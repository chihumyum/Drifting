use std::collections::VecDeque;
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use include_dir::{include_dir, Dir};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
use tauri_plugin_opener::OpenerExt;

use crate::native_capabilities::{atomic_write, durable_replace_file, temporary_sibling};

type DatabaseResult<T> = Result<T, String>;
type Response<T> = mpsc::Sender<DatabaseResult<T>>;

const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_SESSION_ID_MAX_LENGTH: usize = 128;
const MIGRATION_BREAKPOINT: &str = "--> statement-breakpoint";
const MIGRATIONS_TABLE: &str = "__drizzle_migrations";
const SAFETY_BACKUPS_PER_VERSION: usize = 3;
const RECOVERY_RECEIPT_VERSION: u8 = 1;
const RECOVERY_FAILURE_PREFIX: &str = "database-recovery:";

// The journal remains the single migration manifest. `include_dir!` embeds the
// journal and every referenced SQL file into desktop and mobile binaries, so a
// packaged application never depends on a writable/external migration folder.
static DRIZZLE_MIGRATIONS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../drizzle");

/// JSON-safe SQLite value used at the Tauri boundary.
///
/// SQLite integers are always represented as decimal strings. JavaScript can
/// therefore choose `number` for safe values and `bigint` for the full i64
/// range without first losing precision in JSON parsing.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum DatabaseValue {
    Null,
    Integer(String),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExecuteResult {
    changes: u64,
    last_insert_rowid: DatabaseValue,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<DatabaseValue>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOpenResult {
    path: String,
    journal_mode: String,
    migrations_applied: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSafetyBackupSummary {
    backup_id: String,
    sha256: String,
    size_bytes: u64,
    created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOpenFailure {
    code: String,
    message: String,
    recovery_session_id: Option<String>,
    source_version: Option<String>,
    target_version: String,
    safety_backup: Option<DatabaseSafetyBackupSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseRecoveryReceipt {
    version: u8,
    recovery_session_id: String,
    database_name: String,
    source_version: Option<String>,
    target_version: String,
    backup_id: String,
    backup_file_name: String,
    backup_sha256: String,
    backup_size_bytes: u64,
    created_at_ms: u64,
    state: String,
    candidate_file_name: Option<String>,
    failed_stage: String,
    error_code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCheckpointResult {
    busy: u64,
    log_frames: u64,
    checkpointed_frames: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTransaction {
    /// Decimal string for the same JSON precision reason as SQLite integers.
    id: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransactionBehavior {
    #[default]
    Deferred,
    Immediate,
    Exclusive,
}

impl TransactionBehavior {
    fn begin_sql(self) -> &'static str {
        match self {
            Self::Deferred => "BEGIN DEFERRED",
            Self::Immediate => "BEGIN IMMEDIATE",
            Self::Exclusive => "BEGIN EXCLUSIVE",
        }
    }
}

enum Request {
    Open {
        database_name: String,
        client_session_id: String,
        recover_stale_transaction: bool,
        response: Response<DatabaseOpenResult>,
    },
    Execute {
        client_session_id: String,
        sql: String,
        parameters: Vec<DatabaseValue>,
        transaction_id: Option<u64>,
        response: Response<DatabaseExecuteResult>,
    },
    Query {
        client_session_id: String,
        sql: String,
        parameters: Vec<DatabaseValue>,
        transaction_id: Option<u64>,
        response: Response<DatabaseQueryResult>,
    },
    Begin {
        client_session_id: String,
        behavior: TransactionBehavior,
        response: Response<u64>,
    },
    Commit {
        client_session_id: String,
        transaction_id: u64,
        response: Response<()>,
    },
    Rollback {
        client_session_id: String,
        transaction_id: u64,
        response: Response<()>,
    },
    Checkpoint {
        client_session_id: String,
        response: Response<DatabaseCheckpointResult>,
    },
    Close {
        client_session_id: String,
        response: Response<()>,
    },
    RestoreSafetyBackup {
        recovery_session_id: String,
        backup_id: String,
        client_session_id: String,
        response: Response<DatabaseOpenResult>,
    },
    Shutdown,
}

struct GatewayInner {
    sender: mpsc::Sender<Request>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    database_directory: PathBuf,
}

impl Drop for GatewayInner {
    fn drop(&mut self) {
        let _ = self.sender.send(Request::Shutdown);
        if let Some(worker) = self
            .worker
            .lock()
            .expect("database worker mutex poisoned")
            .take()
        {
            let _ = worker.join();
        }
    }
}

/// Cloneable handle to the one dedicated thread that owns the SQLite
/// connection. `rusqlite::Connection` never crosses threads and every request
/// is serialized by this worker.
#[derive(Clone)]
pub struct DatabaseGateway {
    inner: Arc<GatewayInner>,
}

impl DatabaseGateway {
    pub fn new(database_directory: PathBuf) -> DatabaseResult<Self> {
        let (sender, receiver) = mpsc::channel();
        let worker_directory = database_directory.clone();
        let worker = thread::Builder::new()
            .name("drifting-sqlite".into())
            .spawn(move || worker_loop(receiver, worker_directory))
            .map_err(|error| format!("failed to start SQLite worker: {error}"))?;

        Ok(Self {
            inner: Arc::new(GatewayInner {
                sender,
                worker: Mutex::new(Some(worker)),
                database_directory,
            }),
        })
    }

    fn recovery_failure(&self, error: String) -> DatabaseOpenFailure {
        let Some((session_id, fallback_code)) = parse_recovery_failure(&error) else {
            return DatabaseOpenFailure {
                code: "database-open-failed".into(),
                message: "Drifting could not open the local library database.".into(),
                recovery_session_id: None,
                source_version: None,
                target_version: env!("CARGO_PKG_VERSION").into(),
                safety_backup: None,
            };
        };

        read_recovery_receipt(&self.inner.database_directory, session_id)
            .map(|receipt| DatabaseOpenFailure {
                code: receipt.error_code.clone(),
                message: "The local library upgrade stopped before activation. Your previous database is still available.".into(),
                recovery_session_id: Some(receipt.recovery_session_id.clone()),
                source_version: receipt.source_version.clone(),
                target_version: receipt.target_version.clone(),
                safety_backup: Some(DatabaseSafetyBackupSummary {
                    backup_id: receipt.backup_id,
                    sha256: receipt.backup_sha256,
                    size_bytes: receipt.backup_size_bytes,
                    created_at_ms: receipt.created_at_ms,
                }),
            })
            .unwrap_or_else(|_| DatabaseOpenFailure {
                code: fallback_code.to_owned(),
                message: "The local library upgrade is incomplete and its recovery receipt could not be verified.".into(),
                recovery_session_id: Some(session_id.to_owned()),
                source_version: None,
                target_version: env!("CARGO_PKG_VERSION").into(),
                safety_backup: None,
            })
    }

    fn request<T>(&self, create_request: impl FnOnce(Response<T>) -> Request) -> DatabaseResult<T> {
        let (response, receiver) = mpsc::channel();
        self.inner
            .sender
            .send(create_request(response))
            .map_err(|_| "SQLite worker is unavailable".to_string())?;
        receiver
            .recv()
            .map_err(|_| "SQLite worker stopped before replying".to_string())?
    }

    pub fn open(
        &self,
        database_name: String,
        client_session_id: String,
        recover_stale_transaction: bool,
    ) -> DatabaseResult<DatabaseOpenResult> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Open {
            database_name,
            client_session_id,
            recover_stale_transaction,
            response,
        })
    }

    pub fn execute(
        &self,
        sql: String,
        parameters: Vec<DatabaseValue>,
        transaction_id: Option<u64>,
        client_session_id: String,
    ) -> DatabaseResult<DatabaseExecuteResult> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Execute {
            client_session_id,
            sql,
            parameters,
            transaction_id,
            response,
        })
    }

    pub fn query(
        &self,
        sql: String,
        parameters: Vec<DatabaseValue>,
        transaction_id: Option<u64>,
        client_session_id: String,
    ) -> DatabaseResult<DatabaseQueryResult> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Query {
            client_session_id,
            sql,
            parameters,
            transaction_id,
            response,
        })
    }

    pub fn begin(
        &self,
        behavior: TransactionBehavior,
        client_session_id: String,
    ) -> DatabaseResult<u64> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Begin {
            client_session_id,
            behavior,
            response,
        })
    }

    pub fn commit(&self, transaction_id: u64, client_session_id: String) -> DatabaseResult<()> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Commit {
            client_session_id,
            transaction_id,
            response,
        })
    }

    pub fn rollback(&self, transaction_id: u64, client_session_id: String) -> DatabaseResult<()> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Rollback {
            client_session_id,
            transaction_id,
            response,
        })
    }

    pub fn checkpoint(
        &self,
        client_session_id: String,
    ) -> DatabaseResult<DatabaseCheckpointResult> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Checkpoint {
            client_session_id,
            response,
        })
    }

    pub fn close(&self, client_session_id: String) -> DatabaseResult<()> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::Close {
            client_session_id,
            response,
        })
    }

    pub fn restore_safety_backup(
        &self,
        recovery_session_id: String,
        backup_id: String,
        client_session_id: String,
    ) -> DatabaseResult<DatabaseOpenResult> {
        validate_client_session_id(&client_session_id)?;
        self.request(|response| Request::RestoreSafetyBackup {
            recovery_session_id,
            backup_id,
            client_session_id,
            response,
        })
    }

    fn recovery_receipt(
        &self,
        recovery_session_id: &str,
    ) -> DatabaseResult<DatabaseRecoveryReceipt> {
        read_recovery_receipt(&self.inner.database_directory, recovery_session_id)
    }
}

struct OpenDatabase {
    connection: Connection,
    path: PathBuf,
    journal_mode: String,
}

fn worker_loop(receiver: mpsc::Receiver<Request>, database_directory: PathBuf) {
    let mut database: Option<OpenDatabase> = None;
    let mut active_transaction: Option<u64> = None;
    let mut client_session_id: Option<String> = None;
    let next_transaction_id = AtomicU64::new(1);
    let mut ready = VecDeque::new();
    let mut deferred = VecDeque::new();

    loop {
        let request = match ready.pop_front() {
            Some(request) => request,
            None => match receiver.recv() {
                Ok(request) => request,
                Err(_) => break,
            },
        };

        if should_defer(&request, active_transaction, client_session_id.as_deref()) {
            deferred.push_back(request);
            continue;
        }

        let transaction_before_request = active_transaction;
        let shutdown = process_request(
            request,
            &database_directory,
            &mut database,
            &mut active_transaction,
            &mut client_session_id,
            &next_transaction_id,
        );

        if transaction_before_request.is_some() && active_transaction.is_none() {
            ready.append(&mut deferred);
        }

        if shutdown {
            break;
        }
    }

    if active_transaction.take().is_some() {
        if let Some(open_database) = database.as_ref() {
            let _ = open_database.connection.execute_batch("ROLLBACK");
        }
    }
    if let Some(open_database) = database.take() {
        let _ = close_database(open_database);
    }
}

fn should_defer(
    request: &Request,
    active_transaction: Option<u64>,
    current_client_session_id: Option<&str>,
) -> bool {
    let Some(active_transaction) = active_transaction else {
        return false;
    };

    let Some(request_client_session_id) = request.client_session_id() else {
        return false;
    };
    if Some(request_client_session_id) != current_client_session_id {
        return false;
    }

    match request {
        Request::Execute { transaction_id, .. } | Request::Query { transaction_id, .. } => {
            *transaction_id != Some(active_transaction)
        }
        Request::Begin { .. } => true,
        Request::Open { .. }
        | Request::Commit { .. }
        | Request::Rollback { .. }
        | Request::Checkpoint { .. }
        | Request::Close { .. }
        | Request::RestoreSafetyBackup { .. }
        | Request::Shutdown => false,
    }
}

impl Request {
    fn client_session_id(&self) -> Option<&str> {
        match self {
            Self::Open {
                client_session_id, ..
            }
            | Self::Execute {
                client_session_id, ..
            }
            | Self::Query {
                client_session_id, ..
            }
            | Self::Begin {
                client_session_id, ..
            }
            | Self::Commit {
                client_session_id, ..
            }
            | Self::Rollback {
                client_session_id, ..
            }
            | Self::Checkpoint {
                client_session_id, ..
            }
            | Self::Close {
                client_session_id, ..
            }
            | Self::RestoreSafetyBackup {
                client_session_id, ..
            } => Some(client_session_id),
            Self::Shutdown => None,
        }
    }
}

