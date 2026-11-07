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
    components::{IconButton, Pill, PillGroup},
    sand::{self, Icon, KindMark},
    tokens::{Rgb, glass as g},
};
use gpui::{
    AnyElement, Context, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};

use super::chrome::{LEADING_INSET, TITLEBAR_HEIGHT, TOGGLE_GAP, TRAILING_INSET};
use super::{PageSide, Workspace};
use crate::actions::NewEntity;
use crate::book::Book;
use crate::nav::{Leaf, Tab};
use crate::strings::t;
use dr_i18n::keys;

/// A pill being dragged: the index of its tab.
#[derive(Clone, Debug)]
pub struct DockDrag {
    pub from: usize,
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

pub fn dock(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
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
            .label(t(
                cx,
                if locked {
                    keys::top_timeline::DOCK_UNLOCK
                } else {
                    keys::top_timeline::DOCK_LOCK
                },
            ))
            .selected(locked)
            .on_click(move |_, _, cx| {
                entity.update(cx, |ws, cx| {
                    ws.dock_locked = !ws.dock_locked;
                    ws.changed(cx);
                })
            }),
        );
        let pills: Vec<Pill> = tabs.iter().map(|tab| pill(tab, ws, &book, cx)).collect();
        let n = pills.len();
        let on_change = cx.entity();
        let on_drop = cx.entity();
        let on_each = cx.entity();
        let group = PillGroup::new("dock-pills", pills, active.unwrap_or(n))
            .on_change(move |i, _, cx| {
                on_change.update(cx, |ws, cx| {
                    if ws.nav.activate(i) {
                        ws.changed(cx);
                    }
                })
            })
            .draggable(
                |i| DockDrag { from: i },
                move |drag: &DockDrag, to, _, cx| {
                    on_drop.update(cx, |ws, cx| {
                        if ws.nav.reorder(drag.from, to) {
                            ws.changed(cx);
                        }
                    })
                },
            )
            .map_pill(move |i, pill, el| {
                // A double click keeps a preview, a middle click closes; the
                // close stroke shows under the hand.
                let promote = on_each.clone();
                let close = on_each.clone();
                el.group(pill_group(pill))
                    .on_click(move |e, _, cx| {
                        if e.click_count() > 1 {
                            promote.update(cx, |ws, cx| {
                                let target =
                                    ws.nav.tabs().get(i).map(|t| t.focused().target.clone());
                                if let Some(target) = target {
                                    ws.promote(&target, cx);
                                }
                            })
                        }
                    })
                    .on_mouse_up(MouseButton::Middle, move |_, _, cx| {
                        close.update(cx, |ws, cx| {
                            if ws.nav.close(i) {
                                ws.changed(cx);
                            }
                        })
                    })
            });
        row = row
            .child(
                div()
                    .id("dock-pills-scroll")
                    .flex()
                    .flex_row()
                    .items_center()
                    .overflow_x_scroll()
                    .child(group),
            )
            .child(
                IconButton::new("dock-new", Icon::Plus)
                    .label(t(cx, keys::top_timeline::NEW_ENTITY))
                    .selected(ws.nav.current().is_none())
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(NewEntity), cx)),
            );
    } else {
        let mut last: Option<u8> = None;
        for (i, tab) in tabs.iter().enumerate() {
            let leaves: Vec<&Leaf> = tab.leaves().collect();
            let group = kind_group(book.mark(&leaves[0].target).0);
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
                    book.mark(&leaf.target),
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

/// One page of a pill: a tab's leaf, or one side of a split.
struct Half {
    preview: bool,
    mark: (sand::Kind, Option<Rgb>),
    name: SharedString,
    side: Option<PageSide>,
}

/// The hover group a pill's close stroke shows in.
fn pill_group(pill: &Pill) -> SharedString {
    format!(
        "pill-{}",
        pill.key.clone().unwrap_or_else(|| pill.label.clone())
    )
    .into()
}

/// One tab as a pill: its mark and name (italic while a preview), a split
/// tab's two halves joined by a short line, the close stroke under the
/// hand. Drifts while its page takes longer than the loading delay.
fn pill(tab: &Tab, ws: &Workspace, book: &Book, cx: &mut Context<Workspace>) -> Pill {
    let index = ws
        .nav
        .tabs()
        .iter()
        .position(|t| t == tab)
        .unwrap_or_default();
    let key: SharedString = tab.key().into();
    let focused = tab.focused().clone();
    let (kind, color) = book.mark(&focused.target);
    let slow = tab
        .leaves()
        .any(|l| ws.pages.get(&l.target.key()).is_some_and(|p| p.slow()));
    let label = super::title_of(book, &focused.target, cx);
    let group: SharedString = format!("pill-{key}").into();
    let half = |leaf: &Leaf, side: Option<PageSide>| Half {
        preview: leaf.preview,
        mark: book.mark(&leaf.target),
        name: super::title_of(book, &leaf.target, cx),
        side,
    };
    let halves: Vec<Half> = match tab {
        Tab::Leaf(leaf) => vec![half(leaf, None)],
        Tab::Split(split) => [PageSide::Left, PageSide::Right]
            .into_iter()
            .map(|side| half(split.side(side), Some(side)))
            .collect(),
    };
    let entity = cx.entity();
    let pill_key = key.clone();
    let close_label = t(cx, keys::top_timeline::CLOSE_TAB);
    Pill::new(label)
        .key(key)
        .mark(kind, color)
        .preview(focused.preview)
        .loading(slow)
        .content(move |window, cx| {
            let theme = Theme::of(window, cx);
            let p = theme.palette;
            let mut row = div().flex().flex_row().items_center().gap(px(8.0));
            for (
                n,
                Half {
                    preview,
                    mark: m,
                    name,
                    side,
                },
            ) in halves.iter().enumerate()
            {
                if n > 0 {
                    row = row.child(div().w(px(1.0)).h(px(12.0)).bg(p.rule_strong.solid()));
                }
                let close_entity = entity.clone();
                let side = *side;
                let close = div()
                    .id(ElementId::Name(format!("{pill_key}-close-{side:?}").into()))
                    .role(gpui::Role::Button)
                    .aria_label(close_label.clone())
                    .opacity(0.0)
                    .group_hover(group.clone(), |st| st.opacity(1.0))
                    .child(sand::icon(Icon::Close, 12.0, p.ink(3).solid()))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        close_entity.update(cx, |ws, cx| {
                            match side {
                                Some(side) => ws.nav.close_side(index, side),
                                None => ws.nav.close(index),
                            };
                            ws.changed(cx);
                        })
                    });
                let mut half = div()
                    .id(ElementId::Name(format!("{pill_key}-half-{side:?}").into()))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(mark(
                        format!("{pill_key}-mark-{side:?}").into(),
                        *m,
                        *preview,
                    ))
                    .child(
                        div()
                            .whitespace_nowrap()
                            .when(*preview, |el| el.italic())
                            .child(name.clone()),
                    )
                    .child(close);
                if let Some(side) = side {
                    let focus = entity.clone();
                    half = half.on_click(move |_, _, cx| {
                        focus.update(cx, |ws, cx| {
                            ws.nav.focus_side(index, side);
                            ws.changed(cx);
                        })
                    });
                }
                row = row.child(half);
            }
            row.into_any_element()
        })
}
