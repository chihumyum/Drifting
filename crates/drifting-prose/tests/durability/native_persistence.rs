use super::*;
use drifting_core::original_body_archive::{ArchiveScope, OriginalBodyArchiveStore};
use drifting_core::original_operation::{MutationTarget, OriginalOperationRef};
use drifting_core::original_operation_store::OriginalOperationStore;
use drifting_core::prose_journal::AuthoredProseJournal;
use drifting_document::{NativeDraftCommit, NativeDraftStart, NativeInputEdit};

pub(super) fn scope() -> ArchiveScope {
    ArchiveScope {
        project_id: context().project_id,
        project_sync_id: context().project_sync_id,
        sync_generation_id: context().sync_generation_id,
        document_id: DOC.into(),
        incarnation: 0,
    }
}

fn journaled_fixture() -> Fixture {
    let f = Fixture::new();
    // Capture an actual seed event with the identical synthetic identities.
    let mut seed = DocumentSession::with_test_client_id(37001).unwrap();
    let log = seed.capture_authored_updates().unwrap();
    seed.edit(Edit::AppendParagraph {
        id: "body".into(),
        text: "甲北塔乙👩🏽‍🚀".into(),
    })
    .unwrap();
    let records = log.drain_records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].update(), f.base);
    AuthoredProseJournal::new(&f.gateway, CLIENT)
        .append(
            &context(),
            DOC,
            records[0].update(),
            &RevisionSource::User,
            None,
            None,
            |repo, tx| {
                let (doc, _) = drifting_prose::load_document(repo, DOC, tx)?;
                doc.prepare_remote(records[0].update(), 1).map(|_| ())
            },
        )
        .unwrap();
    f
}

fn references(f: &Fixture) -> Vec<OriginalOperationRef> {
    f.rows("SELECT c.change_set_id,c.payload_sha256,m.payload_sha256,m.incarnation FROM sync_change_set c JOIN sync_mutation m USING(change_set_id) ORDER BY c.device_seq")
        .into_iter().map(|r| {
            let [V::Text(id),V::Text(envelope),V::Text(payload),V::Integer(incarnation)] = r.as_slice() else { panic!("Unexpected journal shape") };
            OriginalOperationRef {
                project_id: context().project_id,
                project_sync_id: context().project_sync_id,
                sync_generation_id: context().sync_generation_id,
                change_set_id: id.clone(), mutation_index: 0,
                target: MutationTarget { family:"yjs".into(),kind:"prose-document".into(),id:DOC.into(),incarnation:incarnation.parse().unwrap() },
                payload_sha256:format!("sha256:{payload}"), original_envelope_sha256:envelope.clone(),
            }
        }).collect()
}

/// Optional synthetic export for the portable cross-language acceptance runner.
/// Ordinary cargo tests never write into the checkout.
fn export_wire(
    f: &Fixture,
    name: &str,
    reference: &OriginalOperationRef,
    before: &[u8],
    after: &[u8],
) {
    let Some(directory) = std::env::var_os("NATIVE_AUTHORING_WIRE_DIR") else {
        return;
    };
    let original = OriginalOperationStore::new(&f.gateway, CLIENT)
        .load_verified(reference)
        .unwrap();
    let rows = f
        .gateway
        .query(
            "SELECT encoded_bytes FROM sync_change_set WHERE change_set_id=?".into(),
            vec![text(&reference.change_set_id)],
            None,
            CLIENT.into(),
        )
        .unwrap();
    let V::Blob(envelope) = &rows.rows[0][0] else {
        panic!("Missing original envelope")
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join(format!("{name}.json")),
        serde_json::to_vec_pretty(&json!({
            "envelopeBase64":STANDARD.encode(envelope),"originalReference":reference,
            "beforeBase64":STANDARD.encode(before),"afterBase64":STANDARD.encode(after),
            "exactUpdateBase64":STANDARD.encode(original.exact_update())
        }))
        .unwrap(),
    )
    .unwrap();
}

