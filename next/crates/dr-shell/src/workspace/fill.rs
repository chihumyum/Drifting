//! Per-panel Fill (`铺满`, `kernel-v5.md` §17, `v5-tracks.md` T9), replacing
//! the whole-window Super View stage.
//!
//! Only one place (`Left`, `Right`, or `Bottom`) fills the middle column at a
//! time:
//! - Filling another place while one is already filled restores the previous
//!   place to its pre-fill `prev_open` state (`补定第 4 处选丙`: closed→filled
//!   returns to closed on swap; open→filled returns to open on swap).
//! - Exiting fill (`Esc`, clicking a dock pill, `ShowProjectHome`,
//!   `NewEntity`, `ToggleProjects`, `⌘[`, opening a page from inside a filled
//!   panel, clicking the black moon, or switching Right to `Stats`/`Agent`)
//!   returns to open.
//! - Clicking a filled sidebar's crescent moon exits fill and closes that
//!   sidebar together (`W25Final`).
//! - Fill is transient and never persisted in `BookLayout`.

use dr_ui::{anim, tokens::motion};
use gpui::{Context, Window};
use serde::{Deserialize, Serialize};

use super::Workspace;
use super::sidebar::{RightTab, Side};
use crate::nav::{Open, Target};

/// Narrowest width a filled sidebar may be dragged to when exposing paper beside it.
pub const MIN_FILL_WIDTH: f32 = 480.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FillPlace {
    Left,
    Right,
    Bottom,
}

