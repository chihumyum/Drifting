//! Shelf covers and the writing heat map as CPU bitmaps (tiny-skia), ported
//! from the renderer's `lib/shelf-cover/styles/topo.ts` (等高线, the default
//! style, Canvas 2D there), `lib/sand-cover.ts` (笔迹) and `lib/sand-heat.ts`.
//! Every book is synthetic.

use std::time::Instant;

use tiny_skia::{Color, LineCap, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform};

use crate::{sea::Rand, theme::Rgb};

pub const COVER_W: u32 = 252;
pub const COVER_H: u32 = 452;

/// A synthetic book: chapters, their words, and its storylines.
#[derive(Clone, Debug)]
pub struct Book {
    pub seed: u32,
    pub title: &'static str,
    pub words: Vec<f32>,
    pub storylines: Vec<(Rgb, Vec<usize>)>,
}

impl Book {
    pub fn synthetic(
        seed: u32,
        title: &'static str,
        chapters: usize,
        lines: usize,
        story: &[Rgb; 6],
    ) -> Book {
        let mut rand = Rand::new(seed);
        let words = (0..chapters)
            .map(|_| 2000.0 + 14000.0 * rand.next().powi(2))
            .collect();
        let storylines = (0..lines)
            .map(|i| {
                let carried = (0..chapters)
                    .filter(|_| rand.next() < if i == 0 { 0.8 } else { 0.42 })
                    .collect();
                (story[(i + seed as usize) % 6], carried)
            })
            .collect();
        Book {
            seed,
            title,
            words,
            storylines,
        }
    }

    fn chapters(&self) -> usize {
        self.words.len().max(1)
    }

    fn relative(&self) -> Vec<f32> {
        let n = self.chapters();
        let mean = self.words.iter().sum::<f32>() / n as f32;
        self.words
            .iter()
            .map(|w| if mean > 0.0 { w / mean } else { 1.0 })
            .collect()
    }
}

