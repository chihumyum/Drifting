//! Hover cards on GPUI's simulated clock: 220ms to show, 220ms of grace
//! after leaving, closed (and not reopened by a row sliding under a still
//! pointer) when the list scrolls.

use std::{cell::Cell, rc::Rc, time::Duration};

use dr_ui::components::HoverCard;
use gpui::{
    Context, IntoElement, Modifiers, ParentElement as _, Render, ScrollDelta, ScrollEvent,
    Styled as _, TestAppContext, VisualTestContext, Window, div, point, px,
};

struct Host {
    builds: Rc<Cell<usize>>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let builds = self.builds.clone();
        div()
            .size_full()
            .child(div().w(px(120.0)).h(px(30.0)).child(HoverCard::new(
                "thing",
                div().w(px(120.0)).h(px(30.0)).child("林岚"),
                move |_, _| {
                    builds.set(builds.get() + 1);
                    div().w(px(100.0)).h(px(60.0)).into_any_element()
                },
            )))
    }
}

fn frame(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

/// Whether the card is showing: one fresh frame, did it build the card?
fn open(cx: &mut VisualTestContext, builds: &Rc<Cell<usize>>) -> bool {
    builds.set(0);
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx)
    });
    builds.get() > 0
}

fn wait(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    frame(cx);
}

#[gpui::test]
fn shows_after_the_delay_and_stays_for_the_grace(cx: &mut TestAppContext) {
    let builds = Rc::new(Cell::new(0));
    let b = builds.clone();
    let (_, cx) = cx.add_window_view(move |_, _| Host { builds: b });
    frame(cx);
    cx.simulate_mouse_move(point(px(10.0), px(10.0)), None, Modifiers::default());
    frame(cx);
    wait(cx, 200);
    assert!(!open(cx, &builds), "shown before 220ms");
    wait(cx, 30);
    assert!(open(cx, &builds), "not shown after 220ms");

    // Leave: the card stays for the grace, then goes.
    cx.simulate_mouse_move(point(px(600.0), px(500.0)), None, Modifiers::default());
    frame(cx);
    wait(cx, 200);
    assert!(open(cx, &builds), "gone before the grace ran out");
    wait(cx, 30);
    assert!(!open(cx, &builds), "still there after the grace");
}

#[gpui::test]
fn a_scroll_closes_it_and_a_still_pointer_does_not_reopen_it(cx: &mut TestAppContext) {
    let builds = Rc::new(Cell::new(0));
    let b = builds.clone();
    let (_, cx) = cx.add_window_view(move |_, _| Host { builds: b });
    frame(cx);
    cx.simulate_mouse_move(point(px(10.0), px(10.0)), None, Modifiers::default());
    frame(cx);
    wait(cx, 240);
    assert!(open(cx, &builds));

    cx.simulate_event(ScrollEvent {
        position: point(px(10.0), px(10.0)),
        delta: ScrollDelta::Pixels(point(px(0.0), px(-24.0))),
        modifiers: Modifiers::default(),
        ..ScrollEvent::default()
    });
    frame(cx);
    assert!(!open(cx, &builds), "rode along with the scroll");
    wait(cx, 400);
    assert!(
        !open(cx, &builds),
        "reopened under a pointer that never moved"
    );

    // A real move after the list has settled points at the row again.
    cx.simulate_mouse_move(point(px(12.0), px(11.0)), None, Modifiers::default());
    frame(cx);
    wait(cx, 240);
    assert!(open(cx, &builds));
}
