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
