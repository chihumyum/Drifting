use super::*;
use crate::relocation_alias as alias;
use yrs::Map as _;

fn seed() -> DocumentSession {
    let doc = DocumentSession::with_test_client_id(1101).unwrap();
    let mut txn = doc.doc.transact_mut();
    for (id, entries) in [
        ("left", vec![("b", "潮汐")]),
        ("right", vec![("c", "夜航"), ("d", "终章")]),
    ] {
        let quote = doc
            .root
            .push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
        quote.insert_attribute(&mut txn, "id", id);
        for (id, value) in entries {
            let block = quote.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            block.insert_attribute(&mut txn, "id", id);
            block.push_back(&mut txn, XmlTextPrelim::new(value));
        }
    }
    drop(txn);
    doc
}

fn clone_session(source: &DocumentSession, client: u64) -> DocumentSession {
    let mut result = DocumentSession::with_test_client_id(client).unwrap();
    result
        .apply_remote(&source.update(None, 1).unwrap(), 1)
        .unwrap();
    result
}

fn block(doc: &DocumentSession, id: &str) -> XmlElementRef {
    doc.find_block(&doc.doc.transact(), id).unwrap()
}

fn text(doc: &DocumentSession, id: &str) -> XmlTextRef {
    let Some(XmlOut::Text(text)) = block(doc, id).get(&doc.doc.transact(), 0) else {
        panic!("missing text");
    };
    text
}

fn insert(doc: &DocumentSession, id: &str, offset: u32, value: &str) -> Vec<u8> {
    let target = text(doc, id);
    let mut txn = doc.doc.transact_mut_with(REMOTE);
    target.insert(&mut txn, offset, value);
    txn.encode_update_v1()
}

fn join(doc: &mut DocumentSession, partial: bool) {
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: if partial { 1 } else { 2 },
            length: if partial { 3 } else { 1 },
        },
        text: String::new(),
    })
    .unwrap();
}

fn unique_ids(doc: &DocumentSession) {
    let txn = doc.doc.transact();
    let mut ids = std::collections::BTreeSet::new();
    for child in doc.root.successors(&txn) {
        if let XmlOut::Element(element) = child {
            let id = element
                .get_attribute(&txn, "id")
                .unwrap()
                .to_json(&txn)
                .to_string();
            assert!(ids.insert(id), "duplicate public identity");
        }
    }
}

fn assert_text(doc: &DocumentSession, expected: &str) {
    assert_eq!(doc.native_projection().unwrap().text, expected);
    assert!(!doc.has_pending());
    unique_ids(doc);
}

fn history(log: &AuthoredUpdateLog, live: &DocumentSession, replica: &mut DocumentSession) {
    let updates = log.drain();
    assert_eq!(
        updates.len(),
        1,
        "one exact authored event per history action"
    );
    replica.apply_remote(&updates[0], 1).unwrap();
    assert_eq!(replica.semantic().unwrap(), live.semantic().unwrap());
    assert!(!replica.has_pending());
    let reopened = clone_session(live, 1110);
    assert_eq!(reopened.semantic().unwrap(), live.semantic().unwrap());
    assert!(!reopened.has_pending());
}

fn comment(id: &str, block: &str, start: u32, end: u32, quote: &str) -> CommentAnchorRecord {
    CommentAnchorRecord {
        id: id.into(),
        target_block_id: Some(block.into()),
        target_block_ids_json: json!([block]).to_string(),
        anchor_json: json!({"future":true,"selectedText":quote,"textAnchor":{
            "startBlockId":block,"startOffset":start,"endBlockId":block,"endOffset":end,"text":quote
        }})
        .to_string(),
    }
}

fn assert_comments(doc: &DocumentSession) {
    let view = doc.native_projection().unwrap();
    for comment in &view.comments {
        assert_eq!(comment.status, "anchored", "{}", comment.id);
        let units: Vec<_> = view.text.encode_utf16().collect();
        let selected = comment
            .ranges
            .iter()
            .map(|range| {
                String::from_utf16(
                    &units[range.location as usize..(range.location + range.length) as usize],
                )
                .unwrap()
            })
            .collect::<String>();
        assert_eq!(selected, comment.quote);
    }
    for record in doc.comment_anchor_records() {
        let value: Value = serde_json::from_str(&record.anchor_json).unwrap();
        assert_eq!(value["future"], true);
    }
}

