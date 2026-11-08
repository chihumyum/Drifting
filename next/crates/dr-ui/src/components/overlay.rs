//! Things that float above everything (surfaces.md, 「Floating layers」).
//!
//! There is one floating layer and one way to place things on it. Menus,
//! hover cards, dropdown lists, cards that open from a canvas, dialogs and
//! notices all go through [`float`] with a [`Place`]:
//!
//! - [`Place::Rect`]: beside a rectangle (a trigger, the thing a hover card
//!   belongs to): below it, aligned to its start, centre or end; above it
//!   when there is no room below.
//! - [`Place::Point`]: at a point (a double-click on the canvas, a timeline
//!   position): its top-left there, flipping left or up at the window's edge.
//! - [`Place::Center`]: centred in the window (dialogs, global search).
//!
//! Whatever the place, it is kept 8px inside the window. GPUI's `deferred`
//! paints the layer after the whole window (what the renderer's portal to
//! `body` with `position: fixed` did); [`Layer`] keeps popovers under
//! dialogs and notices over both. The placement itself is the pure function
//! [`place`]. There is no custom context menu, so nothing here opens on a
//! right click.
//!
//! - [`Dialog`]: another slab lifted off the desk, the menu shell's square
//!   form: the desk's opaque colour, square corners, a 0.5px ink hairline and
//!   the floating shadow, no glass. Behind it the window is not darkened,
//!   only veiled by a mist of the desk's own colour.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Display, ElementId, Entity, GlobalElementId, InspectorElementId,
    InteractiveElement, IntoElement, LayoutId, ParentElement, Pixels, Point, Position, RenderOnce,
    SharedString, Size, Style, Styled, Window, canvas, deferred, div, point,
    prelude::FluentBuilder as _, px,
};
use smallvec::SmallVec;

use crate::{
    fonts::{Role, weight},
    glass::{self, Ground},
    sand::Icon,
    style::DrStyled,
    theme::Theme,
    tokens::space,
};

use super::{button::PanelIconButton, menu::float_shadow};

/// How far floating things stay inside the window.
pub const MARGIN: f32 = 8.0;

/// Which floating things cover which.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Layer {
    /// Menus, hover cards, dropdown lists, canvas cards.
    #[default]
    Popover,
    /// Dialogs and global search.
    Dialog,
    /// Notices.
    Notice,
}

impl Layer {
    const fn priority(self) -> usize {
        match self {
            Layer::Popover => 100,
            Layer::Dialog => 200,
            Layer::Notice => 300,
        }
    }
}

/// Where along a rectangle's edge a floating thing lines up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Align {
    #[default]
    Start,
    Center,
    End,
}

/// Where a floating thing goes, in window coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Place {
    /// Below `rect` (above it when there is no room below), `gap` px away.
    Rect {
        rect: Bounds<Pixels>,
        align: Align,
        gap: f32,
    },
    /// Beside `rect`, its top level with `rect`'s, `gap` px away: on the
    /// right, or on the left when it does not fit on the right and the left
    /// has more room (the 0.1 client's `right-start`).
    Beside { rect: Bounds<Pixels>, gap: f32 },
    /// Its top-left at a point; flips left or up at the window's edges.
    Point(Point<Pixels>),
    /// Centred in the window.
    Center,
}

impl Place {
    /// Below `rect`, aligned to its start, `gap` px away.
    pub fn below(rect: Bounds<Pixels>, gap: f32) -> Place {
        Place::Rect {
            rect,
            align: Align::Start,
            gap,
        }
    }
}

