//! Derived indexes: search (trigram FTS5, LIKE for one or two characters),
//! outline, paragraph lengths, references, counts.

mod common;

use common::*;
use dr_store::Library;
use dr_store::index::{BlockRow, Derived, DocIndex, RefKind, RefRow};
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

static SEQ: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);

fn index(lib: &Library, doc: &str, book: &str, blocks: &[BlockRow], refs: &[RefRow]) {
    lib.register(doc, "node", Some(book)).unwrap();
    let chars: u64 = blocks.iter().map(|b| b.chars as u64).sum();
    let derived = Derived {
        words: chars,
        chars,
        blocks: blocks.to_vec(),
        references: refs.to_vec(),
    };
    assert!(
        lib.index_doc(&DocIndex {
            doc_id: doc,
            book_id: Some(book),
            seq: SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            frontiers: &Frontiers::default(),
            derived: &derived,
        })
        .unwrap()
    );
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
    use common::synthetic::{Rng, chapter};
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let mut rng = Rng::new(3);
    let mut probe = String::new();
    for c in 0..20 {
        let text = chapter(&mut rng, 20_000);
        if probe.is_empty() {
            // Search for what the corpus has: its first three characters.
            probe = text.chars().take(3).collect();
        }
        let blocks: Vec<BlockRow> = text
            .lines()
            .enumerate()
            .map(|(i, l)| block(&format!("{c}-{i}"), 0, l))
            .collect();
        index(&lib, &format!("node:{c}"), "book-a", &blocks, &[]);
    }
    let t = std::time::Instant::now();
    let first: String = probe.chars().take(1).collect();
    let one = lib.search(Some("book-a"), &first, 100).unwrap();
    let three = lib.search(Some("book-a"), &probe, 100).unwrap();
    assert_eq!(one.len(), 100);
    assert!(!three.is_empty() && three.len() <= 100);
    // 400 000 characters: generous so debug CI builds pass.
    assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
}

#[test]
fn an_index_never_moves_backwards_and_no_triggers_exist() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:x", "node", None).unwrap();
    let write = |seq: i64, text: &str| {
        lib.index_doc(&DocIndex {
            doc_id: "node:x",
            book_id: None,
            seq,
            frontiers: &Frontiers::default(),
            derived: &Derived {
                words: 1,
                chars: 1,
                blocks: vec![block("b", 0, text)],
                references: vec![],
            },
        })
        .unwrap()
    };
    assert!(write(5, "新的版本"));
    assert!(!write(4, "旧的版本"), "an older derivation is ignored");
    assert!(!write(5, "同一版本"));
    assert_eq!(hits(&lib, None, "新的版"), [("node:x".into(), 0)]);
    assert_eq!(hits(&lib, None, "旧的版"), []);
    assert_eq!(lib.doc_stats("node:x").unwrap().unwrap().indexed_seq, 5);
    let conn = rusqlite::Connection::open(dir.path().join("library.sqlite")).unwrap();
    let triggers: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'trigger'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(triggers, 0, "no SQL triggers on Loro or derived tables");
}

// ---------------------------------------------------------------------------
// Paragraph patches.

use dr_corpus::rng::Rng;
use dr_store::StoreError;
use dr_store::index::{DerivedPatch, DocPatch, Splice};

