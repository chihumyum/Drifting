//! The probe window: a chapter list on the left, the editor on the right and a
//! status line that shows what storage holds (to see that marked text is not
//! in it).

use std::{cell::Cell, rc::Rc, time::Instant};

use gpui::{
    App, AppContext, Bounds, Context, DisplayId, Entity, Focusable, FontWeight, KeyBinding,
    MouseButton, Render, SharedString, Window, WindowBounds, WindowHandle, WindowOptions, actions,
    div, prelude::*, px, size, uniform_list,
};
use gpui_prose::{Book, EditorOptions, ProseEditor, ProseStyle};

use crate::{
    corpus::{self, Corpus},
    platform,
};

actions!(prose_bench, [Quit]);

pub struct Root {
    pub editor: Option<Entity<ProseEditor>>,
    pub titles: Vec<SharedString>,
    /// When the current frame's render began (for frame work time).
    pub frame_start: Rc<Cell<Option<Instant>>>,
    pub sidebar: bool,
    /// Show what storage holds in the status line: a read on each document
    /// holder's thread every frame, so only the interactive window does
    /// (the measuring windows show the editor's own count).
    pub stored_len: bool,
    /// The library the documents are open on, kept as long as the window.
    pub corpus: Option<Rc<Corpus>>,
}

impl Root {
    pub fn new(titles: Vec<SharedString>, sidebar: bool) -> Root {
        Root {
            editor: None,
            titles,
            frame_start: Rc::default(),
            sidebar,
            stored_len: false,
            corpus: None,
        }
    }

