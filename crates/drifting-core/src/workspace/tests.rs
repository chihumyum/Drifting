use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-workspace";
const NOW: &str = "2026-09-26T00:00:00.000Z";
// Synthetic Yjs 13 event: client 440001, default XmlFragment, one empty
// paragraph with stable id. Export is independently decoded by the TS oracle.
const SEED: &[u8] = &[
    1, 3, 193, 237, 26, 0, 7, 1, 7, 100, 101, 102, 97, 117, 108, 116, 3, 9, 112, 97, 114, 97, 103,
    114, 97, 112, 104, 7, 0, 193, 237, 26, 0, 6, 40, 0, 193, 237, 26, 0, 2, 105, 100, 1, 119, 25,
    119, 111, 114, 107, 115, 112, 97, 99, 101, 45, 101, 109, 112, 116, 121, 45, 112, 97, 114, 97,
    103, 114, 97, 112, 104, 0,
];
fn seed() -> ChapterSeed {
    ChapterSeed{update:SEED.to_vec(),content_json:r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"workspace-empty-paragraph"}}]}"#.into()}
}
fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let gateway = DatabaseGateway::new(dir.path().into()).unwrap();
    gateway
        .open("workspace.db".into(), CLIENT.into(), false)
        .unwrap();
    (dir, gateway)
}
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "workspace-project".into(),
        project_sync_id: "workspace-project-sync".into(),
        sync_generation_id: "workspace-generation".into(),
        installation_id: "workspace-installation".into(),
        new_writer_id: "workspace-writer".into(),
        new_writer_epoch: "workspace-epoch".into(),
        now_ms: 100,
        now_iso: NOW.into(),
    }
}
fn project() -> CreateProject {
    CreateProject {
        user_id: "local-user".into(),
        name: "原生写作".into(),
        default_kv_ids: std::array::from_fn(|i| format!("workspace-fact-{i}")),
    }
}
fn chapter(id: &str, title: &str, order: Option<f64>) -> CreateChapter {
    CreateChapter {
        id: id.into(),
        title: title.into(),
        book_order: order,
        seed: seed(),
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
fn count(g: &DatabaseGateway, table: &str) -> u64 {
    match &rows(g, &format!("SELECT count(*) FROM {table}"))[0][0] {
        V::Integer(s) => s.parse().unwrap(),
        _ => panic!("count"),
    }
}
fn journal_state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "sync_generation_writer_state",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_order_register",
        "sync_yjs_materialization_receipt",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
    ]
    .map(|table| rows(g, &format!("SELECT * FROM {table}")))
    .to_vec()
}

