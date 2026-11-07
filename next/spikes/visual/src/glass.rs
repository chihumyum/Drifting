//! 素玻璃 without a backdrop blur: three ways to draw the renderer's glass rim
//! (`src/styles/materials.css`, `.glass::before`) with what GPUI has.
//!
//! The rim in the renderer is two inset box-shadows (a 1px ring over a bleed
//! of `--glass-rim` px) in `--glass-cc`, at `--glass-edge` 33% × 1.8 × the
//! strength, masked by the tiled texture `glass-thick.png` (150px tiles)
//! whose position flows 150px diagonally in 15s while the pointer is on it.
//!
//! - [`Plan::Bake`] (甲): the CPU computes that rim pixel for pixel, mask and
//!   all, into a bitmap per control; a flowing or animating control is baked
//!   again each frame.
//! - [`Plan::Cover`] (乙): the GPU draws the texture tinted (an SVG wrapping
//!   the PNG, so GPUI treats it as a monochrome sprite), then covers its
//!   middle with the ground colour so only the rim stays; flowing moves the
//!   sprites. Needs a known flat ground under and around the control.
//! - [`Plan::Flat`] (丙): GPUI primitives only. A uniform 1px border and an
//!   inset shadow, at the texture's mean strength; flowing turns the shadow's
//!   offset slowly round.

use std::{
    cell::RefCell,
    collections::HashMap,
    hash::{Hash, Hasher},
    rc::Rc,
    sync::Arc,
    time::Instant,
};

use gpui::{
    App, BorderStyle, Bounds, BoxShadow, ContentMask, Corners, Pixels, RenderImage,
    TransformationMatrix, Window, point, px, quad, size, transparent_black,
};
use image::{Frame, RgbaImage};
use smallvec::SmallVec;

use crate::{
    assets::{GLASS_TILE_PATH, Mask},
    theme::Rgb,
};

/// `--glass-edge` 33% × 1.8: the ring's alpha at strength 1.
pub const GLASS_EDGE: f32 = 0.594;
/// The texture tile, in logical px (`mask-size: 150px 150px`).
pub const TILE: f32 = 150.0;
/// How fast the texture travels while the glass flows: one tile in 15s.
pub const FLOW_PX_PER_S: f32 = TILE / 15.0;
/// The four sampling origins siblings rotate through, and the dense patch.
pub const SAMPLE_ORIGINS: [(f32, f32); 4] = [
    (-14.0, -46.0),
    (-96.0, -132.0),
    (-168.0, -18.0),
    (-58.0, -186.0),
];
pub const DENSE: (f32, f32) = (-96.0, -132.0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Plan {
    Bake,
    Cover,
    Flat,
}

impl Plan {
    pub const ALL: [Plan; 3] = [Plan::Bake, Plan::Cover, Plan::Flat];

    pub fn label(self) -> &'static str {
        match self {
            Plan::Bake => "甲",
            Plan::Cover => "乙",
            Plan::Flat => "丙",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Plan::Bake => "a-bake",
            Plan::Cover => "b-cover",
            Plan::Flat => "c-flat",
        }
    }

    /// How much of the ground a floating slab (the paper's toolbar, a Dock
    /// pill, a floating sidebar toggle) lets through. The renderer uses 80%
    /// of the page plus a 1.6px backdrop blur.
    pub fn floating_fill(self) -> f32 {
        match self {
            Plan::Bake => 0.84,
            Plan::Cover => 1.0,
            Plan::Flat => 0.92,
        }
    }
}

/// Everything about one rim at one moment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// The rim's visibility (the pseudo-element's opacity), 0–1.
    pub opacity: f32,
    /// `--glass-g`: strength.
    pub g: f32,
    /// `--glass-sp`: bleed multiplier.
    pub sp: f32,
    /// How far the texture has flowed, logical px along the diagonal.
    pub flow: f32,
    /// `--glass-rim`, logical px.
    pub rim: f32,
    /// Sampling origin on the texture (`--glass-gx`, `--glass-gy`).
    pub origin: (f32, f32),
    /// `--glass-cc`.
    pub color: Rgb,
}

