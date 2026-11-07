//! 字海 on the CPU: the renderer's water (`src/renderer/lib/char-sea/`,
//! WebGL2 there) as a plain Rust wave equation, drawn with GPUI glyphs.
//!
//! At rest the sea is one faint dot per 10px cell, painted from a cached tile
//! bitmap, and nothing is computed. Moving, each cell the water, the rain or
//! the loading word touches gets its dot covered and its character drawn
//! over it, offset by the slope and scaled by the height, as the shader does.

use std::{collections::HashMap, sync::Arc, time::Instant};

use gpui::{
    App, Bounds, FontId, GlyphId, Pixels, RenderImage, SharedString, TextRun, Window, font, point,
    px, size,
};

use crate::{glass::render_image, theme::Theme};

/// The synthetic passage the sea is written in (the renderer's
/// `char-sea-text.ts`, written for Drifting).
pub const PASSAGE: &str = "雾从港口那边漫过来的时候，林岚正把第三封信压在灯座底下。灯塔的铁梯被潮气浸得发凉，她每往上走一级，脚下就响一声，像有人在楼下跟着数。守塔人说今晚不会有船。她没有回答，只是把窗推开一道缝，让海风翻动桌上的信纸。纸角卷起来，露出背面一行很淡的铅笔字，那是她自己的笔迹，可她不记得什么时候写过。远处的雾笛响了两声，停了，又响了一声。她数着灯转过的圈数，数到第七圈的时候，海面上亮起一点很小的光，像有人在水底下划了一根火柴。那光不往岸边来，也不往外走，只在原地一明一灭。她想起父亲说过，雾最浓的夜里，旧码头会自己记起从前的船。信封上的邮戳已经洇开了，只剩一个“北”字还看得清。";

pub const CELL: f32 = 10.0;
pub const GLYPH_SIZE: f32 = 0.8;
pub const STEP_RATE: f32 = 100.0;
pub const WATER_CELL: f32 = 7.0;
const C2: f32 = 0.2;
const DAMPING: f32 = 0.992;
const EDGE_DAMPING: f32 = 0.9;
const EDGE_CELLS: f32 = 16.0;
const CALM_FROM: f32 = 0.3;
const CALM_FULL: f32 = 0.05;
const CALM_DAMPING: f32 = 0.015;
const HOLD_SPRING: f32 = 0.03;
const HOLD_DAMPING: f32 = 0.04;
const HOLD_MARGIN: i32 = 4;
const DROP_RADIUS: f32 = 2.2;
const WORD_HEIGHT: f32 = 0.45;
const WORD_RISE: f32 = 0.7;
const WORD_BREATH: f32 = 2.6;
const WORD_SWELL: f32 = 0.12;
const WORD_BURST: f32 = 4.0;
const RAIN_DENSITY: f32 = 0.3;
const RAIN_BREAK: f32 = 0.2;
const SWAP_HEAD: f32 = 14.0;
const SWAP_TRAIL: f32 = 2.5;
const SWAP_WORD: f32 = 0.8;
const SWAP_SEA: f32 = 1.0;

/// mulberry32, as the renderer seeds its randomness.
#[derive(Clone)]
pub struct Rand(u32);

impl Rand {
    pub fn new(seed: u32) -> Rand {
        Rand(seed)
    }

    pub fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(1 | t);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64 / 4_294_967_296.0) as f32
    }
}

struct Held {
    shape: Vec<f32>,
    target: Vec<f32>,
    inside: Vec<bool>,
}

/// The 2D wave equation on 7px cells, 9-point Laplacian, absorbing edges.
pub struct Water {
    pub cols: usize,
    pub rows: usize,
    current: Vec<f32>,
    previous: Vec<f32>,
    next: Vec<f32>,
    damping: Vec<f32>,
    last_peak: f32,
    held: Option<Held>,
    hold_height: f32,
}

impl Water {
    pub fn new(width: f32, height: f32) -> Water {
        let cols = ((width / WATER_CELL).ceil() as usize).max(3);
        let rows = ((height / WATER_CELL).ceil() as usize).max(3);
        let mut damping = vec![0.0; cols * rows];
        for y in 0..rows {
            for x in 0..cols {
                let edge = x.min(y).min(cols - 1 - x).min(rows - 1 - y) as f32;
                let k = (edge / EDGE_CELLS).min(1.0);
                damping[y * cols + x] =
                    EDGE_DAMPING + (DAMPING - EDGE_DAMPING) * (k * k * (3.0 - 2.0 * k));
            }
        }
        Water {
            cols,
            rows,
            current: vec![0.0; cols * rows],
            previous: vec![0.0; cols * rows],
            next: vec![0.0; cols * rows],
            damping,
            last_peak: 0.0,
            held: None,
            hold_height: 0.0,
        }
    }

