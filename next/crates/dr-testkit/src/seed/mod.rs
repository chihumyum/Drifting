//! The one seed generator (`dr_testkit::seed`).
//!
//! ```no_run
//! use dr_testkit::seed::{self, Preset};
//! let seeded = seed::generate(Preset::Lite, seed::DEFAULT_SEED).unwrap();
//! println!("{}", seeded.shape().to_json());
//! ```
//!
//! - [`generate`] builds every document in memory through dr-doc: one book
//!   document and its prose documents per book, deterministic peers and
//!   timestamps, so a preset and a seed always give byte-identical
//!   documents and the same [`Shape`].
//! - [`Seeded::write_to`] stores them in a dr-store library (origin
//!   `import`), the way the 0.1 importer does.
//! - The showcase preset and the two sample books come from
//!   [`crate::samples`].

mod build;
mod preset;
mod shape;

use dr_doc::Result;
use dr_doc::loro_types::VersionVector;
use dr_model::DocId;

pub use build::{SeededBook, T0};
pub use preset::{Budget, Preset, Spec, allocate};
pub use shape::{GroupShape, Shape};

pub(crate) use build::{Builder, day_before_t0, id as build_id, positions};

/// The seed every preset uses unless told otherwise.
pub const DEFAULT_SEED: u64 = 0x5EED_0F08;

/// What [`generate`] made.
pub struct Seeded {
    pub preset: Preset,
    pub seed: u64,
    pub books: Vec<SeededBook>,
}

/// Build a preset. The showcase preset ignores `seed` for its fixed books
/// and uses it for the shelf's synthetic text.
pub fn generate(preset: Preset, seed: u64) -> Result<Seeded> {
    let books = match preset.spec() {
        Some(spec) => vec![build::synthetic(&spec, preset.name(), seed)?],
        None => crate::samples::showcase(seed)?,
    };
    Ok(Seeded {
        preset,
        seed,
        books,
    })
}

impl Seeded {
    /// Counts, sizes and the corpus fingerprint of every book together.
    pub fn shape(&self) -> Shape {
        Shape::of(self.preset.name(), self.seed, &self.books)
    }

    /// Store every document in `lib` (origin `import`): each document's
    /// genesis, then its whole history as one update, compacted. Documents
    /// already in the library are left alone. Returns how many were written.
    pub fn write_to(&self, lib: &dr_store::Library) -> std::result::Result<usize, WriteError> {
        let mut written = 0;
        for b in &self.books {
            written += write_book(lib, b)?;
        }
        Ok(written)
    }
}

/// Store one seeded book; see [`Seeded::write_to`].
pub fn write_book(
    lib: &dr_store::Library,
    b: &SeededBook,
) -> std::result::Result<usize, WriteError> {
    let book = b.book_id().as_str();
    let mut written = 0;
    let mut store = |doc_id: &DocId, genesis: Vec<u8>, bytes: Vec<u8>| -> dr_store::Result<()> {
        let id = doc_id.to_string();
        if lib.doc_info(&id)?.is_some() {
            return Ok(());
        }
        let h = lib.open_doc(
            &id,
            dr_store::OpenDoc::CreateIfMissing {
                kind: doc_id.kind().prefix(),
                book_id: Some(book),
                genesis: &move |d: &loro::LoroDoc| {
                    d.import(&genesis)
                        .expect("dr-doc's genesis imports into an empty document");
                },
            },
        )?;
        h.import(bytes, dr_store::Origin::Import)?;
        h.compact_now()?;
        h.close();
        written += 1;
        Ok(())
    };
    let all = VersionVector::default();
    for p in &b.prose {
        store(
            p.doc_id(),
            dr_doc::prose::genesis(p.doc_id()),
            p.export_updates_since(&all)?,
        )?;
    }
    store(
        b.book.doc_id(),
        dr_doc::book::genesis(b.book_id()),
        b.book.export_updates_since(&all)?,
    )?;
    Ok(written)
}

/// Why storing a seed failed.
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

/// Library options for a seeded library: dr-doc's style configuration.
pub fn library_options(app_version: &str) -> dr_store::LibraryOptions {
    let mut o = dr_store::LibraryOptions::new(app_version);
    o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
    o
}
