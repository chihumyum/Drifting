//! V3 manuscript order, session lifetime and name eligibility on the shared synthetic seed.
use dr_editor::entity_links::{NameGroup, NameIndex};
use dr_editor::links::LinkTargets as _;
use dr_editor::{BookEditor, EditorSettings};
use dr_workspace::{Actor, Workspace};
use gpui::{EntityInputHandler, TestAppContext};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entries: Value,
}
fn call(e: &Env, name: &str, mut input: Value) -> Value {
    input["book"] = e.book.clone().into();
    e.ws.call(&Actor::User, name, input)
        .unwrap_or_else(|err| panic!("{name}: {err}"))["output"]
        .clone()
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
    let mut e = Env {
        _dir: dir,
        ws,
        book,
        entries: Value::Null,
    };
    e.entries = call(&e, "entry.list", json!({"all":true}));
    e
}
fn entry<'a>(e: &'a Env, template: &str) -> &'a Value {
    e.entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["template"] == template)
        .unwrap()
}
#[test]
fn eligibility_uses_home_or_any_membership_and_never_links_the_owner() {
    let e = env();
    let chapter = entry(&e, "tpl-chapter");
    let id = chapter["id"].as_str().unwrap();
    let home = chapter["parent"].as_str().unwrap();
    let names = NameIndex::load(&e.ws, &e.book, &[]).unwrap();
    assert!(!names.search("", 1000).iter().any(|r| r.1.id == id));
    let character = entry(&e, "tpl-character");
    let host = character["parent"].as_str().unwrap();
    call(
        &e,
        "entry.update",
        json!({"id":host,"overrides":{"allow":[],"auto_link":true,"accept":true}}),
    );
    call(&e, "membership.add", json!({"host":host,"member":id}));
    let names = NameIndex::load(&e.ws, &e.book, &[]).unwrap();
    assert!(
        names
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id && r.2 == NameGroup::Entry)
    );
    let own = format!("body:{id}/mod-prose");
    assert!(
        !NameIndex::load(&e.ws, &e.book, &[&own])
            .unwrap()
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id)
    );
    call(&e, "membership.remove", json!({"host":host,"member":id}));
    assert!(
        !NameIndex::load(&e.ws, &e.book, &[])
            .unwrap()
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id)
    );
    call(
        &e,
        "entry.update",
        json!({"id":home,"overrides":{"auto_link":true}}),
    );
    assert!(
        NameIndex::load(&e.ws, &e.book, &[])
            .unwrap()
            .search("", 1000)
            .iter()
            .any(|r| r.1.id == id)
    );
    let targets = dr_editor::v3::LinkTargets {
        workspace: e.ws.clone(),
        book: e.book.clone(),
    };
    assert!(targets.alive(&dr_model::kind::EntityKind::Entry, id));
    call(&e, "entry.trash", json!({"id":id}));
    assert!(!targets.alive(&dr_model::kind::EntityKind::Entry, id));
    assert!(
        dr_editor::link_card::card_facts(
            &e.ws,
            &e.book,
            &dr_text::autolink::LinkTarget::new(dr_model::kind::EntityKind::Entry, id)
        )
        .is_none()
    );
}
#[gpui::test]
fn manuscript_refresh_keeps_sessions_undo_and_document_order(cx: &mut TestAppContext) {
    let e = env();
    call(
        &e,
        "entry_template.put_module",
        json!({"template":"tpl-chapter","module":{"id":"second","kind":"prose","name":"Second"}}),
    );
    let expected =
        dr_editor::v3::read(&e.ws, &e.book, |v| dr_editor::v3::manuscript_docs(&v)).unwrap();
    assert_eq!(expected.len(), 8);
    assert!(expected.iter().all(|(d, _)| d.starts_with("body:")));
    // Existing seed prose opens directly; a newly added module must still
    // initialize from its template, once, before its first editor session.
    assert!(e.ws.library().doc_info(&expected[0].0).unwrap().is_some());
    assert!(e.ws.library().doc_info(&expected[1].0).unwrap().is_none());
    let first_owner = dr_editor::v3::body(&expected[0].0).unwrap().0;
    let defaults = call(
        &e,
        "module.read_prose",
        json!({"owner":first_owner,"module":"mod-prose"}),
    )["paragraphs"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &e,
        "module.set_prose",
        json!({"owner":"tpl-chapter","module":"second","template":true,
            "paragraphs":[{"text":defaults}]}),
    );
    let ws = e.ws.clone();
    let book = e.book.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |w, cx| {
        BookEditor::open(ws, &book, EditorSettings::default(), w, cx).unwrap()
    });
    let docs = view.read_with(cx, |v, _| {
        v.chapter_docs().map(str::to_owned).collect::<Vec<_>>()
    });
    assert_eq!(
        docs,
        expected.iter().map(|r| r.0.clone()).collect::<Vec<_>>()
    );
    let (first, second) = (docs[0].clone(), docs[1].clone());
    let original = view.read_with(cx, |v, cx| v.plain_text(&first, cx).unwrap());
    let second_original = view.read_with(cx, |v, cx| v.plain_text(&second, cx).unwrap());
    assert_eq!(second_original.trim(), defaults);
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    prose.update_in(cx, |p, w, cx| {
        p.select(0, 0..0, w, cx);
        p.replace_text_in_range(None, "A", w, cx);
    });
    prose.update_in(cx, |p, w, cx| {
        p.select(1, 0..0, w, cx);
        p.replace_text_in_range(None, "B", w, cx);
    });
    let owner = dr_editor::v3::body(&first).unwrap().0;
    let parent = e
        .entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == owner)
        .unwrap()["parent"]
        .clone();
    let manuscript = e
        .entries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == parent)
        .unwrap()["parent"]
        .clone();
    call(
        &e,
        "entry.move",
        json!({"id":owner,"parent":manuscript,"index":2}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |v, _| v.chapter_of(&first)) == Some(6) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&first, cx).unwrap()),
        format!("A{original}")
    );
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    prose.update_in(cx, |p, w, cx| p.select(6, 0..0, w, cx));
    assert!(view.update_in(cx, |v, w, cx| v.undo(w, cx)));
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&first, cx).unwrap()),
        original
    );
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&second, cx).unwrap()),
        format!("B{second_original}")
    );
    prose.update_in(cx, |p, w, cx| p.select(7, 0..0, w, cx));
    assert!(view.update_in(cx, |v, w, cx| v.undo(w, cx)));
    assert_eq!(
        view.read_with(cx, |v, cx| v.plain_text(&second, cx).unwrap()),
        second_original
    );
}

