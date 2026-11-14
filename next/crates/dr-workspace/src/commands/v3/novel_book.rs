//! `project.create`: a new book from a [`m::ProjectTemplate`] (defaults to the
//! built-in writing template). The one command that may name the built-in
//! template (`cutover` gate, `kernel-v4.md` §9, `kernel-v5.md` §2); everything
//! else recognises entries by their data.
use super::*;

op! {
    ProjectCreate = "project.create", Write, Library, "Create a project from a project template (defaults to the built-in writing template).",
    fn(cx, input: super::super::book::BookCreateIn) -> Named {
        name_ok(&input.name)?;
        let pt = match input.template {
            Some(tpl) => project::validate_project_template(tpl)?,
            None => dr_doc::v3::novel_project_template(),
        };
        let id = BookId::new_v7();
        let slot = cx.workspace().book_slot_or_create_v3(&id)?;
        let templates: BTreeMap<EntryTemplateId, m::EntryTemplate> = pt
            .templates
            .iter()
            .map(|t| (t.id.clone(), t.clone()))
            .collect();
        // Every seed entry gets a body document for each prose module of its
        // template, registered before the book document is committed.
        for entry in &pt.entries {
            if let Some(tpl_id) = &entry.template
                && let Some(tpl) = templates.get(tpl_id)
            {
                for module in tpl.prose_modules() {
                    cx.create_prose(&id, &body_id(&entry.id, &module.id))?;
                }
            }
        }
        // The documents beside the book, from their genesis, so a first
        // writing day, checkpoint or canvas drag never has to create one.
        for side in [
            DocId::Stats(id.clone()),
            DocId::Checkpoints(id.clone()),
            DocId::Layout(id.clone()),
        ] {
            cx.workspace().side_slot(&side, &id, true)?;
        }
        let name = input.name.trim().to_string();
        let n = name.clone();
        cx.write_book_v3(&slot, Replaces::nothing(), move |t| {
            t.meta()
                .name(&n)?
                .summary(&input.summary)?
                .created_at(Some(now()))?;
            dr_doc::v3::apply_project_template(t, &pt)?;
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
