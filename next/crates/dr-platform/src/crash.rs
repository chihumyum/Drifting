//! Crash reports through Sentry.
//!
//! **Whether anything is sent** ([`decide`]): only when the build was compiled
//! with a DSN (`DRIFTING_SENTRY_DSN`; no DSN is ever committed, so local and
//! CI builds send nothing), the build is a release build (development builds
//! need `DRIFTING_CRASH_REPORTS_IN_DEV=1`), and the author agreed (the
//! setting F6 stores, passed in as `consent`).
//!
//! **What is caught**:
//!
//! - *Rust panics*, always recorded by our panic hook to `crashes/pending/`
//!   with a sanitized message, the stack and the loaded images, whether or
//!   not reports are on. The next launch sends them (or, with reports off,
//!   deletes them), as the 0.1 client did. A panic usually aborts the
//!   process (GPUI callbacks cannot unwind), so it cannot be sent on the spot.
//! - *Native crashes* (signals, aborts, access violations), through Sentry's
//!   minidump integration: a crash-reporter process (this same executable,
//!   re-run with `DRIFTING_CRASH_REPORTER` set) writes a minidump and uploads
//!   it at once. It only exists while reports are on. A minidump holds the
//!   crashed threads' stack memory, which can include fragments of whatever
//!   the app was handling; the consent text must say so.
//!
//! **Follow-ups**: every report sent leaves a small record in
//! `crashes/followups/`. [`CrashReporting::take_follow_up`] hands F6 the
//! newest one, once, for the "what were you doing?" notification; older ones
//! are dropped, so each crash is offered at most once.
//!
//! **Privacy**: events are rebuilt through `before_send`: messages and
//! exception values are sanitized (`sanitize`), the host name, user, request
//! data and breadcrumbs from other code are dropped.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sentry::protocol::{DebugImage, DebugMeta, Event, Exception, Mechanism, Stacktrace};
use serde::{Deserialize, Serialize};

use crate::identity::{Channel, Identity};
use crate::paths::AppDirs;
use crate::sanitize;

/// Compile-time: the public DSN of the client's Sentry project.
pub const DSN_ENV: &str = "DRIFTING_SENTRY_DSN";
/// Run-time, development builds only: send reports anyway.
pub const DEV_OPT_IN_ENV: &str = "DRIFTING_CRASH_REPORTS_IN_DEV";
/// Marks the crash-reporter process.
pub const REPORTER_ENV: &str = "DRIFTING_CRASH_REPORTER";

/// At most this many panic records wait for the next launch (as the 0.1
/// client's `diagnostics/native/`).
const MAX_PENDING: usize = 20;
const CONSENT_TAG: &str = "drifting.consent";
const CRASH_ID_TAG: &str = "drifting.crash_id";

#[derive(Clone, Debug)]
pub struct CrashConfig {
    pub dsn: Option<String>,
    pub channel: Channel,
    pub consent: bool,
    pub dev_opt_in: bool,
    pub crashes_dir: Option<PathBuf>,
    /// Sentry's release name, `drifting@<version>`.
    pub release: String,
    pub app_version: String,
    pub environment: &'static str,
    pub build_commit: Option<String>,
}

impl CrashConfig {
    pub fn for_build(
        identity: &Identity,
        dirs: Option<&AppDirs>,
        app_version: &str,
        build_commit: Option<&str>,
        consent: bool,
    ) -> Self {
        Self {
            dsn: option_env!("DRIFTING_SENTRY_DSN")
                .map(str::trim)
                .filter(|dsn| !dsn.is_empty())
                .map(str::to_owned),
            channel: identity.channel,
            consent,
            dev_opt_in: std::env::var(DEV_OPT_IN_ENV).is_ok_and(|value| value == "1"),
            crashes_dir: dirs.map(|dirs| dirs.crashes.clone()),
            release: format!("drifting@{app_version}"),
            app_version: app_version.to_owned(),
            environment: match identity.channel {
                Channel::Release => "production",
                Channel::Development => "development",
            },
            build_commit: build_commit.filter(|c| !c.is_empty()).map(str::to_owned),
        }
    }
}

