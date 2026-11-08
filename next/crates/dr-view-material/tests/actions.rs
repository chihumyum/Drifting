//! Page actions over the sample book and real F3 commands, driven through
//! the shell's registered menu. Synthetic images come from dr-testkit.

use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    pages::{PageMenuHost, PageMenuSection},
};
use dr_view_material::menu::{MaterialDialog, source_path};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn library() -> (tempfile::TempDir, Library, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let sample = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &sample).unwrap();
    lib.close().unwrap();
    let book = sample.book.book_id().to_string();
    let lib = Library::open_dir(&root, "test").unwrap();
    let note = call(&lib, "material.list", json!({"book": book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "text")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (dir, lib, book, note)
}

fn setup(cx: &mut TestAppContext, lib: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
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
        dr_view_material::init(cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    cx.update(|w, _| w.activate_window());
    wait(cx, |cx| ws.read_with(cx, |w, _| !w.book.is_empty()));
    (ws, cx)
}

fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        cx.update(|w, cx| w.draw(cx).clear(cx));
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn menu(ws: &Entity<Workspace>, id: &str, cx: &mut VisualTestContext) -> Vec<PageMenuSection> {
    cx.update(|_, cx| {
        dr_shell::workspace::page_actions::page_actions(
            ws,
            &PageMenuHost::of(ws, cx),
            &Target::Material(id.parse().unwrap()),
            cx,
        )
    })
}

fn run(
    ws: &Entity<Workspace>,
    id: &str,
    item: &str,
    cx: &mut VisualTestContext,
) -> Entity<MaterialDialog> {
    let action = menu(ws, id, cx)
        .into_iter()
        .flat_map(|s| s.items)
        .find(|i| i.id == item)
        .unwrap()
        .run;
    cx.update(|w, cx| action(w, cx));
    wait(cx, |cx| ws.read_with(cx, |w, _| w.dialog.is_some()));
    ws.read_with(cx, |w, _| {
        w.dialog
            .as_ref()
            .unwrap()
            .clone()
            .downcast::<MaterialDialog>()
            .unwrap()
    })
}

fn closed(ws: &Entity<Workspace>, cx: &mut VisualTestContext) {
    wait(cx, |cx| ws.read_with(cx, |w, _| w.dialog.is_none()));
}

fn material(lib: &Library, book: &str, id: &str) -> Value {
    call(lib, "material.list", json!({"book": book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .unwrap()
        .clone()
}

#[gpui::test]
fn page_menu_distinguishes_notes_and_media_and_keeps_delete_last(cx: &mut TestAppContext) {
    let (dir, lib, book, note) = library();
    let image = dr_view_material::import::import_bytes(
        &lib,
        &book,
        None,
        dr_testkit::media::png(32, 20),
        "东岸速写",
    )
    .unwrap()
    .material;
    let pdf_file = dir.path().join("tides.pdf");
    std::fs::write(&pdf_file, dr_testkit::media::sample_pdf()).unwrap();
    let pdf = dr_view_material::import::import_path(&lib, &book, None, &pdf_file)
        .unwrap()
        .material;
    let (ws, cx) = setup(cx, lib);
    for (id, media) in [(&note, false), (&image, true), (&pdf, true)] {
        let rows: Vec<_> = menu(&ws, id, cx)
            .into_iter()
            .flat_map(|s| s.items)
            .collect();
        assert_eq!(rows.iter().any(|r| r.id == "material-open-original"), media);
        assert!(rows.iter().any(|r| r.id == "material-move" && !r.danger));
        assert_eq!(rows.last().unwrap().id, "material-delete");
        assert!(rows.last().unwrap().danger);
        assert!(rows.iter().any(|r| r.id == "page-history"));
    }
}

#[gpui::test]
fn folder_picker_moves_to_existing_root_and_new_folder(cx: &mut TestAppContext) {
    let (_dir, lib, book, note) = library();
    let folder = call(
        &lib,
        "material_folder.create",
        json!({"book": book, "name": "潮汐"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (ws, cx) = setup(cx, lib.clone());
    let dialog = run(&ws, &note, "material-move", cx);
    cx.update(|w, cx| dialog.update(cx, |d, cx| d.move_to(Some(folder.clone()), w, cx)));
    closed(&ws, cx);
    assert_eq!(material(&lib, &book, &note)["folder"], folder);

    let dialog = run(&ws, &note, "material-move", cx);
    cx.update(|w, cx| dialog.update(cx, |d, cx| d.move_to(None, w, cx)));
    closed(&ws, cx);
    assert!(material(&lib, &book, &note)["folder"].is_null());

    let dialog = run(&ws, &note, "material-move", cx);
    let field = dialog.read_with(cx, |d, _| d.field());
    cx.update(|w, cx| {
        field.update(cx, |f, cx| f.set_text("   ", cx));
        dialog.update(cx, |d, cx| d.create_and_move(w, cx));
    });
    assert!(ws.read_with(cx, |w, _| w.dialog.is_some()));
    cx.update(|w, cx| {
        field.update(cx, |f, cx| f.set_text("  东岸  ", cx));
        field.focus_handle(cx).focus(w, cx);
    });
    cx.simulate_keystrokes("enter");
    closed(&ws, cx);
    let made = material(&lib, &book, &note)["folder"].clone();
    let folders = call(&lib, "material_folder.list", json!({"book": book}));
    let made = folders
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == made)
        .unwrap();
    assert_eq!(made["name"], "东岸");
    assert!(made["parent"].is_null());
}

#[gpui::test]
fn delete_cancel_keeps_material_and_confirmation_closes_its_tab(cx: &mut TestAppContext) {
    let (_dir, lib, book, note) = library();
    let (ws, cx) = setup(cx, lib.clone());
    let target = Target::Material(note.parse().unwrap());
    ws.update(cx, |w, cx| w.open(target.clone(), Open::KEEP, cx));
    run(&ws, &note, "material-delete", cx);
    cx.simulate_keystrokes("escape");
    closed(&ws, cx);
    assert_eq!(material(&lib, &book, &note)["id"], note);
    let dialog = run(&ws, &note, "material-delete", cx);
    cx.update(|w, cx| dialog.update(cx, |d, cx| d.confirm_delete(w, cx)));
    closed(&ws, cx);
    assert!(
        !call(&lib, "material.list", json!({"book": book}))
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == note)
    );
    wait(cx, |cx| {
        ws.read_with(cx, |w, _| !w.nav.is_selected(&target))
    });
}

#[gpui::test]
fn original_is_source_bytes_and_missing_source_shows_an_alert(cx: &mut TestAppContext) {
    let (_dir, lib, book, _note) = library();
    let bytes = dr_testkit::media::png(32, 20);
    let image =
        dr_view_material::import::import_bytes(&lib, &book, None, bytes.clone(), "东岸速写")
            .unwrap()
            .material;
    let original = source_path(&lib, &book, &image).unwrap();
    assert_eq!(std::fs::read(&original).unwrap(), bytes);
    std::fs::remove_file(original).unwrap();
    assert!(source_path(&lib, &book, &image).is_err());
    let (ws, cx) = setup(cx, lib);
    let dialog = run(&ws, &image, "material-open-original", cx);
    dialog.update(cx, |d, cx| d.close(cx));
    closed(&ws, cx);
}
