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
        /// Written in the same original; absent fields start empty (facts
        /// from the category template).
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        aliases: Option<Vec<String>>,
        #[serde(default)]
        facts: Option<Vec<Fact>>,
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
    Backlinks {
        element_id: String,
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
    OpenCategory {
        category_id: String,
    },
    CloseCategory {
        category_id: String,
    },
    /// The category's element body template as editable blocks.
    ElementTemplate {
        category_id: String,
    },
    SetElementTemplate {
        category_id: String,
        blocks: Vec<super::transfer::ImportBlock>,
    },
    /// The element overview's category placements.
    CategoryLayouts,
    /// Both cells pin the category; both absent or null return it to auto.
    SetCategoryLayout {
        category_id: String,
        grid_x: Option<i64>,
        grid_y: Option<i64>,
    },
}

/// Distinguishes an absent optional field from an explicit `null`.
pub(super) fn present<'de, D: Deserializer<'de>>(
    value: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(value).map(Some)
}

pub(super) fn empty_body() -> Result<ChapterSeed, String> {
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
pub(super) fn category_colour() -> Result<String, String> {
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
                summary,
                aliases,
                facts,
            } => {
                let template = super::transfer::template_blocks(
                    &store.category_element_template(project_id, category_id)?,
                )?;
                let element = store.create_element(
                    &self.context(&project)?,
                    NewElement {
                        id: identifier("element")?,
                        category_id: category_id.clone(),
                        name: name.clone(),
                        group_name: group_name.clone(),
                        seed: empty_body()?,
                        summary: summary.clone().unwrap_or_default(),
                        aliases: aliases.clone().unwrap_or_default(),
                        facts: facts.clone(),
                    },
                    &mut || identifier("fact"),
                )?;
                // The category's body template fills the new body through a
                // short-lived owner, as the author's input.
                if !template.is_empty() {
                    let scope =
                        store.document_scope(project_id, &format!("element:{}", element.id))?;
                    let mut owner = LabSession::open_body(
                        self.directory.clone(),
                        self.gateway.clone(),
                        scope,
                        "element",
                        element.id.clone(),
                        self.installation_id.clone(),
                    )?;
                    let filled = owner.import_blocks(&template);
                    let released = owner.prepare_to_release();
                    filled?;
                    released?;
                }
                json!(element)
            }
            ElementCommand::ElementTemplate { category_id } => {
                super::transfer::blocks_value(&super::transfer::template_blocks(
                    &store.category_element_template(project_id, category_id)?,
                )?)
            }
            ElementCommand::SetElementTemplate {
                category_id,
                blocks,
            } => json!(store.set_category_element_template(
                &self.context(&project)?,
                category_id,
                &super::transfer::template_json(blocks)?,
            )?),
            ElementCommand::CategoryLayouts => json!(store.category_layouts(project_id)?),
            ElementCommand::SetCategoryLayout {
                category_id,
                grid_x,
                grid_y,
            } => {
                let cell = match (grid_x, grid_y) {
                    (Some(x), Some(y)) => Some((*x, *y)),
                    (None, None) => None,
                    _ => return Err("Pin a category with both grid coordinates".into()),
                };
                json!(store.set_category_layout(&self.context(&project)?, category_id, cell)?)
            }
            ElementCommand::OpenCategory { category_id } => {
                return self.open_category(documents, project_id, category_id);
            }
            ElementCommand::CloseCategory { category_id } => {
                let key = (project_id.to_owned(), category_id.clone());
                let handle = *self
                    .category_bodies
                    .get(&key)
                    .ok_or("Category is not open in this workspace")?;
                documents
                    .get_mut(&handle)
                    .ok_or("Workspace document owner is missing")?
                    .prepare_to_release()?;
                self.category_bodies.remove(&key);
                documents.remove(&handle);
                return Ok(Value::Null);
            }
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
                let key = (project_id.to_owned(), category_id.clone());
                if let Some(handle) = self.category_bodies.get(&key) {
                    documents
                        .get_mut(handle)
                        .ok_or("Workspace document owner is missing")?
                        .prepare_to_release()?;
                }
                let trashed =
                    store.trash_element_category(&self.context(&project)?, category_id)?;
                // The retired owner never checkpoints after its lifecycle changed.
                if let Some(handle) = self.category_bodies.remove(&key) {
                    documents.remove(&handle);
                }
                json!(trashed)
            }
            ElementCommand::RestoreCategory { category_id } => {
                if self
                    .category_bodies
                    .contains_key(&(project_id.into(), category_id.clone()))
                {
                    return Err("Category still has a live document owner".into());
                }
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
            ElementCommand::Backlinks { element_id } => {
                return self.element_backlinks(documents, project_id, element_id);
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

    /// Chapters whose prose links this element, in book order, read from
    /// live owners or a cold durable read; unreadable chapters are reported.
    /// `sources` lists the drift, element, category and storyline pages that
    /// link it, read the same way with a per-revision cache for cold bodies.
    fn element_backlinks(
        &mut self,
        documents: &HashMap<u64, LabSession>,
        project_id: &str,
        element_id: &str,
    ) -> Result<Value, String> {
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let mut chapters = Vec::new();
        let mut unavailable = Vec::new();
        for chapter in store.list_chapters(project_id)? {
            let read = (|| -> Result<Vec<drifting_document::EntityLinkSpan>, String> {
                let scope = store.chapter_scope(project_id, &chapter.id)?;
                let key = (project_id.to_owned(), chapter.id.clone());
                if let Some(owner) = self.documents.get(&key).and_then(|h| documents.get(h)) {
                    return owner.document.entity_link_spans();
                }
                let reader = DurableDocument::open_with_scope(self.gateway.clone(), CLIENT, scope)?;
                if reader.has_pending() {
                    return Err("Chapter prose dependencies are unresolved".into());
                }
                reader.entity_link_spans()
            })();
            match read {
                Ok(spans) => {
                    let spans: Vec<_> = spans
                        .into_iter()
                        .filter(|span| span.kind == "element" && span.id == element_id)
                        .collect();
                    if let Some(first) = spans.first() {
                        let mut blocks: Vec<_> =
                            spans.iter().map(|span| span.block_id.clone()).collect();
                        blocks.dedup();
                        chapters.push(
                            json!({"chapterId": chapter.id, "chapterTitle": chapter.title,
                            "spans": spans.len(), "blocks": blocks.len(), "first": first.range}),
                        );
                    }
                }
                Err(_) => unavailable
                    .push(json!({"chapterId": chapter.id, "chapterTitle": chapter.title})),
            }
        }
        let mut pages: Vec<(&str, String, String, String)> = Vec::new();
        for drift in store.drifts(project_id)? {
            pages.push(("drift", drift.id, drift.title, drift.document_id));
        }
        for element in store.elements(project_id)? {
            if element.id != element_id {
                pages.push(("element", element.id, element.name, element.document_id));
            }
        }
        for category in store.element_categories(project_id)? {
            pages.push(("category", category.id, category.name, category.document_id));
        }
        for storyline in store.storylines(project_id)? {
            pages.push((
                "storyline",
                storyline.id,
                storyline.name,
                storyline.document_id,
            ));
        }
        let revisions: HashMap<String, i64> = self
            .gateway
            .query(
                "SELECT document_id,revision FROM yjs_document_revision".into(),
                vec![],
                None,
                CLIENT.into(),
            )?
            .rows
            .iter()
            .filter_map(|row| match (&row[0], &row[1]) {
                (DatabaseValue::Text(id), DatabaseValue::Integer(revision)) => {
                    revision.parse().ok().map(|revision| (id.clone(), revision))
                }
                _ => None,
            })
            .collect();
        let mut cache = std::mem::take(&mut self.link_spans);
        let mut sources = Vec::new();
        let mut unavailable_sources = Vec::new();
        for (kind, id, title, document_id) in pages {
            let read = (|| -> Result<Vec<drifting_document::EntityLinkSpan>, String> {
                let key = (project_id.to_owned(), id.clone());
                if let Some(owner) = self
                    .body_owner(kind, &key)
                    .and_then(|handle| documents.get(&handle))
                {
                    return owner.document.entity_link_spans();
                }
                let revision = revisions.get(&document_id).copied().unwrap_or(-1);
                if let Some((cached, spans)) = cache.get(&document_id) {
                    if *cached == revision {
                        return Ok(spans.clone());
                    }
                }
                let scope = store.document_scope(project_id, &document_id)?;
                let reader = DurableDocument::open_with_scope(self.gateway.clone(), CLIENT, scope)?;
                if reader.has_pending() {
                    return Err("Body prose dependencies are unresolved".into());
                }
                let spans = reader.entity_link_spans()?;
                cache.insert(document_id.clone(), (revision, spans.clone()));
                Ok(spans)
            })();
            match read {
                Ok(spans) => {
                    let spans: Vec<_> = spans
                        .into_iter()
                        .filter(|span| span.kind == "element" && span.id == element_id)
                        .collect();
                    if let Some(first) = spans.first() {
                        let mut blocks: Vec<_> =
                            spans.iter().map(|span| span.block_id.clone()).collect();
                        blocks.dedup();
                        sources.push(json!({"kind": kind, "id": id, "title": title,
                            "spans": spans.len(), "blocks": blocks.len(), "first": first.range}));
                    }
                }
                Err(_) => unavailable_sources.push(json!({"kind": kind, "id": id, "title": title})),
            }
        }
        self.link_spans = cache;
        Ok(
            json!({"elementId": element_id, "chapters": chapters, "sources": sources,
            "unavailable": unavailable, "unavailableSources": unavailable_sources}),
        )
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

impl WorkspaceSession {
    fn open_category(
        &mut self,
        documents: &mut HashMap<u64, LabSession>,
        project_id: &str,
        category_id: &str,
    ) -> Result<Value, String> {
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        if !store
            .element_categories(project_id)?
            .iter()
            .any(|c| c.id == category_id)
        {
            return Err("Category is not available in this project".into());
        }
        let key = (project_id.to_owned(), category_id.to_owned());
        if let Some(handle) = self.category_bodies.get(&key) {
            let state = documents
                .get(handle)
                .ok_or("Workspace document owner is missing")?
                .document_state()?;
            return Ok(
                json!({"handle":handle,"projectId":project_id,"categoryId":category_id,"document":state}),
            );
        }
        for handle in self.document_handles() {
            documents
                .get_mut(&handle)
                .ok_or("Workspace document owner is missing")?
                .prepare_to_release()?;
        }
        let scope = store.document_scope(project_id, &format!("category:{category_id}"))?;
        let candidate = LabSession::open_body(
            self.directory.clone(),
            self.gateway.clone(),
            scope,
            "category",
            category_id.into(),
            self.installation_id.clone(),
        )?;
        let state = candidate.document_state()?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        documents.insert(handle, candidate);
        self.category_bodies.insert(key, handle);
        Ok(
            json!({"handle":handle,"projectId":project_id,"categoryId":category_id,"document":state}),
        )
    }
}
