//! Whole-library backups: one `.drifting` file (a ZIP) holding a standalone
//! SQLite snapshot of the library and every asset file its rows name. The
//! 0.1 client's package and restore rules (`crates/drifting-core/src/
//! library_backup.rs`), on the 0.2 library; this is format version 2.
//!
//! ```text
//! manifest.json                         format, versions, checksums, books
//! library.sqlite                        VACUUM INTO snapshot (deflated)
//! assets/<book>/<asset>/<variant>.<ext> as stored (not recompressed)
//! ```
//!
//! - **Export** ([`Library::export_backup`]) runs while the library is open:
//!   the snapshot is one consistent read on a connection of its own, so
//!   writers are not held up; asset files are copied afterwards (they are
//!   written once). An asset row whose file is absent on this device is
//!   counted, not fatal. The file appears at its destination only when
//!   complete.
//! - **Checking** ([`stage`]) extracts the whole package into
//!   `<library>/restore-staging/`, checks every checksum, that nothing else
//!   is in it, the database's integrity and migration record, and upgrades
//!   the database there if this build has newer migrations. It returns what
//!   the backup holds (for the confirmation) and touches nothing else; the
//!   library may stay open meanwhile. One staged backup at a time.
//! - **Replacing** ([`Library::restore_staged`]) needs the library closed.
//!   It saves the current library as a pre-restore backup first
//!   (`safety-snapshots/pre-restore/`, the newest three kept), adds the
//!   backup's asset files without removing any, starts a new epoch in the
//!   restored database (its peers must not write again under ids another
//!   replica already has) and only then replaces the database file. A crash
//!   or failure at any point leaves either the old or the new database, each
//!   with every asset file it names; before the replacement nothing of the
//!   current library has changed.
//! - A 0.1 backup (format version 1) is refused with [`LEGACY`]: it holds a
//!   0.1 database, which the 0.1 import (M10) reads.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::asset::{Variant, reject_symlinks, sanitized_extension, sanitized_segment};
use crate::digest::{file_sha256, hex};
use crate::error::{Result, StoreError};
use crate::file_io::{
    atomic_copy_capped, atomic_write, durable_replace_file, ensure_parent_directory,
    sync_directory, sync_file, temporary_sibling,
};
use crate::library::{LibraryOptions, LibraryPaths, take_lock};
use crate::migrate::{self, Durability, MIGRATIONS};
use crate::{Library, now_ms, random_u64};

pub const FORMAT: &str = "drifting-library-backup";
/// 1 was the 0.1 client's package.
pub const FORMAT_VERSION: u32 = 2;
pub const EXTENSION: &str = "drifting";

/// [`StoreError::Backup`] codes. Not a backup, damaged, or not what its
/// manifest says.
pub const INVALID: &str = "backup-invalid";
/// A backup made by Drifting 0.1: import it (M10) instead.
pub const LEGACY: &str = "backup-legacy";
/// Made by a newer Drifting (newer format or schema): update the app first.
pub const NEWER: &str = "backup-newer";
/// The progress callback asked to stop ([`Progress`]).
pub const CANCELLED: &str = "backup-cancelled";

/// What a backup operation is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Step {
    /// Export: a consistent copy of the database (not counted in bytes).
    Snapshot,
    /// Export: writing the package (the database copy and asset files).
    Pack,
    /// Checking: extracting every file and checking its checksum.
    Extract,
    /// Checking: the database's integrity, and its upgrade when the backup
    /// is older (not counted in bytes).
    Verify,
    /// Restore: saving the current library first (as [`Step::Pack`]).
    SaveCurrent,
    /// Restore: copying the backup's asset files in.
    CopyAssets,
    /// Restore: replacing the database and opening it (not counted; no
    /// longer cancellable).
    Replace,
}

/// Where a backup operation is: the step, and bytes done of the step's
/// total (`total` is 0 for a step not counted in bytes). Reported at each
/// step's start, every [`REPORT_EVERY`] bytes and at its end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub step: Step,
    pub done: u64,
    pub total: u64,
}

/// A progress callback: return `false` to cancel ([`CANCELLED`]). An export
/// or a check cancelled leaves nothing behind; a restore can be cancelled
/// until [`Step::Replace`], and the library is then as it was (asset files
/// already added stay: they are only ever added).
pub type ProgressFn<'a> = dyn FnMut(&Progress) -> bool + 'a;

