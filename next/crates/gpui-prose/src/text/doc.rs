//! One body text as the editor sees it: a text source (which owns the Loro
//! document and the write rules), the paragraph mirror and index fed by the
//! source's events, the author's undo steps and the anchors held on it.
//!
//! Positions handed in and out are Unicode scalar offsets in the whole text
//! unless a name says otherwise.

use std::ops::Range;

use loro::{LoroDoc, LoroResult, LoroValue};

use super::{
    anchor::{Anchor, AnchorChange, AnchorId, AnchorSet, Resolved},
    blocks::{BlockAttrs, BlockKind},
    index::{BidMap, ParagraphIndex},
    loro_source::LoroSource,
    marks::{self, Marks, Span},
    mirror::{self, ChangeSet, Line, LineSplice, TextOp},
    source::{Edit, EditResult, MarkOverride, ProseSource},
    undo::{AnchorRestore, AuthorUndo, DeletionRecord, UndoConfig, restore_points},
    units::byte_of_char,
};
use crate::schema::{block, inline};

/// Origin of edits typed by the author. Undo tracks these.
pub const ORIGIN_USER: &str = "user";
/// Prefix of Agent write origins (`agent:<session>/<turn>`). Undo skips these.
pub const ORIGIN_AGENT_PREFIX: &str = "agent:";

/// A body text: its source, mirror, index, undo steps and anchors.
pub struct ProseDoc {
    source: Box<dyn ProseSource>,
    lines: Vec<Line>,
    index: ParagraphIndex,
    bids: BidMap,
    rev: u64,
    /// Changes applied since the last [`ProseDoc::take_changes`].
    changes: Vec<ChangeSet>,
    undo: AuthorUndo,
    anchors: AnchorSet,
    anchor_changes: Vec<AnchorChange>,
}

impl ProseDoc {
    /// Opens a body text from any source.
    pub fn open(source: Box<dyn ProseSource>) -> ProseDoc {
        ProseDoc::open_with(source, &UndoConfig::default())
    }

    pub fn open_with(mut source: Box<dyn ProseSource>, undo: &UndoConfig) -> ProseDoc {
        // Whatever the source did while opening (a repair) is already in the
        // read, and its events are dropped with it.
        let lines = mirror::lines_from_paragraphs(source.resync(), 0);
        let index = ParagraphIndex::new(lines.iter().map(Line::extent));
        let mut bids = BidMap::default();
        bids.rebuild(lines.iter().map(Line::bid));
        ProseDoc {
            source,
            lines,
            index,
            bids,
            rev: 0,
            changes: Vec::new(),
            undo: AuthorUndo::new(undo),
            anchors: AnchorSet::default(),
            anchor_changes: Vec::new(),
        }
    }

    /// A new standalone body text with one empty paragraph.
    pub fn new() -> ProseDoc {
        ProseDoc::open(Box::new(LoroSource::empty()))
    }

    /// Opens a standalone body text from a Loro snapshot.
    pub fn from_snapshot(bytes: &[u8]) -> LoroResult<ProseDoc> {
        Ok(ProseDoc::open(Box::new(LoroSource::from_snapshot(bytes)?)))
    }

    /// A standalone body text from plain paragraphs (a seed, not undoable).
    pub fn from_paragraphs<'a>(
        paragraphs: impl IntoIterator<Item = (BlockKind, &'a str)>,
    ) -> ProseDoc {
        ProseDoc::open(Box::new(LoroSource::from_paragraphs(paragraphs)))
    }

    /// A standalone body text on an existing `LoroDoc`.
    pub fn from_loro(doc: LoroDoc) -> ProseDoc {
        ProseDoc::from_loro_with(doc, &UndoConfig::default())
    }

    pub fn from_loro_with(doc: LoroDoc, undo: &UndoConfig) -> ProseDoc {
        ProseDoc::open_with(Box::new(LoroSource::with_undo(doc, undo)), undo)
    }

    pub fn source(&self) -> &dyn ProseSource {
        self.source.as_ref()
    }

    pub fn source_mut(&mut self) -> &mut dyn ProseSource {
        self.source.as_mut()
    }

