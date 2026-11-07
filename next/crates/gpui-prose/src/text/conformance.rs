//! A conformance suite for [`ProseSource`] implementations: the loro-schema
//! v0 write rules, undo and anchors as the editor relies on them, a random
//! edit script checked against fresh reads, and a differential run of two
//! sources side by side.
//!
//! gpui-prose runs it on its own [`crate::text::LoroSource`] and on a test
//! source built like `dr-doc` (closure writes, events without marks).
//! Drifting's `dr-editor` runs it on its real `dr-doc` source with the
//! `conformance` feature.
//!
//! Every check returns `Err(description)` instead of panicking, so a host can
//! report which rule its source breaks.

use std::collections::{HashMap, HashSet};

use loro::LoroValue;

use super::{
    blocks::{BlockAttrs, BlockKind},
    doc::{ORIGIN_USER, ProseDoc},
    source::{Edit, ProseSource},
};
use crate::schema::{block, inline};

/// Builds a source holding these paragraphs (a seed the author cannot undo).
pub type Factory<'a> = &'a dyn Fn(&[(BlockKind, &str)]) -> Box<dyn ProseSource>;

type Check = Result<(), String>;

fn ensure(cond: bool, what: impl FnOnce() -> String) -> Check {
    if cond { Ok(()) } else { Err(what()) }
}

fn open(make: Factory, paragraphs: &[(BlockKind, &str)]) -> ProseDoc {
    ProseDoc::open(make(paragraphs))
}

fn texts(doc: &ProseDoc) -> Vec<String> {
    doc.lines()[..doc.visible_lines()]
        .iter()
        .map(|line| line.text.to_string())
        .collect()
}

fn bids(doc: &ProseDoc) -> Vec<Option<String>> {
    doc.lines()[..doc.lines().len() - 1]
        .iter()
        .map(|line| line.bid().map(String::from))
        .collect()
}

/// The mirror equals a fresh read, the index matches, every paragraph has a
/// unique block id and the text ends with a newline.
pub fn consistent(doc: &ProseDoc) -> Check {
    ensure(doc.mirror_snapshot() == doc.reread(), || {
        "the mirror drifted from a fresh read".into()
    })?;
    ensure(doc.index_matches_mirror(), || {
        "the paragraph index disagrees with the mirror".into()
    })?;
    let ids = bids(doc);
    ensure(ids.iter().all(Option::is_some), || {
        format!("a paragraph has no block id: {ids:?}")
    })?;
    let unique: HashSet<&Option<String>> = ids.iter().collect();
    ensure(unique.len() == ids.len(), || {
        format!("duplicate block ids: {ids:?}")
    })?;
    ensure(doc.plain_text().ends_with('\n'), || {
        "the text no longer ends with a newline".into()
    })
}

/// Enter moves block ids with the text (loro-schema v0).
pub fn enter_rules(make: Factory) -> Check {
    let mut doc = open(
        make,
        &[(BlockKind::H2, "标题文字"), (BlockKind::Body, "正文")],
    );
    let ids = bids(&doc);
    doc.split(4, ORIGIN_USER);
    ensure(texts(&doc) == ["标题文字", "", "正文"], || {
        format!("Enter at a heading's end: {:?}", texts(&doc))
    })?;
    ensure(
        doc.line(0).bid() == ids[0].as_deref() && doc.line(0).kind == BlockKind::H2,
        || "Enter at the end: the heading keeps its id and kind".into(),
    )?;
    ensure(doc.line(1).kind == BlockKind::Body, || {
        "Enter at the end: the new paragraph is body".into()
    })?;
    doc.split(2, ORIGIN_USER);
    ensure(
        doc.line(0).kind == BlockKind::H2 && doc.line(1).kind == BlockKind::H2,
        || "Enter in the middle: both halves stay headings".into(),
    )?;
    ensure(doc.line(1).bid() == ids[0].as_deref(), || {
        "Enter in the middle: the second half keeps the id".into()
    })?;
    let start = doc.line_start(3);
    doc.split(start, ORIGIN_USER);
    ensure(doc.line(4).bid() == ids[1].as_deref(), || {
        "Enter at a paragraph start: the paragraph keeps its id".into()
    })?;
    consistent(&doc)
}

