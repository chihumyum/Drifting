//! Real SQLite files exercise the durable owner independently of native UI.
//! Direct remote appends model the committed reducer seam; these tests do not
//! certify the separate production remote reducer or provider transport.
use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_core::database::{DatabaseGateway, DatabaseValue as V};
use drifting_core::prose::{ProseRepository, RevisionSource};
use drifting_core::prose_journal::AuthoredProseContext;
use drifting_document::{
    CommentAnchorRecord, DocumentSession, Edit, NativeRange, NativeReplacement,
};
use drifting_prose::{DurabilityPhase, DurableDocument};
use serde_json::json;

const CLIENT: &str = "synthetic-durability-integration";
const DOC: &str = "node-content:synthetic-node";
const OTHER: &str = "node-content:synthetic-other";
const NOW: &str = "2026-09-25T00:00:00.000Z";

fn text(value: &str) -> V {
    V::Text(value.into())
}

struct Fixture {
    _directory: tempfile::TempDir,
    gateway: DatabaseGateway,
    base: Vec<u8>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let gateway = DatabaseGateway::new(directory.path().into()).unwrap();
        gateway
            .open("synthetic-durability.db".into(), CLIENT.into(), false)
            .unwrap();
        for sql in [
            "INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES ('synthetic-project','Synthetic','local-user','now','now')",
            "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('synthetic-node','Synthetic prose','synthetic-project',0,0,'now','now')",
            "INSERT INTO book_node(id,title,project_id,position_x,position_y,created_at,updated_at) VALUES ('synthetic-other','Other prose','synthetic-project',0,0,'now','now')",
            "INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES ('synthetic-generation','synthetic-project','synthetic-project-sync','now','now')",
        ] { gateway.execute(sql.into(), vec![], None, CLIENT.into()).unwrap(); }
        let mut seed = DocumentSession::with_test_client_id(37001).unwrap();
        seed.edit(Edit::AppendParagraph {
            id: "body".into(),
            text: "甲北塔乙👩🏽‍🚀".into(),
        })
        .unwrap();
        let base = seed.update(None, 1).unwrap();
        // A preexisting published-format snapshot is a fixture baseline, not a
        // newly authored seed. All subsequent native authoring uses the journal.
        ProseRepository::new(&gateway, CLIENT)
            .save_snapshot(DOC, &base, NOW, None)
            .unwrap();
        Self {
            _directory: directory,
            gateway,
            base,
        }
    }

    fn owner(&self) -> DurableDocument {
        DurableDocument::open_with_scope(self.gateway.clone(), CLIENT, native_persistence::scope())
            .unwrap()
    }

    fn repo(&self) -> ProseRepository<'_> {
        ProseRepository::new(&self.gateway, CLIENT)
    }

    fn execute(&self, sql: &str) {
        self.gateway
            .execute(sql.into(), vec![], None, CLIENT.into())
            .unwrap();
    }

    fn rows(&self, sql: &str) -> Vec<Vec<V>> {
        self.gateway
            .query(sql.into(), vec![], None, CLIENT.into())
            .unwrap()
            .rows
    }

    fn count(&self, table: &str) -> u64 {
        let rows = self.rows(&format!("SELECT count(*) FROM {table}"));
        let V::Integer(value) = &rows[0][0] else {
            panic!("Invalid count");
        };
        value.parse().unwrap()
    }

    fn assert_local_journal(&self, count: u64) {
        for table in ["sync_change_set", "sync_mutation", "sync_apply_receipt"] {
            assert_eq!(self.count(table), count, "{table}");
        }
        assert_eq!(self.rows("SELECT count(*) FROM sync_change_set WHERE origin <> 'local' OR apply_state <> 'applied'")[0][0], V::Integer("0".into()));
    }

    fn append_remote(&self, doc_id: &str, bytes: &[u8]) -> u64 {
        self.repo()
            .append_update(doc_id, bytes, &RevisionSource::Remote, NOW, None, None)
            .unwrap()
            .update_id
    }
}

fn context() -> AuthoredProseContext {
    AuthoredProseContext {
        project_id: "synthetic-project".into(),
        project_sync_id: "synthetic-project-sync".into(),
        sync_generation_id: "synthetic-generation".into(),
        installation_id: "synthetic-installation".into(),
        new_writer_id: "synthetic-writer".into(),
        new_writer_epoch: "synthetic-epoch".into(),
        now_ms: 100,
        now_iso: NOW.into(),
    }
}

fn persist(owner: &mut DurableDocument) -> Result<(), String> {
    owner.persist_authored(
        &context(),
        &RevisionSource::User,
        |_, _, _| Ok(()),
        &mut |_| {},
    )
}

fn checkpoint(owner: &mut DurableDocument) -> Result<(), String> {
    owner.checkpoint(NOW, |_, _, _| Ok(()), &mut |_| {})
}

fn insert(owner: &mut DurableDocument, at: u32, value: &str) {
    owner
        .edit(Edit::Insert {
            block: "body".into(),
            offset: at,
            text: value.into(),
        })
        .unwrap();
}

fn remote_update(base: &[u8], client: u64, at: u32, value: &str) -> Vec<u8> {
    let mut peer = DocumentSession::with_test_client_id(client).unwrap();
    peer.apply_remote(base, 1).unwrap();
    let vector = peer.state_vector();
    peer.edit(Edit::Insert {
        block: "body".into(),
        offset: at,
        text: value.into(),
    })
    .unwrap();
    peer.update(Some(&vector), 1).unwrap()
}

fn comment() -> CommentAnchorRecord {
    CommentAnchorRecord {
        id: "synthetic-comment".into(),
        target_block_id: Some("body".into()),
        target_block_ids_json: "[\"body\"]".into(),
        anchor_json: json!({"selectedText":"北塔", "future":{"preserved":true},
            "blockSnapshots":[{"blockId":"body","blockText":"甲北塔乙👩🏽‍🚀"}],
            "textAnchor":{"startBlockId":"body","startOffset":1,"endBlockId":"body","endOffset":3,"text":"北塔"}}).to_string(),
    }
}

fn write_comment_cas(
    gateway: &DatabaseGateway,
    transaction: u64,
    document: &DocumentSession,
    expected: &str,
) -> Result<(), String> {
    let updated = document
        .comment_anchor_records()
        .into_iter()
        .next()
        .ok_or("Missing comment")?;
    let result = gateway.execute(
        "UPDATE comment SET anchor_json = ?, target_block_id = ?, target_block_ids_json = ? WHERE id = 'synthetic-comment' AND anchor_json = ?".into(),
        vec![text(&updated.anchor_json), updated.target_block_id.as_deref().map(text).unwrap_or(V::Null), text(&updated.target_block_ids_json), text(expected)],
        Some(transaction), CLIENT.into(),
    )?;
    if result.changes != 1 {
        return Err("Synthetic comment CAS conflict".into());
    }
    Ok(())
}

