//! Drift notes, drift groups and act binding, and drift body owners. Domain
//! writes live in drifting-core; a drift body is an ordinary durable prose
//! owner (`node-content:<id>`) keyed apart from chapters.
use super::elements::{empty_body, present};
use super::*;
use drifting_core::workspace::NewDrift;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DriftCommand {
    Library,
    CreateDrift {
        title: Option<String>,
        group_id: Option<String>,
    },
    UpdateDrift {
        drift_id: String,
        title: Option<String>,
        #[serde(default, deserialize_with = "present")]
        group_id: Option<Option<String>>,
    },
    TrashDrift {
        drift_id: String,
    },
    RestoreDrift {
        drift_id: String,
    },
    CreateGroup {
        name: String,
        parent_group_id: Option<String>,
    },
    RenameGroup {
        group_id: String,
        name: String,
    },
    DeleteGroup {
        group_id: String,
    },
    BindAct {
        act_id: String,
        drift_id: Option<String>,
    },
    OpenDrift {
        drift_id: String,
    },
    CloseDrift {
        drift_id: String,
    },
}

impl WorkspaceSession {
    pub(super) fn drifts(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        command: &DriftCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let result = match command {
            DriftCommand::Library => Value::Null,
            DriftCommand::CreateDrift { title, group_id } => json!(store.create_drift(
                &self.context(&project)?,
                NewDrift {
                    id: identifier("drift")?,
                    title: title.clone(),
                    group_id: group_id.clone(),
                    seed: empty_body()?,
                },
            )?),
            DriftCommand::UpdateDrift {
                drift_id,
                title,
                group_id,
            } => json!(store.update_drift(
                &self.context(&project)?,
                drift_id,
                title.as_deref(),
                group_id.as_ref().map(Option::as_deref),
            )?),
            DriftCommand::TrashDrift { drift_id } => {
                let key = (project_id.to_owned(), drift_id.clone());
                if let Some(handle) = self.drift_bodies.get(&key) {
                    documents
                        .get_mut(handle)
                        .ok_or("Workspace document owner is missing")?
                        .prepare_to_release()?;
                }
                let trashed = store.trash_drift(&self.context(&project)?, drift_id)?;
                if let Some(handle) = self.drift_bodies.remove(&key) {
                    documents.remove(&handle);
                }
                json!(trashed)
            }
            DriftCommand::RestoreDrift { drift_id } => {
                if self
                    .drift_bodies
                    .contains_key(&(project_id.into(), drift_id.clone()))
                {
                    return Err("Drift still has a live document owner".into());
                }
                json!(drifting_prose::workspace::restore_drift(
                    &self.gateway,
                    CLIENT,
                    &self.context(&project)?,
                    drift_id,
                )?)
            }
            DriftCommand::CreateGroup {
                name,
                parent_group_id,
            } => json!(store.create_drift_group(
                &self.context(&project)?,
                &identifier("drift-group")?,
                name,
                parent_group_id.as_deref(),
            )?),
            DriftCommand::RenameGroup { group_id, name } => {
                json!(store.rename_drift_group(&self.context(&project)?, group_id, name)?)
            }
            DriftCommand::DeleteGroup { group_id } => {
                store.delete_drift_group(&self.context(&project)?, group_id)?;
                Value::Null
            }
            DriftCommand::BindAct { act_id, drift_id } => json!(store.bind_act_drift(
                &self.context(&project)?,
                act_id,
                drift_id.as_deref(),
            )?),
            DriftCommand::OpenDrift { drift_id } => {
                return self.open_drift(documents, project_id, drift_id);
            }
            DriftCommand::CloseDrift { drift_id } => {
                let key = (project_id.to_owned(), drift_id.clone());
                let handle = *self
                    .drift_bodies
                    .get(&key)
                    .ok_or("Drift is not open in this workspace")?;
                documents
                    .get_mut(&handle)
                    .ok_or("Workspace document owner is missing")?
                    .prepare_to_release()?;
                self.drift_bodies.remove(&key);
                documents.remove(&handle);
                return Ok(Value::Null);
            }
        };
        Ok(json!({
            "result": result,
            "library": {
                "drifts": store.drifts(project_id)?,
                "trashedDrifts": store.trashed_drifts(project_id)?,
                "groups": store.drift_groups(project_id)?,
            },
        }))
    }

    fn open_drift(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        drift_id: &str,
    ) -> Result<Value, String> {
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        if !store.drifts(project_id)?.iter().any(|d| d.id == drift_id) {
            return Err("Drift is not available in this project".into());
        }
        let key = (project_id.to_owned(), drift_id.to_owned());
        if let Some(handle) = self.drift_bodies.get(&key) {
            let state = documents
                .get(handle)
                .ok_or("Workspace document owner is missing")?
                .document_state()?;
            return Ok(
                json!({"handle":handle,"projectId":project_id,"driftId":drift_id,"document":state}),
            );
        }
        for handle in self.document_handles() {
            documents
                .get_mut(&handle)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
        }
        let scope = store.document_scope(project_id, &format!("node-content:{drift_id}"))?;
        let candidate = LabSession::open_body(
            self.directory.clone(),
            self.gateway.clone(),
            scope,
            "node",
            drift_id.into(),
            self.installation_id.clone(),
        )?;
        let state = candidate.document_state()?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        documents.insert(handle, candidate);
        self.drift_bodies.insert(key, handle);
        Ok(json!({"handle":handle,"projectId":project_id,"driftId":drift_id,"document":state}))
    }
}
