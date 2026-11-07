//! A shaped paragraph broken into visual rows and set on them.
//!
//! GPUI shapes the whole paragraph as one line (`layout_line`, cached across
//! frames by text, font size and runs); the editor breaks it into rows with
//! the shared Chinese rules in [`super::linebreak`] (a pure module the PDF
//! export can use too), lets a no-start mark hang past the right edge, and
//! sets each row ([`RowSetting`]):
//!
//! - **first-line indent** (the editor setting, body paragraphs): the first
//!   row starts that far in and is that much narrower;
//! - **punctuation squeezing** (标点挤压, `prose-linebreak`'s
//!   [`punctuation_squeeze`]): a full-width closing mark followed by another
//!   mark loses its blank right half, an opening mark after an opening mark
//!   its blank left half — before the rows are broken, so the narrower marks
//!   also fit more on a row;
//! - **alignment**: centred and right-aligned rows move right by their own
//!   room; justified rows (all but the last) spread their spare width over
//!   the gaps between characters (not inside Latin words), with a hanging
//!   mark staying outside the column.
//!
//! Every position this type answers — the caret, hit tests, selection and
//! decoration boxes, where a glyph is painted — is a *placed* x relative to
//! the text origin, with all of the above applied, so input, the candidate
//! window and painting agree. Painting is [`crate::render`]'s.

use std::{ops::Range, sync::Arc};

use gpui::{Bounds, LineLayout, Pixels, Point, TextRun, Window, point, px};

use super::linebreak::{NO_END, NO_START, Overflow, break_rows, punctuation_squeeze};

/// Which side of a soft-wrap boundary a cursor sits on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Affinity {
    /// At the end of the earlier visual row (after End / ⌘→).
    Upstream,
    /// At the start of the later visual row (the default).
    #[default]
    Downstream,
}

/// How a paragraph's rows sit in the column.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RowAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// How a paragraph is set on its rows, besides the column width.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RowSetting {
    /// How far the first row starts in (and how much narrower it is).
    pub first_indent: Pixels,
    pub align: RowAlign,
    /// Spread every row but the last to the full width (left-aligned rows
    /// only).
    pub justify: bool,
    /// Squeeze adjacent full-width punctuation.
    pub squeeze: bool,
}

/// One row's placement.
#[derive(Clone, Debug)]
struct RowPlace {
    /// Stop indices of the row's first character and of its end (the next
    /// row's first stop, or the text end).
    first: usize,
    end: usize,
    /// The adjusted x where the row starts (see [`ProseLayout::row_x`]).
    x0: f32,
    /// How far the row moves right (alignment).
    offset: f32,
    /// Spare width spread over the row's gaps (justification): extra x of
    /// each stop in `first..end`, and of the row end.
    extra: Vec<f32>,
    end_extra: f32,
}

/// A shaped paragraph broken into visual rows and set on them.
pub struct ProseLayout {
    pub line: Arc<LineLayout>,
    /// Byte range of each row in the paragraph text.
    pub rows: Vec<Range<usize>>,
    pub wrap_width: Pixels,
    setting: RowSetting,
    /// Every cluster start, and the text end: (byte, adjusted x). Adjusted x
    /// is the shaped x with squeezes taken off and the first-line indent
    /// added.
    stops: Vec<(usize, f32)>,
    /// The shaped x of each stop (to place a cluster's other glyphs).
    raw: Vec<f32>,
    /// Squeezed opening marks: drawn this far left of their stop (their ink
    /// sits in the right half of the em box).
    leads: Vec<(usize, f32)>,
    places: Vec<RowPlace>,
}

impl ProseLayout {
    /// Breaks `line` (shaped from `text`) into rows of at most `wrap_width`,
    /// left-aligned, without indent or squeezing.
    pub fn new(line: Arc<LineLayout>, text: &str, wrap_width: Pixels) -> ProseLayout {
        ProseLayout::set(line, text, wrap_width, RowSetting::default())
    }

