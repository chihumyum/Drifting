use super::*;
use yrs::{IdSet, Snapshot};

fn source() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(65301).unwrap();
    seed.edit(Edit::AppendParagraph {
        id: "p".into(),
        text: "甲乙丙".into(),
    })
    .unwrap();
    let mut peer = DocumentSession::with_test_client_id(65302).unwrap();
    peer.apply_remote(&seed.update(None, 1).unwrap(), 1)
        .unwrap();
    peer.edit(Edit::Insert {
        block: "p".into(),
        offset: 1,
        text: "中🙂".into(),
    })
    .unwrap();
    let mut owner = DocumentSession::with_test_client_id(65303).unwrap();
    owner
        .apply_remote(&peer.update(None, 1).unwrap(), 1)
        .unwrap();
    owner
}
fn content(owner: &DocumentSession) -> String {
    owner.native_projection().unwrap().text
}
fn open(owner: &mut DocumentSession, draft: bool, at: u32, len: u32) {
    if draft {
        owner
            .begin_draft(NativeDraftStart {
                key: "q".into(),
                revision: owner.revision,
                range: NativeRange {
                    location: at,
                    length: len,
                },
            })
            .unwrap();
    } else {
        owner.fork_input("q".into(), None).unwrap();
    }
}
fn input(sequence: u64, at: u32, len: u32, text: &str) -> NativeInputEdit {
    NativeInputEdit {
        key: "q".into(),
        sequence,
        range: NativeRange {
            location: at,
            length: len,
        },
        text: text.into(),
        selection: None,
    }
}
fn commit(owner: &mut DocumentSession, draft: bool, at: u32, len: u32) {
    if draft {
        owner
            .commit_draft(NativeDraftCommit {
                key: "q".into(),
                text: "".into(),
                selection: None,
            })
            .unwrap();
    } else {
        owner.replace_input(input(0, at, len, "")).unwrap();
    }
}
fn remote(owner: &mut DocumentSession, edits: Vec<Edit>) {
    let mut peer = DocumentSession::with_test_client_id(65304).unwrap();
    peer.apply_remote(&owner.update(None, 1).unwrap(), 1)
        .unwrap();
    let sv = peer.state_vector();
    for edit in edits {
        peer.edit(edit).unwrap();
    }
    owner
        .apply_remote(&peer.update(Some(&sv), 1).unwrap(), 1)
        .unwrap();
}
fn insert(at: u32, text: &str) -> Edit {
    Edit::Insert {
        block: "p".into(),
        offset: at,
        text: text.into(),
    }
}
fn delete(at: u32, len: u32) -> Edit {
    Edit::Delete {
        block: "p".into(),
        offset: at,
        length: len,
    }
}
fn selected(owner: &DocumentSession, at: u32, len: u32) -> IdSet {
    let txn = owner.doc.transact();
    let p = owner.editable_block(&txn, "p").unwrap();
    let Some(XmlOut::Text(text)) = p.get(&txn, 0) else {
        panic!()
    };
    let mut ids = IdSet::new();
    for offset in at..at + len {
        ids.insert(
            *text
                .sticky_index(&txn, offset, Assoc::After)
                .unwrap()
                .id()
                .unwrap(),
            1,
        );
    }
    ids
}
fn verify(record: &CapturedAuthoredUpdate, before: &Snapshot, ids: &IdSet, at: u32, len: u32) {
    let proof = record
        .deletion()
        .expect("contiguous live deletion is classified");
    assert_eq!(
        Snapshot::decode_v1(proof.transaction().before_snapshot()).unwrap(),
        *before
    );
    assert_eq!(proof.intent().offset_utf16(), at);
    assert_eq!(proof.intent().length_utf16(), len);
    let update = Update::decode_v1(record.update()).unwrap();
    assert!(update.insertions(true).is_empty());
    assert_eq!(update.delete_set(), ids);
    let declared = proof.intent().selected_source_ranges().iter().map(|range| {
        (
            yrs::ClientID::new(range.client()),
            [range.clock()..range.clock() + range.length()],
        )
    });
    assert_eq!(IdSet::from_iter(declared), *ids);
}
fn history(owner: &mut DocumentSession, log: &AuthoredUpdateLog, before: &str, after: &str) {
    for _ in 0..2 {
        assert!(owner.undo());
        assert_eq!(content(owner), before);
        assert!(owner.redo());
        assert_eq!(content(owner), after);
    }
    assert!(log.drain_records().iter().all(|r| r.deletion().is_none()));
    let mut reopened = DocumentSession::new();
    reopened
        .apply_remote(&owner.update(None, 1).unwrap(), 1)
        .unwrap();
    assert_eq!(content(&reopened), after);
}

