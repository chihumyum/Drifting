//! One-way, derived Markdown files. No filesystem content is ever imported.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

static WRITER: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    path: String,
    text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    project_id: String,
    generated_at: String,
    read_only: bool,
    reverse_sync: bool,
    files: BTreeMap<String, String>,
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
    if path.len() > 1024
        || !path.ends_with(".md")
        || path.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.len() > 240
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.%".contains(&c))
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
    read_manifest_file(root, "manifest.json")
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
    if manifest.schema_version != 1 || !manifest.read_only || manifest.reverse_sync {
        return Err("Unsupported projection manifest".into());
    }
    for path in manifest.files.keys() {
        validate_path(path)?;
    }
    Ok(Some(manifest))
}

// Record ownership before changing files, so interrupted writes can be retried
// without treating their new files as user-created collisions.
fn read_owned_manifest(root: &Path, project_id: &str) -> Result<Option<Manifest>, String> {
    let published = read_manifest(root)?;
    let pending = read_manifest_file(root, ".pending-manifest.json")?;
    let mut owned: Option<Manifest> = None;
    for manifest in published.into_iter().chain(pending) {
        if manifest.project_id != project_id {
            return Err("Projection project mismatch".into());
        }
        if let Some(owned) = &mut owned {
            owned.files.extend(manifest.files);
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
        read_only: true,
        reverse_sync: false,
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
            file.set_permissions(fs::Permissions::from_mode(0o400))
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

fn write_projection(
    root: &Path,
    project_id: &str,
    generated_at: String,
    entries: Vec<Entry>,
) -> Result<ProjectionInfo, String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    validate_project(project_id)?;
    if entries.len() > 20_000
        || entries.iter().map(|e| e.text.len()).sum::<usize>() > 256 * 1024 * 1024
    {
        return Err("Markdown projection exceeds size limit".into());
    }
    let mut paths = HashSet::new();
    for entry in &entries {
        validate_path(&entry.path)?;
        if !paths.insert(&entry.path) {
            return Err("Duplicate projection path".into());
        }
    }
    let (output, _) = output_root(root, project_id)?;
    if !inspect(&output, true)? {
        return Err("Projection output directory is unavailable".into());
    }
    ensure_directory(&output.join("markdown-projections"))?;
    let directory = project_directory(&output, project_id);
    ensure_directory(&directory)?;
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
    let files: BTreeMap<_, _> = entries
        .iter()
        .map(|entry| {
            (
                entry.path.clone(),
                format!("{:x}", Sha256::digest(entry.text.as_bytes())),
            )
        })
        .collect();
    let mut manifest = Manifest {
        schema_version: 1,
        project_id: project_id.into(),
        generated_at,
        read_only: true,
        reverse_sync: false,
        files: BTreeMap::new(),
    };
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
        atomic_write(
            &directory.join(".pending-manifest.json"),
            &serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
        )?;
    }
    for entry in entries {
        let path = prepare_path(&directory, &entry.path, true)?;
        // Compare actual bytes, so external edits are repaired, never imported.
        if !inspect(&path, false)?
            || fs::metadata(&path).map_err(|e| e.to_string())?.len() != entry.text.len() as u64
            || fs::read(&path).map_err(|e| e.to_string())? != entry.text.as_bytes()
        {
            atomic_write(&path, entry.text.as_bytes())?;
        }
    }
    if let Some(previous) = previous {
        for path in previous
            .files
            .keys()
            .filter(|path| !files.contains_key(*path))
        {
            let target = prepare_path(&directory, path, false)?;
            if inspect(&target, false)? {
                fs::remove_file(target).map_err(|e| e.to_string())?;
            }
        }
    }
    manifest.files = files;
    atomic_write(
        &directory.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )?;
    let pending = directory.join(".pending-manifest.json");
    if inspect(&pending, false)? {
        fs::remove_file(pending).map_err(|e| e.to_string())?;
    }
    info(root, project_id)
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
    for name in ["manifest.json", ".pending-manifest.json"] {
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
    let _ = fs::remove_dir(directory);
    forget_output_root(root, project_id)
}

fn forget_output_root(root: &Path, project_id: &str) -> Result<(), String> {
    let mut settings = read_settings(root)?;
    if settings.roots.remove(project_id).is_some() {
        atomic_write(
            &root.join("markdown-projection-settings.json"),
            &serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
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
) -> Result<ProjectionInfo, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        write_projection(&root, &project_id, generated_at, entries)
    })
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
        }
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
            schema_version: 1,
            project_id: "other".into(),
            generated_at: "old".into(),
            read_only: true,
            reverse_sync: false,
            files: BTreeMap::new(),
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
        fs::remove_file(directory.join("manifest.json")).unwrap();
        atomic_write(
            &directory.join(".pending-manifest.json"),
            &serde_json::to_vec(&interrupted).unwrap(),
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
        assert!(manifest.read_only && !manifest.reverse_sync);
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
}
