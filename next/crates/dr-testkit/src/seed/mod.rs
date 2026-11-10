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

pub mod acceptance;
mod build;

mod digest;
mod plan;
mod preset;
mod shape;
pub mod v3;

use dr_doc::Result;

pub use build::{SeededBook, T0};

pub use digest::digest;
pub use preset::{Budget, Preset, Spec, allocate};
pub use shape::{GroupShape, Shape};
pub use v3::{
    BuilderV3, SeededBookV3, SeededV3, book_to_v3, digest_v3, generate_v3, write_book_v3,
};

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
        Some(spec) => vec![build::write_direct(&plan::synthetic(
            &spec,
            preset.name(),
            seed,
        ))?],
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

// Source-format writer lives only in the testkit. The App sample writer
// is dr_samples::v3::write_book; there is no old persistent product path.
pub use dr_samples::WriteError;
mod source_store;
pub use source_store::write_book;

/// Library options for a seeded library: dr-doc's style configuration.
pub fn library_options(app_version: &str) -> dr_store::LibraryOptions {
    let mut o = dr_store::LibraryOptions::new(app_version);
    o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
    o
}

/// A previous-format synthetic source for refusal and import-boundary tests.
/// This is never offered by the App/CLI seed selector.
pub fn write_source_fixture(lib: &dr_store::Library) -> std::result::Result<String, WriteError> {
    let source = generate(Preset::Tiny, DEFAULT_SEED + 0x100)?;
    let id = source.books[0].book_id().to_string();
    source.write_to(lib)?;
    Ok(id)
}
