//! Complete local library backups: one `.drifting` ZIP holding a standalone
//! SQLite snapshot and every app-owned asset file its rows reference.
//!
//! Export never modifies the library. Restore first extracts and verifies the
//! whole package into a private staging directory and migrates a candidate
//! copy there. Only then, with the library closed, does it save the current
//! library as a pre-restore package, merge asset files additively and replace
//! the database file. A crash at any point leaves either the old or the new
//! database, each with every asset file it references.
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::asset_store::sanitized_asset_segment;
use crate::database::{
    apply_migrations, record_opened_app_version, remove_database_sidecars,
    snapshot_connection_into, validate_database_truth,
};
use crate::file_io::{
    atomic_copy_capped, durable_replace_file, ensure_parent_directory, sync_directory,
    temporary_sibling,
};

pub const BACKUP_FORMAT: &str = "drifting-library-backup";
pub const BACKUP_FORMAT_VERSION: u32 = 1;
pub const BACKUP_EXTENSION: &str = "drifting";

const MANIFEST_PATH: &str = "manifest.json";
const DATABASE_PATH: &str = "library.sqlite";
const ASSETS_PREFIX: &str = "assets/";
const CANDIDATE_FILE: &str = "candidate.sqlite";
const STAGED_MANIFEST_FILE: &str = "staged-manifest.json";
const MANIFEST_LIMIT: u64 = 64 * 1024 * 1024;
const DATABASE_LIMIT: u64 = 64 * 1024 * 1024 * 1024;
const ASSET_FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const ASSET_VARIANTS: [&str; 3] = ["source", "display", "thumbnail"];
const PRE_RESTORE_PACKAGES_RETAINED: usize = 3;
const PRE_RESTORE_PREFIX: &str = "Drifting-pre-restore-";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupFile {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupProject {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupManifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub created_at_ms: u64,
    pub database: BackupFile,
    pub projects: Vec<BackupProject>,
    pub assets: Vec<BackupFile>,
    /// Referenced assets whose directory was absent on the exporting device.
    pub missing_assets: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub created_at_ms: u64,
    pub app_version: String,
    pub projects: Vec<BackupProject>,
    pub asset_file_count: u64,
    pub missing_asset_count: u64,
    pub package_size_bytes: u64,
}

/// Paths a closed-library restore needs. `staging` must hold a package staged
/// by [`stage_backup_package`].
#[derive(Clone, Debug)]
pub struct LibraryRestorePlan {
    pub staging: PathBuf,
    pub assets_root: PathBuf,
    pub safety_directory: PathBuf,
    pub app_version: String,
    pub now_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRestoreOutcome {
    /// File name of the package holding the library that was replaced.
    pub pre_restore_package: Option<String>,
    pub restored_project_count: u64,
}

fn sha256_hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn file_sha256(path: &Path) -> io::Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((sha256_hex(hasher.finalize()), size))
}

/// Backups and restores carry local libraries only. A cloud-bound library has
/// provider bindings, cursors and writer lanes that a copy must not revive.
fn require_local_authority(connection: &Connection) -> Result<(), String> {
    let authority: Option<(String, String)> = connection
        .query_row(
            "SELECT mode, transition_state FROM sync_app_authority WHERE id = 'app'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to read the library sync mode: {error}"))?;
    match authority {
        Some((mode, state)) if mode == "local" && state == "stable" => Ok(()),
        Some(_) => Err(
            "library-sync-connected: disconnect sync before backing up or restoring the library"
                .into(),
        ),
        None => Err("the library has no sync authority record".into()),
    }
}

fn is_asset_file_name(name: &str) -> bool {
    let Some((variant, extension)) = name.split_once('.') else {
        return false;
    };
    ASSET_VARIANTS.contains(&variant)
        && !extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn is_segment(value: &str) -> bool {
    sanitized_asset_segment(value).as_deref() == Ok(value)
}

/// `assets/<project>/<asset>/<variant>.<ext>`, each segment already in the
/// sanitized on-disk form.
fn asset_relative_path(path: &str) -> Option<(&str, &str, &str)> {
    let rest = path.strip_prefix(ASSETS_PREFIX)?;
    let mut parts = rest.split('/');
    let (project, asset, file) = (parts.next()?, parts.next()?, parts.next()?);
    (parts.next().is_none() && is_segment(project) && is_segment(asset) && is_asset_file_name(file))
        .then_some((project, asset, file))
}

fn real_directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "asset paths may not be symlinks",
        )),
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
    size: u64,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..read]);
        self.size += read as u64;
        Ok(read)
    }
}