#[test]
fn failed_comment_cas_retains_authored_bytes_and_retry_never_duplicates_journal() {
    let fixture = Fixture::new();
    let comment = comment();
    fixture.gateway.execute(
        "INSERT INTO comment(id,project_id,target_kind,target_id,target_block_id,target_block_ids_json,anchor_json,body_json,created_at,updated_at) VALUES ('synthetic-comment','synthetic-project','node','synthetic-node','body','[\"body\"]',?,'{\"syntheticBody\":true}','now','now')".into(),
        vec![text(&comment.anchor_json)], None, CLIENT.into(),
    ).unwrap();
    let mut owner = fixture.owner();
    owner.set_comment_anchors(vec![comment.clone()]).unwrap();
    let revision = owner.native_projection().unwrap().revision;
    owner
        .replace_native(NativeReplacement {
            revision,
            range: NativeRange {
                location: 2,
                length: 0,
            },
            text: "\n".into(),
        })
        .unwrap();
    let authored = owner.native_projection().unwrap().text;
    fixture.execute(
        "UPDATE comment SET anchor_json = '{\"external\":true}' WHERE id = 'synthetic-comment'",
    );
    let mut phases = Vec::new();
    let error = owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, doc| write_comment_cas(gateway, tx, doc, &comment.anchor_json),
            &mut |phase| phases.push(phase),
        )
        .unwrap_err();
    assert!(error.contains("CAS conflict"));
    assert!(!phases.contains(&DurabilityPhase::AuthoredAfterCommit));
    assert!(owner.has_uncommitted_updates());
    assert_eq!(owner.native_projection().unwrap().text, authored);
    assert_eq!(owner.covered_update_id(), 0);
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), 0);
    assert!(fixture
        .repo()
        .list_updates(DOC, None, None)
        .unwrap()
        .is_empty());
    fixture.assert_local_journal(0);
    assert_eq!(fixture.count("sync_generation_writer_state"), 0);
    assert_eq!(
        fixture.rows("SELECT anchor_json FROM comment")[0][0],
        text("{\"external\":true}")
    );
    assert!(checkpoint(&mut owner)
        .unwrap_err()
        .contains("Commit authored"));

    fixture
        .gateway
        .execute(
            "UPDATE comment SET anchor_json = ? WHERE id = 'synthetic-comment'".into(),
            vec![text(&comment.anchor_json)],
            None,
            CLIENT.into(),
        )
        .unwrap();
    owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, doc| write_comment_cas(gateway, tx, doc, &comment.anchor_json),
            &mut |phase| phases.push(phase),
        )
        .unwrap();
    assert!(phases.contains(&DurabilityPhase::AuthoredAfterCommit));
    assert!(!owner.has_uncommitted_updates());
    fixture.assert_local_journal(1);
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), 1);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(owner.covered_update_id(), rows[0].id);
    persist(&mut owner).unwrap();
    fixture.assert_local_journal(1);
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), 1);
    assert_eq!(
        fixture.rows("SELECT body_json FROM comment")[0][0],
        text("{\"syntheticBody\":true}")
    );
    let durable_anchor = &fixture.rows("SELECT anchor_json FROM comment")[0][0];
    assert_eq!(
        *durable_anchor,
        text(&owner.comment_anchor_records()[0].anchor_json)
    );
    checkpoint(&mut owner).unwrap();
    drop(owner);
    assert_eq!(fixture.owner().native_projection().unwrap().text, authored);
    fixture.assert_local_journal(1);
}

#[test]
fn malformed_tail_stops_coverage_before_the_bad_row_and_forbids_compaction() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    let valid = remote_update(&fixture.base, 37002, 0, "先");
    let first = fixture.append_remote(DOC, &valid);
    let bad = fixture.append_remote(DOC, &[255]);
    let later = remote_update(&fixture.base, 37003, 11, "后");
    let last = fixture.append_remote(DOC, &later);
    assert!(first < bad && bad < last);
    assert!(owner.replay().is_err());
    assert_eq!(owner.covered_update_id(), first);
    assert_eq!(owner.native_projection().unwrap().text, "先甲北塔乙👩🏽‍🚀");
    assert!(
        !owner.has_uncommitted_updates(),
        "Remote replay must not echo into the authored log"
    );
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap().unwrap();
    let updates = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert!(checkpoint(&mut owner).is_err());
    assert_eq!(owner.covered_update_id(), first);
    assert_eq!(
        fixture.repo().get_snapshot(DOC, None).unwrap().unwrap(),
        snapshot
    );
    assert_eq!(
        fixture.repo().list_updates(DOC, None, None).unwrap(),
        updates
    );
    assert!(DurableDocument::open(fixture.gateway.clone(), CLIENT, DOC).is_err());
    fixture.assert_local_journal(0);
}

#[test]
fn received_late_text_stays_durable_uncovered_and_retry_does_not_duplicate_it() {
    let fixture = Fixture::new();
    let mut seed = DocumentSession::with_test_client_id(37100).unwrap();
    for (id, value) in [("p", "潮汐"), ("q", "夜航")] {
        seed.edit(Edit::AppendParagraph {
            id: id.into(),
            text: value.into(),
        })
        .unwrap();
    }
    let base = seed.update(None, 1).unwrap();
    let mut peer = DocumentSession::with_test_client_id(37101).unwrap();
    peer.apply_remote(&base, 1).unwrap();
    let events = peer.capture_authored_updates().unwrap();
    peer.edit(Edit::Insert {
        block: "q".into(),
        offset: 1,
        text: "保".into(),
    })
    .unwrap();
    let late = events.drain().remove(0);
    fixture.repo().save_snapshot(DOC, &base, NOW, None).unwrap();
    let mut owner = fixture.owner();
    let revision = owner.native_projection().unwrap().revision;
    owner
        .replace_native(NativeReplacement {
            revision,
            range: NativeRange {
                location: 1,
                length: 3,
            },
            text: "".into(),
        })
        .unwrap();
    persist(&mut owner).unwrap();
    checkpoint(&mut owner).unwrap();
    let baseline = owner.update(None, 1).unwrap();
    let mut active = DocumentSession::with_test_client_id(37102).unwrap();
    active.apply_remote(&baseline, 1).unwrap();
    let events = active.capture_authored_updates().unwrap();
    active
        .edit(Edit::Insert {
            block: "p".into(),
            offset: 0,
            text: "先".into(),
        })
        .unwrap();
    let first = owner
        .receive_remote(&events.drain().remove(0), 1, NOW, &mut |_| {})
        .unwrap();
    let mut phases = Vec::new();
    let blocked = owner
        .receive_remote(&late, 1, NOW, &mut |phase| phases.push(phase))
        .unwrap();
    assert_eq!(
        phases,
        vec![
            DurabilityPhase::RemoteBeforeCommit,
            DurabilityPhase::RemoteAfterCommit
        ]
    );
    active
        .edit(Edit::Insert {
            block: "p".into(),
            offset: 0,
            text: "后".into(),
        })
        .unwrap();
    let later = owner
        .receive_remote(&events.drain().remove(0), 1, NOW, &mut |_| {})
        .unwrap();
    assert!(first < blocked && blocked < later);
    assert!(owner
        .replay()
        .unwrap_err()
        .contains("REMOTE_TEXT_RETENTION_REQUIRED"));
    assert_eq!(owner.covered_update_id(), first);
    assert_eq!(owner.remote_block().unwrap().update_id, blocked);
    assert_eq!(owner.native_projection().unwrap().text, "先潮航");
    assert!(!owner.has_uncommitted_updates());
    let projection = owner.native_projection().unwrap();
    let exported = owner.update(None, 1).unwrap();
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(
        rows.iter()
            .find(|row| row.id == blocked)
            .unwrap()
            .update_blob,
        late
    );
    let revision = fixture.repo().get_revision(DOC, None).unwrap();
    for _ in 0..2 {
        assert_eq!(
            owner.receive_remote(&late, 1, NOW, &mut |_| {}).unwrap(),
            blocked
        );
        assert!(checkpoint(&mut owner)
            .unwrap_err()
            .contains("REMOTE_TEXT_RETENTION_REQUIRED"));
        assert_eq!(owner.covered_update_id(), first);
        assert_eq!(owner.native_projection().unwrap().text, projection.text);
        assert_eq!(
            owner.native_projection().unwrap().revision,
            projection.revision
        );
        assert_eq!(owner.update(None, 1).unwrap(), exported);
        assert_eq!(fixture.repo().get_snapshot(DOC, None).unwrap(), snapshot);
        assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), rows);
        assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), revision);
        let error = match DurableDocument::open(fixture.gateway.clone(), CLIENT, DOC) {
            Ok(_) => panic!("Unsafe tail must prevent cold open"),
            Err(error) => error,
        };
        assert!(
            error.contains(&format!("update {blocked} is unapplied")),
            "{error}"
        );
    }
    assert!(owner.receive_remote(&[255], 1, NOW, &mut |_| {}).is_err());
    assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), rows);
    fixture.assert_local_journal(1);
}

#[test]
fn remote_then_local_replays_actual_gapped_ids_and_recovers_lost_notifications() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    insert(&mut owner, 11, "本地");
    let foreign_first = fixture.append_remote(OTHER, &[0, 0]);
    let remote = remote_update(&fixture.base, 37004, 0, "远端");
    let remote_id = fixture.append_remote(DOC, &remote);
    let foreign_last = fixture.append_remote(OTHER, &[0, 0]);
    assert!(foreign_first < remote_id && remote_id < foreign_last);
    // No callback was delivered. Persist must first replay the earlier remote
    // row, then append its local delta and replay the actual later stored row.
    persist(&mut owner).unwrap();
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, remote_id);
    assert!(rows[1].id > foreign_last);
    assert_eq!(owner.covered_update_id(), rows[1].id);
    assert_eq!(
        owner.native_projection().unwrap().text,
        "远端甲北塔乙👩🏽‍🚀本地"
    );
    assert_eq!(
        fixture
            .repo()
            .list_revision_provenance(DOC, 0, None)
            .unwrap()
            .iter()
            .map(|row| row.source.clone())
            .collect::<Vec<_>>(),
        vec![RevisionSource::Remote, RevisionSource::User]
    );
    fixture.assert_local_journal(1);
    let next = remote_update(&owner.update(None, 1).unwrap(), 37005, 0, "再");
    let latest_id = fixture.append_remote(DOC, &next);
    assert!(!owner.native_projection().unwrap().text.starts_with("再"));
    checkpoint(&mut owner).unwrap();
    assert_eq!(owner.covered_update_id(), latest_id);
    assert_eq!(
        owner.native_projection().unwrap().text,
        "再远端甲北塔乙👩🏽‍🚀本地"
    );
    assert!(fixture
        .repo()
        .list_updates(DOC, None, None)
        .unwrap()
        .is_empty());
    assert_eq!(
        fixture
            .repo()
            .list_updates(OTHER, None, None)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), 3);
    fixture.assert_local_journal(1);
    drop(owner);
    let mut reopened = fixture.owner();
    assert_eq!(
        reopened.native_projection().unwrap().text,
        "再远端甲北塔乙👩🏽‍🚀本地"
    );
    assert!(!reopened.has_uncommitted_updates());
    checkpoint(&mut reopened).unwrap();
    fixture.assert_local_journal(1);
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), 3);
}

