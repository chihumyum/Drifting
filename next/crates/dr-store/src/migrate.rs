//! Schema migrations with a safety snapshot and a shadow copy.
//!
//! The same discipline as the 0.1 client (`crates/drifting-core/src/database.rs`):
//!
//! - Migrations are ordered SQL files under `migrations/`. A published one
//!   is never edited; a change is a new file appended to [`MIGRATIONS`].
//!   Each applied migration is recorded in `schema_migration` with the
//!   SHA-256 of its text, and the record must be a prefix of this build's
//!   list, so an edited migration is detected instead of half-applied.
//! - Before an existing library is migrated, `VACUUM INTO` writes a
//!   standalone safety snapshot (it includes WAL content and does not modify
//!   the source). The migration runs on a copy of that snapshot (the shadow),
//!   which is validated (`integrity_check`, `foreign_key_check`, migration
//!   record) before it durably replaces the library file.
//! - On failure the shadow is discarded and the library file is left
//!   byte-for-byte as it was; the error carries the snapshot's path.
//! - A new app version opening a library takes a safety snapshot even when
//!   no migration is pending (a new build may write differently).
//!
//! A crash at any point leaves either the old library (plus a stale shadow,
//! removed on the next open) or the fully migrated one.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::error::{MigrationFailure, Result, StoreError};
use crate::file_io::{
    durable_replace_file, is_temporary_sibling_of, sha256_hex, sync_directory, sync_file,
    temporary_sibling,
};
use crate::now_ms;

/// One schema migration: `name` is `NNNN_<what>`, where `NNNN` is its index.
#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub name: &'static str,
    pub sql: &'static str,
}

impl Migration {
    pub fn sha256(&self) -> String {
        sha256_hex(self.sql.as_bytes())
    }
}

/// This build's migrations, in order.
pub const MIGRATIONS: &[Migration] = &[Migration {
    name: "0000_baseline",
    sql: include_str!("../migrations/0000_baseline.sql"),
}];

/// SHA-256 of every published migration. A published migration must never
/// change; `published_migrations_are_unchanged` compares the two lists.
pub const PUBLISHED: &[(&str, &str)] = &[(
    "0000_baseline",
    "b7eb1a95897575e56ae9249023d69f4c152bf3d2c936fc2031ca6c3be8ae9307",
)];

const RECORD_TABLE: &str = "schema_migration";
const SAFETY_SNAPSHOTS_PER_VERSION: usize = 3;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Where a migration attempt stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MigrationStage {
    /// Writing the `VACUUM INTO` safety snapshot.
    Snapshot,
    /// Copying the snapshot to the shadow file.
    Copy,
    /// Running the migration SQL on the shadow (inside its transaction).
    Migrate,
    /// Checking the migrated shadow.
    Validate,
    /// Replacing the library file with the shadow.
    Replace,
    /// Reopening the replaced library.
    Reopen,
}

impl MigrationStage {
    pub const ALL: [MigrationStage; 6] = [
        Self::Snapshot,
        Self::Copy,
        Self::Migrate,
        Self::Validate,
        Self::Replace,
        Self::Reopen,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::Copy => "copy",
            Self::Migrate => "migrate",
            Self::Validate => "validate",
            Self::Replace => "replace",
            Self::Reopen => "reopen",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|v| v.as_str() == s)
    }

    /// Whether a failure at this stage leaves the source library untouched.
    /// Only a failure after the replacement (reopening) does not.
    pub fn source_unchanged(self) -> bool {
        self != Self::Reopen
    }
}

