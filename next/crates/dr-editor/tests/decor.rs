//! The paint layers on a real workspace: comments where their anchors are,
//! the Agent's changes inked and kept on this device, links and suggestions,
//! TODO markers projected into TODOs, anchors stored again after an undo.

use std::ops::Range;
use std::time::{Duration, Instant};

use dr_editor::decor::{AgentMarks, DecorLooks, ReviewFocus};
use dr_editor::{BookEditor, ChapterEditor, EditorSettings};
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

// ----- the whole book (M05) ------------------------------------------------------------

fn open_book<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
) -> (Entity<BookEditor>, &'a mut VisualTestContext) {
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut editor =
            BookEditor::open(ws, &book, EditorSettings::default(), window, cx).unwrap();
        editor.set_decor_looks(
            DecorLooks::new(&Palette::LIGHT, hsla(0.58, 0.7, 0.42, 1.), false),
            cx,
        );
        editor
    });
    cx.run_until_parked();
    (view, cx)
}

fn book_range(
    view: &Entity<BookEditor>,
    cx: &mut VisualTestContext,
    chapter: usize,
    group: &str,
    id: &str,
) -> Option<Range<usize>> {
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    editor.read_with(cx, |e, _| e.decoration_range(chapter, group, id))
}

#[gpui::test]
fn the_whole_book_draws_every_chapters_layers(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "第一章的字。");
    let two = chapter(&e, "雨夜，钟楼停了。他在楼下等。");
    let three = chapter(&e, "灯一盏一盏地灭了。");
    let note = comment(&e, &two, "note", (3, 5));
    let todo = comment(&e, &three, "todo", (1, 3));
    let (view, cx) = open_book(cx, &e);
    // Each chapter's comments in that chapter.
    assert!(wait_for(cx, |cx| book_range(
        &view, cx, 1, "comments", &note
    ) == Some(3..5)));
    assert_eq!(book_range(&view, cx, 2, "comments", &todo), Some(1..3));
    assert_eq!(book_range(&view, cx, 1, "comments", &todo), None);
    // An Agent's write to the third chapter is inked there.
    out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": three, "find": "灭了", "replace": "全灭了"}),
    );
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    assert!(wait_for(cx, |cx| {
        (0..8).any(|i| {
            editor
                .read_with(cx, |e, _| e.decoration_range(2, "agent", &format!("m{i}")))
                .is_some()
        })
    }));
    // A comment written in the first chapter shows up there.
    let late = comment(&e, &one, "note", (0, 3));
    assert!(wait_for(cx, |cx| book_range(
        &view, cx, 0, "comments", &late
    ) == Some(0..3)));
    // Jumping to the TODO puts the caret in its chapter.
    cx.update(|_, cx| ReviewFocus::jump(&todo, cx));
    assert!(wait_for(cx, |cx| {
        editor.read_with(cx, |e, _| {
            let s = e.selection();
            s.chapter == 2 && s.head == 1
        })
    }));
    // A TODO marker typed in the second chapter is projected onto it.
    editor.update_in(cx, |e, window, cx| {
        e.select(1, 0..0, window, cx);
        e.replace_text_in_range(None, "TODO ", window, cx);
    });
    assert!(wait_for(cx, |_| todos(&e, &two) == 1));
    assert_eq!(todos(&e, &one), 0);
}

// ----- task items ------------------------------------------------------------------------

/// Clicks paragraph `line`'s list mark (left of its first character).
fn click_mark(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, line: usize) {
    let at = editor.update_in(cx, |e, window, cx| {
        let doc = &e.book().chapters[0].doc;
        let start16 = doc.offset_to_utf16(doc.line_start(line));
        e.bounds_for_range(start16..start16 + 1, gpui::Bounds::default(), window, cx)
            .unwrap()
    });
    let body = gpui_prose::ProseStyle::default().body_size;
    let point = gpui::point(at.left() - body * 0.9, at.top() + at.size.height / 2.);
    cx.simulate_click(point, gpui::Modifiers::default());
}

