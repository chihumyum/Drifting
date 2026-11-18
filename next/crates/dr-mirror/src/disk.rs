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
    .map(|_| ())
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
    Ok(hash_with_stat(path)?.map(|(sha, _)| sha))
}

/// [`hash`] and the [`Stat`] the file had while it was read.
pub fn hash_with_stat(path: &Path) -> io::Result<Option<(String, Stat)>> {
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
    Ok(Some((format!("{:x}", hash.finalize()), before)))
}

/// What [`write_checked`] and [`copy_checked`] left at the path.
#[derive(Debug)]
pub struct Installed {
    /// False when another writer occupied the name during portable publication.
    pub published: bool,
    /// The installed file's size and modification time, taken from the
    /// temporary file before it was installed (an outside save after the
    /// install changes them).
    pub stat: Stat,
    /// An outside save that landed between the last check and the
    /// exchange: the hidden sibling now holding those bytes. The caller
    /// keeps it with [`preserve_displaced`].
    pub displaced: Option<PathBuf>,
}

pub fn write_checked(
    root: &Path,
    rel: &str,
    expected: Option<&str>,
    bytes: &[u8],
    read_only: bool,
) -> io::Result<Installed> {
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
) -> io::Result<Installed> {
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
) -> io::Result<Installed> {
    let parent = path.parent().ok_or_else(unsafe_path)?;
    let temp = dr_store::file_io::temporary_sibling(&parent.join("drifting"))?;
    let mut exchanged = false;
    let result = (|| {
        prepare(&temp)?;
        set_permissions(&temp, read_only)?;
        let stat = stat_of(&fs::symlink_metadata(&temp)?)?;
        if compare && hash(path)?.as_deref() != expected {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "file changed before replacement",
            ));
        }
        if compare && expected.is_none() {
            // Atomic no-clobber publication for a new path.
            let stat = publish_new(&temp, path)?.unwrap_or(stat);
            return Ok(Installed {
                published: true,
                stat,
                displaced: None,
            });
        }
        #[cfg(test)]
        seam::before_exchange(path);
        if let Some(expected) = expected.filter(|_| compare) {
            // An outside save between the check above and the swap is in
            // the file the swap takes out, never overwritten.
            match exchange(&temp, path) {
                Ok(()) => {
                    exchanged = true;
                    return after_exchange(&temp, path, expected, stat);
                }
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "file removed before replacement",
                    ));
                }
                Err(err) if rename_unsupported(&err) => {
                    // A filesystem without atomic exchange still must never
                    // overwrite an outside save. Move that file out first,
                    // then publish exclusively. A competing new name wins.
                    let held = dr_store::file_io::temporary_sibling(path)?;
                    fs::rename(path, &held)?;
                    if !fs::symlink_metadata(&held).is_ok_and(|m| m.is_file()) {
                        // This was a move, not a swap: path no longer holds
                        // our temp. Restore without replacing a new occupant.
                        restore_moved(&held, path)?;
                        let _ = fs::remove_file(&temp);
                        return Err(unsafe_path());
                    }
                    let mut result = after_exchange(&held, path, expected, stat)?;
                    #[cfg(test)]
                    if let Some(mut hook) = seam::BEFORE_PUBLISH.take() {
                        hook(path);
                    }
                    match publish_new(&temp, path) {
                        Ok(installed_stat) => {
                            result.stat = installed_stat.unwrap_or(stat);
                        }
                        Err(err) => {
                            log::warn!("Markdown publication deferred: {err}");
                            result.published = false;
                            let _ = fs::remove_file(&temp);
                        }
                    }
                    return Ok(result);
                }
                Err(err) => return Err(err),
            }
        }
        #[cfg(windows)]
        if let Ok(meta) = fs::symlink_metadata(path)
            && meta.permissions().readonly()
        {
            set_permissions(path, false)?;
        }
        dr_store::file_io::durable_replace_file(&temp, path)?;
        Ok(Installed {
            published: true,
            stat,
            displaced: None,
        })
    })();
    if result.is_err() && !exchanged {
        #[cfg(windows)]
        let _ = set_permissions(&temp, false);
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Restore an unsafe entry taken by the portable fallback. The exclusive
/// operation can move a directory or symlink without following it. If the
/// name has been occupied meanwhile, the held entry stays intact.
fn restore_moved(held: &Path, path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let restored = rename_with(held, path, libc::RENAME_EXCL);
    #[cfg(target_os = "linux")]
    let restored = rename_with(held, path, libc::RENAME_NOREPLACE);
    #[cfg(windows)]
    let restored = dr_store::file_io::windows_move_write_through(held, path, false);
    restored.map_err(|err| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            RetainedEntry {
                path: held.to_path_buf(),
                cause: err,
            },
        )
    })
}

