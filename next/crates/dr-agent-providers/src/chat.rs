//! OpenAI-compatible Chat Completions for local servers (Ollama, LM Studio,
//! llama.cpp …). Like the DeepSeek adapter in shape, without its own fields:
//! no `thinking`, no reasoning effort, no web search, and an output limit
//! only when one was set explicitly. What a model thinks arrives either as
//! `reasoning_content` / `reasoning` or inline as `<think>…</think>`; both
//! become thinking, never answer text.

use std::collections::{BTreeMap, BTreeSet};

use dr_agent::{
    AssistantMessage, ContentBlock, DriverEvent, DriverRequest, FinishReason, ToolCall, Usage,
};
use dr_model::conversation::ConversationEntryKind;
use serde_json::{Value, json};

use crate::deepseek::{
    check_tool_closure, nonblank, optional_string, stream_error, string, tool_result, wire_call,
};
use crate::{ProviderError, Result, SseEvent};

/// The search flag is ignored: a local server has no hosted search tool.
pub fn request(request: &DriverRequest, _search: bool) -> Result<Value> {
    crate::transport::single_request(request)?;
    let config = &request.config;
    let mut messages = vec![json!({"role": "system", "content": config.system_prompt})];
    let conversation = crate::conversation::project(&request.conversation)?;
    for entry in conversation.iter() {
        match entry.kind {
            ConversationEntryKind::User => messages.push(json!({
                "role": "user", "content": string(&entry.payload, "text")?,
            })),
            ConversationEntryKind::Assistant => {
                let message: AssistantMessage = serde_json::from_value(entry.payload.clone())
                    .map_err(|_| {
                        ProviderError::protocol("invalid assistant conversation record")
                    })?;
                let mut content = String::new();
                let mut calls = Vec::new();
                for block in message.blocks {
                    match block {
                        ContentBlock::Text { text, .. } => content.push_str(&text),
                        ContentBlock::ToolCall { call } => calls.push(wire_call(&call)),
                        // Earlier thinking is not sent back to a local model.
                        ContentBlock::Thinking { .. } => {}
                    }
                }
                let mut item = json!({"role": "assistant", "content": content});
                if !calls.is_empty() {
                    if content.is_empty() {
                        item["content"] = Value::Null;
                    }
                    item["tool_calls"] = calls.into();
                }
                messages.push(item);
            }
            ConversationEntryKind::ToolResult => messages.push(json!({
                "role": "tool", "tool_call_id": nonblank(&entry.payload, "call")?,
                "content": tool_result(&entry.payload)?,
            })),
            ConversationEntryKind::ToolCall => {
                let call: ToolCall = serde_json::from_value(entry.payload.clone())
                    .map_err(|_| ProviderError::protocol("invalid tool conversation record"))?;
                messages.push(
                    json!({"role":"assistant", "content":null, "tool_calls":[wire_call(&call)]}),
                );
            }
            _ => {}
        }
    }
    check_tool_closure(&messages)?;
    let mut body = json!({
        "model": config.route.model, "messages": messages, "stream": true,
        "stream_options": {"include_usage": true},
    });
    if let Some(max) = config.max_output_tokens {
        body["max_tokens"] = max.into();
    }
    if !request.tools.is_empty() {
        body["tools"] = request.tools.iter().map(|tool| json!({
            "type":"function", "function": {"name":tool.name,"description":tool.description,"parameters":tool.input_schema},
        })).collect::<Vec<_>>().into();
    }
    Ok(body)
}

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Nothing visible yet: a `<think>` may still open.
    Start,
    Thinking,
    /// Just after `</think>`: the answer's leading blank lines are dropped.
    AfterThinking,
    Answer,
}

#[derive(Debug, PartialEq, Eq)]
enum Piece {
    Thinking(String),
    Text(String),
}

/// Splits streamed content into thinking and answer across arbitrary chunk
/// boundaries. Only a `<think>` before any visible text opens thinking.
struct Splitter {
    phase: Phase,
    pending: String,
}

impl Splitter {
    fn new() -> Self {
        Self {
            phase: Phase::Start,
            pending: String::new(),
        }
    }