impl Look {
    pub fn new(color: Rgb, origin: (f32, f32)) -> Look {
        Look {
            opacity: 1.0,
            g: 1.0,
            sp: 1.0,
            flow: 0.0,
            rim: 9.0,
            origin,
            color,
        }
    }
}

/// What lies under and around the glass, for the plans that need to know.
#[derive(Clone, Copy, Debug)]
pub struct Ground {
    /// The flat colour inside the control (what shows through it).
    pub inside: Rgb,
    /// The flat colour round it (for the rounded corners).
    pub outside: Rgb,
    /// `--glass-bleed-lift`.
    pub bleed_lift: f32,
}

fn erfc(x: f32) -> f32 {
    // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * z);
    let y = t
        * (0.254_829_6
            + t * (-0.284_496_74 + t * (1.421_413_7 + t * (-1.453_152_1 + t * 1.061_405_4))))
        * (-z * z).exp();
    if x >= 0.0 { y } else { 2.0 - y }
}

/// The renderer's rim before the texture cuts it, at `depth` px inside the
/// edge: (ring alpha, bleed alpha), each 0–1.
pub fn rim_profile(depth: f32, look: &Look, pixel: f32) -> (f32, f32) {
    let a = (GLASS_EDGE * look.g).min(1.0);
    let ring = a * ((1.0 - depth) / pixel + 0.5).clamp(0.0, 1.0);
    let bleed = if look.sp > 0.0 {
        let sigma = look.rim * look.sp / 2.0;
        a * 0.5 * erfc((depth - look.sp) / (sigma * std::f32::consts::SQRT_2))
    } else {
        0.0
    };
    (ring, bleed)
}

/// Signed distance from `p` to a rounded rectangle's edge, negative inside.
fn rounded_rect_sdf(px_: f32, py_: f32, w: f32, h: f32, r: f32) -> f32 {
    let qx = (px_ - w / 2.0).abs() - w / 2.0 + r;
    let qy = (py_ - h / 2.0).abs() - h / 2.0 + r;
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - r
}

/// 甲: the renderer's rim, pixel for pixel, as a straight-alpha BGRA bitmap
/// `scale` device px per logical px. `texture` is `glass-thick.png`.
pub fn bake_rim(
    w: f32,
    h: f32,
    radius: f32,
    scale: f32,
    look: &Look,
    bleed_lift: f32,
    texture: &Mask,
) -> RgbaImage {
    let pw = (w * scale).ceil().max(1.0) as u32;
    let ph = (h * scale).ceil().max(1.0) as u32;
    let r = radius.min(w / 2.0).min(h / 2.0);
    let ring_c = look.color;
    let bleed_c = look.color.mix(Rgb::WHITE, bleed_lift);
    let tex_scale = texture.width as f32 / TILE;
    let (ox, oy) = (look.origin.0 + look.flow, look.origin.1 + look.flow);
    let pixel = 1.0 / scale;
    let reach = look.rim * look.sp.max(0.0) * 1.6 + 2.0;
    let ring_rgb = ring_c.to_u8();
    let mut image = RgbaImage::new(pw, ph);
    for y in 0..ph {
        let ly = (y as f32 + 0.5) * pixel;
        for x in 0..pw {
            let lx = (x as f32 + 0.5) * pixel;
            let depth = -rounded_rect_sdf(lx, ly, w, h, r);
            let cover = (depth / pixel + 0.5).clamp(0.0, 1.0);
            if cover <= 0.0 || depth > reach {
                continue;
            }
            let (ring, bleed) = rim_profile(depth, look, pixel);
            let alpha = ring + bleed * (1.0 - ring);
            if alpha <= 0.002 {
                continue;
            }
            let t = texture.sample_wrapped((lx - ox) * tex_scale, (ly - oy) * tex_scale);
            let a = alpha * t * cover * look.opacity;
            if a <= 0.002 {
                continue;
            }
            let rgb = if bleed_lift > 0.0 && bleed > 0.0 {
                let wr = ring / alpha;
                ring_c.mix(bleed_c, 1.0 - wr).to_u8()
            } else {
                ring_rgb
            };
            // GPUI's RenderImage is BGRA, straight alpha.
            image.put_pixel(
                x,
                y,
                image::Rgba([rgb[2], rgb[1], rgb[0], (a * 255.0 + 0.5) as u8]),
            );
        }
    }
    image
}

