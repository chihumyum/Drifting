use super::*;
use drifting_core::original_operation::ChangeSetRef;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";

#[derive(Clone)]
struct Original {
    reference: ChangeSetRef,
    bytes: Vec<u8>,
}

fn reopen_workspace(fixture: &mut Fixture) {
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
}

fn pair() -> (Fixture, Fixture) {
    let mut first = Fixture::new();
    first.close();
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join(CLIENT);
    std::fs::create_dir_all(&directory).unwrap();
    // A common accepted project baseline, copied only after its gateway closes
    // and checkpoints WAL. Each reopened replica gets its own installation.
    std::fs::copy(first.directory.join(FILE), directory.join(FILE)).unwrap();
    let mut second = Fixture {
        _temporary: temporary,
        directory,
        workspace: 0,
        project: first.project.clone(),
        chapters: first.chapters.clone(),
    };
    reopen_workspace(&mut first);
    reopen_workspace(&mut second);
    (first, second)
}

fn originals(db: &DatabaseGateway, project: &str) -> Vec<Original> {
    // Test discovery of already-authored prose originals, not a transport
    // cursor that could skip unsupported metadata while advancing a frontier.
    db.query("SELECT c.project_id,c.project_sync_id,c.sync_generation_id,c.change_set_id,c.payload_sha256,c.encoded_bytes FROM sync_change_set c WHERE c.project_id=? AND c.origin='local' AND NOT EXISTS (SELECT 1 FROM sync_mutation m WHERE m.change_set_id=c.change_set_id AND m.action!='yjs.update') ORDER BY c.rowid".into(),
        vec![DatabaseValue::Text(project.into())], None, CLIENT.into()).unwrap().rows.iter().map(|row| {
            let text = |i| match &row[i] { DatabaseValue::Text(v) => v.clone(), _ => panic!("text") };
            let DatabaseValue::Blob(bytes) = &row[5] else { panic!("original bytes") };
            Original { reference: ChangeSetRef { project_id:text(0), project_sync_id:text(1),
                sync_generation_id:text(2), change_set_id:text(3), original_envelope_sha256:text(4) }, bytes:bytes.clone() }
        }).collect()
}

fn receive(fixture: &Fixture, original: &Original) -> Value {
    success(receive_request(fixture, original))
}
fn receive_request(fixture: &Fixture, original: &Original) -> Value {
    json!({"operation":"workspaceReceiveProse","handle":fixture.workspace,
        "original":original.reference,"envelope":STANDARD.encode(&original.bytes)})
}
fn handle(fixture: &Fixture, index: usize) -> u64 {
    fixture.open(index)["handle"].as_u64().unwrap()
}
fn prose(handle: u64) -> String {
    state(handle)["projection"]["text"].as_str().unwrap().into()
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_yjs_materialization_receipt",
        "sync_generation_writer_state",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "node_content",
    ]
    .into_iter()
    .map(|table| {
        (
            table.into(),
            db.query(
                format!("SELECT * FROM {table} ORDER BY rowid"),
                vec![],
                None,
                CLIENT.into(),
            )
            .unwrap()
            .rows,
        )
    })
    .collect()
}
fn durable_counts(db: &DatabaseGateway) -> Value {
    json!(db.query("SELECT (SELECT count(*) FROM sync_change_set),(SELECT count(*) FROM sync_mutation),(SELECT count(*) FROM sync_apply_receipt),(SELECT count(*) FROM sync_yjs_materialization_receipt),(SELECT sum(revision) FROM yjs_document_revision),(SELECT count(*) FROM yjs_document_revision_provenance)".into(), vec![], None, CLIENT.into()).unwrap().rows)
}
fn context(handle: u64) -> AuthoredProseContext {
    SESSIONS.get().unwrap().lock().unwrap()[&handle]
        .authored_context()
        .unwrap()
}
fn receive_without_notification(
    db: &DatabaseGateway,
    context: &AuthoredProseContext,
    original: &Original,
) {
    let receipt = drifting_prose::remote_sync::receive_remote_prose(
        db,
        CLIENT,
        context,
        &original.reference,
        &original.bytes,
        None,
    )
    .unwrap();
    assert!(!receipt.already_applied);
}

