//! Books, project facts (项目设定) and Project Memory.

use dr_model::id::BookId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::BookInfo;
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<BookList>()
        .add::<BookGet>()
        .add::<BookUpdate>()
        .add::<BookTrash>()
        .add::<BookRestore>()
        .add::<BookShelf>()
        .add::<BookPurge>()
        .add::<BookPurgeExpired>();
}

// ---- books ----------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BookCreateIn {
    pub name: String,
    #[serde(default)]
    pub summary: String,
}

op! {
    BookList = "book.list", Read, Shared,
    "List the library's books (trashed ones when asked).",
    fn(cx, input: ListBooksIn) -> Vec<BookInfo> {
        let mut out = Vec::new();
        for d in cx.workspace().library().docs(None, Some("book"))? {
            let Some(id) = d.doc_id.strip_prefix("book:") else { continue };
            let raw = cx.workspace().library().load_copy(&d.doc_id)?;
            if !dr_doc::v3::is_book_doc(&raw) { continue; }
            let slot = cx.workspace().book_slot(&super::pid("book", id)?)?;
            let m = slot.reader_v3.view().meta();
            if m.deleted_at.is_none() || input.trashed {
                out.push(BookInfo::from(&m));
            }
        }
        Ok(out)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ListBooksIn {
    #[serde(default)]
    pub trashed: bool,
}

op! {
    BookTrash = "book.trash", Write, Book,
    "Move a book to the trash (restorable; storage deletes it for good later).",
    fn(cx, input: BookIn) -> Done {
        let slot = cx.book(&input.book)?;
        cx.write_book_v3(&slot, Replaces::record(dr_doc::v3::CollectionV3::Meta, "deleted_at"), |txn| { txn.meta().deleted_at(Some(now()))?; Ok(()) })?;
        cx.effect(EffectAction::Trashed, "book", &input.book, Some(&slot.reader_v3.view().meta().name));
        cx.undo_with(Invocation::new("book.restore", &input));
        Ok(Done { id: input.book })
    }
}

op! {
    BookRestore = "book.restore", Write, Book,
    "Bring a book back from the trash.",
    fn(cx, input: BookIn) -> Done {
        let slot = cx.book(&input.book)?;
        cx.write_book_v3(&slot, Replaces::record(dr_doc::v3::CollectionV3::Meta, "deleted_at"), |txn| { txn.meta().deleted_at(None)?; Ok(()) })?;
        cx.effect(EffectAction::Restored, "book", &input.book, Some(&slot.reader_v3.view().meta().name));
        cx.undo_with(Invocation::new("book.trash", &input));
        Ok(Done { id: input.book })
    }
}

// ---- the shelf and the trash ---------------------------------------------------

/// Days a book stays in Recently Deleted before it goes for good (the 0.1
/// shelf's rule).
pub const BOOK_TRASH_DAYS: i64 = 30;

const DAY_SECS: i64 = 86_400;

/// One book as the bookshelf shows it.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ShelfBook {
    #[serde(flatten)]
    pub info: BookInfo,
    /// The 「副标题」 project fact, trimmed, when it has a value.
    pub subtitle: Option<String>,
    /// Live chapters, storylines and elements.
    pub chapters: u32,
    pub storylines: u32,
    pub elements: u32,
    /// Words in the live chapters only (not ideas, elements or notes), as
    /// the derived index counts them.
    pub words: Option<u64>,
    /// The newest stored change of any of its documents (Unix seconds).
    pub updated_at: Option<i64>,
    /// In Recently Deleted since (Unix seconds).
    pub deleted_at: Option<i64>,
    /// In Recently Deleted: when it goes for good (Unix seconds) …
    pub purge_at: Option<i64>,
    /// … and the whole days left until then, rounded up (0: due now).
    pub days_left: Option<i64>,
}

/// When a book trashed at `deleted_at` goes for good, and the days left at
/// `now` (all Unix seconds).
pub fn purge_due(deleted_at: i64, now: i64) -> (i64, i64) {
    let at = deleted_at + BOOK_TRASH_DAYS * DAY_SECS;
    let left = (at - now).max(0);
    (at, (left + DAY_SECS - 1) / DAY_SECS)
}

fn shelf_book(cx: &Cx<'_>, id: &BookId, now: i64) -> Result<ShelfBook> {
    let slot = cx.workspace().book_slot(id)?;
    let m = slot.reader_v3.view().meta();
    let lib = cx.workspace().library();
    let v = slot.reader_v3.view();
    let structure = v.structure_snapshot();
    let entries = structure.entries_map();
    let templates = structure.templates_map();
    let live = |e: &&dr_model::v3::Entry| {
        !e.is_trashed()
            && dr_model::v3::effective_ancestors(entries, &e.id)
                .iter()
                .all(|id| entries.get(id).is_some_and(|a| !a.is_trashed()))
    };
    // The manuscript sequence: the book's words are its book prose, its
    // chapters the entries it numbers.
    let manuscript: Vec<_> = structure
        .manuscript()
        .into_iter()
        .flat_map(|p| p.entries)
        .collect();
    let numbered: std::collections::BTreeSet<_> = manuscript
        .iter()
        .filter(|e| e.ordinal.is_some())
        .map(|e| e.entry.id.clone())
        .collect();
    let mut words = Some(0u64);
    for doc in manuscript
        .iter()
        .flat_map(|e| e.prose.iter().map(|p| p.doc.to_string()))
    {
        let count = if lib.doc_info(&doc)?.is_none() {
            Some(0)
        } else {
            match lib.head(&doc)? {
                None => Some(0),
                Some(head) => lib
                    .doc_stats(&doc)?
                    .filter(|s| s.indexed_seq == head.seq)
                    .map(|s| s.words),
            }
        };
        words = words.zip(count).map(|(a, b)| a + b);
    }
    let mut docs: Vec<String> = lib
        .docs(Some(id.as_str()), None)?
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    docs.push(dr_model::DocId::Book(id.clone()).to_string());
    let updated_at = docs
        .iter()
        .map(|d| lib.head(d).map(|h| h.map(|h| h.ts.div_euclid(1000))))
        .collect::<dr_store::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .max();
    let deleted_at = m.deleted_at.map(|t| t.0);
    let due = deleted_at.map(|d| purge_due(d, now));
    Ok(ShelfBook {
        info: BookInfo::from(&m),
        subtitle: v
            .facts()
            .iter()
            .find(|f| f.key.trim() == "副标题")
            .map(|f| f.value.trim().to_owned())
            .filter(|v| !v.is_empty()),
        chapters: numbered.len() as u32,
        storylines: entries
            .values()
            .filter(live)
            .filter(|e| e.is_lane(templates))
            .count() as u32,
        elements: entries
            .values()
            .filter(live)
            // Content entries (a `linkable` template, or none) the
            // manuscript does not number, whatever their switch.
            .filter(|e| e.is_linkable(templates) && !numbered.contains(&e.id))
            .count() as u32,
        words,
        updated_at,
        deleted_at,
        purge_at: due.map(|d| d.0),
        days_left: due.map(|d| d.1),
    })
}

op! {
    BookShelf = "book.shelf", Read, Shared,
    "Everything the bookshelf shows, in one read: every book with its counts, chapter words, creation, last change, and (in Recently Deleted) when it goes for good. Live books first, most recently changed first; then the trashed ones, most recently deleted first.",
    fn(cx, input: ListBooksIn) -> Vec<ShelfBook> {
        let now = now().0;
        let mut live = Vec::new();
        let mut trashed = Vec::new();
        for d in cx.workspace().library().docs(None, Some("book"))? {
            let Some(id) = d.doc_id.strip_prefix("book:") else { continue };
            let id: BookId = super::pid("book", id)?;
            match shelf_book(cx, &id, now) {
                Ok(b) if b.info.trashed => { if input.trashed { trashed.push(b) } }
                Ok(b) => live.push(b),
                // One unreadable book leaves the rest of the shelf.
                Err(e) => log::warn!("book {id} not on the shelf: {e}"),
            }
        }
        live.sort_by(|a, b| b.updated_at.cmp(&a.updated_at)
            .then_with(|| a.info.name.cmp(&b.info.name))
            .then_with(|| a.info.id.cmp(&b.info.id)));
        trashed.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| a.info.id.cmp(&b.info.id)));
        live.extend(trashed);
        Ok(live)
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct BookPurged {
    pub id: String,
    /// Stored documents deleted (the book's and its prose).
    pub docs: usize,
    /// Asset files deleted.
    pub assets: usize,
}

op! {
    BookPurge = "book.purge", Write, Library,
    "Delete a book in Recently Deleted for good, now: its documents, history and assets on this device. Refused for a book not in the trash or still open in an editor. Cannot be undone.",
    fn(cx, input: BookIn) -> BookPurged {
        let id: BookId = super::pid("book", &input.book)?;
        let ws = cx.workspace();
        // No command may write the book meanwhile.
        let gate = ws.book_gate(&id);
        let _lease = gate.enter();
        let (name, trashed) = {
            let slot = ws.book_slot(&id)?;
            let m = slot.reader_v3.view().meta();
            (m.name.clone(), m.deleted_at.is_some())
        };
        if !trashed {
            return Err(WsError::Conflict(format!("book {id} is not in Recently Deleted")));
        }
        let out = ws.purge_book(&id)?;
        cx.effect(EffectAction::Purged, "book", id.as_str(), Some(&name));
        cx.irreversible();
        Ok(BookPurged { id: input.book, docs: out.0, assets: out.1 })
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ExpiredPurged {
    /// The books deleted for good.
    pub purged: Vec<String>,
    /// Books that were due but are in use; the next run tries again.
    pub waiting: Vec<String>,
}

op! {
    BookPurgeExpired = "book.purge_expired", Write, Library,
    "Delete for good every book whose 30 days in Recently Deleted are over (the shelf runs it a while after it opens, so a restore made on another device can arrive first). Cannot be undone.",
    fn(cx, input: NoInput) -> ExpiredPurged {
        let ws = cx.workspace();
        let now = now().0;
        let mut out = ExpiredPurged { purged: Vec::new(), waiting: Vec::new() };
        for d in ws.library().docs(None, Some("book"))? {
            let Some(id) = d.doc_id.strip_prefix("book:") else { continue };
            let id: BookId = super::pid("book", id)?;
            let gate = ws.book_gate(&id);
            let _lease = gate.enter();
            let (name, due) = {
                let slot = ws.book_slot(&id)?;
                let m = slot.reader_v3.view().meta();
                (m.name.clone(), m.deleted_at.map(|t| purge_due(t.0, now).0))
            };
            if !due.is_some_and(|at| at <= now) { continue; }
            match ws.purge_book(&id) {
                Ok(_) => {
                    cx.effect(EffectAction::Purged, "book", id.as_str(), Some(&name));
                    out.purged.push(id.to_string());
                }
                Err(WsError::Conflict(_)) => out.waiting.push(id.to_string()),
                Err(e) => return Err(e),
            }
        }
        if !out.purged.is_empty() { cx.irreversible(); } else { cx.undo_nothing(); }
        Ok(out)
    }
}

pub use super::v3::book::{BookGet, BookUpdate, BookUpdateIn};

pub use super::v3::project::FactList;
