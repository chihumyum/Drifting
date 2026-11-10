//! Presentation DTOs for the v3 plot module.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub const DEFAULT_CELL: (f64, f64) = dr_model::shared::PLOT_DEFAULT_CELL;
pub const DEFAULT_LINES: usize = dr_model::shared::PLOT_DEFAULT_LINES;
/// Rows or columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    Row,
    Column,
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct LineInfo {
    pub id: String,
    pub label: String,
    pub pos: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct CellInfo {
    pub row: String,
    pub column: String,
    pub text: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct PlotGridInfo {
    pub node: String,
    /// Whether the grid is stored; when not, the rest is the empty 3 × 3
    /// grid to show, with the ids it will be stored with (any edit, or
    /// `plot_grid.create`, stores it).
    pub exists: bool,
    pub cell_w: f64,
    pub cell_h: f64,
    pub rows: Vec<LineInfo>,
    pub columns: Vec<LineInfo>,
    /// Non-empty cells only.
    pub cells: Vec<CellInfo>,
}
