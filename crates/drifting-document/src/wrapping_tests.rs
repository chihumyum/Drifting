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
    // A heading wraps as a bullet item too.
    apply(&mut doc, NativeFormatAction::Heading2, 9, 0).unwrap();
    apply(&mut doc, NativeFormatAction::BulletList, 9, 0).unwrap();
    let view = doc.native_projection().unwrap();
    assert_eq!(view.blocks[2].kind, "heading");
    assert_eq!(view.blocks[2].containers, s(&["bulletList", "listItem"]));
    while doc.undo() {}
    assert!(shape(&doc)
        .iter()
        .all(|(_, containers, _)| containers.is_empty()));
}
