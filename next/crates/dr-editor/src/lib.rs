//! dr-editor (F4e): Drifting's editor, gpui-prose on Drifting's storage.
//!
//! - [`SessionSource`]: gpui-prose's text source on a workspace editing
//!   session. Writes and undo go through F3's `ProseSession` (dr-doc's
//!   transactions in the document holder's write job), reads and anchors run
//!   on the holder thread, every commit (the author's, an Agent's command, a
//!   sync) reaches the editor as an event.
//! - [`DriftingExtension`]: entity link looks (from the workspace's catalog)
//!   and Markdown input rules ([`rules`]).
//! - [`todo`]: typed TODO markers.
//! - [`ChapterEditor`]: the editor view the shell puts on the paper, with
//!   chapter switching, settings ([`EditorSettings`]) and the anchors an undo
//!   brings back written to the book.
//! - [`BookEditor`]: the whole book in one scroll (M05), every chapter
//!   editable with its own session and undo.
//! - [`page`]: the chapter page around the text (M03): the facts and the
//!   places for the host's folio line, title, synopsis and empty hint.
//!
//! Docs: `docs/rust-rewrite/foundations/f4-editor.md` (F4e).

pub mod anchors;
pub mod assist;
pub mod book;
mod clipboard;
pub mod convert;
pub mod decor;
pub mod embeds;
pub mod entity_links;
pub mod file_host;
pub mod highlight;
pub mod link_card;
pub mod links;
pub mod material;
pub mod page;
pub mod pinyin;
mod prose_files;
pub mod rules;
pub mod settings;
pub mod source;
pub mod table;
pub mod todo;
pub mod v3;
pub mod v3_link;
pub mod view;

pub use book::{
    BookEditor, BookEditorEvent, BookSection, PreparedBook, ReadingPosition, SectionHeading,
};
pub use clipboard::{ClipboardHtml, PasteAsPlainText, set_clipboard_html};
pub use embeds::{NoteEmbeds, NoteEvent};
pub use links::{DriftingExtension, LinkTargets};
pub use page::{PageChrome, PageInfo, PageKind};
pub use settings::EditorSettings;
pub use source::SessionSource;
pub use todo::TodoMarker;
pub use view::{
    ChapterEditor, ChapterEditorEvent, CommentRequested, EmbedCommentRequested,
    EmbedFrameRequested, EntityLinkOpened, MaterialOpened, PositionLinkCopied, WritingTyped,
};

/// The options every editor Drifting builds starts from (a chapter or entry
/// body, the whole book, a table cell): gpui-prose's defaults, except that
/// on macOS each edit and composition update is drawn at once
/// ([`gpui_prose::EditorOptions::present_now`], through gpui-prose's
/// `SystemIme`). The author's decision of 2026-11-24, with GPUI v1.29.3:
/// on GPUI's own timing a keystroke took about 47 ms to reach the screen at
/// the median, drawn at once about 27 ms, neither with a long tail
/// (`docs/rust-rewrite/foundations/f4-editor.md`). Windows and Linux keep
/// GPUI's timing.
pub fn editor_options() -> gpui_prose::EditorOptions {
    gpui_prose::EditorOptions {
        present_now: cfg!(target_os = "macos"),
        ..gpui_prose::EditorOptions::default()
    }
}

// The public playback switch lives on each host's `editor()` entity.
pub use gpui_prose::playback::{CommitPlaybackOptions, CommitPlaybackStatus};
/// The page a v3 body is part of ([`ChapterEditor::set_page_scroll`]).
pub use gpui_prose::render::PageScroll;
