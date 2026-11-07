//! The editor's layer of undo (F4 builds on this): a prose session.
//!
//! An editor edits one prose document as the author and undoes only the
//! author's own typing (dr-doc's `ProseUndo`: merge interval 0, every origin
//! but `user` excluded; the editor groups bursts with the manager's hooks).
//! Every edit, undo and redo runs on the document's holder through the same
//! bridge as commands, so it is one commit, persisted before its event, and
//! the workspace's events and caches see it.
//!
//! This is the seam for F4: when gpui-prose's text source lands, `dr-editor`
//! implements it with a session (read through [`ProseSession::reader`],
//! subscribe through [`crate::Workspace::subscribe`], write through
//! [`ProseSession::edit`]).

use std::sync::{Arc, Mutex};

use dr_doc::prose::{ProseReader, ProseTxn};
use dr_doc::undo::ProseUndo;
use dr_model::DocId;

use crate::bridge::lock;
use crate::error::{Result, WsError};
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
        let undo = lock(&slot.mirror.doc).undo_manager();
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
        self.slot
            .mirror
            .write(dr_store::Origin::User, None, move |d, _| {
                let (r, _) = d.edit(dr_model::Origin::User, f);
                Ok(r?)
            })
    }

    /// Undo the author's last step; false when there is none.
    pub fn undo(&self) -> Result<bool> {
        let um = self.undo.clone();
        self.slot
            .mirror
            .write(dr_store::Origin::User, None, move |d, _| {
                Ok(lock(&um).undo(d)?.is_some())
            })
    }

    pub fn redo(&self) -> Result<bool> {
        let um = self.undo.clone();
        self.slot
            .mirror
            .write(dr_store::Origin::User, None, move |d, _| {
                Ok(lock(&um).redo(d)?.is_some())
            })
    }

    pub fn can_undo(&self) -> bool {
        lock(&self.undo).can_undo()
    }

    pub fn can_redo(&self) -> bool {
        lock(&self.undo).can_redo()
    }
}
