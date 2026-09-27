//! Shared project/chapter creation and naming for native hosts. Domain rows, initial prose,
//! canonical journal and reducer metadata commit together. Hosts supply IDs and
//! an empty Yrs seed; this Rust 1.88 layer does not own a second CRDT engine.
mod acts;
mod comments;
mod deletion;
mod drifts;
mod elements;
mod facts;
mod history;
mod journal;
mod library;
mod metadata;
mod metrics;
mod outline;
mod relations;
mod storylines;
mod timeline;
mod trash;
pub use comments::{
    plain_comment_doc, CommentPatch, NewChapterComment, NewComment, WorkspaceComment,
};
pub use deletion::ProjectDeletion;
pub use drifts::{NewDrift, WorkspaceDrift, WorkspaceDriftGroup};
pub use elements::{
    CategoryLayout, ElementChanges, NewElement, NewElementCategory, WorkspaceElement,
    WorkspaceElementCategory,
};
pub use facts::Fact;
pub use history::{HistoryEntry, SnapshotCapture};
pub use library::{
    ElementPortrait, NewAssetFile, WorkspaceAsset, WorkspaceLibraryItem, MAX_ASSET_BYTES,
};
pub use metadata::{ProjectChanges, WorkspaceNodeMetadata, WorkspaceProjectDetails};
pub use metrics::{NodeProjection, NodeWordCount};
pub use outline::WorkspaceOutlineRow;
pub use relations::{RelationTypeDefinition, WorkspaceRelation, WorkspaceRelationType};
pub use storylines::{ChapterMembership, NewStoryline, StorylineChanges, WorkspaceStoryline};
pub use timeline::{TimelineMarker, TimelineNode, WorkspaceTimeline};
#[cfg(test)]
mod tests;

