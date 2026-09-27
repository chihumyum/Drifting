use super::*;
use crate::materialization_admission::MaterializationAdmissionStore;
use crate::original_operation::{ChangeSetRef, OriginalOperationRef};
use crate::original_operation_store::OriginalOperationStore;
use base64::{engine::general_purpose::STANDARD, Engine};

const CLIENT: &str = "synthetic-chapter-trash";
const NOW: &str = "2026-09-26T00:00:00.000Z";
const DOC: &str = "node-content:trash-chapter";
// Actual Yjs 13.6 events: client 440002, one XmlElement paragraph and XmlText,
// stable id trash-synthetic-block. Insert 正文🙂保留, snapshot, then append 尾.
const SEED: &str =
    "AQPC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawA=";
const INSERT: &str = "AQHC7RoDBADC7RoBEOato+aWh/CfmYLkv53nlZkA";
const SNAPSHOT: &str = "AQTC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawQAwu0aARDmraPmlofwn5mC5L+d55WZAA==";
const TAIL: &str = "AQHC7RoJhMLtGggD5bC+AA==";
const FULL: &str = "AQTC7RoABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDC7RoABigAwu0aAAJpZAF3FXRyYXNoLXN5bnRoZXRpYy1ibG9jawQAwu0aARPmraPmlofwn5mC5L+d55WZ5bC+AA==";

fn bytes(value: &str) -> Vec<u8> {
    STANDARD.decode(value).unwrap()
}
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "trash-project".into(),
        project_sync_id: "trash-project-sync".into(),
        sync_generation_id: "trash-generation".into(),
        installation_id: "trash-installation".into(),
        new_writer_id: "trash-writer".into(),
        new_writer_epoch: "trash-epoch".into(),
        now_ms: 100,
        now_iso: NOW.into(),
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
    let gateway = DatabaseGateway::new(dir.path().into()).unwrap();
    gateway
        .open("trash.db".into(), CLIENT.into(), false)
        .unwrap();
    let store = WorkspaceStore::new(&gateway, CLIENT);
    let c = context();
    store
        .create_project(
            &c,
            CreateProject {
                user_id: "local-user".into(),
                name: "回收站测试".into(),
                default_kv_ids: std::array::from_fn(|i| format!("trash-fact-{i}")),
            },
        )
        .unwrap();
    for (id, title, order) in [
        ("trash-chapter", "原章🙂", 2.5),
        ("other-chapter", "保留章", 9.0),
    ] {
        store.create_chapter(&c, CreateChapter {
            id: id.into(), title: title.into(), book_order: Some(order),
            seed: ChapterSeed { update: bytes(SEED), content_json: r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"}}]}"#.into() },
        }).unwrap();
    }
    let journal = AuthoredProseJournal::new(&gateway, CLIENT);
    let first = journal
        .append(
            &c,
            DOC,
            &bytes(INSERT),
            &RevisionSource::User,
            Some(1),
            None,
            |_, _| Ok(()),
        )
        .unwrap();
    let repo = ProseRepository::new(&gateway, CLIENT);
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    repo.snapshot_and_prune(DOC, &bytes(SNAPSHOT), first.update_id, NOW, tx)
        .unwrap();
    gateway.commit(tx, CLIENT.into()).unwrap();
    journal
        .append(
            &c,
            DOC,
            &bytes(TAIL),
            &RevisionSource::User,
            Some(2),
            None,
            |_, _| Ok(()),
        )
        .unwrap();
    exec(&gateway, "UPDATE book_node SET summary='保留简介',narrative_order=7,position_x=12.5,position_y=-4,writing_status='finished' WHERE id='trash-chapter'");
    exec(&gateway, "INSERT INTO comment(id,project_id,target_kind,target_id,target_block_id,anchor_json,body_json,created_at,updated_at) VALUES ('trash-comment','trash-project','node','trash-chapter','trash-synthetic-block','{\"anchor\":\"synthetic-stable\"}','{\"text\":\"保留评论\"}','before','before')");
    (dir, gateway)
}
fn capture(repo: &ProseRepository<'_>, tx: u64, doc: &str) -> Result<ChapterSeed, String> {
    assert_eq!(doc, DOC);
    assert_eq!(
        repo.get_snapshot(doc, Some(tx))?.unwrap().state_blob,
        bytes(SNAPSHOT)
    );
    assert_eq!(
        repo.list_updates(doc, None, Some(tx))?[0].update_blob,
        bytes(TAIL)
    );
    Ok(ChapterSeed { update: bytes(FULL), content_json: r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"trash-synthetic-block"},"content":[{"type":"text","text":"正文🙂保留尾"}]}]}"#.into() })
}
fn state(g: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "book_node",
        "node_content",
        "comment",
        "entity_relation",
        "node_storyline_link",
        "sync_generation_writer_state",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_set_tag",
        "sync_yjs_materialization_receipt",
        "yjs_snapshots",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
    ]
    .iter()
    .map(|table| rows(g, &format!("SELECT * FROM {table}")))
    .collect()
}