#[test]
fn prepared_projection_failure_does_not_publish_remote_state_or_consume_local_history() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    insert(&mut owner, 0, "本");
    let local = owner.update(None, 1).unwrap();
    let remote = remote_update(&fixture.base, 37901, 0, "远");
    let remote_id = owner.receive_remote(&remote, 1, NOW, &mut |_| {}).unwrap();
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    let mut phases = Vec::new();
    let error = owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |_, _, candidate| {
                let text = candidate.native_projection()?.text;
                assert!(text.contains('远') && text.contains('本'));
                Err("Synthetic prepared projection failure".into())
            },
            &mut |phase| phases.push(phase),
        )
        .unwrap_err();
    assert!(error.contains("prepared projection failure"));
    assert!(!phases.contains(&DurabilityPhase::AuthoredAfterCommit));
    assert_eq!(owner.update(None, 1).unwrap(), local);
    assert_eq!(owner.covered_update_id(), 0);
    assert!(owner.has_uncommitted_updates());
    assert_eq!(fixture.repo().get_snapshot(DOC, None).unwrap(), snapshot);
    assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), rows);
    fixture.assert_local_journal(0);
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), 1);
    persist(&mut owner).unwrap();
    let text = owner.native_projection().unwrap().text;
    assert_eq!(text.matches('本').count(), 1);
    assert_eq!(text.matches('远').count(), 1);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, remote_id);
    assert_eq!(owner.covered_update_id(), rows[1].id);
    fixture.assert_local_journal(1);
    assert!(owner.undo(), "Original owner lost its local undo history");
    let text = owner.native_projection().unwrap().text;
    assert!(!text.contains('本') && text.contains('远'));
}

fn quote_repair_fixture() -> (Fixture, DurableDocument, Vec<u8>) {
    // Synthetic Yjs v1 seed, client 37501: left[b=潮汐], right[c=夜航,d=终章].
    // Static bytes keep this SQLite test independent of a second CRDT crate.
    let base = STANDARD.decode("ARD9pAIABwEHZGVmYXVsdAMKYmxvY2txdW90ZQcA/aQCAAMJcGFyYWdyYXBoBwD9pAIBBgQA/aQCAgbmva7msZAoAP2kAgECaWQBdwFiKAD9pAIAAmlkAXcEbGVmdIf9pAIAAwpibG9ja3F1b3RlBwD9pAIHAwlwYXJhZ3JhcGgHAP2kAggGBAD9pAIJBuWknOiIqigA/aQCCAJpZAF3AWOH/aQCCAMJcGFyYWdyYXBoBwD9pAINBgQA/aQCDgbnu4jnq6AoAP2kAg0CaWQBdwFkKAD9pAIHAmlkAXcFcmlnaHQA").unwrap();
    let mut fixture = Fixture::new();
    fixture.base = base.clone();
    fixture.repo().save_snapshot(DOC, &base, NOW, None).unwrap();
    let comment = CommentAnchorRecord {
        id: "synthetic-comment".into(),
        target_block_id: Some("b".into()),
        target_block_ids_json: "[\"b\"]".into(),
        anchor_json: json!({"selectedText":"潮","future":{"preserved":true},"blockSnapshots":[{"blockId":"b","blockText":"潮汐"}],"textAnchor":{"startBlockId":"b","startOffset":0,"endBlockId":"b","endOffset":1,"text":"潮"}}).to_string(),
    };
    fixture.gateway.execute(
        "INSERT INTO comment(id,project_id,target_kind,target_id,target_block_id,target_block_ids_json,anchor_json,body_json,created_at,updated_at) VALUES ('synthetic-comment','synthetic-project','node','synthetic-node','b','[\"b\"]',?,'{\"syntheticBody\":true}','now','now')".into(),
        vec![text(&comment.anchor_json)], None, CLIENT.into(),
    ).unwrap();
    let mut owner = fixture.owner();
    owner.set_comment_anchors(vec![comment.clone()]).unwrap();
    let revision = owner.native_projection().unwrap().revision;
    owner
        .replace_native(NativeReplacement {
            revision,
            range: NativeRange {
                location: 1,
                length: 3,
            },
            text: String::new(),
        })
        .unwrap();
    owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, document| write_comment_cas(gateway, tx, document, &comment.anchor_json),
            &mut |_| {},
        )
        .unwrap();
    checkpoint(&mut owner).unwrap();
    assert_eq!(owner.native_projection().unwrap().text, "潮航\n终章");
    let mut peer = DocumentSession::with_test_client_id(37502).unwrap();
    peer.apply_remote(&base, 1).unwrap();
    let capture = peer.capture_authored_updates().unwrap();
    peer.edit(Edit::Insert {
        block: "b".into(),
        offset: 0,
        text: "保".into(),
    })
    .unwrap();
    let bytes = capture.drain().remove(0);
    (fixture, owner, bytes)
}

fn persisted_anchor(fixture: &Fixture) -> String {
    let V::Text(value) = &fixture.rows("SELECT anchor_json FROM comment")[0][0] else {
        panic!("anchor")
    };
    value.clone()
}

fn reload_quote_comment(fixture: &Fixture, owner: &mut DurableDocument) {
    owner
        .set_comment_anchors(vec![CommentAnchorRecord {
            id: "synthetic-comment".into(),
            target_block_id: Some("b".into()),
            target_block_ids_json: "[\"b\"]".into(),
            anchor_json: persisted_anchor(fixture),
        }])
        .unwrap();
}

