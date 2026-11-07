//! The Rust rule against the 0.1 client's TypeScript rule: every expected
//! count in `fixtures/count-words.json` was computed by
//! `packages/prose-metrics/src/index.ts` itself (`fixtures/generate.mts`).

use prose_metrics::count_words;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/count-words.json")).expect("fixture JSON")
}

#[test]
fn every_case_matches_the_typescript_count() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() > 1500, "the fixture lost its generated cases");
    let mut failures = Vec::new();
    for case in cases {
        let text = case["text"].as_str().expect("text");
        let want = case["words"].as_u64().expect("words");
        let got = count_words(text);
        if got != want {
            failures.push(format!("{text:?}: TypeScript {want}, Rust {got}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// The one deliberate difference: 0.1 counted ProseMirror JSON with a space
/// after every child node, so a Latin word split by a mark counted twice. The
/// new client counts the real text of each paragraph.
#[test]
fn split_words_count_once_unlike_the_old_projection() {
    let fixture = fixture();
    let docs = fixture["pmDocuments"].as_array().expect("pmDocuments");
    let mut differ = 0;
    for doc in docs {
        let name = doc["name"].as_str().expect("name");
        let old = doc["old"].as_u64().expect("old");
        let extracted = doc["oldExtracted"].as_str().expect("oldExtracted");
        // The old count is the rule applied to the old extraction.
        assert_eq!(count_words(extracted), old, "{name}");
        let new: u64 = doc["paragraphs"]
            .as_array()
            .expect("paragraphs")
            .iter()
            .map(|p| count_words(p.as_str().expect("paragraph")))
            .sum();
        match name {
            "a bold split Latin word counted twice by 0.1" => {
                assert_eq!((old, new), (3, 2), "{name}");
                differ += 1;
            }
            "a linked name inside a Latin word" => {
                assert_eq!((old, new), (4, 2), "{name}");
                differ += 1;
            }
            _ => assert_eq!(old, new, "{name}"),
        }
    }
    assert_eq!(differ, 2);
}