/// Joins keep the right block id and kind.
pub fn join_rules(make: Factory) -> Check {
    let mut doc = open(
        make,
        &[
            (BlockKind::H2, "标题"),
            (BlockKind::Body, ""),
            (BlockKind::H3, "小节"),
            (BlockKind::Body, "正文"),
        ],
    );
    let ids = bids(&doc);
    doc.join_backward(2, ORIGIN_USER);
    ensure(
        texts(&doc) == ["标题", "小节", "正文"] && doc.line(1).bid() == ids[2].as_deref(),
        || "Backspace below an empty paragraph keeps the lower one".into(),
    )?;
    doc.join_backward(2, ORIGIN_USER);
    ensure(
        texts(&doc) == ["标题", "小节正文"]
            && doc.line(1).kind == BlockKind::H3
            && doc.line(1).bid() == ids[2].as_deref(),
        || "Backspace into a paragraph keeps the upper one's id and kind".into(),
    )?;
    let end = doc.line_start(1) + 2;
    doc.delete(1..end, ORIGIN_USER);
    ensure(
        texts(&doc) == ["标正文"] && doc.line(0).bid() == ids[0].as_deref(),
        || "a cross-paragraph delete keeps the first paragraph".into(),
    )?;
    consistent(&doc)
}

/// Pasted paragraphs get fresh ids; one undo removes the paste.
pub fn paste_rules(make: Factory) -> Check {
    let mut doc = open(make, &[(BlockKind::Body, "开头结尾")]);
    let original = bids(&doc)[0].clone();
    let inserted = doc.replace(2..2, "一\n二\n三", ORIGIN_USER);
    ensure(inserted == (2..7), || format!("paste range {inserted:?}"))?;
    ensure(texts(&doc) == ["开头一", "二", "三结尾"], || {
        format!("paste: {:?}", texts(&doc))
    })?;
    ensure(doc.line(2).bid() == original.as_deref(), || {
        "paste: the paragraph after the caret keeps the id".into()
    })?;
    consistent(&doc)?;
    doc.undo();
    ensure(texts(&doc) == ["开头结尾"], || {
        "one undo removes the paste".into()
    })
}

/// Grouping, the Agent's writes, Enter and the final newline.
pub fn undo_rules(make: Factory) -> Check {
    let mut doc = open(make, &[(BlockKind::Body, "")]);
    for (ix, ch) in "你好世界".chars().enumerate() {
        doc.replace(ix..ix, &ch.to_string(), ORIGIN_USER);
    }
    ensure(doc.undo_count() == 1, || {
        "a burst of typing is one step".into()
    })?;
    doc.checkpoint();
    doc.replace(4..4, "。", ORIGIN_USER);
    let end = doc.line(0).chars;
    doc.replace(end..end, "【补】", "agent:s/1");
    ensure(doc.undo_count() == 2, || {
        "the Agent's write is not the author's step".into()
    })?;
    doc.undo();
    ensure(doc.line(0).text.as_ref() == "你好世界【补】", || {
        format!("undo keeps the Agent's text: {}", doc.line(0).text)
    })?;
    doc.undo();
    doc.redo();
    ensure(doc.line(0).text.as_ref() == "你好世界【补】", || {
        "redo".into()
    })?;
    let mut doc = open(make, &[(BlockKind::H1, "标题")]);
    doc.split(2, ORIGIN_USER);
    doc.undo();
    ensure(
        doc.plain_text() == "标题\n" && doc.line(0).kind == BlockKind::H1,
        || "undoing Enter keeps the final newline and the heading".into(),
    )?;
    consistent(&doc)
}

