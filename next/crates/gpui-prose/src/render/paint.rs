//! Painting a broken paragraph row by row: background highlights, glyphs in
//! their run colours, underlines and strikethroughs. Rows outside the content
//! mask are skipped, so a 5000-character paragraph scrolled mostly out of view
//! paints only its visible rows.

use gpui::{Hsla, Pixels, Point, StrikethroughStyle, TextRun, UnderlineStyle, Window, fill, point};

use crate::layout::ProseLayout;

/// Per-byte-range decorations taken from the runs.
struct Decorations {
    colors: Vec<(usize, Hsla)>,
    backgrounds: Vec<(std::ops::Range<usize>, Hsla)>,
    underlines: Vec<(std::ops::Range<usize>, UnderlineStyle)>,
    strikes: Vec<(std::ops::Range<usize>, StrikethroughStyle)>,
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

/// Paints `layout` at `origin` (the text origin of its first row).
pub fn paint_layout(
    layout: &ProseLayout,
    origin: Point<Pixels>,
    line_height: Pixels,
    runs: &[TextRun],
    fallback_color: Hsla,
    window: &mut Window,
) {
    let line = &layout.line;
    let deco = Decorations::from_runs(runs);
    let padding_top = (line_height - line.ascent - line.descent) / 2.;
    let baseline = padding_top + line.ascent;
    let mask = window.content_mask().bounds;
    let rows = &layout.rows;
    let visible = |row: usize| {
        let top = origin.y + line_height * row as f32;
        top + line_height >= mask.top() && top <= mask.bottom()
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
            let color = deco.colors.get(color_ix).map_or(fallback_color, |c| c.1);
            let at = origin
                + point(
                    glyph.position.x - layout.row_x(row),
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
        for row in 0..rows.len() {
            if let (true, Some((x0, x1))) = (visible(row), layout.x_range(row, range.clone())) {
                let y = line_height * row as f32 + baseline + line.descent * 0.5;
                window.paint_underline(origin + point(x0, y), x1 - x0, style);
            }
        }
    }
    for (range, style) in &deco.strikes {
        for row in 0..rows.len() {
            if let (true, Some((x0, x1))) = (visible(row), layout.x_range(row, range.clone())) {
                let y = line_height * row as f32 + baseline - line.ascent * 0.32;
                window.paint_strikethrough(origin + point(x0, y), x1 - x0, style);
            }
        }
    }
}
