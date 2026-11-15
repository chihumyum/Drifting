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

fn doc_uses_note_shortcuts(
    doc_id: &str,
    entries: &std::collections::BTreeMap<dr_model::id::EntryId, dr_model::v3::Entry>,
    templates: &std::collections::BTreeMap<
        dr_model::id::EntryTemplateId,
        dr_model::v3::EntryTemplate,
    >,
) -> bool {
    match DocId::parse(doc_id) {
        Ok(DocId::Template(t)) => t.entry_module().is_some(),
        Ok(DocId::Body(b)) => {
            let Some(entry) = entries.get(b.entry()) else {
                return false;
            };
            dr_model::v3::resolve_level_settings(entry.parent.as_ref(), entries, templates)
                .format_shortcuts
                != dr_model::v3::FormatShortcuts::Plain
        }
        _ => false,
    }
}

/// Whether typing convenience rules (`- `, `1. `, `[ ] `, `==字==`, `` `code` ``,
/// ```` ``` ````) are active for `doc_id`, resolved from its resident parent
/// level's `format_shortcuts` (`kernel-v4.md` §3, `kernel-v5.md` §6).
pub fn uses_note_shortcuts(ws: &Workspace, book: &str, doc_id: &str) -> bool {
    match DocId::parse(doc_id) {
        Ok(DocId::Template(t)) => t.entry_module().is_some(),
        Ok(DocId::Body(_)) => {
            let doc = doc_id.to_owned();
            read(ws, book, move |v| {
                let entries = v.entries_map();
                let templates = v.templates_map();
                doc_uses_note_shortcuts(&doc, &entries, &templates)
            })
            .unwrap_or(false)
        }
        _ => false,
    }
}

/// Resolves [`uses_note_shortcuts`] for each chapter document in `docs` in one
/// book read.
pub fn book_note_shortcuts(ws: &Workspace, book: &str, docs: &[String]) -> Vec<bool> {
    if docs.is_empty() {
        return Vec::new();
    }
    let len = docs.len();
    let owned = docs.to_vec();
    read(ws, book, move |v| {
        let entries = v.entries_map();
        let templates = v.templates_map();
        owned
            .iter()
            .map(|d| doc_uses_note_shortcuts(d, &entries, &templates))
            .collect()
    })
    .unwrap_or_else(|_| vec![false; len])
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

fn sections_from_flat(flat: Vec<dr_doc::v3::FlatEntry<'_>>) -> Vec<crate::book::BookSection> {
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
    out
}

/// Flattens a [`dr_model::v3::BookRoot`] (`Root`, `Entry`, `View`, or `Lane`)
/// via the unified [`dr_doc::v3::BookStructureV3::sequence`] reader
/// (`kernel-v5.md` §3, §16), keeping entries without `in_book` prose so the
/// view renders their headings and hierarchy.
pub fn flatten_book_root(
    view: &BookViewV3<'_>,
    root: &dr_model::v3::BookRoot,
) -> Result<Vec<crate::book::BookSection>, dr_doc::v3::InvalidBookRoot> {
    let structure = view.structure_snapshot();
    let flat = structure.sequence(root, true)?;
    Ok(sections_from_flat(flat))
}

/// Flattens `from` and everything below it for the book view
/// (`kernel-v4.md` §7): `from`'s own book prose first, then depth-first in
/// manuscript and membership order, keeping entries that carry no book prose
/// so the view renders their headings and hierarchy.
pub fn flatten_book(
    view: &BookViewV3<'_>,
    from: &dr_model::id::EntryId,
) -> Result<Vec<crate::book::BookSection>, dr_doc::v3::NotALevel> {
    flatten_book_root(
        view,
        &dr_model::v3::BookRoot::Entry {
            entry: from.clone(),
        },
    )
    .map_err(|_| dr_doc::v3::NotALevel(from.clone()))
}

/// Level entry configured as the project's book start (`project.book.root`), when applicable.
pub fn manuscript_roots(view: &BookViewV3<'_>) -> Vec<dr_model::id::EntryId> {
    let structure = view.structure_snapshot();
    match structure.project().book.as_ref().map(|b| &b.root) {
        Some(r @ dr_model::v3::BookRoot::Entry { entry }) if structure.is_valid_book_root(r) => {
            vec![entry.clone()]
        }
        _ => Vec::new(),
    }
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
        let views: Vec<_> = structure.timeline_views().cloned().collect();
        let number_by_id: std::collections::HashMap<dr_model::id::EntryId, u32> = structure
            .book_sequence()
            .into_iter()
            .filter_map(|e| Some((e.entry.id.clone(), e.ordinal?)))
            .collect();
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
                // The lane and colour every surface shows (`kernel-v4.md` §9).
                let memberships = structure.memberships();
                if let Some(host_id) =
                    dr_model::v3::primary_lane(entry, entries, templates, memberships, &views)
                    && let Some(lane) = entries.get(host_id)
                {
                    info.storyline = Some(crate::page::StorylineMark {
                        id: host_id.to_string(),
                        name: lane.title.clone(),
                        color: dr_model::v3::lane_color(lane, templates).unwrap_or_default(),
                    });
                }
                info.color =
                    dr_model::v3::entry_color(entry, entries, templates, memberships, &views);
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
        let normalized = match kind {
            dr_model::kind::EntityKind::Entry => dr_model::kind::EntityKind::Entry,
            dr_model::kind::EntityKind::Asset | dr_model::kind::EntityKind::Material => {
                dr_model::kind::EntityKind::Asset
            }
            _ => return false,
        };
        let target = dr_model::shared::EntityRef::new(normalized, id);
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
            let assets = v.assets().into_iter().map(|a| a.id.to_string()).collect();
            (entries, assets)
        })
        .ok()
    }

    fn pdf_assets(&self) -> std::collections::HashSet<String> {
        read(&self.workspace, &self.book, |v| {
            v.assets()
                .into_iter()
                .filter(|a| a.kind == dr_model::kind::AssetKind::Pdf)
                .map(|a| a.id.to_string())
                .collect()
        })
        .unwrap_or_default()
    }
}
