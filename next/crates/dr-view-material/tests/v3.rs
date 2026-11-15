use dr_model::{id::RelationId, kind::EntityKind, shared::EntityRef};
use dr_view_material::v3;
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn place_in_media_entry(
    lib: &Workspace,
    book: &str,
    asset: &str,
    title: &str,
) -> Result<(String, String, String), String> {
    let call = |name: &str, input: Value| {
        lib.call(&Actor::User, name, input)
            .map(|v| v["output"].clone())
            .map_err(|e| format!("{name}: {e}"))
    };
    call(
        "entry_template.put",
        json!({"book": book, "template": {"id": "test-media-template", "name": "媒体",
            "modules": [{"id": "mod-media", "kind": "media", "name": "附件"}]}}),
    )?;
    let entry = call(
        "entry.create",
        json!({"book": book, "template": "test-media-template", "title": title}),
    )?["id"]
        .as_str()
        .ok_or("entry.create gave no id")?
        .to_owned();
    let item = dr_model::id::new_uuid_v7();
    call(
        "module.put_media",
        json!({"book": book, "entry": entry, "module": "mod-media",
            "item": {"id": item, "asset": asset, "caption": ""}}),
    )?;
    Ok((entry, "mod-media".to_owned(), item))
}

#[test]
fn entry_associations_remain_read_only_and_survive_hidden_ancestors() {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book_id = seed.books[0].book_id().to_string();
    let entries = seed.books[0].book.view().entries();
    let entry = entries
        .iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == "tpl-chapter")
        })
        .unwrap();
    let entry_id = entry.id.to_string();
    let parent = entry.parent.clone().unwrap();
    let generic = dr_doc::catalog::generic_relation_type_id(seed.books[0].book_id());
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let asset = dr_view_material::import::import_bytes(
        &ws,
        &book_id,
        None,
        dr_testkit::media::png(16, 16),
        "测试图",
    )
    .unwrap()
    .material;
    // The file shown as an item of an entry's media module (the import puts
    // it into the asset library only).
    let (media_entry_id, _, material) =
        place_in_media_entry(&ws, &book_id, &asset, "测试图").unwrap();
    let parsed_book = book_id.parse().unwrap();
    let target_entry = entry_id.clone();
    ws.library()
        .open_doc(&format!("book:{book_id}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, move |doc| {
            dr_doc::v3::BorrowedBookV3::new(doc, &parsed_book)
                .unwrap()
                .txn()
                .relation(&RelationId::new_v7())
                .unwrap()
                .ends(
                    &EntityRef::new(EntityKind::Entry, &media_entry_id),
                    &EntityRef::new(EntityKind::Entry, &target_entry),
                )
                .unwrap()
                .relation_type(&generic)
                .unwrap();
        })
        .unwrap();
    let before = ws.observe(&format!("book:{book_id}")).unwrap().version;
    assert!(
        v3::related(&ws, &book_id, &entry_id)
            .unwrap()
            .contains(material.as_str())
    );
    assert!(
        v3::related(&ws, &book_id, "missing-entry")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ws.observe(&format!("book:{book_id}")).unwrap().version,
        before
    );
    call(&ws, "entry.trash", json!({"book":book_id,"id":parent}));
    assert!(v3::related(&ws, &book_id, &entry_id).unwrap().is_empty());
    call(&ws, "entry.restore", json!({"book":book_id,"id":parent}));
    assert!(
        v3::related(&ws, &book_id, &entry_id)
            .unwrap()
            .contains(material.as_str())
    );
    let old = dr_testkit::seed::acceptance::empty_source(ws.library());
    let old_doc = format!("book:{old}");
    let before = ws.library().load_copy(&old_doc).unwrap();
    assert!(v3::related(&ws, &old, &entry_id).is_err());
    assert!(
        ws.call(&Actor::User, "relation.list", json!({"book":old}))
            .is_err()
    );
    let after = ws.library().load_copy(&old_doc).unwrap();
    assert_eq!(before.oplog_frontiers(), after.oplog_frontiers());
    assert_eq!(before.get_deep_value(), after.get_deep_value());
    ws.shutdown().unwrap();
}

