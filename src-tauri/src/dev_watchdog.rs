//! Development-only renderer stall watchdog.
//!
//! The renderer sends a heartbeat every `HEARTBEAT_INTERVAL`. A native thread
//! notices when heartbeats stop for longer than `STALL_THRESHOLD` plus that
//! interval and appends JSON lines to `<data root>/logs/renderer-stalls.log`.
//! Detection lives on the native side because a blocked WebView main thread
//! cannot report its own stall, and a hard freeze may never recover.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};

pub const STALL_THRESHOLD: Duration = Duration::from_millis(1_000);
/// Must match `BEAT_MS` in `src/renderer/lib/dev-watchdog.ts`.
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(250);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const FIRST_ONGOING_REPORT: Duration = Duration::from_secs(5);
const LOG_FILE: &str = "renderer-stalls.log";
const ROTATE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CONTEXT_BYTES: usize = 16 * 1024;
const MAX_SESSION_ID_CHARS: usize = 64;
const SAMPLE_DIRECTORY: &str = "stall-samples";
const SAMPLE_SECONDS: &str = "3";
const SAMPLE_RETENTION: usize = 20;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    session_id: String,
    /// Detection runs only while the page is visible; hidden pages throttle timers.
    active: bool,
    #[serde(default)]
    utc_offset_minutes: i32,
    #[serde(default)]
    context: Value,
    /// Renderer-measured timer gap, sent once on the first tick after a stall.
    #[serde(default)]
    recovered: Option<Value>,
}

struct Stall {
    next_report: Duration,
}

struct Session {
    id: String,
    active: bool,
    last_beat: Instant,
    last_beat_wall_ms: u64,
    context: Value,
    stall: Option<Stall>,
}

/// Pure detection state. Callers supply the clocks so tests can drive it.
pub struct Watchdog {
    silence_limit: Duration,
    utc_offset_minutes: i32,
    session: Option<Session>,
    /// The unloading page may still tick while the next document loads.
    retired_session_id: Option<String>,
}

impl Watchdog {
    pub fn new(threshold: Duration) -> Self {
        Self {
            silence_limit: threshold + HEARTBEAT_INTERVAL,
            utc_offset_minutes: 0,
            session: None,
            retired_session_id: None,
        }
    }

    pub fn beat(&mut self, beat: Heartbeat, now: Instant, wall_ms: u64) -> Vec<Value> {
        self.utc_offset_minutes = beat.utc_offset_minutes.clamp(-18 * 60, 18 * 60);
        let session_id: String = beat.session_id.chars().take(MAX_SESSION_ID_CHARS).collect();
        if self.retired_session_id.as_deref() == Some(session_id.as_str()) {
            return Vec::new();
        }
        let context = bounded_context(beat.context);
        let mut records = Vec::new();

        let same_session = self
            .session
            .as_ref()
            .is_some_and(|session| session.id == session_id);
        if same_session {
            let session = self.session.as_mut().expect("session checked above");
            if session.active != beat.active {
                // Hidden pages are not watched; record why a freeze may be absent.
                records.push(json!({
                    "event": "visibility",
                    "at": format_timestamp(wall_ms, self.utc_offset_minutes),
                    "sessionId": session.id,
                    "active": beat.active,
                }));
            }
            let native_stall = session.stall.take();
            if native_stall.is_some() || beat.recovered.is_some() {
                let silent = now.saturating_duration_since(session.last_beat);
                let blocked = if beat.recovered.is_some() {
                    "renderer"
                } else {
                    // The renderer timer kept running; delivery to native was late.
                    "ipc-or-native"
                };
                records.push(json!({
                    "event": "stall-recovered",
                    "at": format_timestamp(wall_ms, self.utc_offset_minutes),
                    "sessionId": session.id,
                    "blocked": blocked,
                    "nativeDetected": native_stall.is_some(),
                    "nativeSilentMs": duration_ms(silent),
                    "renderer": beat.recovered,
                    "context": context,
                }));
            }
        } else {
            if let Some(previous) = self.session.take() {
                if previous.stall.is_some() {
                    records.push(json!({
                        "event": "stall-unrecovered",
                        "at": format_timestamp(wall_ms, self.utc_offset_minutes),
                        "sessionId": previous.id,
                        "reason": "replaced by a new renderer session",
                        "nativeSilentMs": duration_ms(now.saturating_duration_since(previous.last_beat)),
                    }));
                }
            }
            records.push(json!({
                "event": "session",
                "at": format_timestamp(wall_ms, self.utc_offset_minutes),
                "sessionId": session_id,
                "active": beat.active,
                "context": context,
            }));
        }

        let session = self.session.get_or_insert_with(|| Session {
            id: session_id,
            active: beat.active,
            last_beat: now,
            last_beat_wall_ms: wall_ms,
            context: Value::Null,
            stall: None,
        });
        session.active = beat.active;
        session.last_beat = now;
        session.last_beat_wall_ms = wall_ms;
        session.context = context;
        records
    }

