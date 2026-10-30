//! Project Markdown folder. Generated reading files are derived and read-only.
//! Authored files (chapters and drifts) are writable: the renderer reads them
//! back and merges external edits into Yjs, so this writer never replaces
//! authored bytes it has not been told about (`expected_sha256`).
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

static WRITER: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    path: String,
    text: String,
    /// An authored file: writable, and merged back into Drifting when edited.
    #[serde(default)]
    authored: bool,
    /// SHA-256 of the authored file as Drifting last wrote or read it. A file
    /// with other bytes was edited outside Drifting and is not replaced.
    #[serde(default)]
    expected_sha256: Option<String>,
}

/// Largest authored file read back from disk.
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;
const OWNER: &str = ".drifting/owner.json";
const PRESERVED: &str = ".drifting/preserved";

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetVariant {
    Source,
    Display,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    path: String,
    asset_id: String,
    variant: AssetVariant,
    ext: String,
    source_sha256: Option<String>,
    source_size_bytes: Option<u64>,
}

struct OutputEntry {
    path: String,
    bytes: Vec<u8>,
    authored: bool,
    expected: Option<String>,
}
const MAX_BYTES: usize = 256 * 1024 * 1024;
const ASSET_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tiff", "heic",
    "heif", "bin",
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    key: String,
    path: String,
    title: String,
    anchor: Option<String>,
    source_version: Option<String>,
}

const MANIFEST: &str = ".drifting/manifest.json";
const PENDING: &str = ".drifting/pending-manifest.json";
const MANIFEST_PATHS: [&str; 4] = [MANIFEST, PENDING, "manifest.json", ".pending-manifest.json"];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    project_id: String,
    generated_at: String,
    read_only: bool,
    reverse_sync: bool,
    files: BTreeMap<String, String>,
    #[serde(default)]
    documents: Vec<Document>,
    /// Paths of authored files (schema 4). Their hashes in `files` are the
    /// bytes this writer published.
    #[serde(default)]
    authored: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionInfo {
    directory: String,
    custom_root: Option<String>,
    generated_at: Option<String>,
    read_only: bool,
    reverse_sync: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    #[serde(flatten)]
    info: ProjectionInfo,
    /// Authored paths left untouched because their bytes changed on disk.
    conflicts: Vec<String>,
    /// Edited files this writer kept a copy of under `.drifting/preserved`.
    preserved: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    path: String,
    known_size: Option<u64>,
    known_modified_ms: Option<i64>,
    /// Read and hash even when size and modification time match.
    #[serde(default)]
    force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    path: String,
    exists: bool,
    size: u64,
    modified_ms: i64,
    /// Size or modification time differ from the request, or `force` was set.
    changed: bool,
    sha256: Option<String>,
    text: Option<String>,
    /// `encoding`, `too-large` or an I/O message; the file is then not read.
    error: Option<String>,
}

pub fn project_directory(root: &Path, project_id: &str) -> PathBuf {
    root.join("markdown-projections")
        .join(format!("{:x}", Sha256::digest(project_id.as_bytes())))
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputSettings {
    roots: BTreeMap<String, PathBuf>,
}

// Device-local paths must never enter project data or authored sync settings.
fn read_settings(root: &Path) -> Result<OutputSettings, String> {
    inspect(root, true)?;
    let path = root.join("markdown-projection-settings.json");
    if !inspect(&path, false)? {
        return Ok(OutputSettings::default());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("Projection settings exceed size limit".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid projection output settings".into())
}

fn output_root(root: &Path, project_id: &str) -> Result<(PathBuf, Option<String>), String> {
    validate_project(project_id)?;
    match read_settings(root)?.roots.remove(project_id) {
        Some(custom) => {
            if !custom.is_absolute()
                || (inspect(&custom, true)?
                    && fs::canonicalize(&custom).map_err(|e| e.to_string())? != custom)
            {
                return Err("Custom projection output directory is unavailable".into());
            }
            let label = custom.to_string_lossy().into_owned();
            Ok((custom, Some(label)))
        }
        None => Ok((root.to_path_buf(), None)),
    }
}

pub fn resolved_project_directory(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    let (output, _) = output_root(root, project_id)?;
    Ok(project_directory(&output, project_id))
}

pub(crate) fn set_output_root(
    root: &Path,
    project_id: &str,
    custom_root: Option<String>,
) -> Result<ProjectionInfo, String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    validate_project(project_id)?;
    let mut settings = read_settings(root)?;
    let selected = match custom_root {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() || !inspect(&path, true)? {
                return Err("Select an existing absolute output directory".into());
            }
            Some(fs::canonicalize(path).map_err(|e| e.to_string())?)
        }
        None => None,
    };
    let output = selected.as_deref().unwrap_or(root);
    let result = info_at(
        output,
        project_id,
        selected.as_ref().map(|p| p.to_string_lossy().into_owned()),
    )?;
    let directory = PathBuf::from(&result.directory);
    if inspect(&directory, true)?
        && read_owned_manifest(&directory, project_id)?.is_none()
        && fs::read_dir(&directory)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("Output directory contains files not owned by this projection".into());
    }
    ensure_directory(&output.join("markdown-projections"))?;
    ensure_directory(&directory)?;
    // Check writability before persisting a new location; never touch old output.
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let probe = directory.join(format!(
        ".projection-check-{:032x}.tmp",
        u128::from_le_bytes(random)
    ));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|e| e.to_string())?;
    fs::remove_file(probe).map_err(|e| e.to_string())?;
    if let Some(selected) = selected {
        settings.roots.insert(project_id.into(), selected);
    } else {
        settings.roots.remove(project_id);
    }
    atomic_write(
        &root.join("markdown-projection-settings.json"),
        &serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
        0o400,
    )?;
    Ok(result)
}

