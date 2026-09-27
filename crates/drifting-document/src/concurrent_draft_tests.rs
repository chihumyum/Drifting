use super::*;

const PREFIX: &str = "前👩🏽‍🚀";
const BODY: &str = "甲北塔乙👩🏽‍🚀";

fn source() -> DocumentSession {
    source_body(BODY)
}

fn source_body(body: &str) -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(34001).unwrap();
    for (id, text) in [("lead", PREFIX), ("p", body), ("q", "尾段")] {
        seed.edit(Edit::AppendParagraph {
            id: id.into(),
            text: text.into(),
        })
        .unwrap();
    }
    let mut owner = DocumentSession::with_test_client_id(34002).unwrap();
    owner
        .apply_remote(&seed.update(None, 1).unwrap(), 1)
        .unwrap();
    owner
}

#[test]
fn same_paragraph_prefix_insertions_keep_unicode_and_the_queued_author_basis() {
    let body = "甲👩🏽‍🚀北e\u{301}尾";
    let mut doc = source_body(body);
    let start = block_start(&doc, "p");
    let cut = "甲👩🏽‍🚀北".encode_utf16().count() as u32;
    doc.fork_input("typing".into(), None).unwrap();
    remote(&mut doc, |peer| {
        peer.edit(Edit::Insert {
            block: "p".into(),
            offset: 1,
            text: "远🙂".into(),
        })
        .unwrap();
        peer.edit(Edit::Format {
            block: "p".into(),
            offset: 1,
            length: 3,
            attributes: json!({"bold": true}).as_object().unwrap().clone(),
        })
        .unwrap();
    });
    let authored = doc
        .replace_input(NativeInputEdit {
            key: "typing".into(),
            sequence: 0,
            range: NativeRange {
                location: start + cut,
                length: 0,
            },
            text: "\n".into(),
            selection: Some(NativeDraftSelection {
                view_id: "typing".into(),
                epoch: 1,
                range: NativeRange {
                    location: start + cut + 1,
                    length: 0,
                },
            }),
        })
        .unwrap();
    assert_eq!(authored.text, format!("{PREFIX}\n甲👩🏽‍🚀北\ne\u{301}尾\n尾段"));
    assert_eq!(selection(&doc), (start + cut + 4, 0));
    let new_id = authored.blocks[2].id.clone();
    let authored = doc
        .replace_input(NativeInputEdit {
            key: "typing".into(),
            sequence: 1,
            range: NativeRange {
                location: start + cut + 1,
                length: 0,
            },
            text: "续".into(),
            selection: Some(NativeDraftSelection {
                view_id: "typing".into(),
                epoch: 2,
                range: NativeRange {
                    location: start + cut + 2,
                    length: 0,
                },
            }),
        })
        .unwrap();
    assert_eq!(authored.blocks[2].id, new_id);
    assert_eq!(
        authored.text,
        format!("{PREFIX}\n甲👩🏽‍🚀北\n续e\u{301}尾\n尾段")
    );
    let merged = format!("{PREFIX}\n甲远🙂👩🏽‍🚀北\n续e\u{301}尾\n尾段");
    assert_eq!(doc.native_projection().unwrap().text, merged);
    assert_eq!(selection(&doc), (start + cut + 5, 0));
    let checkpoint = doc.update(None, 1).unwrap();
    assert!(doc.undo());
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().text,
        format!("{PREFIX}\n甲远🙂👩🏽‍🚀北e\u{301}尾\n尾段")
    );
    assert!(!doc.undo());
    assert!(doc.redo());
    assert!(doc.redo());
    assert_eq!(doc.native_projection().unwrap().text, merged);
    let view = doc.native_projection().unwrap();
    assert!(view.blocks[1]
        .runs
        .iter()
        .any(|run| run.range.length == 3 && run.attributes["bold"] == true));
    let mut reopened = DocumentSession::new();
    reopened.apply_remote(&checkpoint, 1).unwrap();
    assert_eq!(reopened.native_projection().unwrap().text, merged);
    assert!(!reopened.undo());
}

