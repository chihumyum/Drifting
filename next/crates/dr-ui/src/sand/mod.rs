//! 砂笔: what the author leaves. Brush icons, kind marks, the frame drawn
//! round a selected cell, readouts drawn as one dry stroke.
//!
//! Every mask is a white alpha PNG drawn through GPUI's `svg()` (tinted on
//! the GPU). Light themes multiply sand into the ground; GPUI has no blend
//! modes, so on a flat ground the colour is multiplied in advance
//! ([`Palette::sand_on`]), which gives the same pixels.
//!
//! Sand never appears or vanishes in one frame: it fades in and out as a
//! whole ([`motion::sand::FADE`]), and only the author's own actions draw it
//! along its path ([`SandFrame`]).

mod icon_names;
pub mod line;
mod mask_names;
pub mod stroke;

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use gpui::{
    App, Bounds, Div, ElementId, Entity, Hsla, IntoElement, ParentElement, Pixels, RenderImage,
    RenderOnce, SharedString, Styled, Svg, TextAlign, TextRun, Transformation,
    TransformationMatrix, Window, canvas, div, point, prelude::FluentBuilder, px, radians, size,
    svg,
};
use image::Frame;
use smallvec::SmallVec;

pub use icon_names::Icon;
pub use mask_names::SandMask;

use crate::{
    anim::{self, Tween},
    glass::{Ground, current_ground},
    theme::Theme,
    tokens::{Easing, Palette, Rgb, motion},
};

/// A brush icon in `color` (`BrushIcon`): plain tint, no blend, so hover and
/// press colours still reach it.
pub fn icon(icon: Icon, size_px: f32, color: Hsla) -> Svg {
    svg()
        .path(icon.shared_path())
        .size(px(size_px))
        .flex_none()
        .text_color(color)
}

/// A brush icon at `size_px` (`18px` for the overlapping moon switch) with a
/// circular cutout (`hole = 18 * 0.345`, `0.6px` soft edge) cleared on its
/// left (`cut_on_right == false`) or right (`cut_on_right == true`) around a
/// front icon centered `8px` away (`W25Final`).
pub fn icon_cutout(icon: Icon, size_px: f32, color: Hsla, cut_on_right: bool) -> Svg {
    svg()
        .path(icon.cut_shared_path(cut_on_right))
        .size(px(size_px))
        .flex_none()
        .text_color(color)
}

/// Total frames in the 风·林·火·山 thinking strip (`icons/thinking.png`).
pub const THINKING_FRAMES: usize = 68;
/// Zero-based index of the resting frame for 「已思考」: the 57th frame (山).
pub const THINKING_STILL_FRAME: usize = 56;
/// Milliseconds per frame when playing the thinking strip (8 fps, 8.5s loop).
pub const THINKING_STEP_MS: usize = 125;

/// Pure frame selector for the 68-frame 风·林·火·山 strip.
pub const fn thinking_frame(elapsed_ms: usize, running: bool) -> usize {
    if running {
        (elapsed_ms / THINKING_STEP_MS) % THINKING_FRAMES
    } else {
        THINKING_STILL_FRAME
    }
}

fn thinking_at_frame(size_px: f32, color: Hsla, frame: usize) -> Div {
    div()
        .size(px(size_px))
        .flex_none()
        .overflow_hidden()
        .relative()
        .child(
            svg()
                .path(Icon::Thinking.shared_path())
                .absolute()
                .top_0()
                .left(px(-(frame as f32) * size_px))
                .w(px(size_px * THINKING_FRAMES as f32))
                .h(px(size_px))
                .text_color(color),
        )
}

/// Static mountain frame (山, 57th frame) for menus and non-animated badges.
pub fn thinking_still(size_px: f32, color: Hsla) -> Div {
    thinking_at_frame(size_px, color, THINKING_STILL_FRAME)
}

/// 风·林·火·山: 68 frames side by side, stepped forward at 125ms a frame
/// while `running`; still, it holds the 57th frame (山). It plays under
/// reduced motion too (it says the Agent is still at work), so callers pass
/// whether it runs and nothing else.
pub fn thinking(size_px: f32, color: Hsla, running: bool, window: &Window) -> impl IntoElement {
    let frame = if running {
        let ms = anim::now()
            .duration_since(*START.get_or_init(Instant::now))
            .as_millis() as usize;
        window.request_animation_frame();
        thinking_frame(ms, true)
    } else {
        THINKING_STILL_FRAME
    };
    thinking_at_frame(size_px, color, frame)
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Pinwheel timing constants (`kernel-v5` §7, prototype `.ani.pin`).
pub const PINWHEEL_LAP_SECS: f32 = 1.6;
pub const PINWHEEL_SLOW_SECS: f32 = 3.0;
pub const PINWHEEL_FILL_SECS: f32 = 0.6;
const PINWHEEL_OMEGA: f32 = -std::f32::consts::TAU / PINWHEEL_LAP_SECS;

/// Instantaneous visual state of a comment card's pinwheel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PinwheelSample {
    /// Counter-clockwise rotation angle in radians (`0` or negative).
    pub angle_rad: f32,
    /// Opacity of the hollow `Icon::Pinwheel` (`0.0..=1.0`).
    pub hollow_alpha: f32,
    /// Opacity of the filled `Icon::PinwheelSolid` (`0.0..=1.0`).
    pub solid_alpha: f32,
    /// Whether another animation frame is required.
    pub animating: bool,
}

#[derive(Clone, Copy, Debug)]
enum PinwheelPhase {
    Spinning { started_at: Instant, angle0: f32 },
    Stopping { stopped_at: Instant, angle0: f32 },
    Resting { angle: f32 },
}

