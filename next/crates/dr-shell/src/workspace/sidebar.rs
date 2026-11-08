//! The two sidebars (workspace.md): a drawer from each window edge, one or
//! two halves, each half its own tab row over its own panel.
//!
//! - Left: 章节 / 要素 / 构想; right: 审阅 / 素材库 / 统计 / 帮手.
//! - Opening and closing is the structural motion (420 ms); switching a
//!   half's tab pushes its panel like a block of ice (265 ms), and the glass
//!   block under the tab rides the same push.
//! - A half's minimum width is its tab row's; two halves fit when the
//!   sidebar is twice that plus the hairline between them.
//! - The left panels and the material library list the book from F3's
//!   queries (chapters by storyline or the whole book, elements by category,
//!   ideas by group, materials by folder); their modules (M-chapters,
//!   M-elements, …) add hover cards, sorting and editing. Stats is M07's
//!   (`dr-view-stats`); review and the Agent are empty until theirs arrive.
//! - The chapter panel (M04): its summary line switches between the
//!   storylines and the whole book in reading order, where each act starts
//!   with its heading (第N幕 · name). A chapter cell can be picked up and
//!   dropped on another chapter: it moves to that place in reading order
//!   (F3's `chapter.move`), into that act if the place is in another.

use std::collections::HashSet;
use std::rc::Rc;
use std::time::SystemTime;

use dr_i18n::{Key, keys};
use dr_ui::{
    Theme, anim,
    components::{
        Button, IconButton, Layer as FloatLayer, PanelIconButton, Place, SandCell, Segmented,
        menu::{float_shadow, slab_edge},
        overlay,
    },
    fonts::{Role, weight},
    glass::{self, Ground},
    sand::{self, Icon},
    style::DrStyled,
    tokens::{Rgb, glass as g, menu as m, motion, radius},
    transitions::Push,
};
use dr_workspace::dto::{ActInfo, GroupInfo};
use gpui::{
    AnyElement, App, AppContext as _, Context, DragMoveEvent, ElementId, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, TextRun,
    Window, div, prelude::FluentBuilder as _, px, uniform_list,
};
use serde::{Deserialize, Serialize};

use super::chapter_sort::{self, BookSort, CellMeta, ChapterSort, OuterSort};
use super::chrome::{self, LEADING_INSET, TITLEBAR_HEIGHT, TOGGLE_GAP, TRAILING_INSET};
use super::{SuperView, Workspace};
use crate::actions::{ShowProjectHome, ToggleNotifications};
use crate::book::Book;
use crate::dialogs::FollowUpNotice;
use crate::nav::{Open, Target};
use crate::notifications::{self, Notifications};
use crate::panes::{PaneId, Panes};
use crate::strings::{t, tf};
use dr_ui::components::{DraggedPill, Pill};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeftTab {
    Chapters,
    Elements,
    /// 构想.
    Drifts,
}

impl LeftTab {
    pub const ORDER: [LeftTab; 3] = [LeftTab::Chapters, LeftTab::Elements, LeftTab::Drifts];

