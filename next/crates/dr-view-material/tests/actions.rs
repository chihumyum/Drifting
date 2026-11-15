//! Page actions over the sample book and real F3 commands, driven through
//! the shell's registered menu. Synthetic images come from dr-testkit.

use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    pages::{PageMenuHost, PageMenuSection},
};
use dr_view_material::menu::{MaterialDialog, source_path};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

fn library() -> (tempfile::TempDir, Library, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let sample = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&sample).unwrap()).unwrap();
    lib.close().unwrap();
    let book = sample.book.book_id().to_string();
    let lib = Library::open_dir(&root, "test").unwrap();
    let media = dr_view_material::import::import_bytes(
        &lib,
        &book,
        None,
        dr_testkit::media::png(24, 24),
        "初始图片",
    )
    .unwrap()
    .material;
    (dir, lib, book, media)
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

fn has_material(lib: &Library, book: &str, id: &str) -> bool {
    dr_shell::book::Book::load(lib, book)
        .unwrap()
        .material_items()
        .iter()
        .any(|m| m.id == id)
}

#[gpui::test]
fn page_menu_exposes_open_original_history_and_keeps_delete_last(cx: &mut TestAppContext) {
    let (dir, lib, book, _initial) = library();
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
    for id in [&image, &pdf] {
        let rows: Vec<_> = menu(&ws, id, cx)
            .into_iter()
            .flat_map(|s| s.items)
            .collect();
        assert!(rows.iter().any(|r| r.id == "material-open-original"));
        assert_eq!(rows.last().unwrap().id, "material-delete");
        assert!(rows.last().unwrap().danger);
        assert!(!rows.iter().any(|r| r.id == "page-history"));
    }
}

#[gpui::test]
fn delete_moves_material_to_trash_without_confirmation_and_closes_its_tab(cx: &mut TestAppContext) {
    let (_dir, lib, book, media) = library();
    let (ws, cx) = setup(cx, lib.clone());
    let target = Target::Material(media.parse().unwrap());
    ws.update(cx, |w, cx| w.open(target.clone(), Open::KEEP, cx));
    let action = menu(&ws, &media, cx)
        .into_iter()
        .flat_map(|s| s.items)
        .find(|i| i.id == "material-delete")
        .unwrap()
        .run;
    cx.update(|w, cx| action(w, cx));
    assert!(ws.read_with(cx, |w, _| w.dialog.is_none()));
    wait(cx, |_| !has_material(&lib, &book, &media));
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
