//! The Bottom Panel under the paper (the 0.1 client's `TimelineDrawer` and
//! `BottomPanel`): one place in the middle column, between the sidebars,
//! holding the timeline (M14) or the plot planner (M15) of the chapter in
//! front, never both.
//!
//! - **What shows**: nothing in immersive writing; the planner while it is
//!   open and a chapter or idea is in front (elsewhere the panel closes and
//!   comes back with the next chapter, the choice kept); else the timeline
//!   unless it is hidden. Opening the planner hides the timeline, showing
//!   the timeline closes the planner (the 0.1 `ui-store` rules).
//! - **Toggles**: ⌘J ([`crate::actions::ToggleBottomTimeline`]) and the
//!   bamboo in the paper's corner (left of the tray) for the timeline; the
//!   tray's first button, on a chapter or idea, for the planner. Each shows
//!   only when a module draws its pane ([`crate::pages::add_bottom_panel`]).
//! - **Height**: one for both panes, 180 at first; the top edge drags it
//!   (the grabbed point stays under the pointer), from 180 or the pane's own
//!   least height up to the column less 240 for the paper. A height kept
//!   from a taller window is clamped when drawn, not rewritten.
//! - **Slide**: the panel opens and shuts like the sidebars (STRUCTURAL);
//!   while it shuts it keeps showing what it held. Swapping the timeline for
//!   the planner replaces it at once (the 0.1 push is not drawn yet).
//! - **Kept**: whether the timeline is hidden, whether the planner is open,
//!   and the height, in the book's local layout ([`super::BookLayout`]).
//!
//! The timeline is made once per window and book (it is made as the panel
//! starts to open, and reads while it slides), a planner once per chapter
//! or idea in front (the one before is let go, and it goes when the
//! timeline takes its place); both go with the library
//! ([`super::Workspace::let_go_of_library`]).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use dr_ui::{Theme, anim, tokens::motion};
use gpui::{
    AnyElement, App, AppContext as _, Context, DragMoveEvent, InteractiveElement as _,
    IntoElement as _, MouseButton, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use serde::{Deserialize, Serialize};

use super::Workspace;
use super::sidebar::NoPreview;
use crate::book::Book;
use crate::nav::Target;
use crate::pages::{self, BottomHost, BottomPane, BottomPanel};

/// The panel's height the first time it opens.
pub const DEFAULT_HEIGHT: f32 = 180.0;
/// The least the panel can be dragged to.
pub const MIN_HEIGHT: f32 = 180.0;
/// How much of the paper stays above the panel.
pub const MIN_PAPER_HEIGHT: f32 = 240.0;
/// The top edge's grip.
const GRIP: f32 = 4.0;

/// The panel as the book's local layout keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BottomLayout {
    /// The timeline was put away (⌘J, the bamboo).
    pub timeline_hidden: bool,
    /// The planner is open (it shows while a chapter or idea is in front).
    pub planner_open: bool,
    pub height: f32,
}

impl Default for BottomLayout {
    fn default() -> Self {
        BottomLayout {
            timeline_hidden: false,
            planner_open: false,
            height: DEFAULT_HEIGHT,
        }
    }
}

/// What the top edge drags.
#[derive(Clone, Copy, Debug)]
pub struct BottomResize;

/// The panel's state in a window.
pub struct Bottom {
    pub layout: BottomLayout,
    reveal: anim::Tween,
    /// The pane shown last: it stays while the panel slides shut.
    last: BottomPane,
    /// Each pane as made, with the page or book it was made for.
    made: RefCell<HashMap<BottomPane, (String, Option<BottomPanel>)>>,
    /// The book the made panes last heard of.
    seen: Option<Rc<Book>>,
    /// How far below the top edge the pointer took it.
    grab: f32,
    /// Drawn since the book opened: the first draw does not slide.
    drawn: bool,
}

impl Bottom {
    pub fn new(layout: BottomLayout) -> Bottom {
        Bottom {
            layout,
            reveal: anim::Tween::still(0.0),
            last: BottomPane::Timeline,
            made: RefCell::default(),
            seen: None,
            grab: 0.0,
            drawn: false,
        }
    }

