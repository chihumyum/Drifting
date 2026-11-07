//! Costs of the dr-doc API on synthetic data, for f1-model-doc.md. Ignored by
//! default; run in release:
//!
//! ```text
//! cargo test --release -p dr-doc --test measure -- --ignored --nocapture
//! ```
//!
//! With `DR_EVIDENCE=1` it writes `docs/rust-rewrite/acceptance/f1-measure.json`.
//! The numbers are for orientation, not a gate (no budget is checked here;
//! the benchmark gates belong to F2/F4 and dr-testkit).

use std::time::Instant;

use dr_doc::Unit;
use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_model::book::EntityRef;
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::prose::{EntityLink, Heading};
use dr_model::{DocId, Origin};

const HAN: &str = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞";

fn pct(mut v: Vec<f64>, p: f64) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() - 1) as f64 * p).round() as usize]
}

/// A 20,000-character chapter of ~100-character paragraphs, H1–H3 headings
/// and an entity link every 150 characters, written in one commit.
fn chapter(peer: u64) -> ProseDoc {
    let mut d = ProseDoc::create(DocId::parse("node:measure").unwrap(), peer).unwrap();
    let han: Vec<char> = HAN.chars().collect();
    let mut text = String::new();
    let mut i = 0usize;
    while text.chars().count() < 20_000 {
        for _ in 0..100 {
            text.push(han[(i * 7919) % han.len()]);
            i += 1;
        }
        text.push('\n');
    }
    text.pop();
    let (r, _) = d.edit(Origin::Import, |t| {
        t.insert_paragraphs(0, &text)?;
        let blocks = t.view().blocks();
        for (k, b) in blocks.iter().enumerate() {
            if k % 10 == 0 {
                t.set_heading(b.newline, Heading::from_level((k / 10 % 3 + 1) as i64))?;
            }
        }
        let len = t.view().len();
        let mut at = 0;
        while at + 4 < len {
            let link = EntityLink {
                target: format!("el-{}", at % 7),
                kind: EntityKind::Element,
                block: None,
                end_block: None,
            };
            t.link_entity(at..at + 3, &link)?;
            at += 150;
        }
        Ok(())
    });
    r.unwrap();
    d
}

