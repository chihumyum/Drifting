//! One body text: the Loro document, its paragraph mirror, the author's undo
//! history and the anchors held on it.
//!
//! Positions handed in and out are Unicode scalar offsets in the whole text
//! (Loro's native unit) unless a name says otherwise.

use std::{
    ops::Range,
    sync::{Arc, Mutex},
};

use loro::{ContainerTrait, LoroDoc, LoroResult, LoroText, LoroValue, Subscription, TextDelta};

use super::{
    anchor::{Anchor, AnchorChange, AnchorId, AnchorSet, Resolved},
    blocks::{self, BlockAttrs, BlockKind},
    marks::{self, Marks, Span},
    mirror::{self, ChangeSet, Line},
    undo::{AnchorRestore, AuthorUndo, DeletionRecord, UndoConfig, restore_points},
};
use crate::schema::{self, BODY, block, inline};

/// Origin of edits typed by the author. Undo tracks these.
pub const ORIGIN_USER: &str = "user";
/// Prefix of Agent write origins (`agent:<session>/<turn>`). Undo skips these.
pub const ORIGIN_AGENT_PREFIX: &str = "agent:";
/// Origin of the block-id repair commit (not undoable).
pub const ORIGIN_REPAIR: &str = "repair";

type EventQueue = Arc<Mutex<Vec<(String, bool, Vec<TextDelta>)>>>;

/// A mark to set (`Some`) or clear (`None`) on text being inserted: the
/// pending toggles of a caret (⌘B before typing).
pub type MarkOverride = (String, Option<LoroValue>);

/// A body text: the Loro document, its paragraph mirror and its undo history.
pub struct ProseDoc {
    doc: LoroDoc,
    text: LoroText,
    lines: Vec<Line>,
    /// Scalar offset of each line's first character; rebuilt lazily.
    starts: Vec<usize>,
    /// UTF-16 offset of each line's first unit; rebuilt lazily.
    starts16: Vec<usize>,
    starts_dirty: bool,
    queue: EventQueue,
    _subscription: Subscription,
    rev: u64,
    /// Changes applied since the last [`ProseDoc::take_changes`].
    changes: Vec<ChangeSet>,
    undo: AuthorUndo,
    anchors: AnchorSet,
    anchor_changes: Vec<AnchorChange>,
}

impl ProseDoc {
    /// A new body text with one empty paragraph (a standalone document; a
    /// host with deterministic genesis changes builds its own `LoroDoc` and
    /// opens it with [`ProseDoc::from_loro`]).
    pub fn new() -> ProseDoc {
        ProseDoc::from_paragraphs(std::iter::empty())
    }

    /// Opens a body text from a Loro snapshot.
    pub fn from_snapshot(bytes: &[u8]) -> LoroResult<ProseDoc> {
        let doc = LoroDoc::new();
        schema::configure(&doc);
        doc.import(bytes)?;
        Ok(ProseDoc::from_loro(doc))
    }

    /// Builds a body text from plain paragraphs in one commit (a seed, not
    /// undoable). Every paragraph gets a block id.
    pub fn from_paragraphs<'a>(
        paragraphs: impl IntoIterator<Item = (BlockKind, &'a str)>,
    ) -> ProseDoc {
        let doc = LoroDoc::new();
        schema::configure(&doc);
        let text = doc.get_text(BODY);
        let mut body = String::new();
        let mut newlines = Vec::new();
        let mut chars = 0;
        for (kind, paragraph) in paragraphs {
            debug_assert!(!paragraph.contains('\n'));
            body.push_str(paragraph);
            body.push('\n');
            chars += paragraph.chars().count();
            newlines.push((chars, kind));
            chars += 1;
        }
        if body.is_empty() {
            body.push('\n');
            newlines.push((0, BlockKind::Body));
        }
        text.insert(0, &body).expect("insert the seed text");
        for (at, kind) in newlines {
            let bid = blocks::fresh_block_id(&text, at);
            let _ = text.mark(at..at + 1, block::ID, bid);
            if let Some(level) = kind.level() {
                let _ = text.mark(at..at + 1, block::HEADING, level);
            }
        }
        doc.set_next_commit_origin("seed");
        doc.commit();
        ProseDoc::from_loro(doc)
    }

