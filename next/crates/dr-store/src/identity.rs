//! This device's identity, kept outside every library.
//!
//! - **Installation id**: the 0.1 client's non-secret marker file
//!   `sync-installation-v2.json` (`src-tauri/src/installation_identity.rs`,
//!   ported unchanged in behaviour). Reading the same file keeps a device the
//!   same device across the upgrade.
//! - **Writing-day device key**: the digest the 0.1 renderer derives from it
//!   (`src/renderer/services/writing-days/device-key.ts`), so imported
//!   writing days stay attributed to this device.
//! - **Library watermarks** (`library-watermarks.json`): for every library
//!   this device has opened, the highest `write_seq` it has seen leave the
//!   device. A library that opens below its watermark is an older copy put
//!   back (a restored backup), and gets a new epoch.
//!
//! Loro peer ids are not derived from the installation id: copying the app's
//! data (Migration Assistant, a restored home folder) copies this file too,
//! and two machines would then write under the same peers. Peers stay random
//! per (device, document) in each library (`loro_peer`), and the epoch rotates
//! whenever the library notices it moved.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::digest::hex;
use crate::error::{Result, StoreError};
use crate::file_io::atomic_write;

pub const IDENTITY_FILE: &str = "sync-installation-v2.json";
pub const WATERMARK_FILE: &str = "library-watermarks.json";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    version: u8,
    installation_id: String,
}

fn invalid(what: &str) -> StoreError {
    StoreError::Identity(what.to_string())
}

fn random_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| invalid("installation randomness unavailable"))?;
    Ok(format!("install-{}", hex(&bytes)))
}

fn read_identity(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 1024 {
        return Err(invalid("invalid installation identity file"));
    }
    let mut bytes = Vec::new();
    File::open(path)?.take(1025).read_to_end(&mut bytes)?;
    let value: Identity = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("installation identity is corrupt; restore its local backup"))?;
    let suffix = value
        .installation_id
        .strip_prefix("install-")
        .unwrap_or_default();
    if value.version != 2 || suffix.len() != 64 || !suffix.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid("unsupported installation identity"));
    }
    Ok(value.installation_id)
}

/// Read the installation id in `dir`, creating it on first use. A corrupt
/// file is an error and is left untouched (never silently rotated).
pub fn load_or_create_installation_id(dir: &Path) -> Result<String> {
    fs::create_dir_all(dir)?;
    let path = dir.join(IDENTITY_FILE);
    match fs::symlink_metadata(&path) {
        Ok(_) => return read_identity(&path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let id = random_id()?;
    let temporary = dir.join(format!(".{id}.tmp"));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let bytes = serde_json::to_vec(&Identity {
            version: 2,
            installation_id: id,
        })
        .map_err(|e| invalid(&e.to_string()))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Publish a complete file without replacing a competing process's marker.
        match fs::hard_link(&temporary, &path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        #[cfg(unix)]
        File::open(dir)?.sync_all()?;
        read_identity(&path)
    })();
    let _ = fs::remove_file(temporary);
    result
}

/// The key this device signs its writing days with: a digest of the
/// installation id, so synced rows name the device without carrying the id.
/// Same result as the 0.1 renderer's `getWritingDeviceKey`.
pub fn writing_device_key(installation_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!("drifting.writing-day.v1\n{installation_id}").as_bytes());
    format!("device-{}", hex(&hash[..12]))
}

/// The device directory: where the identity and the library watermarks live
/// (the app's local data directory, outside every library).
#[derive(Clone, Debug)]
pub struct Device {
    dir: PathBuf,
    installation_id: String,
}

