//! Cross-platform native capabilities used by the renderer platform contract.
//!
//! Integration dependencies (kept here so `Cargo.toml` can be updated in one pass):
//!
//! - `tauri-plugin-dialog = "2.7"`
//! - `tauri-plugin-fs = "2.5"` (required to read Android `content://` picker results)
//! - `tauri-plugin-opener = "2.5"`
//! - `image = { version = "=0.25.4", default-features = false, features =
//!   ["bmp", "gif", "ico", "jpeg", "png", "tiff", "webp"] }`
//! - `base64 = "0.22"`
//! - `regex = "1"`
//! - `reqwest = { version = "0.12", default-features = false, features =
//!   ["charset", "http2", "rustls-tls"] }`
//!
//! `tauri_plugin_dialog::init()` and `tauri_plugin_fs::init()` must be registered before
//! `material_pick_file` is invoked. Secure storage lives in `secure_storage.rs`; keeping it
//! separate prevents image/material changes from changing credential-handling code.
//!
//! PDF thumbnails keep using the renderer `pdf.js` path. Image inspection and derivatives are
//! centralized in `image_pipeline`; HEIC/HEIF/AVIF are routed to an operating-system codec where
//! one exists instead of bundling a second native codec stack into every target.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::redirect::Policy;
use reqwest::{Client, ClientBuilder, Url};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, FilePath, PickerMode};
use tauri_plugin_fs::{FsExt, OpenOptions as PluginOpenOptions};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::image_pipeline;

// Material creation currently needs one bounded in-memory read for image/PDF
// inspection and thumbnail generation. Keep the picker/import ceiling identical
// to that read ceiling so a file can never be accepted and then fail solely
// because a later mandatory material step has a lower limit.
const MATERIAL_FILE_LIMIT: u64 = 64 * 1024 * 1024;
const ASSET_TRANSFER_LIMIT: u64 = 512 * 1024 * 1024;
const MATERIAL_FILE_TOO_LARGE_CODE: &str = "MATERIAL_FILE_TOO_LARGE";
const MATERIAL_IMPORT_FAILED_CODE: &str = "MATERIAL_IMPORT_FAILED";
const MATERIAL_FILE_TOO_LARGE_ERROR: &str =
    "Selected file is larger than the 64 MiB material limit";
const AI_LOG_LIMIT: usize = 4 * 1024 * 1024;
const URL_LIMIT: usize = 4096;
const URL_META_BODY_LIMIT: usize = 256 * 1024;
const HTTP_HEADER_TOTAL_LIMIT: usize = 32 * 1024;
const HTTP_HEADER_VALUE_LIMIT: usize = 8 * 1024;
const MAX_REDIRECTS: usize = 5;
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const URL_METADATA_TOTAL_TIMEOUT: Duration = Duration::from_secs(8);
const ASSET_TRANSFER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CACHE_SEGMENT_LEN: usize = 128;
const MAX_EXTENSION_LEN: usize = 16;

static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
pub struct FailureResult {
    ok: bool,
    error: String,
}