fn ease(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn noise1d(n: usize, cell: f32, rand: &mut Rand) -> Vec<f32> {
    let grid: Vec<f32> = (0..(n as f32 / cell) as usize + 3)
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

fn noise2d(w: usize, h: usize, cell: f32, rand: &mut Rand) -> Vec<f32> {
    let gw = (w as f32 / cell) as usize + 3;
    let gh = (h as f32 / cell) as usize + 3;
    let grid: Vec<f32> = (0..gw * gh).map(|_| rand.next()).collect();
    let mut out = vec![0.0; w * h];
    for y in 0..h {
        let v = y as f32 / cell;
        let y0 = v.floor() as usize;
        let ty = ease(v - y0 as f32);
        for x in 0..w {
            let u = x as f32 / cell;
            let x0 = u.floor() as usize;
            let tx = ease(u - x0 as f32);
            let a = grid[y0 * gw + x0];
            let b = grid[y0 * gw + x0 + 1];
            let c = grid[(y0 + 1) * gw + x0];
            let d = grid[(y0 + 1) * gw + x0 + 1];
            out[y * w + x] =
                (a * (1.0 - tx) + b * tx) * (1.0 - ty) + (c * (1.0 - tx) + d * tx) * ty;
        }
    }
    out
}

fn lanes(n: usize) -> Vec<f32> {
    let w = COVER_W as f32;
    (0..n)
        .map(|i| {
            if n == 1 {
                w * 0.5
            } else {
                w * (0.22 + 0.56 * i as f32 / (n - 1) as f32)
            }
        })
        .collect()
}

fn color(rgb: [u8; 3], a: f32) -> Color {
    Color::from_rgba8(rgb[0], rgb[1], rgb[2], (a.clamp(0.0, 1.0) * 255.0) as u8)
}

fn mix_u8(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    [0, 1, 2].map(|i| (a[i] as f32 + (b[i] as f32 - a[i] as f32) * t).round() as u8)
}

/// 等高线: each chapter a storyline carries raises a hill in its lane; the
/// contours take the colour of the storyline whose hill they ring.
pub fn topo(book: &Book) -> Pixmap {
    let (w, h) = (COVER_W as usize, COVER_H as usize);
    let mut rand = Rand::new(book.seed);
    let mut pixmap = Pixmap::new(COVER_W, COVER_H).expect("cover size");
    pixmap.fill(Color::from_rgba8(248, 245, 236, 255));
    let n = book.chapters();
    let wn = book.relative();
    let g = 3usize;
    let gw = w.div_ceil(g) + 1;
    let gh = h.div_ceil(g) + 1;
    let mut field = vec![0.0f32; gw * gh];
    let mut owner = vec![-1i32; gw * gh];
    let mut best = vec![0.0f32; gw * gh];
    let terrain = noise2d(w, h, 70.0, &mut rand);
    for y in 0..gh {
        for x in 0..gw {
            field[y * gw + x] = terrain[(y * g).min(h - 1) * w + (x * g).min(w - 1)] * 0.4;
        }
    }
    let lane = lanes(book.storylines.len());
    let sigma = 11.0 + rand.next() * 12.0;
    for (i, (_, chapters)) in book.storylines.iter().enumerate() {
        for &c in chapters {
            let hx = lane[i] + (rand.next() - 0.5) * 40.0;
            let hy = (c as f32 + 0.5) / n as f32 * h as f32 + (rand.next() - 0.5) * 8.0;
            let a = 0.3 + 0.45 * wn[c].min(2.0);
            let sg = sigma * (0.7 + 0.6 * rand.next());
            let r = sg * 3.0;
            let y0 = ((hy - r) / g as f32).floor().max(0.0) as usize;
            let y1 = (((hy + r) / g as f32).ceil() as usize).min(gh - 1);
            let x0 = ((hx - r) / g as f32).floor().max(0.0) as usize;
            let x1 = (((hx + r) / g as f32).ceil() as usize).min(gw - 1);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let d2 = ((x * g) as f32 - hx).powi(2) + ((y * g) as f32 - hy).powi(2);
                    let v = a * (-d2 / (2.0 * sg * sg)).exp();
                    let j = y * gw + x;
                    field[j] += v;
                    if v > best[j] {
                        best[j] = v;
                        owner[j] = i as i32;
                    }
                }
            }
        }
    }
    let lo = field.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = field.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let levels = 16 + (rand.next() * 12.0) as usize;
    let step = (hi - lo) / levels as f32;
    let rgb: Vec<[u8; 3]> = book.storylines.iter().map(|(c, _)| c.to_u8()).collect();
    let mut paint = Paint {
        anti_alias: false,
        ..Paint::default()
    };
    for y in 0..gh {
        for x in 0..gw {
            let j = y * gw + x;
            let i = owner[j];
            if i < 0 || best[j] < 0.05 {
                continue;
            }
            let a = 0.2 * ((field[j] - lo) / (hi - lo)).powf(1.4);
            paint.set_color(color(rgb[i as usize], a));
            if let Some(rect) = Rect::from_xywh(
                (x * g) as f32 - g as f32 / 2.0,
                (y * g) as f32 - g as f32 / 2.0,
                g as f32,
                g as f32,
            ) {
                pixmap.fill_rect(rect, &paint, Transform::identity(), None);
            }
        }
    }
    // Marching squares, one path per (storyline, major) pair.
    let mut paths: Vec<((i32, bool), PathBuilder)> = Vec::new();
    for l in 1..levels {
        let iso = lo + l as f32 * step;
        let major = l % 4 == 0;
        for y in 0..gh - 1 {
            for x in 0..gw - 1 {
                let a = field[y * gw + x];
                let b = field[y * gw + x + 1];
                let c = field[(y + 1) * gw + x + 1];
                let d = field[(y + 1) * gw + x];
                let code = (u8::from(a > iso) << 3)
                    | (u8::from(b > iso) << 2)
                    | (u8::from(c > iso) << 1)
                    | u8::from(d > iso);
                if code == 0 || code == 15 {
                    continue;
                }
                let (fx, fy, gf) = ((x * g) as f32, (y * g) as f32, g as f32);
                let point = |edge: u8| match edge {
                    0 => (fx + gf * (iso - a) / (b - a), fy),
                    1 => (fx + gf, fy + gf * (iso - b) / (c - b)),
                    2 => (fx + gf * (iso - d) / (c - d), fy + gf),
                    _ => (fx, fy + gf * (iso - a) / (d - a)),
                };
                // Edges: T 0, R 1, B 2, L 3.
                let segments: &[(u8, u8)] = match code {
                    1 | 14 => &[(3, 2)],
                    2 | 13 => &[(2, 1)],
                    3 | 12 => &[(3, 1)],
                    4 | 11 => &[(0, 1)],
                    5 => &[(0, 3), (2, 1)],
                    6 | 9 => &[(0, 2)],
                    7 | 8 => &[(0, 3)],
                    10 => &[(0, 1), (3, 2)],
                    _ => &[],
                };
                let j = y * gw + x;
                let key = (
                    if owner[j] >= 0 && best[j] > 0.04 {
                        owner[j]
                    } else {
                        -1
                    },
                    major,
                );
                let at = match paths.iter().position(|(k, _)| *k == key) {
                    Some(at) => at,
                    None => {
                        paths.push((key, PathBuilder::new()));
                        paths.len() - 1
                    }
                };
                let builder = &mut paths[at].1;
                for &(e0, e1) in segments {
                    let (x0, y0) = point(e0);
                    let (x1, y1) = point(e1);
                    builder.move_to(x0, y0);
                    builder.line_to(x1, y1);
                }
            }
        }
    }
    let mut paint = Paint::default();
    for ((i, major), builder) in paths {
        let Some(path) = builder.finish() else {
            continue;
        };
        let line = if i < 0 {
            [128, 110, 88]
        } else {
            mix_u8(rgb[i as usize], [40, 30, 20], 0.18)
        };
        paint.set_color(color(line, if major { 0.92 } else { 0.62 }));
        let stroke = Stroke {
            width: if major { 1.2 } else { 0.7 },
            line_cap: LineCap::Butt,
            ..Stroke::default()
        };
        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }
    pixmap
}

