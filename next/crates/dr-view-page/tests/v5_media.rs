//! V5 `media` module regression tests (`v5-tracks.md` lines 400, 406, 415).

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost,
};
use dr_ui::Appearance;
use dr_view_page::media::MediaModule;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, TestAppContext, VisualTestContext, WeakEntity, px, size};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entry: String,
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path().join("lib"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "媒体模块"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let module = json!({
        "id": "mod-media",
        "name": "参考图",
        "kind": "media",
        "config": {
            "arrangement": "grid"
        }
    });
    call(
        &ws,
        "entry_template.put_module",
        json!({"book": book, "template": "tpl-idea", "module": module}),
    );
    let entry =
        dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-idea", "旧灯塔", None)["id"]
            .as_str()
            .unwrap()
            .to_owned();
    Env {
        dir,
        ws,
        book,
        entry,
    }
}

fn put_asset(e: &Env, filename: &str, bytes: Vec<u8>, folder: Option<&str>) -> String {
    let path = e.dir.path().join(filename);
    std::fs::write(&path, bytes).unwrap();
    dr_view_material::import::import_path(&e.ws, &e.book, folder, &path)
        .unwrap()
        .material
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait_settled(view: &Entity<MediaModule>, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if view.read_with(cx, |v, _| v.is_settled()) {
            return;
        }
        assert!(Instant::now() < deadline, "MediaModule did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn open(cx: &mut TestAppContext, e: &Env) -> (Entity<MediaModule>, VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
        }
    });
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let module = book
        .v3()
        .unwrap()
        .template_of(&e.entry)
        .unwrap()
        .modules
        .iter()
        .find(|m| m.id == "mod-media")
        .unwrap()
        .clone();
    let host = ModuleHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: e.ws.clone(),
            book_id: e.book.clone(),
            book,
        },
        entry: e.entry.clone(),
        module,
    };
    let window = cx.add_window(|window, cx| MediaModule::new(host, window, cx));
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1000.0), px(800.0)));
    wait_settled(&view, &mut vcx);
    (view, vcx)
}

