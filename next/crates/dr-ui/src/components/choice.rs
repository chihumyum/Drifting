//! Choosing one of several (components.md, 「多选一」「Dock 药丸」;
//! materials.md, 「同族选中的水波」).
//!
//! - [`Segmented`] (the 0.1 client's `GlassSlider`, the choose-one; not the
//!   number slider, which is [`Range`](super::Range)): words side by side,
//!   no track; one square block of glass (an opaque paper fill and the
//!   selected rim) lies under the chosen word and slides to another on the
//!   weighted spring (520ms), its texture flowing with the distance it
//!   travels. Words have no press state; a choice turns the word at once
//!   and the block follows. A sidebar's Panel Tabs are the same block on
//!   the panel's push instead of the spring (`.motion(motion::PUSH)`), and a
//!   click on the selected tab is reported too (`.report_selected()`).
//! - [`PillGroup`]: glass pills (a resting line, flowing under the pointer)
//!   that pass the selection between them as a wave: the selected bleed
//!   travels from the old pill to the new one as one band of water, a
//!   little longer for each pill it crosses, wider and fainter mid-way with
//!   softer edges; the new pill keeps its resting line until the band lands,
//!   then its own bleed comes in as the band fades. Picked up, a pill's
//!   still copy follows the hand on the weighted spring while the others make
//!   way on the same spring; taken a row's height away its slot closes; on
//!   the drop every pill springs from where it was shown into its new place
//!   (workspace.md, 「拖拽排序有重量」; the geometry is [`super::reorder`]).

use std::{collections::HashMap, rc::Rc, time::Instant};

use gpui::{
    AnyElement, App, AppContext as _, Bounds, Div, ElementId, Entity, InteractiveElement,
    IntoElement, ParentElement, Pixels, RenderOnce, SharedString, Stateful,
    StatefulInteractiveElement, Styled, Window, canvas, div, prelude::FluentBuilder as _, px,
};

use super::reorder::{self, Slide, Slot};
use crate::{
    anim,
    fonts::Role,
    glass::{self, DENSE, Ground, Kind, Look, Mode, Spec, Tone},
    sand::{self, KindMark},
    style::DrStyled,
    theme::Theme,
    tokens::{Motion, Rgb, glass as g, motion},
};

type OnSelect = super::OnIndex;
/// A band of glass: (a0, a1, b0, b1) in window x.
type Band = (f32, f32, f32, f32);

/// Where each item was laid out last frame, and how the chosen one moved.
pub struct ChoiceState {
    selected: usize,
    rects: Vec<Option<Bounds<Pixels>>>,
    /// The block (or band) leaving `from` at `start`.
    from: Option<(f32, f32)>,
    start: Option<Instant>,
    crossed: u32,
    flow_base: f32,
    /// How the block travels: `None` is the weighted spring.
    glide: Option<Motion>,
    /// Who the selected pill is: a pill that only moved (a drag reordered
    /// the row) sends no wave.
    selected_key: Option<ElementId>,
    /// Who each pill is, in order.
    keys: Vec<ElementId>,
    /// Each pill's words at their own width (a dock pill grows to it).
    natural: Vec<Option<f32>>,
    /// The pill in the hand, while it is.
    drag: Option<Session>,
    /// Pills making way or landing, by who they are.
    slides: HashMap<ElementId, Slide>,
}

/// A pill picked up from the row.
struct Session {
    from: usize,
    /// Where it would land now.
    to: usize,
    /// Where on the pill the hand took it.
    grab: (f32, f32),
    /// The pointer and the row (x, y, width, height), last seen.
    pointer: (f32, f32),
    row: (f32, f32, f32, f32),
    /// The slots as they were when it was picked up, from the row's start.
    slots: Vec<Slot>,
    keys: Vec<ElementId>,
    /// The row's top, in the window.
    top: f32,
    inside: bool,
    ghost: Entity<DraggedPill>,
}

impl ChoiceState {
    fn new(selected: usize, n: usize) -> ChoiceState {
        ChoiceState {
            selected,
            rects: vec![None; n],
            from: None,
            start: None,
            crossed: 0,
            flow_base: 0.0,
            glide: None,
            selected_key: None,
            keys: Vec::new(),
            natural: vec![None; n],
            drag: None,
            slides: HashMap::new(),
        }
    }

    /// Where a pill is shown now, relative to where it is laid out.
    fn offset(&self, key: &ElementId, now: Instant) -> (f32, f32) {
        self.slides.get(key).map_or((0.0, 0.0), |s| s.value(now))
    }

    fn slide_to(&mut self, key: &ElementId, to: (f32, f32), now: Instant) {
        self.slides
            .entry(key.clone())
            .or_insert_with(|| Slide::still((0.0, 0.0), now))
            .retarget(to, now);
    }

