//! Finished-manuscript export: EPUB 3, Word (.docx) and PDF.
//!
//! The renderer reads the book from live Yjs (see
//! `services/export/manuscript-export.service.ts`) and sends one
//! [`Manuscript`]: acts and chapters in book order, chapter prose already
//! reduced to headings, paragraphs, quotes and scene breaks. This module only
//! lays that out. It never reads the database or the network; the only file it
//! writes is the one the author picks in the save dialog.
mod docx;
mod epub;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod pdf;
mod text;

#[cfg(test)]
mod acceptance;

use std::io::Write;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
use tauri_plugin_fs::{FsExt, OpenOptions};

pub(crate) use text::Language;

/// Upper bound for the renderer payload (prose plus a base64 cover).
const MANUSCRIPT_PAYLOAD_LIMIT: usize = 96 * 1024 * 1024;
const COVER_SOURCE_LIMIT: u64 = 64 * 1024 * 1024;
const COVER_LONG_EDGE: u32 = 2560;
const COVER_BYTES_LIMIT: usize = 12 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManuscriptFormat {
    Epub,
    Docx,
    Pdf,
}

impl ManuscriptFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Docx => "docx",
            Self::Pdf => "pdf",
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::Epub => "EPUB",
            Self::Docx => "Word",
            Self::Pdf => "PDF",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manuscript {
    pub title: String,
    #[serde(default)]
    pub author: String,
    /// Stable per project; hashed into the EPUB package identifier.
    pub identifier: String,
    /// UTC `YYYY-MM-DDThh:mm:ssZ`, the moment the renderer captured the book.
    pub modified: String,
    /// The interface language, used only when the prose is not CJK.
    #[serde(default)]
    pub locale: String,
    /// An editor font family the author chose; PDF tries it first.
    #[serde(default)]
    pub preferred_font: Option<String>,
    #[serde(default)]
    pub cover: Option<Cover>,
    pub sections: Vec<Section>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cover {
    pub media_type: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Section {
    /// An act (卷 / 幕) title of its own; present only when act titles are on.
    Act { title: String },
    #[serde(rename_all = "camelCase")]
    Chapter {
        title: String,
        /// False keeps the title in navigation only.
        show_title: bool,
        blocks: Vec<Block>,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Justify,
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Block {
    /// Prose headings: 1 = scene, 2 = beat, 3 = note.
    Heading {
        level: u8,
        runs: Vec<Run>,
        #[serde(default)]
        align: Align,
    },
    Paragraph {
        runs: Vec<Run>,
        #[serde(default)]
        align: Align,
        #[serde(default)]
        indent: u8,
    },
    Quote {
        blocks: Vec<Block>,
    },
    /// A horizontal rule in the editor: a scene break.
    Break,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    /// May contain `\n` for a hard line break.
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strike: bool,
    /// Only http(s) and mailto links survive validation.
    #[serde(default)]
    pub href: Option<String>,
}

/// A decoded, validated cover image ready to embed.
pub(crate) struct CoverImage {
    pub bytes: Vec<u8>,
    pub png: bool,
    pub width: u32,
    pub height: u32,
}

impl CoverImage {
    pub(crate) fn extension(&self) -> &'static str {
        if self.png {
            "png"
        } else {
            "jpeg"
        }
    }

    pub(crate) fn media_type(&self) -> &'static str {
        if self.png {
            "image/png"
        } else {
            "image/jpeg"
        }
    }
}

/// The manuscript after validation, with everything a writer needs resolved.
pub(crate) struct Book<'a> {
    pub source: &'a Manuscript,
    pub language: Language,
    pub modified: text::Timestamp,
    pub cover: Option<CoverImage>,
}

impl Book<'_> {
    pub(crate) fn title(&self) -> &str {
        self.source.title.trim()
    }

    pub(crate) fn author(&self) -> &str {
        self.source.author.trim()
    }

    pub(crate) fn sections(&self) -> &[Section] {
        &self.source.sections
    }

    pub(crate) fn has_acts(&self) -> bool {
        self.source
            .sections
            .iter()
            .any(|section| matches!(section, Section::Act { .. }))
    }
}

