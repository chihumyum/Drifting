//! The whole book in one editor (M05) on a real workspace.

use std::time::{Duration, Instant};

use dr_editor::{BookEditor, BookEditorEvent, EditorSettings};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext};
use gpui_prose::layout::{BookPos, BookRange};
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn out(ws: &Workspace, actor: &Actor, name: &str, input: Value) -> Value {
    ws.call(actor, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, &Actor::User, "book.create", json!({"name": "全书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

fn chapter(e: &Env, title: &str, text: &str) -> String {
    let id = out(
        &e.ws,
        &Actor::User,
        "chapter.create",
        json!({"book": e.book, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    format!("node:{id}")
}

fn stored(e: &Env, doc: &str) -> Vec<String> {
    out(&e.ws, &Actor::User, "prose.read", json!({"doc": doc}))["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect()
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
) -> (Entity<BookEditor>, &'a mut VisualTestContext) {
    let ws = e.ws.clone();
    let book = e.book.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::open(ws, &book, EditorSettings::default(), window, cx).unwrap()
    });
    cx.run_until_parked();
    (view, cx)
}

fn wait_for(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        if done(cx) || Instant::now() > deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn type_at(
    view: &Entity<BookEditor>,
    cx: &mut VisualTestContext,
    chapter: usize,
    at: usize,
    text: &str,
) {
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.update_in(cx, |e, window, cx| e.select(chapter, at..at, window, cx));
    for c in text.chars() {
        let s = c.to_string();
        editor.update_in(cx, |e, window, cx| {
            e.replace_text_in_range(None, &s, window, cx)
        });
    }
    cx.run_until_parked();
}

fn text_of(view: &Entity<BookEditor>, cx: &mut VisualTestContext, doc: &str) -> String {
    view.read_with(cx, |v, cx| v.plain_text(doc, cx).unwrap())
}

#[gpui::test]
fn every_chapter_in_one_scroll_with_its_acts(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    let two = chapter(&e, "二", "钟停了。\n第二段。");
    let three = chapter(&e, "三", "天亮。");
    out(
        &e.ws,
        &Actor::User,
        "act.create",
        json!({"book": e.book, "name": "第二幕", "start_chapter": two.trim_start_matches("node:")}),
    );
    let (view, cx) = open(cx, &e);
    let docs: Vec<String> =
        view.read_with(cx, |v, _| v.chapter_docs().map(str::to_owned).collect());
    assert_eq!(docs, [one.clone(), two.clone(), three.clone()]);
    let (titles, acts) = view.read_with(cx, |v, cx| {
        let book = v.editor().read(cx).book();
        (
            book.chapters
                .iter()
                .map(|c| c.title.to_string())
                .collect::<Vec<_>>(),
            book.acts()
                .iter()
                .map(|(c, n)| (*c, n.to_string()))
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(titles, ["一", "二", "三"]);
    assert!(acts.contains(&(1, "第二幕".to_owned())), "{acts:?}");
    // Typing in the second chapter writes the second chapter's document.
    type_at(&view, cx, 1, 0, "早上，");
    assert_eq!(stored(&e, &two), ["早上，钟停了。", "第二段。"]);
    assert_eq!(stored(&e, &one), ["雨夜。"]);
}

#[gpui::test]
fn undo_stays_in_the_caret_chapter(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    let two = chapter(&e, "二", "钟停了。");
    let (view, cx) = open(cx, &e);
    type_at(&view, cx, 0, 3, "甲");
    type_at(&view, cx, 1, 4, "乙");
    // The caret goes back to chapter one; ⌘Z undoes chapter one's typing,
    // although chapter two was edited last.
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.update_in(cx, |e, window, cx| e.select(0, 0..0, window, cx));
    assert!(view.update_in(cx, |v, window, cx| v.undo(window, cx)));
    cx.run_until_parked();
    assert_eq!(stored(&e, &one), ["雨夜。"]);
    assert_eq!(stored(&e, &two), ["钟停了。乙"]);
    // Nothing left to undo in chapter one: chapter two is not touched.
    assert!(!view.update_in(cx, |v, window, cx| v.undo(window, cx)));
    assert_eq!(stored(&e, &two), ["钟停了。乙"]);
    // The key binding goes the same way (the view captures the action).
    editor.update_in(cx, |e, window, cx| e.select(1, 0..0, window, cx));
    let focus = editor.read_with(cx, gpui::Focusable::focus_handle);
    cx.update(|window, cx| window.focus(&focus, cx));
    cx.dispatch_action(gpui_prose::input::actions::Undo);
    cx.run_until_parked();
    assert_eq!(stored(&e, &two), ["钟停了。"]);
    assert_eq!(stored(&e, &one), ["雨夜。"]);
    assert!(view.update_in(cx, |v, window, cx| v.redo(window, cx)));
    assert_eq!(stored(&e, &two), ["钟停了。乙"]);
}

#[gpui::test]
fn an_agent_writing_any_chapter_shows_up(cx: &mut TestAppContext) {
    let e = env();
    chapter(&e, "一", "雨夜。");
    let two = chapter(&e, "二", "钟停了。");
    let (view, cx) = open(cx, &e);
    out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": two, "find": "停了", "replace": "又走了"}),
    );
    wait_for(cx, |cx| text_of(&view, cx, &two) == "钟又走了。\n");
    assert_eq!(text_of(&view, cx, &two), "钟又走了。\n");
}

#[gpui::test]
fn lines_and_reading_positions(cx: &mut TestAppContext) {
    let e = env();
    // Long enough to scroll: the first three paragraphs are named.
    let filler = |head: &str| {
        let mut t = head.to_owned();
        for i in 0..300 {
            t.push_str(&format!("\n第{i}段。"));
        }
        t
    };
    let one = chapter(&e, "一", &filler("甲\n乙\n丙"));
    let two = chapter(&e, "二", &filler("子\n丑\n寅\n卯"));
    let (view, cx) = open(cx, &e);
    // Line 5 of the projection is the third paragraph.
    assert!(view.update_in(cx, |v, window, cx| v.reveal_line(&two, 5, window, cx)));
    cx.run_until_parked();
    let (sel, top) = view.read_with(cx, |v, cx| {
        let editor = v.editor().read(cx);
        (
            editor.selection(),
            editor.list_state().logical_scroll_top().item_ix,
        )
    });
    assert_eq!((sel.chapter, sel.head), (1, 4), "the caret at 寅");
    // The paragraph is at the top (the caret keeps a little context above
    // it once the frame is drawn).
    let line_item = view.read_with(cx, |v, cx| v.editor().read(cx).book().line_item(1, 2));
    assert!(
        top + 2 >= line_item && top <= line_item,
        "top {top}, paragraph item {line_item}"
    );
    let at = view.read_with(cx, |v, cx| v.reading_position(cx)).unwrap();
    assert_eq!(at.doc, two);
    assert!(at.paragraph <= 2 && at.block.is_some(), "{at:?}");
    // Somewhere else, then back to exactly there.
    assert!(view.update_in(cx, |v, window, cx| v.jump_to(&one, window, cx)));
    cx.run_until_parked();
    assert_eq!(
        view.read_with(cx, |v, cx| v.reading_position(cx))
            .unwrap()
            .doc,
        one
    );
    view.update(cx, |v, cx| v.restore(&at, cx));
    cx.run_until_parked();
    let back = view.read_with(cx, |v, cx| v.reading_position(cx)).unwrap();
    assert_eq!(
        (back.doc, back.block, back.paragraph),
        (at.doc.clone(), at.block.clone(), at.paragraph)
    );
    // A range across chapters already has its text.
    let last = view.read_with(cx, |v, cx| {
        v.editor().read(cx).book().chapters[0].doc.max_cursor()
    });
    let range = BookRange {
        start: BookPos {
            chapter: 0,
            offset: last - "第299段。".chars().count(),
        },
        end: BookPos {
            chapter: 1,
            offset: 1,
        },
    };
    assert_eq!(
        view.read_with(cx, |v, cx| v.text_in(range, cx)),
        "第299段。\n子"
    );
    // The jump put the caret in chapter one; the selection is inside it.
    assert_eq!(
        view.read_with(cx, |v, cx| v.selection(cx)).chapter(),
        Some(0)
    );
}

#[gpui::test]
fn a_book_prepared_off_the_main_thread_installs_without_failing(cx: &mut TestAppContext) {
    fn send<T: Send>(_: &T) {}
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    let two = chapter(&e, "二", "钟停了。");
    // The slow half on another thread, as the shell does.
    let (ws, book) = (e.ws.clone(), e.book.clone());
    let prepared = std::thread::spawn(move || BookEditor::prepare(&ws, &book).unwrap())
        .join()
        .unwrap();
    send(&prepared);
    assert_eq!(
        prepared.chapter_docs().collect::<Vec<_>>(),
        [one.as_str(), two.as_str()]
    );
    let ws = e.ws.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::with_prepared(ws, prepared, EditorSettings::default(), window, cx)
    });
    cx.run_until_parked();
    assert_eq!(text_of(&view, cx, &two), "钟停了。\n");
    // A book that cannot be read fails in the slow half, not in `cx.new`.
    assert!(BookEditor::prepare(&e.ws, "no-such-book").is_err());
}

#[gpui::test]
fn the_view_follows_the_books_chapters(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    let (view, cx) = open(cx, &e);
    let reloaded = std::rc::Rc::new(std::cell::Cell::new(false));
    {
        let reloaded = reloaded.clone();
        cx.update(|_, cx| {
            cx.subscribe(&view, move |_, event: &BookEditorEvent, _| {
                if *event == BookEditorEvent::Reloaded {
                    reloaded.set(true);
                }
            })
            .detach();
        });
    }
    // Renamed: the title changes in place.
    out(
        &e.ws,
        &Actor::User,
        "chapter.update",
        json!({"book": e.book, "id": one.trim_start_matches("node:"), "title": "第一章"}),
    );
    wait_for(cx, |cx| {
        view.read_with(cx, |v, cx| {
            v.editor().read(cx).book().chapters[0].title.as_ref() == "第一章"
        })
    });
    assert!(!reloaded.get());
    // A new chapter: the view is rebuilt with it.
    let two = chapter(&e, "二", "新的一章。");
    wait_for(cx, |cx| {
        view.read_with(cx, |v, _| v.chapter_of(&two).is_some())
    });
    assert!(reloaded.get());
    assert_eq!(text_of(&view, cx, &two), "新的一章。\n");
}