    /// A document navigation (reload, HMR full reload) is not a stall.
    pub fn page_load_started(&mut self, wall_ms: u64) -> Vec<Value> {
        let Some(session) = self.session.take() else {
            return Vec::new();
        };
        self.retired_session_id = Some(session.id.clone());
        if session.stall.is_none() {
            return Vec::new();
        }
        vec![json!({
            "event": "stall-unrecovered",
            "at": format_timestamp(wall_ms, self.utc_offset_minutes),
            "sessionId": session.id,
            "reason": "page navigation started",
        })]
    }

    pub fn tick(&mut self, now: Instant, wall_ms: u64) -> Vec<Value> {
        let Some(session) = self.session.as_mut() else {
            return Vec::new();
        };
        if !session.active {
            return Vec::new();
        }
        let silent = now.saturating_duration_since(session.last_beat);
        if silent <= self.silence_limit {
            return Vec::new();
        }
        match session.stall.as_mut() {
            None => {
                session.stall = Some(Stall {
                    next_report: FIRST_ONGOING_REPORT,
                });
                vec![json!({
                    "event": "stall",
                    "at": format_timestamp(session.last_beat_wall_ms, self.utc_offset_minutes),
                    "detectedAt": format_timestamp(wall_ms, self.utc_offset_minutes),
                    "sessionId": session.id,
                    "nativeSilentMs": duration_ms(silent),
                    "lastContext": session.context,
                })]
            }
            Some(stall) if silent >= stall.next_report => {
                stall.next_report = next_ongoing_report(stall.next_report);
                vec![json!({
                    "event": "stall-ongoing",
                    "at": format_timestamp(wall_ms, self.utc_offset_minutes),
                    "sessionId": session.id,
                    "nativeSilentMs": duration_ms(silent),
                })]
            }
            Some(_) => Vec::new(),
        }
    }
}

fn next_ongoing_report(current: Duration) -> Duration {
    match current.as_secs() {
        0..=5 => Duration::from_secs(15),
        6..=15 => Duration::from_secs(60),
        _ => current + Duration::from_secs(300),
    }
}

fn bounded_context(context: Value) -> Value {
    let size = context.to_string().len();
    if size > MAX_CONTEXT_BYTES {
        Value::String(format!("[context omitted: {size} bytes]"))
    } else {
        context
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(duration_ms)
        .unwrap_or(0)
}

/// ISO-8601 with the renderer's UTC offset, so entries match the author's clock.
fn format_timestamp(epoch_ms: u64, offset_minutes: i32) -> String {
    let local_ms = i64::try_from(epoch_ms)
        .unwrap_or(i64::MAX)
        .saturating_add(i64::from(offset_minutes) * 60_000);
    let (year, month, day) = civil_from_days(local_ms.div_euclid(86_400_000));
    let ms_of_day = local_ms.rem_euclid(86_400_000);
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let offset = offset_minutes.unsigned_abs();
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}{sign}{:02}:{:02}",
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1_000 % 60,
        ms_of_day % 1_000,
        offset / 60,
        offset % 60,
    )
}