#[test]
fn workspace_trash_preserves_body_comments_and_restores_canonical_next_incarnation() {
    let (_dir, g) = database();
    let c = context();
    let store = WorkspaceStore::new(&g, CLIENT);
    let chapter = store.list_chapters(&c.project_id).unwrap()[0].clone();
    let body_before = [
        "node_content",
        "comment",
        "yjs_snapshots",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
    ]
    .map(|table| rows(&g, &format!("SELECT * FROM {table}")));
    store.trash_chapter(&c, &chapter.id).unwrap();
    assert_eq!(store.list_chapters(&c.project_id).unwrap().len(), 1);
    assert_eq!(
        store.list_trashed_chapters(&c.project_id).unwrap()[0].id,
        chapter.id
    );
    assert!(store.chapter_scope(&c.project_id, &chapter.id).is_err());
    assert_eq!(
        body_before,
        [
            "node_content",
            "comment",
            "yjs_snapshots",
            "yjs_updates",
            "yjs_document_revision",
            "yjs_document_revision_provenance"
        ]
        .map(|table| rows(&g, &format!("SELECT * FROM {table}")))
    );
    assert_eq!(
        rows(
            &g,
            "SELECT incarnation,state FROM sync_entity_lifecycle WHERE entity_id='trash-chapter'"
        ),
        vec![vec![integer(0), text("trashed")]]
    );
    g.close(CLIENT.into()).unwrap();
    g.open("trash.db".into(), CLIENT.into(), false).unwrap();
    assert_eq!(store.list_trashed_chapters(&c.project_id).unwrap().len(), 1);
    let restored = store.restore_chapter(&c, &chapter.id, capture).unwrap();
    assert_eq!(restored, chapter);
    assert!(store
        .list_trashed_chapters(&c.project_id)
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .chapter_scope(&c.project_id, &chapter.id)
            .unwrap()
            .incarnation,
        1
    );
    assert_eq!(rows(&g, "SELECT summary,narrative_order,position_x,position_y FROM book_node WHERE id='trash-chapter'"),
        vec![vec![text("保留简介"), integer(7), V::Real(12.5), V::Real(-4.0)]]);
    assert_eq!(rows(&g, "SELECT * FROM node_content"), body_before[0]);
    assert_eq!(rows(&g, "SELECT * FROM comment"), body_before[1]);
    let repo = ProseRepository::new(&g, CLIENT);
    assert_eq!(repo.get_revision(DOC, None).unwrap(), 4);
    let updates = repo.list_updates(DOC, None, None).unwrap();
    assert_eq!(updates[0].update_blob, bytes(TAIL));
    assert_eq!(updates[1].update_blob, bytes(FULL));
    assert_eq!(
        repo.list_revision_provenance(DOC, 3, None).unwrap()[0].source,
        RevisionSource::System
    );
    let original_row = rows(
        &g,
        "SELECT change_set_id,payload_sha256 FROM sync_change_set ORDER BY device_seq DESC LIMIT 1",
    );
    let reference = ChangeSetRef {
        project_id: c.project_id.clone(),
        project_sync_id: c.project_sync_id.clone(),
        sync_generation_id: c.sync_generation_id.clone(),
        change_set_id: string(&original_row[0], 0).unwrap(),
        original_envelope_sha256: string(&original_row[0], 1).unwrap(),
    };
    let tx = g
        .begin(TransactionBehavior::Deferred, CLIENT.into())
        .unwrap();
    let original = OriginalOperationStore::new(&g, CLIENT)
        .load_change_set_in_transaction(&reference, tx)
        .unwrap();
    g.commit(tx, CLIENT.into()).unwrap();
    assert_eq!(
        original
            .mutations()
            .iter()
            .map(|m| m.action())
            .collect::<Vec<_>>(),
        vec!["entity.restore", "tuple.set", "field.set", "yjs.update"]
    );
    assert!(original
        .mutations()
        .iter()
        .all(|m| m.target().incarnation == 1));
    assert_eq!(
        original.mutations()[0].payload_json().unwrap()["seed"],
        json!({
            "title":"原章🙂","summary":"保留简介","bookOrder":2.5,"narrativeOrder":7.0,
        "writingStatus":"finished","kind":"chapter","driftGroupId":null })
    );
    let m = &original.mutations()[3];
    let source = OriginalOperationRef {
        project_id: reference.project_id,
        project_sync_id: reference.project_sync_id,
        sync_generation_id: reference.sync_generation_id,
        change_set_id: reference.change_set_id,
        original_envelope_sha256: reference.original_envelope_sha256,
        mutation_index: 3,
        target: m.target().clone(),
        payload_sha256: m.payload_sha256().into(),
    };
    let admission = MaterializationAdmissionStore::new(&g, CLIENT)
        .load_verified(&source)
        .unwrap();
    assert_eq!(admission.document_revision(), 4);
    assert_eq!(admission.update_row_id(), updates[1].id);
    assert!(admission.matches(&source, &bytes(FULL)));
    let before = state(&g);
    assert!(store
        .restore_chapter(&c, &chapter.id, |_, _, _| panic!(
            "duplicate must not capture"
        ))
        .is_err());
    assert_eq!(state(&g), before);
}

