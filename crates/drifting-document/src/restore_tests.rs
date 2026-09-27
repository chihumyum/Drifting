use super::*;

#[test]
fn replace_with_state_restores_blocks_marks_and_undoes() {
    let mut doc = DocumentSession::with_test_client_id(53001).unwrap();
    doc.edit(Edit::AppendParagraph {
        id: "p1".into(),
        text: "雨夜钟声".into(),
    })
    .unwrap();
    doc.edit(Edit::AppendParagraph {
        id: "p2".into(),
        text: "她推开门".into(),
    })
    .unwrap();
    doc.edit(Edit::Format {
        block: "p1".into(),
        offset: 0,
        length: 2,
        attributes: serde_json::from_str(r#"{"bold":{}}"#).unwrap(),
    })
    .unwrap();
    let past = doc.update(None, 1).unwrap();
    let before = doc.prose_projection().unwrap();
    doc.edit(Edit::Insert {
        block: "p2".into(),
        offset: 0,
        text: "后来，".into(),
    })
    .unwrap();
    doc.edit(Edit::AppendParagraph {
        id: "p3".into(),
        text: "第三段".into(),
    })
    .unwrap();
    doc.replace_with_state(&past).unwrap();
    let restored = doc.prose_projection().unwrap();
    assert_eq!(
        restored.content_json, before.content_json,
        "blocks, ids and marks come back"
    );
    assert_eq!(restored.basis_hash, before.basis_hash);
    // One undo returns to the edited text.
    assert!(doc.undo());
    assert_eq!(
        doc.native_projection().unwrap().text,
        "雨夜钟声\n后来，她推开门\n第三段"
    );
    assert!(doc.redo());
    assert_eq!(doc.native_projection().unwrap().text, "雨夜钟声\n她推开门");
    assert!(doc.replace_with_state(b"not an update").is_err());
    let empty = DocumentSession::with_test_client_id(53002)
        .unwrap()
        .update(None, 1)
        .unwrap();
    assert!(
        doc.replace_with_state(&empty).is_err(),
        "a version without blocks is refused"
    );
}
