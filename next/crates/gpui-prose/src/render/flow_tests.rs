//! A flow editor ([`crate::EditorOptions::flow`]) inside a page that
//! scrolls it, with GPUI's deterministic test platform: only what the page
//! shows is laid out, the text the author looks at stays put when estimates
//! above it change, and the page follows the caret.

use gpui::{
    AppContext as _, Context, Entity, EntityInputHandler as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, ScrollHandle, StatefulInteractiveElement as _,
    Styled as _, TestAppContext, VisualTestContext, Window, div, point, px, size,
};

use crate::{
    EditorOptions, ProseEditor, ProseStyle,
    layout::{Book, Chapter},
    text::{BlockKind, ProseDoc},
};

const PARAGRAPH: &str = "他把吸铁石拍在桌上，说这东西能把河里的铁钉都吸上来，谁也不信，可第二天一早，码头上围了一圈人，看他从水里一根一根地往外拽。";
const PARAGRAPHS: usize = 300;
const HEIGHT: f32 = 700.;
const ABOVE: f32 = 120.;

/// An entry page: a header, the body, something below; the page scrolls.
struct Page {
    editor: Entity<ProseEditor>,
    scroll: ScrollHandle,
}

impl Render for Page {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("page")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(div().h(px(ABOVE)))
            .child(ProseEditor::element(&self.editor, cx))
            .child(div().h(px(300.)))
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

fn page(
    cx: &mut TestAppContext,
    with_page: bool,
) -> (Entity<ProseEditor>, ScrollHandle, &mut VisualTestContext) {
    page_with(cx, with_page, |_, _, _| {})
}

fn page_with(
    cx: &mut TestAppContext,
    with_page: bool,
    before_drawing: impl FnOnce(&mut ProseEditor, &mut Window, &mut Context<ProseEditor>) + 'static,
) -> (Entity<ProseEditor>, ScrollHandle, &mut VisualTestContext) {
    let texts: Vec<String> = (0..PARAGRAPHS)
        .map(|i| format!("第{i}段。{PARAGRAPH}"))
        .collect();
    let book = Book::new(vec![Chapter {
        title: "第一章".into(),
        doc: ProseDoc::from_paragraphs(texts.iter().map(|t| (BlockKind::Body, t.as_str()))),
    }]);
    let scroll = ScrollHandle::new();
    let handle = scroll.clone();
    let (page, cx) = cx.add_window_view(|window, cx| {
        let options = EditorOptions {
            flow: true,
            cursor_blink: None,
            ..EditorOptions::default()
        };
        let editor = cx
            .new(|cx| ProseEditor::with_options(book, ProseStyle::default(), options, window, cx));
        if with_page {
            editor.update(cx, |e, _| {
                e.set_page_scroll(Some(crate::render::PageScroll::new(handle.clone())))
            });
        }
        // Before the editor has ever been drawn.
        editor.update(cx, |e, cx| before_drawing(e, window, cx));
        Page {
            editor,
            scroll: handle,
        }
    });
    let editor = page.read_with(cx, |p, _| p.editor.clone());
    cx.simulate_resize(size(px(900.), px(HEIGHT)));
    for _ in 0..4 {
        draw(cx);
    }
    (editor, scroll, cx)
}

/// The paragraphs painted this frame and the window top of each.
fn painted(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Vec<(usize, f32)> {
    editor.read_with(cx, |e, _| {
        let mut lines: Vec<(usize, f32)> = e
            .frame
            .borrow()
            .lines
            .iter()
            .map(|l| (l.line, f32::from(l.bounds.top())))
            .collect();
        lines.sort_by_key(|(line, _)| *line);
        lines
    })
}

fn scroll_to(scroll: &ScrollHandle, y: f32, cx: &mut VisualTestContext) {
    scroll.set_offset(point(px(0.), px(-y)));
    draw(cx);
    draw(cx);
}

#[gpui::test]
fn a_flow_editor_lays_out_only_what_the_page_shows(cx: &mut TestAppContext) {
    let (editor, scroll, cx) = page(cx, true);
    let height = editor.read_with(cx, |e, _| {
        f32::from(e.flow.borrow().bounds.expect("drawn").size.height)
    });
    // As tall as its text: many windows.
    assert!(height > 20. * HEIGHT, "height {height}");
    let lines = painted(&editor, cx);
    assert_eq!(lines.first().map(|l| l.0), Some(0));
    assert!(
        lines.len() < PARAGRAPHS / 5,
        "{} of {PARAGRAPHS} paragraphs painted",
        lines.len()
    );
    // The page scrolled to the middle: the paragraphs there, not the first.
    scroll_to(&scroll, height / 2., cx);
    let lines = painted(&editor, cx);
    let first = lines.first().expect("painted").0;
    assert!(first > PARAGRAPHS / 4, "first painted {first}");
    assert!(lines.len() < PARAGRAPHS / 5, "{} painted", lines.len());
    // And what the window shows of them is there.
    assert!(
        lines
            .iter()
            .any(|(_, top)| *top >= 0. && *top < HEIGHT / 2.),
        "{lines:?}"
    );
    // The page's own scrolling takes the whole height.
    let max = f32::from(scroll.max_offset().y);
    assert!(max > height - HEIGHT, "max {max}, height {height}");
}

#[gpui::test]
fn the_text_stays_put_when_heights_above_it_change(cx: &mut TestAppContext) {
    let (editor, scroll, cx) = page(cx, true);
    let height = editor.read_with(cx, |e, _| {
        f32::from(e.flow.borrow().bounds.expect("drawn").size.height)
    });
    scroll_to(&scroll, height / 2., cx);
    let lines = painted(&editor, cx);
    let (line, top) = *lines
        .iter()
        .find(|(_, top)| *top >= 100.)
        .expect("a paragraph in view");
    let offset = scroll.offset().y;
    // New estimates far above it (as a background estimate pass brings).
    editor.update(cx, |e, cx| {
        let mut heights = e.heights.borrow_mut();
        for ix in 1..40 {
            heights.set_estimate(ix, 900.);
        }
        drop(heights);
        cx.notify();
    });
    for _ in 0..3 {
        draw(cx);
        let now = painted(&editor, cx);
        let at = now
            .iter()
            .find(|(l, _)| *l == line)
            .expect("still painted")
            .1;
        assert!(
            (at - top).abs() < 0.5,
            "paragraph {line} moved from {top} to {at}"
        );
    }
    // The page took the difference.
    assert!(
        scroll.offset().y < offset,
        "{:?} -> {:?}",
        offset,
        scroll.offset().y
    );
}

#[gpui::test]
fn the_page_follows_the_caret(cx: &mut TestAppContext) {
    let (editor, scroll, cx) = page(cx, true);
    // The caret at the end of the last paragraph the window shows in full.
    let lines = painted(&editor, cx);
    let line = lines
        .iter()
        .rev()
        .find(|(_, top)| *top < HEIGHT - 120.)
        .expect("a paragraph in view")
        .0;
    editor.update_in(cx, |e, window, cx| {
        let doc = &e.book().chapters[0].doc;
        let at = doc.line_start(line) + doc.line(line).chars;
        e.select(0, at..at, window, cx);
    });
    draw(cx);
    let before = scroll.offset().y;
    // Writing on below the window's edge: the page scrolls along.
    for _ in 0..12 {
        editor.update_in(cx, |e, window, cx| {
            e.press_enter(window, cx);
            e.replace_text_in_range(None, "又一段。", window, cx);
        });
        draw(cx);
        draw(cx);
        let caret = editor
            .read_with(cx, |e, _| e.cursor_rect.get())
            .expect("a caret");
        assert!(
            caret.top() >= px(0.) && caret.bottom() <= px(HEIGHT),
            "caret at {caret:?}"
        );
    }
    assert!(scroll.offset().y < before, "the page did not scroll");
    // A caret far away (the end of the chapter): the page goes there.
    editor.update_in(cx, |e, window, cx| {
        let doc = &e.book().chapters[0].doc;
        let end = doc.max_cursor();
        e.select(0, end..end, window, cx);
    });
    for _ in 0..3 {
        draw(cx);
    }
    let caret = editor
        .read_with(cx, |e, _| e.cursor_rect.get())
        .expect("a caret");
    assert!(
        caret.top() >= px(0.) && caret.bottom() <= px(HEIGHT),
        "caret at {caret:?}"
    );
    let last = editor.read_with(cx, |e, _| e.book().chapters[0].doc.visible_lines() - 1);
    assert!(painted(&editor, cx).iter().any(|(l, _)| *l == last));
}

#[gpui::test]
fn without_the_page_it_still_draws_only_what_shows_and_starts_at_the_top(cx: &mut TestAppContext) {
    let (editor, scroll, cx) = page(cx, false);
    let height = editor.read_with(cx, |e, _| {
        f32::from(e.flow.borrow().bounds.expect("drawn").size.height)
    });
    scroll_to(&scroll, height / 2., cx);
    assert!(painted(&editor, cx).len() < PARAGRAPHS / 5);
    // Estimates above change, then the page goes back to the top: the first
    // paragraph is the first thing under the header.
    editor.update(cx, |e, cx| {
        let mut heights = e.heights.borrow_mut();
        for ix in 1..40 {
            heights.set_estimate(ix, 900.);
        }
        drop(heights);
        cx.notify();
    });
    draw(cx);
    scroll_to(&scroll, 0., cx);
    draw(cx);
    let lines = painted(&editor, cx);
    let (line, top) = lines.first().copied().expect("painted");
    assert_eq!(line, 0);
    let editor_top = editor.read_with(cx, |e, _| {
        f32::from(e.flow.borrow().bounds.expect("drawn").top())
    });
    assert!((editor_top - ABOVE).abs() < 0.5, "editor at {editor_top}");
    assert!(top - editor_top < 80., "first paragraph at {top}");
}

#[gpui::test]
fn a_caret_placed_before_the_first_frame_is_shown(cx: &mut TestAppContext) {
    // A page opened at a position (a link to a paragraph near the end):
    // the caret goes there before the editor has ever been drawn.
    let (editor, scroll, cx) = page_with(cx, true, |e, window, cx| {
        let doc = &e.book().chapters[0].doc;
        let line = doc.visible_lines() - 3;
        let at = doc.line_start(line);
        e.select(0, at..at, window, cx);
    });
    for _ in 0..3 {
        draw(cx);
    }
    assert!(scroll.offset().y < px(-1000.), "{:?}", scroll.offset());
    let caret = editor
        .read_with(cx, |e, _| e.cursor_rect.get())
        .expect("a caret");
    assert!(
        caret.top() >= px(0.) && caret.bottom() <= px(HEIGHT),
        "caret at {caret:?}"
    );
}