fn durable(f: &Fixture) -> Vec<Vec<Vec<V>>> {
    [
        "yjs_snapshots",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "sync_generation_writer_state",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "comment",
        "workspace_projection_clock",
        "sqlite_sequence",
        "sync_generation",
        "sync_entity_lifecycle",
        "sync_generation_purge",
    ]
    .into_iter()
    .map(|table| f.rows(&format!("SELECT * FROM {table} ORDER BY rowid")))
    .collect()
}

fn delete(owner: &mut DurableDocument, location: u32, length: u32) {
    let revision = owner.native_projection().unwrap().revision;
    owner
        .replace_native(NativeReplacement {
            revision,
            range: NativeRange { location, length },
            text: String::new(),
        })
        .unwrap();
}

#[test]
fn native_delete_record_survives_projection_failure_and_later_input_before_retry() {
    let f = journaled_fixture();
    let c = comment();
    f.gateway.execute("INSERT INTO comment(id,project_id,target_kind,target_id,anchor_json,body_json,created_at,updated_at) VALUES ('synthetic-comment','synthetic-project','node','synthetic-node',?,'{}','now','now')".into(),vec![text(&c.anchor_json)],None,CLIENT.into()).unwrap();
    let mut owner = f.owner();
    owner.set_comment_anchors(vec![c]).unwrap();
    let baseline = durable(&f);
    delete(&mut owner, 1, 2);
    let error = owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |db, tx, _| {
                db.execute(
                    "UPDATE comment SET body_json='changed' WHERE id='synthetic-comment'".into(),
                    vec![],
                    Some(tx),
                    CLIENT.into(),
                )?;
                Err("injected late projection failure".into())
            },
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.contains("late projection"));
    assert_eq!(durable(&f), baseline);
    assert!(owner.has_uncommitted_updates());
    assert_eq!(owner.native_projection().unwrap().text, "甲乙👩🏽‍🚀");
    // New input must append behind the retained whole record, without executing
    // the failed deletion again or replacing its beforeSnapshot.
    insert(&mut owner, 1, "新");
    persist(&mut owner).unwrap();
    assert!(!owner.has_uncommitted_updates());
    assert_eq!(owner.native_projection().unwrap().text, "甲新乙👩🏽‍🚀");
    let refs = references(&f);
    assert_eq!(refs.len(), 3);
    let store = OriginalOperationStore::new(&f.gateway, CLIENT);
    let original = store.load_verified(&refs[1]).unwrap();
    assert_eq!(original.intent().offset_utf16, 1);
    assert_eq!(original.intent().length_utf16, 2);
    let rows = f.repo().list_updates(DOC, None, None).unwrap();
    assert_eq!(original.exact_update(), rows[1].update_blob);
    assert!(store.load_verified(&refs[0]).is_err());
    assert!(store.load_verified(&refs[2]).is_err());
    let archive = OriginalBodyArchiveStore::new(&f.gateway, CLIENT)
        .load_original_bodies(&scope(), &[])
        .unwrap();
    assert_eq!(archive.bodies().len(), 3);
    assert!(archive
        .bodies()
        .iter()
        .any(|body| body.source() == &refs[1] && body.update() == original.exact_update()));
    let committed = durable(&f);
    persist(&mut owner).unwrap();
    assert_eq!(durable(&f), committed);
    checkpoint(&mut owner).unwrap();
    drop(owner);
    assert_eq!(f.owner().native_projection().unwrap().text, "甲新乙👩🏽‍🚀");
    assert!(OriginalOperationStore::new(&f.gateway, CLIENT)
        .load_verified(&refs[1])
        .is_ok());
}

