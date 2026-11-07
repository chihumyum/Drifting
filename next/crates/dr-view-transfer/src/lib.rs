//! dr-view-transfer: moving books in and out (module M41's second part).
//!
//! - **`.driftingbook`** ([`book`]): the bookshelf card's export icon
//!   ([`dr_view_shelf::ExportBook`]) and 「导入书（.driftingbook）」
//!   ([`dr_view_shelf::ImportBook`]), as the 0.1 shelf; the file is
//!   `dr_export::book_file` (format version 2).
//!
//! - **Importing documents** ([`documents`]): Markdown, text and Word
//!   files into the open book as chapters, elements or ideas, from the
//!   account menu's 「导入」 ([`dr_shell::actions::ImportDocuments`]); the
//!   reading and writing are `dr_export::import`.
//! - **Backup and restore** ([`backup`]): the whole library as one
//!   `.drifting` file and back, on `dr_store::backup`, from Settings →
//!   本地数据 ([`dr_shell::actions::BackupLibrary`], `RestoreLibrary`);
//!   replacing the library is the shell's, registered with
//!   [`backup::set_replace`].
//!
//! [`init`] takes the actions with `cx.on_action` (the app calls it once,
//! after `dr_shell::init` and `dr_view_shelf::init`); the dialogs are the
//! shell's modal dialog. docs/rust-rewrite/modules/m41-export.md has the
//! rules and the decisions.

pub mod backup;
pub mod book;
mod dialog;
pub mod documents;

pub use dialog::{Proceed, State, TransferDialog, WIDTH};

use gpui::App;

/// Takes the bookshelf's export and import actions, the account menu's
/// 「导入」 and Settings' backup and restore.
pub fn init(cx: &mut App) {
    cx.on_action(|a: &dr_view_shelf::ExportBook, cx| {
        let book = a.book.clone();
        // GPUI has the window checked out while it dispatches.
        dr_shell::menus::after_dispatch(cx, move |cx| book::export(book, cx));
    });
    cx.on_action(|_: &dr_view_shelf::ImportBook, cx| {
        dr_shell::menus::after_dispatch(cx, book::import);
    });
    cx.on_action(|_: &dr_shell::actions::ImportDocuments, cx| {
        dr_shell::menus::after_dispatch(cx, documents::open);
    });
    // Settings → 本地数据.
    cx.on_action(|_: &dr_shell::actions::BackupLibrary, cx| {
        dr_shell::menus::after_dispatch(cx, backup::backup);
    });
    cx.on_action(|_: &dr_shell::actions::RestoreLibrary, cx| {
        dr_shell::menus::after_dispatch(cx, |cx| {
            let replace = backup::replacer(cx);
            backup::restore(replace, cx);
        });
    });
}
