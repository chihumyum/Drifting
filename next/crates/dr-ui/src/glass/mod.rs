//! 素玻璃: what the hand presses. A glass control shows only a rim cut from
//! one uneven texture; see `state.rs` for how it answers the hand and
//! `paint.rs` for how it is drawn without a backdrop blur (decision D2).
//!
//! Every glass control knows the flat colour under and round it
//! ([`Ground`]). Whoever paints a flat surface declares it with
//! [`surface`], and every rim painted inside picks it up; glass over
//! anything uneven says [`Ground::Uneven`] and falls back to a uniform line.

mod paint;
mod state;

use std::cell::RefCell;

use gpui::{
    AnyElement, App, Bounds, ElementId, Entity, GlobalElementId, InspectorElementId,
    InteractiveElement, IntoElement, LayoutId, MouseButton, ParentElement, Pixels, Stateful,
    StatefulInteractiveElement, Styled, Window, canvas, div, prelude::FluentBuilder as _,
};

pub use paint::{dilate, inset, paint_band, paint_rim, paint_slab, rim_profile};
pub use state::{GlassState, Held, Kind, Mode, Target};

use crate::{
    anim,
    theme::Theme,
    tokens::{Palette, Rgb, Story},
};

/// `--glass-edge` 33% × 1.8: the ring's alpha at strength 1.
pub const GLASS_EDGE: f32 = 0.594;
/// The texture tile, in logical px (`mask-size: 150px 150px`).
pub const TILE: f32 = 150.0;
/// How fast the texture travels while the glass drifts: one tile in 15s.
pub const FLOW_PX_PER_S: f32 = TILE / 15.0;
/// The texture's mean alpha; the uniform fallback line is drawn at this share.
pub const TEXTURE_MEAN: f32 = 0.463;
/// The four sampling origins large glass rotates through
/// (`.glass:nth-of-type(4n + k)`), and the dense patch small glass reads.
pub const SAMPLE_ORIGINS: [(f32, f32); 4] = [
    (-14.0, -46.0),
    (-96.0, -132.0),
    (-168.0, -18.0),
    (-58.0, -186.0),
];
pub const DENSE: (f32, f32) = (-96.0, -132.0);
/// Where a menu's resting line reads the ring texture.
pub const SLAB_ORIGIN: (f32, f32) = SAMPLE_ORIGINS[0];

/// Everything about one rim at one moment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// The rim's visibility, 0–1.
    pub opacity: f32,
    /// `--glass-g`: strength.
    pub g: f32,
    /// `--glass-sp`: bleed multiplier.
    pub sp: f32,
    /// How far the texture has drifted, px along the diagonal.
    pub flow: f32,
    /// `--glass-rim`, px.
    pub rim: f32,
    /// Sampling origin on the texture.
    pub origin: (f32, f32),
    /// `--glass-cc`.
    pub color: Rgb,
    /// `--glass-bleed-lift`.
    pub bleed_lift: f32,
}

impl Look {
    pub fn new(color: Rgb, origin: (f32, f32)) -> Look {
        Look {
            opacity: 1.0,
            g: 1.0,
            sp: 1.0,
            flow: 0.0,
            rim: crate::tokens::glass::RIM,
            origin,
            color,
            bleed_lift: 0.0,
        }
    }
}

/// What lies under and round a rim.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ground {
    /// A flat colour inside the control and round its corners.
    Flat { inside: Rgb, outside: Rgb },
    /// An image, the character sea, prose: the rim falls back to a uniform line.
    Uneven,
}

impl Ground {
    pub const fn flat(color: Rgb) -> Ground {
        Ground::Flat {
            inside: color,
            outside: color,
        }
    }
}

/// The colour a rim takes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Tone {
    /// `--glass-clear`: glass that belongs to nothing.
    #[default]
    Clear,
    /// The accent: a primary button, an open Switch, a waiting card.
    Accent,
    /// `--destructive`: a dangerous action's button.
    Danger,
    /// A storyline's or category's colour.
    Story(Story),
    Color(Rgb),
}