#[derive(Debug, thiserror::Error)]
#[error("Markdown folder entry kept at {path}: {cause}")]
struct RetainedEntry {
    path: PathBuf,
    cause: io::Error,
}

/// The original entry could not be restored because its name was taken;
/// callers keep a visible issue pointing at the retained entry.
pub(crate) fn retained_entry(err: &io::Error) -> Option<&Path> {
    err.get_ref()?
        .downcast_ref::<RetainedEntry>()
        .map(|entry| entry.path.as_path())
}

/// After the swap `temp` holds what was at the path. The expected bytes go;
/// anything else is an outside save, left for the caller to keep.
fn after_exchange(temp: &Path, path: &Path, expected: &str, stat: Stat) -> io::Result<Installed> {
    if !fs::symlink_metadata(temp).is_ok_and(|m| m.is_file()) {
        // A directory or a symlink was put there: give it back.
        exchange(temp, path)?;
        let _ = fs::remove_file(temp);
        return Err(unsafe_path());
    }
    dr_store::file_io::sync_directory(path.parent().ok_or_else(unsafe_path)?)?;
    if matches!(hash(temp), Ok(Some(sha)) if sha == expected) {
        #[cfg(windows)]
        set_permissions(temp, false)?;
        if let Err(err) = fs::remove_file(temp) {
            log::warn!("Markdown folder: replaced copy left behind: {err}");
        }
        return Ok(Installed {
            published: true,
            stat,
            displaced: None,
        });
    }
    Ok(Installed {
        published: true,
        stat,
        displaced: Some(temp.to_path_buf()),
    })
}