#[test]
fn workspace_creates_defaults_and_atomic_canonical_chapter_seed() {
    let (_dir, gateway) = database();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    let c = context();
    let created = store.create_project(&c, project()).unwrap();
    assert_eq!(
        store.list_projects("local-user").unwrap(),
        vec![created.clone()]
    );
    assert!(store.list_projects("other-user").unwrap().is_empty());
    assert_eq!(count(&gateway, "entity_kv_entry"), 6);
    let facts: Vec<Value> = serde_json::from_str(
        &string(&rows(&gateway, "SELECT kv_json FROM project")[0], 0).unwrap(),
    )
    .unwrap();
    assert_eq!(facts, FACTS.map(|key| json!({"key":key,"value":""})));
    assert_eq!(count(&gateway, "storylines"), 0);
    assert_eq!(count(&gateway, "element_category"), 0);
    assert_eq!(count(&gateway, "entity_relation_type_endpoint_kind"), 7);
    assert_eq!(
        rows(
            &gateway,
            "SELECT name,locked,system_key FROM entity_relation_type"
        ),
        vec![vec![
            text("Generic association"),
            integer(1),
            text("generic-association")
        ]]
    );
    assert_eq!(count(&gateway, "sync_entity_lifecycle"), 8);
    assert_eq!(count(&gateway, "sync_field_clock"), 0); // Create seeds are lifecycle authority, not field.set.
    assert_eq!(count(&gateway, "sync_order_register"), 6);
    assert_eq!(
        rows(
            &gateway,
            "SELECT position_key FROM sync_order_register ORDER BY position_key"
        ),
        (0..6)
            .map(|i| vec![text(&format!("a{i}"))])
            .collect::<Vec<_>>()
    );
    let first = store
        .create_chapter(&c, chapter("workspace-chapter-a", "第一章", Some(2.5)))
        .unwrap();
    let second = store
        .create_chapter(&c, chapter("workspace-chapter-b", "第一章", None))
        .unwrap();
    assert_eq!(
        (&first.title, first.book_order),
        (&"第一章".to_string(), 2.5)
    );
    assert_eq!(
        (&second.title, second.book_order),
        (&"第一章 2".to_string(), 7.5)
    );
    assert_eq!(count(&gateway, "sync_change_set"), 3);
    assert_eq!(count(&gateway, "sync_mutation"), 20);
    assert_eq!(
        rows(
            &gateway,
            "SELECT mutation_count,apply_state FROM sync_change_set ORDER BY device_seq"
        ),
        vec![
            vec![integer(14), text("applied")],
            vec![integer(3), text("applied")],
            vec![integer(3), text("applied")]
        ]
    );
    assert_eq!(count(&gateway, "sync_apply_receipt"), 3);
    assert_eq!(count(&gateway, "sync_yjs_materialization_receipt"), 2);
    assert_eq!(
        rows(
            &gateway,
            "SELECT target_kind,field_key FROM sync_field_clock ORDER BY target_id"
        ),
        vec![vec![text("node-storyline-primary"), text("field:storylineId")]; 2]
    );
    assert_eq!(count(&gateway, "node_storyline_link"), 0);
    assert_eq!(rows(&gateway,"SELECT kind,writing_status,narrative_order,drift_group_id,word_count_basis_revision FROM book_node ORDER BY id"),vec![vec![text("chapter"),text("draft"),V::Null,V::Null,integer(1)];2]);
    assert_eq!(
        rows(
            &gateway,
            "SELECT revision,source_kind FROM yjs_document_revision_provenance"
        ),
        vec![vec![integer(1), text("system")]; 2]
    );
    let scope = store.chapter_scope(&c.project_id, &first.id).unwrap();
    assert_eq!(scope.incarnation, 0);
    assert_eq!(scope.document_id, first.document_id);
    let repo = ProseRepository::new(&gateway, CLIENT);
    assert_eq!(
        repo.list_updates(&first.document_id, None, None).unwrap()[0].update_blob,
        SEED
    );
    assert_eq!(repo.get_revision(&first.document_id, None).unwrap(), 1);
    if let Some(directory) = std::env::var_os("NATIVE_WORKSPACE_EXPORT_DIR") {
        let changes = rows(
            &gateway,
            "SELECT encoded_bytes,mutation_count FROM sync_change_set ORDER BY device_seq",
        )
        .into_iter()
        .map(|row| {
            let V::Blob(bytes) = &row[0] else {
                panic!("envelope")
            };
            json!({"encodedBase64":STANDARD.encode(bytes),"mutationCount":number(&row,1).unwrap()})
        })
        .collect::<Vec<_>>();
        let export = json!({"schemaVersion":1,"changes":changes,"project":created,"chapters":[first,second],"seed":{"updateBase64":STANDARD.encode(SEED),"contentJson":seed().content_json}});
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join("workspace-wire.json"),
            serde_json::to_vec_pretty(&export).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn workspace_cold_lists_preserve_fractional_order_and_project_unique_titles() {
    let (dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    let created = store.create_project(&c, project()).unwrap();
    exec(&gateway,"INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('drift','CHAPTER','workspace-project',0,0,'now','now')");
    let a = store
        .create_chapter(&c, chapter("z", " chapter ", Some(0.25)))
        .unwrap();
    let b = store
        .create_chapter(&c, chapter("a", "chapter", Some(0.25)))
        .unwrap();
    let empty = store
        .create_chapter(&c, chapter("c", " \u{feff} ", Some(-0.5)))
        .unwrap();
    assert_eq!(a.title, "chapter 2");
    assert_eq!(b.title, "chapter 3");
    assert_eq!(empty.title, "Untitled");
    gateway.close(CLIENT.into()).unwrap();
    drop(gateway);
    let reopened = DatabaseGateway::new(dir.path().into()).unwrap();
    reopened
        .open("workspace.db".into(), CLIENT.into(), false)
        .unwrap();
    let store = WorkspaceStore::new(&reopened, CLIENT);
    assert_eq!(store.list_projects("local-user").unwrap(), vec![created]);
    assert_eq!(
        store.list_chapters(&c.project_id).unwrap(),
        vec![empty, b, a.clone()]
    );
    assert_eq!(
        store
            .chapter_scope(&c.project_id, &a.id)
            .unwrap()
            .document_id,
        "node-content:z"
    );
    assert!(store.chapter_scope("wrong-project", &a.id).is_err());
    assert_eq!(
        ProseRepository::new(&reopened, CLIENT)
            .list_updates("node-content:z", None, None)
            .unwrap()[0]
            .update_blob,
        SEED
    );
}

#[test]
fn workspace_project_receipt_failure_rolls_back_defaults_generation_and_writer() {
    let (_dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    exec(&gateway,"CREATE TRIGGER workspace_fail BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    assert!(store
        .create_project(&c, project())
        .unwrap_err()
        .contains("synthetic receipt failure"));
    for table in [
        "project",
        "sync_generation",
        "entity_kv_entry",
        "entity_relation_type",
        "entity_relation_type_endpoint_kind",
        "sync_change_set",
        "sync_mutation",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_order_register",
    ] {
        assert_eq!(count(&gateway, table), 0, "{table}");
    }
    exec(&gateway, "DROP TRIGGER workspace_fail");
    store.create_project(&c, project()).unwrap();
    assert_eq!(
        rows(&gateway, "SELECT device_seq FROM sync_change_set"),
        vec![vec![integer(1)]]
    );
}

#[test]
fn workspace_chapter_materialization_failure_retains_prior_journal_and_retries_once() {
    let (_dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    store.create_project(&c, project()).unwrap();
    let before = journal_state(&gateway);
    exec(&gateway,"CREATE TRIGGER workspace_fail BEFORE INSERT ON sync_yjs_materialization_receipt BEGIN SELECT RAISE(ABORT,'synthetic admission failure'); END");
    assert!(store
        .create_chapter(&c, chapter("a", "New Chapter", None))
        .unwrap_err()
        .contains("synthetic admission failure"));
    assert_eq!(journal_state(&gateway), before);
    assert_eq!(count(&gateway, "book_node"), 0);
    assert_eq!(count(&gateway, "node_content"), 0);
    exec(&gateway, "DROP TRIGGER workspace_fail");
    store
        .create_chapter(&c, chapter("a", "New Chapter", None))
        .unwrap();
    assert_eq!(
        rows(
            &gateway,
            "SELECT device_seq FROM sync_change_set ORDER BY device_seq"
        ),
        vec![vec![integer(1)], vec![integer(2)]]
    );
    assert_eq!(count(&gateway, "sync_yjs_materialization_receipt"), 1);
}

#[test]
fn workspace_rejects_wrong_scope_invalid_seed_and_existing_prose_without_writes() {
    let (_dir, gateway) = database();
    let c = context();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    store.create_project(&c, project()).unwrap();
    let before = journal_state(&gateway);
    let mut wrong = c.clone();
    wrong.project_sync_id = "wrong".into();
    assert!(store
        .create_chapter(&wrong, chapter("a", "A", None))
        .is_err());
    let mut invalid = chapter("a", "A", None);
    invalid.seed.content_json = r#"{"type":"doc","content":[]}"#.into();
    assert!(store.create_chapter(&c, invalid).is_err());
    assert!(store
        .create_chapter(&c, chapter("a", "A", Some(f64::NAN)))
        .is_err());
    assert_eq!(journal_state(&gateway), before);
    ProseRepository::new(&gateway, CLIENT)
        .save_snapshot("node-content:a", SEED, NOW, None)
        .unwrap();
    let before_seed_rejection = journal_state(&gateway);
    assert!(store
        .create_chapter(&c, chapter("a", "A", None))
        .unwrap_err()
        .contains("durable prose"));
    assert_eq!(journal_state(&gateway), before_seed_rejection);
    assert_eq!(count(&gateway, "book_node"), 0);
    exec(
        &gateway,
        "UPDATE sync_generation SET status='retired',retired_at='now'",
    );
    assert!(store.create_chapter(&c, chapter("b", "B", None)).is_err());
    assert!(store.list_projects("local-user").unwrap().is_empty());
}
