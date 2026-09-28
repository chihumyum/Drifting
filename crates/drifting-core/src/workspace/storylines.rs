//! Storylines and chapter membership with the renderer's rows and originals.
//! Membership is an OR-set on each storyline (`membership`, member = chapter)
//! plus the chapter's primary-storyline register; `node_storyline_link` is the
//! local projection. Storyline order uses fractional registers whose local
//! numeric projection (`order_key`) is the rank within the project.
use super::facts::{push_order, Fact, FactOwner};
use super::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[cfg(test)]
mod tests;

const DEFAULT_STORYLINE: &str = "New Storyline";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStoryline {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub summary: String,
    pub order_key: i64,
    pub facts: Vec<Fact>,
    pub document_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One chapter's storylines; `primary` is one of them or none.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterMembership {
    pub chapter_id: String,
    pub storyline_ids: Vec<String>,
    pub primary: Option<String>,
}

pub struct NewStoryline {
    pub id: String,
    pub name: String,
    /// `#RRGGBB`, chosen by the host like the renderer's random colour.
    pub color: String,
    pub seed: ChapterSeed,
}

#[derive(Default)]
pub struct StorylineChanges {
    pub name: Option<String>,
    pub color: Option<String>,
    pub summary: Option<String>,
}

const COLUMNS: &str =
    "s.id,s.project_id,s.name,s.color,s.summary,s.order_key,s.kv_json,s.created_at,s.updated_at";

