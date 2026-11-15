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
    /// command cleared the redo stack; or what the step would change is
    /// gone, so it can no longer be undone or redone).
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

/// A journal row's undo (or redo) without the record `gone` among the
/// `targets` its history restores name. `None` when the row can no longer
/// run: a restore is left with no target, or the stored value does not read.
/// `Some(None)` when the row has no undo (or redo).
fn without_target(stored: Option<&str>, gone: &serde_json::Value) -> Option<Option<String>> {
    let Some(stored) = stored else {
        return Some(None);
    };
    let mut steps: Vec<Invocation> = serde_json::from_str(stored).ok()?;
    for step in &mut steps {
        let Some(targets) = step.input.get_mut("targets").and_then(|t| t.as_array_mut()) else {
            continue;
        };
        let before = targets.len();
        targets.retain(|t| t != gone);
        if targets.len() < before && targets.is_empty() {
            return None;
        }
    }
    serde_json::to_string(&steps).ok().map(Some)
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

    /// `actor`'s newest live rows in `book` that have an undo, newest first,
    /// with the inverse of each: [`crate::Workspace::undo_in`] takes the
    /// first that is the book's own command.
    pub(crate) fn undoable_in(
        &self,
        actor: &str,
        book: &str,
        limit: usize,
    ) -> Result<Vec<(JournalEntry, Vec<Invocation>)>> {
        self.rows_in(
            "SELECT seq, ts, actor, command, book, effects, state, undo FROM ws_journal
             WHERE actor = ?1 AND book = ?2 AND state = 'live' AND undo IS NOT NULL
             ORDER BY seq DESC LIMIT ?3",
            actor,
            book,
            limit,
        )
    }

    /// `actor`'s most recently undone rows in `book` that can be redone, in
    /// the order [`Journal::last_redoable`] takes them, with the redo of each.
    pub(crate) fn redoable_in(
        &self,
        actor: &str,
        book: &str,
        limit: usize,
    ) -> Result<Vec<(JournalEntry, Vec<Invocation>)>> {
        self.rows_in(
            "SELECT seq, ts, actor, command, book, effects, state, redo FROM ws_journal
             WHERE actor = ?1 AND book = ?2 AND state = 'undone' AND redo IS NOT NULL
             ORDER BY changed_ts DESC, seq ASC LIMIT ?3",
            actor,
            book,
            limit,
        )
    }

    fn rows_in(
        &self,
        sql: &str,
        actor: &str,
        book: &str,
        limit: usize,
    ) -> Result<Vec<(JournalEntry, Vec<Invocation>)>> {
        type Row = (
            i64,
            i64,
            String,
            String,
            Option<String>,
            String,
            String,
            String,
        );
        let rows: Vec<Row> = self.lib.local_read(|conn| {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt
                .query_map(params![actor, book, limit as i64], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        rows.into_iter()
            .map(|(seq, ts, actor, command, book, effects, state, inverse)| {
                Ok((
                    JournalEntry {
                        seq,
                        ts,
                        actor,
                        command,
                        book,
                        effects: from_json(&effects)?,
                        state,
                        undoable: true,
                    },
                    from_json(&inverse)?,
                ))
            })
            .collect()
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

    /// Retire one row: what its undo or redo would change is gone, so the
    /// step can never run (`Workspace::run_step`).
    pub(crate) fn retire(&self, seq: i64) -> Result<()> {
        Ok(self.lib.local_write(|tx| {
            tx.execute(
                "UPDATE ws_journal SET state = 'dead', changed_ts = ?2 WHERE seq = ?1",
                params![seq, now_ms()],
            )?;
            changed(tx, seq, LocalChangeKind::Update);
            Ok(())
        })?)
    }

    /// The record `collection/id` of `book` was purged (an asset's bytes
    /// deleted): no step may bring it back as an empty file. In every
    /// actor's live or undone rows whose undo or redo restores it from
    /// history, it is taken out of what the step restores; a step left with
    /// nothing to restore is retired (`dead`), so Undo passes over it. A
    /// step that took several records at once (a folder trashed with its
    /// files) still brings the others back. Returns how many rows changed.
    pub(crate) fn forget_record(&self, book: &str, collection: &str, id: &str) -> Result<usize> {
        let gone = serde_json::json!({ "collection": collection, "id": id });
        let needle = to_json(&gone)?;
        Ok(self.lib.local_write(|tx| {
            let rows: Vec<(i64, Option<String>, Option<String>)> = tx
                .prepare(
                    "SELECT seq, undo, redo FROM ws_journal
                     WHERE book = ?1 AND state IN ('live', 'undone')
                     AND (instr(coalesce(undo, ''), ?2) > 0 OR instr(coalesce(redo, ''), ?2) > 0)",
                )?
                .query_map(params![book, needle], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            let now = now_ms();
            for (seq, undo, redo) in &rows {
                match (
                    without_target(undo.as_deref(), &gone),
                    without_target(redo.as_deref(), &gone),
                ) {
                    (Some(undo), Some(redo)) => tx.execute(
                        "UPDATE ws_journal SET undo = ?2, redo = ?3, changed_ts = ?4 WHERE seq = ?1",
                        params![seq, undo, redo, now],
                    )?,
                    _ => tx.execute(
                        "UPDATE ws_journal SET state = 'dead', changed_ts = ?2 WHERE seq = ?1",
                        params![seq, now],
                    )?,
                };
                changed(tx, *seq, LocalChangeKind::Update);
            }
            Ok(rows.len())
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
