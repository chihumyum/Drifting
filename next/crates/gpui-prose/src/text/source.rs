//! The text source: where a body text lives and how it is written.
//!
//! The editor does not own the Loro document. It reads paragraphs, takes
//! change events and asks for edits through [`ProseSource`]; the source owns
//! the document and the write rules (Enter moves the block id, a new newline
//! carries all its attributes, inline marks never sit on a newline) and the
//! Loro undo stack. gpui-prose ships [`crate::text::LoroSource`], a minimal
//! source on a plain `LoroDoc`; Drifting's `dr-editor` implements the trait
//! on `dr-doc` and `dr-store` (writes through the document holder's write
//! closure, reads through its view).
//!
//! What stays in the editor: the paragraph index and mirror (fed by
//! events), grouping Loro undo items into author steps, and re-anchoring
//! anchors whose text an undo brings back — for which the source reports
//! what each edit deleted and the events show what an undo re-inserted.
//!
//! Positions are Unicode scalar offsets in the whole body text.

use std::{any::Any, ops::Range};

use loro::LoroValue;

use super::{
    anchor::{Anchor, Resolved},
    blocks::BlockAttrs,
    marks::{Marks, Span},
};

/// A mark to set (`Some`) or clear (`None`) on text being inserted.
pub type MarkOverride = (String, Option<LoroValue>);

/// One paragraph as the source reads it: its text (without the `\n`), the
/// attributes on its `\n`, and its marked runs (bytes of `text`). The reading
/// rules apply: paragraph attributes only from `\n`, marks only off it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceParagraph {
    pub text: String,
    pub block: BlockAttrs,
    pub spans: Vec<Span>,
}

/// One step of a body change, applied left to right in coordinates before the
/// change (Quill-delta style, as `dr-doc`'s `ProseEvent` gives them).
#[derive(Clone, Debug, PartialEq)]
pub enum SourceChange {
    /// Keep `len` characters; `restyled` when their attributes or marks changed.
    Retain { len: usize, restyled: bool },
    /// Insert `text` here. `marks`, when the source knows them, are exactly
    /// the inline marks the new text has (the editor then skips re-reading
    /// the paragraph); `None` makes the editor re-read it.
    Insert { text: String, marks: Option<Marks> },
    /// Delete `len` characters here.
    Delete { len: usize },
}

/// A change to the body text: a local commit, an undo, or imported updates.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceEvent {
    pub origin: String,
    pub local: bool,
    pub changes: Vec<SourceChange>,
}

/// One edit, committed as one commit with one origin.
#[derive(Clone, Debug)]
pub enum Edit<'a> {
    /// Replace `range` with `text`. Each `\n` in `text` is an Enter (pasted
    /// paragraphs get fresh block ids); `overrides` then set or clear marks on
    /// the inserted text (a caret's pending ⌘B).
    Replace {
        range: Range<usize>,
        text: &'a str,
        overrides: &'a [MarkOverride],
    },
    /// Delete `range` under the paragraph-join rules (never the final `\n`).
    Delete { range: Range<usize> },
    /// Enter at `at`.
    Split { at: usize },
    /// Set (or clear) one paragraph attribute of the paragraph whose `\n` is
    /// at `newline`. Never the block id.
    SetBlockAttr {
        newline: usize,
        key: &'a str,
        value: Option<LoroValue>,
    },
    /// Set an inline mark on `range` (newlines skipped).
    Mark {
        range: Range<usize>,
        key: &'a str,
        value: LoroValue,
    },
    /// Clear an inline mark from `range`.
    Unmark { range: Range<usize>, key: &'a str },
}

/// What an edit did, for the editor's caret, undo grouping and anchors.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EditResult {
    /// Where inserted text ended up, after the edit (empty for deletes and
    /// formatting; for Enter, the new `\n`).
    pub inserted: Range<usize>,
    /// The caret after the edit.
    pub caret: usize,
    /// Text the edit deleted, as `(position before the edit, length)`, in the
    /// order deleted.
    pub deleted: Vec<(usize, usize)>,
    /// Items the commit pushed onto the author's undo stack (0 when the
    /// origin is not the author's, or nothing changed).
    pub undo_items: usize,
}