pub fn render_image(image: RgbaImage) -> Arc<RenderImage> {
    Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(image), 1)))
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct BakeKey {
    w: u32,
    h: u32,
    r: u32,
    scale: u32,
    opacity: u16,
    g: u16,
    sp: u16,
    flow: i32,
    rim: u16,
    origin: (i32, i32),
    color: [u8; 3],
    lift: u16,
}

/// Timings of the bakes, for the conclusion.
#[derive(Default, Clone, Debug)]
pub struct BakeStats {
    pub bakes: u64,
    pub total_ms: f64,
    pub max_ms: f64,
    /// Bytes of the baked rims alive now.
    pub live_bytes: usize,
    /// Logical size of the last bake, and its time.
    pub last: Option<(f32, f32, f64)>,
}

/// 甲's bitmaps: one per control, re-baked when its look changes.
#[derive(Default)]
pub struct BakeCache {
    entries: HashMap<u64, (BakeKey, Arc<RenderImage>, usize)>,
    pub stats: BakeStats,
}

impl BakeCache {
    #[expect(clippy::too_many_arguments, reason = "the rim's whole description")]
    fn image(
        &mut self,
        id: u64,
        bounds: Bounds<Pixels>,
        radius: f32,
        look: &Look,
        ground: &Ground,
        texture: &Mask,
        window: &mut Window,
    ) -> Arc<RenderImage> {
        let scale = window.scale_factor();
        let w = f32::from(bounds.size.width);
        let h = f32::from(bounds.size.height);
        let q = |v: f32| (v * 256.0).round() as u16;
        let key = BakeKey {
            w: (w * 4.0).round() as u32,
            h: (h * 4.0).round() as u32,
            r: (radius * 4.0).round() as u32,
            scale: (scale * 100.0) as u32,
            opacity: q(look.opacity),
            g: q(look.g),
            sp: q(look.sp),
            // A step of half a device pixel is as fine as a flow can show.
            flow: (look.flow * scale * 2.0).round() as i32,
            rim: q(look.rim),
            origin: (look.origin.0 as i32, look.origin.1 as i32),
            color: look.color.to_u8(),
            lift: q(ground.bleed_lift),
        };
        if let Some((old_key, image, _)) = self.entries.get(&id)
            && *old_key == key
        {
            return image.clone();
        }
        let started = Instant::now();
        let flow = key.flow as f32 / (scale * 2.0);
        let baked = bake_rim(
            w,
            h,
            radius,
            scale,
            &Look { flow, ..*look },
            ground.bleed_lift,
            texture,
        );
        let bytes = baked.as_raw().len();
        let image = render_image(baked);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        self.stats.bakes += 1;
        self.stats.total_ms += ms;
        self.stats.max_ms = self.stats.max_ms.max(ms);
        self.stats.last = Some((w, h, ms));
        if let Some((_, old, old_bytes)) = self.entries.insert(id, (key, image.clone(), bytes)) {
            self.stats.live_bytes -= old_bytes;
            let _ = window.drop_image(old);
        }
        self.stats.live_bytes += bytes;
        image
    }
}

pub type SharedBakes = Rc<RefCell<BakeCache>>;

pub fn control_id(name: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    hasher.finish()
}

