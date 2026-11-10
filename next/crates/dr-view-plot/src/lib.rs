//! Canonical v3 plot-grid module and shared grid presentation.
pub mod model;
mod planner;
pub mod v3;

pub use model::{CellSize, Grid, Line};
pub use planner::{
    ClearDialog, Field, PlannerHost, PlotPlanner, RATIO_SCOPE, STORE_AFTER, Write, ratio_key,
};

pub fn init(cx: &mut gpui::App) {
    v3::register(cx);
}
