//! This device's identity, kept outside every library.
//!
//! - **Installation id**: the 0.1 client's non-secret marker file
//!   `sync-installation-v2.json` (`src-tauri/src/installation_identity.rs`,
//!   ported unchanged in behaviour). Reading the same file keeps a device the
//!   same device across the upgrade.
//! - **Writing-day device key**: the digest the 0.1 renderer derives from it
//!   (`src/renderer/services/writing-days/device-key.ts`), so imported
//!   writing days stay attributed to this device.
//! - **Machine binding** (`device-machine-v1.json`): which machine the
//!   installation id belongs to, as a salted digest of the OS machine id
//!   ([`crate::machine`]: macOS `IOPlatformUUID`, Windows `MachineGuid`). When
//!   the app's data is copied to another machine (Migration Assistant, a
//!   restored home folder), the identity file comes along but the machine id
//!   does not match: the device takes a new installation id, so it is a new
//!   device for writing days, and every library it opens starts a new epoch.
//!   The digest lives beside `sync-installation-v2.json`, not in it: 0.1 reads
//!   that file with `deny_unknown_fields` and would call an extra field
//!   corrupt.
//! - **Library watermarks** (`library-watermarks.json`): for every library
//!   this device has opened, the highest `write_seq` it has seen leave the
//!   device. A library that opens below its watermark is an older copy put
//!   back (a restored backup), and gets a new epoch.
//!
//! Loro peer ids are not derived from the installation id: peers stay random
//! per (device, document) in each library (`loro_peer`), and the epoch rotates
//! whenever the library notices it moved (another installation id, or an
//! older copy).

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::digest::hex;
use crate::error::{Result, StoreError};
use crate::file_io::atomic_write;

pub const IDENTITY_FILE: &str = "sync-installation-v2.json";
pub const MACHINE_FILE: &str = "device-machine-v1.json";
pub const WATERMARK_FILE: &str = "library-watermarks.json";

/// Which machine an installation id belongs to.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MachineBinding {
    version: u8,
    installation_id: String,
    /// `SHA-256("drifting.machine.v1\n" + machine id)`, hex.
    machine: String,
}

/// The salted digest of a raw machine id that is stored (never the id).
pub fn machine_fingerprint(raw_machine_id: &str) -> String {
    crate::digest::sha256_hex(
        format!(
            "drifting.machine.v1\n{}",
            raw_machine_id.trim().to_ascii_uppercase()
        )
        .as_bytes(),
    )
}

fn read_binding(dir: &Path) -> Result<Option<MachineBinding>> {
    let path = dir.join(MACHINE_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() || metadata.len() > 1024 {
        return Err(invalid("invalid machine binding file"));
    }
    let binding: MachineBinding = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|_| invalid("machine binding is corrupt"))?;
    if binding.version != 1
        || binding.machine.len() != 64
        || !binding.machine.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(invalid("unsupported machine binding"));
    }
    Ok(Some(binding))
}

fn write_binding(dir: &Path, installation_id: &str, machine: &str) -> Result<()> {
    let bytes = serde_json::to_vec(&MachineBinding {
        version: 1,
        installation_id: installation_id.into(),
        machine: machine.into(),
    })
    .map_err(|e| invalid(&e.to_string()))?;
    atomic_write(&dir.join(MACHINE_FILE), &bytes)?;
    Ok(())
}

/// Replace the installation id with a new one (same file format as 0.1,
/// owner-only), durably. Returns the new id.
fn replace_installation_id(dir: &Path) -> Result<String> {
    write_installation_id(dir, &random_id()?)
}