fn stored_comments(fixture: &Fixture) -> Vec<CommentAnchorRecord> {
    fixture
        .rows(
            "SELECT id,anchor_json,target_block_id,target_block_ids_json FROM comment ORDER BY id",
        )
        .into_iter()
        .map(|row| {
            let [V::Text(id), V::Text(anchor), V::Text(block), V::Text(ids)] = row.as_slice()
            else {
                panic!("Invalid synthetic comment row")
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

fn write_all_comment_cas(
    gateway: &DatabaseGateway,
    transaction: u64,
    document: &DocumentSession,
    expected: &[CommentAnchorRecord],
) -> Result<(), String> {
    for updated in document.comment_anchor_records() {
        let old = expected
            .iter()
            .find(|record| record.id == updated.id)
            .ok_or("Missing synthetic comment baseline")?;
        let result = gateway.execute(
            "UPDATE comment SET anchor_json=?,target_block_id=?,target_block_ids_json=? WHERE id=? AND anchor_json=? AND target_block_id=? AND target_block_ids_json=?".into(),
            vec![text(&updated.anchor_json), updated.target_block_id.as_deref().map(text).unwrap_or(V::Null), text(&updated.target_block_ids_json), text(&updated.id), text(&old.anchor_json), old.target_block_id.as_deref().map(text).unwrap_or(V::Null), text(&old.target_block_ids_json)],
            Some(transaction), CLIENT.into(),
        )?;
        if result.changes != 1 {
            return Err("Synthetic mixed comment CAS conflict".into());
        }
    }
    Ok(())
}

fn assert_mixed_comments(
    fixture: &Fixture,
    owner: &DurableDocument,
    expected: &str,
    safe_anchor: &[u8],
) {
    let projection = owner.native_projection().unwrap();
    assert_eq!(projection.text, expected);
    let units: Vec<_> = projection.text.encode_utf16().collect();
    assert_eq!(projection.comments.len(), 2);
    for (id, quote) in [
        ("synthetic-comment", "潮"),
        ("synthetic-tail-comment", "终"),
    ] {
        let comment = projection
            .comments
            .iter()
            .find(|entry| entry.id == id)
            .unwrap();
        assert_eq!(comment.status, "anchored");
        assert_eq!(comment.quote, quote);
        assert_eq!(comment.ranges.len(), 1);
        let range = &comment.ranges[0];
        assert_eq!(
            String::from_utf16(
                &units[range.location as usize..(range.location + range.length) as usize]
            )
            .unwrap(),
            quote
        );
    }
    // The safe suffix emoji retains its peer-authored physical item identity;
    // it must never be copied into an alias namespace during repair/history.
    assert_eq!(owner.anchor("d", 1, false).unwrap(), safe_anchor);
    assert_eq!(
        owner.resolve_anchor(safe_anchor).unwrap(),
        Some(json!({"block":"d","offset":1}))
    );
    let ids: Vec<_> = projection
        .blocks
        .iter()
        .filter_map(|block| block.id.as_deref())
        .collect();
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());
    let records = owner.comment_anchor_records();
    assert_eq!(stored_comments(fixture), records);
    for record in records {
        let anchor: serde_json::Value = serde_json::from_str(&record.anchor_json).unwrap();
        assert_eq!(anchor["future"]["preserved"], true);
    }
    assert!(fixture
        .rows("SELECT body_json FROM comment ORDER BY id")
        .iter()
        .all(|row| row[0] == text("{\"syntheticBody\":true}")));
}

fn mixed_quote_fixture() -> (Fixture, DurableDocument) {
    let (fixture, mut owner, _) = quote_repair_fixture();
    let tail_comment = CommentAnchorRecord {
        id: "synthetic-tail-comment".into(),
        target_block_id: Some("d".into()),
        target_block_ids_json: "[\"d\"]".into(),
        anchor_json: json!({"selectedText":"终","future":{"preserved":true},"blockSnapshots":[{"blockId":"d","blockText":"终章"}],"textAnchor":{"startBlockId":"d","startOffset":0,"endBlockId":"d","endOffset":1,"text":"终"}}).to_string(),
    };
    fixture.gateway.execute(
        "INSERT INTO comment(id,project_id,target_kind,target_id,target_block_id,target_block_ids_json,anchor_json,body_json,created_at,updated_at) VALUES ('synthetic-tail-comment','synthetic-project','node','synthetic-node','d','[\"d\"]',?,'{\"syntheticBody\":true}','now','now')".into(),
        vec![text(&tail_comment.anchor_json)], None, CLIENT.into(),
    ).unwrap();
    owner
        .set_comment_anchors(stored_comments(&fixture))
        .unwrap();
    (fixture, owner)
}

fn replay_mixed_comments(fixture: &Fixture, owner: &mut DurableDocument) {
    let old = stored_comments(fixture);
    owner
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap();
}

fn checkpoint_mixed_comments(fixture: &Fixture, owner: &mut DurableDocument) {
    let old = stored_comments(fixture);
    owner
        .checkpoint(
            NOW,
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap();
}

fn persist_mixed_comments(fixture: &Fixture, owner: &mut DurableDocument) {
    let old = stored_comments(fixture);
    owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap();
}

fn cold_mixed_owner(fixture: &mut Fixture, owner: DurableDocument) -> DurableDocument {
    drop(owner);
    fixture.gateway.close(CLIENT.into()).unwrap();
    // New SQLite worker and new CRDT owner: no live store/history object is
    // reused to supply pending dependencies or alias proof receipts.
    fixture.gateway = DatabaseGateway::new(fixture._directory.path().into()).unwrap();
    fixture
        .gateway
        .open("synthetic-durability.db".into(), CLIENT.into(), false)
        .unwrap();
    let mut reopened = DurableDocument::open_for_replay_with_scope(
        fixture.gateway.clone(),
        CLIENT,
        native_persistence::scope(),
    )
    .unwrap();
    reopened
        .set_comment_anchors(stored_comments(fixture))
        .unwrap();
    replay_mixed_comments(fixture, &mut reopened);
    reopened
}

fn assert_system_repair_count(fixture: &Fixture, expected: usize) {
    assert_eq!(
        fixture
            .repo()
            .list_revision_provenance(DOC, 0, None)
            .unwrap()
            .iter()
            .filter(|entry| entry.source == RevisionSource::System)
            .count(),
        expected
    );
}

fn run_mixed_quote_repair_case(
    client: u64,
    edits: &[(&str, &str)],
    joined: &str,
    undone: &str,
    late_after_cold: bool,
) {
    let (mut fixture, mut owner) = mixed_quote_fixture();
    let mut peer = DocumentSession::with_test_client_id(client).unwrap();
    peer.apply_remote(&fixture.base, 1).unwrap();
    let vector = peer.state_vector();
    for (block, value) in edits {
        peer.edit(Edit::Insert {
            block: (*block).into(),
            offset: 0,
            text: (*value).into(),
        })
        .unwrap();
    }
    // The synthetic seed/plain inserts have no historical deletes. This diff
    // is a fixture packet, never a replacement for the owner's event journal.
    let packet = peer.update(Some(&vector), 1).unwrap();
    let peer_checkpoint = peer.update(None, 1).unwrap();
    let safe_anchor = peer.anchor("d", 1, false).unwrap();
    let raw_id = owner.receive_remote(&packet, 1, NOW, &mut |_| {}).unwrap();
    assert_eq!(owner.native_projection().unwrap().text, "潮航\n终章");
    let old = stored_comments(&fixture);
    owner
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap();
    assert_mixed_comments(&fixture, &owner, joined, &safe_anchor);
    assert!(!owner.has_uncommitted_updates());
    fixture.assert_local_journal(2);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, raw_id);
    assert_eq!(rows[0].update_blob, packet);
    assert_eq!(owner.covered_update_id(), rows[1].id);
    assert_eq!(fixture.count("sync_frontier"), 0);
    let journal = fixture.rows("SELECT encoded_bytes FROM sync_change_set ORDER BY change_set_id");

    for bytes in [&packet, &peer_checkpoint, &packet] {
        owner.receive_remote(bytes, 1, NOW, &mut |_| {}).unwrap();
        let old = stored_comments(&fixture);
        owner
            .replay_with_context(
                &context(),
                |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
                &mut |_| {},
            )
            .unwrap();
        assert_mixed_comments(&fixture, &owner, joined, &safe_anchor);
        assert_eq!(
            fixture.rows("SELECT encoded_bytes FROM sync_change_set ORDER BY change_set_id"),
            journal
        );
    }

    for redo in [false, true, false, true] {
        assert!(if redo {
            owner.try_redo().unwrap()
        } else {
            owner.try_undo().unwrap()
        });
        let old = stored_comments(&fixture);
        owner
            .persist_authored(
                &context(),
                &RevisionSource::User,
                |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
                &mut |_| {},
            )
            .unwrap();
        assert_mixed_comments(
            &fixture,
            &owner,
            if redo { joined } else { undone },
            &safe_anchor,
        );
    }
    assert_eq!(
        fixture
            .repo()
            .list_revision_provenance(DOC, 0, None)
            .unwrap()
            .iter()
            .filter(|entry| entry.source == RevisionSource::System)
            .count(),
        1
    );
    // Only the four authored history groups add journal entries after the join
    // and the one System repair. Remote retries/full-state delivery add none.
    fixture.assert_local_journal(6);
    let old = stored_comments(&fixture);
    owner
        .checkpoint(
            NOW,
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap();
    assert!(fixture
        .repo()
        .list_updates(DOC, None, None)
        .unwrap()
        .is_empty());
    let mut reopened = cold_mixed_owner(&mut fixture, owner);
    assert_mixed_comments(&fixture, &reopened, joined, &safe_anchor);
    fixture.assert_local_journal(6);
    assert!(!reopened.has_uncommitted_updates());
    assert!(!reopened.has_pending());
    // Undo stacks are intentionally process-local. The four history actions
    // above exercised fresh alias namespaces while the original join existed.
    assert!(!reopened.native_projection().unwrap().can_undo);
    if late_after_cold {
        let capture = peer.capture_authored_updates().unwrap();
        peer.edit(Edit::Insert {
            block: "b".into(),
            offset: 0,
            text: "再".into(),
        })
        .unwrap();
        let later = capture.drain().remove(0);
        let expected = format!("再{joined}");
        for bytes in [&later, &peer.update(None, 1).unwrap(), &later] {
            reopened.receive_remote(bytes, 1, NOW, &mut |_| {}).unwrap();
            replay_mixed_comments(&fixture, &mut reopened);
            assert_mixed_comments(&fixture, &reopened, &expected, &safe_anchor);
            fixture.assert_local_journal(7);
            assert_system_repair_count(&fixture, 2);
        }
        checkpoint_mixed_comments(&fixture, &mut reopened);
        let reopened = cold_mixed_owner(&mut fixture, reopened);
        assert_mixed_comments(&fixture, &reopened, &expected, &safe_anchor);
        fixture.assert_local_journal(7);
        assert_system_repair_count(&fixture, 2);
    }
}

#[test]
fn mixed_same_writer_prefix_and_safe_suffix_repair_journals_once_and_survives_history_reopen() {
    run_mixed_quote_repair_case(
        37511,
        &[("b", "保"), ("d", "远🙂")],
        "保潮航\n远🙂终章",
        "保潮汐\n夜航\n远🙂终章",
        false,
    );
}

#[test]
fn safe_clock_gap_between_original_prefix_inserts_preserves_two_history_cycles_and_cold_replay() {
    run_mixed_quote_repair_case(
        37512,
        &[("b", "保"), ("d", "远🙂"), ("b", "续")],
        "续保潮航\n远🙂终章",
        "续保潮汐\n夜航\n远🙂终章",
        true,
    );
}

#[test]
fn safe_clock_gap_pending_last_prefix_survives_checkpoint_prune_cold_open_and_dependency_comment_cas(
) {
    let (mut fixture, mut owner) = mixed_quote_fixture();
    let mut peer = DocumentSession::with_test_client_id(37513).unwrap();
    peer.apply_remote(&fixture.base, 1).unwrap();
    let vector = peer.state_vector();
    let capture = peer.capture_authored_updates().unwrap();
    peer.edit(Edit::Insert {
        block: "b".into(),
        offset: 0,
        text: "保".into(),
    })
    .unwrap();
    peer.edit(Edit::Insert {
        block: "d".into(),
        offset: 0,
        text: "远🙂".into(),
    })
    .unwrap();
    // The final b item below has an actual origin dependency on the first b
    // item. A d-before-b packet without that origin may integrate a Skip instead
    // of remaining pending and is intentionally outside this recovery case.
    assert_eq!(capture.drain().len(), 2);
    let dependency = peer.update(Some(&vector), 1).unwrap();
    let safe_anchor = peer.anchor("d", 1, false).unwrap();
    peer.edit(Edit::Insert {
        block: "b".into(),
        offset: 0,
        text: "续".into(),
    })
    .unwrap();
    let dependent = capture.drain().remove(0);
    let full_state = peer.update(None, 1).unwrap();

    let pending_id = owner
        .receive_remote(&dependent, 1, NOW, &mut |_| {})
        .unwrap();
    replay_mixed_comments(&fixture, &mut owner);
    assert_eq!(owner.native_projection().unwrap().text, "潮航\n终章");
    assert!(owner.has_pending());
    assert!(!owner.has_uncommitted_updates());
    assert!(owner.remote_block().is_none());
    assert_eq!(owner.covered_update_id(), pending_id);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].update_blob, dependent);
    fixture.assert_local_journal(1);
    assert_system_repair_count(&fixture, 0);

    let pending_checkpoint = owner.update(None, 1).unwrap();
    checkpoint_mixed_comments(&fixture, &mut owner);
    assert_eq!(
        fixture
            .repo()
            .get_snapshot(DOC, None)
            .unwrap()
            .unwrap()
            .state_blob,
        pending_checkpoint
    );
    assert!(fixture
        .repo()
        .list_updates(DOC, None, None)
        .unwrap()
        .is_empty());
    owner = cold_mixed_owner(&mut fixture, owner);
    assert!(
        owner.has_pending(),
        "Cold snapshot discarded the undelivered source clocks"
    );
    // A cold CRDT owner may GC deleted items previously pinned by the live
    // undo stack. The exact committed snapshot remains unchanged; use this
    // owner's own export for subsequent atomicity checks.
    assert_eq!(
        fixture
            .repo()
            .get_snapshot(DOC, None)
            .unwrap()
            .unwrap()
            .state_blob,
        pending_checkpoint
    );
    let cold_pending_state = owner.update(None, 1).unwrap();
    assert_eq!(owner.native_projection().unwrap().text, "潮航\n终章");
    assert!(!owner.native_projection().unwrap().can_undo);
    fixture.assert_local_journal(1);

    // A failure in the second comment CAS rolls back the first comment, repair
    // journal, and snapshot together, without consuming the pending b bytes.
    let expected_comments = stored_comments(&fixture);
    let incoming = owner
        .receive_remote(&dependency, 1, NOW, &mut |_| {})
        .unwrap();
    fixture.execute(
        "UPDATE comment SET anchor_json='{\"external\":true}' WHERE id='synthetic-tail-comment'",
    );
    let before_comments = stored_comments(&fixture);
    let before_snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
    let error = owner
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| {
                write_all_comment_cas(gateway, tx, candidate, &expected_comments)
            },
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.contains("CAS conflict"), "{error}");
    assert_eq!(owner.update(None, 1).unwrap(), cold_pending_state);
    assert!(owner.has_pending());
    assert_eq!(stored_comments(&fixture), before_comments);
    assert_eq!(
        fixture.repo().get_snapshot(DOC, None).unwrap(),
        before_snapshot
    );
    fixture.assert_local_journal(1);
    assert_system_repair_count(&fixture, 0);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, incoming);
    assert_eq!(rows[0].update_blob, dependency);
    let tail = expected_comments
        .iter()
        .find(|value| value.id == "synthetic-tail-comment")
        .unwrap();
    fixture
        .gateway
        .execute(
            "UPDATE comment SET anchor_json=? WHERE id='synthetic-tail-comment'".into(),
            vec![text(&tail.anchor_json)],
            None,
            CLIENT.into(),
        )
        .unwrap();

    replay_mixed_comments(&fixture, &mut owner);
    let joined = "续保潮航\n远🙂终章";
    assert_mixed_comments(&fixture, &owner, joined, &safe_anchor);
    assert!(!owner.has_pending());
    assert!(!owner.has_uncommitted_updates());
    assert!(owner.remote_block().is_none());
    fixture.assert_local_journal(2);
    assert_system_repair_count(&fixture, 1);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].update_blob, dependency);
    assert_eq!(owner.covered_update_id(), rows[1].id);
    let journal = fixture.rows("SELECT encoded_bytes FROM sync_change_set ORDER BY change_set_id");
    for bytes in [&dependent, &dependency, &full_state, &dependent] {
        owner.receive_remote(bytes, 1, NOW, &mut |_| {}).unwrap();
        replay_mixed_comments(&fixture, &mut owner);
        assert_mixed_comments(&fixture, &owner, joined, &safe_anchor);
        assert_eq!(
            fixture.rows("SELECT encoded_bytes FROM sync_change_set ORDER BY change_set_id"),
            journal
        );
        assert_system_repair_count(&fixture, 1);
    }
    // Cold open has no original join undo stack; newly authored native history
    // remains usable and must preserve both remote positions and item identity.
    owner
        .edit(Edit::Insert {
            block: "d".into(),
            offset: 5,
            text: "本".into(),
        })
        .unwrap();
    persist_mixed_comments(&fixture, &mut owner);
    assert_mixed_comments(&fixture, &owner, "续保潮航\n远🙂终章本", &safe_anchor);
    assert!(owner.try_undo().unwrap());
    persist_mixed_comments(&fixture, &mut owner);
    assert_mixed_comments(&fixture, &owner, joined, &safe_anchor);
    fixture.assert_local_journal(4);
    checkpoint_mixed_comments(&fixture, &mut owner);
    assert!(fixture
        .repo()
        .list_updates(DOC, None, None)
        .unwrap()
        .is_empty());
    let mut reopened = cold_mixed_owner(&mut fixture, owner);
    for bytes in [&full_state, &dependent, &dependency] {
        reopened.receive_remote(bytes, 1, NOW, &mut |_| {}).unwrap();
        replay_mixed_comments(&fixture, &mut reopened);
        assert_mixed_comments(&fixture, &reopened, joined, &safe_anchor);
        fixture.assert_local_journal(4);
        assert_system_repair_count(&fixture, 1);
    }
}

