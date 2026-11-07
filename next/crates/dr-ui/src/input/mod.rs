//! Text inputs: the single-line [`TextField`] (framed, or bare in the type of
//! the text around it) and the multi-line [`TextArea`] (bare, wrapping).
//! Their composition rules are `gpui-ime`'s [`LineComposer`], the same
//! crate the editor uses; [`ime`] adds grapheme boundaries and the call that
//! makes the system drop marked text.

pub mod area;
pub mod field;
pub mod ime;

pub use area::{AreaEvent, TextArea};
pub use field::{FieldEvent, TextField};
pub use gpui_ime::{Change, LineComposer};
pub use ime::{Graphemes, set_discard_marked_text};

/// Every input's key bindings (single- and multi-line, each in its own key
/// context).
pub fn bindings() -> Vec<gpui::KeyBinding> {
    field::bindings()
}