    /// Lets go of every pane made (another book, another library).
    pub(super) fn forget(&mut self) {
        self.made.borrow_mut().clear();
        self.seen = None;
        self.drawn = false;
    }

    /// How much of the panel shows now, 0–1.
    pub fn shown(&self) -> f32 {
        self.reveal.value(anim::now())
    }
}

/// The least and most the panel can be in a column `column_h` tall while
/// `pane` shows.
fn bounds(pane_min: f32, column_h: f32) -> (f32, f32) {
    let max = (column_h - MIN_PAPER_HEIGHT).max(MIN_HEIGHT);
    (pane_min.max(MIN_HEIGHT).min(max), max)
}

impl Workspace {
    /// What the Bottom Panel shows now, if anything.
    pub fn bottom_pane(&self, cx: &App) -> Option<BottomPane> {
        if self.immersive || self.book_id.is_empty() {
            return None;
        }
        let planned = matches!(
            self.nav.current(),
            Some(Target::Chapter(_) | Target::Idea(_))
        );
        if self.bottom.layout.planner_open {
            return (planned && pages::has_bottom_panel(BottomPane::Planner, cx))
                .then_some(BottomPane::Planner);
        }
        (!self.bottom.layout.timeline_hidden && pages::has_bottom_panel(BottomPane::Timeline, cx))
            .then_some(BottomPane::Timeline)
    }

    /// ⌘J and the bamboo: shows the timeline (closing the planner), or puts
    /// it away.
    pub fn toggle_timeline(&mut self, cx: &mut Context<Self>) {
        let b = &mut self.bottom.layout;
        if b.timeline_hidden || b.planner_open {
            b.timeline_hidden = false;
            b.planner_open = false;
        } else {
            b.timeline_hidden = true;
        }
        self.changed(cx);
    }

    /// The planner's button: opens it (the timeline goes), or closes it.
    pub fn toggle_planner(&mut self, cx: &mut Context<Self>) {
        let b = &mut self.bottom.layout;
        if b.planner_open {
            b.planner_open = false;
        } else {
            b.planner_open = true;
            b.timeline_hidden = true;
        }
        self.changed(cx);
    }

    /// The panel's kept height.
    pub fn bottom_height(&self) -> f32 {
        self.bottom.layout.height
    }

    pub fn set_bottom_height(&mut self, height: f32, cx: &mut Context<Self>) {
        self.bottom.layout.height = height.max(MIN_HEIGHT);
        self.changed(cx);
    }

    /// The view `pane` shows, once made (tests, the debug bridge).
    pub fn bottom_view(&self, pane: BottomPane) -> Option<gpui::AnyView> {
        self.bottom
            .made
            .borrow()
            .get(&pane)
            .and_then(|(_, made)| made.as_ref().map(|p| p.view.clone()))
    }

    fn bottom_host(&self, cx: &Context<Self>) -> BottomHost {
        BottomHost {
            workspace: cx.weak_entity(),
            library: self.library.clone(),
            book_id: self.book_id.clone(),
            book: self.book.clone(),
            target: self.nav.current().cloned(),
        }
    }