impl fmt::Display for MigrationStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Test hook: make a migration attempt fail at a stage.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultMode {
    /// Return an error and clean up as for any failure.
    Fail,
    /// Stop as if the process died: return an error without cleaning up.
    Crash,
    /// Print `MIGRATION_STAGE:<stage>` to stdout and wait forever, so a
    /// parent process can kill it there.
    Pause,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MigrationFault {
    pub stage: MigrationStage,
    pub mode: FaultMode,
}

enum Stop {
    Fail(MigrationStage, String),
    Crash(MigrationStage, String),
}

impl Stop {
    fn stage_detail(self) -> (MigrationStage, String) {
        match self {
            Stop::Fail(s, d) | Stop::Crash(s, d) => (s, d),
        }
    }
}

fn fault(fault: Option<MigrationFault>, stage: MigrationStage) -> Result<(), Stop> {
    let Some(f) = fault.filter(|f| f.stage == stage) else {
        return Ok(());
    };
    match f.mode {
        FaultMode::Fail => Err(Stop::Fail(stage, format!("injected fault at {stage}"))),
        FaultMode::Crash => Err(Stop::Crash(stage, format!("injected crash at {stage}"))),
        FaultMode::Pause => {
            use std::io::Write;
            println!("MIGRATION_STAGE:{stage}");
            let _ = std::io::stdout().flush();
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
    }
}

/// What opening a library did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenReport {
    /// The database was new (or empty) and got the full schema directly.
    pub created: bool,
    /// Migrations applied by this open.
    pub migrations_applied: usize,
    /// The safety snapshot this open took, if any.
    pub safety_snapshot: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Durability {
    /// WAL + `synchronous=NORMAL`: survives a process crash; the last
    /// transactions may be lost on power failure. The default.
    Normal,
    /// WAL + `synchronous=FULL`: also survives power failure.
    Full,
}

pub(crate) fn configure(conn: &Connection, durability: Durability) -> Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::invalid("journal mode", mode));
    }
    conn.pragma_update(
        None,
        "synchronous",
        match durability {
            Durability::Normal => "NORMAL",
            Durability::Full => "FULL",
        },
    )?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}

pub(crate) fn open_connection(path: &Path, durability: Durability) -> Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags)?;
    configure(&conn, durability)?;
    Ok(conn)
}

fn record_table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [RECORD_TABLE],
        |r| r.get(0),
    )?)
}

fn has_other_tables(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name <> ?1)",
        [RECORD_TABLE],
        |r| r.get(0),
    )?)
}

/// How many of `migrations` the database has applied. Read-only. Fails when
/// the record is not a prefix of `migrations` or is longer than it.
pub fn applied_count(conn: &Connection, migrations: &[Migration]) -> Result<usize> {
    if !record_table_exists(conn)? {
        if has_other_tables(conn)? {
            return Err(StoreError::SchemaMismatch(
                "tables exist without a migration record".into(),
            ));
        }
        return Ok(0);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT version, name, sha256 FROM {RECORD_TABLE} ORDER BY version"
    ))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (i, (version, name, sha)) in rows.iter().enumerate() {
        if *version != i as i64 {
            return Err(StoreError::SchemaMismatch(format!(
                "migration record has a gap at {i}"
            )));
        }
        let Some(expected) = migrations.get(i) else {
            return Err(StoreError::SchemaNewer {
                applied: rows.len(),
                known: migrations.len(),
            });
        };
        if *name != expected.name || *sha != expected.sha256() {
            return Err(StoreError::SchemaMismatch(format!(
                "migration {name} differs from this build's {}",
                expected.name
            )));
        }
    }
    Ok(rows.len())
}

/// Apply the pending migrations in one transaction. `before_commit` runs
/// inside it after the SQL (a test hook).
fn apply_pending(
    conn: &Connection,
    migrations: &[Migration],
    before_commit: &dyn Fn() -> Result<(), Stop>,
) -> Result<usize, Stop> {
    let as_stop = |e: StoreError| Stop::Fail(MigrationStage::Migrate, e.to_string());
    let sql = |e: rusqlite::Error| Stop::Fail(MigrationStage::Migrate, e.to_string());
    conn.pragma_update(None, "foreign_keys", false)
        .map_err(sql)?;
    conn.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
    let result = (|| {
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {RECORD_TABLE} (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                applied_ms INTEGER NOT NULL
            ) STRICT"
        ))
        .map_err(sql)?;
        let applied = applied_count(conn, migrations).map_err(as_stop)?;
        let mut count = 0;
        for (i, m) in migrations.iter().enumerate().skip(applied) {
            conn.execute_batch(m.sql)
                .map_err(|e| Stop::Fail(MigrationStage::Migrate, format!("{}: {e}", m.name)))?;
            conn.execute(
                &format!(
                    "INSERT INTO {RECORD_TABLE} (version, name, sha256, applied_ms) VALUES (?1, ?2, ?3, ?4)"
                ),
                params![i as i64, m.name, m.sha256(), now_ms()],
            )
            .map_err(sql)?;
            count += 1;
        }
        before_commit()?;
        Ok(count)
    })();
    let result = match result {
        Ok(n) => conn.execute_batch("COMMIT").map(|()| n).map_err(sql),
        Err(e) => Err(e),
    };
    if result.is_err() && !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(sql)?;
    result
}

