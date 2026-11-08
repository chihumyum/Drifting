//! The tour on screen (the 0.1 client's `CoachTour.tsx`): a ring of
//! waiting glass round the control a step is about and a card beside it, in
//! the hover card's shell, with Skip, Back and Next. Nothing else is covered
//! or dimmed, so the author can use what the ring points at.
//!
//! The tour draws in the floating layer, after the window's own tree, so it
//! reads the anchors of the very frame it draws in ([`super::anchor`]): the
//! ring and the card follow their control as it moves, and a step whose
//! control was not drawn is passed over in the frame after.

use std::time::{Duration, Instant};

use dr_i18n::keys;
use dr_shell::t;
use dr_ui::{
    anim::{self, Tween},
    components::{
        Button,
        menu::{float_shadow, slab_edge},
        overlay::{self, Layer, Place},
    },
    fonts::{Role, weight},
    glass::{self, GlassState, Ground, Kind, Mode, Spec, Tone},
    style::DrStyled as _,
    text::wrapped,
    theme::Theme,
    tokens::{Easing, Motion, menu as m, motion, radius, space},
};
use gpui::{
    AnyElement, App, Bounds, Context, Element, ElementId, Empty, FocusHandle, GlobalElementId,
    InspectorElementId, InteractiveElement as _, IntoElement, LayoutId, ParentElement as _, Pixels,
    Point, Render, SharedString, Size, StatefulInteractiveElement as _, Style, Styled as _, Task,
    Window, WindowId, div, point, prelude::FluentBuilder as _, px, size,
};

use super::{
    Back, KEY_CONTEXT, Next, Skip,
    anchor::{self, Shown},
    geometry,
    steps::{Step, Target, shortcut_text},
};

/// The tour comes up this long after the workspace shows uncovered
/// (`WORKSPACE_TOUR_DELAY_MS`).
pub const START_DELAY: Duration = Duration::from_millis(700);
/// The card's width (guide.css `.guide-card`, 20px wider than a hover card
/// for the step count beside the title).
pub const CARD_WIDTH: f32 = 268.0;
/// A step's words fade in as a block (guide.css `guide-card-text-in`).
const TEXT_IN: Motion = Motion::new(Duration::from_millis(180), Easing::EASE_OUT);

/// Where the tour stands, for tests and the debug bridge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TourState {
    /// The step shown, by its place in the tour.
    pub step: usize,
    pub id: &'static str,
    /// What it points at.
    pub target: Bounds<Pixels>,
    /// Where the ring is heading (it glides there).
    pub ring: Bounds<Pixels>,
    /// Pointing at the fallback (a closed sidebar's toggle).
    pub fallback: bool,
    /// Where the card is heading.
    pub card: Bounds<Pixels>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Started; comes up [`START_DELAY`] after the workspace shows.
    Waiting,
    Showing,
    Done,
}

/// Which step's card a frame was built with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Built {
    step: usize,
    fallback: bool,
}

/// Values gliding together along the Dock pill's motion (the ring and the
/// card slide to the next control together).
#[derive(Clone, Copy, Debug)]
struct Glide<const N: usize>([Tween; N]);

impl<const N: usize> Glide<N> {
    fn still(to: [f32; N]) -> Self {
        Glide(to.map(Tween::still))
    }

    fn aim(&mut self, to: [f32; N], now: Instant, reduce: bool) {
        for (tween, v) in self.0.iter_mut().zip(to) {
            tween.retarget_motion(v, now, motion::DOCK_PILL, reduce);
        }
    }

    fn at(&self, now: Instant) -> [f32; N] {
        self.0.map(|t| t.value(now))
    }

    fn moving(&self, now: Instant) -> bool {
        self.0.iter().any(|t| !t.settled(now))
    }

    /// Glides to `to`, or starts there.
    fn toward(slot: &mut Option<Self>, to: [f32; N], now: Instant, reduce: bool) {
        match slot {
            Some(glide) => glide.aim(to, now, reduce),
            None => *slot = Some(Glide::still(to)),
        }
    }
}

