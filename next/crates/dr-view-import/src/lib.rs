//! Import a 0.1 source into a separately named library.
//! MappingChoices are explicit, pending is structured, and source/current
//! libraries stay intact. The cancellable background worker closes its target
//! before the shared release protocol performs a short controlled activation.

pub mod copy;
mod flow;
pub mod reimport;
mod view;

pub use flow::{
    Done, DoneBook, Failed, Found, FoundLibrary, LegacyImport, OFFERED, QUIT_WAIT_BOOK, Ready,
    Running, State, V1_DATA_DIR_ENV, find_libraries, find_local_libraries, v1_data_dir,
};

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
/// shell's modal dialog while an import is open; the first time the
/// bookshelf shows on a device with 0.1 libraries, the dialog shows by
/// itself ([`LegacyImport::offer`]). Once, after `dr_shell::init` and
/// `dr_view_shelf::init`.
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
                // Seen on this device: it does not offer itself again.
                dr_shell::Settings::set_device_memory(cx, OFFERED, Some(true.into()));
                // In the window the author started it in.
                match import.read(cx).window() {
                    Some(window) => dr_shell::dialogs::show_in(window, cx, import.into()),
                    None => dr_shell::dialogs::show(cx, import.into()),
                }
            } else {
                dr_shell::dialogs::hide(cx, import.entity_id());
            }
        }
    })
    .detach();
    // A book an earlier import left unfinished: a reminder to carry it on.
    flow::check_unfinished(entity.clone(), cx);
    cx.set_global(Importer(entity));
    // Quitting: the import stops first, so its documents close and its
    // thread lets go of the library.
    dr_shell::release::before_release(cx, |cx| {
        let pending =
            importer(cx).and_then(|entity| entity.update(cx, |import, _| import.begin_drain()));
        let wait = cx.background_spawn(async move {
            if let Some((thread, cancel)) = pending {
                flow::drain_worker(thread, cancel)?;
            }
            Ok(())
        });
        Box::pin(wait)
    });
    dr_shell::release::after_release(cx, |cx| {
        if let Some(entity) = importer(cx) {
            let waits = entity.update(cx, |import, cx| {
                import.end_drain();
                cx.notify();
                import.offer_again()
            });
            if let Some(window) = waits {
                offer_in(window, cx);
            }
        }
    });
    // The bookshelf with no first run over it: the import offers itself.
    dr_shell::pages::after_first_run(cx, |window, cx| {
        offer_in(window.window_handle(), cx);
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

/// [`LegacyImport::offer`] in `window`, once what is under way there is over
/// (the window being built, a first run's last click, a library swap).
fn offer_in(window: gpui::AnyWindowHandle, cx: &mut App) {
    cx.defer(move |cx| {
        let Some(entity) = importer(cx) else {
            return;
        };
        dr_shell::workspace::with_workspace_in(window, cx, move |_, window, cx| {
            entity.update(cx, |import, cx| import.offer(window, cx));
        });
    });
}
