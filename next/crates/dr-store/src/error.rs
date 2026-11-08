//! Errors of the storage layer.

use std::path::PathBuf;

use crate::migrate::MigrationStage;

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("loro: {0}")]
    Loro(#[from] loro::LoroError),
    #[error("loro export: {0}")]
    LoroEncode(#[from] loro::LoroEncodeError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// A migration failed. The library database was not changed; the error
    /// says where the safety snapshot taken before the attempt is.
    #[error(transparent)]
    Migration(#[from] MigrationFailure),
    /// The database was written by a newer build (more migrations than this
    /// build knows). Upgrade the app; nothing was changed.
    #[error("library schema is newer than this build ({applied} > {known} migrations)")]
    SchemaNewer { applied: usize, known: usize },
    /// The applied migrations are not a prefix of this build's migrations:
    /// a development database made with an edited baseline, or not a
    /// Drifting 0.2 library at all. Nothing was changed.
    #[error("library schema does not match this build: {0}")]
    SchemaMismatch(String),
    /// The document is already held by another open handle in this process.
    #[error("document {0} is already open")]
    AlreadyOpen(String),
    /// The operation needs every document closed (for example an epoch
    /// rotation).
    #[error("{0} documents are still open")]
    DocumentsOpen(usize),
    /// Nothing is stored for this document.
    #[error("document {0} is not stored")]
    NotFound(String),
    /// The document, or the book it would belong to, was purged on this
    /// device; it is not created again ([`crate::purge`]).
    #[error("document {0} was purged on this device")]
    Purged(String),
    /// The document holder thread is gone (closed, or it panicked).
    #[error("document {0} is closed")]
    Closed(String),
    /// A write closure panicked. Its partial edits were committed and
    /// persisted (Loro cannot roll them back), under the write's origin.
    #[error("write to {0} panicked; partial edits were persisted")]
    WritePanicked(String),
    /// A read closure panicked. The holder keeps running.
    #[error("a read of {0} panicked")]
    ReadPanicked(String),
    #[error("invalid {what}: {value}")]
    Invalid { what: &'static str, value: String },
    #[error("asset: {0}")]
    Asset(String),
    /// A library backup that cannot be restored: `code` is one of
    /// [`crate::backup::INVALID`], [`crate::backup::LEGACY`] or
    /// [`crate::backup::NEWER`]. Nothing was changed.
    #[error("{code}: {detail}")]
    Backup { code: &'static str, detail: String },
    /// A previous migration attempt left a receipt that cannot be settled
    /// safely (unreadable, its snapshot changed, or the replaced library is
    /// incomplete). Opening stops; the app offers to restore the snapshot.
    #[error("library recovery {recovery_id} needs attention: {code}")]
    Recovery {
        recovery_id: String,
        code: &'static str,
    },
    #[error("installation identity: {0}")]
    Identity(String),
    /// The library is opened read-only.
    #[error("the library is opened read-only")]
    ReadOnly,
    /// A read-only open of a library this build would first migrate.
    #[error("library needs migrating ({applied} of {known} migrations); open it read-write once")]
    NeedsMigration { applied: usize, known: usize },
    /// A derived-index patch was made from other rows than the stored ones;
    /// derive the document from scratch instead.
    #[error("index patch for {doc_id} expects {expected} paragraphs, {stored} are stored")]
    IndexBase {
        doc_id: String,
        stored: u64,
        expected: u64,
    },
    /// Another runtime writer appended after the caller's observed event.
    #[error("agent session {session} expects event {expected}, but {stored} is stored")]
    AgentSequence {
        session: String,
        expected: i64,
        stored: i64,
    },
}

impl StoreError {
    pub(crate) fn invalid(what: &'static str, value: impl Into<String>) -> Self {
        Self::Invalid {
            what,
            value: value.into(),
        }
    }
}

/// A failed migration. Unless it failed while reopening the replaced
/// library ([`MigrationStage::Reopen`]), the source database is byte-for-byte
/// unchanged: the migration ran on a shadow copy that was discarded.
#[derive(Debug, Clone)]
pub struct MigrationFailure {
    pub stage: MigrationStage,
    pub detail: String,
    /// The `VACUUM INTO` copy of the database taken before the attempt
    /// (empty when the attempt failed before writing it).
    pub safety_snapshot: PathBuf,
    /// The recovery receipt of the attempt, if one was written.
    pub recovery_id: Option<String>,
    /// Migrations applied in the source database.
    pub from: usize,
    /// Migrations this build wanted to reach.
    pub to: usize,
}

impl MigrationFailure {
    /// Whether the library file is exactly as it was before the attempt.
    pub fn source_unchanged(&self) -> bool {
        self.stage.source_unchanged()
    }
}

impl std::fmt::Display for MigrationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "library migration {} -> {} failed at {} ({})",
            self.from, self.to, self.stage, self.detail
        )?;
        if self.source_unchanged() {
            f.write_str("; the library was not changed")?;
        } else {
            f.write_str("; the migrated library could not be reopened")?;
        }
        if !self.safety_snapshot.as_os_str().is_empty() {
            write!(f, "; safety snapshot: {}", self.safety_snapshot.display())?;
        }
        Ok(())
    }
}

impl std::error::Error for MigrationFailure {}