#[test]
fn derived_repair_snapshot_failure_rolls_back_journal_comments_and_live_then_cold_retry_commits_once(
) {
    let (fixture, mut owner, remote) = quote_repair_fixture();
    let incoming = owner.receive_remote(&remote, 1, NOW, &mut |_| {}).unwrap();
    let baseline = owner.update(None, 1).unwrap();
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    let revision = fixture.repo().get_revision(DOC, None).unwrap();
    let old_anchor = persisted_anchor(&fixture);
    let writer = fixture.rows("SELECT * FROM sync_generation_writer_state ORDER BY writer_id");
    assert!(owner
        .replay()
        .unwrap_err()
        .contains("REMOTE_REPAIR_PERSISTENCE_REQUIRED"));
    assert_eq!(owner.update(None, 1).unwrap(), baseline);
    let cold_error = match DurableDocument::open(fixture.gateway.clone(), CLIENT, DOC) {
        Ok(_) => panic!("Cold replay must not manufacture an unjournaled repair"),
        Err(error) => error,
    };
    assert!(
        cold_error.contains("REMOTE_REPAIR_PERSISTENCE_REQUIRED"),
        "{cold_error}"
    );
    fixture.execute("CREATE TRIGGER fail_repair_snapshot BEFORE UPDATE ON yjs_snapshots BEGIN SELECT RAISE(ABORT,'synthetic repair snapshot failed'); END");
    let mut phases = Vec::new();
    let error = owner
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| {
                assert_eq!(candidate.native_projection()?.text, "保潮航\n终章");
                write_comment_cas(gateway, tx, candidate, &old_anchor)
            },
            &mut |phase| phases.push(phase),
        )
        .unwrap_err();
    assert!(error.contains("repair snapshot failed"), "{error}");
    assert!(!phases.contains(&DurabilityPhase::ReplayAfterCommit));
    assert_eq!(owner.update(None, 1).unwrap(), baseline);
    assert!(owner.covered_update_id() < incoming);
    assert_eq!(fixture.repo().get_snapshot(DOC, None).unwrap(), snapshot);
    assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), rows);
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), revision);
    assert_eq!(persisted_anchor(&fixture), old_anchor);
    assert_eq!(
        fixture.rows("SELECT * FROM sync_generation_writer_state ORDER BY writer_id"),
        writer
    );
    fixture.assert_local_journal(1);
    fixture.execute("DROP TRIGGER fail_repair_snapshot");
    drop(owner);
    let mut reopened = DurableDocument::open_for_replay_with_scope(
        fixture.gateway.clone(),
        CLIENT,
        native_persistence::scope(),
    )
    .unwrap();
    reload_quote_comment(&fixture, &mut reopened);
    reopened
        .replay_with_context(
            &context(),
            |gateway, tx, document| write_comment_cas(gateway, tx, document, &old_anchor),
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(reopened.native_projection().unwrap().text, "保潮航\n终章");
    assert!(
        !reopened.has_uncommitted_updates(),
        "Repair entered the user authored observer"
    );
    fixture.assert_local_journal(2);
    assert_eq!(
        fixture.count("sync_frontier"),
        0,
        "Repair manufactured a remote applied frontier"
    );
    let tail = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(tail.len(), 2);
    assert_eq!(tail[0].id, incoming);
    assert_eq!(tail[0].update_blob, remote);
    assert_eq!(reopened.covered_update_id(), tail[1].id);
    assert_eq!(
        fixture
            .repo()
            .list_revision_provenance(DOC, 0, None)
            .unwrap()
            .last()
            .unwrap()
            .source,
        RevisionSource::System
    );
    let comments = reopened.comment_anchor_records();
    assert_eq!(persisted_anchor(&fixture), comments[0].anchor_json);
    assert_eq!(
        fixture.rows("SELECT body_json FROM comment")[0][0],
        text("{\"syntheticBody\":true}")
    );
    let before_retry =
        fixture.rows("SELECT encoded_bytes FROM sync_change_set ORDER BY change_set_id");
    reopened
        .replay_with_context(&context(), |_, _, _| Ok(()), &mut |_| {})
        .unwrap();
    assert_eq!(
        fixture.rows("SELECT encoded_bytes FROM sync_change_set ORDER BY change_set_id"),
        before_retry
    );
    drop(reopened);
    let mut reopened = fixture.owner();
    assert_eq!(reopened.native_projection().unwrap().text, "保潮航\n终章");
    reopened
        .receive_remote(&remote, 1, NOW, &mut |_| {})
        .unwrap();
    reopened
        .replay_with_context(&context(), |_, _, _| Ok(()), &mut |_| {})
        .unwrap();
    assert_eq!(
        reopened
            .native_projection()
            .unwrap()
            .text
            .matches('保')
            .count(),
        1
    );
    fixture.assert_local_journal(2);
    checkpoint(&mut reopened).unwrap();
    drop(reopened);
    assert_eq!(
        fixture.owner().native_projection().unwrap().text,
        "保潮航\n终章"
    );
}