/// State machine for a comment card's Agent pinwheel:
/// hollow spinning CCW (`1.6s`/turn) → `3.0s` uniform deceleration on finish →
/// `0.6s` whole-shape cross-fade into solid → resting solid until viewed.
#[derive(Clone, Debug)]
pub struct PinwheelTrack {
    phase: PinwheelPhase,
}

impl PinwheelTrack {
    /// Starts spinning from `0°` at `now`.
    pub fn spinning(now: Instant) -> Self {
        Self {
            phase: PinwheelPhase::Spinning {
                started_at: now,
                angle0: 0.0,
            },
        }
    }

    /// Already finished before this view opened (solid, still at `0°`).
    pub fn finished() -> Self {
        Self {
            phase: PinwheelPhase::Resting { angle: 0.0 },
        }
    }

    /// Updates the track with whether the Agent conversation is currently running.
    pub fn sync(&mut self, running: bool, now: Instant) {
        match (self.phase, running) {
            (PinwheelPhase::Spinning { .. }, true) => {}
            (PinwheelPhase::Spinning { started_at, angle0 }, false) => {
                let dt = now.saturating_duration_since(started_at).as_secs_f32();
                let cur = (angle0 + PINWHEEL_OMEGA * dt) % std::f32::consts::TAU;
                self.phase = PinwheelPhase::Stopping {
                    stopped_at: now,
                    angle0: cur,
                };
            }
            (PinwheelPhase::Stopping { stopped_at, angle0 }, true) => {
                let cur = Self::sample_stopping(stopped_at, angle0, now).angle_rad;
                self.phase = PinwheelPhase::Spinning {
                    started_at: now,
                    angle0: cur,
                };
            }
            (PinwheelPhase::Resting { angle }, true) => {
                self.phase = PinwheelPhase::Spinning {
                    started_at: now,
                    angle0: angle,
                };
            }
            (PinwheelPhase::Stopping { .. } | PinwheelPhase::Resting { .. }, false) => {}
        }
    }

    fn sample_stopping(stopped_at: Instant, angle0: f32, now: Instant) -> PinwheelSample {
        let elapsed = now.saturating_duration_since(stopped_at).as_secs_f32();
        let decel_travel = 0.5 * PINWHEEL_OMEGA * PINWHEEL_SLOW_SECS; // -337.5°
        if elapsed < PINWHEEL_SLOW_SECS {
            let u = (elapsed / PINWHEEL_SLOW_SECS).clamp(0.0, 1.0);
            let progress = u * (2.0 - u);
            return PinwheelSample {
                angle_rad: angle0 + decel_travel * progress,
                hollow_alpha: 1.0,
                solid_alpha: 0.0,
                animating: true,
            };
        }
        let end_angle = angle0 + decel_travel;
        let fill_t = elapsed - PINWHEEL_SLOW_SECS;
        if fill_t < PINWHEEL_FILL_SECS {
            let u = (fill_t / PINWHEEL_FILL_SECS).clamp(0.0, 1.0);
            let s = u * u * (3.0 - 2.0 * u);
            return PinwheelSample {
                angle_rad: end_angle,
                hollow_alpha: 1.0 - s,
                solid_alpha: s,
                animating: true,
            };
        }
        PinwheelSample {
            angle_rad: end_angle,
            hollow_alpha: 0.0,
            solid_alpha: 1.0,
            animating: false,
        }
    }

    /// Where the pinwheel is at `now`. It turns under reduced motion too:
    /// like the loader and the thinking mark it says the Agent is still at
    /// work, so it is not one of the movements 关闭动态效果 stops.
    pub fn sample(&mut self, now: Instant) -> PinwheelSample {
        match self.phase {
            PinwheelPhase::Spinning { started_at, angle0 } => {
                let dt = now.saturating_duration_since(started_at).as_secs_f32();
                PinwheelSample {
                    angle_rad: (angle0 + PINWHEEL_OMEGA * dt) % std::f32::consts::TAU,
                    hollow_alpha: 1.0,
                    solid_alpha: 0.0,
                    animating: true,
                }
            }
            PinwheelPhase::Stopping { stopped_at, angle0 } => {
                let s = Self::sample_stopping(stopped_at, angle0, now);
                if !s.animating {
                    self.phase = PinwheelPhase::Resting { angle: s.angle_rad };
                }
                s
            }
            PinwheelPhase::Resting { angle } => PinwheelSample {
                angle_rad: angle,
                hollow_alpha: 0.0,
                solid_alpha: 1.0,
                animating: false,
            },
        }
    }
}

/// Renders the two-layer pinwheel (`Icon::Pinwheel` + `Icon::PinwheelSolid`)
/// from a [`PinwheelSample`].
pub fn pinwheel_element(sample: PinwheelSample, size_px: f32, color: Hsla, window: &Window) -> Div {
    if sample.animating {
        window.request_animation_frame();
    }
    let tf = Transformation::rotate(radians(sample.angle_rad));
    div()
        .size(px(size_px))
        .flex_none()
        .relative()
        .when_some(
            (sample.hollow_alpha > 0.001).then_some(sample.hollow_alpha),
            |d, a| {
                d.child(
                    icon(Icon::Pinwheel, size_px, color.opacity(a))
                        .absolute()
                        .top_0()
                        .left_0()
                        .with_transformation(tf),
                )
            },
        )
        .when_some(
            (sample.solid_alpha > 0.001).then_some(sample.solid_alpha),
            |d, a| {
                d.child(
                    icon(Icon::PinwheelSolid, size_px, color.opacity(a))
                        .absolute()
                        .top_0()
                        .left_0()
                        .with_transformation(tf),
                )
            },
        )
}

