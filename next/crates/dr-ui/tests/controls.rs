//! The value controls under GPUI's test platform: Panel Tabs report a click
//! on the open tab, the number slider follows the hand and the keys, the
//! number field previews and settles what is typed, and pills are dragged
//! onto one another.

use std::{cell::RefCell, rc::Rc};

use dr_ui::{
    components::{
        NumberField, Pill, PillGroup, Range, Segmented,
        range::{WIDTH, knob_x},
    },
    tokens::motion,
};
use gpui::{
    Context, IntoElement, Modifiers, MouseButton, ParentElement as _, Render, Styled as _,
    TestAppContext, VisualTestContext, Window, div, point, px,
};

fn frame(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

type Heard = Rc<RefCell<Vec<String>>>;

// ── Panel Tabs ───────────────────────────────────────────────────────────

struct Tabs {
    selected: usize,
    report: bool,
    heard: Heard,
}

impl Render for Tabs {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let heard = self.heard.clone();
        let me = cx.entity();
        let tabs = Segmented::new("tabs", ["章节", "要素", "构想"], self.selected)
            .motion(motion::PUSH)
            .on_change(move |i, _, cx| {
                heard.borrow_mut().push(format!("tab {i}"));
                me.update(cx, |t, cx| {
                    t.selected = i;
                    cx.notify();
                });
            });
        div().size_full().child(if self.report {
            tabs.report_selected()
        } else {
            tabs
        })
    }
}

/// Inside the first tab: tabs are laid out from x = 0, each its word and
/// 10px either side.
const FIRST_TAB: (f32, f32) = (14.0, 10.0);

#[gpui::test]
fn the_open_tab_reports_its_click_only_when_asked(cx: &mut TestAppContext) {
    for report in [false, true] {
        let heard: Heard = Rc::default();
        let h = heard.clone();
        let (_, cx) = cx.add_window_view(move |_, _| Tabs {
            selected: 0,
            report,
            heard: h,
        });
        frame(cx);
        cx.simulate_click(
            point(px(FIRST_TAB.0), px(FIRST_TAB.1)),
            Modifiers::default(),
        );
        frame(cx);
        let expected: Vec<String> = if report { vec!["tab 0".into()] } else { vec![] };
        assert_eq!(*heard.borrow(), expected, "report_selected = {report}");
    }
}

// ── Number slider and field ─────────────────────────────────────────────

struct Numbers {
    value: f64,
    heard: Heard,
}

impl Render for Numbers {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (a, b) = (cx.entity(), cx.entity());
        let (ha, hb) = (self.heard.clone(), self.heard.clone());
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(
                Range::new("size", self.value, 12.0, 28.0)
                    .label("字号")
                    .on_change(move |v, _, cx| {
                        ha.borrow_mut().push(format!("range {v}"));
                        a.update(cx, |n, cx| {
                            n.value = v;
                            cx.notify();
                        });
                    }),
            )
            .child(
                NumberField::new("size-number", self.value, 12.0, 28.0)
                    .unit("px")
                    .on_change(move |v, _, cx| {
                        hb.borrow_mut().push(format!("field {v}"));
                        b.update(cx, |n, cx| {
                            n.value = v;
                            cx.notify();
                        });
                    }),
            )
    }
}

fn numbers(cx: &mut TestAppContext) -> (gpui::Entity<Numbers>, Heard, &mut VisualTestContext) {
    cx.update(|cx| cx.bind_keys(dr_ui::input::field::bindings()));
    let heard: Heard = Rc::default();
    let h = heard.clone();
    let (view, cx) = cx.add_window_view(move |_, _| Numbers {
        value: 17.0,
        heard: h,
    });
    cx.update(|window, _| window.activate_window());
    frame(cx);
    (view, heard, cx)
}

#[gpui::test]
fn the_slider_jumps_to_the_hand_follows_it_and_steps_with_keys(cx: &mut TestAppContext) {
    let (view, heard, cx) = numbers(cx);
    let mid = |t: f32| point(px(knob_x(t, WIDTH)), px(11.0));
    // Press three quarters along: 12 + 16 × 0.75 = 24.
    cx.simulate_mouse_down(mid(0.75), MouseButton::Left, Modifiers::default());
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 24.0);
    // Drag past the end: it stays on the last value.
    cx.simulate_mouse_move(
        point(px(WIDTH + 40.0), px(11.0)),
        MouseButton::Left,
        Modifiers::default(),
    );
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 28.0);
    cx.simulate_mouse_move(mid(0.0), MouseButton::Left, Modifiers::default());
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 12.0);
    cx.simulate_mouse_up(mid(0.0), MouseButton::Left, Modifiers::default());
    frame(cx);
    // After letting go, moving the pointer changes nothing.
    cx.simulate_mouse_move(mid(0.5), None, Modifiers::default());
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 12.0);
    // The press gave it the keyboard: the arrows step it, End ends it.
    cx.simulate_keystrokes("right");
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 13.0);
    cx.simulate_keystrokes("end");
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 28.0);
    cx.simulate_keystrokes("right");
    frame(cx);
    assert_eq!(
        heard.borrow().last().map(String::as_str),
        Some("range 28"),
        "a step past the end is not a change"
    );
}