fn presence(samples: usize, chapters: usize, own: &[usize], weights: Option<&[f32]>) -> Vec<f32> {
    let n = chapters.max(1);
    let mut level = vec![0.0f32; n];
    for (k, &index) in own.iter().enumerate() {
        if index < n {
            level[index] = weights.map_or(1.0, |w| w[k]);
        }
    }
    let raw: Vec<f32> = (0..samples)
        .map(|y| {
            let at = if n == 1 {
                0.0
            } else {
                y as f32 / (samples - 1) as f32 * (n - 1) as f32
            };
            let i0 = (at.floor() as usize).min(n - 1);
            let i1 = (i0 + 1).min(n - 1);
            level[i0] + (level[i1] - level[i0]) * (at - i0 as f32)
        })
        .collect();
    let window = (((17 * samples) as f32 / COVER_H as f32).round() as usize | 1).max(3);
    let half = window / 2;
    let mut prefix = vec![0.0f32; samples + 1];
    for y in 0..samples {
        prefix[y + 1] = prefix[y] + raw[y];
    }
    (0..samples)
        .map(|y| {
            (prefix[(y + half + 1).min(samples)] - prefix[y.saturating_sub(half)]) / window as f32
        })
        .collect()
}

/// 笔迹: each storyline one sand stroke scribbled down the cover by a hand
/// with momentum; thick through its chapters, a thread where it is absent.
/// Returns one alpha mask per storyline (0–1, row by row).
pub fn sand_cover(book: &Book) -> Vec<Vec<f32>> {
    let (w, h) = (COVER_W as usize, COVER_H as usize);
    let (wf, hf) = (w as f32, h as f32);
    let mut rand = Rand::new(book.seed ^ 0x9e37_79b9);
    let hand = Hand::new(&mut rand);
    let n = book.storylines.len().max(1);
    let base = if n <= 1 {
        14.0
    } else if n <= 3 {
        12.5
    } else {
        9.0
    };
    let swing =
        wf * match n {
            1 => 0.34,
            2 => 0.27,
            3 => 0.22,
            _ => 0.15,
        } * hand.swing;
    let relative = book.relative();
    book.storylines
        .iter()
        .enumerate()
        .map(|(index, (_, own))| {
            let weights: Vec<f32> = own
                .iter()
                .map(|&c| ((0.45 + 0.55 * relative[c].sqrt()).min(1.5) * 10.0).round() / 10.0)
                .collect();
            let level = presence(h, book.chapters(), own, Some(&weights));
            let lane =
                wf * if n == 1 {
                    0.5
                } else {
                    0.22 + 0.56 * index as f32 / (n - 1) as f32
                } + (rand.next() - 0.5) * wf * 0.06;
            let pts = pen_path(lane, swing, &hand, &mut rand, wf, hf);
            let samples = stroke_samples(&pts, &level, &hand, base * hand.bold, &mut rand, hf);
            let mut sand = vec![0.0f32; w * h];
            let mut across = vec![0.0f32; w * h];
            let mut loose = vec![0.0f32; w * h];
            let mut k = 0;
            while k < samples.len() {
                let s = &samples[k];
                let load = 0.38 + 0.62 * s.l;
                let reach = s.half * 2.2;
                let x0 = (s.x - reach).floor().max(0.0) as usize;
                let x1 = ((s.x + reach).ceil() as usize).min(w - 1);
                let y0 = (s.y - reach).floor().max(0.0) as usize;
                let y1 = ((s.y + reach).ceil().max(0.0) as usize).min(h - 1);
                if s.x + reach >= 0.0 && s.y + reach >= 0.0 && s.x - reach < wf && s.y - reach < hf
                {
                    for y in y0..=y1 {
                        for x in x0..=x1 {
                            let dx = x as f32 - s.x;
                            let dy = y as f32 - s.y;
                            let dist = (dx * dx + dy * dy).sqrt() / s.half;
                            if dist >= 2.2 {
                                continue;
                            }
                            let i = y * w + x;
                            loose[i] = loose[i].max(0.3 + s.l);
                            let density = (1.25 - dist).clamp(0.0, 1.0).powf(1.3) * load;
                            if density > sand[i] {
                                sand[i] = density;
                                across[i] = dx * s.nx + dy * s.ny;
                            }
                        }
                    }
                }
                k += ((s.half * 0.3).round() as usize).max(1);
            }
            let strata = noise2d(w, h, 30.0, &mut rand);
            (0..w * h)
                .map(|i| {
                    if loose[i] == 0.0 {
                        return 0.0;
                    }
                    let density = sand[i];
                    let layers = 0.75 + 0.25 * (across[i] * 0.9 + strata[i] * 6.0).sin();
                    let mut a = if rand.next() < density * layers {
                        0.62 + 0.38 * rand.next()
                    } else {
                        0.0
                    };
                    a += density * 0.35;
                    if rand.next() < 0.012 * loose[i] {
                        a = a.max(0.5);
                    }
                    a.min(1.0)
                })
                .collect()
        })
        .collect()
}

