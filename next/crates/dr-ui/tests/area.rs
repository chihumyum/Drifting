//! The multi-line input under GPUI's test platform, whose stand-in font
//! gives every character the same advance (0.6 em: 6px at 10px), so rows
//! break at known places: it wraps to its width and grows a row at a time,
//! Up and Down keep their aim, Enter makes a paragraph or submits a title,
//! and losing focus discards the composition.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use dr_ui::input::{FieldEvent, TextArea, set_discard_marked_text};
use gpui::{
    AppContext as _, Context, Entity, EntityInputHandler, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Styled as _, TestAppContext, VisualTestContext,
    Window, div, px,
};

/// Ten characters to a row.
const WIDTH: f32 = 60.0;
const ROW: f32 = 20.0;

struct Host {
    area: Entity<TextArea>,
    events: Rc<RefCell<Vec<FieldEvent>>>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            div()
                .debug_selector(|| "area".into())
                .w(px(WIDTH))
                .text_size(px(10.0))
                .line_height(px(ROW))
                .child(self.area.clone()),
        )
    }
}

type Events = Rc<RefCell<Vec<FieldEvent>>>;

fn host(
    cx: &mut TestAppContext,
    make: impl FnOnce(TextArea) -> TextArea + 'static,
) -> (Entity<TextArea>, Events, &mut VisualTestContext) {
    cx.update(|cx| cx.bind_keys(dr_ui::input::bindings()));
    let (host, cx) = cx.add_window_view(|window, cx| {
        let area = cx.new(|cx| make(TextArea::new("area", window, cx)));
        let events = Rc::new(RefCell::new(Vec::new()));
        let sink = events.clone();
        cx.subscribe(&area, move |_, _, event: &FieldEvent, _| {
            sink.borrow_mut().push(event.clone());
        })
        .detach();
        Host { area, events }
    });
    let (area, events) = host.read_with(cx, |h, _| (h.area.clone(), h.events.clone()));
    cx.update(|window, cx| {
        window.activate_window();
        window.focus(&area.focus_handle(cx), cx);
    });
    cx.run_until_parked();
    (area, events, cx)
}

fn height(cx: &mut VisualTestContext) -> f32 {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    f32::from(cx.debug_bounds("area").expect("drawn").size.height)
}

fn type_in(area: &Entity<TextArea>, text: &str, cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        area.update(cx, |a, cx| a.replace_text_in_range(None, text, window, cx))
    });
}

fn caret(area: &Entity<TextArea>, cx: &mut VisualTestContext) -> usize {
    area.read_with(cx, |a, _| a.composer().cursor())
}

/// Byte offset of character `n` in a run of CJK characters.
fn ch(n: usize) -> usize {
    n * 3
}

#[gpui::test]
fn it_wraps_to_its_width_and_grows_a_row_at_a_time(cx: &mut TestAppContext) {
    let (area, _, cx) = host(cx, |a| a.placeholder("梗概"));
    assert_eq!(height(cx), ROW, "empty, one row (the placeholder's)");
    type_in(&area, "一二三四五六七八九十甲乙", cx);
    assert_eq!(height(cx), 2.0 * ROW);
    assert_eq!(area.read_with(cx, |a, _| a.rows()), 2);
    type_in(&area, "丙丁戊己庚辛壬癸子丑", cx);
    assert_eq!(height(cx), 3.0 * ROW);
    // A paragraph of its own starts a row.
    cx.simulate_keystrokes("enter");
    type_in(&area, "寅", cx);
    assert_eq!(height(cx), 4.0 * ROW);
    assert_eq!(
        area.read_with(cx, |a, _| a.text()),
        "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑\n寅"
    );
}

#[gpui::test]
fn punctuation_wrap_is_opt_in_and_the_caret_follows_its_rows(cx: &mut TestAppContext) {
    for wrap in [false, true] {
        let (area, _, cx) = host(cx, move |a| if wrap { a.wrap_punctuation() } else { a });
        let text = "一二三四五六七八九十！”";
        type_in(&area, text, cx);
        assert_eq!(height(cx), ROW * if wrap { 2.0 } else { 1.0 });
        assert_eq!(
            area.read_with(cx, |a, _| a.rows()),
            if wrap { 2 } else { 1 }
        );
        if wrap {
            cx.simulate_keystrokes("home");
            assert_eq!(caret(&area, cx), ch(9), "十 and both marks moved together");
            cx.simulate_keystrokes("up end");
            assert_eq!(
                caret(&area, cx),
                ch(9),
                "the first row ends at the same boundary"
            );
            cx.simulate_keystrokes("down end");
            assert_eq!(caret(&area, cx), text.len());
        }
        assert_eq!(area.read_with(cx, |a, _| a.text()), text);
    }
}

#[gpui::test]
fn up_and_down_keep_their_aim(cx: &mut TestAppContext) {
    let (area, _, cx) = host(cx, |a| {
        a.with_text("一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅")
    });
    height(cx);
    // On the eighth character of the first row; down lands under it.
    cx.update(|window, cx| area.update(cx, |a, cx| a.set_selected_text_range(8..8, window, cx)));
    cx.simulate_keystrokes("down");
    assert_eq!(caret(&area, cx), ch(18));
    // The last row is three long: the caret stops at its end …
    cx.simulate_keystrokes("down");
    assert_eq!(caret(&area, cx), ch(23));
    // … and coming back up it finds the same column again.
    cx.simulate_keystrokes("up up");
    assert_eq!(caret(&area, cx), ch(8));
    // Past the first row is the start; past the last, the end.
    cx.simulate_keystrokes("up");
    assert_eq!(caret(&area, cx), 0);
    cx.simulate_keystrokes("down down down");
    assert_eq!(caret(&area, cx), ch(23));
    // Shift selects down a row.
    cx.update(|window, cx| area.update(cx, |a, cx| a.set_selected_text_range(2..2, window, cx)));
    cx.simulate_keystrokes("shift-down");
    assert_eq!(
        area.read_with(cx, |a, _| a.composer().selection()),
        ch(2)..ch(12)
    );
}

