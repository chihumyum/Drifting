use super::*;

/// Builds `[heading, paragraph, paragraph]` with the marks the tests read.
fn document() -> DocumentSession {
    let session = DocumentSession::with_test_client_id(52001).unwrap();
    {
        let mut txn = session.doc.transact_mut();
        let blocks = [
            (
                "heading",
                vec![("id", Any::from("h1")), ("level", Any::from(1.0))],
                "  第一章 Start  ",
            ),
            (
                "paragraph",
                vec![("id", Any::from("p1"))],
                "他说 hello, world！ab",
            ),
            (
                "paragraph",
                vec![("id", Any::from("p2")), ("textAlign", Any::from("center"))],
                "cd ef",
            ),
        ];
        for (index, (name, attrs, text)) in blocks.into_iter().enumerate() {
            let block = session
                .root
                .insert(&mut txn, index as u32, XmlElementPrelim::empty(name));
            for (key, value) in attrs {
                block.insert_attribute(&mut txn, key, value);
            }
            let body = block.insert(&mut txn, 0, XmlTextPrelim::new(text));
            if index == 1 {
                let units = |s: &str| s.encode_utf16().count() as u32;
                let at = units("他说 hello, world！");
                body.format(
                    &mut txn,
                    at,
                    2,
                    Attrs::from([("bold".into(), Any::Map(Default::default()))]),
                );
                body.format(
                    &mut txn,
                    at + 1,
                    1,
                    Attrs::from([("italic".into(), Any::Map(Default::default()))]),
                );
            }
            if index == 2 {
                body.format(
                    &mut txn,
                    0,
                    2,
                    Attrs::from([("italic".into(), Any::Map(Default::default()))]),
                );
                body.format(
                    &mut txn,
                    1,
                    1,
                    Attrs::from([("bold".into(), Any::Map(Default::default()))]),
                );
                // Two marks opening together follow the schema's mark rank.
                body.format(
                    &mut txn,
                    3,
                    2,
                    Attrs::from([
                        ("bold".into(), Any::Map(Default::default())),
                        (
                            "entityLink--kDRvc5Je".into(),
                            Any::from_json(r#"{"id":"e1","kind":"element"}"#).unwrap(),
                        ),
                        (
                            "link".into(),
                            Any::from_json(r#"{"href":"https://example.invalid"}"#).unwrap(),
                        ),
                    ]),
                );
            }
        }
    }
    session
}

#[test]
fn prose_word_count_matches_prose_metrics() {
    for (text, count) in [
        ("", 0),
        (" \u{3000}\u{feff} ", 0),
        ("hello world", 2),
        ("你好，世界", 4),
        ("hello世界 foo", 4),
        ("3.14 abc", 2),
        ("— – … !!", 0),
        ("１２３ ＡＢ", 0),
        ("can't stop\u{a0}now", 3),
        ("𠀀 x", 1),
    ] {
        assert_eq!(count_words(text), count, "{text:?}");
    }
}

#[test]
fn prose_projection_follows_y_prosemirror_and_prose_metrics() {
    let empty = DocumentSession::with_test_client_id(52002)
        .unwrap()
        .prose_projection()
        .unwrap();
    assert_eq!(empty.content_json, r#"{"type":"doc","content":[]}"#);
    assert_eq!((empty.word_count, empty.outline_json.as_str()), (0, "[]"));
    // sha256 of {"content":[],"type":"doc"}, as deriveProseMetric computes.
    assert_eq!(
        empty.basis_hash,
        "sha256:d220121877b265dcfe2d77fc13d31575a60fa3a663129c23d978f706979d5477"
    );
    let projection = document().prose_projection().unwrap();
    assert_eq!(
        projection.content_json,
        concat!(
            r#"{"type":"doc","content":["#,
            r#"{"type":"heading","attrs":{"id":"h1","level":1},"content":[{"type":"text","text":"  第一章 Start  "}]},"#,
            r#"{"type":"paragraph","attrs":{"id":"p1"},"content":[{"type":"text","text":"他说 hello, world！"},"#,
            r#"{"type":"text","text":"a","marks":[{"type":"bold","attrs":{}}]},"#,
            r#"{"type":"text","text":"b","marks":[{"type":"bold","attrs":{}},{"type":"italic","attrs":{}}]}]},"#,
            r#"{"type":"paragraph","attrs":{"id":"p2","textAlign":"center"},"content":["#,
            r#"{"type":"text","text":"c","marks":[{"type":"italic","attrs":{}}]},"#,
            r#"{"type":"text","text":"d","marks":[{"type":"italic","attrs":{}},{"type":"bold","attrs":{}}]},"#,
            r#"{"type":"text","text":" "},"#,
            r#"{"type":"text","text":"ef","marks":[{"type":"link","attrs":{"href":"https://example.invalid"}},{"type":"bold","attrs":{}},{"type":"entityLink","attrs":{"id":"e1","kind":"element"}}]}]}]}"#,
        )
    );
    assert_eq!(
        projection.outline_json,
        r#"[{"id":"h1","level":1,"text":"第一章 Start","position":0,"paragraphsAfter":2}]"#
    );
    // Computed by @drifting/prose-metrics over the same JSON.
    assert_eq!(
        (projection.word_count, projection.basis_hash.as_str()),
        (
            13,
            "sha256:99323af1384708a12786da7f2ded5e3db04159f7beb5ffd4a0be50c459225d57"
        )
    );
}

#[test]
fn prose_projection_handles_large_numbers_and_non_ascii_format_keys() {
    let session = DocumentSession::with_test_client_id(52003).unwrap();
    {
        let mut txn = session.doc.transact_mut();
        let block = session
            .root
            .insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        block.insert_attribute(&mut txn, "indent", Any::from(1e21));
        let body = block.insert(&mut txn, 0, XmlTextPrelim::new("xy"));
        body.format(
            &mut txn,
            0,
            1,
            Attrs::from([("é123456789".into(), Any::Map(Default::default()))]),
        );
    }
    let projection = session.prose_projection().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&projection.content_json).unwrap();
    assert_eq!(parsed["content"][0]["attrs"]["indent"], 1e21);
    assert!(projection.content_json.contains(r#""indent":1e+21"#));
    assert_eq!(
        parsed["content"][0]["content"][0]["marks"][0]["type"],
        "é123456789"
    );
}
