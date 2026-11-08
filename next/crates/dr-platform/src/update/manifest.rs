//! The updater manifest the 0.1 release workflow publishes
//! (`scripts/create-update-manifest.mjs`), which is Tauri's format:
//!
//! ```json
//! {
//!   "version": "0.1.0-alpha.10",
//!   "notes": "…",
//!   "pub_date": "2026-11-06T10:00:00.000Z",
//!   "platforms": {
//!     "darwin-aarch64": { "signature": "<base64 of the .sig file>", "url": "https://…/x.app.tar.gz" },
//!     "windows-x86_64": { "signature": "…", "url": "https://…/x-setup.exe" }
//!   }
//! }
//! ```
//!
//! Like Tauri, a `<os>-<arch>-<bundle>` key wins over `<os>-<arch>`.

use std::collections::BTreeMap;

use semver::Version;
use serde::Deserialize;

/// The most a manifest may be; the real one is a few kilobytes.
pub const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("the update manifest is not valid JSON: {0}")]
    Json(String),
    #[error("the update manifest's version {0:?} is not SemVer")]
    Version(String),
    #[error("the update manifest has no entry for {0}")]
    NoPlatform(String),
    #[error("the update artifact URL {0:?} is not allowed")]
    Url(String),
    #[error("the update manifest's signature for {0} is empty")]
    EmptySignature(String),
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    platforms: BTreeMap<String, RawPlatform>,
}

#[derive(Debug, Deserialize)]
struct RawPlatform {
    signature: String,
    url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub version: Version,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    platforms: BTreeMap<String, Artifact>,
}

/// One downloadable update for one platform.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub url: String,
    /// The `.sig` file's text as base64, as Tauri writes it.
    pub signature: String,
}

/// Which URLs an artifact may come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrlPolicy {
    /// HTTPS only: release builds.
    Https,
    /// HTTPS, plus `file://`, plain paths and plain HTTP to this machine
    /// (`127.0.0.1`, `localhost`, `[::1]`): local end-to-end tests and
    /// development builds pointed at a folder or a local test server.
    AllowLocal,
}

impl Manifest {
    pub fn parse(json: &[u8]) -> Result<Self, ManifestError> {
        let raw: RawManifest =
            serde_json::from_slice(json).map_err(|error| ManifestError::Json(error.to_string()))?;
        // Tauri's manifests sometimes carry a leading `v`.
        let version_text = raw.version.trim().trim_start_matches('v');
        let version = Version::parse(version_text)
            .map_err(|_| ManifestError::Version(raw.version.clone()))?;
        let platforms = raw
            .platforms
            .into_iter()
            .map(|(key, platform)| {
                (
                    key,
                    Artifact {
                        url: platform.url.trim().to_owned(),
                        signature: platform.signature.trim().to_owned(),
                    },
                )
            })
            .collect();
        Ok(Self {
            version,
            notes: raw.notes.filter(|notes| !notes.trim().is_empty()),
            published_at: raw.pub_date,
            platforms,
        })
    }

    /// The artifact for `target` (`darwin-aarch64`, …), preferring the
    /// bundle-specific key, after checking its URL and signature are usable.
    pub fn artifact(&self, target: &Target, policy: UrlPolicy) -> Result<&Artifact, ManifestError> {
        let specific = format!("{}-{}", target.key(), target.bundle);
        let artifact = self
            .platforms
            .get(&specific)
            .or_else(|| self.platforms.get(&target.key()))
            .ok_or_else(|| ManifestError::NoPlatform(target.key()))?;
        if artifact.signature.is_empty() {
            return Err(ManifestError::EmptySignature(target.key()));
        }
        check_url(&artifact.url, policy)?;
        Ok(artifact)
    }

    pub fn is_newer_than(&self, current: &Version) -> bool {
        &self.version > current
    }
}

fn check_url(url: &str, policy: UrlPolicy) -> Result<(), ManifestError> {
    let allowed = url.starts_with("https://")
        || (policy == UrlPolicy::AllowLocal
            && (url.starts_with("file://")
                || url.starts_with('/')
                || super::fetch::is_loopback_http(url)));
    if allowed && !url.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(ManifestError::Url(url.to_owned()))
    }
}

/// The updater's name for this platform, as Tauri spells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub os: &'static str,
    pub arch: &'static str,
    /// `app` (a `.app.tar.gz`) or `nsis` (a `-setup.exe`).
    pub bundle: &'static str,
}

