//! 结绳 — a quipu: each storyline a dyed cord hung from one rope, its
//! chapters tied as knots down the cord, a run of chapters as a long knot,
//! the knots fat where the chapters are long.

use std::f32::consts::PI;

use tiny_skia::{LineCap, LineJoin};

use crate::art::book::{CoverBook, lanes_of, mean, runs};
use crate::art::paint::{
    Ctx, H, HF, Point, RadialGradient, Rand, Rgb, TAU, WF, clamp, css, css1, ground_with, mix,
    noise1d, noise2d, pt,
};

const DARK: Rgb = [40, 28, 16];
const WHITE: Rgb = [255, 255, 255];

fn rope(ctx: &mut Ctx, pts: &[Point], w: f32, rgb: Rgb) {
    ctx.set_line_cap(LineCap::Round);
    ctx.set_line_join(LineJoin::Round);
    let line = |ctx: &mut Ctx, dx: f32, dy: f32| {
        ctx.begin_path();
        for (i, p) in pts.iter().enumerate() {
            if i > 0 {
                ctx.line_to(p.x + dx, p.y + dy);
            } else {
                ctx.move_to(p.x + dx, p.y + dy);
            }
        }
    };
    line(ctx, 0.6, 0.8);
    ctx.set_stroke_style(css([60, 40, 20], 0.18));
    ctx.set_line_width(w + 1.2);
    ctx.stroke();
    line(ctx, 0.0, 0.0);
    ctx.set_stroke_style(css1(rgb));
    ctx.set_line_width(w);
    ctx.stroke();
    // The twist: short diagonals across the cord.
    ctx.set_stroke_style(css(mix(rgb, DARK, 0.38), 0.55));
    ctx.set_line_width(0.7);
    ctx.begin_path();
    let mut along = 0.0;
    for i in 1..pts.len() {
        let a = pts[i - 1];
        let b = pts[i];
        let len = (b.x - a.x).hypot(b.y - a.y);
        let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
        along += len;
        if along < w * 0.8 {
            continue;
        }
        along = 0.0;
        let tx = (b.x - a.x) / len;
        let ty = (b.y - a.y) / len;
        let h = w / 2.0;
        ctx.move_to(b.x - ty * h - tx * h * 0.7, b.y + tx * h - ty * h * 0.7);
        ctx.line_to(b.x + ty * h + tx * h * 0.7, b.y - tx * h + ty * h * 0.7);
    }
    ctx.stroke();
    line(ctx, -w * 0.2, -w * 0.2);
    ctx.set_stroke_style(css(mix(rgb, WHITE, 0.35), 0.45));
    ctx.set_line_width((w * 0.18).max(0.6));
    ctx.stroke();
}

fn knot(ctx: &mut Ctx, x: f32, y: f32, r: f32, rgb: Rgb, rand: &mut Rand) {
    let mut g = RadialGradient::new(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r * 1.15);
    g.add_color_stop(0.0, css1(mix(rgb, WHITE, 0.32)));
    g.add_color_stop(0.55, css1(rgb));
    g.add_color_stop(1.0, css1(mix(rgb, DARK, 0.45)));
    ctx.set_fill_style(g);
    ctx.begin_path();
    ctx.ellipse(
        x,
        y,
        r * 0.95,
        r * 1.08,
        (rand.next() - 0.5) * 0.5,
        0.0,
        TAU,
    );
    ctx.fill();
    ctx.set_stroke_style(css(mix(rgb, DARK, 0.5), 0.5));
    ctx.set_line_width(0.7);
    for k in -1..=1 {
        ctx.begin_path();
        ctx.ellipse(
            x,
            y + k as f32 * r * 0.38,
            r * 0.88,
            r * 0.3,
            0.3,
            0.1 * PI,
            0.9 * PI,
        );
        ctx.stroke();
    }
}

