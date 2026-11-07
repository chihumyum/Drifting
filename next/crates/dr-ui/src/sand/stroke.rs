//! The dry-brush frame round a selected cell, drawn for the cell's own size
//! (a port of the renderer's `lib/sand-frame.ts`). The centreline starts
//! beside the mark on the left side and runs down, along the bottom, up the
//! right side, along the top and back down past the start, or stops just
//! short of it. Every corner and side is jittered, the brush turns round the
//! corners and wavers along the line; it presses as it lands, dries as it
//! goes until its hairs part into streaks, and flicks off. Grain and a few
//! loose grains finish it. Widths are px and never stretch with the cell.
//!
//! Everything random is keyed to where it sits on its own side, so redrawing
//! the same seed at another width keeps the left side as it was, carries the
//! right side with the edge and runs the top and bottom on: nothing crawls
//! while a sidebar is dragged wider.

/// Room round the frame box for the stroke's width, overshoot and loose grains, px.
pub const PAD: f32 = 5.0;
const STEP: f32 = 0.5;
const HAIRS: usize = 9;
/// Within this many px of the right edge, shape and grain follow that edge.
const RIGHT_ZONE: f32 = 14.0;

/// A stroke rasterised for one size.
#[derive(Clone, Debug)]
pub struct Stroke {
    /// Device px: the frame box plus [`PAD`] on every side.
    pub width: u32,
    pub height: u32,
    /// 0–1 per device px.
    pub alpha: Vec<f32>,
    /// When (0–1 along the stroke) the brush reached each device px; above 1
    /// where it never did.
    pub arrive: Vec<f32>,
}

struct Rand(u32);

impl Rand {
    fn next(&mut self) -> f32 {
        // mulberry32, as the renderer.
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(1 | t);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64 / 4_294_967_296.0) as f32
    }

    fn jitter(&mut self, a: f32) -> f32 {
        (self.next() - 0.5) * 2.0 * a
    }
}

fn hash(seed: u32, x: i32, y: i32) -> f32 {
    let mut h = seed ^ (x as u32).wrapping_mul(0x27d4_eb2d) ^ (y as u32).wrapping_mul(0x1656_67b1);
    h = (h ^ (h >> 15)).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2_ae35);
    ((h ^ (h >> 16)) as f64 / 4_294_967_296.0) as f32
}

struct Waver(Vec<(f32, f32, f32)>);

impl Waver {
    fn new(rand: &mut Rand, specs: &[(f32, f32)]) -> Waver {
        Waver(
            specs
                .iter()
                .map(|&(length, amp)| {
                    let k = std::f32::consts::TAU / (length * (0.75 + 0.5 * rand.next()));
                    let p = rand.next() * std::f32::consts::TAU;
                    (k, p, amp)
                })
                .collect(),
        )
    }

