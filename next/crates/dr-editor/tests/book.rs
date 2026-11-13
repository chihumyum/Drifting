//! Flattened book view in one editor (M05, 整书视图) on a real workspace.

use std::time::{Duration, Instant};

use dr_doc::v3::novel::{
    MOD_DESCRIPTION, MOD_PROSE, TPL_CHAPTER, TPL_GROUP, TPL_MANUSCRIPT, TPL_STORYLINE,
    TPL_STORYLINES,
};
use dr_editor::{BookEditor, BookEditorEvent, BookSection, EditorSettings, SectionHeading};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext, px, size};
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
    let book = out(&ws, &Actor::User, "project.create", json!({"name": "全书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

fn manuscript_root(e: &Env) -> String {
    dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, TPL_MANUSCRIPT)
}

fn chapter(e: &Env, title: &str, text: &str) -> String {
    let id = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": manuscript_root(e),
            "template": TPL_CHAPTER,
            "title": title,
            "bodies": { MOD_PROSE: text }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    format!("body:{id}/{MOD_PROSE}")
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
    open_from(cx, e, &manuscript_root(e))
}

fn open_from<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    from: &str,
) -> (Entity<BookEditor>, &'a mut VisualTestContext) {
    let ws = e.ws.clone();
    let book = e.book.clone();
    let from = from.to_owned();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::open(ws, &book, &from, EditorSettings::default(), window, cx).unwrap()
    });
    cx.run_until_parked();
    (view, cx)
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
fn every_manuscript_entry_in_one_scroll_with_author_named_groups(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜。");
    let two = chapter(&e, "二", "钟停了。\n第二段。");
    let three = chapter(&e, "三", "天亮。");
    let group = dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &e.book,
        "tpl-group",
        "第二部分",
        None,
    )["id"]
        .clone();
    for doc in [&two, &three] {
        out(
            &e.ws,
            &Actor::User,
            "entry.move",
            json!({"book":e.book,"id":doc.trim_start_matches("body:").split('/').next().unwrap(),"parent":group}),
        );
    }
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
    assert!(
        acts.is_empty(),
        "canonical manuscript groups do not create legacy act boundaries"
    );
    assert_eq!(
        out(
            &e.ws,
            &Actor::User,
            "entry.get",
            json!({"book":e.book,"id":group})
        )["title"],
        "第二部分"
    );
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
    let from = manuscript_root(&e);
    let (ws, book, from2) = (e.ws.clone(), e.book.clone(), from.clone());
    let prepared = std::thread::spawn(move || BookEditor::prepare(&ws, &book, &from2).unwrap())
        .join()
        .unwrap();
    send(&prepared);
    assert_eq!(prepared.from_entry(), from);
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
    // A book or non-level entry that cannot be read fails in the slow half, not in `cx.new`.
    assert!(BookEditor::prepare(&e.ws, "no-such-book", &from).is_err());
    let closed_entry = one
        .trim_start_matches("body:")
        .split('/')
        .next()
        .unwrap()
        .to_owned();
    assert!(BookEditor::prepare(&e.ws, &e.book, &closed_entry).is_err());
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
        "entry.update",
        json!({"book": e.book, "id": one.trim_start_matches("body:").split('/').next().unwrap(), "title": "第一章"}),
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

fn entry_id_of(doc: &str) -> String {
    doc.trim_start_matches("body:")
        .split('/')
        .next()
        .unwrap()
        .to_owned()
}