#[test]
#[ignore]
fn measure() {
    let mut out = serde_json::Map::new();
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1e3;

    // Load a chapter from its snapshot.
    let src = chapter(1);
    let snap = src.export_snapshot().unwrap();
    let mut loads = Vec::new();
    for _ in 0..20 {
        let t = Instant::now();
        let d = ProseDoc::load(
            DocId::parse("node:measure").unwrap(),
            2,
            std::slice::from_ref(&snap),
        )
        .unwrap();
        let _ = d.view().len();
        loads.push(ms(t));
    }
    out.insert("chapter_chars".into(), src.view().len().into());
    out.insert("chapter_snapshot_bytes".into(), snap.len().into());
    out.insert("load_chapter_ms_p50".into(), pct(loads, 0.5).into());

    let mut d = ProseDoc::load(DocId::parse("node:measure").unwrap(), 2, &[snap]).unwrap();
    // First full read decodes the chapter; later reads are warm.
    let t = Instant::now();
    let n = d.view().paragraphs().count();
    out.insert("paragraphs".into(), n.into());
    out.insert("read_all_paragraphs_first_ms".into(), ms(t).into());
    let mut warm = Vec::new();
    for _ in 0..10 {
        let t = Instant::now();
        let n2 = d.view().paragraphs().map(|p| p.runs.len()).sum::<usize>();
        assert!(n2 > 0);
        warm.push(ms(t));
    }
    out.insert(
        "read_all_paragraphs_warm_ms_p50".into(),
        pct(warm, 0.5).into(),
    );
    let mut one = Vec::new();
    let len = d.view().len();
    for k in 0..200 {
        let t = Instant::now();
        let _ = d.view().paragraph_at((k * 997) % len).unwrap();
        one.push(ms(t) * 1e3);
    }
    out.insert("paragraph_at_us_p50".into(), pct(one, 0.5).into());
    let mut conv = Vec::new();
    for k in 0..200 {
        let t = Instant::now();
        let p = d.view().pos(Unit::Char, (k * 991) % len).unwrap();
        let _ = d.view().pos(Unit::Utf16, p.utf16).unwrap();
        conv.push(ms(t) * 1e3);
    }
    out.insert("pos_convert_roundtrip_us_p50".into(), pct(conv, 0.5).into());
    let t = Instant::now();
    let links = d.view().entity_links().len();
    out.insert("entity_links".into(), links.into());
    out.insert("entity_links_ms".into(), ms(t).into());

    // A keystroke: one edit (insert 1–2 characters mid-text) and its update
    // bytes, ready for storage. Every 20th one is an Enter.
    let mut keys = Vec::new();
    let mut bytes = 0usize;
    for k in 0..2000 {
        let at = (k * 7907) % (d.view().len() - 1);
        let t = Instant::now();
        let (r, c) = d.edit(Origin::User, |t| {
            if k % 20 == 19 {
                t.split(at).map(|_| ())
            } else {
                t.insert_text(at, "字")
            }
        });
        r.unwrap();
        bytes += c.unwrap().update.len();
        keys.push(ms(t));
    }
    out.insert(
        "keystroke_edit_commit_export_ms_p50".into(),
        pct(keys.clone(), 0.5).into(),
    );
    out.insert(
        "keystroke_edit_commit_export_ms_p95".into(),
        pct(keys, 0.95).into(),
    );
    out.insert("keystroke_update_bytes_avg".into(), (bytes / 2000).into());

    // The book: 100 chapters, 300 elements, 400 relations, 200 ideas.
    let mut b = BookDoc::create(BookId::parse("measure").unwrap(), 1).unwrap();
    let t = Instant::now();
    let (r, _) = b.edit(Origin::Import, |t| {
        t.relation_type(&RelationTypeId::parse("rt").unwrap())?
            .name("关系")?
            .orientation(&RelationOrientation::Directed)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        for i in 0..100 {
            t.node(&NodeId::parse(&format!("c{i:03}")).unwrap())?
                .kind(&NodeKind::Chapter)?
                .title(&format!("第{}章", i + 1))?
                .book_order(Some((i * 5) as f64))?;
        }
        for i in 0..200 {
            t.node(&NodeId::parse(&format!("d{i:03}")).unwrap())?
                .kind(&NodeKind::Drift)?
                .title("构想")?;
        }
        for i in 0..300 {
            t.element(&ElementId::parse(&format!("e{i:03}")).unwrap())?
                .name("要素")?
                .add_alias("别名")?;
        }
        for i in 0..400 {
            let a = EntityRef::new(EntityKind::Element, format!("e{:03}", i % 300));
            let z = EntityRef::new(EntityKind::Element, format!("e{:03}", (i * 7 + 1) % 300));
            t.relation(&RelationId::parse(&format!("r{i:03}")).unwrap())?
                .ends(&a, &z)?
                .relation_type(&RelationTypeId::parse("rt").unwrap())?;
        }
        Ok(())
    });
    r.unwrap();
    out.insert("book_build_ms".into(), ms(t).into());
    let snap = b.export_snapshot().unwrap();
    out.insert("book_snapshot_bytes".into(), snap.len().into());
    let t = Instant::now();
    let b = BookDoc::load(BookId::parse("measure").unwrap(), 2, &[snap]).unwrap();
    out.insert("load_book_ms".into(), ms(t).into());
    let mut ch = Vec::new();
    for _ in 0..10 {
        let t = Instant::now();
        assert_eq!(b.view().chapters().len(), 100);
        ch.push(ms(t));
    }
    out.insert("book_chapters_ms_p50".into(), pct(ch, 0.5).into());
    let mut rel = Vec::new();
    for _ in 0..10 {
        let t = Instant::now();
        let _ = b.view().relations();
        rel.push(ms(t));
    }
    out.insert("book_relations_ms_p50".into(), pct(rel, 0.5).into());
    let t = Instant::now();
    let _ = b.view().repair_plan();
    out.insert("book_repair_plan_ms".into(), ms(t).into());

    let json = serde_json::json!({
        "schema": "f1-measure/1",
        "note": "Generated by crates/dr-doc/tests/measure.rs (release, DR_EVIDENCE=1). Orientation only, not a gate.",
        "loro": "1.17.1",
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "results": out,
    });
    println!("{}", serde_json::to_string_pretty(&json).unwrap());
    if std::env::var("DR_EVIDENCE").is_ok() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/rust-rewrite/acceptance/f1-measure.json");
        let mut s = serde_json::to_string_pretty(&json).unwrap();
        s.push('\n');
        std::fs::write(path, s).unwrap();
    }
}
