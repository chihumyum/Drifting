//! Drifts: free-floating `book_node` rows (`kind='drift'`, no book order and
//! no storylines) with their own prose body, drift groups ordered within their
//! parent, and binding a drift to an act boundary — the renderer's rows and
//! originals (useBookNode, useDriftGroup, useBookAct).
use super::facts::push_order;
use super::*;
use std::collections::HashMap;

#[cfg(test)]
mod tests;

const DEFAULT_DRIFT: &str = "New Drift";
const DEFAULT_GROUP: &str = "新分组";
/// Renderer `MAX_DRIFT_GROUP_DEPTH`: root groups may hold one level of groups.
const MAX_GROUP_DEPTH: usize = 2;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDrift {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub summary: String,
    pub drift_group_id: Option<String>,
    /// The act boundary this drift is bound to, if any.
    pub act_id: Option<String>,
    pub document_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDriftGroup {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub parent_group_id: Option<String>,
    pub sort_order: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct NewDrift {
    pub id: String,
    pub title: Option<String>,
    pub group_id: Option<String>,
    pub seed: ChapterSeed,
}

struct LiveDrift {
    drift: WorkspaceDrift,
    incarnation: u64,
}

const DRIFT_COLUMNS: &str =
    "n.id,n.project_id,n.title,n.summary,n.drift_group_id,n.created_at,n.updated_at,\
    (SELECT a.id FROM book_act a WHERE a.drift_node_id=n.id LIMIT 1)";
const GROUP_COLUMNS: &str =
    "d.id,d.project_id,d.name,d.parent_group_id,d.sort_order,d.created_at,d.updated_at";

impl WorkspaceStore<'_> {
    pub fn drifts(&self, project_id: &str) -> Result<Vec<WorkspaceDrift>, String> {
        self.drift_rows(None, project_id, false)
    }

    pub fn trashed_drifts(&self, project_id: &str) -> Result<Vec<WorkspaceDrift>, String> {
        self.drift_rows(None, project_id, true)
    }

    /// Groups in the renderer's `compareDriftGroups` order within each parent.
    pub fn drift_groups(&self, project_id: &str) -> Result<Vec<WorkspaceDriftGroup>, String> {
        let mut groups: Vec<WorkspaceDriftGroup> = self
            .query(
                None,
                &format!("SELECT {GROUP_COLUMNS} FROM drift_group d WHERE d.project_id=?"),
                vec![text(project_id)],
            )?
            .iter()
            .map(|row| group_from_row(row))
            .collect::<Result<_, _>>()?;
        groups.sort_by(compare_groups);
        Ok(groups)
    }

    pub fn create_drift(
        &self,
        context: &AuthoredProseContext,
        input: NewDrift,
    ) -> Result<WorkspaceDrift, String> {
        validate_context(context)?;
        let doc_id = format!("node-content:{}", input.id);
        if !opaque(&input.id) || !opaque(&doc_id) {
            return Err("Invalid drift identity".into());
        }
        let cache: Value = serde_json::from_str(&input.seed.content_json)
            .map_err(|e| format!("Invalid drift seed JSON: {e}"))?;
        if input.seed.update.is_empty() || cache.get("type").and_then(Value::as_str) != Some("doc")
        {
            return Err("A new drift body needs a document seed and a nonempty Yjs event".into());
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
            if let Some(group) = &input.group_id {
                self.group(tx, &context.project_id, group)?;
            }
            let title = self.unique_chapter_title(tx, &context.project_id, input.title.as_deref().unwrap_or(DEFAULT_DRIFT), None)?;
            let repository = ProseRepository::new(self.gateway, self.client);
            if repository.get_revision(&doc_id, Some(tx))? != 0 || repository.get_snapshot(&doc_id, Some(tx))?.is_some() {
                return Err("New drift already has durable prose".into());
            }
            // Position is local-only (the renderer scatters it randomly); a
            // receiver materializes 0,0 until a restore authors it.
            self.execute(tx, r#"
                INSERT INTO book_node (
                    id, title, summary, book_order, narrative_order, project_id, word_count,
                    word_count_basis_kind, word_count_basis_hash, word_count_basis_revision,
                    writing_status, kind, drift_group_id, position_x, position_y, created_at, updated_at
                ) VALUES (?, ?, '', NULL, NULL, ?, 0, 'yjs', ?, 1, 'drifting', 'drift', ?, 0, 0, ?, ?)
            "#, vec![text(&input.id), text(&title), text(&context.project_id), text(&basis_hash),
                input.group_id.as_deref().map(text).unwrap_or(V::Null), text(&context.now_iso), text(&context.now_iso)])?;
            self.execute(tx, "INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
                vec![text(&input.id), text(&input.seed.content_json), text(&context.now_iso), text(&context.now_iso)])?;
            let appended = repository.append_update(&doc_id, &input.seed.update, &RevisionSource::System,
                &context.now_iso, Some(0), Some(tx))?;
            self.commit_changes(tx, context, &[
                journal::Mutation::create("node", &input.id, json!({
                    "bookOrder": null, "driftGroupId": input.group_id, "kind": "drift", "narrativeOrder": null,
                    "summary": "", "title": title, "writingStatus": "drifting",
                })),
                journal::Mutation::yjs(&doc_id, &input.seed.update),
            ], Some((1, &appended, &input.seed.update)))?;
            Ok(self.live_drift(tx, context, &input.id)?.drift)
        })
    }

    /// Rename (unique across chapters and drifts) or move into a group;
    /// unchanged values write nothing.
    pub fn update_drift(
        &self,
        context: &AuthoredProseContext,
        drift_id: &str,
        title: Option<&str>,
        group_id: Option<Option<&str>>,
    ) -> Result<WorkspaceDrift, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let LiveDrift { drift, incarnation } = self.live_drift(tx, context, drift_id)?;
            if let Some(Some(group)) = group_id {
                self.group(tx, &context.project_id, group)?;
            }
            let mut next = drift.clone();
            let mut fields = Vec::new();
            // The renderer's three paths: renameNode suffixes a colliding title
            // and skips no change; moveDriftToGroup skips no change and stamps
            // the wall clock; updateNode (both at once) keeps the title as
            // given and journals both. Title edits advance updated_at >= +1 ms.
            match (title, group_id) {
                (Some(title), None) => {
                    next.title = self.unique_chapter_title(tx, &context.project_id, title, Some(drift_id))?;
                    if next.title != drift.title {
                        fields.push(("title", json!(next.title)));
                    }
                }
                (None, Some(group)) => {
                    next.drift_group_id = group.map(Into::into);
                    if next.drift_group_id != drift.drift_group_id {
                        fields.push(("driftGroupId", json!(next.drift_group_id)));
                    }
                }
                (Some(title), Some(group)) => {
                    next.title = title.into();
                    next.drift_group_id = group.map(Into::into);
                    fields.push(("driftGroupId", json!(next.drift_group_id)));
                    fields.push(("title", json!(next.title)));
                }
                (None, None) => {}
            }
            if fields.is_empty() {
                return Ok(drift);
            }
            let stamp = if title.is_some() {
                "CASE WHEN julianday(updated_at) IS NULL OR julianday(?3)>julianday(updated_at) THEN ?3 \
                    ELSE strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds') END"
            } else {
                "?3"
            };
            self.execute(tx, &format!("UPDATE book_node SET title=?1,drift_group_id=?2,updated_at={stamp} WHERE id=?4 AND project_id=?5"),
                vec![text(&next.title), next.drift_group_id.as_deref().map(text).unwrap_or(V::Null),
                    text(&context.now_iso), text(drift_id), text(&context.project_id)])?;
            let mutations: Vec<_> = fields.into_iter()
                .map(|(field, value)| journal::Mutation::field("node", drift_id, incarnation, field, value))
                .collect();
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(self.live_drift(tx, context, drift_id)?.drift)
        })
    }

    /// Bind a drift to an act boundary or unbind it (`None`). A drift is bound
    /// to at most one act, as the renderer's bind picker enforces.
    pub fn bind_act_drift(
        &self,
        context: &AuthoredProseContext,
        act_id: &str,
        drift_id: Option<&str>,
    ) -> Result<WorkspaceAct, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let (mut act, incarnation) = self.live_act(tx, context, act_id)?;
            if let Some(drift) = drift_id {
                self.live_drift(tx, context, drift)?;
                let bound = self.query(
                    Some(tx),
                    "SELECT id FROM book_act WHERE drift_node_id=? AND id<>? AND project_id=?",
                    vec![text(drift), text(act_id), text(&context.project_id)],
                )?;
                if !bound.is_empty() {
                    return Err("This drift is already bound to another act".into());
                }
            }
            if act.drift_node_id.as_deref() == drift_id {
                return Ok(act);
            }
            self.execute(
                tx,
                "UPDATE book_act SET drift_node_id=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    drift_id.map(text).unwrap_or(V::Null),
                    text(&context.now_iso),
                    text(act_id),
                    text(&context.project_id),
                ],
            )?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "book-act",
                    act_id,
                    incarnation,
                    "driftNodeId",
                    json!(drift_id),
                )],
                None,
            )?;
            act.drift_node_id = drift_id.map(Into::into);
            act.updated_at = context.now_iso.clone();
            Ok(act)
        })
    }

    /// Like the renderer: first unbind the drift's timeline markers and acts
    /// (one original each when any are bound), then trash it.
    pub fn trash_drift(
        &self,
        context: &AuthoredProseContext,
        drift_id: &str,
    ) -> Result<WorkspaceDrift, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let LiveDrift { mut drift, incarnation } = self.live_drift(tx, context, drift_id)?;
            // unbindMarkersForDrift, then unbindActsForDrift: one original each,
            // rows in index (rowid) order. A marker keeps its own caption and
            // otherwise takes the drift title, and journals both fields.
            let fallback = match js_trim(&drift.title) {
                "" => "Marker",
                title => title,
            };
            for (table, kind) in [("timeline_marker", "timeline-marker"), ("book_act", "book-act")] {
                let label = if kind == "timeline-marker" { "label" } else { "NULL" };
                let bound = self.query(Some(tx), &format!("SELECT id,{label} FROM {table} WHERE drift_node_id=? AND project_id=? ORDER BY rowid"),
                    vec![text(drift_id), text(&context.project_id)])?;
                if bound.is_empty() {
                    continue;
                }
                let mut mutations = Vec::new();
                for row in &bound {
                    let id = string(row, 0)?;
                    let owner = self.lifecycle_of(tx, context, kind, &id)?;
                    mutations.push(journal::Mutation::field(kind, &id, owner, "driftNodeId", Value::Null));
                    if kind == "timeline-marker" {
                        let current = string(row, 1)?;
                        let caption = if js_trim(&current).is_empty() { fallback.to_string() } else { current };
                        self.execute(tx, "UPDATE timeline_marker SET drift_node_id=NULL,label=?,updated_at=? WHERE id=? AND project_id=?",
                            vec![text(&caption), text(&context.now_iso), text(&id), text(&context.project_id)])?;
                        mutations.push(journal::Mutation::field(kind, &id, owner, "label", json!(caption)));
                    } else {
                        self.execute(tx, "UPDATE book_act SET drift_node_id=NULL,updated_at=? WHERE id=? AND project_id=?",
                            vec![text(&context.now_iso), text(&id), text(&context.project_id)])?;
                    }
                }
                self.commit_changes(tx, context, &mutations, None)?;
            }
            // The trash original itself purges the drift's relations first.
            let mut mutations = self.purge_relations(tx, context, "node", drift_id)?;
            self.execute(tx, "UPDATE book_node SET deleted_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&context.now_iso), text(&context.now_iso), text(drift_id), text(&context.project_id)])?;
            mutations.push(journal::Mutation::json("entity", "node", drift_id, "entity.trash", json!({}))
                .at_incarnation(incarnation));
            self.commit_changes(tx, context, &mutations, None)?;
            drift.act_id = None;
            drift.updated_at = context.now_iso.clone();
            Ok(drift)
        })
    }

    /// Reauthor the drift in the next incarnation: seed, graph position and
    /// the complete body state, as the renderer's node restore does.
    pub fn restore_drift<F>(
        &self,
        context: &AuthoredProseContext,
        drift_id: &str,
        mut capture_full_state: F,
    ) -> Result<WorkspaceDrift, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &str) -> Result<ChapterSeed, String>,
    {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let rows = self.query(Some(tx), r#"
                SELECT n.title,n.summary,n.narrative_order,n.drift_group_id,n.position_x,n.position_y,l.incarnation
                FROM book_node n JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='node'
                    AND l.entity_id=n.id AND l.state='trashed'
                WHERE n.id=? AND n.project_id=? AND n.kind='drift' AND n.deleted_at IS NOT NULL
            "#, vec![text(&context.sync_generation_id), text(drift_id), text(&context.project_id)])?;
            let row = rows.first().ok_or("Drift lifecycle must be trashed")?;
            let incarnation = match &row[6] {
                V::Integer(v) => v.parse::<u64>().ok(),
                _ => None,
            }
            .and_then(|n| n.checked_add(1))
            .filter(|n| *n <= MAX_SAFE)
            .ok_or("Invalid drift incarnation")?;
            let optional = |i: usize| match &row[i] { V::Null => Value::Null, V::Text(v) => json!(v), V::Real(v) => json!(v), V::Integer(v) => json!(v.parse::<f64>().unwrap_or(0.0)), _ => Value::Null };
            let seed = json!({"bookOrder": null, "driftGroupId": optional(3), "kind": "drift",
                "narrativeOrder": optional(2), "summary": string(row, 1)?, "title": string(row, 0)?, "writingStatus": "drifting"});
            let position = json!({"x": number(row, 4)?, "y": number(row, 5)?});
            let doc_id = format!("node-content:{drift_id}");
            let repo = ProseRepository::new(self.gateway, self.client);
            let revision = repo.get_revision(&doc_id, Some(tx))?;
            let state = capture_full_state(&repo, tx, &doc_id)?;
            if state.update.is_empty() {
                return Err("Restore requires a complete prose state".into());
            }
            self.execute(tx, "UPDATE book_node SET deleted_at=NULL,updated_at=? WHERE id=? AND project_id=?",
                vec![text(&context.now_iso), text(drift_id), text(&context.project_id)])?;
            let appended = repo.append_update(&doc_id, &state.update, &RevisionSource::System, &context.now_iso, Some(revision), Some(tx))?;
            self.commit_changes(tx, context, &[
                journal::Mutation::json("entity", "node", drift_id, "entity.restore", json!({"seed": seed})).at_incarnation(incarnation),
                journal::Mutation::json("entity", "node", drift_id, "tuple.set", json!({"tuple": "graph.position", "value": position}))
                    .at_incarnation(incarnation),
                journal::Mutation::yjs(&doc_id, &state.update).at_incarnation(incarnation),
            ], Some((2, &appended, &state.update)))?;
            Ok(self.live_drift(tx, context, drift_id)?.drift)
        })
    }

    pub fn create_drift_group(
        &self,
        context: &AuthoredProseContext,
        group_id: &str,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<WorkspaceDriftGroup, String> {
        validate_context(context)?;
        if !opaque(group_id) {
            return Err("Invalid drift group identity".into());
        }
        let name = match js_trim(name) {
            "" => DEFAULT_GROUP,
            name => name,
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let groups = self.all_groups(tx, &context.project_id)?;
            if let Some(parent) = parent_id {
                self.group(tx, &context.project_id, parent)?;
                if depth(&groups, parent) + 1 >= MAX_GROUP_DEPTH {
                    return Err("Drift groups nest at most one level".into());
                }
            }
            let sort_order = next_sibling_order(&groups, parent_id, &[])?;
            self.execute(tx, "INSERT INTO drift_group(id,project_id,name,parent_group_id,color,sort_order,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?)",
                vec![text(group_id), text(&context.project_id), text(name), parent_id.map(text).unwrap_or(V::Null),
                    V::Real(sort_order), text(&context.now_iso), text(&context.now_iso)])?;
            let mut mutations = vec![journal::Mutation::create("drift-group", group_id, json!({
                "color": null, "name": name, "parentGroupId": parent_id,
            }))];
            // Renderer: plan the parent scope over siblings by numeric order.
            let mut siblings = self.all_groups(tx, &context.project_id)?;
            siblings.retain(|g| g.parent_group_id.as_deref() == parent_id);
            siblings.sort_by(|a, b| a.sort_order.unwrap_or(0.0).total_cmp(&b.sort_order.unwrap_or(0.0)).then(a.id.cmp(&b.id)));
            let ids: Vec<String> = siblings.into_iter().map(|g| g.id).collect();
            let scope = group_scope(&context.project_id, parent_id);
            push_order("drift-group", &scope, &self.group_positions(tx, context, &scope)?, &ids, &|_| 0, &mut mutations)?;
            self.commit_changes(tx, context, &mutations, None)?;
            self.project_group_ranks(tx, context, &scope)?;
            self.group(tx, &context.project_id, group_id)
        })
    }

    pub fn rename_drift_group(
        &self,
        context: &AuthoredProseContext,
        group_id: &str,
        name: &str,
    ) -> Result<WorkspaceDriftGroup, String> {
        validate_context(context)?;
        // useDriftGroup.renameGroup: a blank name falls back to the default.
        let name = match js_trim(name) {
            "" => DEFAULT_GROUP,
            name => name,
        };
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let group = self.group(tx, &context.project_id, group_id)?;
            if group.name == name {
                return Ok(group);
            }
            self.execute(
                tx,
                "UPDATE drift_group SET name=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(name),
                    text(&context.now_iso),
                    text(group_id),
                    text(&context.project_id),
                ],
            )?;
            let incarnation = self.lifecycle_of(tx, context, "drift-group", group_id)?;
            self.commit_changes(
                tx,
                context,
                &[journal::Mutation::field(
                    "drift-group",
                    group_id,
                    incarnation,
                    "name",
                    json!(name),
                )],
                None,
            )?;
            self.group(tx, &context.project_id, group_id)
        })
    }

    /// Renderer `deleteGroup`: child groups rise to the deleted group's parent
    /// (after its existing siblings), that scope is rebalanced, member drifts
    /// move to the parent, then the group is purged. No drift is lost.
    pub fn delete_drift_group(
        &self,
        context: &AuthoredProseContext,
        group_id: &str,
    ) -> Result<(), String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let target = self.group(tx, &context.project_id, group_id)?;
            let parent = target.parent_group_id.clone();
            let groups = self.all_groups(tx, &context.project_id)?;
            let mut children: Vec<WorkspaceDriftGroup> =
                groups.iter().filter(|g| g.parent_group_id.as_deref() == Some(group_id)).cloned().collect();
            children.sort_by(compare_groups);
            let mut excluded: Vec<&str> = vec![group_id];
            excluded.extend(children.iter().map(|g| g.id.as_str()));
            let first = next_sibling_order(&groups, parent.as_deref(), &excluded)?;
            let mut mutations = Vec::new();
            for (index, child) in children.iter().enumerate() {
                self.execute(tx, "UPDATE drift_group SET parent_group_id=?,sort_order=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![parent.as_deref().map(text).unwrap_or(V::Null), V::Real(first + index as f64),
                        text(&context.now_iso), text(&child.id), text(&context.project_id)])?;
                let incarnation = self.lifecycle_of(tx, context, "drift-group", &child.id)?;
                mutations.push(journal::Mutation::field("drift-group", &child.id, incarnation, "parentGroupId", json!(parent)));
            }
            let mut siblings = self.all_groups(tx, &context.project_id)?;
            siblings.retain(|g| g.id != group_id && g.parent_group_id == parent);
            siblings.sort_by(compare_groups);
            if !siblings.is_empty() {
                let keys = crate::fractional::keys_between(None, None, siblings.len())?;
                let scope = group_scope(&context.project_id, parent.as_deref());
                for (group, key) in siblings.iter().zip(keys) {
                    let incarnation = self.lifecycle_of(tx, context, "drift-group", &group.id)?;
                    mutations.push(journal::Mutation::json("order", "drift-group", &group.id, "order.rebalance",
                        json!({"scope": scope, "entries": [{"entityId": group.id, "positionKey": key}]})).at_incarnation(incarnation));
                }
            }
            let members: Vec<String> = self.query(Some(tx),
                "SELECT id FROM book_node WHERE drift_group_id=? AND project_id=? AND deleted_at IS NULL ORDER BY id",
                vec![text(group_id), text(&context.project_id)])?.iter().map(|row| string(row, 0)).collect::<Result<_, _>>()?;
            for member in &members {
                self.execute(tx, "UPDATE book_node SET drift_group_id=?,updated_at=? WHERE id=? AND project_id=?",
                    vec![parent.as_deref().map(text).unwrap_or(V::Null), text(&context.now_iso), text(member), text(&context.project_id)])?;
                let incarnation = self.lifecycle_of(tx, context, "node", member)?;
                mutations.push(journal::Mutation::field("node", member, incarnation, "driftGroupId", json!(parent)));
            }
            self.execute(tx, "DELETE FROM drift_group WHERE id=? AND project_id=?", vec![text(group_id), text(&context.project_id)])?;
            let incarnation = self.lifecycle_of(tx, context, "drift-group", group_id)?;
            mutations.push(journal::Mutation::json("entity", "drift-group", group_id, "entity.purge", json!({})).at_incarnation(incarnation));
            self.commit_changes(tx, context, &mutations, None)?;
            if !siblings.is_empty() {
                self.project_group_ranks(tx, context, &group_scope(&context.project_id, parent.as_deref()))?;
            }
            Ok(())
        })
    }

    fn group_positions(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        scope: &str,
    ) -> Result<HashMap<String, String>, String> {
        let mut live = HashMap::new();
        for row in self.query(Some(tx), "SELECT entity_id,incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind='drift-group'",
            vec![text(&context.sync_generation_id)])? {
            live.insert(string(&row, 0)?, (row[1].clone(), string(&row, 2)? == "live"));
        }
        let mut positions = HashMap::new();
        for row in self.query(Some(tx), "SELECT entity_id,incarnation,position_key FROM sync_order_register WHERE sync_generation_id=? AND list_kind='drift-group' AND owner_id=?",
            vec![text(&context.sync_generation_id), text(scope)])? {
            let id = string(&row, 0)?;
            if live.get(&id).is_none_or(|(incarnation, is_live)| *is_live && *incarnation == row[1]) {
                positions.insert(id, string(&row, 2)?);
            }
        }
        Ok(positions)
    }

    /// The local reducer's projection: `sort_order` becomes the rank in scope.
    fn project_group_ranks(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        scope: &str,
    ) -> Result<(), String> {
        let rows = self.query(
            Some(tx),
            r#"
            SELECT r.entity_id FROM sync_order_register r
            JOIN drift_group d ON d.id=r.entity_id AND d.project_id=?
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=r.sync_generation_id
                AND l.entity_kind='drift-group' AND l.entity_id=r.entity_id
            WHERE r.sync_generation_id=? AND r.list_kind='drift-group' AND r.owner_id=?
                AND r.incarnation=COALESCE(l.incarnation,0) AND (l.state IS NULL OR l.state='live')
            ORDER BY CAST(r.position_key AS BLOB),r.entity_id
        "#,
            vec![
                text(&context.project_id),
                text(&context.sync_generation_id),
                text(scope),
            ],
        )?;
        for (rank, row) in rows.iter().enumerate() {
            self.execute(
                tx,
                "UPDATE drift_group SET sort_order=? WHERE id=? AND project_id=?",
                vec![
                    V::Real(rank as f64),
                    text(&string(row, 0)?),
                    text(&context.project_id),
                ],
            )?;
        }
        Ok(())
    }

    fn lifecycle_of(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
    ) -> Result<u64, String> {
        let rows = self.query(Some(tx), "SELECT incarnation FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?",
            vec![text(&context.sync_generation_id), text(kind), text(id)])?;
        match rows.first().map(|row| &row[0]) {
            None => Ok(0),
            Some(V::Integer(v)) => v
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_SAFE)
                .ok_or_else(|| "Invalid incarnation".into()),
            Some(_) => Err("Invalid incarnation".into()),
        }
    }

    fn live_drift(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        drift_id: &str,
    ) -> Result<LiveDrift, String> {
        let rows = self.query(Some(tx), &format!(r#"
            SELECT {DRIFT_COLUMNS},l.incarnation,l.state FROM book_node n
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=? AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.id=? AND n.project_id=? AND n.kind='drift' AND n.deleted_at IS NULL
        "#), vec![text(&context.sync_generation_id), text(drift_id), text(&context.project_id)])?;
        let row = rows
            .first()
            .ok_or("Drift is not available in this project")?;
        if !matches!(&row[9], V::Null) && string(row, 9)? != "live" {
            return Err("Drift is not live".into());
        }
        let incarnation = match &row[8] {
            V::Null => 0,
            V::Integer(v) => v
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_SAFE)
                .ok_or("Invalid drift incarnation")?,
            _ => return Err("Invalid drift incarnation".into()),
        };
        Ok(LiveDrift {
            drift: drift_from_row(row)?,
            incarnation,
        })
    }

    fn drift_rows(
        &self,
        tx: Option<u64>,
        project_id: &str,
        trashed: bool,
    ) -> Result<Vec<WorkspaceDrift>, String> {
        let filter = if trashed {
            "n.deleted_at IS NOT NULL AND l.state='trashed'"
        } else {
            "n.deleted_at IS NULL AND (l.state IS NULL OR l.state='live')"
        };
        self.query(
            tx,
            &format!(
                r#"
            SELECT {DRIFT_COLUMNS} FROM book_node n
            JOIN sync_generation g ON g.project_id=n.project_id AND g.status='active'
            LEFT JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.project_id=? AND n.kind='drift' AND {filter} ORDER BY n.created_at,n.rowid
        "#
            ),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| drift_from_row(row))
        .collect()
    }

    fn all_groups(&self, tx: u64, project_id: &str) -> Result<Vec<WorkspaceDriftGroup>, String> {
        self.query(
            Some(tx),
            &format!("SELECT {GROUP_COLUMNS} FROM drift_group d WHERE d.project_id=?"),
            vec![text(project_id)],
        )?
        .iter()
        .map(|row| group_from_row(row))
        .collect()
    }

    fn group(
        &self,
        tx: u64,
        project_id: &str,
        group_id: &str,
    ) -> Result<WorkspaceDriftGroup, String> {
        self.all_groups(tx, project_id)?
            .into_iter()
            .find(|g| g.id == group_id)
            .ok_or_else(|| "Drift group is not available in this project".into())
    }
}

