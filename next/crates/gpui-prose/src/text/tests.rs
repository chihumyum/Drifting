//! Text-layer behaviour without a window: the mirror against fresh reads,
//! the block-id rules, inline marks, undo grouping and anchors in undo.

use std::collections::HashSet;

use loro::{ExportMode, LoroDoc, LoroValue};

use super::*;
use crate::schema::{BODY, block, inline};

fn assert_mirror(doc: &ProseDoc) {
    assert_eq!(
        doc.mirror_snapshot(),
        doc.reread(),
        "mirror drifted from Loro"
    );
}

fn texts(doc: &ProseDoc) -> Vec<String> {
    doc.lines()[..doc.visible_lines()]
        .iter()
        .map(|line| line.text.to_string())
        .collect()
}

fn bids(doc: &ProseDoc) -> Vec<String> {
    doc.lines()[..doc.lines().len() - 1]
        .iter()
        .map(|line| {
            line.bid()
                .expect("every paragraph has a block id")
                .to_owned()
        })
        .collect()
}

fn assert_unique_bids(doc: &ProseDoc) {
    let ids = bids(doc);
    let unique: HashSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "duplicate block ids: {ids:?}");
}

fn seeded(paragraphs: &[(BlockKind, &str)]) -> ProseDoc {
    ProseDoc::from_paragraphs(paragraphs.iter().copied())
}

#[test]
fn seed_and_reread_agree() {
    let doc = seeded(&[
        (BlockKind::H1, "第一章"),
        (BlockKind::Body, "天色将晚。"),
        (BlockKind::H2, "小标题"),
        (BlockKind::Body, ""),
    ]);
    assert_eq!(doc.visible_lines(), 4);
    assert_eq!(doc.line(0).kind, BlockKind::H1);
    assert_eq!(doc.line(2).kind, BlockKind::H2);
    assert_eq!(doc.line(3).text.as_ref(), "");
    assert_unique_bids(&doc);
    assert_mirror(&doc);
}

/// Enter follows loro-schema v0: the new newline goes in at the caret and the
/// block id follows the text it ends.
#[test]
fn enter_moves_block_ids_with_the_text() {
    let mut doc = seeded(&[(BlockKind::H2, "标题文字"), (BlockKind::Body, "正文")]);
    let (heading, body) = (bids(&doc)[0].clone(), bids(&doc)[1].clone());

    // At the end of a heading: the heading keeps its id; the new empty
    // paragraph below is body with a fresh id.
    doc.split(4, ORIGIN_USER);
    assert_eq!(texts(&doc), ["标题文字", "", "正文"]);
    assert_eq!(doc.line(0).bid(), Some(heading.as_str()));
    assert_eq!(doc.line(0).kind, BlockKind::H2);
    assert_eq!(doc.line(1).kind, BlockKind::Body);
    assert_ne!(doc.line(1).bid(), Some(heading.as_str()));
    assert_eq!(doc.line(2).bid(), Some(body.as_str()));
    assert_unique_bids(&doc);
    assert_mirror(&doc);

    // In the middle: the first half gets a fresh id and stays a heading, the
    // second half keeps the paragraph's id.
    doc.split(2, ORIGIN_USER);
    assert_eq!(texts(&doc), ["标题", "文字", "", "正文"]);
    assert_eq!(doc.line(0).kind, BlockKind::H2);
    assert_eq!(doc.line(1).kind, BlockKind::H2);
    assert_eq!(doc.line(1).bid(), Some(heading.as_str()));
    assert_unique_bids(&doc);

    // At the start: the new empty paragraph above is body; the paragraph
    // itself is untouched.
    let start = doc.line_start(3);
    doc.split(start, ORIGIN_USER);
    assert_eq!(texts(&doc), ["标题", "文字", "", "", "正文"]);
    assert_eq!(doc.line(4).bid(), Some(body.as_str()));
    assert_eq!(doc.line(3).kind, BlockKind::Body);
    assert_unique_bids(&doc);
    assert_mirror(&doc);
}

