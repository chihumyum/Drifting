//! `.driftingmodule` file transfer in the shell over a real library
//! (`custom-modules.md` §10, CM3), as `.driftingtemplate`'s:
//! - export goes straight to the save panel, no dialog, the same module the
//!   same bytes; importing the file back always adds a new module;
//! - files dropped on All Projects are imported, no question first;
//! - a bad file is refused with the template import's words for 「模块」 and
//!   nothing is written.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::Library;
use dr_view_transfer::{State, TransferDialog};
use dr_workspace::{Actor, Workspace as Lib, WorkspaceOptions, library_options};
use gpui::{
    Entity, ExternalPaths, FileDropEvent, Point, TestAppContext, VisualTestContext, point, px,
};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn out(ws: &Lib, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn modules(lib: &Lib) -> Vec<Value> {
    out(lib, "custom_module.list", json!({}))
        .as_array()
        .unwrap()
        .clone()
}

fn setup(cx: &mut TestAppContext, lib: Lib) -> (Entity<Workspace>, &mut VisualTestContext) {
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
                ..Services::default()
            },
            settings,
            cx,
        );
        dr_view_shelf::init(cx);
        dr_view_transfer::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
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

fn drop_files(cx: &mut VisualTestContext, paths: Vec<PathBuf>, at: Point<gpui::Pixels>) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.simulate_event(FileDropEvent::Entered {
        position: at,
        paths: ExternalPaths(paths.into_iter().collect()),
    });
    cx.simulate_event(FileDropEvent::Submit { position: at });
    cx.simulate_event(FileDropEvent::Ended);
}

#[gpui::test]
fn export_is_the_same_bytes_and_import_or_drop_always_adds_a_new_module(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Lib::open(
        Library::open(dir.path().join("library"), library_options(VERSION)).unwrap(),
        WorkspaceOptions::default(),
    )
    .unwrap();
    let raw = dr_testkit::samples::MODULE_FILES[0].1;
    let id = out(
        &lib,
        "custom_module.create",
        json!({"value": serde_json::from_str::<Value>(raw).unwrap()}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (view, cx) = setup(cx, lib.clone());

    // Export: straight to the save panel, no dialog.
    let file = dir.path().join("伏笔追踪.driftingmodule");
    cx.update(|window, cx| {
        window.dispatch_action(
            Box::new(dr_view_shelf::ExportModule { module: id.clone() }),
            cx,
        )
    });
    cx.run_until_parked();
    assert!(
        shown(&view, cx).is_none(),
        "no dialog before the save panel"
    );
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection({
        let file = file.clone();
        move |_| Some(file)
    });
    wait_for(cx, |_| file.exists());
    assert!(shown(&view, cx).is_none(), "nothing after it either");
    let first = std::fs::read(&file).unwrap();
    // The same module, the same bytes.
    let again = dir.path().join("again.driftingmodule");
    cx.update(|_, cx| {
        dr_view_transfer::module::export_path(lib.clone(), id.clone(), None, again.clone(), cx)
    });
    wait_for(cx, |_| {
        again.exists() && std::fs::metadata(&again).unwrap().len() > 0
    });
    assert_eq!(first, std::fs::read(&again).unwrap());

    // Import it: a new module, never the old one replaced.
    cx.update(|_, cx| {
        dr_view_transfer::module::import_path(lib.clone(), file.clone(), cx);
    });
    wait_for(cx, |_| modules(&lib).len() == 2);
    let ids: Vec<String> = modules(&lib)
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(ids.contains(&id));
    // Dropped on All Projects (the window shows it: no project here).
    assert!(view.read_with(cx, |ws, _| ws.shelf_open));
    drop_files(cx, vec![file.clone()], point(px(600.0), px(400.0)));
    wait_for(cx, |_| modules(&lib).len() == 3);
}

#[gpui::test]
fn a_bad_module_file_says_why_in_the_modules_words_and_writes_nothing(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Lib::open(
        Library::open(dir.path().join("library"), library_options(VERSION)).unwrap(),
        WorkspaceOptions::default(),
    )
    .unwrap();
    let (view, cx) = setup(cx, lib.clone());
    let cases = [
        ("not.driftingmodule", "{\"hello\": 1}".to_owned(), dr_i18n::keys::module_bench::transfer::NOT_MODULE),
        (
            "newer.driftingmodule",
            "{\"format\":\"drifting.module\",\"formatVersion\":99,\"name\":\"x\"}".to_owned(),
            dr_i18n::keys::module_bench::transfer::NEWER,
        ),
        (
            "damaged.driftingmodule",
            "{\"format\":\"drifting.module\",\"formatVersion\":1,\"name\":\"x\",\"look\":{\"block\":{\"box\":\"col\",\"gap\":5}}}".to_owned(),
            dr_i18n::keys::module_bench::transfer::DAMAGED,
        ),
    ];
    for (name, body, want) in cases {
        let path = dir.path().join(name);
        std::fs::write(&path, body).unwrap();
        let dialog =
            cx.update(|_, cx| dr_view_transfer::module::import_path(lib.clone(), path, cx));
        wait_for(cx, |cx| {
            dialog.read_with(cx, |d, _| matches!(d.state, State::Failed { .. }))
        });
        let reason = dialog.read_with(cx, |d, _| match &d.state {
            State::Failed { reason, .. } => Some(*reason),
            _ => None,
        });
        assert_eq!(reason, Some(want), "{name}");
        assert!(modules(&lib).is_empty(), "{name}: nothing written");
        dialog.update(cx, |_, cx| cx.notify());
        cx.update(|_, cx| dr_shell::dialogs::hide(cx, dialog.entity_id()));
        cx.run_until_parked();
        let _ = &view;
    }
}
