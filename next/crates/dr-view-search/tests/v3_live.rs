//! The query can finish before the derived prose index. Index completion
//! must refresh the open v3 panel without another keystroke.
use dr_view_search::{SearchPanel, model::Field, v3::Target};
use dr_workspace::{Actor, Workspace};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::{Duration, Instant},
};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn fixture() -> (tempfile::TempDir, Workspace, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let mut books = Vec::new();
    for seed in [
        dr_testkit::seed::DEFAULT_SEED,
        dr_testkit::seed::DEFAULT_SEED + 1,
    ] {
        let made = dr_testkit::seed::generate_v3(dr_testkit::seed::Preset::Tiny, seed).unwrap();
        books.push(made.books[0].book_id().to_string());
        made.write_to(&store).unwrap();
    }
    store.close().unwrap();
    let mut options = dr_workspace::library_options("0.2.0-dev");
    // Control ordering, rather than relying on a race between the production
    // 90 ms search debounce and the 150 ms index debounce.
    options.derive_idle = Duration::from_secs(60);
    let store = dr_store::Library::open(dir.path(), options).unwrap();
    let ws = Workspace::open(store, Default::default()).unwrap();
    for doc in ws.library().docs(None, None).unwrap() {
        ws.library().reindex_doc(&doc.doc_id).unwrap();
    }
    (dir, ws, books)
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    ws: &Workspace,
    book: &str,
) -> (Entity<SearchPanel>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        cx.bind_keys(dr_ui::input::bindings());
        cx.bind_keys(dr_view_search::key_bindings());
    });
    let ws = ws.clone();
    let book = book.to_owned();
    cx.add_window_view(move |window, cx| {
        SearchPanel::new_v3(
            Some(ws),
            book,
            Rc::new(|_| (dr_ui::sand::Kind::Element, None)),
            dr_i18n::Locale::En,
            dr_i18n::Platform::Mac,
            window,
            cx,
        )
    })
}

fn wait(
    panel: &Entity<SearchPanel>,
    cx: &mut VisualTestContext,
    done: impl Fn(&SearchPanel) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        cx.run_until_parked();
        if panel.read_with(cx, |p, _| done(p)) {
            return;
        }
        assert!(Instant::now() < deadline, "search panel did not refresh");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn material(ws: &Workspace, book: &str) -> String {
    call(ws, "material.list", json!({"book":book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "text")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn replace_first(ws: &Workspace, doc: &str, prefix: &str) {
    let source = call(ws, "prose.read", json!({"doc":doc}));
    let p = &source["paragraphs"][0];
    call(
        ws,
        "prose.replace",
        json!({
            "doc":doc, "block_id":p["block_id"], "find":p["text"],
            "replace":format!("{prefix} {}", p["text"].as_str().unwrap())
        }),
    );
}

#[gpui::test]
fn late_material_index_refreshes_an_empty_query_result(cx: &mut TestAppContext) {
    let (_dir, ws, books) = fixture();
    let book = &books[0];
    let id = material(&ws, book);
    let doc = format!("material:{id}");
    let (panel, cx) = setup(cx, &ws, book);
    replace_first(&ws, &doc, "G4LateIndex");
    panel.update(cx, |p, cx| p.set_query("G4LateIndex", cx));
    wait(&panel, cx, |p| !p.is_searching());
    assert!(panel.read_with(cx, |p, _| p.v3_groups().unwrap().is_empty()));
    ws.library().reindex_doc(&doc).unwrap();
    let direct = dr_view_search::v3::search(&ws, book, "G4LateIndex", 500).unwrap();
    assert_eq!(direct.len(), 1);
    assert_eq!(direct[0].target, Target::Material(id));
    assert_eq!(direct[0].rows[0].field, Field::Body);
    assert_eq!(direct[0].rows[0].paragraph, Some(0));
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap() == direct
    });
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected()),
        Some(dr_view_search::Line::Hit(0, 0)),
        "first late result keeps the default Enter destination"
    );
}

