//! Automatic updates from GitHub Releases, signed with the 0.1 client's
//! minisign key.
//!
//! One check is three steps, each its own call so the UI (M42,
//! `dr-view-update`) decides when they happen: [`Updater::check`] reads the
//! manifest, [`Updater::download`] streams the artifact to a file and
//! verifies its signature, and the [`Downloaded`] update installs
//! ([`Downloaded::replace_bundle`] on macOS, [`Downloaded::installer_launch`]
//! on Windows). Nothing here schedules checks or flushes the library; the
//! app reopens itself with [`crate::relaunch`].
//!
//! What is refused, and how the UI tells them apart ([`UpdateError::problem`]):
//!
//! - a bad signature, or one by another key ([`Problem::Signature`]);
//! - a signature that does not name the offered version, or a bundle whose
//!   own version is not it: an older signed release offered under a newer
//!   number ([`Problem::Version`]); a manifest offering the running version
//!   or an older one is [`Offer::Current`] / [`Offer::Older`], never
//!   downloaded;
//! - a download that broke off, stalled or came up short
//!   ([`Problem::Interrupted`]); nothing of it is kept;
//! - no connection ([`Problem::Offline`]) or a server error
//!   ([`Problem::Server`]).
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
pub mod store;

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use semver::Version;

use crate::identity::Identity;
pub use fetch::{Fetch, FetchError, LocalFetch, Progress, UpdateFetch};
pub use install::{InstallError, InstallerLaunch};
pub use manifest::{Artifact, Manifest, ManifestError, Target, UrlPolicy};
pub use signature::{SignatureError, UpdaterKey, Verified};
pub use store::{Downloads, InstallFailure};

/// The GPUI line's manifest.
pub const RELEASE_ENDPOINT: &str =
    "https://github.com/chihumyum/Drifting/releases/latest/download/update.json";
/// The manifest every 0.1 Tauri client before the last one polls.
pub const LEGACY_ENDPOINT: &str =
    "https://github.com/chihumyum/Drifting/releases/latest/download/latest.json";

/// How often the 0.1 client checked while open; the scheduler (F6/M42) uses it.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(3 * 60 * 60);

/// Development builds only: a manifest URL or path (a local file, or a test
/// server on this machine), and the public key its artifacts are signed
/// with, for trying the whole flow without a release.
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
    /// The signature is good but names another version's file: an older
    /// signed release offered under a newer number.
    #[error("the update offered as {offered} was signed as {signed:?}")]
    VersionMismatch { offered: Version, signed: String },
    #[error("could not write the download: {0}")]
    Io(#[from] std::io::Error),
}

/// What went wrong, in the terms the author is told.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Problem {
    /// This build cannot update (no key, no test manifest, no platform).
    Unavailable,
    /// The update server could not be reached.
    Offline,
    /// The server answered with an error, or a manifest that is not one.
    Server,
    /// The download broke off, stalled or came up short; it was deleted.
    Interrupted,
    /// The download does not match its signature, or another key signed it.
    Signature,
    /// The signed file or the bundle is another version than the one offered.
    Version,
    /// The update is a different app.
    WrongApp,
    /// The app's folder is not writable by this user.
    NeedsAdmin,
    /// Writing on this machine failed, or the archive is malformed.
    Local,
}

