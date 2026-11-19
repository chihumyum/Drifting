//! Durable request chains and evidence-gated plans. No automatic-run authority
//! is stored here: the application must explicitly arm its current lifetime.
mod store;
mod tools;
mod types;

pub use store::Store;
pub use tools::{
    READ_TOOL, UPDATE_TOOL, describe_tool, execute_tool, read_descriptor, update_descriptor,
};
pub use types::*;

pub(crate) use store::{begin, persist_read, persist_writes};

#[cfg(test)]
mod tests;
