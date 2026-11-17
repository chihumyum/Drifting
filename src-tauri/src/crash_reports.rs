//! Native panic records for the renderer's crash reporter.
//!
//! A panic hook writes one small JSON file per panic next to the databases
//! directory. On the next launch the renderer takes the files, sanitizes them
//! and sends them with its own reports (see
//! `src/renderer/services/diagnostics/crash-reporter.ts`). The hook never
//! touches the network and keeps the default panic output.

use std::backtrace::Backtrace;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::ThreadId;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_PENDING_REPORTS: usize = 20;
const MAX_FIELD_BYTES: usize = 12 * 1024;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCrashReport {
    message: String,
    location: String,
    thread: String,
    backtrace: String,
    occurred_at_ms: u64,
    app_version: String,
    /// The launch step (`enter_setup_step`) the panicking thread was in.
    /// Records written before it existed have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    setup_step: Option<String>,
}

pub(crate) struct CrashReportDirectory(PathBuf);

/// The launch step Tauri's `setup` hook is in, and the thread running it.
/// When a step returns an error Tauri panics with a fixed sentence around it,
/// so the record names the step itself.
static SETUP_STEP: Mutex<Option<(ThreadId, &'static str)>> = Mutex::new(None);

/// Name the launch step that starts now on this thread.
pub(crate) fn enter_setup_step(step: &'static str) {
    if let Ok(mut current) = SETUP_STEP.lock() {
        *current = Some((std::thread::current().id(), step));
    }
}

/// The launch finished its steps: later panics belong to none of them.
pub(crate) fn finish_setup_steps() {
    if let Ok(mut current) = SETUP_STEP.lock() {
        *current = None;
    }
}

/// The step this thread is in, if it is the one running the launch steps.
fn current_setup_step() -> Option<String> {
    // try_lock: a panic must never wait on the lock it may be holding.
    let current = SETUP_STEP.try_lock().ok()?;
    current
        .filter(|(thread, _)| *thread == std::thread::current().id())
        .map(|(_, step)| step.to_owned())
}

pub(crate) fn report_directory(database_directory: &Path) -> PathBuf {
    database_directory
        .parent()
        .unwrap_or(database_directory)
        .join("diagnostics")
        .join("native")
}

/// The author's home folder, which reports replace with `~`: `HOME` on Unix,
/// `USERPROFILE` (C:\Users\<name>) on Windows, where `HOME` is usually unset.
fn home_directory() -> Option<String> {
    ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).and_then(|home| home.into_string().ok()))
        .find(|home| !home.is_empty())
}

fn bounded(mut value: String) -> String {
    if let Some(home) = home_directory() {
        value = value.replace(&home, "~");
    }
    if value.len() > MAX_FIELD_BYTES {
        let mut end = MAX_FIELD_BYTES;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

fn write_report(directory: &Path, report: &NativeCrashReport) -> std::io::Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(directory)?;
    if fs::read_dir(directory)?.count() >= MAX_PENDING_REPORTS {
        return Ok(());
    }
    let name = format!(
        "panic-{}-{}-{}.json",
        report.occurred_at_ms,
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let temporary = directory.join(format!(".{name}.tmp"));
    fs::write(&temporary, serde_json::to_vec(report)?)?;
    fs::rename(temporary, directory.join(name))
}

/// Record every panic before the default hook prints it.
pub(crate) fn install_panic_hook(directory: PathBuf, app_version: String) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_owned());
        let report = NativeCrashReport {
            message: bounded(message),
            location: info
                .location()
                .map(|location| format!("{}:{}", location.file(), location.line()))
                .unwrap_or_default(),
            thread: std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_owned(),
            backtrace: bounded(Backtrace::force_capture().to_string()),
            occurred_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default(),
            app_version: app_version.clone(),
            setup_step: current_setup_step(),
        };
        // A failure to record must never turn one panic into another.
        let _ = write_report(&directory, &report);
        previous(info);
    }));
}

pub(crate) fn take_reports(directory: &Path) -> Vec<NativeCrashReport> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("panic-") && name.ends_with(".json"))
        })
        .collect();
    paths.sort();
    paths
        .into_iter()
        .take(MAX_PENDING_REPORTS)
        .filter_map(|path| {
            let report = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
            // Unreadable records are removed too, so they cannot pile up.
            let _ = fs::remove_file(&path);
            report
        })
        .collect()
}

#[tauri::command]
pub(crate) fn diagnostics_take_native_reports(
    directory: State<'_, CrashReportDirectory>,
) -> Vec<NativeCrashReport> {
    take_reports(&directory.0)
}

pub(crate) fn directory_state(directory: PathBuf) -> CrashReportDirectory {
    CrashReportDirectory(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_is_recorded_once_and_taken_once() {
        let directory = std::env::temp_dir().join(format!(
            "drifting-crash-reports-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let report = NativeCrashReport {
            message: bounded(format!(
                "boom in {}/notes",
                home_directory().unwrap_or_default()
            )),
            location: "src/lib.rs:1".into(),
            thread: "main".into(),
            backtrace: "0: drifting::run".into(),
            occurred_at_ms: 1,
            app_version: "0.1.0-alpha.2".into(),
            setup_step: Some("window-fit".into()),
        };
        write_report(&directory, &report).unwrap();
        fs::write(directory.join("panic-2-broken.json"), b"{").unwrap();

        let taken = take_reports(&directory);
        assert_eq!(taken, vec![report]);
        assert!(taken[0].message.starts_with("boom in ~"));
        assert!(take_reports(&directory).is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_record_written_before_setup_steps_existed_is_still_taken() {
        let report: NativeCrashReport = serde_json::from_str(
            r#"{"message":"boom","location":"src/lib.rs:1","thread":"main","backtrace":"","occurredAtMs":1,"appVersion":"0.1.0-alpha.11"}"#,
        )
        .unwrap();
        assert_eq!(report.setup_step, None);
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("setupStep").is_none());
    }

    #[test]
    fn the_setup_step_belongs_to_the_thread_running_it() {
        enter_setup_step("tray");
        assert_eq!(current_setup_step().as_deref(), Some("tray"));
        let elsewhere = std::thread::spawn(current_setup_step).join().unwrap();
        assert_eq!(elsewhere, None);
        finish_setup_steps();
        assert_eq!(current_setup_step(), None);
    }
}