impl Tone {
    pub fn rgb(self, palette: &Palette) -> Rgb {
        match self {
            Tone::Clear => palette.glass_clear,
            Tone::Accent => palette.accent,
            Tone::Danger => palette.danger,
            Tone::Story(s) => palette.story(s),
            Tone::Color(c) => c,
        }
    }
}

thread_local! {
    static GROUNDS: RefCell<Vec<Ground>> = const { RefCell::new(Vec::new()) };
}

/// The ground declared by the innermost [`surface`] being painted, or `None`
/// outside any.
pub fn current_ground() -> Option<Ground> {
    GROUNDS.with(|g| g.borrow().last().copied())
}

/// Declares `ground` for every rim painted inside `child`. Paint the
/// surface's own fill on `child` itself (`div().bg(...)`).
pub fn surface(ground: Ground, child: impl IntoElement) -> GroundScope {
    GroundScope {
        ground,
        child: Some(child.into_any_element()),
    }
}

pub struct GroundScope {
    ground: Ground,
    child: Option<AnyElement>,
}

impl IntoElement for GroundScope {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl gpui::Element for GroundScope {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self.child.take().expect("laid out once");
        (child.request_layout(window, cx), child)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        GROUNDS.with(|g| g.borrow_mut().push(self.ground));
        child.paint(window, cx);
        GROUNDS.with(|g| {
            g.borrow_mut().pop();
        });
    }
}

/// How a rim is drawn, apart from its state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    pub tone: Tone,
    pub radius: f32,
    pub origin: (f32, f32),
    /// `None` takes the ground of the surface it is painted on.
    pub ground: Option<Ground>,
    /// The whole rim's strength (an empty chip's line is at half).
    pub strength: f32,
    /// `--glass-rim` for this control: how far its bleed reaches.
    pub rim: f32,
    /// The control's own opaque fill (a field, a floating button, a chip
    /// that is on): the rim covers its middle with this and its corners
    /// with the surface round it.
    pub fill: Option<Rgb>,
}

impl Spec {
    pub fn new(tone: Tone, radius: f32) -> Spec {
        Spec {
            tone,
            radius,
            origin: DENSE,
            ground: None,
            strength: 1.0,
            rim: crate::tokens::glass::RIM,
            fill: None,
        }
    }

    /// The control paints its own opaque `fill` under the rim.
    pub fn filled(self, fill: Rgb) -> Spec {
        Spec {
            fill: Some(fill),
            ..self
        }
    }

    pub fn strength(self, strength: f32) -> Spec {
        Spec { strength, ..self }
    }

    pub fn rim(self, rim: f32) -> Spec {
        Spec { rim, ..self }
    }

    /// The rim of `state` at `at`, with this spec's colour and reach.
    pub fn look(&self, state: &GlassState, at: std::time::Instant, palette: &Palette) -> Look {
        let mut look = state.look(at, self.tone.rgb(palette), self.origin);
        look.bleed_lift = palette.bleed_lift;
        look.opacity *= self.strength;
        look.rim = self.rim;
        look
    }

    /// The ground this rim sits on, while it is being painted.
    pub fn resolve_ground(&self, palette: &Palette) -> Ground {
        let around = self
            .ground
            .or_else(current_ground)
            .unwrap_or(Ground::flat(palette.desk));
        match (self.fill, around) {
            (Some(fill), Ground::Flat { inside, .. }) => Ground::Flat {
                inside: fill,
                outside: inside,
            },
            (Some(fill), Ground::Uneven) => Ground::Flat {
                inside: fill,
                outside: fill,
            },
            (None, ground) => ground,
        }
    }

    pub fn origin(self, origin: (f32, f32)) -> Spec {
        Spec { origin, ..self }
    }

    pub fn ground(self, ground: Ground) -> Spec {
        Spec {
            ground: Some(ground),
            ..self
        }
    }
}

