//! Synthetic process-recovery worker. The parent kills only after a flushed
//! marker from inside the real owner's transaction/replay/checkpoint path.
use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_core::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use drifting_core::original_body_archive::ArchiveScope;
use drifting_core::prose::{ProseRepository, RevisionSource};
use drifting_core::prose_journal::{AuthoredProseContext, AuthoredProseJournal};
use drifting_document::{
    CommentAnchorRecord, DocumentSession, Edit, NativeRange, NativeReplacement,
};
use drifting_prose::{load_document, DurabilityPhase, DurableDocument};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::io::Write;
use std::path::Path;

#[path = "durability/native_delete.rs"]
mod native_delete;

const CLIENT: &str = "synthetic-recovery";
const DOC: &str = "node-content:synthetic-node";
const NOW: &str = "2026-09-25T00:00:00.000Z";
const CHECKS: [&str; 9] = [
    "prose",
    "anchors",
    "revision",
    "journal",
    "receipt",
    "covered-tail",
    "isolation",
    "integrity",
    "foreign-keys",
];
const BLOCKED_CHECKS: [&str; 8] = [
    "raw-update-retention",
    "open-disposition",
    "covered-tail",
    "snapshot-retention",
    "receipt-not-created",
    "isolation",
    "integrity",
    "foreign-keys",
];
const REPAIR_CHECKS: [&str; 11] = [
    "raw-update-retention",
    "derived-system-journal",
    "snapshot-coverage",
    "comment-cas",
    "retry-no-duplicate",
    "covered-tail",
    "no-user-undo",
    "no-remote-frontier",
    "isolation",
    "integrity",
    "foreign-keys",
];
fn text(value: &str) -> V {
    V::Text(value.into())
}
fn gateway(directory: &Path) -> DatabaseGateway {
    let gateway = DatabaseGateway::new(directory.into()).unwrap();
    gateway
        .open("recovery.db".into(), CLIENT.into(), false)
        .unwrap();
    gateway
}
fn query(gateway: &DatabaseGateway, sql: &str, tx: Option<u64>) -> Vec<Vec<V>> {
    gateway
        .query(sql.into(), vec![], tx, CLIENT.into())
        .unwrap()
        .rows
}
fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "synthetic-project".into(),
        project_sync_id: "synthetic-project-sync".into(),
        sync_generation_id: "synthetic-generation".into(),
        installation_id: "synthetic-installation".into(),
        new_writer_id: "synthetic-writer".into(),
        new_writer_epoch: "synthetic-epoch".into(),
        now_ms: 1_790_291_200_000,
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
fn count(gateway: &DatabaseGateway, table: &str) -> u64 {
    let V::Integer(value) = &query(gateway, &format!("SELECT count(*) FROM {table}"), None)[0][0]
    else {
        panic!("count not integer")
    };
    value.parse().unwrap()
}
fn read_comments(gateway: &DatabaseGateway, tx: Option<u64>) -> Vec<CommentAnchorRecord> {
    query(
        gateway,
        "SELECT id,anchor_json,target_block_id,target_block_ids_json FROM comment ORDER BY id",
        tx,
    )
    .into_iter()
    .map(|row| {
        let [V::Text(id), V::Text(anchor), V::Text(block), V::Text(ids)] = row.as_slice() else {
            panic!("invalid synthetic anchor")
        };
        CommentAnchorRecord {
            id: id.clone(),
            anchor_json: anchor.clone(),
            target_block_id: Some(block.clone()),
            target_block_ids_json: ids.clone(),
        }
    })
    .collect()
}
fn write_comments(
    gateway: &DatabaseGateway,
    tx: u64,
    document: &DocumentSession,
    old: &[CommentAnchorRecord],
) -> Result<(), String> {
    for record in document.comment_anchor_records() {
        let prior = old
            .iter()
            .find(|item| item.id == record.id)
            .ok_or("missing loaded anchor")?;
        let result = gateway.execute("UPDATE comment SET anchor_json=?,target_block_id=?,target_block_ids_json=? WHERE id=? AND anchor_json=? AND target_block_id=? AND target_block_ids_json=?".into(), vec![text(&record.anchor_json), text(record.target_block_id.as_deref().unwrap()), text(&record.target_block_ids_json), text(&record.id), text(&prior.anchor_json), text(prior.target_block_id.as_deref().unwrap()), text(&prior.target_block_ids_json)], Some(tx), CLIENT.into())?;
        if result.changes != 1 {
            return Err("synthetic comment CAS failed".into());
        }
    }
    Ok(())
}
fn seed_rows(gateway: &DatabaseGateway) {
    for sql in [
        "INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('synthetic-project','Synthetic','local-user','now','now')",
        "INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('isolated-project','Untouched','local-user','now','now')",
        "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('synthetic-node','Synthetic prose','synthetic-project',0,0,'now','now')",
        "INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES ('synthetic-generation','synthetic-project','synthetic-project-sync','now','now')",
    ] { gateway.execute(sql.into(), vec![], None, CLIENT.into()).unwrap(); }
}
fn seed(gateway: &DatabaseGateway) {
    seed_rows(gateway);
    let mut document = DocumentSession::with_test_client_id(46001).unwrap();
    for (id, value) in [("p", "甲北塔乙"), ("q", "海岸")] {
        document
            .edit(Edit::AppendParagraph {
                id: id.into(),
                text: value.into(),
            })
            .unwrap();
    }
    document.set_comment_anchors(vec![CommentAnchorRecord { id: "synthetic-comment".into(), target_block_id: Some("p".into()), target_block_ids_json: "[\"p\"]".into(), anchor_json: json!({"selectedText":"北塔","blockSnapshots":[{"blockId":"p","blockText":"甲北塔乙"}],"futureField":{"keep":[1,2]},"textAnchor":{"startBlockId":"p","startOffset":1,"endBlockId":"p","endOffset":3,"text":"北塔","futureAnchor":true}}).to_string() }]).unwrap();
    let record = &document.comment_anchor_records()[0];
    gateway.execute("INSERT INTO comment(id,project_id,target_kind,target_id,target_block_id,target_block_ids_json,anchor_json,body_json,created_at,updated_at) VALUES ('synthetic-comment','synthetic-project','node','synthetic-node','p',?,?,?,'now','now')".into(),vec![text(&record.target_block_ids_json),text(&record.anchor_json),text("{\"synthetic\":true}")],None,CLIENT.into()).unwrap();
    let repo = ProseRepository::new(gateway, CLIENT);
    repo.save_snapshot(DOC, &document.update(None, 1).unwrap(), NOW, None)
        .unwrap();
    repo.save_snapshot("isolated-document", &[0, 0], NOW, None)
        .unwrap();
}
fn owner(gateway: &DatabaseGateway) -> DurableDocument {
    let mut document = DurableDocument::open_with_scope(gateway.clone(), CLIENT, scope()).unwrap();
    document
        .set_comment_anchors(read_comments(gateway, None))
        .unwrap();
    document
}
fn summary(gateway: &DatabaseGateway, tx: Option<u64>) -> Value {
    let own = tx.is_none();
    let tx = tx.unwrap_or_else(|| {
        gateway
            .begin(TransactionBehavior::Deferred, CLIENT.into())
            .unwrap()
    });
    let (mut document, _) = load_document(&ProseRepository::new(gateway, CLIENT), DOC, tx).unwrap();
    let anchors = read_comments(gateway, Some(tx));
    document.set_comment_anchors(anchors.clone()).unwrap();
    // Compactable storage layout and session-local clocks are excluded. These
    // authoritative rows must remain byte-for-byte stable across both restarts.
    let state = json!({
        "semantic":document.semantic().unwrap(),"anchors":anchors,
        "revision":query(gateway,"SELECT * FROM yjs_document_revision ORDER BY document_id",Some(tx)),
        "provenance":query(gateway,"SELECT * FROM yjs_document_revision_provenance ORDER BY document_id,revision",Some(tx)),
        "writer":query(gateway,"SELECT * FROM sync_generation_writer_state ORDER BY writer_id",Some(tx)),
        "journal":query(gateway,"SELECT * FROM sync_change_set ORDER BY change_set_id",Some(tx)),
        "mutations":query(gateway,"SELECT * FROM sync_mutation ORDER BY change_set_id,mutation_index",Some(tx)),
        "receipts":query(gateway,"SELECT * FROM sync_apply_receipt ORDER BY change_set_id",Some(tx))
    });
    let result = json!({"stateHash":format!("{:x}",Sha256::digest(serde_json::to_vec(&state).unwrap())),"updateBase64":STANDARD.encode(document.update(None,1).unwrap()),"semantic":state["semantic"],"projection":document.native_projection().unwrap()});
    if own {
        gateway.commit(tx, CLIENT.into()).unwrap();
    }
    result
}
fn emit(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}
fn pause(boundary: &str, expected: &Value, baseline: &Value, details: Value) -> ! {
    emit(
        json!({"event":"ready","boundary":boundary,"expectedStateHash":expected["stateHash"],"baselineStateHash":baseline["stateHash"],"details":details}),
    );
    loop {
        std::thread::park();
    }
}
fn delta(base: &[u8], client: u64, value: &str) -> Vec<u8> {
    let mut peer = DocumentSession::with_test_client_id(client).unwrap();
    peer.apply_remote(base, 1).unwrap();
    let log = peer.capture_authored_updates().unwrap();
    peer.edit(Edit::Insert {
        block: "q".into(),
        offset: 0,
        text: value.into(),
    })
    .unwrap();
    let mut updates = log.drain();
    assert_eq!(updates.len(), 1);
    updates.remove(0)
}
fn append_remote(gateway: &DatabaseGateway, bytes: &[u8]) -> u64 {
    // This is the low-level durable reducer seam, not a network protocol mock.
    ProseRepository::new(gateway, CLIENT)
        .append_update(DOC, bytes, &RevisionSource::Remote, NOW, None, None)
        .unwrap()
        .update_id
}
fn blocked_fixture(directory: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(directory.join("blocked-fixture.json")).unwrap()).unwrap()
}
fn fixture_bytes(fixture: &Value, field: &str) -> Vec<u8> {
    STANDARD.decode(fixture[field].as_str().unwrap()).unwrap()
}
fn seed_blocked(gateway: &DatabaseGateway, fixture: &Value) {
    seed_rows(gateway);
    let repository = ProseRepository::new(gateway, CLIENT);
    repository
        .save_snapshot(DOC, &fixture_bytes(fixture, "seedBase64"), NOW, None)
        .unwrap();
    repository
        .save_snapshot("isolated-document", &[0, 0], NOW, None)
        .unwrap();
    let mut document = owner(gateway);
    let revision = document.native_projection().unwrap().revision;
    document
        .replace_native(NativeReplacement {
            revision,
            range: NativeRange {
                location: 1,
                length: 3,
            },
            text: String::new(),
        })
        .unwrap();
    assert_eq!(document.native_projection().unwrap().text, "潮航\n终章");
    document
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |_, _, _| Ok(()),
            &mut |_| {},
        )
        .unwrap();
    document
        .checkpoint(NOW, |_, _, _| Ok(()), &mut |_| {})
        .unwrap();
    assert!(repository.list_updates(DOC, None, None).unwrap().is_empty());
}
fn seed_repair(gateway: &DatabaseGateway, fixture: &Value) {
    seed_blocked(gateway, fixture);
    let mut document = owner(gateway);
    document.set_comment_anchors(vec![CommentAnchorRecord {
        id: "synthetic-comment".into(), target_block_id: Some("b".into()),
        target_block_ids_json: "[\"b\"]".into(),
        anchor_json: json!({"selectedText":"潮","blockSnapshots":[{"blockId":"b","blockText":"潮航"}],"futureField":{"keep":[1,2]},"textAnchor":{"startBlockId":"b","startOffset":0,"endBlockId":"b","endOffset":1,"text":"潮"}}).to_string(),
    }]).unwrap();
    let record = &document.comment_anchor_records()[0];
    gateway.execute("INSERT INTO comment(id,project_id,target_kind,target_id,target_block_id,target_block_ids_json,anchor_json,body_json,created_at,updated_at) VALUES ('synthetic-comment','synthetic-project','node','synthetic-node','b',?,?,?,'now','now')".into(),vec![text(&record.target_block_ids_json),text(&record.anchor_json),text("{\"synthetic\":true}")],None,CLIENT.into()).unwrap();
    if fixture.get("dependencyBase64").is_some() {
        let tail = CommentAnchorRecord {
            id: "synthetic-tail-comment".into(), target_block_id: Some("d".into()),
            target_block_ids_json: "[\"d\"]".into(),
            anchor_json: json!({"selectedText":"终","futureField":{"keep":[1,2]},"textAnchor":{"startBlockId":"d","startOffset":0,"endBlockId":"d","endOffset":1,"text":"终"}}).to_string(),
        };
        gateway.execute("INSERT INTO comment(id,project_id,target_kind,target_id,target_block_id,target_block_ids_json,anchor_json,body_json,created_at,updated_at) VALUES ('synthetic-tail-comment','synthetic-project','node','synthetic-node','d',?,?,?,'now','now')".into(),vec![text(&tail.target_block_ids_json),text(&tail.anchor_json),text("{\"synthetic\":true}")],None,CLIENT.into()).unwrap();
    }
}
fn retained_state(gateway: &DatabaseGateway) -> Value {
    // Include the physical tail and snapshot bytes. A failed open/checkpoint
    // must not silently rewrite or compact the only copy of the incoming event.
    let rows = json!({
        "snapshots":query(gateway,"SELECT * FROM yjs_snapshots ORDER BY document_id",None),
        "updates":query(gateway,"SELECT * FROM yjs_updates ORDER BY id",None),
        "revision":query(gateway,"SELECT * FROM yjs_document_revision ORDER BY document_id",None),
        "provenance":query(gateway,"SELECT * FROM yjs_document_revision_provenance ORDER BY document_id,revision",None),
        "writer":query(gateway,"SELECT * FROM sync_generation_writer_state ORDER BY writer_id",None),
        "journal":query(gateway,"SELECT * FROM sync_change_set ORDER BY change_set_id",None),
        "mutations":query(gateway,"SELECT * FROM sync_mutation ORDER BY change_set_id,mutation_index",None),
        "receipts":query(gateway,"SELECT * FROM sync_apply_receipt ORDER BY change_set_id",None),
        "comments":query(gateway,"SELECT * FROM comment ORDER BY id",None),
    });
    let repo = ProseRepository::new(gateway, CLIENT);
    let snapshot = repo.get_snapshot(DOC, None).unwrap().unwrap();
    let tail = repo.list_updates(DOC, None, None).unwrap();
    json!({
        "stateHash":format!("{:x}",Sha256::digest(serde_json::to_vec(&rows).unwrap())),
        "snapshotBase64":STANDARD.encode(snapshot.state_blob),
        "tail":tail.iter().map(|row|json!({"id":row.id,"updateBase64":STANDARD.encode(&row.update_blob)})).collect::<Vec<_>>(),
        "revision":repo.get_revision(DOC,None).unwrap(),
        "journalCount":count(gateway,"sync_change_set"),
        "receiptCount":count(gateway,"sync_apply_receipt"),
    })
}
fn crash_blocked(gateway: &DatabaseGateway, boundary: &str, fixture: &Value) {
    let baseline = retained_state(gateway);
    let mut document = owner(gateway);
    let covered = document.covered_update_id();
    let live_before = document.update(None, 1).unwrap();
    let bytes = fixture_bytes(fixture, "updateBase64");
    let id = document.receive_remote(&bytes, 1, NOW, &mut |phase| {
        if boundary == "blocked-remote-before-commit" && phase == DurabilityPhase::RemoteBeforeCommit {
            pause(boundary, &baseline, &baseline, json!({"retentionOnly":true,"transactionWritten":true,"committed":false,"coveredId":covered,"state":baseline}));
        }
        if boundary == "blocked-remote-after-commit" && phase == DurabilityPhase::RemoteAfterCommit {
            let stored = retained_state(gateway);
            pause(boundary, &stored, &baseline, json!({"retentionOnly":true,"committed":true,"replayAttempted":false,"coveredId":covered,"state":stored}));
        }
    }).unwrap();
    assert_eq!(boundary, "blocked-remote-after-replay-rejection");
    let committed = retained_state(gateway);
    assert_eq!(
        document
            .receive_remote(&bytes, 1, NOW, &mut |_| {})
            .unwrap(),
        id
    );
    assert_eq!(
        retained_state(gateway),
        committed,
        "Retry appended the same unacknowledged bytes twice"
    );
    let reason = document.replay().unwrap_err();
    assert!(
        reason.contains("REMOTE_TEXT_RETENTION_REQUIRED"),
        "{reason}"
    );
    let blocked = document
        .remote_block()
        .expect("Missing stored-unapplied state");
    assert_eq!(blocked.update_id, id);
    assert!(blocked.reason.contains("REMOTE_TEXT_RETENTION_REQUIRED"));
    assert_eq!(document.covered_update_id(), covered);
    assert_eq!(document.update(None, 1).unwrap(), live_before);
    let checkpoint_error = document
        .checkpoint(NOW, |_, _, _| Ok(()), &mut |_| {})
        .unwrap_err();
    assert!(checkpoint_error.contains("REMOTE_TEXT_RETENTION_REQUIRED"));
    assert_eq!(retained_state(gateway), committed);
    pause(
        boundary,
        &committed,
        &baseline,
        json!({"retentionOnly":true,"committed":true,"replayAttempted":true,"replayRejected":true,"checkpointRejected":true,"duplicateReceivePreserved":true,"liveUnchanged":true,"coveredId":covered,"blockedUpdateId":id,"reason":reason,"state":committed}),
    );
}
fn recover_blocked(gateway: &DatabaseGateway, boundary: &str, fixture: &Value) {
    let before = retained_state(gateway);
    let committed = boundary != "blocked-remote-before-commit";
    let error = match DurableDocument::open_with_scope(gateway.clone(), CLIENT, scope()) {
        Ok(document) => {
            assert!(
                !committed,
                "Committed dangerous update was treated as applied"
            );
            assert_eq!(document.native_projection().unwrap().text, "潮航\n终章");
            None
        }
        Err(error) => {
            assert!(
                committed,
                "Uncommitted update unexpectedly blocked open: {error}"
            );
            assert!(error.contains("original bytes retained"), "{error}");
            assert!(error.contains("REMOTE_TEXT_RETENTION_REQUIRED"), "{error}");
            Some(error)
        }
    };
    let repo = ProseRepository::new(gateway, CLIENT);
    let tail = repo.list_updates(DOC, None, None).unwrap();
    assert_eq!(tail.len(), usize::from(committed));
    if committed {
        assert_eq!(tail[0].update_blob, fixture_bytes(fixture, "updateBase64"));
    }
    assert_eq!(
        repo.get_revision(DOC, None).unwrap(),
        if committed { 2 } else { 1 }
    );
    assert_eq!(count(gateway, "sync_change_set"), 1);
    assert_eq!(count(gateway, "sync_mutation"), 1);
    assert_eq!(count(gateway, "sync_apply_receipt"), 1);
    assert_eq!(
        query(
            gateway,
            "SELECT name FROM project WHERE id='isolated-project'",
            None
        ),
        vec![vec![text("Untouched")]]
    );
    assert_eq!(
        repo.get_snapshot("isolated-document", None)
            .unwrap()
            .unwrap()
            .state_blob,
        vec![0, 0]
    );
    assert_eq!(
        query(gateway, "PRAGMA integrity_check", None),
        vec![vec![text("ok")]]
    );
    assert!(query(gateway, "PRAGMA foreign_key_check", None).is_empty());
    assert_eq!(
        retained_state(gateway),
        before,
        "Cold open changed retained bytes or receipts"
    );
    emit(
        json!({"event":"recovered","boundary":boundary,"stateHash":before["stateHash"],"checks":BLOCKED_CHECKS,"details":{"retentionOnly":true,"committed":committed,"openBlocked":error.is_some(),"openError":error,"state":before}}),
    );
}
fn crash_repair(gateway: &DatabaseGateway, boundary: &str, fixture: &Value) {
    let mut document = owner(gateway);
    let closure = fixture.get("dependencyBase64").is_some();
    let expected_text = if closure {
        "保潮航\n远🙂终章"
    } else {
        "保潮航\n终章"
    };
    let bytes = fixture_bytes(fixture, "updateBase64");
    let raw_id = document
        .receive_remote(&bytes, 1, NOW, &mut |_| {})
        .unwrap();
    assert_eq!(document.covered_update_id(), 0);
    assert_eq!(document.native_projection().unwrap().text, "潮航\n终章");
    let mut raw_ids = vec![raw_id];
    if closure {
        let before = document.update(None, 1).unwrap();
        let old = read_comments(gateway, None);
        let error = document
            .replay_with_context(
                &context(),
                |gateway, tx, candidate| write_comments(gateway, tx, candidate, &old),
                &mut |_| {},
            )
            .unwrap_err();
        assert!(error.contains("REMOTE_TEXT_RETENTION_REQUIRED:"), "{error}");
        assert_eq!(document.remote_block().unwrap().update_id, raw_id);
        assert_eq!(document.update(None, 1).unwrap(), before);
        assert_eq!(document.covered_update_id(), 0);
        assert!(!document.has_pending());
        assert_eq!(count(gateway, "sync_change_set"), 1);
        let dependency_id = document
            .receive_remote(
                &fixture_bytes(fixture, "dependencyBase64"),
                1,
                NOW,
                &mut |_| {},
            )
            .unwrap();
        assert!(dependency_id > raw_id);
        raw_ids.push(dependency_id);
    }
    let baseline = retained_state(gateway);
    assert_eq!(baseline["tail"].as_array().unwrap().len(), raw_ids.len());
    let old = read_comments(gateway, None);
    let staged = RefCell::new(Value::Null);
    document.replay_with_context(
        &context(),
        |gateway, tx, candidate| {
            assert_eq!(candidate.native_projection()?.text, expected_text);
            write_comments(gateway, tx, candidate, &old)?;
            let journal = query(gateway, "SELECT count(*) FROM sync_change_set", Some(tx));
            assert_eq!(journal, vec![vec![V::Integer("2".into())]]);
            *staged.borrow_mut() = json!({"text":candidate.native_projection()?.text,"journalCount":2});
            Ok(())
        },
        &mut |phase| {
            let before = boundary == "repair-before-commit" && phase == DurabilityPhase::ReplayBeforeCommit;
            let after = boundary == "repair-after-commit" && phase == DurabilityPhase::ReplayAfterCommit;
            let live = boundary == "repair-after-live-replay" && phase == DurabilityPhase::ReplayAppliedBeforeCoverage;
            if before || after || live {
                // The pre-COMMIT marker reports the already committed raw row,
                // not the uncommitted candidate. Recovery must retry from it.
                let expected = if before { baseline.clone() } else { retained_state(gateway) };
                pause(boundary, &expected, &baseline, json!({
                    "rawCommitted":true,"rawUpdateId":raw_id,"rawUpdateIds":raw_ids,"dependencyClosure":closure,"blockedBeforeDependency":closure,"coveredBeforeReplay":0,
                    "transactionWritten":true,"repairCommitted":!before,
                    "liveReplayApplied":live,"staged":staged.borrow().clone(),"state":expected,
                }));
            }
        },
    ).unwrap();
    panic!("repair phase hook did not fire");
}
fn recover_repair(gateway: &DatabaseGateway, boundary: &str, fixture: &Value) {
    let closure = fixture.get("dependencyBase64").is_some();
    let raw_count = if closure { 2 } else { 1 };
    let expected_text = if closure {
        "保潮航\n远🙂终章"
    } else {
        "保潮航\n终章"
    };
    let before = retained_state(gateway);
    let mut document =
        DurableDocument::open_for_replay_with_scope(gateway.clone(), CLIENT, scope()).unwrap();
    let old = read_comments(gateway, None);
    document.set_comment_anchors(old.clone()).unwrap();
    document
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| write_comments(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap();
    let projection = document.native_projection().unwrap();
    assert_eq!(projection.text, expected_text);
    assert_eq!(projection.comments.len(), raw_count);
    assert_eq!(projection.comments[0].quote, "潮");
    assert_eq!(projection.comments[0].status, "anchored");
    assert_eq!(projection.comments[0].ranges.len(), 1);
    assert_eq!(projection.comments[0].ranges[0].location, 1);
    assert_eq!(projection.comments[0].ranges[0].length, 1);
    for record in document.comment_anchor_records() {
        let anchor: Value = serde_json::from_str(&record.anchor_json).unwrap();
        assert_eq!(anchor["futureField"]["keep"], json!([1, 2]));
    }
    if closure {
        let comment = &projection.comments[1];
        assert_eq!(comment.quote, "终");
        assert_eq!(comment.status, "anchored");
        assert_eq!(comment.ranges.len(), 1);
        assert_eq!(comment.ranges[0].location, 7);
        assert_eq!(comment.ranges[0].length, 1);
        let anchor = fixture_bytes(fixture, "safeAnchorBase64");
        assert_eq!(document.anchor("d", 1, false).unwrap(), anchor);
        assert_eq!(
            document.resolve_anchor(&anchor).unwrap(),
            Some(json!({"block":"d","offset":1}))
        );
    }
    assert_eq!(
        query(gateway, "SELECT body_json FROM comment", None),
        vec![vec![text("{\"synthetic\":true}")]; raw_count]
    );
    let repository = ProseRepository::new(gateway, CLIENT);
    let tail = repository.list_updates(DOC, None, None).unwrap();
    assert_eq!(tail.len(), raw_count + 1);
    assert_eq!(tail[0].update_blob, fixture_bytes(fixture, "updateBase64"));
    if closure {
        assert_eq!(
            tail[1].update_blob,
            fixture_bytes(fixture, "dependencyBase64")
        );
    }
    assert!(tail.windows(2).all(|pair| pair[0].id < pair[1].id));
    assert_eq!(document.covered_update_id(), tail[raw_count].id);
    assert_eq!(
        repository.get_revision(DOC, None).unwrap(),
        (raw_count + 2) as u64
    );
    assert_eq!(
        repository
            .list_revision_provenance(DOC, 0, None)
            .unwrap()
            .iter()
            .map(|entry| &entry.source)
            .collect::<Vec<_>>(),
        if closure {
            vec![
                &RevisionSource::User,
                &RevisionSource::Remote,
                &RevisionSource::Remote,
                &RevisionSource::System,
            ]
        } else {
            vec![
                &RevisionSource::User,
                &RevisionSource::Remote,
                &RevisionSource::System,
            ]
        }
    );
    assert_eq!(count(gateway, "sync_change_set"), 2);
    assert_eq!(count(gateway, "sync_mutation"), 2);
    assert_eq!(count(gateway, "sync_apply_receipt"), 2);
    assert_eq!(count(gateway, "sync_frontier"), 0);
    assert!(!document.has_uncommitted_updates());
    assert!(
        !document.try_undo().unwrap(),
        "Cold repair entered user undo"
    );
    let repaired = retained_state(gateway);
    let old = read_comments(gateway, None);
    document
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| write_comments(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(
        retained_state(gateway),
        repaired,
        "Retry duplicated a repair or rewrote its snapshot"
    );
    assert_eq!(
        query(
            gateway,
            "SELECT name FROM project WHERE id='isolated-project'",
            None
        ),
        vec![vec![text("Untouched")]]
    );
    assert_eq!(
        repository
            .get_snapshot("isolated-document", None)
            .unwrap()
            .unwrap()
            .state_blob,
        vec![0, 0]
    );
    assert_eq!(
        query(gateway, "PRAGMA integrity_check", None),
        vec![vec![text("ok")]]
    );
    assert!(query(gateway, "PRAGMA foreign_key_check", None).is_empty());
    let state = summary(gateway, None);
    emit(
        json!({"event":"recovered","boundary":boundary,"stateHash":repaired["stateHash"],"checks":REPAIR_CHECKS,
        "details":{"beforeState":before,"state":repaired,"updateBase64":state["updateBase64"],"semantic":state["semantic"],
        "coveredId":document.covered_update_id(),"commentRanges":projection.comments[0].ranges,"allCommentRanges":projection.comments.iter().map(|value|json!({"id":value.id,"quote":value.quote,"ranges":value.ranges})).collect::<Vec<_>>(),"safeAnchorBase64":if closure { fixture["safeAnchorBase64"].clone() } else { Value::Null },"dependencyClosure":closure,"retryStable":true,"systemJournalCount":1,"remoteFrontierCount":0}}),
    );
}
fn crash(gateway: &DatabaseGateway, boundary: &str) {
    let baseline = summary(gateway, None);
    let mut document = owner(gateway);
    let base = document.update(None, 1).unwrap();
    if boundary.starts_with("local-n-plus-two") {
        let remote = delta(&base, 46002, "远");
        let remote_id = append_remote(gateway, &remote);
        let local = delta(&base, 46003, "本");
        let appended = AuthoredProseJournal::new(gateway, CLIENT)
            .append(
                &context(),
                DOC,
                &local,
                &RevisionSource::User,
                None,
                None,
                |repo, tx| {
                    let (mut persisted, _) = load_document(repo, DOC, tx)?;
                    persisted.apply_remote(&local, 1)
                },
            )
            .unwrap();
        // A delivery callback can already have integrated local N+2 while the
        // remote N+1 callback is lost. Coverage still comes only from row replay.
        document.apply_remote(&local, 1).unwrap();
        let live = document.native_projection().unwrap().text;
        assert!(live.contains('本') && !live.contains('远'));
        assert_eq!(document.covered_update_id(), 0);
        assert!(remote_id < appended.update_id);
        let details = json!({"gapProved":true,"remoteId":remote_id,"localId":appended.update_id,"coveredBeforeReplay":0,"liveContainedLocal":true,"liveContainedRemote":false});
        if boundary == "local-n-plus-two-before-replay" {
            pause(boundary, &summary(gateway, None), &baseline, details);
        }
        document
            .checkpoint(NOW, |_, _, _| Ok(()), &mut |_| {})
            .unwrap();
        assert_eq!(document.covered_update_id(), appended.update_id);
        assert!(ProseRepository::new(gateway, CLIENT)
            .list_updates(DOC, None, None)
            .unwrap()
            .is_empty());
        let late = delta(&document.update(None, 1).unwrap(), 46004, "迟");
        let late_id = append_remote(gateway, &late);
        assert!(late_id > document.covered_update_id());
        let mut details = details;
        details["coveredAfterCheckpoint"] = json!(document.covered_update_id());
        details["lateId"] = json!(late_id);
        details["lateTailRetained"] = json!(true);
        pause(boundary, &summary(gateway, None), &baseline, details);
    }
    if boundary == "remote-committed-before-replay" || boundary == "replay-applied-before-coverage"
    {
        let remote = delta(&base, 46002, "远");
        let id = append_remote(gateway, &remote);
        assert!(!document.native_projection().unwrap().text.contains('远'));
        let expected = summary(gateway, None);
        if boundary == "remote-committed-before-replay" {
            pause(
                boundary,
                &expected,
                &baseline,
                json!({"remoteId":id,"coveredBeforeReplay":document.covered_update_id()}),
            );
        }
        document
            .replay_observed(None, &mut |phase| {
                if phase == DurabilityPhase::ReplayAppliedBeforeCoverage {
                    pause(boundary, &expected, &baseline, json!({"remoteId":id}));
                }
            })
            .unwrap();
        panic!("replay hook did not fire");
    }
    let old = read_comments(gateway, None);
    let revision = document.native_projection().unwrap().revision;
    document
        .replace_native(NativeReplacement {
            revision,
            range: NativeRange {
                location: 2,
                length: 0,
            },
            text: "\n".into(),
        })
        .unwrap();
    let expected = RefCell::new(Value::Null);
    document
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, document| {
                write_comments(gateway, tx, document, &old)?;
                *expected.borrow_mut() = summary(gateway, Some(tx));
                Ok(())
            },
            &mut |phase| {
                if boundary == "authored-before-commit"
                    && phase == DurabilityPhase::AuthoredBeforeCommit
                {
                    pause(
                        boundary,
                        &baseline,
                        &baseline,
                        json!({"transactionWritten":true}),
                    );
                }
                if boundary == "authored-after-commit"
                    && phase == DurabilityPhase::AuthoredAfterCommit
                {
                    pause(
                        boundary,
                        &expected.borrow(),
                        &baseline,
                        json!({"committedBeforeReplay":true}),
                    );
                }
            },
        )
        .unwrap();
    let expected = expected.into_inner();
    let target = match boundary {
        "checkpoint-after-snapshot" => DurabilityPhase::CheckpointAfterSnapshot,
        "checkpoint-after-prune" => DurabilityPhase::CheckpointAfterPrune,
        "checkpoint-after-commit" => DurabilityPhase::CheckpointAfterCommit,
        _ => panic!("Unknown boundary {boundary}"),
    };
    document
        .checkpoint(NOW, |_, _, _| Ok(()), &mut |phase| {
            if phase == target {
                pause(
                    boundary,
                    &expected,
                    &baseline,
                    json!({"snapshotAndPruneSameTransaction":true}),
                );
            }
        })
        .unwrap();
    panic!("checkpoint hook did not fire");
}
fn recover(gateway: &DatabaseGateway, boundary: &str) {
    let document = owner(gateway);
    let projection = document.native_projection().unwrap();
    let baseline = boundary == "authored-before-commit";
    let remote_only = boundary == "remote-committed-before-replay"
        || boundary == "replay-applied-before-coverage";
    let gap = boundary.starts_with("local-n-plus-two");
    let late = boundary == "local-n-plus-two-after-checkpoint";
    let local_count = u64::from(!baseline && !remote_only);
    let expected_revision = if baseline {
        0
    } else if gap {
        if late {
            3
        } else {
            2
        }
    } else {
        1
    };
    if baseline {
        assert_eq!(projection.text, "甲北塔乙\n海岸");
    } else if gap {
        assert!(projection.text.contains('远') && projection.text.contains('本'));
        assert_eq!(projection.text.contains('迟'), late);
    } else if remote_only {
        assert!(projection.text.contains('远'));
    } else {
        assert!(projection.text.contains("北\n塔"));
    }
    assert_eq!(projection.comments.len(), 1);
    assert_eq!(projection.comments[0].quote, "北塔");
    // Inserting a paragraph break inside the quote intentionally changes its
    // text. The anchor remains mapped across both blocks and reports changed.
    assert_eq!(
        projection.comments[0].status,
        if local_count == 1 && !gap {
            "changed"
        } else {
            "anchored"
        }
    );
    assert_eq!(
        projection.comments[0]
            .ranges
            .iter()
            .map(|r| r.length)
            .sum::<u32>(),
        if local_count == 1 && !gap { 3 } else { 2 }
    );
    let anchor: Value =
        serde_json::from_str(&document.comment_anchor_records()[0].anchor_json).unwrap();
    assert_eq!(anchor["futureField"]["keep"], json!([1, 2]));
    assert_eq!(anchor["selectedText"], "北塔");
    assert_eq!(
        query(gateway, "SELECT body_json FROM comment", None),
        vec![vec![text("{\"synthetic\":true}")]]
    );
    let repo = ProseRepository::new(gateway, CLIENT);
    assert_eq!(repo.get_revision(DOC, None).unwrap(), expected_revision);
    assert_eq!(
        repo.list_revision_provenance(DOC, 0, None).unwrap().len() as u64,
        expected_revision
    );
    assert_eq!(count(gateway, "sync_change_set"), local_count);
    assert_eq!(count(gateway, "sync_mutation"), local_count);
    assert_eq!(count(gateway, "sync_apply_receipt"), local_count);
    assert_eq!(count(gateway, "sync_generation_writer_state"), local_count);
    assert!(query(
        gateway,
        "SELECT change_set_id FROM sync_change_set WHERE apply_state != 'applied'",
        None
    )
    .is_empty());
    let tail = repo.list_updates(DOC, None, None).unwrap();
    let expected_tail = if baseline || boundary == "checkpoint-after-commit" {
        0
    } else if gap && !late {
        2
    } else {
        1
    };
    assert_eq!(tail.len(), expected_tail);
    assert_eq!(
        document.covered_update_id(),
        tail.last().map_or(0, |row| row.id)
    );
    assert!(!document.has_uncommitted_updates());
    assert_eq!(
        query(
            gateway,
            "SELECT name FROM project WHERE id='isolated-project'",
            None
        ),
        vec![vec![text("Untouched")]]
    );
    assert_eq!(
        repo.get_snapshot("isolated-document", None)
            .unwrap()
            .unwrap()
            .state_blob,
        vec![0, 0]
    );
    assert_eq!(
        query(gateway, "PRAGMA integrity_check", None),
        vec![vec![text("ok")]]
    );
    assert!(query(gateway, "PRAGMA foreign_key_check", None).is_empty());
    let state = summary(gateway, None);
    emit(
        json!({"event":"recovered","boundary":boundary,"stateHash":state["stateHash"],"checks":CHECKS,"details":{"updateBase64":state["updateBase64"],"semantic":state["semantic"],"revision":expected_revision,"localJournalCount":local_count,"tailCount":tail.len(),"coveredId":document.covered_update_id()}}),
    );
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 4, "mode directory boundary required");
    let gateway = gateway(Path::new(&args[2]));
    let blocked = args[3].starts_with("blocked-remote-");
    let repair = args[3].starts_with("repair-");
    let native_deletion = args[3].starts_with("native-delete-");
    let fixture = (blocked || repair).then(|| blocked_fixture(Path::new(&args[2])));
    match args[1].as_str() {
        "seed" => {
            if native_deletion {
                native_delete::seed_native(&gateway);
            } else if let Some(fixture) = &fixture {
                if repair {
                    seed_repair(&gateway, fixture);
                } else {
                    seed_blocked(&gateway, fixture);
                }
            } else {
                seed(&gateway);
            }
            let journal = query(&gateway, "PRAGMA journal_mode", None);
            let sync = query(&gateway, "PRAGMA synchronous", None);
            assert_eq!(journal, vec![vec![text("wal")]]);
            assert_eq!(sync, vec![vec![V::Integer("1".into())]]);
            emit(
                json!({"event":"seeded","boundary":args[3],"details":{"sqlite":{"journalMode":"wal","synchronous":1}}}),
            );
        }
        "crash" => {
            if native_deletion {
                native_delete::crash_native(&gateway, &args[3]);
            } else if let Some(fixture) = &fixture {
                if repair {
                    crash_repair(&gateway, &args[3], fixture);
                } else {
                    crash_blocked(&gateway, &args[3], fixture);
                }
            } else {
                crash(&gateway, &args[3]);
            }
        }
        "recover" => {
            if native_deletion {
                native_delete::recover_native(&gateway, &args[3]);
            } else if let Some(fixture) = &fixture {
                if repair {
                    recover_repair(&gateway, &args[3], fixture);
                } else {
                    recover_blocked(&gateway, &args[3], fixture);
                }
            } else {
                recover(&gateway, &args[3]);
            }
        }
        _ => panic!("Unknown worker mode"),
    }
    gateway.close(CLIENT.into()).unwrap();
}