#[test]
fn sequential_native_declarations_rollback_as_one_batch_without_sequence_holes() {
    let f = journaled_fixture();
    let mut owner = f.owner();
    let baseline = durable(&f);
    delete(&mut owner, 1, 1);
    delete(&mut owner, 1, 1);
    f.execute("CREATE TRIGGER reject_second_capture BEFORE INSERT ON sync_apply_receipt WHEN (SELECT count(*) FROM sync_apply_receipt)=2 BEGIN SELECT RAISE(ABORT,'injected second capture receipt failure'); END");
    let error = persist(&mut owner).unwrap_err();
    assert!(error.contains("second capture receipt"), "{error}");
    assert_eq!(durable(&f), baseline);
    assert!(owner.has_uncommitted_updates());
    f.execute("DROP TRIGGER reject_second_capture");
    persist(&mut owner).unwrap();
    assert_eq!(owner.native_projection().unwrap().text, "甲乙👩🏽‍🚀");
    let refs = references(&f);
    assert_eq!(refs.len(), 3);
    let store = OriginalOperationStore::new(&f.gateway, CLIENT);
    let first = store.load_verified(&refs[1]).unwrap();
    let second = store.load_verified(&refs[2]).unwrap();
    assert_ne!(first.before_snapshot(), second.before_snapshot());
    assert_eq!(first.intent().length_utf16, 1);
    assert_eq!(second.intent().length_utf16, 1);
    assert_ne!(
        first.intent().selected_source_ranges,
        second.intent().selected_source_ranges
    );
    assert_eq!(
        f.rows("SELECT device_seq FROM sync_change_set ORDER BY device_seq"),
        vec![
            vec![V::Integer("1".into())],
            vec![V::Integer("2".into())],
            vec![V::Integer("3".into())]
        ]
    );
    checkpoint(&mut owner).unwrap();
    assert_eq!(f.owner().native_projection().unwrap().text, "甲乙👩🏽‍🚀");
}

#[test]
fn actual_native_multiclient_deletion_keeps_exact_event_through_original_store() {
    let f = journaled_fixture();
    let mut owner = f.owner();
    insert(&mut owner, 2, "外");
    persist(&mut owner).unwrap();
    let before = owner.update(None, 1).unwrap();
    delete(&mut owner, 1, 3);
    let after = owner.update(None, 1).unwrap();
    persist(&mut owner).unwrap();
    assert_eq!(owner.native_projection().unwrap().text, "甲乙👩🏽‍🚀");
    let refs = references(&f);
    export_wire(&f, "native-multiclient", &refs[2], &before, &after);
    let original = OriginalOperationStore::new(&f.gateway, CLIENT)
        .load_verified(&refs[2])
        .unwrap();
    let clients: std::collections::BTreeSet<_> = original
        .intent()
        .selected_source_ranges
        .iter()
        .map(|r| r.client)
        .collect();
    assert_eq!(clients.len(), 2);
    assert_eq!(
        original.exact_update(),
        f.repo().list_updates(DOC, None, None).unwrap()[2].update_blob
    );
    checkpoint(&mut owner).unwrap();
    assert_eq!(f.owner().native_projection().unwrap().text, "甲乙👩🏽‍🚀");
}

#[test]
fn native_history_and_generic_delete_do_not_gain_standalone_command_intent() {
    let f = journaled_fixture();
    let mut owner = f.owner();
    let before = owner.update(None, 1).unwrap();
    delete(&mut owner, 1, 2);
    let after = owner.update(None, 1).unwrap();
    persist(&mut owner).unwrap();
    export_wire(&f, "native-plain", &references(&f)[1], &before, &after);
    assert!(owner.undo());
    persist(&mut owner).unwrap();
    assert!(owner.redo());
    persist(&mut owner).unwrap();
    owner
        .edit(Edit::Delete {
            block: "body".into(),
            offset: 0,
            length: 1,
        })
        .unwrap();
    persist(&mut owner).unwrap();
    let refs = references(&f);
    assert_eq!(refs.len(), 5);
    let store = OriginalOperationStore::new(&f.gateway, CLIENT);
    assert!(store.load_verified(&refs[1]).is_ok());
    for index in [0, 2, 3, 4] {
        assert!(store.load_verified(&refs[index]).is_err());
    }
    assert_eq!(owner.native_projection().unwrap().text, "乙👩🏽‍🚀");
    checkpoint(&mut owner).unwrap();
    assert_eq!(f.owner().native_projection().unwrap().text, "乙👩🏽‍🚀");
}