/// Marks skip newlines, toggle, expand like the schema says.
pub fn mark_rules(make: Factory) -> Check {
    let mut doc = open(
        make,
        &[(BlockKind::Body, "甲乙丙"), (BlockKind::Body, "丁戊")],
    );
    ensure(doc.toggle_mark(1..5, inline::BOLD, ORIGIN_USER), || {
        "toggle on".into()
    })?;
    ensure(
        doc.range_has_mark(1..5, inline::BOLD) && doc.line(0).block.get(inline::BOLD).is_none(),
        || "bold covers the range but not the newline".into(),
    )?;
    ensure(!doc.toggle_mark(1..5, inline::BOLD, ORIGIN_USER), || {
        "toggle off".into()
    })?;
    consistent(&doc)?;
    let mut doc = open(make, &[(BlockKind::Body, "粗体链接")]);
    doc.mark(0..2, inline::BOLD, true.into(), ORIGIN_USER);
    doc.set_link(2..4, Some("https://example.com"), ORIGIN_USER);
    doc.replace(2..2, "字", ORIGIN_USER);
    ensure(doc.range_has_mark(0..3, inline::BOLD), || {
        "typing after bold stays bold".into()
    })?;
    doc.replace(5..5, "外", ORIGIN_USER);
    ensure(!doc.range_has_mark(5..6, inline::LINK), || {
        "typing after a link is not linked".into()
    })?;
    doc.replace_styled(
        6..6,
        "加",
        &[(inline::ITALIC.into(), Some(LoroValue::Bool(true)))],
        ORIGIN_USER,
    );
    ensure(doc.range_has_mark(6..7, inline::ITALIC), || {
        "pending toggles style the inserted text".into()
    })?;
    doc.set_block_attr(0, block::QUOTE, Some(true.into()), ORIGIN_USER);
    ensure(doc.line(0).block.get(block::QUOTE).is_some(), || {
        "paragraph attribute".into()
    })?;
    consistent(&doc)
}

/// Undo re-anchors anchors whose text it brings back.
pub fn anchor_rules(make: Factory) -> Check {
    let mut doc = open(make, &[(BlockKind::Body, "零一二三四五六七")]);
    doc.add_anchor("whole", 1..3).ok_or("anchor")?;
    doc.add_anchor("tail", 4..7).ok_or("anchor")?;
    doc.delete(0..5, ORIGIN_USER);
    ensure(doc.anchor("whole").is_some_and(|r| r.collapsed), || {
        "a fully deleted anchor collapses".into()
    })?;
    doc.undo();
    let whole = doc.anchor("whole").map(|r| r.range);
    let tail = doc.anchor("tail").map(|r| r.range);
    ensure(whole == Some(1..3) && tail == Some(4..7), || {
        format!("undo re-anchors: whole {whole:?}, tail {tail:?}")
    })?;
    ensure(doc.take_anchor_changes().len() == 2, || {
        "the host hears about both".into()
    })?;
    doc.delete(1..3, "agent:s/2");
    ensure(
        doc.undo().is_none() || doc.anchor("whole").is_some_and(|r| r.collapsed),
        || "the Agent's delete is not undone by the author".into(),
    )?;
    Ok(())
}

