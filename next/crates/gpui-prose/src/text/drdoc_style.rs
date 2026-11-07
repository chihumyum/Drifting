//! A test source built the way Drifting's `dr-doc` + `dr-store` are, to show
//! that [`ProseSource`] is enough for them (the real one lives in
//! `dr-editor`, which may depend on both crates; this crate may not):
//!
//! - the document is owned by a holder and written only inside its
//!   `write(origin, |txn| …)` closure, one commit per call, as `dr-store`'s
//!   document holder does;
//! - the write rules are implemented here on their own, following `dr-doc`'s
//!   `ProseTxn` (`insert_paragraphs`, `split`, `delete`, block attributes,
//!   styles), not by calling gpui-prose's `blocks.rs`;
//! - events are converted the way `dr-doc`'s `ProseEvent` is: retain / insert
//!   / delete in coordinates before the change, **without** the inserted
//!   text's marks, so the editor must re-read touched paragraphs;
//! - undo excludes every origin `dr-model` excludes (`agent:`, `genesis`,
//!   `mirror`, `sync`, `import`, `repair`), merge interval 0.

use std::{
    any::Any,
    ops::Range,
    sync::{Arc, Mutex},
};

use loro::{
    ContainerTrait, LoroDoc, LoroText, LoroValue, Subscription, TextDelta, UndoManager,
    cursor::{PosType, Side},
};

use super::{
    anchor::{Anchor, Resolved},
    blocks::BlockKind,
    loro_source::read_paragraphs,
    source::{Edit, EditResult, ProseSource, SourceChange, SourceEvent, SourceParagraph},
};
use crate::schema::{self, BODY, block};

const EXCLUDED: &[&str] = &["agent:", "genesis", "mirror", "sync", "import", "repair"];
const AT_END: &[&str] = &[
    block::QUOTE,
    block::INDENT,
    block::ALIGN,
    block::LIST,
    block::LIST_LEVEL,
    block::CALLOUT,
];
const ON_SPLIT: &[&str] = &[
    block::HEADING,
    block::QUOTE,
    block::INDENT,
    block::ALIGN,
    block::LIST,
    block::LIST_LEVEL,
    block::CODE_BLOCK,
    block::CALLOUT,
];

/// The document holder: owns the document; writes only through `write`.
struct Holder {
    doc: LoroDoc,
}

impl Holder {
    fn write<R>(&mut self, origin: &str, f: impl FnOnce(&mut Txn) -> R) -> R {
        let mut txn = Txn {
            text: self.doc.get_text(BODY),
        };
        let out = f(&mut txn);
        self.doc.set_next_commit_origin(origin);
        self.doc.commit();
        out
    }

    fn text(&self) -> LoroText {
        self.doc.get_text(BODY)
    }
}

/// One transaction, with the v0 rules as `dr-doc`'s `ProseTxn` states them.
struct Txn {
    text: LoroText,
}

type Attrs = Vec<(String, LoroValue)>;

impl Txn {
    fn chars(&self) -> Vec<char> {
        self.text.to_string().chars().collect()
    }

    fn newline_at_or_after(&self, pos: usize) -> usize {
        let chars = self.chars();
        (pos..chars.len())
            .find(|&i| chars[i] == '\n')
            .unwrap_or(chars.len() - 1)
    }

    fn paragraph_start(&self, pos: usize) -> usize {
        let chars = self.chars();
        (0..pos.min(chars.len()))
            .rev()
            .find(|&i| chars[i] == '\n')
            .map_or(0, |i| i + 1)
    }

    /// The block id and the other paragraph attributes of the `\n` at `nl`.
    fn newline_block(&self, nl: usize) -> (Option<LoroValue>, Attrs) {
        let delta = self
            .text
            .slice_delta(nl, nl + 1, PosType::Unicode)
            .unwrap_or_default();
        let mut id = None;
        let mut attrs = Vec::new();
        for item in delta {
            if let TextDelta::Insert {
                attributes: Some(a),
                ..
            } = item
            {
                for (k, v) in a {
                    if v.is_null() {
                        continue;
                    }
                    if k == block::ID {
                        id = Some(v);
                    } else if block::is_block_key(&k) {
                        attrs.push((k, v));
                    }
                }
            }
        }
        (id, attrs)
    }

