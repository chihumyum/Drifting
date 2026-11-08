//! 山脊 — every slice of the book a ridgeline, near ones hiding far ones;
//! each storyline rises as peaks in its own lane where it runs, higher where
//! the chapters are long, its peaks drawn in its colour.

use tiny_skia::LineJoin;

use crate::art::book::{CoverBook, lanes_of, row_at};
use crate::art::paint::{Ctx, HF, PAPER, Rand, Rgb, W, WF, css, css1, ground, noise1d};

const INK: Rgb = [40, 36, 32];

struct Pt {
    x: f32,
    y: f32,
    dom: Option<usize>,
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    ctx.put_image_data(&ground(PAPER));
    let s = &book.strands;
    let n = s.len();
    let lanes: Vec<f32> = lanes_of(n)
        .into_iter()
        .map(|x| x + (rand.next() - 0.5) * 24.0)
        .collect();
    let sig: Vec<f32> = s.iter().map(|_| 9.0 + rand.next() * 14.0).collect();
    let rows = 36 + (rand.next() * 24.0).floor() as usize;
    let top = 64.0 + rand.next() * 40.0;
    let gap = (HF - 30.0 - top) / (rows - 1) as f32;
    let lift = gap * (4.0 + rand.next() * 5.0);
    let x0 = 16.0;
    let x1 = WF - 16.0;
    ctx.set_line_join(LineJoin::Round);
    for r in 0..rows {
        let k = row_at(r as f32 / (rows - 1) as f32);
        let y0 = top + r as f32 * gap;
        let words = book.word_level[k];
        let cell = 2.0 + rand.next() * 3.0;
        let jit = noise1d(W + 1, cell, rand);
        let mut pts = Vec::new();
        let mut x = x0;
        while x <= x1 {
            let mut h = 0.0;
            let mut dom = None;
            let mut best = 0.0;
            for i in 0..n {
                let g = s[i].level[k]
                    * (0.45 + 0.55 * words.min(1.8))
                    * (-((x - lanes[i]).powi(2)) / (2.0 * sig[i].powi(2))).exp();
                h += g;
                if g > best {
                    best = g;
                    dom = Some(i);
                }
            }
            let j = jit[x.floor() as usize];
            let calm = (-((x - WF / 2.0).powi(2)) / (2.0 * (WF * 0.3).powi(2))).exp();
            h = h * lift * (0.7 + 0.6 * j) + calm * gap * 0.5 * j;
            pts.push(Pt {
                x,
                y: y0 - h,
                dom: if best > 0.06 { dom } else { None },
            });
            x += 1.5;
        }
        // Paper under the line hides the ridges behind it.
        ctx.begin_path();
        ctx.move_to(pts[0].x, pts[0].y);
        for p in &pts {
            ctx.line_to(p.x, p.y);
        }
        ctx.line_to(x1, HF + 2.0);
        ctx.line_to(x0, HF + 2.0);
        ctx.close_path();
        ctx.set_fill_style(css1(PAPER));
        ctx.fill();
        ctx.begin_path();
        for (i, p) in pts.iter().enumerate() {
            if i > 0 {
                ctx.line_to(p.x, p.y);
            } else {
                ctx.move_to(p.x, p.y);
            }
        }
        ctx.set_stroke_style(css(INK, 0.82));
        ctx.set_line_width(1.15);
        ctx.stroke();
        for (i, strand) in s.iter().enumerate() {
            if strand.neutral {
                continue;
            }
            ctx.begin_path();
            let mut on = false;
            for p in &pts {
                if p.dom != Some(i) {
                    on = false;
                    continue;
                }
                if on {
                    ctx.line_to(p.x, p.y);
                } else {
                    ctx.move_to(p.x, p.y);
                }
                on = true;
            }
            ctx.set_stroke_style(css(strand.rgb, 0.95));
            ctx.set_line_width(1.7);
            ctx.stroke();
        }
    }
    false
}
