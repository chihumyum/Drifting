//! The tab dock on the paper's top edge (workspace.md, 「标签页在稿纸顶部」).
//!
//! At rest the open documents are a row of sand marks, one per page (a
//! split tab's two side by side), with a wider space where the kind of
//! thing changes; the open tab's mark is drawn a size up, and a page still
//! being prepared has a small ring of glass drifting round its mark. Under
//! the hand (locked, or while one of its pills is in the hand) each mark grows in
//! place into its glass pill on the dock pill's curve (340 ms): the glass
//! widens out of the mark's width, the words come in last, the mark spreads
//! away under the glass. Leaving, the dock waits [`dwell::DOCK_COLLAPSE`]
//! and the pills give way to marks that arrive like sand. The lock and the
//! `+` (the owner's) stand either side of the pills and only the pills
//! scroll.
//!
//! The pills are a [`PillGroup`]: the wave between them, and dragging with
//! the others making way, the slot closing far from the row and the landing
//! spring.

use std::time::Instant;

use gpui::{
    AnyElement, App, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Task, Window, div,
    prelude::FluentBuilder as _, px,
};
use smallvec::SmallVec;

use super::{Build, Pill, PillGroup, reorder::MARK_WIDTH};
use crate::{
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, KindMark},
    style::child_id,
    theme::Theme,
    tokens::{Rgb, motion::dwell},
};

/// A mark of a split tab's pair is a little narrower.
const PAIR_MARK_WIDTH: f32 = 17.0;
/// The extra space where the kind of thing changes.
const CLUSTER_BREAK: f32 = 8.0;
/// The open tab's mark, a size up.
const ACTIVE_SCALE: f32 = 1.35;
/// The glass ring round a mark whose page is still being prepared.
const LOADING_RING: f32 = 18.0;
/// The row of marks is this tall.
const MARK_ROW_HEIGHT: f32 = 22.0;

/// One page's mark in the resting dock.
#[derive(Clone, Copy, Debug)]
pub struct DockMark {
    pub kind: sand::Kind,
    pub color: Option<Rgb>,
    /// A preview: hollow.
    pub hollow: bool,
}

impl DockMark {
    pub fn new(kind: sand::Kind, color: Option<Rgb>) -> DockMark {
        DockMark {
            kind,
            color,
            hollow: false,
        }
    }

    pub fn hollow(mut self, hollow: bool) -> DockMark {
        self.hollow = hollow;
        self
    }
}

/// One open document: its pill when the dock is open, its marks at rest.
#[derive(Clone, Debug)]
pub struct DockTab {
    pub pill: Pill,
    /// One per page; a split tab has two.
    pub marks: SmallVec<[DockMark; 2]>,
    /// Which of its marks is the focused page (a split tab's side).
    pub focused: usize,
}

impl DockTab {
    /// A tab of one page: the pill's own mark (hollow while a preview).
    pub fn new(pill: Pill) -> DockTab {
        let marks = pill
            .mark
            .map(|(kind, color)| DockMark::new(kind, color).hollow(pill.preview))
            .into_iter()
            .collect();
        DockTab {
            pill,
            marks,
            focused: 0,
        }
    }

    /// A split tab's two pages, and which one has the focus.
    pub fn marks(mut self, marks: impl IntoIterator<Item = DockMark>, focused: usize) -> DockTab {
        self.marks = marks.into_iter().collect();
        self.focused = focused;
        self
    }
}

/// Which family a kind belongs to: the dock leaves a wider space where it
/// changes (chapters, drifts, elements and categories, storylines,
/// materials, the rest).
pub fn kind_family(kind: sand::Kind) -> u8 {
    match kind {
        sand::Kind::Chapter(_) => 0,
        sand::Kind::Drift { .. } => 1,
        sand::Kind::Element | sand::Kind::Category => 2,
        sand::Kind::Storyline => 3,
        sand::Kind::Material => 4,
        _ => 5,
    }
}

/// Whether the dock is open and since when.
pub struct DockState {
    hovered: bool,
    /// One of its pills is in the hand.
    holding: bool,
    collapse: Option<Task<()>>,
    open: bool,
    opened_at: Option<Instant>,
}

