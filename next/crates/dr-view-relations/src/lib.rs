//! The relation graph's legend (shared by the canvases that draw
//! relations) and the right sidebar's 「关系」 (RL, `kernel-v5.md` §19).
pub mod legend;
mod look;
pub mod rail;
mod rail_view;

pub use rail::RelationsRail;
pub use rail_view::RailHead;

/// Registers the right sidebar's 「关系」 with the shell.
pub fn init(cx: &mut gpui::App) {
    dr_shell::pages::set_relations(cx, rail::make);
}
