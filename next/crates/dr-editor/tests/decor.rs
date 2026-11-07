//! The paint layers on a real workspace: comments where their anchors are,
//! the Agent's changes inked and kept on this device, links and suggestions,
//! TODO markers projected into TODOs, anchors stored again after an undo.

use std::ops::Range;
use std::time::{Duration, Instant};

use dr_editor::decor::{AgentMarks, DecorLooks, ReviewFocus};
use dr_editor::{ChapterEditor, EditorSettings};
use dr_store::Library;
use dr_ui::tokens::Palette;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, EntityInputHandler, Focusable, TestAppContext, VisualTestContext, hsla};
use gpui_prose::ProseEditor;
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
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
    let book = out(&ws, &Actor::User, "book.create", json!({"name": "画层"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env { dir, ws, book }
}

fn chapter(e: &Env, text: &str) -> String {
    let id = out(
        &e.ws,
        &Actor::User,
        "chapter.create",
        json!({"book": e.book, "title": "一", "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    format!("node:{id}")
}

fn comment(e: &Env, doc: &str, kind: &str, range: (usize, usize)) -> String {
    let id = doc.trim_start_matches("node:");
    out(
        &e.ws,
        &Actor::User,
        "comment.create",
        json!({"book": e.book, "kind": kind, "target": {"kind": "node", "id": id}, "range": [range.0, range.1], "body": "批注"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    doc: &str,
) -> (Entity<ChapterEditor>, &'a mut VisualTestContext) {
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), doc.to_owned());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut editor =
            ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap();
        editor.set_decor_looks(
            DecorLooks::new(&Palette::LIGHT, hsla(0.58, 0.7, 0.42, 1.), false),
            cx,
        );
        editor
    });
    cx.run_until_parked();
    (view, cx)
}

fn wait_for(
    cx: &mut VisualTestContext,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        // Timers (the links wait for typing to settle) run on the test clock.
        cx.executor().advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
        if done(cx) {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn prose(view: &Entity<ChapterEditor>, cx: &mut VisualTestContext) -> Entity<ProseEditor> {
    view.read_with(cx, |v, _| v.editor().clone())
}

fn range(
    view: &Entity<ChapterEditor>,
    cx: &mut VisualTestContext,
    group: &str,
    id: &str,
) -> Option<Range<usize>> {
    let editor = prose(view, cx);
    editor.read_with(cx, |e, _| e.decoration_range(0, group, id))
}

/// A list of one range.
fn one(r: Range<usize>) -> Vec<Range<usize>> {
    std::iter::once(r).collect()
}

/// Every decoration of a group, sorted by where it starts.
fn group(
    view: &Entity<ChapterEditor>,
    cx: &mut VisualTestContext,
    group: &str,
) -> Vec<Range<usize>> {
    let editor = prose(view, cx);
    let ids: Vec<String> = (0..64)
        .flat_map(|i| {
            [
                format!("l{i}"),
                format!("s{i}"),
                format!("t{i}"),
                format!("m{i}"),
            ]
        })
        .collect();
    let mut found: Vec<Range<usize>> = editor.read_with(cx, |e, _| {
        ids.iter()
            .filter_map(|id| e.decoration_range(0, group, id))
            .collect()
    });
    found.sort_by_key(|r| r.start);
    found
}

#[gpui::test]
fn an_agents_write_while_the_chapter_opens_leaves_comments_on_their_words(cx: &mut TestAppContext) {
    // The anchors are resolved off the main thread; positions found for
    // another state of the document than the editor shows are found again.
    let e = env();
    let doc = chapter(&e, "雨夜，钟楼停了。他在楼下等。");
    let note = comment(&e, &doc, "note", (9, 11));
    let (ws, book, d) = (e.ws.clone(), e.book.clone(), doc.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut editor =
            ChapterEditor::open(ws, &book, &d, EditorSettings::default(), window, cx).unwrap();
        editor.set_decor_looks(
            DecorLooks::new(&Palette::LIGHT, hsla(0.58, 0.7, 0.42, 1.), false),
            cx,
        );
        editor
    });
    out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc, "find": "雨夜", "replace": "那个雨夜"}),
    );
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note).is_some()));
    for _ in 0..5 {
        wait_for(cx, |_| true);
    }
    // 「楼下」 moved two characters along.
    assert_eq!(range(&view, cx, "comments", &note), Some(11..13));
}

