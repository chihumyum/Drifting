//! What a dialog opens is painted over the dialog. GPUI hit-tests a float
//! opened inside a dialog as if it were on top whatever its layer (nested
//! floats are laid out after their parent), but paints every float in
//! layer order: a menu on the popover layer is drawn under the dialog's
//! card and mist, so it can be clicked yet cannot be seen. Paint order is
//! what these tests watch.

use std::{cell::RefCell, rc::Rc};

use dr_ui::components::{
    Choice, Dialog, Select,
    overlay::{self, Layer, Place},
};
use dr_ui::sand::Icon;
use gpui::{
    AnyElement, Context, IntoElement, ParentElement as _, Render, Styled as _, TestAppContext,
    Window, canvas, div, point, px, size,
};

type Order = Rc<RefCell<Vec<&'static str>>>;

/// Paints nothing; notes when it is painted.
fn probe(name: &'static str, order: Order) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |_, _, _, _| order.borrow_mut().push(name),
    )
    .size(px(10.0))
}

struct Host {
    order: Order,
    in_dialog: bool,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let menu = div().child(probe("menu", self.order.clone()));
        let at = Place::Point(point(px(20.0), px(20.0)));
        let floated: AnyElement = if self.in_dialog {
            overlay::float_in_dialog(at, menu).into_any_element()
        } else {
            overlay::float(at, Layer::Popover, menu).into_any_element()
        };
        div().size_full().child(
            Dialog::new("dlg", "Modal").body(
                div()
                    .child(probe("dialog", self.order.clone()))
                    .child(floated),
            ),
        )
    }
}

fn painted(cx: &mut TestAppContext, in_dialog: bool) -> Vec<&'static str> {
    let order: Order = Rc::default();
    let seen = order.clone();
    let (_, cx) = cx.add_window_view(move |_, _| Host {
        order: seen,
        in_dialog,
    });
    cx.simulate_resize(size(px(800.0), px(600.0)));
    cx.run_until_parked();
    order.borrow_mut().clear();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    order.take()
}

#[gpui::test]
fn a_float_a_dialog_opens_is_painted_over_the_dialog(cx: &mut TestAppContext) {
    assert_eq!(painted(cx, true), ["dialog", "menu"]);
}

#[gpui::test]
fn on_the_popover_layer_it_would_be_painted_under_the_dialog(cx: &mut TestAppContext) {
    assert_eq!(painted(cx, false), ["menu", "dialog"]);
}

#[gpui::test]
fn select_in_dialog_marks_itself(_cx: &mut TestAppContext) {
    let choices = || vec![Choice::new(Icon::ChevronRight, "A")];
    assert!(Select::new("s", choices(), 0).in_dialog().is_in_dialog());
    assert!(!Select::new("s", choices(), 0).is_in_dialog());
}
