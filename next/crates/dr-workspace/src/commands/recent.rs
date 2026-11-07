//! What the author opened recently, per book (the 0.1 client's
//! `recent-entities-store`): Project Home's 「继续写」 starts from it.
//!
//! - Device-local, as in 0.1 (it was localStorage): kept in the library
//!   database, never synced; each device continues where it was.
//! - An entry is a page the author opened: a chapter, an idea (both
//!   `node`), an element, a storyline, a category or a material, and when.
//! - `recent.touch` moves a page to the front (no duplicates) and keeps the
//!   newest [`RECENT_KEEP`] of each book. It is not an author's step: no
//!   journal row, nothing to undo.
//! - `recent.list` gives a book's entries, newest first, leaving out what is
//!   in the trash or gone; the shell decides what 「继续写」 opens (0.1: the
//!   newest `node`, else the chapter changed last).
//! - Purging a book drops its entries.
//!
//! Stored as one JSON value under `ws` / `recent` in dr-store's small
//! device-local table (`local_state`, migration 0004, which moved the value
//! over from `library_meta`), written through `Library::local_write`.

use dr_model::id::BookId;
use dr_store::{LocalChange, LocalChangeKind};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::dto::Target;
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<RecentTouch>().add::<RecentList>();
}

/// Entries kept per book (the 0.1 default).
pub const RECENT_KEEP: usize = 10;

/// Where the list lives in dr-store's `local_state`.
const SCOPE: &str = "ws";
const KEY: &str = "recent";

/// One page opened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecentEntry {
    pub book: String,
    pub target: Target,
    /// When (ms since the epoch).
    pub used_ms: i64,
}

fn read_all(lib: &dr_store::Library) -> Result<Vec<RecentEntry>> {
    let raw = lib.local_get(SCOPE, KEY)?;
    // A value this build cannot read starts the list afresh.
    Ok(raw
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default())
}

/// Rewrite the list with `f` in one local transaction.
fn update(
    lib: &dr_store::Library,
    book: &str,
    f: impl FnOnce(&mut Vec<RecentEntry>),
) -> Result<()> {
    Ok(lib.local_write(|tx| {
        let raw = tx.get_state(SCOPE, KEY)?;
        let mut all: Vec<RecentEntry> = raw
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        f(&mut all);
        // Plain strings and numbers: serialising cannot fail.
        let json = serde_json::to_string(&all).unwrap_or_else(|_| "[]".to_string());
        tx.set_state(SCOPE, KEY, &json, None)?;
        tx.changed(LocalChange::new("recent", book, LocalChangeKind::Update));
        Ok(())
    })?)
}

/// Drop a purged book's entries.
pub(crate) fn forget_book(lib: &dr_store::Library, book: &str) -> Result<()> {
    if read_all(lib)?.iter().all(|e| e.book != book) {
        return Ok(());
    }
    update(lib, book, |all| all.retain(|e| e.book != book))
}

/// The page kinds an entry may name.
const KINDS: &[&str] = &["node", "element", "storyline", "category", "material"];

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RecentTouchIn {
    pub book: String,
    pub target: Target,
}

op! {
    RecentTouch = "recent.touch", Write, Book,
    "Record that the author opened a page of a book (this device only; Project Home's 「继续写」 reads it). Not undoable.",
    fn(cx, input: RecentTouchIn) -> Done {
        let book: BookId = pid("book", &input.book)?;
        if !KINDS.contains(&input.target.kind.as_str()) {
            return Err(WsError::invalid(format!("{:?} is not a page", input.target.kind)));
        }
        let slot = cx.book(book.as_str())?;
        require_live(&slot, input.target.to_ref().kind, &input.target.id)?;
        let entry = RecentEntry { book: input.book.clone(), target: input.target.clone(), used_ms: now_ms() };
        update(cx.workspace().library(), &input.book, move |all| {
            all.retain(|e| !(e.book == entry.book && e.target == entry.target));
            all.insert(0, entry.clone());
            let mut seen = 0;
            all.retain(|e| {
                if e.book != entry.book { return true; }
                seen += 1;
                seen <= RECENT_KEEP
            });
        })?;
        cx.undo_nothing();
        Ok(Done { id: input.target.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RecentListIn {
    pub book: String,
    /// At most this many (default and most: 10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

op! {
    RecentList = "recent.list", Read, Shared,
    "List the pages of a book the author opened recently on this device, newest first (what is in the trash or gone is left out).",
    fn(cx, input: RecentListIn) -> Vec<RecentEntry> {
        let slot = cx.book(&input.book)?;
        let limit = input.limit.unwrap_or(RECENT_KEEP).clamp(1, RECENT_KEEP);
        Ok(read_all(cx.workspace().library())?
            .into_iter()
            .filter(|e| e.book == input.book && is_live(&slot, &e.target.to_ref()))
            .take(limit)
            .collect())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
