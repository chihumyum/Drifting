//! Native-only Tauri updater state. Updates come from the latest published
//! GitHub release (docs/releasing.md).
//!
//! The renderer can request checks and present metadata, but the endpoint,
//! signature verification, downloaded bytes, and installation remain native.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::ShutdownAction;

const UPDATE_ENDPOINT: &str =
    "https://github.com/chihumyum/Drifting/releases/latest/download/latest.json";

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    downloaded: Option<Vec<u8>>,
}

#[derive(Default)]
pub(crate) struct AppUpdateState(Mutex<PendingUpdate>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateMetadata {
    version: String,
    current_version: String,
    notes: Option<String>,
    published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum UpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// Why the signed updater did not start, when it did not. An updater that
/// cannot start leaves Drifting usable: only update checks report it.
static UPDATER_UNAVAILABLE: OnceLock<String> = OnceLock::new();

fn updater_public_key() -> Result<&'static str, String> {
    option_env!("DRIFTING_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "This build is not configured with the updater public key".to_string())
}

fn updater_ready() -> Result<(), String> {
    updater_public_key()?;
    match UPDATER_UNAVAILABLE.get() {
        Some(reason) => Err(reason.clone()),
        None => Ok(()),
    }
}

/// Starts the updater plugin when the public key is compiled in. A plugin that
/// fails to start (for example a build without `plugins.updater`) is recorded
/// rather than returned, so the App still opens.
pub(crate) fn install_plugin_if_configured(app: &AppHandle) {
    let Ok(public_key) = updater_public_key() else {
        return;
    };
    if let Err(error) = app.plugin(
        tauri_plugin_updater::Builder::new()
            .pubkey(public_key)
            .build(),
    ) {
        let reason = format!("could not initialize the signed updater: {error}");
        eprintln!("{reason}");
        let _ = UPDATER_UNAVAILABLE.set(reason);
    }
}

#[tauri::command]
pub(crate) async fn update_check(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<UpdateMetadata>, String> {
    updater_ready()?;
    let endpoint = UPDATE_ENDPOINT
        .parse()
        .map_err(|error| format!("Updater endpoint is invalid: {error}"))?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("could not configure the updater: {error}"))?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("could not build the updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("could not check for an update: {error}"))?;
    let metadata = update.as_ref().map(|candidate| UpdateMetadata {
        version: candidate.version.clone(),
        current_version: candidate.current_version.clone(),
        notes: candidate.body.clone(),
        published_at: candidate.date.map(|date| date.to_string()),
    });
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())?;
    pending.update = update;
    pending.downloaded = None;
    Ok(metadata)
}

#[tauri::command]
pub(crate) async fn update_download(
    state: State<'_, AppUpdateState>,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<u64, String> {
    let update = {
        let pending = state
            .0
            .lock()
            .map_err(|_| "updater state is unavailable".to_string())?;
        pending
            .update
            .clone()
            .ok_or_else(|| "There is no checked update to download".to_string())?
    };
    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(UpdateDownloadEvent::Started { content_length });
                }
                let _ = on_event.send(UpdateDownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(UpdateDownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| format!("could not download or verify the update: {error}"))?;
    let size =
        u64::try_from(bytes.len()).map_err(|_| "downloaded update is too large".to_string())?;
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())?;
    pending.downloaded = Some(bytes);
    Ok(size)
}

#[tauri::command]
pub(crate) fn update_install(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())?;
    let update = pending
        .update
        .clone()
        .ok_or_else(|| "There is no checked update to install".to_string())?;
    let bytes = pending
        .downloaded
        .take()
        .ok_or_else(|| "The checked update has not been downloaded".to_string())?;
    if let Err(error) = update.install(&bytes) {
        pending.downloaded = Some(bytes);
        return Err(format!("could not install the verified update: {error}"));
    }
    pending.update = None;
    drop(pending);
    // Relaunch through the same flush barrier as an ordinary quit, so edits
    // made while the bundle was being replaced still reach SQLite.
    if !crate::request_flushed_shutdown(&app, ShutdownAction::RestartApp) {
        crate::relaunch_app(&app);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn update_dismiss(state: State<'_, AppUpdateState>) -> Result<(), String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "updater state is unavailable".to_string())?;
    pending.update = None;
    pending.downloaded = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_is_the_latest_published_release_manifest() {
        assert!(UPDATE_ENDPOINT.starts_with("https://github.com/"));
        assert!(UPDATE_ENDPOINT.ends_with("/releases/latest/download/latest.json"));
    }
}