/// Two-bounce hop (`@keyframes hop1`, 0.55s) for `Icon::Shikigami` when
/// pointing at 「交给 Agent」 in a comment's hover card.
pub fn shikigami_hop_icon(
    size_px: f32,
    color: Hsla,
    hop_started: Option<Instant>,
    reduce_motion: bool,
    window: &Window,
) -> Svg {
    let (dy, rot_deg, active) = match hop_started.filter(|_| !reduce_motion) {
        Some(t0) => {
            let u = anim::now().saturating_duration_since(t0).as_secs_f32() / 0.55;
            if u >= 1.0 {
                (0.0, 0.0, false)
            } else if u < 0.25 {
                let k = u / 0.25;
                (-3.0 * k, -10.0 * k, true)
            } else if u < 0.50 {
                let k = 1.0 - (u - 0.25) / 0.25;
                (-3.0 * k, -10.0 * k, true)
            } else if u < 0.72 {
                let k = (u - 0.50) / 0.22;
                (-1.5 * k, 5.0 * k, true)
            } else {
                let k = 1.0 - (u - 0.72) / 0.28;
                (-1.5 * k, 5.0 * k, true)
            }
        }
        None => (0.0, 0.0, false),
    };
    if active {
        window.request_animation_frame();
    }
    let tf = Transformation::translate(point(px(0.0), px(dy)))
        .with_rotation(radians(rot_deg.to_radians()));
    icon(Icon::Shikigami, size_px, color).with_transformation(tf)
}

/// The kind of thing a [`KindMark`] stands for (materials.md, 「砂笔记号」).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// A round seal, one of six fixed by the chapter's id.
    Chapter(u8),
    /// A square seal.
    Element,
    /// A short dash.
    Storyline,
    /// A folded corner.
    Category,
    /// A small eddy; `loose` (not in a group) is fainter.
    Drift { loose: bool },
    /// A wave.
    DriftGroup,
    /// An upright slip.
    Material,
    /// The whole book: a blunt star in the accent.
    All,
    /// One character the author picked (`kernel-v5.md` §8): any single
    /// grapheme, emoji included, drawn as text in the mark's slot.
    Glyph(Glyph),
}

/// A character drawn as a mark. Interned, so a [`Kind`] stays `Copy`: an
/// author picks few of them, and each is kept for the life of the process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Glyph(u32);

static GLYPHS: std::sync::Mutex<Vec<SharedString>> = std::sync::Mutex::new(Vec::new());

impl Glyph {
    /// The glyph for `text` (one grapheme; the caller checks).
    pub fn new(text: &str) -> Glyph {
        let mut glyphs = GLYPHS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = glyphs.iter().position(|g| g.as_ref() == text) {
            return Glyph(i as u32);
        }
        glyphs.push(SharedString::from(text.to_owned()));
        Glyph((glyphs.len() - 1) as u32)
    }

    /// The character it draws.
    pub fn text(self) -> SharedString {
        GLYPHS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(self.0 as usize)
            .cloned()
            .unwrap_or_default()
    }
}

impl Kind {
    fn mask(self, hollow: bool) -> SandMask {
        use SandMask as M;
        match (self, hollow) {
            (Kind::Chapter(n), false) => {
                [M::Blob0, M::Blob1, M::Blob2, M::Blob3, M::Blob4, M::Blob5][n as usize % 6]
            }
            (Kind::Chapter(n), true) => [
                M::Blob0Hollow,
                M::Blob1Hollow,
                M::Blob2Hollow,
                M::Blob3Hollow,
                M::Blob4Hollow,
                M::Blob5Hollow,
            ][n as usize % 6],
            (Kind::Element, false) => M::MarkSquare,
            (Kind::Element, true) => M::MarkSquareHollow,
            (Kind::Storyline, false) => M::MarkDash,
            (Kind::Storyline, true) => M::MarkDashHollow,
            (Kind::Category, false) => M::MarkCorner,
            (Kind::Category, true) => M::MarkCornerHollow,
            (Kind::Drift { .. }, false) => M::MarkSpiral,
            (Kind::Drift { .. }, true) => M::MarkSpiralHollow,
            (Kind::DriftGroup, _) => M::MarkWave,
            (Kind::Material, false) => M::MarkSlip,
            (Kind::Material, true) => M::MarkSlipHollow,
            (Kind::All, false) => M::MarkStar,
            (Kind::All, true) => M::MarkStarHollow,
            // Drawn as text ([`paint_kind_mark`]); never asked for a mask.
            (Kind::Glyph(_), false) => M::MarkSquare,
            (Kind::Glyph(_), true) => M::MarkSquareHollow,
        }
    }

    /// Where the mark sits in its 14px slot: (left, top, width, height).
    fn placement(self) -> (f32, f32, f32, f32) {
        match self {
            Kind::Chapter(_) => (2.0, 2.0, 10.0, 10.0),
            Kind::Element => (2.5, 2.5, 9.0, 9.0),
            Kind::Storyline => (-1.0, 4.0, 16.0, 6.0),
            Kind::DriftGroup => (-1.0, 2.5, 16.0, 9.0),
            Kind::Category => (1.0, 1.0, 12.0, 12.0),
            Kind::Drift { .. } => (0.0, 1.5, 14.0, 11.0),
            Kind::Material => (4.0, 0.0, 6.0, 14.0),
            Kind::All | Kind::Glyph(_) => (0.0, 0.0, 14.0, 14.0),
        }
    }
}

/// The 14px slot a kind mark reserves.
pub const MARK_SLOT: f32 = 14.0;

