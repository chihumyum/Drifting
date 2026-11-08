//! The paragraph element: one per visible paragraph, created by the editor's
//! `list()` item callback each frame. It shapes and breaks the paragraph in
//! layout (recording its measured height), places the caret in prepaint, and
//! paints, bottom to top: the quote's wash, the decorations under the words
//! (comment sand, find hits), the selection, the words (in their inks), the
//! decorations over the words (dry underlines, a suggestion's grains) and a
//! rule.
//!
//! Decorations never change the layout: they are painted from the shaped
//! rows. Block styles do (an indent narrows the column), and come from the
//! paragraph's attributes like its heading level.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{
    App, AvailableSpace, Bounds, DispatchPhase, Element, ElementId, GlobalElementId, Hsla,
    InspectorElementId, IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent,
    PathBuilder, Pixels, Point, SharedString, Size, Style, TextRun, WeakEntity, Window, fill,
    point, px, quad, relative, size,
};

use super::{
    blocks::{BlockLook, BlockStyle, ListItem, ListMark},
    decor::{Brush, DecorationKey, Touch},
    frame::{CompSpan, FrameCache, PaintedDecoration, PaintedLine},
    paint::{TextPaint, paint_text},
    sand::{paint_dots, paint_stroke},
    state::{ParaDeco, ParaKind, Shared},
};
use crate::{
    ProseEditor,
    layout::{
        Affinity, HeightIndex, ProseLayout, RowSetting, column, shape_set, typewriter_bounds,
        typewriter_tail,
    },
};

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
    pub text_color: Hsla,
    pub frame: Rc<RefCell<FrameCache>>,
    pub heights: Rc<RefCell<HeightIndex>>,
    /// Quote, indent, alignment, rule.
    pub block: BlockLook,
    pub(crate) block_style: BlockStyle,
    /// The body size (a quote's wash reaches a fraction of it past the text).
    pub(crate) body_size: Pixels,
    /// Decorations on this paragraph this frame.
    pub(crate) decos: Vec<ParaDeco>,
    /// The share of its ink the text keeps (immersive writing).
    pub(crate) alpha: f32,
    pub(crate) editor: WeakEntity<ProseEditor>,
    pub(crate) shared: Rc<RefCell<Shared>>,
    /// A drawn decoration waits for the author's next click in the prose.
    pub(crate) settle_on_click: bool,
    /// How the rows are set: first-line indent, alignment, justification,
    /// squeezing (F4b; the column width comes from layout).
    pub(crate) setting: RowSetting,
    /// Typewriter scrolling's line (a fraction of the view), if on.
    pub(crate) typewriter: Option<f32>,
    /// The book's last paragraph (room after it for typewriter scrolling).
    pub(crate) last: bool,
}

struct Shaped {
    layout: Rc<ProseLayout>,
    /// The text's left edge inside the item (column, indent, quote inset).
    /// Alignment, indent and justification are the layout's own (F4b), so
    /// every row is placed by the layout.
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

/// The extent of `bytes` in each of `rows` it touches, relative to the text
/// origin (the layout's placement applied): (row, x0, x1).
fn row_spans<'a>(
    layout: &'a ProseLayout,
    rows: Range<usize>,
    bytes: Range<usize>,
) -> impl Iterator<Item = (usize, Pixels, Pixels)> + 'a {
    let first = layout
        .rows
        .partition_point(|row| row.end <= bytes.start)
        .max(rows.start);
    (first..rows.end.min(layout.row_count()))
        .take_while(move |&row| layout.rows[row].start < bytes.end)
        .filter_map(move |row| {
            let span = &layout.rows[row];
            let (start, end) = (bytes.start.max(span.start), bytes.end.min(span.end));
            (start < end).then(|| (row, layout.x_at(row, start), layout.x_at(row, end)))
        })
}

