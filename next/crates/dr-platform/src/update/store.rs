//! The updates folder (`<data>/updates`): the verified download waiting for
//! the next quit, and two notes the quitting app leaves for the next launch,
//! which are read once and deleted:
//!
//! - `installed.json`: the version the quit installed and its notes, so the
//!   new version can say 「已更新到 Drifting …」 (0.1's
//!   `drifting.updater.installed.v1`). Read only by that version: when the
//!   Windows installer did not finish, the app that starts is still the old
//!   one and the note is dropped.
//! - `install-failed.json`: the version a quit could not install and why
//!   (the app's folder not writable, say), so the next launch can tell the
//!   author. Dropped once that version or a later one is running.
//!
//! Nothing here holds prose or paths of the author's; the folder is the
//! app's own.

use std::path::{Path, PathBuf};

use semver::Version;
use serde::{Deserialize, Serialize};

use super::{Downloaded, Problem};

const INSTALLED: &str = "installed.json";
const INSTALL_FAILED: &str = "install-failed.json";

/// An update the last quit installed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installed {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
}

/// An update the last quit could not install.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallFailure {
    pub version: String,
    pub problem: Problem,
}

#[derive(Clone, Debug)]
pub struct Downloads {
    dir: PathBuf,
}

impl Downloads {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// `<data>/updates`.
    pub fn in_data(data: &Path) -> Self {
        Self::new(data.join("updates"))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Deletes what no launch will use: unfinished downloads (`.partial`, a
    /// crash mid-download) and artifacts of `current` or older (installed,
    /// or overtaken). The notes stay for [`Self::take_installed`] and
    /// [`Self::take_failure`].
    pub fn clean(&self, current: &Version) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stale = name.ends_with(".partial")
                || artifact_version(&name).is_some_and(|version| version <= *current);
            if stale && let Err(error) = std::fs::remove_file(entry.path()) {
                log::warn!("updates: could not delete {name}: {error}");
            }
        }
    }

    /// Deletes every artifact except `keep` (a newer download replaced an
    /// older one that was waiting).
    pub fn keep_only(&self, keep: &Path) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path != keep && artifact_version(&name).is_some() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    pub fn record_installed(&self, update: &Downloaded) -> std::io::Result<()> {
        self.write(
            INSTALLED,
            &Installed {
                version: update.version.to_string(),
                notes: update.notes.clone(),
            },
        )
    }

    /// The update the last quit installed, when `current` is that version.
    /// Read once.
    pub fn take_installed(&self, current: &Version) -> Option<Installed> {
        let installed: Installed = self.take(INSTALLED)?;
        (Version::parse(&installed.version).ok()? == *current).then_some(installed)
    }

    pub fn record_failure(&self, version: &Version, problem: Problem) -> std::io::Result<()> {
        self.write(
            INSTALL_FAILED,
            &InstallFailure {
                version: version.to_string(),
                problem,
            },
        )
    }

    /// What the last quit could not install, while that version is still
    /// newer than `current`. Read once.
    pub fn take_failure(&self, current: &Version) -> Option<InstallFailure> {
        let failure: InstallFailure = self.take(INSTALL_FAILED)?;
        (Version::parse(&failure.version).ok()? > *current).then_some(failure)
    }

    fn write(&self, name: &str, value: &impl Serialize) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(name);
        let partial = path.with_extension("json.tmp");
        std::fs::write(&partial, serde_json::to_vec(value)?)?;
        std::fs::rename(partial, path)
    }

    fn take<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Option<T> {
        let path = self.dir.join(name);
        let bytes = std::fs::read(&path).ok()?;
        let _ = std::fs::remove_file(&path);
        serde_json::from_slice(&bytes).ok()
    }
}

/// The version in a release file's name (`Drifting_0.2.1_aarch64.app.tar.gz`,
/// `Drifting_0.2.1_x86_64-setup.exe`): the first `_`-separated part that is
/// SemVer.
fn artifact_version(name: &str) -> Option<Version> {
    if !(name.ends_with(".app.tar.gz") || name.ends_with("-setup.exe")) {
        return None;
    }
    name.split('_').find_map(|part| Version::parse(part).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn cleaning_keeps_only_newer_finished_downloads() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "Drifting_0.2.0_aarch64.app.tar.gz",
            "Drifting_0.2.1_aarch64.app.tar.gz",
            "Drifting_0.2.2_aarch64.app.partial",
            "Drifting_0.2.3_x86_64-setup.exe",
            "installed.json",
        ] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        let downloads = Downloads::new(dir.path());
        downloads.clean(&v("0.2.1"));
        assert_eq!(
            names(dir.path()),
            ["Drifting_0.2.3_x86_64-setup.exe", "installed.json"]
        );
        downloads.keep_only(&dir.path().join("nothing"));
        assert_eq!(names(dir.path()), ["installed.json"]);
        // No folder yet: nothing to do.
        Downloads::new(dir.path().join("missing")).clean(&v("0.2.1"));
    }

    #[test]
    fn the_notes_are_read_once_and_only_by_the_version_they_are_about() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = Downloads::in_data(dir.path());
        let update = Downloaded {
            version: v("0.2.1"),
            notes: Some("修好了大纲".into()),
            path: dir.path().join("x"),
            bundle_id: "cc.drifting.next.dev".into(),
        };
        downloads.record_installed(&update).unwrap();
        assert_eq!(
            downloads.take_installed(&v("0.2.1")),
            Some(Installed {
                version: "0.2.1".into(),
                notes: Some("修好了大纲".into())
            })
        );
        assert_eq!(downloads.take_installed(&v("0.2.1")), None);
        // The installer did not finish: the old version starts, and drops it.
        downloads.record_installed(&update).unwrap();
        assert_eq!(downloads.take_installed(&v("0.2.0")), None);
        assert_eq!(downloads.take_installed(&v("0.2.1")), None);

        downloads
            .record_failure(&v("0.2.1"), Problem::NeedsAdmin)
            .unwrap();
        assert_eq!(
            downloads.take_failure(&v("0.2.0")),
            Some(InstallFailure {
                version: "0.2.1".into(),
                problem: Problem::NeedsAdmin
            })
        );
        assert_eq!(downloads.take_failure(&v("0.2.0")), None);
        downloads
            .record_failure(&v("0.2.1"), Problem::NeedsAdmin)
            .unwrap();
        assert_eq!(downloads.take_failure(&v("0.2.1")), None);
        assert_eq!(names(&dir.path().join("updates")), Vec::<String>::new());
    }
}