#[test]
fn queued_and_draft_commands_persist_live_basis_without_deleting_remote_insertions() {
    for queued in [false, true] {
        for interior in [false, true] {
            let f = journaled_fixture();
            let mut owner = f.owner();
            let revision = owner.native_projection().unwrap().revision;
            if queued {
                owner.fork_input("synthetic-input".into(), None).unwrap();
            } else {
                owner
                    .begin_draft(NativeDraftStart {
                        key: "synthetic-input".into(),
                        revision,
                        range: NativeRange {
                            location: 1,
                            length: 2,
                        },
                    })
                    .unwrap();
            }
            let remote = remote_update(&f.base, 37004, if interior { 2 } else { 0 }, "远");
            f.append_remote(DOC, &remote);
            owner.replay().unwrap();
            let before = owner.update(None, 1).unwrap();
            if queued {
                owner
                    .replace_input(NativeInputEdit {
                        key: "synthetic-input".into(),
                        sequence: 0,
                        range: NativeRange {
                            location: 1,
                            length: 2,
                        },
                        text: String::new(),
                        selection: None,
                    })
                    .unwrap();
            } else {
                owner
                    .commit_draft(NativeDraftCommit {
                        key: "synthetic-input".into(),
                        text: String::new(),
                        selection: None,
                    })
                    .unwrap();
            }
            let expected = if interior {
                "甲远乙👩🏽‍🚀"
            } else {
                "远甲乙👩🏽‍🚀"
            };
            assert_eq!(owner.native_projection().unwrap().text, expected);
            let baseline = durable(&f);
            owner
                .persist_authored(
                    &context(),
                    &RevisionSource::User,
                    |_, _, _| Err("fail after actual command".into()),
                    &mut |_| {},
                )
                .unwrap_err();
            assert_eq!(durable(&f), baseline);
            let after = owner.update(None, 1).unwrap();
            persist(&mut owner).unwrap();
            let refs = references(&f);
            assert_eq!(refs.len(), 2);
            let original = OriginalOperationStore::new(&f.gateway, CLIENT).load_verified(&refs[1]);
            if interior {
                assert!(
                    original.is_err(),
                    "Noncontiguous source deletion must remain raw"
                );
            } else {
                let original = original.unwrap();
                assert_eq!(original.intent().offset_utf16, 2);
                export_wire(
                    &f,
                    if queued {
                        "native-queued"
                    } else {
                        "native-draft"
                    },
                    &refs[1],
                    &before,
                    &after,
                );
                assert_eq!(original.intent().length_utf16, 2);
                assert_eq!(
                    original.exact_update(),
                    f.repo().list_updates(DOC, None, None).unwrap()[2].update_blob
                );
            }
            checkpoint(&mut owner).unwrap();
            assert_eq!(f.owner().native_projection().unwrap().text, expected);
        }
    }
}

fn advance_native_incarnation(f: &Fixture, transaction: Option<u64>) -> Result<(), String> {
    // Reference the actual immutable seed journal to satisfy the published FK.
    // This is a catalog transition fixture, not a claimed full restore reducer.
    f.gateway.execute(
        "INSERT INTO sync_entity_lifecycle(sync_generation_id,entity_kind,entity_id,incarnation,state,hlc_wall_ms,hlc_counter,writer_id,writer_epoch,device_seq,change_set_id,mutation_index) VALUES ('synthetic-generation','node','synthetic-node',1,'live',1,0,'synthetic-lifecycle','epoch',1,?,0)".into(),
        vec![text("synthetic-writer:synthetic-epoch:1")],
        transaction,
        CLIENT.into(),
    )?;
    Ok(())
}

#[test]
fn native_captured_deletion_refuses_changed_incarnation_without_losing_record() {
    let f = journaled_fixture();
    let mut owner = f.owner();
    delete(&mut owner, 1, 2);
    let captured = owner.update(None, 1).unwrap();
    let coverage = owner.covered_update_id();
    advance_native_incarnation(&f, None).unwrap();
    let baseline = durable(&f);
    for _ in 0..2 {
        let error = persist(&mut owner).unwrap_err();
        assert!(error.contains("incarnation"), "{error}");
        assert!(owner.has_uncommitted_updates());
        assert_eq!(owner.update(None, 1).unwrap(), captured);
        assert_eq!(owner.covered_update_id(), coverage);
        assert_eq!(durable(&f), baseline);
    }
    assert!(DurableDocument::open_with_scope(f.gateway.clone(), CLIENT, scope()).is_err());
    assert!(
        DurableDocument::open_for_replay_with_scope(f.gateway.clone(), CLIENT, scope()).is_err()
    );
    assert_eq!(durable(&f), baseline);
}