/// How sand comes and goes: fades in on first paint, fades out when no
/// longer shown, shifts strength over 0.24s.
#[derive(Clone, Copy, Debug)]
pub struct Presence {
    pub level: Tween,
}

impl Presence {
    fn new() -> Presence {
        Presence {
            level: Tween::still(0.0),
        }
    }

    fn aim(&mut self, to: f32, reduce: bool) {
        let at = anim::now();
        let fading = self.level.to == 0.0 || to == 0.0;
        let d = if reduce {
            Duration::ZERO
        } else if fading {
            motion::sand::FADE
        } else {
            motion::sand::SHIFT
        };
        self.level.retarget(to, at, d, Easing::EASE_OUT);
    }
}

fn use_presence(
    id: ElementId,
    level: f32,
    theme: Theme,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Presence> {
    let presence = window.use_keyed_state(id, cx, |_, _| Presence::new());
    presence.update(cx, |p, _| p.aim(level, theme.reduce_motion));
    presence
}

/// The sand colour for `color` on the ground being painted.
pub fn sand_color(palette: &Palette, color: Rgb) -> Rgb {
    let ground = match current_ground() {
        Some(Ground::Flat { inside, .. }) => inside,
        _ => palette.desk,
    };
    palette.sand_on(color, ground)
}

/// A kind mark (`KindMark`): every thing that can open as a tab carries the
/// mark of its kind, in the same place in every list.
#[derive(IntoElement)]
pub struct KindMark {
    id: ElementId,
    kind: Kind,
    color: Option<Rgb>,
    hollow: bool,
    shown: bool,
    strength: f32,
    scale: f32,
}

impl KindMark {
    pub fn new(id: impl Into<ElementId>, kind: Kind) -> KindMark {
        KindMark {
            id: id.into(),
            kind,
            color: None,
            hollow: false,
            shown: true,
            strength: 1.0,
            scale: 1.0,
        }
    }

    /// The storyline's or category's colour; without one, neutral ink.
    pub fn color(mut self, color: Rgb) -> Self {
        self.color = Some(color);
        self
    }

    /// Hollow: only the sand along the edge (a preview tab).
    pub fn hollow(mut self, hollow: bool) -> Self {
        self.hollow = hollow;
        self
    }

    /// Fades the mark out (and back in) instead of dropping it.
    pub fn shown(mut self, shown: bool) -> Self {
        self.shown = shown;
        self
    }

    /// 0–1 of its usual strength (an empty count, a closed chip).
    pub fn strength(mut self, strength: f32) -> Self {
        self.strength = strength;
        self
    }

    /// Draws the 14px slot at another size (an empty state's big mark).
    pub fn scale(mut self, scale: f32) -> Self {
        self.scale = scale;
        self
    }
}

impl RenderOnce for KindMark {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let palette = theme.palette;
        let presence = use_presence(
            self.id.clone(),
            if self.shown { self.strength } else { 0.0 },
            theme,
            window,
            cx,
        );
        let k = self.scale;
        let kind = self.kind;
        let color = self.color;
        let hollow = self.hollow;
        let slot = MARK_SLOT * k;
        div().size(px(slot)).flex_none().relative().child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    let now = anim::now();
                    let p = presence.read(cx);
                    let level = p.level.value(now);
                    anim::keep_going(!p.level.settled(now), window);
                    // Arriving sand grows from 0.8× as it fades in (sand-arrive).
                    let grow = 0.8 + 0.2 * level.min(1.0);
                    let look = MarkLook {
                        kind,
                        color,
                        hollow,
                        level,
                        stretch: (grow, grow),
                    };
                    paint_kind_mark(bounds, k, look, palette, window, cx);
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }
}

/// How a kind mark is drawn at one moment.
#[derive(Clone, Copy, Debug)]
pub struct MarkLook {
    pub kind: Kind,
    pub color: Option<Rgb>,
    pub hollow: bool,
    /// 0–1 of its strength (fading in or out).
    pub level: f32,
    /// How much wider and taller than its slot it is drawn, about its
    /// centre (arriving sand starts at 0.8; spreading sand ends at 2.8 × 1.6).
    pub stretch: (f32, f32),
}

/// Paints a kind mark into its slot at `bounds` (the 14px slot times
/// `scale`), during paint: [`KindMark`]'s drawing, for marks that move on
/// their own (the one a dock pill grew from, spreading away).
pub fn paint_kind_mark(
    bounds: Bounds<Pixels>,
    scale: f32,
    look: MarkLook,
    palette: &Palette,
    window: &mut Window,
    cx: &mut App,
) {
    if look.level <= 0.003 {
        return;
    }
    let pigment = match look.kind {
        Kind::All => 1.0,
        Kind::Drift { loose: true } => 0.55 * palette.pigment,
        _ => palette.pigment,
    };
    let tint = match (look.kind, look.color) {
        (Kind::All, _) => palette.accent,
        (_, Some(c)) => sand_color(palette, c),
        (_, None) => sand_color(palette, palette.ink(3)),
    };
    if let Kind::Glyph(glyph) = look.kind {
        paint_glyph(bounds, scale, glyph, &look, palette, window, cx);
        return;
    }
    let mask = look.kind.mask(look.hollow);
    let (l, t, w, h) = look.kind.placement();
    let k = scale;
    let (bw, bh) = (w * k * look.stretch.0, h * k * look.stretch.1);
    let cx_ = l * k + w * k / 2.0;
    let cy_ = t * k + h * k / 2.0;
    let at = Bounds {
        origin: bounds.origin + point(px(cx_ - bw / 2.0), px(cy_ - bh / 2.0)),
        size: size(px(bw), px(bh)),
    };
    let _ = window.paint_svg(
        at,
        mask.shared_path(),
        None,
        TransformationMatrix::unit(),
        tint.alpha(pigment * look.level),
        cx,
    );
}

