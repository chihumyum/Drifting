//! A sanitized diagnostic summary: counts, sizes and an integrity check,
//! never titles, ids, prose or paths, so an author can share it safely.
use super::*;

fn count(store: &WorkspaceStore<'_>, sql: &str, values: Vec<V>) -> Result<u64, String> {
    match store.query(None, sql, values)?.first().map(|row| &row[0]) {
        Some(V::Integer(value)) => value.parse().map_err(|_| "Invalid count".to_string()),
        Some(V::Null) | None => Ok(0),
        _ => Err("Invalid count".into()),
    }
}

impl WorkspaceStore<'_> {
    pub fn diagnostics(&self, user_id: &str) -> Result<Value, String> {
        let integrity: Vec<String> = self
            .query(None, "PRAGMA quick_check", vec![])?
            .iter()
            .filter_map(|row| match &row[0] {
                V::Text(value) => Some(value.clone()),
                _ => None,
            })
            .collect();
        let mut projects = Vec::new();
        for project in self.list_projects(user_id)? {
            let p = || vec![text(&project.id)];
            let words: u64 = self
                .node_word_counts(&project.id)?
                .iter()
                .filter(|node| node.kind == "chapter")
                .filter_map(|node| node.word_count)
                .sum();
            projects.push(json!({
                "chapters": count(self, "SELECT COUNT(*) FROM book_node WHERE project_id=? AND kind='chapter' AND deleted_at IS NULL", p())?,
                "drifts": count(self, "SELECT COUNT(*) FROM book_node WHERE project_id=? AND kind='drift' AND deleted_at IS NULL", p())?,
                "trashed": count(self, "SELECT (SELECT COUNT(*) FROM book_node WHERE project_id=?1 AND deleted_at IS NOT NULL)
                    + (SELECT COUNT(*) FROM element WHERE project_id=?1 AND deleted_at IS NOT NULL)
                    + (SELECT COUNT(*) FROM element_category WHERE project_id=?1 AND deleted_at IS NOT NULL)
                    + (SELECT COUNT(*) FROM storylines WHERE project_id=?1 AND deleted_at IS NOT NULL)", p())?,
                "acts": count(self, "SELECT COUNT(*) FROM book_act WHERE project_id=?", p())?,
                "elements": count(self, "SELECT COUNT(*) FROM element WHERE project_id=? AND deleted_at IS NULL", p())?,
                "categories": count(self, "SELECT COUNT(*) FROM element_category WHERE project_id=? AND deleted_at IS NULL", p())?,
                "storylines": count(self, "SELECT COUNT(*) FROM storylines WHERE project_id=? AND deleted_at IS NULL", p())?,
                "relations": count(self, "SELECT COUNT(*) FROM entity_relation WHERE project_id=?", p())?,
                "comments": count(self, "SELECT COUNT(*) FROM comment WHERE project_id=?", p())?,
                "patches": count(self, "SELECT COUNT(*) FROM element_patch WHERE project_id=?", p())?,
                "libraryItems": count(self, "SELECT COUNT(*) FROM library_item WHERE project_id=?", p())?,
                "assets": count(self, "SELECT COUNT(*) FROM project_asset WHERE project_id=?", p())?,
                "assetBytes": count(self, "SELECT COALESCE(SUM(source_size_bytes),0) FROM project_asset WHERE project_id=?", p())?,
                "historyVersions": count(self, "SELECT COUNT(*) FROM entity_snapshot_history WHERE project_id=?", p())?,
                "chapterWords": words,
            }));
        }
        Ok(json!({
            "format": "drifting.native-diagnostics",
            "formatVersion": 1,
            "database": {
                "migrations": count(self, "SELECT COUNT(*) FROM __drizzle_migrations", vec![])?,
                "pageSize": count(self, "PRAGMA page_size", vec![])?,
                "pageCount": count(self, "PRAGMA page_count", vec![])?,
                "freePages": count(self, "PRAGMA freelist_count", vec![])?,
                "integrity": if integrity == ["ok"] { "ok" } else { "problems" },
                "integrityProblems": if integrity == ["ok"] { 0 } else { integrity.len() },
            },
            "journal": {
                "changeSets": count(self, "SELECT COUNT(*) FROM sync_change_set", vec![])?,
                "local": count(self, "SELECT COUNT(*) FROM sync_change_set WHERE origin='local'", vec![])?,
                "remote": count(self, "SELECT COUNT(*) FROM sync_change_set WHERE origin='remote'", vec![])?,
                "notApplied": count(self, "SELECT COUNT(*) FROM sync_change_set WHERE apply_state!='applied'", vec![])?,
                "purgedGenerations": count(self, "SELECT COUNT(*) FROM sync_generation_purge", vec![])?,
            },
            "prose": {
                "documents": count(self, "SELECT COUNT(*) FROM yjs_document_revision", vec![])?,
                "updates": count(self, "SELECT COUNT(*) FROM yjs_updates", vec![])?,
                "snapshots": count(self, "SELECT COUNT(*) FROM yjs_snapshots", vec![])?,
            },
            "projects": projects,
        }))
    }
}
