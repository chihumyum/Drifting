//! V3 search preserves entry/module identity through grouping and navigation.
//! Read-only: the view never creates documents or writes a derived index.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use dr_doc::v3::BorrowedBookV3;
use dr_model::{DocId, id::BookId, v3 as m};
use dr_store::OpenDoc;
use dr_workspace::{Result, Workspace, WsError};

use crate::model::{Field, Row, char_range};

pub type Marks = std::rc::Rc<dyn Fn(&Target) -> (dr_ui::sand::Kind, Option<dr_ui::tokens::Rgb>)>;

/// The shell converts this directly to Target::Entry / Target::Material.
/// No legacy NavTarget or location-link fallback is involved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Entry { id: String, module: Option<String> },
    Material(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jump {
    pub target: Target,
    /// Paragraph N starts at line 2N+1 in the prose navigation contract.
    pub line: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub target: Target,
    pub title: String,
    /// Author-defined template/module names; not inferred entity kinds.
    pub module_name: Option<String>,
    pub rows: Vec<Row>,
}

pub fn jump(group: &Group, row: Option<&Row>) -> Jump {
    Jump {
        target: group.target.clone(),
        line: row.and_then(|r| r.paragraph).map(|n| 2 * n + 1),
    }
}

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
}

/// Same simple Unicode fold as the existing search; scalar offsets become
/// byte ranges only at the rendering boundary.
pub fn find(text: &str, query: &str) -> Option<Range<usize>> {
    let hay: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().collect();
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    let at = hay
        .windows(needle.len())
        .position(|part| part.iter().zip(&needle).all(|(a, b)| fold(*a) == fold(*b)))?;
    Some(at..at + needle.len())
}

fn row(text: &str, query: &str, field: Field, paragraph: Option<u32>) -> Option<Row> {
    let found = find(text, query)?;
    let chars: Vec<char> = text.chars().collect();
    let start = found.start.saturating_sub(24);
    let end = (found.end + 24).min(chars.len());
    let snippet: String = chars[start..end]
        .iter()
        .map(|c| if c.is_control() { ' ' } else { *c })
        .collect();
    Some(Row {
        field,
        highlight: char_range(&snippet, found.start - start, found.len()),
        snippet,
        paragraph,
    })
}

struct Collector<'a> {
    query: &'a str,
    remaining: usize,
    groups: Vec<Group>,
}

impl Collector<'_> {
    fn add(&mut self, target: Target, title: &str, module_name: Option<&str>, rows: Vec<Row>) {
        let rows: Vec<_> = rows.into_iter().take(self.remaining).collect();
        self.remaining -= rows.len();
        if !rows.is_empty() {
            self.groups.push(Group {
                target,
                title: title.to_owned(),
                module_name: module_name.map(str::to_owned),
                rows,
            });
        }
    }
}

