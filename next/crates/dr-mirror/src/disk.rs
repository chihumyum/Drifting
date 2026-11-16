//! The folder on disk (the file layer of the 0.1 client's
//! `markdown_projection.rs`): which installation a book's folder belongs
//! to, writes that replace a file whole or not at all (owner-only
//! permissions), and copies of files kept before they are replaced.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// Files larger than this are not read back.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// The book folder's own directory.
pub const META_DIR: &str = ".drifting";
const OWNER_FILE: &str = "owner.json";
const PRESERVED_DIR: &str = "preserved";

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// A file's size and modification time: the cheap check whether it
/// changed (0.1 compared these after the first pass too).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stat {
    pub size: u64,
    /// Nanoseconds since the Unix epoch.
    pub mtime: u64,
}

fn stat_of(meta: &fs::Metadata) -> io::Result<Stat> {
    let mtime = meta
        .modified()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    Ok(Stat {
        size: meta.len(),
        mtime,
    })
}

/// The file's [`Stat`]; `None` when it is not there.
pub fn stat(path: &Path) -> io::Result<Option<Stat>> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() => Ok(Some(stat_of(&m)?)),
        Ok(_) => Err(unsafe_path()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// A file's bytes, when it last changed and its [`Stat`] as it was before
/// the bytes were read; `None` when it is not there.
pub fn read(path: &Path) -> io::Result<Option<(Vec<u8>, SystemTime, Stat)>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.is_file() {
        return Err(unsafe_path());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(io::Error::new(io::ErrorKind::FileTooLarge, "too large"));
    }
    let stat = stat_of(&meta)?;
    let mut bytes = Vec::new();
    open_file(path)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::new(io::ErrorKind::FileTooLarge, "too large"));
    }
    if self::stat(path)? != Some(stat) {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "file changed during read",
        ));
    }
    Ok(Some((bytes, meta.modified()?, stat)))
}

/// Replace `path` with `bytes`: a file beside it, flushed, then renamed
/// over it, so a reader sees the old file or the new one. Readable and
/// writable by the owner only.
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(unsafe_path)?;
    fs::create_dir_all(parent)?;
    install(
        path,
        None,
        false,
        |temporary| {
            let mut file = make_file(temporary)?;
            file.write_all(bytes)?;
            file.sync_all()
        },
        false,
    )
}

/// Return a path below a selected directory, checking each component
/// without following symlinks. Missing subdirectories are optionally
/// created one at a time.
pub fn checked(root: &Path, rel: &str, create: bool) -> io::Result<PathBuf> {
    if !fs::symlink_metadata(root)?.is_dir() {
        return Err(unsafe_path());
    }
    let mut path = root.to_path_buf();
    let mut parts = rel.split('/').peekable();
    while let Some(part) = parts.next() {
        if matches!(part, "" | "." | "..") || part.contains(['\\', ':', '\0']) {
            return Err(unsafe_path());
        }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() || (parts.peek().is_some() && !m.is_dir()) => {
                return Err(unsafe_path());
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if create && parts.peek().is_some() {
                    match fs::create_dir(&path) {
                        Ok(()) => {}
                        Err(e)
                            if e.kind() == io::ErrorKind::AlreadyExists
                                && fs::symlink_metadata(&path)?.is_dir() => {}
                        Err(e) => return Err(e),
                    }
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(path)
}

fn unsafe_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "unsafe Markdown folder path",
    )
}

fn open_file(path: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(unsafe_path());
    }
    Ok(file)
}

fn make_file(path: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

pub fn hash(path: &Path) -> io::Result<Option<String>> {
    let Some(before) = stat(path)? else {
        return Ok(None);
    };
    let mut file = open_file(path)?;
    let mut hash = Sha256::new();
    io::copy(&mut file, &mut hash)?;
    if stat(path)? != Some(before) {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "file changed during fingerprint",
        ));
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

pub fn write_checked(
    root: &Path,
    rel: &str,
    expected: Option<&str>,
    bytes: &[u8],
    read_only: bool,
) -> io::Result<()> {
    let path = checked(root, rel, true)?;
    install(
        &path,
        expected,
        true,
        |temporary| {
            let mut file = make_file(temporary)?;
            file.write_all(bytes)?;
            file.sync_all()
        },
        read_only,
    )
}

pub fn copy_checked(
    source: &Path,
    root: &Path,
    rel: &str,
    expected: Option<&str>,
    read_only: bool,
) -> io::Result<()> {
    let path = checked(root, rel, true)?;
    install(
        &path,
        expected,
        true,
        |temporary| {
            #[cfg(target_os = "macos")]
            if clone_file(source, temporary).is_ok() {
                return dr_store::file_io::sync_file(temporary);
            }
            let mut dst = make_file(temporary)?;
            io::copy(&mut open_file(source)?, &mut dst)?;
            dst.sync_all()
        },
        read_only,
    )
}

#[cfg(target_os = "macos")]
fn clone_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // The selected source is an app-owned regular asset or a checked mirror file.
    if unsafe {
        libc::clonefile(from.as_ptr(), to.as_ptr(), 1 /* CLONE_NOFOLLOW */)
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn install(
    path: &Path,
    expected: Option<&str>,
    compare: bool,
    prepare: impl FnOnce(&Path) -> io::Result<()>,
    read_only: bool,
) -> io::Result<()> {
    let parent = path.parent().ok_or_else(unsafe_path)?;
    let temp = dr_store::file_io::temporary_sibling(&parent.join("drifting"))?;
    let result = (|| {
        prepare(&temp)?;
        set_permissions(&temp, read_only)?;
        if compare && hash(path)?.as_deref() != expected {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "file changed before replacement",
            ));
        }
        if compare && expected.is_none() {
            // Atomic no-clobber publication for a new path.
            publish_new(&temp, path)?;
            return Ok(());
        }
        #[cfg(windows)]
        if let Ok(meta) = fs::symlink_metadata(path) {
            if meta.permissions().readonly() {
                set_permissions(path, false)?;
            }
        }
        dr_store::file_io::durable_replace_file(&temp, path)
    })();
    if result.is_err() {
        #[cfg(windows)]
        let _ = set_permissions(&temp, false);
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn publish_new(temp: &Path, path: &Path) -> io::Result<()> {
    fs::hard_link(temp, path)?;
    fs::remove_file(temp)?;
    dr_store::file_io::sync_directory(path.parent().ok_or_else(unsafe_path)?)
}

#[cfg(windows)]
fn publish_new(temp: &Path, path: &Path) -> io::Result<()> {
    dr_store::file_io::windows_move_write_through(temp, path, false)
}

#[cfg(unix)]
fn set_permissions(path: &Path, read_only: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if read_only { 0o400 } else { 0o600 }),
    )
}