#[gpui::test]
fn opens_from_manuscript_intermediate_level_and_storyline_in_exact_order(cx: &mut TestAppContext) {
    let e = env();
    let ms = manuscript_root(&e);
    let ms_title = out(
        &e.ws,
        &Actor::User,
        "entry.get",
        json!({"book": e.book, "id": ms}),
    )["title"]
        .as_str()
        .unwrap()
        .to_owned();

    let prologue = chapter(&e, "楔子", "雾起。");
    let vol_one = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": ms, "template": TPL_GROUP, "title": "第一卷"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_one = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": vol_one,
            "template": TPL_CHAPTER,
            "title": "第一章",
            "bodies": { MOD_PROSE: "第一卷一。" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_two = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": vol_one,
            "template": TPL_CHAPTER,
            "title": "第二章",
            "bodies": { MOD_PROSE: "第一卷二。" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let epilogue = chapter(&e, "尾声", "天晴。");

    let storylines_root = dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, TPL_STORYLINES);
    let lane = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": storylines_root,
            "template": TPL_STORYLINE,
            "title": "暗流线",
            "bodies": { MOD_DESCRIPTION: "这条说明不进整书。" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let resident_under_lane = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": storylines_root,
            "template": TPL_CHAPTER,
            "title": "线内常驻章",
            "bodies": { MOD_PROSE: "常驻正文。" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        &Actor::User,
        "entry.move",
        json!({"book": e.book, "id": resident_under_lane, "parent": lane}),
    );
    // Membership order (`pos`: "a" then "b") intentionally reverses manuscript order:
    // `ch_two` comes before `prologue` on `暗流线`, and both come after `resident_under_lane`.
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane, "member": ch_two, "pos": "a0"}),
    );
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane, "member": entry_id_of(&prologue), "pos": "a1"}),
    );

    // 1. Open from manuscript root (`书稿`).
    {
        let (view, vcx) = open_from(cx, &e, &ms);
        let sections = view.read_with(vcx, |v, _| v.sections().to_vec());
        assert_eq!(
            sections,
            vec![
                BookSection {
                    entry: ms.clone(),
                    title: ms_title,
                    depth: 0,
                    doc: None,
                },
                BookSection {
                    entry: entry_id_of(&prologue),
                    title: "楔子".into(),
                    depth: 1,
                    doc: Some(prologue.clone()),
                },
                BookSection {
                    entry: vol_one.clone(),
                    title: "第一卷".into(),
                    depth: 1,
                    doc: None,
                },
                BookSection {
                    entry: ch_one.clone(),
                    title: "第一章".into(),
                    depth: 2,
                    doc: Some(format!("body:{ch_one}/{MOD_PROSE}")),
                },
                BookSection {
                    entry: ch_two.clone(),
                    title: "第二章".into(),
                    depth: 2,
                    doc: Some(format!("body:{ch_two}/{MOD_PROSE}")),
                },
                BookSection {
                    entry: entry_id_of(&epilogue),
                    title: "尾声".into(),
                    depth: 1,
                    doc: Some(epilogue.clone()),
                },
            ]
        );
    }

    // 2. Open from intermediate level (`第一卷`): only `第一卷` and what lies below it.
    {
        let (view, vcx) = open_from(cx, &e, &vol_one);
        let sections = view.read_with(vcx, |v, _| v.sections().to_vec());
        assert_eq!(
            sections,
            vec![
                BookSection {
                    entry: vol_one.clone(),
                    title: "第一卷".into(),
                    depth: 0,
                    doc: None,
                },
                BookSection {
                    entry: ch_one.clone(),
                    title: "第一章".into(),
                    depth: 1,
                    doc: Some(format!("body:{ch_one}/{MOD_PROSE}")),
                },
                BookSection {
                    entry: ch_two.clone(),
                    title: "第二章".into(),
                    depth: 1,
                    doc: Some(format!("body:{ch_two}/{MOD_PROSE}")),
                },
            ]
        );
    }

    // 3. Open from storyline (`暗流线`): resident children first, then members in membership order;
    //    `MOD_DESCRIPTION` (`in_book = false`) is excluded.
    {
        let (view, vcx) = open_from(cx, &e, &lane);
        let sections = view.read_with(vcx, |v, _| v.sections().to_vec());
        assert_eq!(
            sections,
            vec![
                BookSection {
                    entry: lane.clone(),
                    title: "暗流线".into(),
                    depth: 0,
                    doc: None,
                },
                BookSection {
                    entry: resident_under_lane.clone(),
                    title: "线内常驻章".into(),
                    depth: 1,
                    doc: Some(format!("body:{resident_under_lane}/{MOD_PROSE}")),
                },
                BookSection {
                    entry: ch_two.clone(),
                    title: "第二章".into(),
                    depth: 1,
                    doc: Some(format!("body:{ch_two}/{MOD_PROSE}")),
                },
                BookSection {
                    entry: entry_id_of(&prologue),
                    title: "楔子".into(),
                    depth: 1,
                    doc: Some(prologue.clone()),
                },
            ]
        );
    }
}

