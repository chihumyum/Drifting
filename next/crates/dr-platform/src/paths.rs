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
//!
//! On Windows the program itself is installed in `%LOCALAPPDATA%\<product
//! name>` (`%LOCALAPPDATA%\Drifting` for the release identity, where the 0.1
//! Tauri installer put it), beside these folders and never holding them, so
//! the uninstaller, which removes only its own files, never reaches a book.
//! [`Layout`] lets tests check both systems' rules on either.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};

use crate::identity::Identity;

/// The release identity's own folder is `<bundle id>.<RELEASE_OWN_SUFFIX>`
/// beside the 0.1 client's `<bundle id>`. Published with 0.2.0: never rename.
pub const RELEASE_OWN_SUFFIX: &str = "v2";

/// Which system's folder rules: macOS, or Windows (which every other system
/// follows too: everything under the local data folder).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    MacOs,
    Windows,
}

impl Layout {
    /// The rules of the system this build runs on.
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Layout::MacOs
        } else {
            Layout::Windows
        }
    }
}

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
        Self::for_layout_at(Layout::current(), identity, local_data, log_root)
    }

    /// [`Self::for_identity_at`] by `layout`'s rules instead of this
    /// system's: tests of the other system's folders.
    pub fn for_layout_at(
        layout: Layout,
        identity: &Identity,
        local_data: &Path,
        log_root: &Path,
    ) -> Self {
        Self::layout(
            layout,
            identity,
            &identity.instance_name(),
            local_data,
            log_root,
        )
    }

    fn layout(
        layout: Layout,
        identity: &Identity,
        name: &str,
        local_data: &Path,
        log_root: &Path,
    ) -> Self {
        let data = local_data.join(name);
        let own = if identity.is_release() {
            local_data.join(format!("{name}.{RELEASE_OWN_SUFFIX}"))
        } else {
            data.clone()
        };
        let logs = match layout {
            Layout::MacOs => log_root.join(name),
            Layout::Windows => own.join("logs"),
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

    /// The system folders of a made-up account, per layout: the local data
    /// folder and macOS's log root.
    fn roots(layout: Layout) -> (PathBuf, PathBuf) {
        match layout {
            Layout::MacOs => (
                PathBuf::from("/Users/example/Library/Application Support"),
                PathBuf::from("/Users/example/Library/Logs"),
            ),
            Layout::Windows => (
                Path::new("C:").join("Users/example/AppData/Local"),
                PathBuf::new(),
            ),
        }
    }

    fn at(layout: Layout, identity: &Identity) -> AppDirs {
        let (local, logs) = roots(layout);
        AppDirs::layout(layout, identity, identity.bundle_id, &local, &logs)
    }

    const LAYOUTS: [Layout; 2] = [Layout::MacOs, Layout::Windows];

    #[test]
    fn the_layout_is_this_systems() {
        assert_eq!(
            Layout::current() == Layout::MacOs,
            cfg!(target_os = "macos")
        );
    }

    #[test]
    fn each_identity_has_its_own_folders_named_by_bundle_id() {
        for layout in LAYOUTS {
            let development = at(layout, &DEVELOPMENT);
            let release = at(layout, &RELEASE);
            for (dirs, id) in [
                (&development, DEVELOPMENT.bundle_id),
                (&release, RELEASE.bundle_id),
            ] {
                assert_eq!(dirs.data.file_name().unwrap(), id, "{layout:?}");
                assert!(dirs.crashes.starts_with(&dirs.own), "{layout:?}");
            }
            assert_ne!(development.data, release.data);
            assert_ne!(development.own, release.own);
            assert_ne!(development.logs, release.logs);
        }
    }

    #[test]
    fn a_development_build_keeps_everything_in_its_own_data_folder() {
        for layout in LAYOUTS {
            let (local, _) = roots(layout);
            let dirs = at(layout, &DEVELOPMENT);
            assert_eq!(dirs.own, dirs.data, "{layout:?}");
            assert_eq!(dirs.data, local.join("cc.drifting.next.dev"));
        }
    }

    /// The 0.1 client's folder is `data` (Tauri's `app_local_data_dir`:
    /// `~/Library/Application Support/cc.drifting.client`,
    /// `%LOCALAPPDATA%\cc.drifting.client`); the release identity's own files
    /// are beside it, never in it (its pre-registry library's root is
    /// `data`, and the import refuses a destination inside its source).
    #[test]
    fn the_release_identity_keeps_its_own_files_beside_the_0_1_folder() {
        for layout in LAYOUTS {
            let (local, log_root) = roots(layout);
            let dirs = at(layout, &RELEASE);
            assert_eq!(dirs.data, local.join("cc.drifting.client"), "{layout:?}");
            assert_eq!(dirs.own, local.join("cc.drifting.client.v2"));
            for own in [&dirs.own, &dirs.crashes, &dirs.logs] {
                assert!(!own.starts_with(&dirs.data), "{layout:?} {own:?}");
                assert!(!dirs.data.starts_with(own), "{layout:?} {own:?}");
            }
            match layout {
                Layout::MacOs => assert_eq!(dirs.logs, log_root.join("cc.drifting.client")),
                Layout::Windows => assert_eq!(dirs.logs, local.join("cc.drifting.client.v2/logs")),
            }
        }
    }

    /// Windows: the installer puts the program in `%LOCALAPPDATA%\<product
    /// name>` (`Drifting`, the 0.1 Tauri installer's folder) and its
    /// uninstaller removes only its own files there; no data folder is in it
    /// or holds it.
    #[test]
    fn windows_keeps_the_program_and_the_data_apart() {
        let (local, _) = roots(Layout::Windows);
        for identity in [&DEVELOPMENT, &RELEASE] {
            let install = local.join(identity.product_name);
            let dirs = at(Layout::Windows, identity);
            for folder in [&dirs.data, &dirs.own, &dirs.logs, &dirs.crashes] {
                assert!(!folder.starts_with(&install), "{folder:?}");
                assert!(!install.starts_with(folder), "{folder:?}");
            }
        }
        assert_eq!(
            local.join(RELEASE.product_name),
            local.join("Drifting"),
            "the 0.1 install folder"
        );
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
