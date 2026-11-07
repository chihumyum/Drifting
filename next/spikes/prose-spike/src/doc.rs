//! One body text as one Loro document, mirrored as paragraphs for layout.
//!
//! Data model (the minimal form of decision D3 used by spike P0-B):
//!
//! - a `LoroDoc` with one flat `LoroText` under the root key [`TEXT_KEY`];
//! - paragraphs are separated by `\n`, and the text ends with `\n`, so every
//!   paragraph owns the newline that terminates it (Quill style);
//! - the paragraph kind is a mark with key [`HEADING_KEY`] and an integer value
//!   `1..=3` on that newline; no mark means body. The key is configured with
//!   `ExpandType::None`, so typing next to a newline never inherits it.
//!
//! The mirror ([`ProseDoc::lines`]) is `text.split('\n')`: always one line more
//! than there are newlines. With the trailing newline in place the last line is
//! empty and is not shown. The mirror is only ever updated from Loro's own
//! events, so local edits, undo, redo and imported remote changes all take the
//! same path, and a property test checks it against a fresh read.
//!
//! Positions handed in and out of this module are Unicode scalar offsets in the
//! whole text (Loro's native unit), unless a name says otherwise.

use std::{
    ops::Range,
    sync::{Arc, Mutex},
};

use gpui::SharedString;
use loro::{
    ContainerTrait, ExpandType, LoroDoc, LoroResult, LoroText, LoroValue, StyleConfig,
    StyleConfigMap, Subscription, TextDelta, UndoManager, event::Diff,
};

/// Root key of the body text in every body document.
pub const TEXT_KEY: &str = "body";
/// Mark key for the paragraph kind, placed on the terminating newline.
pub const HEADING_KEY: &str = "heading";
/// Origin of edits typed by the author. Undo tracks these.
pub const ORIGIN_USER: &str = "user";
/// Prefix of Agent write origins (`agent:<session>`). Undo skips these.
pub const ORIGIN_AGENT_PREFIX: &str = "agent:";
/// Edits within this long of the first edit of an undo step undo together.
/// Loro's own merge interval stays 0 (loro-schema v0: merging inside Loro hits
/// #1228/#1245); [`ProseDoc`] groups Loro's single-commit steps itself.
pub const UNDO_MERGE_INTERVAL_MS: u64 = 500;

/// The kind of a paragraph. H1/H2/H3 are three heading levels whose meaning the
/// author decides; the editor treats them alike apart from their size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum BlockKind {
    #[default]
    Body,
    H1,
    H2,
    H3,
}

impl BlockKind {
    pub fn level(self) -> Option<i64> {
        match self {
            BlockKind::Body => None,
            BlockKind::H1 => Some(1),
            BlockKind::H2 => Some(2),
            BlockKind::H3 => Some(3),
        }
    }

    fn from_value(value: &LoroValue) -> BlockKind {
        match value {
            LoroValue::I64(1) => BlockKind::H1,
            LoroValue::I64(2) => BlockKind::H2,
            LoroValue::I64(3) => BlockKind::H3,
            _ => BlockKind::Body,
        }
    }

    fn from_attributes<'a>(
        attributes: impl IntoIterator<Item = (&'a String, &'a LoroValue)>,
    ) -> Option<BlockKind> {
        attributes
            .into_iter()
            .find(|(key, _)| key.as_str() == HEADING_KEY)
            .map(|(_, value)| BlockKind::from_value(value))
    }
}

/// One paragraph of the mirror: the text between two newlines.
#[derive(Clone, Debug)]
pub struct Line {
    pub text: SharedString,
    pub kind: BlockKind,
    /// Length in Unicode scalars, without the newline.
    pub chars: usize,
    /// Length in UTF-16 code units, without the newline.
    pub utf16: usize,
    /// Bumped whenever the text or kind changes; a cheap layout cache key.
    pub rev: u64,
}

