//! The 0.1 library import on GPUI's test platform, over the shell, the
//! bookshelf and a real library (F3 over dr-store with dr-index), with the
//! synthetic 0.1 library of dr-import-v1's tests (one book, 《阿Q正传》;
//! with or without the handoff). Nothing reads an author's library.
//!
//! - The bookshelf's entry opens the folder panel; the chosen folder is
//!   imported with progress; the summary lists the book with the words the
//!   bookshelf shows, and the book is on the bookshelf; the 0.1 database is
//!   unchanged; Esc closes the summary.
//! - Without the handoff the gate stops it with nothing written and lists the
//!   bodies by book; 取消 leaves the library empty; 「仍然导入」 imports.
//! - The same library again: the book is left alone.
//! - A folder without a 0.1 library fails, and says so.

#[path = "../../dr-import-v1/tests/common/mod.rs"]
mod common;

use std::path::Path;
use std::time::{Duration, Instant};

use dr_shell::actions::Dismiss;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_import::{LegacyImport, State};
use dr_view_shelf::{ImportLegacyLibrary, Shelf};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: VERSION,
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

/// An empty library, opened as the app opens it.
fn library() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    (dir, Library::open_dir(&root, VERSION).unwrap())
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    // F3 and the import run on their own threads.
    cx.executor().allow_parking();
    cx.update(|cx| {
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
        dr_shell::init(
            info(),
            Services {
                library: Some(library),
                ..Services::default()
            },
            file,
            cx,
        );
        dr_view_shelf::init(cx);
        dr_view_import::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}

/// Runs the app until `done` holds, at most thirty seconds.
fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn importer(cx: &mut VisualTestContext) -> Entity<LegacyImport> {
    cx.update(|_, cx| dr_view_import::importer(cx))
        .expect("init ran")
}

fn state(cx: &mut VisualTestContext) -> State {
    let import = importer(cx);
    import.read_with(cx, |i, _| i.state().clone())
}

fn shelf_of(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<Shelf> {
    view.read_with(cx, |ws, _| ws.shelf.clone())
        .expect("the bookshelf is made")
        .view
        .downcast::<Shelf>()
        .expect("the bookshelf is dr-view-shelf's")
}

/// The book names on the bookshelf, once it has read (again) and `done`
/// holds.
fn shelf_until(
    shelf: &Entity<Shelf>,
    cx: &mut VisualTestContext,
    done: impl Fn(&dr_view_shelf::data::ShelfData) -> bool,
) -> dr_view_shelf::data::ShelfData {
    wait_for(cx, |cx| {
        cx.update(|window, _| window.refresh());
        shelf.read_with(cx, |s, _| s.data.as_deref().is_some_and(&done))
    });
    shelf.read_with(cx, |s, _| s.data.as_deref().cloned().unwrap())
}

/// Starts the import of `folder` as the folder panel would.
fn start(cx: &mut VisualTestContext, folder: &Path) {
    let import = importer(cx);
    let folder = folder.to_path_buf();
    cx.update(|window, cx| import.update(cx, |i, cx| i.start(folder, window, cx)));
}

fn settled(cx: &mut VisualTestContext) -> State {
    wait_for(cx, |cx| {
        !matches!(state(cx), State::Running(_) | State::Picking)
    });
    state(cx)
}

fn sha(path: &Path) -> String {
    common::sha256_bytes(&std::fs::read(path).unwrap())
}

#[gpui::test]
fn the_shelf_entry_imports_a_handed_off_library(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    shelf_until(&shelf, cx, |d| d.books.is_empty());
    let old = common::build(true);
    let before = (
        sha(&old.db),
        std::fs::metadata(&old.db).unwrap().modified().unwrap(),
    );

    // The rail's entry dispatches the action; the folder panel opens.
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Picking));
    assert!(cx.did_prompt_for_paths());
    let root = old.root.clone();
    cx.simulate_path_prompt_response(move |options| {
        assert!(options.directories && !options.files && !options.multiple);
        assert_eq!(options.prompt.as_deref(), Some("选择文件夹"));
        Some(vec![root])
    });
    // It runs (one book is quick: the reports may all land in one batch);
    // a second click while it is open does nothing.
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    assert!(!cx.did_prompt_for_paths());
    let State::Done(done) = settled(cx) else {
        panic!("not done: {:?}", state(cx))
    };
    assert_eq!(done.folder, "app-local-data");
    assert_eq!(done.books.len(), 1);
    let book = &done.books[0];
    assert_eq!(
        (book.name.as_str(), book.status.as_str()),
        ("阿Q正传", "imported")
    );
    assert_eq!(done.from_caches, 0);
    assert!(done.left.is_empty());

    // On the bookshelf, with the words the summary shows.
    let data = shelf_until(&shelf, cx, |d| d.books.iter().any(|b| b.name == "阿Q正传"));
    let on_shelf = data.books.iter().find(|b| b.name == "阿Q正传").unwrap();
    assert_eq!(Some(on_shelf.words), book.words);
    assert!(on_shelf.words > 0);
    assert!(lib.library().stale_index_docs().unwrap().is_empty());

    // The 0.1 library was only read.
    let after = (
        sha(&old.db),
        std::fs::metadata(&old.db).unwrap().modified().unwrap(),
    );
    assert_eq!(before, after);

    // Esc closes the summary.
    cx.dispatch_action(Dismiss);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));

    // The same library again: the book is left alone.
    start(cx, &old.root);
    let State::Done(again) = settled(cx) else {
        panic!("not done: {:?}", state(cx))
    };
    assert_eq!(again.books[0].status, "already-imported");
    let shelf_books = shelf_until(&shelf, cx, |d| !d.books.is_empty()).books;
    assert_eq!(shelf_books.len(), 1);
}

