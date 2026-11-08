//! Once per library: the built-in samples land in a new library, both or
//! neither (see the crate documentation).

use std::sync::Mutex;
use std::time::Instant;

use dr_store::Library;
use dr_workspace::Workspace;
use serde::{Deserialize, Serialize};

use crate::build::SeededBook;
use crate::store;

/// Interrupted or failed attempts are retried on later launches up to this
/// many attempts in all; then the library is `skipped`.
pub const MAX_ATTEMPTS: u32 = 3;

/// The recipe a library received, recorded in the marker (the 0.1 client's
/// name for the same two books).
pub const RECIPE: &str = "pride-and-prejudice-v1+a-q-zhengzhuan-v1";

/// Where the marker lives: dr-store's device-local state, under this scope
/// and key, tied to no book (purging a sample must not forget it).
pub const MARKER_SCOPE: &str = "samples";
pub const MARKER_KEY: &str = "built-in";

/// [`Outcome::Skipped`]: the library had a book (live or in Recently
/// Deleted), or had one deleted for good, before the samples came.
pub const NOT_A_NEW_LIBRARY: &str = "not-a-new-library";
/// [`Outcome::Skipped`]: [`MAX_ATTEMPTS`] attempts failed.
pub const ATTEMPTS_EXHAUSTED: &str = "attempts-exhausted";
/// [`Outcome::Skipped`]: the marker is not one this version wrote (a newer
/// version's, say); the library is left as it is.
pub const UNKNOWN_MARKER: &str = "unknown-marker";

/// What [`ensure_built_in`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Both samples were written now: their book ids, in shelf order
    /// (*Pride and Prejudice* first).
    Created { books: Vec<String> },
    /// This library received them before (they may have been deleted since;
    /// they never come back).
    AlreadyDone,
    /// This library does not get them: [`NOT_A_NEW_LIBRARY`],
    /// [`ATTEMPTS_EXHAUSTED`] or [`UNKNOWN_MARKER`].
    Skipped { reason: String },
    /// This attempt failed and nothing of it is left on the shelf; a later
    /// launch tries again while fewer than [`MAX_ATTEMPTS`] attempts were
    /// made. `attempts` counts this one.
    Failed { error: String, attempts: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    /// Claimed, not complete (or interrupted by a quit).
    Creating,
    /// Written once; never written again, even after deletion.
    Created,
    /// Rolled back; retried while attempts remain.
    Failed,
    /// The library had other content, or attempts ran out.
    Skipped,
}

/// The marker's stored value (JSON).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Marker {
    status: Status,
    recipe: String,
    /// The sample books this attempt claimed, in shelf order.
    #[serde(default)]
    books: Vec<String>,
    #[serde(default)]
    attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// How long the created samples took, for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

/// One run at a time in this process (a second caller waits, then finds
/// the marker).
static RUNNING: Mutex<()> = Mutex::new(());

/// Once per library: write *Pride and Prejudice* and 《阿Q正传》 into the
/// library under `ws` (both or neither), record the marker, and say which
/// books were made. Slow (seconds): run it off the main thread, before the
/// shelf first opens a book (a partial sample left by an interrupted launch
/// is removed here, which an open book would refuse). Failures come back as
/// [`Outcome::Failed`]; the lay-out runs under `catch_unwind`.
pub fn ensure_built_in(ws: &Workspace) -> Outcome {
    let _running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let lib = ws.library();
    let marker = match read_marker(lib) {
        Ok(m) => m,
        Err(Unreadable::Unknown) => {
            return Outcome::Skipped {
                reason: UNKNOWN_MARKER.into(),
            };
        }
        Err(Unreadable::Store(error)) => return Outcome::Failed { error, attempts: 0 },
    };
    let mut attempts = marker.as_ref().map_or(0, |m| m.attempts);
    match &marker {
        Some(m) if m.status == Status::Created => return Outcome::AlreadyDone,
        Some(m) if m.status == Status::Skipped => {
            return Outcome::Skipped {
                reason: m.reason.clone().unwrap_or_else(|| NOT_A_NEW_LIBRARY.into()),
            };
        }
        // An earlier attempt was interrupted, or could not clean up after
        // itself: its books were never complete. Remove them first (only
        // what the marker claimed: nothing else is ever removed here).
        Some(m) => {
            if let Err(error) = discard(lib, &m.books) {
                return Outcome::Failed { error, attempts };
            }
        }
        None => {}
    }
    let books = crate::book_ids();
    match has_content(lib) {
        Ok(false) => {}
        Ok(true) => return skip(lib, NOT_A_NEW_LIBRARY, attempts),
        Err(error) => return Outcome::Failed { error, attempts },
    }
    if attempts >= MAX_ATTEMPTS {
        return skip(lib, ATTEMPTS_EXHAUSTED, attempts);
    }
    attempts += 1;
    let started = Instant::now();
    // The claim names every book before any is written, so a later launch
    // knows what to remove after a quit midway.
    if let Err(error) = write_marker(lib, Status::Creating, &books, attempts, None, None) {
        return Outcome::Failed {
            error,
            attempts: attempts - 1,
        };
    }
    let result = write_all(lib, &books).and_then(|()| {
        let ms = started.elapsed().as_millis() as u64;
        write_marker(lib, Status::Created, &books, attempts, None, Some(ms)).map_err(Failure::Error)
    });
    match result {
        Ok(()) => {
            log::info!(
                "built-in samples created in {} ms",
                started.elapsed().as_millis()
            );
            Outcome::Created { books }
        }
        Err(failure) => {
            // Nothing of this attempt stays; if even that fails, the claim
            // stays `creating` and the next launch removes it.
            let cleaned = discard(lib, &books);
            if let Err(e) = &cleaned {
                log::warn!("the partial built-in samples could not be removed yet: {e}");
            }
            match failure {
                Failure::NoLongerNew if cleaned.is_ok() => {
                    skip(lib, NOT_A_NEW_LIBRARY, attempts - 1)
                }
                Failure::NoLongerNew => Outcome::Failed {
                    error: "another book arrived while the samples were written".into(),
                    attempts,
                },
                Failure::Error(error) => {
                    log::warn!("the built-in samples were not created: {error}");
                    if cleaned.is_ok()
                        && let Err(e) = write_marker(
                            lib,
                            Status::Failed,
                            &books,
                            attempts,
                            Some(error.clone()),
                            None,
                        )
                    {
                        log::warn!("could not record the failed built-in samples: {e}");
                    }
                    Outcome::Failed { error, attempts }
                }
            }
        }
    }
}

