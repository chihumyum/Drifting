//! F4a — text storage and indexing: the text source the editor reads and
//! writes through ([`ProseSource`], with the built-in [`LoroSource`]), the
//! paragraph mirror and SumTree index fed by its events, the write rules for
//! paragraphs and block ids, inline marks, the author's undo steps, anchors,
//! and grapheme / word boundaries.
//!
//! Nothing here depends on layout or input; this layer can be used (and is
//! tested) without a window.

pub mod anchor;
pub mod blocks;
#[cfg(any(test, feature = "conformance"))]
pub mod conformance;
pub mod doc;
pub mod index;
pub mod loro_source;
pub mod marks;
pub mod mirror;
pub mod segment;
pub mod source;
pub mod undo;
pub mod units;

pub use anchor::{Anchor, AnchorChange, AnchorId, AnchorSet, Resolved};
pub use blocks::{BlockAttrs, BlockKind};
pub use doc::{ORIGIN_AGENT_PREFIX, ORIGIN_USER, ProseDoc};
pub use index::{ParagraphExtent, ParagraphIndex};
pub use loro_source::{LoroSource, ORIGIN_REPAIR, change_of, read_paragraphs};
pub use marks::{Marks, Span};
pub use mirror::{ChangeSet, Line, LineSplice, TextOp};
pub use source::{
    Edit, EditResult, MarkOverride, ProseSource, SourceChange, SourceEvent, SourceParagraph,
};
pub use undo::UndoConfig;

#[cfg(test)]
mod drdoc_style;
#[cfg(test)]
mod tests;