#[test]
fn same_paragraph_prefix_deletions_keep_tail_history_and_queued_author_offsets() {
    for (name, body, cut, offset, length) in [
        ("repeated prefix", "甲甲👩🏽‍🚀乙", 2, 0, 1),
        ("cut predecessor", "甲甲👩🏽‍🚀乙", 2, 1, 1),
        ("entire prefix", "甲甲👩🏽‍🚀乙", 2, 0, 2),
        ("Unicode prefix", "甲👩🏽‍🚀北e\u{301}尾", 9, 0, 8),
        ("entire Unicode prefix", "甲👩🏽‍🚀北e\u{301}尾", 9, 0, 9),
        ("retained combining mark", "甲e\u{301}👩🏽‍🚀尾", 3, 1, 1),
    ] {
        let mut doc = source_body(body);
        let units: Vec<_> = body.encode_utf16().collect();
        let tail = String::from_utf16(&units[cut as usize..]).unwrap();
        let authored_prefix = String::from_utf16(&units[..cut as usize]).unwrap();
        let mut prefix_units = units[..cut as usize].to_vec();
        prefix_units.drain(offset as usize..(offset + length) as usize);
        let prefix = String::from_utf16(&prefix_units).unwrap();
        let tail_length = tail.encode_utf16().count() as u32;
        remote(&mut doc, |peer| {
            peer.edit(Edit::Format {
                block: "p".into(),
                offset: cut,
                length: tail_length,
                attributes: json!({"bold": true}).as_object().unwrap().clone(),
            })
            .unwrap();
            peer.edit(Edit::SetAttribute {
                block: "p".into(),
                key: "future".into(),
                value: json!({"keep": ["synthetic", 3]}),
            })
            .unwrap();
            let mut txn = peer.doc.transact_mut_with(LOCAL);
            let text = peer.editable_text(&txn, "p").unwrap();
            text.insert_attribute(
                &mut txn,
                "futureText",
                Any::Buffer(vec![1, 128, 255].into()),
            );
        });
        doc.set_comment_anchors(vec![CommentAnchorRecord {
            id: "tail-quote".into(),
            target_block_id: Some("p".into()),
            target_block_ids_json: "[\"p\"]".into(),
            anchor_json: json!({"selectedText": tail, "future": {"keep": true},
                "blockSnapshots": [{"blockId": "p", "blockText": body}],
                "textAnchor": {"startBlockId":"p", "startOffset":cut,
                    "endBlockId":"p", "endOffset":units.len(), "text":tail}})
            .to_string(),
        }])
        .unwrap();
        let start = block_start(&doc, "p");
        let cut_anchor = doc.anchor("p", cut, false).unwrap();
        doc.fork_input("typing".into(), None).unwrap();
        remote(&mut doc, |peer| {
            peer.edit(Edit::Delete {
                block: "p".into(),
                offset,
                length,
            })
            .unwrap();
        });
        let live_cut = cut - length;
        assert_eq!(
            doc.resolve_anchor(&cut_anchor).unwrap().unwrap(),
            json!({"block": "p", "offset": live_cut}),
            "{name}"
        );
        let remote_only = doc.semantic().unwrap();
        let author = doc
            .replace_input(NativeInputEdit {
                key: "typing".into(),
                sequence: 0,
                range: NativeRange {
                    location: start + cut,
                    length: 0,
                },
                text: "\n".into(),
                selection: None,
            })
            .unwrap();
        assert_eq!(
            author.text,
            format!("{PREFIX}\n{authored_prefix}\n{tail}\n尾段"),
            "{name}"
        );
        let tail_id = author.blocks[2].id.clone().unwrap();
        let author = doc
            .replace_input(NativeInputEdit {
                key: "typing".into(),
                sequence: 1,
                range: NativeRange {
                    location: start + cut + 1,
                    length: 0,
                },
                text: "续".into(),
                selection: None,
            })
            .unwrap();
        assert_eq!(
            author.text,
            format!("{PREFIX}\n{authored_prefix}\n续{tail}\n尾段"),
            "{name}"
        );
        assert_eq!(author.blocks[2].id.as_deref(), Some(tail_id.as_str()));
        assert_eq!(
            doc.native_projection().unwrap().text,
            format!("{PREFIX}\n{prefix}\n续{tail}\n尾段"),
            "{name}"
        );
        let merged = doc.semantic().unwrap();
        let check_tail = |doc: &DocumentSession, split: bool| {
            let projection = doc.native_projection().unwrap();
            let comment = &projection.comments[0];
            assert_eq!(comment.quote, tail, "{name}");
            assert_eq!(
                comment.ranges[0].location,
                start + live_cut + if split { 2 } else { 0 }
            );
            assert_eq!(comment.ranges[0].length, tail_length, "{name}");
            let records = doc.comment_anchor_records();
            let anchor: Value = serde_json::from_str(&records[0].anchor_json).unwrap();
            assert_eq!(anchor["future"], json!({"keep": true}), "{name}");
            assert_eq!(anchor["blockSnapshots"][0]["blockText"], body, "{name}");
            let txn = doc.doc.transact();
            for id in ["p", if split { &tail_id } else { "p" }] {
                let text = doc.editable_text(&txn, id).unwrap();
                assert_eq!(
                    text.get_attribute(&txn, "futureText")
                        .unwrap()
                        .to_json(&txn),
                    Any::Buffer(vec![1, 128, 255].into()),
                    "{name}"
                );
            }
        };
        check_tail(&doc, true);
        select(&mut doc, 1, start + live_cut + 2, tail_length);
        for _ in 0..2 {
            assert!(doc.undo(), "{name}");
            assert!(doc.undo(), "{name}");
            assert_eq!(
                doc.semantic().unwrap(),
                remote_only,
                "Undo restored remote deletion: {name}"
            );
            assert_eq!(selection(&doc), (start + live_cut, tail_length), "{name}");
            check_tail(&doc, false);
            assert!(!doc.undo(), "Remote deletion entered local history: {name}");
            assert!(doc.redo(), "{name}");
            assert!(doc.redo(), "{name}");
            assert_eq!(doc.semantic().unwrap(), merged, "{name}");
            assert_eq!(
                selection(&doc),
                (start + live_cut + 2, tail_length),
                "{name}"
            );
            check_tail(&doc, true);
        }
        let checkpoint = doc.update(None, 1).unwrap();
        let mut reopened = DocumentSession::new();
        reopened.apply_remote(&checkpoint, 1).unwrap();
        assert_eq!(reopened.semantic().unwrap(), merged, "{name}");
        reopened
            .set_comment_anchors(doc.comment_anchor_records())
            .unwrap();
        check_tail(&reopened, true);
        assert!(!reopened.undo(), "{name}");
    }
}

