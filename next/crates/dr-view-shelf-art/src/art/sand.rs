//! The sand on a shelf cover (the shelf's first cover style; the 0.1
//! client's `lib/sand-cover.ts`): the book's storylines turned upright, its
//! first chapter at the top. Each storyline is one sand stroke scribbled
//! down the cover by a hand with momentum: it sweeps from side to side,
//! overshoots a little and comes round, now and then carries on down instead
//! of turning back, and the book is read along the stroke, so every sweep is
//! a stretch of chapters. The stroke runs thick through the chapters the
//! storyline carries, the more so where they are long, and thins to a loose
//! thread where it is absent; the hand's pressure wanders over that, so the
//! cover follows the book's structure without charting it. The strokes keep
//! the author's order from left to right, each about its own lane, and cross
//! where their sweeps meet. A book whose storylines carry no chapter gets one
//! stroke of neutral ink.
//!
//! Each stroke is an alpha mask (0–1); the colour is laid on when it is
//! shown, so a theme change needs no redraw. Everything random is seeded by
//! the book, so its cover is the same every time the shelf opens. Sizes are
//! mask px: twice the 126 × 226 cover.
//!
//! Unlike the full-colour styles this one is worked in doubles, with the
//! 0.1 client's `Float32Array`s rounded to `f32` where it stores them: how
//! many random numbers a stroke draws turns on its pen's path and on every
//! px's sand, so the arithmetic has to follow the original's for the cover
//! to come out the same.

use super::book::CoverRequest;
use super::paint::{H, Rand, W};

const WD: f64 = W as f64;
const HD: f64 = H as f64;

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// JavaScript's `Math.round`.
fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// JavaScript's `Math.hypot` as V8 works it: scaled by the larger, summed
/// with Kahan's compensation.
fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = a.max(b);
    if max == 0.0 || max.is_infinite() {
        return max;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `x || 1`.
fn or_one(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 1.0 } else { x }
}

