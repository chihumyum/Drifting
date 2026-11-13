use std::time::{Duration, Instant};

use crate::{Error, Event, PROTOCOL_VERSION, Result};
use dr_doc::conversation::{BorrowedConversation, EntryIndex};
use dr_model::{
    DocId,
    conversation::{ConversationEntry, ConversationEntryKind},
    id::ConversationId,
};
use dr_store::{DocHandle, Library, OpenDoc, Origin, agent::AgentEventAppend};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JournalEvent {
    pub session: String,
    pub seq: i64,
    pub turn: u32,
    pub event: Event,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    turn: u32,
    event: Event,
}

/// [`Stored`] for writing, without moving the event.
#[derive(Serialize)]
struct StoredRef<'a> {
    turn: u32,
    event: &'a Event,
}

/// Buffered text is written once it is this large, whatever its age, so a
/// fast stream still produces journal rows of a bounded size.
const MAX_UNFLUSHED_BYTES: usize = 16 * 1024;

/// Streamed text of one content block not yet in the journal: consecutive
/// `TextDelta`s, or consecutive `ThinkingDelta`s, of one block and turn,
/// concatenated. Written as that same single delta event, so the journal
/// format is unchanged and every reader folds it exactly as it folded the
/// separate deltas.
struct Unflushed {
    turn: u32,
    event: Event,
    since: Instant,
}

impl Unflushed {
    fn new(turn: u32, thinking: bool, index: u32, text: &str, since: Instant) -> Self {
        let text = text.to_owned();
        let event = if thinking {
            Event::ThinkingDelta { index, text }
        } else {
            Event::TextDelta { index, text }
        };
        Self { turn, event, since }
    }

    fn continues(&self, turn: u32, thinking: bool, index: u32) -> bool {
        self.turn == turn
            && match &self.event {
                Event::TextDelta { index: i, .. } => !thinking && *i == index,
                Event::ThinkingDelta { index: i, .. } => thinking && *i == index,
                _ => false,
            }
    }

    fn text(&mut self) -> &mut String {
        match &mut self.event {
            Event::TextDelta { text, .. } | Event::ThinkingDelta { text, .. } => text,
            _ => unreachable!("only deltas are buffered"),
        }
    }

    fn json(&self) -> Result<String> {
        Ok(serde_json::to_string(&StoredRef {
            turn: self.turn,
            event: &self.event,
        })?)
    }
}

/// Read a versioned journal, returning events newer than `after_seq`. The
/// first event is checked on every read so a tail reader cannot bypass the
/// protocol version. Full replay (`after_seq = 0`) checks every sequence;
/// incremental readers supply their last accepted cursor and only the new
/// suffix is decoded. The already accepted prefix is immutable.
pub fn events(lib: &Library, session: &str, after_seq: i64) -> Result<Vec<JournalEvent>> {
    if after_seq < 0 {
        return Err(Error::Protocol("negative journal cursor".into()));
    }
    let first = lib
        .agent_event(session, 1)?
        .ok_or_else(|| Error::Protocol("journal has no initial Started event".into()))?;
    let initial: Stored = serde_json::from_str(&first.event_json)?;
    validate_start(&initial.event)?;
    let rows = lib.agent_events(session, after_seq)?;
    let mut previous = after_seq;
    let mut result = Vec::new();
    for row in rows {
        if previous.checked_add(1) != Some(row.seq) {
            return Err(Error::Protocol("journal sequence is not contiguous".into()));
        }
        let value: Stored = serde_json::from_str(&row.event_json)?;
        if row.seq == 1 {
            validate_start(&value.event)?;
        } else if matches!(value.event, Event::Started { .. }) {
            return Err(Error::Protocol("journal repeats Started".into()));
        }
        previous = row.seq;
        result.push(JournalEvent {
            session: row.session,
            seq: row.seq,
            turn: value.turn,
            event: value.event,
        });
    }
    Ok(result)
}

fn validate_start(event: &Event) -> Result<()> {
    match event {
        Event::Started { version } if *version == PROTOCOL_VERSION => Ok(()),
        Event::Started { version } => Err(Error::Protocol(format!(
            "unsupported journal protocol {version}"
        ))),
        _ => Err(Error::Protocol(
            "journal does not begin with Started".into(),
        )),
    }
}

/// Read the persisted projection without opening a writer or creating a
/// document. This also works for a read-only library and its backups.
pub fn conversation(lib: &Library, id: &ConversationId) -> Result<Vec<ConversationEntry>> {
    let doc = lib.load_copy(&DocId::Conversation(id.clone()).to_string())?;
    Ok(BorrowedConversation::new(&doc, id)?.entries()?)
}

