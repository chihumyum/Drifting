//! The two sidebars (workspace.md): a drawer from each window edge, one or
//! two halves, each half its own tab row over its own panel.
//!
//! - Left: 章节 / 要素 / 构想; right: 审阅 / 素材库 / 统计 / 帮手.
//! - Opening and closing is the structural motion (420 ms); switching a
//!   half's tab pushes its panel like a block of ice (265 ms), and the glass
//!   block under the tab rides the same push.
//! - A half's minimum width is its tab row's; two halves fit when the
//!   sidebar is twice that plus the hairline between them.
//! - The panels are placeholders filled from the stand-in book until their
//!   modules (M-chapters, M-elements, …) take them over.

use std::time::SystemTime;

use dr_i18n::{Key, keys};
use dr_ui::{
    Theme, anim,
    components::{
        Button, IconButton, Layer as FloatLayer, PanelIconButton, Place,
        menu::{float_shadow, slab_edge},
        overlay,
    },
    fonts::{Role, weight},
    glass::{self, Ground, Kind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark, SandFrame},
    style::DrStyled,
    tokens::{Story, glass as g, menu as m, radius},
    transitions::Push,
};
use gpui::{
    AnyElement, App, AppContext as _, Context, DragMoveEvent, ElementId, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, TextRun,
    Window, div, prelude::FluentBuilder as _, px,
};
use serde::{Deserialize, Serialize};

use super::chrome::{self, LEADING_INSET, TITLEBAR_HEIGHT, TOGGLE_GAP, TRAILING_INSET};
use super::panel_tabs::{self, PanelTabs, TAB_PAD};
use super::{SuperView, Workspace};
use crate::actions::{ShowProjectHome, ToggleNotifications};
use crate::nav::{Open, Target};
use crate::notifications::{self, Notifications};
use crate::panes::{PaneId, Panes};
use crate::strings::{t, tf};

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

/// The width of a tab row: the labels with their padding, 6px at each end,
/// and the toggle's slot for the half by the window edge.
fn row_width(labels: &[Key], with_toggle: bool, side: Side, window: &Window, cx: &App) -> f32 {
    let theme = Theme::of(window, cx);
    let size = px(panel_tabs::label_size(&theme));
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
    let tabs = PanelTabs::new(ElementId::Name(id("tabs")), labels, selected).on_click(
        move |i, window, cx| {
            let tab = order[i];
            entity.update(cx, |ws, cx| T::click(ws, pane, tab, window, cx));
        },
    );
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

fn left_header(
    tab: LeftTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let book = &ws.book;
    let slug = pane_slug(pane);
    match tab {
        LeftTab::Chapters => {
            let text = tf(
                cx,
                keys::left_sidebar::view_mode::CHAPTER_SUMMARY,
                &[
                    ("storylines", &book.storylines.len()),
                    ("chapters", &book.chapters.len()),
                ],
            );
            let selected = ws.nav.is_selected(&Target::Book);
            let entity = cx.entity();
            div()
                .size_full()
                .flex()
                .items_center()
                .child(meta(text, &theme))
                .child(
                    IconButton::new(SharedString::from(format!("book-{slug}")), Icon::OpenBook)
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
                .child(
                    IconButton::new(
                        SharedString::from(format!("elements-sv-{slug}")),
                        Icon::KnotLinks,
                    )
                    .selected(selected)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |ws, cx| ws.toggle_super_view(SuperView::Elements, cx))
                    }),
                )
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
        RightTab::Library => row
            .child(meta(t(cx, keys::right_sidebar::kickers::LIBRARY), &theme))
            .child(super_entry(ws, cx, "library"))
            .into_any_element(),
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
        RightTab::Companion => row.into_any_element(),
    }
}

