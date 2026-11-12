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
    assert!(dr_doc::v3::is_book_doc(&raw));
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
/// A book document as a build of format 3 began it: `meta.v = 3` from that
/// format's genesis peer.
fn format_3_genesis(book: &dr_model::id::BookId) -> Vec<u8> {
    let doc = loro::LoroDoc::new();
    doc.set_peer_id(dr_doc::peer::genesis_peer(&format!("book:{book}"), 3))
        .unwrap();
    let meta = doc.get_map("meta");
    meta.insert("v", 3).unwrap();
    meta.insert("book", book.as_str()).unwrap();
    doc.commit_with(loro::CommitOptions::new().timestamp(0));
    doc.export(loro::ExportMode::all_updates()).unwrap()
}
#[test]
fn a_book_of_format_3_is_refused_as_it_is_and_cannot_arrive_by_sync() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "cutover-contract").unwrap();
    // One stored by an earlier build.
    let old = dr_model::id::BookId::new_v7();
    let id = format!("book:{old}");
    let genesis = format_3_genesis(&old);
    let h = ws
        .library()
        .open_doc(
            &id,
            dr_store::OpenDoc::CreateIfMissing {
                kind: "book",
                book_id: Some(old.as_str()),
                genesis: &move |d: &loro::LoroDoc| {
                    d.import(&genesis).unwrap();
                },
            },
        )
        .unwrap();
    h.close();
    let stored = || {
        ws.library()
            .load_copy(&id)
            .unwrap()
            .export(loro::ExportMode::all_updates())
            .unwrap()
    };
    let before = stored();
    assert!(!dr_doc::v3::is_book_doc(
        &ws.library().load_copy(&id).unwrap()
    ));
    for (name, input) in [
        ("book.get", json!({"book": old.as_str()})),
        ("entry.list", json!({"book": old.as_str()})),
        (
            "book.writing_days",
            json!({"book": old.as_str(), "today": "2026-11-13"}),
        ),
    ] {
        assert!(ws.call(&Actor::User, name, input).is_err(), "{name}");
    }
    assert!(
        ws.call(&Actor::User, "book.list", json!({})).unwrap()["output"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(stored(), before, "refused as it is: nothing written");
    // And one arriving from a device of that build is not taken in.
    let other = dr_model::id::BookId::new_v7();
    assert!(
        ws.import_remote(
            &format!("book:{other}"),
            Some(("book", other.as_str())),
            format_3_genesis(&other),
            &Actor::Sync
        )
        .is_err()
    );
    assert!(
        ws.library()
            .doc_info(&format!("book:{other}"))
            .unwrap()
            .is_none()
    );
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
        .get_map("synthetic_root")
        .insert("synthetic-key", 1)
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
    assert_eq!(marker(&ws), json!(dr_doc::schema::BOOK_SCHEMA_VERSION));
    // Alone it cannot apply yet: it waits, and changes nothing.
    import(&ws, &change).unwrap();
    assert_eq!(marker(&ws), json!(dr_doc::schema::BOOK_SCHEMA_VERSION));
    // What it waits for would apply it too.
    let before = ws.version(&id).unwrap();
    assert!(import(&ws, &harmless).is_err());
    assert_eq!(marker(&ws), json!(dr_doc::schema::BOOK_SCHEMA_VERSION));
    assert_eq!(ws.version(&id).unwrap(), before);
    ws.shutdown().unwrap();

    // A waiting update is held in memory only: after a restart it has to
    // come again. Its dependency now lands on its own, and with the
    // dependency in the book the marker change is refused outright.
    let ws = Workspace::open_dir(dir.path(), "cutover-contract").unwrap();
    assert_eq!(marker(&ws), json!(dr_doc::schema::BOOK_SCHEMA_VERSION));
    assert!(import(&ws, &harmless).unwrap());
    assert_eq!(
        ws.observe(&id).unwrap().value["synthetic_root"]["synthetic-key"],
        json!(1)
    );
    assert!(import(&ws, &change).is_err());
    assert_eq!(marker(&ws), json!(dr_doc::schema::BOOK_SCHEMA_VERSION));
    ws.shutdown().unwrap();
}
