//! A shaped paragraph broken into visual rows.
//!
//! GPUI shapes the whole paragraph as one line (`layout_line`, cached across
//! frames by text, font size and runs); the editor breaks it into rows with
//! the shared Chinese rules in [`super::linebreak`] (a pure module the PDF
//! export can use too), lets a no-start mark hang past the right edge, and answers geometry questions (where is byte n, which
//! byte is at x, selection rectangles). Painting is [`crate::render`]'s.

use std::{ops::Range, sync::Arc};

use gpui::{Bounds, LineLayout, Pixels, Point, TextRun, Window, point, px};

use super::linebreak::{Overflow, break_rows};

/// Which side of a soft-wrap boundary a cursor sits on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Affinity {
    /// At the end of the earlier visual row (after End / ⌘→).
    Upstream,
    /// At the start of the later visual row (the default).
    #[default]
    Downstream,
}

/// A shaped paragraph broken into visual rows.
pub struct ProseLayout {
    pub line: Arc<LineLayout>,
    /// Byte range of each row in the paragraph text.
    pub rows: Vec<Range<usize>>,
    /// The unwrapped x where each row starts.
    row_x: Vec<Pixels>,
    pub wrap_width: Pixels,
}

impl ProseLayout {
    /// Breaks `line` (shaped from `text`) into rows of at most `wrap_width`
    /// with the shared rules in [`super::linebreak`], letting a no-start mark
    /// hang past the edge instead of opening a row.
    pub fn new(line: Arc<LineLayout>, text: &str, wrap_width: Pixels) -> ProseLayout {
        let mut glyphs: Vec<(usize, f32)> = line
            .runs
            .iter()
            .flat_map(|run| {
                run.glyphs
                    .iter()
                    .map(|g| (g.index, f32::from(g.position.x)))
            })
            .collect();
        glyphs.sort_by_key(|(index, _)| *index);
        glyphs.dedup_by_key(|(index, _)| *index);
        let rows = break_rows(
            text,
            &glyphs,
            f32::from(line.width),
            f32::from(wrap_width),
            f32::from(line.font_size),
            Overflow::Hang,
        );
        ProseLayout {
            row_x: rows.iter().map(|row| px(row.start_x)).collect(),
            rows: rows.into_iter().map(|row| row.range).collect(),
            line,
            wrap_width,
        }
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// The unwrapped x where row `row` starts.
    pub fn row_x(&self, row: usize) -> Pixels {
        self.row_x[row]
    }

    /// The visual row holding `byte`.
    pub fn row_of(&self, byte: usize, affinity: Affinity) -> usize {
        let last = self.rows.len() - 1;
        for (ix, row) in self.rows.iter().enumerate() {
            if byte < row.end || ix == last || (byte == row.end && affinity == Affinity::Upstream) {
                return ix;
            }
        }
        last
    }

    /// Position of `byte` relative to the text origin (top of its row).
    pub fn point_for_byte(
        &self,
        byte: usize,
        affinity: Affinity,
        line_height: Pixels,
    ) -> Point<Pixels> {
        let row = self.row_of(byte, affinity);
        point(
            self.line.x_for_index(byte) - self.row_x[row],
            line_height * row as f32,
        )
    }

    /// The byte in `row` closest to `x`, and its affinity.
    pub fn byte_in_row(&self, row: usize, x: Pixels) -> (usize, Affinity) {
        let range = self.rows[row].clone();
        let byte = self
            .line
            .closest_index_for_x(self.row_x[row] + x.max(px(0.)))
            .clamp(range.start, range.end);
        let affinity = if byte == range.end && row + 1 < self.rows.len() {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        (byte, affinity)
    }

    /// The byte closest to a point relative to the text origin.
    pub fn byte_for_point(&self, at: Point<Pixels>, line_height: Pixels) -> (usize, Affinity) {
        let row = if at.y < px(0.) {
            0
        } else {
            ((at.y / line_height) as usize).min(self.rows.len() - 1)
        };
        self.byte_in_row(row, at.x)
    }

    /// The x extent of `range` inside row `row`, relative to the row start.
    pub fn x_range(&self, row: usize, range: Range<usize>) -> Option<(Pixels, Pixels)> {
        let bounds = &self.rows[row];
        let start = range.start.max(bounds.start);
        let end = range.end.min(bounds.end);
        (start < end).then(|| {
            (
                self.line.x_for_index(start) - self.row_x[row],
                self.line.x_for_index(end) - self.row_x[row],
            )
        })
    }

    /// Selection rectangles relative to the text origin. `past_end` extends the
    /// last row a little to show that the newline is selected too.
    pub fn selection_rects(
        &self,
        range: Range<usize>,
        past_end: bool,
        line_height: Pixels,
    ) -> Vec<Bounds<Pixels>> {
        let mut rects = Vec::new();
        for (ix, row) in self.rows.iter().enumerate() {
            let last = ix + 1 == self.rows.len();
            let start = range.start.max(row.start);
            let end = range.end.min(row.end);
            let continues = range.end > row.end || (last && past_end);
            if start > end || (start == end && !continues) {
                continue;
            }
            let x0 = self.line.x_for_index(start) - self.row_x[ix];
            let row_end = self.line.x_for_index(end) - self.row_x[ix];
            let x1 = if continues && !last {
                row_end.max(self.wrap_width)
            } else if continues {
                row_end + px(6.)
            } else {
                row_end
            };
            rects.push(Bounds::from_corners(
                point(x0, line_height * ix as f32),
                point(x1.max(x0 + px(1.)), line_height * (ix + 1) as f32),
            ));
        }
        rects
    }
}

/// Column geometry: wrap width and the text's left offset inside the item.
pub fn column(available: Pixels, max_width: Pixels, gutter: Pixels) -> (Pixels, Pixels) {
    let wrap = (available - gutter * 2.).min(max_width).max(px(80.));
    let left = ((available - wrap) / 2.).max(px(0.));
    (wrap, left)
}

/// Shapes and breaks a paragraph (GPUI caches the shaping across frames).
pub fn shape(
    text: &str,
    font_size: Pixels,
    runs: &[TextRun],
    wrap_width: Pixels,
    window: &mut Window,
) -> ProseLayout {
    let line = window
        .text_system()
        .layout_line(text, font_size, runs, None);
    ProseLayout::new(line, text, wrap_width)
}
