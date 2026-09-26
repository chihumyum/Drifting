use super::*;

fn source() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(31001).unwrap();
    seed.edit(Edit::AppendParagraph {
        id: "p".into(),
        text: "甲北塔乙👩🏽‍🚀".into(),
    })
    .unwrap();
    let mut doc = DocumentSession::with_test_client_id(31002).unwrap();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    doc
}
fn begin(doc: &mut DocumentSession, key: &str, at: u32, length: u32) {
    doc.begin_draft(NativeDraftStart {
        key: key.into(),
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
    })
    .unwrap();
}
fn commit(doc: &mut DocumentSession, key: &str, text: &str) {
    doc.commit_draft(NativeDraftCommit {
        key: key.into(),
        text: text.into(),
        selection: None,
    })
    .unwrap();
}
fn remote(doc: &mut DocumentSession, edits: Vec<Edit>) {
    let mut peer = DocumentSession::with_test_client_id(31003).unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let vector = peer.state_vector();
    for edit in edits {
        peer.edit(edit).unwrap();
    }
    doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
        .unwrap();
}

#[test]
fn draft_replaces_original_items_and_preserves_overlapping_remote_insertion_and_history() {
    let mut doc = source();
    let snapshot = doc.update(None, 1).unwrap();
    begin(&mut doc, "ime", 1, 2);
    assert_eq!(doc.update(None, 1).unwrap(), snapshot);
    assert!(!doc.undo());
    remote(
        &mut doc,
        vec![Edit::Insert {
            block: "p".into(),
            offset: 2,
            text: "远".into(),
        }],
    );
    doc.commit_draft(NativeDraftCommit {
        key: "ime".into(),
        text: "新".into(),
        selection: Some(NativeDraftSelection {
            view_id: "ime-view".into(),
            epoch: 1,
            range: NativeRange {
                location: 2,
                length: 0,
            },
        }),
    })
    .unwrap();
    let caret = doc.native_projection().unwrap().selections[0]
        .range
        .clone()
        .unwrap();
    let merged = doc.native_projection().unwrap().text;
    let authored_end = merged[..merged.find('新').unwrap()].encode_utf16().count() as u32 + 1;
    assert_eq!(
        caret.location, authored_end,
        "Caret must remain immediately after authored 新"
    );
    assert!(merged.contains('远'));
    assert!(merged.contains('新'));
    assert!(!merged.contains('北'));
    assert!(!merged.contains('塔'));
    assert_eq!(doc.active_drafts(), 0);
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, "甲北远塔乙👩🏽‍🚀");
    assert!(!doc.undo());
    assert!(doc.redo());
    assert_eq!(doc.native_projection().unwrap().text, merged);
    assert!(doc
        .commit_draft(NativeDraftCommit {
            key: "ime".into(),
            text: "重复".into(),
            selection: None
        })
        .is_err());
}

#[test]
fn draft_selection_uses_authored_positions_after_remote_prefix_and_delete() {
    let mut doc = source();
    begin(&mut doc, "ime", 1, 2);
    remote(
        &mut doc,
        vec![
            Edit::Delete {
                block: "p".into(),
                offset: 2,
                length: 1,
            },
            Edit::Insert {
                block: "p".into(),
                offset: 0,
                text: "远端".into(),
            },
        ],
    );
    doc.commit_draft(NativeDraftCommit {
        key: "ime".into(),
        text: "新词".into(),
        selection: Some(NativeDraftSelection {
            view_id: "view".into(),
            epoch: 8,
            range: NativeRange {
                location: 3,
                length: 0,
            },
        }),
    })
    .unwrap();
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, "远端甲新词乙👩🏽‍🚀");
    assert_eq!(view.selections[0].range.as_ref().unwrap().location, 5);
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, "远端甲北乙👩🏽‍🚀");
}