/// The top-left corner of something `content` big placed at `place` in a
/// window `window` big. The one placement rule every floating thing uses.
pub fn place(place: Place, content: Size<Pixels>, window: Size<Pixels>) -> Point<Pixels> {
    let (w, h) = (f32::from(content.width), f32::from(content.height));
    let (ww, wh) = (f32::from(window.width), f32::from(window.height));
    let clamp = |v: f32, len: f32, total: f32| {
        let max = total - MARGIN - len;
        if max < MARGIN {
            MARGIN
        } else {
            v.clamp(MARGIN, max)
        }
    };
    let (x, y) = match place {
        Place::Center => ((ww - w) / 2.0, (wh - h) / 2.0),
        Place::Point(p) => {
            let (px_, py_) = (f32::from(p.x), f32::from(p.y));
            let x = if px_ + w > ww - MARGIN && px_ - w >= MARGIN {
                px_ - w
            } else {
                px_
            };
            let y = if py_ + h > wh - MARGIN && py_ - h >= MARGIN {
                py_ - h
            } else {
                py_
            };
            (clamp(x, w, ww), clamp(y, h, wh))
        }
        Place::Rect { rect, align, gap } => {
            let (left, right) = (f32::from(rect.left()), f32::from(rect.right()));
            let (top, bottom) = (f32::from(rect.top()), f32::from(rect.bottom()));
            let x = match align {
                Align::Start => left,
                Align::Center => (left + right - w) / 2.0,
                Align::End => right - w,
            };
            let below = bottom + gap;
            let above = top - gap - h;
            let y = if below + h > wh - MARGIN && above >= MARGIN {
                above
            } else {
                below
            };
            (clamp(x, w, ww), clamp(y, h, wh))
        }
        Place::Beside { rect, gap } => {
            let (left, right) = (f32::from(rect.left()), f32::from(rect.right()));
            let room_right = ww - MARGIN - right - gap;
            let room_left = left - MARGIN - gap;
            let x = if w > room_right && room_left > room_right {
                left - gap - w
            } else {
                right + gap
            };
            (clamp(x, w, ww), clamp(f32::from(rect.top()), h, wh))
        }
    };
    point(px(x.round()), px(y.round()))
}

/// Floats `child` at `place` on `layer`, above everything else.
pub fn float(place: Place, layer: Layer, child: impl IntoElement) -> impl IntoElement {
    deferred(Overlay {
        place,
        child: Some(child.into_any_element()),
    })
    .with_priority(layer.priority())
}

/// Lays its child out at its natural size, then moves it to where [`place`]
/// puts it.
struct Overlay {
    place: Place,
    child: Option<AnyElement>,
}

impl IntoElement for Overlay {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl gpui::Element for Overlay {
    type RequestLayoutState = (AnyElement, SmallVec<[LayoutId; 1]>);
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
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut child = self.child.take().expect("laid out once");
        let child_id = child.request_layout(window, cx);
        let style = Style {
            position: Position::Absolute,
            display: Display::Flex,
            ..Style::default()
        };
        let ids: SmallVec<[LayoutId; 1]> = SmallVec::from_elem(child_id, 1);
        let layout = window.request_layout(style, ids.iter().copied(), cx);
        (layout, (child, ids))
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let content = window.layout_bounds(state.1[0]).size;
        let at = place(self.place, content, window.viewport_size());
        let offset = at - bounds.origin;
        window.with_element_offset(offset, |window| state.0.prepaint(window, cx));
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        state.0.paint(window, cx);
    }
}