/// The character of a [`Kind::Glyph`] centred in its slot, in the mark's
/// ink (the entry's colour when it has one); a preview tab's hollow mark is
/// fainter.
fn paint_glyph(
    bounds: Bounds<Pixels>,
    scale: f32,
    glyph: Glyph,
    look: &MarkLook,
    palette: &Palette,
    window: &mut Window,
    cx: &mut App,
) {
    let text = glyph.text();
    if text.is_empty() {
        return;
    }
    let tint = match look.color {
        Some(c) => sand_color(palette, c),
        None => palette.ink(2),
    };
    let alpha = look.level * if look.hollow { 0.55 } else { 1.0 };
    let font_size = px(GLYPH_SIZE * scale * look.stretch.1);
    let run = TextRun {
        len: text.len(),
        font: crate::fonts::Role::Ui.font(crate::fonts::weight::REGULAR),
        color: tint.alpha(alpha),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = window
        .text_system()
        .shape_line(text, font_size, &[run], None);
    let slot = MARK_SLOT * scale;
    let line_height = font_size * 1.2;
    let origin = bounds.origin
        + point(
            (px(slot) - line.width()) / 2.0,
            (px(slot) - line_height) / 2.0,
        );
    let _ = line.paint(origin, line_height, TextAlign::Left, None, window, cx);
}

/// The size a [`Kind::Glyph`]'s character is drawn at in the 14px slot.
pub const GLYPH_SIZE: f32 = 12.0;

/// A sand mask laid in `bounds` in `color` at `alpha`, during paint.
pub fn paint_mask(
    mask: SandMask,
    bounds: Bounds<Pixels>,
    color: Hsla,
    window: &mut Window,
    cx: &App,
) {
    let _ = window.paint_svg(
        bounds,
        mask.shared_path(),
        None,
        TransformationMatrix::unit(),
        color,
        cx,
    );
}

/// The brush frame round a selected cell (`SandFrame`). Each new selection
/// is a new stroke drawn along its path from the mark over 0.38s; a frame
/// already selected when it first renders shows at once. When the
/// selection moves on the frame fades out whole (0.3s).
///
/// A frame can also stay at rest, faint, while it is not selected (a
/// region comment on a picture, M19: [`SandFrame::rest`]), and keep one
/// stroke for good ([`SandFrame::seed`]); it fades between its rest
/// levels and is drawn round again each time it is selected.
#[derive(IntoElement)]
pub struct SandFrame {
    id: ElementId,
    selected: bool,
    color: Option<Rgb>,
    rest: f32,
    seed: Option<u32>,
}

impl SandFrame {
    pub fn new(id: impl Into<ElementId>, selected: bool) -> SandFrame {
        SandFrame {
            id: id.into(),
            selected,
            color: None,
            rest: 0.0,
            seed: None,
        }
    }

    pub fn color(mut self, color: Rgb) -> Self {
        self.color = Some(color);
        self
    }

    /// How strong the frame stays while it is not selected (0–1; 0, the
    /// default, is gone).
    pub fn rest(mut self, rest: f32) -> Self {
        self.rest = rest.clamp(0.0, 1.0);
        self
    }

    /// The stroke's seed: the same stroke every time it is drawn.
    pub fn seed(mut self, seed: u32) -> Self {
        self.seed = Some(seed);
        self
    }
}

/// How far the frame's canvas reaches beyond the cell (`.cell-frame`):
/// 7px each side, 6px above and below.
const FRAME_OUT: (f32, f32) = (7.0, 6.0);
const FRAME_DRAW_DELAY: Duration = Duration::from_millis(60);

pub struct FrameState {
    selected: bool,
    rest: f32,
    fixed: Option<u32>,
    seed: u32,
    began: Option<Instant>,
    fade: Tween,
    nominal_w: Option<f32>,
    cache: Option<FrameCache>,
}

struct FrameCache {
    key: (u32, u32, u32, u32),
    stroke: stroke::Stroke,
    image: Option<(u32, u32, [u8; 3], Arc<RenderImage>)>,
}

fn new_seed() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(Instant::now().elapsed().as_nanos());
    h.finish() as u32
}

impl FrameState {
    fn new(selected: bool, rest: f32, fixed: Option<u32>) -> FrameState {
        FrameState {
            selected,
            rest,
            fixed,
            seed: fixed.unwrap_or_else(new_seed),
            // Already selected on first render: shown drawn, no stroke.
            began: None,
            fade: Tween::still(if selected { 1.0 } else { rest }),
            nominal_w: None,
            cache: None,
        }
    }

    fn select(&mut self, selected: bool, rest: f32, reduce: bool) {
        let at = anim::now();
        let d = if reduce {
            Duration::ZERO
        } else {
            motion::sand::FADE
        };
        if selected == self.selected {
            // Resting at another strength (pointed at, resolved).
            if !selected && rest != self.rest {
                self.rest = rest;
                self.fade.retarget(rest, at, d, Easing::EASE_OUT);
            }
            return;
        }
        self.selected = selected;
        self.rest = rest;
        if selected {
            self.seed = self.fixed.unwrap_or_else(new_seed);
            self.nominal_w = None;
            self.began = (!reduce).then_some(at);
            self.fade.set(1.0);
        } else {
            self.fade.retarget(rest, at, d, Easing::EASE_OUT);
        }
    }

