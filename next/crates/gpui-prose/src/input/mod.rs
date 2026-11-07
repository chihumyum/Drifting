//! F4c — input: actions and key bindings, the selection, input-method
//! composition and the `EntityInputHandler`, caret movement (grapheme
//! clusters, ICU words, rows), editing actions, and the mouse.

pub mod actions;
pub mod composition;
mod editing;
mod ime;
mod mouse;
mod movement;
pub mod selection;

pub use actions::{KEY_CONTEXT, bind_keys};
pub use composition::{Composition, Marked16, Marking, Overlay, Virtual16};
pub use selection::Selection;

#[cfg(test)]
mod tests;
