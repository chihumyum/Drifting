//! Real GUI state/worker/release contracts on the synthetic 0.1 fixture.
//! The ordinary source chooser enters Ready; the same MappingChoices as the
//! underlying importer configure a separate target, never the active store.
#[path = "../../dr-import-v1/tests/common/mod.rs"]
mod common;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_import::{
    LegacyImport, State,
    reimport::{Destination, ResultOfImport},
};
use dr_view_shelf::ImportLegacyLibrary;
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};
use std::{
    path::Path,
    time::{Duration, Instant},
};
const VERSION: &str = "0.2.0-dev";
fn library() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let mut opts = dr_workspace::library_options(VERSION);
    opts.device = Some(dr_store::Device::open(dir.path()).unwrap());
    let lib = dr_store::Library::open(dir.path().join("library"), opts).unwrap();
    let ws = Library::open(lib, Default::default()).unwrap();
    (dir, ws)
}
fn init(cx: &mut TestAppContext, lib: Library) {
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
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_shelf::init(cx);
        dr_view_import::init(cx);
    });
}
fn setup(cx: &mut TestAppContext, lib: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    init(cx, lib);
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}
fn importer(cx: &mut VisualTestContext) -> Entity<LegacyImport> {
    cx.update(|_, cx| dr_view_import::importer(cx).unwrap())
}
fn state(cx: &mut VisualTestContext) -> State {
    importer(cx).read_with(cx, |i, _| i.state().clone())
}
fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(40);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "timed out: {:?}", state(cx));
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn settled(cx: &mut VisualTestContext) -> State {
    wait(cx, |cx| {
        !matches!(
            state(cx),
            State::Running(_) | State::Switching(_) | State::Picking
        )
    });
    state(cx)
}
fn configure(cx: &mut VisualTestContext, source: &Path) {
    let i = importer(cx);
    let source = source.to_path_buf();
    cx.update(|w, cx| i.update(cx, |i, cx| i.start(source, w, cx)));
    assert!(matches!(state(cx), State::Ready(_)));
}
fn choices(cx: &mut VisualTestContext) {
    let i = importer(cx);
    cx.update(|_, cx| {
        i.update(cx, |i, cx| {
            i.set_mapping_choices(common::v3_choices()).unwrap();
            cx.notify();
        })
    });
}
fn start(cx: &mut VisualTestContext) {
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.start_configured(w, cx)));
}
fn active(cx: &mut VisualTestContext) -> Library {
    cx.update(|_, cx| cx.global::<Services>().library.clone().unwrap())
}
fn sha(path: &Path) -> String {
    common::sha256_bytes(&std::fs::read(path).unwrap())
}

fn source_files(
    root: &Path,
) -> std::collections::BTreeMap<String, (String, u64, std::time::SystemTime)> {
    fn visit(
        root: &Path,
        path: &Path,
        out: &mut std::collections::BTreeMap<String, (String, u64, std::time::SystemTime)>,
    ) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                let meta = std::fs::metadata(&path).unwrap();
                out.insert(
                    path.strip_prefix(root).unwrap().display().to_string(),
                    (sha(&path), meta.len(), meta.modified().unwrap()),
                );
            }
        }
    }
    let mut out = Default::default();
    visit(root, root, &mut out);
    out
}