impl FailureResult {
    fn new(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: error.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct OpenSuccess {
    ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum OpenResult {
    Success(OpenSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFileSuccess {
    ok: bool,
    file_path: String,
    size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct PickFileCanceled {
    ok: bool,
    canceled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFileFailure {
    ok: bool,
    canceled: bool,
    code: &'static str,
    error: String,
    max_size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum PickFileResult {
    Success(PickFileSuccess),
    Canceled(PickFileCanceled),
    Failure(PickFileFailure),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailSuccess {
    ok: bool,
    data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ThumbnailResult {
    Success(ThumbnailSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
pub struct ReadBytesSuccess {
    ok: bool,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ReadBytesResult {
    Success(ReadBytesSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectImageSuccess {
    ok: bool,
    mime: String,
    size_bytes: u64,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum InspectImageResult {
    Success(InspectImageSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageVariantSuccess {
    ok: bool,
    bytes: Vec<u8>,
    mime: String,
    size_bytes: u64,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ImageVariantResult {
    Success(ImageVariantSuccess),
    Failure(FailureResult),
}

impl From<image_pipeline::ImageVariant> for ImageVariantSuccess {
    fn from(variant: image_pipeline::ImageVariant) -> Self {
        Self {
            ok: true,
            size_bytes: variant.size_bytes(),
            bytes: variant.bytes,
            mime: variant.mime,
            width: variant.width,
            height: variant.height,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedImageSource {
    mime: String,
    size_bytes: u64,
    width: u32,
    height: u32,
}

impl From<image_pipeline::ImageInspection> for PreparedImageSource {
    fn from(source: image_pipeline::ImageInspection) -> Self {
        Self {
            mime: source.mime,
            size_bytes: source.size_bytes,
            width: source.width,
            height: source.height,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct PrepareImageSuccess {
    ok: bool,
    source: PreparedImageSource,
    display: ImageVariantSuccess,
    thumbnail: ImageVariantSuccess,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareImageFailure {
    ok: bool,
    code: &'static str,
    codec: Option<&'static str>,
    error: String,
}

impl From<image_pipeline::ImagePipelineError> for PrepareImageFailure {
    fn from(error: image_pipeline::ImagePipelineError) -> Self {
        Self {
            ok: false,
            code: error.code,
            codec: error.codec.map(image_pipeline::SystemImageCodec::extension),
            error: error.message,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum PrepareImageResult {
    Success(PrepareImageSuccess),
    Failure(PrepareImageFailure),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlMetadataSuccess {
    ok: bool,
    title: Option<String>,
    og_image: Option<String>,
    favicon: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum UrlMetadataResult {
    Success(UrlMetadataSuccess),
    Failure(FailureResult),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssetVariant {
    Source,
    Display,
    Thumbnail,
}

impl AssetVariant {
    fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Display => "display",
            Self::Thumbnail => "thumbnail",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCachePathSuccess {
    ok: bool,
    file_path: String,
    file_url: String,
    exists: bool,
    size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AssetCachePathResult {
    Success(AssetCachePathSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCacheWriteSuccess {
    ok: bool,
    file_path: String,
    file_url: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AssetCacheWriteResult {
    Success(AssetCacheWriteSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCacheUploadSuccess {
    ok: bool,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AssetCacheUploadResult {
    Success(AssetCacheUploadSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
pub struct AssetCacheDeleteSuccess {
    ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AssetCacheDeleteResult {
    Success(AssetCacheDeleteSuccess),
    Failure(FailureResult),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLogWriteSuccess {
    ok: bool,
    file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AiLogWriteResult {
    Success(AiLogWriteSuccess),
    Failure(FailureResult),
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilePickerKind {
    Image,
    Pdf,
    Any,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn file_url(path: &Path) -> Result<String, String> {
    tauri::Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "could not convert local cache path to a file URL".to_string())
}

fn app_local_dir(app: &AppHandle, child: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "application data directory is unavailable".to_string())?;
    Ok(root.join(child))
}

fn unique_token() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}", elapsed.as_nanos(), counter)
}

fn is_single_normal_component(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn safe_cache_segment(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_CACHE_SEGMENT_LEN {
        return Err("invalid asset cache identifier".into());
    }

    let mut safe = String::with_capacity(trimmed.len());
    for character in trimmed.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            safe.push(character);
        } else {
            safe.push('_');
        }
    }

    if safe == "." || safe == ".." || !is_single_normal_component(&safe) {
        return Err("invalid asset cache identifier".into());
    }
    if safe.starts_with('.') {
        safe.insert(0, '_');
    }
    Ok(safe)
}

fn safe_cache_extension(value: &str) -> Result<String, String> {
    let normalized = value.trim().trim_start_matches('.').to_ascii_lowercase();
    if normalized.is_empty() || normalized.len() > MAX_EXTENSION_LEN {
        return Err("invalid asset cache extension".into());
    }
    if !normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("invalid asset cache extension".into());
    }
    Ok(normalized)
}

fn asset_cache_path_from_root(
    root: &Path,
    project_id: &str,
    asset_id: &str,
    variant: AssetVariant,
    ext: &str,
) -> Result<PathBuf, String> {
    let project = safe_cache_segment(project_id)?;
    let asset = safe_cache_segment(asset_id)?;
    let extension = safe_cache_extension(ext)?;
    Ok(root
        .join(project)
        .join(asset)
        .join(format!("{}.{}", variant.as_str(), extension)))
}

fn asset_cache_path(
    app: &AppHandle,
    project_id: &str,
    asset_id: &str,
    variant: AssetVariant,
    ext: &str,
) -> Result<PathBuf, String> {
    let root = app_local_dir(app, "asset-cache")?;
    let path = asset_cache_path_from_root(&root, project_id, asset_id, variant, ext)?;
    reject_symlinked_cache_path(&root, project_id, asset_id, Some(&path))?;
    Ok(path)
}

fn asset_cache_asset_dir(
    app: &AppHandle,
    project_id: &str,
    asset_id: &str,
) -> Result<PathBuf, String> {
    let project = safe_cache_segment(project_id)?;
    let asset = safe_cache_segment(asset_id)?;
    let root = app_local_dir(app, "asset-cache")?;
    let directory = root.join(project).join(asset);
    reject_symlinked_cache_path(&root, project_id, asset_id, None)?;
    Ok(directory)
}

fn reject_symlinked_cache_path(
    root: &Path,
    project_id: &str,
    asset_id: &str,
    file: Option<&Path>,
) -> Result<(), String> {
    let project = safe_cache_segment(project_id)?;
    let asset = safe_cache_segment(asset_id)?;
    for candidate in [
        root.to_path_buf(),
        root.join(&project),
        root.join(&project).join(&asset),
    ] {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("refusing to access a symlinked asset cache path".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(_) => return Err("could not validate asset cache path".into()),
        }
    }
    if let Some(file) = file {
        match fs::symlink_metadata(file) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("refusing to access a symlinked asset cache file".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("could not validate asset cache file".into()),
        }
    }
    Ok(())
}

fn ensure_parent_directory(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    if fs::symlink_metadata(parent)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to write through a symlinked directory",
        ));
    }
    Ok(())
}

fn temporary_sibling(path: &Path) -> io::Result<PathBuf> {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid target filename"))?;
    Ok(path.with_file_name(format!(".{filename}.{}.part", unique_token())))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    ensure_parent_directory(path)?;
    let temporary = temporary_sibling(path)?;
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);

        match fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists || cfg!(windows) => {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(remove_error) if remove_error.kind() == io::ErrorKind::NotFound => {}
                    Err(remove_error) => return Err(remove_error),
                }
                fs::rename(&temporary, path)
            }
            Err(error) => Err(error),
        }
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn atomic_copy_capped(source: &Path, path: &Path, limit: u64) -> io::Result<u64> {
    let metadata = fs::metadata(source)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "source path is not a file",
        ));
    }
    if metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "source file exceeds size limit",
        ));
    }

    ensure_parent_directory(path)?;
    let temporary = temporary_sibling(path)?;
    let copy_result = (|| {
        let mut source = File::open(source)?.take(limit.saturating_add(1));
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let copied = io::copy(&mut source, &mut target)?;
        if copied > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source file exceeds size limit",
            ));
        }
        target.sync_all()?;
        drop(target);

        match fs::rename(&temporary, path) {
            Ok(()) => Ok(copied),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists || cfg!(windows) => {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(remove_error) if remove_error.kind() == io::ErrorKind::NotFound => {}
                    Err(remove_error) => return Err(remove_error),
                }
                fs::rename(&temporary, path)?;
                Ok(copied)
            }
            Err(error) => Err(error),
        }
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copy_result
}

async fn download_response_atomically(
    mut response: reqwest::Response,
    path: &Path,
    limit: u64,
) -> io::Result<u64> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "response body exceeds size limit",
        ));
    }

    ensure_parent_directory(path)?;
    let temporary = temporary_sibling(path)?;
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        let mut written = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| io::Error::other(error.to_string()))?
        {
            written = written.saturating_add(chunk.len() as u64);
            if written > limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "response body exceeds size limit",
                ));
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        drop(file);

        match tokio::fs::rename(&temporary, path).await {
            Ok(()) => Ok(written),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists || cfg!(windows) => {
                match tokio::fs::remove_file(path).await {
                    Ok(()) => {}
                    Err(remove_error) if remove_error.kind() == io::ErrorKind::NotFound => {}
                    Err(remove_error) => return Err(remove_error),
                }
                tokio::fs::rename(&temporary, path).await?;
                Ok(written)
            }
            Err(error) => Err(error),
        }
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

fn read_file_capped_with_limit(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not a file",
        ));
    }
    if metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds size limit",
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len().min(limit) as usize);
    File::open(path)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds size limit",
        ));
    }
    Ok(bytes)
}

fn read_file_capped(path: &Path) -> io::Result<Vec<u8>> {
    read_file_capped_with_limit(path, MATERIAL_FILE_LIMIT)
}

fn validate_material_import_size(size_bytes: u64) -> Result<(), String> {
    if size_bytes > MATERIAL_FILE_LIMIT {
        Err(MATERIAL_FILE_TOO_LARGE_ERROR.into())
    } else {
        Ok(())
    }
}

fn material_import_failure(error: String) -> PickFileFailure {
    let too_large = error == MATERIAL_FILE_TOO_LARGE_ERROR;
    PickFileFailure {
        ok: false,
        canceled: false,
        code: if too_large {
            MATERIAL_FILE_TOO_LARGE_CODE
        } else {
            MATERIAL_IMPORT_FAILED_CODE
        },
        error,
        max_size_bytes: too_large.then_some(MATERIAL_FILE_LIMIT),
    }
}

fn safe_import_stem(selected: &FilePath) -> String {
    let candidate = match selected {
        FilePath::Path(path) => path.file_stem().and_then(|value| value.to_str()),
        FilePath::Url(url) => url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .and_then(|value| Path::new(value).file_stem())
            .and_then(|value| value.to_str()),
    }
    .unwrap_or("import");

    let mut safe = String::new();
    for character in candidate.chars().take(80) {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            safe.push(character);
        } else {
            safe.push('_');
        }
    }
    if safe.is_empty() {
        "import".into()
    } else {
        safe
    }
}

fn selected_extension(selected: &FilePath) -> Option<String> {
    let extension = match selected {
        FilePath::Path(path) => path.extension().and_then(|value| value.to_str()),
        FilePath::Url(url) => url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .and_then(|value| Path::new(value).extension())
            .and_then(|value| value.to_str()),
    }?;
    safe_cache_extension(extension).ok()
}

fn sniff_extension(bytes: &[u8]) -> &'static str {
    image_pipeline::sniff_extension(bytes)
}

fn is_pdf_file(path: &Path) -> bool {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return true;
    }
    let mut signature = [0_u8; 5];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .is_ok()
        && &signature == b"%PDF-"
}

fn copy_picker_file(app: &AppHandle, selected: FilePath) -> Result<(PathBuf, u64), String> {
    let mut temporary_to_cleanup: Option<PathBuf> = None;
    let copy_result = (|| {
        let mut source_options = PluginOpenOptions::new();
        source_options.read(true);
        let source = app
            .fs()
            .open(selected.clone(), source_options)
            .map_err(|_| "could not read the selected file".to_string())?;

        // For ordinary files this rejects oversized input before creating any
        // app-owned copy. Some Android content providers expose an unknown
        // descriptor length (zero); the bounded copy below remains the final
        // race/unknown-length guard for those providers.
        let metadata = source
            .metadata()
            .map_err(|_| "could not inspect the selected file".to_string())?;
        validate_material_import_size(metadata.len())?;

        let imports = app_local_dir(app, "imports")?;
        fs::create_dir_all(&imports)
            .map_err(|_| "could not create the imports directory".to_string())?;
        if fs::symlink_metadata(&imports)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("refusing to import through a symlinked directory".into());
        }

        let token = unique_token();
        let temporary = imports.join(format!(".{token}.part"));
        temporary_to_cleanup = Some(temporary.clone());
        let stem = safe_import_stem(&selected);
        let mut source = BufReader::new(source).take(MATERIAL_FILE_LIMIT.saturating_add(1));
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "could not create the imported file".to_string())?;
        let copied = io::copy(&mut source, &mut target)
            .map_err(|_| "could not copy the selected file".to_string())?;
        target
            .sync_all()
            .map_err(|_| "could not finalize the imported file".to_string())?;
        drop(target);

        if copied > MATERIAL_FILE_LIMIT {
            return Err(MATERIAL_FILE_TOO_LARGE_ERROR.into());
        }

        let mut signature = [0_u8; 512];
        let signature_length = File::open(&temporary)
            .and_then(|mut file| file.read(&mut signature))
            .unwrap_or(0);
        let sniffed_extension = sniff_extension(&signature[..signature_length]);
        let extension = if sniffed_extension == "bin" {
            selected_extension(&selected).unwrap_or_else(|| "bin".into())
        } else {
            sniffed_extension.to_string()
        };
        let destination = imports.join(format!("{token}-{stem}.{extension}"));
        fs::rename(&temporary, &destination)
            .map_err(|_| "could not finalize the imported file".to_string())?;
        temporary_to_cleanup = None;
        Ok((destination, copied))
    })();

    #[cfg(target_os = "ios")]
    {
        // Picker URLs on iOS may be security scoped. The file is app-local now, so release it.
        if matches!(selected, FilePath::Url(_)) {
            let _ = app
                .fs()
                .stop_accessing_security_scoped_resource(selected.clone());
        }
    }

    if copy_result.is_err() {
        if let Some(temporary) = temporary_to_cleanup {
            let _ = fs::remove_file(temporary);
        }
    }
    copy_result
}

fn bounded_u32(value: f64, minimum: u32, maximum: u32, fallback: u32) -> u32 {
    let value = if value.is_finite() {
        value.round()
    } else {
        fallback as f64
    };
    value.clamp(minimum as f64, maximum as f64) as u32
}

fn parse_http_url(value: &str) -> Result<Url, String> {
    if value.is_empty() || value.len() > URL_LIMIT {
        return Err("invalid URL".into());
    }
    let parsed = Url::parse(value).map_err(|_| "invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("only credential-free http(s) URLs are allowed".into());
    }
    Ok(parsed)
}

fn http_client_builder() -> ClientBuilder {
    Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else {
                let url = attempt.url();
                if matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                {
                    attempt.follow()
                } else {
                    attempt.error("redirected to an unsupported URL")
                }
            }
        }))
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
             AppleWebKit/605.1.15 (KHTML, like Gecko) Drifting/1.0",
        )
}

fn url_metadata_http_client() -> Result<Client, String> {
    http_client_builder()
        .timeout(URL_METADATA_TOTAL_TIMEOUT)
        .build()
        .map_err(|_| "could not initialize HTTP client".to_string())
}

fn asset_transfer_http_client() -> Result<Client, String> {
    // Large assets may legitimately take minutes on mobile networks. A per-read timeout catches
    // stalled connections without imposing the metadata fetcher's short end-to-end deadline.
    http_client_builder()
        .read_timeout(ASSET_TRANSFER_READ_TIMEOUT)
        .build()
        .map_err(|_| "could not initialize HTTP client".to_string())
}

fn validate_response_headers(headers: &HeaderMap) -> Result<(), String> {
    let mut total = 0_usize;
    for (name, value) in headers {
        let value_length = value.as_bytes().len();
        if value_length > HTTP_HEADER_VALUE_LIMIT {
            return Err("HTTP response header is too large".into());
        }
        total = total.saturating_add(name.as_str().len() + value_length);
        if total > HTTP_HEADER_TOTAL_LIMIT {
            return Err("HTTP response headers are too large".into());
        }
    }
    Ok(())
}

async fn read_response_capped(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("HTTP response body is too large".into());
    }

    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(limit as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "HTTP response body could not be read".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("HTTP response body is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn html_tag_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?is)<(?:meta|link)\b[^>]*>").expect("valid tag regex"))
}

fn html_attribute_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?is)([a-z_:][a-z0-9_:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#)
            .expect("valid attribute regex")
    })
}

fn html_title_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX
        .get_or_init(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").expect("valid title regex"))
}

fn html_strip_tags_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?is)<[^>]*>").expect("valid strip-tags regex"))
}

fn tag_attributes(tag: &str) -> HashMap<String, String> {
    let mut attributes = HashMap::new();
    for captures in html_attribute_regex().captures_iter(tag) {
        let Some(name) = captures.get(1) else {
            continue;
        };
        let Some(value) = captures.get(2) else {
            continue;
        };
        let raw = value.as_str();
        let unquoted = if raw.len() >= 2
            && ((raw.starts_with('"') && raw.ends_with('"'))
                || (raw.starts_with('\'') && raw.ends_with('\'')))
        {
            &raw[1..raw.len() - 1]
        } else {
            raw
        };
        attributes.insert(
            name.as_str().to_ascii_lowercase(),
            unquoted.trim().to_string(),
        );
    }
    attributes
}

fn decode_basic_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn bounded_text(value: &str, max_chars: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(max_chars).collect())
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedMetadata {
    title: Option<String>,
    og_image: Option<String>,
    favicon: Option<String>,
}

fn parse_document_metadata(html: &str) -> ParsedMetadata {
    let mut og_title = None;
    let mut twitter_title = None;
    let mut og_image = None;
    let mut twitter_image = None;
    let mut favicon = None;

    for tag_match in html_tag_regex().find_iter(html) {
        let tag = tag_match.as_str();
        let attributes = tag_attributes(tag);
        if tag
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("<meta"))
        {
            let key = attributes
                .get("property")
                .or_else(|| attributes.get("name"))
                .map(|value| value.to_ascii_lowercase());
            let content = attributes.get("content").cloned();
            match (key.as_deref(), content) {
                (Some("og:title"), Some(value)) if og_title.is_none() => og_title = Some(value),
                (Some("twitter:title"), Some(value)) if twitter_title.is_none() => {
                    twitter_title = Some(value)
                }
                (Some("og:image"), Some(value)) if og_image.is_none() => og_image = Some(value),
                (Some("twitter:image"), Some(value)) if twitter_image.is_none() => {
                    twitter_image = Some(value)
                }
                _ => {}
            }
        } else {
            let rel = attributes
                .get("rel")
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if favicon.is_none()
                && rel.split_whitespace().any(|value| value == "icon")
                && attributes.contains_key("href")
            {
                favicon = attributes.get("href").cloned();
            }
        }
    }

    let document_title = html_title_regex()
        .captures(html)
        .and_then(|captures| captures.get(1))
        .map(|value| {
            html_strip_tags_regex()
                .replace_all(value.as_str(), " ")
                .into_owned()
        });
    let title = og_title
        .or(twitter_title)
        .or(document_title)
        .map(|value| decode_basic_html_entities(&value))
        .and_then(|value| bounded_text(&value, 512));

    ParsedMetadata {
        title,
        og_image: og_image
            .or(twitter_image)
            .and_then(|value| bounded_text(&value, URL_LIMIT)),
        favicon: favicon.and_then(|value| bounded_text(&value, URL_LIMIT)),
    }
}

fn resolve_http_reference(base: &Url, value: Option<String>) -> Option<String> {
    let value = value?;
    let resolved = base.join(&value).ok()?;
    if !matches!(resolved.scheme(), "http" | "https") {
        return None;
    }
    Some(resolved.to_string())
}

fn safe_log_filename(filename: &str) -> Result<String, String> {
    let filename = filename.trim();
    if filename.is_empty()
        || filename.len() > 180
        || filename.starts_with('.')
        || !is_single_normal_component(filename)
        || !filename.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("invalid log filename".into());
    }
    Ok(filename.to_string())
}

