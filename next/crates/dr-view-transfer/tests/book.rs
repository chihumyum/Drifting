//! `.driftingbook` from the bookshelf, in the shell over a real library
//! (GPUI's test platform): the card's export action goes through the save
//! panel and writes the file; importing it adds a second book while the
//! dialog shows how far it is, then goes; a file that is not a book is
//! refused with the 0.1 reason and nothing written.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::Library;
use dr_view_transfer::{State, TransferDialog, book};
use dr_workspace::{Actor, Workspace as Lib, WorkspaceOptions, library_options};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn out(ws: &Lib, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn library() -> (tempfile::TempDir, Lib, String) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options(VERSION)).unwrap();
    let ws = Lib::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "book.create", json!({"name": "慢钟"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &ws,
        "chapter.create",
        json!({"book": book, "title": "一", "text": "钟停了。"}),
    );
    (dir, ws, book)
}

fn setup(cx: &mut TestAppContext, lib: Lib) -> (Entity<Workspace>, &mut VisualTestContext) {
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
                library: Some(lib),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_transfer::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait_for(cx, |cx| cx.read(|cx| !view.read(cx).book.is_empty()));
    (view, cx)
}

fn wait_for(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn shown(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> Option<Entity<TransferDialog>> {
    cx.read(|cx| {
        view.read(cx)
            .dialog
            .clone()
            .and_then(|d| d.downcast::<TransferDialog>().ok())
    })
}

fn books(lib: &Lib) -> usize {
    out(lib, "book.list", json!({})).as_array().unwrap().len()
}

#[gpui::test]
fn a_book_is_exported_from_its_card_and_imported_again(cx: &mut TestAppContext) {
    let (dir, lib, id) = library();
    let (view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("慢钟.driftingbook");

    // The card's export icon: the save panel, then the file.
    cx.update(|window, cx| {
        window.dispatch_action(Box::new(dr_view_shelf::ExportBook { book: id.clone() }), cx)
    });
    cx.run_until_parked();
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection({
        let file = file.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| file.exists());
    assert!(
        shown(&view, cx).is_none(),
        "an export that worked says nothing"
    );

    // Importing it: a dialog while it runs, then a second book.
    // From the app (as after the file panel), not inside a window update.
    let dialog = cx
        .cx
        .update(|cx| book::import_path(lib.clone(), file.clone(), cx));
    assert!(shown(&view, cx).is_some());
    wait_for(cx, |cx| shown(&view, cx).is_none());
    assert_eq!(books(&lib), 2);
    let _ = dialog;
}

#[gpui::test]
fn a_file_that_is_not_a_book_is_refused(cx: &mut TestAppContext) {
    let (dir, lib, _) = library();
    let (view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("notes.driftingbook");
    std::fs::write(&file, "just text").unwrap();
    let dialog = cx.cx.update(|cx| book::import_path(lib.clone(), file, cx));
    assert!(shown(&view, cx).is_some());
    wait_for(cx, |cx| !dialog.read_with(cx, |d, _| d.is_working()));
    let state = dialog.read_with(cx, |d, _| d.state.clone());
    let State::Failed { title, reason, .. } = state else {
        panic!("{state:?}")
    };
    use dr_i18n::keys::project_picker::book_transfer as k;
    assert_eq!((title, reason), (k::IMPORT_FAILED_TITLE, k::NOT_ABOOK));
    assert_eq!(books(&lib), 1);
    // 「关闭」 takes it away.
    cx.cx.update(|cx| dialog.update(cx, |d, cx| d.close(cx)));
    cx.run_until_parked();
    assert!(shown(&view, cx).is_none());
}
