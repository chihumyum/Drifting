//! Host-only complete entry checkpoints. A receipt advances only the current
//! invocation's book CAS; it never grants content coverage or refreshes reads.
use std::collections::BTreeSet;

use dr_doc::v3::BorrowedBookV3;
use dr_model::{DocId, id::BookId, kind::EntityKind};
use dr_workspace::{Workspace, commands::v3::snapshots::Created};

use super::{AgentTools, TurnKey};
use crate::{Error, Result, resolve::ResolvedCall};

pub(super) fn entries(ws: &Workspace, key: &TurnKey, call: &ResolvedCall) -> Result<Vec<String>> {
    // Comments are book-owned, not part of an entry checkpoint. Their source
    // prose is read only, and must not create a checkpoint or new body.
    if call.name.starts_with("comment.") {
        return Ok(Vec::new());
    }
    let book = BookId::parse(&key.book).map_err(|e| Error::Invalid(e.to_string()))?;
    if !crate::catalog::is_v3_book(ws, &book)? {
        return Ok(Vec::new());
    }
    let mut ids = BTreeSet::new();
    for target in &call.targets {
        if let Ok(DocId::Body(body)) = DocId::parse(target) {
            ids.insert(body.entry().to_string());
        }
    }
    let args = &call.arguments;
    let keys: &[&str] = match call.name.as_str() {
        "entry.update" | "entry.move" | "entry.trash" | "entry.restore" => &["id"],
        "membership.add" | "membership.remove" => &["host", "member"],
        "membership.primary" => &["member"],
        "timeline_view.place" | "timeline_view.remove" => &["lane", "entry"],
        name if name.starts_with("module.") && args["template"] != true => &["entry", "owner"],
        _ => &[],
    };
    for key in keys {
        if let Some(id) = args[*key].as_str() {
            ids.insert(id.to_owned());
        }
    }
    let copy = ws.library().load_copy(&format!("book:{book}"))?;
    let borrowed = BorrowedBookV3::new(&copy, &book).map_err(|e| Error::Invalid(e.to_string()))?;
    let view = borrowed.view();
    let mut endpoints = Vec::new();
    if matches!(
        call.name.as_str(),
        "relation.create" | "module.put_relation"
    ) {
        for key in ["from", "to", "other"] {
            if let (Some(kind), Some(id)) = (args[key]["kind"].as_str(), args[key]["id"].as_str()) {
                endpoints.push((EntityKind::from(kind), id.to_owned()));
            }
        }
    }
    if matches!(
        call.name.as_str(),
        "relation.delete" | "module.remove_relation"
    ) && let Some(relation) = view
        .relations_raw()
        .into_iter()
        .find(|r| Some(r.id.as_str()) == args["id"].as_str())
    {
        endpoints.extend([
            (relation.from.kind, relation.from.id),
            (relation.to.kind, relation.to.id),
        ]);
    }
    if call.name == "entry_history.restore" {
        for target in args["targets"].as_array().into_iter().flatten() {
            let Some(id) = target["id"].as_str() else {
                continue;
            };
            match target["collection"].as_str() {
                Some("entries") => {
                    ids.insert(id.to_owned());
                }
                Some("memberships") => {
                    for membership in view
                        .memberships_raw()
                        .iter()
                        .filter(|m| dr_model::v3::Membership::key(&m.host, &m.member) == id)
                    {
                        ids.extend([membership.host.to_string(), membership.member.to_string()]);
                    }
                }
                Some("patches") => endpoints.push((EntityKind::Patch, id.to_owned())),
                Some("plot_grids") => {
                    if let Some((entry, _)) = id.split_once('/') {
                        ids.insert(entry.to_owned());
                    }
                }
                Some("relations") => {
                    if let Some(r) = view
                        .relations_raw()
                        .into_iter()
                        .find(|r| r.id.as_str() == id)
                    {
                        endpoints.extend([(r.from.kind, r.from.id), (r.to.kind, r.to.id)]);
                    }
                }
                _ => {}
            }
        }
    }

    for (kind, id) in endpoints {
        if kind == EntityKind::Entry {
            ids.insert(id);
        } else if kind == EntityKind::Patch
            && let Some(patch) = view.patches().iter().find(|p| p.id.as_str() == id)
        {
            ids.insert(patch.entry.to_string());
        }
    }
    Ok(ids.into_iter().collect())
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
        for entry in entries(ws, key, call)? {
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
            // A checkpoint commits to the book, but to none of the records a
            // write is held to. Only a write held to the whole book has to
            // step past it, and then to this exact frontier, which contains
            // only the guarded checkpoint commit. Never observe-and-rebase:
            // an author may already have typed again.
            if guards.versions.contains_key(&book_doc) {
                guards.versions.insert(book_doc.clone(), version.clone());
            }
            captured.push(entry);
        }
        Ok(())
    }
}
