//! Sand for the shelf's writing heat map and the cards' 30-day strips (the
//! 0.1 client's `lib/sand-heat.ts`, docs/writing-days.md): a day written is
//! one press of a dry brush, larger and fuller the more words it holds; a
//! day without words is a few loose grains; a day in a strip is a short
//! upright stroke, pressed at its foot and drying toward the top.
//! Everything paints alpha into a mask; the colour is laid on when it is
//! shown, so a theme change needs no redraw. Every mark is seeded, so the
//! same day always lands the same.

use crate::art::paint::Rand;

/// An alpha mask in device pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct SandMask {
    pub width: usize,
    pub height: usize,
    pub dpr: f32,
    /// 0–255 per device pixel, row by row.
    pub alpha: Vec<u8>,
}

impl SandMask {
    /// `width` × `height` CSS px at `dpr`.
    pub fn new(width: f32, height: f32, dpr: f32) -> SandMask {
        let w = ((width * dpr + 0.5).floor() as usize).max(1);
        let h = ((height * dpr + 0.5).floor() as usize).max(1);
        SandMask {
            width: w,
            height: h,
            dpr,
            alpha: vec![0; w * h],
        }
    }

    /// Grains painted so far.
    pub fn coverage(&self) -> usize {
        self.alpha.iter().filter(|&&a| a > 0).count()
    }

    fn grain(&mut self, x: i64, y: i64, alpha: f32) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        let index = y as usize * self.width + x as usize;
        let value = (alpha.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8;
        if value > self.alpha[index] {
            self.alpha[index] = value;
        }
    }
}

fn hash(a: i64, b: i64, c: u32) -> f32 {
    let mut h = (a as i32 as u32).wrapping_mul(374_761_393)
        ^ (b as i32 as u32).wrapping_mul(668_265_263)
        ^ c.wrapping_mul(1_274_126_177);
    h = (h ^ (h >> 13)).wrapping_mul(1_103_515_245);
    h ^= h >> 16;
    (f64::from(h) / 4_294_967_296.0) as f32
}