enum Failure {
    /// Another book appeared while the samples were written.
    NoLongerNew,
    Error(String),
}

impl From<String> for Failure {
    fn from(e: String) -> Self {
        Failure::Error(e)
    }
}

/// Lay out both books, store every prose document, check that the library
/// is still new, then store the book documents (the moment they show on
/// the shelf) and bring their derived index up to date. 《阿Q正传》 is
/// written first, so *Pride and Prejudice*, changed last, leads the shelf.
fn write_all(lib: &Library, books: &[String]) -> Result<(), Failure> {
    let laid_out = std::panic::catch_unwind(|| [crate::pride_and_prejudice(), crate::a_q()])
        .map_err(|p| {
            let what = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            format!("laying out the samples panicked: {what}")
        })?;
    let mut samples: Vec<SeededBook> = Vec::new();
    for b in laid_out {
        samples.push(b.map_err(|e| e.to_string())?);
    }
    debug_assert!(
        samples
            .iter()
            .map(|b| b.book_id().to_string())
            .eq(books.iter().cloned())
    );
    for b in samples.iter().rev() {
        store::write_prose_docs(lib, b).map_err(|e| e.to_string())?;
    }
    if has_content(lib)? {
        return Err(Failure::NoLongerNew);
    }
    for b in samples.iter().rev() {
        store::write_book_doc(lib, b).map_err(|e| e.to_string())?;
    }
    // The shelf's word counts come from the derived index; it is rebuilt
    // when the library opens anyway, so a failure here costs nothing more.
    for doc in samples.iter().flat_map(store::doc_ids) {
        if let Err(e) = lib.reindex_doc(&doc) {
            log::warn!("{doc}: indexing the sample failed: {e}");
        }
    }
    Ok(())
}

/// Whether the library has (or had) a book: one stored (live or in Recently
/// Deleted), or one deleted for good on this device. A sample book already
/// here without a claim of ours (sync, an import) counts too, so nothing
/// this function did not write is ever removed by it. The samples' own prose
/// documents are no book documents, so the check just before their book
/// documents are stored still holds.
fn has_content(lib: &Library) -> Result<bool, String> {
    let stored = lib.docs(None, Some("book")).map_err(|e| e.to_string())?;
    if !stored.is_empty() {
        return Ok(true);
    }
    let purged = lib.purged_docs(None).map_err(|e| e.to_string())?;
    Ok(purged.iter().any(|d| d.kind == "book"))
}

/// Remove every stored document of `books` (prose first, the book document
/// last, as F3's permanent delete does) and forget that they were purged,
/// so a later attempt can write the same ids again. They were never
/// complete, so nobody saw them.
fn discard(lib: &Library, books: &[String]) -> Result<(), String> {
    for book in books.iter().rev() {
        let book_doc = format!("book:{book}");
        let mut docs: Vec<String> = lib
            .docs(Some(book), None)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
        docs.sort_by_key(|d| *d == book_doc);
        for d in &docs {
            lib.purge_doc(d).map_err(|e| format!("{d}: {e}"))?;
        }
        lib.forget_purged_book(book).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn skip(lib: &Library, reason: &str, attempts: u32) -> Outcome {
    if let Err(e) = write_marker(
        lib,
        Status::Skipped,
        &[],
        attempts,
        Some(reason.into()),
        None,
    ) {
        log::warn!("could not record the skipped built-in samples: {e}");
    }
    Outcome::Skipped {
        reason: reason.into(),
    }
}

/// Why the marker could not be read.
enum Unreadable {
    /// Not a marker this version wrote.
    Unknown,
    /// The library could not be read.
    Store(String),
}

fn read_marker(lib: &Library) -> Result<Option<Marker>, Unreadable> {
    let Some(value) = lib
        .local_get(MARKER_SCOPE, MARKER_KEY)
        .map_err(|e| Unreadable::Store(e.to_string()))?
    else {
        return Ok(None);
    };
    serde_json::from_str(&value).map(Some).map_err(|e| {
        log::warn!("the built-in samples' marker is not one this version wrote: {e}");
        Unreadable::Unknown
    })
}

fn write_marker(
    lib: &Library,
    status: Status,
    books: &[String],
    attempts: u32,
    reason: Option<String>,
    duration_ms: Option<u64>,
) -> Result<(), String> {
    let marker = Marker {
        status,
        recipe: RECIPE.into(),
        books: books.to_vec(),
        attempts,
        reason,
        duration_ms,
    };
    let value = serde_json::to_string(&marker).map_err(|e| e.to_string())?;
    lib.local_set(MARKER_SCOPE, MARKER_KEY, &value, None)
        .map_err(|e| e.to_string())
}