    pub fn label(self) -> Key {
        match self {
            LeftTab::Chapters => keys::left_sidebar::tabs::CHAPTERS,
            LeftTab::Elements => keys::left_sidebar::tabs::ELEMENTS,
            LeftTab::Drifts => keys::left_sidebar::tabs::DRIFTS,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RightTab {
    Review,
    Library,
    Stats,
    /// 帮手 (the Agent).
    Companion,
}

impl RightTab {
    pub const ORDER: [RightTab; 4] = [
        RightTab::Review,
        RightTab::Library,
        RightTab::Stats,
        RightTab::Companion,
    ];

    pub fn label(self) -> Key {
        match self {
            RightTab::Review => keys::right_sidebar::tabs::REVIEW,
            RightTab::Library => keys::right_sidebar::tabs::LIBRARY,
            RightTab::Stats => keys::right_sidebar::tabs::STATS,
            RightTab::Companion => keys::right_sidebar::tabs::COMPANION,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

/// What a sidebar's resize handle drags.
#[derive(Clone, Copy, Debug)]
pub struct ResizeDrag(pub Side);

/// The drag preview of a resize: nothing follows the pointer.
pub struct NoPreview;

impl Render for NoPreview {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// A Panel Tab's padding on each side (`Segmented`'s).
const TAB_PAD: f32 = 10.0;

/// The width of a tab row: the labels with their padding, 6px at each end,
/// and the toggle's slot for the half by the window edge.
fn row_width(labels: &[Key], with_toggle: bool, side: Side, window: &Window, cx: &App) -> f32 {
    let theme = Theme::of(window, cx);
    let size = px(theme.scale.label);
    let font = Role::Structure.font(weight::REGULAR);
    let text: f32 = labels
        .iter()
        .map(|key| {
            let s = t(cx, *key);
            let run = TextRun {
                len: s.len(),
                font: font.clone(),
                color: theme.palette.ink(1).solid(),
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            f32::from(
                window
                    .text_system()
                    .layout_line(&s, size, &[run], None)
                    .width,
            )
            .ceil()
                + 2.0 * TAB_PAD
        })
        .sum();
    let toggle = match (with_toggle, side) {
        (false, _) => 0.0,
        (true, Side::Left) => LEADING_INSET + g::ROUND + TOGGLE_GAP,
        (true, Side::Right) => TRAILING_INSET + g::ROUND + TOGGLE_GAP,
    };
    text + 12.0 + toggle
}

/// The narrowest a sidebar may be: one tab row (`split` false), or the
/// width at which it holds two halves.
pub fn min_width(side: Side, split: bool, window: &Window, cx: &App) -> f32 {
    let labels: Vec<Key> = match side {
        Side::Left => LeftTab::ORDER.iter().map(|t| t.label()).collect(),
        Side::Right => RightTab::ORDER.iter().map(|t| t.label()).collect(),
    };
    let outer = row_width(&labels, true, side, window, cx);
    if split { outer * 2.0 + 1.0 } else { outer }
}

pub fn on_resize(
    ws: &mut Workspace,
    e: &DragMoveEvent<ResizeDrag>,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    let x = f32::from(e.event.position.x);
    let window_w = f32::from(window.viewport_size().width);
    match e.drag(cx).0 {
        Side::Left => ws.left.width = x,
        Side::Right => ws.right.width = window_w - x,
    }
    ws.changed(cx);
}

pub fn left(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let shown = ws.left.shown();
    let width = ws.left.width;
    let panes = ws.left.panes.clone();
    let body = panes_row(ws, Side::Left, &panes, window, cx);
    let account = account_cell(ws, window, cx);
    column(Side::Left, width, shown, body.child(account), window, cx)
}

pub fn right(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let shown = ws.right.shown();
    let width = ws.right.width;
    let panes = ws.right.panes.clone();
    let body = panes_row(ws, Side::Right, &panes, window, cx);
    column(Side::Right, width, shown, body, window, cx)
}

/// The drawer: `shown` of `width` shows, the content slides with the edge.
fn column(
    side: Side,
    width: f32,
    shown: f32,
    content: gpui::Div,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    anim::keep_going(shown > 0.0 && shown < 1.0, window);
    let visible = (width * shown).round();
    if visible <= 0.0 {
        return div().into_any_element();
    }
    let offset = visible - width;
    let handle = div()
        .id(match side {
            Side::Left => "resize-left",
            Side::Right => "resize-right",
        })
        .absolute()
        .top_0()
        .bottom_0()
        .w(px(6.0))
        .when(side == Side::Left, |el| el.right(px(-3.0)))
        .when(side == Side::Right, |el| el.left(px(-3.0)))
        .cursor_col_resize()
        .on_drag(ResizeDrag(side), |_, _, _, cx| cx.new(|_| NoPreview));
    div()
        .relative()
        .flex_none()
        .h_full()
        .w(px(visible))
        .overflow_hidden()
        .when(side == Side::Left, |el| {
            el.border_r(px(0.5)).border_color(p.hairline())
        })
        .when(side == Side::Right, |el| {
            el.border_l(px(0.5)).border_color(p.hairline())
        })
        .child(
            div()
                .absolute()
                .top_0()
                .h_full()
                .w(px(width))
                .when(side == Side::Left, |el| el.left(px(offset)))
                .when(side == Side::Right, |el| el.right(px(offset)))
                .child(content),
        )
        .child(handle)
        .into_any_element()
}

fn panes_row<T>(
    ws: &mut Workspace,
    side: Side,
    panes: &Panes<T>,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> gpui::Div
where
    T: Copy + PartialEq + PanelTab + 'static,
{
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let n = panes.panes.len();
    let mut row = div().flex_1().min_h_0().flex().flex_row();
    for (i, pane) in panes.panes.iter().enumerate() {
        let outer = match side {
            Side::Left => i == 0,
            Side::Right => i == n - 1,
        };
        let split_button =
            (n == 1 && panes.can_split && panes.keep_single).then_some(panes.split_edge);
        let el = pane_view(ws, side, pane.id, pane.tab, outer, split_button, window, cx);
        row = row.child(
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .when(i > 0, |el| {
                    el.border_l(px(0.5)).border_color(p.local_hairline())
                })
                .child(el),
        );
    }
    div().size_full().flex().flex_col().child(row)
}

/// What a sidebar tab knows about itself.
pub trait PanelTab: Sized + 'static {
    const ORDER: &'static [Self];
    fn key(self) -> Key;
    fn slug(self) -> &'static str;
    fn click(
        ws: &mut Workspace,
        pane: PaneId,
        tab: Self,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    );
    fn split(ws: &mut Workspace, cx: &mut Context<Workspace>);
    fn header(
        self,
        ws: &Workspace,
        pane: PaneId,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> AnyElement;
    fn body(
        self,
        ws: &Workspace,
        pane: PaneId,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> AnyElement;
}

impl PanelTab for LeftTab {
    const ORDER: &'static [Self] = &LeftTab::ORDER;
    fn key(self) -> Key {
        self.label()
    }
    fn slug(self) -> &'static str {
        match self {
            LeftTab::Chapters => "chapters",
            LeftTab::Elements => "elements",
            LeftTab::Drifts => "drifts",
        }
    }
    fn click(
        ws: &mut Workspace,
        pane: PaneId,
        tab: Self,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) {
        if !ws.left.panes.click(pane, tab) {
            let reduce = ws.reduce_motion(window, cx);
            ws.left.set_open(false, reduce);
        }
        ws.changed(cx);
    }
    fn split(ws: &mut Workspace, cx: &mut Context<Workspace>) {
        ws.left.panes.split(&LeftTab::ORDER);
        ws.changed(cx);
    }
    fn header(
        self,
        ws: &Workspace,
        pane: PaneId,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> AnyElement {
        left_header(self, ws, pane, window, cx)
    }
    fn body(
        self,
        ws: &Workspace,
        pane: PaneId,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> AnyElement {
        left_body(self, ws, pane, window, cx)
    }
}

impl PanelTab for RightTab {
    const ORDER: &'static [Self] = &RightTab::ORDER;
    fn key(self) -> Key {
        self.label()
    }
    fn slug(self) -> &'static str {
        match self {
            RightTab::Review => "review",
            RightTab::Library => "library",
            RightTab::Stats => "stats",
            RightTab::Companion => "companion",
        }
    }
    fn click(
        ws: &mut Workspace,
        pane: PaneId,
        tab: Self,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) {
        if !ws.right.panes.click(pane, tab) {
            let reduce = ws.reduce_motion(window, cx);
            ws.right.set_open(false, reduce);
        }
        ws.changed(cx);
    }
    fn split(ws: &mut Workspace, cx: &mut Context<Workspace>) {
        ws.right.panes.split(&RightTab::ORDER);
        ws.changed(cx);
    }
    fn header(
        self,
        ws: &Workspace,
        pane: PaneId,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> AnyElement {
        right_header(self, ws, pane, window, cx)
    }
    fn body(
        self,
        ws: &Workspace,
        pane: PaneId,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> AnyElement {
        right_body(self, ws, pane, window, cx)
    }
}

fn pane_slug(pane: PaneId) -> &'static str {
    match pane {
        PaneId::Primary => "primary",
        PaneId::Secondary => "secondary",
    }
}

impl Workspace {
    /// Whether this exact Review pane still owns a visible destination.
    /// Requests may wait for its first render; hiding or replacing the pane
    /// cancels that wait without depending on the cached body rendering again.
    pub fn review_visible(&self, pane: PaneId) -> bool {
        self.right.open
            && !self.immersive
            && !self.covered()
            && self
                .right
                .panes
                .panes
                .iter()
                .any(|shown| shown.id == pane && shown.tab == RightTab::Review)
    }

    /// Whether this cached companion body is still shown in its own pane.
    /// Used to cancel UI-owned operations when a tab closes or is covered.
    pub fn companion_visible(&self, body: gpui::EntityId) -> bool {
        if !self.right.open || self.immersive || self.covered() {
            return false;
        }
        let panels = self.companion.borrow();
        self.right.panes.panes.iter().any(|pane| {
            pane.tab == RightTab::Companion
                && panels
                    .get(pane_slug(pane.id))
                    .and_then(Option::as_ref)
                    .is_some_and(|panel| panel.body.entity_id() == body)
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn pane_view<T>(
    ws: &mut Workspace,
    side: Side,
    pane: PaneId,
    tab: T,
    outer: bool,
    split_button: Option<crate::panes::Edge>,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement
where
    T: Copy + PartialEq + PanelTab + 'static,
{
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let side_slug = if side == Side::Left { "left" } else { "right" };
    let id = |name: &str| SharedString::from(format!("{side_slug}-{}-{name}", pane_slug(pane)));
    let labels: Vec<SharedString> = T::ORDER.iter().map(|tab| t(cx, tab.key())).collect();
    let selected = T::ORDER.iter().position(|t| *t == tab).unwrap_or(0);
    let order = T::ORDER;
    let entity = cx.entity();
    // Panel Tabs: the block rides the panel's push and lands with it; a
    // click on the current one closes the half.
    let tabs = Segmented::new(ElementId::Name(id("tabs")), labels, selected)
        .motion(motion::PUSH)
        .report_selected()
        .font(Role::Structure)
        .text_size(theme.scale.label)
        .on_change(move |i, window, cx| {
            let tab = order[i];
            entity.update(cx, |ws, cx| T::click(ws, pane, tab, window, cx));
        });
    let split = split_button.map(|edge| {
        let entity = cx.entity();
        (
            edge,
            Button::new(
                ElementId::Name(id("split")),
                t(cx, keys::sidebar_layout::SPLIT),
            )
            .text()
            .small()
            .on_click(move |_, _, cx| entity.update(cx, |ws, cx| T::split(ws, cx))),
        )
    });
    let (lead, trail) = match (outer, side) {
        (true, Side::Left) => (LEADING_INSET + g::ROUND + TOGGLE_GAP, 6.0),
        (true, Side::Right) => (6.0, TRAILING_INSET + g::ROUND + TOGGLE_GAP),
        _ => (6.0, 6.0),
    };
    let mut tab_row = div()
        .id(ElementId::Name(id("tab-row")))
        .flex_none()
        .h(px(TITLEBAR_HEIGHT))
        .pl(px(lead))
        .pr(px(trail))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0));
    let split_at_start = matches!(split, Some((crate::panes::Edge::Start, _)));
    let mut split = split.map(|(_, b)| b);
    if split_at_start {
        tab_row = tab_row.child(split.take().expect("just checked"));
    }
    // M24's tour rings the left tabs, and (until the Agent's own tab can be
    // marked) the right ones.
    let tabs = crate::pages::anchor(
        if side == Side::Left {
            crate::pages::anchors::LEFT_PANEL_TAB
        } else {
            crate::pages::anchors::AGENT_TAB
        },
        tabs,
        cx,
    );
    tab_row = tab_row.child(tabs).child(div().flex_1());
    if let Some(button) = split {
        tab_row = tab_row.child(button);
    }
    let tab_row = chrome::drag_region(tab_row, cx);
    let header_h = (theme.scale.row_height * 1.25).max(40.0);
    let header = div()
        .flex_none()
        .h(px(header_h))
        .pl(px(12.0))
        .pr(px(10.0))
        .border_t(px(0.5))
        .border_color(p.local_hairline())
        .flex()
        .flex_row()
        .items_center()
        .child(tab.header(ws, pane, window, cx));
    let index = selected;
    let ws_handle = cx.entity();
    let body = Push::new(
        ElementId::Name(id("push")),
        SharedString::new_static(tab.slug()),
        index,
        move |slug, window, cx| {
            let tab = order
                .iter()
                .copied()
                .find(|t| t.slug() == slug.as_ref())
                .unwrap_or(order[0]);
            ws_handle.update(cx, |ws, cx| tab.body(ws, pane, window, cx))
        },
    );
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(tab_row)
        .child(header)
        .child(div().flex_1().min_h_0().child(body))
        .into_any_element()
}

/// The meta line of a panel header: small index type, muted.
fn meta(text: SharedString, theme: &Theme) -> gpui::Div {
    div()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .font_role(Role::Index)
        .type_px(theme.scale.caption, theme.scale.line_caption)
        .text_color(theme.palette.muted().solid())
        .child(text)
}

/// The panel a module draws for `tab` in `pane`, made the first time.
fn module_panel(
    tab: LeftTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Option<crate::pages::LeftPanel> {
    let key = (pane_slug(pane), tab);
    if let Some(made) = ws.left_panels.borrow().get(&key) {
        return made.clone();
    }
    let made = crate::pages::left_panel_for(tab, cx.weak_entity(), window, cx);
    ws.left_panels.borrow_mut().insert(key, made.clone());
    made
}

/// The 帮手 tab a module draws for `pane` ([`crate::pages::set_companion`]),
/// made the first time the pane shows it, then kept.
fn companion_panel(
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Option<crate::pages::LeftPanel> {
    let key = pane_slug(pane);
    if let Some(made) = ws.companion.borrow().get(key) {
        return made.clone();
    }
    let made = crate::pages::companion_for(cx.weak_entity(), window, cx);
    ws.companion.borrow_mut().insert(key, made.clone());
    made
}

/// The 素材库 tab a module draws for `pane` ([`crate::pages::set_library`]),
/// made the first time the pane shows it, then kept.
fn library_panel(
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Option<crate::pages::LeftPanel> {
    let key = pane_slug(pane);
    if let Some(made) = ws.library_panel.borrow().get(key) {
        return made.clone();
    }
    let made = crate::pages::library_for(cx.weak_entity(), window, cx);
    ws.library_panel.borrow_mut().insert(key, made.clone());
    made
}

fn left_header(
    tab: LeftTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    if let Some(panel) = module_panel(tab, ws, pane, window, cx) {
        return div().size_full().child(panel.head).into_any_element();
    }
    let theme = Theme::of(window, cx);
    let book = &ws.book;
    let slug = pane_slug(pane);
    match tab {
        LeftTab::Chapters => {
            // Before the first storyline only the chapters count.
            let text = if book.storylines.is_empty() {
                tf(
                    cx,
                    keys::left_sidebar::meta::CHAPTERS,
                    &[("count", &book.chapters.len())],
                )
            } else {
                tf(
                    cx,
                    keys::left_sidebar::view_mode::CHAPTER_SUMMARY,
                    &[
                        ("storylines", &book.storylines.len()),
                        ("chapters", &book.chapters.len()),
                    ],
                )
            };
            let selected = ws.nav.is_selected(&Target::Book);
            let entity = cx.entity();
            let summary = if book.storylines.is_empty() {
                meta(text, &theme).into_any_element()
            } else {
                // The summary switches the panel between the storylines and
                // the whole book (the 0.1 client's view-mode text).
                let by_book = ws.chapters_by_book;
                let toggle = cx.entity();
                let ink = theme.palette.ink(1).solid();
                meta(text, &theme)
                    .id(SharedString::from(format!("chapter-view-{slug}")))
                    .cursor_pointer()
                    .hover(move |st| st.text_color(ink))
                    .role(gpui::Role::Button)
                    .aria_label(t(
                        cx,
                        if by_book {
                            keys::left_sidebar::view_mode::GLOBAL_TITLE
                        } else {
                            keys::left_sidebar::view_mode::STORYLINE_TITLE
                        },
                    ))
                    .on_click(move |_, _, cx| {
                        toggle.update(cx, |ws, cx| {
                            ws.chapters_by_book = !ws.chapters_by_book;
                            ws.changed(cx);
                        })
                    })
                    .into_any_element()
            };
            // The sort menu (the 0.1 client's `SortMenu`), under its button.
            let by_book = book.storylines.is_empty() || ws.chapters_by_book;
            let sort_open = ws.chapter_sort_open.as_deref() == Some(slug);
            let sort_bounds = overlay::use_bounds(
                ElementId::Name(format!("chapter-sort-bounds-{slug}").into()),
                window,
                cx,
            );
            let sort_menu = match (sort_open, *sort_bounds.read(cx)) {
                (true, Some(bounds)) => Some(super::chapter_sort::menu(
                    &cx.entity(),
                    ws.chapter_sort,
                    by_book,
                    bounds,
                    &theme,
                    cx,
                )),
                _ => None,
            };
            let sorter = cx.entity();
            let pane_key = slug.to_owned();
            // The folding fan (by storyline only), drawn as a press will
            // leave the groups: shut while all are open.
            let fan = (!by_book).then(|| {
                let folder = cx.entity();
                IconButton::new(
                    SharedString::from(format!("chapter-fold-{slug}")),
                    if ws.folded_in(pane).is_empty() {
                        Icon::FoldingFanClosed
                    } else {
                        Icon::FoldingFan
                    },
                )
                .label(t(cx, keys::left_sidebar::actions::COLLAPSE_ALL))
                .on_click(move |_, _, cx| folder.update(cx, |ws, cx| ws.fold_all(pane, cx)))
            });
            div()
                .size_full()
                .flex()
                .items_center()
                .child(summary)
                .children(fan)
                .child(
                    div().relative().child(overlay::probe(sort_bounds)).child(
                        IconButton::new(
                            SharedString::from(format!("chapter-sort-{slug}")),
                            Icon::Sort,
                        )
                        .label(t(cx, keys::left_sidebar::actions::SORT))
                        .selected(sort_open)
                        .on_click(move |_, _, cx| {
                            let pane = pane_key.clone();
                            sorter.update(cx, |ws, cx| {
                                ws.chapter_sort_open =
                                    if ws.chapter_sort_open.as_deref() == Some(pane.as_str()) {
                                        None
                                    } else {
                                        Some(pane)
                                    };
                                cx.notify();
                            })
                        }),
                    ),
                )
                .children(sort_menu)
                .child(
                    IconButton::new(SharedString::from(format!("book-{slug}")), Icon::OpenBook)
                        .label(t(cx, keys::top_timeline::singletons::ALL_CHAPTERS))
                        .selected(selected)
                        .on_click(move |e, _, cx| {
                            let how = if e.click_count() > 1 {
                                Open::KEEP
                            } else {
                                Open::PREVIEW
                            };
                            entity.update(cx, |ws, cx| ws.open(Target::Book, how, cx));
                        }),
                )
                .into_any_element()
        }
        LeftTab::Elements => {
            let text = tf(
                cx,
                keys::left_sidebar::meta::ELEMENTS,
                &[
                    ("categories", &book.categories.len()),
                    ("elements", &book.elements.len()),
                ],
            );
            let selected = ws.super_view == Some(SuperView::Elements);
            let entity = cx.entity();
            div()
                .size_full()
                .flex()
                .items_center()
                .child(meta(text, &theme))
                .child(crate::pages::anchor(
                    crate::pages::anchors::SUPER_VIEW_ENTRY,
                    IconButton::new(
                        SharedString::from(format!("elements-sv-{slug}")),
                        Icon::KnotLinks,
                    )
                    .label(t(cx, SuperView::Elements.label()))
                    .selected(selected)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |ws, cx| ws.toggle_super_view(SuperView::Elements, cx))
                    }),
                    cx,
                ))
                .into_any_element()
        }
        LeftTab::Drifts => {
            let text = tf(
                cx,
                keys::left_sidebar::meta::DRIFTS,
                &[("count", &book.ideas.len())],
            );
            meta(text, &theme).into_any_element()
        }
    }
}

fn right_header(
    tab: RightTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let slug = pane_slug(pane);
    let super_entry = |ws: &Workspace, cx: &mut Context<Workspace>, name: &str| {
        let entity = cx.entity();
        IconButton::new(
            SharedString::from(format!("{name}-sv-{slug}")),
            Icon::Layers,
        )
        .label(t(cx, SuperView::ReviewMaterials.label()))
        .selected(ws.super_view == Some(SuperView::ReviewMaterials))
        .on_click(move |_, _, cx| {
            entity.update(cx, |ws, cx| {
                ws.toggle_super_view(SuperView::ReviewMaterials, cx)
            })
        })
    };
    let row = div().size_full().flex().items_center();
    match tab {
        RightTab::Review => row
            .child(meta(t(cx, keys::right_sidebar::kickers::REVIEW), &theme))
            .child(super_entry(ws, cx, "review"))
            .into_any_element(),
        RightTab::Library => match library_panel(ws, pane, window, cx) {
            // M19: the module's head row.
            Some(panel) => div().size_full().child(panel.head).into_any_element(),
            None => row
                .child(meta(t(cx, keys::right_sidebar::kickers::LIBRARY), &theme))
                .child(super_entry(ws, cx, "library"))
                .into_any_element(),
        },
        RightTab::Stats => {
            use keys::right_sidebar::kickers::stats as k;
            // Read from the navigation model: what the stats follow.
            let key = match ws.nav.current() {
                None => k::NONE,
                Some(Target::Book) => k::ALL_CHAPTERS,
                Some(Target::Chapter(_)) => k::CHAPTER,
                Some(Target::Idea(_)) => k::DRIFT,
                Some(Target::Storyline(_)) => k::STORYLINE,
                Some(Target::Element(_)) => k::ELEMENT,
                Some(Target::Category(_)) => k::CATEGORY,
                Some(Target::Material(_)) => k::MATERIAL,
            };
            row.child(meta(t(cx, key), &theme)).into_any_element()
        }
        RightTab::Companion => match companion_panel(ws, pane, window, cx) {
            Some(panel) => div().size_full().child(panel.head).into_any_element(),
            None => row.into_any_element(),
        },
    }
}

/// How far a level of a list is set in.
const INDENT: f32 = 12.0;
/// The space under each row.
const ROW_GAP: f32 = 2.0;

/// One row of a sidebar list.
#[derive(Clone, Debug)]
enum Row {
    /// A cell that opens `target`; `group` keeps its id unique where the
    /// same thing shows twice (a chapter on two storylines).
    Cell {
        target: Target,
        group: SharedString,
        depth: usize,
        structure: bool,
        /// A chapter's readout on the right (its date, its word count).
        meta: Option<SharedString>,
        /// A storyline's group folds (the chapter panel by storyline).
        fold: Option<Fold>,
        /// Its hover card shows what can be done to it (the chapter panel).
        card: bool,
    },
    /// A group's heading that opens nothing (未归属, 未分类, an idea group,
    /// a material folder).
    Heading {
        key: SharedString,
        label: SharedString,
        mark: Option<sand::Kind>,
        color: Option<Rgb>,
        depth: usize,
        fold: Option<Fold>,
    },
}

/// A group that folds (the 0.1 client's `GroupHeaderCell`): its id in
/// [`Workspace::folded`], whether it is folded, how many it holds.
#[derive(Clone, Debug)]
struct Fold {
    id: SharedString,
    pane: PaneId,
    folded: bool,
    count: usize,
}

/// The id of the 未归属 group among the folded ones.
const LOOSE_GROUP: &str = "unaffiliated";

impl Workspace {
    /// The chapter panel's folded groups in `pane`, for the book shown.
    pub fn folded_in(&self, pane: PaneId) -> HashSet<String> {
        self.folded
            .get(&(self.book_id.clone(), pane))
            .cloned()
            .unwrap_or_default()
    }

    /// Where sidebar list `list` (`left-primary-chapters`,
    /// `right-secondary-library` …) of the book shown is scrolled, once it
    /// has shown in this run.
    pub fn list_scroll(&self, list: &str) -> Option<gpui::UniformListScrollHandle> {
        self.list_scroll
            .borrow()
            .get(&format!("{}/{list}", self.book_id))
            .cloned()
    }

    /// Folds or opens one group of the chapter panel in `pane`.
    pub fn toggle_fold(&mut self, pane: PaneId, group: &str, cx: &mut Context<Self>) {
        let folded = self.folded.entry((self.book_id.clone(), pane)).or_default();
        if !folded.remove(group) {
            folded.insert(group.to_owned());
        }
        cx.notify();
    }

    /// The folding fan in `pane`: folds every group, or opens them all when
    /// any is folded.
    pub fn fold_all(&mut self, pane: PaneId, cx: &mut Context<Self>) {
        let all: HashSet<String> = self
            .book
            .storylines
            .iter()
            .map(|s| s.id.clone())
            .chain([LOOSE_GROUP.to_owned()])
            .collect();
        let folded = self.folded.entry((self.book_id.clone(), pane)).or_default();
        if folded.is_empty() {
            *folded = all;
        } else {
            folded.clear();
        }
        cx.notify();
    }
}

/// A group's count and its chevron at the end of its row: the chevron
/// folds or opens it (and only that: the row's own click is not run).
fn fold_tail(
    id: &SharedString,
    fold: &Fold,
    ws: &gpui::Entity<Workspace>,
    theme: &Theme,
) -> [AnyElement; 2] {
    let p = theme.palette;
    let count = div()
        .flex_none()
        .font_role(Role::Index)
        .type_px(theme.scale.caption, theme.scale.line_caption)
        .text_color(p.muted().solid())
        .child(fold.count.to_string())
        .into_any_element();
    let (ws, group, pane) = (ws.clone(), fold.id.to_string(), fold.pane);
    let chevron = div()
        .id(ElementId::Name(format!("{id}-fold").into()))
        .flex_none()
        .size(px(16.0))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_expanded(!fold.folded)
        .child(sand::icon(
            if fold.folded {
                Icon::ChevronRight
            } else {
                Icon::ChevronDown
            },
            11.0,
            p.ink(3).solid(),
        ))
        .on_click(move |_, _, cx| {
            cx.stop_propagation();
            let group = group.clone();
            ws.update(cx, |ws, cx| ws.toggle_fold(pane, &group, cx));
        })
        .into_any_element();
    [count, chevron]
}

/// A sidebar list: every row is one cell high, so only the rows on screen
/// are built (a book of hundreds of chapters costs what one screenful
/// does).
fn rows_view(
    id: SharedString,
    rows: Vec<Row>,
    ws: &Workspace,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let rows = std::rc::Rc::new(rows);
    let book = ws.book.clone();
    let current = ws.nav.current().cloned();
    let entity = cx.entity();
    // What a hover card's rows are made with.
    let host = crate::pages::PageMenuHost {
        workspace: entity.downgrade(),
        library: ws.library.clone(),
        book_id: ws.book_id.clone(),
        book: book.clone(),
    };
    let list_id = id.clone();
    // Where this list was, if it showed before in this run.
    let scroll = ws
        .list_scroll
        .borrow_mut()
        .entry(format!("{}/{id}", ws.book_id))
        .or_default()
        .clone();
    uniform_list(ElementId::Name(id), rows.len(), move |range, window, cx| {
        let theme = Theme::of(window, cx);
        let wash = theme.palette.accent.alpha(0.08);
        range
            .map(|i| {
                let row = match &rows[i] {
                    Row::Cell {
                        target,
                        group,
                        depth,
                        structure,
                        meta,
                        fold,
                        card,
                    } => {
                        let id: SharedString = format!("{list_id}-{group}-{}", target.key()).into();
                        let el = cell(
                            id.clone(),
                            &book,
                            target.clone(),
                            *depth,
                            *structure,
                            meta.clone(),
                            fold.as_ref(),
                            current.as_ref() == Some(target),
                            &entity,
                            wash,
                            &theme,
                            cx,
                        );
                        if *card {
                            hover_card(id, el, target, &entity, &host)
                        } else {
                            el
                        }
                    }
                    Row::Heading {
                        key,
                        label,
                        mark,
                        color,
                        depth,
                        fold,
                    } => heading(
                        format!("{list_id}-{key}").into(),
                        label.clone(),
                        *mark,
                        *color,
                        *depth,
                        fold.as_ref(),
                        &entity,
                        &theme,
                    ),
                };
                div().pb(px(ROW_GAP)).child(row)
            })
            .collect::<Vec<_>>()
    })
    .track_scroll(&scroll)
    .size_full()
    .px(px(8.0))
    .py(px(6.0))
    .into_any_element()
}

/// A chapter cell in the hand: the chapter's id.
#[derive(Clone, Debug)]
pub struct ChapterDrag {
    pub id: String,
}

/// A cell that opens `target` (components.md, 「Cell」): a click shows it
/// as a preview, a double click keeps it. A chapter's can be picked up and
/// dropped on another chapter's to move it there in reading order.
#[allow(clippy::too_many_arguments)]
fn cell(
    id: SharedString,
    book: &Book,
    target: Target,
    depth: usize,
    structure: bool,
    meta: Option<SharedString>,
    fold: Option<&Fold>,
    selected: bool,
    ws: &gpui::Entity<Workspace>,
    wash: gpui::Hsla,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let tail = fold.map(|f| fold_tail(&id, f, ws, theme));
    let (mark, color) = book.mark(&target);
    let label = super::title_of(book, &target, cx);
    let entity = ws.clone();
    let chapter = match &target {
        Target::Chapter(c) => Some(c.to_string()),
        _ => None,
    };
    let ghost = label.clone();
    let drag_id = SharedString::from(format!("{id}-drag"));
    let readout = meta.map(|text| {
        div()
            .flex_none()
            .font_role(Role::Index)
            .type_px(theme.scale.caption, theme.scale.line_caption)
            .text_color(theme.palette.muted().solid())
            .child(text)
    });
    let cell = SandCell::new(ElementId::Name(id), label)
        .mark(mark)
        .color_opt(color)
        .selected(selected)
        .font(if structure { Role::Structure } else { Role::Ui })
        .children(readout)
        .children(tail.into_iter().flatten())
        .on_click(move |e, _, cx| {
            let how = if e.click_count() > 1 {
                Open::KEEP
            } else {
                Open::PREVIEW
            };
            let target = target.clone();
            entity.update(cx, |ws, cx| ws.open(target, how, cx));
        });
    let el = indented(depth, cell.into_any_element());
    let Some(chapter) = chapter else {
        return el;
    };
    let drop_on = ws.clone();
    let onto = chapter.clone();
    div()
        .id(ElementId::Name(drag_id))
        .rounded(px(radius::SM))
        .on_drag(ChapterDrag { id: chapter }, move |_, _, window, cx| {
            let pill = Pill::new(ghost.clone()).mark(mark, color);
            let at = window.mouse_position();
            cx.new(|_| DraggedPill::new(pill, at))
        })
        .drag_over::<ChapterDrag>(move |st, _, _, _| st.bg(wash))
        .on_drop(move |drag: &ChapterDrag, _, cx| {
            drop_on.update(cx, |ws, cx| ws.move_chapter(&drag.id, &onto, cx))
        })
        .child(el)
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn heading(
    id: SharedString,
    label: SharedString,
    mark: Option<sand::Kind>,
    color: Option<Rgb>,
    depth: usize,
    fold: Option<&Fold>,
    ws: &gpui::Entity<Workspace>,
    theme: &Theme,
) -> AnyElement {
    let tail = fold.map(|f| fold_tail(&id, f, ws, theme));
    let mut cell = SandCell::new(ElementId::Name(id.clone()), label)
        .color_opt(color)
        .font(Role::Structure)
        .disabled(true)
        .children(tail.into_iter().flatten());
    if let Some(mark) = mark {
        cell = cell.mark(mark);
    }
    // A heading that folds folds on a click anywhere on it.
    let el = match fold {
        Some(fold) => {
            let (ws, group, pane) = (ws.clone(), fold.id.to_string(), fold.pane);
            div()
                .id(ElementId::Name(format!("{id}-toggle").into()))
                .cursor_pointer()
                .on_click(move |_, _, cx| {
                    let group = group.clone();
                    ws.update(cx, |ws, cx| ws.toggle_fold(pane, &group, cx));
                })
                .child(cell)
                .into_any_element()
        }
        None => cell.into_any_element(),
    };
    indented(depth, el)
}

/// A chapter panel row with its hover card: what the page can do (the same
/// rows as its ⋯ menu), under its name, words, storylines and summary.
fn hover_card(
    id: SharedString,
    el: AnyElement,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    host: &crate::pages::PageMenuHost,
) -> AnyElement {
    card(id, el, target, ws, host, Rc::default())
}

/// `el` with `target`'s hover card, `extra` rows before the dangerous ones.
fn card(
    id: SharedString,
    el: AnyElement,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    host: &crate::pages::PageMenuHost,
    extra: Rc<crate::pages::CardRows>,
) -> AnyElement {
    let (target, ws, host) = (target.clone(), ws.clone(), host.clone());
    let card_id = id.clone();
    dr_ui::components::HoverCard::new(
        ElementId::Name(format!("{id}-card").into()),
        el,
        move |window, cx| card_body(&card_id, &target, &ws, &host, &extra, window, cx),
    )
    .into_any_element()
}

/// A page's hover card around a module's own element (M14's slabs and lane
/// names): the chapter panel's card for `target` (its name, words,
/// storylines and summary, then what can be done to it, as its ⋯ menu),
/// with the module's own rows ([`crate::pages::CardRows`]: above the page's,
/// and before the dangerous ones). `id` is unique in the window. Call it
/// while drawing the module's view, not inside the workspace's own drawing
/// (it reads the workspace).
pub fn page_hover_card(
    id: impl Into<SharedString>,
    el: impl IntoElement,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    rows: crate::pages::CardRows,
    cx: &App,
) -> AnyElement {
    let host = crate::pages::PageMenuHost::of(ws, cx);
    card(
        id.into(),
        el.into_any_element(),
        target,
        ws,
        &host,
        Rc::new(rows),
    )
}

/// Words as the 0.1 client wrote them (`toLocaleString`): 12,345.
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A page's hover card (the 0.1 client's `EntityHoverCard`): a chapter's
/// words, its storylines (the primary first) and summary; a storyline's
/// chapters and words, its summary. Then its actions.
fn card_body(
    id: &SharedString,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    host: &crate::pages::PageMenuHost,
    extra: &crate::pages::CardRows,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    use dr_ui::components::{CardAction, CardBody};
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let book = &host.book;
    let (mark, color) = book.mark(target);
    let mut body = CardBody::new(
        ElementId::Name(format!("{id}-body").into()),
        super::title_of(book, target, cx),
    )
    .mark(mark, color);
    match target {
        Target::Chapter(chapter) => {
            if let Some(c) = book.chapters.iter().find(|c| c.id == chapter.as_str()) {
                body = body.count(tf(
                    cx,
                    keys::node_editor::meta::WORDS,
                    &[("count", &grouped(c.words))],
                ));
                let mut on: Vec<&dr_workspace::dto::StorylineInfo> = c
                    .storylines
                    .iter()
                    .filter_map(|s| book.storylines.iter().find(|x| &x.id == s))
                    .collect();
                on.sort_by_key(|s| Some(&s.id) != c.primary_storyline.as_ref());
                let line = if on.is_empty() {
                    div()
                        .text_color(p.muted().solid())
                        .child(t(cx, keys::node_editor::empty::NO_STORYLINE))
                } else {
                    div().flex().flex_row().flex_wrap().gap(px(8.0)).children(
                        on.into_iter().enumerate().map(|(i, s)| {
                            let ink = if i == 0 { p.ink(2) } else { p.muted() };
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(4.0))
                                .text_color(ink.solid())
                                .child({
                                    let mark = sand::KindMark::new(
                                        ElementId::Name(format!("{id}-sl-{}", s.id).into()),
                                        sand::Kind::Storyline,
                                    )
                                    .scale(0.7);
                                    match crate::book::color_of(&s.color) {
                                        Some(c) => mark.color(c),
                                        None => mark,
                                    }
                                })
                                .child(s.name.clone())
                        }),
                    )
                };
                body = body.meta(line);
                if !c.summary.trim().is_empty() {
                    body = body.summary(c.summary.clone());
                }
            }
        }
        Target::Storyline(storyline) => {
            if let Some(s) = book.storylines.iter().find(|s| s.id == storyline.as_str()) {
                let chapters: Vec<_> = book.chapters_of(&s.id).collect();
                let words: u64 = chapters.iter().map(|c| c.words).sum();
                body = body.count(format!(
                    "{} · {}",
                    tf(
                        cx,
                        keys::storyline_editor::meta::CHAPTERS,
                        &[("count", &chapters.len())]
                    ),
                    tf(
                        cx,
                        keys::storyline_editor::meta::K_WORDS,
                        &[("count", &format!("{:.1}", words as f64 / 1000.0))]
                    ),
                ));
                if !s.summary.trim().is_empty() {
                    body = body.summary(s.summary.clone());
                }
            }
        }
        _ => {}
    }
    let sections = super::page_actions::with_rows(
        super::page_actions::page_actions(ws, host, target, cx),
        extra,
    );
    for section in sections {
        let rows = section
            .items
            .into_iter()
            .map(|item| {
                let run = item.run.clone();
                let mut action = CardAction::new(
                    ElementId::Name(format!("{id}-{}", item.id).into()),
                    item.icon,
                    item.label,
                )
                .current(item.checked)
                .on_click(move |_, window, cx| run(window, cx));
                if item.danger {
                    action = action.danger();
                }
                action.into_any_element()
            })
            .collect();
        body = body.section(rows);
    }
    body.into_any_element()
}

fn indented(depth: usize, el: AnyElement) -> AnyElement {
    if depth == 0 {
        return el;
    }
    div()
        .pl(px(INDENT * depth as f32))
        .child(el)
        .into_any_element()
}

/// Groups in their list's order, each followed by its children (a cycle
/// stops at the depth limit).
fn walk_groups<'a>(
    groups: &'a [GroupInfo],
    parent: Option<&str>,
    depth: usize,
    out: &mut Vec<(&'a GroupInfo, usize)>,
) {
    if depth > 4 {
        return;
    }
    for g in groups.iter().filter(|g| g.parent.as_deref() == parent) {
        out.push((g, depth));
        walk_groups(groups, Some(&g.id), depth + 1, out);
    }
}

fn open_row(target: Option<Target>, group: &str, depth: usize, structure: bool) -> Option<Row> {
    target.map(|target| Row::Cell {
        target,
        group: SharedString::from(group.to_owned()),
        depth,
        structure,
        meta: None,
        fold: None,
        card: false,
    })
}

/// A chapter's row, with its readout when the panel shows one.
fn chapter_row(
    chapter: &dr_workspace::dto::ChapterInfo,
    group: &str,
    depth: usize,
    meta: Option<CellMeta>,
) -> Option<Row> {
    let mut row = open_row(
        chapter.id.parse().ok().map(Target::Chapter),
        group,
        depth,
        false,
    )?;
    if let Row::Cell {
        meta: slot, card, ..
    } = &mut row
    {
        *slot = meta.and_then(|meta| chapter_sort::readout(chapter, meta).map(SharedString::from));
        *card = true;
    }
    Some(row)
}

/// Below this width a chapter cell shows only its name (the 0.1 client's
/// `META_HIDE_WIDTH`).
const META_HIDE_WIDTH: f32 = 200.0;

fn heading_row(
    key: impl Into<SharedString>,
    label: SharedString,
    mark: Option<sand::Kind>,
    color: Option<Rgb>,
    depth: usize,
) -> Row {
    Row::Heading {
        key: key.into(),
        label,
        mark,
        color,
        depth,
        fold: None,
    }
}

/// The rows of a left panel.
#[allow(clippy::too_many_arguments)]
fn left_rows(
    tab: LeftTab,
    book: &Book,
    by_book: bool,
    sort: ChapterSort,
    show_meta: bool,
    pane: PaneId,
    folded: &HashSet<String>,
    theme: &Theme,
    cx: &App,
) -> Vec<Row> {
    let mut rows = Vec::new();
    let meta = show_meta.then_some(sort.meta);
    match tab {
        LeftTab::Chapters => {
            if book.storylines.is_empty() || by_book {
                if sort.book != BookSort::BookOrder {
                    // Another order has no acts to group by.
                    rows.extend(
                        chapter_sort::sort_book(&book.chapters, sort.book)
                            .into_iter()
                            .filter_map(|c| chapter_row(c, "book", 0, meta)),
                    );
                    return rows;
                }
                // The whole book in reading order; each act starts with its
                // heading and holds its chapters.
                let starts: std::collections::HashMap<&str, (usize, &ActInfo)> = book
                    .acts
                    .iter()
                    .enumerate()
                    .filter_map(|(n, a)| a.chapters.first().map(|c| (c.as_str(), (n, a))))
                    .collect();
                let mut depth = 0;
                for c in &book.chapters {
                    if let Some((n, act)) = starts.get(c.id.as_str()) {
                        rows.push(heading_row(
                            format!("act-{}", act.id),
                            act_label(*n + 1, &act.name, cx),
                            None,
                            act.color.as_deref().and_then(crate::book::color_of),
                            0,
                        ));
                        depth = 1;
                    }
                    rows.extend(chapter_row(c, "book", depth, meta));
                }
            } else {
                // By storyline, as the 0.1 client's storyline view: a chapter
                // shows under each storyline it is on (or only its primary
                // one).
                let mut storylines: Vec<(usize, &dr_workspace::dto::StorylineInfo)> =
                    book.storylines.iter().enumerate().collect();
                if sort.outer == OuterSort::Alphabet {
                    storylines.sort_by(|(i, a), (j, b)| {
                        a.name
                            .to_lowercase()
                            .cmp(&b.name.to_lowercase())
                            .then(i.cmp(j))
                    });
                }
                for (_, sl) in storylines {
                    let on = book.chapters_of(&sl.id).filter(|c| {
                        !sort.primary_only || c.primary_storyline.as_deref() == Some(&sl.id)
                    });
                    let chapters = chapter_sort::sort_inner(on, sort.inner);
                    let is_folded = folded.contains(&sl.id);
                    let mut head =
                        open_row(sl.id.parse().ok().map(Target::Storyline), "sl", 0, true);
                    if let Some(Row::Cell { fold, card, .. }) = &mut head {
                        *fold = Some(Fold {
                            id: sl.id.clone().into(),
                            pane,
                            folded: is_folded,
                            count: chapters.len(),
                        });
                        *card = true;
                    }
                    rows.extend(head);
                    if !is_folded {
                        rows.extend(
                            chapters
                                .into_iter()
                                .filter_map(|c| chapter_row(c, &sl.id, 1, meta)),
                        );
                    }
                }
                let loose: Vec<_> = book.unaffiliated().collect();
                if !loose.is_empty() {
                    let is_folded = folded.contains(LOOSE_GROUP);
                    let mut head = heading_row(
                        LOOSE_GROUP,
                        t(cx, keys::left_sidebar::groups::UNAFFILIATED),
                        Some(sand::Kind::Storyline),
                        Some(theme.palette.ink(4)),
                        0,
                    );
                    if let Row::Heading { fold, .. } = &mut head {
                        *fold = Some(Fold {
                            id: LOOSE_GROUP.into(),
                            pane,
                            folded: is_folded,
                            count: loose.len(),
                        });
                    }
                    rows.push(head);
                    if !is_folded {
                        rows.extend(
                            chapter_sort::sort_inner(loose.into_iter(), sort.inner)
                                .into_iter()
                                .filter_map(|c| chapter_row(c, "loose", 1, meta)),
                        );
                    }
                }
            }
        }
        LeftTab::Elements => {
            let element = |id: &str| id.parse().ok().map(Target::Element);
            for cat in &book.categories {
                rows.extend(open_row(
                    cat.id.parse().ok().map(Target::Category),
                    "cat",
                    0,
                    true,
                ));
                rows.extend(
                    book.elements
                        .iter()
                        .filter(|e| e.category.as_deref() == Some(cat.id.as_str()))
                        .filter_map(|e| open_row(element(&e.id), "el", 1, false)),
                );
            }
            let known = |c: &Option<String>| {
                c.as_ref()
                    .is_some_and(|c| book.categories.iter().any(|cat| &cat.id == c))
            };
            let loose: Vec<_> = book
                .elements
                .iter()
                .filter(|e| !known(&e.category))
                .collect();
            if !loose.is_empty() {
                rows.push(heading_row(
                    "uncategorized",
                    t(cx, keys::left_sidebar::UNCATEGORIZED),
                    Some(sand::Kind::Category),
                    Some(theme.palette.ink(4)),
                    0,
                ));
                rows.extend(
                    loose
                        .into_iter()
                        .filter_map(|e| open_row(element(&e.id), "el", 1, false)),
                );
            }
        }
        LeftTab::Drifts => {
            let idea = |id: &str| id.parse().ok().map(Target::Idea);
            let mut groups = Vec::new();
            walk_groups(&book.idea_groups, None, 0, &mut groups);
            for (g, depth) in groups {
                rows.push(heading_row(
                    format!("group-{}", g.id),
                    g.name.clone().into(),
                    Some(sand::Kind::DriftGroup),
                    g.color.as_deref().and_then(crate::book::color_of),
                    depth,
                ));
                rows.extend(
                    book.ideas
                        .iter()
                        .filter(|i| i.group.as_deref() == Some(g.id.as_str()))
                        .filter_map(|i| open_row(idea(&i.id), "idea", depth + 1, false)),
                );
            }
            let grouped = |i: &&dr_workspace::dto::IdeaInfo| {
                i.group
                    .as_ref()
                    .is_some_and(|g| book.idea_groups.iter().any(|x| &x.id == g))
            };
            rows.extend(
                book.ideas
                    .iter()
                    .filter(|i| !grouped(i))
                    .filter_map(|i| open_row(idea(&i.id), "idea", 0, false)),
            );
        }
    }
    rows
}

/// 第N幕 and the act's name, if it has one.
fn act_label(n: usize, name: &str, cx: &App) -> SharedString {
    let ordinal = tf(cx, keys::all_chapters::ACT_ORDINAL, &[("n", &n)]);
    if name.trim().is_empty() {
        ordinal
    } else {
        format!("{ordinal} · {}", name.trim()).into()
    }
}

fn left_body(
    tab: LeftTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    if let Some(panel) = module_panel(tab, ws, pane, window, cx) {
        return div().size_full().child(panel.body).into_any_element();
    }
    let theme = Theme::of(window, cx);
    let book = ws.book.clone();
    let empty_key = match tab {
        LeftTab::Chapters if book.chapters.is_empty() => {
            Some(keys::left_sidebar::empty::NO_CHAPTERS)
        }
        LeftTab::Elements if book.elements.is_empty() && book.categories.is_empty() => {
            Some(keys::left_sidebar::empty::NO_ELEMENTS)
        }
        LeftTab::Drifts if book.ideas.is_empty() && book.idea_groups.is_empty() => {
            Some(keys::left_sidebar::empty::NO_DRIFTS)
        }
        _ => None,
    };
    if let Some(key) = empty_key {
        return empty(key, cx);
    }
    let show_meta = ws.left.width >= META_HIDE_WIDTH;
    let rows = left_rows(
        tab,
        &book,
        ws.chapters_by_book,
        ws.chapter_sort,
        show_meta,
        pane,
        &ws.folded_in(pane),
        &theme,
        cx,
    );
    rows_view(
        format!("left-{}-{}", pane_slug(pane), tab.slug()).into(),
        rows,
        ws,
        cx,
    )
}

fn right_body(
    tab: RightTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    match tab {
        // M31: the 帮手 panel, when the app has one.
        RightTab::Companion => match companion_panel(ws, pane, window, cx) {
            Some(panel) => div().size_full().child(panel.body).into_any_element(),
            None => div().size_full().into_any_element(),
        },
        // M19: the module's panel, when the app has one.
        RightTab::Library if let Some(panel) = library_panel(ws, pane, window, cx) => {
            div().size_full().child(panel.body).into_any_element()
        }
        RightTab::Library => {
            let book = ws.book.clone();
            let material = |id: &str| id.parse().ok().map(Target::Material);
            let mut rows = Vec::new();
            // Folders (素材夹) first, each with its materials; then the
            // materials in no folder.
            let mut folders = Vec::new();
            walk_groups(&book.folders, None, 0, &mut folders);
            for (f, depth) in folders {
                rows.push(heading_row(
                    format!("folder-{}", f.id),
                    f.name.clone().into(),
                    None,
                    None,
                    depth,
                ));
                rows.extend(
                    book.materials
                        .iter()
                        .filter(|m| m.folder.as_deref() == Some(f.id.as_str()))
                        .filter_map(|m| open_row(material(&m.id), "mat", depth + 1, false)),
                );
            }
            let filed = |m: &&dr_workspace::dto::MaterialInfo| {
                m.folder
                    .as_ref()
                    .is_some_and(|f| book.folders.iter().any(|x| &x.id == f))
            };
            rows.extend(
                book.materials
                    .iter()
                    .filter(|m| !filed(m))
                    .filter_map(|m| open_row(material(&m.id), "mat", 0, false)),
            );
            rows_view(
                format!("right-{}-library", pane_slug(pane)).into(),
                rows,
                ws,
                cx,
            )
        }
        // M07: word counts and writing days; M20: the page's own readings.
        // A row opens its page (a chapter of the whole book is shown there);
        // 「历史快照…」 opens M09's history.
        RightTab::Stats => {
            let strings = crate::Strings::get(cx);
            let (locale, platform) = (strings.locale(), strings.platform());
            let shell = cx.weak_entity();
            let book = ws.book.clone();
            let hooks = dr_view_stats::Hooks {
                act: std::rc::Rc::new(move |action, window, cx| {
                    shell
                        .update(cx, |ws, cx| match action {
                            dr_view_stats::StatsAction::Open { target, link } => {
                                let shown = link.is_some_and(|l| ws.open_link(&l, window, cx));
                                if !shown {
                                    ws.super_view = None;
                                    ws.open(crate::book::target(target), Open::KEEP, cx);
                                }
                                cx.notify();
                            }
                            dr_view_stats::StatsAction::History { doc, name } => {
                                ws.open_history(doc, &name, window, cx)
                            }
                        })
                        .ok();
                }),
                marks: std::rc::Rc::new(move |t| book.mark(&crate::book::target(t.clone()))),
            };
            dr_view_stats::panel(
                &format!("stats-{}", pane_slug(pane)),
                &ws.book_id,
                ws.nav.current().map(crate::book::nav_target),
                locale,
                platform,
                Some(hooks),
                cx,
            )
        }
        // M18: comments and TODOs.
        RightTab::Review => {
            let strings = crate::Strings::get(cx);
            let (locale, platform) = (strings.locale(), strings.platform());
            let shell = cx.weak_entity();
            let open: dr_view_review::Opener = std::rc::Rc::new(move |key, window, cx| {
                shell
                    .update(cx, |ws, cx| ws.open_review_target(key, window, cx))
                    .ok();
            });
            dr_view_review::panel(
                &format!("review-{}", pane_slug(pane)),
                &ws.book_id,
                ws.nav.current().map(crate::book::nav_target),
                locale,
                platform,
                open,
                cx,
            )
        }
    }
}

fn empty(key: Key, cx: &mut Context<Workspace>) -> AnyElement {
    dr_ui::components::EmptyState::new(SharedString::from(key.name()), t(cx, key))
        .into_any_element()
}

/// The account cell at the foot of the left sidebar: who, the Project Home
/// (torii) and the notification center (wind bell).
fn account_cell(
    ws: &mut Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let bell = overlay::use_bounds("bell-bounds", window, cx);
    let account = overlay::use_bounds("account-bounds", window, cx);
    let home = ws.nav.current().is_none() && ws.super_view.is_none();
    let open = ws.notifications_open;
    let menu_open = ws.account_open;
    let toggle = cx.entity();
    div()
        .flex_none()
        .h(px(theme.scale.row_height + 14.0))
        .px(px(12.0))
        .border_t(px(0.5))
        .border_color(p.subtle_hairline())
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .child(
            // The account (local only): its menu opens upward, the same
            // one the bookshelf's account cell opens.
            glass::glass_box(
                "account",
                glass::Kind::Hidden,
                glass::Mode::default(),
                menu_open,
                glass::Spec::new(glass::Tone::Clear, 12.0),
                window,
                cx,
            )
            .flex_1()
            .min_w_0()
            .px(px(6.0))
            .py(px(4.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(t(cx, keys::user_menu::LOCAL_MENU))
            .on_click(move |_, _, cx| {
                toggle.update(cx, |ws, cx| {
                    ws.account_open = !ws.account_open;
                    ws.notifications_open = false;
                    cx.notify();
                })
            })
            .child(overlay::probe(account))
            .child(crate::account::avatar(20.0, window, cx))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .font_role(Role::Ui)
                    .type_px(theme.scale.secondary, theme.scale.line_body)
                    .text_color(p.ink(2).solid())
                    .truncate()
                    .child(t(cx, keys::common::LOCAL)),
            ),
        )
        .child(crate::pages::anchor(
            crate::pages::anchors::PROJECT_HOME,
            IconButton::new("home", Icon::Torii)
                .label(t(cx, keys::project_home::KICKER))
                .selected(home)
                .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowProjectHome), cx)),
            cx,
        ))
        .child(
            div()
                .relative()
                .child(overlay::probe(bell))
                .child(crate::pages::anchor(
                    crate::pages::anchors::NOTIFICATIONS,
                    IconButton::new("notifications", Icon::Furin)
                        .label(t(cx, keys::notifications::TITLE))
                        .selected(open)
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(ToggleNotifications), cx)
                        }),
                    cx,
                )),
        )
        .into_any_element()
}

/// The account menu over the left sidebar's account cell.
pub fn account_menu(
    _ws: &mut Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let anchor = *overlay::use_bounds("account-bounds", window, cx).read(cx);
    let entity = cx.entity();
    let close: crate::account::Close = std::rc::Rc::new(move |_, cx| {
        entity.update(cx, |ws, cx| {
            ws.account_open = false;
            cx.notify();
        })
    });
    crate::account::menu("workspace-account", anchor, close, window, cx)
}

/// The notification center: from the bell, upwards when there is no room
/// below; the menus' rich surface.
pub fn notification_center(
    _ws: &mut Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let bell = *overlay::use_bounds("bell-bounds", window, cx).read(cx);
    let place = match bell {
        Some(rect) => Place::Rect {
            rect,
            align: dr_ui::components::Align::End,
            gap: m::HOVER_CARD_GAP,
        },
        None => Place::Center,
    };
    let now = SystemTime::now();
    let items = Notifications::items(cx).to_vec();
    let entity = cx.entity();
    let mut list = div().flex().flex_col();
    if items.is_empty() {
        list = list.child(
            div()
                .px(px(m::HOVER_CARD_PAD))
                .py(px(12.0))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.muted().solid())
                .child(t(cx, keys::notifications::EMPTY)),
        );
    }
    for notice in items {
        let id = notice.id;
        // A crash follow-up opens the feedback dialog about that crash (M39).
        let follow_up = notice.crash_id.clone().map(|crash_id| FollowUpNotice {
            notice: id,
            crash_id,
            at: notice.at,
        });
        let open_follow_up = entity.clone();
        list = list.child(
            div()
                .px(px(m::HOVER_CARD_PAD))
                .py(px(6.0))
                .flex()
                .flex_row()
                .gap(px(8.0))
                .child(
                    div()
                        .id(SharedString::from(format!("notice-text-{id}")))
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .when_some(follow_up, |el, follow_up| {
                            el.cursor_pointer().on_click(move |_, window, cx| {
                                let follow_up = follow_up.clone();
                                open_follow_up.update(cx, |ws, cx| {
                                    ws.open_feedback(Some(follow_up), window, cx)
                                })
                            })
                        })
                        .when_some(notice.opens.clone(), |el, (book, doc)| {
                            let ws = entity.clone();
                            el.cursor_pointer().on_click(move |_, window, cx| {
                                let (book, doc) = (book.clone(), doc.clone());
                                ws.update(cx, |ws, cx| ws.open_noticed(&book, &doc, window, cx))
                            })
                        })
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(6.0))
                                .font_role(Role::Index)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.muted().solid())
                                .child(t(cx, notice.source.label()))
                                .child(notifications::ago(notice.at, now, cx)),
                        )
                        .child(
                            div()
                                .font_role(Role::Ui)
                                .type_px(s.secondary, s.line_body)
                                .text_color(p.ink(1).solid())
                                .child(notice.text.clone()),
                        )
                        .when_some(notice.action.clone(), |el, action| {
                            let run = action.run.clone();
                            el.child(
                                div().pt(px(2.0)).child(
                                    Button::new(
                                        SharedString::from(format!("notice-action-{id}")),
                                        action.label,
                                    )
                                    .text()
                                    .small()
                                    .on_click(
                                        move |_, window, cx| {
                                            // Not the row's click as well (a
                                            // crash follow-up's).
                                            cx.stop_propagation();
                                            run(id, window, cx)
                                        },
                                    ),
                                ),
                            )
                        }),
                )
                .child(
                    PanelIconButton::new(SharedString::from(format!("notice-{id}")), Icon::Close)
                        .label(t(cx, keys::notifications::REMOVE))
                        .on_click(move |_, _, cx| Notifications::remove(id, cx)),
                ),
        );
    }
    let header = div()
        .px(px(m::HOVER_CARD_PAD))
        .pt(px(10.0))
        .pb(px(6.0))
        .flex()
        .flex_row()
        .items_center()
        .child(
            div()
                .flex_1()
                .font_role(Role::Structure)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(1).solid())
                .child(t(cx, keys::notifications::TITLE)),
        )
        .child(
            Button::new("notifications-clear", t(cx, keys::notifications::CLEAR))
                .text()
                .small()
                .on_click(|_, _, cx| Notifications::clear(cx)),
        );
    let panel = div()
        .id("notification-center")
        .occlude()
        .relative()
        .w(px(m::WIDTH_WIDE))
        .max_h(px(480.0))
        .overflow_y_scroll()
        .pb(px(m::PAD_Y))
        .rounded(px(radius::SHEET))
        .bg(p.desk.solid())
        .shadow(float_shadow(p))
        .child(slab_edge(p, radius::SHEET))
        .child(header)
        .child(list)
        .on_mouse_down_out(move |e, _, cx| {
            // The bell toggles it itself.
            if bell.is_some_and(|b| b.contains(&e.position)) {
                return;
            }
            entity.update(cx, |ws, cx| {
                ws.notifications_open = false;
                cx.notify();
            })
        });
    overlay::float(
        place,
        FloatLayer::Popover,
        glass::surface(Ground::flat(p.desk), panel),
    )
}
