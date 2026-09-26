use super::*;
use crate::database::{DatabaseValue as V, TransactionBehavior};
use crate::prose::RevisionSource;
use crate::prose_journal::AuthoredProseJournal;
use crate::remote_workspace::utc_iso;
fn text(value: &str) -> V {
    V::Text(value.into())
}
fn integer(value: u64) -> V {
    V::Integer(value.to_string())
}
use crate::prose_journal::encoding::{hash, Cbor};
use std::collections::BTreeMap;

const CLIENT: &str = "synthetic-remote-prose";
const DOC: &str = "node-content:remote-node";
const EMPTY_DOCUMENT: &str = r#"{"type":"doc","content":[]}"#;

fn context(writer: &str) -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "remote-project".into(),
        project_sync_id: "remote-project-sync".into(),
        sync_generation_id: "remote-generation".into(),
        installation_id: format!("installation-{writer}"),
        new_writer_id: writer.into(),
        new_writer_epoch: "epoch".into(),
        now_ms: 100,
        now_iso: "1970-01-01T00:00:00.100Z".into(),
    }
}

fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let directory = tempfile::tempdir().unwrap();
    let db = DatabaseGateway::new(directory.path().into()).unwrap();
    db.open("remote.db".into(), CLIENT.into(), false).unwrap();
    for sql in [
        "INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('remote-project','Synthetic','local-user','now','now')",
        "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('remote-node','Synthetic','remote-project',0,0,'now','now'),('second-node','Second','remote-project',0,0,'now','now')",
        "INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES ('remote-generation','remote-project','remote-project-sync','now','now')",
    ] { execute(&db, sql, None); }
    (directory, db)
}
fn execute(db: &DatabaseGateway, sql: &str, tx: Option<u64>) {
    db.execute(sql.into(), vec![], tx, CLIENT.into()).unwrap();
}
fn rows(db: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn tables(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<V>>> {
    rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .into_iter().map(|row| {
            let V::Text(name) = &row[0] else { panic!("table name") };
            let mut data=rows(db,&format!("SELECT * FROM \"{}\"",name.replace('"',"\"\"")));
            data.sort_by_key(|row|serde_json::to_string(row).unwrap());
            (name.clone(),data)
        }).collect()
}
fn reference(context: &AuthoredProseContext, id: String, envelope: &[u8]) -> ChangeSetRef {
    ChangeSetRef {
        project_id: context.project_id.clone(),
        project_sync_id: context.project_sync_id.clone(),
        sync_generation_id: context.sync_generation_id.clone(),
        change_set_id: id,
        original_envelope_sha256: hash(envelope),
    }
}
fn project(
    repo: &ProseRepository<'_>,
    tx: u64,
    target: &MutationTarget,
    update: &[u8],
) -> Result<String, String> {
    // Core intentionally has no CRDT dependency. [0,0] is a valid empty Yjs v1
    // update; this storage projector proves reads use the caller's transaction.
    assert_eq!(update, [0, 0]);
    repo.get_snapshot(&target.id, Some(tx))?;
    repo.list_updates(&target.id, None, Some(tx))?;
    Ok(EMPTY_DOCUMENT.into())
}
fn local(
    db: &DatabaseGateway,
    c: &AuthoredProseContext,
) -> crate::prose_journal::AuthoredProseCommit {
    AuthoredProseJournal::new(db, CLIENT)
        .append(
            c,
            DOC,
            &[0, 0],
            &RevisionSource::User,
            None,
            None,
            |_, _| Ok(()),
        )
        .unwrap()
}

fn envelope(
    mutations: &[(&str, u64, &str)],
    seq: u64,
    wall: u64,
    counter: u64,
) -> (ChangeSetRef, Vec<u8>) {
    use Cbor::*;
    let payloads: Vec<_> = mutations
        .iter()
        .map(|(_, _, action)| {
            if *action == "yjs.update" {
                Map(vec![("update", Bytes(&[0, 0]))])
            } else {
                Map(vec![("field", Text("title")), ("value", Text("Changed"))])
            }
        })
        .collect();
    let hashes: Vec<_> = payloads
        .iter()
        .map(|p| format!("sha256:{}", hash(&p.bytes())))
        .collect();
    let wire = mutations
        .iter()
        .enumerate()
        .map(|(index, (id, incarnation, action))| {
            Map(vec![
                ("index", Uint(index as u64)),
                (
                    "target",
                    Map(vec![
                        (
                            "family",
                            Text(if *action == "yjs.update" {
                                "yjs"
                            } else {
                                "entity"
                            }),
                        ),
                        (
                            "kind",
                            Text(if *action == "yjs.update" {
                                "prose-document"
                            } else {
                                "node"
                            }),
                        ),
                        ("id", Text(id)),
                        ("incarnation", Uint(*incarnation)),
                    ]),
                ),
                ("action", Text(action)),
                ("payloadVersion", Uint(1)),
                (
                    "payload",
                    if *action == "yjs.update" {
                        Map(vec![("update", Bytes(&[0, 0]))])
                    } else {
                        Map(vec![("field", Text("title")), ("value", Text("Changed"))])
                    },
                ),
                ("payloadSha256", Text(&hashes[index])),
            ])
        })
        .collect();
    let id = format!("sender:epoch:{seq}");
    let bytes = Map(vec![
        ("protocol", Text("drifting.sync.changeset")),
        ("protocolVersion", Uint(1)),
        ("payloadVersion", Uint(1)),
        ("projectId", Text("remote-project")),
        ("projectSyncId", Text("remote-project-sync")),
        ("syncGenerationId", Text("remote-generation")),
        ("changeSetId", Text(&id)),
        ("writerId", Text("sender")),
        ("writerEpoch", Text("epoch")),
        ("deviceSeq", Uint(seq)),
        (
            "hlc",
            Map(vec![("wallMs", Uint(wall)), ("counter", Uint(counter))]),
        ),
        ("mutations", Array(wire)),
    ])
    .bytes();
    (reference(&context("receiver"), id, &bytes), bytes)
}

#[test]
fn remote_prose_receives_authored_original_and_deduplicates_after_prune_and_reopen() {
    let (_source_dir, source) = database();
    let authored = local(&source, &context("sender"));
    let expected = reference(
        &context("receiver"),
        authored.encoded.change_set_id.clone(),
        &authored.encoded.encoded_bytes,
    );
    let (dir, db) = database();
    let result = RemoteProseJournal::new(&db, CLIENT)
        .receive(
            &context("receiver"),
            &expected,
            &authored.encoded.encoded_bytes,
            None,
            project,
        )
        .unwrap();
    assert!(!result.already_applied);
    assert_eq!(result.affected_documents, vec![DOC]);
    assert_eq!(
        rows(
            &db,
            "SELECT source_kind FROM yjs_document_revision_provenance"
        ),
        vec![vec![text("remote")]]
    );
    assert_eq!(
        rows(&db, "SELECT content_json,updated_at FROM node_content"),
        vec![vec![text(EMPTY_DOCUMENT), text("1970-01-01T00:00:00.100Z")]]
    );
    let before = tables(&db);
    let duplicate = RemoteProseJournal::new(&db, CLIENT)
        .receive(
            &context("receiver"),
            &expected,
            &authored.encoded.encoded_bytes,
            None,
            |_, _, _, _| panic!("duplicate projector"),
        )
        .unwrap();
    assert!(duplicate.already_applied);
    assert_eq!(duplicate.affected_documents, vec![DOC]);
    assert_eq!(tables(&db), before);
    let tx = db
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    ProseRepository::new(&db, CLIENT)
        .snapshot_and_prune(DOC, &[0, 0], 1, "checkpoint", tx)
        .unwrap();
    db.commit(tx, CLIENT.into()).unwrap();
    let after_prune = tables(&db);
    db.close(CLIENT.into()).unwrap();
    let reopened = DatabaseGateway::new(dir.path().into()).unwrap();
    reopened
        .open("remote.db".into(), CLIENT.into(), false)
        .unwrap();
    assert!(
        RemoteProseJournal::new(&reopened, CLIENT)
            .receive(
                &context("receiver"),
                &expected,
                &authored.encoded.encoded_bytes,
                None,
                |_, _, _, _| panic!("cold duplicate projector")
            )
            .unwrap()
            .already_applied
    );
    assert_eq!(tables(&reopened), after_prune);
}

#[test]
fn remote_prose_multi_mutation_validates_complete_identity_and_current_scope_atomically() {
    let (_dir, db) = database();
    let receiver = RemoteProseJournal::new(&db, CLIENT);
    let (expected, bytes) = envelope(
        &[
            (DOC, 0, "yjs.update"),
            (DOC, 0, "yjs.update"),
            ("node-content:second-node", 0, "yjs.update"),
        ],
        1,
        100,
        0,
    );
    let mut revisions = Vec::new();
    let result = receiver
        .receive(
            &context("receiver"),
            &expected,
            &bytes,
            None,
            |repo, tx, target, update| {
                revisions.push(repo.get_revision(&target.id, Some(tx))?);
                project(repo, tx, target, update)
            },
        )
        .unwrap();
    assert_eq!(revisions, vec![0, 1, 0]);
    assert_eq!(
        result.affected_documents,
        vec![DOC, "node-content:second-node"]
    );
    assert_eq!(rows(&db,"SELECT document_revision FROM sync_yjs_materialization_receipt ORDER BY mutation_index"),vec![vec![integer(1)],vec![integer(2)],vec![integer(1)]]);
    let before = tables(&db);
    for spec in [
        vec![(DOC, 0, "yjs.update"), ("remote-node", 0, "field.set")],
        vec![
            (DOC, 0, "yjs.update"),
            ("node-content:missing", 0, "yjs.update"),
        ],
        vec![(DOC, 1, "yjs.update")],
    ] {
        let (expected, bytes) = envelope(&spec, 2, 100, 0);
        assert!(receiver
            .receive(&context("receiver"), &expected, &bytes, None, project)
            .is_err());
        assert_eq!(tables(&db), before);
    }
    let (collision, other) = envelope(&[(DOC, 0, "yjs.update")], 1, 999, 0);
    assert!(receiver
        .receive(&context("receiver"), &collision, &other, None, project)
        .is_err());
    let mut wrong = expected.clone();
    wrong.project_id = "other-project".into();
    assert!(receiver
        .receive(&context("receiver"), &wrong, &bytes, None, project)
        .is_err());
    assert_eq!(tables(&db), before);
    let (next, bytes) = envelope(&[(DOC, 0, "yjs.update"), (DOC, 0, "yjs.update")], 2, 100, 0);
    let mut calls = 0;
    assert!(receiver
        .receive(
            &context("receiver"),
            &next,
            &bytes,
            None,
            |repo, tx, target, update| {
                calls += 1;
                if calls == 2 {
                    Err("synthetic CRDT validation failure".into())
                } else {
                    project(repo, tx, target, update)
                }
            }
        )
        .unwrap_err()
        .contains("validation failure"));
    assert_eq!(tables(&db), before);
}

#[test]
fn remote_prose_receipt_failure_rolls_back_complete_packet_and_preserves_outer_transaction() {
    for phase in ["admission", "apply"] {
        for nested in [false, true] {
            let (_dir, db) = database();
            let sql = if phase == "admission" {
                "CREATE TRIGGER fail_remote_receipt BEFORE INSERT ON sync_yjs_materialization_receipt WHEN NEW.mutation_index=1 BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END"
            } else {
                "CREATE TRIGGER fail_remote_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END"
            };
            execute(&db, sql, None);
            let (expected, bytes) =
                envelope(&[(DOC, 0, "yjs.update"), (DOC, 0, "yjs.update")], 1, 100, 0);
            let tx = nested.then(|| {
                db.begin(TransactionBehavior::Immediate, CLIENT.into())
                    .unwrap()
            });
            if tx.is_some() {
                execute(&db, "UPDATE project SET name='Outer edit'", tx);
            }
            let error = RemoteProseJournal::new(&db, CLIENT)
                .receive(&context("receiver"), &expected, &bytes, tx, project)
                .unwrap_err();
            assert!(error.contains("synthetic receipt failure"));
            if let Some(tx) = tx {
                db.commit(tx, CLIENT.into()).unwrap();
            }
            for table in [
                "yjs_updates",
                "yjs_document_revision",
                "yjs_document_revision_provenance",
                "sync_change_set",
                "sync_mutation",
                "sync_yjs_materialization_receipt",
                "sync_apply_receipt",
                "sync_generation_writer_state",
                "node_content",
            ] {
                assert!(
                    rows(&db, &format!("SELECT * FROM {table}")).is_empty(),
                    "{table}"
                );
            }
            assert_eq!(
                rows(&db, "SELECT name FROM project"),
                vec![vec![text(if nested { "Outer edit" } else { "Synthetic" })]]
            );
            execute(&db, "DROP TRIGGER fail_remote_receipt", None);
            assert!(
                !RemoteProseJournal::new(&db, CLIENT)
                    .receive(&context("receiver"), &expected, &bytes, None, project)
                    .unwrap()
                    .already_applied
            );
            assert_eq!(
                rows(&db, "SELECT count(*) FROM sync_yjs_materialization_receipt"),
                vec![vec![integer(2)]]
            );
        }
    }
}

#[test]
fn remote_prose_observes_hlc_without_consuming_local_sequence() {
    let (_dir, db) = database();
    let c = context("receiver");
    assert_eq!(local(&db, &c).device_seq, 1);
    let (expected, bytes) = envelope(&[(DOC, 0, "yjs.update")], 1, 500, 7);
    RemoteProseJournal::new(&db, CLIENT)
        .receive(&c, &expected, &bytes, None, project)
        .unwrap();
    assert_eq!(rows(&db,"SELECT next_device_seq,hlc_wall_ms,hlc_counter FROM sync_generation_writer_state WHERE retired_at IS NULL"),vec![vec![integer(2),integer(500),integer(8)]]);
    let authored = local(&db, &c);
    assert_eq!(
        (
            authored.device_seq,
            authored.hlc_wall_ms,
            authored.hlc_counter
        ),
        (2, 500, 9)
    );
    let (expected, bytes) = envelope(&[(DOC, 0, "yjs.update")], 2, 100, 0);
    RemoteProseJournal::new(&db, CLIENT)
        .receive(&c, &expected, &bytes, None, project)
        .unwrap();
    let authored = local(&db, &c);
    assert_eq!(
        (
            authored.device_seq,
            authored.hlc_wall_ms,
            authored.hlc_counter
        ),
        (3, 500, 11)
    );
    assert_eq!(utc_iso(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(utc_iso(951_782_400_001), "2000-02-29T00:00:00.001Z");
    assert_eq!(utc_iso(253_402_300_800_000), "+010000-01-01T00:00:00.000Z");
    assert_eq!(
        utc_iso(8_640_000_000_000_000),
        "+275760-09-13T00:00:00.000Z"
    );
    assert_eq!(utc_iso(9_007_199_254_740_991), "1970-01-01T00:00:00.000Z");
}
