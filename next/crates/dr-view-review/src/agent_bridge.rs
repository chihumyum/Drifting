//! Bridge between M18 Review comment cards and M31 Agent conversations.
//!
//! `dr-view-agent` registers the dispatch and active-run query callbacks at
//! application startup; `dr-shell` wires the sidebar tab opener per Review
//! pane. Neither direction introduces a crate dependency cycle.

use std::collections::HashMap;

use gpui::{App, AppContext as _, Context, Entity, Global};

/// Request to hand a comment over to the Agent (`交给 Agent`).
#[derive(Clone, Debug)]
pub struct CommentAgentRequest {
    pub book_id: String,
    pub book_name: String,
    pub comment_id: String,
    /// Reused when the comment was already handed to Agent before (`再交一次接着同一次对话`).
    pub existing_conversation: Option<String>,
    /// Pre-localized header prefix shown at the top of the user message, e.g. `批注 · 林晚 · 设定 · 年龄`.
    pub header: String,
    /// Quoted text at the commented place, if any.
    pub quote: Option<String>,
    /// Comment body.
    pub body: String,
    /// Optional extra note typed in the side flyout (`写给 Agent…`).
    pub extra_note: String,
}

/// Request to focus a specific Agent conversation from Review and show `‹ 回审阅`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionFocusRequest {
    pub book_id: String,
    pub conversation_id: String,
    pub comment_id: String,
    /// Title shown beside the `‹` back button in the Agent panel header, e.g. `林晚 · 设定 · 年龄`.
    pub return_title: String,
}

/// Visual state of the Agent pinwheel at the bottom-right corner of a comment card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversationPinwheel {
    /// Never dispatched, or finished and already viewed by the author.
    Hidden,
    /// Currently running: hollow pinwheel spinning CCW (`1.6s`/turn).
    Running,
    /// Finished and not yet viewed: decelerates `3.0s`, fades `0.6s` to solid, rests solid.
    UnviewedDone,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TrackedConversation {
    launching: usize,
    running: bool,
    unviewed: bool,
}

/// App-lifetime observable state shared between Review cards and Agent panels.
#[derive(Default)]
pub struct CommentAgentTracker {
    conversations: HashMap<(String, String), TrackedConversation>,
    pending_open: Option<CompanionFocusRequest>,
}

impl CommentAgentTracker {
    pub fn pinwheel(&self, book_id: &str, conversation_id: &str) -> ConversationPinwheel {
        let Some(entry) = self
            .conversations
            .get(&(book_id.to_owned(), conversation_id.to_owned()))
        else {
            return ConversationPinwheel::Hidden;
        };
        if entry.launching > 0 || entry.running {
            ConversationPinwheel::Running
        } else if entry.unviewed {
            ConversationPinwheel::UnviewedDone
        } else {
            ConversationPinwheel::Hidden
        }
    }

    pub fn tracked_keys(&self) -> Vec<(String, String)> {
        self.conversations.keys().cloned().collect()
    }

    pub fn has_tracked(&self, book_id: &str, conversation_id: &str) -> bool {
        self.conversations
            .contains_key(&(book_id.to_owned(), conversation_id.to_owned()))
    }

    pub fn mark_dispatched(
        &mut self,
        book_id: &str,
        conversation_id: &str,
        cx: &mut Context<Self>,
    ) {
        let entry = self
            .conversations
            .entry((book_id.to_owned(), conversation_id.to_owned()))
            .or_default();
        entry.launching += 1;
        entry.running = true;
        entry.unviewed = true;
        cx.notify();
    }

    pub fn finish_launch(&mut self, book_id: &str, conversation_id: &str, cx: &mut Context<Self>) {
        if let Some(entry) = self
            .conversations
            .get_mut(&(book_id.to_owned(), conversation_id.to_owned()))
        {
            entry.launching = entry.launching.saturating_sub(1);
            cx.notify();
        }
    }

    pub fn seed_existing(
        &mut self,
        book_id: &str,
        conversation_id: &str,
        running: bool,
        cx: &mut Context<Self>,
    ) {
        let key = (book_id.to_owned(), conversation_id.to_owned());
        if self.conversations.contains_key(&key) {
            return;
        }
        self.conversations.insert(
            key,
            TrackedConversation {
                launching: 0,
                running,
                unviewed: running,
            },
        );
        if running {
            cx.notify();
        }
    }

