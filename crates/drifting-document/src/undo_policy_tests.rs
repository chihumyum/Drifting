use super::*;

fn source(kind: &str) -> DocumentSession {
    let seed = DocumentSession::with_test_client_id(29001).unwrap();
    {
        let mut txn = seed.doc.transact_mut();
        let block = seed.root.push_back(&mut txn, XmlElementPrelim::empty(kind));
        block.insert_attribute(&mut txn, "id", "original");
        block.insert_attribute(&mut txn, "future", "retained");
        if kind == "heading" {
            block.insert_attribute(&mut txn, "level", 2);
        }
        block.push_back(&mut txn, XmlTextPrelim::new("甲北塔乙"));
    }
    let mut doc = DocumentSession::with_test_client_id(29002).unwrap();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    doc
}
fn split(doc: &mut DocumentSession) -> String {
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: 2,
            length: 0,
        },
        text: "\n".into(),
    })
    .unwrap();
    doc.native_projection().unwrap().blocks[1]
        .id
        .clone()
        .unwrap()
}
fn remote(doc: &mut DocumentSession, edits: Vec<Edit>) {
    let mut peer = DocumentSession::with_test_client_id(29003).unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let vector = peer.state_vector();
    for edit in edits {
        peer.edit(edit).unwrap();
    }
    doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
        .unwrap();
}

#[test]
fn structural_undo_retains_remote_subtree_text_identity_marks_and_metadata() {
    for kind in ["paragraph", "heading"] {
        let mut doc = source(kind);
        let copied = split(&mut doc);
        remote(
            &mut doc,
            vec![
                Edit::Insert {
                    block: copied.clone(),
                    offset: 0,
                    text: "远端".into(),
                },
                Edit::Format {
                    block: copied.clone(),
                    offset: 0,
                    length: 2,
                    attributes: [("bold".into(), json!(true))].into_iter().collect(),
                },
            ],
        );
        for _ in 0..3 {
            assert!(doc.undo());
            let view = doc.native_projection().unwrap();
            assert_eq!(view.text, "甲北塔乙\n远端");
            assert_eq!(view.blocks[1].id.as_deref(), Some(copied.as_str()));
            assert!(view.blocks[1].editable);
            assert_eq!(view.blocks[1].attributes["future"], "retained");
            assert_eq!(view.blocks[1].runs[0].attributes["bold"], true);
            let mut reopened = DocumentSession::new();
            reopened
                .apply_remote(&doc.update(None, 1).unwrap(), 1)
                .unwrap();
            assert_eq!(reopened.semantic().unwrap(), doc.semantic().unwrap());
            assert!(doc.redo());
            assert_eq!(doc.native_projection().unwrap().text, "甲北\n远端塔乙");
        }
    }
}

#[test]
fn protected_parent_does_not_disable_regular_attribute_or_local_insert_undo() {
    let mut doc = source("paragraph");
    doc.edit(Edit::SetAttribute {
        block: "original".into(),
        key: "future".into(),
        value: json!("changed"),
    })
    .unwrap();
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().blocks[0].attributes["future"],
        "retained"
    );
    assert!(doc.redo());
    assert_eq!(
        doc.native_projection().unwrap().blocks[0].attributes["future"],
        "changed"
    );
    let _ = split(&mut doc);
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().blocks.len(), 1);
    assert_eq!(doc.native_projection().unwrap().text, "甲北塔乙");
}

#[test]
fn selection_of_remote_append_stays_in_the_protected_parent_through_history() {
    let mut doc = source("paragraph");
    let copied = split(&mut doc);
    remote(
        &mut doc,
        vec![Edit::Insert {
            block: copied,
            offset: 2,
            text: "远端".into(),
        }],
    );
    doc.set_selection(NativeSelectionRequest {
        view_id: "remote".into(),
        epoch: 1,
        revision: doc.revision,
        range: NativeRange {
            location: 5,
            length: 2,
        },
    })
    .unwrap();
    assert!(doc.undo());
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, "甲北塔乙\n远端");
    let range = view.selections[0].range.as_ref().unwrap();
    assert_eq!((range.location, range.length), (5, 2));
    assert!(doc.redo());
    let view = doc.native_projection().unwrap();
    let range = view.selections[0].range.as_ref().unwrap();
    assert_eq!((range.location, range.length), (5, 2));
}

#[test]
fn remote_deletion_and_format_on_remote_text_and_new_comments_survive_undo() {
    let mut doc = source("paragraph");
    let copied = split(&mut doc);
    remote(
        &mut doc,
        vec![
            Edit::Insert {
                block: copied.clone(),
                offset: 0,
                text: "远方潮汐".into(),
            },
            Edit::Delete {
                block: copied.clone(),
                offset: 1,
                length: 1,
            },
            Edit::Format {
                block: copied.clone(),
                offset: 1,
                length: 2,
                attributes: [("italic".into(), json!(true))].into_iter().collect(),
            },
        ],
    );
    doc.set_comment_anchors(vec![CommentAnchorRecord { id: "remote-comment".into(),
        target_block_id: Some(copied.clone()), target_block_ids_json: json!([copied]).to_string(),
        anchor_json: json!({"selectedText":"潮汐", "blockSnapshots":[{"blockId":copied,"blockText":"远潮汐塔乙"}],
            "textAnchor":{"startBlockId":copied,"startOffset":1,"endBlockId":copied,"endOffset":3,"text":"潮汐"}}).to_string()
    }]).unwrap();
    assert!(doc.undo());
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, "甲北塔乙\n远潮汐");
    assert_eq!(view.comments[0].status, "anchored");
    assert_eq!(view.comments[0].ranges[0].length, 2);
    let before = doc.comment_anchor_records();
    let mut reopened = DocumentSession::new();
    reopened
        .apply_remote(&doc.update(None, 1).unwrap(), 1)
        .unwrap();
    reopened.set_comment_anchors(before).unwrap();
    assert_eq!(
        reopened.native_projection().unwrap().comments[0].status,
        "anchored"
    );
    assert!(doc.redo());
    assert_eq!(doc.native_projection().unwrap().text, "甲北\n远潮汐塔乙");
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "anchored"
    );
}
