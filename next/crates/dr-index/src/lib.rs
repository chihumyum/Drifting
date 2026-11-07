//! Derived indexes for dr-store (`docs/rust-rewrite/foundations/dr-text-index.md`).
//!
//! dr-store computes derived data itself, from Loro changes, instead of the
//! editor pushing it back (`simplifications.md`, section two). This crate is
//! the [`dr_store::index::Deriver`] it calls: for every prose document it
//! produces one [`dr_store::index::BlockRow`] per paragraph (block id, order,
//! heading level, plain text for search), the entity links and material
//! embeds as [`dr_store::index::RefRow`]s, and the words and characters by
//! dr-text's rule. dr-store writes them with `index_state.indexed_seq` in one
//! transaction.
//!
//! - [`TextDeriver`] keeps what it derived per open document and, given the
//!   Loro diffs since its last run, re-reads only the paragraphs they touch
//!   ([`incremental`]). Without diffs, or when the diffs do not line up, it
//!   reads the whole document.
//! - [`attach`] registers it (and dr-doc's style configuration) on a
//!   library's options.

#[doc(hidden)]
pub mod evidence;
pub mod incremental;
mod paragraphs;
mod source;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dr_doc::prose::ProseView;
use dr_model::DocId;
use dr_store::LibraryOptions;
use dr_store::index::{DeriveInput, Derived, DerivedUpdate, Deriver};
use loro::VersionVector;

pub use paragraphs::{Block, derive_blocks, derived_from};
pub use source::prose_reader;

/// Everything derived from `view`, read from scratch.
pub fn derive_view(view: &ProseView<'_>) -> Derived {
    derived_from(&derive_blocks(view))
}

/// How a [`TextDeriver`] has worked so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeriverStats {
    /// Whole documents read (no diffs, nothing cached, or a fallback).
    pub full: u64,
    /// Derivations from diffs that re-read only the touched paragraphs.
    pub incremental: u64,
    /// Of `full`: diffs were given and something was cached, but they could
    /// not be used (too many, or they did not add up to the document).
    pub fallbacks: u64,
    /// Paragraphs re-read by incremental derivations.
    pub paragraphs_read: u64,
    /// Documents that could not be read as prose (logged; nothing derived).
    pub unreadable: u64,
}

struct Entry {
    used: u64,
    vv: VersionVector,
    blocks: Vec<Block>,
}

/// What was derived last, per (document, Loro peer). The peer tells the
/// document holder's own document (it carries the device peer) from the
/// copies a background rebuild loads (a random peer), so diffs are only
/// ever applied to what was derived from the same document.
struct Cache {
    capacity: usize,
    clock: u64,
    entries: HashMap<(String, u64), Entry>,
}

impl Cache {
    fn take(&mut self, key: &(String, u64)) -> Option<Entry> {
        self.entries.remove(key)
    }

    fn put(&mut self, key: (String, u64), mut entry: Entry) {
        self.clock += 1;
        entry.used = self.clock;
        self.entries.insert(key, entry);
        while self.entries.len() > self.capacity {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }
}

/// dr-store's deriver for Drifting's prose documents. One per library: its
/// cache is keyed by document id and Loro peer.
pub struct TextDeriver {
    cache: Mutex<Cache>,
    full: AtomicU64,
    incremental: AtomicU64,
    fallbacks: AtomicU64,
    paragraphs_read: AtomicU64,
    unreadable: AtomicU64,
}

/// Documents whose derivation is kept for the next diffs. An entry is a copy
/// of the document's plain text (about 60 KB for a 20 000-character
/// chapter), so this bounds the memory at a few MB.
pub const DEFAULT_CACHED_DOCS: usize = 32;

impl Default for TextDeriver {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CACHED_DOCS)
    }
}

impl TextDeriver {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(docs: usize) -> Self {
        Self {
            cache: Mutex::new(Cache {
                capacity: docs.max(1),
                clock: 0,
                entries: HashMap::new(),
            }),
            full: AtomicU64::new(0),
            incremental: AtomicU64::new(0),
            fallbacks: AtomicU64::new(0),
            paragraphs_read: AtomicU64::new(0),
            unreadable: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> DeriverStats {
        DeriverStats {
            full: self.full.load(Ordering::Relaxed),
            incremental: self.incremental.load(Ordering::Relaxed),
            fallbacks: self.fallbacks.load(Ordering::Relaxed),
            paragraphs_read: self.paragraphs_read.load(Ordering::Relaxed),
            unreadable: self.unreadable.load(Ordering::Relaxed),
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Derive one prose document, from the diffs when they can be used.
    fn derive_prose(&self, doc_id: &DocId, input: &DeriveInput<'_>) -> Option<Derived> {
        let reader = match prose_reader(doc_id, input.doc) {
            Ok(r) => r,
            Err(e) => {
                self.unreadable.fetch_add(1, Ordering::Relaxed);
                log::warn!(
                    "{}: not readable as prose, nothing derived: {e}",
                    input.doc_id
                );
                return None;
            }
        };
        let view = reader.view();
        let key = (input.doc_id.to_string(), input.doc.peer_id());
        let vv = input.doc.oplog_vv();
        let cached = self.cache().take(&key);
        let blocks = match (input.changes, cached) {
            (Some(changes), Some(entry)) if vv.includes_vv(&entry.vv) => {
                match incremental::update(&view, &entry.blocks, changes) {
                    Ok(update) => {
                        self.incremental.fetch_add(1, Ordering::Relaxed);
                        self.paragraphs_read
                            .fetch_add(update.read as u64, Ordering::Relaxed);
                        update.blocks
                    }
                    Err(why) => {
                        log::debug!("{}: reading the whole document ({why})", input.doc_id);
                        self.fallbacks.fetch_add(1, Ordering::Relaxed);
                        self.full.fetch_add(1, Ordering::Relaxed);
                        derive_blocks(&view)
                    }
                }
            }
            _ => {
                self.full.fetch_add(1, Ordering::Relaxed);
                derive_blocks(&view)
            }
        };
        let derived = derived_from(&blocks);
        self.cache().put(
            key,
            Entry {
                used: 0,
                vv,
                blocks,
            },
        );
        Some(derived)
    }
}

impl Deriver for TextDeriver {
    fn derive(&self, input: &DeriveInput<'_>) -> Option<DerivedUpdate> {
        let Ok(doc_id) = DocId::parse(input.doc_id) else {
            // Not one of Drifting's documents: nothing to derive.
            return None;
        };
        if doc_id.is_book() {
            // A book document has no paragraphs. Record it as indexed (empty)
            // so it does not count as stale on every open.
            return Some(DerivedUpdate::Full(Derived::default()));
        }
        self.derive_prose(&doc_id, input).map(DerivedUpdate::Full)
    }
}

/// Register dr-doc's style configuration and a [`TextDeriver`] on `options`.
/// Returns the deriver (for its [`TextDeriver::stats`]).
pub fn attach(options: &mut LibraryOptions) -> Arc<TextDeriver> {
    let deriver = Arc::new(TextDeriver::new());
    options.configure_doc = Some(Arc::new(dr_doc::schema::configure));
    options.deriver = Some(deriver.clone());
    deriver
}
