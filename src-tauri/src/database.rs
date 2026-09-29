//! Tauri commands only. SQLite ownership and migration/recovery live in drifting-core.
pub use drifting_core::database::{
    DatabaseCheckpointResult, DatabaseExecuteResult, DatabaseGateway, DatabaseOpenFailure,
    DatabaseOpenResult, DatabaseTransaction, TransactionBehavior,
};
use drifting_core::database_transport::{CompactDatabaseQueryResult, CompactDatabaseValue};
use drifting_core::file_io::{durable_replace_file, temporary_sibling};
use serde::Serialize;
use std::fs::{self, File};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
use tauri_plugin_opener::OpenerExt;
type DatabaseResult<T> = Result<T, String>;

fn parse_transaction_id(transaction_id: String) -> DatabaseResult<u64> {
    transaction_id
        .parse::<u64>()
        .map_err(|_| "invalid transaction ID".to_string())
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> DatabaseResult<T> + Send + 'static,
) -> DatabaseResult<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("database task failed: {error}"))?
}

async fn run_database_open(
    gateway: DatabaseGateway,
    operation: impl FnOnce(DatabaseGateway) -> DatabaseResult<DatabaseOpenResult> + Send + 'static,
) -> Result<DatabaseOpenResult, DatabaseOpenFailure> {
    let error_gateway = gateway.clone();
    match tauri::async_runtime::spawn_blocking(move || operation(gateway)).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(error_gateway.recovery_failure(error)),
        Err(_) => {
            Err(error_gateway.recovery_failure("database worker task stopped unexpectedly".into()))
        }
    }
}

