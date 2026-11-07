//! The author's undo, configured the way `loro-schema.md` "撤销" requires.
//!
//! - Merge interval **0** and no manual groups: Loro #1228 and #1245 do not
//!   trigger then. The editor groups a burst of typing itself (record a time
//!   per item with `set_on_push`, pop several items per Undo).
//! - Every origin but `user` is excluded, so Undo never removes an Agent's,
//!   a sync's or a repair's change; those are folded into the stacks like
//!   remote changes.
//! - Undo and redo are local writes. They go through [`ProseUndo::undo`] /
//!   [`ProseUndo::redo`] with the document's writer, so the step comes back as
//!   a [`Committed`] for storage like any other edit.
//!
//! Known: Loro #1229 is not avoidable — undoing the author's own formatting
//! change also clears another device's later change of the same key. Only
//! formatting, never text.

use dr_model::Origin;
use dr_model::origin::UNDO_EXCLUDED_ORIGIN_PREFIXES;
use loro::{LoroDoc, UndoManager};

use crate::core::Committed;
use crate::error::Result;
use crate::prose::ProseDoc;

/// The author's undo stack for one prose document.
pub struct ProseUndo {
    um: UndoManager,
}

impl ProseUndo {
    pub(crate) fn new(doc: &LoroDoc) -> Self {
        let mut um = UndoManager::new(doc);
        um.set_merge_interval(0);
        for p in UNDO_EXCLUDED_ORIGIN_PREFIXES {
            um.add_exclude_origin_prefix(p);
        }
        Self { um }
    }

    pub fn can_undo(&self) -> bool {
        self.um.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.um.can_redo()
    }

    pub fn undo_count(&self) -> usize {
        self.um.undo_count()
    }

    /// Undo one item on `doc` (the writer this manager was made from).
    pub fn undo(&mut self, doc: &mut ProseDoc) -> Result<Option<Committed>> {
        let um = &mut self.um;
        doc.core().capture_local(&Origin::User, || Ok(um.undo()?))
    }

    pub fn redo(&mut self, doc: &mut ProseDoc) -> Result<Option<Committed>> {
        let um = &mut self.um;
        doc.core().capture_local(&Origin::User, || Ok(um.redo()?))
    }

    /// The Loro manager, for the editor's own hooks (`set_on_push` /
    /// `set_on_pop` to record times and carry cursors). Do not call its
    /// `undo` / `redo` directly: the step would not reach storage.
    pub fn hooks(&mut self) -> &mut UndoManager {
        &mut self.um
    }
}
