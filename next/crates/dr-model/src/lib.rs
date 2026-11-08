//! Drifting's domain types, without Loro.
//!
//! - [`id`]: entity ids (uuidv7 strings, as in the old data) and document ids;
//! - [`kind`]: the string-valued enums the book document stores, all open
//!   (unknown values are kept);
//! - [`book`]: one record type per collection of the book document;
//! - [`prose`]: what paragraphs and runs of text carry;
//! - [`order`]: book order, narrative order and acts (real coordinates);
//! - [`pos`]: fractional-index position keys for plain lists;
//! - [`origin`]: where a write came from;
//! - [`time`]: timestamps and calendar days;
//! - [`invariant`]: the invariant checklist and how each one holds;
//! - [`check`]: the predicates the command layer runs before a write;
//! - [`legacy`]: how retired 0.1.x values map onto the current schema (import).
//!
//! `dr-doc` maps these onto Loro documents (`docs/rust-rewrite/loro-schema.md`);
//! commands (F3) validate against them. This crate depends on neither.

pub mod book;
pub mod check;
pub mod conversation;
pub mod id;
pub mod invariant;
pub mod kind;
pub mod legacy;
pub mod order;
pub mod origin;
pub mod pos;
pub mod prose;
pub mod time;

pub use id::{DocId, DocKind, ProseProfile};
pub use origin::Origin;
pub use time::{Day, Timestamp};