#[gpui::test]
fn pending_is_prewrite_then_explicit_choices_import_into_a_new_preferred_v3_library(
    cx: &mut TestAppContext,
) {
    let (dir, lib) = library();
    let original = lib.library().paths().root.clone();
    let old_book = dr_testkit::seed::acceptance::empty_source(lib.library());
    let untouched = lib
        .library()
        .load_copy(&format!("book:{old_book}"))
        .unwrap()
        .get_deep_value();
    let (_view, cx) = setup(cx, lib);
    // 1. Prewrite V3Pending stops before creating target or libraries.json:
    //    an idea group sharing a chapter's id (one of the cases that still
    //    refuse; the others have recorded defaults, dr-import-v1
    //    `tests/defaults.rs`).
    let bad = common::build(true);
    {
        let c = rusqlite::Connection::open(&bad.db).unwrap();
        c.execute(
            "INSERT INTO drift_group (id, project_id, name, parent_group_id, color, sort_order, created_at, updated_at) VALUES (?1, ?2, '撞号', NULL, NULL, 3, ?3, ?3)",
            [common::CHAPTER, common::BOOK, common::T0],
        )
        .unwrap();
    }
    let bad_before = source_files(&bad.root);
    configure(cx, &bad.root);
    let bad_target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    assert_ne!(bad_target, original);
    start(cx);
    let State::Ready(ready) = settled(cx) else {
        panic!("expected structured pending")
    };
    assert!(
        ready
            .pending
            .iter()
            .any(|p| p.code == "entry-id-invalid-or-colliding")
    );
    assert!(!bad_target.exists());
    assert!(!dir.path().join(dr_account::LIBRARIES_FILE).exists());
    // Accepting stale caches cannot bypass a preflight pending.
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.import_anyway(w, cx)));
    assert!(matches!(state(cx), State::Ready(_)));
    assert_eq!(bad_before, source_files(&bad.root));

    // 2. Clean 0.1 library with act drift binding now imports directly into a
    //    new preferred v3 library with default MappingChoices and creates "幕".
    let old = common::build_v3(true);
    let before = source_files(&old.root);
    configure(cx, &old.root);
    let target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    assert_ne!(target, original);
    start(cx);
    let State::Done(done) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    assert!(!done.cancelled);
    assert_eq!(done.books[0].status, "imported");
    assert!(done.books[0].words.unwrap() > 0);
    let current = active(cx);
    assert_eq!(current.library().paths().root, target);
    let snapshot = dr_shell::book::Book::load(&current, common::BOOK).unwrap();
    let v3_doc = snapshot.v3().expect("canonical v3 book");
    let act_track = v3_doc
        .entries
        .iter()
        .find(|e| e.parent.is_none() && e.template.as_deref() == Some("tpl-act-track"))
        .expect("imported act track");
    assert_eq!(act_track.title, "幕");
    assert_eq!(v3_doc.timeline_views[0].lanes[0].act_track, Some(true));
    assert!(current.library().stale_index_docs().unwrap().is_empty());
    let open_comments = current
        .call(
            &dr_workspace::Actor::User,
            "comment.list",
            serde_json::json!({"book": common::BOOK, "status": "open"}),
        )
        .unwrap()["output"]
        .clone();
    assert!(
        open_comments
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["body"]["text"] != "未庄的土谷祠"),
        "resolved material description comment must not appear in open filter: {open_comments}"
    );
    let resolved_comments = current
        .call(
            &dr_workspace::Actor::User,
            "comment.list",
            serde_json::json!({"book": common::BOOK, "status": "resolved"}),
        )
        .unwrap()["output"]
        .clone();
    let img_desc = resolved_comments
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["body"]["text"] == "未庄的土谷祠")
        .expect("material description comment in resolved list");
    assert_eq!(
        img_desc["target"],
        serde_json::json!({"kind": "asset", "id": common::ASSET})
    );
    assert!(img_desc["module"].is_null());
    assert!(img_desc["part"].is_null());
    assert_eq!(img_desc["origin"], "manual");
    assert_eq!(img_desc["author_kind"], "user");
    assert_eq!(img_desc["unlocated"], false);
    let made = current
        .call(
            &dr_workspace::Actor::User,
            "entry.create",
            serde_json::json!({"book":common::BOOK,"parent":common::CATEGORY,"title":"王胡"}),
        )
        .unwrap()["output"]
        .clone();
    let doc = format!("body:{}/mod-prose", made["id"].as_str().unwrap());
    let body = current
        .call(
            &dr_workspace::Actor::User,
            "prose.read",
            serde_json::json!({"doc":doc}),
        )
        .unwrap();
    assert_eq!(body["output"]["paragraphs"][0]["text"], "外貌");
    let registry = dr_account::LibraryRegistry::load_or_init(dir.path()).unwrap();
    assert_eq!(registry.active_library_dir(dir.path()), target);
    assert!(
        registry
            .entries
            .iter()
            .any(|e| dir.path().join(&e.path) == original)
    );
    let previous =
        dr_store::Library::open(&original, dr_workspace::library_options(VERSION)).unwrap();
    assert_eq!(
        previous
            .load_copy(&format!("book:{old_book}"))
            .unwrap()
            .get_deep_value(),
        untouched
    );
    previous.close().unwrap();
    assert_eq!(before, source_files(&old.root));
    // A new explicit reimport creates another target; receipts are not reset.
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.close(w, cx)));
    drop(current);
    configure(cx, &old.root);
    assert_ne!(
        importer(cx).read_with(cx, |i, _| i.destination().unwrap().target()),
        target
    );
}

#[gpui::test]
fn freshness_gate_keeps_the_same_choices_and_source_until_explicit_accept(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    let original = lib.library().paths().root.clone();
    let (_view, cx) = setup(cx, lib);
    let old = common::build_v3(false);
    let before = sha(&old.db);
    configure(cx, &old.root);
    choices(cx);
    start(cx);
    let State::Blocked(blocked) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    assert!(!blocked.gate.clear());
    assert_eq!(active(cx).library().paths().root, original);
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.import_anyway(w, cx)));
    let State::Done(done) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    assert!(done.from_caches > 0);
    assert_eq!(sha(&old.db), before);
}

#[gpui::test]
fn folder_selection_and_mapping_file_drive_the_same_gui_configuration(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    let (_view, cx) = setup(cx, lib);
    let old = common::build_v3(true);
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Picking));
    let source = old.root.clone();
    cx.simulate_path_prompt_response(move |p| {
        assert!(p.directories && !p.files);
        Some(vec![source])
    });
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Ready(_)));
    cx.update(|w, cx| w.draw(cx).clear(cx));
    let view_src = include_str!("../src/view.rs");
    assert!(
        !view_src.contains("\"v3-import-mapping\"") && !view_src.contains("r.target.display()"),
        "ordinary Ready dialog must not expose MappingChoices JSON button or raw target path"
    );
    let path = dir.path().join("explicit-synthetic-choices.json");
    std::fs::write(&path, serde_json::to_vec(&common::v3_choices()).unwrap()).unwrap();
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.choose_mapping(w, cx)));
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(move |p| {
        assert!(p.files && !p.directories);
        Some(vec![path])
    });
    cx.run_until_parked();
    assert!(matches!(state(cx),State::Ready(r) if r.explicit_choices));
    start(cx);
    assert!(matches!(settled(cx), State::Done(_)));
}

/// A 0.1 data folder with one local library (the list reads the registry
/// and the files' times only).
fn v1_folder() -> tempfile::TempDir {
    let base = tempfile::tempdir().unwrap();
    std::fs::write(
        base.path().join("libraries.json"),
        r#"{"version":1,"active":"local","libraries":{"local":{"owner":{"kind":"local"}}}}"#,
    )
    .unwrap();
    let databases = base.path().join("libraries/local/databases");
    std::fs::create_dir_all(&databases).unwrap();
    std::fs::write(databases.join("drifting-library.db"), b"").unwrap();
    base
}

fn look_in(cx: &mut TestAppContext, dir: &Path) {
    let dir = dir.to_path_buf();
    cx.update(|cx| {
        let i = dr_view_import::importer(cx).unwrap();
        i.update(cx, |i, _| i.look_in(Some(dir)));
    });
}

fn offered(cx: &mut VisualTestContext) -> bool {
    cx.update(|_, cx| dr_shell::Settings::device_memory(cx, dr_view_import::OFFERED))
        == Some(true.into())
}

