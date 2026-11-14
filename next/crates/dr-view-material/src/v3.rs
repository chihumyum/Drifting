//! V3 media-entry associations bridging `dr-view-material` / `dr-view-shelf-review`
//! over format-5 `Entry <-> Entry` relations until T5 switches the shelf to the
//! file index.

use std::collections::{HashMap, HashSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{id::BookId, kind::EntityKind, shared::EntityRef, v3 as model};
use dr_store::OpenDoc;
use dr_workspace::{
    Actor, Result, Workspace, WsError,
    commands::v3::relations::{Create as RelationCreate, CreateIn, Delete as RelationDelete},
    dto::Target,
};

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryLink {
    pub id: String,
    pub title: String,
    pub linked: bool,
}

fn live_entries_and_media_hosts(
    view: &dr_doc::v3::BookViewV3<'_>,
) -> (HashMap<String, model::Entry>, HashMap<String, String>) {
    let entries = view.entries_map();
    let mut live = HashMap::new();
    let mut hosts = HashMap::new();
    for e in entries.values() {
        let is_live = !e.is_trashed()
            && model::effective_ancestors(&entries, &e.id)
                .iter()
                .all(|id| entries.get(id).is_some_and(|a| !a.is_trashed()));
        if is_live {
            for item in e.media.values().flatten() {
                hosts.insert(item.id.to_string(), e.id.to_string());
            }
            live.insert(e.id.to_string(), e.clone());
        }
    }
    (live, hosts)
}

/// The live entry choices and this media item's host entry associations.
pub fn entry_links(ws: &Workspace, book: &str, material: &str) -> Result<Vec<EntryLink>> {
    let book_id = BookId::parse(book).map_err(invalid)?;
    let material = material.to_owned();
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid("materials require a book of the current format"));
            }
            let book = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let view = book.view();
            if view.meta().deleted_at.is_some() {
                return Err(invalid("material is unavailable"));
            }
            let (live, hosts) = live_entries_and_media_hosts(&view);
            let Some(host_id) = hosts.get(&material) else {
                return Err(invalid("material is unavailable"));
            };
            let own = EntityRef::new(EntityKind::Entry, host_id.clone());
            let ty = dr_doc::catalog::generic_relation_type_id(&book_id);
            let linked: HashSet<_> = view
                .relations_raw()
                .into_iter()
                .filter(|r| {
                    r.relation_type == ty
                        && ((r.from == own && r.to.kind == EntityKind::Entry)
                            || (r.to == own && r.from.kind == EntityKind::Entry))
                })
                .map(|r| if r.from == own { r.to.id } else { r.from.id })
                .collect();
            let mut choices: Vec<_> = live
                .values()
                .filter(|e| e.id.as_str() != host_id)
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

/// Creates or removes the generic association between `material`'s host entry
/// and `entry`, preserving any hidden relations on non-live endpoints.
pub fn set_entry_link(
    ws: &Workspace,
    book: &str,
    material: &str,
    entry: &str,
    linked: bool,
) -> Result<()> {
    let book_id = BookId::parse(book).map_err(invalid)?;
    let ty = dr_doc::catalog::generic_relation_type_id(&book_id).to_string();
    let mat = material.to_owned();
    let target_entry = entry.to_owned();
    let (host_id, existing) = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid("materials require a book of the current format"));
            }
            let b = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let v = b.view();
            if v.meta().deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            let (live, hosts) = live_entries_and_media_hosts(&v);
            let Some(host_id) = hosts.get(&mat).cloned() else {
                return Err(WsError::NotFound {
                    what: "material",
                    id: mat,
                });
            };
            if !live.contains_key(&target_entry) || target_entry == host_id {
                return Err(WsError::NotFound {
                    what: "entry",
                    id: target_entry,
                });
            }
            let own = EntityRef::new(EntityKind::Entry, host_id.clone());
            let other = EntityRef::new(EntityKind::Entry, target_entry);
            let ty = dr_doc::catalog::generic_relation_type_id(&book_id);
            let existing: Vec<String> = v
                .relations_raw()
                .into_iter()
                .filter(|r| {
                    r.relation_type == ty
                        && ((r.from == own && r.to == other) || (r.from == other && r.to == own))
                })
                .map(|r| r.id.to_string())
                .collect();
            Ok((host_id, existing))
        })??;
    if linked {
        if existing.is_empty() {
            ws.run::<RelationCreate>(
                &Actor::User,
                CreateIn {
                    book: book.to_owned(),
                    from: Target {
                        kind: "entry".into(),
                        id: host_id,
                    },
                    to: Target {
                        kind: "entry".into(),
                        id: entry.to_owned(),
                    },
                    relation_type: Some(ty),
                    id: None,
                },
            )?;
        }
    } else {
        for rel_id in existing {
            ws.run::<RelationDelete>(
                &Actor::User,
                dr_workspace::commands::EntityIn {
                    book: book.to_owned(),
                    id: rel_id,
                },
            )?;
        }
    }
    Ok(())
}