fn add_file<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    entry: &str,
    source: &Path,
    method: CompressionMethod,
) -> Result<BackupFile, String> {
    let file = File::open(source).map_err(|error| format!("failed to read {entry}: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("failed to read {entry}: {error}"))?
        .len();
    let options = SimpleFileOptions::default()
        .compression_method(method)
        .large_file(length >= u64::from(u32::MAX));
    zip.start_file(entry, options)
        .map_err(|error| format!("failed to add {entry} to the backup: {error}"))?;
    let mut reader = HashingReader {
        inner: file,
        hasher: Sha256::new(),
        size: 0,
    };
    io::copy(&mut reader, zip)
        .map_err(|error| format!("failed to add {entry} to the backup: {error}"))?;
    Ok(BackupFile {
        path: entry.to_owned(),
        sha256: sha256_hex(reader.hasher.finalize()),
        size_bytes: reader.size,
    })
}

/// Package the standalone, closed `snapshot` database and the asset files its
/// `project_asset` rows reference into `destination`, replacing it atomically.
pub fn write_backup_package(
    snapshot: &Path,
    assets_root: &Path,
    destination: &Path,
    app_version: &str,
    created_at_ms: u64,
) -> Result<BackupSummary, String> {
    let connection = Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("failed to open the library snapshot: {error}"))?;
    validate_database_truth(&connection)?;
    require_local_authority(&connection)?;
    let projects = {
        let mut statement = connection
            .prepare("SELECT id, name FROM project ORDER BY created_at, id")
            .map_err(|error| format!("failed to list backup projects: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(BackupProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(|error| format!("failed to list backup projects: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to list backup projects: {error}"))?
    };
    let referenced_assets = {
        let mut statement = connection
            .prepare("SELECT project_id, id FROM project_asset ORDER BY project_id, id")
            .map_err(|error| format!("failed to list backup assets: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("failed to list backup assets: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to list backup assets: {error}"))?
    };
    drop(connection);

    ensure_parent_directory(destination)
        .map_err(|error| format!("failed to prepare the backup location: {error}"))?;
    let temporary = temporary_sibling(destination)
        .map_err(|error| format!("failed to prepare the backup file: {error}"))?;
    let written = (|| {
        let file = File::create(&temporary)
            .map_err(|error| format!("failed to create the backup file: {error}"))?;
        let mut zip = ZipWriter::new(file);
        let database = add_file(
            &mut zip,
            DATABASE_PATH,
            snapshot,
            CompressionMethod::Deflated,
        )?;
        let mut assets = Vec::new();
        let mut missing_assets = 0u64;
        for (project_id, asset_id) in &referenced_assets {
            let project = sanitized_asset_segment(project_id)?;
            let asset = sanitized_asset_segment(asset_id)?;
            let directory = assets_root.join(&project).join(&asset);
            let present = real_directory(assets_root)
                .and_then(|_| real_directory(&assets_root.join(&project)))
                .and_then(|_| real_directory(&directory))
                .map_err(|error| format!("failed to read asset {asset_id}: {error}"))?;
            if !present {
                missing_assets += 1;
                continue;
            }
            let mut files = fs::read_dir(&directory)
                .map_err(|error| format!("failed to read asset {asset_id}: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to read asset {asset_id}: {error}"))?;
            files.sort_by_key(|entry| entry.file_name());
            for entry in files {
                let kind = entry
                    .file_type()
                    .map_err(|error| format!("failed to read asset {asset_id}: {error}"))?;
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                if !kind.is_file() || !is_asset_file_name(&name) {
                    continue;
                }
                let path = format!("{ASSETS_PREFIX}{project}/{asset}/{name}");
                assets.push(add_file(
                    &mut zip,
                    &path,
                    &entry.path(),
                    CompressionMethod::Stored,
                )?);
            }
        }
        let manifest = BackupManifest {
            format: BACKUP_FORMAT.into(),
            format_version: BACKUP_FORMAT_VERSION,
            app_version: app_version.into(),
            created_at_ms,
            database,
            projects: projects.clone(),
            assets,
            missing_assets,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("failed to encode the backup manifest: {error}"))?;
        zip.start_file(MANIFEST_PATH, SimpleFileOptions::default())
            .and_then(|()| zip.write_all(&manifest_bytes).map_err(Into::into))
            .map_err(|error| format!("failed to write the backup manifest: {error}"))?;
        let file = zip
            .finish()
            .map_err(|error| format!("failed to finish the backup file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to finish the backup file: {error}"))?;
        drop(file);
        durable_replace_file(&temporary, destination)
            .map_err(|error| format!("failed to save the backup file: {error}"))?;
        Ok(manifest)
    })();
    let manifest = match written {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    let package_size_bytes = fs::metadata(destination)
        .map_err(|error| format!("failed to inspect the backup file: {error}"))?
        .len();
    Ok(summary(&manifest, package_size_bytes))
}

fn summary(manifest: &BackupManifest, package_size_bytes: u64) -> BackupSummary {
    BackupSummary {
        created_at_ms: manifest.created_at_ms,
        app_version: manifest.app_version.clone(),
        projects: manifest.projects.clone(),
        asset_file_count: manifest.assets.len() as u64,
        missing_asset_count: manifest.missing_assets,
        package_size_bytes,
    }
}

fn validate_manifest(manifest: &BackupManifest) -> Result<(), String> {
    if manifest.format != BACKUP_FORMAT {
        return Err("backup-invalid: the file is not a Drifting library backup".into());
    }
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err("backup-newer: the backup uses a newer format; update Drifting first".into());
    }
    if manifest.database.path != DATABASE_PATH || manifest.database.size_bytes > DATABASE_LIMIT {
        return Err("backup-invalid: the backup database entry is invalid".into());
    }
    let mut paths = HashSet::new();
    for asset in &manifest.assets {
        if asset_relative_path(&asset.path).is_none()
            || asset.size_bytes > ASSET_FILE_LIMIT
            || !paths.insert(asset.path.as_str())
        {
            return Err("backup-invalid: the backup lists an invalid asset path".into());
        }
    }
    Ok(())
}

fn extract_verified<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    expected: &BackupFile,
    destination: &Path,
) -> Result<(), String> {
    let mut entry = archive.by_name(&expected.path).map_err(|_| {
        format!(
            "backup-invalid: {} is missing from the backup",
            expected.path
        )
    })?;
    if entry.size() != expected.size_bytes {
        return Err(format!(
            "backup-invalid: {} has the wrong size",
            expected.path
        ));
    }
    ensure_parent_directory(destination)
        .map_err(|error| format!("failed to stage {}: {error}", expected.path))?;
    let mut output = File::create(destination)
        .map_err(|error| format!("failed to stage {}: {error}", expected.path))?;
    let mut reader = HashingReader {
        inner: (&mut entry).take(expected.size_bytes.saturating_add(1)),
        hasher: Sha256::new(),
        size: 0,
    };
    io::copy(&mut reader, &mut output)
        .map_err(|error| format!("failed to stage {}: {error}", expected.path))?;
    if reader.size != expected.size_bytes || sha256_hex(reader.hasher.finalize()) != expected.sha256
    {
        return Err(format!(
            "backup-invalid: {} does not match its checksum",
            expected.path
        ));
    }
    output
        .sync_all()
        .map_err(|error| format!("failed to stage {}: {error}", expected.path))
}

/// Extract and verify `package` into the new, empty `staging` directory, then
/// prepare its candidate database: migrated to this build, every project owned
/// by `project_user_id`, and every sync writer retired so the next local write
/// starts a fresh writer identity instead of reusing published sequences.
pub fn stage_backup_package(
    package: &Path,
    staging: &Path,
    project_user_id: &str,
    now_iso: &str,
) -> Result<BackupSummary, String> {
    if staging.exists() {
        return Err("backup staging directory already exists".into());
    }
    fs::create_dir_all(staging)
        .map_err(|error| format!("failed to create the backup staging directory: {error}"))?;
    let staged = stage_into(package, staging, project_user_id, now_iso);
    if staged.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    staged
}

fn stage_into(
    package: &Path,
    staging: &Path,
    project_user_id: &str,
    now_iso: &str,
) -> Result<BackupSummary, String> {
    let file =
        File::open(package).map_err(|error| format!("failed to open the backup: {error}"))?;
    let package_size_bytes = file
        .metadata()
        .map_err(|error| format!("failed to open the backup: {error}"))?
        .len();
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "backup-invalid: the file is not a Drifting library backup".to_string())?;

    let manifest: BackupManifest = {
        let mut entry = archive
            .by_name(MANIFEST_PATH)
            .map_err(|_| "backup-invalid: the file is not a Drifting library backup".to_string())?;
        if entry.size() > MANIFEST_LIMIT {
            return Err("backup-invalid: the backup manifest is too large".into());
        }
        let mut bytes = Vec::new();
        (&mut entry)
            .take(MANIFEST_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "backup-invalid: the backup manifest is unreadable".to_string())?;
        serde_json::from_slice(&bytes)
            .map_err(|_| "backup-invalid: the backup manifest is unreadable".to_string())?
    };
    validate_manifest(&manifest)?;

    let mut expected: HashSet<&str> = manifest
        .assets
        .iter()
        .map(|asset| asset.path.as_str())
        .collect();
    expected.insert(MANIFEST_PATH);
    expected.insert(DATABASE_PATH);
    if archive.len() != expected.len() || archive.file_names().any(|name| !expected.contains(name))
    {
        return Err("backup-invalid: the backup contains unexpected entries".into());
    }

    let candidate = staging.join(CANDIDATE_FILE);
    extract_verified(&mut archive, &manifest.database, &candidate)?;
    for asset in &manifest.assets {
        extract_verified(&mut archive, asset, &staging.join(&asset.path))?;
    }

    let connection = Connection::open(&candidate)
        .map_err(|_| "backup-invalid: the backup database cannot be opened".to_string())?;
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .and_then(|()| connection.pragma_update(None, "synchronous", "FULL"))
        .map_err(|_| "backup-invalid: the backup database cannot be opened".to_string())?;
    validate_staged_candidate(&connection, project_user_id, now_iso)?;
    drop(connection);
    File::open(&candidate)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("failed to finalize the restore candidate: {error}"))?;

    let manifest_bytes = serde_json::to_vec(&manifest)
        .map_err(|error| format!("failed to record the staged backup: {error}"))?;
    crate::file_io::atomic_write(&staging.join(STAGED_MANIFEST_FILE), &manifest_bytes)
        .map_err(|error| format!("failed to record the staged backup: {error}"))?;
    Ok(summary(&manifest, package_size_bytes))
}

fn validate_staged_candidate(
    connection: &Connection,
    project_user_id: &str,
    now_iso: &str,
) -> Result<(), String> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| "backup-invalid: the backup database is damaged".to_string())?;
    if integrity != "ok" {
        return Err("backup-invalid: the backup database is damaged".into());
    }
    apply_migrations(connection).map_err(|error| {
        if error.contains("newer than this Drifting build") {
            "backup-newer: the backup was made by a newer Drifting; update the app first".into()
        } else {
            format!("backup-invalid: the backup database cannot be upgraded ({error})")
        }
    })?;
    require_local_authority(connection)?;
    connection
        .execute(
            "UPDATE sync_generation_writer_state SET retired_at = ?1, updated_at = ?1 \
             WHERE retired_at IS NULL",
            params![now_iso],
        )
        .map_err(|error| format!("failed to retire restored sync writers: {error}"))?;
    connection
        .execute("UPDATE project SET user_id = ?1", params![project_user_id])
        .map_err(|error| format!("failed to assign restored projects: {error}"))?;
    validate_database_truth(connection)
        .map_err(|error| format!("backup-invalid: the restored database is inconsistent ({error})"))
}