/// Backspace joins under the v0 rules: into a non-empty paragraph above, the
/// joined paragraph keeps the upper one's id and kind; below an empty
/// paragraph, the empty one goes and the lower one keeps its id and kind.
#[test]
fn joins_keep_the_right_block_id() {
    let mut doc = seeded(&[
        (BlockKind::H2, "标题"),
        (BlockKind::Body, ""),
        (BlockKind::H3, "小节"),
        (BlockKind::Body, "正文"),
    ]);
    let ids = bids(&doc);
    doc.join_backward(2, ORIGIN_USER);
    assert_eq!(texts(&doc), ["标题", "小节", "正文"]);
    assert_eq!(doc.line(1).kind, BlockKind::H3);
    assert_eq!(doc.line(1).bid(), Some(ids[2].as_str()));
    doc.join_backward(2, ORIGIN_USER);
    assert_eq!(texts(&doc), ["标题", "小节正文"]);
    assert_eq!(doc.line(1).kind, BlockKind::H3);
    assert_eq!(doc.line(1).bid(), Some(ids[2].as_str()));
    // A selection across paragraphs: the first paragraph absorbs the rest.
    let end = doc.line_start(1) + 2;
    doc.delete(1..end, ORIGIN_USER);
    assert_eq!(texts(&doc), ["标正文"]);
    assert_eq!(doc.line(0).kind, BlockKind::H2);
    assert_eq!(doc.line(0).bid(), Some(ids[0].as_str()));
    assert_mirror(&doc);
}

/// A pasted multi-paragraph text gets a fresh id for every new paragraph.
#[test]
fn pasted_paragraphs_get_fresh_ids() {
    let mut doc = seeded(&[(BlockKind::Body, "开头结尾")]);
    let original = bids(&doc)[0].clone();
    let inserted = doc.replace(2..2, "一\n二\n三", ORIGIN_USER);
    assert_eq!(inserted, 2..7);
    assert_eq!(texts(&doc), ["开头一", "二", "三结尾"]);
    assert_eq!(doc.line(2).bid(), Some(original.as_str()));
    assert_unique_bids(&doc);
    assert_mirror(&doc);
    doc.undo().expect("one step");
    assert_eq!(texts(&doc), ["开头结尾"]);
}

#[test]
fn utf16_round_trip() {
    let doc = seeded(&[(BlockKind::Body, "a😀中"), (BlockKind::Body, "文")]);
    // "a😀中\n文\n": scalars a=0 😀=1 中=2 \n=3 文=4; utf16 a=0 😀=1..3 中=3 \n=4 文=5
    assert_eq!(doc.offset_to_utf16(2), 3);
    assert_eq!(doc.offset_to_utf16(4), 5);
    assert_eq!(doc.offset_from_utf16(5), 4);
    assert_eq!(doc.offset_from_utf16(3), 2);
    assert_eq!(doc.len_utf16(), 7);
    assert_eq!(doc.slice(1..5), "😀中\n文");
}

/// Agent writes are excluded from the author's undo stack: undo removes the
/// author's text and leaves the Agent's in place.
#[test]
fn undo_skips_agent_writes() {
    let mut doc = seeded(&[(BlockKind::Body, "")]);
    doc.replace(0..0, "作者写的", ORIGIN_USER);
    doc.checkpoint();
    let end = doc.line(0).chars;
    doc.replace(end..end, "【Agent 补的】", "agent:session-1/1");
    assert_eq!(doc.line(0).text.as_ref(), "作者写的【Agent 补的】");
    assert_eq!(doc.undo_count(), 1);
    doc.undo().expect("one author step to undo");
    assert_eq!(doc.line(0).text.as_ref(), "【Agent 补的】");
    assert!(!doc.can_undo());
    doc.redo().expect("redo the author step");
    assert_eq!(doc.line(0).text.as_ref(), "作者写的【Agent 补的】");
    assert_mirror(&doc);
}

/// Edits closer together than the merge interval are one undo step; a
/// checkpoint starts a new one.
#[test]
fn undo_merges_within_interval() {
    let mut doc = seeded(&[(BlockKind::Body, "")]);
    for (ix, ch) in "你好世界".chars().enumerate() {
        doc.replace(ix..ix, &ch.to_string(), ORIGIN_USER);
    }
    assert_eq!(doc.undo_count(), 1);
    doc.checkpoint();
    doc.replace(4..4, "。", ORIGIN_USER);
    assert_eq!(doc.undo_count(), 2);
    doc.undo();
    assert_eq!(doc.line(0).text.as_ref(), "你好世界");
    doc.undo();
    assert_eq!(doc.line(0).text.as_ref(), "");
    assert_mirror(&doc);
}

