//! Durable, provider-neutral local objects for SyncEngine.
//!
//! Renderer code receives only `syncobj:` references. Protocol bytes, canonical
//! asset sources, and downloaded provider objects never cross the IPC boundary
//! as absolute paths. The Google Drive adapter streams the current plaintext
//! object format after re-validating the opaque reference, exact size, and
//! SHA-256 identity.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use zeroize::Zeroizing;

use crate::native_capabilities::{
    app_local_dir, asset_store_path, atomic_copy_capped, ensure_parent_directory, AssetVariant,
};

const OBJECT_ROOT: &str = "sync-objects";
const REF_PREFIX: &str = "syncobj:";
const MAX_STAGED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PROTOCOL_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SyncObjectKind {
    Segment,
    Genesis,
    Checkpoint,
    SnapshotCommit,
    Blob,
}

impl SyncObjectKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Segment => "segment",
            Self::Genesis => "genesis",
            Self::Checkpoint => "checkpoint",
            Self::SnapshotCommit => "snapshot-commit",
            Self::Blob => "blob",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalObjectResult {
    source_ref: String,
    size_bytes: u64,
    stored_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolChunkResult {
    offset: u64,
    total_size_bytes: u64,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncObjectGcResult {
    removed_objects: u64,
    removed_temporary_files: u64,
}

#[derive(Debug, Default, Eq, PartialEq)]
struct SyncObjectGcCounts {
    removed_objects: u64,
    removed_temporary_files: u64,
}

fn sha256_id(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn sha256_digest_id(digest: &[u8; 32]) -> String {
    format!(
        "sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn validate_sha256_id(value: &str) -> Result<(), String> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("sync object SHA-256 identity is invalid".into());
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<(), String> {
    if !(2..=128).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
    {
        return Err("local sync object reference is invalid".into());
    }
    Ok(())
}

fn token_from_ref(source_ref: &str) -> Result<&str, String> {
    let token = source_ref
        .strip_prefix(REF_PREFIX)
        .ok_or_else(|| "local sync object reference is invalid".to_string())?;
    validate_token(token)?;
    Ok(token)
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app_local_dir(app, OBJECT_ROOT)
}

fn path_for_token(root: &Path, token: &str) -> Result<PathBuf, String> {
    validate_token(token)?;
    let bucket = token
        .get(..2)
        .ok_or_else(|| "local sync object reference is invalid".to_string())?;
    Ok(root.join(bucket).join(format!("{token}.object")))
}

fn reject_symlink_chain(root: &Path, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "local sync object path has no parent".to_string())?;
    for candidate in [root, parent, path] {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("refusing to access a symlinked sync object path".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("could not validate local sync object path".into()),
        }
    }
    Ok(())
}

fn resolve_ref(app: &AppHandle, source_ref: &str, require_file: bool) -> Result<PathBuf, String> {
    let token = token_from_ref(source_ref)?;
    let object_root = root(app)?;
    let path = path_for_token(&object_root, token)?;
    reject_symlink_chain(&object_root, &path)?;
    if require_file {
        let metadata =
            fs::metadata(&path).map_err(|_| "local sync object is unavailable".to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_STAGED_BYTES {
            return Err("local sync object is invalid or too large".into());
        }
    }
    Ok(path)
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "OS CSPRNG is unavailable".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn allocate_ref(app: &AppHandle) -> Result<(String, PathBuf), String> {
    let object_root = root(app)?;
    for _ in 0..16 {
        let token = random_token()?;
        let path = path_for_token(&object_root, &token)?;
        reject_symlink_chain(&object_root, &path)?;
        if !path.exists() {
            return Ok((format!("{REF_PREFIX}{token}"), path));
        }
    }
    Err("could not allocate a unique local sync object".into())
}

fn retained_tokens(source_refs: &[String]) -> Result<HashSet<String>, String> {
    if source_refs.len() > 1_000_000 {
        return Err("local sync object retention set is too large".into());
    }
    source_refs
        .iter()
        .map(|source_ref| token_from_ref(source_ref).map(str::to_owned))
        .collect()
}

fn gc_orphan_objects_at(
    object_root: &Path,
    retained: &HashSet<String>,
    older_than: Duration,
    now: SystemTime,
) -> Result<SyncObjectGcCounts, String> {
    let root_metadata = match fs::symlink_metadata(object_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(SyncObjectGcCounts::default())
        }
        Err(_) => return Err("local sync object root could not be inspected".into()),
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("local sync object root is not a real directory".into());
    }

    let mut counts = SyncObjectGcCounts::default();
    for bucket_entry in fs::read_dir(object_root)
        .map_err(|_| "local sync object root could not be enumerated".to_string())?
    {
        let bucket_entry = bucket_entry
            .map_err(|_| "local sync object bucket could not be inspected".to_string())?;
        let bucket_path = bucket_entry.path();
        let bucket_metadata = fs::symlink_metadata(&bucket_path)
            .map_err(|_| "local sync object bucket could not be inspected".to_string())?;
        let bucket_name = bucket_entry
            .file_name()
            .into_string()
            .map_err(|_| "local sync object bucket name is invalid".to_string())?;
        if bucket_metadata.file_type().is_symlink()
            || !bucket_metadata.is_dir()
            || bucket_name.len() != 2
            || !bucket_name.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("local sync object bucket is invalid".into());
        }

        for object_entry in fs::read_dir(&bucket_path)
            .map_err(|_| "local sync object bucket could not be enumerated".to_string())?
        {
            let object_entry = object_entry
                .map_err(|_| "local sync object entry could not be inspected".to_string())?;
            let object_path = object_entry.path();
            let metadata = fs::symlink_metadata(&object_path)
                .map_err(|_| "local sync object entry could not be inspected".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("local sync object entry is not a real file".into());
            }
            let file_name = object_entry
                .file_name()
                .into_string()
                .map_err(|_| "local sync object entry name is invalid".to_string())?;
            let (token, temporary) = if let Some(token) = file_name.strip_suffix(".object") {
                (token, false)
            } else {
                let staged_name = file_name
                    .strip_prefix('.')
                    .and_then(|value| value.strip_suffix(".part"))
                    .ok_or_else(|| "local sync object entry name is invalid".to_string())?;
                let (destination_name, staging_token) = staged_name
                    .rsplit_once('.')
                    .ok_or_else(|| "local sync object entry name is invalid".to_string())?;
                if staging_token.is_empty()
                    || !staging_token
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                {
                    return Err("local sync object staging entry name is invalid".into());
                }
                let token = destination_name
                    .strip_suffix(".object")
                    .ok_or_else(|| "local sync object staging entry name is invalid".to_string())?;
                (token, true)
            };
            validate_token(token)?;
            let canonical_path = path_for_token(object_root, token)?;
            if (!temporary && canonical_path != object_path)
                || (temporary && canonical_path.parent() != object_path.parent())
            {
                return Err("local sync object entry escaped its canonical bucket".into());
            }
            if !temporary && retained.contains(token) {
                continue;
            }
            let modified = metadata
                .modified()
                .map_err(|_| "local sync object age could not be inspected".to_string())?;
            let Ok(age) = now.duration_since(modified) else {
                continue;
            };
            if age < older_than {
                continue;
            }
            fs::remove_file(&object_path)
                .map_err(|_| "orphan local sync object could not be removed".to_string())?;
            let count = if temporary {
                &mut counts.removed_temporary_files
            } else {
                &mut counts.removed_objects
            };
            *count = count
                .checked_add(1)
                .ok_or_else(|| "local sync object cleanup count overflowed".to_string())?;
        }
    }
    Ok(counts)
}

fn hash_file(path: &Path) -> Result<(u64, [u8; 32]), String> {
    let metadata =
        fs::metadata(path).map_err(|_| "local sync object is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_STAGED_BYTES {
        return Err("local sync object is invalid or too large".into());
    }
    let mut reader = BufReader::new(
        File::open(path).map_err(|_| "local sync object is unavailable".to_string())?,
    );
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "could not read local sync object".to_string())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "local sync object size overflow".to_string())?;
        if total > MAX_STAGED_BYTES {
            return Err("local sync object is too large".into());
        }
        digest.update(&buffer[..read]);
    }
    Ok((total, digest.finalize().into()))
}

fn validate_upload_file(
    path: &Path,
    expected_stored_sha256: &str,
    expected_size_bytes: u64,
) -> Result<(), String> {
    validate_sha256_id(expected_stored_sha256)?;
    if expected_size_bytes == 0 || expected_size_bytes > MAX_STAGED_BYTES {
        return Err("upload size is invalid".into());
    }
    let (size_bytes, digest) = hash_file(path)?;
    if size_bytes != expected_size_bytes {
        return Err("upload size does not match its immutable identity".into());
    }
    if sha256_digest_id(&digest) != expected_stored_sha256 {
        return Err("upload stored hash does not match its immutable identity".into());
    }
    Ok(())
}

/// Resolve and validate a plaintext object immediately before provider upload.
/// The returned path is confined to the native `sync-objects` root and never
/// crosses IPC.
pub(crate) fn validate_upload_ref(
    app: &AppHandle,
    source_ref: &str,
    expected_stored_sha256: &str,
    expected_size_bytes: u64,
) -> Result<PathBuf, String> {
    let path = resolve_ref(app, source_ref, true)?;
    validate_upload_file(&path, expected_stored_sha256, expected_size_bytes)?;
    Ok(path)
}

/// Resolve an opaque destination for a native provider download. The caller
/// must write to a sibling temporary file, fsync, and atomically replace this
/// path only after its expected stored hash has been verified.
pub(crate) fn resolve_download_destination_ref(
    app: &AppHandle,
    destination_ref: &str,
) -> Result<PathBuf, String> {
    resolve_ref(app, destination_ref, false)
}

fn create_protocol_stage(path: &Path) -> Result<(), String> {
    ensure_parent_directory(path)
        .map_err(|_| "could not create local sync object directory".to_string())?;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| "could not allocate local sync protocol object".to_string())?;
    file.sync_all()
        .map_err(|_| "could not durably allocate local sync protocol object".to_string())
}

