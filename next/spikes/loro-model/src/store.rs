//! SQLite storage of Loro documents: an append-only update log per document,
//! one compacted snapshot per document, and the peer id each (device,
//! document) pair edits with.
//!
//! - Every local commit is appended as one row (`append_update`) in its own
//!   transaction before it is announced or uploaded.
//! - Compaction writes a fresh snapshot and deletes the updates it covers in
//!   one transaction, so a crash leaves either the old snapshot plus all
//!   updates or the new snapshot plus the newer updates.
//! - Loading imports the snapshot and the newer updates in one batch; Loro
//!   dedupes anything that overlaps, so a superset is harmless.

use std::path::Path;

use anyhow::{Context, Result};
use loro::{ExportMode, LoroDoc};
use rusqlite::{Connection, OptionalExtension, params};

use crate::ids::random_peer_id;
use crate::schema;

pub const MIGRATION_0000: &str = r#"
CREATE TABLE IF NOT EXISTS library_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS loro_doc (
    doc_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS loro_update (
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    origin TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (doc_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS loro_snapshot (
    doc_id TEXT PRIMARY KEY NOT NULL,
    upto_seq INTEGER NOT NULL,
    vv BLOB NOT NULL,
    frontiers BLOB NOT NULL,
    bytes BLOB NOT NULL,
    ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS loro_peer (
    doc_id TEXT PRIMARY KEY NOT NULL,
    peer_id INTEGER NOT NULL,
    epoch TEXT NOT NULL
) WITHOUT ROWID;
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Durability {
    /// WAL + synchronous=NORMAL: survives a process crash; the last
    /// transactions may be lost on power failure.
    Normal,
    /// WAL + synchronous=FULL: also survives power failure.
    Full,
}

pub struct Store {
    pub conn: Connection,
    epoch: String,
}

#[derive(Debug, Clone, Copy)]
pub struct CompactStats {
    pub snapshot_bytes: usize,
    pub deleted_updates: usize,
    pub upto_seq: i64,
}

fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

impl Store {
    pub fn open(path: &Path, durability: Durability) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| "open sqlite")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(
            None,
            "synchronous",
            match durability {
                Durability::Normal => "NORMAL",
                Durability::Full => "FULL",
            },
        )?;
        conn.execute_batch(MIGRATION_0000)?;
        let epoch: Option<String> = conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = 'epoch'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let epoch = match epoch {
            Some(e) => e,
            None => {
                let e = format!("{:016x}", random_peer_id());
                conn.execute(
                    "INSERT INTO library_meta(key, value) VALUES ('epoch', ?1)",
                    [&e],
                )?;
                e
            }
        };
        Ok(Self { conn, epoch })
    }

    /// What restoring a backup or copying a library must do: new epoch, so
    /// every document gets a new peer id before its next local edit. Reusing
    /// a peer id from a copy could write different changes under ids another
    /// replica already has.
    pub fn rotate_epoch(&mut self) -> Result<()> {
        let e = format!("{:016x}", random_peer_id());
        self.conn.execute(
            "UPDATE library_meta SET value = ?1 WHERE key = 'epoch'",
            [&e],
        )?;
        self.epoch = e;
        Ok(())
    }

    /// The peer id this device edits `doc_id` with, allocated and persisted
    /// on first use (and again after an epoch change).
    pub fn peer_for(&self, doc_id: &str) -> Result<u64> {
        let row: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT peer_id, epoch FROM loro_peer WHERE doc_id = ?1",
                [doc_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((peer, epoch)) = row
            && epoch == self.epoch
        {
            return Ok(peer as u64);
        }
        let peer = random_peer_id();
        self.conn.execute(
            "INSERT INTO loro_peer(doc_id, peer_id, epoch) VALUES (?1, ?2, ?3)
             ON CONFLICT(doc_id) DO UPDATE SET peer_id = excluded.peer_id, epoch = excluded.epoch",
            params![doc_id, peer as i64, self.epoch],
        )?;
        Ok(peer)
    }

    pub fn register(&self, doc_id: &str, kind: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO loro_doc(doc_id, kind) VALUES (?1, ?2)",
            params![doc_id, kind],
        )?;
        Ok(())
    }

    /// Append one encoded update (one local commit, or one imported batch).
    pub fn append_update(&self, doc_id: &str, bytes: &[u8], origin: &str) -> Result<i64> {
        let tx = self.conn.unchecked_transaction()?;
        let seq: i64 = tx.query_row(
            "SELECT coalesce(max(seq), 0) + 1 FROM (
                SELECT seq FROM loro_update WHERE doc_id = ?1
                UNION ALL SELECT upto_seq AS seq FROM loro_snapshot WHERE doc_id = ?1)",
            [doc_id],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO loro_update(doc_id, seq, bytes, origin, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![doc_id, seq, bytes, origin, now_s()],
        )?;
        tx.commit()?;
        Ok(seq)
    }

    /// Write a snapshot of `doc` and delete the updates it covers, in one
    /// transaction. `doc` must already contain every appended update (the
    /// document holder appends each commit before compacting).
    pub fn compact(&self, doc_id: &str, doc: &LoroDoc) -> Result<CompactStats> {
        self.compact_with(doc_id, doc, &|| {})
    }

    /// [`Self::compact`] with a hook that runs inside the transaction, after
    /// the snapshot is written and before the covered updates are deleted.
    /// The crash probe uses it to hold the transaction open while it kills
    /// the process.
    pub fn compact_with(
        &self,
        doc_id: &str,
        doc: &LoroDoc,
        mid: &dyn Fn(),
    ) -> Result<CompactStats> {
        let tx = self.conn.unchecked_transaction()?;
        let upto: i64 = tx.query_row(
            "SELECT coalesce(max(seq), 0) FROM (
                SELECT seq FROM loro_update WHERE doc_id = ?1
                UNION ALL SELECT upto_seq AS seq FROM loro_snapshot WHERE doc_id = ?1)",
            [doc_id],
            |r| r.get(0),
        )?;
        let bytes = doc.export(ExportMode::Snapshot)?;
        tx.execute(
            "INSERT INTO loro_snapshot(doc_id, upto_seq, vv, frontiers, bytes, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(doc_id) DO UPDATE SET upto_seq = excluded.upto_seq, vv = excluded.vv,
               frontiers = excluded.frontiers, bytes = excluded.bytes, ts = excluded.ts",
            params![
                doc_id,
                upto,
                doc.oplog_vv().encode(),
                doc.oplog_frontiers().encode(),
                bytes,
                now_s()
            ],
        )?;
        mid();
        let deleted = tx.execute(
            "DELETE FROM loro_update WHERE doc_id = ?1 AND seq <= ?2",
            params![doc_id, upto],
        )?;
        tx.commit()?;
        Ok(CompactStats {
            snapshot_bytes: bytes.len(),
            deleted_updates: deleted,
            upto_seq: upto,
        })
    }

    /// How many updates and bytes are waiting for compaction.
    pub fn pending(&self, doc_id: &str) -> Result<(i64, i64)> {
        let upto: i64 = self
            .conn
            .query_row(
                "SELECT upto_seq FROM loro_snapshot WHERE doc_id = ?1",
                [doc_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        Ok(self.conn.query_row(
            "SELECT count(*), coalesce(sum(length(bytes)), 0) FROM loro_update WHERE doc_id = ?1 AND seq > ?2",
            params![doc_id, upto],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    /// Load a document: snapshot plus newer updates, imported in one batch.
    /// Returns `None` when nothing is stored for it.
    pub fn load(&self, doc_id: &str) -> Result<Option<LoroDoc>> {
        let snap: Option<(i64, Vec<u8>)> = self
            .conn
            .query_row(
                "SELECT upto_seq, bytes FROM loro_snapshot WHERE doc_id = ?1",
                [doc_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let upto = snap.as_ref().map(|s| s.0).unwrap_or(0);
        let mut stmt = self.conn.prepare_cached(
            "SELECT bytes FROM loro_update WHERE doc_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let updates: Vec<Vec<u8>> = stmt
            .query_map(params![doc_id, upto], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if snap.is_none() && updates.is_empty() {
            return Ok(None);
        }
        let doc = LoroDoc::new();
        schema::configure(&doc);
        let mut batch = Vec::with_capacity(updates.len() + 1);
        if let Some((_, bytes)) = snap {
            batch.push(bytes);
        }
        batch.extend(updates);
        if batch.len() == 1 {
            doc.import(&batch[0])?;
        } else {
            doc.import_batch(&batch)?;
        }
        Ok(Some(doc))
    }

    /// Load and set this device's peer for editing.
    pub fn load_for_edit(&self, doc_id: &str) -> Result<Option<LoroDoc>> {
        let Some(doc) = self.load(doc_id)? else {
            return Ok(None);
        };
        doc.set_peer_id(self.peer_for(doc_id)?)?;
        Ok(Some(doc))
    }

    pub fn doc_ids(&self, kind: Option<&str>) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT doc_id FROM loro_doc WHERE ?1 IS NULL OR kind = ?1 ORDER BY doc_id")?;
        let ids = stmt
            .query_map([kind], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// Database size in bytes (pages in use).
    pub fn size_bytes(&self) -> Result<i64> {
        let pages: i64 = self.conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let size: i64 = self.conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        Ok(pages * size)
    }
}

/// Holds one open document and persists every commit: what F2's document
/// actor does on its own thread. Each commit carries its origin; the encoded
/// update is appended before `commit` returns.
pub struct Holder {
    pub doc_id: String,
    pub doc: LoroDoc,
    last_vv: loro::VersionVector,
}

impl Holder {
    /// Hold a document loaded from the store (everything already persisted).
    pub fn loaded(doc_id: &str, doc: LoroDoc) -> Self {
        let last_vv = doc.oplog_vv();
        Self {
            doc_id: doc_id.to_string(),
            doc,
            last_vv,
        }
    }

    /// Hold a document that has not been persisted yet (for example a new
    /// one at genesis): the first flush writes its whole history.
    pub fn new(doc_id: &str, doc: LoroDoc) -> Self {
        let last_vv = loro::VersionVector::default();
        Self {
            doc_id: doc_id.to_string(),
            doc,
            last_vv,
        }
    }

    /// Commit pending edits with `origin` and append them. Returns the update
    /// size, or 0 when nothing changed.
    pub fn commit(&mut self, store: &Store, origin: &str) -> Result<usize> {
        self.doc.set_next_commit_origin(origin);
        self.doc.commit();
        self.flush(store, origin)
    }

    /// Append everything since the last append (after a commit or an import).
    pub fn flush(&mut self, store: &Store, origin: &str) -> Result<usize> {
        let vv = self.doc.oplog_vv();
        if vv == self.last_vv {
            return Ok(0);
        }
        let bytes = self.doc.export(ExportMode::updates(&self.last_vv))?;
        store.append_update(&self.doc_id, &bytes, origin)?;
        self.last_vv = vv;
        Ok(bytes.len())
    }
}
