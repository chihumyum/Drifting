//! Canonical page facts from actual entry/template/module identities.
use dr_doc::v3::{BookReaderV3, BookViewV3};
use dr_model::{DocId, id::BookId};
use dr_store::OpenDoc;
use dr_workspace::{Actor, Workspace, WsError};
use serde_json::{Value, json};

pub fn body(doc: &str) -> Option<(String, String)> {
    match DocId::parse(doc).ok()? {
        DocId::Body(id) => Some((id.entry().to_string(), id.module().to_string())),
        _ => None,
    }
}

pub fn read<R: Send + 'static>(
    ws: &Workspace,
    book: &str,
    f: impl FnOnce(BookViewV3<'_>) -> R + Send + 'static,
) -> Result<R, WsError> {
    let id = BookId::parse(book).map_err(|e| WsError::Invalid(e.to_string()))?;
    let handle = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?;
    handle
        .read(move |d| {
            let reader = BookReaderV3::from_loro(id, d)?;
            Ok::<_, dr_doc::DocError>(f(reader.view()))
        })?
        .map_err(Into::into)
}

pub fn call(ws: &Workspace, name: &str, input: Value) -> Result<Value, WsError> {
    Ok(ws.call(&Actor::User, name, input)?["output"].clone())
}

pub fn prepare_body(
    ws: &Workspace,
    book: &str,
    entry: &str,
    module: &str,
) -> Result<crate::SessionSource, WsError> {
    if let (Ok(eid), Ok(mid)) = (
        dr_model::id::EntryId::parse(entry),
        dr_model::id::ModuleId::parse(module),
    ) {
        let doc = dr_model::DocId::Body(dr_model::id::BodyDocId::new(eid.clone(), mid)).to_string();
        if ws
            .library()
            .doc_info(&doc)?
            .is_some_and(|d| d.book_id.as_deref() == Some(book))
            && ws.is_live_entry(book, &eid)?
        {
            return crate::SessionSource::open_verified_v3(ws, &doc);
        }
    }
    let result = call(
        ws,
        "module.prose_document",
        json!({"book": book, "owner": entry, "module": module}),
    )?;
    let doc = result["id"]
        .as_str()
        .ok_or_else(|| WsError::Invalid("module.prose_document returned no document".into()))?;
    crate::SessionSource::open_verified_v3(ws, doc)
}

