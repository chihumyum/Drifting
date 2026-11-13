//! Flow layout ([`crate::EditorOptions::flow`]): the editor as tall as its
//! text inside a page that scrolls it (an entry page's body), laying out and
//! painting only the items near the part of it the window shows — what
//! `list()` does for an editor that scrolls itself.
//!
//! The editor's height is the height index's total: measured items at their
//! height, the others at their estimate. Each frame the element finds the
//! item at the top of what the page shows, lays it out and the items around
//! it (by their real heights, [`FLOW_OVERDRAW`] above and below) and places
//! them from it. When laying them out corrects estimates above that item, the
//! index moves it; the element keeps it where it was this frame and, with
//! the page's scroll handle ([`crate::ProseEditor::set_page_scroll`]), moves
//! the page by the correction, so the text the author is looking at stays
//! put (the page's own scrolling is anchored to pixels, not to items). What
//! the page cannot take at its top is the text moving up to the editor's
//! top, as it should. Without a handle the items are placed by the index
//! alone: a correction above moves what is shown.
//!
//! Requests to keep the caret in view (the paragraph's autoscroll) move the
//! page too.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, Element, ElementId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, ScrollHandle, Style, Window, point, px,
    relative, size,
};

use crate::layout::HeightIndex;

/// Pixels laid out above and below the part of the editor the page shows.
pub const FLOW_OVERDRAW: f32 = 1200.;

/// What a flow editor keeps between frames.
#[derive(Default)]
pub struct FlowState {
    /// The host page's scroll.
    pub page: Option<ScrollHandle>,
    /// With a page: the item at the top of what it showed, and where
    /// (document pixels) the next frame places it.
    anchor: Option<(usize, f32)>,
    /// An item to bring into view that has not been laid out yet (the caret
    /// went far, maybe before the first frame): the page goes there.
    pub reveal: Option<usize>,
    /// The editor's bounds at the last prepaint (window pixels).
    pub bounds: Option<Bounds<Pixels>>,
    /// What the page showed of the window around the editor then (its
    /// content mask): the editor's visible part is this inside `bounds`.
    pub view: Option<Bounds<Pixels>>,
    /// The items laid out then.
    pub laid_out: Range<usize>,
}

impl FlowState {
    /// Items `start..start + old` were replaced by `new` items.
    pub fn splice(&mut self, start: usize, old: usize, new: usize) {
        let follow = |item: &mut usize| {
            if *item >= start + old {
                *item = *item - old + new;
            } else if *item >= start {
                *item = start;
            }
        };
        if let Some((item, _)) = &mut self.anchor {
            follow(item);
        }
        if let Some(item) = &mut self.reveal {
            follow(item);
        }
        self.laid_out = 0..0;
    }

    /// Every item changed (new slots, a new book): start from the index.
    pub fn reset(&mut self) {
        self.anchor = None;
        self.reveal = None;
        self.laid_out = 0..0;
    }

    /// Where the index puts things against where the last frame placed
    /// them (document pixels; 0 once the page took the difference).
    pub fn shift(&self, heights: &mut HeightIndex) -> f32 {
        match self.anchor {
            Some((item, at)) if item < heights.len() => at - heights.top(item) as f32,
            _ => 0.,
        }
    }

    /// Moves the page by `dy` (positive: the text goes down), as far as its
    /// top allows (its bottom is the page's to clamp: the editor's height may
    /// have changed since its last layout). Returns what it moved.
    pub fn scroll_page(&self, dy: f32) -> f32 {
        let Some(page) = &self.page else {
            return 0.;
        };
        let offset = page.offset();
        let y = (offset.y + px(dy)).min(px(0.));
        page.set_offset(point(offset.x, y));
        f32::from(y - offset.y)
    }

    /// Scrolls the page so that document pixel `y` of the editor shows
    /// `fraction` of the way down what the page shows, by the last frame's
    /// geometry. Returns false when there is no page or no frame yet.
    pub fn scroll_doc_to(&self, y: f32, fraction: f32) -> bool {
        let (Some(bounds), Some(view)) = (self.bounds, self.view) else {
            return false;
        };
        if self.page.is_none() {
            return false;
        }
        let wanted = view.top() + view.size.height * fraction;
        let now = bounds.top() + px(y);
        self.scroll_page(f32::from(wanted - now));
        true
    }
}

type RenderItem = Box<dyn FnMut(usize, &mut Window, &mut App) -> AnyElement>;

/// The flow editor's items, laid out around what the page shows.
pub struct FlowItems {
    count: usize,
    height: Pixels,
    heights: Rc<RefCell<HeightIndex>>,
    state: Rc<RefCell<FlowState>>,
    render_item: RenderItem,
}

impl FlowItems {
    pub fn new(
        count: usize,
        heights: Rc<RefCell<HeightIndex>>,
        state: Rc<RefCell<FlowState>>,
        render_item: impl FnMut(usize, &mut Window, &mut App) -> AnyElement + 'static,
    ) -> FlowItems {
        let height = {
            let mut index = heights.borrow_mut();
            let shift = state.borrow().shift(&mut index);
            px((index.total() as f32 + shift).max(0.))
        };
        FlowItems {
            count,
            height,
            heights,
            state,
            render_item: Box::new(render_item),
        }
    }
}

