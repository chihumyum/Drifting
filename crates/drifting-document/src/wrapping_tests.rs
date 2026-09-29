use super::*;

fn source() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(79001).unwrap();
    for (id, text) in [("a", "开篇🙂"), ("b", "潮汐"), ("c", "夜航")] {
        seed.edit(Edit::AppendParagraph {
            id: id.into(),
            text: text.into(),
        })
        .unwrap();
    }
    let mut doc = DocumentSession::with_test_client_id(79002).unwrap();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    doc
}

fn apply(
    doc: &mut DocumentSession,
    action: NativeFormatAction,
    at: u32,
    length: u32,
) -> Result<(), String> {
    doc.format_native(NativeFormatting {
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
        action,
    })
}

/// Each block's id and enclosing containers.
fn shape(doc: &DocumentSession) -> Vec<(String, Vec<String>, Option<u32>)> {
    doc.native_projection()
        .unwrap()
        .blocks
        .into_iter()
        .map(|block| (block.id.unwrap(), block.containers, block.list_number))
        .collect()
}

fn s(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

#[test]
fn native_quote_wraps_and_lifts_top_level_blocks_in_one_unit_each() {
    let mut doc = source();
    // A bold mark and a comment survive the reconstruction.
    let text = doc.editable_text(&doc.doc.transact(), "b").unwrap();
    text.format(
        &mut doc.doc.transact_mut_with(REMOTE),
        0,
        1,
        [("bold".into(), Any::Map(Default::default()))]
            .into_iter()
            .collect(),
    );
    doc.set_comment_anchors(vec![CommentAnchorRecord {
        id: "note".into(),
        target_block_id: Some("b".into()),
        target_block_ids_json: "[\"b\"]".into(),
        anchor_json: json!({"selectedText":"潮汐",
            "blockSnapshots":[{"blockId":"b","blockText":"潮汐"}],
            "textAnchor":{"startBlockId":"b","startOffset":0,"endBlockId":"b","endOffset":2,"text":"潮汐"}})
        .to_string(),
    }])
    .unwrap();
    let before = doc.semantic().unwrap();
    let text_before = doc.native_projection().unwrap().text;
    let log = doc.capture_authored_updates().unwrap();
    // "开篇🙂" is 4 units; the selection spans a and b.
    apply(&mut doc, NativeFormatAction::Blockquote, 1, 6).unwrap();
    assert_eq!(log.drain_records().len(), 1);
    assert_eq!(
        shape(&doc),
        vec![
            ("a".into(), s(&["blockquote"]), None),
            ("b".into(), s(&["blockquote"]), None),
            ("c".into(), s(&[]), None),
        ]
    );
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, text_before);
    assert!(view.blocks[1].runs[0].attributes.contains_key("bold"));
    let comment = &view.comments[0];
    assert_eq!(comment.status, "anchored");
    assert_eq!(
        (comment.ranges[0].location, comment.ranges[0].length),
        (5, 2)
    );
    // Lifting all of it restores the original document.
    apply(&mut doc, NativeFormatAction::Blockquote, 0, 7).unwrap();
    assert_eq!(doc.semantic().unwrap(), before);
    assert!(doc.undo());
    assert_eq!(shape(&doc)[0].1, s(&["blockquote"]));
    assert!(doc.undo());
    assert_eq!(doc.semantic().unwrap(), before);
    assert!(doc.redo());
    assert_eq!(shape(&doc)[1].1, s(&["blockquote"]));
}

#[test]
fn native_quote_lifts_its_first_or_last_blocks_and_refuses_the_middle() {
    let mut doc = source();
    apply(&mut doc, NativeFormatAction::Blockquote, 0, 10).unwrap();
    assert!(shape(&doc)
        .iter()
        .all(|(_, containers, _)| *containers == s(&["blockquote"])));
    // The middle block cannot leave without moving an unselected sibling.
    let revision = doc.revision;
    assert!(apply(&mut doc, NativeFormatAction::Blockquote, 5, 0).is_err());
    assert_eq!(doc.revision, revision);
    // The first goes before the quote, the last after it.
    apply(&mut doc, NativeFormatAction::Blockquote, 0, 0).unwrap();
    apply(&mut doc, NativeFormatAction::Blockquote, 8, 0).unwrap();
    assert_eq!(
        shape(&doc),
        vec![
            ("a".into(), s(&[]), None),
            ("b".into(), s(&["blockquote"]), None),
            ("c".into(), s(&[]), None),
        ]
    );
    // Mixed root and quoted blocks refuse; so does a list action inside a quote.
    assert!(apply(&mut doc, NativeFormatAction::Blockquote, 0, 6).is_err());
    assert!(apply(&mut doc, NativeFormatAction::BulletList, 5, 0).is_err());
    assert_eq!(doc.native_projection().unwrap().text, "开篇🙂\n潮汐\n夜航");
}

