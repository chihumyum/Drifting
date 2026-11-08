//! 蓝晒 — a cyanotype: each storyline a plant laid on the coated paper, a
//! leaf shape of its own, a leaf for every chapter it carries, large where
//! the chapter is long; the plants print white on Prussian blue.

use std::f32::consts::PI;

use tiny_skia::{Color, LineCap};

use crate::art::book::{CoverBook, lanes_of, shuffled};
use crate::art::paint::{
    Ctx, H, HF, Image, PAPER, Point, Rand, Rgb, TAU, W, WF, clamped, css, noise2d, noise2d_xy, pt,
    smoothstep,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Leaf {
    Ellipse,
    Lance,
    Fan,
    Frond,
    Blade,
    Round,
}

const LEAVES: [Leaf; 6] = [
    Leaf::Ellipse,
    Leaf::Lance,
    Leaf::Fan,
    Leaf::Frond,
    Leaf::Blade,
    Leaf::Round,
];
const BLUE: Rgb = [22, 58, 112];

#[allow(clippy::too_many_arguments)]
fn leaf(ctx: &mut Ctx, kind: Leaf, x: f32, y: f32, ang: f32, l: f32, rand: &mut Rand) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    let white = css([240, 246, 253], 0.74 + rand.next() * 0.2);
    let vein = css([36, 76, 136], 0.4);
    ctx.set_fill_style(white);
    match kind {
        Leaf::Ellipse | Leaf::Lance => {
            let w = if kind == Leaf::Ellipse {
                l * 0.34
            } else {
                l * 0.15
            };
            ctx.begin_path();
            ctx.move_to(0.0, 0.0);
            ctx.quadratic_curve_to(l * 0.45, -w * 1.6, l, 0.0);
            ctx.quadratic_curve_to(l * 0.45, w * 1.6, 0.0, 0.0);
            ctx.fill();
            ctx.set_stroke_style(vein);
            ctx.set_line_width(0.55);
            ctx.begin_path();
            ctx.move_to(0.0, 0.0);
            ctx.line_to(l * 0.9, 0.0);
            for k in 1..4 {
                let a = (k as f32 / 4.0) * l * 0.9;
                ctx.move_to(a, 0.0);
                ctx.line_to(a + l * 0.13, -w * 0.6);
                ctx.move_to(a, 0.0);
                ctx.line_to(a + l * 0.13, w * 0.6);
            }
            ctx.stroke();
        }
        Leaf::Fan => {
            ctx.set_stroke_style(white);
            ctx.set_line_width(1.0);
            ctx.begin_path();
            ctx.move_to(0.0, 0.0);
            ctx.line_to(l * 0.45, 0.0);
            ctx.stroke();
            ctx.begin_path();
            ctx.move_to(l * 0.4, 0.0);
            ctx.arc(l * 0.4, 0.0, l * 0.62, -0.8, -0.06);
            ctx.line_to(l * 0.88, 0.0);
            ctx.arc(l * 0.4, 0.0, l * 0.62, 0.06, 0.8);
            ctx.close_path();
            ctx.fill();
            ctx.set_stroke_style(vein);
            ctx.set_line_width(0.45);
            ctx.begin_path();
            for k in -4..=4 {
                let a = k as f32 * 0.18;
                ctx.move_to(l * 0.4, 0.0);
                ctx.line_to(l * 0.4 + a.cos() * l * 0.6, a.sin() * l * 0.6);
            }
            ctx.stroke();
        }
        Leaf::Frond => {
            ctx.set_stroke_style(white);
            ctx.set_line_width(0.9);
            ctx.begin_path();
            ctx.move_to(0.0, 0.0);
            ctx.line_to(l * 1.25, 0.0);
            ctx.stroke();
            for k in 1..=8 {
                let a = (k as f32 / 9.0) * l * 1.25;
                let s = l * 0.24 * (1.0 - k as f32 / 10.0);
                ctx.begin_path();
                ctx.ellipse(a, -s * 0.75, s, s * 0.32, -0.9, 0.0, TAU);
                ctx.fill();
                ctx.begin_path();
                ctx.ellipse(a, s * 0.75, s, s * 0.32, 0.9, 0.0, TAU);
                ctx.fill();
            }
        }
        Leaf::Blade => {
            let bend = (rand.next() - 0.5) * l * 0.7;
            ctx.begin_path();
            ctx.move_to(0.0, -1.3);
            ctx.quadratic_curve_to(l * 0.7, bend - 1.6, l * 1.6, bend * 1.7);
            ctx.quadratic_curve_to(l * 0.7, bend + 1.6, 0.0, 1.3);
            ctx.fill();
        }
        Leaf::Round => {
            ctx.set_stroke_style(white);
            ctx.set_line_width(0.9);
            ctx.begin_path();
            ctx.move_to(0.0, 0.0);
            ctx.line_to(l * 0.5, 0.0);
            ctx.stroke();
            let r = l * 0.42;
            let cx = l * 0.5 + r * 0.7;
            ctx.begin_path();
            ctx.arc(cx, 0.0, r, 0.0, TAU);
            ctx.fill();
            ctx.set_stroke_style(vein);
            ctx.set_line_width(0.45);
            ctx.begin_path();
            for k in 0..9 {
                let a = (k as f32 / 9.0) * TAU;
                ctx.move_to(cx - r * 0.3, 0.0);
                ctx.line_to(cx + a.cos() * r * 0.9, a.sin() * r * 0.9);
            }
            ctx.stroke();
        }
    }
    ctx.restore();
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let mottle = noise2d(26.0, rand);
    let fine = noise2d(2.0, rand);
    let edge_n = noise2d(9.0, rand);
    let streak = noise2d_xy(60.0, 3.0, rand);
    // The coat is brushed on by hand, so its edge is ragged and the paper
    // shows past it.
    let m = 6.0 + rand.next() * 9.0;
    let mut img = Image::new();
    let d = &mut img.data;
    for i in 0..W * H {
        let x = i % W;
        let y = i / W;
        let edge = x.min(y).min(W - 1 - x).min(H - 1 - y) as f32;
        let coat = smoothstep(m * 0.2, m, edge + (edge_n[i] - 0.5) * m * 1.8);
        let tone = 0.8 + 0.28 * mottle[i] + 0.08 * streak[i] + 0.05 * fine[i];
        for k in 0..3 {
            let paper = f32::from(PAPER[k]);
            d[i * 4 + k] = clamped(paper + (f32::from(BLUE[k]) * tone - paper) * coat);
        }
        d[i * 4 + 3] = 255;
    }
    ctx.put_image_data(&img);
    let s = &book.strands;
    let n = book.chapters;
    let lanes = lanes_of(s.len());
    let kinds = shuffled(&LEAVES, rand);
    ctx.set_shadow_color(css([232, 242, 255], 0.8));
    ctx.set_shadow_blur(2.5);
    for (i, strand) in s.iter().enumerate() {
        let kind = kinds[i % kinds.len()];
        let xb = lanes[i] + (rand.next() - 0.5) * 30.0;
        let xt = lanes[i] + (rand.next() - 0.5) * 50.0;
        let bend = (rand.next() - 0.5) * 70.0;
        let at = |u: f32| -> Point {
            pt(
                xt + (xb - xt) * u + (u * PI).sin() * bend,
                -12.0 + u * (HF + 24.0),
            )
        };
        ctx.set_stroke_style(css([238, 244, 252], 0.88));
        ctx.set_line_cap(LineCap::Round);
        ctx.set_line_width(1.2 + rand.next() * 1.1);
        ctx.begin_path();
        // Stepped in doubles, as the 0.1 client counts its 101 steps.
        let mut u = 0.0f64;
        while u <= 1.0001 {
            let p = at(u as f32);
            if u != 0.0 {
                ctx.line_to(p.x, p.y);
            } else {
                ctx.move_to(p.x, p.y);
            }
            u += 0.01;
        }
        ctx.stroke();
        let mut side = if rand.next() < 0.5 { -1.0 } else { 1.0 };
        for c in 0..n {
            if strand.on[c] == 0 {
                continue;
            }
            let u = (c as f32 + 0.5) / n as f32;
            let p = at(u);
            let q = at((u + 0.01).min(1.0));
            let up = (q.y - p.y).atan2(q.x - p.x) + PI;
            let l = (8.0 + 13.0 * book.wn[c].min(1.7)) * (0.8 + 0.4 * rand.next());
            let ang = up + side * (0.45 + 0.55 * rand.next());
            leaf(ctx, kind, p.x, p.y, ang, l, rand);
            side = -side;
        }
    }
    ctx.set_shadow_blur(0.0);
    ctx.set_shadow_color(Color::TRANSPARENT);
    // Dust and seeds caught in the exposure.
    for _ in 0..46 {
        ctx.set_fill_style(css([236, 244, 252], 0.12 + rand.next() * 0.35));
        ctx.begin_path();
        let x = rand.next() * WF;
        let y = rand.next() * HF;
        let r = 0.4 + rand.next() * 1.1;
        ctx.arc(x, y, r, 0.0, TAU);
        ctx.fill();
    }
    true
}