fn decode_cover(cover: &Cover) -> Result<CoverImage, String> {
    let png = match cover.media_type.as_str() {
        "image/png" => true,
        "image/jpeg" => false,
        _ => return Err("cover must be a PNG or JPEG image".into()),
    };
    let bytes = BASE64_STANDARD
        .decode(cover.data.as_bytes())
        .map_err(|_| "cover image is not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > COVER_BYTES_LIMIT {
        return Err("cover image exceeds the 12 MiB limit".into());
    }
    let format = image::guess_format(&bytes).map_err(|_| "unrecognized cover image")?;
    let expected = if png {
        image::ImageFormat::Png
    } else {
        image::ImageFormat::Jpeg
    };
    if format != expected {
        return Err("cover image does not match its media type".into());
    }
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format)
        .into_dimensions()
        .map_err(|_| "cover image could not be read")?;
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err("cover image dimensions are out of range".into());
    }
    Ok(CoverImage {
        bytes,
        png,
        width,
        height,
    })
}

fn validate_runs(runs: &[Run]) -> Result<(), String> {
    for run in runs {
        if let Some(href) = &run.href {
            if !text::is_exported_link(href) {
                return Err("only http(s) and mailto links can be exported".into());
            }
        }
    }
    Ok(())
}

fn validate_blocks(blocks: &[Block], depth: usize) -> Result<(), String> {
    if depth > 8 {
        return Err("quotes are nested too deeply".into());
    }
    for block in blocks {
        match block {
            Block::Heading { level, runs, .. } => {
                if !(1..=3).contains(level) {
                    return Err("prose headings are levels 1 to 3".into());
                }
                validate_runs(runs)?;
            }
            Block::Paragraph { runs, indent, .. } => {
                if *indent > 8 {
                    return Err("paragraph indent is out of range".into());
                }
                validate_runs(runs)?;
            }
            Block::Quote { blocks } => validate_blocks(blocks, depth + 1)?,
            Block::Break => {}
        }
    }
    Ok(())
}

/// Validate the renderer payload and resolve language, time and cover.
pub(crate) fn prepare(manuscript: &Manuscript) -> Result<Book<'_>, String> {
    if manuscript.title.trim().is_empty() || manuscript.title.chars().count() > 500 {
        return Err("the book needs a title of at most 500 characters".into());
    }
    if manuscript.author.chars().count() > 500 {
        return Err("the author name is too long".into());
    }
    if manuscript.identifier.is_empty() || manuscript.identifier.len() > 200 {
        return Err("invalid book identifier".into());
    }
    let chapters = manuscript
        .sections
        .iter()
        .filter(|section| matches!(section, Section::Chapter { .. }))
        .count();
    if chapters == 0 {
        return Err("choose at least one chapter".into());
    }
    for section in &manuscript.sections {
        match section {
            Section::Act { title } if title.trim().is_empty() => {
                return Err("act titles cannot be empty".into())
            }
            Section::Chapter { title, blocks, .. } => {
                if title.trim().is_empty() {
                    return Err("chapter titles cannot be empty".into());
                }
                validate_blocks(blocks, 0)?;
            }
            Section::Act { .. } => {}
        }
    }
    let modified = text::Timestamp::parse(&manuscript.modified)
        .ok_or_else(|| "invalid export timestamp".to_string())?;
    let cover = manuscript.cover.as_ref().map(decode_cover).transpose()?;
    Ok(Book {
        source: manuscript,
        language: text::detect_language(manuscript),
        modified,
        cover,
    })
}