    pub fn set_running(
        &mut self,
        book_id: &str,
        conversation_id: &str,
        running: bool,
        viewed_now: bool,
        cx: &mut Context<Self>,
    ) {
        let key = (book_id.to_owned(), conversation_id.to_owned());
        let entry = self
            .conversations
            .entry(key)
            .or_insert(TrackedConversation {
                launching: 0,
                running,
                unviewed: running,
            });
        let effective_running = running || entry.launching > 0;
        let next = TrackedConversation {
            launching: entry.launching,
            running: effective_running,
            unviewed: if effective_running {
                true
            } else if viewed_now {
                false
            } else {
                entry.unviewed
            },
        };
        if *entry != next {
            *entry = next;
            cx.notify();
        }
    }

    pub fn mark_viewed(&mut self, book_id: &str, conversation_id: &str, cx: &mut Context<Self>) {
        let key = (book_id.to_owned(), conversation_id.to_owned());
        if let Some(entry) = self.conversations.get_mut(&key)
            && entry.launching == 0
            && !entry.running
            && entry.unviewed
        {
            entry.unviewed = false;
            cx.notify();
        }
    }

    pub fn set_pending_open(&mut self, req: CompanionFocusRequest, cx: &mut Context<Self>) {
        self.pending_open = Some(req);
        cx.notify();
    }

    pub fn take_pending_open(&mut self, book_id: &str) -> Option<CompanionFocusRequest> {
        if self
            .pending_open
            .as_ref()
            .is_some_and(|req| req.book_id == book_id)
        {
            self.pending_open.take()
        } else {
            None
        }
    }

    pub fn peek_pending_open(&self) -> Option<&CompanionFocusRequest> {
        self.pending_open.as_ref()
    }

    pub fn clear_library_state(&mut self, cx: &mut Context<Self>) {
        if !self.conversations.is_empty() || self.pending_open.is_some() {
            self.conversations.clear();
            self.pending_open = None;
            cx.notify();
        }
    }
}

pub type DispatchFn = Box<dyn Fn(CommentAgentRequest, &mut App) -> Result<String, String>>;
pub type QueryRunningFn = Box<dyn Fn(&str, &mut App) -> bool>;

struct AgentBridgeGlobal {
    tracker: Entity<CommentAgentTracker>,
    dispatch: Option<DispatchFn>,
    query_running: Option<QueryRunningFn>,
}

impl Global for AgentBridgeGlobal {}

fn ensure_global(cx: &mut App) -> Entity<CommentAgentTracker> {
    if let Some(global) = cx.try_global::<AgentBridgeGlobal>() {
        return global.tracker.clone();
    }
    let tracker = cx.new(|_| CommentAgentTracker::default());
    cx.set_global(AgentBridgeGlobal {
        tracker: tracker.clone(),
        dispatch: None,
        query_running: None,
    });
    tracker
}

/// Returns the shared [`CommentAgentTracker`] entity, creating it if needed.
pub fn ensure_tracker(cx: &mut App) -> Entity<CommentAgentTracker> {
    ensure_global(cx)
}

/// Borrows the shared [`CommentAgentTracker`] if initialized.
pub fn tracker(cx: &App) -> Option<Entity<CommentAgentTracker>> {
    cx.try_global::<AgentBridgeGlobal>()
        .map(|g| g.tracker.clone())
}

/// Registers the Agent runtime callbacks (`dr-view-agent::init_with_service`).
pub fn register(
    dispatch: DispatchFn,
    query_running: QueryRunningFn,
    cx: &mut App,
) -> Entity<CommentAgentTracker> {
    let tracker = ensure_global(cx);
    let global = cx.global_mut::<AgentBridgeGlobal>();
    global.dispatch = Some(dispatch);
    global.query_running = Some(query_running);
    tracker
}

/// Clears library-scoped tracking state without dropping registered callbacks.
pub fn reset_library_state(cx: &mut App) {
    if let Some(tracker) = tracker(cx) {
        tracker.update(cx, |t, cx| t.clear_library_state(cx));
    }
}

/// Hands a comment to the Agent, returning the `ConversationId` string.
pub fn dispatch(req: CommentAgentRequest, cx: &mut App) -> Result<String, String> {
    let _ = ensure_global(cx);
    let f = cx
        .global_mut::<AgentBridgeGlobal>()
        .dispatch
        .take()
        .ok_or_else(|| "Agent runtime is not initialized".to_owned())?;
    let result = f(req, cx);
    if let Some(global) = cx.try_global::<AgentBridgeGlobal>() {
        let _ = global;
        cx.global_mut::<AgentBridgeGlobal>().dispatch = Some(f);
    }
    result
}