    fn push(&mut self, text: &str) -> Vec<Piece> {
        let mut out = Vec::new();
        self.pending.push_str(text);
        loop {
            match self.phase {
                Phase::Start => {
                    let trimmed = self.pending.trim_start();
                    if let Some(rest) = trimmed.strip_prefix(OPEN) {
                        self.pending = rest.to_owned();
                        self.phase = Phase::Thinking;
                    } else if OPEN.starts_with(trimmed) {
                        return out;
                    } else {
                        self.phase = Phase::Answer;
                    }
                }
                Phase::Thinking => {
                    if let Some(at) = self.pending.find(CLOSE) {
                        let thought = self.pending[..at].to_owned();
                        self.pending = self.pending[at + CLOSE.len()..].to_owned();
                        if !thought.is_empty() {
                            out.push(Piece::Thinking(thought));
                        }
                        self.phase = Phase::AfterThinking;
                    } else {
                        let keep = held_back(&self.pending, CLOSE);
                        let emit = self.pending.len() - keep;
                        if emit > 0 {
                            out.push(Piece::Thinking(self.pending[..emit].to_owned()));
                            self.pending.drain(..emit);
                        }
                        return out;
                    }
                }
                Phase::AfterThinking => {
                    let trimmed = self.pending.trim_start();
                    if trimmed.is_empty() {
                        self.pending.clear();
                        return out;
                    }
                    self.pending = trimmed.to_owned();
                    self.phase = Phase::Answer;
                }
                Phase::Answer => {
                    if !self.pending.is_empty() {
                        out.push(Piece::Text(std::mem::take(&mut self.pending)));
                    }
                    return out;
                }
            }
        }
    }

    /// The stream ended: whatever is held back is what it looked like.
    fn finish(&mut self) -> Vec<Piece> {
        let rest = std::mem::take(&mut self.pending);
        match self.phase {
            _ if rest.is_empty() => Vec::new(),
            Phase::Thinking => vec![Piece::Thinking(rest)],
            Phase::AfterThinking => Vec::new(),
            Phase::Start | Phase::Answer => vec![Piece::Text(rest)],
        }
    }
}

/// How many trailing bytes of `text` could be the start of `tag`.
fn held_back(text: &str, tag: &str) -> usize {
    (1..tag.len().min(text.len() + 1))
        .rev()
        .find(|&n| {
            text.is_char_boundary(text.len() - n) && tag.starts_with(&text[text.len() - n..])
        })
        .unwrap_or(0)
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}

pub struct Decoder {
    index_offset: u32,
    splitter: Splitter,
    calls: BTreeMap<u32, Call>,
    usage: Option<Usage>,
    reason: Option<String>,
    terminal: bool,
}

impl Decoder {
    pub fn new(index_offset: u32) -> Self {
        Self {
            index_offset,
            splitter: Splitter::new(),
            calls: BTreeMap::new(),
            usage: None,
            reason: None,
            terminal: false,
        }
    }

    fn events(&self, pieces: Vec<Piece>) -> Result<Vec<DriverEvent>> {
        let text_index = self
            .index_offset
            .checked_add(1)
            .ok_or_else(|| ProviderError::protocol("content index overflow"))?;
        Ok(pieces
            .into_iter()
            .map(|piece| match piece {
                Piece::Thinking(text) => DriverEvent::ThinkingDelta {
                    index: self.index_offset,
                    text,
                },
                Piece::Text(text) => DriverEvent::TextDelta {
                    index: text_index,
                    text,
                },
            })
            .collect())
    }

