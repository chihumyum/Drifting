//! gpui-prose's own text source: a body text on a plain `LoroDoc`, written
//! with the loro-schema v0 rules in [`super::blocks`] and [`super::marks`].
//!
//! For standalone use of gpui-prose, tests and benchmarks. Drifting's editor
//! uses a source on `dr-doc` instead (same rules, same storage format).

use std::{
    any::Any,
    ops::Range,
    sync::{Arc, Mutex},
};

use loro::{
    ContainerTrait, Frontiers, LoroDoc, LoroResult, LoroText, Subscription, TextDelta, UndoManager,
    cursor::PosType,
};

use super::{
    anchor::{Anchor, Resolved},
    blocks::{self, BlockAttrs, BlockKind},
    marks::{self, Marks, push_span},
    source::{Edit, EditResult, ProseSource, SourceChange, SourceEvent, SourceParagraph},
    undo::UndoConfig,
};
use crate::schema::{self, BODY, block};

/// Origin of the block-id repair commit (not undoable).
pub const ORIGIN_REPAIR: &str = "repair";

type EventQueue = Arc<Mutex<Vec<SourceEvent>>>;

/// Paragraphs read at a version of the document.
type ReadAt = (Frontiers, Vec<SourceParagraph>);

/// A body text on a `LoroDoc` that this source owns.
pub struct LoroSource {
    doc: LoroDoc,
    text: LoroText,
    undo: UndoManager,
    queue: EventQueue,
    /// What the block-id check read while opening, handed to the first
    /// [`ProseSource::read_all`] so that opening reads the text once (the
    /// first read of a body text is most of the cost of opening it). Used
    /// only while the document is still at that version.
    opened: Mutex<Option<ReadAt>>,
    _subscription: Subscription,
}

impl LoroSource {
    /// Opens an existing document: applies the style table and repairs
    /// missing or duplicate block ids (a `repair` commit, not undoable).
    pub fn new(doc: LoroDoc) -> LoroSource {
        LoroSource::with_undo(doc, &UndoConfig::default())
    }

    pub fn with_undo(doc: LoroDoc, config: &UndoConfig) -> LoroSource {
        schema::configure(&doc);
        let text = doc.get_text(BODY);
        let queue: EventQueue = Arc::default();
        let subscription = doc.subscribe(
            &text.id(),
            Arc::new({
                let queue = queue.clone();
                move |event| {
                    let local = matches!(event.triggered_by, loro::EventTriggerKind::Local);
                    let mut changes = Vec::new();
                    for diff in event.events {
                        if let loro::event::Diff::Text(delta) = diff.diff {
                            changes.extend(delta.iter().map(change_of));
                        }
                    }
                    if !changes.is_empty() {
                        queue.lock().unwrap().push(SourceEvent {
                            origin: event.origin.to_owned(),
                            local,
                            changes,
                        });
                    }
                }
            }),
        );
        let mut undo = UndoManager::new(&doc);
        undo.set_merge_interval(0);
        for prefix in &config.exclude_origin_prefixes {
            undo.add_exclude_origin_prefix(prefix);
        }
        undo.set_max_undo_steps(config.max_items);
        let mut source = LoroSource {
            doc,
            text,
            undo,
            queue,
            opened: Mutex::new(None),
            _subscription: subscription,
        };
        if source.text.len_unicode() == 0 {
            // A document that never had a body: give it its final newline.
            let _ = source.text.insert(0, "\n");
            let bid = blocks::fresh_block_id(&source.text, 0);
            let _ = source.text.mark(0..1, block::ID, bid);
            source.commit("seed");
        }
        let (fixed, read) = source.check_block_ids();
        if fixed == 0 {
            *source.opened.get_mut().unwrap() = Some((source.doc.state_frontiers(), read));
        }
        source
    }

    /// A new body text with one empty paragraph.
    pub fn empty() -> LoroSource {
        LoroSource::from_paragraphs(std::iter::empty())
    }