fn json_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)("(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password)"\s*:\s*)"[^"]*""#,
        )
        .expect("valid JSON secret regex")
    })
}

fn header_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?im)^((?:authorization|x-api-key|api-key)\s*:\s*)[^\r\n]+$")
            .expect("valid header secret regex")
    })
}

fn token_secret_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)\b(?:sk-ant-[a-z0-9_-]{12,}|sk-[a-z0-9_-]{20,}|AIza[a-z0-9_-]{20,})\b")
            .expect("valid token secret regex")
    })
}

fn redact_log_secrets(content: &str) -> String {
    let json_redacted = json_secret_regex().replace_all(content, "$1\"[REDACTED]\"");
    let header_redacted = header_secret_regex().replace_all(&json_redacted, "$1[REDACTED]");
    token_secret_regex()
        .replace_all(&header_redacted, "[REDACTED]")
        .into_owned()
}

#[tauri::command]
pub fn material_open_local(app: AppHandle, file_path: String) -> OpenResult {
    let path = PathBuf::from(file_path);
    let valid = path.is_absolute() && fs::metadata(&path).is_ok_and(|metadata| metadata.is_file());
    if !valid {
        return OpenResult::Failure(FailureResult::new("invalid local file path"));
    }
    match app.opener().open_path(path_string(&path), None::<&str>) {
        Ok(()) => OpenResult::Success(OpenSuccess { ok: true }),
        Err(_) => OpenResult::Failure(FailureResult::new("could not open local file")),
    }
}

