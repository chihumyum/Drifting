//! Elements library: categories and elements with the renderer's rows,
//! alias set and canonical originals. Element and category bodies are Yjs
//! documents (`element:<id>`, `category:<id>`) seeded like chapters.
//! Facts use the normalized key/value authority. Trash purges relations
//! first; portraits live in the materials library. Category body templates
//! are not yet ported.
use super::facts::{Fact, FactOwner};
use super::*;
use crate::prose_journal::encoding::Cbor;
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
mod tests;

const DEFAULT_ELEMENT: &str = "New Element";
const DEFAULT_CATEGORY: &str = "New Category";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceElementCategory {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub template_facts: Vec<Fact>,
    pub document_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryLayout {
    pub category_id: String,
    /// `auto` or `pinned`.
    pub layout_mode: String,
    pub grid_x: Option<i64>,
    pub grid_y: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceElement {
    pub id: String,
    pub project_id: String,
    pub category_id: Option<String>,
    pub name: String,
    pub summary: String,
    pub aliases: Vec<String>,
    pub group_name: Option<String>,
    pub facts: Vec<Fact>,
    pub document_id: String,
    pub created_at: String,
    pub updated_at: String,
}

pub struct NewElementCategory {
    pub id: String,
    pub name: String,
    /// `#RRGGBB`, chosen by the host like the renderer's random colour.
    pub color: String,
    pub seed: ChapterSeed,
}

pub struct NewElement {
    pub id: String,
    pub category_id: String,
    /// `None` derives "New Element", "New Element 2", ... like the renderer.
    pub name: Option<String>,
    pub group_name: Option<String>,
    pub seed: ChapterSeed,
    /// Written in the same original as the element; empty by default.
    pub summary: String,
    pub aliases: Vec<String>,
    /// `None` starts from the category's template facts.
    pub facts: Option<Vec<Fact>>,
}

/// Present fields are written; `Some(None)` clears an optional field.
#[derive(Default)]
pub struct ElementChanges {
    pub name: Option<String>,
    pub summary: Option<String>,
    pub group_name: Option<Option<String>>,
    pub category_id: Option<Option<String>>,
    pub aliases: Option<Vec<String>>,
}

struct LiveElement {
    element: WorkspaceElement,
    incarnation: u64,
    portrait: bool,
}

impl WorkspaceStore<'_> {
    pub fn element_categories(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorkspaceElementCategory>, String> {
        self.query(
            None,
            &format!(
                r#"
            SELECT {CATEGORY_COLUMNS} FROM element_category c
            JOIN sync_generation g ON g.project_id=c.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='element-category' AND l.entity_id=c.id
            WHERE c.project_id=? AND c.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')
            ORDER BY c.name,c.rowid
        "#
            ),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| category_from_row(row))
        .collect()
    }

    pub fn trashed_element_categories(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorkspaceElementCategory>, String> {
        self.query(
            None,
            &format!(
                r#"
            SELECT {CATEGORY_COLUMNS} FROM element_category c
            JOIN sync_generation g ON g.project_id=c.project_id AND g.status='active'
            JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='element-category' AND l.entity_id=c.id AND l.state='trashed'
            WHERE c.project_id=? AND c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC,c.rowid
        "#
            ),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| category_from_row(row))
        .collect()
    }

    pub fn elements(&self, project_id: &str) -> Result<Vec<WorkspaceElement>, String> {
        self.element_rows(None, project_id, false)
    }

    pub fn trashed_elements(&self, project_id: &str) -> Result<Vec<WorkspaceElement>, String> {
        self.element_rows(None, project_id, true)
    }

    pub fn element_scope(
        &self,
        project_id: &str,
        element_id: &str,
    ) -> Result<ArchiveScope, String> {
        self.transaction(TransactionBehavior::Deferred, |tx| {
            let element = self
                .element_rows(Some(tx), project_id, false)?
                .into_iter()
                .find(|element| element.id == element_id)
                .ok_or("Element is not available in this project")?;
            let rows = self.query(Some(tx), "SELECT project_sync_id,sync_generation_id FROM sync_generation WHERE project_id=? AND status='active'", vec![text(project_id)])?;
            let row = rows.first().ok_or("Project has no active sync generation")?;
            let (project_sync_id, sync_generation_id) = (string(row, 0)?, string(row, 1)?);
            let incarnation = AuthoredProseJournal::new(self.gateway, self.client).current_incarnation(
                tx, project_id, &project_sync_id, &sync_generation_id, &element.document_id)?;
            Ok(ArchiveScope { project_id: project_id.into(), project_sync_id, sync_generation_id,
                document_id: element.document_id, incarnation })
        })
    }

    pub fn create_element_category(
        &self,
        context: &AuthoredProseContext,
        input: NewElementCategory,
    ) -> Result<WorkspaceElementCategory, String> {
        validate_context(context)?;
        let doc_id = format!("category:{}", input.id);
        if !opaque(&input.id) || !opaque(&doc_id) || !color(&input.color) {
            return Err("Invalid category identity or colour".into());
        }
        validate_seed(&input.seed)?;
        let name = match js_trim(&input.name) {
            "" => DEFAULT_CATEGORY,
            name => name,
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let appended = self.seed_document(tx, context, &doc_id, &input.seed)?;
            self.execute(tx, r#"
                INSERT INTO element_category(id,name,content_json,element_template_json,element_template_kv_json,
                    color,project_id,layout_mode,grid_x,grid_y,deleted_at,created_at,updated_at)
                VALUES (?,?,?,'{}','[]',?,?,'auto',NULL,NULL,NULL,?,?)
            "#, vec![text(&input.id), text(name), text(&input.seed.content_json), text(&input.color),
                text(&context.project_id), text(&context.now_iso), text(&context.now_iso)])?;
            self.commit_changes(tx, context, &[
                journal::Mutation::create("element-category", &input.id, json!({
                    "color": input.color, "elementTemplateJson": "{}", "gridX": null, "gridY": null,
                    "layoutMode": "auto", "name": name,
                })),
                journal::Mutation::yjs(&doc_id, &input.seed.update),
            ], Some((1, &appended, &input.seed.update)))?;
            Ok(WorkspaceElementCategory {
                id: input.id.clone(), project_id: context.project_id.clone(), name: name.into(),
                color: input.color.clone(), template_facts: Vec::new(), document_id: doc_id.clone(),
                created_at: context.now_iso.clone(), updated_at: context.now_iso.clone(),
            })
        })
    }

    /// Rename or recolour a live category; unchanged values write nothing.
    pub fn update_element_category(
        &self,
        context: &AuthoredProseContext,
        category_id: &str,
        name: Option<&str>,
        colour: Option<&str>,
    ) -> Result<WorkspaceElementCategory, String> {
        validate_context(context)?;
        let name = name.map(js_trim);
        if name == Some("") || colour.is_some_and(|value| !color(value)) {
            return Err("Category name is empty or colour is invalid".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut category, incarnation) = self.live_category(tx, context, category_id)?;
            let mut mutations = Vec::new();
            if let Some(colour) = colour.filter(|value| *value != category.color) {
                category.color = colour.into();
                mutations.push(journal::Mutation::field("element-category", category_id, incarnation, "color", json!(colour)));
            }
            if let Some(name) = name.filter(|value| *value != category.name) {
                category.name = name.into();
                mutations.push(journal::Mutation::field("element-category", category_id, incarnation, "name", json!(name)));
            }
            if mutations.is_empty() {
                return Ok(category);
            }
            category.updated_at = context.now_iso.clone();
            self.execute(tx, "UPDATE element_category SET name=?,color=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&category.name), text(&category.color), text(&context.now_iso),
                    text(category_id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(category)
        })
    }

    /// Template facts are cloned with fresh IDs from `new_fact_id` before the
    /// element's own create, as in the renderer's creation original.
    pub fn create_element(
        &self,
        context: &AuthoredProseContext,
        input: NewElement,
        new_fact_id: &mut dyn FnMut() -> Result<String, String>,
    ) -> Result<WorkspaceElement, String> {
        validate_context(context)?;
        let doc_id = format!("element:{}", input.id);
        if !opaque(&input.id) || !opaque(&doc_id) || !opaque(&input.category_id) {
            return Err("Invalid element or category identity".into());
        }
        validate_seed(&input.seed)?;
        let group_name = input
            .group_name
            .as_deref()
            .map(js_trim)
            .filter(|v| !v.is_empty());
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.live_category(tx, context, &input.category_id)?;
            // A category body template is filled into the new body by its
            // owner after creation (see `category_element_template`).
            let others = self.element_rows(Some(tx), &context.project_id, false)?;
            let aliases = desired_aliases(&input.aliases);
            let alias_names: Vec<&str> = aliases.values().map(String::as_str).collect();
            if !alias_names.is_empty() {
                name_conflict(&alias_names, &others, None)?;
            }
            let name = match input.name.as_deref().map(js_trim).filter(|v| !v.is_empty()) {
                Some(name) => {
                    name_conflict(&[name], &others, None)?;
                    name.to_owned()
                }
                None => {
                    let mut name = DEFAULT_ELEMENT.to_owned();
                    let mut n = 2;
                    while name_conflict(&[&name], &others, None).is_err() {
                        name = format!("{DEFAULT_ELEMENT} {n}");
                        n += 1;
                    }
                    name
                }
            };
            let appended = self.seed_document(tx, context, &doc_id, &input.seed)?;
            let template = self.facts(tx, context, FactOwner {
                kind: "element-category", id: &input.category_id, namespace: "element-template",
            })?;
            let mut mutations = Vec::new();
            let facts = input.facts.clone().unwrap_or_else(|| template.clone());
            let facts_projection = self.replace_facts(tx, context,
                FactOwner { kind: "element", id: &input.id, namespace: "facts" },
                &facts, new_fact_id, &mut mutations)?;
            self.execute(tx, r#"
                INSERT INTO element(id,project_id,category_id,name,summary,content_json,kv_json,aliases_json,
                    group_name,portrait_asset_id,deleted_at,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)
            "#, vec![text(&input.id), text(&context.project_id), text(&input.category_id), text(&name),
                text(&input.summary), text(&input.seed.content_json), text(&facts_projection),
                text(&json!(aliases.values().collect::<Vec<_>>()).to_string()), group_name.map(text).unwrap_or(V::Null),
                text(&context.now_iso), text(&context.now_iso)])?;
            mutations.push(journal::Mutation::create("element", &input.id, json!({
                "categoryId": input.category_id, "groupName": group_name, "name": name, "summary": input.summary,
            })));
            if !aliases.is_empty() {
                self.alias_mutations(tx, context, &input.id, 0, &aliases, &mut mutations)?;
            }
            let seed = mutations.len();
            mutations.push(journal::Mutation::yjs(&doc_id, &input.seed.update));
            self.commit_changes(tx, context, &mutations, Some((seed, &appended, &input.seed.update)))?;
            Ok(WorkspaceElement {
                id: input.id.clone(), project_id: context.project_id.clone(),
                category_id: Some(input.category_id.clone()), name, summary: input.summary.clone(),
                aliases: aliases.values().cloned().collect(),
                group_name: group_name.map(Into::into), facts: super::facts::cleaned(&facts), document_id: doc_id.clone(),
                created_at: context.now_iso.clone(), updated_at: context.now_iso.clone(),
            })
        })
    }

    /// Scalar fields and the alias set in one original: alias `set.remove` /
    /// `set.add`, then one `field.set` per changed scalar in UTF-8 order.
    pub fn update_element(
        &self,
        context: &AuthoredProseContext,
        element_id: &str,
        changes: ElementChanges,
    ) -> Result<WorkspaceElement, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let LiveElement { element: before, incarnation, .. } = self.live_element(tx, context, element_id)?;
            let mut after = before.clone();
            if let Some(name) = &changes.name {
                after.name = match js_trim(name) { "" => before.name.clone(), name => name.into() };
            }
            if let Some(summary) = &changes.summary {
                after.summary = summary.clone();
            }
            if let Some(group) = &changes.group_name {
                after.group_name = group.as_deref().map(js_trim).filter(|v| !v.is_empty()).map(Into::into);
            }
            if let Some(category) = &changes.category_id {
                if let Some(category) = category {
                    self.live_category(tx, context, category)?;
                }
                after.category_id = category.clone();
            }
            let desired = changes.aliases.as_ref().map(|aliases| desired_aliases(aliases));
            if let Some(desired) = &desired {
                after.aliases = desired.values().cloned().collect();
            }
            if changes.name.is_some() || changes.aliases.is_some() {
                // As the renderer: the next name plus the submitted (or kept) aliases.
                let aliases: Vec<&str> = match &changes.aliases {
                    Some(aliases) => aliases.iter().map(|a| js_trim(a)).filter(|a| !a.is_empty()).collect(),
                    None => before.aliases.iter().map(String::as_str).collect(),
                };
                let candidates: Vec<&str> = std::iter::once(after.name.as_str()).chain(aliases).collect();
                let others = self.element_rows(Some(tx), &context.project_id, false)?;
                name_conflict(&candidates, &others, Some(element_id))?;
            }
            let mut mutations = Vec::new();
            if let Some(desired) = &desired {
                self.alias_mutations(tx, context, element_id, incarnation, desired, &mut mutations)?;
            }
            let fields: [(&str, Value, Value); 4] = [
                ("categoryId", json!(before.category_id), json!(after.category_id)),
                ("groupName", json!(before.group_name), json!(after.group_name)),
                ("name", json!(before.name), json!(after.name)),
                ("summary", json!(before.summary), json!(after.summary)),
            ];
            for (field, old, new) in fields {
                if old != new {
                    mutations.push(journal::Mutation::field("element", element_id, incarnation, field, new));
                }
            }
            if mutations.is_empty() {
                return Ok(before);
            }
            after.updated_at = context.now_iso.clone();
            self.execute(tx, r#"
                UPDATE element SET category_id=?,name=?,summary=?,group_name=?,aliases_json=?,updated_at=?
                WHERE id=? AND project_id=?
            "#, vec![after.category_id.as_deref().map(text).unwrap_or(V::Null), text(&after.name),
                text(&after.summary), after.group_name.as_deref().map(text).unwrap_or(V::Null),
                text(&json!(after.aliases).to_string()), text(&context.now_iso), text(element_id),
                text(&context.project_id)])?;
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(after)
        })
    }

    pub fn trash_element(
        &self,
        context: &AuthoredProseContext,
        element_id: &str,
    ) -> Result<WorkspaceElement, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let LiveElement {
                mut element,
                incarnation,
                ..
            } = self.live_element(tx, context, element_id)?;
            let mut mutations = self.purge_relations(tx, context, "element", element_id)?;
            self.execute(
                tx,
                "UPDATE element SET deleted_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&context.now_iso),
                    text(&context.now_iso),
                    text(element_id),
                    text(&context.project_id),
                ],
            )?;
            mutations.push(
                journal::Mutation::json("entity", "element", element_id, "entity.trash", json!({}))
                    .at_incarnation(incarnation),
            );
            self.commit_changes(tx, context, &mutations, None)?;
            element.updated_at = context.now_iso.clone();
            Ok(element)
        })
    }

    /// Reauthors the element in the next incarnation: restore seed, every
    /// alias, then the complete body state, like the renderer's restore.
    pub fn restore_element<F>(
        &self,
        context: &AuthoredProseContext,
        element_id: &str,
        mut capture_full_state: F,
    ) -> Result<WorkspaceElement, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &str) -> Result<ChapterSeed, String>,
    {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let LiveElement {
                mut element,
                incarnation,
                portrait,
            } = self.trashed_element(tx, context, element_id)?;
            // A trashed element keeps its portrait binding and bytes.
            let _ = portrait;
            let incarnation = incarnation
                .checked_add(1)
                .filter(|n| *n <= MAX_SAFE)
                .ok_or("Element incarnation overflow")?;
            let repo = ProseRepository::new(self.gateway, self.client);
            let revision = repo.get_revision(&element.document_id, Some(tx))?;
            let state = capture_full_state(&repo, tx, &element.document_id)?;
            if state.update.is_empty() {
                return Err("Restore requires a complete prose state".into());
            }
            self.execute(
                tx,
                "UPDATE element SET deleted_at=NULL,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&context.now_iso),
                    text(element_id),
                    text(&context.project_id),
                ],
            )?;
            let appended = repo.append_update(
                &element.document_id,
                &state.update,
                &RevisionSource::System,
                &context.now_iso,
                Some(revision),
                Some(tx),
            )?;
            let mut mutations = vec![journal::Mutation::json(
                "entity",
                "element",
                element_id,
                "entity.restore",
                json!({"seed": {
                    "categoryId": element.category_id, "groupName": element.group_name,
                    "name": element.name, "summary": element.summary,
                }}),
            )
            .at_incarnation(incarnation)];
            for (member, display) in desired_aliases(&element.aliases) {
                mutations.push(
                    journal::Mutation::json(
                        "set",
                        "alias",
                        element_id,
                        "set.add",
                        json!({"memberId": member, "value": display}),
                    )
                    .at_incarnation(incarnation),
                );
            }
            let seed = mutations.len();
            mutations.push(
                journal::Mutation::yjs(&element.document_id, &state.update)
                    .at_incarnation(incarnation),
            );
            self.commit_changes(
                tx,
                context,
                &mutations,
                Some((seed, &appended, &state.update)),
            )?;
            element.updated_at = context.now_iso.clone();
            Ok(element)
        })
    }

    pub fn set_element_facts(
        &self,
        context: &AuthoredProseContext,
        element_id: &str,
        facts: &[Fact],
        new_fact_id: &mut dyn FnMut() -> Result<String, String>,
    ) -> Result<WorkspaceElement, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let LiveElement { mut element, .. } = self.live_element(tx, context, element_id)?;
            let mut mutations = Vec::new();
            let projection = self.replace_facts(
                tx,
                context,
                FactOwner {
                    kind: "element",
                    id: element_id,
                    namespace: "facts",
                },
                facts,
                new_fact_id,
                &mut mutations,
            )?;
            if mutations.is_empty() {
                return Ok(element);
            }
            self.execute(
                tx,
                "UPDATE element SET kv_json=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&projection),
                    text(&context.now_iso),
                    text(element_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(tx, context, &mutations, None)?;
            element.facts = serde_json::from_str(&projection).map_err(|e| e.to_string())?;
            element.updated_at = context.now_iso.clone();
            Ok(element)
        })
    }

    /// The template that later elements of this category clone; existing
    /// elements never change, as in the renderer.
    pub fn set_category_template_facts(
        &self,
        context: &AuthoredProseContext,
        category_id: &str,
        facts: &[Fact],
        new_fact_id: &mut dyn FnMut() -> Result<String, String>,
    ) -> Result<WorkspaceElementCategory, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut category, _) = self.live_category(tx, context, category_id)?;
            let mut mutations = Vec::new();
            let projection = self.replace_facts(tx, context,
                FactOwner { kind: "element-category", id: category_id, namespace: "element-template" },
                facts, new_fact_id, &mut mutations)?;
            if mutations.is_empty() {
                return Ok(category);
            }
            self.execute(tx,
                "UPDATE element_category SET element_template_kv_json=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&projection), text(&context.now_iso), text(category_id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &mutations, None)?;
            category.template_facts = serde_json::from_str(&projection).map_err(|e| e.to_string())?;
            category.updated_at = context.now_iso.clone();
            Ok(category)
        })
    }

    /// Like the renderer, every element of the category (live or trashed)
    /// loses its category locally without an original; restoring the category
    /// does not re-attach them.
    pub fn trash_element_category(
        &self,
        context: &AuthoredProseContext,
        category_id: &str,
    ) -> Result<WorkspaceElementCategory, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut category, incarnation) = self.live_category(tx, context, category_id)?;
            let mut mutations = self.purge_relations(tx, context, "category", category_id)?;
            self.execute(tx, "UPDATE element SET category_id=NULL,updated_at=? WHERE category_id=? AND project_id=?",
                vec![text(&context.now_iso), text(category_id), text(&context.project_id)])?;
            self.execute(tx, "UPDATE element_category SET deleted_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&context.now_iso), text(&context.now_iso), text(category_id), text(&context.project_id)])?;
            mutations.push(journal::Mutation::json(
                "entity", "element-category", category_id, "entity.trash", json!({}))
                .at_incarnation(incarnation));
            self.commit_changes(tx, context, &mutations, None)?;
            category.updated_at = context.now_iso.clone();
            Ok(category)
        })
    }

    /// Reauthors the category in the next incarnation: its six-field seed and
    /// complete body state. Template facts are not re-emitted.
    pub fn restore_element_category<F>(
        &self,
        context: &AuthoredProseContext,
        category_id: &str,
        mut capture_full_state: F,
    ) -> Result<WorkspaceElementCategory, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &str) -> Result<ChapterSeed, String>,
    {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let rows = self.query(Some(tx), &format!(r#"
                SELECT {CATEGORY_COLUMNS},l.incarnation,c.element_template_json,c.layout_mode,c.grid_x,c.grid_y
                FROM element_category c JOIN sync_entity_lifecycle l ON l.sync_generation_id=?
                    AND l.entity_kind='element-category' AND l.entity_id=c.id AND l.state='trashed'
                WHERE c.id=? AND c.project_id=? AND c.deleted_at IS NOT NULL
            "#), vec![text(&context.sync_generation_id), text(category_id), text(&context.project_id)])?;
            let row = rows.first().ok_or("Category lifecycle must be trashed")?;
            let mut category = category_from_row(row)?;
            let incarnation = safe_integer(&row[7], "category incarnation")?
                .checked_add(1)
                .filter(|n| *n <= MAX_SAFE)
                .ok_or("Category incarnation overflow")?;
            let grid = |index: usize| match &row[index] {
                V::Null => Ok(Value::Null),
                V::Integer(value) => value
                    .parse::<i64>()
                    .map(|n| json!(n))
                    .map_err(|_| "Invalid category grid".to_string()),
                _ => Err("Invalid category grid".to_string()),
            };
            let seed = json!({"color": category.color, "elementTemplateJson": string(row, 8)?,
                "gridX": grid(10)?, "gridY": grid(11)?, "layoutMode": string(row, 9)?, "name": category.name});
            let repo = ProseRepository::new(self.gateway, self.client);
            let revision = repo.get_revision(&category.document_id, Some(tx))?;
            let state = capture_full_state(&repo, tx, &category.document_id)?;
            if state.update.is_empty() {
                return Err("Restore requires a complete prose state".into());
            }
            self.execute(tx, "UPDATE element_category SET deleted_at=NULL,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&context.now_iso), text(category_id), text(&context.project_id)])?;
            let appended = repo.append_update(&category.document_id, &state.update, &RevisionSource::System,
                &context.now_iso, Some(revision), Some(tx))?;
            self.commit_changes(tx, context, &[
                journal::Mutation::json("entity", "element-category", category_id, "entity.restore",
                    json!({"seed": seed})).at_incarnation(incarnation),
                journal::Mutation::yjs(&category.document_id, &state.update).at_incarnation(incarnation),
            ], Some((1, &appended, &state.update)))?;
            category.updated_at = context.now_iso.clone();
            Ok(category)
        })
    }

    fn seed_document(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        doc_id: &str,
        seed: &ChapterSeed,
    ) -> Result<crate::prose::AppendedUpdate, String> {
        let repository = ProseRepository::new(self.gateway, self.client);
        if repository.get_snapshot(doc_id, Some(tx))?.is_some()
            || !repository.list_updates(doc_id, None, Some(tx))?.is_empty()
            || repository.get_revision(doc_id, Some(tx))? != 0
        {
            return Err("New document already has durable prose".into());
        }
        repository.append_update(
            doc_id,
            &seed.update,
            &RevisionSource::System,
            &context.now_iso,
            Some(0),
            Some(tx),
        )
    }

    /// Current alias members come from the set authority at this incarnation;
    /// the latest add wins its display, as in the renderer.
    fn alias_mutations(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        element_id: &str,
        incarnation: u64,
        desired: &BTreeMap<String, String>,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        let rows = self.query(Some(tx), r#"
            SELECT t.value_key,t.value_cbor,t.add_tag FROM sync_set_tag t
            JOIN sync_change_set c ON c.change_set_id=t.add_change_set_id
            WHERE t.sync_generation_id=? AND t.owner_kind='alias' AND t.owner_id=? AND t.incarnation=?
                AND t.set_key='aliases' AND t.removed_by_change_set_id IS NULL
            ORDER BY t.value_key,c.hlc_wall_ms,c.hlc_counter,c.writer_id,c.writer_epoch,c.device_seq,
                t.add_mutation_index,t.add_tag
        "#, vec![text(&context.sync_generation_id), text(element_id), integer(incarnation)])?;
        let mut current: BTreeMap<String, (Vec<u8>, Vec<String>)> = BTreeMap::new();
        for row in rows {
            let V::Blob(value) = &row[1] else {
                return Err("Invalid alias tag value".into());
            };
            let entry = current.entry(string(&row, 0)?).or_default();
            entry.0 = value.clone();
            entry.1.push(string(&row, 2)?);
        }
        for (member, (value, tags)) in &current {
            if desired
                .get(member)
                .is_some_and(|display| Cbor::Text(display).bytes() == *value)
            {
                continue;
            }
            mutations.push(
                journal::Mutation::json(
                    "set",
                    "alias",
                    element_id,
                    "set.remove",
                    json!({"memberId": member, "observedAddTags": tags}),
                )
                .at_incarnation(incarnation),
            );
        }
        for (member, display) in desired {
            if current
                .get(member)
                .is_some_and(|(value, _)| Cbor::Text(display).bytes() == *value)
            {
                continue;
            }
            mutations.push(
                journal::Mutation::json(
                    "set",
                    "alias",
                    element_id,
                    "set.add",
                    json!({"memberId": member, "value": display}),
                )
                .at_incarnation(incarnation),
            );
        }
        Ok(())
    }

    /// The element overview's placement of every live category: `pinned`
    /// at a grid cell, or `auto` for the layout solver.
    pub fn category_layouts(&self, project_id: &str) -> Result<Vec<CategoryLayout>, String> {
        self.query(
            None,
            r#"
            SELECT id,layout_mode,grid_x,grid_y FROM element_category
            WHERE project_id=? AND deleted_at IS NULL ORDER BY created_at,id
        "#,
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| {
            let grid = |index: usize| match &row[index] {
                V::Integer(value) => value.parse::<i64>().ok(),
                V::Real(value) => Some(*value as i64),
                _ => None,
            };
            Ok(CategoryLayout {
                category_id: string(row, 0)?,
                layout_mode: string(row, 1)?,
                grid_x: grid(2),
                grid_y: grid(3),
            })
        })
        .collect()
    }

    /// Pins a category to a grid cell (`Some`) or returns it to the solver
    /// (`None`); unchanged placements write nothing.
    pub fn set_category_layout(
        &self,
        context: &AuthoredProseContext,
        category_id: &str,
        cell: Option<(i64, i64)>,
    ) -> Result<CategoryLayout, String> {
        validate_context(context)?;
        if cell.is_some_and(|(x, y)| x.abs() > 100_000 || y.abs() > 100_000) {
            return Err("Grid cell out of range".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (_, incarnation) = self.live_category(tx, context, category_id)?;
            let current = self.query(Some(tx), "SELECT layout_mode,grid_x,grid_y FROM element_category WHERE id=?",
                vec![text(category_id)])?;
            let (mode, x, y) = match cell {
                Some((x, y)) => ("pinned", json!(x), json!(y)),
                None => ("auto", Value::Null, Value::Null),
            };
            let same = |index: usize, value: &Value| match (&current[0][index], value) {
                (V::Null, Value::Null) => true,
                (V::Integer(a), Value::Number(b)) => a.parse::<i64>().ok() == b.as_i64(),
                _ => false,
            };
            let mut mutations = Vec::new();
            if string(&current[0], 0)? != mode {
                mutations.push(journal::Mutation::field("element-category", category_id, incarnation, "layoutMode", json!(mode)));
            }
            if !same(1, &x) {
                mutations.push(journal::Mutation::field("element-category", category_id, incarnation, "gridX", x.clone()));
            }
            if !same(2, &y) {
                mutations.push(journal::Mutation::field("element-category", category_id, incarnation, "gridY", y.clone()));
            }
            if !mutations.is_empty() {
                self.execute(tx, "UPDATE element_category SET layout_mode=?,grid_x=?,grid_y=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![text(mode), x.as_i64().map(|v| V::Integer(v.to_string())).unwrap_or(V::Null),
                        y.as_i64().map(|v| V::Integer(v.to_string())).unwrap_or(V::Null), text(&context.now_iso),
                        text(category_id), text(&context.project_id)])?;
                self.commit_changes(tx, context, &mutations, None)?;
            }
            Ok(CategoryLayout {
                category_id: category_id.into(),
                layout_mode: mode.into(),
                grid_x: x.as_i64(),
                grid_y: y.as_i64(),
            })
        })
    }

    /// A category's element body template: ProseMirror JSON, `{}` when unset.
    pub fn category_element_template(
        &self,
        project_id: &str,
        category_id: &str,
    ) -> Result<String, String> {
        let rows = self.query(None, "SELECT element_template_json FROM element_category WHERE id=? AND project_id=? AND deleted_at IS NULL",
            vec![text(category_id), text(project_id)])?;
        let row = rows.first().ok_or("分类不存在或已在回收站")?;
        string(row, 0)
    }

    /// Replaces the template new elements of the category start from; `{}`
    /// clears it. Unchanged templates write nothing.
    pub fn set_category_element_template(
        &self,
        context: &AuthoredProseContext,
        category_id: &str,
        template_json: &str,
    ) -> Result<WorkspaceElementCategory, String> {
        validate_context(context)?;
        if template_json != "{}" {
            let document: Value = serde_json::from_str(template_json)
                .map_err(|e| format!("Invalid template: {e}"))?;
            if document.get("type").and_then(Value::as_str) != Some("doc")
                || !document.get("content").is_some_and(Value::is_array)
            {
                return Err("Invalid template document".into());
            }
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut category, incarnation) = self.live_category(tx, context, category_id)?;
            let current = self.query(Some(tx), "SELECT element_template_json FROM element_category WHERE id=?",
                vec![text(category_id)])?;
            if string(&current[0], 0)? == template_json {
                return Ok(category);
            }
            self.execute(tx, "UPDATE element_category SET element_template_json=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(template_json), text(&context.now_iso), text(category_id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &[journal::Mutation::field("element-category", category_id, incarnation,
                "elementTemplateJson", json!(template_json))], None)?;
            category.updated_at = context.now_iso.clone();
            Ok(category)
        })
    }

    fn live_category(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        category_id: &str,
    ) -> Result<(WorkspaceElementCategory, u64), String> {
        let rows = self.query(Some(tx), r#"
            SELECT c.id,c.project_id,c.name,c.color,c.created_at,c.updated_at,c.element_template_kv_json,
                COALESCE(l.incarnation,0)
            FROM element_category c LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=?
                AND l.entity_kind='element-category' AND l.entity_id=c.id
            WHERE c.id=? AND c.project_id=? AND c.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')
        "#, vec![text(&context.sync_generation_id), text(category_id), text(&context.project_id)])?;
        let row = rows
            .first()
            .ok_or("Category is not available in this project")?;
        Ok((
            category_from_row(row)?,
            safe_integer(&row[7], "category incarnation")?,
        ))
    }

    fn live_element(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        element_id: &str,
    ) -> Result<LiveElement, String> {
        self.element_lifecycle(tx, context, element_id, false)
    }

    fn trashed_element(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        element_id: &str,
    ) -> Result<LiveElement, String> {
        self.element_lifecycle(tx, context, element_id, true)
    }

    fn element_lifecycle(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        element_id: &str,
        trashed: bool,
    ) -> Result<LiveElement, String> {
        let rows = self.query(Some(tx), &format!(r#"
            SELECT {ELEMENT_COLUMNS},l.incarnation,l.state,e.deleted_at,e.portrait_asset_id FROM element e
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=?
                AND l.entity_kind='element' AND l.entity_id=e.id
            WHERE e.id=? AND e.project_id=?
        "#), vec![text(&context.sync_generation_id), text(element_id), text(&context.project_id)])?;
        let row = rows
            .first()
            .ok_or("Element is not available in this project")?;
        let state = match &row[11] {
            V::Null => "live".to_string(),
            _ => string(row, 11)?,
        };
        let deleted = row[12] != V::Null;
        let expected = if trashed { "trashed" } else { "live" };
        // Only the renderer's own lifecycle proves a restorable trash state.
        if deleted != trashed || state != expected || (trashed && row[10] == V::Null) {
            return Err(format!("Element lifecycle must be {expected}"));
        }
        let incarnation = if row[10] == V::Null {
            0
        } else {
            safe_integer(&row[10], "element incarnation")?
        };
        Ok(LiveElement {
            element: element_from_row(row)?,
            incarnation,
            portrait: row[13] != V::Null,
        })
    }

    fn element_rows(
        &self,
        tx: Option<u64>,
        project_id: &str,
        trashed: bool,
    ) -> Result<Vec<WorkspaceElement>, String> {
        let (filter, order) = if trashed {
            (
                "e.deleted_at IS NOT NULL AND l.state='trashed'",
                "e.deleted_at DESC,e.rowid",
            )
        } else {
            (
                "e.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')",
                "e.updated_at DESC,e.rowid",
            )
        };
        self.query(
            tx,
            &format!(
                r#"
            SELECT {ELEMENT_COLUMNS} FROM element e
            JOIN sync_generation g ON g.project_id=e.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='element' AND l.entity_id=e.id
            WHERE e.project_id=? AND {filter} ORDER BY {order}
        "#
            ),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| element_from_row(row))
        .collect()
    }
}

const ELEMENT_COLUMNS: &str =
    "e.id,e.project_id,e.category_id,e.name,e.summary,e.aliases_json,e.group_name,e.created_at,e.updated_at,e.kv_json";
const CATEGORY_COLUMNS: &str =
    "c.id,c.project_id,c.name,c.color,c.created_at,c.updated_at,c.element_template_kv_json";

/// Renderer `desiredAliases`: display is trimmed NFKC, the member is its
/// lowercase; the last value of a member wins; members sort by UTF-8 bytes.
fn desired_aliases(values: &[String]) -> BTreeMap<String, String> {
    let mut aliases = BTreeMap::new();
    for value in values {
        let display: String = js_trim(value).nfkc().collect();
        let member = js_trim(&display.nfkc().collect::<String>()).to_lowercase();
        if !member.is_empty() {
            aliases.insert(member, display);
        }
    }
    aliases
}

/// Renderer `findElementNameConflict`: trimmed, lowercased candidates against
/// every other live element's name and aliases.
fn name_conflict(
    candidates: &[&str],
    elements: &[WorkspaceElement],
    exclude: Option<&str>,
) -> Result<(), String> {
    let candidates: Vec<String> = candidates
        .iter()
        .map(|name| js_trim(name).to_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    for element in elements
        .iter()
        .filter(|element| Some(element.id.as_str()) != exclude)
    {
        for name in std::iter::once(&element.name).chain(&element.aliases) {
            if candidates.contains(&name.to_lowercase()) {
                return Err(format!(
                    "Name \"{name}\" is already used by element \"{}\"",
                    element.name
                ));
            }
        }
    }
    Ok(())
}

fn validate_seed(seed: &ChapterSeed) -> Result<(), String> {
    let cache: Value =
        serde_json::from_str(&seed.content_json).map_err(|e| format!("Invalid seed JSON: {e}"))?;
    let blocks = cache.get("content").and_then(Value::as_array);
    if cache.get("type").and_then(Value::as_str) != Some("doc")
        || blocks.is_none_or(|blocks| {
            blocks.len() != 1
                || blocks[0].get("type").and_then(Value::as_str) != Some("paragraph")
                || blocks[0]
                    .get("content")
                    .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
        })
        || seed.update.is_empty()
    {
        return Err("A new body must be one empty paragraph and a nonempty Yjs event".into());
    }
    Ok(())
}

pub(super) fn color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|c| c.is_ascii_hexdigit())
}

fn safe_integer(value: &V, label: &str) -> Result<u64, String> {
    match value {
        V::Integer(value) => value.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE),
        _ => None,
    }
    .ok_or_else(|| format!("Invalid {label}"))
}

