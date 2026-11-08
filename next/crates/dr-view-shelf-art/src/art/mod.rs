//! The covers themselves, as pixels (the 0.1 client's `lib/shelf-cover/*`
//! and `lib/sand-cover.ts`, Canvas 2D there, tiny-skia here): no GPUI, so a
//! cover is drawn on any thread.

pub mod book;
pub mod glyphs;
pub mod paint;
pub mod sand;
pub mod styles;

pub use book::{CoverRequest, StorylineCover, cover_seed, is_latin};
pub use styles::CoverStyle;

use paint::{Ctx, H, Rand, W};

/// A cover drawn.
#[derive(Clone)]
pub enum Drawn {
    /// A style that paints the whole cover: straight RGBA, `W × H`, and
    /// whether its ground is dark under the title.
    Art { rgba: Vec<u8>, dark: bool },
    /// Sand: one alpha mask per stroke (coloured when shown, so a theme
    /// change needs no redraw) and the colour of each (`None`: the
    /// neutral ink of a book whose storylines carry no chapter).
    Sand {
        masks: Vec<Vec<f32>>,
        colors: Vec<Option<paint::Rgb>>,
    },
}

/// The cover's size in pixels (twice the 126 × 226 it is shown at).
pub const SIZE: (usize, usize) = (W, H);

/// Draws `request`'s cover in `style`.
pub fn draw(style: CoverStyle, request: &CoverRequest) -> Drawn {
    match style.art() {
        Some(art) => {
            let mut ctx = Ctx::new();
            let book = book::read_cover_book(request);
            let mut rand = Rand::new(request.seed);
            let dark = art(&mut ctx, &book, &mut rand);
            Drawn::Art {
                rgba: paint::to_rgba(&ctx.pixmap),
                dark,
            }
        }
        None => {
            let masks = sand::draw_sand_cover(request);
            let carried = request.storylines.iter().any(|l| !l.chapters.is_empty());
            let colors = (0..masks.len())
                .map(|k| {
                    carried
                        .then(|| {
                            request
                                .storylines
                                .get(k)
                                .map(|l| paint::hex_color(&l.color))
                        })
                        .flatten()
                })
                .collect();
            Drawn::Sand { masks, colors }
        }
    }
}

/// `drawn` on a ground of `paper`, sand in its colours (or `neutral`):
/// straight RGBA, for screenshots and comparisons.
pub fn flatten(drawn: &Drawn, paper: paint::Rgb, neutral: paint::Rgb) -> Vec<u8> {
    match drawn {
        Drawn::Art { rgba, .. } => rgba.clone(),
        Drawn::Sand { masks, colors } => {
            let mut out = Vec::with_capacity(W * H * 4);
            for _ in 0..W * H {
                out.extend_from_slice(&[paper[0], paper[1], paper[2], 255]);
            }
            for (mask, color) in masks.iter().zip(colors) {
                let c = color.unwrap_or(neutral);
                for (i, &a) in mask.iter().enumerate() {
                    for k in 0..3 {
                        let v = f32::from(out[i * 4 + k]) * (1.0 - a) + f32::from(c[k]) * a;
                        out[i * 4 + k] = paint::clamped(v);
                    }
                }
            }
            out
        }
    }
}