impl UpdateError {
    pub fn problem(&self) -> Problem {
        match self {
            UpdateError::Unavailable(_) => Problem::Unavailable,
            UpdateError::Fetch(error) => match error {
                FetchError::Network(_) => Problem::Offline,
                FetchError::Status(_) | FetchError::Url(_) | FetchError::TooLarge(_) => {
                    Problem::Server
                }
                FetchError::Interrupted(_) | FetchError::Incomplete { .. } => Problem::Interrupted,
                FetchError::Io(_) => Problem::Local,
            },
            UpdateError::Manifest(_) => Problem::Server,
            UpdateError::Signature(SignatureError::Io(_)) => Problem::Local,
            UpdateError::Signature(_) => Problem::Signature,
            UpdateError::VersionMismatch { .. } => Problem::Version,
            UpdateError::Install(error) => match error {
                InstallError::WrongApp { .. } => Problem::WrongApp,
                InstallError::WrongVersion { .. } => Problem::Version,
                InstallError::NeedsAuthorization => Problem::NeedsAdmin,
                InstallError::Archive(_) | InstallError::Io(_) => Problem::Local,
            },
            UpdateError::Io(_) => Problem::Local,
        }
    }
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

/// What a check found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Offer {
    /// A newer version, with an artifact for this platform.
    Newer(Available),
    /// The version running now.
    Current,
    /// An older version than the one running: never installed.
    Older(Version),
}

/// A newer version the manifest offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Available {
    pub version: Version,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    artifact: Artifact,
}

/// A downloaded artifact whose signature checked out and names its version.
#[derive(Clone, Debug)]
pub struct Downloaded {
    pub version: Version,
    pub notes: Option<String>,
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

    pub fn check(&self) -> Result<Offer, UpdateError> {
        let bytes = self
            .fetch
            .get(&self.config.manifest_url, manifest::MAX_MANIFEST_BYTES)?;
        let manifest = Manifest::parse(&bytes)?;
        let current = &self.config.current_version;
        if manifest.version == *current {
            return Ok(Offer::Current);
        }
        if !manifest.is_newer_than(current) {
            return Ok(Offer::Older(manifest.version));
        }
        let artifact = manifest
            .artifact(&self.config.target, self.config.url_policy)?
            .clone();
        Ok(Offer::Newer(Available {
            version: manifest.version,
            notes: manifest.notes,
            published_at: manifest.published_at,
            artifact,
        }))
    }

