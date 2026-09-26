use super::*;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
const CLIENT: &str = "synthetic-original-reader";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureMutation {
    index: u64,
    target: crate::original_operation::MutationTarget,
    action: String,
    payload_version: u64,
    payload_bytes: Vec<u8>,
    payload_sha256: String,
}
#[derive(Deserialize)]
struct Fixture {
    name: String,
    envelope: Vec<u8>,
    reference: OriginalOperationRef,
    header: Value,
    mutations: Vec<FixtureMutation>,
}
fn fixture(name: &str) -> Fixture {
    serde_json::from_str::<Vec<Fixture>>(include_str!("fixtures.json"))
        .unwrap()
        .into_iter()
        .find(|f| f.name == name)
        .unwrap()
}
fn v(value: &str) -> V {
    V::Text(value.into())
}
fn n(value: u64) -> V {
    V::Integer(value.to_string())
}
fn execute(gateway: &DatabaseGateway, sql: &str, tx: Option<u64>) {
    gateway
        .execute(sql.into(), vec![], tx, CLIENT.into())
        .unwrap();
}
// These are synthetic copies only: disabling their write guards models a
// corrupted/imported SQLite image. Ordinary production writers cannot make
// these updates. A separate test inserts a mismatching but correctly rehashed
// materialized row with ALL published guards intact.
fn corruptible_fixture(gateway: &DatabaseGateway) {
    for trigger in [
        "trg_sync_change_set_immutable_fields",
        "trg_sync_mutation_immutable_update",
        "trg_sync_mutation_no_delete",
        "trg_sync_mutation_index_bounds",
    ] {
        execute(gateway, &format!("DROP TRIGGER {trigger}"), None);
    }
}
fn database(f: &Fixture) -> (tempfile::TempDir, DatabaseGateway, PathBuf) {
    database_with_receipt(f, true)
}
fn database_with_receipt(
    f: &Fixture,
    receipt: bool,
) -> (tempfile::TempDir, DatabaseGateway, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let gateway = DatabaseGateway::new(dir.path().into()).unwrap();
    let opened = gateway
        .open("original.db".into(), CLIENT.into(), false)
        .unwrap();
    gateway.execute("INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES (?1,'Synthetic','local-user','now','now')".into(),
        vec![v(&f.reference.project_id)],None,CLIENT.into()).unwrap();
    gateway.execute("INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES (?1,?2,?3,'now','now')".into(),
        vec![v(&f.reference.sync_generation_id),v(&f.reference.project_id),v(&f.reference.project_sync_id)],None,CLIENT.into()).unwrap();
    gateway.execute("INSERT INTO sync_change_set(change_set_id,sync_generation_id,project_id,project_sync_id,writer_id,writer_epoch,device_seq,hlc_wall_ms,hlc_counter,protocol_version,payload_version,mutation_count,encoded_bytes,payload_sha256,origin,apply_state,created_at,applied_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,1,?10,?11,?12,'remote','applied','now','now')".into(),
        vec![v(&f.reference.change_set_id),v(&f.reference.sync_generation_id),v(&f.reference.project_id),v(&f.reference.project_sync_id),
            v(f.header["writerId"].as_str().unwrap()),v(f.header["writerEpoch"].as_str().unwrap()),n(f.header["deviceSeq"].as_u64().unwrap()),
            n(f.header["wallMs"].as_u64().unwrap()),n(f.header["counter"].as_u64().unwrap()),n(f.mutations.len() as u64),V::Blob(f.envelope.clone()),
            v(&f.reference.original_envelope_sha256)],None,CLIENT.into()).unwrap();
    for m in &f.mutations {
        gateway.execute("INSERT INTO sync_mutation(change_set_id,mutation_index,target_family,target_kind,target_id,incarnation,action,payload_version,payload_cbor,payload_sha256) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)".into(),
            vec![v(&f.reference.change_set_id),n(m.index),v(&m.target.family),v(&m.target.kind),v(&m.target.id),n(m.target.incarnation),v(&m.action),n(m.payload_version),V::Blob(m.payload_bytes.clone()),v(&m.payload_sha256)],None,CLIENT.into()).unwrap();
    }
    if receipt {
        gateway.execute("INSERT INTO sync_apply_receipt(change_set_id,sync_generation_id,mutation_count,applied_at) VALUES (?1,?2,?3,'now')".into(),
            vec![v(&f.reference.change_set_id),v(&f.reference.sync_generation_id),n(f.mutations.len() as u64)],None,CLIENT.into()).unwrap();
    }
    (dir, gateway, PathBuf::from(opened.path))
}
fn state(gateway: &DatabaseGateway, tx: Option<u64>) -> String {
    let names = gateway.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name".into(),vec![],tx,CLIENT.into()).unwrap();
    let mut state = Vec::new();
    for row in names.rows {
        let V::Text(name) = &row[0] else {
            panic!("table name");
        };
        let sql = format!(
            "SELECT * FROM \"{}\" ORDER BY rowid",
            name.replace('"', "\"\"")
        );
        state.push((
            name.clone(),
            gateway.query(sql, vec![], tx, CLIENT.into()).unwrap(),
        ));
    }
    serde_json::to_string(&state).unwrap()
}

