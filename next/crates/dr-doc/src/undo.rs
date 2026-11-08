//! The author's undo, configured the way `loro-schema.md` "撤销" requires.
//!
//! - Merge interval **0** and no manual groups: Loro #1228 and #1245 do not
//!   trigger then. The editor groups a burst of typing itself (record a time
//!   per item with `set_on_push`, pop several items per Undo).
//! - Every origin but `user` is excluded, so Undo never removes an Agent's,
//!   a sync's or a repair's change, nor the author's commands
//!   (`user:command`, undone by the workspace's journal); those are folded
//!   into the stacks like remote changes.
//! - Undo and redo are local writes. They go through [`ProseUndo::undo`] /
//!   [`ProseUndo::redo`] with the document's writer, so the step comes back as
//!   a [`Committed`] for storage like any other edit.
//! - No stack limit, set explicitly: `loro::UndoManager::new` keeps only 100
//!   items (only `loro-internal`'s own default is unlimited), which would
//!   leave the author about 100 keystrokes of undo. The editor groups items
//!   into steps of its own and pops them one by one, so every item it
//!   counted must still be on the stack; and a host that counts an edit's
//!   items from [`ProseUndo::undo_count`] before and after it
//!   (gpui-prose's `EditResult::undo_items`) would read 0 once a limited
//!   stack is full. Not gpui-prose's `UndoConfig::max_items` either: that is
//!   a limit too, only a later one. The stack lives as long as the editing
//!   session and holds one inverse diff per commit.
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
    /// The undo manager for a document someone else holds (see
    /// `prose::BorrowedProse`). Use [`Self::undo_step`] / [`Self::redo_step`]
    /// inside the holder's write: they apply the step and leave persisting to
    /// the holder.
    pub fn on(doc: &LoroDoc) -> Self {
        Self::new(doc)
    }

    pub(crate) fn new(doc: &LoroDoc) -> Self {
        let mut um = UndoManager::new(doc);
        // `UndoManager::new` caps the stack at 100; see the module comment.
        um.set_max_undo_steps(usize::MAX);
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

    /// Undo one item on the document this manager watches, without
    /// capturing the update: for a holder's write job. Loro commits any
    /// pending ops first, then commits the step itself; the holder exports
    /// and persists both as the author's (`user`). Returns whether there was
    /// anything to undo.
    pub fn undo_step(&mut self) -> Result<bool> {
        Ok(self.um.undo()?)
    }

    /// Redo one item; see [`Self::undo_step`].
    pub fn redo_step(&mut self) -> Result<bool> {
        Ok(self.um.redo()?)
    }

    /// The Loro manager, for the editor's own hooks (`set_on_push` /
    /// `set_on_pop` to record times and carry cursors). Do not call its
    /// `undo` / `redo` directly: the step would not reach storage.
    pub fn hooks(&mut self) -> &mut UndoManager {
        &mut self.um
    }
}