    /// The hand took pill `from` at `grab` inside it.
    fn pick_up(
        &mut self,
        from: usize,
        grab: (f32, f32),
        pointer: (f32, f32),
        ghost: Entity<DraggedPill>,
        now: Instant,
    ) {
        let laid: Vec<Option<(f32, f32, f32)>> = (0..self.rects.len())
            .map(|i| {
                let b = self.rects[i]?;
                let (dx, dy) = self.keys.get(i).map_or((0.0, 0.0), |k| self.offset(k, now));
                Some((
                    f32::from(b.origin.x) - dx,
                    f32::from(b.origin.y) - dy,
                    f32::from(b.size.width),
                ))
            })
            .collect();
        let Some(Some((x0, y0, _))) = laid.first().copied() else {
            return;
        };
        let n = laid.len();
        let mut slots = Vec::with_capacity(n);
        for i in 0..n {
            let (x, _, w) = laid[i].unwrap_or((x0, y0, 0.0));
            let next = laid.get(i + 1).copied().flatten().map(|l| l.0);
            let width = next.map_or(w + PILL_GAP, |nx| nx - x);
            slots.push((x - x0, width));
        }
        let width: f32 = slots.iter().map(|s| s.1).sum();
        self.drag = Some(Session {
            from,
            to: from,
            grab,
            pointer,
            row: (x0, y0, width - PILL_GAP, g::PILL_HEIGHT),
            slots,
            keys: self.keys.clone(),
            top: y0,
            inside: true,
            ghost,
        });
    }

    /// The hand moved over the window, with the row at `row`.
    fn drag_to(&mut self, pointer: (f32, f32), row: (f32, f32, f32, f32), now: Instant) {
        let Some(d) = self.drag.as_mut() else {
            return;
        };
        d.pointer = pointer;
        d.row = row;
        d.inside = reorder::is_inside(row, pointer);
        // Over the row the others open a slot where the pill would land; far
        // from it the pill's own slot closes; in between nothing moves.
        let offsets = if d.inside {
            let p = reorder::project(&d.slots, d.from, pointer.0 - row.0 - d.grab.0);
            d.to = p.to;
            Some(p.offsets)
        } else {
            d.to = d.from;
            reorder::is_far(row, pointer).then(|| reorder::closed(&d.slots, d.from))
        };
        if let Some(offsets) = offsets {
            let keys = d.keys.clone();
            for (i, key) in keys.iter().enumerate() {
                self.slide_to(key, (offsets[i], 0.0), now);
            }
        }
    }

    /// The drag ended (dropped on the row, or anywhere else): every pill
    /// springs from where it was shown into its place with `from` at `to`,
    /// the picked-up one from where its copy in the hand had got to.
    fn land(&mut self, d: Session, to: usize, cx: &App, now: Instant) {
        let starts = reorder::starts_after(&d.slots, d.from, to);
        let lag = d.ghost.read(cx).lag;
        for (i, key) in d.keys.iter().enumerate() {
            let from = if i == d.from {
                let x = d.pointer.0 - d.grab.0 + lag.x;
                let y = d.pointer.1 - d.grab.1 + lag.y;
                (x - (d.row.0 + starts[i]), y - d.top)
            } else {
                let shown = d.slots[i].0 + self.offset(key, now).0;
                (shown - starts[i], 0.0)
            };
            self.slides.insert(key.clone(), Slide::home_from(from, now));
        }
    }

    /// How far along its way the block is `elapsed` after it left, 0 to 1.
    fn travel(&self, elapsed: std::time::Duration) -> f32 {
        match self.glide {
            None => motion::spring_progress(elapsed.as_secs_f32()),
            Some(m) => {
                let t = elapsed.as_secs_f32() / m.duration.as_secs_f32().max(f32::EPSILON);
                m.easing.at(t.clamp(0.0, 1.0))
            }
        }
    }

    /// How long the block's way takes.
    fn travel_time(&self) -> std::time::Duration {
        self.glide.map_or(motion::SPRING_DURATION, |m| m.duration)
    }

    fn rect(&self, i: usize) -> Option<(f32, f32)> {
        self.rects
            .get(i)
            .copied()
            .flatten()
            .map(|b| (f32::from(b.origin.x), f32::from(b.size.width)))
    }
}

fn use_choice(
    id: &ElementId,
    selected: usize,
    n: usize,
    window: &mut Window,
    cx: &mut App,
) -> Entity<ChoiceState> {
    window.use_keyed_state(crate::style::child_id(&id.clone(), "choice"), cx, |_, _| {
        ChoiceState::new(selected, n)
    })
}