    pub fn push(&mut self, event: &SseEvent) -> Result<Vec<DriverEvent>> {
        if self.terminal {
            return Err(ProviderError::protocol("event after stream completion"));
        }
        if event.data.trim() == "[DONE]" {
            return self.complete();
        }
        let chunk: Value = serde_json::from_str(&event.data)
            .map_err(|_| ProviderError::protocol("stream contains invalid JSON"))?;
        if !chunk.is_object() {
            return Err(ProviderError::protocol("stream event is not an object"));
        }
        if chunk.get("error").is_some_and(|error| !error.is_null()) {
            return Err(stream_error(&chunk));
        }
        if let Some(usage) = chunk.get("usage").filter(|v| !v.is_null()) {
            self.usage = Some(parse_usage(usage));
        }
        let Some(choices) = chunk.get("choices").and_then(Value::as_array) else {
            return Ok(Vec::new());
        };
        if choices.is_empty() {
            return Ok(Vec::new());
        }
        if choices.len() != 1
            || choices[0]
                .get("index")
                .and_then(Value::as_u64)
                .is_some_and(|index| index != 0)
        {
            return Err(ProviderError::protocol("server returned multiple choices"));
        }
        let choice = &choices[0];
        let empty = json!({});
        let delta = choice
            .get("delta")
            .filter(|v| v.is_object())
            .unwrap_or(&empty);
        let content = optional_string(delta, "content")?.filter(|text| !text.is_empty());
        let reasoning = optional_string(delta, "reasoning_content")?
            .or(optional_string(delta, "reasoning")?)
            .filter(|text| !text.is_empty());
        let calls = delta
            .get("tool_calls")
            .filter(|v| !v.is_null())
            .map(|calls| {
                calls
                    .as_array()
                    .ok_or_else(|| ProviderError::protocol("invalid tool delta"))
            })
            .transpose()?
            .filter(|calls| !calls.is_empty());
        if self.reason.is_some() && (content.is_some() || reasoning.is_some() || calls.is_some()) {
            return Err(ProviderError::protocol("content after finish reason"));
        }
        let mut events = Vec::new();
        if let Some(text) = reasoning {
            events.push(DriverEvent::ThinkingDelta {
                index: self.index_offset,
                text: text.into(),
            });
        }
        if let Some(text) = content {
            let pieces = self.splitter.push(text);
            events.extend(self.events(pieces)?);
        }
        for part in calls.into_iter().flatten() {
            self.tool_delta(part)?;
        }
        if let Some(reason) = optional_string(choice, "finish_reason")?
            && !reason.is_empty()
        {
            self.reason = Some(reason.into());
        }
        Ok(events)
    }

    fn tool_delta(&mut self, part: &Value) -> Result<()> {
        let id = optional_string(part, "id")?.filter(|id| !id.is_empty());
        let index = match part.get("index").and_then(Value::as_u64) {
            Some(index) => {
                u32::try_from(index).map_err(|_| ProviderError::protocol("tool index overflow"))?
            }
            // Some servers omit the index: an id names the call, otherwise
            // the fragment continues the last one.
            None => match id {
                Some(id) => self
                    .calls
                    .iter()
                    .find(|(_, call)| call.id == id)
                    .map(|(index, _)| *index)
                    .unwrap_or_else(|| self.next_call()),
                None => self
                    .calls
                    .keys()
                    .next_back()
                    .copied()
                    .unwrap_or_else(|| self.next_call()),
            },
        };
        let call = self.calls.entry(index).or_default();
        if let Some(id) = id {
            if !call.id.is_empty() && call.id != id {
                return Err(ProviderError::protocol("tool identity changed"));
            }
            call.id = id.into();
        }
        if let Some(kind) = optional_string(part, "type")?
            && kind != "function"
        {
            return Err(ProviderError::protocol("unsupported tool type"));
        }
        if let Some(function) = part.get("function").filter(|v| !v.is_null()) {
            if !function.is_object() {
                return Err(ProviderError::protocol("invalid function delta"));
            }
            if let Some(name) = optional_string(function, "name")? {
                call.name.push_str(name);
            }
            match function.get("arguments") {
                None | Some(Value::Null) => {}
                Some(Value::String(arguments)) => call.arguments.push_str(arguments),
                // A whole object instead of JSON text.
                Some(arguments @ Value::Object(_)) => {
                    call.arguments.push_str(&arguments.to_string())
                }
                Some(_) => return Err(ProviderError::protocol("invalid tool arguments")),
            }
        }
        Ok(())
    }

    fn next_call(&self) -> u32 {
        self.calls.keys().next_back().map_or(0, |index| index + 1)
    }

