use super::*;

fn clone_session(source: &DocumentSession) -> DocumentSession {
    let mut target = DocumentSession::new();
    target
        .apply_remote(&source.update(None, 1).unwrap(), 1)
        .unwrap();
    target
}

fn text(doc: &DocumentSession, id: &str) -> XmlTextRef {
    let txn = doc.doc.transact();
    let block = doc.find_block(&txn, id).unwrap();
    let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
        panic!("text")
    };
    text
}

fn insert(doc: &DocumentSession, id: &str, offset: u32, value: &str) -> Vec<u8> {
    let text = text(doc, id);
    let mut txn = doc.doc.transact_mut();
    text.insert(&mut txn, offset, value);
    txn.encode_update_v1()
}

fn styled_insert(doc: &DocumentSession, id: &str, value: &str) -> Vec<u8> {
    let text = text(doc, id);
    let mut txn = doc.doc.transact_mut();
    text.insert_with_attributes(
        &mut txn,
        0,
        value,
        Attrs::from([("bold".into(), true.into())]),
    );
    txn.encode_update_v1()
}

fn seed() -> DocumentSession {
    let doc = DocumentSession::new();
    {
        let mut txn = doc.doc.transact_mut();
        for (id, entries) in [
            ("left", vec![("b", "潮汐")]),
            ("right", vec![("c", "夜航"), ("d", "尾声")]),
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
    }
    doc
}

fn joined(source: &DocumentSession, partial: bool) -> DocumentSession {
    let mut doc = clone_session(source);
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: if partial { 1 } else { 2 },
            length: if partial { 3 } else { 1 },
        },
        text: String::new(),
    })
    .unwrap();
    doc
}

fn unchanged_rejection(doc: &mut DocumentSession, bytes: &[u8], encoding: u8) {
    let history_state = |doc: &DocumentSession| {
        [doc.undo.undo_stack(), doc.undo.redo_stack()].map(|stack| {
            stack
                .iter()
                .map(|item| (item.deletions().clone(), item.insertions().clone()))
                .collect::<Vec<_>>()
        })
    };
    let snapshot = doc.update(None, 1).unwrap();
    let vector = doc.state_vector();
    let projection = serde_json::to_value(doc.native_projection().unwrap()).unwrap();
    let comments = doc.comment_anchor_records();
    let history = history_state(doc);
    let ephemeral = (
        doc.active_drafts(),
        doc.active_inputs(),
        doc.active_input_compositions(),
    );
    let error = doc.apply_remote(bytes, encoding).unwrap_err();
    assert!(error.starts_with(REMOTE_TEXT_RETENTION_REQUIRED), "{error}");
    assert_eq!(doc.update(None, 1).unwrap(), snapshot);
    assert_eq!(doc.state_vector(), vector);
    assert_eq!(
        serde_json::to_value(doc.native_projection().unwrap()).unwrap(),
        projection
    );
    assert_eq!(doc.comment_anchor_records(), comments);
    assert_eq!(history_state(doc), history);
    assert_eq!(
        (
            doc.active_drafts(),
            doc.active_inputs(),
            doc.active_input_compositions()
        ),
        ephemeral
    );
}

#[test]
fn retention_styled_original_prefix_rejects_atomically_with_active_history_and_input() {
    for partial in [false, true] {
        let source = seed();
        let late = clone_session(&source);
        let update = styled_insert(&late, "b", "保🙂e\u{301}");
        let mut doc = joined(&source, partial);
        doc.set_comment_anchors(vec![CommentAnchorRecord {
            id: "suffix".into(), target_block_id: Some("d".into()), target_block_ids_json: json!(["d"]).to_string(),
            anchor_json: json!({"future":true,"selectedText":"尾声","textAnchor":{"startBlockId":"d","startOffset":0,"endBlockId":"d","endOffset":2,"text":"尾声"}}).to_string(),
        }]).unwrap();
        doc.set_selection(NativeSelectionRequest {
            view_id: "view".into(),
            epoch: 1,
            revision: doc.revision,
            range: NativeRange {
                location: 1,
                length: 0,
            },
        })
        .unwrap();
        doc.fork_input("queued".into(), None).unwrap();
        doc.fork_input("composing".into(), Some("queued")).unwrap();
        doc.begin_draft(NativeDraftStart {
            key: "draft".into(),
            revision: doc.revision,
            range: NativeRange {
                location: 1,
                length: 0,
            },
        })
        .unwrap();
        unchanged_rejection(&mut doc, &update, 1);
        let v2 = Update::decode_v1(&update).unwrap().encode_v2();
        unchanged_rejection(&mut doc, &v2, 2);
        // All ephemeral bases are still usable after refusal.
        doc.commit_draft(NativeDraftCommit {
            key: "draft".into(),
            text: "续".into(),
            selection: None,
        })
        .unwrap();
        assert!(doc.undo());
        doc.replace_input(NativeInputEdit {
            key: "queued".into(),
            sequence: 0,
            range: NativeRange {
                location: 1,
                length: 0,
            },
            text: "接".into(),
            selection: None,
        })
        .unwrap();
        assert!(doc.undo());
        let joined_text = doc.native_projection().unwrap().text;
        assert!(doc.undo());
        assert_eq!(doc.native_projection().unwrap().text, "潮汐\n夜航\n尾声");
        assert!(doc.redo());
        assert_eq!(doc.native_projection().unwrap().text, joined_text);
        unchanged_rejection(&mut doc, &update, 1);
    }
}