    /// Streams the artifact into `directory` and verifies it. A failed or
    /// unverified download leaves no file behind. A file an earlier launch
    /// downloaded for the same version is kept when it still verifies
    /// against this manifest's signature, and not fetched again.
    pub fn download(
        &self,
        update: &Available,
        directory: &Path,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<Downloaded, UpdateError> {
        std::fs::create_dir_all(directory)?;
        let path = directory.join(artifact_file_name(&update.version, &self.config.target));
        let downloaded = Downloaded {
            version: update.version.clone(),
            notes: update.notes.clone(),
            path: path.clone(),
            bundle_id: self.config.bundle_id.clone(),
        };
        if path.is_file() {
            match self.verify(&path, update) {
                Ok(()) => return Ok(downloaded),
                Err(error) => {
                    log::info!("updates: dropping an earlier download: {error}");
                    std::fs::remove_file(&path)?;
                }
            }
        }
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
            self.verify(&partial, update)?;
            std::fs::rename(&partial, &path)?;
            Ok::<_, UpdateError>(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        Ok(downloaded)
    }

    /// The signature is good, and the file it names is the offered version's.
    fn verify(&self, path: &Path, update: &Available) -> Result<(), UpdateError> {
        let verified = self.key.verify_file(path, &update.artifact.signature)?;
        check_signed_version(&verified, &update.version)
    }
}

/// `tauri signer` and `update-tool sign` sign the file's name with it, and
/// release files are `<name>_<version>_<platform…>`: a signature that names
/// another version is an older (or other) release under this number.
fn check_signed_version(verified: &Verified, offered: &Version) -> Result<(), UpdateError> {
    let marker = format!("_{offered}_");
    match verified.signed_file() {
        Some(name) if name.contains(&marker) => Ok(()),
        signed => Err(UpdateError::VersionMismatch {
            offered: offered.clone(),
            signed: signed.unwrap_or_default().to_owned(),
        }),
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
        install::replace_bundle(&self.path, bundle, &self.bundle_id, Some(&self.version))?;
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
    use super::fetch::fake_server::{FakeServer, Serve, refused_base};
    use super::install::test_bundles::{archive_of, write_app};
    use super::signature::test_keys::TestKey;
    use super::*;

    const DEV: &str = "cc.drifting.next.dev";

    /// A synthetic release: an app archive at `bundle_version`, signed as
    /// the release file of `signed_as`, offered by a manifest as `offered`.
    struct Build<'a> {
        offered: &'a str,
        bundle_version: &'a str,
        signed_as: &'a str,
        bundle_id: &'a str,
        tamper: bool,
    }

    impl<'a> Build<'a> {
        fn of(version: &'a str) -> Self {
            Build {
                offered: version,
                bundle_version: version,
                signed_as: version,
                bundle_id: DEV,
                tamper: false,
            }
        }
    }

    struct Release {
        dir: tempfile::TempDir,
        archive: Vec<u8>,
        signature: String,
        key: TestKey,
        offered: String,
    }

    fn release(build: Build) -> Release {
        let dir = tempfile::tempdir().unwrap();
        let built = dir.path().join("build");
        std::fs::create_dir(&built).unwrap();
        let app = write_app(
            &built,
            build.bundle_id,
            &format!("v{}", build.bundle_version),
            build.bundle_version,
        );
        let path = dir.path().join("Drifting.app.tar.gz");
        archive_of(&app, &path);
        let key = TestKey::generate();
        let mut archive = std::fs::read(&path).unwrap();
        let signature = key.sign_as(
            &archive,
            &format!("Drifting_{}_aarch64.app.tar.gz", build.signed_as),
        );
        if build.tamper {
            let last = archive.len() - 1;
            archive[last] ^= 0xff;
        }
        std::fs::write(&path, &archive).unwrap();
        Release {
            dir,
            archive,
            signature,
            key,
            offered: build.offered.to_owned(),
        }
    }

    fn manifest_json(release: &Release, url: &str) -> String {
        let target = Target::current().unwrap().key();
        serde_json::json!({
            "version": release.offered,
            "notes": "合成的测试版本",
            "pub_date": "2026-11-07T00:00:00Z",
            "platforms": { target: { "signature": release.signature, "url": url } }
        })
        .to_string()
    }

    /// The release as `file://` URLs. Nothing leaves the temp folder.
    fn local_manifest(release: &Release) -> String {
        let archive = release.dir.path().join("Drifting.app.tar.gz");
        let manifest = manifest_json(release, &format!("file://{}", archive.display()));
        let path = release.dir.path().join("update.json");
        std::fs::write(&path, manifest).unwrap();
        format!("file://{}", path.display())
    }

    /// The release on a stand-in server on 127.0.0.1.
    fn served(release: &Release, server: &FakeServer, artifact: Serve) -> String {
        server.serve("/download/Drifting.app.tar.gz", artifact);
        server.serve(
            "/latest/update.json",
            Serve::Bytes(
                manifest_json(release, &server.url("/download/Drifting.app.tar.gz")).into_bytes(),
            ),
        );
        server.url("/latest/update.json")
    }

    fn updater(manifest_url: String, key: &TestKey, current: &str) -> Updater<UpdateFetch> {
        Updater::new(
            UpdaterConfig {
                manifest_url,
                public_key: key.public_key(),
                current_version: Version::parse(current).unwrap(),
                target: Target::current().unwrap(),
                url_policy: UrlPolicy::AllowLocal,
                bundle_id: DEV.into(),
            },
            UpdateFetch::new(
                UrlPolicy::AllowLocal,
                "Drifting test",
                std::time::Duration::from_millis(500),
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn newer(updater: &Updater<UpdateFetch>) -> Available {
        match updater.check().unwrap() {
            Offer::Newer(available) => available,
            other => panic!("expected a newer version, got {other:?}"),
        }
    }

    fn files_in(dir: &Path) -> usize {
        std::fs::read_dir(dir).map_or(0, |d| d.count())
    }

    #[test]
    fn checks_downloads_verifies_and_installs_end_to_end() {
        let release = release(Build::of("0.2.1"));
        let updater = updater(local_manifest(&release), &release.key, "0.2.0");
        let available = newer(&updater);
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
        let installed = write_app(applications.path(), DEV, "v0.2.0", "0.2.0");
        downloaded.replace_bundle(&installed).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/drifting")).unwrap(),
            "v0.2.1"
        );
        assert!(!downloaded.path.exists());
    }

    #[test]
    fn over_http_from_a_server_on_this_machine() {
        let release = release(Build::of("0.2.1"));
        let server = FakeServer::start();
        let manifest = served(&release, &server, Serve::Bytes(release.archive.clone()));
        let updater = updater(manifest, &release.key, "0.2.0");
        let available = newer(&updater);
        let downloads = tempfile::tempdir().unwrap();
        let mut last = None;
        let downloaded = updater
            .download(&available, downloads.path(), &mut |p| last = Some(p))
            .unwrap();
        let length = release.archive.len() as u64;
        assert_eq!(
            last,
            Some(Progress {
                received: length,
                total: Some(length)
            })
        );
        assert_eq!(std::fs::read(&downloaded.path).unwrap(), release.archive);

        // A second download of the same version (a relaunch before
        // installing) keeps the verified file and asks the server nothing.
        let asked = server.requests();
        let again = updater
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap();
        assert_eq!(again.path, downloaded.path);
        assert_eq!(server.requests(), asked);
        assert_eq!(files_in(downloads.path()), 1);
    }

    #[test]
    fn a_download_cut_short_is_refused_and_nothing_is_kept() {
        let release = release(Build::of("0.2.1"));
        let server = FakeServer::start();
        let sent = release.archive.len() / 2;
        let manifest = served(
            &release,
            &server,
            Serve::CutShort {
                body: release.archive.clone(),
                sent,
            },
        );
        let updater = updater(manifest, &release.key, "0.2.0");
        let available = newer(&updater);
        let downloads = tempfile::tempdir().unwrap();
        let error = updater
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap_err();
        assert_eq!(error.problem(), Problem::Interrupted, "{error}");
        assert_eq!(files_in(downloads.path()), 0);

        // A stale `.partial` an earlier crash left is overwritten, never
        // taken for the download.
        std::fs::write(
            downloads
                .path()
                .join(artifact_file_name(
                    &available.version,
                    &updater.config.target,
                ))
                .with_extension("partial"),
            &release.archive[..sent],
        )
        .unwrap();
        server.serve(
            "/download/Drifting.app.tar.gz",
            Serve::Bytes(release.archive.clone()),
        );
        let downloaded = updater
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap();
        assert_eq!(std::fs::read(&downloaded.path).unwrap(), release.archive);
        assert_eq!(files_in(downloads.path()), 1);
    }

    #[test]
    fn no_connection_and_server_errors_are_told_apart() {
        let release = release(Build::of("0.2.1"));
        let offline = updater(
            format!("{}/latest/update.json", refused_base()),
            &release.key,
            "0.2.0",
        );
        assert_eq!(offline.check().unwrap_err().problem(), Problem::Offline);

        let server = FakeServer::start();
        server.serve("/latest/update.json", Serve::Status(503));
        server.serve("/broken/update.json", Serve::Bytes(b"<html>".to_vec()));
        let failing = updater(server.url("/latest/update.json"), &release.key, "0.2.0");
        assert_eq!(failing.check().unwrap_err().problem(), Problem::Server);
        let broken = updater(server.url("/broken/update.json"), &release.key, "0.2.0");
        assert_eq!(broken.check().unwrap_err().problem(), Problem::Server);
    }

    #[test]
    fn the_same_or_an_older_version_is_not_offered() {
        let release = release(Build::of("0.2.0"));
        let manifest = local_manifest(&release);
        assert_eq!(
            updater(manifest.clone(), &release.key, "0.2.0")
                .check()
                .unwrap(),
            Offer::Current
        );
        assert_eq!(
            updater(manifest, &release.key, "0.3.0").check().unwrap(),
            Offer::Older(Version::parse("0.2.0").unwrap())
        );
    }

    #[test]
    fn a_tampered_artifact_is_refused_and_removed() {
        let release = release(Build {
            tamper: true,
            ..Build::of("0.2.1")
        });
        let updater = updater(local_manifest(&release), &release.key, "0.2.0");
        let available = newer(&updater);
        let downloads = tempfile::tempdir().unwrap();
        let error = updater
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap_err();
        assert!(matches!(
            error,
            UpdateError::Signature(SignatureError::Invalid)
        ));
        assert_eq!(error.problem(), Problem::Signature);
        assert_eq!(files_in(downloads.path()), 0);
    }

    #[test]
    fn an_artifact_signed_by_another_key_is_refused() {
        let release = release(Build::of("0.2.1"));
        let manifest = local_manifest(&release);
        let updater = updater(manifest, &TestKey::generate(), "0.2.0");
        let available = newer(&updater);
        let downloads = tempfile::tempdir().unwrap();
        let error = updater
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap_err();
        assert!(matches!(
            error,
            UpdateError::Signature(SignatureError::WrongKey)
        ));
        assert_eq!(files_in(downloads.path()), 0);
    }

    /// An older release, signed with the real key, offered under a newer
    /// number: the signature names its own version, so it is refused before
    /// it is kept; and a bundle whose own version differs is refused before
    /// it is installed.
    #[test]
    fn an_older_signed_release_offered_as_newer_is_refused() {
        let replayed = release(Build {
            offered: "0.2.2",
            bundle_version: "0.2.0",
            signed_as: "0.2.0",
            ..Build::of("0.2.2")
        });
        let updater_a = updater(local_manifest(&replayed), &replayed.key, "0.2.1");
        let available = newer(&updater_a);
        let downloads = tempfile::tempdir().unwrap();
        let error = updater_a
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap_err();
        assert!(
            matches!(error, UpdateError::VersionMismatch { .. }),
            "{error}"
        );
        assert_eq!(error.problem(), Problem::Version);
        assert_eq!(files_in(downloads.path()), 0);

        let relabelled = release(Build {
            offered: "0.2.2",
            bundle_version: "0.2.0",
            signed_as: "0.2.2",
            ..Build::of("0.2.2")
        });
        let updater_b = updater(local_manifest(&relabelled), &relabelled.key, "0.2.1");
        let available = newer(&updater_b);
        let downloaded = updater_b
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap();
        let applications = tempfile::tempdir().unwrap();
        let installed = write_app(applications.path(), DEV, "v0.2.1", "0.2.1");
        let error = downloaded.replace_bundle(&installed).unwrap_err();
        assert_eq!(error.problem(), Problem::Version, "{error}");
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/drifting")).unwrap(),
            "v0.2.1"
        );
    }

    #[test]
    fn a_signed_archive_of_another_app_does_not_install() {
        let release = release(Build {
            bundle_id: "com.example.other",
            ..Build::of("0.2.1")
        });
        let updater = updater(local_manifest(&release), &release.key, "0.2.0");
        let available = newer(&updater);
        let downloads = tempfile::tempdir().unwrap();
        let downloaded = updater
            .download(&available, downloads.path(), &mut |_| {})
            .unwrap();
        let applications = tempfile::tempdir().unwrap();
        let installed = write_app(applications.path(), DEV, "v0.2.0", "0.2.0");
        let error = downloaded.replace_bundle(&installed).unwrap_err();
        assert!(matches!(
            error,
            UpdateError::Install(InstallError::WrongApp { .. })
        ));
        assert_eq!(error.problem(), Problem::WrongApp);
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
