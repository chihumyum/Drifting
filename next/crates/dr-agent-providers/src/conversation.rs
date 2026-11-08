//! Hidden runtime records have a versioned wire projection. The synchronized
//! transcript itself stays untouched, including unknown extension records.

use std::borrow::Cow;

use dr_agent::long_task::{CHECKPOINT_ENTRY_KIND, CONTINUATION_ENTRY_KIND};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use serde_json::json;

use crate::{ProviderError, Result};

pub(crate) fn user_boundary(entry: &ConversationEntry) -> bool {
    entry.kind == ConversationEntryKind::User
        || (entry.kind.as_str() == CONTINUATION_ENTRY_KIND && entry.payload["version"] == 1)
}

pub(crate) fn project(entries: &[ConversationEntry]) -> Result<Cow<'_, [ConversationEntry]>> {
    if !entries.iter().any(|entry| {
        matches!(
            entry.kind.as_str(),
            CONTINUATION_ENTRY_KIND | CHECKPOINT_ENTRY_KIND
        )
    }) {
        return Ok(Cow::Borrowed(entries));
    }
    let mut projected = Vec::with_capacity(entries.len());
    for entry in entries {
        match entry.kind.as_str() {
            CONTINUATION_ENTRY_KIND | CHECKPOINT_ENTRY_KIND if entry.payload["version"] != 1 => {
                return Err(ProviderError::protocol(
                    "unsupported runtime conversation record version",
                ));
            }
            CHECKPOINT_ENTRY_KIND => {}
            CONTINUATION_ENTRY_KIND => {
                let text = entry.payload["text"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .ok_or_else(|| ProviderError::protocol("invalid runtime continuation text"))?;
                let mut user = entry.clone();
                user.kind = ConversationEntryKind::User;
                user.payload = json!({"text":text});
                projected.push(user);
            }
            _ => projected.push(entry.clone()),
        }
    }
    Ok(Cow::Owned(projected))
}