#[test]
fn workspace_trash_and_restore_receipt_failures_rollback_and_retry_once() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    exec(&g, "CREATE TRIGGER fail_trash_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'receipt fault'); END");
    let before = state(&g);
    assert!(store
        .trash_chapter(&c, "trash-chapter")
        .unwrap_err()
        .contains("receipt fault"));
    assert_eq!(state(&g), before);
    exec(&g, "DROP TRIGGER fail_trash_receipt");
    store.trash_chapter(&c, "trash-chapter").unwrap();
    let trashed = state(&g);
    assert!(store
        .restore_chapter(&c, "trash-chapter", |_, _, _| Err("capture refused".into()))
        .unwrap_err()
        .contains("capture refused"));
    assert_eq!(state(&g), trashed);
    exec(&g, "CREATE TRIGGER fail_restore_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'restore receipt fault'); END");
    assert!(store
        .restore_chapter(&c, "trash-chapter", capture)
        .unwrap_err()
        .contains("restore receipt fault"));
    assert_eq!(state(&g), trashed);
    exec(&g, "DROP TRIGGER fail_restore_receipt");
    store.restore_chapter(&c, "trash-chapter", capture).unwrap();
    assert_eq!(
        rows(
            &g,
            "SELECT count(*) FROM sync_mutation WHERE action='entity.restore'"
        ),
        vec![vec![integer(1)]]
    );
    assert_eq!(
        ProseRepository::new(&g, CLIENT)
            .get_revision(DOC, None)
            .unwrap(),
        4
    );
}

#[test]
fn workspace_trash_rejects_wrong_scope_lifecycle_and_associations_without_writes() {
    let (_dir, g) = database();
    let store = WorkspaceStore::new(&g, CLIENT);
    let c = context();
    let before = state(&g);
    let mut wrong = c.clone();
    wrong.project_sync_id = "wrong-project-sync".into();
    assert!(store.trash_chapter(&wrong, "trash-chapter").is_err());
    assert!(store.trash_chapter(&c, "not-this-project").is_err());
    assert!(store
        .restore_chapter(&c, "trash-chapter", |_, _, _| panic!("live cannot restore"))
        .is_err());
    assert_eq!(state(&g), before);
    exec(&g, "INSERT INTO entity_relation(id,project_id,from_kind,from_id,to_kind,to_id,relation_type_id,created_at,updated_at) VALUES ('edge','trash-project','node','trash-chapter','node','other-chapter','system:generic-association:trash-project','now','now')");
    // A relation without a lifecycle cannot be purged, so the trash fails
    // closed, as the renderer's incarnation resolver does.
    let linked = state(&g);
    assert!(store
        .trash_chapter(&c, "trash-chapter")
        .unwrap_err()
        .contains("no lifecycle"));
    assert_eq!(state(&g), linked);
    exec(&g, "DELETE FROM entity_relation WHERE id='edge'");
    store.trash_chapter(&c, "trash-chapter").unwrap();
    let trashed = state(&g);
    assert!(store.trash_chapter(&c, "trash-chapter").is_err());
    assert_eq!(state(&g), trashed);
    exec(
        &g,
        "UPDATE sync_generation SET status='retired',retired_at='now' WHERE sync_generation_id='trash-generation'",
    );
    let retired = state(&g);
    assert!(store
        .restore_chapter(&c, "trash-chapter", |_, _, _| panic!(
            "retired cannot capture"
        ))
        .is_err());
    assert!(store
        .list_trashed_chapters(&c.project_id)
        .unwrap()
        .is_empty());
    assert_eq!(state(&g), retired);
}