fn ease(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// `noise1d`: the grid in doubles, the noise stored as `f32`.
fn noise1d(n: usize, cell: f64, rand: &mut Rand) -> Vec<f32> {
    let grid: Vec<f64> = (0..(n as f64 / cell).floor() as usize + 3)
        .map(|_| rand.next_f64())
        .collect();
    (0..n)
        .map(|i| {
            let u = i as f64 / cell;
            let i0 = u.floor();
            let t = ease(u - i0);
            let i0 = i0 as usize;
            (grid[i0] * (1.0 - t) + grid[i0 + 1] * t) as f32
        })
        .collect()
}

/// `noise2d`: the grid stored as `f32`, worked in doubles, stored as `f32`.
fn noise2d(cell: f64, rand: &mut Rand) -> Vec<f32> {
    let gw = (WD / cell).floor() as usize + 3;
    let gh = (HD / cell).floor() as usize + 3;
    let grid: Vec<f64> = (0..gw * gh)
        .map(|_| f64::from(rand.next_f64() as f32))
        .collect();
    let mut out = vec![0.0f32; W * H];
    for y in 0..H {
        let v = y as f64 / cell;
        let y0 = v.floor();
        let ty = ease(v - y0);
        let y0 = y0 as usize;
        for x in 0..W {
            let u = x as f64 / cell;
            let x0 = u.floor();
            let tx = ease(u - x0);
            let x0 = x0 as usize;
            let a = grid[y0 * gw + x0];
            let b = grid[y0 * gw + x0 + 1];
            let c = grid[(y0 + 1) * gw + x0];
            let d = grid[(y0 + 1) * gw + x0 + 1];
            out[y * W + x] =
                ((a * (1.0 - tx) + b * tx) * (1.0 - ty) + (c * (1.0 - tx) + d * tx) * ty) as f32;
        }
    }
    out
}

/// `presence` (see [`super::book::presence`]) as the 0.1 client works it.
fn presence(chapters: usize, own: Option<&[usize]>, weights: Option<&[f64]>) -> Vec<f32> {
    let samples = H;
    let n = chapters.max(1);
    let mut level = vec![0.0f32; n];
    match own {
        None => level.fill(0.55),
        Some(own) => {
            for (k, &index) in own.iter().enumerate() {
                if index < n {
                    level[index] = weights.map_or(1.0, |w| w[k] as f32);
                }
            }
        }
    }
    let mut raw = vec![0.0f32; samples];
    for (y, r) in raw.iter_mut().enumerate() {
        let at = if n == 1 {
            0.0
        } else {
            (y as f64 / (samples - 1) as f64) * (n - 1) as f64
        };
        let i0 = (n - 1).min(at.floor() as usize);
        let i1 = (n - 1).min(i0 + 1);
        let (l0, l1) = (f64::from(level[i0]), f64::from(level[i1]));
        *r = (l0 + (l1 - l0) * (at - i0 as f64)) as f32;
    }
    let window = 3usize.max(round((17 * samples) as f64 / HD) as usize | 1);
    let half = window >> 1;
    let mut prefix = vec![0.0f32; samples + 1];
    for y in 0..samples {
        prefix[y + 1] = (f64::from(prefix[y]) + f64::from(raw[y])) as f32;
    }
    (0..samples)
        .map(|y| {
            let a = f64::from(prefix[samples.min(y + half + 1)]);
            let b = f64::from(prefix[y.saturating_sub(half)]);
            ((a - b) / window as f64) as f32
        })
        .collect()
}

/// `relativeWords`, in doubles.
fn relative_words(chapters: usize, words: &[u64]) -> Vec<f64> {
    let n = chapters.max(1);
    let counts: Vec<f64> = (0..n)
        .map(|c| words.get(c).copied().unwrap_or(0) as f64)
        .collect();
    let mean = counts.iter().sum::<f64>() / n as f64;
    counts
        .iter()
        .map(|&w| if mean > 0.0 { w / mean } else { 1.0 })
        .collect()
}

/// How heavily a chapter lies on its stroke: a chapter of the book's usual
/// length weighs 1, an empty one about half, a long one up to half again;
/// rounded to tenths, so a few more words leave the cover as it was.
pub fn chapter_weight(relative: f64) -> f64 {
    round((0.45 + 0.55 * relative.sqrt()).min(1.5) * 10.0) / 10.0
}

/// One writer's hand for one cover: how fast it drops, how far it reaches,
/// how tightly it turns.
struct Hand {
    pace: f64,
    vmax: f64,
    accel: f64,
    damp: f64,
    jitter: f64,
    reach_min: f64,
    carry: f64,
    wander: f64,
    swing: f64,
    bold: f64,
    pressure_var: f64,
    pressure_cell: f64,
}

fn make_hand(rand: &mut Rand) -> Hand {
    Hand {
        pace: 0.055 + 0.07 * rand.next_f64(),
        vmax: 2.6 + 2.4 * rand.next_f64(),
        accel: 0.3 + 0.9 * rand.next_f64(),
        damp: 0.86 + 0.09 * rand.next_f64(),
        jitter: rand.next_f64() * 0.3,
        reach_min: 0.05 + 0.3 * rand.next_f64(),
        carry: 0.06 + 0.16 * rand.next_f64(),
        wander: 0.4 + rand.next_f64(),
        swing: 0.75 + 0.5 * rand.next_f64(),
        bold: 0.7 + 0.6 * rand.next_f64(),
        pressure_var: 0.2 + 0.4 * rand.next_f64(),
        pressure_cell: 40.0 + 100.0 * rand.next_f64(),
    }
}

#[derive(Clone, Copy)]
struct P {
    x: f64,
    y: f64,
}

struct Target {
    x: f64,
    y: f64,
    carry: bool,
}

/// Where the pen is steering and how it is going about it.
struct Pen<'a> {
    hand: &'a Hand,
    lane: f64,
    swing: f64,
    wander: Vec<f32>,
    side: f64,
    k: usize,
    ty: f64,
    vmax: f64,
    pace: f64,
}

impl Pen<'_> {
    fn next(&mut self, rand: &mut Rand) -> Target {
        let hand = self.hand;
        self.k += 1;
        // Now and then the hand carries on down the same side instead of
        // turning back.
        let carry = rand.next_f64() < hand.carry;
        if !carry {
            self.side = -self.side;
        }
        self.ty += self.pace
            * if carry {
                1.2 + 1.2 * rand.next_f64()
            } else {
                0.45 + 1.1 * rand.next_f64()
            };
        self.vmax = hand.vmax * (0.7 + 0.6 * rand.next_f64());
        let centre =
            self.lane + (f64::from(self.wander[self.k % 160]) - 0.5) * self.swing * hand.wander;
        let reach = hand.reach_min + (1.0 - hand.reach_min) * rand.next_f64().powf(0.8);
        let x = centre
            + self.side
                * self.swing
                * if carry {
                    0.3 + 0.5 * rand.next_f64()
                } else {
                    reach
                };
        Target {
            x: clamp(x, 5.0, WD - 5.0),
            y: self.ty,
            carry,
        }
    }
}