#[gpui::test]
fn without_the_handoff_the_gate_stops_until_import_anyway(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let root = lib.library().paths().root.clone();
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    let old = common::build(false);

    start(cx, &old.root);
    let State::Blocked(blocked) = settled(cx) else {
        panic!("not stopped: {:?}", state(cx))
    };
    // Nothing written, nothing left beside the library.
    assert!(lib.library().docs(None, None).unwrap().is_empty());
    assert!(!dr_import_v1::receipt::directory(&root).exists());
    // The bodies it cannot prove, by book.
    let titles: Vec<_> = blocked
        .gate
        .doubtful
        .iter()
        .map(|d| (d.book_name.clone().unwrap(), d.title.clone().unwrap()))
        .collect();
    assert_eq!(titles.len(), 2);
    assert!(titles.iter().all(|(book, _)| book == "阿Q正传"));

    // 取消: nothing happens.
    cx.dispatch_action(Dismiss);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
    assert!(lib.library().docs(None, None).unwrap().is_empty());

    // Again, and 「仍然导入」.
    start(cx, &old.root);
    assert!(matches!(settled(cx), State::Blocked(_)));
    let import = importer(cx);
    cx.update(|window, cx| import.update(cx, |i, cx| i.import_anyway(window, cx)));
    let State::Done(done) = settled(cx) else {
        panic!("not done: {:?}", state(cx))
    };
    assert_eq!(done.books[0].status, "imported");
    assert_eq!(done.from_caches, 2, "the two bodies came from their caches");
    shelf_until(&shelf, cx, |d| d.books.iter().any(|b| b.name == "阿Q正传"));
}

#[gpui::test]
fn a_folder_without_a_library_fails(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let (_view, cx) = setup(cx, library);
    let empty = tempfile::tempdir().unwrap();
    start(cx, empty.path());
    let State::Failed(failed) = settled(cx) else {
        panic!("not failed: {:?}", state(cx))
    };
    assert!(
        failed.message.contains("not a Drifting 0.1 library"),
        "{}",
        failed.message
    );
    cx.dispatch_action(Dismiss);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));

    // Cancelling the folder panel opens nothing.
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    cx.simulate_path_prompt_response(|_| None);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
}

/// A library opened as the app opens it (F7's `library.rs`): with this
/// device's identity, made fresh in a temporary folder.
fn library_with_device() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let mut o = dr_workspace::library_options(VERSION);
    o.device = Some(dr_store::Device::open(dir.path().join("device")).unwrap());
    let lib = dr_store::Library::open(dir.path().join("library"), o).unwrap();
    let ws = Library::open(lib, dr_workspace::WorkspaceOptions::default()).unwrap();
    (dir, ws)
}

fn look_in(cx: &mut VisualTestContext, dir: &Path) {
    let import = importer(cx);
    let dir = dir.to_path_buf();
    cx.update(|_, cx| import.update(cx, |i, _| i.look_in(Some(dir))));
}

