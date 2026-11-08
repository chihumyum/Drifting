//! The colour swatch under GPUI's test platform: a click opens the picker on
//! the swatch's colour and each colour picked comes back to its owner; a
//! locked swatch opens nothing. (The system's panel is not opened here: the
//! test window has no platform handle, and the picker is the test's own.)

use std::{cell::RefCell, rc::Rc};

use dr_ui::{
    components::{ColorSwatch, color},
    tokens::color::Rgb,
};
use gpui::{
    Context, InteractiveElement as _, IntoElement, Modifiers, ParentElement as _, Render,
    Styled as _, TestAppContext, Window, div,
};

struct Host {
    color: Rgb,
    locked: bool,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        div().size_full().child(
            div().debug_selector(|| "swatch".into()).child(
                ColorSwatch::new("swatch", self.color)
                    .label("颜色")
                    .show_value()
                    .disabled(self.locked)
                    .on_pick(move |c, _, cx| {
                        me.update(cx, |h, cx| {
                            h.color = c;
                            cx.notify();
                        })
                    }),
            ),
        )
    }
}

#[gpui::test]
fn a_click_opens_the_picker_and_the_colour_comes_back(cx: &mut TestAppContext) {
    let opened: Rc<RefCell<Vec<String>>> = Rc::default();
    let seen = opened.clone();
    cx.update(|cx| {
        color::set_color_picker(cx, move |current, done, window, cx| {
            seen.borrow_mut().push(color::hex(current));
            // The author drags through two colours.
            done(Rgb::hex(0x112233), window, cx);
            done(Rgb::hex(0xcc3366), window, cx);
        })
    });
    let (host, cx) = cx.add_window_view(|_, _| Host {
        color: Rgb::hex(0x3a6f9c),
        locked: false,
    });
    cx.run_until_parked();
    let at = cx.debug_bounds("swatch").expect("drawn").origin
        + gpui::point(gpui::px(14.0), gpui::px(14.0));
    cx.simulate_click(at, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(*opened.borrow(), ["#3a6f9c"]);
    assert_eq!(host.read_with(cx, |h, _| color::hex(h.color)), "#cc3366");
    // Locked: nothing opens.
    host.update(cx, |h, cx| {
        h.locked = true;
        cx.notify();
    });
    cx.run_until_parked();
    cx.simulate_click(at, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(opened.borrow().len(), 1);
}
