//! Elements library commands and element body owners. Domain writes live in
//! drifting-core; an element body is an ordinary durable prose owner keyed
//! separately from chapters.
use super::*;
use drifting_core::workspace::{ElementChanges, Fact, NewElement, NewElementCategory};
use serde::Deserializer;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ElementCommand {
    Library,
    CreateCategory {
        name: String,
    },
    UpdateCategory {
        category_id: String,
        name: Option<String>,
        color: Option<String>,
    },
    CreateElement {
        category_id: String,
        name: Option<String>,
        group_name: Option<String>,
    },
    UpdateElement {
        element_id: String,
        name: Option<String>,
        summary: Option<String>,
        #[serde(default, deserialize_with = "present")]
        group_name: Option<Option<String>>,
        #[serde(default, deserialize_with = "present")]
        category_id: Option<Option<String>>,
        aliases: Option<Vec<String>>,
    },
    SetElementFacts {
        element_id: String,
        facts: Vec<Fact>,
    },
    SetCategoryTemplateFacts {
        category_id: String,
        facts: Vec<Fact>,
    },
    TrashCategory {
        category_id: String,
    },
    RestoreCategory {
        category_id: String,
    },
    TrashElement {
        element_id: String,
    },
    RestoreElement {
        element_id: String,
    },
    OpenElement {
        element_id: String,
        #[serde(default)]
        reopen: bool,
    },
    CloseElement {
        element_id: String,
    },
}

/// Distinguishes an absent optional field from an explicit `null`.
fn present<'de, D: Deserializer<'de>>(value: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(value).map(Some)
}

fn empty_body() -> Result<ChapterSeed, String> {
    let mut seed = DocumentSession::new();
    seed.edit(Edit::AppendParagraph {
        id: identifier("paragraph")?,
        text: String::new(),
    })?;
    Ok(ChapterSeed {
        update: seed.update(None, 1)?,
        content_json: seed.semantic()?.to_string(),
    })
}

/// An uppercase `#RRGGBB`, like the renderer's random category colour.
fn category_colour() -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .subsec_nanos();
    let mixed = nanos
        .wrapping_add(NEXT_WRITER.fetch_add(1, Ordering::Relaxed) as u32)
        .wrapping_mul(2_654_435_761);
    Ok(format!("#{:06X}", mixed >> 8))
}

