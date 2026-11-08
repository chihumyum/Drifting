//! The water under the sea: a surface over the window that a press splashes,
//! that can be held to a shape (the loading word), and that lets the shape go
//! as one ring.

use super::rain::js_round;

/// Steps of the water per second, whatever the display's frame rate.
pub const STEP_RATE: f32 = 100.0;
/// One cell of water in CSS px.
pub const WATER_CELL: f32 = 7.0;
// (wave speed in cells per step)²; with the 9-point Laplacian below a ring
// travels about 0.45 cells a step, about 310px a second.
const C2: f32 = 0.2;
// Damping per step inside, and how far in from each edge the water absorbs a
// wave instead of throwing it back.
const DAMPING: f32 = 0.992;
const EDGE_DAMPING: f32 = 0.9;
const EDGE_CELLS: f32 = 16.0;
// A 2D ring leaves a slow swell behind it. Once the whole surface is this
// calm, it settles faster still, so a single press is still water (and the
// loop stops) in about five seconds; rings that are still travelling, and
// drops that keep falling, are not touched.
const CALM_FROM: f32 = 0.3;
const CALM_FULL: f32 = 0.05;
const CALM_DAMPING: f32 = 0.015;
// Water held to a shape (the loading word): the spring that pulls it back and
// its own damping, and how many cells round the shape are pinned to it too, so
// nothing leaks from its edges.
const HOLD_SPRING: f32 = 0.03;
const HOLD_DAMPING: f32 = 0.04;
const HOLD_MARGIN: usize = 4;
// Let go with a burst, the word leaves from its outline only: its strokes are
// joined across gaps up to this share of its height and its holes filled, the
// edge softened over RELEASE_SOFTEN cells. For RELEASE_DRAIN_STEPS steps after,
// what lies more than RELEASE_DRAIN_DEPTH cells inside drinks its own water (at
// most RELEASE_DRAIN a step), so the middle sinks quietly instead of rebounding
// as a second ring.
const RELEASE_JOIN: f32 = 0.12;
const RELEASE_SOFTEN: usize = 1;
const RELEASE_DRAIN_DEPTH: usize = 2;
const RELEASE_DRAIN_STEPS: u32 = 80;
const RELEASE_DRAIN: f32 = 0.18;

/// A box blur of `radius` cells along the rows, then the columns, in place.
fn box_blur(field: &mut [f32], cols: usize, rows: usize, radius: usize) {
    if cols == 0 || rows == 0 {
        return;
    }
    let mut line = vec![0.0f32; cols.max(rows)];
    blur_pass(field, &mut line, rows, cols, radius, |row, col| {
        row * cols + col
    });
    blur_pass(field, &mut line, cols, rows, radius, |col, row| {
        row * cols + col
    });
}

/// One direction of `box_blur`: `count` lines of `length` cells, the cell
/// `k` of line `l` at `at(l, k)`. The sum runs in a double, as the 0.1
/// client's did.
fn blur_pass(
    field: &mut [f32],
    line: &mut [f32],
    count: usize,
    length: usize,
    radius: usize,
    at: impl Fn(usize, usize) -> usize,
) {
    let last = length - 1;
    let width = (2 * radius + 1) as f64;
    for l in 0..count {
        for (k, cell) in line[..length].iter_mut().enumerate() {
            *cell = field[at(l, k)];
        }
        let mut sum = 0.0f64;
        for k in 0..=2 * radius {
            // k - radius, clamped into the line
            sum += f64::from(line[k.saturating_sub(radius).min(last)]);
        }
        for k in 0..length {
            field[at(l, k)] = (sum / width) as f32;
            sum += f64::from(line[(k + radius + 1).min(last)])
                - f64::from(line[k.saturating_sub(radius)]);
        }
    }
}