fn process_request(
    request: Request,
    database_directory: &Path,
    database: &mut Option<OpenDatabase>,
    active_transaction: &mut Option<u64>,
    current_client_session_id: &mut Option<String>,
    next_transaction_id: &AtomicU64,
) -> bool {
    match request {
        Request::Open {
            database_name,
            client_session_id,
            recover_stale_transaction,
            response,
        } => {
            let result = open_for_client_session(
                database,
                active_transaction,
                current_client_session_id,
                database_directory,
                &database_name,
                &client_session_id,
                recover_stale_transaction,
            );
            let _ = response.send(result);
        }
        Request::Execute {
            client_session_id,
            sql,
            parameters,
            transaction_id,
            response,
        } => {
            let result = ensure_client_session_access(
                current_client_session_id.as_deref(),
                &client_session_id,
            )
            .and_then(|()| {
                with_connection(database, |connection| {
                    ensure_transaction_access(*active_transaction, transaction_id)?;
                    validate_transaction_sql(&sql, transaction_id.is_some())?;
                    execute_sql(connection, &sql, parameters)
                })
            });
            let _ = response.send(result);
        }
        Request::Query {
            client_session_id,
            sql,
            parameters,
            transaction_id,
            response,
        } => {
            let result = ensure_client_session_access(
                current_client_session_id.as_deref(),
                &client_session_id,
            )
            .and_then(|()| {
                with_connection(database, |connection| {
                    ensure_transaction_access(*active_transaction, transaction_id)?;
                    validate_transaction_sql(&sql, transaction_id.is_some())?;
                    query_sql(connection, &sql, parameters)
                })
            });
            let _ = response.send(result);
        }
        Request::Begin {
            client_session_id,
            behavior,
            response,
        } => {
            let result = ensure_client_session_access(
                current_client_session_id.as_deref(),
                &client_session_id,
            )
            .and_then(|()| {
                with_connection(database, |connection| {
                    if active_transaction.is_some() {
                        return Err("another transaction is already active".into());
                    }
                    connection
                        .execute_batch(behavior.begin_sql())
                        .map_err(|error| format!("failed to begin transaction: {error}"))?;
                    let transaction_id = next_transaction_id.fetch_add(1, Ordering::Relaxed);
                    if transaction_id == u64::MAX {
                        let _ = connection.execute_batch("ROLLBACK");
                        return Err("transaction ID space exhausted".into());
                    }
                    *active_transaction = Some(transaction_id);
                    Ok(transaction_id)
                })
            });
            let _ = response.send(result);
        }
        Request::Commit {
            client_session_id,
            transaction_id,
            response,
        } => {
            let result = ensure_client_session_access(
                current_client_session_id.as_deref(),
                &client_session_id,
            )
            .and_then(|()| {
                finish_transaction(database, active_transaction, transaction_id, "COMMIT")
            });
            let _ = response.send(result);
        }
        Request::Rollback {
            client_session_id,
            transaction_id,
            response,
        } => {
            let result = ensure_client_session_access(
                current_client_session_id.as_deref(),
                &client_session_id,
            )
            .and_then(|()| {
                finish_transaction(database, active_transaction, transaction_id, "ROLLBACK")
            });
            let _ = response.send(result);
        }
        Request::Checkpoint {
            client_session_id,
            response,
        } => {
            let result = ensure_client_session_access(
                current_client_session_id.as_deref(),
                &client_session_id,
            )
            .and_then(|()| {
                if active_transaction.is_some() {
                    Err("cannot checkpoint while a transaction is active".into())
                } else {
                    with_connection(database, checkpoint_database)
                }
            });
            let _ = response.send(result);
        }
        Request::Close {
            client_session_id,
            response,
        } => {
            let session_access = ensure_client_session_access(
                current_client_session_id.as_deref(),
                &client_session_id,
            );
            let result = match session_access {
                Ok(()) => {
                    let result = rollback_and_close(database, active_transaction);
                    // `rollback_and_close` consumes the connection even when
                    // checkpointing reports an error, so the lease is over.
                    *current_client_session_id = None;
                    result
                }
                Err(error) => Err(error),
            };
            let _ = response.send(result);
        }
        Request::RestoreSafetyBackup {
            recovery_session_id,
            backup_id,
            client_session_id,
            response,
        } => {
            let result = restore_safety_backup_for_client_session(
                database,
                active_transaction,
                current_client_session_id,
                database_directory,
                &recovery_session_id,
                &backup_id,
                &client_session_id,
            );
            let _ = response.send(result);
        }
        Request::Shutdown => {
            let _ = rollback_and_close(database, active_transaction);
            *current_client_session_id = None;
            return true;
        }
    }

    false
}

fn validate_client_session_id(client_session_id: &str) -> DatabaseResult<()> {
    if client_session_id.is_empty()
        || client_session_id.len() > CLIENT_SESSION_ID_MAX_LENGTH
        || !client_session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid database client session ID".into());
    }
    Ok(())
}

fn ensure_client_session_access(
    current_client_session_id: Option<&str>,
    requested_client_session_id: &str,
) -> DatabaseResult<()> {
    match current_client_session_id {
        Some(current) if current == requested_client_session_id => Ok(()),
        Some(_) => Err("database is owned by another renderer session".into()),
        None => Err("database is not open for this renderer session".into()),
    }
}

fn open_for_client_session(
    database: &mut Option<OpenDatabase>,
    active_transaction: &mut Option<u64>,
    current_client_session_id: &mut Option<String>,
    database_directory: &Path,
    database_name: &str,
    requested_client_session_id: &str,
    recover_stale_transaction: bool,
) -> DatabaseResult<DatabaseOpenResult> {
    // Reject an invalid target before an explicit takeover can mutate the
    // existing connection or roll back its transaction.
    resolve_database_path(database_directory, database_name)?;

    match current_client_session_id.as_deref() {
        Some(current) if current == requested_client_session_id => {
            if active_transaction.is_some() {
                return Err(
                    "cannot reopen the database while this renderer session has an active transaction"
                        .into(),
                );
            }
        }
        Some(_) => {
            if !recover_stale_transaction {
                return Err(
                    "database is owned by another renderer session; stale recovery is required"
                        .into(),
                );
            }
            if let Some(transaction_id) = *active_transaction {
                finish_transaction(database, active_transaction, transaction_id, "ROLLBACK")?;
            }
        }
        None => {
            if active_transaction.is_some() {
                return Err("database transaction has no renderer session owner".into());
            }
        }
    }

    // Claim the lease before opening. If opening or migration fails, a retry
    // from this same renderer remains valid while requests from the stale
    // renderer stay rejected.
    *current_client_session_id = Some(requested_client_session_id.to_owned());
    open_or_switch_database(database, database_directory, database_name)
}

fn restore_safety_backup_for_client_session(
    database: &mut Option<OpenDatabase>,
    active_transaction: &mut Option<u64>,
    current_client_session_id: &mut Option<String>,
    database_directory: &Path,
    recovery_session_id: &str,
    backup_id: &str,
    requested_client_session_id: &str,
) -> DatabaseResult<DatabaseOpenResult> {
    ensure_client_session_access(
        current_client_session_id.as_deref(),
        requested_client_session_id,
    )?;
    if active_transaction.is_some() || database.is_some() {
        return Err("database recovery requires a closed database".into());
    }
    let receipt = read_recovery_receipt(database_directory, recovery_session_id)?;
    if receipt.backup_id != backup_id {
        return Err("database recovery backup identity does not match".into());
    }
    let database_path = resolve_database_path(database_directory, &receipt.database_name)?;
    let backup_path = verify_recovery_backup(database_directory, &receipt)?;
    let migration =
        migrate_shadow_candidate(database_directory, &database_path, &backup_path, &receipt);
    let migrations_applied = match migration {
        Ok(applied) => applied,
        Err((stage, code, _detail)) => {
            let _ = update_recovery_failure(database_directory, recovery_session_id, stage, code);
            return Err(format!(
                "{RECOVERY_FAILURE_PREFIX}{recovery_session_id}:{code}"
            ));
        }
    };
    record_opened_app_version(database_directory, &database_path, &receipt.target_version)?;
    remove_recovery_receipt(database_directory, recovery_session_id);

    let (open_database, reopened_migrations) = open_database(database_directory, database_path)?;
    let result = DatabaseOpenResult {
        path: open_database.path.to_string_lossy().into_owned(),
        journal_mode: open_database.journal_mode.clone(),
        migrations_applied: migrations_applied.saturating_add(reopened_migrations),
    };
    *database = Some(open_database);
    Ok(result)
}

fn with_connection<T>(
    database: &mut Option<OpenDatabase>,
    operation: impl FnOnce(&Connection) -> DatabaseResult<T>,
) -> DatabaseResult<T> {
    let database = database
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;
    operation(&database.connection)
}

fn ensure_transaction_access(
    active_transaction: Option<u64>,
    requested_transaction: Option<u64>,
) -> DatabaseResult<()> {
    match (active_transaction, requested_transaction) {
        (None, None) => Ok(()),
        (Some(active), Some(requested)) if active == requested => Ok(()),
        (None, Some(_)) => Err("transaction is no longer active".into()),
        (Some(_), None) => Err("database is reserved by an active transaction".into()),
        (Some(_), Some(_)) => Err("transaction ID does not own the active transaction".into()),
    }
}

fn finish_transaction(
    database: &mut Option<OpenDatabase>,
    active_transaction: &mut Option<u64>,
    transaction_id: u64,
    sql: &'static str,
) -> DatabaseResult<()> {
    let connection = &database
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?
        .connection;
    ensure_transaction_access(*active_transaction, Some(transaction_id))?;

    match connection.execute_batch(sql) {
        Ok(()) => {
            *active_transaction = None;
            Ok(())
        }
        Err(error) => {
            if connection.is_autocommit() {
                *active_transaction = None;
            }
            Err(format!(
                "failed to {} transaction: {error}",
                sql.to_ascii_lowercase()
            ))
        }
    }
}

fn rollback_and_close(
    database: &mut Option<OpenDatabase>,
    active_transaction: &mut Option<u64>,
) -> DatabaseResult<()> {
    let rollback_error = if active_transaction.take().is_some() {
        database.as_ref().and_then(|database| {
            database
                .connection
                .execute_batch("ROLLBACK")
                .err()
                .map(|error| format!("failed to roll back active transaction: {error}"))
        })
    } else {
        None
    };

    let close_result = match database.take() {
        Some(database) => close_database(database),
        None => Ok(()),
    };

    match (rollback_error, close_result) {
        (None, result) => result,
        (Some(rollback_error), Ok(())) => Err(rollback_error),
        (Some(rollback_error), Err(close_error)) => Err(format!("{rollback_error}; {close_error}")),
    }
}

fn resolve_database_path(
    database_directory: &Path,
    database_name: &str,
) -> DatabaseResult<PathBuf> {
    if database_name.is_empty() || database_name.len() > 255 || database_name.contains('\0') {
        return Err("invalid database filename".into());
    }

    let path = Path::new(database_name);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("database name must be a filename, not a path".into());
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("db") {
        return Err("database filename must end in .db".into());
    }

    Ok(database_directory.join(path))
}

fn open_or_switch_database(
    database: &mut Option<OpenDatabase>,
    database_directory: &Path,
    database_name: &str,
) -> DatabaseResult<DatabaseOpenResult> {
    let target_path = resolve_database_path(database_directory, database_name)?;

    if let Some(open_database) = database.as_mut() {
        if open_database.path == target_path {
            let migrations_applied = apply_migrations(&open_database.connection)?;
            return Ok(DatabaseOpenResult {
                path: open_database.path.to_string_lossy().into_owned(),
                journal_mode: open_database.journal_mode.clone(),
                migrations_applied,
            });
        }
    }

    if let Some(open_database) = database.take() {
        close_database(open_database)?;
    }

    let (open_database, migrations_applied) = open_database(database_directory, target_path)?;
    let result = DatabaseOpenResult {
        path: open_database.path.to_string_lossy().into_owned(),
        journal_mode: open_database.journal_mode.clone(),
        migrations_applied,
    };
    *database = Some(open_database);
    Ok(result)
}

