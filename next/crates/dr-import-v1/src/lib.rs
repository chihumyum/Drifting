//! Importing a Drifting 0.1.x library into 0.2 (module M10).
//!
//! The 0.2 program has no Yjs. It reads the 0.1 library's SQLite directly:
//! every authored table, the prose caches (`contentJson`) and the evidence of
//! how fresh each cache is, including the handoff stamp the last 0.1 release
//! writes (`docs/v2-handoff.md`). Plan and mapping:
//! `docs/rust-rewrite/modules/m10-import.md`.
//!
//! - [`locate`]: the 0.1 libraries on this device (the 0.1 registry rules);
//! - [`staging`]: the read-only copy the import works on, migrated up to the
//!   last 0.1 schema with [`schema`] (the frozen 0.1 migrations);
//! - [`tables`]: where each of the 100 old tables goes;
//! - [`time`]: 0.1 timestamps;
//! - [`run`]: one import, start to finish, reporting [`progress`];
//! - [`meta`]: the snapshot history's metadata replayed into the book
//!   document; [`receipt`]: what the import did.
//!
//! The original library is never written: everything reads the staging copy.

pub mod anchors;
pub mod book;
pub mod error;
pub mod gate;
pub mod handoff;
pub mod legacy;
pub mod locate;
pub mod meta;
pub mod progress;
pub mod prose;
pub mod receipt;
pub mod run;
pub mod schema;
pub mod staging;
pub mod tables;
pub mod time;
/// Checking an import against the 0.1 ground truth (the measurements and
/// the dev tool). Not part of the import API.
#[doc(hidden)]
pub mod verify;

pub use error::{ImportError, Result};
