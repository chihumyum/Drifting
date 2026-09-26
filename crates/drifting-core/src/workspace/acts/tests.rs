use super::*;
use crate::original_operation::{verify_change_set, ChangeSetRef};
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-act-boundaries";
const NOW: &str = "2026-09-27T00:00:00.000Z";
// Synthetic Yjs client 440002, one empty paragraph with a stable block ID.
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "acts-project".into(),
        project_sync_id: "acts-project-sync".into(),
        sync_generation_id: "acts-generation".into(),
        installation_id: "acts-installation".into(),
        new_writer_id: "acts-writer".into(),
        new_writer_epoch: "acts-epoch".into(),
        now_iso: NOW.into(),
        now_ms: 200,
    }
}
fn rows(g: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    g.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn exec(g: &DatabaseGateway, sql: &str) {
    g.execute(sql.into(), vec![], None, CLIENT.into()).unwrap();
}
fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let g = DatabaseGateway::new(dir.path().into()).unwrap();
    g.open("acts.db".into(), CLIENT.into(), false).unwrap();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "合成幕分界".into(),
                default_kv_ids: std::array::from_fn(|i| format!("acts-fact-{i}")),
            },
        )
        .unwrap();
    for (id, order) in [
        ("chapter-a", 1.25),
        ("chapter-b", 10.5),
        ("chapter-c", 20.75),
    ] {
        store.create_chapter(&c,CreateChapter {
            id:id.into(),title:id.into(),book_order:Some(order),
            seed:ChapterSeed { update:STANDARD.decode(SEED).unwrap(),
                content_json:r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#.into() },
        }).unwrap();
    }
    exec(&g,"INSERT INTO comment(id,project_id,target_kind,target_id,anchor_json,body_json,created_at,updated_at) VALUES ('act-comment','acts-project','node','chapter-b','{\"anchor\":\"synthetic\"}','{\"text\":\"保留评论\"}','before','before')");
    (dir, g)
}
fn prose(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "book_node",
        "node_content",
        "comment",
        "comment_action",
        "yjs_snapshots",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "sync_yjs_materialization_receipt",
    ]
    .iter()
    .map(|table| rows(g, &format!("SELECT * FROM {table} ORDER BY rowid")))
    .collect()
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    let mut value = prose(g);
    value.extend(
        [
            "book_act",
            "sync_generation_writer_state",
            "sync_change_set",
            "sync_mutation",
            "sync_apply_receipt",
            "sync_entity_lifecycle",
            "sync_field_clock",
            "workspace_projection_change",
        ]
        .iter()
        .map(|table| rows(g, &format!("SELECT * FROM {table} ORDER BY rowid"))),
    );
    value
}
fn latest(g: &DatabaseGateway) -> crate::original_operation::VerifiedChangeSet {
    let row=&rows(g,"SELECT change_set_id,payload_sha256,encoded_bytes FROM sync_change_set ORDER BY device_seq DESC LIMIT 1")[0];
    let V::Blob(bytes) = &row[2] else {
        panic!("canonical original bytes")
    };
    let c = context();
    verify_change_set(
        bytes,
        &ChangeSetRef {
            project_id: c.project_id,
            project_sync_id: c.project_sync_id,
            sync_generation_id: c.sync_generation_id,
            change_set_id: string(row, 0).unwrap(),
            original_envelope_sha256: string(row, 1).unwrap(),
        },
    )
    .unwrap()
}

#[test]
fn workspace_acts_create_and_rename_on_current_chapter_axis() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let before = prose(&g);
    assert!(store
        .outline(&c.project_id)
        .unwrap()
        .iter()
        .all(|row| row.kind == "chapter" && row.act_id.is_none()));
    // Creation order differs from final axis order; existing acts are not renamed.
    let tail = store
        .create_act_before_chapter(&c, "tail-act", "chapter-c")
        .unwrap();
    let middle = store
        .create_act_before_chapter(&c, "middle-act", "chapter-b")
        .unwrap();
    assert_eq!(tail.name, "第一幕");
    assert_eq!(middle.name, "第一幕");
    assert_eq!(middle.start_order, Some(10.5));
    let wire = latest(&g);
    assert_eq!(wire.mutations().len(), 1);
    let m = &wire.mutations()[0];
    assert_eq!(m.action(), "entity.create");
    assert_eq!(m.target().kind, "book-act");
    assert_eq!(
        m.payload_json().unwrap(),
        json!({"seed":{"name":"第一幕","color":null,"startOrder":10.5,"driftNodeId":null}})
    );
    let named = store.rename_act(&c, &middle.id, "第二部分🙂").unwrap();
    assert_eq!(named.start_order, middle.start_order);
    assert_eq!(named.name, "第二部分🙂");
    let wire = latest(&g);
    assert_eq!(wire.mutations()[0].action(), "field.set");
    assert_eq!(
        wire.mutations()[0].payload_json().unwrap(),
        json!({"field":"name","value":"第二部分🙂"})
    );
    assert_eq!(prose(&g), before);
    let unchanged = state(&g);
    store.rename_act(&c, &middle.id, "第二部分🙂").unwrap();
    assert_eq!(state(&g), unchanged);
    g.close(CLIENT.into()).unwrap();
    g.open("acts.db".into(), CLIENT.into(), false).unwrap();
    let outline = store.outline(&c.project_id).unwrap();
    assert_eq!(
        outline
            .iter()
            .map(|row| (row.kind, row.id.as_str(), row.act_id.as_deref()))
            .collect::<Vec<_>>(),
        vec![
            ("chapter", "chapter-a", None),
            ("act", "middle-act", None),
            ("chapter", "chapter-b", Some("middle-act")),
            ("act", "tail-act", None),
            ("chapter", "chapter-c", Some("tail-act")),
        ]
    );
    assert_eq!(outline[1].title, "第二部分🙂");
    for (n, expected) in [
        (1, "第一幕"),
        (10, "第十幕"),
        (12, "第十二幕"),
        (20, "第二十幕"),
        (21, "第二十一幕"),
        (99, "第九十九幕"),
        (100, "第100幕"),
    ] {
        assert_eq!(default_act_name(n), expected);
    }
}