#[tauri::command]
pub async fn material_pick_file(
    app: AppHandle,
    kind: FilePickerKind,
) -> Result<PickFileResult, String> {
    let selected = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            let mut dialog = app
                .dialog()
                .file()
                // Open document-provider files in place so Drifting can inspect
                // their metadata before making its own durable import copy.
                // iOS Photos may still supply an OS-managed temporary file;
                // our 64 MiB preflight/copy guards apply before persistence.
                .set_file_access_mode(FileAccessMode::Scoped);
            dialog = match kind {
                FilePickerKind::Image => dialog.set_picker_mode(PickerMode::Image).add_filter(
                    "Images",
                    &[
                        "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif",
                        "avif",
                    ],
                ),
                FilePickerKind::Pdf => dialog
                    .set_picker_mode(PickerMode::Document)
                    .add_filter("PDFs", &["pdf"]),
                FilePickerKind::Any => dialog.set_picker_mode(PickerMode::Document),
            };
            dialog.blocking_pick_file()
        }
    })
    .await
    .map_err(|_| "file picker worker failed".to_string())?;

    let Some(selected) = selected else {
        return Ok(PickFileResult::Canceled(PickFileCanceled {
            ok: false,
            canceled: true,
        }));
    };

    let imported = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || copy_picker_file(&app, selected)
    })
    .await
    .map_err(|_| "file import worker failed".to_string())?;

    Ok(match imported {
        Ok((file_path, size_bytes)) => PickFileResult::Success(PickFileSuccess {
            ok: true,
            file_path: path_string(&file_path),
            size_bytes: Some(size_bytes),
        }),
        Err(error) => PickFileResult::Failure(material_import_failure(error)),
    })
}

