//! The sea of characters under the window (M24, registered by
//! `dr-view-sea` through [`crate::pages::set_backdrop`]), the first run and
//! the workspace tour, as the shell drives them (m24-sea.md, 「怎么接」):
//!
//! - **Backdrop**: the window root's first child, under the bookshelf and
//!   the workspace alike.
//! - **Holds**: the bookshelf holds the sea as a surface while it shows;
//!   opening a book holds it as a full-window wait until the page in front
//!   is ready (at most 2 s; a wait that showed, past 240 ms, stays at least
//!   600 ms), and lets go of the bookshelf's hold in the same frame; a
//!   library swap holds it until the new library is taken up. While the
//!   wait holds, the window shows only the sea.
//! - **Ebb**: after the last hold lets go the sea ebbs a few seconds; the
//!   workspace leaves its desk colour to it and the sidebars and the Bottom
//!   Panel lie on it as bare glass.
//! - **First run**: the first time the app opens on this device (device
//!   value `first_run.done`), the first run lies over the bookshelf, which
//!   is drawn under it once it says so.
//! - **Tour**: started when a book's workspace first shows; its layer is
//!   the root's last child, covered by a Super View or the wait.

use std::any::Any;
use std::time::{Duration, Instant};

use gpui::{AnyElement, Context, IntoElement as _, Window};

use super::Workspace;
use crate::Settings;
use crate::pages::{self, FirstRunPage, SeaHold};

/// The device value: the first run is over.
pub const FIRST_RUN_DONE: &str = "first_run.done";
/// A full-window wait lets go by then even when the page is not ready.
pub const OPENING_LIMIT: Duration = Duration::from_millis(2000);
/// A wait shows past this (the sea's loading delay) …
pub const OPENING_SHOWS: Duration = Duration::from_millis(240);
/// … and then stays at least this long.
pub const OPENING_STAYS: Duration = Duration::from_millis(600);

/// The window's holds on the sea, its first run and its tour.
#[derive(Default)]
pub struct SeaState {
    shelf: Option<Box<dyn Any>>,
    waiting: Option<Box<dyn Any>>,
    /// When the wait began, for a book being opened (`None`: a swap,
    /// let go when the library is taken up).
    opening_since: Option<Instant>,
    pub(crate) first_run: Option<FirstRunPage>,
    /// The book the tour was offered in.
    guided: Option<String>,
}

impl SeaState {
    /// A full-window wait holds the sea.
    pub fn waiting(&self) -> bool {
        self.waiting.is_some()
    }

    /// The first run lies over the bookshelf.
    pub fn first_run_shows(&self) -> bool {
        self.first_run.is_some()
    }
}

impl Workspace {
    /// The sea, drawn first under the window's root, when registered.
    pub(super) fn backdrop(window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let backdrop = pages::backdrop(cx)?;
        Some((backdrop.draw)(window, cx))
    }

    /// The sea is ebbing: no desk colour, the sidebars on it.
    pub(super) fn sea_ebbs(window: &mut Window, cx: &mut Context<Self>) -> bool {
        pages::backdrop(cx).is_some_and(|b| (b.ebbing)(window, cx))
    }

    /// `el` lying on the sea while it ebbs; itself otherwise.
    pub(super) fn on_sea(id: &str, el: AnyElement, ebbing: bool, cx: &Context<Self>) -> AnyElement {
        match pages::backdrop(cx).filter(|_| ebbing) {
            Some(b) => (b.on_sea)(id.to_owned().into(), el),
            None => el,
        }
    }

    fn hold(kind: SeaHold, window: &mut Window, cx: &mut Context<Self>) -> Option<Box<dyn Any>> {
        let backdrop = pages::backdrop(cx)?;
        Some((backdrop.hold)(kind, window, cx))
    }

    /// The bookshelf shows: it lies on the sea.
    pub(super) fn sea_shelf(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sea.shelf.is_none() {
            self.sea.shelf = Self::hold(SeaHold::Surface, window, cx);
        }
    }

    /// A book is being opened: a full-window wait until its page is ready.
    pub(super) fn sea_opening(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if pages::backdrop(cx).is_none() {
            return;
        }
        self.sea.waiting = Self::hold(SeaHold::Loading, window, cx);
        self.sea.opening_since = Some(Instant::now());
    }

    /// The library is being swapped: a full-window wait until it is taken
    /// up again.
    pub(super) fn sea_swapping(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sea.waiting = Self::hold(SeaHold::Loading, window, cx);
        self.sea.opening_since = None;
    }

    /// The swapped library is taken up: the wait lets go.
    pub(super) fn sea_swapped(&mut self) {
        if self.sea.opening_since.is_none() {
            self.sea.waiting = None;
        }
    }

    /// While a book is opening: whether the wait still holds. It lets go
    /// (with the bookshelf's hold, in the same frame) once the page in front
    /// is ready, kept 600 ms once it showed, or after 2 s.
    pub(super) fn sea_settle(&mut self, window: &mut Window) -> bool {
        let Some(since) = self.sea.opening_since else {
            if self.sea.waiting.is_none() {
                self.sea.shelf = None;
            }
            return self.sea.waiting.is_some();
        };
        let waited = since.elapsed();
        let ready = !self.book.is_empty()
            && self
                .nav
                .current()
                .is_none_or(|target| self.page_view(target).is_some());
        let showed = waited >= OPENING_SHOWS;
        let done = waited >= OPENING_LIMIT
            || (ready && (!showed || waited >= OPENING_SHOWS + OPENING_STAYS));
        if done {
            self.sea.waiting = None;
            self.sea.shelf = None;
            self.sea.opening_since = None;
            return false;
        }
        window.request_animation_frame();
        true
    }

    /// The first time the app opens on this device, the first run over the
    /// bookshelf; when it is over, the device remembers.
    pub(super) fn sea_first_run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let seen = Settings::device_memory(cx, FIRST_RUN_DONE)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if seen {
            return;
        }
        let this = cx.weak_entity();
        let done: pages::FirstRunDone = std::rc::Rc::new(move |_, cx| {
            Settings::set_device_memory(cx, FIRST_RUN_DONE, Some(true.into()));
            this.update(cx, |ws, cx| {
                ws.sea.first_run = None;
                cx.notify();
            })
            .ok();
        });
        self.sea.first_run = pages::make_first_run(done, window, cx);
    }

    /// A book's workspace shows: the tour, once per book opened (the tour
    /// itself knows whether this device saw it).
    pub(super) fn sea_guide(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(guide) = pages::guide(cx) else {
            return;
        };
        if self.book.is_empty() || self.sea.guided.as_deref() == Some(self.book_id.as_str()) {
            return;
        }
        self.sea.guided = Some(self.book_id.clone());
        cx.defer_in(window, move |_, window, cx| (guide.start)(window, cx));
    }

    /// The tour's layer, the root's last child.
    pub(super) fn guide_layer(
        &self,
        covered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let guide = pages::guide(cx)?;
        (guide.layer)(covered, window, cx)
    }
}

/// The first run over the bookshelf, and whether the bookshelf shows under
/// it yet.
pub(super) fn first_run_layer(ws: &Workspace, cx: &gpui::App) -> Option<(AnyElement, bool)> {
    let page = ws.sea.first_run.as_ref()?;
    Some((page.view.clone().into_any_element(), (page.shows_shelf)(cx)))
}