fn manuscript_docs_from(
    ordered: &[dr_model::v3::Entry],
    entries: &std::collections::BTreeMap<dr_model::id::EntryId, dr_model::v3::Entry>,
    templates: &std::collections::BTreeMap<
        dr_model::id::EntryTemplateId,
        dr_model::v3::EntryTemplate,
    >,
) -> Vec<(String, String)> {
    let levels = dr_model::v3::effective_manuscript_levels(entries, templates);
    ordered
        .iter()
        .filter(|e| levels.contains(&e.id))
        .flat_map(|level| {
            ordered.iter().filter(|e| {
                if e.is_trashed() || !e.is_leaf(templates) {
                    return false;
                }
                let anc = dr_model::v3::effective_ancestors(entries, templates, &e.id);
                anc.contains(&level.id)
                    && anc
                        .iter()
                        .all(|a| entries.get(a).is_some_and(|ae| !ae.is_trashed()))
            })
        })
        .flat_map(|entry| {
            entry
                .effective_template(templates)
                .into_iter()
                .flat_map(|t| t.prose_modules())
                .enumerate()
                .map(|(i, m)| {
                    (
                        format!("body:{}/{}", entry.id, m.id),
                        if i == 0 {
                            entry.title.clone()
                        } else {
                            m.name.clone()
                        },
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// One visit, in manuscript tree order; every prose module keeps its own document.
pub fn manuscript_docs(view: &BookViewV3<'_>) -> Vec<(String, String)> {
    let ordered = view.entries_raw();
    let entries: std::collections::BTreeMap<_, _> =
        ordered.iter().map(|e| (e.id.clone(), e.clone())).collect();
    let templates = view.templates_map();
    manuscript_docs_from(&ordered, &entries, &templates)
}

pub(crate) fn page_infos(
    ws: &Workspace,
    book: &str,
    docs: &[String],
) -> Result<Vec<crate::page::PageInfo>, WsError> {
    let docs = docs.to_vec();
    read(ws, book, move |view| {
        let ordered = view.entries_raw();
        let entries: std::collections::BTreeMap<_, _> =
            ordered.iter().map(|e| (e.id.clone(), e.clone())).collect();
        let templates = view.templates_map();
        let manuscript = manuscript_docs_from(&ordered, &entries, &templates);
        let mut numbered = Vec::new();
        let mut number_by_id = std::collections::HashMap::new();
        for (doc, _) in manuscript {
            if let Some((id, _)) = body(&doc)
                && !number_by_id.contains_key(&id)
            {
                numbered.push(id.clone());
                number_by_id.insert(id, numbered.len() as u32);
            }
        }
        docs.iter()
            .map(|doc| {
                let mut info = crate::page::PageInfo::blank(doc);
                let Some((id, module)) = body(doc) else {
                    return info;
                };
                let Some(entry) = dr_model::id::EntryId::parse(&id)
                    .ok()
                    .and_then(|eid| entries.get(&eid))
                else {
                    return info;
                };
                info.title = entry.title.clone();
                let template = entry.effective_template(&templates);
                // The familiar folio is only for the built-in novel templates.
                info.kind = match template.map(|t| t.id.as_str()) {
                    Some("tpl-chapter") => crate::page::PageKind::Chapter,
                    Some("tpl-idea") => crate::page::PageKind::Idea,
                    _ => crate::page::PageKind::Other,
                };
                info.number = number_by_id.get(&id).copied();
                if let Some(t) = template {
                    for m in &t.modules {
                        let fields = entry.fields.get(&m.id);
                        let field = |key: &Option<String>| {
                            key.as_ref()
                                .and_then(|k| fields?.get(k))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string()
                        };
                        if m.config.summary_field.is_some() {
                            info.synopsis = field(&m.config.summary_field);
                        }
                        if m.config.status_field.is_some() {
                            info.status = field(&m.config.status_field);
                        }
                    }
                    // Repeated body modules use their own name; only the first owns the entry heading.
                    if t.prose_modules()
                        .next()
                        .is_some_and(|m| m.id.as_str() != module)
                    {
                        info.title = t
                            .modules
                            .iter()
                            .find(|m| m.id.as_str() == module)
                            .map(|m| m.name.clone())
                            .unwrap_or_default();
                        info.kind = crate::page::PageKind::Other;
                    }
                }
                if let Some(primary) = &entry.primary
                    && let Some(lane) = entries.get(primary)
                {
                    let template = lane.effective_template(&templates);
                    let color = template
                        .and_then(|t| {
                            t.modules.iter().find_map(|m| {
                                let key = m.config.color_field.as_ref()?;
                                lane.fields
                                    .get(&m.id)?
                                    .get(key)?
                                    .as_str()
                                    .map(str::to_owned)
                            })
                        })
                        .or_else(|| template.and_then(|t| t.color.clone()))
                        .unwrap_or_default();
                    info.storyline = Some(crate::page::StorylineMark {
                        id: primary.to_string(),
                        name: lane.title.clone(),
                        color,
                    });
                }
                info
            })
            .collect()
    })
}

pub fn set_role_field(
    ws: &Workspace,
    book: &str,
    doc: &str,
    role: &str,
    value: &str,
) -> Result<bool, WsError> {
    let (entry, _) = body(doc).ok_or_else(|| WsError::Invalid("not a body document".into()))?;
    let query_entry = entry.clone();
    let role = role.to_owned();
    let selected = read(ws, book, move |v| {
        let e = v
            .entries()
            .into_iter()
            .find(|e| e.id.as_str() == query_entry)?;
        let templates = v.templates_map();
        let t = e.effective_template(&templates)?;
        t.modules.iter().find_map(|m| {
            let key = match role.as_str() {
                "summary" => &m.config.summary_field,
                "status" => &m.config.status_field,
                _ => return None,
            }
            .as_ref()?;
            Some((
                m.id.to_string(),
                key.clone(),
                e.fields
                    .get(&m.id)
                    .and_then(|f| f.get(key))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            ))
        })
    })?
    .ok_or_else(|| WsError::Invalid("template has no requested field role".into()))?;
    if selected.2 == value {
        return Ok(false);
    }
    call(
        ws,
        "module.set_field",
        json!({"book": book, "entry": entry, "module": selected.0, "field": selected.1, "value": value}),
    )?;
    Ok(true)
}

/// Read the schema marker; callers refuse any noncanonical book.
pub fn is_book(ws: &Workspace, book: &str) -> Result<bool, WsError> {
    Ok(ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(dr_doc::v3::is_v3_doc)?)
}

pub struct LinkTargets {
    pub workspace: Workspace,
    pub book: String,
}
impl crate::links::LinkTargets for LinkTargets {
    fn alive(&self, kind: &dr_model::kind::EntityKind, id: &str) -> bool {
        if !matches!(
            kind,
            dr_model::kind::EntityKind::Entry | dr_model::kind::EntityKind::Material
        ) {
            return false;
        }
        let target = dr_model::shared::EntityRef::new(kind.clone(), id);
        read(&self.workspace, &self.book, move |v| {
            v.entity_exists(&target)
        })
        .unwrap_or(false)
    }

    fn snapshot(&self) -> Option<crate::links::TargetSnapshot> {
        read(&self.workspace, &self.book, |v| {
            let entries = v
                .entries_raw()
                .into_iter()
                .filter(|e| !e.is_trashed())
                .map(|e| e.id.to_string())
                .collect();
            let materials = v
                .materials()
                .into_iter()
                .map(|m| m.id.to_string())
                .collect();
            (entries, materials)
        })
        .ok()
    }
}
