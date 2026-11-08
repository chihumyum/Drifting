//! Storing a laid-out book in a dr-store library (origin `import`), the way
//! the 0.1 importer does: each document's genesis, then its whole history
//! as one update, compacted.

use dr_doc::loro_types::VersionVector;
use dr_model::DocId;

use crate::build::SeededBook;

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
        dr_doc::book::genesis(b.book_id()),
        b.book.export_updates_since(&all)?,
    )
}

/// Every document id of `b`: its prose documents, then its book document.
pub(crate) fn doc_ids(b: &SeededBook) -> Vec<String> {
    b.prose
        .iter()
        .map(|p| p.doc_id().to_string())
        .chain([b.book.doc_id().to_string()])
        .collect()
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

/// Why storing a book failed.
#[derive(Debug)]
pub enum WriteError {
    Doc(dr_doc::DocError),
    Store(dr_store::StoreError),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Doc(e) => write!(f, "{e}"),
            WriteError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for WriteError {}

impl From<dr_doc::DocError> for WriteError {
    fn from(e: dr_doc::DocError) -> Self {
        WriteError::Doc(e)
    }
}

impl From<dr_store::StoreError> for WriteError {
    fn from(e: dr_store::StoreError) -> Self {
        WriteError::Store(e)
    }
}
