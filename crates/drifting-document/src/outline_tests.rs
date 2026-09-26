use super::*;

fn heading(
    parent: &impl XmlFragment,
    txn: &mut yrs::TransactionMut,
    id: Option<&str>,
    level: i64,
    value: &str,
) {
    let block = parent.push_back(txn, XmlElementPrelim::empty("heading"));
    if let Some(id) = id {
        block.insert_attribute(txn, "id", id);
    }
    block.insert_attribute(txn, "level", level);
    block.push_back(txn, XmlTextPrelim::new(value));
}

#[test]
fn native_outline_uses_unique_live_headings_utf16_ranges_and_nearest_lower_parent() {
    let mut doc = DocumentSession::new();
    doc.edit(Edit::AppendParagraph {
        id: "p".into(),
        text: "🙂e\u{301}".into(),
    })
    .unwrap();
    {
        let mut txn = doc.doc.transact_mut_with(REMOTE);
        heading(&doc.root, &mut txn, Some("beat"), 2, " 先拍🙂 ");
        heading(&doc.root, &mut txn, Some("note"), 3, "注e\u{301}");
        heading(&doc.root, &mut txn, Some("scene"), 1, "场");
        let quote = doc
            .root
            .push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
        quote.insert_attribute(&mut txn, "id", "quote");
        heading(&quote, &mut txn, Some("nested"), 3, "跨级注");
        heading(&doc.root, &mut txn, Some("blank"), 2, " \t\u{feff}");
        heading(&doc.root, &mut txn, None, 1, "无身份");
        heading(&doc.root, &mut txn, Some("duplicate"), 1, "重复一");
        heading(&doc.root, &mut txn, Some("duplicate"), 1, "重复二");
        heading(&doc.root, &mut txn, Some("invalid"), 4, "无效级别");
        let unsupported = doc
            .root
            .push_back(&mut txn, XmlElementPrelim::empty("heading"));
        unsupported.insert_attribute(&mut txn, "id", "unsupported");
        unsupported.insert_attribute(&mut txn, "level", 1);
        unsupported.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        heading(&doc.root, &mut txn, Some("next"), 2, "后拍");
    }
    let before = doc.update(None, 1).unwrap();
    let projection = doc.native_projection().unwrap();
    let items = &projection.outline;
    assert_eq!(
        items
            .iter()
            .map(|item| (
                item.block_id.as_str(),
                item.level,
                item.parent_id.as_deref()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("beat", 2, None),
            ("note", 3, Some("beat")),
            ("scene", 1, None),
            ("nested", 3, Some("scene")),
            ("next", 2, Some("scene"))
        ]
    );
    assert_eq!(items[0].text, "先拍🙂");
    assert_eq!(items[0].range.location, 5); // emoji + e + combining mark + LF
    let units = projection.text.encode_utf16().collect::<Vec<_>>();
    for item in items {
        let block = projection
            .blocks
            .iter()
            .find(|block| block.id.as_ref() == Some(&item.block_id))
            .unwrap();
        assert_eq!(
            serde_json::to_value(&item.range).unwrap(),
            serde_json::to_value(&block.range).unwrap()
        );
        let range =
            item.range.location as usize..(item.range.location + item.range.length) as usize;
        assert_eq!(String::from_utf16(&units[range]).unwrap().trim(), item.text);
    }
    assert_eq!(
        doc.update(None, 1).unwrap(),
        before,
        "outline is a read projection"
    );
}

#[test]
fn native_outline_tracks_format_text_history_and_cold_yjs_replay() {
    let mut seed = DocumentSession::new();
    seed.edit(Edit::AppendParagraph {
        id: "p".into(),
        text: "场🙂".into(),
    })
    .unwrap();
    seed.edit(Edit::AppendParagraph {
        id: "q".into(),
        text: "注".into(),
    })
    .unwrap();
    let mut doc = DocumentSession::new();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    let log = doc.capture_authored_updates().unwrap();
    assert!(doc.native_projection().unwrap().outline.is_empty());
    doc.format_native(NativeFormatting {
        revision: doc.revision,
        range: NativeRange {
            location: 0,
            length: 0,
        },
        action: NativeFormatAction::Heading1,
    })
    .unwrap();
    doc.format_native(NativeFormatting {
        revision: doc.revision,
        range: NativeRange {
            location: 4,
            length: 0,
        },
        action: NativeFormatAction::Heading3,
    })
    .unwrap();
    let outline = serde_json::to_value(doc.native_projection().unwrap().outline).unwrap();
    assert_eq!(outline[1]["parentId"], "p");
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: 1,
            length: 0,
        },
        text: "新".into(),
    })
    .unwrap();
    assert_eq!(doc.native_projection().unwrap().outline[0].text, "场新🙂");
    assert_eq!(
        doc.native_projection().unwrap().outline[1].range.location,
        5
    );
    assert!(doc.undo());
    assert_eq!(
        serde_json::to_value(doc.native_projection().unwrap().outline).unwrap(),
        outline
    );
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().outline.len(), 1);
    assert!(doc.redo());
    assert!(doc.redo());
    let mut peer = DocumentSession::new();
    peer.apply_remote(&seed.update(None, 1).unwrap(), 1)
        .unwrap();
    for update in log.drain_records() {
        peer.apply_remote(update.update(), 1).unwrap();
    }
    let expected = serde_json::to_value(doc.native_projection().unwrap().outline).unwrap();
    assert_eq!(
        serde_json::to_value(peer.native_projection().unwrap().outline).unwrap(),
        expected
    );
    let mut reopened = DocumentSession::new();
    reopened
        .apply_remote(&doc.update(None, 1).unwrap(), 1)
        .unwrap();
    assert_eq!(
        serde_json::to_value(reopened.native_projection().unwrap().outline).unwrap(),
        expected
    );
    assert!(log.is_empty());
}
