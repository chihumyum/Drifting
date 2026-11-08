//! 地层 — rock strata: a layer for every chapter from the top down, thick
//! where the chapter is long, tinted where storylines run through it; the
//! beds are folded, sometimes broken by a fault.

use std::f32::consts::PI;

use crate::art::book::CoverBook;
use crate::art::paint::{
    Ctx, H, HF, Image, Rand, Rgb, TAU, W, WF, average_color, clamped, mix, noise1d, noise2d,
};

const EARTH: [Rgb; 7] = [
    [220, 202, 170],
    [200, 174, 136],
    [230, 218, 194],
    [184, 166, 142],
    [208, 188, 164],
    [194, 182, 164],
    [232, 210, 174],
];

struct Bed {
    rgb: Rgb,
    texture: usize,
    k: f32,
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let n = book.chapters;
    let nf = n as f32;
    let s: Vec<_> = book.strands.iter().filter(|s| !s.neutral).collect();
    let thick: Vec<f32> = (0..n).map(|c| 0.35 + 0.65 * book.wn[c].min(2.2)).collect();
    let scale = (HF + 40.0) / thick.iter().sum::<f32>();
    let fold_a = 10.0 + rand.next() * 40.0;
    let fold_f = 0.5 + rand.next() * 1.4;
    let fold_p = rand.next() * TAU;
    let tilt = (rand.next() - 0.5) * 0.3;
    // Each bed's top edge across the cover.
    let mut bounds: Vec<Vec<f32>> = Vec::with_capacity(n + 1);
    let mut y = -20.0;
    for c in 0..=n {
        let cell = 24.0 + rand.next() * 30.0;
        let wav = noise1d(W + 1, cell, rand);
        let b: Vec<f32> = (0..W)
            .map(|x| {
                let xf = x as f32;
                y + ((xf / WF) * PI * fold_f + fold_p).sin()
                    * fold_a
                    * (0.6 + 0.4 * (c as f32 / nf))
                    + (xf - WF / 2.0) * tilt
                    + (wav[x] - 0.5) * 3.0
            })
            .collect();
        bounds.push(b);
        if let Some(t) = thick.get(c) {
            y += t * scale;
        }
    }
    let beds: Vec<Bed> = (0..n)
        .map(|c| {
            let base = EARTH[(rand.next() * EARTH.len() as f32).floor() as usize];
            let present: Vec<Rgb> = s.iter().filter(|s| s.on[c] != 0).map(|s| s.rgb).collect();
            let rgb = if present.is_empty() {
                base
            } else {
                mix(base, average_color(&present), 0.45 + 0.2 * rand.next())
            };
            let texture = (rand.next() * 3.0).floor() as usize;
            let k = 0.8 + rand.next() * 1.6;
            Bed { rgb, texture, k }
        })
        .collect();
    let fault = rand.next() < 0.55;
    let fx0 = WF * (0.2 + 0.6 * rand.next());
    let fx1 = fx0 + (rand.next() - 0.5) * WF * 0.6;
    let shift = (if rand.next() < 0.5 { -1.0 } else { 1.0 }) * (8.0 + rand.next() * 26.0);
    let fine = noise2d(1.3, rand);
    let pebble = noise2d(2.2, rand);
    let mut img = Image::new();
    let d = &mut img.data;
    // The beds' edges a column at a time.
    let columns: Vec<Vec<f32>> = (0..W)
        .map(|x| bounds.iter().map(|b| b[x]).collect())
        .collect();
    for (x, edge) in columns.iter().enumerate() {
        let xf = x as f32;
        for yy in 0..H {
            let yf = yy as f32;
            let fx_at = fx0 + ((fx1 - fx0) * yf) / HF;
            let ys = if fault && xf > fx_at { yf - shift } else { yf };
            let mut c = 0;
            while c + 1 < n && edge[c + 1] <= ys {
                c += 1;
            }
            let bed = &beds[c];
            let i = yy * W + x;
            let mut f = 0.92 + 0.12 * fine[i];
            if bed.texture == 1 {
                f *= 0.96 + 0.05 * ((ys - edge[c]) * bed.k).sin();
            }
            if bed.texture == 2 && pebble[i] > 0.86 {
                f *= 0.8;
            }
            if (ys - edge[c]).min(edge[c + 1] - ys) < 0.9 {
                f *= 0.78;
            }
            if fault && (xf - fx_at).abs() < 0.9 {
                f *= 0.55;
            }
            d[i * 4] = clamped(f32::from(bed.rgb[0]) * f);
            d[i * 4 + 1] = clamped(f32::from(bed.rgb[1]) * f);
            d[i * 4 + 2] = clamped(f32::from(bed.rgb[2]) * f);
            d[i * 4 + 3] = 255;
        }
    }
    ctx.put_image_data(&img);
    false
}