#[gpui::test]
fn the_first_bookshelf_offers_the_import_by_itself_once_on_a_device(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    init(cx, lib);
    let base = v1_folder();
    look_in(cx, base.path());
    let (_view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    let State::Found(found) = state(cx) else {
        panic!("{:?}", state(cx))
    };
    assert_eq!(found.libraries.len(), 1);
    assert!(
        !cx.did_prompt_for_paths(),
        "never the folder panel by itself"
    );
    assert!(offered(cx));

    // Put away: it does not come back, in this window or in a new one.
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.close(w, cx)));
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
    let (_second, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
    assert!(active(cx).library().docs(None, None).unwrap().is_empty());
}

#[gpui::test]
fn without_0_1_libraries_nothing_offers_itself(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    init(cx, lib);
    // A 0.1 folder that is not there, then one with no library in it.
    look_in(cx, &dir.path().join("no-such-0.1-folder"));
    let (_view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
    let empty = tempfile::tempdir().unwrap();
    look_in(cx, empty.path());
    let (_second, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
    assert!(!cx.did_prompt_for_paths());
    assert!(!offered(cx));

    // Opened from the bookshelf, the dialog counts as seen on this device:
    // a later bookshelf does not show it by itself.
    let base = v1_folder();
    look_in(cx, base.path());
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Found(_)));
    assert!(offered(cx));
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.close(w, cx)));
    cx.run_until_parked();
    let (_third, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
}

#[gpui::test]
fn missing_source_fails_and_cancelling_the_picker_writes_nothing(cx: &mut TestAppContext) {
    let (dir, lib) = library();
    let (_view, cx) = setup(cx, lib);
    let i = importer(cx);
    cx.update(|w, cx| {
        i.update(cx, |i, cx| {
            i.start(dir.path().join("missing-source"), w, cx)
        })
    });
    assert!(matches!(state(cx), State::Failed(_)));
    cx.update(|w, cx| i.update(cx, |i, cx| i.close(w, cx)));
    cx.dispatch_action(ImportLegacyLibrary);
    cx.run_until_parked();
    cx.simulate_path_prompt_response(|_| None);
    cx.run_until_parked();
    assert!(matches!(state(cx), State::Idle));
    assert!(active(cx).library().docs(None, None).unwrap().is_empty());
}

#[test]
fn interrupted_target_resumes_only_with_the_same_explicit_choices_and_no_source_writes() {
    let (dir, ws) = library();
    let old = common::build_v3(true);
    let before = sha(&old.db);
    let picked = dr_import_v1::locate::resolve(&old.root).unwrap();
    let original = ws.library().paths().root.clone();
    let mut job = Destination::prepare(&original, &picked).unwrap();
    job.set_choices(common::v3_choices()).unwrap();
    let target = job.target();
    let cancel = dr_import_v1::run::Cancel::default();
    let stop = cancel.clone();
    let result = dr_view_import::reimport::import(
        job,
        VERSION,
        dr_import_v1::gate::Accept::NOTHING,
        cancel,
        &mut |p| {
            if p.step == dr_import_v1::progress::Step::Bodies && p.done == 1 {
                stop.now();
            }
        },
    )
    .unwrap();
    assert!(
        matches!(result,ResultOfImport::Imported {job,receipt,..} if !job.completed&&receipt.cancelled)
    );
    let mut resumed = Destination::prepare(&original, &picked).unwrap();
    assert_eq!(resumed.target(), target);
    assert!(resumed.set_choices(Default::default()).is_err());
    let ResultOfImport::Imported { job, receipt, .. } = dr_view_import::reimport::import(
        resumed,
        VERSION,
        dr_import_v1::gate::Accept::NOTHING,
        Default::default(),
        &mut |_| {},
    )
    .unwrap() else {
        panic!("not resumed")
    };
    assert!(job.completed);
    assert_eq!(receipt.books[0].status, "imported");
    assert_eq!(sha(&old.db), before);
    let lib = dr_store::Library::open(&target, dr_workspace::library_options(VERSION)).unwrap();
    let labels = lib
        .history(&format!("body:{}/mod-prose", common::CHAPTER))
        .unwrap();
    assert_eq!(labels.iter().filter(|l| l.label == "import").count(), 1);
    lib.close().unwrap();
    assert_eq!(ws.library().paths().root, original);
    assert!(!dir.path().join(dr_account::LIBRARIES_FILE).exists());
    ws.shutdown().unwrap();
}

#[gpui::test]
fn an_interrupted_new_target_is_a_startup_reminder_and_carries_on(cx: &mut TestAppContext) {
    let (_dir, ws) = library();
    let old = common::build_v3(true);
    let picked = dr_import_v1::locate::resolve(&old.root).unwrap();
    let original = ws.library().paths().root.clone();
    let mut job = Destination::prepare(&original, &picked).unwrap();
    job.set_choices(common::v3_choices()).unwrap();
    let target = job.target();
    let cancel = dr_import_v1::run::Cancel::default();
    let stop = cancel.clone();
    dr_view_import::reimport::import(
        job,
        VERSION,
        dr_import_v1::gate::Accept::NOTHING,
        cancel,
        &mut |p| {
            if p.step == dr_import_v1::progress::Step::Bodies && p.done == 1 {
                stop.now();
            }
        },
    )
    .unwrap();
    let (_view, cx) = setup(cx, ws);
    wait(cx, |cx| {
        cx.update(|_, cx| !dr_shell::notifications::Notifications::items(cx).is_empty())
    });
    let notice = cx.update(|_, cx| dr_shell::notifications::Notifications::items(cx)[0].clone());
    cx.update(|w, cx| (notice.action.clone().unwrap().run)(notice.id, w, cx));
    assert!(matches!(state(cx),State::Ready(r) if r.explicit_choices));
    start(cx);
    assert!(matches!(settled(cx), State::Done(_)));
    assert_eq!(active(cx).library().paths().root, target);
    assert!(cx.update(|_, cx| {
        dr_shell::notifications::Notifications::items(cx)
            .iter()
            .all(|n| n.source != dr_shell::notifications::Source::Import)
    }));
}

