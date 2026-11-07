//! Small device-local state of the modules (`local_state`, migration 0004):
//! what the author opened recently, a panel's width, a module's last choice.
//!
//! - One text value (usually JSON) per `(scope, key)`; `scope` names the
//!   owning module (`ws` for dr-workspace), so modules never collide.
//! - Never synced and never part of a document: each device keeps its own.
//! - A row may name its book (`book_id`); when the book's last document is
//!   purged ([`Library::purge_doc`]) its rows go in the same transaction.
//! - Writes go through [`Library::local_write`] like every local-only table,
//!   and each changed row is announced as a [`LocalChange`] on the library's
//!   bus once committed: table [`TABLE`], key `<scope>/<key>`.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::events::{LocalChange, LocalChangeKind};
use crate::library::LocalTx;
use crate::{Library, now_ms};

/// The table name local-state changes carry ([`LocalChange::table`]).
pub const TABLE: &str = "local_state";

/// Largest value stored (a guard against using it as a blob store).
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;

/// One stored value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalEntry {
    pub scope: String,
    pub key: String,
    pub value: String,
    pub book_id: Option<String>,
    pub changed_ms: i64,
}

/// The key a change of `(scope, key)` is announced under.
pub fn change_key(scope: &str, key: &str) -> String {
    format!("{scope}/{key}")
}

fn validate(scope: &str, key: &str) -> Result<()> {
    if scope.is_empty() || scope.len() > 64 || scope.contains('/') {
        return Err(StoreError::invalid("local state scope", scope));
    }
    if key.is_empty() || key.len() > 512 {
        return Err(StoreError::invalid("local state key", key));
    }
    Ok(())
}

fn entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<LocalEntry> {
    Ok(LocalEntry {
        scope: r.get(0)?,
        key: r.get(1)?,
        value: r.get(2)?,
        book_id: r.get(3)?,
        changed_ms: r.get(4)?,
    })
}

pub(crate) fn get(conn: &Connection, scope: &str, key: &str) -> Result<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT value FROM local_state WHERE scope = ?1 AND key = ?2")?
        .query_row(params![scope, key], |r| r.get(0))
        .optional()?)
}

/// Delete a book's rows inside the caller's transaction; returns their
/// changes, to announce after the commit.
pub(crate) fn forget_book(conn: &Connection, book_id: &str) -> Result<Vec<LocalChange>> {
    let keys: Vec<(String, String)> = conn
        .prepare_cached("SELECT scope, key FROM local_state WHERE book_id = ?1")?
        .query_map([book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    conn.execute("DELETE FROM local_state WHERE book_id = ?1", [book_id])?;
    Ok(keys
        .into_iter()
        .map(|(s, k)| LocalChange::new(TABLE, change_key(&s, &k), LocalChangeKind::Delete))
        .collect())
}

impl LocalTx<'_> {
    /// The value stored under `(scope, key)` in this transaction.
    pub fn get_state(&self, scope: &str, key: &str) -> Result<Option<String>> {
        get(self, scope, key)
    }

    /// Store `value` under `(scope, key)`, tied to `book_id` if given; the
    /// change is announced after the commit. Storing the value already
    /// there (with the same book) changes and announces nothing.
    pub fn set_state(
        &mut self,
        scope: &str,
        key: &str,
        value: &str,
        book_id: Option<&str>,
    ) -> Result<()> {
        validate(scope, key)?;
        if value.len() > MAX_VALUE_BYTES {
            return Err(StoreError::invalid(
                "local state value",
                format!("{} bytes under {scope}/{key}", value.len()),
            ));
        }
        let old: Option<(String, Option<String>)> = self
            .prepare_cached("SELECT value, book_id FROM local_state WHERE scope = ?1 AND key = ?2")?
            .query_row(params![scope, key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if old
            .as_ref()
            .is_some_and(|(v, b)| v == value && b.as_deref() == book_id)
        {
            return Ok(());
        }
        self.prepare_cached(
            "INSERT INTO local_state (scope, key, value, book_id, changed_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value,
               book_id = excluded.book_id, changed_ms = excluded.changed_ms",
        )?
        .execute(params![scope, key, value, book_id, now_ms()])?;
        let kind = if old.is_some() {
            LocalChangeKind::Update
        } else {
            LocalChangeKind::Insert
        };
        self.changed(LocalChange::new(TABLE, change_key(scope, key), kind));
        Ok(())
    }

    /// Remove `(scope, key)`; false when nothing was stored.
    pub fn remove_state(&mut self, scope: &str, key: &str) -> Result<bool> {
        let n = self
            .prepare_cached("DELETE FROM local_state WHERE scope = ?1 AND key = ?2")?
            .execute(params![scope, key])?;
        if n > 0 {
            self.changed(LocalChange::new(
                TABLE,
                change_key(scope, key),
                LocalChangeKind::Delete,
            ));
        }
        Ok(n > 0)
    }
}

impl Library {
    /// The value stored under `(scope, key)` on this device.
    pub fn local_get(&self, scope: &str, key: &str) -> Result<Option<String>> {
        get(&self.reader(), scope, key)
    }

    /// A scope's values, by key; with `book_id`, only that book's.
    pub fn local_entries(&self, scope: &str, book_id: Option<&str>) -> Result<Vec<LocalEntry>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT scope, key, value, book_id, changed_ms FROM local_state
             WHERE scope = ?1 AND (?2 IS NULL OR book_id = ?2) ORDER BY key",
        )?;
        let rows = stmt
            .query_map(params![scope, book_id], entry)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// [`LocalTx::set_state`] in a transaction of its own.
    pub fn local_set(
        &self,
        scope: &str,
        key: &str,
        value: &str,
        book_id: Option<&str>,
    ) -> Result<()> {
        self.local_write(|tx| tx.set_state(scope, key, value, book_id))
    }

    /// [`LocalTx::remove_state`] in a transaction of its own.
    pub fn local_remove(&self, scope: &str, key: &str) -> Result<bool> {
        self.local_write(|tx| tx.remove_state(scope, key))
    }
}