#[test]
fn original_store_reads_actual_single_and_multi_operation_without_side_effects() {
    for name in ["single", "multiple"] {
        let f = fixture(name);
        let (_dir, gateway, _path) = database(&f);
        let before = state(&gateway, None);
        let result = OriginalOperationStore::new(&gateway, CLIENT)
            .load_verified(&f.reference)
            .unwrap();
        assert_eq!(result.selected().index(), f.reference.mutation_index);
        assert_eq!(result.mutations().len(), f.mutations.len());
        assert_eq!(
            result.selected().canonical_payload_bytes(),
            f.mutations[f.reference.mutation_index as usize].payload_bytes
        );
        assert_eq!(state(&gateway, None), before);
    }
}

#[test]
fn original_store_verifies_unselected_mutation_target_action_payload_and_complete_indices() {
    let f = fixture("multiple");
    let (_dir, gateway, _) = database(&f);
    corruptible_fixture(&gateway);
    let store = OriginalOperationStore::new(&gateway, CLIENT);
    for sql in [
        "UPDATE sync_mutation SET target_family='yjs' WHERE mutation_index=0",
        "UPDATE sync_mutation SET target_kind='chapter' WHERE mutation_index=0",
        "UPDATE sync_mutation SET target_id='rebound-companion' WHERE mutation_index=0",
        "UPDATE sync_mutation SET incarnation=4 WHERE mutation_index=0",
        "UPDATE sync_mutation SET action='entity.trash' WHERE mutation_index=0",
        "UPDATE sync_mutation SET payload_cbor=x'a0' WHERE mutation_index=0",
        "UPDATE sync_mutation SET payload_sha256='0000000000000000000000000000000000000000000000000000000000000000' WHERE mutation_index=0",
        "UPDATE sync_mutation SET payload_cbor=x'a0',payload_sha256='c19a797fa1fd590cd2e5b42d1cf5f246e29b91684e2f87404b81dc345c7a56a0' WHERE mutation_index=0",
        "DELETE FROM sync_mutation WHERE mutation_index=0",
        "UPDATE sync_mutation SET mutation_index=2 WHERE mutation_index=0",
        "INSERT INTO sync_mutation SELECT change_set_id,2,target_family,target_kind,target_id,incarnation,action,payload_version,payload_cbor,payload_sha256 FROM sync_mutation WHERE mutation_index=0",
    ] {
        let tx=gateway.begin(TransactionBehavior::Immediate,CLIENT.into()).unwrap();
        execute(&gateway,sql,Some(tx)); let before=state(&gateway,Some(tx));
        assert!(store.load_verified_in_transaction(&f.reference,tx).is_err(),"{sql}");
        assert_eq!(state(&gateway,Some(tx)),before,"reader changed caller transaction: {sql}");
        gateway.rollback(tx,CLIENT.into()).unwrap();
    }
    store.load_verified(&f.reference).unwrap();
}