    pub fn splash(&mut self, x: f32, y: f32, amplitude: f32, radius: f32) {
        self.last_peak = self.last_peak.max(amplitude);
        let cx = x / WATER_CELL;
        let cy = y / WATER_CELL;
        let reach = (radius * 3.0).ceil();
        let two_r2 = 2.0 * radius * radius;
        let r0 = ((cy - reach).floor() as i64).max(1) as usize;
        let r1 = ((cy + reach).ceil() as i64).min(self.rows as i64 - 2);
        let c0 = ((cx - reach).floor() as i64).max(1) as usize;
        let c1 = ((cx + reach).ceil() as i64).min(self.cols as i64 - 2);
        if r1 < r0 as i64 || c1 < c0 as i64 {
            return;
        }
        for row in r0..=r1 as usize {
            for col in c0..=c1 as usize {
                let d2 = (col as f32 - cx).powi(2) + (row as f32 - cy).powi(2);
                self.current[row * self.cols + col] += amplitude * (-d2 / two_r2).exp();
            }
        }
    }

    /// Holds the water to `shape` (each cell's share, 0–1) at `set_hold_height`;
    /// `None` lets it go, raised `burst` times so one ring leaves it.
    pub fn hold(&mut self, shape: Option<Vec<f32>>, burst: f32) {
        let Some(shape) = shape else {
            if let Some(held) = self.held.take()
                && burst != 1.0
            {
                let standing = held
                    .inside
                    .iter()
                    .zip(&self.current)
                    .filter(|(inside, _)| **inside)
                    .map(|(_, h)| *h)
                    .fold(0.0f32, f32::max);
                for field in [&mut self.current, &mut self.previous] {
                    for ((h, inside), share) in field.iter_mut().zip(&held.inside).zip(&held.shape)
                    {
                        if *inside {
                            *h = 0.0;
                        }
                        let solid = if *share > 0.3 { 1.0 } else { 0.0 };
                        *h += standing * solid * burst;
                    }
                }
            }
            return;
        };
        let w = self.cols;
        let mut inside = vec![false; shape.len()];
        for (i, share) in shape.iter().enumerate() {
            if *share < 0.002 {
                continue;
            }
            let cx = (i % w) as i32;
            let cy = (i / w) as i32;
            for dy in -HOLD_MARGIN..=HOLD_MARGIN {
                for dx in -HOLD_MARGIN..=HOLD_MARGIN {
                    let x = cx + dx;
                    let y = cy + dy;
                    if x > 0 && y > 0 && x < w as i32 - 1 && y < self.rows as i32 - 1 {
                        inside[y as usize * w + x as usize] = true;
                    }
                }
            }
        }
        let g = &shape;
        let mut target = vec![0.0; shape.len()];
        for i in 0..shape.len() {
            if !inside[i] {
                continue;
            }
            let laplacian = (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) * 0.5
                + (g[i - w - 1] + g[i - w + 1] + g[i + w - 1] + g[i + w + 1]) * 0.25
                - 3.0 * g[i];
            let d = self.damping[i];
            target[i] = g[i] + ((g[i] * (1.0 - d)) / d - C2 * laplacian) / HOLD_SPRING;
        }
        self.held = Some(Held {
            shape,
            target,
            inside,
        });
    }

    pub fn set_hold_height(&mut self, height: f32) {
        self.hold_height = height;
    }