    pub fn open(
        &mut self,
        book: Book,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ProseEditor> {
        let options = EditorOptions {
            present_now: platform::IMMEDIATE.load(std::sync::atomic::Ordering::Relaxed),
            cursor_blink: if platform::NO_BLINK.load(std::sync::atomic::Ordering::Relaxed) {
                None
            } else {
                EditorOptions::default().cursor_blink
            },
            ime_log: std::env::var_os("PROSE_BENCH_IME_LOG").is_some(),
            ..EditorOptions::default()
        };
        let editor = cx.new(|cx| {
            let mut editor =
                ProseEditor::with_options(book, ProseStyle::default(), options, window, cx);
            editor.set_platform_hooks(Rc::new(platform::MacHooks));
            editor
        });
        self.editor = Some(editor.clone());
        cx.notify();
        editor
    }

    fn status(&self, cx: &App) -> SharedString {
        let Some(editor) = &self.editor else {
            return "".into();
        };
        let editor = editor.read(cx);
        let sel = editor.selection();
        let chapter = &editor.book().chapters[sel.chapter];
        let held = if self.stored_len {
            corpus::stored_len(&chapter.doc).map_or_else(
                || "存储未读到".to_owned(),
                |len| format!("存储里正文 {len} 个字符"),
            )
        } else {
            format!("编辑器里正文 {} 个字符", chapter.doc.len_chars())
        };
        let comp = editor
            .composition()
            .map(|c| format!(" · 组字中「{}」（未写入存储）", c.text))
            .unwrap_or_default();
        format!(
            "{} · 光标 {}{} · 选区 {} 字 · {} · 本帧画了 {} 段{}",
            chapter.title,
            sel.head,
            if sel.is_empty() {
                ""
            } else {
                "（有选区）"
            },
            sel.range().len(),
            held,
            editor.painted_lines(),
            comp
        )
        .into()
    }
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.frame_start.set(Some(Instant::now()));
        let status = self.status(cx);
        let sidebar = self.sidebar.then(|| {
            let count = self.titles.len();
            div()
                .w(px(220.))
                .h_full()
                .flex_none()
                .bg(gpui::hsla(40. / 360., 0.2, 0.95, 1.))
                .child(
                    uniform_list(
                        "chapters",
                        count,
                        cx.processor(|this, range: std::ops::Range<usize>, _window, cx| {
                            range
                                .map(|ix| {
                                    div()
                                        .id(ix)
                                        .px(px(14.))
                                        .py(px(5.))
                                        .text_size(px(13.))
                                        .text_color(gpui::hsla(0., 0., 0.25, 1.))
                                        .hover(|style| {
                                            style.bg(gpui::hsla(40. / 360., 0.2, 0.9, 1.))
                                        })
                                        .child(this.titles[ix].clone())
                                        .on_mouse_down(
                                            MouseButton::Left,
                                            cx.listener(move |this, _, window, cx| {
                                                if let Some(editor) = &this.editor {
                                                    editor.update(cx, |editor, cx| {
                                                        editor.jump_to_chapter(ix, window, cx)
                                                    });
                                                }
                                            }),
                                        )
                                })
                                .collect()
                        }),
                    )
                    .h_full(),
                )
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(gpui::hsla(40. / 360., 0.3, 0.985, 1.))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_row()
                    .children(sidebar)
                    .child(
                        div().flex_1().h_full().children(
                            self.editor
                                .as_ref()
                                .map(|editor| ProseEditor::element(editor, cx)),
                        ),
                    ),
            )
            .child(
                div()
                    .h(px(26.))
                    .flex_none()
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .text_size(px(12.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(gpui::hsla(0., 0., 0.4, 1.))
                    .child(status),
            )
    }
}

/// The display to put a measurement window on: the built-in panel (120 Hz on
/// the reference machine) when there is one, else the primary display.
pub fn pick_display(cx: &App, prefer_builtin: bool) -> Option<(DisplayId, bool, f64)> {
    let displays = cx.displays();
    let facts = |d: &Rc<dyn gpui::PlatformDisplay>| {
        let id = d.id();
        let (builtin, rate) = platform::display_facts(u64::from(id));
        (id, builtin, rate)
    };
    if prefer_builtin
        && let Some(found) = displays.iter().map(facts).find(|(_, builtin, _)| *builtin)
    {
        return Some(found);
    }
    cx.primary_display().map(|d| facts(&d))
}

/// Opens the probe window. `on_top` keeps it above other windows: GPUI stops
/// drawing a window that is fully covered, so measurements and screenshots
/// need it visible.
pub fn open_window(
    cx: &mut App,
    titles: Vec<SharedString>,
    sidebar: bool,
    prefer_builtin: bool,
    on_top: bool,
) -> (WindowHandle<Root>, Option<(DisplayId, bool, f64)>) {
    cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
    cx.on_action(|_: &Quit, cx| cx.quit());
    gpui_prose::bind_keys(cx);
    let display = pick_display(cx, prefer_builtin);
    let display_id = display.map(|(id, _, _)| id);
    let bounds = Bounds::centered(display_id, size(px(1180.), px(820.)), cx);
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                display_id,
                kind: if on_top {
                    gpui::WindowKind::PopUp
                } else {
                    gpui::WindowKind::Normal
                },
                // GPUI caps frames of a window that is not the key window at
                // 30 fps, but only frames that carry next-frame callbacks — the
                // very hook the measurements use. The author types in the key
                // window, which is never capped, so the measurement window
                // turns the cap off to match.
                inactive_frame_interval: if on_top {
                    None
                } else {
                    WindowOptions::default().inactive_frame_interval
                },
                ..Default::default()
            },
            |_, cx| cx.new(|_| Root::new(titles, sidebar)),
        )
        .expect("open the probe window");
    cx.activate(true);
    (window, display)
}

/// Interactive mode: open the corpus and type. The library is the heavy
/// seed's, in a temporary directory: what is typed is not kept.
pub fn run(book_mode: bool, builtin: bool, on_top: bool) {
    let corpus = Rc::new(Corpus::heavy());
    gpui_platform::application().run(move |cx: &mut App| {
        let titles = if book_mode {
            corpus.titles()
        } else {
            vec![corpus.chapter_title()]
        };
        let (window, _) = open_window(cx, titles, book_mode, builtin, on_top);
        window
            .update(cx, |root, window, cx| {
                let book = if book_mode {
                    corpus.book()
                } else {
                    corpus.chapter()
                };
                root.stored_len = true;
                root.corpus = Some(corpus.clone());
                let editor = root.open(book, window, cx);
                let focus = editor.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
            })
            .ok();
    });
}