impl DockState {
    fn hover(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if hovered {
            self.collapse = None;
            if !self.hovered {
                self.hovered = true;
                cx.notify();
            }
            return;
        }
        if !self.hovered || self.collapse.is_some() {
            return;
        }
        // Leaving waits long enough to cross the gap to the lock or the plus.
        self.collapse = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(dwell::DOCK_COLLAPSE).await;
            this.update(cx, |s, cx| {
                s.hovered = false;
                s.collapse = None;
                cx.notify();
            })
            .ok();
        }));
    }
}

type ShapePills = Box<dyn FnOnce(PillGroup) -> PillGroup>;

#[derive(IntoElement)]
pub struct TabDock {
    id: ElementId,
    tabs: Vec<DockTab>,
    active: Option<usize>,
    locked: bool,
    held_open: bool,
    leading: Option<Build>,
    trailing: Option<Build>,
    on_change: Option<super::OnIndex>,
    shape: Vec<ShapePills>,
}

impl TabDock {
    pub fn new(id: impl Into<ElementId>, tabs: Vec<DockTab>, active: Option<usize>) -> TabDock {
        TabDock {
            id: id.into(),
            tabs,
            active,
            locked: false,
            held_open: false,
            leading: None,
            trailing: None,
            on_change: None,
            shape: Vec::new(),
        }
    }

    /// Pills even with no one there (the lock is down).
    pub fn locked(mut self, locked: bool) -> Self {
        self.locked = locked;
        self
    }

    /// Kept open by the owner for now (something else is being dragged that
    /// the pills take). The dock stays open by itself while one of its own
    /// pills is in the hand.
    pub fn held_open(mut self, open: bool) -> Self {
        self.held_open = open;
        self
    }

    /// Before the pills (the lock); shown only while the dock is open.
    pub fn leading(
        mut self,
        build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        self.leading = Some(std::rc::Rc::new(build));
        self
    }

    /// After the pills (the `+`); shown only while the dock is open.
    pub fn trailing(
        mut self,
        build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        self.trailing = Some(std::rc::Rc::new(build));
        self
    }

    /// A pill was clicked (its index).
    pub fn on_change(mut self, f: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(std::rc::Rc::new(f));
        self
    }

    /// The pills can be picked up and reordered: see
    /// [`PillGroup::draggable`].
    pub fn draggable<T: 'static>(
        mut self,
        payload: impl Fn(usize) -> T + 'static,
        on_drop: impl Fn(&T, usize, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.shape
            .push(Box::new(move |group| group.draggable(payload, on_drop)));
        self
    }

    /// Adds to each pill what the dock does not do: see
    /// [`PillGroup::map_pill`].
    pub fn map_pill(
        mut self,
        f: impl Fn(usize, &Pill, gpui::Stateful<gpui::Div>) -> gpui::Stateful<gpui::Div> + 'static,
    ) -> Self {
        self.shape.push(Box::new(move |group| group.map_pill(f)));
        self
    }
}

