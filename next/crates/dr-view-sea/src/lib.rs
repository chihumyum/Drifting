//! dr-view-sea: 字海, the full-window waits and the first run (M24).
//!
//! - [`sea`]: the sea of characters under the bookshelf and the full-window
//!   waits, held by the pages that lie on it ([`Sea::hold`]); at rest a
//!   faint dot per cell, moving where the hand, the rain or the rising word
//!   stirs it. [`char_sea`] draws it; [`on_sea`] lays glass on it.
//! - [`model`]: the water, the rain and the characters, with no GPUI.
//! - [`text`]: the passage it is written in, per interface language.
//! - [`first_run`]: the app's name rising from the sea on a first launch,
//!   the card of steps that follows (language in the corner), and the
//!   sample book landing on the shelf.
//! - [`tour`]: the bubble tour the first time a book opens on this device.
//! - [`shell`]: registers all of it with the shell (`dr_shell::pages`).
//!
//! docs/rust-rewrite/modules/m24-sea.md has the design, the numbers and how
//! the shell and the shelf wire it.

pub mod element;
pub mod first_run;
pub mod glass;
pub mod model;
pub mod sea;
pub mod shell;
pub mod text;
pub mod tour;

pub use element::{CharSea, char_sea};
pub use glass::{OnSea, SeaGlass, on_sea};
pub use sea::{Hold, HoldKind, Mode, Sea};