/// One session's writer: appends to the local journal, then projects the
/// appended event into the synchronized conversation.
///
/// Streamed text is the exception (m27 "流式文字分批落盘").
/// [`Journal::stream`] buffers the deltas of one content block, and they
/// reach the journal as one delta event: when the block changes, when it is
/// older than the flush interval or larger than [`MAX_UNFLUSHED_BYTES`], on
/// [`Journal::flush`], and ahead of every other event, in that event's own
/// transaction. So the durable journal is always the journal of every delta
/// with runs of one block's deltas joined: never reordered, never torn (each
/// write is one SQLite transaction), and a completed message, a tool result
/// or any control event is never durable without all the text streamed
/// before it. A crash loses at most the buffered text: the end of the
/// message being streamed, younger than the interval. A failed write keeps
/// the buffer, so a later write cannot leave a gap in the middle.
pub(crate) struct Journal {
    pub lib: Library,
    pub session: String,
    pub turn: u32,
    pub seq: i64,
    id: ConversationId,
    handle: DocHandle,
    entries: EntryIndex,
    unflushed: Option<Unflushed>,
}

impl Journal {
    pub fn open(lib: Library, session: &str) -> Result<Self> {
        Ok(Self::open_with_log(lib, session)?.0)
    }

    /// Open, replaying the projection of the whole journal, which is
    /// returned as read.
    pub fn open_with_log(lib: Library, session: &str) -> Result<(Self, Vec<JournalEvent>)> {
        let session = lib.agent_session(session)?.ok_or(crate::Error::Closed)?;
        // Validate the source before opening/creating any projection. Even a
        // terminal session from a newer build must be left untouched.
        let log = events(&lib, &session.session, 0)?;
        let DocId::Conversation(id) = DocId::parse(&session.conversation)
            .map_err(|e| crate::Error::Protocol(e.to_string()))?
        else {
            return Err(crate::Error::Protocol(
                "session document is not a conversation".into(),
            ));
        };
        let doc_id = DocId::Conversation(id.clone()).to_string();
        if let Some(info) = lib.doc_info(&doc_id)?
            && info.book_id.as_deref() != Some(&session.book_id)
        {
            return Err(crate::Error::Protocol(
                "conversation belongs to another book".into(),
            ));
        }
        let bytes = dr_doc::conversation::genesis(&id);
        let handle = lib.open_doc(
            &doc_id,
            OpenDoc::CreateIfMissing {
                kind: "conversation",
                book_id: Some(&session.book_id),
                genesis: &|doc| {
                    doc.import(&bytes).expect("conversation genesis");
                },
            },
        )?;
        let mut journal = Self {
            lib,
            session: session.session,
            turn: 1,
            seq: 0,
            id,
            handle,
            entries: EntryIndex::default(),
            unflushed: None,
        };
        for event in &log {
            journal.project(event)?;
            journal.seq = event.seq;
            journal.turn = event.turn;
        }
        Ok((journal, log))
    }

    pub fn append(&mut self, event: Event) -> Result<()> {
        self.append_observed(event, Vec::new())
    }

    /// Buffer one streamed delta of the current turn (see [`Journal`]).
    /// `interval` zero writes it at once.
    pub fn stream(
        &mut self,
        thinking: bool,
        index: u32,
        text: &str,
        interval: Duration,
        now: Instant,
    ) -> Result<()> {
        if self
            .unflushed
            .as_ref()
            .is_some_and(|u| !u.continues(self.turn, thinking, index))
        {
            self.flush()?;
        }
        let unflushed = match &mut self.unflushed {
            Some(unflushed) => {
                unflushed.text().push_str(text);
                unflushed
            }
            None => self
                .unflushed
                .insert(Unflushed::new(self.turn, thinking, index, text, now)),
        };
        let size = unflushed.text().len();
        if now.saturating_duration_since(unflushed.since) >= interval || size >= MAX_UNFLUSHED_BYTES
        {
            self.flush()?;
        }
        Ok(())
    }

    /// When the buffered text must be written, if there is any.
    pub fn flush_due(&self, interval: Duration) -> Option<Instant> {
        self.unflushed.as_ref().map(|u| u.since + interval)
    }

    /// Write the buffered text now, alone.
    pub fn flush(&mut self) -> Result<()> {
        if self.unflushed.is_some() {
            self.write(None, &[], None)?;
        }
        Ok(())
    }

    /// Drop the buffered text: what a crash would lose. Only for a run that
    /// could not write it and is about to record its failure.
    pub fn discard_unflushed(&mut self) {
        self.unflushed = None;
    }

