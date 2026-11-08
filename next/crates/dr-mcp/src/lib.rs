//! MCP adapts the shared Agent runtime. It does not own another author-tool
//! registry, permission tier, conversation model, or library lifetime.

pub mod bridge;
mod client_config;
pub mod grants;
pub mod host;
pub mod inbound;
pub mod outbound;
pub mod plugin_tools;
mod private_files;
pub mod transport;

pub use grants::*;
pub use plugin_tools::{PluginSlot, PluginTools};

pub type Result<T> = std::result::Result<T, String>;
