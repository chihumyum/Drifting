//! Once per library: the built-in samples land in a new library, both or
//! neither (see the crate documentation).

use std::sync::Mutex;
use std::time::Instant;

use dr_store::Library;
use dr_workspace::Workspace;
use serde::{Deserialize, Serialize};

use crate::v3::{MappingChoices, Pending, SampleBookV3};

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

/// Per-book ownership token recorded while an attempt is `creating`. Tied to
/// `book_id` in `local_state`, so purging a partial book's last document
/// revokes ownership in the same SQLite transaction even if updating the
/// global [`MARKER_SCOPE`] marker afterwards fails.
pub const OWNER_SCOPE: &str = "samples-owner";

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
    /// No marker, attempts or source state changed; explicit policy is missing.
    Pending { items: Vec<Pending> },
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
    /// Attempt-unique ownership token matching `local_state[OWNER_SCOPE, book]`
    /// while `status == Creating`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
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
    ensure_built_in_with(ws, &MappingChoices::default())
}

/// The ordinary once-only path with the same explicit mapping choices as
/// the import adapter. Product defaults never borrow test policy.
pub fn ensure_built_in_with(ws: &Workspace, choices: &MappingChoices) -> Outcome {
    let _running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let lib = ws.library();
    let books = crate::book_ids();
    let marker = match read_marker(lib, &books) {
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
        _ => {}
    }
    if marker.is_none() {
        match has_content(lib) {
            Ok(true) => return skip(lib, NOT_A_NEW_LIBRARY, attempts),
            Err(error) => return Outcome::Failed { error, attempts },
            Ok(false) => {}
        }
    }
    // Policy is validated before touching a prior claim or removing a partial
    // attempt. A Created marker above is terminal, even after sample deletion.
    let sources = match std::panic::catch_unwind(|| [crate::pride_and_prejudice(), crate::a_q()]) {
        Ok(sources) => sources,
        Err(_) => {
            return Outcome::Failed {
                error: "sample recipe panicked".into(),
                attempts,
            };
        }
    };
    let mut samples = Vec::new();
    let mut pending = Vec::new();
    for source in sources {
        let source = match source {
            Ok(source) => source,
            Err(error) => {
                return Outcome::Failed {
                    error: error.to_string(),
                    attempts,
                };
            }
        };
        pending.extend(choices.pending(&source.book.view()));
        if pending.is_empty() {
            match crate::v3::convert(&source, choices) {
                Ok(sample) => samples.push(sample),
                Err(error) => {
                    return Outcome::Failed {
                        error: error.to_string(),
                        attempts,
                    };
                }
            }
        }
    }
    if !pending.is_empty() {
        return Outcome::Pending { items: pending };
    }
    if let Some(m) = &marker
        && m.status == Status::Creating
    {
        if let Err(error) = cleanup_creating_marker(lib, m, &samples) {
            return Outcome::Failed { error, attempts };
        }
        if let Err(error) = write_marker(
            lib,
            Status::Failed,
            &[],
            None,
            attempts,
            Some("interrupted attempt cleaned up".into()),
            None,
        ) {
            return Outcome::Failed { error, attempts };
        }
    }
    match has_content(lib) {
        Ok(false) => {}
        Ok(true) => return skip(lib, NOT_A_NEW_LIBRARY, attempts),
        Err(error) => return Outcome::Failed { error, attempts },
    }
    if attempts >= MAX_ATTEMPTS {
        return skip(lib, ATTEMPTS_EXHAUSTED, attempts);
    }
    attempts += 1;
    let token = dr_model::id::BookId::new_v7().to_string();
    let started = Instant::now();
    // The claim names every book and a unique attempt token before any
    // document is written, so a later launch only removes partial documents
    // stamped by this attempt.
    if let Err(error) = write_marker(
        lib,
        Status::Creating,
        &books,
        Some(&token),
        attempts,
        None,
        None,
    ) {
        return Outcome::Failed {
            error,
            attempts: attempts - 1,
        };
    }
    let result = write_all(lib, &books, &samples, &token).and_then(|()| {
        let ms = started.elapsed().as_millis() as u64;
        write_marker(lib, Status::Created, &books, None, attempts, None, Some(ms))
            .map_err(Failure::Error)
    });
    match result {
        Ok(()) => {
            clear_owner_tokens(lib, &books);
            log::info!(
                "built-in samples created in {} ms",
                started.elapsed().as_millis()
            );
            Outcome::Created { books }
        }
        Err(failure) => {
            // Nothing of this attempt stays; if even that fails, the claim
            // stays `creating` and the next launch removes only owned docs.
            let cleaned = cleanup_owned_attempt(lib, &books, &token, &samples);
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
                            &[],
                            None,
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

/// Lay out both books, stamp each book's attempt ownership token, store every
/// prose document, check that the library is still new, then store the book
/// documents (the moment they show on the shelf). 《阿Q正传》 is written
/// first, so *Pride and Prejudice*, changed last, leads the shelf.
fn write_all(
    lib: &Library,
    books: &[String],
    samples: &[SampleBookV3],
    token: &str,
) -> Result<(), Failure> {
    debug_assert!(
        samples
            .iter()
            .map(|b| b.book_id().to_string())
            .eq(books.iter().cloned())
    );
    if has_content(lib)? {
        return Err(Failure::NoLongerNew);
    }
    for sample in samples.iter().rev() {
        let book = sample.book_id().as_str();
        lib.local_set(OWNER_SCOPE, book, token, Some(book))
            .map_err(|e| Failure::Error(e.to_string()))?;
        crate::v3::write_book(lib, sample).map_err(|e| Failure::Error(e.to_string()))?;
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

fn sample_for<'a>(samples: &'a [SampleBookV3], book: &str) -> Option<&'a SampleBookV3> {
    samples.iter().find(|s| s.book_id().as_str() == book)
}

fn cleanup_creating_marker(
    lib: &Library,
    marker: &Marker,
    samples: &[SampleBookV3],
) -> Result<(), String> {
    if let Some(token) = marker.token.as_deref() {
        return cleanup_owned_attempt(lib, &marker.books, token, samples);
    }
    // Legacy `Creating` marker without an attempt token: only discard a
    // claimed sample book when its stored documents are unmodified sample
    // content; any user/modified book is preserved so `has_content` skips.
    for book in marker.books.iter().rev() {
        let Some(sample) = sample_for(samples, book) else {
            continue;
        };
        if crate::v3::is_unmodified_subset(lib, sample)? {
            discard_book(lib, book)?;
        }
    }
    Ok(())
}

fn cleanup_owned_attempt(
    lib: &Library,
    books: &[String],
    token: &str,
    samples: &[SampleBookV3],
) -> Result<(), String> {
    for book in books.iter().rev() {
        let owner = lib
            .local_get(OWNER_SCOPE, book)
            .map_err(|e| e.to_string())?;
        if owner.as_deref() != Some(token) {
            continue;
        }
        if let Some(sample) = sample_for(samples, book)
            && crate::v3::is_unmodified_subset(lib, sample)?
        {
            discard_book(lib, book)?;
        }
        let _ = lib
            .local_remove(OWNER_SCOPE, book)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn clear_owner_tokens(lib: &Library, books: &[String]) {
    for book in books {
        let _ = lib.local_remove(OWNER_SCOPE, book);
    }
}

/// Remove every stored document of `book` (prose first, the book document
/// last, as F3's permanent delete does) and forget that it was purged, so a
/// later attempt can write the same id again.
fn discard_book(lib: &Library, book: &str) -> Result<(), String> {
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
    Ok(())
}

fn skip(lib: &Library, reason: &str, attempts: u32) -> Outcome {
    if let Err(e) = write_marker(
        lib,
        Status::Skipped,
        &[],
        None,
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

fn read_marker(lib: &Library, known_books: &[String]) -> Result<Option<Marker>, Unreadable> {
    let Some(value) = lib
        .local_get(MARKER_SCOPE, MARKER_KEY)
        .map_err(|e| Unreadable::Store(e.to_string()))?
    else {
        return Ok(None);
    };
    let marker: Marker = serde_json::from_str(&value).map_err(|e| {
        log::warn!("the built-in samples' marker is not one this version wrote: {e}");
        Unreadable::Unknown
    })?;
    if marker.recipe != RECIPE || marker.books.iter().any(|b| !known_books.contains(b)) {
        log::warn!(
            "the built-in samples' marker names an unknown recipe or book ({:?}, {:?})",
            marker.recipe,
            marker.books
        );
        return Err(Unreadable::Unknown);
    }
    Ok(Some(marker))
}

fn write_marker(
    lib: &Library,
    status: Status,
    books: &[String],
    token: Option<&str>,
    attempts: u32,
    reason: Option<String>,
    duration_ms: Option<u64>,
) -> Result<(), String> {
    let marker = Marker {
        status,
        recipe: RECIPE.into(),
        books: books.to_vec(),
        token: token.map(str::to_owned),
        attempts,
        reason,
        duration_ms,
    };
    let value = serde_json::to_string(&marker).map_err(|e| e.to_string())?;
    lib.local_set(MARKER_SCOPE, MARKER_KEY, &value, None)
        .map_err(|e| e.to_string())
}
