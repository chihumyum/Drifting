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
    generated_at: Option<String>,
    read_only: bool,
    reverse_sync: bool,
}

pub fn project_directory(root: &Path, project_id: &str) -> PathBuf {
    root.join("markdown-projections")
        .join(format!("{:x}", Sha256::digest(project_id.as_bytes())))
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
    let path = root.join("manifest.json");
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

fn info(root: &Path, project_id: &str) -> Result<ProjectionInfo, String> {
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
    inspect(root, true)?;
    ensure_directory(&root.join("markdown-projections"))?;
    let directory = project_directory(root, project_id);
    ensure_directory(&directory)?;
    let previous = read_manifest(&directory)?;
    if previous
        .as_ref()
        .is_some_and(|m| m.project_id != project_id)
    {
        return Err("Projection project mismatch".into());
    }
    // Validate every existing path before changing any managed file.
    for entry in &entries {
        prepare_path(&directory, &entry.path, false)?;
    }
    if let Some(previous) = &previous {
        for path in previous.files.keys() {
            prepare_path(&directory, path, false)?;
        }
    }
    let mut files = BTreeMap::new();
    for entry in entries {
        let path = prepare_path(&directory, &entry.path, true)?;
        let hash = format!("{:x}", Sha256::digest(entry.text.as_bytes()));
        // Compare actual bytes, so external edits are repaired, never imported.
        if !inspect(&path, false)?
            || fs::metadata(&path).map_err(|e| e.to_string())?.len() != entry.text.len() as u64
            || fs::read(&path).map_err(|e| e.to_string())? != entry.text.as_bytes()
        {
            atomic_write(&path, entry.text.as_bytes())?;
        }
        files.insert(entry.path, hash);
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
    let manifest = Manifest {
        schema_version: 1,
        project_id: project_id.into(),
        generated_at,
        read_only: true,
        reverse_sync: false,
        files,
    };
    atomic_write(
        &directory.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )?;
    info(root, project_id)
}

fn remove_projection(root: &Path, project_id: &str) -> Result<(), String> {
    let _guard = WRITER.lock().map_err(|_| "Projection writer unavailable")?;
    info(root, project_id)?;
    let directory = project_directory(root, project_id);
    let Some(manifest) = read_manifest(&directory)? else {
        return Ok(());
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
    fs::remove_file(directory.join("manifest.json")).map_err(|e| e.to_string())?;
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    // Only empty managed directories are removed; user-created files survive.
    for path in directories {
        let _ = fs::remove_dir(path);
    }
    let _ = fs::remove_dir(directory);
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
pub fn markdown_projection_info(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<ProjectionInfo, String> {
    info(
        &app.path().app_local_data_dir().map_err(|e| e.to_string())?,
        &project_id,
    )
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