#[test]
fn native_lists_wrap_each_block_in_an_item_number_and_lift() {
    let mut doc = source();
    let log = doc.capture_authored_updates().unwrap();
    apply(&mut doc, NativeFormatAction::OrderedList, 0, 10).unwrap();
    assert_eq!(log.drain_records().len(), 1);
    assert_eq!(
        shape(&doc),
        vec![
            ("a".into(), s(&["orderedList", "listItem"]), Some(1)),
            ("b".into(), s(&["orderedList", "listItem"]), Some(2)),
            ("c".into(), s(&["orderedList", "listItem"]), Some(3)),
        ]
    );
    // The other list kind refuses; lifting the last item leaves two.
    assert!(apply(&mut doc, NativeFormatAction::BulletList, 0, 0).is_err());
    apply(&mut doc, NativeFormatAction::OrderedList, 9, 0).unwrap();
    assert_eq!(shape(&doc)[2], ("c".into(), s(&[]), None));
    assert_eq!(shape(&doc)[1].2, Some(2));
    // A heading cannot become a list item; a quote takes it.
    apply(&mut doc, NativeFormatAction::Heading2, 9, 0).unwrap();
    assert!(apply(&mut doc, NativeFormatAction::BulletList, 9, 0).is_err());
    apply(&mut doc, NativeFormatAction::Blockquote, 9, 0).unwrap();
    let view = doc.native_projection().unwrap();
    assert_eq!(view.blocks[2].kind, "heading");
    assert_eq!(view.blocks[2].containers, s(&["blockquote"]));
    while doc.undo() {}
    assert!(shape(&doc)
        .iter()
        .all(|(_, containers, _)| containers.is_empty()));
}

fn rule(doc: &mut DocumentSession, location: u32, action: NativeRuleAction) -> Result<u32, String> {
    doc.rule_native(NativeRuleEdit {
        revision: doc.revision,
        location,
        action,
    })
}

#[test]
fn native_rules_insert_after_a_block_or_before_an_empty_one_and_remove() {
    let mut doc = source();
    doc.set_comment_anchors(vec![CommentAnchorRecord {
        id: "note".into(),
        target_block_id: Some("c".into()),
        target_block_ids_json: "[\"c\"]".into(),
        anchor_json: json!({"selectedText":"夜航",
            "blockSnapshots":[{"blockId":"c","blockText":"夜航"}],
            "textAnchor":{"startBlockId":"c","startOffset":0,"endBlockId":"c","endOffset":2,"text":"夜航"}})
        .to_string(),
    }])
    .unwrap();
    let before = doc.semantic().unwrap();
    let log = doc.capture_authored_updates().unwrap();
    // After 潮汐: the rule, then an empty paragraph holding the caret.
    let caret = rule(&mut doc, 6, NativeRuleAction::Insert).unwrap();
    assert_eq!(log.drain_records().len(), 1);
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, "开篇🙂\n潮汐\n\u{fffc}\n\n夜航");
    assert_eq!(view.blocks[2].kind, "horizontalRule");
    assert!(!view.blocks[2].editable && view.blocks[2].id.is_some());
    assert_eq!(caret, view.blocks[3].range.location);
    assert_eq!(view.comments[0].status, "anchored");
    assert_eq!(view.comments[0].ranges[0].location, 11);
    // In that empty paragraph another rule goes before it.
    let caret = rule(&mut doc, caret, NativeRuleAction::Insert).unwrap();
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, "开篇🙂\n潮汐\n\u{fffc}\n\u{fffc}\n\n夜航");
    assert_eq!(caret, view.blocks[4].range.location);
    // Removing a rule by its location; text blocks and other places refuse.
    let second = view.blocks[3].range.location;
    rule(&mut doc, second, NativeRuleAction::Remove).unwrap();
    assert_eq!(
        doc.native_projection().unwrap().text,
        "开篇🙂\n潮汐\n\u{fffc}\n\n夜航"
    );
    let revision = doc.revision;
    assert!(rule(&mut doc, 5, NativeRuleAction::Remove).is_err());
    assert_eq!(doc.revision, revision);
    assert_eq!(
        doc.native_projection().unwrap().comments[0].status,
        "anchored"
    );
    // Each edit is one undo unit.
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().text,
        "开篇🙂\n潮汐\n\u{fffc}\n\u{fffc}\n\n夜航"
    );
    while doc.undo() {}
    assert_eq!(doc.semantic().unwrap(), before);
}

