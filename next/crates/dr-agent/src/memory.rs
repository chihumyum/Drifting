//! M30: one book's synchronized Project Memory and device-local Working
//! Memory. Markdown is content, never a second copy of the book's entries.
mod project;
mod store;

pub use project::{ProjectEntry, ProjectSnapshot, project};
pub use store::{clear, edit, edit_once, load, read_page, replace, take_notice};

use dr_model::id::BookId;
use serde::{Deserialize, Serialize};

pub const SCOPE: &str = "agent-memory";
pub const FILENAME: &str = "WORKING_MEMORY.md";
pub const EMPTY_MARKDOWN: &str = "# Working Memory\n\n## Current\n\n## Recent\n";
pub const DEFAULT_PAGE_CHARS: usize = 16_000;
pub const MAX_PAGE_CHARS: usize = 64_000;

pub type MemoryResult<T> = std::result::Result<T, MemoryError>;

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("WORKING_MEMORY_REVISION_CONFLICT: expected {expected}, actual {actual}; read again")]
    Conflict { expected: u64, actual: u64 },
    #[error("invalid memory operation: {0}")]
    Invalid(String),
    #[error("stored working memory is incomplete or unsupported")]
    Corrupt,
    #[error(transparent)]
    Store(#[from] dr_store::StoreError),
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdatedBy {
    Author,
    Agent,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub book: BookId,
    pub revision: u64,
    pub exists: bool,
    pub content_md: String,
    pub approx_tokens: u64,
    pub updated_by: Option<UpdatedBy>,
    pub updated_ms: Option<i64>,
}

/// Small write result, safe for the journal and idempotency receipt. The
/// complete document belongs only to its chunks, never to a tool receipt.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MutationInfo {
    pub revision: u64,
    pub exists: bool,
    pub approx_tokens: u64,
    pub updated_by: Option<UpdatedBy>,
    pub updated_ms: Option<i64>,
}
impl From<&Snapshot> for MutationInfo {
    fn from(value: &Snapshot) -> Self {
        Self {
            revision: value.revision,
            exists: value.exists,
            approx_tokens: value.approx_tokens,
            updated_by: value.updated_by,
            updated_ms: value.updated_ms,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Page {
    pub filename: String,
    pub book: BookId,
    #[serde(flatten)]
    pub info: MutationInfo,
    /// Unicode scalar offsets, not UTF-8 byte offsets.
    pub start: usize,
    pub end: usize,
    pub total_chars: usize,
    pub has_more: bool,
    pub content_md: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Edit {
    pub old_text: String,
    pub new_text: String,
}

#[cfg(test)]
mod tests;
