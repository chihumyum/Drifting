//! The red light in a project template's working copy (`project-templates.md`
//! §12, PT3): the window steps back to 全部项目 instead of closing.
//!
//! - What floats over the page goes first (a dialog, snapshot history,
//!   Settings, search, the comment composer), so nothing is left over
//!   全部项目 still writing into the copy.
//! - The keyboard leaves the page and the window draws at once: GPUI tells a
//!   field it lost the keyboard on the next frame, so without the draw the
//!   field would hand over what is typed in it only after the copy is saved.
//! - Then the views' accepted drafts settle ([`crate::release::settle`]) and
//!   the copy is saved over its template (`flush_working_copies`) off the
//!   main thread, under a barrier the library's release waits for; a failure
//!   says 「保存未完成，请重试。」 at the window's foot.

use std::sync::{Arc, Mutex};

use dr_i18n::keys;
use dr_workspace::Workspace as Library;
use futures::{FutureExt as _, channel::oneshot, future::LocalBoxFuture};
use gpui::{App, AppContext as _, Context, Global, Window};

use super::Workspace;

/// Saves of working copies on their way: the library is not let go of
/// before they are done.
#[derive(Clone, Default)]
struct Saves(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    active: usize,
    waiters: Vec<oneshot::Sender<()>>,
}

impl Global for Saves {}

struct Lease {
    library: Option<Library>,
    saves: Saves,
}

impl std::ops::Deref for Lease {
    type Target = Library;

    fn deref(&self) -> &Library {
        self.library.as_ref().expect("an active working-copy save")
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.library.take();
        let mut state = self.saves.0.lock().unwrap_or_else(|e| e.into_inner());
        state.active = state.active.saturating_sub(1);
        if state.active == 0 {
            for tx in std::mem::take(&mut state.waiters) {
                let _ = tx.send(());
            }
        }
    }
}

impl Saves {
    /// The barrier, registered with the release gate the first time.
    fn of(cx: &mut App) -> Saves {
        if let Some(saves) = cx.try_global::<Saves>() {
            return saves.clone();
        }
        let saves = Saves::default();
        cx.set_global(saves.clone());
        crate::release::before_release(cx, |cx| cx.global::<Saves>().drained());
        saves
    }

    fn enter(&self, library: Library) -> Lease {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).active += 1;
        Lease {
            library: Some(library),
            saves: self.clone(),
        }
    }

    fn drained(&self) -> LocalBoxFuture<'static, Result<(), String>> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.active == 0 {
            return async { Ok(()) }.boxed_local();
        }
        let (tx, rx) = oneshot::channel();
        state.waiters.push(tx);
        async {
            rx.await
                .map_err(|_| "working-copy save barrier disappeared".into())
        }
        .boxed_local()
    }
}

impl Workspace {
    /// Whether the window shows a project template's working copy.
    pub(super) fn in_working_copy(&self) -> bool {
        !self.shelf_open
            && !self.book_id.is_empty()
            && self
                .library
                .as_ref()
                .is_some_and(|lib| super::is_working_copy(lib, &self.book_id))
    }

    /// The first half of leaving a working copy: what floats over the page
    /// closes and the keyboard leaves it. The caller draws the window next.
    pub(super) fn close_over_working_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog = None;
        self.history = None;
        self.search = None;
        self.composer = None;
        if self.settings.take().is_some() {
            crate::settings::panel_closed(window.window_handle().window_id(), cx);
        }
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// The second half, once the page's fields have handed over what is
    /// typed in them: settle the views' drafts, then save the copy over its
    /// template now.
    pub(super) fn save_left_working_copy(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.library.clone() else {
            return;
        };
        // A release in progress saves the copies itself (`Workspace::close`).
        if crate::release::is_releasing(cx) {
            return;
        }
        let lease = Saves::of(cx).enter(lib);
        let settled = crate::release::settle(cx);
        cx.spawn(async move |this, cx| {
            let settled = settled.await;
            let saved = cx
                .background_spawn(
                    async move { lease.flush_working_copies().map_err(|e| e.to_string()) },
                )
                .await;
            if let Err(error) = settled.and(saved) {
                log::warn!("leaving the template's working copy did not save it: {error}");
                this.update(cx, |ws, cx| {
                    let text = crate::t(cx, keys::common::SAVE_FAILED);
                    ws.toast_error(text, cx);
                })
                .ok();
            }
        })
        .detach();
    }
}