/// Howard Hinnant's days-to-civil conversion for the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The data root's `logs` directory: a sibling of the database directory, so
/// each development checkout or worktree instance keeps its own log.
pub fn log_directory(database_directory: &Path) -> PathBuf {
    database_directory
        .parent()
        .unwrap_or(database_directory)
        .join("logs")
}

struct LogSink {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl LogSink {
    fn append(&self, records: &[Value]) {
        if records.is_empty() {
            return;
        }
        for record in records {
            let event = record["event"].as_str().unwrap_or_default();
            if event.starts_with("stall") {
                eprintln!(
                    "[dev-watchdog] {event} after {} ms of heartbeat silence; see {}",
                    record["nativeSilentMs"].as_u64().unwrap_or(0),
                    self.path.display(),
                );
            }
        }
        let _guard = lock(&self.write_lock);
        if let Err(error) = self.write(records) {
            eprintln!(
                "[dev-watchdog] could not write {}: {error}",
                self.path.display()
            );
        }
    }

    fn write(&self, records: &[Value]) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::metadata(&self.path).is_ok_and(|metadata| metadata.len() > ROTATE_BYTES) {
            fs::rename(&self.path, self.path.with_extension("1.log"))?;
        }
        let mut lines = String::new();
        for record in records {
            lines.push_str(&record.to_string());
            lines.push('\n');
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(lines.as_bytes())
    }
}

/// Captures a native stack sample of the WebView content process when a stall
/// opens. JavaScript frames are opaque, but the sample separates script
/// execution, garbage collection, layout and blocking waits.
struct Sampler {
    web_content_pid: Arc<AtomicI32>,
    directory: PathBuf,
}

impl Sampler {
    fn capture(&self, label: &str) -> Option<(i32, PathBuf)> {
        let pid = self.web_content_pid.load(Ordering::Relaxed);
        if pid <= 0 || !cfg!(target_os = "macos") {
            return None;
        }
        fs::create_dir_all(&self.directory).ok()?;
        prune_samples(&self.directory, SAMPLE_RETENTION - 1);
        let path = self.directory.join(format!("stall-{label}.txt"));
        let mut child = Command::new("/usr/bin/sample")
            .arg(pid.to_string())
            .arg(SAMPLE_SECONDS)
            .arg("-mayDie")
            .arg("-file")
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        // Reap the sampler without delaying stall detection.
        std::thread::spawn(move || child.wait());
        Some((pid, path))
    }

    fn annotate(&self, records: &mut [Value]) {
        for record in records
            .iter_mut()
            .filter(|record| record["event"] == "stall")
        {
            let label = record["detectedAt"]
                .as_str()
                .unwrap_or("unknown")
                .replace(':', "-");
            if let Some((pid, path)) = self.capture(&label) {
                record["webContentPid"] = json!(pid);
                record["sample"] = json!(path.display().to_string());
            }
        }
    }
}

/// Keep the newest `keep` samples; names embed their detection timestamp.
fn prune_samples(directory: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut samples: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "txt"))
        .collect();
    samples.sort();
    let excess = samples.len().saturating_sub(keep);
    for path in samples.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(target_os = "macos")]
fn refresh_web_content_pid(window: &tauri::WebviewWindow, pid: Arc<AtomicI32>) {
    let _ = window.with_webview(move |webview| unsafe {
        use objc2::runtime::NSObjectProtocol;
        use objc2_web_kit::WKWebView;

        let webview: &WKWebView = &*webview.inner().cast();
        // Private accessor; if a WebKit build removes it, sampling stays off.
        if !webview.respondsToSelector(objc2::sel!(_webProcessIdentifier)) {
            return;
        }
        let identifier: i32 = objc2::msg_send![webview, _webProcessIdentifier];
        pid.store(identifier, Ordering::Relaxed);
    });
}

