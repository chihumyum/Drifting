//! Storylines and chapter membership commands, and storyline body owners.
//! Domain writes live in drifting-core; a storyline body is an ordinary
//! durable prose owner keyed apart from chapters and elements.
use super::elements::{category_colour, empty_body};
use super::*;
use drifting_core::workspace::{Fact, NewStoryline, StorylineChanges};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum StorylineCommand {
    Library,
    CreateStoryline {
        name: String,
    },
    UpdateStoryline {
        storyline_id: String,
        name: Option<String>,
        color: Option<String>,
        summary: Option<String>,
    },
    MoveStoryline {
        storyline_id: String,
        before_storyline_id: Option<String>,
    },
    SetStorylineFacts {
        storyline_id: String,
        facts: Vec<Fact>,
    },
    SetChapterStorylines {
        chapter_id: String,
        storyline_ids: Vec<String>,
        /// Absent keeps the current primary; `null` clears it.
        #[serde(default, deserialize_with = "super::elements::present")]
        primary: Option<Option<String>>,
    },
    /// The 章节模版 as editable blocks.
    ChapterTemplate {
        storyline_id: String,
    },
    SetChapterTemplate {
        storyline_id: String,
        blocks: Vec<super::transfer::ImportBlock>,
    },
    TrashStoryline {
        storyline_id: String,
    },
    RestoreStoryline {
        storyline_id: String,
    },
    OpenStoryline {
        storyline_id: String,
    },
    CloseStoryline {
        storyline_id: String,
    },
}

impl WorkspaceSession {
    pub(super) fn storylines(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        command: &StorylineCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let result = match command {
            StorylineCommand::Library => Value::Null,
            StorylineCommand::ChapterTemplate { storyline_id } => {
                super::transfer::blocks_value(&super::transfer::template_blocks(
                    &store.storyline_chapter_template(project_id, storyline_id)?,
                )?)
            }
            StorylineCommand::SetChapterTemplate {
                storyline_id,
                blocks,
            } => json!(store.set_storyline_chapter_template(
                &self.context(&project)?,
                storyline_id,
                &super::transfer::template_json(blocks)?,
            )?),
            StorylineCommand::CreateStoryline { name } => json!(store.create_storyline(
                &self.context(&project)?,
                NewStoryline {
                    id: identifier("storyline")?,
                    name: name.clone(),
                    color: category_colour()?,
                    seed: empty_body()?,
                },
                &mut || identifier("fact"),
            )?),
            StorylineCommand::UpdateStoryline {
                storyline_id,
                name,
                color,
                summary,
            } => json!(store.update_storyline(
                &self.context(&project)?,
                storyline_id,
                StorylineChanges {
                    name: name.clone(),
                    color: color.clone(),
                    summary: summary.clone(),
                },
            )?),
            StorylineCommand::MoveStoryline {
                storyline_id,
                before_storyline_id,
            } => json!(store.move_storyline(
                &self.context(&project)?,
                storyline_id,
                before_storyline_id.as_deref(),
            )?),
            StorylineCommand::SetStorylineFacts {
                storyline_id,
                facts,
            } => json!(store.set_storyline_facts(
                &self.context(&project)?,
                storyline_id,
                facts,
                &mut || identifier("fact"),
            )?),
            StorylineCommand::SetChapterStorylines {
                chapter_id,
                storyline_ids,
                primary,
            } => json!(store.set_chapter_storylines(
                &self.context(&project)?,
                chapter_id,
                storyline_ids,
                primary.as_ref().map(Option::as_deref),
            )?),
            StorylineCommand::TrashStoryline { storyline_id } => {
                let key = (project_id.to_owned(), storyline_id.clone());
                if let Some(handle) = self.storyline_bodies.get(&key) {
                    documents
                        .get_mut(handle)
                        .ok_or("Workspace document owner is missing")?
                        .prepare_to_release()?;
                }
                let trashed = store.trash_storyline(&self.context(&project)?, storyline_id)?;
                if let Some(handle) = self.storyline_bodies.remove(&key) {
                    documents.remove(&handle);
                }
                json!(trashed)
            }
            StorylineCommand::RestoreStoryline { storyline_id } => {
                if self
                    .storyline_bodies
                    .contains_key(&(project_id.into(), storyline_id.clone()))
                {
                    return Err("Storyline still has a live document owner".into());
                }
                json!(drifting_prose::workspace::restore_storyline(
                    &self.gateway,
                    CLIENT,
                    &self.context(&project)?,
                    storyline_id,
                )?)
            }
            StorylineCommand::OpenStoryline { storyline_id } => {
                return self.open_storyline(documents, project_id, storyline_id);
            }
            StorylineCommand::CloseStoryline { storyline_id } => {
                let key = (project_id.to_owned(), storyline_id.clone());
                let handle = *self
                    .storyline_bodies
                    .get(&key)
                    .ok_or("Storyline is not open in this workspace")?;
                documents
                    .get_mut(&handle)
                    .ok_or("Workspace document owner is missing")?
                    .prepare_to_release()?;
                self.storyline_bodies.remove(&key);
                documents.remove(&handle);
                return Ok(Value::Null);
            }
        };
        Ok(json!({
            "result": result,
            "library": {
                "storylines": store.storylines(project_id)?,
                "trashedStorylines": store.trashed_storylines(project_id)?,
                "memberships": store.chapter_memberships(project_id)?,
            },
        }))
    }

    fn open_storyline(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        storyline_id: &str,
    ) -> Result<Value, String> {
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        if !store
            .storylines(project_id)?
            .iter()
            .any(|s| s.id == storyline_id)
        {
            return Err("Storyline is not available in this project".into());
        }
        let key = (project_id.to_owned(), storyline_id.to_owned());
        if let Some(handle) = self.storyline_bodies.get(&key) {
            let state = documents
                .get(handle)
                .ok_or("Workspace document owner is missing")?
                .document_state()?;
            return Ok(
                json!({"handle":handle,"projectId":project_id,"storylineId":storyline_id,"document":state}),
            );
        }
        for handle in self.document_handles() {
            documents
                .get_mut(&handle)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
        }
        let scope = store.document_scope(project_id, &format!("storyline:{storyline_id}"))?;
        let candidate = LabSession::open_body(
            self.directory.clone(),
            self.gateway.clone(),
            scope,
            "storyline",
            storyline_id.into(),
            self.installation_id.clone(),
        )?;
        let state = candidate.document_state()?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        documents.insert(handle, candidate);
        self.storyline_bodies.insert(key, handle);
        Ok(
            json!({"handle":handle,"projectId":project_id,"storylineId":storyline_id,"document":state}),
        )
    }
}
