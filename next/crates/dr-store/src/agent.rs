//! M27's append-only local runtime journal. Events are opaque JSON here;
//! dr-agent owns their versioned schema and derives runtime state/messages.
//! No journal rows participate in Loro synchronization. A conversation's
//! author-visible content is a separate Loro document.

use rusqlite::{Connection, OptionalExtension, params};

use crate::{Library, LocalChange, LocalChangeKind, LocalTx, Result, StoreError, now_ms};

pub const SESSION_TABLE: &str = "agent_session";
pub const EVENT_TABLE: &str = "agent_event";

/// Immutable local identity; all mutable state is projected from events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSession {
    pub session: String,
    /// The Loro conversation document id.
    pub conversation: String,
    pub book_id: String,
    pub created_ms: i64,
}

/// A journal event in durable order (sequence starts at one per session).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentEvent {
    pub session: String,
    pub seq: i64,
    pub event_json: String,
    pub ts: i64,
}

/// A compare-and-append operation. `expected_seq` is the last event the
/// caller observed, zero for an empty session. A stale writer is refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentEventAppend {
    pub session: String,
    pub expected_seq: i64,
    pub event_json: String,
}

fn valid_id(what: &'static str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(StoreError::invalid(what, value));
    }
    Ok(())
}

impl AgentEventAppend {
    pub(crate) fn validate(&self) -> Result<()> {
        valid_id("agent session", &self.session)?;
        if self.expected_seq < 0 || self.expected_seq == i64::MAX {
            return Err(StoreError::invalid(
                "agent event sequence",
                self.expected_seq.to_string(),
            ));
        }
        if serde_json::from_str::<serde_json::Value>(&self.event_json).is_err() {
            return Err(StoreError::invalid("agent event JSON", "invalid JSON"));
        }
        Ok(())
    }
}

fn session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSession> {
    Ok(AgentSession {
        session: row.get(0)?,
        conversation: row.get(1)?,
        book_id: row.get(2)?,
        created_ms: row.get(3)?,
    })
}

fn get_session(conn: &Connection, session: &str) -> Result<Option<AgentSession>> {
    Ok(conn.prepare_cached(
        "SELECT session, conversation, book_id, created_ms FROM agent_session WHERE session = ?1",
    )?.query_row([session], session_row).optional()?)
}

pub(crate) fn append(conn: &Connection, request: &AgentEventAppend) -> Result<AgentEvent> {
    request.validate()?;
    if get_session(conn, &request.session)?.is_none() {
        return Err(StoreError::NotFound(format!(
            "agent session {}",
            request.session
        )));
    }
    let last: i64 = conn.query_row(
        "SELECT coalesce(max(seq), 0) FROM agent_event WHERE session = ?1",
        [&request.session],
        |r| r.get(0),
    )?;
    if last != request.expected_seq {
        return Err(StoreError::AgentSequence {
            session: request.session.clone(),
            expected: request.expected_seq,
            stored: last,
        });
    }
    let event = AgentEvent {
        session: request.session.clone(),
        seq: last + 1,
        event_json: request.event_json.clone(),
        ts: now_ms(),
    };
    conn.execute(
        "INSERT INTO agent_event (session, seq, event_json, ts) VALUES (?1, ?2, ?3, ?4)",
        params![event.session, event.seq, event.event_json, event.ts],
    )?;
    Ok(event)
}

pub(crate) fn event_change(event: &AgentEvent) -> LocalChange {
    LocalChange::new(
        EVENT_TABLE,
        format!("{}/{}", event.session, event.seq),
        LocalChangeKind::Insert,
    )
}

