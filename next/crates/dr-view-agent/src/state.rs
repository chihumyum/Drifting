//! Read-only projections of the durable journal and synchronized transcript.
//!
//! There is no UI message store: these values can always be reconstructed.
//! Local controls and receipt row ids stay in `RunSnapshot`; only transcript
//! entries are shared with another device.

use std::collections::{BTreeMap, HashMap};

use dr_agent::{
    AssistantMessage, ContentBlock, Event, JournalEvent, ModelFailure, ProviderTool, Question,
    RequestId, RunConfig, SettlementRef, State, ToolCall, ToolPolicy, ToolResult, ToolStatus,
    Usage,
};
use dr_model::{
    conversation::{ConversationEntry, ConversationEntryKind},
    id::ConversationId,
};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
pub struct ConversationSummary {
    pub id: ConversationId,
    /// First author's words; an empty title lets the view use its empty label.
    pub title: String,
    pub message_count: usize,
    pub active: Vec<String>,
    pub interrupted: bool,
    /// Local session time, or zero for a conversation only received by sync.
    pub last_created_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatSnapshot {
    pub conversation: ConversationId,
    pub entries: Vec<ConversationEntry>,
    pub messages: Vec<ChatMessage>,
    pub runs: Vec<RunSnapshot>,
}

/// Presentation order keeps the synchronized transcript untouched and places
/// local cards after the last message in their own turn. Synced conversations
/// need not have any local journal at all.
pub enum TranscriptItem<'a> {
    Message(&'a ChatMessage),
    Run { run: &'a RunSnapshot, turn: u32 },
}

impl ChatSnapshot {
    pub fn transcript(&self) -> Vec<TranscriptItem<'_>> {
        let mut last = HashMap::new();
        for (index, message) in self.messages.iter().enumerate() {
            last.insert((message.session.as_str(), message.turn), index);
        }
        let runs: HashMap<_, _> = self
            .runs
            .iter()
            .map(|run| (run.session.as_str(), run))
            .collect();
        let mut items = Vec::new();
        for (index, message) in self.messages.iter().enumerate() {
            items.push(TranscriptItem::Message(message));
            if last.get(&(message.session.as_str(), message.turn)) == Some(&index)
                && let Some(run) = runs.get(message.session.as_str())
            {
                items.push(TranscriptItem::Run {
                    run,
                    turn: message.turn,
                });
            }
        }
        for run in &self.runs {
            if !last.contains_key(&(run.session.as_str(), run.turn)) {
                items.push(TranscriptItem::Run {
                    run,
                    turn: run.turn,
                });
            }
        }
        items
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatMessage {
    pub id: String,
    pub session: String,
    pub turn: u32,
    pub content: MessageContent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageContent {
    User {
        text: String,
    },
    Assistant {
        message: AssistantMessage,
    },
    ToolResult {
        call: String,
        status: ToolStatus,
        output: Value,
    },
    /// Preserve future/unknown structured contents without guessing their meaning.
    Other {
        entry_kind: ConversationEntryKind,
        payload: Value,
    },
}

impl From<&ConversationEntry> for ChatMessage {
    fn from(entry: &ConversationEntry) -> Self {
        let payload = &entry.payload;
        let content = match entry.kind {
            ConversationEntryKind::User => {
                payload
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| MessageContent::User {
                        text: text.to_owned(),
                    })
            }
            ConversationEntryKind::Assistant => serde_json::from_value(payload.clone())
                .ok()
                .map(|message| MessageContent::Assistant { message }),
            ConversationEntryKind::ToolResult => payload
                .get("call")
                .and_then(Value::as_str)
                .zip(
                    payload
                        .get("status")
                        .and_then(|value| serde_json::from_value(value.clone()).ok()),
                )
                .map(|(call, status)| MessageContent::ToolResult {
                    call: call.to_owned(),
                    status,
                    output: payload.get("output").cloned().unwrap_or(Value::Null),
                }),
            _ => None,
        }
        .unwrap_or_else(|| MessageContent::Other {
            entry_kind: entry.kind.clone(),
            payload: payload.clone(),
        });
        Self {
            id: entry.id.clone(),
            session: entry.session.clone(),
            turn: entry.turn,
            content,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PendingQuestion {
    pub request: RequestId,
    pub question: Question,
}

#[derive(Clone, Debug, Serialize)]
pub struct QuestionRecord {
    pub request: RequestId,
    pub question: Question,
    pub answer: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PendingPermission {
    pub request: RequestId,
    pub policy: ToolPolicy,
    pub call: ToolCall,
}

#[derive(Clone, Debug, Serialize)]
pub struct Steering {
    pub id: String,
    pub text: String,
    pub turn: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChangedReceipt {
    pub turn: u32,
    pub receipt: SettlementRef,
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolActivity {
    pub id: String,
    pub call: Option<ToolCall>,
    pub started: bool,
    pub result: Option<ToolResult>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RunSnapshot {
    pub session: String,
    pub turn: u32,
    pub state: State,
    pub config: Option<RunConfig>,
    /// Last reported model input, used with the frozen context-window limit.
    pub usage: Usage,
    pub live_message: Option<AssistantMessage>,
    pub question: Option<PendingQuestion>,
    pub questions: Vec<QuestionRecord>,
    pub permission: Option<PendingPermission>,
    pub provider_tools: Vec<ProviderTool>,
    pub provider_tool_turns: BTreeMap<String, u32>,
    pub tools: Vec<ToolActivity>,
    pub changes: Vec<ChangedReceipt>,
    pub unapplied_steering: Vec<Steering>,
    pub error: Option<String>,
    pub model_failure: Option<ModelFailure>,
    pub last_seq: i64,
}

/// A deterministic, sequence-checked reducer. A view may rebuild it or feed
/// the next durable suffix; repeated events are harmless, gaps are errors.
pub struct ChatState {
    run: RunSnapshot,
    entries: Vec<ConversationEntry>,
}

impl ChatState {
    pub fn new(session: impl Into<String>) -> Self {
        Self {
            run: RunSnapshot {
                session: session.into(),
                turn: 1,
                state: State::Streaming,
                config: None,
                usage: Usage::default(),
                live_message: None,
                question: None,
                questions: Vec::new(),
                permission: None,
                provider_tools: Vec::new(),
                provider_tool_turns: BTreeMap::new(),
                tools: Vec::new(),
                changes: Vec::new(),
                unapplied_steering: Vec::new(),
                error: None,
                model_failure: None,
                last_seq: 0,
            },
            entries: Vec::new(),
        }
    }

    pub fn snapshot(&self) -> RunSnapshot {
        self.run.clone()
    }

    /// Projected events which may be one holder write ahead of the Loro read.
    /// The controller merges them by immutable event id; it never writes them.
    pub fn entries(&self) -> &[ConversationEntry] {
        &self.entries
    }

    pub fn apply(&mut self, row: &JournalEvent) -> Result<(), String> {
        if row.session != self.run.session {
            return Err("journal belongs to a different session".into());
        }
        if row.seq < 1 {
            return Err("journal sequence must be positive".into());
        }
        if row.seq <= self.run.last_seq {
            return Ok(());
        }
        if row.seq != self.run.last_seq + 1 {
            return Err("journal sequence is not contiguous".into());
        }
        self.run.last_seq = row.seq;
        self.run.turn = row.turn;
        match &row.event {
            Event::Configured { config } => self.run.config = Some(config.clone()),
            Event::StateChanged { state } => {
                self.run.state = *state;
                if *state == State::Streaming {
                    self.run.live_message = None;
                }
                if state.is_terminal() {
                    self.run.question = None;
                    self.run.permission = None;
                }
            }
            Event::TextDelta { index, text } => self.delta(*index, text, false),
            Event::ThinkingDelta { index, text } => self.delta(*index, text, true),
            Event::ThinkingSignature {
                index,
                signature,
                replay,
            } => {
                self.delta(*index, "", true);
                if let Some(message) = &mut self.run.live_message {
                    for block in &mut message.blocks {
                        if let ContentBlock::Thinking {
                            index: i,
                            signature: s,
                            replay: r,
                            ..
                        } = block
                            && i == index
                        {
                            *s = signature.clone();
                            *r = replay.clone();
                        }
                    }
                }
            }
            Event::Usage { usage } => {
                self.run.usage = *usage;
                if let Some(message) = &mut self.run.live_message {
                    message.usage = *usage;
                }
            }
            Event::AssistantMessage { message } => {
                self.run.usage = message.usage;
                self.run.live_message = None;
            }
            Event::ProviderTool { activity } => {
                self.run
                    .provider_tool_turns
                    .entry(activity.id.clone())
                    .or_insert(row.turn);
                if let Some(previous) = self
                    .run
                    .provider_tools
                    .iter_mut()
                    .find(|a| a.id == activity.id)
                {
                    let mut next = activity.clone();
                    if next.query.is_none() {
                        next.query.clone_from(&previous.query);
                    }
                    if next.url.is_none() {
                        next.url.clone_from(&previous.url);
                    }
                    *previous = next;
                } else {
                    self.run.provider_tools.push(activity.clone());
                }
            }
            Event::ToolProposed { call } | Event::ToolStarted { call } => {
                let started = matches!(row.event, Event::ToolStarted { .. });
                let tool = self.tool(&call.id);
                tool.call = Some(call.clone());
                tool.started |= started;
            }
            Event::ToolFinished { result } => {
                self.tool(&result.call).result = Some(result.clone());
                for receipt in &result.settlements {
                    if !self
                        .run
                        .changes
                        .iter()
                        .any(|change| change.receipt.id == receipt.id)
                    {
                        self.run.changes.push(ChangedReceipt {
                            turn: row.turn,
                            receipt: receipt.clone(),
                        });
                    }
                }
            }
            Event::QuestionAsked { request, question } => {
                self.run.question = Some(PendingQuestion {
                    request: request.clone(),
                    question: question.clone(),
                });
                self.run.questions.push(QuestionRecord {
                    request: request.clone(),
                    question: question.clone(),
                    answer: None,
                });
            }
            Event::Answered { request, answer } => {
                if self
                    .run
                    .question
                    .as_ref()
                    .is_some_and(|q| q.request == *request)
                {
                    self.run.question = None;
                }
                if let Some(record) = self
                    .run
                    .questions
                    .iter_mut()
                    .find(|q| q.request == *request)
                {
                    record.answer = Some(answer.clone());
                }
            }
            Event::PermissionAsked {
                request,
                policy,
                call,
            } => {
                self.run.permission = Some(PendingPermission {
                    request: request.clone(),
                    policy: *policy,
                    call: call.clone(),
                });
            }
            Event::PermissionAnswered { request, .. } => {
                if self
                    .run
                    .permission
                    .as_ref()
                    .is_some_and(|p| p.request == *request)
                {
                    self.run.permission = None;
                }
            }
            Event::SteeringReceived { id, text } => self.run.unapplied_steering.push(Steering {
                id: id.clone(),
                text: text.clone(),
                turn: row.turn,
            }),
            Event::SteeringApplied { id } => self.run.unapplied_steering.retain(|s| s.id != *id),
            Event::Failed { error } => self.run.error = Some(error.clone()),
            Event::ModelFailed { failure } => self.run.model_failure = Some(failure.clone()),
            _ => {}
        }
        let projected = match &row.event {
            Event::UserMessage { text } => Some((
                ConversationEntryKind::User,
                serde_json::json!({"text":text}),
            )),
            Event::AssistantMessage { message } => Some((
                ConversationEntryKind::Assistant,
                serde_json::to_value(message).map_err(|e| e.to_string())?,
            )),
            Event::ToolFinished { result } => Some((
                ConversationEntryKind::ToolResult,
                serde_json::json!({"call":result.call,"status":result.status,"output":result.output}),
            )),
            _ => None,
        };
        if let Some((kind, payload)) = projected {
            self.entries.push(ConversationEntry {
                id: format!("{}:{}", row.session, row.seq),
                session: row.session.clone(),
                turn: row.turn,
                kind,
                payload,
            });
        }
        Ok(())
    }

    fn tool(&mut self, id: &str) -> &mut ToolActivity {
        let index = self
            .run
            .tools
            .iter()
            .position(|tool| tool.id == id)
            .unwrap_or_else(|| {
                self.run.tools.push(ToolActivity {
                    id: id.into(),
                    call: None,
                    started: false,
                    result: None,
                });
                self.run.tools.len() - 1
            });
        &mut self.run.tools[index]
    }

    fn delta(&mut self, index: u32, text: &str, thinking: bool) {
        let message = self
            .run
            .live_message
            .get_or_insert_with(AssistantMessage::default);
        let existing = message.blocks.iter_mut().find(|block| match block {
            ContentBlock::Text { index: i, .. } => !thinking && *i == index,
            ContentBlock::Thinking { index: i, .. } => thinking && *i == index,
            _ => false,
        });
        match existing {
            Some(
                ContentBlock::Text { text: value, .. } | ContentBlock::Thinking { text: value, .. },
            ) => value.push_str(text),
            _ => {
                message.blocks.push(if thinking {
                    ContentBlock::Thinking {
                        index,
                        text: text.into(),
                        signature: None,
                        replay: None,
                    }
                } else {
                    ContentBlock::Text {
                        index,
                        text: text.into(),
                    }
                });
                message.blocks.sort_by_key(|block| match block {
                    ContentBlock::Text { index, .. } | ContentBlock::Thinking { index, .. } => {
                        *index
                    }
                    ContentBlock::ToolCall { .. } => u32::MAX,
                });
            }
        }
    }
}