/// Grows (`grow`) or shrinks a mask by `radius` cells, as a square, along the
/// rows then the columns.
fn morph(mask: &mut [bool], cols: usize, rows: usize, radius: usize, grow: bool) {
    if cols == 0 || rows == 0 {
        return;
    }
    let mut line = vec![false; cols.max(rows)];
    morph_pass(mask, &mut line, rows, cols, radius, grow, |row, col| {
        row * cols + col
    });
    morph_pass(mask, &mut line, cols, rows, radius, grow, |col, row| {
        row * cols + col
    });
}

/// One direction of `morph`, laid out as `blur_pass`.
fn morph_pass(
    mask: &mut [bool],
    line: &mut [bool],
    count: usize,
    length: usize,
    radius: usize,
    grow: bool,
    at: impl Fn(usize, usize) -> usize,
) {
    let last = length - 1;
    for l in 0..count {
        for (k, cell) in line[..length].iter_mut().enumerate() {
            *cell = mask[at(l, k)];
        }
        for k in 0..length {
            let reach = &line[k.saturating_sub(radius)..=(k + radius).min(last)];
            mask[at(l, k)] = if grow {
                reach.iter().any(|on| *on)
            } else {
                reach.iter().all(|on| *on)
            };
        }
    }
}

/// Fills whatever the mask encloses (a letter's counter): what the outside
/// cannot reach becomes part of it.
fn fill_holes(mask: &mut [bool], cols: usize, rows: usize) {
    if cols == 0 || rows == 0 {
        return;
    }
    let mut outside = vec![false; mask.len()];
    let mut queue: Vec<usize> = Vec::new();
    let visit = |i: usize, outside: &mut [bool], queue: &mut Vec<usize>| {
        if mask[i] || outside[i] {
            return;
        }
        outside[i] = true;
        queue.push(i);
    };
    for x in 0..cols {
        visit(x, &mut outside, &mut queue);
        visit((rows - 1) * cols + x, &mut outside, &mut queue);
    }
    for y in 0..rows {
        visit(y * cols, &mut outside, &mut queue);
        visit(y * cols + cols - 1, &mut outside, &mut queue);
    }
    while let Some(i) = queue.pop() {
        let x = i % cols;
        if x > 0 {
            visit(i - 1, &mut outside, &mut queue);
        }
        if x < cols - 1 {
            visit(i + 1, &mut outside, &mut queue);
        }
        if i >= cols {
            visit(i - cols, &mut outside, &mut queue);
        }
        if i + cols < mask.len() {
            visit(i + cols, &mut outside, &mut queue);
        }
    }
    for (cell, out) in mask.iter_mut().zip(&outside) {
        if !out {
            *cell = true;
        }
    }
}

/// The 9-point Laplacian of `g` at the inner cell `i` of a grid `w` wide.
fn laplacian(g: &[f32], i: usize, w: usize) -> f32 {
    (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) * 0.5
        + (g[i - w - 1] + g[i - w + 1] + g[i + w - 1] + g[i + w + 1]) * 0.25
        - 3.0 * g[i]
}

/// A shape the water is held to.
struct Held {
    /// Each water cell's share of the shape, 0..1.
    shape: Vec<f32>,
    /// What the spring pulls each cell towards, per unit of hold height.
    target: Vec<f32>,
    /// The shape's cells and HOLD_MARGIN round them: the cells the spring holds.
    inside: Vec<bool>,
}

/// The inside of a word just let go, drinking its own water for a while.
struct Drain {
    /// How much each cell drinks, 0..1.
    inside: Vec<f32>,
    steps: u32,
}

/// A water surface over the window: the 2D wave equation on a grid of 7px
/// cells, with a 9-point Laplacian so rings stay round, and absorbing edges.
pub struct Water {
    pub cols: usize,
    pub rows: usize,
    width: f32,
    height: f32,
    current: Vec<f32>,
    previous: Vec<f32>,
    next: Vec<f32>,
    damping: Vec<f32>,
    last_peak: f32,
    held: Option<Held>,
    hold_height: f32,
    drain: Option<Drain>,
}

/// Water cells across `extent` CSS px, at least three.
fn water_cells(extent: f32) -> usize {
    let count = (extent / WATER_CELL).ceil();
    if count > 3.0 { count as usize } else { 3 }
}