fn append_protocol_chunk(path: &Path, offset: u64, bytes: &[u8]) -> Result<u64, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_PROTOCOL_CHUNK_BYTES {
        return Err("protocol chunk must contain between 1 byte and 2 MiB".into());
    }
    let current_size = fs::metadata(path)
        .map_err(|_| "local sync protocol stage is unavailable".to_string())?
        .len();
    if current_size != offset {
        return Err("local sync protocol chunk offset is not contiguous".into());
    }
    let next_size = current_size
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "local sync protocol stage size overflow".to_string())?;
    if next_size > MAX_STAGED_BYTES {
        return Err("local sync protocol object exceeds the 512 MiB limit".into());
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|_| "local sync protocol stage is unavailable".to_string())?;
    file.write_all(bytes)
        .map_err(|_| "could not append local sync protocol chunk".to_string())?;
    Ok(next_size)
}

fn finalize_protocol_stage(
    path: &Path,
    source_ref: String,
    expected_size_bytes: u64,
) -> Result<LocalObjectResult, String> {
    if expected_size_bytes > MAX_STAGED_BYTES {
        return Err("local sync protocol object exceeds the 512 MiB limit".into());
    }
    let (size_bytes, digest) = hash_file(path)?;
    if size_bytes != expected_size_bytes {
        return Err("local sync protocol stage size does not match its finalization".into());
    }
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "could not durably finalize local sync protocol object".to_string())?;
    Ok(LocalObjectResult {
        source_ref,
        size_bytes,
        stored_sha256: sha256_digest_id(&digest),
    })
}

