//! 织物 — a woven cloth: each storyline a band of dyed warp threads that
//! float over the weft through the chapters it carries and dip under
//! elsewhere; a chapter is a band of weft, thick where it is long.

use crate::art::book::{CoverBook, Strand, lanes_of};
use crate::art::paint::{Ctx, HF, Rand, Rgb, WF, css, css1, js_round, mix};

const DARK: Rgb = [30, 20, 10];
const WHITE: Rgb = [255, 255, 255];

#[allow(clippy::too_many_arguments)]
fn thread_cell(
    ctx: &mut Ctx,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    rgb: Rgb,
    vertical: bool,
    rand: &mut Rand,
) {
    ctx.set_fill_style(css1(rgb));
    let jx = (rand.next() - 0.5) * 0.5;
    let jy = (rand.next() - 0.5) * 0.5;
    ctx.fill_rect(x + 0.4 + jx, y + 0.35 + jy, w - 0.8, h - 0.7);
    ctx.set_fill_style(css(mix(rgb, DARK, 0.28), 0.5));
    if vertical {
        ctx.fill_rect(x + 0.4, y, 0.9, h);
        ctx.fill_rect(x + w - 1.3, y, 0.9, h);
        ctx.set_fill_style(css(mix(rgb, WHITE, 0.28), 0.6));
        ctx.fill_rect(x + w * 0.36, y + 0.6, w * 0.16, h - 1.2);
    } else {
        ctx.fill_rect(x, y + 0.35, w, 0.8);
        ctx.fill_rect(x, y + h - 1.15, w, 0.8);
        ctx.set_fill_style(css(mix(rgb, WHITE, 0.28), 0.55));
        ctx.fill_rect(x + 0.7, y + h * 0.36, w - 1.4, (h * 0.14).max(0.6));
    }
}

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    let s: Vec<&Strand> = book.strands.iter().filter(|s| !s.neutral).collect();
    let n = book.chapters;
    let linen: Rgb = [226, 216, 196];
    let weft = mix(linen, WHITE, 0.3);
    let heights: Vec<f32> = (0..n).map(|c| 0.45 + 0.55 * book.wn[c].min(2.0)).collect();
    let scale = (HF + 4.0) / heights.iter().sum::<f32>();
    let tw = 6.0 + rand.next() * 2.5;
    let t = (WF / tw).ceil() as usize + 1;
    let mut band: Vec<Option<usize>> = vec![None; t];
    let lanes = lanes_of(s.len().max(1));
    for (i, &lane) in lanes.iter().enumerate().take(s.len()) {
        let k = 3 + (rand.next() * 4.0).floor() as isize;
        let c0 = js_round(lane / tw - k as f32 / 2.0) as isize;
        for j in c0..c0 + k {
            if j >= 0 && (j as usize) < t {
                band[j as usize] = Some(i);
            }
        }
    }
    // A book without storylines: one dark band, weft-faced where chapters
    // run long.
    let plain = s.is_empty();
    ctx.set_fill_style(css1(mix(linen, [60, 50, 40], 0.35)));
    ctx.fill_rect(0.0, 0.0, WF, HF);
    let mut y = -2.0;
    let mut pick = 0usize;
    for (c, &height) in heights.iter().enumerate() {
        let h = height * scale;
        let picks = js_round(h / (6.0 + rand.next() * 3.0)).max(1.0);
        let wc = mix(weft, [205, 192, 168], rand.next() * 0.3);
        for _ in 0..picks as usize {
            let ph = h / picks;
            for (j, owner) in band.iter().enumerate() {
                let x = j as f32 * tw - 1.0;
                let (over, warp) = match *owner {
                    Some(i) => (s[i].on[c] != 0 || (j + pick).is_multiple_of(3), s[i].rgb),
                    None if plain && j as f32 > t as f32 * 0.3 && (j as f32) < t as f32 * 0.7 => (
                        if book.wn[c] > 1.0 {
                            (j + pick).is_multiple_of(4)
                        } else {
                            (j + pick).is_multiple_of(2)
                        },
                        [72, 70, 74],
                    ),
                    None => (
                        (j + pick).is_multiple_of(2),
                        mix(
                            linen,
                            [150, 135, 110],
                            0.12 + (0.12 * ((j * 7) % 3) as f32) / 2.0,
                        ),
                    ),
                };
                thread_cell(ctx, x, y, tw, ph, if over { warp } else { wc }, over, rand);
            }
            y += ph;
            pick += 1;
        }
    }
    false
}
