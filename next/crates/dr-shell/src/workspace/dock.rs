//! The tab dock on the paper's top edge (workspace.md, 「标签页在稿纸顶部」).
//!
//! At rest the open documents are a row of sand marks on the window-controls
//! line; under the hand (or locked) each mark is a glass pill with its
//! title. A preview's title is italic and its mark hollow. A split tab is two
//! halves joined by a short line. The lock is at the start, the `+` (the
//! Project Home with its create row) at the end.
//!
//! Pills drag: dropped on another pill a tab takes its place; dropped on the
//! paper's left or right half it splits the page with the active one. A
//! click activates, a double click keeps a preview, a middle click closes.

use dr_ui::{
    Theme,
    components::IconButton,
    fonts::Role,
    glass::{self, GlassState, Ground, Kind, Mode, SAMPLE_ORIGINS, Spec, Tone},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    tokens::{Rgb, glass as g},
};
use gpui::{
    AnyElement, App, AppContext as _, BoxShadow, Context, ElementId, InteractiveElement,
    IntoElement, MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Window, div, point, prelude::FluentBuilder as _, px,
};

use super::chrome::{LEADING_INSET, TITLEBAR_HEIGHT, TOGGLE_GAP, TRAILING_INSET};
use super::{PageSide, Workspace};
use crate::actions::NewEntity;
use crate::nav::{Leaf, Tab, Target};
use crate::stand_in::StandIn;

/// A pill being dragged: the index of its tab.
#[derive(Clone, Debug)]
pub struct DockDrag {
    pub from: usize,
    pub label: SharedString,
    pub mark: (sand::Kind, Option<Rgb>),
    pub preview: bool,
}

/// The kind mark and colour of a target.
pub fn mark_of(book: &StandIn, target: &Target, theme: &Theme) -> (sand::Kind, Option<Rgb>) {
    let story = |i: usize| theme.palette.story(dr_ui::tokens::Story::ALL[i % 6]);
    match target {
        Target::Chapter(id) => match book.chapter_index(id) {
            Some(i) => {
                let c = &book.chapters[i];
                (sand::Kind::Chapter(c.seal), Some(story(c.storyline)))
            }
            None => (sand::Kind::Chapter(0), None),
        },
        Target::Idea(_) => (sand::Kind::Drift { loose: true }, None),
        Target::Storyline(id) => {
            let i = book.storylines.iter().position(|s| &s.id == id);
            (sand::Kind::Storyline, i.map(story))
        }
        Target::Element(id) => {
            let c = book
                .elements
                .iter()
                .find(|(e, _)| &e.id == id)
                .map(|(_, c)| *c);
            (sand::Kind::Element, c.map(|c| story(c + 2)))
        }
        Target::Category(id) => {
            let i = book.categories.iter().position(|c| &c.id == id);
            (sand::Kind::Category, i.map(|i| story(i + 2)))
        }
        Target::Material(_) => (sand::Kind::Material, None),
        Target::Book => (sand::Kind::All, None),
    }
}

fn kind_group(kind: sand::Kind) -> u8 {
    match kind {
        sand::Kind::Chapter(_) => 0,
        sand::Kind::Drift { .. } => 1,
        sand::Kind::Element | sand::Kind::Category => 2,
        sand::Kind::Storyline => 3,
        sand::Kind::Material => 4,
        _ => 5,
    }
}

fn mark(id: SharedString, (kind, color): (sand::Kind, Option<Rgb>), hollow: bool) -> KindMark {
    let mark = KindMark::new(ElementId::Name(id), kind).hollow(hollow);
    match color {
        Some(c) => mark.color(c),
        None => mark,
    }
}