/// Records the bounds it is laid out at into `cell` during prepaint: place
/// it inside a trigger to know where to float its menu.
pub fn probe(cell: Entity<Option<Bounds<Pixels>>>) -> impl IntoElement {
    canvas(
        move |bounds, _, cx| {
            cell.update(cx, |b, _| *b = Some(bounds));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The keyed bounds cell of a trigger.
pub fn use_bounds(
    id: impl Into<ElementId>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Option<Bounds<Pixels>>> {
    window.use_keyed_state(id, cx, |_, _| None)
}

#[derive(IntoElement)]
pub struct Dialog {
    id: ElementId,
    title: SharedString,
    eyebrow: Option<SharedString>,
    subtitle: Option<SharedString>,
    body: Vec<AnyElement>,
    actions: Vec<AnyElement>,
    status: Option<AnyElement>,
    width: f32,
    on_close: Option<super::Handler>,
    on_mist: Option<super::Handler>,
}

impl Dialog {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Dialog {
        Dialog {
            id: id.into(),
            title: title.into(),
            eyebrow: None,
            subtitle: None,
            body: Vec::new(),
            actions: Vec::new(),
            status: None,
            width: 420.0,
            on_close: None,
            on_mist: None,
        }
    }

    /// The small title above the title, in index type.
    pub fn eyebrow(mut self, text: impl Into<SharedString>) -> Self {
        self.eyebrow = Some(text.into());
        self
    }

    pub fn subtitle(mut self, text: impl Into<SharedString>) -> Self {
        self.subtitle = Some(text.into());
        self
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    pub fn body(mut self, child: impl IntoElement) -> Self {
        self.body.push(child.into_any_element());
        self
    }

    /// Actions sit on the right, the primary one last.
    pub fn action(mut self, child: impl IntoElement) -> Self {
        self.actions.push(child.into_any_element());
        self
    }

    /// A result or progress, left of the actions.
    pub fn status(mut self, child: impl IntoElement) -> Self {
        self.status = Some(child.into_any_element());
        self
    }

    /// The ✕ in the corner, which shows only with this. A click on the
    /// mist around the card does the same unless [`Dialog::on_mist`] says
    /// otherwise.
    pub fn on_close(mut self, f: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(f));
        self
    }

    /// A click on the mist around the card, apart from the ✕ (a dialog
    /// holding half-written words closes there only when nothing would be
    /// lost: 0.1's `closeOnBackdrop`). `|_, _| {}` keeps the mist inert.
    pub fn on_mist(mut self, f: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_mist = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for Dialog {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let viewport = window.viewport_size();
        let close = self.on_close.clone();
        let mist = self.on_mist.clone().or_else(|| close.clone());
        let card = div()
            .id(self.id.clone())
            .w(px(self.width))
            .max_w(viewport.width - px(32.0))
            .bg(p.desk.solid())
            .border(px(0.5))
            .border_color(p.hairline())
            .shadow(float_shadow(p))
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .p(px(space::S8))
            .flex()
            .flex_col()
            .gap(px(space::S5))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(space::S3))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .when_some(self.eyebrow, |el, e| {
                                el.child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(3).solid())
                                        .child(e),
                                )
                            })
                            .child(
                                div()
                                    .font_role(Role::Ui)
                                    .type_px(s.dialog_title, s.dialog_title + 6.0)
                                    .weight(weight::SEMIBOLD)
                                    .text_color(p.ink(1).solid())
                                    .child(self.title),
                            )
                            .when_some(self.subtitle, |el, t| {
                                el.child(
                                    div()
                                        .font_role(Role::Ui)
                                        .type_px(s.secondary, s.line_body)
                                        .text_color(p.muted().solid())
                                        .child(crate::text::wrapped(t)),
                                )
                            }),
                    )
                    .when_some(close.clone(), |el, f| {
                        el.child(
                            PanelIconButton::new(
                                crate::style::child_id(&self.id.clone(), "close"),
                                Icon::Close,
                            )
                            .on_click(move |_, w, cx| f(w, cx)),
                        )
                    }),
            )
            .when(!self.body.is_empty(), |el| {
                el.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(space::S4))
                        .font_role(Role::Ui)
                        .type_px(s.body, s.line_body)
                        .text_color(p.ink(2).solid())
                        .children(self.body),
                )
            })
            .when(!self.actions.is_empty() || self.status.is_some(), |el| {
                el.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(space::S3))
                        .child(div().flex_1().children(self.status))
                        .children(self.actions),
                )
            });
        float(
            Place::Center,
            Layer::Dialog,
            glass::surface(
                Ground::flat(p.desk),
                div()
                    .id(crate::style::child_id(&self.id, "mist"))
                    .w(viewport.width)
                    .h(viewport.height)
                    .bg(p.desk.alpha(p.dialog_mist))
                    .occlude()
                    .flex()
                    .items_center()
                    .justify_center()
                    .when_some(mist, |el, f| {
                        el.on_mouse_down(gpui::MouseButton::Left, move |_, w, cx| f(w, cx))
                    })
                    .child(card),
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::size;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        Bounds::new(point(px(x), px(y)), size(px(w), px(h)))
    }

    const WINDOW: Size<Pixels> = Size {
        width: px(1000.0),
        height: px(700.0),
    };

    #[test]
    fn a_menu_goes_below_its_trigger_aligned_to_its_start() {
        let at = place(
            Place::below(rect(100.0, 50.0, 80.0, 30.0), 4.0),
            size(px(240.0), px(200.0)),
            WINDOW,
        );
        assert_eq!(at, point(px(100.0), px(84.0)));
    }

    #[test]
    fn without_room_below_it_goes_above() {
        let at = place(
            Place::below(rect(100.0, 600.0, 80.0, 30.0), 4.0),
            size(px(240.0), px(200.0)),
            WINDOW,
        );
        assert_eq!(at, point(px(100.0), px(396.0)));
    }

    #[test]
    fn it_stays_eight_pixels_inside_the_window() {
        let at = place(
            Place::below(rect(900.0, 50.0, 80.0, 30.0), 4.0),
            size(px(240.0), px(200.0)),
            WINDOW,
        );
        assert_eq!(at.x, px(1000.0 - 8.0 - 240.0));
        let end = place(
            Place::Rect {
                rect: rect(100.0, 50.0, 80.0, 30.0),
                align: Align::End,
                gap: 4.0,
            },
            size(px(240.0), px(200.0)),
            WINDOW,
        );
        assert_eq!(end.x, px(8.0));
    }

    #[test]
    fn at_a_point_it_flips_at_the_edges() {
        let at = place(
            Place::Point(point(px(950.0), px(650.0))),
            size(px(200.0), px(100.0)),
            WINDOW,
        );
        assert_eq!(at, point(px(750.0), px(550.0)));
        let at = place(
            Place::Point(point(px(20.0), px(30.0))),
            size(px(200.0), px(100.0)),
            WINDOW,
        );
        assert_eq!(at, point(px(20.0), px(30.0)));
    }

    #[test]
    fn beside_goes_right_or_flips_left_top_aligned() {
        // Room on the right: right of it, tops level.
        let at = place(
            Place::Beside {
                rect: rect(100.0, 120.0, 200.0, 60.0),
                gap: 8.0,
            },
            size(px(248.0), px(200.0)),
            WINDOW,
        );
        assert_eq!(at, point(px(308.0), px(120.0)));
        // A card in the right column: no room right, more on the left.
        let at = place(
            Place::Beside {
                rect: rect(700.0, 120.0, 280.0, 60.0),
                gap: 8.0,
            },
            size(px(248.0), px(200.0)),
            WINDOW,
        );
        assert_eq!(at, point(px(700.0 - 8.0 - 248.0), px(120.0)));
        // Low in the window: lifted to stay inside.
        let at = place(
            Place::Beside {
                rect: rect(100.0, 650.0, 200.0, 40.0),
                gap: 8.0,
            },
            size(px(248.0), px(200.0)),
            WINDOW,
        );
        assert_eq!(at.y, px(700.0 - 8.0 - 200.0));
    }

    #[test]
    fn centred_and_too_big_both_land_inside() {
        let at = place(Place::Center, size(px(400.0), px(300.0)), WINDOW);
        assert_eq!(at, point(px(300.0), px(200.0)));
        // A full-window mist sits at the origin.
        assert_eq!(
            place(Place::Center, WINDOW, WINDOW),
            point(px(0.0), px(0.0))
        );
    }
}
