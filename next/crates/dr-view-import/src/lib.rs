//! dr-view-import: importing a Drifting 0.1 library, from the bookshelf
//! (module M10's interface; the import itself is `dr-import-v1`).
//!
//! The bookshelf's rail has the entry: it dispatches
//! [`dr_view_shelf::ImportLegacyLibrary`], which [`init`] takes with
//! `cx.on_action`. Then:
//!
//! 1. **The library.** The local 0.1 libraries this device has (found by the
//!    0.1 client's own path rule, [`v1_data_dir`]) are listed to pick from;
//!    with none, or with 「选择文件夹」, the system's folder panel: the 0.1
//!    app's data folder, one library's root or its `databases` folder
//!    (`dr_import_v1::locate::resolve` says which library that is). The
//!    device takes over the chosen library's 0.1 installation id, so its
//!    writing days continue under the 0.1 device key.
//! 2. **The import** runs on its own thread, into the library the app has
//!    open (`run::import_into_library`). The 0.1 library is only read: the
//!    import works on a copy beside the new library.
//! 3. **The gate.** A library that never went through the handoff, with
//!    bodies whose caches cannot be proven the latest, is stopped before
//!    anything is written: a dialog lists those bodies by book, and only
//!    「仍然导入」 imports them from their caches (the import runs again,
//!    accepting them).
//! 4. **Progress** while it runs (the book, n of m, a bar), and **a summary**
//!    at the end: the books, their words, what was left alone.
//! 5. The bookshelf reads again on F3's events as the books land, so the new
//!    books are on it when the summary shows.
//!
//! The dialog floats over the window as a layer of the shell
//! (`dr_shell::pages::add_layer`); it draws nothing while no import is
//! open. 「取消」 lets the book being written finish and leaves the rest out;
//! quitting the app stops the import first ([`LegacyImport::stop_for_quit`]),
//! and a book stopped halfway is carried on by the next import
//! (m10-import.md).
//!
//! Copy comes from the 0.1 client's strings; what it never had is a
//! placeholder ([`copy`]), listed in m10-import.md 「待协调」.

pub mod copy;
mod flow;
mod view;

pub use flow::{
    Done, DoneBook, Failed, Found, FoundLibrary, LegacyImport, QUIT_WAIT_BOOK, QUIT_WAIT_NOW,
    Running, State, V1_DATA_DIR_ENV, find_local_libraries, v1_data_dir,
};

use gpui::{App, AppContext as _, Entity, Global};

struct Importer(Entity<LegacyImport>);

impl Global for Importer {}

/// The app's one import (one at a time), once [`init`] ran.
pub fn importer(cx: &App) -> Option<Entity<LegacyImport>> {
    cx.try_global::<Importer>().map(|i| i.0.clone())
}

/// Takes the bookshelf's 「导入 · Drifting 0.1」 and adds the dialog to the
/// shell's layers. Once, after `dr_shell::init` and `dr_view_shelf::init`.
pub fn init(cx: &mut App) {
    let entity = cx.new(LegacyImport::new);
    dr_shell::pages::add_layer(cx, entity.clone().into());
    cx.set_global(Importer(entity));
    // Quitting: the import stops first, so its documents close and its
    // thread lets go of the library.
    dr_shell::quit::before_quit(cx, |cx| {
        if let Some(entity) = importer(cx) {
            entity.update(cx, |import, _| import.stop_for_quit());
        }
    });
    cx.on_action(|_: &dr_view_shelf::ImportLegacyLibrary, cx| {
        // GPUI has the window checked out while it dispatches; reach it once
        // the dispatch is over.
        dr_shell::menus::after_dispatch(cx, |cx| {
            let Some(entity) = importer(cx) else {
                return;
            };
            dr_shell::workspace::with_workspace(cx, move |_, window, cx| {
                entity.update(cx, |import, cx| import.choose(window, cx));
            });
        });
    });
}
