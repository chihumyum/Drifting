//! V5 `image` field placeholder, folder-trash restore, and purged-placeholder clear
//! (`v5-tracks.md` line 417).

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost,
};
use dr_view_elements::fields::v3::TypedFields;
use dr_workspace::{Actor, Workspace, commands::v3::types::FieldDef};
use gpui::{TestAppContext, VisualTestContext, WeakEntity, px, size};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

#[gpui::test]
fn image_field_shows_gone_placeholder_restores_trashed_folder_and_clears_purged_id(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open(
        dr_store::Library::open(
            dir.path().join("lib"),
            dr_workspace::library_options("test"),
        )
        .unwrap(),
        Default::default(),
    )
    .unwrap();
    let book = call(&ws, "project.create", json!({"name": "图片字段占位"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let entry =
        dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-idea", "守塔人", None)["id"]
            .as_str()
            .unwrap()
            .to_owned();

    let def: FieldDef =
        serde_json::from_value(json!({"id": "avatar", "name": "肖像", "field_type": "image"}))
            .unwrap();
    let module = json!({
        "id": "mod-profile",
        "name": "档案",
        "kind": "fields",
        "config": { "defs": [def] }
    });
    call(
        &ws,
        "entry_template.put_module",
        json!({"book": book, "template": "tpl-idea", "module": module}),
    );

    let folder = call(
        &ws,
        "asset_folder.create",
        json!({"book": book, "name": "立绘"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let png_path = dir.path().join("守塔人肖像.png");
    std::fs::write(&png_path, dr_testkit::media::png(320, 320)).unwrap();
    let asset_id = dr_model::id::new_uuid_v7();
    let stored = ws
        .library()
        .import_asset(&dr_store::asset::SourceImport {
            book_id: &book,
            asset_id: &asset_id,
            source: &png_path,
            mime: "image/png",
            ext: "png",
            dimensions: Some((320, 320)),
            limit: dr_store::asset::MAX_COPY_BYTES,
        })
        .unwrap();
    let asset = call(
        &ws,
        "asset.put",
        json!({
            "book": book,
            "id": asset_id,
            "name": "守塔人肖像",
            "kind": "image",
            "mime": "image/png",
            "size": stored.size,
            "sha256": stored.sha256,
            "width": 320,
            "height": 320,
            "folder": folder,
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    call(
        &ws,
        "module.set_field",
        json!({
            "book": book,
            "entry": entry,
            "module": "mod-profile",
            "field": "avatar",
            "value": asset,
        }),
    );

    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
        }
    });

    let loaded = Rc::new(Book::load(&ws, &book).unwrap());
    let host = ModuleHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: ws.clone(),
            book_id: book.clone(),
            book: loaded,
        },
        entry: entry.clone(),
        module: serde_json::from_value(module).unwrap(),
    };
    let window = cx.add_window(|w, cx| TypedFields::new(host, w, cx));
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|w, _| w.activate_window());
    vcx.simulate_resize(size(px(1000.0), px(700.0)));

    let wait_ready = |vcx: &mut VisualTestContext, cond: &dyn Fn(&TypedFields) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            draw(vcx);
            if view.read_with(vcx, |v, _| v.is_settled() && cond(v)) {
                return;
            }
            assert!(Instant::now() < deadline, "TypedFields timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    };

    wait_ready(&mut vcx, &|v| !v.image_is_gone("avatar"));

    // Trashing the parent folder turns the image field into a restorable `.gone` placeholder.
    call(
        &ws,
        "asset_folder.trash",
        json!({"book": book, "id": folder}),
    );
    wait_ready(&mut vcx, &|v| {
        v.image_is_gone("avatar") && v.image_can_restore("avatar")
    });

    // Restoring from the field placeholder restores the folder and returns to live state.
    view.update(&mut vcx, |v, cx| v.restore_image_field("avatar", cx));
    wait_ready(&mut vcx, &|v| !v.image_is_gone("avatar"));

    // Exact `v5-tracks.md:417` scenario: trashing the entry, purging the asset,
    // and restoring the entry leaves a dangling purged asset id on `avatar`
    // (reads as missing placeholder, not restorable in book).
    call(&ws, "entry.trash", json!({"book": book, "id": entry}));
    call(&ws, "asset.trash", json!({"book": book, "id": asset}));
    call(&ws, "asset.purge", json!({"book": book, "id": asset}));
    ws.undo_in(&Actor::User, &book, None).unwrap();
    let reloaded = Rc::new(Book::load(&ws, &book).unwrap());
    view.update(&mut vcx, |v, cx| v.refresh(reloaded, cx));
    wait_ready(&mut vcx, &|v| {
        v.image_is_gone("avatar") && !v.image_can_restore("avatar")
    });

    // Clearing removes the dangling placeholder value cleanly.
    view.update(&mut vcx, |v, cx| v.clear_image_field("avatar", cx));
    wait_ready(&mut vcx, &|v| !v.image_is_gone("avatar"));
    let stored = call(
        &ws,
        "module.read",
        json!({"book": book, "entry": entry, "module": "mod-profile"}),
    )["fields"]["avatar"]
        .clone();
    assert!(
        stored.is_null(),
        "expected cleared image field to be null, got {stored}"
    );
}
