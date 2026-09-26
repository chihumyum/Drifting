use super::*;

const CLIENT: &str = "synthetic-outline";
const PROJECT: &str = "outline-project";
const GENERATION: &str = "outline-generation";
const NOW: &str = "2026-09-26T00:00:00.000Z";

fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let directory = tempfile::tempdir().unwrap();
    let gateway = DatabaseGateway::new(directory.path().into()).unwrap();
    gateway
        .open("outline.db".into(), CLIENT.into(), false)
        .unwrap();
    WorkspaceStore::new(&gateway, CLIENT)
        .create_project(
            &AuthoredProseContext {
                project_id: PROJECT.into(),
                project_sync_id: "outline-project-sync".into(),
                sync_generation_id: GENERATION.into(),
                installation_id: "outline-installation".into(),
                new_writer_id: "outline-writer".into(),
                new_writer_epoch: "outline-epoch".into(),
                now_ms: 100,
                now_iso: NOW.into(),
            },
            CreateProject {
                user_id: "local-user".into(),
                name: "合成大纲".into(),
                default_kv_ids: std::array::from_fn(|index| format!("outline-fact-{index}")),
            },
        )
        .unwrap();
    (directory, gateway)
}

fn exec(gateway: &DatabaseGateway, sql: &str, values: Vec<V>) {
    gateway
        .execute(sql.into(), values, None, CLIENT.into())
        .unwrap();
}

fn query(gateway: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    gateway
        .query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}

// These synthetic domain rows exercise a read-only query; no prose seed or
// authored-content claim is made by this fixture setup.
fn chapter(gateway: &DatabaseGateway, id: &str, order: f64) {
    exec(gateway, "INSERT INTO book_node(id,project_id,title,kind,book_order,position_x,position_y,created_at,updated_at) VALUES (?,? ,?,'chapter',?,0,0,?,?)",
        vec![text(id),text(PROJECT),text(id),V::Real(order),text(NOW),text(NOW)]);
}

fn act(gateway: &DatabaseGateway, id: &str, order: Option<f64>) {
    exec(gateway, "INSERT INTO book_act(id,project_id,name,start_order,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        vec![text(id),text(PROJECT),text(id),order.map(V::Real).unwrap_or(V::Null),text(NOW),text(NOW)]);
}

fn total_changes(gateway: &DatabaseGateway) -> Vec<Vec<V>> {
    query(gateway, "SELECT total_changes()")
}

fn compact(rows: &[WorkspaceOutlineRow]) -> Vec<(&str, &str, Option<&str>)> {
    rows.iter()
        .map(|row| (row.kind, row.id.as_str(), row.act_id.as_deref()))
        .collect()
}

fn scenario(gateway: &DatabaseGateway, name: &str) -> Value {
    let store = WorkspaceStore::new(gateway, CLIENT);
    let before = total_changes(gateway);
    let rows = store.outline(PROJECT).unwrap();
    assert_eq!(total_changes(gateway), before);
    let acts = query(gateway, "SELECT id,name,start_order FROM book_act ORDER BY id COLLATE BINARY")
        .iter().map(|row| json!({
            "id":string(row,0).unwrap(),"projectId":PROJECT,"name":string(row,1).unwrap(),
            "color":null,"startOrder":match &row[2] {V::Null=>Value::Null,_=>json!(number(row,2).unwrap())},
            "driftNodeId":null,"createdAt":NOW,"updatedAt":NOW
        })).collect::<Vec<_>>();
    let chapters = store
        .list_chapters(PROJECT)
        .unwrap()
        .into_iter()
        .map(
            |chapter| json!({"id":chapter.id,"title":chapter.title,"bookOrder":chapter.book_order}),
        )
        .collect::<Vec<_>>();
    json!({"name":name,"acts":acts,"chapters":chapters,"rows":rows})
}

#[test]
fn workspace_outline_matches_boundaries_and_utf8_ties_without_writes() {
    let (_directory, gateway) = database();
    for (id, order) in [
        ("before", -3.0),
        ("chapter-𐀀", 10.0),
        ("chapter-\u{e000}", 10.0),
        ("tail", 40.0),
    ] {
        chapter(&gateway, id, order);
    }
    let before = total_changes(&gateway);
    let ungrouped = WorkspaceStore::new(&gateway, CLIENT)
        .outline(PROJECT)
        .unwrap();
    assert!(ungrouped
        .iter()
        .all(|row| row.kind == "chapter" && row.act_id.is_none()));
    assert_eq!(total_changes(&gateway), before);
    for (id, order) in [
        ("act-𐀀", 10.0),
        ("act-\u{e000}", 10.0),
        ("empty", 20.0),
        ("last", 30.0),
    ] {
        act(&gateway, id, Some(order));
    }
    let store = WorkspaceStore::new(&gateway, CLIENT);
    let before = total_changes(&gateway);
    let rows = store.outline(PROJECT).unwrap();
    assert_eq!(
        compact(&rows),
        vec![
            ("chapter", "before", None),
            ("act", "act-\u{e000}", None),
            ("act", "act-𐀀", None),
            ("chapter", "chapter-\u{e000}", Some("act-𐀀")),
            ("chapter", "chapter-𐀀", Some("act-𐀀")),
            ("act", "empty", None),
            ("act", "last", None),
            ("chapter", "tail", Some("last")),
        ]
    );
    assert_eq!(total_changes(&gateway), before);
    let finite = scenario(&gateway, "finite-first-boundary-empty-act-and-utf8-ties");
    act(&gateway, "head", None);
    let before = total_changes(&gateway);
    let rows = store.outline(PROJECT).unwrap();
    assert_eq!(
        &compact(&rows)[..2],
        &[("act", "head", None), ("chapter", "before", Some("head"))]
    );
    assert_eq!(total_changes(&gateway), before);
    let head = scenario(&gateway, "optional-null-head-boundary");
    if let Some(directory) = std::env::var_os("NATIVE_WORKSPACE_EXPORT_DIR") {
        let path = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("workspace-outline.json"),
            serde_json::to_vec_pretty(&json!({"schemaVersion":1,"scenarios":[finite,head]}))
                .unwrap(),
        )
        .unwrap();
    }
}

