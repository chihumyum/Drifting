//! The tab dock on the paper's top edge (workspace.md, 「标签页在稿纸顶部」),
//! drawn by F5's `TabDock`.
//!
//! At rest the open documents are a row of sand marks on the window-controls
//! line (a split tab's two side by side, the open one a size up); under the
//! hand (or locked) each mark grows into a glass pill with its title, and
//! 260 ms after the hand leaves they fall back. A preview's title is italic
//! and its mark hollow. A split tab's pill is two halves joined by a short
//! line. The lock is at the start, the `+` (the Project Home with its create
//! row) at the end. The shell gives the tabs, the lock, the `+` and what a
//! click, a drag and a drop do; the dock keeps its own hover.
//!
//! Pills drag: dropped on another pill a tab takes its place; dropped on the
//! paper's left or right half it splits the page with the active one. A
//! click activates, a double click keeps a preview, a middle click closes.

use dr_ui::{
    Theme,
    components::{DockMark, DockTab, IconButton, Pill, TabDock},
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

fn mark(id: SharedString, (kind, color): (sand::Kind, Option<Rgb>), hollow: bool) -> KindMark {
    let mark = KindMark::new(ElementId::Name(id), kind).hollow(hollow);
    match color {
        Some(c) => mark.color(c),
        None => mark,
    }
}

pub fn dock(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let tabs = ws.nav.tabs().to_vec();
    let active = ws.nav.active_index();
    let book = ws.book.clone();
    let docked: Vec<DockTab> = tabs
        .iter()
        .map(|tab| {
            let pill = pill(tab, ws, &book, cx);
            match tab {
                Tab::Leaf(_) => DockTab::new(pill),
                Tab::Split(split) => {
                    let marks = [PageSide::Left, PageSide::Right].map(|side| {
                        let leaf = split.side(side);
                        let (kind, color) = book.mark(&leaf.target);
                        DockMark::new(kind, color).hollow(leaf.preview)
                    });
                    let focused = match split.focused {
                        PageSide::Left => 0,
                        PageSide::Right => 1,
                    };
                    DockTab::new(pill).marks(marks, focused)
                }
            }
        })
        .collect();
    let locked = ws.dock_locked;
    let lock = cx.entity();
    let lock_label = t(
        cx,
        if locked {
            keys::top_timeline::DOCK_UNLOCK
        } else {
            keys::top_timeline::DOCK_LOCK
        },
    );
    let new_label = t(cx, keys::top_timeline::NEW_ENTITY);
    let home = ws.nav.current().is_none();
    let on_change = cx.entity();
    let on_drop = cx.entity();
    let on_each = cx.entity();
    let tab_dock = TabDock::new("dock", docked, active)
        .locked(locked)
        .leading(move |_, _| {
            let lock = lock.clone();
            IconButton::new(
                "dock-lock",
                if locked {
                    Icon::LockShut
                } else {
                    Icon::LockOpen
                },
            )
            .label(lock_label.clone())
            .selected(locked)
            .on_click(move |_, _, cx| {
                lock.update(cx, |ws, cx| {
                    ws.dock_locked = !ws.dock_locked;
                    ws.changed(cx);
                })
            })
            .into_any_element()
        })
        .trailing(move |_, _| {
            IconButton::new("dock-new", Icon::Plus)
                .label(new_label.clone())
                .selected(home)
                .on_click(|_, window, cx| window.dispatch_action(Box::new(NewEntity), cx))
                .into_any_element()
        })
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
                            let target = ws.nav.tabs().get(i).map(|t| t.focused().target.clone());
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
        .child(tab_dock)
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
        .any(|l| ws.editors.get(&l.target.key()).is_some_and(|p| p.slow()));
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
