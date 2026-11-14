use dr_model::{id::RelationId, kind::EntityKind, shared::EntityRef};
use dr_view_material::v3;
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
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
        dr_view_material::import::place_in_media_entry(&ws, &book_id, &asset, "测试图").unwrap();
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
fn material_entry_links_are_local_partial_and_keep_hidden_relations() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "v3-links").unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let b = &seed.books[0].book;
    let book = b.book_id().to_string();
    let chapter = b
        .view()
        .entries()
        .into_iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == "tpl-chapter")
        })
        .unwrap();
    let a = chapter.id.to_string();
    let parent = chapter.parent.unwrap().to_string();
    let generic = dr_doc::catalog::generic_relation_type_id(b.book_id());
    seed.write_to(ws.library()).unwrap();
    let asset = dr_view_material::import::import_bytes(
        &ws,
        &book,
        None,
        dr_testkit::media::png(16, 16),
        "测试图",
    )
    .unwrap()
    .material;
    // The file shown as an item of an entry's media module (the import puts
    // it into the asset library only).
    let (media_entry_id, _, material) =
        dr_view_material::import::place_in_media_entry(&ws, &book, &asset, "测试图").unwrap();
    let parsed_book = book.parse().unwrap();
    let host_entry = media_entry_id.clone();
    let chapter_a = a.clone();
    let generic_rel = generic.clone();
    ws.library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, move |doc| {
            let b = dr_doc::v3::BorrowedBookV3::new(doc, &parsed_book).unwrap();
            let mut txn = b.txn();
            txn.relation(&RelationId::new_v7())
                .unwrap()
                .ends(
                    &EntityRef::new(EntityKind::Entry, &host_entry),
                    &EntityRef::new(EntityKind::Entry, "missing-entry"),
                )
                .unwrap()
                .relation_type(&generic_rel)
                .unwrap();
            txn.relation(&RelationId::new_v7())
                .unwrap()
                .ends(
                    &EntityRef::new(EntityKind::Entry, &host_entry),
                    &EntityRef::new(EntityKind::Entry, &chapter_a),
                )
                .unwrap()
                .relation_type(&dr_model::id::RelationTypeId::new_v7())
                .unwrap();
        })
        .unwrap();
    let parsed_book = book.parse().unwrap();
    let originals: Vec<_> = ws
        .library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .read(move |doc| {
            dr_doc::v3::BorrowedBookV3::new(doc, &parsed_book)
                .unwrap()
                .view()
                .relations_raw()
        })
        .unwrap()
        .into_iter()
        .filter(|r| {
            !(r.relation_type == generic
                && ((r.from.id == media_entry_id && (r.to.id == a || r.to.id == parent))
                    || (r.to.id == media_entry_id && (r.from.id == a || r.from.id == parent))))
        })
        .collect();
    let other = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED + 1,
    )
    .unwrap();
    let other_book = other.books[0].book_id().to_string();
    let foreign = other.books[0].book.view().entries()[0].id.to_string();
    other.write_to(ws.library()).unwrap();
    std::thread::scope(|scope| {
        let first = scope.spawn(|| v3::set_entry_link(&ws, &book, &material, &a, true).unwrap());
        let second =
            scope.spawn(|| v3::set_entry_link(&ws, &book, &material, &parent, true).unwrap());
        first.join().unwrap();
        second.join().unwrap();
    });
    let before = ws.observe(&format!("book:{book}")).unwrap().version;
    v3::set_entry_link(&ws, &book, &material, &a, true).unwrap();
    assert_eq!(ws.observe(&format!("book:{book}")).unwrap().version, before);
    assert!(v3::set_entry_link(&ws, &book, &material, &foreign, true).is_err());
    assert!(v3::set_entry_link(&ws, &other_book, &material, &foreign, true).is_err());
    assert_eq!(ws.observe(&format!("book:{book}")).unwrap().version, before);
    v3::set_entry_link(&ws, &book, &material, &a, false).unwrap();
    let unlinked = ws.observe(&format!("book:{book}")).unwrap().version;
    v3::set_entry_link(&ws, &book, &material, &a, false).unwrap();
    assert_eq!(
        ws.observe(&format!("book:{book}")).unwrap().version,
        unlinked
    );
    let links = v3::entry_links(&ws, &book, &material).unwrap();
    assert!(!links.iter().find(|e| e.id == a).unwrap().linked);
    assert!(links.iter().find(|e| e.id == parent).unwrap().linked);
    ws.undo(&Actor::User).unwrap().unwrap();
    assert!(
        v3::entry_links(&ws, &book, &material)
            .unwrap()
            .iter()
            .find(|e| e.id == a)
            .unwrap()
            .linked
    );
    assert!(
        v3::entry_links(&ws, &book, &material)
            .unwrap()
            .iter()
            .find(|e| e.id == parent)
            .unwrap()
            .linked
    );
    v3::set_entry_link(&ws, &book, &material, &a, false).unwrap();
    call(&ws, "entry.trash", json!({"book":book,"id":parent}));
    assert!(
        !v3::entry_links(&ws, &book, &material)
            .unwrap()
            .iter()
            .any(|e| e.id == a || e.id == parent)
    );
    assert!(v3::set_entry_link(&ws, &book, &material, &a, true).is_err());
    call(&ws, "entry.restore", json!({"book":book,"id":parent}));
    let doc = ws
        .library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .unwrap();
    let id = book.parse().unwrap();
    let rows = doc
        .read(move |doc| {
            dr_doc::v3::BorrowedBookV3::new(doc, &id)
                .unwrap()
                .view()
                .relations_raw()
        })
        .unwrap();
    for original in originals {
        assert!(rows.contains(&original), "unshown relation was changed");
    }
    drop(doc);
    ws.shutdown().unwrap();
    let ws = Workspace::open_dir(dir.path(), "v3-links").unwrap();
    assert!(
        v3::entry_links(&ws, &book, &material)
            .unwrap()
            .iter()
            .find(|e| e.id == parent)
            .unwrap()
            .linked
    );
    ws.close();
}
