use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const DATABASE_DIRECTORY: &str = "databases";

type DataPathResult<T> = Result<T, String>;

pub struct DataDirectories {
    pub database_directory: PathBuf,
}

pub fn prepare_data_directories(app: &AppHandle) -> DataPathResult<DataDirectories> {
    let database_directory = match database_directory_override()? {
        Some(path) => path,
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("failed to resolve Tauri data directory: {error}"))?
            .join(DATABASE_DIRECTORY),
    };

    fs::create_dir_all(&database_directory).map_err(|error| {
        format!(
            "failed to create database directory {}: {error}",
            database_directory.display()
        )
    })?;

    Ok(DataDirectories { database_directory })
}

fn database_directory_override() -> DataPathResult<Option<PathBuf>> {
    let Some(value) = std::env::var_os("DRIFTING_DB_DIR") else {
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
            .map_err(|error| format!("failed to resolve DRIFTING_DB_DIR: {error}"))
    }
}
