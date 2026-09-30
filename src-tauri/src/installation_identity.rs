//! A non-secret installation marker, independent of accounts and Keychain.
//! Losing this file rotates the journal writer; it never resets local prose.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use tauri::Manager;

const FILE_NAME: &str = "sync-installation-v2.json";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    version: u8,
    installation_id: String,
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "installation randomness unavailable")?;
    Ok(format!(
        "install-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

fn read_identity(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 1024 {
        return Err("invalid installation identity file".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(1025)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let value: Identity = serde_json::from_slice(&bytes)
        .map_err(|_| "installation identity is corrupt; restore its local backup")?;
    let suffix = value
        .installation_id
        .strip_prefix("install-")
        .unwrap_or_default();
    if value.version != 2 || suffix.len() != 64 || !suffix.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("unsupported installation identity".into());
    }
    Ok(value.installation_id)
}

fn load_or_create(root: &Path) -> Result<String, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join(FILE_NAME);
    match fs::symlink_metadata(&path) {
        Ok(_) => return read_identity(&path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let id = random_id()?;
    let temporary = root.join(format!(".{id}.tmp"));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&Identity {
            version: 2,
            installation_id: id,
        })
        .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        // Publish a complete file without replacing a competing process's marker.
        match fs::hard_link(&temporary, &path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        #[cfg(unix)]
        File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        read_identity(&path)
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[tauri::command]
pub async fn sync_installation_identity(app: tauri::AppHandle) -> Result<String, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || load_or_create(&root))
        .await
        .map_err(|_| "installation identity worker failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn survives_reopen_and_isolated_installations_differ() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let id = load_or_create(a.path()).unwrap();
        assert_eq!(load_or_create(a.path()).unwrap(), id);
        assert_ne!(load_or_create(b.path()).unwrap(), id);
        fs::remove_file(a.path().join(FILE_NAME)).unwrap();
        assert_ne!(load_or_create(a.path()).unwrap(), id);
    }

    #[test]
    fn concurrent_first_reads_converge() {
        let dir = tempfile::tempdir().unwrap();
        let ids = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..12)
                .map(|_| scope.spawn(|| load_or_create(dir.path()).unwrap()))
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn corrupt_marker_is_preserved_and_never_silently_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, b"broken").unwrap();
        assert!(load_or_create(dir.path()).is_err());
        assert_eq!(fs::read(path).unwrap(), b"broken");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_creates_owner_only_file() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        load_or_create(other.path()).unwrap();
        assert_eq!(
            fs::metadata(other.path().join(FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        symlink(other.path().join(FILE_NAME), dir.path().join(FILE_NAME)).unwrap();
        assert!(load_or_create(dir.path()).is_err());
    }
}