impl Line {
    fn new(text: &str, kind: BlockKind, rev: u64) -> Line {
        Line {
            chars: text.chars().count(),
            utf16: text.encode_utf16().count(),
            text: SharedString::from(text.to_owned()),
            kind,
            rev,
        }
    }

    fn set_text(&mut self, text: String, rev: u64) {
        self.chars = text.chars().count();
        self.utf16 = text.encode_utf16().count();
        self.text = SharedString::from(text);
        self.rev = rev;
    }

    /// Byte offset of the given scalar offset inside this line.
    pub fn byte_of_char(&self, char_offset: usize) -> usize {
        byte_of_char(&self.text, char_offset)
    }

    /// Scalar offset of the given byte offset inside this line.
    pub fn char_of_byte(&self, byte_offset: usize) -> usize {
        self.text[..byte_offset.min(self.text.len())]
            .chars()
            .count()
    }
}

/// Byte offset of the `n`-th scalar of `s` (clamped to the end).
pub fn byte_of_char(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map_or(s.len(), |(i, _)| i)
}

/// How one applied delta op changed the line list, in the coordinates current
/// when it was applied: lines `start..start + old` became `new` lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineSplice {
    pub start: usize,
    pub old: usize,
    pub new: usize,
}

/// One applied text op, in scalar offsets, for moving positions held elsewhere
/// (selection, composition anchor) over changes the editor did not make.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextOp {
    pub pos: usize,
    pub deleted: usize,
    pub inserted: usize,
}

impl TextOp {
    /// Moves `offset` over this op. Text inserted exactly at `offset` lands
    /// after it (the position stays in front of foreign inserts).
    pub fn transform(&self, offset: usize) -> usize {
        if offset <= self.pos {
            offset
        } else if offset <= self.pos + self.deleted {
            self.pos
        } else {
            offset - self.deleted + self.inserted
        }
    }
}

/// What one Loro event did to the mirror.
#[derive(Clone, Debug, Default)]
pub struct ChangeSet {
    pub origin: String,
    pub local: bool,
    pub splices: Vec<LineSplice>,
    pub ops: Vec<TextOp>,
}

type EventQueue = Arc<Mutex<Vec<(String, bool, Vec<TextDelta>)>>>;

/// A body text: the Loro document, its paragraph mirror and its undo stack.
pub struct ProseDoc {
    doc: LoroDoc,
    text: LoroText,
    lines: Vec<Line>,
    /// Scalar offset of each line's first character; rebuilt lazily.
    starts: Vec<usize>,
    /// UTF-16 offset of each line's first unit; rebuilt lazily.
    starts16: Vec<usize>,
    starts_dirty: bool,
    undo: UndoManager,
    queue: EventQueue,
    _subscription: Subscription,
    rev: u64,
    /// Changes applied since the last [`ProseDoc::take_changes`].
    changes: Vec<ChangeSet>,
    force_new_step: bool,
    /// Author steps: how many Loro undo items each holds, and when it began.
    undo_steps: Vec<(usize, std::time::Instant)>,
    /// Undone author steps, by item count, newest last.
    redo_steps: Vec<usize>,
}

impl ProseDoc {
    /// A new, empty body text (one empty body paragraph).
    pub fn new() -> ProseDoc {
        let doc = LoroDoc::new();
        let text = doc.get_text(TEXT_KEY);
        text.insert(0, "\n").expect("insert into a fresh text");
        doc.set_next_commit_origin("seed");
        doc.commit();
        ProseDoc::from_doc(doc)
    }

    /// Opens a body text from a Loro snapshot.
    pub fn from_snapshot(bytes: &[u8]) -> LoroResult<ProseDoc> {
        Ok(ProseDoc::from_doc(LoroDoc::from_snapshot(bytes)?))
    }

