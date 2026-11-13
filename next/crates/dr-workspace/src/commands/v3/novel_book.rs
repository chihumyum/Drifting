//! `project.create`: a new book from the built-in novel template. The one
//! command that may name the novel template's ids (`cutover` gate,
//! `kernel-v4.md` §9); everything else recognises entries by their data.
use super::*;

op! {
    ProjectCreate = "project.create", Write, Library, "Create a project using the novel template.",
    fn(cx, input: super::super::book::BookCreateIn) -> Named {
        name_ok(&input.name)?;
        let id = BookId::new_v7();
        let slot = cx.workspace().book_slot_or_create_v3(&id)?;
        let roots = dr_doc::v3::NovelRootEntries::new();
        // Every entry the template creates has a body for each prose module
        // of its template, registered before the book is written (there is
        // no template prose to copy yet in a new book).
        let templates: BTreeMap<EntryTemplateId, m::EntryTemplate> =
            dr_doc::v3::novel_project_templates()
                .into_iter()
                .map(|t| (t.id.clone(), t))
                .collect();
        let tpl = |s: &str| EntryTemplateId::parse(s).expect("built-in template id");
        for (entry, template) in [
            (&roots.manuscript, dr_doc::v3::novel::TPL_MANUSCRIPT),
            (&roots.ideas, dr_doc::v3::novel::TPL_IDEAS),
            (&roots.elements, dr_doc::v3::novel::TPL_ELEMENTS),
            (&roots.storylines, dr_doc::v3::novel::TPL_STORYLINES),
            (&roots.cat_character, dr_doc::v3::novel::TPL_CATEGORY),
            (&roots.cat_location, dr_doc::v3::novel::TPL_CATEGORY),
            (&roots.cat_item, dr_doc::v3::novel::TPL_CATEGORY),
            (&roots.cat_organization, dr_doc::v3::novel::TPL_CATEGORY),
        ] {
            for module in templates[&tpl(template)].prose_modules() {
                cx.create_prose(&id, &body_id(entry, &module.id))?;
            }
        }
        // The two documents beside the book, from their genesis, so a first
        // writing day or checkpoint never has to create one.
        for side in [DocId::Stats(id.clone()), DocId::Checkpoints(id.clone())] {
            cx.workspace().side_slot(&side, &id, true)?;
        }
        let name = input.name.trim().to_string();
        let n = name.clone();
        cx.write_book_v3(&slot, Replaces::nothing(), move |t| {
            t.meta()
                .name(&n)?
                .summary(&input.summary)?
                .created_at(Some(now()))?;
            dr_doc::v3::apply_novel_project_template_with(t, roots)?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "book", id.as_str(), Some(&name));
        cx.undo_with(Invocation::new(
            "book.trash",
            BookIn {
                book: id.to_string(),
            },
        ));
        Ok(Named {
            id: id.to_string(),
            name,
        })
    }
}
