use super::*;
use crate::original_operation::{verify_original_operation, OriginalOperationRef};
use base64::{engine::general_purpose::STANDARD, Engine};

#[test]
fn archive_generic_envelope_layer_does_not_claim_standalone_deletion_intent() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/original-operation.json")).unwrap();
    for name in [
        "missing intent",
        "intent kind",
        "intent version",
        "state transfer",
        "missing evidence",
    ] {
        let case = fixture["negatives"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap();
        let bytes = STANDARD.decode(case["envelope"].as_str().unwrap()).unwrap();
        let reference: OriginalOperationRef =
            serde_json::from_value(case["expected"].clone()).unwrap();
        let generic = verify_change_set(&bytes, &ChangeSetRef::from(&reference)).unwrap();
        assert!(!generic.mutations().is_empty());
        assert!(verify_original_operation(&bytes, &reference).is_err());
    }
}

use serde_json::Value;
const CLIENT: &str = "synthetic-original-body-reader";
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/original-body-archive.json"
    ))
    .unwrap()
}
fn decoded(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().unwrap()).unwrap()
}
fn scope(f: &Value) -> ArchiveScope {
    let s = &f["scope"];
    ArchiveScope {
        project_id: s["projectId"].as_str().unwrap().into(),
        project_sync_id: s["projectSyncId"].as_str().unwrap().into(),
        sync_generation_id: s["syncGenerationId"].as_str().unwrap().into(),
        document_id: s["documentId"].as_str().unwrap().into(),
        incarnation: s["incarnation"].as_u64().unwrap(),
    }
}
fn references(f: &Value) -> Vec<ChangeSetRef> {
    serde_json::from_value(f["requiredOriginals"].clone()).unwrap()
}

