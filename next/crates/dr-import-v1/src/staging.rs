//! The staging copy: the importer only ever reads its own copy of the 0.1
//! database. The original is opened by nobody: its files are read byte by
//! byte (the database and, after a crash, its `-wal`), and the copy is
//! recovered, checked and, for an older 0.1.x library, migrated up to the
//! last 0.1 schema. The original is never written, moved or deleted.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{ImportError, Result};
use crate::schema::{self, Level};

/// What was copied, to recognise the same source again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFingerprint {
    pub database_bytes: u64,
    pub wal_bytes: u64,
    /// SHA-256 over the database file then its `-wal`, as copied.
    pub sha256: String,
}

/// A staged copy, at the last 0.1 schema.
#[derive(Debug)]
pub struct Staged {
    pub path: PathBuf,
    pub source: SourceFingerprint,
    /// The level the original was at; `applied < latest` means the copy was
    /// migrated.
    pub level_before: Level,
}

impl Staged {
    /// Open the staged copy read-only.
    pub fn open(&self) -> Result<Connection> {
        Ok(Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stat {
    len: u64,
    modified: Option<SystemTime>,
}

fn stat(path: &Path) -> Result<Option<Stat>> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(ImportError::Path {
            what: "refusing a symbolic link",
            path: path.to_path_buf(),
        }),
        Ok(m) if !m.is_file() => Err(ImportError::Path {
            what: "not a regular file",
            path: path.to_path_buf(),
        }),
        Ok(m) => Ok(Some(Stat {
            len: m.len(),
            modified: m.modified().ok(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// Whether another process has `files` open. `Some(detail)` when one does;
/// `None` when nobody does or it cannot be told (the copy's stability check
/// still catches a writer).
fn open_elsewhere(files: &[&Path]) -> Option<String> {
    #[cfg(unix)]
    {
        let existing: Vec<&Path> = files.iter().copied().filter(|p| p.exists()).collect();
        if existing.is_empty() {
            return None;
        }
        // The 0.1 developer CLI's check (`src/dev-cli/safety.ts`).
        let out = std::process::Command::new("lsof")
            .arg("-t")
            .args(existing.iter().map(|p| p.as_os_str()))
            .output()
            .ok()?;
        let me = std::process::id().to_string();
        let pids: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .filter(|p| *p != me)
            .map(str::to_string)
            .collect();
        (!pids.is_empty()).then(|| format!("held by process {}", pids.join(", ")))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        for f in files.iter().filter(|p| p.exists()) {
            // No sharing: fails while any other handle is open. Read access only.
            if std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(f)
                .is_err()
            {
                return Some(format!("{} is open", f.display()));
            }
        }
        None
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = files;
        None
    }
}

/// Bytes between two copy progress reports.
const REPORT_EVERY: u64 = 4 << 20;

/// Copy `from` to `to`, hashing; `copied` counts across files, `progress`
/// gets (bytes copied, bytes in all) every few megabytes.
fn copy_hashing(
    from: &Path,
    to: &Path,
    hasher: &mut Sha256,
    copied: &mut u64,
    all: u64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<u64> {
    let mut src = std::fs::File::open(from)?;
    let mut dst = std::fs::File::create(to)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    let mut reported = *copied;
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        dst.write_all(&buf[..n])?;
        total += n as u64;
        *copied += n as u64;
        if *copied - reported >= REPORT_EVERY {
            reported = *copied;
            progress(*copied, all.max(*copied));
        }
    }
    dst.sync_all()?;
    Ok(total)
}

/// Copy the 0.1 database at `source` into `dir` (created if needed) as
/// `<name>.db`, recover it into one self-contained file, check it, and bring
/// an older 0.1.x schema up to the last one.
pub fn stage(source: &Path, dir: &Path, name: &str) -> Result<Staged> {
    stage_with(source, dir, name, &mut |_, _| {})
}

/// [`stage`], reporting (bytes copied, bytes in all) while copying.
pub fn stage_with(
    source: &Path,
    dir: &Path,
    name: &str,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Staged> {
    let wal = sidecar(source, "-wal");
    let before = (
        stat(source)?.ok_or_else(|| ImportError::Path {
            what: "no 0.1 database at",
            path: source.to_path_buf(),
        })?,
        stat(&wal)?,
    );
    if let Some(detail) = open_elsewhere(&[source, &wal]) {
        return Err(ImportError::InUse(detail));
    }
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{name}.db"));
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let p = sidecar(&path, suffix);
        if p.exists() {
            std::fs::remove_file(p)?;
        }
    }
    let mut hasher = Sha256::new();
    let all = before.0.len + before.1.as_ref().map_or(0, |s| s.len);
    let mut copied = 0u64;
    progress(0, all);
    let database_bytes = copy_hashing(source, &path, &mut hasher, &mut copied, all, progress)?;
    let wal_bytes = if before.1.is_some() {
        copy_hashing(
            &wal,
            &sidecar(&path, "-wal"),
            &mut hasher,
            &mut copied,
            all,
            progress,
        )?
    } else {
        0
    };
    progress(copied, all.max(copied));
    let after = (stat(source)?, stat(&wal)?);
    if Some(&before.0) != after.0.as_ref() || before.1 != after.1 {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(sidecar(&path, "-wal"));
        return Err(ImportError::InUse(
            "the database changed while it was being copied".into(),
        ));
    }
    let source_fp = SourceFingerprint {
        database_bytes,
        wal_bytes,
        sha256: hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    };

    // Opening the copy read-write replays its WAL; then fold it into the
    // main file so the copy is one file.
    let conn = Connection::open(&path).map_err(|e| ImportError::NotALibrary(e.to_string()))?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| ImportError::NotALibrary(e.to_string()))?;
    if check != "ok" {
        return Err(ImportError::Damaged(check));
    }
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    let _: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))?;
    let level_before = schema::catch_up(&conn)?;
    let violations: i64 =
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if violations > 0 {
        log::warn!("staged 0.1 library has {violations} foreign-key violations; importing anyway");
    }
    drop(conn);
    Ok(Staged {
        path,
        source: source_fp,
        level_before,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn old_library(dir: &Path, upto: usize) -> PathBuf {
        let path = dir.join("drifting-library.db");
        let conn = Connection::open(&path).unwrap();
        let _: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
            .unwrap();
        schema::create_at(&conn, upto).unwrap();
        conn.execute(
            "INSERT INTO library_state (key, value_json, updated_at) VALUES ('k', '1', '2026-01-01T00:00:00Z')",
            [],
        )
        .ok();
        // Leave the WAL in place, as a crashed app would.
        std::mem::forget(conn);
        path
    }

    #[test]
    fn the_original_is_only_read_and_the_copy_catches_up() {
        let src = tempfile::tempdir().unwrap();
        let path = old_library(src.path(), 13);
        let bytes_before = std::fs::read(&path).unwrap();
        let staging = tempfile::tempdir().unwrap();
        let staged = stage(&path, staging.path(), "local").unwrap();
        assert_eq!(staged.level_before.applied, 13);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes_before,
            "original untouched"
        );
        let conn = staged.open().unwrap();
        assert!(schema::level(&conn).unwrap().is_latest());
        assert!(!sidecar(&staged.path, "-wal").exists());
        assert_eq!(staged.source.sha256.len(), 64);
    }

    #[test]
    fn not_a_library() {
        let src = tempfile::tempdir().unwrap();
        let path = src.path().join("x.db");
        std::fs::write(&path, b"hello").unwrap();
        let staging = tempfile::tempdir().unwrap();
        assert!(matches!(
            stage(&path, staging.path(), "x"),
            Err(ImportError::NotALibrary(_))
        ));
        assert!(stage(&src.path().join("missing.db"), staging.path(), "x").is_err());
    }
}