/// `JSON.stringify([projectId, parentGroupId])`.
fn group_scope(project_id: &str, parent: Option<&str>) -> String {
    json!([project_id, parent]).to_string()
}

/// Renderer `compareDriftGroups`.
fn compare_groups(a: &WorkspaceDriftGroup, b: &WorkspaceDriftGroup) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a.sort_order, b.sort_order) {
        (Some(x), Some(y)) if x != y => return x.total_cmp(&y),
        (Some(_), None) => return Less,
        (None, Some(_)) => return Greater,
        _ => {}
    }
    a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id))
}

/// Renderer `nextSiblingSortOrder`: one past the largest finite sibling order.
fn next_sibling_order(
    groups: &[WorkspaceDriftGroup],
    parent: Option<&str>,
    excluded: &[&str],
) -> Result<f64, String> {
    let maximum = groups
        .iter()
        .filter(|g| !excluded.contains(&g.id.as_str()) && g.parent_group_id.as_deref() == parent)
        .filter_map(|g| g.sort_order.filter(|n| n.is_finite()))
        .fold(None, |max: Option<f64>, n| {
            Some(max.map_or(n, |m| m.max(n)))
        });
    Ok(maximum.map_or(0.0, |m| m + 1.0))
}

fn depth(groups: &[WorkspaceDriftGroup], id: &str) -> usize {
    let mut depth = 0;
    let mut current = groups
        .iter()
        .find(|g| g.id == id)
        .and_then(|g| g.parent_group_id.clone());
    let mut seen = std::collections::HashSet::new();
    while let Some(parent) = current.filter(|p| seen.insert(p.clone())) {
        depth += 1;
        current = groups
            .iter()
            .find(|g| g.id == parent)
            .and_then(|g| g.parent_group_id.clone());
    }
    depth
}