fn read_protocol_chunk_file(
    path: &Path,
    offset: u64,
    max_bytes: u64,
) -> Result<ProtocolChunkResult, String> {
    if max_bytes == 0 || max_bytes > MAX_PROTOCOL_CHUNK_BYTES {
        return Err("protocol chunk read limit must be between 1 byte and 2 MiB".into());
    }
    let metadata =
        fs::metadata(path).map_err(|_| "local sync object is unavailable".to_string())?;
    let total_size_bytes = metadata.len();
    if !metadata.is_file() || total_size_bytes > MAX_STAGED_BYTES || offset > total_size_bytes {
        return Err("local sync protocol object or read offset is invalid".into());
    }
    let read_size = max_bytes.min(total_size_bytes.saturating_sub(offset));
    let mut bytes = Vec::with_capacity(read_size as usize);
    let mut file = File::open(path).map_err(|_| "local sync object is unavailable".to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "could not seek local sync protocol object".to_string())?;
    file.take(read_size)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read local sync protocol object".to_string())?;
    if bytes.len() as u64 != read_size
        || fs::metadata(path)
            .map_err(|_| "local sync object is unavailable".to_string())?
            .len()
            != total_size_bytes
    {
        return Err("local sync protocol object changed while it was read".into());
    }
    Ok(ProtocolChunkResult {
        offset,
        total_size_bytes,
        bytes,
    })
}