/// Records an item's bounds during prepaint.
fn measure(state: Entity<ChoiceState>, i: usize) -> impl IntoElement {
    canvas(
        move |bounds, _, cx| {
            state.update(cx, |s, _| {
                if let Some(slot) = s.rects.get_mut(i) {
                    *slot = Some(bounds);
                }
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

#[derive(IntoElement)]
pub struct Segmented {
    id: ElementId,
    options: Vec<SharedString>,
    selected: usize,
    disabled: bool,
    on_change: Option<OnSelect>,
    glide: Option<Motion>,
    report_selected: bool,
    font: Role,
    text_size: Option<f32>,
}

impl Segmented {
    pub fn new(
        id: impl Into<ElementId>,
        options: impl IntoIterator<Item = impl Into<SharedString>>,
        selected: usize,
    ) -> Segmented {
        Segmented {
            id: id.into(),
            options: options.into_iter().map(Into::into).collect(),
            selected,
            disabled: false,
            on_change: None,
            glide: None,
            report_selected: false,
            font: Role::Ui,
            text_size: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the chosen index when the author picks another.
    pub fn on_change(mut self, f: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }

    /// The block travels on `motion` instead of the weighted spring: a
    /// sidebar's Panel Tabs ride the panel's push (`motion::PUSH`, 265ms) and
    /// land with it. Reduced motion still lands at once.
    pub fn motion(mut self, motion: Motion) -> Self {
        self.glide = Some(motion);
        self
    }

    /// A click on the chosen word calls `on_change` too, with its own
    /// index (a sidebar half's selected tab closes the half).
    pub fn report_selected(mut self) -> Self {
        self.report_selected = true;
        self
    }

    /// The words' face: places (Panel Tabs, the Super View switch) are in
    /// the structure face; choices of a mode stay in the interface face.
    pub fn font(mut self, role: Role) -> Self {
        self.font = role;
        self
    }

    /// The words' size in px (default: the secondary size). Panel Tabs use
    /// `scale.label`.
    pub fn text_size(mut self, px: f32) -> Self {
        self.text_size = Some(px);
        self
    }
}

/// The block's position (x, width) at `at`.
fn block_at(s: &ChoiceState, at: Instant) -> Option<(f32, f32)> {
    let (tx, tw) = s.rect(s.selected)?;
    match (s.from, s.start) {
        (Some((fx, fw)), Some(start)) => {
            let t = s.travel(at.saturating_duration_since(start));
            Some((fx + (tx - fx) * t, fw + (tw - fw) * t))
        }
        _ => Some((tx, tw)),
    }
}

/// How far the block's texture has flowed at `at`: 1.2px per px travelled.
fn block_flow(s: &ChoiceState, at: Instant) -> f32 {
    match (s.from, block_at(s, at)) {
        (Some((fx, _)), Some((x, _))) => s.flow_base + (x - fx).abs() * 1.2,
        _ => s.flow_base,
    }
}

impl RenderOnce for Segmented {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let n = self.options.len();
        let state = use_choice(&self.id, self.selected, n, window, cx);
        let selected = self.selected;
        let reduce = theme.reduce_motion;
        let glide = self.glide;
        state.update(cx, |st, _| {
            st.rects.resize(n, None);
            // A change of curve mid-way keeps the block where it is.
            if st.glide != glide {
                let at = anim::now();
                if let Some(here) = block_at(st, at).filter(|_| st.start.is_some()) {
                    st.from = Some(here);
                    st.start = Some(at);
                }
                st.glide = glide;
            }
            if st.selected != selected {
                let at = anim::now();
                let from = block_at(st, at);
                st.flow_base = block_flow(st, at);
                st.from = if reduce { None } else { from };
                st.start = (!reduce).then_some(at);
                st.selected = selected;
            }
        });
        let height = s.control_height - 4.0;
        let block_state = state.clone();
        let block = canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                let now = anim::now();
                let st = block_state.read(cx);
                let Some((x, w)) = block_at(st, now) else {
                    return;
                };
                let moving = st
                    .start
                    .is_some_and(|start| now.saturating_duration_since(start) < st.travel_time());
                // The texture runs with the block's travel, so it is still
                // once the block lands.
                let travelled = block_flow(st, now);
                let rect = Bounds {
                    origin: gpui::point(px(x), bounds.origin.y),
                    size: gpui::size(px(w), bounds.size.height),
                };
                let outside = match glass::current_ground() {
                    Some(Ground::Flat { inside, .. }) => inside,
                    _ => p.desk,
                };
                window.paint_quad(gpui::fill(rect, p.page.solid()));
                let look = Look {
                    flow: travelled,
                    bleed_lift: p.bleed_lift,
                    ..Look::new(p.glass_clear, DENSE)
                };
                glass::paint_rim(
                    rect,
                    0.0,
                    &look,
                    Ground::Flat {
                        inside: p.page,
                        outside,
                    },
                    window,
                    cx,
                );
                anim::keep_going(moving, window);
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let mut row = div()
            .id(self.id.clone())
            .role(gpui::Role::RadioGroup)
            .relative()
            .h(px(height))
            .flex()
            .flex_row()
            .flex_none()
            .items_stretch()
            .font_role(self.font)
            .type_px(self.text_size.unwrap_or(s.secondary), s.line_body)
            .child(block);
        let disabled = self.disabled;
        let report_selected = self.report_selected;
        for (i, label) in self.options.into_iter().enumerate() {
            let on = i == selected;
            let ink = match (disabled, on) {
                (true, true) => p.ink(3),
                (true, false) => p.ink(5),
                (false, true) => p.ink(1),
                (false, false) => p.ink(3),
            };
            let hover = p.ink(2).solid();
            let f = self
                .on_change
                .clone()
                .filter(|_| !disabled && (!on || report_selected));
            let clickable = f.is_some();
            row = row.child(
                div()
                    .id(crate::style::child_id(&self.id.clone(), label.clone()))
                    .relative()
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .text_color(ink.solid())
                    .when(!on && !disabled, |el| {
                        el.hover(move |st| st.text_color(hover))
                    })
                    .when(clickable, |el| el.cursor_pointer())
                    .role(gpui::Role::RadioButton)
                    .aria_label(label.clone())
                    .aria_selected(on)
                    .child(measure(state.clone(), i))
                    .child(label)
                    .when_some(f, |el, f| el.on_click(move |_, w, cx| f(i, w, cx))),
            );
        }
        row
    }
}

/// One pill of a [`PillGroup`].
#[derive(Clone)]
pub struct Pill {
    pub label: SharedString,
    pub mark: Option<(sand::Kind, Option<Rgb>)>,
    pub tone: Tone,
    /// Who the pill is, when two could share a label (an open tab's key).
    pub key: Option<SharedString>,
    /// A preview: italic name, hollow mark.
    pub preview: bool,
    /// What it opens is taking long: it drifts on its own until it is there.
    pub loading: bool,
    /// What the pill holds instead of its mark and name (a split tab's two
    /// halves); the name still names it and its copy in the hand.
    pub content: Option<super::Build>,
}

impl std::fmt::Debug for Pill {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pill")
            .field("label", &self.label)
            .field("mark", &self.mark)
            .field("key", &self.key)
            .field("preview", &self.preview)
            .field("loading", &self.loading)
            .field("content", &self.content.is_some())
            .finish()
    }
}

impl Pill {
    pub fn new(label: impl Into<SharedString>) -> Pill {
        Pill {
            label: label.into(),
            mark: None,
            tone: Tone::Clear,
            key: None,
            preview: false,
            loading: false,
            content: None,
        }
    }

    pub fn key(mut self, key: impl Into<SharedString>) -> Pill {
        self.key = Some(key.into());
        self
    }

    pub fn preview(mut self, preview: bool) -> Pill {
        self.preview = preview;
        self
    }

    pub fn loading(mut self, loading: bool) -> Pill {
        self.loading = loading;
        self
    }

    /// Draw `build` inside the pill instead of the mark and name.
    pub fn content(
        mut self,
        build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Pill {
        self.content = Some(Rc::new(build));
        self
    }

    fn id_in(&self, group: &ElementId) -> ElementId {
        crate::style::child_id(
            group,
            self.key.clone().unwrap_or_else(|| self.label.clone()),
        )
    }

    /// The mark and the name, as a pill shows them.
    fn face(&self, id: &ElementId) -> impl IntoElement + use<> {
        let mark = self.mark.map(|(kind, color)| {
            let mark = KindMark::new(crate::style::child_id(id, "mark"), kind).hollow(self.preview);
            match color {
                Some(c) => mark.color(c),
                None => mark,
            }
        });
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .children(mark)
            .child(
                div()
                    .whitespace_nowrap()
                    .when(self.preview, |el| el.italic())
                    .child(self.label.clone()),
            )
    }

    /// Its kind mark, and the glass in the mark's colour.
    pub fn mark(mut self, kind: sand::Kind, color: Option<Rgb>) -> Pill {
        self.mark = Some((kind, color));
        if let Some(c) = color {
            self.tone = Tone::Color(c);
        }
        self
    }
}

/// Something done to each pill's element: GPUI listeners the group itself
/// does not set (a double click, a middle click, a drop target).
type EachPill = Rc<dyn Fn(usize, &Pill, Stateful<Div>) -> Stateful<Div>>;

/// The space between two pills.
pub const PILL_GAP: f32 = 4.0;

/// Told when a pill is picked up (`true`) and when it is let go.
type OnLift = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// What `draggable` adds, for one payload type: each pill can be picked up,
/// and the row follows the hand and takes the drop.
#[derive(Clone)]
struct Drag {
    #[allow(clippy::type_complexity)]
    pill: Rc<
        dyn Fn(usize, &Pill, Entity<ChoiceState>, Option<OnLift>, Stateful<Div>) -> Stateful<Div>,
    >,
    #[allow(clippy::type_complexity)]
    row: Rc<dyn Fn(Entity<ChoiceState>, Option<OnLift>, Stateful<Div>) -> Stateful<Div>>,
}

#[derive(IntoElement)]
pub struct PillGroup {
    id: ElementId,
    pills: Vec<Pill>,
    selected: usize,
    on_change: Option<OnSelect>,
    drag: Option<Drag>,
    map_pill: Option<EachPill>,
    grown_since: Option<Instant>,
    on_lift: Option<OnLift>,
}

impl PillGroup {
    pub fn new(id: impl Into<ElementId>, pills: Vec<Pill>, selected: usize) -> PillGroup {
        PillGroup {
            id: id.into(),
            pills,
            selected,
            on_change: None,
            drag: None,
            map_pill: None,
            grown_since: None,
            on_lift: None,
        }
    }

    /// Called with the chosen index when the author picks another.
    pub fn on_change(mut self, f: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(f));
        self
    }

    /// The pills can be picked up. The hand carries `payload(i)` (a GPUI
    /// drag value: anything else that takes `on_drop::<T>`, such as the
    /// paper's halves, can take it too), shown as a still copy of the pill
    /// that follows the pointer on the weighted spring ([`DraggedPill`]).
    /// Over the row the other pills make way where it would land; dropped
    /// there, `on_drop(payload, to)` gets the index it lands at (never its
    /// own). Dropped anywhere else it springs home and the owner hears
    /// nothing from the group.
    pub fn draggable<T: 'static>(
        mut self,
        payload: impl Fn(usize) -> T + 'static,
        on_drop: impl Fn(&T, usize, &mut Window, &mut App) + 'static,
    ) -> Self {
        let on_drop = Rc::new(on_drop);
        let pill = Rc::new(
            move |i,
                  pill: &Pill,
                  state: Entity<ChoiceState>,
                  on_lift: Option<OnLift>,
                  el: Stateful<Div>| {
                let lifted = pill.clone();
                el.on_drag(payload(i), move |_, grab, window, cx| {
                    let at = window.mouse_position();
                    let pointer = (f32::from(at.x), f32::from(at.y));
                    let ghost = cx.new(|_| DraggedPill::new(lifted.clone(), at));
                    let held = ghost.clone();
                    state.update(cx, |s, _| {
                        let grab = (f32::from(grab.x), f32::from(grab.y));
                        s.pick_up(i, grab, pointer, held, anim::now());
                    });
                    if let Some(f) = &on_lift {
                        f(true, window, cx);
                    }
                    ghost
                })
            },
        );
        let row = Rc::new(
            move |state: Entity<ChoiceState>, on_lift: Option<OnLift>, el: Stateful<Div>| {
                let moving = state.clone();
                let on_drop = on_drop.clone();
                el.on_drag_move::<T>(move |e, _, cx| {
                    let b = e.bounds;
                    let row = (
                        f32::from(b.origin.x),
                        f32::from(b.origin.y),
                        f32::from(b.size.width),
                        f32::from(b.size.height),
                    );
                    let at = (f32::from(e.event.position.x), f32::from(e.event.position.y));
                    moving.update(cx, |s, _| s.drag_to(at, row, anim::now()));
                })
                .on_drop(move |value: &T, window, cx| {
                    let moved = state.update(cx, |s, cx| {
                        let d = s.drag.take()?;
                        let (from, to) = (d.from, if d.inside { d.to } else { d.from });
                        s.land(d, to, cx, anim::now());
                        Some((from, to))
                    });
                    if moved.is_some()
                        && let Some(f) = &on_lift
                    {
                        f(false, window, cx);
                    }
                    if let Some((from, to)) = moved
                        && from != to
                    {
                        on_drop(value, to, window, cx);
                    }
                })
            },
        );
        self.drag = Some(Drag { pill, row });
        self
    }

    /// The row has just appeared out of a row of marks (the tab dock
    /// opening): each pill grows from a mark's width to its own on the dock
    /// pill's curve, its words come in last and the mark it grew from
    /// spreads away under the glass.
    pub fn grown_since(mut self, since: Option<Instant>) -> Self {
        self.grown_since = since;
        self
    }

    /// Told `true` when a pill is picked up and `false` when it is let go
    /// (dropped anywhere): a dock stays open while its pill is in the hand.
    pub fn on_lift(mut self, f: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_lift = Some(Rc::new(f));
        self
    }

    /// Adds to each pill's element (index, pill, element) what the group
    /// does not do itself: a double click that keeps a preview, a middle
    /// click that closes.
    pub fn map_pill(
        mut self,
        f: impl Fn(usize, &Pill, Stateful<Div>) -> Stateful<Div> + 'static,
    ) -> Self {
        self.map_pill = Some(Rc::new(f));
        self
    }
}

/// The pill in the hand: a still copy (paper fill, the selected rim, no
/// shadow) that follows the pointer on the weighted spring, a little
/// behind and never past it (workspace.md, 「拖拽排序有重量」).
pub struct DraggedPill {
    pill: Pill,
    /// Where the copy is, relative to the pointer, and how fast it moves.
    lag: gpui::Point<f32>,
    speed: gpui::Point<f32>,
    pointer: gpui::Point<Pixels>,
    last: Option<Instant>,
}

impl DraggedPill {
    pub fn new(pill: Pill, pointer: gpui::Point<Pixels>) -> DraggedPill {
        DraggedPill {
            pill,
            lag: gpui::Point::default(),
            speed: gpui::Point::default(),
            pointer,
            last: None,
        }
    }

    /// One step of the critically damped spring (stiffness
    /// `motion::SPRING_K`) toward the pointer: `lag` is how far behind the
    /// copy is.
    pub fn follow(lag: f32, speed: f32, dt: f32) -> (f32, f32) {
        let w = motion::SPRING_K.sqrt();
        let e = (-w * dt).exp();
        let c = speed + w * lag;
        ((lag + c * dt) * e, (speed - w * c * dt) * e)
    }
}

impl gpui::Render for DraggedPill {
    fn render(&mut self, window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let now = anim::now();
        let pointer = window.mouse_position();
        // The pointer moved: the copy is that much further behind.
        let moved = pointer - self.pointer;
        self.pointer = pointer;
        self.lag.x -= f32::from(moved.x);
        self.lag.y -= f32::from(moved.y);
        let dt = self.last.map_or(0.0, |l| {
            now.saturating_duration_since(l).as_secs_f32().min(0.05)
        });
        self.last = Some(now);
        if theme.reduce_motion {
            self.lag = gpui::Point::default();
            self.speed = gpui::Point::default();
        } else {
            let (x, vx) = Self::follow(self.lag.x, self.speed.x, dt);
            let (y, vy) = Self::follow(self.lag.y, self.speed.y, dt);
            self.lag = gpui::point(x, y);
            self.speed = gpui::point(vx, vy);
        }
        let settled = self.lag.x.abs() < 0.25
            && self.lag.y.abs() < 0.25
            && self.speed.x.abs() < 1.0
            && self.speed.y.abs() < 1.0;
        anim::keep_going(!settled, window);
        let tone = self.pill.tone;
        // The copy floats over whatever is under the hand: its rim is the
        // flat line (nothing to cover its corners with); the paper under
        // its words is the copy's own rounded fill.
        let spec = Spec::new(tone, g::PILL_HEIGHT / 2.0).ground(Ground::Uneven);
        let rim = glass::held_layer(
            glass::GlassState::new(Kind::Rest, Mode::default(), true),
            spec,
            theme,
        );
        let id: ElementId = "dr-ui-dragged-pill".into();
        let face = match &self.pill.content {
            Some(build) => build(window, cx),
            None => self.pill.face(&id).into_any_element(),
        };
        glass::surface(
            Ground::flat(p.page),
            div()
                .relative()
                .left(px(self.lag.x))
                .top(px(self.lag.y))
                .h(px(g::PILL_HEIGHT))
                .px(px(10.0))
                .flex()
                .flex_row()
                .items_center()
                .rounded_full()
                .bg(p.page.solid())
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(1).solid())
                .child(rim)
                .child(face),
        )
    }
}

/// The band at `at`: (a0, a1, b0, b1) in window x and its strength, or
/// `None` once it has landed and faded.
fn band_at(s: &ChoiceState, at: Instant) -> Option<(Band, f32, bool)> {
    let start = s.start?;
    let (fx, fw) = s.from?;
    let (tx, tw) = s.rect(s.selected)?;
    let travel = motion::wave::duration(s.crossed);
    let elapsed = at.saturating_duration_since(start);
    let (center, width, edge, k, travelling) = if elapsed < travel {
        let e = motion::wave::ease(elapsed.as_secs_f32() / travel.as_secs_f32());
        let mid = (std::f32::consts::PI * e).sin();
        let center = (fx + fw / 2.0) + ((tx + tw / 2.0) - (fx + fw / 2.0)) * e;
        let width = (fw + (tw - fw) * e) * (1.0 + (motion::wave::WIDEN - 1.0) * mid);
        let edge =
            motion::wave::EDGE_FROM + (motion::wave::EDGE_TO - motion::wave::EDGE_FROM) * mid;
        (center, width, edge, 1.0 - motion::wave::FADE * mid, true)
    } else {
        let settle = (elapsed - travel).as_secs_f32() / motion::wave::SETTLE.as_secs_f32();
        if settle >= 1.0 {
            return None;
        }
        (
            tx + tw / 2.0,
            tw,
            motion::wave::EDGE_FROM,
            1.0 - settle,
            false,
        )
    };
    let a1 = center - width / 2.0;
    let b0 = center + width / 2.0;
    Some(((a1 - edge, a1, b0, b0 + edge), k, travelling))
}

impl RenderOnce for PillGroup {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let n = self.pills.len();
        let selected = self.selected;
        let state = use_choice(&self.id, selected, n, window, cx);
        let reduce = theme.reduce_motion;
        let keys: Vec<ElementId> = self.pills.iter().map(|p| p.id_in(&self.id)).collect();
        let key = keys.get(selected).cloned();
        let now = anim::now();
        let dragging = cx.has_active_drag();
        let (offsets, lifted, moving, natural, let_go) = state.update(cx, |st, cx| {
            st.rects.resize(n, None);
            st.natural.resize(n, None);
            if st.selected != selected {
                if key.is_some() && st.selected_key == key {
                    // The same pill, moved: the selection goes with it.
                    st.from = None;
                    st.start = None;
                } else {
                    st.from = if reduce { None } else { st.rect(st.selected) };
                    st.crossed = (st.selected as i64 - selected as i64).unsigned_abs() as u32;
                    st.start = (!reduce).then_some(now);
                }
                st.selected = selected;
            }
            st.selected_key = key;
            st.keys = keys.clone();
            // Let go anywhere but on the row: everything springs home.
            let let_go = !dragging && st.drag.is_some();
            if let_go && let Some(d) = st.drag.take() {
                let from = d.from;
                st.land(d, from, cx, now);
            }
            if reduce {
                st.slides.clear();
            }
            st.slides
                .retain(|_, sl| !(sl.settled(now) && sl.target() == (0.0, 0.0)));
            let offsets: Vec<(f32, f32)> = keys.iter().map(|k| st.offset(k, now)).collect();
            let lifted = st.drag.as_ref().and_then(|d| d.keys.get(d.from).cloned());
            let moving = st.slides.values().any(|sl| !sl.settled(now));
            (offsets, lifted, moving, st.natural.clone(), let_go)
        });
        if let_go && let Some(f) = &self.on_lift {
            f(false, window, cx);
        }
        anim::keep_going(moving, window);
        let grow = self
            .grown_since
            .filter(|_| !reduce)
            .map(|since| now.saturating_duration_since(since))
            .filter(|e| reorder::growing(*e));
        anim::keep_going(grow.is_some(), window);
        let travelling = band_at(state.read(cx), now).is_some_and(|(_, _, t)| t);
        let mut row = div()
            .id(self.id.clone())
            .role(gpui::Role::TabList)
            .flex()
            .flex_row()
            .flex_none()
            .gap(px(PILL_GAP))
            .items_center();
        if let Some(drag) = &self.drag {
            row = (drag.row)(state.clone(), self.on_lift.clone(), row);
        }
        for (i, pill) in self.pills.into_iter().enumerate() {
            let on = i == selected;
            // While the wave travels the new pill keeps its resting line.
            let lit = on && !travelling;
            let pid = keys[i].clone();
            let spec =
                Spec::new(pill.tone, g::PILL_HEIGHT / 2.0).origin(glass::SAMPLE_ORIGINS[i % 4]);
            let band_state = state.clone();
            let band_tone = pill.tone;
            let band = canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    let now = anim::now();
                    let st = band_state.read(cx);
                    let Some((band, k, _)) = band_at(st, now) else {
                        return;
                    };
                    let group_x = st
                        .rect(0)
                        .map(|(x, _)| x)
                        .unwrap_or(f32::from(bounds.origin.x));
                    let travelled = st
                        .from
                        .map(|(fx, _)| (band.1 - fx).abs() * 1.2)
                        .unwrap_or(0.0);
                    let rel = f32::from(bounds.origin.x) - group_x;
                    let look = Look {
                        origin: (travelled - rel, -46.0),
                        bleed_lift: p.bleed_lift,
                        ..Look::new(band_tone.rgb(p), DENSE)
                    };
                    let ground = spec.resolve_ground(p);
                    glass::paint_band(
                        bounds,
                        g::PILL_HEIGHT / 2.0,
                        &look,
                        ground,
                        band,
                        k,
                        window,
                        cx,
                    );
                    window.request_animation_frame();
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full();
            let ink = if on { p.ink(1) } else { p.ink(2) };
            let f = self.on_change.clone();
            let face = match &pill.content {
                Some(build) => build(window, cx),
                None => pill.face(&pid).into_any_element(),
            };
            // Growing: the words at their own width, measured, fading in
            // behind the glass as it widens; the mark it grew from spreading
            // away where the pill's own mark leads.
            let (face, width, spread) = match grow {
                Some(elapsed) => {
                    let measured = state.clone();
                    let words = div()
                        .flex_none()
                        .relative()
                        .opacity(reorder::content_opacity(elapsed))
                        .child(face)
                        .child(
                            canvas(
                                move |b, _, cx| {
                                    measured.update(cx, |st, _| {
                                        if let Some(slot) = st.natural.get_mut(i) {
                                            *slot = Some(f32::from(b.size.width));
                                        }
                                    })
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full(),
                        );
                    let own = natural[i].map_or(reorder::MARK_WIDTH, |w| w + 2.0 * PILL_PAD);
                    let sp = reorder::spread(elapsed);
                    let spread = pill
                        .mark
                        .filter(|_| sp < 1.0)
                        .map(|(kind, color)| spreading_mark(kind, color, sp, p));
                    (
                        words.into_any_element(),
                        Some(reorder::grown_width(own, elapsed)),
                        spread,
                    )
                }
                None => (face, None, None),
            };
            let (dx, dy) = offsets[i];
            let el = glass::glass_box(
                pid.clone(),
                Kind::Rest,
                Mode {
                    loading: pill.loading,
                    ..Mode::default()
                },
                lit,
                spec,
                window,
                cx,
            )
            .relative()
            .h(px(g::PILL_HEIGHT))
            .px(px(PILL_PAD))
            .flex()
            .flex_row()
            .items_center()
            .rounded_full()
            .font_role(Role::Ui)
            .type_px(s.secondary, s.line_body)
            .text_color(ink.solid())
            .cursor_pointer()
            .when_some(width, |el, w| el.flex_none().w(px(w)).overflow_hidden())
            .when(dx != 0.0 || dy != 0.0, |el| el.left(px(dx)).top(px(dy)))
            // Its copy is in the hand; its slot stays.
            .when(lifted.as_ref() == Some(&pid), |el| el.opacity(0.0))
            .child(measure(state.clone(), i))
            .child(band)
            .children(spread)
            .child(face)
            .role(gpui::Role::Tab)
            .aria_label(pill.label.clone())
            .aria_selected(on)
            .when_some(f, |el, f| el.on_click(move |_, w, cx| f(i, w, cx)));
            let el = match &self.drag {
                Some(drag) => (drag.pill)(i, &pill, state.clone(), self.on_lift.clone(), el),
                None => el,
            };
            let el = match &self.map_pill {
                Some(map) => map(i, &pill, el),
                None => el,
            };
            row = row.child(el);
        }
        row
    }
}

/// A pill's padding either side of its words.
const PILL_PAD: f32 = 10.0;

/// The mark a dock pill grew from, `t` of the way to gone: wider and taller
/// and fainter where the pill's own mark leads its words.
fn spreading_mark(
    kind: sand::Kind,
    color: Option<Rgb>,
    t: f32,
    palette: &'static crate::tokens::Palette,
) -> impl IntoElement {
    let (sx, sy) = reorder::SPREAD_SCALE;
    let look = sand::MarkLook {
        kind,
        color,
        hollow: false,
        level: 1.0 - t,
        stretch: (1.0 + (sx - 1.0) * t, 1.0 + (sy - 1.0) * t),
    };
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(PILL_PAD))
        .w(px(sand::MARK_SLOT))
        .flex()
        .items_center()
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    sand::paint_kind_mark(bounds, 1.0, look, palette, window, cx)
                },
            )
            .size(px(sand::MARK_SLOT)),
        )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn panel_tabs_land_with_the_push_and_choices_on_the_spring() {
        let mut s = ChoiceState::new(0, 3);
        assert_eq!(s.travel_time(), motion::SPRING_DURATION);
        s.glide = Some(motion::PUSH);
        assert_eq!(s.travel_time(), Duration::from_millis(265));
        assert_eq!(s.travel(Duration::ZERO), 0.0);
        assert_eq!(s.travel(Duration::from_millis(265)), 1.0);
        assert_eq!(s.travel(Duration::from_secs(2)), 1.0);
        // The heavy ice: slow first, then fast.
        let early = s.travel(Duration::from_millis(66));
        assert!(early < 0.1, "{early}");
        let mut last = 0.0;
        for ms in (0..=265).step_by(5) {
            let t = s.travel(Duration::from_millis(ms));
            assert!(t >= last, "{ms}ms went back");
            last = t;
        }
    }

    #[test]
    fn the_pill_in_the_hand_follows_a_little_behind_and_never_past() {
        // The pointer jumps 100px ahead of the copy and stays.
        let (mut lag, mut speed) = (-100.0_f32, 0.0_f32);
        let mut steps = 0;
        while lag.abs() > 0.25 {
            (lag, speed) = DraggedPill::follow(lag, speed, 1.0 / 60.0);
            assert!(lag <= 0.0, "overshot the pointer: {lag}");
            steps += 1;
            assert!(steps < 120, "still {lag}px behind after 2s");
        }
        // Behind for a while, not one frame (it has weight)...
        assert!(steps > 15, "{steps} frames");
        // ...and caught up well within a second.
        assert!(steps < 60, "{steps} frames");
    }
}