/// Bytes between two reports within a step.
pub const REPORT_EVERY: u64 = 1024 * 1024;

struct Reporter<'a, 'b> {
    f: &'a mut ProgressFn<'b>,
    at: Progress,
    reported: u64,
    cancellable: bool,
}

impl<'a, 'b> Reporter<'a, 'b> {
    fn new(f: &'a mut ProgressFn<'b>) -> Self {
        Self {
            f,
            at: Progress {
                step: Step::Snapshot,
                done: 0,
                total: 0,
            },
            reported: 0,
            cancellable: true,
        }
    }

    fn emit(&mut self) -> Result<()> {
        self.reported = self.at.done;
        let go_on = (self.f)(&self.at);
        if !go_on && self.cancellable {
            return Err(bad(CANCELLED, "cancelled"));
        }
        Ok(())
    }

    fn step(&mut self, step: Step, total: u64) -> Result<()> {
        if step == Step::Replace {
            self.cancellable = false;
        }
        self.at = Progress {
            step,
            done: 0,
            total,
        };
        self.emit()
    }

    fn add(&mut self, n: u64) -> Result<()> {
        self.at.done += n;
        if self.at.done - self.reported >= REPORT_EVERY
            || (self.at.done >= self.at.total && self.reported < self.at.total)
        {
            return self.emit();
        }
        Ok(())
    }
}

fn is_cancelled(e: &StoreError) -> bool {
    matches!(e, StoreError::Backup { code, .. } if *code == CANCELLED)
}

/// Copy `from` to `to` through `out`, reporting each chunk.
fn copy_reporting(
    from: &mut impl Read,
    to: &mut impl Write,
    reporter: &mut Reporter<'_, '_>,
) -> Result<u64> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut copied = 0u64;
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) => return Ok(copied),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        };
        to.write_all(&buf[..n])?;
        copied += n as u64;
        reporter.add(n as u64)?;
    }
}

/// Pre-restore backups kept (the 0.1 number).
pub const PRE_RESTORE_KEPT: usize = 3;
pub const PRE_RESTORE_PREFIX: &str = "Drifting-pre-restore-";

const MANIFEST_PATH: &str = "manifest.json";
const DATABASE_PATH: &str = "library.sqlite";
const ASSETS_PREFIX: &str = "assets/";
const STAGED_MANIFEST: &str = "staged-manifest.json";
const STAGING_DIR: &str = "restore-staging";
const EXPORT_DIR: &str = "export-staging";
const PRE_RESTORE_DIR: &str = "pre-restore";
const MANIFEST_LIMIT: u64 = 64 * 1024 * 1024;
const DATABASE_LIMIT: u64 = 64 * 1024 * 1024 * 1024;
const ASSET_FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

fn bad(code: &'static str, detail: impl Into<String>) -> StoreError {
    StoreError::Backup {
        code,
        detail: detail.into(),
    }
}

/// One file in the package.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupFile {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// A book in the backup: its id, how many documents it has, and the name the
/// exporting app gave (dr-store does not read documents).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupBook {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub documents: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupManifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub created_at_ms: i64,
    pub library_id: String,
    /// Migrations applied in the packaged database.
    pub migrations: usize,
    pub database: BackupFile,
    pub books: Vec<BackupBook>,
    pub documents: u64,
    pub assets: Vec<BackupFile>,
    /// Asset files the rows name that were absent on the exporting device.
    pub missing_assets: u64,
}

/// Enough of any manifest to tell the format apart.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: String,
    format_version: u32,
}

/// What a backup holds (export result, and the confirmation before a
/// restore).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupSummary {
    pub created_at_ms: i64,
    pub app_version: String,
    pub library_id: String,
    pub books: Vec<BackupBook>,
    pub documents: u64,
    pub asset_files: u64,
    pub missing_assets: u64,
    pub package_bytes: u64,
    /// Migrations this build applied to the staged copy (0 after export).
    pub upgraded_migrations: usize,
}

fn summary(m: &BackupManifest, package_bytes: u64, upgraded: usize) -> BackupSummary {
    BackupSummary {
        created_at_ms: m.created_at_ms,
        app_version: m.app_version.clone(),
        library_id: m.library_id.clone(),
        books: m.books.clone(),
        documents: m.documents,
        asset_files: m.assets.len() as u64,
        missing_assets: m.missing_assets,
        package_bytes,
        upgraded_migrations: upgraded,
    }
}

