//! Drifting's Loro documents, typed (`docs/rust-rewrite/loro-schema.md`).
//!
//! The only way modules read and write books and prose. Three kinds of
//! document:
//!
//! - the **book document** ([`book::BookDoc`]), one per book: every entity's
//!   metadata, orders, trees, anchors, facts, memory and writing days;
//! - **prose documents** ([`prose::ProseDoc`]), one per body: a chapter, an
//!   idea, an element body, a storyline or category description, a material
//!   note;
//! - append-only **conversation documents** ([`conversation::ConversationDoc`]),
//!   one per Agent conversation, projected from its durable runtime journal.
//!
//! Both start from a deterministic genesis change, are written by exactly one
//! writer through typed transactions that commit with an [`dr_model::Origin`],
//! hand every commit back as a [`Committed`] for storage, and expose
//! read-only views and readers that never copy a whole body to answer a
//! question about part of it. No raw `LoroDoc` leaves this crate.
//!
//! Positions are Unicode scalars (Loro's unit); [`pos::TextPos`] converts to
//! and from GPUI's UTF-8 bytes and the input method's UTF-16.
//!
//! Storage (F2) persists the bytes; commands (F3) build on the transactions;
//! the editor (F4) reads views and subscribes to [`prose::ProseEvent`]s.

pub mod anchor;
pub mod book;
pub mod conversation;
mod core;
pub mod error;
pub mod peer;
pub mod pos;
pub mod prose;
pub mod schema;
pub mod undo;

pub use crate::core::{Committed, Imported};
pub use anchor::{Anchor, AnchorCache, Resolved};
pub use error::{DocError, Result};
pub use pos::{PosError, TextPos, Unit};

/// Loro types that appear in this crate's API (versions, subscriptions,
/// cursors), re-exported so dependants use the same pinned Loro.
pub mod loro_types {
    pub use loro::cursor::{Cursor, Side};
    pub use loro::{Frontiers, Subscription, UndoManager, VersionVector};
}
