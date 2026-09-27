//! App-owned asset bytes: `<root>/<project>/<asset>/source.<ext>`.
//!
//! Imports write an in-progress marker naming the importing session before
//! any byte, copy the source atomically under a size cap, and clear the
//! marker only after the owning SQLite rows commit. Deletion removes the rows
//! first and the directory after the commit. `collect_garbage` removes every
//! asset directory that no committed row retains, except imports still owned
//! by the current session, so an interrupted import or delete converges.
use crate::file_io::{atomic_copy_capped, sync_directory};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

const MARKER: &str = ".importing";
const MAX_SEGMENT: usize = 128;

#[derive(Clone, Debug)]
pub struct AssetStore {
    root: PathBuf,
    session: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedAsset {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssetGarbage {
    pub removed: u64,
    pub cleared_markers: u64,
}

fn segment(value: &str) -> Result<&str, String> {
    let valid = !value.is_empty()
        && value.len() <= MAX_SEGMENT
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !value.starts_with('.')
        && matches!(
            Path::new(value).components().collect::<Vec<_>>()[..],
            [Component::Normal(_)]
        );
    if valid {
        Ok(value)
    } else {
        Err(format!("Invalid asset store identifier: {value}"))
    }
}

fn extension(value: &str) -> Result<String, String> {
    let normalized = value.trim_start_matches('.').to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 8
        || !normalized.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(format!("Invalid asset extension: {value}"));
    }
    Ok(normalized)
}

/// Refuses a symlink anywhere below the root, so a managed path never
/// escapes the store.
fn real_directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "asset store paths may not be symlinks",
        )),
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_directory(directory: &Path) -> io::Result<()> {
    if !real_directory(directory)? {
        return Ok(());
    }
    fs::remove_dir_all(directory)?;
    if let Some(parent) = directory.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

impl AssetStore {
    /// `session` identifies this process's imports for garbage collection.
    pub fn new(root: impl Into<PathBuf>, session: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            session: session.into(),
        }
    }

    fn directory(&self, project: &str, asset: &str) -> Result<PathBuf, String> {
        let directory = self.root.join(segment(project)?).join(segment(asset)?);
        for path in [
            self.root.clone(),
            self.root.join(project),
            directory.clone(),
        ] {
            real_directory(&path).map_err(|e| e.to_string())?;
        }
        Ok(directory)
    }

    /// The stored source file of a committed asset.
    pub fn path(&self, project: &str, asset: &str, ext: &str) -> Result<PathBuf, String> {
        Ok(self
            .directory(project, asset)?
            .join(format!("source.{}", extension(ext)?)))
    }

    /// Copies `source` into a new asset directory under `limit` bytes. The
    /// directory stays marked as this session's import until `commit`.
    pub fn import(
        &self,
        project: &str,
        asset: &str,
        ext: &str,
        source: &Path,
        limit: u64,
    ) -> Result<ImportedAsset, String> {
        let directory = self.directory(project, asset)?;
        if real_directory(&directory).map_err(|e| e.to_string())? {
            return Err("素材已存在，不能覆盖".into());
        }
        let path = directory.join(format!("source.{}", extension(ext)?));
        let result = (|| {
            fs::create_dir_all(&directory)?;
            if let Some(parent) = directory.parent() {
                sync_directory(parent)?;
            }
            let marker = directory.join(MARKER);
            fs::write(&marker, self.session.as_bytes())?;
            fs::File::open(&marker)?.sync_all()?;
            sync_directory(&directory)?;
            let size_bytes = atomic_copy_capped(source, &path, limit)?;
            let mut hasher = Sha256::new();
            let mut file = fs::File::open(&path)?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            let digest = hasher.finalize();
            Ok::<_, io::Error>(ImportedAsset {
                path: path.clone(),
                size_bytes,
                sha256: digest.iter().map(|b| format!("{b:02x}")).collect(),
            })
        })();
        result.map_err(|error| {
            let _ = remove_directory(&directory);
            match error.kind() {
                io::ErrorKind::NotFound => "找不到要导入的文件".to_string(),
                io::ErrorKind::InvalidInput => "只能导入文件，不能导入文件夹".to_string(),
                io::ErrorKind::InvalidData => format!("文件超过 {} MB 的上限", limit / 1024 / 1024),
                io::ErrorKind::PermissionDenied => "素材库目录不能包含符号链接".to_string(),
                _ => format!("素材导入失败：{error}"),
            }
        })
    }

    /// Clears the import marker once the owning rows are committed.
    pub fn commit(&self, project: &str, asset: &str) -> Result<(), String> {
        let directory = self.directory(project, asset)?;
        let marker = directory.join(MARKER);
        match fs::remove_file(&marker) {
            Ok(()) => sync_directory(&directory).map_err(|e| e.to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Removes an asset's bytes: an abandoned import, or after its rows'
    /// deletion committed.
    pub fn remove(&self, project: &str, asset: &str) -> Result<(), String> {
        remove_directory(&self.directory(project, asset)?).map_err(|e| e.to_string())
    }

    /// Removes every asset directory not retained by committed rows, except
    /// this session's unfinished imports; clears markers of retained ones.
    pub fn collect_garbage(
        &self,
        retained: &HashSet<(String, String)>,
    ) -> Result<AssetGarbage, String> {
        let mut result = AssetGarbage::default();
        if !real_directory(&self.root).map_err(|e| e.to_string())? {
            return Ok(result);
        }
        let entries = |path: &Path| -> Result<Vec<(String, PathBuf)>, String> {
            let mut found = Vec::new();
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "Asset name is not UTF-8")?;
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_symlink() {
                    return Err("Asset store contains a symlink".into());
                }
                if kind.is_dir() && segment(&name).is_ok() {
                    found.push((name, entry.path()));
                }
            }
            Ok(found)
        };
        for (project, project_path) in entries(&self.root)? {
            for (asset, directory) in entries(&project_path)? {
                let marker = directory.join(MARKER);
                let owner = fs::read_to_string(&marker).ok();
                if retained.contains(&(project.clone(), asset.clone())) {
                    if owner.is_some() {
                        self.commit(&project, &asset)?;
                        result.cleared_markers += 1;
                    }
                } else if owner.as_deref().map(str::trim) != Some(self.session.as_str()) {
                    remove_directory(&directory).map_err(|e| e.to_string())?;
                    result.removed += 1;
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_store_imports_commits_removes_and_collects() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("portrait.png");
        fs::write(&source, b"synthetic image bytes").unwrap();
        let root = dir.path().join("assets");
        let store = AssetStore::new(&root, "session-a");
        let imported = store
            .import("project", "asset-1", "PNG", &source, 1024)
            .unwrap();
        assert_eq!(imported.size_bytes, 21);
        assert_eq!(imported.path, root.join("project/asset-1/source.png"));
        assert_eq!(
            imported.sha256,
            "9d714b0153c5204b5503770a41d5800ed8ba4e24da1a9429b6654397075031b6"
        );
        assert!(
            store
                .import("project", "asset-1", "png", &source, 1024)
                .is_err(),
            "no overwrite"
        );
        assert!(
            store
                .import("project", "asset-2", "png", &source, 4)
                .is_err(),
            "size cap"
        );
        assert!(
            !root.join("project/asset-2").exists(),
            "a failed import leaves nothing"
        );
        assert!(store.import("../x", "asset", "png", &source, 1024).is_err());
        assert!(store
            .import("project", "asset", "p/g", &source, 1024)
            .is_err());
        // Another session's interrupted import and an unretained committed
        // asset are collected; this session's pending import is kept.
        let other = AssetStore::new(&root, "session-b");
        other
            .import("project", "orphan", "pdf", &source, 1024)
            .unwrap();
        store
            .import("project", "deleted", "png", &source, 1024)
            .unwrap();
        store.commit("project", "deleted").unwrap();
        let retained: HashSet<_> = [("project".to_string(), "asset-1".to_string())].into();
        let collected = store.collect_garbage(&retained).unwrap();
        assert_eq!(
            collected,
            AssetGarbage {
                removed: 2,
                cleared_markers: 1
            }
        );
        assert!(root.join("project/asset-1/source.png").exists());
        assert!(!root.join("project/asset-1/.importing").exists());
        store
            .import("project", "pending", "png", &source, 1024)
            .unwrap();
        store.collect_garbage(&retained).unwrap();
        assert!(
            root.join("project/pending").exists(),
            "this session's import is kept"
        );
        store.remove("project", "asset-1").unwrap();
        assert!(!root.join("project/asset-1").exists());
    }
}
