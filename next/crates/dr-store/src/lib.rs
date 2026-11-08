//! Drifting 0.2 storage (foundation F2).
//!
//! One library is a directory:
//!
//! ```text
//! <root>/library.sqlite      Loro update log + snapshots, heads, history
//!                            labels, Agent settlements, sync state, derived
//!                            indexes, asset rows, library settings
//! <root>/library.lock        held while a process has the library open
//! <root>/assets/<book>/<asset>/{source,display,thumbnail}.<ext>
//! <root>/safety-snapshots/<app version>/library-*.sqlite
//! <root>/safety-snapshots/recovery/<id>.json      migration receipts
//! ```
//!
//! and this device keeps, outside every library, its installation identity
//! and library watermarks ([`identity`]).
//!
//! - [`Library::open`] creates or migrates the database ([`migrate`]): a
//!   safety snapshot first, the migration on a shadow copy, a recovery
//!   receipt for every attempt, the original untouched on failure. It starts
//!   a new epoch on its own when the library moved to another device or an
//!   older copy was put back.
//! - [`Library::open_doc`] starts a [`DocHandle`]: one holder thread per open
//!   document. Every write is queued there with its [`Origin`], committed on
//!   its own, appended to SQLite (with the document's head, due history
//!   labels, an Agent write's settlement, sync state, all in one
//!   transaction), and only then announced, on the handle and on the
//!   library's event bus ([`StoreEvent`]). Nothing needs flushing at exit.
//! - Idle holders compact (a full snapshot, written in the same transaction
//!   that deletes the updates it covers) and keep the derived index current
//!   through a [`index::Deriver`]. History is never trimmed; looking back
//!   loads a separate copy ([`Library::load_copy_at`]); who wrote what is read
//!   from the Loro changes themselves ([`history::changes_since`]).
//! - What the sync service has is tracked per document (`remote_vv`), so
//!   uploads export from the document, independent of compaction.
//! - Asset files ([`asset`]) follow the 0.1 product's import protocol.
//!
//! Documents are plain `loro::LoroDoc`s addressed by string ids; the document
//! structure (dr-doc) plugs in through [`LibraryOptions::configure_doc`], the
//! genesis closure of [`OpenDoc::CreateIfMissing`] and the deriver.

pub mod agent;
pub mod archive;
pub mod asset;
pub mod backup;
pub mod digest;
pub mod error;
pub mod events;
pub mod file_io;
pub mod history;
mod holder;
pub mod identity;
pub mod index;
mod library;
pub mod local_state;
pub mod machine;
pub mod migrate;
mod origin;
pub mod purge;

pub use error::{MigrationFailure, Result, StoreError};
pub use events::{LibrarySubscription, LocalChange, LocalChangeKind, StoreEvent};
pub use holder::{
    AgentWrite, Committed, ContainerChange, DocEvent, DocHandle, DocView, EventSubscription,
    HolderStats, Imported, PendingWrite,
};
pub use identity::Device;
pub use library::{
    CloseRefused, CompactStats, CompactionPolicy, DocActivity, DocHead, DocInfo, EpochChange,
    Library, LibraryOptions, LibraryPaths, LoadStats, LocalTx, OpenDoc, Settlement, StoredUpdate,
    UploadBatch, ValidateImport,
};
pub use migrate::{Durability, MIGRATIONS, Migration, MigrationStage, OpenReport};
pub use origin::{AGENT_PREFIX, COMMAND_ORIGIN, Origin};

/// Unix time in milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A random 64-bit value from the operating system.
pub(crate) fn random_u64() -> u64 {
    getrandom::u64().unwrap_or_else(|_| {
        // No OS randomness (should not happen on supported platforms): fall
        // back to the std hasher's per-process random keys.
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        h.write_u32(std::process::id());
        h.finish()
    })
}

/// A random peer id for one (device, document) pair. Never zero, never
/// `u64::MAX` (reserved by Loro), top bit clear: genesis peers have it set
/// (loro-schema.md), so a device peer can never collide with one.
pub(crate) fn random_peer_id() -> u64 {
    loop {
        let v = random_u64() & !(1 << 63);
        if v != 0 {
            return v;
        }
    }
}
