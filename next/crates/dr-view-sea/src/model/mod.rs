//! The parts of the sea that need no GPU (the 0.1 client's
//! `lib/char-sea/char-sea-model.ts`): where each character sits, the water
//! under them (and a shape it can be held to), the loading rain, and the
//! characters that change while it moves.

#[cfg(test)]
mod fixtures;
mod glyphs;
mod layout;
mod rain;
mod rand;
mod water;

pub use self::rand::Rand;
pub use glyphs::{COVER_THRESHOLD, Glyphs, Tick, cells_covered};
pub use layout::{Language, Layout, layout};
pub use rain::Rain;
pub use water::{STEP_RATE, WATER_CELL, Water, bilinear};
