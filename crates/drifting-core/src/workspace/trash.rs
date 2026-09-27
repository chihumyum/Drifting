//! Recoverable local chapter lifecycle commands. Body, comment and placement
//! rows survive trash. Restoring reauthors the same body in the next incarnation.
use super::*;

#[cfg(test)]
mod tests;

#[derive(PartialEq)]
struct TrashChapter {
    chapter: WorkspaceChapter,
    incarnation: u64,
    seed: Value,
    position: Value,
}

impl WorkspaceStore<'_> {
    pub fn list_trashed_chapters(&self, project_id: &str) -> Result<Vec<WorkspaceChapter>, String> {
        self.query(None, r#"
            SELECT n.id,n.project_id,n.title,n.book_order,n.writing_status,n.created_at,n.updated_at
            FROM book_node n JOIN sync_generation g ON g.project_id=n.project_id AND g.status='active'
            JOIN sync_entity_lifecycle l ON l.sync_generation_id=g.sync_generation_id
                AND l.entity_kind='node' AND l.entity_id=n.id AND l.state='trashed'
            LEFT JOIN sync_entity_lifecycle p ON p.sync_generation_id=g.sync_generation_id
                AND p.entity_kind='project' AND p.entity_id=n.project_id
            WHERE n.project_id=? AND n.kind='chapter' AND n.deleted_at IS NOT NULL
                AND (p.state IS NULL OR p.state='live') AND NOT EXISTS (
                    SELECT 1 FROM sync_generation_purge x WHERE x.sync_generation_id=g.sync_generation_id
                )
            ORDER BY n.deleted_at DESC,n.book_order,n.id COLLATE BINARY
        "#, vec![text(project_id)])?.iter().map(chapter_from_row).collect()
    }

    pub fn trash_chapter(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
    ) -> Result<WorkspaceChapter, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let mut current = self.trash_candidate(tx, context, chapter_id, false)?;
            let mut mutations = self.purge_relations(tx, context, "node", chapter_id)?;
            self.execute(
                tx,
                "UPDATE book_node SET deleted_at=?,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&context.now_iso),
                    text(&context.now_iso),
                    text(chapter_id),
                    text(&context.project_id),
                ],
            )?;
            mutations.push(
                journal::Mutation::json("entity", "node", chapter_id, "entity.trash", json!({}))
                    .at_incarnation(current.incarnation),
            );
            self.commit_changes(tx, context, &mutations, None)?;
            current.chapter.updated_at = context.now_iso.clone();
            Ok(current.chapter)
        })
    }

    /// The trusted prose adapter reconstructs and validates snapshot + ordered
    /// tail in this transaction. It must return the complete state, never the
    /// cache alone. The callback runs before lifecycle/domain writes.
    pub fn restore_chapter<F>(
        &self,
        context: &AuthoredProseContext,
        chapter_id: &str,
        mut capture_full_state: F,
    ) -> Result<WorkspaceChapter, String>
    where
        F: FnMut(&ProseRepository<'_>, u64, &str) -> Result<ChapterSeed, String>,
    {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let mut current = self.trash_candidate(tx, context, chapter_id, true)?;
            let incarnation = current
                .incarnation
                .checked_add(1)
                .filter(|value| *value <= MAX_SAFE)
                .ok_or("Chapter incarnation overflow")?;
            let repo = ProseRepository::new(self.gateway, self.client);
            let doc_id = &current.chapter.document_id;
            let revision = repo.get_revision(doc_id, Some(tx))?;
            let state = capture_full_state(&repo, tx, doc_id)?;
            let cache: Value = serde_json::from_str(&state.content_json)
                .map_err(|error| format!("Invalid restored prose projection: {error}"))?;
            if state.update.is_empty()
                || cache.get("type").and_then(Value::as_str) != Some("doc")
                || cache.get("content").and_then(Value::as_array).is_none()
            {
                return Err(
                    "Restore requires a complete prose state and document projection".into(),
                );
            }
            self.guard_project(tx, context)?;
            if self.trash_candidate(tx, context, chapter_id, true)? != current {
                return Err("Chapter changed while capturing restored prose".into());
            }
            self.execute(
                tx,
                "UPDATE book_node SET deleted_at=NULL,updated_at=? WHERE id=? AND project_id=?",
                vec![
                    text(&context.now_iso),
                    text(chapter_id),
                    text(&context.project_id),
                ],
            )?;
            let appended = repo.append_update(
                doc_id,
                &state.update,
                &RevisionSource::System,
                &context.now_iso,
                Some(revision),
                Some(tx),
            )?;
            // Match the renderer's authored restore order and owner incarnation:
            // restore, graph position, the chapter's memberships re-added in
            // this incarnation with its primary, then the full body state.
            let mut mutations = vec![
                journal::Mutation::json(
                    "entity",
                    "node",
                    chapter_id,
                    "entity.restore",
                    json!({"seed":current.seed}),
                )
                .at_incarnation(incarnation),
                journal::Mutation::json(
                    "entity",
                    "node",
                    chapter_id,
                    "tuple.set",
                    json!({"tuple":"graph.position","value":current.position}),
                )
                .at_incarnation(incarnation),
            ];
            self.membership_projection(
                tx,
                context,
                chapter_id,
                true,
                Some(incarnation),
                &mut mutations,
            )?;
            let seed = mutations.len();
            mutations
                .push(journal::Mutation::yjs(doc_id, &state.update).at_incarnation(incarnation));
            self.commit_changes(
                tx,
                context,
                &mutations,
                Some((seed, &appended, &state.update)),
            )?;
            current.chapter.updated_at = context.now_iso.clone();
            Ok(current.chapter)
        })
    }

    fn trash_candidate(
        &self,
        tx: u64,
        context: &AuthoredProseContext,
        chapter_id: &str,
        trashed: bool,
    ) -> Result<TrashChapter, String> {
        if !opaque(chapter_id) {
            return Err("Invalid chapter identity".into());
        }
        let rows = self.query(Some(tx), r#"
            SELECT n.id,n.project_id,n.title,n.book_order,n.writing_status,n.created_at,n.updated_at,
                n.summary,n.narrative_order,n.drift_group_id,n.position_x,n.position_y,n.deleted_at,
                l.incarnation,l.state
            FROM book_node n JOIN sync_entity_lifecycle l ON l.sync_generation_id=?
                AND l.entity_kind='node' AND l.entity_id=n.id
            WHERE n.id=? AND n.project_id=? AND n.kind='chapter'
        "#, vec![text(&context.sync_generation_id), text(chapter_id), text(&context.project_id)])?;
        let row = rows
            .first()
            .ok_or("Chapter lifecycle is not available in this project")?;
        let expected = if trashed { "trashed" } else { "live" };
        let deleted = match &row[12] {
            V::Null => false,
            V::Text(value) if !value.is_empty() => true,
            _ => return Err("Invalid chapter trash timestamp".into()),
        };
        if deleted != trashed || string(row, 14)? != expected {
            return Err(format!("Chapter lifecycle must be {expected}"));
        }
        let incarnation = match &row[13] {
            V::Integer(value) => value.parse::<u64>().ok().filter(|value| *value <= MAX_SAFE),
            _ => None,
        }
        .ok_or("Invalid chapter incarnation")?;
        let chapter = chapter_from_row(row)?;
        let narrative_order = if row[8] == V::Null {
            Value::Null
        } else {
            json!(number(row, 8)?)
        };
        let drift_group_id = match &row[9] {
            V::Null => Value::Null,
            V::Text(value) => json!(value),
            _ => return Err("Invalid chapter drift group".into()),
        };
        Ok(TrashChapter {
            incarnation,
            seed: json!({"title":chapter.title,"summary":string(row, 7)?,"bookOrder":chapter.book_order,
                "narrativeOrder":narrative_order,"writingStatus":chapter.writing_status,
                "kind":"chapter","driftGroupId":drift_group_id}),
            position: json!({"x":number(row, 10)?,"y":number(row, 11)?}),
            chapter,
        })
    }
}
