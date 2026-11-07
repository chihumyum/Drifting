//! dr-view-import: importing a Drifting 0.1 library, from the bookshelf
//! (module M10's interface; the import itself is `dr-import-v1`).
//!
//! The bookshelf's rail has the entry: it dispatches
//! [`dr_view_shelf::ImportLegacyLibrary`], which [`init`] takes with
//! `cx.on_action`. Then:
//!
//! 1. **The folder.** The system's folder panel; the author picks the 0.1
//!    library's folder (the 0.1 app's data folder, one library's root or its
//!    `databases` folder: `dr_import_v1::locate::resolve` says which library
//!    that is).
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
//! The dialog is the shell's modal dialog (`dr_shell::dialogs::show`) while
//! an import is open, so the workspace's shortcuts wait until it closes.
//! There is no cancel yet (an import that stops halfway carries on the next
//! time, m10-import.md).
//!
//! Copy comes from the 0.1 client's strings; what it never had is a
//! placeholder ([`copy`]), listed in m10-import.md 「待协调」.

pub mod copy;
mod flow;
mod view;

pub use flow::{Done, DoneBook, Failed, LegacyImport, Running, State};

use gpui::{App, AppContext as _, Entity, Global};

struct Importer(Entity<LegacyImport>);

impl Global for Importer {}

/// Whether the import's dialog is the shell's dialog now.
struct Shown(bool);

impl Global for Shown {}

/// The app's one import (one at a time), once [`init`] ran.
pub fn importer(cx: &App) -> Option<Entity<LegacyImport>> {
    cx.try_global::<Importer>().map(|i| i.0.clone())
}

/// Takes the bookshelf's 「导入 · Drifting 0.1」 and shows the dialog as the
/// shell's modal dialog while an import is open. Once, after
/// `dr_shell::init` and `dr_view_shelf::init`.
pub fn init(cx: &mut App) {
    let entity = cx.new(LegacyImport::new);
    // The dialog shows while an import is open (not while only the system's
    // folder panel is up).
    cx.observe(&entity, |import, cx| {
        let open = !matches!(import.read(cx).state(), State::Idle | State::Picking);
        let shown = cx.try_global::<Shown>().is_some_and(|s| s.0);
        if open != shown {
            cx.set_global(Shown(open));
            if open {
                dr_shell::dialogs::show(cx, import.into());
            } else {
                dr_shell::dialogs::hide(cx, import.entity_id());
            }
        }
    })
    .detach();
    cx.set_global(Importer(entity));
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