fn open_database(
    database_directory: &Path,
    database_path: PathBuf,
) -> DatabaseResult<(OpenDatabase, usize)> {
    fs::create_dir_all(database_directory)
        .map_err(|error| format!("failed to create database directory: {error}"))?;

    if fs::symlink_metadata(&database_path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("refusing to open a database through a symbolic link".into());
    }

    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let database_existed = database_path
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if database_existed {
        reconcile_incomplete_shadow_migration(database_directory, &database_path)?;
    }
    let mut connection = Connection::open_with_flags(&database_path, flags)
        .map_err(|error| format!("failed to open database: {error}"))?;
    let mut journal_mode = configure_active_connection(&connection)?;

    let marker_is_current = database_version_is_current(
        database_directory,
        &database_path,
        env!("CARGO_PKG_VERSION"),
    )?;
    let migrations_applied = if database_existed
        && (!marker_is_current || database_has_pending_migrations(&connection)?)
    {
        checkpoint_database(&connection)?;
        let safety_backup = create_pre_update_safety_backup(
            &connection,
            database_directory,
            &database_path,
            env!("CARGO_PKG_VERSION"),
        )?
        .ok_or_else(|| "database safety snapshot was unexpectedly skipped".to_string())?;
        let receipt = create_recovery_receipt(
            database_directory,
            &database_path,
            &safety_backup,
            "candidate-preparation",
            "migration-candidate-failed",
        )?;

        drop(connection);
        let migration_result =
            migrate_shadow_candidate(database_directory, &database_path, &safety_backup, &receipt);
        let applied = match migration_result {
            Ok(applied) => applied,
            Err((stage, code, _detail)) => {
                let recovery_session_id = receipt.recovery_session_id.clone();
                let _ =
                    update_recovery_failure(database_directory, &recovery_session_id, stage, code);
                return Err(format!(
                    "{RECOVERY_FAILURE_PREFIX}{}:{code}",
                    recovery_session_id
                ));
            }
        };

        connection = Connection::open_with_flags(&database_path, flags)
            .map_err(|error| format!("failed to reopen activated database: {error}"))?;
        journal_mode = configure_active_connection(&connection)?;
        validate_database_truth(&connection)?;
        record_opened_app_version(
            database_directory,
            &database_path,
            env!("CARGO_PKG_VERSION"),
        )?;
        remove_recovery_receipt(database_directory, &receipt.recovery_session_id);
        applied
    } else {
        let applied = apply_migrations(&connection)?;
        validate_database_truth(&connection)?;
        record_opened_app_version(
            database_directory,
            &database_path,
            env!("CARGO_PKG_VERSION"),
        )?;
        applied
    };
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("failed to enable foreign keys: {error}"))?;

    Ok((
        OpenDatabase {
            connection,
            path: database_path,
            journal_mode,
        },
        migrations_applied,
    ))
}

fn configure_active_connection(connection: &Connection) -> DatabaseResult<String> {
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(|error| format!("failed to configure SQLite busy timeout: {error}"))?;
    let journal_mode = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|error| format!("failed to enable WAL mode: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("failed to configure SQLite synchronous mode: {error}"))?;
    connection
        .pragma_update(None, "wal_autocheckpoint", 1_000_i64)
        .map_err(|error| format!("failed to configure WAL autocheckpoint: {error}"))?;
    Ok(journal_mode)
}

fn database_version_is_current(
    database_directory: &Path,
    database_path: &Path,
    app_version: &str,
) -> DatabaseResult<bool> {
    let marker = database_version_marker(database_directory, database_path)?;
    Ok(fs::read_to_string(marker)
        .map(|value| value.trim() == app_version)
        .unwrap_or(false))
}

/// A development build can append a public migration without changing its
/// package version. Such an upgrade still requires the verified shadow path.
fn database_has_pending_migrations(connection: &Connection) -> DatabaseResult<bool> {
    let journal_file = DRIZZLE_MIGRATIONS
        .get_file("meta/_journal.json")
        .ok_or_else(|| "embedded Drizzle migration journal is missing".to_string())?;
    let journal: MigrationJournal = serde_json::from_slice(journal_file.contents())
        .map_err(|error| format!("invalid embedded Drizzle migration journal: {error}"))?;
    validate_migration_journal(&journal)?;
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '__drizzle_migrations')", [], |row| row.get(0),
    ).map_err(|error| format!("failed to inspect migration journal: {error}"))?;
    if !exists {
        return Ok(true);
    }
    let applied: usize = connection
        .query_row(
            &format!("SELECT count(*) FROM {MIGRATIONS_TABLE}"),
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to count applied migrations: {error}"))?;
    Ok(applied < journal.entries.len())
}

fn database_opened_version(
    database_directory: &Path,
    database_path: &Path,
) -> DatabaseResult<Option<String>> {
    let marker = database_version_marker(database_directory, database_path)?;
    Ok(fs::read_to_string(marker)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty()))
}

fn recovery_directory(database_directory: &Path) -> PathBuf {
    database_directory.join("safety-backups").join("recovery")
}

fn recovery_receipt_path(database_directory: &Path, recovery_session_id: &str) -> PathBuf {
    recovery_directory(database_directory).join(format!("{recovery_session_id}.json"))
}

fn validate_opaque_id(value: &str) -> DatabaseResult<()> {
    if value.len() < 16
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("invalid recovery identifier".into());
    }
    Ok(())
}

fn file_sha256_and_size(path: &Path) -> DatabaseResult<(String, u64)> {
    use std::io::Read;

    let mut file =
        File::open(path).map_err(|error| format!("failed to open safety file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash safety file: {error}"))?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| "safety file size overflowed".to_string())?;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn create_recovery_receipt(
    database_directory: &Path,
    database_path: &Path,
    backup_path: &Path,
    stage: &str,
    error_code: &str,
) -> DatabaseResult<DatabaseRecoveryReceipt> {
    let database_name = database_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "database filename is not valid UTF-8".to_string())?;
    let backup_file_name = backup_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "database safety filename is not valid UTF-8".to_string())?;
    let (backup_sha256, backup_size_bytes) = file_sha256_and_size(backup_path)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?;
    let entropy = format!(
        "{database_name}:{}:{}:{}",
        created_at.as_nanos(),
        std::process::id(),
        backup_sha256
    );
    let recovery_session_id = format!("{:x}", Sha256::digest(entropy.as_bytes()));
    let backup_id = format!(
        "{:x}",
        Sha256::digest(format!("backup:{recovery_session_id}").as_bytes())
    );
    let receipt = DatabaseRecoveryReceipt {
        version: RECOVERY_RECEIPT_VERSION,
        recovery_session_id,
        database_name: database_name.to_owned(),
        source_version: database_opened_version(database_directory, database_path)?,
        target_version: env!("CARGO_PKG_VERSION").into(),
        backup_id,
        backup_file_name: backup_file_name.to_owned(),
        backup_sha256,
        backup_size_bytes,
        created_at_ms: created_at.as_millis().try_into().unwrap_or(u64::MAX),
        state: "snapshot-created".into(),
        candidate_file_name: None,
        failed_stage: stage.into(),
        error_code: error_code.into(),
    };
    write_recovery_receipt(database_directory, &receipt)?;
    Ok(receipt)
}

fn write_recovery_receipt(
    database_directory: &Path,
    receipt: &DatabaseRecoveryReceipt,
) -> DatabaseResult<()> {
    validate_opaque_id(&receipt.recovery_session_id)?;
    let path = recovery_receipt_path(database_directory, &receipt.recovery_session_id);
    let bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|error| format!("failed to encode database recovery receipt: {error}"))?;
    atomic_write(&path, &bytes)
        .map_err(|error| format!("failed to persist database recovery receipt: {error}"))
}

fn read_recovery_receipt(
    database_directory: &Path,
    recovery_session_id: &str,
) -> DatabaseResult<DatabaseRecoveryReceipt> {
    validate_opaque_id(recovery_session_id)?;
    let path = recovery_receipt_path(database_directory, recovery_session_id);
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read database recovery receipt: {error}"))?;
    let receipt: DatabaseRecoveryReceipt = serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to decode database recovery receipt: {error}"))?;
    if receipt.version != RECOVERY_RECEIPT_VERSION
        || receipt.recovery_session_id != recovery_session_id
    {
        return Err("database recovery receipt is not compatible".into());
    }
    Ok(receipt)
}

fn update_recovery_failure(
    database_directory: &Path,
    recovery_session_id: &str,
    stage: &str,
    code: &str,
) -> DatabaseResult<()> {
    let mut receipt = read_recovery_receipt(database_directory, recovery_session_id)?;
    receipt.failed_stage = stage.into();
    receipt.error_code = code.into();
    write_recovery_receipt(database_directory, &receipt)
}

fn remove_recovery_receipt(database_directory: &Path, recovery_session_id: &str) {
    if validate_opaque_id(recovery_session_id).is_ok() {
        let _ = fs::remove_file(recovery_receipt_path(
            database_directory,
            recovery_session_id,
        ));
    }
}

fn latest_recovery_receipt_for_database(
    database_directory: &Path,
    database_name: &str,
) -> DatabaseResult<Option<DatabaseRecoveryReceipt>> {
    let directory = recovery_directory(database_directory);
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to inspect database recovery receipts: {error}"
            ))
        }
    };
    let mut receipts = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("failed to inspect a database recovery receipt: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "database recovery receipt filename is invalid".to_string())?;
        if validate_opaque_id(session_id).is_err() {
            return Err("database recovery receipt filename is invalid".into());
        }
        let receipt = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DatabaseRecoveryReceipt>(&bytes).ok())
            .filter(|receipt| {
                receipt.version == RECOVERY_RECEIPT_VERSION
                    && receipt.recovery_session_id == session_id
            })
            .ok_or_else(|| {
                format!("{RECOVERY_FAILURE_PREFIX}{session_id}:recovery-receipt-invalid")
            })?;
        if receipt.database_name == database_name {
            receipts.push(receipt);
        }
    }
    receipts.sort_by_key(|receipt| receipt.created_at_ms);
    Ok(receipts.pop())
}

fn recovery_backup_path(
    database_directory: &Path,
    receipt: &DatabaseRecoveryReceipt,
) -> DatabaseResult<PathBuf> {
    let path = Path::new(&receipt.backup_file_name);
    if path.components().count() != 1 {
        return Err("invalid recovery backup filename".into());
    }
    Ok(database_directory
        .join("safety-backups")
        .join(&receipt.target_version)
        .join(path))
}

fn verify_recovery_backup(
    database_directory: &Path,
    receipt: &DatabaseRecoveryReceipt,
) -> DatabaseResult<PathBuf> {
    let path = recovery_backup_path(database_directory, receipt)?;
    let (hash, size) = file_sha256_and_size(&path)?;
    if hash != receipt.backup_sha256 || size != receipt.backup_size_bytes {
        return Err("database safety backup hash or size does not match its receipt".into());
    }
    Ok(path)
}

fn validate_database_truth(connection: &Connection) -> DatabaseResult<()> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("database integrity check failed to run: {error}"))?;
    if integrity != "ok" {
        return Err("database integrity check did not return ok".into());
    }
    let foreign_key_failure: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM pragma_foreign_key_check LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("database foreign key check failed to run: {error}"))?;
    if foreign_key_failure.is_some() {
        return Err("database foreign key check found invalid references".into());
    }
    validate_applied_migration_truth(connection)
}

