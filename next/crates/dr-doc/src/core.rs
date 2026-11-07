//! What the book and prose documents share: loading, committing with an
//! origin, importing and exporting.

use dr_model::{DocId, Origin};
use loro::{
    CommitOptions, ExportMode, Frontiers, LoroDoc, LoroValue, ValueOrContainer, VersionVector,
};

use crate::error::{DocError, Result};
use crate::peer::{PeerId, is_device_peer};
use crate::schema;

/// One local commit, ready for storage: append `update` to the document's
/// update log with `origin` (`loro_update.origin`), then publish events and
/// upload. Storage must persist it before anything leaves the device.
#[derive(Clone, Debug)]
pub struct Committed {
    pub doc_id: DocId,
    pub origin: Origin,
    /// Loro update bytes of exactly this commit.
    pub update: Vec<u8>,
}

/// What importing remote bytes did.
#[derive(Clone, Debug, Default)]
pub struct Imported {
    /// Some ops wait for dependencies that have not arrived yet; Loro keeps
    /// them and applies them when the rest arrives.
    pub pending: bool,
    /// A deterministic repair this device wrote right after the import
    /// (origin `repair`). Persist it like any local commit.
    pub repair: Option<Committed>,
}

/// A configured Loro document and its id.
pub(crate) struct Core {
    pub(crate) doc: LoroDoc,
    pub(crate) id: DocId,
}

impl Clone for Core {
    /// A shared handle on the same document (Loro clones share state).
    fn clone(&self) -> Self {
        Self {
            doc: self.doc.clone(),
            id: self.id.clone(),
        }
    }
}

pub(crate) fn configured() -> LoroDoc {
    let doc = LoroDoc::new();
    schema::configure(&doc);
    doc
}

pub(crate) fn check_peer(peer: PeerId) -> Result<()> {
    if is_device_peer(peer) {
        Ok(())
    } else {
        Err(DocError::ReservedPeer(peer))
    }
}

/// A borrowed document must already carry its genesis, and be the document
/// it is said to be.
pub(crate) fn check_borrowed(doc: &LoroDoc, id: &DocId, key: &str) -> Result<()> {
    if doc.get_map(schema::prose::META).get(key).is_none() {
        return Err(DocError::NotInitialized(id.clone()));
    }
    check_meta(doc, id, key)
}

fn check_meta(doc: &LoroDoc, id: &DocId, key: &str) -> Result<()> {
    let want = match key {
        schema::meta::BOOK => id.entity_id().to_string(),
        _ => id.to_string(),
    };
    match doc.get_map(schema::prose::META).get(key) {
        Some(ValueOrContainer::Value(LoroValue::String(s))) if s.as_str() != want => {
            Err(DocError::WrongDocument {
                expected: id.clone(),
                found: s.to_string(),
            })
        }
        // A document without meta can only be damaged (or empty); the
        // genesis imported next writes it.
        _ => Ok(()),
    }
}

impl Core {
    /// Load `blobs` (a snapshot and/or updates, in any order) plus the
    /// genesis, check that they belong to `id`, and edit as `peer`.
    pub(crate) fn load(
        id: DocId,
        genesis: &[u8],
        blobs: &[Vec<u8>],
        peer: Option<PeerId>,
        meta_key: &str,
    ) -> Result<Self> {
        let doc = configured();
        // Stored bytes first (a snapshot then takes the fast path into the
        // empty document) and check they are this document's, then the
        // genesis, a no-op when the stored bytes already contain it.
        if !blobs.is_empty() {
            // `import_batch` decodes without checking Loro's checksum, and its
            // decoder trusts lengths inside the bytes: one corrupted blob can
            // make it allocate tens of gigabytes and abort the process (found
            // by the `load_bytes` fuzz target). Check every checksum first, so
            // corruption is an error, not a crash. (`import` checks on its own.)
            for b in blobs {
                LoroDoc::decode_import_blob_meta(b, true)?;
            }
            doc.import_batch(blobs)?;
            check_meta(&doc, &id, meta_key)?;
        }
        doc.import(genesis)?;
        let core = Core { doc, id };
        if let Some(peer) = peer {
            check_peer(peer)?;
            core.doc.set_peer_id(peer)?;
        }
        Ok(core)
    }

    pub(crate) fn peer(&self) -> PeerId {
        self.doc.peer_id()
    }

    pub(crate) fn set_peer(&self, peer: PeerId) -> Result<()> {
        check_peer(peer)?;
        self.doc.set_peer_id(peer)?;
        Ok(())
    }

    /// Run `f` as one commit with `origin`. Whatever `f` applied is committed
    /// even when it returns an error, so no op is ever left pending under the
    /// wrong origin. Returns `f`'s result and the commit (if anything changed).
    pub(crate) fn transact<R>(
        &self,
        origin: &Origin,
        timestamp: Option<i64>,
        f: impl FnOnce() -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        let before = self.doc.oplog_vv();
        let options = || {
            let mut o = CommitOptions::new().origin(&origin.as_string());
            if let Some(m) = origin.commit_message() {
                o = o.commit_msg(&m);
            }
            if let Some(t) = timestamp {
                o = o.timestamp(t);
            }
            o
        };
        // Some reads commit the pending transaction implicitly (resolving a
        // cursor on deleted text replays history behind a commit barrier).
        // Setting the options up front makes such an implicit commit carry the
        // same origin and message; the explicit commit below covers the rest.
        self.doc.set_next_commit_options(options());
        let result = f();
        self.doc.commit_with(options());
        let committed = self.export_since(&before, origin);
        (result, committed)
    }

    fn export_since(&self, before: &VersionVector, origin: &Origin) -> Option<Committed> {
        if self.doc.oplog_vv() == *before {
            return None;
        }
        let update = self
            .doc
            .export(ExportMode::updates(before))
            .expect("exporting local updates cannot fail");
        Some(Committed {
            doc_id: self.id.clone(),
            origin: origin.clone(),
            update,
        })
    }

    /// Import remote bytes. Returns whether some ops are pending.
    pub(crate) fn import(&self, bytes: &[u8], origin: &Origin) -> Result<bool> {
        let status = self.doc.import_with(bytes, &origin.as_string())?;
        Ok(status.pending.is_some())
    }

    pub(crate) fn version(&self) -> VersionVector {
        self.doc.oplog_vv()
    }

    pub(crate) fn frontiers(&self) -> Frontiers {
        self.doc.oplog_frontiers()
    }

    pub(crate) fn export_updates_since(&self, vv: &VersionVector) -> Result<Vec<u8>> {
        Ok(self.doc.export(ExportMode::updates(vv))?)
    }

    pub(crate) fn export_snapshot(&self) -> Result<Vec<u8>> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    /// Run a local undo/redo step `f` (which commits on its own) and capture
    /// its update with origin `user`.
    pub(crate) fn capture_local(
        &self,
        origin: &Origin,
        f: impl FnOnce() -> Result<bool>,
    ) -> Result<Option<Committed>> {
        let before = self.doc.oplog_vv();
        self.doc
            .set_next_commit_options(CommitOptions::new().origin(&origin.as_string()));
        let did = f()?;
        self.doc.commit();
        Ok(if did {
            self.export_since(&before, origin)
        } else {
            None
        })
    }
}
