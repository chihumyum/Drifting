//! A gpui-prose editor in a window: a few paragraphs to type into.
//!
//! The standalone demo: the editor on its own in-memory Loro document
//! (`LoroSource`), using no `dr-*` crate. The benchmarks run the editor on
//! Drifting's storage and live in dr-editor (`prose-bench`, `editor-bench`,
//! `book-bench`).
//!
//! ```text
//! cargo run -p gpui-prose --example editor
//! PROSE_IME_LOG=1 cargo run -p gpui-prose --example editor   # every input-method call
//! ```
//!
//! ⌘B / ⌘I / ⌘U / ⌘⇧X toggle bold, italic, underline and strikethrough;
//! ⌘1–⌘3 make H1–H3, ⌘0 body text; ⌥←/⌥→ move by word (Chinese words from
//! ICU's dictionary); double click selects a word; ⌘Z / ⌘⇧Z undo and redo
//! (on Windows: Ctrl for ⌘, Ctrl+←/→ by word). ⌘Q / Ctrl+Q quits.
//!
//! The strip at the bottom is a second, one-line editor: somewhere else for
//! the focus to go, for trying what a half-typed composition does when the
//! author clicks away (the manual tests in
//! `docs/rust-rewrite/foundations/f4c-input.md`).

use gpui::{
    App, AppContext, Bounds, Entity, Focusable, KeyBinding, Render, Window, WindowBounds,
    WindowOptions, actions, div, prelude::*, px, rgb, size,
};
use gpui_prose::{BlockKind, Book, Chapter, EditorOptions, ProseDoc, ProseEditor, ProseStyle};

actions!(prose_example, [Quit]);

struct Demo {
    editor: Entity<ProseEditor>,
    other: Entity<ProseEditor>,
}

impl Render for Demo {
    fn render(&mut self, _window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .child(ProseEditor::element(&self.editor, cx)),
            )
            .child(
                div()
                    .h(px(64.))
                    .border_t_1()
                    .border_color(rgb(0xd0d0d0))
                    .child(ProseEditor::element(&self.other, cx)),
            )
    }
}

/// `PROSE_IME_LOG=1` prints every input-method call to stderr.
fn options() -> EditorOptions {
    EditorOptions {
        ime_log: std::env::var_os("PROSE_IME_LOG").is_some(),
        ..EditorOptions::default()
    }
}

fn main() {
    gpui_platform::application().run(|cx: &mut App| {
        let quit = if cfg!(target_os = "macos") {
            "cmd-q"
        } else {
            "ctrl-q"
        };
        cx.bind_keys([KeyBinding::new(quit, Quit, None)]);
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
                let editor = cx.new(|cx| {
                    ProseEditor::with_options(book, ProseStyle::default(), options(), window, cx)
                });
                let other = cx.new(|cx| {
                    ProseEditor::with_options(
                        Book::new(vec![Chapter {
                            title: "另一个文字框".into(),
                            doc: ProseDoc::from_paragraphs([(
                                BlockKind::Body,
                                "另一个文字框：组字时点这里，焦点离开正文",
                            )]),
                        }]),
                        ProseStyle::default(),
                        EditorOptions {
                            fit_content: true,
                            ..options()
                        },
                        window,
                        cx,
                    )
                });
                let focus = editor.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
                cx.new(|_| Demo { editor, other })
            },
        )
        .expect("open the window");
        // Closing the window ends the demo (Windows keeps running otherwise).
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
