//! dr-view-timeline: the bottom timeline (module M14).
//!
//! The storylines as lanes under the paper, in reading order (书序) or in
//! the story's own time (叙事时), as the 0.1 client's
//! `DesktopBottomTimeline` drew them: each chapter a slab of glass on the
//! lane of its main storyline, dashed curves where a storyline's chapters
//! sit on other lanes, act boundaries down every track. A chapter dragged
//! onto another lane changes its main storyline and lands where it is let
//! go; a double click on an empty spot makes a chapter there.
//!
//! - [`model`]: lanes, the axis, links and what a drop changes (no GPUI).
//! - [`view`]: [`BottomTimeline`], the view.
//!
//! The shell has no Bottom Panel yet; [`make`] gives the view for the place
//! F6 will open under the paper (docs/rust-rewrite/modules/m14-timeline.md,
//! 「待协调」). The act rail's dragging, time pins, the spring of a dragged
//! slab, hover cards and 打散 are later milestones.

pub mod model;
pub mod view;

use dr_shell::Workspace;
use gpui::{App, AppContext as _, Entity, WeakEntity};

pub use view::{BottomTimeline, ClipDrag, DropAt};

/// The timeline for the window of `ws`.
pub fn make(ws: WeakEntity<Workspace>, cx: &mut App) -> Entity<BottomTimeline> {
    cx.new(|cx| BottomTimeline::new(ws, cx))
}