    /// The surface at (x, y) logical px, bilinear between water cells.
    pub fn height_at(&self, x: f32, y: f32) -> f32 {
        let fx = (x / WATER_CELL - 0.5).clamp(0.0, (self.cols - 1) as f32);
        let fy = (y / WATER_CELL - 0.5).clamp(0.0, (self.rows - 1) as f32);
        let x0 = fx.floor() as usize;
        let y0 = fy.floor() as usize;
        let x1 = (x0 + 1).min(self.cols - 1);
        let y1 = (y0 + 1).min(self.rows - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let c = &self.current;
        let a = c[y0 * self.cols + x0] * (1.0 - tx) + c[y0 * self.cols + x1] * tx;
        let b = c[y1 * self.cols + x0] * (1.0 - tx) + c[y1 * self.cols + x1] * tx;
        a * (1.0 - ty) + b * ty
    }

    /// The held shape's own standing height at (x, y), so the word's slope moves no glyph.
    pub fn held_at(&self, x: f32, y: f32) -> f32 {
        let Some(held) = &self.held else {
            return 0.0;
        };
        let col = ((x / WATER_CELL) as usize).min(self.cols - 1);
        let row = ((y / WATER_CELL) as usize).min(self.rows - 1);
        held.shape[row * self.cols + col] * self.hold_height
    }

    pub fn off_rest(&self, x: f32, y: f32) -> f32 {
        if x < 0.0 || y < 0.0 {
            return 0.0;
        }
        let col = (x / WATER_CELL) as usize;
        let row = (y / WATER_CELL) as usize;
        if col >= self.cols || row >= self.rows {
            return 0.0;
        }
        let i = row * self.cols + col;
        self.current[i]
            - self
                .held
                .as_ref()
                .map_or(0.0, |h| h.shape[i] * self.hold_height)
    }

    pub fn step(&mut self) -> f32 {
        let w = self.cols;
        let calmness = ((CALM_FROM - self.last_peak) / (CALM_FROM - CALM_FULL)).clamp(0.0, 1.0);
        let calm = 1.0 - CALM_DAMPING * calmness * calmness * (3.0 - 2.0 * calmness);
        let height = self.hold_height;
        let mut peak = 0.0f32;
        let c = &self.current;
        let p = &self.previous;
        let n = &mut self.next;
        let d = &self.damping;
        for y in 1..self.rows - 1 {
            let row = y * w;
            for x in 1..w - 1 {
                let i = row + x;
                let laplacian = (c[i - 1] + c[i + 1] + c[i - w] + c[i + w]) * 0.5
                    + (c[i - w - 1] + c[i - w + 1] + c[i + w - 1] + c[i + w + 1]) * 0.25
                    - 3.0 * c[i];
                let mut value = 2.0 * c[i] - p[i] + C2 * laplacian;
                if let Some(held) = &self.held
                    && held.inside[i]
                {
                    value += HOLD_SPRING * (height * held.target[i] - c[i])
                        - HOLD_DAMPING * (c[i] - p[i]);
                }
                value *= d[i] * calm;
                n[i] = value;
                peak = peak.max(value.abs());
            }
        }
        std::mem::swap(&mut self.previous, &mut self.current);
        std::mem::swap(&mut self.current, &mut self.next);
        self.last_peak = peak;
        peak
    }

    pub fn clear(&mut self) {
        self.current.fill(0.0);
        self.previous.fill(0.0);
        self.last_peak = 0.0;
    }
}

struct Drop {
    y: f32,
    speed: f32,
    length: f32,
    fade: f32,
    broken: bool,
}

struct Column {
    drops: Vec<Drop>,
    wait: f32,
}

/// The loading rain: per cell, (trail 0–255, head 0–255).
pub struct Rain {
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<[u8; 2]>,
    columns: Vec<Column>,
    pub falling: bool,
    level: f32,
    rand: Rand,
}

impl Rain {
    pub fn new(cols: usize, rows: usize, seed: u32) -> Rain {
        Rain {
            cols,
            rows,
            cells: vec![[0, 0]; cols * rows],
            columns: Vec::new(),
            falling: false,
            level: 0.0,
            rand: Rand::new(seed),
        }
    }

    fn life(&self) -> f32 {
        (self.rows as f32 + 17.0) / 21.0
    }

    fn gap(&self) -> f32 {
        self.life() * (1.0 - RAIN_DENSITY) / RAIN_DENSITY
    }

    pub fn start(&mut self) {
        if self.falling {
            return;
        }
        self.falling = true;
        let gap = self.gap();
        self.columns = (0..self.cols)
            .map(|_| Column {
                drops: Vec::new(),
                wait: if self.rand.next() < RAIN_DENSITY {
                    self.rand.next() * 0.9
                } else {
                    self.rand.next() * gap
                },
            })
            .collect();
    }

    pub fn stop(&mut self) {
        self.falling = false;
    }

