use super::*;
use crate::original_operation::MutationTarget;
use crate::prose::{ProseRepository, RevisionSource};
use crate::prose_journal::{AuthoredProseCommit, AuthoredProseContext, AuthoredProseJournal};
const CLIENT: &str = "synthetic-admission-core";
const DOC: &str = "node-content:synthetic-node";
fn setup() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let db = DatabaseGateway::new(dir.path().into()).unwrap();
    db.open("admission.db".into(), CLIENT.into(), false)
        .unwrap();
    for sql in [
        r#"
        INSERT INTO project (id, name, user_id, created_at, updated_at)
        VALUES ('p', 'Synthetic', 'local', 'now', 'now')
        "#,
        r#"
        INSERT INTO book_node (
            id, title, project_id, position_x, position_y, created_at, updated_at
        )
        VALUES ('synthetic-node', 'Synthetic', 'p', 0, 0, 'now', 'now')
        "#,
        r#"
        INSERT INTO sync_generation (
            sync_generation_id, project_id, project_sync_id, created_at, updated_at
        )
        VALUES ('g', 'p', 'ps', 'now', 'now')
        "#,
    ] {
        db.execute(sql.into(), vec![], None, CLIENT.into()).unwrap();
    }
    (dir, db)
}
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "p".into(),
        project_sync_id: "ps".into(),
        sync_generation_id: "g".into(),
        installation_id: "i".into(),
        new_writer_id: "w".into(),
        new_writer_epoch: "e".into(),
        now_ms: 100,
        now_iso: "now".into(),
    }
}
fn append(db: &DatabaseGateway, revision: u64) -> Result<AuthoredProseCommit, String> {
    AuthoredProseJournal::new(db, CLIENT).append(
        &context(),
        DOC,
        &[0, 0],
        &RevisionSource::User,
        Some(revision),
        None,
        |_, _| Ok(()),
    )
}
fn reference(c: &AuthoredProseCommit) -> OriginalOperationRef {
    OriginalOperationRef {
        project_id: "p".into(),
        project_sync_id: "ps".into(),
        sync_generation_id: "g".into(),
        change_set_id: c.encoded.change_set_id.clone(),
        mutation_index: 0,
        target: MutationTarget {
            family: "yjs".into(),
            kind: "prose-document".into(),
            id: DOC.into(),
            incarnation: 0,
        },
        payload_sha256: format!("sha256:{}", c.encoded.payload_sha256),
        original_envelope_sha256: c.encoded.encoded_sha256.clone(),
    }
}
fn rows(db: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn durable(db: &DatabaseGateway) -> Vec<Vec<Vec<V>>> {
    [
        "yjs_updates",
        "yjs_snapshots",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "sync_generation_writer_state",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_yjs_materialization_receipt",
    ]
    .iter()
    .map(|t| rows(db, &format!("SELECT * FROM {t} ORDER BY rowid")))
    .collect()
}
#[test]
fn materialization_native_journal_records_actual_append_and_survives_prune_cold() {
    let (dir, db) = setup();
    let c = append(&db, 0).unwrap();
    let r = reference(&c);
    let store = MaterializationAdmissionStore::new(&db, CLIENT);
    let proof = store.load_verified(&r).unwrap();
    assert_eq!(proof.update_row_id(), c.update_id);
    assert_eq!(proof.document_revision(), 1);
    assert!(proof.matches(&r, &[0, 0]));
    assert!(!proof.matches(&r, &[0, 1]));
    let tx = db
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    ProseRepository::new(&db, CLIENT)
        .snapshot_and_prune(DOC, &[0, 0], c.update_id, "now", tx)
        .unwrap();
    db.commit(tx, CLIENT.into()).unwrap();
    let cold = DatabaseGateway::new(dir.path().into()).unwrap();
    cold.open("admission.db".into(), CLIENT.into(), false)
        .unwrap();
    assert_eq!(
        MaterializationAdmissionStore::new(&cold, CLIENT)
            .load_verified(&r)
            .unwrap(),
        proof
    );
    assert!(rows(&cold, "SELECT * FROM yjs_updates").is_empty());
}
#[test]
fn materialization_native_admission_failure_rolls_back_writer_revision_and_journal() {
    let (_dir, db) = setup();
    let before = durable(&db);
    db.execute(
        r#"
        CREATE TRIGGER fail_admission
        BEFORE INSERT ON sync_yjs_materialization_receipt
        BEGIN
            SELECT RAISE(ABORT, 'admission failure');
        END
        "#
        .into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    assert!(append(&db, 0).unwrap_err().contains("admission failure"));
    assert_eq!(durable(&db), before);
    db.execute(
        "DROP TRIGGER fail_admission".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    let c = append(&db, 0).unwrap();
    assert_eq!(c.device_seq, 1);
    assert_eq!(c.revision, 1);
    assert_eq!(
        rows(&db, "SELECT count(*) FROM sync_yjs_materialization_receipt"),
        vec![vec![V::Integer("1".into())]]
    );
}
#[test]
fn materialization_reader_refuses_missing_forged_and_mismatched_raw_without_writes() {
    for fault in [
        "missing",
        "hash",
        "version",
        "incarnation",
        "row",
        "revision",
        "raw",
        "raw-type",
        "original-quarantined",
    ] {
        let (_dir, db) = setup();
        let c = append(&db, 0).unwrap();
        let r = reference(&c);
        // Explicitly corrupted copies test the reader in addition to SQL guards.
        db.execute(
            "DROP TRIGGER sync_yjs_materialization_receipt_immutable_update".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap();
        db.execute(
            "DROP TRIGGER sync_yjs_materialization_receipt_immutable_delete".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap();
        db.execute(
            "PRAGMA ignore_check_constraints=ON".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap();
        let sql = match fault {
            "missing" => "DELETE FROM sync_yjs_materialization_receipt",
            "hash" => "UPDATE sync_yjs_materialization_receipt SET event_sha256=printf('%064d',0)",
            "version" => "UPDATE sync_yjs_materialization_receipt SET admission_version=2",
            "incarnation" => "UPDATE sync_yjs_materialization_receipt SET incarnation=1",
            "row" => "UPDATE sync_yjs_materialization_receipt SET update_row_id=0",
            "revision" => "UPDATE sync_yjs_materialization_receipt SET document_revision=0",
            "raw" => "UPDATE yjs_updates SET update_blob=x'0001'",
            "raw-type" => "UPDATE yjs_updates SET update_blob='xx'",
            "original-quarantined" => "UPDATE sync_change_set SET apply_state='quarantined'",
            _ => unreachable!(),
        };
        db.execute(sql.into(), vec![], None, CLIENT.into()).unwrap();
        let before = durable(&db);
        assert!(
            MaterializationAdmissionStore::new(&db, CLIENT)
                .load_verified(&r)
                .is_err(),
            "{fault}"
        );
        assert_eq!(durable(&db), before, "{fault}");
    }
}
#[test]
fn materialization_receipts_are_immutable_and_equal_events_do_not_share_identity() {
    let (_dir, db) = setup();
    let a = append(&db, 0).unwrap();
    let b = append(&db, 1).unwrap();
    let store = MaterializationAdmissionStore::new(&db, CLIENT);
    let pa = store.load_verified(&reference(&a)).unwrap();
    let pb = store.load_verified(&reference(&b)).unwrap();
    assert_eq!(pa.event_sha256(), pb.event_sha256());
    assert_ne!(pa.update_row_id(), pb.update_row_id());
    assert!(!pa.matches(&reference(&b), &[0, 0]));
    let before = durable(&db);
    for sql in [
        "UPDATE sync_yjs_materialization_receipt SET created_at='later'",
        "DELETE FROM sync_yjs_materialization_receipt",
        r#"
        INSERT OR REPLACE INTO sync_yjs_materialization_receipt
        SELECT * FROM sync_yjs_materialization_receipt
        "#,
    ] {
        assert!(db.execute(sql.into(), vec![], None, CLIENT.into()).is_err());
        assert_eq!(durable(&db), before);
    }
}