impl WorkspaceStore<'_> {
    /// The durable scope of any live body document in the active generation.
    pub fn document_scope(
        &self,
        project_id: &str,
        document_id: &str,
    ) -> Result<ArchiveScope, String> {
        self.transaction(TransactionBehavior::Deferred, |tx| {
            let rows = self.query(Some(tx), "SELECT project_sync_id,sync_generation_id FROM sync_generation WHERE project_id=? AND status='active'", vec![text(project_id)])?;
            let row = rows.first().ok_or("Project has no active sync generation")?;
            let (project_sync_id, sync_generation_id) = (string(row, 0)?, string(row, 1)?);
            let incarnation = AuthoredProseJournal::new(self.gateway, self.client)
                .current_incarnation(tx, project_id, &project_sync_id, &sync_generation_id, document_id)?;
            Ok(ArchiveScope { project_id: project_id.into(), project_sync_id, sync_generation_id,
                document_id: document_id.into(), incarnation })
        })
    }

    pub fn storylines(&self, project_id: &str) -> Result<Vec<WorkspaceStoryline>, String> {
        self.storyline_rows(None, project_id, false)
    }

    pub fn trashed_storylines(&self, project_id: &str) -> Result<Vec<WorkspaceStoryline>, String> {
        self.storyline_rows(None, project_id, true)
    }

    /// Every live chapter's storylines (live storylines only), in book order.
    pub fn chapter_memberships(&self, project_id: &str) -> Result<Vec<ChapterMembership>, String> {
        let live: BTreeSet<String> = self
            .storylines(project_id)?
            .into_iter()
            .map(|s| s.id)
            .collect();
        let mut memberships = Vec::new();
        for chapter in self.list_chapters(project_id)? {
            let (ids, primary) = self.links(None, project_id, &chapter.id)?;
            let storyline_ids: Vec<String> =
                ids.into_iter().filter(|id| live.contains(id)).collect();
            memberships.push(ChapterMembership {
                primary: primary.filter(|id| storyline_ids.contains(id)),
                chapter_id: chapter.id,
                storyline_ids,
            });
        }
        Ok(memberships)
    }

    pub fn create_storyline(
        &self,
        context: &AuthoredProseContext,
        input: NewStoryline,
        new_fact_id: &mut dyn FnMut() -> Result<String, String>,
    ) -> Result<WorkspaceStoryline, String> {
        validate_context(context)?;
        let doc_id = format!("storyline:{}", input.id);
        if !opaque(&input.id) || !opaque(&doc_id) || !colour(&input.color) {
            return Err("Invalid storyline identity or colour".into());
        }
        validate_body_seed(&input.seed)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let existing = self.storyline_rows(Some(tx), &context.project_id, false)?;
            let name = unique_name(&input.name, &existing, None);
            let order_key = existing.iter().map(|s| s.order_key).max().map_or(0, |max| max + 1);
            let repository = ProseRepository::new(self.gateway, self.client);
            if repository.get_revision(&doc_id, Some(tx))? != 0 || repository.get_snapshot(&doc_id, Some(tx))?.is_some() {
                return Err("New storyline already has durable prose".into());
            }
            let appended = repository.append_update(&doc_id, &input.seed.update, &RevisionSource::System,
                &context.now_iso, Some(0), Some(tx))?;
            let template = self.facts(tx, context, FactOwner { kind: "project", id: &context.project_id, namespace: "storyline-template" })?;
            let mut mutations = Vec::new();
            let facts = self.replace_facts(tx, context, FactOwner { kind: "storyline", id: &input.id, namespace: "facts" },
                &template, new_fact_id, &mut mutations)?;
            self.execute(tx, r#"
                INSERT INTO storylines(id,project_id,name,color,summary,order_key,content_json,kv_json,
                    node_content_template_json,deleted_at,created_at,updated_at)
                VALUES (?,?,?,?,'',?,?,?,'{}',NULL,?,?)
            "#, vec![text(&input.id), text(&context.project_id), text(&name), text(&input.color),
                integer(order_key as u64), text(&input.seed.content_json), text(&facts),
                text(&context.now_iso), text(&context.now_iso)])?;
            mutations.push(journal::Mutation::create("storyline", &input.id, json!({
                "color": input.color, "name": name, "nodeContentTemplateJson": "{}", "summary": "",
            })));
            let seed = mutations.len();
            mutations.push(journal::Mutation::yjs(&doc_id, &input.seed.update));
            self.push_storyline_order(tx, context, &mut mutations)?;
            // The first live storyline becomes every live chapter's primary.
            if existing.is_empty() {
                let mut chapters: Vec<String> = self.chapters(Some(tx), &context.project_id)?.into_iter().map(|c| c.id).collect();
                chapters.sort();
                for chapter in &chapters {
                    self.execute(tx, "INSERT INTO node_storyline_link(node_id,storyline_id,is_primary) VALUES (?,?,1)",
                        vec![text(chapter), text(&input.id)])?;
                    self.membership_projection(tx, context, chapter, false, None, &mut mutations)?;
                }
            }
            self.commit_changes(tx, context, &mutations, Some((seed, &appended, &input.seed.update)))?;
            self.project_storyline_ranks(tx, &context.project_id)?;
            self.storyline(tx, &context.project_id, &input.id)
        })
    }

    /// Rename (kept project-unique, case-insensitively), recolour or edit the
    /// summary; unchanged values write nothing.
    pub fn update_storyline(
        &self,
        context: &AuthoredProseContext,
        storyline_id: &str,
        changes: StorylineChanges,
    ) -> Result<WorkspaceStoryline, String> {
        validate_context(context)?;
        if changes.color.as_deref().is_some_and(|c| !colour(c)) {
            return Err("Invalid storyline colour".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let incarnation = self.live_storyline(tx, context, storyline_id)?;
            let before = self.storyline(tx, &context.project_id, storyline_id)?;
            let mut after = before.clone();
            if let Some(name) = &changes.name {
                let others = self.storyline_rows(Some(tx), &context.project_id, false)?;
                after.name = unique_name(name, &others, Some(storyline_id));
            }
            if let Some(color) = &changes.color {
                after.color = color.clone();
            }
            if let Some(summary) = &changes.summary {
                after.summary = summary.clone();
            }
            let mut mutations = Vec::new();
            for (field, old, new) in [
                ("color", &before.color, &after.color),
                ("name", &before.name, &after.name),
                ("summary", &before.summary, &after.summary),
            ] {
                if old != new {
                    mutations.push(journal::Mutation::field("storyline", storyline_id, incarnation, field, json!(new)));
                }
            }
            if mutations.is_empty() {
                return Ok(before);
            }
            self.execute(tx, "UPDATE storylines SET name=?,color=?,summary=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&after.name), text(&after.color), text(&after.summary), text(&context.now_iso),
                    text(storyline_id), text(&context.project_id)])?;
            self.commit_changes(tx, context, &mutations, None)?;
            self.storyline(tx, &context.project_id, storyline_id)
        })
    }

    /// The 章节模版 new chapters whose primary storyline this is start from
    /// (`nodeContentTemplateJson`); `{}` for none.
    pub fn storyline_chapter_template(
        &self,
        project_id: &str,
        storyline_id: &str,
    ) -> Result<String, String> {
        let rows = self.query(None, "SELECT node_content_template_json FROM storylines WHERE id=? AND project_id=? AND deleted_at IS NULL",
            vec![text(storyline_id), text(project_id)])?;
        let row = rows.first().ok_or("故事线不存在或已在回收站")?;
        string(row, 0)
    }

    /// Replaces the storyline's 章节模版; `{}` clears it. Unchanged templates
    /// write nothing.
    pub fn set_storyline_chapter_template(
        &self,
        context: &AuthoredProseContext,
        storyline_id: &str,
        template_json: &str,
    ) -> Result<WorkspaceStoryline, String> {
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
            let incarnation = self.live_storyline(tx, context, storyline_id)?;
            let current = self.query(Some(tx), "SELECT node_content_template_json FROM storylines WHERE id=?",
                vec![text(storyline_id)])?;
            if string(&current[0], 0)? != template_json {
                self.execute(tx, "UPDATE storylines SET node_content_template_json=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![text(template_json), text(&context.now_iso), text(storyline_id), text(&context.project_id)])?;
                self.commit_changes(tx, context, &[journal::Mutation::field("storyline", storyline_id, incarnation,
                    "nodeContentTemplateJson", json!(template_json))], None)?;
            }
            self.storyline(tx, &context.project_id, storyline_id)
        })
    }

    /// Place a storyline before another (or last), as a drag in the renderer.
    pub fn move_storyline(
        &self,
        context: &AuthoredProseContext,
        storyline_id: &str,
        before_id: Option<&str>,
    ) -> Result<Vec<WorkspaceStoryline>, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.live_storyline(tx, context, storyline_id)?;
            let mut ids: Vec<String> = self
                .storyline_rows(Some(tx), &context.project_id, false)?
                .into_iter()
                .map(|s| s.id)
                .filter(|id| id != storyline_id)
                .collect();
            let at = match before_id {
                Some(before) => ids
                    .iter()
                    .position(|id| id == before)
                    .ok_or("Unknown storyline position")?,
                None => ids.len(),
            };
            ids.insert(at, storyline_id.into());
            let (positions, incarnations) = self.storyline_positions(tx, context)?;
            let mut mutations = Vec::new();
            push_order(
                "storyline",
                &context.project_id,
                &positions,
                &ids,
                &|id| incarnations.get(id).copied().unwrap_or(0),
                &mut mutations,
            )?;
            if !mutations.is_empty() {
                // The renderer reorders through updateStoryline, which stamps the row.
                self.execute(
                    tx,
                    "UPDATE storylines SET updated_at=? WHERE id=? AND project_id=?",
                    vec![
                        text(&context.now_iso),
                        text(storyline_id),
                        text(&context.project_id),
                    ],
                )?;
                self.commit_changes(tx, context, &mutations, None)?;
                self.project_storyline_ranks(tx, &context.project_id)?;
            }
            self.storyline_rows(Some(tx), &context.project_id, false)
        })
    }

    pub fn set_storyline_facts(
        &self,
        context: &AuthoredProseContext,
        storyline_id: &str,
        facts: &[Fact],
        new_fact_id: &mut dyn FnMut() -> Result<String, String>,
    ) -> Result<WorkspaceStoryline, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            self.live_storyline(tx, context, storyline_id)?;
            let mut mutations = Vec::new();
            let projection = self.replace_facts(
                tx,
                context,
                FactOwner {
                    kind: "storyline",
                    id: storyline_id,
                    namespace: "facts",
                },
                facts,
                new_fact_id,
                &mut mutations,
            )?;
            if !mutations.is_empty() {
                self.execute(
                    tx,
                    "UPDATE storylines SET kv_json=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![
                        text(&projection),
                        text(&context.now_iso),
                        text(storyline_id),
                        text(&context.project_id),
                    ],
                )?;
                self.commit_changes(tx, context, &mutations, None)?;
            }
            self.storyline(tx, &context.project_id, storyline_id)
        })
    }

    /// Replace a chapter's storylines with the renderer's `setNodeStorylines`
    /// rule: `primary` absent keeps the current primary, `Some(None)` clears
    /// it; with no primary left, the first listed storyline becomes primary;
    /// a primary missing from the list is prepended to it.
    pub fn set_chapter_storylines(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
        storyline_ids: &[String],
        primary: Option<Option<&str>>,
    ) -> Result<ChapterMembership, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let mut mutations = Vec::new();
            self.apply_chapter_storylines(
                tx,
                context,
                chapter_id,
                storyline_ids,
                primary,
                &mut mutations,
            )?;
            if !mutations.is_empty() {
                self.commit_changes(tx, context, &mutations, None)?;
            }
            self.membership(tx, &context.project_id, chapter_id)
        })
    }

    /// Replaces a chapter's links and appends their projection to
    /// `mutations`; an unchanged membership appends nothing.
    pub(super) fn apply_chapter_storylines(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        chapter_id: &str,
        storyline_ids: &[String],
        primary: Option<Option<&str>>,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        if !self
            .chapters(Some(tx), &context.project_id)?
            .iter()
            .any(|c| c.id == chapter_id)
        {
            return Err("Chapter is not available in this project".into());
        }
        let live = self.storyline_rows(Some(tx), &context.project_id, false)?;
        let (current, current_primary) = self.links(Some(tx), &context.project_id, chapter_id)?;
        let mut primary = match primary {
            Some(primary) => primary.map(str::to_owned),
            None => current_primary.clone(),
        };
        if primary.is_none() {
            primary = storyline_ids.first().cloned();
        }
        let mut ids: Vec<&String> = storyline_ids.iter().collect();
        if let Some(primary) = primary.as_ref().filter(|p| !storyline_ids.contains(p)) {
            ids.insert(0, primary);
        }
        let mut desired: Vec<&WorkspaceStoryline> = Vec::new();
        for id in ids {
            let storyline = live
                .iter()
                .find(|s| &s.id == id)
                .ok_or("Storyline is not available in this project")?;
            if !desired.iter().any(|s| s.id == storyline.id) {
                desired.push(storyline);
            }
        }
        let wanted: BTreeSet<&str> = desired.iter().map(|s| s.id.as_str()).collect();
        if current.iter().map(String::as_str).collect::<BTreeSet<_>>() == wanted
            && current_primary == primary
        {
            return Ok(());
        }
        self.execute(
            tx,
            "DELETE FROM node_storyline_link WHERE node_id=?",
            vec![text(chapter_id)],
        )?;
        for storyline in &desired {
            self.execute(
                tx,
                "INSERT INTO node_storyline_link(node_id,storyline_id,is_primary) VALUES (?,?,?)",
                vec![
                    text(chapter_id),
                    text(&storyline.id),
                    integer(u64::from(Some(&storyline.id) == primary.as_ref())),
                ],
            )?;
        }
        self.membership_projection(tx, context, chapter_id, false, None, mutations)
    }

    /// A chapter's current links (UTF-8 order) and primary, for moves.
    pub(super) fn chapter_links(
        &self,
        tx: u64,
        project_id: &str,
        chapter_id: &str,
    ) -> Result<(Vec<String>, Option<String>), String> {
        self.links(Some(tx), project_id, chapter_id)
    }

    /// Live chapters whose primary was this storyline lose all their links and
    /// every link to it is removed (a trashed chapter's silently, as in the
    /// renderer); live chapters are projected; then it is trashed. Links are
    /// not restored.
    pub fn trash_storyline(
        &self,
        context: &AuthoredProseContext,
        storyline_id: &str,
    ) -> Result<WorkspaceStoryline, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let incarnation = self.live_storyline(tx, context, storyline_id)?;
            let mut mutations = self.purge_relations(tx, context, "storyline", storyline_id)?;
            let primary_of: BTreeSet<String> = self
                .query(
                    Some(tx),
                    // Only live chapters are projected, as the renderer's store holds them.
                    "SELECT l.node_id FROM node_storyline_link l JOIN book_node n ON n.id=l.node_id AND n.deleted_at IS NULL WHERE l.storyline_id=? AND l.is_primary=1",
                    vec![text(storyline_id)],
                )?
                .iter()
                .map(|row| string(row, 0))
                .collect::<Result<_, _>>()?;
            let members: BTreeSet<String> = self
                .query(
                    Some(tx),
                    "SELECT l.node_id FROM node_storyline_link l JOIN book_node n ON n.id=l.node_id AND n.deleted_at IS NULL WHERE l.storyline_id=?",
                    vec![text(storyline_id)],
                )?
                .iter()
                .map(|row| string(row, 0))
                .collect::<Result<_, _>>()?;
            for node in &primary_of {
                self.execute(
                    tx,
                    "DELETE FROM node_storyline_link WHERE node_id=?",
                    vec![text(node)],
                )?;
            }
            self.execute(
                tx,
                "DELETE FROM node_storyline_link WHERE storyline_id=?",
                vec![text(storyline_id)],
            )?;
            for node in &members {
                self.membership_projection(tx, context, node, false, None, &mut mutations)?;
            }
            self.execute(
                tx,
                "UPDATE storylines SET deleted_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&context.now_iso),
                    text(&context.now_iso),
                    text(storyline_id),
                    text(&context.project_id),
                ],
            )?;
            mutations.push(
                journal::Mutation::json(
                    "entity",
                    "storyline",
                    storyline_id,
                    "entity.trash",
                    json!({}),
                )
                .at_incarnation(incarnation),
            );
            self.commit_changes(tx, context, &mutations, None)?;
            self.project_storyline_ranks(tx, &context.project_id)?;
            self.storyline(tx, &context.project_id, storyline_id)
        })
    }

    /// Reauthor the storyline in the next incarnation: seed, its order among
    /// live storylines and the complete body state.
    pub fn restore_storyline<F>(
        &self,
        context: &AuthoredProseContext,
        storyline_id: &str,
        mut capture_full_state: F,
    ) -> Result<WorkspaceStoryline, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &str) -> Result<ChapterSeed, String>,
    {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let rows = self.query(
                Some(tx),
                r#"
                SELECT l.incarnation,s.node_content_template_json FROM storylines s
                JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='storyline'
                    AND l.entity_id=s.id AND l.state='trashed'
                WHERE s.id=? AND s.project_id=? AND s.deleted_at IS NOT NULL
            "#,
                vec![
                    text(&context.sync_generation_id),
                    text(storyline_id),
                    text(&context.project_id),
                ],
            )?;
            let row = rows.first().ok_or("Storyline lifecycle must be trashed")?;
            let incarnation = safe_u64(&row[0])?
                .checked_add(1)
                .filter(|n| *n <= MAX_SAFE)
                .ok_or("Storyline incarnation overflow")?;
            let template = string(row, 1)?;
            let before = self.storyline(tx, &context.project_id, storyline_id)?;
            let repo = ProseRepository::new(self.gateway, self.client);
            let revision = repo.get_revision(&before.document_id, Some(tx))?;
            let state = capture_full_state(&repo, tx, &before.document_id)?;
            if state.update.is_empty() {
                return Err("Restore requires a complete prose state".into());
            }
            self.execute(
                tx,
                "UPDATE storylines SET deleted_at=NULL,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&context.now_iso),
                    text(storyline_id),
                    text(&context.project_id),
                ],
            )?;
            let appended = repo.append_update(
                &before.document_id,
                &state.update,
                &RevisionSource::System,
                &context.now_iso,
                Some(revision),
                Some(tx),
            )?;
            let mut mutations = vec![journal::Mutation::json(
                "entity",
                "storyline",
                storyline_id,
                "entity.restore",
                json!({"seed": {"color": before.color, "name": before.name,
                    "nodeContentTemplateJson": template, "summary": before.summary}}),
            )
            .at_incarnation(incarnation)];
            self.push_storyline_order(tx, context, &mut mutations)?;
            let seed = mutations.len();
            mutations.push(
                journal::Mutation::yjs(&before.document_id, &state.update)
                    .at_incarnation(incarnation),
            );
            self.commit_changes(
                tx,
                context,
                &mutations,
                Some((seed, &appended, &state.update)),
            )?;
            self.project_storyline_ranks(tx, &context.project_id)?;
            self.storyline(tx, &context.project_id, storyline_id)
        })
    }

    /// Renderer `appendAuthoredNodeStorylineProjectionInTransaction`: diff the
    /// chapter's live membership tags against its links, per storyline in
    /// UTF-8 order, then always set its primary register.
    pub(super) fn membership_projection(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        chapter_id: &str,
        force_reincarnation: bool,
        node_incarnation: Option<u64>,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        let (links, primary) = self.links(Some(tx), &context.project_id, chapter_id)?;
        let tags = self.query(
            Some(tx),
            r#"
            SELECT t.owner_id,t.add_tag,t.incarnation,l.incarnation,l.state FROM sync_set_tag t
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=t.sync_generation_id
                AND l.entity_kind='storyline' AND l.entity_id=t.owner_id
            WHERE t.sync_generation_id=? AND t.owner_kind='membership' AND t.set_key='membership'
                AND t.value_key=? AND t.removed_by_change_set_id IS NULL
        "#,
            vec![text(&context.sync_generation_id), text(chapter_id)],
        )?;
        let mut current: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for row in &tags {
            let live_incarnation = match (&row[3], &row[4]) {
                (V::Null, _) => Some(0),
                (value, V::Text(state)) if state == "live" => Some(safe_u64(value)?),
                _ => None,
            };
            if live_incarnation == Some(safe_u64(&row[2])?) {
                current
                    .entry(string(row, 0)?)
                    .or_default()
                    .push(string(row, 1)?);
            }
        }
        let storylines: BTreeSet<String> = current
            .keys()
            .cloned()
            .chain(links.iter().cloned())
            .collect();
        for storyline in storylines {
            let incarnation = self.lifecycle_incarnation(tx, context, "storyline", &storyline)?;
            let mut observed = current.get(&storyline).cloned().unwrap_or_default();
            observed.sort();
            let set = |action: &'static str, payload: Value| {
                journal::Mutation::json("set", "membership", &storyline, action, payload)
                    .at_incarnation(incarnation)
            };
            if links.contains(&storyline) {
                if force_reincarnation && !observed.is_empty() {
                    mutations.push(set(
                        "set.remove",
                        json!({"memberId": chapter_id, "observedAddTags": observed}),
                    ));
                }
                if force_reincarnation || observed.is_empty() {
                    mutations.push(set(
                        "set.add",
                        json!({"memberId": chapter_id, "value": null}),
                    ));
                }
            } else if !observed.is_empty() {
                mutations.push(set(
                    "set.remove",
                    json!({"memberId": chapter_id, "observedAddTags": observed}),
                ));
            }
        }
        let node_incarnation = match node_incarnation {
            Some(incarnation) => incarnation,
            None => self.lifecycle_incarnation(tx, context, "node", chapter_id)?,
        };
        mutations.push(journal::Mutation::field(
            "node-storyline-primary",
            chapter_id,
            node_incarnation,
            "storylineId",
            json!(primary),
        ));
        Ok(())
    }

    /// Renderer `appendPlannedAuthoredOrderInTransaction` for storylines: the
    /// desired order is every row with `deleted_at IS NULL` by (order key, id);
    /// bounds come only from registers of live storylines at their current
    /// incarnation, so a storyline restored in this change-set is an insertion.
    fn push_storyline_order(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<(), String> {
        let mut rows: Vec<(i64, String)> = self
            .query(
                Some(tx),
                "SELECT order_key,id FROM storylines WHERE project_id=? AND deleted_at IS NULL",
                vec![text(&context.project_id)],
            )?
            .iter()
            .map(|row| {
                Ok((
                    match &row[0] {
                        V::Integer(v) => v.parse().map_err(|_| "Invalid storyline order")?,
                        V::Real(v) => *v as i64,
                        _ => return Err("Invalid storyline order".to_string()),
                    },
                    string(row, 1)?,
                ))
            })
            .collect::<Result<_, String>>()?;
        rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let ids: Vec<String> = rows.into_iter().map(|(_, id)| id).collect();
        let (positions, incarnations) = self.storyline_positions(tx, context)?;
        let pending: HashMap<String, u64> = mutations
            .iter()
            .filter_map(|m| m.lifecycle_target("storyline"))
            .collect();
        push_order(
            "storyline",
            &context.project_id,
            &positions,
            &ids,
            &|id| {
                pending
                    .get(id)
                    .or(incarnations.get(id))
                    .copied()
                    .unwrap_or(0)
            },
            mutations,
        )
    }

    /// Registers usable as bounds, and each storyline's current incarnation.
    fn storyline_positions(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
    ) -> Result<(HashMap<String, String>, HashMap<String, u64>), String> {
        let mut incarnations = HashMap::new();
        let mut live = HashMap::new();
        for row in self.query(Some(tx), "SELECT entity_id,incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='storyline'",
            vec![text(&context.sync_generation_id)])? {
            let (id, incarnation) = (string(&row, 0)?, safe_u64(&row[1])?);
            incarnations.insert(id.clone(), incarnation);
            live.insert(id, (incarnation, string(&row, 2)? == "live"));
        }
        let mut positions = HashMap::new();
        for row in self.query(Some(tx), "SELECT entity_id,incarnation,position_key FROM sync_order_register WHERE sync_generation_id=? AND list_kind='storyline' AND owner_id=?",
            vec![text(&context.sync_generation_id), text(&context.project_id)])? {
            let id = string(&row, 0)?;
            let usable = match live.get(&id) {
                None => true,
                Some((incarnation, is_live)) => *is_live && *incarnation == safe_u64(&row[1])?,
            };
            if usable {
                positions.insert(id, string(&row, 2)?);
            }
        }
        Ok((positions, incarnations))
    }

    /// The reducer's local projection: each live storyline's rank by
    /// (position key, id); `updated_at` is not touched.
    fn project_storyline_ranks(&self, tx: u64, project_id: &str) -> Result<(), String> {
        let rows = self.query(Some(tx), r#"
            SELECT s.id FROM storylines s
            JOIN sync_generation g ON g.project_id=s.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='storyline' AND l.entity_id=s.id
            JOIN sync_order_register r ON r.sync_generation_id=g.sync_generation_id AND r.list_kind='storyline'
                AND r.entity_id=s.id AND r.incarnation=COALESCE(l.incarnation,0)
            WHERE s.project_id=? AND s.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')
            ORDER BY CAST(r.position_key AS BLOB),s.id
        "#, vec![text(project_id)])?;
        for (rank, row) in rows.iter().enumerate() {
            self.execute(
                tx,
                "UPDATE storylines SET order_key=? WHERE id=? AND project_id=?",
                vec![
                    integer(rank as u64),
                    text(&string(row, 0)?),
                    text(project_id),
                ],
            )?;
        }
        Ok(())
    }

    fn lifecycle_incarnation(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
    ) -> Result<u64, String> {
        let rows = self.query(Some(tx), "SELECT incarnation FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?",
            vec![text(&context.sync_generation_id), text(kind), text(id)])?;
        rows.first().map_or(Ok(0), |row| safe_u64(&row[0]))
    }

    fn live_storyline(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        storyline_id: &str,
    ) -> Result<u64, String> {
        if !self
            .storyline_rows(Some(tx), &context.project_id, false)?
            .iter()
            .any(|s| s.id == storyline_id)
        {
            return Err("Storyline is not available in this project".into());
        }
        self.lifecycle_incarnation(tx, context, "storyline", storyline_id)
    }

    /// A chapter's linked storylines (UTF-8 order) and primary.
    fn links(
        &self,
        tx: Option<u64>,
        project_id: &str,
        chapter_id: &str,
    ) -> Result<(Vec<String>, Option<String>), String> {
        let rows = self.query(tx, r#"
            SELECT l.storyline_id,l.is_primary FROM node_storyline_link l JOIN storylines s ON s.id=l.storyline_id
            WHERE l.node_id=? AND s.project_id=? ORDER BY CAST(l.storyline_id AS BLOB)
        "#, vec![text(chapter_id), text(project_id)])?;
        let mut ids = Vec::new();
        let mut primary = None;
        for row in &rows {
            let id = string(row, 0)?;
            if matches!(&row[1], V::Integer(value) if value != "0") {
                if primary.is_some() {
                    return Err("Chapter has more than one primary storyline".into());
                }
                primary = Some(id.clone());
            }
            ids.push(id);
        }
        Ok((ids, primary))
    }

    fn membership(
        &self,
        tx: u64,
        project_id: &str,
        chapter_id: &str,
    ) -> Result<ChapterMembership, String> {
        let (storyline_ids, primary) = self.links(Some(tx), project_id, chapter_id)?;
        Ok(ChapterMembership {
            chapter_id: chapter_id.into(),
            storyline_ids,
            primary,
        })
    }

    fn storyline(&self, tx: u64, project_id: &str, id: &str) -> Result<WorkspaceStoryline, String> {
        let rows = self.query(
            Some(tx),
            &format!("SELECT {COLUMNS} FROM storylines s WHERE s.id=? AND s.project_id=?"),
            vec![text(id), text(project_id)],
        )?;
        storyline_from_row(
            rows.first()
                .ok_or("Storyline is not available in this project")?,
        )
    }

    fn storyline_rows(
        &self,
        tx: Option<u64>,
        project_id: &str,
        trashed: bool,
    ) -> Result<Vec<WorkspaceStoryline>, String> {
        let (filter, order) = if trashed {
            (
                "s.deleted_at IS NOT NULL AND l.state='trashed'",
                "s.deleted_at DESC,s.rowid",
            )
        } else {
            (
                "s.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')",
                "s.order_key,s.rowid",
            )
        };
        self.query(
            tx,
            &format!(
                r#"
            SELECT {COLUMNS} FROM storylines s
            JOIN sync_generation g ON g.project_id=s.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='storyline' AND l.entity_id=s.id
            WHERE s.project_id=? AND {filter} ORDER BY {order}
        "#
            ),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| storyline_from_row(row))
        .collect()
    }
}

/// Renderer `makeUniqueStorylineName`: trimmed, "New Storyline" when empty,
/// then " 2", " 3", ... until no other live storyline has it (ignoring case).
fn unique_name(base: &str, existing: &[WorkspaceStoryline], exclude: Option<&str>) -> String {
    let base = match js_trim(base) {
        "" => DEFAULT_STORYLINE,
        base => base,
    };
    let taken: BTreeSet<String> = existing
        .iter()
        .filter(|s| Some(s.id.as_str()) != exclude)
        .map(|s| js_trim(&s.name).to_lowercase())
        .collect();
    if !taken.contains(&base.to_lowercase()) {
        return base.into();
    }
    (2..)
        .map(|n| format!("{base} {n}"))
        .find(|name| !taken.contains(&name.to_lowercase()))
        .unwrap()
}

fn colour(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|c| c.is_ascii_hexdigit())
}

fn safe_u64(value: &V) -> Result<u64, String> {
    match value {
        V::Integer(value) => value.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE),
        _ => None,
    }
    .ok_or_else(|| "Invalid incarnation".into())
}

