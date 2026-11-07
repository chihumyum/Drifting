//! dr-export: what leaves Drifting as a file (module M41's back end).
//!
//! - The finished manuscript as EPUB 3, Word (.docx) or PDF: [`outline`]
//!   lists the acts and chapters for the dialog, [`read_manuscript`] reads
//!   the chosen chapters from Loro into a [`Manuscript`], [`render`] lays it
//!   out. The writers are the 0.1 client's (`src-tauri/src/manuscript_export`)
//!   as they were; only the Tauri commands and dialogs are gone. H1, H2 and
//!   H3 always travel as three heading levels, with no switch.
//! - Markdown share ([`markdown`]): the whole book or one document's body.
//! - A cover from an image file ([`cover_from_path`]), file names to suggest
//!   ([`manuscript_filename`], [`markdown_filename`]) and a whole-or-nothing
//!   write ([`write_file`]).
//!
//! Everything here runs off the main thread and blocks: reading goes through
//! F3 (`dr-workspace`), rendering a long book into PDF takes seconds. The
//! save and open panels belong to the interface (GPUI's prompts).

pub mod book_file;
mod convert;
mod cover;
mod files;
pub mod import;
mod manuscript;
mod markdown;

pub use convert::{
    ActEntry, ChapterEntry, Labels, Options, Outline, blocks, default_chapters, outline,
    read_manuscript, timestamp,
};
pub use cover::{COVER_EXTENSIONS, COVER_LONG_EDGE, COVER_SOURCE_LIMIT, cover_from_path};
pub use files::{manuscript_filename, readable_stem, write_file};
pub use import::{
    IMPORT_EXTENSIONS, ImportError, ImportFormat, ImportTarget, ImportWarning, ImportedEntity,
    ImportedItem, ParsedDoc, files_in_folder, import_docs, order_import_files, parse_bytes,
    parse_file,
};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub use manuscript::pdf_fonts;
pub use manuscript::{
    Align, Block, Cover, Format, Language, Manuscript, Run, Section, language, render,
    valid_filename,
};
pub use markdown::{MarkdownDoc, MarkdownTarget, markdown, markdown_filename};

/// Why an export could not be read.
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error(transparent)]
    Workspace(#[from] dr_workspace::WsError),
    /// The book or document is gone (trashed or purged).
    #[error("{0} is no longer available")]
    NotFound(String),
    /// Nothing to export: no chapter chosen, or none left.
    #[error("choose at least one chapter")]
    NoChapters,
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T, E = ExportError> = std::result::Result<T, E>;