#[test]
fn native_captured_deletion_rechecks_scope_after_projection_callback_and_retries() {
    let f = journaled_fixture();
    let mut owner = f.owner();
    delete(&mut owner, 1, 2);
    let captured = owner.update(None, 1).unwrap();
    let coverage = owner.covered_update_id();
    let baseline = durable(&f);
    let error = owner
        .persist_authored(
            &context(),
            &RevisionSource::User,
            |_, tx, _| advance_native_incarnation(&f, Some(tx)),
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.contains("incarnation"), "{error}");
    assert!(owner.has_uncommitted_updates());
    assert_eq!(owner.update(None, 1).unwrap(), captured);
    assert_eq!(owner.covered_update_id(), coverage);
    assert_eq!(durable(&f), baseline);
    persist(&mut owner).unwrap();
    assert!(!owner.has_uncommitted_updates());
    let refs = references(&f);
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[1].target.incarnation, 0);
    let original = OriginalOperationStore::new(&f.gateway, CLIENT)
        .load_verified(&refs[1])
        .unwrap();
    assert_eq!(original.intent().offset_utf16, 1);
    assert_eq!(original.intent().length_utf16, 2);
    assert_eq!(owner.native_projection().unwrap().text, "甲乙👩🏽‍🚀");
    let committed = durable(&f);
    persist(&mut owner).unwrap();
    assert_eq!(durable(&f), committed);
}

#[test]
fn unscoped_native_deletion_refuses_persistence_and_retains_complete_record_after_later_input() {
    let f = journaled_fixture();
    let mut owner = DurableDocument::open(f.gateway.clone(), CLIENT, DOC).unwrap();
    delete(&mut owner, 1, 2);
    let baseline = durable(&f);
    let error = persist(&mut owner).unwrap_err();
    assert!(error.to_lowercase().contains("scope"), "{error}");
    assert!(owner.has_uncommitted_updates());
    assert_eq!(durable(&f), baseline);
    insert(&mut owner, 1, "新");
    let captured = owner.update(None, 1).unwrap();
    for _ in 0..2 {
        let error = persist(&mut owner).unwrap_err();
        assert!(error.to_lowercase().contains("scope"), "{error}");
        assert!(owner.has_uncommitted_updates());
        assert_eq!(owner.native_projection().unwrap().text, "甲新乙👩🏽‍🚀");
        assert_eq!(owner.update(None, 1).unwrap(), captured);
        assert_eq!(durable(&f), baseline);
    }
    // No retry may silently drop the declaration and fall back to a raw update.
    assert_eq!(references(&f).len(), 1);
}

#[test]
fn review_scoped_plain_replay_refuses_changed_incarnation_before_live_or_coverage_changes() {
    let f = journaled_fixture();
    let mut owner = f.owner();
    let captured = owner.update(None, 1).unwrap();
    let coverage = owner.covered_update_id();
    advance_native_incarnation(&f, None).unwrap();
    let remote = remote_update(&f.base, 98807, 1, "外");
    f.append_remote(DOC, &remote);
    let baseline = durable(&f);
    let result = owner.replay();
    eprintln!(
        "REVIEW stale plain replay result={result:?}; text={:?}; coverage={coverage}->{}",
        owner.native_projection().unwrap().text,
        owner.covered_update_id()
    );
    assert!(
        result.is_err(),
        "scoped owner accepted tail after its incarnation changed"
    );
    assert_eq!(owner.update(None, 1).unwrap(), captured);
    assert_eq!(owner.covered_update_id(), coverage);
    assert_eq!(durable(&f), baseline);
}