    /// Opens an existing document: applies the style table, builds the
    /// mirror, and repairs missing or duplicate block ids (an uncommitted
    /// `repair` change, committed here; not undoable).
    pub fn from_loro(doc: LoroDoc) -> ProseDoc {
        ProseDoc::from_loro_with(doc, &UndoConfig::default())
    }

    pub fn from_loro_with(doc: LoroDoc, undo: &UndoConfig) -> ProseDoc {
        schema::configure(&doc);
        let text = doc.get_text(BODY);
        let queue: EventQueue = Arc::default();
        let subscription = doc.subscribe(
            &text.id(),
            Arc::new({
                let queue = queue.clone();
                move |event| {
                    let local = matches!(event.triggered_by, loro::EventTriggerKind::Local);
                    let origin = event.origin.to_owned();
                    let mut deltas = Vec::new();
                    for diff in event.events {
                        if let loro::event::Diff::Text(delta) = diff.diff {
                            deltas.extend(delta);
                        }
                    }
                    if !deltas.is_empty() {
                        queue.lock().unwrap().push((origin, local, deltas));
                    }
                }
            }),
        );
        let undo = AuthorUndo::new(&doc, undo);
        let lines = mirror::lines_from_delta(&text.to_delta(), 0);
        let mut prose = ProseDoc {
            doc,
            text,
            lines,
            starts: Vec::new(),
            starts16: Vec::new(),
            starts_dirty: true,
            queue,
            _subscription: subscription,
            rev: 0,
            changes: Vec::new(),
            undo,
            anchors: AnchorSet::default(),
            anchor_changes: Vec::new(),
        };
        if prose.text.len_unicode() == 0 {
            // A document that never had a body: give it its final newline.
            let _ = prose.text.insert(0, "\n");
            let bid = blocks::fresh_block_id(&prose.text, 0);
            let _ = prose.text.mark(0..1, block::ID, bid);
            prose.commit("seed");
        }
        prose.repair_block_ids();
        prose.take_changes();
        prose
    }

    pub fn loro(&self) -> &LoroDoc {
        &self.doc
    }

    pub fn text(&self) -> &LoroText {
        &self.text
    }

    // ----- the mirror -----------------------------------------------------------

    /// All lines, including the hidden empty line after the trailing newline.
    pub fn lines(&self) -> &[Line] {
        &self.lines
    }

    pub fn line(&self, ix: usize) -> &Line {
        &self.lines[ix]
    }

    /// Lines shown to the author: the empty line after the trailing newline is
    /// a position, not a paragraph, so it is hidden whenever a newline precedes it.
    pub fn visible_lines(&self) -> usize {
        let n = self.lines.len();
        if n > 1 && self.lines[n - 1].chars == 0 {
            n - 1
        } else {
            n
        }
    }

    /// The line whose block id is `bid`.
    pub fn line_by_bid(&self, bid: &str) -> Option<usize> {
        self.lines.iter().position(|line| line.bid() == Some(bid))
    }

    /// Total length in scalars, newlines included.
    pub fn len_chars(&mut self) -> usize {
        self.ensure_starts();
        let last = self.lines.len() - 1;
        self.starts[last] + self.lines[last].chars
    }

    /// The largest offset the cursor may take: the end of the last visible line.
    pub fn max_cursor(&mut self) -> usize {
        let last = self.visible_lines() - 1;
        self.line_start(last) + self.lines[last].chars
    }

    /// Total length in UTF-16 units, newlines included.
    pub fn len_utf16(&mut self) -> usize {
        self.ensure_starts();
        let last = self.lines.len() - 1;
        self.starts16[last] + self.lines[last].utf16
    }

    fn ensure_starts(&mut self) {
        if !self.starts_dirty {
            return;
        }
        self.starts.clear();
        self.starts16.clear();
        let (mut at, mut at16) = (0, 0);
        for line in &self.lines {
            self.starts.push(at);
            self.starts16.push(at16);
            at += line.chars + 1;
            at16 += line.utf16 + 1;
        }
        self.starts_dirty = false;
    }

    /// The line containing `offset`, without touching the lazy index.
    pub fn line_of(&self, offset: usize) -> usize {
        let mut at = 0;
        for (ix, line) in self.lines.iter().enumerate() {
            if offset <= at + line.chars {
                return ix;
            }
            at += line.chars + 1;
        }
        self.lines.len() - 1
    }

