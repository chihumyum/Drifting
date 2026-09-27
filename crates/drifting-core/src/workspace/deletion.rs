//! Project deletion: one terminal `sync-generation.purge` original, then every
//! row the project owns. The FK tree removes ordinary entities, assets'
//! metadata and Agent rows; Yjs state and version history have no project
//! key and are removed by their document ids. The journal and its receipts
//! survive, detached from the deleted project.
use super::*;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeletion {
    pub project_id: String,
    /// App-owned asset directories whose bytes may now be removed.
    pub asset_ids: Vec<String>,
    pub document_ids: Vec<String>,
}

impl WorkspaceStore<'_> {
    pub fn delete_project(
        &self,
        context: &AuthoredProseContext,
    ) -> Result<ProjectDeletion, String> {
        validate_context(context)?;
        self.transaction(TransactionBehavior::Immediate, |tx| {
            self.guard_project(tx, context)?;
            let project = text(&context.project_id);
            let mut documents = std::collections::BTreeSet::new();
            for (sql, prefix) in [
                ("SELECT id FROM book_node WHERE project_id=?", "node-content"),
                ("SELECT id FROM element WHERE project_id=?", "element"),
                ("SELECT id FROM storylines WHERE project_id=?", "storyline"),
                ("SELECT id FROM element_category WHERE project_id=?", "category"),
            ] {
                for row in self.query(Some(tx), sql, vec![project.clone()])? {
                    documents.insert(format!("{prefix}:{}", string(&row, 0)?));
                }
            }
            // History outlives hard-deleted bodies and proves their documents.
            for row in self.query(Some(tx), "SELECT DISTINCT entity_kind,entity_id FROM entity_snapshot_history WHERE project_id=?",
                vec![project.clone()])? {
                let prefix = match string(&row, 0)?.as_str() {
                    "node" => "node-content",
                    "element" => "element",
                    "storyline" => "storyline",
                    "category" => "category",
                    _ => continue,
                };
                documents.insert(format!("{prefix}:{}", string(&row, 1)?));
            }
            let asset_ids = self
                .query(Some(tx), "SELECT id FROM project_asset WHERE project_id=? ORDER BY id", vec![project.clone()])?
                .iter()
                .map(|row| string(row, 0))
                .collect::<Result<Vec<_>, _>>()?;
            let generation = self.query(Some(tx), "SELECT generation_number FROM sync_generation WHERE sync_generation_id=?",
                vec![text(&context.sync_generation_id)])?;
            let number = match generation.first().map(|row| &row[0]) {
                Some(V::Integer(value)) => value.parse::<u64>().map_err(|_| "Invalid generation number")?,
                _ => return Err("Project generation is missing".into()),
            };
            self.commit_changes(tx, context, &[journal::Mutation::json(
                "sync-generation",
                "sync-generation",
                &context.sync_generation_id,
                "sync-generation.purge",
                json!({}),
            )
            .at_incarnation(number)], None)?;
            self.execute(tx, "DELETE FROM entity_snapshot_history WHERE project_id=?", vec![project.clone()])?;
            for document in &documents {
                for table in [
                    "yjs_prose_command_receipt",
                    "yjs_document_revision_provenance",
                    "yjs_document_revision",
                    "yjs_updates",
                    "yjs_snapshots",
                ] {
                    self.execute(tx, &format!("DELETE FROM {table} WHERE document_id=?"), vec![text(document)])?;
                }
            }
            self.execute(tx, "DELETE FROM project WHERE id=?", vec![project])?;
            Ok(ProjectDeletion {
                project_id: context.project_id.clone(),
                asset_ids,
                document_ids: documents.into_iter().collect(),
            })
        })
    }
}
