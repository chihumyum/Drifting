//! Device-local audit. No chat session or conversation document is created.

use std::collections::BTreeMap;

use dr_store::{Library, StoreError, local_state::MAX_VALUE_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{ExternalStart, ExternalState};
use crate::{Result, SettlementRef, ToolResult, ToolStatus};

pub(super) const SESSIONS: &str = "agent.external.sessions";
pub(super) const EVENTS: &str = "agent.external.events";
pub(super) const MAX_REQUEST: usize = MAX_VALUE_BYTES / 2;

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
        let mut pending = BTreeMap::new();
        let mut expected = 1_u64;
        for row in self
            .lib
            .local_entries(EVENTS, Some(self.header.start.book.as_str()))?
        {
            if !row.key.starts_with(&prefix) {
                continue;
            }
            let value: Value = serde_json::from_str(&row.value)?;
            if value["seq"].as_u64() != Some(expected)
                || row.key != format!("{prefix}{expected:020}")
            {
                return Err(invalid("missing or mismatched event sequence").into());
            }
            expected += 1;
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
