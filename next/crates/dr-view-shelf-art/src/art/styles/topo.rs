//! 等高线 — a contour map: each chapter a storyline carries raises a hill in
//! its lane, higher where the chapter is long; the contours take the colour
//! of the storyline whose hill they ring.

use crate::art::book::{CoverBook, lanes_of};
use crate::art::paint::{Ctx, H, HF, Path2D, Rand, Rgb, W, css, ground, mix, noise2d};

#[derive(Clone, Copy)]
enum Edge {
    T,
    R,
    B,
    L,
}

/// Marching squares: corners top-left 8, top-right 4, bottom-right 2,
/// bottom-left 1.
fn segments(code: u8) -> &'static [(Edge, Edge)] {
    use Edge::*;
    match code {
        1 => &[(L, B)],
        2 => &[(B, R)],
        3 => &[(L, R)],
        4 => &[(T, R)],
        5 => &[(T, L), (B, R)],
        6 => &[(T, B)],
        7 => &[(T, L)],
        8 => &[(T, L)],
        9 => &[(T, B)],
        10 => &[(T, R), (L, B)],
        11 => &[(T, R)],
        12 => &[(L, R)],
        13 => &[(R, B)],
        14 => &[(L, B)],
        _ => &[],
    }
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    ctx.put_image_data(&ground([248, 245, 236]));
    let s = &book.strands;
    let n = book.chapters;
    let g = 3usize;
    let gf = g as f32;
    let gw = W.div_ceil(g) + 1;
    let gh = H.div_ceil(g) + 1;
    let mut f = vec![0.0f32; gw * gh];
    let mut d: Vec<Option<usize>> = vec![None; gw * gh];
    let mut best = vec![0.0f32; gw * gh];
    let terrain = noise2d(70.0, rand);
    for y in 0..gh {
        for x in 0..gw {
            f[y * gw + x] = terrain[(H - 1).min(y * g) * W + (W - 1).min(x * g)] * 0.4;
        }
    }
    let lanes = lanes_of(s.len());
    let sigma = 11.0 + rand.next() * 12.0;
    for (i, strand) in s.iter().enumerate() {
        for c in 0..n {
            if strand.on[c] == 0 {
                continue;
            }
            let hx = lanes[i] + (rand.next() - 0.5) * 40.0;
            let hy = ((c as f32 + 0.5) / n as f32) * HF + (rand.next() - 0.5) * 8.0;
            let a = 0.3 + 0.45 * book.wn[c].min(2.0);
            let sg = sigma * (0.7 + 0.6 * rand.next());
            let r = sg * 3.0;
            let y0 = ((hy - r) / gf).floor().max(0.0) as isize;
            let y1 = ((gh - 1) as f32).min(((hy + r) / gf).ceil()) as isize;
            let x0 = ((hx - r) / gf).floor().max(0.0) as isize;
            let x1 = ((gw - 1) as f32).min(((hx + r) / gf).ceil()) as isize;
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let (xg, yg) = (x as f32 * gf, y as f32 * gf);
                    let v = a * (-((xg - hx).powi(2) + (yg - hy).powi(2)) / (2.0 * sg * sg)).exp();
                    let j = y as usize * gw + x as usize;
                    f[j] += v;
                    if v > best[j] {
                        best[j] = v;
                        d[j] = Some(i);
                    }
                }
            }
        }
    }
    let lo = f.iter().copied().fold(f32::INFINITY, f32::min);
    let hi = f.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let levels = 16 + (rand.next() * 12.0).floor() as usize;
    let step = (hi - lo) / levels as f32;
    // A wash of the storyline's colour, deeper up its hills.
    for y in 0..gh {
        for x in 0..gw {
            let j = y * gw + x;
            let Some(i) = d[j] else {
                continue;
            };
            if best[j] < 0.05 || s[i].neutral {
                continue;
            }
            ctx.set_fill_style(css(s[i].rgb, 0.2 * ((f[j] - lo) / (hi - lo)).powf(1.4)));
            ctx.fill_rect(x as f32 * gf - gf / 2.0, y as f32 * gf - gf / 2.0, gf, gf);
        }
    }
    // One path for each storyline (or none) and weight, in the order they
    // first appear.
    let mut paths: Vec<((Option<usize>, bool), Path2D)> = Vec::new();
    for l in 1..levels {
        let iso = lo + l as f32 * step;
        let major = l % 4 == 0;
        for y in 0..gh - 1 {
            for x in 0..gw - 1 {
                let a = f[y * gw + x];
                let b = f[y * gw + x + 1];
                let c = f[(y + 1) * gw + x + 1];
                let dd = f[(y + 1) * gw + x];
                let code = (u8::from(a > iso) << 3)
                    | (u8::from(b > iso) << 2)
                    | (u8::from(c > iso) << 1)
                    | u8::from(dd > iso);
                if code == 0 || code == 15 {
                    continue;
                }
                let px = x as f32 * gf;
                let py = y as f32 * gf;
                let at = |e: Edge| match e {
                    Edge::T => (px + (gf * (iso - a)) / (b - a), py),
                    Edge::R => (px + gf, py + (gf * (iso - b)) / (c - b)),
                    Edge::B => (px + (gf * (iso - dd)) / (c - dd), py + gf),
                    Edge::L => (px, py + (gf * (iso - a)) / (dd - a)),
                };
                let j = y * gw + x;
                let key = (d[j].filter(|_| best[j] > 0.04), major);
                let k = match paths.iter().position(|(k, _)| *k == key) {
                    Some(k) => k,
                    None => {
                        paths.push((key, Path2D::new()));
                        paths.len() - 1
                    }
                };
                let path = &mut paths[k].1;
                for &(e0, e1) in segments(code) {
                    let (x0, y0) = at(e0);
                    let (x1, y1) = at(e1);
                    path.move_to(x0, y0);
                    path.line_to(x1, y1);
                }
            }
        }
    }
    for ((i, major), path) in &paths {
        let rgb: Rgb = match i {
            Some(i) if !s[*i].neutral => mix(s[*i].rgb, [40, 30, 20], 0.18),
            _ => [128, 110, 88],
        };
        ctx.set_stroke_style(css(rgb, if *major { 0.92 } else { 0.62 }));
        ctx.set_line_width(if *major { 1.2 } else { 0.7 });
        ctx.stroke_path(path);
    }
    false
}
