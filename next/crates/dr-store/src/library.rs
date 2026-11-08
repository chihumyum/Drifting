//! The library: database connections, the single-owner lock, the epoch and
//! per-document peer ids (rotated automatically when the library has moved
//! or an older copy was put back), loading and copying documents, the
//! registry of open document holders, the event bus, sync state, activity
//! and Agent settlements.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use loro::{ExportMode, Frontiers, LoroDoc, VersionVector};
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::events::{
    self, LibrarySubscription, LocalChange, LocalChangeKind, SharedBus, StoreEvent,
};
use crate::file_io::{durable_replace_file, sync_file, temporary_sibling};
use crate::history::{self, ChangeSummary};
use crate::holder::{self, Closing, DocHandle, Shared};
use crate::identity::Device;
use crate::index::{DeriveInput, DerivedUpdate, Deriver, DocIndex};
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
    /// Measured with F2's first benchmark (now `dr-testkit`'s store bench,
    /// docs/rust-rewrite/acceptance/f8-m1-store-bench.json):
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
/// An application schema guard for incoming Loro bytes, run on the holder
/// thread against the settled document before the import mutates it.
pub type ValidateImport = Arc<dyn Fn(&str, &LoroDoc, &[u8]) -> Result<()> + Send + Sync>;

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
    /// Application-owned document invariants for incoming updates. The
    /// store remains schema-neutral; validation must not mutate the live
    /// document or call back into the library. Rejection imports nothing.
    pub validate_import: Option<ValidateImport>,
    /// This device (identity and library watermarks, outside the library).
    /// With it the library notices when it was moved to another device or
    /// replaced by an older copy, and starts a new epoch. Tests may omit it.
    pub device: Option<Device>,
    /// Computes derived indexes from Loro changes (dr-doc + dr-text).
    pub deriver: Option<Arc<dyn Deriver>>,
    /// How long a holder waits after its last job before deriving the index
    /// (default 150 ms: a derivation after a keystroke takes about 0.2 ms, so
    /// search and outline can follow closely). Compaction waits
    /// `compaction.idle`.
    pub derive_idle: Duration,
    /// Rebuild, in the background, the derived index of every document whose
    /// head is beyond its `indexed_seq` when the library opens (needs a
    /// deriver).
    pub rebuild_indexes_on_open: bool,
    /// The background rebuild writes a document's index only after nobody
    /// else has written for this long (default 500 ms), and never while
    /// anyone waits to: the author's keystrokes do not queue behind it.
    pub background_quiet: Duration,
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
    /// Test hook: pause inside each update transaction after its Loro row
    /// and before its settlement. Crash tests kill the process here.
    #[doc(hidden)]
    pub append_pause: Option<Duration>,
    /// Test hook: mark the same midpoint before `append_pause`. Must not
    /// read or write this library (the writer transaction is held).
    #[doc(hidden)]
    pub append_checkpoint: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl LibraryOptions {
    pub fn new(app_version: impl Into<String>) -> Self {
        Self {
            app_version: app_version.into(),
            durability: Durability::Normal,
            compaction: CompactionPolicy::default(),
            configure_doc: None,
            validate_import: None,
            device: None,
            deriver: None,
            derive_idle: Duration::from_millis(150),
            rebuild_indexes_on_open: true,
            background_quiet: Duration::from_millis(500),
            migration_fault: None,
            compaction_pause: None,
            append_faults: None,
            append_pause: None,
            append_checkpoint: None,
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
            .field("validate_import", &self.validate_import.is_some())
            .field("device", &self.device)
            .field("deriver", &self.deriver.is_some())
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

/// [`Library::try_close`] refused: why, and the library back.
pub struct CloseRefused {
    pub error: StoreError,
    pub library: Library,
}

impl std::fmt::Debug for CloseRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloseRefused")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Display for CloseRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "closing the library was refused: {}", self.error)
    }
}

impl std::error::Error for CloseRefused {}

/// A write transaction on a module's local-only tables
/// ([`Library::local_write`]). Derefs to the SQLite transaction.
pub struct LocalTx<'a> {
    tx: rusqlite::Transaction<'a>,
    changes: Vec<LocalChange>,
}

impl LocalTx<'_> {
    /// Announce `change` once the transaction commits.
    pub fn changed(&mut self, change: LocalChange) {
        self.changes.push(change);
    }
}

impl<'a> std::ops::Deref for LocalTx<'a> {
    type Target = rusqlite::Transaction<'a>;
    fn deref(&self) -> &Self::Target {
        &self.tx
    }
}

/// The latest stored state of a document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocHead {
    pub seq: i64,
    pub vv: VersionVector,
    pub frontiers: Frontiers,
    pub ts: i64,
}

/// What a document's upload carries: the updates after what the sync
/// service has, and the version they bring it to.
#[derive(Clone, Debug)]
pub struct UploadBatch {
    pub doc_id: String,
    pub bytes: Vec<u8>,
    pub vv: VersionVector,
}

/// Recent changes to one document, read from its Loro changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocActivity {
    pub doc_id: String,
    pub changes: Vec<ChangeSummary>,
}

/// One Agent write's settlement record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub id: i64,
    pub session: String,
    pub turn: String,
    pub call: String,
    pub doc_id: String,
    pub seq: i64,
    pub before: Frontiers,
    pub after: Frontiers,
    pub summary: String,
    pub ts: i64,
}

