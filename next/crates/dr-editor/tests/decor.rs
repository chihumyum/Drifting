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
    let book = out(&ws, &Actor::User, "project.create", json!({"name": "画层"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env { dir, ws, book }
}

fn chapter(e: &Env, text: &str) -> String {
    let id = out(
        &e.ws,
        &Actor::User,
        "entry.create", json!({"book": e.book, "parent": dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-manuscript"), "template": "tpl-chapter", "title": "一", "bodies": {"mod-prose": text}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    format!("body:{id}/mod-prose")
}

fn comment(e: &Env, doc: &str, kind: &str, range: (usize, usize)) -> String {
    let id = doc.trim_start_matches("body:").split('/').next().unwrap();
    // Written by hand whatever the kind (there is one kind of comment; the
    // marker and checklist origins are only projected from prose).
    let _ = kind;
    let origin = "manual";
    out(
        &e.ws,
        &Actor::User,
        "comment.create",
        json!({"book": e.book, "origin": origin, "target": {"kind": "entry", "id": id}, "module":"mod-prose", "range": [range.0, range.1], "body": "批注"}),
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
    let name = dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &e.book,
        "tpl-character",
        "林岚",
        None,
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
                kind: dr_model::kind::EntityKind::Entry,
                block: None,
                end_block: None,
                manual: false,
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

/// `kernel-v5.md` §16: an automatic link whose entry's own 「自动链接」 is off
/// is drawn as text, without grains, and is a link again once it is on; the
/// author's setting does the same for every automatic one. The text and its
/// links stay as they were throughout.
#[gpui::test]
fn a_link_to_an_entry_switched_off_reads_as_text_until_it_is_on_again(cx: &mut TestAppContext) {
    let e = env();
    let name = dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &e.book,
        "tpl-character",
        "林岚",
        None,
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // The Agent's chapter: its names are linked as it writes them.
    let id = out(
        &e.ws,
        &Actor::agent("s", 1, "c"),
        "entry.create", json!({"book": e.book, "parent": dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-manuscript"), "template": "tpl-chapter", "title": "一", "bodies": {"mod-prose": "林岚上了楼，林岚又下来。"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("body:{id}/mod-prose");
    let stored = |e: &Env| {
        let d = e.ws.library().load_copy(&doc).unwrap();
        (d.get_deep_value(), d.oplog_frontiers())
    };
    let before = stored(&e);
    let (view, cx) = open(cx, &e, &doc);
    let both = vec![0..2, 6..8];
    assert!(wait_for(cx, |cx| group(&view, cx, "links") == both));
    let switch = |on: bool| {
        out(
            &e.ws,
            &Actor::User,
            "entry.set_auto_link",
            json!({"book": e.book, "id": name, "auto_link": on}),
        );
    };
    switch(false);
    assert!(wait_for(cx, |cx| group(&view, cx, "links").is_empty()));
    assert!(group(&view, cx, "suggestions").is_empty());
    assert_eq!(stored(&e), before);
    switch(true);
    assert!(wait_for(cx, |cx| group(&view, cx, "links") == both));
    // The author's setting: no links and no grains, at once.
    e.ws.set_auto_links(false);
    view.update(cx, |v, cx| {
        v.set_settings(
            EditorSettings {
                auto_entity_links: false,
                ..EditorSettings::default()
            },
            cx,
        )
    });
    assert!(wait_for(cx, |cx| group(&view, cx, "links").is_empty()));
    assert!(group(&view, cx, "suggestions").is_empty());
    e.ws.set_auto_links(true);
    view.update(cx, |v, cx| v.set_settings(EditorSettings::default(), cx));
    assert!(wait_for(cx, |cx| group(&view, cx, "links") == both));
    assert_eq!(stored(&e), before);
}

/// `kernel-v5.md` §16: turning an entry on links its names already written,
/// in the chapter open in the editor too: the links come in at once, the
/// selection stays where it was and the author's undo gains no step; while
/// the input method is composing in the chapter nothing is written, and it
/// is written once the composition ends.
#[gpui::test]
fn a_switch_turned_on_links_the_open_chapter_without_moving_the_selection_or_the_undo(
    cx: &mut TestAppContext,
) {
    let e = env();
    let level = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "template": "tpl-group", "title": "杂项"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let entry = |title: &str| {
        out(
            &e.ws,
            &Actor::User,
            "entry.create",
            json!({"book": e.book, "parent": level, "template": "tpl-character", "title": title}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (lan, fu) = (entry("林岚"), entry("阿福"));
    let switch_on = |id: &str| {
        out(
            &e.ws,
            &Actor::User,
            "entry.set_auto_link",
            json!({"book": e.book, "id": id, "auto_link": true}),
        );
    };
    // Written while 林岚 was off: no links.
    let doc = chapter(&e, "林岚上了楼。我等林岚。");
    let (view, cx) = open(cx, &e, &doc);
    let editor = prose(&view, cx);
    // The author types, then selects.
    editor.update_in(cx, |p, w, cx| {
        p.select(0, 11..11, w, cx);
        p.replace_text_in_range(None, "好", w, cx);
        p.select(0, 2..5, w, cx);
    });
    cx.run_until_parked();
    let undo = |cx: &mut VisualTestContext| {
        editor.read_with(cx, |p, _| p.book().chapters[0].doc.undo_count())
    };
    let (selection, undos) = (editor.read_with(cx, |p, _| p.selection()), undo(cx));
    assert_eq!(undos, 1);
    assert!(group(&view, cx, "links").is_empty());

    switch_on(&lan);
    assert!(e.ws.wait_for_link_backfill(Duration::from_secs(20)));
    assert!(wait_for(cx, |cx| group(&view, cx, "links") == [0..2, 8..10]));
    assert_eq!(editor.read_with(cx, |p, _| p.selection()), selection);
    assert_eq!(undo(cx), undos, "the links are no step of the author's");
    // ⌘Z takes back what the author typed; the links stay.
    editor.update_in(cx, |p, w, cx| p.undo(w, cx));
    assert!(wait_for(cx, |cx| {
        editor.read_with(cx, |p, _| {
            p.book().chapters[0].doc.lines()[0].text.to_string()
        }) == "林岚上了楼。我等林岚。"
    }));
    assert_eq!(group(&view, cx, "links"), [0..2, 8..10]);

    // The author types 阿福 (off) and starts composing after it.
    editor.update_in(cx, |p, w, cx| {
        p.select(0, 11..11, w, cx);
        p.replace_text_in_range(None, "阿福", w, cx);
        p.replace_and_mark_text_in_range(None, "a", None, w, cx);
    });
    cx.run_until_parked();
    assert!(editor.read_with(cx, |p, _| p.composition().is_some()));
    let stored_links = |e: &Env| {
        let d = e.ws.library().load_copy(&doc).unwrap();
        d.get_text(dr_doc::schema::prose::BODY)
            .to_delta()
            .iter()
            .filter(|d| {
                matches!(d, loro::TextDelta::Insert { attributes: Some(a), .. }
                    if a.keys().any(|k| k.starts_with("entity:")))
            })
            .count()
    };
    let before = stored_links(&e);
    switch_on(&fu);
    std::thread::sleep(Duration::from_millis(400));
    cx.run_until_parked();
    assert_eq!(
        stored_links(&e),
        before,
        "nothing is written while composing"
    );
    assert!(!e.ws.wait_for_link_backfill(Duration::from_millis(50)));
    // The composition ends: the name is linked then.
    editor.update_in(cx, |p, w, cx| p.replace_text_in_range(None, "啊", w, cx));
    cx.run_until_parked();
    assert!(e.ws.wait_for_link_backfill(Duration::from_secs(20)));
    assert!(wait_for(cx, |cx| group(&view, cx, "links") == [0..2, 8..10, 11..13]));
}

fn todos(e: &Env, doc: &str) -> usize {
    let id = doc.trim_start_matches("body:").split('/').next().unwrap();
    out(
        &e.ws,
        &Actor::User,
        "comment.list",
        json!({"book": e.book, "origin": "marker", "target": {"kind": "entry", "id": id}}),
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
    let id = doc
        .trim_start_matches("body:")
        .split('/')
        .next()
        .unwrap()
        .to_owned();
    assert!(wait_for(cx, |_| {
        let listed = out(
            &e.ws,
            &Actor::User,
            "comment.anchors",
            json!({"book": e.book, "target": {"kind": "entry", "id": id}, "module":"mod-prose"}),
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
    let from =
        dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, dr_doc::v3::novel::TPL_MANUSCRIPT);
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut editor =
            BookEditor::open(ws, &book, &from, EditorSettings::default(), window, cx).unwrap();
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

/// Every checklist item becomes a comment (origin `task`), its tick is the
/// comment's status both ways: a click on the box resolves it, resolving the
/// comment ticks the box, reopening clears it (DY fix 8, `kernel-v5.md` §7).
#[gpui::test]
fn task_items_are_comments_and_their_tick_is_the_status_both_ways(cx: &mut TestAppContext) {
    use gpui_prose::render::ListMark;
    use gpui_prose::schema::block;
    let e = env();
    // A chapter's prose: every prose module projects its checklist items.
    let doc = chapter(&e, "买灯芯\n问钟楼的年代\n");
    let (view, cx) = open(cx, &e, &doc);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    let editor = prose(&view, cx);
    // The caret on the last, empty paragraph: neither item is being typed.
    editor.update_in(cx, |p, window, cx| p.select(0, 11..11, window, cx));
    editor.update_in(cx, |e, window, cx| {
        e.edit_chapter(0, gpui_prose::HostStep::Own, window, cx, move |d| {
            for line in [0, 1] {
                d.set_block_attr(line, block::LIST, Some("task".into()), "user");
            }
            None
        });
    });
    let tasks = |e: &Env| -> Vec<Value> {
        let mut list: Vec<Value> = out(
            &e.ws,
            &Actor::User,
            "comment.list",
            json!({"book": e.book, "origin": "task"}),
        )
        .as_array()
        .unwrap()
        .clone();
        list.sort_by_key(|c| c["body"]["text"].as_str().unwrap().to_owned());
        list
    };
    assert!(wait_for(cx, |_| tasks(&e).len() == 2));
    let mark = |cx: &mut VisualTestContext, line: usize| {
        editor.read_with(cx, |e, _| e.block_look(0, line).list.map(|l| l.mark))
    };
    let status = |e: &Env, body: &str| {
        tasks(e).iter().find(|c| c["body"]["text"] == body).unwrap()["status"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(status(&e, "买灯芯"), "open");
    // A click on the box ticks the item and resolves its comment.
    wait_for(cx, |_| true);
    click_mark(&editor, cx, 0);
    assert!(wait_for(cx, |cx| mark(cx, 0) == Some(ListMark::Task { done: true })));
    assert!(wait_for(cx, |_| status(&e, "买灯芯") == "resolved"));
    // Resolving the other comment ticks its item in the prose; reopening
    // clears the tick.
    let other = tasks(&e)
        .iter()
        .find(|c| c["body"]["text"] == "问钟楼的年代")
        .unwrap()["id"]
        .clone();
    out(
        &e.ws,
        &Actor::User,
        "comment.update",
        json!({"book": e.book, "id": other, "status": "resolved"}),
    );
    assert!(wait_for(cx, |cx| mark(cx, 1) == Some(ListMark::Task { done: true })));
    out(
        &e.ws,
        &Actor::User,
        "comment.update",
        json!({"book": e.book, "id": other, "status": "open"}),
    );
    assert!(wait_for(cx, |cx| mark(cx, 1) == Some(ListMark::Task { done: false })));
    assert!(wait_for(cx, |_| status(&e, "问钟楼的年代") == "open"));
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
        json!({"book": e.book, "body": "浮动"}),
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
    let note = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "template": "tpl-note", "title": "笔记", "bodies": {"mod-prose": "后盖    左上格\n拆之前先拍一张照。"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("body:{note}/mod-prose");
    let (view, cx) = open(cx, &e, &doc);
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
            .open_doc(&doc, dr_store::OpenDoc::Existing)
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

// ----- a checklist item the caret leaves ---------------------------------------------------

/// The bodies of the checklist comments on `doc`'s entry.
fn task_bodies(e: &Env, doc: &str) -> Vec<String> {
    let id = doc.trim_start_matches("body:").split('/').next().unwrap();
    let mut bodies: Vec<String> = out(
        &e.ws,
        &Actor::User,
        "comment.list",
        json!({"book": e.book, "origin": "task", "target": {"kind": "entry", "id": id}}),
    )
    .as_array()
    .unwrap()
    .iter()
    .map(|c| c["body"]["text"].as_str().unwrap().to_owned())
    .collect();
    bodies.sort();
    bodies
}

/// Focuses `editor` in its (active) window: focus events flow only there.
fn focus(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) {
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    editor.update_in(cx, |e, window, cx| window.focus(&e.focus_handle(cx), cx));
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
}

/// Makes paragraph `line` of `chapter` a checklist item, with the caret at
/// `caret` (in that paragraph), and types `text` there key by key.
fn type_task(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    chapter: usize,
    line: usize,
    caret: usize,
    text: &str,
) {
    use gpui_prose::schema::block;
    editor.update_in(cx, |e, window, cx| {
        e.select(chapter, caret..caret, window, cx);
        e.edit_chapter(chapter, gpui_prose::HostStep::Own, window, cx, move |d| {
            d.set_block_attr(line, block::LIST, Some("task".into()), "user");
            None
        });
    });
    cx.run_until_parked();
    for c in text.chars() {
        let s = c.to_string();
        editor.update_in(cx, |e, window, cx| {
            e.replace_text_in_range(None, &s, window, cx)
        });
    }
    cx.run_until_parked();
}

/// A checklist item typed with the caret in it, and an item whose words are
/// changed there, are written when the caret moves to another paragraph of
/// the chapter: the comment is there with the item's words (review item 1
/// of the DY hand-back).
#[gpui::test]
fn a_checklist_item_is_written_when_the_caret_leaves_it(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "正文。\n");
    let (view, cx) = open(cx, &e, &doc);
    let editor = prose(&view, cx);
    focus(&editor, cx);
    // The second paragraph (empty, at 4) becomes an item and is typed.
    type_task(&editor, cx, 0, 1, 4, "买灯芯");
    // The caret moves to the first paragraph.
    editor.update_in(cx, |e, window, cx| e.select(0, 1..1, window, cx));
    assert!(wait_for(cx, |_| task_bodies(&e, &doc) == ["买灯芯"]));
    // The item's words are changed with the caret in it, then it leaves.
    editor.update_in(cx, |e, window, cx| e.select(0, 7..7, window, cx));
    cx.run_until_parked();
    for c in "和火柴".chars() {
        let s = c.to_string();
        editor.update_in(cx, |e, window, cx| {
            e.replace_text_in_range(None, &s, window, cx)
        });
    }
    cx.run_until_parked();
    editor.update_in(cx, |e, window, cx| e.select(0, 1..1, window, cx));
    assert!(wait_for(cx, |_| task_bodies(&e, &doc) == ["买灯芯和火柴"]));
}

/// In the whole book, a checklist item typed in one chapter is written when
/// the caret moves into another chapter.
#[gpui::test]
fn a_checklist_item_is_written_when_the_caret_goes_to_another_chapter(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "第一章的字。");
    let two = chapter(&e, "雨夜。\n");
    let (view, cx) = open_book(cx, &e);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    assert!(wait_for(cx, |cx| editor
        .read_with(cx, |e, _| e.book().chapters.len())
        == 2));
    focus(&editor, cx);
    // The second chapter's second paragraph (empty, at 4) becomes an item.
    type_task(&editor, cx, 1, 1, 4, "问钟楼的年代");
    editor.update_in(cx, |e, window, cx| e.select(0, 1..1, window, cx));
    assert!(wait_for(cx, |_| task_bodies(&e, &two) == ["问钟楼的年代"]));
    assert!(task_bodies(&e, &one).is_empty());
}

#[gpui::test]
fn opening_chapter_and_book_editor_projects_existing_unprojected_checklist_and_todo_markers(
    cx: &mut TestAppContext,
) {
    let e = env();
    let one = chapter(&e, "待勾清单\nTODO: 查钟楼文献");
    let two = chapter(&e, "第二章待办\n待办：补夜景描写");

    // Turn paragraph 0 of both chapters into checklist items directly in Loro
    // before any editor opens, so neither `task` nor `marker` is projected yet.
    for doc in [&one, &two] {
        let handle =
            e.ws.library()
                .open_doc(doc, dr_store::OpenDoc::Existing)
                .unwrap();
        let doc_id = dr_model::DocId::parse(doc).unwrap();
        let bytes = handle
            .read(move |d| {
                let copy = d.fork();
                let prose = dr_doc::prose::BorrowedProse::new(&copy, &doc_id).unwrap();
                let attrs = dr_model::prose::BlockAttrs {
                    list: Some(dr_model::kind::ListKind::Task),
                    ..Default::default()
                };
                prose.txn().set_block_attrs(0, &attrs).unwrap();
                copy.commit();
                copy.export(loro::ExportMode::all_updates()).unwrap()
            })
            .unwrap();
        e.ws.import_remote(doc, Some(("prose", &e.book)), bytes, &Actor::User)
            .unwrap();
    }

    let entry_one = one.trim_start_matches("body:").split('/').next().unwrap();
    let entry_two = two.trim_start_matches("body:").split('/').next().unwrap();
    assert!(
        out(
            &e.ws,
            &Actor::User,
            "comment.list",
            json!({"book": e.book, "target": {"kind": "entry", "id": entry_one}}),
        )
        .as_array()
        .unwrap()
        .is_empty()
    );

    // Opening `ChapterEditor` projects chapter one's existing checklist + marker immediately.
    let (_chapter_view, vcx) = open(cx, &e, &one);
    assert!(wait_for(vcx, |_| {
        let list = out(
            &e.ws,
            &Actor::User,
            "comment.list",
            json!({"book": e.book, "target": {"kind": "entry", "id": entry_one}}),
        );
        let arr = list.as_array().unwrap();
        arr.iter()
            .any(|c| c["origin"] == "task" && c["body"]["text"] == "待勾清单")
            && arr
                .iter()
                .any(|c| c["origin"] == "marker" && c["body"]["text"] == "查钟楼文献")
    }));

    // Opening `BookEditor` projects chapter two's existing checklist + marker immediately.
    let (_book_view, vcx) = open_book(cx, &e);
    assert!(wait_for(vcx, |_| {
        let list = out(
            &e.ws,
            &Actor::User,
            "comment.list",
            json!({"book": e.book, "target": {"kind": "entry", "id": entry_two}}),
        );
        let arr = list.as_array().unwrap();
        arr.iter()
            .any(|c| c["origin"] == "task" && c["body"]["text"] == "第二章待办")
            && arr
                .iter()
                .any(|c| c["origin"] == "marker" && c["body"]["text"] == "补夜景描写")
    }));
}

#[gpui::test]
fn unchecking_a_checked_checklist_box_reopens_its_review_comment(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "正文。\n");
    let entry = doc.trim_start_matches("body:").split('/').next().unwrap();
    let (view, cx) = open(cx, &e, &doc);
    let editor = prose(&view, cx);
    focus(&editor, cx);

    type_task(&editor, cx, 0, 1, 4, "核对月相");
    editor.update_in(cx, |ed, window, cx| ed.select(0, 1..1, window, cx));
    assert!(wait_for(cx, |_| task_bodies(&e, &doc) == ["核对月相"]));

    // Move caret onto the checklist line and click its checkbox once -> checked & resolved.
    editor.update_in(cx, |ed, window, cx| {
        ed.select(0, 5..5, window, cx);
        assert!(ed.toggle_tasks(cx));
    });
    assert!(wait_for(cx, |_| {
        let list = out(
            &e.ws,
            &Actor::User,
            "comment.list",
            json!({"book": e.book, "origin": "task", "target": {"kind": "entry", "id": entry}}),
        );
        list.as_array()
            .unwrap()
            .first()
            .and_then(|c| c["status"].as_str())
            == Some("resolved")
    }));

    // Click the checked box again -> checkbox unticks and comment returns to `open`.
    editor.update_in(cx, |ed, _window, cx| {
        assert!(ed.toggle_tasks(cx));
    });
    assert!(wait_for(cx, |cx| {
        let unchecked_in_editor = editor.read_with(cx, |ed, _| {
            !matches!(
                ed.book().chapters[0]
                    .doc
                    .line(1)
                    .block
                    .get(gpui_prose::schema::block::CHECKED),
                Some(loro::LoroValue::Bool(true))
            )
        });
        let list = out(
            &e.ws,
            &Actor::User,
            "comment.list",
            json!({"book": e.book, "origin": "task", "target": {"kind": "entry", "id": entry}}),
        );
        let open_in_review = list
            .as_array()
            .unwrap()
            .first()
            .and_then(|c| c["status"].as_str())
            == Some("open");
        unchecked_in_editor && open_in_review
    }));
}

#[gpui::test]
fn synced_checklist_edits_on_second_device_do_not_write_back_book_comments(
    cx: &mut TestAppContext,
) {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let e_a = env();
    let doc = chapter(&e_a, "第一段。\n第二段。");

    let book_doc = format!("book:{}", e_a.book);
    let book_bytes = e_a
        .ws
        .library()
        .open_doc(&book_doc, dr_store::OpenDoc::Existing)
        .unwrap()
        .read(|d| d.export(loro::ExportMode::Snapshot).unwrap())
        .unwrap();
    let prose_bytes = e_a
        .ws
        .library()
        .open_doc(&doc, dr_store::OpenDoc::Existing)
        .unwrap()
        .read(|d| d.export(loro::ExportMode::Snapshot).unwrap())
        .unwrap();

    let dir_b = tempfile::tempdir().unwrap();
    let lib_b = Library::open(dir_b.path(), library_options("device-b")).unwrap();
    let ws_b = Workspace::open(lib_b, WorkspaceOptions::default()).unwrap();
    ws_b.import_remote(
        &book_doc,
        Some(("book", &e_a.book)),
        book_bytes,
        &Actor::Sync,
    )
    .unwrap();
    ws_b.import_remote(&doc, Some(("prose", &e_a.book)), prose_bytes, &Actor::Sync)
        .unwrap();
    let e_b = Env {
        dir: dir_b,
        ws: ws_b,
        book: e_a.book.clone(),
    };

    let (view_b, cx) = open(cx, &e_b, &doc);
    let editor_b = prose(&view_b, cx);
    focus(&editor_b, cx);
    wait_for(cx, |_| true);

    let book_writes_b = Arc::new(AtomicUsize::new(0));
    let watched_book = e_b.book.clone();
    let counter = book_writes_b.clone();
    let _sub = e_b.ws.subscribe(move |ev| {
        if let dr_workspace::WsEvent::Book(b) = ev
            && b.book.to_string() == watched_book
        {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    });

    // Device A turns paragraph 1 into a checklist item and edits its text,
    // syncing the prose updates to Device B while Device B has the chapter open.
    let delta_bytes = {
        let handle_a = e_a
            .ws
            .library()
            .open_doc(&doc, dr_store::OpenDoc::Existing)
            .unwrap();
        let doc_id = dr_model::DocId::parse(&doc).unwrap();
        handle_a
            .read(move |d| {
                let before = d.oplog_vv();
                let copy = d.fork();
                let prose = dr_doc::prose::BorrowedProse::new(&copy, &doc_id).unwrap();
                let attrs = dr_model::prose::BlockAttrs {
                    list: Some(dr_model::kind::ListKind::Task),
                    ..Default::default()
                };
                let mut txn = prose.txn();
                txn.set_block_attrs(5, &attrs).unwrap();
                txn.insert_text(5, "远端设备敲入：").unwrap();
                copy.commit();
                copy.export(loro::ExportMode::updates(&before)).unwrap()
            })
            .unwrap()
    };

    e_b.ws
        .import_remote(&doc, Some(("prose", &e_b.book)), delta_bytes, &Actor::Sync)
        .unwrap();

    assert!(wait_for(cx, |cx| {
        view_b
            .read_with(cx, |v, cx| v.plain_text(cx))
            .contains("远端设备敲入：第二段。")
    }));
    // Move selection on Device B as well to verify neither incoming sync nor
    // subsequent caret movement writes a competing `comment.project` commit.
    editor_b.update_in(cx, |ed, window, cx| ed.select(0, 0..0, window, cx));
    cx.run_until_parked();
    assert_eq!(
        book_writes_b.load(Ordering::SeqCst),
        0,
        "passive open editor on Device B must not write book comments on synced prose edits"
    );
}