/// Every stored paragraph row, in order, and the FTS index checked against
/// them.
fn stored(lib: &Library, doc: &str) -> Vec<(i64, Option<String>, i64, i64, String)> {
    lib.local_transaction(|tx| {
        // FTS5 compares its index with the content table.
        tx.execute(
            "INSERT INTO block_fts (block_fts, rank) VALUES ('integrity-check', 1)",
            [],
        )?;
        Ok(())
    })
    .expect("the full-text index matches its rows");
    lib.local_read(|c| {
        let rows = c
            // Keys are sort keys with gaps: compare positions.
            .prepare(
                "SELECT row_number() OVER (ORDER BY ord) - 1, block_id, heading, chars, text
                 FROM block_index WHERE doc_id = ?1 ORDER BY ord",
            )?
            .query_map([doc], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .unwrap()
}

fn rows_of(d: &Derived) -> Vec<(i64, Option<String>, i64, i64, String)> {
    d.blocks
        .iter()
        .enumerate()
        .map(|(i, b)| {
            (
                i as i64,
                b.block_id.clone(),
                b.heading as i64,
                b.chars as i64,
                b.text.clone(),
            )
        })
        .collect()
}

fn derived(blocks: Vec<BlockRow>, refs: Vec<RefRow>) -> Derived {
    let chars = blocks.iter().map(|b| b.chars as u64).sum();
    Derived {
        words: chars,
        chars,
        blocks,
        references: refs,
    }
}

fn full(lib: &Library, doc: &str, seq: i64, d: &Derived) {
    assert!(
        lib.index_doc(&DocIndex {
            doc_id: doc,
            book_id: Some("book-p"),
            seq,
            frontiers: &Frontiers::default(),
            derived: d,
        })
        .unwrap()
    );
}

fn patch(lib: &Library, doc: &str, seq: i64, p: &DerivedPatch) -> dr_store::Result<bool> {
    lib.patch_index(&DocPatch {
        doc_id: doc,
        book_id: Some("book-p"),
        seq,
        frontiers: &Frontiers::default(),
        patch: p,
    })
}

fn para(rng: &mut Rng, n: u64) -> BlockRow {
    let pool = ["春风", "安娜", "窗外", "下着雨", "我们走吧", "rain", "Anna"];
    let text: String = (0..rng.range(1, 6)).map(|_| *rng.pick(&pool)).collect();
    block(
        &format!("b{n}"),
        (rng.below(5) == 0) as u8 * rng.range(1, 3) as u8,
        &text,
    )
}

#[test]
fn random_patches_leave_exactly_what_a_full_rewrite_would() {
    random_patches(0xF2_0003, false);
}

/// The same with the keys often packed one by one (as libraries written
/// before the gaps are), so inserts keep finding no room and renumber, and
/// with patches cut into several touching splices.
#[test]
fn random_patches_on_packed_keys_and_touching_splices() {
    random_patches(0xF2_0004, true);
}

/// Give a document's rows the keys 0, 1, 2, … in their order.
fn pack_keys(lib: &Library, doc: &str) {
    let ids: Vec<i64> = keys(lib, doc).into_iter().map(|k| k.0).collect();
    lib.local_transaction(|tx| {
        tx.execute(
            "UPDATE block_index SET ord = ord + (1 << 61) WHERE doc_id = ?1",
            [doc],
        )?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE block_index SET ord = ?2 WHERE id = ?1",
                rusqlite::params![id, i as i64],
            )?;
        }
        Ok(())
    })
    .unwrap();
}

/// Cut a one-splice patch into two touching splices (positions and the
/// result unchanged).
fn cut(p: &mut DerivedPatch, rng: &mut Rng) {
    if p.splices.len() != 1 {
        return;
    }
    let s = p.splices.remove(0);
    let r = rng.range(0, s.removed as usize) as u32;
    let k = rng.range(0, s.blocks.len());
    p.splices.push(Splice {
        at: s.at,
        removed: r,
        blocks: s.blocks[..k].to_vec(),
    });
    p.splices.push(Splice {
        at: s.at + r,
        removed: s.removed - r,
        blocks: s.blocks[k..].to_vec(),
    });
}

fn random_patches(seed: u64, packed: bool) {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:p", "node", Some("book-p")).unwrap();
    let mut rng = Rng::new(seed);
    let mut next = 0u64;
    let mut current: Vec<BlockRow> = (0..40)
        .map(|_| {
            next += 1;
            para(&mut rng, next)
        })
        .collect();
    let mut prev = derived(current.clone(), vec![link("b1", "el-anna")]);
    full(&lib, "node:p", 1, &prev);
    for seq in 2..400 {
        // A keystroke, an Enter, a merge, a deletion, a paste, or a move.
        let len = current.len();
        match rng.below(6) {
            0 if len > 0 => {
                let i = rng.below(len as u64) as usize;
                current[i].text.push('字');
                current[i].chars += 1;
            }
            1 => {
                next += 1;
                let at = rng.below(len as u64 + 1) as usize;
                current.insert(at, para(&mut rng, next));
            }
            2 if len > 1 => {
                let i = rng.below(len as u64 - 1) as usize;
                let b = current.remove(i + 1);
                current[i].text.push_str(&b.text);
                current[i].chars += b.chars;
            }
            3 if len > 3 => {
                let i = rng.below(len as u64 - 2) as usize;
                current.drain(i..i + rng.range(1, 2));
            }
            4 => {
                let at = rng.below(len as u64 + 1) as usize;
                let paste: Vec<BlockRow> = (0..rng.range(1, 8))
                    .map(|_| {
                        next += 1;
                        para(&mut rng, next)
                    })
                    .collect();
                current.splice(at..at, paste);
            }
            _ if len > 2 => {
                let b = current.remove(0);
                current.push(b);
            }
            _ => {}
        }
        let refs = if rng.below(10) == 0 {
            vec![link(
                &format!("b{}", rng.range(1, next as usize)),
                "el-anna",
            )]
        } else {
            prev.references.clone()
        };
        let now = derived(current.clone(), refs);
        let mut p = DerivedPatch::between(&prev, &now);
        if packed {
            if rng.below(3) == 0 {
                pack_keys(&lib, "node:p");
            }
            if rng.below(2) == 0 {
                cut(&mut p, &mut rng);
            }
        }
        assert_eq!(p.apply_to(&prev).unwrap(), now, "the patch is the change");
        assert!(patch(&lib, "node:p", seq, &p).unwrap());
        assert_eq!(stored(&lib, "node:p"), rows_of(&now), "seq {seq}");
        assert_eq!(
            lib.doc_stats("node:p").unwrap().unwrap().paragraphs,
            now.blocks.len() as u64
        );
        assert_eq!(
            lib.references_from("node:p").unwrap().len(),
            now.references.len()
        );
        prev = now;
    }
    // Search sees exactly the stored text.
    let want = prev
        .blocks
        .iter()
        .filter(|b| b.text.contains("下着雨"))
        .count();
    assert_eq!(lib.search(None, "下着雨", 1000).unwrap().len(), want);
}

#[test]
fn several_splices_move_the_paragraphs_between_them() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:s", "node", None).unwrap();
    let base: Vec<BlockRow> = (0..10)
        .map(|i| block(&format!("b{i}"), 0, &format!("第{i}段")))
        .collect();
    let old = derived(base.clone(), vec![]);
    full(&lib, "node:s", 1, &old);
    // Grow at 1, shrink at 4..7, grow at the end: the middle moves both ways.
    let p = DerivedPatch {
        base_paragraphs: 10,
        splices: vec![
            Splice {
                at: 1,
                removed: 0,
                blocks: vec![block("n1", 0, "新一"), block("n2", 0, "新二")],
            },
            Splice {
                at: 4,
                removed: 3,
                blocks: vec![],
            },
            Splice {
                at: 10,
                removed: 0,
                blocks: vec![block("n3", 1, "新三")],
            },
        ],
        references: None,
        words: 0,
        chars: 0,
    };
    let want = p.apply_to(&old).unwrap();
    assert!(patch(&lib, "node:s", 2, &p).unwrap());
    assert_eq!(stored(&lib, "node:s"), rows_of(&want));
    assert_eq!(
        stored(&lib, "node:s")
            .iter()
            .map(|r| r.4.as_str())
            .collect::<Vec<_>>(),
        [
            "第0段", "新一", "新二", "第1段", "第2段", "第3段", "第7段", "第8段", "第9段", "新三"
        ]
    );
}

