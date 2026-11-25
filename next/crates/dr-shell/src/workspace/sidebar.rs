//! The two sidebars (workspace.md): a drawer from each window edge, one or
//! two halves, each half its own tab row over its own panel.
//!
//! - Left: 章节 / 要素 / 构想; right: 审阅 / 关系 / 素材库 / 统计 / 帮手.
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
        Button, Layer as FloatLayer, PanelIconButton, Place, SandCell, Segmented,
        menu::{float_shadow, slab_edge},
        overlay,
    },
    fonts::{Role, weight},
    glass::{self, Ground},
    sand::{self, Icon},
    style::DrStyled,
    tokens::{Rgb, menu as m, motion, radius},
    transitions::Push,
};
use dr_workspace::dto::GroupInfo;
use gpui::{
    AnyElement, App, AppContext as _, Context, DragMoveEvent, ElementId, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, TextRun,
    Window, div, prelude::FluentBuilder as _, px, relative, uniform_list,
};
use serde::{Deserialize, Serialize};

use super::Workspace;
use super::chrome::{self, RIGHT_TOGGLE_END, TITLEBAR_HEIGHT, TOGGLE_GAP};
use super::fill::{FillPlace, MIN_FILL_WIDTH};
use crate::book::Book;
use crate::dialogs::FollowUpNotice;
use crate::nav::{Open, Target};
use crate::notifications::{self, Notifications};
use crate::panes::{PaneId, Panes};
use crate::strings::t;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeftTab {
    // Preserve current v3 layouts that were written before the cutover;
    // all former fixed tabs now show the one canonical entry structure.
    #[serde(alias = "chapters", alias = "elements", alias = "drifts")]
    Structure,
}