impl WorkspaceSession {
    pub(super) fn elements(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        command: &ElementCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let result = match command {
            ElementCommand::Library => Value::Null,
            ElementCommand::CreateCategory { name } => {
                json!(store.create_element_category(
                    &self.context(&project)?,
                    NewElementCategory {
                        id: identifier("category")?,
                        name: name.clone(),
                        color: category_colour()?,
                        seed: empty_body()?,
                    },
                )?)
            }
            ElementCommand::UpdateCategory {
                category_id,
                name,
                color,
            } => json!(store.update_element_category(
                &self.context(&project)?,
                category_id,
                name.as_deref(),
                color.as_deref(),
            )?),
            ElementCommand::CreateElement {
                category_id,
                name,
                group_name,
            } => json!(store.create_element(
                &self.context(&project)?,
                NewElement {
                    id: identifier("element")?,
                    category_id: category_id.clone(),
                    name: name.clone(),
                    group_name: group_name.clone(),
                    seed: empty_body()?,
                },
                &mut || identifier("fact"),
            )?),
            ElementCommand::SetElementFacts { element_id, facts } => json!(store
                .set_element_facts(&self.context(&project)?, element_id, facts, &mut || {
                    identifier("fact")
                },)?),
            ElementCommand::SetCategoryTemplateFacts { category_id, facts } => json!(store
                .set_category_template_facts(
                    &self.context(&project)?,
                    category_id,
                    facts,
                    &mut || identifier("fact"),
                )?),
            ElementCommand::TrashCategory { category_id } => {
                json!(store.trash_element_category(&self.context(&project)?, category_id)?)
            }
            ElementCommand::RestoreCategory { category_id } => {
                json!(drifting_prose::workspace::restore_element_category(
                    &self.gateway,
                    CLIENT,
                    &self.context(&project)?,
                    category_id,
                )?)
            }
            ElementCommand::UpdateElement {
                element_id,
                name,
                summary,
                group_name,
                category_id,
                aliases,
            } => json!(store.update_element(
                &self.context(&project)?,
                element_id,
                ElementChanges {
                    name: name.clone(),
                    summary: summary.clone(),
                    group_name: group_name.clone(),
                    category_id: category_id.clone(),
                    aliases: aliases.clone(),
                },
            )?),
            ElementCommand::TrashElement { element_id } => {
                let key = (project_id.to_owned(), element_id.clone());
                if let Some(handle) = self.elements.get(&key) {
                    documents
                        .get_mut(handle)
                        .ok_or("Workspace document owner is missing")?
                        .prepare_to_release()?;
                }
                let trashed = store.trash_element(&self.context(&project)?, element_id)?;
                // The retired owner never checkpoints after its lifecycle changed.
                if let Some(handle) = self.elements.remove(&key) {
                    documents.remove(&handle);
                }
                json!(trashed)
            }
            ElementCommand::RestoreElement { element_id } => {
                if self
                    .elements
                    .contains_key(&(project_id.into(), element_id.clone()))
                {
                    return Err("Element still has a live document owner".into());
                }
                json!(drifting_prose::workspace::restore_element(
                    &self.gateway,
                    CLIENT,
                    &self.context(&project)?,
                    element_id,
                )?)
            }
            ElementCommand::OpenElement { element_id, reopen } => {
                return self.open_element(documents, project_id, element_id, *reopen);
            }
            ElementCommand::CloseElement { element_id } => {
                let key = (project_id.to_owned(), element_id.clone());
                let handle = *self
                    .elements
                    .get(&key)
                    .ok_or("Element is not open in this workspace")?;
                documents
                    .get_mut(&handle)
                    .ok_or("Workspace document owner is missing")?
                    .prepare_to_release()?;
                self.elements.remove(&key);
                documents.remove(&handle);
                return Ok(Value::Null);
            }
        };
        Ok(json!({
            "result": result,
            "library": {
                "categories": store.element_categories(project_id)?,
                "elements": store.elements(project_id)?,
                "trashedElements": store.trashed_elements(project_id)?,
                "trashedCategories": store.trashed_element_categories(project_id)?,
            },
        }))
    }

    fn open_element(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        element_id: &str,
        reopen: bool,
    ) -> Result<Value, String> {
        let scope =
            WorkspaceStore::new(&self.gateway, CLIENT).element_scope(project_id, element_id)?;
        let key = (project_id.to_owned(), element_id.to_owned());
        let previous = self.elements.get(&key).copied();
        if reopen && previous.is_none() {
            return Err("Element is not open in this workspace".into());
        }
        if let (Some(handle), false) = (previous, reopen) {
            let owner = documents
                .get(&handle)
                .ok_or("Workspace document owner is missing")?;
            if owner.owner.scope != scope {
                return Err("Open element scope changed; reopen before editing".into());
            }
            let state = owner.document_state()?;
            return Ok(
                json!({"handle":handle,"projectId":project_id,"elementId":element_id,"document":state}),
            );
        }
        // As with chapters: every other owner saves first; an explicit reopen
        // replaces only this element's owner after the new one is ready.
        let handles = match previous {
            Some(handle) => vec![handle],
            None => self.document_handles(),
        };
        for handle in handles {
            documents
                .get_mut(&handle)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
        }
        let candidate = LabSession::open_body(
            self.directory.clone(),
            self.gateway.clone(),
            scope,
            "element",
            element_id.into(),
            self.installation_id.clone(),
        )?;
        let state = candidate.document_state()?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        documents.insert(handle, candidate);
        if let Some(previous) = self.elements.insert(key, handle) {
            documents.remove(&previous);
        }
        Ok(json!({"handle":handle,"projectId":project_id,"elementId":element_id,"document":state}))
    }
}