/// Whether the segment `a`–`b` meets `rect` (Liang–Barsky).
pub(crate) fn segment_hits(a: Point<Pixels>, b: Point<Pixels>, rect: Bounds<Pixels>) -> bool {
    let (x0, y0) = (f32::from(a.x), f32::from(a.y));
    let (dx, dy) = (f32::from(b.x) - x0, f32::from(b.y) - y0);
    let (mut t0, mut t1) = (0f32, 1f32);
    for (p, q) in [
        (-dx, x0 - f32::from(rect.left())),
        (dx, f32::from(rect.right()) - x0),
        (-dy, y0 - f32::from(rect.top())),
        (dy, f32::from(rect.bottom()) - y0),
    ] {
        if p == 0. {
            if q < 0. {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0. {
                t0 = t0.max(r);
            } else {
                t1 = t1.min(r);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
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
        let tail = match self.typewriter {
            // Room after the last paragraph so typewriter scrolling can bring
            // its last row up to the line.
            Some(position) if self.last => typewriter_tail(window.viewport_size().height, position),
            _ => px(0.),
        };
        let (pad_top, pad_bottom) = (self.pad_top, self.pad_bottom + tail);
        let (max_width, gutter) = (self.max_width, self.gutter);
        let (item_ix, heights) = (self.item_ix, self.heights.clone());
        let block = self.block;
        let setting = self.setting;
        let layout_id = window.request_measured_layout(style, {
            let shared = shared.clone();
            move |known: Size<Option<Pixels>>, available: Size<AvailableSpace>, window, _cx| {
                let width = known.width.unwrap_or(match available.width {
                    AvailableSpace::Definite(width) => width,
                    _ => max_width + gutter * 2.,
                });
                let (column_width, left) = column(width, max_width, gutter);
                let wrap_width = (column_width - block.inset - block.inset_right).max(px(40.));
                // Alignment, indent, squeezing and justification are the
                // layout's, so every position it answers is placed.
                let layout = shape_set(&text, font_size, &runs, wrap_width, setting, window);
                let height = pad_top + line_height * layout.row_count() as f32 + pad_bottom;
                heights
                    .borrow_mut()
                    .set_measured(item_ix, f32::from(height));
                *shared.borrow_mut() = Some(Shaped {
                    layout: Rc::new(layout),
                    left: left + block.inset,
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
            // Not while the input method composes (the candidate window
            // would move under the pinyin); the confirmed text realigns.
            match self.typewriter.filter(|_| self.comp.is_none()) {
                // Typewriter scrolling: the caret's row to the line.
                Some(position) => {
                    let view = window.content_mask().bounds;
                    if let Some(wanted) = typewriter_bounds(cursor, view, position) {
                        window.request_autoscroll(wanted);
                    }
                }
                // Keep a row of context above and below the cursor.
                None => {
                    let margin = self.line_height;
                    window.request_autoscroll(Bounds::from_corners(
                        point(cursor.left(), cursor.top() - margin),
                        point(cursor.right(), cursor.bottom() + margin),
                    ));
                }
            }
        }
        // How the paragraph broke into rows this frame, for the screen
        // reader's runs (built after the editor's children prepaint).
        self.frame.borrow_mut().prepainted.push(PaintedLine {
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
        cx: &mut App,
    ) {
        let shared = layout.0.borrow();
        let Some(shaped) = shared.as_ref() else {
            return;
        };
        let origin = bounds.origin + point(shaped.left, self.pad_top);
        let lay = &shaped.layout;
        let lh = self.line_height;
        let rows = lay.row_count();
        let ascent = lay.line.ascent;
        let content = ascent + lay.line.descent;
        let padding_top = (lh - content) / 2.;
        let baseline = padding_top + ascent;
        let first_paint = self.frame.borrow().lines.is_empty();
        if first_paint {
            self.shared.borrow_mut().frame += 1;
            self.frame.borrow_mut().decorations.clear();
        }

        // Three layers, bottom to top: under the words, the words, over the
        // words. A layer takes one place in GPUI's ordering for all it
        // holds (inside it quads come before sprites), so sand under a row
        // of glyphs costs one ordering, not one per glyph.
        let layer_bounds = Bounds::from_corners(
            bounds.origin - point(px(0.), lh),
            bounds.bottom_right() + point(px(0.), lh),
        );
        // Each decoration's boxes, row by row, in window coordinates.
        let text_box = |row: usize, x0: Pixels, x1: Pixels, reach: Pixels| {
            Bounds::from_corners(
                origin + point(x0 - reach, lh * row as f32 + padding_top - px(1.)),
                origin + point(x1 + reach, lh * row as f32 + padding_top + content + px(2.)),
            )
        };
        let mut touch_targets: Vec<(DecorationKey, Touch, Vec<Bounds<Pixels>>)> = Vec::new();
        let mut inks: Vec<(Range<usize>, Hsla, f32)> = Vec::new();
        let mut painted = Vec::with_capacity(self.decos.len());
        // Only rows in view (and one either side) are worked out.
        let mask = window.content_mask().bounds;
        let rows_in_view = {
            let lo = ((mask.top() - origin.y) / lh).floor() - 1.;
            let hi = ((mask.bottom() - origin.y) / lh).ceil() + 1.;
            (lo.max(0.) as usize)..(hi.max(0.) as usize).min(rows)
        };

        window.paint_layer(layer_bounds, |window| {
            self.paint_block_washes(bounds, shaped, origin, rows, window);
            self.paint_quote_wash(bounds, shaped.left, origin, rows, window);
            for deco in &self.decos {
                let reach = match &deco.kind {
                    ParaKind::Wash { reach, .. } => *reach,
                    _ => px(0.),
                };
                let boxes: Vec<Bounds<Pixels>> =
                    row_spans(lay, rows_in_view.clone(), deco.bytes.clone())
                        .map(|(row, x0, x1)| text_box(row, x0, x1, reach))
                        .collect();
                if deco.touch != Touch::None {
                    touch_targets.push((deco.key.clone(), deco.touch, boxes.clone()));
                }
                match &deco.kind {
                    ParaKind::Ink { color, level } => {
                        inks.push((deco.bytes.clone(), *color, *level))
                    }
                    ParaKind::Wash {
                        brush,
                        hot_brush,
                        color,
                        alpha,
                        heat,
                        ..
                    } => {
                        let reveal = reveal_ends(&boxes, deco.drawn);
                        for (ix, rect) in boxes.iter().enumerate() {
                            let seed = deco.seed ^ ix as u32;
                            match hot_brush {
                                Some(hot) if *heat > 0. => {
                                    let (rest, hot_alpha) = (alpha * (1. - heat), alpha * heat);
                                    let tint = color.alpha(rest);
                                    paint_brush(brush, *rect, reveal[ix], tint, seed, window, cx);
                                    let tint = color.alpha(hot_alpha);
                                    paint_brush(hot, *rect, reveal[ix], tint, seed, window, cx);
                                }
                                _ => {
                                    let tint = color.alpha(*alpha);
                                    paint_brush(brush, *rect, reveal[ix], tint, seed, window, cx);
                                }
                            }
                        }
                    }
                    ParaKind::Underline { .. } => {}
                }
                painted.push(PaintedDecoration {
                    chapter: self.chapter,
                    line: self.line,
                    key: deco.key.clone(),
                    boxes,
                    alpha: match &deco.kind {
                        ParaKind::Wash { alpha, .. } | ParaKind::Underline { alpha, .. } => *alpha,
                        ParaKind::Ink { level, .. } => *level,
                    },
                    drawn: deco.drawn,
                });
            }
        });

        let mut task_box = None;
        window.paint_layer(layer_bounds, |window| {
            if let Some((range, past_end)) = self.selection.clone() {
                for rect in lay.selection_rects(range, past_end, lh) {
                    window.paint_quad(fill(
                        Bounds::new(origin + rect.origin, rect.size),
                        self.selection_color,
                    ));
                }
            }
            let done = matches!(
                self.block.list,
                Some(ListItem {
                    mark: ListMark::Task { done: true },
                    ..
                })
            );
            let plain = if done {
                self.block_style.task_done_ink
            } else if self.block.code && self.block_style.code_ink.is_some() {
                self.block_style.code_ink
            } else {
                self.block
                    .quote
                    .then_some(self.block_style.quote_ink)
                    .flatten()
            }
            .map(|ink| (self.text_color, ink));
            paint_text(
                lay,
                origin,
                lh,
                &TextPaint {
                    runs: &self.runs,
                    fallback: self.text_color,
                    inks: &inks,
                    plain,
                    alpha: self.alpha,
                },
                window,
            );
            if self.block.rule {
                let (column, _) = column(bounds.size.width, self.max_width, self.gutter);
                let width = column * self.block_style.rule_width.clamp(0.05, 1.);
                let center_x = bounds.left() + bounds.size.width / 2.;
                let y = (origin.y + lh / 2.).round();
                window.paint_quad(fill(
                    Bounds::from_corners(
                        point(center_x - width / 2., y),
                        point(center_x + width / 2., y + px(0.5)),
                    ),
                    self.block_style.rule,
                ));
            }
            if done {
                // A done task's text is struck through, row by row.
                let ink = self.block_style.task_done_ink.unwrap_or(self.text_color);
                let thick = (self.font_size * 0.06).max(px(1.));
                for row in rows_in_view.clone() {
                    if let Some((x0, x1)) = lay.x_range(row, 0..self.text.len()) {
                        let y = origin.y + lh * row as f32 + baseline - ascent * 0.3;
                        window.paint_quad(fill(
                            Bounds::new(origin + point(x0, y - origin.y), size(x1 - x0, thick)),
                            ink,
                        ));
                    }
                }
            }
            task_box = self.paint_list_mark(origin, lh, baseline, ascent, window, cx);
        });

        if self
            .decos
            .iter()
            .any(|d| matches!(d.kind, ParaKind::Underline { .. }))
        {
            window.paint_layer(layer_bounds, |window| {
                for deco in &self.decos {
                    let ParaKind::Underline {
                        brush,
                        color,
                        alpha,
                        height,
                        drop,
                    } = &deco.kind
                    else {
                        continue;
                    };
                    let boxes: Vec<Bounds<Pixels>> =
                        row_spans(lay, rows_in_view.clone(), deco.bytes.clone())
                            .map(|(row, x0, x1)| {
                                let mid = lh * row as f32 + baseline + *drop;
                                Bounds::from_corners(
                                    origin + point(x0, mid - *height / 2.),
                                    origin + point(x1, mid + *height / 2.),
                                )
                            })
                            .collect();
                    let reveal = reveal_ends(&boxes, deco.drawn);
                    for (ix, rect) in boxes.iter().enumerate() {
                        let tint = color.alpha(*alpha);
                        let seed = deco.seed ^ ix as u32;
                        match brush {
                            Brush::Dotted => {
                                let y = rect.center().y - px(0.65);
                                paint_dots(
                                    rect.left(),
                                    rect.right(),
                                    y,
                                    reveal[ix],
                                    tint,
                                    seed,
                                    window,
                                )
                            }
                            _ => paint_brush(brush, *rect, reveal[ix], tint, seed, window, cx),
                        }
                    }
                }
            });
        }
        self.frame.borrow_mut().decorations.extend(painted);

        if let Some(cursor) = prepaint.cursor {
            self.cursor_out.set(Some(cursor));
        }
        self.listen(&touch_targets, bounds, origin, window, cx);
        if let Some(task_box) = task_box {
            self.listen_task_box(task_box, window);
        }

        // What hit testing, vertical movement and the input method read:
        // one record a paragraph (the layout places each row itself).
        self.frame.borrow_mut().lines.push(PaintedLine {
            chapter: self.chapter,
            line: self.line,
            rev: self.rev,
            text: self.text.clone(),
            bounds,
            origin,
            layout: lay.clone(),
            line_height: lh,
            comp: self.comp,
        });
    }
}

/// Where each box's stroke is drawn to, for a stroke drawn along its rows:
/// `drawn` of the boxes' whole width, in order. `Pixels::MAX` when done.
fn reveal_ends(boxes: &[Bounds<Pixels>], drawn: Option<f32>) -> Vec<Pixels> {
    let Some(drawn) = drawn else {
        return vec![Pixels::MAX; boxes.len()];
    };
    let total: f32 = boxes.iter().map(|b| f32::from(b.size.width)).sum();
    let mut left = total * drawn;
    boxes
        .iter()
        .map(|b| {
            let w = f32::from(b.size.width);
            let here = left.clamp(0., w);
            left -= w;
            b.left() + px(here)
        })
        .collect()
}

fn paint_brush(
    brush: &Brush,
    rect: Bounds<Pixels>,
    drawn_to: Pixels,
    color: Hsla,
    seed: u32,
    window: &mut Window,
    cx: &App,
) {
    match brush {
        Brush::Sand(texture) => paint_stroke(texture, rect, drawn_to, color, seed, window, cx),
        Brush::Flat | Brush::Dotted => {
            let right = rect.right().min(drawn_to);
            if right > rect.left() && color.a > 0.003 {
                window.paint_quad(
                    fill(
                        Bounds::from_corners(rect.origin, point(right, rect.bottom())),
                        color,
                    )
                    .corner_radii(px(2.)),
                );
            }
        }
    }
}

impl ParagraphElement {
    /// A callout's wash and edge, and a code block's wash, under the text:
    /// a paragraph inside the block paints its whole height, the first and
    /// the last only their part of the pads, so the block reads as one.
    fn paint_block_washes(
        &self,
        bounds: Bounds<Pixels>,
        shaped: &Shaped,
        origin: Point<Pixels>,
        rows: usize,
        window: &mut Window,
    ) {
        let (look, style, body) = (&self.block, &self.block_style, self.body_size);
        if !look.code && !look.callout {
            return;
        }
        let em = |ems: f32| (body * ems).round();
        let text_bottom = origin.y + self.line_height * rows as f32;
        let code_pad = em(style.code_pad);
        let (code_top, code_bottom) = (
            if look.code && !look.code_above {
                code_pad
            } else {
                px(0.)
            },
            if look.code && !look.code_below {
                code_pad
            } else {
                px(0.)
            },
        );
        let (column_width, column_left) = column(bounds.size.width, self.max_width, self.gutter);
        let column_left = bounds.left() + column_left;
        let corners = |radius: Pixels, above: bool, below: bool| gpui::Corners {
            top_left: if above { px(0.) } else { radius },
            top_right: if above { px(0.) } else { radius },
            bottom_left: if below { px(0.) } else { radius },
            bottom_right: if below { px(0.) } else { radius },
        };
        if look.callout {
            let top = if look.callout_above {
                bounds.top()
            } else {
                origin.y - code_top - em(style.callout_pad)
            };
            let bottom = if look.callout_below {
                bounds.bottom()
            } else {
                text_bottom + code_bottom + em(style.callout_pad)
            };
            let left = column_left + body * (f32::from(look.indent) * style.indent_step);
            let rect =
                Bounds::from_corners(point(left, top), point(column_left + column_width, bottom));
            let radii = corners(style.block_radius, look.callout_above, look.callout_below);
            if let Some(wash) = style.callout_wash {
                window.paint_quad(fill(rect, wash).corner_radii(radii));
            }
            if let Some(edge) = style.callout_edge {
                // The edge runs round the whole aside: each paragraph paints
                // a framed box reaching past its joined sides, clipped to
                // itself, so the middle shows the sides, the ends their
                // rounded top or bottom.
                let w = px(1.);
                let reach = |joined: bool| if joined { px(12.) } else { px(0.) };
                let framed = Bounds::from_corners(
                    point(rect.left(), rect.top() - reach(look.callout_above)),
                    point(rect.right(), rect.bottom() + reach(look.callout_below)),
                );
                let clip = Bounds::from_corners(
                    point(rect.left() - w, rect.top()),
                    point(rect.right() + w, rect.bottom()),
                )
                .intersect(&window.content_mask().bounds);
                window.with_content_mask(Some(gpui::ContentMask { bounds: clip }), |window| {
                    window.paint_quad(quad(
                        framed,
                        style.block_radius,
                        gpui::transparent_black(),
                        w,
                        edge,
                        gpui::BorderStyle::Solid,
                    ));
                });
            }
        }
        if look.code
            && let Some(wash) = style.code_wash
        {
            let top = if look.code_above {
                bounds.top()
            } else {
                origin.y - code_top
            };
            let bottom = if look.code_below {
                bounds.bottom()
            } else {
                text_bottom + code_bottom
            };
            let inset = em(style.code_inset);
            let left = shaped.left + bounds.left() - inset;
            let right = shaped.left + bounds.left() + shaped.layout.wrap_width + inset;
            window.paint_quad(
                fill(
                    Bounds::from_corners(point(left, top), point(right, bottom)),
                    wash,
                )
                .corner_radii(corners(
                    style.block_radius,
                    look.code_above,
                    look.code_below,
                )),
            );
        }
    }

    /// The quote's wash, running through the gaps to its neighbours.
    fn paint_quote_wash(
        &self,
        bounds: Bounds<Pixels>,
        left: Pixels,
        origin: Point<Pixels>,
        rows: usize,
        window: &mut Window,
    ) {
        let Some(wash) = self.block_style.quote_wash.filter(|_| self.block.quote) else {
            return;
        };
        let lh = self.line_height;
        let reach = self.body_size * 0.35;
        let top = if self.block.quote_above {
            bounds.top()
        } else {
            origin.y - reach
        };
        let bottom = if self.block.quote_below {
            bounds.bottom()
        } else {
            origin.y + lh * rows as f32 + reach
        };
        let (width, _) = column(bounds.size.width, self.max_width, self.gutter);
        let left = (bounds.left() + left - self.body_size * self.block_style.quote_inset)
            .max(bounds.left());
        let right = bounds.left() + (bounds.size.width - width) / 2. + width;
        let radius = self.block_style.block_radius;
        let round = |square: bool| if square { px(0.) } else { radius };
        window.paint_quad(
            fill(
                Bounds::from_corners(point(left, top), point(right, bottom)),
                wash,
            )
            .corner_radii(gpui::Corners {
                top_left: round(self.block.quote_above),
                top_right: round(self.block.quote_above),
                bottom_left: round(self.block.quote_below),
                bottom_right: round(self.block.quote_below),
            }),
        );
    }

    /// The pointer: touching a [`Touch::Fade`] decoration (moving onto it, or
    /// the prose scrolling under a pointer held still) and resting on a
    /// [`Touch::Point`] one; a click settles drawn decorations. What is found
    /// is applied in a deferred editor update (painting cannot change the
    /// editor).
    /// A list item's mark left of its first row; a task's box is returned
    /// (where a click ticks it).
    fn paint_list_mark(
        &self,
        origin: Point<Pixels>,
        lh: Pixels,
        baseline: Pixels,
        ascent: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let item = self.block.list?;
        let style = &self.block_style;
        let ink = style.list_ink.unwrap_or(self.text_color);
        let em = self.font_size;
        let right = origin.x - em * 0.5;
        let middle = origin.y + baseline - ascent * 0.33;
        match item.mark {
            ListMark::Bullet => {
                let d = em * 0.3;
                let dot = Bounds::new(point(right - d, middle - d / 2.), size(d, d));
                match item.level % 3 {
                    0 => window.paint_quad(fill(dot, ink).corner_radii(d / 2.)),
                    1 => window.paint_quad(quad(
                        dot,
                        d / 2.,
                        gpui::transparent_black(),
                        px(1.),
                        ink,
                        gpui::BorderStyle::Solid,
                    )),
                    _ => {
                        let s = d * 0.85;
                        window.paint_quad(fill(
                            Bounds::new(point(right - s, middle - s / 2.), size(s, s)),
                            ink,
                        ))
                    }
                }
                None
            }
            ListMark::Ordered(n) => {
                let label = SharedString::from(format!("{n}."));
                let run = TextRun {
                    len: label.len(),
                    color: ink,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                    ..self.runs.first().cloned().unwrap_or_else(|| TextRun {
                        len: 0,
                        font: window.text_style().font(),
                        color: ink,
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    })
                };
                let line = window.text_system().shape_line(label, em, &[run], None);
                let at = point(right - line.width, origin.y);
                let _ = line.paint(at, lh, gpui::TextAlign::Left, None, window, cx);
                None
            }
            ListMark::Task { done } => {
                let side = em * 0.82;
                let b = Bounds::new(point(right - side, middle - side / 2.), size(side, side));
                let radius = (side * 0.2).min(px(3.));
                if done {
                    window.paint_quad(fill(b, style.task_done).corner_radii(radius));
                    let mut tick = PathBuilder::stroke(side * 0.13);
                    let p = |x: f32, y: f32| b.origin + point(side * x, side * y);
                    tick.move_to(p(0.24, 0.52));
                    tick.line_to(p(0.43, 0.7));
                    tick.line_to(p(0.77, 0.32));
                    if let Ok(path) = tick.build() {
                        window.paint_path(path, style.task_tick);
                    }
                } else {
                    window.paint_quad(quad(
                        b,
                        radius,
                        gpui::transparent_black(),
                        px(1.2),
                        style.task_box,
                        gpui::BorderStyle::Solid,
                    ));
                }
                // A little room around the box for the click.
                Some(b.dilate(px(4.)))
            }
        }
    }

    /// A click on a task's box ticks it (the host does): the caret stays
    /// where it was.
    fn listen_task_box(&self, task_box: Bounds<Pixels>, window: &mut Window) {
        let mask = window.content_mask().bounds;
        let (editor, chapter, line) = (self.editor.clone(), self.chapter, self.line);
        window.on_mouse_event(move |event: &MouseDownEvent, phase, _window, cx| {
            if phase == DispatchPhase::Capture
                && event.button == MouseButton::Left
                && mask.contains(&event.position)
                && task_box.contains(&event.position)
            {
                cx.stop_propagation();
                let editor = editor.clone();
                cx.defer(move |cx| {
                    if let Some(editor) = editor.upgrade() {
                        editor.update(cx, |e, cx| e.task_clicked(chapter, line, cx));
                    }
                });
            }
        });
    }

    fn listen(
        &self,
        targets: &[(DecorationKey, Touch, Vec<Bounds<Pixels>>)],
        bounds: Bounds<Pixels>,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let mask = window.content_mask().bounds;
        let chapter = self.chapter;
        let schedule = |editor: WeakEntity<ProseEditor>, cx: &mut App| {
            cx.defer(move |cx| {
                if let Some(editor) = editor.upgrade() {
                    editor.update(cx, |editor, cx| editor.take_pointer_findings(cx));
                }
            });
        };
        if targets.iter().any(|(_, touch, _)| *touch == Touch::Fade) {
            // A pointer held still while the prose moves under it touches
            // everything that passes: the path from where it was on this
            // paragraph last frame to where it is now (only the landing
            // point when the prose jumped more than half the view).
            let pointer = window.mouse_position();
            let mut shared = self.shared.borrow_mut();
            let frame = shared.frame;
            if shared.pointer_in && mask.contains(&pointer) {
                let key = (self.chapter, self.line);
                let from = shared
                    .last_local
                    .get(&key)
                    .filter(|(f, rev, _)| f + 1 == frame && *rev == self.rev)
                    .map(|(_, _, local)| origin + *local)
                    .filter(|from| (from.y - pointer.y).abs() <= mask.size.height / 2.)
                    .unwrap_or(pointer);
                for (key, touch, boxes) in targets {
                    if *touch == Touch::Fade
                        && boxes.iter().any(|b| segment_hits(from, pointer, *b))
                    {
                        shared.touched.push((chapter, key.clone()));
                    }
                }
                shared
                    .last_local
                    .insert(key, (frame, self.rev, pointer - origin));
            }
            if frame.is_multiple_of(64) {
                shared.last_local.retain(|_, (f, _, _)| *f + 2 >= frame);
            }
            if !shared.touched.is_empty() && !shared.scheduled {
                shared.scheduled = true;
                drop(shared);
                schedule(self.editor.clone(), cx);
            }
        }
        if !targets.is_empty() {
            let targets = targets.to_vec();
            let (shared, editor) = (self.shared.clone(), self.editor.clone());
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let mut sh = shared.borrow_mut();
                sh.pointer_in = true;
                if sh.pointer != Some(event.position) {
                    sh.pointer_prev = sh.pointer;
                    sh.pointer = Some(event.position);
                    sh.hits.clear();
                }
                sh.moved = true;
                let from = sh.pointer_prev.unwrap_or(event.position);
                let inside = mask.contains(&event.position);
                for (key, touch, boxes) in &targets {
                    match touch {
                        Touch::Fade => {
                            if boxes.iter().any(|b| segment_hits(from, event.position, *b)) {
                                sh.touched.push((chapter, key.clone()));
                            }
                        }
                        Touch::Point { rest } => {
                            let hit = event.pressed_button.is_none()
                                && inside
                                && boxes.iter().any(|b| b.contains(&event.position));
                            if hit && !sh.hits.iter().any(|(c, k, _)| *c == chapter && k == key) {
                                sh.hits.push((chapter, key.clone(), *rest));
                            }
                        }
                        Touch::None => {}
                    }
                }
                if !sh.scheduled {
                    sh.scheduled = true;
                    drop(sh);
                    schedule(editor.clone(), cx);
                }
            });
        }
        if self.settle_on_click {
            let editor = self.editor.clone();
            let _ = bounds;
            window.on_mouse_event(move |event: &MouseDownEvent, phase, _window, cx| {
                if phase == DispatchPhase::Bubble
                    && event.button == MouseButton::Left
                    && mask.contains(&event.position)
                {
                    let editor = editor.clone();
                    cx.defer(move |cx| {
                        if let Some(editor) = editor.upgrade() {
                            editor.update(cx, |editor, cx| editor.settle_drawn(cx));
                        }
                    });
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_meet_boxes_they_cross() {
        let rect = Bounds::from_corners(point(px(10.), px(10.)), point(px(20.), px(20.)));
        let p = |x: f32, y: f32| point(px(x), px(y));
        // A point inside.
        assert!(segment_hits(p(15., 15.), p(15., 15.), rect));
        // Passing straight through without stopping inside.
        assert!(segment_hits(p(15., 0.), p(15., 30.), rect));
        assert!(segment_hits(p(0., 0.), p(30., 30.), rect));
        // Passing by.
        assert!(!segment_hits(p(0., 0.), p(30., 5.), rect));
        assert!(!segment_hits(p(25., 0.), p(25., 30.), rect));
    }

    #[test]
    fn a_drawn_stroke_reaches_along_its_rows_in_order() {
        let b = |x: f32, w: f32| Bounds::new(point(px(x), px(0.)), size(px(w), px(10.)));
        let boxes = [b(0., 100.), b(0., 100.), b(0., 50.)];
        let ends = reveal_ends(&boxes, Some(0.5));
        assert_eq!(ends, [px(100.), px(25.), px(0.)]);
        assert!(reveal_ends(&boxes, None).iter().all(|e| *e == Pixels::MAX));
    }
}