#[gpui::test]
fn quit_awaits_the_real_worker_before_a_target_can_reopen(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    let original = lib.library().paths().root.clone();
    let (_view, cx) = setup(cx, lib);
    let old = common::build_v3(true);
    configure(cx, &old.root);
    choices(cx);
    let i = importer(cx);
    let target = i.read_with(cx, |i, _| i.destination().unwrap().target());
    start(cx);
    cx.update(|_, cx| dr_shell::quit::request(cx));
    wait(cx, |cx| !i.read_with(cx, |i, _| i.is_running()));
    assert_eq!(
        active(cx).library().paths().root,
        original,
        "quitting cannot activate a background result"
    );
    if target.join("library.sqlite").is_file() {
        let lib = dr_store::Library::open(&target, dr_workspace::library_options(VERSION)).unwrap();
        lib.close().unwrap();
    }
}

#[gpui::test]
fn configuration_dialog_stays_in_the_window_that_started_it(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    init(cx, lib);
    let first = cx.add_window(Workspace::new);
    let second = cx.add_window(Workspace::new);
    cx.run_until_parked();
    let old = common::build_v3(true);
    let i = cx.update(|cx| dr_view_import::importer(cx).unwrap());
    second
        .update(cx, |_, w, cx| {
            i.update(cx, |i, cx| i.start(old.root.clone(), w, cx))
        })
        .unwrap();
    cx.run_until_parked();
    assert_eq!(i.read_with(cx, |i, _| i.window()), Some(second.into()));
    cx.update(|cx| {
        assert!(second.read(cx).unwrap().dialog.is_some());
        assert!(first.read(cx).unwrap().dialog.is_none());
    });
}

#[gpui::test]
fn a_late_worker_preserves_the_completed_target_and_the_authors_new_selection(
    cx: &mut TestAppContext,
) {
    let (dir, lib) = library();
    let original = lib.library().paths().root.clone();
    let (_view, cx) = setup(cx, lib);
    let old = common::build_v3(true);
    let before = sha(&old.db);
    configure(cx, &old.root);
    choices(cx);
    let target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    start(cx);
    // No GUI message is consumed until this later author selection is saved.
    let mut registry = dr_account::LibraryRegistry::default_local();
    registry.entries.push(dr_account::LibraryEntry {
        id: "later-local".into(),
        path: "later-local".into(),
        owner: dr_account::LibraryOwner::Local,
        created_at: dr_store::now_ms() as u64,
    });
    registry.active_id = "later-local".into();
    registry.save(dir.path()).unwrap();
    assert!(matches!(settled(cx), State::Failed(_)));
    let registry = dr_account::LibraryRegistry::load_or_init(dir.path()).unwrap();
    assert_eq!(registry.active_id, "later-local");
    assert_eq!(
        active(cx).library().paths().root,
        original,
        "activation failure restores the usable previous workspace"
    );
    assert_eq!(sha(&old.db), before);
    assert!(target.join("library.sqlite").is_file());
    let target = dr_store::Library::open(&target, dr_workspace::library_options(VERSION)).unwrap();
    let book = target.load_copy(&format!("book:{}", common::BOOK)).unwrap();
    assert!(dr_doc::v3::is_book_doc(&book));
    target.close().unwrap();
}

#[test]
fn committed_preferred_target_opens_from_the_registry_after_a_fresh_start() {
    let (dir, old_ws) = library();
    let original = old_ws.library().paths().root.clone();
    let old = common::build_v3(true);
    let before = sha(&old.db);
    let picked = dr_import_v1::locate::resolve(&old.root).unwrap();
    let mut job = Destination::prepare(&original, &picked).unwrap();
    job.set_choices(common::v3_choices()).unwrap();
    let ResultOfImport::Imported { job, .. } = dr_view_import::reimport::import(
        job,
        VERSION,
        dr_import_v1::gate::Accept::NOTHING,
        Default::default(),
        &mut |_| {},
    )
    .unwrap() else {
        panic!("import did not finish")
    };
    old_ws.shutdown().unwrap();
    let target = job
        .open_target(&original, dr_workspace::library_options(VERSION))
        .unwrap();
    let ws = Library::open(target, Default::default()).unwrap();
    job.commit_selection(&ws).unwrap();
    ws.shutdown().unwrap();
    let registry = dr_account::LibraryRegistry::load_or_init(dir.path()).unwrap();
    let chosen = registry.active_library_dir(dir.path());
    assert_eq!(chosen, job.target());
    let ws = Library::open_dir(&chosen, VERSION).unwrap();
    let book = dr_shell::book::Book::load_any(&ws, None).unwrap().unwrap();
    assert_eq!(book.id, common::BOOK);
    assert!(book.v3().is_some());
    ws.shutdown().unwrap();
    assert_eq!(sha(&old.db), before);
    assert!(original.join("library.sqlite").is_file());
}