#[cfg(not(target_os = "macos"))]
fn refresh_web_content_pid(_window: &tauri::WebviewWindow, _pid: Arc<AtomicI32>) {}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding the lock must not silence later diagnostics.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct DevWatchdog {
    watchdog: Arc<Mutex<Watchdog>>,
    sink: Arc<LogSink>,
    sampler: Arc<Sampler>,
}

impl DevWatchdog {
    pub fn start(log_directory: PathBuf) -> Self {
        let state = Self {
            watchdog: Arc::new(Mutex::new(Watchdog::new(STALL_THRESHOLD))),
            sink: Arc::new(LogSink {
                path: log_directory.join(LOG_FILE),
                write_lock: Mutex::new(()),
            }),
            sampler: Arc::new(Sampler {
                web_content_pid: Arc::new(AtomicI32::new(0)),
                directory: log_directory.join(SAMPLE_DIRECTORY),
            }),
        };
        let watchdog = state.watchdog.clone();
        let sink = state.sink.clone();
        let sampler = state.sampler.clone();
        let spawned = std::thread::Builder::new()
            .name("dev-watchdog".to_string())
            .spawn(move || loop {
                std::thread::sleep(POLL_INTERVAL);
                let mut records = lock(&watchdog).tick(Instant::now(), wall_ms());
                sampler.annotate(&mut records);
                sink.append(&records);
            });
        match spawned {
            Ok(_) => eprintln!(
                "[dev-watchdog] logging renderer stalls over {} ms to {}",
                STALL_THRESHOLD.as_millis(),
                state.sink.path.display(),
            ),
            Err(error) => eprintln!("[dev-watchdog] could not start: {error}"),
        }
        state
    }

    pub fn page_load_started(&self) {
        let records = lock(&self.watchdog).page_load_started(wall_ms());
        self.sink.append(&records);
    }
}

