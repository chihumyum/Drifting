//! Tauri commands only. Package format, staging, verification and restore live
//! in `drifting_core::library_backup`; this adapter owns dialogs and paths.
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use drifting_core::database::DatabaseGateway;
use drifting_core::library_backup::{
    stage_backup_package, write_backup_package, BackupSummary, LibraryRestoreOutcome,
    LibraryRestorePlan, BACKUP_EXTENSION,
};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
use tauri_plugin_opener::OpenerExt;

use crate::native_capabilities::app_local_dir;

type BackupResult<T> = Result<T, String>;

const RESTORE_STAGING_DIRECTORY: &str = "library-restore";
const RESTORE_ID_BYTES: usize = 16;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackupExportResult {
    canceled: bool,
    file_name: Option<String>,
    summary: Option<BackupSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackupInspectResult {
    canceled: bool,
    restore_id: Option<String>,
    file_name: Option<String>,
    summary: Option<BackupSummary>,
}

fn now_ms() -> BackupResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .map_err(|_| "system clock is before the Unix epoch".to_string())
}

fn restore_staging_root(gateway: &DatabaseGateway) -> PathBuf {
    gateway.database_directory().join(RESTORE_STAGING_DIRECTORY)
}

fn safety_directory(gateway: &DatabaseGateway) -> PathBuf {
    gateway
        .database_directory()
        .join("safety-backups")
        .join("pre-restore")
}

fn restore_staging(gateway: &DatabaseGateway, restore_id: &str) -> BackupResult<PathBuf> {
    if restore_id.len() != RESTORE_ID_BYTES * 2
        || !restore_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid library restore ID".into());
    }
    Ok(restore_staging_root(gateway).join(restore_id))
}

fn new_restore_id() -> BackupResult<String> {
    let mut bytes = [0u8; RESTORE_ID_BYTES];
    getrandom::getrandom(&mut bytes).map_err(|_| "could not create a restore ID".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn file_name_of(path: &std::path::Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> BackupResult<T> + Send + 'static,
) -> BackupResult<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("library backup task failed: {error}"))?
}

/// Save every project of the open library and its asset files as one
/// `.drifting` package at a location the author picks.
#[tauri::command]
pub async fn library_backup_export(
    app: AppHandle,
    gateway: State<'_, DatabaseGateway>,
    client_session_id: String,
    suggested_file_name: String,
) -> BackupResult<LibraryBackupExportResult> {
    if suggested_file_name.contains(['/', '\\', '\0'])
        || !suggested_file_name.ends_with(&format!(".{BACKUP_EXTENSION}"))
    {
        return Err("invalid backup file name".into());
    }
    let selected = run_blocking({
        let app = app.clone();
        move || {
            Ok(app
                .dialog()
                .file()
                .set_picker_mode(PickerMode::Document)
                .set_file_access_mode(FileAccessMode::Scoped)
                .set_file_name(suggested_file_name)
                .add_filter("Drifting backup", &[BACKUP_EXTENSION])
                .blocking_save_file())
        }
    })
    .await?;
    let Some(selected) = selected else {
        return Ok(LibraryBackupExportResult {
            canceled: true,
            file_name: None,
            summary: None,
        });
    };
    let destination = selected
        .into_path()
        .map_err(|_| "the selected backup location cannot be written".to_string())?;
    let assets_root = app_local_dir(&app, "assets")?;
    let gateway = gateway.inner().clone();
    let file_name = file_name_of(&destination);
    let summary = run_blocking(move || {
        let created_at_ms = now_ms()?;
        let snapshot = gateway
            .database_directory()
            .join(format!(".library-backup-{created_at_ms}-{}.sqlite", new_restore_id()?));
        gateway.snapshot_active_database(snapshot.clone(), client_session_id)?;
        let written = write_backup_package(
            &snapshot,
            &assets_root,
            &destination,
            env!("CARGO_PKG_VERSION"),
            created_at_ms,
        );
        let _ = fs::remove_file(&snapshot);
        written
    })
    .await?;
    Ok(LibraryBackupExportResult {
        canceled: false,
        file_name,
        summary: Some(summary),
    })
}

/// Pick a `.drifting` package, then extract, verify and migrate it into a
/// private staging directory. Nothing in the live library changes.
#[tauri::command]
pub async fn library_backup_inspect(
    app: AppHandle,
    gateway: State<'_, DatabaseGateway>,
    project_user_id: String,
    now_iso: String,
) -> BackupResult<LibraryBackupInspectResult> {
    let selected = run_blocking({
        let app = app.clone();
        move || {
            Ok(app
                .dialog()
                .file()
                .set_picker_mode(PickerMode::Document)
                .add_filter("Drifting backup", &[BACKUP_EXTENSION])
                .blocking_pick_file())
        }
    })
    .await?;
    let Some(selected) = selected else {
        return Ok(LibraryBackupInspectResult {
            canceled: true,
            restore_id: None,
            file_name: None,
            summary: None,
        });
    };
    let package = selected
        .into_path()
        .map_err(|_| "the selected backup cannot be read".to_string())?;
    let file_name = file_name_of(&package);
    let gateway = gateway.inner().clone();
    let (restore_id, summary) = run_blocking(move || {
        // One restore is staged at a time; earlier abandoned stagings go.
        let root = restore_staging_root(&gateway);
        if root.exists() {
            fs::remove_dir_all(&root)
                .map_err(|error| format!("failed to clear an earlier restore: {error}"))?;
        }
        let restore_id = new_restore_id()?;
        let staging = restore_staging(&gateway, &restore_id)?;
        let summary = stage_backup_package(&package, &staging, &project_user_id, &now_iso)?;
        Ok((restore_id, summary))
    })
    .await?;
    Ok(LibraryBackupInspectResult {
        canceled: false,
        restore_id: Some(restore_id),
        file_name,
        summary: Some(summary),
    })
}

/// Replace the open library with a staged package. The current library is
/// first saved as a pre-restore package in the safety directory.
#[tauri::command]
pub async fn library_backup_restore(
    app: AppHandle,
    gateway: State<'_, DatabaseGateway>,
    restore_id: String,
    database_name: String,
    client_session_id: String,
) -> BackupResult<LibraryRestoreOutcome> {
    let gateway = gateway.inner().clone();
    let assets_root = app_local_dir(&app, "assets")?;
    run_blocking(move || {
        let plan = LibraryRestorePlan {
            staging: restore_staging(&gateway, &restore_id)?,
            assets_root,
            safety_directory: safety_directory(&gateway),
            app_version: env!("CARGO_PKG_VERSION").into(),
            now_ms: now_ms()?,
        };
        gateway.restore_library_backup(database_name, plan, client_session_id)
    })
    .await
}

#[tauri::command]
pub async fn library_backup_discard(
    gateway: State<'_, DatabaseGateway>,
    restore_id: String,
) -> BackupResult<()> {
    let staging = restore_staging(gateway.inner(), &restore_id)?;
    run_blocking(move || match fs::remove_dir_all(&staging) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to discard the staged backup: {error}")),
    })
    .await
}

#[tauri::command]
pub fn library_backup_open_safety_directory(
    app: AppHandle,
    gateway: State<'_, DatabaseGateway>,
) -> BackupResult<()> {
    let directory = safety_directory(gateway.inner());
    fs::create_dir_all(&directory)
        .map_err(|_| "could not prepare the pre-restore backup directory".to_string())?;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|_| "could not open the pre-restore backup directory".to_string())
}
