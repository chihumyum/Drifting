//! Aging: what a seeded document looks like after a year or two of use.
//!
//! Every document the seed writes is its genesis plus one compacted update,
//! so a benchmark on the seed alone never sees a long history. The steps
//! here take a seeded document and use it the way an author does, with
//! deterministic peers, timestamps and random choices:
//!
//! - [`chapter::age`] revises a chapter (typing in input-method commits,
//!   typo fixes, paragraphs rewritten, sentences moved, the odd split, join
//!   and bold) in sessions spread over days and devices, until its history
//!   holds a given number of operations while its visible length stays put;
//! - [`book::age`] uses a book for a number of days on two devices: writing
//!   days every minute of writing, field edits, layout drags, comments,
//!   timeline moves and the entry checkpoints the app saves by itself.
//!
//! No new corpus: replacement text comes from [`crate::text`], and the
//! documents are the seed's own. An aged document is stored like a seeded
//! one ([`store`]): genesis, then its whole history as one update, compacted.
//!
//! See `docs/rust-rewrite/spikes/history-aging.md`.

pub mod book;
pub mod chapter;

use dr_model::DocId;
use dr_model::id::BookId;

use crate::seed::WriteError;

/// Seconds in a day.
pub(crate) const DAY_S: i64 = 86_400;

/// Operations in a document's history: the sum of its version vector
/// (Loro counts one per character typed or deleted, mark or map write).
pub fn ops(vv: &loro::VersionVector) -> usize {
    vv.values().map(|end| *end as usize).sum()
}

/// A deterministic device peer for aging: top bit clear (a device), lowest
/// bit clear (never dr-doc's import peer).
pub(crate) fn device_peer(doc_id: &str, device: usize) -> u64 {
    let h = dr_doc::peer::fnv1a64(format!("aging-device:{device}:{doc_id}").as_bytes());
    ((h & !(1 << 63)) & !1).max(2)
}

/// What a history is made of, read from a document's snapshot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryShape {
    /// Operations ([`ops`]).
    pub ops: usize,
    /// Loro changes (one per peer per run of commits within Loro's change
    /// merge interval).
    pub changes: usize,
    /// Peers that wrote the document.
    pub peers: usize,
    /// Operations after run-length merging: the pieces a replay walks.
    pub op_runs: usize,
    /// Bytes of a shallow snapshot at the latest version: the state with no
    /// history behind it, the floor a full snapshot cannot go below.
    pub state_bytes: usize,
}

impl HistoryShape {
    /// Read the shape of the history in `snapshot`.
    pub fn of(snapshot: &[u8]) -> Result<Self, String> {
        let doc = loro::LoroDoc::new();
        dr_doc::schema::configure(&doc);
        doc.import(snapshot).map_err(|e| e.to_string())?;
        let vv = doc.oplog_vv();
        let json = doc
            .export_json_updates(&loro::VersionVector::default(), &vv)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            ops: ops(&vv),
            changes: doc.len_changes(),
            peers: vv.iter().count(),
            op_runs: json.changes.iter().map(|c| c.ops.len()).sum(),
            state_bytes: doc
                .export(loro::ExportMode::shallow_snapshot(&doc.oplog_frontiers()))
                .map_err(|e| e.to_string())?
                .len(),
        })
    }
}

/// Store one document in `lib` the way the seed does (origin `import`):
/// its genesis, then `updates` (its whole history) as one update,
/// compacted. Fails when the document is already stored.
pub fn store(
    lib: &dr_store::Library,
    book: &BookId,
    doc_id: &DocId,
    genesis: Vec<u8>,
    updates: Vec<u8>,
) -> Result<(), WriteError> {
    let id = doc_id.to_string();
    if lib.doc_info(&id)?.is_some() {
        return Err(WriteError::Store(dr_store::StoreError::Invalid {
            what: "aged document",
            value: format!("{id} is already stored"),
        }));
    }
    let h = lib.open_doc(
        &id,
        dr_store::OpenDoc::CreateIfMissing {
            kind: doc_id.kind().prefix(),
            book_id: Some(book.as_str()),
            genesis: &move |d: &loro::LoroDoc| {
                d.import(&genesis)
                    .expect("dr-doc's genesis imports into an empty document");
            },
        },
    )?;
    h.import(updates, dr_store::Origin::Import)?;
    h.compact_now()?;
    h.close();
    Ok(())
}
