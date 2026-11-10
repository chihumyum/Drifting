//! V3 material associations, read without a legacy navigation conversion.

use std::collections::{BTreeMap, HashSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{id::BookId, kind::EntityKind, shared::EntityRef, v3 as model};
use dr_store::OpenDoc;
use dr_workspace::{Result, Workspace, WsError};

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryLink {
    pub id: String,
    pub title: String,
    pub linked: bool,
}

/// The live entry choices and this material's built-in associations.
pub fn entry_links(ws: &Workspace, book: &str, material: &str) -> Result<Vec<EntryLink>> {
    let book_id = BookId::parse(book).map_err(invalid)?;
    let material = material.to_owned();
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_v3_doc(doc) {
                return Err(invalid("v3 materials require a v3 book"));
            }
            let book = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let view = book.view();
            let own = EntityRef::new(EntityKind::Material, material);
            if view.meta().deleted_at.is_some() || !view.entity_exists(&own) {
                return Err(invalid("material is unavailable"));
            }
            let ty = dr_doc::catalog::generic_relation_type_id(&book_id);
            let linked: HashSet<_> = view
                .relations_raw()
                .into_iter()
                .filter(|r| {
                    r.relation_type == ty && r.from == own && r.to.kind == EntityKind::Entry
                })
                .map(|r| r.to.id)
                .collect();
            let templates = view.templates_map();
            let entries: BTreeMap<_, _> = view
                .entries_raw()
                .into_iter()
                .map(|e| (e.id.clone(), e))
                .collect();
            let mut choices: Vec<_> = entries
                .values()
                .filter(|e| {
                    !e.is_trashed()
                        && model::effective_ancestors(&entries, &templates, &e.id)
                            .iter()
                            .all(|id| entries.get(id).is_some_and(|e| !e.is_trashed()))
                })
                .map(|e| EntryLink {
                    id: e.id.to_string(),
                    title: e.title.clone(),
                    linked: linked.contains(e.id.as_str()),
                })
                .collect();
            choices.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
            Ok(choices)
        })?
}

/// Materials related to this entry. Module navigation still scopes relations
/// to the entry: v3 relation endpoints do not contain a module. This projection
/// is for display only and must never be written back as the relation set.
pub fn related(ws: &Workspace, book: &str, entry: &str) -> Result<HashSet<String>> {
    let book_id = BookId::parse(book).map_err(invalid)?;
    let entry = entry.to_owned();
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_v3_doc(doc) {
                return Err(invalid("v3 materials require a v3 book"));
            }
            let b = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let v = b.view();
            if v.meta().deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            let templates = v.templates_map();
            let entries: BTreeMap<_, _> = v
                .entries_raw()
                .into_iter()
                .map(|e| (e.id.clone(), e))
                .collect();
            let Some(selected) = entries.get(entry.as_str()).filter(|e| {
                !e.is_trashed()
                    && model::effective_ancestors(&entries, &templates, &e.id)
                        .iter()
                        .all(|a| entries.get(a).is_some_and(|a| !a.is_trashed()))
            }) else {
                return Ok(HashSet::new());
            };
            let target = EntityRef::new(EntityKind::Entry, selected.id.as_str());
            Ok(v.relations_of(&target)
                .into_iter()
                .flat_map(|r| [r.from, r.to])
                .filter(|t| t.kind == EntityKind::Material)
                .map(|t| t.id)
                .collect())
        })?
}
