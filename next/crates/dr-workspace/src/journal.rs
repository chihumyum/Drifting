//! The command journal: the workspace's local-only table.
//!
//! One row per write command (who, which command, which book, what it did,
//! how to undo it), and the object-level undo/redo stacks read from it: each
//! actor (`Actor::journal_key`) has its own. Every change is one SQLite
//! transaction, announced on the library bus with `notify_local`, so view
//! models hear about it exactly like a Loro change.
//!
//! **Where it lives (adapter):** dr-store has no public way to add a table
//! to `library.sqlite` or run a transaction on it yet (f3-workspace.md
//! "待协调" F2-2), so the journal is an in-memory SQLite database for now:
//! undo history lasts for the session. The schema and the transaction code
//! are the ones that move into dr-store's migration `0001_*` when it can host
//! them.

use std::sync::Mutex;

use dr_store::{Library, LocalChange, LocalChangeKind};
use rusqlite::{Connection, OptionalExtension, params};
use schemars::JsonSchema;
use serde::Serialize;

use crate::bridge::lock;
use crate::cx::{Effect, Invocation};
use crate::error::{Result, WsError};

pub const TABLE: &str = "ws_journal";

const SCHEMA: &str = "
CREATE TABLE ws_journal (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  command TEXT NOT NULL,
  book TEXT,
  effects TEXT NOT NULL,
  undo TEXT,
  redo TEXT,
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'undone', 'dead')),
  changed_ts INTEGER NOT NULL
) STRICT;
CREATE INDEX ws_journal_actor ON ws_journal (actor, state, seq);
";

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
    conn: Mutex<Connection>,
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

impl Journal {
    pub(crate) fn open(lib: Library) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            lib,
        })
    }

    fn notify(&self, seq: i64, kind: LocalChangeKind) {
        self.lib
            .notify_local(LocalChange::new(TABLE, seq.to_string(), kind));
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
        let seq = {
            let mut conn = lock(&self.conn);
            let tx = conn.transaction()?;
            let now = now_ms();
            tx.execute(
                "UPDATE ws_journal SET state = 'dead', changed_ts = ?2 WHERE actor = ?1 AND state = 'undone'",
                params![actor, now],
            )?;
            tx.execute(
                "INSERT INTO ws_journal (ts, actor, command, book, effects, undo, changed_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?1)",
                params![
                    now,
                    actor,
                    command,
                    book,
                    to_json(effects)?,
                    undo.map(to_json).transpose()?
                ],
            )?;
            let seq = tx.last_insert_rowid();
            tx.commit()?;
            seq
        };
        self.notify(seq, LocalChangeKind::Insert);
        Ok(seq)
    }

    /// `actor`'s newest live row that has an undo.
    pub(crate) fn last_undoable(&self, actor: &str) -> Result<Option<(i64, Vec<Invocation>)>> {
        let row: Option<(i64, String)> = lock(&self.conn)
            .query_row(
                "SELECT seq, undo FROM ws_journal
                 WHERE actor = ?1 AND state = 'live' AND undo IS NOT NULL
                 ORDER BY seq DESC LIMIT 1",
                [actor],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(seq, u)| Ok((seq, from_json(&u)?))).transpose()
    }

    pub(crate) fn mark_undone(&self, seq: i64, redo: Option<&[Invocation]>) -> Result<()> {
        {
            let mut conn = lock(&self.conn);
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE ws_journal SET state = 'undone', redo = ?2, changed_ts = ?3 WHERE seq = ?1",
                params![seq, redo.map(to_json).transpose()?, now_ms()],
            )?;
            tx.commit()?;
        }
        self.notify(seq, LocalChangeKind::Update);
        Ok(())
    }

    /// `actor`'s most recently undone row that can be redone.
    pub(crate) fn last_redoable(&self, actor: &str) -> Result<Option<(i64, Vec<Invocation>)>> {
        let row: Option<(i64, String)> = lock(&self.conn)
            .query_row(
                "SELECT seq, redo FROM ws_journal
                 WHERE actor = ?1 AND state = 'undone' AND redo IS NOT NULL
                 ORDER BY changed_ts DESC, seq ASC LIMIT 1",
                [actor],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(seq, u)| Ok((seq, from_json(&u)?))).transpose()
    }

    pub(crate) fn mark_redone(&self, seq: i64, undo: Option<&[Invocation]>) -> Result<()> {
        {
            let mut conn = lock(&self.conn);
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE ws_journal SET state = 'live', undo = ?2, redo = NULL, changed_ts = ?3 WHERE seq = ?1",
                params![seq, undo.map(to_json).transpose()?, now_ms()],
            )?;
            tx.commit()?;
        }
        self.notify(seq, LocalChangeKind::Update);
        Ok(())
    }

    pub(crate) fn entries(&self, actor: Option<&str>, limit: usize) -> Result<Vec<JournalEntry>> {
        let conn = lock(&self.conn);
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