/// Enter goes in at the cursor, so undoing it can never remove the
/// document's last newline (loro-schema v0).
#[test]
fn undo_of_enter_keeps_the_final_newline() {
    let mut doc = seeded(&[(BlockKind::H1, "标题")]);
    let id = bids(&doc)[0].clone();
    doc.split(2, ORIGIN_USER);
    assert_eq!(doc.loro_source().unwrap().text().to_string(), "标题\n\n");
    doc.undo().expect("undo the Enter");
    assert_eq!(doc.loro_source().unwrap().text().to_string(), "标题\n");
    assert_eq!(doc.line(0).kind, BlockKind::H1);
    assert_eq!(doc.line(0).bid(), Some(id.as_str()));
    assert_mirror(&doc);
}

// ----- inline marks ------------------------------------------------------------

#[test]
fn marks_skip_newlines_and_toggle() {
    let mut doc = seeded(&[(BlockKind::Body, "甲乙丙"), (BlockKind::Body, "丁戊")]);
    // 甲乙丙\n丁戊\n — bold from 乙 to 丁, across the newline.
    assert!(doc.toggle_mark(1..5, inline::BOLD, ORIGIN_USER));
    assert!(doc.range_has_mark(1..5, inline::BOLD));
    assert!(!doc.range_has_mark(0..5, inline::BOLD));
    let line0 = doc.line(0).clone();
    assert_eq!(line0.spans.len(), 1);
    assert_eq!(&line0.text[line0.spans[0].range.clone()], "乙丙");
    assert!(line0.spans[0].marks.bold());
    // The newline itself carries paragraph attributes only.
    assert!(doc.line(0).block.get(inline::BOLD).is_none());
    assert_mirror(&doc);
    // Toggling the same range again clears it.
    assert!(!doc.toggle_mark(1..5, inline::BOLD, ORIGIN_USER));
    assert!(doc.line(0).spans.is_empty());
    assert!(doc.line(1).spans.is_empty());
    assert_mirror(&doc);
}

/// Bold expands after (typing at its end stays bold); links do not.
#[test]
fn bold_expands_and_links_do_not() {
    let mut doc = seeded(&[(BlockKind::Body, "粗体链接")]);
    doc.mark(0..2, inline::BOLD, true.into(), ORIGIN_USER);
    doc.set_link(2..4, Some("https://example.com"), ORIGIN_USER);
    doc.replace(2..2, "字", ORIGIN_USER);
    assert!(doc.range_has_mark(0..3, inline::BOLD));
    doc.replace(5..5, "外", ORIGIN_USER);
    assert!(!doc.range_has_mark(5..6, inline::LINK));
    let line = doc.line(0).clone();
    let link = line
        .spans
        .iter()
        .find(|span| span.marks.link().is_some())
        .unwrap();
    assert_eq!(&line.text[link.range.clone()], "链接");
    assert_mirror(&doc);
}

/// The caret's pending toggles style the next inserted text in the same commit.
#[test]
fn pending_toggles_style_inserted_text() {
    let mut doc = seeded(&[(BlockKind::Body, "正文")]);
    doc.replace_styled(
        2..2,
        "加粗",
        &[(inline::BOLD.into(), Some(LoroValue::Bool(true)))],
        ORIGIN_USER,
    );
    assert!(doc.range_has_mark(2..4, inline::BOLD));
    assert!(!doc.range_has_mark(0..2, inline::BOLD));
    assert_eq!(doc.undo_count(), 1);
    doc.undo();
    assert_eq!(doc.line(0).text.as_ref(), "正文");
    assert_mirror(&doc);
}

// ----- anchors in undo -----------------------------------------------------------

