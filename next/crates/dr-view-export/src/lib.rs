//! dr-view-export: manuscript export dialog (module M41), over dr-export.
//!
//! - 「导出成稿」 ([`Request::Manuscript`]): opened from the workspace avatar
//!   menu. Chooses format (EPUB, PDF, Word), scope (when the project has
//!   `成书` enabled, 「只导成书正文」 defaults on and exports the book sequence's
//!   `in_book` prose; turning it off—or opening a project without `成书`, where
//!   the whole tree starts ticked—lets the author tick the residence tree and
//!   export all content of the ticked entries with tree hierarchy), the single
//!   「条目标题」 switch, and book info (title, author, cover); then opens the
//!   save panel and writes the file off the main thread. H1, H2 and H3 inside
//!   prose always travel (dr-export).
//!
//! The shell opens one [`ExportDialog`] over the workspace and drops it on
//! [`ExportEvent::Close`]. `docs/rust-rewrite/modules/m41-export.md` has the
//! rules and decisions.

mod manuscript;
pub mod prefs;

use std::path::PathBuf;

pub use dr_export::Format;
use dr_i18n::{I18n, Locale, Platform};
use dr_workspace::Workspace;
use gpui::{Context, EventEmitter, IntoElement, Render, Window, div, prelude::*};

pub use manuscript::{Busy, Feedback as ManuscriptFeedback, ManuscriptState};

/// What the author asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    /// 「导出成稿」, opened for the whole project from the workspace avatar menu.
    Manuscript,
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
            Request::Manuscript => {
                Inner::Manuscript(ManuscriptState::new(lib, book, i18n, window, cx))
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

    /// Sets the author's preferred editor font family for PDF export.
    pub fn set_preferred_font(&mut self, font: Option<String>) {
        if let Some(m) = self.manuscript_mut() {
            m.preferred_font = font;
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
