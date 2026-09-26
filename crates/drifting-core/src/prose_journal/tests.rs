use super::*;
use serde_json::Value;

const CLIENT: &str = "synthetic-native-journal";
const DOC: &str = "node-content:synthetic-node";
const NOW: &str = "2026-09-25T00:00:00.000Z";

fn database() -> (tempfile::TempDir, DatabaseGateway) {
    let dir = tempfile::tempdir().unwrap();
    let gateway = DatabaseGateway::new(dir.path().into()).unwrap();
    gateway
        .open("journal.db".into(), CLIENT.into(), false)
        .unwrap();
    for sql in [
        "INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('synthetic-project','Synthetic','local-user','now','now')",
        "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('synthetic-node','Synthetic prose','synthetic-project',0,0,'now','now')",
        "INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES ('synthetic-generation','synthetic-project','synthetic-project-sync','now','now')",
    ] { gateway.execute(sql.into(), vec![], None, CLIENT.into()).unwrap(); }
    (dir, gateway)
}
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "synthetic-project".into(),
        project_sync_id: "synthetic-project-sync".into(),
        sync_generation_id: "synthetic-generation".into(),
        installation_id: "installation-a".into(),
        new_writer_id: "writer-a".into(),
        new_writer_epoch: "epoch-a".into(),
        now_ms: 100,
        now_iso: NOW.into(),
    }
}
fn rows(gateway: &DatabaseGateway, sql: &str) -> Vec<Vec<V>> {
    gateway
        .query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn count(gateway: &DatabaseGateway, table: &str) -> u64 {
    read_uint(
        &rows(gateway, &format!("SELECT count(*) FROM {table}"))[0],
        0,
    )
    .unwrap()
}
fn append(
    journal: &AuthoredProseJournal,
    context: &AuthoredProseContext,
    expected: u64,
) -> Result<AuthoredProseCommit, String> {
    journal.append(
        context,
        DOC,
        &[0, 0],
        &RevisionSource::User,
        Some(expected),
        None,
        |repository, tx| {
            // Synthetic empty v1 update. Actual native Yrs validation lives in the
            // owner; this storage test proves the validator observes the same tx.
            assert_eq!(repository.get_revision(DOC, Some(tx))?, expected);
            Ok(())
        },
    )
}

#[test]
fn prose_journal_receipt_failure_rolls_back_prose_revision_writer_and_complete_journal() {
    let (_dir, gateway) = database();
    let journal = AuthoredProseJournal::new(&gateway, CLIENT);
    gateway.execute("CREATE TRIGGER fail_native_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END".into(), vec![], None, CLIENT.into()).unwrap();
    assert!(append(&journal, &context(), 0)
        .unwrap_err()
        .contains("synthetic receipt failure"));
    for table in [
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "sync_generation_writer_state",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
    ] {
        assert_eq!(count(&gateway, table), 0, "{table} escaped atomic rollback");
    }
    gateway
        .execute(
            "DROP TRIGGER fail_native_receipt".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap();
    let first = append(&journal, &context(), 0).unwrap();
    assert_eq!(
        (
            first.device_seq,
            first.hlc_wall_ms,
            first.hlc_counter,
            first.revision
        ),
        (1, 100, 0, 1)
    );
    assert_eq!(
        rows(
            &gateway,
            "SELECT apply_state,applied_at FROM sync_change_set"
        )[0],
        vec![text("applied"), text(NOW)]
    );
    assert_eq!(count(&gateway, "sync_apply_receipt"), 1);
    let stored = rows(
        &gateway,
        "SELECT payload_cbor,payload_sha256 FROM sync_mutation",
    );
    assert_eq!(
        stored[0],
        vec![
            V::Blob(first.encoded.payload_cbor),
            text(&first.encoded.payload_sha256)
        ]
    );
}

#[test]
fn prose_journal_writer_rotation_and_clock_rollback_match_authored_writer_contract() {
    let (_dir, gateway) = database();
    let journal = AuthoredProseJournal::new(&gateway, CLIENT);
    append(&journal, &context(), 0).unwrap();
    let mut next = context();
    next.now_ms = 99;
    let second = append(&journal, &next, 1).unwrap();
    assert_eq!(
        (second.device_seq, second.hlc_wall_ms, second.hlc_counter),
        (2, 100, 1)
    );
    next.installation_id = "installation-b".into();
    next.new_writer_id = "writer-b".into();
    next.new_writer_epoch = "epoch-b".into();
    let rotated = append(&journal, &next, 2).unwrap();
    assert_eq!(
        (rotated.device_seq, rotated.hlc_wall_ms, rotated.hlc_counter),
        (1, 100, 2)
    );
    assert_eq!(count(&gateway, "sync_generation_writer_state"), 2);
    assert_eq!(
        rows(
            &gateway,
            "SELECT writer_id FROM sync_generation_writer_state WHERE retired_at IS NULL"
        )[0],
        vec![text("writer-b")]
    );
    let failed = journal.append(
        &next,
        DOC,
        &[0, 0],
        &RevisionSource::User,
        Some(1),
        None,
        |_, _| Ok(()),
    );
    assert!(failed.is_err());
    assert_eq!(rows(&gateway,"SELECT next_device_seq,hlc_counter FROM sync_generation_writer_state WHERE retired_at IS NULL")[0],vec![integer(2),integer(2)]);
    assert_eq!(count(&gateway, "yjs_updates"), 3);
}

#[test]
fn prose_journal_nested_failure_retains_outer_work_and_rejects_invalid_owner_generation_and_clock()
{
    let (_dir, gateway) = database();
    let journal = AuthoredProseJournal::new(&gateway, CLIENT);
    let tx = gateway
        .begin(TransactionBehavior::Immediate, CLIENT.into())
        .unwrap();
    gateway
        .execute(
            "UPDATE project SET name='outer change'".into(),
            vec![],
            Some(tx),
            CLIENT.into(),
        )
        .unwrap();
    let failed = journal.append(
        &context(),
        DOC,
        &[0, 0],
        &RevisionSource::User,
        Some(0),
        Some(tx),
        |_, _| {
            gateway.execute(
                "UPDATE project SET name='rolled-back validator change'".into(),
                vec![],
                Some(tx),
                CLIENT.into(),
            )?;
            Err("synthetic CRDT validation failure".into())
        },
    );
    assert!(failed
        .unwrap_err()
        .contains("synthetic CRDT validation failure"));
    gateway.commit(tx, CLIENT.into()).unwrap();
    assert_eq!(
        rows(&gateway, "SELECT name FROM project")[0],
        vec![text("outer change")]
    );
    let mut invalid = context();
    invalid.project_sync_id = "wrong-project-sync".into();
    assert!(append(&journal, &invalid, 0)
        .unwrap_err()
        .contains("identity"));
    assert!(journal
        .append(
            &context(),
            "node-content:missing",
            &[0, 0],
            &RevisionSource::User,
            Some(0),
            None,
            |_, _| Ok(())
        )
        .unwrap_err()
        .contains("owner"));
    let mut invalid = context();
    invalid.now_ms = MAX_SAFE + 1;
    assert!(append(&journal, &invalid, 0).is_err());
    assert_eq!(count(&gateway, "sync_change_set"), 0);
    append(&journal, &context(), 0).unwrap();
    gateway
        .execute(
            "UPDATE sync_generation_writer_state SET next_device_seq=?".into(),
            vec![integer(MAX_SAFE)],
            None,
            CLIENT.into(),
        )
        .unwrap();
    assert!(append(&journal, &context(), 1)
        .unwrap_err()
        .contains("sequence"));
    assert_eq!(count(&gateway, "yjs_updates"), 1);
}

#[test]
fn prose_journal_rejects_utf16_oversized_ids_atomically_and_accepts_unicode_boundary() {
    let (_dir, gateway) = database();
    let journal = AuthoredProseJournal::new(&gateway, CLIENT);
    let oversized = "😀".repeat(128);
    assert_eq!(oversized.chars().count(), 128);
    assert_eq!(oversized.encode_utf16().count(), 256);
    for field in ["project", "project-sync", "generation", "document"] {
        let mut input = context();
        let mut doc_id = DOC.to_string();
        match field {
            "project" => input.project_id = oversized.clone(),
            "project-sync" => input.project_sync_id = oversized.clone(),
            "generation" => input.sync_generation_id = oversized.clone(),
            "document" => doc_id = format!("node-content:{oversized}"),
            _ => unreachable!(),
        }
        let error = journal
            .append(
                &input,
                &doc_id,
                &[0, 0],
                &RevisionSource::User,
                Some(0),
                None,
                |_, _| panic!("invalid {field} reached CRDT validation"),
            )
            .unwrap_err();
        assert!(error.contains("Invalid authored prose journal identity"));
        for table in [
            "yjs_updates",
            "yjs_document_revision",
            "yjs_document_revision_provenance",
            "sync_generation_writer_state",
            "sync_change_set",
            "sync_mutation",
            "sync_apply_receipt",
        ] {
            assert_eq!(count(&gateway, table), 0, "{field} mutated {table}");
        }
    }

    // The 13 ASCII prefix units plus 121 surrogate pairs are exactly 255.
    let owner_id = "😀".repeat(121);
    let doc_id = format!("node-content:{owner_id}");
    assert_eq!(doc_id.encode_utf16().count(), 255);
    gateway.execute(
        "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES (?,'Unicode prose','synthetic-project',0,0,'now','now')".into(),
        vec![text(&owner_id)],
        None,
        CLIENT.into(),
    ).unwrap();
    let committed = journal
        .append(
            &context(),
            &doc_id,
            &[0, 0],
            &RevisionSource::User,
            Some(0),
            None,
            |_, _| Ok(()),
        )
        .unwrap();
    assert_eq!((committed.device_seq, committed.revision), (1, 1));
    assert_eq!(count(&gateway, "sync_apply_receipt"), 1);
    assert_eq!(
        rows(&gateway, "SELECT document_id FROM yjs_updates")[0],
        vec![text(&doc_id)]
    );
}

#[test]
fn prose_journal_bytes_and_hashes_match_actual_typescript_encoder() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/apple-native/fixtures/prose-journal-v1.json");
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(path).expect("Run the production prose journal oracle fixture generator"),
    )
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let input = &case["input"];
        let expected = &case["expected"];
        let update: Vec<u8> = serde_json::from_value(input["update"].clone()).unwrap();
        let identity = encoding::ChangeIdentity {
            project_id: input["projectId"].as_str().unwrap(),
            project_sync_id: input["projectSyncId"].as_str().unwrap(),
            sync_generation_id: input["syncGenerationId"].as_str().unwrap(),
            writer_id: input["writerId"].as_str().unwrap(),
            writer_epoch: input["writerEpoch"].as_str().unwrap(),
            device_seq: input["deviceSeq"].as_u64().unwrap(),
            wall_ms: input["hlc"]["wallMs"].as_u64().unwrap(),
            counter: input["hlc"]["counter"].as_u64().unwrap(),
            doc_id: input["docId"].as_str().unwrap(),
            incarnation: input["incarnation"].as_u64().unwrap(),
        };
        let actual = encoding::encode(&identity, &update);
        assert_eq!(
            actual.payload_cbor,
            serde_json::from_value::<Vec<u8>>(expected["payloadCbor"].clone()).unwrap(),
            "{} payload",
            case["name"]
        );
        assert_eq!(
            actual.encoded_bytes,
            serde_json::from_value::<Vec<u8>>(expected["encodedBytes"].clone()).unwrap(),
            "{} change set",
            case["name"]
        );
        assert_eq!(
            format!("sha256:{}", actual.payload_sha256),
            expected["payloadSha256"].as_str().unwrap()
        );
        assert_eq!(
            format!("sha256:{}", actual.encoded_sha256),
            expected["encodedSha256"].as_str().unwrap()
        );
    }
}