    pub fn tick(&mut self, dt: f32, off_rest: impl Fn(usize, f32) -> f32) -> bool {
        let to = if self.falling { 1.0 } else { 0.0 };
        let tau = if self.falling { 0.05 } else { 0.1 };
        self.level += (to - self.level) * (1.0 - (-dt / tau).exp());
        self.cells.fill([0, 0]);
        if !self.falling && self.level < 0.01 {
            self.level = 0.0;
            self.columns.clear();
            return false;
        }
        let gap = self.gap();
        let mut lit = false;
        let (cols, rows) = (self.cols, self.rows);
        for col in 0..self.columns.len() {
            let column = &mut self.columns[col];
            column.wait -= dt;
            let room = column
                .drops
                .last()
                .is_none_or(|last| last.y - last.length > 2.0);
            if self.falling && column.wait <= 0.0 && column.drops.len() < 2 && room {
                column.drops.push(Drop {
                    y: -self.rand.next() * 4.0,
                    speed: 11.0 + self.rand.next() * 20.0,
                    length: 7.0 + self.rand.next() * 20.0,
                    fade: 1.0,
                    broken: false,
                });
                column.wait = gap * (0.3 + self.rand.next() * 1.4);
            }
            let mut k = column.drops.len();
            while k > 0 {
                k -= 1;
                let drop = &mut column.drops[k];
                drop.y += drop.speed * dt;
                if !drop.broken && off_rest(col, drop.y).abs() > RAIN_BREAK {
                    drop.broken = true;
                    column.wait = column.wait.min(0.25 + self.rand.next() * 0.9);
                }
                if drop.broken {
                    drop.fade -= dt * 4.0;
                }
                if drop.fade <= 0.0 || drop.y - drop.length > rows as f32 {
                    column.drops.swap_remove(k);
                    continue;
                }
                lit = true;
                let head = drop.y.floor() as i64;
                let strength = drop.fade * self.level;
                let from = (head - drop.length.ceil() as i64).max(0);
                let to = head.min(rows as i64 - 1);
                for row in from..=to {
                    let trail = (1.0 - (drop.y - row as f32) / drop.length).max(0.0);
                    let at = row as usize * cols + col;
                    let cell = &mut self.cells[at];
                    cell[0] = cell[0].max((255.0 * strength * trail.powf(1.25)).round() as u8);
                    if row == head {
                        cell[1] = cell[1].max((255.0 * strength).round() as u8);
                    }
                }
            }
        }
        lit || self.falling
    }
}

/// One shaped character, ready for `paint_glyph`.
#[derive(Clone, Copy)]
struct Glyph {
    font: FontId,
    id: GlyphId,
    advance: f32,
    ascent: f32,
    descent: f32,
}

/// One frame's numbers.
#[derive(Clone, Copy, Debug, Default)]
pub struct SeaFrame {
    pub interval_ms: f32,
    pub sim_ms: f32,
    pub paint_ms: f32,
    pub cells: u32,
    pub steps: u32,
}

pub struct Sea {
    pub width: f32,
    pub height: f32,
    pub cols: usize,
    pub rows: usize,
    origin: (f32, f32),
    chars: Vec<char>,
    own: Vec<u16>,
    live: Vec<u16>,
    letters: Vec<u16>,
    pub water: Water,
    pub rain: Rain,
    word_shape: Option<Vec<f32>>,
    word_cells: Vec<bool>,
    pub word_held: bool,
    word_time: f32,
    word_shown: f32,
    accumulated: f32,
    quiet_frames: u32,
    pub running: bool,
    last: Option<Instant>,
    rand: Rand,
    glyphs: HashMap<(u16, u8), Glyph>,
    dot_tile: Option<(bool, f32, Arc<RenderImage>)>,
    pub frames: Vec<SeaFrame>,
    pending: SeaFrame,
    drip: Option<f32>,
    /// `SEA_PAINT=full` covers every moving cell's resting dot and draws it
    /// where the slope moved it, as the shader does (two quads a cell); the
    /// default leaves the dots where they are and draws only the characters.
    pub full: bool,
}

/// Font sizes are quantized so the atlas holds a handful per character.
const SIZE_STEPS: u8 = 9;

fn centred_origin(extent: f32, cell: f32) -> f32 {
    let from_centre = extent / 2.0 - cell / 2.0;
    from_centre - cell * (from_centre / cell).floor()
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl Sea {
    pub fn new(width: f32, height: f32) -> Sea {
        let origin = (centred_origin(width, CELL), centred_origin(height, CELL));
        let cols = (((width - origin.0) / CELL).floor() as usize).max(1);
        let rows = (((height - origin.1) / CELL).floor() as usize).max(1);
        let text: Vec<char> = PASSAGE.chars().collect();
        let mut chars: Vec<char> = Vec::new();
        let mut index: HashMap<char, u16> = HashMap::new();
        let mut own = vec![0u16; cols * rows];
        for (i, slot) in own.iter_mut().enumerate() {
            let ch = text[i % text.len()];
            *slot = *index.entry(ch).or_insert_with(|| {
                chars.push(ch);
                (chars.len() - 1) as u16
            });
        }
        let letters = chars
            .iter()
            .enumerate()
            .filter(|(_, c)| c.is_alphanumeric())
            .map(|(i, _)| i as u16)
            .collect();
        Sea {
            width,
            height,
            cols,
            rows,
            origin,
            chars,
            live: own.clone(),
            own,
            letters,
            water: Water::new(width, height),
            rain: Rain::new(cols, rows, 7),
            word_shape: None,
            word_cells: vec![false; cols * rows],
            word_held: false,
            word_time: 0.0,
            word_shown: 0.0,
            accumulated: 0.0,
            quiet_frames: 0,
            running: false,
            last: None,
            rand: Rand::new(11),
            glyphs: HashMap::new(),
            dot_tile: None,
            frames: Vec::new(),
            pending: SeaFrame::default(),
            drip: None,
            full: std::env::var("SEA_PAINT").is_ok_and(|v| v == "full"),
        }
    }

    fn kick(&mut self) {
        if !self.running {
            self.running = true;
            self.quiet_frames = 0;
            self.last = None;
        }
    }

    pub fn drop_at(&mut self, x: f32, y: f32, amplitude: f32) {
        self.water.splash(x, y, amplitude, DROP_RADIUS);
        self.kick();
    }

    /// A pointer moving over the sea leaves a faint wake.
    pub fn wake(&mut self, from: (f32, f32), to: (f32, f32), dt: f32) {
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let distance = (dx * dx + dy * dy).sqrt();
        let speed = distance / dt.max(0.001);
        let amplitude = (speed * 0.00006).min(0.09);
        if amplitude > 0.006 {
            let steps = (distance / WATER_CELL).ceil().max(1.0) as usize;
            for i in 1..=steps {
                let t = i as f32 / steps as f32;
                self.water.splash(
                    from.0 + dx * t,
                    from.1 + dy * t,
                    amplitude / (steps as f32).sqrt(),
                    1.3,
                );
            }
            self.kick();
        }
    }

    /// Rasterizes "Loading" in a bold old serif onto the water grid (SVG text
    /// through GPUI's resvg), about 30% of the window high, ≤ 70% wide.
    fn word(&mut self, cx: &App) -> Option<Vec<f32>> {
        let samples = 4.0;
        let (cols, rows) = (self.water.cols, self.water.rows);
        let w = cols as f32 * samples;
        let h = rows as f32 * samples;
        let scale = samples / WATER_CELL;
        let size = (self.height * 0.3).min(self.width * 0.7 / 3.6) * scale;
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><text x="{x}" y="{y}" font-family="Times New Roman, Tinos, Times, serif" font-weight="700" font-size="{size}" text-anchor="middle" fill="white">Loading</text></svg>"#,
            x = w / 2.0,
            y = h / 2.0 + size * 0.33,
        );
        // GPUI rasterizes SVGs at twice the asked scale.
        let image = cx
            .svg_renderer()
            .render_single_frame(svg.as_bytes(), 0.5)
            .ok()?;
        let bytes = image.as_bytes(0)?;
        let iw = image.size(0).width.0 as usize;
        let ih = image.size(0).height.0 as usize;
        let mut shape = vec![0.0f32; cols * rows];
        let s = samples as usize;
        for row in 0..rows {
            for col in 0..cols {
                let mut sum = 0u32;
                for j in 0..s {
                    for k in 0..s {
                        let (x, y) = (col * s + k, row * s + j);
                        if x < iw && y < ih {
                            sum += bytes[(y * iw + x) * 4 + 3] as u32;
                        }
                    }
                }
                shape[row * cols + col] = sum as f32 / (s * s * 255) as f32;
            }
        }
        Some(shape)
    }

    pub fn loading(&mut self, on: bool, cx: &App) {
        if on {
            if self.word_shape.is_none() {
                self.word_shape = self.word(cx);
                if let Some(shape) = &self.word_shape {
                    for row in 0..self.rows {
                        for col in 0..self.cols {
                            let (x, y) = self.cell_centre(col, row);
                            let wc = ((x / WATER_CELL) as usize).min(self.water.cols - 1);
                            let wr = ((y / WATER_CELL) as usize).min(self.water.rows - 1);
                            self.word_cells[row * self.cols + col] =
                                shape[wr * self.water.cols + wc] > 0.35;
                        }
                    }
                }
            }
            self.rain.start();
            if !self.word_held && self.word_shape.is_some() {
                self.word_held = true;
                self.word_time = 0.0;
                self.water.hold(self.word_shape.clone(), 1.0);
            }
            self.drip = Some(0.24);
        } else {
            self.rain.stop();
            if self.word_held {
                self.water.hold(None, WORD_BURST);
            }
            self.word_held = false;
            self.drip = None;
        }
        self.kick();
    }

    fn cell_centre(&self, col: usize, row: usize) -> (f32, f32) {
        (
            self.origin.0 + (col as f32 + 0.5) * CELL,
            self.origin.1 + (row as f32 + 0.5) * CELL,
        )
    }

    /// Moves the sea on to `now`; true while it needs another frame.
    pub fn advance(&mut self) -> bool {
        if !self.running {
            return false;
        }
        let now = Instant::now();
        let dt = self
            .last
            .map_or(1.0 / 60.0, |last| (now - last).as_secs_f32())
            .min(0.05);
        let interval = self.last.map(|last| (now - last).as_secs_f32() * 1000.0);
        self.last = Some(now);
        let started = Instant::now();
        let mut moving = false;
        if self.word_held {
            self.word_time += dt;
            let rise = 1.0 - (1.0 - (self.word_time / WORD_RISE).min(1.0)).powi(3);
            let height = WORD_HEIGHT
                * rise
                * (1.0 + WORD_SWELL * (std::f32::consts::TAU * self.word_time / WORD_BREATH).sin());
            self.word_shown = height;
            self.water.set_hold_height(height);
            moving = true;
        } else if self.word_shown > 0.0 {
            self.word_shown *= (-dt / 0.15).exp();
            if self.word_shown < 0.002 {
                self.word_shown = 0.0;
            }
            moving = true;
        }
        if let Some(wait) = &mut self.drip {
            *wait -= dt;
            if *wait <= 0.0 {
                *wait = 1.1;
                let x = self.width * (0.15 + 0.7 * self.rand.next());
                let y = self.height * (0.15 + 0.7 * self.rand.next());
                self.water.splash(x, y, 1.2, DROP_RADIUS);
            }
        }
        let (origin, water) = (self.origin, &self.water);
        let raining = self.rain.tick(dt, |col, row| {
            water.off_rest(origin.0 + (col as f32 + 0.5) * CELL, origin.1 + row * CELL)
        });
        moving |= raining;
        moving |= self.swap(dt);
        self.accumulated += dt;
        let steps = ((self.accumulated * STEP_RATE).floor() as u32).min(6);
        self.accumulated -= steps as f32 / STEP_RATE;
        let mut peak = 0.0f32;
        for _ in 0..steps {
            peak = peak.max(self.water.step());
        }
        if moving {
            self.quiet_frames = 0;
        } else if steps > 0 {
            self.quiet_frames = if peak < 0.004 {
                self.quiet_frames + 1
            } else {
                0
            };
        }
        self.pending = SeaFrame {
            interval_ms: interval.unwrap_or(0.0),
            sim_ms: started.elapsed().as_secs_f32() * 1000.0,
            steps,
            ..SeaFrame::default()
        };
        if self.quiet_frames > 20 {
            self.water.clear();
            self.running = false;
            self.live.copy_from_slice(&self.own);
            return false;
        }
        true
    }

    fn swap(&mut self, dt: f32) -> bool {
        if self.letters.is_empty() {
            return false;
        }
        let expected = self.own.len() as f32 * SWAP_SEA * dt;
        let count = expected.floor() as usize + usize::from(self.rand.next() < expected.fract());
        for _ in 0..count {
            let i = (self.rand.next() * self.own.len() as f32) as usize % self.own.len();
            let l = (self.rand.next() * self.letters.len() as f32) as usize % self.letters.len();
            self.own[i] = self.letters[l];
        }
        let mut changing = false;
        let word = self.word_shown > 0.05;
        for i in 0..self.live.len() {
            let [trail, head] = self.rain.cells[i];
            let mut rate = if head > 40 {
                SWAP_HEAD
            } else if trail > 20 {
                SWAP_TRAIL
            } else {
                0.0
            };
            if word && self.word_cells[i] {
                rate = rate.max(SWAP_WORD);
            }
            if rate > 0.0 {
                changing = true;
                if self.rand.next() < rate * dt {
                    let l = (self.rand.next() * self.letters.len() as f32) as usize
                        % self.letters.len();
                    self.live[i] = self.letters[l];
                }
            } else {
                self.live[i] = self.own[i];
            }
        }
        changing
    }

    fn glyph(&mut self, index: u16, step: u8, window: &mut Window) -> Option<Glyph> {
        if let Some(g) = self.glyphs.get(&(index, step)) {
            return Some(*g);
        }
        let size = CELL * GLYPH_SIZE * Self::step_scale(step);
        let text: SharedString = self.chars[index as usize].to_string().into();
        let run = TextRun {
            len: text.len(),
            font: font("Songti SC"),
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let line = window
            .text_system()
            .shape_line(text, px(size), &[run], None);
        let run = line.runs.first()?;
        let shaped = run.glyphs.first()?;
        let glyph = Glyph {
            font: run.font_id,
            id: shaped.id,
            advance: f32::from(line.width),
            ascent: f32::from(line.ascent),
            descent: f32::from(line.descent),
        };
        self.glyphs.insert((index, step), glyph);
        Some(glyph)
    }

    fn step_scale(step: u8) -> f32 {
        0.8 + 0.4 * step as f32 / (SIZE_STEPS - 1) as f32
    }

    /// The resting dots as one tile of 10 × 10 cells.
    fn dots(&mut self, theme: &Theme, scale: f32) -> Arc<RenderImage> {
        if let Some((dark, s, tile)) = &self.dot_tile
            && *dark == theme.dark
            && *s == scale
        {
            return tile.clone();
        }
        let n = (CELL * 10.0 * scale).round() as u32;
        let rest = if theme.dark { 0.09 } else { 0.075 };
        let ink = theme.sand_on(theme.ink[1], theme.paper_deep);
        let [r, g, b] = ink.to_u8();
        let mut image = image::RgbaImage::new(n, n);
        for y in 0..n {
            for x in 0..n {
                let lx = (x as f32 + 0.5) / scale;
                let ly = (y as f32 + 0.5) / scale;
                let fx = (lx / CELL).fract() - 0.5;
                let fy = (ly / CELL).fract() - 0.5;
                let d = ((fx * CELL).powi(2) + (fy * CELL).powi(2)).sqrt();
                let a = (1.0 - smoothstep(0.35, 0.95, d)) * rest;
                if a > 0.0 {
                    image.put_pixel(x, y, image::Rgba([b, g, r, (a * 255.0 + 0.5) as u8]));
                }
            }
        }
        let tile = render_image(image);
        self.dot_tile = Some((theme.dark, scale, tile.clone()));
        tile
    }

    /// Paints the sea into `bounds` (its origin is the sea's top left).
    pub fn paint(&mut self, bounds: Bounds<Pixels>, theme: &Theme, window: &mut Window) {
        let started = Instant::now();
        let ground = theme.paper_deep;
        window.paint_quad(gpui::fill(bounds, ground.solid()));
        let scale = window.scale_factor();
        let tile = self.dots(theme, scale);
        let span = CELL * 10.0;
        let o = bounds.origin;
        let (ox, oy) = (self.origin.0 - span, self.origin.1 - span);
        let mut ty = oy;
        while ty < self.height {
            let mut tx = ox;
            while tx < self.width {
                let b = Bounds {
                    origin: o + point(px(tx), px(ty)),
                    size: size(px(span), px(span)),
                };
                let _ = window.paint_image(
                    b.intersect(&bounds),
                    b,
                    Default::default(),
                    tile.clone(),
                    0,
                    false,
                );
                tx += span;
            }
            ty += span;
        }
        let mut cells = 0u32;
        if self.running {
            let rest = if theme.dark { 0.09 } else { 0.075 };
            let peak = if theme.dark { 0.58 } else { 0.62 };
            let word_h = self.word_shown;
            let st = WATER_CELL;
            for row in 0..self.rows {
                for col in 0..self.cols {
                    let i = row * self.cols + col;
                    let (cx_, cy_) = self.cell_centre(col, row);
                    let hc = self.water.height_at(cx_, cy_);
                    let [trail, head] = self.rain.cells[i];
                    let rx = trail as f32 / 255.0;
                    let ry = head as f32 / 255.0;
                    if hc.abs() < 0.004 && rx == 0.0 {
                        continue;
                    }
                    let gx = self.water.height_at(cx_ + st, cy_)
                        - self.water.height_at(cx_ - st, cy_)
                        - (self.water.held_at(cx_ + st, cy_) - self.water.held_at(cx_ - st, cy_))
                            * word_h.signum();
                    let gy = self.water.height_at(cx_, cy_ + st)
                        - self.water.height_at(cx_, cy_ - st)
                        - (self.water.held_at(cx_, cy_ + st) - self.water.held_at(cx_, cy_ - st))
                            * word_h.signum();
                    let lim = (0.3 + 0.4 * rx) * CELL;
                    let off = (
                        (gx * 26.0 * (1.0 + 1.5 * rx)).clamp(-lim, lim),
                        (gy * 26.0 * (1.0 + 1.5 * rx)).clamp(-lim, lim),
                    );
                    let cr = (hc * 3.0).clamp(-1.0, 1.0);
                    let s = smoothstep(0.04, 0.26, hc.abs()).max(0.7 * rx);
                    if s < 0.01 && off.0.abs() < 0.05 && off.1.abs() < 0.05 {
                        continue;
                    }
                    cells += 1;
                    let origin = o + point(px(cx_), px(cy_));
                    let ink = theme.ink[1]
                        .mix(theme.accent, (0.45 * s * cr.max(0.0) + 0.55 * ry).min(1.0));
                    let color = theme.sand_on(ink, ground);
                    let dot_a = rest * (1.0 - s);
                    if self.full {
                        // Cover the resting dot, then draw it where the slope moved it.
                        window.paint_quad(gpui::fill(
                            Bounds {
                                origin: origin - point(px(1.5), px(1.5)),
                                size: size(px(3.0), px(3.0)),
                            },
                            ground.solid(),
                        ));
                        if dot_a > 0.004 {
                            window.paint_quad(
                                gpui::fill(
                                    Bounds {
                                        origin: origin + point(px(off.0 - 0.8), px(off.1 - 0.8)),
                                        size: size(px(1.6), px(1.6)),
                                    },
                                    color.alpha(dot_a),
                                )
                                .corner_radii(px(0.8)),
                            );
                        }
                    }
                    let glyph_a = peak * (0.6 + 0.4 * cr.max(ry)) * s;
                    if glyph_a > 0.01 {
                        let sc = 1.0 + 0.2 * cr;
                        let step = (((sc - 0.8) / 0.4) * (SIZE_STEPS - 1) as f32)
                            .round()
                            .clamp(0.0, (SIZE_STEPS - 1) as f32)
                            as u8;
                        if let Some(g) = self.glyph(self.live[i], step, window) {
                            let at = origin
                                + point(
                                    px(off.0 - g.advance / 2.0),
                                    px(off.1 + (g.ascent - g.descent) / 2.0),
                                );
                            let size = px(CELL * GLYPH_SIZE * Self::step_scale(step));
                            let _ =
                                window.paint_glyph(at, g.font, g.id, size, color.alpha(glyph_a));
                        }
                    }
                }
            }
        }
        if self.running && self.pending.interval_ms > 0.0 {
            let mut frame = self.pending;
            frame.paint_ms = started.elapsed().as_secs_f32() * 1000.0;
            frame.cells = cells;
            self.frames.push(frame);
            if self.frames.len() > 20_000 {
                self.frames.drain(..10_000);
            }
            self.pending.interval_ms = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drop_spreads_as_a_ring_and_settles() {
        let mut water = Water::new(400.0, 400.0);
        water.splash(200.0, 200.0, 1.2, DROP_RADIUS);
        // About 0.45 water cells a step: after 30 steps the ring is ~95px out.
        for _ in 0..30 {
            water.step();
        }
        let ring_at = |r: f32| {
            (0..360)
                .map(|deg| {
                    let a = (deg as f32).to_radians();
                    water
                        .height_at(200.0 + r * a.cos(), 200.0 + r * a.sin())
                        .abs()
                })
                .fold(0.0f32, f32::max)
        };
        let ring = (70..130)
            .step_by(5)
            .map(|r| ring_at(r as f32))
            .fold(0.0f32, f32::max);
        let beyond = ring_at(170.0);
        assert!(
            ring > 0.05 && ring > 4.0 * beyond,
            "ring {ring} beyond {beyond}"
        );
        let mut peak = 1.0;
        for _ in 0..1500 {
            peak = water.step();
        }
        assert!(peak < 0.004, "peak after 15s = {peak}");
    }

    #[test]
    fn rain_lights_cells_while_it_falls() {
        let mut rain = Rain::new(40, 30, 3);
        rain.start();
        let mut lit = false;
        for _ in 0..120 {
            rain.tick(1.0 / 60.0, |_, _| 0.0);
            lit |= rain.cells.iter().any(|c| c[1] > 0);
        }
        assert!(lit);
        rain.stop();
        for _ in 0..120 {
            rain.tick(1.0 / 60.0, |_, _| 0.0);
        }
        assert!(rain.cells.iter().all(|c| c[0] == 0));
    }
}