/// What a plan needs to draw.
#[derive(Clone)]
pub struct Painter {
    pub plan: Plan,
    pub texture: Arc<Mask>,
    /// The texture's mean alpha: 丙 draws its uniform rim at this share.
    pub texture_mean: f32,
    pub bakes: SharedBakes,
}

impl Painter {
    /// Paints one rim. `id` names the control (甲 keeps one bitmap per id).
    #[expect(clippy::too_many_arguments, reason = "the rim's whole description")]
    pub fn paint(
        &self,
        id: u64,
        bounds: Bounds<Pixels>,
        radius: f32,
        look: &Look,
        ground: &Ground,
        window: &mut Window,
        cx: &App,
    ) {
        if look.opacity <= 0.003 {
            return;
        }
        match self.plan {
            Plan::Bake => {
                let image = self.bakes.borrow_mut().image(
                    id,
                    bounds,
                    radius,
                    look,
                    ground,
                    &self.texture,
                    window,
                );
                let _ = window.paint_image(bounds, bounds, Corners::default(), image, 0, false);
            }
            Plan::Cover => paint_cover(bounds, radius, look, ground, window, cx),
            Plan::Flat => paint_flat(bounds, radius, look, ground, self.texture_mean, window),
        }
    }
}

/// 乙: the texture tinted on the GPU, its middle covered by the ground.
fn paint_cover(
    bounds: Bounds<Pixels>,
    radius: f32,
    look: &Look,
    ground: &Ground,
    window: &mut Window,
    cx: &App,
) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let r = radius.min(w / 2.0).min(h / 2.0);
    let (ring0, bleed0) = rim_profile(0.5, look, 0.5);
    let level0 = ring0 + bleed0 * (1.0 - ring0);
    let (_, bleed1) = rim_profile(1.5, look, 0.5);
    if level0 <= 0.0 {
        return;
    }
    // One colour for ring and bleed: in the dark the bleed is lifted toward
    // white, so take the halfway colour.
    let color = look.color.mix(
        Rgb::WHITE,
        ground.bleed_lift * if look.sp > 0.0 { 0.5 } else { 0.0 },
    );
    let mask = ContentMask { bounds };
    window.with_content_mask(Some(mask), |window| {
        let ox = (look.origin.0 + look.flow).rem_euclid(TILE) - TILE;
        let oy = (look.origin.1 + look.flow).rem_euclid(TILE) - TILE;
        let mut ty = oy;
        while ty < h {
            let mut tx = ox;
            while tx < w {
                let tile = Bounds {
                    origin: bounds.origin + point(px(tx), px(ty)),
                    size: size(px(TILE), px(TILE)),
                };
                let _ = window.paint_svg(
                    tile,
                    GLASS_TILE_PATH.into(),
                    None,
                    TransformationMatrix::unit(),
                    color.alpha(level0 * look.opacity),
                    cx,
                );
                tx += TILE;
            }
            ty += TILE;
        }
        // The sharp cover leaves the 1px ring; the soft one fades the bleed.
        let keep = (bleed1 / level0).clamp(0.0, 1.0);
        let inner = inset(bounds, 1.0);
        window.paint_quad(quad(
            inner,
            Corners::all(px((r - 1.0).max(0.0))),
            ground.inside.alpha(1.0 - keep),
            0.0,
            transparent_black(),
            BorderStyle::Solid,
        ));
        if keep > 0.0 && look.sp > 0.0 {
            let k = look.rim / 9.0 * look.sp;
            let m = 1.0 + 3.0 * k;
            let soft = inset(bounds, m);
            if soft.size.width > px(0.0) && soft.size.height > px(0.0) {
                window.paint_drop_shadows(
                    soft,
                    Corners::all(px((r - m).max(0.0))),
                    &[BoxShadow {
                        color: ground.inside.solid(),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(3.0 * k),
                        spread_radius: px(0.0),
                        inset: false,
                    }],
                );
            }
        }
        // The texture is square; the corners outside a round control go back
        // to the ground.
        if r > 0.0 {
            let d = r + 2.0;
            window.paint_quad(quad(
                dilate(bounds, d),
                Corners::all(px(r + d)),
                transparent_black(),
                px(d),
                ground.outside.solid(),
                BorderStyle::Solid,
            ));
        }
    });
}

