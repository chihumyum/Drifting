//! 剪纸 — cut paper: every stretch a storyline carries is cut as one bold
//! shape in its colour, a shape of its own kind, large where the words run
//! long, a long stretch as several down its length; offcuts lie about.

use tiny_skia::Color;

use crate::art::book::{CoverBook, lanes_of, mean, merge_runs, runs, shuffled};
use crate::art::paint::{
    Ctx, HF, Point, Rand, Rgb, TAU, WF, css, css1, ground_with, js_round, noise1d, noise2d, pt,
    smooth_closed, vivid,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cut {
    Algae,
    Burst,
    Seed,
    Pebble,
}

const CUTS: [Cut; 4] = [Cut::Algae, Cut::Burst, Cut::Seed, Cut::Pebble];
const SHEETS: [Rgb; 5] = [
    [250, 246, 238],
    [228, 236, 240],
    [245, 230, 220],
    [234, 237, 224],
    [40, 44, 58],
];

#[allow(clippy::too_many_arguments)]
fn cut_shape(
    ctx: &mut Ctx,
    kind: Cut,
    cx: f32,
    cy: f32,
    sx: f32,
    sy: f32,
    rgb: Rgb,
    rand: &mut Rand,
) {
    const M: usize = 140;
    let mut pts: Vec<Point> = Vec::with_capacity(M);
    let k = match kind {
        Cut::Algae => 5.0 + (rand.next() * 5.0).floor(),
        Cut::Burst => 7.0 + (rand.next() * 6.0).floor(),
        _ => 3.0,
    };
    let ph = rand.next() * TAU;
    let ph2 = rand.next() * TAU;
    let rot = (rand.next() - 0.5) * 0.7;
    let wob = noise1d(M + 3, 10.0, rand);
    for (m, &wob) in wob.iter().enumerate().take(M) {
        let th = (m as f32 / M as f32) * TAU;
        let r = match kind {
            Cut::Algae => {
                0.5 + 0.5 * ((k * th) / 2.0 + ph).sin().abs().powf(0.55) + 0.12 * (wob - 0.5)
            }
            Cut::Burst => {
                0.42 + 0.58 * ((k * th) / 2.0 + ph).cos().abs().powf(2.6) + 0.05 * (wob - 0.5)
            }
            Cut::Seed => 0.75 + 0.25 * (th - ph).cos() + 0.08 * (wob - 0.5),
            Cut::Pebble => {
                0.82 + 0.12 * (3.0 * th + ph).sin()
                    + 0.08 * (5.0 * th + ph2).sin()
                    + 0.12 * (wob - 0.5)
            }
        };
        let x = (th.cos() * r * sx) / 2.0;
        let y = (th.sin() * r * sy) / 2.0;
        pts.push(pt(
            cx + x * rot.cos() - y * rot.sin(),
            cy + x * rot.sin() + y * rot.cos(),
        ));
    }
    ctx.set_fill_style(css1(rgb));
    smooth_closed(ctx, &pts);
    ctx.fill();
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let sheet = (rand.next() * SHEETS.len() as f32).floor() as usize;
    let dark = sheet == SHEETS.len() - 1;
    let tooth = noise2d(1.5, rand);
    ctx.put_image_data(&ground_with(SHEETS[sheet], |i, _, _| {
        0.985 + 0.015 * tooth[i]
    }));
    let s = &book.strands;
    let n = book.chapters;
    let nf = n as f32;
    let lanes = lanes_of(s.len());
    ctx.set_shadow_color(css([30, 20, 10], 0.24));
    ctx.set_shadow_blur(3.0);
    ctx.set_shadow_offset(1.2, 1.8);
    let kinds = shuffled(&CUTS, rand);
    for (i, st) in s.iter().enumerate() {
        let kind = kinds[i % kinds.len()];
        let rgb: Rgb = if st.neutral {
            if dark { [236, 230, 218] } else { [40, 44, 58] }
        } else {
            vivid(st.rgb, 1.4, 1.02)
        };
        for (a, b) in merge_runs(&runs(&st.on), 1) {
            let len = (b - a + 1) as f32;
            let span = (len / nf) * HF;
            let pieces = js_round(span / 110.0).max(1.0) as usize;
            for p in 0..pieces {
                let cy = ((a as f32 + ((p as f32 + 0.5) / pieces as f32) * len) / nf) * HF;
                let size = (34.0 + 54.0 * (mean(&book.wn, a, b).min(1.6) / 1.6).powf(0.7))
                    * (0.75 + 0.5 * rand.next());
                let sy = 170f32.min(size.max((span / pieces as f32) * (0.8 + 0.4 * rand.next())));
                let cx = lanes[i] + (rand.next() - 0.5) * 50.0;
                cut_shape(ctx, kind, cx, cy, size, sy, rgb, rand);
            }
        }
        let offcuts = 2 + (rand.next() * 4.0).floor() as usize;
        for _ in 0..offcuts {
            let s0 = 6.0 + rand.next() * 10.0;
            let kind = if rand.next() < 0.5 {
                Cut::Seed
            } else {
                Cut::Burst
            };
            let x = rand.next() * WF;
            let y = rand.next() * HF;
            let sy = s0 * (0.8 + rand.next());
            cut_shape(ctx, kind, x, y, s0, sy, rgb, rand);
        }
    }
    ctx.set_shadow_color(Color::TRANSPARENT);
    ctx.set_shadow_blur(0.0);
    ctx.set_shadow_offset(0.0, 0.0);
    dark
}