impl FillPlace {
    pub const fn slug(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Bottom => "bottom",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoonHalf {
    LeftCrescent,
    LeftFull,
    RightCrescent,
    RightFull,
}

pub struct FillState {
    place: Option<FillPlace>,
    prev_open: bool,
    custom_width: Option<f32>,
    left: anim::Tween,
    right: anim::Tween,
    bottom: anim::Tween,
}

impl Default for FillState {
    fn default() -> Self {
        Self {
            place: None,
            prev_open: true,
            custom_width: None,
            left: anim::Tween::still(0.0),
            right: anim::Tween::still(0.0),
            bottom: anim::Tween::still(0.0),
        }
    }
}

impl FillState {
    pub fn active(&self) -> Option<FillPlace> {
        self.place
    }

    pub fn prev_open(&self) -> bool {
        self.prev_open
    }

    pub fn custom_width(&self) -> Option<f32> {
        self.custom_width
    }

    pub fn set_custom_width(&mut self, width: Option<f32>) {
        self.custom_width = width;
    }

    pub fn progress(&self, place: FillPlace) -> f32 {
        let now = anim::now();
        match place {
            FillPlace::Left => self.left.value(now),
            FillPlace::Right => self.right.value(now),
            FillPlace::Bottom => self.bottom.value(now),
        }
    }

    pub fn animating(&self) -> bool {
        let now = anim::now();
        !self.left.settled(now) || !self.right.settled(now) || !self.bottom.settled(now)
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    fn set_place(&mut self, next: Option<(FillPlace, bool)>, reduce: bool) {
        let now = anim::now();
        let active = next.map(|(p, _)| p);
        self.place = active;
        if let Some((_, prev_open)) = next {
            self.prev_open = prev_open;
        }
        self.custom_width = None;
        self.left.retarget_motion(
            if active == Some(FillPlace::Left) {
                1.0
            } else {
                0.0
            },
            now,
            motion::STRUCTURAL,
            reduce,
        );
        self.right.retarget_motion(
            if active == Some(FillPlace::Right) {
                1.0
            } else {
                0.0
            },
            now,
            motion::STRUCTURAL,
            reduce,
        );
        self.bottom.retarget_motion(
            if active == Some(FillPlace::Bottom) {
                1.0
            } else {
                0.0
            },
            now,
            motion::STRUCTURAL,
            reduce,
        );
    }
}

impl Workspace {
    pub(crate) fn set_tab_fill_layout(
        &mut self,
        tab: String,
        layout: crate::v3::tab_fill::FillLayout,
        cx: &mut Context<Self>,
    ) {
        if self.tab_fill_layouts.insert(tab, layout) != Some(layout) {
            self.changed(cx);
        }
    }

    pub fn filled(&self) -> Option<FillPlace> {
        self.fill.active()
    }

    pub fn is_filled(&self, place: FillPlace) -> bool {
        self.fill.active() == Some(place)
    }

    pub fn fill_progress(&self, place: FillPlace) -> f32 {
        self.fill.progress(place)
    }

    /// A filled panel covers the paper (and Project Home under it): the
    /// bottom one, or a side one not narrowed.
    pub fn fill_covers_paper(&self) -> bool {
        match self.filled() {
            Some(FillPlace::Bottom) => true,
            Some(FillPlace::Left | FillPlace::Right) => self.fill.custom_width().is_none(),
            None => false,
        }
    }

    pub fn fill_width(&self) -> Option<f32> {
        self.fill.custom_width()
    }

    /// Right sidebar can only fill when its focused pane is `Review` or `Library`.
    pub fn right_can_fill(&self) -> bool {
        matches!(
            self.right.panes.focused_tab(),
            RightTab::Review | RightTab::Library
        )
    }

    /// Maximum width a filled `side` sidebar occupies when un-narrowed: the
    /// window minus the opposite open sidebar's visible width.
    pub fn max_fill_width(&self, side: Side, window_w: f32) -> f32 {
        let other = match side {
            Side::Left => (self.right.width * self.right.shown()).round(),
            Side::Right => (self.left.width * self.left.shown()).round(),
        };
        (window_w - other).max(MIN_FILL_WIDTH)
    }

    /// Target width of `side` while filled (either narrowed `custom_width` or full middle+side).
    pub fn target_fill_width(&self, side: Side, window_w: f32) -> f32 {
        let max_w = self.max_fill_width(side, window_w);
        match self.fill.custom_width() {
            Some(fw) if self.can_drag_fill_edge(side) => fw.clamp(MIN_FILL_WIDTH, max_w),
            _ => max_w,
        }
    }

    /// Whether the inner edge of a filled `side` sidebar can be dragged to
    /// expose or re-cover the paper (`kernel-v5.md` §17 「宽窄」).
    pub fn can_drag_fill_edge(&self, side: Side) -> bool {
        match side {
            Side::Left => {
                self.is_filled(FillPlace::Left)
                    && (self.right.open || self.fill.custom_width().is_some())
            }
            Side::Right => {
                self.is_filled(FillPlace::Right)
                    && (self.left.open || self.fill.custom_width().is_some())
            }
        }
    }

    /// Width (in px) drawn for `side` on this frame, interpolating smoothly
    /// across Closed, Open, and Filled states (`motion::STRUCTURAL`).
    pub fn sidebar_drawn_widths(&self, side: Side, window_w: f32) -> (f32, f32) {
        let (base_w, shown, place) = match side {
            Side::Left => (self.left.width, self.left.shown(), FillPlace::Left),
            Side::Right => (self.right.width, self.right.shown(), FillPlace::Right),
        };
        let fill_t = self.fill.progress(place);
        if shown <= 0.0 && fill_t <= 0.0 {
            return (base_w, 0.0);
        }
        let open_vis = base_w * shown;
        let fill_target = self.target_fill_width(side, window_w);
        let visible = (open_vis + (fill_target - open_vis) * fill_t).round();
        let inner_w = if fill_t > 0.0 {
            (base_w + (fill_target - base_w) * fill_t).round()
        } else {
            base_w
        };
        (inner_w, visible)
    }

    pub fn enter_fill(
        &mut self,
        place: FillPlace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let reduce = self.reduce_motion(window, cx);
        if self.enter_fill_with_motion(place, reduce, cx) {
            self.refocus(window, cx);
            true
        } else {
            false
        }
    }

    pub fn enter_fill_with_motion(
        &mut self,
        place: FillPlace,
        reduce: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.modal() || (place == FillPlace::Right && !self.right_can_fill()) {
            return false;
        }
        if self.fill.active() == Some(place) {
            return true;
        }
        let mut layout_changed = false;
        if let Some(prev) = self.fill.active() {
            let restore_open = self.fill.prev_open();
            match prev {
                FillPlace::Left => {
                    if !restore_open && self.left.open {
                        self.left.set_open(false, reduce);
                        layout_changed = true;
                    }
                    self.want_template_structure = false;
                    if let Some(sb) = &self.v3_sidebar {
                        sb.update(cx, |s, cx| s.leave_fill(cx));
                    }
                }
                FillPlace::Right => {
                    if !restore_open && self.right.open {
                        self.right.set_open(false, reduce);
                        layout_changed = true;
                    }
                }
                FillPlace::Bottom => {}
            }
        }

        let was_open = match place {
            FillPlace::Left => {
                let was = self.left.open;
                if !was {
                    self.left.set_open(true, reduce);
                    layout_changed = true;
                }
                was
            }
            FillPlace::Right => {
                let was = self.right.open;
                if !was {
                    self.right.set_open(true, reduce);
                    layout_changed = true;
                }
                was
            }
            FillPlace::Bottom => {
                if self.bottom.layout.timeline_hidden || self.bottom.layout.planner_open {
                    self.bottom.layout.timeline_hidden = false;
                    self.bottom.layout.planner_open = false;
                    layout_changed = true;
                }
                true
            }
        };

        self.set_immersive(false, cx);
        self.fill.set_place(Some((place, was_open)), reduce);
        if layout_changed {
            self.changed(cx);
        } else {
            cx.notify();
        }
        true
    }

    /// Exits fill back to open (`left.open` / `right.open` remains `true`).
    pub fn exit_fill(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let reduce = self.reduce_motion(window, cx);
        self.exit_fill_with_motion(reduce, cx)
    }

    pub fn exit_fill_in_cx(&mut self, cx: &mut Context<Self>) -> bool {
        self.exit_fill_with_motion(self.editor_reduce, cx)
    }

    pub fn exit_fill_with_motion(&mut self, reduce: bool, cx: &mut Context<Self>) -> bool {
        let Some(prev) = self.fill.active() else {
            return false;
        };
        if prev == FillPlace::Left {
            self.want_template_structure = false;
            self.want_new_template = false;
            if let Some(sb) = &self.v3_sidebar {
                sb.update(cx, |s, cx| s.leave_fill(cx));
            }
        }
        self.fill.set_place(None, reduce);
        cx.notify();
        true
    }

    pub fn toggle_fill(&mut self, place: FillPlace, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_filled(place) {
            self.exit_fill(window, cx);
        } else {
            self.enter_fill(place, window, cx);
        }
    }

    /// Crescent button of the overlapping moon pair (`W25Final`):
    /// - Closed → Open
    /// - Open → Closed
    /// - Filled → Closed (exits fill and closes the sidebar together)
    pub fn click_crescent(&mut self, side: Side, window: &mut Window, cx: &mut Context<Self>) {
        let reduce = self.reduce_motion(window, cx);
        match side {
            Side::Left => {
                if !self.left.open {
                    self.left.set_open(true, reduce);
                } else {
                    if self.is_filled(FillPlace::Left) {
                        self.want_template_structure = false;
                        if let Some(sb) = &self.v3_sidebar {
                            sb.update(cx, |s, cx| s.leave_fill(cx));
                        }
                        self.fill.set_place(None, reduce);
                    }
                    self.left.set_open(false, reduce);
                }
                if self.is_filled(FillPlace::Right) {
                    self.fill.set_custom_width(None);
                }
            }
            Side::Right => {
                if !self.right.open {
                    self.right.set_open(true, reduce);
                } else {
                    if self.is_filled(FillPlace::Right) {
                        self.fill.set_place(None, reduce);
                    }
                    self.right.set_open(false, reduce);
                }
                if self.is_filled(FillPlace::Left) {
                    self.fill.set_custom_width(None);
                }
            }
        }
        self.changed(cx);
    }

    /// Full / Black moon button of the overlapping moon pair (`W25Final`):
    /// - Closed → Filled (opens the sidebar and fills together)
    /// - Open → Filled
    /// - Filled → Open
    pub fn click_full_moon(&mut self, side: Side, window: &mut Window, cx: &mut Context<Self>) {
        let place = match side {
            Side::Left => FillPlace::Left,
            Side::Right => FillPlace::Right,
        };
        if self.is_filled(place) {
            self.exit_fill(window, cx);
        } else {
            self.enter_fill(place, window, cx);
        }
    }

    /// Fills the left sidebar and switches it into `模板结构` (`W12Template`, `W30Home`).
    pub fn open_template_structure(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.enter_fill(FillPlace::Left, window, cx) {
            return;
        }
        if let Some(sb) = self.v3_sidebar.clone() {
            sb.update(cx, |s, cx| s.enter_structure(window, cx));
        } else {
            self.want_template_structure = true;
        }
        cx.notify();
    }

    /// 「新建模板」 while the left column fills (`kernel-v5.md` §9): the
    /// structure comes up with a new template in its floating panel; it is
    /// stored once the author changes something in it.
    pub fn new_template_in_structure(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_filled(FillPlace::Left) {
            return;
        }
        if let Some(sb) = self.v3_sidebar.clone() {
            sb.update(cx, |s, cx| {
                s.enter_structure(window, cx);
                s.new_structure_template(window, cx);
            });
        } else {
            self.want_template_structure = true;
            self.want_new_template = true;
        }
        cx.notify();
    }

    /// Esc over a filled left column: closes the structure's floating
    /// panel, when one is open. Whether there was one.
    pub(super) fn close_fill_panel(&mut self, cx: &mut Context<Self>) -> bool {
        self.is_filled(FillPlace::Left)
            && self
                .v3_sidebar
                .clone()
                .is_some_and(|sb| sb.update(cx, |s, cx| s.close_structure_panel(cx)))
    }

    /// Opens `target` on the paper beside a narrowed Left fill (`完整编辑`,
    /// `W12Template` 42甲) without exiting fill.
    pub fn open_alongside_fill(
        &mut self,
        target: Target,
        how: Open,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_filled(FillPlace::Left) {
            let window_w = f32::from(window.viewport_size().width);
            let max_w = self.max_fill_width(Side::Left, window_w);
            let narrowed = (max_w * 0.55).round().max(MIN_FILL_WIDTH);
            self.fill.set_custom_width(Some(narrowed));
        }
        self.open_page(target, how, cx);
    }
}
