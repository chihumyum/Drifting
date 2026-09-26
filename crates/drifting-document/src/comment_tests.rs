use super::*;

fn source() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(27001).unwrap();
    for (id, text) in [("p", "甲北塔乙👩🏽‍🚀"), ("q", "海岸")] {
        seed.edit(Edit::AppendParagraph {
            id: id.into(),
            text: text.into(),
        })
        .unwrap();
    }
    let mut doc = DocumentSession::with_test_client_id(27002).unwrap();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    doc
}

fn record() -> CommentAnchorRecord {
    CommentAnchorRecord {id: "comment".into(), target_block_id: Some("p".into()), target_block_ids_json: "[\"p\"]".into(),
        anchor_json: json!({"selectedText":"北塔", "blockSnapshots":[{"blockId":"p","blockText":"甲北塔乙👩🏽‍🚀"}],
            "futureField":{"keep":[1,2]}, "textAnchor":{"startBlockId":"p","startOffset":1,"endBlockId":"p","endOffset":3,"text":"北塔","futureAnchor":true}}).to_string()}
}

fn replace(doc: &mut DocumentSession, at: u32, length: u32, text: &str) {
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
        text: text.into(),
    })
    .unwrap();
}

fn anchor(doc: &DocumentSession) -> Value {
    serde_json::from_str(&doc.comment_anchor_records()[0].anchor_json).unwrap()
}

#[test]
fn split_join_history_and_checkpoint_keep_quote_and_original_snapshots() {
    let mut doc = source();
    let original: Value = serde_json::from_str(&record().anchor_json).unwrap();
    doc.set_comment_anchors(vec![record()]).unwrap();
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "anchored"
    );
    replace(&mut doc, 2, 0, "\n");
    let split = anchor(&doc);
    assert_eq!(split["textAnchor"]["startBlockId"], "p");
    assert_ne!(split["textAnchor"]["endBlockId"], "p");
    assert_eq!(split["textAnchor"]["endOffset"], 1);
    for key in ["blockSnapshots", "selectedText", "futureField"] {
        assert_eq!(split[key], original[key]);
    }
    assert_eq!(split["textAnchor"]["futureAnchor"], true);
    assert_eq!(split["textAnchor"]["text"], "北塔");
    assert_eq!(
        doc.native_projection().unwrap().comments[0].ranges[0].length,
        3
    );
    assert!(doc.undo());
    assert_eq!(anchor(&doc)["textAnchor"], original["textAnchor"]);
    assert!(doc.redo());
    assert_eq!(anchor(&doc)["textAnchor"], split["textAnchor"]);
    let records = doc.comment_anchor_records();
    let mut reopened = DocumentSession::new();
    reopened
        .apply_remote(&doc.update(None, 1).unwrap(), 1)
        .unwrap();
    reopened.set_comment_anchors(records).unwrap();
    assert_eq!(
        reopened.native_projection().unwrap().comments[0].ranges[0].length,
        3
    );
    assert_eq!(anchor(&reopened)["textAnchor"], split["textAnchor"]);
    replace(&mut reopened, 2, 1, "");
    assert_eq!(anchor(&reopened)["textAnchor"], original["textAnchor"]);
    assert!(reopened.undo());
    assert_eq!(anchor(&reopened)["textAnchor"], split["textAnchor"]);
}

#[test]
fn remote_insert_survives_local_structural_undo_and_adjusts_comment_positions() {
    let mut doc = source();
    doc.set_comment_anchors(vec![record()]).unwrap();
    replace(&mut doc, 2, 0, "\n");
    let mut peer = DocumentSession::with_test_client_id(27003).unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let vector = peer.state_vector();
    peer.edit(Edit::Insert {
        block: "p".into(),
        offset: 0,
        text: "远".into(),
    })
    .unwrap();
    doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
        .unwrap();
    assert_eq!(anchor(&doc)["textAnchor"]["startOffset"], 2);
    assert!(doc.undo());
    assert!(doc
        .native_projection()
        .unwrap()
        .text
        .starts_with("远甲北塔乙"));
    assert_eq!(anchor(&doc)["textAnchor"]["startOffset"], 2);
    assert_eq!(anchor(&doc)["textAnchor"]["endOffset"], 4);
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "anchored"
    );
    assert!(doc.redo());
    assert_eq!(anchor(&doc)["textAnchor"]["startOffset"], 2);
    assert_ne!(anchor(&doc)["textAnchor"]["endBlockId"], "p");
}

#[test]
fn deleted_text_and_blocks_keep_anchor_context_until_undo_restores_it() {
    let mut doc = source();
    doc.set_comment_anchors(vec![record()]).unwrap();
    replace(&mut doc, 1, 2, "");
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "collapsed"
    );
    assert_eq!(anchor(&doc)["textAnchor"]["text"], "北塔");
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "anchored"
    );
    doc.edit(Edit::DeleteBlock { block: "p".into() }).unwrap();
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "unresolved"
    );
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "anchored"
    );
}

