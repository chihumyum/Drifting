use super::*;
use crate::prose_journal::encoding::{hash, Cbor};
use crate::remote_workspace::RemoteWorkspaceJournal;
use serde_json::json;
const CLIENT: &str = "metadata-tests";
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "project".into(),
        project_sync_id: "project-sync".into(),
        sync_generation_id: "generation".into(),
        installation_id: "receiver-installation".into(),
        new_writer_id: "receiver".into(),
        new_writer_epoch: "epoch".into(),
        now_ms: 1,
        now_iso: "1970-01-01T00:00:00.001Z".into(),
    }
}
fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let db = DatabaseGateway::new(dir.path().into()).unwrap();
    db.open("metadata.db".into(), CLIENT.into(), false).unwrap();
    crate::workspace::WorkspaceStore::new(&db, CLIENT)
        .create_project(
            &context(),
            crate::workspace::CreateProject {
                user_id: "local-user".into(),
                name: "Synthetic".into(),
                default_kv_ids: std::array::from_fn(|i| format!("metadata-fact-{i}")),
            },
        )
        .unwrap();
    (dir, db)
}
fn cbor(value: &Value) -> Cbor<'_> {
    match value {
        Value::Null => Cbor::Null,
        Value::Bool(v) => Cbor::Bool(*v),
        Value::Number(v) => Cbor::Number(v.as_f64().unwrap()),
        Value::String(v) => Cbor::Text(v),
        Value::Array(v) => Cbor::Array(v.iter().map(cbor).collect()),
        Value::Object(v) => Cbor::Map(v.iter().map(|(k, v)| (k.as_str(), cbor(v))).collect()),
    }
}
struct Mutation {
    kind: &'static str,
    id: &'static str,
    action: &'static str,
    payload: Value,
}
fn field(kind: &'static str, field: &str, value: Value) -> Mutation {
    Mutation {
        kind,
        id: if kind == "project" {
            "project"
        } else {
            "chapter"
        },
        action: "field.set",
        payload: json!({"field":field,"value":value}),
    }
}
fn seed() -> Vec<Mutation> {
    vec![
        Mutation {
            kind: "node",
            id: "chapter",
            action: "entity.create",
            payload: json!({"seed":{"title":"Seed","kind":"chapter","bookOrder":5,"summary":"","narrativeOrder":null,"writingStatus":"draft","driftGroupId":null}}),
        },
        Mutation {
            kind: "prose-document",
            id: "node-content:chapter",
            action: "yjs.update",
            payload: Value::Null,
        },
        field("node-storyline-primary", "storylineId", Value::Null),
    ]
}
fn envelope(writer: &str, wall: u64, mutations: &[Mutation]) -> (ChangeSetRef, Vec<u8>) {
    let id = format!("{writer}:epoch:1");
    let payloads: Vec<_> = mutations
        .iter()
        .map(|m| {
            if m.action == "yjs.update" {
                Cbor::Map(vec![("update", Cbor::Bytes(&[0, 0]))]).bytes()
            } else {
                cbor(&m.payload).bytes()
            }
        })
        .collect();
    let hashes: Vec<_> = payloads
        .iter()
        .map(|p| format!("sha256:{}", hash(p)))
        .collect();
    let entries = mutations
        .iter()
        .enumerate()
        .map(|(i, m)| {
            Cbor::Map(vec![
                ("index", Cbor::Uint(i as u64)),
                (
                    "target",
                    Cbor::Map(vec![
                        (
                            "family",
                            Cbor::Text(if m.action == "yjs.update" {
                                "yjs"
                            } else {
                                "entity"
                            }),
                        ),
                        ("kind", Cbor::Text(m.kind)),
                        ("id", Cbor::Text(m.id)),
                        ("incarnation", Cbor::Uint(0)),
                    ]),
                ),
                ("action", Cbor::Text(m.action)),
                ("payloadVersion", Cbor::Uint(1)),
                ("payloadSha256", Cbor::Text(&hashes[i])),
                (
                    "payload",
                    if m.action == "yjs.update" {
                        Cbor::Map(vec![("update", Cbor::Bytes(&[0, 0]))])
                    } else {
                        cbor(&m.payload)
                    },
                ),
            ])
        })
        .collect();
    let bytes = Cbor::Map(vec![
        ("protocol", Cbor::Text("drifting.sync.changeset")),
        ("protocolVersion", Cbor::Uint(1)),
        ("payloadVersion", Cbor::Uint(1)),
        ("projectId", Cbor::Text("project")),
        ("projectSyncId", Cbor::Text("project-sync")),
        ("syncGenerationId", Cbor::Text("generation")),
        ("changeSetId", Cbor::Text(&id)),
        ("writerId", Cbor::Text(writer)),
        ("writerEpoch", Cbor::Text("epoch")),
        ("deviceSeq", Cbor::Uint(1)),
        (
            "hlc",
            Cbor::Map(vec![
                ("wallMs", Cbor::Uint(wall)),
                ("counter", Cbor::Uint(0)),
            ]),
        ),
        ("mutations", Cbor::Array(entries)),
    ])
    .bytes();
    (
        ChangeSetRef {
            project_id: "project".into(),
            project_sync_id: "project-sync".into(),
            sync_generation_id: "generation".into(),
            change_set_id: id,
            original_envelope_sha256: hash(&bytes),
        },
        bytes,
    )
}
fn receive(
    db: &DatabaseGateway,
    writer: &str,
    wall: u64,
    mutations: &[Mutation],
) -> Result<crate::remote_workspace::RemoteWorkspaceCommit, String> {
    let (reference, bytes) = envelope(writer, wall, mutations);
    RemoteWorkspaceJournal::new(db, CLIENT).receive(
        &context(),
        &reference,
        &bytes,
        None,
        |repo, tx, target, bytes| {
            assert_eq!(bytes, [0, 0]);
            // The chapter and cache must exist before the mandatory projector runs.
            assert_eq!(
                db.query(
                    "SELECT title FROM book_node WHERE id='chapter'".into(),
                    vec![],
                    Some(tx),
                    CLIENT.into()
                )?
                .rows
                .len(),
                1
            );
            repo.get_snapshot(&target.id, Some(tx))?;
            Ok(r#"{"type":"doc","content":[]}"#.into())
        },
    )
}
fn rows(db: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn state(db: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "project",
        "book_node",
        "node_content",
        "sync_change_set",
        "sync_mutation",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_apply_receipt",
        "sync_generation_writer_state",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "sync_yjs_materialization_receipt",
    ]
    .iter()
    .map(|table| rows(db, &format!("SELECT * FROM {table} ORDER BY rowid")))
    .collect()
}
#[test]
fn remote_workspace_metadata_late_fields_reproject_verified_winners() {
    let (_dir, db) = database();
    receive(
        &db,
        "late-title",
        300,
        &[field("node", "title", json!("Winner"))],
    )
    .unwrap();
    receive(
        &db,
        "late-order",
        250,
        &[field("node", "bookOrder", json!(2.5))],
    )
    .unwrap();
    assert!(rows(&db, "SELECT * FROM book_node").is_empty());
    receive(&db, "create", 100, &seed()).unwrap();
    assert_eq!(
        rows(&db, "SELECT title,book_order,updated_at FROM book_node"),
        vec![vec![text("Winner"), V::Real(2.5), text(&utc_iso(300))]]
    );
    receive(&db, "loser", 200, &[field("node", "title", json!("Loser"))]).unwrap();
    assert_eq!(
        rows(&db, "SELECT title,book_order,updated_at FROM book_node"),
        vec![vec![text("Winner"), V::Real(2.5), text(&utc_iso(300))]]
    );
    // UTF-8 writer ordering breaks an otherwise equal clock; the original
    // winning title still runs after order, so updatedAt need not be max HLC.
    receive(
        &db,
        "order-z",
        400,
        &[field("node", "bookOrder", json!(8.5))],
    )
    .unwrap();
    receive(
        &db,
        "order-a",
        400,
        &[field("node", "bookOrder", json!(9.5))],
    )
    .unwrap();
    assert_eq!(
        rows(&db, "SELECT title,book_order,updated_at FROM book_node"),
        vec![vec![text("Winner"), V::Real(8.5), text(&utc_iso(300))]]
    );
    let before = state(&db);
    assert!(
        receive(&db, "create", 100, &seed())
            .unwrap()
            .already_applied
    );
    assert_eq!(state(&db), before);
}
#[test]
fn remote_workspace_metadata_rejects_unsupported_and_rolls_back_receipt_failure() {
    let (_dir, db) = database();
    let before = state(&db);
    let mut bad = seed();
    bad.push(field("node", "summary", json!("unsupported")));
    assert!(receive(&db, "bad", 100, &bad).is_err());
    assert_eq!(state(&db), before);
    db.execute("CREATE TRIGGER metadata_fail_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END".into(),vec![],None,CLIENT.into()).unwrap();
    assert!(receive(&db, "create", 100, &seed())
        .unwrap_err()
        .contains("synthetic receipt failure"));
    assert_eq!(state(&db), before);
    db.execute(
        "DROP TRIGGER metadata_fail_receipt".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    receive(&db, "create", 100, &seed()).unwrap();
    db.execute(
        "UPDATE sync_entity_lifecycle SET state='trashed' WHERE entity_kind='node'".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    let blocked = state(&db);
    assert!(receive(&db, "trashed", 200, &[field("node", "title", json!("No"))]).is_err());
    assert_eq!(state(&db), blocked);
    db.execute(
        "UPDATE sync_entity_lifecycle SET state='live' WHERE entity_kind='node'".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    receive(
        &db,
        "rename-project",
        200,
        &[field("project", "name", json!("Renamed"))],
    )
    .unwrap();
    assert_eq!(
        rows(&db, "SELECT name FROM project"),
        vec![vec![text("Renamed")]]
    );
    for lifecycle in ["trashed", "purged"] {
        db.execute(
            "UPDATE sync_entity_lifecycle SET state=? WHERE entity_kind='project'".into(),
            vec![text(lifecycle)],
            None,
            CLIENT.into(),
        )
        .unwrap();
        let blocked = state(&db);
        assert!(receive(
            &db,
            "project-blocked",
            300,
            &[field("node", "title", json!("No"))]
        )
        .is_err());
        assert!(
            receive(&db, "create", 100, &seed()).is_err(),
            "duplicate must also reject {lifecycle} project"
        );
        assert_eq!(state(&db), blocked);
    }
    db.execute(
        "UPDATE sync_entity_lifecycle SET state='live' WHERE entity_kind='project'".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    db.execute(
        "UPDATE sync_generation SET status='staged'".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    let before = state(&db);
    assert!(receive(&db, "retired", 300, &[field("node", "title", json!("No"))]).is_err());
    assert_eq!(state(&db), before);
}
