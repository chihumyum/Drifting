//! Durable request chains and evidence-gated plans. No automatic-run authority
//! is stored here: the application must explicitly arm its current lifetime.
mod store;
mod types;

pub use store::Store;
pub use types::*;

pub(crate) use store::{begin, persist_read, persist_writes};

#[cfg(test)]
mod tests;