    fn at(&self, u: f32) -> f32 {
        self.0
            .iter()
            .map(|(k, p, amp)| amp * (k * u + p).sin())
            .sum()
    }
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[derive(Clone, Copy)]
struct Sample {
    x: f32,
    y: f32,
    leg: usize,
    u: f32,
    q: f32,
    from_start: f32,
    to_end: f32,
}

/// Draws the frame round a `w` × `h` box at `scale` device px per px.
/// `nominal_w` is the width the stroke was first drawn at; it keeps the
/// drying stable when the box is resized.
pub fn draw(w: f32, h: f32, scale: f32, seed: u32, nominal_w: f32) -> Stroke {
    let mut rand = Rand(seed);
    let left = PAD;
    let right = PAD + w;
    let top = PAD;
    let bottom = PAD + h;

    let tl = (left + rand.jitter(1.2), top + rand.jitter(0.9));
    let tr_dx = rand.jitter(1.2);
    let tr_y = top + rand.jitter(0.9);
    let br_dx = rand.jitter(1.2);
    let br_y = bottom + rand.jitter(0.9);
    let bl = (left + rand.jitter(1.2), bottom + rand.jitter(0.9));
    let tr = (right + tr_dx, tr_y);
    let br = (right + br_dx, br_y);
    let side = bl.1 - tl.1;
    let f = 0.5 + rand.jitter(0.08);
    let start = (tl.0 + (bl.0 - tl.0) * f + rand.jitter(0.4), tl.1 + side * f);
    let over = if rand.next() < 0.28 {
        -(1.5 + rand.next() * 4.0)
    } else {
        3.0 + rand.next() * (11.0f32).min(side * 0.35)
    };
    let end_y = (bl.1 - side * 0.04).min((tl.1 + side * 0.1).max(start.1 + over));
    let end = (
        tl.0 + (bl.0 - tl.0) * ((end_y - tl.1) / side) + rand.jitter(1.1),
        end_y,
    );

    let wob: Vec<Waver> = (0..5)
        .map(|_| Waver::new(&mut rand, &[(110.0, 0.6), (36.0, 0.3), (12.0, 0.12)]))
        .collect();
    let bend = [
        Waver::new(&mut rand, &[(420.0, 0.7)]),
        Waver::new(&mut rand, &[(420.0, 0.7)]),
    ];
    let turn = 4 + (rand.next() * 4.0).round() as usize;
    let dry = 0.4 + 0.24 * rand.next();
    let thick = 2.0 + 0.4 * rand.next();
    let breadth = Waver::new(&mut rand, &[(23.0, 0.2), (7.0, 0.07)]);
    let press = Waver::new(&mut rand, &[(41.0, 0.07)]);
    let hairs: Vec<(f32, f32, f32)> = (0..HAIRS)
        .map(|_| {
            (
                rand.next(),
                std::f32::consts::TAU / (30.0 + rand.next() * 60.0),
                rand.next() * std::f32::consts::TAU,
            )
        })
        .collect();

    let perimeter = 2.0 * (nominal_w + h);
    let qa = (bl.1 - start.1) / perimeter;
    let qb = qa + nominal_w / perimeter;
    let qc = qb + h / perimeter;
    let qd = qc + nominal_w / perimeter;

    let mut raw: Vec<Sample> = Vec::new();
    let mut push = |x: f32, y: f32, leg: usize, u: f32, q: f32, from_start: f32, to_end: f32| {
        raw.push(Sample {
            x,
            y,
            leg,
            u,
            q,
            from_start,
            to_end,
        })
    };
    let level_bottom = |x: f32| bl.1 + (br.1 - bl.1) * smoothstep(right - 24.0, right, x);
    let level_top = |x: f32| tl.1 + (tr.1 - tl.1) * smoothstep(right - 24.0, right, x);
    let inf = f32::INFINITY;

    let mut y = start.1;
    while y < bl.1 {
        let t = (y - start.1) / (bl.1 - start.1);
        push(
            start.0 + (bl.0 - start.0) * t + wob[0].at(y),
            y,
            0,
            y,
            (y - start.1) / perimeter,
            y - start.1,
            inf,
        );
        y += STEP;
    }
    let mut x = bl.0;
    while x < br.0 {
        push(
            x,
            level_bottom(x) + wob[1].at(x - left) + bend[0].at(x - left),
            1,
            x - left,
            qa + (x - bl.0) / perimeter,
            inf,
            inf,
        );
        x += STEP;
    }
    let mut y = br.1;
    while y > tr.1 {
        let t = (br.1 - y) / (br.1 - tr.1);
        push(
            br.0 + (tr.0 - br.0) * t + wob[2].at(y),
            y,
            2,
            y,
            qb + (br.1 - y) / perimeter,
            inf,
            inf,
        );
        y -= STEP;
    }
    let top_steps = ((tr.0 - tl.0) / STEP).floor().max(0.0) as i32;
    push(
        tr.0,
        level_top(tr.0) + wob[3].at(tr.0 - left) + bend[1].at(tr.0 - left),
        3,
        tr.0 - left,
        qc,
        inf,
        inf,
    );
    for i in (0..=top_steps).rev() {
        let x = tl.0 + i as f32 * STEP;
        let back = (left + nominal_w - x).max(0.0);
        push(
            x,
            level_top(x) + wob[3].at(x - left) + bend[1].at(x - left),
            3,
            x - left,
            qd.min(qc + back / perimeter),
            inf,
            inf,
        );
    }
    let mut y = tl.1;
    let span = if end.1 - tl.1 == 0.0 {
        1.0
    } else {
        end.1 - tl.1
    };
    while y <= end.1 {
        let t = (y - tl.1) / span;
        push(
            tl.0 + (end.0 - tl.0) * t + wob[4].at(y),
            y,
            4,
            y,
            qd + (y - tl.1) / perimeter,
            inf,
            end.1 - y,
        );
        y += STEP;
    }

    // Round the corners the way a turning brush does.
    let n = raw.len();
    let path: Vec<Sample> = (0..n)
        .map(|i| {
            let lo = i.saturating_sub(turn);
            let hi = (i + turn).min(n - 1);
            let (mut ax, mut ay) = (0.0, 0.0);
            for s in &raw[lo..=hi] {
                ax += s.x;
                ay += s.y;
            }
            let c = (hi - lo + 1) as f32;
            Sample {
                x: ax / c,
                y: ay / c,
                ..raw[i]
            }
        })
        .collect();
    let mut along = vec![0.0f32; n];
    for i in 1..n {
        along[i] = along[i - 1] + (path[i].x - path[i - 1].x).hypot(path[i].y - path[i - 1].y);
    }
    let total = if n > 0 && along[n - 1] > 0.0 {
        along[n - 1]
    } else {
        1.0
    };

    let pw = ((w + PAD * 2.0) * scale).ceil().max(1.0) as usize;
    let ph = ((h + PAD * 2.0) * scale).ceil().max(1.0) as usize;
    let mut alpha = vec![0.0f32; pw * ph];
    let mut arrive = vec![2.0f32; pw * ph];

    for i in 0..n {
        let p = path[i];
        let i0 = i.saturating_sub(1);
        let i1 = (i + 1).min(n - 1);
        let dx = path[i1].x - path[i0].x;
        let dy = path[i1].y - path[i0].y;
        let d = dx.hypot(dy).max(f32::EPSILON);
        let (nx, ny) = (-dy / d, dx / d);
        let key = p.u + p.leg as f32 * 1000.0;
        let mut load = 1.0 - dry * p.q.min(1.2).powf(1.25) + press.at(key);
        let mut rad = (thick / 2.0) * (1.0 + breadth.at(key));
        if p.from_start < 4.0 {
            load += 0.15 * (1.0 - p.from_start / 4.0);
        }
        rad *= 0.8 + 0.25 * load.min(1.0);
        if p.from_start < 3.0 {
            rad *= 1.12;
        }
        if p.to_end < 7.0 {
            rad *= (p.to_end / 7.0).max(0.3);
        }
        let r = rad * scale;
        let (cx, cy) = (p.x * scale, p.y * scale);
        let dryness = (1.0 - load).max(0.0);
        let when = along[i] / total;
        let x0 = (cx - r - 1.0).floor().max(0.0) as usize;
        let x1 = ((cx + r + 1.0).ceil() as usize).min(pw - 1);
        let y0 = (cy - r - 1.0).floor().max(0.0) as usize;
        let y1 = ((cy + r + 1.0).ceil() as usize).min(ph - 1);
        for yy in y0..=y1 {
            for xx in x0..=x1 {
                let ox = xx as f32 + 0.5 - cx;
                let oy = yy as f32 + 0.5 - cy;
                let dist = ox.hypot(oy);
                if dist > r + 0.8 {
                    continue;
                }
                let edge = ((r + 0.8 - dist) / 1.6).min(1.0);
                let across = (ox * nx + oy * ny) / r.max(0.5);
                let hi = (((across + 1.0) * 0.5 * HAIRS as f32).floor() as i32)
                    .clamp(0, HAIRS as i32 - 1) as usize;
                let (ht, hk, hp) = hairs[hi];
                let holds = if ht + 0.15 * (key * hk + hp).sin() > dryness * 1.3 {
                    1.0
                } else {
                    0.16
                };
                let v = edge * load.min(1.0) * holds;
                let at = yy * pw + xx;
                if v > alpha[at] {
                    alpha[at] = v;
                }
                if v > 0.05 && when < arrive[at] {
                    arrive[at] = when;
                }
            }
        }
    }

    // Grain, keyed to the left edge or, near the right edge, to that edge.
    let right_zone = (right - RIGHT_ZONE) * scale;
    let right_edge = (right * scale).round() as i32;
    for yy in 0..ph {
        for xx in 0..pw {
            let at = yy * pw + xx;
            let a = alpha[at];
            if a == 0.0 {
                continue;
            }
            let kx = if xx as f32 >= right_zone {
                xx as i32 - right_edge - 100_000
            } else {
                xx as i32
            };
            let grain = if hash(seed, kx, yy as i32) < a * 1.1 {
                0.6 + 0.4 * hash(seed ^ 0x9e37_79b9, kx, yy as i32)
            } else {
                0.0
            };
            alpha[at] = a * 0.45 + grain * 0.55;
        }
    }

    // Loose grains, one chance per 40px of each side, keyed like the side.
    let mut leg_start = [0usize; 5];
    let mut leg_end = [0usize; 5];
    for (i, p) in path.iter().enumerate() {
        if leg_end[p.leg] == 0 {
            leg_start[p.leg] = i;
        }
        leg_end[p.leg] = i + 1;
    }
    for leg in 0..5 {
        for i in leg_start[leg]..leg_end[leg] {
            let p = path[i];
            let cell = (p.u / 40.0).floor() as i32;
            if i > leg_start[leg] && (path[i - 1].u / 40.0).floor() as i32 == cell {
                continue;
            }
            let salt = leg as i32 * 7919 + cell;
            if hash(seed, salt, 17) > 0.75 {
                continue;
            }
            let pick = (leg_end[leg] - 1).min(i + (hash(seed, salt, 29) * 80.0).floor() as usize);
            let q = path[pick];
            let side = if hash(seed, salt, 41) < 0.5 {
                -1.0
            } else {
                1.0
            };
            let offset = side * thick * (0.9 + 1.8 * hash(seed, salt, 53));
            let i0 = pick.saturating_sub(1);
            let i1 = (pick + 1).min(n - 1);
            let tx = path[i1].x - path[i0].x;
            let ty = path[i1].y - path[i0].y;
            let tlen = tx.hypot(ty).max(f32::EPSILON);
            let gx = ((q.x - (ty / tlen) * offset) * scale).round();
            let gy = ((q.y + (tx / tlen) * offset) * scale).round();
            if gx < 0.0 || gy < 0.0 || gx >= pw as f32 || gy >= ph as f32 {
                continue;
            }
            let at = gy as usize * pw + gx as usize;
            alpha[at] = alpha[at].max(0.5);
            arrive[at] = arrive[at].min(along[pick] / total);
        }
    }

    Stroke {
        width: pw as u32,
        height: ph as u32,
        alpha,
        arrive,
    }
}

impl Stroke {
    /// The stroke in `rgb` up to `progress` (0–1 along it), as straight-alpha
    /// BGRA for GPUI, `opacity` applied.
    pub fn paint(&self, rgb: [u8; 3], progress: f32, opacity: f32) -> image::RgbaImage {
        let mut image = image::RgbaImage::new(self.width, self.height);
        for (i, pixel) in image.pixels_mut().enumerate() {
            let a = self.alpha[i];
            if a == 0.0 || self.arrive[i] > progress {
                continue;
            }
            let alpha = (a * opacity * 255.0).min(255.0) as u8;
            *pixel = image::Rgba([rgb[2], rgb[1], rgb[0], alpha]);
        }
        image
    }

