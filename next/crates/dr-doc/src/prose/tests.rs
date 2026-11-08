//! Prose document behaviour (ported from the P0-C spike's `model.rs`, plus the
//! typed API's own guarantees).

use std::sync::{Arc, Mutex};

use dr_model::id::{BlockId, CommentId, EmbedId, MaterialId};
use dr_model::kind::{EntityKind, ListKind};
use dr_model::pos::PosKey;
use dr_model::prose::{BlockAttrs, EntityLink, Heading, InlineMarks, InlineStyle};
use dr_model::{DocId, Origin};

use super::*;
use crate::anchor::{Anchor, AnchorCache};
use crate::pos::{PosError, TextPos, Unit};

fn node(id: &str) -> DocId {
    DocId::parse(&format!("node:{id}")).unwrap()
}

fn doc(id: &str, peer: u64) -> ProseDoc {
    ProseDoc::create(node(id), peer).unwrap()
}

fn user<R>(d: &mut ProseDoc, f: impl FnOnce(&mut ProseTxn<'_>) -> Result<R>) -> R {
    let (r, _) = d.edit(Origin::User, f);
    r.unwrap()
}

fn sync(from: &ProseDoc, to: &mut ProseDoc) {
    let bytes = from.export_updates_since(&to.version()).unwrap();
    to.import(&bytes, Origin::Sync).unwrap();
}

fn ids(d: &ProseDoc) -> Vec<BlockId> {
    d.view().paragraphs().map(|p| p.id.unwrap()).collect()
}

fn texts(d: &ProseDoc) -> Vec<String> {
    d.view().paragraphs().map(|p| p.text()).collect()
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
fn genesis_is_deterministic_and_concurrent_init_merges() {
    assert_eq!(genesis(&node("x")), genesis(&node("x")));
    assert_ne!(genesis(&node("x")), genesis(&node("y")));
    let mut a = doc("x", 1);
    let mut b = doc("x", 2);
    user(&mut a, |t| t.insert_text(0, "甲"));
    user(&mut b, |t| t.insert_text(0, "乙"));
    sync(&a, &mut b);
    sync(&b, &mut a);
    assert_eq!(a.view().plain_text(), b.view().plain_text());
    assert_eq!(a.view().paragraph_count(), 1, "one paragraph, not two");
    assert!(a.view().plain_text().ends_with('\n'));
}

#[test]
fn enter_keeps_block_ids_with_the_text() {
    let mut p = doc("t", 7);
    user(&mut p, |t| t.insert_text(0, "第一段"));
    let first = ids(&p)[0].clone();
    let caret = user(&mut p, |t| t.split(3));
    assert_eq!(caret, 4);
    user(&mut p, |t| t.insert_text(caret, "第二段"));
    let after = ids(&p);
    assert_eq!(after[0], first);
    assert_eq!(texts(&p), vec!["第一段", "第二段"]);
    let second = after[1].clone();
    user(&mut p, |t| t.split(6));
    assert_eq!(texts(&p), vec!["第一段", "第二", "段"]);
    let ids3 = ids(&p);
    assert_eq!(ids3[0], first);
    assert_eq!(ids3[2], second);
    assert_ne!(ids3[1], second);
    user(&mut p, |t| t.split(0));
    assert_eq!(texts(&p), vec!["", "第一段", "第二", "段"]);
    assert_eq!(ids(&p)[1], first);
    assert_eq!(user(&mut p, |t| t.repair_block_ids()), 0);
}

#[test]
fn split_carries_heading_only_in_the_middle() {
    let mut p = doc("h", 7);
    user(&mut p, |t| {
        t.insert_text(0, "标题文字")?;
        t.set_heading(0, Some(Heading::H2))?;
        t.split(4)
    });
    let ps: Vec<_> = p.view().paragraphs().collect();
    assert_eq!(ps[0].attrs.heading, Some(Heading::H2));
    assert_eq!(ps[1].attrs.heading, None);
    user(&mut p, |t| t.split(2));
    let ps: Vec<_> = p.view().paragraphs().collect();
    assert_eq!(texts(&p), vec!["标题", "文字", ""]);
    assert_eq!(ps[0].attrs.heading, Some(Heading::H2));
    assert_eq!(ps[1].attrs.heading, Some(Heading::H2));
}

#[test]
fn merging_keeps_the_first_paragraph() {
    let mut p = doc("m", 7);
    user(&mut p, |t| {
        t.insert_text(0, "甲甲")?;
        t.set_heading(0, Some(Heading::H1))?;
        let c = t.split(2)?;
        t.insert_text(c, "乙乙")?;
        let c = t.split(c + 2)?;
        t.insert_text(c, "丙丙")
    });
    let before = ids(&p);
    assert_eq!(texts(&p), vec!["甲甲", "乙乙", "丙丙"]);
    user(&mut p, |t| t.delete(2..3));
    assert_eq!(texts(&p), vec!["甲甲乙乙", "丙丙"]);
    let ps: Vec<_> = p.view().paragraphs().collect();
    assert_eq!(ps[0].id.as_ref(), Some(&before[0]));
    assert_eq!(ps[0].attrs.heading, Some(Heading::H1));
    assert_eq!(ps[1].id.as_ref(), Some(&before[2]));
    user(&mut p, |t| t.delete(3..6));
    assert_eq!(texts(&p), vec!["甲甲乙丙"]);
    let ps: Vec<_> = p.view().paragraphs().collect();
    assert_eq!(ps[0].id.as_ref(), Some(&before[0]));
    assert_eq!(ps[0].attrs.heading, Some(Heading::H1));
}

#[test]
fn deleting_whole_paragraphs_keeps_the_next_one() {
    let mut p = doc("w", 7);
    user(&mut p, |t| {
        let c = t.split(0)?;
        t.insert_text(c, "正文")?;
        t.set_heading(c, Some(Heading::H3))
    });
    let before = ids(&p);
    user(&mut p, |t| t.delete(0..1));
    assert_eq!(texts(&p), vec!["正文"]);
    let ps: Vec<_> = p.view().paragraphs().collect();
    assert_eq!(ps[0].id.as_ref(), Some(&before[1]));
    assert_eq!(ps[0].attrs.heading, Some(Heading::H3));
}

#[test]
fn the_final_newline_cannot_be_removed() {
    let mut p = doc("f", 7);
    user(&mut p, |t| t.insert_text(0, "甲"));
    let len = p.view().len();
    user(&mut p, |t| t.delete(0..len));
    assert_eq!(p.view().plain_text(), "\n");
    assert_eq!(p.view().paragraph_count(), 1);
    // Inserting after the final newline is refused.
    let (r, c) = p.edit(Origin::User, |t| t.insert_text(1, "x"));
    assert!(matches!(r, Err(DocError::BadRange { .. })));
    assert!(c.is_none());
    let (r, _) = p.edit(Origin::User, |t| t.insert_text(0, "a\nb"));
    assert!(matches!(r, Err(DocError::NewlineInText)));
    let (r, _) = p.edit(Origin::User, |t| t.insert_text(0, "\u{FFFC}"));
    assert!(matches!(r, Err(DocError::ObjectCharInText)));
}

#[test]
fn pasted_paragraphs_get_fresh_ids() {
    let mut p = doc("paste", 7);
    let caret = user(&mut p, |t| t.insert_paragraphs(0, "一\n二\n三"));
    assert_eq!(caret, 5);
    assert_eq!(texts(&p), vec!["一", "二", "三"]);
    let v = ids(&p);
    assert_eq!(v.len(), 3);
    assert!(v[0] != v[1] && v[1] != v[2] && v[0] != v[2]);
}

#[test]
fn undo_of_a_merge_restores_both_ids() {
    let mut p = doc("u", 7);
    user(&mut p, |t| {
        t.insert_text(0, "甲")?;
        let c = t.split(1)?;
        t.insert_text(c, "乙")
    });
    let before = ids(&p);
    let mut um = p.undo_manager();
    user(&mut p, |t| t.delete(1..2));
    assert_eq!(texts(&p), vec!["甲乙"]);
    let c = um.undo(&mut p).unwrap();
    assert!(c.is_some(), "an undo is a local write storage must persist");
    assert_eq!(c.unwrap().origin, Origin::User);
    assert_eq!(texts(&p), vec!["甲", "乙"]);
    assert_eq!(ids(&p), before);
}

#[test]
fn author_undo_never_removes_agent_or_sync_text() {
    let mut p = doc("ua", 7);
    let mut q = doc("ua", 8);
    let mut um = p.undo_manager();
    user(&mut p, |t| t.insert_text(0, "作者"));
    let (_, c) = p.edit(Origin::agent("s1", 1), |t| t.insert_text(0, "【A】"));
    assert_eq!(c.unwrap().origin, Origin::agent("s1", 1));
    user(&mut q, |t| t.insert_text(0, "远端"));
    sync(&q, &mut p);
    user(&mut p, |t| t.insert_text(0, "再写"));
    while um.can_undo() {
        um.undo(&mut p).unwrap();
    }
    let s = p.view().plain_text();
    assert!(s.contains("【A】") && s.contains("远端"), "{s}");
    assert!(!s.contains("作者") && !s.contains("再写"), "{s}");
}

#[test]
fn concurrent_splits_never_duplicate_ids() {
    let mut a = doc("c", 1);
    user(&mut a, |t| t.insert_text(0, "一二三四五六"));
    let mut b = doc("c", 2);
    sync(&a, &mut b);
    user(&mut a, |t| t.split(2));
    user(&mut b, |t| t.split(4));
    sync(&a, &mut b);
    sync(&b, &mut a);
    assert_eq!(texts(&a), vec!["一二", "三四", "五六"]);
    assert_eq!(user(&mut a, |t| t.repair_block_ids()), 0);
    assert_eq!(ids(&a), ids(&b));
}

#[test]
fn concurrent_enter_at_one_end_converges_with_unique_ids() {
    // Both devices press Enter at the end of the same paragraph, or one
    // presses Enter there while the other joins it with the next paragraph:
    // each moves the paragraph's id onto a different newline, so the merge
    // can hold it twice. (Whether it does depends on how Loro orders the
    // concurrent marks; P0-C saw it in 818 of 3000 random cases.) Readers
    // keep the first; import repairs it, identically on both devices.
    let mut repaired = 0;
    for (pa, pb) in [(1, 2), (2, 1), (5, 3), (3, 5), (11, 400), (400, 11)] {
        for join in [false, true] {
            let mut a = doc("dup", pa);
            user(&mut a, |t| {
                t.insert_text(0, "段落")?;
                let c = t.split(2)?;
                t.insert_text(c, "下段")
            });
            let mut b = doc("dup", pb);
            sync(&a, &mut b);
            user(&mut a, |t| {
                let c = t.split(2)?;
                t.insert_text(c, "甲")
            });
            user(&mut b, |t| {
                if join {
                    t.delete(2..3)
                } else {
                    let c = t.split(2)?;
                    t.insert_text(c, "乙")
                }
            });
            let a_bytes = a.export_updates_since(&b.version()).unwrap();
            let b_bytes = b.export_updates_since(&a.version()).unwrap();
            let ra = a.import(&b_bytes, Origin::Sync).unwrap();
            let rb = b.import(&a_bytes, Origin::Sync).unwrap();
            repaired += ra.repair.is_some() as usize + rb.repair.is_some() as usize;
            sync(&a, &mut b);
            sync(&b, &mut a);
            assert_eq!(a.view().plain_text(), b.view().plain_text());
            assert_eq!(ids(&a), ids(&b), "peers {pa}/{pb} join={join}");
            let v = ids(&a);
            let unique: std::collections::HashSet<_> = v.iter().collect();
            assert_eq!(unique.len(), v.len());
            assert_eq!(user(&mut a, |t| t.repair_block_ids()), 0);
        }
    }
    assert!(repaired > 0, "some variant needed the repair");
}

#[test]
fn readers_hide_later_duplicates_until_repair() {
    let mut a = doc("r", 1);
    user(&mut a, |t| {
        t.insert_text(0, "甲")?;
        let c = t.split(1)?;
        t.insert_text(c, "乙")
    });
    let dup = ids(&a)[0].clone();
    // Write a duplicate directly (as a paste without id refresh would).
    let nl = a.view().len() - 1;
    user(&mut a, |t| t.set_block_id(nl, Some(&dup)));
    let ps: Vec<_> = a.view().paragraphs().collect();
    assert_eq!(ps[0].id.as_ref(), Some(&dup));
    assert_eq!(ps[1].id, None);
    assert_eq!(ps[1].stored_id.as_ref(), Some(&dup));
    assert_eq!(a.view().paragraph_at(nl).unwrap().id, None);
    assert_eq!(a.view().paragraph_by_id(&dup).unwrap().text(), "甲");
    let mut b = doc("r", 2);
    sync(&a, &mut b); // import repairs on b
    let fixed = a.repair().unwrap();
    assert!(fixed.is_some());
    sync(&a, &mut b);
    sync(&b, &mut a);
    assert_eq!(ids(&a), ids(&b));
    assert_eq!(user(&mut a, |t| t.repair_block_ids()), 0);
}

#[test]
fn anchors_exclude_edge_typing_and_collapse_on_delete() {
    let mut p = doc("a", 7);
    user(&mut p, |t| t.insert_text(0, "零一二三四五六七八九"));
    let a = p.view().anchor(3..6).unwrap();
    let r = p.view().resolve(&a).unwrap();
    assert_eq!(
        (r.range.clone(), r.collapsed, r.updated.is_none()),
        (3..6, false, true)
    );
    user(&mut p, |t| {
        t.insert_text(6, "后")?;
        t.insert_text(3, "前")
    });
    let r = p.view().resolve(&a).unwrap();
    assert_eq!(p.view().text_in(r.range).unwrap(), "三四五");
    user(&mut p, |t| t.insert_text(5, "中"));
    let r = p.view().resolve(&a).unwrap();
    assert_eq!(p.view().text_in(r.range).unwrap(), "三中四五");
    user(&mut p, |t| t.delete(7..8));
    let r = p.view().resolve(&a).unwrap();
    assert_eq!(p.view().text_in(r.range.clone()).unwrap(), "三中四");
    let a = r.updated.unwrap();
    user(&mut p, |t| t.delete(4..7));
    let r = p.view().resolve(&a).unwrap();
    assert!(r.collapsed);
    assert_eq!(r.range, 4..4);
    let point = r.updated.unwrap();
    assert!(point.is_point());
    user(&mut p, |t| t.insert_text(0, "头"));
    assert_eq!(p.view().resolve(&point).unwrap().range, 5..5);
}

#[test]
fn anchor_does_not_come_back_after_undo() {
    let mut p = doc("au", 7);
    user(&mut p, |t| t.insert_text(0, "零一二三四五"));
    let a = p.view().anchor(2..4).unwrap();
    let mut um = p.undo_manager();
    user(&mut p, |t| t.delete(1..5));
    um.undo(&mut p).unwrap();
    assert_eq!(p.view().plain_text(), "零一二三四五\n");
    assert!(p.view().resolve(&a).unwrap().collapsed);
}

#[test]
fn anchors_survive_merge_and_encoding() {
    let mut a = doc("as", 1);
    user(&mut a, |t| t.insert_text(0, "甲乙丙丁戊己"));
    let mut b = doc("as", 2);
    sync(&a, &mut b);
    let anchor = Anchor::decode(&a.view().anchor(1..4).unwrap().encode()).unwrap();
    user(&mut b, |t| t.insert_text(2, "插"));
    user(&mut a, |t| t.insert_text(0, "前"));
    sync(&b, &mut a);
    sync(&a, &mut b);
    let ra = a.view().resolve(&anchor).unwrap();
    let rb = b.view().resolve(&anchor).unwrap();
    assert_eq!(ra, rb);
    assert_eq!(a.view().text_in(ra.range).unwrap(), "乙插丙丁");
}

#[test]
fn anchor_cache_keeps_the_replacement_locally() {
    let mut p = doc("ac", 7);
    user(&mut p, |t| t.insert_text(0, "零一二三四五"));
    let stored = p.view().anchor(1..4).unwrap();
    let mut cache = AnchorCache::new();
    assert!(
        cache
            .resolve("c1", &stored, &p.view())
            .unwrap()
            .updated
            .is_none()
    );
    assert!(cache.is_empty());
    user(&mut p, |t| t.delete(1..2));
    let r = cache.resolve("c1", &stored, &p.view()).unwrap();
    assert_eq!(p.view().text_in(r.range.clone()).unwrap(), "二三");
    assert_eq!(cache.len(), 1);
    // The next query uses the cached replacement: no replay, same answer.
    let r2 = cache.resolve("c1", &stored, &p.view()).unwrap();
    assert_eq!(r2.range, r.range);
    assert!(r2.updated.is_none());
    let mut other = AnchorCache::new();
    other.import(cache.export());
    assert_eq!(other.get("c1"), cache.get("c1"));
}

#[test]
fn resolving_a_deleted_anchor_inside_an_agent_write_keeps_its_origin() {
    // Resolving a cursor on deleted text commits implicitly behind a barrier.
    // The transaction sets its options up front, so that implicit commit is
    // still an Agent commit and the author's Undo does not take it.
    let mut p = doc("bar", 7);
    user(&mut p, |t| t.insert_text(0, "零一二三四五"));
    let a = p.view().anchor(1..3).unwrap();
    let mut um = p.undo_manager();
    user(&mut p, |t| t.delete(1..3));
    let (r, c) = p.edit(Origin::agent("s", 1), |t| {
        t.insert_text(0, "甲")?;
        let r = t.view().resolve(&a).expect("resolves");
        t.insert_text(r.range.start + 1, "乙")?;
        Ok(r)
    });
    assert!(r.unwrap().collapsed);
    assert!(c.is_some());
    um.undo(&mut p).unwrap(); // undoes the author's delete only
    let s = p.view().plain_text();
    assert!(s.contains('甲') && s.contains('乙'), "{s}");
    assert!(s.contains("一二"), "{s}");
}

#[test]
fn entity_links_overlap_and_do_not_expand() {
    let mut p = doc("l", 7);
    user(&mut p, |t| {
        t.insert_text(0, "安娜卡列尼娜来了")?;
        t.link_entity(0..6, &link("el-anna"))?;
        t.link_entity(2..6, &link("el-karenina"))
    });
    let targets = |p: &ProseDoc| -> Vec<(std::ops::Range<usize>, String)> {
        p.view()
            .entity_links()
            .into_iter()
            .map(|(r, l)| (r, l.target))
            .collect()
    };
    assert_eq!(
        targets(&p),
        vec![(0..6, "el-anna".into()), (2..6, "el-karenina".into())]
    );
    user(&mut p, |t| {
        t.insert_text(6, "啊")?;
        t.insert_text(0, "看")
    });
    assert_eq!(
        targets(&p),
        vec![(1..7, "el-anna".into()), (3..7, "el-karenina".into())]
    );
    user(&mut p, |t| t.insert_text(2, "·"));
    assert_eq!(targets(&p)[0], (1..8, "el-anna".into()));
    user(&mut p, |t| t.split(5));
    for para in p.view().paragraphs() {
        assert!(para.attrs.is_plain());
    }
    let len = p.view().len();
    user(&mut p, |t| t.unlink_entity(0..len, "el-karenina"));
    assert!(targets(&p).iter().all(|(_, t)| t == "el-anna"));
    // Runs carry the typed link.
    let para = p.view().paragraphs().next().unwrap();
    assert!(
        para.runs
            .iter()
            .any(|r| r.marks.entities.iter().any(|l| l.target == "el-anna"))
    );
    // A link to a patch is not an entity link.
    let (r, _) = p.edit(Origin::User, |t| {
        t.link_entity(
            0..1,
            &EntityLink {
                target: "p".into(),
                kind: EntityKind::Patch,
                block: None,
                end_block: None,
            },
        )
    });
    assert!(r.is_err());
}

#[test]
fn inline_styles_skip_newlines_and_respect_the_profile() {
    let mut p = doc("s", 7);
    user(&mut p, |t| {
        t.insert_paragraphs(0, "甲乙\n丙丁")?;
        t.set_style(1..4, &InlineStyle::Bold)
    });
    let ps: Vec<_> = p.view().paragraphs().collect();
    assert!(ps[0].attrs.is_plain() && ps[1].attrs.is_plain());
    assert!(ps[0].runs[1].marks.bold && ps[1].runs[0].marks.bold);
    assert!(!ps[0].runs[0].marks.bold);
    // Bold continues after bold (ExpandType::After).
    user(&mut p, |t| t.insert_text(2, "续"));
    let ps: Vec<_> = p.view().paragraphs().collect();
    assert_eq!(ps[0].runs[1].text, "乙续");
    user(&mut p, |t| t.clear_style(0..p_len(t), StyleKey::Bold));
    assert!(
        p.view()
            .paragraphs()
            .all(|p| p.runs.iter().all(|r| !r.marks.bold))
    );
    // Highlight is a note-profile mark; lists are note-profile attributes.
    let (r, _) = p.edit(Origin::User, |t| {
        t.set_style(0..1, &InlineStyle::Highlight("yellow".into()))
    });
    assert!(matches!(r, Err(DocError::NotInProfile(_))));
    let list = BlockAttrs {
        list: Some(ListKind::Bullet),
        ..BlockAttrs::default()
    };
    let (r, _) = p.edit(Origin::User, |t| t.set_block_attrs(0, &list));
    assert!(matches!(r, Err(DocError::NotInProfile(_))));
    let mut note = ProseDoc::create(DocId::parse("material:n").unwrap(), 7).unwrap();
    assert_eq!(note.profile(), ProseProfile::Note);
    let task = BlockAttrs {
        list: Some(ListKind::Task),
        todo: Some(CommentId::parse("todo-1").unwrap()),
        ..BlockAttrs::default()
    };
    user(&mut note, |t| {
        t.insert_text(0, "买书")?;
        t.set_block_attrs(0, &task)?;
        t.set_style(0..2, &InlineStyle::Highlight("yellow".into()))
    });
    let para = note.view().paragraphs().next().unwrap();
    assert_eq!(para.attrs, task);
    assert_eq!(para.runs[0].marks.highlight.as_deref(), Some("yellow"));
}

fn p_len(t: &ProseTxn<'_>) -> usize {
    t.view().len()
}

#[test]
fn block_attrs_round_trip_and_stay_on_the_newline() {
    let mut p = doc("b", 7);
    let attrs = BlockAttrs {
        heading: Some(Heading::H1),
        quote: true,
        indent: 8,
        align: dr_model::prose::Align::Right,
        ..BlockAttrs::default()
    };
    user(&mut p, |t| {
        t.insert_text(0, "引文")?;
        t.set_block_attrs(1, &attrs)
    });
    let id = ids(&p)[0].clone();
    let para = p.view().paragraphs().next().unwrap();
    assert_eq!(para.attrs, attrs);
    assert_eq!(para.id.as_ref(), Some(&id), "set_block_attrs keeps the id");
    assert!(para.runs.iter().all(|r| r.marks.is_plain()));
}

#[test]
fn embeds_are_placeholders_with_side_entries() {
    let mut p = ProseDoc::create(DocId::parse("material:e").unwrap(), 7).unwrap();
    let tbl = EmbedId::parse("tbl-1").unwrap();
    user(&mut p, |t| {
        t.insert_text(0, "前文")?;
        let c = t.split(2)?;
        t.insert_text(c, "后文")?;
        let w = t.insert_embed(c, &tbl, &EmbedKind::Table)?;
        w.add_col("c0", &PosKey::first())?;
        w.add_row("r0", &PosKey::first())?;
        w.set_cell("r0", "c0", "格子")
    });
    assert_eq!(texts(&p), vec!["前文", "\u{FFFC}", "后文"]);
    assert_eq!(p.view().embed_refs(), vec![(3, tbl.clone())]);
    let para = p.view().paragraphs().nth(1).unwrap();
    assert_eq!(para.embed(), Some(&tbl));
    let mut q = ProseDoc::create(DocId::parse("material:e").unwrap(), 8).unwrap();
    sync(&p, &mut q);
    user(&mut q, |t| {
        let w = t.table(&tbl)?;
        w.add_row("r1", &PosKey::first().after())?;
        t.table(&tbl)?.cell("r1", "c0")?.insert(0, "乙")?;
        Ok(())
    });
    user(&mut p, |t| {
        let w = t.table(&tbl)?;
        w.add_row("r1", &PosKey::first().after())?;
        w.cell("r1", "c0")?.insert(0, "甲")?;
        Ok(())
    });
    sync(&q, &mut p);
    sync(&p, &mut q);
    let Some(EmbedView::Table { cells, rows, .. }) = p.view().embed(&tbl) else {
        panic!("table")
    };
    assert_eq!(rows.len(), 2);
    let v = &cells[&("r1".to_string(), "c0".to_string())];
    assert!(v == "甲乙" || v == "乙甲", "{v}");
    assert_eq!(cells[&("r0".to_string(), "c0".to_string())], "格子");
    let mut um = p.undo_manager();
    user(&mut p, |t| t.delete(3..5));
    assert!(p.view().embed_refs().is_empty());
    assert_eq!(p.view().orphan_embeds(), vec![tbl.clone()]);
    um.undo(&mut p).unwrap();
    assert_eq!(p.view().embed_refs(), vec![(3, tbl.clone())]);
    assert!(p.view().orphan_embeds().is_empty());
    let m = EmbedId::parse("m-1").unwrap();
    user(&mut p, |t| {
        t.insert_embed(
            0,
            &m,
            &EmbedKind::Material(MaterialId::parse("mat-9").unwrap()),
        )
        .map(|_| ())
    });
    assert!(matches!(
        p.view().embed(&m),
        Some(EmbedView::Material {
            material: Some(_),
            ..
        })
    ));
}

#[test]
fn agent_commits_carry_a_durable_message() {
    let mut p = doc("ag", 7);
    user(&mut p, |t| t.insert_text(0, "正文"));
    let origin = Origin::agent("sess", 3);
    let (_, c) = p.edit(origin.clone(), |t| t.insert_text(0, "甲"));
    let c = c.unwrap();
    assert_eq!(c.origin, origin);
    let cursor = p.view().cursor(0, loro::cursor::Side::Middle).unwrap();
    let id = cursor.id.unwrap();
    let msg = |d: &loro::LoroDoc| {
        d.get_change(id)
            .and_then(|m| m.message.as_ref().map(|s| s.to_string()))
    };
    assert_eq!(msg(&p.core().doc).as_deref(), Some("agent:sess/3"));
    // The message survives a snapshot round trip.
    let snap = p.export_snapshot().unwrap();
    let q = ProseDoc::load(node("ag"), 9, &[snap]).unwrap();
    assert_eq!(msg(&q.core().doc).as_deref(), Some("agent:sess/3"));
}

#[test]
fn commits_replay_into_the_same_document() {
    // What storage does: persist every Committed, load them back.
    let mut p = doc("st", 7);
    let mut log = Vec::new();
    for i in 0..20 {
        let (r, c) = p.edit(Origin::User, |t| {
            let end = t.view().len() - 1;
            if i % 5 == 4 {
                t.split(end).map(|_| ())
            } else {
                t.insert_text(end, &format!("字{i}"))
            }
        });
        r.unwrap();
        log.push(c.unwrap().update);
    }
    let q = ProseDoc::load(node("st"), 8, &log).unwrap();
    assert_eq!(q.view().plain_text(), p.view().plain_text());
    assert_eq!(ids(&q), ids(&p));
    // Snapshot plus later updates, given in any order.
    let snap = p.export_snapshot().unwrap();
    let v = p.version();
    user(&mut p, |t| t.insert_text(0, "后"));
    let tail = p.export_updates_since(&v).unwrap();
    let r = ProseDoc::load(node("st"), 8, &[tail, snap]).unwrap();
    assert_eq!(r.view().plain_text(), p.view().plain_text());
}

#[test]
fn a_failed_edit_still_commits_what_it_applied() {
    let mut p = doc("fail", 7);
    let (r, c) = p.edit(Origin::agent("s", 1), |t| {
        t.insert_text(0, "甲")?;
        t.insert_text(99, "乙")
    });
    assert!(r.is_err());
    let c = c.expect("the first insert is committed under the Agent origin");
    assert_eq!(c.origin, Origin::agent("s", 1));
    assert_eq!(p.view().plain_text(), "甲\n");
    // Nothing is left pending: the next user commit contains only its own op.
    let (_, c2) = p.edit(Origin::User, |t| t.insert_text(0, "丙"));
    let q = ProseDoc::load(node("fail"), 8, &[c.update]).unwrap();
    assert_eq!(q.view().plain_text(), "甲\n");
    let q2 = ProseDoc::load(node("fail"), 8, &[c2.unwrap().update]).unwrap();
    assert!(q2.view().plain_text().len() <= "丙甲\n".len());
}

#[test]
fn loading_bytes_of_another_document_fails() {
    let mut p = doc("one", 7);
    user(&mut p, |t| t.insert_text(0, "甲"));
    let snap = p.export_snapshot().unwrap();
    assert!(matches!(
        ProseDoc::load(node("two"), 7, &[snap]),
        Err(DocError::WrongDocument { .. })
    ));
    assert!(matches!(
        ProseDoc::create(node("x"), 0),
        Err(DocError::ReservedPeer(0))
    ));
    assert!(matches!(
        ProseDoc::create(node("x"), crate::peer::genesis_peer("node:x", 1)),
        Err(DocError::ReservedPeer(_))
    ));
    assert!(ProseDoc::create(DocId::parse("book:b").unwrap(), 7).is_err());
}

#[test]
fn positions_convert_across_the_whole_body() {
    let mut p = doc("pos", 7);
    user(&mut p, |t| {
        t.insert_text(0, "a中😀")?;
        let c = t.split(3)?;
        t.insert_text(c, "\u{20000}é")
    });
    let v = p.view();
    // "a中😀\n𠀀é\n"
    assert_eq!((v.len(), v.len_utf8(), v.len_utf16()), (7, 16, 9));
    let at = v.pos(Unit::Char, 4).unwrap();
    assert_eq!((at.utf8, at.utf16), (9, 5));
    assert_eq!(v.pos(Unit::Utf8, 9).unwrap(), at);
    assert_eq!(v.pos(Unit::Utf16, 5).unwrap(), at);
    assert_eq!(
        v.pos(Unit::Utf8, 2),
        Err(PosError::NotABoundary {
            unit: Unit::Utf8,
            value: 2
        })
    );
    assert_eq!(
        v.pos(Unit::Utf16, 3),
        Err(PosError::NotABoundary {
            unit: Unit::Utf16,
            value: 3
        })
    );
    assert!(matches!(
        v.pos(Unit::Char, 8),
        Err(PosError::OutOfRange { .. })
    ));
    // Paragraph-local and document-wide conversions agree.
    let para = v.paragraph_at(4).unwrap();
    let start = v.pos(Unit::Char, para.range.start).unwrap();
    let local = TextPos::in_str(&para.text(), Unit::Utf16, 2).unwrap();
    assert_eq!(
        v.pos(Unit::Utf16, start.utf16 + local.utf16).unwrap().chars,
        4 + 1
    );
}

#[test]
fn events_report_unicode_splices_and_origins() {
    let mut p = doc("ev", 7);
    let seen: Arc<Mutex<Vec<ProseEvent>>> = Default::default();
    let s2 = seen.clone();
    let _sub = p.subscribe(move |e| s2.lock().unwrap().push(e.clone()));
    user(&mut p, |t| t.insert_text(0, "😀中"));
    p.edit(Origin::agent("s", 2), |t| t.insert_text(2, "文"))
        .0
        .unwrap();
    user(&mut p, |t| t.delete(0..1));
    user(&mut p, |t| t.set_heading(0, Some(Heading::H2)));
    let ev = seen.lock().unwrap();
    assert_eq!(ev.len(), 4);
    assert_eq!(ev[0].trigger, Trigger::Local);
    assert_eq!(ev[0].origin, Some(Origin::User));
    assert_eq!(
        ev[0].splices(),
        vec![event::Splice {
            at: 0,
            deleted: 0,
            inserted: 2
        }]
    );
    assert_eq!(ev[1].origin, Some(Origin::agent("s", 2)));
    assert_eq!(
        ev[1].splices(),
        vec![event::Splice {
            at: 2,
            deleted: 0,
            inserted: 1
        }]
    );
    assert_eq!(
        ev[2].splices(),
        vec![event::Splice {
            at: 0,
            deleted: 1,
            inserted: 0
        }]
    );
    // "中文\n": the heading is a restyle of the newline at 2.
    assert!(ev[3].splices().is_empty());
    assert_eq!(ev[3].restyled(), vec![2..3]);
    drop(ev);
    // An import is reported with the importer's label.
    let mut q = doc("ev", 8);
    let seen_q: Arc<Mutex<Vec<ProseEvent>>> = Default::default();
    let s3 = seen_q.clone();
    let _sub_q = q.subscribe(move |e| s3.lock().unwrap().push(e.clone()));
    sync(&p, &mut q);
    let ev = seen_q.lock().unwrap();
    assert!(
        ev.iter()
            .any(|e| e.trigger == Trigger::Import && e.origin == Some(Origin::Sync))
    );
}

#[test]
fn insert_events_carry_the_new_texts_marks() {
    // "甲乙" bold, "丙" linked to an entity. Bold extends after its end,
    // entity links do not extend at all (`schema::STYLE_TABLE`).
    let mut p = doc("evm", 7);
    user(&mut p, |t| {
        t.insert_text(0, "甲乙丙")?;
        t.set_style(0..2, &InlineStyle::Bold)?;
        t.link_entity(2..3, &link("el-1"))
    });
    let seen: Arc<Mutex<Vec<ProseEvent>>> = Default::default();
    let s2 = seen.clone();
    let _sub = p.subscribe(move |e| s2.lock().unwrap().push(e.clone()));
    let inserted = |e: &ProseEvent| -> Vec<(String, InlineMarks)> {
        e.body
            .iter()
            .filter_map(|c| match c {
                TextChange::Insert { text, marks } => Some((text.clone(), marks.clone())),
                _ => None,
            })
            .collect()
    };
    let bold = InlineMarks {
        bold: true,
        ..InlineMarks::default()
    };
    user(&mut p, |t| t.insert_text(2, "一")); // after the bold, before the link
    user(&mut p, |t| t.insert_text(4, "二")); // after the link
    user(&mut p, |t| t.insert_text(0, "三")); // before the bold
    {
        let ev = seen.lock().unwrap();
        assert_eq!(inserted(&ev[0]), vec![("一".into(), bold.clone())]);
        assert_eq!(
            inserted(&ev[1]),
            vec![("二".into(), InlineMarks::default())]
        );
        assert_eq!(
            inserted(&ev[2]),
            vec![("三".into(), InlineMarks::default())]
        );
    }
    // An import reports every run with its marks (how Loro cuts the runs
    // is its own business; the final newline comes with the genesis).
    let mut q = doc("evm", 8);
    let seen_q: Arc<Mutex<Vec<ProseEvent>>> = Default::default();
    let s3 = seen_q.clone();
    let _sub_q = q.subscribe(move |e| s3.lock().unwrap().push(e.clone()));
    sync(&p, &mut q);
    let ev = seen_q.lock().unwrap();
    let chars: Vec<(char, InlineMarks)> = ev
        .iter()
        .flat_map(inserted)
        .flat_map(|(t, m)| t.chars().map(move |c| (c, m.clone())).collect::<Vec<_>>())
        .collect();
    let linked = InlineMarks {
        entities: vec![link("el-1")],
        ..InlineMarks::default()
    };
    let plain = InlineMarks::default();
    assert_eq!(
        chars,
        vec![
            ('三', plain.clone()),
            ('甲', bold.clone()),
            ('乙', bold.clone()),
            ('一', bold),
            ('丙', linked),
            ('二', plain),
        ]
    );
    assert_eq!(q.view().plain_text(), "三甲乙一丙二\n");
}

#[test]
fn anchors_are_the_cursor_pair_the_editor_stores() {
    // `gpui_prose::Anchor` stores the same bytes (f4-editor.md "待协调" 4):
    // `Cursor::encode()` of a `Side::Left` cursor on the first anchored
    // character and a `Side::Right` cursor on the last; a point is one
    // `Side::Left` cursor twice. `dr-editor` moves the bytes as they are.
    use dr_model::book::EncodedAnchor;
    use loro::cursor::Side;
    let mut p = doc("anc-enc", 7);
    user(&mut p, |t| t.insert_text(0, "甲乙丙丁"));
    let (e, point_bytes) = {
        let v = p.view();
        let e = v.anchor(1..3).unwrap().encode();
        assert_eq!(e.start, v.text.get_cursor(1, Side::Left).unwrap().encode());
        assert_eq!(e.end, v.text.get_cursor(2, Side::Right).unwrap().encode());
        (e, v.text.get_cursor(2, Side::Left).unwrap().encode())
    };
    assert_eq!(Anchor::decode(&e).unwrap().encode(), e, "bytes round-trip");
    let point = Anchor::decode(&EncodedAnchor {
        start: point_bytes.clone(),
        end: point_bytes,
    })
    .unwrap();
    assert!(point.is_point());
    user(&mut p, |t| t.insert_text(0, "前"));
    let r = p.view().resolve(&point).unwrap();
    assert_eq!((r.range, r.collapsed), (3..3, true));
    let r = p.view().resolve(&Anchor::decode(&e).unwrap()).unwrap();
    assert_eq!((r.range, r.collapsed), (2..4, false));
}

#[test]
fn readers_share_state_and_history_copies_do_not() {
    let mut p = doc("rd", 7);
    let reader = p.reader();
    user(&mut p, |t| t.insert_text(0, "一"));
    let f1 = p.frontiers();
    let snap1 = p.export_snapshot().unwrap();
    user(&mut p, |t| t.insert_text(1, "二"));
    assert_eq!(reader.view().plain_text(), "一二\n");
    let snap = p.export_snapshot().unwrap();
    let old = ProseReader::load_at(node("rd"), &[snap], &f1).unwrap();
    assert_eq!(old.view().plain_text(), "一\n");
    assert_eq!(p.view().plain_text(), "一二\n");
    let _ = snap1;
    // Readers are Send + Sync.
    let r2 = reader.clone();
    let h = std::thread::spawn(move || r2.view().plain_text());
    assert_eq!(h.join().unwrap(), "一二\n");
}

#[test]
fn corrupted_bytes_are_an_error_not_a_crash() {
    // One flipped byte in a stored update: Loro's checksum catches it before
    // the decoder can act on a damaged length (see core.rs).
    let mut p = doc("bad", 7);
    let (_, c) = p.edit(Origin::User, |t| t.insert_text(0, "正文"));
    let mut bytes = c.unwrap().update;
    let last = bytes.len() - 1;
    bytes[last] ^= 0x5A;
    assert!(ProseDoc::load(node("bad"), 7, &[bytes.clone()]).is_err());
    let mut q = doc("bad", 8);
    assert!(q.import(&bytes, Origin::Sync).is_err());
    assert!(ProseReader::load_at(node("bad"), &[bytes], &p.frontiers()).is_err());
}

#[test]
fn anchors_into_another_container_read_as_unlocated() {
    // Damaged anchor bytes can name any container; resolving must not ask
    // Loro for one that does not exist (Loro panics then).
    let mut p = doc("ac2", 7);
    user(&mut p, |t| t.insert_text(0, "正文"));
    let other = loro::LoroDoc::new();
    let t = other.get_text("elsewhere");
    t.insert(0, "abc").unwrap();
    let foreign = Anchor {
        start: t.get_cursor(0, loro::cursor::Side::Left).unwrap(),
        end: t.get_cursor(1, loro::cursor::Side::Right).unwrap(),
    };
    assert_eq!(p.view().resolve(&foreign), None);
    // An anchor from the same body of another document resolves to nothing
    // useful but never panics.
    let mut q = doc("ac3", 8);
    user(&mut q, |t| t.insert_text(0, "别处的字"));
    let a = q.view().anchor(0..2).unwrap();
    let _ = p.view().resolve(&a);
}

#[test]
fn a_task_line_linked_to_a_todo_has_no_state_of_its_own() {
    let mut note = ProseDoc::create(DocId::parse("material:tasks").unwrap(), 7).unwrap();
    let linked = BlockAttrs {
        list: Some(ListKind::Task),
        checked: true,
        todo: Some(CommentId::parse("todo-1").unwrap()),
        ..BlockAttrs::default()
    };
    user(&mut note, |t| {
        t.insert_text(0, "买书")?;
        t.set_block_attrs(0, &linked)
    });
    let para = note.view().paragraphs().next().unwrap();
    assert!(!para.attrs.checked, "the TODO is the only truth");
    assert_eq!(para.attrs.todo, linked.todo);
    let raw = note.view().raw_attrs_at(para.newline);
    assert!(
        !raw.contains_key(crate::schema::block::CHECKED),
        "not even stored"
    );
    // An unlinked task line keeps its own tick.
    let plain = BlockAttrs {
        list: Some(ListKind::Task),
        checked: true,
        ..BlockAttrs::default()
    };
    user(&mut note, |t| t.set_block_attrs(0, &plain));
    assert!(note.view().paragraphs().next().unwrap().attrs.checked);
}

#[test]
fn import_and_mirror_commits_carry_their_origin_as_message() {
    // "Who changed what" is read from the history itself, so imports and the
    // Markdown folder are recognisable like the Agent; the author's own
    // commits carry no message.
    let mut p = doc("msg", 7);
    let mut msgs = Vec::new();
    for origin in [
        Origin::User,
        Origin::Import,
        Origin::Mirror,
        Origin::agent("s", 2),
    ] {
        let (r, c) = p.edit(origin, |t| t.insert_text(0, "字"));
        r.unwrap();
        assert!(c.is_some());
        let id = p
            .view()
            .cursor(0, loro::cursor::Side::Middle)
            .unwrap()
            .id
            .unwrap();
        msgs.push(
            p.core()
                .doc
                .get_change(id)
                .and_then(|m| m.message.as_ref().map(|s| s.to_string())),
        );
    }
    assert_eq!(
        msgs,
        vec![
            None,
            Some("import".to_string()),
            Some("mirror".to_string()),
            Some("agent:s/2".to_string())
        ]
    );
    // The book document goes through the same commit path.
    let mut b = crate::book::BookDoc::create(dr_model::id::BookId::parse("b").unwrap(), 7).unwrap();
    let (r, c) = b.edit(Origin::Import, |t| t.meta().name("书").map(|_| ()));
    r.unwrap();
    assert!(c.is_some());
}

/// A holder's document: a plain `LoroDoc`, configured, with the genesis.
fn holder_doc(id: &str, peer: u64) -> loro::LoroDoc {
    let d = loro::LoroDoc::new();
    crate::schema::configure(&d);
    d.import(&genesis(&node(id))).unwrap();
    d.set_peer_id(peer).unwrap();
    d
}

#[test]
fn transactions_on_a_borrowed_document_leave_the_commit_to_the_holder() {
    let raw = holder_doc("bor", 7);
    let id = node("bor");
    // The holder sets its commit options first (an implicit commit behind a
    // barrier then carries them too), runs the edit, commits.
    let opts = || {
        loro::CommitOptions::new()
            .origin("agent:s/1")
            .commit_msg("agent:s/1")
    };
    raw.set_next_commit_options(opts());
    {
        let b = BorrowedProse::new(&raw, &id).unwrap();
        let mut t = b.txn();
        t.insert_text(0, "第一段").unwrap();
        let c = t.split(3).unwrap();
        t.insert_text(c, "第二段").unwrap();
        t.set_heading(0, Some(Heading::H1)).unwrap();
    }
    raw.commit_with(opts());
    let msg_at = |pos: usize| {
        let id = raw
            .get_text("body")
            .get_cursor(pos, loro::cursor::Side::Middle)
            .unwrap()
            .id
            .unwrap();
        raw.get_change(id)
            .and_then(|m| m.message.as_ref().map(|s| s.to_string()))
    };
    for pos in [0, 3, 4, 6] {
        assert_eq!(
            msg_at(pos).as_deref(),
            Some("agent:s/1"),
            "char {pos} is in the holder's commit"
        );
    }
    let b = BorrowedProse::new(&raw, &id).unwrap();
    let ps: Vec<_> = b.view().paragraphs().collect();
    assert_eq!(
        ps.iter().map(|p| p.text()).collect::<Vec<_>>(),
        vec!["第一段", "第二段"]
    );
    assert_eq!(ps[0].attrs.heading, Some(Heading::H1));
    assert!(ps.iter().all(|p| p.id.is_some()));
    // The same edits through a ProseDoc give the same document shape.
    let q = ProseDoc::load(
        id.clone(),
        8,
        &[raw.export(loro::ExportMode::Snapshot).unwrap()],
    )
    .unwrap();
    assert_eq!(q.view().plain_text(), b.view().plain_text());
    // Wrong or uninitialised documents are refused.
    assert!(matches!(
        BorrowedProse::new(&raw, &node("other")),
        Err(DocError::WrongDocument { .. })
    ));
    let empty = loro::LoroDoc::new();
    assert!(matches!(
        BorrowedProse::new(&empty, &id),
        Err(DocError::NotInitialized(_))
    ));
    assert!(BorrowedProse::new(&raw, &DocId::parse("book:b").unwrap()).is_err());
}

#[test]
fn borrowed_undo_steps_and_shared_readers() {
    let raw = holder_doc("bu", 7);
    let id = node("bu");
    let reader = ProseReader::from_loro(id.clone(), &raw).unwrap();
    let b = BorrowedProse::new(&raw, &id).unwrap();
    let mut um = b.undo_manager();
    b.txn().insert_text(0, "作者").unwrap();
    raw.commit_with(loro::CommitOptions::new().origin("user"));
    raw.set_next_commit_options(
        loro::CommitOptions::new()
            .origin("agent:s/1")
            .commit_msg("agent:s/1"),
    );
    b.txn().insert_text(0, "【A】").unwrap();
    raw.commit_with(
        loro::CommitOptions::new()
            .origin("agent:s/1")
            .commit_msg("agent:s/1"),
    );
    // The reader shares the holder's document: it sees both writes.
    assert_eq!(reader.view().plain_text(), "【A】作者\n");
    assert!(um.undo_step().unwrap());
    assert_eq!(
        reader.view().plain_text(),
        "【A】\n",
        "only the author's typing is undone"
    );
    assert!(um.redo_step().unwrap());
    assert_eq!(reader.view().plain_text(), "【A】作者\n");
    assert!(ProseReader::from_loro(node("x"), &raw).is_err());
}

/// The author's commands (`user:command`, F2's `Origin::Command`) are undone
/// by the workspace's journal: every `ProseUndo` leaves them out on its own,
/// while the author's typing before and after stays undoable.
#[test]
fn the_editors_undo_leaves_the_authors_commands_out() {
    let raw = holder_doc("uc", 7);
    let id = node("uc");
    let b = BorrowedProse::new(&raw, &id).unwrap();
    let mut um = b.undo_manager();
    let commit = |origin: &str| raw.commit_with(loro::CommitOptions::new().origin(origin));
    b.txn().insert_text(0, "甲").unwrap();
    commit("user");
    b.txn().insert_text(1, "【命令】").unwrap();
    commit(dr_model::origin::COMMAND_ORIGIN);
    b.txn().insert_text(5, "乙").unwrap();
    commit("user");
    assert_eq!(um.undo_count(), 2, "two items, both typing");
    while um.can_undo() {
        assert!(um.undo_step().unwrap());
    }
    assert_eq!(b.view().plain_text(), "【命令】\n");
}

/// `loro::UndoManager::new` keeps 100 items; the author's undo keeps them
/// all: every commit adds one item past 100 and all of them undo.
#[test]
fn the_authors_undo_stack_has_no_limit() {
    const COMMITS: usize = 250;
    let mut p = doc("ul", 7);
    let mut um = p.undo_manager();
    for i in 0..COMMITS {
        user(&mut p, |t| t.insert_text(i, "字"));
        assert_eq!(um.undo_count(), i + 1, "commit {i} pushed one item");
    }
    let mut undone = 0;
    while um.can_undo() {
        um.undo(&mut p).unwrap();
        undone += 1;
    }
    assert_eq!(undone, COMMITS);
    assert_eq!(texts(&p), vec![""], "every keystroke undone");
}

#[test]
fn reading_paragraphs_from_the_middle_needs_nothing_before() {
    let mut p = doc("pin", 7);
    user(&mut p, |t| {
        t.insert_paragraphs(0, "一\n二二\n三三三\n四").map(|_| ())
    });
    let v = p.view();
    let all: Vec<_> = v.paragraphs().collect();
    let mid = v.paragraph_in(all[1].range.start + 1, 2);
    assert_eq!(
        mid.iter().map(|x| x.text()).collect::<Vec<_>>(),
        vec!["二二", "三三三"]
    );
    assert_eq!(mid[0].id, all[1].id);
    assert_eq!(mid[1].range, all[2].range);
    // Past the end it stops; at the last paragraph it returns just that one.
    assert_eq!(v.paragraph_in(all[3].range.start, 5).len(), 1);
    assert!(v.paragraph_in(0, 0).is_empty());
    assert_eq!(v.paragraph_in(v.len() + 10, 1)[0].text(), "四");
}

fn template(peer: u64) -> ProseDoc {
    let c = dr_model::id::CategoryId::parse("cat-1").unwrap();
    ProseDoc::create(dr_model::id::TemplateOwner::Category(c).doc_id(), peer).unwrap()
}

/// A body template is an ordinary prose document under a derived id: two
/// devices that start the same template merge into one, and copying it into
/// a new element gives exactly its text, attributes, marks and table, under
/// fresh block and embed ids.
#[test]
fn templates_merge_and_copy_into_new_documents() {
    // Two devices start the category's template before they sync.
    let mut a = template(1);
    let mut b = template(2);
    sync(&b, &mut a);
    assert_eq!(texts(&a), vec![""], "one genesis, one empty paragraph");
    let tbl = EmbedId::parse("tbl-t").unwrap();
    user(&mut a, |t| {
        t.insert_text(0, "外貌")?;
        let c = t.split(2)?;
        t.insert_text(c, "身高一米八，常和林立吵架")?;
        t.set_style(c..c + 2, &InlineStyle::Bold)?;
        t.link_entity(c + 8..c + 10, &link("el-lin"))?;
        let c = t.split(c + 12)?;
        let c = t.split(c)?;
        t.insert_text(c, "性格")?;
        let w = t.insert_embed(c, &tbl, &EmbedKind::Table)?;
        w.add_col("k0", &PosKey::first())?;
        w.add_row("r0", &PosKey::first())?;
        w.set_cell("r0", "k0", "格子")?;
        t.set_heading(0, Some(Heading::H1))
    });
    sync(&a, &mut b);
    assert_eq!(
        texts(&b),
        vec!["外貌", "身高一米八，常和林立吵架", "", "\u{FFFC}", "性格"]
    );

    // A new element starts from it.
    let mut e = ProseDoc::create(DocId::parse("element:e1").unwrap(), 3).unwrap();
    let end = user(&mut e, |t| t.insert_copy(0, &b.view()));
    assert_eq!(
        texts(&e),
        texts(&b),
        "exactly the template, no extra paragraph"
    );
    assert_eq!(end, e.view().len() - 1);
    let (src, dst): (Vec<_>, Vec<_>) = (
        b.view().paragraphs().collect(),
        e.view().paragraphs().collect(),
    );
    for (s, d) in src.iter().zip(&dst) {
        assert_eq!(s.attrs, d.attrs);
        assert_ne!(s.id, d.id, "fresh block ids");
        if s.embed().is_none() {
            assert_eq!(s.runs, d.runs, "marks and entity links");
        }
    }
    assert!(dst.iter().all(|p| p.id.is_some()));
    let copied = dst[3].embed().unwrap().clone();
    assert_ne!(copied, tbl, "a new embed id");
    match e.view().embed(&copied) {
        Some(super::embed::EmbedView::Table { cells, .. }) => {
            assert_eq!(
                cells.get(&("r0".into(), "k0".into())).map(String::as_str),
                Some("格子")
            );
        }
        other => panic!("{other:?}"),
    }
    // Typing next to the copied bold or link behaves as typed text does.
    user(&mut e, |t| t.insert_text(5, "高"));
    assert!(e.view().paragraphs().nth(1).unwrap().runs[0].marks.bold);

    // Copied in front of existing text: that paragraph keeps its id.
    let mut n = doc("tpl", 4);
    user(&mut n, |t| t.insert_text(0, "原文"));
    let kept = ids(&n)[0].clone();
    user(&mut n, |t| t.insert_copy(0, &b.view()).map(|_| ()));
    let mut want = texts(&b);
    want.push("原文".into());
    assert_eq!(texts(&n), want);
    assert_eq!(ids(&n).last(), Some(&kept));
    let all = ids(&n);
    assert_eq!(
        all.iter().collect::<std::collections::HashSet<_>>().len(),
        all.len()
    );

    // Not in the middle of a paragraph, and nothing a profile refuses.
    let (r, _) = n.edit(Origin::User, |t| t.insert_copy(1, &b.view()));
    assert!(matches!(r, Err(DocError::BadRange { .. })));
    let mut note = ProseDoc::create(DocId::parse("material:m").unwrap(), 5).unwrap();
    user(&mut note, |t| {
        t.insert_text(0, "条目")?;
        t.set_block_attrs(
            0,
            &BlockAttrs {
                list: Some(ListKind::Bullet),
                ..Default::default()
            },
        )
    });
    let mut chap = doc("tpl2", 6);
    let (r, _) = chap.edit(Origin::User, |t| t.insert_copy(0, &note.view()));
    assert!(matches!(r, Err(DocError::NotInProfile(_))));
}

/// A table as a material note's editor writes it (dr-editor's `CellSource`:
/// each cell a text, its marks set on that text, the highlighter's
/// highlight valued ""): a copy keeps every cell's marks where they were,
/// and the rows and columns under their ids, in their order.
#[test]
fn a_copied_tables_cells_keep_their_marks() {
    use super::embed::EmbedView;
    use crate::schema::inline;
    let material = |id: &str| DocId::parse(&format!("material:{id}")).unwrap();
    let table = |t: &mut ProseTxn<'_>, tbl: &EmbedId, cols: &[&str], rows: &[&str]| {
        let c = t.insert_text(0, "对照").and_then(|_| t.split(2))?;
        let w = t.insert_embed(c, tbl, &EmbedKind::Table)?;
        // Like dr-editor's insert_table: positions in order.
        for (lines, col) in [(cols, true), (rows, false)] {
            let mut pos = PosKey::first();
            for (i, id) in lines.iter().enumerate() {
                if i > 0 {
                    pos = pos.after();
                }
                if col {
                    w.add_col(id, &pos)?;
                } else {
                    w.add_row(id, &pos)?;
                }
            }
        }
        Ok::<_, DocError>(w)
    };
    let typed = |w: &TableWriter, r: &str, c: &str, s: &str| -> Result<loro::LoroText> {
        let t = w.cell(r, c)?;
        t.insert(0, s)?;
        Ok(t)
    };
    let lin = || super::attrs::encode_entity(&link("el-lin"));

    let tbl = EmbedId::parse("tbl-n").unwrap();
    let mut note = ProseDoc::create(material("m1"), 1).unwrap();
    user(&mut note, |t| {
        let w = table(t, &tbl, &["c0", "c1", "c2"], &["r0", "r1"])?;
        let a = typed(&w, "r0", "c0", "粗体和高亮")?;
        a.mark(0..2, inline::BOLD, true)?;
        a.mark(3..5, inline::HIGHLIGHT, "")?;
        typed(&w, "r0", "c1", "代码\u{2028}第二行")?.mark(0..2, inline::CODE, true)?;
        typed(&w, "r1", "c0", "找林立")?.mark(1..3, &inline::entity_key("el-lin"), lin())?;
        typed(&w, "r1", "c2", "素")?;
        Ok(())
    });

    let mut copy = ProseDoc::create(material("m2"), 2).unwrap();
    user(&mut copy, |t| t.insert_copy(0, &note.view()));
    assert_eq!(texts(&copy), texts(&note));
    let (src, dst) = (note.view(), copy.view());
    let copied = dst.paragraphs().nth(1).unwrap().embed().unwrap().clone();
    assert_ne!(copied, tbl);
    let (
        Some(EmbedView::Table {
            cols: sc,
            rows: sr,
            cells: scells,
            ..
        }),
        Some(EmbedView::Table {
            cols: dc,
            rows: dr,
            cells: dcells,
            ..
        }),
    ) = (src.embed(&tbl), dst.embed(&copied))
    else {
        panic!("both are tables");
    };
    assert_eq!((&sc, &sr), (&dc, &dr), "line ids, positions and order");
    assert_eq!(scells, dcells);
    assert_eq!(scells.len(), 4, "untyped cells stay uncreated");
    for (r, c) in scells.keys() {
        assert_eq!(
            dst.table_cell(&copied, r, c),
            src.table_cell(&tbl, r, c),
            "cell ({r}, {c})"
        );
    }
    let first: Vec<_> = dst
        .table_cell(&copied, "r0", "c0")
        .unwrap()
        .into_iter()
        .map(|r| (r.text, r.marks.bold, r.marks.highlight))
        .collect();
    assert_eq!(
        first,
        [
            ("粗体".into(), true, None),
            ("和".into(), false, None),
            ("高亮".into(), false, Some(String::new())),
        ],
        "the bold did not spread to the next run"
    );
    assert!(dst.table_cell(&copied, "r0", "c1").unwrap()[0].marks.code);
    assert_eq!(
        dst.table_cell(&copied, "r1", "c0").unwrap()[1]
            .marks
            .entities,
        [link("el-lin")]
    );
    assert_eq!(src.table_cell(&tbl, "r0", "c2"), None, "never typed in");

    // A body template's table: bold and links come along into an element;
    // a note's highlight and code are refused in a chapter, like the body's.
    let mut tpl = template(3);
    let t2 = EmbedId::parse("tbl-t").unwrap();
    user(&mut tpl, |t| {
        let w = table(t, &t2, &["k0"], &["r0"])?;
        let x = typed(&w, "r0", "k0", "林立很高")?;
        x.mark(0..2, &inline::entity_key("el-lin"), lin())?;
        x.mark(2..4, inline::BOLD, true)?;
        Ok(())
    });
    let mut el = ProseDoc::create(DocId::parse("element:e2").unwrap(), 4).unwrap();
    user(&mut el, |t| t.insert_copy(0, &tpl.view()));
    let e2 = el
        .view()
        .paragraphs()
        .nth(1)
        .unwrap()
        .embed()
        .unwrap()
        .clone();
    let runs = el.view().table_cell(&e2, "r0", "k0").unwrap();
    assert_eq!(Some(runs.clone()), tpl.view().table_cell(&t2, "r0", "k0"));
    assert_eq!(
        (runs[0].marks.entities.clone(), runs[1].marks.bold),
        (vec![link("el-lin")], true)
    );
    let mut chap = doc("cells", 5);
    let (r, _) = chap.edit(Origin::User, |t| t.insert_copy(0, &note.view()));
    assert!(matches!(r, Err(DocError::NotInProfile(_))));
}