struct Hand {
    pace: f32,
    vmax: f32,
    accel: f32,
    damp: f32,
    jitter: f32,
    reach_min: f32,
    carry: f32,
    wander: f32,
    swing: f32,
    bold: f32,
    pressure_var: f32,
    pressure_cell: f32,
}

impl Hand {
    fn new(rand: &mut Rand) -> Hand {
        Hand {
            pace: 0.055 + 0.07 * rand.next(),
            vmax: 2.6 + 2.4 * rand.next(),
            accel: 0.3 + 0.9 * rand.next(),
            damp: 0.86 + 0.09 * rand.next(),
            jitter: rand.next() * 0.3,
            reach_min: 0.05 + 0.3 * rand.next(),
            carry: 0.06 + 0.16 * rand.next(),
            wander: 0.4 + rand.next(),
            swing: 0.75 + 0.5 * rand.next(),
            bold: 0.7 + 0.6 * rand.next(),
            pressure_var: 0.2 + 0.4 * rand.next(),
            pressure_cell: 40.0 + 100.0 * rand.next(),
        }
    }
}

fn pen_path(
    lane: f32,
    swing: f32,
    hand: &Hand,
    rand: &mut Rand,
    w: f32,
    h: f32,
) -> Vec<(f32, f32)> {
    let wander = noise1d(160, 4.0, rand);
    let mut side: f32 = if rand.next() < 0.5 { -1.0 } else { 1.0 };
    let mut p = (lane + side * swing * 0.4, -24.0f32);
    let mut k = 0usize;
    let mut ty = p.1;
    let mut vmax = hand.vmax;
    let pace = h * hand.pace * (0.85 + 0.3 * rand.next());
    let mut next = |side: &mut f32, ty: &mut f32, vmax: &mut f32, rand: &mut Rand| {
        k += 1;
        let carry = rand.next() < hand.carry;
        if !carry {
            *side = -*side;
        }
        *ty += pace
            * if carry {
                1.2 + 1.2 * rand.next()
            } else {
                0.45 + 1.1 * rand.next()
            };
        *vmax = hand.vmax * (0.7 + 0.6 * rand.next());
        let centre = lane + (wander[k % 160] - 0.5) * swing * hand.wander;
        let reach = hand.reach_min + (1.0 - hand.reach_min) * rand.next().powf(0.8);
        let x = centre
            + *side
                * swing
                * if carry {
                    0.3 + 0.5 * rand.next()
                } else {
                    reach
                };
        (x.clamp(5.0, w - 5.0), *ty, carry)
    };
    let mut target = next(&mut side, &mut ty, &mut vmax, rand);
    let mut v = (side * hand.vmax * 0.6, 0.6f32);
    let mut pts = vec![p];
    let mut since = 0;
    let mut i = 0;
    while i < 20000 && p.1 < h + 24.0 {
        i += 1;
        let dx = target.0 - p.0;
        let dy = target.1 - p.1;
        let d = (dx * dx + dy * dy).sqrt().max(1e-6);
        v.0 = v.0 * hand.damp + dx / d * hand.accel + (rand.next() - 0.5) * hand.jitter;
        v.1 = v.1 * hand.damp + dy / d * hand.accel + (rand.next() - 0.5) * hand.jitter;
        let sp = (v.0 * v.0 + v.1 * v.1).sqrt();
        if sp > vmax {
            v.0 *= vmax / sp;
            v.1 *= vmax / sp;
        }
        p.0 += v.0;
        p.1 += v.1;
        pts.push(p);
        since += 1;
        let passed = if target.2 {
            p.1 >= target.1
        } else if side > 0.0 {
            p.0 >= target.0
        } else {
            p.0 <= target.0
        };
        if passed || d < 6.0 || since > 300 {
            target = next(&mut side, &mut ty, &mut vmax, rand);
            since = 0;
        }
    }
    pts
}