/// 丙: a uniform border and an inset shadow; flowing turns the shadow round.
fn paint_flat(
    bounds: Bounds<Pixels>,
    radius: f32,
    look: &Look,
    ground: &Ground,
    mean: f32,
    window: &mut Window,
) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let r = px(radius.min(w / 2.0).min(h / 2.0));
    let a = (GLASS_EDGE * look.g).min(1.0) * mean * look.opacity;
    let bleed = look.color.mix(Rgb::WHITE, ground.bleed_lift);
    if look.sp > 0.0 {
        let angle = look.flow / TILE * std::f32::consts::TAU;
        let orbit = 1.2 * look.sp;
        window.paint_inset_shadows(
            bounds,
            Corners::all(r),
            &[BoxShadow {
                color: bleed.alpha(a),
                offset: point(px(orbit * angle.cos()), px(orbit * angle.sin())),
                blur_radius: px(look.rim * look.sp / 2.0),
                spread_radius: px(look.sp),
                inset: true,
            }],
        );
    }
    window.paint_quad(quad(
        bounds,
        Corners::all(r),
        transparent_black(),
        px(1.0),
        look.color.alpha(a),
        BorderStyle::Solid,
    ));
}

pub fn inset(bounds: Bounds<Pixels>, by: f32) -> Bounds<Pixels> {
    Bounds {
        origin: bounds.origin + point(px(by), px(by)),
        size: size(
            (bounds.size.width - px(2.0 * by)).max(px(0.0)),
            (bounds.size.height - px(2.0 * by)).max(px(0.0)),
        ),
    }
}

pub fn dilate(bounds: Bounds<Pixels>, by: f32) -> Bounds<Pixels> {
    Bounds {
        origin: bounds.origin - point(px(by), px(by)),
        size: size(
            bounds.size.width + px(2.0 * by),
            bounds.size.height + px(2.0 * by),
        ),
    }
}

/// How a glass control answers the hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `.glass`: no rim at rest.
    Hidden,
    /// `.glass--rest`: the uneven line at rest.
    Rest,
    /// `.glass--surface`: a card or a long pill; pressing does not deepen it.
    Surface,
    /// `.glass--rest.glass--still`: read-only; the pointer leaves it as is.
    Still,
}

/// One control's rim over time (materials.md, 「状态」).
#[derive(Clone, Copy, Debug)]
pub struct Anim {
    pub kind: Kind,
    pub hover: bool,
    pub pressed: bool,
    pub selected: bool,
    pub opacity: f32,
    pub g: f32,
    pub sp: f32,
    pub flow: f32,
}

impl Anim {
    pub fn new(kind: Kind) -> Anim {
        let mut anim = Anim {
            kind,
            hover: false,
            pressed: false,
            selected: false,
            opacity: 0.0,
            g: 1.0,
            sp: 1.0,
            flow: 0.0,
        };
        let (o, g, sp, _) = anim.target();
        anim.opacity = o;
        anim.g = g;
        anim.sp = sp;
        anim
    }

    pub fn selected(mut self, on: bool) -> Anim {
        self.selected = on;
        let (o, g, sp, _) = self.target();
        self.opacity = o;
        self.g = g;
        self.sp = sp;
        self
    }

    /// (opacity, g, sp, flowing) this control is heading for.
    pub fn target(&self) -> (f32, f32, f32, bool) {
        let rest = match self.kind {
            Kind::Hidden => (0.0, 1.0, 1.0, false),
            _ => (1.0, 0.85, 0.0, false),
        };
        if self.pressed && self.kind != Kind::Still {
            if self.kind == Kind::Surface {
                return (1.0, 1.0, 1.0, true);
            }
            return (1.0, 1.7, 1.3, false);
        }
        if self.selected {
            return (1.0, 1.0, 1.0, false);
        }
        if self.hover {
            return match self.kind {
                Kind::Still => rest,
                _ => (1.0, 1.0, 1.0, true),
            };
        }
        rest
    }

