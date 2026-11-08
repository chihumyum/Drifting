//! The folder on disk (the file layer of the 0.1 client's
//! `markdown_projection.rs`): which installation a book's folder belongs
//! to, writes that replace a file whole or not at all (owner-only
//! permissions), and copies of files kept before they are replaced.

use std::fs;
use std::io::{self, Write};
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
    match fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(Some(stat_of(&m)?)),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// A file's bytes, when it last changed and its [`Stat`] as it was before
/// the bytes were read; `None` when it is not there.
pub fn read(path: &Path) -> io::Result<Option<(Vec<u8>, SystemTime, Stat)>> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(io::Error::new(io::ErrorKind::FileTooLarge, "too large"));
    }
    let stat = stat_of(&meta)?;
    let bytes = fs::read(path)?;
    Ok(Some((bytes, meta.modified()?, stat)))
}

/// Replace `path` with `bytes`: a file beside it, flushed, then renamed
/// over it, so a reader sees the old file or the new one. Readable and
/// writable by the owner only.
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no folder"))?;
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = dir.join(format!(".{name}.{}.drifting-tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::File::create(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        owner_only(&temp)?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn owner_only(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn owner_only(_: &Path) -> io::Result<()> {
    Ok(())
}

/// Keep `bytes` (a file about to be replaced or dropped) under
/// `.drifting/preserved/<stamp>/<rel>` in the book's folder.
pub fn preserve(book_dir: &Path, rel: &str, bytes: &[u8], stamp: &str) -> io::Result<PathBuf> {
    let to = book_dir
        .join(META_DIR)
        .join(PRESERVED_DIR)
        .join(stamp)
        .join(rel);
    write(&to, bytes)?;
    Ok(to)
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
}

/// Claim `book_dir` for this installation (`.drifting/owner.json`): taken
/// when it has no owner, refused when another installation has it (both
/// would read every change once, and the text would double once synced).
pub fn claim(
    book_dir: &Path,
    installation: &str,
    app: &str,
) -> io::Result<Result<(), OwnedElsewhere>> {
    let file = book_dir.join(META_DIR).join(OWNER_FILE);
    match fs::read(&file) {
        Ok(bytes) => {
            let owner: Option<Owner> = serde_json::from_slice(&bytes).ok();
            match owner {
                Some(o) if o.installation_id == installation => Ok(Ok(())),
                Some(_) => Ok(Err(OwnedElsewhere)),
                // Unreadable: taken over (it says nothing).
                None => {
                    write_owner(&file, installation, app)?;
                    Ok(Ok(()))
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            write_owner(&file, installation, app)?;
            Ok(Ok(()))
        }
        Err(e) => Err(e),
    }
}

fn write_owner(file: &Path, installation: &str, app: &str) -> io::Result<()> {
    let owner = Owner {
        installation_id: installation.to_owned(),
        app: app.to_owned(),
    };
    let mut text = serde_json::to_string_pretty(&owner).expect("serialises");
    text.push('\n');
    write(file, text.as_bytes())
}

/// Remove `path` and the folders it leaves empty, up to `stop`.
pub fn remove(path: &Path, stop: &Path) -> io::Result<()> {
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
    fn a_folder_has_one_owner() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(claim(dir.path(), "me", "app").unwrap(), Ok(()));
        assert_eq!(claim(dir.path(), "me", "app").unwrap(), Ok(()));
        assert_eq!(
            claim(dir.path(), "other", "app").unwrap(),
            Err(OwnedElsewhere)
        );
        let kept = preserve(dir.path(), "正文/001 雨.md", b"x", "20261108-120000").unwrap();
        assert!(kept.ends_with(".drifting/preserved/20261108-120000/正文/001 雨.md"));
    }
}