    fn fresh_block_id(&self, nl: usize) -> LoroValue {
        let id = self
            .text
            .get_cursor(nl, Side::Middle)
            .and_then(|c| c.id)
            .expect("a newline has an op id");
        LoroValue::from(format!("{}@{}", id.counter, id.peer))
    }

    /// Writes exactly `id` and `attrs` on the `\n` at `nl`.
    /// Like `dr-doc`'s: no inline mark stays on the newline, and only the
    /// paragraph keys whose value changes are written.
    fn set_newline(&self, nl: usize, id: Option<&LoroValue>, attrs: &Attrs) {
        if let Ok(delta) = self
            .text
            .slice_delta(nl, nl + 1, loro::cursor::PosType::Unicode)
        {
            for item in delta {
                if let loro::TextDelta::Insert {
                    attributes: Some(attributes),
                    ..
                } = item
                {
                    for (key, value) in attributes.iter() {
                        if !block::is_block_key(key) && !value.is_null() {
                            let _ = self.text.unmark(nl..nl + 1, key);
                        }
                    }
                }
            }
        }
        let have = super::blocks::newline_attrs(&self.text, nl);
        for key in block::ALL {
            let want = if *key == block::ID {
                id.cloned()
            } else {
                attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
            };
            if want.as_ref() == have.get(key) {
                continue;
            }
            let _ = match want {
                Some(v) => self.text.mark(nl..nl + 1, key, v),
                None => self.text.unmark(nl..nl + 1, key),
            };
        }
    }

    fn insert_text(&self, pos: usize, s: &str) {
        debug_assert!(!s.contains('\n'));
        if !s.is_empty() {
            let _ = self.text.insert(pos, s);
        }
    }

    /// Each newline is an Enter; returns the caret after the text.
    fn insert_paragraphs(&self, pos: usize, s: &str) -> usize {
        let mut caret = pos;
        for (i, line) in s.split('\n').enumerate() {
            if i > 0 {
                caret = self.split(caret);
            }
            self.insert_text(caret, line);
            caret += line.chars().count();
        }
        caret
    }

    fn split(&self, pos: usize) -> usize {
        let nl = self.newline_at_or_after(pos);
        let start = self.paragraph_start(pos);
        let (old_id, old) = self.newline_block(nl);
        let _ = self.text.insert(pos, "\n");
        let fresh = self.fresh_block_id(pos);
        let only = |keys: &[&str]| -> Attrs {
            old.iter()
                .filter(|(k, _)| keys.contains(&k.as_str()))
                .cloned()
                .collect()
        };
        if pos == nl && pos > start {
            self.set_newline(pos, old_id.as_ref(), &old);
            self.set_newline(nl + 1, Some(&fresh), &only(AT_END));
        } else if pos == start {
            self.set_newline(pos, Some(&fresh), &only(AT_END));
        } else {
            self.set_newline(pos, Some(&fresh), &only(ON_SPLIT));
        }
        pos + 1
    }

    /// Returns the range actually deleted (the final newline stays).
    fn delete(&self, range: Range<usize>) -> Range<usize> {
        let len = self.text.len_unicode();
        let end = range.end.min(len.saturating_sub(1));
        let start = range.start.min(end);
        if start == end {
            return start..start;
        }
        let deleted = self.text.slice(start, end).unwrap_or_default();
        if !deleted.contains('\n') {
            let _ = self.text.delete(start, end - start);
            return start..end;
        }
        let first_start = self.paragraph_start(start);
        let (first_id, first_attrs) = self.newline_block(self.newline_at_or_after(start));
        let survivor = self.newline_at_or_after(end);
        let _ = self.text.delete(start, end - start);
        if !(start == first_start && deleted.ends_with('\n')) {
            self.set_newline(survivor - (end - start), first_id.as_ref(), &first_attrs);
        }
        start..end
    }

