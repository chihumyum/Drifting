//! The adapter between dr-doc's typed documents and dr-store's holders.
//!
//! dr-store's holder owns a plain `LoroDoc` and runs write closures on it;
//! dr-doc's `BookDoc` / `ProseDoc` own their own `LoroDoc` and expose typed
//! transactions only on that one. Neither can wrap the other's document yet
//! (f3-workspace.md "待协调" F1-1 / F2-1), so every document the workspace
//! opens has a **mirror**: a dr-doc writer holding the same history as the
//! holder's document, under the same peer id.
//!
//! The rules that keep the two identical:
//!
//! 1. The mirror is edited **only inside a holder write job**, on the holder
//!    thread: no other write to the holder's document can interleave, so the
//!    mirror's next op counter is never one the holder has used.
//! 2. Every job first brings the two level ([`sync_pair`]: whichever is
//!    behind imports what the other has), runs the edit on the mirror, then
//!    levels them again, which imports the mirror's new commit into the
//!    holder's document. The holder then persists it as one update row with
//!    the job's origin (and an Agent's settlement), and only then announces
//!    it. So "persist first, then notify" and "one commit, one origin" hold
//!    exactly as for a direct holder write.
//! 3. Readers read the mirror (`BookReader` / `ProseReader`). A write that
//!    reaches the holder some other way marks the mirror stale (the event
//!    listener compares frontiers); the next read levels it through an empty
//!    write job.
//!
//! The cost is a second copy of each open document in memory and an
//! export/import of every commit (a few microseconds for a keystroke-sized
//! commit). When dr-doc can open a transaction on a borrowed `LoroDoc`, the
//! mirror goes away and commands write inside the holder closure directly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use dr_doc::Committed;
use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_store::{AgentWrite, DocHandle};
use loro::{CommitOptions, ExportMode, Frontiers, LoroDoc, VersionVector};

use crate::error::{Result, WsError};

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the bridge needs from a dr-doc writer.
pub(crate) trait Mirrored: Send + 'static {
    fn version(&self) -> VersionVector;
    fn frontiers(&self) -> Frontiers;
    fn export_since(&self, vv: &VersionVector) -> dr_doc::Result<Vec<u8>>;
    /// Import updates the holder has and the mirror lacks. Returns a repair
    /// commit dr-doc made right after (prose: duplicate block ids).
    fn absorb(&mut self, bytes: &[u8]) -> dr_doc::Result<Option<Committed>>;
}

impl Mirrored for BookDoc {
    fn version(&self) -> VersionVector {
        BookDoc::version(self)
    }
    fn frontiers(&self) -> Frontiers {
        BookDoc::frontiers(self)
    }
    fn export_since(&self, vv: &VersionVector) -> dr_doc::Result<Vec<u8>> {
        self.export_updates_since(vv)
    }
    fn absorb(&mut self, bytes: &[u8]) -> dr_doc::Result<Option<Committed>> {
        Ok(self.import(bytes, dr_model::Origin::Sync)?.repair)
    }
}

impl Mirrored for ProseDoc {
    fn version(&self) -> VersionVector {
        ProseDoc::version(self)
    }
    fn frontiers(&self) -> Frontiers {
        ProseDoc::frontiers(self)
    }
    fn export_since(&self, vv: &VersionVector) -> dr_doc::Result<Vec<u8>> {
        self.export_updates_since(vv)
    }
    fn absorb(&mut self, bytes: &[u8]) -> dr_doc::Result<Option<Committed>> {
        Ok(self.import(bytes, dr_model::Origin::Sync)?.repair)
    }
}

/// Bring the mirror and the holder's document level: whichever is behind
/// imports what the other has. Runs on the holder thread only. A repair the
/// mirror makes while absorbing is a new mirror commit, so loop until equal.
pub(crate) fn sync_pair<D: Mirrored>(m: &mut D, doc: &LoroDoc) -> Result<()> {
    for _ in 0..4 {
        let dv = doc.oplog_vv();
        let mv = m.version();
        if dv == mv {
            return Ok(());
        }
        if !mv.includes_vv(&dv) {
            let bytes = doc.export(ExportMode::updates(&mv))?;
            m.absorb(&bytes)?;
        }
        let dv = doc.oplog_vv();
        let mv = m.version();
        if !dv.includes_vv(&mv) {
            let bytes = m.export_since(&dv)?;
            doc.import(&bytes)?;
        }
    }
    if doc.oplog_vv() == m.version() {
        Ok(())
    } else {
        Err(WsError::Internal(
            "mirror and holder document did not converge".into(),
        ))
    }
}

/// An open document: its holder and its mirror.
pub(crate) struct Mirror<D> {
    pub(crate) handle: DocHandle,
    pub(crate) doc: Arc<Mutex<D>>,
    stale: AtomicBool,
}

impl<D: Mirrored> Mirror<D> {
    pub(crate) fn new(handle: DocHandle, doc: D) -> Self {
        Self {
            handle,
            doc: Arc::new(Mutex::new(doc)),
            stale: AtomicBool::new(false),
        }
    }

    /// Run `f` on the holder thread with the mirror level with the holder's
    /// document. `f` edits the mirror (through dr-doc) and may also edit the
    /// holder's raw document (`revert_to`); either way the two are levelled
    /// afterwards and the holder persists the result as one row under
    /// `origin`. For an Agent, `agent` makes it a settled write.
    pub(crate) fn write<R, F>(
        &self,
        origin: dr_store::Origin,
        agent: Option<AgentWrite>,
        f: F,
    ) -> Result<R>
    where
        F: FnOnce(&mut D, &LoroDoc) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let m = self.doc.clone();
        let commit_origin = origin.clone();
        let job = move |doc: &LoroDoc| -> Result<R> {
            let mut g = lock(&m);
            sync_pair(&mut *g, doc)?;
            let r = f(&mut g, doc);
            // Raw edits (if any) are committed with this write's origin
            // before levelling exports them.
            let mut options = CommitOptions::new().origin(&commit_origin.to_string());
            if let Some(msg) = commit_origin.commit_message() {
                options = options.commit_msg(&msg);
            }
            doc.commit_with(options);
            // Level even when `f` failed: dr-doc commits whatever it applied.
            sync_pair(&mut *g, doc)?;
            r
        };
        let (r, _) = match agent {
            Some(a) => self.handle.write_agent(a, job)?,
            None => self.handle.write(origin, job)?,
        };
        self.stale.store(false, Ordering::Release);
        r
    }

    /// A write `f` made through the holder some other way: level the mirror
    /// before the next read.
    pub(crate) fn mark_stale(&self) {
        self.stale.store(true, Ordering::Release);
    }

    pub(crate) fn is_stale(&self) -> bool {
        self.stale.load(Ordering::Acquire)
    }

    /// Level a stale mirror (an empty write job; a repair it makes is stored
    /// as a repair).
    pub(crate) fn refresh(&self) -> Result<()> {
        if self.is_stale() {
            self.write(crate::actor::repair_store_origin(), None, |_, _| Ok(()))?;
        }
        Ok(())
    }

    /// Called from the holder's event listener (on the holder thread, after
    /// a persisted change): is the mirror behind the event? A busy mirror is
    /// conservatively treated as behind.
    pub(crate) fn check_event(&self, frontiers: &Frontiers) {
        match self.doc.try_lock() {
            Ok(g) => {
                if &g.frontiers() != frontiers {
                    self.mark_stale();
                }
            }
            Err(_) => self.mark_stale(),
        }
    }

    pub(crate) fn frontiers(&self) -> Frontiers {
        lock(&self.doc).frontiers()
    }
}
