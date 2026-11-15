//! Read-only file/entry relation queries bridging `dr-view-material` and
//! `dr-view-shelf-review` over format-5 relations (`kernel-v5.md` §10).
//! Creating relations to files has no UI entry point in T5 (`v5-tracks.md`
//! lines 404, 413).

use std::collections::{HashMap, HashSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{
    id::{AssetId, BookId},
    kind::EntityKind,
    shared::EntityRef,
    v3 as model,
};
use dr_store::OpenDoc;
use dr_workspace::{Result, Workspace, WsError};

fn invalid(e: impl ToString) -> WsError {
    WsError::Invalid(e.to_string())
}

fn live_entries(view: &dr_doc::v3::BookViewV3<'_>) -> HashMap<String, model::Entry> {
    let entries = view.entries_map();
    let mut live = HashMap::new();
    for e in entries.values() {
        let is_live = !e.is_trashed()
            && model::effective_ancestors(&entries, &e.id)
                .iter()
                .all(|id| entries.get(id).is_some_and(|a| !a.is_trashed()));
        if is_live {
            live.insert(e.id.to_string(), e.clone());
        }
    }
    live
}

fn asset_is_live(view: &dr_doc::v3::BookViewV3<'_>, id: &str) -> bool {
    AssetId::parse(id)
        .ok()
        .is_some_and(|aid| view.asset(&aid).is_some())
}

/// Live files and media items related to `entry`.
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
            let live = live_entries(&v);
            if !live.contains_key(&entry) {
                return Ok(HashSet::new());
            }
            let target = EntityRef::new(EntityKind::Entry, entry.clone());
            let mut out = HashSet::new();
            for r in v.relations_of(&target) {
                for end in [r.from, r.to] {
                    if end.kind == EntityKind::Asset && asset_is_live(&v, &end.id) {
                        out.insert(end.id.clone());
                        continue;
                    }
                    if end.kind == EntityKind::Entry
                        && end.id != entry
                        && let Some(host) = live.get(&end.id)
                    {
                        for item in host.media.values().flatten() {
                            out.insert(item.id.to_string());
                            if asset_is_live(&v, item.asset.as_str()) {
                                out.insert(item.asset.to_string());
                            }
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
            let live = live_entries(&v);
            let end_ok = |end: &EntityRef| match end.kind {
                EntityKind::Entry => live.contains_key(&end.id),
                EntityKind::Asset => asset_is_live(&v, &end.id),
                _ => false,
            };
            let rels = v.relations_matching(|r| {
                end_ok(&r.from)
                    && end_ok(&r.to)
                    && (r.from.kind == EntityKind::Entry || r.to.kind == EntityKind::Entry)
            });
            let mut linked = HashSet::new();
            for r in &rels {
                for end in [&r.from, &r.to] {
                    if end.kind == EntityKind::Asset {
                        linked.insert(end.id.clone());
                    } else if let Some(host) = live.get(&end.id) {
                        for item in host.media.values().flatten() {
                            linked.insert(item.id.to_string());
                            if asset_is_live(&v, item.asset.as_str()) {
                                linked.insert(item.asset.to_string());
                            }
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
                                if end.kind == EntityKind::Asset {
                                    set.insert(end.id.clone());
                                } else if end.id != entry
                                    && let Some(host) = live.get(&end.id)
                                {
                                    for item in host.media.values().flatten() {
                                        set.insert(item.id.to_string());
                                        if asset_is_live(&v, item.asset.as_str()) {
                                            set.insert(item.asset.to_string());
                                        }
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
