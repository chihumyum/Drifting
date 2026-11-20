//! Where platform services keep their files.
//!
//! | | macOS | Windows |
//! | --- | --- | --- |
//! | data (shared with 0.1 under the release identity) | `~/Library/Application Support/<bundle id>` | `%LOCALAPPDATA%\<bundle id>` |
//! | own (this client's files) | development: = data; release: `~/Library/Application Support/<bundle id>.v2` | development: = data; release: `%LOCALAPPDATA%\<bundle id>.v2` |
//! | logs | `~/Library/Logs/<bundle id>` | `<own>\logs` |
//! | crashes | `<own>/crashes` | `<own>\crashes` |
//!
//! `data` is the folder Tauri's `app_local_data_dir` names for the same
//! identifier, so the release identity finds the 0.1 client's data folder
//! where it always was. That folder belongs to the 0.1 client: its
//! `libraries.json`, its pre-registry library (`databases/`, `assets/`, the
//! installation identity) at the root and every other library in
//! `libraries/<id>`, the same file and folder names this client's account
//! libraries use. So the release identity keeps its own files beside it, in
//! [`AppDirs::own`], and writes nothing into `data` but what both clients
//! share on purpose (`mcp/`, the external Agents' connection files, whose
//! paths are already in the authors' Agent configs). Not inside it either:
//! the 0.1 pre-registry library's root is `data` itself, and the import
//! refuses a destination inside the library it reads.
//!
//! A development build has its own bundle id and therefore its own folders,
//! `own` is `data`; with `DRIFTING_PROFILE` each profile gets
//! `<bundle id>.<profile>` (`Identity::instance_name`).

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};

use crate::identity::Identity;

/// The release identity's own folder is `<bundle id>.<RELEASE_OWN_SUFFIX>`
/// beside the 0.1 client's `<bundle id>`. Published with 0.2.0: never rename.
pub const RELEASE_OWN_SUFFIX: &str = "v2";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppDirs {
    /// The folder the system names after this run's bundle id. Under the
    /// release identity it is the 0.1 client's data folder: only what both
    /// clients share lives here (`mcp/`), and 「导入 Drifting 0.1」 finds the
    /// 0.1 libraries here. Everything else goes in [`Self::own`].
    pub data: PathBuf,
    /// This client's own files: settings, the library registry and the
    /// libraries (`libraries.json`, `library/`, `libraries/`), the device
    /// identity, downloaded updates, the diagnostics id. `data` for a
    /// development build; beside it for the release identity.
    pub own: PathBuf,
    pub logs: PathBuf,
    /// Panic records and minidumps waiting to be sent, and crash follow-ups.
    pub crashes: PathBuf,
}

impl AppDirs {
    pub fn for_identity(identity: &Identity) -> Result<Self> {
        let local_data =
            dirs::data_local_dir().context("this system has no local application data folder")?;
        #[cfg(target_os = "macos")]
        let log_root = dirs::home_dir()
            .context("this system has no home folder")?
            .join("Library/Logs");
        #[cfg(not(target_os = "macos"))]
        let log_root = PathBuf::new();
        Ok(Self::for_identity_at(identity, &local_data, &log_root))
    }

    /// The folders `identity` gets when the system's local data folder is
    /// `local_data` and macOS's `~/Library/Logs` is `log_root` (unused
    /// elsewhere): tests of a layout whose real folders they must not touch,
    /// the release identity's above all.
    pub fn for_identity_at(identity: &Identity, local_data: &Path, log_root: &Path) -> Self {
        Self::layout(identity, &identity.instance_name(), local_data, log_root)
    }

    fn layout(identity: &Identity, name: &str, local_data: &Path, log_root: &Path) -> Self {
        let data = local_data.join(name);
        let own = if identity.is_release() {
            local_data.join(format!("{name}.{RELEASE_OWN_SUFFIX}"))
        } else {
            data.clone()
        };
        let logs = if cfg!(target_os = "macos") {
            log_root.join(name)
        } else {
            own.join("logs")
        };
        Self {
            crashes: own.join("crashes"),
            data,
            own,
            logs,
        }
    }

    /// Everything under one folder: tests, and isolated runs that must not
    /// touch the real folders. `own` is `data`, as in a development build.
    pub fn under(root: &Path) -> Self {
        Self {
            data: root.join("data"),
            own: root.join("data"),
            logs: root.join("logs"),
            crashes: root.join("crashes"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{DEVELOPMENT, RELEASE};

    fn at(identity: &Identity, root: &Path) -> AppDirs {
        AppDirs::layout(
            identity,
            identity.bundle_id,
            &root.join("local"),
            &root.join("Logs"),
        )
    }

    #[test]
    fn each_identity_has_its_own_folders_named_by_bundle_id() {
        let root = Path::new("/r");
        let development = at(&DEVELOPMENT, root);
        let release = at(&RELEASE, root);
        for (dirs, id) in [
            (&development, DEVELOPMENT.bundle_id),
            (&release, RELEASE.bundle_id),
        ] {
            assert_eq!(dirs.data.file_name().unwrap(), id);
            assert!(dirs.crashes.starts_with(&dirs.own));
            assert!(dirs.logs.iter().any(|part| part == id || part == "logs"));
        }
        assert_ne!(development.data, release.data);
        assert_ne!(development.own, release.own);
        assert_ne!(development.logs, release.logs);
    }

    #[test]
    fn a_development_build_keeps_everything_in_its_own_data_folder() {
        let dirs = at(&DEVELOPMENT, Path::new("/r"));
        assert_eq!(dirs.own, dirs.data);
        assert_eq!(dirs.data, Path::new("/r/local/cc.drifting.next.dev"));
    }

    /// The 0.1 client's folder is `data`; the release identity's own files
    /// are beside it, never in it (its pre-registry library's root is
    /// `data`, and the import refuses a destination inside its source).
    #[test]
    fn the_release_identity_keeps_its_own_files_beside_the_0_1_folder() {
        let dirs = at(&RELEASE, Path::new("/r"));
        assert_eq!(dirs.data, Path::new("/r/local/cc.drifting.client"));
        assert_eq!(dirs.own, Path::new("/r/local/cc.drifting.client.v2"));
        for own in [&dirs.own, &dirs.crashes] {
            assert!(!own.starts_with(&dirs.data), "{own:?}");
            assert!(!dirs.data.starts_with(own), "{own:?}");
        }
        if cfg!(target_os = "macos") {
            assert_eq!(dirs.logs, Path::new("/r/Logs/cc.drifting.client"));
        } else {
            assert_eq!(dirs.logs, dirs.own.join("logs"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_logs_follow_the_library_logs_convention() {
        let dirs = AppDirs::for_identity(&DEVELOPMENT).unwrap();
        let name = DEVELOPMENT.instance_name();
        assert!(dirs.logs.ends_with(format!("Library/Logs/{name}")));
        assert!(
            dirs.data
                .ends_with(format!("Library/Application Support/{name}"))
        );
    }
}