    /// The share of the stroke's ink that has arrived by `progress`.
    pub fn drawn(&self, progress: f32) -> f32 {
        let total: f32 = self.alpha.iter().sum();
        if total == 0.0 {
            return 1.0;
        }
        let shown: f32 = self
            .alpha
            .iter()
            .zip(&self.arrive)
            .filter(|(_, at)| **at <= progress)
            .map(|(a, _)| *a)
            .sum();
        shown / total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_draws_the_same_stroke() {
        let a = draw(200.0, 30.0, 2.0, 7, 200.0);
        let b = draw(200.0, 30.0, 2.0, 7, 200.0);
        assert_eq!(a.alpha, b.alpha);
        assert_eq!(a.width, 420);
        assert_eq!(a.height, 80);
    }

    #[test]
    fn the_brush_draws_along_its_path() {
        let s = draw(200.0, 30.0, 2.0, 11, 200.0);
        let half = s.drawn(0.5);
        assert!(half > 0.3 && half < 0.8, "{half}");
        // The faintest specks (where the brush only grazed) never arrive,
        // as in the renderer.
        assert!(s.drawn(1.0) > 0.95);
        assert!(s.drawn(0.0) < 0.05);
    }

    #[test]
    fn a_wider_box_keeps_the_left_side_where_it_was() {
        let narrow = draw(160.0, 30.0, 1.0, 3, 160.0);
        let wide = draw(220.0, 30.0, 1.0, 3, 160.0);
        // The left 20 px columns match.
        for y in 0..narrow.height as usize {
            for x in 0..20usize {
                let a = narrow.alpha[y * narrow.width as usize + x];
                let b = wide.alpha[y * wide.width as usize + x];
                assert!((a - b).abs() < 1e-4, "({x},{y}) {a} vs {b}");
            }
        }
    }
}