/// Why an epoch was started at open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochChange {
    /// Another device opened the library last (copied or moved).
    OtherDevice,
    /// The library is behind what this device has seen of it (an older copy
    /// was put back).
    OlderCopy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompactStats {
    pub upto_seq: i64,
    pub snapshot_bytes: usize,
    pub deleted_updates: usize,
}

/// What a background reindex did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reindexed {
    Written,
    Unchanged,
    /// Not a quiet moment when it came to writing: try again.
    Deferred,
}

pub(crate) enum Slot {
    Opening,
    Open(Weak<Shared>),
}

/// Who else writes: every writer but the background rebuild counts, from
/// the moment it asks for the connection until it lets go.
pub(crate) struct Foreground {
    /// Asking for the connection or holding it.
    pending: AtomicUsize,
    /// When the last one let go, in nanoseconds since `clock`.
    last_ns: AtomicU64,
    clock: Instant,
}

impl Foreground {
    fn new() -> Self {
        Self {
            pending: AtomicUsize::new(0),
            last_ns: AtomicU64::new(0),
            clock: Instant::now(),
        }
    }

    /// How long nobody has written; `None` while someone is.
    fn quiet_for(&self) -> Option<Duration> {
        if self.pending.load(Ordering::SeqCst) > 0 {
            return None;
        }
        let last = Duration::from_nanos(self.last_ns.load(Ordering::SeqCst));
        Some(self.clock.elapsed().saturating_sub(last))
    }
}

/// The writer connection, held. Dropping it lets go; a foreground writer's
/// drop also records when.
pub(crate) struct Writer<'a> {
    guard: MutexGuard<'a, Connection>,
    foreground: Option<&'a Foreground>,
}

impl std::ops::Deref for Writer<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.guard
    }
}

impl std::ops::DerefMut for Writer<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.guard
    }
}