struct Sample {
    x: f32,
    y: f32,
    nx: f32,
    ny: f32,
    l: f32,
    half: f32,
}

fn stroke_samples(
    pts: &[(f32, f32)],
    level: &[f32],
    hand: &Hand,
    max_half: f32,
    rand: &mut Rand,
    h: f32,
) -> Vec<Sample> {
    let mut out = vec![pts[0]];
    let mut carry = 0.0;
    for win in pts.windows(2) {
        let (a, b) = (win[0], win[1]);
        let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        let mut d = 1.0 - carry;
        while d <= len {
            out.push((a.0 + (b.0 - a.0) * d / len, a.1 + (b.1 - a.1) * d / len));
            d += 1.0;
        }
        carry = len - (d - 1.0);
    }
    let n = out.len();
    let top = out.iter().position(|p| p.1 >= 0.0).unwrap_or(0);
    let bottom = out[top..]
        .iter()
        .position(|p| p.1 >= h - 1.0)
        .map_or(n - 1, |i| i + top);
    let pressure = noise1d(n + 1, hand.pressure_cell, rand);
    let ragged = noise1d(n + 1, 10.0, rand);
    let pv = hand.pressure_var;
    (0..n)
        .map(|i| {
            let a = out[i.saturating_sub(2)];
            let b = out[(i + 2).min(n - 1)];
            let dl = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt().max(1e-6);
            let t = ((i as f32 - top as f32) / (bottom - top).max(1) as f32).clamp(0.0, 1.0);
            let asked = level[(t * (level.len() - 1) as f32).round() as usize];
            let l = (asked * (1.0 - pv + 2.0 * pv * pressure[i]) / 1.25).clamp(0.0, 1.0);
            Sample {
                x: out[i].0,
                y: out[i].1,
                nx: -(b.1 - a.1) / dl,
                ny: (b.0 - a.0) / dl,
                l,
                half: (max_half * (0.14 + 0.86 * l) + (ragged[i] - 0.5) * 2.4).max(0.7),
            }
        })
        .collect()
}