#[gpui::test]
fn home_and_end_stay_on_the_row(cx: &mut TestAppContext) {
    let (area, _, cx) = host(cx, |a| a.with_text("一二三四五六七八九十甲乙丙"));
    height(cx);
    cx.update(|window, cx| area.update(cx, |a, cx| a.set_selected_text_range(3..3, window, cx)));
    // The end of the first row is where the second begins; the caret stays
    // on the first, and what is typed there goes before 甲.
    cx.simulate_keystrokes("end");
    assert_eq!(caret(&area, cx), ch(10));
    cx.simulate_keystrokes("up");
    assert_eq!(caret(&area, cx), 0, "it was on the first row");
    cx.simulate_keystrokes("down home");
    assert_eq!(caret(&area, cx), ch(10), "home of the second row");
    type_in(&area, "〇", cx);
    assert_eq!(
        area.read_with(cx, |a, _| a.text()),
        "一二三四五六七八九十〇甲乙丙"
    );
}

#[gpui::test]
fn enter_makes_a_paragraph(cx: &mut TestAppContext) {
    let (area, events, cx) = host(cx, |a| a.with_text("雾港"));
    cx.simulate_keystrokes("enter");
    assert_eq!(area.read_with(cx, |a, _| a.text()), "雾港\n");
    let submit = if cfg!(target_os = "macos") {
        "cmd-enter"
    } else {
        "ctrl-enter"
    };
    cx.simulate_keystrokes(submit);
    cx.simulate_keystrokes("escape");
    assert_eq!(
        *events.borrow(),
        vec![
            FieldEvent::Changed("雾港\n".into()),
            FieldEvent::Submitted("雾港\n".into()),
            FieldEvent::Cancelled,
        ]
    );
}

#[gpui::test]
fn a_title_submits_on_enter_and_never_breaks(cx: &mut TestAppContext) {
    let (area, events, cx) = host(cx, |a| a.with_text("第三章\n雾港").submit_on_enter());
    assert_eq!(area.read_with(cx, |a, _| a.text()), "第三章 雾港");
    cx.simulate_keystrokes("enter");
    assert_eq!(area.read_with(cx, |a, _| a.text()), "第三章 雾港");
    type_in(&area, "\r\n灯塔", cx);
    assert_eq!(area.read_with(cx, |a, _| a.text()), "第三章 雾港 灯塔");
    // Enter while composing chooses the candidate.
    cx.update(|window, cx| {
        area.update(cx, |a, cx| {
            a.replace_and_mark_text_in_range(None, "deng", Some(4..4), window, cx)
        })
    });
    cx.simulate_keystrokes("enter");
    assert_eq!(
        *events.borrow(),
        vec![
            FieldEvent::Submitted("第三章 雾港".into()),
            FieldEvent::Changed("第三章 雾港 灯塔".into()),
        ]
    );
}

#[gpui::test]
fn losing_focus_discards_the_composition(cx: &mut TestAppContext) {
    let discards = Rc::new(Cell::new(0));
    let count = discards.clone();
    cx.update(|cx| set_discard_marked_text(cx, move |_| count.set(count.get() + 1)));
    let (area, events, cx) = host(cx, |a| a.with_text("林"));
    cx.update(|window, cx| {
        area.update(cx, |a, cx| {
            a.replace_and_mark_text_in_range(None, "lan", Some(3..3), window, cx)
        })
    });
    assert!(area.read_with(cx, |a, _| a.is_composing()));
    cx.update(|window, cx| window.blur(cx));
    cx.run_until_parked();
    assert_eq!(area.read_with(cx, |a, _| a.text()), "林");
    assert!(!area.read_with(cx, |a, _| a.is_composing()));
    assert_eq!(discards.get(), 1);
    // The input method's late word is not taken.
    type_in(&area, "岚", cx);
    assert_eq!(area.read_with(cx, |a, _| a.text()), "林");
    assert_eq!(*events.borrow(), vec![FieldEvent::Blurred]);
}

#[gpui::test]
fn a_framed_area_is_a_slip_a_few_rows_high_that_grows(cx: &mut TestAppContext) {
    let (area, _, cx) = host(cx, |a| a.framed(3.0));
    let line = cx.update(|window, cx| dr_ui::Theme::of(window, cx).scale.line_body);
    // 8px above and below, three rows of the interface's body type.
    let empty = height(cx);
    assert_eq!(empty, 16.0 + 3.0 * line);
    // More than three rows of text: it grows with them.
    type_in(&area, &"字".repeat(200), cx);
    let full = height(cx);
    assert!(full > empty, "{full} after {empty}");
    let rows = area.read_with(cx, |a, _| a.rows()) as f32;
    assert_eq!(full, 16.0 + rows * line);
    // A press on the slip's padding puts the caret in it.
    cx.update(|window, cx| window.blur(cx));
    let origin = cx.debug_bounds("area").unwrap().origin;
    cx.simulate_click(
        origin + gpui::point(px(4.0), px(3.0)),
        gpui::Modifiers::none(),
    );
    assert!(cx.update(|window, cx| area.focus_handle(cx).is_focused(window)));
}
