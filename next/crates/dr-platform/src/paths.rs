//! Where platform services keep their files.
//!
//! | | macOS | Windows |
//! | --- | --- | --- |
//! | data | `~/Library/Application Support/<bundle id>` | `%LOCALAPPDATA%\<bundle id>` |
//! | logs | `~/Library/Logs/<bundle id>` | `%LOCALAPPDATA%\<bundle id>\logs` |
//! | crashes | `<data>/crashes` | `<data>\crashes` |
//!
//! These are the folders Tauri's `app_local_data_dir` and `app_log_dir` name
//! for the same identifier, so the release identity finds the 0.1 client's
//! data folder where it always was. A development build has its own bundle id
//! and therefore its own folders; with `DRIFTING_PROFILE` each profile gets
//! `<bundle id>.<profile>` (`Identity::instance_name`).

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};

use crate::identity::Identity;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppDirs {
    /// The app's own data folder. F2 decides what goes in it.
    pub data: PathBuf,
    pub logs: PathBuf,
    /// Panic records and minidumps waiting to be sent, and crash follow-ups.
    pub crashes: PathBuf,
}

impl AppDirs {
    pub fn for_identity(identity: &Identity) -> Result<Self> {
        Self::named(&identity.instance_name())
    }

    fn named(name: &str) -> Result<Self> {
        let data = dirs::data_local_dir()
            .context("this system has no local application data folder")?
            .join(name);
        #[cfg(target_os = "macos")]
        let logs = dirs::home_dir()
            .context("this system has no home folder")?
            .join("Library/Logs")
            .join(name);
        #[cfg(not(target_os = "macos"))]
        let logs = data.join("logs");
        Ok(Self {
            crashes: data.join("crashes"),
            data,
            logs,
        })
    }

    /// Everything under one folder: tests, and isolated runs that must not
    /// touch the real folders.
    pub fn under(root: &Path) -> Self {
        Self {
            data: root.join("data"),
            logs: root.join("logs"),
            crashes: root.join("crashes"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{DEVELOPMENT, RELEASE};

    #[test]
    fn each_identity_has_its_own_folders_named_by_bundle_id() {
        let development = AppDirs::named(DEVELOPMENT.bundle_id).unwrap();
        let release = AppDirs::named(RELEASE.bundle_id).unwrap();
        for (dirs, id) in [
            (&development, DEVELOPMENT.bundle_id),
            (&release, RELEASE.bundle_id),
        ] {
            assert_eq!(dirs.data.file_name().unwrap(), id);
            assert!(dirs.crashes.starts_with(&dirs.data));
            assert!(dirs.logs.iter().any(|part| part == id));
        }
        assert_ne!(development.data, release.data);
        assert_ne!(development.logs, release.logs);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_logs_follow_the_library_logs_convention() {
        let dirs = AppDirs::named(DEVELOPMENT.bundle_id).unwrap();
        assert!(dirs.logs.ends_with("Library/Logs/cc.drifting.next.dev"));
        assert!(
            dirs.data
                .ends_with("Library/Application Support/cc.drifting.next.dev")
        );
    }
}
