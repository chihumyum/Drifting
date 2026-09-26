//! Drifting client core shared by Tauri and Apple native hosts.
pub mod database;
pub mod file_io;
pub(crate) mod fractional;
pub mod original_body_archive;
pub mod original_operation;
pub mod original_operation_store;
pub mod prose;
pub mod prose_journal;
pub mod remote_prose;
pub mod remote_workspace;
mod remote_workspace_metadata;

pub mod materialization_admission;

pub mod workspace;