    /// Moves toward the target; true while anything still changes.
    pub fn step(&mut self, dt: f32) -> bool {
        let (to, tg, tsp, flowing) = self.target();
        let pressing = self.pressed && self.kind != Kind::Surface && self.kind != Kind::Still;
        // 40ms to take hold, 0.24s for the bleed to come in, 0.28s to settle.
        let shadow_s = if pressing {
            0.04
        } else if self.g > tg + 0.01 {
            0.28
        } else {
            0.24
        };
        let ease = |v: &mut f32, target: f32, seconds: f32| {
            let k = 1.0 - (-dt * 4.6 / seconds).exp();
            *v += (target - *v) * k;
            if (*v - target).abs() < 0.002 {
                *v = target;
            }
        };
        ease(&mut self.opacity, to, 0.24);
        ease(&mut self.g, tg, shadow_s);
        ease(&mut self.sp, tsp, shadow_s);
        if flowing {
            self.flow += dt * FLOW_PX_PER_S;
        }
        flowing || self.opacity != to || self.g != tg || self.sp != tsp
    }

    pub fn look(&self, color: Rgb, origin: (f32, f32), rim: f32) -> Look {
        Look {
            opacity: self.opacity,
            g: self.g,
            sp: self.sp,
            flow: self.flow,
            rim,
            origin,
            color,
        }
    }
}

/// A rim held in one state, for the side-by-side strip.
pub fn forced(kind: Kind, state: Forced, flow: f32) -> Anim {
    let mut anim = Anim::new(kind);
    match state {
        Forced::Rest => {}
        Forced::Hover => anim.hover = true,
        Forced::Pressed => anim.pressed = true,
        Forced::Selected => anim.selected = true,
    }
    let (o, g, sp, flowing) = anim.target();
    anim.opacity = o;
    anim.g = g;
    anim.sp = sp;
    anim.flow = if flowing { flow } else { 0.0 };
    anim
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Forced {
    Rest,
    Hover,
    Pressed,
    Selected,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erfc_matches_known_values() {
        assert!((erfc(0.0) - 1.0).abs() < 1e-5);
        assert!((erfc(1.0) - 0.157_299_2).abs() < 1e-5);
        assert!((erfc(-1.0) - 1.842_700_8).abs() < 1e-5);
    }

    #[test]
    fn rim_is_strongest_at_the_edge_and_gone_inside() {
        let look = Look::new(Rgb::hex(0xb4b6ae), DENSE);
        let (ring, bleed) = rim_profile(0.5, &look, 0.5);
        assert!((ring - GLASS_EDGE).abs() < 1e-4);
        assert!(bleed > 0.25 && bleed < 0.4);
        let (ring, bleed) = rim_profile(12.0, &look, 0.5);
        assert_eq!(ring, 0.0);
        assert!(bleed < 0.01);
    }

    #[test]
    fn a_press_takes_hold_in_forty_milliseconds_and_stops_the_flow() {
        let mut anim = Anim::new(Kind::Rest);
        anim.hover = true;
        for _ in 0..30 {
            anim.step(1.0 / 60.0);
        }
        let flowed = anim.flow;
        assert!(flowed > 0.0);
        anim.pressed = true;
        for _ in 0..3 {
            anim.step(1.0 / 60.0);
        }
        assert!(anim.g > 1.6, "g = {}", anim.g);
        assert_eq!(anim.flow, flowed);
        anim.pressed = false;
        anim.hover = false;
        for _ in 0..60 {
            anim.step(1.0 / 60.0);
        }
        // Let go and left, the flow pauses where it was.
        assert_eq!(anim.flow, flowed);
        assert!((anim.g - 0.85).abs() < 0.01);
    }
}