#[tauri::command]
pub(crate) async fn sync_object_allocate_protocol(
    app: AppHandle,
) -> Result<LocalObjectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (source_ref, path) = allocate_ref(&app)?;
        create_protocol_stage(&path)?;
        Ok(LocalObjectResult {
            source_ref,
            size_bytes: 0,
            stored_sha256: sha256_id(&[]),
        })
    })
    .await
    .map_err(|_| "local sync protocol allocation worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_object_append_protocol_chunk(
    app: AppHandle,
    source_ref: String,
    offset: u64,
    bytes: Vec<u8>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = Zeroizing::new(bytes);
        let path = resolve_ref(&app, &source_ref, true)?;
        append_protocol_chunk(&path, offset, &bytes)
    })
    .await
    .map_err(|_| "local sync protocol append worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_object_finalize_protocol(
    app: AppHandle,
    source_ref: String,
    expected_size_bytes: u64,
) -> Result<LocalObjectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_ref(&app, &source_ref, true)?;
        finalize_protocol_stage(&path, source_ref, expected_size_bytes)
    })
    .await
    .map_err(|_| "local sync protocol finalization worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_object_discard_local(
    app: AppHandle,
    source_ref: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_ref(&app, &source_ref, false)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("could not discard local sync object".to_string()),
        }
    })
    .await
    .map_err(|_| "local sync object discard worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_object_gc_orphans(
    app: AppHandle,
    retained_source_refs: Vec<String>,
    older_than_ms: u64,
) -> Result<SyncObjectGcResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let retained = retained_tokens(&retained_source_refs)?;
        let counts = gc_orphan_objects_at(
            &root(&app)?,
            &retained,
            Duration::from_millis(older_than_ms),
            SystemTime::now(),
        )?;
        Ok(SyncObjectGcResult {
            removed_objects: counts.removed_objects,
            removed_temporary_files: counts.removed_temporary_files,
        })
    })
    .await
    .map_err(|_| "local sync object cleanup worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_object_stage_asset_source(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    ext: String,
) -> Result<LocalObjectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = asset_store_path(&app, &project_id, &asset_id, AssetVariant::Source, &ext)?;
        let (source_ref, destination) = allocate_ref(&app)?;
        atomic_copy_capped(&source, &destination, MAX_STAGED_BYTES)
            .map_err(|_| "could not stage canonical asset source".to_string())?;
        let (size_bytes, digest) = hash_file(&destination)?;
        Ok(LocalObjectResult {
            source_ref,
            size_bytes,
            stored_sha256: sha256_digest_id(&digest),
        })
    })
    .await
    .map_err(|_| "asset staging worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_object_read_protocol_chunk(
    app: AppHandle,
    source_ref: String,
    offset: u64,
    max_bytes: u64,
) -> Result<ProtocolChunkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_ref(&app, &source_ref, true)?;
        read_protocol_chunk_file(&path, offset, max_bytes)
    })
    .await
    .map_err(|_| "sync protocol chunk read worker failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_staging_and_reads_are_chunked_contiguous_and_hash_verified() {
        let directory = tempfile::tempdir().unwrap();
        let protocol = directory.path().join("segment.cbor");
        create_protocol_stage(&protocol).unwrap();
        assert_eq!(append_protocol_chunk(&protocol, 0, &[1, 2]).unwrap(), 2);
        assert!(append_protocol_chunk(&protocol, 1, &[3]).is_err());
        assert_eq!(append_protocol_chunk(&protocol, 2, &[3, 4]).unwrap(), 4);
        assert!(append_protocol_chunk(&protocol, 4, &[]).is_err());

        let finalized = finalize_protocol_stage(&protocol, "syncobj:test".into(), 4).unwrap();
        assert_eq!(finalized.size_bytes, 4);
        assert_eq!(finalized.stored_sha256, sha256_id(&[1, 2, 3, 4]));
        assert!(finalize_protocol_stage(&protocol, "syncobj:test".into(), 3).is_err());

        let first = read_protocol_chunk_file(&protocol, 0, 3).unwrap();
        assert_eq!(first.offset, 0);
        assert_eq!(first.total_size_bytes, 4);
        assert_eq!(first.bytes, [1, 2, 3]);
        let second = read_protocol_chunk_file(&protocol, 3, 3).unwrap();
        assert_eq!(second.bytes, [4]);
        assert!(read_protocol_chunk_file(&protocol, 5, 1).is_err());
        assert!(read_protocol_chunk_file(&protocol, 0, 0).is_err());
        assert!(read_protocol_chunk_file(&protocol, 0, MAX_PROTOCOL_CHUNK_BYTES + 1).is_err());
    }

    #[test]
    fn plaintext_upload_validation_requires_exact_hash_and_size() {
        let directory = tempfile::tempdir().unwrap();
        let object = directory.path().join("object");
        fs::write(&object, b"plaintext sync object").unwrap();
        let expected = sha256_id(b"plaintext sync object");
        assert!(validate_upload_file(&object, &expected, 21).is_ok());
        assert!(validate_upload_file(&object, &expected, 20).is_err());
        assert!(validate_upload_file(&object, &format!("sha256:{}", "0".repeat(64)), 21,).is_err());
        assert!(validate_upload_file(&object, "sha512:invalid", 21).is_err());
    }

    #[test]
    fn orphan_gc_preserves_sqlite_references_and_is_restart_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let retained_token = "aa-retained-object";
        let orphan_token = "bb-crash-orphan";
        let fresh_token = "cc-fresh-in-flight";
        for token in [retained_token, orphan_token, fresh_token] {
            let path = path_for_token(root, token).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, token.as_bytes()).unwrap();
        }
        let retained = HashSet::from([retained_token.to_string()]);
        assert_eq!(
            gc_orphan_objects_at(
                root,
                &retained,
                Duration::from_secs(60 * 60),
                SystemTime::now(),
            )
            .unwrap(),
            SyncObjectGcCounts::default()
        );
        assert_eq!(
            gc_orphan_objects_at(root, &retained, Duration::ZERO, SystemTime::now()).unwrap(),
            SyncObjectGcCounts {
                removed_objects: 2,
                removed_temporary_files: 0,
            }
        );
        assert!(path_for_token(root, retained_token).unwrap().exists());
        assert!(!path_for_token(root, orphan_token).unwrap().exists());
        assert!(!path_for_token(root, fresh_token).unwrap().exists());
        assert_eq!(
            gc_orphan_objects_at(root, &retained, Duration::ZERO, SystemTime::now()).unwrap(),
            SyncObjectGcCounts::default()
        );
    }

    #[test]
    fn orphan_gc_removes_only_canonical_atomic_staging_siblings_after_the_ttl() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let token = "dd-interrupted-staging";
        let canonical = path_for_token(root, token).unwrap();
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let temporary = canonical
            .parent()
            .unwrap()
            .join(format!(".{token}.object.abc-123.part"));
        fs::write(&temporary, b"partial object").unwrap();

        assert_eq!(
            gc_orphan_objects_at(
                root,
                &HashSet::new(),
                Duration::from_secs(60 * 60),
                SystemTime::now(),
            )
            .unwrap(),
            SyncObjectGcCounts::default()
        );
        assert!(temporary.exists());

        assert_eq!(
            gc_orphan_objects_at(root, &HashSet::new(), Duration::ZERO, SystemTime::now()).unwrap(),
            SyncObjectGcCounts {
                removed_objects: 0,
                removed_temporary_files: 1,
            }
        );
        assert!(!temporary.exists());
    }

    #[test]
    fn orphan_gc_fails_closed_on_malformed_refs_and_unmanaged_entries() {
        assert!(retained_tokens(&["file:///tmp/not-opaque".into()]).is_err());

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("unexpected-file"), b"do not delete").unwrap();
        assert!(
            gc_orphan_objects_at(root, &HashSet::new(), Duration::ZERO, SystemTime::now()).is_err()
        );
        assert!(root.join("unexpected-file").exists());
    }

    #[cfg(unix)]
    #[test]
    fn orphan_gc_rejects_symlinked_buckets_without_following_them() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.object"), b"keep").unwrap();
        symlink(outside.path(), directory.path().join("aa")).unwrap();
        assert!(gc_orphan_objects_at(
            directory.path(),
            &HashSet::new(),
            Duration::ZERO,
            SystemTime::now(),
        )
        .is_err());
        assert!(outside.path().join("outside.object").exists());
    }
}
