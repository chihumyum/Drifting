//! M27: one in-process runtime. The local append-only journal is the event
//! authority; the synchronized conversation is its replayable projection.
//! Model adapters implement [`Driver`]; M29 implements [`ToolExecutor`].
//! No provider, interface, network, permission tier, or alternate transport.

mod config;
mod control;
pub mod driver;
mod journal;
pub mod protocol;
mod runtime;
pub mod tools;

pub use config::{ModelCapabilities, ModelRoute, Provider, RunConfig, ThinkingLevel};
pub use control::{Cancellation, Control, RunHandle};
pub use driver::{Driver, DriverEvent, DriverRequest, FinishReason};
pub use journal::{JournalEvent, conversation, events};
pub use protocol::*;
pub use runtime::{Options, RecoveredRun, Runtime, Start};
pub use tools::{ToolContext, ToolExecutor};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Store(#[from] dr_store::StoreError),
    #[error(transparent)]
    Document(#[from] dr_doc::DocError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("runtime protocol: {0}")]
    Protocol(String),
    #[error("model driver: {0}")]
    Driver(String),
    #[error("model provider: {0}")]
    Provider(#[from] ModelFailure),
    #[error("tool: {0}")]
    Tool(String),
    #[error("the run is closed")]
    Closed,
    #[error("stale or mismatched request")]
    StaleRequest,
}
