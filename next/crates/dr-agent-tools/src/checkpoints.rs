//! Host-only complete entry checkpoints. A receipt advances only the current
//! invocation's book CAS; it never grants content coverage or refreshes reads.
use std::collections::{BTreeMap, BTreeSet};

use dr_doc::v3::BorrowedBookV3;
use dr_model::{DocId, id::BookId, id::EntryId, kind::EntityKind};
use dr_workspace::{RecordKey, Workspace, commands::v3::snapshots::Created};

use super::{AgentTools, TurnKey};
use crate::{Error, Result, resolve::ResolvedCall};

#[cfg(test)]
pub(super) fn entries(ws: &Workspace, key: &TurnKey, call: &ResolvedCall) -> Result<Vec<String>> {
    Ok(selection(ws, key, call)?.entries)
}

struct Selection {
    entries: Vec<String>,
    children_guard: Vec<String>,
}

fn selection(ws: &Workspace, key: &TurnKey, call: &ResolvedCall) -> Result<Selection> {
    // Comments are book-owned, not part of an entry checkpoint. Their source
    // prose is read only, and must not create a checkpoint or new body.
    if call.name.starts_with("comment.") {
        return Ok(Selection {
            entries: Vec::new(),
            children_guard: Vec::new(),
        });
    }
    let book = BookId::parse(&key.book).map_err(|e| Error::Invalid(e.to_string()))?;
    if !crate::catalog::is_v3_book(ws, &book)? {
        return Ok(Selection {
            entries: Vec::new(),
            children_guard: Vec::new(),
        });
    }
    let named = Named::of(call);
    let mut ids = named.entries;
    // Most calls name their entries; only a relation, membership or patch
    // named by its own id, or turning off an entry's level switch (which
    // moves any direct children to root), has to be looked up in the book.
    // Loading a copy of the book document costs as much as the book is big,
    // so no other call loads one.
    if named.lookups.is_empty() {
        return Ok(Selection {
            entries: ids.into_iter().collect(),
            children_guard: Vec::new(),
        });
    }
    let copy = ws.library().load_copy(&format!("book:{book}"))?;
    let borrowed = BorrowedBookV3::new(&copy, &book).map_err(|e| Error::Invalid(e.to_string()))?;
    let view = borrowed.view();
    let Lookups {
        mut patches,
        relations,
        memberships,
        children_of,
    } = named.lookups;
    let mut children_guard = Vec::new();
    if !children_of.is_empty() {
        let headers = view.entry_headers_with(&BTreeMap::new());
        for id in children_of {
            let Ok(parent_id) = EntryId::parse(&id) else {
                continue;
            };
            let Some(parent) = headers.get(&parent_id) else {
                continue;
            };
            if parent.is_trashed() || !parent.is_level() {
                continue;
            }
            let direct: Vec<String> = headers
                .values()
                .filter(|c| c.parent.as_ref() == Some(&parent_id))
                .map(|c| c.id.to_string())
                .collect();
            if !direct.is_empty() {
                children_guard.push(parent_id.to_string());
                ids.extend(direct);
            }
        }
    }
    if !memberships.is_empty() {
        let stored = view.memberships_raw();
        for key in memberships {
            for membership in stored
                .iter()
                .filter(|m| dr_model::v3::Membership::key(&m.host, &m.member) == key)
            {
                ids.extend([membership.host.to_string(), membership.member.to_string()]);
            }
        }
    }
    if !relations.is_empty() {
        let stored = view.relations_raw();
        for id in relations {
            if let Some(r) = stored.iter().find(|r| r.id.as_str() == id) {
                for (kind, id) in [(&r.from.kind, &r.from.id), (&r.to.kind, &r.to.id)] {
                    if *kind == EntityKind::Entry {
                        ids.insert(id.clone());
                    } else if *kind == EntityKind::Patch {
                        patches.push(id.clone());
                    }
                }
            }
        }
    }
    if !patches.is_empty() {
        let stored = view.patches();
        for id in patches {
            if let Some(patch) = stored.iter().find(|p| p.id.as_str() == id) {
                ids.insert(patch.entry.to_string());
            }
        }
    }
    Ok(Selection {
        entries: ids.into_iter().collect(),
        children_guard,
    })
}

/// What a call names that its write-before checkpoint covers: entries named
/// directly (by an argument or a prose document), and records named by their
/// own id whose entries only the book knows.
#[derive(Debug, Default)]
struct Named {
    entries: BTreeSet<String>,
    lookups: Lookups,
}

/// Records to find in the book; each one leads to the entries it belongs to.
#[derive(Debug, Default)]
struct Lookups {
    /// Patch ids: the patch's entry.
    patches: Vec<String>,
    /// Relation ids: each endpoint that is an entry, or a patch's entry.
    relations: Vec<String>,
    /// Membership keys: the host and the member.
    memberships: Vec<String>,
    /// Entries whose switch is being turned off: any direct children moved to
    /// root.
    children_of: Vec<String>,
}

impl Lookups {
    fn is_empty(&self) -> bool {
        self.patches.is_empty()
            && self.relations.is_empty()
            && self.memberships.is_empty()
            && self.children_of.is_empty()
    }
}

