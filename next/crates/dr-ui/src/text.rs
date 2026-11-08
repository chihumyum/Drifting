//! Interface text that wraps by the editor's Chinese rules.
//!
//! GPUI v1.27 wraps text without them: a 「，」 or 「。」 can start a row
//! (M09's excerpts, F5's hover card summary). [`wrapped`] is a read-only
//! paragraph that breaks rows with `prose-linebreak` instead (the same
//! rules as the editor and [`crate::input::TextArea`]): no 点号 or closing
//! quote starts a row, Latin words stay whole, a mark that does not fit
//! hangs past the edge.
//!
//! It is a drop-in for a string child: it takes its face, size, colour and
//! line height from the text around it, and honours the parent's
//! `text_center()` / `text_right()`, `whitespace_nowrap()`, `line_clamp(n)`
//! and `text_ellipsis()` (or [`Wrapped::max_lines`]), so
//! `div().line_clamp(2).text_ellipsis().child(text)` becomes
//! `div().line_clamp(2).text_ellipsis().child(wrapped(text))`.

use std::ops::Range;

use gpui::{
    App, AvailableSpace, Bounds, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, ShapedLine, SharedString, Style, TextAlign, TextOverflow, TextRun,
    WhiteSpace, Window, point, px, relative, size,
};
use prose_linebreak as linebreak;

/// One paragraph shaped as a single line, and the rows it breaks into
/// (paragraph-relative byte ranges, each with the x it starts at).
pub(crate) struct Paragraph {
    pub start: usize,
    pub line: ShapedLine,
    pub breaks: Vec<(Range<usize>, Pixels)>,
}

/// The part of `runs` (covering the whole text) that falls in `range`.
pub(crate) fn runs_in(runs: &[TextRun], range: Range<usize>) -> Vec<TextRun> {
    let mut out = Vec::new();
    let mut at = 0;
    for run in runs {
        let (a, b) = (at.max(range.start), (at + run.len).min(range.end));
        if a < b {
            out.push(TextRun {
                len: b - a,
                ..run.clone()
            });
        }
        at += run.len;
    }
    out
}

/// Shapes `text` a paragraph at a time and breaks each into rows `wrap`
/// wide (none: one row a paragraph) by `prose-linebreak`. The caller chooses
/// whether closing marks hang or move with the preceding text to a new row.
pub(crate) fn shape(
    text: &str,
    runs: &[TextRun],
    font_size: Pixels,
    wrap: Option<Pixels>,
    overflow: linebreak::Overflow,
    window: &Window,
) -> Vec<Paragraph> {
    let starts = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1));
    let ends = text
        .match_indices('\n')
        .map(|(i, _)| i)
        .chain(std::iter::once(text.len()));
    starts
        .zip(ends)
        .map(|(start, end)| {
            let para = &text[start..end];
            let line = window.text_system().shape_line(
                SharedString::from(para.to_string()),
                font_size,
                &runs_in(runs, start..end),
                None,
            );
            let breaks = match wrap {
                Some(wrap) => {
                    // One (byte, x) per cluster, in byte order.
                    let mut glyphs: Vec<(usize, f32)> = line
                        .runs
                        .iter()
                        .flat_map(|r| r.glyphs.iter())
                        .map(|g| (g.index, f32::from(g.position.x)))
                        .collect();
                    glyphs.sort_by_key(|g| g.0);
                    glyphs.dedup_by_key(|g| g.0);
                    linebreak::break_rows(
                        para,
                        &glyphs,
                        f32::from(line.width()),
                        f32::from(wrap),
                        f32::from(font_size),
                        overflow,
                    )
                    .into_iter()
                    .map(|row| (row.range, px(row.start_x)))
                    .collect()
                }
                None => vec![(0..para.len(), px(0.0))],
            };
            Paragraph {
                start,
                line,
                breaks,
            }
        })
        .collect()
}

/// A paragraph of interface text (newlines start new paragraphs) wrapped by
/// the Chinese rules; see the module notes.
pub fn wrapped(text: impl Into<SharedString>) -> Wrapped {
    Wrapped {
        text: text.into(),
        max_lines: None,
    }
}

pub struct Wrapped {
    text: SharedString,
    max_lines: Option<usize>,
}

impl Wrapped {
    /// At most `n` rows, the last ending in 「…」 if the text goes on (the
    /// same as the parent's `line_clamp(n)` with `text_ellipsis()`).
    pub fn max_lines(mut self, n: usize) -> Self {
        self.max_lines = Some(n.max(1));
        self
    }
}

/// What the text style in force asks of the paragraph.
#[derive(Clone)]
struct Look {
    font_size: Pixels,
    line_height: Pixels,
    run: TextRun,
    wraps: bool,
    clamp: Option<usize>,
    affix: Option<SharedString>,
    align: TextAlign,
}

impl Wrapped {
    fn look(&self, window: &Window) -> Look {
        let style = window.text_style();
        let affix = match (&style.text_overflow, self.max_lines) {
            (
                Some(
                    TextOverflow::Truncate(a)
                    | TextOverflow::TruncateStart(a)
                    | TextOverflow::TruncateMiddle(a),
                ),
                _,
            ) => Some(a.clone()),
            (None, Some(_)) => Some(SharedString::new_static("…")),
            _ => None,
        };
        Look {
            font_size: style.font_size.to_pixels(window.rem_size()),
            line_height: window.pixel_snap(window.line_height()),
            run: style.to_run(self.text.len()),
            wraps: style.white_space == WhiteSpace::Normal,
            clamp: self.max_lines.or(style.line_clamp),
            affix,
            align: style.text_align,
        }
    }
}