#[cfg(not(unix))]
fn set_permissions(path: &Path, read_only: bool) -> io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(read_only);
    fs::set_permissions(path, permissions)
}

/// Keep `bytes` (a file about to be replaced or dropped) under
/// `.drifting/preserved/<stamp>/<rel>` in the book's folder.
pub fn preserve(book_dir: &Path, rel: &str, bytes: &[u8], stamp: &str) -> io::Result<PathBuf> {
    let rel = preserved_relative(rel, stamp)?;
    write_checked(book_dir, &rel, None, bytes, false)?;
    Ok(book_dir.join(rel))
}

pub fn preserve_file(book_dir: &Path, rel: &str, stamp: &str) -> io::Result<PathBuf> {
    let from = checked(book_dir, rel, false)?;
    let to = preserved_relative(rel, stamp)?;
    copy_checked(&from, book_dir, &to, None, false)?;
    Ok(book_dir.join(to))
}

fn preserved_relative(rel: &str, stamp: &str) -> io::Result<String> {
    if stamp.is_empty() || stamp.contains(['/', '\\']) || matches!(stamp, "." | "..") {
        return Err(unsafe_path());
    }
    Ok(format!("{META_DIR}/{PRESERVED_DIR}/{stamp}/{rel}"))
}

/// A folder another installation of Drifting keeps.
#[derive(Debug, PartialEq, Eq)]
pub struct OwnedElsewhere;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    installation_id: String,
    #[serde(default)]
    app: String,
    #[serde(default)]
    book: String,
}

/// Claim `book_dir` for this installation (`.drifting/owner.json`): taken
/// when it has no owner, refused when another installation has it (both
/// would read every change once, and the text would double once synced).
pub fn claim(
    book_dir: &Path,
    installation: &str,
    app: &str,
) -> io::Result<Result<(), OwnedElsewhere>> {
    claim_for(book_dir, installation, app, "")
}

pub fn claim_for(
    book_dir: &Path,
    installation: &str,
    app: &str,
    book: &str,
) -> io::Result<Result<(), OwnedElsewhere>> {
    let rel = format!("{META_DIR}/{OWNER_FILE}");
    let file = checked(book_dir, &rel, false)?;
    if let Some((bytes, _, _)) = read(&file)? {
        let owner: Option<Owner> = serde_json::from_slice(&bytes).ok();
        return Ok(
            if owner.is_some_and(|owner| {
                owner.installation_id == installation && owner.app == app && owner.book == book
            }) {
                Ok(())
            } else {
                Err(OwnedElsewhere)
            },
        );
    }
    let owner = Owner {
        installation_id: installation.into(),
        app: app.into(),
        book: book.into(),
    };
    let bytes = serde_json::to_vec_pretty(&owner).expect("owner JSON");
    write_checked(book_dir, &rel, None, &bytes, false)?;
    Ok(Ok(()))
}

/// Remove `path` and the folders it leaves empty, up to `stop`.
pub fn remove(path: &Path, stop: &Path) -> io::Result<()> {
    #[cfg(windows)]
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.permissions().readonly()) {
        set_permissions(path, false)?;
    }
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d == stop || !d.starts_with(stop) {
            break;
        }
        if fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_are_whole_and_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a/b/章.md");
        write(&f, "一".as_bytes()).unwrap();
        write(&f, "二".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "二");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&f).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let left: Vec<_> = fs::read_dir(f.parent().unwrap()).unwrap().collect();
        assert_eq!(left.len(), 1, "no temporary file left");
        remove(&f, dir.path()).unwrap();
        assert!(!dir.path().join("a").exists(), "empty folders go");
    }

    #[test]
    fn a_relative_write_or_preserve_cannot_escape() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("chosen");
        fs::create_dir(&dir).unwrap();
        assert!(write_checked(&dir, "../external", None, b"source", false).is_err());
        assert!(preserve(&dir, "../../external", b"source", "stamp").is_err());
        assert!(!root.path().join("external").exists());
    }

    #[test]
    fn a_folder_has_one_owner() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(claim(dir.path(), "me", "app").unwrap(), Ok(()));
        assert_eq!(claim(dir.path(), "me", "app").unwrap(), Ok(()));
        assert_eq!(
            claim(dir.path(), "me", "another-app").unwrap(),
            Err(OwnedElsewhere)
        );
        assert_eq!(
            claim(dir.path(), "other", "app").unwrap(),
            Err(OwnedElsewhere)
        );
        let kept = preserve(dir.path(), "正文/001 雨.md", b"x", "20261108-120000").unwrap();
        assert!(kept.ends_with(".drifting/preserved/20261108-120000/正文/001 雨.md"));
    }
}
