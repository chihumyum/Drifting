//! Testkit-only source-format fixture writer. Never linked into the App.
//! Storing a laid-out book in a dr-store library (origin `import`), the way
//! the 0.1 importer does: each document's genesis, then its whole history
//! as one update, compacted.

use dr_doc::loro_types::VersionVector;
use dr_model::DocId;

use super::SeededBook;
use dr_samples::WriteError;

/// Store one book: its prose documents, then its book document (the shelf
/// lists a book once its book document is stored, so it never shows one
/// without its prose). Documents already in the library are left alone.
/// Returns how many were written.
pub fn write_book(lib: &dr_store::Library, b: &SeededBook) -> Result<usize, WriteError> {
    Ok(write_prose_docs(lib, b)? + write_book_doc(lib, b)?)
}

/// Every prose document of `b` (see [`write_book`]).
pub(crate) fn write_prose_docs(
    lib: &dr_store::Library,
    b: &SeededBook,
) -> Result<usize, WriteError> {
    let all = VersionVector::default();
    let mut written = 0;
    for p in &b.prose {
        written += store(
            lib,
            b,
            p.doc_id(),
            dr_doc::prose::genesis(p.doc_id()),
            p.export_updates_since(&all)?,
        )?;
    }
    Ok(written)
}

/// The book document of `b` (see [`write_book`]).
pub(crate) fn write_book_doc(lib: &dr_store::Library, b: &SeededBook) -> Result<usize, WriteError> {
    let all = VersionVector::default();
    store(
        lib,
        b,
        b.book.doc_id(),
        dr_doc::import_v1::genesis(b.book_id()),
        b.book.export_updates_since(&all)?,
    )
}

fn store(
    lib: &dr_store::Library,
    b: &SeededBook,
    doc_id: &DocId,
    genesis: Vec<u8>,
    bytes: Vec<u8>,
) -> Result<usize, WriteError> {
    let id = doc_id.to_string();
    if lib.doc_info(&id)?.is_some() {
        return Ok(0);
    }
    let h = lib.open_doc(
        &id,
        dr_store::OpenDoc::CreateIfMissing {
            kind: doc_id.kind().prefix(),
            book_id: Some(b.book_id().as_str()),
            genesis: &move |d: &loro::LoroDoc| {
                d.import(&genesis)
                    .expect("dr-doc's genesis imports into an empty document");
            },
        },
    )?;
    h.import(bytes, dr_store::Origin::Import)?;
    h.compact_now()?;
    h.close();
    Ok(1)
}