fn long_knot(ctx: &mut Ctx, at: &dyn Fn(f32) -> f32, ya: f32, yb: f32, r: f32, rgb: Rgb) {
    let mut pts = Vec::new();
    let mut y = ya;
    while y <= yb {
        pts.push(pt(at(y), y));
        y += 1.5;
    }
    let line = |ctx: &mut Ctx, dx: f32| {
        ctx.begin_path();
        for (i, p) in pts.iter().enumerate() {
            if i > 0 {
                ctx.line_to(p.x + dx, p.y);
            } else {
                ctx.move_to(p.x + dx, p.y);
            }
        }
    };
    ctx.set_line_cap(LineCap::Round);
    line(ctx, 0.0);
    ctx.set_stroke_style(css1(mix(rgb, DARK, 0.42)));
    ctx.set_line_width(r * 2.0 + 1.0);
    ctx.stroke();
    ctx.set_stroke_style(css1(rgb));
    ctx.set_line_width(r * 2.0 - 0.6);
    ctx.stroke();
    line(ctx, -r * 0.4);
    ctx.set_stroke_style(css(mix(rgb, WHITE, 0.3), 0.55));
    ctx.set_line_width(r * 0.5);
    ctx.stroke();
    ctx.set_stroke_style(css(mix(rgb, DARK, 0.5), 0.5));
    ctx.set_line_width(0.75);
    let mut y = ya;
    while y <= yb {
        let x = at(y);
        ctx.begin_path();
        ctx.move_to(x - r, y - r * 0.3);
        ctx.quadratic_curve_to(x, y + r * 0.4, x + r, y - r * 0.3);
        ctx.stroke();
        y += 2.3;
    }
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let fibre = noise2d(1.4, rand);
    let mottle = noise2d(30.0, rand);
    ctx.put_image_data(&ground_with([238, 229, 211], |i, _, _| {
        0.97 + 0.02 * fibre[i] + 0.025 * mottle[i]
    }));
    let s = &book.strands;
    let n = book.chapters;
    let top = 18.0 + rand.next() * 8.0;
    let sag = 4.0 + rand.next() * 9.0;
    let primary_y = |x: f32| top + sag * ((x / WF) * PI).sin();
    let lanes: Vec<f32> = lanes_of(s.len())
        .into_iter()
        .map(|x| x + (rand.next() - 0.5) * 16.0)
        .collect();
    for (i, strand) in s.iter().enumerate() {
        let cord: Rgb = if strand.neutral {
            [212, 198, 170]
        } else {
            mix(strand.rgb, [235, 225, 205], 0.1)
        };
        let x0 = lanes[i];
        let y0 = primary_y(x0);
        let end = HF - 10.0 - rand.next() * 46.0;
        let cell = 90.0 + rand.next() * 80.0;
        let sway = noise1d(H + 2, cell, rand);
        let amp = 10.0 + rand.next() * 22.0;
        let at = |y: f32| {
            x0 + (sway[clamp(y, 0.0, HF).floor() as usize] - sway[y0.floor() as usize]) * amp
        };
        let mut pts = Vec::new();
        let mut y = y0;
        while y <= end {
            pts.push(pt(at(y), y));
            y += 2.0;
        }
        let cw = 3.2 + rand.next() * 1.4;
        rope(ctx, &pts, cw, cord);
        let span0 = y0 + 16.0;
        let step = (end - 12.0 - span0) / n as f32;
        let y_at = |c: usize| span0 + (c as f32 + 0.5) * step;
        for (a, b) in runs(&strand.on) {
            // A long run is tied as several long knots.
            let mut c = a;
            while c <= b {
                let e = b.min(c + 5);
                let words = mean(&book.wn, c, e).min(1.8);
                if e == c {
                    knot(
                        ctx,
                        at(y_at(c)),
                        y_at(c),
                        cw * (1.15 + 0.6 * words),
                        cord,
                        rand,
                    );
                } else {
                    long_knot(
                        ctx,
                        &at,
                        y_at(c) - step * 0.3,
                        y_at(e) + step * 0.3,
                        cw * (0.95 + 0.35 * words),
                        cord,
                    );
                }
                c += 6;
            }
        }
        // The frayed end.
        ctx.set_stroke_style(css(cord, 0.85));
        ctx.set_line_width(0.8);
        for _ in 0..7 {
            ctx.begin_path();
            ctx.move_to(at(end), end);
            let cx = at(end) + (rand.next() - 0.5) * cw * 2.0;
            let x = at(end) + (rand.next() - 0.5) * cw * 3.2;
            let y = end + 7.0 + rand.next() * 7.0;
            ctx.quadratic_curve_to(cx, end + 5.0, x, y);
            ctx.stroke();
        }
    }
    let mut primary = Vec::new();
    let mut x = -10.0;
    while x <= WF + 10.0 {
        primary.push(pt(x, primary_y(x)));
        x += 2.0;
    }
    rope(ctx, &primary, 5.6, [190, 164, 120]);
    false
}
