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
    // Canvas layout coordinates live in `layout:<book>`, outside `book:<id>` and
    // outside any entry (`LAYOUT-DOC-QUIET`).
    if call.name.starts_with("layout.") {
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
        relation_types,
        memberships,
        children_of,
        comments,
        mut assets,
        asset_folders,
    } = named.lookups;
    let headers = view.entry_headers_with(&BTreeMap::new());
    let mut children_guard = Vec::new();
    if !children_of.is_empty() {
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
            let has_any_child = headers
                .values()
                .any(|c| c.parent.as_ref() == Some(&parent_id));
            if has_any_child {
                children_guard.push(parent_id.to_string());
            }
            let mut descendants = BTreeSet::new();
            let mut frontier = vec![parent_id];
            while let Some(cur) = frontier.pop() {
                for c in headers.values() {
                    if c.parent.as_ref() == Some(&cur)
                        && !c.is_trashed()
                        && descendants.insert(c.id.clone())
                    {
                        frontier.push(c.id.clone());
                    }
                }
            }
            ids.extend(descendants.into_iter().map(|eid| eid.to_string()));
        }
    }
    if !asset_folders.is_empty() {
        for fid_str in asset_folders {
            if let Ok(fid) = dr_model::id::AssetFolderId::parse(&fid_str) {
                let (_, files) = crate::resolve::asset_folder_subtree(&view, &fid);
                assets.extend(files.into_iter().map(|a| a.id.to_string()));
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
    if !relations.is_empty() || !relation_types.is_empty() {
        for row in view.relations_raw() {
            if relations.iter().any(|id| id == row.id.as_str())
                || relation_types
                    .iter()
                    .any(|id| id == row.relation_type.as_str())
            {
                ids.extend(row.left.union(&row.right).map(ToString::to_string));
            }
        }
    }
    if !comments.is_empty() {
        let stored = view.comments();
        for id in comments {
            if let Some(c) = stored.iter().find(|c| c.id.as_str() == id)
                && let Some(t) = &c.target
            {
                match t.kind {
                    EntityKind::Entry => {
                        ids.insert(t.id.clone());
                    }
                    EntityKind::Patch => patches.push(t.id.clone()),
                    EntityKind::Asset => assets.push(t.id.clone()),
                    _ => {}
                }
            }
        }
    }
    if !assets.is_empty() {
        let asset_set: BTreeSet<String> = assets.into_iter().collect();
        ids.extend(entries_referencing_assets(
            ws, &book, &view, &headers, &asset_set,
        )?);
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

pub(super) fn entries_referencing_assets(
    ws: &Workspace,
    book: &BookId,
    view: &dr_doc::v3::BookViewV3<'_>,
    headers: &BTreeMap<EntryId, dr_model::v3::Entry>,
    asset_set: &BTreeSet<String>,
) -> Result<BTreeSet<String>> {
    let mut found = BTreeSet::new();
    let templates = view.templates_map();
    let mut image_fields = BTreeSet::new();
    for tpl in templates.values() {
        for m in &tpl.modules {
            if m.kind == dr_model::v3::ModuleKind::Fields {
                for def in &m.config.defs {
                    if def.field_type == dr_model::v3::FieldType::Image {
                        image_fields.insert((m.id.to_string(), def.id.clone()));
                    }
                }
            }
        }
    }
    for e in view.entries_raw() {
        let media_hit = e
            .media
            .values()
            .flatten()
            .any(|it| asset_set.contains(it.asset.as_str()));
        let field_hit = !media_hit
            && e.fields.iter().any(|(mid, vals)| {
                vals.iter().any(|(fid, val)| {
                    val.as_str().is_some_and(|s| asset_set.contains(s))
                        && image_fields.contains(&(mid.to_string(), fid.clone()))
                })
            });
        if media_hit || field_hit {
            found.insert(e.id.to_string());
        }
    }
    for r in ws
        .library()
        .entry_module_references_in_book(book.as_str())?
    {
        if r.count > 0
            && r.target_kind == "asset"
            && matches!(
                r.kind,
                dr_store::index::RefKind::Embed | dr_store::index::RefKind::Link
            )
            && asset_set.contains(&r.target_id)
            && EntryId::parse(&r.source_entry).is_ok_and(|eid| headers.contains_key(&eid))
        {
            found.insert(r.source_entry);
        }
    }
    let stale: BTreeSet<String> = ws.library().stale_index_docs()?.into_iter().collect();
    if !stale.is_empty() {
        for info in ws.library().docs(Some(book.as_str()), Some("body"))? {
            if !stale.contains(&info.doc_id) {
                continue;
            }
            let Ok(DocId::Body(body_id)) = DocId::parse(&info.doc_id) else {
                continue;
            };
            let doc_id = DocId::Body(body_id.clone());
            if !headers.contains_key(body_id.entry()) || found.contains(body_id.entry().as_str()) {
                continue;
            }
            let copy = ws.library().load_copy(&info.doc_id)?;
            let Ok(prose) = dr_doc::prose::BorrowedProse::new(&copy, &doc_id) else {
                continue;
            };
            let pv = prose.view();
            let embed_hit = pv.embed_refs().into_iter().any(|(_, eid)| {
                matches!(
                    pv.embed(&eid),
                    Some(dr_doc::prose::EmbedView::Asset { asset: Some(aid), .. })
                        if asset_set.contains(aid.as_str())
                )
            });
            let link_hit = !embed_hit
                && pv.entity_links_v3().into_iter().any(|(_, link)| {
                    link.kind == EntityKind::Asset && asset_set.contains(&link.target)
                });
            if embed_hit || link_hit {
                found.insert(body_id.entry().to_string());
            }
        }
    }
    Ok(found)
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
    /// Relation rows and kinds: all their member entries.
    relations: Vec<String>,
    relation_types: Vec<String>,
    /// Membership keys: the host and the member.
    memberships: Vec<String>,
    /// Entries whose switch is being turned off: live descendants moved to
    /// Recently Deleted.
    children_of: Vec<String>,
    /// Comment ids: the comment's target entity.
    comments: Vec<String>,
    /// Asset ids: entries referencing those assets.
    assets: Vec<String>,
    /// Asset folder ids: assets in their subtree, then referencing entries.
    asset_folders: Vec<String>,
}

impl Lookups {
    fn is_empty(&self) -> bool {
        self.patches.is_empty()
            && self.relations.is_empty()
            && self.relation_types.is_empty()
            && self.memberships.is_empty()
            && self.children_of.is_empty()
            && self.comments.is_empty()
            && self.assets.is_empty()
            && self.asset_folders.is_empty()
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
        if call.name == "comment.create"
            && let (Some(kind), Some(id)) = (
                args["target"]["kind"].as_str(),
                args["target"]["id"].as_str(),
            )
        {
            named.endpoint(EntityKind::from(kind), id);
        }
        if matches!(
            call.name.as_str(),
            "comment.update" | "comment.reanchor" | "comment.trash" | "comment.restore"
        ) && let Some(id) = args["id"].as_str()
        {
            named.lookups.comments.push(id.to_owned());
        }
        if matches!(
            call.name.as_str(),
            "asset.rename" | "asset.move" | "asset.trash" | "asset.restore"
        ) && let Some(id) = args["id"].as_str()
        {
            named.lookups.assets.push(id.to_owned());
        }
        if matches!(
            call.name.as_str(),
            "asset_folder.rename"
                | "asset_folder.move"
                | "asset_folder.trash"
                | "asset_folder.restore"
        ) && let Some(id) = args["id"].as_str()
        {
            named.lookups.asset_folders.push(id.to_owned());
        }
        if call.name == "asset_folder.create"
            && let Some(parent) = args["parent"].as_str()
        {
            named.lookups.asset_folders.push(parent.to_owned());
        }
        if call.name == "relation_row.add_entry" || call.name == "relation_row.remove_entry" {
            named
                .entries
                .extend(args["entry"].as_str().map(str::to_owned));
        }
        if call.name == "relation_row.create_pair" {
            named.entries.extend(
                ["left", "right"]
                    .into_iter()
                    .filter_map(|key| args[key].as_str())
                    .map(str::to_owned),
            );
        }
        if call.name.starts_with("relation_row.")
            && let Some(id) = args["id"].as_str()
        {
            named.lookups.relations.push(id.to_owned());
        }
        if matches!(
            call.name.as_str(),
            "relation_type.set_direction" | "relation_type.delete"
        ) && let Some(id) = args["id"].as_str()
        {
            named.lookups.relation_types.push(id.to_owned());
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
                    Some("relation_types") => named.lookups.relation_types.push(id.to_owned()),
                    Some("comments") => named.lookups.comments.push(id.to_owned()),
                    Some("assets") => named.lookups.assets.push(id.to_owned()),
                    Some("asset_folders") => named.lookups.asset_folders.push(id.to_owned()),
                    _ => {}
                }
            }
        }
        named
    }

    fn endpoint(&mut self, kind: EntityKind, id: &str) {
        match kind {
            EntityKind::Entry => {
                self.entries.insert(id.to_owned());
            }
            EntityKind::Patch => self.lookups.patches.push(id.to_owned()),
            EntityKind::Comment => self.lookups.comments.push(id.to_owned()),
            EntityKind::Asset => self.lookups.assets.push(id.to_owned()),
            _ => {}
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