fn chapter(ws: &Workspace, book: &str) -> String {
    call(ws, "entry.list", json!({"book":book,"all":true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn pump(cx: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_millis(200);
    while Instant::now() < until {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn queued_indexes_use_the_current_query_and_cannot_restore_a_cleared_query(
    cx: &mut TestAppContext,
) {
    let (_dir, ws, books) = fixture();
    let book = &books[0];
    let entry = chapter(&ws, book);
    let body = format!("body:{entry}/mod-prose");
    let material = format!("material:{}", material(&ws, book));
    replace_first(&ws, &material, "G4OldQuery");
    replace_first(&ws, &body, "G4CurrentQuery");
    let (panel, cx) = setup(cx, &ws, book);
    panel.update(cx, |p, cx| p.set_query("G4OldQuery", cx));
    wait(&panel, cx, |p| !p.is_searching());
    assert!(panel.read_with(cx, |p, _| p.v3_groups().unwrap().is_empty()));
    ws.library().reindex_doc(&material).unwrap();
    panel.update(cx, |p, cx| p.set_query("G4CurrentQuery", cx));
    ws.library().reindex_doc(&body).unwrap();
    let direct = dr_view_search::v3::search(&ws, book, "G4CurrentQuery", 500).unwrap();
    assert_eq!(direct.len(), 1);
    assert_eq!(
        direct[0].target,
        Target::Entry {
            id: entry.clone(),
            module: Some("mod-prose".into())
        }
    );
    assert_eq!(direct[0].rows[0].paragraph, Some(0));
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap() == direct
    });

    // A → B → A and a queued index notification must settle on the latest
    // request, even though an older request has exactly the same text.
    panel.update(cx, |p, cx| {
        p.set_query("G4CurrentQuery", cx);
        p.set_query("G4OldQuery", cx);
        p.set_query("G4CurrentQuery", cx);
    });
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap() == direct
    });
    call(&ws, "entry.trash", json!({"book":book,"id":entry}));
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap().is_empty()
    });
    call(&ws, "entry.restore", json!({"book":book,"id":entry}));
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap() == direct
    });
    replace_first(&ws, &body, "G4More");
    ws.library().reindex_doc(&body).unwrap();
    panel.update(cx, |p, cx| p.set_query("", cx));
    pump(cx);
    assert!(panel.read_with(cx, |p, _| !p.is_searching()
        && p.v3_groups().unwrap().is_empty()));
}

#[gpui::test]
fn another_book_or_library_does_not_reset_the_selected_hit(cx: &mut TestAppContext) {
    let (_dir, ws, books) = fixture();
    let (_other_dir, other, other_books) = fixture();
    assert_eq!(books, other_books, "same ids in independent libraries");
    let book = &books[0];
    let (panel, cx) = setup(cx, &ws, book);
    panel.update_in(cx, |p, window, cx| {
        p.set_query("灯", cx);
        p.focus(window, cx);
    });
    wait(&panel, cx, |p| !p.is_searching());
    let first = panel.read_with(cx, |p, _| p.selected());
    assert!(first.is_some());
    cx.simulate_keystrokes("down");
    let selected = panel.read_with(cx, |p, _| p.selected());
    assert_ne!(first, selected, "seed has more than one matching row");
    let before = panel.read_with(cx, |p, _| p.v3_groups().unwrap().to_vec());
    for (lib, book) in [(&ws, &books[1]), (&other, &other_books[0])] {
        let doc = format!("material:{}", material(lib, book));
        replace_first(lib, &doc, "G4Unrelated");
        lib.library().reindex_doc(&doc).unwrap();
        call(
            lib,
            "entry.update",
            json!({"book":book,"id":chapter(lib, book),"title":"G4 unrelated title"}),
        );
    }
    pump(cx);
    panel.read_with(cx, |p, _| {
        assert!(!p.is_searching());
        assert_eq!(p.selected(), selected);
        assert_eq!(p.v3_groups().unwrap(), before);
    });
}

