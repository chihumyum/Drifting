//! Drawing the sea (the 0.1 client's fragment shader in
//! `lib/char-sea/char-sea.ts`, on the CPU with GPUI's own primitives).
//!
//! - **At rest** the sheet is one faint dot per cell, painted from a cached
//!   tile, and nothing is computed.
//! - **Moving**, every cell the water, the rain or the word touches draws
//!   its character over its dot, moved by the slope, swelling on the crest,
//!   nearer the accent on a crest and under a rain head. This is P0-D's
//!   simplified drawing, which the author accepted: the dots stay where they
//!   are instead of being pushed aside with the character.
//! - **Glass on the sea** veils it (12% shows under a card and fades out
//!   over 10 px round it), draws its resting line, and where a crest reaches
//!   the line the line thickens and bleeds inward; a trough does not thin it
//!   (GPUI cannot take paint away).
//!
//! In the light theme ink is laid on by multiplying (on a flat ground that
//! is the colour times the ground at the same opacity); in the dark it is
//! laid on as it is.

use std::sync::Arc;

use dr_ui::{
    glass::{self, Ground, Look},
    theme::Theme,
    tokens::{Palette, Rgb},
};
use gpui::{
    App, Bounds, Corners, Element, ElementId, GlobalElementId, Hitbox, InspectorElementId,
    IntoElement, LayoutId, MouseMoveEvent, Pixels, Point, SharedString, Style, TextRun, Window,
    font, point, px, size,
};

use crate::model::{WATER_CELL, Water, bilinear};
use crate::sea::{Glyph, Inner, Mode, Sea, Shape, WORD_FONT, word_families};

/// Glyph sizes are quantized so the cache holds a handful per character.
const SIZE_STEPS: u8 = 9;
/// Under glass the sea shows at this strength.
const VEIL: f32 = 0.12;
/// How far round glass the veil fades out.
const VEIL_FADE: f32 = 10.0;
/// Rim segments the water is read along, px.
const RIM_STEP: f32 = 8.0;

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The sea's colours in one appearance (the 0.1 client's `readTheme`).
#[derive(Clone, Copy, Debug)]
struct Colors {
    dark: bool,
    ground: Rgb,
    ink: Rgb,
    tint: Rgb,
    rest: f32,
    peak: f32,
}

impl Colors {
    fn of(p: &Palette) -> Colors {
        Colors {
            dark: p.dark,
            ground: p.desk,
            ink: p.ink[1],
            tint: p.accent,
            rest: if p.dark { 0.09 } else { 0.075 },
            peak: if p.dark { 0.58 } else { 0.62 },
        }
    }

    /// `c` laid on the ground at alpha `a`, as the shader blends it.
    fn laid(&self, c: Rgb, a: f32) -> gpui::Hsla {
        if self.dark {
            c.alpha(a)
        } else {
            c.multiply(self.ground).alpha(a)
        }
    }
}

/// The sea under a window: put it first in the window's root, under the
/// page that lies on it, at the window's full size.
pub struct CharSea {
    sea: Sea,
}

/// The sea under the window, as an element.
pub fn char_sea(sea: &Sea) -> CharSea {
    CharSea { sea: sea.clone() }
}

impl IntoElement for CharSea {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for CharSea {
    type RequestLayoutState = ();
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style {
            position: gpui::Position::Absolute,
            ..Style::default()
        };
        style.inset.top = px(0.0).into();
        style.inset.left = px(0.0).into();
        style.size.width = gpui::relative(1.0).into();
        style.size.height = gpui::relative(1.0).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Hitbox> {
        let now = dr_ui::anim::now();
        let theme = Theme::of(window, cx);
        let locale = dr_shell::strings::Strings::get(cx).locale();
        let size = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let holds = self.sea.0.holds.borrow();
        let mut inner = self.sea.0.inner.borrow_mut();
        inner.sync(&holds, now, size, locale, theme.reduce_motion);
        drop(holds);
        if let Some(word) = inner.needs_word_shape()
            && let Some(water) = &inner.water
            && let Some(shape) = word_shape(word, water, inner.size, window, cx)
        {
            inner.set_word_shape(shape);
        }
        let started = std::time::Instant::now();
        inner.advance(now);
        inner.times.0 = started.elapsed().as_secs_f32() * 1000.0;
        None
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut Option<Hitbox>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let now = dr_ui::anim::now();
        let theme = Theme::of(window, cx);
        let colors = Colors::of(theme.palette);
        {
            let mut inner = self.sea.0.inner.borrow_mut();
            for image in std::mem::take(&mut inner.stale_images) {
                window.drop_image(image).ok();
            }
            if inner.mode != Mode::Off {
                let started = std::time::Instant::now();
                paint_sea(&mut inner, bounds, colors, theme.palette, window, cx);
                inner.times.1 = started.elapsed().as_secs_f32() * 1000.0;
            }
        }
        // The hand: a light wake as it moves. A dialog over the page is not
        // the sea, but its mist hides the wake anyway.
        let sea = self.sea.clone();
        let origin = bounds.origin;
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, _| {
            if phase != gpui::DispatchPhase::Bubble {
                return;
            }
            let at = event.position - origin;
            let mut inner = sea.0.inner.borrow_mut();
            let was = inner.running;
            inner.wake(f32::from(at.x), f32::from(at.y), dr_ui::anim::now());
            if inner.running && !was {
                window.refresh();
            }
        });
        let holds = self.sea.0.holds.borrow();
        if self.sea.0.inner.borrow().wants_frame(&holds, now) {
            window.request_animation_frame();
        }
    }
}