#[gpui::test]
fn own_book_prose_precedes_descendants_and_non_book_prose_is_excluded(cx: &mut TestAppContext) {
    let e = env();
    let ms = manuscript_root(&e);
    // Add an `in_book = true` preface prose module and an `in_book = false` note module to TPL_GROUP.
    out(
        &e.ws,
        &Actor::User,
        "entry_template.put_module",
        json!({
            "book": e.book,
            "template": TPL_GROUP,
            "module": {
                "id": "mod-preface",
                "kind": "prose",
                "name": "卷首语",
                "config": { "in_book": true }
            }
        }),
    );
    out(
        &e.ws,
        &Actor::User,
        "entry_template.put_module",
        json!({
            "book": e.book,
            "template": TPL_GROUP,
            "module": {
                "id": "mod-notes",
                "kind": "prose",
                "name": "作者备忘",
                "config": { "in_book": false }
            }
        }),
    );
    let vol = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": ms,
            "template": TPL_GROUP,
            "title": "第一卷",
            "bodies": {
                "mod-preface": "山雨欲来风满楼。",
                "mod-notes": "备忘：不进整书视图。"
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": vol,
            "template": TPL_CHAPTER,
            "title": "第一章",
            "bodies": { MOD_PROSE: "正文第一段。" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (view, vcx) = open_from(cx, &e, &vol);
    let docs: Vec<String> =
        view.read_with(vcx, |v, _| v.chapter_docs().map(str::to_owned).collect());
    let preface_doc = format!("body:{vol}/mod-preface");
    let child_doc = format!("body:{child}/{MOD_PROSE}");
    assert_eq!(docs, vec![preface_doc.clone(), child_doc.clone()]);
    assert_eq!(text_of(&view, vcx, &preface_doc), "山雨欲来风满楼。\n");
    assert_eq!(text_of(&view, vcx, &child_doc), "正文第一段。\n");
}

#[gpui::test]
fn duplicate_and_cyclic_memberships_visit_each_entry_once(cx: &mut TestAppContext) {
    let e = env();
    let storylines_root = dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, TPL_STORYLINES);
    let root_lane = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": storylines_root, "template": TPL_STORYLINE, "title": "总纲线"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lane_a = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": storylines_root, "template": TPL_STORYLINE, "title": "子线甲"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        &Actor::User,
        "entry.move",
        json!({"book": e.book, "id": lane_a, "parent": root_lane}),
    );
    let lane_b = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": storylines_root, "template": TPL_STORYLINE, "title": "子线乙"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        &Actor::User,
        "entry.move",
        json!({"book": e.book, "id": lane_b, "parent": root_lane}),
    );

    let shared = chapter(&e, "共享章", "同一章多处归属。");
    let only_b = chapter(&e, "乙线章", "只在乙线。");
    let shared_id = entry_id_of(&shared);
    let only_b_id = entry_id_of(&only_b);

    // `shared` belongs to `lane_a`, `lane_b`, and directly to `root_lane`.
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane_a, "member": shared_id, "pos": "a0"}),
    );
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane_b, "member": shared_id, "pos": "a0"}),
    );
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane_b, "member": only_b_id, "pos": "a1"}),
    );
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": root_lane, "member": shared_id, "pos": "a0"}),
    );
    // Cyclic memberships: `lane_a` <-> `lane_b` <-> `root_lane`.
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane_a, "member": lane_b, "pos": "a2"}),
    );
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane_b, "member": lane_a, "pos": "a2"}),
    );
    out(
        &e.ws,
        &Actor::User,
        "membership.add",
        json!({"book": e.book, "host": lane_b, "member": root_lane, "pos": "a3"}),
    );

    let (view, vcx) = open_from(cx, &e, &root_lane);
    let entries: Vec<(String, u32)> = view.read_with(vcx, |v, _| {
        v.sections()
            .iter()
            .map(|s| (s.entry.clone(), s.depth))
            .collect()
    });
    // Depth-first: `root_lane` (0) -> `lane_a` (1) -> `shared` (2) -> `lane_b` (2, via `lane_a`
    // membership before `root_lane`'s second child) -> `only_b` (3). Every entry appears once!
    assert_eq!(
        entries,
        vec![
            (root_lane, 0),
            (lane_a, 1),
            (shared_id, 2),
            (lane_b, 2),
            (only_b_id, 3),
        ]
    );
}

