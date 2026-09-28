//! Recovery after the workspace database stopped opening. An upgrade that
//! fails leaves the previous database untouched and a verified safety copy
//! with a recovery receipt; `workspaceOpen` then fails with
//! `database-recovery:<session>:<code>`. These commands read that failure,
//! rebuild the database from the safety copy, and name the copy and its
//! folder so the host can save or show them. Nothing here opens a workspace.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RecoveryCommand {
    /// `{code, message, recoverySessionId?, sourceVersion?, targetVersion,
    /// safetyBackup?: {backupId, sha256, sizeBytes, createdAtMs}}` for the
    /// error `workspaceOpen` returned.
    Status { error: String },
    /// Migrates the verified safety copy again in a shadow database and
    /// activates it; `workspaceOpen` then opens it.
    Restore {
        recovery_session_id: String,
        backup_id: String,
    },
    /// The verified safety copy's path, for the host to copy elsewhere.
    BackupFile {
        recovery_session_id: String,
        backup_id: String,
    },
    /// The folder holding the safety copy.
    BackupFolder { recovery_session_id: String },
}

pub(super) fn recover(directory: &Path, command: &RecoveryCommand) -> Result<Value, String> {
    Ok(match command {
        RecoveryCommand::Status { error } => {
            json!(DatabaseGateway::new(directory.to_path_buf())?.recovery_failure(error.clone()))
        }
        RecoveryCommand::Restore {
            recovery_session_id,
            backup_id,
        } => {
            // Only the gateway whose open failed may restore.
            let mut recoveries = recoveries()?;
            let gateway = recoveries
                .get(directory)
                .ok_or("Open the workspace again before restoring its safety copy")?;
            let restored = gateway.restore_safety_backup(
                recovery_session_id.clone(),
                backup_id.clone(),
                CLIENT.into(),
            )?;
            gateway.close(CLIENT.into())?;
            recoveries.remove(directory);
            json!({"migrationsApplied": restored.migrations_applied})
        }
        RecoveryCommand::BackupFile {
            recovery_session_id,
            backup_id,
        } => json!({"path": DatabaseGateway::new(directory.to_path_buf())?
            .verified_recovery_backup(recovery_session_id, backup_id)?}),
        RecoveryCommand::BackupFolder {
            recovery_session_id,
        } => json!({"path": DatabaseGateway::new(directory.to_path_buf())?
            .recovery_backup_directory(recovery_session_id)?}),
    })
}