    /// Scalar offset of the first character of line `ix`.
    pub fn line_start(&mut self, ix: usize) -> usize {
        self.ensure_starts();
        self.starts[ix.min(self.starts.len() - 1)]
    }

    /// The line containing `offset`, and the offset inside it. An offset on a
    /// newline belongs to the line that newline ends.
    pub fn locate(&mut self, offset: usize) -> (usize, usize) {
        self.ensure_starts();
        let ix = match self.starts.binary_search(&offset) {
            Ok(ix) => ix,
            Err(ix) => ix - 1,
        };
        (ix, offset - self.starts[ix])
    }

    pub fn offset_to_utf16(&mut self, offset: usize) -> usize {
        let (ix, inner) = self.locate(offset);
        let line = &self.lines[ix];
        let inner16: usize = line.text.chars().take(inner).map(char::len_utf16).sum();
        self.starts16[ix] + inner16
    }

    pub fn offset_from_utf16(&mut self, offset16: usize) -> usize {
        self.ensure_starts();
        let ix = match self.starts16.binary_search(&offset16) {
            Ok(ix) => ix,
            Err(ix) => ix - 1,
        };
        let mut remaining = offset16 - self.starts16[ix];
        let mut chars = 0;
        for ch in self.lines[ix].text.chars() {
            if remaining == 0 {
                break;
            }
            remaining = remaining.saturating_sub(ch.len_utf16());
            chars += 1;
        }
        // An offset past the line's text lands on its newline (or the end).
        let inner = if remaining > 0 {
            self.lines[ix].chars + 1
        } else {
            chars
        };
        (self.starts[ix] + inner).min(self.len_chars())
    }

    /// The text in `range` (scalar offsets), newlines included.
    pub fn slice(&mut self, range: Range<usize>) -> String {
        let mut out = String::new();
        if range.is_empty() {
            return out;
        }
        let (first, mut inner) = self.locate(range.start);
        let mut remaining = range.end - range.start;
        for line in &self.lines[first..] {
            let take = remaining.min(line.chars.saturating_sub(inner));
            let start = line.byte_of_char(inner);
            let end = line.byte_of_char(inner + take);
            out.push_str(&line.text[start..end]);
            remaining -= take;
            if remaining == 0 {
                break;
            }
            out.push('\n');
            remaining -= 1;
            inner = 0;
            if remaining == 0 {
                break;
            }
        }
        out
    }

    /// The marks a character typed at `offset` takes by default: those of the
    /// character before it (inside its paragraph), as far as they expand.
    pub fn marks_before(&mut self, offset: usize) -> Marks {
        let (ix, inner) = self.locate(offset);
        if inner == 0 {
            return Marks::default();
        }
        let line = &self.lines[ix];
        let byte = line.byte_of_char(inner - 1);
        marks::marks_at(&line.spans, byte)
            .cloned()
            .unwrap_or_default()
    }

    /// Whether every character of `range` (newlines aside) has `key`.
    pub fn range_has_mark(&mut self, range: Range<usize>, key: &str) -> bool {
        if range.is_empty() {
            return false;
        }
        let (first, mut inner) = self.locate(range.start);
        let mut remaining = range.len();
        let mut any = false;
        for line in &self.lines[first..] {
            let take = remaining.min(line.chars.saturating_sub(inner));
            if take > 0 {
                any = true;
                let (start, end) = (line.byte_of_char(inner), line.byte_of_char(inner + take));
                if !covered(&line.spans, start..end, key) {
                    return false;
                }
            }
            remaining -= take;
            if remaining == 0 {
                break;
            }
            remaining -= 1;
            inner = 0;
            if remaining == 0 {
                break;
            }
        }
        any
    }

    // ----- edits ----------------------------------------------------------------

    /// Replaces `range` with `text` in one commit. Each `\n` in `text` is an
    /// Enter (new paragraphs get fresh block ids). Returns where the inserted
    /// text ended up.
    pub fn replace(&mut self, range: Range<usize>, text: &str, origin: &str) -> Range<usize> {
        self.replace_styled(range, text, &[], origin)
    }

