//! One canonical runtime: factory, strict open and retired registry reachability.
mod common;
use dr_workspace::{Actor, Workspace, registry};
use serde_json::json;
#[test]
fn canonical_creation_and_shared_capabilities_have_no_old_product_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "cutover-contract").unwrap();
    let book = ws
        .call(
            &Actor::User,
            "project.create",
            json!({"name":"Synthetic cutover"}),
        )
        .unwrap()["output"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let raw = ws.library().load_copy(&format!("book:{book}")).unwrap();
    assert!(dr_doc::v3::is_v3_doc(&raw));
    for name in [
        "book.create",
        "chapter.create",
        "chapter.list",
        "chapter.update",
        "act.create",
        "idea.create",
        "element.create",
        "category.create",
        "storyline.create",
        "plot_grid.get",
        "time_pin.create",
        "category_template.document",
        "chapter_template.set_body",
        "storyline_template.list",
        "history.undo_agent",
    ] {
        assert!(
            registry().get(name).is_none(),
            "retired runtime is still reachable: {name}"
        );
    }
    for name in [
        "entry.create",
        "module.read_prose",
        "entry_snapshot.restore",
        "membership.add",
        "fact.put",
        "memory.add",
        "relation.create",
        "prose.link",
        "prose.shape",
    ] {
        assert!(
            registry().get(name).is_some(),
            "shared/canonical capability missing: {name}"
        );
    }
    ws.shutdown().unwrap();
}
#[test]
fn old_catalog_and_old_prose_are_refused_without_repair_or_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "cutover-contract").unwrap();
    let old = common::acceptance::empty_source(ws.library());
    let before = ws
        .library()
        .load_copy(&format!("book:{old}"))
        .unwrap()
        .export(loro::ExportMode::all_updates())
        .unwrap();
    assert!(
        ws.call(&Actor::User, "book.get", json!({"book":old}))
            .is_err()
    );
    assert!(ws.prose_session("node:synthetic-retired").is_err());
    assert!(
        ws.call(&Actor::User, "book.list", json!({})).unwrap()["output"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ws.library()
            .load_copy(&format!("book:{old}"))
            .unwrap()
            .export(loro::ExportMode::all_updates())
            .unwrap(),
        before
    );
    ws.shutdown().unwrap();
}
#[test]
fn old_sync_payload_cannot_be_hidden_under_a_new_canonical_genesis() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "cutover-contract").unwrap();
    let book = dr_model::id::BookId::new_v7();
    let id = format!("book:{book}");
    let bytes = dr_doc::import_v1::genesis(&book);
    assert!(
        ws.import_remote(&id, Some(("book", book.as_str())), bytes, &Actor::Sync)
            .is_err()
    );
    assert!(ws.library().docs(None, None).unwrap().is_empty());
    ws.shutdown().unwrap();
}
#[test]
fn a_marker_change_that_arrives_before_its_dependency_is_refused_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "cutover-contract").unwrap();
    let book = ws
        .call(
            &Actor::User,
            "project.create",
            json!({"name":"Synthetic cutover"}),
        )
        .unwrap()["output"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = format!("book:{book}");
    let marker = |ws: &Workspace| ws.observe(&id).unwrap().value["meta"]["v"].clone();
    // Another device: a harmless write, then one that changes the marker.
    let other = ws.library().load_copy(&id).unwrap();
    let start = other.oplog_vv();
    other
        .get_map("writing_days")
        .insert("synthetic-device/2026-12-02", 1)
        .unwrap();
    other.commit();
    let harmless = other.export(loro::ExportMode::updates(&start)).unwrap();
    let between = other.oplog_vv();
    other.get_map("meta").insert("v", 2).unwrap();
    other.commit();
    let change = other.export(loro::ExportMode::updates(&between)).unwrap();
    let both = other.export(loro::ExportMode::updates(&start)).unwrap();
    let import = |ws: &Workspace, bytes: &[u8]| {
        ws.import_remote(
            &id,
            Some(("book", book.as_str())),
            bytes.to_vec(),
            &Actor::Sync,
        )
    };

    assert!(import(&ws, &both).is_err());
    assert_eq!(marker(&ws), json!(3));
    // Alone it cannot apply yet: it waits, and changes nothing.
    import(&ws, &change).unwrap();
    assert_eq!(marker(&ws), json!(3));
    // What it waits for would apply it too.
    let before = ws.version(&id).unwrap();
    assert!(import(&ws, &harmless).is_err());
    assert_eq!(marker(&ws), json!(3));
    assert_eq!(ws.version(&id).unwrap(), before);
    ws.shutdown().unwrap();

    // A waiting update is held in memory only: after a restart it has to
    // come again. Its dependency now lands on its own, and with the
    // dependency in the book the marker change is refused outright.
    let ws = Workspace::open_dir(dir.path(), "cutover-contract").unwrap();
    assert_eq!(marker(&ws), json!(3));
    assert!(import(&ws, &harmless).unwrap());
    assert_eq!(
        ws.observe(&id).unwrap().value["writing_days"]["synthetic-device/2026-12-02"],
        json!(1)
    );
    assert!(import(&ws, &change).is_err());
    assert_eq!(marker(&ws), json!(3));
    ws.shutdown().unwrap();
}