fn rect(v: [f32; 4]) -> Bounds<Pixels> {
    Bounds::new(point(px(v[0]), px(v[1])), size(px(v[2]), px(v[3])))
}

/// One window's tour.
pub(crate) struct TourView {
    window: WindowId,
    guide: &'static str,
    steps: &'static [Step],
    phase: Phase,
    timer: Option<Task<()>>,
    covered: bool,
    index: usize,
    forward: bool,
    /// The anchors of the last frame drawn.
    shown: Option<Shown>,
    placed: Option<TourState>,
    /// x, y, width, height, corner.
    ring: Option<Glide<5>>,
    card_at: Option<Glide<2>>,
    text_in: Tween,
    text_step: Option<usize>,
    glass: GlassState,
    reduce: bool,
    /// A step has been on screen: only then does ending count as seen.
    shown_any: bool,
    focus: FocusHandle,
    focused_step: Option<usize>,
    /// What had the keyboard before the card took it.
    before: Option<FocusHandle>,
}

impl TourView {
    pub(crate) fn new(
        window: WindowId,
        guide: &'static str,
        steps: &'static [Step],
        cx: &mut Context<Self>,
    ) -> TourView {
        TourView {
            window,
            guide,
            steps,
            phase: Phase::Waiting,
            timer: None,
            covered: false,
            index: 0,
            forward: true,
            shown: None,
            placed: None,
            ring: None,
            card_at: None,
            text_in: Tween::still(1.0),
            text_step: None,
            // `.glass--waiting` in the accent: drifting on its own.
            glass: GlassState::new(
                Kind::Hidden,
                Mode {
                    waiting: true,
                    ..Mode::default()
                },
                false,
            ),
            reduce: false,
            shown_any: false,
            focus: cx.focus_handle(),
            focused_step: None,
            before: None,
        }
    }

    pub(crate) fn running(&self) -> bool {
        self.phase != Phase::Done
    }

    pub(crate) fn state(&self) -> Option<TourState> {
        (self.phase == Phase::Showing && !self.covered)
            .then_some(self.placed)
            .flatten()
    }

