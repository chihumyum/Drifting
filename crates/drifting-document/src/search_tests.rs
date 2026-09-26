use super::*;

fn document(text: &str) -> DocumentSession {
    let mut seed = DocumentSession::new();
    seed.edit(Edit::AppendParagraph {
        id: "p".into(),
        text: text.into(),
    })
    .unwrap();
    let mut doc = DocumentSession::new();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    doc
}

fn replace(doc: &mut DocumentSession, location: u32, length: u32, text: &str) {
    doc.replace_native(NativeReplacement {
        revision: doc.native_projection().unwrap().revision,
        range: NativeRange { location, length },
        text: text.into(),
    })
    .unwrap();
}

#[test]
fn native_search_maps_literal_lowercase_matches_to_original_utf16() {
    let doc = document("甲İ🙂 E\u{301} É Straße %_ [x]");
    for (query, expected, location, length) in [
        ("i", "İ", 1, 1),
        ("🙂", "🙂", 2, 2),
        ("e\u{301}", "E\u{301}", 5, 2),
        ("é", "É", 8, 1),
        ("straße", "Straße", 10, 6),
        ("%_", "%_", 17, 2),
        (" [X] ", "[x]", 20, 3),
    ] {
        let hits = doc.search_native(query, 100).unwrap();
        assert_eq!(hits.len(), 1, "{query}");
        assert_eq!(hits[0].matched.matched_text, expected);
        let range = doc.resolve_search_match(&hits[0].matched).unwrap().unwrap();
        assert_eq!((range.location, range.length), (location, length));
    }
    assert!(doc.search_native("ss", 100).unwrap().is_empty());
    assert!(doc.search_native("  ", 100).unwrap().is_empty());
    assert!(doc.search_native("甲", 0).unwrap().is_empty());
    assert_eq!(native_search_ranges("İİ", "i", 1).len(), 1);
}

#[test]
fn native_search_cold_anchors_relocate_and_reject_changed_original_text() {
    let mut live = document("甲目标🙂乙目标🙂");
    let mut cold = DocumentSession::new();
    cold.apply_remote(&live.update(None, 1).unwrap(), 1)
        .unwrap();
    let matched = cold.search_native("目标🙂", 1).unwrap().remove(0).matched;
    drop(cold);
    replace(&mut live, 0, 0, "前🙂");
    let range = live.resolve_search_match(&matched).unwrap().unwrap();
    assert_eq!((range.location, range.length), (4, 4));
    replace(&mut live, 4, 2, "改写");
    assert!(live.resolve_search_match(&matched).unwrap().is_none());
    assert_eq!(
        live.search_native("目标🙂", 10).unwrap().len(),
        1,
        "another equal occurrence must not become the stale result"
    );
}

#[test]
fn native_search_excludes_ambiguous_placeholder_and_cross_block_matches() {
    let mut doc = document("甲");
    doc.edit(Edit::AppendParagraph {
        id: "q".into(),
        text: "乙".into(),
    })
    .unwrap();
    {
        let mut txn = doc.doc.transact_mut_with(REMOTE);
        for _ in 0..2 {
            let block = doc
                .root
                .push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            block.insert_attribute(&mut txn, "id", "duplicate");
            block.push_back(&mut txn, XmlTextPrelim::new("隐藏"));
        }
        doc.root
            .push_back(&mut txn, XmlElementPrelim::empty("image"));
    }
    assert!(doc.search_native("甲\n乙", 100).unwrap().is_empty());
    assert!(doc.search_native("隐藏", 100).unwrap().is_empty());
    assert!(doc.search_native("\u{fffc}", 100).unwrap().is_empty());
    assert_eq!(doc.search_native("乙", 100).unwrap().len(), 1);
}

#[test]
fn native_search_and_resolution_leave_document_history_and_capture_unchanged() {
    let mut doc = document("原文🙂");
    replace(&mut doc, 0, 0, "新");
    doc.set_selection(NativeSelectionRequest {
        view_id: "editor".into(),
        epoch: 1,
        revision: doc.native_projection().unwrap().revision,
        range: NativeRange {
            location: 1,
            length: 2,
        },
    })
    .unwrap();
    let log = doc.capture_authored_updates().unwrap();
    let before = doc.update(None, 1).unwrap();
    let projection = serde_json::to_value(doc.native_projection().unwrap()).unwrap();
    let hits = doc.search_native("原文", 100).unwrap();
    assert!(doc
        .resolve_search_match(&hits[0].matched)
        .unwrap()
        .is_some());
    assert_eq!(doc.update(None, 1).unwrap(), before);
    assert_eq!(
        serde_json::to_value(doc.native_projection().unwrap()).unwrap(),
        projection
    );
    assert!(log.is_empty());
    assert!(doc.undo());
    assert_eq!(doc.native_projection().unwrap().text, "原文🙂");
}