/// Verify that the active database already contains the exact embedded
/// migration prefix. This path is deliberately read-only: restart
/// reconciliation after durable replacement must never migrate active
/// authority while deciding whether it is safe to complete the version marker.
fn validate_applied_migration_truth(connection: &Connection) -> DatabaseResult<()> {
    let journal_file = DRIZZLE_MIGRATIONS
        .get_file("meta/_journal.json")
        .ok_or_else(|| "embedded Drizzle migration journal is missing".to_string())?;
    let journal: MigrationJournal = serde_json::from_slice(journal_file.contents())
        .map_err(|error| format!("invalid embedded Drizzle migration journal: {error}"))?;
    validate_migration_journal(&journal)?;

    let migration_table_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            params![MIGRATIONS_TABLE],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect Drizzle migration state: {error}"))?;
    if !migration_table_exists {
        return Err("active database has no Drizzle migration journal".into());
    }

    let mut statement = connection
        .prepare(&format!(
            "SELECT hash, created_at FROM {MIGRATIONS_TABLE} ORDER BY created_at ASC"
        ))
        .map_err(|error| format!("failed to read Drizzle migration state: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(AppliedMigration {
                hash: row.get(0)?,
                when: row.get(1)?,
            })
        })
        .map_err(|error| format!("failed to read Drizzle migration state: {error}"))?;
    let applied = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read Drizzle migration state: {error}"))?;
    if applied.len() != journal.entries.len() {
        return Err(format!(
            "active database migration count does not match this build ({} != {})",
            applied.len(),
            journal.entries.len()
        ));
    }
    for (recorded, expected) in applied.iter().zip(&journal.entries) {
        let migration_path = format!("{}.sql", expected.tag);
        let migration_file = DRIZZLE_MIGRATIONS
            .get_file(&migration_path)
            .ok_or_else(|| format!("embedded migration is missing: {migration_path}"))?;
        let expected_hash = format!("{:x}", Sha256::digest(migration_file.contents()));
        if recorded.when != expected.when || recorded.hash != expected_hash {
            return Err(format!(
                "active database migration {} is not the expected journal entry",
                expected.tag
            ));
        }
    }
    Ok(())
}

fn migration_fault(stage: &str) -> DatabaseResult<()> {
    if cfg!(debug_assertions)
        && std::env::var("DRIFTING_TEST_DATABASE_KILL_STAGE").as_deref() == Ok(stage)
    {
        use std::io::Write;

        println!("DATABASE_MIGRATION_STAGE:{stage}");
        let _ = std::io::stdout().flush();
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }
    if cfg!(debug_assertions)
        && std::env::var("DRIFTING_TEST_DATABASE_FAULT_STAGE").as_deref() == Ok(stage)
    {
        return Err(format!("injected database migration fault at {stage}"));
    }
    Ok(())
}

type ShadowMigrationFailure = (&'static str, &'static str, String);

fn migrate_shadow_candidate(
    database_directory: &Path,
    database_path: &Path,
    backup_path: &Path,
    receipt: &DatabaseRecoveryReceipt,
) -> Result<usize, ShadowMigrationFailure> {
    let candidate = temporary_sibling(database_path).map_err(|error| {
        (
            "candidate-preparation",
            "candidate-create-failed",
            error.to_string(),
        )
    })?;
    let candidate_file_name = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or((
            "candidate-preparation",
            "candidate-create-failed",
            "candidate filename is not valid UTF-8".into(),
        ))?
        .to_owned();
    let mut active_receipt = receipt.clone();
    active_receipt.state = "candidate-created".into();
    active_receipt.candidate_file_name = Some(candidate_file_name);
    write_recovery_receipt(database_directory, &active_receipt)
        .map_err(|error| ("candidate-preparation", "receipt-write-failed", error))?;

    let outcome = (|| {
        migration_fault("snapshot-copy")
            .map_err(|error| ("snapshot-copy", "candidate-copy-failed", error))?;
        fs::copy(backup_path, &candidate)
            .map_err(|error| ("snapshot-copy", "candidate-copy-failed", error.to_string()))?;
        File::open(&candidate)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                (
                    "candidate-fsync",
                    "candidate-fsync-failed",
                    error.to_string(),
                )
            })?;
        migration_fault("candidate-fsync")
            .map_err(|error| ("candidate-fsync", "candidate-fsync-failed", error))?;

        let connection = Connection::open(&candidate)
            .map_err(|error| ("candidate-open", "candidate-open-failed", error.to_string()))?;
        connection
            .busy_timeout(DATABASE_BUSY_TIMEOUT)
            .map_err(|error| ("candidate-open", "candidate-open-failed", error.to_string()))?;
        connection
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(|error| ("candidate-open", "candidate-open-failed", error.to_string()))?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|error| ("candidate-open", "candidate-open-failed", error.to_string()))?;
        migration_fault("migration")
            .map_err(|error| ("migration", "migration-statement-failed", error))?;
        let applied = apply_migrations(&connection)
            .map_err(|error| ("migration", "migration-statement-failed", error))?;
        migration_fault("integrity-check")
            .map_err(|error| ("integrity-check", "integrity-check-failed", error))?;
        validate_database_truth(&connection)
            .map_err(|error| ("integrity-check", "integrity-check-failed", error))?;
        drop(connection);
        File::open(&candidate)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                (
                    "candidate-fsync",
                    "candidate-fsync-failed",
                    error.to_string(),
                )
            })?;
        migration_fault("post-migration-fsync")
            .map_err(|error| ("candidate-fsync", "candidate-fsync-failed", error))?;

        active_receipt.state = "replacing".into();
        active_receipt.failed_stage = "durable-replace".into();
        active_receipt.error_code = "durable-replace-failed".into();
        write_recovery_receipt(database_directory, &active_receipt)
            .map_err(|error| ("durable-replace", "receipt-write-failed", error))?;
        migration_fault("replace")
            .map_err(|error| ("durable-replace", "durable-replace-failed", error))?;
        remove_database_sidecars(database_path)
            .map_err(|error| ("durable-replace", "sidecar-cleanup-failed", error))?;
        durable_replace_file(&candidate, database_path).map_err(|error| {
            (
                "durable-replace",
                "durable-replace-failed",
                error.to_string(),
            )
        })?;
        migration_fault("marker")
            .map_err(|error| ("version-marker", "version-marker-failed", error))?;
        Ok(applied)
    })();

    if outcome.is_err() && candidate.exists() {
        let _ = fs::remove_file(&candidate);
    }
    outcome
}

fn remove_database_sidecars(database_path: &Path) -> DatabaseResult<()> {
    let Some(filename) = database_path.file_name().and_then(|value| value.to_str()) else {
        return Err("database filename is not valid UTF-8".into());
    };
    let parent = database_path
        .parent()
        .ok_or_else(|| "database path has no parent directory".to_string())?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = parent.join(format!("{filename}{suffix}"));
        match fs::remove_file(sidecar) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to remove a database sidecar: {error}")),
        }
    }
    Ok(())
}

fn reconcile_incomplete_shadow_migration(
    database_directory: &Path,
    database_path: &Path,
) -> DatabaseResult<()> {
    let database_name = database_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "database filename is not valid UTF-8".to_string())?;
    let Some(receipt) = latest_recovery_receipt_for_database(database_directory, database_name)?
    else {
        return Ok(());
    };
    verify_recovery_backup(database_directory, &receipt).map_err(|_| {
        format!(
            "{RECOVERY_FAILURE_PREFIX}{}:safety-backup-invalid",
            receipt.recovery_session_id
        )
    })?;

    let candidate_exists = receipt
        .candidate_file_name
        .as_deref()
        .map(|name| database_directory.join(name).is_file())
        .unwrap_or(false);
    if receipt.state != "replacing" || candidate_exists {
        if let Some(name) = receipt.candidate_file_name.as_deref() {
            let candidate = database_directory.join(name);
            let _ = fs::remove_file(candidate);
        }
        remove_recovery_receipt(database_directory, &receipt.recovery_session_id);
        return Ok(());
    }

    let connection = Connection::open(database_path).map_err(|_| {
        format!(
            "{RECOVERY_FAILURE_PREFIX}{}:activated-database-open-failed",
            receipt.recovery_session_id
        )
    })?;
    if validate_database_truth(&connection).is_err() {
        return Err(format!(
            "{RECOVERY_FAILURE_PREFIX}{}:activated-database-invalid",
            receipt.recovery_session_id
        ));
    }
    drop(connection);
    record_opened_app_version(database_directory, database_path, &receipt.target_version)?;
    remove_recovery_receipt(database_directory, &receipt.recovery_session_id);
    Ok(())
}

fn parse_recovery_failure(error: &str) -> Option<(&str, &str)> {
    let payload = error.strip_prefix(RECOVERY_FAILURE_PREFIX)?;
    payload.split_once(':')
}

fn database_version_marker(
    database_directory: &Path,
    database_path: &Path,
) -> DatabaseResult<PathBuf> {
    let filename = database_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "database filename is not valid UTF-8".to_string())?;
    Ok(database_directory
        .join("safety-backups")
        .join(format!("{filename}.last-version")))
}

fn record_opened_app_version(
    database_directory: &Path,
    database_path: &Path,
    app_version: &str,
) -> DatabaseResult<()> {
    let marker = database_version_marker(database_directory, database_path)?;
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("failed to create safety backup metadata directory: {error}")
        })?;
    }
    atomic_write(&marker, app_version.as_bytes())
        .map_err(|error| format!("failed to record the database safety version: {error}"))
}

fn retain_recent_database_safety_backups(directory: &Path) -> DatabaseResult<()> {
    let mut backups = fs::read_dir(directory)
        .map_err(|error| format!("failed to inspect database safety backups: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let name = entry.file_name().into_string().ok()?;
            (metadata.is_file() && name.ends_with(".sqlite")).then_some((
                entry.path(),
                metadata.modified().ok(),
                name,
            ))
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.2.cmp(&left.2)));
    for (path, _, _) in backups.into_iter().skip(SAFETY_BACKUPS_PER_VERSION) {
        fs::remove_file(path)
            .map_err(|error| format!("failed to prune an old database safety backup: {error}"))?;
    }
    Ok(())
}

/// Snapshot the committed SQLite truth before a new application version can
/// run migrations. `VACUUM INTO` includes WAL content in one standalone file
/// and does not modify the source database.
fn create_pre_update_safety_backup(
    connection: &Connection,
    database_directory: &Path,
    database_path: &Path,
    app_version: &str,
) -> DatabaseResult<Option<PathBuf>> {
    let marker = database_version_marker(database_directory, database_path)?;
    if fs::read_to_string(&marker)
        .map(|value| value.trim() == app_version)
        .unwrap_or(false)
        && !database_has_pending_migrations(connection)?
    {
        return Ok(None);
    }
    let database_name = database_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "database filename is not valid UTF-8".to_string())?;
    let directory = database_directory.join("safety-backups").join(app_version);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create database safety backup directory: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?
        .as_nanos();
    let destination = directory.join(format!("{database_name}-{timestamp}.sqlite"));
    let destination_text = destination
        .to_str()
        .ok_or_else(|| "database safety backup path is not valid UTF-8".to_string())?;
    connection
        .execute("VACUUM INTO ?1", params![destination_text])
        .map_err(|error| {
            format!("failed to create the pre-update database safety backup: {error}")
        })?;
    File::open(&destination)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            format!("failed to durably finalize the database safety backup: {error}")
        })?;
    sync_database_directory(&directory)
        .map_err(|error| format!("failed to durably record the database safety backup: {error}"))?;
    retain_recent_database_safety_backups(&directory)?;
    sync_database_directory(&directory).map_err(|error| {
        format!("failed to durably finalize database safety backup retention: {error}")
    })?;
    Ok(Some(destination))
}

#[cfg(unix)]
fn sync_database_directory(directory: &Path) -> std::io::Result<()> {
    File::open(directory)?.sync_all()
}

#[cfg(not(unix))]
fn sync_database_directory(_directory: &Path) -> std::io::Result<()> {
    Ok(())
}

fn close_database(database: OpenDatabase) -> DatabaseResult<()> {
    checkpoint_database(&database.connection)?;
    drop(database);
    Ok(())
}

fn checkpoint_database(connection: &Connection) -> DatabaseResult<DatabaseCheckpointResult> {
    let (busy, log_frames, checkpointed_frames): (i64, i64, i64) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| format!("WAL checkpoint failed: {error}"))?;

    Ok(DatabaseCheckpointResult {
        busy: nonnegative_u64("busy", busy)?,
        log_frames: nonnegative_u64("log frame", log_frames)?,
        checkpointed_frames: nonnegative_u64("checkpointed frame", checkpointed_frames)?,
    })
}

fn nonnegative_u64(label: &str, value: i64) -> DatabaseResult<u64> {
    value
        .try_into()
        .map_err(|_| format!("SQLite returned a negative {label} count"))
}