    /// Append the buffered text, then `event`, in one transaction with the
    /// evidence proofs. Clears the buffer only once committed.
    fn write(
        &mut self,
        event: Option<&Event>,
        reads: &[crate::evidence::ReadProof],
        writes: Option<&crate::evidence::WriteProof>,
    ) -> Result<()> {
        let mut rows = Vec::with_capacity(2);
        if let Some(unflushed) = &self.unflushed {
            rows.push(unflushed.json()?);
        }
        if let Some(event) = event {
            rows.push(serde_json::to_string(&StoredRef {
                turn: self.turn,
                event,
            })?);
        }
        let session = &self.session;
        let mut seq = self.seq;
        self.lib.local_write(|tx| {
            for event_json in rows {
                seq = tx
                    .agent_append_event(&AgentEventAppend {
                        session: session.clone(),
                        expected_seq: seq,
                        event_json,
                    })?
                    .seq;
            }
            for proof in reads {
                crate::long_task::persist_read(tx, proof)?;
            }
            if let Some(proof) = writes {
                crate::long_task::persist_writes(tx, proof)?;
            }
            Ok(())
        })?;
        self.seq = seq;
        self.unflushed = None;
        Ok(())
    }

    pub(crate) fn append_observed(
        &mut self,
        event: Event,
        observations: Vec<crate::evidence::ReadObservation>,
    ) -> Result<()> {
        let mut reads = Vec::new();
        let mut write = None;
        if let Event::ToolFinished { result } = &event {
            // The authoritative receipts remain usable even if their old Loro
            // state can no longer be loaded for narrower checklist evidence.
            write = crate::evidence::write_proof(&self.lib, &self.session, self.turn, &result.call)
                .ok()
                .flatten();
            if result.status == crate::ToolStatus::Success && !observations.is_empty() {
                let session = self
                    .lib
                    .agent_session(&self.session)?
                    .ok_or(Error::Closed)?;
                let book = dr_model::id::BookId::parse(&session.book_id)
                    .map_err(|e| Error::Protocol(e.to_string()))?;
                for observation in observations {
                    reads.push(crate::evidence::verify_read(
                        &self.lib,
                        &book,
                        &self.session,
                        self.turn,
                        &result.call,
                        observation,
                    )?);
                }
            }
        }
        // Text streamed before this event goes first, in the same transaction.
        self.write(Some(&event), &reads, write.as_ref())?;
        // Persist the authority before touching its synchronized projection.
        // A crash in between is repaired by replay; immutable ids deduplicate.
        self.project(&JournalEvent {
            session: self.session.clone(),
            seq: self.seq,
            turn: self.turn,
            event,
        })
    }

    fn project(&mut self, event: &JournalEvent) -> Result<()> {
        let (kind, payload) = match &event.event {
            Event::UserMessage { text } => (ConversationEntryKind::User, json!({"text": text})),
            Event::Continuation { text } => (
                ConversationEntryKind::Other(crate::long_task::CONTINUATION_ENTRY_KIND.into()),
                json!({"version":1,"text":text}),
            ),
            Event::Checkpoint { reason } => (
                ConversationEntryKind::Other(crate::long_task::CHECKPOINT_ENTRY_KIND.into()),
                json!({"version":1,"reason":reason}),
            ),
            Event::AssistantMessage { message } => (
                ConversationEntryKind::Assistant,
                serde_json::to_value(message)?,
            ),
            Event::ToolFinished { result } => {
                // Receipts and local row ids never leave this installation.
                (
                    ConversationEntryKind::ToolResult,
                    json!({"call": result.call, "status": result.status, "output": result.output}),
                )
            }
            _ => return Ok(()),
        };
        let entry = ConversationEntry {
            id: format!("{}:{}", event.session, event.seq),
            session: event.session.clone(),
            turn: event.turn,
            kind,
            payload,
        };
        // The index travels to the holder thread and back. Lost with a failed
        // write, it starts again empty and is rebuilt from the list.
        let id = self.id.clone();
        let mut entries = std::mem::take(&mut self.entries);
        let (result, _) = self.handle.write(Origin::User, move |doc| {
            let appended = BorrowedConversation::new(doc, &id)
                .and_then(|conversation| conversation.append_indexed(&mut entries, &entry));
            (appended, entries)
        })?;
        let (appended, entries) = result;
        self.entries = entries;
        appended?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn entries_parsed(&self) -> usize {
        self.entries.parsed()
    }

    pub fn transcript(&self) -> Result<Vec<ConversationEntry>> {
        let id = self.id.clone();
        Ok(self
            .handle
            .read(move |doc| BorrowedConversation::new(doc, &id)?.entries())??)
    }
}

#[cfg(test)]
mod tests;
