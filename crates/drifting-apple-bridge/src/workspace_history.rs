//! Version history of chapter, drift, element and storyline bodies: list
//! snapshots with a text preview, and restore one as a forward edit through
//! the body's owner after capturing the current state.
use super::agent::ProseTarget;
use super::*;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum HistoryCommand {
    List {
        target: ProseTarget,
    },
    Restore {
        target: ProseTarget,
        snapshot_id: String,
    },
}

fn snapshot_kind(target: &ProseTarget) -> &'static str {
    match target.kind.as_str() {
        "element" => "element",
        "storyline" => "storyline",
        "category" => "category",
        _ => "node",
    }
}

impl WorkspaceSession {
    pub(super) fn history(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        command: &HistoryCommand,
    ) -> Result<Value, String> {
        self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        match command {
            HistoryCommand::List { target } => {
                let (_, open) = self.body(project_id, target)?;
                // An open owner's unsaved input is captured first when due.
                if let Some(owner) = open.and_then(|handle| documents.get_mut(&handle)) {
                    owner.persist();
                }
                let entries: Vec<Value> = store
                    .snapshot_history(project_id, snapshot_kind(target), &target.id)?
                    .into_iter()
                    .map(|entry| {
                        let text = entry
                            .content_json
                            .as_deref()
                            .and_then(|json| serde_json::from_str::<Value>(json).ok())
                            .map(|document| drifting_document::prose_plain_text(&document))
                            .unwrap_or_default();
                        json!({"id": entry.id, "createdAt": entry.created_at, "meta": entry.meta, "text": text})
                    })
                    .collect();
                Ok(json!({"entries": entries}))
            }
            HistoryCommand::Restore {
                target,
                snapshot_id,
            } => {
                let (kind, id, state) = store.snapshot_state(project_id, snapshot_id)?;
                if kind != snapshot_kind(target) || id != target.id {
                    return Err("这个历史版本不属于当前文档".into());
                }
                let (body, open) = self.body(project_id, target)?;
                let (handle, temporary) = match open {
                    Some(handle) => (handle, false),
                    None => {
                        let scope = store.document_scope(project_id, &body.document_id)?;
                        let owner = LabSession::open_body(
                            self.directory.clone(),
                            self.gateway.clone(),
                            scope,
                            body.owner_kind,
                            body.key.1.clone(),
                            self.installation_id.clone(),
                        )?;
                        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
                        documents.insert(handle, owner);
                        (handle, true)
                    }
                };
                let owner = documents
                    .get_mut(&handle)
                    .ok_or("Workspace document owner is missing")?;
                let result = owner.restore_version(&state);
                let state = owner.document_state();
                if temporary {
                    let released = owner.prepare_to_release();
                    documents.remove(&handle);
                    released?;
                }
                result?;
                Ok(json!({
                    "handle": if temporary { Value::Null } else { json!(handle) },
                    "document": state?,
                }))
            }
        }
    }
}