impl Named {
    fn of(call: &ResolvedCall) -> Self {
        let mut named = Self::default();
        for target in &call.targets {
            if let Ok(DocId::Body(body)) = DocId::parse(target) {
                named.entries.insert(body.entry().to_string());
            }
        }
        let args = &call.arguments;
        let keys: &[&str] = match call.name.as_str() {
            "entry.update" | "entry.move" | "entry.trash" | "entry.restore" | "entry.set_level" => {
                &["id"]
            }
            "membership.add" | "membership.remove" => &["host", "member"],
            "membership.primary" => &["member"],
            "timeline_view.place" | "timeline_view.remove" => &["lane", "entry"],
            name if name.starts_with("module.") && args["template"] != true => &["entry", "owner"],
            _ => &[],
        };
        for key in keys {
            if let Some(id) = args[*key].as_str() {
                named.entries.insert(id.to_owned());
            }
        }
        if call.name == "entry.set_level"
            && args["level"] == false
            && let Some(id) = args["id"].as_str()
        {
            named.lookups.children_of.push(id.to_owned());
        }
        if matches!(
            call.name.as_str(),
            "relation.create" | "module.put_relation"
        ) {
            for key in ["from", "to", "other"] {
                if let (Some(kind), Some(id)) =
                    (args[key]["kind"].as_str(), args[key]["id"].as_str())
                {
                    named.endpoint(EntityKind::from(kind), id);
                }
            }
        }
        if matches!(
            call.name.as_str(),
            "relation.delete" | "module.remove_relation"
        ) && let Some(id) = args["id"].as_str()
        {
            named.lookups.relations.push(id.to_owned());
        }
        if call.name == "entry_history.restore" {
            for target in args["targets"].as_array().into_iter().flatten() {
                let Some(id) = target["id"].as_str() else {
                    continue;
                };
                match target["collection"].as_str() {
                    Some("entries") => {
                        named.entries.insert(id.to_owned());
                    }
                    Some("memberships") => named.lookups.memberships.push(id.to_owned()),
                    Some("patches") => named.endpoint(EntityKind::Patch, id),
                    Some("plot_grids") => {
                        if let Some((entry, _)) = id.split_once('/') {
                            named.entries.insert(entry.to_owned());
                        }
                    }
                    Some("relations") => named.lookups.relations.push(id.to_owned()),
                    _ => {}
                }
            }
        }
        named
    }

    /// A relation endpoint or a patch: an entry is named, a patch is looked
    /// up, any other kind has no entry.
    fn endpoint(&mut self, kind: EntityKind, id: &str) {
        if kind == EntityKind::Entry {
            self.entries.insert(id.to_owned());
        } else if kind == EntityKind::Patch {
            self.lookups.patches.push(id.to_owned());
        }
    }
}

impl AgentTools {
    pub(super) fn checkpoint_before_write(
        &self,
        ws: &Workspace,
        actor: &dr_workspace::Actor,
        key: &TurnKey,
        call: &ResolvedCall,
        guards: &mut dr_workspace::WritePreconditions,
        captured: &mut Vec<String>,
    ) -> Result<()> {
        let book_doc = format!("book:{}", key.book);
        let sel = selection(ws, key, call)?;
        if !guards.versions.contains_key(&book_doc) {
            for parent in &sel.children_guard {
                let key = RecordKey::children_of(Some(parent));
                if !guards
                    .records
                    .iter()
                    .any(|r| r.doc == book_doc && r.key == key)
                {
                    return Err(Error::ReadRequired(format!(
                        "read required: {book_doc} record {key}"
                    )));
                }
            }
        }
        for entry in sel.entries {
            {
                let turns = self.turns.lock().expect("tool observations");
                let turn = turns
                    .get(key)
                    .ok_or_else(|| Error::ReadRequired(book_doc.clone()))?;
                if turn.checkpointed.contains(&entry) {
                    continue;
                }
            }
            // Unread retained bodies are captured, not authorized for editing.
            // Every supplied write/source guard is checked in the reservation:
            // the versions of prose, and the records this write read of the
            // book, so a write that is already stale leaves no checkpoint.
            let capture_guards = dr_workspace::WritePreconditions {
                versions: guards.versions.clone(),
                records: guards.records.clone(),
                require_all: false,
            };
            let value = ws.call_guarded(
                actor,
                "entry_snapshot.create_with_receipt",
                serde_json::json!({"book":key.book,"entry":entry}),
                capture_guards,
            )?;
            let receipt: Created = serde_json::from_value(value["output"].clone())
                .map_err(|e| Error::Invalid(format!("invalid checkpoint receipt: {e}")))?;
            let version = receipt
                .versions
                .get(&book_doc)
                .ok_or_else(|| Error::Invalid("checkpoint receipt has no book version".into()))?;
            // A checkpoint commits to `checkpoints:<book>`, beside the book,
            // and not to the book document: the book's version in the
            // receipt is the one the capture was held to, so a write held to
            // the whole book keeps that exact frontier. Never
            // observe-and-rebase: an author may already have typed again.
            if guards.versions.contains_key(&book_doc) {
                guards.versions.insert(book_doc.clone(), version.clone());
            }
            captured.push(entry);
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "checkpoint_selection_tests.rs"]
mod selection_tests;