/// Deleting anchored text collapses the anchor; undoing the delete brings the
/// anchor back over the restored text, and reports it for the host to store.
#[test]
fn undo_brings_a_deleted_anchor_back() {
    let mut doc = seeded(&[(BlockKind::Body, "甲乙丙丁戊己")]);
    doc.add_anchor("c1", 2..4).unwrap(); // 丙丁
    doc.delete(1..5, ORIGIN_USER); // 乙丙丁戊
    let gone = doc.anchor("c1").unwrap();
    assert!(gone.collapsed);
    assert_eq!(gone.range, 1..1);
    doc.undo().expect("undo the delete");
    assert_eq!(doc.line(0).text.as_ref(), "甲乙丙丁戊己");
    assert_eq!(doc.anchor("c1").unwrap().range, 2..4);
    let changes = doc.take_anchor_changes();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].range, 2..4);
    // Redo collapses it again; another undo brings it back again.
    doc.redo();
    assert!(doc.anchor("c1").unwrap().collapsed);
    doc.undo();
    assert_eq!(doc.anchor("c1").unwrap().range, 2..4);
}

/// Deleting one edge of an anchor shrinks it; undo grows it back. A deletion
/// strictly inside an anchor needs nothing: its edges never died.
#[test]
fn undo_restores_partially_deleted_anchors() {
    let mut doc = seeded(&[(BlockKind::Body, "零一二三四五六七")]);
    doc.add_anchor("head", 1..4).unwrap(); // 一二三
    doc.add_anchor("tail", 4..7).unwrap(); // 四五六
    doc.add_anchor("around", 0..8).unwrap();
    doc.delete(3..5, ORIGIN_USER); // 三四
    assert_eq!(doc.anchor("head").unwrap().range, 1..3);
    assert_eq!(doc.anchor("tail").unwrap().range, 3..5);
    doc.undo();
    assert_eq!(doc.anchor("head").unwrap().range, 1..4);
    assert_eq!(doc.anchor("tail").unwrap().range, 4..7);
    assert_eq!(doc.anchor("around").unwrap().range, 0..8);
    let mut changed: Vec<String> = doc
        .take_anchor_changes()
        .into_iter()
        .map(|change| change.id.to_string())
        .collect();
    changed.sort();
    assert_eq!(changed, ["head", "tail"]);
}

/// Backspaces merged into one step, each its own Loro item: undo walks the
/// items back and re-anchors after each.
#[test]
fn undo_restores_anchors_across_merged_backspaces() {
    let mut doc = seeded(&[(BlockKind::Body, "甲乙丙丁")]);
    doc.add_anchor("c", 1..3).unwrap(); // 乙丙
    for end in [4usize, 3, 2, 1] {
        doc.delete(end - 1..end, ORIGIN_USER);
    }
    assert_eq!(doc.undo_count(), 1);
    assert!(doc.anchor("c").unwrap().collapsed);
    doc.undo();
    assert_eq!(doc.line(0).text.as_ref(), "甲乙丙丁");
    assert_eq!(doc.anchor("c").unwrap().range, 1..3);
}

/// The Agent's deletions are not the author's to undo; the anchor stays
/// collapsed until the author's own history (snapshots) restores it.
#[test]
fn agent_deletions_leave_anchors_alone() {
    let mut doc = seeded(&[(BlockKind::Body, "甲乙丙丁")]);
    doc.add_anchor("c", 1..3).unwrap();
    doc.delete(1..3, "agent:s/1");
    assert!(doc.undo().is_none());
    assert!(doc.anchor("c").unwrap().collapsed);
    assert!(doc.take_anchor_changes().is_empty());
}

/// An anchor edited around by a remote peer between the delete and the undo
/// still comes back over its own text.
#[test]
fn anchor_restore_survives_remote_edits() {
    let mut doc = seeded(&[(BlockKind::Body, "甲乙丙丁")]);
    doc.loro_source().unwrap().loro().set_peer_id(1).unwrap();
    doc.add_anchor("c", 2..4).unwrap(); // 丙丁
    let remote = LoroDoc::new();
    crate::schema::configure(&remote);
    remote.set_peer_id(2).unwrap();
    remote
        .import(
            &doc.loro_source()
                .unwrap()
                .loro()
                .export(ExportMode::Snapshot)
                .unwrap(),
        )
        .unwrap();
    doc.delete(2..4, ORIGIN_USER);
    remote.get_text(BODY).insert(0, "远端").unwrap();
    remote.commit();
    doc.import(&remote.export(ExportMode::all_updates()).unwrap())
        .unwrap();
    assert_eq!(doc.line(0).text.as_ref(), "远端甲乙");
    doc.undo();
    assert_eq!(doc.line(0).text.as_ref(), "远端甲乙丙丁");
    assert_eq!(doc.anchor("c").unwrap().range, 4..6);
}