    fn progress(&self, at: Instant) -> f32 {
        match self.began {
            None => 1.0,
            Some(began) => {
                let t = (at.saturating_duration_since(began + FRAME_DRAW_DELAY)).as_secs_f32()
                    / motion::sand::DRAW.as_secs_f32();
                motion::sand::drawn_at(t)
            }
        }
    }
}

impl RenderOnce for SandFrame {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let palette = theme.palette;
        let (selected, rest, fixed) = (self.selected, self.rest, self.seed);
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| {
            FrameState::new(selected, rest, fixed)
        });
        state.update(cx, |s, _| s.select(selected, rest, theme.reduce_motion));
        let color = self.color.unwrap_or(palette.ink(3));
        let (ox, oy) = FRAME_OUT;
        div()
            .absolute()
            .top(px(-oy))
            .left(px(-ox))
            .right(px(-ox))
            .bottom(px(-oy))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, cx| {
                        let now = anim::now();
                        let scale = window.scale_factor();
                        let ground = match current_ground() {
                            Some(Ground::Flat { inside, .. }) => inside,
                            _ => palette.desk,
                        };
                        let rgb = palette.sand_on(color, ground).to_u8();
                        state.update(cx, |s, _| {
                            let fade = s.fade.value(now);
                            let progress = s.progress(now);
                            let moving = progress < 1.0 || !s.fade.settled(now);
                            anim::keep_going(moving, window);
                            if fade <= 0.003 {
                                if let Some(old) = s.cache.take().and_then(|c| c.image) {
                                    let _ = window.drop_image(old.3);
                                }
                                return;
                            }
                            let w = f32::from(bounds.size.width) - stroke::PAD * 2.0;
                            let h = f32::from(bounds.size.height) - stroke::PAD * 2.0;
                            if w <= 0.0 || h <= 0.0 {
                                return;
                            }
                            let nominal = *s.nominal_w.get_or_insert(w);
                            let key = (
                                (w * 4.0) as u32,
                                (h * 4.0) as u32,
                                (scale * 100.0) as u32,
                                s.seed,
                            );
                            if s.cache.as_ref().is_none_or(|c| c.key != key) {
                                if let Some(old) = s.cache.take().and_then(|c| c.image) {
                                    let _ = window.drop_image(old.3);
                                }
                                s.cache = Some(FrameCache {
                                    key,
                                    stroke: stroke::draw(w, h, scale, s.seed, nominal),
                                    image: None,
                                });
                            }
                            let cache = s.cache.as_mut().expect("just filled");
                            // GPUI cannot fade an image, so the fade is baked
                            // in, in 32 steps, like the 64 steps of the draw.
                            let step = (progress * 64.0).round() as u32;
                            let shade = (fade * 32.0).round() as u32;
                            let fresh = cache.image.as_ref().is_none_or(|(st, sh, c, _)| {
                                *st != step || *sh != shade || *c != rgb
                            });
                            if fresh {
                                let image = cache.stroke.paint(
                                    rgb,
                                    step as f32 / 64.0,
                                    shade as f32 / 32.0 * palette.pigment,
                                );
                                let render = Arc::new(RenderImage::new(SmallVec::from_elem(
                                    Frame::new(image),
                                    1,
                                )));
                                if let Some(old) = cache.image.replace((step, shade, rgb, render)) {
                                    let _ = window.drop_image(old.3);
                                }
                            }
                            let image = cache.image.as_ref().expect("just painted").3.clone();
                            let at = Bounds {
                                origin: bounds.origin,
                                size: size(
                                    px(cache.stroke.width as f32 / scale),
                                    px(cache.stroke.height as f32 / scale),
                                ),
                            };
                            let _ = window.paint_image(
                                at,
                                at,
                                gpui::Corners::default(),
                                image,
                                0,
                                false,
                            );
                        });
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
    }
}

/// One value drawn as a dry stroke (`.sand-stroke`, the stats panel's
/// bars): the dry underline at its own proportions, cut from its start on a
/// short value and stretched on a long one; the last 12px thin out.
#[derive(IntoElement)]
pub struct Readout {
    id: ElementId,
    /// 0–1 of the track.
    value: f32,
    color: Option<Rgb>,
    height: f32,
    track: bool,
}

impl Readout {
    pub fn new(id: impl Into<ElementId>, value: f32) -> Readout {
        Readout {
            id: id.into(),
            value,
            color: None,
            height: 7.0,
            track: true,
        }
    }

    pub fn color(mut self, color: Rgb) -> Self {
        self.color = Some(color);
        self
    }

    /// Without the loose grains under the rest of the track.
    pub fn bare(mut self) -> Self {
        self.track = false;
        self
    }

    /// The stroke's height (7 by default; the chapter-length rhythm's
    /// strokes are 4).
    pub fn height(mut self, height: f32) -> Self {
        self.height = height.max(1.0);
        self
    }
}

pub struct ReadoutState {
    value: Tween,
    fade: Tween,
}

