//! Interface text under GPUI's test platform, whose stand-in font gives
//! every character the same advance (6px at 10px): rows break by the
//! Chinese rules, and clamps and nowrap come from the parent's style.

use dr_ui::text::wrapped;
use gpui::{
    Context, InteractiveElement as _, IntoElement, ParentElement as _, Render, Styled as _,
    TestAppContext, Window, div, px,
};

/// Ten characters to a row, 20px a row.
fn column(name: &'static str) -> gpui::Div {
    div()
        .w(px(60.0))
        .text_size(px(10.0))
        .line_height(px(20.0))
        .debug_selector(move || name.into())
}

struct Host;

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_start()
            // Eleven characters, the last a comma: it hangs on the row
            // rather than starting a second one alone.
            .child(column("comma").child(wrapped("一二三四五六七八九十，")))
            .child(column("plain").child(wrapped("一二三四五六七八九十甲")))
            .child(column("clamp").child(wrapped("一二三四五六七八九十".repeat(4)).max_lines(2)))
            .child(
                column("styled")
                    .line_clamp(3)
                    .text_ellipsis()
                    .child(wrapped("一二三四五六七八九十".repeat(5))),
            )
            .child(
                column("nowrap")
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(wrapped("一二三四五六七八九十".repeat(3))),
            )
            .child(column("paragraphs").child(wrapped("一\n二\n三")))
    }
}

#[gpui::test]
fn rows_break_by_the_chinese_rules(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Host);
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let mut height = |name: &'static str| f32::from(cx.debug_bounds(name).expect(name).size.height);
    assert_eq!(height("comma"), 20.0, "the comma hangs");
    assert_eq!(height("plain"), 40.0, "an ideograph moves down");
    assert_eq!(height("clamp"), 40.0);
    assert_eq!(height("styled"), 60.0);
    assert_eq!(height("nowrap"), 20.0);
    assert_eq!(height("paragraphs"), 60.0);
}
