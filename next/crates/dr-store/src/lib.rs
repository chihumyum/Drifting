//! Drifting 0.2 storage (foundation F2).
//!
//! One library is a directory:
//!
//! ```text
//! <root>/library.sqlite      Loro update log + snapshots, history labels,
//!                            derived indexes, asset rows, library settings
//! <root>/library.lock        held while a process has the library open
//! <root>/assets/<book>/<asset>/{source,display,thumbnail}.<ext>
//! <root>/safety-snapshots/<app version>/library-*.sqlite
//! ```
//!
//! - [`Library::open`] creates or migrates the database ([`migrate`]): a
//!   safety snapshot first, the migration on a shadow copy, the original
//!   untouched on failure.
//! - [`Library::open_doc`] starts a [`DocHandle`]: one holder thread per open
//!   document. Every write is queued there with its [`Origin`], committed on
//!   its own, appended to SQLite, and only then announced as a [`DocEvent`].
//! - Holders compact in the background (a full snapshot, written in the same
//!   transaction that deletes the updates it covers). History is never
//!   trimmed; looking back loads a separate copy ([`Library::load_copy_at`]).
//! - Derived indexes ([`index`]) and asset files ([`asset`]) have minimal
//!   write and query APIs; incremental maintenance belongs to dr-workspace.
//!
//! Documents are plain `loro::LoroDoc`s addressed by string ids; the document
//! structure (dr-doc) plugs in through [`LibraryOptions::configure_doc`] and
//! the genesis closure of [`OpenDoc::CreateIfMissing`].

pub mod asset;
pub mod error;
#[doc(hidden)]
pub mod evidence;
pub mod file_io;
pub mod history;
mod holder;
pub mod index;
mod library;
pub mod migrate;
mod origin;
#[doc(hidden)]
pub mod synthetic;

pub use error::{MigrationFailure, Result, StoreError};
pub use holder::{
    Committed, ContainerChange, DocEvent, DocHandle, DocView, EventSubscription, HolderStats,
    Imported, PendingWrite,
};
pub use library::{
    CompactStats, CompactionPolicy, DocInfo, Library, LibraryOptions, LibraryPaths, LoadStats,
    OpenDoc, StoredUpdate,
};
pub use migrate::{Durability, MIGRATIONS, Migration, MigrationStage, OpenReport};
pub use origin::{AGENT_PREFIX, Origin};

/// Unix time in milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A random 64-bit value from the OS-seeded std hasher (no extra crate).
pub(crate) fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
    );
    h.write_u32(std::process::id());
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.finish()
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