impl Device {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        let installation_id = load_or_create_installation_id(&dir)?;
        Ok(Self {
            dir,
            installation_id,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn installation_id(&self) -> &str {
        &self.installation_id
    }

    pub fn writing_device_key(&self) -> String {
        writing_device_key(&self.installation_id)
    }

    fn watermarks(&self) -> Result<BTreeMap<String, i64>> {
        let path = self.dir.join(WATERMARK_FILE);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| invalid("library watermarks are corrupt")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(e.into()),
        }
    }

    /// The highest `write_seq` recorded for a library.
    pub fn watermark(&self, library_id: &str) -> Result<Option<i64>> {
        Ok(self.watermarks()?.get(library_id).copied())
    }

    /// Raise a library's watermark (never lowers it).
    pub fn raise_watermark(&self, library_id: &str, write_seq: i64) -> Result<()> {
        let mut marks = self.watermarks()?;
        let entry = marks.entry(library_id.to_string()).or_insert(i64::MIN);
        if *entry >= write_seq {
            return Ok(());
        }
        *entry = write_seq;
        let bytes = serde_json::to_vec_pretty(&marks).map_err(|e| invalid(&e.to_string()))?;
        atomic_write(&self.dir.join(WATERMARK_FILE), &bytes)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn survives_reopen_and_isolated_installations_differ() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let id = load_or_create_installation_id(a.path()).unwrap();
        assert_eq!(load_or_create_installation_id(a.path()).unwrap(), id);
        assert_ne!(load_or_create_installation_id(b.path()).unwrap(), id);
        fs::remove_file(a.path().join(IDENTITY_FILE)).unwrap();
        assert_ne!(load_or_create_installation_id(a.path()).unwrap(), id);
    }

    #[test]
    fn concurrent_first_reads_converge() {
        let dir = tempfile::tempdir().unwrap();
        let ids = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..12)
                .map(|_| scope.spawn(|| load_or_create_installation_id(dir.path()).unwrap()))
                .collect();
            threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn corrupt_marker_is_preserved_and_never_silently_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(IDENTITY_FILE);
        fs::write(&path, b"broken").unwrap();
        assert!(load_or_create_installation_id(dir.path()).is_err());
        assert_eq!(fs::read(path).unwrap(), b"broken");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_creates_owner_only_file() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        load_or_create_installation_id(other.path()).unwrap();
        let mode = fs::metadata(other.path().join(IDENTITY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        symlink(
            other.path().join(IDENTITY_FILE),
            dir.path().join(IDENTITY_FILE),
        )
        .unwrap();
        assert!(load_or_create_installation_id(dir.path()).is_err());
    }

    #[test]
    fn reads_the_0_1_file_and_matches_its_device_key() {
        let dir = tempfile::tempdir().unwrap();
        let id = format!("install-{}", "ab".repeat(32));
        fs::write(
            dir.path().join(IDENTITY_FILE),
            format!("{{\"version\":2,\"installation_id\":\"{id}\"}}"),
        )
        .unwrap();
        let device = Device::open(dir.path()).unwrap();
        assert_eq!(device.installation_id(), id);
        // SHA-256("drifting.writing-day.v1\ninstall-abab…"), first 12 bytes,
        // as the 0.1 renderer computes it.
        let key = device.writing_device_key();
        assert_eq!(key.len(), "device-".len() + 24);
        assert_eq!(key, writing_device_key(&id));
        use sha2::{Digest, Sha256};
        let full = hex(&Sha256::digest(
            format!("drifting.writing-day.v1\n{id}").as_bytes(),
        ));
        assert_eq!(&key["device-".len()..], &full[..24]);
    }

    #[test]
    fn watermarks_only_rise() {
        let dir = tempfile::tempdir().unwrap();
        let device = Device::open(dir.path()).unwrap();
        assert_eq!(device.watermark("lib").unwrap(), None);
        device.raise_watermark("lib", 10).unwrap();
        device.raise_watermark("lib", 5).unwrap();
        assert_eq!(device.watermark("lib").unwrap(), Some(10));
        assert_eq!(
            Device::open(dir.path()).unwrap().watermark("lib").unwrap(),
            Some(10)
        );
    }
}