#[test]
fn workspace_acts_remove_empty_or_bound_boundary_preserves_all_prose() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let empty = store
        .create_act_before_chapter(&c, "empty-act", "chapter-c")
        .unwrap();
    store
        .move_chapter(&c, "chapter-c", Some("chapter-a"))
        .unwrap();
    let outline = store.outline(&c.project_id).unwrap();
    assert_eq!(outline.last().unwrap().id, empty.id);
    assert!(outline
        .iter()
        .filter(|row| row.kind == "chapter")
        .all(|row| row.act_id.is_none()));
    // Existing head anchor with bound notes, authored with the same canonical
    // journal. This fixture does not add a native drift creation UI.
    exec(&g,"INSERT INTO book_node(id,project_id,title,kind,position_x,position_y,created_at,updated_at) VALUES ('notes-drift','acts-project','幕笔记','drift',3,4,'before','before')");
    exec(&g,"INSERT INTO node_content(node_id,content_json,created_at,updated_at) VALUES ('notes-drift','{\"type\":\"doc\",\"content\":[]}','before','before')");
    ProseRepository::new(&g, CLIENT)
        .save_snapshot(
            "node-content:notes-drift",
            &STANDARD.decode(SEED).unwrap(),
            NOW,
            None,
        )
        .unwrap();
    store.transaction(TransactionBehavior::Immediate,|tx| {
        store.execute(tx,"INSERT INTO book_act(id,project_id,name,color,start_order,drift_node_id,created_at,updated_at) VALUES ('head-act','acts-project','序幕','#abcdef',NULL,'notes-drift',?,?)",vec![text(NOW),text(NOW)])?;
        store.commit_changes(tx,&c,&[journal::Mutation::create("book-act","head-act",json!({"name":"序幕","color":"#abcdef","startOrder":null,"driftNodeId":"notes-drift"}))],None)
    }).unwrap();
    let head = store.rename_act(&c, "head-act", "保留笔记的序幕").unwrap();
    assert_eq!(head.color.as_deref(), Some("#abcdef"));
    assert_eq!(head.drift_node_id.as_deref(), Some("notes-drift"));
    assert_eq!(head.start_order, None);
    let middle = store
        .create_act_before_chapter(&c, "middle-act", "chapter-b")
        .unwrap();
    assert_eq!(middle.name, "第二幕"); // The head counts; the later empty act does not.
    let before = prose(&g);
    assert_eq!(store.remove_act(&c, "head-act").unwrap(), head);
    assert_eq!(store.remove_act(&c, "empty-act").unwrap(), empty);
    assert_eq!(prose(&g), before);
    assert_eq!(
        rows(
            &g,
            "SELECT state,incarnation FROM sync_entity_lifecycle WHERE entity_id='head-act'"
        ),
        vec![vec![text("purged"), integer(0)]]
    );
    let wire = latest(&g);
    assert_eq!(wire.mutations().len(), 1);
    assert_eq!(wire.mutations()[0].action(), "entity.purge");
    assert_eq!(wire.mutations()[0].payload_json().unwrap(), json!({}));
    assert_eq!(
        rows(&g, "SELECT id FROM book_node WHERE id='notes-drift'"),
        vec![vec![text("notes-drift")]]
    );
    assert!(store
        .outline(&c.project_id)
        .unwrap()
        .iter()
        .filter(|row| row.kind == "act")
        .all(|row| row.id == middle.id));
}

#[test]
fn workspace_acts_receipt_failures_and_invalid_scope_rollback() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    store
        .create_act_before_chapter(&c, "existing-act", "chapter-b")
        .unwrap();
    for command in ["create", "rename", "remove"] {
        exec(&g,"CREATE TRIGGER fail_act_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'act receipt fault'); END");
        let before = state(&g);
        let apply = || match command {
            "create" => store.create_act_before_chapter(&c, "retry-act", "chapter-a"),
            "rename" => store.rename_act(&c, "retry-act", "重试命名"),
            _ => store.remove_act(&c, "retry-act"),
        };
        assert!(apply().unwrap_err().contains("act receipt fault"));
        assert_eq!(state(&g), before);
        exec(&g, "DROP TRIGGER fail_act_receipt");
        apply().unwrap();
    }
    let before = state(&g);
    let mut wrong = c.clone();
    wrong.project_sync_id = "wrong-sync".into();
    assert!(store.rename_act(&wrong, "existing-act", "bad").is_err());
    assert!(store.remove_act(&wrong, "existing-act").is_err());
    assert!(store
        .create_act_before_chapter(&c, "duplicate-coordinate", "chapter-b")
        .unwrap_err()
        .contains("already exists"));
    assert!(store
        .create_act_before_chapter(&c, "foreign-chapter-act", "foreign-chapter")
        .is_err());
    assert!(store
        .create_act_before_chapter(&c, "retry-act", "chapter-a")
        .is_err());
    assert!(store.remove_act(&c, "retry-act").is_err());
    assert!(store.rename_act(&c, "existing-act", " \n").is_err());
    assert_eq!(state(&g), before);
    assert_eq!(rows(&g,"SELECT count(*) FROM sync_mutation WHERE action='entity.purge' AND target_kind='book-act'"),vec![vec![integer(1)]]);
}