#[test]
fn workspace_remote_prose_offline_replicas_converge_all_open_chapters_with_local_history() {
    let (first, second) = pair();
    let a = [handle(&first, 0), handle(&first, 1)];
    let b = [handle(&second, 0), handle(&second, 1)];
    insert(a[0], "甲🙂 ");
    insert(a[1], "港口 ");
    insert(b[0], "乙🪶 ");
    insert(b[1], "海湾 ");
    let outbound_a = originals(&gateway(a[0]), &first.project);
    let outbound_b = originals(&gateway(b[0]), &second.project);
    assert_eq!(outbound_a.len(), 2);
    assert_eq!(outbound_b.len(), 2);
    for original in &outbound_a {
        let received = receive(&second, original);
        assert_eq!(received["alreadyApplied"], false);
        assert_eq!(received["documents"].as_array().unwrap().len(), 2);
        assert!(received["documents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["document"]["saved"] == true));
    }
    for original in &outbound_b {
        receive(&first, original);
    }
    for i in 0..2 {
        assert_eq!(prose(a[i]), prose(b[i]));
    }
    assert!(prose(a[0]).contains("甲🙂 ") && prose(a[0]).contains("乙🪶 "));
    assert!(prose(a[1]).contains("港口 ") && prose(a[1]).contains("海湾 "));
    success(json!({"operation":"documentUndo","handle":a[0]}));
    assert_eq!(prose(a[0]), "乙🪶 ");
    success(json!({"operation":"documentUndo","handle":b[1]}));
    assert_eq!(prose(b[1]), "港口 ");
    first.close();
    second.close();
}

#[test]
fn workspace_remote_prose_duplicate_survives_prune_and_cold_reopen() {
    let (first, mut second) = pair();
    let a = handle(&first, 0);
    let mut b = handle(&second, 0);
    insert(a, "独立副本 e\u{301}🙂");
    let original = originals(&gateway(a), &first.project).remove(0);
    export_oracle(&second, &original);
    let received = receive(&second, &original);
    assert_eq!(received["alreadyApplied"], false);
    assert_eq!(prose(b), prose(a));
    let before = durable_counts(&gateway(b));
    assert!(ProseRepository::new(&gateway(b), CLIENT)
        .list_updates(&format!("node-content:{}", second.chapters[0]), None, None)
        .unwrap()
        .is_empty());
    for _ in 0..2 {
        assert_eq!(receive(&second, &original)["alreadyApplied"], true);
        assert_eq!(durable_counts(&gateway(b)), before);
    }
    second.close();
    reopen_workspace(&mut second);
    b = handle(&second, 0);
    assert_eq!(receive(&second, &original)["alreadyApplied"], true);
    assert_eq!(prose(b), prose(a));
    assert_eq!(durable_counts(&gateway(b)), before);
    assert_eq!(state(b)["projection"]["canUndo"], false);
    first.close();
    second.close();
}

#[test]
fn workspace_remote_prose_lost_notification_replays_all_owners_after_local_interleave() {
    let (first, second) = pair();
    let a = [handle(&first, 0), handle(&first, 1)];
    let b = [handle(&second, 0), handle(&second, 1)];
    insert(a[0], "远端🙂 ");
    insert(a[1], "另章到达");
    let outbound = originals(&gateway(a[0]), &first.project);
    let db = gateway(b[0]);
    receive_without_notification(&db, &context(b[0]), &outbound[0]);
    assert!(
        prose(b[0]).is_empty(),
        "COMMIT alone must not pretend the display was notified"
    );
    insert(b[0], "本地 ");
    assert!(prose(b[0]).contains("远端🙂 ") && prose(b[0]).contains("本地 "));
    receive_without_notification(&db, &context(b[1]), &outbound[1]);
    assert!(prose(b[1]).is_empty());
    let before = durable_counts(&db);
    // Repeating chapter A's receipt must also repair missed chapter B delivery.
    assert_eq!(receive(&second, &outbound[0])["alreadyApplied"], true);
    assert_eq!(prose(b[1]), "另章到达");
    assert_eq!(durable_counts(&db), before);
    success(json!({"operation":"documentUndo","handle":b[0]}));
    assert_eq!(prose(b[0]), "远端🙂 ");
    first.close();
    second.close();
}

#[test]
fn workspace_remote_prose_rejected_original_and_receipt_failure_preserve_owner_and_draft() {
    let (first, second) = pair();
    let a = handle(&first, 0);
    let b = handle(&second, 0);
    insert(a, "远端文字");
    insert(b, "本地文字");
    let original = originals(&gateway(a), &first.project).remove(0);
    let db = gateway(b);
    let before = state(b);
    let stored = rows(&db);
    success(json!({"operation":"documentBeginDraft","handle":b,"start":{
        "key":"pending-remote-prose","revision":before["projection"]["revision"],"range":{"location":0,"length":0}}}));
    let mut wrong = original.clone();
    wrong.reference.project_sync_id = "wrong-scope".into();
    assert!(!rejected(receive_request(&second, &wrong)).is_empty());
    assert_eq!(state(b), before);
    assert_eq!(rows(&db), stored);
    execute(&db, "CREATE TRIGGER fail_remote_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'remote receipt fault'); END");
    assert!(rejected(receive_request(&second, &original)).contains("remote receipt fault"));
    assert_eq!(state(b), before);
    assert_eq!(rows(&db), stored);
    assert_eq!(
        SESSIONS.get().unwrap().lock().unwrap()[&b]
            .document
            .active_drafts(),
        1
    );
    execute(&db, "DROP TRIGGER fail_remote_receipt");
    success(json!({"operation":"documentCancelDraft","handle":b,"key":"pending-remote-prose"}));
    assert_eq!(receive(&second, &original)["alreadyApplied"], false);
    success(json!({"operation":"documentUndo","handle":b}));
    assert_eq!(prose(b), "远端文字");
    first.close();
    second.close();
}

fn export_oracle(fixture: &Fixture, original: &Original) {
    let Ok(output) = std::env::var("NATIVE_REMOTE_PROSE_EXPORT_DIR") else {
        return;
    };
    let output = PathBuf::from(output);
    std::fs::create_dir_all(&output).unwrap();
    // The original replica remains untouched. Checkpoint its accepted baseline,
    // then use a separate closed/checked file copy for parity with TypeScript.
    let opened = handle(fixture, 0);
    let source = gateway(opened);
    assert_eq!(
        serde_json::to_value(source.checkpoint(CLIENT.into()).unwrap()).unwrap()["busy"],
        0
    );
    let working = tempfile::tempdir().unwrap();
    std::fs::copy(fixture.directory.join(FILE), working.path().join(FILE)).unwrap();
    let db = DatabaseGateway::new(working.path().to_path_buf()).unwrap();
    db.open(FILE.into(), CLIENT.into(), false).unwrap();
    db.close(CLIENT.into()).unwrap();
    std::fs::copy(working.path().join(FILE), output.join("before.db")).unwrap();
    db.open(FILE.into(), CLIENT.into(), false).unwrap();
    let context = AuthoredProseContext {
        project_id: original.reference.project_id.clone(),
        project_sync_id: original.reference.project_sync_id.clone(),
        sync_generation_id: original.reference.sync_generation_id.clone(),
        installation_id: "remote-prose-oracle".into(),
        new_writer_id: "remote-prose-oracle".into(),
        new_writer_epoch: "epoch-1".into(),
        now_ms: 1_790_380_800_000,
        now_iso: "2026-09-26T00:00:00.000Z".into(),
    };
    let mut deliveries = Vec::new();
    for expected in [false, true] {
        let receipt = drifting_prose::remote_sync::receive_remote_prose(
            &db,
            CLIENT,
            &context,
            &original.reference,
            &original.bytes,
            None,
        )
        .unwrap();
        assert_eq!(receipt.already_applied, expected);
        deliveries.push(json!({"encodedBase64":STANDARD.encode(&original.bytes),
            "clock":{"nowMs":context.now_ms,"nowIso":context.now_iso},
            "identity":{"installationId":context.installation_id,"writerId":context.new_writer_id,"writerEpoch":context.new_writer_epoch},
            "expectedStatus":if expected {"duplicate"} else {"applied"}}));
    }
    db.close(CLIENT.into()).unwrap();
    std::fs::copy(working.path().join(FILE), output.join("after.db")).unwrap();
    let wire = json!({"schemaVersion":1,"cases":[{"name":"authored-unicode-original-and-duplicate",
        "beforeDatabase":"before.db","afterDatabase":"after.db","deliveries":deliveries,
        "documentIds":[format!("node-content:{}",fixture.chapters[0])]}]});
    std::fs::write(
        output.join("remote-prose-wire.json"),
        serde_json::to_vec_pretty(&wire).unwrap(),
    )
    .unwrap();
}
