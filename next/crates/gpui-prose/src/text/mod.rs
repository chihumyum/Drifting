//! F4a — text storage and indexing: one body text as a Loro document, the
//! paragraph mirror the editor lays out from, the write rules for paragraphs
//! and block ids, inline marks, the author's undo history, anchors, and
//! grapheme / word boundaries.
//!
//! Nothing here depends on layout or input; this layer can be used (and is
//! tested) without a window.

pub mod anchor;
pub mod blocks;
pub mod doc;
pub mod marks;
pub mod mirror;
pub mod segment;
pub mod undo;
pub mod units;

pub use anchor::{Anchor, AnchorChange, AnchorId, AnchorSet, Resolved};
pub use blocks::{BlockAttrs, BlockKind};
pub use doc::{MarkOverride, ORIGIN_AGENT_PREFIX, ORIGIN_REPAIR, ORIGIN_USER, ProseDoc};
pub use marks::{Marks, Span};
pub use mirror::{ChangeSet, Line, LineSplice, TextOp};
pub use undo::UndoConfig;

#[cfg(test)]
mod tests;