    /// Calls `f` on each piece of `range` between newlines.
    fn each_run(&self, range: Range<usize>, mut f: impl FnMut(Range<usize>)) {
        let chars = self.chars();
        let mut seg = range.start;
        for i in range.clone() {
            if chars.get(i) == Some(&'\n') {
                if i > seg {
                    f(seg..i);
                }
                seg = i + 1;
            }
        }
        if range.end > seg {
            f(seg..range.end);
        }
    }

    fn set_style(&self, range: Range<usize>, key: &str, value: LoroValue) {
        self.each_run(range, |r| {
            let _ = self.text.mark(r, key, value.clone());
        });
    }

    /// Like `dr-doc`'s: newlines included.
    fn clear_style(&self, range: Range<usize>, key: &str) {
        if !range.is_empty() {
            let _ = self.text.unmark(range, key);
        }
    }
}

type Queue = Arc<Mutex<Vec<SourceEvent>>>;

pub(crate) struct DrDocStyle {
    holder: Holder,
    undo: UndoManager,
    queue: Queue,
    _subscription: Subscription,
}

impl DrDocStyle {
    /// A document seeded with `paragraphs` the way an import writes it
    /// (origin `import`, so not undoable).
    pub(crate) fn seeded(paragraphs: &[(BlockKind, &str)]) -> DrDocStyle {
        let doc = LoroDoc::new();
        schema::configure(&doc);
        let mut holder = Holder { doc };
        holder.write("genesis", |txn| {
            let _ = txn.text.insert(0, "\n");
            let id = txn.fresh_block_id(0);
            txn.set_newline(0, Some(&id), &Vec::new());
        });
        holder.write("import", |txn| {
            let mut caret = 0;
            for (ix, (kind, text)) in paragraphs.iter().enumerate() {
                if ix > 0 {
                    caret = txn.split(caret);
                }
                txn.insert_text(caret, text);
                caret += text.chars().count();
                let nl = txn.newline_at_or_after(caret);
                let (id, mut attrs) = txn.newline_block(nl);
                attrs.retain(|(k, _)| k != block::HEADING);
                if let Some(level) = kind.level() {
                    attrs.push((block::HEADING.into(), LoroValue::from(level)));
                }
                txn.set_newline(nl, id.as_ref(), &attrs);
            }
        });
        let queue: Queue = Arc::default();
        let text = holder.text();
        let subscription = holder.doc.subscribe(
            &text.id(),
            Arc::new({
                let queue = queue.clone();
                move |event| {
                    let mut changes = Vec::new();
                    for diff in event.events {
                        if let loro::event::Diff::Text(delta) = diff.diff {
                            for d in delta {
                                // dr-doc's `TextChange`: no marks on inserts.
                                changes.push(match d {
                                    TextDelta::Retain { retain, attributes } => {
                                        SourceChange::Retain {
                                            len: retain,
                                            restyled: attributes.is_some_and(|a| !a.is_empty()),
                                        }
                                    }
                                    TextDelta::Insert { insert, .. } => SourceChange::Insert {
                                        text: insert,
                                        marks: None,
                                    },
                                    TextDelta::Delete { delete } => {
                                        SourceChange::Delete { len: delete }
                                    }
                                });
                            }
                        }
                    }
                    if !changes.is_empty() {
                        queue.lock().unwrap().push(SourceEvent {
                            origin: event.origin.to_owned(),
                            local: matches!(event.triggered_by, loro::EventTriggerKind::Local),
                            changes,
                        });
                    }
                }
            }),
        );
        let mut undo = UndoManager::new(&holder.doc);
        undo.set_merge_interval(0);
        for prefix in EXCLUDED {
            undo.add_exclude_origin_prefix(prefix);
        }
        undo.set_max_undo_steps(100_000);
        DrDocStyle {
            holder,
            undo,
            queue,
            _subscription: subscription,
        }
    }
}