#[tauri::command]
pub async fn material_thumbnail(file_path: String, size: f64) -> ThumbnailResult {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bounded_size = bounded_u32(size, 1, 2048, 96);
        if is_pdf_file(Path::new(&file_path)) {
            return Err(
                "PDF thumbnail generation is not available in this native module; use the renderer pdf.js fallback"
                    .to_string(),
            );
        }
        image_pipeline::thumbnail_data_url(
            Path::new(&file_path),
            MATERIAL_FILE_LIMIT,
            bounded_size,
        )
        .map_err(|error| error.to_string())
    })
    .await;

    match result {
        Ok(Ok(data_url)) => ThumbnailResult::Success(ThumbnailSuccess { ok: true, data_url }),
        Ok(Err(error)) => ThumbnailResult::Failure(FailureResult::new(error)),
        Err(_) => ThumbnailResult::Failure(FailureResult::new("thumbnail worker failed")),
    }
}

#[tauri::command]
pub async fn material_read_bytes(file_path: String) -> ReadBytesResult {
    let result =
        tauri::async_runtime::spawn_blocking(move || read_file_capped(Path::new(&file_path))).await;
    match result {
        Ok(Ok(bytes)) => ReadBytesResult::Success(ReadBytesSuccess { ok: true, bytes }),
        Ok(Err(error)) if error.kind() == io::ErrorKind::InvalidData => {
            ReadBytesResult::Failure(FailureResult::new("file too large (>64 MiB)"))
        }
        Ok(Err(_)) => ReadBytesResult::Failure(FailureResult::new("could not read local file")),
        Err(_) => ReadBytesResult::Failure(FailureResult::new("file read worker failed")),
    }
}

#[tauri::command]
pub async fn material_inspect_image(file_path: String) -> InspectImageResult {
    let result = tauri::async_runtime::spawn_blocking(move || {
        image_pipeline::inspect(Path::new(&file_path), MATERIAL_FILE_LIMIT)
    })
    .await;

    match result {
        Ok(Ok(inspection)) => InspectImageResult::Success(InspectImageSuccess {
            ok: true,
            mime: inspection.mime,
            size_bytes: inspection.size_bytes,
            width: inspection.width,
            height: inspection.height,
        }),
        Ok(Err(error)) => InspectImageResult::Failure(FailureResult::new(error.to_string())),
        Err(_) => InspectImageResult::Failure(FailureResult::new("image inspection worker failed")),
    }
}

#[tauri::command]
pub async fn material_prepare_image(
    app: AppHandle,
    file_path: String,
    display_max_long_edge: f64,
    display_quality: f64,
    thumbnail_max_long_edge: f64,
    thumbnail_quality: f64,
) -> PrepareImageResult {
    let display_max_long_edge = bounded_u32(display_max_long_edge, 1, 4096, 1600);
    let display_quality = bounded_u32(display_quality, 1, 100, 82) as u8;
    let thumbnail_max_long_edge = bounded_u32(thumbnail_max_long_edge, 1, 2048, 512);
    let thumbnail_quality = bounded_u32(thumbnail_quality, 1, 100, 72) as u8;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if let Some(codec) = image_pipeline::detect_system_codec(path)? {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            return crate::apple_image_codec::prepare(
                path,
                codec,
                MATERIAL_FILE_LIMIT,
                display_max_long_edge,
                display_quality,
                thumbnail_max_long_edge,
                thumbnail_quality,
            );
            #[cfg(target_os = "android")]
            return crate::android_image_codec::prepare(
                &app,
                path,
                codec,
                MATERIAL_FILE_LIMIT,
                display_max_long_edge,
                display_quality,
                thumbnail_max_long_edge,
                thumbnail_quality,
            );
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            return Err(image_pipeline::ImagePipelineError::codec_unavailable(codec));
        }
        let _ = &app;
        image_pipeline::prepare(
            path,
            MATERIAL_FILE_LIMIT,
            display_max_long_edge,
            display_quality,
            thumbnail_max_long_edge,
            thumbnail_quality,
        )
    })
    .await;

    match result {
        Ok(Ok(prepared)) => PrepareImageResult::Success(PrepareImageSuccess {
            ok: true,
            source: prepared.source.into(),
            display: prepared.display.into(),
            thumbnail: prepared.thumbnail.into(),
        }),
        Ok(Err(error)) => PrepareImageResult::Failure(error.into()),
        Err(_) => PrepareImageResult::Failure(PrepareImageFailure {
            ok: false,
            code: image_pipeline::IMAGE_INVALID_CODE,
            codec: None,
            error: "image preparation worker failed".into(),
        }),
    }
}

#[tauri::command]
pub async fn material_create_image_variant(
    file_path: String,
    max_long_edge: f64,
    quality: f64,
) -> ImageVariantResult {
    let result = tauri::async_runtime::spawn_blocking(move || {
        image_pipeline::create_variant(
            Path::new(&file_path),
            MATERIAL_FILE_LIMIT,
            bounded_u32(max_long_edge, 1, 4096, 1600),
            bounded_u32(quality, 1, 100, 82) as u8,
        )
    })
    .await;
    match result {
        Ok(Ok(success)) => ImageVariantResult::Success(success.into()),
        Ok(Err(error)) => ImageVariantResult::Failure(FailureResult::new(error.to_string())),
        Err(_) => ImageVariantResult::Failure(FailureResult::new("image variant worker failed")),
    }
}