#[gpui::test]
fn task_items_tick_their_box_or_their_todo(cx: &mut TestAppContext) {
    use gpui_prose::render::ListMark;
    use gpui_prose::schema::block;
    let e = env();
    // Lists live in material notes.
    let material = out(
        &e.ws,
        &Actor::User,
        "material.create",
        json!({"book": e.book, "kind": "text", "title": "清单", "text": "买灯芯\n问钟楼的年代"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("material:{material}");
    let todo = out(
        &e.ws,
        &Actor::User,
        "comment.create",
        json!({"book": e.book, "kind": "todo", "body": "问钟楼的年代"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (view, cx) = open(cx, &e, &doc);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    let editor = prose(&view, cx);
    // The second item is linked to the TODO (as the notes' task lines are).
    let id = todo.clone();
    editor.update_in(cx, |e, window, cx| {
        e.edit_chapter(0, gpui_prose::HostStep::Own, window, cx, move |d| {
            for line in [0, 1] {
                d.set_block_attr(line, block::LIST, Some("task".into()), "user");
            }
            d.set_block_attr(1, block::TODO, Some(id.as_str().into()), "user");
            None
        });
    });
    let mark = |cx: &mut VisualTestContext, line: usize| {
        editor.read_with(cx, |e, _| e.block_look(0, line).list.map(|l| l.mark))
    };
    assert_eq!(mark(cx, 0), Some(ListMark::Task { done: false }));
    // The TODO done elsewhere: the linked item shows it.
    out(
        &e.ws,
        &Actor::User,
        "comment.update",
        json!({"book": e.book, "id": todo, "status": "resolved"}),
    );
    assert!(wait_for(cx, |cx| mark(cx, 1) == Some(ListMark::Task { done: true })));
    // A click on the plain task's box ticks it.
    wait_for(cx, |_| true);
    click_mark(&editor, cx, 0);
    assert!(wait_for(cx, |cx| mark(cx, 0) == Some(ListMark::Task { done: true })));
    // A click on the linked one reopens its TODO.
    click_mark(&editor, cx, 1);
    let status = |e: &Env| {
        out(&e.ws, &Actor::User, "comment.list", json!({"book": e.book}))
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == todo.as_str())
            .unwrap()["status"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert!(wait_for(cx, |_| status(&e) == "open"));
    assert!(wait_for(cx, |cx| mark(cx, 1) == Some(ListMark::Task { done: false })));
}

#[test]
fn a_comments_original_passage_says_when_the_prose_changed() {
    let e = env();
    let doc = chapter(&e, "雨夜，钟楼停了。楼下没人。");
    // 「钟楼」, kept as it was written.
    let note = comment(&e, &doc, "note", (3, 5));
    let read = |e: &Env| {
        dr_editor::decor::original(&e.ws, &e.book, &note)
            .unwrap()
            .unwrap()
    };
    let first = read(&e);
    assert_eq!(first.text, "钟楼");
    assert_eq!(first.changed, Some(false));
    // Words elsewhere change nothing; the words under it do.
    out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc, "find": "楼下", "replace": "街上"}),
    );
    assert_eq!(read(&e).changed, Some(false));
    out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc, "find": "钟楼", "replace": "钟塔"}),
    );
    let after = read(&e);
    assert_eq!(
        after.text, "钟楼",
        "the passage is the one it was written on"
    );
    assert_eq!(after.changed, Some(true));
    // A comment on nothing keeps no passage.
    let floating = out(
        &e.ws,
        &Actor::User,
        "comment.create",
        json!({"book": e.book, "kind": "note", "body": "浮动"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        dr_editor::decor::original(&e.ws, &e.book, &floating).unwrap(),
        None
    );
}

#[gpui::test]
fn code_blocks_and_callouts_are_written_in_notes(cx: &mut TestAppContext) {
    use gpui_prose::schema::block;
    let e = env();
    let material = out(
        &e.ws,
        &Actor::User,
        "material.create",
        json!({"book": e.book, "kind": "text", "title": "笔记", "text": "后盖    左上格\n拆之前先拍一张照。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (view, cx) = open(cx, &e, &format!("material:{material}"));
    let editor = prose(&view, cx);
    editor.update_in(cx, |e, window, cx| {
        e.edit_chapter(0, gpui_prose::HostStep::Own, window, cx, move |d| {
            d.set_block_attr(0, block::CODE_BLOCK, Some("".into()), "user");
            d.set_block_attr(1, block::CALLOUT, Some("note".into()), "user");
            None
        });
    });
    let looks = |cx: &mut VisualTestContext| {
        editor.read_with(cx, |e, _| {
            (e.block_look(0, 0).code, e.block_look(0, 1).callout)
        })
    };
    assert!(wait_for(cx, |cx| looks(cx) == (true, true)));
    // Kept in the note's document, not only on the screen.
    let stored =
        e.ws.library()
            .open_doc(&format!("material:{material}"), dr_store::OpenDoc::Existing)
            .unwrap()
            .read(|d| {
                let text = d.get_text(dr_doc::schema::prose::BODY);
                text.to_delta()
                    .iter()
                    .filter_map(|item| match item {
                        loro::TextDelta::Insert {
                            attributes: Some(a),
                            ..
                        } => Some(a.keys().cloned().collect::<Vec<_>>()),
                        _ => None,
                    })
                    .flatten()
                    .collect::<Vec<_>>()
            })
            .unwrap();
    assert!(stored.iter().any(|k| k == block::CODE_BLOCK), "{stored:?}");
    assert!(stored.iter().any(|k| k == block::CALLOUT), "{stored:?}");
}
