//! Extension points for editors built on gpui-prose (Drifting's `dr-editor`
//! adds entity links, Markdown input rules, TODO markers and the selection
//! toolbar through these).
//!
//! v0 has one hook, styling marked runs. Hosts also see what happens through
//! [`crate::EditorEvent`] and can query marks at a position
//! ([`crate::ProseEditor::marks_at`]).

use crate::{render::RunStyle, style::ProseStyle, text::Marks};

pub trait ProseExtension: 'static {
    /// Adjusts how a run of marked text looks; `run` starts as gpui-prose's
    /// default look for `marks` (bold, italic, links, underline, strike).
    /// Entity links (`entity:<id>` keys) have no default look.
    fn style_run(&self, _marks: &Marks, _run: &mut RunStyle, _style: &ProseStyle) {}
}