#[tauri::command]
pub async fn material_create_thumbnail_variant(
    file_path: String,
    size: f64,
    quality: f64,
) -> ImageVariantResult {
    let result = tauri::async_runtime::spawn_blocking(move || {
        image_pipeline::create_variant(
            Path::new(&file_path),
            MATERIAL_FILE_LIMIT,
            bounded_u32(size, 1, 2048, 512),
            bounded_u32(quality, 1, 100, 72) as u8,
        )
    })
    .await;
    match result {
        Ok(Ok(success)) => ImageVariantResult::Success(success.into()),
        Ok(Err(error)) => ImageVariantResult::Failure(FailureResult::new(error.to_string())),
        Err(_) => {
            ImageVariantResult::Failure(FailureResult::new("thumbnail variant worker failed"))
        }
    }
}

#[tauri::command]
pub async fn material_resolve_url_meta(url: String) -> UrlMetadataResult {
    let parsed_url = match parse_http_url(&url) {
        Ok(url) => url,
        Err(error) => return UrlMetadataResult::Failure(FailureResult::new(error)),
    };
    let client = match url_metadata_http_client() {
        Ok(client) => client,
        Err(error) => return UrlMetadataResult::Failure(FailureResult::new(error)),
    };
    let mut response = match client
        .get(parsed_url)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return UrlMetadataResult::Failure(FailureResult::new("URL request failed"));
        }
    };
    if !response.status().is_success() {
        return UrlMetadataResult::Failure(FailureResult::new(format!(
            "HTTP {}",
            response.status().as_u16()
        )));
    }
    if let Err(error) = validate_response_headers(response.headers()) {
        return UrlMetadataResult::Failure(FailureResult::new(error));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.starts_with("text/html")
        && !content_type.starts_with("application/xhtml+xml")
    {
        return UrlMetadataResult::Failure(FailureResult::new("URL did not return HTML"));
    }
    let final_url = response.url().clone();
    let body = match read_response_capped(&mut response, URL_META_BODY_LIMIT).await {
        Ok(body) => body,
        Err(error) => return UrlMetadataResult::Failure(FailureResult::new(error)),
    };
    let html = String::from_utf8_lossy(&body);
    let metadata = parse_document_metadata(&html);
    UrlMetadataResult::Success(UrlMetadataSuccess {
        ok: true,
        title: metadata.title,
        og_image: resolve_http_reference(&final_url, metadata.og_image),
        favicon: resolve_http_reference(&final_url, metadata.favicon),
    })
}

#[tauri::command]
pub fn asset_cache_get_path(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    variant: AssetVariant,
    ext: String,
) -> AssetCachePathResult {
    let path = match asset_cache_path(&app, &project_id, &asset_id, variant, &ext) {
        Ok(path) => path,
        Err(error) => return AssetCachePathResult::Failure(FailureResult::new(error)),
    };
    let url = match file_url(&path) {
        Ok(url) => url,
        Err(error) => return AssetCachePathResult::Failure(FailureResult::new(error)),
    };
    let metadata = fs::metadata(&path)
        .ok()
        .filter(|metadata| metadata.is_file());
    AssetCachePathResult::Success(AssetCachePathSuccess {
        ok: true,
        file_path: path_string(&path),
        file_url: url,
        exists: metadata.is_some(),
        size_bytes: metadata.map(|metadata| metadata.len()),
    })
}

fn cache_write_success(path: &Path, size_bytes: u64) -> Result<AssetCacheWriteSuccess, String> {
    Ok(AssetCacheWriteSuccess {
        ok: true,
        file_path: path_string(path),
        file_url: file_url(path)?,
        size_bytes,
    })
}

#[tauri::command]
pub async fn asset_cache_write_bytes(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    variant: AssetVariant,
    ext: String,
    bytes: Vec<u8>,
) -> AssetCacheWriteResult {
    if bytes.len() as u64 > MATERIAL_FILE_LIMIT {
        return AssetCacheWriteResult::Failure(FailureResult::new(
            "asset exceeds cache write limit (>64 MiB)",
        ));
    }
    let path = match asset_cache_path(&app, &project_id, &asset_id, variant, &ext) {
        Ok(path) => path,
        Err(error) => return AssetCacheWriteResult::Failure(FailureResult::new(error)),
    };
    let size_bytes = bytes.len() as u64;
    let write = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || atomic_write(&path, &bytes)
    })
    .await;
    match write {
        Ok(Ok(())) => match cache_write_success(&path, size_bytes) {
            Ok(success) => AssetCacheWriteResult::Success(success),
            Err(error) => AssetCacheWriteResult::Failure(FailureResult::new(error)),
        },
        _ => AssetCacheWriteResult::Failure(FailureResult::new("could not write cached asset")),
    }
}

#[tauri::command]
pub async fn asset_cache_copy_file(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    variant: AssetVariant,
    ext: String,
    source_path: String,
) -> AssetCacheWriteResult {
    let path = match asset_cache_path(&app, &project_id, &asset_id, variant, &ext) {
        Ok(path) => path,
        Err(error) => return AssetCacheWriteResult::Failure(FailureResult::new(error)),
    };
    let source = PathBuf::from(source_path);
    let copy = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || atomic_copy_capped(&source, &path, ASSET_TRANSFER_LIMIT)
    })
    .await;
    match copy {
        Ok(Ok(size_bytes)) => match cache_write_success(&path, size_bytes) {
            Ok(success) => AssetCacheWriteResult::Success(success),
            Err(error) => AssetCacheWriteResult::Failure(FailureResult::new(error)),
        },
        Ok(Err(error)) if error.kind() == io::ErrorKind::InvalidData => {
            AssetCacheWriteResult::Failure(FailureResult::new(
                "source file is too large (>512 MiB)",
            ))
        }
        _ => AssetCacheWriteResult::Failure(FailureResult::new("could not copy cached asset")),
    }
}