    /// Opens a body text from a Loro snapshot.
    pub fn from_snapshot(bytes: &[u8]) -> LoroResult<LoroSource> {
        let doc = LoroDoc::new();
        schema::configure(&doc);
        doc.import(bytes)?;
        Ok(LoroSource::new(doc))
    }

    /// Builds a body text from plain paragraphs in one commit (a seed, not
    /// undoable). Every paragraph gets a block id.
    pub fn from_paragraphs<'a>(
        paragraphs: impl IntoIterator<Item = (BlockKind, &'a str)>,
    ) -> LoroSource {
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
        LoroSource::new(doc)
    }

    pub fn loro(&self) -> &LoroDoc {
        &self.doc
    }

    pub fn text(&self) -> &LoroText {
        &self.text
    }

    fn commit(&mut self, origin: &str) -> usize {
        *self.opened.get_mut().unwrap() = None;
        let before = self.undo.undo_count();
        self.doc.set_next_commit_origin(origin);
        self.doc.commit();
        self.undo.undo_count().saturating_sub(before)
    }

    /// Applies one edit without committing (an edit or a batch commits).
    fn apply(&mut self, edit: Edit<'_>) -> EditResult {
        let mut result = EditResult::default();
        match edit {
            Edit::Replace {
                range,
                text,
                overrides,
            } => {
                let deleted = blocks::delete(&self.text, range);
                if !deleted.is_empty() {
                    result.deleted.push((deleted.start, deleted.len()));
                }
                let at = deleted.start;
                let end = blocks::insert(&self.text, at, text);
                for (key, value) in overrides {
                    match value {
                        Some(value) => marks::mark_inline(&self.text, at..end, key, value.clone()),
                        None => marks::unmark_inline(&self.text, at..end, key),
                    }
                }
                result.inserted = at..end;
                result.caret = end;
            }
            Edit::Delete { range } => {
                let deleted = blocks::delete(&self.text, range);
                if !deleted.is_empty() {
                    result.deleted.push((deleted.start, deleted.len()));
                }
                result.inserted = deleted.start..deleted.start;
                result.caret = deleted.start;
            }
            Edit::Split { at } => {
                let caret = blocks::split(&self.text, at);
                result.inserted = at..caret;
                result.caret = caret;
            }
            Edit::SetBlockAttr {
                newline,
                key,
                value,
            } => {
                if key != block::ID && block::is_block_key(key) {
                    blocks::set_block_attr(&self.text, newline, key, value);
                }
                result.caret = newline;
            }
            Edit::Mark { range, key, value } => {
                if !block::is_block_key(key) {
                    marks::mark_inline(&self.text, range.clone(), key, value);
                }
                result.caret = range.end;
            }
            Edit::Unmark { range, key } => {
                if !block::is_block_key(key) {
                    marks::unmark_inline(&self.text, range.clone(), key);
                }
                result.caret = range.end;
            }
        }
        result
    }

    /// Fixes missing and duplicate block ids (deterministically, as its own
    /// `repair` commit). Returns how many paragraphs it changed.
    pub fn repair_block_ids(&mut self) -> usize {
        self.check_block_ids().0
    }

    /// Repairs block ids; also returns the paragraphs it read (before any
    /// repair).
    fn check_block_ids(&mut self) -> (usize, Vec<SourceParagraph>) {
        let mut paragraphs = Vec::new();
        let mut at = 0;
        let all = self.read_all();
        let last = all.len() - 1;
        for paragraph in &all[..last] {
            at += paragraph.text.chars().count();
            paragraphs.push((at, paragraph.block.bid().map(String::from)));
            at += 1;
        }
        let fixed = blocks::repair_block_ids(&self.text, &paragraphs);
        if fixed > 0 {
            self.commit(ORIGIN_REPAIR);
        }
        (fixed, all)
    }
}