fn paint_sea(
    inner: &mut Inner,
    bounds: Bounds<Pixels>,
    colors: Colors,
    palette: &Palette,
    window: &mut Window,
    cx: &mut App,
) {
    window.paint_quad(gpui::fill(bounds, colors.ground.solid()));
    paint_dots(inner, bounds, colors, window);
    inner.drawn_cells = 0;
    if inner.running {
        paint_characters(inner, bounds, colors, window);
    }
    paint_glass(inner, bounds, colors, palette, window, cx);
}

/// The resting dots: one tile of 10 × 10 cells, laid over the sheet.
fn paint_dots(inner: &mut Inner, bounds: Bounds<Pixels>, colors: Colors, window: &mut Window) {
    let Some(sheet) = &inner.layout else {
        return;
    };
    let alpha = colors.rest * inner.rest_scale;
    if alpha <= 0.002 {
        return;
    }
    let scale = window.scale_factor();
    let key = crate::sea::DotKey {
        dark: colors.dark,
        scale,
        cell: (sheet.cell_width, sheet.cell_height),
        rest: (inner.rest_scale * 32.0).round() as u16,
    };
    let tile = match &inner.dot_tile {
        Some((k, tile)) if *k == key => tile.clone(),
        _ => {
            inner.retire_dots();
            let tile = dot_tile(key, colors, alpha);
            inner.dot_tile = Some((key, tile.clone()));
            tile
        }
    };
    let Some(sheet) = &inner.layout else {
        return;
    };
    let span = (sheet.cell_width * 10.0, sheet.cell_height * 10.0);
    let (ox, oy) = (sheet.origin_x - span.0, sheet.origin_y - span.1);
    let (w, h) = inner.size;
    let mut ty = oy;
    while ty < h {
        let mut tx = ox;
        while tx < w {
            let b = Bounds {
                origin: bounds.origin + point(px(tx), px(ty)),
                size: size(px(span.0), px(span.1)),
            };
            window
                .paint_image(bounds, b, Corners::default(), tile.clone(), 0, false)
                .ok();
            tx += span.0;
        }
        ty += span.1;
    }
}

fn dot_tile(key: crate::sea::DotKey, colors: Colors, alpha: f32) -> Arc<gpui::RenderImage> {
    let (cw, ch) = key.cell;
    let w = (cw * 10.0 * key.scale).round().max(1.0) as u32;
    let h = (ch * 10.0 * key.scale).round().max(1.0) as u32;
    let ink = if colors.dark {
        colors.ink
    } else {
        colors.ink.multiply(colors.ground)
    };
    let [r, g, b] = ink.to_u8();
    let mut image = image::RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let lx = (x as f32 + 0.5) / key.scale;
            let ly = (y as f32 + 0.5) / key.scale;
            let fx = ((lx / cw).fract() - 0.5) * cw;
            let fy = ((ly / ch).fract() - 0.5) * ch;
            let d = (fx * fx + fy * fy).sqrt();
            let a = (1.0 - smoothstep(0.35, 0.95, d)) * alpha;
            if a > 0.0 {
                image.put_pixel(x, y, image::Rgba([b, g, r, (a * 255.0 + 0.5) as u8]));
            }
        }
    }
    Arc::new(gpui::RenderImage::new(smallvec::SmallVec::from_elem(
        image::Frame::new(image),
        1,
    )))
}

