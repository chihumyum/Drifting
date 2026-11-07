//! Writes seed inputs for the `load_bytes` fuzz target: real exported bytes
//! of small documents. Ignored by default; run with
//! `DR_FUZZ_SEEDS=<dir> cargo test -p dr-doc --test fuzz_seeds -- --ignored`.

use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_model::book::EntityRef;
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::prose::{EntityLink, Heading};
use dr_model::{DocId, Origin};

#[test]
#[ignore]
fn write_fuzz_seeds() {
    let Ok(dir) = std::env::var("DR_FUZZ_SEEDS") else {
        return;
    };
    std::fs::create_dir_all(&dir).unwrap();
    let mut p = ProseDoc::create(DocId::parse("node:fuzz").unwrap(), 3).unwrap();
    let mut updates = Vec::new();
    for step in 0..6 {
        let (r, c) = p.edit(Origin::User, |t| {
            let end = t.view().len() - 1;
            match step {
                0 => t.insert_text(0, "安娜卡列尼娜😀"),
                1 => t.split(3).map(|_| ()),
                2 => t.set_heading(0, Some(Heading::H2)),
                3 => t.link_entity(
                    0..2,
                    &EntityLink {
                        target: "e0".into(),
                        kind: EntityKind::Element,
                        block: None,
                        end_block: None,
                    },
                ),
                4 => t.insert_paragraphs(end, "第二段\n第三段").map(|_| ()),
                _ => t.delete(1..5),
            }
        });
        r.unwrap();
        updates.push(c.unwrap().update);
    }
    let mut b = BookDoc::create(BookId::parse("fuzz").unwrap(), 3).unwrap();
    let (r, c) = b.edit(Origin::User, |t| {
        t.node(&NodeId::parse("n0").unwrap())?
            .kind(&NodeKind::Chapter)?
            .title("章")?
            .book_order(Some(5.0))?;
        t.element(&ElementId::parse("e0").unwrap())?
            .name("安")?
            .add_alias("小安")?;
        t.element(&ElementId::parse("e1").unwrap())?.name("娜")?;
        t.relation(&RelationId::parse("r0").unwrap())?
            .ends(
                &EntityRef::new(EntityKind::Element, "e0"),
                &EntityRef::new(EntityKind::Element, "e1"),
            )?
            .relation_type(&RelationTypeId::parse("t0").unwrap())?;
        t.drift_groups().create("g0", None, "组")?;
        Ok(())
    });
    r.unwrap();
    let seeds: Vec<(String, Vec<u8>)> = vec![
        ("prose-snapshot".into(), p.export_snapshot().unwrap()),
        ("prose-update".into(), updates[3].clone()),
        ("prose-all".into(), updates.concat()),
        ("book-snapshot".into(), b.export_snapshot().unwrap()),
        ("book-update".into(), c.unwrap().update),
    ];
    for (name, bytes) in seeds {
        // load_bytes splits at the first two bytes; 0xFF 0xFF keeps it whole.
        let mut data = vec![0xFF, 0xFF];
        data.extend(bytes);
        std::fs::write(format!("{dir}/{name}"), data).unwrap();
    }
}