    /// Builds a body text from plain paragraphs in one commit (a seed, not undoable).
    pub fn from_paragraphs<'a>(
        paragraphs: impl IntoIterator<Item = (BlockKind, &'a str)>,
    ) -> ProseDoc {
        let doc = LoroDoc::new();
        configure(&doc);
        let text = doc.get_text(TEXT_KEY);
        let mut body = String::new();
        let mut marks = Vec::new();
        let mut chars = 0;
        for (kind, paragraph) in paragraphs {
            debug_assert!(!paragraph.contains('\n'));
            body.push_str(paragraph);
            body.push('\n');
            chars += paragraph.chars().count();
            if let Some(level) = kind.level() {
                marks.push((chars, level));
            }
            chars += 1;
        }
        if body.is_empty() {
            body.push('\n');
        }
        text.insert(0, &body).expect("insert the seed text");
        for (at, level) in marks {
            text.mark(at..at + 1, HEADING_KEY, level)
                .expect("mark a seed heading");
        }
        doc.set_next_commit_origin("seed");
        doc.commit();
        ProseDoc::from_doc(doc)
    }

    fn from_doc(doc: LoroDoc) -> ProseDoc {
        configure(&doc);
        let text = doc.get_text(TEXT_KEY);
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
                        if let Diff::Text(delta) = diff.diff {
                            deltas.extend(delta);
                        }
                    }
                    if !deltas.is_empty() {
                        queue.lock().unwrap().push((origin, local, deltas));
                    }
                }
            }),
        );
        let mut undo = UndoManager::new(&doc);
        undo.set_merge_interval(0);
        undo.add_exclude_origin_prefix(ORIGIN_AGENT_PREFIX);
        undo.add_exclude_origin_prefix("seed");
        undo.set_max_undo_steps(100_000);
        let lines = lines_from_delta(&text.to_delta(), 0);
        ProseDoc {
            doc,
            text,
            lines,
            starts: Vec::new(),
            starts16: Vec::new(),
            starts_dirty: true,
            undo,
            queue,
            _subscription: subscription,
            rev: 0,
            changes: Vec::new(),
            force_new_step: false,
            undo_steps: Vec::new(),
            redo_steps: Vec::new(),
        }
    }

    pub fn loro(&self) -> &LoroDoc {
        &self.doc
    }

    pub fn text(&self) -> &LoroText {
        &self.text
    }

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
        self.starts[ix]
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

    // ----- edits -------------------------------------------------------------

    /// Replaces `range` with `text` in one commit.
    pub fn replace(&mut self, range: Range<usize>, text: &str, origin: &str) -> LoroResult<()> {
        if range.is_empty() && text.is_empty() {
            return Ok(());
        }
        if !range.is_empty() {
            self.text.delete(range.start, range.len())?;
        }
        if !text.is_empty() {
            self.text.insert(range.start, text)?;
        }
        self.commit(origin);
        Ok(())
    }

    /// Splits the paragraph at `offset` (Enter). The new newline always goes
    /// in at the cursor (loro-schema v0: inserting it after the old newline
    /// let an undo remove the document's last newline). In the middle of a
    /// heading both halves stay headings; at the end of a heading the new
    /// empty paragraph below is body; at the start, the empty paragraph above
    /// is body and the heading stays as it is.
    pub fn split(&mut self, offset: usize, origin: &str) -> LoroResult<()> {
        let (ix, inner) = self.locate(offset);
        let line = &self.lines[ix];
        let (kind, at_start, at_end) = (line.kind, inner == 0, inner == line.chars);
        let terminated = ix + 1 < self.lines.len();
        self.text.insert(offset, "\n")?;
        if let Some(level) = kind.level()
            && !at_start
        {
            // The new newline now ends the text before the cursor.
            self.text.mark(offset..offset + 1, HEADING_KEY, level)?;
            if at_end && terminated {
                // The old newline ends the new empty paragraph: body.
                self.text.unmark(offset + 1..offset + 2, HEADING_KEY)?;
            }
        }
        self.commit(origin);
        Ok(())
    }

    /// Joins line `ix` onto the line before it (Backspace at a paragraph start).
    /// The joined paragraph keeps the kind of the line before, unless that line
    /// was empty.
    pub fn join_backward(&mut self, ix: usize, origin: &str) -> LoroResult<()> {
        if ix == 0 {
            return Ok(());
        }
        let prev = &self.lines[ix - 1];
        let (prev_kind, prev_empty) = (prev.kind, prev.chars == 0);
        let start = self.line_start(ix);
        let newline = start - 1;
        let kind = self.lines[ix].kind;
        self.text.delete(newline, 1)?;
        if !prev_empty && prev_kind != kind && ix < self.lines.len() - 1 {
            // The remaining newline is the one that ended line `ix`; the mirror
            // still holds the lengths from before the delete.
            let end = newline + self.lines[ix].chars;
            set_kind_mark(&self.text, end, prev_kind)?;
        }
        self.commit(origin);
        Ok(())
    }

    /// Sets the kind of line `ix`.
    pub fn set_kind(&mut self, ix: usize, kind: BlockKind, origin: &str) -> LoroResult<()> {
        if ix + 1 >= self.lines.len() || self.lines[ix].kind == kind {
            return Ok(());
        }
        let newline = self.line_start(ix) + self.lines[ix].chars;
        set_kind_mark(&self.text, newline, kind)?;
        self.commit(origin);
        Ok(())
    }

    /// Makes the next commit start a new undo step even inside the merge
    /// interval (Enter, an IME commit, a paste).
    pub fn checkpoint(&mut self) {
        self.force_new_step = true;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_steps.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_steps.is_empty()
    }

    /// Author steps that can be undone.
    pub fn undo_count(&self) -> usize {
        self.undo_steps.len()
    }

    /// Undoes the author's last step (every Loro item in it). Returns whether
    /// anything changed and where the cursor should go, if the step moved text.
    pub fn undo(&mut self) -> Option<Option<usize>> {
        let (items, _) = self.undo_steps.pop()?;
        let before = self.changes.len();
        let mut changed = false;
        for _ in 0..items {
            changed |= self.undo.undo().unwrap_or(false);
        }
        self.drain();
        self.redo_steps.push(items);
        changed.then(|| self.cursor_after(before))
    }

    /// Redoes the last undone step; see [`ProseDoc::undo`].
    pub fn redo(&mut self) -> Option<Option<usize>> {
        let items = self.redo_steps.pop()?;
        let before = self.changes.len();
        let mut changed = false;
        for _ in 0..items {
            changed |= self.undo.redo().unwrap_or(false);
        }
        self.drain();
        // A redone step never merges with later typing.
        let long_ago = std::time::Instant::now() - std::time::Duration::from_secs(3600);
        self.undo_steps.push((items, long_ago));
        changed.then(|| self.cursor_after(before))
    }

    fn cursor_after(&self, from: usize) -> Option<usize> {
        self.changes[from..]
            .iter()
            .flat_map(|set| set.ops.iter())
            .last()
            .map(|op| op.pos + op.inserted)
    }

    /// Commits pending Loro operations with the given origin and folds the
    /// resulting event into the mirror.
    pub fn commit(&mut self, origin: &str) {
        let split = std::mem::take(&mut self.force_new_step);
        let before = self.undo.undo_count();
        self.doc.set_next_commit_origin(origin);
        self.doc.commit();
        let pushed = self.undo.undo_count().saturating_sub(before);
        if pushed > 0 {
            // Loro pushed this commit as its own item (merge interval 0);
            // fold it into the current author step while that step is young.
            let now = std::time::Instant::now();
            let window = std::time::Duration::from_millis(UNDO_MERGE_INTERVAL_MS);
            match self.undo_steps.last_mut() {
                Some((items, started)) if !split && now.duration_since(*started) < window => {
                    *items += pushed;
                }
                _ => self.undo_steps.push((pushed, now)),
            }
            self.redo_steps.clear();
        }
        self.drain();
    }

    /// Imports remote updates (sync, another device) and folds them in.
    pub fn import(&mut self, bytes: &[u8]) -> LoroResult<()> {
        self.doc.import(bytes)?;
        self.drain();
        Ok(())
    }

    /// Applies queued Loro events to the mirror.
    pub fn drain(&mut self) {
        let events = std::mem::take(&mut *self.queue.lock().unwrap());
        for (origin, local, delta) in events {
            let mut set = ChangeSet {
                origin,
                local,
                ..ChangeSet::default()
            };
            self.rev += 1;
            apply_delta(&mut self.lines, &delta, self.rev, &mut set);
            self.starts_dirty = true;
            self.changes.push(set);
        }
    }

    /// Changes folded into the mirror since the last call.
    pub fn take_changes(&mut self) -> Vec<ChangeSet> {
        std::mem::take(&mut self.changes)
    }

    /// A fresh mirror read straight from Loro, for tests and checks.
    pub fn reread(&self) -> Vec<(BlockKind, String)> {
        lines_from_delta(&self.text.to_delta(), 0)
            .into_iter()
            .map(|line| (line.kind, line.text.to_string()))
            .collect()
    }
}

