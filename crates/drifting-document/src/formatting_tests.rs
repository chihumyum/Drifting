use super::*;

fn source() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(78001).unwrap();
    for (id, text) in [("p", "甲🙂e\u{301}"), ("q", "海岸")] {
        seed.edit(Edit::AppendParagraph {
            id: id.into(),
            text: text.into(),
        })
        .unwrap();
    }
    let mut doc = DocumentSession::with_test_client_id(78002).unwrap();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    doc
}

fn format(doc: &mut DocumentSession, action: NativeFormatAction, at: u32, length: u32) {
    doc.format_native(NativeFormatting {
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
        action,
    })
    .unwrap();
}

fn text(doc: &DocumentSession, id: &str) -> XmlTextRef {
    doc.editable_text(&doc.doc.transact(), id).unwrap()
}

fn mark(doc: &DocumentSession, id: &str, at: u32, len: u32, attributes: Attrs) {
    text(doc, id).format(&mut doc.doc.transact_mut_with(REMOTE), at, len, attributes);
}

fn marks(doc: &DocumentSession, id: &str) -> Vec<(String, Attrs)> {
    text(doc, id)
        .diff(&doc.doc.transact(), YChange::identity)
        .into_iter()
        .map(|run| {
            let Out::Any(Any::String(text)) = run.insert else {
                panic!("text")
            };
            (
                text.to_string(),
                run.attributes.map(|value| *value).unwrap_or_default(),
            )
        })
        .collect()
}

