#[cfg(desktop)]
use std::ffi::OsStr;
use std::fs;
#[cfg(desktop)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(desktop)]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(desktop)]
use rusqlite::backup::Backup;
#[cfg(desktop)]
use rusqlite::{Connection, OpenFlags};
#[cfg(desktop)]
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
const LEGACY_PRODUCT_DIRECTORY: &str = "Drifting";
const DATABASE_DIRECTORY: &str = "databases";
#[cfg(desktop)]
const ASSET_CACHE_DIRECTORY: &str = "asset-cache";
#[cfg(desktop)]
const MIGRATION_MARKER: &str = "electron-data-migration-v1.json";

type MigrationResult<T> = Result<T, String>;

pub struct DataDirectories {
    pub database_directory: PathBuf,
}

#[cfg(desktop)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationMarker {
    version: u8,
    source_directory: String,
    completed_at_unix_ms: u128,
    databases_copied: Vec<String>,
    asset_files_copied: usize,
}

pub fn prepare_data_directories(app: &AppHandle) -> MigrationResult<DataDirectories> {
    if let Some(database_directory) = database_directory_override()? {
        fs::create_dir_all(&database_directory).map_err(|error| {
            format!(
                "failed to create DRIFTING_DB_DIR {}: {error}",
                database_directory.display()
            )
        })?;
        return Ok(DataDirectories { database_directory });
    }

    let target_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve Tauri data directory: {error}"))?;
    fs::create_dir_all(&target_root).map_err(|error| {
        format!(
            "failed to create Tauri data directory {}: {error}",
            target_root.display()
        )
    })?;

    #[cfg(desktop)]
    {
        let legacy_root = legacy_user_data_directory(app)?;
        if legacy_root != target_root {
            migrate_legacy_data(&legacy_root, &target_root)?;
        }
    }

    let database_directory = target_root.join(DATABASE_DIRECTORY);
    fs::create_dir_all(&database_directory).map_err(|error| {
        format!(
            "failed to create database directory {}: {error}",
            database_directory.display()
        )
    })?;

    Ok(DataDirectories { database_directory })
}

fn database_directory_override() -> MigrationResult<Option<PathBuf>> {
    let Some(value) = std::env::var_os("DRIFTING_DB_DIR") else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }

    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(Some(path))
    } else {
        std::env::current_dir()
            .map(|current| Some(current.join(path)))
            .map_err(|error| format!("failed to resolve DRIFTING_DB_DIR: {error}"))
    }
}

#[cfg(desktop)]
fn legacy_user_data_directory(app: &AppHandle) -> MigrationResult<PathBuf> {
    if let Some(value) = std::env::var_os("DRIFTING_LEGACY_USER_DATA_DIR") {
        if !value.is_empty() {
            let path = PathBuf::from(value);
            return if path.is_absolute() {
                Ok(path)
            } else {
                std::env::current_dir()
                    .map(|current| current.join(path))
                    .map_err(|error| {
                        format!("failed to resolve DRIFTING_LEGACY_USER_DATA_DIR: {error}")
                    })
            };
        }
    }

    app.path()
        .config_dir()
        .map(|directory| directory.join(LEGACY_PRODUCT_DIRECTORY))
        .map_err(|error| format!("failed to resolve legacy Electron data directory: {error}"))
}

#[cfg(desktop)]
fn migrate_legacy_data(source_root: &Path, target_root: &Path) -> MigrationResult<()> {
    if !source_root.is_dir() {
        return Ok(());
    }

    let marker_path = target_root.join(MIGRATION_MARKER);
    if marker_path.is_file() {
        return Ok(());
    }

    let target_databases = target_root.join(DATABASE_DIRECTORY);
    fs::create_dir_all(&target_databases).map_err(|error| {
        format!(
            "failed to create migrated database directory {}: {error}",
            target_databases.display()
        )
    })?;

    let databases_copied =
        migrate_database_directory(&source_root.join(DATABASE_DIRECTORY), &target_databases)?;
    let asset_files_copied = copy_directory_without_overwrite(
        &source_root.join(ASSET_CACHE_DIRECTORY),
        &target_root.join(ASSET_CACHE_DIRECTORY),
    )?;

    let marker = MigrationMarker {
        version: 1,
        source_directory: source_root.to_string_lossy().into_owned(),
        completed_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        databases_copied,
        asset_files_copied,
    };
    write_json_atomically(&marker_path, &marker)
}

#[cfg(desktop)]
fn migrate_database_directory(source: &Path, target: &Path) -> MigrationResult<Vec<String>> {
    if !source.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("failed to read legacy database directory: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to inspect legacy database directory: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut copied = Vec::new();
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        if !file_type.is_file() || entry.path().extension() != Some(OsStr::new("db")) {
            continue;
        }

        let destination = target.join(entry.file_name());
        if destination.exists() {
            validate_database(&destination, "existing Tauri database")?;
            continue;
        }

        backup_database_atomically(&entry.path(), &destination)?;
        copied.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(copied)
}

#[cfg(desktop)]
fn backup_database_atomically(source: &Path, destination: &Path) -> MigrationResult<()> {
    validate_database(source, "legacy Electron database")?;

    let filename = destination
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| format!("invalid database filename: {}", destination.display()))?;
    let temporary = destination.with_file_name(format!(".{filename}.electron-migration.tmp"));
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(|error| {
            format!(
                "failed to remove interrupted migration file {}: {error}",
                temporary.display()
            )
        })?;
    }

    let source_connection = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        format!(
            "failed to open legacy database {}: {error}",
            source.display()
        )
    })?;
    let mut destination_connection = Connection::open(&temporary).map_err(|error| {
        format!(
            "failed to create migrated database {}: {error}",
            temporary.display()
        )
    })?;

    {
        let backup = Backup::new(&source_connection, &mut destination_connection)
            .map_err(|error| format!("failed to start SQLite backup: {error}"))?;
        backup
            .run_to_completion(128, Duration::from_millis(10), None)
            .map_err(|error| format!("failed to copy SQLite snapshot: {error}"))?;
    }
    destination_connection
        .close()
        .map_err(|(_, error)| format!("failed to close migrated database: {error}"))?;

    if let Err(error) = validate_database(&temporary, "migrated Tauri database") {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    fs::rename(&temporary, destination).map_err(|error| {
        format!(
            "failed to activate migrated database {}: {error}",
            destination.display()
        )
    })
}