impl Default for ProseDoc {
    fn default() -> Self {
        ProseDoc::new()
    }
}

fn configure(doc: &LoroDoc) {
    let mut styles = StyleConfigMap::new();
    styles.insert(
        HEADING_KEY.into(),
        StyleConfig {
            expand: ExpandType::None,
        },
    );
    doc.config_text_style(styles);
}

fn set_kind_mark(text: &LoroText, newline: usize, kind: BlockKind) -> LoroResult<()> {
    match kind.level() {
        Some(level) => text.mark(newline..newline + 1, HEADING_KEY, level),
        None => text.unmark(newline..newline + 1, HEADING_KEY),
    }
}

/// Builds the mirror from a full delta (`LoroText::to_delta`).
fn lines_from_delta(delta: &[TextDelta], rev: u64) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for item in delta {
        let TextDelta::Insert { insert, attributes } = item else {
            continue;
        };
        let kind = attributes
            .as_ref()
            .and_then(BlockKind::from_attributes)
            .unwrap_or_default();
        let mut parts = insert.split('\n');
        if let Some(first) = parts.next() {
            current.push_str(first);
        }
        for part in parts {
            lines.push(Line::new(&current, kind, rev));
            current.clear();
            current.push_str(part);
        }
    }
    lines.push(Line::new(&current, BlockKind::Body, rev));
    lines
}

