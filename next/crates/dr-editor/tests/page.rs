//! The chapter page around the text (M03) on a real workspace: the facts the
//! host's head and end show, the places they are drawn, the actions.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_editor::page::{self, PageChrome, PageInfo, PageKind};
use dr_editor::{BookEditor, ChapterEditor, EditorSettings, SessionSource};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    AnyElement, App, Entity, EntityInputHandler, Focusable, IntoElement, ParentElement, Styled,
    TestAppContext, VisualTestContext, Window, div, px, size,
};
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "book.create", json!({"name": "页面"}))["id"]
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
        "chapter.create",
        json!({"book": e.book, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    format!("node:{id}")
}

fn titles(e: &Env) -> Vec<String> {
    out(&e.ws, "chapter.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["title"].as_str().unwrap().to_owned())
        .collect()
}

/// Records the pages it is asked to draw.
#[derive(Default)]
struct Recorder {
    heads: RefCell<Vec<PageInfo>>,
    ends: RefCell<Vec<PageInfo>>,
}

struct Chrome(Rc<Recorder>);

impl PageChrome for Chrome {
    fn head(&self, page: &PageInfo, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        self.0.heads.borrow_mut().push(page.clone());
        Some(
            div()
                .h(px(140.))
                .child(page.title.clone())
                .into_any_element(),
        )
    }

    fn end(&self, page: &PageInfo, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        self.0.ends.borrow_mut().push(page.clone());
        Some(div().h(px(60.)).child("⁂").into_any_element())
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

fn open<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    doc: &str,
) -> (Entity<ChapterEditor>, &'a mut VisualTestContext) {
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), doc.to_owned());
    cx.executor().allow_parking();
    // The host opened the session first (off the main thread, in the shell).
    let source = SessionSource::open(&ws, &doc).unwrap();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::with_session(
            ws,
            &book,
            &doc,
            source,
            EditorSettings::default(),
            window,
            cx,
        )
    });
    cx.simulate_resize(size(px(900.), px(900.)));
    cx.run_until_parked();
    (view, cx)
}