fn read_staged_manifest(staging: &Path) -> Result<BackupManifest, String> {
    let bytes = fs::read(staging.join(STAGED_MANIFEST_FILE)).map_err(|_| {
        "the staged backup is no longer available; choose the file again".to_string()
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "the staged backup is no longer available; choose the file again".to_string())
}

/// Copy staged asset files into the asset store without removing anything.
/// Asset identifiers are immutable, so an existing derivative is kept and an
/// existing source is replaced only when it no longer matches the backup.
fn merge_assets(
    staging: &Path,
    assets_root: &Path,
    manifest: &BackupManifest,
) -> Result<(), String> {
    fs::create_dir_all(assets_root)
        .map_err(|error| format!("failed to prepare the asset store: {error}"))?;
    real_directory(assets_root)
        .map_err(|error| format!("failed to prepare the asset store: {error}"))?;
    let mut created_projects = HashSet::new();
    for asset in &manifest.assets {
        let (project, asset_id, file) =
            asset_relative_path(&asset.path).ok_or("backup-invalid: invalid staged asset path")?;
        let project_directory = assets_root.join(project);
        let directory = project_directory.join(asset_id);
        for path in [&project_directory, &directory] {
            real_directory(path)
                .map_err(|error| format!("failed to restore asset files: {error}"))?;
        }
        let target = directory.join(file);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("failed to restore asset files: an asset path is not a file".into());
            }
            Ok(_) => {
                let keep = !file.starts_with("source.")
                    || file_sha256(&target)
                        .map(|(sha256, size)| sha256 == asset.sha256 && size == asset.size_bytes)
                        .unwrap_or(false);
                if keep {
                    continue;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to restore asset files: {error}")),
        }
        if !project_directory.exists() {
            created_projects.insert(project.to_owned());
        }
        atomic_copy_capped(&staging.join(&asset.path), &target, ASSET_FILE_LIMIT)
            .map_err(|error| format!("failed to restore asset files: {error}"))?;
    }
    for project in created_projects {
        let _ = sync_directory(&assets_root.join(project));
    }
    sync_directory(assets_root).map_err(|error| format!("failed to restore asset files: {error}"))
}

fn retain_recent_pre_restore_packages(directory: &Path) -> Result<(), String> {
    let mut packages = fs::read_dir(directory)
        .map_err(|error| format!("failed to inspect pre-restore backups: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            (name.starts_with(PRE_RESTORE_PREFIX)
                && name.ends_with(&format!(".{BACKUP_EXTENSION}"))
                && entry.file_type().ok()?.is_file())
            .then_some((name, entry.path()))
        })
        .collect::<Vec<_>>();
    // Names embed a zero-padded millisecond timestamp, so they sort by age.
    packages.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in packages.into_iter().skip(PRE_RESTORE_PACKAGES_RETAINED) {
        fs::remove_file(path)
            .map_err(|error| format!("failed to prune a pre-restore backup: {error}"))?;
    }
    Ok(())
}

