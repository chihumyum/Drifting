//! Project details (summary, facts, storyline template) and chapter or drift
//! metadata (summary, writing status). Domain writes live in drifting-core.
use super::*;
use drifting_core::workspace::{Fact, ProjectChanges};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MetadataCommand {
    Project,
    UpdateProject {
        summary: Option<String>,
        facts: Option<Vec<Fact>>,
        storyline_template: Option<Vec<Fact>>,
    },
    Node {
        node_id: String,
    },
    /// Every live chapter and drift in one read.
    Nodes,
    SetNodeSummary {
        node_id: String,
        summary: String,
    },
    SetNodeStatus {
        node_id: String,
        status: String,
    },
}

impl WorkspaceSession {
    pub(super) fn metadata(
        &mut self,
        project_id: &str,
        command: &MetadataCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        Ok(json!({"result": match command {
            MetadataCommand::Project => json!(store.project_details(project_id)?),
            MetadataCommand::UpdateProject { summary, facts, storyline_template } => json!(store.update_project(
                &self.context(&project)?,
                ProjectChanges {
                    summary: summary.clone(),
                    facts: facts.clone(),
                    storyline_template: storyline_template.clone(),
                },
                &mut || identifier("fact"),
            )?),
            MetadataCommand::Node { node_id } => json!(store.node_metadata(project_id, node_id)?),
            MetadataCommand::Nodes => json!(store.nodes_metadata(project_id)?),
            MetadataCommand::SetNodeSummary { node_id, summary } =>
                json!(store.set_node_summary(&self.context(&project)?, node_id, summary)?),
            MetadataCommand::SetNodeStatus { node_id, status } =>
                json!(store.set_node_status(&self.context(&project)?, node_id, status)?),
        }}))
    }
}