#[test]
fn prefix_deletion_does_not_allow_mixed_items_changed_marks_or_tail() {
    for scenario in [
        "prefix insertion",
        "cut insertion",
        "tail insertion",
        "tail deletion",
        "prefix format",
        "tail format",
        "text metadata",
        "all-prefix cut insertion",
    ] {
        let mut doc = source_body("甲甲北塔");
        let start = block_start(&doc, "p");
        begin(&mut doc, start + 2, 0);
        remote(&mut doc, |peer| {
            peer.edit(Edit::Delete {
                block: "p".into(),
                offset: 0,
                length: if scenario == "all-prefix cut insertion" {
                    2
                } else {
                    1
                },
            })
            .unwrap();
            let edit = match scenario {
                "prefix insertion"
                | "all-prefix cut insertion"
                | "cut insertion"
                | "tail insertion" => Edit::Insert {
                    block: "p".into(),
                    offset: match scenario {
                        "cut insertion" => 1,
                        "tail insertion" => 2,
                        _ => 0,
                    },
                    text: "远".into(),
                },
                "tail deletion" => Edit::Delete {
                    block: "p".into(),
                    offset: 1,
                    length: 1,
                },
                "prefix format" | "tail format" => Edit::Format {
                    block: "p".into(),
                    offset: if scenario == "prefix format" { 0 } else { 1 },
                    length: 1,
                    attributes: json!({"bold": true}).as_object().unwrap().clone(),
                },
                "text metadata" => {
                    let mut txn = peer.doc.transact_mut_with(LOCAL);
                    let text = peer.editable_text(&txn, "p").unwrap();
                    text.insert_attribute(&mut txn, "future", Any::Buffer(vec![1, 2, 3].into()));
                    return;
                }
                _ => unreachable!(),
            };
            peer.edit(edit).unwrap();
        });
        reject_without_mutation(&mut doc, "\n");
    }
}