    /// [`ProseDoc::replace`], then sets or clears `overrides` on the inserted
    /// text (the caret's pending toggles), in the same commit.
    pub fn replace_styled(
        &mut self,
        range: Range<usize>,
        text: &str,
        overrides: &[MarkOverride],
        origin: &str,
    ) -> Range<usize> {
        if range.is_empty() && text.is_empty() {
            return range;
        }
        let deleted = self.delete_recorded(range.clone());
        let at = deleted.start;
        let end = blocks::insert(&self.text, at, text);
        for (key, value) in overrides {
            match value {
                Some(value) => marks::mark_inline(&self.text, at..end, key, value.clone()),
                None => marks::unmark_inline(&self.text, at..end, key),
            }
        }
        self.commit(origin);
        at..end
    }

    /// Deletes `range` in one commit, under the paragraph-join rules.
    pub fn delete(&mut self, range: Range<usize>, origin: &str) {
        if range.is_empty() {
            return;
        }
        self.delete_recorded(range);
        self.commit(origin);
    }

    /// Enter at `offset`. Returns the caret position afterwards.
    pub fn split(&mut self, offset: usize, origin: &str) -> usize {
        let caret = blocks::split(&self.text, offset);
        self.commit(origin);
        caret
    }

    /// Joins line `ix` onto the line before it (Backspace at a paragraph start).
    pub fn join_backward(&mut self, ix: usize, origin: &str) {
        if ix == 0 || ix >= self.lines.len() {
            return;
        }
        let start = self.line_start(ix);
        self.delete(start - 1..start, origin);
    }

    /// Sets the kind (H1/H2/H3 or body) of line `ix`.
    pub fn set_kind(&mut self, ix: usize, kind: BlockKind, origin: &str) {
        if ix + 1 >= self.lines.len() || self.lines[ix].kind == kind {
            return;
        }
        self.set_block_attr(
            ix,
            block::HEADING,
            kind.level().map(LoroValue::from),
            origin,
        );
    }

    /// Sets (or clears) a paragraph attribute of line `ix`. The block id
    /// cannot be changed this way.
    pub fn set_block_attr(&mut self, ix: usize, key: &str, value: Option<LoroValue>, origin: &str) {
        if ix + 1 >= self.lines.len() || key == block::ID || !block::is_block_key(key) {
            return;
        }
        let newline = self.line_start(ix) + self.lines[ix].chars;
        blocks::set_block_attr(&self.text, newline, key, value);
        self.commit(origin);
    }

    /// Sets an inline mark on `range` (newlines are skipped).
    pub fn mark(&mut self, range: Range<usize>, key: &str, value: LoroValue, origin: &str) {
        if range.is_empty() || block::is_block_key(key) {
            return;
        }
        marks::mark_inline(&self.text, range, key, value);
        self.commit(origin);
    }

    /// Clears an inline mark from `range`.
    pub fn unmark(&mut self, range: Range<usize>, key: &str, origin: &str) {
        if range.is_empty() || block::is_block_key(key) {
            return;
        }
        marks::unmark_inline(&self.text, range, key);
        self.commit(origin);
    }

    /// Bold/italic/underline/strike on `range`: off if all of it has the
    /// mark, else on. Returns whether the mark is now on.
    pub fn toggle_mark(&mut self, range: Range<usize>, key: &str, origin: &str) -> bool {
        let on = !self.range_has_mark(range.clone(), key);
        if on {
            self.mark(range, key, LoroValue::Bool(true), origin);
        } else {
            self.unmark(range, key, origin);
        }
        on
    }

    /// Links `range` to `url`, or removes links from it.
    pub fn set_link(&mut self, range: Range<usize>, url: Option<&str>, origin: &str) {
        match url {
            Some(url) => self.mark(range, inline::LINK, LoroValue::from(url), origin),
            None => self.unmark(range, inline::LINK, origin),
        }
    }

    /// Deletes `range` (clamped so the final newline stays), recording the
    /// anchors whose edges it removes for the undo item.
    fn delete_recorded(&mut self, range: Range<usize>) -> Range<usize> {
        let len = self.text.len_unicode();
        let end = range.end.min(len.saturating_sub(1));
        let start = range.start.min(end);
        if start == end {
            return start..start;
        }
        let restores = if self.anchors.is_empty() {
            Vec::new()
        } else {
            self.anchor_restores(start..end)
        };
        let deleted = blocks::delete(&self.text, start..end);
        self.undo.pending.deletions.push(DeletionRecord {
            len: deleted.len(),
            restores,
        });
        deleted
    }