/// One Loro text delta item as a source change, with the inserted text's
/// marks (for sources on a `LoroDoc` someone else holds).
pub fn change_of(delta: &TextDelta) -> SourceChange {
    match delta {
        TextDelta::Retain { retain, attributes } => SourceChange::Retain {
            len: *retain,
            restyled: attributes.as_ref().is_some_and(|a| !a.is_empty()),
        },
        TextDelta::Insert { insert, attributes } => SourceChange::Insert {
            text: insert.clone(),
            marks: Some(
                attributes
                    .as_ref()
                    .map(Marks::from_attributes)
                    .unwrap_or_default(),
            ),
        },
        TextDelta::Delete { delete } => SourceChange::Delete { len: *delete },
    }
}

/// Splits a delta into paragraphs, applying the reading rules: paragraph
/// attributes only from `\n`, marks only from other characters. The last
/// entry is whatever follows the last `\n`. Public for sources on a
/// `LoroDoc` someone else holds.
pub fn read_paragraphs(delta: &[TextDelta]) -> Vec<SourceParagraph> {
    let mut lines = Vec::new();
    let mut current = SourceParagraph::default();
    for item in delta {
        let TextDelta::Insert { insert, attributes } = item else {
            continue;
        };
        let marks = attributes
            .as_ref()
            .map(Marks::from_attributes)
            .unwrap_or_default();
        let mut parts = insert.split('\n');
        if let Some(first) = parts.next() {
            push_span(
                &mut current.spans,
                current.text.len(),
                first.len(),
                marks.clone(),
            );
            current.text.push_str(first);
        }
        for part in parts {
            current.block = attributes
                .as_ref()
                .map(BlockAttrs::from_attributes)
                .unwrap_or_default();
            lines.push(std::mem::take(&mut current));
            push_span(&mut current.spans, 0, part.len(), marks.clone());
            current.text.push_str(part);
        }
    }
    lines.push(current);
    lines
}

impl ProseSource for LoroSource {
    fn read_all(&self) -> Vec<SourceParagraph> {
        let opened = self.opened.lock().unwrap().take();
        if let Some((at, paragraphs)) = opened
            && at == self.doc.state_frontiers()
            && self.doc.get_pending_txn_len() == 0
        {
            return paragraphs;
        }
        read_paragraphs(&self.text.to_delta())
    }

    fn read(&self, range: Range<usize>) -> Vec<SourceParagraph> {
        if range.is_empty() {
            return vec![SourceParagraph::default()];
        }
        let delta = self
            .text
            .slice_delta(range.start, range.end, PosType::Unicode)
            .unwrap_or_default();
        read_paragraphs(&delta)
    }

    fn take_events(&mut self) -> Vec<SourceEvent> {
        std::mem::take(&mut *self.queue.lock().unwrap())
    }

    fn edit(&mut self, edit: Edit<'_>, origin: &str) -> EditResult {
        let mut result = self.apply(edit);
        result.undo_items = self.commit(origin);
        result
    }

    fn edit_batch(&mut self, edits: &[Edit<'_>], origin: &str) -> EditResult {
        let mut merged = EditResult::default();
        for edit in edits {
            merged.merge(self.apply(edit.clone()));
        }
        merged.undo_items = self.commit(origin);
        merged
    }

    fn undo_item(&mut self) -> bool {
        self.undo.undo().unwrap_or(false)
    }

    fn redo_item(&mut self) -> bool {
        self.undo.redo().unwrap_or(false)
    }

    fn anchor(&self, range: Range<usize>) -> Option<Anchor> {
        Anchor::new(&self.text, range)
    }

    fn resolve(&self, anchor: &Anchor) -> Option<Resolved> {
        anchor.resolve(&self.doc)
    }

    fn import(&mut self, bytes: &[u8]) -> Result<(), String> {
        *self.opened.get_mut().unwrap() = None;
        self.doc.import(bytes).map_err(|e| e.to_string())?;
        self.repair_block_ids();
        Ok(())
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