fn step_scale(step: u8) -> f32 {
    0.8 + 0.4 * step as f32 / (SIZE_STEPS - 1) as f32
}

/// Shapes one of the sheet's characters at one size step, in the first of
/// the passage's faces that has it.
fn glyph(inner: &mut Inner, index: u8, step: u8, window: &mut Window) -> Option<Glyph> {
    if let Some(g) = inner.glyph_cache.get(&(index, step)) {
        return *g;
    }
    let sheet = inner.layout.as_ref()?;
    let ch = *sheet.glyphs.get(index as usize)?;
    let size = sheet.cell_height * inner.passage.glyph_size * step_scale(step);
    let text: SharedString = ch.to_string().into();
    let mut found = None;
    for family in inner.passage.families {
        let run = TextRun {
            len: text.len(),
            font: font(SharedString::new_static(family)),
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let line = window
            .text_system()
            .shape_line(text.clone(), px(size), &[run], None);
        let Some(run) = line.runs.first() else {
            continue;
        };
        let Some(shaped) = run.glyphs.first() else {
            continue;
        };
        if shaped.id.0 == 0 {
            continue;
        }
        found = Some(Glyph {
            font: run.font_id,
            id: shaped.id,
            advance: f32::from(line.width),
            ascent: f32::from(line.ascent),
            descent: f32::from(line.descent),
        });
        break;
    }
    inner.glyph_cache.insert((index, step), found);
    found
}

/// Every cell the water, the rain or the word moves: its character, over
/// its dot.
fn paint_characters(
    inner: &mut Inner,
    bounds: Bounds<Pixels>,
    colors: Colors,
    window: &mut Window,
) {
    let (Some(water), Some(sheet)) = (&inner.water, &inner.layout) else {
        return;
    };
    let (w, h) = inner.size;
    let (cols, rows) = (sheet.cols, sheet.rows);
    let (cw, ch) = (sheet.cell_width, sheet.cell_height);
    let (ox, oy) = (sheet.origin_x, sheet.origin_y);
    let st = (w / water.cols as f32, h / water.rows as f32);
    let word_h = inner.word_shown();
    let word = inner.word_shape.as_deref();
    let wat = |x: f32, y: f32| {
        word.map_or(0.0, |shape| {
            bilinear(shape, water.cols, water.rows, w, h, x, y)
        })
    };
    let rain = inner.rain.as_ref().map(|r| r.cells.clone());
    let live = inner.glyphs.as_ref().map(|g| g.live.clone());
    let glyph_size = inner.passage.glyph_size;
    // (cell, glyph index, step, origin, colour) to draw once the water is
    // let go of (shaping needs the whole of `inner`).
    let mut draws: Vec<(u8, u8, Point<Pixels>, gpui::Hsla)> = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            let i = row * cols + col;
            let cx = ox + (col as f32 + 0.5) * cw;
            let cy = oy + (row as f32 + 0.5) * ch;
            let hc = water.sample(cx, cy);
            let (rx, ry) = rain.as_ref().map_or((0.0, 0.0), |r| {
                (r[i * 2] as f32 / 255.0, r[i * 2 + 1] as f32 / 255.0)
            });
            if hc.abs() < 0.004 && rx == 0.0 {
                continue;
            }
            // The word's own standing slope moves no character: its
            // characters sit square in their cells.
            let mut gx = water.sample(cx + st.0, cy) - water.sample(cx - st.0, cy);
            let mut gy = water.sample(cx, cy + st.1) - water.sample(cx, cy - st.1);
            if word_h > 0.0 {
                gx -= word_h * (wat(cx + st.0, cy) - wat(cx - st.0, cy));
                gy -= word_h * (wat(cx, cy + st.1) - wat(cx, cy - st.1));
            }
            let lim = (0.3 + 0.4 * rx) * ch;
            let off = (
                (gx * 26.0 * (1.0 + 1.5 * rx)).clamp(-lim, lim),
                (gy * 26.0 * (1.0 + 1.5 * rx)).clamp(-lim, lim),
            );
            let cr = (hc * 3.0).clamp(-1.0, 1.0);
            let s = smoothstep(0.04, 0.26, hc.abs()).max(0.7 * rx);
            let a = colors.peak * (0.6 + 0.4 * cr.max(ry)) * s;
            if a < 0.01 {
                continue;
            }
            let sc = 1.0 + 0.2 * cr;
            let step = (((sc - 0.8) / 0.4) * (SIZE_STEPS - 1) as f32)
                .round()
                .clamp(0.0, (SIZE_STEPS - 1) as f32) as u8;
            let c = colors
                .ink
                .mix(colors.tint, (0.45 * s * cr.max(0.0) + 0.55 * ry).min(1.0));
            let index = live.as_ref().map_or(sheet.map[i], |l| l[i]);
            draws.push((
                index,
                step,
                bounds.origin + point(px(cx + off.0), px(cy + off.1)),
                colors.laid(c, a.min(1.0)),
            ));
        }
    }
    let mut drawn = 0u32;
    for (index, step, at, color) in draws {
        let Some(g) = glyph(inner, index, step, window) else {
            continue;
        };
        let size = px(ch * glyph_size * step_scale(step));
        let origin = at + point(px(-g.advance / 2.0), px((g.ascent - g.descent) / 2.0));
        if window
            .paint_glyph(origin, g.font, g.id, size, color)
            .is_ok()
        {
            drawn += 1;
        }
    }
    inner.drawn_cells = drawn;
}