/// The rim of `state`, as an absolutely placed layer under a control's
/// content. It asks for frames only while the rim moves.
pub fn layer(state: Entity<GlassState>, spec: Spec, theme: Theme) -> impl IntoElement {
    let palette = theme.palette;
    canvas(
        |_, _, _| (),
        move |bounds, _, window, cx| {
            let now = anim::now();
            let s = state.read(cx);
            let look = spec.look(s, now, palette);
            let ground = spec.resolve_ground(palette);
            paint_rim(bounds, spec.radius, &look, ground, window, cx);
            request_frames(s, now, window, cx);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// Asks for the next frame a rim needs: every refresh while it changes
/// state, about 30 a second while it only drifts slowly, none when still.
pub fn request_frames(state: &GlassState, at: std::time::Instant, window: &Window, cx: &App) {
    if state.changing(at) {
        window.request_animation_frame();
    } else if state.drift_speed() > 0.0 {
        match anim::interval_for(state.drift_speed()) {
            Some(interval) => anim::keep_going_within(interval, window, cx),
            None => window.request_animation_frame(),
        }
    }
}

/// The keyed glass state of the control `id`, created on first render.
pub fn use_state(
    id: impl Into<ElementId>,
    kind: Kind,
    mode: Mode,
    selected: bool,
    theme: Theme,
    window: &mut Window,
    cx: &mut App,
) -> Entity<GlassState> {
    let state = window.use_keyed_state(id, cx, |_, _| GlassState::new(kind, mode, selected));
    state.update(cx, |s, _| {
        s.set_reduce_motion(theme.reduce_motion);
        s.set_kind(kind);
        s.set_mode(mode);
        s.set_selected(selected);
    });
    state
}

/// Wires hover and press on `el` to `state`. `interactive` false (disabled,
/// read-only) leaves the rim as it is.
pub fn wire(
    el: Stateful<gpui::Div>,
    state: &Entity<GlassState>,
    interactive: bool,
) -> Stateful<gpui::Div> {
    if !interactive {
        return el;
    }
    let hover = state.clone();
    let down = state.clone();
    let up = state.clone();
    let out = state.clone();
    el.on_hover(move |hovered, _, cx| {
        hover.update(cx, |s, cx| {
            if s.set_hover(*hovered) {
                cx.notify();
            }
        });
    })
    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
        down.update(cx, |s, cx| {
            if s.set_pressed(true) {
                cx.notify();
            }
        });
    })
    .on_mouse_up(MouseButton::Left, move |_, _, cx| {
        up.update(cx, |s, cx| {
            if s.set_pressed(false) {
                cx.notify();
            }
        });
    })
    .on_mouse_up_out(MouseButton::Left, move |_, _, cx| {
        out.update(cx, |s, cx| {
            if s.set_pressed(false) {
                cx.notify();
            }
        });
    })
}

/// A ready glass box: `div` with id `id`, its rim layer under its children
/// and hover and press wired. Style and fill it like any div.
#[allow(clippy::too_many_arguments)]
pub fn glass_box(
    id: impl Into<ElementId>,
    kind: Kind,
    mode: Mode,
    selected: bool,
    spec: Spec,
    window: &mut Window,
    cx: &mut App,
) -> Stateful<gpui::Div> {
    let id = id.into();
    let theme = Theme::of(window, cx);
    let state = use_state(id.clone(), kind, mode, selected, theme, window, cx);
    let interactive = !mode.disabled;
    let el = div()
        .id(id)
        .relative()
        .child(layer(state.clone(), spec, theme))
        .when(!interactive, |el| el.cursor_default());
    wire(el, &state, interactive)
}

/// A rim held still in `state` (no hand, no frames): a layer like [`layer`].
pub fn held_layer(state: GlassState, spec: Spec, theme: Theme) -> impl IntoElement {
    let palette = theme.palette;
    canvas(
        |_, _, _| (),
        move |bounds, _, window, cx| {
            let look = spec.look(&state, anim::now(), palette);
            let ground = spec.resolve_ground(palette);
            paint_rim(bounds, spec.radius, &look, ground, window, cx);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}
