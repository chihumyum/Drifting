//! What every cover style paints with (the 0.1 client's
//! `lib/shelf-cover/paint.ts`): seeded randomness, smooth noise, colour
//! arithmetic, a few raster helpers, and [`Ctx`], the part of Canvas 2D the
//! styles use, over a tiny-skia pixmap of the cover's own size (twice the
//! 126 × 226 cover). The styles are ported line by line against it, so the
//! names and the order of arguments are the canvas's.
//!
//! Differences from a browser's canvas, none of which the styles lean on:
//! a path's points take the transform when they are added and strokes are
//! not scaled by it (the styles only translate and rotate); a radial
//! gradient's inner circle has no radius; a shadow's blur is three box
//! blurs (close to the canvas's Gaussian).

use std::f32::consts::PI;

use tiny_skia::{
    BlendMode, Color, FillRule, GradientStop, LineCap, LineJoin, Mask, Paint, Path, PathBuilder,
    Pixmap, PixmapPaint, Point as SkPoint, RadialGradient as SkRadial, Rect, Shader, SpreadMode,
    Stroke, Transform,
};

pub const COVER_WIDTH: usize = 252;
pub const COVER_HEIGHT: usize = 452;
pub const W: usize = COVER_WIDTH;
pub const H: usize = COVER_HEIGHT;
pub const WF: f32 = W as f32;
pub const HF: f32 = H as f32;

pub const TAU: f32 = PI * 2.0;

/// A colour as the styles write it, 0–255 a channel.
pub type Rgb = [u8; 3];

/// A seeded random number generator (mulberry32), 0–1, the same numbers as
/// the 0.1 client's for the same seed.
#[derive(Clone, Debug)]
pub struct Rand(u32);

impl Rand {
    pub fn new(seed: u32) -> Rand {
        Rand(seed)
    }

    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f32 {
        self.next_f64() as f32
    }

    /// The draw in full precision (the 0.1 client's numbers are doubles).
    pub fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

fn ease(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

pub fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    v.max(lo).min(hi)
}

pub fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Smooth noise along one axis, 0–1, varying over about `cell` steps.
pub fn noise1d(n: usize, cell: f32, rand: &mut Rand) -> Vec<f32> {
    let grid: Vec<f32> = (0..(n as f32 / cell).floor() as usize + 3)
        .map(|_| rand.next())
        .collect();
    (0..n)
        .map(|i| {
            let u = i as f32 / cell;
            let i0 = u.floor() as usize;
            let t = ease(u - i0 as f32);
            grid[i0] * (1.0 - t) + grid[i0 + 1] * t
        })
        .collect()
}

/// Smooth noise over the cover, 0–1, varying over about `cell` px across
/// and `cell_y` down (`noise2d(cell, rand)` is `noise2d_xy(cell, cell, …)`).
pub fn noise2d(cell: f32, rand: &mut Rand) -> Vec<f32> {
    noise2d_xy(cell, cell, rand)
}

/// How many cells of `cell` px fit in `n` px, divided as the 0.1 client
/// divides: the cell as the decimal a style writes, in doubles (252 / 1.2
/// is 210 there; in f32 it falls just short, a column fewer, and every
/// draw after it moves).
fn cells_in(n: usize, cell: f32) -> usize {
    let cell: f64 = cell.to_string().parse().unwrap_or(f64::from(cell));
    (n as f64 / cell).floor() as usize
}

pub fn noise2d_xy(cell: f32, cell_y: f32, rand: &mut Rand) -> Vec<f32> {
    let gw = cells_in(W, cell) + 3;
    let gh = cells_in(H, cell_y) + 3;
    let grid: Vec<f32> = (0..gw * gh).map(|_| rand.next()).collect();
    let mut out = vec![0.0; W * H];
    for y in 0..H {
        let v = y as f32 / cell_y;
        let y0 = v.floor() as usize;
        let ty = ease(v - y0 as f32);
        for x in 0..W {
            let u = x as f32 / cell;
            let x0 = u.floor() as usize;
            let tx = ease(u - x0 as f32);
            let a = grid[y0 * gw + x0];
            let b = grid[y0 * gw + x0 + 1];
            let c = grid[(y0 + 1) * gw + x0];
            let d = grid[(y0 + 1) * gw + x0 + 1];
            out[y * W + x] =
                (a * (1.0 - tx) + b * tx) * (1.0 - ty) + (c * (1.0 - tx) + d * tx) * ty;
        }
    }
    out
}

/// `#rgb` or `#rrggbb`; anything else is `fallback`.
pub fn hex_color_or(color: &str, fallback: Rgb) -> Rgb {
    let Some(digits) = color.trim().strip_prefix('#') else {
        return fallback;
    };
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return fallback;
    }
    let full: String = match digits.len() {
        3 => digits.chars().flat_map(|c| [c, c]).collect(),
        6 => digits.to_owned(),
        _ => return fallback,
    };
    let channel = |i: usize| u8::from_str_radix(&full[i..i + 2], 16).unwrap_or(0);
    [channel(0), channel(2), channel(4)]
}

