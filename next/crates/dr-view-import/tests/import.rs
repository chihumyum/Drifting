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
    // 1. Prewrite V3Pending stops before creating target or libraries.json.
    let bad = common::build(true);
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
            .any(|p| p.code == "invalid-or-duplicate-source-relation")
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
    assert_eq!(rt.source_kinds, [dr_model::kind::EntityKind::Entry]);
    assert_eq!(rt.target_kinds, [dr_model::kind::EntityKind::Entry]);
    assert!(rt.source_templates.is_empty());
    assert!(rt.target_templates.is_empty());
}

#[test]
fn reimport_dialog_copy_is_localized_in_all_nine_languages_without_mapping_json_or_paths() {
    use dr_i18n::{I18n, Locale, Platform, keys};
    let en = I18n::new(Locale::En, Platform::Mac);
    let banned = [
        "MappingChoices",
        "reimport-v3-",
        "reimport-v4-",
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

#[test]
fn reimport_v4_continuation_preserves_unfinished_v3_targets_and_refuses_to_resume_them() {
    let (dir, ws) = library();
    let data = dir.path().to_path_buf();
    let original = ws.library().paths().root.clone();
    ws.shutdown().unwrap();

    let old = common::build_v3(true);
    let source_before = source_files(&old.root);
    let picked = dr_import_v1::locate::resolve(&old.root).unwrap();

    // Seed an unfinished earlier-format (`reimport-v3-…`) target directory,
    // manifest, and pending pointer inside the same data directory.
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
    let v3_artifacts_before = (
        source_files(&old_v3_dir),
        file_state(&old_v3_manifest),
        file_state(&old_v3_pending),
    );

    // 1. Startup unfinished check ignores `reimport-v3-pending.json` and leaves it untouched.
    assert!(Destination::unfinished(&original).unwrap().is_none());

    // 2. Direct attempt to execute an earlier `reimport-v3-…` Destination is refused.
    let refused = dr_view_import::reimport::import(
        old_v3_job,
        VERSION,
        dr_import_v1::gate::Accept::NOTHING,
        Default::default(),
        &mut |_| {},
    );
    assert!(matches!(
        refused,
        Err(dr_import_v1::ImportError::Invalid(_))
    ));

    // 3. `prepare` ignores `reimport-v3-pending.json`, allocates a `reimport-v4-…`
    //    destination, interrupts cleanly, records `reimport-v4-pending.json`, and
    //    resumes the same `reimport-v4-…` destination to completion.
    let mut first_v4 = Destination::prepare(&original, &picked).unwrap();
    assert!(first_v4.id.starts_with("reimport-v4-"));
    assert_ne!(first_v4.id, old_v3_id);
    first_v4.set_choices(common::v3_choices()).unwrap();

    let cancel = dr_import_v1::run::Cancel::default();
    let stopper = cancel.clone();
    let partial = dr_view_import::reimport::import(
        first_v4.clone(),
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
        .expect("unfinished v4 job must be surfaced");
    assert_eq!(found_unfinished.id, first_v4.id);

    let resumed_v4 = Destination::prepare(&original, &picked).unwrap();
    assert_eq!(resumed_v4.id, first_v4.id);
    let finished = dr_view_import::reimport::import(
        resumed_v4,
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
    assert_eq!(completed_job.id, first_v4.id);

    // 4. Even if `reimport-v4-pending.json` is tampered to point at `reimport-v3-…`,
    //    both `unfinished` and `prepare` reject it cleanly without touching old files.
    std::fs::write(
        data.join("reimport-v4-pending.json"),
        serde_json::to_vec(&old_v3_id).unwrap(),
    )
    .unwrap();
    assert!(Destination::unfinished(&original).is_err());
    assert!(Destination::prepare(&original, &picked).is_err());

    // 5. All `reimport-v3-…` files AND the 0.1 source directory remain byte-for-byte
    //    and mtime-for-mtime identical!
    let v3_artifacts_after = (
        source_files(&old_v3_dir),
        file_state(&old_v3_manifest),
        file_state(&old_v3_pending),
    );
    assert_eq!(v3_artifacts_after, v3_artifacts_before);
    assert_eq!(source_files(&old.root), source_before);
}
