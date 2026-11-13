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
    let book = out(&ws, "project.create", json!({"name": "慢钟"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &ws,
        "entry.create",
        json!({"book": book, "parent": dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-manuscript"), "template": "tpl-chapter", "title": "一", "bodies": {"mod-prose": "钟停了。"}}),
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

fn stored_zip(name: &[u8], body: &[u8]) -> Vec<u8> {
    let mut crc = !0u32;
    for &b in body {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 * (crc & 1));
        }
    }
    let crc = !crc;
    let len = body.len() as u32;
    let nlen = name.len() as u16;
    let mut out = Vec::new();
    out.extend_from_slice(b"PK\x03\x04");
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&nlen.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(name);
    out.extend_from_slice(body);
    let cd_offset = out.len() as u32;
    out.extend_from_slice(b"PK\x01\x02");
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&nlen.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(name);
    let cd_size = out.len() as u32 - cd_offset;
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[gpui::test]
fn a_format_3_book_file_is_refused_without_writing_anything(cx: &mut TestAppContext) {
    assert_eq!(dr_export::book_file::FORMAT_VERSION, 4);
    let (dir, lib, _) = library();
    let docs_before = lib.library().docs(None, None).unwrap().len();
    let (view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("format3.driftingbook");
    std::fs::write(
        &file,
        stored_zip(
            b"manifest.json",
            br#"{"format":"drifting.book","formatVersion":3}"#,
        ),
    )
    .unwrap();
    let dialog = cx.cx.update(|cx| book::import_path(lib.clone(), file, cx));
    assert!(shown(&view, cx).is_some());
    wait_for(cx, |cx| !dialog.read_with(cx, |d, _| d.is_working()));
    let state = dialog.read_with(cx, |d, _| d.state.clone());
    let State::Failed { title, reason, .. } = state else {
        panic!("{state:?}")
    };
    use dr_i18n::keys::project_picker::book_transfer as k;
    assert_eq!((title, reason), (k::IMPORT_FAILED_TITLE, k::OLDER));
    assert_eq!(books(&lib), 1);
    assert_eq!(lib.library().docs(None, None).unwrap().len(), docs_before);
    cx.cx.update(|cx| dialog.update(cx, |d, cx| d.close(cx)));
    cx.run_until_parked();
    assert!(shown(&view, cx).is_none());
}

#[gpui::test]
fn a_v3_book_uses_the_same_save_and_import_flow(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = Library::open(&root, library_options(VERSION)).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = seed.books[0].book_id().to_string();
    let title = seed.books[0].book.view().meta().name;
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let lib = Lib::open_dir(&root, VERSION).unwrap();
    let before = dr_testkit::seed::digest_v3(lib.library(), &id).unwrap();
    let (view, cx) = setup(cx, lib.clone());
    let file = dir.path().join("v3.driftingbook");
    assert_eq!(dr_export::book_file::book_title(&lib, &id).unwrap(), title);
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
    assert!(shown(&view, cx).is_none());
    let old: std::collections::HashSet<_> = lib
        .library()
        .docs(None, Some("book"))
        .unwrap()
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    let _dialog = cx.cx.update(|cx| book::import_path(lib.clone(), file, cx));
    wait_for(cx, |cx| shown(&view, cx).is_none());
    let new = lib
        .library()
        .docs(None, Some("book"))
        .unwrap()
        .into_iter()
        .find(|d| !old.contains(&d.doc_id))
        .unwrap();
    assert_eq!(
        dr_testkit::seed::digest_v3(lib.library(), new.doc_id.strip_prefix("book:").unwrap())
            .unwrap(),
        before
    );
    lib.close();
}
