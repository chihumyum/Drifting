//! Kernel v5 Track P1 (`p1-reorder`): `BookV3::shown_precondition` and
//! `Workspace` object-level undo/redo routing.

use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace,
    actions::{Dismiss, OpenSettings, Redo, Undo},
    book::Book,
};
use dr_workspace::{Actor, RecordKey, Workspace};
use gpui::{App, Entity, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

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

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn wait_workspace(
    view: &Entity<ShellWorkspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&ShellWorkspace, &App) -> bool,
) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        if view.read_with(cx, |w, cx| done(w, cx)) {
            return;
        }
        assert!(Instant::now() < until, "workspace did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn shown_precondition_exposes_active_digests_for_level_children_and_entries() {
    let (_dir, ws, book_id) = seed();
    let book = Book::load(&ws, &book_id).unwrap();
    let v = book.v3().unwrap();
    let root = v.roots[0].clone();

    let roots_pre = v
        .shown_precondition(&RecordKey::children_of(None))
        .expect("roots children_of digest");
    assert!(!roots_pre.if_replaced);

    let level_pre = v
        .shown_precondition(&RecordKey::children_of(Some(&root)))
        .expect("level children_of digest");
    assert!(!level_pre.if_replaced);

    let entry_pre = v
        .shown_precondition(&RecordKey::entry(&root))
        .expect("entry digest");
    assert!(!entry_pre.if_replaced);

    assert!(
        v.shown_precondition(&RecordKey::entry("missing-entry"))
            .is_none()
    );
    ws.shutdown().unwrap();
}

#[gpui::test]
fn workspace_undo_redo_serializes_fifo_steps_and_pauses_under_covered_layers(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let (_dir, lib, book) = seed();
    let initial = Book::load(&lib, &book).unwrap();
    let manuscript = initial
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();

    let c1 = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": manuscript, "template": "tpl-chapter", "title": "Step 1"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c2 = call(
        &lib,
        "entry.create",
        json!({"book": book, "parent": manuscript, "template": "tpl-chapter", "title": "Step 2"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let created_children = Book::load(&lib, &book).unwrap().v3().unwrap().levels[&manuscript]
        .children
        .clone();

    // Two sequential moves in the same folder.
    call(
        &lib,
        "entry.move",
        json!({"book": book, "id": c1, "parent": manuscript, "index": 0}),
    );
    let after_first_move = Book::load(&lib, &book).unwrap().v3().unwrap().levels[&manuscript]
        .children
        .clone();
    call(
        &lib,
        "entry.move",
        json!({"book": book, "id": c2, "parent": manuscript, "index": 0}),
    );
    let after_second_move = Book::load(&lib, &book).unwrap().v3().unwrap().levels[&manuscript]
        .children
        .clone();
    assert_eq!(&after_second_move[..2], &[c2.clone(), c1.clone()]);

    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.clone()),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });

    let (ws, vcx) = cx.add_window_view(ShellWorkspace::new);
    vcx.update(|window, cx| {
        window.activate_window();
        let focus = ws.read(cx).focus_handle().clone();
        focus.focus(window, cx);
    });
    vcx.simulate_resize(size(px(1200.0), px(800.0)));
    wait_workspace(&ws, vcx, |w, _| w.book.v3().is_some());

    // Open Settings (`covered() == true`): dispatching Undo must NOT touch the book.
    vcx.dispatch_action(OpenSettings);
    vcx.run_until_parked();
    vcx.dispatch_action(Undo);
    vcx.run_until_parked();
    assert_eq!(
        Book::load(&lib, &book).unwrap().v3().unwrap().levels[&manuscript].children,
        after_second_move
    );
    vcx.dispatch_action(Dismiss);
    vcx.run_until_parked();

    // Dispatch two Undos back-to-back without waiting in between: FIFO queue
    // must serialize both background steps cleanly back to `created_children`.
    vcx.update(|window, cx| {
        let focus = ws.read(cx).focus_handle().clone();
        focus.focus(window, cx);
    });
    vcx.dispatch_action(Undo);
    vcx.dispatch_action(Undo);
    wait_workspace(&ws, vcx, |w, _| {
        w.book
            .v3()
            .is_some_and(|v| v.levels[&manuscript].children == created_children)
    });

    // Redo one step -> `after_first_move`; Redo second step -> `after_second_move`.
    vcx.dispatch_action(Redo);
    wait_workspace(&ws, vcx, |w, _| {
        w.book
            .v3()
            .is_some_and(|v| v.levels[&manuscript].children == after_first_move)
    });
    vcx.dispatch_action(Redo);
    wait_workspace(&ws, vcx, |w, _| {
        w.book
            .v3()
            .is_some_and(|v| v.levels[&manuscript].children == after_second_move)
    });
}
