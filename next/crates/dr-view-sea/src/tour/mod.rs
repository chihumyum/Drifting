//! The workspace tour (M24, 「6 步导览」; the 0.1 client's
//! `features/guide/` and `shells/desktop/WorkspaceGuide.tsx`).
//!
//! The first time a book opens on this device, once the workspace has come
//! up uncovered, the tour waits [`START_DELAY`] and walks six steps, each
//! pointing at a real control ([`WORKSPACE_TOUR`]): the left sidebar's
//! Panel Tabs, a Super View entry, Project Home's 新建, the timeline's
//! toggle, the Agent's tab, the torii and the wind bell. A ring of waiting
//! glass (the accent, drifting on its own) stands 4px round the control,
//! round buttons keep it round; beside it the card in the hover card's
//! shell: the title with the step count in index type, one sentence, the
//! step's shortcuts in index type (no keycaps), then Skip, Back and Next
//! (Done on the last). Ring and card glide to the next control together on
//! the Dock pill's motion and the card's words fade in as a block; under
//! reduced motion everything lands at once. Nothing else is dimmed or
//! covered, so what the ring points at still works.
//!
//! A step whose control is put away points at what brings it out (a closed
//! sidebar's own toggle) with its other sentence, and moves onto the
//! control once it shows; a step with neither on screen is passed over,
//! going either way; if nothing is left the tour ends. Return walks it, Esc
//! skips it (while the card has the keyboard, which it takes when a step
//! comes up and gives back at the end). Finishing or skipping marks it seen
//! on this device ([`SeenStore`]); Settings can show it again
//! ([`reset_seen`]). Unlike the 0.1 client, a tour that never found a
//! control to point at ends without counting as seen. While a Super View
//! covers the workspace the tour is put away and starts again from the
//! first step when it closes.
//!
//! ## Who marks what
//!
//! Controls are marked with [`anchor`] under one of [`ids`]; the tour
//! never knows their types. Bounds are read in the frame they are drawn,
//! so a control that was not drawn is not on screen. This crate depends on
//! the shell, so the shell cannot call [`anchor`] from here: the anchor
//! reads nothing of the shell and can move below it (into dr-ui) as is.
//!
//! | Id | Control | Owner |
//! | --- | --- | --- |
//! | [`ids::LEFT_PANEL_TAB`] | every left Panel Tab label | shell |
//! | [`ids::LEFT_SIDEBAR_CLOSED_TOGGLE`] | the left toggle, only while closed | shell |
//! | [`ids::SUPER_VIEW_ENTRY`] | a panel head's Super View button | shell |
//! | [`ids::HOME_CREATE`] | Project Home's 新建 section | M02 |
//! | [`ids::TIMELINE_TOGGLE`] | the timeline toggle | shell |
//! | [`ids::AGENT_TAB`] | the Agent's Panel Tab label | shell |
//! | [`ids::RIGHT_SIDEBAR_CLOSED_TOGGLE`] | the right toggle, only while closed | shell |
//! | [`ids::PROJECT_HOME`], [`ids::NOTIFICATIONS`] | torii and wind bell | shell |
//!
//! ## Wiring
//!
//! ```ignore
//! dr_view_sea::tour::init(cx);                    // Return / Esc on the card
//! dr_view_sea::tour::set_seen_store(cx, store);   // the device's settings
//! // When a book's workspace first shows (under its opening wait is fine):
//! dr_view_sea::tour::maybe_start(window, cx);
//! // At the end of the workspace's root, every frame a book is open:
//! .children(dr_view_sea::tour::layer(covered, window, cx))
//! // Settings → Appearance → 引导 → 再次显示:
//! dr_view_sea::tour::reset_seen(cx);
//! ```

mod anchor;
pub mod geometry;
mod steps;
mod view;

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use gpui::{
    AnyElement, App, AppContext as _, Entity, Global, IntoElement, KeyBinding, Window, WindowId,
};

pub use anchor::{Anchor, Shown, anchor};
pub use steps::{
    Fallback, Pick, Shortcut, Step, Target, WORKSPACE_TOUR, WORKSPACE_TOUR_ID, ids, shortcut_text,
};
pub use view::{CARD_WIDTH, START_DELAY, TourState};

use view::TourView;

/// The card's key context.
pub const KEY_CONTEXT: &str = "DrTour";

gpui::actions!(
    tour,
    [
        /// The next step (Done on the last).
        Next,
        /// The step before.
        Back,
        /// Ends the tour; it counts as seen.
        Skip,
    ]
);

