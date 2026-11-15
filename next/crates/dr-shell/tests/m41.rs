//! M41 in the shell over a real library (《慢钟》): the export dialogs open
//! in the workspace's dialog slot from a chapter and from the whole book,
//! read the book, and go away when they close.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_export::{ExportDialog, Request};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&book).unwrap()).unwrap();
    lib.close().unwrap();
    let ws = Library::open_dir(&root, VERSION).unwrap();
    (dir, ws)
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait_for(&view, cx, |ws, _| !ws.book.is_empty());
    (view, cx)
}

fn wait_for(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace, &gpui::App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if cx.update(|_, cx| done(view.read(cx), cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn dialog(ws: &Workspace) -> Option<Entity<ExportDialog>> {
    ws.dialog
        .clone()
        .and_then(|d| d.downcast::<ExportDialog>().ok())
}

#[gpui::test]
fn the_export_dialogs_open_over_the_workspace_and_close(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, lib);
    let third = view.update_in(cx, |ws, window, cx| {
        let id = ws.book.v3().unwrap().manuscript[2].entry.clone();
        ws.open(
            Target::Entry {
                id: id.parse().unwrap(),
                module: Some("mod-prose".parse().unwrap()),
            },
            Open::KEEP,
            cx,
        );
        ws.open_export(
            Request::Manuscript {
                chapter: Some(id.clone()),
            },
            window,
            cx,
        );
        id
    });
    assert!(
        view.read_with(cx, |ws, _| ws.covered()),
        "the dialog covers the workspace"
    );
    wait_for(&view, cx, |ws, cx| {
        dialog(ws).is_some_and(|d| d.read(cx).manuscript().is_some_and(|m| m.outline.is_some()))
    });
    let chosen = view.read_with(cx, |ws, cx| {
        dialog(ws)
            .unwrap()
            .read(cx)
            .manuscript()
            .unwrap()
            .chapters()
    });
    assert_eq!(chosen, vec![third.clone()]);
    // Closing drops it.
    let d = view.read_with(cx, |ws, _| dialog(ws).unwrap());
    d.update(cx, |d, cx| d.close(cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |ws, _| ws.dialog.is_none()));
}

#[gpui::test]
fn bookless_project_blocks_manuscript_export_dialog(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let books = lib
        .call(
            &dr_workspace::Actor::User,
            "book.list",
            serde_json::json!({}),
        )
        .unwrap()["output"]
        .clone();
    let book_id = books[0]["id"].as_str().unwrap().to_owned();
    lib.call(
        &dr_workspace::Actor::User,
        "project.update",
        serde_json::json!({"book": book_id, "has_book": false}),
    )
    .unwrap();

    let (view, cx) = setup(cx, lib);
    wait_for(&view, cx, |ws, _| {
        ws.book.v3().is_some_and(|v| v.project.book.is_none())
    });

    view.update_in(cx, |ws, window, cx| {
        let root_id = ws.book.v3().unwrap().roots[0].clone();
        ws.open(Target::Book(root_id.parse().unwrap()), Open::KEEP, cx);
        ws.open_export(Request::Manuscript { chapter: None }, window, cx);
    });
    cx.run_until_parked();
    assert!(
        view.read_with(cx, |ws, _| ws.dialog.is_none() && !ws.covered()),
        "manuscript export dialog must not open when project.book is disabled"
    );
}
