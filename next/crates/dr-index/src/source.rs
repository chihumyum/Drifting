//! Reading dr-store's `LoroDoc` as a dr-doc prose document.
//!
//! dr-store hands the deriver a plain `LoroDoc`; dr-doc reads prose only
//! through its own types and has no constructor that wraps an existing
//! `LoroDoc`. Until it has one (dr-text-index.md, "待协调" 1), the document is
//! copied: exported as a snapshot and loaded into a dr-doc reader. The copy
//! is never written to.

use dr_doc::prose::{ProseDoc, ProseReader};
use dr_model::DocId;
use loro::{ExportMode, LoroDoc};

/// The peer the read-only copy is loaded with (any device peer will do: it
/// never writes).
const COPY_PEER: u64 = 1;

/// A dr-doc reader on the current state of `doc`.
pub fn prose_reader(doc_id: &DocId, doc: &LoroDoc) -> dr_doc::Result<ProseReader> {
    let snapshot = doc.export(ExportMode::Snapshot)?;
    Ok(ProseDoc::load(doc_id.clone(), COPY_PEER, &[snapshot])?.reader())
}
