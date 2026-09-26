//! Real native commands and independent file-backed receivers. The optional
//! export replays the same originals without a live checkpoint, so production
//! TypeScript can compare the receive transaction's exact durable result.
use super::*;
use drifting_core::original_operation::ChangeSetRef;
use std::collections::{BTreeMap, HashSet};

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_workspace_remote_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic workspace remote receipt fault'); END";

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

fn handle(fixture: &Fixture, index: usize) -> u64 {
    fixture.open(index)["handle"].as_u64().unwrap()
}

fn open_id(fixture: &Fixture, id: &str) -> Value {
    success(
        json!({"operation":"workspaceOpenChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":id}),
    )
}

fn create(fixture: &Fixture, title: &str) -> String {
    success(
        json!({"operation":"workspaceCreateChapter","handle":fixture.workspace,
        "projectId":fixture.project,"title":title}),
    )["id"]
        .as_str()
        .unwrap()
        .into()
}

fn rename(fixture: &Fixture, id: &str, title: &str) {
    success(
        json!({"operation":"workspaceRenameChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":id,"title":title}),
    );
}

fn move_before(fixture: &Fixture, id: &str, before: Option<&str>) {
    success(
        json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":id,"beforeChapterId":before}),
    );
}

fn originals(db: &DatabaseGateway, project: &str) -> Vec<Original> {
    // Discover complete local originals by storage order. No mutation/action
    // filter may silently omit metadata from these exported receive packets.
    db.query(
        "SELECT project_id,project_sync_id,sync_generation_id,change_set_id,payload_sha256,encoded_bytes FROM sync_change_set WHERE project_id=? AND origin='local' AND apply_state='applied' ORDER BY rowid".into(),
        vec![text(project)], None, CLIENT.into(),
    ).unwrap().rows.iter().map(|row| {
        let value = |i| match &row[i] { DatabaseValue::Text(value) => value.clone(), _ => panic!("text expected") };
        let DatabaseValue::Blob(bytes) = &row[5] else { panic!("original bytes expected") };
        Original { reference: ChangeSetRef { project_id:value(0),project_sync_id:value(1),
            sync_generation_id:value(2),change_set_id:value(3),original_envelope_sha256:value(4) }, bytes:bytes.clone() }
    }).collect()
}

fn known(db: &DatabaseGateway, project: &str) -> HashSet<String> {
    originals(db, project)
        .into_iter()
        .map(|original| original.reference.change_set_id)
        .collect()
}

fn since(db: &DatabaseGateway, project: &str, known: &HashSet<String>) -> Vec<Original> {
    originals(db, project)
        .into_iter()
        .filter(|original| !known.contains(&original.reference.change_set_id))
        .collect()
}

fn request(fixture: &Fixture, original: &Original) -> Value {
    json!({"operation":"workspaceReceiveChanges","handle":fixture.workspace,
        "original":original.reference,"envelope":STANDARD.encode(&original.bytes)})
}

fn receive(fixture: &Fixture, original: &Original) -> Value {
    success(request(fixture, original))
}

fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "project",
        "book_node",
        "node_content",
        "node_storyline_link",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_yjs_materialization_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_conflict",
        "yjs_updates",
        "yjs_snapshots",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
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

fn assert_rows_equal(
    actual: BTreeMap<String, Vec<Vec<DatabaseValue>>>,
    expected: &BTreeMap<String, Vec<Vec<DatabaseValue>>>,
) {
    assert_eq!(actual.len(), expected.len());
    for (table, expected_rows) in expected {
        let actual_rows = actual.get(table).expect("expected durable table");
        assert!(
            actual_rows == expected_rows,
            "durable table {table} differs (actual {} rows, expected {} rows)",
            actual_rows.len(),
            expected_rows.len()
        );
    }
}

fn assert_duplicate_notification_unchanged(
    db: &DatabaseGateway,
    mut expected: BTreeMap<String, Vec<Vec<DatabaseValue>>>,
) {
    let mut actual = rows(db);
    // ABI notification also checkpoints every live owner. That can refresh the
    // snapshot timestamp, without rewriting the snapshot bytes or any receive
    // journal, receipt, revision or cache. The owner-free export above checks
    // the stricter whole-transaction duplicate invariant without this omission.
    for tables in [&mut actual, &mut expected] {
        for snapshot in tables.get_mut("yjs_snapshots").unwrap() {
            assert_eq!(snapshot.len(), 3);
            assert!(matches!(snapshot.pop(), Some(DatabaseValue::Text(_))));
        }
    }
    assert_rows_equal(actual, &expected);
}

