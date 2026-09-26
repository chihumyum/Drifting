use super::*;
use crate::native_command::{NativeCommandScope, TrackedCommandOrigin};
use std::sync::{Arc, Mutex};
use yrs::{IdSet, Snapshot, ID};

fn seeded() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(64501).unwrap();
    seed.edit(Edit::AppendParagraph {
        id: "a".into(),
        text: "甲乙丙".into(),
    })
    .unwrap();
    let mut peer = DocumentSession::with_test_client_id(64502).unwrap();
    peer.apply_remote(&seed.update(None, 1).unwrap(), 1)
        .unwrap();
    peer.edit(Edit::Insert {
        block: "a".into(),
        offset: 1,
        text: "中🙂".into(),
    })
    .unwrap();
    let mut live = DocumentSession::with_test_client_id(64503).unwrap();
    live.apply_remote(&peer.update(None, 1).unwrap(), 1)
        .unwrap();
    live
}
fn request(live: &DocumentSession, location: u32, length: u32, text: &str) -> NativeReplacement {
    NativeReplacement {
        revision: live.revision,
        range: NativeRange { location, length },
        text: text.into(),
    }
}
fn replace(live: &mut DocumentSession, at: u32, len: u32, text: &str) {
    let request = request(live, at, len, text);
    live.replace_native(request).unwrap();
}
fn text(live: &DocumentSession) -> String {
    live.native_projection().unwrap().text
}
fn target(live: &DocumentSession) -> XmlTextRef {
    let txn = live.doc.transact();
    let element = live.editable_block(&txn, "a").unwrap();
    let Some(XmlOut::Text(text)) = element.get(&txn, 0) else {
        panic!()
    };
    text
}
fn state(live: &DocumentSession) -> (Vec<u8>, String, u64, usize, usize) {
    (
        live.update(None, 1).unwrap(),
        text(live),
        live.revision,
        live.undo.undo_stack().len(),
        live.undo.redo_stack().len(),
    )
}

#[test]
fn native_command_captures_actual_chinese_emoji_and_multiple_source_items() {
    for (at, len, expected) in [(1, 1, "甲🙂乙丙"), (2, 2, "甲中乙丙"), (0, 5, "丙")] {
        let mut live = seeded();
        let before = live.doc.transact().snapshot();
        let retained = live.update(None, 1).unwrap();
        let xml = target(&live);
        let expected_ids = {
            let txn = live.doc.transact();
            (at..at + len)
                .map(|i| {
                    xml.sticky_index(&txn, i, Assoc::After)
                        .unwrap()
                        .id()
                        .copied()
                        .unwrap()
                })
                .collect::<Vec<_>>()
        };
        let mut selected = IdSet::new();
        for id in expected_ids {
            selected.insert(id, 1);
        }
        let log = live.capture_authored_updates().unwrap();
        replace(&mut live, at, len, "");
        assert_eq!(text(&live), expected);
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        let record = &records[0];
        let proof = record.deletion().expect("real native deletion");
        assert_eq!(
            Snapshot::decode_v1(proof.transaction().before_snapshot()).unwrap(),
            before
        );
        assert_eq!(proof.intent().offset_utf16(), at);
        assert_eq!(proof.intent().length_utf16(), len);
        assert_eq!(
            proof.intent().selected_source_ranges(),
            proof.transaction().transaction_deletes()
        );
        let actual = Update::decode_v1(record.update()).unwrap();
        assert!(actual.insertions(true).is_empty());
        assert_eq!(actual.delete_set(), &selected);
        let id = yrs::branch::BranchID::Nested(ID::new(
            yrs::ClientID::new(proof.intent().target_text().client()),
            proof.intent().target_text().clock(),
        ));
        assert_eq!(
            id,
            <XmlTextRef as AsRef<yrs::branch::Branch>>::as_ref(&xml).id()
        );
        let mut replica = DocumentSession::new();
        replica.apply_remote(&retained, 1).unwrap();
        replica.apply_remote(record.update(), 1).unwrap();
        assert_eq!(text(&replica), expected);
        assert!(log.is_empty());
    }
}