fn category_from_row(row: &[V]) -> Result<WorkspaceElementCategory, String> {
    let id = string(row, 0)?;
    Ok(WorkspaceElementCategory {
        document_id: format!("category:{id}"),
        id,
        project_id: string(row, 1)?,
        name: string(row, 2)?,
        color: string(row, 3)?,
        template_facts: serde_json::from_str(&string(row, 6)?)
            .map_err(|_| "Invalid category template facts")?,
        created_at: string(row, 4)?,
        updated_at: string(row, 5)?,
    })
}

fn element_from_row(row: &[V]) -> Result<WorkspaceElement, String> {
    let optional = |index: usize| match &row[index] {
        V::Null => Ok(None),
        V::Text(value) => Ok(Some(value.clone())),
        _ => Err("Invalid element optional text".to_string()),
    };
    let id = string(row, 0)?;
    Ok(WorkspaceElement {
        document_id: format!("element:{id}"),
        id,
        project_id: string(row, 1)?,
        category_id: optional(2)?,
        name: string(row, 3)?,
        summary: string(row, 4)?,
        aliases: serde_json::from_str(&string(row, 5)?).map_err(|_| "Invalid element aliases")?,
        group_name: optional(6)?,
        facts: serde_json::from_str(&string(row, 9)?).map_err(|_| "Invalid element facts")?,
        created_at: string(row, 7)?,
        updated_at: string(row, 8)?,
    })
}
