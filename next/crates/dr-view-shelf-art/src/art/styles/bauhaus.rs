//! 包豪斯 — a grid of the book's movements (rows) by its storylines
//! (columns): where a storyline carries a movement it gets a bold primitive
//! in its colour, large where the words run long; small black marks
//! elsewhere.

use std::f32::consts::PI;

use crate::art::book::{CoverBook, mean};
use crate::art::paint::{
    Composite, Ctx, HF, Rand, Rgb, TAU, WF, clamp, css1, ground_with, js_round, noise2d, vivid,
};

const BLACK: Rgb = [30, 28, 28];

#[allow(clippy::too_many_arguments)]
fn primitive(
    ctx: &mut Ctx,
    x: f32,
    y: f32,
    cw: f32,
    rh: f32,
    scale: f32,
    rgb: Rgb,
    rand: &mut Rand,
) {
    let s = cw.min(rh) * scale;
    let cx = x + cw / 2.0;
    let cy = y + rh / 2.0;
    let kind = (rand.next() * 6.0).floor() as usize;
    let turn = (rand.next() * 4.0).floor() as usize;
    let rot = turn as f32 * (PI / 2.0);
    ctx.set_fill_style(css1(rgb));
    ctx.set_stroke_style(css1(rgb));
    ctx.begin_path();
    match kind {
        0 => ctx.arc(cx, cy, s / 2.0, 0.0, TAU),
        1 => {
            ctx.arc(cx, cy, s / 2.0, rot, rot + PI);
            ctx.close_path();
        }
        2 => {
            // A quarter disc from one corner of the cell.
            let qx = cx + (if turn == 0 || turn == 3 { -1.0 } else { 1.0 }) * (s / 2.0);
            let qy = cy + (if turn < 2 { -1.0 } else { 1.0 }) * (s / 2.0);
            let toward = (cy - qy).atan2(cx - qx);
            ctx.move_to(qx, qy);
            ctx.arc(qx, qy, s, toward - PI / 4.0, toward + PI / 4.0);
            ctx.close_path();
        }
        3 => {
            ctx.move_to(cx + (rot.cos() * s) / 2.0, cy + (rot.sin() * s) / 2.0);
            ctx.line_to(
                cx + ((rot + 2.1).cos() * s) / 2.0,
                cy + ((rot + 2.1).sin() * s) / 2.0,
            );
            ctx.line_to(
                cx + ((rot + 4.2).cos() * s) / 2.0,
                cy + ((rot + 4.2).sin() * s) / 2.0,
            );
            ctx.close_path();
        }
        4 => ctx.rect(cx - s / 2.0, cy - s / 2.0, s, s),
        _ => {
            ctx.arc(cx, cy, s * 0.4, 0.0, TAU);
            ctx.set_line_width(s * 0.18);
            ctx.stroke();
            return;
        }
    }
    ctx.fill();
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let tooth = noise2d(1.6, rand);
    ctx.put_image_data(&ground_with([241, 236, 225], |i, _, _| {
        0.985 + 0.015 * tooth[i]
    }));
    let s = &book.strands;
    let n = s.len();
    let chapters = book.chapters;
    let nf = chapters as f32;
    let cols = if n <= 1 { 2 } else { n.min(4) };
    let rows = clamp(js_round(nf / (2.0 + rand.next() * 3.0)), 5.0, 9.0) as usize;
    let mx = 10.0;
    let top = 10.0;
    let cw = (WF - 2.0 * mx) / cols as f32;
    let rh = (HF - top - 10.0) / rows as f32;
    // Overlapping shapes overprint.
    ctx.set_composite(Composite::Multiply);
    for r in 0..rows {
        let c0 = (chapters - 1).min(((r as f32 / rows as f32) * nf).floor() as usize);
        let c1 =
            (c0 as isize).max((((r + 1) as f32 / rows as f32) * nf).floor() as isize - 1) as usize;
        let words = mean(&book.wn, c0, c1).min(1.8) / 1.8;
        for k in 0..cols {
            let st = &s[k % n];
            let x = mx + k as f32 * cw;
            let y = top + r as f32 * rh;
            let on: Vec<f32> = st.on[c0..=c1].iter().map(|&v| f32::from(v)).collect();
            if mean(&on, 0, c1 - c0) > 0.34 {
                let scale = (0.5 + 0.7 * words) * (0.85 + 0.3 * rand.next());
                let rgb = if st.neutral {
                    BLACK
                } else {
                    vivid(st.rgb, 1.35, 1.0)
                };
                primitive(ctx, x, y, cw, rh, scale, rgb, rand);
            } else if rand.next() < 0.2 {
                ctx.set_fill_style(css1(BLACK));
                if rand.next() < 0.5 {
                    ctx.begin_path();
                    ctx.arc(x + cw / 2.0, y + rh / 2.0, 2.6, 0.0, TAU);
                    ctx.fill();
                } else {
                    ctx.fill_rect(x + cw * 0.2, y + rh / 2.0 - 1.0, cw * 0.6, 2.0);
                }
            }
        }
    }
    ctx.set_composite(Composite::SourceOver);
    if rand.next() < 0.6 {
        ctx.set_fill_style(css1(BLACK));
        let at = top + (rand.next() * rows as f32).floor() * rh - 1.5;
        ctx.fill_rect(mx, at, WF - 2.0 * mx, 3.0);
    }
    false
}