impl Target {
    pub fn current() -> Option<Self> {
        let (os, bundle) = if cfg!(target_os = "macos") {
            ("darwin", "app")
        } else if cfg!(windows) {
            ("windows", "nsis")
        } else {
            return None;
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else if cfg!(target_arch = "x86_64") {
            "x86_64"
        } else {
            return None;
        };
        Some(Self { os, arch, bundle })
    }

    pub fn key(&self) -> String {
        format!("{}-{}", self.os, self.arch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: Target = Target {
        os: "darwin",
        arch: "aarch64",
        bundle: "app",
    };

    fn manifest(json: &str) -> Manifest {
        Manifest::parse(json.as_bytes()).unwrap()
    }

    #[test]
    fn reads_the_manifest_the_release_workflow_writes() {
        let manifest = manifest(
            r#"{
              "version": "0.1.0-alpha.10",
              "notes": "修复\n\nFixes",
              "pub_date": "2026-11-06T10:00:00.000Z",
              "platforms": {
                "darwin-aarch64": { "signature": "c2ln", "url": "https://github.com/o/r/releases/download/v0.1.0-alpha.10/Drifting.app.tar.gz" },
                "windows-x86_64": { "signature": "c2ln", "url": "https://github.com/o/r/releases/download/v0.1.0-alpha.10/Drifting_0.1.0-alpha.10_windows_x64-setup.exe" }
              }
            }"#,
        );
        assert_eq!(manifest.version, Version::parse("0.1.0-alpha.10").unwrap());
        assert_eq!(manifest.notes.as_deref(), Some("修复\n\nFixes"));
        let artifact = manifest.artifact(&MAC, UrlPolicy::Https).unwrap();
        assert!(artifact.url.ends_with(".app.tar.gz"));
        assert!(manifest.is_newer_than(&Version::parse("0.1.0-alpha.9").unwrap()));
        assert!(!manifest.is_newer_than(&Version::parse("0.1.0-alpha.10").unwrap()));
        assert!(!manifest.is_newer_than(&Version::parse("0.2.0").unwrap()));
    }

    #[test]
    fn prerelease_ordering_is_semver() {
        let alpha = manifest(r#"{"version":"v0.2.0-alpha.2","platforms":{}}"#);
        assert!(alpha.is_newer_than(&Version::parse("0.2.0-alpha.1").unwrap()));
        assert!(alpha.is_newer_than(&Version::parse("0.1.0-alpha.10").unwrap()));
        assert!(!alpha.is_newer_than(&Version::parse("0.2.0").unwrap()));
    }

    #[test]
    fn a_bundle_specific_entry_wins() {
        let manifest = manifest(
            r#"{"version":"1.0.0","platforms":{
              "darwin-aarch64":{"signature":"a","url":"https://x/generic"},
              "darwin-aarch64-app":{"signature":"b","url":"https://x/app"}}}"#,
        );
        assert_eq!(
            manifest.artifact(&MAC, UrlPolicy::Https).unwrap().url,
            "https://x/app"
        );
    }

    #[test]
    fn refuses_what_it_cannot_trust() {
        let missing = manifest(r#"{"version":"1.0.0","platforms":{}}"#);
        assert_eq!(
            missing.artifact(&MAC, UrlPolicy::Https),
            Err(ManifestError::NoPlatform("darwin-aarch64".into()))
        );
        let plain_http = manifest(
            r#"{"version":"1.0.0","platforms":{"darwin-aarch64":{"signature":"a","url":"http://x/a"}}}"#,
        );
        assert!(matches!(
            plain_http.artifact(&MAC, UrlPolicy::Https),
            Err(ManifestError::Url(_))
        ));
        let local = manifest(
            r#"{"version":"1.0.0","platforms":{"darwin-aarch64":{"signature":"a","url":"file:///tmp/a"}}}"#,
        );
        assert!(local.artifact(&MAC, UrlPolicy::Https).is_err());
        assert!(local.artifact(&MAC, UrlPolicy::AllowLocal).is_ok());
        let this_machine = manifest(
            r#"{"version":"1.0.0","platforms":{"darwin-aarch64":{"signature":"a","url":"http://127.0.0.1:4100/a"}}}"#,
        );
        assert!(this_machine.artifact(&MAC, UrlPolicy::Https).is_err());
        assert!(this_machine.artifact(&MAC, UrlPolicy::AllowLocal).is_ok());
        assert!(plain_http.artifact(&MAC, UrlPolicy::AllowLocal).is_err());
        let unsigned = manifest(
            r#"{"version":"1.0.0","platforms":{"darwin-aarch64":{"signature":" ","url":"https://x/a"}}}"#,
        );
        assert!(matches!(
            unsigned.artifact(&MAC, UrlPolicy::Https),
            Err(ManifestError::EmptySignature(_))
        ));
        assert!(matches!(
            Manifest::parse(br#"{"version":"latest","platforms":{}}"#),
            Err(ManifestError::Version(_))
        ));
        assert!(matches!(
            Manifest::parse(b"<html>"),
            Err(ManifestError::Json(_))
        ));
    }

    #[test]
    fn this_platform_has_a_target() {
        let target = Target::current().unwrap();
        assert!(["darwin", "windows"].contains(&target.os));
        assert!(["aarch64", "x86_64"].contains(&target.arch));
    }
}