impl Water {
    /// Still water over a window `width` × `height` CSS px.
    pub fn new(width: f32, height: f32) -> Water {
        let cols = water_cells(width);
        let rows = water_cells(height);
        let size = cols * rows;
        let mut damping = vec![0.0f32; size];
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
            width,
            height,
            current: vec![0.0; size],
            previous: vec![0.0; size],
            next: vec![0.0; size],
            damping,
            last_peak: 0.0,
            held: None,
            hold_height: 0.0,
            drain: None,
        }
    }

    /// The surface's height per cell, row by row.
    pub fn heights(&self) -> &[f32] {
        &self.current
    }

    /// Holds the water to a shape (each water cell's share of it, 0..1, row by
    /// row) raised to `set_hold_height`, by a spring with its own damping;
    /// `None` lets it go, and the shape spreads as rings. With a `burst` other
    /// than 1 it leaves as one ring from its outline, raised `burst` times so
    /// it carries further (`release`). The spring's target is compensated with
    /// the same Laplacian and damping `step` uses, so at rest the water stands
    /// exactly at shape × height, and whatever knocks it settles back.
    ///
    /// A shape of the wrong length is cut or padded with zeros to the grid.
    pub fn hold(&mut self, shape: Option<Vec<f32>>, burst: f32) {
        let Some(mut shape) = shape else {
            if let Some(held) = self.held.take()
                && burst != 1.0
            {
                self.release(&held, burst);
            }
            return;
        };
        let w = self.cols;
        let rows = self.rows;
        shape.resize(w * rows, 0.0);
        let mut inside = vec![false; shape.len()];
        for (i, share) in shape.iter().enumerate() {
            if *share < 0.002 {
                continue;
            }
            let cx = i % w;
            let cy = i / w;
            // the cells within HOLD_MARGIN of it, short of the grid's border
            for y in cy.saturating_sub(HOLD_MARGIN).max(1)..=(cy + HOLD_MARGIN).min(rows - 2) {
                for x in cx.saturating_sub(HOLD_MARGIN).max(1)..=(cx + HOLD_MARGIN).min(w - 2) {
                    inside[y * w + x] = true;
                }
            }
        }
        let g = &shape;
        let mut target = vec![0.0f32; shape.len()];
        for (i, cell) in target.iter_mut().enumerate() {
            if !inside[i] {
                continue;
            }
            let d = self.damping[i];
            *cell = g[i] + ((g[i] * (1.0 - d)) / d - C2 * laplacian(g, i, w)) / HOLD_SPRING;
        }
        self.held = Some(Held {
            shape,
            target,
            inside,
        });
    }

    /// Whether the water is held to a shape.
    pub fn is_held(&self) -> bool {
        self.held.is_some()
    }

    /// The held word let go as one: only its outer outline leaves. Its strokes
    /// are joined across the gaps between letters and its holes filled, so the
    /// outline keeps the letters' corners but none of their inner edges. That
    /// silhouette stands as high as the strokes stood, raised `burst` times,
    /// and for a moment its inside drinks its own water, so one ring goes out.
    fn release(&mut self, held: &Held, burst: f32) {
        let (cols, rows) = (self.cols, self.rows);
        let mut solid = vec![false; held.shape.len()];
        let mut top = rows;
        let mut bottom = None;
        for (i, share) in held.shape.iter().enumerate() {
            if *share <= 0.3 {
                continue;
            }
            solid[i] = true;
            let row = i / cols;
            top = top.min(row);
            bottom = Some(bottom.map_or(row, |bottom: usize| bottom.max(row)));
        }
        let Some(bottom) = bottom else {
            return;
        };
        let join = (js_round((bottom - top + 1) as f32 * RELEASE_JOIN) as usize).max(1);
        morph(&mut solid, cols, rows, join, true);
        morph(&mut solid, cols, rows, join, false);
        fill_holes(&mut solid, cols, rows);
        let mut inner = solid.clone();
        morph(&mut inner, cols, rows, RELEASE_DRAIN_DEPTH, false);
        let to_field = |mask: &[bool]| -> Vec<f32> {
            mask.iter().map(|on| if *on { 1.0 } else { 0.0 }).collect()
        };
        let mut silhouette = to_field(&solid);
        let mut drain = to_field(&inner);
        box_blur(&mut silhouette, cols, rows, RELEASE_SOFTEN);
        box_blur(&mut drain, cols, rows, RELEASE_SOFTEN);
        let standing = held
            .inside
            .iter()
            .zip(&self.current)
            .filter(|(inside, _)| **inside)
            .fold(
                0.0f32,
                |standing, (_, h)| if *h > standing { *h } else { standing },
            );
        for field in [&mut self.current, &mut self.previous] {
            for ((h, inside), s) in field.iter_mut().zip(&held.inside).zip(&silhouette) {
                if *inside {
                    *h = 0.0;
                }
                *h += standing * s * burst;
            }
        }
        self.drain = Some(Drain {
            inside: drain,
            steps: RELEASE_DRAIN_STEPS,
        });
    }

    /// How high the held shape stands now.
    pub fn set_hold_height(&mut self, height: f32) {
        self.hold_height = height;
    }

    /// The water cell under (x, y) CSS px, if it is on the grid.
    fn cell_at(&self, x: f32, y: f32) -> Option<usize> {
        let col = (x / WATER_CELL).floor();
        let row = (y / WATER_CELL).floor();
        if col >= 0.0 && row >= 0.0 && col < self.cols as f32 && row < self.rows as f32 {
            Some(row as usize * self.cols + col as usize)
        } else {
            None
        }
    }

    /// How far the water at (x, y) CSS px stands from its rest; a held shape
    /// counts as rest. Off the grid it is at rest.
    pub fn off_rest(&self, x: f32, y: f32) -> f32 {
        let Some(i) = self.cell_at(x, y) else {
            return 0.0;
        };
        let rest = self
            .held
            .as_ref()
            .map_or(0.0, |held| self.hold_height * held.shape[i]);
        self.current[i] - rest
    }

    /// A Gaussian bump at (x, y) CSS px; it spreads as a ring.
    pub fn splash(&mut self, x: f32, y: f32, amplitude: f32, radius_cells: f32) {
        self.last_peak = self.last_peak.max(amplitude);
        let cx = x / WATER_CELL;
        let cy = y / WATER_CELL;
        let reach = (radius_cells * 3.0).ceil();
        let two_r2 = 2.0 * radius_cells * radius_cells;
        let row_from = ((cy - reach).floor() as i64).max(1);
        let row_to = ((cy + reach).ceil() as i64).min(self.rows as i64 - 2);
        let col_from = ((cx - reach).floor() as i64).max(1);
        let col_to = ((cx + reach).ceil() as i64).min(self.cols as i64 - 2);
        for row in row_from..=row_to {
            for col in col_from..=col_to {
                let dx = col as f32 - cx;
                let dy = row as f32 - cy;
                let d2 = dx * dx + dy * dy;
                self.current[row as usize * self.cols + col as usize] +=
                    amplitude * (-d2 / two_r2).exp();
            }
        }
    }

    /// One step of the wave equation; returns the largest height left.
    pub fn step(&mut self) -> f32 {
        let w = self.cols;
        let rows = self.rows;
        let drinking = self.drain.as_ref().map_or(0.0, |drain| {
            RELEASE_DRAIN * drain.steps as f32 / RELEASE_DRAIN_STEPS as f32
        });
        let calmness = ((CALM_FROM - self.last_peak) / (CALM_FROM - CALM_FULL)).clamp(0.0, 1.0);
        let calm = 1.0 - CALM_DAMPING * calmness * calmness * (3.0 - 2.0 * calmness);
        let height = self.hold_height;
        let c = &self.current;
        let p = &self.previous;
        let n = &mut self.next;
        let d = &self.damping;
        let held = self.held.as_ref();
        let drain = self.drain.as_ref();
        let mut peak = 0.0f32;
        for y in 1..rows - 1 {
            let row_start = y * w;
            for x in 1..w - 1 {
                let i = row_start + x;
                let mut value = 2.0 * c[i] - p[i] + C2 * laplacian(c, i, w);
                // a held shape's spring pulls its water back to the shape and calms it
                if let Some(held) = held
                    && held.inside[i]
                {
                    value += HOLD_SPRING * (height * held.target[i] - c[i])
                        - HOLD_DAMPING * (c[i] - p[i]);
                }
                value *= d[i] * calm;
                if let Some(drain) = drain {
                    value *= 1.0 - drinking * drain.inside[i];
                }
                n[i] = value;
                let magnitude = value.abs();
                if magnitude > peak {
                    peak = magnitude;
                }
            }
        }
        // previous ← current ← next ← previous
        std::mem::swap(&mut self.previous, &mut self.current);
        std::mem::swap(&mut self.current, &mut self.next);
        self.last_peak = peak;
        if let Some(drain) = &mut self.drain {
            drain.steps = drain.steps.saturating_sub(1);
            if drain.steps == 0 {
                self.drain = None;
            }
        }
        peak
    }

    /// Still water again (a held shape stays held).
    pub fn clear(&mut self) {
        self.current.fill(0.0);
        self.previous.fill(0.0);
        self.next.fill(0.0);
        self.last_peak = 0.0;
        self.drain = None;
    }

    /// The height at (x, y) CSS px as the 0.1 shader read it:
    /// `texture(uH, p / uWin)` with LINEAR filtering and CLAMP_TO_EDGE, i.e. a
    /// bilinear sample where the `cols × rows` texels span exactly
    /// `width × height` (texel centres at (i + 0.5) · width / cols — note this
    /// is not exactly WATER_CELL).
    pub fn sample(&self, x: f32, y: f32) -> f32 {
        bilinear(
            &self.current,
            self.cols,
            self.rows,
            self.width,
            self.height,
            x,
            y,
        )
    }
}