#[gpui::test]
fn entry_arrangement_overrides_template_and_reset_returns_to_template(cx: &mut TestAppContext) {
    let e = env();
    let other_entry =
        dr_testkit::seed::acceptance::novel_entry(&e.ws, &e.book, "tpl-idea", "防波堤", None)["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let (view, mut vcx) = open(cx, &e);
    assert_eq!(
        view.read_with(&vcx, |v, _| v.arrangement().to_owned()),
        "grid"
    );
    assert!(!view.read_with(&vcx, |v, _| v.own_arrangement()));

    view.update(&mut vcx, |v, cx| v.set_arrangement(Some("list"), cx));
    wait_settled(&view, &mut vcx);
    assert_eq!(
        view.read_with(&vcx, |v, _| v.arrangement().to_owned()),
        "list"
    );
    assert!(view.read_with(&vcx, |v, _| v.own_arrangement()));

    // Sibling entry using the same template keeps the template's `grid` arrangement.
    let other = call(
        &e.ws,
        "module.read",
        json!({"book": e.book, "entry": other_entry, "module": "mod-media"}),
    );
    assert_eq!(other["arrangement"], "grid");
    assert!(!other["own_arrangement"].as_bool().unwrap_or(false));

    // Clearing the entry override restores the template's `grid` arrangement.
    view.update(&mut vcx, |v, cx| v.set_arrangement(None, cx));
    wait_settled(&view, &mut vcx);
    assert_eq!(
        view.read_with(&vcx, |v, _| v.arrangement().to_owned()),
        "grid"
    );
    assert!(!view.read_with(&vcx, |v, _| v.own_arrangement()));
}

#[gpui::test]
fn media_asset_once_captions_reorder_and_folder_trash_restore(cx: &mut TestAppContext) {
    let e = env();
    let folder = call(
        &e.ws,
        "asset_folder.create",
        json!({"book": e.book, "name": "实地照片"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a1 = put_asset(
        &e,
        "灯塔远景.png",
        dr_testkit::media::png(600, 400),
        Some(&folder),
    );
    let a2 = put_asset(&e, "海图摘录.pdf", dr_testkit::media::sample_pdf(), None);

    let (view, mut vcx) = open(cx, &e);
    view.update(&mut vcx, |v, cx| {
        v.put_assets(vec![a1.clone(), a2.clone(), a1.clone()], cx);
    });
    wait_settled(&view, &mut vcx);
    let items = view.read_with(&vcx, |v, _| v.items().to_vec());
    assert_eq!(
        items.len(),
        2,
        "MEDIA-ASSET-ONCE deduplicates within a module"
    );
    assert_eq!(items[0].asset, a1);
    assert_eq!(items[1].asset, a2);

    // Putting an already-present asset again leaves count at 2.
    view.update(&mut vcx, |v, cx| v.put_assets(vec![a1.clone()], cx));
    wait_settled(&view, &mut vcx);
    assert_eq!(view.read_with(&vcx, |v, _| v.items().len()), 2);

    // Caption persists and reorder moves item 2 before item 1.
    let id1 = items[0].id.clone();
    let id2 = items[1].id.clone();
    view.update(&mut vcx, |v, cx| {
        v.set_caption(&id1, "北侧石阶".into(), cx);
    });
    wait_settled(&view, &mut vcx);
    view.update(&mut vcx, |v, cx| v.reorder_before(&id2, &id1, cx));
    wait_settled(&view, &mut vcx);
    let reordered = view.read_with(&vcx, |v, _| v.items().to_vec());
    assert_eq!(reordered[0].asset, a2);
    assert_eq!(reordered[1].asset, a1);
    assert_eq!(reordered[1].caption, "北侧石阶");

    // Trashing the parent folder marks `a1` missing even though `a1` itself has no deleted_at!
    call(
        &e.ws,
        "asset_folder.trash",
        json!({"book": e.book, "id": folder}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(&mut vcx);
        if view.read_with(&vcx, |v, _| {
            v.is_settled() && v.items().iter().any(|i| i.asset == a1 && i.missing)
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "folder trash did not mark item missing"
        );
        std::thread::sleep(Duration::from_millis(5));
    }

    // Restoring from the media placeholder restores the trashed parent folder too.
    view.update(&mut vcx, |v, cx| v.restore_missing(&a1, cx));
    wait_settled(&view, &mut vcx);
    assert!(view.read_with(&vcx, |v, _| v.items().iter().all(|i| !i.missing)));

    // Removing from the media module keeps the asset in the book's library.
    view.update(&mut vcx, |v, cx| v.remove_item(id2.clone(), cx));
    wait_settled(&view, &mut vcx);
    assert_eq!(view.read_with(&vcx, |v, _| v.items().len()), 1);
    let live_assets = call(
        &e.ws,
        "asset.list",
        json!({"book": e.book, "trashed": false}),
    );
    assert_eq!(live_assets.as_array().unwrap().len(), 2);
}

/// A HEIC that came without its display copy and thumbnail (imported from a
/// 0.1 library that had none, or synced from a device that could not make
/// them) gets them when an entry's media module shows it, decoded by the
/// system in the module's background load (`dr_view_material::import::
/// make_missing_copies`); the module then draws the JPEG copies. ImageIO
/// decodes it, so this runs on macOS.
#[cfg(target_os = "macos")]
#[gpui::test]
fn a_heic_without_copies_gets_them_when_a_media_module_shows_it(cx: &mut TestAppContext) {
    use dr_store::asset::{MAX_COPY_BYTES, SourceImport, Variant};

    let e = env();
    // The source alone, as such an import leaves it.
    let path = e.dir.path().join("source.heic");
    std::fs::write(&path, dr_testkit::media::HEIC).unwrap();
    let asset = dr_model::id::new_uuid_v7();
    let source =
        e.ws.library()
            .import_asset(&SourceImport {
                book_id: &e.book,
                asset_id: &asset,
                source: &path,
                mime: "image/heic",
                ext: "heic",
                dimensions: Some((600, 400)),
                limit: MAX_COPY_BYTES,
            })
            .unwrap();
    call(
        &e.ws,
        "asset.put",
        json!({"book": e.book, "id": asset, "name": "IMG_0412", "kind": "image",
               "mime": "image/heic", "size": source.size, "sha256": source.sha256,
               "width": 600, "height": 400}),
    );
    assert!(
        e.ws.library()
            .asset(&asset, Variant::Display)
            .unwrap()
            .is_none()
    );

    let (view, mut vcx) = open(cx, &e);
    view.update(&mut vcx, |v, cx| v.put_assets(vec![asset.clone()], cx));
    wait_settled(&view, &mut vcx);
    let meta = view
        .read_with(&vcx, |v, _| v.asset_meta(&asset).cloned())
        .expect("the module shows the file");
    let name = |p: &Option<std::path::PathBuf>| {
        p.as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
    };
    assert_eq!(name(&meta.display).as_deref(), Some("display.jpg"));
    assert_eq!(name(&meta.thumb).as_deref(), Some("thumbnail.jpg"));
    let store = e.ws.library();
    let display = store.asset(&asset, Variant::Display).unwrap().unwrap();
    assert_eq!(display.mime, "image/jpeg");
    assert_eq!((display.width, display.height), (Some(600), Some(400)));
    assert!(store.asset(&asset, Variant::Thumbnail).unwrap().is_some());
    // The source is the original.
    let kept = store.asset(&asset, Variant::Source).unwrap().unwrap();
    assert_eq!(kept, source);
    assert_eq!(std::fs::read(&kept.path).unwrap(), dr_testkit::media::HEIC);
}