impl IntoElement for FlowItems {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for FlowItems {
    type RequestLayoutState = ();
    type PrepaintState = Vec<AnyElement>;

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
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = self.height.into();
        (window.request_layout(style, None, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<AnyElement> {
        // A request to scroll made before these items is not theirs.
        window.take_autoscroll();
        let view = window.content_mask().bounds;
        let visible = bounds.intersect(&view);
        {
            let mut state = self.state.borrow_mut();
            state.bounds = Some(bounds);
            state.view = Some(view);
            if state.page.is_none() {
                state.reveal = None;
            }
        }
        if self.count == 0 || visible.size.height <= px(0.) || visible.size.width <= px(0.) {
            // Scrolled away: nothing to lay out; the anchor waits. An item
            // the caret went to is brought into view by its estimate.
            let mut state = self.state.borrow_mut();
            state.laid_out = 0..0;
            if let Some(item) = state.reveal.filter(|&item| item < self.count) {
                let y = {
                    let mut index = self.heights.borrow_mut();
                    index.top(item) as f32 + state.shift(&mut index)
                };
                let wanted = view.top() + view.size.height / 3.;
                if state.scroll_page(f32::from(wanted - (bounds.top() + px(y)))) != 0. {
                    window.request_animation_frame();
                } else {
                    state.reveal = None;
                }
            }
            return Vec::new();
        }
        let top = f32::from(visible.top() - bounds.top());
        let bottom = f32::from(visible.bottom() - bounds.top());
        let has_page = self.state.borrow().page.is_some();
        // The item at the top of what is shown, placed where the last frame
        // put things (the index plus what the page has not taken yet).
        let (first, first_y, shift) = {
            let mut index = self.heights.borrow_mut();
            let shift = if has_page {
                self.state.borrow().shift(&mut index)
            } else {
                0.
            };
            let (first, _) = index.item_at(f64::from(top - shift));
            (first, index.top(first) as f32 + shift, shift)
        };
        let available = size(
            AvailableSpace::Definite(bounds.size.width),
            AvailableSpace::MinContent,
        );
        // Down from it, then up from it, each at its real height. Laying out
        // a paragraph records its height in the index (no borrow is held).
        let mut below: Vec<(usize, AnyElement, f32)> = Vec::new();
        let mut y = first_y;
        let mut ix = first;
        while ix < self.count && (ix == first || y < bottom + FLOW_OVERDRAW) {
            let mut element = (self.render_item)(ix, window, cx);
            let height = f32::from(element.layout_as_root(available, window, cx).height);
            below.push((ix, element, y));
            y += height;
            ix += 1;
        }
        let end = ix;
        let mut above: Vec<(usize, AnyElement, f32)> = Vec::new();
        let mut y = first_y;
        let mut ix = first;
        while ix > 0 && y > top - FLOW_OVERDRAW {
            ix -= 1;
            let mut element = (self.render_item)(ix, window, cx);
            let height = f32::from(element.layout_as_root(available, window, cx).height);
            y -= height;
            above.push((ix, element, y));
        }
        let start = ix;
        // Without the page, a difference found at the very top is taken here
        // and now: the text starts at the editor's top.
        let correction = if start == 0 && !has_page && y != 0. {
            -y
        } else {
            0.
        };
        let reveal = self.state.borrow().reveal.filter(|&item| item < self.count);
        let mut reveal_y = None;
        let mut items = Vec::with_capacity(above.len() + below.len());
        let mut wanted = None;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for (ix, mut element, y) in above.into_iter().rev().chain(below) {
                if Some(ix) == reveal {
                    reveal_y = Some(y + correction);
                }
                let origin = point(bounds.left(), bounds.top() + px(y + correction));
                element.prepaint_at(origin, window, cx);
                if let Some(request) = window.take_autoscroll() {
                    wanted = Some(request);
                }
                items.push(element);
            }
        });
        // Where the index now puts the anchor: the page takes the
        // difference, so the next frame places it there and it stays on
        // screen where it is.
        let placed = first_y + correction;
        let (index_top, total) = {
            let mut index = self.heights.borrow_mut();
            (index.top(first) as f32, index.total() as f32)
        };
        let mut state = self.state.borrow_mut();
        state.laid_out = start..end;
        let mut moved = 0.;
        // An item the caret went to (far off, or before the first frame):
        // shown once its top is on screen; until then the page takes it a
        // third of the way down. Its own paragraph asks for the caret's row
        // (below) once it is laid out.
        let mut revealing = false;
        if let Some(item) = reveal {
            let y = reveal_y
                .unwrap_or_else(|| self.heights.borrow_mut().top(item) as f32 + shift + correction);
            let at = bounds.top() + px(y);
            if at >= view.top() && at < view.bottom() {
                state.reveal = None;
            } else {
                let wanted = view.top() + view.size.height / 3.;
                let dy = state.scroll_page(f32::from(wanted - at));
                if dy == 0. {
                    state.reveal = None;
                } else {
                    moved += dy;
                    revealing = true;
                }
            }
        }
        if has_page {
            let difference = placed - index_top;
            if difference.abs() >= 0.5 {
                moved += state.scroll_page(difference);
                // What the page cannot take at its top is not kept: the
                // text goes up to the editor's top.
                if (moved - difference).abs() >= 0.5 {
                    moved = difference;
                }
            }
            state.anchor = Some((first, index_top));
        } else {
            state.anchor = None;
        }
        // Keep the caret in view (a row of context around it): the page
        // scrolls.
        if let Some(wanted) = wanted
            && has_page
            && !revealing
        {
            let dy = if wanted.top() < view.top() {
                f32::from(view.top() - wanted.top())
            } else if wanted.bottom() > view.bottom() {
                f32::from(view.bottom() - wanted.bottom())
            } else {
                0.
            };
            if dy != 0. {
                moved += state.scroll_page(dy);
            }
        }
        drop(state);
        let height_changed = (total - f32::from(self.height)).abs() >= 0.5;
        if moved != 0. || height_changed {
            window.request_animation_frame();
        }
        items
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        items: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for item in items {
                item.paint(window, cx);
            }
        });
    }
}
