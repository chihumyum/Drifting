//! Opt-in bounded selects let v3's author-sized inventories reach their end.
use dr_ui::{
    components::{Choice, Dialog, Select},
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
                    .map(|n| Choice::plain(format!("Choice {n}")))
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

struct DialogHost {
    chosen: Rc<Cell<Option<usize>>>,
    dismissed: Rc<Cell<bool>>,
}
impl Render for DialogHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let chosen = self.chosen.clone();
        let dismissed = self.dismissed.clone();
        div().size_full().child(
            Dialog::new("dlg", "Modal")
                .on_close(move |_, _| dismissed.set(true))
                .body(
                    Select::new(
                        "in-dlg",
                        (0..8).map(|n| Choice::plain(format!("Row {n}"))).collect(),
                        0,
                    )
                    .in_dialog()
                    .max_menu_height(260.0)
                    .on_change(move |i, _, _| chosen.set(Some(i))),
                ),
        )
    }
}

#[gpui::test]
fn in_dialog_select_floats_above_dialog_and_mist(cx: &mut TestAppContext) {
    let chosen = Rc::new(Cell::new(None));
    let dismissed = Rc::new(Cell::new(false));
    let (res, closed) = (chosen.clone(), dismissed.clone());
    let (_, cx) = cx.add_window_view(move |_, _| DialogHost { chosen, dismissed });
    cx.simulate_resize(size(px(800.), px(600.)));
    for _ in 0..3 {
        draw(cx);
    }
    let trigger = cx.debug_bounds("in-dlg").unwrap();
    cx.simulate_click(trigger.center(), Modifiers::default());
    for _ in 0..3 {
        draw(cx);
    }
    // Click near the bottom of the open choice list (past the compact dialog card, over mist).
    let list = cx.debug_bounds("select-choice-scroll").unwrap();
    cx.simulate_click(
        point(list.center().x, list.bottom() - px(18.)),
        Modifiers::default(),
    );
    draw(cx);
    assert_eq!(res.get(), Some(7));
    assert!(!closed.get(), "clicking a choice must not trigger on_mist");
}

/// A field's values and a template's levels are words, not things: their
/// trigger draws the name and the one fold at its end, no mark before it
/// (it used to draw a chevron there too, so the trigger read "v Alias v").
struct MarkHost;
impl Render for MarkHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .child(Select::new(
                "words",
                vec![Choice::plain("Alias"), Choice::plain("Long text")],
                0,
            ))
            .child(Select::new(
                "things",
                vec![Choice::new(Icon::Layers, "Chapter")],
                0,
            ))
    }
}

#[gpui::test]
fn plain_choices_draw_no_mark_before_the_name(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| MarkHost);
    cx.simulate_resize(size(px(600.), px(400.)));
    draw(cx);
    assert!(cx.debug_bounds("words").is_some());
    assert!(cx.debug_bounds("words-mark").is_none());
    assert!(cx.debug_bounds("things-mark").is_some());
}