#[test]
fn a_patch_only_lands_on_the_rows_it_was_made_from() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:m", "node", None).unwrap();
    let one = derived(vec![block("a", 0, "一")], vec![]);
    let two = derived(vec![block("a", 0, "一"), block("b", 0, "二")], vec![]);
    let p = DerivedPatch::between(&one, &two);
    // No index yet: the first one must be full.
    assert!(matches!(
        patch(&lib, "node:m", 2, &p),
        Err(StoreError::IndexBase { .. })
    ));
    full(&lib, "node:m", 1, &two);
    // Made from one paragraph, but two are stored.
    assert!(matches!(
        patch(&lib, "node:m", 2, &p),
        Err(StoreError::IndexBase { .. })
    ));
    assert_eq!(stored(&lib, "node:m"), rows_of(&two), "nothing changed");
    // Older than what is stored: ignored.
    let back = DerivedPatch::between(&two, &one);
    assert!(!patch(&lib, "node:m", 1, &back).unwrap());
    // Out of range or overlapping splices are refused.
    let bad = DerivedPatch {
        base_paragraphs: 2,
        splices: vec![
            Splice {
                at: 1,
                removed: 1,
                blocks: vec![],
            },
            Splice {
                at: 0,
                removed: 1,
                blocks: vec![],
            },
        ],
        ..DerivedPatch::default()
    };
    assert!(patch(&lib, "node:m", 3, &bad).is_err());
    let unchanged = DerivedPatch::between(&two, &two);
    assert!(unchanged.splices.is_empty() && unchanged.references.is_none());
}

