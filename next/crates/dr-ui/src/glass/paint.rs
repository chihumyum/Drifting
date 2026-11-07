//! Painting a rim (decision D2, P0-D's 乙 「遮盖」).
//!
//! The renderer's rim is two inset box-shadows (a 1px ring over a bleed of
//! `--glass-rim` px) in `--glass-cc`, at `--glass-edge` 33% × 1.8 × the
//! strength, masked by the tiled texture `glass-thick.png`. GPUI has no
//! masks, so:
//!
//! - **Cover** (the default): the GPU draws the texture tinted (an SVG
//!   wrapping the PNG, a monochrome sprite), then covers its middle with the
//!   ground colour so only the rim stays; a soft cover fades the bleed. The
//!   corners outside a round control go back to the ground. Drifting moves
//!   only the sprites. Needs a known flat ground under and round the control.
//! - **Flat** (P0-D's 丙): a uniform 1px border and an inset shadow at the
//!   texture's mean strength, for glass on an uneven ground (over an image,
//!   a PDF, the character sea).
//! - **Slab ring**: menus and hover cards keep the renderer's own trick, the
//!   pre-tinted ring texture under an opaque fill inset 1px.

use std::sync::{Arc, OnceLock};

use gpui::{
    App, BorderStyle, Bounds, BoxShadow, ContentMask, Corners, Pixels, RenderImage,
    TransformationMatrix, Window, point, px, quad, size, transparent_black,
};
use image::Frame;
use smallvec::SmallVec;

use crate::{assets, tokens::Rgb};

use super::{GLASS_EDGE, Ground, Look, TEXTURE_MEAN, TILE};

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

/// Paints one rim in `bounds` with corner `radius`.
pub fn paint_rim(
    bounds: Bounds<Pixels>,
    radius: f32,
    look: &Look,
    ground: Ground,
    window: &mut Window,
    cx: &App,
) {
    if look.opacity <= 0.003 || bounds.size.width <= px(0.0) {
        return;
    }
    match ground {
        Ground::Flat { inside, outside } => {
            paint_cover(bounds, radius, look, inside, outside, window, cx)
        }
        Ground::Uneven => paint_flat(bounds, radius, look, window),
    }
}

/// The tint the cover plan draws ring and bleed in: one colour for both, so
/// in the dark (where the bleed is lifted toward white) it takes the halfway
/// colour.
fn cover_color(look: &Look) -> Rgb {
    let lift = if look.sp > 0.0 {
        look.bleed_lift * 0.5
    } else {
        0.0
    };
    look.color.mix(Rgb::WHITE, lift)
}

/// Draws the tinted texture over `bounds`, read from `origin + flow`.
fn paint_tiles(
    bounds: Bounds<Pixels>,
    origin: (f32, f32),
    flow: (f32, f32),
    color: gpui::Hsla,
    window: &mut Window,
    cx: &App,
) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let ox = (origin.0 + flow.0).rem_euclid(TILE) - TILE;
    let oy = (origin.1 + flow.1).rem_euclid(TILE) - TILE;
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
                assets::GLASS_TILE_PATH.into(),
                None,
                TransformationMatrix::unit(),
                color,
                cx,
            );
            tx += TILE;
        }
        ty += TILE;
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_cover(
    bounds: Bounds<Pixels>,
    radius: f32,
    look: &Look,
    inside: Rgb,
    outside: Rgb,
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
    let color = cover_color(look);
    window.with_content_mask(Some(ContentMask { bounds }), |window| {
        paint_tiles(
            bounds,
            look.origin,
            (look.flow, look.flow),
            color.alpha(level0 * look.opacity),
            window,
            cx,
        );
        // The sharp cover leaves the 1px ring; the soft one fades the bleed.
        let keep = (bleed1 / level0).clamp(0.0, 1.0);
        window.paint_quad(quad(
            inset(bounds, 1.0),
            Corners::all(px((r - 1.0).max(0.0))),
            inside.alpha(1.0 - keep),
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
                        color: inside.solid(),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(3.0 * k),
                        spread_radius: px(0.0),
                        inset: false,
                    }],
                );
            }
        }
        // The texture is square; the corners outside a round control go
        // back to the ground.
        if r > 0.0 {
            let d = r + 2.0;
            window.paint_quad(quad(
                dilate(bounds, d),
                Corners::all(px(r + d)),
                transparent_black(),
                px(d),
                outside.solid(),
                BorderStyle::Solid,
            ));
        }
    });
}

/// 丙: a uniform border and an inset shadow; drifting turns the shadow round.
fn paint_flat(bounds: Bounds<Pixels>, radius: f32, look: &Look, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let r = px(radius.min(w / 2.0).min(h / 2.0));
    let a = (GLASS_EDGE * look.g).min(1.0) * TEXTURE_MEAN * look.opacity;
    let bleed = look.color.mix(Rgb::WHITE, look.bleed_lift);
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

/// A band of the rim, `band` = (a0, a1, b0, b1) in window x: full strength
/// between a1 and b0, fading to nothing at a0 and b1. Used by the selection
/// wave; GPUI has no gradient masks, so the soft edges are steps.
#[allow(clippy::too_many_arguments)]
pub fn paint_band(
    bounds: Bounds<Pixels>,
    radius: f32,
    look: &Look,
    ground: Ground,
    band: (f32, f32, f32, f32),
    strength: f32,
    window: &mut Window,
    cx: &App,
) {
    const STEPS: usize = 5;
    let (a0, a1, b0, b1) = band;
    let top = bounds.origin.y;
    let height = bounds.size.height;
    let strip = |x0: f32, x1: f32, k: f32, window: &mut Window| {
        if x1 <= x0 || k <= 0.0 {
            return;
        }
        let clip = Bounds {
            origin: point(px(x0), top),
            size: size(px(x1 - x0), height),
        }
        .intersect(&bounds);
        if clip.size.width <= px(0.0) {
            return;
        }
        window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
            let faded = Look {
                opacity: look.opacity * k * strength,
                ..*look
            };
            paint_rim(bounds, radius, &faded, ground, window, cx);
        });
    };
    strip(a1, b0, 1.0, window);
    for i in 0..STEPS {
        let k = (i as f32 + 0.5) / STEPS as f32;
        let ea = a0 + (a1 - a0) * i as f32 / STEPS as f32;
        let eb = a0 + (a1 - a0) * (i + 1) as f32 / STEPS as f32;
        strip(ea, eb, k, window);
        let fa = b1 - (b1 - b0) * (i + 1) as f32 / STEPS as f32;
        let fb = b1 - (b1 - b0) * i as f32 / STEPS as f32;
        strip(fa, fb, k, window);
    }
}