/// `#rgb` or `#rrggbb`; anything else is the neutral ink.
pub fn hex_color(color: &str) -> Rgb {
    hex_color_or(color, [85, 82, 78])
}

/// JavaScript's `Math.round` (halves go up), as the 0.1 client rounds.
pub fn js_round(v: f32) -> f32 {
    (v + 0.5).floor()
}

/// A value stored into a `Uint8ClampedArray`: clamped, then rounded to the
/// nearest (halves to even).
pub fn clamped(v: f32) -> u8 {
    let v = v.clamp(0.0, 255.0);
    let r = v.round();
    let r = if (v - v.floor() - 0.5).abs() < f32::EPSILON && r % 2.0 != 0.0 {
        r - 1.0
    } else {
        r
    };
    r as u8
}

pub fn mix(a: Rgb, b: Rgb, t: f32) -> Rgb {
    let m = |i: usize| js_round(f32::from(a[i]) + (f32::from(b[i]) - f32::from(a[i])) * t) as u8;
    [m(0), m(1), m(2)]
}

/// `rgba(r,g,b,a)`.
pub fn css(c: Rgb, a: f32) -> Color {
    Color::from_rgba8(c[0], c[1], c[2], clamped(a.clamp(0.0, 1.0) * 255.0))
}

/// `rgb(r,g,b)`.
pub fn css1(c: Rgb) -> Color {
    css(c, 1.0)
}

pub fn average_color(list: &[Rgb]) -> Rgb {
    let n = list.len().max(1) as f32;
    let avg = |k: usize| js_round(list.iter().map(|c| f32::from(c[k])).sum::<f32>() / n) as u8;
    [avg(0), avg(1), avg(2)]
}

