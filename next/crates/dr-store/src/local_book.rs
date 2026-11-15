//! Books that stay on this device (`local_book`, migration 0008).
//!
//! dr-workspace edits a project template in a working copy: a project made
//! from the template that never leaves the device (`project-templates.md`
//! §12, `handoff/v5-tracks.md` DW). The store is where what leaves the
//! device is decided, so it keeps the mark:
//!
//! - [`Library::keep_local`] marks a book before its first document is
//!   written, so no sync cycle in between can see one.
//! - Sync's lists leave a marked book out: [`Library::docs_with_local_changes`],
//!   [`Library::export_for_upload`], [`Library::syncable_docs`] (the documents
//!   sync may register), [`Library::purged_docs`] and
//!   [`Library::assets_pending_upload`].
//! - A mark is kept for good (it is small), like a purge record: purging the
//!   book's documents records them as purged as usual, and those records
//!   never upload either. [`Library::local_books`] lists only the marked
//!   books that still have a stored document.
//! - `note` belongs to the module that marked the book; the store never
//!   reads it.

use rusqlite::{OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::events::{LocalChange, LocalChangeKind};
use crate::library::DocInfo;
use crate::{Library, now_ms};

/// The table name local-book changes carry ([`LocalChange::table`]).
pub const TABLE: &str = "local_book";

/// A book kept on this device that still has a stored document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalBook {
    pub book_id: String,
    pub note: String,
    pub created_ms: i64,
}

impl Library {
    /// Keep `book_id` on this device from now on: sync never lists its
    /// documents, asset bytes or purge records. Call it before the book's
    /// first document is written. Refused for a book that already has a
    /// stored document or was marked before.
    pub fn keep_local(&self, book_id: &str, note: &str) -> Result<()> {
        if book_id.is_empty() {
            return Err(StoreError::invalid("local book", book_id));
        }
        self.local_write(|tx| {
            let stored: bool = tx
                .prepare_cached("SELECT EXISTS (SELECT 1 FROM loro_doc WHERE book_id = ?1)")?
                .query_row([book_id], |r| r.get(0))?;
            let marked: bool = tx
                .prepare_cached("SELECT EXISTS (SELECT 1 FROM local_book WHERE book_id = ?1)")?
                .query_row([book_id], |r| r.get(0))?;
            if stored || marked {
                return Err(StoreError::invalid(
                    "local book",
                    format!("{book_id} already has documents"),
                ));
            }
            tx.prepare_cached(
                "INSERT INTO local_book (book_id, note, created_ms) VALUES (?1, ?2, ?3)",
            )?
            .execute(params![book_id, note, now_ms()])?;
            tx.changed(LocalChange::new(TABLE, book_id, LocalChangeKind::Insert));
            Ok(())
        })
    }

    /// `book_id`, when it is kept on this device and still has a stored
    /// document.
    pub fn local_book(&self, book_id: &str) -> Result<Option<LocalBook>> {
        Ok(self
            .reader()
            .prepare_cached(
                "SELECT book_id, note, created_ms FROM local_book l WHERE book_id = ?1
                   AND EXISTS (SELECT 1 FROM loro_doc d WHERE d.book_id = l.book_id)",
            )?
            .query_row([book_id], |r| {
                Ok(LocalBook {
                    book_id: r.get(0)?,
                    note: r.get(1)?,
                    created_ms: r.get(2)?,
                })
            })
            .optional()?)
    }

    /// The books kept on this device that still have a stored document,
    /// oldest first.
    pub fn local_books(&self) -> Result<Vec<LocalBook>> {
        Ok(self
            .reader()
            .prepare_cached(
                "SELECT book_id, note, created_ms FROM local_book l
                 WHERE EXISTS (SELECT 1 FROM loro_doc d WHERE d.book_id = l.book_id)
                 ORDER BY created_ms, book_id",
            )?
            .query_map([], |r| {
                Ok(LocalBook {
                    book_id: r.get(0)?,
                    note: r.get(1)?,
                    created_ms: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Whether `doc_id` belongs to a book kept on this device.
    pub fn is_local_doc(&self, doc_id: &str) -> Result<bool> {
        Ok(self
            .reader()
            .prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM loro_doc WHERE doc_id = ?1
                   AND book_id IN (SELECT book_id FROM local_book))",
            )?
            .query_row([doc_id], |r| r.get(0))?)
    }

    /// Every stored document sync may know of: [`Library::docs`] of the
    /// whole library without the books kept on this device.
    pub fn syncable_docs(&self) -> Result<Vec<DocInfo>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT doc_id, kind, book_id FROM loro_doc
             WHERE book_id IS NULL OR book_id NOT IN (SELECT book_id FROM local_book)
             ORDER BY doc_id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DocInfo {
                    doc_id: r.get(0)?,
                    kind: r.get(1)?,
                    book_id: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
}

impl Library {
    /// Replace the note of a book kept on this device (its owner's record).
    /// False when the book was never marked.
    pub fn set_local_note(&self, book_id: &str, note: &str) -> Result<bool> {
        self.local_write(|tx| {
            let n = tx
                .prepare_cached(
                    "UPDATE local_book SET note = ?2 WHERE book_id = ?1 AND note != ?2",
                )?
                .execute(params![book_id, note])?;
            if n > 0 {
                tx.changed(LocalChange::new(TABLE, book_id, LocalChangeKind::Update));
            }
            let marked: bool = tx
                .prepare_cached("SELECT EXISTS (SELECT 1 FROM local_book WHERE book_id = ?1)")?
                .query_row([book_id], |r| r.get(0))?;
            Ok(marked)
        })
    }
}
