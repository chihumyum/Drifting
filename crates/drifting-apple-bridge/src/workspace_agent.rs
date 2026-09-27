//! Prose tools for the native writing Agent: read a body's live text and
//! apply an accepted revision through its document owner, so open views,
//! history and provenance stay with the one owner of that body.
use super::*;
use drifting_core::prose::AgentIdentity;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProseTarget {
    pub(super) kind: String,
    pub(super) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProseChange {
    current_text: String,
    revised_text: String,
    #[serde(default)]
    all_occurrences: bool,
    /// Adds `revisedText` as new paragraphs at the end (`currentText` empty).
    #[serde(default)]
    append: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentCall {
    session_id: String,
    turn_id: String,
    call_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentCommand {
    ReadProse {
        target: ProseTarget,
    },
    /// The styled projection (blocks, runs and marks) of a body, live or
    /// stored, for printing and PDF export. Read only.
    ReadProjection {
        target: ProseTarget,
    },
    ApplyChanges {
        target: ProseTarget,
        changes: Vec<ProseChange>,
        agent: AgentCall,
    },
}

/// The body document, its owner kind and the map of open owners.
pub(super) struct Body {
    pub(super) document_id: String,
    pub(super) owner_kind: &'static str,
    pub(super) key: (String, String),
}

impl WorkspaceSession {
    pub(super) fn body(
        &self,
        project_id: &str,
        target: &ProseTarget,
    ) -> Result<(Body, Option<u64>), String> {
        let key = (project_id.to_owned(), target.id.clone());
        let (document_id, owner_kind, open) = match target.kind.as_str() {
            "chapter" => (
                format!("node-content:{}", target.id),
                "node",
                self.documents.get(&key),
            ),
            "drift" => (
                format!("node-content:{}", target.id),
                "node",
                self.drift_bodies.get(&key),
            ),
            "element" => (
                format!("element:{}", target.id),
                "element",
                self.elements.get(&key),
            ),
            "storyline" => (
                format!("storyline:{}", target.id),
                "storyline",
                self.storyline_bodies.get(&key),
            ),
            "category" => (
                format!("category:{}", target.id),
                "category",
                self.category_bodies.get(&key),
            ),
            kind => return Err(format!("Agent prose tools do not support {kind} bodies")),
        };
        let open = open.copied();
        Ok((
            Body {
                document_id,
                owner_kind,
                key,
            },
            open,
        ))
    }

    pub(super) fn agent(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        command: &AgentCommand,
    ) -> Result<Value, String> {
        self.project(project_id)?;
        match command {
            AgentCommand::ReadProjection { target } => {
                let (body, open) = self.body(project_id, target)?;
                WorkspaceStore::new(&self.gateway, CLIENT)
                    .document_scope(project_id, &body.document_id)?;
                let (projection, live) = match open.and_then(|handle| documents.get(&handle)) {
                    Some(owner) => (owner.document.native_projection()?, true),
                    None => {
                        let repository = ProseRepository::new(&self.gateway, CLIENT);
                        let tx = self
                            .gateway
                            .begin(TransactionBehavior::Deferred, CLIENT.into())?;
                        let loaded =
                            drifting_prose::load_document(&repository, &body.document_id, tx)
                                .and_then(|(document, _)| document.native_projection());
                        let _ = self.gateway.rollback(tx, CLIENT.into());
                        (loaded?, false)
                    }
                };
                Ok(json!({"projection": projection, "live": live}))
            }
            AgentCommand::ReadProse { target } => {
                let (body, open) = self.body(project_id, target)?;
                // A trashed or missing body has no live scope.
                WorkspaceStore::new(&self.gateway, CLIENT)
                    .document_scope(project_id, &body.document_id)?;
                let (text, live) = match open.and_then(|handle| documents.get(&handle)) {
                    Some(owner) => (owner.document.native_projection()?.text, true),
                    None => {
                        let repository = ProseRepository::new(&self.gateway, CLIENT);
                        let tx = self
                            .gateway
                            .begin(TransactionBehavior::Deferred, CLIENT.into())?;
                        let loaded =
                            drifting_prose::load_document(&repository, &body.document_id, tx)
                                .and_then(|(document, _)| document.native_projection());
                        let _ = self.gateway.rollback(tx, CLIENT.into());
                        (loaded?.text, false)
                    }
                };
                Ok(json!({"text": text, "live": live}))
            }
            AgentCommand::ApplyChanges {
                target,
                changes,
                agent,
            } => {
                let (body, open) = self.body(project_id, target)?;
                let identity = AgentIdentity {
                    session_id: agent.session_id.clone(),
                    turn_id: agent.turn_id.clone(),
                    call_id: agent.call_id.clone(),
                };
                let changes: Vec<(String, String, bool, bool)> = changes
                    .iter()
                    .map(|c| {
                        (
                            c.current_text.clone(),
                            c.revised_text.clone(),
                            c.all_occurrences,
                            c.append,
                        )
                    })
                    .collect();
                // An open body is revised in place; otherwise a temporary
                // owner opens, applies, saves and closes.
                let (handle, temporary) = match open {
                    Some(handle) => (handle, false),
                    None => {
                        let scope = WorkspaceStore::new(&self.gateway, CLIENT)
                            .document_scope(project_id, &body.document_id)?;
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
                let result = owner.apply_agent_changes(&changes, identity);
                let state = owner.document_state();
                if temporary {
                    let released = owner.prepare_to_release();
                    documents.remove(&handle);
                    released?;
                }
                let applied = result?;
                Ok(json!({
                    "applied": applied,
                    "handle": if temporary { Value::Null } else { json!(handle) },
                    "document": state?,
                }))
            }
        }
    }
}
