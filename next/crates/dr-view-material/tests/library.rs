//! The 素材库 panel on GPUI's test platform, on a real workspace with
//! synthetic files (dr-testkit's media): files dropped in become materials
//! in the folder they land on (and what is not an image or a PDF is left
//! out); a copied image pasted becomes one; a new folder takes its typed
//! name; a selection moves into a folder and is deleted; folders fold.

use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::book::Book;
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_store::Library;
use dr_store::asset::Variant;
use dr_ui::Appearance;
use dr_view_material::folders::{Entry, Selection};
use dr_view_material::library::LibraryPanel;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    ClipboardItem, Entity, Image, ImageFormat, TestAppContext, VisualTestContext, WeakEntity, px,
    size,
};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("lib"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "project.create", json!({"name": "素材"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env { dir, ws, book }
}

fn file(e: &Env, name: &str, bytes: Vec<u8>) -> PathBuf {
    let path = e.dir.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: Some(Appearance::Light),
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait_for(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The panel in a 320 × 700 window, on the book as it is now.
fn open(cx: &mut TestAppContext, e: &Env) -> (Entity<LibraryPanel>, VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            let mut file = SettingsFile::in_memory();
            file.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .ok();
            dr_shell::init(info(), Services::default(), file, cx);
            cx.bind_keys(dr_view_material::library::bindings());
        }
    });
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let lib = e.ws.clone();
    let window = cx.add_window(move |window, cx| {
        LibraryPanel::new(WeakEntity::new_invalid(), Some(lib), book, window, cx)
    });
    let panel = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(320.), px(700.)));
    draw(&mut vcx);
    (panel, vcx)
}

/// The book read again into the panel (the shell does this after writes).
fn reload(e: &Env, panel: &Entity<LibraryPanel>, cx: &mut VisualTestContext) {
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    panel.update(cx, |p, cx| p.set_book(book, cx));
    draw(cx);
}

fn materials(e: &Env) -> Vec<dr_shell::book::MaterialInfo> {
    Book::load(&e.ws, &e.book)
        .unwrap()
        .material_items()
        .to_vec()
}

fn keys(panel: &Entity<LibraryPanel>, cx: &mut VisualTestContext) -> Vec<String> {
    panel.read_with(cx, |p, _| p.entries().iter().map(Entry::key).collect())
}

#[gpui::test]
fn dropped_files_become_materials_and_keep_thumbnails(cx: &mut TestAppContext) {
    let e = env();
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    let png = file(&e, "东岸速写.png", dr_testkit::media::png(600, 400));
    let pdf = file(&e, "潮汐笔记.pdf", dr_testkit::media::sample_pdf());
    let doc = file(&e, "提纲.docx", b"not a picture".to_vec());
    panel.update(cx, |p, cx| p.import_paths(vec![png, pdf, doc], None, cx));
    assert!(panel.read_with(cx, |p, _| p.importing()));
    wait_for(cx, |cx| !panel.read_with(cx, |p, _| p.importing()));
    let made = materials(&e);
    assert_eq!(made.len(), 2, "the Word file is left out: {made:?}");
    let by_title = |title: &str| made.iter().find(|m| m.title == title).unwrap().clone();
    let image = by_title("东岸速写");
    assert_eq!(image.kind, "image");
    assert_eq!(by_title("潮汐笔记").kind, "pdf");
    // Display copy and thumbnail are kept beside the image; a PDF has a
    // thumbnail of its first page.
    let store = e.ws.library();
    let asset = image.asset.as_deref().unwrap();
    let display = store.asset(asset, Variant::Display).unwrap().unwrap();
    assert_eq!((display.width, display.height), (Some(600), Some(400)));
    assert!(store.asset(asset, Variant::Thumbnail).unwrap().is_some());
    let pdf_asset = by_title("潮汐笔记").asset.clone().unwrap();
    assert!(
        store
            .asset(&pdf_asset, Variant::Thumbnail)
            .unwrap()
            .is_some()
    );
    reload(&e, &panel, cx);
    assert_eq!(keys(&panel, cx).len(), 2);
}

