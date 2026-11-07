//! M41 in the shell over a real library (《慢钟》): the export dialogs open
//! in the workspace's dialog slot from a chapter and from the whole book,
//! read the book, and go away when they close.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_export::{ExportDialog, MarkdownTarget, Request};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
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
        let id = ws.book.chapters[2].id.clone();
        ws.open(Target::Chapter(id.parse().unwrap()), Open::KEEP, cx);
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

    // The whole book's share.
    view.update_in(cx, |ws, window, cx| {
        ws.open(Target::Book, Open::KEEP, cx);
        ws.open_export(Request::Markdown(MarkdownTarget::Book), window, cx);
    });
    wait_for(&view, cx, |ws, cx| {
        dialog(ws).is_some_and(|d| d.read(cx).markdown().is_some_and(|m| m.doc.is_some()))
    });
    let (markdown, documents) = view.read_with(cx, |ws, cx| {
        let doc = dialog(ws)
            .unwrap()
            .read(cx)
            .markdown()
            .unwrap()
            .doc
            .clone()
            .unwrap();
        (doc.markdown, doc.documents)
    });
    let first = view.read_with(cx, |ws, _| ws.book.chapters[0].title.clone());
    assert!(markdown.contains(&first), "the first chapter's title");
    assert!(documents >= 20, "{documents}");
}
