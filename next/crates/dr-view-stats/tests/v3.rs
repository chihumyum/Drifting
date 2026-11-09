use dr_view_stats::{
    model::Live,
    v3::{self, Scope},
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
    let book = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    for doc in store.docs(Some(&book), None).unwrap() {
        store.reindex_doc(&doc.doc_id).unwrap();
    }
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, book)
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

#[test]
fn manuscript_uses_residence_and_live_prose_once_per_module() {
    let (_dir, ws, book) = fixture();
    let before = ws.observe(&format!("book:{book}")).unwrap().version;
    let data = v3::load(&ws, &book, Scope::Book).unwrap();
    assert!(data.leaves > 0);
    assert_eq!(data.documents.len(), data.leaves);
    assert!(
        data.documents
            .iter()
            .all(|d| d.module.as_deref() == Some("mod-prose"))
    );
    let first = data.documents[0].clone();
    let entry = first.entry.clone().unwrap();
    let one = v3::load(
        &ws,
        &book,
        Scope::Entry {
            id: entry.clone(),
            module: Some("mod-prose".into()),
        },
    )
    .unwrap();
    assert_eq!(one.documents, vec![first.clone()]);
    assert!(one.shape.unwrap().paragraphs > 0);
    assert_eq!(ws.observe(&format!("book:{book}")).unwrap().version, before);
    let baseline = data.book_words(&Live::default()).unwrap();
    call(&ws, "entry.trash", json!({"book":book,"id":entry}));
    let trashed = v3::load(&ws, &book, Scope::Book).unwrap();
    assert_eq!(trashed.leaves + 1, data.leaves);
    assert_eq!(
        trashed.book_words(&Live::default()).unwrap().words + first.metrics.unwrap().words,
        baseline.words
    );
    call(&ws, "entry.restore", json!({"book":book,"id":entry}));
    assert_eq!(
        v3::load(&ws, &book, Scope::Book)
            .unwrap()
            .book_words(&Live::default()),
        Some(baseline)
    );
    let mut live = Live::default();
    live.docs.insert(
        first.id.clone(),
        dr_text::TextMetrics { words: 7, chars: 7 },
    );
    assert_eq!(one.words(&live).unwrap().words, 7);
    assert_eq!(
        data.book_words(&live).unwrap().words,
        baseline.words - first.metrics.unwrap().words + 7
    );
    // A second pending document cannot be hidden by a ready live document.
    let mut pending = data.manuscript.clone();
    pending[1].metrics = None;
    assert!(v3::total(&pending, &live).is_none());
    ws.shutdown().unwrap();
}

#[test]
fn material_and_nonmanuscript_entry_never_fall_back_to_whole_book() {
    let (_dir, ws, book) = fixture();
    let entries = call(&ws, "entry.list", json!({"book":book,"all":true}));
    let idea = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-idea")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let book_data = v3::load(&ws, &book, Scope::Book).unwrap();
    let one = v3::load(
        &ws,
        &book,
        Scope::Entry {
            id: idea.into(),
            module: None,
        },
    )
    .unwrap();
    assert!(!one.documents.is_empty());
    assert!(
        one.documents
            .iter()
            .all(|d| !book_data.manuscript.contains(d))
    );
    let doc = ws
        .library()
        .docs(Some(&book), Some("material"))
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let material = doc.doc_id.strip_prefix("material:").unwrap();
    let mat = v3::load(&ws, &book, Scope::Material(material.into())).unwrap();
    assert_eq!(mat.documents.len(), 1);
    assert_eq!(mat.documents[0].id, doc.doc_id);
    assert_eq!(
        mat.book_words(&Live::default()),
        book_data.book_words(&Live::default())
    );
    let field = v3::load(
        &ws,
        &book,
        Scope::Entry {
            id: idea.into(),
            module: Some("mod-fields".into()),
        },
    )
    .unwrap();
    assert_eq!(field.words(&Live::default()).unwrap().words, 0);
    assert!(
        v3::load(
            &ws,
            &book,
            Scope::Entry {
                id: "missing".into(),
                module: None
            }
        )
        .is_err()
    );
    ws.shutdown().unwrap();
}

#[gpui::test]
fn changing_the_front_page_keeps_the_latest_scope(cx: &mut gpui::TestAppContext) {
    use gpui::{Context, ParentElement as _, Render, Styled as _, Window};
    use std::time::{Duration, Instant};
    struct Root {
        book: String,
        scope: Scope,
    }
    impl Render for Root {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
            gpui::div()
                .size_full()
                .child(dr_view_stats::v3_panel::panel(
                    "v3-stats-test",
                    &self.book,
                    self.scope.clone(),
                    dr_i18n::Locale::En,
                    dr_i18n::Platform::Mac,
                    None,
                    cx,
                ))
        }
    }
    let (_dir, ws, book) = fixture();
    let data = v3::load(&ws, &book, Scope::Book).unwrap();
    let selected = Scope::Entry {
        id: data.documents[0].entry.clone().unwrap(),
        module: Some("mod-prose".into()),
    };
    cx.executor().allow_parking();
    cx.update(|cx| dr_view_stats::init(Some(ws), cx));
    let (root, cx) = cx.add_window_view(move |_, _| Root {
        book,
        scope: Scope::Book,
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // Replace the requested scope while the book read is still waiting.
    root.update(cx, |r, cx| {
        r.scope = selected.clone();
        cx.notify();
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let view = cx
        .update(|_, cx| dr_view_stats::v3_panel::view("v3-stats-test", cx))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        cx.executor().advance_clock(Duration::from_millis(50));
        cx.run_until_parked();
        if view.read_with(cx, |v, _| v.loaded().is_some_and(|d| d.scope == selected)) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        view.read_with(cx, |v, _| v.loaded().unwrap().documents.len()),
        1
    );
    cx.update(|_, cx| dr_view_stats::release(cx));
    assert!(
        cx.update(|_, cx| dr_view_stats::v3_panel::view("v3-stats-test", cx))
            .is_none()
    );
}
