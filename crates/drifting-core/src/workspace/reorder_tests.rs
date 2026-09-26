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
fn placement(chapters: &[WorkspaceChapter]) -> Vec<Value> {
    chapters
        .iter()
        .map(|chapter| json!({"id": chapter.id, "bookOrder": chapter.book_order}))
        .collect()
}
fn ids(chapters: &[WorkspaceChapter]) -> Vec<&str> {
    chapters.iter().map(|chapter| chapter.id.as_str()).collect()
}
fn clock_rows(gateway: &DatabaseGateway) -> Vec<Value> {
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
            let values = result
                .columns
                .iter()
                .zip(row)
                .map(|(name, value)| {
                    let value = match value {
                        V::Text(value) => json!(value),
                        V::Integer(value) => json!(value.parse::<u64>().unwrap()),
                        _ => panic!("Unexpected field clock value"),
                    };
                    (name.clone(), value)
                })
                .collect();
            Value::Object(values)
        })
        .collect()
}

#[test]
fn workspace_move_preserves_continuous_axis_acts_prose_and_cold_order() {
    let (dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    let project = store.create_project(&c, project()).unwrap();
    for (id, title, order) in [
        ("a", "第一章", 2.5),
        ("b", "第二章", 10.25),
        ("c", "第三章", 20.5),
    ] {
        store
            .create_chapter(&c, chapter(id, title, Some(order)))
            .unwrap();
    }
    // Acts are authored numeric boundaries, not lists of chapter IDs.
    exec(&gateway, "INSERT INTO book_act(id,project_id,name,start_order,created_at,updated_at) VALUES ('act-a','workspace-project','第一幕',4.5,'now','now'),('act-b','workspace-project','第二幕',15.0,'now','now')");
    let acts_before = rows(&gateway, "SELECT * FROM book_act ORDER BY id");
    let prose_before = prose_state(&gateway);
    let membership_before = rows(&gateway, "SELECT * FROM node_storyline_link");
    let order_registers = rows(&gateway, "SELECT * FROM sync_order_register");
    let initial = store.list_chapters(&c.project_id).unwrap();
    let mut checkpoints = Vec::new();
    let front = store.move_chapter(&c, "c", Some("a")).unwrap();
    assert_eq!(ids(&front), vec!["c", "a", "b"]);
    assert_eq!(front[0].book_order, -2.5);
    assert_eq!(front[1..], initial[..2]); // Only c changed.
    checkpoints.push(json!({"changeSetIndex": 4, "chapterId": "c", "beforeChapterId": "a", "chapters": placement(&front)}));
    let end = store.move_chapter(&c, "a", None).unwrap();
    assert_eq!(ids(&end), vec!["c", "b", "a"]);
    assert_eq!(end[2].book_order, 15.25);
    assert_eq!(end[0], front[0]);
    assert_eq!(end[1], front[2]);
    // Crossing a fixed boundary moves membership naturally, not the boundary.
    assert_eq!(rows(&gateway, "SELECT id FROM book_node WHERE kind='chapter' AND book_order>=15.0 ORDER BY book_order,id"), vec![vec![text("a")]]);
    checkpoints.push(json!({"changeSetIndex": 5, "chapterId": "a", "beforeChapterId": null, "chapters": placement(&end)}));
    let middle = store.move_chapter(&c, "a", Some("b")).unwrap();
    assert_eq!(ids(&middle), vec!["c", "a", "b"]);
    assert_eq!(middle[1].book_order, 3.875);
    assert_eq!(middle[0], end[0]);
    assert_eq!(middle[2], end[1]);
    checkpoints.push(json!({"changeSetIndex": 6, "chapterId": "a", "beforeChapterId": "b", "chapters": placement(&middle)}));
    assert!(rows(
        &gateway,
        "SELECT id FROM book_node WHERE kind='chapter' AND book_order>=15.0"
    )
    .is_empty());
    assert_eq!(
        rows(&gateway, "SELECT * FROM book_act ORDER BY id"),
        acts_before
    );
    assert_eq!(
        rows(&gateway, "SELECT * FROM node_storyline_link"),
        membership_before
    );
    assert_eq!(
        rows(&gateway, "SELECT * FROM sync_order_register"),
        order_registers
    );
    assert_eq!(prose_state(&gateway), prose_before);
    assert_eq!(count(&gateway, "sync_change_set"), 7);
    assert_eq!(count(&gateway, "sync_field_clock"), 5);
    assert_eq!(rows(&gateway, "SELECT target_id,device_seq FROM sync_field_clock WHERE field_key='field:bookOrder' ORDER BY target_id"), vec![vec![text("a"),integer(7)],vec![text("c"),integer(5)]]);
    if let Some(directory) = std::env::var_os("NATIVE_WORKSPACE_EXPORT_DIR") {
        let changes = rows(&gateway, "SELECT encoded_bytes,mutation_count FROM sync_change_set ORDER BY device_seq")
            .into_iter().map(|row| {
                let V::Blob(bytes) = &row[0] else { panic!("envelope") };
                json!({"encodedBase64": STANDARD.encode(bytes), "mutationCount": number(&row, 1).unwrap()})
            }).collect::<Vec<_>>();
        let export = json!({
            "schemaVersion": 1, "changes": changes, "project": project, "chapters": middle,
            "seed": {"updateBase64": STANDARD.encode(SEED), "contentJson": seed().content_json},
            "fieldClocks": clock_rows(&gateway), "moves": checkpoints,
        });
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join("workspace-reorder-wire.json"),
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
    assert_eq!(store.list_chapters(&c.project_id).unwrap(), middle);
    assert_eq!(prose_state(&reopened), prose_before);
    assert_eq!(
        rows(&reopened, "SELECT * FROM book_act ORDER BY id"),
        acts_before
    );
}

#[test]
fn workspace_move_noops_and_invalid_destinations_or_numeric_gaps_never_write() {
    let (_dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    store.create_project(&c, project()).unwrap();
    for (id, order) in [("a", 5.0), ("b", 5.0), ("c", 15.0)] {
        store
            .create_chapter(&c, chapter(id, id, Some(order)))
            .unwrap();
    }
    exec(&gateway, "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('drift','Drift','workspace-project',0,0,'now','now')");
    let before = store.list_chapters(&c.project_id).unwrap();
    let journal_before = journal_state(&gateway);
    assert_eq!(store.move_chapter(&c, "a", Some("a")).unwrap(), before);
    assert_eq!(store.move_chapter(&c, "a", Some("b")).unwrap(), before);
    assert_eq!(store.move_chapter(&c, "c", None).unwrap(), before);
    assert!(store
        .move_chapter(&c, "c", Some("b"))
        .unwrap_err()
        .contains("numeric gap"));
    for (source, destination) in [
        ("missing", None),
        ("drift", Some("a")),
        ("a", Some("missing")),
        ("a", Some("drift")),
    ] {
        assert!(store.move_chapter(&c, source, destination).is_err());
    }
    let mut wrong = c.clone();
    wrong.project_sync_id = "wrong-project-sync".into();
    assert!(store.move_chapter(&wrong, "c", Some("a")).is_err());
    assert_eq!(store.list_chapters(&c.project_id).unwrap(), before);
    assert_eq!(journal_state(&gateway), journal_before);
    // An adjacent floating-point value leaves no strict midpoint either.
    gateway
        .execute(
            "UPDATE book_node SET book_order=? WHERE id='b'".into(),
            vec![V::Real(f64::from_bits(5.0_f64.to_bits() + 1))],
            None,
            CLIENT.into(),
        )
        .unwrap();
    let before_dense = store.list_chapters(&c.project_id).unwrap();
    assert!(store
        .move_chapter(&c, "c", Some("b"))
        .unwrap_err()
        .contains("numeric gap"));
    assert_eq!(store.list_chapters(&c.project_id).unwrap(), before_dense);
    assert_eq!(journal_state(&gateway), journal_before);
    exec(&gateway, "UPDATE sync_entity_lifecycle SET state='trashed' WHERE entity_kind='node' AND entity_id='b'");
    let journal_before = journal_state(&gateway);
    assert!(store.move_chapter(&c, "a", Some("b")).is_err());
    assert_eq!(journal_state(&gateway), journal_before);
    exec(
        &gateway,
        "UPDATE sync_generation SET status='retired',retired_at='now'",
    );
    let journal_before = journal_state(&gateway);
    assert!(store.move_chapter(&c, "a", Some("a")).is_err());
    assert_eq!(journal_state(&gateway), journal_before);
}

#[test]
fn workspace_move_receipt_failure_rolls_back_coordinate_and_retries_live_incarnation() {
    let (_dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    store.create_project(&c, project()).unwrap();
    for id in ["a", "b", "c"] {
        store.create_chapter(&c, chapter(id, id, None)).unwrap();
    }
    store.move_chapter(&c, "c", Some("a")).unwrap();
    // Synthetic current catalog represents a previously restored chapter;
    // the placement command must target its current incarnation, not zero.
    exec(
        &gateway,
        "UPDATE sync_entity_lifecycle SET incarnation=2 WHERE entity_kind='node' AND entity_id='c'",
    );
    let chapters_before = store.list_chapters(&c.project_id).unwrap();
    let journal_before = journal_state(&gateway);
    let prose_before = prose_state(&gateway);
    exec(&gateway, "CREATE TRIGGER workspace_move_failure BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic move receipt failure'); END");
    assert!(store
        .move_chapter(&c, "c", None)
        .unwrap_err()
        .contains("synthetic move receipt failure"));
    assert_eq!(store.list_chapters(&c.project_id).unwrap(), chapters_before);
    assert_eq!(journal_state(&gateway), journal_before);
    assert_eq!(prose_state(&gateway), prose_before);
    exec(&gateway, "DROP TRIGGER workspace_move_failure");
    let moved = store.move_chapter(&c, "c", None).unwrap();
    assert_eq!(ids(&moved), vec!["a", "b", "c"]);
    assert_eq!(moved[2].book_order, 15.0);
    assert_eq!(count(&gateway, "sync_change_set"), 6);
    assert_eq!(
        rows(
            &gateway,
            "SELECT next_device_seq FROM sync_generation_writer_state"
        ),
        vec![vec![integer(7)]]
    );
    assert_eq!(rows(&gateway, "SELECT incarnation,device_seq FROM sync_field_clock WHERE target_kind='node' AND target_id='c' AND field_key='field:bookOrder' ORDER BY incarnation"), vec![vec![integer(0),integer(5)],vec![integer(2),integer(6)]]);
    assert_eq!(rows(&gateway, "SELECT incarnation FROM sync_mutation WHERE change_set_id='workspace-writer:workspace-epoch:6'"), vec![vec![integer(2)]]);
    assert_eq!(prose_state(&gateway), prose_before);
}
