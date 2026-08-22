//! Native-only Tauri updater state for the public Alpha channel.
//!
//! The renderer can request checks and present metadata, but the endpoint,
//! signature verification, downloaded bytes, and installation remain native.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const ALPHA_UPDATE_ENDPOINT: &str =
    "https://chihumyum.github.io/Drifting/updates/alpha/latest.json";

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

fn updater_public_key() -> Result<&'static str, String> {
    option_env!("DRIFTING_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "This build is not configured with the Alpha updater public key".to_string())
}

pub(crate) fn install_plugin_if_configured(app: &AppHandle) -> Result<(), String> {
    let Ok(public_key) = updater_public_key() else {
        return Ok(());
    };
    app.plugin(
        tauri_plugin_updater::Builder::new()
            .pubkey(public_key)
            .build(),
    )
    .map_err(|error| format!("could not initialize the signed updater: {error}"))
}

#[tauri::command]
pub(crate) async fn update_check(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<UpdateMetadata>, String> {
    updater_public_key()?;
    let endpoint = ALPHA_UPDATE_ENDPOINT
        .parse()
        .map_err(|error| format!("Alpha updater endpoint is invalid: {error}"))?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("could not configure the Alpha updater: {error}"))?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("could not build the Alpha updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("could not check for an Alpha update: {error}"))?;
    let metadata = update.as_ref().map(|candidate| UpdateMetadata {
        version: candidate.version.clone(),
        current_version: candidate.current_version.clone(),
        notes: candidate.body.clone(),
        published_at: candidate.date.map(|date| date.to_string()),
    });
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Alpha updater state is unavailable".to_string())?;
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
            .map_err(|_| "Alpha updater state is unavailable".to_string())?;
        pending
            .update
            .clone()
            .ok_or_else(|| "There is no checked Alpha update to download".to_string())?
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
        .map_err(|error| format!("could not download or verify the Alpha update: {error}"))?;
    let size =
        u64::try_from(bytes.len()).map_err(|_| "downloaded update is too large".to_string())?;
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Alpha updater state is unavailable".to_string())?;
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
        .map_err(|_| "Alpha updater state is unavailable".to_string())?;
    let update = pending
        .update
        .clone()
        .ok_or_else(|| "There is no checked Alpha update to install".to_string())?;
    let bytes = pending
        .downloaded
        .take()
        .ok_or_else(|| "The checked Alpha update has not been downloaded".to_string())?;
    if let Err(error) = update.install(&bytes) {
        pending.downloaded = Some(bytes);
        return Err(format!(
            "could not install the verified Alpha update: {error}"
        ));
    }
    pending.update = None;
    drop(pending);
    app.restart();
}

#[tauri::command]
pub(crate) fn update_dismiss(state: State<'_, AppUpdateState>) -> Result<(), String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Alpha updater state is unavailable".to_string())?;
    pending.update = None;
    pending.downloaded = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_endpoint_is_https_and_versioned_outside_latest_release_alias() {
        assert!(ALPHA_UPDATE_ENDPOINT.starts_with("https://"));
        assert!(ALPHA_UPDATE_ENDPOINT.ends_with("/updates/alpha/latest.json"));
        assert!(!ALPHA_UPDATE_ENDPOINT.contains("/releases/latest"));
    }
}