/// Ensures an existing `agent_conversation` on a comment is registered in the tracker.
pub fn ensure_watched(book_id: &str, conversation_id: &str, cx: &mut App) {
    let tracker = ensure_global(cx);
    if tracker.read(cx).has_tracked(book_id, conversation_id) {
        return;
    }
    let running = if let Some(f) = cx.global_mut::<AgentBridgeGlobal>().query_running.take() {
        let active = f(conversation_id, cx);
        cx.global_mut::<AgentBridgeGlobal>().query_running = Some(f);
        active
    } else {
        false
    };
    tracker.update(cx, |t, cx| {
        t.seed_existing(book_id, conversation_id, running, cx)
    });
}

/// Reads the current pinwheel state for `(book_id, conversation_id)`.
pub fn pinwheel_state(book_id: &str, conversation_id: &str, cx: &App) -> ConversationPinwheel {
    tracker(cx)
        .map(|t| t.read(cx).pinwheel(book_id, conversation_id))
        .unwrap_or(ConversationPinwheel::Hidden)
}

/// Marks a finished conversation as viewed so its solid pinwheel disappears.
pub fn mark_viewed(book_id: &str, conversation_id: &str, cx: &mut App) {
    let tracker = ensure_global(cx);
    tracker.update(cx, |t, cx| t.mark_viewed(book_id, conversation_id, cx));
}

/// Posts a request for the Agent panel to select `conversation_id` and show `‹ 回审阅`.
pub fn request_open_conversation(req: CompanionFocusRequest, cx: &mut App) {
    let tracker = ensure_global(cx);
    tracker.update(cx, |t, cx| t.set_pending_open(req, cx));
}

/// Formats the durable user message sent to the Agent for a comment handoff.
pub fn format_user_message(req: &CommentAgentRequest) -> String {
    let meta = match req
        .quote
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
    {
        Some(quote) => {
            let escaped = serde_json::to_string(quote).unwrap_or_else(|_| format!("\"{quote}\""));
            format!("[comment:{}; quote:{escaped}]", req.comment_id)
        }
        None => format!("[comment:{}]", req.comment_id),
    };
    let mut body = req.body.trim().to_owned();
    let extra = req.extra_note.trim();
    if !extra.is_empty() {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(extra);
    }
    format!("{} {meta}\n{body}", req.header.trim())
}

/// Parses a user message created by [`format_user_message`] into `(header, body)`
/// so the Agent transcript renders the muted `批注 · …` header without raw metadata.
pub fn parse_comment_user_message(text: &str) -> Option<(&str, &str)> {
    let (first_line, rest) = text.split_once('\n')?;
    let tag_idx = first_line.rfind(" [comment:")?;
    if !first_line.ends_with(']') {
        return None;
    }
    let header = first_line[..tag_idx].trim();
    if header.is_empty() {
        return None;
    }
    Some((header, rest))
}

/// Strips trailing ` [comment:...]` metadata from a single-line conversation title.
pub fn clean_conversation_title(title: &str) -> &str {
    if let Some(tag_idx) = title.rfind(" [comment:")
        && title.ends_with(']')
    {
        return title[..tag_idx].trim();
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_message_round_trips_header_and_body() {
        let req = CommentAgentRequest {
            book_id: "book_1".into(),
            book_name: "雾季".into(),
            comment_id: "cmt_123".into(),
            existing_conversation: None,
            header: "批注 · 林晚 · 设定 · 年龄".into(),
            quote: Some("二十七".into()),
            body: "第一章说她二十五，统一一下。".into(),
            extra_note: "顺便看看第三章有没有写她的生日。".into(),
        };
        let encoded = format_user_message(&req);
        assert!(encoded.contains("[comment:cmt_123; quote:\"二十七\"]"));
        let (header, body) = parse_comment_user_message(&encoded).expect("parsed");
        assert_eq!(header, "批注 · 林晚 · 设定 · 年龄");
        assert_eq!(
            body,
            "第一章说她二十五，统一一下。\n顺便看看第三章有没有写她的生日。"
        );
        let first_line = encoded.lines().next().unwrap();
        assert_eq!(
            clean_conversation_title(first_line),
            "批注 · 林晚 · 设定 · 年龄"
        );
    }
}