    fn complete(&mut self) -> Result<Vec<DriverEvent>> {
        let pieces = self.splitter.finish();
        let mut events = self.events(pieces)?;
        let reason = self
            .reason
            .as_deref()
            .ok_or_else(|| ProviderError::protocol("stream ended without finish reason"))?;
        let has_tools = !self.calls.is_empty();
        // Older servers end a tool call with "stop".
        let finished = match reason {
            "stop" => true,
            "tool_calls" | "function_call" => has_tools,
            _ => false,
        };
        if !finished {
            return Err(ProviderError::protocol(
                "response was truncated or has inconsistent tool completion",
            ));
        }
        let mut ids = BTreeSet::new();
        let mut calls = Vec::new();
        for (index, call) in &self.calls {
            let name = call.name.trim();
            if name.is_empty() {
                return Err(ProviderError::protocol("tool call without a name"));
            }
            let mut id = call.id.trim().to_owned();
            if id.is_empty() {
                id = format!("call_{index}");
            }
            if !ids.insert(id.clone()) {
                return Err(ProviderError::protocol("duplicate tool identity"));
            }
            let arguments: Value = if call.arguments.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&call.arguments)
                    .map_err(|_| ProviderError::protocol("tool arguments are not valid JSON"))?
            };
            if !arguments.is_object() {
                return Err(ProviderError::protocol("tool arguments must be an object"));
            }
            calls.push(ToolCall {
                id,
                name: name.to_owned(),
                arguments,
            });
        }
        events.extend(calls.into_iter().map(DriverEvent::ToolCall));
        events.push(DriverEvent::Usage(self.usage.unwrap_or_default()));
        events.push(DriverEvent::Finish(if has_tools {
            FinishReason::Tools
        } else {
            FinishReason::Complete
        }));
        self.terminal = true;
        Ok(events)
    }

    pub fn finish(&self) -> Result<Option<Vec<Value>>> {
        if self.terminal {
            Ok(None)
        } else {
            Err(ProviderError::protocol("stream disconnected before [DONE]"))
        }
    }
}

