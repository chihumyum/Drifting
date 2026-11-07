//! The library: database connections, the single-owner lock, the epoch and
//! per-document peer ids, loading and copying documents, and the registry of
//! open document holders.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use loro::{ExportMode, Frontiers, LoroDoc};
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::file_io::{durable_replace_file, sync_file, temporary_sibling};
use crate::holder::{self, DocHandle, Shared};
use crate::migrate::{self, Durability, MIGRATIONS, Migration, MigrationFault, OpenReport};
use crate::origin::Origin;
use crate::{now_ms, random_peer_id, random_u64};

/// When a document holder writes a fresh snapshot. A holder compacts once it
/// has been idle for `idle` with at least `max_updates` updates or
/// `max_bytes` of updates since the last snapshot, and when it closes with
/// at least `on_close_min_updates`.
#[derive(Clone, Debug)]
pub struct CompactionPolicy {
    pub max_updates: usize,
    pub max_bytes: usize,
    pub idle: Duration,
    pub on_close_min_updates: usize,
}

impl Default for CompactionPolicy {
    /// From `f2-bench` (docs/rust-rewrite/acceptance/f2-store-bench.json):
    /// each keystroke-sized update left on top of a 20 000-character
    /// chapter's snapshot adds about 6.5 µs to opening it, and compacting a
    /// few hundred costs about a millisecond. 200 keeps an open under ~1.5 ms.
    fn default() -> Self {
        Self {
            max_updates: 200,
            max_bytes: 1 << 20,
            idle: Duration::from_millis(750),
            on_close_min_updates: 50,
        }
    }
}

pub type ConfigureDoc = Arc<dyn Fn(&LoroDoc) + Send + Sync>;

#[derive(Clone)]
pub struct LibraryOptions {
    /// The build opening the library. Names the safety snapshot directory;
    /// a change of version takes a safety snapshot even with no migration.
    pub app_version: String,
    pub durability: Durability,
    pub compaction: CompactionPolicy,
    /// Runs on every `LoroDoc` the store creates (to load, copy or create a
    /// document) before anything is imported: dr-doc's style configuration
    /// (loro-schema.md). The store itself turns on timestamps.
    pub configure_doc: Option<ConfigureDoc>,
    /// Test hook: fail or pause a migration at a stage.
    #[doc(hidden)]
    pub migration_fault: Option<MigrationFault>,
    /// Test hook: hold every compaction transaction open this long between
    /// writing the snapshot and deleting the covered updates.
    #[doc(hidden)]
    pub compaction_pause: Option<Duration>,
    /// Test hook: fail this many update appends (as a full disk would).
    #[doc(hidden)]
    pub append_faults: Option<Arc<std::sync::atomic::AtomicUsize>>,
}

impl LibraryOptions {
    pub fn new(app_version: impl Into<String>) -> Self {
        Self {
            app_version: app_version.into(),
            durability: Durability::Normal,
            compaction: CompactionPolicy::default(),
            configure_doc: None,
            migration_fault: None,
            compaction_pause: None,
            append_faults: None,
        }
    }
}

impl std::fmt::Debug for LibraryOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LibraryOptions")
            .field("app_version", &self.app_version)
            .field("durability", &self.durability)
            .field("compaction", &self.compaction)
            .field("configure_doc", &self.configure_doc.is_some())
            .finish_non_exhaustive()
    }
}

/// The files of a library directory.
#[derive(Clone, Debug)]
pub struct LibraryPaths {
    pub root: PathBuf,
    pub db: PathBuf,
    pub lock: PathBuf,
    pub assets: PathBuf,
    pub safety_snapshots: PathBuf,
}

impl LibraryPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            db: root.join("library.sqlite"),
            lock: root.join("library.lock"),
            assets: root.join("assets"),
            safety_snapshots: root.join("safety-snapshots"),
            root,
        }
    }
}