#[test]
fn same_paragraph_split_maps_comments_and_new_selection_history_in_live_offsets() {
    let mut doc = source();
    let start = block_start(&doc, "p");
    doc.set_comment_anchors(vec![CommentAnchorRecord {
        id: "quote".into(),
        target_block_id: Some("p".into()),
        target_block_ids_json: "[\"p\"]".into(),
        anchor_json: json!({"selectedText": "塔乙", "future": {"keep": true},
            "blockSnapshots": [{"blockId": "p", "blockText": BODY}],
            "textAnchor": {"startBlockId":"p", "startOffset":2,
                "endBlockId":"p", "endOffset":4, "text":"塔乙"}})
        .to_string(),
    }])
    .unwrap();
    select(&mut doc, 1, start + 2, 2);
    begin(&mut doc, start + 2, 0);
    remote(&mut doc, |peer| {
        peer.edit(Edit::Insert {
            block: "p".into(),
            offset: 1,
            text: "远🙂".into(),
        })
        .unwrap();
    });
    assert_eq!(selection(&doc), (start + 5, 2));
    commit(&mut doc, "\n").unwrap();
    assert_eq!(selection(&doc), (start + 6, 2));
    for (epoch, at, length, undo_at) in [
        (2, start + 8, 7, start + 7), // Copied emoji, with a newer selection epoch.
        (3, start + 15, 0, start + 14), // A new caret at the copied tail's end.
        (4, start + 1, 3, start + 1), // Remote-only prefix items stay in place.
    ] {
        select(&mut doc, epoch, at, length);
        assert!(doc.undo());
        assert_eq!(selection(&doc), (undo_at, length));
        assert_eq!(
            doc.native_projection().unwrap().comments[0].ranges[0].location,
            start + 5
        );
        assert!(doc.redo());
        assert_eq!(selection(&doc), (at, length));
        let view = doc.native_projection().unwrap();
        assert_eq!(view.comments[0].quote, "塔乙");
        assert_eq!(view.comments[0].ranges[0].location, start + 6);
        assert_eq!(view.comments[0].ranges[0].length, 2);
    }
    let records = doc.comment_anchor_records();
    let anchor: Value = serde_json::from_str(&records[0].anchor_json).unwrap();
    assert_eq!(anchor["future"], json!({"keep": true}));
    assert_eq!(anchor["blockSnapshots"][0]["blockText"], BODY);
}

#[test]
fn same_paragraph_split_rejects_boundary_tail_deleted_items_marks_and_metadata() {
    let insert = |offset, text: &str| Edit::Insert {
        block: "p".into(),
        offset,
        text: text.into(),
    };
    let delete = |offset| Edit::Delete {
        block: "p".into(),
        offset,
        length: 1,
    };
    let format = |offset| Edit::Format {
        block: "p".into(),
        offset,
        length: 1,
        attributes: json!({"bold": true}).as_object().unwrap().clone(),
    };
    for (name, edits) in [
        ("cut insertion", vec![insert(2, "界")]),
        ("tail insertion", vec![insert(3, "尾")]),
        ("end insertion", vec![insert(11, "终")]),
        ("prefix deletion", vec![delete(0)]),
        ("tail deletion", vec![delete(2)]),
        (
            "same visible prefix, new identity",
            vec![delete(0), insert(0, "甲")],
        ),
        ("prefix format", vec![format(0)]),
        ("tail format", vec![format(2)]),
        (
            "block metadata",
            vec![Edit::SetAttribute {
                block: "p".into(),
                key: "future".into(),
                value: json!({"keep": true}),
            }],
        ),
    ] {
        let mut doc = source();
        let at = block_start(&doc, "p") + 2;
        begin(&mut doc, at, 0);
        remote(&mut doc, |peer| {
            for edit in edits {
                peer.edit(edit).unwrap();
            }
            peer.edit(insert(0, "远")).unwrap();
        });
        assert!(
            doc.native_projection().unwrap().text.contains('远'),
            "{name}"
        );
        reject_without_mutation(&mut doc, "\n");
    }
}

