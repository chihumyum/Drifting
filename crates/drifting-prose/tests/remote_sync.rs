//! Real SQLite receiver transactions using synthetic Yjs events and complete
//! canonical originals produced by the renderer's shipped protocol encoder.
use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_core::database::{DatabaseGateway, DatabaseValue as V};
use drifting_core::original_body_archive::ArchiveScope;
use drifting_core::original_operation::ChangeSetRef;
use drifting_core::prose::{ProseRepository, RevisionSource};
use drifting_core::prose_journal::AuthoredProseContext;
use drifting_prose::{remote_sync::receive_remote_prose, DurableDocument};
use serde_json::Value;
use std::collections::BTreeMap;

const CLIENT: &str = "synthetic-remote-sync";
const DOC: &str = "node-content:synthetic-remote-node";
const NOW: &str = "2026-09-26T00:00:00.000Z";

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/remote-sync.json")).unwrap()
}

fn bytes(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().unwrap()).unwrap()
}

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "synthetic-remote-project".into(),
        project_sync_id: "synthetic-remote-project-sync".into(),
        sync_generation_id: "synthetic-remote-generation".into(),
        installation_id: "receiver-installation".into(),
        new_writer_id: "receiver-writer".into(),
        new_writer_epoch: "receiver-epoch".into(),
        now_ms: 200,
        now_iso: NOW.into(),
    }
}

fn scope() -> ArchiveScope {
    let context = context();
    ArchiveScope {
        project_id: context.project_id,
        project_sync_id: context.project_sync_id,
        sync_generation_id: context.sync_generation_id,
        document_id: DOC.into(),
        incarnation: 0,
    }
}

fn database(data: &Value) -> (tempfile::TempDir, DatabaseGateway) {
    let directory = tempfile::tempdir().unwrap();
    let gateway = DatabaseGateway::new(directory.path().into()).unwrap();
    gateway
        .open("remote-sync.db".into(), CLIENT.into(), false)
        .unwrap();
    for sql in [
        "INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('synthetic-remote-project','Remote test','local-user','now','now')",
        "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('synthetic-remote-node','Remote prose','synthetic-remote-project',0,0,'now','now')",
        "INSERT INTO node_content(node_id,content_json,created_at,updated_at) VALUES ('synthetic-remote-node','{}','now','now')",
        "INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES ('synthetic-remote-generation','synthetic-remote-project','synthetic-remote-project-sync','now','now')",
    ] {
        gateway.execute(sql.into(), vec![], None, CLIENT.into()).unwrap();
    }
    let repository = ProseRepository::new(&gateway, CLIENT);
    repository
        .save_snapshot(DOC, &bytes(&data["snapshotBase64"]), NOW, None)
        .unwrap();
    repository
        .append_update(
            DOC,
            &bytes(&data["tailBase64"]),
            &RevisionSource::Remote,
            NOW,
            None,
            None,
        )
        .unwrap();
    (directory, gateway)
}

fn tables(gateway: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<V>>> {
    gateway
        .query(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows
        .into_iter()
        .map(|row| {
            let V::Text(name) = &row[0] else {
                panic!("table name")
            };
            let mut rows = gateway
                .query(
                    format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")),
                    vec![],
                    None,
                    CLIENT.into(),
                )
                .unwrap()
                .rows;
            rows.sort_by_key(|row| serde_json::to_string(row).unwrap());
            (name.clone(), rows)
        })
        .collect()
}

fn receive(
    gateway: &DatabaseGateway,
    case: &Value,
) -> Result<drifting_core::remote_prose::RemoteProseCommit, String> {
    let expected: ChangeSetRef = serde_json::from_value(case["reference"].clone()).unwrap();
    receive_remote_prose(
        gateway,
        CLIENT,
        &context(),
        &expected,
        &bytes(&case["envelopeBase64"]),
        None,
    )
}

#[test]
fn remote_sync_accumulates_real_snapshot_tail_and_same_document_mutations() {
    let data = fixture();
    let (_directory, gateway) = database(&data);
    let mut live = DurableDocument::open_with_scope(gateway.clone(), CLIENT, scope()).unwrap();
    let before_live = live.native_projection().unwrap();
    assert_eq!(before_live.text, data["beforeText"].as_str().unwrap());
    let case = &data["cases"][0];
    let receipt = receive(&gateway, case).unwrap();
    assert!(!receipt.already_applied);
    assert_eq!(receipt.affected_documents, vec![DOC]);
    assert_eq!(
        live.native_projection().unwrap().text,
        before_live.text,
        "receiving must not publish into an existing live owner"
    );
    assert_eq!(
        live.native_projection().unwrap().revision,
        before_live.revision
    );
    let repository = ProseRepository::new(&gateway, CLIENT);
    assert_eq!(
        repository
            .get_snapshot(DOC, None)
            .unwrap()
            .unwrap()
            .state_blob,
        bytes(&data["snapshotBase64"])
    );
    assert_eq!(
        repository
            .list_updates(DOC, None, None)
            .unwrap()
            .iter()
            .map(|row| row.update_blob.clone())
            .collect::<Vec<_>>(),
        vec![
            bytes(&data["tailBase64"]),
            bytes(&case["updatesBase64"][0]),
            bytes(&case["updatesBase64"][1])
        ]
    );
    assert_eq!(repository.get_revision(DOC, None).unwrap(), 3);
    let stored = tables(&gateway);
    assert_eq!(stored["sync_mutation"].len(), 2);
    assert_eq!(stored["sync_yjs_materialization_receipt"].len(), 2);
    assert_eq!(stored["sync_apply_receipt"].len(), 1);
    let duplicate = receive(&gateway, case).unwrap();
    assert!(duplicate.already_applied);
    assert_eq!(duplicate.affected_documents, receipt.affected_documents);
    assert_eq!(
        tables(&gateway),
        stored,
        "duplicate receipt must perform no writes"
    );
    live.replay().unwrap();
    assert_eq!(
        live.native_projection().unwrap().text,
        data["afterText"].as_str().unwrap()
    );
    let cache = gateway
        .query(
            "SELECT content_json FROM node_content WHERE node_id='synthetic-remote-node'".into(),
            vec![],
            None,
            CLIENT.into(),
        )
        .unwrap();
    let V::Text(cache) = &cache.rows[0][0] else {
        panic!("cache")
    };
    assert_eq!(
        serde_json::from_str::<Value>(cache).unwrap(),
        live.semantic().unwrap()
    );
    assert!(
        !live.undo(),
        "remote receiving/replay must not author local undo"
    );
}

#[test]
fn remote_sync_rejects_invalid_second_mutation_without_writes() {
    let data = fixture();
    for (case, expected_error) in data["cases"].as_array().unwrap()[1..].iter().zip([
        "trailing bytes",
        "unresolved dependencies",
        "Embedded XML text",
    ]) {
        let (_directory, gateway) = database(&data);
        let before = tables(&gateway);
        let error = receive(&gateway, case).unwrap_err();
        assert!(error.contains(expected_error), "{}: {error}", case["name"]);
        assert_eq!(
            tables(&gateway),
            before,
            "{} escaped full envelope rollback",
            case["name"]
        );
        let cold = DurableDocument::open_with_scope(gateway.clone(), CLIENT, scope()).unwrap();
        assert_eq!(
            cold.native_projection().unwrap().text,
            data["beforeText"].as_str().unwrap()
        );
    }
}