#[test]
fn pending_local_and_derived_repair_commit_together_after_comment_cas_retry_without_undoing_remote_text(
) {
    let (fixture, mut owner, remote) = quote_repair_fixture();
    let received = owner.receive_remote(&remote, 1, NOW, &mut |_| {}).unwrap();
    owner
        .edit(Edit::Insert {
            block: "d".into(),
            offset: 0,
            text: "本".into(),
        })
        .unwrap();
    let live = owner.update(None, 1).unwrap();
    let old_anchor = persisted_anchor(&fixture);
    fixture.execute(
        "UPDATE comment SET anchor_json='{\"external\":true}' WHERE id='synthetic-comment'",
    );
    assert!(owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, document| write_comment_cas(gateway, tx, document, &old_anchor),
            &mut |_| {}
        )
        .unwrap_err()
        .contains("CAS conflict"));
    assert_eq!(owner.update(None, 1).unwrap(), live);
    assert!(owner.has_uncommitted_updates());
    assert!(owner.covered_update_id() < received);
    fixture.assert_local_journal(1);
    assert_eq!(
        fixture.repo().list_updates(DOC, None, None).unwrap().len(),
        1
    );
    fixture
        .gateway
        .execute(
            "UPDATE comment SET anchor_json=? WHERE id='synthetic-comment'".into(),
            vec![text(&old_anchor)],
            None,
            CLIENT.into(),
        )
        .unwrap();
    owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, document| write_comment_cas(gateway, tx, document, &old_anchor),
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(owner.native_projection().unwrap().text, "保潮航\n本终章");
    fixture.assert_local_journal(3);
    assert_eq!(
        fixture.repo().list_updates(DOC, None, None).unwrap().len(),
        3
    );
    assert!(!owner.has_uncommitted_updates());
    assert!(
        owner.undo(),
        "The original local edit history must survive prepared replay"
    );
    assert_eq!(owner.native_projection().unwrap().text, "保潮航\n终章");
}

#[test]
fn snapshot_and_prune_failures_leave_reopenable_rows_and_retry_does_not_rejournal() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    insert(&mut owner, 0, "已提交");
    persist(&mut owner).unwrap();
    let expected = owner.native_projection().unwrap().text;
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap().unwrap();
    let tail = fixture.repo().list_updates(DOC, None, None).unwrap();
    for (trigger, statement, has_snapshot_phase) in [
        ("fail_snapshot", "CREATE TRIGGER fail_snapshot BEFORE UPDATE ON yjs_snapshots BEGIN SELECT RAISE(ABORT,'synthetic snapshot failure'); END", false),
        ("fail_prune", "CREATE TRIGGER fail_prune BEFORE DELETE ON yjs_updates BEGIN SELECT RAISE(ABORT,'synthetic prune failure'); END", true),
    ] {
        fixture.execute(statement);
        let mut phases = Vec::new();
        assert!(owner.checkpoint(NOW, |_, _, _| Ok(()), &mut |phase| phases.push(phase)).is_err());
        assert_eq!(phases.contains(&DurabilityPhase::CheckpointAfterSnapshot), has_snapshot_phase);
        assert!(!phases.contains(&DurabilityPhase::CheckpointAfterCommit));
        assert_eq!(fixture.repo().get_snapshot(DOC, None).unwrap().unwrap(), snapshot);
        assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), tail);
        assert_eq!(fixture.owner().native_projection().unwrap().text, expected);
        fixture.assert_local_journal(1);
        fixture.execute(&format!("DROP TRIGGER {trigger}"));
    }
    let mut phases = Vec::new();
    owner
        .checkpoint(NOW, |_, _, _| Ok(()), &mut |phase| phases.push(phase))
        .unwrap();
    assert_eq!(
        phases,
        vec![
            DurabilityPhase::CheckpointAfterSnapshot,
            DurabilityPhase::CheckpointAfterPrune,
            DurabilityPhase::CheckpointAfterCommit
        ]
    );
    assert!(fixture
        .repo()
        .list_updates(DOC, None, None)
        .unwrap()
        .is_empty());
    assert_eq!(fixture.owner().native_projection().unwrap().text, expected);
    assert_eq!(fixture.repo().get_revision(DOC, None).unwrap(), 1);
    fixture.assert_local_journal(1);
}