    /// Covered by a Super View or the opening wait: put away, and back at
    /// the first step when it shows again. The delay before it first comes
    /// up counts only while it is uncovered.
    pub(crate) fn set_covered(&mut self, covered: bool, window: &Window, cx: &mut Context<Self>) {
        if covered && !self.covered && self.phase == Phase::Showing {
            self.rewind();
        }
        self.covered = covered;
        match self.phase {
            Phase::Waiting if covered => self.timer = None,
            Phase::Waiting if self.timer.is_none() => {
                self.timer = Some(cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor().timer(START_DELAY).await;
                    this.update(cx, |tour, cx| {
                        if tour.phase == Phase::Waiting {
                            tour.phase = Phase::Showing;
                            cx.notify();
                        }
                    })
                    .ok();
                }));
            }
            _ => {}
        }
        anchor::listen(self.window, self.phase == Phase::Showing && !covered);
    }

    fn rewind(&mut self) {
        self.index = 0;
        self.forward = true;
        self.shown = None;
        self.placed = None;
        self.ring = None;
        self.card_at = None;
        self.text_step = None;
        self.focused_step = None;
    }

    /// Next (or Done on the last step) and Back.
    fn go(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.phase != Phase::Showing {
            return;
        }
        if forward && self.index + 1 >= self.steps.len() {
            self.finish(window, cx);
        } else {
            self.forward = forward;
            self.index = if forward {
                self.index + 1
            } else {
                self.index.saturating_sub(1)
            };
        }
        cx.notify();
    }

    /// Finished or skipped: remembered as seen on this device, and the
    /// keyboard goes back where it was. A tour that found nothing to point
    /// at ends without counting as seen (it comes again with the next book).
    pub(crate) fn finish(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.phase == Phase::Done {
            return;
        }
        self.phase = Phase::Done;
        self.timer = None;
        self.placed = None;
        anchor::listen(self.window, false);
        // After this update (the store may write the settings, which
        // repaints every window): not tied to the tour, which may be gone.
        let guide = self.guide;
        if self.shown_any {
            App::defer(cx, move |cx| super::mark_seen(guide, cx));
        }
        let before = self.before.take();
        if self.focus.contains_focused(window, cx)
            && let Some(before) = before
        {
            cx.defer_in(window, move |_, window, cx| window.focus(&before, cx));
        }
    }

    /// The step to show from `index` on in the tour's direction: the first
    /// whose control (or fallback) is on screen. Back past the first step
    /// turns forward; forward past the last ends the tour (`None`).
    fn settle(&mut self, shown: &Shown, viewport: Size<Pixels>) -> Option<(usize, Target)> {
        let n = self.steps.len();
        let mut i = self.index.min(n.saturating_sub(1));
        for _ in 0..=2 * n {
            if let Some(target) = self.steps.get(i)?.resolve(shown, viewport) {
                self.index = i;
                return Some((i, target));
            }
            if self.forward {
                i += 1;
                if i >= n {
                    return None;
                }
            } else if i == 0 {
                self.forward = true;
            } else {
                i -= 1;
            }
        }
        None
    }

    /// What the frame being drawn shows: called from the floating layer
    /// with its anchors. `None` for `built` asks only to look.
    fn follow(
        &mut self,
        shown: Shown,
        built: Option<Built>,
        card: Option<Size<Pixels>>,
        viewport: Size<Pixels>,
        now: Instant,
    ) -> Followed {
        let found = built.and_then(|b| {
            self.steps[b.step]
                .resolve(&shown, viewport)
                .filter(|t| t.fallback == b.fallback)
                .map(|t| (b, t))
        });
        self.shown = Some(shown);
        let reduce = self.reduce;
        if let Some((built, target)) = found {
            let ring = geometry::ring(target.rect, viewport);
            let b = ring.bounds;
            let to = [
                f32::from(b.origin.x),
                f32::from(b.origin.y),
                f32::from(b.size.width),
                f32::from(b.size.height),
                ring.radius,
            ];
            Glide::toward(&mut self.ring, to, now, reduce);
            if let Some(card) = card {
                let at = geometry::card_origin(b, card, viewport);
                Glide::toward(
                    &mut self.card_at,
                    [f32::from(at.x), f32::from(at.y)],
                    now,
                    reduce,
                );
                self.shown_any = true;
                self.placed = Some(TourState {
                    step: built.step,
                    id: self.steps[built.step].id,
                    target: target.rect,
                    ring: b,
                    fallback: target.fallback,
                    card: Bounds::new(at, card),
                });
            }
        }
        let ring = self.ring.map(|g| {
            let v = g.at(now);
            (rect([v[0], v[1], v[2], v[3]]), v[4])
        });
        let card_at = self.card_at.map(|g| {
            let v = g.at(now);
            point(px(v[0]), px(v[1]))
        });
        Followed {
            ring,
            card_at,
            // Another step, or the other sentence: build the card again.
            again: found.is_none(),
            moving: self.ring.is_some_and(|g| g.moving(now))
                || self.card_at.is_some_and(|g| g.moving(now)),
        }
    }

    fn card(
        &self,
        index: usize,
        target: Target,
        fade: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let step = &self.steps[index];
        let title = t(cx, step.title);
        let body = t(cx, step.body(target.fallback));
        let shortcuts: Vec<SharedString> = step
            .shortcuts
            .iter()
            .filter_map(|k| shortcut_text(*k, cx))
            .collect();
        let last = index + 1 == self.steps.len();
        // The step count and the shortcuts are index type: numbers and keys
        // written plainly, no keycaps or capsules.
        let index_type = |el: gpui::Div| el.font_role(Role::Index).text_color(p.muted().solid());
        let head = div()
            .flex()
            .flex_row()
            .items_baseline()
            .justify_between()
            .gap(px(space::S5))
            .child(
                div()
                    .min_w_0()
                    .weight(weight::SEMIBOLD)
                    .text_color(p.ink(1).solid())
                    .child(title.clone()),
            )
            .child(index_type(div().flex_none()).child(format!(
                "{} / {}",
                index + 1,
                self.steps.len()
            )));
        let words = div()
            .relative()
            .opacity(fade)
            .flex()
            .flex_col()
            .gap(px(space::S2))
            .pt(px(space::S5))
            .px(px(m::HOVER_CARD_PAD))
            .pb(px(space::S4))
            .child(head)
            .child(wrapped(body))
            .when(!shortcuts.is_empty(), |el| {
                el.child(
                    index_type(div())
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .gap_x(px(space::S6))
                        .gap_y(px(space::S1))
                        .children(shortcuts),
                )
            });
        let view = cx.entity();
        let (skip, back, next) = (view.clone(), view.clone(), view);
        let actions = div()
            .relative()
            .mx(px(m::HOVER_CARD_PAD))
            .pt(px(space::S3))
            .pb(px(space::S4))
            .border_t(px(m::SEPARATOR))
            .border_color(p.hairline())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::S2))
            .child(
                Button::new("tour-skip", t(cx, keys::guide::SKIP))
                    .text()
                    .small()
                    .on_click(move |_, window, cx| {
                        skip.update(cx, |tour, cx| {
                            tour.finish(window, cx);
                            cx.notify();
                        })
                    }),
            )
            .child(div().flex_1())
            .when(index > 0, |el| {
                el.child(
                    Button::new("tour-back", t(cx, keys::guide::BACK))
                        .small()
                        .on_click(move |_, window, cx| {
                            back.update(cx, |tour, cx| tour.go(false, window, cx))
                        }),
                )
            })
            .child(
                Button::new(
                    "tour-next",
                    t(
                        cx,
                        if last {
                            keys::guide::DONE
                        } else {
                            keys::guide::NEXT
                        },
                    ),
                )
                .primary()
                .small()
                .on_click(move |_, window, cx| {
                    next.update(cx, |tour, cx| tour.go(true, window, cx))
                }),
            );
        glass::surface(
            Ground::flat(p.desk),
            div()
                .id("tour-card")
                .absolute()
                .top_0()
                .left_0()
                .w(px(CARD_WIDTH))
                .rounded(px(radius::SHEET))
                .shadow(float_shadow(p))
                .occlude()
                .key_context(KEY_CONTEXT)
                .track_focus(&self.focus)
                .on_action(cx.listener(|tour, _: &Next, window, cx| tour.go(true, window, cx)))
                .on_action(cx.listener(|tour, _: &Back, window, cx| tour.go(false, window, cx)))
                .on_action(cx.listener(|tour, _: &Skip, window, cx| {
                    tour.finish(window, cx);
                    cx.notify();
                }))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(2).solid())
                .role(gpui::Role::Dialog)
                .aria_label(title)
                .child(slab_edge(p, radius::SHEET))
                .child(words)
                .child(actions),
        )
        .into_any_element()
    }
}