/// Save the closed library at `database_path` as a pre-restore package.
fn save_pre_restore_package(
    database_path: &Path,
    plan: &LibraryRestorePlan,
) -> Result<Option<String>, String> {
    let exists = fs::metadata(database_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if !exists {
        return Ok(None);
    }
    fs::create_dir_all(&plan.safety_directory)
        .map_err(|error| format!("failed to prepare the pre-restore backup: {error}"))?;
    let snapshot = plan.staging.join("pre-restore.sqlite");
    let _ = fs::remove_file(&snapshot);
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("failed to open the current library: {error}"))?;
    snapshot_connection_into(&connection, &snapshot)?;
    drop(connection);
    let name = format!("{PRE_RESTORE_PREFIX}{:016}.{BACKUP_EXTENSION}", plan.now_ms);
    let result = write_backup_package(
        &snapshot,
        &plan.assets_root,
        &plan.safety_directory.join(&name),
        &plan.app_version,
        plan.now_ms,
    );
    let _ = fs::remove_file(&snapshot);
    result?;
    retain_recent_pre_restore_packages(&plan.safety_directory)?;
    Ok(Some(name))
}

/// Replace the closed library at `database_path` with the staged backup.
pub(crate) fn restore_staged_backup(
    database_directory: &Path,
    database_path: &Path,
    plan: &LibraryRestorePlan,
) -> Result<LibraryRestoreOutcome, String> {
    let manifest = read_staged_manifest(&plan.staging)?;
    let candidate = plan.staging.join(CANDIDATE_FILE);
    {
        let connection = Connection::open_with_flags(&candidate, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| {
                "the staged backup is no longer available; choose the file again".to_string()
            })?;
        validate_database_truth(&connection)?;
    }
    let pre_restore_package = save_pre_restore_package(database_path, plan)?;
    merge_assets(&plan.staging, &plan.assets_root, &manifest)?;

    remove_database_sidecars(database_path)?;
    durable_replace_file(&candidate, database_path)
        .map_err(|error| format!("failed to activate the restored library: {error}"))?;
    // A stale marker is safe: the next open re-verifies through the
    // pre-update safety path before trusting the database.
    let _ = record_opened_app_version(database_directory, database_path, &plan.app_version);
    let _ = fs::remove_dir_all(&plan.staging);
    Ok(LibraryRestoreOutcome {
        pre_restore_package,
        restored_project_count: manifest.projects.len() as u64,
    })
}

#[cfg(test)]
mod tests;
