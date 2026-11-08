use crate::{Error, Event, PROTOCOL_VERSION, Result};
use dr_doc::conversation::BorrowedConversation;
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

pub(crate) struct Journal {
    pub lib: Library,
    pub session: String,
    pub turn: u32,
    pub seq: i64,
    id: ConversationId,
    handle: DocHandle,
}

impl Journal {
    pub fn open(lib: Library, session: &str) -> Result<Self> {
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
        };
        for event in log {
            journal.project(&event)?;
            journal.seq = event.seq;
            journal.turn = event.turn;
        }
        Ok(journal)
    }

    pub fn append(&mut self, event: Event) -> Result<()> {
        let record = Stored {
            turn: self.turn,
            event,
        };
        let stored = self.lib.agent_append_event(&AgentEventAppend {
            session: self.session.clone(),
            expected_seq: self.seq,
            event_json: serde_json::to_string(&record)?,
        })?;
        self.seq = stored.seq;
        // Persist the authority before touching its synchronized projection.
        // A crash in between is repaired by replay; immutable ids deduplicate.
        self.project(&JournalEvent {
            session: self.session.clone(),
            seq: self.seq,
            turn: self.turn,
            event: record.event,
        })
    }

    fn project(&self, event: &JournalEvent) -> Result<()> {
        let (kind, payload) = match &event.event {
            Event::UserMessage { text } => (ConversationEntryKind::User, json!({"text": text})),
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
        let id = self.id.clone();
        let (result, _) = self.handle.write(Origin::User, move |doc| {
            BorrowedConversation::new(doc, &id)?.append(&entry)
        })?;
        result?;
        Ok(())
    }

    pub fn transcript(&self) -> Result<Vec<ConversationEntry>> {
        let id = self.id.clone();
        Ok(self
            .handle
            .read(move |doc| BorrowedConversation::new(doc, &id)?.entries())??)
    }
}