impl Drop for Writer<'_> {
    fn drop(&mut self) {
        if let Some(f) = self.foreground {
            let now = f.clock.elapsed().as_nanos() as u64;
            f.last_ns.fetch_max(now, Ordering::SeqCst);
            f.pending.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

pub(crate) struct Inner {
    pub paths: LibraryPaths,
    pub options: LibraryOptions,
    pub report: OpenReport,
    writer: Mutex<Connection>,
    foreground: Foreground,
    reader: Mutex<Connection>,
    epoch: Mutex<String>,
    pub docs: Mutex<HashMap<String, Slot>>,
    pub docs_changed: Condvar,
    /// Holder threads whose last handle is gone (and the background index
    /// rebuild), joined by `Library::close`.
    pub closing: Closing,
    pub bus: SharedBus,
    pub library_id: String,
    pub epoch_change: Option<EpochChange>,
    /// Asks background work (index rebuilds) to stop.
    pub stopping: AtomicBool,
    /// Identifies this process's asset imports for garbage collection.
    pub session: String,
    /// Opened by [`Library::open_read_only`]: no lock, no writes.
    pub read_only: bool,
    /// Last, so the connections are closed before the lock goes.
    _lock: Option<LibraryLock>,
}

impl Inner {
    /// The writer connection, for anyone but the background rebuild.
    pub fn writer(&self) -> Writer<'_> {
        self.foreground.pending.fetch_add(1, Ordering::SeqCst);
        Writer {
            guard: self.writer.lock().unwrap_or_else(|e| e.into_inner()),
            foreground: Some(&self.foreground),
        }
    }

    /// How long background work should still wait before it writes: zero
    /// once nobody else has written for [`LibraryOptions::background_quiet`]
    /// and nobody is waiting to.
    pub fn quiet_remaining(&self) -> Duration {
        let quiet = self.options.background_quiet;
        match self.foreground.quiet_for() {
            Some(q) => quiet.saturating_sub(q),
            None => quiet,
        }
    }

    /// The writer connection for background work if it is a quiet moment
    /// ([`Self::quiet_remaining`] is zero, and still nobody asked once the
    /// lock is taken); `None` otherwise.
    pub fn try_background_writer(&self) -> Option<Writer<'_>> {
        if !self.quiet_remaining().is_zero() {
            return None;
        }
        let guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        // Someone asked while this waited for the lock: they go first.
        self.foreground.quiet_for().is_some().then_some(Writer {
            guard,
            foreground: None,
        })
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

    pub fn publish(&self, event: &StoreEvent) {
        events::publish(&self.bus, event);
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

/// The exclusive lock on `library.lock`, released explicitly when dropped.
///
/// On Unix the lock is `flock`, which belongs to the open file rather than to
/// the process: a child process that another thread is starting at that
/// moment holds a copy of every descriptor until it starts its program, and
/// closing ours alone would leave the library locked until then (an
/// immediate reopen failed 438 times in 1000 while four threads started
/// processes: `a_closed_library_reopens_at_once_while_processes_start`).
/// Unlocking releases the lock for every copy at once.
pub(crate) struct LibraryLock(File);

impl Drop for LibraryLock {
    fn drop(&mut self) {
        if let Err(e) = self.0.unlock() {
            log::warn!("releasing the library lock failed: {e}");
        }
    }
}

pub(crate) fn take_lock(paths: &LibraryPaths) -> Result<LibraryLock> {
    fs::create_dir_all(&paths.root)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.lock)?;
    match file.try_lock() {
        Ok(()) => Ok(LibraryLock(file)),
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

    /// Open a library only to read it (inspection tools): no lock, no
    /// migration, no safety snapshot, no epoch check, no background work.
    /// The app may have it open at the same time. The library's schema must
    /// be exactly this build's; documents cannot be opened for editing
    /// (copies can be loaded), and every write fails.
    pub fn open_read_only(root: impl Into<PathBuf>, options: LibraryOptions) -> Result<Self> {
        let paths = LibraryPaths::new(root);
        if !paths.db.is_file() {
            return Err(StoreError::NotFound(paths.db.display().to_string()));
        }
        let open = || -> Result<Connection> {
            let conn = Connection::open_with_flags(
                &paths.db,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            conn.busy_timeout(Duration::from_secs(5))?;
            conn.pragma_update(None, "query_only", true)?;
            Ok(conn)
        };
        let writer = open()?;
        let applied = migrate::applied_count(&writer, MIGRATIONS)?;
        if applied != MIGRATIONS.len() {
            return Err(StoreError::NeedsMigration {
                applied,
                known: MIGRATIONS.len(),
            });
        }
        let epoch = meta(&writer, "epoch")?.unwrap_or_default();
        let library_id = meta(&writer, "library_id")?.unwrap_or_default();
        let reader = open()?;
        let mut options = options;
        options.rebuild_indexes_on_open = false;
        Ok(Self {
            inner: Arc::new(Inner {
                paths,
                options,
                report: OpenReport::default(),
                writer: Mutex::new(writer),
                foreground: Foreground::new(),
                reader: Mutex::new(reader),
                epoch: Mutex::new(epoch),
                docs: Mutex::new(HashMap::new()),
                docs_changed: Condvar::new(),
                closing: Closing::default(),
                bus: SharedBus::default(),
                library_id,
                epoch_change: None,
                stopping: AtomicBool::new(false),
                session: format!("{:016x}", random_u64()),
                read_only: true,
                _lock: None,
            }),
        })
    }

    /// Whether this library was opened with [`Self::open_read_only`].
    pub fn is_read_only(&self) -> bool {
        self.inner.read_only
    }

    pub(crate) fn open_locked(
        paths: LibraryPaths,
        options: LibraryOptions,
        migrations: &[Migration],
        lock: LibraryLock,
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
        let mut epoch = match epoch {
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
        writer.execute(
            "INSERT OR IGNORE INTO library_meta (key, value) VALUES ('library_id', ?1)",
            [format!("{:016x}{:016x}", random_u64(), random_u64())],
        )?;
        writer.execute(
            "INSERT OR IGNORE INTO library_meta (key, value) VALUES ('write_seq', '0')",
            [],
        )?;
        let library_id = meta(&writer, "library_id")?.unwrap_or_default();
        let epoch_change = match &options.device {
            Some(device) => check_device(&writer, device, &library_id)?,
            None => None,
        };
        if epoch_change.is_some() {
            epoch = format!("{:016x}", random_u64());
            set_meta(&writer, "epoch", &epoch)?;
            log::warn!("library {library_id}: new epoch ({epoch_change:?})");
        }
        let reader = migrate::open_connection(&paths.db, options.durability)?;
        reader.pragma_update(None, "query_only", true)?;
        let library = Self {
            inner: Arc::new(Inner {
                paths,
                options,
                report,
                writer: Mutex::new(writer),
                foreground: Foreground::new(),
                reader: Mutex::new(reader),
                epoch: Mutex::new(epoch),
                docs: Mutex::new(HashMap::new()),
                docs_changed: Condvar::new(),
                closing: Closing::default(),
                bus: SharedBus::default(),
                library_id,
                epoch_change,
                stopping: AtomicBool::new(false),
                session: format!("{:016x}", random_u64()),
                read_only: false,
                _lock: Some(lock),
            }),
        };
        if library.inner.options.deriver.is_some() && library.inner.options.rebuild_indexes_on_open
        {
            library.spawn_index_rebuild();
        }
        Ok(library)
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
        let shadow = temporary_sibling(&paths.db)?;
        let result = (|| -> Result<()> {
            // Copy through SQLite: a consistent copy even if the backup has
            // a WAL of its own.
            {
                let conn = Connection::open_with_flags(
                    backup,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?;
                let integrity: String =
                    conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
                if integrity != "ok" {
                    return Err(StoreError::invalid("backup", integrity));
                }
                if migrate::applied_count(&conn, MIGRATIONS)? == 0 {
                    return Err(StoreError::invalid("backup", "not a Drifting library"));
                }
                let target = shadow.to_str().ok_or_else(|| {
                    StoreError::invalid("library path", shadow.display().to_string())
                })?;
                conn.execute("VACUUM INTO ?1", [target])?;
            }
            // The new epoch goes in before the copy takes the library's
            // place, so no later failure can leave the backup's peers in use.
            {
                let conn = Connection::open(&shadow)?;
                conn.execute(
                    "INSERT INTO library_meta (key, value) VALUES ('epoch', ?1)
                     ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    [format!("{:016x}", random_u64())],
                )?;
            }
            sync_file(&shadow)?;
            // The current library's WAL must be empty before it is dropped:
            // if the replacement then fails, nothing committed is lost.
            if paths.db.exists() {
                let conn = migrate::open_connection(&paths.db, options.durability)?;
                migrate::checkpoint_truncate(&conn)?;
            }
            migrate::remove_sidecars(&paths.db)?;
            durable_replace_file(&shadow, &paths.db)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&shadow);
        }
        result?;
        Self::open_locked(paths, options, MIGRATIONS, lock)
    }

    /// The recovery receipts of failed or interrupted migrations in `root`,
    /// readable without opening the library (for the recovery screen).
    pub fn recovery_receipts(root: impl Into<PathBuf>) -> Result<Vec<migrate::RecoveryReceipt>> {
        migrate::recovery_receipts(&LibraryPaths::new(root).safety_snapshots)
    }

    /// Restore the safety snapshot a receipt names, after checking its hash
    /// and size, then open it (with a new epoch). The receipt is removed.
    pub fn restore_from_receipt(
        root: impl Into<PathBuf>,
        recovery_id: &str,
        options: LibraryOptions,
    ) -> Result<Self> {
        let paths = LibraryPaths::new(root);
        let receipt = migrate::recovery_receipts(&paths.safety_snapshots)?
            .into_iter()
            .find(|r| r.recovery_id == recovery_id)
            .ok_or_else(|| StoreError::NotFound(format!("recovery receipt {recovery_id}")))?;
        let snapshot = migrate::verified_snapshot(&paths.safety_snapshots, &receipt)?;
        // Keep the snapshot out of the way of the receipt cleanup on open.
        let staged = temporary_sibling(&snapshot)?;
        fs::copy(&snapshot, &staged)?;
        let _ = fs::remove_file(
            paths
                .safety_snapshots
                .join("recovery")
                .join(format!("{recovery_id}.json")),
        );
        let library = Self::restore_backup(paths.root.clone(), &staged, options);
        let _ = fs::remove_file(&staged);
        library
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
    /// Refused with [`StoreError::Purged`] when the document, or its book,
    /// was purged on this device ([`crate::purge`]).
    pub fn register(&self, doc_id: &str, kind: &str, book_id: Option<&str>) -> Result<()> {
        validate_doc_id(doc_id)?;
        let conn = self.inner.writer();
        let tx = conn.unchecked_transaction()?;
        let stored: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM loro_doc WHERE doc_id = ?1)",
            [doc_id],
            |r| r.get(0),
        )?;
        if !stored {
            crate::purge::check_creatable(&tx, doc_id, book_id)?;
            tx.execute(
                "INSERT INTO loro_doc (doc_id, kind, book_id, created_ms) VALUES (?1, ?2, ?3, ?4)",
                params![doc_id, kind, book_id, now_ms()],
            )?;
        }
        tx.commit()?;
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
        if self.inner.read_only {
            return Err(StoreError::ReadOnly);
        }
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
                crate::purge::check_creatable(&tx, doc_id, book_id)?;
                tx.execute(
                    "INSERT OR IGNORE INTO loro_doc (doc_id, kind, book_id, created_ms) VALUES (?1, ?2, ?3, ?4)",
                    params![doc_id, kind, book_id, now_ms()],
                )?;
                record_append(
                    &tx,
                    doc_id,
                    1,
                    &bytes,
                    &Origin::Genesis,
                    now_ms(),
                    &doc.oplog_vv(),
                    &doc.oplog_frontiers(),
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

    /// Close the library: wait for every closing document holder to finish
    /// (labels, compaction), then close the database and release the lock.
    /// Refused while documents are open, or while other clones of this
    /// `Library` are alive (they keep the database open). The library is
    /// dropped either way; [`Self::try_close`] hands it back on refusal.
    pub fn close(self) -> Result<()> {
        self.try_close().map_err(|refused| refused.error)
    }

    /// [`Self::close`], but a refusal returns the library so the caller can
    /// close its documents and try again.
    pub fn try_close(self) -> std::result::Result<(), CloseRefused> {
        {
            let mut docs = self.inner.docs.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                let live = docs
                    .values()
                    .filter(|slot| match slot {
                        Slot::Opening => true,
                        Slot::Open(weak) => weak.strong_count() > 0,
                    })
                    .count();
                if live > 0 {
                    drop(docs);
                    return Err(CloseRefused {
                        error: StoreError::DocumentsOpen(live),
                        library: self,
                    });
                }
                if docs.is_empty() {
                    break;
                }
                docs = self
                    .inner
                    .docs_changed
                    .wait(docs)
                    .unwrap_or_else(|e| e.into_inner());
            }
        }
        // Stop background work (index rebuilds) and wait for it.
        self.inner.stopping.store(true, Ordering::Relaxed);
        let threads =
            std::mem::take(&mut *self.inner.closing.lock().unwrap_or_else(|e| e.into_inner()));
        for thread in threads {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
        if Arc::strong_count(&self.inner) > 1 {
            return Err(CloseRefused {
                error: StoreError::invalid(
                    "library",
                    "other clones of this library are still alive",
                ),
                library: self,
            });
        }
        if !self.inner.read_only {
            self.raise_watermark().map_err(|error| CloseRefused {
                error,
                library: self.clone(),
            })?;
        }
        Ok(())
    }

    /// Make everything committed so far survive a power failure. With
    /// [`Durability::Normal`] a commit survives a crash of the process but not
    /// of the machine. Call this before anything leaves the device (sync
    /// uploads): otherwise a power cut could take back operations another
    /// replica already has, and this device would reuse their ids.
    pub fn sync_to_disk(&self) -> Result<()> {
        // A checkpoint syncs the WAL before it copies anything back.
        self.inner
            .writer()
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))?;
        // What leaves the device now must never be reused by an older copy.
        self.raise_watermark()
    }

    /// Run `f` in one write transaction on the library database, for the
    /// local-only tables other modules own (the import receipt, and later
    /// the Agent archive, MCP servers, working memory, the Markdown ledger,
    /// local settings: see f2-store.md). Commits when `f` returns `Ok`.
    /// Never touch Loro, history or derived tables this way; announce what
    /// changed with [`Self::notify_local`].
    pub fn local_transaction<R>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<R>,
    ) -> Result<R> {
        let mut conn = self.inner.writer();
        let tx = conn.transaction()?;
        let r = f(&tx)?;
        tx.commit()?;
        Ok(r)
    }

    /// The device this library was opened with takes over the 0.1
    /// installation id of a library it is importing (M10,
    /// [`Device::take_over`]), so its writing days continue under the 0.1
    /// device key, at once. The library records the id as the one that
    /// opened it last, so its next open sees the same device (no new epoch).
    /// `Ok(false)`: opened without a device, or already that id. Another
    /// library this device opened before sees another installation the next
    /// time it opens, and starts a new epoch.
    pub fn adopt_installation_id(&self, installation_id: &str) -> Result<bool> {
        let Some(device) = &self.inner.options.device else {
            return Ok(false);
        };
        let conn = self.inner.writer();
        if !device.take_over(installation_id)? {
            return Ok(false);
        }
        set_meta(&conn, "installation_id", installation_id)?;
        Ok(true)
    }

    /// [`Self::local_transaction`] that also announces what changed: `f`
    /// records each change with [`LocalTx::changed`], and once the
    /// transaction has committed every change goes out on the bus (nothing
    /// is announced when `f` fails).
    pub fn local_write<R>(&self, f: impl FnOnce(&mut LocalTx<'_>) -> Result<R>) -> Result<R> {
        let (r, changes) = {
            let mut conn = self.inner.writer();
            let mut tx = LocalTx {
                tx: conn.transaction()?,
                changes: Vec::new(),
            };
            let r = f(&mut tx)?;
            let LocalTx { tx, changes } = tx;
            tx.commit()?;
            (r, changes)
        };
        for change in changes {
            self.notify_local(change);
        }
        Ok(r)
    }

    /// Run `f` on the read-only connection (a consistent read of the local
    /// tables).
    pub fn local_read<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        let conn = self.inner.reader();
        f(&conn)
    }

    /// Documents with a live holder in this process.
    pub fn open_doc_count(&self) -> usize {
        self.inner
            .docs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    pub(crate) fn writer(&self) -> Writer<'_> {
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
    // One read transaction: a holder compacting between the two reads would
    // otherwise delete updates the snapshot read had not covered yet.
    let tx = conn.unchecked_transaction()?;
    let snapshot: Option<(i64, Vec<u8>)> = tx
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
    {
        let mut stmt = tx.prepare_cached(
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
    }
    tx.commit()?;
    if batch.is_empty() {
        return Ok(None);
    }
    let status = if batch.len() == 1 {
        doc.import(&batch[0])?
    } else {
        doc.import_batch(&batch)?
    };
    if status.pending.is_some() {
        return Err(StoreError::invalid(
            "stored document",
            format!("{doc_id}: stored updates depend on operations that are not stored"),
        ));
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

pub(crate) fn meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT value FROM library_meta WHERE key = ?1")?
        .query_row([key], |r| r.get(0))
        .optional()?)
}

pub(crate) fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO library_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )?
    .execute(params![key, value])?;
    Ok(())
}

/// Compare the library with this device: another installation opened it
/// last (it was copied or moved), or it is behind this device's watermark
/// for it (an older copy was put back). Either way a new epoch is due.
/// Records this installation and lifts `write_seq` to the watermark, so the
/// same copy does not rotate again on every open.
fn check_device(
    conn: &Connection,
    device: &Device,
    library_id: &str,
) -> Result<Option<EpochChange>> {
    let installation_id = device.installation_id();
    let recorded = meta(conn, "installation_id")?;
    // Two machines can share an installation id when both took over the
    // same 0.1 identity (M10, `adopt_installation_id`): the machine is
    // compared too, where both sides know it.
    let recorded_machine = meta(conn, "machine")?;
    let other_machine = matches!(
        (recorded_machine.as_deref(), device.machine()),
        (Some(was), Some(now)) if was != now
    );
    let write_seq: i64 = meta(conn, "write_seq")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let watermark = device.watermark(library_id)?;
    let change = match (&recorded, watermark) {
        (Some(id), _) if *id != installation_id => Some(EpochChange::OtherDevice),
        _ if other_machine => Some(EpochChange::OtherDevice),
        (_, Some(mark)) if write_seq < mark => Some(EpochChange::OlderCopy),
        _ => None,
    };
    if recorded.as_deref() != Some(installation_id.as_str()) {
        set_meta(conn, "installation_id", &installation_id)?;
    }
    if let Some(machine) = device.machine()
        && recorded_machine.as_deref() != Some(machine)
    {
        set_meta(conn, "machine", machine)?;
    }
    if let Some(mark) = watermark
        && write_seq < mark
    {
        set_meta(conn, "write_seq", &mark.to_string())?;
    }
    Ok(change)
}

/// Append one update row, inside the caller's transaction, with the
/// document's new head and the library's write counter.
#[allow(clippy::too_many_arguments)]
pub(crate) fn record_append(
    tx: &Connection,
    doc_id: &str,
    seq: i64,
    bytes: &[u8],
    origin: &Origin,
    ts: i64,
    vv: &VersionVector,
    frontiers: &Frontiers,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO loro_update (doc_id, seq, bytes, origin, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?
    .execute(params![doc_id, seq, bytes, origin.to_string(), ts])?;
    tx.prepare_cached(
        "INSERT INTO loro_head (doc_id, seq, vv, frontiers, ts) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (doc_id) DO UPDATE SET seq = excluded.seq, vv = excluded.vv,
           frontiers = excluded.frontiers, ts = excluded.ts",
    )?
    .execute(params![doc_id, seq, vv.encode(), frontiers.encode(), ts])?;
    tx.prepare_cached(
        "UPDATE library_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'write_seq'",
    )?
    .execute([])?;
    Ok(())
}

/// Merge `vv` into what the sync service is known to have of a document,
/// inside the caller's transaction.
pub(crate) fn merge_remote_vv(tx: &Connection, doc_id: &str, vv: &VersionVector) -> Result<()> {
    let stored: Option<Vec<u8>> = tx
        .prepare_cached("SELECT remote_vv FROM sync_doc WHERE doc_id = ?1")?
        .query_row([doc_id], |r| r.get(0))
        .optional()?;
    let mut merged = match stored {
        Some(bytes) => VersionVector::decode(&bytes)?,
        None => VersionVector::default(),
    };
    merged.merge(vv);
    tx.prepare_cached(
        "INSERT INTO sync_doc (doc_id, remote_vv, updated_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT (doc_id) DO UPDATE SET remote_vv = excluded.remote_vv, updated_ms = excluded.updated_ms",
    )?
    .execute(params![doc_id, merged.encode(), now_ms()])?;
    Ok(())
}

impl Library {
    /// Why this open started a new epoch, if it did.
    pub fn epoch_change(&self) -> Option<EpochChange> {
        self.inner.epoch_change
    }

    /// The library's stable id (copies share it).
    pub fn library_id(&self) -> &str {
        &self.inner.library_id
    }

    /// Updates appended to this library so far (all documents).
    pub fn write_seq(&self) -> Result<i64> {
        Ok(meta(&self.inner.reader(), "write_seq")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0))
    }

    /// Listen to every persisted document change and every local-only table
    /// change of this library.
    pub fn subscribe(
        &self,
        f: impl Fn(&StoreEvent) + Send + Sync + 'static,
    ) -> LibrarySubscription {
        events::subscribe(&self.inner.bus, Arc::new(f))
    }

    /// Announce a committed change to a local-only table (dr-workspace's
    /// tables use this to reach the same bus as Loro events).
    pub fn notify_local(&self, change: LocalChange) {
        self.inner.publish(&StoreEvent::Local(change));
    }

    /// Whether a holder has (or is getting) this document, without taking a
    /// handle on it.
    fn is_open(&self, doc_id: &str) -> bool {
        let docs = self.inner.docs.lock().unwrap_or_else(|e| e.into_inner());
        match docs.get(doc_id) {
            Some(Slot::Opening) => true,
            Some(Slot::Open(weak)) => weak.strong_count() > 0,
            None => false,
        }
    }

    pub(crate) fn open_handle(&self, doc_id: &str) -> Option<DocHandle> {
        let docs = self.inner.docs.lock().unwrap_or_else(|e| e.into_inner());
        match docs.get(doc_id) {
            Some(Slot::Open(weak)) => weak.upgrade().map(DocHandle::from_shared),
            _ => None,
        }
    }

    /// Raise this device's watermark for the library to its current write
    /// count (when a device is configured).
    fn raise_watermark(&self) -> Result<()> {
        if let Some(device) = &self.inner.options.device {
            device.raise_watermark(&self.inner.library_id, self.write_seq()?)?;
        }
        Ok(())
    }

    /// The latest stored state of a document.
    pub fn head(&self, doc_id: &str) -> Result<Option<DocHead>> {
        let row: Option<(i64, Vec<u8>, Vec<u8>, i64)> = self
            .inner
            .reader()
            .prepare_cached("SELECT seq, vv, frontiers, ts FROM loro_head WHERE doc_id = ?1")?
            .query_row([doc_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?;
        row.map(|(seq, vv, f, ts)| {
            Ok(DocHead {
                seq,
                vv: VersionVector::decode(&vv)?,
                frontiers: Frontiers::decode(&f)?,
                ts,
            })
        })
        .transpose()
    }

    /// What the sync service is known to have of a document.
    pub fn remote_vv(&self, doc_id: &str) -> Result<VersionVector> {
        let stored: Option<Vec<u8>> = self
            .inner
            .reader()
            .prepare_cached("SELECT remote_vv FROM sync_doc WHERE doc_id = ?1")?
            .query_row([doc_id], |r| r.get(0))
            .optional()?;
        Ok(match stored {
            Some(bytes) => VersionVector::decode(&bytes)?,
            None => VersionVector::default(),
        })
    }

    /// Record that the sync service now has a document up to `vv` (merged
    /// with what it had).
    pub fn mark_uploaded(&self, doc_id: &str, vv: &VersionVector) -> Result<()> {
        {
            let conn = self.inner.writer();
            let tx = conn.unchecked_transaction()?;
            merge_remote_vv(&tx, doc_id, vv)?;
            tx.commit()?;
        }
        self.notify_local(LocalChange::new(
            "sync_doc",
            doc_id,
            LocalChangeKind::Update,
        ));
        Ok(())
    }

    /// Documents with changes that exist only on this device: their stored
    /// version is not covered by what the sync service has.
    pub fn docs_with_local_changes(&self) -> Result<Vec<String>> {
        let rows: Vec<(String, Vec<u8>, Option<Vec<u8>>)> = self
            .inner
            .reader()
            .prepare_cached(
                "SELECT h.doc_id, h.vv, s.remote_vv FROM loro_head h
                 LEFT JOIN sync_doc s ON s.doc_id = h.doc_id ORDER BY h.doc_id",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (doc_id, vv, remote) in rows {
            let vv = VersionVector::decode(&vv)?;
            let remote = match remote {
                Some(b) => VersionVector::decode(&b)?,
                None => VersionVector::default(),
            };
            if vv
                .iter()
                .any(|(peer, end)| remote.get(peer).copied().unwrap_or(0) < *end)
            {
                out.push(doc_id);
            }
        }
        Ok(out)
    }

    /// The updates the sync service does not have yet, exported from the
    /// document (not from rows: compaction may have folded them into the
    /// snapshot). Makes everything durable on disk first, and raises the
    /// device watermark, because these bytes are about to leave the device.
    /// `None` when there is nothing to upload.
    pub fn export_for_upload(&self, doc_id: &str) -> Result<Option<UploadBatch>> {
        self.sync_to_disk()?;
        let remote = self.remote_vv(doc_id)?;
        let export = move |doc: &LoroDoc| -> Result<Option<(Vec<u8>, VersionVector)>> {
            let vv = doc.oplog_vv();
            if vv
                .iter()
                .all(|(peer, end)| remote.get(peer).copied().unwrap_or(0) >= *end)
            {
                return Ok(None);
            }
            Ok(Some((doc.export(ExportMode::updates(&remote))?, vv)))
        };
        let exported = match self.open_handle(doc_id) {
            Some(h) => h.read(export)??,
            None => export(&self.load_copy(doc_id)?)?,
        };
        Ok(exported.map(|(bytes, vv)| UploadBatch {
            doc_id: doc_id.into(),
            bytes,
            vv,
        }))
    }

    /// Documents with a stored change at or after `since_ms`, newest first.
    pub fn docs_changed_since(&self, since_ms: i64) -> Result<Vec<String>> {
        Ok(self
            .inner
            .reader()
            .prepare_cached("SELECT doc_id FROM loro_head WHERE ts >= ?1 ORDER BY ts DESC, doc_id")?
            .query_map([since_ms], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?)
    }

    /// Who changed which documents since `since_ms`: each changed document's
    /// Loro changes from then on (peer, time, commit message). For the
    /// Project Home check-in. Reads the documents' own history, so it covers
    /// compacted updates and remote changes alike.
    pub fn activity_since(&self, since_ms: i64) -> Result<Vec<DocActivity>> {
        let since_s = since_ms.div_euclid(1000);
        let mut out = Vec::new();
        for doc_id in self.docs_changed_since(since_ms)? {
            let changes = match self.open_handle(&doc_id) {
                Some(h) => h.read(move |doc| history::changes_since(doc, since_s))?,
                None => history::changes_since(&self.load_copy(&doc_id)?, since_s),
            };
            if !changes.is_empty() {
                out.push(DocActivity { doc_id, changes });
            }
        }
        Ok(out)
    }

    /// Agent settlement records, oldest first, optionally of one session or
    /// one document.
    pub fn settlements(
        &self,
        session: Option<&str>,
        doc_id: Option<&str>,
    ) -> Result<Vec<Settlement>> {
        type Row = (
            i64,
            String,
            String,
            String,
            String,
            i64,
            Vec<u8>,
            Vec<u8>,
            String,
            i64,
        );
        let rows: Vec<Row> = self
            .inner
            .reader()
            .prepare_cached(
                "SELECT id, session, turn, call, doc_id, seq, before_frontiers, after_frontiers, summary, ts
                 FROM agent_settlement WHERE (?1 IS NULL OR session = ?1) AND (?2 IS NULL OR doc_id = ?2)
                 ORDER BY id",
            )?
            .query_map(params![session, doc_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        rows.into_iter()
            .map(
                |(id, session, turn, call, doc_id, seq, before, after, summary, ts)| {
                    Ok(Settlement {
                        id,
                        session,
                        turn,
                        call,
                        doc_id,
                        seq,
                        before: Frontiers::decode(&before)?,
                        after: Frontiers::decode(&after)?,
                        summary,
                        ts,
                    })
                },
            )
            .collect()
    }

    /// Delete a document and everything stored for it (updates, snapshot,
    /// head, peer, sync state, history labels, derived rows) in one
    /// transaction, and record it as purged so sync cannot bring it back
    /// ([`crate::purge`]); the Agent journals of a conversation it was go
    /// too. Purging a book's last document also drops the book's
    /// device-local state, Agent journals and the Agent settlements of its
    /// documents; while the book lives, settlements stay (the durable record
    /// of what an Agent did). Refused while the document is open; a
    /// document that is not stored is left alone.
    pub fn purge_doc(&self, doc_id: &str) -> Result<()> {
        let changes = {
            let docs = self.inner.docs.lock().unwrap_or_else(|e| e.into_inner());
            if docs.contains_key(doc_id) {
                return Err(StoreError::AlreadyOpen(doc_id.into()));
            }
            let conn = self.inner.writer();
            let tx = conn.unchecked_transaction()?;
            let info: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT kind, book_id FROM loro_doc WHERE doc_id = ?1",
                    [doc_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            for table in [
                "loro_update",
                "loro_snapshot",
                "loro_head",
                "loro_peer",
                "sync_doc",
                "history_label",
                "loro_doc",
            ] {
                tx.execute(&format!("DELETE FROM {table} WHERE doc_id = ?1"), [doc_id])?;
            }
            crate::index::delete_index(&tx, doc_id)?;
            let changes = match &info {
                Some((kind, book)) => crate::purge::record(&tx, doc_id, kind, book.as_deref())?,
                None => Vec::new(),
            };
            tx.commit()?;
            changes
        };
        self.notify_local(LocalChange::new("doc", doc_id, LocalChangeKind::Delete));
        for change in changes {
            self.notify_local(change);
        }
        Ok(())
    }

    /// Derive and store the index of a document that is not open, from a
    /// copy loaded from SQLite. Returns false when nothing was written (no
    /// deriver, nothing derived for this kind, or the index is current).
    pub fn reindex_doc(&self, doc_id: &str) -> Result<bool> {
        self.reindex(doc_id, false)
    }

    /// [`Self::reindex_doc`]; `background` (the rebuild when the library
    /// opens) leaves an open document to its holder, which derives it when
    /// idle anyway, instead of taking a handle on it: a handle held there
    /// would make a `close` at that moment refuse.
    fn reindex(&self, doc_id: &str, background: bool) -> Result<bool> {
        Ok(self.reindex_as(doc_id, background)? == Reindexed::Written)
    }

    fn reindex_as(&self, doc_id: &str, background: bool) -> Result<Reindexed> {
        let unchanged = |written: bool| {
            if written {
                Reindexed::Written
            } else {
                Reindexed::Unchanged
            }
        };
        let Some(deriver) = self.inner.options.deriver.clone() else {
            return Ok(Reindexed::Unchanged);
        };
        if background {
            if self.is_open(doc_id) {
                return Ok(Reindexed::Unchanged);
            }
        } else if let Some(h) = self.open_handle(doc_id) {
            return h.reindex_now().map(unchanged);
        }
        let Some(info) = self.doc_info(doc_id)? else {
            return Err(StoreError::NotFound(doc_id.into()));
        };
        let doc = self.inner.new_doc();
        let Some(stats) = load_into(&self.inner.reader(), doc_id, &doc)? else {
            return Ok(Reindexed::Unchanged);
        };
        let input = DeriveInput {
            doc_id,
            kind: &info.kind,
            book_id: info.book_id.as_deref(),
            doc: &doc,
            changes: None,
            held: false,
        };
        let frontiers = doc.oplog_frontiers();
        let derived = deriver.derive(&input);
        // Derived without the lock; written with it, in one transaction. In
        // the background only in a quiet moment; otherwise it is tried again.
        let writer = if background {
            match self.inner.try_background_writer() {
                Some(w) => w,
                None => return Ok(Reindexed::Deferred),
            }
        } else {
            self.inner.writer()
        };
        let book_id = info.book_id.as_deref();
        let written = match derived {
            Some(DerivedUpdate::Full(derived)) => crate::index::write_index(
                &writer,
                &DocIndex {
                    doc_id,
                    book_id,
                    seq: stats.last_seq,
                    frontiers: &frontiers,
                    derived: &derived,
                },
            )?,
            Some(DerivedUpdate::Patch(patch)) => crate::index::write_patch(
                &writer,
                &crate::index::DocPatch {
                    doc_id,
                    book_id,
                    seq: stats.last_seq,
                    frontiers: &frontiers,
                    patch: &patch,
                },
            )?,
            _ => false,
        };
        drop(writer);
        if written {
            self.notify_local(LocalChange::new("index", doc_id, LocalChangeKind::Update));
        }
        Ok(unchanged(written))
    }

    /// Rebuild every stale index now (see [`Self::stale_index_docs`]).
    /// Returns how many were written.
    pub fn rebuild_stale_indexes(&self) -> Result<usize> {
        let mut n = 0;
        for doc_id in self.stale_index_docs()? {
            if self.inner.stopping.load(Ordering::Relaxed) {
                break;
            }
            if self.reindex(&doc_id, false)? {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Rebuild stale indexes on a thread of its own, writing only in quiet
    /// moments. Between documents, and while it waits for a quiet moment, it
    /// keeps no hold on the library: dropping the last handle ends it.
    fn spawn_index_rebuild(&self) {
        let weak = Arc::downgrade(&self.inner);
        let spawned = std::thread::Builder::new()
            .name("dr-store:index-rebuild".into())
            .spawn(move || {
                let live = |weak: &Weak<Inner>| {
                    weak.upgrade()
                        .filter(|inner| !inner.stopping.load(Ordering::Relaxed))
                        .map(|inner| Library { inner })
                };
                let Some(docs) = live(&weak).map(|lib| lib.stale_index_docs()) else {
                    return;
                };
                let docs = match docs {
                    Ok(d) => d,
                    Err(e) => return log::warn!("listing stale indexes failed: {e}"),
                };
                for doc_id in docs {
                    loop {
                        let wait = match live(&weak) {
                            Some(lib) => lib.inner.quiet_remaining(),
                            None => return,
                        };
                        if !wait.is_zero() {
                            std::thread::sleep(wait.min(Duration::from_millis(25)));
                            continue;
                        }
                        let Some(lib) = live(&weak) else { return };
                        match lib.reindex_as(&doc_id, true) {
                            Ok(Reindexed::Deferred) => continue,
                            Ok(_) => break,
                            Err(e) => return log::warn!("rebuilding stale indexes failed: {e}"),
                        }
                    }
                }
            });
        match spawned {
            Ok(thread) => self
                .inner
                .closing
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(thread),
            Err(e) => log::warn!("could not start the index rebuild: {e}"),
        }
    }
}