#[test]
fn same_paragraph_prefix_insert_does_not_relax_text_metadata_or_non_enter_gates() {
    for replacement in ["\n", "一\n二", "\n\n"] {
        let mut doc = source();
        let at = block_start(&doc, "p") + 2;
        begin(&mut doc, at, 0);
        remote(&mut doc, |peer| {
            peer.edit(Edit::Insert {
                block: "p".into(),
                offset: 0,
                text: "远".into(),
            })
            .unwrap();
            if replacement == "\n" {
                let mut txn = peer.doc.transact_mut_with(LOCAL);
                let text = peer.editable_text(&txn, "p").unwrap();
                text.insert_attribute(&mut txn, "future", Any::Buffer(vec![1, 2, 3].into()));
            }
        });
        reject_without_mutation(&mut doc, replacement);
    }
}

fn block_start(doc: &DocumentSession, id: &str) -> u32 {
    doc.native_projection()
        .unwrap()
        .blocks
        .into_iter()
        .find(|block| block.id.as_deref() == Some(id))
        .unwrap()
        .range
        .location
}

fn remote(doc: &mut DocumentSession, change: impl FnOnce(&mut DocumentSession)) {
    let mut peer = DocumentSession::with_test_client_id(34003).unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let vector = peer.state_vector();
    change(&mut peer);
    doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
        .unwrap();
}

fn remote_prefix(doc: &mut DocumentSession) {
    remote(doc, |peer| {
        peer.edit(Edit::Insert {
            block: "lead".into(),
            offset: 0,
            text: "远端".into(),
        })
        .unwrap();
    });
}

fn begin(doc: &mut DocumentSession, at: u32, length: u32) {
    doc.begin_draft(NativeDraftStart {
        key: "structural".into(),
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
    })
    .unwrap();
}

fn commit(doc: &mut DocumentSession, text: &str) -> Result<(), String> {
    doc.commit_draft(NativeDraftCommit {
        key: "structural".into(),
        text: text.into(),
        selection: None,
    })
}

fn select(doc: &mut DocumentSession, epoch: u64, at: u32, length: u32) {
    doc.set_selection(NativeSelectionRequest {
        view_id: "tail".into(),
        epoch,
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
    })
    .unwrap();
}

fn selection(doc: &DocumentSession) -> (u32, u32) {
    let range = doc.native_projection().unwrap().selections[0]
        .range
        .clone()
        .unwrap();
    (range.location, range.length)
}

fn reject_without_mutation(doc: &mut DocumentSession, text: &str) {
    let before = doc.update(None, 1).unwrap();
    let projection = serde_json::to_value(doc.native_projection().unwrap()).unwrap();
    let undo = doc.undo.undo_stack().len();
    let redo = doc.undo.redo_stack().len();
    assert!(commit(doc, text).is_err());
    assert_eq!(doc.update(None, 1).unwrap(), before);
    assert_eq!(
        serde_json::to_value(doc.native_projection().unwrap()).unwrap(),
        projection
    );
    assert_eq!(doc.undo.undo_stack().len(), undo);
    assert_eq!(doc.undo.redo_stack().len(), redo);
    assert_eq!(doc.active_drafts(), 1);
}

#[test]
fn disjoint_remote_prefix_allows_split_and_followup_input_on_the_old_visible_branch() {
    let mut doc = source();
    let old_start = block_start(&doc, "p");
    doc.fork_input("typing".into(), None).unwrap();
    remote_prefix(&mut doc);
    let authored = doc
        .replace_input(NativeInputEdit {
            key: "typing".into(),
            sequence: 0,
            range: NativeRange {
                location: old_start + 2,
                length: 0,
            },
            text: "\n".into(),
            selection: None,
        })
        .unwrap();
    assert_eq!(authored.text, format!("{PREFIX}\n甲北\n塔乙👩🏽‍🚀\n尾段"));
    let new_block = authored.blocks[2].id.clone().unwrap();
    let authored = doc
        .replace_input(NativeInputEdit {
            key: "typing".into(),
            sequence: 1,
            range: NativeRange {
                location: old_start + 3,
                length: 0,
            },
            text: "续".into(),
            selection: Some(NativeDraftSelection {
                view_id: "typing".into(),
                epoch: 1,
                range: NativeRange {
                    location: old_start + 4,
                    length: 0,
                },
            }),
        })
        .unwrap();
    assert_eq!(authored.blocks[2].id.as_deref(), Some(new_block.as_str()));
    assert_eq!(authored.text, format!("{PREFIX}\n甲北\n续塔乙👩🏽‍🚀\n尾段"));
    let merged = format!("远端{PREFIX}\n甲北\n续塔乙👩🏽‍🚀\n尾段");
    assert_eq!(doc.native_projection().unwrap().text, merged);
    assert_eq!(selection(&doc), (old_start + 6, 0));
    let checkpoint = doc.update(None, 1).unwrap();
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().text,
        format!("远端{PREFIX}\n甲北\n塔乙👩🏽‍🚀\n尾段")
    );
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().text,
        format!("远端{PREFIX}\n{BODY}\n尾段")
    );
    assert!(!doc.undo());
    assert!(doc.redo());
    assert!(doc.redo());
    assert_eq!(doc.native_projection().unwrap().text, merged);
    let mut reopened = DocumentSession::new();
    reopened.apply_remote(&checkpoint, 1).unwrap();
    assert_eq!(reopened.native_projection().unwrap().text, merged);
}

