//! Writing a synthetic plan as dr-doc documents. The book writer itself
//! (deterministic peers and commit timestamps, so the same preset and seed
//! give byte-identical documents) is dr-samples' `build`, shared with the
//! sample books; this module re-exports it.

use dr_doc::{DocError, Result};
use dr_model::book::{BlockSnapshot, EntityRef, KvEntry};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::{Day, DocId, Timestamp};

pub(crate) use dr_samples::build::{Builder, format_paras, id, positions};
pub use dr_samples::build::{SeededBook, T0};

use super::plan::{self, Plan};

/// The date `days` days before the seed's day zero, as `YYYY-MM-DD`.
pub(crate) fn day_before_t0(days: i64) -> Day {
    let z = T0.div_euclid(86_400) - days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Day::parse(&format!("{y:04}-{m:02}-{d:02}")).expect("valid date")
}

/// Write a plan as dr-doc documents: deterministic ids, peers and
/// timestamps, so the same plan gives byte-identical documents.
pub(crate) fn write_direct(p: &Plan) -> Result<SeededBook> {
    let mut b = Builder::new(p.book.clone())?;
    let element_refs: Vec<EntityRef> = p
        .elements
        .iter()
        .map(|e| EntityRef::new(EntityKind::Element, e.id.as_str()))
        .collect();
    let storyline_pos = positions(p.storylines.len());
    b.edit_book(|t| {
        t.meta()
            .name(&p.name)?
            .summary(plan::BOOK_SUMMARY)?
            .created_at(Some(Timestamp(T0)))?
            .word_target(Some(p.word_target))?
            .daily_word_target(Some(p.daily_word_target))?;
        for (i, (id, s)) in p.storylines.iter().enumerate() {
            t.storyline(id)?
                .name(&s.name)?
                .color(&s.color)?
                .summary(&s.summary)?
                .pos(&storyline_pos[i])?;
        }
        for (id, c) in &p.categories {
            t.category(id)?
                .name(&c.name)?
                .color(&c.color)?
                .layout(&CategoryLayout::Auto)?;
        }
        for (i, e) in p.elements.iter().enumerate() {
            let w = t.element(&e.id)?;
            w.name(&e.name)?
                .summary(&e.summary)?
                .category(Some(&p.categories[e.category].0))?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
            for a in &e.aliases {
                w.add_alias(a)?;
            }
            for (key, value) in &e.facts {
                w.put_fact(&KvEntry {
                    id: KvEntryId::parse(&format!("fact-{i}")).expect("valid id"),
                    key: key.clone(),
                    value: value.clone(),
                    pos: Some(PosKey::first()),
                })?;
            }
        }
        for (key, value) in &p.facts {
            t.put_fact(&KvEntry {
                id: KvEntryId::parse("fact-book-setting").expect("valid id"),
                key: key.clone(),
                value: value.clone(),
                pos: Some(PosKey::first()),
            })?;
        }
        Ok(())
    })?;
    for (id, s) in &p.storylines {
        b.prose("storylines", DocId::Storyline(id.clone()), &s.body, &[])?;
    }
    for (id, c) in &p.categories {
        b.prose("categories", DocId::Category(id.clone()), &c.body, &[])?;
    }
    for e in &p.elements {
        b.prose("elements", DocId::Element(e.id.clone()), &e.body, &[])?;
    }

    let (rt_name, source_role, target_role) = plan::RELATION_TYPE;
    b.edit_book(|t| {
        t.relation_type(&p.relation_type)?
            .name(rt_name)?
            .orientation(&RelationOrientation::Directed)?
            .source_role(source_role)?
            .target_role(target_role)?
            .source_kinds(&[EntityKind::Element])?
            .target_kinds(&[EntityKind::Element])?;
        for (k, (id, a, z)) in p.relations.iter().enumerate() {
            t.relation(id)?
                .ends(&element_refs[*a], &element_refs[*z])?
                .relation_type(&p.relation_type)?
                .created_at(Some(Timestamp(T0 + k as i64)))?;
        }
        Ok(())
    })?;

    b.edit_book(|t| {
        for (a, (id, name, first)) in p.acts.iter().enumerate() {
            t.act(id)?
                .name(name)?
                .start_order((a > 0).then(|| Plan::order(*first) - 5.0))?;
        }
        for (i, c) in p.chapters.iter().enumerate() {
            let order = Plan::order(i);
            let primary = &p.storylines[c.storylines[0]].0;
            let w = t.node(&c.id)?;
            w.kind(&NodeKind::Chapter)?
                .title(&c.title)?
                .summary(plan::CHAPTER_SUMMARY)?
                .book_order(Some(order))?
                .narrative_order(Some(order))?
                .status(&c.status)?
                .add_storyline(primary)?
                .primary_storyline(Some(primary))?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
            for s in &c.storylines[1..] {
                w.add_storyline(&p.storylines[*s].0)?;
            }
        }
        for (id, at, label) in &p.time_pins {
            t.time_pin(id)?.narrative_order(*at)?.label(label)?;
        }
        Ok(())
    })?;
    let first_chapter = b.prose.len();
    for c in &p.chapters {
        b.prose(
            "chapters",
            DocId::Node(c.id.clone()),
            &c.body,
            &element_refs,
        )?;
    }

    b.edit_book(|t| {
        for (id, name) in &p.idea_groups {
            t.drift_groups().create(id.as_str(), None, name)?;
        }
        for (i, idea) in p.ideas.iter().enumerate() {
            t.node(&idea.id)?
                .kind(&NodeKind::Drift)?
                .title(&idea.title)?
                .status(&idea.status)?
                .group(idea.group.map(|g| &p.idea_groups[g].0))?
                .x(idea.x)?
                .y(idea.y)?
                .created_at(Some(Timestamp(T0 + i as i64)))?;
        }
        Ok(())
    })?;
    for idea in &p.ideas {
        b.prose(
            "ideas",
            DocId::Node(idea.id.clone()),
            &idea.body,
            &element_refs,
        )?;
    }

    let material_pos = positions(p.materials.len());
    b.edit_book(|t| {
        for (id, name) in &p.folders {
            t.material_folders().create(id.as_str(), None, name)?;
        }
        for (i, m) in p.materials.iter().enumerate() {
            t.material(&m.id)?
                .title(&m.title)?
                .kind(&MaterialKind::Text)?
                .folder(m.folder.map(|f| &p.folders[f].0))?
                .pos(&material_pos[i])?
                .task_todos(m.task_todos)?;
        }
        Ok(())
    })?;
    for m in &p.materials {
        b.prose("materialNotes", DocId::Material(m.id.clone()), &m.body, &[])?;
    }

    // Comments and TODOs, anchored where the plan put them.
    let mut placed = Vec::new();
    for c in &p.comments {
        let view = b.prose[first_chapter + c.chapter].view();
        let block = view.blocks().get(c.para).and_then(|bl| bl.id.clone());
        let quote = view.text_in(c.range.0..c.range.1)?;
        if quote != c.quote {
            return Err(DocError::Missing {
                collection: "planned quotation",
                id: c.quote.clone(),
            });
        }
        placed.push((block, view.anchor(c.range.0..c.range.1)));
    }
    b.edit_book(|t| {
        for (k, (c, (block, anchor))) in p.comments.iter().zip(&placed).enumerate() {
            let w = t.comment(&c.id)?;
            w.kind(if c.todo {
                &CommentKind::Todo
            } else {
                &CommentKind::Note
            })?
            .author_kind(&CommentAuthorKind::User)?
            .status(if c.resolved {
                &CommentStatus::Resolved
            } else {
                &CommentStatus::Open
            })?
            .source(&CommentSource::Manual)?
            .target(Some(&EntityRef::new(
                EntityKind::Node,
                p.chapters[c.chapter].id.as_str(),
            )))?
            .target_block(block.as_ref())?
            .anchor(anchor.as_ref())?
            .quote(Some(&c.quote))?
            .snapshots(&[BlockSnapshot {
                block: block.clone(),
                text: c.snapshot.clone(),
            }])?
            .body(&c.body)?
            .created_at(Some(Timestamp(T0 + k as i64)))?
            .updated_at(Some(Timestamp(T0 + k as i64)))?
            .resolved_at(c.resolved.then_some(Timestamp(T0 + k as i64 + 60)))?;
            if let Some(pr) = c.priority {
                w.priority(Some(&CommentPriority::parse(pr)))?;
            }
        }
        Ok(())
    })?;
    for c in &p.comments {
        b.record(if c.todo { "todos" } else { "comments" }, c.body.clone());
    }

    b.edit_book(|t| {
        for (day, words) in &p.writing_days {
            t.writing_day(&p.device, day, *words)?;
        }
        for (id, body) in &p.memory {
            t.memory(id)?
                .kind(&MemoryKind::Preference)?
                .body(body)?
                .source(&MemorySource::Author)?
                .status(&MemoryStatus::Active)?;
        }
        Ok(())
    })?;
    Ok(b.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_count_back_from_day_zero() {
        assert_eq!(day_before_t0(0).as_str(), "2025-11-01");
        assert_eq!(day_before_t0(1).as_str(), "2025-10-31");
        assert_eq!(day_before_t0(366).as_str(), "2024-10-31");
    }
}
