//! The single-line input and the composition rules it shares with the
//! editor (see docs/rust-rewrite/foundations/f5-ui.md, 「待协调」).

pub mod compose;
pub mod field;

pub use compose::{Change, Composer};
pub use field::{FieldEvent, TextField};
