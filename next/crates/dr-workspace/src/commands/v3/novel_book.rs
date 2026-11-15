//! `project.create`: unified project creation from a [`ProjectTemplateValue`]
//! (built-in writing template, library `project-template:<id>`, or inline value).
//! The one command that may name the built-in template (`cutover` gate,
//! `kernel-v4.md` §9, `kernel-v5.md` §2, `project-templates.md` §8); everything
//! else recognises entries by their data.
use super::types::ProjectCreateTemplate;
use super::*;
use crate::Actor;
use dr_doc::project_template::{
    BorrowedProjectTemplate, apply_materialized_project_template, from_seed_template,
    has_authored_paragraphs, materialize_project_template, write_prose_paragraphs,
};
use dr_doc::prose::BorrowedProse;
use dr_doc::v3::BorrowedBookV3;
use dr_model::project_template::{ProjectTemplateValue, StoredTemplateOrigin};
use dr_store::{Library, OpenDoc, StoreError};

/// Guard tracking every document created by `project.create` so any failure
/// before `book:<id>` finishes committing purges and forgets every partial
/// document, leaving no half-created project (`project-templates.md` §8 & §14).
struct Written<'a> {
    lib: &'a Library,
    docs: Vec<String>,
    committed: bool,
}

impl<'a> Written<'a> {
    fn new(lib: &'a Library) -> Self {
        Self {
            lib,
            docs: Vec::new(),
            committed: false,
        }
    }

    fn record(&mut self, doc_id: String) {
        self.docs.push(doc_id);
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for Written<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for doc_id in self.docs.iter().rev() {
            let _ = self
                .lib
                .purge_doc(doc_id)
                .and_then(|()| self.lib.forget_purged(doc_id));
        }
    }
}

fn resolve_template_and_source(
    cx: &Cx<'_>,
    project_name: &str,
    template: Option<ProjectCreateTemplate>,
) -> Result<(ProjectTemplateValue, Option<m::ProjectTemplateRef>)> {
    match template {
        None => Ok((
            dr_doc::v3::novel_project_template_value(),
            Some(dr_doc::v3::novel_project_template_source()),
        )),
        Some(ProjectCreateTemplate::Library { template_id }) => {
            let pt_id: ProjectTemplateDocId = pid("project_template", &template_id)?;
            let doc_str = DocId::ProjectTemplate(pt_id.clone()).to_string();
            let lib = cx.workspace().library();
            if lib.doc_info(&doc_str)?.is_none() {
                return Err(WsError::not_found("project_template", &template_id));
            }
            let raw = lib.load_copy(&doc_str)?;
            let borrowed = BorrowedProjectTemplate::new(&raw, &pt_id)?;
            let view = borrowed.view();
            let info = view
                .info()
                .ok_or_else(|| WsError::invalid("saved project template is missing metadata"))?;
            let val = view.value().map_err(|e| WsError::invalid(e.to_string()))?;
            let origin = match info.origin {
                StoredTemplateOrigin::Own => m::ProjectTemplateOrigin::Own,
                StoredTemplateOrigin::File => m::ProjectTemplateOrigin::File,
            };
            let source = m::ProjectTemplateRef {
                id: pt_id.to_string(),
                version: info.revision,
                origin: Some(origin),
                name: Some(val.name.clone()),
                credit: val.credit.clone().filter(|c| !c.is_empty()),
            };
            Ok((val, Some(source)))
        }
        Some(ProjectCreateTemplate::Value { value, source }) => {
            let val = *value;
            let resolved_source = match source {
                Some(src_dto) => {
                    let mut s = src_dto.into_model()?;
                    if s.name.is_none() {
                        s.name = Some(val.name.clone());
                    }
                    if s.credit.is_none() {
                        s.credit = val.credit.clone().filter(|c| !c.is_empty());
                    }
                    Some(s)
                }
                None => Some(m::ProjectTemplateRef {
                    id: "template:value".into(),
                    version: val.revision,
                    origin: Some(m::ProjectTemplateOrigin::File),
                    name: Some(val.name.clone()),
                    credit: val.credit.clone().filter(|c| !c.is_empty()),
                }),
            };
            Ok((val, resolved_source))
        }
        Some(ProjectCreateTemplate::Seed(raw_seed)) => {
            let seed_pt = project::validate_project_template(*raw_seed)?;
            let rev = seed_pt
                .project
                .source
                .as_ref()
                .map(|s| s.version.max(1))
                .unwrap_or(1);
            let source = seed_pt.project.source.clone();
            let val = from_seed_template(&seed_pt, project_name, "", rev)
                .map_err(|e| WsError::invalid(e.to_string()))?;
            Ok((val, source))
        }
    }
}