/// What a restore did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreOutcome {
    /// The current library saved before it was replaced (a `.drifting`
    /// package, or the raw database file when it could not be read); `None`
    /// when there was no library.
    pub pre_restore: Option<PathBuf>,
    pub summary: BackupSummary,
}

/// A checked backup extracted into the library's staging directory, ready
/// for [`Library::restore_staged`]. Dropping it removes the staged files (a
/// restore that was refused, say because the library is still open, can be
/// tried again until then).
#[derive(Debug)]
pub struct StagedBackup {
    root: PathBuf,
    dir: PathBuf,
    summary: BackupSummary,
}

impl StagedBackup {
    pub fn summary(&self) -> &BackupSummary {
        &self.summary
    }

    /// Remove the staged files now.
    pub fn discard(self) {}
}

impl Drop for StagedBackup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
        // The staging directory itself, once empty.
        let _ = fs::remove_dir(self.root.join(STAGING_DIR));
    }
}

fn token() -> String {
    format!("{:013}-{:016x}", now_ms(), random_u64())
}

fn utf8(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| StoreError::invalid("path", path.display().to_string()))
}

/// `assets/<book>/<asset>/<variant>.<ext>` with segments already in their
/// stored (sanitized) form; anything else is not a package path.
fn asset_relative_path(path: &str) -> Option<(&str, &str, &str)> {
    let rest = path.strip_prefix(ASSETS_PREFIX)?;
    let mut parts = rest.split('/');
    let (book, asset, file) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let canonical = |s: &str| sanitized_segment(s).is_ok_and(|c| c == s);
    let (variant, ext) = file.split_once('.')?;
    let file_ok =
        Variant::parse(variant).is_some() && sanitized_extension(ext).is_ok_and(|e| e == ext);
    (canonical(book) && canonical(asset) && file_ok).then_some((book, asset, file))
}

struct HashingWriter<W> {
    inner: W,
    hasher: Sha256,
    size: u64,
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.size += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn add_file<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    source: &Path,
    method: CompressionMethod,
    reporter: &mut Reporter<'_, '_>,
) -> Result<BackupFile> {
    let mut file = File::open(source)?;
    let len = file.metadata()?.len();
    let options = SimpleFileOptions::default()
        .compression_method(method)
        .large_file(len >= u64::from(u32::MAX));
    zip.start_file(name, options)
        .map_err(|e| StoreError::invalid("backup file", e.to_string()))?;
    let mut out = HashingWriter {
        inner: &mut *zip,
        hasher: Sha256::new(),
        size: 0,
    };
    copy_reporting(&mut file, &mut out, reporter)?;
    Ok(BackupFile {
        path: name.to_string(),
        sha256: hex(&out.hasher.finalize()),
        size_bytes: out.size,
    })
}