#[gpui::test]
fn a_copied_image_pastes_as_a_material(cx: &mut TestAppContext) {
    let e = env();
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    let existing = file(&e, "existing.png", dr_testkit::media::png(30, 30));
    panel.update(cx, |p, cx| p.import_paths(vec![existing], None, cx));
    wait_for(cx, |cx| !panel.read_with(cx, |p, _| p.importing()));
    cx.update(|_, cx| {
        cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
            ImageFormat::Png,
            dr_testkit::media::png(64, 48),
        )))
    });
    panel.update(cx, |p, cx| p.paste(cx));
    wait_for(cx, |cx| {
        !panel.read_with(cx, |p, _| p.importing()) && materials(&e).len() == 2
    });
    let made = materials(&e);
    assert_eq!(made.len(), 2);
    // Placed at the very top of the library with timestamped default name and inline rename active.
    assert!(
        made[0].title.starts_with("粘贴的图片 "),
        "unexpected pasted title: {}",
        made[0].title
    );
    assert_eq!(made[0].kind, "image");
    reload(&e, &panel, cx);
    wait_for(cx, |cx| panel.read_with(cx, |p, _| p.renaming().is_some()));
    assert_eq!(
        panel.read_with(cx, |p, _| p.renaming().map(str::to_owned)),
        Some(dr_view_material::folders::material_key(&made[0].id))
    );
}

#[gpui::test]
fn a_selection_selects_all_clears_and_is_deleted(cx: &mut TestAppContext) {
    let e = env();
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    // Two different pictures: the same bytes would be one file.
    let a = file(&e, "a.png", dr_testkit::media::png(32, 32));
    let b = file(&e, "b.png", dr_testkit::media::png(32, 33));
    panel.update(cx, |p, cx| p.import_paths(vec![a, b], None, cx));
    wait_for(cx, |cx| !panel.read_with(cx, |p, _| p.importing()));
    reload(&e, &panel, cx);
    assert_eq!(keys(&panel, cx).len(), 2);
    panel.update(cx, |p, cx| p.select_all(cx));
    assert_eq!(panel.read_with(cx, |p, _| p.picker().selected.len()), 2);
    cx.update(|window, cx| {
        let focus = gpui::Focusable::focus_handle(panel.read(cx), cx);
        window.focus(&focus, cx);
    });
    draw(cx);
    cx.simulate_keystrokes("escape");
    assert!(panel.read_with(cx, |p, _| p.picker().selected.is_empty()));
    let ids: Vec<String> = materials(&e).into_iter().map(|m| m.id).collect();
    let sel = Selection {
        materials: ids,
        folders: Vec::new(),
    };
    panel.update(cx, |p, cx| p.delete(sel, cx));
    wait_for(cx, |_| materials(&e).is_empty());
}

