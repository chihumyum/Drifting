//! Disposable loopback-only Hosted lab credentials. Never used by a release,
//! the production app identity, remote services, BYOK or provider credentials.
//! Like Vite's local dev session store, this avoids ad-hoc code-signing ACLs.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::Manager;

fn allowed(debug: bool, identifier: &str, origin: &str, key: &str) -> bool {
    let Some(suffix) = key.strip_prefix("drifting.hosted.v1.") else {
        return false;
    };
    debug
        && matches!(
            identifier,
            "cc.drifting.client.hosted-lab" | "cc.drifting.client.hosted-lab.peer"
        )
        && reqwest::Url::parse(origin).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                && url.username().is_empty()
                && url.password().is_none()
                && {
                    use sha2::{Digest, Sha256};
                    // The requested key must belong to this exact local service.
                    suffix
                        == format!(
                            "{:x}",
                            Sha256::digest(url.origin().ascii_serialization().as_bytes())
                        )
                }
        })
}

pub fn path(app: &tauri::AppHandle, key: &str) -> Result<Option<PathBuf>, String> {
    if !allowed(
        cfg!(debug_assertions),
        &app.config().identifier,
        option_env!("DRIFTING_HOSTED_ORIGIN").unwrap_or_default(),
        key,
    ) {
        return Ok(None);
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-hosted-session");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if !fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("invalid local lab session directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(Some(root.join(key)))
}

pub fn read(path: &std::path::Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return Err("invalid local lab session".into());
    }
    let mut value = String::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(256 * 1024 + 1)
        .read_to_string(&mut value)
        .map_err(|_| "invalid local lab session")?;
    Ok(Some(value))
}

pub fn write(path: &std::path::Path, value: &str) -> Result<bool, String> {
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|_| "local session randomness unavailable")?;
    let temporary =
        path.with_extension(nonce.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(value.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        sync_parent(path)?;
        Ok(true)
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn sync_parent(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path.parent().ok_or("missing local session directory")?)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(path: &std::path::Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => sync_parent(path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn only_exact_loopback_debug_lab_session_can_use_a_file() {
        let origin = "http://localhost:3000";
        let key = format!("drifting.hosted.v1.{:x}", Sha256::digest(origin));
        assert!(allowed(true, "cc.drifting.client.hosted-lab", origin, &key));
        assert!(!allowed(
            false,
            "cc.drifting.client.hosted-lab",
            origin,
            &key
        ));
        assert!(!allowed(true, "cc.drifting.client", origin, &key));
        assert!(!allowed(
            true,
            "cc.drifting.client.hosted-lab",
            "https://example.test",
            &key
        ));
        assert!(!allowed(
            true,
            "cc.drifting.client.hosted-lab",
            "http://localhost:3001",
            &key
        ));
        for other in [
            "byok.openai",
            "oauth.openai-codex",
            "sync.google-drive.credentials.a",
        ] {
            assert!(!allowed(
                true,
                "cc.drifting.client.hosted-lab",
                origin,
                other
            ));
        }
    }

    #[test]
    fn session_survives_reopen_replacement_and_logout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session");
        assert_eq!(read(&path).unwrap(), None);
        write(&path, "synthetic-session-a").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("synthetic-session-a"));
        write(&path, "synthetic-session-b").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("synthetic-session-b"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        delete(&path).unwrap();
        assert_eq!(read(&path).unwrap(), None);
        delete(&path).unwrap();
    }
}
