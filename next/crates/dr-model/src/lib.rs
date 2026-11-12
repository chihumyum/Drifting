//! Drifting's domain types, without Loro.
//!
//! - [`id`]: entity ids (uuidv7 strings, as in the old data) and document ids;
//! - [`kind`]: the string-valued enums the book document stores, all open
//!   (unknown values are kept);
//! - [`shared`] and [`v3`]: canonical domain records;
//! - [`prose`]: what paragraphs and runs of text carry;
//! - [`pos`]: fractional-index position keys for plain lists;
//! - [`origin`]: where a write came from;
//! - [`time`]: timestamps and calendar days;
//! - [`invariant`]: the active contracts and the tests that hold each one;
//! - [`check`]: the predicates the command layer runs before a write;
//! - [`import_v1`]: the 0.1 source format, for the source replay only: the
//!   per-kind ids, vocabularies and records of the old book model, and how
//!   retired 0.1.x values map onto the current schema. Product code may not
//!   import it (`cargo xtask check`, gate `v3-cutover`).
//!
//! `dr-doc` maps these onto Loro documents (`docs/rust-rewrite/loro-schema.md`);
//! commands (F3) validate against them. This crate depends on neither.

pub mod check;
pub mod conversation;
pub mod id;
pub mod import_v1;
pub mod invariant;
pub mod kind;
pub mod order;
pub mod origin;
pub mod pos;
pub mod prose;
pub mod shared;
pub mod time;
pub mod v3;

pub use id::{DocId, DocKind, ProseProfile};
pub use origin::Origin;
pub use time::{Day, Timestamp};