/// How to open a document.
pub enum OpenDoc<'a> {
    /// It must already be stored.
    Existing,
    /// Open it, or create it when nothing is stored: `genesis` writes the
    /// document's deterministic first change on a fresh, configured doc
    /// (dr-doc sets its genesis peer and timestamp 0). It is appended with
    /// origin `genesis`, then the device peer takes over.
    CreateIfMissing {
        kind: &'a str,
        book_id: Option<&'a str>,
        genesis: &'a dyn Fn(&LoroDoc),
    },
}

/// A stored document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocInfo {
    pub doc_id: String,
    pub kind: String,
    pub book_id: Option<String>,
}

/// What loading a document read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LoadStats {
    /// `upto_seq` of the snapshot (0 when there is none).
    pub snapshot_seq: i64,
    pub snapshot_bytes: usize,
    /// Updates imported on top of the snapshot.
    pub updates: usize,
    pub update_bytes: usize,
    /// The highest sequence number stored for the document.
    pub last_seq: i64,
}

/// One row of a document's update log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredUpdate {
    pub seq: i64,
    pub origin: String,
    pub ts: i64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompactStats {
    pub upto_seq: i64,
    pub snapshot_bytes: usize,
    pub deleted_updates: usize,
}

pub(crate) enum Slot {
    Opening,
    Open(Weak<Shared>),
}

pub(crate) struct Inner {
    pub paths: LibraryPaths,
    pub options: LibraryOptions,
    pub report: OpenReport,
    writer: Mutex<Connection>,
    reader: Mutex<Connection>,
    epoch: Mutex<String>,
    pub docs: Mutex<HashMap<String, Slot>>,
    pub docs_changed: Condvar,
    /// Identifies this process's asset imports for garbage collection.
    pub session: String,
    _lock: File,
}

impl Inner {
    pub fn writer(&self) -> MutexGuard<'_, Connection> {
        self.writer.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn reader(&self) -> MutexGuard<'_, Connection> {
        self.reader.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn new_doc(&self) -> LoroDoc {
        let doc = LoroDoc::new();
        if let Some(configure) = &self.options.configure_doc {
            configure(&doc);
        }
        doc.set_record_timestamp(true);
        doc
    }

    pub fn epoch(&self) -> String {
        self.epoch.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The doc slot was released by its holder thread.
    pub fn release(&self, doc_id: &str) {
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        docs.remove(doc_id);
        self.docs_changed.notify_all();
    }
}

struct OpeningSlot<'a> {
    inner: &'a Inner,
    doc_id: &'a str,
    armed: bool,
}

impl Drop for OpeningSlot<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.inner.release(self.doc_id);
        }
    }
}

/// An open library. Cheap to clone; the database closes when the last clone
/// and every document handle are gone.
#[derive(Clone)]
pub struct Library {
    pub(crate) inner: Arc<Inner>,
}

fn take_lock(paths: &LibraryPaths) -> Result<File> {
    fs::create_dir_all(&paths.root)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.lock)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(fs::TryLockError::WouldBlock) => Err(StoreError::invalid(
            "library",
            "already open in another process or handle",
        )),
        Err(fs::TryLockError::Error(e)) => Err(e.into()),
    }
}

impl Library {
    /// Open (create or migrate) the library in `root`.
    pub fn open(root: impl Into<PathBuf>, options: LibraryOptions) -> Result<Self> {
        Self::open_with_migrations(root, options, MIGRATIONS)
    }

    /// [`Self::open`] with another migration list: tests use it to play a
    /// later build that appends migrations.
    pub fn open_with_migrations(
        root: impl Into<PathBuf>,
        options: LibraryOptions,
        migrations: &[Migration],
    ) -> Result<Self> {
        let paths = LibraryPaths::new(root);
        let lock = take_lock(&paths)?;
        Self::open_locked(paths, options, migrations, lock)
    }