fn select(doc: &mut DocumentSession, epoch: u64, at: u32, length: u32) {
    doc.set_selection(NativeSelectionRequest {
        view_id: "view".into(),
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
    let view = doc.native_projection().unwrap();
    let range = view.selections[0].range.as_ref().unwrap();
    (range.location, range.length)
}

fn comment() -> CommentAnchorRecord {
    CommentAnchorRecord {
        id: "comment".into(),
        target_block_id: Some("p".into()),
        target_block_ids_json: "[\"p\"]".into(),
        anchor_json: json!({"selectedText":"🙂e\u{301}","future":{"keep":true},
            "blockSnapshots":[{"blockId":"p","blockText":"甲🙂e\u{301}"}],
            "textAnchor":{"startBlockId":"p","startOffset":1,"endBlockId":"p","endOffset":5,
                "text":"🙂e\u{301}","futureAnchor":[1,2]}})
        .to_string(),
    }
}

fn assert_comment(doc: &DocumentSession) {
    let view = doc.native_projection().unwrap();
    let comment = &view.comments[0];
    assert_eq!(comment.status, "anchored");
    let units: Vec<_> = view.text.encode_utf16().collect();
    let range = &comment.ranges[0];
    assert_eq!(
        String::from_utf16(
            &units[range.location as usize..(range.location + range.length) as usize]
        )
        .unwrap(),
        "🙂e\u{301}"
    );
    let payload: Value =
        serde_json::from_str(&doc.comment_anchor_records()[0].anchor_json).unwrap();
    assert_eq!(payload["future"], json!({"keep":true}));
    assert_eq!(payload["textAnchor"]["futureAnchor"], json!([1, 2]));
}

#[test]
fn native_format_inline_multiblock_toggles_preserve_other_marks_and_one_history_unit() {
    let mut doc = source();
    let link = Any::from_json(r#"{"entityId":"synthetic","future":{"x":[1,true]}}"#).unwrap();
    mark(
        &doc,
        "p",
        1,
        2,
        [
            ("entityLink".into(), link.clone()),
            ("bold--abcdefgh".into(), Any::Map(Default::default())),
            (
                "futureMark".into(),
                Any::from_json(r#"{"keep":null}"#).unwrap(),
            ),
        ]
        .into_iter()
        .collect(),
    );
    mark(
        &doc,
        "q",
        0,
        1,
        [("italic".into(), Any::Map(Default::default()))]
            .into_iter()
            .collect(),
    );
    let before = doc.semantic().unwrap();
    select(&mut doc, 1, 1, 7);
    doc.set_comment_anchors(vec![comment()]).unwrap();
    let log = doc.capture_authored_updates().unwrap();
    format(&mut doc, NativeFormatAction::Bold, 1, 7);
    assert_eq!(log.drain_records().len(), 1);
    assert_eq!(selection(&doc), (1, 7));
    assert_comment(&doc);
    assert_eq!(marks(&doc, "p")[1].1["entityLink"], link);
    assert!(marks(&doc, "q")
        .iter()
        .all(|(_, attrs)| attrs.contains_key("bold")));
    let bold = doc.semantic().unwrap();
    format(&mut doc, NativeFormatAction::Bold, 1, 7);
    assert_eq!(log.drain_records().len(), 1);
    assert!(marks(&doc, "p")
        .iter()
        .all(|(_, attrs)| !attrs.keys().any(|key| key.starts_with("bold"))));
    assert!(marks(&doc, "q")[0].1.contains_key("italic"));
    assert!(doc.undo());
    assert_eq!(doc.semantic().unwrap(), bold);
    assert!(doc.undo());
    assert_eq!(doc.semantic().unwrap(), before);
    assert!(!doc.undo());
    assert!(doc.redo());
    assert!(doc.redo());
    assert_comment(&doc);
    assert_eq!(selection(&doc), (1, 7));
}

#[test]
fn native_format_heading_tags_levels_typed_metadata_anchors_history_and_reopen() {
    let mut doc = source();
    let blob = Any::Buffer(vec![0, 1, 255].into());
    {
        let mut txn = doc.doc.transact_mut_with(REMOTE);
        let element = doc.find_block(&txn, "p").unwrap();
        element.insert_attribute(&mut txn, "futureBlock", blob.clone());
        let Some(XmlOut::Text(text)) = element.get(&txn, 0) else {
            panic!("text")
        };
        text.insert_attribute(&mut txn, "futureText", blob.clone());
        text.insert_attribute(&mut txn, "futureUndefined", Any::Undefined);
    }
    let before = doc.semantic().unwrap();
    doc.set_comment_anchors(vec![comment()]).unwrap();
    select(&mut doc, 1, 1, 7);
    let log = doc.capture_authored_updates().unwrap();
    format(&mut doc, NativeFormatAction::Heading2, 1, 7);
    assert_eq!(log.drain_records().len(), 1);
    assert_eq!(doc.semantic().unwrap()["content"][0]["type"], "heading");
    assert!(doc
        .native_projection()
        .unwrap()
        .blocks
        .iter()
        .all(|block| block.kind == "heading" && block.attributes["level"] == 2));
    assert_eq!(selection(&doc), (1, 7));
    assert_comment(&doc);
    let heading = doc.semantic().unwrap();
    select(&mut doc, 2, 3, 2); // A newer selection also follows reconstructed IDs.
    for _ in 0..2 {
        assert!(doc.undo());
        assert_eq!(doc.semantic().unwrap(), before);
        assert_eq!(selection(&doc), (3, 2));
        assert_comment(&doc);
        assert!(doc.redo());
        assert_eq!(doc.semantic().unwrap(), heading);
        assert_eq!(selection(&doc), (3, 2));
        assert_comment(&doc);
    }
    format(&mut doc, NativeFormatAction::Heading3, 0, 0);
    let same = doc.update(None, 1).unwrap();
    let revision = doc.revision;
    format(&mut doc, NativeFormatAction::Heading3, 0, 0);
    assert_eq!(doc.update(None, 1).unwrap(), same);
    assert_eq!(doc.revision, revision);
    let mut reopened = DocumentSession::new();
    reopened.apply_remote(&same, 1).unwrap();
    reopened
        .set_comment_anchors(doc.comment_anchor_records())
        .unwrap();
    assert_eq!(reopened.semantic().unwrap(), doc.semantic().unwrap());
    assert_comment(&reopened);
    let txn = reopened.doc.transact();
    assert_eq!(
        reopened
            .find_block(&txn, "p")
            .unwrap()
            .get_attribute(&txn, "futureBlock"),
        Some(Out::Any(blob.clone()))
    );
    let target = text(&reopened, "p");
    assert_eq!(
        target.get_attribute(&txn, "futureText"),
        Some(Out::Any(blob))
    );
    assert_eq!(
        target.get_attribute(&txn, "futureUndefined"),
        Some(Out::Any(Any::Undefined))
    );
}

#[test]
fn native_format_paragraph_clears_selected_marks_and_level_but_keeps_links() {
    let mut doc = source();
    let attrs = ["bold", "italic", "strike", "entityLink", "futureMark"]
        .into_iter()
        .map(|key| (key.into(), Any::Map(Default::default())))
        .collect::<Attrs>();
    mark(&doc, "p", 0, 5, attrs);
    format(&mut doc, NativeFormatAction::Heading1, 0, 0);
    let before = doc.semantic().unwrap();
    format(&mut doc, NativeFormatAction::Paragraph, 1, 2);
    let block = &doc.semantic().unwrap()["content"][0];
    assert_eq!(block["type"], "paragraph");
    assert!(block["attrs"].get("level").is_none());
    let runs = marks(&doc, "p");
    assert!(runs[0].1.contains_key("bold"));
    assert!(runs[2].1.contains_key("strike"));
    assert_eq!(runs[1].0, "🙂");
    assert_eq!(runs[1].1.len(), 2);
    assert!(runs[1].1.contains_key("entityLink"));
    assert!(runs[1].1.contains_key("futureMark"));
    assert!(doc.undo());
    assert_eq!(doc.semantic().unwrap(), before);
    assert!(doc.redo());
    let mut reopened = DocumentSession::new();
    reopened
        .apply_remote(&doc.update(None, 1).unwrap(), 1)
        .unwrap();
    assert_eq!(reopened.semantic().unwrap(), doc.semantic().unwrap());
}

#[test]
fn native_format_empty_caret_and_container_heading_preserve_parent_and_reject_unwrap() {
    let mut seed = DocumentSession::new();
    {
        let mut txn = seed.doc.transact_mut_with(REMOTE);
        let empty = seed
            .root
            .push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        empty.insert_attribute(&mut txn, "id", "empty");
        let quote = seed
            .root
            .push_back(&mut txn, XmlElementPrelim::empty("blockquote"));
        quote.insert_attribute(&mut txn, "id", "quote");
        quote.insert_attribute(&mut txn, "future", 42);
        let paragraph = quote.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        paragraph.insert_attribute(&mut txn, "id", "inside");
        paragraph.push_back(&mut txn, XmlTextPrelim::new("引文"));
    }
    let quote = seed.find_block(&seed.doc.transact(), "quote").unwrap();
    format(&mut seed, NativeFormatAction::Heading1, 0, 0);
    assert_eq!(seed.native_projection().unwrap().blocks[0].kind, "heading");
    format(&mut seed, NativeFormatAction::Heading2, 1, 0);
    assert_eq!(
        seed.find_block(&seed.doc.transact(), "quote").unwrap(),
        quote
    );
    assert_eq!(
        seed.semantic().unwrap()["content"][1]["content"][0]["type"],
        "heading"
    );
    let before = seed.update(None, 1).unwrap();
    assert!(seed
        .format_native(NativeFormatting {
            revision: seed.revision,
            range: NativeRange {
                location: 1,
                length: 0
            },
            action: NativeFormatAction::Paragraph
        })
        .unwrap_err()
        .contains("unwrap"));
    assert_eq!(seed.update(None, 1).unwrap(), before);
    assert!(seed.undo());
    assert!(seed.undo());
    assert_eq!(
        seed.native_projection().unwrap().blocks[0].kind,
        "paragraph"
    );
}

#[test]
fn native_format_invalid_ranges_or_later_shared_metadata_reject_before_any_mutation() {
    let mut doc = source();
    select(&mut doc, 1, 1, 2);
    doc.set_comment_anchors(vec![comment()]).unwrap();
    let log = doc.capture_authored_updates().unwrap();
    for (revision, at, length, action) in [
        (doc.revision + 1, 0, 1, NativeFormatAction::Bold),
        (doc.revision, 2, 1, NativeFormatAction::Italic),
        (doc.revision, 0, 0, NativeFormatAction::Bold),
        (doc.revision, 5, 1, NativeFormatAction::Italic),
    ] {
        let before = doc.update(None, 1).unwrap();
        assert!(doc
            .format_native(NativeFormatting {
                revision,
                range: NativeRange {
                    location: at,
                    length
                },
                action
            })
            .is_err());
        assert_eq!(doc.update(None, 1).unwrap(), before);
        assert!(log.is_empty());
        assert!(!doc.undo());
        assert_eq!(selection(&doc), (1, 2));
        assert_comment(&doc);
    }
    {
        let mut txn = doc.doc.transact_mut_with(REMOTE);
        doc.find_block(&txn, "q").unwrap().insert_attribute(
            &mut txn,
            "future",
            yrs::MapPrelim::default(),
        );
    }
    let before = doc.update(None, 1).unwrap();
    assert!(doc
        .format_native(NativeFormatting {
            revision: doc.revision,
            range: NativeRange {
                location: 0,
                length: 8
            },
            action: NativeFormatAction::Heading1
        })
        .unwrap_err()
        .contains("shared XML block"));
    assert_eq!(doc.update(None, 1).unwrap(), before);
    assert!(log.is_empty());
    assert!(!doc.undo());
}

#[test]
fn native_format_italic_event_replays_on_peer_and_preserves_remote_history() {
    let mut doc = source();
    let mut peer = DocumentSession::new();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let log = doc.capture_authored_updates().unwrap();
    format(&mut doc, NativeFormatAction::Italic, 1, 4);
    let events = log.drain_records();
    assert_eq!(events.len(), 1);
    assert!(events[0].deletion().is_none());
    peer.apply_remote(events[0].update(), 1).unwrap();
    assert_eq!(peer.semantic().unwrap(), doc.semantic().unwrap());
    let vector = peer.state_vector();
    peer.edit(Edit::Insert {
        block: "q".into(),
        offset: 2,
        text: "远".into(),
    })
    .unwrap();
    doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
        .unwrap();
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().text,
        "甲🙂e\u{301}\n海岸远"
    );
    assert!(marks(&doc, "p")
        .iter()
        .all(|(_, attrs)| !attrs.contains_key("italic")));
    assert!(doc.redo());
    assert!(marks(&doc, "p")[1].1.contains_key("italic"));
}