impl RenderOnce for Readout {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let palette = theme.palette;
        let reduce = theme.reduce_motion;
        let target = self.value.clamp(0.0, 1.0);
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| ReadoutState {
            value: Tween::still(target),
            fade: Tween::still(0.0),
        });
        state.update(cx, |s, _| {
            let at = anim::now();
            let d = |d: Duration| if reduce { Duration::ZERO } else { d };
            s.value
                .retarget(target, at, d(motion::sand::READOUT_SLIDE), Easing::EASE);
            s.fade
                .retarget(1.0, at, d(motion::sand::READOUT_IN), Easing::EASE_OUT);
        });
        let color = self.color.unwrap_or(palette.ink(2));
        let height = self.height;
        let track = self.track;
        div().w_full().h(px(height)).relative().child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    let now = anim::now();
                    let s = state.read(cx);
                    let value = s.value.value(now);
                    let fade = s.fade.value(now);
                    anim::keep_going(!s.value.settled(now) || !s.fade.settled(now), window);
                    let full_w = f32::from(bounds.size.width);
                    if track {
                        let tint = sand_color(palette, palette.ink(3));
                        paint_loose(bounds, tint.alpha(palette.pigment * 0.4), window);
                    }
                    let w = full_w * value;
                    if w <= 0.5 {
                        return;
                    }
                    // The stroke at its own proportions (720 × 26), cut from
                    // its start; a long value stretches the whole stroke.
                    let natural = height * (720.0 / 26.0);
                    let stroke_w = natural.max(w);
                    let tint = sand_color(palette, color).alpha(palette.pigment * fade);
                    let clip = Bounds {
                        origin: bounds.origin,
                        size: size(px(w), bounds.size.height),
                    };
                    window.with_content_mask(Some(gpui::ContentMask { bounds: clip }), |window| {
                        paint_mask(
                            SandMask::Ul,
                            Bounds {
                                origin: bounds.origin,
                                size: size(px(stroke_w), px(height)),
                            },
                            tint,
                            window,
                            cx,
                        );
                    });
                    // The last 12px thin out: the ground laid back over them.
                    let ground = match current_ground() {
                        Some(Ground::Flat { inside, .. }) => inside,
                        _ => palette.desk,
                    };
                    let tail = 12.0f32.min(w);
                    for i in 0..6 {
                        let k = (i as f32 + 0.5) / 6.0;
                        let x = w - tail + tail * i as f32 / 6.0;
                        window.paint_quad(gpui::fill(
                            Bounds {
                                origin: bounds.origin + point(px(x), px(0.0)),
                                size: size(px(tail / 6.0 + 0.5), px(height)),
                            },
                            ground.alpha(k * 0.9),
                        ));
                    }
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }
}

/// Loose grains along a track: a dotted line of sand.
fn paint_loose(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let mut x = 1.0;
    let mut i = 0u32;
    while x < w {
        let jitter = ((i.wrapping_mul(2_654_435_761) >> 16) % 5) as f32 / 5.0;
        let y = h * (0.3 + 0.4 * jitter);
        window.paint_quad(
            gpui::fill(
                Bounds {
                    origin: bounds.origin + point(px(x), px(y)),
                    size: size(px(1.2), px(1.2)),
                },
                color,
            )
            .corner_radii(px(0.6)),
        );
        x += 6.0;
        i += 1;
    }
}

/// A dry comment underline (`SandMask::Ul` in `palette.comment`, `.sand-ul` in
/// the review prototype): `6px` at rest (`0.85`), `7px` and full pigment when
/// `hot` (pointed at or its Review card hovered), and wiped left-to-right over
/// `0.38s` whenever `replay` increments (jumping from Review's arrow).
#[derive(IntoElement)]
pub struct CommentUnderline {
    id: ElementId,
    hot: bool,
    replay: u64,
}

impl CommentUnderline {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            hot: false,
            replay: 0,
        }
    }

    pub fn hot(mut self, hot: bool) -> Self {
        self.hot = hot;
        self
    }

    pub fn replay(mut self, replay: u64) -> Self {
        self.replay = replay;
        self
    }
}

pub struct CommentUnderlineState {
    hot: Tween,
    wipe: Tween,
    replay: u64,
}

impl RenderOnce for CommentUnderline {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let palette = theme.palette;
        let reduce = theme.reduce_motion;
        let target_hot = if self.hot { 1.0 } else { 0.0 };
        let replay = self.replay;
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| CommentUnderlineState {
            hot: Tween::still(target_hot),
            wipe: Tween::still(1.0),
            replay,
        });
        state.update(cx, |s, _| {
            let at = anim::now();
            let d = |ms: u64| {
                if reduce {
                    Duration::ZERO
                } else {
                    Duration::from_millis(ms)
                }
            };
            s.hot.retarget(target_hot, at, d(140), Easing::EASE_OUT);
            if s.replay != replay {
                s.replay = replay;
                s.wipe = Tween::still(if reduce { 1.0 } else { 0.0 });
                s.wipe.retarget(1.0, at, d(380), Easing::EASE_OUT);
            }
        });
        div().w_full().h(px(7.0)).relative().child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    let now = anim::now();
                    let s = state.read(cx);
                    let hot = s.hot.value(now);
                    let wipe = s.wipe.value(now);
                    anim::keep_going(!s.hot.settled(now) || !s.wipe.settled(now), window);
                    let full_w = (f32::from(bounds.size.width) + 2.0).max(0.0);
                    let w = full_w * wipe;
                    if w <= 0.5 {
                        return;
                    }
                    let h = 6.0 + hot;
                    let alpha = palette.pigment * (0.85 + 0.15 * hot);
                    let tint = sand_color(palette, palette.comment).alpha(alpha);
                    let clip = Bounds {
                        origin: bounds.origin - point(px(1.0), px(0.0)),
                        size: size(px(w), px(7.0)),
                    };
                    window.with_content_mask(Some(gpui::ContentMask { bounds: clip }), |w_in| {
                        paint_mask(
                            SandMask::Ul,
                            Bounds {
                                origin: bounds.origin - point(px(1.0), px(0.0)),
                                size: size(px(full_w), px(h)),
                            },
                            tint,
                            w_in,
                            cx,
                        );
                    });
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }
}