/// One edit in a transaction, as `dr-doc`'s `ProseTxn` calls would make it.
fn apply(txn: &mut Txn, edit: Edit<'_>) -> EditResult {
    let mut result = EditResult::default();
    match edit {
        Edit::Replace {
            range,
            text,
            overrides,
        } => {
            let deleted = txn.delete(range);
            if !deleted.is_empty() {
                result.deleted.push((deleted.start, deleted.len()));
            }
            let caret = txn.insert_paragraphs(deleted.start, text);
            for (key, value) in overrides {
                match value {
                    Some(v) => txn.set_style(deleted.start..caret, key, v.clone()),
                    None => txn.clear_style(deleted.start..caret, key),
                }
            }
            result.inserted = deleted.start..caret;
            result.caret = caret;
        }
        Edit::Delete { range } => {
            let deleted = txn.delete(range);
            if !deleted.is_empty() {
                result.deleted.push((deleted.start, deleted.len()));
            }
            result.inserted = deleted.start..deleted.start;
            result.caret = deleted.start;
        }
        Edit::Split { at } => {
            result.caret = txn.split(at);
            result.inserted = at..result.caret;
        }
        Edit::SetBlockAttr {
            newline,
            key,
            value,
        } => {
            let (id, mut attrs) = txn.newline_block(newline);
            attrs.retain(|(k, _)| k != key);
            if let Some(v) = value {
                attrs.push((key.to_owned(), v));
            }
            txn.set_newline(newline, id.as_ref(), &attrs);
            result.caret = newline;
        }
        Edit::Mark { range, key, value } => {
            txn.set_style(range.clone(), key, value);
            result.caret = range.end;
        }
        Edit::Unmark { range, key } => {
            txn.clear_style(range.clone(), key);
            result.caret = range.end;
        }
    }
    result
}

impl ProseSource for DrDocStyle {
    fn read_all(&self) -> Vec<SourceParagraph> {
        read_paragraphs(&self.holder.text().to_delta())
    }

    fn read(&self, range: Range<usize>) -> Vec<SourceParagraph> {
        if range.is_empty() {
            return vec![SourceParagraph::default()];
        }
        let delta = self
            .holder
            .text()
            .slice_delta(range.start, range.end, PosType::Unicode)
            .unwrap_or_default();
        read_paragraphs(&delta)
    }

    fn take_events(&mut self) -> Vec<SourceEvent> {
        std::mem::take(&mut *self.queue.lock().unwrap())
    }

    fn edit(&mut self, edit: Edit<'_>, origin: &str) -> EditResult {
        let before = self.undo.undo_count();
        let mut result = self.holder.write(origin, |txn| apply(txn, edit));
        result.undo_items = self.undo.undo_count().saturating_sub(before);
        result
    }

    fn edit_batch(&mut self, edits: &[Edit<'_>], origin: &str) -> EditResult {
        let before = self.undo.undo_count();
        let mut result = self.holder.write(origin, |txn| {
            let mut merged = EditResult::default();
            for edit in edits {
                merged.merge(apply(txn, edit.clone()));
            }
            merged
        });
        result.undo_items = self.undo.undo_count().saturating_sub(before);
        result
    }

    fn undo_item(&mut self) -> bool {
        self.undo.undo().unwrap_or(false)
    }

    fn redo_item(&mut self) -> bool {
        self.undo.redo().unwrap_or(false)
    }

    fn anchor(&self, range: Range<usize>) -> Option<Anchor> {
        Anchor::new(&self.holder.text(), range)
    }

    fn resolve(&self, anchor: &Anchor) -> Option<Resolved> {
        anchor.resolve(&self.holder.doc)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