pub fn dock(ws: &mut Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let expanded = ws.dock_hovered || ws.dock_locked || cx.has_active_drag();
    let tabs = ws.nav.tabs().to_vec();
    let active = ws.nav.active_index();
    let book = ws.book.clone();
    let mut row = div()
        .id("dock-row")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0));
    if expanded {
        let locked = ws.dock_locked;
        let entity = cx.entity();
        row = row.child(
            IconButton::new(
                "dock-lock",
                if locked {
                    Icon::LockShut
                } else {
                    Icon::LockOpen
                },
            )
            .selected(locked)
            .on_click(move |_, _, cx| {
                entity.update(cx, |ws, cx| {
                    ws.dock_locked = !ws.dock_locked;
                    ws.changed(cx);
                })
            }),
        );
        let mut pills = div()
            .id("dock-pills")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .overflow_x_scroll();
        for (i, tab) in tabs.iter().enumerate() {
            pills = pills.child(pill(i, tab, active == Some(i), &book, window, cx));
        }
        row = row.child(pills).child(
            IconButton::new("dock-new", Icon::Plus)
                .selected(ws.nav.current().is_none())
                .on_click(|_, window, cx| window.dispatch_action(Box::new(NewEntity), cx)),
        );
    } else {
        let mut last: Option<u8> = None;
        for (i, tab) in tabs.iter().enumerate() {
            let leaves: Vec<&Leaf> = match tab {
                Tab::Leaf(leaf) => vec![leaf],
                Tab::Split(split) => vec![&split.left, &split.right],
            };
            let group = kind_group(mark_of(&book, &leaves[0].target, &theme).0);
            let gap = match last {
                Some(g) if g != group => 10.0,
                Some(_) => 2.0,
                None => 0.0,
            };
            last = Some(group);
            let mut marks = div()
                .ml(px(gap))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(1.0));
            for (j, leaf) in leaves.iter().enumerate() {
                marks = marks.child(mark(
                    format!("dock-dot-{i}-{j}").into(),
                    mark_of(&book, &leaf.target, &theme),
                    leaf.preview,
                ));
            }
            row = row.child(marks);
        }
    }
    let lead = if ws.left.open {
        12.0
    } else {
        LEADING_INSET + g::ROUND + TOGGLE_GAP
    };
    let trail = if ws.right.open {
        12.0
    } else {
        TRAILING_INSET + g::ROUND + TOGGLE_GAP
    };
    div()
        .absolute()
        .top_0()
        .left(px(lead))
        .right(px(trail))
        .h(px(TITLEBAR_HEIGHT))
        .flex()
        .justify_center()
        .items_center()
        .child(
            div()
                .id("dock")
                .min_w(px(40.0))
                .h(px(TITLEBAR_HEIGHT))
                .flex()
                .items_center()
                .justify_center()
                .on_hover(cx.listener(|ws, hovered: &bool, _, cx| ws.hover_dock(*hovered, cx)))
                .child(row),
        )
        .into_any_element()
}

fn label(book: &StandIn, target: &Target, cx: &App) -> SharedString {
    super::title_of(book, target, cx)
}

