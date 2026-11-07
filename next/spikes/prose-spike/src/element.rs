//! The paragraph element: shapes one paragraph with GPUI's text system, breaks
//! it into rows with Chinese line-breaking rules, and paints selection, glyphs,
//! the composition underline and the cursor.
//!
//! Why the editor breaks lines itself: GPUI v1.27's wrapper treats the space
//! before every CJK character and full-width punctuation mark as a break, so
//! "，" or "。" can start a row. Here GPUI shapes the whole paragraph as one
//! line (`layout_line`, cached across frames) and paints single glyphs
//! (`paint_glyph`); rows, hanging punctuation and hit testing are ours.
//!
//! One element per visible paragraph, created by the editor's `list()` item
//! callback each frame.

use std::{cell::RefCell, ops::Range, rc::Rc, sync::Arc};

use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, LineLayout, Pixels, Point, SharedString, Size, Style, TextRun,
    UnderlineStyle, Window, fill, point, px, relative, size,
};

use crate::heights::HeightIndex;

/// Which side of a soft-wrap boundary a cursor sits on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Affinity {
    /// At the end of the earlier visual row (after End / ⌘→).
    Upstream,
    /// At the start of the later visual row (the default).
    #[default]
    Downstream,
}

// ----- Chinese line breaking -------------------------------------------------

/// Marks that never start a row (GB/T 15834: 点号 and closing brackets and
/// quotes; plus their ASCII and Japanese counterparts).
const NO_START: &str = "，。、；：？！）］｝〕〉》」』】〙〗〟’”｠»‥・ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ,.;:?!)]}%";
/// Marks that never end a row (opening brackets and quotes).
const NO_END: &str = "（［｛〔〈《「『【〘〖〝‘“｟«([{";

fn wide(c: char) -> bool {
    crate::heights::advance_em(c) >= 1.0
}

fn word(c: char) -> bool {
    c.is_alphanumeric() && !wide(c) || matches!(c, '_' | '\'' | '’' | '-' | '.' | '@' | '#')
}

/// Whether a row may start at `c`, right after `prev`.
pub fn can_break_between(prev: char, c: char) -> bool {
    if NO_START.contains(c) || NO_END.contains(prev) {
        return false;
    }
    // ——, …… and ⋯⋯ stay together.
    if prev == c && matches!(c, '—' | '…' | '⋯') {
        return false;
    }
    if prev == ' ' || prev == '\t' {
        return c != ' ';
    }
    if c == ' ' {
        return false;
    }
    if word(prev) && word(c) {
        return false;
    }
    wide(prev) || wide(c) || matches!(prev, '-' | '/' | '—')
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
    /// Breaks `line` (shaped from `text`) into rows of at most `wrap_width`,
    /// letting a no-start mark hang past the edge instead of opening a row.
    pub fn new(line: Arc<LineLayout>, text: &str, wrap_width: Pixels) -> ProseLayout {
        let mut glyphs: Vec<(usize, Pixels)> = line
            .runs
            .iter()
            .flat_map(|run| run.glyphs.iter().map(|g| (g.index, g.position.x)))
            .collect();
        glyphs.sort_by_key(|(index, _)| *index);
        glyphs.dedup_by_key(|(index, _)| *index);
        let mut rows = Vec::new();
        let mut row_x = Vec::new();
        let (mut start, mut start_x) = (0usize, px(0.));
        let mut candidate: Option<(usize, Pixels)> = None;
        let mut prev = '\0';
        for (ix, &(byte, x)) in glyphs.iter().enumerate() {
            let c = text[byte..].chars().next().unwrap_or(' ');
            if byte > start && can_break_between(prev, c) {
                candidate = Some((byte, x));
            }
            let next_x = glyphs.get(ix + 1).map_or(line.width, |(_, x)| *x);
            let overflows = next_x - start_x > wrap_width && byte > start;
            let hangs = NO_START.contains(c) || c == ' ';
            if overflows && !hangs {
                let (at, at_x) = candidate.filter(|(at, _)| *at > start).unwrap_or((byte, x));
                rows.push(start..at);
                row_x.push(start_x);
                start = at;
                start_x = at_x;
                candidate = None;
            }
            prev = c;
        }
        rows.push(start..line.len);
        row_x.push(start_x);
        ProseLayout {
            line,
            rows,
            row_x,
            wrap_width,
        }
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
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

    /// Paints the glyphs row by row, skipping rows outside the content mask.
    pub fn paint(
        &self,
        origin: Point<Pixels>,
        line_height: Pixels,
        colors: &[(usize, Hsla)],
        underline: Option<(Range<usize>, UnderlineStyle)>,
        window: &mut Window,
    ) {
        let layout = &self.line;
        let padding_top = (line_height - layout.ascent - layout.descent) / 2.;
        let baseline = padding_top + layout.ascent;
        let mask = window.content_mask().bounds;
        let visible = |row: usize| {
            let top = origin.y + line_height * row as f32;
            top + line_height >= mask.top() && top <= mask.bottom()
        };
        let mut color_ix = 0;
        let mut row = 0;
        for run in &layout.runs {
            for glyph in &run.glyphs {
                while row + 1 < self.rows.len() && glyph.index >= self.rows[row].end {
                    row += 1;
                }
                if !visible(row) {
                    continue;
                }
                while color_ix + 1 < colors.len() && glyph.index >= colors[color_ix].0 {
                    color_ix += 1;
                }
                let color = colors.get(color_ix).map_or(gpui::black(), |c| c.1);
                let at = origin
                    + point(
                        glyph.position.x - self.row_x[row],
                        line_height * row as f32 + baseline,
                    );
                let _ = if glyph.is_emoji {
                    window.paint_emoji(at, run.font_id, glyph.id, layout.font_size)
                } else {
                    window.paint_glyph(at, run.font_id, glyph.id, layout.font_size, color)
                };
            }
        }
        if let Some((range, style)) = underline {
            for (ix, row) in self.rows.iter().enumerate() {
                let start = range.start.max(row.start);
                let end = range.end.min(row.end);
                if start >= end {
                    continue;
                }
                let x0 = layout.x_for_index(start) - self.row_x[ix];
                let x1 = layout.x_for_index(end) - self.row_x[ix];
                let y = line_height * ix as f32 + baseline + layout.descent * 0.5;
                window.paint_underline(origin + point(x0, y), x1 - x0, &style);
            }
        }
    }
}

// ----- painted-frame bookkeeping ---------------------------------------------

/// The composition shown inside a paragraph, in display-text bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompSpan {
    /// Where the marked text starts.
    pub at: usize,
    /// Length of the marked text.
    pub len: usize,
    /// Length of committed text hidden behind it (a replaced selection).
    pub replaced: usize,
}

