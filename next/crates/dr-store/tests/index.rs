//! Derived indexes: search (trigram FTS5, LIKE for one or two characters),
//! outline, paragraph lengths, references, counts.

mod common;

use common::*;
use dr_store::Library;
use dr_store::index::{BlockRow, DocIndex, RefKind, RefRow};
use loro::Frontiers;

fn block(id: &str, heading: u8, text: &str) -> BlockRow {
    BlockRow {
        block_id: Some(id.into()),
        heading,
        chars: text.chars().count() as u32,
        text: text.into(),
    }
}

fn link(block: &str, target: &str) -> RefRow {
    RefRow {
        source_block: Some(block.into()),
        target_kind: "element".into(),
        target_id: target.into(),
        kind: RefKind::Link,
        count: 1,
    }
}

fn index(lib: &Library, doc: &str, book: &str, blocks: &[BlockRow], refs: &[RefRow]) {
    lib.register(doc, "node", Some(book)).unwrap();
    let chars: u64 = blocks.iter().map(|b| b.chars as u64).sum();
    lib.index_doc(&DocIndex {
        doc_id: doc,
        book_id: Some(book),
        frontiers: &Frontiers::default(),
        words: chars,
        chars,
        blocks,
        references: refs,
    })
    .unwrap();
}

fn seeded(lib: &Library) {
    index(
        lib,
        "node:1",
        "book-a",
        &[
            block("b1", 1, "第一章 安娜"),
            block("b2", 0, "安娜说：「我们走吧。」窗外下着雨。"),
            block("b3", 2, "雨夜"),
            block("b4", 0, "Dear Anna, the 50% discount_code is \"spring\"."),
        ],
        &[link("b2", "el-anna"), link("b4", "el-anna")],
    );
    index(
        lib,
        "node:2",
        "book-b",
        &[
            block("c1", 0, "另一本书里的安娜。"),
            block("c2", 0, "安静。"),
        ],
        &[link("c1", "el-anna")],
    );
}

fn hits(lib: &Library, book: Option<&str>, q: &str) -> Vec<(String, u32)> {
    lib.search(book, q, 50)
        .unwrap()
        .into_iter()
        .map(|h| (h.doc_id, h.ord))
        .collect()
}

#[test]
fn one_and_two_character_chinese_queries_fall_back_to_like() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    seeded(&lib);
    // One character: LIKE.
    assert_eq!(
        hits(&lib, None, "安"),
        [
            ("node:1".into(), 0),
            ("node:1".into(), 1),
            ("node:2".into(), 0),
            ("node:2".into(), 1)
        ]
    );
    // Two characters: LIKE.
    assert_eq!(
        hits(&lib, None, "安娜"),
        [
            ("node:1".into(), 0),
            ("node:1".into(), 1),
            ("node:2".into(), 0)
        ]
    );
    assert_eq!(
        hits(&lib, Some("book-a"), "雨"),
        [("node:1".into(), 1), ("node:1".into(), 2)]
    );
    // Three or more: the trigram index.
    assert_eq!(hits(&lib, None, "我们走"), [("node:1".into(), 1)]);
    assert_eq!(hits(&lib, Some("book-b"), "我们走"), []);
    let h = &lib.search(None, "窗外下", 5).unwrap()[0];
    assert_eq!(h.block_id.as_deref(), Some("b2"));
    assert_eq!(h.match_offset, 11);
    assert!(h.snippet.contains("窗外下着雨"));
}

#[test]
fn queries_are_literal_and_case_insensitive() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    seeded(&lib);
    assert_eq!(hits(&lib, None, "anna"), [("node:1".into(), 3)]);
    assert_eq!(hits(&lib, None, "DEAR"), [("node:1".into(), 3)]);
    assert_eq!(hits(&lib, None, "50%"), [("node:1".into(), 3)]);
    assert_eq!(
        hits(&lib, None, "%"),
        [("node:1".into(), 3)],
        "LIKE wildcards are escaped"
    );
    assert_eq!(hits(&lib, None, "_"), [("node:1".into(), 3)]);
    assert_eq!(
        hits(&lib, None, "\"spring\""),
        [("node:1".into(), 3)],
        "FTS syntax is quoted"
    );
    assert_eq!(hits(&lib, None, "OR"), [], "an FTS operator is just text");
    assert_eq!(hits(&lib, None, "   "), []);
    assert_eq!(lib.search(None, "安", 2).unwrap().len(), 2, "limit");
}

#[test]
fn reindexing_replaces_and_removal_clears() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    seeded(&lib);
    index(
        &lib,
        "node:1",
        "book-a",
        &[block("b9", 0, "全部改写了")],
        &[],
    );
    assert_eq!(hits(&lib, None, "我们走"), []);
    assert_eq!(hits(&lib, None, "改写"), [("node:1".into(), 0)]);
    assert_eq!(hits(&lib, None, "全部改写"), [("node:1".into(), 0)]);
    assert!(lib.references_from("node:1").unwrap().is_empty());
    lib.remove_doc_index("node:2").unwrap();
    assert_eq!(hits(&lib, None, "安"), []);
    assert!(lib.doc_stats("node:2").unwrap().is_none());
}

#[test]
fn outline_lengths_references_and_counts() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    seeded(&lib);
    let outline = lib.outline("node:1").unwrap();
    assert_eq!(
        outline
            .iter()
            .map(|e| (e.ord, e.heading, e.text.as_str()))
            .collect::<Vec<_>>(),
        [(0, 1, "第一章 安娜"), (2, 2, "雨夜")]
    );
    assert_eq!(lib.block_lengths("node:1").unwrap(), [6, 17, 2, 45]);
    let to = lib.references_to("el-anna").unwrap();
    assert_eq!(
        to.iter()
            .map(|r| (r.source_doc.as_str(), r.source_block.as_deref()))
            .collect::<Vec<_>>(),
        [
            ("node:1", Some("b2")),
            ("node:1", Some("b4")),
            ("node:2", Some("c1"))
        ]
    );
    assert_eq!(lib.references_from("node:2").unwrap().len(), 1);
    let stats = lib.doc_stats("node:1").unwrap().unwrap();
    assert_eq!((stats.paragraphs, stats.chars), (4, 70));
    let book = lib.book_stats("book-a").unwrap();
    assert_eq!((book.docs, book.chars, book.paragraphs), (1, 70, 4));
}

#[test]
fn search_stays_fast_enough_on_a_large_book() {
    use dr_store::synthetic::{Rng, chapter};
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let mut rng = Rng::new(3);
    for c in 0..20 {
        let text = chapter(&mut rng, 20_000);
        let blocks: Vec<BlockRow> = text
            .lines()
            .enumerate()
            .map(|(i, l)| block(&format!("{c}-{i}"), 0, l))
            .collect();
        index(&lib, &format!("node:{c}"), "book-a", &blocks, &[]);
    }
    let t = std::time::Instant::now();
    let one = lib.search(Some("book-a"), "春", 100).unwrap();
    let three = lib.search(Some("book-a"), "春夏秋", 100).unwrap();
    assert_eq!(one.len(), 100);
    assert!(three.len() <= 100);
    // 400 000 characters: generous so debug CI builds pass.
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
}