#[test]
fn native_command_does_not_classify_noop_insert_replace_structure_or_private_primitive() {
    for kind in [
        "noop", "insert", "replace", "split", "join", "private", "generic", "format",
    ] {
        let mut live = seeded();
        if kind == "join" {
            live.edit(Edit::AppendParagraph {
                id: "b".into(),
                text: "尾".into(),
            })
            .unwrap();
        }
        if kind == "format" {
            live.edit(Edit::Format {
                block: "a".into(),
                offset: 1,
                length: 1,
                attributes: serde_json::from_value(json!({"bold":true})).unwrap(),
            })
            .unwrap();
        }
        let log = live.capture_authored_updates().unwrap();
        match kind {
            "noop" => replace(&mut live, 1, 0, ""),
            "insert" => replace(&mut live, 1, 0, "入"),
            "replace" => replace(&mut live, 1, 1, "换"),
            "split" => replace(&mut live, 1, 0, "\n"),
            "join" => replace(&mut live, 5, 2, ""),
            "private" => {
                let edit = request(&live, 1, 1, "");
                live.replace_native_prose(edit).unwrap();
            }
            "generic" => live
                .edit(Edit::Delete {
                    block: "a".into(),
                    offset: 1,
                    length: 1,
                })
                .unwrap(),
            "format" => replace(&mut live, 1, 1, ""),
            _ => unreachable!(),
        }
        let records = log.drain_records();
        assert_eq!(records.is_empty(), kind == "noop", "{kind}");
        assert!(records.iter().all(|r| r.deletion().is_none()), "{kind}");
    }
}

#[test]
fn native_command_rejections_leave_bytes_history_and_capture_unchanged() {
    for kind in ["stale", "half-emoji-start", "half-emoji-end", "outside"] {
        let mut live = seeded();
        let log = live.capture_authored_updates().unwrap();
        let before = state(&live);
        let mut edit = match kind {
            "half-emoji-start" => request(&live, 3, 1, ""),
            "half-emoji-end" => request(&live, 2, 1, ""),
            "outside" => request(&live, 999, 1, ""),
            _ => request(&live, 0, 1, ""),
        };
        if kind == "stale" {
            edit.revision += 1;
        }
        assert!(live.replace_native(edit).is_err(), "{kind}");
        assert_eq!(state(&live), before, "{kind}");
        assert!(log.is_empty());
        assert!(live
            .authored_capture
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .command
            .is_none());
        replace(&mut live, 1, 1, "");
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        assert!(records[0].deletion().is_some());
    }
}

#[test]
fn native_command_history_is_raw_and_preserves_existing_local_undo_units() {
    let mut live = seeded();
    let mut control = seeded();
    let log = live.capture_authored_updates().unwrap();
    for (at, len, text) in [(1, 1, ""), (1, 0, "添"), (1, 1, "")] {
        replace(&mut live, at, len, text);
        replace(&mut control, at, len, text);
    }
    let records = log.drain_records();
    assert_eq!(records.len(), 3);
    assert!(records[0].deletion().is_some());
    assert!(records[1].deletion().is_none());
    assert!(records[2].deletion().is_some());
    assert_eq!(
        live.undo.undo_stack().len(),
        control.undo.undo_stack().len()
    );
    for _ in 0..2 {
        for _ in 0..3 {
            assert!(live.undo());
            assert!(control.undo());
            assert_eq!(text(&live), text(&control));
        }
        for _ in 0..3 {
            assert!(live.redo());
            assert!(control.redo());
            assert_eq!(text(&live), text(&control));
        }
    }
    assert!(log.drain_records().iter().all(|r| r.deletion().is_none()));
    live.edit(Edit::Insert {
        block: "a".into(),
        offset: 0,
        text: "常".into(),
    })
    .unwrap();
    assert_eq!(log.drain().len(), 1);
    assert!(live.undo());
    assert!(!text(&live).starts_with('常'));
}

#[test]
fn native_command_origin_is_removed_after_success_and_scope_drop_retains_only_raw_bytes() {
    let mut live = seeded();
    let log = live.capture_authored_updates().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let output = seen.clone();
    live.doc
        .observe_update_v1("origins", move |txn, _| {
            output.lock().unwrap().push(txn.origin().cloned());
        })
        .unwrap();
    replace(&mut live, 1, 1, "");
    assert!(log.drain_records()[0].deletion().is_some());
    let origin = seen.lock().unwrap()[0].clone().unwrap();
    let before = live.undo.undo_stack().len();
    target(&live).insert(&mut live.doc.transact_mut_with(origin), 0, "untracked");
    assert_eq!(live.undo.undo_stack().len(), before);
    assert!(log.is_empty());
    // Exercise unwinding-safe publication with an actual event before success.
    let capture = live.authored_capture.clone().unwrap();
    let scope = NativeCommandScope::begin(&capture).unwrap();
    let origin = scope.origin();
    let xml = target(&live);
    {
        let _tracked = TrackedCommandOrigin::new(&mut live.undo, origin.clone());
        let mut txn = live.doc.transact_mut_with(origin.clone());
        scope.prepare(&mut txn, &xml, 0, 1);
        xml.remove_range(&mut txn, 0, 1);
    }
    assert!(
        log.drain_records().is_empty(),
        "No record may be published before public success"
    );
    drop(scope);
    let records = log.drain_records();
    assert_eq!(records.len(), 1);
    assert!(records[0].deletion().is_none());
    assert!(capture.lock().unwrap().command.is_none());
    let before = live.undo.undo_stack().len();
    xml.insert(&mut live.doc.transact_mut_with(origin), 0, "untracked");
    assert_eq!(live.undo.undo_stack().len(), before);
}

