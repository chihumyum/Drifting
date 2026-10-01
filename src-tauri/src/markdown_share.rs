//! User-selected Markdown export destination. No source database or network access.
use std::io::Write;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
use tauri_plugin_fs::{FsExt, OpenOptions};

const MARKDOWN_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct MarkdownSaveResult {
    ok: bool,
    canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl MarkdownSaveResult {
    fn failure(error: &str) -> Self {
        Self {
            ok: false,
            canceled: false,
            error: Some(error.into()),
        }
    }
}

fn validate(filename: &str, markdown: &str) -> Result<(), &'static str> {
    if filename.len() > 160
        || filename.trim() != filename
        || !filename.ends_with(".md")
        || filename == ".md"
        || filename.starts_with('.')
        || filename.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err("invalid Markdown filename");
    }
    if markdown.len() > MARKDOWN_LIMIT {
        return Err("Markdown exceeds the 32 MiB export limit");
    }
    Ok(())
}

#[tauri::command]
pub async fn share_save_markdown(
    app: AppHandle,
    filename: String,
    markdown: String,
) -> MarkdownSaveResult {
    if let Err(error) = validate(&filename, &markdown) {
        return MarkdownSaveResult::failure(error);
    }
    let selected = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .file()
                .set_picker_mode(PickerMode::Document)
                .set_file_access_mode(FileAccessMode::Scoped)
                .set_file_name(filename)
                .add_filter("Markdown", &["md"])
                .blocking_save_file()
        }
    })
    .await;
    let selected = match selected {
        Ok(Some(selected)) => selected,
        Ok(None) => {
            return MarkdownSaveResult {
                ok: false,
                canceled: true,
                error: None,
            }
        }
        Err(_) => return MarkdownSaveResult::failure("could not open the save dialog"),
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), ()> {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = app.fs().open(selected, options).map_err(|_| ())?;
        file.write_all(markdown.as_bytes()).map_err(|_| ())?;
        file.flush().map_err(|_| ())?;
        file.sync_all().map_err(|_| ())
    })
    .await;
    match result {
        Ok(Ok(())) => MarkdownSaveResult {
            ok: true,
            canceled: false,
            error: None,
        },
        _ => MarkdownSaveResult::failure("could not save the Markdown file"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_export_validates_unicode_filenames_paths_and_size() {
        assert!(validate("合成书稿.md", "# 合成\n\nHello 👋").is_ok());
        for filename in [
            "../book.md",
            "folder/book.md",
            "book\\other.md",
            ".md",
            "a.txt",
            "a.md\n",
            "a:book.md",
        ] {
            assert!(validate(filename, "text").is_err(), "{filename}");
        }
        assert!(validate(&format!("{}.md", "长".repeat(60)), "text").is_err());
        assert!(validate("book.md", &"a".repeat(MARKDOWN_LIMIT + 1)).is_err());
    }
}