/// The texels either side of `texel` (in texel units from the first centre),
/// clamped to the edge, and the weight of the second.
fn texel_span(texel: f32, count: usize) -> (usize, usize, f32) {
    let last = count - 1;
    let texel = if texel.is_nan() {
        0.0
    } else {
        texel.clamp(0.0, last as f32)
    };
    let first = (texel.floor() as usize).min(last);
    (first, (first + 1).min(last), texel - first as f32)
}

/// The same bilinear LINEAR/CLAMP_TO_EDGE sample over any `cols × rows` grid
/// of `values` (row by row) spanning `width × height` CSS px. Values missing
/// from a short slice read as 0.
pub fn bilinear(
    values: &[f32],
    cols: usize,
    rows: usize,
    width: f32,
    height: f32,
    x: f32,
    y: f32,
) -> f32 {
    if cols == 0 || rows == 0 {
        return 0.0;
    }
    let (x0, x1, tx) = texel_span(x / width * cols as f32 - 0.5, cols);
    let (y0, y1, ty) = texel_span(y / height * rows as f32 - 0.5, rows);
    let at = |col: usize, row: usize| values.get(row * cols + col).copied().unwrap_or(0.0);
    let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
    let bottom = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
    top * (1.0 - ty) + bottom * ty
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fixtures::steps;
    use std::f64::consts::PI;

    /// `Math.round`: halves go up.
    fn round(x: f64) -> f64 {
        let floor = x.floor();
        if x - floor >= 0.5 { floor + 1.0 } else { floor }
    }

    /// How far the wave front has travelled along a direction, in CSS px.
    fn front_distance(water: &Water, cx: f64, cy: f64, angle: f64) -> f64 {
        let mut front = 0.0;
        let mut r = 0.0;
        while r < 80.0 {
            let x = round(cx + angle.cos() * r);
            let y = round(cy + angle.sin() * r);
            if x < 0.0 || y < 0.0 || x >= water.cols as f64 || y >= water.rows as f64 {
                break;
            }
            if water.heights()[y as usize * water.cols + x as usize].abs() > 0.05 {
                front = r;
            }
            r += 0.5;
        }
        front * f64::from(WATER_CELL)
    }

    /// A word of strokes `stroke` cells wide with gaps as wide between them,
    /// held at 0.45 for a second and a half.
    fn held_word(stroke: usize) -> Water {
        let mut water = Water::new(960.0, 600.0);
        let mut shape = vec![0.0f32; water.cols * water.rows];
        for y in 36..50 {
            for x in 30..107 {
                if (x / stroke).is_multiple_of(2) {
                    shape[y * water.cols + x] = 1.0;
                }
            }
        }
        water.hold(Some(shape), 1.0);
        water.set_hold_height(0.45);
        for _ in 0..steps(1.5) {
            water.step();
        }
        water
    }

    /// A cell at the window's left side, level with the word.
    fn side(water: &Water) -> usize {
        (300.0 / WATER_CELL).floor() as usize * water.cols + (60.0 / WATER_CELL).floor() as usize
    }

    #[test]
    fn spreads_a_press_as_a_round_ring_at_about_310px_a_second() {
        let mut water = Water::new(960.0, 600.0);
        water.splash(480.0, 300.0, 1.2, 2.2);
        for _ in 0..steps(0.5) {
            water.step();
        }
        let cx = 480.0 / f64::from(WATER_CELL);
        let cy = 300.0 / f64::from(WATER_CELL);
        let along = front_distance(&water, cx, cy, 0.0);
        let diagonal = front_distance(&water, cx, cy, PI / 4.0);
        assert!(along > 130.0, "{along}");
        assert!(along < 200.0, "{along}");
        assert!(
            (diagonal - along).abs() / along < 0.12,
            "{diagonal} vs {along}"
        );
    }

    #[test]
    fn keeps_a_ring_in_sight_for_a_second_and_a_half_then_goes_still_within_six() {
        let mut water = Water::new(960.0, 600.0);
        water.splash(480.0, 300.0, 1.2, 2.2);
        let mut peak = f32::INFINITY;
        for _ in 0..steps(1.5) {
            peak = water.step();
        }
        assert!(peak > 0.1, "{peak}");
        for _ in 0..steps(4.5) {
            peak = water.step();
        }
        assert!(peak < 0.004, "{peak}");
    }

    #[test]
    fn holds_the_water_to_the_loading_word_settles_back_after_a_ring_and_spreads_when_let_go() {
        let mut water = Water::new(480.0, 300.0);
        let mut shape = vec![0.0f32; water.cols * water.rows];
        for y in 18..24 {
            for x in 24..44 {
                shape[y * water.cols + x] = 1.0;
            }
        }
        let at = (34.0 * WATER_CELL + 3.0, 21.0 * WATER_CELL + 3.0);
        let centre = 21 * water.cols + 34;
        water.hold(Some(shape), 1.0);
        assert!(water.is_held());
        water.set_hold_height(0.45);
        for _ in 0..steps(3.0) {
            water.step();
        }
        // toBeCloseTo(0.45, 2)
        let standing = water.heights()[centre];
        assert!((standing - 0.45).abs() < 0.005, "{standing}");
        assert!(water.off_rest(at.0, at.1).abs() < 0.01);
        assert!(water.heights()[5 * water.cols + 5].abs() < 0.005);

        water.splash(at.0, at.1, 1.2, 2.2);
        for _ in 0..steps(0.05) {
            water.step();
        }
        assert!(water.off_rest(at.0, at.1).abs() > 0.1);
        for _ in 0..steps(2.0) {
            water.step();
        }
        assert!(water.off_rest(at.0, at.1).abs() < 0.02);

        water.hold(None, 1.0);
        assert!(!water.is_held());
        for _ in 0..steps(0.5) {
            water.step();
        }
        assert!(water.heights()[centre] < 0.2);
    }

    #[test]
    fn bursts_a_held_word_into_rings_that_reach_the_sides_when_it_is_let_go() {
        let reach = |burst: f32| {
            let mut water = held_word(3);
            water.hold(None, burst);
            let side = side(&water);
            let mut peak = 0.0f32;
            for _ in 0..steps(3.0) {
                water.step();
                peak = peak.max(water.heights()[side].abs());
            }
            peak
        };
        // A burst leaves from the word's outline only, so it carries further
        // than letting go plainly, and at the loading word's strength (4)
        // further still.
        let plain = reach(1.0);
        let twice = reach(2.0);
        let four = reach(4.0);
        assert!(twice > plain * 1.6, "{twice} vs {plain}");
        assert!(four > 0.4, "{four}");
    }

    /// Along the word's middle row: how many separate stretches stand above
    /// half its top.
    fn stretches(water: &Water) -> usize {
        let row = 43 * water.cols;
        let h = water.heights();
        let top = (20..117).fold(0.0f32, |top, x| top.max(h[row + x]));
        (20..117)
            .filter(|x| h[row + x] > top / 2.0 && h[row + x - 1] <= top / 2.0)
            .count()
    }

    /// Lets the held word go with `burst` (and the inside drinking its own
    /// water, or for comparison not); returns how high its middle stands after
    /// the first 0.4s, and how high the ring reaches at the side.
    fn let_go_as_one(burst: f32, drain: bool) -> (f32, f32) {
        // Strokes four cells wide with gaps between them, as letters stand.
        let mut water = held_word(4);
        assert!(stretches(&water) > 5);
        water.hold(None, burst);
        assert_eq!(stretches(&water), 1);
        if !drain {
            water.drain = None;
        }
        let middle = 43 * water.cols + 68;
        let side = side(&water);
        let mut late = 0.0f32;
        let mut reach = 0.0f32;
        for i in 0..steps(2.0) {
            water.step();
            if i as f32 > STEP_RATE * 0.4 {
                late = late.max(water.heights()[middle].abs());
            }
            reach = reach.max(water.heights()[side].abs());
        }
        (late, reach)
    }

    #[test]
    fn lets_a_held_word_go_as_one_swell_from_its_outline_and_its_middle_does_not_ring_again() {
        // The word stood at 0.9 when let go; its middle sinks and stays down
        // while the ring reaches the side.
        let (late, reach) = let_go_as_one(2.0, true);
        assert!(late < 0.1, "{late}");
        assert!(reach > 0.2, "{reach}");
    }

    #[test]
    fn lets_the_loading_word_go_at_its_own_burst_as_one_ring_without_a_second() {
        // The loading word lets go at 4, standing at 1.8: one swell from its
        // outline, and its middle stays within the ninth of that the test
        // above allows at 0.9, where without drinking its own water it would
        // rebound as a second ring several times as high.
        let (late, reach) = let_go_as_one(4.0, true);
        let (rebound, _) = let_go_as_one(4.0, false);
        assert!(late < 0.2, "{late}");
        assert!(rebound > late * 3.0, "{rebound} vs {late}");
        assert!(reach > 0.4, "{reach}");
    }

    #[test]
    fn letting_go_of_nothing_held_or_an_empty_shape_changes_nothing() {
        let mut water = Water::new(200.0, 100.0);
        water.splash(100.0, 50.0, 1.0, 2.0);
        let before = water.heights().to_vec();
        water.hold(None, 4.0);
        assert_eq!(water.heights(), before.as_slice());
        water.hold(Some(vec![0.0; 3]), 1.0);
        water.hold(None, 4.0);
        assert_eq!(water.heights(), before.as_slice());
        // a shape too long for the grid is cut to it
        water.hold(Some(vec![0.5; water.cols * water.rows + 50]), 1.0);
        water.set_hold_height(0.2);
        water.step();
        assert!(water.is_held());
    }

    #[test]
    fn off_rest_is_zero_off_the_grid() {
        let mut water = Water::new(70.0, 70.0);
        water.splash(35.0, 35.0, 1.0, 1.0);
        assert!(water.off_rest(35.0, 35.0) > 0.5);
        assert_eq!(water.off_rest(-1.0, 35.0), 0.0);
        assert_eq!(water.off_rest(35.0, 70.0), 0.0);
        assert_eq!(water.off_rest(f32::NAN, 35.0), 0.0);
    }

    #[test]
    fn clear_stills_the_water() {
        let mut water = Water::new(200.0, 100.0);
        water.splash(100.0, 50.0, 1.0, 2.0);
        water.step();
        water.clear();
        assert!(water.heights().iter().all(|h| *h == 0.0));
        assert_eq!(water.step(), 0.0);
    }

    #[test]
    fn samples_the_heights_as_the_shader_filtered_them() {
        // 3 × 2 texels over 30 × 10 px: centres at x 5, 15, 25 and y 2.5, 7.5.
        let values = [0.0, 1.0, 2.0, 10.0, 11.0, 12.0];
        let sample = |x, y| bilinear(&values, 3, 2, 30.0, 10.0, x, y);
        assert_eq!(sample(5.0, 2.5), 0.0);
        assert_eq!(sample(15.0, 7.5), 11.0);
        assert!((sample(10.0, 2.5) - 0.5).abs() < 1e-6);
        assert!((sample(20.0, 5.0) - 6.5).abs() < 1e-6);
        // clamped to the edge texels
        assert_eq!(sample(0.0, 0.0), 0.0);
        assert_eq!(sample(-50.0, 100.0), 10.0);
        assert_eq!(sample(30.0, 10.0), 12.0);
        assert_eq!(sample(f32::NAN, 2.5), 0.0);
        // a short slice reads as zeros past its end
        assert_eq!(bilinear(&values[..3], 3, 2, 30.0, 10.0, 15.0, 7.5), 0.0);
        assert_eq!(bilinear(&[], 0, 0, 30.0, 10.0, 1.0, 1.0), 0.0);
    }

    #[test]
    fn samples_its_own_grid_over_the_window_not_over_whole_water_cells() {
        // 100px wide: 15 cells of 100 / 15 ≈ 6.67px, not 7.
        let mut water = Water::new(100.0, 100.0);
        water.splash(50.0, 50.0, 1.0, 1.5);
        let texel = 100.0 / water.cols as f32;
        let (col, row) = (7usize, 7usize);
        let at = water.heights()[row * water.cols + col];
        let centre = (col as f32 + 0.5) * texel;
        assert!((water.sample(centre, centre) - at).abs() < 1e-6);
    }

    #[test]
    fn the_masks_join_strokes_and_fill_counters() {
        // An "O" 5 wide with a one-cell counter, and a stroke two cells to its right.
        let (cols, rows) = (12, 7);
        let mut mask = vec![false; cols * rows];
        for y in 1..6 {
            for x in 1..6 {
                mask[y * cols + x] = !(y == 3 && x == 3);
            }
            mask[y * cols + 8] = true;
        }
        let mut filled = mask.clone();
        fill_holes(&mut filled, cols, rows);
        assert!(filled[3 * cols + 3]);
        assert!(!filled[3 * cols + 7]);
        let mut joined = mask.clone();
        morph(&mut joined, cols, rows, 1, true);
        morph(&mut joined, cols, rows, 1, false);
        // the gap between the O and the stroke is closed; beyond the stroke stays open
        assert!(joined[3 * cols + 6] && joined[3 * cols + 7]);
        assert!(!joined[3 * cols + 10] && !joined[3 * cols + 11]);
    }

    #[test]
    fn the_box_blur_keeps_the_total_away_from_the_edges() {
        let (cols, rows) = (9, 9);
        let mut field = vec![0.0f32; cols * rows];
        field[4 * cols + 4] = 9.0;
        box_blur(&mut field, cols, rows, 1);
        for y in 3..6 {
            for x in 3..6 {
                assert!((field[y * cols + x] - 1.0).abs() < 1e-6);
            }
        }
        assert!((field.iter().sum::<f32>() - 9.0).abs() < 1e-5);
    }
}