/// Integrity, foreign keys and a complete migration record.
pub fn validate(conn: &Connection, migrations: &[Migration]) -> Result<()> {
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(StoreError::invalid("integrity check", integrity));
    }
    let bad_reference: Option<String> = conn
        .query_row(
            "SELECT \"table\" FROM pragma_foreign_key_check LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(table) = bad_reference {
        return Err(StoreError::invalid("foreign key check", table));
    }
    let applied = applied_count(conn, migrations)?;
    if applied != migrations.len() {
        return Err(StoreError::SchemaMismatch(format!(
            "{applied} of {} migrations applied",
            migrations.len()
        )));
    }
    Ok(())
}

/// Checkpoint the whole WAL into the database file and truncate it. Fails if
/// another connection keeps part of it busy.
pub(crate) fn checkpoint_truncate(conn: &Connection) -> Result<()> {
    let (busy, log, done): (i64, i64, i64) =
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    if busy != 0 || log != done {
        return Err(StoreError::invalid(
            "checkpoint",
            format!("busy={busy} log={log} checkpointed={done}"),
        ));
    }
    Ok(())
}

/// A version string usable as one directory name.
fn version_segment(version: &str) -> Result<&str> {
    let ok = !version.is_empty()
        && version.len() <= 64
        && !version.starts_with('.')
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+'));
    if ok {
        Ok(version)
    } else {
        Err(StoreError::invalid("app version", version))
    }
}