/// Generate the file bytes for one format.
pub(crate) fn render(book: &Book<'_>, format: ManuscriptFormat) -> Result<Vec<u8>, String> {
    let bytes = match format {
        ManuscriptFormat::Epub => epub::write(book)?,
        ManuscriptFormat::Docx => docx::write(book)?,
        ManuscriptFormat::Pdf => render_pdf(book)?,
    };
    if bytes.len() > OUTPUT_LIMIT {
        return Err("the exported file exceeds 512 MiB".into());
    }
    Ok(bytes)
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn render_pdf(book: &Book<'_>) -> Result<Vec<u8>, String> {
    pdf::write(book, &pdf::system_fonts())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn render_pdf(_book: &Book<'_>) -> Result<Vec<u8>, String> {
    Err("PDF export is available on desktop".into())
}

fn validate_filename(filename: &str, format: ManuscriptFormat) -> Result<(), String> {
    let extension = format!(".{}", format.extension());
    if filename.len() > 160
        || filename.trim() != filename
        || !filename.ends_with(&extension)
        || filename == extension
        || filename.starts_with('.')
        || filename.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err("invalid export filename".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptSaveResult {
    ok: bool,
    canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ManuscriptSaveResult {
    fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            canceled: false,
            error: Some(error.into()),
        }
    }
}

/// Ask where to save, then lay out and write the manuscript.
#[tauri::command]
pub async fn manuscript_export_save(
    app: AppHandle,
    format: ManuscriptFormat,
    filename: String,
    payload: String,
) -> ManuscriptSaveResult {
    if let Err(error) = validate_filename(&filename, format) {
        return ManuscriptSaveResult::failure(error);
    }
    if payload.len() > MANUSCRIPT_PAYLOAD_LIMIT {
        return ManuscriptSaveResult::failure("the manuscript exceeds the 96 MiB export limit");
    }
    let selected = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .file()
                .set_picker_mode(PickerMode::Document)
                .set_file_access_mode(FileAccessMode::Scoped)
                .set_file_name(filename)
                .add_filter(format.filter_name(), &[format.extension()])
                .blocking_save_file()
        }
    })
    .await;
    let selected = match selected {
        Ok(Some(selected)) => selected,
        Ok(None) => {
            return ManuscriptSaveResult {
                ok: false,
                canceled: true,
                error: None,
            }
        }
        Err(_) => return ManuscriptSaveResult::failure("could not open the save dialog"),
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let manuscript: Manuscript = serde_json::from_str(&payload)
            .map_err(|error| format!("invalid manuscript: {error}"))?;
        let book = prepare(&manuscript)?;
        let bytes = render(&book, format)?;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = app
            .fs()
            .open(selected, options)
            .map_err(|_| "could not create the selected file".to_string())?;
        file.write_all(&bytes)
            .map_err(|_| "could not write the selected file".to_string())?;
        file.flush()
            .map_err(|_| "could not flush the selected file".to_string())?;
        file.sync_all()
            .map_err(|_| "could not finalize the selected file".to_string())
    })
    .await;
    match result {
        Ok(Ok(())) => ManuscriptSaveResult {
            ok: true,
            canceled: false,
            error: None,
        },
        Ok(Err(error)) => ManuscriptSaveResult::failure(error),
        Err(_) => ManuscriptSaveResult::failure("the export worker failed"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverPickResult {
    ok: bool,
    canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cover: Option<Cover>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// A cover picked from disk, oriented, bounded and re-encoded as JPEG.
#[tauri::command]
pub async fn manuscript_export_pick_cover(app: AppHandle) -> CoverPickResult {
    let selected = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .file()
                .set_picker_mode(PickerMode::Image)
                .set_file_access_mode(FileAccessMode::Scoped)
                .add_filter(
                    "Images",
                    &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"],
                )
                .blocking_pick_file()
        }
    })
    .await;
    let selected = match selected {
        Ok(Some(selected)) => selected,
        Ok(None) => {
            return CoverPickResult {
                ok: false,
                canceled: true,
                cover: None,
                error: None,
            }
        }
        Err(_) => {
            return CoverPickResult {
                ok: false,
                canceled: false,
                cover: None,
                error: Some("could not open the file picker".into()),
            }
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Cover, String> {
        let path = selected
            .into_path()
            .map_err(|_| "the chosen image is not a local file".to_string())?;
        let variant =
            crate::image_pipeline::create_variant(&path, COVER_SOURCE_LIMIT, COVER_LONG_EDGE, 90)
                .map_err(|error| error.message)?;
        Ok(Cover {
            media_type: variant.mime,
            data: BASE64_STANDARD.encode(&variant.bytes),
            width: variant.width,
            height: variant.height,
        })
    })
    .await;
    match result {
        Ok(Ok(cover)) => CoverPickResult {
            ok: true,
            canceled: false,
            cover: Some(cover),
            error: None,
        },
        Ok(Err(error)) => CoverPickResult {
            ok: false,
            canceled: false,
            cover: None,
            error: Some(error),
        },
        Err(_) => CoverPickResult {
            ok: false,
            canceled: false,
            cover: None,
            error: Some("the cover worker failed".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_filenames_are_single_bounded_segments_with_the_format_extension() {
        assert!(validate_filename("合成书稿.epub", ManuscriptFormat::Epub).is_ok());
        assert!(validate_filename("Book.docx", ManuscriptFormat::Docx).is_ok());
        assert!(validate_filename("Book.pdf", ManuscriptFormat::Pdf).is_ok());
        for (filename, format) in [
            ("Book.pdf", ManuscriptFormat::Epub),
            ("../Book.epub", ManuscriptFormat::Epub),
            ("a/b.docx", ManuscriptFormat::Docx),
            (".pdf", ManuscriptFormat::Pdf),
            ("Book.pdf\n", ManuscriptFormat::Pdf),
            ("a:b.pdf", ManuscriptFormat::Pdf),
        ] {
            assert!(validate_filename(filename, format).is_err(), "{filename}");
        }
        assert!(
            validate_filename(&format!("{}.pdf", "长".repeat(60)), ManuscriptFormat::Pdf).is_err()
        );
    }
}
