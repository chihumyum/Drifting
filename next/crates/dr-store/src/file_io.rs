//! Shared durable filesystem primitives. No UI or framework dependency.
//!
//! Moved unchanged from the 0.1 client (`crates/drifting-core/src/file_io.rs`),
//! including the Windows write-through rename fixed on 2026-11-05; only the
//! `extern` block is marked `unsafe` for edition 2024. Tests added here.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);
fn unique_token() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}", elapsed.as_nanos(), counter)
}

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
/// read-only descriptor; Windows' FlushFileBuffers needs a handle with write
/// access, so a read-only handle fails there with "access denied".
pub fn sync_file(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    let file = OpenOptions::new().write(true).open(path)?;
    #[cfg(not(windows))]
    let file = File::open(path)?;
    file.sync_all()
}

pub fn temporary_sibling(path: &Path) -> io::Result<PathBuf> {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid target filename"))?;
    Ok(path.with_file_name(format!(".{filename}.{}.part", unique_token())))
}

pub fn rename_then_sync_parent<R, S>(
    temporary: &Path,
    path: &Path,
    rename: R,
    sync_parent: S,
) -> io::Result<()>
where
    R: FnOnce(&Path, &Path) -> io::Result<()>,
    S: FnOnce(&Path) -> io::Result<()>,
{
    rename(temporary, path)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    sync_parent(parent)
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

/// Windows has no directory fsync (see `windows_move_write_through`): NTFS
/// journals directory metadata, and replacements that must be durable use
/// MoveFileExW with WRITE_THROUGH. Callers keep the same barrier points and
/// the same validation, so a symlinked or missing directory fails alike.
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

#[cfg(unix)]
pub fn durable_replace_file(temporary: &Path, path: &Path) -> io::Result<()> {
    rename_then_sync_parent(
        temporary,
        path,
        |source, destination| fs::rename(source, destination),
        sync_directory,
    )
}

/// `path` as a NUL-terminated wide string a Win32 file call reads in full.
/// Without the verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\share\…`) those
/// calls stop at MAX_PATH and answer "the system cannot find the path
/// specified". std's own file calls add the prefix to a long path, so a file
/// std created under one must be moved under the same form: absolute (which
/// normalizes the path as Win32 would), then prefixed once it is as long as
/// std's threshold (248, CreateDirectoryW's limit).
#[cfg(windows)]
fn win32_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};

    const LEGACY_MAX_PATH: usize = 248;
    let absolute = std::path::absolute(path)?;
    let wide: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    let mut out = Vec::with_capacity(wide.len() + 9);
    match absolute.components().next() {
        Some(Component::Prefix(prefix)) if wide.len() >= LEGACY_MAX_PATH => {
            match prefix.kind() {
                Prefix::Disk(_) => {
                    out.extend(r"\\?\".encode_utf16());
                    out.extend_from_slice(&wide);
                }
                // `\\server\share\…` → `\\?\UNC\server\share\…`.
                Prefix::UNC(..) => {
                    out.extend(r"\\?\UNC\".encode_utf16());
                    out.extend_from_slice(&wide[2..]);
                }
                // Verbatim or a device path already: as it is.
                _ => out.extend_from_slice(&wide),
            }
        }
        _ => out.extend_from_slice(&wide),
    }
    out.push(0);
    Ok(out)
}

#[cfg(windows)]
pub fn windows_move_write_through(
    source: &Path,
    destination: &Path,
    replace_existing: bool,
) -> io::Result<()> {
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    // Long paths too: the asset store's ids may be 128 characters each, so
    // `<library>\assets\<book>\<asset>\<variant>.<ext>` passes MAX_PATH.
    let source = win32_path(source)?;
    let destination = win32_path(destination)?;
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace_existing {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };

    // Windows does not provide the POSIX directory-fsync contract through
    // `File::sync_all`: directory handles need FILE_FLAG_BACKUP_SEMANTICS,
    // while FlushFileBuffers requires GENERIC_WRITE and does not document
    // directory handles as supported. MoveFileExW with WRITE_THROUGH is the
    // platform durability boundary for both file replacement and the logical
    // removal rename used below.
    let moved = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
pub fn durable_replace_file(temporary: &Path, path: &Path) -> io::Result<()> {
    windows_move_write_through(temporary, path, true)
}

pub fn atomic_write_with_commit<C>(path: &Path, bytes: &[u8], commit: C) -> io::Result<()>
where
    C: FnOnce(&Path, &Path) -> io::Result<()>,
{
    ensure_parent_directory(path)?;
    let temporary = temporary_sibling(path)?;
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        commit(&temporary, path)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_with_commit(path, bytes, durable_replace_file)
}

pub fn atomic_copy_capped_with_commit<C>(
    source: &Path,
    path: &Path,
    limit: u64,
    commit: C,
) -> io::Result<u64>
where
    C: FnOnce(&Path, &Path) -> io::Result<()>,
{
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
    let copy_result = (|| {
        let mut source = File::open(source)?.take(limit.saturating_add(1));
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let copied = io::copy(&mut source, &mut target)?;
        if copied > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source file exceeds size limit",
            ));
        }
        target.sync_all()?;
        drop(target);
        commit(&temporary, path)?;
        Ok(copied)
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copy_result
}

pub fn atomic_copy_capped(source: &Path, path: &Path, limit: u64) -> io::Result<u64> {
    atomic_copy_capped_with_commit(source, path, limit, durable_replace_file)
}

#[cfg(all(test, windows))]
mod tests {
    use super::win32_path;
    use std::path::Path;

    fn text(path: &str) -> String {
        let wide = win32_path(Path::new(path)).unwrap();
        assert_eq!(wide.last(), Some(&0), "NUL-terminated");
        String::from_utf16(&wide[..wide.len() - 1]).unwrap()
    }

    #[test]
    fn long_paths_are_verbatim_and_short_ones_stay_as_they_are() {
        assert_eq!(text(r"C:\lib\assets\a.png"), r"C:\lib\assets\a.png");
        let long = "a".repeat(300);
        assert_eq!(
            text(&format!(r"C:\lib/x\..\{long}")),
            format!(r"\\?\C:\lib\{long}"),
            "normalized as Win32 would, then prefixed"
        );
        assert_eq!(
            text(&format!(r"\\server\share\{long}")),
            format!(r"\\?\UNC\server\share\{long}")
        );
        assert_eq!(
            text(&format!(r"\\?\C:\{long}")),
            format!(r"\\?\C:\{long}"),
            "verbatim already"
        );
    }
}