#[gpui::test]
fn library_without_act_drift_imports_with_default_choices(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    let original = lib.library().paths().root.clone();
    let (_view, cx) = setup(cx, lib);
    let old = common::build_v3(true);
    let conn = rusqlite::Connection::open(&old.db).unwrap();
    conn.execute(
        "UPDATE book_act SET drift_node_id = NULL WHERE id = 'act-1'",
        [],
    )
    .unwrap();
    drop(conn);
    let before = source_files(&old.root);
    configure(cx, &old.root);
    let target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    assert_ne!(target, original);
    start(cx);
    let State::Done(done) = settled(cx) else {
        panic!("expected zero-choice import to finish: {:?}", state(cx))
    };
    assert!(!done.cancelled);
    assert_eq!(done.books[0].status, "imported");
    assert_eq!(source_files(&old.root), before);
    let current = active(cx);
    let snapshot = dr_shell::book::Book::load(&current, common::BOOK).unwrap();
    assert!(snapshot.v3().is_some());
    let copy = current
        .library()
        .load_copy(&format!("book:{}", common::BOOK))
        .unwrap();
    let reader = dr_doc::v3::BookReaderV3::from_loro(
        dr_model::id::BookId::parse(common::BOOK).unwrap(),
        &copy,
    )
    .unwrap();
    let view = reader.view();
    let storylines_root = view
        .root_entry_by_template(
            &dr_model::id::EntryTemplateId::parse(dr_doc::v3::novel::TPL_STORYLINES).unwrap(),
        )
        .unwrap()
        .id;
    let lanes = view.children_of(Some(&storylines_root));
    assert_eq!(lanes.len(), 2);
    assert_eq!(lanes[0].id.as_str(), common::STORYLINE);
    assert_eq!(lanes[1].title, "未归属");
    let rt = view
        .relation_type(&dr_model::id::RelationTypeId::parse(common::REL_TYPE).unwrap())
        .unwrap();
    assert_eq!(rt.name, "同乡");
    assert_eq!(rt.description, dr_model::v3::LinkedText::default());
    assert_eq!(rt.direction, dr_model::v3::RelationDirection::Symmetric);
    assert!(view.relations().is_empty());
}

#[test]
fn reimport_dialog_copy_is_localized_in_all_nine_languages_without_mapping_json_or_paths() {
    use dr_i18n::{I18n, Locale, Platform, keys};
    let en = I18n::new(Locale::En, Platform::Mac);
    let banned = [
        "MappingChoices",
        "reimport-v3-",
        "reimport-v4-",
        "reimport-v5-",
        "v2",
        "v3",
        "层级模板",
        "叶子模板",
        "层级模版",
        "叶子模版",
        "leaf template",
        "level template",
    ];
    for locale in Locale::ALL {
        let i18n = I18n::new(locale, Platform::Mac);
        for key in [
            keys::import::v3::TITLE,
            keys::import::v3::DESTINATION,
            keys::import::v3::START,
            keys::import::v3::PENDING,
            keys::import::v3::SWITCHING,
            keys::import::v1::action::DOWNLOAD_LAST_RELEASE,
            keys::import::v1::action::IMPORT_ANYWAY,
            keys::import::v1::blocked::GET_LAST_RELEASE,
            keys::import::v1::blocked::NO_HANDOFF,
            keys::import::v1::blocked::SYNC,
            keys::import::v1::blocked::TITLE,
            keys::import::v1::notice::CARRY_ON,
            keys::import::v1::summary::ALREADY_IMPORTED,
            keys::import::v1::summary::ALREADY_IN_LIBRARY,
            keys::import::v1::summary::CARRIES_ON,
            keys::import::v1::refused::ACCOUNT_HAS_BOOKS,
        ] {
            let text = i18n.t(key);
            assert!(!text.is_empty(), "{locale:?} {}", key.name());
            for term in banned {
                assert!(
                    !text.to_lowercase().contains(&term.to_lowercase()),
                    "{locale:?} {} contained retired/internal term {term:?}: {text}",
                    key.name()
                );
            }
            if locale != Locale::En {
                assert_ne!(
                    text,
                    en.t(key),
                    "{locale:?} {} was left in English: {text}",
                    key.name()
                );
            }
        }
    }
}

/// The confirmation before an import is titled as its button is named
/// (「导入到新库」), in every language: a first import is not a re-import,
/// and the dialog tells no import apart from another.
#[test]
fn import_confirmation_is_titled_as_its_button_in_all_nine_languages() {
    use dr_i18n::{I18n, Locale, Platform, keys};
    for locale in Locale::ALL {
        let i18n = I18n::new(locale, Platform::Mac);
        assert_eq!(
            i18n.t(keys::import::v3::TITLE),
            i18n.t(keys::import::v3::START),
            "{locale:?}"
        );
    }
    let zh = I18n::new(Locale::ZhCn, Platform::Mac);
    assert_eq!(zh.t(keys::import::v3::TITLE), "导入到新库");
}