/// Write the package for the database snapshot at `snapshot` and the asset
/// files under `assets_root` to `destination`, which appears complete or
/// not at all.
fn write_package(
    snapshot: &Path,
    assets_root: &Path,
    destination: &Path,
    app_version: &str,
    book_names: &HashMap<String, String>,
    (reporter, step): (&mut Reporter<'_, '_>, Step),
) -> Result<(BackupManifest, u64)> {
    type AssetRow = (String, String, String, String);
    let (migrations, library_id, books, documents, rows) = {
        let conn = Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        // Counted, not checked against this build: a library a newer build
        // migrated can still be saved.
        let migrations: i64 =
            conn.query_row("SELECT count(*) FROM schema_migration", [], |r| r.get(0))?;
        let migrations = migrations as usize;
        let library_id: String = conn
            .query_row(
                "SELECT value FROM library_meta WHERE key = 'library_id'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_default();
        let books: Vec<BackupBook> = conn
            .prepare(
                "SELECT book_id, count(*) FROM loro_doc WHERE book_id IS NOT NULL
                 GROUP BY book_id ORDER BY book_id",
            )?
            .query_map([], |r| {
                let id: String = r.get(0)?;
                Ok(BackupBook {
                    name: book_names.get(&id).cloned(),
                    id,
                    documents: r.get::<_, i64>(1)? as u64,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let documents: i64 = conn.query_row("SELECT count(*) FROM loro_doc", [], |r| r.get(0))?;
        let rows: Vec<AssetRow> = conn
            .prepare(
                "SELECT book_id, asset_id, variant, ext FROM asset
                 ORDER BY book_id, asset_id, variant",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        (migrations, library_id, books, documents as u64, rows)
    };
    // Which files go in, and how many bytes in all, before writing any.
    let mut missing_assets = 0u64;
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut total = fs::metadata(snapshot)?.len();
    for (book, asset, variant, ext) in &rows {
        let (Ok(book), Ok(asset), Ok(ext)) = (
            sanitized_segment(book),
            sanitized_segment(asset),
            sanitized_extension(ext),
        ) else {
            missing_assets += 1;
            continue;
        };
        let name = format!("{variant}.{ext}");
        let file = assets_root.join(&book).join(&asset).join(&name);
        reject_symlinks(assets_root, &book, &asset, Some(&file))?;
        match fs::symlink_metadata(&file) {
            Ok(m) if m.is_file() => total += m.len(),
            Ok(_) => {
                missing_assets += 1;
                continue;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                missing_assets += 1;
                continue;
            }
            Err(e) => return Err(e.into()),
        }
        files.push((format!("{ASSETS_PREFIX}{book}/{asset}/{name}"), file));
    }
    ensure_parent_directory(destination)?;
    let temporary = temporary_sibling(destination)?;
    let written = (|| -> Result<BackupManifest> {
        reporter.step(step, total)?;
        let mut zip = ZipWriter::new(File::create(&temporary)?);
        let database = add_file(
            &mut zip,
            DATABASE_PATH,
            snapshot,
            CompressionMethod::Deflated,
            reporter,
        )?;
        let mut assets = Vec::new();
        for (path, file) in &files {
            match add_file(&mut zip, path, file, CompressionMethod::Stored, reporter) {
                Ok(f) => assets.push(f),
                // Deleted since it was counted.
                Err(StoreError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {
                    missing_assets += 1;
                }
                Err(e) => return Err(e),
            }
        }
        let manifest = BackupManifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            app_version: app_version.into(),
            created_at_ms: now_ms(),
            library_id,
            migrations,
            database,
            books,
            documents,
            assets,
            missing_assets,
        };
        let bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| StoreError::invalid("backup manifest", e.to_string()))?;
        zip.start_file(MANIFEST_PATH, SimpleFileOptions::default())
            .map_err(|e| StoreError::invalid("backup file", e.to_string()))?;
        zip.write_all(&bytes)?;
        let file = zip
            .finish()
            .map_err(|e| StoreError::invalid("backup file", e.to_string()))?;
        file.sync_all()?;
        drop(file);
        durable_replace_file(&temporary, destination)?;
        Ok(manifest)
    })();
    match written {
        Ok(manifest) => Ok((manifest, fs::metadata(destination)?.len())),
        Err(e) => {
            let _ = fs::remove_file(&temporary);
            Err(e)
        }
    }
}

/// A consistent copy of the database at `db` (any connection may be writing
/// meanwhile), at `out`.
fn snapshot_database(db: &Path, out: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute("VACUUM INTO ?1", [utf8(out)?])?;
    Ok(())
}

impl Library {
    /// Write a backup of the whole library to `destination` (the author picks
    /// it; `.drifting` by convention), while the library stays in use.
    /// `book_names` labels the books in the manifest for the restore
    /// confirmation (the app knows the titles; dr-store does not).
    pub fn export_backup(
        &self,
        destination: &Path,
        book_names: &HashMap<String, String>,
    ) -> Result<BackupSummary> {
        self.export_backup_with(destination, book_names, &mut |_| true)
    }

    /// [`Self::export_backup`], reporting [`Progress`] ([`Step::Snapshot`],
    /// [`Step::Pack`]); cancelled, nothing is left at `destination`.
    pub fn export_backup_with(
        &self,
        destination: &Path,
        book_names: &HashMap<String, String>,
        progress: &mut ProgressFn<'_>,
    ) -> Result<BackupSummary> {
        let mut reporter = Reporter::new(progress);
        let paths = self.paths();
        let dir = paths.root.join(EXPORT_DIR);
        fs::create_dir_all(&dir)?;
        let snapshot = dir.join(format!("{}.sqlite", token()));
        let result = reporter
            .step(Step::Snapshot, 0)
            .and_then(|()| snapshot_database(&paths.db, &snapshot))
            .and_then(|()| {
                write_package(
                    &snapshot,
                    &paths.assets,
                    destination,
                    &self.options().app_version,
                    book_names,
                    (&mut reporter, Step::Pack),
                )
            });
        let _ = fs::remove_file(&snapshot);
        let _ = fs::remove_dir(&dir);
        let (manifest, size) = result?;
        Ok(summary(&manifest, size, 0))
    }

    /// Replace the library in `root` with a staged backup ([`stage`]) and
    /// open it. The library must be closed (in this process and every
    /// other). The current library is saved as a pre-restore backup first;
    /// on any error before the replacement it is left exactly as it was.
    pub fn restore_staged(
        root: impl Into<PathBuf>,
        staged: &StagedBackup,
        options: LibraryOptions,
    ) -> Result<(Library, RestoreOutcome)> {
        Self::restore_staged_with(root, staged, options, &mut |_| true)
    }

    /// [`Self::restore_staged`], reporting [`Progress`]
    /// ([`Step::SaveCurrent`], [`Step::CopyAssets`], [`Step::Replace`]);
    /// cancellable until [`Step::Replace`], the library then as it was.
    pub fn restore_staged_with(
        root: impl Into<PathBuf>,
        staged: &StagedBackup,
        options: LibraryOptions,
        progress: &mut ProgressFn<'_>,
    ) -> Result<(Library, RestoreOutcome)> {
        let mut reporter = Reporter::new(progress);
        let paths = LibraryPaths::new(root);
        if fs::canonicalize(&paths.root)? != fs::canonicalize(&staged.root)? {
            return Err(StoreError::invalid(
                "staged backup",
                "it was staged for another library",
            ));
        }
        let lock = take_lock(&paths)?;
        let gone = || bad(INVALID, "the staged backup is gone; choose the file again");
        let manifest: BackupManifest = fs::read(staged.dir.join(STAGED_MANIFEST))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(gone)?;
        let candidate = staged.dir.join(DATABASE_PATH);
        {
            let conn = Connection::open_with_flags(&candidate, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|_| gone())?;
            let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            if check != "ok" || migrate::applied_count(&conn, MIGRATIONS)? != MIGRATIONS.len() {
                return Err(gone());
            }
            // A new epoch before the copy takes the library's place: the
            // backup's peers must never write again.
            conn.execute(
                "INSERT INTO library_meta (key, value) VALUES ('epoch', ?1)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [format!("{:016x}", random_u64())],
            )?;
        }
        sync_file(&candidate)?;
        let pre_restore = save_pre_restore(&paths, &staged.dir, &options, &mut reporter)?;
        merge_assets(&staged.dir, &paths.assets, &manifest, &mut reporter)?;
        reporter.step(Step::Replace, 0)?;
        migrate::remove_sidecars(&paths.db)?;
        durable_replace_file(&candidate, &paths.db)?;
        let summary = staged.summary.clone();
        let _ = fs::remove_dir_all(&staged.dir);
        let library = Self::open_locked(paths, options, MIGRATIONS, lock)?;
        Ok((
            library,
            RestoreOutcome {
                pre_restore,
                summary,
            },
        ))
    }

    /// The pre-restore backups of the library in `root`, newest first (each
    /// can be staged and restored like any backup).
    pub fn pre_restore_backups(root: impl Into<PathBuf>) -> Result<Vec<PathBuf>> {
        let dir = Library::pre_restore_dir(root);
        let mut found = match fs::read_dir(&dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().into_string().ok()?;
                    (name.starts_with(PRE_RESTORE_PREFIX) && e.file_type().ok()?.is_file())
                        .then_some((name, e.path()))
                })
                .collect::<Vec<_>>(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        // Names carry a zero-padded millisecond time: they sort by age.
        found.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(found.into_iter().map(|(_, p)| p).collect())
    }

    /// The folder the pre-restore backups of the library in `root` are kept
    /// in (Settings' 「打开恢复前副本」 opens it); it may not exist yet.
    pub fn pre_restore_dir(root: impl Into<PathBuf>) -> PathBuf {
        LibraryPaths::new(root)
            .safety_snapshots
            .join(PRE_RESTORE_DIR)
    }
}

/// Save the closed library in `paths` as a pre-restore package; when its
/// database cannot be read (the reason to restore, often), copy the raw
/// database file instead. Keeps the newest [`PRE_RESTORE_KEPT`].
fn save_pre_restore(
    paths: &LibraryPaths,
    staging: &Path,
    options: &LibraryOptions,
    reporter: &mut Reporter<'_, '_>,
) -> Result<Option<PathBuf>> {
    if !fs::metadata(&paths.db).is_ok_and(|m| m.is_file() && m.len() > 0) {
        return Ok(None);
    }
    let dir = paths.safety_snapshots.join(PRE_RESTORE_DIR);
    fs::create_dir_all(&dir)?;
    let stamp = format!("{PRE_RESTORE_PREFIX}{:016}", now_ms());
    let snapshot = staging.join("pre-restore.sqlite");
    let package = dir.join(format!("{stamp}.{EXTENSION}"));
    let packaged = (|| -> Result<()> {
        let conn = migrate::open_connection(&paths.db, options.durability)?;
        // Everything committed is in the file before it is replaced.
        migrate::checkpoint_truncate(&conn)?;
        drop(conn);
        snapshot_database(&paths.db, &snapshot)?;
        write_package(
            &snapshot,
            &paths.assets,
            &package,
            &options.app_version,
            &HashMap::new(),
            (&mut *reporter, Step::SaveCurrent),
        )
        .map(|_| ())
    })();
    let _ = fs::remove_file(&snapshot);
    let saved = match packaged {
        Ok(()) => package,
        Err(e) if is_cancelled(&e) => return Err(e),
        Err(e) => {
            log::warn!(
                "the current library could not be packaged before a restore ({e}); keeping its raw database"
            );
            let raw = dir.join(format!("{stamp}.sqlite"));
            reporter.step(Step::SaveCurrent, 0)?;
            atomic_copy_capped(&paths.db, &raw, DATABASE_LIMIT)?;
            let wal = paths.db.with_file_name("library.sqlite-wal");
            if wal.is_file() {
                atomic_copy_capped(
                    &wal,
                    &raw.with_file_name(format!("{stamp}.sqlite-wal")),
                    DATABASE_LIMIT,
                )?;
            }
            raw
        }
    };
    retain_pre_restore(&dir)?;
    Ok(Some(saved))
}

fn retain_pre_restore(dir: &Path) -> Result<()> {
    let mut stamps: Vec<String> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| {
            let rest = n.strip_prefix(PRE_RESTORE_PREFIX)?;
            Some(rest.get(..16)?.to_string())
        })
        .collect();
    stamps.sort();
    stamps.dedup();
    let old: HashSet<String> = stamps
        .iter()
        .rev()
        .skip(PRE_RESTORE_KEPT)
        .cloned()
        .collect();
    for e in fs::read_dir(dir)?.filter_map(|e| e.ok()) {
        let Ok(name) = e.file_name().into_string() else {
            continue;
        };
        let stamp = name
            .strip_prefix(PRE_RESTORE_PREFIX)
            .and_then(|r| r.get(..16));
        if stamp.is_some_and(|s| old.contains(s)) {
            fs::remove_file(e.path())?;
        }
    }
    Ok(())
}

/// Copy the staged asset files into the asset store without removing
/// anything. Asset ids are immutable, so an existing derivative is kept and
/// an existing source replaced only when it no longer matches the backup.
fn merge_assets(
    staging: &Path,
    assets_root: &Path,
    manifest: &BackupManifest,
    reporter: &mut Reporter<'_, '_>,
) -> Result<()> {
    reporter.step(
        Step::CopyAssets,
        manifest.assets.iter().map(|a| a.size_bytes).sum(),
    )?;
    if manifest.assets.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(assets_root)?;
    let mut touched = HashSet::new();
    for asset in &manifest.assets {
        let (book, id, file) = asset_relative_path(&asset.path)
            .ok_or_else(|| bad(INVALID, format!("invalid staged asset path {}", asset.path)))?;
        let target = assets_root.join(book).join(id).join(file);
        reject_symlinks(assets_root, book, id, Some(&target))?;
        match fs::symlink_metadata(&target) {
            Ok(m) if !m.is_file() => {
                return Err(StoreError::Asset(format!(
                    "{} is in the way of a restored asset file",
                    target.display()
                )));
            }
            Ok(_) => {
                let keep = !file.starts_with("source.")
                    || file_sha256(&target)
                        .is_ok_and(|(sha, size)| sha == asset.sha256 && size == asset.size_bytes);
                if keep {
                    reporter.add(asset.size_bytes)?;
                    continue;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        atomic_copy_capped(&staging.join(&asset.path), &target, ASSET_FILE_LIMIT)?;
        touched.insert(book.to_string());
        reporter.add(asset.size_bytes)?;
    }
    for book in touched {
        let _ = sync_directory(&assets_root.join(book));
    }
    sync_directory(assets_root)?;
    Ok(())
}

/// Check the backup at `package` and extract it into `root`'s staging
/// directory (replacing an earlier staged backup), upgrading its database
/// to this build's schema there. Nothing else changes; the library may be
/// open. Errors are [`StoreError::Backup`] (codes [`INVALID`], [`LEGACY`],
/// [`NEWER`]) or I/O.
pub fn stage(root: impl Into<PathBuf>, package: &Path, app_version: &str) -> Result<StagedBackup> {
    stage_with(root, package, app_version, &mut |_| true)
}

/// [`stage`], reporting [`Progress`] ([`Step::Extract`], [`Step::Verify`]);
/// cancelled, nothing is left staged.
pub fn stage_with(
    root: impl Into<PathBuf>,
    package: &Path,
    app_version: &str,
    progress: &mut ProgressFn<'_>,
) -> Result<StagedBackup> {
    let mut reporter = Reporter::new(progress);
    let root = root.into();
    let base = root.join(STAGING_DIR);
    match fs::remove_dir_all(&base) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let dir = base.join(token());
    fs::create_dir_all(&dir)?;
    match stage_into(package, &dir, app_version, &mut reporter) {
        Ok(summary) => Ok(StagedBackup { root, dir, summary }),
        Err(e) => {
            let _ = fs::remove_dir_all(&base);
            Err(e)
        }
    }
}

fn read_manifest<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<BackupManifest> {
    let not_a_backup = || bad(INVALID, "the file is not a Drifting library backup");
    let bytes = {
        let mut entry = archive.by_name(MANIFEST_PATH).map_err(|_| not_a_backup())?;
        if entry.size() > MANIFEST_LIMIT {
            return Err(bad(INVALID, "the backup manifest is too large"));
        }
        let mut bytes = Vec::new();
        (&mut entry)
            .take(MANIFEST_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| not_a_backup())?;
        bytes
    };
    let header: Header = serde_json::from_slice(&bytes).map_err(|_| not_a_backup())?;
    if header.format != FORMAT {
        return Err(not_a_backup());
    }
    match header.format_version {
        1 => {
            return Err(bad(
                LEGACY,
                "a backup made by Drifting 0.1; import it instead",
            ));
        }
        FORMAT_VERSION => {}
        v if v > FORMAT_VERSION => {
            return Err(bad(
                NEWER,
                format!("backup format {v} is newer than this build's {FORMAT_VERSION}"),
            ));
        }
        v => return Err(bad(INVALID, format!("unknown backup format {v}"))),
    }
    let manifest: BackupManifest = serde_json::from_slice(&bytes)
        .map_err(|e| bad(INVALID, format!("the backup manifest is unreadable: {e}")))?;
    if manifest.database.path != DATABASE_PATH || manifest.database.size_bytes > DATABASE_LIMIT {
        return Err(bad(INVALID, "the backup's database entry is invalid"));
    }
    let mut paths = HashSet::new();
    for asset in &manifest.assets {
        if asset_relative_path(&asset.path).is_none()
            || asset.size_bytes > ASSET_FILE_LIMIT
            || !paths.insert(asset.path.as_str())
        {
            return Err(bad(INVALID, format!("invalid asset path {}", asset.path)));
        }
    }
    Ok(manifest)
}

fn extract_verified<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    expected: &BackupFile,
    destination: &Path,
    reporter: &mut Reporter<'_, '_>,
) -> Result<()> {
    let mut entry = archive
        .by_name(&expected.path)
        .map_err(|_| bad(INVALID, format!("{} is missing", expected.path)))?;
    if entry.size() != expected.size_bytes {
        return Err(bad(
            INVALID,
            format!("{} has the wrong size", expected.path),
        ));
    }
    ensure_parent_directory(destination)?;
    let output = File::create(destination)?;
    let mut out = HashingWriter {
        inner: output,
        hasher: Sha256::new(),
        size: 0,
    };
    copy_reporting(
        &mut (&mut entry).take(expected.size_bytes + 1),
        &mut out,
        reporter,
    )
    .map_err(|e| match e {
        StoreError::Io(e) => bad(INVALID, format!("{} cannot be read: {e}", expected.path)),
        other => other,
    })?;
    if out.size != expected.size_bytes || hex(&out.hasher.finalize()) != expected.sha256 {
        return Err(bad(
            INVALID,
            format!("{} does not match its checksum", expected.path),
        ));
    }
    out.inner.sync_all()?;
    Ok(())
}

fn stage_into(
    package: &Path,
    dir: &Path,
    app_version: &str,
    reporter: &mut Reporter<'_, '_>,
) -> Result<BackupSummary> {
    let file = File::open(package)?;
    let package_bytes = file.metadata()?.len();
    let mut archive = ZipArchive::new(file)
        .map_err(|_| bad(INVALID, "the file is not a Drifting library backup"))?;
    let manifest = read_manifest(&mut archive)?;
    let mut expected: HashSet<&str> = manifest.assets.iter().map(|a| a.path.as_str()).collect();
    expected.insert(MANIFEST_PATH);
    expected.insert(DATABASE_PATH);
    if archive.len() != expected.len()
        || archive
            .file_names()
            .any(|n| n.map_or(true, |n| !expected.contains(n.as_ref())))
    {
        return Err(bad(
            INVALID,
            "the backup holds files its manifest does not list",
        ));
    }
    let candidate = dir.join(DATABASE_PATH);
    reporter.step(
        Step::Extract,
        manifest.database.size_bytes + manifest.assets.iter().map(|a| a.size_bytes).sum::<u64>(),
    )?;
    extract_verified(&mut archive, &manifest.database, &candidate, reporter)?;
    for asset in &manifest.assets {
        extract_verified(&mut archive, asset, &dir.join(&asset.path), reporter)?;
    }
    drop(archive);
    reporter.step(Step::Verify, 0)?;

    let applied = {
        let conn = Connection::open(&candidate)
            .map_err(|_| bad(INVALID, "the backup's database cannot be opened"))?;
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|_| bad(INVALID, "the backup's database is damaged"))?;
        if integrity != "ok" {
            return Err(bad(INVALID, "the backup's database is damaged"));
        }
        let applied = match migrate::applied_count(&conn, MIGRATIONS) {
            Ok(0) => return Err(bad(INVALID, "the backup holds no Drifting library")),
            Ok(n) => n,
            Err(StoreError::SchemaNewer { applied, known }) => {
                return Err(bad(
                    NEWER,
                    format!("made by a newer Drifting ({applied} > {known} migrations)"),
                ));
            }
            Err(StoreError::SchemaMismatch(d)) => return Err(bad(INVALID, d)),
            Err(e) => return Err(e),
        };
        if applied != manifest.migrations {
            return Err(bad(
                INVALID,
                "the backup's database is not what its manifest says",
            ));
        }
        applied
    };
    if applied < MIGRATIONS.len() {
        // Upgraded here, so a migration that fails on it fails before the
        // library is touched.
        let snapshots = dir.join("migrate");
        let opened = migrate::open_database(
            &candidate,
            &snapshots,
            app_version,
            Durability::Full,
            MIGRATIONS,
            None,
        );
        let _ = fs::remove_dir_all(&snapshots);
        drop(opened.map_err(|e| bad(INVALID, format!("the backup cannot be upgraded: {e}")))?);
    }
    {
        // One self-contained file: out of WAL mode, nothing beside it.
        let conn = Connection::open(&candidate)?;
        let mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("delete") {
            return Err(StoreError::invalid("journal mode", mode));
        }
    }
    migrate::remove_sidecars(&candidate)?;
    sync_file(&candidate)?;
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|e| StoreError::invalid("backup manifest", e.to_string()))?;
    atomic_write(&dir.join(STAGED_MANIFEST), &bytes)?;
    Ok(summary(
        &manifest,
        package_bytes,
        MIGRATIONS.len() - applied,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_paths_are_stored_asset_paths_only() {
        assert_eq!(
            asset_relative_path("assets/b1/a1/source.png"),
            Some(("b1", "a1", "source.png"))
        );
        for bad in [
            "assets/b1/a1/other.png",
            "assets/b1/a1/source.PNG",
            "assets/b 1/a1/source.png",
            "assets/../a1/source.png",
            "assets/.b/a1/source.png",
            "assets/b1/source.png",
            "assets/b1/a1/x/source.png",
            "library.sqlite",
            "/assets/b1/a1/source.png",
        ] {
            assert_eq!(asset_relative_path(bad), None, "{bad}");
        }
    }
}