/// The colour with its saturation and lightness scaled, as print and paper
/// colours are louder than ink.
pub fn vivid(rgb: Rgb, sat: f32, light: f32) -> Rgb {
    let [r, g, b] = rgb.map(|v| f32::from(v) / 255.0);
    let mx = r.max(g).max(b);
    let mn = r.min(g).min(b);
    let mut h = 0.0;
    let mut s = 0.0;
    let mut l = (mx + mn) / 2.0;
    if mx != mn {
        let d = mx - mn;
        s = if l > 0.5 {
            d / (2.0 - mx - mn)
        } else {
            d / (mx + mn)
        };
        h = if mx == r {
            (g - b) / d + if g < b { 6.0 } else { 0.0 }
        } else if mx == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        h /= 6.0;
    }
    s = clamp(s * sat, 0.0, 1.0);
    l = clamp(l * light, 0.0, 1.0);
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let channel = |t: f32| {
        let t = (t + 1.0) % 1.0;
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [
        js_round(channel(h + 1.0 / 3.0) * 255.0) as u8,
        js_round(channel(h) * 255.0) as u8,
        js_round(channel(h - 1.0 / 3.0) * 255.0) as u8,
    ]
}

pub const PAPER: Rgb = [253, 252, 249];

/// A cover's worth of pixels as `ImageData` holds them: straight RGBA, row
/// by row, `W × H × 4` bytes.
#[derive(Clone)]
pub struct Image {
    pub data: Vec<u8>,
}

impl Image {
    /// Transparent black (`createImageData`).
    pub fn new() -> Image {
        Image {
            data: vec![0; W * H * 4],
        }
    }
}

impl Default for Image {
    fn default() -> Self {
        Image::new()
    }
}

/// A ground of one colour.
pub fn ground(rgb: Rgb) -> Image {
    ground_with(rgb, |_, _, _| 1.0)
}

/// A ground of one colour, each px (index `i`, at `x`, `y`) scaled by
/// `texture`.
pub fn ground_with(rgb: Rgb, texture: impl Fn(usize, usize, usize) -> f32) -> Image {
    let mut img = Image::new();
    for i in 0..W * H {
        let t = texture(i, i % W, i / W);
        let d = &mut img.data[i * 4..i * 4 + 4];
        d[0] = clamped(f32::from(rgb[0]) * t);
        d[1] = clamped(f32::from(rgb[1]) * t);
        d[2] = clamped(f32::from(rgb[2]) * t);
        d[3] = 255;
    }
    img
}

/// Lays a colour on the image through an alpha field, as pigment: the paper
/// shows through.
pub fn multiply_into(data: &mut [u8], alpha: &[f32], rgb: Rgb, strength: f32) {
    for (px, &alpha) in data.chunks_mut(4).zip(alpha).take(W * H) {
        let a = alpha * strength;
        if a <= 0.0 {
            continue;
        }
        for (v, &c) in px.iter_mut().zip(&rgb) {
            *v = clamped(f32::from(*v) * (1.0 - a + (a * f32::from(c)) / 255.0));
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

pub fn pt(x: f32, y: f32) -> Point {
    Point { x, y }
}

// ---- paths ----------------------------------------------------------------

/// A path as the canvas builds it: subpaths of lines and curves, with
/// arcs and ellipses joined to the point before them.
#[derive(Clone, Default)]
pub struct Path2D {
    builder: PathBuilder,
    open: bool,
}

impl Path2D {
    pub fn new() -> Path2D {
        Path2D::default()
    }

    pub fn move_to(&mut self, x: f32, y: f32) {
        self.builder.move_to(x, y);
        self.open = true;
    }

    pub fn line_to(&mut self, x: f32, y: f32) {
        if self.open {
            self.builder.line_to(x, y);
        } else {
            self.move_to(x, y);
        }
    }

    pub fn quadratic_curve_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        if !self.open {
            self.move_to(cx, cy);
        }
        self.builder.quad_to(cx, cy, x, y);
    }

    pub fn bezier_curve_to(&mut self, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) {
        if !self.open {
            self.move_to(c1x, c1y);
        }
        self.builder.cubic_to(c1x, c1y, c2x, c2y, x, y);
    }

    pub fn close_path(&mut self) {
        if self.open {
            self.builder.close();
        }
    }

    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.move_to(x, y);
        self.builder.line_to(x + w, y);
        self.builder.line_to(x + w, y + h);
        self.builder.line_to(x, y + h);
        self.builder.close();
        self.move_to(x, y);
    }

    /// `arc(x, y, r, a0, a1)`, clockwise on screen.
    pub fn arc(&mut self, x: f32, y: f32, r: f32, a0: f32, a1: f32) {
        self.ellipse(x, y, r, r, 0.0, a0, a1);
    }

    /// `arc(x, y, r, a0, a1, true)`.
    pub fn arc_ccw(&mut self, x: f32, y: f32, r: f32, a0: f32, a1: f32) {
        self.ellipse_dir(x, y, r, r, 0.0, a0, a1, true);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ellipse(&mut self, x: f32, y: f32, rx: f32, ry: f32, rot: f32, a0: f32, a1: f32) {
        self.ellipse_dir(x, y, rx, ry, rot, a0, a1, false);
    }

    /// The canvas's `ellipse`: from angle `a0` to `a1` (the sweep clamped
    /// to a full turn), joined by a line to the point before.
    #[allow(clippy::too_many_arguments)]
    pub fn ellipse_dir(
        &mut self,
        x: f32,
        y: f32,
        rx: f32,
        ry: f32,
        rot: f32,
        a0: f32,
        a1: f32,
        ccw: bool,
    ) {
        if rx < 0.0 || ry < 0.0 {
            return;
        }
        let mut sweep = a1 - a0;
        if !ccw {
            if sweep >= TAU {
                sweep = TAU;
            } else if sweep < 0.0 {
                sweep = sweep.rem_euclid(TAU);
            }
        } else if -sweep >= TAU {
            sweep = -TAU;
        } else if sweep > 0.0 {
            sweep = sweep.rem_euclid(TAU) - TAU;
        }
        let (sr, cr) = rot.sin_cos();
        let at = |a: f32| {
            let (s, c) = a.sin_cos();
            let (ex, ey) = (rx * c, ry * s);
            (x + ex * cr - ey * sr, y + ex * sr + ey * cr)
        };
        // Its derivative, for the control points.
        let dir = |a: f32| {
            let (s, c) = a.sin_cos();
            let (ex, ey) = (-rx * s, ry * c);
            (ex * cr - ey * sr, ex * sr + ey * cr)
        };
        let start = at(a0);
        if self.open {
            self.builder.line_to(start.0, start.1);
        } else {
            self.move_to(start.0, start.1);
        }
        let parts = (sweep.abs() / (PI / 2.0)).ceil().max(1.0) as usize;
        let step = sweep / parts as f32;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        let mut a = a0;
        for _ in 0..parts {
            let b = a + step;
            let (p0, p3) = (at(a), at(b));
            let (d0, d3) = (dir(a), dir(b));
            self.builder.cubic_to(
                p0.0 + k * d0.0,
                p0.1 + k * d0.1,
                p3.0 - k * d3.0,
                p3.1 - k * d3.1,
                p3.0,
                p3.1,
            );
            a = b;
        }
    }

    /// `addPath`.
    pub fn add_path(&mut self, other: &Path2D) {
        if let Some(path) = other.builder.clone().finish() {
            self.builder.push_path(&path);
            self.open = other.open;
        }
    }

    fn finish(&self) -> Option<Path> {
        self.builder.clone().finish()
    }

    fn transformed(&self, t: Transform) -> Option<Path> {
        self.finish()?.transform(t)
    }
}

// ---- the context -----------------------------------------------------------

/// A colour stop of a gradient: where (0–1) and what.
#[derive(Clone, Copy, Debug)]
pub struct Stop {
    pub at: f32,
    pub color: Color,
}

/// `createRadialGradient(x0, y0, r0, x1, y1, r1)` with its stops (the
/// inner circle is drawn as a point).
#[derive(Clone, Debug)]
pub struct RadialGradient {
    pub x0: f32,
    pub y0: f32,
    pub r0: f32,
    pub x1: f32,
    pub y1: f32,
    pub r1: f32,
    pub stops: Vec<Stop>,
}

impl RadialGradient {
    pub fn new(x0: f32, y0: f32, r0: f32, x1: f32, y1: f32, r1: f32) -> RadialGradient {
        RadialGradient {
            x0,
            y0,
            r0,
            x1,
            y1,
            r1,
            stops: Vec::new(),
        }
    }

    pub fn add_color_stop(&mut self, at: f32, color: Color) {
        self.stops.push(Stop { at, color });
    }
}

/// What a fill or a stroke is painted with.
#[derive(Clone, Debug)]
pub enum Style {
    Color(Color),
    Radial(RadialGradient),
}

impl From<Color> for Style {
    fn from(c: Color) -> Style {
        Style::Color(c)
    }
}

impl From<RadialGradient> for Style {
    fn from(g: RadialGradient) -> Style {
        Style::Radial(g)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Shadow {
    pub color: Color,
    pub blur: f32,
    pub offset_x: f32,
    pub offset_y: f32,
}

impl Shadow {
    const NONE: Shadow = Shadow {
        color: Color::TRANSPARENT,
        blur: 0.0,
        offset_x: 0.0,
        offset_y: 0.0,
    };

    fn shows(&self) -> bool {
        self.color.alpha() > 0.0
            && (self.blur > 0.0 || self.offset_x != 0.0 || self.offset_y != 0.0)
    }
}

/// `globalCompositeOperation`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Composite {
    SourceOver,
    Multiply,
}

#[derive(Clone)]
struct State {
    fill: Style,
    stroke: Style,
    line_width: f32,
    cap: LineCap,
    join: LineJoin,
    shadow: Shadow,
    composite: Composite,
    global_alpha: f32,
    transform: Transform,
    clip: Option<Mask>,
}

impl Default for State {
    fn default() -> Self {
        State {
            fill: Style::Color(Color::BLACK),
            stroke: Style::Color(Color::BLACK),
            line_width: 1.0,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
            shadow: Shadow::NONE,
            composite: Composite::SourceOver,
            global_alpha: 1.0,
            transform: Transform::identity(),
            clip: None,
        }
    }
}

/// The 2D context a style paints on.
pub struct Ctx {
    pub pixmap: Pixmap,
    state: State,
    stack: Vec<State>,
    path: Path2D,
}

impl Default for Ctx {
    fn default() -> Self {
        Ctx::new()
    }
}

impl Ctx {
    /// A transparent cover.
    pub fn new() -> Ctx {
        Ctx {
            pixmap: Pixmap::new(W as u32, H as u32).expect("the cover's size is not zero"),
            state: State::default(),
            stack: Vec::new(),
            path: Path2D::new(),
        }
    }

    // -- state --

    pub fn set_fill_style(&mut self, style: impl Into<Style>) {
        self.state.fill = style.into();
    }

    pub fn set_stroke_style(&mut self, style: impl Into<Style>) {
        self.state.stroke = style.into();
    }

    pub fn set_line_width(&mut self, w: f32) {
        if w > 0.0 && w.is_finite() {
            self.state.line_width = w;
        }
    }

    pub fn set_line_cap(&mut self, cap: LineCap) {
        self.state.cap = cap;
    }

    pub fn set_line_join(&mut self, join: LineJoin) {
        self.state.join = join;
    }

    pub fn set_global_alpha(&mut self, a: f32) {
        if (0.0..=1.0).contains(&a) {
            self.state.global_alpha = a;
        }
    }

    pub fn set_composite(&mut self, op: Composite) {
        self.state.composite = op;
    }

    pub fn set_shadow_color(&mut self, color: Color) {
        self.state.shadow.color = color;
    }

    pub fn set_shadow_blur(&mut self, blur: f32) {
        self.state.shadow.blur = blur.max(0.0);
    }

    pub fn set_shadow_offset(&mut self, x: f32, y: f32) {
        self.state.shadow.offset_x = x;
        self.state.shadow.offset_y = y;
    }

    pub fn save(&mut self) {
        self.stack.push(self.state.clone());
    }

    pub fn restore(&mut self) {
        if let Some(state) = self.stack.pop() {
            self.state = state;
        }
    }

    pub fn translate(&mut self, x: f32, y: f32) {
        self.state.transform = self.state.transform.pre_translate(x, y);
    }

    pub fn rotate(&mut self, angle: f32) {
        self.state.transform = self
            .state
            .transform
            .pre_concat(Transform::from_rotate(angle.to_degrees()));
    }

    pub fn set_transform_identity(&mut self) {
        self.state.transform = Transform::identity();
    }

    // -- the current path (its points take the transform as they come) --

    fn map(&self, x: f32, y: f32) -> (f32, f32) {
        let mut p = SkPoint::from_xy(x, y);
        self.state.transform.map_point(&mut p);
        (p.x, p.y)
    }

    fn rotated(&self) -> f32 {
        let t = self.state.transform;
        t.ky.atan2(t.sx)
    }

    pub fn begin_path(&mut self) {
        self.path = Path2D::new();
    }

    pub fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.map(x, y);
        self.path.move_to(x, y);
    }

    pub fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.map(x, y);
        self.path.line_to(x, y);
    }

    pub fn quadratic_curve_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        let (cx, cy) = self.map(cx, cy);
        let (x, y) = self.map(x, y);
        self.path.quadratic_curve_to(cx, cy, x, y);
    }

    pub fn bezier_curve_to(&mut self, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) {
        let (c1x, c1y) = self.map(c1x, c1y);
        let (c2x, c2y) = self.map(c2x, c2y);
        let (x, y) = self.map(x, y);
        self.path.bezier_curve_to(c1x, c1y, c2x, c2y, x, y);
    }

    pub fn close_path(&mut self) {
        self.path.close_path();
    }

    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.move_to(x, y);
        self.line_to(x + w, y);
        self.line_to(x + w, y + h);
        self.line_to(x, y + h);
        self.close_path();
        self.move_to(x, y);
    }

    pub fn arc(&mut self, x: f32, y: f32, r: f32, a0: f32, a1: f32) {
        self.ellipse(x, y, r, r, 0.0, a0, a1);
    }

    pub fn arc_ccw(&mut self, x: f32, y: f32, r: f32, a0: f32, a1: f32) {
        let (cx, cy) = self.map(x, y);
        let rot = self.rotated();
        self.path.ellipse_dir(cx, cy, r, r, rot, a0, a1, true);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ellipse(&mut self, x: f32, y: f32, rx: f32, ry: f32, rot: f32, a0: f32, a1: f32) {
        let (cx, cy) = self.map(x, y);
        let rot = rot + self.rotated();
        self.path.ellipse(cx, cy, rx, ry, rot, a0, a1);
    }

    // -- drawing --

    fn paint_of(&self, style: &Style) -> Paint<'static> {
        let mut paint = Paint {
            anti_alias: true,
            blend_mode: match self.state.composite {
                Composite::SourceOver => BlendMode::SourceOver,
                Composite::Multiply => BlendMode::Multiply,
            },
            ..Paint::default()
        };
        match style {
            Style::Color(c) => {
                let mut c = *c;
                c.apply_opacity(self.state.global_alpha);
                paint.set_color(c);
            }
            Style::Radial(g) => {
                let stops: Vec<GradientStop> = g
                    .stops
                    .iter()
                    .map(|s| {
                        let mut c = s.color;
                        c.apply_opacity(self.state.global_alpha);
                        GradientStop::new(s.at, c)
                    })
                    .collect();
                // Ours have no inner radius: the gradient starts at the
                // inner circle's centre.
                let _ = g.r0;
                match SkRadial::new(
                    SkPoint::from_xy(g.x0, g.y0),
                    SkPoint::from_xy(g.x1, g.y1),
                    g.r1,
                    stops,
                    SpreadMode::Pad,
                    self.state.transform,
                ) {
                    Some(shader) => paint.shader = shader,
                    None => {
                        if let Some(last) = g.stops.last() {
                            paint.set_color(last.color);
                        }
                    }
                }
            }
        }
        paint
    }

    fn stroke_of(&self) -> Stroke {
        Stroke {
            width: self.state.line_width,
            line_cap: self.state.cap,
            line_join: self.state.join,
            ..Stroke::default()
        }
    }

    /// Draws `draw` (a fill or a stroke of `path` with `paint`) and its
    /// shadow under it.
    fn draw(&mut self, path: &Path, paint: &Paint, stroke: Option<&Stroke>) {
        let shadow = self.state.shadow;
        if shadow.shows() {
            self.draw_shadow(path, paint, stroke, shadow);
        }
        let clip = self.state.clip.as_ref();
        match stroke {
            Some(s) => self
                .pixmap
                .stroke_path(path, paint, s, Transform::identity(), clip),
            None => {
                self.pixmap
                    .fill_path(path, paint, FillRule::Winding, Transform::identity(), clip)
            }
        }
    }

    fn draw_with_rule(&mut self, path: &Path, paint: &Paint, rule: FillRule) {
        let shadow = self.state.shadow;
        if shadow.shows() {
            self.draw_shadow(path, paint, None, shadow);
        }
        let clip = self.state.clip.as_ref();
        self.pixmap
            .fill_path(path, paint, rule, Transform::identity(), clip);
    }

    fn draw_shadow(&mut self, path: &Path, paint: &Paint, stroke: Option<&Stroke>, shadow: Shadow) {
        // Only the shape's box, out to the blur's reach, is drawn and
        // blurred (a whole cover a shape is far too slow for styles that
        // shadow hundreds of small shapes).
        let b = path.bounds();
        let spread = (shadow.blur * 1.5).ceil() + 4.0;
        let pad = spread + stroke.map_or(0.0, |s| s.width * 2.0);
        let left = (b.left() + shadow.offset_x - pad).floor().max(-spread);
        let top = (b.top() + shadow.offset_y - pad).floor().max(-spread);
        let right = (b.right() + shadow.offset_x + pad).ceil().min(WF + spread);
        let bottom = (b.bottom() + shadow.offset_y + pad).ceil().min(HF + spread);
        if !(right > left && bottom > top) {
            return;
        }
        let Some(mut layer) = Pixmap::new((right - left) as u32, (bottom - top) as u32) else {
            return;
        };
        let mut tint = Paint {
            anti_alias: true,
            ..Paint::default()
        };
        let mut c = shadow.color;
        // The shadow takes the shape's own coverage; a gradient counts as
        // opaque.
        if let Shader::SolidColor(own) = paint.shader {
            c.apply_opacity(own.alpha());
        }
        c.apply_opacity(self.state.global_alpha);
        tint.set_color(c);
        let at = Transform::from_translate(shadow.offset_x - left, shadow.offset_y - top);
        match stroke {
            Some(s) => layer.stroke_path(path, &tint, s, at, None),
            None => layer.fill_path(path, &tint, FillRule::Winding, at, None),
        }
        if shadow.blur > 0.0 {
            blur(&mut layer, shadow.blur / 2.0);
        }
        let mode = PixmapPaint {
            blend_mode: paint.blend_mode,
            ..PixmapPaint::default()
        };
        let clip = self.state.clip.as_ref();
        self.pixmap.draw_pixmap(
            left as i32,
            top as i32,
            layer.as_ref(),
            &mode,
            Transform::identity(),
            clip,
        );
    }

    /// `fill()` (non-zero).
    pub fn fill(&mut self) {
        self.fill_rule(FillRule::Winding);
    }

    pub fn fill_rule(&mut self, rule: FillRule) {
        let Some(path) = self.path.finish() else {
            return;
        };
        let paint = self.paint_of(&self.state.fill.clone());
        self.draw_with_rule(&path, &paint, rule);
    }

    pub fn stroke(&mut self) {
        let Some(path) = self.path.finish() else {
            return;
        };
        let paint = self.paint_of(&self.state.stroke.clone());
        let stroke = self.stroke_of();
        self.draw(&path, &paint, Some(&stroke));
    }

    /// `fill(path, rule)`: a [`Path2D`] in the current transform.
    pub fn fill_path(&mut self, path: &Path2D, rule: FillRule) {
        let Some(path) = path.transformed(self.state.transform) else {
            return;
        };
        let paint = self.paint_of(&self.state.fill.clone());
        self.draw_with_rule(&path, &paint, rule);
    }

    /// `stroke(path)`.
    pub fn stroke_path(&mut self, path: &Path2D) {
        let Some(path) = path.transformed(self.state.transform) else {
            return;
        };
        let paint = self.paint_of(&self.state.stroke.clone());
        let stroke = self.stroke_of();
        self.draw(&path, &paint, Some(&stroke));
    }

    /// `clip()` with the current path.
    pub fn clip(&mut self, rule: FillRule) {
        if let Some(path) = self.path.finish() {
            self.clip_to(&path, rule);
        }
    }

    /// `clip(path, rule)`.
    pub fn clip_path(&mut self, path: &Path2D, rule: FillRule) {
        if let Some(path) = path.transformed(self.state.transform) {
            self.clip_to(&path, rule);
        }
    }

    fn clip_to(&mut self, path: &Path, rule: FillRule) {
        match &mut self.state.clip {
            Some(mask) => mask.intersect_path(path, rule, true, Transform::identity()),
            None => {
                if let Some(mut mask) = Mask::new(W as u32, H as u32) {
                    mask.fill_path(path, rule, true, Transform::identity());
                    self.state.clip = Some(mask);
                }
            }
        }
    }

    pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        // Upright and unshadowed, the rect is covered exactly, as the
        // canvas covers it (a path's coverage comes in sixteenths, which
        // shows on rects under a px wide).
        let t = self.state.transform;
        if t.sx == 1.0 && t.sy == 1.0 && t.kx == 0.0 && t.ky == 0.0 && !self.state.shadow.shows() {
            let (x0, y0) = self.map(x, y);
            let (x1, y1) = self.map(x + w, y + h);
            let (l, r) = (x0.min(x1), x0.max(x1));
            let (top, bottom) = (y0.min(y1), y0.max(y1));
            // tiny-skia asserts (in a debug build) on a rect that covers
            // two columns, neither in full; cut at the first column's edge,
            // it covers the same.
            let cut = l.ceil();
            let spans: &[(f32, f32)] = if cut > l && cut < r {
                &[(l, cut), (cut, r)]
            } else {
                &[(l, r)]
            };
            let paint = self.paint_of(&self.state.fill.clone());
            let clip = self.state.clip.as_ref();
            for &(a, b) in spans {
                if let Some(rect) = Rect::from_ltrb(a, top, b, bottom) {
                    self.pixmap
                        .fill_rect(rect, &paint, Transform::identity(), clip);
                }
            }
            return;
        }
        let mut p = Path2D::new();
        let corners = [
            self.map(x, y),
            self.map(x + w, y),
            self.map(x + w, y + h),
            self.map(x, y + h),
        ];
        p.move_to(corners[0].0, corners[0].1);
        for c in &corners[1..] {
            p.line_to(c.0, c.1);
        }
        p.close_path();
        let Some(path) = p.finish() else {
            return;
        };
        let paint = self.paint_of(&self.state.fill.clone());
        self.draw_with_rule(&path, &paint, FillRule::Winding);
    }

    pub fn clear_rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        if let Some(rect) = Rect::from_xywh(x, y, w, h) {
            let paint = Paint {
                blend_mode: BlendMode::Clear,
                ..Paint::default()
            };
            self.pixmap
                .fill_rect(rect, &paint, self.state.transform, None);
        }
    }

    /// `putImageData(img, 0, 0)`: the pixels replaced, whatever the
    /// transform, clip or composite.
    pub fn put_image_data(&mut self, img: &Image) {
        let out = self.pixmap.data_mut();
        for i in 0..W * H {
            let s = &img.data[i * 4..i * 4 + 4];
            let a = u16::from(s[3]);
            let pre = |v: u8| ((u16::from(v) * a + 127) / 255) as u8;
            out[i * 4] = pre(s[0]);
            out[i * 4 + 1] = pre(s[1]);
            out[i * 4 + 2] = pre(s[2]);
            out[i * 4 + 3] = s[3];
        }
    }

    /// `getImageData(0, 0, W, H)`: straight RGBA.
    pub fn get_image_data(&self) -> Image {
        let mut img = Image::new();
        for (i, px) in self.pixmap.pixels().iter().enumerate() {
            let c = px.demultiply();
            img.data[i * 4] = c.red();
            img.data[i * 4 + 1] = c.green();
            img.data[i * 4 + 2] = c.blue();
            img.data[i * 4 + 3] = c.alpha();
        }
        img
    }

    /// `fillText` centred on (`x`, `y`) both ways (`textAlign = 'center'`,
    /// `textBaseline = 'middle'`), in `face` at `size` px.
    pub fn fill_text(&mut self, text: &str, x: f32, y: f32, face: &super::glyphs::Face, size: f32) {
        let Some(path) = face.text_path(text, x, y, size) else {
            return;
        };
        let mut p = Path2D::new();
        p.builder.push_path(&path);
        let Some(path) = p.transformed(self.state.transform) else {
            return;
        };
        let paint = self.paint_of(&self.state.fill.clone());
        self.draw_with_rule(&path, &paint, FillRule::Winding);
    }
}