#[test]
fn reimport_v5_continuation_preserves_unfinished_earlier_targets_and_refuses_to_resume_them() {
    let (dir, ws) = library();
    let data = dir.path().to_path_buf();
    let original = ws.library().paths().root.clone();
    ws.shutdown().unwrap();

    let old = common::build_v3(true);
    let source_before = source_files(&old.root);
    let picked = dr_import_v1::locate::resolve(&old.root).unwrap();

    // Seed unfinished earlier-format (`reimport-v3-…` and `reimport-v4-…`)
    // target directories, manifests, and pending pointers in the data directory.
    let old_v3_id = "reimport-v3-01900000-0000-7000-8000-0000000000a1";
    let old_v3_dir = data.join(old_v3_id);
    std::fs::create_dir_all(&old_v3_dir).unwrap();
    std::fs::write(old_v3_dir.join("library.sqlite"), b"unfinished-v3-sqlite").unwrap();
    let old_v3_manifest = data.join(format!("{old_v3_id}.json"));
    let old_v3_job = Destination {
        data: data.clone(),
        id: old_v3_id.into(),
        original: original.clone(),
        database: picked.database.clone(),
        source_root: picked.root.clone(),
        left: picked.left.clone(),
        choices: common::v3_choices(),
        completed: false,
    };
    std::fs::write(
        &old_v3_manifest,
        serde_json::to_vec_pretty(&old_v3_job).unwrap(),
    )
    .unwrap();
    let old_v3_pending = data.join("reimport-v3-pending.json");
    std::fs::write(&old_v3_pending, serde_json::to_vec(&old_v3_id).unwrap()).unwrap();

    let old_v4_id = "reimport-v4-01900000-0000-7000-8000-0000000000a2";
    let old_v4_dir = data.join(old_v4_id);
    std::fs::create_dir_all(&old_v4_dir).unwrap();
    std::fs::write(old_v4_dir.join("library.sqlite"), b"unfinished-v4-sqlite").unwrap();
    let old_v4_manifest = data.join(format!("{old_v4_id}.json"));
    let old_v4_job = Destination {
        data: data.clone(),
        id: old_v4_id.into(),
        original: original.clone(),
        database: picked.database.clone(),
        source_root: picked.root.clone(),
        left: picked.left.clone(),
        choices: common::v3_choices(),
        completed: false,
    };
    std::fs::write(
        &old_v4_manifest,
        serde_json::to_vec_pretty(&old_v4_job).unwrap(),
    )
    .unwrap();
    let old_v4_pending = data.join("reimport-v4-pending.json");
    std::fs::write(&old_v4_pending, serde_json::to_vec(&old_v4_id).unwrap()).unwrap();

    let file_state = |p: &std::path::Path| {
        let meta = std::fs::metadata(p).unwrap();
        let bytes = std::fs::read(p).unwrap();
        let mtime = meta
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        (common::sha256_bytes(&bytes), meta.len(), mtime)
    };
    let earlier_artifacts_before = (
        source_files(&old_v3_dir),
        file_state(&old_v3_manifest),
        file_state(&old_v3_pending),
        source_files(&old_v4_dir),
        file_state(&old_v4_manifest),
        file_state(&old_v4_pending),
    );

    // 1. Startup unfinished check ignores earlier pending pointers and leaves them untouched.
    assert!(Destination::unfinished(&original).unwrap().is_none());

    // 2. Direct attempts to execute earlier `reimport-v3-…` or `reimport-v4-…` Destinations are refused.
    for earlier_job in [old_v3_job, old_v4_job] {
        let refused = dr_view_import::reimport::import(
            earlier_job,
            VERSION,
            dr_import_v1::gate::Accept::NOTHING,
            Default::default(),
            &mut |_| {},
        );
        assert!(matches!(
            refused,
            Err(dr_import_v1::ImportError::Invalid(_))
        ));
    }

    // 3. `prepare` ignores earlier pending pointers, allocates a `reimport-v5-…`
    //    destination, interrupts cleanly, records `reimport-v5-pending.json`, and
    //    resumes the same `reimport-v5-…` destination to completion.
    let mut first_v5 = Destination::prepare(&original, &picked).unwrap();
    assert!(first_v5.id.starts_with("reimport-v5-"));
    assert_ne!(first_v5.id, old_v3_id);
    assert_ne!(first_v5.id, old_v4_id);
    first_v5.set_choices(common::v3_choices()).unwrap();

    let cancel = dr_import_v1::run::Cancel::default();
    let stopper = cancel.clone();
    let partial = dr_view_import::reimport::import(
        first_v5.clone(),
        VERSION,
        dr_import_v1::gate::Accept::NOTHING,
        cancel,
        &mut |p| {
            if p.step == dr_import_v1::progress::Step::Bodies && p.done == 1 {
                stopper.now();
            }
        },
    )
    .unwrap();
    let ResultOfImport::Imported {
        job: partial_job, ..
    } = partial
    else {
        panic!("expected interrupted partial import")
    };
    assert!(!partial_job.completed);
    let found_unfinished = Destination::unfinished(&original)
        .unwrap()
        .expect("unfinished v5 job must be surfaced");
    assert_eq!(found_unfinished.id, first_v5.id);

    let resumed_v5 = Destination::prepare(&original, &picked).unwrap();
    assert_eq!(resumed_v5.id, first_v5.id);
    let finished = dr_view_import::reimport::import(
        resumed_v5,
        VERSION,
        dr_import_v1::gate::Accept::NOTHING,
        Default::default(),
        &mut |_| {},
    )
    .unwrap();
    let ResultOfImport::Imported {
        job: completed_job, ..
    } = finished
    else {
        panic!("expected resumed import to complete")
    };
    assert!(completed_job.completed);
    assert_eq!(completed_job.id, first_v5.id);

    // 4. Even if `reimport-v5-pending.json` is tampered to point at `reimport-v4-…`,
    //    both `unfinished` and `prepare` reject it cleanly without touching old files.
    std::fs::write(
        data.join("reimport-v5-pending.json"),
        serde_json::to_vec(&old_v4_id).unwrap(),
    )
    .unwrap();
    assert!(Destination::unfinished(&original).is_err());
    assert!(Destination::prepare(&original, &picked).is_err());

    // 5. All `reimport-v3-…` / `reimport-v4-…` files AND the 0.1 source directory remain
    //    byte-for-byte and mtime-for-mtime identical!
    let earlier_artifacts_after = (
        source_files(&old_v3_dir),
        file_state(&old_v3_manifest),
        file_state(&old_v3_pending),
        source_files(&old_v4_dir),
        file_state(&old_v4_manifest),
        file_state(&old_v4_pending),
    );
    assert_eq!(earlier_artifacts_after, earlier_artifacts_before);
    assert_eq!(source_files(&old.root), source_before);
}

// What differs from 0.1 (decisions 六 甲 / 七 甲, m10-import.md 「导入界面」).

fn locale(cx: &mut VisualTestContext, locale: dr_i18n::Locale) {
    cx.update(|_, cx| dr_shell::Strings::install(locale, cx));
    cx.run_until_parked();
}

fn strings(cx: &mut VisualTestContext) -> dr_i18n::I18n {
    cx.update(|_, cx| {
        dr_i18n::I18n::new(
            dr_shell::Strings::get(cx).locale(),
            dr_i18n::Platform::current(),
        )
    })
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is not drawn"));
    cx.simulate_click(b.center(), gpui::Modifiers::none());
    cx.run_until_parked();
}