fn execute_sql(
    connection: &Connection,
    sql: &str,
    parameters: Vec<DatabaseValue>,
) -> DatabaseResult<DatabaseExecuteResult> {
    let parameters = bind_values(parameters)?;
    let changes = connection
        .execute(sql, params_from_iter(parameters.iter()))
        .map_err(|error| format!("SQLite execute failed: {error}"))?;

    Ok(DatabaseExecuteResult {
        changes: changes as u64,
        last_insert_rowid: DatabaseValue::Integer(connection.last_insert_rowid().to_string()),
    })
}

fn query_sql(
    connection: &Connection,
    sql: &str,
    parameters: Vec<DatabaseValue>,
) -> DatabaseResult<DatabaseQueryResult> {
    let parameters = bind_values(parameters)?;
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("failed to prepare SQLite query: {error}"))?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    let column_count = statement.column_count();
    let mut query = statement
        .query(params_from_iter(parameters.iter()))
        .map_err(|error| format!("SQLite query failed: {error}"))?;
    let mut rows = Vec::new();

    while let Some(row) = query
        .next()
        .map_err(|error| format!("failed to read SQLite row: {error}"))?
    {
        let mut values = Vec::with_capacity(column_count);
        for column in 0..column_count {
            let value = row
                .get_ref(column)
                .map_err(|error| format!("failed to read SQLite column {column}: {error}"))?;
            values.push(database_value(value)?);
        }
        rows.push(values);
    }

    Ok(DatabaseQueryResult { columns, rows })
}

fn bind_values(parameters: Vec<DatabaseValue>) -> DatabaseResult<Vec<Value>> {
    parameters
        .into_iter()
        .map(|parameter| match parameter {
            DatabaseValue::Null => Ok(Value::Null),
            DatabaseValue::Integer(value) => value
                .parse::<i64>()
                .map(Value::Integer)
                .map_err(|_| format!("invalid SQLite i64 value: {value}")),
            DatabaseValue::Real(value) if value.is_finite() => Ok(Value::Real(value)),
            DatabaseValue::Real(_) => Err("SQLite REAL parameter must be finite".into()),
            DatabaseValue::Text(value) => Ok(Value::Text(value)),
            DatabaseValue::Blob(value) => Ok(Value::Blob(value)),
        })
        .collect()
}

fn database_value(value: ValueRef<'_>) -> DatabaseResult<DatabaseValue> {
    match value {
        ValueRef::Null => Ok(DatabaseValue::Null),
        ValueRef::Integer(value) => Ok(DatabaseValue::Integer(value.to_string())),
        ValueRef::Real(value) if value.is_finite() => Ok(DatabaseValue::Real(value)),
        ValueRef::Real(_) => Err("SQLite returned a non-finite REAL value".into()),
        ValueRef::Text(value) => std::str::from_utf8(value)
            .map(|value| DatabaseValue::Text(value.to_owned()))
            .map_err(|error| format!("SQLite returned invalid UTF-8 text: {error}")),
        ValueRef::Blob(value) => Ok(DatabaseValue::Blob(value.to_vec())),
    }
}

fn validate_transaction_sql(sql: &str, has_transaction: bool) -> DatabaseResult<()> {
    let keywords = leading_sql_keywords(sql, 2);
    let first = keywords.first().map(String::as_str);
    let second = keywords.get(1).map(String::as_str);

    match first {
        Some("BEGIN" | "COMMIT" | "END") => Err(
            "transaction control must use database_begin/database_commit/database_rollback".into(),
        ),
        Some("ROLLBACK") if second != Some("TO") => Err(
            "transaction control must use database_begin/database_commit/database_rollback".into(),
        ),
        Some("SAVEPOINT" | "RELEASE") if !has_transaction => {
            Err("savepoints require an active transaction ID".into())
        }
        _ => Ok(()),
    }
}

fn leading_sql_keywords(sql: &str, limit: usize) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut keywords = Vec::with_capacity(limit);

    while index < bytes.len() && keywords.len() < limit {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index..index + 2) == Some(b"--") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes.get(index..index + 2) == Some(b"/*") {
            index += 2;
            while index + 1 < bytes.len() && &bytes[index..index + 2] != b"*/" {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }

        let start = index;
        while index < bytes.len() && (bytes[index].is_ascii_alphabetic() || bytes[index] == b'_') {
            index += 1;
        }
        if start == index {
            break;
        }
        keywords.push(sql[start..index].to_ascii_uppercase());
    }

    keywords
}

#[derive(Deserialize)]
struct MigrationJournal {
    entries: Vec<MigrationJournalEntry>,
}

#[derive(Deserialize)]
struct MigrationJournalEntry {
    idx: usize,
    when: i64,
    tag: String,
}

#[derive(Debug)]
struct AppliedMigration {
    hash: String,
    when: i64,
}

fn schema_reset_required(detail: impl AsRef<str>) -> String {
    format!(
        "local database schema history does not match this Drifting build ({}); reset this pre-release local database before reopening it",
        detail.as_ref()
    )
}

fn apply_migrations(connection: &Connection) -> DatabaseResult<usize> {
    let journal_file = DRIZZLE_MIGRATIONS
        .get_file("meta/_journal.json")
        .ok_or_else(|| "embedded Drizzle migration journal is missing".to_string())?;
    let journal: MigrationJournal = serde_json::from_slice(journal_file.contents())
        .map_err(|error| format!("invalid embedded Drizzle migration journal: {error}"))?;
    validate_migration_journal(&journal)?;

    connection
        .pragma_update(None, "foreign_keys", false)
        .map_err(|error| format!("failed to suspend foreign keys for migrations: {error}"))?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| format!("failed to begin migration transaction: {error}"))?;

    let migration_result = apply_migrations_in_transaction(connection, &journal);
    let migration_result = match migration_result {
        Ok(applied) => connection
            .execute_batch("COMMIT")
            .map(|()| applied)
            .map_err(|error| format!("failed to commit migrations: {error}")),
        Err(error) => Err(error),
    };

    if migration_result.is_err() && !connection.is_autocommit() {
        let _ = connection.execute_batch("ROLLBACK");
    }
    let foreign_key_result = connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("failed to restore foreign keys after migrations: {error}"));

    match (migration_result, foreign_key_result) {
        (Ok(applied), Ok(())) => Ok(applied),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(migration_error), Err(foreign_key_error)) => {
            Err(format!("{migration_error}; {foreign_key_error}"))
        }
    }
}

fn apply_migrations_in_transaction(
    connection: &Connection,
    journal: &MigrationJournal,
) -> DatabaseResult<usize> {
    connection
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {MIGRATIONS_TABLE} (\
             id SERIAL PRIMARY KEY,\
             hash text NOT NULL,\
             created_at numeric\
             )"
        ))
        .map_err(|error| format!("failed to create Drizzle migrations table: {error}"))?;

    let has_application_tables: bool = connection
        .query_row(
            &format!(
                "SELECT EXISTS(\
                 SELECT 1 FROM sqlite_schema \
                 WHERE type = 'table' \
                   AND name NOT LIKE 'sqlite_%' \
                   AND name <> '{MIGRATIONS_TABLE}'\
                 )"
            ),
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect local database schema: {error}"))?;

    let applied_migrations = {
        let mut statement = connection
            .prepare(&format!(
                "SELECT hash, created_at FROM {MIGRATIONS_TABLE} ORDER BY created_at ASC"
            ))
            .map_err(|error| format!("failed to read Drizzle migration state: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(AppliedMigration {
                    hash: row.get(0)?,
                    when: row.get(1)?,
                })
            })
            .map_err(|error| {
                schema_reset_required(format!("migration history is unreadable: {error}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            schema_reset_required(format!("migration history is unreadable: {error}"))
        })?
    };

    if applied_migrations.is_empty() && has_application_tables {
        return Err(schema_reset_required(
            "application tables exist without the current migration baseline",
        ));
    }

    for pair in applied_migrations.windows(2) {
        if pair[0].when >= pair[1].when {
            return Err(schema_reset_required(
                "migration timestamps are duplicated or out of order",
            ));
        }
    }

    let known_prefix_len = applied_migrations.len().min(journal.entries.len());
    for index in 0..known_prefix_len {
        let applied = &applied_migrations[index];
        let expected = &journal.entries[index];
        let migration_path = format!("{}.sql", expected.tag);
        let migration_file = DRIZZLE_MIGRATIONS
            .get_file(&migration_path)
            .ok_or_else(|| format!("embedded migration is missing: {migration_path}"))?;
        let expected_hash = format!("{:x}", Sha256::digest(migration_file.contents()));
        if applied.when != expected.when || applied.hash != expected_hash {
            return Err(schema_reset_required(format!(
                "migration {} is not the expected journal prefix",
                expected.tag
            )));
        }
    }

    if applied_migrations.len() > journal.entries.len() {
        let last_applied = applied_migrations
            .last()
            .expect("non-empty migration history has a last row");
        let latest_embedded = journal.entries.last().map(|entry| entry.when).unwrap_or(0);
        if last_applied.when > latest_embedded {
            return Err(format!(
                "database schema is newer than this Drifting build ({} > {latest_embedded}); upgrade the app before opening it",
                last_applied.when
            ));
        }
        return Err(schema_reset_required(
            "migration history contains a non-prefix entry",
        ));
    }

    let mut applied = 0;
    for entry in journal.entries.iter().skip(applied_migrations.len()) {
        let migration_path = format!("{}.sql", entry.tag);
        let migration_file = DRIZZLE_MIGRATIONS
            .get_file(&migration_path)
            .ok_or_else(|| format!("embedded migration is missing: {migration_path}"))?;
        let migration_sql = migration_file
            .contents_utf8()
            .ok_or_else(|| format!("migration is not valid UTF-8: {migration_path}"))?;

        for statement in migration_sql.split(MIGRATION_BREAKPOINT) {
            if statement.trim().is_empty() {
                continue;
            }
            connection
                .execute_batch(statement)
                .map_err(|error| format!("migration {} failed: {error}", entry.tag))?;
        }

        let hash = format!("{:x}", Sha256::digest(migration_file.contents()));
        connection
            .execute(
                &format!("INSERT INTO {MIGRATIONS_TABLE} (hash, created_at) VALUES (?1, ?2)"),
                params![hash, entry.when],
            )
            .map_err(|error| format!("failed to record migration {}: {error}", entry.tag))?;
        applied += 1;
    }

    Ok(applied)
}

fn validate_migration_journal(journal: &MigrationJournal) -> DatabaseResult<()> {
    let mut previous_timestamp = None;
    for (expected_index, entry) in journal.entries.iter().enumerate() {
        if entry.idx != expected_index {
            return Err(format!(
                "migration journal index mismatch: expected {expected_index}, found {}",
                entry.idx
            ));
        }
        if !entry
            .tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(format!("invalid migration tag: {}", entry.tag));
        }
        if previous_timestamp.is_some_and(|previous| previous >= entry.when) {
            return Err(format!(
                "migration timestamps are not strictly increasing at {}",
                entry.tag
            ));
        }
        previous_timestamp = Some(entry.when);
    }
    Ok(())
}

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
    let receipt = gateway.recovery_receipt(&recovery_session_id)?;
    verify_recovery_backup(&gateway.inner.database_directory, &receipt)?;
    Ok(gateway.recovery_failure(format!(
        "{RECOVERY_FAILURE_PREFIX}{recovery_session_id}:{}",
        receipt.error_code
    )))
}

