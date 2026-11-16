//! dr-view-transfer: moving books in and out (module M41's second part).
//!
//! - **`.driftingproject`** ([`book`]): the bookshelf card's export icon
//!   ([`dr_view_shelf::ExportBook`]) and 「导入书（.driftingproject）」
//!   ([`dr_view_shelf::ImportBook`]), as the 0.1 shelf; the file is
//!   `dr_export::book_file` (format version 5).
//! - **`.driftingtemplate`** ([`template`]): template hover-card export
//!   ([`dr_view_shelf::ExportTemplate`]) straight to the save panel, All
//!   Projects' 「导入模板 .driftingtemplate」 ([`dr_view_shelf::ImportTemplate`]),
//!   and `.driftingtemplate` files dropped onto the window; the file is
//!   `dr_export::template_file` (format version 1).
//!
//! - **Importing documents** ([`documents`]): Markdown, text and Word
//!   files into a chosen level of the open book using its resolved default
//!   template, from the account menu's 「导入」
//!   ([`dr_shell::actions::ImportDocuments`]); the reading and writing are
//!   `dr_export::import`.
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
pub mod template;

pub use dialog::{Proceed, State, TransferDialog, WIDTH};
pub use template::{ExportTemplate, ExportTemplateById, ImportTemplate};

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
    cx.on_action(|a: &dr_view_shelf::ExportTemplate, cx| {
        let tpl = a.template.clone();
        dr_shell::menus::after_dispatch(cx, move |cx| template::export(tpl, cx));
    });
    cx.on_action(|a: &template::ExportTemplateById, cx| {
        let tpl = a.id.clone();
        dr_shell::menus::after_dispatch(cx, move |cx| template::export(tpl, cx));
    });
    cx.on_action(|_: &dr_view_shelf::ImportTemplate, cx| {
        dr_shell::menus::after_dispatch(cx, template::import);
    });
    dr_shell::pages::set_external_file_drop(
        cx,
        |paths, _| paths.iter().any(|p| template::is_template_file(p)),
        |paths, _, cx| {
            let tpl_paths: Vec<_> = paths
                .iter()
                .filter(|p| template::is_template_file(p))
                .cloned()
                .collect();
            if tpl_paths.is_empty() {
                return;
            }
            let lib = cx
                .try_global::<dr_shell::Services>()
                .and_then(|s| s.library.clone());
            if let Some(lib) = lib {
                dr_shell::menus::after_dispatch(cx, move |cx| {
                    template::import_paths(lib, tpl_paths, cx);
                });
            }
        },
    );
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
