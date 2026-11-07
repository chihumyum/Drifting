//! The sanitized diagnostic summary the author can attach to feedback (and
//! later copy from Settings → Privacy): the 0.1 client's
//! `drifting.sanitized-diagnostics` format, version 2
//! (`services/diagnostics/sanitized-summary.ts`), field for field.
//!
//! It holds the app's version, platform and architecture, sync counts and
//! error codes, and the updater's state; never manuscript text, credentials,
//! project or book identifiers, absolute paths or raw error text. Error codes
//! that are not plain identifiers become `redacted-error`.
//!
//! The new client has no sync and no running updater yet, so their parts
//! start from what 0.1 reported for a local library with an idle updater
//! ([`SyncSnapshot::local`], [`UpdateSnapshot::idle`]); the modules that
//! bring them (sync, M42's update service) fill them in.
//!
//! Also here: the diagnostics-only installation id that feedback carries
//! (`diag-<uuid>`, random, unrelated to the sync installation id and to the
//! writing-day device), and the ISO time format reports use.

use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;

use crate::sanitize;

pub const FORMAT: &str = "drifting.sanitized-diagnostics";
pub const FORMAT_VERSION: u32 = 2;

/// The file in the app's data folder that holds the diagnostics id.
pub const INSTALLATION_FILE: &str = "diagnostics-installation-v1";
/// What feedback carries when the id cannot be read or written.
pub const INSTALLATION_UNAVAILABLE: &str = "diag-unavailable";

/// The app itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub version: String,
    /// `macos`, `windows`.
    pub platform: String,
    /// `aarch64`, `x86_64`.
    pub architecture: String,
    /// `desktop` (0.1 also had the mobile shell).
    pub target: String,
}

impl AppInfo {
    /// This build on this machine.
    pub fn current(version: &str) -> AppInfo {
        AppInfo {
            version: version.to_owned(),
            platform: std::env::consts::OS.to_owned(),
            architecture: std::env::consts::ARCH.to_owned(),
            target: "desktop".to_owned(),
        }
    }
}

/// What is waiting to sync, summed over every book.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub change_sets: u64,
    pub segments: u64,
    pub transfers: u64,
    pub gaps: u64,
    pub conflicts: u64,
    pub quarantined: u64,
    pub failed: u64,
}

/// Sync, as counts and codes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncSnapshot {
    /// 0.1's authority status: `local`, `cloud-ready`, `cloud-attention`, …
    pub authority_status: String,
    /// `local` or `hosted`.
    pub provider_mode: String,
    pub active_projects: u64,
    pub ready_projects: u64,
    pub provisioning_projects: u64,
    pub paused_projects: u64,
    pub attention_projects: u64,
    pub runtime_mounted: bool,
    pub online: Option<bool>,
    pub suspended: Option<bool>,
    pub pending: Pending,
    /// Raw codes; [`summary`] keeps the plain identifiers, sorted, once.
    pub error_codes: Vec<String>,
}

impl SyncSnapshot {
    /// A library that does not sync.
    pub fn local() -> SyncSnapshot {
        SyncSnapshot {
            authority_status: "local".into(),
            provider_mode: "local".into(),
            active_projects: 0,
            ready_projects: 0,
            provisioning_projects: 0,
            paused_projects: 0,
            attention_projects: 0,
            runtime_mounted: false,
            online: None,
            suspended: None,
            pending: Pending::default(),
            error_codes: Vec::new(),
        }
    }
}

/// The updater.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    /// 0.1's phases: `idle`, `checking`, `available`, `downloading`,
    /// `ready`, `installing`, `error`.
    pub phase: String,
    pub candidate_version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    /// Whether there was an error; never its text.
    pub has_error: bool,
}

impl UpdateSnapshot {
    pub fn idle() -> UpdateSnapshot {
        UpdateSnapshot {
            phase: "idle".into(),
            candidate_version: None,
            downloaded_bytes: 0,
            total_bytes: None,
            has_error: false,
        }
    }
}

