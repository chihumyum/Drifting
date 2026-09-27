//! The story timeline and graph: narrative order, markers and card positions.
use super::elements::present;
use super::*;
use serde::Deserializer;

/// Absent stays `None`; an explicit `null` becomes `Some(None)`.
fn present_number<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<f64>>, D::Error> {
    Ok(Some(Option::<f64>::deserialize(deserializer)?))
}

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
    /// One drop on the graph: order and/or lane, atomically. Absent fields
    /// stay; `order: null` unplaces, `lane: null` removes every link.
    MoveChapter {
        chapter_id: String,
        #[serde(default, deserialize_with = "present_number")]
        order: Option<Option<f64>>,
        #[serde(default, deserialize_with = "present")]
        lane: Option<Option<String>>,
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
            TimelineCommand::MoveChapter {
                chapter_id,
                order,
                lane,
            } => json!(store.move_chapter_on_timeline(
                &self.context(&project)?,
                chapter_id,
                *order,
                lane.as_ref().map(|lane| lane.as_deref()),
            )?),
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
        let mut reply = json!({"result": result, "timeline": store.timeline(project_id)?});
        // A lane change rewrites memberships; the storyline library comes
        // with the reply so the host needs no second read.
        if matches!(command, TimelineCommand::MoveChapter { lane: Some(_), .. }) {
            reply["storylines"] = json!({
                "storylines": store.storylines(project_id)?,
                "trashedStorylines": store.trashed_storylines(project_id)?,
                "memberships": store.chapter_memberships(project_id)?,
            });
        }
        Ok(reply)
    }
}