impl RenderOnce for TabDock {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let initially = self.locked || self.held_open;
        let state = window.use_keyed_state(child_id(&self.id, "dock"), cx, |_, _| DockState {
            hovered: false,
            holding: false,
            collapse: None,
            open: initially,
            opened_at: None,
        });
        let open = {
            let s = state.read(cx);
            s.hovered || s.holding || self.locked || self.held_open
        };
        let opened_at = state.update(cx, |s, _| {
            if open && !s.open {
                s.opened_at = Some(crate::anim::now());
            }
            s.open = open;
            s.opened_at
        });
        let hover = state.clone();
        let root = div()
            .id(self.id.clone())
            .min_w(px(40.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .on_hover(move |hovered, _, cx| hover.update(cx, |s, cx| s.hover(*hovered, cx)));
        if !open {
            return root.child(marks_row(
                &self.id,
                &self.tabs,
                self.active,
                theme,
                window,
                cx,
            ));
        }
        let n = self.tabs.len();
        let pills: Vec<Pill> = self.tabs.into_iter().map(|t| t.pill).collect();
        let holding = state.clone();
        let mut group =
            PillGroup::new(child_id(&self.id, "pills"), pills, self.active.unwrap_or(n))
                .grown_since(opened_at)
                .on_lift(move |held, _, cx| {
                    holding.update(cx, |s, cx| {
                        s.holding = held;
                        if !held {
                            // GPUI hovers nothing while something is dragged,
                            // so letting go counts as just leaving: the dock
                            // waits, and a pointer still over it keeps it open.
                            s.hovered = true;
                            s.collapse = None;
                            s.hover(false, cx);
                        }
                        cx.notify();
                    })
                });
        if let Some(f) = self.on_change {
            group = group.on_change(move |i, w, cx| f(i, w, cx));
        }
        for shape in self.shape {
            group = shape(group);
        }
        root.when_some(self.leading, |el, build| el.child(build(window, cx)))
            .child(
                div()
                    .id(child_id(&self.id, "scroll"))
                    .flex()
                    .flex_row()
                    .items_center()
                    .min_w_0()
                    .overflow_x_scroll()
                    .child(group),
            )
            .when_some(self.trailing, |el, build| el.child(build(window, cx)))
    }
}

/// The resting row: a mark per page, a wider space between families.
fn marks_row(
    id: &ElementId,
    tabs: &[DockTab],
    active: Option<usize>,
    theme: Theme,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut row = div()
        .id(child_id(id, "marks"))
        .role(gpui::Role::TabList)
        .h(px(MARK_ROW_HEIGHT))
        .flex()
        .flex_row()
        .items_center();
    let mut last = None;
    for (i, tab) in tabs.iter().enumerate() {
        let Some(first) = tab.marks.first() else {
            continue;
        };
        let family = kind_family(first.kind);
        let gap = match last {
            Some(f) if f != family => CLUSTER_BREAK,
            _ => 0.0,
        };
        last = Some(family);
        let pair = tab.marks.len() > 1;
        let width = if pair { PAIR_MARK_WIDTH } else { MARK_WIDTH };
        let is_active = active == Some(i);
        let key: SharedString = tab
            .pill
            .key
            .clone()
            .unwrap_or_else(|| tab.pill.label.clone());
        let mut slot = div()
            .id(child_id(&child_id(id, "tab"), key.clone()))
            .ml(px(gap))
            .flex()
            .flex_row()
            .items_center()
            .role(gpui::Role::Tab)
            .aria_label(tab.pill.label.clone())
            .aria_selected(is_active);
        for (j, m) in tab.marks.iter().enumerate() {
            let focused = is_active && j == tab.focused;
            let loading = tab.pill.loading && j == tab.focused;
            let mid = child_id(&child_id(id, "mark"), format!("{key}-{j}"));
            let mark = KindMark::new(mid.clone(), m.kind)
                .hollow(m.hollow)
                .scale(if focused { ACTIVE_SCALE } else { 1.0 });
            let mark = match m.color {
                Some(c) => mark.color(c),
                None => mark,
            };
            let ring = loading.then(|| {
                let ring = glass::use_state(
                    child_id(&mid, "ring"),
                    Kind::Rest,
                    Mode {
                        loading: true,
                        ..Mode::default()
                    },
                    false,
                    theme,
                    window,
                    cx,
                );
                let tone = m.color.map_or(Tone::Clear, Tone::Color);
                div()
                    .absolute()
                    .left(px((width - LOADING_RING) / 2.0))
                    .top(px((MARK_ROW_HEIGHT - LOADING_RING) / 2.0))
                    .size(px(LOADING_RING))
                    .child(glass::layer(
                        ring,
                        Spec::new(tone, LOADING_RING / 2.0),
                        theme,
                    ))
            });
            slot = slot.child(
                div()
                    .relative()
                    .w(px(width))
                    .h(px(MARK_ROW_HEIGHT))
                    .flex()
                    .items_center()
                    .justify_center()
                    .children(ring)
                    .child(mark),
            );
        }
        row = row.child(slot);
    }
    row.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_page_tab_takes_its_pills_mark() {
        let t = DockTab::new(
            Pill::new("第三章")
                .mark(sand::Kind::Element, None)
                .preview(true),
        );
        assert_eq!(t.marks.len(), 1);
        assert!(t.marks[0].hollow);
        let split = DockTab::new(Pill::new("两半")).marks(
            [
                DockMark::new(sand::Kind::Element, None),
                DockMark::new(sand::Kind::Storyline, None),
            ],
            1,
        );
        assert_eq!(split.marks.len(), 2);
        assert_eq!(split.focused, 1);
    }

    #[test]
    fn families_break_where_the_kind_changes() {
        assert_eq!(
            kind_family(sand::Kind::Element),
            kind_family(sand::Kind::Category)
        );
        assert_ne!(
            kind_family(sand::Kind::Element),
            kind_family(sand::Kind::Storyline)
        );
    }
}