impl Render for TourView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.covered || self.phase != Phase::Showing {
            return Empty.into_any_element();
        }
        anchor::listen(self.window, true);
        let theme = Theme::of(window, cx);
        let now = anim::now();
        if theme.reduce_motion != self.reduce {
            self.reduce = theme.reduce_motion;
            self.glass.set_reduce_motion(self.reduce);
            self.glass.retarget(now);
        }
        let entity = cx.entity();
        // Nothing seen yet: one frame to look round.
        let Some(shown) = self.shown.take() else {
            return overlay::float(Place::Center, Layer::Popover, TourLayer::new(entity, None))
                .into_any_element();
        };
        let found = self.settle(&shown, window.viewport_size());
        self.shown = Some(shown);
        let Some((index, target)) = found else {
            self.finish(window, cx);
            return Empty.into_any_element();
        };
        if self.text_step != Some(index) {
            self.text_step = Some(index);
            self.text_in = Tween::still(0.0);
            self.text_in.retarget_motion(1.0, now, TEXT_IN, self.reduce);
        }
        anim::keep_going(!self.text_in.settled(now), window);
        // Next takes the keyboard when a step comes up, so Return walks the
        // tour and Esc skips it.
        if self.focused_step != Some(index) {
            self.focused_step = Some(index);
            if self.before.is_none() {
                self.before = window.focused(cx);
            }
            let focus = self.focus.clone();
            cx.defer_in(window, move |_, window, cx| window.focus(&focus, cx));
        }
        let card = self.card(index, target, self.text_in.value(now), window, cx);
        let built = Built {
            step: index,
            fallback: target.fallback,
        };
        overlay::float(
            Place::Center,
            Layer::Popover,
            TourLayer::new(entity, Some((built, card))),
        )
        .into_any_element()
    }
}