impl CompSpan {
    /// Display byte → byte in the committed line text.
    pub fn to_line_byte(&self, display: usize) -> usize {
        if display <= self.at {
            display
        } else if display < self.at + self.len {
            self.at
        } else {
            display - self.len + self.replaced
        }
    }
}

/// A paragraph as it was painted this frame, for hit testing, vertical
/// movement and the IME's candidate window.
#[derive(Clone)]
pub struct PaintedLine {
    pub chapter: usize,
    pub line: usize,
    pub rev: u64,
    pub text: SharedString,
    pub bounds: Bounds<Pixels>,
    pub origin: Point<Pixels>,
    pub layout: Rc<ProseLayout>,
    pub line_height: Pixels,
    pub comp: Option<CompSpan>,
}

#[derive(Default)]
pub struct FrameCache {
    pub lines: Vec<PaintedLine>,
}

impl FrameCache {
    pub fn get(&self, chapter: usize, line: usize) -> Option<&PaintedLine> {
        self.lines
            .iter()
            .find(|painted| painted.chapter == chapter && painted.line == line)
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

// ----- the element ------------------------------------------------------------

pub struct ParagraphElement {
    pub item_ix: usize,
    pub chapter: usize,
    pub line: usize,
    pub rev: u64,
    pub text: SharedString,
    pub runs: Vec<TextRun>,
    pub font_size: Pixels,
    pub line_height: Pixels,
    pub pad_top: Pixels,
    pub pad_bottom: Pixels,
    pub max_width: Pixels,
    pub gutter: Pixels,
    /// Selected display bytes, and whether the newline is selected too.
    pub selection: Option<(Range<usize>, bool)>,
    pub cursor: Option<(usize, Affinity)>,
    /// Receives the caret's bounds; the caret layer paints it.
    pub cursor_out: Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    pub autoscroll: bool,
    pub comp: Option<CompSpan>,
    pub selection_color: Hsla,
    pub frame: Rc<RefCell<FrameCache>>,
    pub heights: Rc<RefCell<HeightIndex>>,
}

struct Shaped {
    layout: Rc<ProseLayout>,
    left: Pixels,
}

pub struct ParagraphLayout(Rc<RefCell<Option<Shaped>>>);

pub struct ParagraphPrepaint {
    cursor: Option<Bounds<Pixels>>,
}

impl IntoElement for ParagraphElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for ParagraphElement {
    type RequestLayoutState = ParagraphLayout;
    type PrepaintState = ParagraphPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        _cx: &mut App,
    ) -> (LayoutId, ParagraphLayout) {
        let shared: Rc<RefCell<Option<Shaped>>> = Rc::default();
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let (text, runs) = (self.text.clone(), self.runs.clone());
        let (font_size, line_height) = (self.font_size, self.line_height);
        let (pad_top, pad_bottom) = (self.pad_top, self.pad_bottom);
        let (max_width, gutter) = (self.max_width, self.gutter);
        let (item_ix, heights) = (self.item_ix, self.heights.clone());
        let layout_id = window.request_measured_layout(style, {
            let shared = shared.clone();
            move |known: Size<Option<Pixels>>, available: Size<AvailableSpace>, window, _cx| {
                let width = known.width.unwrap_or(match available.width {
                    AvailableSpace::Definite(width) => width,
                    _ => max_width + gutter * 2.,
                });
                let (wrap_width, left) = column(width, max_width, gutter);
                let layout = shape(&text, font_size, &runs, wrap_width, window);
                let height = pad_top + line_height * layout.row_count() as f32 + pad_bottom;
                heights
                    .borrow_mut()
                    .set_measured(item_ix, f32::from(height));
                *shared.borrow_mut() = Some(Shaped {
                    layout: Rc::new(layout),
                    left,
                });
                size(width, height)
            }
        });
        (layout_id, ParagraphLayout(shared))
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout: &mut ParagraphLayout,
        window: &mut Window,
        _cx: &mut App,
    ) -> ParagraphPrepaint {
        let shared = layout.0.borrow();
        let Some(shaped) = shared.as_ref() else {
            return ParagraphPrepaint { cursor: None };
        };
        let origin = bounds.origin + point(shaped.left, self.pad_top);
        let cursor = self.cursor.map(|(byte, affinity)| {
            let at = shaped
                .layout
                .point_for_byte(byte, affinity, self.line_height);
            Bounds::new(origin + at, size(px(2.), self.line_height))
        });
        if self.autoscroll
            && let Some(cursor) = cursor
        {
            // Keep a row of context above and below the cursor.
            let margin = self.line_height;
            window.request_autoscroll(Bounds::from_corners(
                point(cursor.left(), cursor.top() - margin),
                point(cursor.right(), cursor.bottom() + margin),
            ));
        }
        ParagraphPrepaint { cursor }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout: &mut ParagraphLayout,
        prepaint: &mut ParagraphPrepaint,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let shared = layout.0.borrow();
        let Some(shaped) = shared.as_ref() else {
            return;
        };
        let origin = bounds.origin + point(shaped.left, self.pad_top);
        if let Some((range, past_end)) = self.selection.clone() {
            for rect in shaped
                .layout
                .selection_rects(range, past_end, self.line_height)
            {
                window.paint_quad(fill(
                    Bounds::new(origin + rect.origin, rect.size),
                    self.selection_color,
                ));
            }
        }
        let mut colors = Vec::with_capacity(self.runs.len());
        let mut at = 0;
        for run in &self.runs {
            at += run.len;
            colors.push((at, run.color));
        }
        let underline = self.comp.and_then(|comp| {
            let style = self.runs.iter().find_map(|run| run.underline)?;
            Some((comp.at..comp.at + comp.len, style))
        });
        shaped
            .layout
            .paint(origin, self.line_height, &colors, underline, window);
        if let Some(cursor) = prepaint.cursor {
            self.cursor_out.set(Some(cursor));
        }
        self.frame.borrow_mut().lines.push(PaintedLine {
            chapter: self.chapter,
            line: self.line,
            rev: self.rev,
            text: self.text.clone(),
            bounds,
            origin,
            layout: shaped.layout.clone(),
            line_height: self.line_height,
            comp: self.comp,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::can_break_between;

    #[test]
    fn chinese_line_breaking_rules() {
        // Between ideographs: yes.
        assert!(can_break_between('天', '色'));
        // Never before a comma, full stop or closing quote; never after an opening one.
        assert!(!can_break_between('只', '，'));
        assert!(!can_break_between('了', '。'));
        assert!(!can_break_between('话', '”'));
        assert!(!can_break_between('“', '你'));
        assert!(!can_break_between('《', '书'));
        // After a closing mark the next ideograph may start a row.
        assert!(can_break_between('，', '十'));
        // Dashes and ellipses stay whole.
        assert!(!can_break_between('—', '—'));
        assert!(!can_break_between('…', '…'));
        // Latin words and numbers are not split; a space or a CJK neighbour breaks.
        assert!(!can_break_between('a', 'b'));
        assert!(!can_break_between('1', '9'));
        assert!(can_break_between(' ', 'L'));
        assert!(can_break_between('被', 'L'));
        assert!(can_break_between('a', '中'));
    }
}