/// Ad hoc: what a patch saves (cargo test --release -p dr-store --test index
/// -- --ignored --nocapture). Not a gate; f8's bench is the measurement.
#[test]
#[ignore]
fn measure_patch_against_full_rewrite() {
    use dr_corpus::text;
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:big", "node", None).unwrap();
    let mut rng = Rng::new(7);
    let paras = text::body(&mut rng, 20_000, text::BodyShape::default());
    let blocks: Vec<BlockRow> = text::plain(&paras)
        .lines()
        .enumerate()
        .map(|(i, l)| block(&format!("b{i}"), 0, l))
        .collect();
    let mut prev = derived(blocks, vec![]);
    full(&lib, "node:big", 1, &prev);
    let (mut full_ms, mut patch_ms) = (Vec::new(), Vec::new());
    for seq in 2..42i64 {
        let mut now = prev.clone();
        let i = (seq as usize * 7) % now.blocks.len();
        now.blocks[i].text.push('字');
        let t = std::time::Instant::now();
        if seq % 2 == 0 {
            full(&lib, "node:big", seq, &now);
            full_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        } else {
            assert!(patch(&lib, "node:big", seq, &DerivedPatch::between(&prev, &now)).unwrap());
            patch_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        prev = now;
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    eprintln!(
        "{} paragraphs: full rewrite p50 {:.3} ms, one-paragraph patch p50 {:.3} ms",
        prev.blocks.len(),
        med(&mut full_ms),
        med(&mut patch_ms)
    );
}

#[test]
fn search_follows_a_given_document_order_before_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    for (doc, text) in [
        ("node:a", "雨夜甲"),
        ("node:b", "雨夜乙"),
        ("node:c", "雨夜丙"),
    ] {
        index(&lib, doc, "book-o", &[block("x", 0, text)], &[]);
    }
    let docs = |hits: Vec<dr_store::index::SearchHit>| -> Vec<String> {
        hits.into_iter().map(|h| h.doc_id).collect()
    };
    // Book order c, a; b is not listed and comes last.
    assert_eq!(
        docs(
            lib.search_in_order(Some("book-o"), "雨夜", 10, &["node:c", "node:a"])
                .unwrap()
        ),
        ["node:c", "node:a", "node:b"]
    );
    assert_eq!(
        docs(
            lib.search_in_order(Some("book-o"), "雨夜", 2, &["node:c", "node:a"])
                .unwrap()
        ),
        ["node:c", "node:a"],
        "the limit cuts in book order"
    );
    // Three characters go through FTS5: same order.
    assert_eq!(
        docs(
            lib.search_in_order(None, "雨夜乙", 10, &["node:b"])
                .unwrap()
        ),
        ["node:b"]
    );
    assert_eq!(
        docs(lib.search(Some("book-o"), "雨夜", 1).unwrap()),
        ["node:a"]
    );
}

#[test]
fn the_outline_trims_headings_and_leaves_out_empty_ones() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    index(
        &lib,
        "node:t",
        "book-t",
        &[
            block("h1", 1, "  第一章\u{3000}"),
            block("p", 0, "正文"),
            block("h2", 2, " \u{FEFF}\u{A0} "),
            block("h3", 3, "\t尾声\n"),
        ],
        &[],
    );
    let outline = lib.outline("node:t").unwrap();
    assert_eq!(
        outline
            .iter()
            .map(|e| (e.ord, e.text.as_str()))
            .collect::<Vec<_>>(),
        [(0, "第一章"), (3, "尾声")]
    );
}

