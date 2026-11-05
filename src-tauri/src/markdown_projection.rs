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
    /// None while the project follows all projects and no location is chosen.
    directory: Option<String>,
    custom_root: Option<String>,
    generated_at: Option<String>,
    read_only: bool,
    reverse_sync: bool,
    /// False once the author turned the folder off: nothing is written or read back.
    enabled: bool,
}

/// Where projects without a location of their own are written, and whether
/// the folder is on at all. Device-local, like each project's own location.
/// There is no default: until the author chooses, nothing is written.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSettings {
    /// Holds the folder of every project without a location of its own.
    directory: Option<String>,
    /// The location the author chose; None until one is chosen.
    root: Option<String>,
    enabled: bool,
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

/// A project's folder before it is named after its book (and in builds from
/// before folders had names): the SHA-256 of its ID.
pub fn project_directory(root: &Path, project_id: &str) -> PathBuf {
    root.join("markdown-projections")
        .join(hashed_name(project_id))
}

fn hashed_name(project_id: &str) -> String {
    format!("{:x}", Sha256::digest(project_id.as_bytes()))
}

/// The project's folder under `output`, named after its book once named.
fn named_directory(settings: &OutputSettings, output: &Path, project_id: &str) -> PathBuf {
    match settings.folders.get(project_id) {
        Some(name) => output.join("markdown-projections").join(name),
        None => project_directory(output, project_id),
    }
}

const SETTINGS: &str = "markdown-projection-settings.json";
const TURNED_OFF: &str = "The Markdown folder is turned off";
/// A project follows all projects and the author has not chosen where they go.
pub(crate) const NO_LOCATION: &str = "No location is chosen for the Markdown folder";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputSettings {
    roots: BTreeMap<String, PathBuf>,
    /// Each project's folder name: its book's title, or the title with ` 2`,
    /// ` 3`… when another folder had it first.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    folders: BTreeMap<String, String>,
    /// Where a project without a location of its own is written. There is no
    /// default: unset, such a project is not written at all (but see
    /// `default_location` for devices that wrote before this rule).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    disabled: bool,
}

// Device-local paths must never enter project data or authored sync settings.
fn read_settings(root: &Path) -> Result<OutputSettings, String> {
    inspect(root, true)?;
    let path = root.join(SETTINGS);
    if !inspect(&path, false)? {
        return Ok(OutputSettings::default());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("Projection settings exceed size limit".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid projection output settings".into())
}

fn write_settings(root: &Path, settings: &OutputSettings) -> Result<(), String> {
    atomic_write(
        &root.join(SETTINGS),
        &serde_json::to_vec(settings).map_err(|e| e.to_string())?,
        0o400,
    )
}

/// A chosen location is never silently replaced by another one: once it is
/// gone or moved, writing fails until the author chooses again or resets.
fn chosen_root(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || (inspect(path, true)? && fs::canonicalize(path).map_err(|e| e.to_string())? != path)
    {
        return Err("Custom projection output directory is unavailable".into());
    }
    Ok(())
}

fn selected_directory(path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !inspect(&path, true)? {
        return Err("Select an existing absolute output directory".into());
    }
    fs::canonicalize(path).map_err(|e| e.to_string())
}

/// Where projects without a location of their own go, if anywhere. Until
/// 2026-11-06 a device that had not chosen wrote under the app's data folder;
/// once that folder holds projects it stays this device's location.
fn default_location(settings: &OutputSettings, root: &Path) -> Result<Option<PathBuf>, String> {
    match &settings.default_root {
        Some(chosen) => Ok(Some(chosen.clone())),
        None if inspect(&root.join("markdown-projections"), true)? => Ok(Some(root.to_path_buf())),
        None => Ok(None),
    }
}

fn default_output(settings: &OutputSettings, root: &Path) -> Result<PathBuf, String> {
    match &settings.default_root {
        Some(chosen) => {
            chosen_root(chosen)?;
            Ok(chosen.clone())
        }
        None => default_location(settings, root)?.ok_or_else(|| NO_LOCATION.into()),
    }
}

/// Whether the project has somewhere to go: its own location or the one
/// chosen for all projects.
fn located(settings: &OutputSettings, root: &Path, project_id: &str) -> Result<bool, String> {
    Ok(settings.roots.contains_key(project_id) || default_location(settings, root)?.is_some())
}

/// The project's own location, else the one chosen for all projects;
/// `NO_LOCATION` when neither is set. The label names a location chosen for
/// this project.
fn output_root_in(
    settings: &OutputSettings,
    root: &Path,
    project_id: &str,
) -> Result<(PathBuf, Option<String>), String> {
    validate_project(project_id)?;
    match settings.roots.get(project_id) {
        Some(custom) => {
            chosen_root(custom)?;
            Ok((custom.clone(), Some(custom.to_string_lossy().into_owned())))
        }
        None => Ok((default_output(settings, root)?, None)),
    }
}

fn output_root(root: &Path, project_id: &str) -> Result<(PathBuf, Option<String>), String> {
    output_root_in(&read_settings(root)?, root, project_id)
}

pub fn resolved_project_directory(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    let settings = read_settings(root)?;
    let (output, _) = output_root_in(&settings, root, project_id)?;
    Ok(named_directory(&settings, &output, project_id))
}

/// Whether the author left the folder on; an unreadable setting counts as on.
/// Read by the macOS-only local MCP bridge.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn folder_enabled(root: &Path) -> bool {
    read_settings(root).map_or(true, |settings| !settings.disabled)
}

fn probe_writable(directory: &Path) -> Result<(), String> {
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
    fs::remove_file(probe).map_err(|e| e.to_string())
}

fn folder_settings_in(settings: &OutputSettings, root: &Path) -> Result<FolderSettings, String> {
    let location = default_location(settings, root)?;
    Ok(FolderSettings {
        directory: location.as_ref().map(|path| {
            path.join("markdown-projections")
                .to_string_lossy()
                .into_owned()
        }),
        root: location.map(|path| path.to_string_lossy().into_owned()),
        enabled: !settings.disabled,
    })
}

fn folder_settings(root: &Path) -> Result<FolderSettings, String> {
    folder_settings_in(&read_settings(root)?, root)
}

/// Chooses where projects without a location of their own are written. Their
/// folders at the old location stay where they are.
pub(crate) fn set_default_root(root: &Path, location: String) -> Result<FolderSettings, String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    let mut settings = read_settings(root)?;
    let selected = selected_directory(location)?;
    let parent = selected.join("markdown-projections");
    ensure_directory(&parent)?;
    // Check writability before persisting a new location.
    probe_writable(&parent)?;
    settings.default_root = Some(selected);
    write_settings(root, &settings)?;
    folder_settings_in(&settings, root)
}

