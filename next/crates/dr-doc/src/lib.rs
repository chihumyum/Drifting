//! Drifting's Loro documents, typed (`docs/rust-rewrite/loro-schema.md`).
//!
//! The only way modules read and write books and prose. Three kinds of
//! document:
//!
//! - the **book document** ([`v3::BookDocV3`]), one per book: the entry
//!   tree, templates, memberships, timeline views, relations, comments,
//!   materials, facts, memory and writing days (`kernel-v3.md`);
//! - **prose documents** ([`prose::ProseDoc`]), one per body: a prose module
//!   of an entry, a level's description, a template's prose module, a
//!   material note;
//! - append-only **conversation documents** ([`conversation::ConversationDoc`]),
//!   one per Agent conversation, projected from its durable runtime journal.
//!
//! All three start from a deterministic genesis change, are written by
//! exactly one writer through typed transactions that commit with an
//! [`dr_model::Origin`], hand every commit back as a [`Committed`] for
//! storage, and expose read-only views and readers that never copy a whole
//! body to answer a question about part of it. No raw `LoroDoc` leaves this
//! crate.
//!
//! [`catalog`] holds the codecs and record operations the book document
//! shares with the source replay. [`import_v1`] is that replay: the 0.1 book
//! model, built in memory by the importer and the source fixtures only. It
//! is not an App runtime, and product code may not import it (`cargo xtask
//! check`, gate `v3-cutover`).
//!
//! Positions are Unicode scalars (Loro's unit); [`pos::TextPos`] converts to
//! and from GPUI's UTF-8 bytes and the input method's UTF-16.
//!
//! Storage (F2) persists the bytes; commands (F3) build on the transactions;
//! the editor (F4) reads views and subscribes to [`prose::ProseEvent`]s.

pub mod anchor;
pub mod catalog;
pub mod conversation;
mod core;
pub mod error;
pub mod import_v1;
pub mod peer;
pub mod pos;
pub mod prose;
pub mod schema;
pub mod undo;
pub mod v3;

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
