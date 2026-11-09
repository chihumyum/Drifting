//! V3 material associations, read without a legacy navigation conversion.

use std::collections::{BTreeMap, HashSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{book::EntityRef, id::BookId, kind::EntityKind, v3 as model};
use dr_store::OpenDoc;
use dr_workspace::{Result, Workspace, WsError};

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
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