static SNAPSHOT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write a `VACUUM INTO` safety snapshot of `conn`'s database under
/// `<dir>/<app_version>/` and keep the newest few there. The snapshot is
/// written under a temporary name and renamed when complete, so a crash
/// never leaves a partial file that looks like a snapshot.
pub(crate) fn safety_snapshot(conn: &Connection, dir: &Path, app_version: &str) -> Result<PathBuf> {
    let dir = dir.join(version_segment(app_version)?);
    fs::create_dir_all(&dir)?;
    let n = SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!("library-{:013}-{:04}.sqlite", now_ms(), n % 10_000);
    let path = dir.join(&name);
    let partial = dir.join(format!(".{name}.part"));
    let target = partial.to_str().ok_or_else(|| {
        StoreError::invalid("safety snapshot path", partial.display().to_string())
    })?;
    let written = (|| -> Result<()> {
        conn.execute("VACUUM INTO ?1", [target])?;
        sync_file(&partial)?;
        durable_replace_file(&partial, &path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written?;
    retain_newest(&dir, SAFETY_SNAPSHOTS_PER_VERSION, &name)?;
    Ok(path)
}

/// Keep `keep` snapshots in `dir`: the one just written and the newest
/// others by name. Partial files left by a crash are removed.
fn retain_newest(dir: &Path, keep: usize, just_written: &str) -> Result<()> {
    let mut names: Vec<String> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with(".library-") && name.ends_with(".part") {
            fs::remove_file(entry.path())?;
        } else if name.starts_with("library-") && name.ends_with(".sqlite") && name != just_written
        {
            names.push(name);
        }
    }
    names.sort_unstable_by(|a, b| b.cmp(a));
    for name in names.into_iter().skip(keep.saturating_sub(1)) {
        fs::remove_file(dir.join(name))?;
    }
    sync_directory(dir)?;
    Ok(())
}

/// Remove shadow files a crashed migration left next to `db_path`.
pub(crate) fn remove_stale_shadows(db_path: &Path) -> Result<usize> {
    let (Some(dir), Some(name)) = (
        db_path.parent(),
        db_path.file_name().and_then(|n| n.to_str()),
    ) else {
        return Ok(0);
    };
    let mut removed = 0;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        if let Some(file) = entry.file_name().to_str()
            && is_temporary_sibling_of(file, name)
            && entry.file_type()?.is_file()
        {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    if removed > 0 {
        sync_directory(dir)?;
    }
    Ok(removed)
}

fn sidecar(db_path: &Path, suffix: &str) -> PathBuf {
    let mut name = db_path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    db_path.with_file_name(name)
}

/// Remove the closed library's `-wal` and `-shm`. Refuses a WAL that still
/// holds frames: those would be lost by the replacement.
pub(crate) fn remove_sidecars(db_path: &Path) -> std::io::Result<()> {
    let wal = sidecar(db_path, "-wal");
    if let Ok(meta) = fs::metadata(&wal)
        && meta.len() > 0
    {
        return Err(std::io::Error::other(
            "the library's WAL still holds frames after closing",
        ));
    }
    for path in [wal, sidecar(db_path, "-shm")] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Migrate a copy of `snapshot` and durably put it in `db_path`'s place.
/// The library connection must be closed.
fn migrate_shadow(
    db_path: &Path,
    snapshot: &Path,
    migrations: &[Migration],
    injected: Option<MigrationFault>,
) -> Result<usize, Stop> {
    let shadow =
        temporary_sibling(db_path).map_err(|e| Stop::Fail(MigrationStage::Copy, e.to_string()))?;
    let outcome = (|| {
        let copy = |e: std::io::Error| Stop::Fail(MigrationStage::Copy, e.to_string());
        fault(injected, MigrationStage::Copy)?;
        fs::copy(snapshot, &shadow).map_err(copy)?;
        sync_file(&shadow).map_err(copy)?;

        let open = |e: rusqlite::Error| Stop::Fail(MigrationStage::Migrate, e.to_string());
        let conn = Connection::open(&shadow).map_err(open)?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(open)?;
        conn.pragma_update(None, "journal_mode", "DELETE")
            .map_err(open)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(open)?;
        let applied = apply_pending(&conn, migrations, &|| {
            fault(injected, MigrationStage::Migrate)
        })?;

        fault(injected, MigrationStage::Validate)?;
        validate(&conn, migrations)
            .map_err(|e| Stop::Fail(MigrationStage::Validate, e.to_string()))?;
        drop(conn);
        sync_file(&shadow).map_err(|e| Stop::Fail(MigrationStage::Validate, e.to_string()))?;

        let replace = |e: std::io::Error| Stop::Fail(MigrationStage::Replace, e.to_string());
        fault(injected, MigrationStage::Replace)?;
        remove_sidecars(db_path).map_err(replace)?;
        durable_replace_file(&shadow, db_path).map_err(replace)?;
        Ok(applied)
    })();
    if let Err(Stop::Fail(..)) = &outcome {
        let _ = fs::remove_file(&shadow);
    }
    outcome
}

/// Open (creating if needed) and migrate the library database at `db_path`,
/// returning a configured connection.
pub(crate) fn open_database(
    db_path: &Path,
    snapshots_dir: &Path,
    app_version: &str,
    durability: Durability,
    migrations: &[Migration],
    injected: Option<MigrationFault>,
) -> Result<(Connection, OpenReport)> {
    version_segment(app_version)?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::symlink_metadata(db_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(StoreError::invalid(
            "library path",
            "refusing to open a database through a symbolic link",
        ));
    }
    remove_stale_shadows(db_path)?;

    let mut conn = open_connection(db_path, durability)?;
    let applied = applied_count(&conn, migrations)?;
    let mut report = OpenReport::default();

    if applied == 0 {
        // A new (or empty) database: nothing to protect.
        report.migrations_applied =
            apply_pending(&conn, migrations, &|| Ok(())).map_err(|stop| {
                let (stage, detail) = stop.stage_detail();
                StoreError::invalid("new library schema", format!("{stage}: {detail}"))
            })?;
        report.created = true;
        return Ok((conn, report));
    }

    let opened_by: Option<String> = conn
        .query_row(
            "SELECT value FROM library_meta WHERE key = 'app_version'",
            [],
            |r| r.get(0),
        )
        .optional()?;

    if applied < migrations.len() {
        if let Err(stop) = fault(injected, MigrationStage::Snapshot) {
            let (stage, detail) = stop.stage_detail();
            return Err(MigrationFailure {
                stage,
                detail,
                safety_snapshot: PathBuf::new(),
                from: applied,
                to: migrations.len(),
            }
            .into());
        }
        checkpoint_truncate(&conn)?;
        let snapshot =
            safety_snapshot(&conn, snapshots_dir, app_version).map_err(|e| MigrationFailure {
                stage: MigrationStage::Snapshot,
                detail: e.to_string(),
                safety_snapshot: PathBuf::new(),
                from: applied,
                to: migrations.len(),
            })?;
        drop(conn);
        let failure = |stage: MigrationStage, detail: String| MigrationFailure {
            stage,
            detail,
            safety_snapshot: snapshot.clone(),
            from: applied,
            to: migrations.len(),
        };
        report.migrations_applied = migrate_shadow(db_path, &snapshot, migrations, injected)
            .map_err(|stop| {
                let (stage, detail) = stop.stage_detail();
                failure(stage, detail)
            })?;
        if let Err(stop) = fault(injected, MigrationStage::Reopen) {
            let (stage, detail) = stop.stage_detail();
            return Err(failure(stage, detail).into());
        }
        conn = open_connection(db_path, durability)
            .and_then(|c| validate(&c, migrations).map(|()| c))
            .map_err(|e| failure(MigrationStage::Reopen, e.to_string()))?;
        report.safety_snapshot = Some(snapshot);
    } else if opened_by.as_deref() != Some(app_version) {
        checkpoint_truncate(&conn)?;
        report.safety_snapshot = Some(safety_snapshot(&conn, snapshots_dir, app_version)?);
    }
    Ok((conn, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_safety_snapshot_survives_retention_even_with_a_clock_set_back() {
        let dir = tempfile::tempdir().unwrap();
        let versions = dir.path().join("v");
        std::fs::create_dir_all(&versions).unwrap();
        // Three snapshots from "the future" and a partial file from a crash.
        for i in 0..3 {
            std::fs::write(
                versions.join(format!("library-9999999999999-000{i}.sqlite")),
                b"x",
            )
            .unwrap();
        }
        std::fs::write(versions.join(".library-1-0000.sqlite.part"), b"x").unwrap();
        let conn = Connection::open(dir.path().join("db.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);")
            .unwrap();
        let snap = safety_snapshot(&conn, dir.path(), "v").unwrap();
        assert!(snap.exists(), "the snapshot just taken is kept");
        let mut left: Vec<String> = std::fs::read_dir(&versions)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left.len(), SAFETY_SNAPSHOTS_PER_VERSION);
        assert!(left.iter().all(|n| !n.ends_with(".part")));
    }

    #[test]
    fn migration_list_is_well_formed() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert!(
                m.name.starts_with(&format!("{i:04}_")),
                "{} must start with its index {i:04}",
                m.name
            );
        }
    }

    /// A published migration must never change: add a new one instead. Until
    /// 0.2.0 ships an intended baseline edit may update this pin in the same
    /// change (development libraries then have to be reset).
    #[test]
    fn published_migrations_are_unchanged() {
        assert!(PUBLISHED.len() <= MIGRATIONS.len());
        for ((name, sha), m) in PUBLISHED.iter().zip(MIGRATIONS) {
            assert_eq!(*name, m.name);
            assert_eq!(
                *sha,
                m.sha256(),
                "published migration {name} was edited; append a new migration instead"
            );
        }
    }
}