/// Folds one event delta into the mirror. Positions advance in scalars.
fn apply_delta(lines: &mut Vec<Line>, delta: &[TextDelta], rev: u64, set: &mut ChangeSet) {
    // Cursor: line index, scalar offset inside it, and absolute scalar offset.
    let (mut ix, mut inner, mut pos) = (0usize, 0usize, 0usize);
    for item in delta {
        match item {
            TextDelta::Retain { retain, attributes } => {
                let kind = attributes.as_ref().and_then(BlockKind::from_attributes);
                let mut remaining = *retain;
                while remaining > 0 {
                    let left_in_line = lines[ix].chars - inner;
                    if remaining <= left_in_line {
                        inner += remaining;
                        pos += remaining;
                        remaining = 0;
                    } else {
                        // Step over the rest of the line and its newline.
                        remaining -= left_in_line + 1;
                        pos += left_in_line + 1;
                        if let Some(kind) = kind
                            && lines[ix].kind != kind
                        {
                            lines[ix].kind = kind;
                            lines[ix].rev = rev;
                            set.splices.push(LineSplice {
                                start: ix,
                                old: 1,
                                new: 1,
                            });
                        }
                        ix += 1;
                        inner = 0;
                    }
                }
            }
            TextDelta::Insert { insert, attributes } => {
                let kind = attributes
                    .as_ref()
                    .and_then(BlockKind::from_attributes)
                    .unwrap_or_default();
                let inserted = insert.chars().count();
                set.ops.push(TextOp {
                    pos,
                    deleted: 0,
                    inserted,
                });
                let line = &lines[ix];
                let split = line.byte_of_char(inner);
                let (left, right) = (&line.text[..split], &line.text[split..]);
                let parts: Vec<&str> = insert.split('\n').collect();
                if parts.len() == 1 {
                    let text = format!("{left}{insert}{right}");
                    lines[ix].set_text(text, rev);
                    set.splices.push(LineSplice {
                        start: ix,
                        old: 1,
                        new: 1,
                    });
                    inner += inserted;
                } else {
                    let tail_kind = line.kind;
                    let last = parts.len() - 1;
                    let mut new_lines = Vec::with_capacity(parts.len());
                    new_lines.push(Line::new(&format!("{left}{}", parts[0]), kind, rev));
                    for part in &parts[1..last] {
                        new_lines.push(Line::new(part, kind, rev));
                    }
                    new_lines.push(Line::new(
                        &format!("{}{right}", parts[last]),
                        tail_kind,
                        rev,
                    ));
                    let added = new_lines.len();
                    lines.splice(ix..ix + 1, new_lines);
                    set.splices.push(LineSplice {
                        start: ix,
                        old: 1,
                        new: added,
                    });
                    ix += last;
                    inner = parts[last].chars().count();
                }
                pos += inserted;
            }
            TextDelta::Delete { delete } => {
                set.ops.push(TextOp {
                    pos,
                    deleted: *delete,
                    inserted: 0,
                });
                let mut remaining = *delete;
                let mut joined = 0;
                while remaining > 0 {
                    let left_in_line = lines[ix].chars - inner;
                    if remaining <= left_in_line {
                        let line = &lines[ix];
                        let start = line.byte_of_char(inner);
                        let end = line.byte_of_char(inner + remaining);
                        let text = format!("{}{}", &line.text[..start], &line.text[end..]);
                        lines[ix].set_text(text, rev);
                        remaining = 0;
                    } else {
                        // Drop the rest of the line, then its newline: the next
                        // line joins this one and its newline (and kind) remain.
                        let line = &lines[ix];
                        let start = line.byte_of_char(inner);
                        let next = &lines[ix + 1];
                        let text = format!("{}{}", &line.text[..start], next.text);
                        let kind = next.kind;
                        lines[ix].set_text(text, rev);
                        lines[ix].kind = kind;
                        lines.remove(ix + 1);
                        remaining -= left_in_line + 1;
                        joined += 1;
                    }
                }
                set.splices.push(LineSplice {
                    start: ix,
                    old: joined + 1,
                    new: 1,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(doc: &ProseDoc) -> Vec<(BlockKind, String)> {
        doc.lines()
            .iter()
            .map(|line| (line.kind, line.text.to_string()))
            .collect()
    }

    fn assert_mirror(doc: &ProseDoc) {
        assert_eq!(plain(doc), doc.reread(), "mirror drifted from Loro");
    }

    #[test]
    fn seed_and_reread_agree() {
        let doc = ProseDoc::from_paragraphs([
            (BlockKind::H1, "第一章"),
            (BlockKind::Body, "天色将晚。"),
            (BlockKind::H2, "小标题"),
            (BlockKind::Body, ""),
        ]);
        assert_eq!(doc.visible_lines(), 4);
        assert_eq!(doc.line(0).kind, BlockKind::H1);
        assert_eq!(doc.line(2).kind, BlockKind::H2);
        assert_eq!(doc.line(3).text.as_ref(), "");
        assert_mirror(&doc);
    }

    #[test]
    fn split_and_join_keep_kinds_like_an_editor() {
        let mut doc =
            ProseDoc::from_paragraphs([(BlockKind::H2, "标题文字"), (BlockKind::Body, "正文")]);
        // Enter at the end of a heading starts a body paragraph.
        doc.split(4, ORIGIN_USER).unwrap();
        assert_eq!(doc.line(0).kind, BlockKind::H2);
        assert_eq!(doc.line(1).kind, BlockKind::Body);
        assert_eq!(doc.line(1).text.as_ref(), "");
        assert_mirror(&doc);
        // Enter in the middle of a heading keeps both halves headings.
        doc.split(2, ORIGIN_USER).unwrap();
        assert_eq!(doc.line(0).text.as_ref(), "标题");
        assert_eq!(doc.line(1).text.as_ref(), "文字");
        assert_eq!(doc.line(0).kind, BlockKind::H2);
        assert_eq!(doc.line(1).kind, BlockKind::H2);
        assert_mirror(&doc);
        // Backspace below an empty line keeps the lower line's kind.
        assert_eq!(doc.line(3).text.as_ref(), "正文");
        doc.join_backward(3, ORIGIN_USER).unwrap();
        assert_eq!(doc.line(2).text.as_ref(), "正文");
        assert_eq!(doc.line(2).kind, BlockKind::Body);
        assert_mirror(&doc);
        // Backspace at the start of a body line joins it into the heading above.
        doc.join_backward(2, ORIGIN_USER).unwrap();
        assert_eq!(doc.line(1).text.as_ref(), "文字正文");
        assert_eq!(doc.line(1).kind, BlockKind::H2);
        assert_mirror(&doc);
    }

    #[test]
    fn utf16_round_trip() {
        let mut doc =
            ProseDoc::from_paragraphs([(BlockKind::Body, "a😀中"), (BlockKind::Body, "文")]);
        // "a😀中\n文\n": scalars a=0 😀=1 中=2 \n=3 文=4; utf16 a=0 😀=1..3 中=3 \n=4 文=5
        assert_eq!(doc.offset_to_utf16(2), 3);
        assert_eq!(doc.offset_to_utf16(4), 5);
        assert_eq!(doc.offset_from_utf16(5), 4);
        assert_eq!(doc.offset_from_utf16(3), 2);
        assert_eq!(doc.len_utf16(), 7);
        assert_eq!(doc.slice(1..5), "😀中\n文");
    }

    /// Agent writes are excluded from the author's undo stack: undo removes the
    /// author's text and leaves the Agent's in place.
    #[test]
    fn undo_skips_agent_writes() {
        let mut doc = ProseDoc::from_paragraphs([(BlockKind::Body, "")]);
        doc.replace(0..0, "作者写的", ORIGIN_USER).unwrap();
        doc.checkpoint();
        let end = doc.line(0).chars;
        doc.replace(end..end, "【Agent 补的】", "agent:session-1")
            .unwrap();
        assert_eq!(doc.line(0).text.as_ref(), "作者写的【Agent 补的】");
        assert_eq!(doc.undo_count(), 1);
        doc.undo().expect("one author step to undo");
        assert_eq!(doc.line(0).text.as_ref(), "【Agent 补的】");
        assert!(!doc.can_undo());
        doc.redo().expect("redo the author step");
        assert_eq!(doc.line(0).text.as_ref(), "作者写的【Agent 补的】");
        assert_mirror(&doc);
    }

    /// Edits closer together than the merge interval are one undo step; a
    /// checkpoint or a pause starts a new one.
    #[test]
    fn undo_merges_within_interval() {
        let mut doc = ProseDoc::from_paragraphs([(BlockKind::Body, "")]);
        for (ix, ch) in "你好世界".chars().enumerate() {
            doc.replace(ix..ix, &ch.to_string(), ORIGIN_USER).unwrap();
        }
        assert_eq!(doc.undo_count(), 1);
        doc.checkpoint();
        doc.replace(4..4, "。", ORIGIN_USER).unwrap();
        assert_eq!(doc.undo_count(), 2);
        doc.undo();
        assert_eq!(doc.line(0).text.as_ref(), "你好世界");
        doc.undo();
        assert_eq!(doc.line(0).text.as_ref(), "");
        assert_mirror(&doc);
    }

    /// Enter goes in at the cursor, so undoing it can never remove the
    /// document's last newline (loro-schema v0).
    #[test]
    fn undo_of_enter_keeps_the_final_newline() {
        let mut doc = ProseDoc::from_paragraphs([(BlockKind::H1, "标题")]);
        doc.split(2, ORIGIN_USER).unwrap();
        assert_eq!(doc.text().to_string(), "标题\n\n");
        assert_eq!(doc.line(0).kind, BlockKind::H1);
        assert_eq!(doc.line(1).kind, BlockKind::Body);
        doc.undo().expect("undo the Enter");
        assert_eq!(doc.text().to_string(), "标题\n");
        assert_eq!(doc.line(0).kind, BlockKind::H1);
        assert_mirror(&doc);
    }

    /// Small deterministic generator (xorshift64*), so the test needs no crates.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n.max(1) as u64) as usize
        }
    }

    /// Random edits, undo, redo and remote imports: the event-fed mirror must
    /// always equal a fresh read of the Loro text.
    #[test]
    fn mirror_follows_random_edits_undo_and_imports() {
        const SNIPPETS: &[&str] = &[
            "字",
            "两个",
            "\n",
            "a\nb",
            "😀",
            "，",
            "\n\n",
            "长一点的一句话",
        ];
        for seed in 1..=24u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
            let mut doc = ProseDoc::from_paragraphs([
                (BlockKind::H1, "开头"),
                (BlockKind::Body, "正文第一段"),
            ]);
            let remote = LoroDoc::new();
            remote
                .import(&doc.loro().export(loro::ExportMode::Snapshot).unwrap())
                .unwrap();
            configure(&remote);
            for _ in 0..120 {
                let len = doc.len_chars();
                match rng.below(9) {
                    0..=2 => {
                        let at = rng.below(len);
                        let snippet = SNIPPETS[rng.below(SNIPPETS.len())];
                        doc.replace(at..at, snippet, ORIGIN_USER).unwrap();
                    }
                    3 if len >= 2 => {
                        let at = rng.below(len - 1);
                        let n = 1 + rng.below(6).min(len - 1 - at);
                        doc.replace(at..at + n, "", ORIGIN_USER).unwrap();
                    }
                    4 => {
                        let ix = rng.below(doc.lines().len());
                        let kind = [BlockKind::Body, BlockKind::H1, BlockKind::H2, BlockKind::H3]
                            [rng.below(4)];
                        doc.set_kind(ix, kind, ORIGIN_USER).unwrap();
                    }
                    5 => {
                        let at = rng.below(len);
                        let at = at.min(doc.max_cursor());
                        doc.split(at, ORIGIN_USER).unwrap();
                    }
                    6 => {
                        doc.undo();
                    }
                    7 => {
                        doc.redo();
                    }
                    _ => {
                        // A remote peer edits its copy; we import the update.
                        let text = remote.get_text(TEXT_KEY);
                        let rlen = text.len_unicode();
                        let at = rng.below(rlen);
                        text.insert(at, "远").unwrap();
                        if rlen > 3 && rng.below(2) == 0 {
                            text.delete(rng.below(rlen - 2), 1).unwrap();
                        }
                        remote.commit();
                        let from = doc.loro().oplog_vv();
                        let update = remote.export(loro::ExportMode::updates(&from)).unwrap();
                        doc.import(&update).unwrap();
                        remote
                            .import(&doc.loro().export(loro::ExportMode::Snapshot).unwrap())
                            .unwrap();
                    }
                }
                assert_mirror(&doc);
                assert_eq!(
                    doc.lines().len(),
                    doc.text().to_string().matches('\n').count() + 1
                );
            }
        }
    }

    #[test]
    fn text_op_transform() {
        let op = TextOp {
            pos: 5,
            deleted: 2,
            inserted: 3,
        };
        assert_eq!(op.transform(4), 4);
        assert_eq!(op.transform(5), 5);
        assert_eq!(op.transform(6), 5);
        assert_eq!(op.transform(7), 5);
        assert_eq!(op.transform(8), 9);
    }
}