#[test]
fn external_anchor_revision_and_comments_added_after_edit_are_not_overwritten_by_undo() {
    let mut doc = source();
    doc.set_comment_anchors(vec![record()]).unwrap();
    replace(&mut doc, 0, 0, "新");
    let mut updated = doc.comment_anchor_records()[0].clone();
    let mut payload: Value = serde_json::from_str(&updated.anchor_json).unwrap();
    payload.as_object_mut().unwrap().remove("nativeAnchorV1");
    payload["textAnchor"] =
        json!({"startBlockId":"q","startOffset":0,"endBlockId":"q","endOffset":2,"text":"海岸"});
    updated.anchor_json = payload.to_string();
    updated.target_block_id = Some("q".into());
    updated.target_block_ids_json = "[\"q\"]".into();
    let mut added = updated.clone();
    added.id = "later".into();
    doc.set_comment_anchors(vec![updated, added]).unwrap();
    assert!(doc.undo());
    for comment in doc.native_projection().unwrap().comments {
        assert_eq!(comment.quote, "海岸");
        assert_eq!(comment.status, "anchored");
    }
    assert_eq!(anchor(&doc)["textAnchor"]["startBlockId"], "q");
}

#[test]
fn stale_or_malformed_anchors_never_highlight_unrelated_prose_and_unknown_bytes_survive() {
    let mut doc = source();
    let mut stale = record();
    let mut payload: Value = serde_json::from_str(&stale.anchor_json).unwrap();
    payload["textAnchor"]["text"] = json!("不存在的原文");
    stale.anchor_json = payload.to_string();
    let mut malformed = record();
    malformed.id = "broken".into();
    malformed.anchor_json = "{preserve these bytes".into();
    let originals = vec![malformed.clone(), stale.clone()];
    doc.set_comment_anchors(originals.clone()).unwrap();
    replace(&mut doc, 0, 0, "新");
    assert_eq!(doc.comment_anchor_records(), originals);
    assert!(doc
        .native_projection()
        .unwrap()
        .comments
        .iter()
        .all(|c| c.ranges.is_empty()));
    let mut duplicate = stale.clone();
    duplicate.id = malformed.id.clone();
    assert!(doc.set_comment_anchors(vec![malformed, duplicate]).is_err());
    assert_eq!(doc.comment_anchor_records(), originals);
}

#[test]
fn whole_block_targets_split_and_rejoin_with_their_own_undo_metadata() {
    let mut doc = source();
    let mut whole = record();
    whole.anchor_json = json!({"future":"intact"}).to_string();
    doc.set_comment_anchors(vec![whole]).unwrap();
    replace(&mut doc, 2, 0, "\n");
    assert_eq!(doc.native_projection().unwrap().comments[0].ranges.len(), 2);
    assert_eq!(anchor(&doc), json!({"future":"intact"}));
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().comments[0].ranges.len(), 1);
    assert!(doc.redo());
    assert_eq!(doc.native_projection().unwrap().comments[0].ranges.len(), 2);
}

#[test]
fn stale_quote_offsets_recover_nearest_match_and_cross_block_snapshot_fragments() {
    let mut doc = source();
    let mut comment = record();
    let mut data: Value = serde_json::from_str(&comment.anchor_json).unwrap();
    data["textAnchor"]["startOffset"] = json!(999);
    data["textAnchor"]["endOffset"] = json!(1001);
    comment.anchor_json = data.to_string();
    doc.set_comment_anchors(vec![comment]).unwrap();
    assert_eq!(anchor(&doc)["textAnchor"]["startOffset"], 1);
    let mut cross = record();
    cross.anchor_json=json!({"textAnchor":{"startBlockId":"p","startOffset":3,"endBlockId":"q","endOffset":1,"text":"乙👩🏽‍🚀\n海"},
        "blockSnapshots":[{"blockId":"p","blockText":"甲北塔乙👩🏽‍🚀"},{"blockId":"q","blockText":"海岸"}]}).to_string();
    doc.edit(Edit::Insert {
        block: "p".into(),
        offset: 0,
        text: "前".into(),
    })
    .unwrap();
    doc.edit(Edit::Insert {
        block: "q".into(),
        offset: 0,
        text: "首".into(),
    })
    .unwrap();
    // A new word inside the captured cross-block range means the full quote
    // no longer matches. Keep its context, but do not guess another highlight.
    doc.set_comment_anchors(vec![cross.clone()]).unwrap();
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "unresolved"
    );
    doc.edit(Edit::Delete {
        block: "q".into(),
        offset: 0,
        length: 1,
    })
    .unwrap();
    doc.set_comment_anchors(vec![cross]).unwrap();
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "anchored"
    );
    assert_eq!(anchor(&doc)["textAnchor"]["startOffset"], 4);
}
