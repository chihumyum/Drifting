//! Automatic updates from GitHub Releases, signed with the 0.1 client's
//! minisign key.
//!
//! One check is three steps, each its own call so the UI (F6, M42) decides
//! when they happen: [`Updater::check`] reads the manifest, [`Updater::download`]
//! streams the artifact to a file and verifies its signature, and the
//! [`Downloaded`] update installs ([`Downloaded::replace_bundle`] on macOS,
//! [`Downloaded::installer_launch`] on Windows). Nothing here schedules
//! checks, flushes the library or relaunches; that is the app's job.
//!
//! The manifests (see the F7 doc's hand-over section):
//!
//! - [`RELEASE_ENDPOINT`], `update.json`: the GPUI line. This client and the
//!   last Tauri release poll it.
//! - [`LEGACY_ENDPOINT`], `latest.json`: what every earlier Tauri release
//!   polls. Once the last Tauri release is out it always offers that release,
//!   so no library skips the hand-over.

pub mod fetch;
pub mod install;
pub mod manifest;
pub mod signature;

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use semver::Version;

use crate::identity::Identity;
pub use fetch::{Fetch, FetchError, LocalFetch, Progress};
pub use install::{InstallError, InstallerLaunch};
pub use manifest::{Artifact, Manifest, ManifestError, Target, UrlPolicy};
pub use signature::{SignatureError, UpdaterKey};

/// The GPUI line's manifest.
pub const RELEASE_ENDPOINT: &str =
    "https://github.com/chihumyum/Drifting/releases/latest/download/update.json";
/// The manifest every 0.1 Tauri client before the last one polls.
pub const LEGACY_ENDPOINT: &str =
    "https://github.com/chihumyum/Drifting/releases/latest/download/latest.json";

/// How often the 0.1 client checked while open; the scheduler (F6/M42) uses it.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(3 * 60 * 60);