#[test]
fn relocation_history_original_prefix_survives_two_cycles_one_event_and_reopen() {
    for partial in [false, true] {
        let source = seed();
        let late = clone_session(&source, 1102);
        let mut live = clone_session(&source, 1103);
        live.set_comment_anchors(vec![
            comment("prefix", "b", 0, 1, "潮"),
            comment("tail", "c", 1, 2, "航"),
            comment("suffix", "d", 0, 2, "终章"),
        ])
        .unwrap();
        let right = block(&live, "right");
        let c = block(&live, "c");
        let d = block(&live, "d");
        join(&mut live, partial);
        let update = insert(&late, "b", 0, "保🙂e\u{301}");
        live.apply_remote(&update, 1).unwrap();
        let joined = if partial {
            "保🙂e\u{301}潮航\n终章"
        } else {
            "保🙂e\u{301}潮汐夜航\n终章"
        };
        assert_text(&live, joined);
        assert_comments(&live);
        let mut replica = clone_session(&live, 1104);
        let log = live.capture_authored_updates().unwrap();
        for _ in 0..2 {
            assert!(live.try_undo().unwrap());
            assert_text(&live, "保🙂e\u{301}潮汐\n夜航\n终章");
            assert_comments(&live);
            assert_eq!(
                (live.undo.undo_stack().len(), live.undo.redo_stack().len()),
                (0, 1)
            );
            assert_eq!(block(&live, "right"), right);
            assert_eq!(block(&live, "c"), c);
            assert_eq!(block(&live, "d"), d);
            history(&log, &live, &mut replica);
            assert!(live.try_redo().unwrap());
            assert_text(&live, joined);
            assert_comments(&live);
            assert_eq!(
                (live.undo.undo_stack().len(), live.undo.redo_stack().len()),
                (1, 0)
            );
            assert_eq!(block(&live, "left"), right);
            assert_eq!(block(&live, "b"), c);
            assert_eq!(block(&live, "d"), d);
            history(&log, &live, &mut replica);
        }
        let txn = live.doc.transact();
        let record = alias::defs(&txn).unwrap().remove(0);
        let evidence = alias::evidence(&txn, record.source_text).unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].text, "保🙂e\u{301}");
    }
}

#[test]
fn relocation_history_selection_on_late_render_follows_logical_b() {
    let source = seed();
    let late = clone_session(&source, 1102);
    let mut live = clone_session(&source, 1103);
    join(&mut live, true);
    live.apply_remote(&insert(&late, "b", 0, "保🙂"), 1)
        .unwrap();
    live.set_selection(NativeSelectionRequest {
        view_id: "late-selection".into(),
        epoch: 2,
        revision: live.revision,
        range: NativeRange {
            location: 0,
            length: 3,
        },
    })
    .unwrap();
    live.set_comment_anchors(vec![comment("late-comment", "b", 0, 3, "保🙂")])
        .unwrap();
    for _ in 0..2 {
        for redo in [false, true] {
            assert!(if redo {
                live.try_redo()
            } else {
                live.try_undo()
            }
            .unwrap());
            let view = live.native_projection().unwrap();
            let selected = view
                .selections
                .iter()
                .find(|item| item.view_id == "late-selection")
                .unwrap()
                .range
                .as_ref()
                .unwrap();
            assert_eq!((selected.location, selected.length), (0, 3));
            assert_comments(&live);
            assert_eq!(
                live.resolve_anchor(&live.selections["late-selection"].start.bytes)
                    .unwrap()
                    .unwrap()["block"],
                "b"
            );
        }
    }
}

#[test]
fn relocation_history_preserves_aware_c_tail_and_suffix_items() {
    let source = seed();
    let late = clone_session(&source, 1102);
    let mut live = clone_session(&source, 1103);
    join(&mut live, true);
    live.apply_remote(&insert(&late, "b", 0, "保"), 1).unwrap();
    let aware = clone_session(&live, 1104);
    live.apply_remote(&insert(&aware, "b", 3, "远"), 1).unwrap();
    live.apply_remote(&insert(&aware, "d", 1, "外"), 1).unwrap();
    let d = block(&live, "d");
    assert_text(&live, "保潮航远\n终外章");
    for _ in 0..2 {
        assert!(live.try_undo().unwrap());
        assert_text(&live, "保潮汐\n夜航远\n终外章");
        assert_eq!(block(&live, "d"), d);
        assert!(live.try_redo().unwrap());
        assert_text(&live, "保潮航远\n终外章");
        assert_eq!(block(&live, "d"), d);
    }
}