#[gpui::test]
fn typing_previews_numbers_in_range_and_enter_settles(cx: &mut TestAppContext) {
    let (view, heard, cx) = numbers(cx);
    // Click into the field, under the 22px slider.
    cx.simulate_click(point(px(30.0), px(34.0)), Modifiers::default());
    frame(cx);
    assert!(cx.update(|window, cx| window.focused(cx).is_some()));
    let typed = |cx: &mut VisualTestContext, text: &str| {
        let all = if cfg!(target_os = "macos") {
            "cmd-a"
        } else {
            "ctrl-a"
        };
        cx.simulate_keystrokes(all);
        cx.simulate_input(text);
        frame(cx);
    };
    // "2" is not yet a size (half of 24): nothing moves.
    typed(cx, "2");
    assert_eq!(view.read_with(cx, |n, _| n.value), 17.0);
    cx.simulate_input("4");
    frame(cx);
    assert_eq!(
        view.read_with(cx, |n, _| n.value),
        24.0,
        "{:?}",
        heard.borrow()
    );
    // Out of range: no preview, Enter brings it to the end.
    typed(cx, "40");
    assert_eq!(view.read_with(cx, |n, _| n.value), 24.0);
    cx.simulate_keystrokes("enter");
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 28.0);
    // Up and Down step it by one.
    cx.simulate_keystrokes("down");
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 27.0);
    // Rubbish, then leaving the field: the value stays and the text with it.
    typed(cx, "abc");
    cx.update(|window, cx| window.blur(cx));
    frame(cx);
    assert_eq!(view.read_with(cx, |n, _| n.value), 27.0);
}

// ── Pills ─────────────────────────────────────────────────────────────────

/// Pills of fixed width (60px of content, 10px padding each side) so the
/// test knows where each one is: pill `i` spans 84 i .. 84 i + 80.
struct Pills {
    order: Vec<&'static str>,
    selected: usize,
    drops: Heard,
}

struct PillDrag(usize);

impl Render for Pills {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let drops = self.drops.clone();
        let pills = self
            .order
            .iter()
            .map(|name| {
                Pill::new(*name).content(|_, _| div().w(px(60.0)).h(px(20.0)).into_any_element())
            })
            .collect();
        div()
            .size_full()
            .child(PillGroup::new("pills", pills, self.selected).draggable(
                PillDrag,
                move |drag: &PillDrag, to, _, cx| {
                    drops.borrow_mut().push(format!("{} -> {to}", drag.0));
                    me.update(cx, |p, cx| {
                        let name = p.order.remove(drag.0);
                        p.order.insert(to, name);
                        cx.notify();
                    });
                },
            ))
    }
}

fn pill_at(i: usize) -> gpui::Point<gpui::Pixels> {
    point(px(84.0 * i as f32 + 40.0), px(14.0))
}

#[gpui::test]
fn a_pill_dropped_on_another_takes_its_place(cx: &mut TestAppContext) {
    let drops: Heard = Rc::default();
    let d = drops.clone();
    let (view, cx) = cx.add_window_view(move |_, _| Pills {
        order: vec!["一", "二", "三", "四"],
        selected: 0,
        drops: d,
    });
    frame(cx);
    cx.simulate_mouse_down(pill_at(0), MouseButton::Left, Modifiers::default());
    for x in [10.0, 60.0, 120.0, 180.0] {
        cx.simulate_mouse_move(
            point(px(40.0 + x), px(14.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        frame(cx);
    }
    cx.simulate_mouse_move(pill_at(2), MouseButton::Left, Modifiers::default());
    frame(cx);
    cx.simulate_mouse_up(pill_at(2), MouseButton::Left, Modifiers::default());
    frame(cx);
    assert_eq!(*drops.borrow(), vec!["0 -> 2".to_string()]);
    assert_eq!(
        view.read_with(cx, |p, _| p.order.clone()),
        vec!["二", "三", "一", "四"]
    );
}
