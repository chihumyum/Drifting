use dr_view_search::{
    model::Field,
    v3::{self, Target},
};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn fixture() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

#[test]
fn module_identity_survives_search_retention_and_navigation() {
    let (_dir, ws, book) = fixture();
    let entries = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let chapter = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap();
    let entry = chapter["id"].as_str().unwrap();
    let source = call(
        &ws,
        "module.read_prose",
        json!({"book":book,"owner":entry,"module":"mod-prose"}),
    );
    let paragraph = source["paragraphs"][0]["text"].as_str().unwrap();
    let query: String = paragraph.trim().chars().take(4).collect();
    assert!(!query.is_empty());
    call(
        &ws,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter","module":{"id":"second-body","kind":"prose","name":"Second body"}}),
    );
    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":"second-body","paragraphs":[{"text":paragraph}]}),
    );
    for doc in ws.library().docs(Some(&book), None).unwrap() {
        ws.library().reindex_doc(&doc.doc_id).unwrap();
    }
    let before = ws.observe(&format!("book:{book}")).unwrap().version;
    let found = v3::search(&ws, &book, &query, 500).unwrap();
    for module in ["mod-prose", "second-body"] {
        let group = found
            .iter()
            .find(|g| {
                g.target
                    == Target::Entry {
                        id: entry.into(),
                        module: Some(module.into()),
                    }
            })
            .unwrap();
        let body = group.rows.iter().find(|r| r.field == Field::Body).unwrap();
        let jump = v3::jump(group, Some(body));
        assert_eq!(jump.target, group.target);
        assert_eq!(jump.line, body.paragraph.map(|p| p * 2 + 1));
        assert_eq!(
            body.snippet[body.highlight.clone()].to_lowercase(),
            query.to_lowercase()
        );
    }
    assert_eq!(ws.observe(&format!("book:{book}")).unwrap().version, before);
    call(
        &ws,
        "entry_template.remove_module",
        json!({"book":book,"template":"tpl-chapter","module":"second-body"}),
    );
    assert!(
        v3::search(&ws, &book, &query, 500)
            .unwrap()
            .iter()
            .any(|g| g.target
                == Target::Entry {
                    id: entry.into(),
                    module: Some("second-body".into())
                })
    );
    call(&ws, "entry.trash", json!({"book":book,"id":entry}));
    assert!(
        !v3::search(&ws, &book, &query, 500)
            .unwrap()
            .iter()
            .any(|g| matches!(&g.target, Target::Entry { id, .. } if id == entry))
    );
    call(&ws, "entry.restore", json!({"book":book,"id":entry}));
    assert!(
        v3::search(&ws, &book, &query, 500)
            .unwrap()
            .iter()
            .any(|g| g.target
                == Target::Entry {
                    id: entry.into(),
                    module: Some("second-body".into())
                })
    );
    ws.shutdown().unwrap();
}

#[test]
fn titles_limit_empty_and_legacy_version_are_explicit() {
    let (_dir, ws, book) = fixture();
    let entries = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let title = entries[0]["title"].as_str().unwrap();
    let before = ws.observe(&format!("book:{book}")).unwrap().version;
    let found = v3::search(&ws, &book, title, 1).unwrap();
    assert_eq!(found.iter().map(|g| g.rows.len()).sum::<usize>(), 1);
    assert_eq!(found[0].rows[0].field, Field::Title);
    assert!(v3::search(&ws, &book, " ", 1).unwrap().is_empty());
    assert!(v3::search(&ws, &book, title, 0).unwrap().is_empty());
    assert_eq!(ws.observe(&format!("book:{book}")).unwrap().version, before);
    let old = call(
        &ws,
        "book.create",
        json!({"name":"Synthetic compatibility"}),
    );
    assert!(v3::search(&ws, old["id"].as_str().unwrap(), title, 1).is_err());
    assert!(
        ws.call(
            &Actor::User,
            "book.search",
            json!({"book":old["id"],"query":title})
        )
        .is_ok()
    );
    ws.shutdown().unwrap();
}

#[test]
fn hidden_bodies_do_not_consume_the_live_result_cap() {
    let (_dir, ws, book) = fixture();
    let entries = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let chapters: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["template"] == "tpl-chapter")
        .take(2)
        .collect();
    assert_eq!(chapters.len(), 2);
    let source = call(
        &ws,
        "module.read_prose",
        json!({"book":book,"owner":chapters[0]["id"],"module":"mod-prose"}),
    );
    let text = source["paragraphs"][0]["text"].as_str().unwrap();
    for entry in &chapters {
        call(
            &ws,
            "module.set_prose",
            json!({"book":book,"owner":entry["id"],"module":"mod-prose","paragraphs":[{"text":text}]}),
        );
    }
    for doc in ws.library().docs(Some(&book), None).unwrap() {
        ws.library().reindex_doc(&doc.doc_id).unwrap();
    }
    call(
        &ws,
        "entry.trash",
        json!({"book":book,"id":chapters[0]["id"]}),
    );
    for n in [2, 4] {
        let query: String = text.trim().chars().take(n).collect();
        let full = v3::search(&ws, &book, &query, 500).unwrap();
        assert!(!full.is_empty());
        let limited = v3::search(&ws, &book, &query, 1).unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].target, full[0].target);
        assert_eq!(limited[0].rows, full[0].rows[..1]);
        assert!(!full.iter().any(|g| matches!(&g.target, Target::Entry { id, .. } if id == chapters[0]["id"].as_str().unwrap())));
        assert!(full.iter().any(|g| matches!(&g.target, Target::Entry { id, .. } if id == chapters[1]["id"].as_str().unwrap())));
    }
    ws.shutdown().unwrap();
}

#[gpui::test]
fn v3_panel_emits_module_destination_without_a_legacy_jump(cx: &mut gpui::TestAppContext) {
    use std::{
        cell::RefCell,
        rc::Rc,
        time::{Duration, Instant},
    };
    let (_dir, ws, book) = fixture();
    for doc in ws.library().docs(Some(&book), None).unwrap() {
        ws.library().reindex_doc(&doc.doc_id).unwrap();
    }
    cx.executor().allow_parking();
    cx.update(|cx| cx.bind_keys(dr_ui::input::bindings()));
    let (panel, cx) = cx.add_window_view(move |window, cx| {
        dr_view_search::SearchPanel::new_v3(
            Some(ws),
            book,
            Rc::new(|_| (dr_ui::sand::Kind::Element, None)),
            dr_i18n::Locale::En,
            dr_i18n::Platform::Mac,
            window,
            cx,
        )
    });
    let events = Rc::new(RefCell::new(Vec::new()));
    let result = events.clone();
    cx.update(|window, cx| {
        cx.subscribe(&panel, move |_, event: &dr_view_search::SearchEvent, _| {
            result.borrow_mut().push(event.clone())
        })
        .detach();
        panel.update(cx, |p, cx| {
            p.focus(window, cx);
            p.set_query("灯", cx);
        });
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    while panel.read_with(cx, |p, _| p.is_searching()) {
        cx.run_until_parked();
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let jump = panel.read_with(cx, |p, _| {
        let g = &p.v3_groups().unwrap()[0];
        assert!(
            p.groups().is_empty(),
            "v3 results never enter legacy targets"
        );
        v3::jump(g, g.rows.first())
    });
    cx.simulate_keystrokes("enter");
    assert_eq!(
        events.borrow().as_slice(),
        &[dr_view_search::SearchEvent::JumpV3(jump)]
    );
    panel.update(cx, |p, cx| p.set_query("", cx));
    assert!(panel.read_with(cx, |p, _| p.v3_groups().unwrap().is_empty()));
}
