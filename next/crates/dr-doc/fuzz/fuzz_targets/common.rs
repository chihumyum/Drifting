//! Read and write everything a damaged document offers. Nothing here may
//! panic, whatever the bytes were.

use dr_doc::book::BookDoc;
use dr_doc::prose::ProseDoc;
use dr_doc::{Anchor, Unit};
use dr_model::Origin;
use dr_model::book::EncodedAnchor;
use dr_model::prose::{Heading, InlineStyle};

pub fn exercise_prose(d: &mut ProseDoc, seed: &[u8]) {
    let v = d.view();
    let len = v.len();
    for p in v.paragraphs() {
        let _ = p.text();
        let _ = p.embed();
    }
    let _ = v.blocks();
    let _ = v.paragraph_count();
    let _ = v.entity_links();
    let _ = v.embed_refs();
    for (_, id) in v.embed_refs() {
        let _ = v.embed(&id);
    }
    let _ = v.orphan_embeds();
    for b in seed.iter().take(8) {
        let x = *b as usize;
        let _ = v.paragraph_at(x % (len + 2));
        for unit in [Unit::Char, Unit::Utf8, Unit::Utf16] {
            let _ = v.pos(unit, x % (len * 4 + 2));
        }
        let _ = v.text_in(0..x.min(len));
        if x < len
            && let Some(a) = v.anchor(x..len)
        {
            let _ = v.resolve(&a);
        }
    }
    // Cursors from arbitrary bytes.
    if seed.len() > 4 {
        let (s, e) = seed.split_at(seed.len() / 2);
        if let Some(a) = Anchor::decode(&EncodedAnchor {
            start: s.to_vec(),
            end: e.to_vec(),
        }) {
            let _ = v.resolve(&a);
        }
    }
    // Typed edits on whatever is there; errors are fine, panics are not.
    let pick = |i: usize| seed.get(i).copied().unwrap_or(0) as usize % (len + 2);
    let _ = d.edit(Origin::User, |t| {
        let _ = t.insert_text(pick(0), "字");
        let _ = t.split(pick(1));
        let _ = t.delete(pick(2)..pick(2) + pick(3));
        let _ = t.set_heading(pick(4), Heading::from_level((pick(5) % 4) as i64));
        let n = t.view().len();
        let _ = t.set_style(0..pick(6).min(n), &InlineStyle::Bold);
        let _ = t.insert_paragraphs(pick(7), "一\n二");
        let _ = t.drop_orphan_embeds();
        Ok(())
    });
    let _ = d.repair();
    let _ = d.export_snapshot();
    for p in d.view().paragraphs() {
        let _ = p.text();
    }
}

pub fn exercise_book(d: &mut BookDoc) {
    let v = d.view();
    let _ = v.meta();
    let _ = v.nodes();
    let _ = v.chapters();
    let _ = v.drifts();
    let _ = v.timeline();
    let _ = v.acts();
    let _ = v.time_pins();
    let _ = v.storylines();
    let _ = v.categories();
    let _ = v.elements();
    let _ = v.patches();
    let _ = v.relation_types();
    let _ = v.relations_raw();
    let _ = v.relations();
    for n in v.nodes() {
        let _ = v.plot_grid(&n.id);
    }
    let _ = v.comments();
    let _ = v.materials();
    let _ = v.assets();
    let _ = v.drift_groups();
    let _ = v.material_folders();
    let _ = v.facts();
    let _ = v.memory();
    let _ = v.writing_days();
    let _ = v.repair_plan();
    let _ = d.repair();
    let _ = d.view().relations();
    let _ = d.export_snapshot();
}