#[test]
fn original_store_verifies_envelope_header_and_refuses_unaccepted_originals() {
    let f = fixture("multiple");
    let (_dir, gateway, _) = database(&f);
    corruptible_fixture(&gateway);
    let store = OriginalOperationStore::new(&gateway, CLIENT);
    for sql in [
        "UPDATE sync_change_set SET project_id='other-project'",
        "UPDATE sync_change_set SET writer_id='writer-b'",
        "UPDATE sync_change_set SET writer_epoch='epoch-b'",
        "UPDATE sync_change_set SET device_seq=2",
        "UPDATE sync_change_set SET hlc_wall_ms=0",
        "UPDATE sync_change_set SET hlc_counter=0",
        "UPDATE sync_change_set SET mutation_count=1",
        "UPDATE sync_change_set SET encoded_bytes=x'a0'",
        "UPDATE sync_change_set SET payload_sha256='0000000000000000000000000000000000000000000000000000000000000000'",
        "UPDATE sync_change_set SET apply_state='pending'",
        "UPDATE sync_change_set SET apply_state='applying'",
        "UPDATE sync_change_set SET apply_state='quarantined'",
    ] {
        let tx=gateway.begin(TransactionBehavior::Immediate,CLIENT.into()).unwrap();
        execute(&gateway,sql,Some(tx)); let before=state(&gateway,Some(tx));
        assert!(store.load_verified_in_transaction(&f.reference,tx).is_err(),"{sql}");
        assert_eq!(state(&gateway,Some(tx)),before);
        gateway.rollback(tx,CLIENT.into()).unwrap();
    }
    execute(&gateway, "UPDATE sync_change_set SET origin='local'", None);
    store.load_verified(&f.reference).unwrap();
}

#[test]
fn original_store_wrong_reference_and_missing_original_release_own_read_transaction() {
    let f = fixture("multiple");
    let (_dir, gateway, _) = database(&f);
    let store = OriginalOperationStore::new(&gateway, CLIENT);
    for field in 0..9 {
        let mut r = f.reference.clone();
        match field {
            0 => r.project_id.push_str("-other"),
            1 => r.project_sync_id.push_str("-other"),
            2 => r.sync_generation_id.push_str("-other"),
            3 => r.change_set_id.push_str("-missing"),
            4 => r.mutation_index = 0,
            5 => r.target.id.push_str("-rebound"),
            6 => r.target.incarnation += 1,
            7 => r.payload_sha256 = format!("sha256:{}", "0".repeat(64)),
            _ => r.original_envelope_sha256 = "0".repeat(64),
        }
        assert!(store.load_verified(&r).is_err(), "reference field {field}");
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        gateway.rollback(tx, CLIENT.into()).unwrap();
    }
    store.load_verified(&f.reference).unwrap();
}

#[test]
fn original_store_reads_one_wal_snapshot_while_another_connection_commits() {
    let f = fixture("multiple");
    let (_dir, gateway, path) = database(&f);
    let store = OriginalOperationStore::new(&gateway, CLIENT);
    let tx = gateway
        .begin(TransactionBehavior::Deferred, CLIENT.into())
        .unwrap();
    let concurrent = rusqlite::Connection::open(path).unwrap();
    let result = store
        .load_with_hook(&f.reference, tx, || {
            concurrent
                .execute("UPDATE sync_change_set SET apply_state='quarantined'", [])
                .map_err(|error| error.to_string())?;
            Ok(())
        })
        .unwrap();
    assert_eq!(result.mutations()[0].target().id, f.mutations[0].target.id);
    gateway.commit(tx, CLIENT.into()).unwrap();
    assert!(store.load_verified(&f.reference).is_err());
    let before = state(&gateway, None);
    assert!(store.load_verified(&f.reference).is_err());
    assert_eq!(state(&gateway, None), before);
}

#[test]
fn original_store_refuses_oversize_envelope_and_row_blobs_before_copying_them() {
    let f = fixture("multiple");
    let (_dir, gateway, _) = database(&f);
    corruptible_fixture(&gateway);
    let store = OriginalOperationStore::new(&gateway, CLIENT);
    for sql in [
        format!(
            "UPDATE sync_change_set SET encoded_bytes=zeroblob({})",
            MAX_ORIGINAL_ENVELOPE_BYTES + 1
        ),
        format!(
            "UPDATE sync_mutation SET payload_cbor=zeroblob({}) WHERE mutation_index=0",
            f.envelope.len() + 1
        ),
    ] {
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        execute(&gateway, &sql, Some(tx));
        assert!(store
            .load_verified_in_transaction(&f.reference, tx)
            .is_err());
        gateway.rollback(tx, CLIENT.into()).unwrap();
    }
    store.load_verified(&f.reference).unwrap();
}