/// The 笔迹 masks laid in their colours on a transparent bitmap.
pub fn sand_cover_pixmap(
    book: &Book,
    masks: &[Vec<f32>],
    tint: impl Fn(Rgb) -> Rgb,
    opacity: f32,
) -> Pixmap {
    let mut pixmap = Pixmap::new(COVER_W, COVER_H).expect("cover size");
    let data = pixmap.data_mut();
    for ((rgb, _), mask) in book.storylines.iter().zip(masks) {
        let [r, g, b] = tint(*rgb).to_u8();
        for (i, &a) in mask.iter().enumerate() {
            let a = a * opacity;
            if a <= 0.0 {
                continue;
            }
            // Premultiplied source over premultiplied destination.
            let o = i * 4;
            let inv = 1.0 - a;
            data[o] = (r as f32 * a + data[o] as f32 * inv) as u8;
            data[o + 1] = (g as f32 * a + data[o + 1] as f32 * inv) as u8;
            data[o + 2] = (b as f32 * a + data[o + 2] as f32 * inv) as u8;
            data[o + 3] = (255.0 * a + data[o + 3] as f32 * inv) as u8;
        }
    }
    pixmap
}

/// Heat map layout: an 11px cell every 14px, seven rows, Monday on top.
pub const HEAT_CELL: f32 = 11.0;
pub const HEAT_STEP: f32 = 14.0;
const DAB_SIZE: [f32; 5] = [0.0, 7.6, 8.8, 10.0, 11.2];
const DAB_DENSITY: [f32; 5] = [0.0, 0.66, 0.8, 0.92, 1.0];

fn hash(a: i32, b: i32, c: u32) -> f32 {
    let mut h = ((a.wrapping_mul(374_761_393))
        ^ (b.wrapping_mul(668_265_263))
        ^ ((c as i32).wrapping_mul(1_274_126_177))) as u32;
    h = (h ^ (h >> 13)).wrapping_mul(1_103_515_245);
    h ^= h >> 16;
    h as f32 / 4_294_967_296.0
}

/// One alpha byte per device pixel.
pub struct HeatMasks {
    pub width: u32,
    pub height: u32,
    pub dabs: Vec<u8>,
    pub loose: Vec<u8>,
}