fn open_and_write_prose(
    written: &mut Written<'_>,
    book: &BookId,
    doc: &DocId,
    origin: dr_store::Origin,
    agent: Option<dr_store::AgentWrite>,
    paragraphs: Option<&[dr_model::project_template::TemplateParagraph]>,
    entry_map: &BTreeMap<String, EntryId>,
) -> Result<()> {
    let lib = written.lib;
    let doc_str = doc.to_string();
    let Some(paras) = paragraphs.filter(|p| has_authored_paragraphs(p)) else {
        lib.register(&doc_str, doc.kind().prefix(), Some(book.as_str()))?;
        written.record(doc_str);
        return Ok(());
    };
    let g = dr_doc::prose::genesis(doc);
    let genesis = move |d: &loro::LoroDoc| {
        if let Err(e) = d.import(&g) {
            log::error!("prose genesis: {e}");
        }
    };
    let handle = lib.open_doc(
        &doc_str,
        OpenDoc::CreateIfMissing {
            kind: doc.kind().prefix(),
            book_id: Some(book.as_str()),
            genesis: &genesis,
        },
    )?;
    written.record(doc_str);
    let doc_cloned = doc.clone();
    let paras_vec = paras.to_vec();
    let map_cloned = entry_map.clone();
    let res = crate::holder::write(&handle, origin, agent, move |raw_doc| {
        let b = BorrowedProse::new(raw_doc, &doc_cloned)?;
        let mut txn = b.txn();
        write_prose_paragraphs(&mut txn, &paras_vec, &map_cloned)?;
        Ok(())
    })
    .and_then(|()| handle.reindex_now().map(|_| ()).map_err(WsError::from));
    handle.close();
    res
}

