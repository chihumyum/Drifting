//! 星图 — a star chart: a storyline's chapters are its stars, bright where
//! the chapter is long, joined into a constellation while the storyline runs
//! and broken where it is away; field stars and a faint graticule behind.

use std::f32::consts::PI;

use crate::art::book::{CoverBook, lanes_of};
use crate::art::paint::{
    Ctx, HF, RadialGradient, Rand, Rgb, TAU, WF, clamp, css, css1, ground_with, mix, noise2d, vivid,
};

const WHITE: Rgb = [255, 255, 255];

struct Star {
    x: f32,
    y: f32,
    mag: f32,
}

fn glow_star(ctx: &mut Ctx, x: f32, y: f32, r: f32, rgb: Rgb) {
    let mut g = RadialGradient::new(x, y, 0.0, x, y, r * 5.0);
    g.add_color_stop(0.0, css(rgb, 0.45));
    g.add_color_stop(1.0, css(rgb, 0.0));
    ctx.set_fill_style(g);
    ctx.begin_path();
    ctx.arc(x, y, r * 5.0, 0.0, TAU);
    ctx.fill();
    ctx.set_fill_style(css1(mix(rgb, WHITE, 0.65)));
    ctx.begin_path();
    ctx.arc(x, y, r * 0.7, 0.0, TAU);
    ctx.fill();
    if r > 2.3 {
        ctx.set_stroke_style(css(rgb, 0.5));
        ctx.set_line_width(0.6);
        ctx.begin_path();
        ctx.move_to(x - r * 4.0, y);
        ctx.line_to(x + r * 4.0, y);
        ctx.move_to(x, y - r * 4.0);
        ctx.line_to(x, y + r * 4.0);
        ctx.stroke();
    }
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let neb = noise2d(60.0, rand);
    let fine = noise2d(3.0, rand);
    ctx.put_image_data(&ground_with([15, 20, 36], |i, x, y| {
        0.85 + 0.4 * neb[i] * (1.0 - (x as f32 / WF - 0.5).hypot(y as f32 / HF - 0.5))
            + 0.04 * fine[i]
    }));
    ctx.set_stroke_style(css([200, 215, 255], 0.07));
    ctx.set_line_width(0.7);
    let gcx = WF * (rand.next() * 2.0 - 0.5);
    let gcy = -HF * (0.6 + rand.next());
    for k in 1..=9 {
        ctx.begin_path();
        ctx.arc(gcx, gcy, HF * 0.6 + k as f32 * 46.0, 0.0, TAU);
        ctx.stroke();
    }
    ctx.begin_path();
    for k in -7..=7 {
        let a = PI / 2.0 + k as f32 * 0.12;
        ctx.move_to(gcx, gcy);
        ctx.line_to(gcx + a.cos() * HF * 3.0, gcy + a.sin() * HF * 3.0);
    }
    ctx.stroke();
    for _ in 0..220 {
        ctx.set_fill_style(css([230, 236, 255], 0.1 + rand.next() * 0.45));
        ctx.begin_path();
        let x = rand.next() * WF;
        let y = rand.next() * HF;
        let r = 0.35 + rand.next() * 0.6;
        ctx.arc(x, y, r, 0.0, TAU);
        ctx.fill();
    }
    let s = &book.strands;
    let n = book.chapters;
    let lanes = lanes_of(s.len());
    for (i, st) in s.iter().enumerate() {
        let tint: Rgb = if st.neutral {
            [220, 226, 240]
        } else {
            mix(vivid(st.rgb, 1.25, 1.0), WHITE, 0.35)
        };
        let mut x = lanes[i];
        let mut placed: Vec<Option<Star>> = Vec::with_capacity(n);
        for c in 0..n {
            // A random walk held near its lane.
            x += (rand.next() - 0.5) * 28.0;
            x += (lanes[i] - x) * 0.22;
            if st.on[c] == 0 {
                placed.push(None);
                continue;
            }
            let y = 30.0 + ((c as f32 + 0.5) / n as f32) * (HF - 56.0) + (rand.next() - 0.5) * 10.0;
            placed.push(Some(Star {
                x: clamp(x + (rand.next() - 0.5) * 12.0, 8.0, WF - 8.0),
                y,
                mag: 0.8 + 2.5 * (book.wn[c].min(1.8) / 1.8).powf(0.8),
            }));
        }
        ctx.set_stroke_style(css(tint, 0.42));
        ctx.set_line_width(0.75);
        ctx.begin_path();
        let mut last: Option<&Star> = None;
        let mut last_c: isize = -9;
        for (c, star) in placed.iter().enumerate() {
            let Some(star) = star else {
                continue;
            };
            if let Some(l) = last
                && c as isize - last_c <= 3
            {
                ctx.move_to(l.x, l.y);
                ctx.line_to(star.x, star.y);
            }
            last = Some(star);
            last_c = c as isize;
        }
        ctx.stroke();
        for star in placed.iter().flatten() {
            glow_star(ctx, star.x, star.y, star.mag, tint);
        }
    }
    true
}
