//! Painting a broken paragraph row by row: background highlights, glyphs in
//! their run colours, underlines and strikethroughs. Rows outside the content
//! mask are skipped, so a 5000-character paragraph scrolled mostly out of view
//! paints only its visible rows.
//!
//! On top of the runs: each row may be moved right (alignment), byte ranges
//! may take another ink (an Agent change easing back to the text colour, a
//! TODO keyword), the plain text colour may be swapped (a quote's softer
//! ink), and the whole paragraph may fade (immersive writing).

use std::ops::Range;

use gpui::{Hsla, Pixels, Point, StrikethroughStyle, TextRun, UnderlineStyle, Window, fill, point};

use crate::layout::ProseLayout;

/// Per-byte-range decorations taken from the runs.
struct Decorations {
    colors: Vec<(usize, Hsla)>,
    backgrounds: Vec<(Range<usize>, Hsla)>,
    underlines: Vec<(Range<usize>, UnderlineStyle)>,
    strikes: Vec<(Range<usize>, StrikethroughStyle)>,
}

impl Decorations {
    fn from_runs(runs: &[TextRun]) -> Decorations {
        let mut d = Decorations {
            colors: Vec::with_capacity(runs.len()),
            backgrounds: Vec::new(),
            underlines: Vec::new(),
            strikes: Vec::new(),
        };
        let mut at = 0;
        for run in runs {
            let range = at..at + run.len;
            at += run.len;
            d.colors.push((at, run.color));
            if let Some(bg) = run.background_color {
                d.backgrounds.push((range.clone(), bg));
            }
            if let Some(underline) = run.underline {
                d.underlines.push((range.clone(), underline));
            }
            if let Some(strike) = run.strikethrough {
                d.strikes.push((range, strike));
            }
        }
        d
    }
}

/// How a paragraph's text is painted, beyond its runs.
#[derive(Clone, Copy, Debug)]
pub struct TextPaint<'a> {
    pub runs: &'a [TextRun],
    /// The colour of bytes no run covers.
    pub fallback: Hsla,
    /// Byte ranges in another ink, and how much of it (0–1) they take.
    pub inks: &'a [(Range<usize>, Hsla, f32)],
    /// The plain text colour and what to paint it as (a quote's ink).
    pub plain: Option<(Hsla, Hsla)>,
    /// The share of their alpha the glyphs keep (immersive writing).
    pub alpha: f32,
}

impl<'a> TextPaint<'a> {
    pub fn new(runs: &'a [TextRun], fallback: Hsla) -> TextPaint<'a> {
        TextPaint {
            runs,
            fallback,
            inks: &[],
            plain: None,
            alpha: 1.,
        }
    }

    fn ink(&self, byte: usize, color: Hsla) -> Hsla {
        let mut color = match self.plain {
            Some((from, to)) if from == color => to,
            _ => color,
        };
        for (range, ink, level) in self.inks {
            if range.contains(&byte) {
                color = color.blend(ink.alpha(*level));
            }
        }
        if self.alpha < 1. {
            color.a *= self.alpha;
        }
        color
    }
}

/// Paints `layout` at `origin` (the text origin of its first row).
pub fn paint_layout(
    layout: &ProseLayout,
    origin: Point<Pixels>,
    line_height: Pixels,
    runs: &[TextRun],
    fallback_color: Hsla,
    window: &mut Window,
) {
    paint_text(
        layout,
        origin,
        line_height,
        &TextPaint::new(runs, fallback_color),
        window,
    );
}

/// Paints `layout` at `origin` with alignment, inks and fading.
pub fn paint_text(
    layout: &ProseLayout,
    origin: Point<Pixels>,
    line_height: Pixels,
    paint: &TextPaint<'_>,
    window: &mut Window,
) {
    let line = &layout.line;
    let deco = Decorations::from_runs(paint.runs);
    let padding_top = (line_height - line.ascent - line.descent) / 2.;
    let baseline = padding_top + line.ascent;
    let mask = window.content_mask().bounds;
    let rows = &layout.rows;
    let visible = |row: usize| {
        let top = origin.y + line_height * row as f32;
        top + line_height >= mask.top() && top <= mask.bottom()
    };
    let faded = |color: Hsla| {
        let mut color = color;
        color.a *= paint.alpha;
        color
    };

    for (range, color) in &deco.backgrounds {
        for row in 0..rows.len() {
            if let (true, Some((x0, x1))) = (visible(row), layout.x_range(row, range.clone())) {
                let top = origin + point(x0, line_height * row as f32);
                window.paint_quad(fill(
                    gpui::Bounds::from_corners(top, top + point(x1 - x0, line_height)),
                    *color,
                ));
            }
        }
    }

    let mut color_ix = 0;
    let mut row = 0;
    for run in &line.runs {
        for glyph in &run.glyphs {
            while row + 1 < rows.len() && glyph.index >= rows[row].end {
                row += 1;
            }
            if !visible(row) {
                continue;
            }
            while color_ix + 1 < deco.colors.len() && glyph.index >= deco.colors[color_ix].0 {
                color_ix += 1;
            }
            let color = deco.colors.get(color_ix).map_or(paint.fallback, |c| c.1);
            let color = paint.ink(glyph.index, color);
            let at = origin
                + point(
                    layout.glyph_x(row, glyph.index, glyph.position.x),
                    line_height * row as f32 + baseline,
                );
            let _ = if glyph.is_emoji {
                window.paint_emoji(at, run.font_id, glyph.id, line.font_size)
            } else {
                window.paint_glyph(at, run.font_id, glyph.id, line.font_size, color)
            };
        }
    }

    for (range, style) in &deco.underlines {
        let style = UnderlineStyle {
            color: style.color.map(faded),
            ..*style
        };
        for row in 0..rows.len() {
            if let (true, Some((x0, x1))) = (visible(row), layout.x_range(row, range.clone())) {
                let y = line_height * row as f32 + baseline + line.descent * 0.5;
                window.paint_underline(origin + point(x0, y), x1 - x0, &style);
            }
        }
    }
    for (range, style) in &deco.strikes {
        let style = StrikethroughStyle {
            color: style.color.map(faded),
            ..*style
        };
        for row in 0..rows.len() {
            if let (true, Some((x0, x1))) = (visible(row), layout.x_range(row, range.clone())) {
                let y = line_height * row as f32 + baseline - line.ascent * 0.32;
                window.paint_strikethrough(origin + point(x0, y), x1 - x0, &style);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::hsla;

    #[test]
    fn inks_quote_colour_and_fading_combine() {
        let text = hsla(0., 0., 0.1, 1.);
        let quote = hsla(0., 0., 0.3, 1.);
        let green = hsla(0.4, 0.4, 0.34, 1.);
        let link = hsla(0.6, 0.7, 0.42, 1.);
        let inks = [(3..6, green, 1.)];
        let paint = TextPaint {
            runs: &[],
            fallback: text,
            inks: &inks,
            plain: Some((text, quote)),
            alpha: 0.5,
        };
        // The plain colour becomes the quote's; a link keeps its own.
        assert_eq!(paint.ink(0, text), quote.alpha(0.5));
        assert_eq!(paint.ink(0, link), link.alpha(0.5));
        // Inside an ink range the ink takes over.
        let inked = paint.ink(4, text);
        assert!((inked.h - green.h).abs() < 0.01, "{inked:?}");
        assert!((inked.a - 0.5).abs() < 1e-6);
    }
}