fn falloff(outer: f32, inner: f32, x: f32) -> f32 {
    let t = ((x - outer) / (inner - outer)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 53 weeks: a dab per day written (larger with more words), loose grains otherwise.
pub fn heatmap(levels: &[u8], dpr: f32) -> HeatMasks {
    let columns = levels.len().div_ceil(7);
    let width = columns as f32 * HEAT_STEP - (HEAT_STEP - HEAT_CELL);
    let height = 7.0 * HEAT_STEP - (HEAT_STEP - HEAT_CELL);
    let (w, h) = ((width * dpr).round() as u32, (height * dpr).round() as u32);
    let mut dabs = vec![0u8; (w * h) as usize];
    let mut loose = vec![0u8; (w * h) as usize];
    let grain = |mask: &mut Vec<u8>, x: i32, y: i32, alpha: f32| {
        if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
            return;
        }
        let i = (y as u32 * w + x as u32) as usize;
        let v = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
        mask[i] = mask[i].max(v);
    };
    for (i, &level) in levels.iter().enumerate() {
        let cx = (i / 7) as f32 * HEAT_STEP + HEAT_CELL / 2.0;
        let cy = (i % 7) as f32 * HEAT_STEP + HEAT_CELL / 2.0;
        if level == 0 {
            let mut rand = Rand::new(i as u32 * 131 + 17);
            for _ in 0..2 {
                let x = ((cx + (rand.next() - 0.5) * 3.2) * dpr).round() as i32;
                let y = ((cy + (rand.next() - 0.5) * 3.2) * dpr).round() as i32;
                let a = 0.5 * (0.6 + 0.4 * rand.next());
                grain(&mut loose, x, y, a);
            }
            continue;
        }
        let level = level.min(4) as usize;
        let seed = (i as u32 + 1).wrapping_mul(2_654_435_761);
        let r = DAB_SIZE[level] / 2.0 * dpr;
        let (x0, y0) = (cx * dpr, cy * dpr);
        let mut rand = Rand::new(seed);
        let tilt = -0.5 + (rand.next() - 0.5) * 0.6;
        let p0 = rand.next() * std::f32::consts::TAU;
        let p1 = rand.next() * std::f32::consts::TAU;
        let p2 = rand.next() * std::f32::consts::TAU;
        let press = (rand.next() - 0.5) * 0.8;
        let (ct, st) = (tilt.cos(), tilt.sin());
        for py in (y0 - r - 2.0).floor() as i32..=(y0 + r + 2.0).ceil() as i32 {
            for px_ in (x0 - r - 2.0).floor() as i32..=(x0 + r + 2.0).ceil() as i32 {
                let dx = (px_ as f32 + 0.5 - x0) / r;
                let dy = (py as f32 + 0.5 - y0) / r;
                let angle = dy.atan2(dx);
                let edge = 0.92
                    + 0.08 * (2.0 * angle + p0).sin()
                    + 0.06 * (3.0 * angle + p1).sin()
                    + 0.04 * (5.0 * angle + p2).sin();
                let distance = 0.55 * dx.abs().max(dy.abs()) + 0.45 * (dx * dx + dy * dy).sqrt();
                let inside = falloff(edge, edge - 0.3, distance);
                if inside <= 0.0 {
                    continue;
                }
                let along = dx * ct + dy * st;
                let across = -dx * st + dy * ct;
                let hair = 0.86 + 0.14 * (across * 10.0 + p0 * 3.0).sin();
                let p =
                    (inside * DAB_DENSITY[level] * hair * (1.16 - 0.22 * (along - press).abs()))
                        .clamp(0.0, 1.0);
                if hash(px_, py, seed) > p {
                    continue;
                }
                grain(
                    &mut dabs,
                    px_,
                    py,
                    0.5 + 0.5 * hash(py, px_, seed ^ 0x5bd1_e995),
                );
            }
        }
    }
    HeatMasks {
        width: w,
        height: h,
        dabs,
        loose,
    }
}

/// A year of synthetic writing days, as levels 0–4.
pub fn synthetic_year(seed: u32) -> Vec<u8> {
    let mut rand = Rand::new(seed);
    (0..371)
        .map(|day| {
            let busy = 0.35 + 0.4 * ((day as f32 / 40.0).sin() * 0.5 + 0.5);
            if rand.next() < busy {
                1 + (rand.next() * 3.99) as u8
            } else {
                0
            }
        })
        .collect()
}

#[cfg_attr(not(feature = "capture"), allow(dead_code))]
pub fn time<T>(f: impl FnOnce() -> T) -> (T, f64) {
    let started = Instant::now();
    let out = f();
    (out, started.elapsed().as_secs_f64() * 1000.0)
}

/// A tiny-skia pixmap (premultiplied RGBA) as GPUI's straight BGRA.
pub fn pixmap_to_image(pixmap: &Pixmap) -> image::RgbaImage {
    let mut out = image::RgbaImage::new(pixmap.width(), pixmap.height());
    for (dst, src) in out.pixels_mut().zip(pixmap.pixels()) {
        let c = src.demultiply();
        dst.0 = [c.blue(), c.green(), c.red(), c.alpha()];
    }
    out
}

/// An alpha mask in one colour, straight BGRA.
pub fn mask_to_image(
    width: u32,
    height: u32,
    alpha: &[u8],
    rgb: Rgb,
    opacity: f32,
) -> image::RgbaImage {
    let [r, g, b] = rgb.to_u8();
    let mut out = image::RgbaImage::new(width, height);
    for (dst, &a) in out.pixels_mut().zip(alpha) {
        dst.0 = [b, g, r, (a as f32 * opacity) as u8];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Theme;

    #[test]
    fn a_cover_is_the_same_every_time() {
        let theme = Theme::light();
        let book = Book::synthetic(5, "t", 24, 3, &theme.story);
        let a = topo(&book);
        let b = topo(&book);
        assert_eq!(a.data(), b.data());
        let masks = sand_cover(&book);
        assert_eq!(masks.len(), 3);
        assert!(masks[0].iter().any(|&v| v > 0.5));
    }

    #[test]
    fn the_heat_map_has_a_dab_for_a_day_written() {
        let mut levels = vec![0u8; 14];
        levels[3] = 4;
        let masks = heatmap(&levels, 2.0);
        assert!(masks.dabs.iter().filter(|&&a| a > 0).count() > 40);
        assert!(masks.loose.iter().any(|&a| a > 0));
    }
}
