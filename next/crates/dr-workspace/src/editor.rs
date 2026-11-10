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

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

use dr_doc::prose::{BorrowedProse, ProseReader, ProseTxn};
use dr_doc::undo::ProseUndo;
use dr_model::DocId;

use crate::error::{Result, WsError};
use crate::holder::{self, lock};
use crate::workspace::{Inner, ProseSlot, Workspace};

/// The author editing one prose document.
pub struct ProseSession {
    slot: Arc<ProseSlot>,
    undo: Arc<Mutex<ProseUndo>>,
    workspace: Weak<Inner>,
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
            workspace: Arc::downgrade(&self.inner),
        })
    }
}

impl ProseSession {
    /// Commit an author's multi-document edit without partial writes. Callers
    /// must validate their displayed versions inside `edit`, against the
    /// reserved copies. All sessions must be from one workspace and book.
    /// Never call a holder or command from `edit`. Failed guards, staging or
    /// persistence leave documents and all session undo histories unchanged.
    /// Existing single-document edit/undo behavior is unchanged.
    pub fn edit_atomic<R>(
        sessions: &[&ProseSession],
        edit: impl FnOnce(&BTreeMap<String, loro::LoroDoc>) -> Result<R>,
    ) -> Result<R> {
        let first = sessions
            .first()
            .ok_or_else(|| WsError::invalid("empty author edit"))?;
        if first.slot.book.is_none()
            || sessions.iter().any(|s| {
                s.slot.book != first.slot.book || !Weak::ptr_eq(&s.workspace, &first.workspace)
            })
        {
            return Err(WsError::invalid("author edit crosses workspace or book"));
        }
        let handles = sessions
            .iter()
            .map(|s| s.slot.handle.clone())
            .collect::<Vec<_>>();
        let book = first
            .slot
            .book
            .as_ref()
            .expect("validated book")
            .to_string();
        // The new atomic author path installs local text events after its
        // one durable transaction. Every manager watching a reserved holder
        // records the author step normally, preserving earlier Undo/Redo.
        dr_store::DocHandle::atomic_user(&handles, &book, edit, || {})
    }

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