#[test]
fn retention_styled_rejection_survives_checkpoint_without_undo_history() {
    for partial in [false, true] {
        let source = seed();
        let update = styled_insert(&clone_session(&source), "b", "保");
        let mut reopened = clone_session(&joined(&source, partial));
        assert!(!reopened.native_projection().unwrap().can_undo);
        unchanged_rejection(&mut reopened, &update, 1);
    }
}

#[test]
fn retention_mixed_safe_and_unsafe_packet_rejects_the_entire_packet() {
    let source = seed();
    let late = clone_session(&source);
    // The partial join retained only original b[0]. This insertion refers to
    // its removed suffix and has no supported destination, even though the
    // packet also carries one routable prefix insertion and live d text.
    let bad = insert(&late, "b", 2, "缺");
    let good = insert(&late, "d", 0, "远");
    let routable = insert(&clone_session(&source), "b", 0, "保");
    let merged = Update::merge_updates([
        Update::decode_v1(&bad).unwrap(),
        Update::decode_v1(&good).unwrap(),
        Update::decode_v1(&routable).unwrap(),
    ])
    .encode_v1();
    let mut doc = joined(&source, true);
    unchanged_rejection(&mut doc, &merged, 1);
    assert_eq!(doc.native_projection().unwrap().text, "潮航\n尾声");
}

fn empty_paragraph() -> DocumentSession {
    let mut doc = DocumentSession::new();
    doc.edit(Edit::AppendParagraph {
        id: "a".into(),
        text: String::new(),
    })
    .unwrap();
    doc
}

#[test]
fn retention_pending_text_checks_dependency_only_packets_and_reopen() {
    let source = empty_paragraph();
    let seed = source.update(None, 1).unwrap();
    let mut deleter = clone_session(&source);
    let update = insert(&source, "a", 0, "待🙂");
    deleter
        .edit(Edit::DeleteBlock { block: "a".into() })
        .unwrap();
    let deleted_parent = deleter.update(None, 1).unwrap();
    for reload in [false, true] {
        let mut pending = DocumentSession::new();
        pending.apply_remote(&update, 1).unwrap();
        assert!(pending.has_pending());
        if reload {
            pending = clone_session(&pending);
        }
        unchanged_rejection(&mut pending, &deleted_parent, 1);
        assert!(pending.has_pending());
        pending.apply_remote(&seed, 1).unwrap();
        assert!(!pending.has_pending());
        assert_eq!(pending.native_projection().unwrap().text, "待🙂");
    }
}

#[test]
fn retention_explicit_deletes_work_in_the_same_packet_and_before_insert() {
    for deleted_length in [1, 4] {
        let source = empty_paragraph();
        let seed = source.update(None, 1).unwrap();
        let insertion = insert(&source, "a", 0, "AB🙂");
        let deletion = {
            let text = text(&source, "a");
            let mut txn = source.doc.transact_mut();
            text.remove_range(&mut txn, 0, deleted_length);
            txn.encode_update_v1()
        };
        for order in [0, 1, 2] {
            let mut target = DocumentSession::new();
            target.apply_remote(&seed, 1).unwrap();
            match order {
                0 => {
                    let merged = Update::merge_updates([
                        Update::decode_v1(&insertion).unwrap(),
                        Update::decode_v1(&deletion).unwrap(),
                    ]);
                    target.apply_remote(&merged.encode_v1(), 1).unwrap();
                }
                1 | 2 => {
                    target.apply_remote(&deletion, 1).unwrap();
                    assert!(target.has_pending());
                    if order == 2 {
                        target = clone_session(&target);
                    }
                    target.apply_remote(&insertion, 1).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(!target.has_pending());
            assert_eq!(
                target.native_projection().unwrap().text,
                if deleted_length == 1 { "B🙂" } else { "" }
            );
        }
    }
}

#[test]
fn retention_duplicates_and_partially_known_clock_ranges_are_idempotent() {
    let source = empty_paragraph();
    let mut target = clone_session(&source);
    let first = insert(&source, "a", 0, "A");
    target.apply_remote(&first, 1).unwrap();
    target
        .edit(Edit::Delete {
            block: "a".into(),
            offset: 0,
            length: 1,
        })
        .unwrap();
    insert(&source, "a", 1, "B🙂");
    let merged_string = source.update(None, 1).unwrap();
    target.apply_remote(&merged_string, 1).unwrap();
    assert_eq!(target.native_projection().unwrap().text, "B🙂");
    target
        .edit(Edit::Delete {
            block: "a".into(),
            offset: 0,
            length: 3,
        })
        .unwrap();
    for update in [&first, &merged_string] {
        target.apply_remote(update, 1).unwrap();
        assert_eq!(target.native_projection().unwrap().text, "");
    }
    assert!(target.undo());
    assert_eq!(target.native_projection().unwrap().text, "B🙂");
}

#[test]
fn retention_explicit_deleted_new_text_under_deleted_parent_is_accepted() {
    let source = seed();
    let late = clone_session(&source);
    let insertion = insert(&late, "b", 0, "保");
    let deletion = {
        let text = text(&late, "b");
        let mut txn = late.doc.transact_mut();
        text.remove_range(&mut txn, 0, 1);
        txn.encode_update_v1()
    };
    let merged = Update::merge_updates([
        Update::decode_v1(&insertion).unwrap(),
        Update::decode_v1(&deletion).unwrap(),
    ])
    .encode_v1();
    let mut doc = joined(&source, true);
    doc.apply_remote(&merged, 1).unwrap();
    assert_eq!(doc.native_projection().unwrap().text, "潮航\n尾声");
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, "潮汐\n夜航\n尾声");
}