#[gpui::test]
fn comments_drawn_again_stay_where_the_edits_moved_them(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(
        &e,
        "雨夜，钟楼停了。\n他在楼下等。\n第三段在这里写着楼下的事。",
    );
    let note = comment(&e, &doc, "note", (11, 13));
    let (view, cx) = open(cx, &e, &doc);
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note) == Some(11..13)));
    let agent = Actor::agent("s", 1, "c");
    out(
        &e.ws,
        &agent,
        "prose.replace",
        json!({"doc": doc, "find": "雨夜", "replace": "那个雨夜"}),
    );
    out(
        &e.ws,
        &agent,
        "prose.replace",
        json!({"doc": doc, "find": "钟楼停", "replace": "钟楼，一下一下地停"}),
    );
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note) == Some(19..21)));
    // Pointing at its card, and jumping to it, draw it again: where it is
    // now, not where it was found.
    cx.update(|_, cx| ReviewFocus::point_cards(vec![note.clone()], cx));
    wait_for(cx, |_| true);
    assert_eq!(range(&view, cx, "comments", &note), Some(19..21));
    cx.update(|_, cx| ReviewFocus::jump(&note, cx));
    wait_for(cx, |_| true);
    assert_eq!(range(&view, cx, "comments", &note), Some(19..21));
    let caret = prose(&view, cx).read_with(cx, |e, _| e.selection().range());
    assert_eq!(caret, 19..19);
}

#[gpui::test]
fn comments_are_drawn_where_their_anchors_are(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "雨夜，钟楼停了。他在楼下等。");
    let note = comment(&e, &doc, "note", (3, 5));
    let todo = comment(&e, &doc, "todo", (9, 13));
    let (view, cx) = open(cx, &e, &doc);
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note) == Some(3..5)));
    assert_eq!(range(&view, cx, "comments", &todo), Some(9..13));
    // A comment written while the chapter is open shows up; a resolved one goes.
    let late = comment(&e, &doc, "note", (0, 2));
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &late) == Some(0..2)));
    out(
        &e.ws,
        &Actor::User,
        "comment.update",
        json!({"book": e.book, "id": note, "status": "resolved"}),
    );
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note).is_none()));
    // Typing before a comment moves it along.
    let editor = prose(&view, cx);
    editor.update_in(cx, |e, window, cx| {
        e.select(0, 0..0, window, cx);
        e.replace_text_in_range(None, "夜", window, cx);
    });
    cx.run_until_parked();
    assert_eq!(range(&view, cx, "comments", &todo), Some(10..14));
}

#[gpui::test]
fn jumping_to_a_comment_draws_it_and_shows_it(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "雨夜，钟楼停了。\n他在楼下等，等到天亮。");
    let note = comment(&e, &doc, "note", (12, 16));
    let (view, cx) = open(cx, &e, &doc);
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note).is_some()));
    cx.update(|_, cx| {
        ReviewFocus::jump(&note, cx);
    });
    cx.run_until_parked();
    let editor = prose(&view, cx);
    let head = editor.read_with(cx, |e, _| e.selection().head);
    assert_eq!(head, 12, "the caret goes to the comment's start");
    // Pointing at its card from the panel turns it hot: the panel and the
    // prose share the review focus.
    cx.update(|_, cx| ReviewFocus::point_cards(vec![note.clone()], cx));
    cx.run_until_parked();
    assert_eq!(cx.update(|_, cx| ReviewFocus::get(cx).cards), vec![note]);
}

#[gpui::test]
fn the_agents_changes_are_inked_and_kept_on_this_device(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "开头。中间。结尾。");
    let (view, cx) = open(cx, &e, &doc);
    out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc, "find": "中间", "replace": "钟楼底下"}),
    );
    assert!(
        wait_for(cx, |cx| !group(&view, cx, "agent").is_empty()),
        "the rewritten words are inked"
    );
    assert_eq!(group(&view, cx, "agent"), one(3..7));
    // Kept in the library folder, on this device only.
    let file = e.dir.path().join("agent-marks.json");
    let kept: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let marks = kept["docs"][&doc].as_array().unwrap();
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0]["kind"], "chg");
    // Touched: gone, and gone from the file (a restart will not bring it back).
    let id = marks[0]["id"].as_str().unwrap().to_owned();
    let (ws, d) = (e.ws.clone(), doc.clone());
    cx.update(|_, cx| {
        let ledger = AgentMarks::of(&ws, cx);
        ledger.update(cx, |m, cx| m.forget(&d, &[id.as_str()], cx));
    });
    assert!(wait_for(cx, |cx| group(&view, cx, "agent").is_empty()));
    let kept: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(kept["docs"].get(&doc).is_none(), "{kept}");
    // The author's own words are never inked.
    let editor = prose(&view, cx);
    editor.update_in(cx, |e, window, cx| {
        e.select(0, 0..0, window, cx);
        e.replace_text_in_range(None, "作者", window, cx);
    });
    cx.run_until_parked();
    std::thread::sleep(Duration::from_millis(50));
    cx.run_until_parked();
    assert!(group(&view, cx, "agent").is_empty());
}