// ----- block-id repair ----------------------------------------------------------

/// Two devices press Enter at the end of the same paragraph at once: each moves
/// the paragraph's id onto its own new newline. After the merge one paragraph
/// keeps the id, the other gets a deterministic fresh one, on both devices.
#[test]
fn concurrent_enters_are_repaired_the_same_way() {
    let seed = seeded(&[(BlockKind::Body, "同一段")]);
    let snapshot = seed
        .loro_source()
        .unwrap()
        .loro()
        .export(ExportMode::Snapshot)
        .unwrap();
    let open = |peer: u64| {
        let loro = LoroDoc::new();
        crate::schema::configure(&loro);
        loro.set_peer_id(peer).unwrap();
        loro.import(&snapshot).unwrap();
        ProseDoc::from_loro(loro)
    };
    let (mut a, mut b) = (open(11), open(12));
    a.split(3, ORIGIN_USER);
    b.split(3, ORIGIN_USER);
    let (ua, ub) = (
        a.loro_source()
            .unwrap()
            .loro()
            .export(ExportMode::all_updates())
            .unwrap(),
        b.loro_source()
            .unwrap()
            .loro()
            .export(ExportMode::all_updates())
            .unwrap(),
    );
    a.import(&ub).unwrap();
    b.import(&ua).unwrap();
    // Exchange the repairs too, then both agree.
    let (ra, rb) = (
        a.loro_source()
            .unwrap()
            .loro()
            .export(ExportMode::all_updates())
            .unwrap(),
        b.loro_source()
            .unwrap()
            .loro()
            .export(ExportMode::all_updates())
            .unwrap(),
    );
    a.import(&rb).unwrap();
    b.import(&ra).unwrap();
    assert_unique_bids(&a);
    assert_unique_bids(&b);
    assert_eq!(bids(&a), bids(&b));
    assert_eq!(texts(&a), texts(&b));
    assert_mirror(&a);
}

/// A document written without block ids (an old export, say) gets them on open.
#[test]
fn opening_fills_in_missing_block_ids() {
    let loro = LoroDoc::new();
    crate::schema::configure(&loro);
    loro.get_text(BODY).insert(0, "一\n二\n").unwrap();
    loro.commit();
    let doc = ProseDoc::from_loro(loro);
    assert_unique_bids(&doc);
    assert!(!doc.can_undo(), "the repair is not the author's to undo");
}

// ----- property test --------------------------------------------------------------

/// Small deterministic generator (xorshift64*), so the test needs no crates.
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

/// Random edits, marks, kinds, undo, redo and remote imports: the event-fed
/// mirror must always equal a fresh read of the Loro text, and every
/// paragraph keeps a unique block id.
#[test]
fn mirror_follows_random_edits_undo_and_imports() {
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
    for seed in 1..=24u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut doc = seeded(&[(BlockKind::H1, "开头"), (BlockKind::Body, "正文第一段")]);
        doc.loro_source().unwrap().loro().set_peer_id(1).unwrap();
        let remote = LoroDoc::new();
        crate::schema::configure(&remote);
        remote.set_peer_id(2).unwrap();
        remote
            .import(
                &doc.loro_source()
                    .unwrap()
                    .loro()
                    .export(ExportMode::Snapshot)
                    .unwrap(),
            )
            .unwrap();
        doc.add_anchor("a", 1..3);
        for _ in 0..120 {
            let len = doc.len_chars();
            match rng.below(12) {
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
                    let kind = [BlockKind::Body, BlockKind::H1, BlockKind::H2, BlockKind::H3]
                        [rng.below(4)];
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
                        doc.mark(at..at + n, key, LoroValue::from("v"), ORIGIN_USER);
                    }
                }
                9 => {
                    let ix = rng.below(doc.lines().len());
                    doc.set_block_attr(ix, block::QUOTE, Some(true.into()), ORIGIN_USER);
                }
                _ => {
                    // A remote peer edits its copy; we import the update.
                    let text = remote.get_text(BODY);
                    let rlen = text.len_unicode();
                    let at = rng.below(rlen);
                    text.insert(at, "远").unwrap();
                    if rlen > 3 && rng.below(2) == 0 {
                        text.delete(rng.below(rlen - 2), 1).unwrap();
                    }
                    if rlen > 4 && rng.below(3) == 0 {
                        let at = rng.below(rlen - 3);
                        text.mark(at..at + 2, inline::ITALIC, true).unwrap();
                    }
                    remote.commit();
                    let from = doc.loro_source().unwrap().loro().oplog_vv();
                    let update = remote.export(ExportMode::updates(&from)).unwrap();
                    doc.import(&update).unwrap();
                    remote
                        .import(
                            &doc.loro_source()
                                .unwrap()
                                .loro()
                                .export(ExportMode::Snapshot)
                                .unwrap(),
                        )
                        .unwrap();
                }
            }
            assert_mirror(&doc);
            assert_unique_bids(&doc);
            assert!(
                doc.loro_source()
                    .unwrap()
                    .text()
                    .to_string()
                    .ends_with('\n')
            );
            assert_eq!(
                doc.lines().len(),
                doc.loro_source()
                    .unwrap()
                    .text()
                    .to_string()
                    .matches('\n')
                    .count()
                    + 1
            );
            let _ = doc.anchor("a");
        }
    }
}

