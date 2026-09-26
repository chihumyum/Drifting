//! Synthetic exact Yjs events exercise the optional native encoding seam; this
//! test does not certify a production command classifier or deletion authority.
use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_core::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use drifting_core::original_body_archive::{ArchiveScope, OriginalBodyArchiveStore};
use drifting_core::original_operation::{
    DeclaredTextDelete, MutationTarget, OriginalOperationRef, SourceRange,
};
use drifting_core::original_operation_store::OriginalOperationStore;
use drifting_core::prose::RevisionSource;
use drifting_core::prose_journal::{
    AuthoredProseCommit, AuthoredProseContext, AuthoredProseJournal, ProseSourceOperationEvidence,
};
use serde_json::{json, Value};
const CLIENT: &str = "synthetic-native-journal";
const DOC: &str = "node-content:native-journal-body";
fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/native-journal-evidence.json")).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    STANDARD.decode(v.as_str().unwrap()).unwrap()
}
fn evidence(case: &Value) -> ProseSourceOperationEvidence {
    let i = &case["intent"];
    ProseSourceOperationEvidence {
        before_snapshot: bytes(&case["beforeSnapshot"]),
        transaction_deletes: serde_json::from_value(case["transactionDeletes"].clone()).unwrap(),
        intent: DeclaredTextDelete {
            target_text: serde_json::from_value(i["targetText"].clone()).unwrap(),
            offset_utf16: i["offsetUTF16"].as_u64().unwrap(),
            length_utf16: i["lengthUTF16"].as_u64().unwrap(),
            selected_source_ranges: serde_json::from_value(i["selectedSourceRanges"].clone())
                .unwrap(),
        },
    }
}
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "native-journal-project".into(),
        project_sync_id: "native-journal-project-sync".into(),
        sync_generation_id: "native-journal-generation".into(),
        installation_id: "synthetic-installation".into(),
        new_writer_id: "native-journal-writer".into(),
        new_writer_epoch: "native-journal-epoch".into(),
        now_ms: 42,
        now_iso: "2026-09-26T00:00:00.000Z".into(),
    }
}
fn reference(commit: &AuthoredProseCommit) -> OriginalOperationRef {
    let c = context();
    OriginalOperationRef {
        project_id: c.project_id,
        project_sync_id: c.project_sync_id,
        sync_generation_id: c.sync_generation_id,
        change_set_id: commit.encoded.change_set_id.clone(),
        mutation_index: 0,
        target: MutationTarget {
            family: "yjs".into(),
            kind: "prose-document".into(),
            id: DOC.into(),
            incarnation: 0,
        },
        payload_sha256: format!("sha256:{}", commit.encoded.payload_sha256),
        original_envelope_sha256: commit.encoded.encoded_sha256.clone(),
    }
}
fn scope() -> ArchiveScope {
    let c = context();
    ArchiveScope {
        project_id: c.project_id,
        project_sync_id: c.project_sync_id,
        sync_generation_id: c.sync_generation_id,
        document_id: DOC.into(),
        incarnation: 0,
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    db: DatabaseGateway,
    seeds: usize,
}
impl Fixture {
    fn new(case: &Value) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseGateway::new(dir.path().into()).unwrap();
        db.open("native-journal.db".into(), CLIENT.into(), false)
            .unwrap();
        for sql in ["INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('native-journal-project','Synthetic','local','now','now')","INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('native-journal-body','Synthetic','native-journal-project',0,0,'now','now')","INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES ('native-journal-generation','native-journal-project','native-journal-project-sync','now','now')"]{db.execute(sql.into(),vec![],None,CLIENT.into()).unwrap();}
        let journal = AuthoredProseJournal::new(&db, CLIENT);
        for update in case["seedUpdates"].as_array().unwrap() {
            journal
                .append(
                    &context(),
                    DOC,
                    &bytes(update),
                    &RevisionSource::User,
                    None,
                    None,
                    |_, _| Ok(()),
                )
                .unwrap();
        }
        Self {
            dir,
            db,
            seeds: case["seedUpdates"].as_array().unwrap().len(),
        }
    }
    fn rows(&self, sql: &str, tx: Option<u64>) -> Vec<Vec<V>> {
        self.db
            .query(sql.into(), vec![], tx, CLIENT.into())
            .unwrap()
            .rows
    }
    fn state(&self, tx: Option<u64>) -> Value {
        let mut output = serde_json::Map::new();
        for table in [
            "project",
            "sync_generation_writer_state",
            "sync_change_set",
            "sync_mutation",
            "sync_apply_receipt",
            "yjs_updates",
            "yjs_document_revision",
            "yjs_document_revision_provenance",
            "workspace_projection_clock",
            "sqlite_sequence",
        ] {
            output.insert(
                table.into(),
                serde_json::to_value(
                    self.rows(&format!("SELECT * FROM {table} ORDER BY rowid"), tx),
                )
                .unwrap(),
            );
        }
        Value::Object(output)
    }
    fn append(
        &self,
        case: &Value,
        e: &ProseSourceOperationEvidence,
    ) -> Result<AuthoredProseCommit, String> {
        AuthoredProseJournal::new(&self.db, CLIENT).append_with_source_operation(
            &context(),
            DOC,
            &bytes(&case["update"]),
            e,
            &RevisionSource::User,
            Some(self.seeds as u64),
            None,
            |_, _| Ok(()),
        )
    }
}
#[test]
fn native_journal_optional_evidence_roundtrips_file_original_and_archive_and_exports_real_wire() {
    let all = fixtures();
    let mut outputs = vec![];
    for case in all["cases"].as_array().unwrap() {
        let f = Fixture::new(case);
        let e = evidence(case);
        let commit = f.append(case, &e).unwrap();
        assert_eq!(commit.device_seq, f.seeds as u64 + 1);
        let r = reference(&commit);
        let store = OriginalOperationStore::new(&f.db, CLIENT);
        let original = store.load_verified(&r).unwrap();
        assert_eq!(original.exact_update(), bytes(&case["update"]));
        assert_eq!(original.before_snapshot(), e.before_snapshot);
        assert_eq!(original.intent(), &e.intent);
        let archive = OriginalBodyArchiveStore::new(&f.db, CLIENT)
            .load_original_bodies(&scope(), &[])
            .unwrap();
        assert_eq!(archive.bodies().len(), f.seeds + 1);
        assert!(archive
            .bodies()
            .iter()
            .any(|b| b.source() == &r && b.update() == original.exact_update()));
        let snapshot = f.state(None);
        f.db.close(CLIENT.into()).unwrap();
        let fresh = DatabaseGateway::new(f.dir.path().into()).unwrap();
        fresh
            .open("native-journal.db".into(), CLIENT.into(), false)
            .unwrap();
        let reread = OriginalOperationStore::new(&fresh, CLIENT)
            .load_verified(&r)
            .unwrap();
        assert_eq!(reread.intent(), &e.intent);
        assert_eq!(
            OriginalBodyArchiveStore::new(&fresh, CLIENT)
                .load_original_bodies(&scope(), &[])
                .unwrap()
                .bodies()
                .len(),
            f.seeds + 1
        );
        fresh.close(CLIENT.into()).unwrap();
        outputs.push(json!({"name":case["name"],"originalEnvelope":STANDARD.encode(&commit.encoded.encoded_bytes),"payloadCbor":STANDARD.encode(&commit.encoded.payload_cbor),"reference":r,"input":case,"sqliteRevision":commit.revision,"durableTables":snapshot.as_object().unwrap().keys().collect::<Vec<_>>() }));
    }
    if let Some(output) = std::env::var_os("NATIVE_JOURNAL_WIRE_OUTPUT") {
        std::fs::write(
            output,
            serde_json::to_vec_pretty(&json!({"schemaVersion":1,"cases":outputs})).unwrap(),
        )
        .unwrap();
    }
}
#[test]
fn native_journal_rejects_exact_event_and_schema_mismatches_without_advancing_writer_or_revision() {
    let all = fixtures();
    let case = &all["cases"][2];
    let f = Fixture::new(case);
    let base = evidence(case);
    let raw = bytes(&case["update"]);
    let before = f.state(None);
    let mut bad: Vec<(&str, Vec<u8>, ProseSourceOperationEvidence)> = vec![];
    let mut tail = raw.clone();
    tail.push(0);
    bad.push(("trailing event bytes", tail, base.clone()));
    bad.push((
        "state transfer structs",
        bytes(&case["afterState"]),
        base.clone(),
    ));
    bad.push((
        "insertion structs",
        bytes(&case["seedUpdates"][0]),
        base.clone(),
    ));
    bad.push((
        "unrelated delete event",
        bytes(&all["cases"][0]["update"]),
        base.clone(),
    ));
    for (label, mut e) in [
        ("wrong declared DS", base.clone()),
        ("unsorted ranges", base.clone()),
        ("overlap", base.clone()),
        ("zero range length", base.clone()),
        ("range overflow", base.clone()),
        ("target client precision", base.clone()),
        ("target clock overflow", base.clone()),
        ("offset precision", base.clone()),
        ("zero selection", base.clone()),
        ("selection sum mismatch", base.clone()),
        ("truncated snapshot", base.clone()),
        ("snapshot tail", base.clone()),
    ] {
        match label {
            "wrong declared DS" => e.transaction_deletes[0].clock += 1,
            "unsorted ranges" => {
                e.transaction_deletes.reverse();
                e.intent.selected_source_ranges.reverse();
            }
            "overlap" => {
                e.transaction_deletes.push(e.transaction_deletes[0].clone());
                e.intent.selected_source_ranges = e.transaction_deletes.clone();
                e.intent.length_utf16 += 1;
            }
            "zero range length" => {
                e.transaction_deletes[0].length = 0;
                e.intent.selected_source_ranges = e.transaction_deletes.clone();
            }
            "range overflow" => {
                e.transaction_deletes[0].clock = u32::MAX;
                e.intent.selected_source_ranges = e.transaction_deletes.clone();
            }
            "target client precision" => e.intent.target_text.client = 9_007_199_254_740_992,
            "target clock overflow" => e.intent.target_text.clock = u32::MAX,
            "offset precision" => e.intent.offset_utf16 = 9_007_199_254_740_991,
            "zero selection" => e.intent.length_utf16 = 0,
            "selection sum mismatch" => e.intent.length_utf16 += 1,
            "truncated snapshot" => e.before_snapshot = vec![0],
            "snapshot tail" => e.before_snapshot.push(0),
            _ => unreachable!(),
        };
        bad.push((label, raw.clone(), e));
    }
    assert_eq!(bad.len(), 16);
    for (label, update, e) in bad {
        let result = AuthoredProseJournal::new(&f.db, CLIENT).append_with_source_operation(
            &context(),
            DOC,
            &update,
            &e,
            &RevisionSource::User,
            None,
            None,
            |_, _| Ok(()),
        );
        assert!(result.is_err(), "{label}");
        assert_eq!(f.state(None), before, "{label}");
    }
    assert_eq!(
        f.append(case, &base).unwrap().device_seq,
        f.seeds as u64 + 1
    );
}
#[test]
fn native_journal_nested_evidence_rejection_and_receipt_failure_rollback_preserve_outer_work() {
    let all = fixtures();
    let case = &all["cases"][0];
    let f = Fixture::new(case);
    let e = evidence(case);
    let tx =
        f.db.begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
    f.db.execute(
        "UPDATE project SET name='outer'".into(),
        vec![],
        Some(tx),
        CLIENT.into(),
    )
    .unwrap();
    let before = f.state(Some(tx));
    let mut bad = bytes(&case["update"]);
    bad.push(0);
    let result = AuthoredProseJournal::new(&f.db, CLIENT).append_with_source_operation(
        &context(),
        DOC,
        &bad,
        &e,
        &RevisionSource::User,
        None,
        Some(tx),
        |_, tx| {
            f.db.execute(
                "UPDATE project SET name='inner'".into(),
                vec![],
                Some(tx),
                CLIENT.into(),
            )?;
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(f.state(Some(tx)), before);
    f.db.commit(tx, CLIENT.into()).unwrap();
    f.db.execute("CREATE TRIGGER fail_synthetic_native_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END".into(),vec![],None,CLIENT.into()).unwrap();
    let before = f.state(None);
    assert!(f.append(case, &e).unwrap_err().contains("receipt failure"));
    assert_eq!(f.state(None), before);
    f.db.execute(
        "DROP TRIGGER fail_synthetic_native_receipt".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap();
    assert_eq!(f.append(case, &e).unwrap().device_seq, 2);
}
#[test]
fn native_journal_limits_optional_evidence_before_large_encoding_and_keeps_default_append_unchanged(
) {
    let all = fixtures();
    let case = &all["cases"][0];
    let f = Fixture::new(case);
    let base = evidence(case);
    let before = f.state(None);
    let mut huge = base.clone();
    huge.before_snapshot = vec![0; 1024 * 1024 + 1];
    assert!(f.append(case, &huge).unwrap_err().contains("limits"));
    let mut huge = base.clone();
    huge.transaction_deletes = vec![
        SourceRange {
            client: 1,
            clock: 0,
            length: 1
        };
        100001
    ];
    assert!(f.append(case, &huge).unwrap_err().contains("limits"));
    let mut huge = base.clone();
    huge.intent.selected_source_ranges = vec![
        SourceRange {
            client: 1,
            clock: 0,
            length: 1
        };
        100001
    ];
    assert!(f.append(case, &huge).unwrap_err().contains("limits"));
    assert_eq!(f.state(None), before);
    // The legacy append path continues to accept its previous opaque update bytes
    // and to emit exactly the old one-key payload; existing golden fixtures also run.
    let legacy = AuthoredProseJournal::new(&f.db, CLIENT)
        .append(
            &context(),
            DOC,
            &[1, 2, 3],
            &RevisionSource::User,
            None,
            None,
            |_, _| Ok(()),
        )
        .unwrap();
    assert_eq!(
        legacy.encoded.payload_cbor,
        vec![0xa1, 0x66, b'u', b'p', b'd', b'a', b't', b'e', 0x43, 1, 2, 3]
    );
    assert_eq!(legacy.device_seq, 2);
}