impl EditResult {
    /// Folds a later edit of the same batch into this result.
    pub fn merge(&mut self, next: EditResult) {
        self.deleted.extend(next.deleted);
        self.inserted = next.inserted;
        self.caret = next.caret;
        self.undo_items += next.undo_items;
    }
}

/// Where a body text lives. Object-safe: the editor holds `Box<dyn ProseSource>`.
pub trait ProseSource: Send {
    /// Every paragraph, in order. The last entry is whatever follows the final
    /// `\n` (empty in well-formed text).
    fn read_all(&self) -> Vec<SourceParagraph>;

    /// The paragraphs covering `range` (which starts at a paragraph start and
    /// ends at or just after a `\n`, or at the end of the text).
    fn read(&self, range: Range<usize>) -> Vec<SourceParagraph>;

    /// Changes since the last call, oldest first: local edits, undo and redo,
    /// imported updates.
    fn take_events(&mut self) -> Vec<SourceEvent>;

    /// Applies one edit as one commit with `origin`.
    fn edit(&mut self, edit: Edit<'_>, origin: &str) -> EditResult;

    /// Applies `edits` in order as **one** commit with `origin` (so one item
    /// on the author's undo stack): each edit's positions are those the edits
    /// before it left. Give non-overlapping ranges last first (a replace-all
    /// does) so every position is also a position before the batch, which
    /// the editor's anchor bookkeeping assumes. The result merges the edits':
    /// every deletion in order, the last edit's inserted range and caret, and
    /// the commit's undo items.
    ///
    /// The default commits each edit on its own (one undo item each: correct
    /// but slow to undo, since Loro's undo of N items in a row is
    /// quadratic); sources override it.
    fn edit_batch(&mut self, edits: &[Edit<'_>], origin: &str) -> EditResult {
        let mut merged = EditResult::default();
        for edit in edits {
            merged.merge(self.edit(edit.clone(), origin));
        }
        merged
    }

    /// Undoes one item of the author's undo stack. Returns whether anything
    /// changed. (The editor groups items into steps and calls this once per
    /// item.)
    fn undo_item(&mut self) -> bool;

    /// Redoes one item.
    fn redo_item(&mut self) -> bool;

    /// An anchor over `range` (non-empty).
    fn anchor(&self, range: Range<usize>) -> Option<Anchor>;

    /// Where an anchor points now.
    fn resolve(&self, anchor: &Anchor) -> Option<Resolved>;

    /// Every paragraph, and no pending event: what [`ProseSource::read_all`]
    /// returns, with the events up to that state dropped, as one step. The
    /// editor builds its mirror from it when opening and after
    /// [`ProseSource::needs_resync`]. A source whose document other threads
    /// also write (an Agent's or a sync's commit on a storage thread) must
    /// read and drop atomically, or a commit landing between the two would
    /// be applied twice; a single-threaded source keeps the default.
    fn resync(&mut self) -> Vec<SourceParagraph> {
        self.take_events();
        self.read_all()
    }

    /// Whether a read since the last [`ProseSource::take_events`] may have
    /// seen changes whose events the editor has not taken yet (another
    /// thread committed in between). The editor then rebuilds its mirror
    /// from [`ProseSource::resync`]. Single-threaded sources never need it.
    fn needs_resync(&mut self) -> bool {
        false
    }

    /// Imports remote updates and repairs block ids. Sources whose updates
    /// arrive another way (Drifting's sync) keep the default.
    fn import(&mut self, _bytes: &[u8]) -> Result<(), String> {
        Err("this source imports updates elsewhere".into())
    }

    /// For hosts and tests that need the concrete source back.
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;
}
