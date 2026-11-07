//! Finished-manuscript export: EPUB 3, Word (.docx) and PDF.
//!
//! Ported from the 0.1 client's `src-tauri/src/manuscript_export` with the
//! Tauri commands and dialogs left out. [`crate::convert`] reads the book
//! from Loro and builds one [`Manuscript`]: acts and chapters in book order,
//! chapter prose already reduced to headings (H1, H2, H3), paragraphs,
//! quotes and separators. This module only lays that out: it reads neither
//! the library nor the network and writes no file.
mod docx;
mod epub;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod pdf;
mod text;

#[cfg(test)]
mod acceptance;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};

pub use text::Language;

const COVER_BYTES_LIMIT: usize = 12 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 512 * 1024 * 1024;

/// The three manuscript formats.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Epub,
    Docx,
    Pdf,
}

impl Format {
    /// In the order the 0.1 dialog offers them.
    pub const ALL: [Format; 3] = [Format::Epub, Format::Pdf, Format::Docx];

    pub fn extension(self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Docx => "docx",
            Self::Pdf => "pdf",
        }
    }

    /// What the dialog and the save panel's filter call it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Epub => "EPUB",
            Self::Docx => "Word",
            Self::Pdf => "PDF",
        }
    }
}

/// The book reduced to what a reader sees. The same shape (and JSON) as the
/// 0.1 renderer's payload.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manuscript {
    pub title: String,
    #[serde(default)]
    pub author: String,
    /// Stable per book; hashed into the EPUB package identifier.
    pub identifier: String,
    /// UTC `YYYY-MM-DDThh:mm:ssZ`, the moment the book was read.
    pub modified: String,
    /// The interface language, used only when the prose is not CJK.
    #[serde(default)]
    pub locale: String,
    /// An editor font family the author chose; PDF tries it first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    pub sections: Vec<Section>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cover {
    /// `image/jpeg` or `image/png`.
    pub media_type: String,
    /// Base64 image bytes.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Section {
    /// An act title of its own; present only when act titles are on.
    Act { title: String },
    #[serde(rename_all = "camelCase")]
    Chapter {
        title: String,
        /// False keeps the title in navigation only.
        show_title: bool,
        blocks: Vec<Block>,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Justify,
    Left,
    Center,
    Right,
}

impl Align {
    fn is_justify(&self) -> bool {
        *self == Align::Justify
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Block {
    /// Prose headings H1, H2 and H3 (`level` 1–3): three levels whose
    /// meaning is the author's, so every format sets them alike by level.
    Heading {
        level: u8,
        runs: Vec<Run>,
        #[serde(default, skip_serializing_if = "Align::is_justify")]
        align: Align,
    },
    Paragraph {
        runs: Vec<Run>,
        #[serde(default, skip_serializing_if = "Align::is_justify")]
        align: Align,
        #[serde(default, skip_serializing_if = "is_zero")]
        indent: u8,
    },
    Quote {
        blocks: Vec<Block>,
    },
    /// A horizontal rule in the editor: a separator.
    Break,
}

fn is_zero(n: &u8) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    /// May contain `\n` for a hard line break.
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub strike: bool,
    /// Only http(s) and mailto links survive validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
        if self.png { "png" } else { "jpeg" }
    }

    pub(crate) fn media_type(&self) -> &'static str {
        if self.png { "image/png" } else { "image/jpeg" }
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
        if let Some(href) = &run.href
            && !text::is_exported_link(href)
        {
            return Err("only http(s) and mailto links can be exported".into());
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

/// Validate a manuscript and resolve language, time and cover.
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
                return Err("act titles cannot be empty".into());
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

/// Validates `manuscript` and lays it out as `format`: the file's bytes.
/// Errors are short English sentences (0.1's), for the log and a tooltip.
pub fn render(manuscript: &Manuscript, format: Format) -> Result<Vec<u8>, String> {
    render_book(&prepare(manuscript)?, format)
}

/// Whether a run's link survives into the manuscript (http(s) or mailto).
pub(crate) fn exported_link(href: &str) -> bool {
    text::is_exported_link(href)
}

/// The book's language, as the writers detect it from its own characters.
pub fn language(manuscript: &Manuscript) -> Language {
    text::detect_language(manuscript)
}

/// Generate the file bytes for one format.
pub(crate) fn render_book(book: &Book<'_>, format: Format) -> Result<Vec<u8>, String> {
    let bytes = match format {
        Format::Epub => epub::write(book)?,
        Format::Docx => docx::write(book)?,
        Format::Pdf => render_pdf(book)?,
    };
    if bytes.len() > OUTPUT_LIMIT {
        return Err("the exported file exceeds 512 MiB".into());
    }
    Ok(bytes)
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn render_pdf(book: &Book<'_>) -> Result<Vec<u8>, String> {
    pdf::write(book, pdf::system_fonts())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn render_pdf(_book: &Book<'_>) -> Result<Vec<u8>, String> {
    Err("PDF export is available on desktop".into())
}

/// The PDF's body font and Latin font for `manuscript` (`Err` when no
/// installed font can set it): what a PDF export would embed.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn pdf_fonts(manuscript: &Manuscript) -> Result<(String, Option<String>), String> {
    let book = prepare(manuscript)?;
    pdf::body_font_names(&book, pdf::system_fonts())
}

/// Whether `filename` is a single, bounded path segment ending in the
/// format's extension (0.1's check on what the save dialog suggests).
pub fn valid_filename(filename: &str, format: Format) -> bool {
    let extension = format!(".{}", format.extension());
    !(filename.len() > 160
        || filename.trim() != filename
        || !filename.ends_with(&extension)
        || filename == extension
        || filename.starts_with('.')
        || filename.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_filenames_are_single_bounded_segments_with_the_format_extension() {
        assert!(valid_filename("合成书稿.epub", Format::Epub));
        assert!(valid_filename("Book.docx", Format::Docx));
        assert!(valid_filename("Book.pdf", Format::Pdf));
        for (filename, format) in [
            ("Book.pdf", Format::Epub),
            ("../Book.epub", Format::Epub),
            ("a/b.docx", Format::Docx),
            (".pdf", Format::Pdf),
            ("Book.pdf\n", Format::Pdf),
            ("a:b.pdf", Format::Pdf),
        ] {
            assert!(!valid_filename(filename, format), "{filename}");
        }
        assert!(!valid_filename(
            &format!("{}.pdf", "长".repeat(60)),
            Format::Pdf
        ));
    }
}