/// One empty paragraph and a nonempty Yjs event, like every native body seed.
fn validate_body_seed(seed: &ChapterSeed) -> Result<(), String> {
    let cache: Value =
        serde_json::from_str(&seed.content_json).map_err(|e| format!("Invalid seed JSON: {e}"))?;
    let blocks = cache.get("content").and_then(Value::as_array);
    if cache.get("type").and_then(Value::as_str) != Some("doc")
        || blocks.is_none_or(|blocks| blocks.len() != 1)
        || seed.update.is_empty()
    {
        return Err("A new body must be one empty paragraph and a nonempty Yjs event".into());
    }
    Ok(())
}

fn storyline_from_row(row: &[V]) -> Result<WorkspaceStoryline, String> {
    let id = string(row, 0)?;
    Ok(WorkspaceStoryline {
        document_id: format!("storyline:{id}"),
        id,
        project_id: string(row, 1)?,
        name: string(row, 2)?,
        color: string(row, 3)?,
        summary: string(row, 4)?,
        order_key: match &row[5] {
            V::Integer(value) => value.parse().map_err(|_| "Invalid storyline order")?,
            V::Real(value) => *value as i64,
            _ => return Err("Invalid storyline order".into()),
        },
        facts: serde_json::from_str(&string(row, 6)?).map_err(|_| "Invalid storyline facts")?,
        created_at: string(row, 7)?,
        updated_at: string(row, 8)?,
    })
}
