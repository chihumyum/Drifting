//! 色域 — colour fields: the book cut by its words into two to four
//! movements, each a soft-edged field stacked down the cover, tall where it
//! is long, in the colours of the storylines that carry it, on a deep or
//! pale ground.

use crate::art::book::CoverBook;
use crate::art::paint::{
    Ctx, HF, Rand, Rgb, W, WF, average_color, clamped, ground_with, js_round, mix, noise2d,
    noise2d_xy, smoothstep, vivid,
};

const EARTH: [Rgb; 4] = [[150, 70, 52], [182, 128, 64], [70, 76, 96], [120, 92, 70]];

struct Block {
    rgb: Rgb,
    words: f32,
    y0: f32,
    y1: f32,
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let n = book.chapters;
    let s: Vec<_> = book.strands.iter().filter(|s| !s.neutral).collect();
    let k_cuts = n.min(2 + (rand.next() * 3.0).floor() as usize);
    let counted: f32 = book.words.iter().sum();
    let weight = |c: usize| if counted > 0.0 { book.words[c] } else { 1.0 };
    let total = if counted > 0.0 { counted } else { n as f32 };
    let mut cuts = vec![0];
    let mut acc = 0.0;
    let mut c = 0;
    while c + 1 < n && cuts.len() < k_cuts {
        acc += weight(c);
        if acc >= ((total * cuts.len() as f32) / k_cuts as f32) * (0.8 + 0.4 * rand.next()) {
            cuts.push(c + 1);
        }
        c += 1;
    }
    cuts.push(n);
    let mut blocks: Vec<Block> = Vec::new();
    for b in 0..cuts.len() - 1 {
        let a = cuts[b];
        let e = cuts[b + 1] - 1;
        let mut sum = 0.0;
        let mut parts: Vec<(Rgb, f32)> = Vec::new();
        for st in &s {
            let mut v = 0.0;
            for c in a..=e {
                v += f32::from(st.on[c]) * book.wn[c];
            }
            if v != 0.0 {
                parts.push((st.rgb, v));
                sum += v;
            }
        }
        let rgb: Rgb = if parts.is_empty() {
            EARTH[(rand.next() * EARTH.len() as f32).floor() as usize]
        } else {
            let channel = |k: usize| {
                js_round(parts.iter().map(|(c, v)| f32::from(c[k]) * v).sum::<f32>() / sum) as u8
            };
            [channel(0), channel(1), channel(2)]
        };
        let mut words = 0.0;
        for c in a..=e {
            words += weight(c);
        }
        blocks.push(Block {
            rgb: vivid(rgb, 1.25, 1.0),
            words: words.max(1.0),
            y0: 0.0,
            y1: 0.0,
        });
    }
    let dark = rand.next() < 0.55;
    let overall = average_color(&blocks.iter().map(|b| b.rgb).collect::<Vec<_>>());
    let ground_rgb = if dark {
        mix(overall, [22, 14, 12], 0.66)
    } else {
        mix(overall, [250, 243, 230], 0.72)
    };
    let mx = 15.0 + rand.next() * 12.0;
    let top = 18.0 + rand.next() * 18.0;
    let bottom = HF - 20.0 - rand.next() * 18.0;
    let gap = 8.0 + rand.next() * 12.0;
    let share: f32 = blocks.iter().map(|b| b.words.powf(0.8)).sum();
    let span = bottom - top - gap * (blocks.len() - 1) as f32;
    let mut y = top;
    for b in &mut blocks {
        b.y0 = y;
        b.y1 = y + (span * b.words.powf(0.8)) / share;
        y = b.y1 + gap;
        b.rgb = if dark {
            mix(b.rgb, [255, 236, 210], 0.08)
        } else {
            mix(b.rgb, [255, 250, 240], 0.12)
        };
    }
    let brush = noise2d_xy(60.0, 14.0, rand);
    let brush2 = noise2d_xy(34.0, 9.0, rand);
    let edge_n = noise2d(7.0, rand);
    let mut img = ground_with(ground_rgb, |i, _, _| 0.95 + 0.07 * brush[i]);
    let d = &mut img.data;
    for b in &blocks {
        let lift = mix(b.rgb, [255, 248, 236], 0.14);
        let from = (b.y0 - 10.0).floor().max(0.0) as usize;
        let to = (b.y1 + 10.0).ceil().min(HF) as usize;
        for yy in from..to {
            for x in 0..W {
                let i = yy * W + x;
                let (xf, yf) = (x as f32, yy as f32);
                let inside = (xf - mx).min(WF - mx - xf).min(yf - b.y0).min(b.y1 - yf);
                let a = smoothstep(-6.0, 7.0, inside + (edge_n[i] - 0.5) * 9.0)
                    * (0.84 + 0.16 * brush2[i]);
                if a <= 0.0 {
                    continue;
                }
                // The field glows a little lighter towards its middle.
                let glow = smoothstep(4.0, 46.0, inside) * 0.8;
                for k in 0..3 {
                    let c = f32::from(b.rgb[k]) + (f32::from(lift[k]) - f32::from(b.rgb[k])) * glow;
                    let o = f32::from(d[i * 4 + k]);
                    d[i * 4 + k] = clamped(o + (c * (0.95 + 0.08 * brush[i]) - o) * a);
                }
            }
        }
    }
    ctx.put_image_data(&img);
    dark
}