/// A second, empty book in the synthetic library, created after the first.
fn add_second_book(old: &common::Old) {
    let conn = rusqlite::Connection::open(&old.db).unwrap();
    conn.execute(
        "INSERT INTO project (id, name, summary, kv_json, storyline_template_kv_json, user_id, created_at, updated_at, deleted_at)
         VALUES ('01900000-0000-7000-8000-000000000002', '第二本', '', '[]', '[]', 'local', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', NULL)",
        [],
    )
    .unwrap();
}

#[gpui::test]
fn the_local_libraries_are_listed_and_the_device_takes_over_their_identity(
    cx: &mut TestAppContext,
) {
    let (_dir, library) = library_with_device();
    let lib = library.clone();
    let fresh = lib.writing_device().expect("opened with a device");
    let (view, cx) = setup(cx, library);
    let shelf = shelf_of(&view, cx);
    // The 0.1 data folder: the synthetic library is its `legacy` one.
    let old = common::build(true);
    look_in(cx, &old.root);

    // Listed, no folder panel; Esc closes the list.
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    assert!(!cx.did_prompt_for_paths());
    let State::Found(found) = state(cx) else {
        panic!("not listed: {:?}", state(cx))
    };
    assert_eq!(found.libraries.len(), 1);
    assert_eq!(found.libraries[0].picked.id.as_deref(), Some("legacy"));
    assert_eq!(found.libraries[0].picked.root, old.root);
    assert!(found.libraries[0].modified_ms.is_some());
    cx.dispatch_action(Dismiss);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));

    // 「选择文件夹」 from the list: the panel; cancelled, nothing is open.
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    let import = importer(cx);
    cx.update(|window, cx| import.update(cx, |i, cx| i.choose_folder(window, cx)));
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|_| None);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));

    // Picked from the list: imported, and this device's writing days now
    // go under the 0.1 device key.
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    cx.update(|window, cx| import.update(cx, |i, cx| i.pick(0, window, cx)));
    let State::Done(done) = settled(cx) else {
        panic!("not done: {:?}", state(cx))
    };
    assert_eq!(done.books[0].status, "imported");
    assert!(done.identity_adopted);
    let key = lib.writing_device().unwrap();
    assert_eq!(
        key,
        dr_store::identity::writing_device_key(&format!("install-{}", "ab".repeat(32)))
    );
    assert_ne!(key, fresh);
    shelf_until(&shelf, cx, |d| d.books.iter().any(|b| b.name == "阿Q正传"));
}

#[gpui::test]
fn cancelling_leaves_no_book_half_written(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let (_view, cx) = setup(cx, library);
    let old = common::build(true);
    add_second_book(&old);
    start(cx, &old.root);
    let import = importer(cx);
    cx.update(|_, cx| import.update(cx, |i, cx| i.cancel(cx)));
    if let State::Running(running) = state(cx) {
        assert!(running.cancelling);
    }
    // Cancelled before any book: nothing; else the books it got to, whole.
    let books_in_library = || {
        lib.library()
            .docs(None, Some("book"))
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect::<Vec<_>>()
    };
    match settled(cx) {
        State::Idle => assert!(books_in_library().is_empty()),
        State::Done(done) => {
            assert!(done.cancelled);
            assert!(
                done.books
                    .iter()
                    .all(|b| b.status == "imported" || b.status == "cancelled"),
                "{:?}",
                done.books
            );
            let imported = done.books.iter().filter(|b| b.status == "imported").count();
            assert_eq!(books_in_library().len(), imported);
        }
        other => panic!("{other:?}"),
    }
}

#[gpui::test]
fn quitting_stops_the_import_first(cx: &mut TestAppContext) {
    let (_dir, library) = library();
    let lib = library.clone();
    let (_view, cx) = setup(cx, library);
    let old = common::build(true);
    add_second_book(&old);
    start(cx, &old.root);
    let import = importer(cx);
    // What the shell's quit hook runs.
    cx.update(|_, cx| import.update(cx, |i, _| i.stop_for_quit()));
    assert!(!import.read_with(cx, |i, _| i.is_running()));
    // The receipt: no book left half-written (it had time to finish one).
    let statuses: Vec<String> = lib
        .library()
        .local_read(|c| {
            let mut stmt = c.prepare("SELECT status FROM import_book")?;
            let v = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(v)
        })
        .unwrap();
    assert!(statuses.iter().all(|s| s != "importing"), "{statuses:?}");
    settled(cx);
}