/// A batch of edits is one commit, one undo item, undone and redone whole;
/// a batch of deletes brings its anchors back on undo.
pub fn batch_rules(make: Factory) -> Check {
    let mut doc = open(
        make,
        &[
            (BlockKind::Body, "阿明来了，阿明笑了。"),
            (BlockKind::Body, "大家都等阿明。"),
        ],
    );
    let steps = doc.undo_count();
    doc.checkpoint();
    // Last first, as a replace-all gives them.
    let edits: Vec<Edit> = [15..17, 5..7, 0..2]
        .into_iter()
        .map(|range| Edit::Replace {
            range,
            text: "小明",
            overrides: &[],
        })
        .collect();
    let result = doc.edit_batch(&edits, ORIGIN_USER);
    ensure(
        texts(&doc) == ["小明来了，小明笑了。", "大家都等小明。"],
        || format!("a batch of replacements: {:?}", texts(&doc)),
    )?;
    ensure(result.undo_items == 1, || {
        format!(
            "a batch is one commit, one undo item, not {}",
            result.undo_items
        )
    })?;
    ensure(result.deleted.len() == 3, || {
        format!("a batch reports each deletion: {:?}", result.deleted)
    })?;
    ensure(doc.undo_count() == steps + 1, || {
        "a batch is one author step".into()
    })?;
    doc.undo();
    ensure(
        texts(&doc) == ["阿明来了，阿明笑了。", "大家都等阿明。"],
        || format!("one undo takes the whole batch back: {:?}", texts(&doc)),
    )?;
    doc.redo();
    ensure(
        texts(&doc) == ["小明来了，小明笑了。", "大家都等小明。"],
        || format!("one redo puts it back: {:?}", texts(&doc)),
    )?;
    consistent(&doc)?;

    let mut doc = open(make, &[(BlockKind::Body, "零一二三四五六七八九")]);
    doc.add_anchor("two", 2..3).ok_or("anchor")?;
    doc.add_anchor("seven", 7..9).ok_or("anchor")?;
    doc.checkpoint();
    let edits = [Edit::Delete { range: 6..9 }, Edit::Delete { range: 1..4 }];
    doc.edit_batch(&edits, ORIGIN_USER);
    ensure(texts(&doc) == ["零四五九"], || {
        format!("a batch of deletes: {:?}", texts(&doc))
    })?;
    doc.undo();
    let two = doc.anchor("two").map(|r| r.range);
    let seven = doc.anchor("seven").map(|r| r.range);
    ensure(two == Some(2..3) && seven == Some(7..9), || {
        format!("undoing a batch re-anchors: two {two:?}, seven {seven:?}")
    })?;
    consistent(&doc)
}

/// xorshift64*, so the suite needs no crates.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const SNIPPETS: &[&str] = &[
    "字",
    "两个",
    "\n",
    "a\nb",
    "😀",
    "，",
    "\n\n",
    "长一点的一句话",
    "👨\u{200D}👩\u{200D}👧",
];
const KEYS: &[&str] = &[inline::BOLD, inline::ITALIC, inline::LINK, "entity:e1"];

/// One random step on `doc` (the same `rng` state gives the same step).
fn random_step(doc: &mut ProseDoc, rng: &mut Rng) {
    let len = doc.len_chars();
    match rng.below(11) {
        0..=2 => {
            let at = rng.below(len);
            let snippet = SNIPPETS[rng.below(SNIPPETS.len())];
            doc.replace(at..at, snippet, ORIGIN_USER);
        }
        3 if len >= 2 => {
            let at = rng.below(len - 1);
            let n = 1 + rng.below(8).min(len - 1 - at);
            doc.delete(at..at + n, ORIGIN_USER);
        }
        4 => {
            let ix = rng.below(doc.lines().len());
            let kind = [BlockKind::Body, BlockKind::H1, BlockKind::H2, BlockKind::H3][rng.below(4)];
            doc.set_kind(ix, kind, ORIGIN_USER);
        }
        5 => {
            let at = rng.below(len).min(doc.max_cursor());
            doc.split(at, ORIGIN_USER);
        }
        6 => {
            doc.undo();
        }
        7 => {
            doc.redo();
        }
        8 if len >= 2 => {
            let at = rng.below(len - 1);
            let n = 1 + rng.below(6).min(len - 1 - at);
            let key = KEYS[rng.below(KEYS.len())];
            if rng.below(3) == 0 {
                doc.unmark(at..at + n, key, ORIGIN_USER);
            } else {
                // The values the editor writes: `true` for the toggles, a
                // URL for a link, the storage format's map for an entity link
                // (a typed source stores exactly these).
                let value = if key == inline::LINK {
                    LoroValue::from("https://example.com/")
                } else if inline::entity_target(key).is_some() {
                    LoroValue::Map(vec![("kind".to_string(), LoroValue::from("element"))].into())
                } else {
                    LoroValue::from(true)
                };
                doc.mark(at..at + n, key, value, ORIGIN_USER);
            }
        }
        9 => {
            let ix = rng.below(doc.lines().len());
            doc.set_block_attr(ix, block::QUOTE, Some(true.into()), ORIGIN_USER);
        }
        _ => {
            let at = rng.below(len);
            doc.replace(at..at, "代", "agent:s/9");
        }
    }
}