    fn anchor_restores(&mut self, deleted: Range<usize>) -> Vec<AnchorRestore> {
        let mut restores = Vec::new();
        for (id, resolved) in self.anchors.resolve_all(&self.doc) {
            if resolved.collapsed {
                continue;
            }
            let (s, e) = (resolved.range.start, resolved.range.end);
            let start_in = deleted.contains(&s);
            let end_in = deleted.contains(&(e - 1));
            if start_in || end_in {
                restores.push(AnchorRestore {
                    id,
                    start: start_in.then(|| s - deleted.start),
                    end: end_in.then(|| e - deleted.start),
                });
            }
        }
        restores
    }

    /// Fixes missing and duplicate block ids (deterministically). Returns how
    /// many paragraphs it changed.
    pub fn repair_block_ids(&mut self) -> usize {
        self.ensure_starts();
        let last = self.lines.len() - 1;
        let paragraphs: Vec<(usize, Option<String>)> = self.lines[..last]
            .iter()
            .enumerate()
            .map(|(ix, line)| (self.starts[ix] + line.chars, line.bid().map(String::from)))
            .collect();
        let fixed = blocks::repair_block_ids(&self.text, &paragraphs);
        if fixed > 0 {
            self.commit(ORIGIN_REPAIR);
        }
        fixed
    }

    // ----- undo -----------------------------------------------------------------

    /// Makes the next commit start a new undo step even inside the merge
    /// interval (Enter, an IME commit, a paste, moving the caret).
    pub fn checkpoint(&mut self) {
        self.undo.force_new_step = true;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.steps.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.undo.redo.is_empty()
    }

    /// Author steps that can be undone.
    pub fn undo_count(&self) -> usize {
        self.undo.steps.len()
    }

    /// Undoes the author's last step (every Loro item in it) and brings back
    /// the anchors its deletions collapsed. Returns `None` if there was no
    /// step, else where the cursor should go (if the step moved text).
    pub fn undo(&mut self) -> Option<Option<usize>> {
        let step = self.undo.steps.pop()?;
        let before = self.changes.len();
        let mut changed = false;
        for record in step.items.iter().rev() {
            let from = self.changes.len();
            changed |= self.undo.manager.undo().unwrap_or(false);
            self.drain();
            if AuthorUndo::needs_ops(record) {
                let ops: Vec<_> = self.changes[from..]
                    .iter()
                    .flat_map(|set| set.ops.iter().copied())
                    .collect();
                let points = restore_points(record, &ops);
                for (deletion, point) in record.deletions.iter().zip(points) {
                    if let Some(point) = point {
                        self.restore_anchors(&deletion.restores, point);
                    }
                }
            }
        }
        self.undo.redo.push(step);
        changed.then(|| self.cursor_after(before))
    }

    /// Redoes the last undone step; see [`ProseDoc::undo`].
    pub fn redo(&mut self) -> Option<Option<usize>> {
        let mut step = self.undo.redo.pop()?;
        let before = self.changes.len();
        let mut changed = false;
        for _ in &step.items {
            changed |= self.undo.manager.redo().unwrap_or(false);
        }
        self.drain();
        step.started = AuthorUndo::long_ago();
        self.undo.steps.push(step);
        changed.then(|| self.cursor_after(before))
    }

    fn restore_anchors(&mut self, restores: &[AnchorRestore], point: usize) {
        for restore in restores {
            let current = self.anchors.resolve(&restore.id, &self.doc);
            let start = match (restore.start, &current) {
                (Some(rel), _) => point + rel,
                (None, Some(now)) => now.range.start,
                (None, None) => continue,
            };
            let end = match (restore.end, &current) {
                (Some(rel), _) => point + rel,
                (None, Some(now)) => now.range.end,
                (None, None) => continue,
            };
            if start >= end {
                continue;
            }
            if let Some(anchor) = Anchor::new(&self.text, start..end) {
                self.anchors.insert(restore.id.clone(), anchor.clone());
                self.anchor_changes.push(AnchorChange {
                    id: restore.id.clone(),
                    anchor,
                    range: start..end,
                });
            }
        }
    }