/// Three box blurs (each pass `r` either side) over the premultiplied
/// pixels, horizontally then vertically: close to a Gaussian of `sigma`.
pub fn blur(pixmap: &mut Pixmap, sigma: f32) {
    if sigma <= 0.0 {
        return;
    }
    // The box size for three passes of a Gaussian of `sigma`.
    let r = (((12.0 * sigma * sigma / 3.0) + 1.0).sqrt() / 2.0)
        .floor()
        .max(1.0) as isize;
    let (w, h) = (pixmap.width() as usize, pixmap.height() as usize);
    let data = pixmap.data_mut();
    let mut line = vec![[0f32; 4]; w.max(h)];
    let mut out = vec![[0f32; 4]; w.max(h)];
    for _ in 0..3 {
        for horizontal in [true, false] {
            let (len, count) = if horizontal { (w, h) } else { (h, w) };
            for j in 0..count {
                let index = |i: usize| {
                    if horizontal {
                        (j * w + i) * 4
                    } else {
                        (i * w + j) * 4
                    }
                };
                for (i, px) in line.iter_mut().enumerate().take(len) {
                    let o = index(i);
                    *px = [
                        f32::from(data[o]),
                        f32::from(data[o + 1]),
                        f32::from(data[o + 2]),
                        f32::from(data[o + 3]),
                    ];
                }
                let span = (2 * r + 1) as f32;
                let mut sum = [0f32; 4];
                for k in -r..=r {
                    let px = line[k.clamp(0, len as isize - 1) as usize];
                    for c in 0..4 {
                        sum[c] += px[c];
                    }
                }
                for i in 0..len {
                    for c in 0..4 {
                        out[i][c] = sum[c] / span;
                    }
                    let gone = line[(i as isize - r).clamp(0, len as isize - 1) as usize];
                    let come = line[(i as isize + r + 1).clamp(0, len as isize - 1) as usize];
                    for c in 0..4 {
                        sum[c] += come[c] - gone[c];
                    }
                }
                for (i, px) in out.iter().enumerate().take(len) {
                    let o = index(i);
                    let a = px[3].round().clamp(0.0, 255.0);
                    data[o + 3] = a as u8;
                    for c in 0..3 {
                        data[o + c] = px[c].round().clamp(0.0, a) as u8;
                    }
                }
            }
        }
    }
}