/// The rows a [`Wrapped`] paints (its prepaint state).
pub struct Rows(Vec<Painted>);

/// One row to paint: its stretch of a shaped line, and an ellipsis after it
/// when the text was cut there.
struct Painted {
    piece: ShapedLine,
    ellipsis: Option<ShapedLine>,
    y: Pixels,
}

impl IntoElement for Wrapped {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

/// How many rows the paragraphs take, clamped.
fn row_count(paragraphs: &[Paragraph], clamp: Option<usize>) -> usize {
    let rows: usize = paragraphs.iter().map(|p| p.breaks.len()).sum();
    clamp.map_or(rows, |c| rows.min(c)).max(1)
}

impl gpui::Element for Wrapped {
    type RequestLayoutState = ();
    type PrepaintState = Rows;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        let look = self.look(window);
        let text = self.text.clone();
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let id = window.request_measured_layout(style, move |known, available, window, _| {
            let wrap = known.width.or(match available.width {
                AvailableSpace::Definite(w) => Some(w),
                _ => None,
            });
            let paragraphs = shape(
                &text,
                std::slice::from_ref(&look.run),
                look.font_size,
                wrap.filter(|_| look.wraps),
                linebreak::Overflow::Hang,
                window,
            );
            let width = wrap.unwrap_or_else(|| {
                paragraphs
                    .iter()
                    .map(|p| p.line.width())
                    .fold(px(0.0), |a, b| a.max(b))
            });
            size(
                width,
                look.line_height * row_count(&paragraphs, look.clamp) as f32,
            )
        });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        _: &mut App,
    ) -> Rows {
        let look = self.look(window);
        let width = bounds.size.width;
        let paragraphs = shape(
            &self.text,
            std::slice::from_ref(&look.run),
            look.font_size,
            look.wraps.then_some(width),
            linebreak::Overflow::Hang,
            window,
        );
        let total: usize = paragraphs.iter().map(|p| p.breaks.len()).sum();
        let keep = look.clamp.map_or(total, |c| total.min(c));
        // Cut where rows are dropped, or (not wrapping) where a row runs
        // past the width.
        let mut out = Vec::new();
        let mut y = px(0.0);
        'paragraphs: for (pi, para) in paragraphs.iter().enumerate() {
            let mut cursor = para.line.cursor();
            for (ri, (range, x0)) in para.breaks.iter().enumerate() {
                if out.len() == keep {
                    break 'paragraphs;
                }
                let last_kept = out.len() + 1 == keep;
                let more = ri + 1 < para.breaks.len() || pi + 1 < paragraphs.len();
                let overflows = para.line.x_for_index(range.end) - *x0 > width + px(0.5);
                let cut = look
                    .affix
                    .as_ref()
                    .filter(|_| (last_kept && more) || (!look.wraps && overflows));
                match cut {
                    Some(affix) => {
                        let ellipsis = window.text_system().shape_line(
                            affix.clone(),
                            look.font_size,
                            &[TextRun {
                                len: affix.len(),
                                ..look.run.clone()
                            }],
                            None,
                        );
                        let room = width - ellipsis.width();
                        let text = &para.line.text[range.clone()];
                        let end = text
                            .char_indices()
                            .map(|(i, _)| range.start + i)
                            .chain(std::iter::once(range.end))
                            .rev()
                            .find(|&b| para.line.x_for_index(b) - *x0 <= room)
                            .unwrap_or(range.start);
                        let piece = cursor.take_until(end);
                        out.push(Painted {
                            piece,
                            ellipsis: Some(ellipsis),
                            y,
                        });
                        if !look.wraps {
                            // The rest of this paragraph is cut away.
                            y += look.line_height;
                            continue 'paragraphs;
                        }
                        break 'paragraphs;
                    }
                    None => {
                        out.push(Painted {
                            piece: cursor.take_until(range.end),
                            ellipsis: None,
                            y,
                        });
                    }
                }
                y += look.line_height;
            }
        }
        Rows(out)
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        rows: &mut Rows,
        window: &mut Window,
        cx: &mut App,
    ) {
        let look = self.look(window);
        for row in rows.0.drain(..) {
            let used = row.piece.width() + row.ellipsis.as_ref().map_or(px(0.0), |e| e.width());
            let shift = match look.align {
                TextAlign::Left => px(0.0),
                TextAlign::Center => ((bounds.size.width - used) / 2.0).max(px(0.0)),
                TextAlign::Right => (bounds.size.width - used).max(px(0.0)),
            };
            let origin = point(bounds.origin.x + shift, bounds.origin.y + row.y);
            let _ = row
                .piece
                .paint(origin, look.line_height, TextAlign::Left, None, window, cx);
            if let Some(ellipsis) = row.ellipsis {
                let _ = ellipsis.paint(
                    point(origin.x + row.piece.width(), origin.y),
                    look.line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
        }
    }
}
