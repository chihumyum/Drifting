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
    let book = out(&ws, "book.create", json!({"name": "素材"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env { dir, ws, book }
}

fn folder(e: &Env, name: &str, parent: Option<&str>) -> String {
    let mut input = json!({"book": e.book, "name": name});
    if let Some(p) = parent {
        input["parent"] = json!(p);
    }
    out(&e.ws, "material_folder.create", input)["id"]
        .as_str()
        .unwrap()
        .to_owned()
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

fn materials(e: &Env) -> Vec<Value> {
    out(&e.ws, "material.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .clone()
}

fn keys(panel: &Entity<LibraryPanel>, cx: &mut VisualTestContext) -> Vec<String> {
    panel.read_with(cx, |p, _| p.entries().iter().map(Entry::key).collect())
}

#[gpui::test]
fn dropped_files_become_materials_in_their_folder(cx: &mut TestAppContext) {
    let e = env();
    let maps = folder(&e, "地图", None);
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    let png = file(&e, "东岸速写.png", dr_testkit::media::png(600, 400));
    let pdf = file(&e, "潮汐笔记.pdf", dr_testkit::media::sample_pdf());
    let doc = file(&e, "提纲.docx", b"not a picture".to_vec());
    panel.update(cx, |p, cx| {
        p.import_paths(vec![png, pdf, doc], Some(maps.clone()), cx)
    });
    assert!(panel.read_with(cx, |p, _| p.importing()));
    wait_for(cx, |cx| !panel.read_with(cx, |p, _| p.importing()));
    let made = materials(&e);
    assert_eq!(made.len(), 2, "the Word file is left out: {made:?}");
    let by_title = |title: &str| made.iter().find(|m| m["title"] == title).unwrap().clone();
    let image = by_title("东岸速写");
    assert_eq!(
        (image["kind"].as_str(), image["folder"].as_str()),
        (Some("image"), Some(maps.as_str()))
    );
    assert_eq!(by_title("潮汐笔记")["kind"], "pdf");
    // Display copy and thumbnail are kept beside the image; a PDF has a
    // thumbnail of its first page.
    let store = e.ws.library();
    let asset = image["asset"].as_str().unwrap();
    let display = store.asset(asset, Variant::Display).unwrap().unwrap();
    assert_eq!((display.width, display.height), (Some(600), Some(400)));
    assert!(store.asset(asset, Variant::Thumbnail).unwrap().is_some());
    let pdf_asset = by_title("潮汐笔记")["asset"].as_str().unwrap().to_owned();
    assert!(
        store
            .asset(&pdf_asset, Variant::Thumbnail)
            .unwrap()
            .is_some()
    );
    // The folder opened to show them.
    reload(&e, &panel, cx);
    assert_eq!(
        keys(&panel, cx).len(),
        3,
        "the folder and its two materials"
    );
}

#[gpui::test]
fn a_copied_image_pastes_as_a_material(cx: &mut TestAppContext) {
    let e = env();
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    cx.update(|_, cx| {
        cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
            ImageFormat::Png,
            dr_testkit::media::png(64, 48),
        )))
    });
    panel.update(cx, |p, cx| p.paste(cx));
    wait_for(cx, |cx| {
        !panel.read_with(cx, |p, _| p.importing()) && !materials(&e).is_empty()
    });
    let made = materials(&e);
    assert_eq!(made.len(), 1);
    assert_eq!(made[0]["title"], "粘贴的图片");
    assert_eq!(made[0]["kind"], "image");
}

#[gpui::test]
fn a_new_folder_takes_its_typed_name(cx: &mut TestAppContext) {
    let e = env();
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    panel.update(cx, |p, cx| p.new_folder(None, cx));
    wait_for(cx, |_| {
        out(&e.ws, "material_folder.list", json!({"book": e.book}))
            .as_array()
            .unwrap()
            .len()
            == 1
    });
    reload(&e, &panel, cx);
    // Its name is in a field, the caret in it: typed and Enter.
    wait_for(cx, |cx| panel.read_with(cx, |p, _| p.renaming().is_some()));
    let field = panel
        .read_with(cx, |p, _| p.renaming_field().cloned())
        .unwrap();
    assert_eq!(field.read_with(cx, |f, _| f.text()), "新素材夹");
    field.update(cx, |f, cx| f.set_text("旧城", cx));
    cx.simulate_keystrokes("enter");
    wait_for(cx, |_| {
        out(&e.ws, "material_folder.list", json!({"book": e.book}))[0]["name"] == "旧城"
    });
    assert!(panel.read_with(cx, |p, _| p.renaming().is_none()));
}

#[gpui::test]
fn a_selection_moves_into_a_folder_and_is_deleted(cx: &mut TestAppContext) {
    let e = env();
    let outer = folder(&e, "旧城", None);
    let inner = folder(&e, "街区", Some(&outer));
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    let a = file(&e, "a.png", dr_testkit::media::png(32, 32));
    let b = file(&e, "b.png", dr_testkit::media::png(32, 32));
    panel.update(cx, |p, cx| p.import_paths(vec![a, b], None, cx));
    wait_for(cx, |cx| !panel.read_with(cx, |p, _| p.importing()));
    reload(&e, &panel, cx);
    // Closed: the folder, then the two at the root.
    assert_eq!(keys(&panel, cx).len(), 3);
    let ids: Vec<String> = materials(&e)
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_owned())
        .collect();
    let sel = Selection {
        materials: ids.clone(),
        folders: Vec::new(),
    };
    panel.update(cx, |p, cx| p.move_to(sel.clone(), Some(inner.clone()), cx));
    wait_for(cx, |_| {
        materials(&e).iter().all(|m| m["folder"] == inner.as_str())
    });
    reload(&e, &panel, cx);
    // The folder they went into is open; its parent still folded.
    assert!(panel.read_with(cx, |p, _| p.is_open(&inner)));
    assert_eq!(keys(&panel, cx), [format!("f:{outer}")]);
    panel.update(cx, |p, cx| p.set_open(&outer, true, cx));
    assert_eq!(keys(&panel, cx).len(), 4, "旧城, 街区, and the two");
    // A folder never goes into itself: it stays where it is.
    panel.update(cx, |p, cx| {
        p.move_to(Selection::folder(&outer), Some(inner.clone()), cx)
    });
    draw(cx);
    let folders = out(&e.ws, "material_folder.list", json!({"book": e.book}));
    let outer_row = folders
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == outer.as_str())
        .unwrap();
    assert!(outer_row["parent"].is_null());
    // Deleting the selection (after the question): gone.
    panel.update(cx, |p, cx| p.delete(sel, cx));
    wait_for(cx, |_| materials(&e).is_empty());
}

#[gpui::test]
fn folding_everything_inside_and_selecting_all(cx: &mut TestAppContext) {
    let e = env();
    let a = folder(&e, "甲", None);
    let b = folder(&e, "乙", Some(&a));
    folder(&e, "丙", Some(&b));
    let (panel, mut cx) = open(cx, &e);
    let cx = &mut cx;
    assert_eq!(keys(&panel, cx).len(), 1);
    panel.update(cx, |p, cx| p.set_open_all(&a, true, cx));
    assert_eq!(keys(&panel, cx).len(), 3);
    panel.update(cx, |p, cx| p.select_all(cx));
    assert_eq!(panel.read_with(cx, |p, _| p.picker().selected.len()), 3);
    cx.update(|window, cx| {
        let focus = gpui::Focusable::focus_handle(panel.read(cx), cx);
        window.focus(&focus, cx);
    });
    draw(cx);
    cx.simulate_keystrokes("escape");
    assert!(panel.read_with(cx, |p, _| p.picker().selected.is_empty()));
    panel.update(cx, |p, cx| p.set_open_all(&a, false, cx));
    assert_eq!(keys(&panel, cx).len(), 1);
}