/// What a frame of the floating layer shows.
struct Followed {
    ring: Option<(Bounds<Pixels>, f32)>,
    card_at: Option<Point<Pixels>>,
    again: bool,
    moving: bool,
}

/// The window-sized floating layer: it reads the frame's anchors, then
/// places the ring and the card. Only the card takes the pointer.
struct TourLayer {
    view: gpui::Entity<TourView>,
    built: Option<Built>,
    card: Option<AnyElement>,
}

impl TourLayer {
    fn new(view: gpui::Entity<TourView>, card: Option<(Built, AnyElement)>) -> TourLayer {
        let (built, card) = card.unzip();
        TourLayer { view, built, card }
    }
}

impl IntoElement for TourLayer {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

struct LayerFrame {
    ring: Option<(Bounds<Pixels>, f32)>,
    card: bool,
}

impl Element for TourLayer {
    type RequestLayoutState = Option<LayoutId>;
    type PrepaintState = LayerFrame;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Option<LayoutId>) {
        let card = self.card.as_mut().map(|c| c.request_layout(window, cx));
        let viewport = window.viewport_size();
        let mut style = Style::default();
        style.size.width = viewport.width.into();
        style.size.height = viewport.height.into();
        (window.request_layout(style, card, cx), card)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        card_layout: &mut Option<LayoutId>,
        window: &mut Window,
        cx: &mut App,
    ) -> LayerFrame {
        let id = window.window_handle().window_id();
        let shown = anchor::take(id);
        let laid = card_layout.map(|l| window.layout_bounds(l));
        let viewport = window.viewport_size();
        let now = anim::now();
        let built = self.built;
        let followed = self.view.update(cx, |tour, _| {
            tour.follow(shown, built, laid.map(|b| b.size), viewport, now)
        });
        let mut card = false;
        if let (Some(element), Some(laid), Some(at)) = (self.card.as_mut(), laid, followed.card_at)
        {
            window.with_element_offset(at - laid.origin, |window| element.prepaint(window, cx));
            card = true;
        }
        anim::keep_going(followed.moving || followed.again, window);
        LayerFrame {
            ring: followed.ring,
            card,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut Option<LayoutId>,
        frame: &mut LayerFrame,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some((ring, corner)) = frame.ring {
            // The ring lies over the control itself, so it is the uniform
            // line glass draws over anything that is not one flat colour.
            let palette = Theme::of(window, cx).palette;
            let state = self.view.read(cx).glass;
            let now = anim::now();
            let spec = Spec::new(Tone::Accent, corner).ground(Ground::Uneven);
            let look = spec.look(&state, now, palette);
            glass::paint_rim(ring, corner, &look, Ground::Uneven, window, cx);
            glass::request_frames(&state, now, window, cx);
        }
        if frame.card
            && let Some(card) = self.card.as_mut()
        {
            card.paint(window, cx);
        }
    }
}