/// Local servers report usage loosely or not at all; a missing count is 0.
fn parse_usage(value: &Value) -> Usage {
    let count = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: count("prompt_tokens"),
        output_tokens: count("completion_tokens"),
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: value
            .get("completion_tokens_details")
            .and_then(|details| details.get("reasoning_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_agent::{
        ModelCapabilities, Provider, RequestPurpose, RunConfig, ThinkingLevel, ToolAccess,
        ToolDescriptor, ToolPolicy,
    };
    use dr_model::conversation::ConversationEntry;
    use std::sync::Arc;

    fn sse(value: Value) -> SseEvent {
        SseEvent {
            event: None,
            data: value.to_string(),
        }
    }
    fn done() -> SseEvent {
        SseEvent {
            event: None,
            data: "[DONE]".into(),
        }
    }
    fn delta(delta: Value, reason: Value) -> SseEvent {
        sse(json!({"choices":[{"index":0,"delta":delta,"finish_reason":reason}]}))
    }
    fn collect(events: &[DriverEvent]) -> (String, String) {
        let (mut text, mut thinking) = (String::new(), String::new());
        for event in events {
            match event {
                DriverEvent::TextDelta { index, text: t } => {
                    assert_eq!(*index, 1);
                    text.push_str(t);
                }
                DriverEvent::ThinkingDelta { index, text: t } => {
                    assert_eq!(*index, 0);
                    thinking.push_str(t);
                }
                _ => {}
            }
        }
        (text, thinking)
    }

    fn run(chunks: &[&str]) -> (String, String) {
        let mut decoder = Decoder::new(0);
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(
                decoder
                    .push(&delta(json!({"content": chunk}), Value::Null))
                    .unwrap(),
            );
        }
        events.extend(decoder.push(&delta(json!({}), json!("stop"))).unwrap());
        events.extend(decoder.push(&done()).unwrap());
        assert!(matches!(
            events.last(),
            Some(DriverEvent::Finish(FinishReason::Complete))
        ));
        collect(&events)
    }

    #[test]
    fn inline_think_tags_become_thinking_across_any_chunk_boundary() {
        let whole = "\n<think>\nweigh the chapter\n</think>\n\nThe tide came in.";
        for size in 1..=whole.len() {
            let bytes: Vec<char> = whole.chars().collect();
            let chunks: Vec<String> = bytes.chunks(size).map(|c| c.iter().collect()).collect();
            let chunks: Vec<&str> = chunks.iter().map(String::as_str).collect();
            let (text, thinking) = run(&chunks);
            assert_eq!(text, "The tide came in.", "chunk size {size}");
            assert_eq!(thinking, "\nweigh the chapter\n", "chunk size {size}");
        }
        // A tag after visible text is just text; an unfinished tag stays text.
        assert_eq!(
            run(&["Use ", "<think>", " here"]),
            ("Use <think> here".into(), String::new())
        );
        assert_eq!(run(&["<thi"]), ("<thi".into(), String::new()));
        // An unclosed thought is still thinking, not answer.
        assert_eq!(
            run(&["<think>still", " going"]),
            (String::new(), "still going".into())
        );
        assert_eq!(held_back("abc</thi", CLOSE), 5);
        assert_eq!(held_back("abc", CLOSE), 0);
        assert_eq!(held_back("想<", CLOSE), 1);
    }

    #[test]
    fn reasoning_fields_and_usage_are_optional() {
        for field in ["reasoning_content", "reasoning"] {
            let mut decoder = Decoder::new(0);
            let mut events = decoder
                .push(&delta(json!({field: "plan"}), Value::Null))
                .unwrap();
            events.extend(
                decoder
                    .push(&delta(json!({"content": "Done."}), json!("stop")))
                    .unwrap(),
            );
            events.extend(decoder.push(&done()).unwrap());
            assert_eq!(collect(&events), ("Done.".into(), "plan".into()));
            assert!(events.iter().any(|e| matches!(
                e,
                DriverEvent::Usage(usage) if *usage == Usage::default()
            )));
            assert!(
                !events
                    .iter()
                    .any(|e| matches!(e, DriverEvent::Replay { .. }))
            );
        }
        let mut decoder = Decoder::new(0);
        decoder
            .push(&delta(json!({"content": "x"}), json!("stop")))
            .unwrap();
        decoder
            .push(&sse(
                json!({"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}),
            ))
            .unwrap();
        let events = decoder.push(&done()).unwrap();
        assert!(events.iter().any(|e| matches!(
            e,
            DriverEvent::Usage(usage) if usage.input_tokens == 7 && usage.output_tokens == 2
        )));
    }

    #[test]
    fn tool_calls_tolerate_missing_index_id_and_object_arguments() {
        let mut decoder = Decoder::new(0);
        decoder
            .push(&delta(
                json!({"tool_calls":[
                    {"id":"a","type":"function","function":{"name":"read","arguments":"{\"n\":"}},
                ]}),
                Value::Null,
            ))
            .unwrap();
        // No index and no id: the fragment continues the last call.
        decoder
            .push(&delta(
                json!({"tool_calls":[{"function":{"arguments":"1}"}}]}),
                Value::Null,
            ))
            .unwrap();
        // No index but a new id: another call.
        decoder
            .push(&delta(
                json!({"tool_calls":[{"id":"b","function":{"name":"list","arguments":{"all":true}}}]}),
                Value::Null,
            ))
            .unwrap();
        // Ollama's older servers finish tool calls with "stop".
        decoder.push(&delta(json!({}), json!("stop"))).unwrap();
        let events = decoder.push(&done()).unwrap();
        let calls: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                DriverEvent::ToolCall(call) => Some(call.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            (calls[0].id.as_str(), calls[0].name.as_str()),
            ("a", "read")
        );
        assert_eq!(calls[0].arguments, json!({"n":1}));
        assert_eq!(
            (calls[1].id.as_str(), calls[1].name.as_str()),
            ("b", "list")
        );
        assert_eq!(calls[1].arguments, json!({"all":true}));
        assert!(matches!(
            events.last(),
            Some(DriverEvent::Finish(FinishReason::Tools))
        ));
        let mut decoder = Decoder::new(0);
        decoder
            .push(&delta(
                json!({"tool_calls":[
                    {"index":0,"function":{"name":"read","arguments":""}},
                    {"index":1,"id":"b","function":{"name":"list","arguments":{"all":true}}},
                ]}),
                json!("tool_calls"),
            ))
            .unwrap();
        let events = decoder.push(&done()).unwrap();
        let calls: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                DriverEvent::ToolCall(call) => Some(call.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(calls[0].id, "call_0", "a missing id is made up, stably");
        assert_eq!(calls[0].arguments, json!({}));
        assert_eq!(calls[1].arguments, json!({"all":true}));
        assert!(matches!(
            events.last(),
            Some(DriverEvent::Finish(FinishReason::Tools))
        ));
    }

    #[test]
    fn truncation_errors_and_disconnects_fail_closed() {
        for (deltas, reason) in [
            (json!({"content":"cut"}), json!("length")),
            (json!({"content":"none"}), json!("tool_calls")),
            (
                json!({"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{"}}]}),
                json!("tool_calls"),
            ),
            (
                json!({"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"[]"}}]}),
                json!("tool_calls"),
            ),
            (
                json!({"tool_calls":[{"index":0,"id":"a","function":{"arguments":"{}"}}]}),
                json!("tool_calls"),
            ),
        ] {
            let mut decoder = Decoder::new(0);
            decoder.push(&delta(deltas, reason)).unwrap();
            assert!(decoder.push(&done()).is_err());
        }
        let mut decoder = Decoder::new(0);
        decoder
            .push(&delta(json!({"content":"no reason"}), Value::Null))
            .unwrap();
        assert!(decoder.push(&done()).is_err());
        assert!(Decoder::new(0).finish().is_err());
        assert!(
            Decoder::new(0)
                .push(&sse(json!({"error":{"message":"model not found"}})))
                .is_err()
        );
        let mut decoder = Decoder::new(0);
        decoder
            .push(&delta(json!({"content":"a"}), json!("stop")))
            .unwrap();
        assert!(
            decoder
                .push(&delta(json!({"content":"b"}), Value::Null))
                .is_err()
        );
    }

    fn base() -> DriverRequest {
        let mut config = RunConfig::new(Provider::Local, "qwen3:14b");
        config.route.local = Some(dr_agent::LocalRoute {
            server: "server".into(),
            base_url: "http://localhost:11434".into(),
        });
        config.system_prompt = "synthetic system".into();
        config.capabilities = Some(ModelCapabilities {
            context_window: Some(40_960),
            ..ModelCapabilities::default()
        });
        DriverRequest {
            purpose: RequestPurpose::Chat,
            config: Arc::new(config),
            session: "session".into(),
            turn: 1,
            round: 2,
            conversation: vec![
                ConversationEntry {
                    id: "session:1".into(),
                    session: "session".into(),
                    turn: 1,
                    kind: ConversationEntryKind::User,
                    payload: json!({"text":"synthetic request"}),
                },
                ConversationEntry {
                    id: "session:2".into(),
                    session: "session".into(),
                    turn: 1,
                    kind: ConversationEntryKind::Assistant,
                    payload: serde_json::to_value(AssistantMessage {
                        blocks: vec![
                            ContentBlock::Thinking {
                                index: 0,
                                text: "private plan".into(),
                                signature: None,
                                replay: None,
                            },
                            ContentBlock::ToolCall {
                                call: ToolCall {
                                    id: "call-1".into(),
                                    name: "read".into(),
                                    arguments: json!({}),
                                },
                            },
                        ],
                        complete: true,
                        ..AssistantMessage::default()
                    })
                    .unwrap(),
                },
                ConversationEntry {
                    id: "session:3".into(),
                    session: "session".into(),
                    turn: 1,
                    kind: ConversationEntryKind::ToolResult,
                    payload: json!({"call":"call-1","status":"success","output":{"n":1}}),
                },
            ],
            tools: vec![ToolDescriptor {
                name: "read".into(),
                revision: "v1".into(),
                description: "synthetic read".into(),
                input_schema: json!({"type":"object"}),
                access: ToolAccess::Read,
                policy: ToolPolicy::Local,
            }],
        }
    }

    #[test]
    fn request_has_no_deepseek_fields_and_no_unasked_output_limit() {
        let mut input = base();
        Arc::make_mut(&mut input.config).route.thinking = ThinkingLevel::High;
        let body = request(&input, true).unwrap();
        for absent in ["thinking", "reasoning_effort", "max_tokens", "tool_choice"] {
            assert!(body.get(absent).is_none(), "{absent}");
        }
        assert_eq!(body["model"], "qwen3:14b");
        assert_eq!(body["stream"], true);
        assert_eq!(body["tools"][0]["function"]["name"], "read");
        assert_eq!(body["messages"][0]["content"], "synthetic system");
        assert_eq!(body["messages"][2]["tool_calls"][0]["id"], "call-1");
        assert!(body["messages"][2]["content"].is_null());
        assert!(!body.to_string().contains("private plan"));
        assert_eq!(body["messages"][3]["role"], "tool");
        assert!(!body.to_string().contains("web_search"));
        Arc::make_mut(&mut input.config).max_output_tokens = Some(64);
        assert_eq!(request(&input, false).unwrap()["max_tokens"], 64);
    }
}