#[test]
fn disjoint_structural_commit_maps_live_tail_comments_and_newer_selection_history() {
    let mut doc = source();
    let old_start = block_start(&doc, "p");
    doc.set_comment_anchors(vec![CommentAnchorRecord {
        id: "quote".into(),
        target_block_id: Some("p".into()),
        target_block_ids_json: "[\"p\"]".into(),
        anchor_json: json!({
            "selectedText": "塔乙", "future": {"preserved": true},
            "blockSnapshots": [{"blockId": "p", "blockText": BODY}],
            "textAnchor": {"startBlockId": "p", "startOffset": 2,
                "endBlockId": "p", "endOffset": 4, "text": "塔乙"}
        })
        .to_string(),
    }])
    .unwrap();
    select(&mut doc, 1, old_start + 2, 2);
    begin(&mut doc, old_start + 2, 0);
    remote_prefix(&mut doc);
    assert_eq!(selection(&doc), (old_start + 4, 2));
    commit(&mut doc, "\n").unwrap();
    assert_eq!(selection(&doc), (old_start + 5, 2));
    let view = doc.native_projection().unwrap();
    assert_eq!(view.comments[0].quote, "塔乙");
    assert_eq!(view.comments[0].ranges[0].location, old_start + 5);
    assert_eq!(view.comments[0].ranges[0].length, 2);
    assert!(doc.undo());
    assert_eq!(selection(&doc), (old_start + 4, 2));
    assert_eq!(
        doc.native_projection().unwrap().comments[0].ranges[0].location,
        old_start + 4
    );
    assert!(doc.redo());
    assert_eq!(selection(&doc), (old_start + 5, 2));
    // A manual selection made after the split must follow the copied emoji's
    // identities back to the original block, rather than restore epoch 1.
    for epoch in 2..=4 {
        select(&mut doc, epoch, old_start + 7, 7);
        assert!(doc.undo());
        assert_eq!(selection(&doc), (old_start + 6, 7));
        assert!(doc.redo());
        assert_eq!(selection(&doc), (old_start + 7, 7));
    }
    let persisted = doc.comment_anchor_records();
    let anchor: Value = serde_json::from_str(&persisted[0].anchor_json).unwrap();
    assert_eq!(anchor["future"], json!({"preserved": true}));
    assert_eq!(anchor["blockSnapshots"][0]["blockText"], BODY);
}

#[test]
fn identical_visible_replacement_with_new_items_rejects_structural_commit_atomically() {
    let mut doc = source();
    let at = block_start(&doc, "p") + 2;
    begin(&mut doc, at, 0);
    let original_text = doc.native_projection().unwrap().text;
    remote(&mut doc, |peer| {
        peer.edit(Edit::Delete {
            block: "p".into(),
            offset: 2,
            length: 1,
        })
        .unwrap();
        peer.edit(Edit::Insert {
            block: "p".into(),
            offset: 2,
            text: "塔".into(),
        })
        .unwrap();
    });
    assert_eq!(doc.native_projection().unwrap().text, original_text);
    reject_without_mutation(&mut doc, "\n");
}