#[test]
fn native_list_item_split_turns_an_items_new_last_paragraph_into_the_next_item() {
    let mut doc = source();
    apply(&mut doc, NativeFormatAction::OrderedList, 0, 10).unwrap();
    // Enter at the end of 开篇🙂 adds a paragraph to the same item.
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: 4,
            length: 0,
        },
        text: "\n".into(),
    })
    .unwrap();
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, "开篇🙂\n\n潮汐\n夜航");
    assert_eq!(view.blocks[1].list_number, Some(1));
    let new_id = view.blocks[1].id.clone().unwrap();
    // The first paragraph of an item does not split; the new one does.
    let revision = doc.revision;
    assert!(apply(&mut doc, NativeFormatAction::SplitListItem, 0, 0).is_err());
    assert_eq!(doc.revision, revision);
    let log = doc.capture_authored_updates().unwrap();
    apply(&mut doc, NativeFormatAction::SplitListItem, 5, 0).unwrap();
    assert_eq!(log.drain_records().len(), 1);
    let numbers: Vec<_> = doc
        .native_projection()
        .unwrap()
        .blocks
        .into_iter()
        .map(|block| (block.id.unwrap(), block.list_number))
        .collect();
    assert_eq!(
        numbers,
        vec![
            ("a".into(), Some(1)),
            (new_id.clone(), Some(2)),
            ("b".into(), Some(3)),
            ("c".into(), Some(4)),
        ]
    );
    // The new empty item, not the last, stays; lifting needs it last.
    assert!(apply(&mut doc, NativeFormatAction::OrderedList, 5, 0).is_err());
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().blocks[1].list_number,
        Some(1)
    );
}

fn numbers(doc: &DocumentSession) -> Vec<Option<u32>> {
    doc.native_projection()
        .unwrap()
        .blocks
        .into_iter()
        .map(|block| block.list_number)
        .collect()
}

#[test]
fn native_lists_built_one_block_at_a_time_join_their_neighbour() {
    let mut doc = source();
    apply(&mut doc, NativeFormatAction::OrderedList, 0, 0).unwrap();
    apply(&mut doc, NativeFormatAction::OrderedList, 5, 0).unwrap();
    apply(&mut doc, NativeFormatAction::OrderedList, 8, 0).unwrap();
    assert_eq!(numbers(&doc), vec![Some(1), Some(2), Some(3)]);
    // One list: selecting all of it lifts it whole.
    apply(&mut doc, NativeFormatAction::OrderedList, 0, 10).unwrap();
    assert_eq!(numbers(&doc), vec![None, None, None]);
    // A block before a list joins it at the front.
    apply(&mut doc, NativeFormatAction::BulletList, 8, 0).unwrap();
    apply(&mut doc, NativeFormatAction::BulletList, 5, 0).unwrap();
    let view = doc.native_projection().unwrap();
    assert_eq!(view.blocks[1].containers, view.blocks[2].containers);
    apply(&mut doc, NativeFormatAction::BulletList, 5, 5).unwrap();
    assert!(doc
        .native_projection()
        .unwrap()
        .blocks
        .iter()
        .all(|b| b.containers.is_empty()));
    // Undo after redo still works.
    assert!(doc.undo());
    assert!(doc.redo());
    assert!(doc.undo());
}

#[test]
fn native_backspace_after_a_list_removes_the_empty_paragraph_left_behind() {
    let mut seed = DocumentSession::with_test_client_id(79201).unwrap();
    for (id, text) in [("a", "开篇"), ("b", "潮汐"), ("e", "")] {
        seed.edit(Edit::AppendParagraph {
            id: id.into(),
            text: text.into(),
        })
        .unwrap();
    }
    let mut doc = DocumentSession::with_test_client_id(79202).unwrap();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    apply(&mut doc, NativeFormatAction::OrderedList, 0, 5).unwrap();
    assert_eq!(doc.native_projection().unwrap().text, "开篇\n潮汐\n");
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: 5,
            length: 1,
        },
        text: String::new(),
    })
    .unwrap();
    let view = doc.native_projection().unwrap();
    assert_eq!(view.text, "开篇\n潮汐");
    assert_eq!(view.blocks.len(), 2);
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().blocks.len(), 3);
}

#[test]
fn native_undo_of_a_wrap_refuses_when_another_writer_typed_into_it() {
    let mut doc = source();
    apply(&mut doc, NativeFormatAction::Blockquote, 5, 0).unwrap();
    let mut peer = DocumentSession::with_test_client_id(79301).unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    peer.replace_native(NativeReplacement {
        revision: peer.revision,
        range: NativeRange {
            location: 5,
            length: 0,
        },
        text: "远".into(),
    })
    .unwrap();
    doc.apply_remote(&peer.update(None, 1).unwrap(), 1).unwrap();
    let before = doc.semantic().unwrap();
    let error = doc.try_undo().unwrap_err();
    assert!(error.starts_with(NATIVE_HISTORY_UNAVAILABLE), "{error}");
    assert_eq!(doc.semantic().unwrap(), before);
    let ids: Vec<_> = doc
        .native_projection()
        .unwrap()
        .blocks
        .into_iter()
        .map(|block| block.id.unwrap())
        .collect();
    assert_eq!(ids, ["a", "b", "c"]);
}
