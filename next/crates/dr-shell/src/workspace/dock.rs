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
//! While a panel fills (`W11Right`) the row stays above it and looks and
//! answers the same: dots that grow into pills under the hand; a click on a
//! pill leaves the fill and shows that document. Immersed, with the top
//! band showing, the row is centred on the whole window.
//!
//! Pills drag: dropped on another pill a tab takes its place; dropped on the
//! paper's left or right half it splits the page with the active one. A
//! click activates, a double click keeps a preview, a middle click closes.

use dr_ui::{
    Theme,
    components::{DockMark, DockTab, IconButton, Pill, TabDock},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    tokens::Rgb,
};
use gpui::{
    AnyElement, Context, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};

use super::chrome::{CLUSTER_END, LEADING_INSET, RIGHT_TOGGLE_END, TITLEBAR_HEIGHT, TOGGLE_GAP};
use super::fill::FillPlace;
use super::sidebar::Side;
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

/// A module's workbench (CM3): its pill and its mark at rest are 「线装」.
fn is_workbench(target: &crate::nav::Target) -> bool {
    matches!(target, crate::nav::Target::Module(_))
}

/// A page's mark at rest: its kind's, or 「线装」 for a module's workbench
/// (CW; the pill shows the same).
fn dock_mark(
    target: &crate::nav::Target,
    kind: sand::Kind,
    color: Option<Rgb>,
    hollow: bool,
) -> DockMark {
    let mark = DockMark::new(kind, color).hollow(hollow);
    if is_workbench(target) {
        mark.icon(Icon::Stitched)
    } else {
        mark
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
    let window_w = f32::from(window.viewport_size().width);
    let tabs = ws.nav.tabs().to_vec();
    let active = ws.nav.active_index();
    let book = ws.book.clone();
    let docked: Vec<DockTab> = tabs
        .iter()
        .map(|tab| {
            let pill = pill(tab, ws, &book, cx);
            match tab {
                Tab::Leaf(leaf) => {
                    let tab = DockTab::new(pill);
                    if is_workbench(&leaf.target) {
                        let (kind, color) = book.mark(&leaf.target);
                        tab.marks([dock_mark(&leaf.target, kind, color, leaf.preview)], 0)
                    } else {
                        tab
                    }
                }
                Tab::Split(split) => {
                    let marks = [PageSide::Left, PageSide::Right].map(|side| {
                        let leaf = split.side(side);
                        let (kind, color) = book.mark(&leaf.target);
                        dock_mark(&leaf.target, kind, color, leaf.preview)
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
    let home = ws.nav.current().is_none() && ws.filled().is_none();
    let on_change = cx.entity();
    let on_drop = cx.entity();
    let on_each = cx.entity();
    // While a panel fills, the dock is the same row of dots that grow into
    // pills under the hand (`W11Right`, `shell.css` `.dock-f`): it is not
    // held open.
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
            // Only drawn while the dock is open (tests look for it).
            div()
                .debug_selector(|| DOCK_NEW.into())
                .child(
                    IconButton::new("dock-new", Icon::Plus)
                        .label(new_label.clone())
                        .selected(home)
                        .on_click(|_, window, cx| window.dispatch_action(Box::new(NewEntity), cx)),
                )
                .into_any_element()
        })
        .on_change(move |i, window, cx| {
            on_change.update(cx, |ws, cx| {
                let exited = ws.exit_fill(window, cx);
                if ws.nav.activate(i) || exited {
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
    let (lead, trail) = dock_insets(ws, window_w);
    div()
        .absolute()
        .top_0()
        .left(px(lead))
        .right(px(trail))
        .h(px(TITLEBAR_HEIGHT))
        .flex()
        .justify_center()
        .items_center()
        .debug_selector(|| DOCK_ROW.into())
        .child(tab_dock)
        .into_any_element()
}

/// The dock row's debug selector (tests).
pub const DOCK_ROW: &str = "dock-row";
/// The `+` at the end of the open dock (tests): there only while the dots
/// have grown into pills.
pub const DOCK_NEW: &str = "dock-new";

/// How far the dock row stays from the window's left and right edges: over
/// the middle column, clear of the toggles. Immersed, the sidebars and the
/// toggles are not drawn, so the row is centred on the whole window, clear
/// of the window controls on both sides alike.
fn dock_insets(ws: &Workspace, window_w: f32) -> (f32, f32) {
    if ws.immersive {
        return (LEADING_INSET, LEADING_INSET);
    }
    let min_lead = CLUSTER_END + TOGGLE_GAP;
    let min_trail = RIGHT_TOGGLE_END + TOGGLE_GAP;
    let left_base = (ws.left.width * ws.left.shown()).round();
    let right_base = (ws.right.width * ws.right.shown()).round();
    let (mut lead, mut trail) = match ws.filled() {
        Some(FillPlace::Left) => {
            let (_, left_vis) = ws.sidebar_drawn_widths(Side::Left, window_w);
            let max_fill = ws.max_fill_width(Side::Left, window_w);
            let l = if left_vis < max_fill - 80.0 {
                (left_vis + 12.0).max(min_lead)
            } else {
                (left_base + 12.0).max(min_lead)
            };
            (l, (right_base + 12.0).max(min_trail))
        }
        Some(FillPlace::Right) => {
            let (_, right_vis) = ws.sidebar_drawn_widths(Side::Right, window_w);
            let max_fill = ws.max_fill_width(Side::Right, window_w);
            let r = if right_vis < max_fill - 80.0 {
                (right_vis + 12.0).max(min_trail)
            } else {
                (right_base + 12.0).max(min_trail)
            };
            ((left_base + 12.0).max(min_lead), r)
        }
        _ => (
            (left_base + 12.0).max(min_lead),
            (right_base + 12.0).max(min_trail),
        ),
    };
    if lead + trail > window_w - 80.0 {
        lead = min_lead;
        trail = min_trail;
    }
    (lead, trail)
}

/// One page of a pill: a tab's leaf, or one side of a split.
struct Half {
    preview: bool,
    /// A module's workbench (CM3): drawn with the 「线装」 icon.
    stitched: bool,
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
        stitched: is_workbench(&leaf.target),
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
                    stitched,
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
                // A module's workbench: the one 「线装」 mark every module
                // has (`custom-modules.md` §2).
                let lead = if *stitched {
                    sand::icon(Icon::Stitched, 14.0, p.ink(2).solid()).into_any_element()
                } else {
                    mark(format!("{pill_key}-mark-{side:?}").into(), *m, *preview)
                        .into_any_element()
                };
                let mut half = div()
                    .id(ElementId::Name(format!("{pill_key}-half-{side:?}").into()))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(lead)
                    .child(
                        div()
                            .whitespace_nowrap()
                            .when(*preview, |el| el.italic_face())
                            .child(name.clone()),
                    )
                    .child(close);
                if let Some(side) = side {
                    let focus = entity.clone();
                    half = half.on_click(move |_, window, cx| {
                        focus.update(cx, |ws, cx| {
                            ws.exit_fill(window, cx);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nav::Target;

    #[test]
    fn a_workbench_rests_as_its_stitched_mark_and_pages_as_their_kind() {
        let module = Target::Module(dr_model::id::CustomModuleId::new_v7());
        let mark = dock_mark(&module, sand::Kind::Element, None, false);
        assert!(matches!(mark.icon, Some(Icon::Stitched)));
        let entry = Target::Entry {
            id: dr_model::id::EntryId::new_v7(),
            module: None,
        };
        let mark = dock_mark(&entry, sand::Kind::Element, None, true);
        assert!(mark.icon.is_none());
        assert!(mark.hollow);
    }
}
