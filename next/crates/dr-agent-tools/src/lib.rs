//! M29: the Agent and MCP share F3's registered commands and scoped facade.
pub mod catalog;
mod executor;
pub mod prose;
pub mod resolve;

pub use executor::AgentTools;
pub use executor::CallRequest;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] dr_workspace::WsError),
    #[error(transparent)]
    Agent(#[from] dr_agent::Error),
    #[error("invalid tool request: {0}")]
    Invalid(String),
    #[error("stale observation; read again: {0}")]
    Conflict(String),
    #[error("read the target before writing: {0}")]
    ReadRequired(String),
    #[error("two conflicts on this target; stopping the turn: {0}")]
    ConflictLimit(String),
}

impl From<dr_store::StoreError> for Error {
    fn from(error: dr_store::StoreError) -> Self {
        Self::Workspace(error.into())
    }
}