#[test]
fn queued_evidence_rebuilds_live_snapshot_offset_and_cross_client_emoji_ids_after_prefix_insert() {
    for draft in [false, true] {
        let mut owner = source();
        open(&mut owner, draft, 1, 4);
        let old = owner.doc.transact().snapshot();
        let log = owner.capture_authored_updates().unwrap();
        remote(&mut owner, vec![insert(0, "远端")]);
        let live = owner.doc.transact().snapshot();
        assert_ne!(old, live);
        let ids = selected(&owner, 3, 4);
        assert_eq!(ids.len(), 2);
        commit(&mut owner, draft, 1, 4);
        assert_eq!(content(&owner), "远端甲丙");
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        verify(&records[0], &live, &ids, 3, 4);
        history(&mut owner, &log, "远端甲中🙂乙丙", "远端甲丙");
    }
}
#[test]
fn queued_evidence_excludes_already_remote_deleted_ids_and_never_undoes_remote_deletion() {
    for draft in [false, true] {
        let mut owner = source();
        open(&mut owner, draft, 1, 4);
        let original = selected(&owner, 1, 4);
        let log = owner.capture_authored_updates().unwrap();
        remote(&mut owner, vec![delete(1, 1), insert(0, "远")]);
        let live = owner.doc.transact().snapshot();
        let ids = selected(&owner, 2, 3);
        assert_ne!(ids, original);
        assert_eq!(ids, original.diff(&live.delete_set));
        commit(&mut owner, draft, 1, 4);
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        verify(&records[0], &live, &ids, 2, 3);
        assert_eq!(content(&owner), "远甲丙");
        history(&mut owner, &log, "远甲🙂乙丙", "远甲丙");
    }
}
#[test]
fn queued_evidence_interior_remote_insertion_stays_raw_without_deleting_or_claiming_remote_text() {
    for draft in [false, true] {
        let mut owner = source();
        open(&mut owner, draft, 1, 4);
        let old = selected(&owner, 1, 4);
        let log = owner.capture_authored_updates().unwrap();
        remote(&mut owner, vec![insert(2, "远")]);
        commit(&mut owner, draft, 1, 4);
        assert_eq!(content(&owner), "甲远丙");
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        assert!(records[0].deletion().is_none());
        assert_eq!(
            Update::decode_v1(records[0].update()).unwrap().delete_set(),
            &old
        );
        history(&mut owner, &log, "甲中远🙂乙丙", "甲远丙");
    }
}
#[test]
fn queued_evidence_all_remote_deleted_produces_no_event_but_consumes_successful_sequence_once() {
    let mut owner = source();
    open(&mut owner, false, 1, 4);
    let log = owner.capture_authored_updates().unwrap();
    remote(&mut owner, vec![delete(1, 4)]);
    let bytes = owner.update(None, 1).unwrap();
    commit(&mut owner, false, 1, 4);
    assert_eq!(content(&owner), "甲丙");
    assert_eq!(owner.update(None, 1).unwrap(), bytes);
    assert!(log.is_empty());
    assert!(!owner.undo());
    assert!(owner.replace_input(input(0, 1, 4, "")).is_err());
    assert!(log.is_empty());
    owner.replace_input(input(1, 1, 0, "续")).unwrap();
    assert_eq!(content(&owner), "甲续丙");
    let records = log.drain_records();
    assert_eq!(records.len(), 1);
    assert!(records[0].deletion().is_none());
}
#[test]
fn queued_evidence_rapid_followup_uses_visible_branch_ids_and_distinct_live_bases() {
    let mut owner = source();
    open(&mut owner, false, 1, 1);
    let log = owner.capture_authored_updates().unwrap();
    remote(&mut owner, vec![insert(0, "远")]);
    let first = owner.doc.transact().snapshot();
    let ids = selected(&owner, 2, 1);
    assert_eq!(
        owner.replace_input(input(0, 1, 1, "")).unwrap().text,
        "甲🙂乙丙"
    );
    let first_record = log.drain_records();
    verify(&first_record[0], &first, &ids, 2, 1);
    let second = owner.doc.transact().snapshot();
    let ids = selected(&owner, 2, 2);
    assert_eq!(
        owner.replace_input(input(1, 1, 2, "")).unwrap().text,
        "甲乙丙"
    );
    let record = log.drain_records();
    verify(&record[0], &second, &ids, 2, 2);
    assert_ne!(first, second);
    assert_eq!(content(&owner), "远甲乙丙");
    assert!(owner.undo());
    assert_eq!(content(&owner), "远甲🙂乙丙");
    assert!(owner.undo());
    assert_eq!(content(&owner), "远甲中🙂乙丙");
    assert!(log.drain_records().iter().all(|r| r.deletion().is_none()));
}
#[test]
fn queued_evidence_failed_sequence_selection_and_half_emoji_leave_live_and_capture_unchanged() {
    for kind in ["sequence", "half-emoji", "selection"] {
        let mut owner = source();
        open(&mut owner, false, 1, 4);
        owner
            .set_selection(NativeSelectionRequest {
                view_id: "view".into(),
                epoch: 5,
                revision: owner.revision,
                range: NativeRange {
                    location: 0,
                    length: 0,
                },
            })
            .unwrap();
        let log = owner.capture_authored_updates().unwrap();
        let before = owner.update(None, 1).unwrap();
        let revision = owner.revision;
        let mut edit = if kind == "half-emoji" {
            input(0, 3, 1, "")
        } else {
            input(0, 1, 4, "")
        };
        if kind == "sequence" {
            edit.sequence = 9;
        }
        if kind == "selection" {
            edit.selection = Some(NativeDraftSelection {
                view_id: "view".into(),
                epoch: 4,
                range: NativeRange {
                    location: 1,
                    length: 0,
                },
            });
        }
        assert!(owner.replace_input(edit).is_err(), "{kind}");
        assert_eq!(owner.update(None, 1).unwrap(), before);
        assert_eq!(owner.revision, revision);
        assert!(log.is_empty());
        assert!(!owner.undo());
        assert!(owner
            .authored_capture
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .command
            .is_none());
        owner.replace_input(input(0, 1, 4, "")).unwrap();
        assert!(log.drain_records()[0].deletion().is_some());
    }
}
#[test]
fn queued_evidence_insert_replace_structural_and_remote_format_changes_are_unclassified() {
    for kind in ["insert", "replace", "split", "remote-format"] {
        let mut owner = source();
        open(&mut owner, false, 1, 1);
        let log = owner.capture_authored_updates().unwrap();
        if kind == "remote-format" {
            remote(
                &mut owner,
                vec![Edit::Format {
                    block: "p".into(),
                    offset: 1,
                    length: 1,
                    attributes: serde_json::from_value(json!({"bold":true})).unwrap(),
                }],
            );
        }
        let edit = match kind {
            "insert" => input(0, 1, 0, "续"),
            "replace" => input(0, 1, 1, "换"),
            "split" => input(0, 1, 0, "\n"),
            _ => input(0, 1, 1, ""),
        };
        owner.replace_input(edit).unwrap();
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        assert!(records[0].deletion().is_none(), "{kind}");
    }
}
