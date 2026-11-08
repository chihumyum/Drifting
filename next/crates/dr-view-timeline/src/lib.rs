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
//! - [`kept`]: what it keeps for each book on this device (the order, 未归属,
//!   the zoom, the scroll), in the shell's per-book memory.
//!
//! [`init`] puts it in the shell's Bottom Panel under the paper (F6): the
//! shell keeps the panel, its height and ⌘J. The act rail's dragging, time
//! pins, the spring of a dragged slab, hover cards and 打散 are later
//! milestones.

pub mod kept;
pub mod model;
pub mod spring;
pub mod view;

use dr_shell::Workspace;
use dr_shell::pages::{self, BottomPane, BottomPanel};
use gpui::{App, AppContext as _, Entity, WeakEntity};

pub use view::{BottomTimeline, ClipDrag, DropAt, Mark, MarkDrag, default_act_name};

/// The timeline for the window of `ws`.
pub fn make(ws: WeakEntity<Workspace>, cx: &mut App) -> Entity<BottomTimeline> {
    cx.new(|cx| BottomTimeline::new(ws, cx))
}

/// Registers the timeline as the shell's Bottom Panel's timeline pane (one
/// per window and book; dragged no lower than its lanes need). Once, after
/// `dr_shell::init`.
pub fn init(cx: &mut App) {
    pages::add_bottom_panel(cx, BottomPane::Timeline, |host, _, cx| {
        let timeline = make(host.workspace.clone(), cx);
        let lanes = timeline.downgrade();
        Some(BottomPanel::new(timeline).min_height(move |cx| {
            lanes
                .upgrade()
                .map_or(0.0, |timeline| timeline.read(cx).min_height())
        }))
    });
}
