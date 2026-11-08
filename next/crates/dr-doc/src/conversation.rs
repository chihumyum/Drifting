//! Append-only conversation content projected from durable runtime events.
//!
//! The list stores immutable JSON values, never mutable message objects.
//! Stable event identities make recovery replay idempotent; identical values
//! appended concurrently are deduplicated when read. Control state, local
//! permissions and runtime logs are not part of this document.

use std::collections::BTreeMap;

use dr_model::conversation::ConversationEntry;
use dr_model::id::ConversationId;
use dr_model::{DocId, Origin};
use loro::{
    CommitOptions, ExportMode, Frontiers, LoroDoc, LoroValue, ValueOrContainer, VersionVector,
};

use crate::core::{Committed, Core, Imported, check_borrowed, configured};
use crate::error::{DocError, Result};
use crate::peer::{PeerId, genesis_peer};
use crate::schema::{self, GENESIS_VERSION, SCHEMA_VERSION};

/// Deterministic genesis, with no message or prose body.
pub fn genesis(conversation: &ConversationId) -> Vec<u8> {
    let id = DocId::Conversation(conversation.clone()).to_string();
    let doc = configured();
    doc.set_peer_id(genesis_peer(&id, GENESIS_VERSION))
        .expect("genesis peer");
    let meta = doc.get_map(schema::conversation::META);
    meta.insert(schema::meta::VERSION, SCHEMA_VERSION)
        .expect("meta version");
    meta.insert(schema::meta::DOC, id.as_str())
        .expect("meta id");
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export conversation genesis")
}

fn invalid(reason: impl ToString) -> DocError {
    DocError::Conversation(reason.to_string())
}

fn entries(doc: &LoroDoc) -> Result<Vec<ConversationEntry>> {
    let list = doc.get_list(schema::conversation::ENTRIES);
    let mut seen = BTreeMap::<String, usize>::new();
    let mut result: Vec<ConversationEntry> = Vec::new();
    for i in 0..list.len() {
        let Some(ValueOrContainer::Value(LoroValue::String(raw))) = list.get(i) else {
            return Err(invalid(format!("entry {i} is not an immutable JSON value")));
        };
        let entry: ConversationEntry = serde_json::from_str(&raw).map_err(invalid)?;
        entry.validate().map_err(invalid)?;
        if let Some(previous) = seen.get(&entry.id) {
            if result[*previous] != entry {
                return Err(invalid(format!(
                    "event {} has conflicting content",
                    entry.id
                )));
            }
            continue;
        }
        seen.insert(entry.id.clone(), result.len());
        result.push(entry);
    }
    Ok(result)
}

fn append(doc: &LoroDoc, entry: &ConversationEntry) -> Result<bool> {
    entry.validate().map_err(invalid)?;
    if let Some(existing) = entries(doc)?.iter().find(|value| value.id == entry.id) {
        return if existing == entry {
            Ok(false)
        } else {
            Err(invalid(format!("event {} is immutable", entry.id)))
        };
    }
    let raw = serde_json::to_string(entry).map_err(invalid)?;
    doc.get_list(schema::conversation::ENTRIES).push(raw)?;
    Ok(true)
}

/// One writer. Every append returns its update for the store to persist.
pub struct ConversationDoc {
    core: Core,
    id: ConversationId,
}

impl ConversationDoc {
    pub fn create(id: ConversationId, peer: PeerId) -> Result<Self> {
        Self::load(id, peer, &[])
    }

    pub fn load(id: ConversationId, peer: PeerId, blobs: &[Vec<u8>]) -> Result<Self> {
        let core = Core::load(
            DocId::Conversation(id.clone()),
            &genesis(&id),
            blobs,
            Some(peer),
            schema::meta::DOC,
        )?;
        BorrowedConversation::new(&core.doc, &id)?;
        entries(&core.doc)?;
        Ok(Self { core, id })
    }

    pub fn conversation_id(&self) -> &ConversationId {
        &self.id
    }