struct BlockedClosure {
    fixture: Fixture,
    owner: DurableDocument,
    blocked: Vec<u8>,
    dependency: Vec<u8>,
    full: Vec<u8>,
    safe_anchor: Vec<u8>,
    blocked_id: u64,
}

fn blocked_closure_fixture() -> BlockedClosure {
    blocked_closure_fixture_with_leading_safe(false)
}

fn blocked_closure_fixture_with_leading_safe(leading: bool) -> BlockedClosure {
    let (fixture, mut owner) = mixed_quote_fixture();
    let mut peer = DocumentSession::with_test_client_id(37901).unwrap();
    peer.apply_remote(&fixture.base, 1).unwrap();
    let capture = peer.capture_authored_updates().unwrap();
    peer.edit(Edit::Insert {
        block: "d".into(),
        offset: 0,
        text: "远🙂".into(),
    })
    .unwrap();
    let dependency = capture.drain().remove(0);
    peer.edit(Edit::Insert {
        block: "b".into(),
        offset: 0,
        text: "保".into(),
    })
    .unwrap();
    let blocked = capture.drain().remove(0);
    let full = peer.update(None, 1).unwrap();
    let safe_anchor = peer.anchor("d", 1, false).unwrap();
    let before = owner.update(None, 1).unwrap();
    let covered = owner.covered_update_id();
    if leading {
        let mut earlier = DocumentSession::with_test_client_id(37900).unwrap();
        earlier.apply_remote(&fixture.base, 1).unwrap();
        let capture = earlier.capture_authored_updates().unwrap();
        earlier
            .edit(Edit::SetAttribute {
                block: "d".into(),
                key: "futureSuffix".into(),
                value: json!("safe-before-block"),
            })
            .unwrap();
        owner
            .receive_remote(&capture.drain().remove(0), 1, NOW, &mut |_| {})
            .unwrap();
    }
    let blocked_id = owner.receive_remote(&blocked, 1, NOW, &mut |_| {}).unwrap();
    let old = stored_comments(&fixture);
    let error = owner
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &old),
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.contains("REMOTE_TEXT_RETENTION_REQUIRED"), "{error}");
    assert_eq!(owner.remote_block().unwrap().update_id, blocked_id);
    assert_eq!(owner.update(None, 1).unwrap(), before);
    assert_eq!(owner.covered_update_id(), covered);
    assert_eq!(
        owner.receive_remote(&blocked, 1, NOW, &mut |_| {}).unwrap(),
        blocked_id
    );
    fixture.assert_local_journal(1);
    assert_system_repair_count(&fixture, 0);
    BlockedClosure {
        fixture,
        owner,
        blocked,
        dependency,
        full,
        safe_anchor,
        blocked_id,
    }
}

#[test]
fn lookahead_releases_first_retained_row_only_after_complete_durable_dependency_and_replays_actual_gapped_ids(
) {
    let BlockedClosure {
        mut fixture,
        mut owner,
        blocked,
        dependency,
        full,
        safe_anchor,
        blocked_id,
    } = blocked_closure_fixture();
    let other = fixture.append_remote(OTHER, &dependency);
    let dependency_id = owner
        .receive_remote(&dependency, 1, NOW, &mut |_| {})
        .unwrap();
    assert!(blocked_id < other && other < dependency_id);
    replay_mixed_comments(&fixture, &mut owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
    assert!(owner.remote_block().is_none());
    assert!(!owner.has_pending());
    assert!(!owner.has_uncommitted_updates());
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!((rows[0].id, &rows[0].update_blob), (blocked_id, &blocked));
    assert_eq!(
        (rows[1].id, &rows[1].update_blob),
        (dependency_id, &dependency)
    );
    assert_eq!(owner.covered_update_id(), rows[2].id);
    assert_eq!(fixture.count("sync_frontier"), 0);
    assert_system_repair_count(&fixture, 1);
    fixture.assert_local_journal(2);
    for bytes in [&full, &blocked, &dependency, &full] {
        owner.receive_remote(bytes, 1, NOW, &mut |_| {}).unwrap();
        replay_mixed_comments(&fixture, &mut owner);
        assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
        assert_system_repair_count(&fixture, 1);
        fixture.assert_local_journal(2);
    }
    for redo in [false, true, false, true] {
        assert!(if redo {
            owner.try_redo().unwrap()
        } else {
            owner.try_undo().unwrap()
        });
        persist_mixed_comments(&fixture, &mut owner);
        assert_mixed_comments(
            &fixture,
            &owner,
            if redo {
                "保潮航\n远🙂终章"
            } else {
                "保潮汐\n夜航\n远🙂终章"
            },
            &safe_anchor,
        );
        assert_system_repair_count(&fixture, 1);
    }
    checkpoint_mixed_comments(&fixture, &mut owner);
    let owner = cold_mixed_owner(&mut fixture, owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
    assert_system_repair_count(&fixture, 1);
}

#[test]
fn lookahead_cold_recovery_uses_stored_full_closure_without_duplicate_system_journal() {
    let BlockedClosure {
        mut fixture,
        mut owner,
        blocked,
        full,
        safe_anchor,
        blocked_id,
        ..
    } = blocked_closure_fixture();
    let full_id = owner.receive_remote(&full, 1, NOW, &mut |_| {}).unwrap();
    let mut owner = cold_mixed_owner(&mut fixture, owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!((rows[0].id, &rows[0].update_blob), (blocked_id, &blocked));
    assert_eq!((rows[1].id, &rows[1].update_blob), (full_id, &full));
    assert_eq!(owner.covered_update_id(), rows[2].id);
    owner.receive_remote(&full, 1, NOW, &mut |_| {}).unwrap();
    replay_mixed_comments(&fixture, &mut owner);
    let owner = cold_mixed_owner(&mut fixture, owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
    assert_system_repair_count(&fixture, 1);
    fixture.assert_local_journal(2);
}

#[test]
fn lookahead_malformed_formatted_and_still_pending_tail_members_reject_the_entire_candidate() {
    for kind in ["malformed", "format", "pending"] {
        let BlockedClosure {
            fixture,
            mut owner,
            dependency,
            blocked_id,
            ..
        } = blocked_closure_fixture();
        owner
            .receive_remote(&dependency, 1, NOW, &mut |_| {})
            .unwrap();
        let extra = if kind == "malformed" {
            vec![255]
        } else {
            let mut peer = DocumentSession::with_test_client_id(37902).unwrap();
            peer.apply_remote(&fixture.base, 1).unwrap();
            let capture = peer.capture_authored_updates().unwrap();
            if kind == "format" {
                peer.edit(Edit::Format {
                    block: "b".into(),
                    offset: 0,
                    length: 1,
                    attributes: serde_json::from_value(json!({"bold":true})).unwrap(),
                })
                .unwrap();
            } else {
                peer.edit(Edit::AppendParagraph {
                    id: "unseen".into(),
                    text: "缺".into(),
                })
                .unwrap();
                capture.drain();
                peer.edit(Edit::SetAttribute {
                    block: "unseen".into(),
                    key: "future".into(),
                    value: json!("pending"),
                })
                .unwrap();
            }
            capture.drain().remove(0)
        };
        let extra_id = fixture.append_remote(DOC, &extra);
        let before = owner.update(None, 1).unwrap();
        let covered = owner.covered_update_id();
        let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
        let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
        let comments = stored_comments(&fixture);
        let error = owner
            .replay_with_context(
                &context(),
                |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &comments),
                &mut |_| {},
            )
            .unwrap_err();
        if kind == "malformed" {
            assert!(
                error.contains(&format!("invalid row {extra_id}")),
                "{error}"
            );
        }
        if kind == "pending" {
            assert!(error.contains("REMOTE_TEXT_RETENTION_REQUIRED"), "{error}");
        }
        assert_eq!(owner.remote_block().unwrap().update_id, blocked_id);
        assert_eq!(owner.update(None, 1).unwrap(), before, "{kind}");
        assert_eq!(owner.covered_update_id(), covered, "{kind}");
        assert_eq!(
            fixture.repo().get_snapshot(DOC, None).unwrap(),
            snapshot,
            "{kind}"
        );
        assert_eq!(
            fixture.repo().list_updates(DOC, None, None).unwrap(),
            rows,
            "{kind}"
        );
        assert_eq!(stored_comments(&fixture), comments, "{kind}");
        assert_system_repair_count(&fixture, 0);
        fixture.assert_local_journal(1);
    }
}

#[test]
fn lookahead_comment_cas_rollback_preserves_raw_receipts_live_state_and_retry() {
    let BlockedClosure {
        fixture,
        mut owner,
        dependency,
        safe_anchor,
        ..
    } = blocked_closure_fixture();
    owner
        .receive_remote(&dependency, 1, NOW, &mut |_| {})
        .unwrap();
    let expected = stored_comments(&fixture);
    fixture.execute(
        "UPDATE comment SET anchor_json='{\"external\":true}' WHERE id='synthetic-tail-comment'",
    );
    let before = owner.update(None, 1).unwrap();
    let covered = owner.covered_update_id();
    let blocked_status = owner.remote_block().cloned();
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    let comments = stored_comments(&fixture);
    let error = owner
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &expected),
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.contains("CAS conflict"), "{error}");
    assert_eq!(owner.update(None, 1).unwrap(), before);
    assert_eq!(owner.covered_update_id(), covered);
    assert_eq!(owner.remote_block().cloned(), blocked_status);
    assert_eq!(fixture.repo().get_snapshot(DOC, None).unwrap(), snapshot);
    assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), rows);
    assert_eq!(stored_comments(&fixture), comments);
    assert_system_repair_count(&fixture, 0);
    fixture.assert_local_journal(1);
    let tail = expected
        .iter()
        .find(|value| value.id == "synthetic-tail-comment")
        .unwrap();
    fixture
        .gateway
        .execute(
            "UPDATE comment SET anchor_json=? WHERE id='synthetic-tail-comment'".into(),
            vec![text(&tail.anchor_json)],
            None,
            CLIENT.into(),
        )
        .unwrap();
    replay_mixed_comments(&fixture, &mut owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
    assert_system_repair_count(&fixture, 1);
    fixture.assert_local_journal(2);
}