#[tauri::command]
pub async fn database_recovery_retry(
    gateway: State<'_, DatabaseGateway>,
    recovery_session_id: String,
    client_session_id: String,
) -> Result<DatabaseOpenResult, DatabaseOpenFailure> {
    let gateway = gateway.inner().clone();
    let receipt = match gateway.recovery_receipt(&recovery_session_id) {
        Ok(receipt) => receipt,
        Err(error) => return Err(gateway.recovery_failure(error)),
    };
    run_database_open(gateway, move |gateway| {
        gateway.open(receipt.database_name, client_session_id, false)
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
    let receipt = gateway.recovery_receipt(&recovery_session_id)?;
    if receipt.backup_id != backup_id {
        return Err("database recovery backup identity does not match".into());
    }
    let source = verify_recovery_backup(&gateway.inner.database_directory, &receipt)?;
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
    validate_opaque_id(&recovery_session_id)?;
    let directory = gateway
        .recovery_receipt(&recovery_session_id)
        .ok()
        .and_then(|receipt| {
            verify_recovery_backup(&gateway.inner.database_directory, &receipt).ok()
        })
        .and_then(|backup| backup.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| gateway.inner.database_directory.join("safety-backups"));
    fs::create_dir_all(&directory)
        .map_err(|_| "could not prepare the database safety backup directory".to_string())?;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|_| "could not open the database safety backup directory".to_string())
}

#[tauri::command]
pub async fn database_execute(
    gateway: State<'_, DatabaseGateway>,
    sql: String,
    parameters: Option<Vec<DatabaseValue>>,
    transaction_id: Option<String>,
    client_session_id: String,
) -> DatabaseResult<DatabaseExecuteResult> {
    let transaction_id = transaction_id.map(parse_transaction_id).transpose()?;
    let gateway = gateway.inner().clone();
    run_blocking(move || {
        gateway.execute(
            sql,
            parameters.unwrap_or_default(),
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
    parameters: Option<Vec<DatabaseValue>>,
    transaction_id: Option<String>,
    client_session_id: String,
) -> DatabaseResult<DatabaseQueryResult> {
    let transaction_id = transaction_id.map(parse_transaction_id).transpose()?;
    let gateway = gateway.inner().clone();
    run_blocking(move || {
        gateway.query(
            sql,
            parameters.unwrap_or_default(),
            transaction_id,
            client_session_id,
        )
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

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use rusqlite::Connection;
    use tempfile::TempDir;

    use super::{
        apply_migrations, create_pre_update_safety_backup, create_recovery_receipt,
        database_version_is_current, migrate_shadow_candidate, read_recovery_receipt,
        reconcile_incomplete_shadow_migration, record_opened_app_version, recovery_directory,
        recovery_receipt_path, write_recovery_receipt, DatabaseGateway, DatabaseValue,
        MigrationJournal, TransactionBehavior, DRIZZLE_MIGRATIONS, MIGRATIONS_TABLE,
    };

    const CLIENT_SESSION: &str = "test-renderer-session";

    fn gateway() -> (TempDir, DatabaseGateway) {
        let directory = TempDir::new().expect("temporary database directory");
        let gateway = DatabaseGateway::new(directory.path().to_path_buf()).expect("gateway");
        (directory, gateway)
    }

    fn integer(value: i64) -> DatabaseValue {
        DatabaseValue::Integer(value.to_string())
    }

    fn embedded_migration_count() -> usize {
        let journal = DRIZZLE_MIGRATIONS
            .get_file("meta/_journal.json")
            .expect("embedded migration journal");
        serde_json::from_slice::<MigrationJournal>(journal.contents())
            .expect("valid embedded migration journal")
            .entries
            .len()
    }

    #[test]
    fn round_trips_every_sqlite_storage_class_without_losing_i64_precision() {
        let (_directory, gateway) = gateway();
        gateway
            .open("typed.db".into(), CLIENT_SESSION.into(), false)
            .expect("open database");
        gateway
            .execute(
                "CREATE TABLE typed_values (i INTEGER, r REAL, t TEXT, b BLOB, n TEXT)".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("create table");

        let inserted = gateway
            .execute(
                "INSERT INTO typed_values VALUES (?1, ?2, ?3, ?4, ?5)".into(),
                vec![
                    integer(i64::MAX),
                    DatabaseValue::Real(3.5),
                    DatabaseValue::Text("Drifting".into()),
                    DatabaseValue::Blob(vec![0, 1, 254, 255]),
                    DatabaseValue::Null,
                ],
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert values");
        assert_eq!(inserted.changes, 1);

        let result = gateway
            .query(
                "SELECT i, r, t, b, n FROM typed_values".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("query values");
        assert_eq!(result.columns, ["i", "r", "t", "b", "n"]);
        assert_eq!(
            result.rows,
            [vec![
                integer(i64::MAX),
                DatabaseValue::Real(3.5),
                DatabaseValue::Text("Drifting".into()),
                DatabaseValue::Blob(vec![0, 1, 254, 255]),
                DatabaseValue::Null,
            ]]
        );
    }

    #[test]
    fn ordinary_requests_wait_until_the_owning_transaction_finishes() {
        let (_directory, gateway) = gateway();
        gateway
            .open("transactions.db".into(), CLIENT_SESSION.into(), false)
            .expect("open database");
        gateway
            .execute(
                "CREATE TABLE events (name TEXT NOT NULL)".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("create table");

        let transaction_id = gateway
            .begin(TransactionBehavior::Immediate, CLIENT_SESSION.into())
            .expect("begin transaction");
        gateway
            .execute(
                "INSERT INTO events VALUES ('transaction')".into(),
                Vec::new(),
                Some(transaction_id),
                CLIENT_SESSION.into(),
            )
            .expect("transaction insert");

        let queued_gateway = gateway.clone();
        let (started_sender, started_receiver) = mpsc::channel();
        let (finished_sender, finished_receiver) = mpsc::channel();
        let queued_request = thread::spawn(move || {
            started_sender.send(()).expect("announce request");
            let result = queued_gateway.execute(
                "INSERT INTO events VALUES ('ordinary')".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            );
            finished_sender.send(result).expect("return result");
        });

        started_receiver.recv().expect("request started");
        assert!(finished_receiver
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        gateway
            .rollback(transaction_id, CLIENT_SESSION.into())
            .expect("rollback transaction");
        finished_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("queued request completed")
            .expect("queued insert succeeded");
        queued_request.join().expect("request thread");

        let rows = gateway
            .query(
                "SELECT name FROM events ORDER BY name".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("query events");
        assert_eq!(rows.rows, [vec![DatabaseValue::Text("ordinary".into())]]);
    }

    #[test]
    fn a_fresh_renderer_session_recovers_a_stale_transaction() {
        const STALE_SESSION: &str = "stale-renderer-session";
        const FRESH_SESSION: &str = "fresh-renderer-session";

        let (_directory, gateway) = gateway();
        gateway
            .open("recovery.db".into(), STALE_SESSION.into(), false)
            .expect("open stale renderer database");
        gateway
            .execute(
                "CREATE TABLE events (name TEXT NOT NULL)".into(),
                Vec::new(),
                None,
                STALE_SESSION.into(),
            )
            .expect("create events table");
        let stale_transaction = gateway
            .begin(TransactionBehavior::Immediate, STALE_SESSION.into())
            .expect("begin stale transaction");
        gateway
            .execute(
                "INSERT INTO events VALUES ('uncommitted')".into(),
                Vec::new(),
                Some(stale_transaction),
                STALE_SESSION.into(),
            )
            .expect("write stale transaction");

        gateway
            .open("recovery.db".into(), FRESH_SESSION.into(), true)
            .expect("fresh renderer recovers database");

        let rows = gateway
            .query(
                "SELECT name FROM events".into(),
                Vec::new(),
                None,
                FRESH_SESSION.into(),
            )
            .expect("fresh renderer query");
        assert!(
            rows.rows.is_empty(),
            "stale transaction must be rolled back"
        );

        let stale_error = gateway
            .commit(stale_transaction, STALE_SESSION.into())
            .expect_err("stale renderer must lose its database lease");
        assert!(stale_error.contains("owned by another renderer session"));
    }

    #[test]
    fn the_same_renderer_session_cannot_recover_its_own_active_transaction() {
        let (_directory, gateway) = gateway();
        gateway
            .open("same-session.db".into(), CLIENT_SESSION.into(), false)
            .expect("open database");
        gateway
            .execute(
                "CREATE TABLE events (name TEXT NOT NULL)".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("create events table");
        let transaction_id = gateway
            .begin(TransactionBehavior::Immediate, CLIENT_SESSION.into())
            .expect("begin transaction");
        gateway
            .execute(
                "INSERT INTO events VALUES ('kept')".into(),
                Vec::new(),
                Some(transaction_id),
                CLIENT_SESSION.into(),
            )
            .expect("write transaction");

        let error = gateway
            .open("same-session.db".into(), CLIENT_SESSION.into(), true)
            .expect_err("same renderer must not recover its own transaction");
        assert!(error.contains("this renderer session has an active transaction"));

        gateway
            .commit(transaction_id, CLIENT_SESSION.into())
            .expect("original transaction remains active");
        let rows = gateway
            .query(
                "SELECT name FROM events".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("query committed row");
        assert_eq!(rows.rows, [vec![DatabaseValue::Text("kept".into())]]);
    }

    #[test]
    fn another_renderer_cannot_take_over_without_explicit_recovery() {
        let (_directory, gateway) = gateway();
        gateway
            .open("lease.db".into(), CLIENT_SESSION.into(), false)
            .expect("open database");

        let error = gateway
            .open("lease.db".into(), "other-renderer-session".into(), false)
            .expect_err("implicit renderer takeover must fail");
        assert!(error.contains("stale recovery is required"));

        gateway
            .query("SELECT 1".into(), Vec::new(), None, CLIENT_SESSION.into())
            .expect("original renderer keeps its lease");
    }

    #[test]
    fn current_local_first_baseline_is_exactly_recorded_and_idempotent() {
        let (_directory, gateway) = gateway();
        let first_open = gateway
            .open("migrations.db".into(), CLIENT_SESSION.into(), false)
            .expect("first open");
        let expected_migrations = embedded_migration_count();
        assert_eq!(first_open.migrations_applied, expected_migrations);
        assert_eq!(first_open.journal_mode.to_ascii_lowercase(), "wal");

        let migration_count = gateway
            .query(
                format!("SELECT count(*) FROM {MIGRATIONS_TABLE}"),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("migration count");
        assert_eq!(
            migration_count.rows,
            [vec![integer(expected_migrations as i64)]]
        );

        gateway
            .close(CLIENT_SESSION.into())
            .expect("close database");
        let second_open = gateway
            .open("migrations.db".into(), CLIENT_SESSION.into(), false)
            .expect("second open");
        assert_eq!(second_open.migrations_applied, 0);
    }

    #[test]
    fn project_upgrades_preserve_published_prefixes_with_same_version_safety_snapshots() {
        use sha2::{Digest, Sha256};
        for prefix in 1..embedded_migration_count() {
            for inject_failure in [false, true] {
                let (directory, gateway) = gateway();
                let database_path = directory.path().join("published.db");
                let connection = Connection::open(&database_path).unwrap();
                let journal: MigrationJournal = serde_json::from_slice(
                    DRIZZLE_MIGRATIONS
                        .get_file("meta/_journal.json")
                        .unwrap()
                        .contents(),
                )
                .unwrap();
                connection.execute_batch("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);").unwrap();
                for entry in journal.entries.iter().take(prefix) {
                    let migration = DRIZZLE_MIGRATIONS
                        .get_file(format!("{}.sql", entry.tag))
                        .unwrap();
                    connection
                        .execute_batch(std::str::from_utf8(migration.contents()).unwrap())
                        .unwrap();
                    connection
                        .execute(
                            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?1, ?2)",
                            rusqlite::params![
                                format!("{:x}", Sha256::digest(migration.contents())),
                                entry.when
                            ],
                        )
                        .unwrap();
                }
                connection.execute_batch("INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES ('p', 'Synthetic project', 'local', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
                INSERT INTO agent_conversation (id, project_id, title, messages_json, created_at, updated_at) VALUES ('c', 'p', 'Synthetic history', '[]', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');").unwrap();
                if inject_failure {
                    connection
                    .execute_batch("CREATE TABLE workspace_projection_clock (project_id TEXT PRIMARY KEY);")
                    .unwrap();
                }
                drop(connection);
                record_opened_app_version(
                    directory.path(),
                    &database_path,
                    env!("CARGO_PKG_VERSION"),
                )
                .unwrap();
                let result = gateway.open("published.db".into(), CLIENT_SESSION.into(), false);
                let backups = std::fs::read_dir(
                    directory
                        .path()
                        .join("safety-backups")
                        .join(env!("CARGO_PKG_VERSION")),
                )
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "sqlite")
                })
                .collect::<Vec<_>>();
                assert_eq!(backups.len(), 1);
                let backup = Connection::open(backups[0].path()).unwrap();
                assert_eq!(
                    backup
                        .query_row("SELECT count(*) FROM __drizzle_migrations", [], |row| row
                            .get::<_, i64>(
                            0
                        ))
                        .unwrap(),
                    prefix as i64
                );
                assert_eq!(
                    backup
                        .query_row(
                            "SELECT title FROM agent_conversation WHERE id='c'",
                            [],
                            |row| row.get::<_, String>(0)
                        )
                        .unwrap(),
                    "Synthetic history"
                );
                if inject_failure {
                    assert!(result.unwrap_err().contains("database-recovery:"));
                    // Opening can checkpoint WAL headers, but no migration changes the source schema/data.
                    let active = Connection::open(&database_path).unwrap();
                    assert_eq!(
                        active
                            .query_row("SELECT count(*) FROM __drizzle_migrations", [], |row| row
                                .get::<_, i64>(
                                0
                            ))
                            .unwrap(),
                        prefix as i64
                    );
                    assert_eq!(
                    active
                        .query_row(
                            "SELECT count(*) FROM sqlite_schema WHERE name='workspace_projection_change'",
                            [],
                            |row| row.get::<_, i64>(0)
                        )
                        .unwrap(),
                    0
                );
                    assert_eq!(
                        active
                            .query_row(
                                "SELECT title FROM agent_conversation WHERE id='c'",
                                [],
                                |row| row.get::<_, String>(0)
                            )
                            .unwrap(),
                        "Synthetic history"
                    );
                } else {
                    assert_eq!(
                        result.unwrap().migrations_applied,
                        embedded_migration_count() - prefix
                    );
                    let rows = gateway
                        .query(
                            "SELECT title FROM agent_conversation WHERE id='c'".into(),
                            vec![],
                            None,
                            CLIENT_SESSION.into(),
                        )
                        .unwrap();
                    assert_eq!(
                        rows.rows,
                        [vec![DatabaseValue::Text("Synthetic history".into())]]
                    );
                    gateway.close(CLIENT_SESSION.into()).unwrap();
                }
            }
        }
    }

    #[test]
    fn refuses_a_tampered_applied_baseline_and_requires_reset() {
        let (directory, gateway) = gateway();
        gateway
            .open("tampered.db".into(), CLIENT_SESSION.into(), false)
            .expect("initial open");
        gateway
            .close(CLIENT_SESSION.into())
            .expect("close baseline database");

        let connection =
            Connection::open(directory.path().join("tampered.db")).expect("open baseline directly");
        connection
            .execute(
                &format!("UPDATE {MIGRATIONS_TABLE} SET hash = 'tampered'"),
                [],
            )
            .expect("tamper baseline hash");
        connection.close().expect("close direct connection");

        let error = gateway
            .open("tampered.db".into(), CLIENT_SESSION.into(), false)
            .expect_err("tampered baseline must fail closed");
        assert!(error.contains("reset this pre-release local database"));
    }

    #[test]
    fn agent_runtime_migration_enforces_canonical_journal_constraints() {
        let (_directory, gateway) = gateway();
        gateway
            .open("agent-runtime.db".into(), CLIENT_SESSION.into(), false)
            .expect("open migrated database");

        gateway
            .execute(
                "INSERT INTO project (id, name, user_id, created_at, updated_at) \
                 VALUES ('project-1', 'Novel', 'user-1', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert project");
        gateway
            .execute(
                "INSERT INTO agent_conversation \
                 (id, project_id, title, sdk_session_id, created_at, updated_at) \
                 VALUES ('conversation-1', 'project-1', 'Recovery', 'legacy-sdk-session', \
                 '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert conversation");
        gateway
            .execute(
                "INSERT INTO agent_runtime_session \
                 (id, project_id, route_kind, conversation_id, provider, model, status, created_at, updated_at) \
                 VALUES ('session-1', 'project-1', 'chat', 'conversation-1', 'deepseek', \
                 'deepseek-chat', 'running', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert runtime session");
        gateway
            .execute(
                "UPDATE agent_conversation SET runtime_session_id = 'session-1' \
                 WHERE id = 'conversation-1'"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("attach canonical session");
        gateway
            .execute(
                "INSERT INTO agent_runtime_turn \
                 (id, session_id, ordinal, status, accepted_at, updated_at) \
                 VALUES ('turn-1', 'session-1', 0, 'running', \
                 '2026-07-30T00:00:01Z', '2026-07-30T00:00:01Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert runtime turn");
        gateway
            .execute(
                "INSERT INTO agent_runtime_message \
                 (id, session_id, turn_id, ordinal, role, status, content_json, created_at, completed_at) \
                 VALUES ('message-1', 'session-1', 'turn-1', 0, 'user', 'complete', \
                 '{\"content\":\"写第一章\",\"role\":\"user\"}', \
                 '2026-07-30T00:00:01Z', '2026-07-30T00:00:01Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert canonical prompt");
        gateway
            .execute(
                "INSERT INTO agent_runtime_event \
                 (event_id, session_id, turn_id, seq, schema_version, event_type, \
                  payload_json, wall_time_ms, created_at) \
                 VALUES ('turn-1:00000001', 'session-1', 'turn-1', 1, 1, \
                 'turn_started', '{\"prompt\":\"写第一章\"}', 1, '2026-07-30T00:00:01Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert first journal event");
        gateway
            .execute(
                "INSERT INTO agent_runtime_tool_call \
                 (id, session_id, turn_id, call_id, name, access, status, idempotency_key, \
                  arguments_json, created_at) \
                 VALUES ('tool-record-1', 'session-1', 'turn-1', 'call-1', 'list_nodes', \
                 'read', 'requested', 'session-1:turn-1:call-1', '{}', \
                 '2026-07-30T00:00:01Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert canonical tool lifecycle");
        gateway
            .execute(
                "INSERT INTO agent_runtime_checkpoint \
                 (id, session_id, through_turn_ordinal, message_count, context_json, \
                  context_hash, created_at) \
                 VALUES ('checkpoint-1', 'session-1', 0, 1, '[]', 'sha256:test', \
                 '2026-07-30T00:00:02Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert canonical context checkpoint");
        gateway
            .execute(
                "INSERT INTO agent_runtime_read_receipt \
                 (id, project_id, session_id, turn_id, tool_call_id, call_id, tool_name, \
                  idempotency_key, result_blob, result_hash, created_at) \
                 VALUES ('read-receipt-1', 'project-1', 'session-1', 'turn-1', \
                 'tool-record-1', 'call-1', 'list_nodes', \
                 'session-1:turn-1:call-1', CAST('{}' AS BLOB), \
                 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', \
                 '2026-07-30T00:00:02Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert canonical read receipt");
        gateway
            .execute(
                "INSERT INTO agent_runtime_read_observation \
                 (id, receipt_id, project_id, session_id, turn_id, tool_call_id, ordinal, \
                  entity_kind, entity_id, revision, created_at) \
                 VALUES ('read-observation-1', 'read-receipt-1', 'project-1', 'session-1', \
                 'turn-1', 'tool-record-1', 0, 'project', 'project-1', \
                 '2026-07-30T00:00:00Z', '2026-07-30T00:00:02Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert canonical read observation");
        gateway
            .execute(
                "INSERT INTO agent_runtime_result_blob \
                 (content_hash, content_blob, byte_count, char_count, created_at) \
                 VALUES (\
                 'sha256:56bc2404e330671e4d867faca25a27078be7fbe10d2d72273d4de5d936a5fc42', \
                 CAST('oversized result' AS BLOB), 16, 16, '2026-07-30T00:00:02Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert content-addressed result blob");
        gateway
            .execute(
                "INSERT INTO agent_runtime_result_artifact \
                 (ref, project_id, session_id, turn_id, tool_call_id, call_id, tool_name, \
                  idempotency_key, arguments_json, content_hash, created_at) \
                 VALUES ('agent-result:session-1:turn-1:call-1', 'project-1', \
                 'session-1', 'turn-1', 'tool-record-1', 'call-1', 'list_nodes', \
                 'session-1:turn-1:call-1', '{}', \
                 'sha256:56bc2404e330671e4d867faca25a27078be7fbe10d2d72273d4de5d936a5fc42', \
                 '2026-07-30T00:00:02Z')"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("insert durable result reference");

        let mutable_read_receipt = gateway.execute(
            "UPDATE agent_runtime_read_receipt SET result_hash = \
             'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
             WHERE id = 'read-receipt-1'"
                .into(),
            Vec::new(),
            None,
            CLIENT_SESSION.into(),
        );
        assert!(
            mutable_read_receipt.is_err(),
            "durable read receipts must be immutable"
        );
        let mutable_result_blob = gateway.execute(
            "UPDATE agent_runtime_result_blob SET content_blob = CAST('tampered payload' AS BLOB) \
             WHERE content_hash = \
             'sha256:56bc2404e330671e4d867faca25a27078be7fbe10d2d72273d4de5d936a5fc42'"
                .into(),
            Vec::new(),
            None,
            CLIENT_SESSION.into(),
        );
        assert!(
            mutable_result_blob.is_err(),
            "content-addressed Agent result blobs must be immutable"
        );
        let mutable_result_ref = gateway.execute(
            "UPDATE agent_runtime_result_artifact SET arguments_json = '{\"changed\":true}' \
             WHERE ref = 'agent-result:session-1:turn-1:call-1'"
                .into(),
            Vec::new(),
            None,
            CLIENT_SESSION.into(),
        );
        assert!(
            mutable_result_ref.is_err(),
            "Agent result reference provenance must be immutable"
        );

        let invalid_goal_route = gateway.execute(
            "INSERT INTO agent_runtime_session \
             (id, project_id, route_kind, conversation_id, provider, status, created_at, updated_at) \
             VALUES ('session-invalid', 'project-1', 'goal', 'conversation-1', 'deepseek', \
             'running', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')"
                .into(),
            Vec::new(),
            None,
            CLIENT_SESSION.into(),
        );
        assert!(
            invalid_goal_route.is_err(),
            "goal sessions must not claim a chat conversation"
        );

        let duplicate_message_ordinal = gateway.execute(
            "INSERT INTO agent_runtime_message \
             (id, session_id, turn_id, ordinal, role, status, content_json, created_at) \
             VALUES ('message-duplicate', 'session-1', 'turn-1', 0, 'assistant', \
             'complete', '{}', '2026-07-30T00:00:02Z')"
                .into(),
            Vec::new(),
            None,
            CLIENT_SESSION.into(),
        );
        assert!(
            duplicate_message_ordinal.is_err(),
            "message ordinals must be unique per session"
        );

        let duplicate_event_id = gateway.execute(
            "INSERT INTO agent_runtime_event \
             (event_id, session_id, turn_id, seq, schema_version, event_type, \
              payload_json, wall_time_ms, created_at) \
             VALUES ('turn-1:00000001', 'session-1', 'turn-1', 2, 1, \
             'text_delta', '{}', 2, '2026-07-30T00:00:02Z')"
                .into(),
            Vec::new(),
            None,
            CLIENT_SESSION.into(),
        );
        assert!(duplicate_event_id.is_err(), "eventId must be unique");

        let duplicate_turn_seq = gateway.execute(
            "INSERT INTO agent_runtime_event \
             (event_id, session_id, turn_id, seq, schema_version, event_type, \
              payload_json, wall_time_ms, created_at) \
             VALUES ('another-id', 'session-1', 'turn-1', 1, 1, \
             'text_delta', '{}', 2, '2026-07-30T00:00:02Z')"
                .into(),
            Vec::new(),
            None,
            CLIENT_SESSION.into(),
        );
        assert!(duplicate_turn_seq.is_err(), "(turnId, seq) must be unique");

        let attached = gateway
            .query(
                "SELECT sdk_session_id, runtime_session_id FROM agent_conversation \
                 WHERE id = 'conversation-1'"
                    .into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("read attached runtime session");
        assert_eq!(
            attached.rows,
            [vec![
                DatabaseValue::Text("legacy-sdk-session".into()),
                DatabaseValue::Text("session-1".into())
            ]]
        );
        let integrity = gateway
            .query(
                "PRAGMA integrity_check".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("integrity check");
        assert_eq!(integrity.rows, [vec![DatabaseValue::Text("ok".into())]]);
    }

    #[test]
    fn refuses_a_database_migrated_by_a_newer_client() {
        let (_directory, gateway) = gateway();
        gateway
            .open("future.db".into(), CLIENT_SESSION.into(), false)
            .expect("initial open");
        gateway
            .execute(
                format!("INSERT INTO {MIGRATIONS_TABLE} (hash, created_at) VALUES (?1, ?2)"),
                vec![DatabaseValue::Text("future".into()), integer(i64::MAX)],
                None,
                CLIENT_SESSION.into(),
            )
            .expect("record future migration");
        gateway
            .close(CLIENT_SESSION.into())
            .expect("close future database");

        let error = gateway
            .open("future.db".into(), CLIENT_SESSION.into(), false)
            .expect_err("older build must reject a newer schema");
        assert!(error.contains("database schema is newer than this Drifting build"));
    }

    #[test]
    fn database_names_cannot_escape_the_managed_directory() {
        let (_directory, gateway) = gateway();
        assert!(gateway
            .open("../outside.db".into(), CLIENT_SESSION.into(), false)
            .is_err());
        assert!(gateway
            .open("nested/outside.db".into(), CLIENT_SESSION.into(), false)
            .is_err());
        assert!(gateway
            .open("missing-extension".into(), CLIENT_SESSION.into(), false)
            .is_err());
    }

    #[test]
    fn pre_update_safety_snapshot_is_standalone_and_once_per_version() {
        let directory = TempDir::new().expect("temporary database directory");
        let database_path = directory.path().join("library.db");
        let connection = Connection::open(&database_path).expect("open source database");
        apply_migrations(&connection).expect("current public migration baseline");
        connection
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE prose (body TEXT NOT NULL); INSERT INTO prose VALUES ('kept');")
            .expect("seed source database");

        let backup = create_pre_update_safety_backup(
            &connection,
            directory.path(),
            &database_path,
            "0.1.0-alpha.2",
        )
        .expect("create safety snapshot")
        .expect("first open for version creates a snapshot");
        let backup_connection = Connection::open(&backup).expect("open standalone safety snapshot");
        let body: String = backup_connection
            .query_row("SELECT body FROM prose", [], |row| row.get(0))
            .expect("read snapshot content");
        assert_eq!(body, "kept");

        record_opened_app_version(directory.path(), &database_path, "0.1.0-alpha.2")
            .expect("record successful open");
        assert!(create_pre_update_safety_backup(
            &connection,
            directory.path(),
            &database_path,
            "0.1.0-alpha.2",
        )
        .expect("repeat safety check")
        .is_none());
    }

    #[test]
    fn failed_shadow_candidate_never_changes_the_active_database() {
        let directory = TempDir::new().expect("temporary database directory");
        let database_path = directory.path().join("library.db");
        let connection = Connection::open(&database_path).expect("open active database");
        connection
            .execute_batch("CREATE TABLE prose (body TEXT NOT NULL); INSERT INTO prose VALUES ('old authority');")
            .expect("seed active database");
        drop(connection);
        let corrupt_backup = directory.path().join("corrupt.sqlite");
        std::fs::write(&corrupt_backup, b"not sqlite").expect("write corrupt backup");
        let receipt = create_recovery_receipt(
            directory.path(),
            &database_path,
            &corrupt_backup,
            "candidate-preparation",
            "candidate-failed",
        )
        .expect("create recovery receipt");

        let failure =
            migrate_shadow_candidate(directory.path(), &database_path, &corrupt_backup, &receipt)
                .expect_err("corrupt candidate must fail");
        assert_eq!(failure.0, "candidate-open");
        let active = Connection::open(&database_path).expect("reopen active database");
        let body: String = active
            .query_row("SELECT body FROM prose", [], |row| row.get(0))
            .expect("read old authority");
        assert_eq!(body, "old authority");
        let persisted = read_recovery_receipt(directory.path(), &receipt.recovery_session_id)
            .expect("read persisted candidate receipt");
        assert!(persisted
            .candidate_file_name
            .map(|name| !directory.path().join(name).exists())
            .unwrap_or(false));
    }

    #[test]
    fn restart_after_replace_completes_marker_only_after_validating_active_database() {
        let directory = TempDir::new().expect("temporary database directory");
        let database_path = directory.path().join("library.db");
        let connection = Connection::open(&database_path).expect("open active database");
        apply_migrations(&connection).expect("migrate active database");
        let backup = create_pre_update_safety_backup(
            &connection,
            directory.path(),
            &database_path,
            env!("CARGO_PKG_VERSION"),
        )
        .expect("create safety backup")
        .expect("missing marker creates safety backup");
        drop(connection);
        let mut receipt = create_recovery_receipt(
            directory.path(),
            &database_path,
            &backup,
            "version-marker",
            "version-marker-failed",
        )
        .expect("create recovery receipt");
        receipt.state = "replacing".into();
        receipt.candidate_file_name = Some("candidate-already-renamed.sqlite".into());
        write_recovery_receipt(directory.path(), &receipt).expect("persist replacing receipt");

        reconcile_incomplete_shadow_migration(directory.path(), &database_path)
            .expect("reconcile replaced database");
        assert!(database_version_is_current(
            directory.path(),
            &database_path,
            env!("CARGO_PKG_VERSION")
        )
        .expect("read marker"));
        assert!(!recovery_receipt_path(directory.path(), &receipt.recovery_session_id).exists());
    }

    #[test]
    fn restart_after_replace_never_migrates_an_incomplete_active_database() {
        let directory = TempDir::new().expect("temporary database directory");
        let database_path = directory.path().join("library.db");
        let connection = Connection::open(&database_path).expect("open incomplete active database");
        connection
            .execute_batch(&format!(
                "CREATE TABLE {MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);\
                 CREATE TABLE active_canary (value TEXT NOT NULL);\
                 INSERT INTO active_canary VALUES ('must remain unmigrated');"
            ))
            .expect("seed incomplete migration journal");
        let backup = create_pre_update_safety_backup(
            &connection,
            directory.path(),
            &database_path,
            env!("CARGO_PKG_VERSION"),
        )
        .expect("create safety backup")
        .expect("missing marker creates safety backup");
        drop(connection);
        let mut receipt = create_recovery_receipt(
            directory.path(),
            &database_path,
            &backup,
            "version-marker",
            "version-marker-failed",
        )
        .expect("create recovery receipt");
        receipt.state = "replacing".into();
        receipt.candidate_file_name = Some("candidate-already-renamed.sqlite".into());
        write_recovery_receipt(directory.path(), &receipt).expect("persist replacing receipt");

        let error = reconcile_incomplete_shadow_migration(directory.path(), &database_path)
            .expect_err("incomplete active journal must stop reconciliation");
        assert_eq!(
            error,
            format!(
                "database-recovery:{}:activated-database-invalid",
                receipt.recovery_session_id
            )
        );
        let active = Connection::open(&database_path).expect("reopen active database");
        let migration_count: i64 = active
            .query_row(
                &format!("SELECT count(*) FROM {MIGRATIONS_TABLE}"),
                [],
                |row| row.get(0),
            )
            .expect("read migration count");
        assert_eq!(migration_count, 0);
        let project_table_exists: bool = active
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'project')",
                [],
                |row| row.get(0),
            )
            .expect("inspect baseline table");
        assert!(!project_table_exists);
        assert!(!database_version_is_current(
            directory.path(),
            &database_path,
            env!("CARGO_PKG_VERSION")
        )
        .expect("read marker"));
    }

    #[test]
    fn malformed_recovery_receipt_stops_startup_instead_of_guessing() {
        let directory = TempDir::new().expect("temporary database directory");
        let database_path = directory.path().join("library.db");
        Connection::open(&database_path).expect("create active database");
        let recovery = recovery_directory(directory.path());
        std::fs::create_dir_all(&recovery).expect("create recovery directory");
        let session = "0123456789abcdef0123456789abcdef";
        std::fs::write(recovery.join(format!("{session}.json")), b"{not-json")
            .expect("write malformed receipt");

        let error = reconcile_incomplete_shadow_migration(directory.path(), &database_path)
            .expect_err("ambiguous receipt must stop startup");
        assert_eq!(
            error,
            format!("database-recovery:{session}:recovery-receipt-invalid")
        );
    }

    #[test]
    fn shadow_migration_sigkill_worker() {
        let Ok(directory) = std::env::var("DRIFTING_DATABASE_SIGKILL_DIRECTORY") else {
            return;
        };
        let database_path = std::path::PathBuf::from(
            std::env::var("DRIFTING_DATABASE_SIGKILL_ACTIVE").expect("active database path"),
        );
        let backup_path = std::path::PathBuf::from(
            std::env::var("DRIFTING_DATABASE_SIGKILL_BACKUP").expect("backup database path"),
        );
        let recovery_session_id =
            std::env::var("DRIFTING_DATABASE_SIGKILL_RECEIPT").expect("receipt identity");
        let receipt = read_recovery_receipt(std::path::Path::new(&directory), &recovery_session_id)
            .expect("read recovery receipt");
        migrate_shadow_candidate(
            std::path::Path::new(&directory),
            &database_path,
            &backup_path,
            &receipt,
        )
        .expect("migration should only return when no kill stage is configured");
    }

    #[cfg(unix)]
    #[test]
    fn sigkill_matrix_reconciles_to_exactly_old_or_new_database() {
        use std::os::unix::process::ExitStatusExt;

        for stage in [
            "snapshot-copy",
            "candidate-fsync",
            "migration",
            "integrity-check",
            "post-migration-fsync",
            "replace",
            "marker",
        ] {
            let directory = TempDir::new().expect("temporary database directory");
            let database_path = directory.path().join("library.db");
            let active = Connection::open(&database_path).expect("open active database");
            apply_migrations(&active).expect("migrate active database");
            active
                .execute_batch(
                    "CREATE TABLE crash_truth (value TEXT NOT NULL); INSERT INTO crash_truth VALUES ('old');",
                )
                .expect("seed old authority");
            drop(active);

            let backup_directory = directory
                .path()
                .join("safety-backups")
                .join(env!("CARGO_PKG_VERSION"));
            std::fs::create_dir_all(&backup_directory).expect("create safety backup directory");
            let backup_path = backup_directory.join("replacement-source.sqlite");
            let replacement = Connection::open(&backup_path).expect("open replacement source");
            apply_migrations(&replacement).expect("migrate replacement source");
            replacement
                .execute_batch(
                    "CREATE TABLE crash_truth (value TEXT NOT NULL); INSERT INTO crash_truth VALUES ('new');",
                )
                .expect("seed new authority");
            drop(replacement);
            std::fs::File::open(&backup_path)
                .and_then(|file| file.sync_all())
                .expect("sync replacement source");
            let receipt = create_recovery_receipt(
                directory.path(),
                &database_path,
                &backup_path,
                "candidate-preparation",
                "migration-candidate-failed",
            )
            .expect("create recovery receipt");

            let current = std::env::current_exe().expect("current test binary");
            let mut child = Command::new(current)
                .args([
                    "--exact",
                    "database::tests::shadow_migration_sigkill_worker",
                    "--nocapture",
                ])
                .env("DRIFTING_DATABASE_SIGKILL_DIRECTORY", directory.path())
                .env("DRIFTING_DATABASE_SIGKILL_ACTIVE", &database_path)
                .env("DRIFTING_DATABASE_SIGKILL_BACKUP", &backup_path)
                .env(
                    "DRIFTING_DATABASE_SIGKILL_RECEIPT",
                    &receipt.recovery_session_id,
                )
                .env("DRIFTING_TEST_DATABASE_KILL_STAGE", stage)
                .stdout(Stdio::piped())
                .spawn()
                .expect("spawn migration worker");
            let mut output = BufReader::new(child.stdout.take().expect("worker stdout"));
            let mut line = String::new();
            loop {
                line.clear();
                assert!(output.read_line(&mut line).expect("read worker output") > 0);
                if line.contains(&format!("DATABASE_MIGRATION_STAGE:{stage}")) {
                    break;
                }
            }
            child.kill().expect("kill migration worker");
            let status = child.wait().expect("wait for migration worker");
            assert_eq!(status.signal(), Some(9));

            reconcile_incomplete_shadow_migration(directory.path(), &database_path)
                .expect("reconcile interrupted migration");
            let connection = Connection::open(&database_path).expect("open reconciled database");
            let value: String = connection
                .query_row("SELECT value FROM crash_truth", [], |row| row.get(0))
                .expect("read authority sentinel");
            assert_eq!(value, if stage == "marker" { "new" } else { "old" });
            let integrity: String = connection
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .expect("run integrity check");
            assert_eq!(integrity, "ok");
            assert!(
                !recovery_receipt_path(directory.path(), &receipt.recovery_session_id).exists()
            );
        }
    }
}
