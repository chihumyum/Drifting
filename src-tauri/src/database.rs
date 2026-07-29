use std::collections::VecDeque;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use include_dir::{include_dir, Dir};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

type DatabaseResult<T> = Result<T, String>;
type Response<T> = mpsc::Sender<DatabaseResult<T>>;

const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_SESSION_ID_MAX_LENGTH: usize = 128;
const MIGRATION_BREAKPOINT: &str = "--> statement-breakpoint";
const MIGRATIONS_TABLE: &str = "__drizzle_migrations";

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
    Shutdown,
}

struct GatewayInner {
    sender: mpsc::Sender<Request>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
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
        let worker = thread::Builder::new()
            .name("drifting-sqlite".into())
            .spawn(move || worker_loop(receiver, database_directory))
            .map_err(|error| format!("failed to start SQLite worker: {error}"))?;

        Ok(Self {
            inner: Arc::new(GatewayInner {
                sender,
                worker: Mutex::new(Some(worker)),
            }),
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
    let connection = Connection::open_with_flags(&database_path, flags)
        .map_err(|error| format!("failed to open database: {error}"))?;
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(|error| format!("failed to configure SQLite busy timeout: {error}"))?;

    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|error| format!("failed to enable WAL mode: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("failed to configure SQLite synchronous mode: {error}"))?;
    connection
        .pragma_update(None, "wal_autocheckpoint", 1_000_i64)
        .map_err(|error| format!("failed to configure WAL autocheckpoint: {error}"))?;

    let migrations_applied = apply_migrations(&connection)?;
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

    let last_migration: Option<i64> = connection
        .query_row(
            &format!("SELECT created_at FROM {MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1"),
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to read Drizzle migration state: {error}"))?;

    if let Some(last) = last_migration {
        let latest_embedded = journal
            .entries
            .last()
            .map(|entry| entry.when)
            .ok_or_else(|| {
                "database has migration history but the embedded journal is empty".to_string()
            })?;
        if last > latest_embedded {
            return Err(format!(
                "database schema is newer than this Drifting build ({last} > {latest_embedded}); upgrade the app before opening it"
            ));
        }
    }

    let mut applied = 0;
    for entry in journal.entries.iter().filter(|entry| match last_migration {
        Some(last) => last < entry.when,
        None => true,
    }) {
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

#[tauri::command]
pub async fn database_open(
    gateway: State<'_, DatabaseGateway>,
    database_name: String,
    client_session_id: String,
    recover_stale_transaction: Option<bool>,
) -> DatabaseResult<DatabaseOpenResult> {
    let gateway = gateway.inner().clone();
    run_blocking(move || {
        gateway.open(
            database_name,
            client_session_id,
            recover_stale_transaction.unwrap_or(false),
        )
    })
    .await
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
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use rusqlite::{Connection, OpenFlags};
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    use super::{DatabaseGateway, DatabaseValue, TransactionBehavior, MIGRATIONS_TABLE};

    const CLIENT_SESSION: &str = "test-renderer-session";

    fn gateway() -> (TempDir, DatabaseGateway) {
        let directory = TempDir::new().expect("temporary database directory");
        let gateway = DatabaseGateway::new(directory.path().to_path_buf()).expect("gateway");
        (directory, gateway)
    }

    fn integer(value: i64) -> DatabaseValue {
        DatabaseValue::Integer(value.to_string())
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
    fn embedded_drizzle_migrations_are_compatible_and_idempotent() {
        let (_directory, gateway) = gateway();
        let first_open = gateway
            .open("migrations.db".into(), CLIENT_SESSION.into(), false)
            .expect("first open");
        assert_eq!(first_open.migrations_applied, 62);
        assert_eq!(first_open.journal_mode.to_ascii_lowercase(), "wal");

        let migration_count = gateway
            .query(
                format!("SELECT count(*) FROM {MIGRATIONS_TABLE}"),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("migration count");
        assert_eq!(migration_count.rows, [vec![integer(62)]]);

        gateway
            .close(CLIENT_SESSION.into())
            .expect("close database");
        let second_open = gateway
            .open("migrations.db".into(), CLIENT_SESSION.into(), false)
            .expect("second open");
        assert_eq!(second_open.migrations_applied, 0);
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
        assert_eq!(
            integrity.rows,
            [vec![DatabaseValue::Text("ok".into())]]
        );
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

    /// Opt-in compatibility test for a real Electron database. It is skipped
    /// during ordinary test runs; set DRIFTING_COMPAT_DB to a read-only source
    /// path to exercise the embedded migrations and Tauri gateway on a snapshot.
    #[test]
    fn opens_a_real_electron_database_snapshot_when_requested() {
        use rusqlite::backup::Backup;

        let Some(source_path) = std::env::var_os("DRIFTING_COMPAT_DB").map(PathBuf::from) else {
            return;
        };
        let source = Connection::open_with_flags(
            &source_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("open real Electron database read-only");
        let source_integrity: String = source
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("check source integrity");
        assert_eq!(source_integrity.to_ascii_lowercase(), "ok");
        let source_counts = application_table_counts(&source);
        let source_blobs = application_blob_digests(&source);

        let directory = tempfile::tempdir().expect("compatibility tempdir");
        let snapshot_path = directory.path().join("compat.db");
        let mut snapshot = Connection::open(&snapshot_path).expect("create snapshot");
        {
            let backup = Backup::new(&source, &mut snapshot).expect("start SQLite backup");
            backup
                .run_to_completion(128, Duration::from_millis(10), None)
                .expect("copy SQLite snapshot");
        }
        snapshot.close().expect("close snapshot");

        let gateway = DatabaseGateway::new(directory.path().to_path_buf()).expect("gateway");
        gateway
            .open("compat.db".into(), CLIENT_SESSION.into(), false)
            .expect("open through gateway");
        let integrity = gateway
            .query(
                "PRAGMA integrity_check".into(),
                Vec::new(),
                None,
                CLIENT_SESSION.into(),
            )
            .expect("query integrity through gateway");
        assert_eq!(integrity.rows, [vec![DatabaseValue::Text("ok".into())]]);
        gateway
            .close(CLIENT_SESSION.into())
            .expect("close compatibility database");

        let migrated = Connection::open_with_flags(
            snapshot_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("reopen migrated snapshot");
        let migrated_counts = application_table_counts(&migrated);
        for (table, source_count) in source_counts {
            let migrated_count = migrated_counts
                .iter()
                .find_map(|(candidate, count)| (candidate == &table).then_some(*count));
            assert_eq!(
                migrated_count,
                Some(source_count),
                "row count changed while migrating table {table}"
            );
        }
        assert_eq!(source_blobs, application_blob_digests(&migrated));
        let migration_count: i64 = migrated
            .query_row(
                &format!("SELECT count(*) FROM {MIGRATIONS_TABLE}"),
                [],
                |row| row.get(0),
            )
            .expect("migration count");
        assert_eq!(migration_count, 62);
    }

    fn application_table_counts(connection: &Connection) -> Vec<(String, i64)> {
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
                 AND name <> '__drizzle_migrations' ORDER BY name",
            )
            .expect("prepare table list");
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query table list")
            .collect::<Result<Vec<_>, _>>()
            .expect("read table list");
        tables
            .into_iter()
            .map(|table| {
                let identifier = table.replace('"', "\"\"");
                let count = connection
                    .query_row(
                        &format!("SELECT count(*) FROM \"{identifier}\""),
                        [],
                        |row| row.get(0),
                    )
                    .expect("count application table");
                (table, count)
            })
            .collect()
    }

    fn application_blob_digests(connection: &Connection) -> Vec<(&'static str, usize, String)> {
        [
            ("entity_snapshot_history", "state_blob"),
            ("yjs_updates", "update_blob"),
            ("yjs_snapshots", "state_blob"),
        ]
        .into_iter()
        .filter_map(|(table, column)| {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .expect("check blob table");
            if !exists {
                return None;
            }

            let mut statement = connection
                .prepare(&format!(
                    "SELECT \"{column}\" FROM \"{table}\" ORDER BY rowid"
                ))
                .expect("prepare blob digest query");
            let blobs = statement
                .query_map([], |row| row.get::<_, Vec<u8>>(0))
                .expect("query blobs")
                .collect::<Result<Vec<_>, _>>()
                .expect("read blobs");
            let mut digest = Sha256::new();
            for blob in &blobs {
                digest.update((blob.len() as u64).to_le_bytes());
                digest.update(blob);
            }
            Some((table, blobs.len(), format!("{:x}", digest.finalize())))
        })
        .collect()
    }
}