impl LeftTab {
    pub const ORDER: [LeftTab; 1] = [LeftTab::Structure];
    pub fn label(self) -> Key {
        keys::k4_pages::ENTRIES
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RightTab {
    Review,
    /// 「关系」 (RL, `kernel-v5.md` §19): drawn by a module
    /// ([`crate::pages::set_relations`]); it never fills the window.
    Relations,
    Library,
    Stats,
    /// Agent.
    Companion,
}

impl RightTab {
    pub const ORDER: [RightTab; 5] = [
        RightTab::Review,
        RightTab::Relations,
        RightTab::Library,
        RightTab::Stats,
        RightTab::Companion,
    ];

    pub fn label(self) -> Key {
        match self {
            RightTab::Review => keys::right_sidebar::tabs::REVIEW,
            RightTab::Relations => keys::v5_relations::TAB,
            RightTab::Library => keys::right_sidebar::tabs::LIBRARY,
            RightTab::Stats => keys::right_sidebar::tabs::STATS,
            RightTab::Companion => keys::v3_settings::RAIL_AGENT,
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

/// What the divider between two panes inside a split sidebar drags.
#[derive(Clone, Copy, Debug)]
pub struct SidebarSplitDrag(pub Side);

pub fn on_split_drag(
    ws: &mut Workspace,
    e: &DragMoveEvent<SidebarSplitDrag>,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    let x = f32::from(e.event.position.x);
    let window_w = f32::from(window.viewport_size().width);
    match e.drag(cx).0 {
        Side::Left => {
            if ws.is_filled(FillPlace::Left) {
                return;
            }
            let w = ws.left.width.max(1.0);
            ws.left.panes.set_ratio(x / w);
        }
        Side::Right => {
            if ws.is_filled(FillPlace::Right) {
                return;
            }
            let w = ws.right.width.max(1.0);
            let left_edge = window_w - w;
            ws.right.panes.set_ratio((x - left_edge) / w);
        }
    }
    ws.changed(cx);
}

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
        (true, Side::Left) => chrome::CLUSTER_END + TOGGLE_GAP,
        (true, Side::Right) => RIGHT_TOGGLE_END + TOGGLE_GAP,
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
        Side::Left => {
            if ws.is_filled(FillPlace::Left) {
                if ws.can_drag_fill_edge(Side::Left) {
                    let max_w = ws.max_fill_width(Side::Left, window_w);
                    let fw = x.round().clamp(MIN_FILL_WIDTH, max_w);
                    ws.fill.set_custom_width((fw < max_w - 6.0).then_some(fw));
                    cx.notify();
                }
                return;
            }
            ws.left.width = x;
        }
        Side::Right => {
            if ws.is_filled(FillPlace::Right) {
                if ws.can_drag_fill_edge(Side::Right) {
                    let max_w = ws.max_fill_width(Side::Right, window_w);
                    let fw = (window_w - x).round().clamp(MIN_FILL_WIDTH, max_w);
                    ws.fill.set_custom_width((fw < max_w - 6.0).then_some(fw));
                    cx.notify();
                }
                return;
            }
            ws.right.width = window_w - x;
        }
    }
    ws.changed(cx);
}

pub fn left(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let window_w = f32::from(window.viewport_size().width);
    let (inner_w, visible) = ws.sidebar_drawn_widths(Side::Left, window_w);
    let can_resize = !ws.is_filled(FillPlace::Left) || ws.can_drag_fill_edge(Side::Left);
    // The page in front brings its own left column (the module workbench's
    // 「装什么」, CM3, `page_panels.rs`).
    let body = if let Some(panels) = ws.page_panels() {
        div()
            .size_full()
            .flex()
            .flex_col()
            .pt(px(TITLEBAR_HEIGHT))
            .child(
                div()
                    .id("left-page-panel")
                    .debug_selector(|| "left-page-panel".into())
                    .flex_1()
                    .min_h_0()
                    .child(panels.left.clone()),
            )
    } else if ws.book.v3().is_some()
        && let Some(library) = ws.library.clone()
    {
        let host = crate::pages::PageViewHost {
            workspace: cx.weak_entity(),
            library,
            book_id: ws.book_id.clone(),
            book: ws.book.clone(),
        };
        let primary = ws
            .v3_sidebar
            .get_or_insert_with(|| cx.new(|cx| crate::v3::sidebar::Sidebar::new(host.clone(), cx)))
            .clone();
        let is_split = ws.left.panes.is_split();
        let left_filled = ws.is_filled(FillPlace::Left);
        let want_struct = std::mem::take(&mut ws.want_template_structure);
        let new_template = std::mem::take(&mut ws.want_new_template);
        let want_keyboard = ws.take_left_keyboard_wish();
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        if is_split {
            let secondary = ws
                .v3_sidebar_secondary
                .get_or_insert_with(|| {
                    cx.new(|cx| crate::v3::sidebar::Sidebar::new_secondary(host.clone(), cx))
                })
                .clone();
            // Dual-pane Fill rule: when left sidebar is split and enters Fill,
            // only the inner (middle-adjacent) pane expands while the outer
            // (window-edge) pane stays intact at its pre-fill width.
            primary.update(cx, |panel, cx| {
                panel.sync(host.clone(), cx);
                panel.sync_fill(false, &ws.tab_fill_layouts, cx);
                panel.set_pane_controls(false, true, cx);
                if want_keyboard {
                    panel.take_keyboard(window, cx);
                }
            });
            secondary.update(cx, |panel, cx| {
                panel.sync(host, cx);
                panel.sync_fill(left_filled, &ws.tab_fill_layouts, cx);
                panel.set_pane_controls(false, true, cx);
                if want_struct {
                    panel.enter_structure(window, cx);
                }
                if new_template {
                    panel.new_structure_template(window, cx);
                }
            });
            let outer_w = (ws.left.width * ws.left.panes.ratio).round().max(180.0);
            let outer_pane = div()
                .h_full()
                .min_w_0()
                .overflow_hidden()
                .when(left_filled, |el| el.flex_none().w(px(outer_w)))
                .when(!left_filled, |el| el.w(relative(ws.left.panes.ratio)))
                .child(primary);
            let divider = if left_filled {
                div()
                    .flex_none()
                    .w(px(0.5))
                    .h_full()
                    .bg(p.local_hairline())
                    .into_any_element()
            } else {
                div()
                    .id("left-split-divider")
                    .flex_none()
                    .w(px(5.0))
                    .mx(px(-2.0))
                    .h_full()
                    .cursor_col_resize()
                    .flex()
                    .justify_center()
                    .on_drag(SidebarSplitDrag(Side::Left), |_, _, _, cx| {
                        cx.new(|_| NoPreview)
                    })
                    .child(div().w(px(0.5)).h_full().bg(p.local_hairline()))
                    .into_any_element()
            };
            let inner_pane = div()
                .flex_1()
                .min_w_0()
                .h_full()
                .overflow_hidden()
                .child(secondary);
            div()
                .size_full()
                .flex()
                .flex_col()
                .pt(px(TITLEBAR_HEIGHT))
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .flex_row()
                        .child(outer_pane)
                        .child(divider)
                        .child(inner_pane),
                )
        } else {
            let can_split = !left_filled && ws.left.panes.can_split && ws.left.panes.keep_single;
            primary.update(cx, |panel, cx| {
                panel.sync(host, cx);
                panel.sync_fill(left_filled, &ws.tab_fill_layouts, cx);
                panel.set_pane_controls(can_split, false, cx);
                if want_struct {
                    panel.enter_structure(window, cx);
                }
                if new_template {
                    panel.new_structure_template(window, cx);
                }
                // ⌘⇧L (KB): the Tab's tree or the Tab row takes the keyboard.
                if want_keyboard {
                    panel.take_keyboard(window, cx);
                }
            });
            div()
                .size_full()
                .flex()
                .flex_col()
                .pt(px(TITLEBAR_HEIGHT))
                .child(div().flex_1().min_h_0().child(primary))
        }
    } else {
        div().size_full().flex().flex_col()
    };

    column(
        Side::Left,
        inner_w,
        visible,
        can_resize,
        ws.is_filled(FillPlace::Left),
        ws.left.shown(),
        ws.fill.animating(),
        body,
        window,
        cx,
    )
}

pub fn right(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let window_w = f32::from(window.viewport_size().width);
    let (inner_w, visible) = ws.sidebar_drawn_widths(Side::Right, window_w);
    let can_resize = !ws.is_filled(FillPlace::Right) || ws.can_drag_fill_edge(Side::Right);
    // The page in front brings its own right tabs, then the Agent (CM3).
    if let Some(panels) = ws.page_panels().cloned() {
        let body = page_panes(ws, &panels, window, cx);
        return column(
            Side::Right,
            inner_w,
            visible,
            can_resize,
            false,
            ws.right.shown(),
            ws.fill.animating(),
            body,
            window,
            cx,
        );
    }
    let filled = ws.is_filled(FillPlace::Right) || ws.fill.progress(FillPlace::Right) > 0.0;
    let panes = ws.right.panes.clone();
    let body = panes_row(ws, Side::Right, &panes, filled, window, cx);
    column(
        Side::Right,
        inner_w,
        visible,
        can_resize,
        ws.is_filled(FillPlace::Right),
        ws.right.shown(),
        ws.fill.animating(),
        body,
        window,
        cx,
    )
}

/// The right column while the page in front brings its tabs
/// ([`crate::pages::PagePanels`]): one pane, its tab row on the title bar's
/// band as a pane's (the moons' slot kept), the page's tabs then 「Agent」;
/// a page tab's body straight under the row, the Agent with its own header
/// row, the same conversation as the 「Agent」 tab of the usual column.
fn page_panes(
    ws: &mut Workspace,
    panels: &crate::pages::PagePanels,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> gpui::Div {
    use crate::pages::AGENT_TAB;
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let Some(target) = ws.nav.current().cloned() else {
        return div();
    };
    let mut labels: Vec<SharedString> = panels.right.iter().map(|tab| t(cx, tab.label)).collect();
    labels.push(t(cx, RightTab::Companion.label()));
    let slugs: Rc<Vec<SharedString>> = Rc::new(
        panels
            .right
            .iter()
            .map(|tab| tab.slug.clone())
            .chain([SharedString::new_static(AGENT_TAB)])
            .collect(),
    );
    let current = ws
        .page_tab()
        .unwrap_or_else(|| SharedString::new_static(AGENT_TAB));
    let selected = slugs.iter().position(|s| *s == current).unwrap_or(0);
    let entity = cx.entity();
    let change = slugs.clone();
    let tabs = Segmented::new("right-page-tabs", labels, selected)
        .motion(motion::PUSH)
        .report_selected()
        .font(Role::Structure)
        .text_size(theme.scale.label)
        .on_change(move |i, _, cx| {
            if let Some(slug) = change.get(i) {
                let slug = slug.clone();
                let target = target.clone();
                entity.update(cx, |ws, cx| ws.show_page_tab(&target, &slug, cx));
            }
        });
    let tab_row = div()
        .id("right-page-tab-row")
        .debug_selector(|| "right-page-tab-row".into())
        .flex_none()
        .h(px(TITLEBAR_HEIGHT))
        .pl(px(6.0))
        .pr(px(RIGHT_TOGGLE_END + TOGGLE_GAP))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .child(crate::pages::anchor(
            crate::pages::anchors::AGENT_TAB,
            tabs,
            cx,
        ))
        .child(div().flex_1());
    let tab_row = chrome::drag_region(tab_row, cx);
    let agent = slugs.get(selected).is_some_and(|s| s.as_ref() == AGENT_TAB);
    let header_h = (theme.scale.row_height * 1.25).max(40.0);
    let companion = agent
        .then(|| companion_panel(ws, crate::panes::PaneId::Primary, window, cx))
        .flatten();
    let header = agent.then(|| {
        div()
            .flex_none()
            .h(px(header_h))
            .pl(px(12.0))
            .pr(px(10.0))
            .border_t(px(0.5))
            .border_color(p.local_hairline())
            .flex()
            .flex_row()
            .items_center()
            .children(
                companion
                    .as_ref()
                    .map(|c| div().size_full().child(c.head.clone())),
            )
    });
    let bodies: Rc<Vec<(SharedString, gpui::AnyView)>> = Rc::new(
        panels
            .right
            .iter()
            .map(|tab| (tab.slug.clone(), tab.body.clone()))
            .collect(),
    );
    let agent_body = companion.map(|c| c.body);
    let body = Push::new(
        "right-page-push",
        slugs.get(selected).cloned().unwrap_or_default(),
        selected,
        move |slug, _, _| {
            if slug.as_ref() == AGENT_TAB {
                return match &agent_body {
                    Some(body) => body.clone().into_any_element(),
                    None => div().into_any_element(),
                };
            }
            bodies
                .iter()
                .find(|(s, _)| s == slug)
                .map(|(_, body)| body.clone().into_any_element())
                .unwrap_or_else(|| div().into_any_element())
        },
    );
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(tab_row)
        .children(header)
        .child(
            div()
                .flex_1()
                .min_h_0()
                .when(!agent, |el| {
                    el.border_t(px(0.5)).border_color(p.local_hairline())
                })
                .child(body),
        )
}

/// The sidebar content slides with its edge.
#[allow(clippy::too_many_arguments)]
fn column(
    side: Side,
    width: f32,
    visible: f32,
    can_resize: bool,
    filled: bool,
    shown: f32,
    fill_animating: bool,
    content: gpui::Div,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    anim::keep_going((shown > 0.0 && shown < 1.0) || fill_animating, window);
    if visible <= 0.0 {
        return div().into_any_element();
    }
    let offset = visible - width;
    let handle = can_resize.then(|| {
        let id = match (side, filled) {
            (Side::Left, false) => "resize-left",
            (Side::Left, true) => "fill-resize-left",
            (Side::Right, false) => "resize-right",
            (Side::Right, true) => "fill-resize-right",
        };
        let mut h = div()
            .id(id)
            .debug_selector(move || id.to_string())
            .absolute()
            .top_0()
            .bottom_0()
            .w(px(6.0))
            .when(side == Side::Left, |el| {
                el.right(px(if filled { 0.0 } else { -3.0 }))
            })
            .when(side == Side::Right, |el| {
                el.left(px(if filled { 0.0 } else { -3.0 }))
            })
            .cursor_col_resize()
            .on_drag(ResizeDrag(side), |_, _, _, cx| cx.new(|_| NoPreview));
        if filled {
            h = h
                .role(gpui::Role::Button)
                .aria_label(t(cx, keys::v5_fill::RESIZE_FILL));
        }
        h
    });
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
        .children(handle)
        .into_any_element()
}

fn panes_row<T>(
    ws: &mut Workspace,
    side: Side,
    panes: &Panes<T>,
    filled: bool,
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
    let outer_fixed_w = if n == 2 && filled {
        match side {
            Side::Left => (ws.left.width * panes.ratio).round().max(180.0),
            Side::Right => (ws.right.width * (1.0 - panes.ratio)).round().max(180.0),
        }
    } else {
        0.0
    };
    for (i, pane) in panes.panes.iter().enumerate() {
        let outer = match side {
            Side::Left => i == 0,
            Side::Right => i == n - 1,
        };
        let is_filling = filled
            && match side {
                Side::Left => i == n - 1,
                Side::Right => i == 0,
            };
        let split_button =
            (!filled && n == 1 && panes.can_split && panes.keep_single).then_some(panes.split_edge);
        let el = pane_view(
            ws,
            side,
            pane.id,
            pane.tab,
            outer,
            is_filling,
            split_button,
            window,
            cx,
        );
        if i == 1 {
            if filled {
                row = row.child(div().flex_none().w(px(0.5)).h_full().bg(p.local_hairline()));
            } else {
                let id = match side {
                    Side::Left => "left-panes-divider",
                    Side::Right => "right-panes-divider",
                };
                row = row.child(
                    div()
                        .id(id)
                        .flex_none()
                        .w(px(5.0))
                        .mx(px(-2.0))
                        .h_full()
                        .cursor_col_resize()
                        .flex()
                        .justify_center()
                        .on_drag(SidebarSplitDrag(side), |_, _, _, cx| cx.new(|_| NoPreview))
                        .child(div().w(px(0.5)).h_full().bg(p.local_hairline())),
                );
            }
        }
        let cell = if n == 2 && filled && !is_filling {
            div()
                .flex_none()
                .w(px(outer_fixed_w))
                .min_w_0()
                .h_full()
                .overflow_hidden()
        } else if n == 2 && !filled && i == 0 {
            div()
                .w(relative(panes.ratio))
                .min_w_0()
                .h_full()
                .overflow_hidden()
        } else {
            div().flex_1().min_w_0().h_full().overflow_hidden()
        };
        row = row.child(cell.child(el));
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
    ) -> Option<AnyElement>;
    fn body(
        self,
        ws: &Workspace,
        pane: PaneId,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> AnyElement;
}

impl PanelTab for RightTab {
    const ORDER: &'static [Self] = &RightTab::ORDER;
    fn key(self) -> Key {
        self.label()
    }
    fn slug(self) -> &'static str {
        match self {
            RightTab::Review => "review",
            RightTab::Relations => "relations",
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
        let filled = ws.is_filled(FillPlace::Right);
        let is_fill_pane = pane == ws.right_fill_pane_id();
        if filled && is_fill_pane && ws.right_fill_tab() == tab {
            return;
        }
        if !ws.right.panes.click(pane, tab) {
            ws.click_crescent(Side::Right, window, cx);
            return;
        }
        if filled && !ws.right_can_fill() {
            ws.exit_fill(window, cx);
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
    ) -> Option<AnyElement> {
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
            && !self.page_panels_shown()
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
        // A page's right column (CM3) shows the primary pane's Agent.
        if self.page_panels_shown() {
            return self.page_tab().as_deref() == Some(crate::pages::AGENT_TAB)
                && panels
                    .get(pane_slug(PaneId::Primary))
                    .and_then(Option::as_ref)
                    .is_some_and(|panel| panel.body.entity_id() == body);
        }
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
    is_filling: bool,
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
        (true, Side::Left) => (chrome::CLUSTER_END + TOGGLE_GAP, 6.0),
        (true, Side::Right) => (6.0, RIGHT_TOGGLE_END + TOGGLE_GAP),
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
    // M24's tour rings the left tabs, and the Agent's tab on the right.
    let tabs = if side == Side::Left {
        crate::pages::anchor(crate::pages::anchors::LEFT_PANEL_TAB, tabs, cx)
    } else {
        match T::ORDER.iter().position(|tab| tab.slug() == "companion") {
            Some(agent) => tabs
                .wrap_option(
                    agent,
                    crate::pages::anchor_with(crate::pages::anchors::AGENT_TAB, cx),
                )
                .into_any_element(),
            None => tabs.into_any_element(),
        }
    };
    // Smoke #8/#10: when the right panel fills the center column, right-align
    // its tabs beside the right moon pair instead of running into the left cluster.
    if side == Side::Right && is_filling {
        tab_row = tab_row.child(div().flex_1()).child(tabs);
    } else {
        tab_row = tab_row.child(tabs).child(div().flex_1());
    }
    if let Some(button) = split {
        tab_row = tab_row.child(button);
    }
    let tab_row = chrome::drag_region(tab_row, cx);
    let header_h = (theme.scale.row_height * 1.25).max(40.0);
    let header = tab.header(ws, pane, window, cx).map(|head| {
        div()
            .flex_none()
            .h(px(header_h))
            .pl(px(12.0))
            .pr(px(10.0))
            .border_t(px(0.5))
            .border_color(p.local_hairline())
            .flex()
            .flex_row()
            .items_center()
            .child(head)
    });
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
    let has_header = header.is_some();
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(tab_row)
        .children(header)
        .child(
            div()
                .flex_1()
                .min_h_0()
                .when(!has_header, |el| {
                    el.border_t(px(0.5)).border_color(p.local_hairline())
                })
                .child(body),
        )
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

/// The 帮手 tab a module draws for `pane` ([`crate::pages::set_companion`]),
/// made the first time the pane shows it (or images are handed to it,
/// [`Workspace::give_agent_images`]), then kept.
pub(super) fn companion_panel(
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

/// The 「关系」 tab a module draws for `pane` ([`crate::pages::set_relations`]),
/// made the first time the pane shows it, then kept.
fn relations_panel(
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Option<crate::pages::LeftPanel> {
    let key = pane_slug(pane);
    if let Some(made) = ws.relations_panel.borrow().get(key) {
        return made.clone();
    }
    let made = crate::pages::relations_for(cx.weak_entity(), window, cx);
    ws.relations_panel.borrow_mut().insert(key, made.clone());
    made
}

fn right_header(
    tab: RightTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Option<AnyElement> {
    let theme = Theme::of(window, cx);
    let row = div().size_full().flex().items_center();
    match tab {
        // Smoke #14: Review owns its own compact filter bar; drop the redundant 40px strip.
        RightTab::Review => None,
        RightTab::Relations => match relations_panel(ws, pane, window, cx) {
            // RL: the module's head row.
            Some(panel) => Some(div().size_full().child(panel.head).into_any_element()),
            None => None,
        },
        RightTab::Library => match library_panel(ws, pane, window, cx) {
            // M19: the module's head row.
            Some(panel) => Some(div().size_full().child(panel.head).into_any_element()),
            None => Some(
                row.child(meta(t(cx, keys::right_sidebar::kickers::LIBRARY), &theme))
                    .into_any_element(),
            ),
        },
        RightTab::Stats => {
            use keys::right_sidebar::kickers::stats as k;
            // Read from the navigation model: what the stats follow.
            let key = match ws.nav.current() {
                None => k::NONE,
                Some(t) if t.is_book() => keys::v3_shell::BOOK_VIEW,

                Some(Target::Material(_)) => k::MATERIAL,
                Some(Target::Entry { .. } | Target::Template(_)) => keys::v3_shell::ENTRIES,
                Some(_) => keys::v3_shell::BOOK_VIEW,
            };
            Some(row.child(meta(t(cx, key), &theme)).into_any_element())
        }
        RightTab::Companion => match companion_panel(ws, pane, window, cx) {
            Some(panel) => Some(div().size_full().child(panel.head).into_any_element()),
            None => None,
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
        let cards = window.use_keyed_state("legacy-sidebar-cards", cx, |_, _| {
            dr_ui::components::hover_card::SidebarCards::default()
        });
        let cards = cards.read(cx).clone();
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
                            hover_card(id, el, target, &entity, &host, cards.clone())
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
    _wash: gpui::Hsla,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    let tail = fold.map(|f| fold_tail(&id, f, ws, theme));
    let (mark, color) = book.mark(&target);
    let label = super::title_of(book, &target, cx);
    let entity = ws.clone();
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
    indented(depth, cell.into_any_element())
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
    cards: dr_ui::components::hover_card::SidebarCards,
) -> AnyElement {
    build_card(id, el, target, ws, host, Rc::default(), None)
        .in_sidebar(dr_ui::components::hover_card::SidebarCard {
            cards,
            on_pointer_open: None,
        })
        .into_any_element()
}

/// A hover card for a page, with extra rows before the dangerous ones.
fn build_card(
    id: SharedString,
    el: AnyElement,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    host: &crate::pages::PageMenuHost,
    extra: Rc<crate::pages::CardRows>,
    keys: Option<gpui::Entity<dr_ui::components::CardKeys>>,
) -> dr_ui::components::HoverCard {
    let (target, ws, host) = (target.clone(), ws.clone(), host.clone());
    let card_id = id.clone();
    let body_keys = keys.clone();
    dr_ui::components::HoverCard::new(
        ElementId::Name(format!("{id}-card").into()),
        el,
        move |window, cx| {
            card_body(
                &card_id,
                &target,
                &ws,
                &host,
                &extra,
                body_keys.as_ref(),
                window,
                cx,
            )
        },
    )
    .when_some(keys, |card, keys| card.keys(keys).beside())
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
    page_hover_card_keyed(id, el, target, ws, rows, None, cx)
}

/// [`page_hover_card`] the keyboard can walk (KB: a left-column Tab's row):
/// with `keys`, the card opens and closes with them ([`CardKeys`]), its
/// rows are lit by the keyboard and say which can be stopped on (a row
/// that does nothing cannot). The rows are [`crate::v3::card::rows`]' with
/// `rows`, in that order.
///
/// [`CardKeys`]: dr_ui::components::CardKeys
pub fn page_hover_card_keyed(
    id: impl Into<SharedString>,
    el: impl IntoElement,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    rows: crate::pages::CardRows,
    keys: Option<gpui::Entity<dr_ui::components::CardKeys>>,
    cx: &App,
) -> AnyElement {
    let host = crate::pages::PageMenuHost::of(ws, cx);
    build_card(
        id.into(),
        el.into_any_element(),
        target,
        ws,
        &host,
        Rc::new(rows),
        keys,
    )
    .into_any_element()
}

/// The left sidebar's page card shares its slot with the rest of the list.
pub fn sidebar_page_hover_card(
    id: impl Into<SharedString>,
    el: impl IntoElement,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    keys: Option<gpui::Entity<dr_ui::components::CardKeys>>,
    sidebar: dr_ui::components::hover_card::SidebarCard,
    cx: &App,
) -> AnyElement {
    let host = crate::pages::PageMenuHost::of(ws, cx);
    build_card(
        id.into(),
        el.into_any_element(),
        target,
        ws,
        &host,
        Rc::default(),
        keys,
    )
    .in_sidebar(sidebar)
    .into_any_element()
}

/// A page's hover card (the 0.1 client's `EntityHoverCard`): a chapter's
/// words, its storylines (the primary first) and summary; a storyline's
/// chapters and words, its summary. Then its actions.
#[allow(clippy::too_many_arguments)]
fn card_body(
    id: &SharedString,
    target: &Target,
    ws: &gpui::Entity<Workspace>,
    host: &crate::pages::PageMenuHost,
    extra: &crate::pages::CardRows,
    keys: Option<&gpui::Entity<dr_ui::components::CardKeys>>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    use dr_ui::components::{CardAction, CardBody};
    if host.book.v3().is_some() && matches!(target, Target::Entry { .. }) {
        return crate::v3::card::body_keyed(id, target, host, extra, keys, window, cx);
    }
    let (mark, color) = host.book.mark(target);
    let mut body = CardBody::new(
        ElementId::Name(format!("{id}-body").into()),
        super::title_of(&host.book, target, cx),
    )
    .mark(mark, color);
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

fn v3_stats_scope(target: Option<&Target>) -> Option<dr_view_stats::v3::Scope> {
    use dr_view_stats::v3::Scope;
    match target {
        None => Some(Scope::Book),
        Some(t) if t.is_book() => Some(Scope::Book),
        Some(Target::Entry { id, module }) => Some(Scope::Entry {
            id: id.to_string(),
            module: module.as_ref().map(ToString::to_string),
        }),
        Some(Target::Material(id)) => Some(Scope::Material(id.to_string())),
        _ => None,
    }
}

fn v3_stats_target(scope: dr_view_stats::v3::Scope) -> Option<Target> {
    use dr_view_stats::v3::Scope;
    Some(match scope {
        Scope::Book => return None,
        Scope::Entry { id, module } => Target::Entry {
            id: id.parse().ok()?,
            module: module.map(|m| m.parse()).transpose().ok()?,
        },
        Scope::Material(id) => Target::Material(id.parse().ok()?),
    })
}

/// The inner None is the real whole-book scope; the outer None rejects pages
/// such as templates rather than silently turning them into whole-book review.
fn v3_review_scope(target: Option<&Target>) -> Option<Option<dr_view_review::v3::Target>> {
    use dr_view_review::v3::Target as ReviewTarget;
    Some(match target {
        None => None,
        Some(t) if t.is_book() => None,
        Some(Target::Entry { id, module }) => Some(ReviewTarget::Entry {
            id: id.to_string(),
            module: module.as_ref().map(ToString::to_string),
        }),
        Some(Target::Material(id)) => Some(ReviewTarget::Material(id.to_string())),
        _ => return None,
    })
}

fn v3_review_target(target: dr_view_review::v3::Target) -> Option<Target> {
    use dr_view_review::v3::Target as ReviewTarget;
    Some(match target {
        ReviewTarget::Entry { id, module } => Target::Entry {
            id: id.parse().ok()?,
            module: module.map(|m| m.parse()).transpose().ok()?,
        },
        ReviewTarget::Material(id) => Target::Material(id.parse().ok()?),
    })
}

/// A cached panel may outlive a book or library switch. Its navigation
/// callback owns neither the workspace nor a lease on the previous library.
struct V3PanelOwner {
    book: String,
    library: usize,
}
impl V3PanelOwner {
    fn of(ws: &Workspace) -> Option<Self> {
        let library = ws.library.as_ref()?;
        (ws.book.v3().is_some() && ws.book.id == ws.book_id).then(|| Self {
            book: ws.book_id.clone(),
            library: library.library() as *const _ as usize,
        })
    }
    fn matches(&self, ws: &Workspace) -> bool {
        ws.book_id == self.book
            && ws.book.id == self.book
            && ws.book.v3().is_some()
            && ws
                .library
                .as_ref()
                .is_some_and(|lib| lib.library() as *const _ as usize == self.library)
    }
}

fn v3_stats_open(
    ws: &Workspace,
    cx: &mut Context<Workspace>,
) -> Option<dr_view_stats::v3_panel::Open> {
    let owner = V3PanelOwner::of(ws)?;
    let shell = cx.weak_entity();
    Some(Rc::new(move |scope, _, cx| {
        let Some(target) = v3_stats_target(scope) else {
            return;
        };
        shell
            .update(cx, |ws, cx| {
                if owner.matches(ws) && ws.book.exists(&target) {
                    ws.open(target, Open::KEEP, cx);
                }
            })
            .ok();
    }))
}

fn v3_stats_open_history(
    ws: &Workspace,
    cx: &mut Context<Workspace>,
) -> Option<dr_view_stats::v3_panel::OpenHistory> {
    let owner = V3PanelOwner::of(ws)?;
    let shell = cx.weak_entity();
    Some(Rc::new(move |doc, name, window, cx| {
        shell
            .update(cx, |ws, cx| {
                if owner.matches(ws) {
                    ws.open_history(doc.clone(), &name, window, cx);
                }
            })
            .ok();
    }))
}

fn v3_review_open(
    ws: &Workspace,
    cx: &mut Context<Workspace>,
) -> Option<dr_view_review::v3_panel::Open> {
    let owner = V3PanelOwner::of(ws)?;
    let shell = cx.weak_entity();
    Some(Rc::new(move |source, _, cx| {
        let Some(target) = v3_review_target(source) else {
            return;
        };
        shell
            .update(cx, |ws, cx| {
                if owner.matches(ws) && ws.book.exists(&target) {
                    ws.open(target, Open::KEEP, cx);
                }
            })
            .ok();
    }))
}

fn v3_review_open_agent(
    ws: &Workspace,
    pane: PaneId,
    cx: &mut Context<Workspace>,
) -> Option<dr_view_review::v3_panel::OpenAgent> {
    let owner = V3PanelOwner::of(ws)?;
    let shell = cx.weak_entity();
    Some(Rc::new(move |req, window, cx| {
        shell
            .update(cx, |ws, cx| {
                if owner.matches(ws) {
                    ws.open_companion_for_comment(pane, req, window, cx);
                }
            })
            .ok();
    }))
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
        // RL: the module's panel, when the app has one.
        RightTab::Relations => match relations_panel(ws, pane, window, cx) {
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
            walk_groups(book.material_folders(), None, 0, &mut folders);
            for (f, depth) in folders {
                rows.push(heading_row(
                    format!("folder-{}", f.id),
                    f.name.clone().into(),
                    None,
                    None,
                    depth,
                ));
                rows.extend(
                    book.material_items()
                        .iter()
                        .filter(|m| m.folder.as_deref() == Some(f.id.as_str()))
                        .filter_map(|m| open_row(material(&m.id), "mat", depth + 1, false)),
                );
            }
            let filed = |m: &&crate::book::MaterialInfo| {
                m.folder
                    .as_ref()
                    .is_some_and(|f| book.material_folders().iter().any(|x| &x.id == f))
            };
            rows.extend(
                book.material_items()
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

            let Some(scope) = v3_stats_scope(ws.nav.current()) else {
                return div().into_any_element();
            };
            let open = v3_stats_open(ws, cx);
            let open_history = v3_stats_open_history(ws, cx);
            let stats_id = format!("stats-{}", pane_slug(pane));
            let scope_label = match &scope {
                dr_view_stats::v3::Scope::Book => keys::workspace_word_tally::BOOK,
                dr_view_stats::v3::Scope::Entry { .. } => keys::k4_book::ENTRY_WORDS,
                dr_view_stats::v3::Scope::Material(_) => keys::k4_book::MATERIAL_WORDS,
            };
            let panel = dr_view_stats::v3_panel::panel(
                &stats_id,
                &ws.book_id,
                scope,
                locale,
                platform,
                open,
                cx,
            );
            let fill_width = (ws.is_filled(FillPlace::Right) && pane == ws.right_fill_pane_id())
                .then(|| {
                    let total =
                        ws.target_fill_width(Side::Right, f32::from(window.viewport_size().width));
                    if ws.right.panes.is_split() {
                        let outer = (ws.right.width * (1.0 - ws.right.panes.ratio))
                            .round()
                            .max(180.0);
                        (total - outer).max(240.0)
                    } else {
                        total
                    }
                });
            dr_view_stats::v3_panel::set_open_history(&stats_id, open_history, cx);
            dr_view_stats::v3_panel::set_fill_width(&stats_id, fill_width, cx);
            div()
                .id(SharedString::from(format!("v3-stats-{}", pane_slug(pane))))
                .size_full()
                .role(gpui::Role::Group)
                .aria_label(t(cx, keys::right_sidebar::tabs::STATS))
                .child(
                    div()
                        .id(SharedString::from(format!(
                            "v3-stats-scope-{}",
                            pane_slug(pane)
                        )))
                        .size_full()
                        .role(gpui::Role::Group)
                        .aria_label(t(cx, scope_label))
                        .child(panel),
                )
                .into_any_element()
        }
        // M18: comments and TODOs.
        RightTab::Review => {
            let strings = crate::Strings::get(cx);
            let (locale, platform) = (strings.locale(), strings.platform());

            let Some(scope) = v3_review_scope(ws.nav.current()) else {
                return div().into_any_element();
            };
            let Some(open) = v3_review_open(ws, cx) else {
                return div().into_any_element();
            };
            let open_agent = v3_review_open_agent(ws, pane, cx);
            let book = ws.book.clone();
            let marks = Rc::new(move |target: &dr_view_review::v3::Target| {
                v3_review_target(target.clone()).map(|t| book.mark(&t).0)
            });
            let review_id = format!("review-{}", pane_slug(pane));
            let panel = dr_view_review::v3_panel::panel(
                &review_id,
                &ws.book_id,
                scope,
                locale,
                platform,
                open,
                marks,
                cx,
            );
            let fill_width = (ws.is_filled(FillPlace::Right) && pane == ws.right_fill_pane_id())
                .then(|| {
                    let total =
                        ws.target_fill_width(Side::Right, f32::from(window.viewport_size().width));
                    if ws.right.panes.is_split() {
                        let outer = (ws.right.width * (1.0 - ws.right.panes.ratio))
                            .round()
                            .max(180.0);
                        (total - outer).max(240.0)
                    } else {
                        total
                    }
                });
            let book_for_colors = ws.book.clone();
            let mark_colors = Rc::new(move |target: &dr_view_review::v3::Target| {
                v3_review_target(target.clone()).and_then(|t| book_for_colors.mark(&t).1)
            });
            dr_view_review::v3_panel::set_fill_width(&review_id, fill_width, cx);
            dr_view_review::v3_panel::set_open_agent(&review_id, open_agent, cx);
            dr_view_review::v3_panel::set_mark_colors(&review_id, Some(mark_colors), cx);
            div()
                .id(SharedString::from(format!("v3-review-{}", pane_slug(pane))))
                .size_full()
                .role(gpui::Role::Group)
                .aria_label(t(cx, keys::right_sidebar::tabs::REVIEW))
                .child(panel)
                .into_any_element()
        }
    }
}

/// The account menu, dropping from its button right of the traffic lights.
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
            align: dr_ui::components::Align::Start,
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
                                .items_center()
                                .gap(px(6.0))
                                .font_role(Role::Index)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.muted().solid())
                                .when(notice.running, |el| {
                                    el.child(sand::icon(Icon::Rotate, 11.0, p.accent.solid()))
                                })
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
                        .when_some(notice.progress, |el, value| {
                            el.child(
                                div().pt(px(4.0)).child(
                                    sand::Readout::new(
                                        SharedString::from(format!("notice-progress-{id}")),
                                        value,
                                    )
                                    .color(p.accent),
                                ),
                            )
                        })
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
                .when(!notice.pinned && !notice.running, |el| {
                    el.child(
                        PanelIconButton::new(
                            SharedString::from(format!("notice-{id}")),
                            Icon::Close,
                        )
                        .label(t(cx, keys::notifications::REMOVE))
                        .on_click(move |_, _, cx| Notifications::remove(id, cx)),
                    )
                }),
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
                .disabled(!Notifications::has_clearable(cx))
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

/// Brief arrival pill shown under the bell for a few seconds when a new notice
/// lands while the notification center is closed.
pub fn arrival_flash(
    ws: &Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> Option<AnyElement> {
    if ws.notifications_open || ws.immersive {
        return None;
    }
    let text = Notifications::arrival_flash(cx)?.text.clone();
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let entity = cx.entity();
    let rect = (*overlay::use_bounds("bell-bounds", window, cx).read(cx))?;
    let place = Place::Rect {
        rect,
        align: dr_ui::components::Align::Start,
        gap: m::HOVER_CARD_GAP,
    };
    let card = div()
        .id("notification-arrival-flash")
        .occlude()
        .cursor_pointer()
        .max_w(px(300.0))
        .px(px(12.0))
        .py(px(8.0))
        .rounded(px(radius::SHEET))
        .bg(p.desk.solid())
        .shadow(float_shadow(p))
        .child(slab_edge(p, radius::SHEET))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .on_click(move |_, _, cx| {
            entity.update(cx, |ws, cx| {
                ws.notifications_open = true;
                Notifications::mark_read(cx);
                cx.notify();
            });
        })
        .child(sand::icon(Icon::Furin, 13.0, p.accent.solid()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(1).solid())
                .child(text),
        );
    Some(
        overlay::float(
            place,
            FloatLayer::Popover,
            glass::surface(Ground::flat(p.desk), card),
        )
        .into_any_element(),
    )
}

#[cfg(test)]
mod v3_panel_tests {
    use super::*;
    use dr_view_stats::v3::Scope;
    use gpui::{TestAppContext, VisualTestContext};
    use std::time::{Duration, Instant};

    #[test]
    fn scope_roundtrips_modules_without_a_legacy_book_sentinel() {
        for key in [
            "entry:one",
            "entry:one/mod-prose",
            "entry:one/mod-fields",
            "material:one",
        ] {
            let target = Target::from_key(key).unwrap();
            let scope = v3_stats_scope(Some(&target)).unwrap();
            assert_eq!(v3_stats_target(scope), Some(target));
        }
        assert_eq!(v3_stats_scope(None), Some(Scope::Book));
        assert_eq!(
            v3_stats_scope(Some(&Target::from_key("book:one").unwrap())),
            Some(Scope::Book)
        );
        assert!(v3_stats_target(Scope::Book).is_none());
        {
            let key = "template:tpl-chapter";
            assert_eq!(v3_stats_scope(Some(&Target::from_key(key).unwrap())), None);
        }
        for key in ["book", "book:", "chapter:one", "element:one"] {
            assert!(Target::from_key(key).is_none());
        }
        assert!(
            v3_stats_target(Scope::Entry {
                id: "one".into(),
                module: Some(String::new()),
            })
            .is_none()
        );
        assert_eq!(v3_review_scope(None), Some(None));
        assert_eq!(
            v3_review_scope(Some(&Target::from_key("book:one").unwrap())),
            Some(None)
        );
        for key in [
            "entry:one",
            "entry:one/mod-prose",
            "entry:one/mod-fields",
            "material:one",
        ] {
            let target = Target::from_key(key).unwrap();
            let scope = v3_review_scope(Some(&target)).unwrap().unwrap();
            assert_eq!(v3_review_target(scope), Some(target));
        }
        assert_eq!(
            v3_review_scope(Some(&Target::from_key("template:tpl-chapter").unwrap())),
            None
        );
    }

    fn fixture() -> (tempfile::TempDir, dr_workspace::Workspace, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev"))
            .unwrap();
        let made = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = made.books[0].book_id().to_string();
        made.write_to(&store).unwrap();
        store.close().unwrap();
        let library = dr_workspace::Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
        let notes_root = dr_testkit::seed::acceptance::novel_root(&library, &book, "tpl-group");
        library
            .call(
                &dr_workspace::Actor::User,
                "entry_template.put",
                serde_json::json!({
                    "book": &book,
                    "template": {
                        "id": "tpl-custom-media",
                        "name": "自定义媒体",
                        "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]
                    }
                }),
            )
            .unwrap();
        library
            .call(
                &dr_workspace::Actor::User,
                "asset.put",
                serde_json::json!({
                    "book": &book,
                    "id": "00000000-0000-7000-8000-0000000000f1",
                    "kind": "image",
                    "mime": "image/png",
                    "size": 68,
                    "sha256": "00000000000000000000000000000000000000000000000000000000000000f1",
                    "width": 16,
                    "height": 16
                }),
            )
            .unwrap();
        let media_entry = library
            .call(
                &dr_workspace::Actor::User,
                "entry.create",
                serde_json::json!({
                    "book": &book,
                    "template": "tpl-custom-media",
                    "parent": notes_root,
                    "title": "附图"
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        library
            .call(
                &dr_workspace::Actor::User,
                "module.put_media",
                serde_json::json!({
                    "book": &book,
                    "entry": media_entry,
                    "module": "mod-media",
                    "item": {
                        "id": "00000000-0000-7000-8000-0000000000f2",
                        "asset": "00000000-0000-7000-8000-0000000000f1"
                    }
                }),
            )
            .unwrap();
        (dir, library, book)
    }

    fn wait(cx: &mut VisualTestContext, done: impl Fn(&App) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            cx.executor().advance_clock(Duration::from_millis(50));
            cx.run_until_parked();
            if cx.update(|_, cx| done(cx)) {
                break;
            }
            assert!(Instant::now() < deadline, "v3 panel host did not settle");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[gpui::test]
    fn actual_panel_keeps_scope_and_rejects_old_book_or_library_callbacks(cx: &mut TestAppContext) {
        let (_dir, lib, book) = fixture();
        let (_other_dir, other_lib, same_book) = fixture();
        assert_eq!(
            book, same_book,
            "same IDs cannot substitute for library identity"
        );
        cx.executor().allow_parking();
        cx.update(|cx| {
            crate::init(
                crate::ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                crate::Services {
                    library: Some(lib.clone()),
                    book: Some(book.clone()),
                    ..Default::default()
                },
                crate::SettingsFile::in_memory(),
                cx,
            );
        });
        let (shell, cx) = cx.add_window_view(Workspace::new);
        wait(cx, |cx| shell.read(cx).book.v3().is_some());
        let (entry, other_entry, root, nonprose, material) = shell.read_with(cx, |ws, _| {
            let v = ws.book.v3().unwrap();
            let mut chapters = v
                .entries
                .iter()
                .filter(|e| e.template.as_deref() == Some("tpl-chapter"));
            let entry = chapters.next().unwrap();
            let other = chapters.next().unwrap();
            let nonprose = v
                .template_of(&entry.id)
                .unwrap()
                .modules
                .iter()
                .find(|m| m.kind != "prose")
                .unwrap();
            (
                entry.id.clone(),
                other.id.clone(),
                v.roots[0].clone(),
                nonprose.id.clone(),
                v.materials[0].id.clone(),
            )
        });
        for target in [
            None,
            Target::from_key(&format!("book:{root}")),
            Target::from_key(&format!("entry:{entry}")),
            Target::from_key(&format!("entry:{entry}/mod-prose")),
            Target::from_key(&format!("entry:{entry}/{nonprose}")),
            Target::from_key(&format!("material:{material}")),
        ] {
            let expected = v3_stats_scope(target.as_ref()).unwrap();
            shell.update_in(cx, |ws, window, cx| {
                if let Some(target) = target {
                    // One entry is one tab (kernel v5, T1): each target on a
                    // tab of its own, so the panel follows exactly it.
                    ws.nav.close_active();
                    ws.open(target, Open::KEEP, cx);
                }
                drop(right_body(RightTab::Stats, ws, PaneId::Primary, window, cx));
            });
            let panel = cx
                .update(|_, cx| dr_view_stats::v3_panel::view("stats-primary", cx))
                .unwrap();
            wait(cx, |cx| {
                panel.read(cx).loaded().is_some_and(|d| d.scope == expected)
            });
            panel.read_with(cx, |view, _| {
                let data = view.loaded().unwrap();
                if matches!(&expected, Scope::Entry { module: Some(m), .. } if m == &nonprose) {
                    assert!(
                        data.documents.is_empty(),
                        "non-prose has no fallback to manuscript words"
                    );
                }
                if matches!(&expected, Scope::Entry { module: Some(m), .. } if m == "mod-prose") {
                    assert_eq!(data.documents.len(), 1);
                    assert_eq!(data.documents[0].module.as_deref(), Some("mod-prose"));
                }
            });
        }
        let open = shell.update(cx, |ws, cx| v3_stats_open(ws, cx).unwrap());
        let scope = Scope::Entry {
            id: entry,
            module: Some("mod-prose".into()),
        };
        let other_scope = Scope::Entry {
            id: other_entry,
            module: Some("mod-prose".into()),
        };
        let target = v3_stats_target(scope.clone()).unwrap();
        cx.update(|window, cx| open(scope, window, cx));
        shell.read_with(cx, |ws, _| assert_eq!(ws.nav.current(), Some(&target)));
        shell.update(cx, |ws, _| ws.book_id = "different-book".into());
        cx.update(|window, cx| open(other_scope.clone(), window, cx));
        shell.read_with(cx, |ws, _| assert_eq!(ws.nav.current(), Some(&target)));
        shell.update(cx, |ws, _| {
            ws.book_id = book;
            ws.library = Some(other_lib);
        });
        cx.update(|window, cx| open(other_scope, window, cx));
        shell.read_with(cx, |ws, _| assert_eq!(ws.nav.current(), Some(&target)));
        cx.update(|_, cx| dr_view_stats::release(cx));
    }

    #[gpui::test]
    fn review_panel_follows_exact_module_and_isolates_cached_navigation(cx: &mut TestAppContext) {
        use dr_workspace::Actor;
        use serde_json::json;
        use std::collections::BTreeSet;

        let (_dir, lib, book) = fixture();
        let (_other_dir, other_lib, same_book) = fixture();
        assert_eq!(book, same_book);
        let snapshot = Book::load(&lib, &book).unwrap();
        let v = snapshot.v3().unwrap();
        let root = v.roots[0].clone();
        let mut chapters = v
            .entries
            .iter()
            .filter(|e| e.template.as_deref() == Some("tpl-chapter"));
        let entry = chapters.next().unwrap().id.clone();
        let other_entry = chapters.next().unwrap().id.clone();
        let nonprose = v
            .template_of(&entry)
            .unwrap()
            .modules
            .iter()
            .find(|m| m.kind != "prose")
            .unwrap()
            .id
            .clone();
        let mat_info = v.media_items.values().next().unwrap();
        let material = mat_info.id.clone();
        let mat_entry = mat_info.entry.clone().unwrap();
        let mat_mod = mat_info.module.clone().unwrap();
        let mat_file = mat_info.asset.clone().unwrap();
        // Floating/unlocated comments need no range anchoring. This host test
        // exercises scope and navigation through the actual panel.
        let inputs = [
            json!({"target":{"kind":"entry","id":entry},"module":"mod-prose"}),
            json!({"target":{"kind":"entry","id":entry}}),
            json!({"target":{"kind":"entry","id":other_entry},"module":"mod-prose"}),
            json!({"target":{"kind":"entry","id":mat_entry},"module":mat_mod,"part":{"kind":"media","asset":mat_file}}),
            json!({}),
        ];
        let comments: Vec<String> = inputs
            .into_iter()
            .enumerate()
            .map(|(i, mut input)| {
                input["book"] = book.clone().into();
                input["body"] = format!("Synthetic review host {i}").into();
                lib.call(&Actor::User, "comment.create", input).unwrap()["output"]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        let listed = |view: &dr_view_review::ReviewView| -> BTreeSet<String> {
            let listing = view.listing();
            listing
                .open
                .iter()
                .chain(&listing.resolved)
                .flat_map(|g| &g.items)
                .filter(|i| comments.contains(&i.id))
                .map(|i| i.id.clone())
                .collect()
        };
        cx.executor().allow_parking();
        cx.update(|cx| {
            crate::init(
                crate::ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                crate::Services {
                    library: Some(lib.clone()),
                    book: Some(book.clone()),
                    ..Default::default()
                },
                crate::SettingsFile::in_memory(),
                cx,
            )
        });
        let (shell, cx) = cx.add_window_view(Workspace::new);
        wait(cx, |cx| shell.read(cx).book.v3().is_some());
        shell.update_in(cx, |ws, window, cx| {
            drop(right_body(
                RightTab::Review,
                ws,
                PaneId::Primary,
                window,
                cx,
            ));
        });
        let panel = cx
            .update(|_, cx| dr_view_review::view("review-primary", cx))
            .unwrap();
        wait(cx, |cx| listed(panel.read(cx)).len() == comments.len());
        panel.update(cx, |v, cx| {
            v.set_filter(dr_view_review::Filter::All, cx);
            v.set_current_only(true, cx);
        });
        for (target, expected) in [
            (
                Target::from_key(&format!("book:{root}")).unwrap(),
                vec![0, 1, 2, 3, 4],
            ),
            (
                Target::from_key(&format!("entry:{entry}")).unwrap(),
                vec![0, 1],
            ),
            (
                Target::from_key(&format!("entry:{entry}/mod-prose")).unwrap(),
                vec![0],
            ),
            (
                Target::from_key(&format!("entry:{entry}/{nonprose}")).unwrap(),
                vec![],
            ),
            (
                Target::from_key(&format!("material:{material}")).unwrap(),
                vec![3],
            ),
        ] {
            shell.update_in(cx, |ws, window, cx| {
                // One entry is one tab (kernel v5, T1): each target on a
                // tab of its own, so the panel follows exactly it.
                ws.nav.close_active();
                ws.open(target, Open::KEEP, cx);
                drop(right_body(
                    RightTab::Review,
                    ws,
                    PaneId::Primary,
                    window,
                    cx,
                ));
            });
            let expected: BTreeSet<_> = expected.into_iter().map(|i| comments[i].clone()).collect();
            panel.read_with(cx, |v, _| assert_eq!(listed(v), expected));
        }
        // Jump through the actual ReviewView's stored opener, with the module
        // intact; changing scope must not rewrite a comment's source identity.
        cx.update(|window, cx| panel.update(cx, |v, cx| v.jump(&comments[0], window, cx)));
        let target = Target::from_key(&format!("entry:{entry}/mod-prose")).unwrap();
        shell.read_with(cx, |ws, _| assert_eq!(ws.nav.current(), Some(&target)));
        let old_open = shell.update(cx, |ws, cx| v3_review_open(ws, cx).unwrap());
        let material = dr_view_review::v3::Target::Material(material);
        shell.update(cx, |ws, _| ws.book_id = "different-book".into());
        cx.update(|window, cx| old_open(material.clone(), window, cx));
        shell.read_with(cx, |ws, _| assert_eq!(ws.nav.current(), Some(&target)));
        shell.update(cx, |ws, _| {
            ws.book_id = book;
            ws.library = Some(other_lib);
        });
        cx.update(|window, cx| old_open(material, window, cx));
        shell.read_with(cx, |ws, _| assert_eq!(ws.nav.current(), Some(&target)));
        cx.update(|_, cx| dr_view_review::release(cx));
    }

    #[gpui::test]
    fn shared_entry_drag_retains_gesture_and_rejects_other_or_stale_hosts(cx: &mut TestAppContext) {
        use crate::{pages::PageViewHost, v3::EntryDrag};
        use std::cell::Cell;

        let (_dir, lib, book) = fixture();
        let (_other_dir, other_lib, same_book) = fixture();
        assert_eq!(book, same_book);
        cx.executor().allow_parking();
        cx.update(|cx| {
            crate::init(
                crate::ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                crate::Services {
                    library: Some(lib.clone()),
                    book: Some(book.clone()),
                    ..Default::default()
                },
                crate::SettingsFile::in_memory(),
                cx,
            )
        });
        let (shell, cx) = cx.add_window_view(Workspace::new);
        wait(cx, |cx| shell.read(cx).book.v3().is_some());
        let page = shell.read_with(cx, |ws, _| PageViewHost {
            workspace: shell.downgrade(),
            library: lib.clone(),
            book_id: book.clone(),
            book: ws.book.clone(),
        });
        let entry = page.book.v3().unwrap().entries[0].id.clone();
        let private_press = Rc::new(Cell::new(41_u32));
        let mut drag = EntryDrag::new(page.clone(), &entry, "Synthetic shared drag")
            .with_source(private_press.clone());
        drag.span = Some(7.0);
        let cloned = drag.clone();
        cloned.set_grab(23.0);
        cloned.set_grab(f32::NAN);
        cloned.source::<Rc<Cell<u32>>>().unwrap().set(42);
        assert_eq!(drag.grab(), 23.0);
        assert_eq!(drag.span, Some(7.0));
        assert_eq!(drag.source::<Rc<Cell<u32>>>().unwrap().get(), 42);
        assert!(drag.source::<String>().is_none());
        assert!(drag.matches(&page));
        assert!(cx.update(|_, cx| drag.is_current(cx)));
        assert!(!EntryDrag::new(page.clone(), "missing-entry", "Synthetic missing").matches(&page));
        assert!(!drag.matches(&PageViewHost {
            library: other_lib.clone(),
            ..page.clone()
        }));
        assert!(!drag.matches(&PageViewHost {
            book_id: "different-book".into(),
            ..page.clone()
        }));
        let other_shell = cx.update(|window, cx| cx.new(|cx| Workspace::new(window, cx)));
        assert!(!drag.matches(&PageViewHost {
            workspace: other_shell.downgrade(),
            ..page.clone()
        }));
        lib.call(
            &dr_workspace::Actor::User,
            "entry.update",
            serde_json::json!({"book":book,"id":entry,"title":"Synthetic concurrent drag rename"}),
        )
        .unwrap();
        let new_book = Rc::new(Book::load(&lib, &book).unwrap());
        assert!(!drag.matches(&PageViewHost {
            book: new_book.clone(),
            ..page.clone()
        }));
        shell.update(cx, |ws, _| ws.book = new_book);
        assert!(!cx.update(|_, cx| drag.is_current(cx)));
        shell.update(cx, |ws, _| {
            ws.book = page.book.clone();
            ws.book_id = "different-book".into();
        });
        assert!(!cx.update(|_, cx| drag.is_current(cx)));
        shell.update(cx, |ws, _| {
            ws.book_id = book;
            ws.library = Some(other_lib);
        });
        assert!(!cx.update(|_, cx| drag.is_current(cx)));
    }
}