#[gpui::test]
fn trashed_entries_and_their_subtrees_never_appear(cx: &mut TestAppContext) {
    let e = env();
    let ms = manuscript_root(&e);
    let kept = chapter(&e, "保留章", "还在。");
    let trashed_ch = chapter(&e, "删掉的章", "不该出现。");
    let trashed_group = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": ms, "template": TPL_GROUP, "title": "回收卷"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let under_trashed = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": trashed_group,
            "template": TPL_CHAPTER,
            "title": "卷下章",
            "bodies": { MOD_PROSE: "跟着卷进回收站。" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    out(
        &e.ws,
        &Actor::User,
        "entry.trash",
        json!({"book": e.book, "id": entry_id_of(&trashed_ch)}),
    );
    out(
        &e.ws,
        &Actor::User,
        "entry.trash",
        json!({"book": e.book, "id": trashed_group}),
    );

    // Cannot open book view from a trashed level.
    assert!(BookEditor::prepare(&e.ws, &e.book, &trashed_group).is_err());

    let (view, vcx) = open_from(cx, &e, &ms);
    let ids: Vec<String> = view.read_with(vcx, |v, _| {
        v.sections().iter().map(|s| s.entry.clone()).collect()
    });
    assert_eq!(ids, vec![ms.clone(), entry_id_of(&kept)]);
    assert!(!ids.contains(&under_trashed));

    // Restoring brings the group and its child back into the open view; trashing removes them again.
    out(
        &e.ws,
        &Actor::User,
        "entry.restore",
        json!({"book": e.book, "id": trashed_group}),
    );
    wait_for(vcx, |vcx| {
        view.read_with(vcx, |v, _| {
            v.sections().iter().any(|s| s.entry == under_trashed)
        })
    });
    out(
        &e.ws,
        &Actor::User,
        "entry.trash",
        json!({"book": e.book, "id": trashed_group}),
    );
    wait_for(vcx, |vcx| {
        view.read_with(vcx, |v, _| {
            !v.sections().iter().any(|s| s.entry == trashed_group)
        })
    });
}

#[gpui::test]
fn proseless_entries_render_titles_and_hierarchy_even_when_trailing_or_alone(
    cx: &mut TestAppContext,
) {
    let e = env();
    let ms = manuscript_root(&e);
    let vol_one = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": ms, "template": TPL_GROUP, "title": "第一卷"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_one = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({
            "book": e.book,
            "parent": vol_one,
            "template": TPL_CHAPTER,
            "title": "第一章",
            "bodies": { MOD_PROSE: "第一卷正文。" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Trailing prose-less volume after all prose chapters.
    let vol_two = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": ms, "template": TPL_GROUP, "title": "第二卷"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // 1. Mixed view: leading (`书稿` depth 0, `第一卷` depth 1) + prose chapter + trailing (`第二卷` depth 1).
    {
        let (view, vcx) = open_from(cx, &e, &ms);
        vcx.simulate_resize(size(px(900.), px(900.)));
        draw(vcx);
        draw(vcx);

        let (before, after, ch_depth) = view.read_with(vcx, |v, _| {
            (
                v.headings_before(0).to_vec(),
                v.headings_after().to_vec(),
                v.chapter_depth(0),
            )
        });
        assert_eq!(
            before,
            vec![
                SectionHeading {
                    entry: ms.clone(),
                    title: out(
                        &e.ws,
                        &Actor::User,
                        "entry.get",
                        json!({"book": e.book, "id": ms})
                    )["title"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    depth: 0,
                },
                SectionHeading {
                    entry: vol_one.clone(),
                    title: "第一卷".into(),
                    depth: 1,
                },
            ]
        );
        assert_eq!(
            after,
            vec![SectionHeading {
                entry: vol_two.clone(),
                title: "第二卷".into(),
                depth: 1,
            }]
        );
        assert_eq!(ch_depth, Some(2));
        assert_eq!(
            view.read_with(vcx, |v, _| v.chapter_entry(0).map(str::to_owned)),
            Some(ch_one)
        );

        let bounds_of = |vcx: &mut gpui::VisualTestContext, entry: &str| {
            vcx.debug_bounds(Box::leak(
                format!("book-section-heading-{entry}").into_boxed_str(),
            ))
        };
        let b_ms = bounds_of(vcx, &ms).expect("manuscript heading drawn");
        let b_v1 = bounds_of(vcx, &vol_one).expect("first volume heading drawn");
        let b_v2 = bounds_of(vcx, &vol_two).expect("trailing second volume heading drawn");
        assert!(b_ms.origin.y < b_v1.origin.y && b_v1.origin.y < b_v2.origin.y);

        // Renaming a prose-less group updates its heading in place without replacing ProseEditor.
        out(
            &e.ws,
            &Actor::User,
            "entry.update",
            json!({"book": e.book, "id": vol_one, "title": "第一卷·起风"}),
        );
        wait_for(vcx, |vcx| {
            view.read_with(vcx, |v, _| v.headings_before(0)[1].title == "第一卷·起风")
        });
    }

    // 2. All-prose-less view: opening `第二卷` when it has sub-levels and zero prose chapters.
    let sub_part = out(
        &e.ws,
        &Actor::User,
        "entry.create",
        json!({"book": e.book, "parent": vol_two, "template": TPL_GROUP, "title": "上篇"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    {
        let (view, vcx) = open_from(cx, &e, &vol_two);
        vcx.simulate_resize(size(px(900.), px(900.)));
        draw(vcx);
        draw(vcx);
        assert_eq!(view.read_with(vcx, |v, _| v.chapter_docs().count()), 0);
        let bounds_of = |vcx: &mut gpui::VisualTestContext, entry: &str| {
            vcx.debug_bounds(Box::leak(
                format!("book-section-heading-{entry}").into_boxed_str(),
            ))
        };
        let b_v2 = bounds_of(vcx, &vol_two).expect("root prose-less heading drawn");
        let b_sub = bounds_of(vcx, &sub_part).expect("child prose-less heading drawn");
        assert!(b_v2.origin.y < b_sub.origin.y);
    }
}

#[gpui::test]
fn reading_position_remembers_title_headings_and_paragraphs(cx: &mut TestAppContext) {
    let e = env();
    let filler = |head: &str| {
        let mut t = head.to_owned();
        for i in 0..120 {
            t.push_str(&format!("\n第{i}段。"));
        }
        t
    };
    let one = chapter(&e, "第一章", &filler("甲"));
    let two = chapter(&e, "第二章", &filler("乙"));
    let (view, vcx) = open(cx, &e);
    vcx.simulate_resize(size(px(900.), px(700.)));
    draw(vcx);

    // Jump to chapter two's title (`Item::Title(1)`): `at_title` is preserved on restore.
    assert!(view.update_in(vcx, |v, window, cx| v.jump_to(&two, window, cx)));
    draw(vcx);
    let at_title = view.read_with(vcx, |v, cx| v.reading_position(cx)).unwrap();
    assert_eq!(at_title.doc, two);
    assert!(at_title.at_title);

    assert!(view.update_in(vcx, |v, window, cx| v.jump_to(&one, window, cx)));
    draw(vcx);
    assert!(view.update(vcx, |v, cx| v.restore(&at_title, cx)));
    draw(vcx);
    let restored = view.read_with(vcx, |v, cx| v.reading_position(cx)).unwrap();
    assert_eq!(restored.doc, two);
    assert!(restored.at_title);
}