#[gpui::test]
fn links_suggestions_and_todo_keywords_are_found(cx: &mut TestAppContext) {
    let e = env();
    let name = out(
        &e.ws,
        &Actor::User,
        "element.create",
        json!({"book": e.book, "name": "林岚"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = chapter(&e, "TODO 查钟楼的年代\n林岚上了楼，林岚又下来。");
    let (view, cx) = open(cx, &e, &doc);
    assert!(wait_for(cx, |cx| group(&view, cx, "suggestions").len() == 2));
    assert_eq!(group(&view, cx, "suggestions"), vec![12..14, 18..20]);
    assert_eq!(group(&view, cx, "todo-marks"), one(0..4));
    // Linking the first name: it gets the dry underline and stops being a
    // suggestion.
    let editor = prose(&view, cx);
    editor.update_in(cx, |e, window, cx| {
        e.book_mut().chapters[0].doc.mark(
            12..14,
            &format!("entity:{name}"),
            dr_editor::convert::entity_value(&dr_model::prose::EntityLink {
                target: name.clone(),
                kind: dr_model::kind::EntityKind::Element,
                block: None,
                end_block: None,
            }),
            gpui_prose::text::ORIGIN_USER,
        );
        e.refresh_chapter(0, cx);
        let _ = window;
        cx.emit(gpui_prose::EditorEvent::Edited { chapter: 0 });
    });
    assert!(wait_for(cx, |cx| group(&view, cx, "links") == one(12..14)));
    assert_eq!(group(&view, cx, "suggestions"), one(18..20));
}

fn todos(e: &Env, doc: &str) -> usize {
    let id = doc.trim_start_matches("node:");
    out(
        &e.ws,
        &Actor::User,
        "comment.list",
        json!({"book": e.book, "kind": "todo", "target": {"kind": "node", "id": id}}),
    )
    .as_array()
    .unwrap()
    .len()
}

#[gpui::test]
fn todo_markers_become_todos_when_the_caret_leaves(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "正文。\n");
    let (view, cx) = open(cx, &e, &doc);
    let editor = prose(&view, cx);
    // The author types a marker in the second paragraph with the editor
    // focused: no TODO while the caret is there. (Focus events flow only in
    // the active window, when it draws.)
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    editor.update_in(cx, |e, window, cx| {
        window.focus(&e.focus_handle(cx), cx);
        e.select(0, 4..4, window, cx);
    });
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    for c in "TODO 查钟楼".chars() {
        let s = c.to_string();
        editor.update_in(cx, |e, window, cx| {
            e.replace_text_in_range(None, &s, window, cx)
        });
    }
    cx.run_until_parked();
    std::thread::sleep(Duration::from_millis(50));
    cx.run_until_parked();
    assert_eq!(todos(&e, &doc), 0, "still typing in that paragraph");
    // The caret leaves the paragraph: the TODO is made.
    editor.update_in(cx, |e, window, cx| e.select(0, 1..1, window, cx));
    assert!(wait_for(cx, |_| todos(&e, &doc) == 1));
    // The marker is deleted: the open TODO goes with it (the whole list is
    // sent each time).
    editor.update_in(cx, |e, window, cx| {
        e.select(0, 4..13, window, cx);
        e.press_backspace(window, cx);
    });
    assert!(wait_for(cx, |_| todos(&e, &doc) == 0));
}

#[gpui::test]
fn an_undo_stores_the_anchor_it_brought_back(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "雨夜，钟楼停了。");
    let note = comment(&e, &doc, "note", (3, 5));
    let (view, cx) = open(cx, &e, &doc);
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note) == Some(3..5)));
    let editor = prose(&view, cx);
    editor.update_in(cx, |e, window, cx| {
        e.select(0, 2..6, window, cx);
        e.press_backspace(window, cx);
    });
    cx.run_until_parked();
    editor.update_in(cx, |e, window, cx| e.undo(window, cx));
    // The book document has the anchor again (comment.reanchor), so the
    // comment is drawn on the restored words after it is read again.
    let id = doc.trim_start_matches("node:").to_owned();
    assert!(wait_for(cx, |_| {
        let listed = out(
            &e.ws,
            &Actor::User,
            "comment.anchors",
            json!({"book": e.book, "target": {"kind": "node", "id": id}}),
        );
        listed.as_array().is_some_and(|a| !a.is_empty())
    }));
    assert!(wait_for(cx, |cx| range(&view, cx, "comments", &note) == Some(3..5)));
}