#[test]
fn relocation_history_rejects_unowned_restored_b_text_before_redo() {
    let source = seed();
    let late = clone_session(&source, 1102);
    let mut live = clone_session(&source, 1103);
    join(&mut live, true);
    live.apply_remote(&insert(&late, "b", 0, "保"), 1).unwrap();
    assert!(live.try_undo().unwrap());
    let aware = clone_session(&live, 1104);
    live.apply_remote(&insert(&aware, "b", 0, "外"), 1).unwrap();
    let before = live.update(None, 1).unwrap();
    let log = live.capture_authored_updates().unwrap();
    let error = live.try_redo().unwrap_err();
    assert!(error.contains("non-alias peer text"), "{error}");
    assert_eq!(live.update(None, 1).unwrap(), before);
    assert_text(&live, "外保潮汐\n夜航\n终章");
    assert_eq!(
        (live.undo.undo_stack().len(), live.undo.redo_stack().len()),
        (0, 1)
    );
    assert!(log.is_empty());
}

#[test]
fn relocation_history_rejects_modified_owned_render_without_resurrection() {
    for format in [false, true] {
        let source = seed();
        let late = clone_session(&source, 1102);
        let mut live = clone_session(&source, 1103);
        join(&mut live, true);
        live.apply_remote(&insert(&late, "b", 0, "保"), 1).unwrap();
        let aware = clone_session(&live, 1104);
        let target = text(&aware, "b");
        let update = {
            let mut txn = aware.doc.transact_mut_with(REMOTE);
            if format {
                target.format(
                    &mut txn,
                    0,
                    1,
                    [("bold".into(), Any::Bool(true))].into_iter().collect(),
                );
            } else {
                target.remove_range(&mut txn, 0, 1);
            }
            txn.encode_update_v1()
        };
        live.apply_remote(&update, 1).unwrap();
        let before = live.update(None, 1).unwrap();
        assert!(live
            .try_undo()
            .unwrap_err()
            .starts_with(NATIVE_HISTORY_UNAVAILABLE));
        assert_eq!(live.update(None, 1).unwrap(), before);
        assert_eq!(
            (live.undo.undo_stack().len(), live.undo.redo_stack().len()),
            (1, 0)
        );
    }
}

#[test]
fn relocation_history_activation_without_evidence_routes_later_original_update() {
    let source = seed();
    let late = clone_session(&source, 1102);
    let mut live = clone_session(&source, 1103);
    join(&mut live, true);
    assert!(live.try_undo().unwrap());
    live.apply_remote(&insert(&late, "b", 0, "保"), 1).unwrap();
    assert_text(&live, "保潮汐\n夜航\n终章");
    assert!(live.try_redo().unwrap());
    assert_text(&live, "保潮航\n终章");
}

#[test]
fn relocation_history_handle_resolves_in_owner_after_draft_and_input_forks() {
    for input in [false, true] {
        let source = seed();
        let late = clone_session(&source, 1102);
        let mut live = clone_session(&source, 1103);
        if input {
            live.fork_input("queue".into(), None).unwrap();
            live.replace_input(NativeInputEdit {
                key: "queue".into(),
                sequence: 0,
                range: NativeRange {
                    location: 1,
                    length: 3,
                },
                text: String::new(),
                selection: None,
            })
            .unwrap();
            live.replace_input(NativeInputEdit {
                key: "queue".into(),
                sequence: 1,
                range: NativeRange {
                    location: 1,
                    length: 0,
                },
                text: "续".into(),
                selection: None,
            })
            .unwrap();
            assert_text(&live, "潮续航\n终章");
            assert!(live.try_undo().unwrap());
        } else {
            live.begin_draft(NativeDraftStart {
                key: "draft".into(),
                revision: live.revision,
                range: NativeRange {
                    location: 1,
                    length: 3,
                },
            })
            .unwrap();
            live.commit_draft(NativeDraftCommit {
                key: "draft".into(),
                text: String::new(),
                selection: None,
            })
            .unwrap();
            assert_eq!(live.active_drafts(), 0);
        }
        assert_text(&live, "潮航\n终章");
        live.apply_remote(&insert(&late, "b", 0, "保"), 1).unwrap();
        for _ in 0..2 {
            assert!(live.try_undo().unwrap());
            assert_text(&live, "保潮汐\n夜航\n终章");
            assert!(live.try_redo().unwrap());
            assert_text(&live, "保潮航\n终章");
        }
    }
}

#[test]
fn relocation_history_maps_retained_surrogate_and_combining_item_clocks_exactly() {
    let source = seed();
    let original = text(&source, "b");
    {
        let mut txn = source.doc.transact_mut();
        original.remove_range(&mut txn, 0, 2);
        original.insert(&mut txn, 0, "🙂e\u{301}潮");
    }
    let late = clone_session(&source, 1102);
    let mut live = clone_session(&source, 1103);
    live.replace_native(NativeReplacement {
        revision: live.revision,
        range: NativeRange {
            location: 4,
            length: 3,
        },
        text: String::new(),
    })
    .unwrap();
    live.apply_remote(&insert(&late, "b", 2, "保"), 1).unwrap();
    assert_text(&live, "🙂保e\u{301}航\n终章");
    for _ in 0..2 {
        assert!(live.try_undo().unwrap());
        assert_text(&live, "🙂保e\u{301}潮\n夜航\n终章");
        assert!(live.try_redo().unwrap());
        assert_text(&live, "🙂保e\u{301}航\n终章");
    }
}