    fn open_locked(
        paths: LibraryPaths,
        options: LibraryOptions,
        migrations: &[Migration],
        lock: File,
    ) -> Result<Self> {
        let (writer, report) = migrate::open_database(
            &paths.db,
            &paths.safety_snapshots,
            &options.app_version,
            options.durability,
            migrations,
            options.migration_fault,
        )?;
        let now = now_ms().to_string();
        writer.execute(
            "INSERT OR IGNORE INTO library_meta (key, value) VALUES ('created_ms', ?1)",
            [&now],
        )?;
        writer.execute(
            "INSERT INTO library_meta (key, value) VALUES ('app_version', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [&options.app_version],
        )?;
        let epoch: Option<String> = writer
            .query_row(
                "SELECT value FROM library_meta WHERE key = 'epoch'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let epoch = match epoch {
            Some(e) => e,
            None => {
                let e = format!("{:016x}", random_u64());
                writer.execute(
                    "INSERT INTO library_meta (key, value) VALUES ('epoch', ?1)",
                    [&e],
                )?;
                e
            }
        };
        let reader = migrate::open_connection(&paths.db, options.durability)?;
        reader.pragma_update(None, "query_only", true)?;
        Ok(Self {
            inner: Arc::new(Inner {
                paths,
                options,
                report,
                writer: Mutex::new(writer),
                reader: Mutex::new(reader),
                epoch: Mutex::new(epoch),
                docs: Mutex::new(HashMap::new()),
                docs_changed: Condvar::new(),
                session: format!("{:016x}", random_u64()),
                _lock: lock,
            }),
        })
    }