op! {
    ProjectCreate = "project.create", Write, Library, "Create a project from a project template (defaults to the built-in writing template).",
    fn(cx, input: super::super::book::BookCreateIn) -> Named {
        name_ok(&input.name)?;
        let trimmed_name = input.name.trim().to_string();

        // 1. Resolve and validate template + provenance, then materialize all fresh IDs
        //    before touching storage (`project-templates.md` §8 & §14).
        let (val, source) = resolve_template_and_source(cx, &trimmed_name, input.template)?;
        let mat = Arc::new(
            materialize_project_template(&val, source)
                .map_err(|e| WsError::invalid(e.to_string()))?,
        );

        let id = BookId::new_v7();
        let lib = cx.workspace().library();
        let mut written = Written::new(lib);

        let prose_origin = match cx.actor() {
            Actor::User => dr_store::Origin::Command,
            other => other.store_origin(),
        };
        let agent_meta = cx
            .actor()
            .agent_write(&format!("project.create: {trimmed_name}"));

        // 2. Write prose documents FIRST (`template:<book>/<tpl>/<mod>`, then `body:<entry>/<mod>`).
        for ((tpl_id, mod_id), paras) in &mat.template_prose {
            if has_authored_paragraphs(paras) {
                let tdoc = template_doc(&id, tpl_id, mod_id)?;
                open_and_write_prose(
                    &mut written,
                    &id,
                    &tdoc,
                    prose_origin.clone(),
                    agent_meta.clone(),
                    Some(paras),
                    &mat.entry_map,
                )?;
            }
        }

        let templates_map: BTreeMap<EntryTemplateId, &m::EntryTemplate> =
            mat.templates.iter().map(|t| (t.id.clone(), t)).collect();
        for entry in &mat.entries {
            if let Some(tpl_id) = &entry.template
                && let Some(tpl) = templates_map.get(tpl_id)
            {
                for module in tpl.prose_modules() {
                    let bdoc = body_id(&entry.id, &module.id);
                    open_and_write_prose(
                        &mut written,
                        &id,
                        &bdoc,
                        prose_origin.clone(),
                        agent_meta.clone(),
                        entry.prose.get(&module.id).map(Vec::as_slice),
                        &mat.entry_map,
                    )?;
                }
            }
        }

        cx.faults().check("after_prose")?;

        // 3. Write side documents (`stats:<book>`, `checkpoints:<book>`, `layout:<book>`).
        for side in [
            DocId::Stats(id.clone()),
            DocId::Checkpoints(id.clone()),
            DocId::Layout(id.clone()),
        ] {
            let side_str = side.to_string();
            let g = dr_doc::side::genesis(&side).expect("side genesis");
            let genesis = move |d: &loro::LoroDoc| {
                if let Err(e) = d.import(&g) {
                    log::error!("side genesis: {e}");
                }
            };
            let handle = lib.open_doc(
                &side_str,
                OpenDoc::CreateIfMissing {
                    kind: side.kind().prefix(),
                    book_id: Some(id.as_str()),
                    genesis: &genesis,
                },
            )?;
            written.record(side_str);
            handle.close();
        }

        cx.faults().check("after_side")?;

        // 4. Write `book:<id>` LAST (`project-templates.md` §8).
        let book_doc_str = DocId::Book(id.clone()).to_string();
        let g = dr_doc::v3::book_genesis(&id);
        let genesis = move |d: &loro::LoroDoc| {
            if let Err(e) = d.import(&g) {
                log::error!("book genesis: {e}");
            }
        };
        let handle = lib.open_doc(
            &book_doc_str,
            OpenDoc::CreateIfMissing {
                kind: "book",
                book_id: Some(id.as_str()),
                genesis: &genesis,
            },
        )?;
        written.record(book_doc_str);

        let write_book_res = cx.faults().check("in_book").and_then(|()| {
            let book_for_txn = id.clone();
            let name_for_txn = trimmed_name.clone();
            let summary_for_txn = input.summary;
            let mat_for_txn = Arc::clone(&mat);
            let created = now();
            crate::holder::write(
                &handle,
                cx.actor().store_origin(),
                agent_meta,
                move |raw_doc| {
                    let b = BorrowedBookV3::new(raw_doc, &book_for_txn)?;
                    let mut txn = b.txn();
                    txn.meta()
                        .name(&name_for_txn)?
                        .summary(&summary_for_txn)?
                        .created_at(Some(created))?;
                    apply_materialized_project_template(&mut txn, &mat_for_txn, created)?;
                    Ok(())
                },
            )
        });
        handle.close();
        write_book_res?;

        // Warm the book slot and its three side slots in `Workspace`, then commit `Written`.
        let _ = cx
            .workspace()
            .book_slot(&id)
            .map_err(|e| match e {
                WsError::Store(StoreError::NotFound(_)) => {
                    WsError::Internal("newly created book missing".into())
                }
                other => other,
            })?;
        for side in [
            DocId::Stats(id.clone()),
            DocId::Checkpoints(id.clone()),
            DocId::Layout(id.clone()),
        ] {
            cx.workspace().side_slot(&side, &id, false)?;
        }
        written.commit();

        cx.effect(EffectAction::Created, "book", id.as_str(), Some(&trimmed_name));
        cx.undo_with(Invocation::new(
            "book.trash",
            BookIn {
                book: id.to_string(),
            },
        ));
        Ok(Named {
            id: id.to_string(),
            name: trimmed_name,
        })
    }
}
