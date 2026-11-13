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

/// The manuscript sequence's documents with their labels: an entry's first
/// book prose carries the entry's title, later ones their module's name.
fn manuscript_docs_of(s: &dr_doc::v3::BookStructureV3) -> Vec<(String, String)> {
    s.manuscript()
        .into_iter()
        .flat_map(|p| p.entries)
        .flat_map(|e| {
            let title = e.entry.title.clone();
            e.prose.into_iter().enumerate().map(move |(i, p)| {
                (
                    p.doc.to_string(),
                    if i == 0 { title.clone() } else { p.name },
                )
            })
        })
        .collect()
}

/// Flattens `from` and everything below it for the book view
/// (`kernel-v4.md` §7): `from`'s own book prose first, then depth-first in
/// manuscript and membership order, keeping entries that carry no book prose
/// so the view renders their headings and hierarchy.
pub fn flatten_book(
    view: &BookViewV3<'_>,
    from: &dr_model::id::EntryId,
) -> Result<Vec<crate::book::BookSection>, dr_doc::v3::NotALevel> {
    let structure = view.structure_snapshot();
    let flat = structure.flatten(
        from,
        dr_doc::v3::Flatten {
            in_book_only: true,
            include_members: true,
        },
    )?;
    let mut out = Vec::new();
    for e in flat {
        let entry = e.entry.id.to_string();
        let title = e.entry.title.clone();
        if e.prose.is_empty() {
            out.push(crate::book::BookSection {
                entry,
                title,
                depth: e.depth,
                doc: None,
            });
        } else {
            for (i, p) in e.prose.into_iter().enumerate() {
                out.push(crate::book::BookSection {
                    entry: entry.clone(),
                    title: if i == 0 { title.clone() } else { p.name },
                    depth: if i == 0 { e.depth } else { e.depth + 1 },
                    doc: Some(p.doc.to_string()),
                });
            }
        }
    }
    Ok(out)
}

/// Outermost manuscript level entries of the book, in manuscript order.
pub fn manuscript_roots(view: &BookViewV3<'_>) -> Vec<dr_model::id::EntryId> {
    let structure = view.structure_snapshot();
    structure
        .manuscript()
        .into_iter()
        .map(|p| p.root.id.clone())
        .collect()
}

pub(crate) fn page_infos(
    ws: &Workspace,
    book: &str,
    docs: &[String],
) -> Result<Vec<crate::page::PageInfo>, WsError> {
    let docs = docs.to_vec();
    read(ws, book, move |view| {
        let structure = view.structure_snapshot();
        let entries = structure.entries_map();
        let templates = structure.templates_map();
        let number_by_id: std::collections::HashMap<dr_model::id::EntryId, u32> = structure
            .manuscript()
            .into_iter()
            .flat_map(|p| p.entries)
            .filter_map(|e| Some((e.entry.id.clone(), e.ordinal?)))
            .collect();
        let is_active_lane = |host: &dr_model::id::EntryId| {
            structure
                .level_settings(host)
                .is_some_and(|s| s.settings.lane)
        };
        docs.iter()
            .map(|doc| {
                let mut info = crate::page::PageInfo::blank(doc);
                let Some((id, module)) = body(doc) else {
                    return info;
                };
                let Ok(eid) = dr_model::id::EntryId::parse(&id) else {
                    return info;
                };
                let Some(entry) = entries.get(&eid) else {
                    return info;
                };
                info.title = entry.title.clone();
                let template = entry.effective_template(templates);
                info.template_name = template.map(|t| t.name.clone()).unwrap_or_default();
                let is_primary_book_prose = match template {
                    Some(t) => t
                        .book_prose_modules()
                        .next()
                        .is_some_and(|m| m.id.as_str() == module),
                    None => true,
                };
                if is_primary_book_prose {
                    info.chrome = true;
                    info.number = number_by_id.get(&eid).copied();
                    info.kind = if info.number.is_some() {
                        crate::page::PageKind::Chapter
                    } else {
                        crate::page::PageKind::Other
                    };
                }
                let mut own_color = None;
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
                            info.has_synopsis = true;
                            info.synopsis = field(&m.config.summary_field);
                        }
                        if m.config.status_field.is_some() {
                            info.has_status = true;
                            info.status = field(&m.config.status_field);
                        }
                        if own_color.is_none()
                            && let Some(key) = m.config.color_field.as_ref()
                            && let Some(c) = fields
                                .and_then(|f| f.get(key))
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                        {
                            own_color = Some(c.to_owned());
                        }
                    }
                    // Secondary prose modules carry their own module name rather than the entry heading.
                    if !is_primary_book_prose && t.prose_modules().nth(1).is_some() {
                        info.title = t
                            .modules
                            .iter()
                            .find(|m| m.id.as_str() == module)
                            .map(|m| m.name.clone())
                            .unwrap_or_default();
                    }
                }
                let lane_host = entry
                    .primary
                    .as_ref()
                    .filter(|p| {
                        is_active_lane(p)
                            && structure
                                .memberships()
                                .iter()
                                .any(|m| m.member == eid && &m.host == *p)
                    })
                    .or_else(|| {
                        structure
                            .memberships()
                            .iter()
                            .find(|m| m.member == eid && is_active_lane(&m.host))
                            .map(|m| &m.host)
                    });
                if let Some(host_id) = lane_host
                    && let Some(lane) = entries.get(host_id)
                {
                    let lane_tpl = lane.effective_template(templates);
                    let color = lane_tpl
                        .and_then(|t| {
                            t.modules.iter().find_map(|m| {
                                let key = m.config.color_field.as_ref()?;
                                lane.fields
                                    .get(&m.id)?
                                    .get(key)?
                                    .as_str()
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned)
                            })
                        })
                        .or_else(|| {
                            lane_tpl
                                .and_then(|t| t.color.as_deref())
                                .filter(|s| !s.is_empty())
                                .map(str::to_owned)
                        })
                        .unwrap_or_default();
                    info.storyline = Some(crate::page::StorylineMark {
                        id: host_id.to_string(),
                        name: lane.title.clone(),
                        color,
                    });
                }
                info.color = own_color
                    .or_else(|| {
                        template
                            .and_then(|t| t.color.as_deref())
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    })
                    .or_else(|| {
                        info.storyline
                            .as_ref()
                            .map(|s| s.color.as_str())
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    });
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
        .read(dr_doc::v3::is_book_doc)?)
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