#[test]
fn native_command_multiple_or_foreign_events_disqualify_without_dropping_authored_bytes() {
    for foreign in [false, true] {
        let mut live = seeded();
        let log = live.capture_authored_updates().unwrap();
        let capture = live.authored_capture.clone().unwrap();
        let scope = NativeCommandScope::begin(&capture).unwrap();
        let origin = scope.origin();
        let xml = target(&live);
        {
            let _tracked = TrackedCommandOrigin::new(&mut live.undo, origin.clone());
            let mut txn = live.doc.transact_mut_with(origin);
            scope.prepare(&mut txn, &xml, 1, 1);
            xml.remove_range(&mut txn, 1, 1);
        }
        xml.insert(
            &mut live
                .doc
                .transact_mut_with(if foreign { REMOTE } else { LOCAL }),
            0,
            "外",
        );
        scope.complete();
        let records = log.drain_records();
        assert_eq!(records.len(), if foreign { 1 } else { 2 });
        assert!(records.iter().all(|r| r.deletion().is_none()));
    }
}

#[test]
fn native_command_observers_cannot_open_a_nested_write_transaction() {
    let mut live = seeded();
    let log = live.capture_authored_updates().unwrap();
    let doc = live.doc.clone();
    let attempts = Arc::new(Mutex::new(0));
    let output = attempts.clone();
    live.doc
        .observe_update_v1("nested-attempt", move |_, _| {
            assert!(doc.try_transact_mut_with(LOCAL).is_err());
            *output.lock().unwrap() += 1;
        })
        .unwrap();
    replace(&mut live, 1, 1, "");
    assert_eq!(*attempts.lock().unwrap(), 1);
    assert!(log.drain_records()[0].deletion().is_some());
}

#[test]
fn native_command_basis_includes_preexisting_deletions_but_event_does_not_reemit_them() {
    let mut live = seeded();
    live.edit(Edit::Delete {
        block: "a".into(),
        offset: 5,
        length: 1,
    })
    .unwrap();
    let before = live.doc.transact().snapshot();
    assert!(!before.delete_set.is_empty());
    let log = live.capture_authored_updates().unwrap();
    replace(&mut live, 1, 1, "");
    let records = log.drain_records();
    let proof = records[0].deletion().unwrap();
    assert_eq!(
        Snapshot::decode_v1(proof.transaction().before_snapshot()).unwrap(),
        before
    );
    let event = Update::decode_v1(records[0].update()).unwrap();
    assert!(!event.delete_set().is_empty());
    assert!(event.delete_set().diff(&before.delete_set) == *event.delete_set());
}

#[test]
fn native_command_mutable_after_transaction_expansion_never_inherits_delete_intent() {
    for insert in [true, false] {
        let mut live = seeded();
        let log = live.capture_authored_updates().unwrap();
        let xml = target(&live);
        let once = Arc::new(Mutex::new(false));
        let fired = once.clone();
        live.doc
            .observe_after_transaction("expand-command", move |txn| {
                let mut fired = fired.lock().unwrap();
                if !*fired
                    && txn.origin().is_some_and(|origin| {
                        origin.as_ref().starts_with(b"native-command-delete:")
                    })
                {
                    *fired = true;
                    if insert {
                        xml.insert(txn, 0, "observer");
                    } else {
                        xml.remove_range(txn, 0, 1);
                    }
                }
            })
            .unwrap();
        replace(&mut live, 1, 1, "");
        assert!(*once.lock().unwrap());
        let records = log.drain_records();
        assert_eq!(records.len(), 1);
        assert!(
            records[0].deletion().is_none(),
            "insert={insert}, live={}, record={:?}",
            text(&live),
            records[0]
        );
        let actual = Update::decode_v1(records[0].update()).unwrap();
        if insert {
            assert!(!actual.insertions(true).is_empty());
        } else {
            assert_eq!(
                actual
                    .delete_set()
                    .iter()
                    .flat_map(|(_, ranges)| ranges.iter())
                    .map(|r| r.end - r.start)
                    .sum::<u32>(),
                2
            );
        }
        assert!(live
            .authored_capture
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .command
            .is_none());
    }
}