#[cfg(desktop)]
fn validate_database(path: &Path, label: &str) -> MigrationResult<()> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("failed to open {label} {}: {error}", path.display()))?;
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("failed to check {label} {}: {error}", path.display()))?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(format!(
            "{label} failed integrity_check at {}: {result}",
            path.display()
        ))
    }
}

#[cfg(desktop)]
fn copy_directory_without_overwrite(source: &Path, target: &Path) -> MigrationResult<usize> {
    if !source.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(target).map_err(|error| {
        format!(
            "failed to create asset directory {}: {error}",
            target.display()
        )
    })?;

    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("failed to read legacy assets {}: {error}", source.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to inspect legacy assets: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut copied = 0;
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        let destination = target.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(format!(
                "legacy asset cache contains an unsupported symlink: {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            copied += copy_directory_without_overwrite(&entry.path(), &destination)?;
        } else if file_type.is_file() && !destination.exists() {
            let filename = destination
                .file_name()
                .and_then(OsStr::to_str)
                .ok_or_else(|| format!("invalid asset filename: {}", destination.display()))?;
            let temporary = destination.with_file_name(format!(".{filename}.migration.tmp"));
            fs::copy(entry.path(), &temporary).map_err(|error| {
                format!(
                    "failed to copy legacy asset {}: {error}",
                    entry.path().display()
                )
            })?;
            fs::rename(&temporary, &destination).map_err(|error| {
                format!(
                    "failed to activate migrated asset {}: {error}",
                    destination.display()
                )
            })?;
            copied += 1;
        }
    }
    Ok(copied)
}

#[cfg(desktop)]
fn write_json_atomically(path: &Path, value: &impl Serialize) -> MigrationResult<()> {
    let serialized = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize migration marker: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serialized)
        .map_err(|error| format!("failed to write migration marker: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to activate migration marker: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_a_wal_database_and_assets_without_touching_the_source() {
        let source = tempfile::tempdir().expect("source tempdir");
        let target = tempfile::tempdir().expect("target tempdir");
        let source_databases = source.path().join(DATABASE_DIRECTORY);
        fs::create_dir_all(&source_databases).expect("source database directory");
        let source_database = source_databases.join("account.db");
        let connection = Connection::open(&source_database).expect("source database");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("WAL mode");
        connection
            .execute_batch(
                "CREATE TABLE note (body TEXT NOT NULL); INSERT INTO note VALUES ('draft');",
            )
            .expect("seed source database");

        let source_asset = source
            .path()
            .join(ASSET_CACHE_DIRECTORY)
            .join("project")
            .join("asset")
            .join("source.txt");
        fs::create_dir_all(source_asset.parent().expect("asset parent")).expect("asset directory");
        fs::write(&source_asset, b"asset bytes").expect("source asset");

        migrate_legacy_data(source.path(), target.path()).expect("legacy migration");

        let migrated = Connection::open(target.path().join(DATABASE_DIRECTORY).join("account.db"))
            .expect("migrated database");
        let body: String = migrated
            .query_row("SELECT body FROM note", [], |row| row.get(0))
            .expect("migrated row");
        assert_eq!(body, "draft");
        assert_eq!(
            fs::read(&source_asset).expect("source remains"),
            b"asset bytes"
        );
        assert_eq!(
            fs::read(
                target
                    .path()
                    .join(ASSET_CACHE_DIRECTORY)
                    .join("project")
                    .join("asset")
                    .join("source.txt")
            )
            .expect("migrated asset"),
            b"asset bytes"
        );
        assert!(target.path().join(MIGRATION_MARKER).is_file());
    }

    #[test]
    fn completed_migration_never_overwrites_tauri_data() {
        let source = tempfile::tempdir().expect("source tempdir");
        let target = tempfile::tempdir().expect("target tempdir");
        let source_asset = source.path().join(ASSET_CACHE_DIRECTORY).join("value.txt");
        fs::create_dir_all(source_asset.parent().expect("asset parent")).expect("asset directory");
        fs::write(&source_asset, b"electron").expect("source asset");

        migrate_legacy_data(source.path(), target.path()).expect("first migration");
        let target_asset = target.path().join(ASSET_CACHE_DIRECTORY).join("value.txt");
        fs::write(&target_asset, b"tauri").expect("modify target asset");
        fs::write(&source_asset, b"new electron value").expect("modify source asset");

        migrate_legacy_data(source.path(), target.path()).expect("idempotent migration");
        assert_eq!(fs::read(target_asset).expect("target asset"), b"tauri");
    }
}