#[gpui::test]
fn view_mode_persists_current_dedupes_keeping_zero_count_folders_and_trash_restores(
    cx: &mut TestAppContext,
) {
    use dr_view_material::library::ViewMode;
    let e = env();
    let (panel, mut vcx) = open(cx, &e);
    assert_eq!(panel.read_with(&vcx, |p, _| p.view_mode()), ViewMode::List);
    panel.update(&mut vcx, |p, cx| p.set_view_mode(ViewMode::Masonry, cx));
    assert_eq!(
        panel.read_with(&vcx, |p, _| p.view_mode()),
        ViewMode::Masonry
    );

    // Reopening a fresh LibraryPanel in the same Settings session restores Masonry.
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let lib = e.ws.clone();
    let window2 = cx.add_window(move |window, cx| {
        LibraryPanel::new(WeakEntity::new_invalid(), Some(lib), book, window, cx)
    });
    let panel2 = window2.root(cx).unwrap();
    let mut vcx2 = VisualTestContext::from_window(window2.into(), cx);
    draw(&mut vcx2);
    assert_eq!(
        panel2.read_with(&vcx2, |p, _| p.view_mode()),
        ViewMode::Masonry
    );
    panel2.update(&mut vcx2, |p, cx| p.set_view_mode(ViewMode::List, cx));

    // Create a folder whose sole file is used in an entry: `当前` pins the file,
    // `其他` deduplicates the file while keeping the folder row at count 0.
    let folder = dr_view_material::folders::create_folder(&e.ws, &e.book, "海图集", None).unwrap();
    let used_file = dr_view_material::import::import_bytes(
        &e.ws,
        &e.book,
        Some(&folder),
        dr_testkit::media::png(40, 30),
        "东岸海图",
    )
    .unwrap()
    .material;
    let other_file = dr_view_material::import::import_bytes(
        &e.ws,
        &e.book,
        None,
        dr_testkit::media::png(48, 36),
        "码头草图",
    )
    .unwrap()
    .material;
    out(
        &e.ws,
        "entry_template.put",
        json!({"book": e.book, "template": {"id": "test-media-tpl", "name": "设定",
            "modules": [{"id": "mod-media", "kind": "media", "name": "媒体"}]}}),
    );
    let entry = out(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "template": "test-media-tpl", "title": "东岸"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "module.put_media",
        json!({"book": e.book, "entry": entry, "module": "mod-media",
            "item": {"id": dr_model::id::new_uuid_v7(), "asset": used_file, "caption": ""}}),
    );
    reload(&e, &panel2, &mut vcx2);
    wait_for(&mut vcx2, |cx| {
        panel2.read_with(cx, |p, cx| p.current_for_entry(&entry, cx).len() == 1)
    });
    let current = panel2.read_with(&vcx2, |p, cx| p.current_for_entry(&entry, cx));
    assert_eq!(current[0].asset_id, used_file);
    assert_eq!(current[0].module_name, "媒体");
    let other_rows = panel2.read_with(&vcx2, |p, _| p.other_entries_for(&current));
    let folder_row = other_rows
        .iter()
        .find_map(|r| match r {
            Entry::Folder { id, count, .. } if id == &folder => Some(*count),
            _ => None,
        })
        .expect("empty-after-dedupe folder stays in 其他");
    assert_eq!(folder_row, 0);
    assert!(
        !other_rows
            .iter()
            .any(|r| matches!(r, Entry::Material { id, .. } if id == &used_file)),
        "pinned file is deduplicated from 其他"
    );
    assert!(
        other_rows
            .iter()
            .any(|r| matches!(r, Entry::Material { id, .. } if id == &other_file))
    );

    // Move `other_file` to Recently Deleted, verify it appears in trashed_assets,
    // restore it, then trash and permanently purge it.
    panel2.update(&mut vcx2, |p, cx| {
        p.delete(
            Selection {
                materials: vec![other_file.clone()],
                folders: Vec::new(),
            },
            cx,
        )
    });
    wait_for(&mut vcx2, |cx| {
        panel2.read_with(cx, |p, _| {
            p.trashed_assets().iter().any(|a| a.id == other_file)
        })
    });
    panel2.update(&mut vcx2, |p, cx| {
        p.restore_trashed_asset(other_file.clone(), cx)
    });
    wait_for(&mut vcx2, |cx| {
        panel2.read_with(cx, |p, _| {
            p.trashed_assets().is_empty() && materials(&e).iter().any(|m| m.id == other_file)
        })
    });
    panel2.update(&mut vcx2, |p, cx| {
        p.delete(
            Selection {
                materials: vec![other_file.clone()],
                folders: Vec::new(),
            },
            cx,
        )
    });
    wait_for(&mut vcx2, |cx| {
        panel2.read_with(cx, |p, _| {
            p.trashed_assets().iter().any(|a| a.id == other_file)
        })
    });
    panel2.update(&mut vcx2, |p, cx| {
        p.purge_trashed_asset(other_file.clone(), cx)
    });
    wait_for(&mut vcx2, |cx| {
        panel2.read_with(cx, |p, _| p.trashed_assets().is_empty())
    });
}