#[tauri::command]
pub async fn asset_cache_upload_file(
    app: AppHandle,
    url: String,
    project_id: String,
    asset_id: String,
    variant: AssetVariant,
    ext: String,
    content_type: String,
) -> AssetCacheUploadResult {
    let parsed_url = match parse_http_url(&url) {
        Ok(url) => url,
        Err(_) => {
            return AssetCacheUploadResult::Failure(FailureResult::new("invalid upload URL"));
        }
    };
    if content_type.is_empty() || content_type.len() > 256 {
        return AssetCacheUploadResult::Failure(FailureResult::new("invalid content type"));
    }
    let content_type = match HeaderValue::from_str(&content_type) {
        Ok(value) => value,
        Err(_) => {
            return AssetCacheUploadResult::Failure(FailureResult::new("invalid content type"));
        }
    };
    let path = match asset_cache_path(&app, &project_id, &asset_id, variant, &ext) {
        Ok(path) => path,
        Err(error) => return AssetCacheUploadResult::Failure(FailureResult::new(error)),
    };
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() <= ASSET_TRANSFER_LIMIT => metadata,
        Ok(metadata) if metadata.len() > ASSET_TRANSFER_LIMIT => {
            return AssetCacheUploadResult::Failure(FailureResult::new(
                "cached asset is too large (>512 MiB)",
            ));
        }
        _ => {
            return AssetCacheUploadResult::Failure(FailureResult::new(
                "could not read cached asset",
            ));
        }
    };
    let size_bytes = metadata.len();
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => {
            return AssetCacheUploadResult::Failure(FailureResult::new(
                "could not read cached asset",
            ));
        }
    };
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
    let client = match asset_transfer_http_client() {
        Ok(client) => client,
        Err(error) => return AssetCacheUploadResult::Failure(FailureResult::new(error)),
    };
    let response = match client
        .put(parsed_url)
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, size_bytes)
        .body(body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return AssetCacheUploadResult::Failure(FailureResult::new("asset upload failed"));
        }
    };
    if let Err(error) = validate_response_headers(response.headers()) {
        return AssetCacheUploadResult::Failure(FailureResult::new(error));
    }
    if !response.status().is_success() {
        return AssetCacheUploadResult::Failure(FailureResult::new(format!(
            "HTTP {}",
            response.status().as_u16()
        )));
    }
    AssetCacheUploadResult::Success(AssetCacheUploadSuccess {
        ok: true,
        size_bytes,
    })
}

#[tauri::command]
pub async fn asset_cache_download(
    app: AppHandle,
    url: String,
    project_id: String,
    asset_id: String,
    variant: AssetVariant,
    ext: String,
) -> AssetCacheWriteResult {
    let parsed_url = match parse_http_url(&url) {
        Ok(url) => url,
        Err(_) => {
            return AssetCacheWriteResult::Failure(FailureResult::new("invalid download URL"))
        }
    };
    let path = match asset_cache_path(&app, &project_id, &asset_id, variant, &ext) {
        Ok(path) => path,
        Err(error) => return AssetCacheWriteResult::Failure(FailureResult::new(error)),
    };
    let client = match asset_transfer_http_client() {
        Ok(client) => client,
        Err(error) => return AssetCacheWriteResult::Failure(FailureResult::new(error)),
    };
    let response = match client.get(parsed_url).send().await {
        Ok(response) => response,
        Err(_) => {
            return AssetCacheWriteResult::Failure(FailureResult::new("asset download failed"))
        }
    };
    if let Err(error) = validate_response_headers(response.headers()) {
        return AssetCacheWriteResult::Failure(FailureResult::new(error));
    }
    if !response.status().is_success() {
        return AssetCacheWriteResult::Failure(FailureResult::new(format!(
            "HTTP {}",
            response.status().as_u16()
        )));
    }
    match download_response_atomically(response, &path, ASSET_TRANSFER_LIMIT).await {
        Ok(size_bytes) => match cache_write_success(&path, size_bytes) {
            Ok(success) => AssetCacheWriteResult::Success(success),
            Err(error) => AssetCacheWriteResult::Failure(FailureResult::new(error)),
        },
        Err(error) if error.kind() == io::ErrorKind::InvalidData => AssetCacheWriteResult::Failure(
            FailureResult::new("asset exceeds download limit (>512 MiB)"),
        ),
        Err(_) => {
            AssetCacheWriteResult::Failure(FailureResult::new("could not write downloaded asset"))
        }
    }
}

#[tauri::command]
pub async fn asset_cache_delete_asset(
    app: AppHandle,
    project_id: String,
    asset_id: String,
) -> AssetCacheDeleteResult {
    let path = match asset_cache_asset_dir(&app, &project_id, &asset_id) {
        Ok(path) => path,
        Err(error) => return AssetCacheDeleteResult::Failure(FailureResult::new(error)),
    };
    let deletion =
        tauri::async_runtime::spawn_blocking(move || match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to delete a symlinked cache directory",
            )),
            Ok(_) => fs::remove_dir_all(path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        })
        .await;
    match deletion {
        Ok(Ok(())) => AssetCacheDeleteResult::Success(AssetCacheDeleteSuccess { ok: true }),
        _ => AssetCacheDeleteResult::Failure(FailureResult::new("could not delete cached asset")),
    }
}

#[tauri::command]
pub async fn ai_log_write(app: AppHandle, filename: String, content: String) -> AiLogWriteResult {
    let filename = match safe_log_filename(&filename) {
        Ok(filename) => filename,
        Err(error) => return AiLogWriteResult::Failure(FailureResult::new(error)),
    };
    if content.len() > AI_LOG_LIMIT {
        return AiLogWriteResult::Failure(FailureResult::new("AI log content is too large"));
    }
    let directory = match app_local_dir(&app, "ai-log") {
        Ok(directory) => directory,
        Err(error) => return AiLogWriteResult::Failure(FailureResult::new(error)),
    };
    let path = directory.join(filename);
    let redacted = redact_log_secrets(&content);
    let write = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || atomic_write(&path, redacted.as_bytes())
    })
    .await;
    match write {
        Ok(Ok(())) => AiLogWriteResult::Success(AiLogWriteSuccess {
            ok: true,
            file_path: path_string(&path),
        }),
        _ => AiLogWriteResult::Failure(FailureResult::new("could not write AI log")),
    }
}

#[tauri::command]
pub fn ai_log_get_dir(app: AppHandle) -> Result<String, String> {
    app_local_dir(&app, "ai-log").map(|path| path_string(&path))
}