/// Glass on the sea: the veil under it, its resting line, and the water's
/// mark on that line.
fn paint_glass(
    inner: &mut Inner,
    bounds: Bounds<Pixels>,
    colors: Colors,
    palette: &Palette,
    window: &mut Window,
    cx: &mut App,
) {
    let shapes = inner.shapes.clone();
    for shape in &shapes {
        let b = Bounds {
            origin: shape.bounds.origin,
            size: shape.bounds.size,
        };
        let r = px(shape.radius);
        window.paint_drop_shadows(
            b,
            Corners::all(r),
            &[gpui::BoxShadow {
                color: colors.ground.alpha(1.0 - VEIL),
                offset: point(px(0.0), px(0.0)),
                blur_radius: px(VEIL_FADE),
                spread_radius: px(VEIL_FADE / 2.0),
                inset: false,
            }],
        );
        window.paint_quad(gpui::fill(b, colors.ground.alpha(1.0 - VEIL)).corner_radii(r));
    }
    for (order, shape) in shapes.iter().enumerate() {
        let rest = inner
            .rest_shown
            .get(&shape.id)
            .copied()
            .unwrap_or(shape.rest);
        if shape.rest < 0.0 {
            continue;
        }
        let hover = inner.hover_amount.get(&shape.id).copied().unwrap_or(0.0);
        let mut look = Look::new(
            palette.glass_clear,
            glass::SAMPLE_ORIGINS[order % glass::SAMPLE_ORIGINS.len()],
        );
        look.bleed_lift = palette.bleed_lift;
        look.g = rest.max(hover);
        look.sp = hover;
        look.flow = inner.flow.get(&shape.id).copied().unwrap_or(0.0);
        if look.g > 0.003 {
            glass::paint_rim(
                shape.bounds,
                shape.radius,
                &look,
                Ground::Uneven,
                window,
                cx,
            );
        }
        if let Some(water) = &inner.water {
            paint_wet_rim(shape, look, water, bounds.origin, window, cx);
        }
    }
}

/// Where a crest reaches a resting line, that stretch of it thickens and
/// bleeds inward (`G = base · (1 + 0.75 · up)`, `bleed ∝ 0.3 · up`).
fn paint_wet_rim(
    shape: &Shape,
    look: Look,
    water: &Water,
    origin: Point<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let b = shape.bounds;
    let (x0, y0) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (x1, y1) = (x0 + f32::from(b.size.width), y0 + f32::from(b.size.height));
    let (sx, sy) = (f32::from(origin.x), f32::from(origin.y));
    let base = look.g;
    let segment = |cx_: f32, cy_: f32, clip: Bounds<Pixels>, window: &mut Window| {
        let up = (water.sample(cx_ - sx, cy_ - sy) * 4.0).clamp(-0.8, 1.0);
        if up < 0.04 {
            return;
        }
        let extra = Look {
            g: if base > 0.01 {
                0.75 * base * up
            } else {
                0.9 * up
            },
            sp: 0.6 * up,
            ..look
        };
        window.with_content_mask(Some(gpui::ContentMask { bounds: clip }), |window| {
            glass::paint_rim(b, shape.radius, &extra, Ground::Uneven, window, cx);
        });
    };
    let inward = 14.0;
    let mut x = x0;
    while x < x1 {
        let x2 = (x + RIM_STEP).min(x1);
        let mid = (x + x2) / 2.0;
        let top = Bounds {
            origin: point(px(x), px(y0 - 2.0)),
            size: size(px(x2 - x), px(inward + 2.0)),
        };
        let bottom = Bounds {
            origin: point(px(x), px(y1 - inward)),
            size: size(px(x2 - x), px(inward + 2.0)),
        };
        segment(mid, y0, top, window);
        segment(mid, y1, bottom, window);
        x = x2;
    }
    let mut y = y0 + inward;
    while y < y1 - inward {
        let y2 = (y + RIM_STEP).min(y1 - inward);
        let mid = (y + y2) / 2.0;
        let left = Bounds {
            origin: point(px(x0 - 2.0), px(y)),
            size: size(px(inward + 2.0), px(y2 - y)),
        };
        let right = Bounds {
            origin: point(px(x1 - inward), px(y)),
            size: size(px(inward + 2.0), px(y2 - y)),
        };
        segment(x0, mid, left, window);
        segment(x1, mid, right, window);
        y = y2;
    }
}

