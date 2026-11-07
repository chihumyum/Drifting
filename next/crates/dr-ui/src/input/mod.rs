//! The single-line input. Its composition rules are `gpui-ime`'s
//! [`LineComposer`], the same crate the editor uses; [`ime`] adds grapheme
//! boundaries and the call that makes the system drop marked text.

pub mod field;
pub mod ime;

pub use field::{FieldEvent, TextField};
pub use gpui_ime::{Change, LineComposer};
pub use ime::{Graphemes, set_discard_marked_text};
