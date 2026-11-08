//! Append-only conversation content projected from durable runtime events
//! (`loro-schema.md` "对话文档").
//!
//! The list stores immutable JSON values, never mutable message objects.
//! Stable event identities make recovery replay idempotent. Control state,
//! local permissions and runtime logs are not part of this document.
//!
//! - **Reading never fails on content.** Every device reads the same entries
//!   from the same list: an entry this version cannot read (not a string,
//!   not JSON, an envelope from a later version) is skipped and kept; an
//!   event id seen again is skipped, and when its content differs the first
//!   one in list order is read and the id is reported
//!   ([`ConversationProblems`]). A document that merged into something odd
//!   still opens and still syncs.
//! - **The import guard judges the update, not the receiver.** An update is
//!   refused when one of its operations deletes from the entry list (which
//!   is also how an entry would be changed or moved) or rewrites the
//!   document's identity, and when it depends on changes this device does
//!   not have yet. The same bytes get the same answer on every device, so
//!   honest devices never split over it.

use std::collections::HashMap;

use dr_model::conversation::ConversationEntry;
use dr_model::id::ConversationId;
use dr_model::{DocId, Origin};
use loro::{
    CommitOptions, ContainerID, ContainerType, ExportMode, Frontiers, JsonListOp, JsonMapOp,
    JsonOpContent, LoroDoc, LoroValue, ValueOrContainer, VersionVector,
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

/// What reading a conversation found besides its entries. Every device
/// reading the same list finds the same.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConversationProblems {
    /// Positions in the entry list holding something this version cannot
    /// read: kept in the document, skipped.
    pub unreadable: Vec<usize>,
    /// Event ids that appear again with different content (only a bug or a
    /// foreign writer makes one); the first in list order is read.
    pub conflicting: Vec<String>,
}

fn parse(value: &ValueOrContainer) -> Option<ConversationEntry> {
    let ValueOrContainer::Value(LoroValue::String(raw)) = value else {
        return None;
    };
    serde_json::from_str::<ConversationEntry>(raw)
        .ok()
        .filter(|e| e.validate().is_ok())
}

fn read(doc: &LoroDoc) -> (Vec<ConversationEntry>, ConversationProblems) {
    let mut seen = HashMap::<String, usize>::new();
    let mut entries: Vec<ConversationEntry> = Vec::new();
    let mut problems = ConversationProblems::default();
    let mut i = 0;
    doc.get_list(schema::conversation::ENTRIES).for_each(|v| {
        match parse(&v) {
            None => problems.unreadable.push(i),
            Some(entry) => match seen.get(&entry.id) {
                Some(&first) => {
                    if entries[first] != entry && !problems.conflicting.contains(&entry.id) {
                        problems.conflicting.push(entry.id);
                    }
                }
                None => {
                    seen.insert(entry.id.clone(), entries.len());
                    entries.push(entry);
                }
            },
        }
        i += 1;
    });
    (entries, problems)
}

fn append(doc: &LoroDoc, entry: &ConversationEntry) -> Result<bool> {
    entry.validate().map_err(invalid)?;
    if let Some(existing) = read(doc).0.iter().find(|value| value.id == entry.id) {
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

    /// The entries, each event once, in list order. Never fails on content
    /// (see the module documentation); the `Result` is kept for callers.
    pub fn entries(&self) -> Result<Vec<ConversationEntry>> {
        Ok(read(&self.core.doc).0)
    }

    /// What reading skipped.
    pub fn problems(&self) -> ConversationProblems {
        read(&self.core.doc).1
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

    /// Import remote bytes after [`validate_update`] accepted them (the same
    /// check store-owned imports run).
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

/// Check an incoming update before it is imported into `doc` (a
/// conversation document with its genesis), without changing `doc`. Refused:
///
/// - an operation that deletes from the entry list: entries are never
///   deleted, and changing or moving one is a deletion plus an insert;
/// - an operation on `meta.v` or `meta.doc` by anyone but this document's
///   genesis (another conversation's bytes, or a rewritten identity);
/// - an update that depends on changes `doc` does not have yet: Loro would
///   keep its operations pending and apply them, unchecked, when the missing
///   changes arrive. Import those first, then this one again.
///
/// Everything else is accepted, entries this version cannot read and other
/// root containers included (a later version may add them). The answer
/// depends only on the update's own operations, so every device holding
/// what it depends on answers the same. This is protocol validation, not
/// authentication of the remote writer.
pub fn validate_update(doc: &LoroDoc, bytes: &[u8]) -> Result<()> {
    let id = match doc
        .get_map(schema::conversation::META)
        .get(schema::meta::DOC)
    {
        Some(ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
        _ => return Err(invalid("the document has no identity (no genesis)")),
    };
    let genesis = genesis_peer(&id, GENESIS_VERSION);
    let candidate = doc.fork();
    if candidate.import(bytes)?.pending.is_some() {
        return Err(invalid(
            "the update depends on changes this device does not have yet",
        ));
    }
    let changes = candidate
        .export_json_updates_without_peer_compression(&doc.oplog_vv(), &candidate.oplog_vv())?;
    for change in &changes.changes {
        for op in &change.ops {
            let ContainerID::Root {
                name,
                container_type,
            } = &op.container
            else {
                continue;
            };
            match (name.as_str(), container_type, &op.content) {
                (
                    schema::conversation::ENTRIES,
                    ContainerType::List,
                    JsonOpContent::List(JsonListOp::Delete { .. }),
                ) => {
                    return Err(invalid(
                        "an entry was deleted, changed or moved; entries are only appended",
                    ));
                }
                (
                    schema::conversation::META,
                    ContainerType::Map,
                    JsonOpContent::Map(JsonMapOp::Insert { key, .. } | JsonMapOp::Delete { key }),
                ) if change.id.peer != genesis
                    && (key == schema::meta::DOC || key == schema::meta::VERSION) =>
                {
                    return Err(invalid("document identity changed"));
                }
                _ => {}
            }
        }
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

    /// See [`ConversationDoc::entries`].
    pub fn entries(&self) -> Result<Vec<ConversationEntry>> {
        Ok(read(self.doc).0)
    }

    /// See [`ConversationDoc::problems`].
    pub fn problems(&self) -> ConversationProblems {
        read(self.doc).1
    }

    pub fn append(&self, entry: &ConversationEntry) -> Result<bool> {
        append(self.doc, entry)
    }
}

#[cfg(test)]
mod tests;
