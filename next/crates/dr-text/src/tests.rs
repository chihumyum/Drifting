use dr_doc::book::{BookDoc, BookTxn};
use dr_doc::prose::{EmbedKind, ProseDoc, ProseTxn};
use dr_model::id::{BookId, ElementId, EmbedId, MaterialId, NodeId};
use dr_model::kind::{EntityKind, NodeKind};
use dr_model::pos::PosKey;
use dr_model::prose::{EntityLink, Heading, InlineStyle};
use dr_model::time::Timestamp;
use dr_model::{DocId, Origin};

use crate::autolink::book_link_names;
use crate::*;

fn prose(f: impl FnOnce(&mut ProseTxn<'_>) -> dr_doc::Result<()>) -> ProseDoc {
    let mut d = ProseDoc::create(DocId::parse("node:n1").unwrap(), 7).unwrap();
    let (r, _) = d.edit(Origin::User, f);
    r.unwrap();
    d
}

/// Paragraphs written one after another (each `\n` an Enter).
fn paragraphs(text: &str) -> ProseDoc {
    prose(|t| t.insert_paragraphs(0, text).map(|_| ()))
}

fn link(target: &str) -> EntityLink {
    EntityLink {
        target: target.into(),
        kind: EntityKind::Element,
        block: None,
        end_block: None,
    }
}

#[test]
fn plain_text_is_one_line_per_paragraph() {
    let d = paragraphs("第一段\n\nthird\u{2028}line");
    assert_eq!(plain_text(&d.view()), "第一段\n\nthird\u{2028}line");
    let empty = paragraphs("");
    assert_eq!(plain_text(&empty.view()), "");
}

#[test]
fn embeds_read_as_their_text() {
    let tbl = EmbedId::parse("t1").unwrap();
    let mat = EmbedId::parse("m1").unwrap();
    let d = prose(|t| {
        t.insert_paragraphs(0, "前文\n后文")?;
        let w = t.insert_embed(3, &tbl, &EmbedKind::Table)?;
        w.add_col("c0", &PosKey::first())?;
        w.add_col("c1", &PosKey::first().after())?;
        w.add_row("r0", &PosKey::first())?;
        w.add_row("r1", &PosKey::first().after())?;
        w.set_cell("r0", "c0", "甲")?;
        w.set_cell("r0", "c1", "乙")?;
        w.set_cell("r1", "c1", "丁")?;
        t.insert_embed(
            0,
            &mat,
            &EmbedKind::Material(MaterialId::parse("mat").unwrap()),
        )?;
        Ok(())
    });
    let v = d.view();
    let texts: Vec<String> = v.paragraphs().map(|p| block_text(&v, &p)).collect();
    assert_eq!(texts, vec!["", "前文", "甲\t乙\u{2028}\t丁", "后文"]);
    // The placeholder itself never reaches plain text.
    assert!(!plain_text(&v).contains('\u{FFFC}'));
}

#[test]
fn metrics_add_up_and_split_words_count_once() {
    let d = prose(|t| {
        t.insert_paragraphs(0, "hello world\n她叫安娜。")?;
        // hel**lo**: the 0.1 client counted this as two words.
        t.set_style(3..5, &InlineStyle::Bold)
    });
    let v = d.view();
    let mut total = TextMetrics::default();
    for p in v.paragraphs() {
        total += text_metrics(&block_text(&v, &p));
    }
    assert_eq!(
        total,
        TextMetrics {
            words: 6,
            chars: 16
        }
    );
    assert_eq!(count_words(&plain_text(&v)), total.words);
}

#[test]
fn outline_lists_the_three_levels_alike() {
    let d = prose(|t| {
        t.insert_paragraphs(0, "序\n  一  \n正文\n正文\n \n二\n三\n正文")?;
        t.set_heading(2, Some(Heading::H1))?; // "  一  "
        t.set_heading(14, Some(Heading::H2))?; // " " (empty after trim)
        t.set_heading(16, Some(Heading::H2))?; // 二
        t.set_heading(18, Some(Heading::H3)) // 三
    });
    let items = outline(&d.view());
    let got: Vec<(usize, Heading, &str, usize)> = items
        .iter()
        .map(|i| (i.ord, i.heading, i.text.as_str(), i.paragraphs_after))
        .collect();
    assert_eq!(
        got,
        vec![
            (1, Heading::H1, "一", 2),
            (5, Heading::H2, "二", 0),
            (6, Heading::H3, "三", 1),
        ]
    );
    assert!(items.iter().all(|i| i.block_id.is_some()));
}

fn names(list: &[(&str, &str)]) -> LinkMatcher<String> {
    LinkMatcher::new(list.iter().map(|(n, t)| LinkName::new(*n, t.to_string())))
}

fn found(m: &LinkMatcher<String>, text: &str) -> Vec<(usize, usize, String)> {
    m.find(text)
        .into_iter()
        .map(|x| (x.range.start, x.range.end, m.target(&x).clone()))
        .collect()
}

#[test]
fn matcher_is_leftmost_longest_verbatim_and_non_overlapping() {
    // The 0.1 client's own cases (entity_link_tests.rs), in scalar offsets.
    let m = names(&[("山", "short"), ("远山", "long"), ("A+B", "literal")]);
    assert_eq!(
        found(&m, "远山 A+B 山"),
        vec![
            (0, 2, "long".into()),
            (3, 6, "literal".into()),
            (7, 8, "short".into())
        ]
    );
    let m = names(&[("Mira", "m")]);
    assert_eq!(
        found(&m, "🙂Miranda mira Mira"),
        vec![(1, 5, "m".into()), (14, 18, "m".into())]
    );
    // Overlapping candidates: the leftmost wins, then the longest there.
    let m = names(&[
        ("安娜·卡列尼娜", "anna"),
        ("卡列尼娜", "karenina"),
        ("娜·卡", "x"),
    ]);
    assert_eq!(
        found(&m, "安娜·卡列尼娜和卡列尼娜"),
        vec![(0, 7, "anna".into()), (8, 12, "karenina".into())]
    );
    assert_eq!(found(&m, "娜·卡列尼娜"), vec![(0, 3, "x".into())]);
}

#[test]
fn matcher_names_are_trimmed_and_later_targets_win() {
    let m = names(&[
        ("灯塔", "first"),
        ("  ", "blank"),
        ("", "empty"),
        (" 灯塔 ", "chapter"),
        ("北塔", "tower"),
    ]);
    assert_eq!(m.names().len(), 2);
    assert_eq!(
        found(&m, "灯塔北塔"),
        vec![(0, 2, "chapter".into()), (2, 4, "tower".into())]
    );
    let none: LinkMatcher<String> = LinkMatcher::new([]);
    assert!(none.find("anything").is_empty());
}

#[test]
fn suggestions_skip_what_is_linked_already() {
    let d = prose(|t| {
        t.insert_paragraphs(0, "林凯在北塔等信\n北塔的灯，林凯")?;
        t.link_entity(0..2, &link("hero"))?; // 林凯 linked
        t.link_entity(3..4, &link("tower"))?; // only 北 of 北塔
        t.set_style(9..10, &InlineStyle::Bold) // 塔 of the second 北塔, bold
    });
    let m = LinkMatcher::new([
        LinkName::new("林凯", LinkTarget::new(EntityKind::Element, "hero")),
        LinkName::new("北塔", LinkTarget::new(EntityKind::Element, "tower")),
    ]);
    let got: Vec<(std::ops::Range<usize>, String)> = m
        .suggest(&d.view())
        .into_iter()
        .map(|s| (s.range, s.target.id))
        .collect();
    assert_eq!(
        got,
        vec![
            (3..5, "tower".into()),
            (8..10, "tower".into()),
            (13..15, "hero".into())
        ]
    );
    // A link to another target on the same text does not stop a suggestion.
    let other = LinkMatcher::new([LinkName::new(
        "林凯",
        LinkTarget::new(EntityKind::Node, "chapter-2"),
    )]);
    assert_eq!(other.suggest(&d.view()).len(), 2);
}

fn book_with(f: impl FnOnce(&mut BookTxn<'_>) -> dr_doc::Result<()>) -> BookDoc {
    let mut b = BookDoc::create(BookId::parse("b1").unwrap(), 9).unwrap();
    let (r, _) = b.edit(Origin::User, f);
    r.unwrap();
    b
}

#[test]
fn book_names_follow_the_old_priorities_and_respect_conflicts() {
    let e = |s: &str| ElementId::parse(s).unwrap();
    let n = |s: &str| NodeId::parse(s).unwrap();
    let b = book_with(|t| {
        t.element(&e("anna"))?
            .name("安娜")?
            .created_at(Some(Timestamp(10)))?
            .add_alias("小安")?;
        // A merge left two elements called 安娜; the later one also has a
        // unique alias.
        t.element(&e("anna2"))?
            .name("安娜")?
            .created_at(Some(Timestamp(20)))?
            .add_alias("安二")?;
        t.element(&e("gone"))?
            .name("旧人")?
            .deleted_at(Some(Timestamp(30)))?;
        t.element(&e("tower"))?.name("北塔")?;
        // A chapter titled like an element takes the name.
        t.node(&n("c1"))?
            .kind(&NodeKind::Chapter)?
            .title("北塔")?
            .book_order(Some(1.0))?;
        t.node(&n("c2"))?
            .kind(&NodeKind::Chapter)?
            .title("尾声")?
            .book_order(Some(2.0))?;
        t.node(&n("i1"))?
            .kind(&NodeKind::Drift)?
            .title("一个构想")?;
        Ok(())
    });
    let names = book_link_names(&b.view(), &["c2"]);
    let m = LinkMatcher::new(names);
    let targets = |text: &str| -> Vec<String> {
        m.find(text)
            .iter()
            .map(|x| format!("{}:{}", m.target(x).kind.as_str(), m.target(x).id))
            .collect()
    };
    assert_eq!(
        targets("安娜、小安、安二、旧人、北塔、尾声、一个构想"),
        vec![
            "element:anna",
            "element:anna",
            "element:anna2",
            "node:c1",
            "node:i1"
        ]
    );
}

mod properties {
    use proptest::prelude::*;

    use crate::*;

    /// The 0.1 matcher (`detect` in `entity_links.rs`), over scalars: at each
    /// position try the names longest first; on a match jump past it.
    fn reference(text: &[char], names: &[Vec<char>]) -> Vec<(usize, usize, usize)> {
        let mut order: Vec<usize> = (0..names.len()).collect();
        order.sort_by(|a, b| names[*b].len().cmp(&names[*a].len()));
        let mut out = Vec::new();
        let mut at = 0;
        while at < text.len() {
            match order.iter().find(|&&i| text[at..].starts_with(&names[i])) {
                Some(&i) => {
                    out.push((at, at + names[i].len(), i));
                    at += names[i].len();
                }
                None => at += 1,
            }
        }
        out
    }

    proptest! {
        #[test]
        fn matcher_agrees_with_the_old_scan(
            names in proptest::collection::btree_set("[安娜卡列a-c🙂]{1,4}", 1..8),
            text in "[安娜卡列a-c🙂 ]{0,40}",
        ) {
            let names: Vec<String> = names.into_iter().collect();
            let m = LinkMatcher::new(names.iter().enumerate().map(|(i, n)| LinkName::new(n.clone(), i)));
            let got: Vec<(usize, usize, usize)> = m
                .find(&text)
                .iter()
                .map(|x| (x.range.start, x.range.end, *m.target(x)))
                .collect();
            let chars: Vec<char> = text.chars().collect();
            let pats: Vec<Vec<char>> = names.iter().map(|n| n.chars().collect()).collect();
            prop_assert_eq!(got, reference(&chars, &pats));
        }
    }
}

#[test]
fn live_counts_follow_the_editor_paragraph_by_paragraph() {
    let d = prose(|t| {
        t.insert_paragraphs(0, "安娜走了\nHello world\n")?;
        let at = t.view().paragraph_start(t.view().len() - 1);
        let w = t.insert_embed(at, &EmbedId::parse("t1").unwrap(), &EmbedKind::Table)?;
        w.add_col("c0", &PosKey::first())?;
        w.add_row("r0", &PosKey::first())?;
        w.set_cell("r0", "c0", "格子里")
    });
    let mut live = LiveCount::from_view(&d.view());
    // As the index counts it: the table by its cells.
    let mut want = TextMetrics::default();
    for p in d.view().paragraphs() {
        want += text_metrics(&block_text(&d.view(), &p));
    }
    assert_eq!(live.total(), want);
    assert_eq!(live.total().words, 4 + 2 + 3);

    // The editor's lines: typing in the first, Enter in the second.
    let mut lines = vec![
        "安娜走了。".to_string(),
        "Hello".to_string(),
        " world".to_string(),
        "\u{FFFC}".to_string(),
    ];
    live.splice(0, 1, 1);
    live.splice(1, 1, 2);
    assert!(!live.is_current());
    // The table's line is not asked for: its count did not change.
    let mut asked = Vec::new();
    live.recount(|i| {
        asked.push(i);
        lines[i].clone()
    });
    assert_eq!(asked, vec![0, 1, 2]);
    assert_eq!(live.total().words, 4 + 2 + 3);
    assert_eq!(live.total().chars, 5 + 5 + 6 + 3);
    // Deleting a paragraph needs no recount.
    lines.remove(2);
    live.splice(2, 1, 0);
    assert!(live.is_current());
    assert_eq!(live.total().words, 4 + 1 + 3);
    // A placeholder in a line is no character (paragraph_text drops it).
    assert_eq!(paragraph_metrics("ab\u{FFFC}cd").chars, 4);
    assert_eq!(paragraph_metrics("ab\u{FFFC}cd").words, 1);

    // The book from the index, with the open chapter's live count.
    let book = TextMetrics {
        words: 1000,
        chars: 2000,
    };
    let indexed = TextMetrics {
        words: 9,
        chars: 22,
    };
    assert_eq!(
        with_live(book, indexed, live.total()),
        TextMetrics {
            words: 1000 - 9 + 8,
            chars: 2000 - 22 + live.total().chars
        }
    );
}

mod live_splices {
    use proptest::prelude::*;

    use crate::{LiveCount, TextMetrics, paragraph_metrics};

    const POOL: &[&str] = &["安娜", "Hello", " ", "，", "a b c", "\u{FFFC}", ""];

    proptest! {
        /// Any splices, then a recount from the lines: the same total as
        /// counting the lines afresh.
        #[test]
        fn splices_and_a_recount_give_a_fresh_count(
            start in proptest::collection::vec(0..POOL.len(), 0..20),
            edits in proptest::collection::vec((0usize..30, 0usize..4, proptest::collection::vec(0..POOL.len(), 0..4)), 1..10),
        ) {
            let mut lines: Vec<String> = start.iter().map(|i| POOL[*i].to_string()).collect();
            let mut live = LiveCount::new(&lines);
            for (at, removed, inserted) in &edits {
                let at = (*at).min(lines.len());
                let end = (at + removed).min(lines.len());
                lines.splice(at..end, inserted.iter().map(|i| POOL[*i].to_string()));
                live.splice(at, *removed, inserted.len());
            }
            live.recount(|i| lines[i].clone());
            let mut want = TextMetrics::default();
            for l in &lines {
                want += paragraph_metrics(l);
            }
            prop_assert_eq!(live.total(), want);
            prop_assert_eq!(live.len(), lines.len());
        }
    }
}