#[gpui::test]
fn same_book_unrelated_index_preserves_the_selected_destination(cx: &mut TestAppContext) {
    let (_dir, ws, books) = fixture();
    let book = &books[0];
    let entries = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let chapters: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["template"] == "tpl-chapter")
        .take(2)
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(chapters.len(), 2);
    for entry in &chapters {
        let doc = format!("body:{entry}/mod-prose");
        replace_first(&ws, &doc, "G4KeepSelection");
        ws.library().reindex_doc(&doc).unwrap();
    }
    let (panel, cx) = setup(cx, &ws, book);
    panel.update_in(cx, |p, window, cx| {
        p.set_query("G4KeepSelection", cx);
        p.focus(window, cx);
    });
    wait(&panel, cx, |p| !p.is_searching());
    cx.simulate_keystrokes("down");
    let before = panel.read_with(cx, |p, _| p.v3_groups().unwrap().to_vec());
    let selected = panel.read_with(cx, |p, _| p.selected());
    assert_eq!(selected, Some(dr_view_search::Line::Hit(1, 0)));
    let expected = dr_view_search::v3::jump(&before[1], before[1].rows.first());
    let notified = Rc::new(Cell::new(0));
    let events = Rc::new(RefCell::new(Vec::new()));
    cx.update(|_, cx| {
        let notified = notified.clone();
        cx.observe(&panel, move |_, _| notified.set(notified.get() + 1))
            .detach();
        let events = events.clone();
        cx.subscribe(&panel, move |_, event: &dr_view_search::SearchEvent, _| {
            events.borrow_mut().push(event.clone())
        })
        .detach();
    });
    let unrelated = format!("material:{}", material(&ws, book));
    replace_first(&ws, &unrelated, "G4UnrelatedBody");
    ws.library().reindex_doc(&unrelated).unwrap();
    assert_eq!(
        dr_view_search::v3::search(&ws, book, "G4KeepSelection", 500).unwrap(),
        before
    );
    wait(&panel, cx, |p| notified.get() > 0 && !p.is_searching());
    assert_eq!(panel.read_with(cx, |p, _| p.selected()), selected);
    cx.simulate_keystrokes("enter");
    assert_eq!(
        *events.borrow(),
        [dr_view_search::SearchEvent::JumpV3(expected.clone())]
    );

    // Removing a preceding group shifts row indices, but the selected
    // entry/module/paragraph still exists and Enter must keep its target.
    call(&ws, "entry.trash", json!({"book":book,"id":chapters[0]}));
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap().len() == 1
    });
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected()),
        Some(dr_view_search::Line::Hit(0, 0))
    );
    cx.simulate_keystrokes("enter");
    assert_eq!(
        events.borrow().last(),
        Some(&dr_view_search::SearchEvent::JumpV3(expected))
    );

    // A new matching material must not steal the selection. If the chosen
    // entry is subsequently removed, Enter is inert until explicit input.
    replace_first(&ws, &unrelated, "G4KeepSelection");
    ws.library().reindex_doc(&unrelated).unwrap();
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap().len() == 2
    });
    call(&ws, "entry.trash", json!({"book":book,"id":chapters[1]}));
    wait(&panel, cx, |p| {
        !p.is_searching() && p.v3_groups().unwrap().len() == 1
    });
    assert_eq!(panel.read_with(cx, |p, _| p.selected()), None);
    let previous_events = events.borrow().len();
    cx.simulate_keystrokes("enter");
    assert_eq!(events.borrow().len(), previous_events);
    cx.simulate_keystrokes("down");
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected()),
        Some(dr_view_search::Line::Hit(0, 0))
    );
    cx.simulate_keystrokes("enter");
    assert_eq!(
        events.borrow().last(),
        Some(&dr_view_search::SearchEvent::JumpV3(
            dr_view_search::v3::Jump {
                target: Target::Material(material(&ws, book)),
                line: Some(1)
            }
        ))
    );
}
