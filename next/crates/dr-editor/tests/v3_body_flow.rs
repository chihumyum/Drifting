//! A v3 body in its entry page: as tall as its text, the page scrolling it,
//! and a keystroke in a long one as cheap as in a short one, so a phrase
//! typed as one burst is one undo step. From 2026-11-12 (`ed6bff096`) to the
//! fix every keystroke's frame laid out the whole chapter; on the lite seed's
//! first chapter a 14-character burst through the debug bridge outlasted the
//! undo merge interval (500 ms from a step's first edit) and one ⌘Z took back
//! only its last word (real-window scenarios `k4-0-bridge`,
//! `k4-0-home-release`).
//!
//! The undo history reads GPUI's clock, which the test platform holds still
//! until a test moves it: what one step is does not depend on how busy the
//! machine is. What a keystroke costs is pinned by what its frame lays out.

use std::time::Duration;

use dr_editor::{ChapterEditor, EditorSettings};
use dr_workspace::{Actor, Workspace};
use gpui::{
    AppContext as _, Context, Entity, EntityInputHandler as _, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle,
    StatefulInteractiveElement as _, Styled as _, TestAppContext, VisualTestContext, Window, div,
    px, size,
};
use serde_json::{Value, json};

/// Paragraphs in the long body: tens of windows of text.
const PARAGRAPHS: usize = 400;
/// What the real-window scenarios type before their ⌘Z.
const PHRASE: &str = "Restored home ";

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    chapter: String,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&lib).unwrap();
    lib.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "test").unwrap();
    let entries = ws
        .call(
            &Actor::User,
            "entry.list",
            json!({ "book": book, "all": true }),
        )
        .unwrap()["output"]
        .clone();
    let chapter = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let text = "雨停以后，堤岸上的水线还会留下片刻，但没有人能保证它一直等在那里，屋里有盐、柴油和旧纸混在一起的气味。";
    let paragraphs: Vec<Value> = (0..PARAGRAPHS)
        .map(|i| json!({ "text": format!("第{i}段。{text}") }))
        .collect();
    ws.call(
        &Actor::User,
        "module.set_prose",
        json!({ "book": book, "owner": chapter, "module": "mod-prose", "paragraphs": paragraphs }),
    )
    .unwrap();
    Env {
        _dir: dir,
        ws,
        book,
        chapter,
    }
}

/// The entry page around the body: something above, the body, something
/// below; the page scrolls.
struct Page {
    editor: Entity<ChapterEditor>,
    scroll: ScrollHandle,
}

impl Render for Page {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("entry-page")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(div().h(px(140.)))
            .child(self.editor.clone())
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

#[gpui::test]
fn a_burst_typed_into_a_long_body_lays_out_what_shows_and_undoes_in_one_step(
    cx: &mut TestAppContext,
) {
    let e = env();
    let doc = format!("body:{}/mod-prose", e.chapter);
    let (ws, book, opened) = (e.ws.clone(), e.book.clone(), doc.clone());
    cx.executor().allow_parking();
    let scroll = ScrollHandle::new();
    let page_scroll = scroll.clone();
    let (page, cx) = cx.add_window_view(move |window, cx| {
        let editor = cx.new(|cx| {
            ChapterEditor::open(ws, &book, &opened, EditorSettings::default(), window, cx).unwrap()
        });
        editor.update(cx, |e, cx| e.set_page_scroll(Some(page_scroll.clone()), cx));
        Page {
            editor,
            scroll: page_scroll,
        }
    });
    cx.simulate_resize(size(px(1000.), px(800.)));
    for _ in 0..4 {
        draw(cx);
    }
    let editor = page.read_with(cx, |p, _| p.editor.clone());
    let prose = editor.read_with(cx, |e, _| e.editor().clone());
    assert!(
        prose.read_with(cx, |p, _| p.is_flow()),
        "a body flows with its page"
    );
    let before = editor.read_with(cx, |e, cx| e.plain_text(cx));
    // The caret at the start of the body, the editor focused, as after the
    // scenarios' click and ⌘↑.
    prose.update_in(cx, |p, window, cx| {
        p.select(0, 0..0, window, cx);
        window.focus(&p.focus_handle(cx), cx);
    });
    draw(cx);
    // Key by key, a frame after each (an event finds the window dirty and
    // draws it first): each frame lays out what the window shows, not the
    // chapter.
    let burst = |text: &str, cx: &mut VisualTestContext| {
        for ch in text.chars() {
            prose.update_in(cx, |p, window, cx| {
                p.replace_text_in_range(None, &ch.to_string(), window, cx)
            });
            draw(cx);
            let painted = prose.read_with(cx, |p, _| p.painted_lines());
            assert!(
                painted > 0 && painted < PARAGRAPHS / 5,
                "{painted} of {PARAGRAPHS} paragraphs laid out for one keystroke"
            );
        }
    };
    let undo = |cx: &mut VisualTestContext| {
        prose.update_in(cx, |p, window, cx| p.undo(window, cx));
        draw(cx);
        editor.read_with(cx, |e, cx| e.plain_text(cx))
    };
    burst(PHRASE, cx);
    assert_eq!(
        editor.read_with(cx, |e, cx| e.plain_text(cx)),
        format!("{PHRASE}{before}")
    );
    // One ⌘Z takes the whole burst back.
    assert_eq!(undo(cx), before, "one undo after typing {PHRASE:?}");
    // A pause longer than the merge interval starts a new step: two bursts,
    // two undos.
    let (first, second) = PHRASE.split_at(PHRASE.find(' ').unwrap() + 1);
    burst(first, cx);
    cx.executor().advance_clock(Duration::from_millis(600));
    burst(second, cx);
    assert_eq!(undo(cx), format!("{first}{before}"));
    assert_eq!(undo(cx), before);
}
