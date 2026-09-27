//! Derived prose projections and word counts of chapters and drifts. Saving a
//! node body materializes its projection; `reconcile` covers every live node,
//! as the renderer does when a project opens.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MetricsCommand {
    Counts,
    Reconcile,
}

impl WorkspaceSession {
    pub(super) fn metrics(
        &mut self,
        project_id: &str,
        command: &MetricsCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let failures = match command {
            MetricsCommand::Counts => Vec::new(),
            MetricsCommand::Reconcile => drifting_prose::workspace::reconcile_node_projections(
                &self.gateway,
                CLIENT,
                project_id,
                &self.context(&project)?.now_iso,
            )?,
        };
        Ok(json!({
            "counts": WorkspaceStore::new(&self.gateway, CLIENT).node_word_counts(project_id)?,
            "failures": failures
                .into_iter()
                .map(|(node_id, error)| json!({"nodeId": node_id, "error": error}))
                .collect::<Vec<_>>(),
        }))
    }
}
