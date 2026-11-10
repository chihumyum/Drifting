//! dr-view-export: export (module M41), over dr-export.
//!
//! - 「导出成稿」 ([`Request::Manuscript`]): the 0.1 client's
//!   `ManuscriptExportDialog`. Format (EPUB, PDF, Word), the whole book or
//!   chosen chapters (grouped under their acts), act and chapter titles on
//!   or off, the book's title, author and cover; then the save panel, and
//!   the file is laid out and written off the main thread. H1, H2 and H3
//!   always travel (dr-export); there is no switch for them.
//! - 「分享」 ([`Request::Markdown`]): the 0.1 client's `MarkdownShareDialog`.
//!   The whole book or one page as Markdown, read-only; copy it all, or save
//!   it as a `.md` file.
//!
//! The shell opens one [`ExportDialog`] over the workspace and drops it on
//! [`ExportEvent::Close`]. docs/rust-rewrite/modules/m41-export.md has the
//! rules and the decisions.

mod manuscript;
pub mod prefs;

use std::path::PathBuf;

pub use dr_export::Format;
use dr_i18n::{I18n, Locale, Platform};
use dr_workspace::Workspace;
use gpui::{Context, EventEmitter, IntoElement, Render, Window, div, prelude::*};

pub use manuscript::{Busy, Feedback as ManuscriptFeedback, ManuscriptState};

/// What the author asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// 「导出成稿」; opened from a chapter, 「选中章节」 starts with just it.
    Manuscript { chapter: Option<String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportEvent {
    Close,
}

enum Inner {
    Manuscript(ManuscriptState),
}

/// The dialog over the workspace.
pub struct ExportDialog {
    inner: Inner,
}

impl EventEmitter<ExportEvent> for ExportDialog {}

impl ExportDialog {
    pub fn new(
        lib: Option<Workspace>,
        book: String,
        request: Request,
        locale: Locale,
        platform: Platform,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ExportDialog {
        let i18n = I18n::new(locale, platform);
        let inner = match request {
            Request::Manuscript { chapter } => {
                Inner::Manuscript(ManuscriptState::new(lib, book, chapter, i18n, window, cx))
            }
        };
        ExportDialog { inner }
    }

    /// The manuscript side, when that is what is open.
    pub fn manuscript(&self) -> Option<&ManuscriptState> {
        match &self.inner {
            Inner::Manuscript(m) => Some(m),
        }
    }

    pub fn manuscript_mut(&mut self) -> Option<&mut ManuscriptState> {
        match &mut self.inner {
            Inner::Manuscript(m) => Some(m),
        }
    }

    /// Closes the dialog, unless it is writing a file.
    pub fn close(&mut self, cx: &mut Context<Self>) {
        let busy = match &self.inner {
            Inner::Manuscript(m) => m.is_busy(),
        };
        if !busy {
            cx.emit(ExportEvent::Close);
        }
    }
}

impl Render for ExportDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match &mut self.inner {
            Inner::Manuscript(_) => manuscript::render(self, window, cx),
        };
        div().child(body)
    }
}

/// Where the save panel starts: the author's home folder.
pub(crate) fn start_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