#[test]
fn overlapping_local_views_commit_as_separate_authors_without_overwriting_each_other() {
    let mut doc = source();
    begin(&mut doc, "a", 1, 2);
    begin(&mut doc, "b", 1, 2);
    commit(&mut doc, "a", "日");
    commit(&mut doc, "b", "月");
    let value = doc.native_projection().unwrap().text;
    assert!(value.contains('日') && value.contains('月'));
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, "甲日乙👩🏽‍🚀");
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, "甲北塔乙👩🏽‍🚀");
    assert!(doc.redo());
    assert!(doc.redo());
    assert_eq!(doc.native_projection().unwrap().text, value);
}

#[test]
fn draft_validation_cancel_and_rejected_commit_leave_live_state_untouched() {
    let mut doc = source();
    begin(&mut doc, "ime", 1, 2);
    let before = doc.update(None, 1).unwrap();
    let revision = doc.revision;
    assert!(doc
        .begin_draft(NativeDraftStart {
            key: "ime".into(),
            revision,
            range: NativeRange {
                location: 0,
                length: 0
            }
        })
        .is_err());
    assert!(doc
        .begin_draft(NativeDraftStart {
            key: "bad".into(),
            revision: revision - 1,
            range: NativeRange {
                location: 0,
                length: 0
            }
        })
        .is_err());
    assert!(doc
        .commit_draft(NativeDraftCommit {
            key: "ime".into(),
            text: "新".into(),
            selection: Some(NativeDraftSelection {
                view_id: "v".into(),
                epoch: 1,
                range: NativeRange {
                    location: 999,
                    length: 0
                }
            })
        })
        .is_err());
    assert_eq!(doc.active_drafts(), 1);
    assert_eq!(doc.update(None, 1).unwrap(), before);
    assert_eq!(doc.revision, revision);
    doc.cancel_draft("ime");
    doc.cancel_draft("ime");
    assert_eq!(doc.active_drafts(), 0);
    assert!(!doc.undo());
}

#[test]
fn unchanged_structural_draft_keeps_the_standard_maps_and_remote_structure_is_explicit() {
    let mut doc = source();
    doc.set_comment_anchors(vec![CommentAnchorRecord {
        id: "comment".into(), target_block_id: Some("p".into()), target_block_ids_json: "[\"p\"]".into(),
        anchor_json: json!({"selectedText":"北塔", "blockSnapshots":[{"blockId":"p","blockText":"甲北塔乙👩🏽‍🚀"}],
            "textAnchor":{"startBlockId":"p","startOffset":1,"endBlockId":"p","endOffset":3,"text":"北塔"}}).to_string(),
    }]).unwrap();
    begin(&mut doc, "enter", 2, 0);
    let duplicate = doc.update(None, 1).unwrap();
    doc.apply_remote(&duplicate, 1).unwrap();
    commit(&mut doc, "enter", "\n");
    assert_eq!(doc.native_projection().unwrap().text, "甲北\n塔乙👩🏽‍🚀");
    assert_eq!(
        doc.native_projection().unwrap().comments[0].ranges[0].length,
        3
    );
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().comments[0].ranges[0].length,
        2
    );
    assert_eq!(doc.native_projection().unwrap().text, "甲北塔乙👩🏽‍🚀");
    begin(&mut doc, "concurrent", 2, 0);
    remote(
        &mut doc,
        vec![Edit::Insert {
            block: "p".into(),
            offset: 0,
            text: "远".into(),
        }],
    );
    commit(&mut doc, "concurrent", "\n");
    assert_eq!(doc.native_projection().unwrap().text, "远甲北\n塔乙👩🏽‍🚀");
    assert_eq!(doc.active_drafts(), 0);
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, "远甲北塔乙👩🏽‍🚀");
    begin(&mut doc, "removed", 2, 0);
    remote(&mut doc, vec![Edit::DeleteBlock { block: "p".into() }]);
    let before = doc.update(None, 1).unwrap();
    assert!(doc
        .commit_draft(NativeDraftCommit {
            key: "removed".into(),
            text: "新".into(),
            selection: None
        })
        .is_err());
    assert_eq!(doc.update(None, 1).unwrap(), before);
}