fn metadata(db: &DatabaseGateway) -> Vec<Vec<DatabaseValue>> {
    db.query(
        "SELECT id,title,book_order,kind FROM book_node ORDER BY book_order,id".into(),
        vec![],
        None,
        CLIENT.into(),
    )
    .unwrap()
    .rows
}

fn assert_owner_unchanged(fixture: &Fixture, owner: u64, expected: &Value) {
    assert_eq!(handle(fixture, 0), owner);
    assert_eq!(state(owner), *expected);
}

/// Each parallel test owns its export files; the collector combines their
/// manifests only after all four tests pass. This avoids a shared JSON writer.
fn export_case(
    name: &str,
    fixture: &Fixture,
    originals: &[(&Original, &str)],
    document_ids: &[String],
) {
    let Ok(output) = std::env::var("NATIVE_WORKSPACE_REMOTE_EXPORT_DIR") else {
        return;
    };
    let output = PathBuf::from(output);
    std::fs::create_dir_all(&output).unwrap();
    let source = gateway(handle(fixture, 0));
    assert_eq!(
        serde_json::to_value(source.checkpoint(CLIENT.into()).unwrap()).unwrap()["busy"],
        0
    );
    let temporary = tempfile::tempdir().unwrap();
    std::fs::copy(fixture.directory.join(FILE), temporary.path().join(FILE)).unwrap();
    let db = DatabaseGateway::new(temporary.path().to_path_buf()).unwrap();
    db.open(FILE.into(), CLIENT.into(), false).unwrap();
    db.close(CLIENT.into()).unwrap();
    let before_file = format!("{name}-before.db");
    let after_file = format!("{name}-after.db");
    std::fs::copy(temporary.path().join(FILE), output.join(&before_file)).unwrap();
    db.open(FILE.into(), CLIENT.into(), false).unwrap();
    let source = &originals[0].0.reference;
    let context = AuthoredProseContext {
        project_id: source.project_id.clone(),
        project_sync_id: source.project_sync_id.clone(),
        sync_generation_id: source.sync_generation_id.clone(),
        installation_id: "workspace-remote-oracle".into(),
        new_writer_id: "workspace-remote-oracle".into(),
        new_writer_epoch: "epoch-1".into(),
        now_ms: 1_790_380_800_000,
        now_iso: "2026-09-26T00:00:00.000Z".into(),
    };
    let mut deliveries = Vec::new();
    for (original, status) in originals {
        let before = rows(&db);
        if *status == "rejected" {
            execute(&db, FAULT);
        }
        let received = drifting_prose::remote_sync::receive_remote_workspace(
            &db,
            CLIENT,
            &context,
            &original.reference,
            &original.bytes,
            None,
        );
        if *status == "rejected" {
            assert!(received
                .unwrap_err()
                .contains("synthetic workspace remote receipt fault"));
            assert_rows_equal(rows(&db), &before);
            execute(&db, "DROP TRIGGER fail_workspace_remote_receipt");
        } else {
            let received = received.unwrap();
            assert_eq!(received.already_applied, *status == "duplicate");
            if *status == "duplicate" {
                assert_rows_equal(rows(&db), &before);
            }
        }
        let mut delivery = json!({"encodedBase64":STANDARD.encode(&original.bytes),
            "clock":{"nowMs":context.now_ms,"nowIso":context.now_iso},
            "identity":{"installationId":context.installation_id,"writerId":context.new_writer_id,"writerEpoch":context.new_writer_epoch},
            "expectedStatus":status});
        if *status == "rejected" {
            delivery["fault"] = json!("apply-receipt");
        }
        deliveries.push(delivery);
    }
    db.close(CLIENT.into()).unwrap();
    std::fs::copy(temporary.path().join(FILE), output.join(&after_file)).unwrap();
    std::fs::write(
        output.join(format!("{name}.json")),
        serde_json::to_vec_pretty(&json!({
            "name":name,"beforeDatabase":before_file,"afterDatabase":after_file,
            "deliveries":deliveries,"documentIds":document_ids,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn workspace_remote_changes_create_and_prose() {
    let (sender, mut receiver) = pair();
    let sender_db = gateway(handle(&sender, 0));
    let prior = known(&sender_db, &sender.project);
    let new_id = create(&sender, "新章🙂");
    let sender_owner = open_id(&sender, &new_id)["handle"].as_u64().unwrap();
    insert(sender_owner, "原件正文 e\u{301}🙂");
    let packets = since(&sender_db, &sender.project, &prior);
    assert_eq!(packets.len(), 2);
    let owner = handle(&receiver, 0);
    insert(owner, "另一章本地稿");
    let unchanged = state(owner);
    export_case(
        "chapter-create-and-prose",
        &receiver,
        &[
            (&packets[0], "applied"),
            (&packets[1], "applied"),
            (&packets[0], "duplicate"),
            (&packets[1], "duplicate"),
        ],
        &[format!("node-content:{new_id}")],
    );
    let created = receive(&receiver, &packets[0]);
    assert_eq!(created["alreadyApplied"], false);
    assert_eq!(created["projectId"], receiver.project);
    assert_eq!(created["chapters"].as_array().unwrap().len(), 3);
    assert_owner_unchanged(&receiver, owner, &unchanged);
    receive(&receiver, &packets[1]);
    assert_owner_unchanged(&receiver, owner, &unchanged);
    let received = open_id(&receiver, &new_id);
    let new_owner = received["handle"].as_u64().unwrap();
    assert_eq!(
        received["document"]["projection"]["text"],
        "原件正文 e\u{301}🙂"
    );
    assert_eq!(received["document"]["projection"]["canUndo"], false);
    insert(new_owner, "本地续写 ");
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":new_owner}))["projection"]["text"],
        "原件正文 e\u{301}🙂"
    );
    let before = rows(&gateway(new_owner));
    assert_eq!(receive(&receiver, &packets[0])["alreadyApplied"], true);
    assert_eq!(receive(&receiver, &packets[1])["alreadyApplied"], true);
    assert_duplicate_notification_unchanged(&gateway(new_owner), before);
    receiver.close();
    reopen_workspace(&mut receiver);
    assert_eq!(
        open_id(&receiver, &new_id)["document"]["projection"]["text"],
        "原件正文 e\u{301}🙂"
    );
    sender.close();
    receiver.close();
}

#[test]
fn workspace_remote_changes_competing_fields_and_order() {
    let (first, second) = pair();
    let first_owner = handle(&first, 0);
    let second_owner = handle(&second, 0);
    let first_db = gateway(first_owner);
    let second_db = gateway(second_owner);
    let first_prior = known(&first_db, &first.project);
    let second_prior = known(&second_db, &second.project);
    insert(first_owner, "保留正文历史");
    // The local prose command is a legitimate incoming packet too. Metadata
    // cannot be selected out of this collection or silently acknowledged.
    rename(&first, &first.chapters[0], "并发甲");
    move_before(&first, &first.chapters[0], None);
    success(
        json!({"operation":"workspaceRenameProject","handle":first.workspace,
        "projectId":first.project,"name":"远端项目名称"}),
    );
    rename(&second, &second.chapters[0], "并发乙");
    move_before(&second, &second.chapters[1], Some(&second.chapters[0]));
    let a = since(&first_db, &first.project, &first_prior);
    let b = since(&second_db, &second.project, &second_prior);
    assert_eq!(a.len(), 4);
    assert_eq!(b.len(), 2);
    let mut deliveries: Vec<_> = a
        .iter()
        .rev()
        .map(|original| (original, "applied"))
        .collect();
    deliveries.push((&a[0], "duplicate"));
    export_case(
        "competing-fields-and-order",
        &second,
        &deliveries,
        &[format!("node-content:{}", first.chapters[0])],
    );
    for original in a.iter().rev() {
        receive(&second, original);
    }
    for original in b.iter().rev() {
        receive(&first, original);
    }
    assert_eq!(metadata(&first_db), metadata(&second_db));
    assert_eq!(handle(&first, 0), first_owner);
    assert_eq!(handle(&second, 0), second_owner);
    assert_eq!(state(first_owner)["projection"]["text"], "保留正文历史");
    assert_eq!(state(second_owner)["projection"]["text"], "保留正文历史");
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":first_owner}))["projection"]["text"],
        ""
    );
    assert_eq!(state(second_owner)["projection"]["canUndo"], false);
    let before = rows(&second_db);
    for original in &a {
        assert_eq!(receive(&second, original)["alreadyApplied"], true);
    }
    assert_duplicate_notification_unchanged(&second_db, before);
    first.close();
    second.close();
}

#[test]
fn workspace_remote_changes_late_fields_before_create() {
    let (sender, receiver) = pair();
    let sender_db = gateway(handle(&sender, 0));
    let prior = known(&sender_db, &sender.project);
    let new_id = create(&sender, "旧种子标题");
    rename(&sender, &new_id, "迟到创建保留新名🙂");
    move_before(&sender, &new_id, Some(&sender.chapters[0]));
    let new_owner = open_id(&sender, &new_id)["handle"].as_u64().unwrap();
    insert(new_owner, "创建后正文");
    let packets = since(&sender_db, &sender.project, &prior);
    assert_eq!(packets.len(), 4);
    export_case(
        "late-fields-before-create",
        &receiver,
        &[
            (&packets[2], "applied"),
            (&packets[1], "applied"),
            (&packets[0], "applied"),
            (&packets[3], "applied"),
            (&packets[0], "duplicate"),
        ],
        &[format!("node-content:{new_id}")],
    );
    receive(&receiver, &packets[2]);
    receive(&receiver, &packets[1]);
    let db = gateway(handle(&receiver, 0));
    assert!(db
        .query(
            "SELECT id FROM book_node WHERE id=?".into(),
            vec![text(&new_id)],
            None,
            CLIENT.into()
        )
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(db.query("SELECT field_key FROM sync_field_clock WHERE target_kind='node' AND target_id=? ORDER BY field_key".into(),
        vec![text(&new_id)], None, CLIENT.into()).unwrap().rows,
        vec![vec![text("field:bookOrder")], vec![text("field:title")]]);
    let created = receive(&receiver, &packets[0]);
    assert_eq!(created["chapters"][0]["id"], new_id);
    assert_eq!(created["chapters"][0]["title"], "迟到创建保留新名🙂");
    receive(&receiver, &packets[3]);
    assert_eq!(metadata(&db), metadata(&sender_db));
    assert_eq!(
        open_id(&receiver, &new_id)["document"]["projection"]["text"],
        "创建后正文"
    );
    sender.close();
    receiver.close();
}

#[test]
fn workspace_remote_changes_receipt_rollback_and_retry() {
    let (sender, receiver) = pair();
    let sender_db = gateway(handle(&sender, 0));
    let prior = known(&sender_db, &sender.project);
    let new_id = create(&sender, "原子创建🙂");
    let packets = since(&sender_db, &sender.project, &prior);
    assert_eq!(packets.len(), 1);
    let original = &packets[0];
    export_case(
        "receipt-rollback-and-retry",
        &receiver,
        &[
            (original, "rejected"),
            (original, "applied"),
            (original, "duplicate"),
        ],
        &[format!("node-content:{new_id}")],
    );
    let owner = handle(&receiver, 0);
    insert(owner, "保留旧章");
    let before_state = state(owner);
    success(
        json!({"operation":"documentBeginDraft","handle":owner,"start":{
        "key":"workspace-metadata-draft","revision":before_state["projection"]["revision"],
        "range":{"location":0,"length":0}}}),
    );
    let db = gateway(owner);
    let before = rows(&db);
    let mut wrong = original.clone();
    wrong.reference.project_sync_id = "wrong-project-sync".into();
    assert!(!rejected(request(&receiver, &wrong)).is_empty());
    assert_rows_equal(rows(&db), &before);
    assert_eq!(state(owner), before_state);
    execute(&db, FAULT);
    assert!(
        rejected(request(&receiver, original)).contains("synthetic workspace remote receipt fault")
    );
    assert_rows_equal(rows(&db), &before);
    assert_eq!(state(owner), before_state);
    assert_eq!(
        SESSIONS.get().unwrap().lock().unwrap()[&owner]
            .document
            .active_drafts(),
        1
    );
    execute(&db, "DROP TRIGGER fail_workspace_remote_receipt");
    success(
        json!({"operation":"documentCancelDraft","handle":owner,"key":"workspace-metadata-draft"}),
    );
    assert_eq!(receive(&receiver, original)["alreadyApplied"], false);
    assert_eq!(
        open_id(&receiver, &new_id)["document"]["projection"]["text"],
        ""
    );
    assert_owner_unchanged(&receiver, owner, &before_state);
    let after = rows(&db);
    assert_eq!(receive(&receiver, original)["alreadyApplied"], true);
    assert_duplicate_notification_unchanged(&db, after);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":owner}))["projection"]["text"],
        ""
    );
    sender.close();
    receiver.close();
}
