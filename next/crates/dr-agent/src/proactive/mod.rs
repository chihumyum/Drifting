//! Device-local suggestions. Collection reads persisted prose; the one-call
//! model service only receives owned input. Opening a card is a normal Agent
//! session owned by the caller, never an automatic manuscript write.

mod checkin;
mod delta;
mod state;

pub use checkin::*;
pub use delta::*;
pub use state::*;