/// Drop journals when the author purges their conversation, or the book's
/// last document. Settlement receipts keep their separate durable lifetime.
pub(crate) fn forget(
    conn: &Connection,
    conversation: Option<&str>,
    book_id: Option<&str>,
) -> Result<Vec<LocalChange>> {
    let sessions: Vec<String> = conn.prepare_cached(
        "SELECT session FROM agent_session WHERE conversation = ?1 OR book_id = ?2 ORDER BY session",
    )?.query_map(params![conversation, book_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let mut changes = Vec::new();
    for session in sessions {
        conn.execute("DELETE FROM agent_event WHERE session = ?1", [&session])?;
        conn.execute("DELETE FROM agent_session WHERE session = ?1", [&session])?;
        changes.push(LocalChange::new(
            EVENT_TABLE,
            &session,
            LocalChangeKind::Delete,
        ));
        changes.push(LocalChange::new(
            SESSION_TABLE,
            &session,
            LocalChangeKind::Delete,
        ));
    }
    Ok(changes)
}

impl LocalTx<'_> {
    /// Create once; repeating the same identity is an idempotent no-op.
    /// Reusing a session id for another book/conversation is always refused.
    pub fn agent_create_session(
        &mut self,
        session: &str,
        conversation: &str,
        book_id: &str,
    ) -> Result<AgentSession> {
        valid_id("agent session", session)?;
        valid_id("agent conversation", conversation)?;
        valid_id("agent book", book_id)?;
        crate::purge::check_creatable(self, conversation, Some(book_id))?;
        if let Some(old) = get_session(self, session)? {
            if old.conversation != conversation || old.book_id != book_id {
                return Err(StoreError::invalid("agent session identity", session));
            }
            return Ok(old);
        }
        let created_ms = now_ms();
        self.execute(
            "INSERT INTO agent_session (session, conversation, book_id, created_ms) VALUES (?1, ?2, ?3, ?4)",
            params![session, conversation, book_id, created_ms],
        )?;
        self.changed(LocalChange::new(
            SESSION_TABLE,
            session,
            LocalChangeKind::Insert,
        ));
        Ok(AgentSession {
            session: session.into(),
            conversation: conversation.into(),
            book_id: book_id.into(),
            created_ms,
        })
    }

    /// Append in this local transaction; announce only after commit.
    pub fn agent_append_event(&mut self, request: &AgentEventAppend) -> Result<AgentEvent> {
        let event = append(self, request)?;
        self.changed(event_change(&event));
        Ok(event)
    }
}

impl Library {
    pub fn agent_create_session(
        &self,
        session: &str,
        conversation: &str,
        book_id: &str,
    ) -> Result<AgentSession> {
        self.local_write(|tx| tx.agent_create_session(session, conversation, book_id))
    }

    pub fn agent_session(&self, session: &str) -> Result<Option<AgentSession>> {
        get_session(&self.reader(), session)
    }

    /// Sessions to replay on open, oldest first; optionally limited to a book.
    pub fn agent_sessions(&self, book_id: Option<&str>) -> Result<Vec<AgentSession>> {
        let conn = self.reader();
        // Two statements: `?1 IS NULL OR book_id = ?1` would scan the table
        // and sort, while a book's sessions are read from
        // `agent_session_by_book` in order.
        Ok(match book_id {
            Some(book) => conn
                .prepare_cached(
                    "SELECT session, conversation, book_id, created_ms FROM agent_session
                     WHERE book_id = ?1 ORDER BY created_ms, session",
                )?
                .query_map([book], session_row)?
                .collect::<rusqlite::Result<_>>()?,
            None => conn
                .prepare_cached(
                    "SELECT session, conversation, book_id, created_ms FROM agent_session
                     ORDER BY created_ms, session",
                )?
                .query_map([], session_row)?
                .collect::<rusqlite::Result<_>>()?,
        })
    }

    /// One immutable event by identity, without reading the journal prefix.
    /// Runtime readers use sequence one to validate the protocol before an
    /// incremental tail read.
    pub fn agent_event(&self, session: &str, seq: i64) -> Result<Option<AgentEvent>> {
        if seq < 1 {
            return Err(StoreError::invalid("agent event sequence", seq.to_string()));
        }
        Ok(self.reader().prepare_cached(
            "SELECT session, seq, event_json, ts FROM agent_event WHERE session = ?1 AND seq = ?2",
        )?.query_row(params![session, seq], |r| Ok(AgentEvent {
            session: r.get(0)?, seq: r.get(1)?, event_json: r.get(2)?, ts: r.get(3)?,
        })).optional()?)
    }

    /// All events newer than `after_seq`, in durable sequence order. The
    /// returned journal is the source for state recovery and message views.
    pub fn agent_events(&self, session: &str, after_seq: i64) -> Result<Vec<AgentEvent>> {
        if after_seq < 0 {
            return Err(StoreError::invalid(
                "agent event sequence",
                after_seq.to_string(),
            ));
        }
        let conn = self.reader();
        Ok(conn.prepare_cached(
            "SELECT session, seq, event_json, ts FROM agent_event WHERE session = ?1 AND seq > ?2 ORDER BY seq",
        )?.query_map(params![session, after_seq], |r| Ok(AgentEvent {
            session: r.get(0)?, seq: r.get(1)?, event_json: r.get(2)?, ts: r.get(3)?,
        }))?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn agent_append_event(&self, request: &AgentEventAppend) -> Result<AgentEvent> {
        self.local_write(|tx| tx.agent_append_event(request))
    }
}