#[gpui::test]
fn the_page_shows_its_facts_and_follows_them(cx: &mut TestAppContext) {
    let e = env();
    let line = out(
        &e.ws,
        "storyline.create",
        json!({"book": e.book, "name": "码头线"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    chapter(&e, "序", "开头。");
    let doc = chapter(&e, "雨夜", "他把吸铁石拍在桌上。");
    out(
        &e.ws,
        "chapter.update",
        json!({"book": e.book, "id": doc.trim_start_matches("node:"), "add_storylines": [line]}),
    );
    let (view, cx) = open(cx, &e, &doc);
    let recorder = Rc::new(Recorder::default());
    view.update(cx, |v, cx| {
        v.set_chrome(Some(Rc::new(Chrome(recorder.clone()))), cx)
    });
    draw(cx);
    let page = view.read_with(cx, |v, _| v.page_info()).unwrap();
    assert_eq!(page.kind, PageKind::Chapter);
    assert_eq!(page.number, Some(2));
    assert_eq!(page.title, "雨夜");
    assert_eq!(page.status, "draft");
    assert_eq!(
        page.storyline.as_ref().map(|s| s.name.as_str()),
        Some("码头线")
    );
    assert_eq!(page.words, 9, "nine ideographs");
    assert!(!page.empty);
    // The host drew it: head and end, from these facts.
    assert_eq!(recorder.heads.borrow().last(), Some(&page));
    assert_eq!(recorder.ends.borrow().last(), Some(&page));

    // Typing: the count follows at once.
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.update_in(cx, |ed, window, cx| {
        ed.select(0, 0..0, window, cx);
        ed.replace_text_in_range(None, "夜里", window, cx);
    });
    assert_eq!(view.read_with(cx, |v, _| v.page_info()).unwrap().words, 11);

    // The title, the synopsis, the status, as the host stores them.
    assert_eq!(
        page::rename(&e.ws, &e.book, &doc, "  雨夜之后 ").unwrap(),
        Some("雨夜之后".to_owned())
    );
    assert!(page::set_synopsis(&e.ws, &e.book, &doc, "钟停了。").unwrap());
    page::set_finished(&e.ws, &e.book, &doc, true).unwrap();
    wait_for(cx, |cx| {
        view.read_with(cx, |v, _| v.page_info())
            .is_some_and(|p| p.finished())
    });
    let page = view.read_with(cx, |v, _| v.page_info()).unwrap();
    assert_eq!(
        (page.title.as_str(), page.synopsis.as_str(), page.finished()),
        ("雨夜之后", "钟停了。", true)
    );
    draw(cx);
    assert_eq!(recorder.heads.borrow().last(), Some(&page));
}

#[gpui::test]
fn titles_follow_the_old_rules(cx: &mut TestAppContext) {
    let _ = cx;
    let e = env();
    let one = chapter(&e, "一", "");
    chapter(&e, "二", "");
    // Empty after trimming, or unchanged: nothing is written.
    assert_eq!(page::rename(&e.ws, &e.book, &one, "   ").unwrap(), None);
    assert_eq!(page::rename(&e.ws, &e.book, &one, "一").unwrap(), None);
    // Taken: F3 makes it unique.
    let stored = page::rename(&e.ws, &e.book, &one, "二").unwrap().unwrap();
    assert_ne!(stored, "二");
    assert!(stored.starts_with('二'), "{stored}");
    // A synopsis may be cleared; unchanged writes nothing.
    assert!(page::set_synopsis(&e.ws, &e.book, &one, "梗概").unwrap());
    assert!(!page::set_synopsis(&e.ws, &e.book, &one, " 梗概 ").unwrap());
    assert!(page::set_synopsis(&e.ws, &e.book, &one, "").unwrap());
}

#[gpui::test]
fn an_ideas_page_keeps_its_title_and_synopsis(cx: &mut TestAppContext) {
    let e = env();
    let idea = out(
        &e.ws,
        "idea.create",
        json!({"book": e.book, "title": "钟楼的秘密", "text": "也许钟停在三点十七分。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("node:{idea}");
    let ideas = |e: &Env| out(&e.ws, "idea.list", json!({"book": e.book}));
    assert_eq!(
        page::rename(&e.ws, &e.book, &doc, " 钟楼里的人 ").unwrap(),
        Some("钟楼里的人".to_owned())
    );
    assert_eq!(
        page::rename(&e.ws, &e.book, &doc, "钟楼里的人").unwrap(),
        None
    );
    assert!(page::set_synopsis(&e.ws, &e.book, &doc, "一个关于时间的构想").unwrap());
    let stored = ideas(&e)[0].clone();
    assert_eq!(
        (stored["title"].as_str(), stored["summary"].as_str()),
        (Some("钟楼里的人"), Some("一个关于时间的构想"))
    );
    // The page sees it.
    let (view, cx) = open(cx, &e, &doc);
    view.update(cx, |v, cx| {
        v.set_chrome(Some(Rc::new(Chrome(Rc::default()))), cx)
    });
    let p = view.read_with(cx, |v, _| v.page_info()).unwrap();
    assert_eq!(
        (p.kind, p.title.as_str(), p.synopsis.as_str()),
        (PageKind::Idea, "钟楼里的人", "一个关于时间的构想")
    );
}

#[gpui::test]
fn an_acts_title_page_counts_its_chapters_and_words(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    let two = chapter(&e, "二", "钟停了。");
    let three = chapter(&e, "三", "天亮了。");
    for (name, at) in [("回乡", &one), ("停摆", &three)] {
        out(
            &e.ws,
            "act.create",
            json!({"book": e.book, "name": name, "start_chapter": at.trim_start_matches("node:")}),
        );
    }
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::open(ws, &book, EditorSettings::default(), window, cx).unwrap()
    });
    view.update(cx, |v, cx| {
        v.set_chrome(Some(Rc::new(Chrome(Rc::default()))), cx)
    });
    let act = |doc: &str, cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| v.page_info(doc))
            .unwrap()
            .act_page
    };
    let first = act(&one, cx).expect("the first act opens at 一");
    assert_eq!(
        (
            first.name.as_str(),
            first.ordinal,
            first.chapters,
            first.words
        ),
        ("回乡", 1, 2, 5),
        "雨夜 and 钟停了: punctuation is not counted"
    );
    let second = act(&three, cx).expect("the second at 三");
    assert_eq!((second.ordinal, second.chapters, second.words), (2, 1, 3));
    assert!(act(&two, cx).is_none());
    // Typing in 二 counts toward the first act at once.
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.update_in(cx, |ed, window, cx| {
        ed.select(1, 0..0, window, cx);
        ed.replace_text_in_range(None, "夜里", window, cx);
    });
    assert_eq!(act(&one, cx).unwrap().words, 7);
}

#[gpui::test]
fn a_new_chapter_lands_right_after(cx: &mut TestAppContext) {
    let _ = cx;
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    chapter(&e, "二", "天亮。");
    let new = page::new_chapter_after(&e.ws, &e.book, &one, "新章节").unwrap();
    assert!(new.starts_with("node:"));
    assert_eq!(titles(&e), ["一", "新章节", "二"]);
    let again = page::new_chapter_after(&e.ws, &e.book, &one, "新章节").unwrap();
    assert_ne!(again, new);
    assert_eq!(titles(&e).len(), 4);
    let status = out(&e.ws, "chapter.list", json!({"book": e.book}))[1]["status"].clone();
    assert_eq!(status, "draft");
}

#[gpui::test]
fn an_empty_chapter_says_so_and_enter_in_the_title_hands_over(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "空", "");
    let (view, cx) = open(cx, &e, &doc);
    view.update(cx, |v, cx| {
        v.set_chrome(Some(Rc::new(Chrome(Rc::default()))), cx)
    });
    draw(cx);
    let page = view.read_with(cx, |v, _| v.page_info()).unwrap();
    assert!(page.empty && page.words == 0);
    assert_eq!(page::EMPTY_HINTS[0], ("H1", "#"));
    view.update_in(cx, |v, window, cx| v.focus_body(window, cx));
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let focused = cx.update(|window, cx| editor.focus_handle(cx).is_focused(window));
    assert!(focused);
    editor.update_in(cx, |ed, window, cx| {
        ed.replace_text_in_range(None, "第一个字", window, cx)
    });
    assert!(!view.read_with(cx, |v, _| v.page_info()).unwrap().empty);
}

#[gpui::test]
fn every_chapter_of_the_book_has_its_page(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    let two = chapter(&e, "二", "钟停了。");
    out(
        &e.ws,
        "act.create",
        json!({"book": e.book, "name": "第二幕", "start_chapter": two.trim_start_matches("node:")}),
    );
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::open(ws, &book, EditorSettings::default(), window, cx).unwrap()
    });
    cx.simulate_resize(size(px(900.), px(900.)));
    let recorder = Rc::new(Recorder::default());
    view.update(cx, |v, cx| {
        v.set_chrome(Some(Rc::new(Chrome(recorder.clone()))), cx)
    });
    draw(cx);
    draw(cx);
    let numbers: Vec<Option<u32>> = recorder.heads.borrow().iter().map(|p| p.number).collect();
    assert_eq!(
        view.read_with(cx, |v, _| v.page_info(&two))
            .unwrap()
            .act_opening
            .as_deref(),
        Some("第二幕")
    );
    assert!(
        numbers.contains(&Some(1)) && numbers.contains(&Some(2)),
        "{numbers:?}"
    );
    assert_eq!(
        view.read_with(cx, |v, _| v.page_info(&two)).unwrap().title,
        "二"
    );
    // A new chapter after the first: the view rebuilds with its page.
    let new = page::new_chapter_after(&e.ws, &e.book, &one, "新章节").unwrap();
    wait_for(cx, |cx| {
        view.read_with(cx, |v, _| v.page_info(&new)).is_some()
    });
    assert_eq!(
        view.read_with(cx, |v, _| v.page_info(&new)).unwrap().number,
        Some(2)
    );
    assert!(view.update_in(cx, |v, window, cx| v.focus_body(&new, window, cx)));
    let sel = view.read_with(cx, |v, cx| v.editor().read(cx).selection());
    assert_eq!((sel.chapter, sel.head), (1, 0));
}