/// Everything the summary is made from.
#[derive(Clone, Debug)]
pub struct SummaryInput {
    pub app: AppInfo,
    /// 0.1's feature-status map; `None` until features report one.
    pub features: Option<serde_json::Value>,
    pub sync: SyncSnapshot,
    pub update: UpdateSnapshot,
    pub generated_at: SystemTime,
}

impl SummaryInput {
    /// This build now, with no sync and an idle updater.
    pub fn current(version: &str) -> SummaryInput {
        SummaryInput {
            app: AppInfo::current(version),
            features: None,
            sync: SyncSnapshot::local(),
            update: UpdateSnapshot::idle(),
            generated_at: SystemTime::now(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary<'a> {
    format: &'static str,
    format_version: u32,
    generated_at: String,
    app: &'a AppInfo,
    features: &'a Option<serde_json::Value>,
    sync: SyncPart<'a>,
    updater: &'a UpdateSnapshot,
    privacy: Privacy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncPart<'a> {
    authority_status: &'a str,
    provider_mode: &'a str,
    active_projects: u64,
    ready_projects: u64,
    provisioning_projects: u64,
    paused_projects: u64,
    attention_projects: u64,
    runtime_mounted: bool,
    online: Option<bool>,
    suspended: Option<bool>,
    pending: Pending,
    error_codes: Vec<String>,
}

/// What the summary promises, as 0.1 wrote it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Privacy {
    automatic_upload: bool,
    manuscript_included: bool,
    credentials_included: bool,
    absolute_paths_included: bool,
    raw_error_text_included: bool,
    native_error_chain_sanitized: bool,
}

/// The summary as the author previews it and feedback attaches it:
/// two-space indented JSON and a final newline, as 0.1 printed it.
pub fn summary(input: &SummaryInput) -> String {
    let sync = &input.sync;
    let mut error_codes: Vec<String> = sync
        .error_codes
        .iter()
        .filter(|code| !code.is_empty())
        .map(|code| sanitize::error_code(code))
        .collect();
    error_codes.sort();
    error_codes.dedup();
    let summary = Summary {
        format: FORMAT,
        format_version: FORMAT_VERSION,
        generated_at: iso_time(input.generated_at),
        app: &input.app,
        features: &input.features,
        sync: SyncPart {
            authority_status: &sync.authority_status,
            provider_mode: &sync.provider_mode,
            active_projects: sync.active_projects,
            ready_projects: sync.ready_projects,
            provisioning_projects: sync.provisioning_projects,
            paused_projects: sync.paused_projects,
            attention_projects: sync.attention_projects,
            runtime_mounted: sync.runtime_mounted,
            online: sync.online,
            suspended: sync.suspended,
            pending: sync.pending,
            error_codes,
        },
        updater: &input.update,
        privacy: Privacy {
            automatic_upload: false,
            manuscript_included: false,
            credentials_included: false,
            absolute_paths_included: false,
            raw_error_text_included: false,
            native_error_chain_sanitized: true,
        },
    };
    let mut text = serde_json::to_string_pretty(&summary).unwrap_or_default();
    text.push('\n');
    text
}

/// `2026-10-31T08:01:00.000Z`: what JavaScript's `toISOString` prints.
pub fn iso_time(at: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(at).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn valid_installation_id(id: &str) -> bool {
    id.strip_prefix("diag-").is_some_and(|rest| {
        rest.len() == 36
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    })
}

/// The diagnostics id in `data` (the app's data folder), made on first use;
/// [`INSTALLATION_UNAVAILABLE`] when it can be neither read nor written.
pub fn installation_id(data: Option<&Path>) -> String {
    let Some(data) = data else {
        return INSTALLATION_UNAVAILABLE.to_owned();
    };
    let path = data.join(INSTALLATION_FILE);
    if let Ok(text) = std::fs::read_to_string(&path)
        && valid_installation_id(text.trim())
    {
        return text.trim().to_owned();
    }
    let id = format!("diag-{}", uuid::Uuid::new_v4().hyphenated());
    let temporary = data.join(format!(".{INSTALLATION_FILE}.{}.tmp", std::process::id()));
    let written = std::fs::create_dir_all(data)
        .and_then(|()| std::fs::write(&temporary, &id))
        .and_then(|()| std::fs::rename(&temporary, &path));
    match written {
        Ok(()) => id,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            tracing::warn!("diagnostics id not stored: {}", error.kind());
            INSTALLATION_UNAVAILABLE.to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    // Synthetic prose, never a real manuscript.
    const MANUSCRIPT: &str = "他推开门的时候，雨已经停了，街上只剩下潮湿的灯光。";

    fn at(iso_seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(iso_seconds)
    }

    #[test]
    fn the_summary_has_0_1s_fields_in_0_1s_order() {
        let mut input = SummaryInput::current("0.2.0-dev");
        input.app.platform = "macos".into();
        input.app.architecture = "aarch64".into();
        // 2026-10-31T08:00:00Z
        input.generated_at = at(1_793_433_600);
        let text = summary(&input);
        assert!(text.ends_with("}\n"));
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["format"], FORMAT);
        assert_eq!(value["formatVersion"], 2);
        assert_eq!(value["generatedAt"], "2026-10-31T08:00:00.000Z");
        assert_eq!(
            value["app"],
            serde_json::json!({
                "version": "0.2.0-dev", "platform": "macos",
                "architecture": "aarch64", "target": "desktop",
            })
        );
        assert_eq!(value["features"], serde_json::Value::Null);
        assert_eq!(value["sync"]["authorityStatus"], "local");
        assert_eq!(value["sync"]["pending"]["changeSets"], 0);
        assert_eq!(value["updater"]["phase"], "idle");
        assert_eq!(value["privacy"]["manuscriptIncluded"], false);
        assert_eq!(value["privacy"]["nativeErrorChainSanitized"], true);
        let keys: Vec<&str> = text
            .lines()
            .filter(|l| l.starts_with("  \"") && !l.starts_with("    "))
            .map(|l| l.trim().split('"').nth(1).unwrap())
            .collect();
        assert_eq!(
            keys,
            [
                "format",
                "formatVersion",
                "generatedAt",
                "app",
                "features",
                "sync",
                "updater",
                "privacy"
            ]
        );
    }

    #[test]
    fn error_codes_keep_identifiers_only_sorted_once() {
        let mut input = SummaryInput::current("0.2.0-dev");
        input.sync.error_codes = vec![
            "sync.http-503".into(),
            MANUSCRIPT.into(),
            "/private/writer/book".into(),
            "sync.http-503".into(),
            String::new(),
        ];
        let text = summary(&input);
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value["sync"]["errorCodes"],
            serde_json::json!(["redacted-error", "sync.http-503"])
        );
        assert!(!text.contains("雨已经停了"));
        assert!(!text.contains("/private/"));
    }

    #[test]
    fn iso_time_matches_javascript() {
        let t = at(1_793_433_660) + Duration::from_millis(7);
        assert_eq!(iso_time(t), "2026-10-31T08:01:00.007Z");
    }

    #[test]
    fn the_installation_id_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let id = installation_id(Some(dir.path()));
        assert!(valid_installation_id(&id), "{id}");
        assert_eq!(installation_id(Some(dir.path())), id);
        std::fs::write(dir.path().join(INSTALLATION_FILE), "broken").unwrap();
        let replaced = installation_id(Some(dir.path()));
        assert!(valid_installation_id(&replaced));
        assert_ne!(replaced, id);
        assert_eq!(installation_id(None), INSTALLATION_UNAVAILABLE);
    }
}
