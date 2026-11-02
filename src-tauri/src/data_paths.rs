use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const DATABASE_DIRECTORY: &str = "databases";
const APP_DATA_OVERRIDE: &str = "DRIFTING_APP_DATA_DIR";
/// App-local folders the renderer reads through the asset protocol.
const ASSET_PROTOCOL_DIRECTORIES: &[&str] = &["assets", "imports", "generation-inbox"];

type DataPathResult<T> = Result<T, String>;

pub struct DataDirectories {
    pub database_directory: PathBuf,
    /// The legacy library's database folder. App-wide diagnostics (crash
    /// reports, development logs) derive from it so they never move with the
    /// running library.
    pub diagnostics_anchor: PathBuf,
}

pub fn prepare_data_directories(app: &AppHandle) -> DataPathResult<DataDirectories> {
    let base = base_local_root(app)?;
    let library = crate::library_registry::running_library(&base);
    let relative = crate::library_registry::relative_root(library);
    let (database_directory, diagnostics_anchor) = match directory_override("DRIFTING_DB_DIR")? {
        // A moved database folder holds the legacy library; every other
        // library keeps its own folder beneath it.
        Some(path) => (path.join(&relative), path),
        None => (
            base.join(&relative).join(DATABASE_DIRECTORY),
            base.join(DATABASE_DIRECTORY),
        ),
    };

    fs::create_dir_all(&database_directory).map_err(|error| {
        format!(
            "failed to create database directory {}: {error}",
            database_directory.display()
        )
    })?;

    // The configured asset-protocol scope names `$APPLOCALDATA`; a moved root,
    // or any library but the legacy one, must be granted the same folders.
    if directory_override(APP_DATA_OVERRIDE)?.is_some()
        || library != crate::library_registry::LEGACY_LIBRARY_ID
    {
        let root = app_local_root(app)?;
        for directory in ASSET_PROTOCOL_DIRECTORIES {
            app.asset_protocol_scope()
                .allow_directory(root.join(directory), true)
                .map_err(|error| format!("failed to allow {directory} assets: {error}"))?;
        }
    }

    Ok(DataDirectories {
        database_directory,
        diagnostics_anchor,
    })
}

/// The running library's data root: assets, sync objects, installation
/// identity, Markdown projections and MCP state. Every library has its own (see
/// `library_registry`), so no store ever reconciles against another library's
/// database.
pub fn app_local_root(app: &AppHandle) -> DataPathResult<PathBuf> {
    let base = base_local_root(app)?;
    let library = crate::library_registry::running_library(&base);
    Ok(base.join(crate::library_registry::relative_root(library)))
}

/// The App-local base root, which holds the library registry and the legacy
/// library. Development launches move it out of the installed App's folder
/// (`DRIFTING_APP_DATA_DIR`), so a development build and the published App never
/// share any of it.
pub fn base_local_root(app: &AppHandle) -> DataPathResult<PathBuf> {
    match directory_override(APP_DATA_OVERRIDE)? {
        Some(path) => Ok(path),
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("failed to resolve Tauri data directory: {error}")),
    }
}

fn directory_override(name: &str) -> DataPathResult<Option<PathBuf>> {
    let Some(value) = std::env::var_os(name) else {
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
            .map_err(|error| format!("failed to resolve {name}: {error}"))
    }
}