    /// `pane`'s view for the page in front, made when it is not yet.
    fn bottom_panel(
        &mut self,
        pane: BottomPane,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<BottomPanel> {
        let key = match pane {
            BottomPane::Timeline => self.book_id.clone(),
            BottomPane::Planner => self.nav.current().map(Target::key).unwrap_or_default(),
        };
        if let Some((made_for, made)) = self.bottom.made.borrow().get(&pane)
            && *made_for == key
        {
            return made.clone();
        }
        let host = self.bottom_host(cx);
        let made = pages::bottom_panel_for(pane, &host, window, cx);
        self.bottom
            .made
            .borrow_mut()
            .insert(pane, (key, made.clone()));
        made
    }

    /// The book's lists changed: the panes kept hear of it.
    fn refresh_bottom(&mut self, cx: &mut Context<Self>) {
        if self
            .bottom
            .seen
            .as_ref()
            .is_some_and(|seen| Rc::ptr_eq(seen, &self.book))
        {
            return;
        }
        self.bottom.seen = Some(self.book.clone());
        let refreshes: Vec<_> = self
            .bottom
            .made
            .borrow()
            .values()
            .filter_map(|(_, made)| made.as_ref()?.refresh.clone())
            .collect();
        if refreshes.is_empty() {
            return;
        }
        let host = self.bottom_host(cx);
        cx.defer(move |cx| {
            for refresh in refreshes {
                refresh(&host, cx);
            }
        });
    }
}

/// The top edge dragged.
pub(super) fn on_resize(
    ws: &mut Workspace,
    e: &DragMoveEvent<BottomResize>,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    let column_h = f32::from(window.viewport_size().height);
    let pane_min = ws.bottom_min(cx);
    let (min, max) = bounds(pane_min, column_h);
    let top = f32::from(e.event.position.y) - ws.bottom.grab;
    let height = (column_h - top).clamp(min, max).round();
    if height != ws.bottom.layout.height {
        ws.bottom.layout.height = height;
        ws.changed(cx);
    }
}

impl Workspace {
    /// The least height of the pane shown.
    fn bottom_min(&self, cx: &App) -> f32 {
        let pane = self.bottom.last;
        self.bottom
            .made
            .borrow()
            .get(&pane)
            .and_then(|(_, made)| made.as_ref()?.min_height.clone())
            .map_or(MIN_HEIGHT, |min| min(cx))
    }
}

/// The panel under the paper and how tall it is drawn (as much of it as
/// shows); `None` while shut.
pub(super) fn panel(
    ws: &mut Workspace,
    column_h: f32,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Option<(AnyElement, f32)> {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let want = ws.bottom_pane(cx);
    if let Some(pane) = want {
        ws.bottom.last = pane;
    }
    let now = anim::now();
    let to = if want.is_some() { 1.0 } else { 0.0 };
    if std::mem::replace(&mut ws.bottom.drawn, true) {
        ws.bottom
            .reveal
            .retarget_motion(to, now, motion::STRUCTURAL, theme.reduce_motion);
    } else {
        ws.bottom.reveal.set(to);
    }
    let shown = ws.bottom.reveal.value(now);
    anim::keep_going(!ws.bottom.reveal.settled(now), window);
    ws.refresh_bottom(cx);
    // The planner goes once the timeline shows instead; while the panel is
    // only shut (no chapter in front) it waits for its chapter, and another
    // chapter's replaces it ([`Workspace::bottom_panel`]).
    if ws.bottom.last == BottomPane::Timeline {
        ws.bottom.made.borrow_mut().remove(&BottomPane::Planner);
    }
    // About to open: made now, so it reads while it slides in.
    if shown <= 0.0 && want.is_none() {
        return None;
    }
    let pane = ws.bottom.last;
    let made = ws.bottom_panel(pane, window, cx)?;
    // The pane's own least height counts while the edge is dragged (as in
    // the 0.1 client), not on every frame.
    let (min, max) = bounds(MIN_HEIGHT, column_h);
    let height = ws.bottom.layout.height.clamp(min, max);
    let visible = (height * shown).round();
    let grip = div()
        .id("bottom-panel-grip")
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .h(px(GRIP))
        .cursor_row_resize()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |ws, e: &gpui::MouseDownEvent, window, _| {
                let top = f32::from(window.viewport_size().height) - visible;
                ws.bottom.grab = f32::from(e.position.y) - top;
            }),
        )
        .on_drag(BottomResize, |_, _, _, cx| cx.new(|_| NoPreview));
    Some((
        div()
            .id("bottom-panel")
            .relative()
            .flex_none()
            .w_full()
            .h(px(visible))
            .overflow_hidden()
            .when(!ws.ebbing(), |el| el.bg(p.desk.solid()))
            .border_t_1()
            .border_color(p.local_hairline())
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(height))
                    .flex()
                    .flex_col()
                    .child(div().flex_1().min_h_0().size_full().child(made.view)),
            )
            .child(grip)
            .into_any_element(),
        visible,
    ))
}
