//! V5 file endpoints in `EntryRelations` (`v5-tracks.md` lines 404, 413).

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost,
};
use dr_ui::Appearance;
use dr_view_relations::EntryRelations;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, TestAppContext, VisualTestContext, WeakEntity, px, size};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
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
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "EntryRelations timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[gpui::test]
fn asset_relations_render_hide_when_trashed_and_creation_picker_has_no_assets(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path().join("lib"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "关系文件端点"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let entry =
        dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-idea", "古灯塔", None)["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let _peer = dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-idea", "守塔人", None);

    let module = json!({
        "id": "mod-rel",
        "name": "关联",
        "kind": "relations",
        "config": {}
    });
    call(
        &ws,
        "entry_template.put_module",
        json!({"book": book, "template": "tpl-idea", "module": module}),
    );

    let folder = call(
        &ws,
        "asset_folder.create",
        json!({"book": book, "name": "图纸"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let png_path = dir.path().join("塔身剖面.png");
    std::fs::write(&png_path, dr_testkit::media::png(320, 240)).unwrap();
    let asset_id = dr_model::id::new_uuid_v7();
    let stored = ws
        .library()
        .import_asset(&dr_store::asset::SourceImport {
            book_id: &book,
            asset_id: &asset_id,
            source: &png_path,
            mime: "image/png",
            ext: "png",
            dimensions: Some((320, 240)),
            limit: dr_store::asset::MAX_COPY_BYTES,
        })
        .unwrap();
    let asset = call(
        &ws,
        "asset.put",
        json!({
            "book": book,
            "id": asset_id,
            "name": "塔身剖面.png",
            "kind": "image",
            "mime": "image/png",
            "size": stored.size,
            "sha256": stored.sha256,
            "width": 320,
            "height": 240,
            "folder": folder,
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let rel_type = call(
        &ws,
        "entry_relation_type.put",
        json!({
            "book": book,
            "definition": {
                "id": "rel-ref-asset",
                "name": "参考图纸",
                "description": "",
                "orientation": "directed",
                "source_role": "",
                "target_role": "",
                "source_kinds": ["entry"],
                "target_kinds": ["asset"],
                "source_templates": [],
                "target_templates": [],
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "module.put_relation",
        json!({
            "book": book,
            "entry": entry,
            "module": "mod-rel",
            "other": {"kind": "asset", "id": asset},
            "relation_type": rel_type,
            "incoming": false,
        }),
    );

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
    let window = cx.add_window(|window, cx| EntryRelations::new(host, window, cx));
    let view: Entity<EntryRelations> = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1000.0), px(700.0)));
    wait_for(&mut vcx, |cx| {
        view.read_with(cx, |v, cx| v.is_settled() && !v.visible_rows(cx).is_empty())
    });

    let rows = view.read_with(&vcx, |v, cx| v.visible_rows(cx));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "asset");
    assert_eq!(rows[0].2, asset);
    assert_eq!(rows[0].3, "塔身剖面.png");

    // Creation picker offers only live entries, never assets or materials.
    let ends = view.read_with(&vcx, |v, _| v.creation_ends());
    assert!(!ends.is_empty());
    assert!(ends.iter().all(|(kind, _)| kind == "entry"));

    // Trashing the folder hides the asset relation row; restoring brings it back.
    call(
        &ws,
        "asset_folder.trash",
        json!({"book": book, "id": folder}),
    );
    wait_for(&mut vcx, |cx| {
        view.read_with(cx, |v, cx| v.is_settled() && v.visible_rows(cx).is_empty())
    });
    call(
        &ws,
        "asset_folder.restore",
        json!({"book": book, "id": folder}),
    );
    wait_for(&mut vcx, |cx| {
        view.read_with(cx, |v, cx| v.is_settled() && v.visible_rows(cx).len() == 1)
    });
}