fn open(cx: &mut VisualTestContext) -> bool {
    importer(cx).read_with(cx, |i, _| i.differences_open())
}

/// The lines (`selector-0-0`, `selector-0-1`, …) drawn for each book.
fn drawn_lines(cx: &mut VisualTestContext, books: usize) -> Vec<usize> {
    (0..books)
        .map(|i| {
            (0..)
                .take_while(|j| {
                    cx.debug_bounds(Box::leak(
                        format!("legacy-import-difference-{i}-{j}").into_boxed_str(),
                    ))
                    .is_some()
                })
                .count()
        })
        .collect()
}

/// A library with differences imported through the ordinary dialog: the
/// line under the count lines says the total, which is what summary.md
/// lists for every book; pressed, it lists them by book with their counts,
/// and pressed again it closes. In Chinese and in English.
#[gpui::test]
fn the_done_dialog_says_how_much_differs_from_0_1_and_lists_it_by_book(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    let (_view, cx) = setup(cx, lib);
    let old = common::build_differences();
    configure(cx, &old.root);
    let target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    start(cx);
    let State::Done(done) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    let summary = std::fs::read_to_string(
        dr_import_v1::receipt::directory(&target).join(dr_import_v1::receipt::SUMMARY),
    )
    .unwrap();
    let parsed = common::parse_summary(&summary);
    assert_eq!(done.books.len(), 2);
    let zh = dr_i18n::I18n::new(dr_i18n::Locale::ZhCn, dr_i18n::Platform::current());
    let mut total = 0;
    for book in &done.books {
        // The dialog's lines are summary.md's, those that read the same
        // merged: the same words, the same counts.
        let lines = &parsed[&book.name];
        let mut merged: Vec<(String, usize)> = Vec::new();
        for l in lines {
            match merged
                .iter_mut()
                .find(|(text, _)| l.block != "materials" && l.block != "assets" && *text == l.text)
            {
                Some((_, n)) => *n += l.count,
                None => merged.push((l.text.clone(), l.count)),
            }
        }
        assert_eq!(merged.len(), book.differences.len(), "{}", book.name);
        for ((text, count), d) in merged.iter().zip(&book.differences) {
            assert_eq!(*count, d.count, "{text}");
            if d.counted || d.args.iter().all(|(n, _)| *n != "name") {
                assert_eq!(*text, d.text(&zh));
            } else {
                assert!(text.contains(&d.args[0].1), "{text}");
            }
        }
        let differing = dr_import_v1::receipt::total(&book.differences);
        assert_eq!(differing, lines.iter().map(|l| l.count).sum::<usize>());
        total += differing;
    }
    assert_eq!(done.differences(), total);
    assert_eq!(total, 24, "{:#?}", done.books);

    for (lang, line) in [
        (dr_i18n::Locale::ZhCn, "有 24 处和旧版不完全一样"),
        (
            dr_i18n::Locale::En,
            "24 places aren't quite the same as in 0.1",
        ),
    ] {
        locale(cx, lang);
        let words = cx.update(|_, cx| {
            dr_view_import::copy::text(dr_view_import::copy::DIFFERENCES, Some(total), cx)
        });
        assert_eq!(words, line);
        // Closed: the line, no list.
        assert!(!open(cx));
        assert!(cx.debug_bounds("legacy-import-differences-line").is_some());
        assert!(cx.debug_bounds("legacy-import-differences").is_none());
        click(cx, "legacy-import-differences-line");
        assert!(open(cx));
        assert!(cx.debug_bounds("legacy-import-differences").is_some());
        assert!(
            cx.debug_bounds("legacy-import-differences-book-1")
                .is_some()
        );
        assert_eq!(
            drawn_lines(cx, 2),
            done.books
                .iter()
                .map(|b| b.differences.len())
                .collect::<Vec<_>>()
        );
        // The sentences in the language of the dialog.
        let s = strings(cx);
        let first = &done.books[0].differences;
        let span = first
            .iter()
            .find(|d| d.codes.iter().any(|c| c == "table-cell-span"))
            .unwrap();
        assert_eq!(
            span.text(&s),
            match lang {
                dr_i18n::Locale::ZhCn => "表格的合并单元格和列宽没有保留",
                _ => "Merged table cells and column widths were not kept",
            }
        );
        // The two that end in 「逐条列在下方」 in summary.md are said without
        // it here; the relations the book could not hold have their words.
        let said = |code: &str| {
            first
                .iter()
                .find(|d| d.codes.iter().any(|c| c == code))
                .unwrap()
                .dialog_text(&s)
        };
        let (ticks, links, self_end) = match lang {
            dr_i18n::Locale::ZhCn => (
                "清单项关联的待办状态与勾选不一致，已按清单项的勾选为准",
                "正文中指向图片或 PDF 素材的链接，素材没有文件、无处可链，已转为普通文字",
                "两头是同一个对象的关系没有导入",
            ),
            _ => (
                "Where a checklist item's to-do status disagreed with its tick, the tick was followed",
                "Links in the text to image or PDF materials that have no file had nothing to point to and became plain text",
                "Relations whose two ends are the same thing were not imported",
            ),
        };
        assert_eq!(said("task-status-follows-tick"), ticks);
        assert_eq!(said("entity-link-to-asset-kept-as-text"), links);
        assert_eq!(said("relation-self-end-dropped"), self_end);
        // Each book has material lines: summary.md's heading of that block
        // sits right above the first of them, below the line before.
        for (i, book) in done.books.iter().enumerate() {
            let j = book
                .differences
                .iter()
                .position(|d| d.block == dr_import_v1::receipt::Block::Materials)
                .unwrap();
            let heading = cx
                .debug_bounds(Box::leak(
                    format!("legacy-import-differences-materials-{i}").into_boxed_str(),
                ))
                .unwrap_or_else(|| panic!("book {i} has no heading"));
            let below = cx
                .debug_bounds(Box::leak(
                    format!("legacy-import-difference-{i}-{j}").into_boxed_str(),
                ))
                .unwrap();
            assert!(heading.bottom() <= below.top(), "{heading:?} {below:?}");
            if j > 0 {
                let above = cx
                    .debug_bounds(Box::leak(
                        format!("legacy-import-difference-{i}-{}", j - 1).into_boxed_str(),
                    ))
                    .unwrap();
                assert!(above.bottom() <= heading.top(), "{above:?} {heading:?}");
            }
        }
        let heading =
            cx.update(|_, cx| dr_shell::strings::t(cx, dr_import_v1::receipt::MATERIALS_HEADING));
        assert_eq!(
            heading,
            match lang {
                dr_i18n::Locale::ZhCn => "旧版素材里没有带过来的",
                _ => "Materials from 0.1 that did not come over",
            }
        );
        // Opening scrolls inside the dialog: the list keeps to its height.
        let list = cx.debug_bounds("legacy-import-differences").unwrap();
        assert!(
            list.size.height <= gpui::px(232.0) + gpui::px(0.5),
            "{list:?}"
        );
        click(cx, "legacy-import-differences-line");
        assert!(!open(cx));
        assert!(cx.debug_bounds("legacy-import-differences").is_none());
    }
    // Closing the dialog forgets it was open.
    click(cx, "legacy-import-differences-line");
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.close(w, cx)));
    assert!(!open(cx));
}

