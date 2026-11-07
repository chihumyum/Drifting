//! The editor's layer of undo (F4 builds on this): a prose session.
//!
//! An editor edits one prose document as the author and undoes only the
//! author's own typing (dr-doc's `ProseUndo`: merge interval 0, every origin
//! but `user` excluded; the editor groups bursts with the manager's hooks).
//! The author's commands on the same document (the command palette, the
//! Agent panel acting for the author, an object-level undo) commit with
//! [`crate::COMMAND_ORIGIN`], which the session's manager also leaves out:
//! they are undone through the journal ([`crate::Workspace::undo`]), and the
//! editor folds them in like anyone else's change.
//! Every edit, undo and redo is a write job on the document's holder, like a
//! command's, so it is one commit, persisted before its event, and the
//! workspace's events and caches see it. The undo manager watches the
//! holder's own document: an Agent's or a sync's change is a commit with
//! another origin, which the manager folds in like a remote change and never
//! undoes.
//!
//! This is the seam for F4: when gpui-prose's text source lands, `dr-editor`
//! implements it with a session (read through [`ProseSession::reader`],
//! subscribe through [`crate::Workspace::subscribe`], write through
//! [`ProseSession::edit`]).

use std::sync::{Arc, Mutex};

use dr_doc::prose::{BorrowedProse, ProseReader, ProseTxn};
use dr_doc::undo::ProseUndo;
use dr_model::DocId;

use crate::error::{Result, WsError};
use crate::holder::{self, lock};
use crate::workspace::{ProseSlot, Workspace};

/// The author editing one prose document.
pub struct ProseSession {
    slot: Arc<ProseSlot>,
    undo: Arc<Mutex<ProseUndo>>,
}

impl Workspace {
    /// Open an editing session on prose document `doc` (`node:<id>`, …).
    pub fn prose_session(&self, doc: &str) -> Result<ProseSession> {
        let d = DocId::parse(doc).map_err(|e| WsError::invalid(e.to_string()))?;
        let slot = self.prose_slot(&d)?;
        // Made on the holder thread: the manager subscribes to the document.
        // Besides every origin but `user` (dr-doc's rule), it leaves out the
        // author's commands: the editor's Undo takes back the editor's own
        // steps, never a command run from elsewhere on this document.
        let undo = slot.handle.read(|doc| {
            let mut undo = ProseUndo::on(doc);
            undo.hooks()
                .add_exclude_origin_prefix(holder::COMMAND_ORIGIN);
            undo
        })?;
        Ok(ProseSession {
            slot,
            undo: Arc::new(Mutex::new(undo)),
        })
    }
}

impl ProseSession {
    /// A read handle on the document (what the editor lays out).
    pub fn reader(&self) -> ProseReader {
        self.slot.reader.clone()
    }

    /// One commit by the author.
    pub fn edit<R, F>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut ProseTxn<'_>) -> dr_doc::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let doc_id = self.slot.doc.clone();
        holder::write(
            &self.slot.handle,
            dr_store::Origin::User,
            None,
            move |doc| {
                let b = BorrowedProse::new(doc, &doc_id)?;
                let mut txn = b.txn();
                Ok(f(&mut txn)?)
            },
        )
    }

    /// Undo the author's last step; false when there is none.
    pub fn undo(&self) -> Result<bool> {
        let um = self.undo.clone();
        holder::write(&self.slot.handle, dr_store::Origin::User, None, move |_| {
            Ok(lock(&um).undo_step()?)
        })
    }

    pub fn redo(&self) -> Result<bool> {
        let um = self.undo.clone();
        holder::write(&self.slot.handle, dr_store::Origin::User, None, move |_| {
            Ok(lock(&um).redo_step()?)
        })
    }

    pub fn can_undo(&self) -> bool {
        lock(&self.undo).can_undo()
    }

    pub fn can_redo(&self) -> bool {
        lock(&self.undo).can_redo()
    }
}
