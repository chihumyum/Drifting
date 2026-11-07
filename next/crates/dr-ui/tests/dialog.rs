//! The dialog shell under GPUI's test platform: the ✕ and a click on the
//! mist are two callbacks, and the mist follows the ✕ unless told
//! otherwise.

use std::{cell::RefCell, rc::Rc};

use dr_ui::components::Dialog;
use gpui::{
    Context, IntoElement, Modifiers, ParentElement as _, Render, Styled as _, TestAppContext,
    VisualTestContext, Window, div, point, px,
};

struct Host {
    log: Rc<RefCell<Vec<&'static str>>>,
    mist: bool,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let (a, b) = (self.log.clone(), self.log.clone());
        let mut dialog =
            Dialog::new("d", "删除这本书").on_close(move |_, _| a.borrow_mut().push("close"));
        if self.mist {
            dialog = dialog.on_mist(move |_, _| b.borrow_mut().push("mist"));
        }
        div().size_full().child(dialog)
    }
}

fn click(cx: &mut VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_mouse_move(at, None, Modifiers::default());
    cx.simulate_click(at, Modifiers::default());
    cx.run_until_parked();
}

/// Where the ✕ is: a dialog with only its title is 420 wide and 64 tall
/// (20 of padding around a 24px row), centred; the ✕ is the row's last 24px.
fn close_button(cx: &mut VisualTestContext) -> gpui::Point<gpui::Pixels> {
    let size = cx.update(|window, _| window.viewport_size());
    point(
        (size.width + px(420.0)) / 2.0 - px(32.0),
        (size.height - px(64.0)) / 2.0 + px(32.0),
    )
}

fn host(
    cx: &mut TestAppContext,
    mist: bool,
) -> (Rc<RefCell<Vec<&'static str>>>, &mut VisualTestContext) {
    let log = Rc::new(RefCell::new(Vec::new()));
    let seen = log.clone();
    let (_, cx) = cx.add_window_view(move |_, _| Host { log: seen, mist });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    (log, cx)
}

#[gpui::test]
fn the_mist_follows_the_close_button_by_default(cx: &mut TestAppContext) {
    let (log, cx) = host(cx, false);
    click(cx, point(px(10.0), px(10.0)));
    let at = close_button(cx);
    click(cx, at);
    assert_eq!(*log.borrow(), vec!["close", "close"]);
}

#[gpui::test]
fn the_mist_and_the_close_button_are_told_apart(cx: &mut TestAppContext) {
    let (log, cx) = host(cx, true);
    click(cx, point(px(10.0), px(10.0)));
    let at = close_button(cx);
    click(cx, at);
    // Inside the card is neither.
    click(cx, at - point(px(200.0), px(0.0)));
    assert_eq!(*log.borrow(), vec!["mist", "close"]);
}