fn ring_image(dark: bool) -> Arc<RenderImage> {
    static LIGHT: OnceLock<Arc<RenderImage>> = OnceLock::new();
    static DARK: OnceLock<Arc<RenderImage>> = OnceLock::new();
    let (cell, png) = if dark {
        (&DARK, assets::GLASS_RING_DARK_PNG)
    } else {
        (&LIGHT, assets::GLASS_RING_PNG)
    };
    cell.get_or_init(|| {
        let mut image = image::load_from_memory(png)
            .map(|i| i.to_rgba8())
            .unwrap_or_else(|_| image::RgbaImage::new(1, 1));
        // GPUI's RenderImage is BGRA.
        for p in image.pixels_mut() {
            p.0.swap(0, 2);
        }
        Arc::new(RenderImage::new(SmallVec::from_elem(Frame::new(image), 1)))
    })
    .clone()
}

/// A menu's or hover card's resting line: the pre-tinted ring texture
/// tiled under `fill` inset 1px, read from `origin` on the texture.
pub fn paint_slab(
    bounds: Bounds<Pixels>,
    radius: f32,
    fill: Rgb,
    dark: bool,
    origin: (f32, f32),
    window: &mut Window,
) {
    let ring = ring_image(dark);
    // GPUI shrinks a piece's corner radius to half its size, so each
    // rounded corner (2r square) must lie inside one tile: move the grid
    // the least it takes to keep its lines out of the bands along the edges.
    let band = 2.0 * radius;
    let ox = tile_start(origin.0, f32::from(bounds.size.width), band);
    let oy = tile_start(origin.1, f32::from(bounds.size.height), band);
    let mut ty = oy;
    while ty < f32::from(bounds.size.height) {
        let mut tx = ox;
        while tx < f32::from(bounds.size.width) {
            let tile = Bounds {
                origin: bounds.origin + point(px(tx), px(ty)),
                size: size(px(TILE), px(TILE)),
            };
            let piece = tile.intersect(&bounds);
            if piece.size.width > px(0.0) && piece.size.height > px(0.0) {
                let r = px(radius);
                let at = |left: bool, top: bool| {
                    let x = if left {
                        piece.left() == bounds.left()
                    } else {
                        piece.right() == bounds.right()
                    };
                    let y = if top {
                        piece.top() == bounds.top()
                    } else {
                        piece.bottom() == bounds.bottom()
                    };
                    if x && y { r } else { px(0.0) }
                };
                let corners = Corners {
                    top_left: at(true, true),
                    top_right: at(false, true),
                    bottom_right: at(false, false),
                    bottom_left: at(true, false),
                };
                let _ = window.paint_image(piece, tile, corners, ring.clone(), 0, false);
            }
            tx += TILE;
        }
        ty += TILE;
    }
    window.paint_quad(
        gpui::fill(inset(bounds, 1.0), fill.solid()).corner_radii(px((radius - 1.0).max(0.0))),
    );
}

/// Where tiling starts (at or left of 0) so that no tile line falls within
/// `band` of either end of `len`, as near `origin`'s grid as possible.
pub(crate) fn tile_start(origin: f32, len: f32, band: f32) -> f32 {
    let clear = |o: f32| {
        let mut line = o.rem_euclid(TILE);
        while line < len {
            if line > 0.0 && (line < band || line > len - band) {
                return false;
            }
            line += TILE;
        }
        true
    };
    let shift = (0..TILE as i32)
        .flat_map(|d| [d as f32, -(d as f32)])
        .find(|d| clear(origin + d))
        .unwrap_or(0.0);
    let first = (origin + shift).rem_euclid(TILE);
    if first == 0.0 { 0.0 } else { first - TILE }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::glass::DENSE;

    #[test]
    fn a_slab_corner_never_straddles_two_tiles() {
        for len in [240.0_f32, 248.0, 320.0, 420.0, 333.5, 600.0, 90.0] {
            for origin in [-96.0_f32, -30.0, -132.0, 0.0, 17.0] {
                let start = tile_start(origin, len, 32.0);
                assert!(start <= 0.0 && start > -TILE, "{start}");
                let mut line = start + TILE;
                while line < len {
                    assert!(
                        (32.0..=len - 32.0).contains(&line),
                        "len {len}, origin {origin}: a line at {line}"
                    );
                    line += TILE;
                }
            }
        }
        // Already clear: the grid is kept.
        assert_eq!(tile_start(-96.0, 240.0, 32.0), -96.0);
    }

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
}
