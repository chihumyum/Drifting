//! CM3 on All Projects (`custom-modules.md` §10, §16 item 4; 原型第三页):
//! 「我的模块」 under 「我的模板」, one row a module, its hover card with the
//! module's 一块 drawn with its sample, 编辑, 导出 and 删除 (after a
//! question, as a template's); 「导入模块」 under 「导入模板」; 编辑 opens the
//! module's workbench as a pill of the project. Deleting a module leaves
//! the projects using it their copies.

use std::time::{Duration, Instant};

use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace, nav::Target};
use dr_view_shelf::{ExportModule, Shelf, ShelfDialog};
use dr_workspace::{Actor, Workspace as Library, WorkspaceOptions};
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn call(ws: &Library, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn sample(name: &str) -> Value {
    let raw = dr_testkit::samples::MODULE_FILES
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap()
        .1;
    serde_json::from_str(raw).unwrap()
}

fn library() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    let v3 = dr_testkit::seed::book_to_v3(&book).unwrap();
    let book_id = v3.book_id().to_string();
    dr_testkit::seed::write_book_v3(&lib, &v3).unwrap();
    lib.rebuild_stale_indexes().unwrap();
    let workspace = Library::open(lib, WorkspaceOptions::default()).unwrap();
    (dir, workspace, book_id)
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
        Settings::update(cx, |s| {
            s.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .unwrap();
        });
        dr_view_shelf::init(cx);
    });
    let (view, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(900.0)));
    vcx.update(|window, _| window.activate_window());
    vcx.run_until_parked();
    (view, vcx)
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        cx.executor().advance_clock(Duration::from_millis(30));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "shelf CM3 timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn bounds(cx: &mut VisualTestContext, selector: &str) -> Option<gpui::Bounds<gpui::Pixels>> {
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    cx.debug_bounds(selector)
}

fn shelf_of(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<Shelf> {
    view.read_with(cx, |ws, _| ws.shelf.clone())
        .expect("shelf mounted")
        .view
        .downcast::<Shelf>()
        .expect("Shelf entity")
}

/// The pointer on module `id`'s row: its hover card opens.
fn card(cx: &mut VisualTestContext, id: &str) {
    cx.simulate_mouse_move(gpui::point(px(900.0), px(600.0)), None, Modifiers::none());
    wait(cx, "away from the rail", |_| true);
    let row = bounds(cx, &format!("shelf-module-{id}")).unwrap();
    cx.simulate_mouse_move(row.center(), None, Modifiers::none());
    let edit = format!("shelf-module-edit-{id}");
    wait(cx, "the module's hover card", |cx| {
        bounds(cx, &edit).is_some()
    });
}

fn press(cx: &mut VisualTestContext, selector: &str) {
    let at = bounds(cx, selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"))
        .center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    cx.simulate_click(at, Modifiers::none());
    wait(cx, selector, |_| true);
}

#[gpui::test]
fn my_modules_on_all_projects_edit_export_and_delete(cx: &mut TestAppContext) {
    let (_dir, lib, book) = library();
    let (view, vcx) = setup(cx, lib.clone());
    let shelf = shelf_of(&view, vcx);
    // Without modules, no section; 「导入模块」 is there.
    wait(vcx, "the shelf", |vcx| {
        shelf.read_with(vcx, |s, _| s.data.is_some())
    });
    assert!(bounds(vcx, "shelf-my-modules-section").is_none());
    assert!(bounds(vcx, "shelf-import-module").is_some());

    let fore = call(
        &lib,
        "custom_module.create",
        json!({"value": sample("foreshadowing")}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let magic = call(
        &lib,
        "custom_module.create",
        json!({"value": sample("magic-rule")}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // A project uses 魔法规则卡.
    let template = call(&lib, "entry_template.list", json!({"book": book}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "entry_template.put_module",
        json!({"book": book, "template": template, "module": {
            "id": "mod-magic", "kind": "custom", "name": "魔法", "config": {"module": magic}
        }}),
    );
    wait(vcx, "both modules listed", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.data.as_ref().is_some_and(|d| d.modules.len() == 2)
        })
    });
    wait(vcx, "the section drawn", |vcx| {
        bounds(vcx, &format!("shelf-module-{fore}")).is_some()
    });
    assert!(bounds(vcx, "shelf-my-modules-section").is_some());

    // The card: the module drawn with its sample, then 编辑, 导出, 删除.
    card(vcx, &fore);
    assert!(bounds(vcx, &format!("shelf-module-preview-{fore}")).is_some());
    assert!(bounds(vcx, &format!("shelf-module-export-{fore}")).is_some());
    assert!(bounds(vcx, &format!("shelf-module-delete-{fore}")).is_some());
    // 导出 dispatches the export (dr-view-transfer takes it to the save panel).
    let exported = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
    let seen = exported.clone();
    vcx.update(|_, cx| {
        cx.on_action(move |a: &ExportModule, _| *seen.borrow_mut() = Some(a.module.clone()));
    });
    press(vcx, &format!("shelf-module-export-{fore}"));
    assert_eq!(exported.borrow().as_deref(), Some(fore.as_str()));

    // 删除 asks; 取消 keeps it.
    card(vcx, &magic);
    press(vcx, &format!("shelf-module-delete-{magic}"));
    assert_eq!(
        shelf.read_with(vcx, |s, _| s.dialog()),
        Some(ShelfDialog::DeleteModule(magic.clone()))
    );
    press(vcx, "shelf-delete-module-cancel");
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);
    assert_eq!(
        call(&lib, "custom_module.list", json!({}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // 删除 for good: gone from my modules; the project keeps its copy.
    card(vcx, &magic);
    press(vcx, &format!("shelf-module-delete-{magic}"));
    press(vcx, "shelf-delete-module-confirm");
    wait(vcx, "deleted", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.dialog().is_none() && s.data.as_ref().is_some_and(|d| d.modules.len() == 1)
        })
    });
    let read = call(&lib, "entry_template.list", json!({"book": book}));
    assert!(
        read[0]["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "mod-magic")
    );
    let copy = lib
        .call(
            &Actor::User,
            "custom_module.save_as",
            json!({"book": book, "module": magic}),
        )
        .map(|_| ());
    assert!(copy.is_ok(), "the book's copy is still there to save");

    // 编辑: All Projects gives way to the project, the workbench a pill.
    card(vcx, &fore);
    press(vcx, &format!("shelf-module-edit-{fore}"));
    wait(vcx, "the workbench's pill", |vcx| {
        view.read_with(vcx, |ws, _| {
            !ws.shelf_open && ws.nav.current() == Some(&Target::Module(fore.parse().unwrap()))
        })
    });
    assert_eq!(view.read_with(vcx, |ws, _| ws.book_id.clone()), book);
}
