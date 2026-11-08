//! The rules for changing a library from the command line, as in the 0.1
//! client's `pnpm drifting`:
//!
//! 1. **The app must be closed.** The library's lock (`library.lock`, held
//!    by every process that has it open) must be free.
//! 2. **Back up first.** `library.sqlite` is copied (`VACUUM INTO`, a
//!    consistent copy) to `<library>/backups/dr-cli-<ms>.sqlite` and the
//!    copy is integrity-checked before anything is written.
//! 3. **Only with `--yes`.** Without it the command prints what it would do
//!    and where the backup would go, and changes nothing.
//!
//! Reading never needs any of this: `inspect` opens the library read-only,
//! queries and read-only scenarios work on a copy ([`on_copy`]; F3 opens
//! documents through editing handles, which a read-only library refuses).

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

/// The app version the command line opens libraries as: the app's own,
/// so a library is not given a safety snapshot just because the command
/// line opened it.
pub const APP_VERSION: &str = "0.2.0-dev";

/// The library's files.
pub fn db_path(library: &Path) -> PathBuf {
    dr_store::LibraryPaths::new(library).db
}

/// Rule 1: fail when another process holds the library.
pub fn ensure_closed(library: &Path) -> Result<(), String> {
    let lock = dr_store::LibraryPaths::new(library).lock;
    if !lock.exists() {
        return Ok(());
    }
    let file: File = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock)
        .map_err(|e| format!("{}: {e}", lock.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(()),
        Err(TryLockError::WouldBlock) => Err(format!(
            "{} is open in Drifting or another tool; quit it first",
            library.display()
        )),
        Err(TryLockError::Error(e)) => Err(format!("{}: {e}", lock.display())),
    }
}

/// A consistent copy of `library.sqlite` at `to` (works while another
/// process reads or writes it).
pub fn copy_db(library: &Path, to: &Path) -> Result<(), String> {
    let src = db_path(library);
    let conn = Connection::open_with_flags(
        &src,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("{}: {e}", src.display()))?;
    let target = to.to_str().ok_or("the copy's path is not UTF-8")?;
    conn.execute("VACUUM INTO ?1", [target])
        .map_err(|e| format!("copy {}: {e}", src.display()))?;
    Ok(())
}

/// Rule 2: back up and check the backup. `None` when there is no database
/// yet (a new library has nothing to lose).
pub fn backup(library: &Path) -> Result<Option<PathBuf>, String> {
    if !db_path(library).exists() {
        return Ok(None);
    }
    let dir = library.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("dr-cli-{}.sqlite", dr_store::now_ms()));
    copy_db(library, &path)?;
    let check: String = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("PRAGMA integrity_check", [], |r| r.get(0)))
        .map_err(|e| format!("check the backup: {e}"))?;
    if check != "ok" {
        return Err(format!(
            "the backup {} failed its integrity check: {check}",
            path.display()
        ));
    }
    Ok(Some(path))
}

/// What a guarded write did.
#[derive(Debug, PartialEq, Eq)]
pub enum Guarded {
    /// No `--yes`: nothing changed.
    DryRun(String),
    Done {
        backup: Option<PathBuf>,
        report: String,
    },
}

/// Run `write` on the library directory under the three rules. `write`
/// opens what it needs (a library, a workspace) and closes it before it
/// returns.
pub fn guarded_write(
    library: &Path,
    yes: bool,
    action: &str,
    write: impl FnOnce(&Path) -> Result<String, String>,
) -> Result<Guarded, String> {
    ensure_closed(library)?;
    if !yes {
        let backup = if db_path(library).exists() {
            format!(
                "back up {} to {}",
                db_path(library).display(),
                library.join("backups/dr-cli-<time>.sqlite").display()
            )
        } else {
            "create a new library (nothing to back up)".into()
        };
        return Ok(Guarded::DryRun(format!(
            "would {backup}, then {action}; rerun with --yes to do it"
        )));
    }
    let backup = backup(library)?;
    let report = write(library)?;
    Ok(Guarded::Done { backup, report })
}

/// Run `read` on a consistent copy of the library, so the library itself is
/// never opened for writing (the app may have it open).
pub fn on_copy<T>(
    library: &Path,
    read: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    if !db_path(library).exists() {
        return Err(format!(
            "{} is not a library (no library.sqlite)",
            library.display()
        ));
    }
    let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
    copy_db(library, &db_path(tmp.path()))?;
    read(tmp.path())
}