fn v(s: &str) -> V {
    V::Text(s.into())
}
fn n(value: u64) -> V {
    V::Integer(value.to_string())
}
fn execute(gateway: &DatabaseGateway, sql: &str, tx: Option<u64>) {
    gateway
        .execute(sql.into(), vec![], tx, CLIENT.into())
        .unwrap();
}
fn database(f: &Value) -> (tempfile::TempDir, DatabaseGateway, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let gateway = DatabaseGateway::new(dir.path().into()).unwrap();
    let opened = gateway
        .open("original-bodies.db".into(), CLIENT.into(), false)
        .unwrap();
    let s = scope(f);
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    let exec = |sql: &str, values: Vec<V>| {
        gateway
            .execute(sql.into(), values, Some(tx), CLIENT.into())
            .unwrap()
    };
    exec("INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES (?1,'Synthetic','local-user','now','now')",vec![v(&s.project_id)]);
    exec("INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES (?1,?2,?3,'now','now')",vec![v(&s.sync_generation_id),v(&s.project_id),v(&s.project_sync_id)]);
    for item in f["originalOperations"].as_array().unwrap() {
        let reference: ChangeSetRef = serde_json::from_value(item["reference"].clone()).unwrap();
        let header = &item["header"];
        let mutations = item["mutations"].as_array().unwrap();
        exec("INSERT INTO sync_change_set(change_set_id,sync_generation_id,project_id,project_sync_id,writer_id,writer_epoch,device_seq,hlc_wall_ms,hlc_counter,protocol_version,payload_version,mutation_count,encoded_bytes,payload_sha256,origin,apply_state,created_at,applied_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,1,?10,?11,?12,'remote','applied','now','now')",vec![
            v(&reference.change_set_id),v(&reference.sync_generation_id),v(&reference.project_id),v(&reference.project_sync_id),v(header["writerId"].as_str().unwrap()),v(header["writerEpoch"].as_str().unwrap()),n(header["deviceSeq"].as_u64().unwrap()),n(header["hlc"]["wallMs"].as_u64().unwrap()),n(header["hlc"]["counter"].as_u64().unwrap()),n(mutations.len() as u64),V::Blob(decoded(&item["envelopeBase64"])),v(&reference.original_envelope_sha256)]);
        for m in mutations {
            let target = &m["target"];
            exec("INSERT INTO sync_mutation(change_set_id,mutation_index,target_family,target_kind,target_id,incarnation,action,payload_version,payload_cbor,payload_sha256) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",vec![
                v(&reference.change_set_id),n(m["index"].as_u64().unwrap()),v(target["family"].as_str().unwrap()),v(target["kind"].as_str().unwrap()),v(target["id"].as_str().unwrap()),n(target["incarnation"].as_u64().unwrap()),v(m["action"].as_str().unwrap()),n(m["payloadVersion"].as_u64().unwrap()),V::Blob(decoded(&m["canonicalPayloadBase64"])),v(m["payloadSha256"].as_str().unwrap().strip_prefix("sha256:").unwrap())]);
        }
        exec("INSERT INTO sync_apply_receipt(change_set_id,sync_generation_id,mutation_count,applied_at) VALUES (?1,?2,?3,'now')",vec![v(&reference.change_set_id),v(&reference.sync_generation_id),n(mutations.len() as u64)]);
    }
    gateway.commit(tx, CLIENT.into()).unwrap();
    (dir, gateway, std::path::PathBuf::from(opened.path))
}
fn state(gateway: &DatabaseGateway, tx: Option<u64>) -> String {
    let tables = [
        "project",
        "sync_generation",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
    ];
    let rows = tables.map(|table| {
        gateway
            .query(
                format!("SELECT * FROM {table} ORDER BY rowid"),
                vec![],
                tx,
                CLIENT.into(),
            )
            .unwrap()
    });
    serde_json::to_string(&rows).unwrap()
}
fn assert_archive(archive: &VerifiedBodyArchive, f: &Value) {
    assert_eq!(archive.scope(), &scope(f));
    let expected = f["targetUpdateBase64"]
        .as_array()
        .unwrap()
        .iter()
        .map(decoded)
        .collect::<Vec<_>>();
    assert_eq!(
        archive
            .bodies()
            .iter()
            .map(|b| b.update().to_vec())
            .collect::<Vec<_>>(),
        expected
    );
    for body in archive.bodies() {
        let item = f["originalOperations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["reference"]["changeSetId"].as_str() == Some(&body.source().change_set_id))
            .unwrap();
        let m = &item["mutations"][body.source().mutation_index as usize];
        assert_eq!(
            body.source().original_envelope_sha256,
            item["reference"]["originalEnvelopeSha256"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            body.source().payload_sha256,
            m["payloadSha256"].as_str().unwrap()
        );
        assert_eq!(
            body.source().target,
            serde_json::from_value(m["target"].clone()).unwrap()
        );
    }
}
#[test]
fn archive_collects_real_seed_insert_delete_originals_and_reopens_without_intent_for_bodies() {
    let f = fixture();
    let (dir, gateway, _) = database(&f);
    let before = state(&gateway, None);
    let result = OriginalBodyArchiveStore::new(&gateway, CLIENT)
        .load_original_bodies(&scope(&f), &references(&f))
        .unwrap();
    assert_archive(&result, &f);
    assert_eq!(state(&gateway, None), before);
    for item in f["originalOperations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["name"] == "seed" || r["name"] == "insert")
    {
        let reference: ChangeSetRef = serde_json::from_value(item["reference"].clone()).unwrap();
        let generic = verify_change_set(&decoded(&item["envelopeBase64"]), &reference).unwrap();
        let selected = generic
            .mutations()
            .iter()
            .find(|m| m.action() == "yjs.update")
            .unwrap();
        let request = OriginalOperationRef {
            project_id: reference.project_id,
            project_sync_id: reference.project_sync_id,
            sync_generation_id: reference.sync_generation_id,
            change_set_id: reference.change_set_id,
            original_envelope_sha256: reference.original_envelope_sha256,
            mutation_index: selected.index(),
            target: selected.target().clone(),
            payload_sha256: selected.payload_sha256().into(),
        };
        assert!(verify_original_operation(&decoded(&item["envelopeBase64"]), &request).is_err());
    }
    gateway.close(CLIENT.into()).unwrap();
    drop(gateway);
    let cold = DatabaseGateway::new(dir.path().into()).unwrap();
    cold.open("original-bodies.db".into(), CLIENT.into(), false)
        .unwrap();
    assert_archive(
        &OriginalBodyArchiveStore::new(&cold, CLIENT)
            .load_original_bodies(&scope(&f), &references(&f))
            .unwrap(),
        &f,
    );
}
#[test]
fn archive_canonical_discovery_rejects_hidden_target_and_unselected_row_tampering() {
    let f = fixture();
    let (_dir, gateway, _) = database(&f);
    execute(
        &gateway,
        "DROP TRIGGER trg_sync_mutation_immutable_update",
        None,
    );
    for sql in [
        "UPDATE sync_mutation SET target_id='hidden-document' WHERE target_family='yjs'",
        "UPDATE sync_mutation SET target_id='forged-companion' WHERE target_family='entity'",
        "UPDATE sync_mutation SET payload_cbor=x'a0' WHERE target_family='yjs'",
    ] {
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        execute(&gateway, sql, Some(tx));
        let before = state(&gateway, Some(tx));
        assert!(
            OriginalBodyArchiveStore::new(&gateway, CLIENT)
                .load_original_bodies_in_transaction(&scope(&f), &references(&f), tx)
                .is_err(),
            "{sql}"
        );
        assert_eq!(state(&gateway, Some(tx)), before);
        gateway.rollback(tx, CLIENT.into()).unwrap();
    }
    // A fabricated reverse index entry cannot add an unrelated canonical body.
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    gateway.execute("UPDATE sync_mutation SET target_id=?1 WHERE change_set_id=(SELECT change_set_id FROM sync_change_set WHERE device_seq=4)".into(), vec![v(&scope(&f).document_id)], Some(tx), CLIENT.into()).unwrap();
    let before = state(&gateway, Some(tx));
    assert_archive(
        &OriginalBodyArchiveStore::new(&gateway, CLIENT)
            .load_original_bodies_in_transaction(&scope(&f), &references(&f), tx)
            .unwrap(),
        &f,
    );
    assert_eq!(state(&gateway, Some(tx)), before);
    gateway.rollback(tx, CLIENT.into()).unwrap();
    assert_archive(
        &OriginalBodyArchiveStore::new(&gateway, CLIENT)
            .load_original_bodies(&scope(&f), &references(&f))
            .unwrap(),
        &f,
    );
}
#[test]
fn archive_requires_applied_receipt_original_bytes_scope_and_known_references() {
    let f = fixture();
    let (_dir, gateway, _) = database(&f);
    execute(
        &gateway,
        "DROP TRIGGER trg_sync_apply_receipt_no_delete",
        None,
    );
    execute(
        &gateway,
        "DROP TRIGGER trg_sync_change_set_immutable_fields",
        None,
    );
    for sql in [
        "DELETE FROM sync_apply_receipt",
        "UPDATE sync_change_set SET apply_state='quarantined'",
        "UPDATE sync_change_set SET encoded_bytes=x''",
        "UPDATE sync_change_set SET project_id='moved-out-of-scope'",
    ] {
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        execute(&gateway, sql, Some(tx));
        let before = state(&gateway, Some(tx));
        assert!(
            OriginalBodyArchiveStore::new(&gateway, CLIENT)
                .load_original_bodies_in_transaction(&scope(&f), &references(&f), tx)
                .is_err(),
            "{sql}"
        );
        assert_eq!(state(&gateway, Some(tx)), before);
        gateway.rollback(tx, CLIENT.into()).unwrap();
    }
    let store = OriginalBodyArchiveStore::new(&gateway, CLIENT);
    let mut required = references(&f);
    required[0].change_set_id = "missing:epoch:1".into();
    assert!(store
        .load_original_bodies(&scope(&f), &required)
        .unwrap_err()
        .contains("missing"));
    let mut wrong = scope(&f);
    wrong.project_id.push_str("-wrong");
    assert!(store.load_original_bodies(&wrong, &[]).is_err());
    let mut wrong = scope(&f);
    wrong.document_id.push_str("-wrong");
    assert!(store.load_original_bodies(&wrong, &[]).is_err());
    let mut wrong = scope(&f);
    wrong.incarnation += 1;
    assert!(store.load_original_bodies(&wrong, &[]).is_err());
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    gateway.rollback(tx, CLIENT.into()).unwrap();
    assert_archive(
        &store
            .load_original_bodies(&scope(&f), &references(&f))
            .unwrap(),
        &f,
    );
}
#[test]
fn archive_reads_one_wal_snapshot_across_original_and_all_materialized_rows() {
    let f = fixture();
    let (_dir, gateway, path) = database(&f);
    let connection = rusqlite::Connection::open(path).unwrap();
    let store = OriginalBodyArchiveStore::new(&gateway, CLIENT);
    let tx = gateway
        .begin(TransactionBehavior::Deferred, CLIENT.into())
        .unwrap();
    let archive = store
        .load_with_hook(&scope(&f), &references(&f), tx, || {
            connection
                .execute("UPDATE sync_change_set SET apply_state='quarantined'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert_archive(&archive, &f);
    gateway.commit(tx, CLIENT.into()).unwrap();
    assert!(store
        .load_original_bodies(&scope(&f), &references(&f))
        .is_err());
}
#[test]
fn archive_bounds_reads_before_copy_and_leaves_caller_transaction_intact() {
    let f = fixture();
    let (_dir, gateway, _) = database(&f);
    let store = OriginalBodyArchiveStore::new(&gateway, CLIENT);
    execute(
        &gateway,
        "DROP TRIGGER trg_sync_change_set_immutable_fields",
        None,
    );
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    execute(
        &gateway,
        &format!(
            "UPDATE sync_change_set SET encoded_bytes=zeroblob({}) WHERE device_seq=1",
            MAX_ORIGINAL_ENVELOPE_BYTES + 1
        ),
        Some(tx),
    );
    assert!(store
        .load_original_bodies_in_transaction(&scope(&f), &references(&f), tx)
        .unwrap_err()
        .contains("budget"));
    gateway.rollback(tx, CLIENT.into()).unwrap();
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    execute(&gateway, "WITH RECURSIVE seq(value) AS (VALUES(5) UNION ALL SELECT value+1 FROM seq WHERE value<4097) INSERT INTO sync_change_set(change_set_id,sync_generation_id,project_id,project_sync_id,writer_id,writer_epoch,device_seq,hlc_wall_ms,hlc_counter,protocol_version,payload_version,mutation_count,encoded_bytes,payload_sha256,origin,apply_state,created_at,applied_at) SELECT writer_id||':'||writer_epoch||':'||seq.value,sync_generation_id,project_id,project_sync_id,writer_id,writer_epoch,seq.value,hlc_wall_ms,hlc_counter,protocol_version,payload_version,mutation_count,encoded_bytes,payload_sha256,origin,apply_state,created_at,applied_at FROM sync_change_set JOIN seq WHERE device_seq=1", Some(tx));
    assert!(store
        .load_original_bodies_in_transaction(&scope(&f), &references(&f), tx)
        .unwrap_err()
        .contains("budget"));
    gateway.rollback(tx, CLIENT.into()).unwrap();
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    execute(
        &gateway,
        "UPDATE project SET name='Caller uncommitted text'",
        Some(tx),
    );
    let before = state(&gateway, Some(tx));
    assert_archive(
        &store
            .load_original_bodies_in_transaction(&scope(&f), &references(&f), tx)
            .unwrap(),
        &f,
    );
    assert_eq!(state(&gateway, Some(tx)), before);
    gateway.rollback(tx, CLIENT.into()).unwrap();
}
