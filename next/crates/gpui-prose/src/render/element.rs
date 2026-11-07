//! The paragraph element: one per visible paragraph, created by the editor's
//! `list()` item callback each frame. It shapes and breaks the paragraph in
//! layout (recording its measured height), places the caret in prepaint, and
//! paints selection, text and decorations.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, Pixels, SharedString, Size, Style, TextRun, Window, fill, point, px,
    relative, size,
};

use super::{
    frame::{CompSpan, FrameCache, PaintedLine},
    paint::paint_layout,
};
use crate::layout::{Affinity, HeightIndex, ProseLayout, column, shape};

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
        paint_layout(
            &shaped.layout,
            origin,
            self.line_height,
            &self.runs,
            self.text_color,
            window,
        );
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