/// Why nothing is sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disabled {
    /// The build has no DSN: every local and CI build.
    NoDsn,
    /// A development build without `DRIFTING_CRASH_REPORTS_IN_DEV=1`.
    Development,
    /// The author turned reports off (or has not been asked yet).
    NoConsent,
    /// No folder for minidumps and records.
    NoFolder,
}

pub fn decide(config: &CrashConfig) -> Result<(), Disabled> {
    if config.dsn.is_none() {
        Err(Disabled::NoDsn)
    } else if config.channel == Channel::Development && !config.dev_opt_in {
        Err(Disabled::Development)
    } else if !config.consent {
        Err(Disabled::NoConsent)
    } else if config.crashes_dir.is_none() {
        Err(Disabled::NoFolder)
    } else {
        Ok(())
    }
}

/// A newer crash F6 may ask the author about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashFollowUp {
    /// The `drifting.crash_id` tag on the Sentry event.
    pub id: String,
    pub kind: CrashKind,
    /// Seconds since the Unix epoch.
    pub occurred_at: u64,
    pub app_version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CrashKind {
    Panic,
    Native,
}

/// A panic, as the hook writes it.
#[derive(Debug, Serialize, Deserialize)]
struct PanicRecord {
    id: String,
    occurred_at: u64,
    app_version: String,
    release: String,
    environment: String,
    message: String,
    location: Option<String>,
    thread: Option<String>,
    stacktrace: Option<Stacktrace>,
    #[serde(default)]
    debug_images: Vec<DebugImage>,
}

pub struct CrashReporting {
    status: Result<(), Disabled>,
    crashes_dir: Option<PathBuf>,
    consent: Arc<AtomicBool>,
    _guard: Option<sentry::ClientInitGuard>,
}

impl std::fmt::Debug for CrashReporting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CrashReporting")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn pending_dir(crashes: &Path) -> PathBuf {
    crashes.join("pending")
}

fn followups_dir(crashes: &Path) -> PathBuf {
    crashes.join("followups")
}

fn minidumps_dir(crashes: &Path) -> PathBuf {
    crashes.join("minidumps")
}

/// Call first in `main`, before logging, windows or threads: in the
/// crash-reporter process it never returns.
pub fn init(config: CrashConfig) -> CrashReporting {
    let status = decide(&config);
    if std::env::var_os(REPORTER_ENV).is_some() {
        run_reporter(&config);
    }
    if let Some(crashes) = &config.crashes_dir {
        install_panic_hook(crashes.clone(), &config);
    }
    let consent = Arc::new(AtomicBool::new(status.is_ok()));
    let guard = status
        .is_ok()
        .then(|| sentry::init(client_options(&config, consent.clone())));
    let reporting = CrashReporting {
        status,
        crashes_dir: config.crashes_dir.clone(),
        consent,
        _guard: guard,
    };
    reporting.flush_pending_panics();
    reporting
}

/// The crash-reporter process: Sentry's integration runs the minidump
/// server and exits. Reaching the end means it could not; exit rather than
/// fall through into a second copy of the app.
fn run_reporter(config: &CrashConfig) -> ! {
    if config.dsn.is_some() && config.crashes_dir.is_some() {
        let _guard = sentry::init(client_options(config, Arc::new(AtomicBool::new(true))));
    }
    std::process::exit(0);
}

