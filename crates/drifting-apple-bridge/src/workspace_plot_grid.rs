//! The in-chapter plot planner (情节规划格) through the C ABI: read a node's
//! grid, or apply a batch of named operations in one original. Rows and
//! columns the host adds without an id get one here, returned in `created`.
use super::*;
use drifting_core::workspace::PlotGridOp;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PlotGridInput {
    SetSize {
        width: f64,
        height: f64,
    },
    AddRow {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        label: String,
        #[serde(default)]
        after: Option<String>,
    },
    SetRowLabel {
        row_id: String,
        label: String,
    },
    MoveRow {
        row_id: String,
        #[serde(default)]
        after: Option<String>,
    },
    RemoveRow {
        row_id: String,
    },
    AddColumn {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        label: String,
        #[serde(default)]
        after: Option<String>,
    },
    SetColumnLabel {
        column_id: String,
        label: String,
    },
    MoveColumn {
        column_id: String,
        #[serde(default)]
        after: Option<String>,
    },
    RemoveColumn {
        column_id: String,
    },
    SetCell {
        row_id: String,
        column_id: String,
        value: String,
    },
}

impl WorkspaceSession {
    pub(super) fn plot_grid(
        &mut self,
        project_id: &str,
        node_id: &str,
        ops: &[PlotGridInput],
    ) -> Result<Value, String> {
        let project = self.project(project_id)?;
        let store = WorkspaceStore::new(&self.gateway, CLIENT);
        if ops.is_empty() {
            return Ok(json!({"grid": store.plot_grid(project_id, node_id)?, "created": []}));
        }
        let mut created = Vec::new();
        let mut fresh = |id: &Option<String>, kind: &str| -> Result<String, String> {
            match id {
                Some(id) => Ok(id.clone()),
                None => {
                    let id = identifier(kind)?;
                    created.push(id.clone());
                    Ok(id)
                }
            }
        };
        let mut converted = Vec::with_capacity(ops.len());
        for op in ops {
            converted.push(match op {
                PlotGridInput::SetSize { width, height } => PlotGridOp::SetSize {
                    width: *width,
                    height: *height,
                },
                PlotGridInput::AddRow { id, label, after } => PlotGridOp::AddRow {
                    id: fresh(id, "plot-row")?,
                    label: label.clone(),
                    after: after.clone(),
                },
                PlotGridInput::SetRowLabel { row_id, label } => PlotGridOp::SetRowLabel {
                    row_id: row_id.clone(),
                    label: label.clone(),
                },
                PlotGridInput::MoveRow { row_id, after } => PlotGridOp::MoveRow {
                    row_id: row_id.clone(),
                    after: after.clone(),
                },
                PlotGridInput::RemoveRow { row_id } => PlotGridOp::RemoveRow {
                    row_id: row_id.clone(),
                },
                PlotGridInput::AddColumn { id, label, after } => PlotGridOp::AddColumn {
                    id: fresh(id, "plot-column")?,
                    label: label.clone(),
                    after: after.clone(),
                },
                PlotGridInput::SetColumnLabel { column_id, label } => PlotGridOp::SetColumnLabel {
                    column_id: column_id.clone(),
                    label: label.clone(),
                },
                PlotGridInput::MoveColumn { column_id, after } => PlotGridOp::MoveColumn {
                    column_id: column_id.clone(),
                    after: after.clone(),
                },
                PlotGridInput::RemoveColumn { column_id } => PlotGridOp::RemoveColumn {
                    column_id: column_id.clone(),
                },
                PlotGridInput::SetCell {
                    row_id,
                    column_id,
                    value,
                } => PlotGridOp::SetCell {
                    row_id: row_id.clone(),
                    column_id: column_id.clone(),
                    value: value.clone(),
                },
            });
        }
        let grid = store.apply_plot_grid(&self.context(&project)?, node_id, &converted)?;
        Ok(json!({"grid": grid, "created": created}))
    }
}