#[gpui::test]
fn body_typing_and_mentions_write_entry_links_and_undo_with_the_text(cx: &mut TestAppContext) {
    use dr_editor::{ChapterEditor, assist::MenuRow};
    let e = env();
    let owner = entry(&e, "tpl-chapter")["id"].as_str().unwrap();
    let doc = format!("body:{owner}/mod-prose");
    let target = entry(&e, "tpl-character")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let name = entry(&e, "tpl-character")["title"]
        .as_str()
        .unwrap()
        .to_owned();
    let ws = e.ws.clone();
    let book = e.book.clone();
    let opened = doc.clone();
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |w, cx| {
        ChapterEditor::open(ws, &book, &opened, EditorSettings::default(), w, cx).unwrap()
    });
    let prose = view.read_with(cx, |v, _| v.editor().clone());
    let before = view.read_with(cx, |v, cx| v.plain_text(cx));
    prose.update_in(cx, |p, w, cx| {
        p.select(0, 0..0, w, cx);
        p.replace_text_in_range(None, &format!("{name} "), w, cx);
    });
    cx.run_until_parked();
    cx.executor().advance_clock(Duration::from_millis(700));
    cx.run_until_parked();
    let linked = prose.read_with(cx, |p, _| {
        p.book().chapters[0].doc.lines()[0].spans.iter().any(|s| {
            s.marks.entities().any(|(id, value)| {
                id == target
                    && dr_editor::links::link_kind(value) == dr_model::kind::EntityKind::Entry
            })
        })
    });
    assert!(linked, "typed eligible names gain entry marks");
    prose.update_in(cx, |p, w, cx| p.undo(w, cx));
    assert_eq!(view.read_with(cx, |v, cx| v.plain_text(cx)), before);
    prose.update_in(cx, |p, w, cx| {
        p.select(0, 0..0, w, cx);
        p.replace_text_in_range(None, &format!("@{name}"), w, cx);
    });
    cx.run_until_parked();
    let assist = view.read_with(cx, |v, _| v.assist().clone());
    assist.read_with(cx, |a, _| {
        let menu = a.menu().unwrap();
        assert!(menu.rows.iter().any(
            |r| matches!(r, MenuRow::Link {target:t,group:NameGroup::Entry,..} if t.id==target)
        ));
        assert!(
            !menu
                .rows
                .iter()
                .any(|r| matches!(r, MenuRow::Create { .. }))
        );
        assert!(
            a.position_link(0, 2)
                .unwrap()
                .contains("/modules/id-mod-prose/prose.md#L5")
        );
    });
    assist.update_in(cx, |a, w, cx| a.choose(Some(0), w, cx));
    assert!(
        view.read_with(cx, |v, cx| v.plain_text(cx))
            .starts_with(&name)
    );
    prose.update_in(cx, |p, w, cx| p.undo(w, cx));
    assert!(
        view.read_with(cx, |v, cx| v.plain_text(cx))
            .starts_with(&format!("@{name}"))
    );
}