fn client_options(config: &CrashConfig, consent: Arc<AtomicBool>) -> sentry::ClientOptions {
    #[cfg(feature = "network")]
    crate::install_tls_provider();
    let crashes = config.crashes_dir.clone().unwrap_or_default();
    let app_version = config.app_version.clone();
    let followups = followups_dir(&crashes);
    let minidump = sentry::integrations::minidump::MinidumpIntegration::new()
        .crashes_dir(minidumps_dir(&crashes))
        .server_env_var(REPORTER_ENV)
        .process_name("Drifting Crash Reporter")
        .before_capture(move |scope, _path| {
            let id = new_id();
            scope.set_tag(CRASH_ID_TAG, &id);
            write_follow_up(
                &followups,
                &CrashFollowUp {
                    id,
                    kind: CrashKind::Native,
                    occurred_at: now(),
                    app_version: app_version.clone(),
                },
            );
        });
    let mut options = sentry::ClientOptions::new();
    options.dsn = config.dsn.as_deref().and_then(|dsn| dsn.parse().ok());
    options.release = Some(config.release.clone().into());
    options.environment = Some(config.environment.into());
    options.send_default_pii = false;
    // Errors and crashes only: no sessions, traces, logs or breadcrumbs.
    options.auto_session_tracking = false;
    options.max_breadcrumbs = 0;
    options.attach_stacktrace = false;
    let build_commit = config.build_commit.clone();
    options.before_send = Some(Arc::new(move |mut event| {
        if !consent.load(Ordering::SeqCst)
            || event
                .tags
                .get(CONSENT_TAG)
                .is_some_and(|value| value == "off")
        {
            return None;
        }
        if let Some(commit) = &build_commit {
            event.tags.insert("build.commit".into(), commit.clone());
        }
        Some(scrub(event))
    }));
    options.add_integration(minidump)
}

/// Only what a crash report needs leaves the machine.
fn scrub(mut event: Event<'static>) -> Event<'static> {
    event.server_name = None;
    event.user = None;
    event.request = None;
    event.breadcrumbs = Default::default();
    event.extra.clear();
    event.modules.clear();
    if let Some(message) = &event.message {
        event.message = Some(sanitize::message(message));
    }
    for exception in event.exception.values.iter_mut() {
        if let Some(value) = &exception.value {
            exception.value = Some(sanitize::message(value));
        }
        if let Some(stacktrace) = &mut exception.stacktrace {
            for frame in &mut stacktrace.frames {
                frame.abs_path = frame.abs_path.as_deref().map(sanitize::redact_home);
                frame.filename = frame.filename.as_deref().map(sanitize::redact_home);
                frame.package = frame.package.as_deref().map(sanitize::redact_home);
                frame.vars.clear();
            }
        }
    }
    // Image paths name the executable's folder, which for a copy outside
    // /Applications sits in the home folder.
    if !event.debug_meta.images.is_empty() {
        let meta = event.debug_meta.to_mut();
        for image in &mut meta.images {
            match image {
                DebugImage::Apple(image) => image.name = sanitize::redact_home(&image.name),
                DebugImage::Symbolic(image) => {
                    image.name = sanitize::redact_home(&image.name);
                    image.debug_file = image.debug_file.as_deref().map(sanitize::redact_home);
                }
                _ => {}
            }
        }
    }
    if let Some(sentry::protocol::Context::Device(device)) = event.contexts.get_mut("device") {
        device.name = None;
    }
    event
}

fn install_panic_hook(crashes: PathBuf, config: &CrashConfig) {
    let app_version = config.app_version.clone();
    let release = config.release.clone();
    let environment = config.environment.to_owned();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic with a non-text payload".into());
        let record = PanicRecord {
            id: new_id(),
            occurred_at: now(),
            app_version: app_version.clone(),
            release: release.clone(),
            environment: environment.clone(),
            message: sanitize::message(&payload),
            location: info
                .location()
                .map(|l| sanitize::redact_home(&format!("{}:{}", l.file(), l.line()))),
            thread: std::thread::current().name().map(str::to_owned),
            stacktrace: sentry::integrations::backtrace::current_stacktrace(),
            debug_images: sentry::integrations::debug_images::debug_images(),
        };
        tracing::error!(
            target: "panic",
            location = record.location.as_deref().unwrap_or("unknown"),
            "{}",
            record.message
        );
        write_panic_record(&crashes, &record);
        previous(info);
    }));
}

