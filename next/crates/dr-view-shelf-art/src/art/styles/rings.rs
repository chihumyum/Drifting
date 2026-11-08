//! 年轮 — the book as a cut log: a ring for every chapter from the pith
//! out, wide where the chapter is long, stained in the colours of the
//! storylines that run through it; bark where the log ends inside the cover.

use tiny_skia::FillRule;

use crate::art::book::CoverBook;
use crate::art::paint::{
    Ctx, HF, Path2D, Rand, Rgb, TAU, WF, average_color, css, css1, ground_with, mix, noise2d,
};

const LATEWOOD: Rgb = [140, 92, 54];

fn ring_path(cx: f32, cy: f32, r: &[f32]) -> Path2D {
    let mut p = Path2D::new();
    let n = r.len();
    for a in 0..=n {
        let th = ((a % n) as f32 / n as f32) * TAU;
        let x = cx + th.cos() * r[a % n];
        let y = cy + th.sin() * r[a % n];
        if a > 0 {
            p.line_to(x, y);
        } else {
            p.move_to(x, y);
        }
    }
    p.close_path();
    p
}

struct Wobble {
    k: f32,
    a: f32,
    p: f32,
}

struct Ring {
    outer: Vec<f32>,
    mid: Vec<f32>,
    w: f32,
    stain: Rgb,
    present: bool,
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let grain = noise2d(1.5, rand);
    let cloud = noise2d(40.0, rand);
    ctx.put_image_data(&ground_with([236, 216, 184], |i, _, _| {
        0.95 + 0.04 * grain[i] + 0.03 * cloud[i]
    }));
    let n = book.chapters;
    let cx = WF * (0.12 + 0.76 * rand.next());
    let cy = HF * (0.1 + 0.8 * rand.next());
    let far = cx
        .hypot(cy)
        .max((WF - cx).hypot(cy))
        .max(cx.hypot(HF - cy))
        .max((WF - cx).hypot(HF - cy));
    let reach = far * (0.72 + 0.4 * rand.next());
    let widths: Vec<f32> = (0..n).map(|c| 0.3 + 0.7 * book.wn[c].min(2.2)).collect();
    let sum: f32 = widths.iter().sum();
    const A: usize = 200;
    let wobble: Vec<Wobble> = (0..4)
        .map(|k| {
            let a = (0.1 / (k + 1) as f32) * rand.next();
            let p = rand.next() * TAU;
            Wobble {
                k: (k + 2) as f32,
                a,
                p,
            }
        })
        .collect();
    // The tree grew more on one side.
    let ecc = 0.35 * rand.next();
    let lean = rand.next() * TAU;
    let mut r = vec![2.0f32; A];
    let mut grown: Vec<Ring> = Vec::with_capacity(n);
    for (c, &width) in widths.iter().enumerate() {
        let w = (width / sum) * reach;
        let mut outer = vec![0.0f32; A];
        let mut mid = vec![0.0f32; A];
        for a in 0..A {
            let th = (a as f32 / A as f32) * TAU;
            let mut f = 1.0 + ecc * (th - lean).cos();
            for o in &wobble {
                f += o.a * (o.k * th + o.p + c as f32 * 0.04).sin();
            }
            outer[a] = r[a] + w * f;
            mid[a] = (r[a] + outer[a]) / 2.0;
        }
        let present: Vec<Rgb> = book
            .strands
            .iter()
            .filter(|s| !s.neutral && s.on[c] != 0)
            .map(|s| s.rgb)
            .collect();
        grown.push(Ring {
            outer: outer.clone(),
            mid,
            w,
            stain: if present.is_empty() {
                LATEWOOD
            } else {
                mix(LATEWOOD, average_color(&present), 0.65)
            },
            present: !present.is_empty(),
        });
        r = outer;
    }
    for ring in &grown {
        if !ring.present {
            continue;
        }
        ctx.set_stroke_style(css(ring.stain, 0.16));
        ctx.set_line_width(ring.w);
        ctx.stroke_path(&ring_path(cx, cy, &ring.mid));
    }
    for ring in &grown {
        ctx.set_stroke_style(css(ring.stain, if ring.present { 0.9 } else { 0.5 }));
        ctx.set_line_width((ring.w * if ring.present { 0.36 } else { 0.2 }).max(0.6));
        ctx.stroke_path(&ring_path(cx, cy, &ring.outer));
    }
    if reach < far {
        let mut bark = Path2D::new();
        bark.rect(-5.0, -5.0, WF + 10.0, HF + 10.0);
        let edge: Vec<f32> = r.iter().map(|v| v + 1.0).collect();
        bark.add_path(&ring_path(cx, cy, &edge));
        ctx.save();
        ctx.set_fill_style(css1([92, 66, 46]));
        ctx.fill_path(&bark, FillRule::EvenOdd);
        ctx.clip_path(&bark, FillRule::EvenOdd);
        ctx.set_stroke_style(css([40, 26, 16], 0.5));
        for _ in 0..160 {
            let th = rand.next() * TAU;
            let rr = reach + 4.0 + rand.next() * far;
            let x = cx + th.cos() * rr;
            let y = cy + th.sin() * rr;
            let len = 6.0 + rand.next() * 14.0;
            ctx.set_line_width(0.6 + rand.next() * 1.4);
            ctx.begin_path();
            ctx.move_to(x, y);
            ctx.line_to(x + th.cos() * len, y + th.sin() * len);
            ctx.stroke();
        }
        ctx.restore();
    }
    // A check or two split from the pith.
    ctx.set_stroke_style(css([70, 44, 24], 0.55));
    ctx.set_line_width(1.1);
    let checks = 1 + (rand.next() * 2.0).floor() as usize;
    for _ in 0..checks {
        let th = rand.next() * TAU;
        let mut x = cx;
        let mut y = cy;
        ctx.begin_path();
        ctx.move_to(x, y);
        let len = reach * (0.25 + 0.4 * rand.next());
        let mut s = 0.0;
        while s < len {
            x += (th + (rand.next() - 0.5) * 0.4).cos() * 4.0;
            y += (th + (rand.next() - 0.5) * 0.4).sin() * 4.0;
            ctx.line_to(x, y);
            s += 4.0;
        }
        ctx.stroke();
    }
    ctx.set_fill_style(css([90, 58, 32], 0.8));
    ctx.begin_path();
    ctx.arc(cx, cy, 2.2, 0.0, TAU);
    ctx.fill();
    false
}
