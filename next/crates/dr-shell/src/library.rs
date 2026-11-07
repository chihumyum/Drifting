//! Swapping the library under the running app (M41's restore: the dialog in
//! dr-view-transfer replaces the library with a backup's). Only the shell
//! knows everything that holds the library, so it is the one to let go of
//! it, have it replaced, and take the new one up.
//!
//! [`replace`]:
//!
//! 1. Every workspace window lets go: its open pages' editors, the
//!    bookshelf and Project Home, search, snapshot history, the comment
//!    composer, its subscription; M07's recorder stores its writing days and
//!    stops, the Stats and Review tabs let go; `Services` no longer offers
//!    the library. A dialog over the window (the one asking for the swap)
//!    stays. The windows are told to draw again: what the last frame's
//!    handlers held (an editor in a click handler) goes with that frame.
//! 2. Off the main thread F3 brings the open documents' index up to date and
//!    closes the library (`Workspace::shutdown`, which waits for the last
//!    holders), then the job runs with the library closed: given where the
//!    library lives and how it is opened (this device's identity among it),
//!    it returns the library to use (`Library::restore_staged`).
//! 3. The new library is opened as F3's workspace and taken up: `Services`,
//!    automatic links, the Stats and Review tabs, every window (which shows
//!    the bookshelf, or without one the book opened last).
//! 4. If the job fails, the library it left in place is opened again and
//!    taken up the same way; `done` hears why.
//!
//! The job's error and anything that goes wrong on the way reach `done` as
//! words for the dialog. Should the library not close (something still
//! holds it) or not open again, `done` hears that too and the windows stay
//! without a library: quitting and starting again is the way back.

use std::path::Path;

use dr_store::{Library as StoreLibrary, LibraryOptions};
use dr_workspace::{Workspace as Library, WorkspaceOptions};
use gpui::{App, WindowHandle};

use crate::Services;
use crate::workspace::Workspace;

/// What the background half ended with.
enum Swapped {
    /// The job's library.
    New(Library),
    /// The library it left in place, opened again, and why the job failed.
    Old(Library, String),
    /// No library could be opened.
    Lost(String),
}

fn windows(cx: &App) -> Vec<WindowHandle<Workspace>> {
    cx.windows()
        .into_iter()
        .filter_map(|w| w.downcast::<Workspace>())
        .collect()
}

/// Replaces the open library with what `job` returns (see the module's
/// doc). `job` runs off the main thread with the library closed; `done`
/// runs on the main thread once the windows have a library again (or
/// could not get one): `Ok` when the job's library is in use, `Err` with
/// the words for the author otherwise. Call it from anywhere: it waits for
/// the current dispatch to end before it touches the windows.
pub fn replace(
    cx: &mut App,
    job: impl FnOnce(&Path, LibraryOptions) -> Result<StoreLibrary, String> + Send + 'static,
    done: impl FnOnce(Result<(), String>, &mut App) + 'static,
) {
    cx.defer(move |cx| {
        let Some(old) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
            done(Err("no library is open".into()), cx);
            return;
        };
        let root = old.library().paths().root.clone();
        let options = old.library().options().clone();
        let_go(cx);
        cx.spawn(async move |cx| {
            // Main-thread holders were let go above and are released as
            // that update's effects settle; F3's shutdown waits for the
            // last ones on other threads.
            let swapped = cx
                .background_executor()
                .spawn(async move { swap(old, &root, options, job) })
                .await;
            cx.update(|cx| match swapped {
                Swapped::New(lib) => {
                    take_up(lib, cx);
                    done(Ok(()), cx);
                }
                Swapped::Old(lib, why) => {
                    take_up(lib, cx);
                    done(Err(why), cx);
                }
                Swapped::Lost(why) => {
                    log::error!("the library is gone: {why}");
                    done(Err(why), cx);
                }
            });
        })
        .detach();
    });
}

/// Everything in the app that holds the library lets go of it.
fn let_go(cx: &mut App) {
    for handle in windows(cx) {
        if let Err(error) = handle.update(cx, |ws, window, cx| ws.let_go_of_library(window, cx)) {
            log::warn!("a window could not let go of the library: {error:#}");
        }
    }
    dr_view_stats::flush(cx);
    dr_view_stats::release(cx);
    dr_view_review::release(cx);
    if cx.has_global::<Services>() {
        cx.global_mut::<Services>().library = None;
    }
}

/// The background half: close, run the job, open what it gave (or what it
/// left in place).
fn swap(
    old: Library,
    root: &Path,
    options: LibraryOptions,
    job: impl FnOnce(&Path, LibraryOptions) -> Result<StoreLibrary, String>,
) -> Swapped {
    let report = old.before_quit();
    log::info!(
        "library: {} documents closed before the swap ({} in use)",
        report.closed,
        report.in_use
    );
    if let Err(error) = old.shutdown() {
        return Swapped::Lost(format!("the library could not be closed: {error}"));
    }
    let reopen = |why: String, options: LibraryOptions| match StoreLibrary::open(root, options)
        .map_err(|e| e.to_string())
        .and_then(|lib| Library::open(lib, WorkspaceOptions::default()).map_err(|e| e.to_string()))
    {
        Ok(lib) => Swapped::Old(lib, why),
        Err(error) => Swapped::Lost(format!(
            "{why}; the library could not be opened again: {error}"
        )),
    };
    match job(root, options.clone()) {
        Ok(lib) => match Library::open(lib, WorkspaceOptions::default()) {
            Ok(lib) => Swapped::New(lib),
            Err(error) => reopen(error.to_string(), options),
        },
        Err(why) => reopen(why, options),
    }
}

/// The app takes up `lib`: `Services`, F3's automatic links, the Stats and
/// Review tabs, every window.
fn take_up(lib: Library, cx: &mut App) {
    lib.set_auto_links(crate::workspace::editors::editor_settings(cx).auto_entity_links);
    if cx.has_global::<Services>() {
        cx.global_mut::<Services>().library = Some(lib.clone());
    }
    dr_view_stats::init(Some(lib.clone()), cx);
    dr_view_review::init(Some(lib.clone()), cx);
    for handle in windows(cx) {
        let lib = lib.clone();
        if let Err(error) = handle.update(cx, |ws, window, cx| ws.adopt_library(lib, window, cx)) {
            log::warn!("a window could not take up the library: {error:#}");
        }
    }
}