fn write_panic_record(crashes: &Path, record: &PanicRecord) {
    let dir = pending_dir(crashes);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let count = std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
    if count >= MAX_PENDING {
        return;
    }
    if let Ok(json) = serde_json::to_vec(record) {
        let path = dir.join(format!("{}.json", record.id));
        let partial = path.with_extension("partial");
        if std::fs::write(&partial, json).is_ok() {
            let _ = std::fs::rename(&partial, &path);
        }
    }
}

fn write_follow_up(dir: &Path, follow_up: &CrashFollowUp) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_vec(follow_up) {
        let _ = std::fs::write(dir.join(format!("{}.json", follow_up.id)), json);
    }
}

fn read_json_files<T: for<'de> Deserialize<'de>>(dir: &Path) -> Vec<(PathBuf, Option<T>)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let parsed = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
            (path, parsed)
        })
        .collect()
}

fn panic_event(record: &PanicRecord) -> Event<'static> {
    let mut event = Event {
        event_id: uuid::Uuid::parse_str(&record.id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
        level: sentry::Level::Fatal,
        platform: "native".into(),
        timestamp: UNIX_EPOCH + std::time::Duration::from_secs(record.occurred_at),
        release: Some(record.release.clone().into()),
        environment: Some(record.environment.clone().into()),
        message: None,
        ..Default::default()
    };
    event.exception = vec![Exception {
        ty: "panic".into(),
        value: Some(record.message.clone()),
        stacktrace: record.stacktrace.clone(),
        mechanism: Some(Mechanism {
            ty: "panic".into(),
            handled: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    }]
    .into();
    if !record.debug_images.is_empty() {
        event.debug_meta = std::borrow::Cow::Owned(DebugMeta {
            images: record.debug_images.clone(),
            ..Default::default()
        });
    }
    event.tags.insert(CRASH_ID_TAG.into(), record.id.clone());
    if let Some(location) = &record.location {
        event.tags.insert("panic.location".into(), location.clone());
    }
    if let Some(thread) = &record.thread {
        event.tags.insert("panic.thread".into(), thread.clone());
    }
    event
}

impl CrashReporting {
    /// Reports are being sent, or why not.
    pub fn status(&self) -> Result<(), Disabled> {
        self.status
    }

    /// The author changed the setting. Turning reports off takes effect at
    /// once, for the crash reporter too; turning them on takes effect at the
    /// next launch, when the crash reporter can start.
    pub fn set_consent(&self, consent: bool) {
        if self.status.is_err() {
            return;
        }
        self.consent.store(consent, Ordering::SeqCst);
        sentry::with_integration(
            |minidump: &sentry::integrations::minidump::MinidumpIntegration, _| {
                minidump.set_tag(CONSENT_TAG.into(), (!consent).then(|| "off".to_owned()));
            },
        );
    }

    /// A stable integrity code such as `database-open-failed:corrupt`; never
    /// text from the library.
    pub fn report_integrity(&self, code: &str) {
        if self.status.is_ok() && self.consent.load(Ordering::SeqCst) {
            sentry::with_scope(
                |scope| scope.set_fingerprint(Some(&["integrity", code])),
                || sentry::capture_message(&format!("integrity: {code}"), sentry::Level::Error),
            );
        }
    }

    /// The newest crash reported since the last call, for one follow-up
    /// notification. Older ones are dropped.
    pub fn take_follow_up(&self) -> Option<CrashFollowUp> {
        let dir = followups_dir(self.crashes_dir.as_ref()?);
        let mut newest: Option<CrashFollowUp> = None;
        for (path, follow_up) in read_json_files::<CrashFollowUp>(&dir) {
            let _ = std::fs::remove_file(&path);
            if let Some(follow_up) = follow_up
                && newest
                    .as_ref()
                    .is_none_or(|newest| follow_up.occurred_at > newest.occurred_at)
            {
                newest = Some(follow_up);
            }
        }
        newest
    }

    /// Sends the panics recorded by earlier runs, or deletes them when
    /// reports are off.
    fn flush_pending_panics(&self) {
        let Some(crashes) = &self.crashes_dir else {
            return;
        };
        let sending = self.status.is_ok();
        for (path, record) in read_json_files::<PanicRecord>(&pending_dir(crashes)) {
            if sending && let Some(record) = record {
                sentry::capture_event(panic_event(&record));
                write_follow_up(
                    &followups_dir(crashes),
                    &CrashFollowUp {
                        id: record.id.clone(),
                        kind: CrashKind::Panic,
                        occurred_at: record.occurred_at,
                        app_version: record.app_version.clone(),
                    },
                );
            }
            let _ = std::fs::remove_file(&path);
        }
    }

    /// Sends what is queued, waiting at most `timeout`. GPUI gives quit
    /// handlers 200 ms in all (`SHUTDOWN_TIMEOUT`) and `app.run` never returns
    /// on macOS, so the client is not dropped at exit; call this from the quit
    /// handler with a budget well under that. Panic records do not depend on
    /// it: they wait on disk for the next launch.
    pub fn flush(&self, timeout: std::time::Duration) -> bool {
        sentry::Hub::current()
            .client()
            .is_none_or(|client| client.flush(Some(timeout)))
    }

    /// Logs whether reports are on, without the DSN.
    pub fn log_status(&self) {
        match self.status {
            Ok(()) => tracing::info!("crash reports on"),
            Err(reason) => tracing::info!(?reason, "crash reports off"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(dir: &Path) -> CrashConfig {
        CrashConfig {
            dsn: Some("https://public@example.invalid/1".into()),
            channel: Channel::Release,
            consent: true,
            dev_opt_in: false,
            crashes_dir: Some(dir.to_path_buf()),
            release: "drifting@0.2.0".into(),
            app_version: "0.2.0".into(),
            environment: "production",
            build_commit: None,
        }
    }

    #[test]
    fn nothing_is_sent_without_a_dsn_consent_or_in_development() {
        let dir = tempfile::tempdir().unwrap();
        let base = config(dir.path());
        assert_eq!(decide(&base), Ok(()));
        assert_eq!(
            decide(&CrashConfig {
                dsn: None,
                ..base.clone()
            }),
            Err(Disabled::NoDsn)
        );
        assert_eq!(
            decide(&CrashConfig {
                consent: false,
                ..base.clone()
            }),
            Err(Disabled::NoConsent)
        );
        let development = CrashConfig {
            channel: Channel::Development,
            ..base.clone()
        };
        assert_eq!(decide(&development), Err(Disabled::Development));
        assert_eq!(
            decide(&CrashConfig {
                dev_opt_in: true,
                ..development
            }),
            Ok(())
        );
        assert_eq!(
            decide(&CrashConfig {
                crashes_dir: None,
                ..base
            }),
            Err(Disabled::NoFolder)
        );
    }

    #[test]
    fn this_build_has_no_dsn() {
        // No DSN is committed or set in CI; a build with one is a release
        // build made by the release workflow.
        let config =
            CrashConfig::for_build(&crate::identity::DEVELOPMENT, None, "0.2.0-dev", None, true);
        if option_env!("DRIFTING_SENTRY_DSN").is_none() {
            assert_eq!(decide(&config), Err(Disabled::NoDsn));
        }
        assert_eq!(config.environment, "development");
        assert_eq!(config.release, "drifting@0.2.0-dev");
    }

    #[test]
    fn panic_records_become_sanitized_fatal_events() {
        let record = PanicRecord {
            id: new_id(),
            occurred_at: 1_800_000_000,
            app_version: "0.2.0".into(),
            release: "drifting@0.2.0".into(),
            environment: "production".into(),
            message: sanitize::message(&format!("index out of range in `{}`", "雨".repeat(30))),
            location: Some("crates/dr-x/src/lib.rs:10".into()),
            thread: Some("main".into()),
            stacktrace: sentry::integrations::backtrace::current_stacktrace(),
            debug_images: Vec::new(),
        };
        let event = scrub(panic_event(&record));
        assert_eq!(event.level, sentry::Level::Fatal);
        assert_eq!(event.event_id.simple().to_string(), record.id);
        assert_eq!(event.release.as_deref(), Some("drifting@0.2.0"));
        let exception = &event.exception.values[0];
        assert_eq!(exception.ty, "panic");
        assert!(!exception.value.as_deref().unwrap().contains("雨雨雨"));
        assert!(
            exception
                .stacktrace
                .as_ref()
                .is_some_and(|s| !s.frames.is_empty())
        );
        assert_eq!(event.tags.get(CRASH_ID_TAG), Some(&record.id));
    }

    #[test]
    fn scrub_redacts_the_home_folder_in_image_paths() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let images = sentry::integrations::debug_images::debug_images();
        let event = scrub(Event {
            debug_meta: std::borrow::Cow::Owned(DebugMeta {
                images,
                ..Default::default()
            }),
            ..Default::default()
        });
        let home = home.to_string_lossy().into_owned();
        for image in &event.debug_meta.images {
            let name = match image {
                DebugImage::Apple(image) => &image.name,
                DebugImage::Symbolic(image) => &image.name,
                _ => continue,
            };
            assert!(!name.contains(&home), "{name}");
        }
    }

    #[test]
    fn scrub_drops_identifying_fields() {
        let mut event = Event {
            server_name: Some("authors-mac.local".into()),
            message: Some(format!("failed: {}", "字".repeat(20))),
            ..Default::default()
        };
        event.extra.insert("path".into(), "/secret".into());
        let event = scrub(event);
        assert_eq!(event.server_name, None);
        assert!(event.extra.is_empty());
        assert_eq!(event.message.as_deref(), Some("failed: [text]"));
    }

    #[test]
    fn records_wait_and_follow_ups_are_offered_once_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let reporting = CrashReporting {
            status: Err(Disabled::NoDsn),
            crashes_dir: Some(dir.path().to_path_buf()),
            consent: Arc::new(AtomicBool::new(false)),
            _guard: None,
        };
        for (id, at) in [("a", 10), ("b", 30), ("c", 20)] {
            write_follow_up(
                &followups_dir(dir.path()),
                &CrashFollowUp {
                    id: id.into(),
                    kind: CrashKind::Panic,
                    occurred_at: at,
                    app_version: "0.2.0".into(),
                },
            );
        }
        assert_eq!(reporting.take_follow_up().map(|f| f.id), Some("b".into()));
        assert_eq!(reporting.take_follow_up(), None);

        // With reports off, recorded panics are taken and discarded.
        let record = PanicRecord {
            id: new_id(),
            occurred_at: 1,
            app_version: "0.2.0".into(),
            release: "drifting@0.2.0".into(),
            environment: "production".into(),
            message: "boom".into(),
            location: None,
            thread: None,
            stacktrace: None,
            debug_images: Vec::new(),
        };
        write_panic_record(dir.path(), &record);
        assert_eq!(
            std::fs::read_dir(pending_dir(dir.path())).unwrap().count(),
            1
        );
        reporting.flush_pending_panics();
        assert_eq!(
            std::fs::read_dir(pending_dir(dir.path())).unwrap().count(),
            0
        );
        assert_eq!(reporting.take_follow_up(), None);
    }

    #[test]
    fn pending_records_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        for _ in 0..MAX_PENDING + 5 {
            let record = PanicRecord {
                id: new_id(),
                occurred_at: 1,
                app_version: "0.2.0".into(),
                release: "drifting@0.2.0".into(),
                environment: "production".into(),
                message: "boom".into(),
                location: None,
                thread: None,
                stacktrace: None,
                debug_images: Vec::new(),
            };
            write_panic_record(dir.path(), &record);
        }
        assert_eq!(
            std::fs::read_dir(pending_dir(dir.path())).unwrap().count(),
            MAX_PENDING
        );
    }
}
