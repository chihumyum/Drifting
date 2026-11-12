//! The window reads the book's lists again when the book's content changed,
//! not for every commit to its document: the writing-day recorder commits
//! once a minute and every saved entry checkpoint commits once, and neither
//! changes anything the lists hold.
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as Shell};
use dr_workspace::{Actor, Workspace};
use gpui::VisualTestContext;
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn seed() -> (tempfile::TempDir, Workspace, String) {
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

/// Lets the holder threads' events reach the window, several times over.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..12 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    cx.run_until_parked();
}

#[gpui::test]
fn a_writing_day_or_a_saved_checkpoint_does_not_read_the_book_again(cx: &mut gpui::TestAppContext) {
    let (_dir, lib, id) = seed();
    let doc = format!("book:{id}");
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
                book: Some(id.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    let wait = |cx: &mut VisualTestContext, what: &str, done: &dyn Fn(&Shell) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.run_until_parked();
            if view.read_with(cx, |ws, _| done(ws)) {
                break;
            }
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    wait(cx, "the book is read when the window opens", &|ws| {
        ws.book.v3().is_some()
    });
    settle(cx);
    let (reads, snapshot, revision, chapter) = view.read_with(cx, |ws, _| {
        let b = ws.book.v3().unwrap();
        (
            ws.book_reads,
            ws.book.clone(),
            b.revision.clone(),
            b.entries
                .iter()
                .find(|e| e.template.as_deref() == Some("tpl-chapter"))
                .unwrap()
                .id
                .to_string(),
        )
    });
    assert_eq!(lib.version(&doc).unwrap(), revision);

    // Commits to the book document that are none of its content: this
    // device's writing day, an automatic checkpoint of a chapter, one the
    // author saved. Each moves the document's version on. (What arrives
    // from another device is told apart the same way: dr-workspace's
    // `changes_from_another_device_are_told_apart_the_same_way`.)
    let mut commits = 0;
    let mut moved = |what: &str, before: String| {
        assert_ne!(lib.version(&doc).unwrap(), before, "{what}");
        commits += 1;
    };
    for words in [40, 95, 130] {
        let before = lib.version(&doc).unwrap();
        call(
            &lib,
            "writing_day.record",
            json!({"book": id, "device": "device-000000000000000000000001",
                "day": "2026-11-12", "words": words}),
        );
        moved("a writing day", before);
    }
    let before = lib.version(&doc).unwrap();
    call(
        &lib,
        "entry_snapshot.capture",
        json!({"book": id, "entry": chapter, "reason": "close"}),
    );
    moved("a saved checkpoint", before);
    let before = lib.version(&doc).unwrap();
    call(
        &lib,
        "entry_snapshot.create",
        json!({"book": id, "entry": chapter}),
    );
    moved("a checkpoint the author saved", before);
    assert_eq!(commits, 5);

    settle(cx);
    view.read_with(cx, |ws, _| {
        assert_eq!(
            ws.book_reads, reads,
            "commits that are not content read the book again"
        );
        assert!(Rc::ptr_eq(&ws.book, &snapshot), "the lists were replaced");
        assert_eq!(ws.book.v3().unwrap().revision, revision);
    });
    assert_ne!(lib.version(&doc).unwrap(), revision);

    // The book's content: read again, once, and the lists carry the change
    // (and are as new as the document, writing days and checkpoint included).
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": chapter, "title": "Synthetic renamed"}),
    );
    wait(cx, "a renamed chapter reaches the window", &|ws| {
        ws.book.v3().is_some_and(|b| {
            b.entries
                .iter()
                .any(|e| e.id.as_str() == chapter && e.title == "Synthetic renamed")
        })
    });
    settle(cx);
    view.read_with(cx, |ws, _| {
        assert_eq!(ws.book_reads, reads + 1);
        assert!(!Rc::ptr_eq(&ws.book, &snapshot));
        assert_eq!(
            ws.book.v3().unwrap().revision,
            lib.version(&doc).unwrap(),
            "the lists are read at the document's latest version"
        );
    });
}