#[test]
fn original_store_refuses_rehashed_companion_insert_with_published_guards_intact() {
    use sha2::{Digest, Sha256};
    let mut f = fixture("multiple");
    f.mutations[0].payload_bytes = vec![0xa0];
    f.mutations[0].payload_sha256 = format!("{:x}", Sha256::digest(&f.mutations[0].payload_bytes));
    let (_dir, gateway, _) = database(&f);
    let before = state(&gateway, None);
    assert!(OriginalOperationStore::new(&gateway, CLIENT)
        .load_verified(&f.reference)
        .is_err());
    assert_eq!(state(&gateway, None), before);
    assert!(gateway
        .execute(
            "UPDATE sync_mutation SET target_id='tamper'".into(),
            vec![],
            None,
            CLIENT.into()
        )
        .is_err());
}

#[test]
fn original_store_never_uses_a_foreign_gateway_transaction() {
    let f = fixture("single");
    let (_dir, gateway, _) = database(&f);
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    execute(
        &gateway,
        "UPDATE project SET name='caller uncommitted sentinel'",
        Some(tx),
    );
    let before = state(&gateway, Some(tx));
    assert!(OriginalOperationStore::new(&gateway, "different-client")
        .load_verified_in_transaction(&f.reference, tx)
        .is_err());
    assert_eq!(state(&gateway, Some(tx)), before);
    gateway.rollback(tx, CLIENT.into()).unwrap();
}

#[test]
fn original_store_requires_an_actual_matching_apply_receipt() {
    let f = fixture("single");
    let (_dir, gateway, _) = database_with_receipt(&f, false);
    let store = OriginalOperationStore::new(&gateway, CLIENT);
    let before = state(&gateway, None);
    assert!(store.load_verified(&f.reference).is_err());
    assert_eq!(state(&gateway, None), before);
    // Deliberate corruption of this synthetic copy, outside ordinary writers.
    execute(
        &gateway,
        "DROP TRIGGER trg_sync_apply_receipt_complete_change_set",
        None,
    );
    for (count, at) in [(2, "now"), (1, "")] {
        let tx = gateway
            .begin(TransactionBehavior::Immediate, CLIENT.into())
            .unwrap();
        gateway.execute("INSERT INTO sync_apply_receipt(change_set_id,sync_generation_id,mutation_count,applied_at) VALUES (?1,?2,?3,?4)".into(),
            vec![v(&f.reference.change_set_id),v(&f.reference.sync_generation_id),n(count),v(at)],Some(tx),CLIENT.into()).unwrap();
        let before = state(&gateway, Some(tx));
        assert!(store
            .load_verified_in_transaction(&f.reference, tx)
            .is_err());
        assert_eq!(state(&gateway, Some(tx)), before);
        gateway.rollback(tx, CLIENT.into()).unwrap();
    }
}

#[test]
fn original_store_leaves_callers_work_intact_after_success_and_failure() {
    let f = fixture("single");
    let (_dir, gateway, _) = database(&f);
    let before = state(&gateway, None);
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    execute(
        &gateway,
        "UPDATE project SET name='caller transaction sentinel'",
        Some(tx),
    );
    let during = state(&gateway, Some(tx));
    let store = OriginalOperationStore::new(&gateway, CLIENT);
    store
        .load_verified_in_transaction(&f.reference, tx)
        .unwrap();
    let mut wrong = f.reference.clone();
    wrong.payload_sha256 = format!("sha256:{}", "0".repeat(64));
    assert!(store.load_verified_in_transaction(&wrong, tx).is_err());
    assert_eq!(state(&gateway, Some(tx)), during);
    gateway.rollback(tx, CLIENT.into()).unwrap();
    assert_eq!(state(&gateway, None), before);
}

#[test]
fn original_store_limits_corrupt_text_cells_before_gateway_allocation() {
    let mut f = fixture("multiple");
    f.mutations[0].target.id = "🙂".repeat(100_000);
    let (_dir, gateway, _) = database(&f);
    let before = state(&gateway, None);
    assert!(OriginalOperationStore::new(&gateway, CLIENT)
        .load_verified(&f.reference)
        .is_err());
    assert_eq!(state(&gateway, None), before);
}