fn drift_from_row(row: &[V]) -> Result<WorkspaceDrift, String> {
    let optional = |i: usize| match &row[i] {
        V::Null => Ok(None),
        V::Text(v) => Ok(Some(v.clone())),
        _ => Err("Invalid drift optional text".to_string()),
    };
    let id = string(row, 0)?;
    Ok(WorkspaceDrift {
        document_id: format!("node-content:{id}"),
        id,
        project_id: string(row, 1)?,
        title: string(row, 2)?,
        summary: string(row, 3)?,
        drift_group_id: optional(4)?,
        created_at: string(row, 5)?,
        updated_at: string(row, 6)?,
        act_id: optional(7)?,
    })
}

fn group_from_row(row: &[V]) -> Result<WorkspaceDriftGroup, String> {
    let optional = |i: usize| match &row[i] {
        V::Null => Ok(None),
        V::Text(v) => Ok(Some(v.clone())),
        _ => Err("Invalid drift group optional text".to_string()),
    };
    Ok(WorkspaceDriftGroup {
        id: string(row, 0)?,
        project_id: string(row, 1)?,
        name: string(row, 2)?,
        parent_group_id: optional(3)?,
        sort_order: match &row[4] {
            V::Null => None,
            V::Real(v) => Some(*v),
            V::Integer(v) => v.parse().ok(),
            _ => return Err("Invalid drift group order".into()),
        },
        created_at: string(row, 5)?,
        updated_at: string(row, 6)?,
    })
}