/// 1 well inside `inner`, falling to 0 at `outer` (inner < outer).
fn falloff(outer: f32, inner: f32, x: f32) -> f32 {
    let t = ((x - outer) / (inner - outer)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn js_round(v: f32) -> i64 {
    (v + 0.5).floor() as i64
}

/// A day without words: a few loose grains round (`cx`, `cy`), in CSS px.
pub fn loose(mask: &mut SandMask, cx: f32, cy: f32, count: usize, alpha: f32, seed: u32) {
    let mut rand = Rand::new(seed);
    for _ in 0..count {
        let x = js_round((cx + (rand.next() - 0.5) * 3.2) * mask.dpr);
        let y = js_round((cy + (rand.next() - 0.5) * 3.2) * mask.dpr);
        let a = alpha * (0.6 + 0.4 * rand.next());
        mask.grain(x, y, a);
    }
}

/// One press of a dry brush: an uneven dot whose hairs streak along its
/// slant. (6.28 is the 0.1 client's number, not τ: the same marks.)
#[allow(clippy::approx_constant)]
pub fn dab(mask: &mut SandMask, cx: f32, cy: f32, size: f32, density: f32, seed: u32) {
    let r = (size / 2.0) * mask.dpr;
    let x0 = cx * mask.dpr;
    let y0 = cy * mask.dpr;
    let mut rand = Rand::new(seed);
    let tilt = -0.5 + (rand.next() - 0.5) * 0.6;
    let p0 = rand.next() * 6.28;
    let p1 = rand.next() * 6.28;
    let p2 = rand.next() * 6.28;
    let press = (rand.next() - 0.5) * 0.8;
    let (st, ct) = tilt.sin_cos();
    let mut py = (y0 - r - 2.0).floor() as i64;
    while py as f32 <= (y0 + r + 2.0).ceil() {
        let mut px = (x0 - r - 2.0).floor() as i64;
        while px as f32 <= (x0 + r + 2.0).ceil() {
            let dx = (px as f32 + 0.5 - x0) / r;
            let dy = (py as f32 + 0.5 - y0) / r;
            let angle = dy.atan2(dx);
            let edge = 0.92
                + 0.08 * (2.0 * angle + p0).sin()
                + 0.06 * (3.0 * angle + p1).sin()
                + 0.04 * (5.0 * angle + p2).sin();
            // Between a square and a circle: a brush dot, not a pixel.
            let distance = 0.55 * dx.abs().max(dy.abs()) + 0.45 * dx.hypot(dy);
            let inside = falloff(edge, edge - 0.3, distance);
            if inside > 0.0 {
                let along = dx * ct + dy * st;
                let across = -dx * st + dy * ct;
                let hair = 0.86 + 0.14 * (across * 10.0 + p0 * 3.0).sin();
                let p = (inside * density * hair * (1.16 - 0.22 * (along - press).abs()))
                    .clamp(0.0, 1.0);
                if hash(px, py, seed) <= p {
                    let a = 0.5 + 0.5 * hash(py, px, seed ^ 0x5bd1_e995);
                    mask.grain(px, py, a);
                }
            }
            px += 1;
        }
        py += 1;
    }
}

/// A short upright stroke from `base` up `height` CSS px, `width` wide at
/// its foot.
#[allow(clippy::approx_constant)]
pub fn bar(mask: &mut SandMask, x: f32, base: f32, width: f32, height: f32, seed: u32) {
    let dpr = mask.dpr;
    let x0 = x * dpr;
    let x1 = (x + width) * dpr;
    let yb = base * dpr;
    let yt = (base - height) * dpr;
    let mut rand = Rand::new(seed);
    let lean = (rand.next() - 0.5) * 0.7 * dpr;
    let wobble = rand.next() * 6.28;
    let half = (x1 - x0) / 2.0;
    let middle = (x0 + x1) / 2.0;
    let mut py = yt.floor() as i64;
    while (py as f32) < yb.ceil() {
        let v = ((yb - py as f32) / (yb - yt).max(1.0)).clamp(0.0, 1.0);
        let shift = lean * v;
        let breadth = 1.0 - 0.16 * v + 0.06 * (v * 7.0 + wobble).sin();
        let dry = (0.97 - 0.32 * v)
            * if v > 0.9 {
                1.0 - ((v - 0.9) / 0.1) * 0.6
            } else {
                1.0
            };
        let mut px = (x0 - 2.0).floor() as i64;
        while px as f32 <= (x1 + 2.0).ceil() {
            let u = (px as f32 + 0.5 - shift - middle) / half;
            let inside = falloff(breadth, breadth - 0.4, u.abs());
            if inside > 0.0 {
                let hair = 0.68 + 0.32 * hash(px - js_round(shift), 7, seed);
                if hash(px, py, seed) <= inside * hair * dry {
                    let a = 0.55 + 0.45 * hash(py, px, seed ^ 0x27d4_eb2d);
                    mask.grain(px, py, a);
                }
            }
            px += 1;
        }
        py += 1;
    }
}

/// Heat map layout: an 11px cell every 14px, seven rows, Monday at the top.
pub const HEAT_CELL: f32 = 11.0;
pub const HEAT_STEP: f32 = 14.0;
const DAB_SIZE: [f32; 5] = [0.0, 7.6, 8.8, 10.0, 11.2];
const DAB_DENSITY: [f32; 5] = [0.0, 0.66, 0.8, 0.92, 1.0];

/// The heat map's size in CSS px for `columns` weeks.
pub fn heat_size(columns: usize) -> (f32, f32) {
    (
        columns as f32 * HEAT_STEP - (HEAT_STEP - HEAT_CELL),
        7.0 * HEAT_STEP - (HEAT_STEP - HEAT_CELL),
    )
}

/// The year's dabs (`levels` per day, 1–4) and the loose grains of the
/// days without words.
pub fn paint_heatmap(levels: &[u8], columns: usize, dpr: f32) -> (SandMask, SandMask) {
    let (width, height) = heat_size(columns);
    let mut dabs = SandMask::new(width, height, dpr);
    let mut grains = SandMask::new(width, height, dpr);
    for (i, &level) in levels.iter().enumerate() {
        let cx = (i / 7) as f32 * HEAT_STEP + HEAT_CELL / 2.0;
        let cy = (i % 7) as f32 * HEAT_STEP + HEAT_CELL / 2.0;
        if level == 0 {
            loose(
                &mut grains,
                cx,
                cy,
                2,
                0.5,
                (i as u32).wrapping_mul(131).wrapping_add(17),
            );
        } else {
            let l = usize::from(level).min(4);
            dab(
                &mut dabs,
                cx,
                cy,
                DAB_SIZE[l],
                DAB_DENSITY[l],
                (i as u32 + 1).wrapping_mul(2_654_435_761),
            );
        }
    }
    (dabs, grains)
}

/// A strip of days, one upright stroke per day written, as tall as its
/// share of the strip's busiest day.
pub fn paint_strip(daily: &[u64], width: f32, height: f32, dpr: f32, seed: u32) -> SandMask {
    let mut mask = SandMask::new(width, height, dpr);
    let slot = width / daily.len().max(1) as f32;
    let bar_width = 5.0f32.min(slot * 0.5);
    let max = daily.iter().copied().max().unwrap_or(0).max(1) as f32;
    for (i, &words) in daily.iter().enumerate() {
        let x = i as f32 * slot + (slot - bar_width) / 2.0;
        if words > 0 {
            bar(
                &mut mask,
                x,
                height,
                bar_width,
                3.0f32.max(((height - 1.0) * words as f32) / max),
                seed.wrapping_add((i as u32).wrapping_mul(97)),
            );
        } else {
            loose(
                &mut mask,
                x + bar_width / 2.0,
                height - 1.5,
                2,
                0.45,
                seed.wrapping_add((i as u32).wrapping_mul(31)),
            );
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_written_press_sand_and_empty_days_leave_grains() {
        let levels: Vec<u8> = (0..371).map(|i| (i % 5) as u8).collect();
        let (dabs, grains) = paint_heatmap(&levels, 53, 2.0);
        assert_eq!((dabs.width, dabs.height), (1478, 190));
        assert!(dabs.coverage() > grains.coverage());
        assert!(grains.coverage() > 0);
        // The same year lands the same.
        assert_eq!(paint_heatmap(&levels, 53, 2.0).0, dabs);
        let strip = paint_strip(&[0, 10, 200, 0, 50], 100.0, 20.0, 2.0, 7);
        assert!(strip.coverage() > 0);
    }

    #[test]
    fn the_hash_is_the_old_clients() {
        // hash(3, 5, 7) and hash(-2, 9, 0x5bd1e995) in JavaScript.
        assert!(
            (hash(3, 5, 7) - 0.157_834_15).abs() < 1e-6,
            "{}",
            hash(3, 5, 7)
        );
        assert!((hash(-2, 9, 0x5bd1_e995) - 0.112_281_57).abs() < 1e-6);
    }
}
