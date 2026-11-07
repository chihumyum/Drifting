//! What can stop an import.

use std::path::PathBuf;

/// Why an import (or one of its steps) failed. The original 0.1 library is
/// never written, so every error leaves it as it was.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("0.1 library: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("file: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("new library: {0}")]
    Store(#[from] dr_store::StoreError),
    #[error("document: {0}")]
    Doc(#[from] dr_doc::DocError),
    #[error("loro export: {0}")]
    LoroEncode(#[from] loro::LoroEncodeError),
    /// Not a Drifting 0.1 library at all (no Drizzle migration table, or not
    /// SQLite).
    #[error("not a Drifting 0.1 library: {0}")]
    NotALibrary(String),
    /// The library was written by a newer 0.1 build than the migrations this
    /// importer froze.
    #[error("the 0.1 library is newer than this importer ({found} migrations, {known} known)")]
    Newer { found: usize, known: usize },
    /// The recorded migrations are not a prefix of the published ones (a
    /// development database from before 0.1.0-alpha.1, or a damaged one).
    #[error("the 0.1 library's migration history does not match the published 0.1 migrations: {0}")]
    SchemaMismatch(String),
    /// Another process (the 0.1 app) has the library open, or it changed
    /// while it was being copied.
    #[error("the 0.1 library is in use: {0}")]
    InUse(String),
    #[error("library registry: {0}")]
    Registry(String),
    /// The chosen 0.1 data folder holds only account libraries; they go into
    /// per-account libraries (M35).
    #[error("only account libraries in the folder ({0}); they are imported per account")]
    AccountLibrariesOnly(String),
    /// The staging copy failed SQLite's integrity check.
    #[error("the copy of the 0.1 library is damaged: {0}")]
    Damaged(String),
    /// The target already holds this book (re-importing would reuse the
    /// deterministic import peers with different content).
    #[error("the new library already has book {0}")]
    AlreadyImported(String),
    /// The gate stopped the import; the plan says why.
    #[error("the import was stopped before writing: {0}")]
    Blocked(String),
    #[error("{what}: {path}")]
    Path { what: &'static str, path: PathBuf },
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T, E = ImportError> = std::result::Result<T, E>;