/// Development builds only: a manifest URL or path, and the public key its
/// artifacts are signed with, for trying the whole flow against local files.
pub const DEV_MANIFEST_ENV: &str = "DRIFTING_DEV_UPDATE_MANIFEST";
pub const DEV_PUBLIC_KEY_ENV: &str = "DRIFTING_DEV_UPDATER_PUBLIC_KEY";

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("updates are unavailable: {0}")]
    Unavailable(&'static str),
    #[error(transparent)]
    Fetch(#[from] FetchError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error(transparent)]
    Signature(#[from] SignatureError),
    #[error(transparent)]
    Install(#[from] InstallError),
    #[error("could not write the download: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug)]
pub struct UpdaterConfig {
    pub manifest_url: String,
    pub public_key: String,
    pub current_version: Version,
    pub target: Target,
    pub url_policy: UrlPolicy,
    /// The bundle id an installed update must carry.
    pub bundle_id: String,
}

impl UpdaterConfig {
    /// What this build updates from. A release build needs the compiled-in
    /// public key; a development build only updates when both development
    /// variables are set, and then may read local files.
    pub fn for_build(identity: &Identity, current_version: &str) -> Result<Self, UpdateError> {
        let current_version = Version::parse(current_version)
            .map_err(|_| UpdateError::Unavailable("this build's version is not SemVer"))?;
        let target =
            Target::current().ok_or(UpdateError::Unavailable("this platform has no updates"))?;
        let (manifest_url, public_key, url_policy) = if identity.is_release() {
            let key = signature::compiled_in_key().ok_or(UpdateError::Unavailable(
                "this build has no updater public key",
            ))?;
            (
                RELEASE_ENDPOINT.to_owned(),
                key.to_owned(),
                UrlPolicy::Https,
            )
        } else {
            let manifest = std::env::var(DEV_MANIFEST_ENV)
                .ok()
                .filter(|v| !v.is_empty());
            let key = std::env::var(DEV_PUBLIC_KEY_ENV)
                .ok()
                .filter(|v| !v.is_empty());
            match (manifest, key) {
                (Some(manifest), Some(key)) => (manifest, key, UrlPolicy::AllowLocal),
                _ => {
                    return Err(UpdateError::Unavailable(
                        "development builds update only from a local test manifest",
                    ));
                }
            }
        };
        Ok(Self {
            manifest_url,
            public_key,
            current_version,
            target,
            url_policy,
            bundle_id: identity.bundle_id.to_owned(),
        })
    }
}

/// A newer version the manifest offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Available {
    pub version: Version,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    artifact: Artifact,
}

/// A downloaded artifact whose signature checked out.
#[derive(Debug)]
pub struct Downloaded {
    pub version: Version,
    pub path: PathBuf,
    bundle_id: String,
}

pub struct Updater<F> {
    config: UpdaterConfig,
    key: UpdaterKey,
    fetch: F,
}

impl<F: Fetch> Updater<F> {
    pub fn new(config: UpdaterConfig, fetch: F) -> Result<Self, UpdateError> {
        let key = UpdaterKey::parse(&config.public_key)?;
        Ok(Self { config, key, fetch })
    }

    pub fn config(&self) -> &UpdaterConfig {
        &self.config
    }

    pub fn check(&self) -> Result<Option<Available>, UpdateError> {
        let bytes = self
            .fetch
            .get(&self.config.manifest_url, manifest::MAX_MANIFEST_BYTES)?;
        let manifest = Manifest::parse(&bytes)?;
        if !manifest.is_newer_than(&self.config.current_version) {
            return Ok(None);
        }
        let artifact = manifest
            .artifact(&self.config.target, self.config.url_policy)?
            .clone();
        Ok(Some(Available {
            version: manifest.version,
            notes: manifest.notes,
            published_at: manifest.published_at,
            artifact,
        }))
    }

    /// Streams the artifact into `directory` and verifies it. A failed or
    /// unverified download leaves no file behind.
    pub fn download(
        &self,
        update: &Available,
        directory: &Path,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<Downloaded, UpdateError> {
        std::fs::create_dir_all(directory)?;
        let path = directory.join(artifact_file_name(&update.version, &self.config.target));
        let partial = path.with_extension("partial");
        let result = (|| {
            let mut file = std::fs::File::create(&partial)?;
            self.fetch.download(
                &update.artifact.url,
                &mut file,
                fetch::MAX_ARTIFACT_BYTES,
                progress,
            )?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            self.key.verify_file(&partial, &update.artifact.signature)?;
            std::fs::rename(&partial, &path)?;
            Ok::<_, UpdateError>(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        Ok(Downloaded {
            version: update.version.clone(),
            path,
            bundle_id: self.config.bundle_id.clone(),
        })
    }
}

fn artifact_file_name(version: &Version, target: &Target) -> String {
    match target.os {
        "windows" => format!("Drifting_{version}_{}-setup.exe", target.arch),
        _ => format!("Drifting_{version}_{}.app.tar.gz", target.arch),
    }
}

impl Downloaded {
    /// macOS: swap the running bundle for the update. The app then relaunches
    /// through Launch Services after it quits (`open -n <bundle>`, as the 0.1
    /// client's `macos_relaunch.rs`).
    pub fn replace_bundle(&self, bundle: &Path) -> Result<(), UpdateError> {
        install::replace_bundle(&self.path, bundle, &self.bundle_id)?;
        let _ = std::fs::remove_file(&self.path);
        Ok(())
    }

    /// Windows: the installer to start before quitting.
    pub fn installer_launch(&self, relaunch_args: &[OsString]) -> InstallerLaunch {
        install::installer_launch(&self.path, relaunch_args)
    }
}

/// The `.app` this process runs from, when it does.
pub fn running_bundle() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    install::bundle_of(&executable).map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::install::tests::{archive_of, write_app};
    use super::signature::test_keys::TestKey;
    use super::*;

    struct Release {
        _dir: tempfile::TempDir,
        manifest_url: String,
        key: TestKey,
    }

    /// A local "release": an app archive, its signature, and a manifest
    /// pointing at it with `file://` URLs. Nothing leaves the temp folder.
    fn local_release(version: &str, bundle_id: &str, tamper: bool) -> Release {
        let dir = tempfile::tempdir().unwrap();
        let built = dir.path().join("build");
        std::fs::create_dir(&built).unwrap();
        let app = write_app(&built, bundle_id, &format!("v{version}"));
        let archive = dir.path().join("Drifting.app.tar.gz");
        archive_of(&app, &archive);
        let key = TestKey::generate();
        let signature = key.sign(&std::fs::read(&archive).unwrap());
        if tamper {
            let mut bytes = std::fs::read(&archive).unwrap();
            let last = bytes.len() - 1;
            bytes[last] ^= 0xff;
            std::fs::write(&archive, bytes).unwrap();
        }
        let target = Target::current().unwrap().key();
        let manifest = serde_json::json!({
            "version": version,
            "notes": "合成的测试版本",
            "pub_date": "2026-11-07T00:00:00Z",
            "platforms": { target: { "signature": signature, "url": format!("file://{}", archive.display()) } }
        });
        let manifest_path = dir.path().join("update.json");
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        Release {
            manifest_url: format!("file://{}", manifest_path.display()),
            _dir: dir,
            key,
        }
    }

    fn updater(release: &Release, current: &str, bundle_id: &str) -> Updater<LocalFetch> {
        Updater::new(
            UpdaterConfig {
                manifest_url: release.manifest_url.clone(),
                public_key: release.key.public_key(),
                current_version: Version::parse(current).unwrap(),
                target: Target::current().unwrap(),
                url_policy: UrlPolicy::AllowLocal,
                bundle_id: bundle_id.into(),
            },
            LocalFetch,
        )
        .unwrap()
    }

    #[test]
    fn checks_downloads_verifies_and_installs_end_to_end() {
        let release = local_release("0.2.1", "cc.drifting.next.dev", false);
        let updater = updater(&release, "0.2.0", "cc.drifting.next.dev");
        let available = updater.check().unwrap().expect("0.2.1 is newer");
        assert_eq!(available.version, Version::parse("0.2.1").unwrap());
        assert_eq!(available.notes.as_deref(), Some("合成的测试版本"));

        let downloads = tempfile::tempdir().unwrap();
        let mut seen = 0;
        let downloaded = updater
            .download(&available, downloads.path(), &mut |p| seen = p.received)
            .unwrap();
        assert!(seen > 0);
        assert!(downloaded.path.is_file());

        let applications = tempfile::tempdir().unwrap();
        let installed = write_app(applications.path(), "cc.drifting.next.dev", "v0.2.0");
        downloaded.replace_bundle(&installed).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/drifting")).unwrap(),
            "v0.2.1"
        );
        assert!(!downloaded.path.exists());
    }

    #[test]
    fn the_same_or_an_older_version_is_not_offered() {
        let release = local_release("0.2.0", "cc.drifting.next.dev", false);
        assert_eq!(
            updater(&release, "0.2.0", "cc.drifting.next.dev")
                .check()
                .unwrap(),
            None
        );
        assert_eq!(
            updater(&release, "0.3.0", "cc.drifting.next.dev")
                .check()
                .unwrap(),
            None
        );
    }

    #[test]
    fn a_tampered_artifact_is_refused_and_removed() {
        let release = local_release("0.2.1", "cc.drifting.next.dev", true);
        let updater = updater(&release, "0.2.0", "cc.drifting.next.dev");
        let available = updater.check().unwrap().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        assert!(matches!(
            updater.download(&available, downloads.path(), &mut |_| {}),
            Err(UpdateError::Signature(SignatureError::Invalid))
        ));
        assert_eq!(std::fs::read_dir(downloads.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_manifest_signed_by_another_key_is_refused() {
        let release = local_release("0.2.1", "cc.drifting.next.dev", false);
        let mut config = updater(&release, "0.2.0", "cc.drifting.next.dev")
            .config
            .clone();
        config.public_key = TestKey::generate().public_key();
        let updater = Updater::new(config, LocalFetch).unwrap();
        let available = updater.check().unwrap().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        assert!(matches!(
            updater.download(&available, downloads.path(), &mut |_| {}),
            Err(UpdateError::Signature(SignatureError::WrongKey))
        ));
    }

    #[test]
    fn a_signed_archive_of_another_app_does_not_install() {
        let release = local_release("0.2.1", "com.example.other", false);
        let updater = updater(&release, "0.2.0", "cc.drifting.next.dev");
        let available = updater.check().unwrap().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let downloaded = updater
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap();
        let applications = tempfile::tempdir().unwrap();
        let installed = write_app(applications.path(), "cc.drifting.next.dev", "v0.2.0");
        assert!(matches!(
            downloaded.replace_bundle(&installed),
            Err(UpdateError::Install(InstallError::WrongApp { .. }))
        ));
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/drifting")).unwrap(),
            "v0.2.0"
        );
    }

    #[test]
    fn release_builds_poll_the_new_manifest_and_development_builds_nothing_by_default() {
        assert!(
            RELEASE_ENDPOINT
                .starts_with("https://github.com/chihumyum/Drifting/releases/latest/download/")
        );
        assert_ne!(RELEASE_ENDPOINT, LEGACY_ENDPOINT);
        if std::env::var_os(DEV_MANIFEST_ENV).is_none() {
            assert!(matches!(
                UpdaterConfig::for_build(&crate::identity::DEVELOPMENT, "0.2.0-dev"),
                Err(UpdateError::Unavailable(_))
            ));
        }
        // A build without the compiled-in key (every local and CI build)
        // cannot update even under the release identity.
        if signature::compiled_in_key().is_none() {
            assert!(matches!(
                UpdaterConfig::for_build(&crate::identity::RELEASE, "0.2.0"),
                Err(UpdateError::Unavailable(_))
            ));
        }
    }

    #[test]
    fn artifacts_are_named_like_the_release_files() {
        let version = Version::parse("0.2.0").unwrap();
        let mac = Target {
            os: "darwin",
            arch: "aarch64",
            bundle: "app",
        };
        let windows = Target {
            os: "windows",
            arch: "x86_64",
            bundle: "nsis",
        };
        assert_eq!(
            artifact_file_name(&version, &mac),
            "Drifting_0.2.0_aarch64.app.tar.gz"
        );
        assert_eq!(
            artifact_file_name(&version, &windows),
            "Drifting_0.2.0_x86_64-setup.exe"
        );
    }
}