/// The word as each water cell's share of its ink, centred across the
/// window: drawn in an old serif through GPUI's SVG renderer (which reads
/// the system's faces), four samples a cell each way.
fn word_shape(
    text: &str,
    water: &Water,
    (width, height): (f32, f32),
    window: &mut Window,
    cx: &mut App,
) -> Option<Vec<f32>> {
    const SAMPLES: usize = 4;
    let (cols, rows) = (water.cols, water.rows);
    // 30% of the window's height, at most 70% of its width.
    let mut size_px = height * 0.3;
    let mut word_font = font(WORD_FONT);
    word_font.weight = gpui::FontWeight::BOLD;
    let run = TextRun {
        len: text.len(),
        font: word_font,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let wide = f32::from(
        window
            .text_system()
            .shape_line(text.to_owned().into(), px(size_px), &[run], None)
            .width,
    );
    if wide > width * 0.7 {
        size_px *= width * 0.7 / wide;
    }
    let scale = SAMPLES as f32 / WATER_CELL;
    let (w, h) = (cols * SAMPLES, rows * SAMPLES);
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><text x="{x}" y="{y}" font-family="{families}" font-weight="700" font-size="{size}" text-anchor="middle" fill="white">{text}</text></svg>"#,
        x = width / 2.0 * scale,
        y = h as f32 / 2.0,
        families = word_families(),
        size = size_px * scale,
    );
    // GPUI rasterizes an SVG at twice the scale asked for.
    let image = cx
        .svg_renderer()
        .render_single_frame(svg.as_bytes(), 0.5)
        .ok()?;
    let bytes = image.as_bytes(0)?;
    let iw = image.size(0).width.0.max(0) as usize;
    let ih = image.size(0).height.0.max(0) as usize;
    let alpha = |x: usize, y: usize| -> u32 {
        if x < iw && y < ih {
            bytes[(y * iw + x) * 4 + 3] as u32
        } else {
            0
        }
    };
    // Centre the ink (not the line box) on the window's middle.
    let (mut top, mut bottom) = (ih, 0);
    for y in 0..ih {
        if (0..iw).any(|x| alpha(x, y) > 0) {
            top = top.min(y);
            bottom = bottom.max(y);
        }
    }
    if bottom < top {
        return None;
    }
    let ink_middle = (top + bottom) as f32 / 2.0;
    let shift = (height / 2.0 * scale - ink_middle).round() as isize;
    let mut shape = vec![0.0f32; cols * rows];
    for row in 0..rows {
        for col in 0..cols {
            let mut sum = 0u32;
            for j in 0..SAMPLES {
                let y = (row * SAMPLES + j) as isize - shift;
                if y < 0 {
                    continue;
                }
                for k in 0..SAMPLES {
                    sum += alpha(col * SAMPLES + k, y as usize);
                }
            }
            shape[row * cols + col] = sum as f32 / (SAMPLES * SAMPLES * 255) as f32;
        }
    }
    Some(shape)
}

/// The sea's id for a piece of glass.
pub(crate) fn shape_id(id: &ElementId) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_ink_is_multiplied_into_the_ground() {
        let c = Colors::of(&Palette::LIGHT);
        let laid: gpui::Rgba = c.laid(c.ink, 0.5).into();
        let want = c.ink.multiply(c.ground);
        assert!((laid.r - want.r).abs() < 1e-3 && (laid.a - 0.5).abs() < 1e-3);
    }
}
