//! F4d — rendering: marks to text runs, the paragraph element, painting with
//! decorations, the painted-frame record, the caret layer, and the editor's
//! list items.
//!
//! Extensions draw through [`crate::ProseExtension::style_run`] for marked
//! text. Everything a host draws over prose without changing it goes through
//! the paint layers ([`decor`]): under the words (comment sand, find hits),
//! over the words (dry underlines, suggested links) and the words' own ink
//! (Agent changes), moved with every edit and eased in and out. Block styles
//! (quote, indent, alignment, rule) come from the paragraph attributes
//! ([`blocks`]); immersive writing's paragraph focus and the scrollbar ticks
//! live here too; an editor inside a page that scrolls lays out its items
//! with [`flow`]. See `docs/rust-rewrite/foundations/f4d-render.md`.

pub mod blocks;
pub mod cursor;
pub mod decor;
pub mod element;
pub mod flow;
pub mod frame;
mod items;
pub mod motion;
pub mod paint;
pub mod runs;
pub mod sand;
pub mod state;
pub mod ticks;

#[cfg(test)]
mod flow_tests;
#[cfg(test)]
mod tests;

pub use blocks::{Align, BlockLook, BlockStyle, ListItem, ListMark};
pub use cursor::CursorLayer;
pub use decor::{
    Brush, Decoration, DecorationEvent, DecorationKey, Emphasis, Look, Strength, Tick, TickLane,
    Touch, Underline, Wash,
};
pub use element::ParagraphElement;
pub use flow::{FLOW_OVERDRAW, FlowItems, FlowState, PageScroll};
pub use frame::{CompSpan, FrameCache, PaintedDecoration, PaintedLine};
pub use paint::{TextPaint, paint_layout, paint_text};
pub use runs::{RunStyle, line_runs, splice_composition};
pub use sand::SandTexture;
pub use state::{FOCUS_DIM, PaintState};