#[test]
fn js_whitespace_matches_prose_metrics() {
    for c in (0..=0x10FFFFu32).filter_map(char::from_u32) {
        assert_eq!(
            dr_store::index::is_js_whitespace(c),
            prose_metrics::is_js_whitespace(c),
            "U+{:04X}",
            c as u32
        );
    }
}

/// (row id, key) of a document's rows, in order.
fn keys(lib: &Library, doc: &str) -> Vec<(i64, i64)> {
    lib.local_read(|c| {
        Ok(
            c.prepare("SELECT id, ord FROM block_index WHERE doc_id = ?1 ORDER BY ord")?
                .query_map([doc], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        )
    })
    .unwrap()
}

fn insert_at(at: u32, base: u32, b: BlockRow) -> DerivedPatch {
    DerivedPatch {
        base_paragraphs: base,
        splices: vec![Splice {
            at,
            removed: 0,
            blocks: vec![b],
        }],
        references: None,
        words: 0,
        chars: 0,
    }
}

/// Splitting a paragraph in the middle of a long document writes the two
/// new rows and touches no other (the order is kept by gaps between keys);
/// positions in search and outline still count paragraphs.
#[test]
fn a_new_paragraph_writes_its_own_rows_and_no_others() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:k", "node", Some("book-p")).unwrap();
    let blocks: Vec<BlockRow> = (0..200)
        .map(|i| block(&format!("b{i}"), 0, &format!("第{i}段")))
        .collect();
    let old = derived(blocks, vec![]);
    full(&lib, "node:k", 1, &old);
    let before = keys(&lib, "node:k");
    let split = DerivedPatch {
        base_paragraphs: 200,
        splices: vec![Splice {
            at: 100,
            removed: 1,
            blocks: vec![block("b100", 2, "前半"), block("n", 0, "后半独有")],
        }],
        references: None,
        words: 0,
        chars: 0,
    };
    assert!(patch(&lib, "node:k", 2, &split).unwrap());
    let after = keys(&lib, "node:k");
    assert_eq!(after.len(), 201);
    assert_eq!(after[..100], before[..100], "rows before are untouched");
    assert_eq!(after[102..], before[101..], "rows after are untouched");
    assert!(after[100].1 > before[99].1 && after[101].1 < before[101].1);
    assert_eq!(
        stored(&lib, "node:k"),
        rows_of(&split.apply_to(&old).unwrap())
    );
    assert_eq!(
        hits(&lib, Some("book-p"), "后半独有"),
        [("node:k".into(), 101)]
    );
    assert_eq!(
        hits(&lib, Some("book-p"), "第150段"),
        [("node:k".into(), 151)]
    );
    let outline = lib.outline("node:k").unwrap();
    assert_eq!((outline[0].ord, outline[0].text.as_str()), (100, "前半"));
}

