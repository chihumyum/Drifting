//! 字海 — a page of type, faint, through which each storyline runs as a
//! current of its colour, wider and bolder where the chapters are long. The
//! type follows the title: Latin letters for a Latin title, characters
//! otherwise.
//!
//! The 0.1 client set Songti for characters and a monospace for Latin; this
//! sets Drifting Serif (its bold for weight 600) and Sarasa Mono (one weight).
//! Without the fonts it draws the paper alone.

use crate::art::book::{CoverBook, lanes_of, row_at};
use crate::art::glyphs::faces;
use crate::art::paint::{Ctx, HF, PAPER, Rand, WF, css, ground, noise1d};

const LETTERS: &str = "abcdefghijklmnopqrstuvwxyz";
const CHARACTERS: &str = "的一是在不了有和人这中大为上个我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说种面而方后多定行学法所得经十三之进着等部度家力里如水化高自二理起小物现实加量都两体制机当使点从本去把性好应开它合还因由其些然前外天四日那事平形相全表间样与关各重新线内数正心反你明看原又么利比但气第向道命此变条只没结解问意建月无系很情者最立代想已通并提直题展五果料象位入常文总次品式活设管特件长求老头基资边流路少图山接知较将见计别她手角期根论运指几九区放决西被干做必先回则任取处雨雾海灯夜潮川风云";

pub fn draw(ctx: &mut Ctx, book: &CoverBook, rand: &mut Rand) -> bool {
    ctx.put_image_data(&ground(PAPER));
    let s = &book.strands;
    let pool: Vec<char> = if book.latin { LETTERS } else { CHARACTERS }
        .chars()
        .collect();
    let cw: f32 = if book.latin { 9.5 } else { 12.0 };
    let ch: f32 = if book.latin { 13.0 } else { 13.5 };
    let cols = ((WF - 6.0) / cw).floor() as usize;
    let rows = ((HF - 6.0) / ch).floor() as usize;
    let ox = (WF - cols as f32 * cw) / 2.0;
    let oy = (HF - rows as f32 * ch) / 2.0;
    let lanes = lanes_of(s.len());
    let meander: Vec<Vec<f32>> = s
        .iter()
        .map(|_| {
            let cell = 4.0 + rand.next() * 6.0;
            noise1d(rows + 1, cell, rand)
        })
        .collect();
    let faces = faces();
    let mut glyph = [0u8; 4];
    for r in 0..rows {
        let k = row_at(r as f32 / (rows - 1) as f32);
        let words = book.word_level[k];
        for c in 0..cols {
            let x = ox + (c as f32 + 0.5) * cw;
            let y = oy + (r as f32 + 0.5) * ch;
            let mut best = 0.0;
            let mut dom = None;
            for (i, (st, wander)) in s.iter().zip(&meander).enumerate() {
                let lx = lanes[i] + (wander[r] - 0.5) * 60.0;
                let sg = 8.0 + 12.0 * words.min(1.8);
                let v = st.level[k] * (-((x - lx).powi(2)) / (2.0 * sg * sg)).exp();
                if v > best {
                    best = v;
                    dom = Some(i);
                }
            }
            let g = pool[(rand.next() * pool.len() as f32).floor() as usize];
            let Some(faces) = faces else {
                continue;
            };
            let (face, size) = match dom.filter(|_| best > 0.12) {
                Some(dom) => {
                    let rgb = if s[dom].neutral {
                        [50, 48, 46]
                    } else {
                        s[dom].rgb
                    };
                    ctx.set_fill_style(css(rgb, 0.35 + 0.65 * best.min(1.0)));
                    let face = if book.latin {
                        &faces.mono
                    } else if best > 0.6 {
                        &faces.serif_bold
                    } else {
                        &faces.serif
                    };
                    let size = (if book.latin { 10.0 } else { 10.5 }) + 2.5 * best.min(1.0);
                    (face, size)
                }
                None => {
                    ctx.set_fill_style(css([60, 56, 50], 0.075));
                    let face = if book.latin {
                        &faces.mono
                    } else {
                        &faces.serif
                    };
                    (face, if book.latin { 9.5 } else { 10.0 })
                }
            };
            ctx.fill_text(g.encode_utf8(&mut glyph), x, y, face, size);
        }
    }
    false
}