#[tauri::command]
pub async fn dev_watchdog_heartbeat(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DevWatchdog>,
    beat: Heartbeat,
) -> Result<(), String> {
    let records = lock(&state.watchdog).beat(beat, Instant::now(), wall_ms());
    if records.iter().any(|record| record["event"] == "session") {
        // A new document may run in a new content process.
        refresh_web_content_pid(&window, state.sampler.web_content_pid.clone());
    }
    state.sink.append(&records);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0_WALL: u64 = 1_791_094_028_123;

    fn heartbeat(session_id: &str, active: bool, recovered: Option<Value>) -> Heartbeat {
        Heartbeat {
            session_id: session_id.to_string(),
            active,
            utc_offset_minutes: 480,
            context: json!({ "route": "#/project/p1" }),
            recovered,
        }
    }

    fn events(records: &[Value]) -> Vec<&str> {
        records
            .iter()
            .map(|record| record["event"].as_str().unwrap())
            .collect()
    }

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn regular_heartbeats_never_report_a_stall() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let start = Instant::now();
        assert_eq!(
            events(&watchdog.beat(heartbeat("a", true, None), start, T0_WALL)),
            ["session"]
        );
        for step in 1..40 {
            let now = start + ms(step * 250);
            assert!(watchdog.tick(now, T0_WALL).is_empty());
            assert!(watchdog
                .beat(heartbeat("a", true, None), now, T0_WALL)
                .is_empty());
        }
    }

    #[test]
    fn silence_beyond_threshold_and_interval_opens_one_stall_with_last_context() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let start = Instant::now();
        watchdog.beat(heartbeat("a", true, None), start, T0_WALL);

        assert!(watchdog.tick(start + ms(1_250), T0_WALL + 1_250).is_empty());
        let records = watchdog.tick(start + ms(1_300), T0_WALL + 1_300);
        assert_eq!(events(&records), ["stall"]);
        assert_eq!(records[0]["at"], "2026-10-04T14:07:08.123+08:00");
        assert_eq!(records[0]["detectedAt"], "2026-10-04T14:07:09.423+08:00");
        assert_eq!(records[0]["nativeSilentMs"], 1_300);
        assert_eq!(records[0]["lastContext"]["route"], "#/project/p1");
        assert!(watchdog.tick(start + ms(1_400), T0_WALL + 1_400).is_empty());
    }

    #[test]
    fn unrecovered_stalls_are_reported_again_at_growing_intervals() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let start = Instant::now();
        watchdog.beat(heartbeat("a", true, None), start, T0_WALL);
        let mut reported = Vec::new();
        for step in 1..=7_000 {
            let records = watchdog.tick(start + ms(step * 100), T0_WALL);
            for record in records {
                reported.push((record["event"].as_str().unwrap().to_string(), step * 100));
            }
        }
        let reported: Vec<(&str, u64)> = reported
            .iter()
            .map(|(event, at)| (event.as_str(), *at))
            .collect();
        assert_eq!(
            reported,
            [
                ("stall", 1_300),
                ("stall-ongoing", 5_000),
                ("stall-ongoing", 15_000),
                ("stall-ongoing", 60_000),
                ("stall-ongoing", 360_000),
                ("stall-ongoing", 660_000),
            ]
        );
    }

    #[test]
    fn recovery_classifies_where_the_heartbeat_was_held() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let start = Instant::now();
        watchdog.beat(heartbeat("a", true, None), start, T0_WALL);
        watchdog.tick(start + ms(2_000), T0_WALL + 2_000);
        let gap = json!({ "blockedMs": 2_100 });
        let records = watchdog.beat(
            heartbeat("a", true, Some(gap.clone())),
            start + ms(2_400),
            T0_WALL + 2_400,
        );
        assert_eq!(events(&records), ["stall-recovered"]);
        assert_eq!(records[0]["blocked"], "renderer");
        assert_eq!(records[0]["nativeDetected"], true);
        assert_eq!(records[0]["nativeSilentMs"], 2_400);
        assert_eq!(records[0]["renderer"], gap);

        watchdog.tick(start + ms(4_000), T0_WALL + 4_000);
        let records = watchdog.beat(heartbeat("a", true, None), start + ms(4_100), T0_WALL);
        assert_eq!(records[0]["blocked"], "ipc-or-native");
        assert_eq!(records[0]["renderer"], Value::Null);
    }

    #[test]
    fn renderer_reported_gaps_are_logged_even_below_native_detection() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let start = Instant::now();
        watchdog.beat(heartbeat("a", true, None), start, T0_WALL);
        let records = watchdog.beat(
            heartbeat("a", true, Some(json!({ "blockedMs": 1_000 }))),
            start + ms(1_200),
            T0_WALL,
        );
        assert_eq!(events(&records), ["stall-recovered"]);
        assert_eq!(records[0]["nativeDetected"], false);
    }

    #[test]
    fn hidden_pages_and_navigations_are_not_stalls() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let start = Instant::now();
        let records = watchdog.beat(heartbeat("a", false, None), start, T0_WALL);
        assert_eq!(records[0]["active"], false);
        assert!(watchdog.tick(start + ms(60_000), T0_WALL).is_empty());

        let records = watchdog.beat(heartbeat("a", true, None), start + ms(60_000), T0_WALL);
        assert_eq!(events(&records), ["visibility"]);
        assert_eq!(records[0]["active"], true);
        assert!(watchdog.page_load_started(T0_WALL).is_empty());
        // A late tick from the unloading page must not re-arm detection.
        assert!(watchdog
            .beat(heartbeat("a", true, None), start + ms(60_100), T0_WALL)
            .is_empty());
        assert!(watchdog.tick(start + ms(70_000), T0_WALL).is_empty());
        assert_eq!(
            events(&watchdog.beat(heartbeat("b", true, None), start + ms(70_000), T0_WALL)),
            ["session"]
        );
    }

    #[test]
    fn a_replaced_session_closes_its_open_stall() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let start = Instant::now();
        watchdog.beat(heartbeat("a", true, None), start, T0_WALL);
        watchdog.tick(start + ms(3_000), T0_WALL);
        let records = watchdog.beat(heartbeat("b", true, None), start + ms(9_000), T0_WALL);
        assert_eq!(events(&records), ["stall-unrecovered", "session"]);
        assert_eq!(records[0]["sessionId"], "a");
        assert_eq!(records[1]["sessionId"], "b");

        watchdog.tick(start + ms(12_000), T0_WALL);
        let records = watchdog.page_load_started(T0_WALL);
        assert_eq!(events(&records), ["stall-unrecovered"]);
        assert_eq!(records[0]["reason"], "page navigation started");
    }

    #[test]
    fn oversized_context_is_replaced_with_its_size() {
        let mut watchdog = Watchdog::new(STALL_THRESHOLD);
        let mut beat = heartbeat("a", true, None);
        beat.context = json!({ "route": "x".repeat(MAX_CONTEXT_BYTES) });
        let records = watchdog.beat(beat, Instant::now(), T0_WALL);
        assert!(records[0]["context"]
            .as_str()
            .unwrap()
            .starts_with("[context omitted:"));
    }

    #[test]
    fn timestamps_use_the_renderer_offset() {
        assert_eq!(format_timestamp(0, 0), "1970-01-01T00:00:00.000+00:00");
        assert_eq!(
            format_timestamp(1_709_251_199_000, 0),
            "2024-02-29T23:59:59.000+00:00"
        );
        assert_eq!(
            format_timestamp(1_709_251_199_000, 60),
            "2024-03-01T00:59:59.000+01:00"
        );
        assert_eq!(
            format_timestamp(1_709_251_199_000, -330),
            "2024-02-29T18:29:59.000-05:30"
        );
    }

    #[test]
    fn samples_need_a_content_process_and_keep_only_the_newest() {
        let directory = tempfile::tempdir().unwrap();
        let sampler = Sampler {
            web_content_pid: Arc::new(AtomicI32::new(0)),
            directory: directory.path().join(SAMPLE_DIRECTORY),
        };
        let mut records = vec![json!({ "event": "stall", "detectedAt": "x" })];
        sampler.annotate(&mut records);
        assert_eq!(records[0].get("sample"), None);

        fs::create_dir_all(&sampler.directory).unwrap();
        for index in 0..5 {
            fs::write(sampler.directory.join(format!("stall-{index}.txt")), "").unwrap();
        }
        fs::write(sampler.directory.join("notes.md"), "").unwrap();
        prune_samples(&sampler.directory, 2);
        let mut remaining: Vec<String> = fs::read_dir(&sampler.directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        remaining.sort();
        assert_eq!(remaining, ["notes.md", "stall-3.txt", "stall-4.txt"]);
    }

    #[test]
    fn log_lives_beside_the_database_directory_and_rotates() {
        assert_eq!(
            log_directory(Path::new("/data/root/databases")),
            Path::new("/data/root/logs")
        );

        let directory = tempfile::tempdir().unwrap();
        let sink = LogSink {
            path: directory.path().join("logs").join(LOG_FILE),
            write_lock: Mutex::new(()),
        };
        sink.write(&[json!({ "event": "session" })]).unwrap();
        fs::write(&sink.path, vec![b'x'; ROTATE_BYTES as usize + 1]).unwrap();
        sink.write(&[json!({ "event": "stall" })]).unwrap();
        assert_eq!(
            fs::read_to_string(&sink.path).unwrap(),
            "{\"event\":\"stall\"}\n"
        );
        assert!(directory.path().join("logs/renderer-stalls.1.log").exists());
    }
}
