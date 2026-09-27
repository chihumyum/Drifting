//! The story timeline and graph: narrative order, markers and card positions.
use super::elements::present;
use super::*;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TimelineCommand {
    Timeline,
    SetNarrativeOrder {
        chapter_id: String,
        order: Option<f64>,
    },
    SetPosition {
        node_id: String,
        x: f64,
        y: f64,
    },
    CreateMarker {
        narrative_order: f64,
        label: String,
        drift_id: Option<String>,
    },
    UpdateMarker {
        marker_id: String,
        narrative_order: Option<f64>,
        label: Option<String>,
        /// Absent keeps the binding; `null` unbinds the drift.
        #[serde(default, deserialize_with = "present")]
        drift_id: Option<Option<String>>,
    },
    DeleteMarker {
        marker_id: String,
    },
}

impl WorkspaceSession {
    pub(super) fn timeline(
        &mut self,
        project_id: &str,
        command: &TimelineCommand,
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        let result = match command {
            TimelineCommand::Timeline => Value::Null,
            TimelineCommand::SetNarrativeOrder { chapter_id, order } => {
                json!(store.set_narrative_order(&self.context(&project)?, chapter_id, *order)?)
            }
            TimelineCommand::SetPosition { node_id, x, y } => {
                json!(store.set_node_position(&self.context(&project)?, node_id, *x, *y)?)
            }
            TimelineCommand::CreateMarker {
                narrative_order,
                label,
                drift_id,
            } => json!(store.create_marker(
                &self.context(&project)?,
                &identifier("marker")?,
                *narrative_order,
                label,
                drift_id.as_deref(),
            )?),
            TimelineCommand::UpdateMarker {
                marker_id,
                narrative_order,
                label,
                drift_id,
            } => json!(store.update_marker(
                &self.context(&project)?,
                marker_id,
                *narrative_order,
                label.as_deref(),
                drift_id.as_ref().map(|d| d.as_deref()),
            )?),
            TimelineCommand::DeleteMarker { marker_id } => {
                store.delete_marker(&self.context(&project)?, marker_id)?;
                Value::Null
            }
        };
        Ok(json!({"result": result, "timeline": store.timeline(project_id)?}))
    }
}