/// Write `id` over the installation id (same file format as 0.1,
/// owner-only), durably. Returns the id as read back.
fn write_installation_id(dir: &Path, id: &str) -> Result<String> {
    let path = dir.join(IDENTITY_FILE);
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
            installation_id: id.to_string(),
        })
        .map_err(|e| invalid(&e.to_string()))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        crate::file_io::durable_replace_file(&temporary, &path)?;
        read_identity(&path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

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

fn valid_installation_id(id: &str) -> bool {
    let suffix = id.strip_prefix("install-").unwrap_or_default();
    suffix.len() == 64 && suffix.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Read the installation id in `dir`, creating it on first use. A corrupt
/// file is an error and is left untouched (never silently rotated).
pub fn load_or_create_installation_id(dir: &Path) -> Result<String> {
    publish_installation_id(dir, None).map(|(id, _)| id)
}

/// Read the installation id in `dir`; when there is none, publish `wanted`
/// (or a new random id) without ever replacing a file another process
/// published first. Returns the id and whether this call wrote it.
fn publish_installation_id(dir: &Path, wanted: Option<&str>) -> Result<(String, bool)> {
    fs::create_dir_all(dir)?;
    let path = dir.join(IDENTITY_FILE);
    match fs::symlink_metadata(&path) {
        Ok(_) => return Ok((read_identity(&path)?, false)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let id = match wanted {
        Some(id) => id.to_string(),
        None => random_id()?,
    };
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
            installation_id: id.clone(),
        })
        .map_err(|e| invalid(&e.to_string()))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Publish a complete file without replacing a competing process's marker.
        let wrote = match fs::hard_link(&temporary, &path) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(e) => return Err(e.into()),
        };
        #[cfg(unix)]
        File::open(dir)?.sync_all()?;
        let stored = read_identity(&path)?;
        Ok((stored.clone(), wrote && stored == id))
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
///
/// Clones share the installation id: after [`Self::take_over`] every clone
/// (the library's options among them) reads the new one.
#[derive(Clone, Debug)]
pub struct Device {
    dir: PathBuf,
    installation_id: Arc<RwLock<String>>,
    /// This machine's fingerprint (`None` where the platform has none).
    machine: Option<String>,
    machine_changed: bool,
}

impl Device {
    /// Open the device directory: read (or create) the installation id and
    /// check it still belongs to this machine.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self> {
        Self::open_with_machine_id(dir, crate::machine::platform_machine_id())
    }

    /// [`Self::open`] with a given raw machine id (`None`: the platform has
    /// none). Tests use it to play another machine.
    #[doc(hidden)]
    pub fn open_with_machine_id(dir: impl Into<PathBuf>, raw: Option<String>) -> Result<Self> {
        let dir = dir.into();
        let mut installation_id = load_or_create_installation_id(&dir)?;
        let mut machine_changed = false;
        let machine = raw.as_deref().map(machine_fingerprint);
        if let Some(fingerprint) = machine.clone() {
            match read_binding(&dir)? {
                Some(b) if b.installation_id == installation_id && b.machine == fingerprint => {}
                Some(b) if b.installation_id == installation_id => {
                    // The identity was made on another machine: this is a new
                    // device. New id first, then the binding; a crash in
                    // between only leaves a binding to rewrite next time.
                    installation_id = replace_installation_id(&dir)?;
                    write_binding(&dir, &installation_id, &fingerprint)?;
                    machine_changed = true;
                    log::warn!("the app's data came from another machine: new installation id");
                }
                // No binding yet (first run, or upgraded from 0.1), or the
                // identity file was replaced meanwhile: bind it to this machine.
                _ => write_binding(&dir, &installation_id, &fingerprint)?,
            }
        }
        Ok(Self {
            dir,
            installation_id: Arc::new(RwLock::new(installation_id)),
            machine,
            machine_changed,
        })
    }

    /// Take over an installation id (the 0.1 library's, so that this device
    /// stays the same device for writing days) when `dir` has none yet.
    /// Returns whether it was adopted; an existing identity is never
    /// replaced. The next [`Self::open`] binds it to this machine.
    pub fn adopt(dir: impl Into<PathBuf>, installation_id: &str) -> Result<bool> {
        if !valid_installation_id(installation_id) {
            return Err(invalid("not an installation id"));
        }
        let (_, wrote) = publish_installation_id(&dir.into(), Some(installation_id))?;
        Ok(wrote)
    }

    /// Whether this open found the identity made on another machine and
    /// replaced it.
    pub fn machine_changed(&self) -> bool {
        self.machine_changed
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn installation_id(&self) -> String {
        self.installation_id
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The fingerprint of the machine this device runs on (a salted digest,
    /// never the raw id); `None` where the platform has none. A library
    /// records it next to the installation id, so a copy moved to another
    /// machine is noticed even when both machines took over the same 0.1
    /// installation id.
    pub fn machine(&self) -> Option<&str> {
        self.machine.as_deref()
    }

    pub fn writing_device_key(&self) -> String {
        writing_device_key(&self.installation_id())
    }

    /// Take over `installation_id` in place of the current one: the 0.1
    /// installation id of a library this device wrote and is importing (M10),
    /// so that its writing days continue under the 0.1 device key. Unlike
    /// [`Self::adopt`] it replaces an existing identity, but only the one
    /// this device holds: when the file changed underneath (another process
    /// replaced it), nothing is written and it fails. The machine binding is
    /// left as it is; the next [`Self::open`] binds the new id to this
    /// machine. Every clone reads the new id at once. Returns whether the id
    /// changed. Use [`crate::Library::adopt_installation_id`], which also
    /// records it in the library.
    pub fn take_over(&self, installation_id: &str) -> Result<bool> {
        if !valid_installation_id(installation_id) {
            return Err(invalid("not an installation id"));
        }
        let mut current = self
            .installation_id
            .write()
            .unwrap_or_else(|e| e.into_inner());
        if *current == installation_id {
            return Ok(false);
        }
        let on_disk = read_identity(&self.dir.join(IDENTITY_FILE))?;
        if on_disk != *current {
            return Err(invalid(
                "the installation identity changed underneath; not replaced",
            ));
        }
        let written = write_installation_id(&self.dir, installation_id)?;
        if written != installation_id {
            return Err(invalid("the installation identity did not take"));
        }
        log::info!("this device takes over a 0.1 installation id (writing days continue under it)");
        *current = written;
        Ok(true)
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

    fn read_0_1_style(dir: &Path) -> Identity {
        // 0.1's reader: exactly `version` and `installation_id`.
        serde_json::from_slice(&fs::read(dir.join(IDENTITY_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn the_identity_is_bound_to_this_machine() {
        let dir = tempfile::tempdir().unwrap();
        let a = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        assert!(!a.machine_changed());
        assert!(dir.path().join(MACHINE_FILE).exists());
        let again = Device::open_with_machine_id(dir.path(), Some("machine-a".into())).unwrap();
        assert_eq!(
            again.installation_id(),
            a.installation_id(),
            "case does not matter"
        );
        assert!(!again.machine_changed());
        // The raw machine id is never stored.
        let binding = fs::read_to_string(dir.path().join(MACHINE_FILE)).unwrap();
        assert!(!binding.to_ascii_uppercase().contains("MACHINE-A"));
    }

    #[test]
    fn data_copied_to_another_machine_becomes_a_new_device() {
        let dir = tempfile::tempdir().unwrap();
        let a = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        // The whole directory arrives on machine B.
        let b = Device::open_with_machine_id(dir.path(), Some("MACHINE-B".into())).unwrap();
        assert!(b.machine_changed());
        assert_ne!(b.installation_id(), a.installation_id());
        assert_ne!(b.writing_device_key(), a.writing_device_key());
        // The identity file keeps 0.1's exact format (and owner-only mode).
        let identity = read_0_1_style(dir.path());
        assert_eq!(
            (identity.version, identity.installation_id.as_str()),
            (2, b.installation_id().as_str())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(IDENTITY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // From then on B is stable.
        let again = Device::open_with_machine_id(dir.path(), Some("MACHINE-B".into())).unwrap();
        assert_eq!(again.installation_id(), b.installation_id());
        assert!(!again.machine_changed());
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
    }

    #[test]
    fn no_machine_id_means_no_binding_and_no_change() {
        let dir = tempfile::tempdir().unwrap();
        let a = Device::open_with_machine_id(dir.path(), None).unwrap();
        let b = Device::open_with_machine_id(dir.path(), None).unwrap();
        assert_eq!(a.installation_id(), b.installation_id());
        assert!(!dir.path().join(MACHINE_FILE).exists());
    }

    #[test]
    fn a_replaced_identity_is_rebound_without_another_change() {
        let dir = tempfile::tempdir().unwrap();
        Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        // The identity file is lost and recreated (0.1 does that), or a crash
        // hit between writing a new id and its binding.
        fs::remove_file(dir.path().join(IDENTITY_FILE)).unwrap();
        let b = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        assert!(!b.machine_changed());
        let c = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        assert_eq!(c.installation_id(), b.installation_id());
    }

    #[test]
    fn a_corrupt_binding_stops_instead_of_guessing() {
        let dir = tempfile::tempdir().unwrap();
        let a = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        fs::write(dir.path().join(MACHINE_FILE), b"{broken").unwrap();
        assert!(Device::open_with_machine_id(dir.path(), Some("MACHINE-B".into())).is_err());
        assert_eq!(
            read_0_1_style(dir.path()).installation_id,
            a.installation_id()
        );
    }

    #[test]
    fn adopting_takes_the_old_id_only_when_there_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let old = format!("install-{}", "1a".repeat(32));
        assert!(Device::adopt(dir.path(), &old).unwrap());
        let device = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        assert_eq!(device.installation_id(), old);
        assert_eq!(device.writing_device_key(), writing_device_key(&old));
        assert_eq!(
            read_0_1_style(dir.path()).installation_id,
            old,
            "0.1 format"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(IDENTITY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // An identity that exists is never replaced.
        let other = format!("install-{}", "2b".repeat(32));
        assert!(!Device::adopt(dir.path(), &other).unwrap());
        assert_eq!(load_or_create_installation_id(dir.path()).unwrap(), old);
        assert!(Device::adopt(dir.path(), "install-short").is_err());
        assert!(Device::adopt(tempfile::tempdir().unwrap().path(), "not-an-id").is_err());
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

    #[test]
    fn a_device_takes_over_a_0_1_installation_id_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let device = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        let first = device.installation_id();
        let clone = device.clone();
        let old = format!("install-{}", "cd".repeat(32));
        assert!(device.take_over(&old).unwrap());
        // Every clone reads it, the file holds it, its key is the 0.1 one.
        assert_eq!(clone.installation_id(), old);
        assert_eq!(clone.writing_device_key(), writing_device_key(&old));
        assert_eq!(load_or_create_installation_id(dir.path()).unwrap(), old);
        assert!(!device.take_over(&old).unwrap(), "already");
        // The next open binds it to this machine: the same device.
        let again = Device::open_with_machine_id(dir.path(), Some("MACHINE-A".into())).unwrap();
        assert_eq!(again.installation_id(), old);
        assert!(!again.machine_changed());
        assert_ne!(first, old);
        // Not an id, or a file replaced underneath: nothing written.
        assert!(device.take_over("install-zz").is_err());
        let other = format!("install-{}", "ef".repeat(32));
        write_installation_id(dir.path(), &other).unwrap();
        assert!(device.take_over(&first).is_err());
        assert_eq!(load_or_create_installation_id(dir.path()).unwrap(), other);
    }
}