/// A pen with momentum steered from side to side down the cover, from above
/// it to below it: it overshoots a little and comes round, so its turns are
/// tight or loose as the hand is.
fn pen_path(lane: f64, swing: f64, hand: &Hand, rand: &mut Rand) -> Vec<P> {
    let wander = noise1d(160, 4.0, rand);
    let side = if rand.next_f64() < 0.5 { -1.0 } else { 1.0 };
    let mut p = P {
        x: lane + side * swing * 0.4,
        y: -24.0,
    };
    let pace = HD * hand.pace * (0.85 + 0.3 * rand.next_f64());
    let mut pen = Pen {
        hand,
        lane,
        swing,
        wander,
        side,
        k: 0,
        ty: p.y,
        vmax: hand.vmax,
        pace,
    };
    let mut target = pen.next(rand);
    let mut v = P {
        x: pen.side * hand.vmax * 0.6,
        y: 0.6,
    };
    let mut pts = vec![p];
    let mut since = 0;
    let mut i = 0;
    while i < 20000 && p.y < HD + 24.0 {
        let dx = target.x - p.x;
        let dy = target.y - p.y;
        let d = or_one(hypot(dx, dy));
        v.x = v.x * hand.damp + (dx / d) * hand.accel + (rand.next_f64() - 0.5) * hand.jitter;
        v.y = v.y * hand.damp + (dy / d) * hand.accel + (rand.next_f64() - 0.5) * hand.jitter;
        let sp = hypot(v.x, v.y);
        if sp > pen.vmax {
            v.x *= pen.vmax / sp;
            v.y *= pen.vmax / sp;
        }
        p.x += v.x;
        p.y += v.y;
        pts.push(p);
        since += 1;
        let passed = if target.carry {
            p.y >= target.y
        } else if pen.side > 0.0 {
            p.x >= target.x
        } else {
            p.x <= target.x
        };
        if passed || d < 6.0 || since > 300 {
            target = pen.next(rand);
            since = 0;
        }
        i += 1;
    }
    pts
}

struct Sample {
    x: f64,
    y: f64,
    nx: f64,
    ny: f64,
    /// How heavily the book lies here, 0–1.
    l: f64,
    half: f64,
}

/// The path at 1 px steps, each step with its width; the book is read along
/// it from where it enters the cover to where it leaves.
fn stroke_samples(
    pts: &[P],
    level: &[f32],
    hand: &Hand,
    max_half: f64,
    rand: &mut Rand,
) -> Vec<Sample> {
    let mut out = vec![pts[0]];
    let mut carry = 0.0;
    for i in 1..pts.len() {
        let a = pts[i - 1];
        let b = pts[i];
        let len = hypot(b.x - a.x, b.y - a.y);
        let mut d = 1.0 - carry;
        while d <= len {
            out.push(P {
                x: a.x + ((b.x - a.x) * d) / len,
                y: a.y + ((b.y - a.y) * d) / len,
            });
            d += 1.0;
        }
        carry = len - (d - 1.0);
    }
    let n = out.len();
    let top = out.iter().position(|s| s.y >= 0.0).unwrap_or(0);
    let bottom = out[top..]
        .iter()
        .position(|s| s.y >= HD - 1.0)
        .map_or(n - 1, |i| top + i);
    let pressure = noise1d(n + 1, hand.pressure_cell, rand);
    let ragged = noise1d(n + 1, 10.0, rand);
    let pv = hand.pressure_var;
    out.iter()
        .enumerate()
        .map(|(i, s)| {
            let a = out[i.saturating_sub(2)];
            let b = out[(n - 1).min(i + 2)];
            let dl = or_one(hypot(b.x - a.x, b.y - a.y));
            let t = clamp(
                (i as f64 - top as f64) / (bottom as f64 - top as f64).max(1.0),
                0.0,
                1.0,
            );
            let asked = f64::from(level[round(t * (level.len() - 1) as f64) as usize]);
            // What the chapters here ask for, under a hand whose pressure
            // wanders.
            let l = clamp(
                (asked * (1.0 - pv + 2.0 * pv * f64::from(pressure[i]))) / 1.25,
                0.0,
                1.0,
            );
            Sample {
                x: s.x,
                y: s.y,
                nx: -(b.y - a.y) / dl,
                ny: (b.x - a.x) / dl,
                l,
                half: (max_half * (0.14 + 0.86 * l) + (f64::from(ragged[i]) - 0.5) * 2.4).max(0.7),
            }
        })
        .collect()
}