    /// Breaks `line` (shaped from `text`) into rows of at most `wrap_width`
    /// and sets them as `setting` says.
    pub fn set(
        line: Arc<LineLayout>,
        text: &str,
        wrap_width: Pixels,
        setting: RowSetting,
    ) -> ProseLayout {
        let em = f32::from(line.font_size);
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
        let width = f32::from(line.width);
        let raw: Vec<f32> = glyphs
            .iter()
            .map(|(_, x)| *x)
            .chain(std::iter::once(width))
            .collect();

        // Squeezes, taken off every stop after the squeezed mark. Only marks
        // the font sets full-width (some fonts give “” a Latin width).
        let squeezes = if setting.squeeze {
            punctuation_squeeze(text, em)
        } else {
            Vec::new()
        };
        let indent = f32::from(setting.first_indent).max(0.);
        let mut stops = Vec::with_capacity(glyphs.len() + 1);
        let mut leads = Vec::new();
        let mut taken = 0.;
        let mut next_squeeze = squeezes.iter().peekable();
        for (ix, &(byte, x)) in glyphs.iter().enumerate() {
            stops.push((byte, x - taken + indent));
            while next_squeeze.next_if(|(b, _)| *b < byte).is_some() {}
            if let Some(&&(b, amount)) = next_squeeze.peek()
                && b == byte
            {
                next_squeeze.next();
                let advance = raw[ix + 1] - x;
                if advance >= em * 0.9 {
                    let c = text[byte..].chars().next().unwrap_or(' ');
                    if NO_END.contains(c) {
                        // An opening mark: its blank half is on the left.
                        leads.push((byte, amount));
                    }
                    taken += amount;
                }
            }
        }
        stops.push((text.len(), width - taken + indent));

        let breaks = break_rows(
            text,
            &stops[..stops.len() - 1],
            width - taken + indent,
            f32::from(wrap_width),
            em,
            Overflow::Hang,
        );
        let wrap = f32::from(wrap_width);
        let stop_of = |byte: usize| stops.partition_point(|(b, _)| *b < byte);
        let last_row = breaks.len() - 1;
        let places = breaks
            .iter()
            .enumerate()
            .map(|(row, r)| {
                let (first, end) = (stop_of(r.range.start), stop_of(r.range.end));
                let x0 = r.start_x;
                let row_width = stops[end].1 - x0;
                let room = (wrap - row_width).max(0.);
                let offset = match setting.align {
                    RowAlign::Left => 0.,
                    RowAlign::Center => (room / 2.).round(),
                    RowAlign::Right => room,
                };
                let (extra, end_extra) =
                    if setting.justify && setting.align == RowAlign::Left && row < last_row {
                        justify(text, &stops, first, end, x0, wrap, r.hang, em)
                    } else {
                        (vec![0.; end - first], 0.)
                    };
                RowPlace {
                    first,
                    end,
                    x0,
                    offset,
                    extra,
                    end_extra,
                }
            })
            .collect();
        ProseLayout {
            rows: breaks.into_iter().map(|row| row.range).collect(),
            line,
            wrap_width,
            setting,
            stops,
            raw,
            leads,
            places,
        }
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// How this layout was set.
    pub fn setting(&self) -> &RowSetting {
        &self.setting
    }

    /// The adjusted x where row `row` starts: the shaped x with squeezes
    /// taken off and the first-line indent added (0 for the first row).
    pub fn row_x(&self, row: usize) -> Pixels {
        px(self.places[row].x0)
    }

    /// How far row `row` moves right of the text origin for its alignment.
    pub fn row_offset(&self, row: usize) -> Pixels {
        px(self.places[row].offset)
    }

    /// The placed x of `byte` in row `row`, relative to the text origin (the
    /// x of the first character at or after it, as GPUI's `x_for_index`).
    pub fn x_at(&self, row: usize, byte: usize) -> Pixels {
        let place = &self.places[row];
        let k = self
            .stops
            .partition_point(|(b, _)| *b < byte)
            .clamp(place.first, place.end);
        px(self.placed(place, k))
    }

    fn placed(&self, place: &RowPlace, k: usize) -> f32 {
        let extra = if k >= place.end {
            place.end_extra
        } else {
            place.extra[k - place.first]
        };
        self.stops[k].1 - place.x0 + place.offset + extra
    }

    /// Where to paint a glyph of row `row` whose cluster starts at or before
    /// byte `index` and which GPUI shaped at `shaped_x`, relative to the text
    /// origin.
    pub fn glyph_x(&self, row: usize, index: usize, shaped_x: Pixels) -> Pixels {
        let place = &self.places[row];
        let k = self
            .stops
            .partition_point(|(b, _)| *b <= index)
            .saturating_sub(1)
            .clamp(place.first, place.end);
        let lead = self
            .leads
            .binary_search_by_key(&self.stops[k].0, |(b, _)| *b)
            .map_or(0., |ix| self.leads[ix].1);
        px(self.placed(place, k) + (f32::from(shaped_x) - self.raw[k]) - lead)
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
        point(self.x_at(row, byte), line_height * row as f32)
    }

    /// The byte in `row` closest to placed `x`, and its affinity.
    pub fn byte_in_row(&self, row: usize, x: Pixels) -> (usize, Affinity) {
        let place = &self.places[row];
        let x = f32::from(x);
        // Placed x grows along the row (squeezes and spreads keep order):
        // the first stop at or past x, then whichever neighbour is closer.
        let (mut lo, mut hi) = (place.first, place.end + 1);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.placed(place, mid) < x {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let k = lo;
        let k = if k > place.first
            && (k > place.end || x - self.placed(place, k - 1) <= self.placed(place, k) - x)
        {
            k - 1
        } else {
            k.min(place.end)
        };
        let range = self.rows[row].clone();
        let byte = self.stops[k].0.clamp(range.start, range.end);
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

    /// The placed x extent of `range` inside row `row`.
    pub fn x_range(&self, row: usize, range: Range<usize>) -> Option<(Pixels, Pixels)> {
        let bounds = &self.rows[row];
        let start = range.start.max(bounds.start);
        let end = range.end.min(bounds.end);
        (start < end).then(|| (self.x_at(row, start), self.x_at(row, end)))
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
            let x0 = self.x_at(ix, start);
            let row_end = self.x_at(ix, end);
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

    /// Each character's (cluster's) placed start in row `row`, with the
    /// row's end: what a screen reader's per-character positions come from.
    pub fn row_stops(&self, row: usize) -> Vec<(usize, Pixels)> {
        let place = &self.places[row];
        (place.first..=place.end)
            .map(|k| (self.stops[k].0, px(self.placed(place, k))))
            .collect()
    }
}

/// The spare width of a justified row, spread over its gaps: the extra x of
/// each stop in `first..end` and of the row end. Trailing spaces and a
/// hanging mark stay outside the column; gaps inside Latin words and before
/// a combining sequence are not widened; a row that would need more than an
/// em per gap (a long word pushed to the next row) is left as it is.
#[allow(clippy::too_many_arguments)]
fn justify(
    text: &str,
    stops: &[(usize, f32)],
    first: usize,
    end: usize,
    x0: f32,
    wrap: f32,
    hang: f32,
    em: f32,
) -> (Vec<f32>, f32) {
    let none = (vec![0.; end - first], 0.);
    let char_at = |k: usize| text[stops[k].0..].chars().next().unwrap_or(' ');
    // The row's content: without trailing spaces, and without a mark
    // hanging past the column.
    let mut content_end = end;
    while content_end > first && char_at(content_end - 1).is_whitespace() {
        content_end -= 1;
    }
    if hang > 0. && content_end > first + 1 && NO_START.contains(char_at(content_end - 1)) {
        content_end -= 1;
    }
    let spare = wrap - (stops[content_end].1 - x0);
    if spare <= 0.01 || content_end <= first + 1 {
        return none;
    }
    let latin = |c: char| c.is_alphanumeric() && c.is_ascii();
    let stretchable: Vec<bool> = (first..content_end - 1)
        .map(|k| !(latin(char_at(k)) && latin(char_at(k + 1))))
        .collect();
    let gaps = stretchable.iter().filter(|s| **s).count();
    if gaps == 0 || spare / gaps as f32 > em {
        return none;
    }
    let per_gap = spare / gaps as f32;
    let mut extra = Vec::with_capacity(end - first);
    let mut so_far = 0.;
    for k in first..end {
        if k > first && k < content_end && stretchable[k - first - 1] {
            so_far += per_gap;
        }
        extra.push(if k < content_end { so_far } else { spare });
    }
    (extra, spare)
}

/// Column geometry: wrap width and the text's left offset inside the item.
pub fn column(available: Pixels, max_width: Pixels, gutter: Pixels) -> (Pixels, Pixels) {
    let wrap = (available - gutter * 2.).min(max_width).max(px(80.));
    let left = ((available - wrap) / 2.).max(px(0.));
    (wrap, left)
}

/// Shapes and breaks a paragraph, left-aligned (GPUI caches the shaping
/// across frames).
pub fn shape(
    text: &str,
    font_size: Pixels,
    runs: &[TextRun],
    wrap_width: Pixels,
    window: &mut Window,
) -> ProseLayout {
    shape_set(
        text,
        font_size,
        runs,
        wrap_width,
        RowSetting::default(),
        window,
    )
}

/// Shapes, breaks and sets a paragraph.
pub fn shape_set(
    text: &str,
    font_size: Pixels,
    runs: &[TextRun],
    wrap_width: Pixels,
    setting: RowSetting,
    window: &mut Window,
) -> ProseLayout {
    let line = window
        .text_system()
        .layout_line(text, font_size, runs, None);
    ProseLayout::set(line, text, wrap_width, setting)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{FontId, GlyphId, ShapedGlyph, ShapedRun};

    /// A line shaped without a font: CJK, full-width marks and curly quotes
    /// one em (as a Chinese font sets them), other characters 0.6 em.
    fn line(text: &str, em: f32) -> Arc<LineLayout> {
        let mut x = 0.;
        let glyphs = text
            .char_indices()
            .map(|(index, c)| {
                let glyph = ShapedGlyph {
                    id: GlyphId(0),
                    position: point(px(x), px(0.)),
                    index,
                    is_emoji: false,
                };
                x += if super::super::linebreak::advance_em(c) >= 1. || "“”‘’".contains(c) {
                    em
                } else {
                    em * 0.6
                };
                glyph
            })
            .collect();
        Arc::new(LineLayout {
            font_size: px(em),
            width: px(x),
            ascent: px(em * 0.8),
            descent: px(em * 0.2),
            runs: vec![ShapedRun {
                font_id: FontId(0),
                glyphs,
            }],
            len: text.len(),
        })
    }

    fn set(text: &str, wrap: f32, setting: RowSetting) -> ProseLayout {
        ProseLayout::set(line(text, 10.), text, px(wrap), setting)
    }

    fn xs(layout: &ProseLayout, text: &str, row: usize) -> Vec<f32> {
        let bytes = layout.rows[row].clone();
        text[bytes.clone()]
            .char_indices()
            .map(|(b, _)| f32::from(layout.x_at(row, bytes.start + b)))
            .chain(std::iter::once(f32::from(layout.x_at(row, bytes.end))))
            .collect()
    }

    #[test]
    fn squeezing_takes_the_blank_halves_off() {
        let squeeze = RowSetting {
            squeeze: true,
            ..RowSetting::default()
        };
        // 他说：“好。” — the colon before an opening quote and the full stop
        // before a closing quote lose their right halves.
        let text = "他说：“好。”";
        let layout = set(text, 500., squeeze);
        assert_eq!(
            xs(&layout, text, 0),
            [0., 10., 20., 25., 35., 45., 50., 60.]
        );
        // Without squeezing: one em each.
        let plain = set(text, 500., RowSetting::default());
        assert_eq!(xs(&plain, text, 0), [0., 10., 20., 30., 40., 50., 60., 70.]);
        // An opening mark after an opening mark loses its left half: the
        // caret before 「 stays at its ink, the glyph is drawn half an em
        // left of it.
        let text = "（「注」）";
        let layout = set(text, 500., squeeze);
        assert_eq!(xs(&layout, text, 0), [0., 10., 15., 25., 30., 40.]);
        let open = "（".len();
        assert_eq!(layout.glyph_x(0, open, px(10.)), px(5.));
        // Squeezed marks leave room: one more character fits on the row.
        let text = "一二三四五六七八：“九”十";
        assert_eq!(set(text, 100., RowSetting::default()).row_count(), 2);
        assert_eq!(set(text, 110., squeeze).rows[0], 0..text.len() - "十".len());
    }

    #[test]
    fn the_first_row_is_indented_and_narrower() {
        let indent = RowSetting {
            first_indent: px(20.),
            ..RowSetting::default()
        };
        let text = "一二三四五六七八九十甲乙丙丁戊";
        let layout = set(text, 100., indent);
        assert_eq!(layout.rows[0], 0.."一二三四五六七八".len());
        assert_eq!(layout.x_at(0, 0), px(20.));
        assert_eq!(layout.x_at(1, layout.rows[1].start), px(0.));
        // An empty paragraph's caret sits at the indent.
        assert_eq!(set("", 100., indent).x_at(0, 0), px(20.));
        // Clicking left of the indent lands on the first character.
        assert_eq!(layout.byte_in_row(0, px(3.)).0, 0);
    }

    #[test]
    fn justified_rows_reach_the_column_edge() {
        let justify = RowSetting {
            justify: true,
            ..RowSetting::default()
        };
        // Nine ideographs (90 px) then a word that does not fit: row one
        // spreads its 10 spare px over its 8 gaps; the last row is left as is.
        let text = "一二三四五六七八九word";
        let layout = set(text, 100., justify);
        assert_eq!(layout.row_count(), 2);
        let row = xs(&layout, text, 0);
        assert_eq!(row.first(), Some(&0.));
        assert!((row.last().unwrap() - 100.).abs() < 0.01, "{row:?}");
        assert!((row[1] - 11.25).abs() < 0.01, "{row:?}");
        assert_eq!(xs(&layout, text, 1), [0., 6., 12., 18., 24.]);
        // Clicks find the spread characters.
        for (ix, (b, _)) in text[layout.rows[0].clone()].char_indices().enumerate() {
            assert_eq!(layout.byte_in_row(0, px(row[ix] + 1.)).0, b);
        }
        // A hanging comma stays outside; the row before it already fills
        // the column, so nothing spreads.
        let text = "一二三四五六七八九十，下一行";
        let layout = set(text, 100., justify);
        assert_eq!(layout.x_at(0, "一二三四五六七八九十".len()), px(100.));
        // Latin words are not spread inside: only the space grows.
        let text = "ab cd 一二三四五六七八九十";
        let layout = set(text, 100., justify);
        let row = xs(&layout, text, 0);
        assert!((row[1] - row[0] - 6.).abs() < 0.01, "{row:?}");
    }

    #[test]
    fn centred_and_right_rows_move_with_their_room() {
        let center = RowSetting {
            align: RowAlign::Center,
            ..RowSetting::default()
        };
        let layout = set("一二三四五", 100., center);
        assert_eq!(layout.x_at(0, 0), px(25.));
        assert_eq!(layout.byte_in_row(0, px(26.)).0, 0);
        let right = RowSetting {
            align: RowAlign::Right,
            ..RowSetting::default()
        };
        // Rows of a long right-aligned paragraph move by their own room.
        let text = "一二三四五六七八九十甲乙丙";
        let layout = set(text, 100., right);
        assert_eq!(layout.x_at(0, 0), px(0.));
        assert_eq!(layout.x_at(1, layout.rows[1].start), px(70.));
        let caret = layout.point_for_byte(layout.rows[1].start, Affinity::Downstream, px(20.));
        assert_eq!(caret, point(px(70.), px(20.)));
    }
}
