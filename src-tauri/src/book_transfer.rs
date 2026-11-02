//! Save and open `.driftingbook` files (docs/book-transfer.md). The renderer
//! builds and validates a book; these commands only carry its bytes through
//! the native document pickers, as raw IPC bodies rather than JSON arrays.

use std::io::{Read, Write};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
use tauri_plugin_fs::{FsExt, OpenOptions};

const BOOK_EXTENSION: &str = "driftingbook";
/// Matches `BOOK_FILE_MAX_BYTES` in src/renderer/services/book-transfer/book-file.ts.
const BOOK_FILE_LIMIT: usize = 1024 * 1024 * 1024;
/// The suggested file name, percent-encoded so a title in any script fits a header.
const FILE_NAME_HEADER: &str = "x-drifting-book-file-name";

#[derive(Debug, Serialize)]
pub struct BookSaveResult {
    saved: bool,
}

fn validate_book_file_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    let suffix = format!(".{BOOK_EXTENSION}");
    if trimmed.is_empty()
        || trimmed.len() > 255
        || !trimmed.to_ascii_lowercase().ends_with(&suffix)
        || trimmed.len() == suffix.len()
        || trimmed
            .chars()
            .any(|character| matches!(character, '/' | '\\' | '\0') || character.is_control())
    {
        return Err("book-file-name-invalid".into());
    }
    Ok(())
}

fn decoded_file_name(request: &Request<'_>) -> Result<String, String> {
    let header = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "book-file-name-missing".to_string())?;
    let name = percent_decode_str(header)
        .decode_utf8()
        .map_err(|_| "book-file-name-invalid".to_string())?
        .into_owned();
    validate_book_file_name(&name)?;
    Ok(name)
}

/// Ask where to save the book, then write it there. A canceled picker saves nothing.
#[tauri::command]
pub async fn book_transfer_save(
    app: AppHandle,
    request: Request<'_>,
) -> Result<BookSaveResult, String> {
    let file_name = decoded_file_name(&request)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("book-bytes-missing".into());
    };
    if bytes.is_empty() {
        return Err("book-bytes-missing".into());
    }
    if bytes.len() > BOOK_FILE_LIMIT {
        return Err("book-file-too-large".into());
    }
    let bytes = bytes.clone();

    let selected = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .file()
                .set_picker_mode(PickerMode::Document)
                .set_file_access_mode(FileAccessMode::Scoped)
                .set_file_name(file_name)
                .add_filter("Drifting book", &[BOOK_EXTENSION])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|_| "book save dialog failed".to_string())?;
    let Some(selected) = selected else {
        return Ok(BookSaveResult { saved: false });
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = app
            .fs()
            .open(selected, options)
            .map_err(|_| "could not create the selected book file".to_string())?;
        file.write_all(&bytes)
            .map_err(|_| "could not write the selected book file".to_string())?;
        file.flush()
            .map_err(|_| "could not flush the selected book file".to_string())?;
        file.sync_all()
            .map_err(|_| "could not finalize the selected book file".to_string())
    })
    .await
    .map_err(|_| "book save worker failed".to_string())??;
    Ok(BookSaveResult { saved: true })
}

fn read_capped(reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read the selected book file".to_string())?;
    if bytes.len() > limit {
        return Err("book-file-too-large".into());
    }
    Ok(bytes)
}

/// Pick a book and return its bytes; an empty body means the picker was canceled.
#[tauri::command]
pub async fn book_transfer_open(app: AppHandle) -> Result<Response, String> {
    let selected = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .file()
                .set_picker_mode(PickerMode::Document)
                .set_file_access_mode(FileAccessMode::Scoped)
                .add_filter("Drifting book", &[BOOK_EXTENSION])
                .blocking_pick_file()
        }
    })
    .await
    .map_err(|_| "book open dialog failed".to_string())?;
    let Some(selected) = selected else {
        return Ok(Response::new(Vec::new()));
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let mut options = OpenOptions::new();
        options.read(true);
        let file = app
            .fs()
            .open(selected, options)
            .map_err(|_| "could not open the selected book file".to_string())?;
        read_capped(file, BOOK_FILE_LIMIT)
    })
    .await
    .map_err(|_| "book open worker failed".to_string())??;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_book_names_in_any_script() {
        assert!(validate_book_file_name("傲慢与偏见.driftingbook").is_ok());
        assert!(validate_book_file_name("Pride and Prejudice.DRIFTINGBOOK").is_ok());
    }

    #[test]
    fn refuses_names_that_are_not_a_single_book_file() {
        for name in [
            "",
            ".driftingbook",
            "book.zip",
            "../book.driftingbook",
            "a\\b.driftingbook",
            "line\nbreak.driftingbook",
        ] {
            assert!(validate_book_file_name(name).is_err(), "{name:?}");
        }
        assert!(validate_book_file_name(&format!("{}.driftingbook", "x".repeat(250))).is_err());
    }

    #[test]
    fn reads_up_to_the_limit_only() {
        assert_eq!(read_capped(&[1u8, 2, 3][..], 3).unwrap(), vec![1, 2, 3]);
        assert_eq!(
            read_capped(&[1u8, 2, 3, 4][..], 3).unwrap_err(),
            "book-file-too-large"
        );
    }
}
