//! Reading dr-store's `LoroDoc` as a dr-doc prose document.
//!
//! The deriver reads the document it is given in place: on a holder that is
//! the holder's own hot document, on a rebuild the copy dr-store loaded.
//! dr-doc's `ProseReader::from_loro` shares it and writes nothing.

use dr_doc::prose::ProseReader;
use dr_model::DocId;
use loro::LoroDoc;

/// A dr-doc reader on `doc`, without copying it.
pub fn prose_reader(doc_id: &DocId, doc: &LoroDoc) -> dr_doc::Result<ProseReader> {
    ProseReader::from_loro(doc_id.clone(), doc)
}
