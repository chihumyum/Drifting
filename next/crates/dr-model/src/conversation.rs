//! The immutable, synchronized contents of an Agent conversation.
//!
//! These are projections of durable runtime events, not local control state.
//! A source event has one stable id across retries and devices. The document
//! writer rejects attempts to reuse an id with different contents.

use serde::{Deserialize, Serialize};

use crate::id::{ConversationId, IdError};
pub use crate::kind::ConversationEntryKind;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationEntry {
    /// Stable source event identity, normally `<session>:<sequence>`.
    pub id: String,
    pub session: String,
    pub turn: u32,
    pub kind: ConversationEntryKind,
    /// Structured text, reasoning or tool contents. Unknown provider fields
    /// stay intact; runtime controls and permission requests stay local.
    pub payload: serde_json::Value,
}

impl ConversationEntry {
    pub fn validate(&self) -> Result<(), IdError> {
        ConversationId::parse(&self.id)?;
        ConversationId::parse(&self.session)?;
        ConversationId::parse(self.kind.as_str())?;
        Ok(())
    }
}