use crate::database::{DatabaseGateway, DatabaseValue as V, TransactionBehavior};
use crate::original_body_archive::ArchiveScope;
use crate::prose::{ProseRepository, RevisionSource};
use crate::prose_journal::{
    encoding::hash, opaque, token, AuthoredProseContext, AuthoredProseJournal,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const FACTS: [&str; 6] = [
    "本书目标",
    "文风",
    "写作人称",
    "章节目标字数",
    "写法",
    "对标作品",
];
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub user_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub project_sync_id: String,
    pub sync_generation_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChapter {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub book_order: f64,
    pub writing_status: String,
    pub document_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAct {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: Option<String>,
    pub start_order: Option<f64>,
    pub drift_node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct CreateProject {
    pub user_id: String,
    pub name: String,
    pub default_kv_ids: [String; 6],
}

/// Both values must be exported from the same document. Creation requires an
/// empty document; restoration requires its full durable state. The prose
/// adapter validates Yrs before this layer atomically persists the System event.
pub struct ChapterSeed {
    pub update: Vec<u8>,
    pub content_json: String,
}

pub struct CreateChapter {
    pub id: String,
    pub title: String,
    /// None appends after the current last chapter using the product's +5 step.
    pub book_order: Option<f64>,
    pub seed: ChapterSeed,
}

pub struct WorkspaceStore<'a> {
    gateway: &'a DatabaseGateway,
    client: &'a str,
}

fn text(s: &str) -> V {
    V::Text(s.into())
}
fn integer(n: u64) -> V {
    V::Integer(n.to_string())
}
fn string(row: &[V], i: usize) -> Result<String, String> {
    match row.get(i) {
        Some(V::Text(s)) => Ok(s.clone()),
        _ => Err("Invalid workspace text column".into()),
    }
}
fn number(row: &[V], i: usize) -> Result<f64, String> {
    match row.get(i) {
        Some(V::Real(n)) if n.is_finite() => Ok(*n),
        Some(V::Integer(n)) => n
            .parse::<f64>()
            .map_err(|_| "Invalid workspace number".into()),
        _ => Err("Invalid workspace number column".into()),
    }
}
fn validate_context(c: &AuthoredProseContext) -> Result<(), String> {
    if ![&c.project_id, &c.project_sync_id, &c.sync_generation_id]
        .iter()
        .all(|s| opaque(s))
        || c.installation_id.is_empty()
        || c.now_iso.is_empty()
        || c.now_ms > MAX_SAFE
        || !token(&c.new_writer_id)
        || !token(&c.new_writer_epoch)
    {
        return Err("Invalid workspace author identity or clock".into());
    }
    Ok(())
}

impl<'a> WorkspaceStore<'a> {
    pub fn new(gateway: &'a DatabaseGateway, client: &'a str) -> Self {
        Self { gateway, client }
    }
    fn query(&self, tx: Option<u64>, sql: &str, values: Vec<V>) -> Result<Vec<Vec<V>>, String> {
        Ok(self
            .gateway
            .query(sql.into(), values, tx, self.client.into())?
            .rows)
    }
    fn execute(&self, tx: u64, sql: &str, values: Vec<V>) -> Result<(), String> {
        self.gateway
            .execute(sql.into(), values, Some(tx), self.client.into())?;
        Ok(())
    }
    fn transaction<T>(
        &self,
        behavior: TransactionBehavior,
        work: impl FnOnce(u64) -> Result<T, String>,
    ) -> Result<T, String> {
        let tx = self.gateway.begin(behavior, self.client.into())?;
        let result = work(tx).and_then(|result| {
            self.gateway.commit(tx, self.client.into())?;
            Ok(result)
        });
        match result {
            Ok(value) => Ok(value),
            Err(error) => match self.gateway.rollback(tx, self.client.into()) {
                Ok(()) => Err(error),
                Err(rollback) => Err(format!("{error}; workspace rollback failed: {rollback}")),
            },
        }
    }
    pub fn list_projects(&self, user_id: &str) -> Result<Vec<WorkspaceProject>, String> {
        self.query(None, r#"
            SELECT p.id,p.name,p.summary,p.user_id,p.created_at,p.updated_at,
                   g.project_sync_id,g.sync_generation_id
            FROM project p JOIN sync_generation g ON g.project_id=p.id AND g.status='active'
            WHERE p.user_id=? AND NOT EXISTS (
                SELECT 1 FROM sync_generation_purge x WHERE x.sync_generation_id=g.sync_generation_id
            )
            ORDER BY p.updated_at DESC,p.id COLLATE BINARY
        "#, vec![text(user_id)])?.iter().map(project_from_row).collect()
    }
    pub fn list_chapters(&self, project_id: &str) -> Result<Vec<WorkspaceChapter>, String> {
        self.chapters(None, project_id)
    }
    fn chapters(&self, tx: Option<u64>, project_id: &str) -> Result<Vec<WorkspaceChapter>, String> {
        self.query(tx, r#"
            SELECT n.id,n.project_id,n.title,n.book_order,n.writing_status,n.created_at,n.updated_at
            FROM book_node n JOIN sync_generation g ON g.project_id=n.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.project_id=? AND n.kind='chapter' AND n.deleted_at IS NULL
                AND (l.state IS NULL OR l.state='live') AND NOT EXISTS (
                    SELECT 1 FROM sync_generation_purge x WHERE x.sync_generation_id=g.sync_generation_id
                )
            ORDER BY n.book_order,n.id COLLATE BINARY
        "#, vec![text(project_id)])?.iter().map(chapter_from_row).collect()
    }
    pub fn chapter_scope(
        &self,
        project_id: &str,
        chapter_id: &str,
    ) -> Result<ArchiveScope, String> {
        self.transaction(TransactionBehavior::Deferred, |tx| {
            let chapter = self.chapters(Some(tx), project_id)?.into_iter()
                .find(|c| c.id == chapter_id).ok_or("Chapter is not available in this project")?;
            let rows = self.query(Some(tx), "SELECT project_sync_id,sync_generation_id FROM sync_generation WHERE project_id=? AND status='active'", vec![text(project_id)])?;
            let row = rows.first().ok_or("Project has no active sync generation")?;
            let project_sync_id = string(row, 0)?;
            let sync_generation_id = string(row, 1)?;
            let incarnation = AuthoredProseJournal::new(self.gateway, self.client).current_incarnation(
                tx, project_id, &project_sync_id, &sync_generation_id, &chapter.document_id)?;
            Ok(ArchiveScope { project_id: project_id.into(), project_sync_id, sync_generation_id,
                document_id: chapter.document_id, incarnation })
        })
    }
    pub fn create_project(
        &self,
        context: &AuthoredProseContext,
        input: CreateProject,
    ) -> Result<WorkspaceProject, String> {
        validate_context(context)?;
        let relation_id = format!("system:generic-association:{}", context.project_id);
        if !opaque(&input.user_id)
            || input.name.trim().is_empty()
            || !opaque(&relation_id)
            || !input.default_kv_ids.iter().all(|id| opaque(id))
            || input.default_kv_ids.iter().collect::<HashSet<_>>().len() != 6
        {
            return Err("Invalid new project name, user or default fact IDs".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            let kv = serde_json::to_string(&FACTS.map(|key| json!({"key": key, "value": ""})))
                .map_err(|e| e.to_string())?;
            self.execute(
                tx,
                r#"
                INSERT INTO project (
                    id, name, summary, kv_json, storyline_template_kv_json,
                    user_id, created_at, updated_at
                ) VALUES (?, ?, '', ?, '[]', ?, ?, ?)
                "#,
                vec![
                    text(&context.project_id), text(&input.name), text(&kv),
                    text(&input.user_id), text(&context.now_iso), text(&context.now_iso),
                ],
            )?;
            self.execute(
                tx,
                r#"
                INSERT INTO sync_generation (
                    sync_generation_id, project_id, project_sync_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                "#,
                vec![
                    text(&context.sync_generation_id), text(&context.project_id),
                    text(&context.project_sync_id), text(&context.now_iso), text(&context.now_iso),
                ],
            )?;
            let mut mutations = vec![journal::Mutation::create(
                "project", &context.project_id, json!({"name": input.name, "summary": ""}),
            )];
            for (id, key) in input.default_kv_ids.iter().zip(FACTS) {
                self.execute(
                    tx,
                    r#"
                    INSERT INTO entity_kv_entry (id, project_id, owner_kind, owner_id, namespace, key, value)
                    VALUES (?, ?, 'project', ?, 'facts', ?, '')
                    "#,
                    vec![text(id), text(&context.project_id), text(&context.project_id), text(key)],
                )?;
                mutations.push(journal::Mutation::create(
                    "kv-entry", id,
                    json!({
                        "projectId": context.project_id, "ownerKind": "project",
                        "ownerId": context.project_id, "namespace": "facts", "key": key, "value": "",
                    }),
                ));
            }
            // Exact initial generateNKeysBetween(null, null, 6) keys. This fixed
            // empty-scope bootstrap does not implement a general reorder engine.
            let scope = serde_json::to_string(&["project", &context.project_id, "facts"])
                .map_err(|e| e.to_string())?;
            for (index, id) in input.default_kv_ids.iter().enumerate() {
                mutations.push(journal::Mutation::json(
                    "order", "kv-entry", id, "order.move",
                    json!({"scope": scope, "positionKey": format!("a{index}")}),
                ));
            }
            self.execute(
                tx,
                r#"
                INSERT INTO entity_relation_type (
                    id, project_id, name, normalized_name, description, orientation,
                    system_key, locked, source_role, target_role, created_at, updated_at
                ) VALUES (
                    ?, ?, 'Generic association', 'generic association',
                    'Built-in association for TODO and library item links.', 'directed',
                    'generic-association', 1, 'Source', 'Target', ?, ?
                )
                "#,
                vec![text(&relation_id), text(&context.project_id), text(&context.now_iso), text(&context.now_iso)],
            )?;
            for (side, kinds) in [
                ("source", &["comment", "library_item"][..]),
                ("target", &["node", "element", "patch", "category", "storyline"][..]),
            ] {
                for kind in kinds {
                    self.execute(
                        tx,
                        r#"
                        INSERT INTO entity_relation_type_endpoint_kind (relation_type_id, side, entity_kind)
                        VALUES (?, ?, ?)
                        "#,
                        vec![text(&relation_id), text(side), text(kind)],
                    )?;
                }
            }
            mutations.push(journal::Mutation::create(
                "entity-relation-type", &relation_id,
                json!({
                    "name": "Generic association", "normalizedName": "generic association",
                    "description": "Built-in association for TODO and library item links.",
                    "orientation": "directed", "systemKey": "generic-association", "locked": true,
                    "sourceRole": "Source", "targetRole": "Target",
                    "sourceKinds": ["comment", "library_item"],
                    "targetKinds": ["node", "element", "patch", "category", "storyline"],
                }),
            ));
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(WorkspaceProject {
                id: context.project_id.clone(), name: input.name, summary: String::new(), user_id: input.user_id,
                created_at: context.now_iso.clone(), updated_at: context.now_iso.clone(),
                project_sync_id: context.project_sync_id.clone(), sync_generation_id: context.sync_generation_id.clone(),
            })
        })
    }

    pub fn create_chapter(
        &self,
        context: &AuthoredProseContext,
        input: CreateChapter,
    ) -> Result<WorkspaceChapter, String> {
        validate_context(context)?;
        let doc_id = format!("node-content:{}", input.id);
        if !opaque(&input.id)
            || !opaque(&doc_id)
            || input.book_order.is_some_and(|n| !n.is_finite())
        {
            return Err("Invalid new chapter identity or order".into());
        }
        let cache: Value = serde_json::from_str(&input.seed.content_json)
            .map_err(|e| format!("Invalid chapter seed JSON: {e}"))?;
        let blocks = cache
            .get("content")
            .and_then(Value::as_array)
            .ok_or("Chapter seed must contain an empty paragraph")?;
        if cache.get("type").and_then(Value::as_str) != Some("doc")
            || blocks.len() != 1
            || blocks[0].get("type").and_then(Value::as_str) != Some("paragraph")
            || blocks[0]
                .get("content")
                .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
            || input.seed.update.is_empty()
        {
            return Err("Chapter seed must be one empty paragraph and a nonempty Yjs event".into());
        }
        let basis_hash = format!(
            "sha256:{}",
            hash(
                serde_json::to_string(&cache)
                    .map_err(|e| e.to_string())?
                    .as_bytes()
            )
        );
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let title = self.unique_chapter_title(tx, &context.project_id, &input.title, None)?;
            let book_order = match input.book_order {
                Some(value) => value,
                None => self.chapters(Some(tx), &context.project_id)?.iter()
                    .fold(0.0_f64, |order, chapter| order.max(chapter.book_order)) + 5.0,
            };
            if !book_order.is_finite() {
                return Err("Chapter order is not finite".into());
            }
            let repository = ProseRepository::new(self.gateway, self.client);
            if repository.get_snapshot(&doc_id, Some(tx))?.is_some()
                || !repository.list_updates(&doc_id, None, Some(tx))?.is_empty()
                || repository.get_revision(&doc_id, Some(tx))? != 0
            {
                return Err("New chapter already has durable prose".into());
            }
            self.execute(
                tx,
                r#"
                INSERT INTO book_node (
                    id, title, summary, book_order, narrative_order, project_id, word_count,
                    word_count_basis_kind, word_count_basis_hash, word_count_basis_revision,
                    writing_status, kind, drift_group_id, position_x, position_y, created_at, updated_at
                ) VALUES (?, ?, '', ?, NULL, ?, 0, 'yjs', ?, 1, 'draft', 'chapter', NULL, 0, 0, ?, ?)
                "#,
                vec![
                    text(&input.id), text(&title), V::Real(book_order), text(&context.project_id),
                    text(&basis_hash), text(&context.now_iso), text(&context.now_iso),
                ],
            )?;
            self.execute(
                tx,
                r#"
                INSERT INTO node_content (node_id, content_json, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                "#,
                vec![text(&input.id), text(&input.seed.content_json), text(&context.now_iso), text(&context.now_iso)],
            )?;
            let appended = repository.append_update(
                &doc_id, &input.seed.update, &RevisionSource::System, &context.now_iso, Some(0), Some(tx),
            )?;
            let mutations = vec![
                journal::Mutation::create(
                    "node", &input.id,
                    json!({
                        "title": title, "summary": "", "bookOrder": book_order, "narrativeOrder": null,
                        "kind": "chapter", "driftGroupId": null, "writingStatus": "draft",
                    }),
                ),
                journal::Mutation::yjs(&doc_id, &input.seed.update),
                journal::Mutation::json(
                    "entity", "node-storyline-primary", &input.id, "field.set",
                    json!({"field": "storylineId", "value": null}),
                ),
            ];
            self.commit_changes(tx, context, &mutations, Some((1, &appended, &input.seed.update)))?;
            Ok(WorkspaceChapter {
                id: input.id, project_id: context.project_id.clone(), title, book_order,
                writing_status: "draft".into(), document_id: doc_id,
                created_at: context.now_iso.clone(), updated_at: context.now_iso.clone(),
            })
        })
    }

    /// Rename the current live project. An identical name is a durable no-op.
    pub fn rename_project(
        &self,
        context: &AuthoredProseContext,
        name: &str,
    ) -> Result<WorkspaceProject, String> {
        validate_context(context)?;
        if js_trim(name).is_empty() {
            return Err("Project name must not be empty".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            let incarnation = self.guard_project(tx, context)?;
            let rows = self.query(
                Some(tx),
                r#"
                SELECT p.id,p.name,p.summary,p.user_id,p.created_at,p.updated_at,
                       g.project_sync_id,g.sync_generation_id
                FROM project p JOIN sync_generation g ON g.project_id=p.id
                WHERE p.id=? AND g.sync_generation_id=?
                "#,
                vec![text(&context.project_id), text(&context.sync_generation_id)],
            )?;
            let mut project = project_from_row(rows.first().ok_or("Project does not exist")?)?;
            if project.name == name {
                return Ok(project);
            }
            self.execute(
                tx,
                "UPDATE project SET name=?,updated_at=? WHERE id=?",
                vec![
                    text(name),
                    text(&context.now_iso),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "project",
                    &context.project_id,
                    incarnation,
                    "name",
                    json!(name),
                )],
                None,
            )?;
            project.name = name.into();
            project.updated_at = context.now_iso.clone();
            Ok(project)
        })
    }

    /// Chapter names share the renderer's project-wide, case-insensitive
    /// namespace with drift nodes; the renamed chapter itself is excluded.
    pub fn rename_chapter(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
        requested_title: &str,
    ) -> Result<WorkspaceChapter, String> {
        validate_context(context)?;
        if !opaque(chapter_id) {
            return Err("Invalid chapter identity".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let mut chapter = self
                .chapters(Some(tx), &context.project_id)?
                .into_iter()
                .find(|chapter| chapter.id == chapter_id)
                .ok_or("Chapter is not available in this project")?;
            let incarnation = AuthoredProseJournal::new(self.gateway, self.client)
                .current_incarnation(
                    tx,
                    &context.project_id,
                    &context.project_sync_id,
                    &context.sync_generation_id,
                    &chapter.document_id,
                )?;
            let title = self.unique_chapter_title(
                tx,
                &context.project_id,
                requested_title,
                Some(chapter_id),
            )?;
            if chapter.title == title {
                return Ok(chapter);
            }
            // Match nextNodeUpdatedAt: a real rename always advances the node's
            // optimistic concurrency timestamp even within the same millisecond.
            self.execute(
                tx,
                r#"
                UPDATE book_node SET title=?,updated_at=CASE
                    WHEN julianday(updated_at) IS NULL OR julianday(?)>julianday(updated_at) THEN ?
                    ELSE strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds')
                END WHERE id=? AND project_id=?
                "#,
                vec![
                    text(&title),
                    text(&context.now_iso),
                    text(&context.now_iso),
                    text(chapter_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "node",
                    chapter_id,
                    incarnation,
                    "title",
                    json!(title),
                )],
                None,
            )?;
            let rows = self.query(
                Some(tx),
                "SELECT updated_at FROM book_node WHERE id=?",
                vec![text(chapter_id)],
            )?;
            chapter.title = title;
            chapter.updated_at = string(rows.first().ok_or("Chapter disappeared")?, 0)?;
            Ok(chapter)
        })
    }

    /// Move one chapter on the existing continuous reading axis. Act boundaries
    /// and other chapter coordinates remain fixed; this is not a spread/reindex.
    /// Equal or exhausted numeric gaps require a separate placement choice.
    pub fn move_chapter(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
        before_chapter_id: Option<&str>,
    ) -> Result<Vec<WorkspaceChapter>, String> {
        validate_context(context)?;
        if !opaque(chapter_id) || before_chapter_id.is_some_and(|id| !opaque(id)) {
            return Err("Invalid chapter move identity".into());
        }
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let chapters = self.chapters(Some(tx), &context.project_id)?;
            let source_index = chapters
                .iter()
                .position(|chapter| chapter.id == chapter_id)
                .ok_or("Moving chapter is not available in this project")?;
            if before_chapter_id.is_some_and(|id| !chapters.iter().any(|chapter| chapter.id == id))
            {
                return Err("Destination chapter is not available in this project".into());
            }
            let source = &chapters[source_index];
            let incarnation = AuthoredProseJournal::new(self.gateway, self.client)
                .current_incarnation(
                    tx,
                    &context.project_id,
                    &context.project_sync_id,
                    &context.sync_generation_id,
                    &source.document_id,
                )?;
            if before_chapter_id == Some(chapter_id) {
                return Ok(chapters);
            }
            let remaining: Vec<_> = chapters
                .iter()
                .filter(|chapter| chapter.id != chapter_id)
                .collect();
            let destination = match before_chapter_id {
                Some(id) => remaining
                    .iter()
                    .position(|chapter| chapter.id == id)
                    .ok_or("Destination chapter disappeared")?,
                None => remaining.len(),
            };
            // Removing the chapter makes its immediate successor occupy the
            // same index. No clock or timestamp should change for this request.
            if destination == source_index {
                return Ok(chapters);
            }
            let left = destination
                .checked_sub(1)
                .map(|index| remaining[index].book_order);
            let right = remaining.get(destination).map(|chapter| chapter.book_order);
            let next = match (left, right) {
                (Some(left), Some(right)) => {
                    // Halves avoid overflow across opposite-signed extremes;
                    // the usual formula retains precision within one sign.
                    if left.is_sign_negative() != right.is_sign_negative() {
                        left / 2.0 + right / 2.0
                    } else {
                        left + (right - left) / 2.0
                    }
                }
                (None, Some(right)) => right - 5.0,
                (Some(left), None) => left + 5.0,
                (None, None) => return Ok(chapters),
            };
            if !next.is_finite()
                || left.is_some_and(|left| !left.is_finite() || next <= left)
                || right.is_some_and(|right| !right.is_finite() || next >= right)
            {
                return Err(
                    "Chapter move has no representable numeric gap; choose another position".into(),
                );
            }
            self.execute(
                tx,
                r#"
                UPDATE book_node SET book_order=?,updated_at=CASE
                    WHEN julianday(updated_at) IS NULL OR julianday(?)>julianday(updated_at) THEN ?
                    ELSE strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds')
                END WHERE id=? AND project_id=?
                "#,
                vec![
                    V::Real(next),
                    text(&context.now_iso),
                    text(&context.now_iso),
                    text(chapter_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "node",
                    chapter_id,
                    incarnation,
                    "bookOrder",
                    json!(next),
                )],
                None,
            )?;
            self.chapters(Some(tx), &context.project_id)
        })
    }

    fn unique_chapter_title(
        &self,
        tx: u64,
        project_id: &str,
        requested: &str,
        exclude_id: Option<&str>,
    ) -> Result<String, String> {
        let rows = self.query(
            Some(tx),
            "SELECT id,title FROM book_node WHERE project_id=? AND deleted_at IS NULL",
            vec![text(project_id)],
        )?;
        let mut taken = HashSet::new();
        for row in rows {
            if exclude_id != Some(string(&row, 0)?.as_str()) {
                taken.insert(js_trim(&string(&row, 1)?).to_lowercase());
            }
        }
        let base = js_trim(requested);
        let base = if base.is_empty() { "Untitled" } else { base };
        let mut title = base.to_string();
        let mut suffix = 2_u64;
        while taken.contains(&title.to_lowercase()) {
            title = format!("{base} {suffix}");
            suffix += 1;
        }
        Ok(title)
    }

    fn guard_project(&self, tx: u64, c: &AuthoredProseContext) -> Result<u64, String> {
        let found=self.query(Some(tx),r#"
            SELECT COALESCE(l.incarnation,0) FROM project p JOIN sync_generation g ON g.project_id=p.id
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='project' AND l.entity_id=p.id
            WHERE p.id=? AND g.sync_generation_id=? AND g.project_sync_id=? AND g.status='active'
                AND (l.state IS NULL OR l.state='live')
                AND NOT EXISTS (SELECT 1 FROM sync_generation_purge x WHERE x.sync_generation_id=g.sync_generation_id)
        "#,vec![text(&c.project_id),text(&c.sync_generation_id),text(&c.project_sync_id)])?;
        if found.len() != 1 {
            return Err("Project and active generation identity do not match".into());
        }
        match &found[0][0] {
            V::Integer(value) => value
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_SAFE)
                .ok_or_else(|| "Invalid project incarnation".into()),
            _ => Err("Invalid project incarnation".into()),
        }
    }
}
fn project_from_row(r: &Vec<V>) -> Result<WorkspaceProject, String> {
    Ok(WorkspaceProject {
        id: string(r, 0)?,
        name: string(r, 1)?,
        summary: string(r, 2)?,
        user_id: string(r, 3)?,
        created_at: string(r, 4)?,
        updated_at: string(r, 5)?,
        project_sync_id: string(r, 6)?,
        sync_generation_id: string(r, 7)?,
    })
}
fn chapter_from_row(r: &Vec<V>) -> Result<WorkspaceChapter, String> {
    let id = string(r, 0)?;
    Ok(WorkspaceChapter {
        document_id: format!("node-content:{id}"),
        id,
        project_id: string(r, 1)?,
        title: string(r, 2)?,
        book_order: number(r, 3)?,
        writing_status: string(r, 4)?,
        created_at: string(r, 5)?,
        updated_at: string(r, 6)?,
    })
}
// ECMAScript String.trim includes BOM and excludes the Unicode NEL control.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}
