//! `.driftingtemplate` file transfer in the shell over a real library
//! (`docs/rust-rewrite/project-templates.md` §6, §11, §15 PT2;
//! `docs/rust-rewrite/handoff/v5-tracks.md` PT2):
//! - Export goes straight to the native save panel with no intermediate dialog;
//! - Attribution follows the signed-in account's explicit profile name (never
//!   falling back to an email `@` prefix, `homepage`, `book.root`, or
//!   `derivedFrom`, and overwriting upstream authors on re-export);
//! - Import (`ImportTemplate` and dragging `.driftingtemplate` onto the window,
//!   both in Workspace and on All Projects) adds to `project_template.list`
//!   and never creates a project;
//! - Invalid files show the shared transfer failure copy and write nothing.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_account::{AccountService, OtpPurpose, SessionStatus, fake_server::FakeAuthServer};
use dr_platform::SecretStore;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::Library;
use dr_view_transfer::{ExportTemplateById, State, TransferDialog, template};
use dr_workspace::{Actor, Workspace as Lib, WorkspaceOptions, library_options};
use gpui::{
    BorrowAppContext as _, Entity, ExternalPaths, FileDropEvent, Point, TestAppContext,
    VisualTestContext, point, px,
};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn out(ws: &Lib, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn library(with_book: bool) -> (tempfile::TempDir, Lib, Option<String>) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options(VERSION)).unwrap();
    let ws = Lib::open(lib, WorkspaceOptions::default()).unwrap();
    let book = with_book.then(|| {
        let b = out(&ws, "project.create", json!({"name": "雾港来信"}))["id"]
            .as_str()
            .unwrap()
            .to_owned();
        out(
            &ws,
            "entry.create",
            json!({
                "book": b,
                "parent": dr_testkit::seed::acceptance::novel_root(&ws, &b, "tpl-manuscript"),
                "template": "tpl-chapter",
                "title": "第一章",
                "bodies": {"mod-prose": "北码头的雾还没散。"}
            }),
        );
        b
    });
    (dir, ws, book)
}

fn setup_with_account(
    cx: &mut TestAppContext,
    lib: Lib,
    account: Option<Arc<AccountService>>,
    open_book: Option<String>,
) -> (Entity<Workspace>, &mut VisualTestContext) {
    let expect_open_book = open_book.is_some();
    cx.executor().allow_parking();
    cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_device_memory(
            dr_view_account::FIRST_RUN_ACCOUNT_SEEN_KEY,
            Some(json!(true)),
        );
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
                book: open_book,
                ..Services::default()
            },
            settings,
            cx,
        );
        dr_view_shelf::init(cx);
        dr_view_transfer::init(cx);
        if let Some(svc) = account {
            dr_view_account::init(dr_view_account::Service::with_service(svc), cx);
        }
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    if expect_open_book {
        wait_for(cx, |cx| cx.read(|cx| !view.read(cx).book.is_empty()));
    } else {
        cx.run_until_parked();
    }
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

fn templates(lib: &Lib) -> Vec<Value> {
    out(lib, "project_template.list", json!({}))
        .as_array()
        .unwrap()
        .clone()
}

fn simulate_file_drop(cx: &mut VisualTestContext, path: PathBuf, at: Point<gpui::Pixels>) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.simulate_event(FileDropEvent::Entered {
        position: at,
        paths: ExternalPaths([path].into_iter().collect()),
    });
    cx.simulate_event(FileDropEvent::Submit { position: at });
    cx.simulate_event(FileDropEvent::Ended);
}

