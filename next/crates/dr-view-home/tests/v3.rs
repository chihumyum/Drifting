use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace, book::Book};
use dr_view_home::v3::{self, Home};
use dr_workspace::{Actor, Workspace as Library, WritePreconditions};
use gpui::{Entity, Focusable, TestAppContext, VisualTestContext};
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    (dir, Library::open_dir(&root, "test").unwrap(), book)
}

fn change_action(lib: &Library, book: &str, action: &v3::CreateAction) {
    let observed = lib.observe(&format!("book:{book}")).unwrap();
    let snapshot = Book::load(lib, book).unwrap();
    let mut template = snapshot
        .v3()
        .unwrap()
        .template_of(&action.level)
        .unwrap()
        .clone();
    template.verbs.retain(|verb| verb.id != action.id);
    lib.call_guarded(
        &Actor::User,
        "entry_template.put",
        json!({"book":book,"template":template}),
        WritePreconditions::from_observations([observed]),
    )
    .unwrap();
}

#[test]
fn template_actions_create_independent_entries_and_keep_hidden_content() {
    let (_dir, lib, book) = fixture();
    let before = Book::load(&lib, &book).unwrap();
    let action = v3::actions(&before)
        .into_iter()
        .find(|a| a.template.as_deref() == Some("tpl-chapter"))
        .unwrap();
    let entry = before
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap();
    lib.call(
        &Actor::User,
        "entry.trash",
        json!({"book":book,"id":entry.id}),
    )
    .unwrap();
    let hidden = lib
        .call(
            &Actor::User,
            "entry.get",
            json!({"book":book,"id":entry.id}),
        )
        .unwrap()["output"]
        .clone();
    let a = v3::create(&lib, &book, &action, &format!("{} A", entry.title)).unwrap();
    let b = v3::create(&lib, &book, &action, &format!("{} B", entry.title)).unwrap();
    assert_ne!(a, b);
    let after = Book::load(&lib, &book).unwrap();
    for id in [&a, &b] {
        let e = after.v3().unwrap().entry(id).unwrap();
        assert_eq!(e.template, action.template);
        assert_eq!(e.parent.as_deref(), Some(action.level.as_str()));
    }
    assert_eq!(
        lib.call(
            &Actor::User,
            "entry.get",
            json!({"book":book,"id":entry.id})
        )
        .unwrap()["output"],
        hidden
    );
    change_action(&lib, &book, &action);
    let count = Book::load(&lib, &book).unwrap().v3().unwrap().entries.len();
    assert!(matches!(
        v3::create(&lib, &book, &action, &entry.title),
        Err(dr_workspace::WsError::Conflict(_))
    ));
    assert_eq!(
        Book::load(&lib, &book).unwrap().v3().unwrap().entries.len(),
        count
    );
    lib.close();
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            break;
        }
        assert!(Instant::now() < deadline, "home timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

#[gpui::test]
fn home_registration_and_failed_create_keep_the_title_draft(cx: &mut TestAppContext) {
    let (_dir, lib, book) = fixture();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_home::init(cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    wait(cx, "workspace", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == book && ws.v3_home.is_some())
    });
    let home: Entity<Home> = ws.read_with(cx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(cx, "numbers", |cx| {
        home.read_with(cx, |h, _| h.loaded.is_some())
    });
    let action = v3::actions(&Book::load(&lib, &book).unwrap())
        .into_iter()
        .find(|a| a.template.as_deref() == Some("tpl-chapter"))
        .unwrap();
    let dialog = cx.update(|window, cx| {
        home.update(cx, |h, cx| {
            h.ask_create(action.clone(), window, cx).unwrap()
        })
    });
    let title = dialog.read_with(cx, |d, _| d.title.clone());
    cx.update(|window, cx| {
        title.update(cx, |f, cx| f.set_text("Synthetic entry", cx));
        title.read(cx).focus_handle(cx).focus(window, cx);
    });
    change_action(&lib, &book, &action);
    cx.update(|window, cx| dialog.update(cx, |d, cx| d.submit(window, cx)));
    wait(cx, "create conflict", |cx| {
        dialog.read_with(cx, |d, _| !d.busy && d.error.is_some())
    });
    assert_eq!(title.read_with(cx, |f, _| f.text()), "Synthetic entry");
    assert!(ws.read_with(cx, |ws, _| ws.dialog.is_some()));
    lib.close();
}
