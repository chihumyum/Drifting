//! F4d — rendering: marks to text runs, the paragraph element, painting with
//! decorations, the painted-frame record, the caret layer, and the editor's
//! list items.
//!
//! Extensions draw through [`crate::ProseExtension::style_run`] for marked
//! text. Paint layers under and over the text (Drifting's sand-pencil comment
//! marks, search highlights) are the next F4d milestone.

pub mod cursor;
pub mod element;
pub mod frame;
mod items;
pub mod paint;
pub mod runs;

pub use cursor::CursorLayer;
pub use element::ParagraphElement;
pub use frame::{CompSpan, FrameCache, PaintedLine};
pub use runs::{RunStyle, line_runs, splice_composition};