#[cfg(target_os = "macos")]
fn rename_with(from: &Path, to: &Path, flags: libc::c_uint) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // Both are paths inside the checked folder; the call only renames.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), flags) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_with(from: &Path, to: &Path, flags: libc::c_uint) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // Both are paths inside the checked folder; the call only renames.
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            flags,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Swap the two names (macOS `RENAME_SWAP`, Linux `RENAME_EXCHANGE`).
/// Elsewhere the caller moves the old name aside and publishes exclusively.
fn exchange(a: &Path, b: &Path) -> io::Result<()> {
    #[cfg(test)]
    if seam::EXCHANGE_FAILS.get() {
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    }
    #[cfg(target_os = "macos")]
    return rename_with(a, b, libc::RENAME_SWAP);
    #[cfg(target_os = "linux")]
    return rename_with(a, b, libc::RENAME_EXCHANGE);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (a, b);
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

fn rename_unsupported(err: &io::Error) -> bool {
    if err.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    if let Some(code) = err.raw_os_error() {
        return [libc::ENOTSUP, libc::EOPNOTSUPP, libc::EINVAL, libc::ENOSYS].contains(&code);
    }
    false
}

/// Hard links are the portable no-clobber publication; exFAT, SMB and
/// some cloud-storage providers refuse them.
#[cfg(unix)]
fn link_unsupported(err: &io::Error) -> bool {
    err.raw_os_error().is_some_and(|code| {
        [
            libc::ENOTSUP,
            libc::EOPNOTSUPP,
            libc::EPERM,
            libc::ENOSYS,
            libc::EXDEV,
        ]
        .contains(&code)
    })
}

/// Publish `temp` at the new `path` without replacing anything there.
/// `Some` is the published file's stat when it is a new file rather than
/// `temp` itself (the last fallback writes a copy).
#[cfg(unix)]
fn publish_new(temp: &Path, path: &Path) -> io::Result<Option<Stat>> {
    let parent = path.parent().ok_or_else(unsafe_path)?;
    #[cfg(test)]
    let linked = seam::link(temp, path);
    #[cfg(not(test))]
    let linked = fs::hard_link(temp, path);
    match linked {
        Ok(()) => {
            fs::remove_file(temp)?;
            sync_published(parent)?;
            Ok(None)
        }
        Err(err) if link_unsupported(&err) => {
            #[cfg(test)]
            seam::fell_back(path);
            let stat = publish_new_without_link(temp, path)?;
            sync_published(parent)?;
            Ok(stat)
        }
        Err(err) => Err(err),
    }
}

#[cfg(unix)]
fn sync_published(parent: &Path) -> io::Result<()> {
    #[cfg(test)]
    if seam::PUBLISH_SYNC_FAILS.get() {
        return Err(io::Error::other("test: published directory sync failed"));
    }
    dr_store::file_io::sync_directory(parent)
}

#[cfg(unix)]
fn publish_new_without_link(temp: &Path, path: &Path) -> io::Result<Option<Stat>> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        #[cfg(target_os = "macos")]
        let flag = libc::RENAME_EXCL;
        #[cfg(target_os = "linux")]
        let flag = libc::RENAME_NOREPLACE;
        #[cfg(test)]
        let renamed = seam::exclusive(temp, path, flag);
        #[cfg(not(test))]
        let renamed = rename_with(temp, path, flag);
        match renamed {
            Ok(()) => return Ok(None),
            Err(err) if rename_unsupported(&err) => {}
            Err(err) => return Err(err),
        }
    }
    // Last resort: create the path exclusively and copy into it. A reader
    // can see the new file before it is complete, never a replaced one.
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let read_only = fs::symlink_metadata(temp)?.permissions().readonly();
    io::copy(&mut open_file(temp)?, &mut file)?;
    file.sync_all()?;
    set_permissions(path, read_only)?;
    let stat = stat_of(&file.metadata()?)?;
    fs::remove_file(temp)?;
    Ok(Some(stat))
}