#[test]
fn text_op_transform() {
    let op = TextOp {
        pos: 5,
        deleted: 2,
        inserted: 3,
    };
    assert_eq!(op.transform(4), 4);
    assert_eq!(op.transform(5), 5);
    assert_eq!(op.transform(6), 5);
    assert_eq!(op.transform(7), 5);
    assert_eq!(op.transform(8), 9);
}

/// Hosts load chapters on background threads: a document must be `Send`.
#[test]
fn documents_can_move_between_threads() {
    fn assert_send<T: Send>() {}
    assert_send::<ProseDoc>();
}

/// Opening reads the text once (the block-id check's read is reused for the
/// mirror), but never a read the document has moved past.
#[test]
fn the_opening_read_is_reused_only_while_current() {
    let source = LoroSource::from_paragraphs([(BlockKind::Body, "一"), (BlockKind::H1, "二")]);
    let doc = ProseDoc::open(Box::new(source));
    assert_eq!(texts(&doc), ["一", "二"]);
    assert_eq!(doc.lines()[1].kind, BlockKind::H1);
    assert_mirror(&doc);

    // Changed through the LoroDoc before the editor opens it, committed or not.
    for commit in [true, false] {
        let source = LoroSource::from_paragraphs([(BlockKind::Body, "一")]);
        source.text().insert(0, "新").unwrap();
        if commit {
            source.loro().commit();
        }
        let doc = ProseDoc::open(Box::new(source));
        assert_eq!(texts(&doc), ["新一"], "commit: {commit}");
        assert_mirror(&doc);
    }
}

// ----- the text-source conformance suite -------------------------------------------

fn loro_source(paragraphs: &[(BlockKind, &str)]) -> Box<dyn ProseSource> {
    Box::new(LoroSource::from_paragraphs(paragraphs.iter().copied()))
}

fn dr_doc_style(paragraphs: &[(BlockKind, &str)]) -> Box<dyn ProseSource> {
    Box::new(super::drdoc_style::DrDocStyle::seeded(paragraphs))
}

#[test]
fn conformance_on_the_built_in_source() {
    conformance::run_all(&loro_source).unwrap();
}

/// A source built the way `dr-doc` + `dr-store` are (writes through a holder's
/// closure, Quill-style events without marks, its own undo exclusions, its own
/// implementation of the v0 rules) passes the same suite: the trait is enough.
#[test]
fn conformance_on_a_dr_doc_style_source() {
    conformance::run_all(&dr_doc_style).unwrap();
}

/// The two sources, driven by the same random scripts through the editor's
/// document, stay identical: text, paragraph attributes, marks, which
/// paragraph keeps which block id, undo steps.
#[test]
fn dr_doc_style_source_matches_the_built_in_one() {
    conformance::same_behaviour(&loro_source, &dr_doc_style, 16, 120).unwrap();
}
