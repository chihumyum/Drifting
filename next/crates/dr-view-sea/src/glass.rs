//! Glass lying on the sea (the 0.1 client's `useCharSeaShape`): a page wraps
//! each card it lays on the sea in [`on_sea`], and the sea draws that
//! card's resting line, veils itself under it and lets the water reach its
//! rim. While the sea is on ([`crate::Sea::is_on`]), the card draws no rim
//! of its own and leaves its ground clear.

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

use crate::element::shape_id;
use crate::sea::{Sea, Shape};

/// How a piece of glass lies on the sea.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SeaGlass {
    /// Strength of the resting line: the app's resting glass is 0.85; 0
    /// shows only what the water brings; below 0 no line at all, only the
    /// veil.
    pub rest: f32,
    pub radius: f32,
    /// Set down on the sea: the resting line starts from nothing and
    /// settles in.
    pub arrive: bool,
    /// Waiting on the author: the rim flows as under the pointer.
    pub waiting: bool,
    /// Whether the pointer on it brings the bleed and the drift.
    pub hover: bool,
}

impl SeaGlass {
    /// The app's resting glass with corner `radius`.
    pub fn resting(radius: f32) -> SeaGlass {
        SeaGlass {
            rest: 0.85,
            radius,
            arrive: false,
            waiting: false,
            hover: true,
        }
    }

    /// Only what the water brings (a new book's empty slot): no line at rest.
    pub fn bare(radius: f32) -> SeaGlass {
        SeaGlass {
            rest: 0.0,
            ..SeaGlass::resting(radius)
        }
    }

    pub fn rest(mut self, rest: f32) -> SeaGlass {
        self.rest = rest;
        self
    }

    pub fn arrive(mut self, arrive: bool) -> SeaGlass {
        self.arrive = arrive;
        self
    }

    pub fn waiting(mut self, waiting: bool) -> SeaGlass {
        self.waiting = waiting;
        self
    }

    pub fn hover(mut self, hover: bool) -> SeaGlass {
        self.hover = hover;
        self
    }
}

/// Lays `child` on the sea as glass (see the module's doc). The sea reads
/// it a frame late, as the 0.1 client measured after layout.
pub fn on_sea(id: impl Into<ElementId>, glass: SeaGlass, child: impl IntoElement) -> OnSea {
    OnSea {
        id: id.into(),
        glass,
        child: child.into_any_element(),
    }
}

pub struct OnSea {
    id: ElementId,
    glass: SeaGlass,
    child: AnyElement,
}

impl IntoElement for OnSea {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for OnSea {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.prepaint(window, cx);
        let sea = Sea::of(window, cx);
        if !sea.is_on() {
            return;
        }
        let hover = self.glass.hover && bounds.contains(&window.mouse_position());
        let shape = Shape {
            id: shape_id(&self.id),
            bounds,
            radius: self.glass.radius,
            rest: self.glass.rest,
            hover,
            arrive: self.glass.arrive,
            waiting: self.glass.waiting,
        };
        let mut inner = sea.0.inner.borrow_mut();
        // Glass the sea has not seen like this yet needs the sea to draw
        // again.
        if !inner.shapes.contains(&shape) {
            window.request_animation_frame();
        }
        inner.next_shapes.push(shape);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
    }
}