/// Turning the folder off keeps its files where they are; turning it back on
/// merges whatever was edited there meanwhile.
pub(crate) fn set_enabled(root: &Path, enabled: bool) -> Result<FolderSettings, String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    let mut settings = read_settings(root)?;
    settings.disabled = !enabled;
    write_settings(root, &settings)?;
    folder_settings_in(&settings, root)
}

/// The project's folder once it was written, else the folder holding projects.
fn folder_to_open(root: &Path, project_id: Option<&str>) -> Result<PathBuf, String> {
    let settings = read_settings(root)?;
    if let Some(project_id) = project_id {
        if located(&settings, root, project_id)? {
            let (output, _) = output_root_in(&settings, root, project_id)?;
            let directory = named_directory(&settings, &output, project_id);
            if inspect(&directory, true)? {
                return Ok(directory);
            }
        }
    }
    let output = default_output(&settings, root)?;
    if !inspect(&output, true)? {
        return Err("Projection output directory is unavailable".into());
    }
    let directory = output.join("markdown-projections");
    ensure_directory(&directory)?;
    Ok(directory)
}

pub(crate) fn set_output_root(
    root: &Path,
    project_id: &str,
    custom_root: Option<String>,
) -> Result<ProjectionInfo, String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    validate_project(project_id)?;
    let mut settings = read_settings(root)?;
    let selected = custom_root.map(selected_directory).transpose()?;
    if selected.is_none() && default_location(&settings, root)?.is_none() {
        // Following all projects, which have no location yet: nothing to write.
        settings.roots.remove(project_id);
        write_settings(root, &settings)?;
        return Ok(unlocated(!settings.disabled));
    }
    let output = match &selected {
        Some(path) => path.clone(),
        None => default_output(&settings, root)?,
    };
    let output = output.as_path();
    let mut result = info_at(
        output,
        &named_directory(&settings, output, project_id),
        project_id,
        selected.as_ref().map(|p| p.to_string_lossy().into_owned()),
    )?;
    result.enabled = !settings.disabled;
    // A folder of that name already there is someone else's: the next
    // capture names this project's folder around it.
    let parent = output.join("markdown-projections");
    ensure_directory(&parent)?;
    // Check writability before persisting a new location; never touch old output.
    probe_writable(&parent)?;
    if let Some(selected) = selected {
        settings.roots.insert(project_id.into(), selected);
    } else {
        settings.roots.remove(project_id);
    }
    write_settings(root, &settings)?;
    Ok(result)
}

#[derive(PartialEq)]
enum Occupant {
    /// Missing, or holding nothing but Drifting's own bookkeeping.
    Vacant,
    Ours,
    Taken,
}

/// Who holds a folder: a manifest names its project; anything else in it,
/// or anything unreadable, makes it someone else's.
fn occupant(directory: &Path, project_id: &str) -> Occupant {
    match inspect(directory, true) {
        Ok(false) => return Occupant::Vacant,
        Ok(true) => {}
        Err(_) => return Occupant::Taken,
    }
    for name in MANIFEST_PATHS {
        match read_manifest_file(directory, name) {
            Ok(None) => {}
            Ok(Some(manifest)) if manifest.project_id == project_id => return Occupant::Ours,
            _ => return Occupant::Taken,
        }
    }
    match fs::read_dir(directory) {
        Ok(mut entries) => {
            if entries.any(|entry| entry.map_or(true, |entry| entry.file_name() != ".drifting")) {
                Occupant::Taken
            } else {
                Occupant::Vacant
            }
        }
        Err(_) => Occupant::Taken,
    }
}