/// A cell (components.md, 「Cell」): its mark always shown, a hairline glass
/// ring under the hand, a sand frame drawn when selected and ink-1 text.
#[allow(clippy::too_many_arguments)]
fn cell(
    id: SharedString,
    kind: sand::Kind,
    color: Option<dr_ui::tokens::Rgb>,
    label: &'static str,
    selected: bool,
    structure: bool,
    target: Target,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let tone = color.map_or(Tone::Clear, Tone::Color);
    let el = glass::glass_box(
        ElementId::Name(id.clone()),
        Kind::Hidden,
        Mode::default(),
        false,
        Spec::new(tone, radius::SM).rim(3.0),
        window,
        cx,
    );
    let mark = KindMark::new(ElementId::Name(format!("{id}-mark").into()), kind);
    let mark = match color {
        Some(c) => mark.color(c),
        None => mark,
    };
    let frame = SandFrame::new(ElementId::Name(format!("{id}-frame").into()), selected);
    let frame = match color {
        Some(c) => frame.color(c),
        None => frame,
    };
    let entity = cx.entity();
    el.h(px(theme.scale.row_height))
        .px(px(10.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .cursor_pointer()
        .font_role(if structure { Role::Structure } else { Role::Ui })
        .type_px(theme.scale.secondary, theme.scale.line_body)
        .text_color(if selected { p.ink(1) } else { p.ink(2) }.solid())
        .child(frame)
        .child(mark)
        .child(div().flex_1().min_w_0().overflow_hidden().child(label))
        .on_click(move |e, _, cx| {
            let how = if e.click_count() > 1 {
                Open::KEEP
            } else {
                Open::PREVIEW
            };
            let target = target.clone();
            entity.update(cx, |ws, cx| ws.open(target, how, cx));
        })
        .into_any_element()
}

fn story_color(i: usize, theme: &Theme) -> dr_ui::tokens::Rgb {
    theme.palette.story(Story::ALL[i % Story::ALL.len()])
}

fn list(id: SharedString) -> gpui::Stateful<gpui::Div> {
    div()
        .id(ElementId::Name(id))
        .size_full()
        .overflow_y_scroll()
        .px(px(8.0))
        .py(px(6.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
}

fn left_body(
    tab: LeftTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let book = ws.book.clone();
    let slug = pane_slug(pane);
    let mut rows: Vec<AnyElement> = Vec::new();
    match tab {
        LeftTab::Chapters => {
            if book.chapters.is_empty() {
                return empty(keys::left_sidebar::empty::NO_CHAPTERS, cx);
            }
            for (si, storyline) in book.storylines.iter().enumerate() {
                let color = story_color(si, &theme);
                let target = Target::Storyline(storyline.id.clone());
                rows.push(cell(
                    format!("{slug}-sl-{}", storyline.id).into(),
                    sand::Kind::Storyline,
                    Some(color),
                    storyline.name,
                    ws.nav.is_selected(&target),
                    true,
                    target,
                    window,
                    cx,
                ));
                for chapter in book.chapters.iter().filter(|c| c.storyline == si) {
                    let target = Target::Chapter(chapter.id.clone());
                    rows.push(
                        div()
                            .pl(px(12.0))
                            .child(cell(
                                format!("{slug}-ch-{}", chapter.id).into(),
                                sand::Kind::Chapter(chapter.seal),
                                Some(color),
                                chapter.title,
                                ws.nav.is_selected(&target),
                                false,
                                target,
                                window,
                                cx,
                            ))
                            .into_any_element(),
                    );
                }
            }
        }
        LeftTab::Elements => {
            if book.elements.is_empty() {
                return empty(keys::left_sidebar::empty::NO_ELEMENTS, cx);
            }
            for (ci, category) in book.categories.iter().enumerate() {
                let color = story_color(ci + 2, &theme);
                let target = Target::Category(category.id.clone());
                rows.push(cell(
                    format!("{slug}-cat-{}", category.id).into(),
                    sand::Kind::Category,
                    Some(color),
                    category.name,
                    ws.nav.is_selected(&target),
                    true,
                    target,
                    window,
                    cx,
                ));
                for (element, _) in book.elements.iter().filter(|(_, c)| *c == ci) {
                    let target = Target::Element(element.id.clone());
                    rows.push(
                        div()
                            .pl(px(12.0))
                            .child(cell(
                                format!("{slug}-el-{}", element.id).into(),
                                sand::Kind::Element,
                                Some(color),
                                element.name,
                                ws.nav.is_selected(&target),
                                false,
                                target,
                                window,
                                cx,
                            ))
                            .into_any_element(),
                    );
                }
            }
        }
        LeftTab::Drifts => {
            if book.ideas.is_empty() {
                return empty(keys::left_sidebar::empty::NO_DRIFTS, cx);
            }
            for idea in &book.ideas {
                let target = Target::Idea(idea.id.clone());
                rows.push(cell(
                    format!("{slug}-idea-{}", idea.id).into(),
                    sand::Kind::Drift { loose: true },
                    None,
                    idea.name,
                    ws.nav.is_selected(&target),
                    false,
                    target,
                    window,
                    cx,
                ));
            }
        }
    }
    list(format!("left-{slug}-{}", tab.slug()).into())
        .children(rows)
        .into_any_element()
}

fn right_body(
    tab: RightTab,
    ws: &Workspace,
    pane: PaneId,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let slug = pane_slug(pane);
    match tab {
        RightTab::Library => {
            let book = ws.book.clone();
            let rows: Vec<AnyElement> = book
                .materials
                .iter()
                .map(|material| {
                    let target = Target::Material(material.id.clone());
                    cell(
                        format!("{slug}-mat-{}", material.id).into(),
                        sand::Kind::Material,
                        None,
                        material.name,
                        ws.nav.is_selected(&target),
                        false,
                        target,
                        window,
                        cx,
                    )
                })
                .collect();
            list(format!("right-{slug}-library").into())
                .children(rows)
                .into_any_element()
        }
        // Their modules fill these: review (M18/M19), stats (M07), the Agent (M27).
        _ => div().size_full().into_any_element(),
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
    let home = ws.nav.current().is_none() && ws.super_view.is_none();
    let open = ws.notifications_open;
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
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .font_role(Role::Ui)
                .type_px(theme.scale.secondary, theme.scale.line_body)
                .text_color(p.ink(2).solid())
                .child(t(cx, keys::common::LOCAL)),
        )
        .child(
            IconButton::new("home", Icon::Torii)
                .selected(home)
                .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowProjectHome), cx)),
        )
        .child(
            div().relative().child(overlay::probe(bell)).child(
                IconButton::new("notifications", Icon::Furin)
                    .selected(open)
                    .on_click(|_, window, cx| {
                        window.dispatch_action(Box::new(ToggleNotifications), cx)
                    }),
            ),
        )
        .into_any_element()
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
        list = list.child(
            div()
                .px(px(m::HOVER_CARD_PAD))
                .py(px(6.0))
                .flex()
                .flex_row()
                .gap(px(8.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
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
                        ),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("notice-remove-{id}")))
                        .aria_label(t(cx, keys::notifications::REMOVE))
                        .child(
                            PanelIconButton::new(
                                SharedString::from(format!("notice-{id}")),
                                Icon::Close,
                            )
                            .on_click(move |_, _, cx| Notifications::remove(id, cx)),
                        ),
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
