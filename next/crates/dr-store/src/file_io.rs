//! Durable filesystem primitives: write to a temporary sibling, flush, then
//! rename over the target and flush the directory. Adapted from the 0.1
//! client (`crates/drifting-core/src/file_io.rs`).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::now_ms;

static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_token() -> String {
    let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}-{counter:x}", now_ms(), std::process::id())
}

/// Create `path`'s parent directory; refuse a symlinked parent.
pub fn ensure_parent_directory(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    if fs::symlink_metadata(parent)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to write through a symlinked directory",
        ));
    }
    Ok(())
}

/// Flush a finished file's contents and metadata to disk. Unix can fsync a
/// read-only descriptor; Windows' FlushFileBuffers needs write access.
pub fn sync_file(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    let file = OpenOptions::new().write(true).open(path)?;
    #[cfg(not(windows))]
    let file = File::open(path)?;
    file.sync_all()
}

/// A hidden sibling of `path` that no other writer uses:
/// `.<name>.<unique>.part`.
pub fn temporary_sibling(path: &Path) -> io::Result<PathBuf> {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid target filename"))?;
    Ok(path.with_file_name(format!(".{name}.{}.part", unique_token())))
}

/// Whether `candidate` is a temporary sibling of a file named `name`.
pub fn is_temporary_sibling_of(candidate: &str, name: &str) -> bool {
    candidate
        .strip_prefix('.')
        .and_then(|rest| rest.strip_prefix(name))
        .and_then(|rest| rest.strip_prefix('.'))
        .is_some_and(|rest| rest.ends_with(".part"))
}

#[cfg(unix)]
pub fn sync_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "durability barrier requires a real directory",
        ));
    }
    File::open(path)?.sync_all()
}

/// Windows has no directory fsync: NTFS journals directory metadata and
/// replacements use MoveFileExW with WRITE_THROUGH. The same validation runs
/// so a symlinked or missing directory fails alike.
#[cfg(windows)]
pub fn sync_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "durability barrier requires a real directory",
        ));
    }
    Ok(())
}

/// Rename `temporary` over `path` and make the rename durable.
#[cfg(unix)]
pub fn durable_replace_file(temporary: &Path, path: &Path) -> io::Result<()> {
    fs::rename(temporary, path)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    sync_directory(parent)
}

#[cfg(windows)]
pub fn durable_replace_file(temporary: &Path, path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let (source, destination) = (wide(temporary), wide(path));
    // SAFETY: both buffers are NUL-terminated UTF-16 paths that outlive the call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Write `bytes` to `path` atomically: readers see the old file or the new
/// one, never a torn write.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    ensure_parent_directory(path)?;
    let temporary = temporary_sibling(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        durable_replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Copy `source` to `path` atomically, refusing more than `limit` bytes.
/// Returns the size copied.
pub fn atomic_copy_capped(source: &Path, path: &Path, limit: u64) -> io::Result<u64> {
    let metadata = fs::metadata(source)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "source path is not a file",
        ));
    }
    if metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "source file exceeds size limit",
        ));
    }
    ensure_parent_directory(path)?;
    let temporary = temporary_sibling(path)?;
    let result = (|| {
        let mut from = File::open(source)?.take(limit.saturating_add(1));
        let mut to = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let copied = io::copy(&mut from, &mut to)?;
        if copied > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source file exceeds size limit",
            ));
        }
        to.sync_all()?;
        drop(to);
        durable_replace_file(&temporary, path)?;
        Ok(copied)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// SHA-256 (lower-case hex) and size of a file.
pub fn file_sha256(path: &Path) -> io::Result<(String, u64)> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((hex(&hasher.finalize()), size))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_siblings_are_recognised() {
        let p = Path::new("/x/library.sqlite");
        let t = temporary_sibling(p).unwrap();
        let name = t.file_name().unwrap().to_str().unwrap();
        assert!(is_temporary_sibling_of(name, "library.sqlite"));
        assert!(!is_temporary_sibling_of("library.sqlite", "library.sqlite"));
        assert!(!is_temporary_sibling_of(
            ".library.sqlite-wal",
            "library.sqlite"
        ));
        assert!(!is_temporary_sibling_of(
            ".other.sqlite.1.part",
            "library.sqlite"
        ));
    }

    #[test]
    fn atomic_write_and_capped_copy() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a/b.bin");
        atomic_write(&a, b"hello").unwrap();
        assert_eq!(fs::read(&a).unwrap(), b"hello");
        let c = dir.path().join("c.bin");
        assert_eq!(atomic_copy_capped(&a, &c, 5).unwrap(), 5);
        assert!(atomic_copy_capped(&a, &dir.path().join("d.bin"), 4).is_err());
        assert!(!dir.path().join("d.bin").exists());
        let (hash, size) = file_sha256(&c).unwrap();
        assert_eq!(size, 5);
        assert_eq!(hash, sha256_hex(b"hello"));
    }
}