#[test]
fn imported_asset_and_folder_operations_preserve_other_materials_and_books() {
    use dr_view_material::{folders, import};
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "v3-material").unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(ws.library()).unwrap();
    let other = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED + 1,
    )
    .unwrap();
    let other_book = other.books[0].book_id().to_string();
    other.write_to(ws.library()).unwrap();
    let other_before = ws.observe(&format!("book:{other_book}")).unwrap().version;
    import::import_bytes(&ws, &book, None, dr_testkit::media::png(12, 12), "原图").unwrap();
    let snapshot = dr_shell::book::Book::load(&ws, &book).unwrap();
    let originals = snapshot.material_items().to_vec();
    let name = originals[0].title.clone();
    let bytes = dr_testkit::media::png(16, 16);
    let imported = import::import_bytes(&ws, &book, None, bytes.clone(), &name).unwrap();
    let materials = dr_shell::book::Book::load(&ws, &book)
        .unwrap()
        .material_items()
        .to_vec();
    let row = materials
        .iter()
        .find(|m| m.id == imported.material)
        .unwrap();
    let asset = row.asset.clone().unwrap();
    let renamed = format!("{name} {name}");
    folders::rename_material(&ws, &book, &imported.material, &renamed).unwrap();
    assert!(folders::rename_material(&ws, &other_book, &imported.material, &name).is_err());
    assert_eq!(
        ws.observe(&format!("book:{other_book}")).unwrap().version,
        other_before
    );
    let after_rename = dr_shell::book::Book::load(&ws, &book)
        .unwrap()
        .material_items()
        .to_vec();
    let row = after_rename
        .iter()
        .find(|m| m.id == imported.material)
        .unwrap();
    assert_eq!(row.title, renamed);
    assert_eq!(row.asset.as_deref(), Some(asset.as_str()));
    for original in &originals {
        assert!(after_rename.contains(original));
    }
    let file = ws
        .library()
        .asset(&asset, dr_store::asset::Variant::Source)
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(file.path).unwrap(), bytes);
    assert_eq!(file.book_id, book);
    folders::delete(
        &ws,
        &book,
        &folders::Selection::of(&[folders::material_key(&imported.material)]),
    )
    .unwrap();
    let after_delete = dr_shell::book::Book::load(&ws, &book)
        .unwrap()
        .material_items()
        .to_vec();
    assert!(!after_delete.iter().any(|m| m.id == imported.material));
    ws.close();
}

#[test]
fn v5_folder_tree_move_trash_restore_and_duplicate_byte_reuse() {
    use dr_view_material::{folders, import, library_data};
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "v5-folders").unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(ws.library()).unwrap();

    let parent_folder = folders::create_folder(&ws, &book, "参考图", None).unwrap();
    let child_folder = folders::create_folder(&ws, &book, "东岸", Some(&parent_folder)).unwrap();

    let png_a = dr_testkit::media::png(20, 16);
    let png_b = dr_testkit::media::png(24, 18);
    let file_a =
        import::import_bytes(&ws, &book, Some(&child_folder), png_a.clone(), "海图").unwrap();
    assert!(!file_a.reused);
    // Same bytes imported again reuse the existing file id without creating a second tile.
    let dup = import::import_bytes(&ws, &book, None, png_a, "重复海图").unwrap();
    assert!(dup.reused);
    assert_eq!(dup.material, file_a.material);

    let file_b = import::import_bytes(&ws, &book, None, png_b, "城门").unwrap();
    assert!(!file_b.reused);
    folders::move_to(
        &ws,
        &book,
        &folders::Selection::of(&[folders::material_key(&file_b.material)]),
        Some(&parent_folder),
    )
    .unwrap();

    let snap = library_data::load_snapshot(&ws, &book, "关系", "未命名").unwrap();
    let row_a = snap
        .live_materials
        .iter()
        .find(|m| m.id == file_a.material)
        .unwrap();
    let row_b = snap
        .live_materials
        .iter()
        .find(|m| m.id == file_b.material)
        .unwrap();
    assert_eq!(row_a.folder.as_deref(), Some(child_folder.as_str()));
    assert_eq!(row_b.folder.as_deref(), Some(parent_folder.as_str()));

    // Trashing a folder cascades its subfolder and files out of live lists;
    // restoring the folder brings them back (`v5-tracks.md` lines 399, 415).
    folders::delete(
        &ws,
        &book,
        &folders::Selection::of(&[folders::folder_key(&parent_folder)]),
    )
    .unwrap();
    let trashed = library_data::load_snapshot(&ws, &book, "关系", "未命名").unwrap();
    assert!(
        !trashed
            .live_materials
            .iter()
            .any(|m| m.id == file_a.material || m.id == file_b.material)
    );
    assert!(
        trashed
            .trashed_folders
            .iter()
            .any(|f| f.id == parent_folder)
    );
    assert!(
        trashed
            .trashed_assets
            .iter()
            .any(|a| a.id == file_a.material)
    );

    folders::restore_folder(&ws, &book, &parent_folder).unwrap();
    let restored = library_data::load_snapshot(&ws, &book, "关系", "未命名").unwrap();
    assert!(
        restored
            .live_materials
            .iter()
            .any(|m| m.id == file_a.material)
    );
    assert!(
        restored
            .live_materials
            .iter()
            .any(|m| m.id == file_b.material)
    );
    assert!(restored.trashed_folders.is_empty());
    assert!(restored.trashed_assets.is_empty());
    ws.close();
}