#[test]
fn lookahead_preceding_safe_step_and_pending_local_event_commit_with_one_basis_and_local_only_undo()
{
    let BlockedClosure {
        fixture,
        mut owner,
        dependency,
        safe_anchor,
        ..
    } = blocked_closure_fixture_with_leading_safe(true);
    owner
        .edit(Edit::Insert {
            block: "d".into(),
            offset: 2,
            text: "本".into(),
        })
        .unwrap();
    let local = owner.update(None, 1).unwrap();
    let covered = owner.covered_update_id();
    let dependency_id = owner
        .receive_remote(&dependency, 1, NOW, &mut |_| {})
        .unwrap();
    let comments = stored_comments(&fixture);
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
    let error = owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |gateway, tx, candidate| {
                write_all_comment_cas(gateway, tx, candidate, &comments)?;
                Err("Synthetic projection abort after all comment writes".into())
            },
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.contains("projection abort"));
    assert_eq!(owner.update(None, 1).unwrap(), local);
    assert_eq!(owner.covered_update_id(), covered);
    assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), rows);
    assert_eq!(fixture.repo().get_snapshot(DOC, None).unwrap(), snapshot);
    assert_eq!(stored_comments(&fixture), comments);
    assert!(owner.has_uncommitted_updates());
    assert!(!owner
        .semantic()
        .unwrap()
        .to_string()
        .contains("safe-before-block"));
    fixture.assert_local_journal(1);
    persist_mixed_comments(&fixture, &mut owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章本", &safe_anchor);
    assert!(owner
        .semantic()
        .unwrap()
        .to_string()
        .contains("safe-before-block"));
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(rows.len(), 5); // safe, blocked, dependency, exact local, System.
    assert_eq!(rows[2].id, dependency_id);
    assert_eq!(owner.covered_update_id(), rows[4].id);
    fixture.assert_local_journal(3);
    assert_system_repair_count(&fixture, 1);
    assert!(!owner.has_uncommitted_updates());
    assert!(owner.try_undo().unwrap());
    persist_mixed_comments(&fixture, &mut owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
    assert!(owner.try_undo().unwrap());
    persist_mixed_comments(&fixture, &mut owner);
    assert_mixed_comments(&fixture, &owner, "保潮汐\n夜航\n远🙂终章", &safe_anchor);
    assert_system_repair_count(&fixture, 1);
    fixture.assert_local_journal(5);
}

#[test]
fn lookahead_committed_snapshot_survives_interrupt_before_live_apply_without_repair_echo() {
    let BlockedClosure {
        mut fixture,
        mut owner,
        dependency,
        safe_anchor,
        ..
    } = blocked_closure_fixture();
    owner
        .receive_remote(&dependency, 1, NOW, &mut |_| {})
        .unwrap();
    let before = owner.update(None, 1).unwrap();
    let covered = owner.covered_update_id();
    let comments = stored_comments(&fixture);
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        owner
            .replay_with_context(
                &context(),
                |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &comments),
                &mut |phase| {
                    if phase == DurabilityPhase::ReplayAfterCommit {
                        panic!("synthetic after-COMMIT interruption")
                    }
                },
            )
            .unwrap();
    }));
    assert!(interrupted.is_err());
    assert_eq!(owner.update(None, 1).unwrap(), before);
    assert_eq!(owner.covered_update_id(), covered);
    assert_system_repair_count(&fixture, 1);
    fixture.assert_local_journal(2);
    let owner = cold_mixed_owner(&mut fixture, owner);
    assert_mixed_comments(&fixture, &owner, "保潮航\n远🙂终章", &safe_anchor);
    assert_system_repair_count(&fixture, 1);
    fixture.assert_local_journal(2);
}

#[test]
fn lookahead_explicit_cancellation_without_derived_repair_remains_atomically_retained_by_owner_scope(
) {
    let BlockedClosure {
        fixture,
        mut owner,
        blocked,
        dependency,
        full,
        blocked_id,
        ..
    } = blocked_closure_fixture();
    let mut peer = DocumentSession::with_test_client_id(37903).unwrap();
    peer.apply_remote(&full, 1).unwrap();
    let capture = peer.capture_authored_updates().unwrap();
    peer.edit(Edit::Delete {
        block: "b".into(),
        offset: 0,
        length: 1,
    })
    .unwrap();
    let cancellation = capture.drain().remove(0);
    let cancelled_full = peer.update(None, 1).unwrap();
    // The document's established explicit-delete semantics are valid. This
    // owner rollout deliberately handles alias-derived closure repairs only.
    let mut candidate = owner.fork_for_remote_replay().unwrap();
    let prepared = candidate
        .prepare_remote_batch(&[&blocked, &dependency, &cancellation])
        .unwrap();
    assert!(prepared.repair_update().is_none());
    candidate.apply_prepared_remote(&prepared).unwrap();
    assert!(!candidate.has_pending());
    assert_eq!(
        candidate.native_projection().unwrap().text,
        "潮航\n远🙂终章"
    );
    owner
        .receive_remote(&dependency, 1, NOW, &mut |_| {})
        .unwrap();
    owner
        .receive_remote(&cancellation, 1, NOW, &mut |_| {})
        .unwrap();
    owner
        .receive_remote(&cancelled_full, 1, NOW, &mut |_| {})
        .unwrap();
    let before = owner.update(None, 1).unwrap();
    let covered = owner.covered_update_id();
    let snapshot = fixture.repo().get_snapshot(DOC, None).unwrap();
    let rows = fixture.repo().list_updates(DOC, None, None).unwrap();
    let comments = stored_comments(&fixture);
    let error = owner
        .replay_with_context(
            &context(),
            |gateway, tx, candidate| write_all_comment_cas(gateway, tx, candidate, &comments),
            &mut |_| {},
        )
        .unwrap_err();
    assert!(
        error.contains("requires an explicit alias repair"),
        "{error}"
    );
    assert_eq!(owner.remote_block().unwrap().update_id, blocked_id);
    assert_eq!(owner.update(None, 1).unwrap(), before);
    assert_eq!(owner.covered_update_id(), covered);
    assert_eq!(fixture.repo().get_snapshot(DOC, None).unwrap(), snapshot);
    assert_eq!(fixture.repo().list_updates(DOC, None, None).unwrap(), rows);
    assert_eq!(stored_comments(&fixture), comments);
    assert_system_repair_count(&fixture, 0);
    fixture.assert_local_journal(1);
}

#[path = "durability/native_persistence.rs"]
mod native_persistence;