    pub fn doc_id(&self) -> &DocId {
        &self.core.id
    }

    pub fn peer(&self) -> PeerId {
        self.core.peer()
    }

    pub fn set_peer(&mut self, peer: PeerId) -> Result<()> {
        self.core.set_peer(peer)
    }

    pub fn entries(&self) -> Result<Vec<ConversationEntry>> {
        entries(&self.core.doc)
    }

    /// Returns false with no update if this exact event was already appended.
    pub fn append(
        &mut self,
        origin: Origin,
        entry: &ConversationEntry,
    ) -> (Result<bool>, Option<Committed>) {
        self.core
            .transact(&origin, None, || append(&self.core.doc, entry))
    }

    /// Validate on a separate copy before accepting remote bytes. Existing
    /// immutable event contents may not disappear or change. This protects
    /// this typed writer; store-owned imports use [`validate_update`].
    pub fn import(&mut self, bytes: &[u8], origin: Origin) -> Result<Imported> {
        validate_update(&self.core.doc, bytes)?;
        let pending = self.core.import(bytes, &origin)?;
        Ok(Imported {
            pending,
            repair: None,
        })
    }

    pub fn version(&self) -> VersionVector {
        self.core.version()
    }

    pub fn frontiers(&self) -> Frontiers {
        self.core.frontiers()
    }

    pub fn export_updates_since(&self, vv: &VersionVector) -> Result<Vec<u8>> {
        self.core.export_updates_since(vv)
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>> {
        self.core.export_snapshot()
    }
}

/// Validate an incoming update without changing the held document. F2/M36
/// can call this before importing into a store-owned conversation document.
/// This is protocol validation, not authentication of the remote writer.
pub fn validate_update(doc: &LoroDoc, bytes: &[u8]) -> Result<()> {
    let candidate = configured();
    candidate.import(&doc.export(ExportMode::Snapshot)?)?;
    candidate.import(bytes)?;
    let after = entries(&candidate)?;
    let by_id: BTreeMap<_, _> = after
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), (i, e)))
        .collect();
    let mut last_index = None;
    for previous in entries(doc)? {
        let current = by_id.get(previous.id.as_str());
        if current.map(|(_, entry)| *entry) != Some(&previous) {
            return Err(invalid(format!("event {} is immutable", previous.id)));
        }
        let index = current.expect("matched above").0;
        if last_index.is_some_and(|last| last >= index) {
            return Err(invalid("existing events were reordered"));
        }
        last_index = Some(index);
    }
    let key = schema::meta::DOC;
    if candidate
        .get_map(schema::conversation::META)
        .get(key)
        .map(|v| v.get_deep_value())
        != doc
            .get_map(schema::conversation::META)
            .get(key)
            .map(|v| v.get_deep_value())
    {
        return Err(invalid("document identity changed"));
    }
    Ok(())
}

/// Typed append/read access to a document held by F2. Does not commit; the
/// holder owns commit origin, transaction boundaries and durability.
pub struct BorrowedConversation<'a> {
    doc: &'a LoroDoc,
}

impl<'a> BorrowedConversation<'a> {
    pub fn new(doc: &'a LoroDoc, id: &ConversationId) -> Result<Self> {
        let doc_id = DocId::Conversation(id.clone());
        check_borrowed(doc, &doc_id, schema::meta::DOC)?;
        match doc
            .get_map(schema::conversation::META)
            .get(schema::meta::DOC)
        {
            Some(ValueOrContainer::Value(LoroValue::String(value)))
                if value.as_str() == doc_id.to_string() => {}
            _ => return Err(invalid("invalid document identity")),
        }
        Ok(Self { doc })
    }

    pub fn entries(&self) -> Result<Vec<ConversationEntry>> {
        entries(self.doc)
    }

    pub fn append(&self, entry: &ConversationEntry) -> Result<bool> {
        append(self.doc, entry)
    }
}

#[cfg(test)]
mod tests;
