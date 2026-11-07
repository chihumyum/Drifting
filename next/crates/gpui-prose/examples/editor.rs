//! A gpui-prose editor in a window: a few paragraphs to type into.
//!
//! ```text
//! cargo run -p gpui-prose --example editor
//! ```
//!
//! ⌘B / ⌘I / ⌘U / ⌘⇧X toggle bold, italic, underline and strikethrough;
//! ⌘1–⌘3 make H1–H3, ⌘0 body text; ⌥←/⌥→ move by word (Chinese words from
//! ICU's dictionary); double click selects a word; ⌘Z / ⌘⇧Z undo and redo.

use gpui::{
    App, AppContext, Bounds, Entity, Focusable, KeyBinding, Render, Window, WindowBounds,
    WindowOptions, actions, div, prelude::*, px, size,
};
use gpui_prose::{BlockKind, Book, Chapter, ProseDoc, ProseEditor, ProseStyle};

actions!(prose_example, [Quit]);

struct Demo {
    editor: Entity<ProseEditor>,
}

impl Render for Demo {
    fn render(&mut self, _window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .child(ProseEditor::element(&self.editor, cx))
    }
}

fn main() {
    gpui_platform::application().run(|cx: &mut App| {
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        gpui_prose::bind_keys(cx);
        let doc = ProseDoc::from_paragraphs([
            (BlockKind::H1, "第一章　雨夜"),
            (
                BlockKind::Body,
                "天色将晚，雨还没有停。她把伞靠在门边，“你来了”这句话在嘴边转了几圈，终于没有说出口。",
            ),
            (BlockKind::H2, "A heading in English"),
            (
                BlockKind::Body,
                "Mixed text works too: words are not split across rows, and 「，」 never starts one. Emoji like 👨‍👩‍👧 and 🇨🇳 are one step for the arrow keys.",
            ),
        ]);
        let book = Book::new(vec![Chapter {
            title: "示例".into(),
            doc,
        }]);
        let bounds = Bounds::centered(None, size(px(900.), px(700.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |window, cx| {
                let editor =
                    cx.new(|cx| ProseEditor::new(book, ProseStyle::default(), window, cx));
                let focus = editor.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
                cx.new(|_| Demo { editor })
            },
        )
        .expect("open the window");
        cx.activate(true);
    });
}