#[test]
fn relocation_history_pending_dependency_rejects_before_any_history_mutation() {
    let source = seed();
    let late = clone_session(&source, 1102);
    let mut live = clone_session(&source, 1103);
    join(&mut live, true);
    live.apply_remote(&insert(&late, "b", 0, "保"), 1).unwrap();
    let sparse = Doc::with_client_id(1120);
    let target = sparse.get_or_insert_text("unrelated-pending");
    let missing = {
        let mut txn = sparse.transact_mut();
        target.insert(&mut txn, 0, "A");
        txn.encode_update_v1()
    };
    let later = {
        let mut txn = sparse.transact_mut();
        target.insert(&mut txn, 1, "B");
        txn.encode_update_v1()
    };
    live.apply_remote(&later, 1).unwrap();
    assert!(live.has_pending());
    let before = live.update(None, 1).unwrap();
    let expected = live.semantic().unwrap();
    let revision = live.revision;
    let log = live.capture_authored_updates().unwrap();
    let result = live.try_undo();
    assert!(
        result.is_err(),
        "history unexpectedly returned {result:?}: {:?}",
        live.native_projection().unwrap().text
    );
    let error = result.unwrap_err();
    assert!(error.starts_with(NATIVE_HISTORY_UNAVAILABLE), "{error}");
    assert_eq!(
        live.semantic().unwrap(),
        expected,
        "refused history must preserve visible late text"
    );
    assert_eq!(live.update(None, 1).unwrap(), before);
    assert_eq!(live.revision, revision);
    assert_eq!(
        (live.undo.undo_stack().len(), live.undo.redo_stack().len()),
        (1, 0)
    );
    assert!(log.is_empty());
    live.apply_remote(&missing, 1).unwrap();
    assert!(!live.has_pending());
    assert!(live.try_undo().unwrap());
    assert_text(&live, "保潮汐\n夜航\n终章");
    assert!(live.try_redo().unwrap());
    assert_text(&live, "保潮航\n终章");
}

#[test]
fn relocation_history_rejects_activation_replaced_without_retiring_owned_render() {
    let source = seed();
    let late = clone_session(&source, 1102);
    let mut live = clone_session(&source, 1103);
    join(&mut live, true);
    live.apply_remote(&insert(&late, "b", 0, "保"), 1).unwrap();
    let peer = clone_session(&live, 1104);
    let update = {
        let mut txn = peer.doc.transact_mut_with(REMOTE);
        let mut active = alias::active_records(&txn).unwrap().remove(0);
        active.incarnation.push_str("-replacement");
        active.namespace ^= 1;
        alias::set_active(&mut txn, &active).unwrap();
        txn.encode_update_v1()
    };
    live.apply_remote(&update, 1).unwrap();
    let before = live.update(None, 1).unwrap();
    let expected = live.semantic().unwrap();
    let log = live.capture_authored_updates().unwrap();
    let result = live.try_undo();
    assert!(
        result.is_err(),
        "history unexpectedly returned {result:?}: {:?}",
        live.native_projection().unwrap().text
    );
    let error = result.unwrap_err();
    assert!(error.starts_with(NATIVE_HISTORY_UNAVAILABLE), "{error}");
    assert_eq!(live.semantic().unwrap(), expected);
    assert_eq!(live.update(None, 1).unwrap(), before);
    assert_eq!(
        (live.undo.undo_stack().len(), live.undo.redo_stack().len()),
        (1, 0)
    );
    assert!(log.is_empty());
}

fn gap_history_fixture(gap: bool, redo: bool) -> DocumentSession {
    let source = seed();
    let late = clone_session(&source, 1141);
    let mut live = clone_session(&source, 1142);
    join(&mut live, true);
    if gap {
        insert(&late, "d", 0, "远🙂");
    }
    insert(&late, "b", 0, "保");
    live.apply_remote(&late.update(None, 1).unwrap(), 1)
        .unwrap();
    live.set_comment_anchors(vec![comment("gap-comment", "b", 0, 1, "保")])
        .unwrap();
    live.set_selection(NativeSelectionRequest {
        view_id: "gap-selection".into(),
        epoch: 1,
        revision: live.revision,
        range: NativeRange {
            location: 0,
            length: 1,
        },
    })
    .unwrap();
    if redo {
        assert!(live.try_undo().unwrap());
    }
    live
}

