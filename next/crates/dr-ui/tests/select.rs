//! Opt-in bounded selects let v3's author-sized inventories reach their end.
use dr_ui::{
    components::{Choice, Select},
    sand::Icon,
};
use gpui::{
    Context, IntoElement, Modifiers, ParentElement as _, Render, ScrollDelta, ScrollEvent,
    Styled as _, TestAppContext, VisualTestContext, Window, div, point, px, size,
};
use std::{cell::Cell, rc::Rc};
struct Host {
    chosen: Rc<Cell<Option<usize>>>,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let chosen = self.chosen.clone();
        div().size_full().child(
            Select::new(
                "many",
                (0..100)
                    .map(|n| Choice::new(Icon::ChevronRight, format!("Choice {n}")))
                    .collect(),
                0,
            )
            .force_open(true)
            .max_menu_height(180.0)
            .on_change(move |i, _, _| chosen.set(Some(i))),
        )
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
}
#[gpui::test]
fn bounded_menu_scrolls_to_the_last_choice(cx: &mut TestAppContext) {
    let chosen = Rc::new(Cell::new(None));
    let result = chosen.clone();
    let (_, cx) = cx.add_window_view(move |_, _| Host { chosen });
    cx.simulate_resize(size(px(600.), px(500.)));
    for _ in 0..3 {
        draw(cx);
    }
    let bounds = cx.debug_bounds("select-choice-scroll").unwrap();
    assert!(bounds.size.height <= px(180.));
    assert!(bounds.bottom() <= px(500.));
    cx.simulate_mouse_move(bounds.center(), None, Modifiers::default());
    cx.simulate_event(ScrollEvent {
        position: bounds.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-20_000.))),
        ..Default::default()
    });
    draw(cx);
    cx.simulate_click(
        point(bounds.center().x, bounds.bottom() - px(24.)),
        Modifiers::default(),
    );
    draw(cx);
    assert_eq!(result.get(), Some(99));
}