fn pill(
    index: usize,
    tab: &Tab,
    active: bool,
    book: &StandIn,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let key = tab.key();
    let focused = tab.focused().clone();
    let (kind, color) = mark_of(book, &focused.target, &theme);
    let tone = color.map_or(Tone::Clear, Tone::Color);
    let spec = Spec::new(tone, g::PILL_HEIGHT / 2.0).origin(SAMPLE_ORIGINS[index % 4]);
    let group: SharedString = format!("pill-{key}").into();
    let half = |leaf: &Leaf, side: Option<PageSide>, cx: &mut Context<Workspace>| {
        let m = mark_of(book, &leaf.target, &theme);
        let entity = cx.entity();
        let close = div()
            .id(ElementId::Name(format!("{key}-close-{side:?}").into()))
            .opacity(0.0)
            .group_hover(group.clone(), |st| st.opacity(1.0))
            .child(sand::icon(Icon::Close, 12.0, p.ink(3).solid()))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                entity.update(cx, |ws, cx| {
                    match side {
                        Some(side) => ws.nav.close_side(index, side),
                        None => ws.nav.close(index),
                    };
                    ws.changed(cx);
                })
            });
        let text = div()
            .when(leaf.preview, |el| el.italic())
            .child(label(book, &leaf.target, cx));
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(mark(format!("{key}-mark-{side:?}").into(), m, leaf.preview))
            .child(text)
            .child(close)
    };
    let content = match tab {
        Tab::Leaf(leaf) => half(leaf, None, cx).into_any_element(),
        Tab::Split(split) => {
            let entity_l = cx.entity();
            let entity_r = cx.entity();
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .id(ElementId::Name(format!("{key}-left").into()))
                        .child(half(&split.left, Some(PageSide::Left), cx))
                        .on_click(move |_, _, cx| {
                            entity_l.update(cx, |ws, cx| {
                                ws.nav.focus_side(index, PageSide::Left);
                                ws.changed(cx);
                            })
                        }),
                )
                .child(div().w(px(1.0)).h(px(12.0)).bg(p.rule_strong.solid()))
                .child(
                    div()
                        .id(ElementId::Name(format!("{key}-right").into()))
                        .child(half(&split.right, Some(PageSide::Right), cx))
                        .on_click(move |_, _, cx| {
                            entity_r.update(cx, |ws, cx| {
                                ws.nav.focus_side(index, PageSide::Right);
                                ws.changed(cx);
                            })
                        }),
                )
                .into_any_element()
        }
    };
    let drag = DockDrag {
        from: index,
        label: label(book, &focused.target, cx),
        mark: (kind, color),
        preview: focused.preview,
    };
    let entity = cx.entity();
    let target = focused.target.clone();
    glass::glass_box(
        ElementId::Name(format!("pill-{key}").into()),
        Kind::Rest,
        Mode::default(),
        active,
        spec,
        window,
        cx,
    )
    .group(group.clone())
    .h(px(g::PILL_HEIGHT))
    .px(px(10.0))
    .flex()
    .flex_row()
    .flex_none()
    .items_center()
    .rounded_full()
    .font_role(Role::Ui)
    .type_px(s.secondary, s.line_body)
    .text_color(if active { p.ink(1) } else { p.ink(2) }.solid())
    .cursor_pointer()
    .child(content)
    .on_click(move |e, _, cx| {
        let target = target.clone();
        entity.update(cx, |ws, cx| {
            if e.click_count() > 1 {
                ws.promote(&target, cx);
            } else if ws.nav.activate(index) {
                ws.changed(cx);
            }
        })
    })
    .on_mouse_up(
        MouseButton::Middle,
        cx.listener(move |ws, _, _, cx| {
            if ws.nav.close(index) {
                ws.changed(cx);
            }
        }),
    )
    .on_drag(drag, |drag, _, _, cx| cx.new(|_| DragPill(drag.clone())))
    .on_drop(cx.listener(move |ws, drag: &DockDrag, _, cx| {
        if ws.nav.reorder(drag.from, index) {
            ws.changed(cx);
        }
    }))
    .into_any_element()
}

/// The pill in the hand: a still copy of it with a light shadow (the one
/// shadow besides the page's and the floating layers').
pub struct DragPill(pub DockDrag);

impl Render for DragPill {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let d = &self.0;
        let tone = d.mark.1.map_or(Tone::Clear, Tone::Color);
        let spec = Spec::new(tone, g::PILL_HEIGHT / 2.0).filled(p.page);
        let rim = glass::held_layer(
            GlassState::new(Kind::Rest, Mode::default(), true),
            spec,
            theme,
        );
        glass::surface(
            Ground::flat(p.page),
            div()
                .relative()
                .h(px(g::PILL_HEIGHT))
                .px(px(10.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .rounded_full()
                .bg(p.page.solid())
                .shadow(vec![BoxShadow {
                    color: p.shadow_ink.alpha(if p.dark { 0.4 } else { 0.12 }),
                    offset: point(px(0.0), px(2.0)),
                    blur_radius: px(8.0),
                    spread_radius: px(0.0),
                    inset: false,
                }])
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(1).solid())
                .child(rim)
                .child(mark("drag-mark".into(), d.mark, d.preview))
                .child(
                    div()
                        .when(d.preview, |el| el.italic())
                        .child(d.label.clone()),
                ),
        )
    }
}