#[tauri::command]
pub async fn database_open(
    gateway: State<'_, DatabaseGateway>,
    database_name: String,
    client_session_id: String,
    recover_stale_transaction: Option<bool>,
) -> Result<DatabaseOpenResult, DatabaseOpenFailure> {
    let gateway = gateway.inner().clone();
    run_database_open(gateway, move |gateway| {
        gateway.open(
            database_name,
            client_session_id,
            recover_stale_transaction.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub fn database_recovery_status(
    gateway: State<'_, DatabaseGateway>,
    recovery_session_id: String,
) -> Result<DatabaseOpenFailure, String> {
    gateway.recovery_status(&recovery_session_id)
}

#[tauri::command]
pub async fn database_recovery_retry(
    gateway: State<'_, DatabaseGateway>,
    recovery_session_id: String,
    client_session_id: String,
) -> Result<DatabaseOpenResult, DatabaseOpenFailure> {
    let gateway = gateway.inner().clone();
    run_database_open(gateway, move |gateway| {
        gateway.retry_recovery(&recovery_session_id, client_session_id)
    })
    .await
}

#[tauri::command]
pub async fn database_recovery_restore_safety_backup(
    gateway: State<'_, DatabaseGateway>,
    recovery_session_id: String,
    backup_id: String,
    client_session_id: String,
) -> Result<DatabaseOpenResult, DatabaseOpenFailure> {
    let gateway = gateway.inner().clone();
    run_database_open(gateway, move |gateway| {
        gateway.restore_safety_backup(recovery_session_id, backup_id, client_session_id)
    })
    .await
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRecoveryExportResult {
    ok: bool,
    canceled: bool,
    file_name: Option<String>,
}

#[tauri::command]
pub async fn database_recovery_export_safety_backup(
    app: AppHandle,
    gateway: State<'_, DatabaseGateway>,
    recovery_session_id: String,
    backup_id: String,
) -> DatabaseResult<DatabaseRecoveryExportResult> {
    let source = gateway.verified_recovery_backup(&recovery_session_id, &backup_id)?;
    let file_name = format!("Drifting-database-safety-{}.sqlite", &backup_id[..16]);
    let selected = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let file_name = file_name.clone();
        move || {
            app.dialog()
                .file()
                .set_picker_mode(PickerMode::Document)
                .set_file_access_mode(FileAccessMode::Scoped)
                .set_file_name(file_name)
                .add_filter("SQLite database", &["sqlite"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|_| "database safety export dialog failed".to_string())?;
    let Some(selected) = selected else {
        return Ok(DatabaseRecoveryExportResult {
            ok: false,
            canceled: true,
            file_name: None,
        });
    };
    let destination = selected
        .into_path()
        .map_err(|_| "selected export location cannot be written durably".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let temporary = temporary_sibling(&destination)
            .map_err(|error| format!("failed to create export temporary file: {error}"))?;
        let outcome = fs::copy(&source, &temporary)
            .map_err(|error| format!("failed to copy database safety backup: {error}"))
            .and_then(|_| {
                File::open(&temporary)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| format!("failed to finalize database safety export: {error}"))
            })
            .and_then(|_| {
                durable_replace_file(&temporary, &destination)
                    .map_err(|error| format!("failed to activate database safety export: {error}"))
            });
        if outcome.is_err() {
            let _ = fs::remove_file(temporary);
        }
        outcome
    })
    .await
    .map_err(|_| "database safety export worker failed".to_string())??;
    Ok(DatabaseRecoveryExportResult {
        ok: true,
        canceled: false,
        file_name: Some(file_name),
    })
}

#[tauri::command]
pub fn database_recovery_open_backup_directory(
    app: AppHandle,
    gateway: State<'_, DatabaseGateway>,
    recovery_session_id: String,
) -> DatabaseResult<()> {
    let directory = gateway.recovery_backup_directory(&recovery_session_id)?;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|_| "could not open the database safety backup directory".to_string())
}

#[tauri::command]
pub async fn database_execute(
    gateway: State<'_, DatabaseGateway>,
    sql: String,
    parameters: Option<Vec<CompactDatabaseValue>>,
    transaction_id: Option<String>,
    client_session_id: String,
) -> DatabaseResult<DatabaseExecuteResult> {
    let transaction_id = transaction_id.map(parse_transaction_id).transpose()?;
    let gateway = gateway.inner().clone();
    run_blocking(move || {
        gateway.execute(
            sql,
            parameters
                .unwrap_or_default()
                .into_iter()
                .map(|value| value.0)
                .collect(),
            transaction_id,
            client_session_id,
        )
    })
    .await
}

#[tauri::command]
pub async fn database_query(
    gateway: State<'_, DatabaseGateway>,
    sql: String,
    parameters: Option<Vec<CompactDatabaseValue>>,
    transaction_id: Option<String>,
    client_session_id: String,
) -> DatabaseResult<CompactDatabaseQueryResult> {
    let transaction_id = transaction_id.map(parse_transaction_id).transpose()?;
    let gateway = gateway.inner().clone();
    run_blocking(move || {
        gateway
            .query(
                sql,
                parameters
                    .unwrap_or_default()
                    .into_iter()
                    .map(|value| value.0)
                    .collect(),
                transaction_id,
                client_session_id,
            )
            .map(CompactDatabaseQueryResult::from)
    })
    .await
}

/// Read-only acceleration for closed search documents; never publishes Yrs
/// state to the editor or mutates prose/projection rows.
#[tauri::command]
pub async fn database_read_prose_search(
    gateway: State<'_, DatabaseGateway>,
    doc_ids: Vec<String>,
    client_session_id: String,
) -> DatabaseResult<Vec<drifting_prose::search::SearchTextProjection>> {
    let gateway = gateway.inner().clone();
    run_blocking(move || {
        drifting_prose::search::read_search_text(&gateway, &client_session_id, &doc_ids)
    })
    .await
}

#[tauri::command]
pub async fn database_begin(
    gateway: State<'_, DatabaseGateway>,
    behavior: Option<TransactionBehavior>,
    client_session_id: String,
) -> DatabaseResult<DatabaseTransaction> {
    let gateway = gateway.inner().clone();
    let transaction_id =
        run_blocking(move || gateway.begin(behavior.unwrap_or_default(), client_session_id))
            .await?;
    Ok(DatabaseTransaction {
        id: transaction_id.to_string(),
    })
}

#[tauri::command]
pub async fn database_commit(
    gateway: State<'_, DatabaseGateway>,
    transaction_id: String,
    client_session_id: String,
) -> DatabaseResult<()> {
    let transaction_id = parse_transaction_id(transaction_id)?;
    let gateway = gateway.inner().clone();
    run_blocking(move || gateway.commit(transaction_id, client_session_id)).await
}

#[tauri::command]
pub async fn database_rollback(
    gateway: State<'_, DatabaseGateway>,
    transaction_id: String,
    client_session_id: String,
) -> DatabaseResult<()> {
    let transaction_id = parse_transaction_id(transaction_id)?;
    let gateway = gateway.inner().clone();
    run_blocking(move || gateway.rollback(transaction_id, client_session_id)).await
}

#[tauri::command]
pub async fn database_checkpoint(
    gateway: State<'_, DatabaseGateway>,
    client_session_id: String,
) -> DatabaseResult<DatabaseCheckpointResult> {
    let gateway = gateway.inner().clone();
    run_blocking(move || gateway.checkpoint(client_session_id)).await
}

#[tauri::command]
pub async fn database_close(
    gateway: State<'_, DatabaseGateway>,
    client_session_id: String,
) -> DatabaseResult<()> {
    let gateway = gateway.inner().clone();
    run_blocking(move || gateway.close(client_session_id)).await
}
