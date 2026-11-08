//! Bounded, owner-only persistence. Nothing here discovers client config paths.

use crate::Result;
#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::path::PathBuf;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(crate) const PRIVATE_LIMIT: u64 = 4 * 1024 * 1024;
pub(crate) const CLIENT_LIMIT: u64 = 16 * 1024 * 1024;

pub(crate) fn random_hex() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not generate MCP credential".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn safe(meta: &fs::Metadata, private: bool) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: getuid has no preconditions.
        meta.uid() == unsafe { libc::getuid() }
            && meta.permissions().mode() & if private { 0o077 } else { 0o022 } == 0
    }
    #[cfg(not(unix))]
    {
        let _ = (meta, private);
        true
    }
}

fn directory(path: &Path, private: bool) -> Result<()> {
    if !path.is_absolute() {
        return Err("MCP storage requires an absolute directory".into());
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() && safe(&meta, private) => {
            Ok(())
        }
        Ok(_) => Err("MCP directory must be owned by this user, safe and not a symlink".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or("Missing MCP directory parent")?;
            if !parent.exists() {
                directory(parent, private)?;
            }
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(path) {
                Ok(()) => directory(path, private),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    directory(path, private)
                }
                Err(_) => Err("Could not create MCP directory".into()),
            }
        }
        Err(_) => Err("Could not inspect MCP directory".into()),
    }
}

pub(crate) fn ensure_private_dir(path: &Path) -> Result<()> {
    directory(path, true)
}

fn read(path: &Path, max: u64, private: bool) -> Result<Option<Vec<u8>>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read MCP configuration".into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > max || !safe(&meta, private)
    {
        return Err("MCP configuration must be a safe regular file owned by this user".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "Could not open MCP configuration".to_owned())?;
    let opened = file
        .metadata()
        .map_err(|_| "Could not inspect MCP configuration".to_owned())?;
    if !opened.is_file() || !safe(&opened, private) {
        return Err("MCP configuration changed while opening".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read MCP configuration".to_owned())?;
    if bytes.len() as u64 > max {
        return Err("MCP configuration is too large".into());
    }
    Ok(Some(bytes))
}

pub(crate) fn read_private(path: &Path) -> Result<Vec<u8>> {
    read(path, PRIVATE_LIMIT, true)?.ok_or_else(|| "MCP connection file is missing".into())
}
pub(crate) fn read_optional_private(path: &Path) -> Result<Option<Vec<u8>>> {
    read(path, PRIVATE_LIMIT, true)
}
pub(crate) fn read_client(path: &Path) -> Result<Option<Vec<u8>>> {
    read(path, CLIENT_LIMIT, false)
}

fn new_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Could not prepare MCP configuration".to_owned())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not save MCP configuration".to_owned())
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Could not synchronize MCP directory".to_owned())?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Compare twice with the bytes read before editing. A missing expected value
/// means create-only; it must never replace a file another writer just made.
pub(crate) fn atomic_write(
    path: &Path,
    bytes: &[u8],
    expected: Option<&[u8]>,
    backup: bool,
    private: bool,
) -> Result<()> {
    if bytes.len() as u64 > if private { PRIVATE_LIMIT } else { CLIENT_LIMIT } {
        return Err("MCP configuration is too large".into());
    }
    let parent = path.parent().ok_or("Missing MCP configuration parent")?;
    directory(parent, private)?;
    let current = || {
        read(
            path,
            if private { PRIVATE_LIMIT } else { CLIENT_LIMIT },
            private,
        )
    };
    if current()?.as_deref() != expected {
        return Err("MCP configuration changed; try again".into());
    }
    let suffix = random_hex()?;
    let temp = parent.join(format!(".drifting-{suffix}.tmp"));
    let result = (|| {
        new_file(&temp, bytes)?;
        if current()?.as_deref() != expected {
            return Err("MCP configuration changed; try again".into());
        }
        if backup && let Some(before) = expected {
            let name = path
                .file_name()
                .ok_or("Missing client configuration name")?
                .to_str()
                .ok_or("Client configuration path is not UTF-8")?;
            new_file(
                &parent.join(format!("{name}.drifting-backup-{suffix}")),
                before,
            )?;
        }
        if current()?.as_deref() != expected {
            return Err("MCP configuration changed; try again".into());
        }
        if expected.is_none() {
            fs::hard_link(&temp, path)
                .map_err(|_| "MCP configuration was created concurrently".to_owned())?;
            fs::remove_file(&temp).map_err(|_| "Could not remove MCP temporary file".to_owned())?;
        } else {
            fs::rename(&temp, path)
                .map_err(|_| "Could not replace MCP configuration".to_owned())?;
        }
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(crate) fn remove_private(path: &Path) -> Result<()> {
    if read_optional_private(path)?.is_none() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|_| "Could not remove MCP connection file".to_owned())?;
    sync_directory(path.parent().ok_or("Missing MCP directory")?)
}

#[cfg(unix)]
pub(crate) fn socket_path(directory: &Path, override_root: Option<&Path>) -> Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    ensure_private_dir(directory)?;
    let beside = directory.join("bridge.sock");
    if beside.as_os_str().as_bytes().len() <= 103 {
        return Ok(beside);
    }
    let root = match override_root {
        Some(root) => root.to_owned(),
        None => user_cache()?,
    };
    ensure_private_dir(&root)?;
    let sockets = root.join("drifting-mcp");
    ensure_private_dir(&sockets)?;
    let hash = Sha256::digest(directory.as_os_str().as_bytes());
    let name: String = hash[..8].iter().map(|byte| format!("{byte:02x}")).collect();
    let path = sockets.join(format!("{name}.sock"));
    if path.as_os_str().as_bytes().len() > 103 {
        return Err("MCP application data path is too long for local IPC".into());
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
fn user_cache() -> Result<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut buffer = vec![0u8; 1024];
    // SAFETY: confstr writes at most the supplied buffer length.
    let length = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_CACHE_DIR,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    if length == 0 || length > buffer.len() {
        return Err("Could not locate this user's private cache directory".into());
    }
    buffer.truncate(length - 1);
    Ok(PathBuf::from(std::ffi::OsString::from_vec(buffer))
        .components()
        .collect())
}
#[cfg(all(unix, not(target_os = "macos")))]
fn user_cache() -> Result<PathBuf> {
    Err("A private short socket directory is required on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cas_backup_and_private_file_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("private");
        let file = root.join("config.json");
        atomic_write(&file, b"first", None, false, true).unwrap();
        assert!(atomic_write(&file, b"lost", None, false, true).is_err());
        assert!(atomic_write(&file, b"lost", Some(b"stale"), false, true).is_err());
        atomic_write(&file, b"second", Some(b"first"), true, true).unwrap();
        assert_eq!(read_private(&file).unwrap(), b"second");
        let backup = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .find(|entry| entry.file_name().to_string_lossy().contains("backup"))
            .unwrap();
        assert_eq!(fs::read(backup.path()).unwrap(), b"first");
        remove_private(&file).unwrap();
        assert!(!file.exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_and_shared_private_files_are_refused() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("private");
        let file = root.join("secret");
        atomic_write(&file, b"synthetic", None, false, true).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let link = root.join("link");
        symlink(&file, &link).unwrap();
        assert!(read_private(&link).is_err());
        assert!(atomic_write(&link, b"replace", Some(b"synthetic"), false, true).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_private(&file).is_err());
        assert!(read_client(&file).is_ok());
    }
}