/// A small sand seal dot (`SandMask::Blob2` in `palette.comment`, no count) for
/// the corner of a commented file's thumbnail.
pub fn comment_dot(size_px: f32, hot: bool, palette: &Palette) -> Svg {
    let alpha = palette.pigment * if hot { 1.0 } else { 0.9 };
    let tint = sand_color(palette, palette.comment).alpha(alpha);
    svg()
        .path(SandMask::Blob2.shared_path())
        .size(px(size_px))
        .flex_none()
        .text_color(tint)
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    #[test]
    fn a_resting_frame_stays_faint_and_keeps_its_stroke() {
        let now = anim::now;
        let near = |a: f32, b: f32| (a - b).abs() < 1e-4;
        let mut s = FrameState::new(false, 0.5, Some(7));
        assert!(s.seed == 7 && near(s.fade.value(now()), 0.5));
        // Chosen (reduced motion: no draw-in): full, the same stroke.
        s.select(true, 0.5, true);
        assert!(s.seed == 7 && near(s.fade.value(now()), 1.0));
        // Let go, pointed at, resolved: its rest levels.
        s.select(false, 0.8, true);
        assert!(near(s.fade.value(now()), 0.8));
        s.select(false, 0.28, true);
        assert!(near(s.fade.value(now()), 0.28));
        // Without a rest level a frame fades out as before.
        let mut plain = FrameState::new(true, 0.0, None);
        plain.select(false, 0.0, true);
        assert!(near(plain.fade.value(now()), 0.0));
    }

    #[test]
    fn thinking_steps_sixty_eight_frames_and_rests_on_mountain() {
        assert_eq!(THINKING_FRAMES, 68);
        assert_eq!(THINKING_STILL_FRAME, 56);
        assert_eq!(thinking_frame(0, false), 56);
        assert_eq!(thinking_frame(99_999, false), 56);
        assert_eq!(thinking_frame(0, true), 0);
        assert_eq!(thinking_frame(124, true), 0);
        assert_eq!(thinking_frame(125, true), 1);
        assert_eq!(thinking_frame(56 * 125, true), 56);
        assert_eq!(thinking_frame(67 * 125, true), 67);
        assert_eq!(thinking_frame(68 * 125, true), 0);
    }

    #[test]
    fn pinwheel_spins_ccw_decelerates_three_seconds_then_fades_to_solid() {
        let t0 = Instant::now();
        let mut pw = PinwheelTrack::spinning(t0);

        let s0 = pw.sample(t0);
        assert!((s0.angle_rad - 0.0).abs() < 1e-5);
        assert_eq!(
            (s0.hollow_alpha, s0.solid_alpha, s0.animating),
            (1.0, 0.0, true)
        );

        // Half a turn in 0.8s counter-clockwise (-PI).
        let s_half = pw.sample(t0 + Duration::from_millis(800));
        assert!((s_half.angle_rad + std::f32::consts::PI).abs() < 1e-3);
        assert_eq!((s_half.hollow_alpha, s_half.solid_alpha), (1.0, 0.0));

        // Finish at 0.8s: uniform deceleration over 3.0s travels -337.5° more.
        let t_done = t0 + Duration::from_millis(800);
        pw.sync(false, t_done);

        let mid_slow = pw.sample(t_done + Duration::from_millis(1500));
        assert!(mid_slow.angle_rad < s_half.angle_rad);
        assert_eq!(
            (
                mid_slow.hollow_alpha,
                mid_slow.solid_alpha,
                mid_slow.animating
            ),
            (1.0, 0.0, true)
        );

        let at_stop = pw.sample(t_done + Duration::from_secs(3));
        let expected_end = -std::f32::consts::PI - 337.5_f32.to_radians();
        assert!((at_stop.angle_rad - expected_end).abs() < 1e-3);
        assert!((at_stop.hollow_alpha - 1.0).abs() < 1e-4);
        assert!((at_stop.solid_alpha - 0.0).abs() < 1e-4);

        // Halfway through the 0.6s fill cross-fade: both hollow and solid at 0.5, same stopped angle.
        let mid_fill = pw.sample(t_done + Duration::from_millis(3300));
        assert!((mid_fill.angle_rad - expected_end).abs() < 1e-3);
        assert!((mid_fill.hollow_alpha - 0.5).abs() < 1e-3);
        assert!((mid_fill.solid_alpha - 0.5).abs() < 1e-3);
        assert!(mid_fill.animating);

        // Settled solid after 3.6s.
        let settled = pw.sample(t_done + Duration::from_millis(3650));
        assert!((settled.angle_rad - expected_end).abs() < 1e-3);
        assert_eq!(
            (settled.hollow_alpha, settled.solid_alpha, settled.animating),
            (0.0, 1.0, false)
        );

        // Handed off again: resumes spinning hollow from its resting angle.
        let t_again = t_done + Duration::from_secs(5);
        pw.sync(true, t_again);
        let resumed = pw.sample(t_again);
        assert_eq!(
            (resumed.hollow_alpha, resumed.solid_alpha, resumed.animating),
            (1.0, 0.0, true)
        );
    }
}

#[cfg(test)]
mod glyph_tests {
    use super::*;

    #[test]
    fn a_glyph_is_interned_and_keeps_its_character() {
        let a = Glyph::new("岬");
        let b = Glyph::new("🌊");
        assert_ne!(a, b);
        assert_eq!(Glyph::new("岬"), a, "the same character is the same glyph");
        assert_eq!(a.text().as_ref(), "岬");
        assert_eq!(b.text().as_ref(), "🌊");
        // A glyph mark is its own kind, and two marks of one character match.
        assert_eq!(Kind::Glyph(a), Kind::Glyph(Glyph::new("岬")));
        assert_ne!(Kind::Glyph(a), Kind::Element);
    }
}