#[cfg(windows)]
fn publish_new(temp: &Path, path: &Path) -> io::Result<Option<Stat>> {
    dr_store::file_io::windows_move_write_through(temp, path, false).map(|()| None)
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

/// Keep a file [`Installed::displaced`] took out under
/// `.drifting/preserved/<stamp>/<rel>` (a numbered name when this pass
/// already kept that file).
pub fn preserve_displaced(
    book_dir: &Path,
    rel: &str,
    stamp: &str,
    displaced: &Path,
) -> io::Result<PathBuf> {
    let base = preserved_relative(rel, stamp)?;
    set_permissions(displaced, false)?;
    for n in 1..=100 {
        let to = if n == 1 {
            base.clone()
        } else {
            format!("{base}.{n}")
        };
        let path = checked(book_dir, &to, true)?;
        match publish_new(displaced, &path) {
            Ok(_) => return Ok(path),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => {
                // Publication can consume the held name before syncing its
                // directory fails. Report where those bytes actually are.
                let retained = if fs::symlink_metadata(displaced).is_ok() {
                    displaced.to_path_buf()
                } else if fs::symlink_metadata(&path).is_ok() {
                    path
                } else {
                    return Err(err);
                };
                return Err(io::Error::new(
                    err.kind(),
                    RetainedEntry {
                        path: retained,
                        cause: err,
                    },
                ));
            }
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
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

/// Remove a checked version by taking the directory entry first. If an
/// outside save won the race, return its bytes for preservation instead of
/// unlinking them. An outside save to the old name after the move is untouched.
pub fn remove_checked(path: &Path, expected: &str) -> io::Result<Option<PathBuf>> {
    if hash(path)?.as_deref() != Some(expected) {
        return Err(io::Error::from(io::ErrorKind::WouldBlock));
    }
    #[cfg(test)]
    if let Some(mut hook) = seam::BEFORE_REMOVE.take() {
        hook(path);
        seam::BEFORE_REMOVE.set(Some(hook));
    }
    let held = dr_store::file_io::temporary_sibling(path)?;
    fs::rename(path, &held)?;
    if !fs::symlink_metadata(&held).is_ok_and(|m| m.is_file()) {
        restore_moved(&held, path)?;
        return Err(unsafe_path());
    }
    dr_store::file_io::sync_directory(path.parent().ok_or_else(unsafe_path)?)?;
    if matches!(hash(&held), Ok(Some(sha)) if sha == expected) {
        set_permissions(&held, false)?;
        fs::remove_file(held)?;
        Ok(None)
    } else {
        Ok(Some(held))
    }
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

/// Test seams: a file system without hard links or exclusive renames, and
/// an outside save between the final check and the exchange.
#[cfg(test)]
pub(crate) mod seam {
    use std::cell::{Cell, RefCell};
    use std::io;
    use std::path::{Path, PathBuf};

    type Hook = Box<dyn FnMut(&Path)>;

    thread_local! {
        /// The errno every hard link fails with.
        pub static PUBLISH_SYNC_FAILS: Cell<bool> = const { Cell::new(false) };
        pub static EXCHANGE_FAILS: Cell<bool> = const { Cell::new(false) };
        pub static BEFORE_PUBLISH: RefCell<Option<Hook>> = const { RefCell::new(None) };
        pub static BEFORE_REMOVE: RefCell<Option<Hook>> = const { RefCell::new(None) };
        pub static LINK_FAILS: Cell<Option<i32>> = const { Cell::new(None) };
        /// The errno every exclusive rename fails with.
        pub static EXCLUSIVE_FAILS: Cell<Option<i32>> = const { Cell::new(None) };
        /// The new paths published without a hard link.
        pub static FELL_BACK: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
        /// Runs between the final check and the exchange.
        pub static BEFORE_EXCHANGE: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    /// Unix only, as the hard-link publication that calls it.
    #[cfg(unix)]
    pub(super) fn link(from: &Path, to: &Path) -> io::Result<()> {
        match LINK_FAILS.get() {
            Some(code) => Err(io::Error::from_raw_os_error(code)),
            None => std::fs::hard_link(from, to),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn exclusive(from: &Path, to: &Path, flag: libc::c_uint) -> io::Result<()> {
        match EXCLUSIVE_FAILS.get() {
            Some(code) => Err(io::Error::from_raw_os_error(code)),
            None => super::rename_with(from, to, flag),
        }
    }

    #[cfg(unix)]
    pub(super) fn fell_back(path: &Path) {
        FELL_BACK.with_borrow_mut(|paths| paths.push(path.to_path_buf()));
    }

    pub(super) fn before_exchange(path: &Path) {
        if let Some(mut hook) = BEFORE_EXCHANGE.take() {
            hook(path);
            BEFORE_EXCHANGE.set(Some(hook));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn no_hard_links_or_exclusive_rename_still_publishes_without_clobbering() {
        let dir = tempfile::tempdir().unwrap();
        seam::LINK_FAILS.set(Some(libc::ENOTSUP));
        seam::EXCLUSIVE_FAILS.set(Some(libc::ENOTSUP));
        write_checked(dir.path(), "new.md", None, b"new", false).unwrap();
        assert_eq!(fs::read(dir.path().join("new.md")).unwrap(), b"new");
        let temp = dir.path().join("temp");
        fs::write(&temp, b"replacement").unwrap();
        assert_eq!(
            publish_new(&temp, &dir.path().join("new.md"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(dir.path().join("new.md")).unwrap(), b"new");
        seam::LINK_FAILS.set(None);
        seam::EXCLUSIVE_FAILS.set(None);
    }

    #[test]
    fn replacement_keeps_a_save_after_the_last_check_with_or_without_exchange() {
        for portable in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("body.md"), b"before").unwrap();
            seam::EXCHANGE_FAILS.set(portable);
            seam::BEFORE_EXCHANGE.set(Some(Box::new(|path| fs::write(path, b"outside").unwrap())));
            let result = write_checked(
                dir.path(),
                "body.md",
                Some(&sha256_hex(b"before")),
                b"app",
                false,
            )
            .unwrap();
            seam::BEFORE_EXCHANGE.set(None);
            seam::EXCHANGE_FAILS.set(false);
            assert!(result.published);
            assert_eq!(fs::read(dir.path().join("body.md")).unwrap(), b"app");
            let kept = preserve_displaced(
                dir.path(),
                "body.md",
                "race",
                result
                    .displaced
                    .as_ref()
                    .expect("outside save was retained"),
            )
            .unwrap();
            assert_eq!(fs::read(kept).unwrap(), b"outside");
        }
    }

    #[test]
    #[cfg(unix)]
    fn portable_replacement_restores_a_racing_directory_or_symlink() {
        for directory in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("body.md");
            let outside = dir.path().join("outside");
            fs::write(&path, b"before").unwrap();
            fs::write(&outside, b"untouched").unwrap();
            seam::EXCHANGE_FAILS.set(true);
            let target = outside.clone();
            seam::BEFORE_EXCHANGE.set(Some(Box::new(move |path| {
                fs::remove_file(path).unwrap();
                if directory {
                    fs::create_dir(path).unwrap();
                } else {
                    std::os::unix::fs::symlink(&target, path).unwrap();
                }
            })));
            let err = write_checked(
                dir.path(),
                "body.md",
                Some(&sha256_hex(b"before")),
                b"app",
                false,
            )
            .unwrap_err();
            seam::BEFORE_EXCHANGE.set(None);
            seam::EXCHANGE_FAILS.set(false);
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
            let ty = fs::symlink_metadata(&path).unwrap().file_type();
            assert!(if directory {
                ty.is_dir()
            } else {
                ty.is_symlink()
            });
            assert_eq!(fs::read(outside).unwrap(), b"untouched");
        }
    }

    #[test]
    fn portable_replacement_does_not_clobber_a_competing_new_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.md");
        fs::write(&path, b"before").unwrap();
        seam::EXCHANGE_FAILS.set(true);
        seam::BEFORE_EXCHANGE.set(Some(Box::new(|path| {
            fs::write(path, b"first outside").unwrap()
        })));
        seam::BEFORE_PUBLISH.set(Some(Box::new(|path| {
            fs::write(path, b"second outside").unwrap()
        })));
        let result = write_checked(
            dir.path(),
            "body.md",
            Some(&sha256_hex(b"before")),
            b"app",
            false,
        )
        .unwrap();
        seam::BEFORE_EXCHANGE.set(None);
        seam::EXCHANGE_FAILS.set(false);
        assert!(!result.published);
        assert_eq!(fs::read(path).unwrap(), b"second outside");
        assert_eq!(
            fs::read(result.displaced.unwrap()).unwrap(),
            b"first outside"
        );
    }

    #[test]
    fn removal_keeps_a_save_after_the_last_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.md");
        fs::write(&path, b"before").unwrap();
        seam::BEFORE_REMOVE.set(Some(Box::new(|path| fs::write(path, b"outside").unwrap())));
        let held = remove_checked(&path, &sha256_hex(b"before"))
            .unwrap()
            .expect("outside save was retained");
        seam::BEFORE_REMOVE.set(None);
        let kept = preserve_displaced(dir.path(), "body.md", "race", &held).unwrap();
        assert_eq!(fs::read(kept).unwrap(), b"outside");
        assert!(!path.exists());
    }

    #[test]
    #[cfg(unix)]
    fn removal_restores_a_racing_symlink_without_changing_its_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.md");
        let target = dir.path().join("outside");
        fs::write(&path, b"before").unwrap();
        fs::write(&target, b"outside").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o444)).unwrap();
        let outside = target.clone();
        seam::BEFORE_REMOVE.set(Some(Box::new(move |path| {
            fs::remove_file(path).unwrap();
            symlink(&outside, path).unwrap();
        })));
        assert_eq!(
            remove_checked(&path, &sha256_hex(b"before"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        seam::BEFORE_REMOVE.set(None);
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"outside");
        assert_eq!(
            fs::metadata(target).unwrap().permissions().mode() & 0o777,
            0o444
        );
    }

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