    /// The concrete source, if it is a `T`.
    pub fn source_as<T: 'static>(&self) -> Option<&T> {
        self.source.as_any().downcast_ref()
    }

    /// The built-in source, for standalone hosts and tests.
    pub fn loro_source(&self) -> Option<&LoroSource> {
        self.source_as()
    }

    // ----- the mirror and the index ----------------------------------------------

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

    /// The line whose block id is `bid` (the first, if several claim it).
    pub fn line_by_bid(&self, bid: &str) -> Option<usize> {
        self.bids.get(bid)
    }

    /// The whole text, from the mirror.
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        for (ix, line) in self.lines.iter().enumerate() {
            if ix > 0 {
                out.push('\n');
            }
            out.push_str(&line.text);
        }
        out
    }

    /// Total length in scalars, newlines included.
    pub fn len_chars(&self) -> usize {
        self.index.len_chars()
    }

    /// The largest offset the cursor may take: the end of the last visible line.
    pub fn max_cursor(&self) -> usize {
        let last = self.visible_lines() - 1;
        self.line_start(last) + self.lines[last].chars
    }

    /// Total length in UTF-16 units, newlines included.
    pub fn len_utf16(&self) -> usize {
        self.index.len_utf16()
    }

    /// The line containing `offset`.
    pub fn line_of(&self, offset: usize) -> usize {
        self.index.locate(offset).0
    }

    /// Scalar offset of the first character of line `ix`.
    pub fn line_start(&self, ix: usize) -> usize {
        self.index.start(ix.min(self.lines.len() - 1))
    }

    /// The line containing `offset`, and the offset inside it. An offset on a
    /// newline belongs to the line that newline ends.
    pub fn locate(&self, offset: usize) -> (usize, usize) {
        self.index.locate(offset)
    }

    pub fn offset_to_utf16(&self, offset: usize) -> usize {
        let (ix, inner) = self.locate(offset);
        let line = &self.lines[ix];
        let inner16: usize = line.text.chars().take(inner).map(char::len_utf16).sum();
        self.index.start_utf16(ix) + inner16
    }

    pub fn offset_from_utf16(&self, offset16: usize) -> usize {
        let (ix, start16) = self.index.locate_utf16(offset16);
        let mut remaining = offset16 - start16;
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
        (self.line_start(ix) + inner).min(self.len_chars())
    }

    /// The text in `range` (scalar offsets), newlines included.
    pub fn slice(&self, range: Range<usize>) -> String {
        let mut out = String::new();
        if range.is_empty() {
            return out;
        }
        let (first, mut inner) = self.locate(range.start);
        let mut remaining = range.end - range.start;
        for line in &self.lines[first..] {
            let take = remaining.min(line.chars.saturating_sub(inner));
            let start = byte_of_char(&line.text, inner);
            let end = byte_of_char(&line.text, inner + take);
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
    pub fn marks_before(&self, offset: usize) -> Marks {
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
    pub fn range_has_mark(&self, range: Range<usize>, key: &str) -> bool {
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

    /// Applies one edit through the source, records anchors whose edges it
    /// deletes for the undo item, and folds the result into the mirror.
    fn apply(&mut self, edit: Edit<'_>, origin: &str) -> EditResult {
        self.apply_all(std::slice::from_ref(&edit), origin)
    }

    /// Applies `edits` as one commit (one Loro undo item) through the
    /// source: see [`ProseSource::edit_batch`]. Give non-overlapping ranges
    /// last first, so the anchors whose edges they delete come back on undo
    /// (their positions are recorded against the text before the batch).
    pub fn edit_batch(&mut self, edits: &[Edit<'_>], origin: &str) -> EditResult {
        if edits.is_empty() {
            return EditResult::default();
        }
        self.apply_all(edits, origin)
    }

    fn apply_all(&mut self, edits: &[Edit<'_>], origin: &str) -> EditResult {
        let may_delete = edits.iter().any(|edit| match edit {
            Edit::Replace { range, .. } | Edit::Delete { range } => !range.is_empty(),
            _ => false,
        });
        let anchors_before = if may_delete && !self.anchors.is_empty() {
            self.anchors.resolve_all(self.source.as_ref())
        } else {
            Vec::new()
        };
        let result = match edits {
            [edit] => self.source.edit(edit.clone(), origin),
            _ => self.source.edit_batch(edits, origin),
        };
        // Undo puts deleted text back in document order, and the undo record
        // matches its deletions to those inserts in order: a batch given last
        // first deleted in descending order, so record it ascending.
        let mut deleted = result.deleted.clone();
        if edits.len() > 1 {
            deleted.sort_by_key(|&(pos, _)| pos);
        }
        for (pos, len) in deleted {
            let restores = anchor_restores(&anchors_before, pos..pos + len);
            self.undo
                .pending
                .deletions
                .push(DeletionRecord { len, restores });
        }
        self.undo.after_commit(result.undo_items);
        self.drain();
        result
    }

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
        self.apply(
            Edit::Replace {
                range,
                text,
                overrides,
            },
            origin,
        )
        .inserted
    }

    /// Deletes `range` in one commit, under the paragraph-join rules.
    pub fn delete(&mut self, range: Range<usize>, origin: &str) {
        if range.is_empty() {
            return;
        }
        self.apply(Edit::Delete { range }, origin);
    }

    /// Enter at `offset`. Returns the caret position afterwards.
    pub fn split(&mut self, offset: usize, origin: &str) -> usize {
        self.apply(Edit::Split { at: offset }, origin).caret
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
        self.apply(
            Edit::SetBlockAttr {
                newline,
                key,
                value,
            },
            origin,
        );
    }

    /// Sets an inline mark on `range` (newlines are skipped).
    pub fn mark(&mut self, range: Range<usize>, key: &str, value: LoroValue, origin: &str) {
        if range.is_empty() || block::is_block_key(key) {
            return;
        }
        self.apply(Edit::Mark { range, key, value }, origin);
    }

    /// Clears an inline mark from `range`.
    pub fn unmark(&mut self, range: Range<usize>, key: &str, origin: &str) {
        if range.is_empty() || block::is_block_key(key) {
            return;
        }
        self.apply(Edit::Unmark { range, key }, origin);
    }

    /// Bold/italic/underline/strike on `range`: off if all of it has the
    /// mark, else on. Returns whether the mark is now on.
    pub fn toggle_mark(&mut self, range: Range<usize>, key: &str, origin: &str) -> bool {
        self.toggle_mark_value(range, key, LoroValue::Bool(true), origin)
    }

    /// [`ProseDoc::toggle_mark`] for a mark whose value is not `true` (a
    /// note's highlight: its colour).
    pub fn toggle_mark_value(
        &mut self,
        range: Range<usize>,
        key: &str,
        value: LoroValue,
        origin: &str,
    ) -> bool {
        let on = !self.range_has_mark(range.clone(), key);
        if on {
            self.mark(range, key, value, origin);
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

    // ----- undo -----------------------------------------------------------------

    /// Makes the next commit start a new undo step even inside the merge
    /// interval (Enter, an IME commit, a paste, moving the caret).
    pub fn checkpoint(&mut self) {
        self.undo.force_new_step = true;
    }

    /// Makes the next commit part of the last undo step, however long ago
    /// it was (a host's edit derived from the typing, such as automatic
    /// links, which one undo takes back with it). Without a last step it
    /// starts one.
    pub fn join_last_step(&mut self) {
        self.undo.join_last_step = true;
    }

    /// Folds `items` items a host committed to this document outside its
    /// body text (an embed's contents) into the author's undo history, as
    /// if the body had pushed them: the usual merge rules apply
    /// ([`ProseDoc::checkpoint`] first for a step of their own).
    pub fn record_host_items(&mut self, items: usize) {
        self.undo.after_commit(items);
    }

    /// Marks the last undo step as part of edit group `group`: an edit
    /// across chapters, whose steps in the other chapters are undone and
    /// redone with it (see [`crate::ProseEditor`]'s undo).
    pub fn tag_last_step(&mut self, group: u64) {
        if let Some(step) = self.undo.steps.last_mut() {
            step.group = Some(group);
        }
    }

    /// The edit group of the step [`ProseDoc::undo`] would undo next.
    pub fn last_step_group(&self) -> Option<u64> {
        self.undo.steps.last().and_then(|step| step.group)
    }

    /// The edit group of the step [`ProseDoc::redo`] would redo next.
    pub fn next_redo_group(&self) -> Option<u64> {
        self.undo.redo.last().and_then(|step| step.group)
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
            changed |= self.source.undo_item();
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
            changed |= self.source.redo_item();
        }
        self.drain();
        step.started = AuthorUndo::long_ago();
        self.undo.steps.push(step);
        changed.then(|| self.cursor_after(before))
    }

    fn restore_anchors(&mut self, restores: &[AnchorRestore], point: usize) {
        for restore in restores {
            let current = self.anchors.resolve(&restore.id, self.source.as_ref());
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
            if let Some(anchor) = self.source.anchor(start..end) {
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

    // ----- events -------------------------------------------------------------------

    /// Imports remote updates through the source (sources that support it).
    pub fn import(&mut self, bytes: &[u8]) -> Result<(), String> {
        let result = self.source.import(bytes);
        self.drain();
        result
    }

    /// Folds the source's pending events into the mirror and the index. Hosts
    /// whose source changes outside the editor (Drifting's sync) call this,
    /// through the editor, after the change.
    pub fn drain(&mut self) {
        let events = self.source.take_events();
        if events.is_empty() {
            return;
        }
        let mut structure_changed = false;
        for event in events {
            let mut set = ChangeSet {
                origin: event.origin,
                local: event.local,
                ..ChangeSet::default()
            };
            self.rev += 1;
            mirror::apply_changes(
                &mut self.lines,
                &mut self.index,
                &event.changes,
                self.rev,
                &mut set,
            );
            structure_changed |= set.splices.iter().any(|s| s.old != s.new);
            self.changes.push(set);
        }
        let ids_changed = mirror::refresh_stale(&mut self.lines, &self.index, self.source.as_ref());
        if structure_changed || ids_changed {
            self.bids.mark_dirty();
        }
        if self.source.needs_resync() {
            self.resync();
        }
        if self.bids.is_dirty() {
            self.bids.rebuild(self.lines.iter().map(Line::bid));
        }
    }

    /// Rebuilds the mirror from a fresh read (the source saw another thread's
    /// commit while the editor was reading). Reported as one change set
    /// covering the paragraphs that differ, so the selection and composition
    /// outside them stay put.
    fn resync(&mut self) {
        let fresh = mirror::lines_from_paragraphs(self.source.resync(), self.rev + 1);
        let same =
            |a: &Line, b: &Line| a.text == b.text && a.block == b.block && a.spans == b.spans;
        let prefix = self
            .lines
            .iter()
            .zip(&fresh)
            .take_while(|(a, b)| same(a, b))
            .count();
        let max_suffix = self.lines.len().min(fresh.len()) - prefix;
        let suffix = self
            .lines
            .iter()
            .rev()
            .zip(fresh.iter().rev())
            .take(max_suffix)
            .take_while(|(a, b)| same(a, b))
            .count();
        let old = self.lines.len() - prefix - suffix;
        let new = fresh.len() - prefix - suffix;
        if old == 0 && new == 0 {
            return;
        }
        self.rev += 1;
        let pos = self.index.start(prefix);
        let deleted: usize = self.lines[prefix..prefix + old]
            .iter()
            .map(|l| l.extent().chars)
            .sum();
        let inserted: usize = fresh[prefix..prefix + new]
            .iter()
            .map(|l| l.extent().chars)
            .sum();
        let replacement: Vec<Line> = fresh.into_iter().skip(prefix).take(new).collect();
        self.index
            .splice(prefix..prefix + old, replacement.iter().map(Line::extent));
        self.lines.splice(prefix..prefix + old, replacement);
        self.bids.mark_dirty();
        self.changes.push(ChangeSet {
            origin: "resync".into(),
            local: false,
            splices: vec![LineSplice {
                start: prefix,
                old,
                new,
            }],
            ops: vec![TextOp {
                pos,
                deleted,
                inserted,
            }],
        });
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
        let anchor = self.source.anchor(range)?;
        self.anchors.insert(id.into(), anchor.clone());
        Some(anchor)
    }

    pub fn remove_anchor(&mut self, id: &str) -> Option<Anchor> {
        self.anchors.remove(id)
    }

    /// Where an anchor points now.
    pub fn anchor(&mut self, id: &str) -> Option<Resolved> {
        self.anchors.resolve(id, self.source.as_ref())
    }

    pub fn anchors(&self) -> &AnchorSet {
        &self.anchors
    }

    /// Anchors an undo re-anchored since the last call; the host stores them.
    pub fn take_anchor_changes(&mut self) -> Vec<AnchorChange> {
        std::mem::take(&mut self.anchor_changes)
    }

    // ----- checks ---------------------------------------------------------------

    /// A fresh read straight from the source, for tests and checks: each
    /// paragraph's attributes, text and marks.
    pub fn reread(&self) -> Vec<(BlockAttrs, String, Vec<Span>)> {
        self.source
            .read_all()
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

    /// Whether the index agrees with the mirror (tests).
    pub fn index_matches_mirror(&self) -> bool {
        let mut at = 0;
        for (ix, line) in self.lines.iter().enumerate() {
            if self.index.start(ix) != at {
                return false;
            }
            at += line.chars + 1;
        }
        self.index.len() == self.lines.len() && self.index.len_chars() + 1 == at
    }
}

impl Default for ProseDoc {
    fn default() -> Self {
        ProseDoc::new()
    }
}

/// The anchors whose edges `deleted` removes, with the edges' offsets from
/// the deletion start (resolved before the edit).
fn anchor_restores(anchors: &[(AnchorId, Resolved)], deleted: Range<usize>) -> Vec<AnchorRestore> {
    let mut restores = Vec::new();
    for (id, resolved) in anchors {
        if resolved.collapsed {
            continue;
        }
        let (s, e) = (resolved.range.start, resolved.range.end);
        let start_in = deleted.contains(&s);
        let end_in = deleted.contains(&(e - 1));
        if start_in || end_in {
            restores.push(AnchorRestore {
                id: id.clone(),
                start: start_in.then(|| s - deleted.start),
                end: end_in.then(|| e - deleted.start),
            });
        }
    }
    restores
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
