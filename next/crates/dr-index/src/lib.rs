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
//! - [`TextDeriver`] reads the holder's own document in place and keeps what
//!   it derived per open document. Given the Loro diffs since its last run,
//!   it re-reads only the paragraphs they touch and hands dr-store a
//!   paragraph patch ([`dr_store::index::DerivedUpdate::Patch`]) with just
//!   the rows that changed. Without diffs, or when they do not line up, it
//!   reads the whole document and replaces everything.
//! - [`attach`] registers it (and dr-doc's style configuration) on a
//!   library's options.

mod incremental;
mod paragraphs;
mod patch;
mod source;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dr_doc::prose::ProseView;
use dr_model::DocId;
use dr_store::LibraryOptions;
use dr_store::index::{DeriveInput, Derived, DerivedUpdate, Deriver};
use loro::VersionVector;

pub use incremental::{Fallback, MAX_DELTA_ITEMS, MIN_READ_LIMIT, read_limit};
pub use source::prose_reader;

use paragraphs::{derive_blocks, derived_with, kept_ids};
use patch::State;

/// Everything derived from `view`, read from scratch.
pub fn derive_view(view: &ProseView<'_>) -> Derived {
    paragraphs::derived_from(&derive_blocks(view))
}

/// How a [`TextDeriver`] has worked so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeriverStats {
    /// Whole documents read (no diffs, nothing cached, a rebuild copy, or a
    /// fallback); each one replaced everything stored.
    pub full: u64,
    /// Derivations from diffs that re-read only the touched paragraphs; each
    /// one sent a paragraph patch.
    pub incremental: u64,
    /// Of `full`: diffs were given and something was cached, but they could
    /// not be used (too many, or they did not add up to the document).
    pub fallbacks: u64,
    /// Paragraphs re-read by incremental derivations.
    pub paragraphs_read: u64,
    /// Rows the patches replaced or added (their splices' new rows).
    pub rows_patched: u64,
    /// Documents that could not be read as prose (logged; nothing derived).
    pub unreadable: u64,
}

struct Entry {
    used: u64,
    vv: VersionVector,
    state: State,
}

/// What was derived last from a holder's document, per (document, Loro
/// peer). Only holders' documents are cached (`DeriveInput::held`); the peer
/// keeps two libraries that share one deriver (and the same document ids,
/// as tests do) apart.
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
    rows_patched: AtomicU64,
    unreadable: AtomicU64,
}

/// Documents whose derivation is kept for the next diffs. An entry holds a
/// copy of the document's plain text (about 60 KB for a 20 000-character
/// chapter), so this bounds the memory at a few MB. A document that drops
/// out is read whole on its next derivation.
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
            rows_patched: AtomicU64::new(0),
            unreadable: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> DeriverStats {
        DeriverStats {
            full: self.full.load(Ordering::Relaxed),
            incremental: self.incremental.load(Ordering::Relaxed),
            fallbacks: self.fallbacks.load(Ordering::Relaxed),
            paragraphs_read: self.paragraphs_read.load(Ordering::Relaxed),
            rows_patched: self.rows_patched.load(Ordering::Relaxed),
            unreadable: self.unreadable.load(Ordering::Relaxed),
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Derive one prose document: a patch from the diffs when they can be
    /// used, everything otherwise.
    fn derive_prose(&self, doc_id: &DocId, input: &DeriveInput<'_>) -> Option<DerivedUpdate> {
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
        if !input.held {
            // A copy for a rebuild: read once, never diffed.
            self.full.fetch_add(1, Ordering::Relaxed);
            return Some(DerivedUpdate::Full(derive_view(&view)));
        }
        let key = (input.doc_id.to_string(), input.doc.peer_id());
        let vv = input.doc.oplog_vv();
        let cached = self.cache().take(&key);
        let patched = match (input.changes, cached) {
            (Some(changes), Some(entry)) if vv.includes_vv(&entry.vv) => {
                let next = incremental::update(&view, &entry.state.blocks, changes)
                    .map_err(|why| why.to_string())
                    .and_then(|u| {
                        let read = u.read;
                        patch::next(entry.state, u)
                            .map(|n| (n, read))
                            .ok_or_else(|| "the update does not fit".to_string())
                    });
                match next {
                    Ok(((state, patch), read)) => Some((state, patch, read)),
                    Err(why) => {
                        log::debug!("{}: reading the whole document ({why})", input.doc_id);
                        self.fallbacks.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                }
            }
            _ => None,
        };
        let (state, update) = match patched {
            Some((state, patch, read)) => {
                self.incremental.fetch_add(1, Ordering::Relaxed);
                self.paragraphs_read
                    .fetch_add(read as u64, Ordering::Relaxed);
                let rows: usize = patch.splices.iter().map(|s| s.blocks.len()).sum();
                self.rows_patched.fetch_add(rows as u64, Ordering::Relaxed);
                (state, DerivedUpdate::Patch(patch))
            }
            None => {
                self.full.fetch_add(1, Ordering::Relaxed);
                let blocks = derive_blocks(&view);
                let kept = kept_ids(blocks.iter().map(|b| b.stored_id.as_ref()));
                let derived = derived_with(&blocks, &kept);
                let state = State {
                    blocks,
                    kept,
                    references: derived.references.clone(),
                };
                (state, DerivedUpdate::Full(derived))
            }
        };
        self.cache().put(key, Entry { used: 0, vv, state });
        Some(update)
    }
}

impl Deriver for TextDeriver {
    fn derive(&self, input: &DeriveInput<'_>) -> Option<DerivedUpdate> {
        let Ok(doc_id) = DocId::parse(input.doc_id) else {
            // Not one of Drifting's documents: nothing to derive.
            return None;
        };
        if !doc_id.kind().is_book_text() {
            // Book and conversation documents have no prose, and a body template is not
            // the book's text (not searched, counted, linked from or turned
            // into todos). Record these as indexed (empty) so they do not
            // count as stale on every open.
            return Some(DerivedUpdate::Full(Derived::default()));
        }
        self.derive_prose(&doc_id, input)
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
