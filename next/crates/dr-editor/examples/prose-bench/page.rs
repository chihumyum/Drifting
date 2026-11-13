//! `page`: the longest chapter of the heavy seed as an entry page's body, the
//! page scrolling around it, measured three ways:
//!
//! - `box`: the body before 2026-11-12 (`ed6bff096`): the editor's own
//!   scrolling list in a box half the window tall (240..720 px), inside the
//!   scrolling page.
//! - `fit`: the body from 2026-11-12 to the fix: as tall as its text, every
//!   paragraph laid out and painted on every frame (`fit_content`).
//! - `flow`: the body as tall as its text, the page scrolling it, only the
//!   paragraphs near the window laid out and painted (`EditorOptions::flow`).
//!
//! Headless GPUI as `decor` (the macOS text system, Metal into a texture,
//! GPUI's test clock); frame time is the CPU time of one whole frame of the
//! page (render, layout, paint). Opening: the first frames after the editor
//! is made from the open chapter. Typing: 120 characters one by one in the
//! middle of the chapter (scrolled into view first), the edit (a transaction
//! through the workspace session) plus a frame each, then taken back out.
//! Scrolling: top to bottom, 48 px a frame, through whatever scrolls the
//! body (the box's list, or the page).

use std::{sync::Arc, time::Instant};

use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, EntityInputHandler, HeadlessAppContext,
    Hsla, InteractiveElement as _, IntoElement, ParentElement, Render, ScrollHandle,
    StatefulInteractiveElement as _, Styled, Window, div, point, prelude::FluentBuilder as _, px,
    size,
};
use gpui_prose::{EditorOptions, ProseEditor, ProseStyle};
use serde_json::json;

use crate::{
    corpus::Corpus,
    report::{self, summary},
};

const WIDTH: f32 = 1100.;
const HEIGHT: f32 = 820.;
/// The page above and below the body (title row, other modules).
const ABOVE: f32 = 160.;
const BELOW: f32 = 480.;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Box,
    Fit,
    Flow,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Mode::Box => "box",
            Mode::Fit => "fit",
            Mode::Flow => "flow",
        }
    }
}

struct Page {
    editor: Entity<ProseEditor>,
    mode: Mode,
    scroll: ScrollHandle,
    background: Hsla,
}

impl Render for Page {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let boxed = (window.viewport_size().height * 0.5).clamp(px(240.), px(720.));
        div()
            .id("page")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .bg(self.background)
            .child(div().h(px(ABOVE)))
            .map(|page| match self.mode {
                Mode::Box => page.child(
                    div()
                        .h(boxed)
                        .w_full()
                        .child(ProseEditor::element(&self.editor, cx)),
                ),
                Mode::Fit | Mode::Flow => page.child(ProseEditor::element(&self.editor, cx)),
            })
            .child(div().h(px(BELOW)))
    }
}

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    editor: Entity<ProseEditor>,
    page: Entity<Page>,
    scroll: ScrollHandle,
    mode: Mode,
}

impl Headless {
    fn new(corpus: &Corpus, mode: Mode, opening: &mut Vec<f64>) -> Headless {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(()),
            gpui_platform::current_headless_renderer,
        );
        cx.allow_parking();
        let style = ProseStyle::default();
        let background = style.background;
        let options = EditorOptions {
            cursor_blink: None,
            fit_content: mode == Mode::Fit,
            flow: mode == Mode::Flow,
            ..EditorOptions::default()
        };
        let book = corpus.chapter();
        let scroll = ScrollHandle::new();
        let mut slot = None;
        let page_scroll = scroll.clone();
        let window = cx
            .open_window(size(px(WIDTH), px(HEIGHT)), |window, cx| {
                let editor =
                    cx.new(|cx| ProseEditor::with_options(book, style, options, window, cx));
                if mode == Mode::Flow {
                    let handle = page_scroll.clone();
                    editor.update(cx, |e, _| {
                        e.set_page_scroll(Some(gpui_prose::render::PageScroll::new(handle)))
                    });
                }
                let page = cx.new(|_| Page {
                    editor: editor.clone(),
                    mode,
                    scroll: page_scroll,
                    background,
                });
                slot = Some((editor, page.clone()));
                page
            })
            .expect("open the headless window");
        let (editor, page) = slot.expect("the editor");
        let mut h = Headless {
            cx,
            window: window.into(),
            editor,
            page,
            scroll,
            mode,
        };
        // The first frames: the paragraphs' layout, then the height
        // estimates arriving from the background.
        for _ in 0..4 {
            opening.push(h.draw());
        }
        h
    }

    fn editor<R>(
        &mut self,
        f: impl FnOnce(&mut ProseEditor, &mut Window, &mut Context<ProseEditor>) -> R,
    ) -> R {
        let editor = self.editor.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                editor.update(cx, |e, cx| f(e, window, cx))
            })
            .expect("the window")
    }

    /// One frame of the page: re-render, lay out and paint. Its CPU time in ms.
    fn draw(&mut self) -> f64 {
        self.cx.run_until_parked();
        let (editor, page) = (self.editor.clone(), self.page.clone());
        self.cx
            .update_window(self.window, |_, window, cx| {
                window.simulate_next_frame(cx);
                editor.update(cx, |_, cx| cx.notify());
                page.update(cx, |_, cx| cx.notify());
                let t = Instant::now();
                window.draw(cx).clear(cx);
                t.elapsed().as_secs_f64() * 1000.
            })
            .expect("the window")
    }

    /// The page's scroll position (positive, down).
    fn page_y(&self) -> f32 {
        -f32::from(self.scroll.offset().y)
    }

    fn set_page_y(&mut self, y: f32) {
        let max = f32::from(self.scroll.max_offset().y);
        self.scroll.set_offset(point(px(0.), -px(y.clamp(0., max))));
    }

    /// Whether the body's last paragraph has been scrolled into view.
    fn scroll_step(&mut self, step: f32) -> bool {
        match self.mode {
            Mode::Box => self.editor(|e, _, cx| {
                let (y, total) = e.scroll_y();
                let view = f64::from(HEIGHT * 0.5);
                if y + view >= total - 1. {
                    return true;
                }
                e.scroll_by_estimate(f64::from(step), cx);
                false
            }),
            Mode::Fit | Mode::Flow => {
                let max = f32::from(self.scroll.max_offset().y);
                if self.page_y() >= max - 1. {
                    return true;
                }
                let y = self.page_y() + step;
                self.set_page_y(y);
                false
            }
        }
    }
}

