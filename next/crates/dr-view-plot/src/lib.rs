//! dr-view-plot: the plot planner (情节规划, module M15), the 0.1 client's
//! `PlotGrid.tsx`, `PlotPlannerDock.tsx` and `plot-grid/*` (desktop).
//!
//! One grid per chapter or idea: each row a lane named on the left, each
//! column named along the top, each cell a slip of paper written straight
//! into. It lives in the panel under the paper, which it shares with the
//! bottom timeline (M14); the shell shows it for the chapter in front.
//!
//! - **The panel's header**: the chapter's mark and title, 「情节」, and text
//!   buttons 「＋ 行」 「＋ 列」 (a new row or column at the end, scrolled
//!   into view), 「适应」 (the cells sized so the table fills the panel) and
//!   「清空」 (every label and slip emptied after a question; rows, columns
//!   and size stay).
//! - **Headers**: a label written in place (Enter or Esc leaves it); the ⋯
//!   under the pointer opens 重命名, 上移 / 下移 (左移 / 右移), 在上方 /
//!   下方插入一行 (左侧 / 右侧一列) and 删除此行 / 此列 (with how many slips
//!   it clears; the last row or column stays).
//! - **Slips**: text as typed, new lines allowed; an empty slip shows its
//!   glass and 「写点什么…」 only under the pointer or the caret.
//! - **Size**: the grip on the table's corner sizes every cell by hand
//!   (120–440 × 56–380, a live readout while dragged); the table never
//!   squeezes, the overflowing axis scrolls.
//!
//! Everything goes through F3's `plot_grid.*` commands, in order, on a
//! background thread; typing is stored 400 ms after the last key or when
//! the field is left. A chapter without a grid shows an empty 3 × 3 one,
//! stored (`plot_grid.create`) by the first change. F3's events read the
//! grid again, so another window's or an Agent's changes show; a field
//! holding the caret keeps its text. docs/rust-rewrite/modules/m15-plot.md
//! has the rules and what the shell still needs to host it.

pub mod model;
mod planner;

pub use model::{CellSize, Grid, Line};
pub use planner::{ClearDialog, Field, PlannerHost, PlotPlanner, STORE_AFTER, Write};

use gpui::{AppContext as _, Entity, Window};

/// A planner for `host`'s grid (the shell makes one for the chapter in
/// front and drops it when another comes).
pub fn planner(host: PlannerHost, window: &mut Window, cx: &mut gpui::App) -> Entity<PlotPlanner> {
    cx.new(|cx| PlotPlanner::new(host, window, cx))
}