/// Inserting again and again at one place halves the gap each time; the
/// document is renumbered only when it runs out, and reads the same.
#[test]
fn inserting_in_one_place_renumbers_only_when_the_gap_runs_out() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:g", "node", Some("book-p")).unwrap();
    let mut now = derived(
        vec![
            block("a", 0, "甲"),
            block("b", 0, "乙"),
            block("c", 0, "丙"),
        ],
        vec![],
    );
    full(&lib, "node:g", 1, &now);
    let mut renumbered = 0;
    for i in 0..80u32 {
        let before = keys(&lib, "node:g");
        let p = insert_at(
            1,
            now.blocks.len() as u32,
            block(&format!("n{i}"), 0, &format!("新{i}")),
        );
        assert!(patch(&lib, "node:g", 2 + i as i64, &p).unwrap());
        now = p.apply_to(&now).unwrap();
        let after = keys(&lib, "node:g");
        assert_eq!(stored(&lib, "node:g"), rows_of(&now), "insert {i}");
        let moved = before
            .iter()
            .filter(|(id, k)| after.iter().any(|(id2, k2)| id2 == id && k2 != k))
            .count();
        if moved > 0 {
            renumbered += 1;
            let spaced: Vec<i64> = (0..after.len() as i64).map(|j| j << 32).collect();
            assert_eq!(after.iter().map(|k| k.1).collect::<Vec<_>>(), spaced);
        } else {
            assert_eq!(after.len(), before.len() + 1);
        }
    }
    // 2^32 between two keys halves 32 times before there is no room.
    assert_eq!(renumbered, 2);
    assert_eq!(hits(&lib, Some("book-p"), "丙"), [("node:g".into(), 82)]);
}

/// Libraries written before the gaps numbered paragraphs 0, 1, 2, …: they
/// read the same, an append still fits, and the first insert with no room
/// renumbers the document.
#[test]
fn a_document_numbered_one_by_one_reads_the_same_and_renumbers_when_needed() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.register("node:o", "node", Some("book-p")).unwrap();
    let mut now = derived(
        (0..5)
            .map(|i| block(&format!("b{i}"), (i == 3) as u8, &format!("旧{i}")))
            .collect(),
        vec![],
    );
    full(&lib, "node:o", 1, &now);
    lib.local_transaction(|tx| {
        tx.execute(
            "UPDATE block_index SET ord = ord >> 32 WHERE doc_id = 'node:o'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        keys(&lib, "node:o").iter().map(|k| k.1).collect::<Vec<_>>(),
        [0, 1, 2, 3, 4]
    );
    assert_eq!(hits(&lib, Some("book-p"), "旧4"), [("node:o".into(), 4)]);
    assert_eq!(lib.outline("node:o").unwrap()[0].ord, 3);
    // An append fits after the last key.
    let p = insert_at(5, 5, block("e", 0, "末尾"));
    assert!(patch(&lib, "node:o", 2, &p).unwrap());
    now = p.apply_to(&now).unwrap();
    assert_eq!(
        keys(&lib, "node:o")[..5]
            .iter()
            .map(|k| k.1)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3, 4]
    );
    // An insert between 1 and 2 does not: renumbered.
    let p = insert_at(2, 6, block("m", 0, "中间"));
    assert!(patch(&lib, "node:o", 3, &p).unwrap());
    now = p.apply_to(&now).unwrap();
    assert_eq!(stored(&lib, "node:o"), rows_of(&now));
    assert_eq!(
        keys(&lib, "node:o").iter().map(|k| k.1).collect::<Vec<_>>(),
        (0..7i64).map(|j| j << 32).collect::<Vec<_>>()
    );
    assert_eq!(hits(&lib, Some("book-p"), "中间"), [("node:o".into(), 2)]);
    assert_eq!(lib.outline("node:o").unwrap()[0].ord, 4);
}

