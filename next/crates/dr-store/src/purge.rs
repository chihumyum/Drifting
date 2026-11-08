//! What was purged on this device (`purged_doc`, migration 0005), so sync
//! and imports cannot bring it back.
//!
//! - [`Library::purge_doc`] deletes a document with everything stored for it
//!   and, in the same transaction, records it here.
//! - A **book** counts as purged once its last stored document has been
//!   purged: some purged document names it and no stored one does. Its
//!   device-local state ([`crate::local_state`]), its Agent journals
//!   ([`crate::agent`]) and the Agent settlements of its documents go then
//!   too. Purging a document an Agent session names as its conversation
//!   drops that session's journal at once.
//! - Creating a purged document again ([`crate::OpenDoc::CreateIfMissing`],
//!   [`Library::register`]), or creating any document in a purged book, is
//!   refused with [`StoreError::Purged`]: a remote update for a deleted book
//!   stays out. Opening one with [`crate::OpenDoc::Existing`] is
//!   [`StoreError::NotFound`] as before (nothing is stored); [`Library::purged`]
//!   tells the two apart.
//! - Records are kept for good (they are small). Bringing something back on
//!   purpose (the author imports the same 0.1 library again, or the sync
//!   service says another device restored it) first forgets the record:
//!   [`Library::forget_purged`], [`Library::forget_purged_book`].
//!
//! How a purge reaches the sync service and other devices is the sync
//! module's (M36); the list it needs is [`Library::purged_docs`].

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::events::{LocalChange, LocalChangeKind};
use crate::{Library, now_ms};

/// The table name purge records carry ([`LocalChange::table`]).
pub const TABLE: &str = "purged_doc";

/// A document purged on this device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurgedDoc {
    pub doc_id: String,
    pub kind: String,
    pub book_id: Option<String>,
    pub purged_ms: i64,
}

fn purged_doc(r: &rusqlite::Row<'_>) -> rusqlite::Result<PurgedDoc> {
    Ok(PurgedDoc {
        doc_id: r.get(0)?,
        kind: r.get(1)?,
        book_id: r.get(2)?,
        purged_ms: r.get(3)?,
    })
}

pub(crate) fn is_purged(conn: &Connection, doc_id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM purged_doc WHERE doc_id = ?1")?
        .query_row([doc_id], |_| Ok(()))
        .optional()?
        .is_some())
}

pub(crate) fn book_purged(conn: &Connection, book_id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM purged_doc WHERE book_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM loro_doc WHERE book_id = ?1)",
        )?
        .query_row([book_id], |r| r.get(0))?)
}

/// Refuse to create `doc_id` (in `book_id`) when it, or its book, was
/// purged. Run inside the creating transaction.
pub(crate) fn check_creatable(
    conn: &Connection,
    doc_id: &str,
    book_id: Option<&str>,
) -> Result<()> {
    if is_purged(conn, doc_id)? || book_id.map(|b| book_purged(conn, b)).transpose()? == Some(true)
    {
        return Err(StoreError::Purged(doc_id.into()));
    }
    Ok(())
}

/// Record `doc_id` as purged inside the purging transaction (after its
/// `loro_doc` row is gone). Returns the local changes to announce after the
/// commit.
pub(crate) fn record(
    conn: &Connection,
    doc_id: &str,
    kind: &str,
    book_id: Option<&str>,
) -> Result<Vec<LocalChange>> {
    conn.execute(
        "INSERT INTO purged_doc (doc_id, kind, book_id, purged_ms) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (doc_id) DO UPDATE SET kind = excluded.kind, book_id = excluded.book_id,
           purged_ms = excluded.purged_ms",
        params![doc_id, kind, book_id, now_ms()],
    )?;
    let mut changes = vec![LocalChange::new(TABLE, doc_id, LocalChangeKind::Insert)];
    // The Agent sessions whose conversation this document was. By the id
    // the sessions name, not by the kind: the store knows no kind names.
    changes.extend(crate::agent::forget(conn, Some(doc_id), None)?);
    if let Some(book) = book_id
        && book_purged(conn, book)?
    {
        changes.extend(crate::local_state::forget_book(conn, book)?);
        changes.extend(crate::agent::forget(conn, None, Some(book))?);
        changes.extend(forget_settlements(conn, book)?);
    }
    Ok(changes)
}

/// Drop the Agent settlements of a purged book's documents. While the book
/// lives they stay, even for a document purged alone (the sessions that
/// made them still show them); once the book is gone nothing can be undone
/// and their summaries are the book's last words on this device.
fn forget_settlements(conn: &Connection, book_id: &str) -> Result<Vec<LocalChange>> {
    let deleted = conn
        .prepare_cached(
            "DELETE FROM agent_settlement
             WHERE doc_id IN (SELECT doc_id FROM purged_doc WHERE book_id = ?1)",
        )?
        .execute([book_id])?;
    Ok(if deleted > 0 {
        vec![LocalChange::new(
            "agent_settlement",
            book_id,
            LocalChangeKind::Delete,
        )]
    } else {
        Vec::new()
    })
}

impl Library {
    /// The purge record of `doc_id`, if it was purged on this device.
    pub fn purged(&self, doc_id: &str) -> Result<Option<PurgedDoc>> {
        Ok(self
            .reader()
            .query_row(
                "SELECT doc_id, kind, book_id, purged_ms FROM purged_doc WHERE doc_id = ?1",
                [doc_id],
                purged_doc,
            )
            .optional()?)
    }

    /// Documents purged on this device, oldest first; with `book_id`, only
    /// that book's.
    pub fn purged_docs(&self, book_id: Option<&str>) -> Result<Vec<PurgedDoc>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT doc_id, kind, book_id, purged_ms FROM purged_doc
             WHERE ?1 IS NULL OR book_id = ?1 ORDER BY purged_ms, doc_id",
        )?;
        let rows = stmt
            .query_map(params![book_id], purged_doc)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Whether `book_id` was purged: a document of it was, and none is
    /// stored any more.
    pub fn book_purged(&self, book_id: &str) -> Result<bool> {
        book_purged(&self.reader(), book_id)
    }

    /// Let `doc_id` be created again (it stays deleted until someone does).
    /// False when there was no record.
    pub fn forget_purged(&self, doc_id: &str) -> Result<bool> {
        self.local_write(|tx| {
            let n = tx.execute("DELETE FROM purged_doc WHERE doc_id = ?1", [doc_id])?;
            if n > 0 {
                tx.changed(LocalChange::new(TABLE, doc_id, LocalChangeKind::Delete));
            }
            Ok(n > 0)
        })
    }

    /// Let `book_id` and its documents be created again; returns how many
    /// records went.
    pub fn forget_purged_book(&self, book_id: &str) -> Result<usize> {
        self.local_write(|tx| {
            let ids: Vec<String> = tx
                .prepare("SELECT doc_id FROM purged_doc WHERE book_id = ?1")?
                .query_map([book_id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            tx.execute("DELETE FROM purged_doc WHERE book_id = ?1", [book_id])?;
            for id in &ids {
                tx.changed(LocalChange::new(TABLE, id, LocalChangeKind::Delete));
            }
            Ok(ids.len())
        })
    }
}
