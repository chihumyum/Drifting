//! Swapping the library under the running app (M41's restore: the dialog in
//! dr-view-transfer replaces the library with a backup's). Only the shell
//! knows everything that holds the library, so it is the one to let go of
//! it, have it replaced, and take the new one up.
//!
//! [`replace`]:
//!
//! 1. The shared release gate freezes new service work and awaits every
//!    registered asynchronous shutdown. If preparation fails, the original
//!    library and windows stay in place and services resume.
//! 2. The Markdown folder makes a last pass and stops (M40). Every
//!    workspace window lets go: its open pages' editors, the
//!    bookshelf and Project Home, search, snapshot history, the comment
//!    composer, its subscription; M07's recorder stores its writing days and
//!    stops, the Stats and Review tabs let go; `Services` no longer offers
//!    the library. A dialog over the window (the one asking for the swap)
//!    stays. The windows draw their empty-library frame before closing:
//!    what the last frame's handlers held (an editor in a click handler)
//!    goes with that frame.
//! 3. Off the main thread F3 brings the open documents' index up to date and
//!    closes the library (`Workspace::try_shutdown`, which waits for the
//!    last holders), then the job runs with the library closed: given where
//!    the library lives and how it is opened (this device's identity among
//!    it), it returns the library to use (`Library::restore_staged`). When
//!    something still holds the library, F3 hands the workspace back open
//!    and the job does not run: the windows take that workspace up again
//!    and `done` hears why.
//! 4. The new library is opened as F3's workspace and taken up: `Services`,
//!    automatic links, the Stats and Review tabs, every window (which shows
//!    the bookshelf, or without one the book opened last).
//! 5. If the job fails, the library it left in place is opened again and
//!    taken up the same way; `done` hears why. In either case release hooks
//!    resume against the current `Services` before `done` runs.
//!
//! The job's error and anything that goes wrong on the way reach `done` as
//! words for the dialog. Should the library neither close nor come back
//! (F3 could not reopen the workspace it refused to close), or not open
//! again after the job, `done` hears that too and the windows stay without
//! a library: quitting and starting again is the way back.

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
    /// The library it left in place, opened again (or never closed), and
    /// why the job failed or did not run.
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
    if crate::release::is_releasing(cx) {
        cx.defer(move |cx| done(Err("a library release is already in progress".into()), cx));
        return;
    }
    let Some(old) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
        cx.defer(move |cx| done(Err("no library is open".into()), cx));
        return;
    };
    let prepare = crate::release::begin(cx).expect("release gate checked in this dispatch");
    cx.defer(move |cx| {
        cx.spawn(async move |cx| {
            let prepared = prepare.await;
            cx.update(move |cx| {
                if let Err(why) = prepared {
                    crate::release::finish(cx);
                    done(Err(why), cx);
                    return;
                }
                let root = old.library().paths().root.clone();
                let options = old.library().options().clone();
                let_go(cx);
                release_frames(cx);
                cx.spawn(async move |cx| {
                    let swapped = cx
                        .background_executor()
                        .spawn(async move { swap(old, &root, options, job) })
                        .await;
                    cx.update(|cx| {
                        let result = match swapped {
                            Swapped::New(lib) => {
                                take_up(lib, cx);
                                Ok(())
                            }
                            Swapped::Old(lib, why) => {
                                take_up(lib, cx);
                                Err(why)
                            }
                            Swapped::Lost(why) => {
                                log::error!("the library is gone: {why}");
                                Err(why)
                            }
                        };
                        crate::release::finish(cx);
                        done(result, cx);
                    });
                })
                .detach();
            });
        })
        .detach();
    });
}

/// The asynchronous prepare can finish after a window's current frame. Its
/// old click/input handlers still own editors until a new frame replaces
/// them. Draw that empty-library frame before starting shutdown, rather than
/// relying on the platform's next frame racing the background close. Use the
/// erased handle so the root entity is not checked out while it renders.
fn release_frames(cx: &mut App) {
    for handle in windows(cx) {
        let handle: gpui::AnyWindowHandle = handle.into();
        if let Err(error) = handle.update(cx, |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        }) {
            log::warn!("a window could not release its previous frame: {error:#}");
        }
    }
}

/// Everything in the app that holds the library lets go of it.
fn let_go(cx: &mut App) {
    // The Markdown folder first: a last pass while the library is open.
    crate::mirror::stop(cx);
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
    let reopen = |why: String, options: LibraryOptions| match StoreLibrary::open(root, options)
        .map_err(|e| e.to_string())
        .and_then(|lib| Library::open(lib, WorkspaceOptions::default()).map_err(|e| e.to_string()))
    {
        Ok(lib) => Swapped::Old(lib, why),
        Err(error) => Swapped::Lost(format!(
            "{why}; the library could not be opened again: {error}"
        )),
    };
    if let Err(refused) = old.try_shutdown() {
        let why = format!("the library could not be closed: {}", refused.error);
        return match refused.workspace {
            // Still open as before: carry on with it.
            Some(kept) => Swapped::Old(kept, why),
            // F3 let go of it and could not open a workspace over it again.
            None => reopen(why, options),
        };
    }
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
    crate::mirror::restart(cx);
    for handle in windows(cx) {
        let lib = lib.clone();
        if let Err(error) = handle.update(cx, |ws, window, cx| ws.adopt_library(lib, window, cx)) {
            log::warn!("a window could not take up the library: {error:#}");
        }
    }
}
