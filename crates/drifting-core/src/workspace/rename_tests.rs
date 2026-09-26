use super::*;

fn prose_state(gateway: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "yjs_updates",
        "yjs_snapshots",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "sync_yjs_materialization_receipt",
        "node_content",
    ]
    .map(|table| rows(gateway, &format!("SELECT * FROM {table}")))
    .to_vec()
}

fn field_clocks(gateway: &DatabaseGateway) -> Vec<Value> {
    let result = gateway
        .query(
            "SELECT * FROM sync_field_clock ORDER BY target_kind,target_id,incarnation,field_key"
                .into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap();
    result
        .rows
        .iter()
        .map(|row| {
            let mut record = serde_json::Map::new();
            for (name, value) in result.columns.iter().zip(row) {
                let value = match value {
                    V::Text(value) => json!(value),
                    V::Integer(value) => json!(value.parse::<u64>().unwrap()),
                    _ => panic!("Unexpected clock column"),
                };
                record.insert(name.clone(), value);
            }
            Value::Object(record)
        })
        .collect()
}

#[test]
fn workspace_rename_updates_current_field_clocks_without_prose_and_cold_reopens() {
    let (dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    store.create_project(&c, project()).unwrap();
    let first = store
        .create_chapter(&c, chapter("workspace-chapter-a", "第一章", Some(2.5)))
        .unwrap();
    let second = store
        .create_chapter(&c, chapter("workspace-chapter-b", "第二章", None))
        .unwrap();
    let prose_before = prose_state(&gateway);

    store.rename_project(&c, "临时书名").unwrap();
    let project = store.rename_project(&c, "潮汐与夜航").unwrap();
    let once = store.rename_chapter(&c, &first.id, "序章").unwrap();
    assert_eq!(once.updated_at, "2026-09-26T00:00:00.001Z");
    let first = store.rename_chapter(&c, &first.id, "潮汐").unwrap();
    assert_eq!(first.updated_at, "2026-09-26T00:00:00.002Z");
    let before_noop = journal_state(&gateway);
    assert_eq!(store.rename_project(&c, "潮汐与夜航").unwrap(), project);
    assert_eq!(
        store
            .rename_chapter(&c, &first.id, "  潮汐 \u{feff}")
            .unwrap(),
        first
    );
    assert_eq!(journal_state(&gateway), before_noop);
    assert_eq!(prose_state(&gateway), prose_before);
    assert_eq!(count(&gateway, "sync_change_set"), 7);
    assert_eq!(count(&gateway, "sync_mutation"), 24);
    assert_eq!(count(&gateway, "sync_field_clock"), 4);
    assert_eq!(rows(&gateway, "SELECT target_kind,field_key,device_seq,hlc_counter FROM sync_field_clock WHERE target_kind IN ('project','node') ORDER BY target_kind"), vec![
        vec![text("node"), text("field:title"), integer(7), integer(6)],
        vec![text("project"), text("field:name"), integer(5), integer(4)],
    ]);
    let expected_chapters = vec![first, second];
    if let Some(directory) = std::env::var_os("NATIVE_WORKSPACE_EXPORT_DIR") {
        let changes = rows(&gateway, "SELECT encoded_bytes,mutation_count FROM sync_change_set ORDER BY device_seq")
            .into_iter().map(|row| {
                let V::Blob(bytes) = &row[0] else { panic!("envelope") };
                json!({"encodedBase64": STANDARD.encode(bytes), "mutationCount": number(&row, 1).unwrap()})
            }).collect::<Vec<_>>();
        let export = json!({
            "schemaVersion": 1, "changes": changes, "project": project, "chapters": expected_chapters,
            "seed": {"updateBase64": STANDARD.encode(SEED), "contentJson": seed().content_json},
            "fieldClocks": field_clocks(&gateway),
        });
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join("workspace-rename-wire.json"),
            serde_json::to_vec_pretty(&export).unwrap(),
        )
        .unwrap();
    }
    gateway.close(CLIENT.into()).unwrap();
    drop(gateway);
    let reopened = DatabaseGateway::new(dir.path().into()).unwrap();
    reopened
        .open("workspace.db".into(), CLIENT.into(), false)
        .unwrap();
    let store = WorkspaceStore::new(&reopened, CLIENT);
    assert_eq!(store.list_projects("local-user").unwrap(), vec![project]);
    assert_eq!(
        store.list_chapters(&c.project_id).unwrap(),
        expected_chapters
    );
    assert_eq!(prose_state(&reopened), prose_before);
}

#[test]
fn workspace_rename_excludes_self_deduplicates_nodes_and_uses_live_incarnation() {
    let (_dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    store.create_project(&c, project()).unwrap();
    let a = store
        .create_chapter(&c, chapter("a", "第一章", None))
        .unwrap();
    store
        .create_chapter(&c, chapter("b", "Untitled", None))
        .unwrap();
    exec(&gateway, "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('drift','CHAPTER','workspace-project',0,0,'now','now')");
    assert_eq!(
        store.rename_chapter(&c, &a.id, " chapter ").unwrap().title,
        "chapter 2"
    );
    let before_noop = journal_state(&gateway);
    assert_eq!(
        store.rename_chapter(&c, &a.id, "chapter 2").unwrap().title,
        "chapter 2"
    );
    assert_eq!(journal_state(&gateway), before_noop);
    assert_eq!(
        store.rename_chapter(&c, &a.id, " \u{feff}").unwrap().title,
        "Untitled 2"
    );
    let prose_before = prose_state(&gateway);
    // Synthetic current catalog stands in for an already applied restoration;
    // this test exercises naming, not the separate restore command/reducer.
    exec(
        &gateway,
        "UPDATE sync_entity_lifecycle SET incarnation=3 WHERE entity_kind='node' AND entity_id='a'",
    );
    exec(
        &gateway,
        "UPDATE sync_entity_lifecycle SET incarnation=2 WHERE entity_kind='project'",
    );
    store.rename_chapter(&c, &a.id, "恢复后的章节").unwrap();
    store.rename_project(&c, "恢复后的项目").unwrap();
    assert_eq!(
        store
            .chapter_scope(&c.project_id, &a.id)
            .unwrap()
            .incarnation,
        3
    );
    assert_eq!(rows(&gateway, "SELECT target_kind,incarnation FROM sync_mutation WHERE action='field.set' AND target_kind IN ('project','node') ORDER BY change_set_id"), vec![
        vec![text("node"), integer(0)], vec![text("node"), integer(0)],
        vec![text("node"), integer(3)], vec![text("project"), integer(2)],
    ]);
    assert_eq!(rows(&gateway, "SELECT incarnation FROM sync_field_clock WHERE target_kind='node' AND target_id='a' ORDER BY incarnation"), vec![vec![integer(0)], vec![integer(3)]]);
    assert_eq!(prose_state(&gateway), prose_before);
    let mut wrong = c.clone();
    wrong.sync_generation_id = "other-generation".into();
    let before = journal_state(&gateway);
    assert!(store.rename_project(&wrong, "wrong").is_err());
    assert!(store.rename_chapter(&wrong, &a.id, "wrong").is_err());
    assert!(store.rename_chapter(&c, "drift", "wrong").is_err());
    assert!(store.rename_project(&c, "  ").is_err());
    assert_eq!(journal_state(&gateway), before);
    exec(&gateway, "UPDATE sync_entity_lifecycle SET state='trashed' WHERE entity_kind='node' AND entity_id='a'");
    let before = journal_state(&gateway);
    assert!(store.rename_chapter(&c, &a.id, "恢复后的章节").is_err());
    assert_eq!(journal_state(&gateway), before);
    exec(
        &gateway,
        "UPDATE sync_generation SET status='retired',retired_at='now'",
    );
    let before = journal_state(&gateway);
    assert!(store.rename_project(&c, "恢复后的项目").is_err());
    assert!(store.rename_chapter(&c, "b", "Untitled").is_err());
    assert_eq!(journal_state(&gateway), before);
}

#[test]
fn workspace_rename_receipt_failure_rolls_back_names_clocks_and_writer_then_retries() {
    let (_dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    store.create_project(&c, project()).unwrap();
    let a = store
        .create_chapter(&c, chapter("a", "第一章", None))
        .unwrap();
    store.rename_project(&c, "已有项目名").unwrap();
    store.rename_chapter(&c, &a.id, "已有章节名").unwrap();
    let project_before = store.list_projects("local-user").unwrap();
    let chapters_before = store.list_chapters(&c.project_id).unwrap();
    let journal_before = journal_state(&gateway);
    let prose_before = prose_state(&gateway);
    exec(&gateway, "CREATE TRIGGER workspace_rename_failure BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic rename receipt failure'); END");
    assert!(store
        .rename_project(&c, "新项目名")
        .unwrap_err()
        .contains("synthetic rename receipt failure"));
    assert_eq!(store.list_projects("local-user").unwrap(), project_before);
    assert_eq!(journal_state(&gateway), journal_before);
    assert!(store
        .rename_chapter(&c, &a.id, "新章节名")
        .unwrap_err()
        .contains("synthetic rename receipt failure"));
    assert_eq!(store.list_chapters(&c.project_id).unwrap(), chapters_before);
    assert_eq!(journal_state(&gateway), journal_before);
    assert_eq!(prose_state(&gateway), prose_before);
    exec(&gateway, "DROP TRIGGER workspace_rename_failure");
    assert_eq!(
        store.rename_project(&c, "新项目名").unwrap().name,
        "新项目名"
    );
    assert_eq!(
        store.rename_chapter(&c, &a.id, "新章节名").unwrap().title,
        "新章节名"
    );
    assert_eq!(
        rows(
            &gateway,
            "SELECT next_device_seq FROM sync_generation_writer_state"
        ),
        vec![vec![integer(7)]]
    );
    assert_eq!(count(&gateway, "sync_change_set"), 6);
    assert_eq!(prose_state(&gateway), prose_before);
}
