//! The command journal: the workspace's local-only table.
//!
//! One row per write command (who, which command, which book, what it did,
//! how to undo it), and the object-level undo/redo stacks read from it: each
//! actor (`Actor::journal_key`) has its own. The table is dr-store's
//! `ws_journal` (migration `0003`) in `library.sqlite`, so undo survives a
//! restart. Every change is one transaction through `Library::local_write`,
//! announced on the library bus once it has committed, so view models hear
//! about it exactly like a Loro change.
//!
//! An actor keeps its newest [`KEEP`] rows; older ones are dropped as new
//! ones arrive (device-local undo history, not part of the book).

use dr_store::{Library, LocalChange, LocalChangeKind, LocalTx};
use rusqlite::{OptionalExtension, params};
use schemars::JsonSchema;
use serde::Serialize;

use crate::cx::{Effect, Invocation};
use crate::error::{Result, WsError};

pub const TABLE: &str = "ws_journal";

/// Rows kept per actor.
pub const KEEP: i64 = 1000;

/// One journal row.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct JournalEntry {
    pub seq: i64,
    pub ts: i64,
    pub actor: String,
    pub command: String,
    pub book: Option<String>,
    pub effects: Vec<Effect>,
    /// `live`, `undone` (can be redone) or `dead` (undone, and a newer
    /// command cleared the redo stack).
    pub state: String,
    pub undoable: bool,
}

pub(crate) struct Journal {
    lib: Library,
}

fn now_ms() -> i64 {
    dr_store::now_ms()
}

fn to_json<T: Serialize + ?Sized>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|e| WsError::Internal(e.to_string()))
}

fn from_json<T: serde::de::DeserializeOwned>(s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|e| WsError::Internal(e.to_string()))
}

fn changed(tx: &mut LocalTx<'_>, seq: i64, kind: LocalChangeKind) {
    tx.changed(LocalChange::new(TABLE, seq.to_string(), kind));
}

impl Journal {
    pub(crate) fn open(lib: Library) -> Result<Self> {
        Ok(Self { lib })
    }

    /// Record a command; clears `actor`'s redo stack. One transaction.
    pub(crate) fn record(
        &self,
        actor: &str,
        command: &str,
        book: Option<&str>,
        effects: &[Effect],
        undo: Option<&[Invocation]>,
    ) -> Result<i64> {
        let effects = to_json(effects)?;
        let undo = undo.map(to_json).transpose()?;
        Ok(self.lib.local_write(|tx| {
            let now = now_ms();
            tx.execute(
                "UPDATE ws_journal SET state = 'dead', changed_ts = ?2 WHERE actor = ?1 AND state = 'undone'",
                params![actor, now],
            )?;
            tx.execute(
                "INSERT INTO ws_journal (ts, actor, command, book, effects, undo, changed_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?1)",
                params![now, actor, command, book, effects, undo],
            )?;
            let seq = tx.last_insert_rowid();
            changed(tx, seq, LocalChangeKind::Insert);
            // Now and then, drop what is past the actor's limit.
            if seq % 64 == 0 {
                tx.execute(
                    "DELETE FROM ws_journal WHERE actor = ?1 AND seq <
                     (SELECT seq FROM ws_journal WHERE actor = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)",
                    params![actor, KEEP - 1],
                )?;
            }
            Ok(seq)
        })?)
    }

    /// `actor`'s newest live row that has an undo.
    pub(crate) fn last_undoable(&self, actor: &str) -> Result<Option<(i64, Vec<Invocation>)>> {
        let row: Option<(i64, String)> = self.lib.local_read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT seq, undo FROM ws_journal
                     WHERE actor = ?1 AND state = 'live' AND undo IS NOT NULL
                     ORDER BY seq DESC LIMIT 1",
                    [actor],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?)
        })?;
        row.map(|(seq, u)| Ok((seq, from_json(&u)?))).transpose()
    }

    pub(crate) fn mark_undone(&self, seq: i64, redo: Option<&[Invocation]>) -> Result<()> {
        let redo = redo.map(to_json).transpose()?;
        Ok(self.lib.local_write(|tx| {
            tx.execute(
                "UPDATE ws_journal SET state = 'undone', redo = ?2, changed_ts = ?3 WHERE seq = ?1",
                params![seq, redo, now_ms()],
            )?;
            changed(tx, seq, LocalChangeKind::Update);
            Ok(())
        })?)
    }

    /// `actor`'s most recently undone row that can be redone.
    pub(crate) fn last_redoable(&self, actor: &str) -> Result<Option<(i64, Vec<Invocation>)>> {
        let row: Option<(i64, String)> = self.lib.local_read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT seq, redo FROM ws_journal
                     WHERE actor = ?1 AND state = 'undone' AND redo IS NOT NULL
                     ORDER BY changed_ts DESC, seq ASC LIMIT 1",
                    [actor],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?)
        })?;
        row.map(|(seq, u)| Ok((seq, from_json(&u)?))).transpose()
    }

    pub(crate) fn mark_redone(&self, seq: i64, undo: Option<&[Invocation]>) -> Result<()> {
        let undo = undo.map(to_json).transpose()?;
        Ok(self.lib.local_write(|tx| {
            tx.execute(
                "UPDATE ws_journal SET state = 'live', undo = ?2, redo = NULL, changed_ts = ?3 WHERE seq = ?1",
                params![seq, undo, now_ms()],
            )?;
            changed(tx, seq, LocalChangeKind::Update);
            Ok(())
        })?)
    }

    /// Drop a purged book's rows: nothing in them can be undone or redone.
    pub(crate) fn forget_book(&self, book: &str) -> Result<()> {
        Ok(self.lib.local_write(|tx| {
            let seqs: Vec<i64> = tx
                .prepare("SELECT seq FROM ws_journal WHERE book = ?1")?
                .query_map([book], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            tx.execute("DELETE FROM ws_journal WHERE book = ?1", [book])?;
            for seq in seqs {
                changed(tx, seq, LocalChangeKind::Delete);
            }
            Ok(())
        })?)
    }

    pub(crate) fn entries(&self, actor: Option<&str>, limit: usize) -> Result<Vec<JournalEntry>> {
        let rows = self.lib.local_read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT seq, ts, actor, command, book, effects, state, undo IS NOT NULL
                 FROM ws_journal WHERE (?1 IS NULL OR actor = ?1) ORDER BY seq DESC LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![actor, limit as i64], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, bool>(7)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        rows.into_iter()
            .map(
                |(seq, ts, actor, command, book, effects, state, undoable)| {
                    Ok(JournalEntry {
                        seq,
                        ts,
                        actor,
                        command,
                        book,
                        effects: from_json(&effects)?,
                        state,
                        undoable,
                    })
                },
            )
            .collect()
    }
}