/// Return walks the tour and Esc skips it while the card has the keyboard.
pub fn key_bindings() -> Vec<KeyBinding> {
    let c = Some(KEY_CONTEXT);
    vec![
        KeyBinding::new("enter", Next, c),
        KeyBinding::new("escape", Skip, c),
    ]
}

/// Binds [`key_bindings`] through the shell's keymap, so they survive its
/// rebuilds. Call once.
pub fn init(cx: &mut App) {
    dr_shell::keymap::add_bindings(cx, key_bindings);
}

/// Where this device remembers the guides it has shown (the 0.1 client's
/// `guidesSeen` in its device-local settings; never synced). The app
/// provides it; without one, a run remembers in memory only.
pub trait SeenStore: 'static {
    fn is_seen(&self, guide: &str, cx: &App) -> bool;
    fn mark_seen(&self, guide: &str, cx: &mut App);
    /// Forgets every guide (Settings' 「再次显示」).
    fn reset(&self, cx: &mut App);
}

struct Seen(Rc<dyn SeenStore>);

impl Global for Seen {}

/// The store of a run without one: memory only.
#[derive(Default)]
struct ThisRun(RefCell<Vec<String>>);

impl SeenStore for ThisRun {
    fn is_seen(&self, guide: &str, _: &App) -> bool {
        self.0.borrow().iter().any(|g| g == guide)
    }

    fn mark_seen(&self, guide: &str, _: &mut App) {
        let mut seen = self.0.borrow_mut();
        if !seen.iter().any(|g| g == guide) {
            seen.push(guide.to_owned());
        }
    }

    fn reset(&self, _: &mut App) {
        self.0.borrow_mut().clear();
    }
}

/// Where "seen" is kept from now on.
pub fn set_seen_store(cx: &mut App, store: impl SeenStore) {
    cx.set_global(Seen(Rc::new(store)));
}

fn store(cx: &mut App) -> Rc<dyn SeenStore> {
    if !cx.has_global::<Seen>() {
        cx.set_global(Seen(Rc::new(ThisRun::default())));
    }
    cx.global::<Seen>().0.clone()
}

/// Whether this device has seen the workspace tour.
pub fn is_seen(cx: &App) -> bool {
    cx.try_global::<Seen>()
        .is_some_and(|s| s.0.clone().is_seen(WORKSPACE_TOUR_ID, cx))
}

fn mark_seen(guide: &str, cx: &mut App) {
    store(cx).mark_seen(guide, cx);
}

/// Shows the tour again the next time a book opens (Settings → Appearance
/// → 引导).
pub fn reset_seen(cx: &mut App) {
    store(cx).reset(cx);
}

/// The tour of each window.
#[derive(Default)]
struct Tours(HashMap<WindowId, Entity<TourView>>);

impl Global for Tours {}

fn tour_of(window: &Window, cx: &App) -> Option<Entity<TourView>> {
    cx.try_global::<Tours>()?
        .0
        .get(&window.window_handle().window_id())
        .cloned()
}

/// Starts the workspace tour in `window` unless this device has seen it or
/// it is already under way there. Call when a book's workspace shows; the
/// tour comes up [`START_DELAY`] after [`layer`] is first drawn uncovered.
/// Returns whether it started.
pub fn maybe_start(window: &mut Window, cx: &mut App) -> bool {
    if is_seen(cx) || tour_of(window, cx).is_some_and(|t| t.read(cx).running()) {
        return false;
    }
    let id = window.window_handle().window_id();
    let view = cx.new(|cx| TourView::new(id, WORKSPACE_TOUR_ID, &WORKSPACE_TOUR, cx));
    cx.default_global::<Tours>().0.insert(id, view);
    window.refresh();
    true
}

/// The tour's layer for the workspace's root: draw it last, every frame a
/// book is open, while it is `Some`. `covered`: a Super View or the opening
/// wait lies over the workspace (the tour is put away, and starts again
/// from the first step when uncovered).
pub fn layer(covered: bool, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let view = tour_of(window, cx)?;
    view.update(cx, |tour, cx| tour.set_covered(covered, window, cx));
    if !view.read(cx).running() {
        let id = window.window_handle().window_id();
        cx.default_global::<Tours>().0.remove(&id);
        return None;
    }
    Some(view.into_any_element())
}

/// Whether a tour is waiting or showing in `window`.
pub fn is_running(window: &Window, cx: &App) -> bool {
    tour_of(window, cx).is_some_and(|t| t.read(cx).running())
}

/// The step on screen in `window` and where its ring and card are heading.
pub fn current(window: &Window, cx: &App) -> Option<TourState> {
    tour_of(window, cx)?.read(cx).state()
}