/// Search live entries in manuscript tree order, each module in template
/// order, then retained content and materials. Trashed ancestors are excluded
/// before applying the result cap. Templates/comments never enter this list.
pub fn search(ws: &Workspace, book: &str, query: &str, limit: usize) -> Result<Vec<Group>> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let id = BookId::parse(book).map_err(invalid)?;
    let handle = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?;
    let (entries, templates, patches, grids, materials) = handle.read(move |doc| {
        if !dr_doc::v3::is_v3_doc(doc) {
            return Err(invalid("v3 search requires a v3 book"));
        }
        let b = BorrowedBookV3::new(doc, &id).map_err(invalid)?;
        let v = b.view();
        if v.meta().deleted_at.is_some() {
            return Err(invalid("book is in the trash"));
        }
        Ok((
            v.entries(),
            v.templates_map(),
            v.patches(),
            v.plot_grids(),
            v.materials(),
        ))
    })??;
    let map: BTreeMap<_, _> = entries.iter().map(|e| (e.id.clone(), e.clone())).collect();
    let docs = ws.library().docs(Some(book), None)?;
    let stored: BTreeSet<_> = docs.iter().map(|d| d.doc_id.as_str()).collect();
    let mut bodies: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for info in &docs {
        if let Ok(DocId::Body(body)) = DocId::parse(&info.doc_id) {
            bodies
                .entry(body.entry().to_string())
                .or_default()
                .insert(body.module().to_string());
        }
    }
    let live_entries: Vec<_> = entries
        .iter()
        .filter(|e| {
            !e.is_trashed()
                && m::effective_ancestors(&map, &templates, &e.id)
                    .iter()
                    .all(|a| map.get(a).is_some_and(|a| !a.is_trashed()))
        })
        .collect();
    let mut ordered = Vec::new();
    let mut entry_modules = BTreeMap::new();
    for entry in &live_entries {
        let template = entry.effective_template(&templates);
        let mut modules: Vec<String> = template
            .map(|t| t.modules.iter().map(|m| m.id.to_string()).collect())
            .unwrap_or_default();
        if entry.is_level(&templates) {
            modules.insert(0, "about".into());
        }
        let mut retained = bodies.get(entry.id.as_str()).cloned().unwrap_or_default();
        retained.extend(
            entry
                .fields
                .keys()
                .chain(entry.kv.keys())
                .map(ToString::to_string),
        );
        retained.extend(
            patches
                .iter()
                .filter(|p| p.entry == entry.id)
                .map(|p| p.module.to_string()),
        );
        retained.extend(
            grids
                .iter()
                .filter(|g| g.entry == entry.id)
                .map(|g| g.module.to_string()),
        );
        for id in retained {
            if !modules.contains(&id) {
                modules.push(id);
            }
        }
        for module in &modules {
            let doc = format!("body:{}/{module}", entry.id);
            if stored.contains(doc.as_str()) {
                ordered.push(doc);
            }
        }
        entry_modules.insert(entry.id.clone(), modules);
    }
    ordered.extend(
        materials
            .iter()
            .map(|m| format!("material:{}", m.id))
            .filter(|id| stored.contains(id.as_str())),
    );
    let order: Vec<_> = ordered.iter().map(String::as_str).collect();
    let eligible: BTreeSet<_> = order.iter().copied().collect();
    let mut prose: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    if !order.is_empty() {
        // Rank only live document destinations before truncating. Unlisted
        // (trashed/template) hits come last and are never shown. Metadata
        // hits below can reduce, but cannot increase, the body hit budget.
        for hit in ws
            .library()
            .search_in_order(Some(book), query, limit, &order)?
        {
            if eligible.contains(hit.doc_id.as_str())
                && let Some(found) = row(&hit.snippet, query, Field::Body, Some(hit.ord))
            {
                prose.entry(hit.doc_id).or_default().push(found);
            }
        }
    }
    let mut out = Collector {
        query,
        remaining: limit,
        groups: Vec::new(),
    };
    for entry in live_entries {
        if out.remaining == 0 {
            break;
        }
        out.add(
            Target::Entry {
                id: entry.id.to_string(),
                module: None,
            },
            &entry.title,
            None,
            row(&entry.title, query, Field::Title, None)
                .into_iter()
                .collect(),
        );
        let template = entry.effective_template(&templates);
        for module in entry_modules.remove(&entry.id).unwrap_or_default() {
            if out.remaining == 0 {
                break;
            }
            let definition =
                template.and_then(|t| t.modules.iter().find(|m| m.id.as_str() == module));
            let mut rows = Vec::new();
            let mut text = |s: &str, field| {
                if rows.len() < out.remaining
                    && let Some(hit) = row(s, out.query, field, None)
                {
                    rows.push(hit);
                }
            };
            if let Some(fields) = entry
                .fields
                .iter()
                .find(|(id, _)| id.as_str() == module)
                .map(|(_, f)| f)
            {
                for (key, value) in fields {
                    let def = definition.and_then(|m| m.config.defs.iter().find(|f| &f.id == key));
                    // IDs stored in image/reference fields are not prose.
                    if def.is_some_and(|f| {
                        matches!(f.field_type, m::FieldType::Image | m::FieldType::EntityRef)
                    }) {
                        continue;
                    }
                    match value {
                        m::FieldValue::Text(s) => text(s, Field::Summary),
                        m::FieldValue::List(xs) => xs.iter().for_each(|s| text(s, Field::Summary)),
                        _ => {}
                    }
                }
            }
            if let Some(kv) = entry
                .kv
                .iter()
                .find(|(id, _)| id.as_str() == module)
                .map(|(_, kv)| kv)
            {
                for item in kv {
                    text(&format!("{} {}", item.key, item.value), Field::Description);
                }
            }
            for patch in patches
                .iter()
                .filter(|p| p.entry == entry.id && p.module.as_str() == module)
            {
                text(
                    &format!(
                        "{} {}",
                        patch.title.as_deref().unwrap_or_default(),
                        patch.body
                    ),
                    Field::Patch,
                );
            }
            for grid in grids
                .iter()
                .filter(|g| g.entry == entry.id && g.module.as_str() == module)
            {
                for s in grid
                    .rows
                    .iter()
                    .map(|l| &l.label)
                    .chain(grid.cols.iter().map(|l| &l.label))
                    .chain(grid.cells.values())
                {
                    text(s, Field::Description);
                }
            }
            rows.extend(
                prose
                    .remove(&format!("body:{}/{module}", entry.id))
                    .unwrap_or_default(),
            );
            out.add(
                Target::Entry {
                    id: entry.id.to_string(),
                    module: Some(module),
                },
                &entry.title,
                definition.map(|m| m.name.as_str()),
                rows,
            );
        }
    }
    for material in materials {
        if out.remaining == 0 {
            break;
        }
        let mut rows: Vec<_> = [
            row(&material.title, query, Field::Title, None),
            row(&material.description, query, Field::Description, None),
        ]
        .into_iter()
        .flatten()
        .collect();
        rows.extend(
            prose
                .remove(&format!("material:{}", material.id))
                .unwrap_or_default(),
        );
        out.add(
            Target::Material(material.id.to_string()),
            &material.title,
            None,
            rows,
        );
    }
    Ok(out.groups)
}
