//! Permanent deletion from the trash (彻底删除). Only a trashed chapter,
//! drift, element, category or storyline can be purged. What only it owns
//! goes with it in one transaction: comments on it, its facts, an element's
//! patches, its Yjs body and version history. The entity's lifecycle moves
//! from `trashed` to `purged`; the journal keeps every earlier original.
use super::*;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgedEntity {
    pub kind: String,
    pub id: String,
    pub document_id: String,
    /// App-owned asset directories (an element's portrait) whose bytes may
    /// now be removed.
    pub asset_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedEntity {
    pub kind: String,
    pub id: String,
    pub title: String,
    /// When it entered the trash (its `deleted_at`).
    pub trashed_at: String,
}

struct Target {
    table: &'static str,
    lifecycle: &'static str,
    relation: &'static str,
    history: &'static str,
    prefix: &'static str,
    facts: Option<&'static str>,
}

fn target(kind: &str) -> Result<Target, String> {
    let (table, lifecycle, relation, prefix, facts) = match kind {
        "chapter" | "drift" => ("book_node", "node", "node", "node-content", None),
        "element" => ("element", "element", "element", "element", Some("element")),
        "category" => (
            "element_category",
            "element-category",
            "category",
            "category",
            Some("element-category"),
        ),
        "storyline" => (
            "storylines",
            "storyline",
            "storyline",
            "storyline",
            Some("storyline"),
        ),
        _ => return Err(format!("{kind} cannot be purged from the trash")),
    };
    Ok(Target {
        table,
        lifecycle,
        relation,
        history: relation,
        prefix,
        facts,
    })
}

impl WorkspaceStore<'_> {
    /// The trash, newest first by the time each entity was trashed.
    pub fn trash_listing(&self, project_id: &str) -> Result<Vec<TrashedEntity>, String> {
        let mut found = Vec::new();
        for sql in [
            "SELECT kind,id,title,deleted_at FROM book_node WHERE project_id=? AND deleted_at IS NOT NULL AND kind IN ('chapter','drift')",
            "SELECT 'element',id,name,deleted_at FROM element WHERE project_id=? AND deleted_at IS NOT NULL",
            "SELECT 'category',id,name,deleted_at FROM element_category WHERE project_id=? AND deleted_at IS NOT NULL",
            "SELECT 'storyline',id,name,deleted_at FROM storylines WHERE project_id=? AND deleted_at IS NOT NULL",
        ] {
            for row in self.query(None, sql, vec![text(project_id)])? {
                found.push(TrashedEntity {
                    kind: string(&row, 0)?,
                    id: string(&row, 1)?,
                    title: string(&row, 2)?,
                    trashed_at: string(&row, 3)?,
                });
            }
        }
        found.sort_by(|a, b| b.trashed_at.cmp(&a.trashed_at).then(a.id.cmp(&b.id)));
        Ok(found)
    }

    /// Every trashed entity of the project, as `(kind, id)` in a stable order.
    pub fn trashed_entities(&self, project_id: &str) -> Result<Vec<(String, String)>, String> {
        self.trashed_in(None, project_id)
    }

    fn trashed_in(
        &self,
        tx: Option<u64>,
        project_id: &str,
    ) -> Result<Vec<(String, String)>, String> {
        let mut found = Vec::new();
        for (sql, kind) in [
            ("SELECT id,kind FROM book_node WHERE project_id=? AND deleted_at IS NOT NULL AND kind IN ('chapter','drift') ORDER BY id", ""),
            ("SELECT id FROM element WHERE project_id=? AND deleted_at IS NOT NULL ORDER BY id", "element"),
            ("SELECT id FROM element_category WHERE project_id=? AND deleted_at IS NOT NULL ORDER BY id", "category"),
            ("SELECT id FROM storylines WHERE project_id=? AND deleted_at IS NOT NULL ORDER BY id", "storyline"),
        ] {
            for row in self.query(tx, sql, vec![text(project_id)])? {
                let kind = if kind.is_empty() { string(&row, 1)? } else { kind.to_string() };
                found.push((kind, string(&row, 0)?));
            }
        }
        Ok(found)
    }

    pub fn purge_trashed(
        &self,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
    ) -> Result<PurgedEntity, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let mut mutations = Vec::new();
            let purged = self.purge_in(tx, context, kind, id, &mut mutations)?;
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(purged)
        })
    }

    /// Purges everything in the project's trash in one original.
    /// `confirmed` is the `(kind, id)` set the author saw and confirmed; the
    /// trash must still hold exactly that set, or nothing is purged.
    pub fn empty_trash(
        &self,
        context: &AuthoredProseContext,
        confirmed: &[(String, String)],
    ) -> Result<Vec<PurgedEntity>, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let trashed = self.trashed_in(Some(tx), &context.project_id)?;
            let mut expected: Vec<&(String, String)> = confirmed.iter().collect();
            let mut actual: Vec<&(String, String)> = trashed.iter().collect();
            expected.sort();
            expected.dedup();
            actual.sort();
            if expected != actual {
                return Err("回收站在确认后有变化，请重新查看后再清空".into());
            }
            if trashed.is_empty() {
                return Ok(Vec::new());
            }
            let mut mutations = Vec::new();
            let mut purged = Vec::new();
            for (kind, id) in &trashed {
                purged.push(self.purge_in(tx, context, kind, id, &mut mutations)?);
            }
            self.commit_changes(tx, context, &mutations, None)?;
            Ok(purged)
        })
    }

    fn lifecycle_of_kind(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
    ) -> Result<Option<(u64, String)>, String> {
        let rows = self.query(Some(tx), "SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?",
            vec![text(&context.sync_generation_id), text(kind), text(id)])?;
        rows.first()
            .map(|row| {
                let incarnation = match &row[0] {
                    V::Integer(value) => value
                        .parse::<u64>()
                        .map_err(|_| "Invalid incarnation".to_string())?,
                    _ => return Err("Invalid incarnation".into()),
                };
                Ok((incarnation, string(row, 1)?))
            })
            .transpose()
    }

    fn purge_in(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        kind: &str,
        id: &str,
        mutations: &mut Vec<journal::Mutation>,
    ) -> Result<PurgedEntity, String> {
        let target = target(kind)?;
        let node_kind = if target.table == "book_node" {
            " AND kind=?"
        } else {
            ""
        };
        let mut values = vec![text(id), text(&context.project_id)];
        if target.table == "book_node" {
            values.push(text(kind));
        }
        if self.query(Some(tx), &format!("SELECT 1 FROM {} WHERE id=? AND project_id=? AND deleted_at IS NOT NULL{node_kind}", target.table), values)?.is_empty() {
            return Err("只有回收站里的内容才能彻底删除".into());
        }
        let (incarnation, state) = self
            .lifecycle_of_kind(tx, context, target.lifecycle, id)?
            .ok_or("只有回收站里的内容才能彻底删除")?;
        if state != "trashed" {
            return Err("只有回收站里的内容才能彻底删除".into());
        }
        mutations.extend(self.purge_relations(tx, context, target.relation, id)?);
        // Comments written on it go with it.
        for row in self.query(Some(tx), "SELECT id FROM comment WHERE project_id=? AND target_kind=? AND target_id=? ORDER BY id",
            vec![text(&context.project_id), text(target.relation), text(id)])? {
            let comment = string(&row, 0)?;
            mutations.extend(self.purge_relations(tx, context, "comment", &comment)?);
            self.remove_comment_actions(tx, context, &comment, mutations)?;
            self.execute(tx, "DELETE FROM comment WHERE id=? AND project_id=?", vec![text(&comment), text(&context.project_id)])?;
            if let Some((comment_incarnation, "live")) = self.lifecycle_of_kind(tx, context, "comment", &comment)?.as_ref().map(|(i, s)| (*i, s.as_str())) {
                mutations.push(journal::Mutation::json("entity", "comment", &comment, "entity.purge", json!({})).at_incarnation(comment_incarnation));
            }
        }
        if let Some(owner) = target.facts {
            for row in self.query(Some(tx), "SELECT id FROM entity_kv_entry WHERE project_id=? AND owner_kind=? AND owner_id=? ORDER BY id",
                vec![text(&context.project_id), text(owner), text(id)])? {
                let entry = string(&row, 0)?;
                self.execute(tx, "DELETE FROM entity_kv_entry WHERE id=? AND project_id=?", vec![text(&entry), text(&context.project_id)])?;
                if let Some((entry_incarnation, "live")) = self.lifecycle_of_kind(tx, context, "kv-entry", &entry)?.as_ref().map(|(i, s)| (*i, s.as_str())) {
                    mutations.push(journal::Mutation::json("entity", "kv-entry", &entry, "entity.purge", json!({})).at_incarnation(entry_incarnation));
                }
            }
        }
        if kind == "element" {
            for row in self.query(
                Some(tx),
                "SELECT id FROM element_patch WHERE project_id=? AND element_id=? ORDER BY id",
                vec![text(&context.project_id), text(id)],
            )? {
                let patch = string(&row, 0)?;
                mutations.extend(self.purge_relations(tx, context, "patch", &patch)?);
                self.execute(
                    tx,
                    "DELETE FROM element_patch WHERE id=? AND project_id=?",
                    vec![text(&patch), text(&context.project_id)],
                )?;
                if let Some((patch_incarnation, "live")) = self
                    .lifecycle_of_kind(tx, context, "element-patch", &patch)?
                    .as_ref()
                    .map(|(i, s)| (*i, s.as_str()))
                {
                    mutations.push(
                        journal::Mutation::json(
                            "entity",
                            "element-patch",
                            &patch,
                            "entity.trash",
                            json!({}),
                        )
                        .at_incarnation(patch_incarnation),
                    );
                }
            }
        }
        // Patches made from a purged chapter or drift keep their text but
        // lose the source, journaled rather than left to the foreign key.
        if target.table == "book_node" {
            for row in self.query(
                Some(tx),
                "SELECT id FROM element_patch WHERE project_id=? AND source_node_id=? ORDER BY id",
                vec![text(&context.project_id), text(id)],
            )? {
                let patch = string(&row, 0)?;
                self.execute(tx, "UPDATE element_patch SET source_node_id=NULL,updated_at=? WHERE id=? AND project_id=?",
                    vec![text(&context.now_iso), text(&patch), text(&context.project_id)])?;
                if let Some((patch_incarnation, "live")) = self
                    .lifecycle_of_kind(tx, context, "element-patch", &patch)?
                    .as_ref()
                    .map(|(i, s)| (*i, s.as_str()))
                {
                    mutations.push(journal::Mutation::field(
                        "element-patch",
                        &patch,
                        patch_incarnation,
                        "sourceNodeId",
                        Value::Null,
                    ));
                }
            }
        }
        let asset_ids: Vec<String> = if kind == "element" {
            self.query(Some(tx), "SELECT portrait_asset_id FROM element WHERE id=? AND project_id=? AND portrait_asset_id IS NOT NULL",
                vec![text(id), text(&context.project_id)])?
                .iter()
                .map(|row| string(row, 0))
                .collect::<Result<_, _>>()?
        } else {
            Vec::new()
        };
        let document_id = format!("{}:{id}", target.prefix);
        for table in [
            "yjs_prose_command_receipt",
            "yjs_document_revision_provenance",
            "yjs_document_revision",
            "yjs_updates",
            "yjs_snapshots",
        ] {
            self.execute(
                tx,
                &format!("DELETE FROM {table} WHERE document_id=?"),
                vec![text(&document_id)],
            )?;
        }
        self.execute(tx, "DELETE FROM entity_snapshot_history WHERE project_id=? AND entity_kind=? AND entity_id=?",
            vec![text(&context.project_id), text(target.history), text(id)])?;
        self.execute(
            tx,
            &format!("DELETE FROM {} WHERE id=? AND project_id=?", target.table),
            vec![text(id), text(&context.project_id)],
        )?;
        for asset in &asset_ids {
            self.execute(
                tx,
                "DELETE FROM project_asset WHERE id=? AND project_id=?",
                vec![text(asset), text(&context.project_id)],
            )?;
        }
        mutations.push(
            journal::Mutation::json("entity", target.lifecycle, id, "entity.purge", json!({}))
                .at_incarnation(incarnation),
        );
        Ok(PurgedEntity {
            kind: kind.into(),
            id: id.into(),
            document_id,
            asset_ids,
        })
    }
}