    fn cursor_after(&self, from: usize) -> Option<usize> {
        self.changes[from..]
            .iter()
            .flat_map(|set| set.ops.iter())
            .last()
            .map(|op| op.pos + op.inserted)
    }

    // ----- commits and events -----------------------------------------------------

    /// Commits pending Loro operations with the given origin and folds the
    /// resulting event into the mirror.
    pub fn commit(&mut self, origin: &str) {
        let before = self.undo.manager.undo_count();
        self.doc.set_next_commit_origin(origin);
        self.doc.commit();
        let pushed = self.undo.manager.undo_count().saturating_sub(before);
        self.undo.after_commit(pushed);
        self.drain();
    }

    /// Imports remote updates (sync, another device), folds them in, and
    /// repairs block ids a concurrent Enter may have duplicated.
    pub fn import(&mut self, bytes: &[u8]) -> LoroResult<()> {
        self.doc.import(bytes)?;
        self.drain();
        self.repair_block_ids();
        Ok(())
    }

    /// Applies queued Loro events to the mirror.
    pub fn drain(&mut self) {
        let events = std::mem::take(&mut *self.queue.lock().unwrap());
        if events.is_empty() {
            return;
        }
        for (origin, local, delta) in events {
            let mut set = ChangeSet {
                origin,
                local,
                ..ChangeSet::default()
            };
            self.rev += 1;
            mirror::apply_delta(&mut self.lines, &delta, self.rev, &mut set);
            self.starts_dirty = true;
            self.changes.push(set);
        }
        mirror::refresh_stale(&mut self.lines, &self.text);
    }

    /// Changes folded into the mirror since the last call.
    pub fn take_changes(&mut self) -> Vec<ChangeSet> {
        std::mem::take(&mut self.changes)
    }

    // ----- anchors --------------------------------------------------------------

    /// Holds an anchor (loaded by the host) while this document is open.
    pub fn set_anchor(&mut self, id: impl Into<AnchorId>, anchor: Anchor) {
        self.anchors.insert(id.into(), anchor);
    }

    /// Anchors `range` under `id` and returns the anchor to store.
    pub fn add_anchor(&mut self, id: impl Into<AnchorId>, range: Range<usize>) -> Option<Anchor> {
        let anchor = Anchor::new(&self.text, range)?;
        self.anchors.insert(id.into(), anchor.clone());
        Some(anchor)
    }

    pub fn remove_anchor(&mut self, id: &str) -> Option<Anchor> {
        self.anchors.remove(id)
    }

    /// Where an anchor points now.
    pub fn anchor(&mut self, id: &str) -> Option<Resolved> {
        self.anchors.resolve(id, &self.doc)
    }

    pub fn anchors(&self) -> &AnchorSet {
        &self.anchors
    }

    /// Anchors an undo re-anchored since the last call; the host stores them.
    pub fn take_anchor_changes(&mut self) -> Vec<AnchorChange> {
        std::mem::take(&mut self.anchor_changes)
    }

    // ----- checks ---------------------------------------------------------------

    /// A fresh read straight from Loro, for tests and checks: each paragraph's
    /// attributes, text and marks.
    pub fn reread(&self) -> Vec<(BlockAttrs, String, Vec<Span>)> {
        mirror::read_lines(&self.text.to_delta())
            .into_iter()
            .map(|read| (read.block, read.text, read.spans))
            .collect()
    }

    /// The mirror in the same shape as [`ProseDoc::reread`].
    pub fn mirror_snapshot(&self) -> Vec<(BlockAttrs, String, Vec<Span>)> {
        self.lines
            .iter()
            .map(|line| {
                (
                    line.block.clone(),
                    line.text.to_string(),
                    line.spans.to_vec(),
                )
            })
            .collect()
    }
}

impl Default for ProseDoc {
    fn default() -> Self {
        ProseDoc::new()
    }
}

/// Whether spans cover every byte of `range` with `key`.
fn covered(spans: &[Span], range: Range<usize>, key: &str) -> bool {
    let mut at = range.start;
    for span in spans {
        if span.range.end <= at {
            continue;
        }
        if span.range.start > at || !span.marks.has(key) {
            return false;
        }
        at = span.range.end;
        if at >= range.end {
            return true;
        }
    }
    at >= range.end
}