fn validate_project(project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > 256 {
        return Err("Invalid projection project".into());
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), String> {
    let attachment = (path.starts_with("project/assets/id-") || path.starts_with("资料/附件/"))
        && path
            .rsplit('.')
            .next()
            .is_some_and(|ext| ASSET_EXTENSIONS.contains(&ext));
    if path.len() > 1024
        || !(path.ends_with(".md") || attachment)
        || path.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.len() > 240
                || part.ends_with('.')
                || part.ends_with(' ')
                || part
                    .chars()
                    .any(|c| c.is_control() || "\\:*?\"<>|#^[]".contains(c))
                || matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
    {
        return Err("Unsafe Markdown projection path".into());
    }
    Ok(())
}

fn inspect(path: &Path, directory: bool) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink()
                || (directory && !meta.is_dir())
                || (!directory && !meta.is_file())
            {
                return Err("Unsafe Markdown projection entry".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if !directory && meta.nlink() != 1 {
                    return Err("Linked projection file rejected".into());
                }
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    if !inspect(path, true)? {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn prepare_path(root: &Path, path: &str, create: bool) -> Result<PathBuf, String> {
    let mut target = root.to_path_buf();
    let parts: Vec<_> = path.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        target.push(part);
        if create {
            ensure_directory(&target)?;
        } else {
            inspect(&target, true)?;
        }
    }
    target.push(parts[parts.len() - 1]);
    inspect(&target, false)?;
    Ok(target)
}

fn read_manifest(root: &Path) -> Result<Option<Manifest>, String> {
    inspect(&root.join(".drifting"), true)?;
    match read_manifest_file(root, MANIFEST)? {
        Some(manifest) => Ok(Some(manifest)),
        None => read_manifest_file(root, "manifest.json"),
    }
}

fn read_manifest_file(root: &Path, filename: &str) -> Result<Option<Manifest>, String> {
    let path = root.join(filename);
    if !inspect(&path, false)? {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
        return Err("Projection manifest exceeds size limit".into());
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid projection manifest")?;
    let supported = match manifest.schema_version {
        1..=3 => manifest.read_only && !manifest.reverse_sync && manifest.authored.is_empty(),
        4 => !manifest.read_only && manifest.reverse_sync,
        _ => false,
    };
    if !supported {
        return Err("Unsupported projection manifest".into());
    }
    for path in manifest.files.keys() {
        validate_path(path)?;
    }
    if manifest
        .authored
        .iter()
        .any(|path| !path.ends_with(".md") || !manifest.files.contains_key(path))
    {
        return Err("Invalid projection manifest".into());
    }
    Ok(Some(manifest))
}

// Record ownership before changing files, so interrupted writes can be retried
// without treating their new files as user-created collisions.
fn read_owned_manifest(root: &Path, project_id: &str) -> Result<Option<Manifest>, String> {
    inspect(&root.join(".drifting"), true)?;
    let mut owned: Option<Manifest> = None;
    for path in MANIFEST_PATHS {
        let Some(manifest) = read_manifest_file(root, path)? else {
            continue;
        };
        if manifest.project_id != project_id {
            return Err("Projection project mismatch".into());
        }
        if let Some(owned) = &mut owned {
            owned.files.extend(manifest.files);
            owned.authored.extend(manifest.authored);
        } else {
            owned = Some(manifest);
        }
    }
    Ok(owned)
}

fn info(root: &Path, project_id: &str) -> Result<ProjectionInfo, String> {
    let (output, custom_root) = output_root(root, project_id)?;
    info_at(&output, project_id, custom_root)
}

fn info_at(
    root: &Path,
    project_id: &str,
    custom_root: Option<String>,
) -> Result<ProjectionInfo, String> {
    validate_project(project_id)?;
    inspect(root, true)?;
    inspect(&root.join("markdown-projections"), true)?;
    let directory = project_directory(root, project_id);
    let exists = inspect(&directory, true)?;
    let manifest = if exists {
        read_manifest(&directory)?
    } else {
        None
    };
    if manifest
        .as_ref()
        .is_some_and(|m| m.project_id != project_id)
    {
        return Err("Projection project mismatch".into());
    }
    Ok(ProjectionInfo {
        directory: directory.to_string_lossy().into_owned(),
        custom_root,
        generated_at: manifest.map(|m| m.generated_at),
        read_only: false,
        reverse_sync: true,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// One Drifting installation manages a folder. Two would each merge the same
/// external edit into their own copy, and sync would then duplicate the text.
fn instance_id(root: &Path) -> Result<String, String> {
    let path = root.join("markdown-mirror-instance");
    if inspect(&path, false)? {
        let value = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let value = value.trim();
        if value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(value.to_owned());
        }
        return Err("Invalid Markdown folder instance identity".into());
    }
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let value = format!("{:032x}", u128::from_le_bytes(random));
    atomic_write(&path, value.as_bytes(), 0o600)?;
    Ok(value)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    instance: String,
}

/// Checks the folder's owner, claiming an unowned folder when `claim` is set.
fn check_owner(root: &Path, directory: &Path, claim: bool) -> Result<(), String> {
    let instance = instance_id(root)?;
    let path = directory.join(OWNER);
    if inspect(&path, false)? {
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 4096 {
            return Err("Invalid Markdown folder owner".into());
        }
        let owner: Owner = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|_| "Invalid Markdown folder owner")?;
        if owner.instance != instance {
            return Err(
                "This Markdown folder is managed by another Drifting installation".into(),
            );
        }
    } else if claim {
        ensure_directory(&directory.join(".drifting"))?;
        atomic_write(
            &path,
            &serde_json::to_vec(&Owner { instance }).map_err(|e| e.to_string())?,
            0o600,
        )?;
    }
    Ok(())
}

/// Keeps a copy of an edited file before it is replaced or abandoned.
fn preserve(directory: &Path, path: &str, bytes: &[u8], stamp: &str) -> Result<(), String> {
    let stamp: String = stamp
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(64)
        .collect();
    ensure_directory(&directory.join(".drifting"))?;
    ensure_directory(&directory.join(PRESERVED))?;
    let base = format!("{PRESERVED}/{stamp}");
    let target = prepare_path(directory, &format!("{base}/{path}"), true)?;
    atomic_write(&target, bytes, 0o600)
}

fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as i64)
}

fn read_files(
    root: &Path,
    project_id: &str,
    requests: Vec<ReadRequest>,
) -> Result<Vec<ReadResult>, String> {
    validate_project(project_id)?;
    if requests.len() > 20_000 {
        return Err("Too many Markdown files requested".into());
    }
    let directory = resolved_project_directory(root, project_id)?;
    if !inspect(&directory, true)? {
        return Ok(requests
            .into_iter()
            .map(|request| ReadResult {
                path: request.path,
                exists: false,
                size: 0,
                modified_ms: 0,
                changed: request.known_size.is_some(),
                sha256: None,
                text: None,
                error: None,
            })
            .collect());
    }
    check_owner(root, &directory, false)?;
    let mut results = Vec::with_capacity(requests.len());
    for request in requests {
        validate_path(&request.path)?;
        if !request.path.ends_with(".md") {
            return Err("Only Markdown files can be read back".into());
        }
        let target = match prepare_path(&directory, &request.path, false) {
            Ok(target) => target,
            Err(error) => {
                results.push(ReadResult {
                    path: request.path,
                    exists: false,
                    size: 0,
                    modified_ms: 0,
                    changed: true,
                    sha256: None,
                    text: None,
                    error: Some(error),
                });
                continue;
            }
        };
        let meta = match fs::metadata(&target) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                results.push(ReadResult {
                    path: request.path,
                    exists: false,
                    size: 0,
                    modified_ms: 0,
                    changed: request.known_size.is_some(),
                    sha256: None,
                    text: None,
                    error: None,
                });
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        let size = meta.len();
        let modified = modified_ms(&meta);
        let changed = request.force
            || request.known_size != Some(size)
            || request.known_modified_ms != Some(modified);
        let mut result = ReadResult {
            path: request.path,
            exists: true,
            size,
            modified_ms: modified,
            changed,
            sha256: None,
            text: None,
            error: None,
        };
        if changed {
            if size > MAX_READ_BYTES {
                result.error = Some("too-large".into());
            } else {
                let mut bytes = Vec::new();
                fs::File::open(&target)
                    .map_err(|e| e.to_string())?
                    .take(MAX_READ_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                result.size = bytes.len() as u64;
                result.sha256 = Some(sha256_hex(&bytes));
                match String::from_utf8(bytes) {
                    Ok(text) => result.text = Some(text),
                    Err(_) => result.error = Some("encoding".into()),
                }
            }
        }
        results.push(result);
    }
    Ok(results)
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = mode;
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let temporary =
        path.with_file_name(format!(".projection-{:x}.tmp", u128::from_le_bytes(random)));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|e| e.to_string())?;
        }
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
fn write_projection(
    root: &Path,
    project_id: &str,
    generated_at: String,
    entries: Vec<Entry>,
) -> Result<ProjectionInfo, String> {
    write_projection_with_assets(root, project_id, generated_at, entries, vec![])
}

#[cfg(test)]
fn write_projection_with_assets(
    root: &Path,
    project_id: &str,
    generated_at: String,
    entries: Vec<Entry>,
    assets: Vec<Asset>,
) -> Result<ProjectionInfo, String> {
    write_projection_with_documents(root, project_id, generated_at, entries, assets, vec![])
        .map(|result| result.info)
}

fn write_projection_with_documents(
    root: &Path,
    project_id: &str,
    generated_at: String,
    entries: Vec<Entry>,
    assets: Vec<Asset>,
    documents: Vec<Document>,
) -> Result<WriteResult, String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    validate_project(project_id)?;
    if entries.len() + assets.len() > 20_000 {
        return Err("Markdown projection exceeds size limit".into());
    }
    let mut total = 0usize;
    let mut output = Vec::new();
    for entry in entries {
        validate_path(&entry.path)?;
        if !entry.path.ends_with(".md") {
            return Err("Text projection entries must be Markdown".into());
        }
        if entry
            .expected_sha256
            .as_ref()
            .is_some_and(|hash| !entry.authored || !valid_sha256(hash))
        {
            return Err("Invalid authored file expectation".into());
        }
        total = total
            .checked_add(entry.text.len())
            .filter(|size| *size <= MAX_BYTES)
            .ok_or("Markdown projection exceeds size limit")?;
        output.push(OutputEntry {
            path: entry.path,
            bytes: entry.text.into_bytes(),
            authored: entry.authored,
            expected: entry.expected_sha256,
        });
    }
    // Resolve only immutable app-owned sources. Never accept an arbitrary source path over IPC.
    // Verify every attachment before changing even one managed Markdown file.
    let store =
        drifting_core::asset_store::AssetStore::new(root.join("assets"), "markdown-projection");
    for asset in assets {
        validate_path(&asset.path)?;
        if !(asset.path.starts_with("project/assets/id-") || asset.path.starts_with("资料/附件/"))
            || !ASSET_EXTENSIONS.contains(&asset.ext.as_str())
        {
            return Err("Invalid projection attachment".into());
        }
        let source = store.path(project_id, &asset.asset_id, &asset.ext)?;
        let source = match asset.variant {
            AssetVariant::Source => {
                if !asset.path.ends_with(&format!(".{}", asset.ext))
                    || !asset.source_sha256.as_ref().is_some_and(|hash| {
                        hash.len() == 64
                            && hash
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
                    || !asset
                        .source_size_bytes
                        .is_some_and(|size| size > 0 && size <= MAX_BYTES as u64)
                {
                    return Err("Invalid projection source metadata".into());
                }
                source
            }
            AssetVariant::Display => {
                if asset.ext != "jpg"
                    || !asset.path.ends_with(".jpg")
                    || asset.source_sha256.is_some()
                    || asset.source_size_bytes.is_some()
                {
                    return Err("Invalid projection preview metadata".into());
                }
                source.with_file_name("display.jpg")
            }
        };
        if !inspect(&source, false)? {
            return Err(format!(
                "Local projection asset {} is unavailable",
                asset.asset_id
            ));
        }
        let length = fs::metadata(&source).map_err(|e| e.to_string())?.len();
        if length == 0 || length > (MAX_BYTES - total) as u64 {
            return Err("Projection attachment exceeds size limit".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(&source)
            .map_err(|e| e.to_string())?
            .take(length + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != length
            || asset.source_size_bytes.is_some_and(|size| size != length)
            || asset
                .source_sha256
                .as_ref()
                .is_some_and(|hash| *hash != format!("{:x}", Sha256::digest(&bytes)))
        {
            return Err(format!(
                "Projection asset {} failed integrity verification",
                asset.asset_id
            ));
        }
        total += bytes.len();
        output.push(OutputEntry {
            path: asset.path,
            bytes,
            authored: false,
            expected: None,
        });
    }
    let entries = output;
    let mut paths = HashSet::new();
    for entry in &entries {
        validate_path(&entry.path)?;
        if !paths.insert(entry.path.to_lowercase()) {
            return Err("Duplicate projection path".into());
        }
    }
    for entry in &entries {
        let lowered = entry.path.to_lowercase();
        let parts: Vec<_> = lowered.split('/').collect();
        for end in 1..parts.len() {
            if paths.contains(&parts[..end].join("/")) {
                return Err("Projection file conflicts with a directory".into());
            }
        }
    }
    let (output, _) = output_root(root, project_id)?;
    if !inspect(&output, true)? {
        return Err("Projection output directory is unavailable".into());
    }
    ensure_directory(&output.join("markdown-projections"))?;
    let directory = project_directory(&output, project_id);
    ensure_directory(&directory)?;
    check_owner(root, &directory, true)?;
    let previous = read_owned_manifest(&directory, project_id)?;
    // Validate every existing path before changing any managed file.
    for entry in &entries {
        let path = prepare_path(&directory, &entry.path, false)?;
        if inspect(&path, false)?
            && !previous
                .as_ref()
                .is_some_and(|m| m.files.contains_key(&entry.path))
        {
            return Err("Output path contains a file not owned by this projection".into());
        }
    }
    if let Some(previous) = &previous {
        for path in previous.files.keys() {
            prepare_path(&directory, path, false)?;
        }
    }
    // Decide every authored file against what is on disk before changing any.
    // Bytes Drifting has not read are never replaced: an expected hash that no
    // longer matches is a conflict the renderer merges first. Without an
    // expectation (an upgrade from the read-only projection), edited bytes are
    // kept under .drifting/preserved before the file is replaced.
    let mut conflicts = Vec::new();
    let mut preserved = Vec::new();
    let mut keep: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for entry in entries.iter().filter(|entry| entry.authored) {
        let path = prepare_path(&directory, &entry.path, false)?;
        if !inspect(&path, false)? {
            continue;
        }
        let mut current = Vec::new();
        fs::File::open(&path)
            .map_err(|e| e.to_string())?
            .take(MAX_READ_BYTES + 1)
            .read_to_end(&mut current)
            .map_err(|e| e.to_string())?;
        let current_hash = sha256_hex(&current);
        if current_hash == sha256_hex(&entry.bytes) {
            continue;
        }
        let published = previous.as_ref().and_then(|m| m.files.get(&entry.path));
        match &entry.expected {
            Some(expected) if *expected == current_hash => {}
            Some(_) => conflicts.push(entry.path.clone()),
            None if published == Some(&current_hash) => {}
            None => {
                keep.insert(entry.path.clone(), current);
            }
        }
    }
    let files: BTreeMap<_, _> = entries
        .iter()
        .map(|entry| {
            let hash = if conflicts.contains(&entry.path) {
                previous
                    .as_ref()
                    .and_then(|m| m.files.get(&entry.path).cloned())
                    .unwrap_or_else(|| sha256_hex(&entry.bytes))
            } else {
                sha256_hex(&entry.bytes)
            };
            (entry.path.clone(), hash)
        })
        .collect();
    let authored: BTreeSet<String> = entries
        .iter()
        .filter(|entry| entry.authored)
        .map(|entry| entry.path.clone())
        .collect();
    if documents.len() > 20_000 {
        return Err("Too many projection document mappings".into());
    }
    let mut document_keys = HashSet::new();
    for document in &documents {
        validate_path(&document.path)?;
        if !files.contains_key(&document.path)
            || !document.path.ends_with(".md")
            || document.key.is_empty()
            || document.key.len() > 512
            || document.title.len() > 16_384
            || !document_keys.insert(&document.key)
            || document.anchor.as_ref().is_some_and(|anchor| {
                anchor.is_empty()
                    || anchor.len() > 2048
                    || !anchor
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            || document.source_version.as_ref().is_some_and(|version| {
                !version.strip_prefix("sha256:").is_some_and(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            })
        {
            return Err("Invalid projection document mapping".into());
        }
    }
    let mut manifest = Manifest {
        schema_version: 4,
        project_id: project_id.into(),
        generated_at: generated_at.clone(),
        read_only: false,
        reverse_sync: true,
        files: files.clone(),
        documents,
        authored: authored.clone(),
    };
    if serde_json::to_vec(&manifest)
        .map_err(|e| e.to_string())?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("Projection manifest exceeds size limit".into());
    }
    ensure_directory(&directory.join(".drifting"))?;
    // Existing paths are already owned by the published/pending manifest. Only
    // newly introduced paths need another durable claim before writing them.
    if files.keys().any(|path| {
        !previous
            .as_ref()
            .is_some_and(|m| m.files.contains_key(path))
    }) {
        manifest.files = previous
            .as_ref()
            .map(|m| m.files.clone())
            .unwrap_or_default();
        manifest.files.extend(files.clone());
        manifest.authored = previous
            .as_ref()
            .map(|m| m.authored.clone())
            .unwrap_or_default();
        manifest.authored.extend(authored.iter().cloned());
        atomic_write(
            &directory.join(PENDING),
            &{
                let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
                if bytes.len() > 8 * 1024 * 1024 {
                    return Err("Projection pending manifest exceeds size limit".into());
                }
                bytes
            },
            0o400,
        )?;
    }
    for entry in entries {
        if conflicts.contains(&entry.path) {
            continue;
        }
        let path = prepare_path(&directory, &entry.path, true)?;
        let mode = if entry.authored { 0o600 } else { 0o400 };
        // Compare actual bytes, so edits to generated files are repaired.
        if !inspect(&path, false)?
            || fs::metadata(&path).map_err(|e| e.to_string())?.len() != entry.bytes.len() as u64
            || fs::read(&path).map_err(|e| e.to_string())? != entry.bytes
        {
            if let Some(bytes) = keep.get(&entry.path) {
                preserve(&directory, &entry.path, bytes, &generated_at)?;
                preserved.push(entry.path.clone());
            }
            atomic_write(&path, &entry.bytes, mode)?;
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
                if meta.permissions().mode() & 0o777 != mode {
                    fs::set_permissions(&path, fs::Permissions::from_mode(mode))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let mut obsolete_directories = HashSet::new();
    if let Some(previous) = previous {
        for path in previous
            .files
            .keys()
            .filter(|path| !files.contains_key(*path))
        {
            let target = prepare_path(&directory, path, false)?;
            if inspect(&target, false)? {
                // An authored file Drifting no longer writes (renamed or
                // removed) may hold edits it has not read; keep a copy.
                if previous.authored.contains(path) {
                    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
                    if previous.files.get(path) != Some(&sha256_hex(&bytes)) {
                        preserve(&directory, path, &bytes, &generated_at)?;
                        preserved.push(path.clone());
                    }
                }
                fs::remove_file(&target).map_err(|e| e.to_string())?;
            }
            let mut parent = target.parent();
            while let Some(path) = parent {
                if path == directory {
                    break;
                }
                obsolete_directories.insert(path.to_path_buf());
                parent = path.parent();
            }
        }
    }
    let mut obsolete_directories: Vec<_> = obsolete_directories.into_iter().collect();
    obsolete_directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in obsolete_directories {
        let _ = fs::remove_dir(path);
    }
    manifest.files = files;
    manifest.authored = authored;
    atomic_write(
        &directory.join(MANIFEST),
        &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        0o400,
    )?;
    for name in [PENDING, "manifest.json", ".pending-manifest.json"] {
        let old = directory.join(name);
        if inspect(&old, false)? {
            fs::remove_file(old).map_err(|e| e.to_string())?;
        }
    }
    Ok(WriteResult {
        info: info(root, project_id)?,
        conflicts,
        preserved,
    })
}

fn remove_projection(root: &Path, project_id: &str) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    info(root, project_id)?;
    let directory = resolved_project_directory(root, project_id)?;
    let Some(manifest) = read_owned_manifest(&directory, project_id)? else {
        return forget_output_root(root, project_id);
    };
    let mut directories = HashSet::new();
    let mut files = Vec::new();
    for path in manifest.files.keys() {
        let target = prepare_path(&directory, path, false)?;
        let mut parent = target.parent();
        while let Some(path) = parent {
            if path == directory {
                break;
            }
            directories.insert(path.to_path_buf());
            parent = path.parent();
        }
        files.push(target);
    }
    for path in files {
        if inspect(&path, false)? {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    for name in MANIFEST_PATHS.into_iter().chain([OWNER]) {
        let path = directory.join(name);
        if inspect(&path, false)? {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    // Only empty managed directories are removed; user-created files survive.
    for path in directories {
        let _ = fs::remove_dir(path);
    }
    let _ = fs::remove_dir(directory.join(".drifting"));
    let _ = fs::remove_dir(directory);
    forget_output_root(root, project_id)
}

fn forget_output_root(root: &Path, project_id: &str) -> Result<(), String> {
    let mut settings = read_settings(root)?;
    if settings.roots.remove(project_id).is_some() {
        atomic_write(
            &root.join("markdown-projection-settings.json"),
            &serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
            0o400,
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn markdown_projection_remove(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || remove_projection(&root, &project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_info(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<ProjectionInfo, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || info(&root, &project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_set_output_root(
    app: tauri::AppHandle,
    project_id: String,
    custom_root: Option<String>,
) -> Result<ProjectionInfo, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || set_output_root(&root, &project_id, custom_root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_pick_output_root(
    app: tauri::AppHandle,
    title: String,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_dialog::DialogExt;
        tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title(title)
                .blocking_pick_folder()
                .map(|path| {
                    path.into_path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .map_err(|e| e.to_string())
                })
                .transpose()
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, title);
        Err("Markdown projection output settings require desktop".into())
    }
}

#[tauri::command]
pub async fn markdown_projection_write(
    app: tauri::AppHandle,
    project_id: String,
    generated_at: String,
    entries: Vec<Entry>,
    assets: Vec<Asset>,
    documents: Vec<Document>,
) -> Result<WriteResult, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        write_projection_with_documents(
            &root,
            &project_id,
            generated_at,
            entries,
            assets,
            documents,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads authored files back: stat only, unless size or time changed or `force`.
#[tauri::command]
pub async fn markdown_projection_read(
    app: tauri::AppHandle,
    project_id: String,
    requests: Vec<ReadRequest>,
) -> Result<Vec<ReadResult>, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || read_files(&root, &project_id, requests))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(path: &str, text: &str) -> Entry {
        Entry {
            path: path.into(),
            text: text.into(),
            authored: false,
            expected_sha256: None,
        }
    }
    #[test]
    fn readable_tree_upgrades_legacy_manifests_and_cleans_only_owned_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let directory = project_directory(root, "p");
        fs::create_dir_all(directory.join("project/chapters/id-old")).unwrap();
        fs::create_dir_all(directory.join(".obsidian")).unwrap();
        fs::write(directory.join(".obsidian/app.json"), "{}").unwrap();
        fs::write(directory.join("读者笔记.md"), "user-owned").unwrap();
        let legacy_path = "project/chapters/id-old/prose.md";
        fs::write(directory.join(legacy_path), "old prose").unwrap();
        let legacy = Manifest {
            schema_version: 2,
            project_id: "p".into(),
            generated_at: "old".into(),
            read_only: true,
            reverse_sync: false,
            files: BTreeMap::from([(
                legacy_path.into(),
                format!("{:x}", Sha256::digest(b"old prose")),
            )]),
            documents: vec![],
            authored: BTreeSet::new(),
        };
        atomic_write(
            &directory.join("manifest.json"),
            &serde_json::to_vec(&legacy).unwrap(),
            0o400,
        )
        .unwrap();
        let document = Document {
            key: "node:old".into(),
            title: "雨夜".into(),
            path: "正文/001 雨夜.md".into(),
            anchor: None,
            source_version: Some(format!("sha256:{:x}", Sha256::digest(b"old prose"))),
        };
        write_projection_with_documents(
            root,
            "p",
            "new".into(),
            vec![entry("正文/001 雨夜.md", "# 雨夜\n\nold prose")],
            vec![],
            vec![document],
        )
        .unwrap();
        assert!(!directory.join("project").exists());
        assert!(!directory.join("manifest.json").exists());
        assert!(directory.join(MANIFEST).exists());
        assert!(directory.join("读者笔记.md").exists());
        assert!(directory.join(".obsidian/app.json").exists());
        let manifest = read_manifest(&directory).unwrap().unwrap();
        assert_eq!(manifest.schema_version, 4);
        assert_eq!(manifest.documents[0].path, "正文/001 雨夜.md");
        // A renamed chapter replaces the old managed name without leaving empty folders.
        write_projection(
            root,
            "p",
            "renamed".into(),
            vec![entry("正文/002 来信.md", "next")],
        )
        .unwrap();
        assert!(!directory.join("正文/001 雨夜.md").exists());
        assert!(directory.join("正文/002 来信.md").exists());
        remove_projection(root, "p").unwrap();
        assert!(!directory.join(".drifting").exists());
        assert!(directory.join("读者笔记.md").exists());
    }

    #[test]
    #[cfg(unix)]
    fn hidden_metadata_rejects_symlinks_before_changing_the_readable_manuscript() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = temp.path();
        let directory = project_directory(root, "p");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("读者笔记.md"), "user-owned").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.join(".drifting")).unwrap();
        assert!(
            write_projection(root, "p", "bad".into(), vec![entry("开始阅读.md", "new")]).is_err()
        );
        assert!(!directory.join("开始阅读.md").exists());
        assert_eq!(
            fs::read_to_string(directory.join("读者笔记.md")).unwrap(),
            "user-owned"
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn readable_paths_reject_reserved_names_prefix_conflicts_and_case_collisions() {
        let temp = tempfile::tempdir().unwrap();
        for bad in [
            "正文/../bad.md",
            "正文/CON.md",
            "正文/.hidden.md",
            "正文/a?.md",
            "正文/a .md ",
        ] {
            assert!(
                write_projection(temp.path(), "p", "bad".into(), vec![entry(bad, "bad")]).is_err()
            );
        }
        for entries in [
            vec![entry("雨夜.md", "a"), entry("雨夜.md/子页.md", "b")],
            vec![entry("Hero.md", "a"), entry("hero.md", "b")],
        ] {
            assert!(write_projection(temp.path(), "p", "bad".into(), entries).is_err());
        }
        assert!(!project_directory(temp.path(), "p").exists());
    }

    fn asset(root: &Path, project: &str, id: &str, ext: &str, bytes: &[u8]) -> Asset {
        let directory = root.join("assets").join(project).join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(format!("source.{ext}")), bytes).unwrap();
        Asset {
            path: format!("project/assets/id-{id}/source.{ext}"),
            asset_id: id.into(),
            variant: AssetVariant::Source,
            ext: ext.into(),
            source_sha256: Some(format!("{:x}", Sha256::digest(bytes))),
            source_size_bytes: Some(bytes.len() as u64),
        }
    }

    #[test]
    fn attachments_are_verified_hashed_read_only_and_removed_without_touching_vault_settings() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let image = asset(root, "p", "image", "png", b"synthetic image bytes");
        let pdf = asset(root, "p", "document", "pdf", b"%PDF-1.4 synthetic test");
        let result = write_projection_with_assets(
            root,
            "p",
            "first".into(),
            vec![entry("index.md", "assets")],
            vec![image, pdf],
        )
        .unwrap();
        let directory = PathBuf::from(result.directory);
        let path = "project/assets/id-image/source.png";
        let file = directory.join(path);
        assert_eq!(fs::read(&file).unwrap(), b"synthetic image bytes");
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        let manifest = read_manifest(&directory).unwrap().unwrap();
        assert_eq!(
            manifest.files[path],
            format!("{:x}", Sha256::digest(b"synthetic image bytes"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o400
            );
        }
        fs::create_dir(directory.join(".obsidian")).unwrap();
        fs::write(directory.join(".obsidian/app.json"), "{}").unwrap();
        let image = asset(root, "p", "image", "png", b"synthetic image bytes");
        write_projection_with_assets(
            root,
            "p",
            "second".into(),
            vec![entry("index.md", "assets")],
            vec![image],
        )
        .unwrap();
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), modified);
        assert!(!directory
            .join("project/assets/id-document/source.pdf")
            .exists());
        remove_projection(root, "p").unwrap();
        assert!(directory.join(".obsidian/app.json").exists());
        assert!(!file.exists());
        assert!(root.join("assets/p/image/source.png").exists());
    }

    #[test]
    fn missing_corrupt_or_unowned_attachments_never_replace_the_previous_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let result = write_projection(
            root,
            "p",
            "first".into(),
            vec![entry("index.md", "previous")],
        )
        .unwrap();
        let directory = PathBuf::from(result.directory);
        for failure in ["missing", "corrupt", "collision"] {
            let mut image = asset(root, "p", "image", "png", b"synthetic image");
            match failure {
                "missing" => fs::remove_file(root.join("assets/p/image/source.png")).unwrap(),
                "corrupt" => image.source_sha256 = Some("0".repeat(64)),
                _ => {
                    let target = directory.join("project/assets/id-image");
                    fs::create_dir_all(&target).unwrap();
                    fs::write(target.join("source.png"), "user file").unwrap();
                }
            }
            assert!(write_projection_with_assets(
                root,
                "p",
                "bad".into(),
                vec![entry("index.md", "changed")],
                vec![image]
            )
            .is_err());
            assert_eq!(
                fs::read_to_string(directory.join("index.md")).unwrap(),
                "previous"
            );
            assert_eq!(
                read_manifest(&directory).unwrap().unwrap().generated_at,
                "first"
            );
        }
    }

    #[test]
    fn unsupported_image_previews_copy_only_from_the_project_owned_display_variant() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let original = asset(root, "p", "image", "heic", b"synthetic HEIC");
        fs::write(root.join("assets/p/image/display.jpg"), b"synthetic JPEG").unwrap();
        let preview = Asset {
            path: "project/assets/id-image/display.jpg".into(),
            asset_id: "image".into(),
            variant: AssetVariant::Display,
            ext: "jpg".into(),
            source_sha256: None,
            source_size_bytes: None,
        };
        let result = write_projection_with_assets(
            root,
            "p",
            "first".into(),
            vec![entry("index.md", "preview")],
            vec![original, preview],
        )
        .unwrap();
        assert_eq!(
            fs::read(Path::new(&result.directory).join("project/assets/id-image/display.jpg"))
                .unwrap(),
            b"synthetic JPEG"
        );
    }

    #[test]
    #[cfg(unix)]
    fn source_assets_reject_symlinks_and_hardlinks_before_modifying_managed_output() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let image = asset(root, "p", "image", "png", b"synthetic image");
        let source = root.join("assets/p/image/source.png");
        let outside = root.join("outside.png");
        fs::rename(&source, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &source).unwrap();
        assert!(
            write_projection_with_assets(root, "p", "bad".into(), vec![], vec![image]).is_err()
        );
        fs::remove_file(&source).unwrap();
        fs::hard_link(&outside, &source).unwrap();
        let image = Asset {
            path: "project/assets/id-image/source.png".into(),
            asset_id: "image".into(),
            variant: AssetVariant::Source,
            ext: "png".into(),
            source_sha256: Some(format!("{:x}", Sha256::digest(b"synthetic image"))),
            source_size_bytes: Some(15),
        };
        assert!(
            write_projection_with_assets(root, "p", "bad".into(), vec![], vec![image]).is_err()
        );
        assert!(!project_directory(root, "p").exists());
        assert_eq!(fs::read(outside).unwrap(), b"synthetic image");
    }

    #[test]
    fn custom_output_persists_per_project_resets_and_preserves_old_snapshots() {
        let local = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        let root = local.path();
        let original =
            write_projection(root, "p", "first".into(), vec![entry("prose.md", "old")]).unwrap();
        let selected = set_output_root(
            root,
            "p",
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap();
        assert_eq!(
            selected.custom_root,
            Some(
                fs::canonicalize(custom.path())
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert_eq!(selected.generated_at, None);
        // Fresh reads resolve persisted settings without renderer/in-memory state.
        assert_eq!(info(root, "p").unwrap().directory, selected.directory);
        assert_eq!(
            resolved_project_directory(root, "p").unwrap(),
            PathBuf::from(&selected.directory)
        );
        assert_eq!(
            info(root, "other").unwrap().directory,
            project_directory(root, "other").to_string_lossy()
        );
        fs::write(custom.path().join("notes.md"), "user file").unwrap();
        write_projection(root, "p", "second".into(), vec![entry("prose.md", "new")]).unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&selected.directory).join("prose.md")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&original.directory).join("prose.md")).unwrap(),
            "old"
        );
        let reset = set_output_root(root, "p", None).unwrap();
        assert_eq!(reset.directory, original.directory);
        assert_eq!(reset.custom_root, None);
        assert!(Path::new(&selected.directory).join("prose.md").exists());
        set_output_root(
            root,
            "p",
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap();
        fs::write(Path::new(&selected.directory).join("user.md"), "unmanaged").unwrap();
        remove_projection(root, "p").unwrap();
        assert!(!Path::new(&selected.directory).join("prose.md").exists());
        assert!(Path::new(&selected.directory).join("user.md").exists());
        assert!(Path::new(&original.directory).join("prose.md").exists());
        assert_eq!(
            fs::read_to_string(custom.path().join("notes.md")).unwrap(),
            "user file"
        );
        assert!(read_settings(root).unwrap().roots.is_empty());
    }

    #[test]
    fn output_selection_rejects_unowned_directory_and_keeps_previous_location() {
        let local = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        let root = local.path();
        let target = project_directory(custom.path(), "p");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("README.md"), "belongs to user").unwrap();
        assert!(set_output_root(
            root,
            "p",
            Some(custom.path().to_string_lossy().into_owned())
        )
        .is_err());
        assert!(set_output_root(root, "p", Some("relative/path".into())).is_err());
        assert_eq!(info(root, "p").unwrap().custom_root, None);
        assert_eq!(
            fs::read_to_string(target.join("README.md")).unwrap(),
            "belongs to user"
        );
        fs::remove_file(target.join("README.md")).unwrap();
        let wrong_manifest = Manifest {
            documents: vec![],
            schema_version: 1,
            project_id: "other".into(),
            generated_at: "old".into(),
            read_only: true,
            reverse_sync: false,
            files: BTreeMap::new(),
            authored: BTreeSet::new(),
        };
        fs::write(
            target.join("manifest.json"),
            serde_json::to_vec(&wrong_manifest).unwrap(),
        )
        .unwrap();
        assert!(set_output_root(
            root,
            "p",
            Some(custom.path().to_string_lossy().into_owned())
        )
        .is_err());
        assert_eq!(info(root, "p").unwrap().custom_root, None);
    }

    #[test]
    fn unavailable_custom_output_does_not_fallback_and_can_be_reset() {
        let local = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        set_output_root(
            local.path(),
            "p",
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap();
        custom.close().unwrap();
        assert!(info(local.path(), "p").unwrap().custom_root.is_some());
        assert!(write_projection(
            local.path(),
            "p",
            "now".into(),
            vec![entry("prose.md", "text")]
        )
        .is_err());
        assert!(!project_directory(local.path(), "p").exists());
        assert!(set_output_root(local.path(), "p", None)
            .unwrap()
            .custom_root
            .is_none());
        write_projection(
            local.path(),
            "p",
            "now".into(),
            vec![entry("prose.md", "text")],
        )
        .unwrap();
    }

    #[test]
    fn refresh_rejects_new_unowned_file_before_changing_managed_prose() {
        let local = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        let selected = set_output_root(
            local.path(),
            "p",
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap();
        write_projection(
            local.path(),
            "p",
            "now".into(),
            vec![entry("prose.md", "first")],
        )
        .unwrap();
        let directory = Path::new(&selected.directory);
        fs::write(directory.join("new.md"), "user file").unwrap();
        assert!(write_projection(
            local.path(),
            "p",
            "next".into(),
            vec![entry("prose.md", "second"), entry("new.md", "generated")]
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(directory.join("prose.md")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(directory.join("new.md")).unwrap(),
            "user file"
        );
    }

    #[test]
    fn interrupted_projection_claims_can_be_retried_and_cleaned_up() {
        let local = tempfile::tempdir().unwrap();
        write_projection(
            local.path(),
            "p",
            "first".into(),
            vec![entry("prose.md", "first")],
        )
        .unwrap();
        let directory = project_directory(local.path(), "p");
        let mut interrupted = read_manifest(&directory).unwrap().unwrap();
        interrupted
            .files
            .insert("new.md".into(), "pending hash".into());
        atomic_write(
            &directory.join(".pending-manifest.json"),
            &serde_json::to_vec(&interrupted).unwrap(),
            0o400,
        )
        .unwrap();
        fs::write(directory.join("new.md"), "partially generated").unwrap();
        write_projection(
            local.path(),
            "p",
            "next".into(),
            vec![entry("prose.md", "updated"), entry("new.md", "complete")],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("new.md")).unwrap(),
            "complete"
        );
        assert!(!directory.join(".pending-manifest.json").exists());
        // Also cover an interrupted first generation without a published manifest.
        fs::remove_file(directory.join(MANIFEST)).unwrap();
        atomic_write(
            &directory.join(".pending-manifest.json"),
            &serde_json::to_vec(&interrupted).unwrap(),
            0o400,
        )
        .unwrap();
        remove_projection(local.path(), "p").unwrap();
        assert!(!directory.exists());
    }

    #[test]
    #[cfg(unix)]
    fn output_selection_rejects_symlinked_managed_directory() {
        let local = tempfile::tempdir().unwrap();
        let custom = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), custom.path().join("markdown-projections"))
            .unwrap();
        assert!(set_output_root(
            local.path(),
            "p",
            Some(custom.path().to_string_lossy().into_owned())
        )
        .is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(info(local.path(), "p").unwrap().custom_root, None);
    }
    #[test]
    fn markdown_projection_is_incremental_read_only_and_removes_only_owned_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let project = "synthetic-project";
        let result = write_projection(
            root,
            project,
            "first".into(),
            vec![entry("chapters/a/prose.md", "雨😀"), entry("old.md", "old")],
        )
        .unwrap();
        let directory = PathBuf::from(result.directory);
        let body = directory.join("chapters/a/prose.md");
        let before = fs::metadata(&body).unwrap().modified().unwrap();
        fs::write(directory.join("user.md"), "unmanaged").unwrap();
        write_projection(
            root,
            project,
            "second".into(),
            vec![entry("chapters/a/prose.md", "雨😀")],
        )
        .unwrap();
        assert_eq!(fs::metadata(&body).unwrap().modified().unwrap(), before);
        assert!(!directory.join("old.md").exists());
        assert!(directory.join("user.md").exists());
        let manifest = read_manifest(&directory).unwrap().unwrap();
        assert!(!manifest.read_only && manifest.reverse_sync);
        assert!(manifest.authored.is_empty());
        assert_eq!(
            manifest.files["chapters/a/prose.md"],
            format!("{:x}", Sha256::digest("雨😀".as_bytes()))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&body).unwrap().permissions().mode() & 0o777,
                0o400
            );
        }
        remove_projection(root, project).unwrap();
        assert!(!body.exists());
        assert!(directory.join("user.md").exists());
        assert!(!directory.join("manifest.json").exists());
    }
    #[test]
    fn markdown_projection_rejects_unsafe_paths_and_duplicates_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        for bad in [
            "../bad.md",
            "/bad.md",
            "x/../../bad.md",
            "x\\bad.md",
            "x//bad.md",
        ] {
            assert!(
                write_projection(temp.path(), "p", "now".into(), vec![entry(bad, "bad")]).is_err()
            );
        }
        assert!(write_projection(
            temp.path(),
            "p",
            "now".into(),
            vec![entry("a.md", "1"), entry("a.md", "2")]
        )
        .is_err());
    }
    #[test]
    #[cfg(unix)]
    fn markdown_projection_rejects_symlink_parent_and_preserves_external_target() {
        let temp = tempfile::tempdir().unwrap();
        write_projection(temp.path(), "p", "now".into(), vec![entry("ok.md", "safe")]).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            project_directory(temp.path(), "p").join("linked"),
        )
        .unwrap();
        assert!(write_projection(
            temp.path(),
            "p",
            "next".into(),
            vec![entry("ok.md", "changed"), entry("linked/prose.md", "bad")]
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(project_directory(temp.path(), "p").join("ok.md")).unwrap(),
            "safe"
        );
        assert!(!outside.path().join("prose.md").exists());
    }

    fn authored(path: &str, text: &str, expected: Option<&str>) -> Entry {
        Entry {
            path: path.into(),
            text: text.into(),
            authored: true,
            expected_sha256: expected.map(|bytes| sha256_hex(bytes.as_bytes())),
        }
    }

    fn write_authored(root: &Path, entries: Vec<Entry>, stamp: &str) -> WriteResult {
        write_projection_with_documents(root, "p", stamp.into(), entries, vec![], vec![]).unwrap()
    }

    #[cfg(unix)]
    fn edit(path: &Path, text: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn authored_files_are_writable_and_never_replace_unread_edits() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let chapter = "正文/001 雨夜.md";
        let first = write_authored(
            root,
            vec![authored(chapter, "A", None), entry("开始阅读.md", "home")],
            "first",
        );
        let directory = PathBuf::from(first.info.directory);
        let file = directory.join(chapter);
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(directory.join("开始阅读.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o400
        );
        let manifest = read_manifest(&directory).unwrap().unwrap();
        assert_eq!(manifest.schema_version, 4);
        assert!(manifest.authored.contains(chapter));

        fs::write(&file, "B").unwrap();
        let stale = write_authored(root, vec![authored(chapter, "C", Some("A"))], "second");
        assert_eq!(stale.conflicts, vec![chapter.to_string()]);
        assert_eq!(fs::read_to_string(&file).unwrap(), "B");
        assert_eq!(
            read_manifest(&directory).unwrap().unwrap().files[chapter],
            sha256_hex(b"A")
        );

        let merged = write_authored(root, vec![authored(chapter, "C", Some("B"))], "third");
        assert!(merged.conflicts.is_empty() && merged.preserved.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "C");
    }

    #[test]
    #[cfg(unix)]
    fn upgrading_a_read_only_projection_keeps_edited_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let untouched = "正文/001 雨夜.md";
        let edited = "正文/002 晨雾.md";
        let info = write_projection(
            root,
            "p",
            "old".into(),
            vec![entry(untouched, "old one"), entry(edited, "old two")],
        )
        .unwrap();
        let directory = PathBuf::from(info.directory);
        edit(&directory.join(edited), "author two");

        let result = write_authored(
            root,
            vec![
                authored(untouched, "new one", None),
                authored(edited, "new two", None),
            ],
            "2026-10-31T00:00:00.000Z",
        );
        assert_eq!(result.preserved, vec![edited.to_string()]);
        assert_eq!(
            fs::read_to_string(directory.join(edited)).unwrap(),
            "new two"
        );
        assert_eq!(
            fs::read_to_string(
                directory
                    .join(PRESERVED)
                    .join("2026-10-31T00-00-00-000Z")
                    .join(edited)
            )
            .unwrap(),
            "author two"
        );
        assert_eq!(
            fs::read_to_string(directory.join(untouched)).unwrap(),
            "new one"
        );
    }

    #[test]
    #[cfg(unix)]
    fn an_abandoned_authored_file_with_unread_edits_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let first = write_authored(root, vec![authored("正文/001 雨夜.md", "A", None)], "one");
        let directory = PathBuf::from(first.info.directory);
        edit(&directory.join("正文/001 雨夜.md"), "edited");
        let renamed = write_authored(root, vec![authored("正文/001 夜雨.md", "A", None)], "two");
        assert_eq!(renamed.preserved, vec!["正文/001 雨夜.md".to_string()]);
        assert!(!directory.join("正文/001 雨夜.md").exists());
        assert_eq!(
            fs::read_to_string(directory.join(PRESERVED).join("two/正文/001 雨夜.md")).unwrap(),
            "edited"
        );
    }

    #[test]
    #[cfg(unix)]
    fn authored_files_are_read_back_by_stat_then_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let chapter = "正文/001 雨夜.md";
        let info = write_authored(root, vec![authored(chapter, "雨", None)], "one").info;
        let directory = PathBuf::from(info.directory);
        let request = |known_size, known_modified_ms, force| ReadRequest {
            path: chapter.into(),
            known_size,
            known_modified_ms,
            force,
        };
        let first = read_files(root, "p", vec![request(None, None, false)]).unwrap();
        assert!(first[0].exists && first[0].changed);
        assert_eq!(first[0].text.as_deref(), Some("雨"));
        assert_eq!(first[0].sha256, Some(sha256_hex("雨".as_bytes())));

        let (size, modified) = (first[0].size, first[0].modified_ms);
        let same = read_files(root, "p", vec![request(Some(size), Some(modified), false)]).unwrap();
        assert!(!same[0].changed && same[0].text.is_none());
        let forced = read_files(root, "p", vec![request(Some(size), Some(modified), true)]).unwrap();
        assert_eq!(forced[0].text.as_deref(), Some("雨"));

        edit(&directory.join(chapter), "雨夜");
        let edited = read_files(root, "p", vec![request(Some(size), Some(modified), false)]).unwrap();
        assert!(edited[0].changed);
        assert_eq!(edited[0].text.as_deref(), Some("雨夜"));

        fs::write(directory.join(chapter), [0xff, 0xfe, 0x00]).unwrap();
        let invalid = read_files(root, "p", vec![request(None, None, true)]).unwrap();
        assert_eq!(invalid[0].error.as_deref(), Some("encoding"));
        assert!(invalid[0].text.is_none());

        fs::remove_file(directory.join(chapter)).unwrap();
        let missing = read_files(root, "p", vec![request(Some(size), Some(modified), false)]).unwrap();
        assert!(!missing[0].exists && missing[0].changed);
        assert!(read_files(root, "p", vec![ReadRequest {
            path: "../escape.md".into(),
            known_size: None,
            known_modified_ms: None,
            force: true,
        }])
        .is_err());
    }

    #[test]
    fn a_folder_managed_by_another_installation_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let info = write_authored(root, vec![authored("正文/001 雨夜.md", "A", None)], "one").info;
        let directory = PathBuf::from(info.directory);
        fs::remove_file(directory.join(OWNER)).unwrap();
        fs::write(
            directory.join(OWNER),
            serde_json::to_vec(&Owner {
                instance: "0".repeat(32),
            })
            .unwrap(),
        )
        .unwrap();
        let error = write_projection_with_documents(
            root,
            "p",
            "two".into(),
            vec![authored("正文/001 雨夜.md", "B", None)],
            vec![],
            vec![],
        )
        .err()
        .unwrap();
        assert!(error.contains("another Drifting installation"));
        assert!(read_files(
            root,
            "p",
            vec![ReadRequest {
                path: "正文/001 雨夜.md".into(),
                known_size: None,
                known_modified_ms: None,
                force: true,
            }]
        )
        .is_err());
        assert_eq!(fs::read_to_string(directory.join("正文/001 雨夜.md")).unwrap(), "A");
    }
}
