//! Short-text interaction: candidates beyond the first screen, explicit
//! links in Unicode text, and opening a read-only link without editing its card.
use std::{cell::RefCell, rc::Rc};

use dr_ui::linked::{AtItem, Draft, Link, LinkedArea};
use gpui::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, Styled as _, TestAppContext, VisualTestContext, Window, div, point, px,
};

struct Host {
    area: Entity<LinkedArea>,
    opened: Rc<RefCell<Vec<String>>>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let opened = self.opened.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap(px(20.))
            .child(
                div()
                    .w(px(240.))
                    .text_size(px(14.))
                    .line_height(px(22.))
                    .child(self.area.clone()),
            )
            .child(
                div()
                    .debug_selector(|| "read-link".into())
                    .w(px(200.))
                    .text_size(px(14.))
                    .line_height(px(22.))
                    .child(
                        dr_ui::linked::linked(
                            "read-link-text",
                            Draft::new(
                                "甲😀乙",
                                vec![Link {
                                    range: 0..7,
                                    target: "chosen".into(),
                                }],
                            ),
                        )
                        .on_open(move |id, _, _| opened.borrow_mut().push(id.to_string())),
                    ),
            )
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

#[gpui::test]
fn the_list_scrolls_and_keyboard_selection_keeps_a_unicode_link(cx: &mut TestAppContext) {
    cx.update(|cx| {
        dr_ui::init(cx).unwrap();
    });
    let (host, cx) = cx.add_window_view(|window, cx| {
        let candidates = Rc::new(|_: &str, _: &gpui::App| {
            (0..12)
                .map(|i| AtItem {
                    target: format!("item-{i}").into(),
                    label: format!("甲😀{i}").into(),
                    detail: None,
                    mark: dr_ui::sand::Kind::Element,
                })
                .collect()
        });
        Host {
            area: cx.new(|cx| {
                LinkedArea::new(
                    "test-linked",
                    Draft::default(),
                    candidates,
                    |a| a,
                    window,
                    cx,
                )
            }),
            opened: Rc::default(),
        }
    });
    let area = host.read_with(cx, |h, _| h.area.clone());
    cx.update(|window, cx| {
        window.activate_window();
        area.update(cx, |a, cx| a.focus(window, cx));
    });
    draw(cx);
    cx.simulate_input("前 @");
    draw(cx);
    assert_eq!(area.read_with(cx, |a, _| a.at_items().len()), 12);
    for _ in 0..9 {
        cx.simulate_keystrokes("down");
    }
    draw(cx);
    let ninth = cx
        .debug_bounds("test-linked-at-9")
        .expect("the ninth choice is drawn");
    assert!(ninth.top() >= px(0.) && ninth.bottom() < px(360.));
    cx.simulate_keystrokes("enter");
    draw(cx);
    let draft = area.read_with(cx, |a, _| a.draft().clone());
    assert_eq!(draft.text, "前 甲😀9");
    assert_eq!(draft.char_links(), vec![(2, 5, "item-9".into())]);
    assert!(area.read_with(cx, |a, _| a.at_items().is_empty()));

    // The read-only segment takes its click and opens the target.
    let bounds = cx.debug_bounds("read-link").unwrap();
    cx.simulate_click(
        point(bounds.left() + px(4.), bounds.top() + px(8.)),
        gpui::Modifiers::default(),
    );
    draw(cx);
    assert_eq!(
        host.read_with(cx, |h, _| h.opened.borrow().clone()),
        ["chosen"]
    );
}
