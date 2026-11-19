//! Device-local audit. No chat session or conversation document is created.

use std::collections::BTreeMap;

use dr_model::id::BookId;
use dr_store::{Library, StoreError, local_state::MAX_VALUE_BYTES};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{ExternalStart, ExternalState};
use crate::{Error, Result, SettlementRef, ToolResult, ToolStatus};

pub(super) const SESSIONS: &str = "agent.external.sessions";
pub(super) const EVENTS: &str = "agent.external.events";
pub(super) const MAX_REQUEST: usize = MAX_VALUE_BYTES / 2;
pub(super) const RECONCILE_PAGE: usize = 256;

pub const DEFAULT_SESSION_PAGE: usize = 50;
pub const MAX_SESSION_PAGE: usize = 200;
pub const DEFAULT_EVENT_PAGE: usize = 100;
pub const MAX_EVENT_PAGE: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalSessionRecord {
    pub session: String,
    pub start: ExternalStart,
    pub seq: u64,
    pub state: ExternalState,
    pub changed_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalSessionPage {
    pub sessions: Vec<ExternalSessionRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalEventRecord {
    pub seq: u64,
    pub event: Value,
    pub changed_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalEventPage {
    pub session: String,
    pub state: ExternalState,
    pub total_seq: u64,
    pub events: Vec<ExternalEventRecord>,
    pub next_after_seq: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Header {
    pub version: u32,
    pub source: String,
    pub session: String,
    pub start: ExternalStart,
    pub seq: u64,
    pub state: ExternalState,
}

pub(super) struct Journal {
    pub lib: Library,
    pub header: Header,
}

fn invalid(value: impl ToString) -> StoreError {
    StoreError::Invalid {
        what: "external audit",
        value: value.to_string(),
    }
}

impl Journal {
    pub fn create(lib: Library, session: String, start: ExternalStart) -> Result<Self> {
        let header = Header {
            version: 1,
            source: "external_mcp".into(),
            session,
            start,
            seq: 0,
            state: ExternalState::Open,
        };
        let encoded = serde_json::to_string(&header)?;
        lib.local_write(|tx| {
            // Creation and book existence share the writer transaction. A
            // simultaneous final-book purge must not leave orphan audit rows.
            let stored: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id = ?1 AND kind = 'book')",
                [format!("book:{}", header.start.book)],
                |row| row.get(0),
            )?;
            if !stored {
                return Err(StoreError::NotFound(header.start.book.to_string()));
            }
            if tx.get_state(SESSIONS, &header.session)?.is_some() {
                return Err(invalid("session already exists"));
            }
            tx.set_state(
                SESSIONS,
                &header.session,
                &encoded,
                Some(header.start.book.as_str()),
            )
        })?;
        Ok(Self { lib, header })
    }

    pub fn open(lib: Library, value: &str) -> Result<Self> {
        let header: Header = serde_json::from_str(value)?;
        if header.version != 1 || header.source != "external_mcp" {
            return Err(invalid("unsupported audit version or source").into());
        }
        Ok(Self { lib, header })
    }

    pub fn append(&mut self, events: Vec<Value>, state: ExternalState) -> Result<()> {
        let mut next = self.header.clone();
        let mut rows = Vec::with_capacity(events.len());
        for event in events {
            next.seq = next
                .seq
                .checked_add(1)
                .ok_or_else(|| invalid("sequence exhausted"))?;
            let key = format!("{}/{:020}", next.session, next.seq);
            let value = serde_json::to_string(&json!({"seq":next.seq,"event":event}))?;
            if value.len() > MAX_VALUE_BYTES {
                return Err(invalid("event exceeds local-state limit").into());
            }
            rows.push((key, value));
        }
        next.state = state;
        let encoded = serde_json::to_string(&next)?;
        self.lib.local_write(|tx| {
            let stored = tx
                .get_state(SESSIONS, &self.header.session)?
                .ok_or_else(|| StoreError::NotFound(self.header.session.clone()))?;
            let current: Header = serde_json::from_str(&stored).map_err(invalid)?;
            if current.seq != self.header.seq
                || current.state != ExternalState::Open
                || current.session != self.header.session
                || current.start != self.header.start
                || current.version != 1
                || current.source != "external_mcp"
            {
                return Err(invalid("stale audit sequence or closed session"));
            }
            for (key, value) in &rows {
                if tx.get_state(EVENTS, key)?.is_some() {
                    return Err(invalid("event already exists"));
                }
                tx.set_state(EVENTS, key, value, Some(next.start.book.as_str()))?;
            }
            tx.set_state(
                SESSIONS,
                &next.session,
                &encoded,
                Some(next.start.book.as_str()),
            )
        })?;
        self.header = next;
        Ok(())
    }

    pub fn event(&mut self, event: Value) -> Result<()> {
        self.append(vec![event], ExternalState::Open)
    }

    pub fn finish(&mut self, result: &ToolResult) -> Result<()> {
        // Receipts are never truncated, even when a bulk operation exceeds
        // the per-row limit. Finish and all receipt pages commit atomically.
        let mut events = Vec::new();
        for (page, receipts) in result.settlements.chunks(512).enumerate() {
            events.push(
                json!({"kind":"receipts","call":result.call,"page":page,"receipts":receipts}),
            );
        }
        let raw = serde_json::to_vec(&result.output)?;
        let output = if raw.len() > MAX_REQUEST {
            json!({"truncated":true,"bytes":raw.len(),"sha256":format!("{:x}", Sha256::digest(&raw))})
        } else {
            result.output.clone()
        };
        events.push(
            json!({"kind":"finished","call":result.call,"status":result.status,
            "output":output,"receipt_count":result.settlements.len()}),
        );
        self.append(events, ExternalState::Open)
    }

    pub fn close(&mut self, state: ExternalState) -> Result<()> {
        self.append(vec![json!({"kind":"closed","state":state})], state)
    }

    pub fn reconcile(&mut self) -> Result<Vec<SettlementRef>> {
        let prefix = format!("{}/", self.header.session);
        let upper = format!("{}0", self.header.session);
        let mut cursor = prefix.clone();
        let mut pending = BTreeMap::new();
        let mut expected = 1_u64;
        loop {
            let page: Vec<(String, String)> = self.lib.local_read(|conn| {
                let mut stmt = conn.prepare_cached(
                    "SELECT key, value FROM local_state
                     WHERE scope = ?1 AND key > ?2 AND key < ?3
                     ORDER BY key ASC LIMIT ?4",
                )?;
                let rows = stmt
                    .query_map(
                        params![EVENTS, &cursor, &upper, RECONCILE_PAGE as i64],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })?;
            if page.is_empty() {
                break;
            }
            for (key, raw) in &page {
                let value: Value = serde_json::from_str(raw)?;
                if value["seq"].as_u64() != Some(expected)
                    || *key != format!("{prefix}{expected:020}")
                {
                    return Err(invalid("missing or mismatched event sequence").into());
                }
                expected = expected
                    .checked_add(1)
                    .ok_or_else(|| invalid("sequence exhausted"))?;
                let event = &value["event"];
                let call = event["call"].as_str().unwrap_or_default();
                match event["kind"].as_str() {
                    Some("accepted") => {
                        pending.insert(call.to_owned(), ());
                    }
                    Some("finished") => {
                        pending.remove(call);
                    }
                    _ => {}
                }
            }
            cursor = page.last().expect("non-empty page").0.clone();
            if page.len() < RECONCILE_PAGE {
                break;
            }
        }
        if expected - 1 != self.header.seq {
            return Err(invalid("event sequence does not match header").into());
        }
        for call in pending.into_keys() {
            self.finish(&ToolResult {
                call: call.clone(),
                status: ToolStatus::Interrupted,
                output: json!({"reason":"interrupted; effects reconciled from durable receipts"}),
                settlements: super::super::settlement_refs(
                    &self.lib,
                    &self.header.session,
                    1,
                    Some(&call),
                )?,
            })?;
        }
        super::super::settlement_refs(&self.lib, &self.header.session, 1, None)
    }
}

fn valid_session_key(session: &str) -> Result<()> {
    if session.is_empty()
        || session.len() > 256
        || session.contains('/')
        || session.chars().any(char::is_control)
    {
        return Err(Error::Protocol("invalid external session id".into()));
    }
    Ok(())
}

/// Paginate external MCP audit session headers, newest UUIDv7 first, without
/// loading unbounded history into memory or modifying stored audit rows.
pub fn external_sessions(
    lib: &Library,
    book: Option<&BookId>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ExternalSessionPage> {
    if !(1..=MAX_SESSION_PAGE).contains(&limit) {
        return Err(Error::Protocol(format!(
            "external session page limit must be 1..={MAX_SESSION_PAGE}"
        )));
    }
    if let Some(cursor) = cursor {
        valid_session_key(cursor)?;
    }
    let fetch = (limit + 1) as i64;
    let rows: Vec<(String, String, i64)> = lib.local_read(|conn| {
        let map_row =
            |r: &rusqlite::Row<'_>| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?));
        let collected = match (book, cursor) {
            (None, None) => conn
                .prepare_cached(
                    "SELECT key, value, changed_ms FROM local_state
                     WHERE scope = ?1 ORDER BY key DESC LIMIT ?2",
                )?
                .query_map(params![SESSIONS, fetch], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            (None, Some(cursor)) => conn
                .prepare_cached(
                    "SELECT key, value, changed_ms FROM local_state
                     WHERE scope = ?1 AND key < ?2 ORDER BY key DESC LIMIT ?3",
                )?
                .query_map(params![SESSIONS, cursor, fetch], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            (Some(book), None) => conn
                .prepare_cached(
                    "SELECT key, value, changed_ms FROM local_state
                     WHERE scope = ?1 AND book_id = ?2 ORDER BY key DESC LIMIT ?3",
                )?
                .query_map(params![SESSIONS, book.as_str(), fetch], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            (Some(book), Some(cursor)) => conn
                .prepare_cached(
                    "SELECT key, value, changed_ms FROM local_state
                     WHERE scope = ?1 AND book_id = ?2 AND key < ?3 ORDER BY key DESC LIMIT ?4",
                )?
                .query_map(params![SESSIONS, book.as_str(), cursor, fetch], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(collected)
    })?;
    let has_more = rows.len() > limit;
    let mut sessions = Vec::with_capacity(rows.len().min(limit));
    for (key, value, changed_ms) in rows.into_iter().take(limit) {
        let journal = Journal::open(lib.clone(), &value)?;
        if journal.header.session != key {
            return Err(Error::Protocol("external header key mismatch".into()));
        }
        sessions.push(ExternalSessionRecord {
            session: journal.header.session,
            start: journal.header.start,
            seq: journal.header.seq,
            state: journal.header.state,
            changed_ms,
        });
    }
    let next_cursor = has_more
        .then(|| sessions.last().map(|row| row.session.clone()))
        .flatten();
    Ok(ExternalSessionPage {
        sessions,
        next_cursor,
    })
}

/// Paginate a single external MCP session's durable audit events after
/// `after_seq`, verifying contiguous sequence order within the returned page.
pub fn external_events(
    lib: &Library,
    session: &str,
    after_seq: u64,
    limit: usize,
) -> Result<ExternalEventPage> {
    valid_session_key(session)?;
    if !(1..=MAX_EVENT_PAGE).contains(&limit) {
        return Err(Error::Protocol(format!(
            "external event page limit must be 1..={MAX_EVENT_PAGE}"
        )));
    }
    let lower = format!("{session}/{after_seq:020}");
    let upper = format!("{session}0");
    // One read transaction: the header and the page come from one committed
    // state, so an append to a live session cannot land between them.
    let (raw_header, rows): (Option<String>, Vec<(String, String, i64)>) =
        lib.local_read(|conn| {
            let tx = conn.unchecked_transaction()?;
            let header = tx
                .prepare_cached("SELECT value FROM local_state WHERE scope = ?1 AND key = ?2")?
                .query_row(params![SESSIONS, session], |r| r.get(0))
                .optional()?;
            let rows = tx
                .prepare_cached(
                    "SELECT key, value, changed_ms FROM local_state
                     WHERE scope = ?1 AND key > ?2 AND key < ?3
                     ORDER BY key ASC LIMIT ?4",
                )?
                .query_map(params![EVENTS, &lower, &upper, limit as i64], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((header, rows))
        })?;
    let raw_header =
        raw_header.ok_or_else(|| Error::Store(StoreError::NotFound(session.to_owned())))?;
    let journal = Journal::open(lib.clone(), &raw_header)?;
    if journal.header.session != session {
        return Err(Error::Protocol("external header key mismatch".into()));
    }
    if after_seq < journal.header.seq && rows.is_empty() {
        return Err(invalid("missing or mismatched event sequence").into());
    }
    let mut expected = after_seq;
    let mut events = Vec::with_capacity(rows.len());
    for (key, raw, changed_ms) in rows {
        expected = expected
            .checked_add(1)
            .ok_or_else(|| invalid("sequence exhausted"))?;
        let value: Value = serde_json::from_str(&raw)?;
        if value["seq"].as_u64() != Some(expected) || key != format!("{session}/{expected:020}") {
            return Err(invalid("missing or mismatched event sequence").into());
        }
        events.push(ExternalEventRecord {
            seq: expected,
            event: value["event"].clone(),
            changed_ms,
        });
    }
    let next_after_seq = events
        .last()
        .filter(|last| last.seq < journal.header.seq)
        .map(|last| last.seq);
    Ok(ExternalEventPage {
        session: journal.header.session,
        state: journal.header.state,
        total_seq: journal.header.seq,
        events,
        next_after_seq,
    })
}