fn assert_gap_history_rejection_is_atomic(live: &mut DocumentSession, redo: bool, reason: &str) {
    let before = live.update(None, 1).unwrap();
    let projection = serde_json::to_value(live.native_projection().unwrap()).unwrap();
    let comments = live.comment_anchor_records();
    let stacks = (live.undo.undo_stack().len(), live.undo.redo_stack().len());
    let log = live.capture_authored_updates().unwrap();
    let result = if redo {
        live.try_redo()
    } else {
        live.try_undo()
    };
    let error = result.unwrap_err();
    assert!(error.starts_with(NATIVE_HISTORY_UNAVAILABLE), "{error}");
    assert!(error.contains(reason), "{error}");
    assert_eq!(live.update(None, 1).unwrap(), before);
    assert_eq!(
        serde_json::to_value(live.native_projection().unwrap()).unwrap(),
        projection
    );
    assert_eq!(live.comment_anchor_records(), comments);
    assert_eq!(
        (live.undo.undo_stack().len(), live.undo.redo_stack().len()),
        stacks
    );
    assert!(log.is_empty());
    assert_comments(live);
}

#[test]
fn relocation_history_gap_receipt_conflict_rejects_before_mutation() {
    for redo in [false, true] {
        let mut live = gap_history_fixture(true, redo);
        let peer = clone_session(&live, 1143);
        let update = {
            let mut txn = peer.doc.transact_mut_with(REMOTE);
            let map = txn.get_map(alias::ROOT).unwrap();
            let prefix = format!("skip/{}/", alias::defs(&txn).unwrap()[0].id);
            let mut conflict: Value = map
                .iter(&txn)
                .find(|(key, _)| key.starts_with(&prefix))
                .map(|(_, value)| {
                    let Out::Any(Any::String(value)) = value else {
                        panic!("receipt")
                    };
                    serde_json::from_str(&value).unwrap()
                })
                .unwrap();
            conflict["text"] = json!("近🙂");
            map.insert(&mut txn, format!("{prefix}conflict"), conflict.to_string());
            txn.encode_update_v1()
        };
        live.apply_remote(&update, 1).unwrap();
        assert_gap_history_rejection_is_atomic(&mut live, redo, "Conflicting safe clock receipt");
    }
}

fn add_remote_independent_quote_join(live: &mut DocumentSession) {
    let mut peer = clone_session(live, 1144);
    let vector = peer.state_vector();
    {
        let mut txn = peer.doc.transact_mut_with(REMOTE);
        for (id, entries) in [
            ("next-left", vec![("e", "甲甲")]),
            ("next-right", vec![("f", "乙乙"), ("g", "末")]),
        ] {
            let quote = peer
                .root
                .push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
            quote.insert_attribute(&mut txn, "id", id);
            for (id, value) in entries {
                let block = quote.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                block.insert_attribute(&mut txn, "id", id);
                block.push_back(&mut txn, XmlTextPrelim::new(value));
            }
        }
    }
    let projection = peer.native_projection().unwrap();
    let range = &projection
        .blocks
        .iter()
        .find(|b| b.id.as_deref() == Some("e"))
        .unwrap()
        .range;
    peer.replace_native(NativeReplacement {
        revision: projection.revision,
        range: NativeRange {
            location: range.location + range.length,
            length: 1,
        },
        text: String::new(),
    })
    .unwrap();
    live.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
        .unwrap();
    assert_eq!(alias::defs(&live.doc.transact()).unwrap().len(), 2);
}

#[test]
fn relocation_history_gap_second_alias_rejects_without_blocking_contiguous_history() {
    for redo in [false, true] {
        let mut live = gap_history_fixture(true, redo);
        add_remote_independent_quote_join(&mut live);
        assert_gap_history_rejection_is_atomic(&mut live, redo, "one unambiguous alias");

        // The single-alias limitation applies only when clock gaps require
        // proof; ordinary contiguous prefix history remains supported.
        let mut contiguous = gap_history_fixture(false, redo);
        add_remote_independent_quote_join(&mut contiguous);
        assert!(if redo {
            contiguous.try_redo()
        } else {
            contiguous.try_undo()
        }
        .unwrap());
        assert_text(
            &contiguous,
            if redo {
                "保潮航\n终章\n甲甲乙乙\n末"
            } else {
                "保潮汐\n夜航\n终章\n甲甲乙乙\n末"
            },
        );
        assert_comments(&contiguous);
    }
}