/// `seeds` random scripts of `steps` steps; [`consistent`] after every step.
pub fn random_edits(make: Factory, seeds: u64, steps: usize) -> Check {
    for seed in 1..=seeds {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut doc = open(
            make,
            &[(BlockKind::H1, "开头"), (BlockKind::Body, "正文第一段")],
        );
        doc.add_anchor("a", 1..3);
        for step in 0..steps {
            random_step(&mut doc, &mut rng);
            consistent(&doc).map_err(|e| format!("seed {seed}, step {step}: {e}"))?;
            let _ = doc.anchor("a");
        }
    }
    Ok(())
}

/// Block ids relabelled by first appearance across a run, so two sources
/// that mint different id strings can be compared by which paragraph keeps
/// which id.
struct Relabel(HashMap<String, usize>);
impl Relabel {
    fn of(&mut self, doc: &ProseDoc) -> Vec<usize> {
        bids(doc)
            .into_iter()
            .map(|id| {
                let next = self.0.len();
                *self.0.entry(id.unwrap_or_default()).or_insert(next)
            })
            .collect()
    }
}

fn without_bid(block: &BlockAttrs) -> Vec<(String, LoroValue)> {
    block
        .iter()
        .filter(|(key, _)| *key != block::ID)
        .map(|(key, value)| (key.to_owned(), value.clone()))
        .collect()
}

/// The same random scripts on two sources must give the same documents:
/// text, paragraph attributes, marks, which paragraphs keep which block ids,
/// and the same undo behaviour.
pub fn same_behaviour(a: Factory, b: Factory, seeds: u64, steps: usize) -> Check {
    for seed in 1..=seeds {
        let paragraphs = [(BlockKind::H1, "开头"), (BlockKind::Body, "正文第一段")];
        let (mut da, mut db) = (open(a, &paragraphs), open(b, &paragraphs));
        let (mut ra, mut rb) = (
            Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1),
            Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1),
        );
        let (mut la, mut lb) = (Relabel(HashMap::new()), Relabel(HashMap::new()));
        for step in 0..steps {
            random_step(&mut da, &mut ra);
            random_step(&mut db, &mut rb);
            let at = || format!("seed {seed}, step {step}");
            ensure(da.plain_text() == db.plain_text(), || {
                format!(
                    "{}: texts differ\n{:?}\n{:?}",
                    at(),
                    da.plain_text(),
                    db.plain_text()
                )
            })?;
            for (x, y) in da.lines().iter().zip(db.lines()) {
                ensure(without_bid(&x.block) == without_bid(&y.block), || {
                    format!("{}: paragraph attributes differ in {:?}", at(), x.text)
                })?;
                ensure(x.spans == y.spans, || {
                    format!("{}: marks differ in {:?}", at(), x.text)
                })?;
            }
            ensure(la.of(&da) == lb.of(&db), || {
                format!("{}: block ids moved differently", at())
            })?;
            ensure(da.undo_count() == db.undo_count(), || {
                format!("{}: undo steps differ", at())
            })?;
        }
    }
    Ok(())
}

/// Every rule check, then a random script.
pub fn run_all(make: Factory) -> Check {
    enter_rules(make)?;
    join_rules(make)?;
    paste_rules(make)?;
    undo_rules(make)?;
    mark_rules(make)?;
    anchor_rules(make)?;
    batch_rules(make)?;
    random_edits(make, 12, 100)
}