    /// Replace the library in `root` with `backup` (a safety snapshot or
    /// another copy of a library), then open it with a new epoch. The library
    /// must not be open. The backup is checked first; on any error the
    /// current library stays as it was.
    pub fn restore_backup(
        root: impl Into<PathBuf>,
        backup: &Path,
        options: LibraryOptions,
    ) -> Result<Self> {
        let paths = LibraryPaths::new(root);
        let lock = take_lock(&paths)?;
        {
            let conn =
                Connection::open_with_flags(backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if integrity != "ok" {
                return Err(StoreError::invalid("backup", integrity));
            }
            if migrate::applied_count(&conn, MIGRATIONS)? == 0 {
                return Err(StoreError::invalid("backup", "not a Drifting library"));
            }
        }
        let shadow = temporary_sibling(&paths.db)?;
        let result = (|| -> Result<()> {
            fs::copy(backup, &shadow)?;
            sync_file(&shadow)?;
            for suffix in ["-wal", "-shm"] {
                let mut name = paths.db.file_name().unwrap_or_default().to_os_string();
                name.push(suffix);
                match fs::remove_file(paths.db.with_file_name(name)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            durable_replace_file(&shadow, &paths.db)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&shadow);
        }
        result?;
        let library = Self::open_locked(paths, options, MIGRATIONS, lock)?;
        library.rotate_epoch()?;
        Ok(library)
    }

    pub fn paths(&self) -> &LibraryPaths {
        &self.inner.paths
    }

    pub fn options(&self) -> &LibraryOptions {
        &self.inner.options
    }

    /// What opening the library did (created, migrated, safety snapshot).
    pub fn open_report(&self) -> &OpenReport {
        &self.inner.report
    }

    pub fn epoch(&self) -> String {
        self.inner.epoch()
    }

    /// Start a new epoch: every document gets a new peer id before its next
    /// local edit. Required after restoring a backup or copying a library:
    /// a copy that kept the old peer ids would write different changes under
    /// ids another replica already has, and the replicas would silently
    /// diverge. Refused while documents are open.
    pub fn rotate_epoch(&self) -> Result<()> {
        let docs = self.inner.docs.lock().unwrap_or_else(|e| e.into_inner());
        if !docs.is_empty() {
            return Err(StoreError::DocumentsOpen(docs.len()));
        }
        let mut epoch = self.inner.epoch.lock().unwrap_or_else(|e| e.into_inner());
        let new = loop {
            let e = format!("{:016x}", random_u64());
            if e != *epoch {
                break e;
            }
        };
        self.inner.writer().execute(
            "UPDATE library_meta SET value = ?1 WHERE key = 'epoch'",
            [&new],
        )?;
        *epoch = new;
        Ok(())
    }

    /// The peer id this device edits `doc_id` with, allocated and persisted
    /// on first use and again after an epoch change.
    pub fn peer_for(&self, doc_id: &str) -> Result<u64> {
        peer_for(&self.inner, doc_id)
    }

    /// Record a document (idempotent). Opening with
    /// [`OpenDoc::CreateIfMissing`] does this itself.
    pub fn register(&self, doc_id: &str, kind: &str, book_id: Option<&str>) -> Result<()> {
        validate_doc_id(doc_id)?;
        self.inner.writer().execute(
            "INSERT OR IGNORE INTO loro_doc (doc_id, kind, book_id, created_ms) VALUES (?1, ?2, ?3, ?4)",
            params![doc_id, kind, book_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn doc_info(&self, doc_id: &str) -> Result<Option<DocInfo>> {
        Ok(self
            .inner
            .reader()
            .query_row(
                "SELECT doc_id, kind, book_id FROM loro_doc WHERE doc_id = ?1",
                [doc_id],
                |r| {
                    Ok(DocInfo {
                        doc_id: r.get(0)?,
                        kind: r.get(1)?,
                        book_id: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Stored documents, optionally of one book and one kind, by id.
    pub fn docs(&self, book_id: Option<&str>, kind: Option<&str>) -> Result<Vec<DocInfo>> {
        let conn = self.inner.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT doc_id, kind, book_id FROM loro_doc
             WHERE (?1 IS NULL OR book_id = ?1) AND (?2 IS NULL OR kind = ?2)
             ORDER BY doc_id",
        )?;
        let rows = stmt
            .query_map(params![book_id, kind], |r| {
                Ok(DocInfo {
                    doc_id: r.get(0)?,
                    kind: r.get(1)?,
                    book_id: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Updates (count, bytes) waiting for the next compaction.
    pub fn pending_updates(&self, doc_id: &str) -> Result<(usize, usize)> {
        let (count, bytes): (i64, i64) = self.inner.reader().query_row(
            "SELECT count(*), coalesce(sum(length(bytes)), 0) FROM loro_update WHERE doc_id = ?1",
            [doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok((count as usize, bytes as usize))
    }

    /// The update rows after `after_seq` not yet folded into a snapshot, in
    /// order (what sync uploads, and what tests inspect).
    pub fn updates_since(&self, doc_id: &str, after_seq: i64) -> Result<Vec<StoredUpdate>> {
        let conn = self.inner.reader();
        let rows = conn
            .prepare_cached(
                "SELECT seq, origin, ts, bytes FROM loro_update WHERE doc_id = ?1 AND seq > ?2 ORDER BY seq",
            )?
            .query_map(params![doc_id, after_seq], |r| {
                Ok(StoredUpdate {
                    seq: r.get(0)?,
                    origin: r.get(1)?,
                    ts: r.get(2)?,
                    bytes: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// `upto_seq` and size of a document's snapshot, if it has one.
    pub fn snapshot_info(&self, doc_id: &str) -> Result<Option<(i64, usize)>> {
        Ok(self
            .inner
            .reader()
            .query_row(
                "SELECT upto_seq, length(bytes) FROM loro_snapshot WHERE doc_id = ?1",
                [doc_id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as usize)),
            )
            .optional()?)
    }

    /// A fresh, independent copy of the stored document (what is in SQLite,
    /// not what an open holder may still be persisting). For reading: it
    /// edits with a throwaway peer and nothing written to it is stored.
    pub fn load_copy(&self, doc_id: &str) -> Result<LoroDoc> {
        let doc = self.inner.new_doc();
        load_into(&self.inner.reader(), doc_id, &doc)?
            .ok_or_else(|| StoreError::NotFound(doc_id.into()))?;
        Ok(doc)
    }

    /// A copy checked out at `frontiers` (detached, read-only), for looking
    /// back in history. Loaded separately from SQLite so the open document
    /// never expands its history (`fork_at` would, and keep it: P0-C). Drop
    /// it when done.
    pub fn load_copy_at(&self, doc_id: &str, frontiers: &Frontiers) -> Result<LoroDoc> {
        let doc = self.load_copy(doc_id)?;
        doc.checkout(frontiers)?;
        Ok(doc)
    }

    /// Open a document: one holder thread per document. A document that is
    /// already open returns a handle to the same holder.
    pub fn open_doc(&self, doc_id: &str, how: OpenDoc<'_>) -> Result<DocHandle> {
        validate_doc_id(doc_id)?;
        {
            let mut docs = self.inner.docs.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                match docs.get(doc_id) {
                    None => break,
                    Some(Slot::Open(weak)) => {
                        if let Some(shared) = weak.upgrade() {
                            return Ok(DocHandle::from_shared(shared));
                        }
                    }
                    Some(Slot::Opening) => {}
                }
                docs = self
                    .inner
                    .docs_changed
                    .wait(docs)
                    .unwrap_or_else(|e| e.into_inner());
            }
            docs.insert(doc_id.to_string(), Slot::Opening);
        }
        // Frees the slot if loading fails or the genesis closure panics.
        let mut opening = OpeningSlot {
            inner: &self.inner,
            doc_id,
            armed: true,
        };
        let (doc, stats) = self.load_for_holder(doc_id, how)?;
        let handle = holder::spawn(self.inner.clone(), doc_id, doc, stats)?;
        {
            let mut docs = self.inner.docs.lock().unwrap_or_else(|e| e.into_inner());
            docs.insert(doc_id.to_string(), Slot::Open(handle.weak()));
            self.inner.docs_changed.notify_all();
        }
        opening.armed = false;
        Ok(handle)
    }

    fn load_for_holder(&self, doc_id: &str, how: OpenDoc<'_>) -> Result<(LoroDoc, LoadStats)> {
        let doc = self.inner.new_doc();
        let loaded = load_into(&self.inner.reader(), doc_id, &doc)?;
        let stats = match (loaded, how) {
            (Some(stats), _) => stats,
            (None, OpenDoc::Existing) => return Err(StoreError::NotFound(doc_id.into())),
            (
                None,
                OpenDoc::CreateIfMissing {
                    kind,
                    book_id,
                    genesis,
                },
            ) => {
                genesis(&doc);
                doc.commit();
                let bytes = doc.export(ExportMode::all_updates())?;
                let conn = self.inner.writer();
                let tx = conn.unchecked_transaction()?;
                tx.execute(
                    "INSERT OR IGNORE INTO loro_doc (doc_id, kind, book_id, created_ms) VALUES (?1, ?2, ?3, ?4)",
                    params![doc_id, kind, book_id, now_ms()],
                )?;
                tx.execute(
                    "INSERT INTO loro_update (doc_id, seq, bytes, origin, ts) VALUES (?1, 1, ?2, ?3, ?4)",
                    params![doc_id, bytes, Origin::Genesis.to_string(), now_ms()],
                )?;
                tx.commit()?;
                LoadStats {
                    updates: 1,
                    update_bytes: bytes.len(),
                    last_seq: 1,
                    ..LoadStats::default()
                }
            }
        };
        doc.set_peer_id(peer_for(&self.inner, doc_id)?)?;
        Ok((doc, stats))
    }

    /// Database size in bytes (pages in use, WAL excluded).
    pub fn size_bytes(&self) -> Result<u64> {
        let conn = self.inner.reader();
        let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        Ok((pages * size) as u64)
    }

    /// Documents with a live holder in this process.
    pub fn open_doc_count(&self) -> usize {
        self.inner
            .docs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    pub(crate) fn writer(&self) -> MutexGuard<'_, Connection> {
        self.inner.writer()
    }

    pub(crate) fn reader(&self) -> MutexGuard<'_, Connection> {
        self.inner.reader()
    }
}

fn validate_doc_id(doc_id: &str) -> Result<()> {
    if doc_id.is_empty() || doc_id.len() > 256 || doc_id.chars().any(char::is_control) {
        return Err(StoreError::invalid("document id", doc_id));
    }
    Ok(())
}

fn peer_for(inner: &Inner, doc_id: &str) -> Result<u64> {
    let epoch = inner.epoch();
    let conn = inner.writer();
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT peer_id, epoch FROM loro_peer WHERE doc_id = ?1",
            [doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((peer, e)) = row
        && e == epoch
    {
        return Ok(peer as u64);
    }
    let peer = random_peer_id();
    conn.execute(
        "INSERT INTO loro_peer (doc_id, peer_id, epoch) VALUES (?1, ?2, ?3)
         ON CONFLICT (doc_id) DO UPDATE SET peer_id = excluded.peer_id, epoch = excluded.epoch",
        params![doc_id, peer as i64, epoch],
    )?;
    Ok(peer)
}

/// Import the stored snapshot and the newer updates into `doc` in one batch
/// (Loro dedupes any overlap). `None` when nothing is stored.
pub(crate) fn load_into(
    conn: &Connection,
    doc_id: &str,
    doc: &LoroDoc,
) -> Result<Option<LoadStats>> {
    let snapshot: Option<(i64, Vec<u8>)> = conn
        .prepare_cached("SELECT upto_seq, bytes FROM loro_snapshot WHERE doc_id = ?1")?
        .query_row([doc_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let mut stats = LoadStats::default();
    if let Some((seq, bytes)) = &snapshot {
        stats.snapshot_seq = *seq;
        stats.snapshot_bytes = bytes.len();
        stats.last_seq = *seq;
    }
    let mut batch: Vec<Vec<u8>> = Vec::new();
    if let Some((_, bytes)) = snapshot {
        batch.push(bytes);
    }
    let mut stmt = conn.prepare_cached(
        "SELECT seq, bytes FROM loro_update WHERE doc_id = ?1 AND seq > ?2 ORDER BY seq",
    )?;
    let mut rows = stmt.query(params![doc_id, stats.snapshot_seq])?;
    while let Some(row) = rows.next()? {
        let seq: i64 = row.get(0)?;
        let bytes: Vec<u8> = row.get(1)?;
        stats.updates += 1;
        stats.update_bytes += bytes.len();
        stats.last_seq = stats.last_seq.max(seq);
        batch.push(bytes);
    }
    if batch.is_empty() {
        return Ok(None);
    }
    if batch.len() == 1 {
        doc.import(&batch[0])?;
    } else {
        doc.import_batch(&batch)?;
    }
    Ok(Some(stats))
}

/// A full snapshot of a document, encoded (outside any SQLite lock).
pub(crate) struct SnapshotParts {
    bytes: Vec<u8>,
    vv: Vec<u8>,
    frontiers: Vec<u8>,
}

pub(crate) fn export_snapshot(doc: &LoroDoc) -> Result<SnapshotParts> {
    Ok(SnapshotParts {
        bytes: doc.export(ExportMode::Snapshot)?,
        vv: doc.oplog_vv().encode(),
        frontiers: doc.oplog_frontiers().encode(),
    })
}

/// Store `parts` as the snapshot covering every update up to `upto_seq` and
/// delete those updates, in one transaction. `pause` holds the transaction
/// open between the two steps (crash tests).
pub(crate) fn store_snapshot(
    conn: &Connection,
    doc_id: &str,
    parts: &SnapshotParts,
    upto_seq: i64,
    pause: Option<Duration>,
) -> Result<CompactStats> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO loro_snapshot (doc_id, upto_seq, vv, frontiers, bytes, ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (doc_id) DO UPDATE SET upto_seq = excluded.upto_seq, vv = excluded.vv,
           frontiers = excluded.frontiers, bytes = excluded.bytes, ts = excluded.ts",
        params![
            doc_id,
            upto_seq,
            parts.vv,
            parts.frontiers,
            parts.bytes,
            now_ms()
        ],
    )?;
    if let Some(pause) = pause {
        std::thread::sleep(pause);
    }
    let deleted = tx.execute(
        "DELETE FROM loro_update WHERE doc_id = ?1 AND seq <= ?2",
        params![doc_id, upto_seq],
    )?;
    tx.commit()?;
    Ok(CompactStats {
        upto_seq,
        snapshot_bytes: parts.bytes.len(),
        deleted_updates: deleted,
    })
}