#[gpui::test]
fn export_skips_dialogs_and_import_or_drop_adds_templates_without_creating_books(
    cx: &mut TestAppContext,
) {
    let (dir, lib, book) = library(true);
    let book = book.unwrap();
    let tpl_id = out(
        &lib,
        "project_template.save",
        json!({"book": book, "name": "推理长篇", "description": "三幕推理"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(books(&lib), 1);
    assert_eq!(templates(&lib).len(), 1);

    let (view, cx) = setup_with_account(cx, lib.clone(), None, Some(book));

    // 1. `dr_view_shelf::ExportTemplate`: opens native save prompt immediately
    // with ZERO intermediate dialogs, and stays dialog-free on completion.
    let exported_a = dir.path().join("推理长篇.driftingtemplate");
    cx.update(|window, cx| {
        window.dispatch_action(
            Box::new(dr_view_shelf::ExportTemplate {
                template: tpl_id.clone(),
            }),
            cx,
        );
    });
    assert!(
        shown(&view, cx).is_none(),
        "export must never open a selector or attribution dialog"
    );
    cx.run_until_parked();
    assert!(shown(&view, cx).is_none());
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection({
        let file = exported_a.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| exported_a.exists());
    assert!(shown(&view, cx).is_none());

    // `ExportTemplateById` (`transfer::ExportTemplateById`) behaves identically.
    let exported_b = dir.path().join("推理长篇-2.driftingtemplate");
    cx.update(|window, cx| {
        window.dispatch_action(Box::new(ExportTemplateById { id: tpl_id.clone() }), cx);
    });
    cx.run_until_parked();
    assert!(shown(&view, cx).is_none());
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection({
        let file = exported_b.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| exported_b.exists());
    assert_eq!(
        std::fs::read(&exported_a).unwrap(),
        std::fs::read(&exported_b).unwrap()
    );

    // 2. `dr_view_shelf::ImportTemplate`: prompts for file, imports into
    // `project_template.list` (`origin = "file"`), and NEVER creates a project.
    cx.update(|window, cx| {
        window.dispatch_action(Box::new(dr_view_shelf::ImportTemplate), cx);
    });
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response({
        let file = exported_a.clone();
        move |_| Some(vec![file])
    });
    wait_for(cx, |_| templates(&lib).len() == 2);
    wait_for(cx, |cx| shown(&view, cx).is_none());
    assert_eq!(
        books(&lib),
        1,
        "importing a .driftingtemplate must never create a project"
    );
    assert!(templates(&lib).iter().any(|t| t["origin"] == "file"));

    // 3. Dragging and dropping a `.driftingtemplate` onto the open-book window
    // adds a third saved template (`origin = "file"`) and still creates zero books.
    simulate_file_drop(cx, exported_a, point(px(40.), px(40.)));
    wait_for(cx, |_| templates(&lib).len() == 3);
    wait_for(cx, |cx| shown(&view, cx).is_none());
    assert_eq!(books(&lib), 1);
}

#[gpui::test]
fn dropping_a_template_onto_all_projects_shelf_imports_without_creating_a_book(
    cx: &mut TestAppContext,
) {
    // Empty library -> renders All Projects (`render_shelf`) directly.
    let (dir, lib, _) = library(false);
    assert_eq!(books(&lib), 0);
    assert!(templates(&lib).is_empty());

    let valid = json!({
        "format": "drifting.project-template",
        "formatVersion": 1,
        "name": "拖拽进书架的模板",
        "description": "不建书",
        "locale": "zh-CN",
        "madeWith": VERSION,
        "revision": 1,
        "project": {
            "book": {},
            "tabs": [{ "mount": { "kind": "root" } }]
        },
        "templates": [],
        "relation_types": [],
        "entries": [],
        "memberships": [],
        "views": [],
        "template_prose": {}
    });
    let file = dir.path().join("shelf-drop.driftingtemplate");
    std::fs::write(&file, serde_json::to_string_pretty(&valid).unwrap()).unwrap();

    let (view, cx) = setup_with_account(cx, lib.clone(), None, None);
    assert!(cx.read(|cx| view.read(cx).book.is_empty()));

    simulate_file_drop(cx, file, point(px(120.), px(120.)));
    wait_for(cx, |_| templates(&lib).len() == 1);
    wait_for(cx, |cx| shown(&view, cx).is_none());
    assert_eq!(
        books(&lib),
        0,
        "dropping a .driftingtemplate onto All Projects must never create a project"
    );
    assert_eq!(templates(&lib)[0]["name"], "拖拽进书架的模板");
    assert_eq!(templates(&lib)[0]["origin"], "file");
}

#[gpui::test]
fn export_attribution_uses_explicit_profile_name_not_email_prefix_or_upstream_author(
    cx: &mut TestAppContext,
) {
    let server = FakeAuthServer::start();
    server.set_require_signup_verification(false);
    let auth_dir = tempfile::tempdir().unwrap();
    let auth_root = auth_dir.path().canonicalize().unwrap();
    let svc = Arc::new(
        AccountService::new(
            server.config(),
            &auth_root,
            "cc.drifting.next.dev",
            Arc::new(SecretStore::in_memory()),
        )
        .unwrap(),
    );

    // Sign in via passwordless email OTP: user has email `linjia@example.test`
    // and NO explicit profile name set yet.
    svc.send_verification_otp("linjia@example.test", OtpPurpose::SignIn)
        .unwrap();
    let otp = server.last_otp_for("linjia@example.test").unwrap();
    let otp_state = svc.sign_in_email_otp("linjia@example.test", &otp).unwrap();
    assert_eq!(otp_state.status, SessionStatus::Connected);

    let dir = tempfile::tempdir().unwrap();
    let store = Library::open(&otp_state.active_library_dir, library_options(VERSION)).unwrap();
    let lib = Lib::open(store, WorkspaceOptions::default()).unwrap();
    let book = out(&lib, "project.create", json!({"name": "雾港来信"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &lib,
        "entry.create",
        json!({
            "book": book,
            "parent": dr_testkit::seed::acceptance::novel_root(&lib, &book, "tpl-manuscript"),
            "template": "tpl-chapter",
            "title": "第一章",
            "bodies": {"mod-prose": "北码头的雾还没散。"}
        }),
    );
    let own_id = out(
        &lib,
        "project_template.save",
        json!({"book": book, "name": "署名核验模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (view, cx) = setup_with_account(cx, lib.clone(), Some(svc.clone()), Some(book));

    // Account Menu display_name still falls back to `@` prefix `"linjia"`,
    // while `author_name` is `None` because no profile name has been set!
    cx.read(|cx| {
        assert_eq!(dr_shell::account::display_name(cx).as_ref(), "linjia");
        assert_eq!(dr_shell::account::author_name(cx), None);
    });

    // 1. Exporting when signed in WITHOUT a profile name omits `credit` completely.
    let no_name_export = dir.path().join("no-profile-name.driftingtemplate");
    cx.update(|window, cx| {
        window.dispatch_action(
            Box::new(dr_view_shelf::ExportTemplate {
                template: own_id.clone(),
            }),
            cx,
        );
    });
    cx.run_until_parked();
    cx.simulate_new_path_selection({
        let file = no_name_export.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| no_name_export.exists());
    let no_name_text = std::fs::read_to_string(&no_name_export).unwrap();
    assert!(!no_name_text.contains("linjia"));
    let no_name_val: Value = serde_json::from_str(&no_name_text).unwrap();
    assert!(no_name_val.get("credit").is_none());

    // 2. Set explicit profile name to `"林岬"` -> `author_name` becomes `Some("林岬")`,
    // and exporting writes `credit == {"author": "林岬"}`.
    let named_state = svc.update_profile(Some("林岬"), None).unwrap();
    cx.cx.update(|cx| {
        cx.update_global::<dr_view_account::Service, _>(|s, _| {
            s.state = named_state;
        });
    });
    cx.read(|cx| {
        assert_eq!(dr_shell::account::author_name(cx).as_deref(), Some("林岬"));
    });

    let named_export = dir.path().join("named.driftingtemplate");
    cx.update(|window, cx| {
        window.dispatch_action(
            Box::new(dr_view_shelf::ExportTemplate {
                template: own_id.clone(),
            }),
            cx,
        );
    });
    cx.run_until_parked();
    cx.simulate_new_path_selection({
        let file = named_export.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| named_export.exists());
    let named_val: Value = serde_json::from_slice(&std::fs::read(&named_export).unwrap()).unwrap();
    assert_eq!(named_val["credit"], json!({"author": "林岬"}));
    assert!(named_val["project"]["book"].get("root").is_none());
    assert!(named_val.get("derivedFrom").is_none());

    // 3. Import a template credited to `"南枝"`, then export it as `"林岬"`
    // (both unedited and edited via working copy): both write ONLY `"林岬"`.
    let mut foreign_val = named_val;
    foreign_val["name"] = json!("外来的悬疑模板");
    foreign_val["credit"] = json!({"author": "南枝"});
    let foreign_src = dir.path().join("from-nanzhi.driftingtemplate");
    std::fs::write(&foreign_src, serde_json::to_vec(&foreign_val).unwrap()).unwrap();
    let foreign_dialog = cx
        .cx
        .update(|cx| template::import_path(lib.clone(), foreign_src, cx));
    wait_for(cx, |cx| shown(&view, cx).is_none());
    let _ = foreign_dialog;

    let foreign_id = templates(&lib)
        .into_iter()
        .find(|t| t["name"] == "外来的悬疑模板")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let reexport_unedited = dir.path().join("reexport-unedited.driftingtemplate");
    cx.update(|window, cx| {
        window.dispatch_action(
            Box::new(dr_view_shelf::ExportTemplate {
                template: foreign_id.clone(),
            }),
            cx,
        );
    });
    cx.run_until_parked();
    cx.simulate_new_path_selection({
        let file = reexport_unedited.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| reexport_unedited.exists());
    let unedited_text = std::fs::read_to_string(&reexport_unedited).unwrap();
    assert!(!unedited_text.contains("南枝"));
    assert!(!unedited_text.contains("derivedFrom"));
    assert_eq!(
        serde_json::from_str::<Value>(&unedited_text).unwrap()["credit"],
        json!({"author": "林岬"})
    );

    // Edit `"外来的悬疑模板"` in its working copy and export again.
    let wc = out(&lib, "project_template.edit", json!({"id": foreign_id}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    let wc_ms = dr_testkit::seed::acceptance::novel_root(&lib, &wc, "tpl-manuscript");
    out(
        &lib,
        "entry.create",
        json!({
            "book": wc,
            "parent": wc_ms,
            "template": "tpl-chapter",
            "title": "改动后的一章"
        }),
    );
    out(&lib, "project_template.save", json!({"book": wc}));

    let reexport_edited = dir.path().join("reexport-edited.driftingtemplate");
    cx.update(|window, cx| {
        window.dispatch_action(
            Box::new(dr_view_shelf::ExportTemplate {
                template: foreign_id,
            }),
            cx,
        );
    });
    cx.run_until_parked();
    cx.simulate_new_path_selection({
        let file = reexport_edited.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| reexport_edited.exists());
    let edited_text = std::fs::read_to_string(&reexport_edited).unwrap();
    assert!(!edited_text.contains("南枝"));
    assert!(!edited_text.contains("derivedFrom"));
    assert_eq!(
        serde_json::from_str::<Value>(&edited_text).unwrap()["credit"],
        json!({"author": "林岬"})
    );
}

#[gpui::test]
fn refused_templates_show_shared_transfer_failure_copy_and_leave_library_untouched(
    cx: &mut TestAppContext,
) {
    use dr_i18n::keys::all_projects::transfer as proj;
    use dr_i18n::keys::project_picker::book_transfer as reason;

    let (dir, lib, book) = library(true);
    let book = book.unwrap();
    let tpl_id = out(
        &lib,
        "project_template.save",
        json!({"book": book, "name": "基准"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let base_file = dir.path().join("base.driftingtemplate");
    dr_export::template_file::export_template(&lib, &tpl_id, None, &base_file).unwrap();
    let base: Value = serde_json::from_slice(&std::fs::read(&base_file).unwrap()).unwrap();

    let docs_before = lib.library().docs(None, None).unwrap().len();
    let (view, cx) = setup_with_account(cx, lib.clone(), None, Some(book));

    let mut newer = base.clone();
    newer["formatVersion"] = json!(2);
    let mut with_homepage = base.clone();
    with_homepage["credit"] = json!({"author": "林岬", "homepage": "https://example.com"});
    let mut with_book_root = base.clone();
    with_book_root["project"]["book"]["root"] = json!("e1");
    let mut with_derived = base.clone();
    with_derived["credit"] = json!({"author": "林岬", "derivedFrom": {"name": "旧"}});
    let mut broken_ref = base;
    broken_ref["project"]["tabs"] = json!([
        {"mount": {"kind": "root"}},
        {"mount": {"kind": "entry", "entry": "e99"}}
    ]);

    let cases: Vec<(&str, Vec<u8>, dr_i18n::Key)> = vec![
        ("not-template", b"plain notes".to_vec(), proj::NOT_PROJECT),
        ("newer", serde_json::to_vec(&newer).unwrap(), proj::NEWER),
        (
            "too-large",
            vec![b' '; (dr_export::template_file::MAX_BYTES as usize) + 1],
            proj::TOO_LARGE,
        ),
        (
            "homepage",
            serde_json::to_vec(&with_homepage).unwrap(),
            reason::INVALID,
        ),
        (
            "book-root",
            serde_json::to_vec(&with_book_root).unwrap(),
            reason::INVALID,
        ),
        (
            "derived-from",
            serde_json::to_vec(&with_derived).unwrap(),
            reason::INVALID,
        ),
        (
            "broken-ref",
            serde_json::to_vec(&broken_ref).unwrap(),
            reason::INVALID,
        ),
    ];

    for (idx, (name, bytes, expected_reason)) in cases.into_iter().enumerate() {
        let file = dir.path().join(format!("bad-{name}.driftingtemplate"));
        std::fs::write(&file, &bytes).unwrap();
        let dialog = cx
            .cx
            .update(|cx| template::import_path(lib.clone(), file, cx));
        assert!(shown(&view, cx).is_some());
        wait_for(cx, |cx| !dialog.read_with(cx, |d, _| d.is_working()));
        let state = dialog.read_with(cx, |d, _| d.state.clone());
        let State::Failed {
            title, reason: got, ..
        } = state
        else {
            panic!("{name}: expected Failed, got {state:?}");
        };
        assert_eq!(
            (title, got),
            (reason::IMPORT_FAILED_TITLE, expected_reason),
            "case {name}"
        );
        assert_eq!(books(&lib), 1);
        assert_eq!(templates(&lib).len(), 1);
        assert_eq!(lib.library().docs(None, None).unwrap().len(), docs_before);

        if idx % 2 == 0 {
            cx.update(|w, cx| w.draw(cx).clear(cx));
            cx.run_until_parked();
            cx.simulate_keystrokes("escape");
        } else {
            cx.cx.update(|cx| dialog.update(cx, |d, cx| d.close(cx)));
        }
        cx.run_until_parked();
        assert!(shown(&view, cx).is_none());
    }
}