/// A closed path through the points' midpoints, curving at each point.
pub fn smooth_closed(ctx: &mut Ctx, pts: &[Point]) {
    let n = pts.len();
    if n == 0 {
        return;
    }
    let mid = |a: Point, b: Point| pt((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
    let start = mid(pts[n - 1], pts[0]);
    ctx.begin_path();
    ctx.move_to(start.x, start.y);
    for i in 0..n {
        let m = mid(pts[i], pts[(i + 1) % n]);
        ctx.quadratic_curve_to(pts[i].x, pts[i].y, m.x, m.y);
    }
    ctx.close_path();
}

/// The cover as straight RGBA bytes, row by row.
pub fn to_rgba(pixmap: &Pixmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixmap.data().len());
    for px in pixmap.pixels() {
        let c = px.demultiply();
        out.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_random_numbers_are_the_old_clients() {
        // mulberry32(1) in JavaScript.
        let mut r = Rand::new(1);
        let got: Vec<f64> = (0..3).map(|_| r.next_f64()).collect();
        assert!((got[0] - 0.6270739405881613).abs() < 1e-12, "{got:?}");
        assert!((got[1] - 0.002735721180215478).abs() < 1e-12, "{got:?}");
        assert!((got[2] - 0.5274470399599522).abs() < 1e-12, "{got:?}");
    }

    #[test]
    fn colours_read_and_mix_as_the_old_client_did() {
        assert_eq!(hex_color("#abc"), [0xaa, 0xbb, 0xcc]);
        assert_eq!(hex_color("#4F7CAC"), [0x4f, 0x7c, 0xac]);
        assert_eq!(hex_color("blue"), [85, 82, 78]);
        assert_eq!(mix([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128]);
        assert_eq!(clamped(2.5), 2);
        assert_eq!(clamped(3.5), 4);
        assert_eq!(clamped(300.0), 255);
    }
}