#[tauri::command]
pub async fn ai_log_open_dir(app: AppHandle) -> Result<String, String> {
    let directory = app_local_dir(&app, "ai-log")?;
    tauri::async_runtime::spawn_blocking({
        let directory = directory.clone();
        move || fs::create_dir_all(directory)
    })
    .await
    .map_err(|_| "AI log directory worker failed".to_string())?
    .map_err(|_| "could not create AI log directory".to_string())?;
    app.opener()
        .open_path(path_string(&directory), None::<&str>)
        .map_err(|_| "could not open AI log directory".to_string())?;
    Ok(path_string(&directory))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "drifting-native-capabilities-{label}-{}",
            unique_token()
        ))
    }

    #[test]
    fn cache_segments_and_extensions_cannot_escape_the_cache_root() {
        assert_eq!(
            safe_cache_segment("project/../../asset").unwrap(),
            "project_.._.._asset"
        );
        assert_eq!(safe_cache_segment(".hidden").unwrap(), "_.hidden");
        assert!(safe_cache_segment("..").is_err());
        assert!(safe_cache_segment("  ").is_err());
        assert_eq!(safe_cache_extension(".JpG").unwrap(), "jpg");
        assert!(safe_cache_extension("../jpg").is_err());
        assert!(safe_cache_extension("svg+xml").is_err());

        let root = Path::new("/tmp/cache-root");
        let path = asset_cache_path_from_root(
            root,
            "project/../../asset",
            "asset/../../../id",
            AssetVariant::Thumbnail,
            "jpg",
        )
        .unwrap();
        assert!(path.starts_with(root));
        assert_eq!(path.file_name().unwrap(), "thumbnail.jpg");
    }

    #[test]
    fn cache_paths_are_stable_and_variant_specific() {
        let root = Path::new("/tmp/cache-root");
        let source =
            asset_cache_path_from_root(root, "project-a", "asset-a", AssetVariant::Source, "PNG")
                .unwrap();
        let display =
            asset_cache_path_from_root(root, "project-a", "asset-a", AssetVariant::Display, "png")
                .unwrap();
        assert_eq!(
            source,
            root.join("project-a").join("asset-a").join("source.png")
        );
        assert_eq!(
            display,
            root.join("project-a").join("asset-a").join("display.png")
        );
        assert_ne!(source, display);
    }

    #[cfg(unix)]
    #[test]
    fn cache_access_rejects_symlinked_project_directories() {
        use std::os::unix::fs::symlink;

        let directory = test_directory("symlink-cache");
        let root = directory.join("cache");
        let outside = directory.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("project-a")).unwrap();

        assert!(reject_symlinked_cache_path(&root, "project-a", "asset-a", None).is_err());
        assert!(outside.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_cache_write_replaces_content_and_leaves_no_partial_file() {
        let directory = test_directory("atomic-write");
        let path = directory.join("project").join("asset").join("source.bin");
        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");

        let siblings = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(siblings, vec!["source.bin"]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn capped_reads_reject_oversized_files() {
        let directory = test_directory("read-cap");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("input.bin");
        fs::write(&path, b"12345").unwrap();
        assert_eq!(read_file_capped_with_limit(&path, 5).unwrap(), b"12345");
        assert_eq!(
            read_file_capped_with_limit(&path, 4).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn material_import_limit_matches_the_in_memory_material_limit() {
        assert!(validate_material_import_size(MATERIAL_FILE_LIMIT).is_ok());
        assert_eq!(
            validate_material_import_size(MATERIAL_FILE_LIMIT + 1).unwrap_err(),
            MATERIAL_FILE_TOO_LARGE_ERROR
        );

        let failure = material_import_failure(MATERIAL_FILE_TOO_LARGE_ERROR.into());
        let serialized = serde_json::to_value(failure).unwrap();
        assert_eq!(serialized["ok"], false);
        assert_eq!(serialized["canceled"], false);
        assert_eq!(serialized["code"], MATERIAL_FILE_TOO_LARGE_CODE);
        assert_eq!(serialized["error"], MATERIAL_FILE_TOO_LARGE_ERROR);
        assert_eq!(serialized["maxSizeBytes"], MATERIAL_FILE_LIMIT);
    }

    #[test]
    fn image_command_numbers_are_bounded() {
        assert_eq!(bounded_u32(-20.0, 1, 4096, 1600), 1);
        assert_eq!(bounded_u32(50_000.0, 1, 4096, 1600), 4096);
        assert_eq!(bounded_u32(f64::NAN, 1, 4096, 1600), 1600);
        assert_eq!(sniff_extension(b"%PDF-1.7"), "pdf");
    }

    #[test]
    fn only_http_urls_without_embedded_credentials_are_accepted() {
        assert!(parse_http_url("https://example.com/path?q=1").is_ok());
        assert!(parse_http_url("http://example.com").is_ok());
        assert!(parse_http_url("file:///tmp/secret").is_err());
        assert!(parse_http_url("https://user:password@example.com").is_err());
    }

    #[test]
    fn metadata_and_asset_transfer_clients_build_with_distinct_timeout_policies() {
        assert_eq!(HTTP_CONNECT_TIMEOUT, Duration::from_secs(5));
        assert_eq!(URL_METADATA_TOTAL_TIMEOUT, Duration::from_secs(8));
        assert_eq!(ASSET_TRANSFER_READ_TIMEOUT, Duration::from_secs(30));
        assert!(url_metadata_http_client().is_ok());
        assert!(asset_transfer_http_client().is_ok());
    }

    #[test]
    fn metadata_parser_handles_attribute_order_and_relative_assets() {
        let html = r#"
          <html><head>
            <meta content="A &amp; B" property="og:title">
            <meta content="/cover.jpg" property="og:image">
            <link href="icons/site.png" rel="shortcut icon">
            <title>Fallback</title>
          </head></html>
        "#;
        let parsed = parse_document_metadata(html);
        assert_eq!(parsed.title.as_deref(), Some("A & B"));
        let base = parse_http_url("https://example.com/articles/one").unwrap();
        assert_eq!(
            resolve_http_reference(&base, parsed.og_image),
            Some("https://example.com/cover.jpg".into())
        );
        assert_eq!(
            resolve_http_reference(&base, parsed.favicon),
            Some("https://example.com/articles/icons/site.png".into())
        );
    }

    #[test]
    fn log_redaction_removes_common_credential_shapes() {
        let input = concat!(
            "Authorization: Bearer secret-value\n",
            "{\"apiKey\":\"sk-ant-abcdefghijklmnop\",\"message\":\"keep me\"}\n",
            "token sk-abcdefghijklmnopqrstuvwxyz"
        );
        let redacted = redact_log_secrets(input);
        assert!(!redacted.contains("secret-value"));
        assert!(!redacted.contains("sk-ant-abcdefghijklmnop"));
        assert!(!redacted.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert!(redacted.contains("keep me"));
    }
}