fn lifecycle(gateway: &DatabaseGateway, generation: &str, kind: &str, id: &str, state: &str) {
    exec(gateway, "INSERT INTO sync_entity_lifecycle(sync_generation_id,entity_kind,entity_id,incarnation,state,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index) SELECT ?,?,?,0,?,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='project' AND entity_id=?",
        vec![text(generation),text(kind),text(id),text(state),text(GENERATION),text(PROJECT)]);
}

#[test]
fn workspace_outline_uses_current_lifecycle_and_rejects_unavailable_project() {
    let (_directory, gateway) = database();
    for id in ["visible", "trashed", "purged", "soft-deleted", "drift"] {
        chapter(&gateway, id, 5.0);
    }
    for id in ["act-visible", "act-trashed", "act-purged"] {
        act(&gateway, id, Some(0.0));
    }
    exec(
        &gateway,
        "UPDATE book_node SET deleted_at=? WHERE id='soft-deleted'",
        vec![text(NOW)],
    );
    exec(
        &gateway,
        "UPDATE book_node SET kind='drift',book_order=NULL WHERE id='drift'",
        vec![],
    );
    lifecycle(&gateway, GENERATION, "node", "trashed", "trashed");
    lifecycle(&gateway, GENERATION, "node", "purged", "purged");
    lifecycle(&gateway, GENERATION, "book-act", "act-trashed", "trashed");
    lifecycle(&gateway, GENERATION, "book-act", "act-purged", "purged");
    exec(&gateway,"INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,generation_number,status,created_at,updated_at,retired_at) VALUES ('old-generation',?,'outline-project-sync',2,'retired',?,?,?)",vec![text(PROJECT),text(NOW),text(NOW),text(NOW)]);
    lifecycle(&gateway, "old-generation", "node", "visible", "trashed");
    lifecycle(
        &gateway,
        "old-generation",
        "book-act",
        "act-visible",
        "trashed",
    );
    // Another active project's rows must never join this reading axis.
    exec(&gateway, "INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('other-project','Other','other-user',?,?)", vec![text(NOW),text(NOW)]);
    exec(&gateway, "INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES ('other-generation','other-project','other-project-sync',?,?)", vec![text(NOW),text(NOW)]);
    exec(&gateway, "INSERT INTO book_act(id,project_id,name,start_order,created_at,updated_at) VALUES ('other-act','other-project','Other act',NULL,?,?)", vec![text(NOW),text(NOW)]);
    exec(&gateway, "INSERT INTO book_node(id,project_id,title,kind,book_order,position_x,position_y,created_at,updated_at) VALUES ('other-chapter','other-project','Other chapter','chapter',1,0,0,?,?)", vec![text(NOW),text(NOW)]);
    let store = WorkspaceStore::new(&gateway, CLIENT);
    let before = total_changes(&gateway);
    assert_eq!(
        compact(&store.outline(PROJECT).unwrap()),
        vec![
            ("act", "act-visible", None),
            ("chapter", "visible", Some("act-visible"))
        ]
    );
    assert!(store.outline("missing-project").is_err());
    assert_eq!(total_changes(&gateway), before);
    exec(&gateway,"UPDATE sync_entity_lifecycle SET state='trashed' WHERE entity_kind='project' AND entity_id=?",vec![text(PROJECT)]);
    let before = total_changes(&gateway);
    assert!(store.outline(PROJECT).is_err());
    assert_eq!(total_changes(&gateway), before);
    exec(
        &gateway,
        "UPDATE sync_entity_lifecycle SET state='live' WHERE entity_kind='project' AND entity_id=?",
        vec![text(PROJECT)],
    );
    exec(
        &gateway,
        "UPDATE sync_generation SET status='retired',retired_at=? WHERE sync_generation_id=?",
        vec![text(NOW), text(GENERATION)],
    );
    let before = total_changes(&gateway);
    assert!(store.outline(PROJECT).is_err());
    assert_eq!(total_changes(&gateway), before);
    exec(
        &gateway,
        "UPDATE sync_generation SET status='active',retired_at=NULL WHERE sync_generation_id=?",
        vec![text(GENERATION)],
    );
    exec(&gateway,"INSERT INTO sync_generation_purge(sync_generation_id,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index) SELECT sync_generation_id,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='project'",vec![text(GENERATION)]);
    let before = total_changes(&gateway);
    assert!(store.outline(PROJECT).is_err());
    assert_eq!(total_changes(&gateway), before);
}

#[test]
fn workspace_outline_preserves_empty_acts_and_rejects_nonfinite_boundary() {
    let (_directory, gateway) = database();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    let before = total_changes(&gateway);
    assert!(store.outline(PROJECT).unwrap().is_empty());
    assert_eq!(total_changes(&gateway), before);
    act(&gateway, "head", None);
    act(&gateway, "planned", Some(7.5));
    let before = total_changes(&gateway);
    assert_eq!(
        compact(&store.outline(PROJECT).unwrap()),
        vec![("act", "head", None), ("act", "planned", None)]
    );
    assert_eq!(total_changes(&gateway), before);
    exec(
        &gateway,
        "UPDATE book_act SET start_order=1e999 WHERE id='planned'",
        vec![],
    );
    let before = total_changes(&gateway);
    assert!(store.outline(PROJECT).is_err());
    assert_eq!(total_changes(&gateway), before);
}
