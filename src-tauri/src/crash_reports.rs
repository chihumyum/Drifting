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
}

pub(crate) struct CrashReportDirectory(PathBuf);

pub(crate) fn report_directory(database_directory: &Path) -> PathBuf {
    database_directory
        .parent()
        .unwrap_or(database_directory)
        .join("diagnostics")
        .join("native")
}

fn bounded(mut value: String) -> String {
    if let Some(home) = std::env::var_os("HOME").and_then(|home| home.into_string().ok()) {
        if !home.is_empty() {
            value = value.replace(&home, "~");
        }
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
                std::env::var("HOME").unwrap_or_default()
            )),
            location: "src/lib.rs:1".into(),
            thread: "main".into(),
            backtrace: "0: drifting::run".into(),
            occurred_at_ms: 1,
            app_version: "0.1.0-alpha.2".into(),
        };
        write_report(&directory, &report).unwrap();
        fs::write(directory.join("panic-2-broken.json"), b"{").unwrap();

        let taken = take_reports(&directory);
        assert_eq!(taken, vec![report]);
        assert!(taken[0].message.starts_with("boom in ~"));
        assert!(take_reports(&directory).is_empty());
        let _ = fs::remove_dir_all(directory);
    }
}
