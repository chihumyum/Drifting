//! Drifting's built-in sample books: *Pride and Prejudice* (Jane Austen,
//! 1813) and 《阿Q正传》 (鲁迅, 1921–22, left half written), each taken
//! apart into a working book as the 0.1 client's samples were
//! (`docs/sample-project.md`; definitions and rights in `books/`).
//!
//! **Once per library.** [`ensure_built_in`] gives a brand-new library both
//! books, once:
//!
//! - Both land or neither does. The prose documents of both are stored
//!   first and the two book documents last (the shelf lists a book once its
//!   book document is stored), so the shelf never shows half a sample; any
//!   failure removes everything the attempt stored.
//! - A device-local marker in dr-store's `local_state` (scope
//!   [`MARKER_SCOPE`], key [`MARKER_KEY`], JSON, tied to no book) makes it
//!   once-only: `created` is never written again, so deleting a sample never
//!   brings it back; `creating` (a quit midway) and `failed` are cleaned up
//!   and retried on later launches, up to [`MAX_ATTEMPTS`] attempts in all,
//!   then `skipped`.
//! - A library that has a book (live or in Recently Deleted, a sample that
//!   came by sync or import included), or had one deleted for good, is
//!   `skipped` before anything is written, and stays so: samples never go
//!   into a library that was in use. Checked again just before the samples
//!   become visible. Only books its own marker claimed are ever removed.
//! - [`Outcome::Created`] names the two books in shelf order, so the first
//!   run can play their landing.
//!
//! The caller runs it off the main thread (laying *Pride and Prejudice* out
//! takes a moment) and decides when: a local library's first run, never an
//! account library's.
//!
//! **Fixed ids.** A sample's ids (book, chapters, elements …) are fixed per
//! sample ([`layout::sample_id`]) and its documents are byte-identical
//! every time (dr-doc's import peer, fixed timestamps), so the same sample
//! is the same book in every library and on every device.
//!
//! The lay-out ([`layout`], [`build`], [`para`], [`rng`]) is shared with
//! dr-testkit, whose seed writes its synthetic presets and the showcase
//! with it; the test kit re-exports what it used to define.

pub mod build;
mod built_in;
pub mod layout;
mod store;

/// The random number generator and the paragraph model, in `dr-corpus`
/// (no store) so dr-store's tests can use them too.
pub use dr_corpus::{para, rng};

pub use build::SeededBook;
pub use built_in::{
    ATTEMPTS_EXHAUSTED, MARKER_KEY, MARKER_SCOPE, MAX_ATTEMPTS, NOT_A_NEW_LIBRARY, Outcome, RECIPE,
    UNKNOWN_MARKER, ensure_built_in,
};
pub use store::{WriteError, write_book};

const PRIDE_AND_PREJUDICE: &str = include_str!("../books/pride-and-prejudice.json");
const A_Q: &str = include_str!("../books/a-q.json");

const PRIDE_AND_PREJUDICE_KEY: &str = "sample/pride-and-prejudice";
const A_Q_KEY: &str = "sample/a-q";

/// *Pride and Prejudice* (Jane Austen, 1813), 61 chapters, with the 0.1
/// sample's elements, storylines, notes and review items.
pub fn pride_and_prejudice() -> dr_doc::Result<SeededBook> {
    layout::from_json(
        "books/pride-and-prejudice.json",
        PRIDE_AND_PREJUDICE,
        PRIDE_AND_PREJUDICE_KEY,
    )
}

/// 《阿Q正传》 (鲁迅, 1921–22): six written chapters and three planned ones.
pub fn a_q() -> dr_doc::Result<SeededBook> {
    layout::from_json("books/a-q.json", A_Q, A_Q_KEY)
}

/// The built-in samples' book ids, in shelf order (*Pride and Prejudice*,
/// then 《阿Q正传》), without laying them out.
pub fn book_ids() -> Vec<String> {
    [PRIDE_AND_PREJUDICE_KEY, A_Q_KEY]
        .iter()
        .map(|k| layout::sample_id(k, "book", 0))
        .collect()
}