/// The ordered search gives exactly what sorting every hit of a plain
/// search by the order and cutting would: random orders (with documents
/// left out, repeated or unknown), queries of one to four characters and
/// limits.
#[test]
fn ordered_search_equals_sorting_every_hit() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let mut rng = Rng::new(11);
    let docs: Vec<String> = (0..12).map(|i| format!("node:{i:02}")).collect();
    for (n, doc) in docs.iter().enumerate() {
        let blocks: Vec<BlockRow> = (0..rng.range(0, 30))
            .map(|i| para(&mut rng, (n * 100 + i) as u64))
            .collect();
        index(&lib, doc, "book-r", &blocks, &[]);
    }
    for _ in 0..200 {
        let mut order: Vec<&str> = Vec::new();
        for _ in 0..rng.range(0, 16) {
            match rng.below(8) {
                0 => order.push("node:unknown"),
                _ => order.push(rng.pick(&docs)),
            }
        }
        let q = *rng.pick(&["安", "安娜", "下着雨", "我们走吧", "雨", "rain", "无此字"]);
        let limit = rng.range(1, 40);
        let rank = |doc: &str| order.iter().position(|d| *d == doc).unwrap_or(usize::MAX);
        let mut expected = lib.search(Some("book-r"), q, 100_000).unwrap();
        expected.sort_by_key(|h| rank(&h.doc_id));
        expected.truncate(limit);
        assert_eq!(
            lib.search_in_order(Some("book-r"), q, limit, &order)
                .unwrap(),
            expected,
            "{q:?} limit {limit} order {order:?}"
        );
    }
}

