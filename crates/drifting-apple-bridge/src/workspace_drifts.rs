//! Drift notes, drift groups and act binding, and drift body owners. Domain
//! writes live in drifting-core; a drift body is an ordinary durable prose
//! owner (`node-content:<id>`) keyed apart from chapters.
use super::elements::{empty_body, present};
use super::*;
use drifting_core::workspace::{NewDrift, NewElement};

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
    /// 转为章节: the same node joins the book, primary in `storylineId`.
    ConvertToChapter {
        drift_id: String,
        #[serde(default)]
        storyline_id: Option<String>,
    },
    /// 转为设定: a new element in `categoryId` with the drift's title,
    /// summary and body; the drift then goes to the trash.
    ConvertToElement {
        drift_id: String,
        category_id: String,
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
            DriftCommand::ConvertToChapter {
                drift_id,
                storyline_id,
            } => {
                let key = (project_id.to_owned(), drift_id.clone());
                if let Some(handle) = self.drift_bodies.get(&key) {
                    documents
                        .get_mut(handle)
                        .ok_or("Workspace document owner is missing")?
                        .prepare_to_release()?;
                }
                let chapter = store.convert_drift_to_chapter(
                    &self.context(&project)?,
                    drift_id,
                    storyline_id.as_deref(),
                )?;
                // The body now opens as a chapter.
                if let Some(handle) = self.drift_bodies.remove(&key) {
                    documents.remove(&handle);
                }
                json!(chapter)
            }
            DriftCommand::ConvertToElement {
                drift_id,
                category_id,
            } => {
                let key = (project_id.to_owned(), drift_id.clone());
                if let Some(handle) = self.drift_bodies.get(&key) {
                    documents
                        .get_mut(handle)
                        .ok_or("Workspace document owner is missing")?
                        .prepare_to_release()?;
                }
                let drift = store
                    .drifts(project_id)?
                    .into_iter()
                    .find(|drift| drift.id == *drift_id)
                    .ok_or("灵感不存在或已在回收站")?;
                let state = {
                    let repository = ProseRepository::new(&self.gateway, CLIENT);
                    let tx = self
                        .gateway
                        .begin(TransactionBehavior::Deferred, CLIENT.into())?;
                    let loaded = drifting_prose::load_document(&repository, &drift.document_id, tx)
                        .and_then(|(document, _)| document.update(None, 1));
                    let _ = self.gateway.rollback(tx, CLIENT.into());
                    loaded?
                };
                let context = self.context(&project)?;
                let element = store.create_element(
                    &context,
                    NewElement {
                        id: identifier("element")?,
                        category_id: category_id.clone(),
                        name: Some(drift.title.clone()).filter(|title| !title.trim().is_empty()),
                        group_name: None,
                        seed: empty_body()?,
                        summary: drift.summary.clone(),
                        aliases: Vec::new(),
                        facts: None,
                    },
                    &mut || identifier("fact"),
                )?;
                // From here the element exists, so every failure says so.
                let created = |error: String| format!("设定「{}」已创建{error}", element.name);
                // The drift's body replaces the new body through a
                // short-lived owner, as the author's input.
                let copied = store
                    .document_scope(project_id, &format!("element:{}", element.id))
                    .and_then(|scope| {
                        LabSession::open_body(
                            self.directory.clone(),
                            self.gateway.clone(),
                            scope,
                            "element",
                            element.id.clone(),
                            self.installation_id.clone(),
                        )
                    })
                    .and_then(|mut owner| {
                        let copied = owner.document.replace_with_state(&state).and_then(|()| {
                            owner.persist();
                            owner.save_error.clone().map_or(Ok(()), Err)
                        });
                        let released = owner.prepare_to_release();
                        copied.and(released)
                    });
                if let Err(error) = copied {
                    return Err(created(format!("，但灵感正文未能复制：{error}")));
                }
                // Relations and whole-drift notes follow the element and the
                // drift goes to the trash, together or not at all.
                let carried = store.carry_drift_to_element_and_trash(
                    &context,
                    drift_id,
                    &element.id,
                    &mut || identifier("relation"),
                );
                if let Some(handle) = self.drift_bodies.remove(&key) {
                    documents.remove(&handle);
                }
                let carried = carried.map_err(|error| {
                    created(format!(
                        "并复制了正文，但灵感未能移入回收站（关系和批注没有转移）：{error}"
                    ))
                })?;
                json!({"element": element, "driftId": drift_id, "carried": carried})
            }
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