/// A folder name is one path part under the rules for file names.
fn validate_folder_name(name: &str) -> Result<(), String> {
    if name.contains('/') || validate_path(&format!("{name}/a.md")).is_err() {
        return Err("Unsafe Markdown folder name".into());
    }
    Ok(())
}

/// `name` is the title, or the title with the number another folder forced.
fn numbered(name: &str, title: &str) -> bool {
    name == title
        || name
            .strip_prefix(title)
            .and_then(|rest| rest.strip_prefix(' '))
            .and_then(|digits| {
                digits
                    .parse::<u32>()
                    .ok()
                    .filter(|number| *number >= 2 && number.to_string() == digits)
            })
            .is_some()
}

fn same_directory(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    // Windows has no stable file identity in std; GetFinalPathNameByHandleW
    // (behind canonicalize) spells one folder one way, whatever letter case
    // reached it, so a case-only rename is recognized as the same folder.
    #[cfg(not(unix))]
    {
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedFolder {
    #[serde(flatten)]
    info: ProjectionInfo,
    /// Where the folder was before this call renamed it.
    previous_directory: Option<String>,
}

/// Names the project's folder after its book. When another folder already
/// has the title, the name takes ` 2`, ` 3`…, and keeps that number while the
/// title stays. The folder written under its old name (or, from before folders
/// had names, its hashed ID) is renamed in place, files and bookkeeping
/// together; one that cannot move is left where it is.
pub(crate) fn name_folder(
    root: &Path,
    project_id: &str,
    title: &str,
) -> Result<NamedFolder, String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    validate_project(project_id)?;
    validate_folder_name(title)?;
    let mut settings = read_settings(root)?;
    if settings.disabled || !located(&settings, root, project_id)? {
        return Ok(NamedFolder {
            info: info(root, project_id)?,
            previous_directory: None,
        });
    }
    let (output, custom_root) = output_root_in(&settings, root, project_id)?;
    if !inspect(&output, true)? {
        return Err("Projection output directory is unavailable".into());
    }
    let parent = output.join("markdown-projections");
    let current = settings.folders.get(project_id).cloned();
    let written = current
        .iter()
        .cloned()
        .chain([hashed_name(project_id)])
        .map(|name| parent.join(name))
        .find(|directory| occupant(directory, project_id) == Occupant::Ours);
    let free = |name: &str| occupant(&parent.join(name), project_id) != Occupant::Taken;
    let name = match current.filter(|name| numbered(name, title) && free(name)) {
        Some(name) => name,
        None => (1..=1000)
            .map(|number| match number {
                1 => title.to_owned(),
                _ => format!("{title} {number}"),
            })
            .find(|name| validate_folder_name(name).is_ok() && free(name))
            .ok_or("No free Markdown folder name")?,
    };
    let directory = parent.join(&name);
    let mut previous_directory = None;
    if let Some(written) = written.filter(|written| *written != directory) {
        // Onto a missing or empty folder, or the same one in other letter case.
        let onto = !inspect(&directory, true)?
            || same_directory(&written, &directory)
            || fs::read_dir(&directory)
                .map_err(|e| e.to_string())?
                .next()
                .is_none();
        if onto {
            fs::rename(&written, &directory).map_err(|e| e.to_string())?;
            previous_directory = Some(written.to_string_lossy().into_owned());
        }
    }
    if settings.folders.get(project_id) != Some(&name) {
        settings.folders.insert(project_id.into(), name);
        write_settings(root, &settings)?;
    }
    Ok(NamedFolder {
        info: info_at(&output, &directory, project_id, custom_root)?,
        previous_directory,
    })
}

fn validate_project(project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > 256 {
        return Err("Invalid projection project".into());
    }
    Ok(())
}

// Directories that hold app-owned attachment copies. Mirrors written before
// 2026-11-05 kept them in 资料/附件/; that prefix still validates so an older
// manifest can be read and the next write removes those files.
const ATTACHMENT_DIRECTORIES: [&str; 3] = ["project/assets/id-", "素材/附件/", "资料/附件/"];

fn in_attachment_directory(path: &str) -> bool {
    ATTACHMENT_DIRECTORIES
        .iter()
        .any(|directory| path.starts_with(directory))
}

fn validate_path(path: &str) -> Result<(), String> {
    let attachment = in_attachment_directory(path)
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

/// A project with nowhere to go: nothing is written or read until a location is chosen.
fn unlocated(enabled: bool) -> ProjectionInfo {
    ProjectionInfo {
        directory: None,
        custom_root: None,
        generated_at: None,
        read_only: false,
        reverse_sync: true,
        enabled,
    }
}

fn info(root: &Path, project_id: &str) -> Result<ProjectionInfo, String> {
    let settings = read_settings(root)?;
    validate_project(project_id)?;
    if settings.disabled {
        // Nothing at the location is read while off, so it may even be gone.
        let custom = settings.roots.get(project_id);
        let Some(output) = custom.cloned().or(default_location(&settings, root)?) else {
            return Ok(unlocated(false));
        };
        return Ok(ProjectionInfo {
            directory: Some(
                named_directory(&settings, &output, project_id)
                    .to_string_lossy()
                    .into_owned(),
            ),
            custom_root: custom.map(|path| path.to_string_lossy().into_owned()),
            generated_at: None,
            read_only: false,
            reverse_sync: true,
            enabled: false,
        });
    }
    if !located(&settings, root, project_id)? {
        return Ok(unlocated(true));
    }
    let (output, custom_root) = output_root_in(&settings, root, project_id)?;
    let directory = named_directory(&settings, &output, project_id);
    info_at(&output, &directory, project_id, custom_root)
}

fn info_at(
    root: &Path,
    directory: &Path,
    project_id: &str,
    custom_root: Option<String>,
) -> Result<ProjectionInfo, String> {
    validate_project(project_id)?;
    inspect(root, true)?;
    inspect(&root.join("markdown-projections"), true)?;
    // Another project's folder of the same name reports no capture yet; the
    // next capture names this one around it, and a write never enters it.
    let manifest = match occupant(directory, project_id) {
        Occupant::Ours => read_manifest(directory)?,
        _ => None,
    };
    Ok(ProjectionInfo {
        directory: Some(directory.to_string_lossy().into_owned()),
        custom_root,
        generated_at: manifest.map(|m| m.generated_at),
        read_only: false,
        reverse_sync: true,
        enabled: true,
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
            return Err("This Markdown folder is managed by another Drifting installation".into());
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
    let settings = read_settings(root)?;
    if settings.disabled {
        return Err(TURNED_OFF.into());
    }
    let (output, _) = output_root_in(&settings, root, project_id)?;
    let directory = named_directory(&settings, &output, project_id);
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
        if !in_attachment_directory(&asset.path) || !ASSET_EXTENSIONS.contains(&asset.ext.as_str())
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
    let settings = read_settings(root)?;
    if settings.disabled {
        return Err(TURNED_OFF.into());
    }
    let (output, _) = output_root_in(&settings, root, project_id)?;
    if !inspect(&output, true)? {
        return Err("Projection output directory is unavailable".into());
    }
    ensure_directory(&output.join("markdown-projections"))?;
    let directory = named_directory(&settings, &output, project_id);
    if occupant(&directory, project_id) == Occupant::Taken {
        return Err("Output directory contains files not owned by this projection".into());
    }
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
    if info(root, project_id)?.directory.is_none() {
        return forget_output_root(root, project_id);
    }
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
    let root_removed = settings.roots.remove(project_id).is_some();
    if settings.folders.remove(project_id).is_some() || root_removed {
        write_settings(root, &settings)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn markdown_projection_remove(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    let root = crate::data_paths::app_local_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove_projection(&root, &project_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_info(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<ProjectionInfo, String> {
    let root = crate::data_paths::app_local_root(&app)?;
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
    let root = crate::data_paths::app_local_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || set_output_root(&root, &project_id, custom_root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_name_folder(
    app: tauri::AppHandle,
    project_id: String,
    title: String,
) -> Result<NamedFolder, String> {
    let root = crate::data_paths::app_local_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || name_folder(&root, &project_id, &title))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_folder(app: tauri::AppHandle) -> Result<FolderSettings, String> {
    let root = crate::data_paths::app_local_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || folder_settings(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_set_default_root(
    app: tauri::AppHandle,
    location: String,
) -> Result<FolderSettings, String> {
    let root = crate::data_paths::app_local_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || set_default_root(&root, location))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn markdown_projection_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<FolderSettings, String> {
    let root = crate::data_paths::app_local_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || set_enabled(&root, enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// Shows the folder in Finder.
#[tauri::command]
pub async fn markdown_projection_open(
    app: tauri::AppHandle,
    project_id: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let root = crate::data_paths::app_local_root(&app)?;
    let directory =
        tauri::async_runtime::spawn_blocking(move || folder_to_open(&root, project_id.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|_| "could not open the Markdown folder".to_string())
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
    let root = crate::data_paths::app_local_root(&app)?;
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
    let root = crate::data_paths::app_local_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_files(&root, &project_id, requests))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A device that wrote before a location had to be chosen keeps the app's
    /// data folder; most tests start from there.
    fn legacy_location(root: &Path) {
        fs::create_dir_all(root.join("markdown-projections")).unwrap();
    }
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
        legacy_location(temp.path());
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
        let directory = PathBuf::from(result.directory.clone().unwrap());
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
    fn mirrors_written_under_the_retired_material_directory_move_to_the_new_one() {
        let temp = tempfile::tempdir().unwrap();
        legacy_location(temp.path());
        let root = temp.path();
        let mut image = asset(root, "p", "image", "png", b"synthetic image bytes");
        image.path = "资料/附件/地图.png".into();
        let result = write_projection_with_assets(
            root,
            "p",
            "first".into(),
            vec![entry("资料/调研/笔记.md", "note")],
            vec![image],
        )
        .unwrap();
        let directory = PathBuf::from(result.directory.clone().unwrap());
        fs::write(directory.join("资料/调研/作者自己的.txt"), "kept").unwrap();
        let mut image = asset(root, "p", "image", "png", b"synthetic image bytes");
        image.path = "素材/附件/地图.png".into();
        write_projection_with_assets(
            root,
            "p",
            "second".into(),
            vec![entry("素材/调研/笔记.md", "note")],
            vec![image],
        )
        .unwrap();
        assert_eq!(
            fs::read(directory.join("素材/附件/地图.png")).unwrap(),
            b"synthetic image bytes"
        );
        assert_eq!(
            fs::read_to_string(directory.join("素材/调研/笔记.md")).unwrap(),
            "note"
        );
        assert!(!directory.join("资料/附件").exists());
        assert!(!directory.join("资料/调研/笔记.md").exists());
        // A file the author put there is not Drifting's to remove.
        assert_eq!(
            fs::read_to_string(directory.join("资料/调研/作者自己的.txt")).unwrap(),
            "kept"
        );
    }

    #[test]
    fn missing_corrupt_or_unowned_attachments_never_replace_the_previous_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        legacy_location(temp.path());
        let root = temp.path();
        let result = write_projection(
            root,
            "p",
            "first".into(),
            vec![entry("index.md", "previous")],
        )
        .unwrap();
        let directory = PathBuf::from(result.directory.clone().unwrap());
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
        legacy_location(temp.path());
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
            fs::read(
                Path::new(&result.directory.clone().unwrap())
                    .join("project/assets/id-image/display.jpg")
            )
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
    fn folders_are_named_after_the_book_and_follow_its_title() {
        let local = tempfile::tempdir().unwrap();
        legacy_location(local.path());
        let root = local.path();
        let hashed =
            write_projection(root, "p", "first".into(), vec![entry("prose.md", "text")]).unwrap();
        // A folder from before names is renamed in place.
        let named = name_folder(root, "p", "潮汐灯塔").unwrap();
        let directory = root.join("markdown-projections").join("潮汐灯塔");
        assert_eq!(
            named.previous_directory.as_deref(),
            Some(hashed.directory.clone().unwrap().as_str())
        );
        assert_eq!(
            named.info.directory.clone().unwrap(),
            directory.to_string_lossy()
        );
        assert_eq!(named.info.generated_at.as_deref(), Some("first"));
        assert!(!Path::new(&hashed.directory.clone().unwrap()).exists());
        assert_eq!(
            fs::read_to_string(directory.join("prose.md")).unwrap(),
            "text"
        );
        assert_eq!(
            info(root, "p").unwrap().directory.clone().unwrap(),
            named.info.directory.clone().unwrap()
        );
        assert_eq!(resolved_project_directory(root, "p").unwrap(), directory);
        assert_eq!(folder_to_open(root, Some("p")).unwrap(), directory);
        let again = name_folder(root, "p", "潮汐灯塔").unwrap();
        assert_eq!(again.previous_directory, None);
        write_projection(root, "p", "second".into(), vec![entry("prose.md", "new")]).unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("prose.md")).unwrap(),
            "new"
        );
        let read = read_files(
            root,
            "p",
            vec![ReadRequest {
                path: "prose.md".into(),
                known_size: None,
                known_modified_ms: None,
                force: true,
            }],
        )
        .unwrap();
        assert_eq!(read[0].text.as_deref(), Some("new"));
        // A renamed book renames its folder.
        let renamed = name_folder(root, "p", "北岬").unwrap();
        assert_eq!(
            renamed.previous_directory.as_deref(),
            Some(directory.to_string_lossy().as_ref())
        );
        assert!(!directory.exists());
        assert_eq!(
            fs::read_to_string(root.join("markdown-projections/北岬/prose.md")).unwrap(),
            "new"
        );
        // So does a change of letter case alone, on any file system.
        name_folder(root, "p", "Tide").unwrap();
        let cased = name_folder(root, "p", "tide").unwrap();
        assert!(cased.previous_directory.is_some());
        let names: Vec<_> = fs::read_dir(root.join("markdown-projections"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["tide".to_string()]);
        // Deleting the project forgets its name.
        remove_projection(root, "p").unwrap();
        assert!(read_settings(root).unwrap().folders.is_empty());
        assert!(name_folder(root, "p", "a/b").is_err());
        assert!(name_folder(root, "p", ".hidden").is_err());
    }

    #[test]
    fn a_taken_title_gets_a_number_that_stays_while_the_title_does() {
        let local = tempfile::tempdir().unwrap();
        let root = local.path();
        let parent = root.join("markdown-projections");
        fs::create_dir_all(parent.join("Book")).unwrap();
        fs::write(parent.join("Book/notes.md"), "user file").unwrap();
        let first = name_folder(root, "p", "Book").unwrap();
        assert_eq!(
            first.info.directory.clone().unwrap(),
            parent.join("Book 2").to_string_lossy()
        );
        write_projection(root, "p", "now".into(), vec![entry("prose.md", "p")]).unwrap();
        let second = name_folder(root, "q", "Book").unwrap();
        assert_eq!(
            second.info.directory.clone().unwrap(),
            parent.join("Book 3").to_string_lossy()
        );
        write_projection(root, "q", "now".into(), vec![entry("prose.md", "q")]).unwrap();
        // The number stays even once the plain title is free again.
        fs::remove_dir_all(parent.join("Book")).unwrap();
        let kept = name_folder(root, "p", "Book").unwrap();
        assert_eq!(
            kept.info.directory.clone().unwrap(),
            parent.join("Book 2").to_string_lossy()
        );
        assert_eq!(kept.previous_directory, None);
        // A new title drops it.
        let renamed = name_folder(root, "p", "Other").unwrap();
        assert_eq!(
            renamed.info.directory.clone().unwrap(),
            parent.join("Other").to_string_lossy()
        );
        assert_eq!(
            fs::read_to_string(parent.join("Other/prose.md")).unwrap(),
            "p"
        );
        assert_eq!(
            fs::read_to_string(parent.join("Book 3/prose.md")).unwrap(),
            "q"
        );
        assert!(numbered("Book 12", "Book"));
        assert!(!numbered("Book 02", "Book"));
        assert!(!numbered("Book 1", "Book"));
        assert!(!numbered("Booklet", "Book"));
    }

    #[test]
    fn naming_waits_while_the_folder_is_off() {
        let local = tempfile::tempdir().unwrap();
        legacy_location(local.path());
        let root = local.path();
        let hashed =
            write_projection(root, "p", "first".into(), vec![entry("prose.md", "text")]).unwrap();
        set_enabled(root, false).unwrap();
        let named = name_folder(root, "p", "Book").unwrap();
        assert!(!named.info.enabled);
        assert_eq!(named.previous_directory, None);
        assert!(Path::new(&hashed.directory.clone().unwrap()).exists());
        assert!(read_settings(root).unwrap().folders.is_empty());
    }

    #[test]
    fn nothing_is_written_until_a_location_is_chosen() {
        let local = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        let own = tempfile::tempdir().unwrap();
        let root = local.path();
        let folder = folder_settings(root).unwrap();
        assert_eq!(
            (folder.directory, folder.root, folder.enabled),
            (None, None, true)
        );
        let unset = info(root, "p").unwrap();
        assert_eq!((unset.directory, unset.enabled), (None, true));
        assert_eq!(
            write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")])
                .err()
                .as_deref(),
            Some(NO_LOCATION)
        );
        assert_eq!(name_folder(root, "p", "Book").unwrap().info.directory, None);
        assert_eq!(
            folder_to_open(root, Some("p")).err().as_deref(),
            Some(NO_LOCATION)
        );
        assert_eq!(set_output_root(root, "p", None).unwrap().directory, None);
        remove_projection(root, "p").unwrap();
        assert!(!root.join("markdown-projections").exists());
        // A project with a location of its own is written all the same.
        set_output_root(root, "own", Some(own.path().to_string_lossy().into_owned())).unwrap();
        let written =
            write_projection(root, "own", "now".into(), vec![entry("prose.md", "text")]).unwrap();
        assert!(written.directory.clone().unwrap().starts_with(
            fs::canonicalize(own.path())
                .unwrap()
                .to_string_lossy()
                .as_ref()
        ));
        assert_eq!(info(root, "p").unwrap().directory, None);
        // Choosing one, even the app's own data folder, is a choice.
        let folder = set_default_root(root, chosen.path().to_string_lossy().into_owned()).unwrap();
        let canonical = fs::canonicalize(chosen.path()).unwrap();
        assert_eq!(
            folder.root.as_deref(),
            Some(canonical.to_string_lossy().as_ref())
        );
        write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")]).unwrap();
        assert!(project_directory(&canonical, "p").join("prose.md").exists());
        let app = set_default_root(root, root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            app.root.as_deref(),
            Some(fs::canonicalize(root).unwrap().to_string_lossy().as_ref())
        );
        assert!(set_default_root(root, "relative/path".into()).is_err());
        assert_eq!(folder_settings(root).unwrap().root, app.root);
    }

    #[test]
    fn a_device_that_wrote_under_the_app_folder_keeps_it_as_its_location() {
        let local = tempfile::tempdir().unwrap();
        let root = local.path();
        legacy_location(root);
        let folder = folder_settings(root).unwrap();
        assert_eq!(
            folder.root.as_deref(),
            Some(root.to_string_lossy().as_ref())
        );
        assert_eq!(
            folder.directory.unwrap(),
            root.join("markdown-projections").to_string_lossy()
        );
        let written =
            write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")]).unwrap();
        assert_eq!(
            written.directory.clone().unwrap(),
            project_directory(root, "p").to_string_lossy()
        );
    }

    #[test]
    fn the_location_for_all_projects_holds_those_without_their_own_and_keeps_old_folders() {
        let local = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        let own = tempfile::tempdir().unwrap();
        let root = local.path();
        legacy_location(root);
        let original =
            write_projection(root, "p", "first".into(), vec![entry("prose.md", "old")]).unwrap();
        let folder = set_default_root(root, chosen.path().to_string_lossy().into_owned()).unwrap();
        let canonical = fs::canonicalize(chosen.path()).unwrap();
        assert_eq!(
            folder.directory.clone().unwrap(),
            canonical.join("markdown-projections").to_string_lossy()
        );
        // The project follows the new location; its own choice is still unset.
        let moved = info(root, "p").unwrap();
        assert_eq!(moved.custom_root, None);
        assert_eq!(
            moved.directory.clone().unwrap(),
            project_directory(&canonical, "p").to_string_lossy()
        );
        write_projection(root, "p", "second".into(), vec![entry("prose.md", "new")]).unwrap();
        assert_eq!(
            fs::read_to_string(project_directory(&canonical, "p").join("prose.md")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&original.directory.clone().unwrap()).join("prose.md"))
                .unwrap(),
            "old"
        );
        // A location chosen for the project wins, and following all projects returns to theirs.
        set_output_root(root, "p", Some(own.path().to_string_lossy().into_owned())).unwrap();
        assert!(info(root, "p").unwrap().custom_root.is_some());
        let reset = set_output_root(root, "p", None).unwrap();
        assert_eq!(reset.directory, moved.directory);
    }

    #[test]
    fn unavailable_location_does_not_fall_back_and_can_be_chosen_again() {
        let local = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        let again = tempfile::tempdir().unwrap();
        let root = local.path();
        set_default_root(root, chosen.path().to_string_lossy().into_owned()).unwrap();
        chosen.close().unwrap();
        assert!(
            write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")]).is_err()
        );
        assert!(!project_directory(root, "p").exists());
        assert!(folder_to_open(root, Some("p")).is_err());
        set_default_root(root, again.path().to_string_lossy().into_owned()).unwrap();
        write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")]).unwrap();
    }

    #[test]
    fn turned_off_folder_is_neither_written_nor_read_and_keeps_its_files() {
        let local = tempfile::tempdir().unwrap();
        let root = local.path();
        legacy_location(root);
        let written =
            write_projection(root, "p", "first".into(), vec![entry("prose.md", "kept")]).unwrap();
        assert!(written.enabled);
        assert!(!set_enabled(root, false).unwrap().enabled);
        assert!(!folder_enabled(root));
        let off = info(root, "p").unwrap();
        assert!(!off.enabled);
        assert_eq!(off.directory, written.directory);
        assert!(
            write_projection(root, "p", "second".into(), vec![entry("prose.md", "new")]).is_err()
        );
        assert!(read_files(
            root,
            "p",
            vec![ReadRequest {
                path: "prose.md".into(),
                known_size: None,
                known_modified_ms: None,
                force: true,
            }]
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(Path::new(&written.directory.clone().unwrap()).join("prose.md"))
                .unwrap(),
            "kept"
        );
        // A location that went missing is no error while off.
        let gone = tempfile::tempdir().unwrap();
        let again = tempfile::tempdir().unwrap();
        set_enabled(root, true).unwrap();
        set_default_root(root, gone.path().to_string_lossy().into_owned()).unwrap();
        set_enabled(root, false).unwrap();
        gone.close().unwrap();
        assert!(!info(root, "p").unwrap().enabled);
        set_default_root(root, again.path().to_string_lossy().into_owned()).unwrap();
        assert!(set_enabled(root, true).unwrap().enabled);
        assert!(info(root, "p").unwrap().enabled);
        write_projection(root, "p", "third".into(), vec![entry("prose.md", "new")]).unwrap();
    }

    #[test]
    fn opening_shows_the_project_folder_once_written_else_the_folder_holding_projects() {
        let local = tempfile::tempdir().unwrap();
        legacy_location(local.path());
        let root = local.path();
        assert_eq!(
            folder_to_open(root, Some("p")).unwrap(),
            root.join("markdown-projections")
        );
        assert!(root.join("markdown-projections").is_dir());
        let written =
            write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")]).unwrap();
        assert_eq!(
            folder_to_open(root, Some("p")).unwrap(),
            PathBuf::from(&written.directory.clone().unwrap())
        );
        assert_eq!(
            folder_to_open(root, None).unwrap(),
            root.join("markdown-projections")
        );
    }

    #[test]
    fn custom_output_persists_per_project_resets_and_preserves_old_snapshots() {
        let local = tempfile::tempdir().unwrap();
        legacy_location(local.path());
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
        assert_eq!(
            info(root, "p").unwrap().directory.clone().unwrap(),
            selected.directory.clone().unwrap()
        );
        assert_eq!(
            resolved_project_directory(root, "p").unwrap(),
            PathBuf::from(&selected.directory.clone().unwrap())
        );
        assert_eq!(
            info(root, "other").unwrap().directory.clone().unwrap(),
            project_directory(root, "other").to_string_lossy()
        );
        fs::write(custom.path().join("notes.md"), "user file").unwrap();
        write_projection(root, "p", "second".into(), vec![entry("prose.md", "new")]).unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&selected.directory.clone().unwrap()).join("prose.md"))
                .unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&original.directory.clone().unwrap()).join("prose.md"))
                .unwrap(),
            "old"
        );
        let reset = set_output_root(root, "p", None).unwrap();
        assert_eq!(
            reset.directory.clone().unwrap(),
            original.directory.clone().unwrap()
        );
        assert_eq!(reset.custom_root, None);
        assert!(Path::new(&selected.directory.clone().unwrap())
            .join("prose.md")
            .exists());
        set_output_root(
            root,
            "p",
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap();
        fs::write(
            Path::new(&selected.directory.clone().unwrap()).join("user.md"),
            "unmanaged",
        )
        .unwrap();
        remove_projection(root, "p").unwrap();
        assert!(!Path::new(&selected.directory.clone().unwrap())
            .join("prose.md")
            .exists());
        assert!(Path::new(&selected.directory.clone().unwrap())
            .join("user.md")
            .exists());
        assert!(Path::new(&original.directory.clone().unwrap())
            .join("prose.md")
            .exists());
        assert_eq!(
            fs::read_to_string(custom.path().join("notes.md")).unwrap(),
            "user file"
        );
        assert!(read_settings(root).unwrap().roots.is_empty());
    }

    #[test]
    fn a_location_where_the_name_is_taken_is_accepted_and_written_around_it() {
        let local = tempfile::tempdir().unwrap();
        legacy_location(local.path());
        let custom = tempfile::tempdir().unwrap();
        let root = local.path();
        name_folder(root, "p", "Book").unwrap();
        let taken = custom.path().join("markdown-projections").join("Book");
        fs::create_dir_all(&taken).unwrap();
        fs::write(taken.join("README.md"), "belongs to user").unwrap();
        assert!(set_output_root(root, "p", Some("relative/path".into())).is_err());
        let selected = set_output_root(
            root,
            "p",
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap();
        assert_eq!(selected.generated_at, None);
        // A write never enters someone else's folder; naming finds another.
        assert!(
            write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")]).is_err()
        );
        let named = name_folder(root, "p", "Book").unwrap();
        let canonical = fs::canonicalize(custom.path()).unwrap();
        assert_eq!(
            named.info.directory.clone().unwrap(),
            canonical
                .join("markdown-projections/Book 2")
                .to_string_lossy()
        );
        write_projection(root, "p", "now".into(), vec![entry("prose.md", "text")]).unwrap();
        assert_eq!(
            fs::read_to_string(taken.join("README.md")).unwrap(),
            "belongs to user"
        );
        assert!(!taken.join("prose.md").exists());
        // Another project's manifest makes a folder taken too.
        let other = custom.path().join("markdown-projections").join("Other");
        fs::create_dir_all(other.join(".drifting")).unwrap();
        let manifest = Manifest {
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
            other.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(occupant(&other, "p") == Occupant::Taken);
        assert!(occupant(&other, "other") == Occupant::Ours);
    }

    #[test]
    fn unavailable_custom_output_does_not_fallback_and_can_be_reset() {
        let local = tempfile::tempdir().unwrap();
        legacy_location(local.path());
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
        let directory = PathBuf::from(selected.directory.clone().unwrap());
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
        legacy_location(local.path());
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
        legacy_location(temp.path());
        let root = temp.path();
        let project = "synthetic-project";
        let result = write_projection(
            root,
            project,
            "first".into(),
            vec![entry("chapters/a/prose.md", "雨😀"), entry("old.md", "old")],
        )
        .unwrap();
        let directory = PathBuf::from(result.directory.clone().unwrap());
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
        legacy_location(temp.path());
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
        legacy_location(temp.path());
        let root = temp.path();
        let chapter = "正文/001 雨夜.md";
        let first = write_authored(
            root,
            vec![authored(chapter, "A", None), entry("开始阅读.md", "home")],
            "first",
        );
        let directory = PathBuf::from(first.info.directory.clone().unwrap());
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
        legacy_location(temp.path());
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
        let directory = PathBuf::from(info.directory.clone().unwrap());
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
        legacy_location(temp.path());
        let root = temp.path();
        let first = write_authored(root, vec![authored("正文/001 雨夜.md", "A", None)], "one");
        let directory = PathBuf::from(first.info.directory.clone().unwrap());
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
        legacy_location(temp.path());
        let root = temp.path();
        let chapter = "正文/001 雨夜.md";
        let info = write_authored(root, vec![authored(chapter, "雨", None)], "one").info;
        let directory = PathBuf::from(info.directory.clone().unwrap());
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
        let forced =
            read_files(root, "p", vec![request(Some(size), Some(modified), true)]).unwrap();
        assert_eq!(forced[0].text.as_deref(), Some("雨"));

        edit(&directory.join(chapter), "雨夜");
        let edited =
            read_files(root, "p", vec![request(Some(size), Some(modified), false)]).unwrap();
        assert!(edited[0].changed);
        assert_eq!(edited[0].text.as_deref(), Some("雨夜"));

        fs::write(directory.join(chapter), [0xff, 0xfe, 0x00]).unwrap();
        let invalid = read_files(root, "p", vec![request(None, None, true)]).unwrap();
        assert_eq!(invalid[0].error.as_deref(), Some("encoding"));
        assert!(invalid[0].text.is_none());

        fs::remove_file(directory.join(chapter)).unwrap();
        let missing =
            read_files(root, "p", vec![request(Some(size), Some(modified), false)]).unwrap();
        assert!(!missing[0].exists && missing[0].changed);
        assert!(read_files(
            root,
            "p",
            vec![ReadRequest {
                path: "../escape.md".into(),
                known_size: None,
                known_modified_ms: None,
                force: true,
            }]
        )
        .is_err());
    }

    #[test]
    fn a_folder_managed_by_another_installation_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        legacy_location(temp.path());
        let root = temp.path();
        let info = write_authored(root, vec![authored("正文/001 雨夜.md", "A", None)], "one").info;
        let directory = PathBuf::from(info.directory.clone().unwrap());
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
        assert_eq!(
            fs::read_to_string(directory.join("正文/001 雨夜.md")).unwrap(),
            "A"
        );
    }
}
