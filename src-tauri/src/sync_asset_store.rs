//! Native-only canonical asset capture and restore for SyncEngine.
//!
//! The renderer receives root-validated `syncobj:` references plus immutable
//! metadata. It never receives asset bytes or native filesystem paths. Restore
//! attempts persist one receipt per source so activation can be replayed after
//! interruption and rolled back before the SQLite activation transaction wins.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::native_capabilities::{
    app_local_dir, asset_store_path, atomic_copy_capped, atomic_write, AssetVariant,
};

const SYNC_OBJECT_ROOT: &str = "sync-objects";
const ATTEMPT_ROOT: &str = "sync-asset-attempts";
const REF_PREFIX: &str = "syncobj:";
const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const RECEIPT_VERSION: u8 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedAssetSourceResult {
    source_ref: String,
    blob_id: String,
    source_sha256: String,
    size_bytes: u64,
    mime_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedAssetSourceResult {
    asset_id: String,
    staging_ref: String,
    source_sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetGcResult {
    removed_attempts: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ReceiptState {
    Prepared,
    Activated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetAttemptReceipt {
    version: u8,
    attempt_id: String,
    target_project_id: String,
    asset_id: String,
    blob_id: String,
    source_sha256: String,
    size_bytes: u64,
    mime_type: String,
    staging_ref: String,
    state: ReceiptState,
    updated_at_ms: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_text(value: &str) -> String {
    sha256_hex(value.as_bytes())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    let digest = value
        .strip_prefix("sha256:")
        .ok_or_else(|| "asset SHA-256 must use sha256:<lowercase hex>".to_string())?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("asset SHA-256 must use sha256:<lowercase hex>".into());
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 || value.contains('\0') {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_ref_token(token: &str) -> Result<(), String> {
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
    validate_ref_token(token)?;
    Ok(token)
}

fn object_path(root: &Path, source_ref: &str) -> Result<PathBuf, String> {
    let token = token_from_ref(source_ref)?;
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

fn resolve_object_ref(app: &AppHandle, source_ref: &str) -> Result<PathBuf, String> {
    let root = app_local_dir(app, SYNC_OBJECT_ROOT)?;
    let path = object_path(&root, source_ref)?;
    reject_symlink_chain(&root, &path)?;
    let metadata =
        fs::metadata(&path).map_err(|_| "local sync object is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        return Err("local sync object is invalid or too large".into());
    }
    Ok(path)
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "OS CSPRNG is unavailable".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn allocate_object_ref(app: &AppHandle) -> Result<(String, PathBuf), String> {
    let root = app_local_dir(app, SYNC_OBJECT_ROOT)?;
    for _ in 0..16 {
        let token = random_token()?;
        let source_ref = format!("{REF_PREFIX}{token}");
        let path = object_path(&root, &source_ref)?;
        reject_symlink_chain(&root, &path)?;
        if !path.exists() {
            return Ok((source_ref, path));
        }
    }
    Err("could not allocate a unique local sync object".into())
}

fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let metadata = fs::metadata(path).map_err(|_| "asset source is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        return Err("asset source is invalid or exceeds 512 MiB".into());
    }
    let mut reader =
        BufReader::new(File::open(path).map_err(|_| "asset source is unavailable".to_string())?);
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "could not read asset source".to_string())?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| "asset source size overflow".to_string())?;
        if size > MAX_SOURCE_BYTES {
            return Err("asset source exceeds 512 MiB".into());
        }
        digest.update(&buffer[..read]);
    }
    Ok((size, format!("sha256:{:x}", digest.finalize())))
}

fn normalized_mime(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn mime_extension(value: &str) -> Result<&'static str, String> {
    match normalized_mime(value).as_str() {
        "application/pdf" => Ok("pdf"),
        "image/jpeg" | "image/jpg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        "image/bmp" => Ok("bmp"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Ok("ico"),
        "image/tiff" => Ok("tiff"),
        "image/heic" => Ok("heic"),
        "image/heif" => Ok("heif"),
        "image/avif" => Ok("avif"),
        _ => Err("asset MIME type is unsupported".into()),
    }
}

fn detected_mime(path: &Path) -> Result<&'static str, String> {
    let mut file = File::open(path).map_err(|_| "asset source is unavailable".to_string())?;
    let mut prefix = [0_u8; 32];
    let read = file
        .read(&mut prefix)
        .map_err(|_| "could not inspect asset source".to_string())?;
    let bytes = &prefix[..read];
    if bytes.starts_with(b"%PDF-") {
        return Ok("application/pdf");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Ok("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Ok("image/bmp");
    }
    if bytes.starts_with(&[b'I', b'I', 0x2a, 0x00]) || bytes.starts_with(&[b'M', b'M', 0x00, 0x2a])
    {
        return Ok("image/tiff");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Ok("image/x-icon");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"avif" | b"avis" => Ok("image/avif"),
            b"heic" | b"heix" | b"hevc" | b"hevx" => Ok("image/heic"),
            b"mif1" | b"msf1" => Ok("image/heif"),
            _ => Err("asset MIME signature is unsupported".into()),
        };
    }
    Err("asset MIME signature is unsupported".into())
}

fn mime_matches(expected: &str, detected: &str) -> bool {
    let expected = normalized_mime(expected);
    expected == detected
        || (matches!(expected.as_str(), "image/jpg" | "image/jpeg") && detected == "image/jpeg")
        || (matches!(
            expected.as_str(),
            "image/x-icon" | "image/vnd.microsoft.icon"
        ) && detected == "image/x-icon")
}

fn verify_source(
    path: &Path,
    expected_sha256: &str,
    expected_size_bytes: u64,
    expected_mime: &str,
) -> Result<(), String> {
    validate_sha256(expected_sha256)?;
    let (size, sha256) = hash_file(path)?;
    if size != expected_size_bytes || sha256 != expected_sha256 {
        return Err("asset source hash or size does not match immutable metadata".into());
    }
    let detected = detected_mime(path)?;
    if !mime_matches(expected_mime, detected) {
        return Err("asset source MIME signature does not match immutable metadata".into());
    }
    Ok(())
}

fn promote_verified_source(
    source: &Path,
    destination: &Path,
    receipt: &AssetAttemptReceipt,
) -> Result<(), String> {
    verify_source(
        source,
        &receipt.source_sha256,
        receipt.size_bytes,
        &receipt.mime_type,
    )?;
    if verify_source(
        destination,
        &receipt.source_sha256,
        receipt.size_bytes,
        &receipt.mime_type,
    )
    .is_err()
    {
        atomic_copy_capped(source, destination, MAX_SOURCE_BYTES)
            .map_err(|_| "could not activate verified asset source".to_string())?;
        verify_source(
            destination,
            &receipt.source_sha256,
            receipt.size_bytes,
            &receipt.mime_type,
        )?;
    }
    Ok(())
}

fn attempt_directory(app: &AppHandle, attempt_id: &str) -> Result<PathBuf, String> {
    validate_identity(attempt_id, "asset restore attempt identity")?;
    Ok(app_local_dir(app, ATTEMPT_ROOT)?.join(sha256_text(attempt_id)))
}

fn receipt_path(app: &AppHandle, attempt_id: &str, staging_ref: &str) -> Result<PathBuf, String> {
    token_from_ref(staging_ref)?;
    Ok(attempt_directory(app, attempt_id)?.join(format!("{}.json", sha256_text(staging_ref))))
}

fn write_receipt(path: &Path, receipt: &AssetAttemptReceipt) -> Result<(), String> {
    let bytes = serde_json::to_vec(receipt)
        .map_err(|_| "could not encode asset restore receipt".to_string())?;
    atomic_write(path, &bytes).map_err(|_| "could not persist asset restore receipt".to_string())
}

fn read_receipt(path: &Path) -> Result<AssetAttemptReceipt, String> {
    let bytes = fs::read(path).map_err(|_| "asset restore receipt is unavailable".to_string())?;
    let receipt: AssetAttemptReceipt = serde_json::from_slice(&bytes)
        .map_err(|_| "asset restore receipt is corrupt".to_string())?;
    if receipt.version != RECEIPT_VERSION {
        return Err("asset restore receipt version is unsupported".into());
    }
    Ok(receipt)
}

fn list_receipts(directory: &Path) -> Result<Vec<(PathBuf, AssetAttemptReceipt)>, String> {
    let mut receipts = Vec::new();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(receipts),
        Err(_) => return Err("asset restore attempt directory is unavailable".into()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "asset restore attempt directory is corrupt".to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        receipts.push((path.clone(), read_receipt(&path)?));
    }
    receipts.sort_by(|left, right| left.1.staging_ref.cmp(&right.1.staging_ref));
    Ok(receipts)
}

fn remove_object_ref(app: &AppHandle, source_ref: &str) {
    let root = match app_local_dir(app, SYNC_OBJECT_ROOT) {
        Ok(root) => root,
        Err(_) => return,
    };
    if let Ok(path) = object_path(&root, source_ref) {
        let _ = fs::remove_file(path);
    }
}

fn remove_attempt_directory(app: &AppHandle, attempt_id: &str) -> Result<(), String> {
    let directory = attempt_directory(app, attempt_id)?;
    match fs::remove_dir_all(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("could not remove asset restore attempt".into()),
    }
}

fn abandon_receipt(app: &AppHandle, receipt: &AssetAttemptReceipt) -> Result<(), String> {
    if receipt.state == ReceiptState::Activated {
        let extension = mime_extension(&receipt.mime_type)?;
        let destination = asset_store_path(
            app,
            &receipt.target_project_id,
            &receipt.asset_id,
            AssetVariant::Source,
            extension,
        )?;
        if verify_source(
            &destination,
            &receipt.source_sha256,
            receipt.size_bytes,
            &receipt.mime_type,
        )
        .is_ok()
        {
            let _ = fs::remove_file(destination);
        }
    }
    remove_object_ref(app, &receipt.staging_ref);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn capture_source(
    app: &AppHandle,
    project_id: &str,
    asset_id: &str,
    expected_source_sha256: &str,
    expected_size_bytes: u64,
    expected_mime_type: &str,
) -> Result<VerifiedAssetSourceResult, String> {
    validate_identity(project_id, "project identity")?;
    validate_identity(asset_id, "asset identity")?;
    let extension = mime_extension(expected_mime_type)?;
    let source = asset_store_path(app, project_id, asset_id, AssetVariant::Source, extension)?;
    verify_source(
        &source,
        expected_source_sha256,
        expected_size_bytes,
        expected_mime_type,
    )?;
    let (source_ref, destination) = allocate_object_ref(app)?;
    atomic_copy_capped(&source, &destination, MAX_SOURCE_BYTES)
        .map_err(|_| "could not stage canonical asset source".to_string())?;
    verify_source(
        &destination,
        expected_source_sha256,
        expected_size_bytes,
        expected_mime_type,
    )?;
    Ok(VerifiedAssetSourceResult {
        source_ref,
        blob_id: expected_source_sha256.to_string(),
        source_sha256: expected_source_sha256.to_string(),
        size_bytes: expected_size_bytes,
        mime_type: normalized_mime(expected_mime_type),
    })
}

#[tauri::command]
pub(crate) async fn sync_asset_capture_source(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    expected_source_sha256: String,
    expected_size_bytes: u64,
    expected_mime_type: String,
) -> Result<VerifiedAssetSourceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        capture_source(
            &app,
            &project_id,
            &asset_id,
            &expected_source_sha256,
            expected_size_bytes,
            &expected_mime_type,
        )
    })
    .await
    .map_err(|_| "asset capture worker failed".to_string())?
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn sync_asset_prepare_restore_source(
    app: AppHandle,
    attempt_id: String,
    target_project_id: String,
    asset_id: String,
    blob_id: String,
    source_ref: String,
    expected_source_sha256: String,
    expected_size_bytes: u64,
    expected_mime_type: String,
) -> Result<PreparedAssetSourceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_identity(&attempt_id, "asset restore attempt identity")?;
        validate_identity(&target_project_id, "project identity")?;
        validate_identity(&asset_id, "asset identity")?;
        validate_sha256(&blob_id)?;
        if blob_id != expected_source_sha256 {
            return Err("protocol v1 asset blob ID must equal its source SHA-256".into());
        }
        mime_extension(&expected_mime_type)?;
        let source = resolve_object_ref(&app, &source_ref)?;
        verify_source(
            &source,
            &expected_source_sha256,
            expected_size_bytes,
            &expected_mime_type,
        )?;
        let (staging_ref, staging_path) = allocate_object_ref(&app)?;
        atomic_copy_capped(&source, &staging_path, MAX_SOURCE_BYTES)
            .map_err(|_| "could not stage verified restore source".to_string())?;
        verify_source(
            &staging_path,
            &expected_source_sha256,
            expected_size_bytes,
            &expected_mime_type,
        )?;
        let receipt = AssetAttemptReceipt {
            version: RECEIPT_VERSION,
            attempt_id: attempt_id.clone(),
            target_project_id,
            asset_id: asset_id.clone(),
            blob_id,
            source_sha256: expected_source_sha256.clone(),
            size_bytes: expected_size_bytes,
            mime_type: normalized_mime(&expected_mime_type),
            staging_ref: staging_ref.clone(),
            state: ReceiptState::Prepared,
            updated_at_ms: now_ms(),
        };
        write_receipt(&receipt_path(&app, &attempt_id, &staging_ref)?, &receipt)?;
        Ok(PreparedAssetSourceResult {
            asset_id,
            staging_ref,
            source_sha256: expected_source_sha256,
            size_bytes: expected_size_bytes,
        })
    })
    .await
    .map_err(|_| "asset restore staging worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_asset_activate_restore_sources(
    app: AppHandle,
    attempt_id: String,
    target_project_id: String,
    staging_refs: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_identity(&attempt_id, "asset restore attempt identity")?;
        validate_identity(&target_project_id, "project identity")?;
        if staging_refs.is_empty() {
            return Ok(format!("syncasset-activation:{}", sha256_text(&attempt_id)));
        }
        let unique: HashSet<&str> = staging_refs.iter().map(String::as_str).collect();
        if unique.len() != staging_refs.len() {
            return Err("asset restore staging references contain duplicates".into());
        }
        let mut ordered = staging_refs.clone();
        ordered.sort();
        for staging_ref in &ordered {
            let receipt_file = receipt_path(&app, &attempt_id, staging_ref)?;
            let mut receipt = read_receipt(&receipt_file)?;
            if receipt.attempt_id != attempt_id
                || receipt.target_project_id != target_project_id
                || receipt.staging_ref != *staging_ref
            {
                return Err("asset restore receipt identity mismatch".into());
            }
            let source = resolve_object_ref(&app, staging_ref)?;
            let extension = mime_extension(&receipt.mime_type)?;
            let destination = asset_store_path(
                &app,
                &target_project_id,
                &receipt.asset_id,
                AssetVariant::Source,
                extension,
            )?;
            promote_verified_source(&source, &destination, &receipt)?;
            receipt.state = ReceiptState::Activated;
            receipt.updated_at_ms = now_ms();
            write_receipt(&receipt_file, &receipt)?;
        }
        Ok(format!(
            "syncasset-activation:{}",
            sha256_text(&format!("{}\0{}", attempt_id, ordered.join("\0")))
        ))
    })
    .await
    .map_err(|_| "asset restore activation worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_asset_abandon_restore_attempt(
    app: AppHandle,
    attempt_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = attempt_directory(&app, &attempt_id)?;
        for (_, receipt) in list_receipts(&directory)? {
            if receipt.attempt_id != attempt_id {
                return Err("asset restore receipt attempt mismatch".into());
            }
            abandon_receipt(&app, &receipt)?;
        }
        remove_attempt_directory(&app, &attempt_id)
    })
    .await
    .map_err(|_| "asset restore abandon worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_asset_finalize_restore_attempt(
    app: AppHandle,
    attempt_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = attempt_directory(&app, &attempt_id)?;
        for (_, receipt) in list_receipts(&directory)? {
            if receipt.attempt_id != attempt_id || receipt.state != ReceiptState::Activated {
                return Err(
                    "asset restore attempt cannot finalize before every source activates".into(),
                );
            }
            remove_object_ref(&app, &receipt.staging_ref);
        }
        remove_attempt_directory(&app, &attempt_id)
    })
    .await
    .map_err(|_| "asset restore finalize worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_asset_gc_restore_attempts(
    app: AppHandle,
    retained_attempt_ids: Vec<String>,
    older_than_ms: u64,
) -> Result<AssetGcResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let retained: HashSet<String> = retained_attempt_ids.into_iter().collect();
        let root = app_local_dir(&app, ATTEMPT_ROOT)?;
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(AssetGcResult {
                    removed_attempts: 0,
                })
            }
            Err(_) => return Err("asset restore attempt root is unavailable".into()),
        };
        let cutoff = now_ms().saturating_sub(older_than_ms as u128);
        let mut removed = 0_u64;
        for entry in entries {
            let entry = entry.map_err(|_| "asset restore attempt root is corrupt".to_string())?;
            if !entry
                .file_type()
                .map_err(|_| "asset restore attempt root is corrupt".to_string())?
                .is_dir()
            {
                continue;
            }
            let receipts = list_receipts(&entry.path())?;
            let Some((_, first)) = receipts.first() else {
                continue;
            };
            if retained.contains(&first.attempt_id)
                || receipts
                    .iter()
                    .any(|(_, receipt)| receipt.updated_at_ms > cutoff)
            {
                continue;
            }
            for (_, receipt) in receipts {
                abandon_receipt(&app, &receipt)?;
            }
            fs::remove_dir_all(entry.path())
                .map_err(|_| "could not collect stale asset restore attempt".to_string())?;
            removed += 1;
        }
        Ok(AssetGcResult {
            removed_attempts: removed,
        })
    })
    .await
    .map_err(|_| "asset restore GC worker failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader as LineReader, Write};
    use std::process::{Command, Stdio};
    use tempfile::tempdir;

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn verifies_pdf_hash_size_and_mime_without_loading_the_file() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        let bytes = b"%PDF-1.7\nverified source\n%%EOF";
        write(&source, bytes);
        let sha = format!("sha256:{}", sha256_hex(bytes));
        verify_source(&source, &sha, bytes.len() as u64, "application/pdf").unwrap();
        assert!(verify_source(&source, &sha, bytes.len() as u64, "image/png").is_err());
        assert!(verify_source(
            &source,
            &format!("sha256:{}", "0".repeat(64)),
            bytes.len() as u64,
            "application/pdf"
        )
        .is_err());
    }

    #[test]
    fn recognizes_image_signatures_and_rejects_extension_only_spoofing() {
        let directory = tempdir().unwrap();
        let png = directory.path().join("source.png");
        write(
            &png,
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3],
        );
        assert_eq!(detected_mime(&png).unwrap(), "image/png");
        assert!(mime_matches("image/png", detected_mime(&png).unwrap()));
        assert!(!mime_matches(
            "application/pdf",
            detected_mime(&png).unwrap()
        ));
    }

    #[test]
    fn receipt_roundtrip_preserves_replay_authority() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("receipt.json");
        let receipt = AssetAttemptReceipt {
            version: RECEIPT_VERSION,
            attempt_id: "attempt-1".into(),
            target_project_id: "project-1".into(),
            asset_id: "asset-1".into(),
            blob_id: format!("sha256:{}", "a".repeat(64)),
            source_sha256: format!("sha256:{}", "a".repeat(64)),
            size_bytes: 42,
            mime_type: "application/pdf".into(),
            staging_ref: "syncobj:stage-1".into(),
            state: ReceiptState::Activated,
            updated_at_ms: 1,
        };
        write_receipt(&path, &receipt).unwrap();
        let decoded = read_receipt(&path).unwrap();
        assert_eq!(decoded.attempt_id, receipt.attempt_id);
        assert_eq!(decoded.state, ReceiptState::Activated);
        assert_eq!(decoded.source_sha256, receipt.source_sha256);
    }

    #[test]
    fn local_object_refs_are_root_confined_and_reject_paths() {
        let root = Path::new("/managed/sync-objects");
        assert_eq!(
            object_path(root, "syncobj:ab-safe").unwrap(),
            root.join("ab/ab-safe.object")
        );
        assert!(object_path(root, "file:///tmp/asset").is_err());
        assert!(object_path(root, "syncobj:../../asset").is_err());
    }

    fn pdf_receipt(source: &[u8], asset_id: &str) -> AssetAttemptReceipt {
        AssetAttemptReceipt {
            version: RECEIPT_VERSION,
            attempt_id: "sigkill-attempt".into(),
            target_project_id: "sigkill-project".into(),
            asset_id: asset_id.into(),
            blob_id: format!("sha256:{}", sha256_hex(source)),
            source_sha256: format!("sha256:{}", sha256_hex(source)),
            size_bytes: source.len() as u64,
            mime_type: "application/pdf".into(),
            staging_ref: format!("syncobj:stage-{asset_id}"),
            state: ReceiptState::Prepared,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn asset_activation_sigkill_worker() {
        let Ok(source) = std::env::var("DRIFTING_SYNC_ASSET_SIGKILL_SOURCE") else {
            return;
        };
        let destination = std::env::var("DRIFTING_SYNC_ASSET_SIGKILL_DESTINATION").unwrap();
        let receipt_path = std::env::var("DRIFTING_SYNC_ASSET_SIGKILL_RECEIPT").unwrap();
        let receipt = read_receipt(Path::new(&receipt_path)).unwrap();
        promote_verified_source(Path::new(&source), Path::new(&destination), &receipt).unwrap();
        println!("SYNC_ASSET_PROMOTED");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }

    #[cfg(unix)]
    #[test]
    fn sigkill_after_one_promote_replays_without_partial_or_corrupt_sources() {
        use std::os::unix::process::ExitStatusExt;

        let directory = tempdir().unwrap();
        let source_one = directory.path().join("stage-one.object");
        let source_two = directory.path().join("stage-two.object");
        let destination_one = directory.path().join("assets/one/source.pdf");
        let destination_two = directory.path().join("assets/two/source.pdf");
        let receipt_path = directory.path().join("receipt-one.json");
        let bytes_one = b"%PDF-1.7\nfirst crash-safe source\n%%EOF";
        let bytes_two = b"%PDF-1.7\nsecond crash-safe source\n%%EOF";
        write(&source_one, bytes_one);
        write(&source_two, bytes_two);
        let receipt_one = pdf_receipt(bytes_one, "asset-one");
        let receipt_two = pdf_receipt(bytes_two, "asset-two");
        write_receipt(&receipt_path, &receipt_one).unwrap();

        let current = std::env::current_exe().unwrap();
        let mut child = Command::new(current)
            .args([
                "--exact",
                "sync_asset_store::tests::asset_activation_sigkill_worker",
                "--nocapture",
            ])
            .env("DRIFTING_SYNC_ASSET_SIGKILL_SOURCE", &source_one)
            .env("DRIFTING_SYNC_ASSET_SIGKILL_DESTINATION", &destination_one)
            .env("DRIFTING_SYNC_ASSET_SIGKILL_RECEIPT", &receipt_path)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = LineReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert!(output.read_line(&mut line).unwrap() > 0);
            if line.contains("SYNC_ASSET_PROMOTED") {
                break;
            }
        }
        child.kill().unwrap();
        let status = child.wait().unwrap();
        assert_eq!(status.signal(), Some(9));

        verify_source(
            &destination_one,
            &receipt_one.source_sha256,
            receipt_one.size_bytes,
            &receipt_one.mime_type,
        )
        .unwrap();
        assert!(!destination_two.exists());

        promote_verified_source(&source_one, &destination_one, &receipt_one).unwrap();
        promote_verified_source(&source_two, &destination_two, &receipt_two).unwrap();
        verify_source(
            &destination_two,
            &receipt_two.source_sha256,
            receipt_two.size_bytes,
            &receipt_two.mime_type,
        )
        .unwrap();
        let partials = fs::read_dir(destination_two.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(partials, 0);
    }
}
