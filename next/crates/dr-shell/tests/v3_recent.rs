//! The shell records actual front-page identity through the typed v3 API.
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    book::Book,
    nav::{Open, Target},
};
use dr_workspace::{Actor, Workspace as Library, commands::v3::recent};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn fixture() -> (tempfile::TempDir, Library, Vec<String>) {
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
    let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, lib, books)
}

fn chapter(lib: &Library, book: &str) -> String {
    call(lib, "entry.list", json!({"book":book,"all":true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn list(lib: &Library, book: &str) -> Vec<recent::RecentEntry> {
    lib.run::<recent::RecentList>(
        &Actor::User,
        recent::RecentListIn {
            book: book.into(),
            limit: None,
        },
    )
    .unwrap()
    .output
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "recent page was not recorded");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.into()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        )
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| view.read_with(cx, |ws, _| ws.book.v3().is_some()));
    (view, cx)
}

fn open(view: &Entity<Workspace>, cx: &mut VisualTestContext, key: &str) {
    view.update(cx, |ws, cx| {
        ws.open(Target::from_key(key).unwrap(), Open::KEEP, cx)
    });
    // Render each navigation before running the background recorder. Rapid
    // visits must keep this order even when the worker has not started yet.
    draw(cx);
}

fn entry(id: &str, module: Option<&str>) -> recent::Target {
    recent::Target {
        kind: "entry".into(),
        id: id.into(),
        module: module.map(Into::into),
    }
}

#[gpui::test]
fn front_pages_keep_modules_visit_order_and_navigation_is_read_only(cx: &mut TestAppContext) {
    let (_dir, lib, books) = fixture();
    let book = &books[0];
    let id = chapter(&lib, book);
    let body = call(
        &lib,
        "module.read_prose",
        json!({"book":book,"owner":id,"module":"mod-prose"}),
    );
    call(
        &lib,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter","module":{"id":"second-body","kind":"prose","name":"Second body"}}),
    );
    call(
        &lib,
        "module.set_prose",
        json!({"book":book,"owner":id,"module":"second-body","paragraphs":[{"text":body["paragraphs"][0]["text"]}]}),
    );
    let snapshot = Book::load(&lib, book).unwrap();
    let material = snapshot
        .v3()
        .unwrap()
        .materials
        .iter()
        .find(|m| m.kind == "text")
        .unwrap()
        .id
        .clone();
    let before = lib.observe(&format!("book:{book}")).unwrap().version;
    let (view, cx) = setup(cx, &lib, book);
    let whole = format!("entry:{id}");
    let first = format!("entry:{id}/mod-prose");
    let second = format!("entry:{id}/second-body");
    let note = format!("material:{material}");
    for key in [&whole, &first, &second, &note] {
        open(&view, cx, key);
    }
    wait(cx, |_| list(&lib, book).len() == 4);
    let expected = vec![
        recent::Target {
            kind: "material".into(),
            id: material,
            module: None,
        },
        entry(&id, Some("second-body")),
        entry(&id, Some("mod-prose")),
        entry(&id, None),
    ];
    assert_eq!(
        list(&lib, book)
            .iter()
            .map(|r| r.target.clone())
            .collect::<Vec<_>>(),
        expected
    );

    // Flattened book views and template tabs are not forged into a page sentinel.
    assert!(Target::from_key("book").is_none());
    let book_view = format!("book:{}", snapshot.v3().unwrap().roots[0]);
    let untouched = list(&lib, book);
    for key in [book_view.as_str(), "template:tpl-chapter"] {
        open(&view, cx, key);
    }
    cx.run_until_parked();
    assert_eq!(list(&lib, book), untouched);
    // Revisiting the same entry with another selected body updates only its
    // exact target, retaining both bodies and the whole-entry visit.
    open(&view, cx, &first);
    wait(cx, |_| {
        list(&lib, book)
            .first()
            .is_some_and(|r| r.target == entry(&id, Some("mod-prose")))
    });
    assert_eq!(list(&lib, book).len(), 4);
    assert_eq!(
        lib.observe(&format!("book:{book}")).unwrap().version,
        before
    );
    assert!(list(&lib, &books[1]).is_empty());
}

#[gpui::test]
fn switching_books_keeps_each_queued_visit_with_its_original_book(cx: &mut TestAppContext) {
    let (_dir, lib, books) = fixture();
    let a = &books[0];
    let b = &books[1];
    let one = chapter(&lib, a);
    let two = chapter(&lib, b);
    let before_a = lib.observe(&format!("book:{a}")).unwrap().version;
    let before_b = lib.observe(&format!("book:{b}")).unwrap().version;
    let (view, cx) = setup(cx, &lib, a);
    open(&view, cx, &format!("entry:{one}/mod-prose"));
    view.update_in(cx, |ws, w, cx| ws.open_book(b, w, cx));
    wait(cx, |cx| {
        view.read_with(cx, |ws, _| ws.book_id == *b && ws.book.v3().is_some())
    });
    open(&view, cx, &format!("entry:{two}/mod-prose"));
    wait(cx, |_| {
        !list(&lib, a).is_empty() && !list(&lib, b).is_empty()
    });
    assert_eq!(list(&lib, a)[0].target, entry(&one, Some("mod-prose")));
    assert_eq!(list(&lib, b)[0].target, entry(&two, Some("mod-prose")));
    view.update_in(cx, |ws, w, cx| ws.open_book(a, w, cx));
    wait(cx, |cx| {
        view.read_with(cx, |ws, _| ws.book_id == *a && ws.book.v3().is_some())
    });
    open(&view, cx, &format!("entry:{one}"));
    wait(cx, |_| {
        list(&lib, a)
            .first()
            .is_some_and(|r| r.target == entry(&one, None))
    });
    assert!(
        list(&lib, a)
            .iter()
            .all(|r| r.book == *a && r.target.id == one)
    );
    assert_eq!(list(&lib, b).len(), 1);
    assert_eq!(list(&lib, b)[0].book, *b);
    assert_eq!(lib.observe(&format!("book:{a}")).unwrap().version, before_a);
    assert_eq!(lib.observe(&format!("book:{b}")).unwrap().version, before_b);
}
