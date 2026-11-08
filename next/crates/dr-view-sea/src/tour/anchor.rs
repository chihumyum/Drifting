//! Anchors: the controls a tour can point at.
//!
//! A control is marked with [`anchor`]: an element that lays out, prepaints
//! and paints exactly as its child (it adds no box of its own) and, while a
//! tour runs in its window, writes down the child's window bounds when it is
//! prepainted. The tour draws in the floating layer, after the window's own
//! tree, and takes what was written in that frame: a control that was not
//! drawn this frame (a closed sidebar's tabs, a page that is not open, a
//! control scrolled out of its clip) is not on screen. The tour knows the
//! controls only by these ids, never by their types.
//!
//! Nothing here reads the shell: it can move below it unchanged (see the
//! module docs, 「Who marks what」).

use std::{cell::RefCell, collections::HashMap};

use gpui::{
    AnyElement, App, Bounds, ElementId, GlobalElementId, InspectorElementId, IntoElement, LayoutId,
    Pixels, Window, WindowId, px,
};

/// What the anchors of one window wrote since the tour last looked.
#[derive(Default)]
struct Pending {
    listening: bool,
    painted: Vec<(&'static str, Bounds<Pixels>)>,
}

thread_local! {
    // GPUI draws on one thread; like dr-ui's grounds, this needs no global
    // (a global's every write would queue an effect from inside prepaint).
    static PENDING: RefCell<HashMap<WindowId, Pending>> = RefCell::new(HashMap::new());
}

/// More bounds than this without a tour taking them means the tour stopped
/// drawing without saying so: start over rather than grow.
const MAX_PENDING: usize = 1024;

/// Whether the anchors of `window` write their bounds down (only while a
/// tour shows there, so a marked control costs nothing otherwise).
pub(crate) fn listen(window: WindowId, on: bool) {
    PENDING.with(|p| {
        let mut p = p.borrow_mut();
        let pending = p.entry(window).or_default();
        pending.listening = on;
        if !on {
            pending.painted.clear();
        }
    });
}

/// What the anchors of `window` wrote since the last call: this frame's,
/// when called from the floating layer.
pub(crate) fn take(window: WindowId) -> Shown {
    PENDING.with(|p| {
        Shown(
            p.borrow_mut()
                .get_mut(&window)
                .map(|pending| std::mem::take(&mut pending.painted))
                .unwrap_or_default(),
        )
    })
}

fn record(id: &'static str, bounds: Bounds<Pixels>, window: &Window) {
    if bounds.size.width <= px(0.0) || bounds.size.height <= px(0.0) {
        return;
    }
    // Clipped away entirely (a list scrolled past it): not on screen.
    if !window.content_mask().bounds.intersects(&bounds) {
        return;
    }
    let key = window.window_handle().window_id();
    PENDING.with(|p| {
        let mut p = p.borrow_mut();
        if let Some(pending) = p.get_mut(&key)
            && pending.listening
        {
            if pending.painted.len() >= MAX_PENDING {
                pending.painted.clear();
            }
            pending.painted.push((id, bounds));
        }
    });
}

/// The controls one frame drew, by anchor id, in the order they were drawn.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shown(Vec<(&'static str, Bounds<Pixels>)>);

impl Shown {
    /// Bounds drawn under `id`, in drawing order (several controls may share
    /// one id: every Panel Tab label of the left sidebar).
    pub fn bounds<'a>(&'a self, id: &'a str) -> impl Iterator<Item = Bounds<Pixels>> + 'a {
        self.0
            .iter()
            .filter(move |(at, _)| *at == id)
            .map(|(_, bounds)| *bounds)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Marks `child` as the control `id` for tours (one of [`super::ids`]).
/// Layout, hit testing and painting are the child's own.
pub fn anchor(id: &'static str, child: impl IntoElement) -> Anchor {
    Anchor {
        id,
        child: Some(child.into_any_element()),
    }
}

pub struct Anchor {
    id: &'static str,
    child: Option<AnyElement>,
}

impl IntoElement for Anchor {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl gpui::Element for Anchor {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

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
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self.child.take().expect("laid out once");
        (child.request_layout(window, cx), child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        record(self.id, bounds, window);
        child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        child.paint(window, cx);
    }
}
