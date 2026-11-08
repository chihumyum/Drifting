//! 孔版 — a risograph print: each storyline one spot ink, every stretch it
//! carries printed as a big shape (disc, arch, bar, half disc) in halftone
//! that fades along its length, sized by the words, each ink slightly off
//! register and the inks overprinting.

use crate::art::book::{CoverBook, lanes_of, mean, merge_runs, runs, shuffled};
use crate::art::paint::{
    Ctx, H, HF, Rand, Rgb, W, WF, ground_with, js_round, multiply_into, noise2d, smoothstep, vivid,
};

const ANGLES: [f32; 6] = [0.26, 0.79, 1.31, 0.0, 0.52, 1.05];

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let grain = noise2d(1.2, rand);
    let blot = noise2d(14.0, rand);
    let mut img = ground_with([246, 242, 233], |i, _, _| 0.985 + 0.015 * grain[i]);
    let s = &book.strands;
    let n = book.chapters as f32;
    let lanes = lanes_of(s.len());
    let angles = shuffled(&ANGLES, rand);
    let cell = 3.6 + rand.next() * 1.6;
    for (i, st) in s.iter().enumerate() {
        let ink: Rgb = if st.neutral {
            [36, 36, 42]
        } else {
            vivid(st.rgb, 1.45, 1.0)
        };
        let mut tone = vec![0.0f32; W * H];
        for (a, b) in merge_runs(&runs(&st.on), 1) {
            let y0 = (a as f32 / n) * HF;
            let y1 = ((b + 1) as f32 / n) * HF;
            let ym = (y0 + y1) / 2.0;
            let words = mean(&book.wn, a, b).min(1.6) / 1.6;
            let kind = (rand.next() * 4.0).floor() as usize;
            let cx = lanes[i] + (rand.next() - 0.5) * 30.0;
            let r = (22.0 + 38.0 * words) * (0.75 + 0.5 * rand.next());
            let flip = rand.next() < 0.5;
            let big_r = 80f32.min(r.max((y1 - y0) / 2.0));
            let t0 = if kind == 2 { y0 } else { ym - big_r };
            let t1 = if kind == 2 { y1 } else { ym + big_r };
            let (ya, yb) = (
                t0.floor().max(0.0) as usize,
                t1.ceil().clamp(0.0, HF) as usize,
            );
            let (xa, xb) = (
                (cx - big_r).floor().max(0.0) as usize,
                (cx + big_r).ceil().clamp(0.0, WF) as usize,
            );
            for y in ya..yb {
                for x in xa..xb {
                    let dx = x as f32 - cx;
                    let dy = y as f32 - ym;
                    let inside = match kind {
                        0 => dx * dx + dy * dy < big_r * big_r,
                        1 => {
                            (dy > 0.0 && dx.abs() < big_r * 0.7)
                                || dx * dx + dy * dy < (big_r * 0.7).powi(2)
                        }
                        2 => dx.abs() < r * 0.55,
                        _ => {
                            dx * dx + dy * dy < big_r * big_r
                                && (if flip { dx > 0.0 } else { dx < 0.0 })
                        }
                    };
                    if !inside {
                        continue;
                    }
                    let g = (y as f32 - t0) / (t1 - t0).max(1.0);
                    let v = 0.18 + 0.82 * (if flip { g } else { 1.0 - g });
                    let j = y * W + x;
                    if v > tone[j] {
                        tone[j] = v;
                    }
                }
            }
        }
        let ang = angles[i % angles.len()];
        let ca = ang.cos();
        let sa = ang.sin();
        let ox = (rand.next() - 0.5) * 5.0;
        let oy = (rand.next() - 0.5) * 5.0;
        let mut alpha = vec![0.0f32; W * H];
        for y in 0..H {
            for x in 0..W {
                let (xf, yf) = (x as f32, y as f32);
                let sx = js_round(xf - ox);
                let sy = js_round(yf - oy);
                if sx < 0.0 || sy < 0.0 || sx >= WF || sy >= HF {
                    continue;
                }
                let t = tone[sy as usize * W + sx as usize];
                if t == 0.0 {
                    continue;
                }
                let u = xf * ca + yf * sa;
                let v = -xf * sa + yf * ca;
                let fu = u / cell - js_round(u / cell);
                let fv = v / cell - js_round(v / cell);
                let dd = fu.hypot(fv) * cell;
                let rad = cell * 0.72 * t.sqrt();
                let j = y * W + x;
                alpha[j] = smoothstep(rad + 0.6, rad - 0.6, dd)
                    * (if blot[j] < 0.14 { 0.45 } else { 0.92 })
                    * (0.84 + 0.16 * grain[j]);
            }
        }
        multiply_into(&mut img.data, &alpha, ink, 1.0);
    }
    ctx.put_image_data(&img);
    false
}
