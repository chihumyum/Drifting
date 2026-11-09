use dr_model::{Origin, book::EntityRef, id::RelationId, kind::EntityKind};
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
    let mut seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = &mut seed.books[0].book;
    let book_id = book.book_id().to_string();
    let entries = book.view().entries();
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
    let material = book.view().materials().remove(0).id;
    let generic = dr_doc::book::generic_relation_type_id(book.book_id());
    book.edit(Origin::User, |t| {
        t.relation(&RelationId::new_v7())?
            .ends(
                &EntityRef::new(EntityKind::Material, material.as_str()),
                &EntityRef::new(EntityKind::Entry, &entry_id),
            )?
            .relation_type(&generic)?;
        Ok(())
    })
    .0
    .unwrap();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
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
    let old = call(
        &ws,
        "book.create",
        json!({"name":"Synthetic compatibility"}),
    );
    assert!(v3::related(&ws, old["id"].as_str().unwrap(), &entry_id).is_err());
    assert!(
        ws.call(&Actor::User, "relation.list", json!({"book":old["id"]}))
            .is_ok()
    );
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
    let name = seed.books[0].book.view().materials()[0].title.clone();
    seed.write_to(ws.library()).unwrap();
    let other = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED + 1,
    )
    .unwrap();
    let other_book = other.books[0].book_id().to_string();
    other.write_to(ws.library()).unwrap();
    let other_before = ws.observe(&format!("book:{other_book}")).unwrap().version;
    let originals = call(&ws, "material.list", json!({"book":book}));
    let folder = folders::create_folder(&ws, &book, &name, None).unwrap();
    let nested = folders::create_folder(&ws, &book, &name, Some(&folder)).unwrap();
    let snapshot = dr_shell::book::Book::load(&ws, &book).unwrap();
    assert!(snapshot.material_folders().iter().any(|f| f.id == nested));
    assert_eq!(
        snapshot.material_items().len(),
        originals.as_array().unwrap().len()
    );
    let bytes = dr_testkit::media::png(16, 16);
    let imported = import::import_bytes(&ws, &book, Some(&nested), bytes.clone(), &name).unwrap();
    let materials = call(&ws, "material.list", json!({"book":book}));
    let row = materials
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == imported.material)
        .unwrap();
    let asset = row["asset"].as_str().unwrap().to_owned();
    assert_eq!(row["folder"], nested);
    let selection = folders::Selection::of(&[folders::material_key(&imported.material)]);
    folders::move_to(&ws, &book, &selection, Some(&folder)).unwrap();
    folders::rename_material(&ws, &book, &imported.material, &format!("{name} {name}")).unwrap();
    assert!(folders::rename_material(&ws, &other_book, &imported.material, &name).is_err());
    assert_eq!(
        ws.observe(&format!("book:{other_book}")).unwrap().version,
        other_before
    );
    folders::delete(
        &ws,
        &book,
        &folders::Selection::of(&[folders::folder_key(&folder)]),
    )
    .unwrap();
    let after = call(&ws, "material.list", json!({"book":book}));
    let row = after
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == imported.material)
        .unwrap();
    assert!(row["folder"].is_null());
    assert_eq!(row["asset"], asset);
    for original in originals.as_array().unwrap() {
        assert!(after.as_array().unwrap().contains(original));
    }
    let file = ws
        .library()
        .asset(&asset, dr_store::asset::Variant::Source)
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(file.path).unwrap(), bytes);
    assert_eq!(file.book_id, book);
    ws.close();
}

#[test]
fn material_entry_links_are_local_partial_and_keep_hidden_relations() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "v3-links").unwrap();
    let mut seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let b = &mut seed.books[0].book;
    let book = b.book_id().to_string();
    let material = b.view().materials()[0].id.to_string();
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
    let generic = dr_doc::book::generic_relation_type_id(b.book_id());
    let hidden = RelationId::new_v7();
    b.edit(Origin::User, |txn| {
        txn.relation(&hidden)?
            .ends(
                &EntityRef::new(EntityKind::Material, &material),
                &EntityRef::new(EntityKind::Entry, "missing-entry"),
            )?
            .relation_type(&generic)?;
        txn.relation(&RelationId::new_v7())?
            .ends(
                &EntityRef::new(EntityKind::Entry, &a),
                &EntityRef::new(EntityKind::Material, &material),
            )?
            .relation_type(&generic)?;
        txn.relation(&RelationId::new_v7())?
            .ends(
                &EntityRef::new(EntityKind::Material, &material),
                &EntityRef::new(EntityKind::Entry, &a),
            )?
            .relation_type(&dr_model::id::RelationTypeId::new_v7())?;
        Ok(())
    })
    .0
    .unwrap();
    let originals: Vec<_> = b
        .view()
        .relations_raw()
        .into_iter()
        .filter(|r| {
            !(r.relation_type == generic
                && r.from.id == material
                && (r.to.id == a || r.to.id == parent))
        })
        .collect();
    seed.write_to(ws.library()).unwrap();
    let other = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED + 1,
    )
    .unwrap();
    let other_book = other.books[0].book_id().to_string();
    let foreign = other.books[0].book.view().entries()[0].id.to_string();
    other.write_to(ws.library()).unwrap();
    let link = |entry: &str, linked: bool| json!({"book":book,"material":material,"entry":entry,"linked":linked});
    std::thread::scope(|scope| {
        let first = scope.spawn(|| call(&ws, "material.set_entry_link", link(&a, true)));
        let second = scope.spawn(|| call(&ws, "material.set_entry_link", link(&parent, true)));
        first.join().unwrap();
        second.join().unwrap();
    });
    let before = ws.observe(&format!("book:{book}")).unwrap().version;
    call(&ws, "material.set_entry_link", link(&a, true));
    assert_eq!(ws.observe(&format!("book:{book}")).unwrap().version, before);
    assert!(
        ws.call(
            &Actor::User,
            "material.set_entry_link",
            link(&foreign, true)
        )
        .is_err()
    );
    assert!(
        ws.call(
            &Actor::User,
            "material.set_entry_link",
            json!({"book":other_book,"material":material,"entry":foreign,"linked":true})
        )
        .is_err()
    );
    assert_eq!(ws.observe(&format!("book:{book}")).unwrap().version, before);
    call(&ws, "material.set_entry_link", link(&a, false));
    let unlinked = ws.observe(&format!("book:{book}")).unwrap().version;
    call(&ws, "material.set_entry_link", link(&a, false));
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
    call(&ws, "material.set_entry_link", link(&a, false));
    call(&ws, "entry.trash", json!({"book":book,"id":parent}));
    assert!(
        !v3::entry_links(&ws, &book, &material)
            .unwrap()
            .iter()
            .any(|e| e.id == a || e.id == parent)
    );
    assert!(
        ws.call(&Actor::User, "material.set_entry_link", link(&a, true))
            .is_err()
    );
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
