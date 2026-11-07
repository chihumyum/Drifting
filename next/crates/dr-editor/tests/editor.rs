//! The editor view on a real workspace: typing persists through the session,
//! Markdown turns into marks, an Agent's command shows up, chapters switch,
//! TODO markers are found, settings apply.

use dr_editor::{ChapterEditor, ChapterEditorEvent, EditorSettings};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use std::time::{Duration, Instant};

use gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext};
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
    let book = out(&ws, &Actor::User, "book.create", json!({"name": "编辑器"}))["id"]
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

/// The paragraphs as F3 reads them (what search, export and the Agent see).
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
    doc: &str,
) -> (Entity<ChapterEditor>, &'a mut VisualTestContext) {
    let ws = e.ws.clone();
    let book = e.book.clone();
    let doc = doc.to_owned();
    // F2 and F3 write and deliver events on their own threads.
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap()
    });
    cx.run_until_parked();
    (view, cx)
}

/// Runs the app until `done` holds (the holder threads deliver in their own
/// time), at most five seconds.
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

fn type_text(view: &Entity<ChapterEditor>, cx: &mut VisualTestContext, text: &str) {
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    for c in text.chars() {
        let s = c.to_string();
        editor.update_in(cx, |editor, window, cx| {
            editor.replace_text_in_range(None, &s, window, cx)
        });
    }
    cx.run_until_parked();
}

fn caret_at(view: &Entity<ChapterEditor>, cx: &mut VisualTestContext, at: usize) {
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, at..at, window, cx)
    });
}

#[gpui::test]
fn typing_persists_through_the_workspace(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "第一章", "雨夜。");
    let (view, cx) = open(cx, &e, &doc);
    caret_at(&view, cx, 3);
    type_text(&view, cx, "钟停了。");
    assert_eq!(stored(&e, &doc), ["雨夜。钟停了。"]);
    // Search sees it once F2 has indexed the open document (it catches up
    // in the background; the quit hook makes it now).
    e.ws.before_quit();
    let hits = out(
        &e.ws,
        &Actor::User,
        "book.search",
        json!({"book": e.book, "query": "钟停了"}),
    );
    assert!(hits.to_string().contains("钟停了"), "{hits}");
}

#[gpui::test]
fn markdown_after_a_chinese_character_becomes_bold(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "第一章", "");
    let (view, cx) = open(cx, &e, &doc);
    type_text(&view, cx, "他把**吸铁石**拍在桌上");
    assert_eq!(stored(&e, &doc), ["他把吸铁石拍在桌上"]);
    let read = out(&e.ws, &Actor::User, "prose.read", json!({"doc": doc}));
    let text = view.read_with(cx, |v, cx| v.plain_text(cx));
    assert_eq!(text, "他把吸铁石拍在桌上\n");
    let marks = view.read_with(cx, |v, cx| {
        let editor = v.editor().read(cx);
        let doc = &editor.book().chapters[0].doc;
        (
            doc.range_has_mark(2..5, "bold"),
            doc.range_has_mark(5..9, "bold"),
        )
    });
    assert_eq!(marks, (true, false), "only 吸铁石 is bold: {read}");
    // Undo the typing after the rule, then the rule itself: the literal
    // Markdown comes back.
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    for _ in 0..8 {
        editor.update_in(cx, |editor, window, cx| editor.undo(window, cx));
        if view.read_with(cx, |v, cx| v.plain_text(cx)).contains("**") {
            break;
        }
    }
    cx.run_until_parked();
    assert!(
        view.read_with(cx, |v, cx| v.plain_text(cx))
            .starts_with("他把**吸铁石**"),
        "{}",
        view.read_with(cx, |v, cx| v.plain_text(cx))
    );
}

#[gpui::test]
fn headings_from_markdown(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "第一章", "");
    let (view, cx) = open(cx, &e, &doc);
    type_text(&view, cx, "## 钟楼");
    let read = out(&e.ws, &Actor::User, "prose.read", json!({"doc": doc}));
    assert_eq!(read["paragraphs"][0]["text"], "钟楼");
    assert_eq!(read["paragraphs"][0]["heading"], 2, "{read}");
}

#[gpui::test]
fn an_agents_command_shows_up_in_the_open_editor(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "第一章", "开头。");
    let (view, cx) = open(cx, &e, &doc);
    caret_at(&view, cx, 0);
    type_text(&view, cx, "作者");
    out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc, "find": "开头", "replace": "起首"}),
    );
    wait_for(cx, |cx| {
        view.read_with(cx, |v, cx| v.plain_text(cx)) == "作者起首。\n"
    });
    assert_eq!(view.read_with(cx, |v, cx| v.plain_text(cx)), "作者起首。\n");
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.update_in(cx, |editor, window, cx| editor.undo(window, cx));
    cx.run_until_parked();
    assert_eq!(
        stored(&e, &doc),
        ["起首。"],
        "the author's text undone, the Agent's kept"
    );
}

#[gpui::test]
fn chapters_switch_and_todo_markers_are_found(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "正文。");
    let two = chapter(&e, "二", "TODO 查钟楼的年代\n别的");
    let (view, cx) = open(cx, &e, &one);
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    {
        let seen = seen.clone();
        cx.update(|_, cx| {
            cx.subscribe(&view, move |_, event: &ChapterEditorEvent, _| {
                seen.borrow_mut().push(event.clone());
            })
            .detach();
        });
    }
    assert!(view.read_with(cx, |v, _| v.todo_markers().is_empty()));
    view.update_in(cx, |v, window, cx| v.switch_to(&two, window, cx).unwrap());
    cx.run_until_parked();
    let todos = view.read_with(cx, |v, _| v.todo_markers().to_vec());
    assert_eq!(todos.len(), 1);
    assert_eq!(todos[0].task, "查钟楼的年代");
    assert!(todos[0].block.is_some());
    assert!(
        seen.borrow()
            .iter()
            .any(|e| matches!(e, ChapterEditorEvent::TodoMarkers(t) if t.len() == 1))
    );
    // Typing in the new chapter goes to the new document.
    caret_at(&view, cx, 0);
    type_text(&view, cx, "待办：");
    assert_eq!(stored(&e, &two)[0], "待办：TODO 查钟楼的年代");
    assert_eq!(stored(&e, &one), ["正文。"]);
}

#[gpui::test]
fn settings_change_the_editor_style(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "一", "正文。");
    let (view, cx) = open(cx, &e, &doc);
    let settings = EditorSettings::from_values(|k| match k {
        dr_editor::settings::FONT_SIZE => Some(json!(20)),
        dr_editor::settings::PAGE_WIDTH => Some(json!(900)),
        _ => None,
    });
    view.update(cx, |v, cx| v.set_settings(settings, cx));
    let style = view.read_with(cx, |v, cx| v.editor().read(cx).style().clone());
    assert_eq!(style.body_size, gpui::px(20.0));
    assert_eq!(style.max_width, gpui::px(900.0));
}