/// Media items on entries related to `entry`.
pub fn related(ws: &Workspace, book: &str, entry: &str) -> Result<HashSet<String>> {
    let book_id = BookId::parse(book).map_err(invalid)?;
    let entry = entry.to_owned();
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid("materials require a book of the current format"));
            }
            let b = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let v = b.view();
            if v.meta().deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            let (live, _) = live_entries_and_media_hosts(&v);
            if !live.contains_key(&entry) {
                return Ok(HashSet::new());
            }
            let target = EntityRef::new(EntityKind::Entry, entry.clone());
            let mut out = HashSet::new();
            for r in v.relations_of(&target) {
                for end in [r.from, r.to] {
                    if end.kind == EntityKind::Entry
                        && end.id != entry
                        && let Some(host) = live.get(&end.id)
                    {
                        for item in host.media.values().flatten() {
                            out.insert(item.id.to_string());
                        }
                    }
                }
            }
            Ok(out)
        })?
}

/// Returns `(linked_materials, entry_related_materials)` from one book snapshot.
pub fn shelf_relations(
    ws: &Workspace,
    book: &str,
    selected_entry: Option<&str>,
) -> Result<(HashSet<String>, Option<HashSet<String>>)> {
    let book_id = BookId::parse(book).map_err(invalid)?;
    let selected_entry = selected_entry.map(ToOwned::to_owned);
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid("materials require a book of the current format"));
            }
            let b = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let v = b.view();
            if v.meta().deleted_at.is_some() {
                return Err(invalid("book is in the trash"));
            }
            let (live, _) = live_entries_and_media_hosts(&v);
            let rels = v.relations_matching(|r| {
                r.from.kind == EntityKind::Entry
                    && r.to.kind == EntityKind::Entry
                    && live.contains_key(&r.from.id)
                    && live.contains_key(&r.to.id)
            });
            let mut linked = HashSet::new();
            for r in &rels {
                for end in [&r.from, &r.to] {
                    if let Some(host) = live.get(&end.id) {
                        for item in host.media.values().flatten() {
                            linked.insert(item.id.to_string());
                        }
                    }
                }
            }
            let entry_related = match selected_entry {
                None => None,
                Some(entry) => {
                    if !live.contains_key(&entry) {
                        Some(HashSet::new())
                    } else {
                        let target = EntityRef::new(EntityKind::Entry, entry.clone());
                        let mut set = HashSet::new();
                        for r in rels
                            .into_iter()
                            .filter(|r| r.from == target || r.to == target)
                        {
                            for end in [r.from, r.to] {
                                if end.id != entry
                                    && let Some(host) = live.get(&end.id)
                                {
                                    for item in host.media.values().flatten() {
                                        set.insert(item.id.to_string());
                                    }
                                }
                            }
                        }
                        Some(set)
                    }
                }
            };
            Ok((linked, entry_related))
        })?
}