/// One alpha mask per storyline (or one neutral stroke), 0–1, row by row,
/// `W × H`.
pub fn draw_sand_cover(request: &CoverRequest) -> Vec<Vec<f32>> {
    let mut rand = Rand::new(request.seed);
    let rand = &mut rand;
    let hand = make_hand(rand);
    let chapters = request.chapters;
    let relative = relative_words(chapters, &request.words);
    let lines: Vec<Option<&[usize]>> = if request
        .storylines
        .iter()
        .any(|line| !line.chapters.is_empty())
    {
        request
            .storylines
            .iter()
            .map(|line| Some(line.chapters.as_slice()))
            .collect()
    } else {
        vec![None]
    };
    let n = lines.len();
    let base = if n <= 1 {
        14.0
    } else if n <= 3 {
        12.5
    } else {
        9.0
    };
    let swing =
        WD * match n {
            1 => 0.34,
            2 => 0.27,
            3 => 0.22,
            _ => 0.15,
        } * hand.swing;

    lines
        .iter()
        .enumerate()
        .map(|(index, own)| {
            let level = match own {
                None => presence(chapters, None, None),
                Some(own) => {
                    let weights: Vec<f64> = own
                        .iter()
                        .map(|&c| chapter_weight(relative.get(c).copied().unwrap_or(1.0)))
                        .collect();
                    presence(chapters, Some(own), Some(&weights))
                }
            };
            let lane =
                WD * if n == 1 {
                    0.5
                } else {
                    0.22 + (0.56 * index as f64) / (n - 1) as f64
                } + (rand.next_f64() - 0.5) * WD * 0.06;
            let path = pen_path(lane, swing, &hand, rand);
            let samples = stroke_samples(&path, &level, &hand, base * hand.bold, rand);

            // How much sand each px holds, which way across the stroke it
            // lies, and how likely a loose grain is to land there.
            let mut sand = vec![0.0f32; W * H];
            let mut across = vec![0.0f32; W * H];
            let mut loose = vec![0.0f32; W * H];
            let mut k = 0;
            while k < samples.len() {
                let s = &samples[k];
                let load = 0.38 + 0.62 * s.l;
                let reach = s.half * 2.2;
                let x0 = (s.x - reach).floor().max(0.0);
                let x1 = (WD - 1.0).min((s.x + reach).ceil());
                let y0 = (s.y - reach).floor().max(0.0);
                let y1 = (HD - 1.0).min((s.y + reach).ceil());
                let mut y = y0;
                while y <= y1 {
                    let mut x = x0;
                    while x <= x1 {
                        let dx = x - s.x;
                        let dy = y - s.y;
                        let dist = hypot(dx, dy) / s.half;
                        if dist < 2.2 {
                            let i = y as usize * W + x as usize;
                            if 0.3 + s.l > f64::from(loose[i]) {
                                loose[i] = (0.3 + s.l) as f32;
                            }
                            let density = clamp(1.25 - dist, 0.0, 1.0).powf(1.3) * load;
                            if density > f64::from(sand[i]) {
                                sand[i] = density as f32;
                                across[i] = (dx * s.nx + dy * s.ny) as f32;
                            }
                        }
                        x += 1.0;
                    }
                    y += 1.0;
                }
                k += round(s.half * 0.3).max(1.0) as usize;
            }

            let strata = noise2d(30.0, rand);
            let mut alpha = vec![0.0f32; W * H];
            for i in 0..W * H {
                if loose[i] == 0.0 {
                    continue;
                }
                let density = f64::from(sand[i]);
                let layers =
                    0.75 + 0.25 * (f64::from(across[i]) * 0.9 + f64::from(strata[i]) * 6.0).sin();
                let mut a = if rand.next_f64() < density * layers {
                    0.62 + 0.38 * rand.next_f64()
                } else {
                    0.0
                };
                a += density * 0.35;
                // Loose grains thrown off the stroke's edge.
                if rand.next_f64() < 0.012 * f64::from(loose[i]) {
                    a = a.max(0.5);
                }
                alpha[i] = a.min(1.0) as f32;
            }
            alpha
        })
        .collect()
}