fn scroll_pass(h: &mut Headless, step: f32, frames: &mut Vec<f64>) {
    match h.mode {
        Mode::Box => {
            h.set_page_y(ABOVE);
            h.editor(|e, _, cx| {
                e.scroll_by_estimate(-1e9, cx);
            });
        }
        Mode::Fit | Mode::Flow => h.set_page_y(0.),
    }
    h.draw();
    h.draw();
    for _ in 0..20_000 {
        if h.scroll_step(step) {
            break;
        }
        frames.push(h.draw());
    }
}

fn typing_pass(h: &mut Headless, count: usize, keys: &mut Vec<f64>) {
    let (at, line_top) = h.editor(|e, window, cx| {
        let doc = &e.book().chapters[0].doc;
        let line = doc.visible_lines() / 2;
        let at = doc.line_start(line) + 3;
        let item = e.book().line_item(0, line);
        let top = e.heights().borrow_mut().top(item) as f32;
        e.select(0, at..at, window, cx);
        (at, top)
    });
    if h.mode != Mode::Box {
        // The page brings the paragraph into view (the box's list does it
        // itself on `select`).
        h.set_page_y(ABOVE + line_top - 200.);
    }
    for _ in 0..3 {
        h.draw();
    }
    for i in 0..count {
        let t = Instant::now();
        h.editor(|e, window, cx| {
            e.replace_text_in_range(None, if i % 2 == 0 { "字" } else { "句" }, window, cx);
        });
        let edit = t.elapsed().as_secs_f64() * 1000.;
        keys.push(edit + h.draw());
    }
    h.editor(|e, window, cx| {
        e.select(0, at..at + count, window, cx);
        e.press_backspace(window, cx);
    });
    h.draw();
}

pub fn run_page(write: bool, modes: &[Mode]) {
    let corpus = Corpus::heavy();
    let load_start = report::load();
    let mut results = serde_json::Map::new();
    let mut held = Vec::new();
    for &mode in modes {
        let (mut opening, mut scroll, mut typing) = (Vec::new(), Vec::new(), Vec::new());
        let mut first_frame = Vec::new();
        let mut chars = (0, 0);
        for round in 0..3 {
            let mut open = Vec::new();
            let t = Instant::now();
            let mut h = Headless::new(&corpus, mode, &mut open);
            let made = t.elapsed().as_secs_f64() * 1000.;
            first_frame.push(open[0]);
            opening.push(made);
            if round == 0 {
                chars.0 = h.editor(|e, _, _| e.book().chapters[0].doc.len_chars());
            }
            scroll_pass(&mut h, 48., &mut scroll);
            typing_pass(&mut h, 120, &mut typing);
            chars.1 = h.editor(|e, _, _| e.book().chapters[0].doc.len_chars());
            drop(h);
        }
        held.push((mode, !scroll.is_empty(), chars.0 == chars.1));
        results.insert(
            mode.name().into(),
            json!({
                "open_until_four_frames_drawn": summary(&opening),
                "first_frame": summary(&first_frame),
                "scroll_frame": summary(&scroll),
                "keystroke_frame": summary(&typing),
                "chapter_chars": chars.0,
            }),
        );
    }
    let load_end = report::load();
    let mut results = serde_json::Value::Object(results);
    results["method"] = json!(format!(
        "Headless GPUI, {WIDTH}x{HEIGHT} window, a scrolling page with {ABOVE} px above the body and {BELOW} px below it; the longest chapter of the heavy seed through its workspace session. box = the editor's own list in a box half the window tall (before 2026-11-12); fit = as tall as its text, every paragraph drawn (2026-11-12 to the fix); flow = as tall as its text, the page scrolling, only the paragraphs near the window drawn. Opening: making the editor and its first four frames; first_frame: the first of them alone. Scroll: top to bottom, 48 px a frame. Typing: 120 characters one by one mid-chapter, edit + frame each, then taken out. 3 rounds each."
    ));
    let checks: Vec<(String, bool)> = held
        .iter()
        .flat_map(|(mode, scrolled, same)| {
            [
                (format!("{} scrolled", mode.name()), *scrolled),
                (
                    format!("{} typing left the chapter as long as before", mode.name()),
                    *same,
                ),
            ]
        })
        .collect();
    let checks: Vec<(&str, bool)> = checks.iter().map(|(s, b)| (s.as_str(), *b)).collect();
    report::finish(
        "page",
        write,
        &corpus.shape,
        results,
        (load_start, load_end),
        &checks,
    );
}