/// Nothing differs: no line, and the two count lines read as before.
#[gpui::test]
fn the_line_is_absent_when_nothing_differs_and_the_count_lines_stay(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    let (_view, cx) = setup(cx, lib);
    locale(cx, dr_i18n::Locale::ZhCn);
    let done = dr_view_import::Done {
        folder: "app-local-data".into(),
        books: vec![dr_view_import::DoneBook {
            id: common::BOOK.into(),
            name: "阿Q正传".into(),
            status: "imported".into(),
            words: Some(1234),
            differences: Vec::new(),
        }],
        from_caches: 2,
        left: vec!["account-1".into()],
        cancelled: false,
        identity_adopted: false,
        total_ms: 1.0,
    };
    assert_eq!(done.differences(), 0);
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.show(State::Done(done), w, cx)));
    cx.run_until_parked();
    assert!(cx.debug_bounds("legacy-import-from-caches").is_some());
    assert!(cx.debug_bounds("legacy-import-left").is_some());
    assert!(cx.debug_bounds("legacy-import-differences-line").is_none());
    let (caches, left) = cx.update(|_, cx| {
        use dr_view_import::copy;
        (
            copy::text(copy::FROM_CACHES, Some(2), cx),
            copy::text(copy::ACCOUNT_LIBRARIES_LEFT, Some(1), cx),
        )
    });
    assert_eq!(caches, "有 2 篇照缓存导入，可能少了最后几秒的字");
    assert_eq!(left, "文件夹里还有 1 个账号资料库没导入");
    // Nothing to open.
    cx.update(|_, cx| i.update(cx, |i, cx| i.toggle_differences(cx)));
    assert!(!open(cx));
}

/// The line under the count lines when both show, in their order; and it
/// is a button named by what it says, open or closed, for assistive
/// technology (the real window's tree is checked by the import-differences
/// scenario).
#[gpui::test]
fn the_line_comes_after_the_count_lines_and_is_a_named_button(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    let (_view, cx) = setup(cx, lib);
    let mut lines = dr_import_v1::receipt::differences(&{
        let mut b = dr_import_v1::receipt::BookRecord {
            book_id: common::BOOK.into(),
            name: "阿Q正传".into(),
            status: "imported".into(),
            ..Default::default()
        };
        b.notes.0.insert("table-cell-span".into(), 3);
        b
    });
    lines = dr_import_v1::receipt::merged(lines);
    let done = dr_view_import::Done {
        folder: "app-local-data".into(),
        books: vec![dr_view_import::DoneBook {
            id: common::BOOK.into(),
            name: "阿Q正传".into(),
            status: "imported".into(),
            words: Some(1234),
            differences: lines,
        }],
        from_caches: 2,
        left: vec!["account-1".into()],
        cancelled: false,
        identity_adopted: false,
        total_ms: 1.0,
    };
    let i = importer(cx);
    cx.update(|w, cx| i.update(cx, |i, cx| i.show(State::Done(done), w, cx)));
    cx.run_until_parked();
    let caches = cx.debug_bounds("legacy-import-from-caches").unwrap();
    let left = cx.debug_bounds("legacy-import-left").unwrap();
    let line = cx.debug_bounds("legacy-import-differences-line").unwrap();
    assert!(caches.bottom() <= left.top() && left.bottom() <= line.top());
    assert_eq!(caches.left(), line.left() + gpui::px(4.0));
    let src = include_str!("../src/view.rs");
    let at = src.find("fn differences_line(").unwrap();
    let body = &src[at..at + src[at..].find("\n}\n").unwrap()];
    for needed in [
        ".role(gpui::Role::Button)",
        ".aria_label(label.clone())",
        ".aria_expanded(open)",
    ] {
        assert!(body.contains(needed), "{needed}");
    }
    // Open, no material lines: no heading.
    click(cx, "legacy-import-differences-line");
    assert!(open(cx));
    assert!(cx.debug_bounds("legacy-import-difference-0-0").is_some());
    assert!(
        cx.debug_bounds("legacy-import-differences-materials-0")
            .is_none()
    );
    // The list says each line as the dialog does (`dialog_text`), never
    // summary.md's own form.
    let at = src.find("fn differences(").unwrap();
    let body = &src[at..at + src[at..].find("\n}\n").unwrap()];
    assert!(body.contains(".dialog_text(strings)") && !body.contains(".text(strings)"));
}
