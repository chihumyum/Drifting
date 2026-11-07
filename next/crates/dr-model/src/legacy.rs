//! Mapping retired 0.1.x values onto schema v2, for the library import (M10).
//!
//! v2 does not carry the retired Copilot's vocabulary. Importing an old
//! library turns those values into their nearest current meaning instead of
//! storing them; readers that meet one anyway (written by something else)
//! keep it as `Other`.

use crate::kind::{CommentAuthorKind, CommentSource, CommentStatus, EntityKind};

/// `copilot` (the retired in-app AI) becomes `api`: made by software, not
/// typed by hand.
pub fn comment_source(old: &str) -> CommentSource {
    match old {
        "copilot" => CommentSource::Api,
        other => CommentSource::parse(other),
    }
}

/// `copilot` becomes `ai`.
pub fn comment_author_kind(old: &str) -> CommentAuthorKind {
    match old {
        "copilot" => CommentAuthorKind::Ai,
        other => CommentAuthorKind::parse(other),
    }
}

/// `converted` (an accepted Copilot suggestion) becomes `resolved`.
pub fn comment_status(old: &str) -> CommentStatus {
    match old {
        "converted" => CommentStatus::Resolved,
        other => CommentStatus::parse(other),
    }
}

/// `library_item` becomes `material`.
pub fn entity_kind(old: &str) -> EntityKind {
    EntityKind::parse(old)
}

/// Old comment actions: only `start_agent_task` survives, as the TODO's
/// `agent_conversation` field; `accept_suggestion` / `reject_suggestion`
/// (Copilot) and the older `convert_to_memo` are dropped.
pub fn comment_action_survives(kind: &str) -> bool {
    kind == "start_agent_task"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_values_map_to_current_ones() {
        assert_eq!(comment_source("copilot"), CommentSource::Api);
        assert_eq!(comment_source("manual"), CommentSource::Manual);
        assert_eq!(comment_author_kind("copilot"), CommentAuthorKind::Ai);
        assert_eq!(comment_status("converted"), CommentStatus::Resolved);
        assert_eq!(comment_status("open"), CommentStatus::Open);
        assert_eq!(entity_kind("library_item"), EntityKind::Material);
        assert!(comment_action_survives("start_agent_task"));
        assert!(!comment_action_survives("accept_suggestion"));
        // Read without the import mapping, a retired value stays visible.
        assert!(!CommentSource::parse("copilot").is_known());
    }
}
