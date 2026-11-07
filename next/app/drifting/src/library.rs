//! Opening the library (F2) with F3's hooks and this device's identity.
//!
//! The device directory is the app's local data folder (`AppDirs::data`),
//! beside the `library/` folder and outside it. F2's `Device` keeps there
//! the 0.1 client's installation file `sync-installation-v2.json` (the file
//! the release identity finds after the hand-over), which machine it belongs
//! to (a salted digest of `IOPlatformUUID` / `MachineGuid`) and the library
//! watermarks. With it the library notices a copy from another machine or an
//! older backup put back (a new epoch), and M07's writing days are stored
//! under this device's key (`Workspace::writing_device`).
//!
//! A development build has a data folder of its own (`cc.drifting.next.dev`,
//! never the release app's), and `DRIFTING_PROFILE` (each worktree's
//! `cargo xtask dev`) gives every profile its own, so no two development
//! runs share a device identity either.
//!
//! When the identity cannot be read (an unreadable or corrupt file, which F2
//! never rewrites by itself), the library still opens, without it: the
//! author can write, writing days are counted but not stored, and the log
//! says why.

use std::path::Path;

use dr_workspace::{Workspace, WorkspaceOptions};

/// The library's folder inside the app's data folder (F2's `library.sqlite`,
/// `assets/`, …). The data folder itself is the 0.1 client's for the release
/// identity, so the new library keeps to a folder of its own.
pub const LIBRARY_DIR: &str = "library";

/// Opens (or creates) the library in `<data>/library` with this device.
pub fn open(data: &Path, app_version: &str) -> dr_workspace::Result<Workspace> {
    let mut options = dr_workspace::library_options(app_version);
    match dr_store::Device::open(data) {
        Ok(device) => {
            if device.machine_changed() {
                log::warn!("the app's data came from another machine: this is a new device");
            }
            options.device = Some(device);
        }
        Err(error) => {
            log::error!(
                "this device's identity could not be read, writing days are not stored: {error}"
            )
        }
    }
    let lib = dr_store::Library::open(data.join(LIBRARY_DIR), options)?;
    Workspace::open(lib, WorkspaceOptions::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERSION: &str = "0.2.0-test";

    /// The 0.1 client's installation file, which F2's `Device` reads.
    const IDENTITY_FILE: &str = "sync-installation-v2.json";

    fn close(ws: Workspace) {
        ws.close();
        let lib = ws.library().clone();
        drop(ws);
        lib.close().unwrap();
    }

    #[test]
    fn the_library_opens_with_this_devices_writing_day_key() {
        let data = tempfile::tempdir().unwrap();
        let ws = open(data.path(), VERSION).unwrap();
        let key = ws.writing_device().expect("the library knows this device");
        assert!(key.starts_with("device-"), "{key}");
        // The identity lives in the data folder, outside the library.
        assert!(data.path().join(IDENTITY_FILE).is_file());
        assert!(!data.path().join(LIBRARY_DIR).join(IDENTITY_FILE).exists());
        let device = dr_store::Device::open(data.path()).unwrap();
        assert_eq!(key, device.writing_device_key());
        close(ws);

        // Reopened, it is the same device.
        let ws = open(data.path(), VERSION).unwrap();
        assert_eq!(ws.writing_device().as_deref(), Some(key.as_str()));
        close(ws);
    }

    #[test]
    fn every_data_folder_is_its_own_device() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (wa, wb) = (
            open(a.path(), VERSION).unwrap(),
            open(b.path(), VERSION).unwrap(),
        );
        assert_ne!(wa.writing_device(), wb.writing_device());
        close(wa);
        close(wb);
    }

    #[test]
    fn a_broken_identity_still_opens_the_library_without_storing_days() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join(IDENTITY_FILE), b"broken").unwrap();
        let ws = open(data.path(), VERSION).unwrap();
        assert_eq!(ws.writing_device(), None);
        close(ws);
        // F2 never rewrites a corrupt identity by itself.
        assert_eq!(
            std::fs::read(data.path().join(IDENTITY_FILE)).unwrap(),
            b"broken"
        );
    }
}