fn ref_ids(lib: &Library, doc: &str) -> Vec<(i64, String, u32)> {
    lib.local_read(|c| {
        Ok(c.prepare(
            "SELECT id, target_id, count FROM reference WHERE source_doc = ?1 ORDER BY id",
        )?
        .query_map([doc], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .unwrap()
}

fn refs_of(lib: &Library, doc: &str) -> Vec<(Option<String>, String, String, RefKind, u32)> {
    lib.references_from(doc)
        .unwrap()
        .into_iter()
        .map(|r| (r.source_block, r.target_kind, r.target_id, r.kind, r.count))
        .collect()
}

fn want_refs(refs: &[RefRow]) -> Vec<(Option<String>, String, String, RefKind, u32)> {
    refs.iter()
        .map(|r| {
            (
                r.source_block.clone(),
                r.target_kind.clone(),
                r.target_id.clone(),
                r.kind,
                r.count.max(1),
            )
        })
        .collect()
}

fn random_ref(rng: &mut Rng) -> RefRow {
    RefRow {
        source_block: (rng.below(6) != 0).then(|| format!("b{}", rng.below(40))),
        target_kind: (*rng.pick(&["element", "material"])).to_string(),
        target_id: format!("el-{}", rng.below(30)),
        kind: *rng.pick(&[RefKind::Link, RefKind::Embed]),
        count: rng.range(1, 4) as u32,
    }
}

fn set_refs(lib: &Library, doc: &str, seq: i64, refs: &[RefRow]) {
    let p = DerivedPatch {
        base_paragraphs: 0,
        splices: vec![],
        references: Some(refs.to_vec()),
        words: 0,
        chars: 0,
    };
    assert!(patch(lib, doc, seq, &p).unwrap());
}

/// A document's references come back in the deriver's order however they
/// change, with other documents' rows interleaved in the table; a change in
/// the middle rewrites only the rows that differ.
#[test]
fn references_keep_their_order_and_only_changed_rows_are_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let mut rng = Rng::new(0xF2_0005);
    for doc in ["node:r", "node:other"] {
        lib.register(doc, "node", Some("book-p")).unwrap();
        full(&lib, doc, 1, &derived(vec![], vec![]));
    }
    let mut refs: Vec<RefRow> = (0..30).map(|_| random_ref(&mut rng)).collect();
    set_refs(&lib, "node:r", 2, &refs);
    for seq in 3..400 {
        match rng.below(6) {
            0 if !refs.is_empty() => {
                refs.remove(rng.below(refs.len() as u64) as usize);
            }
            1 if !refs.is_empty() => {
                let i = rng.below(refs.len() as u64) as usize;
                refs[i].count += 1;
            }
            2 => {
                // A paste: several at once.
                let at = rng.below(refs.len() as u64 + 1) as usize;
                let more: Vec<RefRow> =
                    (0..rng.range(1, 8)).map(|_| random_ref(&mut rng)).collect();
                refs.splice(at..at, more);
            }
            3 => {
                // Another document's rows land between this one's ids.
                let other: Vec<RefRow> =
                    (0..rng.range(0, 5)).map(|_| random_ref(&mut rng)).collect();
                set_refs(&lib, "node:other", seq, &other);
            }
            _ => {
                let at = rng.below(refs.len() as u64 + 1) as usize;
                refs.insert(at, random_ref(&mut rng));
            }
        }
        set_refs(&lib, "node:r", seq, &refs);
        assert_eq!(refs_of(&lib, "node:r"), want_refs(&refs), "seq {seq}");
    }

    // One place changed in the middle of 200 (as an Enter that splits a
    // paragraph with links): only the changed row and the new one are
    // written. (Changes in two places rewrite what lies between them.)
    let mut refs: Vec<RefRow> = (0..200)
        .map(|i| RefRow {
            source_block: Some(format!("p{i}")),
            target_kind: "element".into(),
            target_id: format!("el-{i}"),
            kind: RefKind::Link,
            count: 1,
        })
        .collect();
    set_refs(&lib, "node:r", 1000, &refs);
    let before = ref_ids(&lib, "node:r");
    refs[100].count = 2;
    refs.insert(101, link("p100", "el-new"));
    set_refs(&lib, "node:r", 1001, &refs);
    let after = ref_ids(&lib, "node:r");
    let kept = after.iter().filter(|r| before.contains(r)).count();
    assert_eq!(
        kept, 199,
        "only the changed row and the new one are written"
    );
    assert_eq!(refs_of(&lib, "node:r"), want_refs(&refs));

    // Rows numbered one by one (before the gaps): an insert in the middle
    // has no room, and the document's rows are written again in order.
    lib.local_transaction(|tx| {
        let ids: Vec<i64> = before_ids(tx, "node:r")?;
        tx.execute(
            "UPDATE reference SET id = -id WHERE source_doc = 'node:r'",
            [],
        )?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE reference SET id = ?2 WHERE id = ?1",
                rusqlite::params![-id, 1_000_000_000 + i as i64],
            )?;
        }
        Ok(())
    })
    .unwrap();
    refs.insert(10, link("p10", "el-tight"));
    set_refs(&lib, "node:r", 1002, &refs);
    assert_eq!(refs_of(&lib, "node:r"), want_refs(&refs));
}

fn before_ids(tx: &rusqlite::Connection, doc: &str) -> dr_store::Result<Vec<i64>> {
    Ok(tx
        .prepare("SELECT id FROM reference WHERE source_doc = ?1 ORDER BY id")?
        .query_map([doc], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?)
}

/// A whole book's references (`mention.list` without `from`/`to`) are read
/// through `reference_by_book` (migration 0006): only that book's rows, in
/// order, with no sort.
#[test]
fn a_books_references_are_read_through_its_own_index() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let plan: Vec<String> = lib
        .local_read(|c| {
            let mut s = c.prepare(
                "EXPLAIN QUERY PLAN SELECT source_doc, source_block, book_id, target_kind,
                   target_id, kind, count FROM reference WHERE book_id = ?1
                 ORDER BY source_doc, id",
            )?;
            let rows = s
                .query_map(["b1"], |r| r.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(
        plan,
        ["SEARCH reference USING INDEX reference_by_book (book_id=?)"],
        "{plan:?}"
    );
    lib.close().unwrap();
}