#[test]
fn recreated_domain_block_id_rejects_structural_commit_atomically() {
    let mut doc = source();
    let at = block_start(&doc, "p") + 2;
    begin(&mut doc, at, 0);
    let original_text = doc.native_projection().unwrap().text;
    remote(&mut doc, |peer| {
        let mut txn = peer.doc.transact_mut_with(LOCAL);
        peer.root.remove_range(&mut txn, 1, 1);
        let block = peer
            .root
            .insert(&mut txn, 1, XmlElementPrelim::empty("paragraph"));
        block.insert_attribute(&mut txn, "id", "p");
        block.push_back(&mut txn, XmlTextPrelim::new(BODY));
    });
    assert_eq!(doc.native_projection().unwrap().text, original_text);
    reject_without_mutation(&mut doc, "\n");
}

#[test]
fn concurrent_sibling_insert_rejects_a_join_across_changed_topology_atomically() {
    let mut doc = source();
    let end_of_p = block_start(&doc, "p") + BODY.encode_utf16().count() as u32;
    begin(&mut doc, end_of_p, 1);
    remote(&mut doc, |peer| {
        let mut txn = peer.doc.transact_mut_with(LOCAL);
        let block = peer
            .root
            .insert(&mut txn, 2, XmlElementPrelim::empty("paragraph"));
        block.insert_attribute(&mut txn, "id", "remote-block");
        block.push_back(&mut txn, XmlTextPrelim::new("远端段落"));
    });
    assert!(doc.native_projection().unwrap().text.contains("远端段落"));
    reject_without_mutation(&mut doc, "");
}

#[test]
fn remote_text_metadata_change_rejects_structure_even_with_equal_visible_text() {
    let mut doc = source();
    let at = block_start(&doc, "p") + 2;
    begin(&mut doc, at, 0);
    let original = doc.native_projection().unwrap().text;
    remote(&mut doc, |peer| {
        let mut txn = peer.doc.transact_mut_with(LOCAL);
        let block = peer.editable_block(&txn, "p").unwrap();
        let Some(XmlOut::Text(text)) = block.get(&txn, 0) else {
            unreachable!()
        };
        text.insert_attribute(
            &mut txn,
            "future",
            Any::from_json(r#"{"keep":[1,true]}"#).unwrap(),
        );
    });
    assert_eq!(doc.native_projection().unwrap().text, original);
    reject_without_mutation(&mut doc, "\n");
}

#[test]
fn entity_link_pass_under_open_input_keeps_a_structural_newline() {
    // A view types against its fork while a background link pass marks a
    // name in the same paragraph; Enter at the paragraph end still applies.
    let mut doc = source();
    let start = block_start(&doc, "p");
    doc.fork_input("typing".into(), None).unwrap();
    let linked = doc
        .link_entities(&[EntityLinkTarget {
            name: "北塔".into(),
            kind: "element".into(),
            id: "tower".into(),
        }])
        .unwrap();
    assert_eq!(linked, 1);
    let end = start + BODY.encode_utf16().count() as u32;
    let authored = doc
        .replace_input(NativeInputEdit {
            key: "typing".into(),
            sequence: 0,
            range: NativeRange {
                location: end,
                length: 0,
            },
            text: "\n".into(),
            selection: None,
        })
        .unwrap();
    assert_eq!(authored.text, format!("{PREFIX}\n{BODY}\n\n尾段"));
    assert_eq!(
        doc.native_projection().unwrap().text,
        format!("{PREFIX}\n{BODY}\n\n尾段")
    );
    // The link survives on the unsplit text.
    let spans = doc.entity_link_spans().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].id, "tower");
    // A mid-paragraph split across the link pass keeps both halves.
    let mut doc = source();
    doc.fork_input("typing".into(), None).unwrap();
    doc.link_entities(&[EntityLinkTarget {
        name: "北塔".into(),
        kind: "element".into(),
        id: "tower".into(),
    }])
    .unwrap();
    let authored = doc
        .replace_input(NativeInputEdit {
            key: "typing".into(),
            sequence: 0,
            range: NativeRange {
                location: start + 1,
                length: 0,
            },
            text: "\n".into(),
            selection: None,
        })
        .unwrap();
    assert_eq!(authored.text, format!("{PREFIX}\n甲\n北塔乙👩🏽‍🚀\n尾段"));
}
