//! Anthropic Messages wire adapter (M28). HTTP, retry leases, web-search
//! fallback and bounded pause continuations belong to the shared transport.
//! Replay items are complete assistant messages, one per streamed response;
//! signed thinking, encrypted results, citations and order remain intact.

use std::collections::{BTreeMap, HashMap, HashSet};

use dr_agent::{
    AssistantMessage, ContentBlock, DriverEvent, DriverRequest, FinishReason, Provider,
    ProviderReplay, ProviderTool, ProviderToolAction, ProviderToolStatus, ThinkingLevel, ToolCall,
    Usage,
};
use dr_model::conversation::ConversationEntryKind;
use serde_json::{Value, json};

use crate::{ProviderError, Result, SseEvent};

/// Messages requires an output limit. These are the old client's declared
/// maxima, including its documented 32k unknown-model fallback, rather than
/// an additional runtime cap. The catalog may fill the frozen config first.
fn output_maximum(model: &str) -> u32 {
    match model {
        "claude-sonnet-5-5" | "claude-opus-5-5" | "claude-fable-5-1" | "claude-haiku-5-5"
        | "claude-sonnet-5" => 128_000,
        "claude-haiku-4-5-20251001" => 64_000,
        _ => 32_000,
    }
}

fn always_thinks(model: &str) -> bool {
    matches!(
        model,
        "claude-sonnet-5-5" | "claude-opus-5-5" | "claude-fable-5-1" | "claude-haiku-5-5"
    )
}

/// Construct a Messages request using this run's frozen settings. Native
/// search stays after local tools, as in the old client; no third party tool.
pub fn request(input: &DriverRequest, search: bool) -> Result<Value> {
    let config = &input.config;
    if config.route.provider != Provider::Anthropic || config.route.model.trim().is_empty() {
        return Err(ProviderError::protocol("not an Anthropic route"));
    }
    let caps = config.capabilities.as_ref();
    let supports_off = caps
        .and_then(|c| c.supports_thinking_off)
        .unwrap_or(!always_thinks(&config.route.model));
    let enabled = config.route.thinking != ThinkingLevel::Off || !supports_off;
    let thinking = if enabled && config.route.thinking == ThinkingLevel::Off {
        caps.and_then(|c| {
            c.thinking_levels
                .iter()
                .find(|level| **level == ThinkingLevel::High)
                .or_else(|| {
                    c.thinking_levels
                        .iter()
                        .find(|level| **level != ThinkingLevel::Off)
                })
        })
        .copied()
        .unwrap_or(ThinkingLevel::High)
    } else {
        config.route.thinking
    };
    if enabled {
        let supported = caps
            .filter(|c| !c.thinking_levels.is_empty())
            .map(|c| c.thinking_levels.contains(&thinking))
            .unwrap_or_else(|| {
                (always_thinks(&config.route.model) || config.route.model == "claude-sonnet-5")
                    && matches!(
                        thinking,
                        ThinkingLevel::Low
                            | ThinkingLevel::Medium
                            | ThinkingLevel::High
                            | ThinkingLevel::Xhigh
                            | ThinkingLevel::Max
                    )
            });
        if !supported {
            return Err(ProviderError::from_status(
                400,
                "adaptive thinking effort unsupported",
            ));
        }
    }
    let declared_maximum = caps.and_then(|c| c.max_output_tokens).or_else(|| {
        (always_thinks(&config.route.model)
            || matches!(
                config.route.model.as_str(),
                "claude-sonnet-5" | "claude-haiku-4-5-20251001"
            ))
        .then(|| output_maximum(&config.route.model))
    });
    let maximum = config
        .max_output_tokens
        .or(declared_maximum)
        .unwrap_or(32_000);
    if maximum == 0 || declared_maximum.is_some_and(|declared| maximum > declared) {
        return Err(ProviderError::from_status(400, "unsupported output limit"));
    }
    let mut messages = Vec::<Value>::new();
    let last_user = input
        .conversation
        .iter()
        .rposition(|e| e.kind == ConversationEntryKind::User);
    for (position, entry) in input.conversation.iter().enumerate() {
        let active = entry.session == input.session
            && entry.turn == input.turn
            && last_user.is_none_or(|last| position > last);
        match entry.kind {
            ConversationEntryKind::User => {
                let text = string(&entry.payload, "text")?;
                messages.push(json!({"role":"user","content":[{"type":"text","text":text}]}));
            }
            ConversationEntryKind::Assistant => {
                let message: AssistantMessage = serde_json::from_value(entry.payload.clone())?;
                if let Some(replay) = &message.replay
                    && replay.provider == Provider::Anthropic
                    && active
                {
                    validate_replay(&message, &replay.items)?;
                    messages.extend(replay.items.clone());
                    continue;
                }
                if active
                    && enabled
                    && message
                        .blocks
                        .iter()
                        .any(|b| matches!(b, ContentBlock::ToolCall { .. }))
                {
                    return Err(ProviderError::protocol(
                        "active thinking tool loop lacks exact Anthropic replay",
                    ));
                }
                let mut content = Vec::new();
                for block in &message.blocks {
                    match block {
                        ContentBlock::Text { text, .. } if !text.is_empty() => content.push(json!({"type":"text","text":text})),
                        ContentBlock::ToolCall { call } => content.push(json!({"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments})),
                        ContentBlock::Thinking { text, signature, replay, .. } if active => {
                            // Only signed/provider-native reasoning can be
                            // replayed. Another provider's reasoning is not an
                            // Anthropic signature and never becomes one here.
                            if let Some(raw) = replay
                                && matches!(raw["type"].as_str(), Some("thinking" | "redacted_thinking")) {
                                validate_reasoning(raw)?;
                                content.push(raw.clone());
                            } else if let Some(signature) = signature {
                                if signature.trim().is_empty() { return Err(ProviderError::protocol("empty thinking signature")); }
                                content.push(json!({"type":"thinking","thinking":text,"signature":signature}));
                            }
                        }
                        _ => {}
                    }
                }
                if !content.is_empty() {
                    messages.push(json!({"role":"assistant","content":content}));
                }
            }
            ConversationEntryKind::ToolResult => {
                let call = nonblank(&entry.payload, "call")?;
                let output = entry
                    .payload
                    .get("output")
                    .ok_or_else(|| ProviderError::protocol("missing tool result"))?;
                let text = output
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| output.to_string());
                let result = json!({"type":"tool_result","tool_use_id":call,"content":text,"is_error":entry.payload["status"] != "success"});
                let previous = messages.last_mut().filter(|m| {
                    m["role"] == "user"
                        && m["content"]
                            .as_array()
                            .is_some_and(|blocks| blocks.iter().all(|b| b["type"] == "tool_result"))
                });
                if let Some(previous) = previous {
                    previous["content"]
                        .as_array_mut()
                        .expect("checked array")
                        .push(result);
                } else {
                    messages.push(json!({"role":"user","content":[result]}));
                }
            }
            ConversationEntryKind::ToolCall => {
                if active && enabled {
                    return Err(ProviderError::protocol(
                        "active thinking tool loop lacks exact Anthropic replay",
                    ));
                }
                let call: ToolCall = serde_json::from_value(entry.payload.clone())?;
                messages.push(json!({"role":"assistant","content":[{"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments}]}));
            }
            _ => {} // Standalone display thinking and future kinds have no wire authority.
        }
    }
    check_tool_closure(&messages)?;
    // A replayed assistant response must remain exact; cache the latest
    // ordinary user/tool message instead of editing signed content.
    if let Some(last) = messages.last_mut()
        && last["role"] == "user"
        && let Some(block) = last["content"].as_array_mut().and_then(|c| c.last_mut())
    {
        block["cache_control"] = json!({"type":"ephemeral"});
    }
    let mut body =
        json!({"model":config.route.model,"max_tokens":maximum,"stream":true,"messages":messages});
    if !config.system_prompt.is_empty() {
        body["system"] = json!([{"type":"text","text":config.system_prompt,"cache_control":{"type":"ephemeral"}}]);
    }
    if enabled {
        body["thinking"] = if caps.and_then(|c| c.supports_summary).unwrap_or(true) {
            json!({"type":"adaptive","display":"summarized"})
        } else {
            json!({"type":"adaptive"})
        };
    }
    if enabled || config.route.model == "claude-sonnet-5" {
        let effort = match thinking {
            ThinkingLevel::Minimal => "minimal",
            ThinkingLevel::Low => "low",
            ThinkingLevel::Medium => "medium",
            ThinkingLevel::Xhigh => "xhigh",
            ThinkingLevel::Max => "max",
            ThinkingLevel::Ultra => "ultra",
            _ => "high",
        };
        body["output_config"] = json!({"effort":effort});
    }
    if !input.tools.is_empty() {
        let mut tools: Vec<_> = input.tools.iter().map(|tool| json!({"name":tool.name,"description":tool.description,"input_schema":tool.input_schema})).collect();
        tools.last_mut().expect("nonempty tools")["cache_control"] = json!({"type":"ephemeral"});
        if search && config.web_search {
            tools.push(json!({"type":"web_search_20250305","name":"web_search","max_uses":5}));
        }
        body["tools"] = tools.into();
        body["tool_choice"] = json!({"type":"auto"});
    }
    Ok(body)
}

fn check_tool_closure(messages: &[Value]) -> Result<()> {
    let mut pending = HashSet::new();
    for message in messages {
        let content = message["content"]
            .as_array()
            .ok_or_else(|| ProviderError::protocol("invalid message content"))?;
        for block in content {
            match block["type"].as_str() {
                Some("tool_use") => {
                    let id = nonblank(block, "id")?;
                    if !pending.insert(id) {
                        return Err(ProviderError::protocol("duplicate outstanding tool call"));
                    }
                }
                Some("tool_result") => {
                    if !pending.remove(nonblank(block, "tool_use_id")?) {
                        return Err(ProviderError::protocol("orphan tool result"));
                    }
                }
                _ if message["role"] == "user" && !pending.is_empty() => {
                    return Err(ProviderError::protocol(
                        "missing tool result before author message",
                    ));
                }
                _ => {}
            }
        }
    }
    if !pending.is_empty() {
        return Err(ProviderError::protocol("unclosed tool calls"));
    }
    Ok(())
}

fn validate_replay(message: &AssistantMessage, items: &[Value]) -> Result<()> {
    if items.is_empty() {
        return Err(ProviderError::protocol("empty exact replay"));
    }
    let calls: HashMap<_, _> = message
        .blocks
        .iter()
        .filter_map(|b| {
            if let ContentBlock::ToolCall { call } = b {
                Some((call.id.as_str(), call))
            } else {
                None
            }
        })
        .collect();
    let mut replayed = HashSet::new();
    for item in items {
        if item["role"] != "assistant" {
            return Err(ProviderError::protocol("replay is not assistant content"));
        }
        let content = item["content"]
            .as_array()
            .ok_or_else(|| ProviderError::protocol("invalid exact replay"))?;
        for block in content {
            match nonblank(block, "type")? {
                "thinking" | "redacted_thinking" => validate_reasoning(block)?,
                "tool_use" => {
                    let id = nonblank(block, "id")?;
                    let call = calls.get(id).ok_or_else(|| {
                        ProviderError::protocol("replay tool absent from canonical message")
                    })?;
                    if !replayed.insert(id)
                        || block["name"] != call.name
                        || block["input"] != call.arguments
                    {
                        return Err(ProviderError::protocol(
                            "replay tool differs from canonical message",
                        ));
                    }
                }
                _ => {}
            }
        }
    }
    if replayed.len() != calls.len() {
        return Err(ProviderError::protocol("incomplete exact tool replay"));
    }
    Ok(())
}

fn validate_reasoning(block: &Value) -> Result<()> {
    match block["type"].as_str() {
        Some("thinking") => {
            string(block, "thinking")?;
            nonblank(block, "signature")?;
        }
        Some("redacted_thinking") => {
            nonblank(block, "data")?;
        }
        _ => return Err(ProviderError::protocol("invalid reasoning replay")),
    }
    Ok(())
}

struct Block {
    wire: Value,
    json: String,
    stopped: bool,
}

pub struct Decoder {
    offset: u32,
    started: bool,
    stopped: bool,
    reason: Option<String>,
    blocks: BTreeMap<u32, Block>,
    calls: HashSet<String>,
    searches: HashMap<String, (ProviderToolAction, Value)>,
    usage: Usage,
    output_seen: bool,
}

impl Decoder {
    pub fn new(index_offset: u32) -> Self {
        Self {
            offset: index_offset,
            started: false,
            stopped: false,
            reason: None,
            blocks: BTreeMap::new(),
            calls: HashSet::new(),
            searches: HashMap::new(),
            usage: Usage::default(),
            output_seen: false,
        }
    }

    /// First free canonical block index for a pause continuation.
    pub fn next_index(&self) -> u32 {
        self.offset.saturating_add(self.blocks.len() as u32)
    }

    pub fn push(&mut self, event: &SseEvent) -> Result<Vec<DriverEvent>> {
        let value: Value = serde_json::from_str(&event.data)?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .or(event.event.as_deref())
            .ok_or_else(|| ProviderError::protocol("missing event type"))?;
        if kind == "ping" {
            return Ok(Vec::new());
        }
        if kind == "error" {
            let status = match value["error"]["type"].as_str() {
                Some("authentication_error") => 401,
                Some("permission_error") => 403,
                Some("rate_limit_error") => 429,
                Some("billing_error") => 402,
                Some("invalid_request_error" | "not_found_error") => 400,
                _ => 500,
            };
            return Err(ProviderError::from_status(status, &event.data));
        }
        if self.stopped {
            return Err(ProviderError::protocol("event after message_stop"));
        }
        if kind == "message_start" {
            if self.started {
                return Err(ProviderError::protocol("duplicate message_start"));
            }
            let usage = object(&value["message"], "usage")?;
            self.usage.input_tokens = number(usage, "input_tokens")?;
            self.read_usage(usage)?;
            self.started = true;
            return Ok(Vec::new());
        }
        if !self.started {
            return Err(ProviderError::protocol("event before message_start"));
        }
        let mut out = Vec::new();
        match kind {
            "content_block_start" => {
                let index = block_index(&value)?;
                if index as usize != self.blocks.len() || self.offset.checked_add(index).is_none() {
                    return Err(ProviderError::protocol(
                        "duplicate or out-of-order block start",
                    ));
                }
                let mut wire = object(&value, "content_block")?.clone();
                let ty = nonblank(&wire, "type")?.to_owned();
                match ty.as_str() {
                    "text" => {
                        let text = optional_text(&wire, "text")?.to_owned();
                        wire["text"] = text.clone().into();
                        if !text.is_empty() {
                            out.push(DriverEvent::TextDelta {
                                index: self.offset + index,
                                text,
                            });
                        }
                        if wire
                            .get("citations")
                            .is_some_and(|c| !c.is_null() && !c.is_array())
                        {
                            return Err(ProviderError::protocol("invalid citations"));
                        }
                    }
                    "thinking" => {
                        let text = optional_text(&wire, "thinking")?.to_owned();
                        let signature = optional_text(&wire, "signature")?.to_owned();
                        wire["thinking"] = text.clone().into();
                        wire["signature"] = signature.into();
                        if !text.is_empty() {
                            out.push(DriverEvent::ThinkingDelta {
                                index: self.offset + index,
                                text,
                            });
                        }
                    }
                    "redacted_thinking" => {
                        validate_reasoning(&wire)?;
                    }
                    "tool_use" | "server_tool_use" => {
                        let id = nonblank(&wire, "id")?;
                        nonblank(&wire, "name")?;
                        if !self.calls.insert(id.to_owned()) {
                            return Err(ProviderError::protocol("duplicate tool id"));
                        }
                        if wire.get("input").is_none() {
                            wire["input"] = json!({});
                        }
                        object(&wire, "input")?;
                    }
                    "web_search_tool_result" | "web_fetch_tool_result" => {
                        nonblank(&wire, "tool_use_id")?;
                        if !wire["content"].is_object() && !wire["content"].is_array() {
                            return Err(ProviderError::protocol("invalid provider tool result"));
                        }
                    }
                    _ => {} // Complete unknown wire blocks are replayed intact.
                }
                self.blocks.insert(
                    index,
                    Block {
                        wire,
                        json: String::new(),
                        stopped: false,
                    },
                );
            }
            "content_block_delta" => {
                let index = block_index(&value)?;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .filter(|b| !b.stopped)
                    .ok_or_else(|| ProviderError::protocol("delta outside active block"))?;
                let delta = object(&value, "delta")?;
                let ty = string(delta, "type")?;
                match (block.wire["type"].as_str(), ty) {
                    (Some("text"), "text_delta") => {
                        let text = string(delta, "text")?;
                        append_string(&mut block.wire, "text", text)?;
                        if !text.is_empty() {
                            out.push(DriverEvent::TextDelta {
                                index: self.offset + index,
                                text: text.into(),
                            });
                        }
                    }
                    (Some("thinking"), "thinking_delta") => {
                        let text = string(delta, "thinking")?;
                        append_string(&mut block.wire, "thinking", text)?;
                        if !text.is_empty() {
                            out.push(DriverEvent::ThinkingDelta {
                                index: self.offset + index,
                                text: text.into(),
                            });
                        }
                    }
                    (Some("thinking"), "signature_delta") => {
                        append_string(&mut block.wire, "signature", string(delta, "signature")?)?;
                    }
                    (Some("tool_use" | "server_tool_use"), "input_json_delta") => {
                        if block.wire["input"]
                            .as_object()
                            .is_some_and(|i| !i.is_empty())
                        {
                            return Err(ProviderError::protocol(
                                "tool input has both complete data and JSON fragments",
                            ));
                        }
                        block.json.push_str(string(delta, "partial_json")?);
                    }
                    (Some("text"), "citations_delta") => {
                        let citation = object(delta, "citation")?.clone();
                        if block.wire["citations"].is_null() {
                            block.wire["citations"] = json!([]);
                        }
                        block.wire["citations"]
                            .as_array_mut()
                            .ok_or_else(|| ProviderError::protocol("invalid citation list"))?
                            .push(citation);
                    }
                    _ => return Err(ProviderError::protocol("unrecognized content delta")),
                }
            }
            "content_block_stop" => {
                let index = block_index(&value)?;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .filter(|b| !b.stopped)
                    .ok_or_else(|| ProviderError::protocol("stop outside active block"))?;
                if !block.json.is_empty() {
                    let input: Value = serde_json::from_str(&block.json)?;
                    if !input.is_object() {
                        return Err(ProviderError::protocol("tool input is not an object"));
                    }
                    block.wire["input"] = input;
                }
                match block.wire["type"].as_str() {
                    Some("tool_use") => out.push(DriverEvent::ToolCall(ToolCall {
                        id: nonblank(&block.wire, "id")?.into(),
                        name: nonblank(&block.wire, "name")?.into(),
                        arguments: block.wire["input"].clone(),
                    })),
                    Some("thinking" | "redacted_thinking") => {
                        validate_reasoning(&block.wire)?;
                        out.push(DriverEvent::ThinkingSignature {
                            index: self.offset + index,
                            signature: block.wire["signature"].as_str().map(str::to_owned),
                            replay: Some(block.wire.clone()),
                        });
                    }
                    Some("server_tool_use") => {
                        if let Some(action) = search_action(&block.wire) {
                            let id = nonblank(&block.wire, "id")?.to_owned();
                            self.searches
                                .insert(id.clone(), (action, block.wire["input"].clone()));
                            out.push(provider_tool(
                                id,
                                action,
                                ProviderToolStatus::Started,
                                &block.wire["input"],
                            ));
                        }
                    }
                    Some("web_search_tool_result" | "web_fetch_tool_result") => {
                        let id = nonblank(&block.wire, "tool_use_id")?.to_owned();
                        let action = if block.wire["type"] == "web_fetch_tool_result" {
                            ProviderToolAction::Open
                        } else {
                            ProviderToolAction::Search
                        };
                        let input = self
                            .searches
                            .get(&id)
                            .map(|(_, input)| input)
                            .unwrap_or(&Value::Null);
                        let status = if matches!(
                            block.wire["content"]["type"].as_str(),
                            Some("web_search_tool_result_error" | "web_fetch_tool_result_error")
                        ) {
                            ProviderToolStatus::Failed
                        } else {
                            ProviderToolStatus::Completed
                        };
                        out.push(provider_tool(id, action, status, input));
                    }
                    _ => {}
                }
                block.stopped = true;
            }
            "message_delta" => {
                let delta = object(&value, "delta")?;
                if let Some(reason) = delta["stop_reason"].as_str() {
                    if self.reason.is_some() {
                        return Err(ProviderError::protocol("duplicate stop reason"));
                    }
                    self.reason = Some(reason.into());
                }
                self.read_usage(object(&value, "usage")?)?;
            }
            "message_stop" => {
                if self.blocks.values().any(|b| !b.stopped)
                    || self.reason.is_none()
                    || !self.output_seen
                {
                    return Err(ProviderError::protocol(
                        "message stopped before completing blocks and usage",
                    ));
                }
                // Messages rejects whitespace-only text on replay. Keep exact
                // wire replay rather than silently deleting a signed response
                // block: the transport can resample before any buffered tool
                // call escapes this attempt.
                if self.blocks.values().any(|block| {
                    block.wire["type"] == "text"
                        && block.wire["text"]
                            .as_str()
                            .is_some_and(|text| text.trim().is_empty())
                }) {
                    return Err(ProviderError::protocol("empty replay text block"));
                }
                let reason = self.reason.as_deref().expect("checked reason");
                let client_calls = self
                    .blocks
                    .values()
                    .filter(|b| b.wire["type"] == "tool_use")
                    .count();
                match reason {
                    "pause_turn" if client_calls == 0 => {}
                    "tool_use" if client_calls > 0 => {}
                    "end_turn" | "stop_sequence" if client_calls == 0 => {}
                    _ => {
                        return Err(ProviderError::protocol(
                            "unsupported or incomplete stop reason",
                        ));
                    }
                }
                self.stopped = true;
                out.push(DriverEvent::Usage(self.usage));
                if reason != "pause_turn" {
                    out.push(DriverEvent::Replay {
                        replay: ProviderReplay {
                            provider: Provider::Anthropic,
                            items: vec![json!({"role":"assistant","content":self.content()})],
                            native_search: None,
                        },
                    });
                    out.push(DriverEvent::Finish(if reason == "tool_use" {
                        FinishReason::Tools
                    } else {
                        FinishReason::Complete
                    }));
                }
            }
            _ => {} // Ignorable protocol additions do not gain tool authority.
        }
        Ok(out)
    }

    fn read_usage(&mut self, value: &Value) -> Result<()> {
        // Match the old Messages driver: input_tokens is the provider's
        // uncached count; cache reads/writes remain separate counters.
        if value.get("input_tokens").is_some() {
            self.usage.input_tokens = number(value, "input_tokens")?;
        }
        if value.get("output_tokens").is_some() {
            self.usage.output_tokens = number(value, "output_tokens")?;
            self.output_seen = true;
        }
        if value.get("cache_read_input_tokens").is_some() {
            self.usage.cached_input_tokens = number(value, "cache_read_input_tokens")?;
        }
        if value.get("cache_creation_input_tokens").is_some() {
            self.usage.cache_write_tokens = number(value, "cache_creation_input_tokens")?;
        }
        Ok(())
    }

    fn content(&self) -> Vec<Value> {
        self.blocks.values().map(|b| b.wire.clone()).collect()
    }

    /// EOF validates the terminal marker. A pause returns content for the
    /// shared transport to append unchanged and resume (at most four times).
    pub fn finish(&self) -> Result<Option<Vec<Value>>> {
        if !self.stopped {
            return Err(ProviderError::protocol(
                "Anthropic stream ended before message_stop",
            ));
        }
        Ok((self.reason.as_deref() == Some("pause_turn")).then(|| self.content()))
    }
}

fn search_action(wire: &Value) -> Option<ProviderToolAction> {
    match wire["name"].as_str() {
        Some("web_search") => Some(ProviderToolAction::Search),
        Some("web_fetch") => Some(ProviderToolAction::Open),
        _ => None,
    }
}

fn provider_tool(
    id: String,
    action: ProviderToolAction,
    status: ProviderToolStatus,
    input: &Value,
) -> DriverEvent {
    DriverEvent::ProviderTool {
        activity: ProviderTool {
            id,
            action,
            status,
            query: input["query"].as_str().map(str::to_owned),
            url: input["url"].as_str().map(str::to_owned),
        },
    }
}

fn object<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    value
        .get(key)
        .filter(|v| v.is_object())
        .ok_or_else(|| ProviderError::protocol("missing object field"))
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::protocol("missing string field"))
}
fn nonblank<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let value = string(value, key)?;
    if value.trim().is_empty() {
        return Err(ProviderError::protocol("empty required string"));
    }
    Ok(value)
}
fn optional_text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    if value.get(key).is_none() {
        return Ok("");
    }
    string(value, key)
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ProviderError::protocol("invalid nonnegative usage"))
}
fn block_index(value: &Value) -> Result<u32> {
    u32::try_from(number(value, "index")?)
        .map_err(|_| ProviderError::protocol("block index overflow"))
}
fn append_string(value: &mut Value, key: &str, delta: &str) -> Result<()> {
    let mut text = string(value, key)?.to_owned();
    text.push_str(delta);
    value[key] = text.into();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_agent::{
        ModelCapabilities, ModelErrorCategory, RunConfig, ToolAccess, ToolDescriptor, ToolPolicy,
    };
    use dr_model::conversation::ConversationEntry;
    use std::sync::{Arc, OnceLock};

    fn text() -> String {
        static TEXT: OnceLock<String> = OnceLock::new();
        TEXT.get_or_init(|| {
            let seed = dr_testkit::seed::generate(
                dr_testkit::seed::Preset::Tiny,
                dr_testkit::seed::DEFAULT_SEED,
            )
            .unwrap();
            seed.books[0].prose[0]
                .view()
                .plain_text()
                .chars()
                .take(24)
                .collect()
        })
        .clone()
    }

    fn config() -> RunConfig {
        let mut config = RunConfig::new(Provider::Anthropic, "claude-sonnet-5");
        config.route.thinking = ThinkingLevel::High;
        config.system_prompt = text();
        config
    }

    fn entry(kind: ConversationEntryKind, payload: Value) -> ConversationEntry {
        ConversationEntry {
            id: "entry".into(),
            session: "run".into(),
            turn: 1,
            kind,
            payload,
        }
    }

    fn input() -> DriverRequest {
        DriverRequest {
            config: Arc::new(config()),
            session: "run".into(),
            turn: 1,
            round: 1,
            conversation: vec![entry(ConversationEntryKind::User, json!({"text":text()}))],
            tools: vec![ToolDescriptor {
                name: "query".into(),
                revision: "1".into(),
                description: text(),
                input_schema: json!({"type":"object"}),
                access: ToolAccess::Read,
                policy: ToolPolicy::Local,
            }],
        }
    }

    fn start() -> Value {
        json!({"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}})
    }
    fn block(index: u32, content: Value) -> Value {
        json!({"type":"content_block_start","index":index,"content_block":content})
    }
    fn delta(index: u32, delta: Value) -> Value {
        json!({"type":"content_block_delta","index":index,"delta":delta})
    }
    fn stop(index: u32) -> Value {
        json!({"type":"content_block_stop","index":index})
    }
    fn terminal(reason: &str) -> Vec<Value> {
        vec![
            json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":7}}),
            json!({"type":"message_stop"}),
        ]
    }
    fn push(decoder: &mut Decoder, value: Value) -> Result<Vec<DriverEvent>> {
        decoder.push(&SseEvent {
            event: Some(value["type"].as_str().unwrap().into()),
            data: value.to_string(),
        })
    }
    fn decode(values: Vec<Value>, offset: u32) -> (Decoder, Vec<DriverEvent>) {
        let mut decoder = Decoder::new(offset);
        let mut parser = crate::SseParser::default();
        let mut output = Vec::new();
        for value in values {
            let encoded = format!(
                "event: {}\r\ndata: {value}\r\n\r\n",
                value["type"].as_str().unwrap()
            );
            // Exercise UTF-8/SSE framing with every byte boundary as well as
            // fragmented tool JSON inside the already parsed provider data.
            for byte in encoded.as_bytes() {
                for event in parser.push(&[*byte]).unwrap() {
                    output.extend(decoder.push(&event).unwrap());
                }
            }
        }
        parser.finish().unwrap();
        (decoder, output)
    }

    #[test]
    fn request_uses_frozen_settings_native_search_and_old_model_maxima() {
        let mut request_input = input();
        let body = request(&request_input, true).unwrap();
        assert_eq!(body["max_tokens"], 128_000);
        assert_eq!(
            body["thinking"],
            json!({"type":"adaptive","display":"summarized"})
        );
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(
            body["tools"][1],
            json!({"type":"web_search_20250305","name":"web_search","max_uses":5})
        );
        assert_eq!(
            body["tools"][0]["cache_control"],
            json!({"type":"ephemeral"})
        );
        assert_eq!(body["messages"][0]["content"][0]["text"], text());
        assert_eq!(
            request(&request_input, false).unwrap()["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        Arc::make_mut(&mut request_input.config).web_search = false;
        assert_eq!(
            request(&request_input, true).unwrap()["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        Arc::make_mut(&mut request_input.config).max_output_tokens = Some(77);
        assert_eq!(request(&request_input, true).unwrap()["max_tokens"], 77);
        Arc::make_mut(&mut request_input.config).max_output_tokens = None;
        Arc::make_mut(&mut request_input.config).route.model = "unknown-listed-model".into();
        Arc::make_mut(&mut request_input.config).route.thinking = ThinkingLevel::Off;
        assert_eq!(request(&request_input, true).unwrap()["max_tokens"], 32_000);
        Arc::make_mut(&mut request_input.config).route.model = "claude-haiku-4-5-20251001".into();
        Arc::make_mut(&mut request_input.config).route.thinking = ThinkingLevel::High;
        assert!(request(&request_input, true).is_err());
        Arc::make_mut(&mut request_input.config).route.thinking = ThinkingLevel::Off;
        assert_eq!(request(&request_input, true).unwrap()["max_tokens"], 64_000);
        Arc::make_mut(&mut request_input.config).route.model = "claude-sonnet-5-5".into();
        assert_eq!(
            request(&request_input, true).unwrap()["thinking"]["type"],
            "adaptive"
        );
        request_input.tools.clear();
        assert!(
            request(&request_input, true)
                .unwrap()
                .get("tools")
                .is_none()
        );
    }

    #[test]
    fn frozen_capabilities_override_bundled_defaults_without_coercing_effort() {
        let mut request_input = input();
        let config = Arc::make_mut(&mut request_input.config);
        config.route.model = "discovered-model".into();
        config.route.thinking = ThinkingLevel::Ultra;
        config.capabilities = Some(ModelCapabilities {
            context_window: Some(300_000),
            max_output_tokens: Some(48_000),
            thinking_levels: vec![ThinkingLevel::Off, ThinkingLevel::Ultra],
            supports_thinking_off: Some(true),
            supports_summary: Some(false),
            supports_verbosity: None,
        });
        let body = request(&request_input, false).unwrap();
        assert_eq!(body["max_tokens"], 48_000);
        assert_eq!(body["thinking"], json!({"type":"adaptive"}));
        assert_eq!(body["output_config"]["effort"], "ultra");
        Arc::make_mut(&mut request_input.config).route.thinking = ThinkingLevel::High;
        assert!(request(&request_input, false).is_err());
        Arc::make_mut(&mut request_input.config).route.thinking = ThinkingLevel::Off;
        assert!(
            request(&request_input, false)
                .unwrap()
                .get("thinking")
                .is_none()
        );
        Arc::make_mut(&mut request_input.config).max_output_tokens = Some(48_001);
        assert!(request(&request_input, false).is_err());
        // The unknown-model fallback is not an invented provider maximum.
        Arc::make_mut(&mut request_input.config).capabilities = None;
        assert_eq!(
            request(&request_input, false).unwrap()["max_tokens"],
            48_001
        );
    }

    #[test]
    fn portable_standalone_calls_close_and_future_entry_kinds_have_no_wire_authority() {
        let mut request_input = input();
        Arc::make_mut(&mut request_input.config).route.thinking = ThinkingLevel::Off;
        for _ in 0..2 {
            request_input.conversation.push(entry(
                ConversationEntryKind::ToolCall,
                json!({"id":"run-local-id","name":"query","arguments":{}}),
            ));
            request_input.conversation.push(entry(
                ConversationEntryKind::ToolResult,
                json!({"call":"run-local-id","status":"success","output":text()}),
            ));
        }
        request_input.conversation.push(entry(
            ConversationEntryKind::Other("future-display-kind".into()),
            json!({"text":text()}),
        ));
        let body = request(&request_input, false).unwrap();
        assert_eq!(body["messages"].as_array().unwrap().len(), 5);
        request_input.conversation.remove(2);
        assert!(request(&request_input, false).is_err());
    }

    #[test]
    fn streaming_preserves_initial_data_signatures_citations_search_and_tool_order() {
        let args = json!({"query":text()});
        let serialized: Vec<char> = args.to_string().chars().collect();
        let middle = serialized.len() / 2;
        let first: String = serialized[..middle].iter().collect();
        let second: String = serialized[middle..].iter().collect();
        let thinking =
            json!({"type":"thinking","thinking":text(),"signature":"sig-a","extra":"opaque"});
        let redacted = json!({"type":"redacted_thinking","data":"encrypted-thinking"});
        let server =
            json!({"type":"server_tool_use","id":"search-1","name":"web_search","input":args});
        let result = json!({"type":"web_search_tool_result","tool_use_id":"search-1","content":[{"type":"web_search_result","url":"https://example.invalid/source","encrypted_content":"encrypted-result","title":text()}]});
        let citation = json!({"type":"web_search_result_location","encrypted_index":"encrypted-citation","url":"https://example.invalid/source","cited_text":text()});
        let mut values = vec![
            start(),
            block(0, thinking.clone()),
            delta(0, json!({"type":"thinking_delta","thinking":text()})),
            delta(0, json!({"type":"signature_delta","signature":"-b"})),
            stop(0),
            block(1, redacted.clone()),
            stop(1),
            block(2, server.clone()),
            stop(2),
            block(3, result.clone()),
            stop(3),
            block(
                4,
                json!({"type":"text","text":text(),"citations":null,"opaque":true}),
            ),
            delta(4, json!({"type":"text_delta","text":text()})),
            delta(4, json!({"type":"citations_delta","citation":citation})),
            stop(4),
            block(
                5,
                json!({"type":"tool_use","id":"call-1","name":"query","input":{}}),
            ),
            delta(5, json!({"type":"input_json_delta","partial_json":first})),
            delta(5, json!({"type":"input_json_delta","partial_json":second})),
            stop(5),
        ];
        values.extend(terminal("tool_use"));
        let (decoder, events) = decode(values, 9);
        assert!(decoder.finish().unwrap().is_none());
        assert_eq!(decoder.next_index(), 15);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, DriverEvent::ToolCall(call) if call.arguments==args))
        );
        assert!(events.iter().any(
            |event| matches!(event, DriverEvent::TextDelta{index:13,text: value} if value==&text())
        ));
        assert!(events.iter().any(|event| matches!(event, DriverEvent::ThinkingSignature{index:9,signature:Some(signature),..} if signature=="sig-a-b")));
        let activities: Vec<_> = events
            .iter()
            .filter_map(|e| {
                if let DriverEvent::ProviderTool { activity } = e {
                    Some(activity)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(activities.len(), 2);
        assert_eq!(activities[0].status, ProviderToolStatus::Started);
        assert_eq!(activities[1].status, ProviderToolStatus::Completed);
        assert_eq!(activities[1].query, Some(text()));
        let replay = events
            .iter()
            .find_map(|e| {
                if let DriverEvent::Replay { replay } = e {
                    Some(replay)
                } else {
                    None
                }
            })
            .unwrap();
        let expected = json!([
            {"type":"thinking","thinking":format!("{}{}",text(),text()),"signature":"sig-a-b","extra":"opaque"},
            redacted,server,result,
            {"type":"text","text":format!("{}{}",text(),text()),"citations":[citation],"opaque":true},
            {"type":"tool_use","id":"call-1","name":"query","input":args}
        ]);
        assert_eq!(
            replay.items,
            vec![json!({"role":"assistant","content":expected})]
        );
        assert!(events.iter().any(|e| matches!(e,DriverEvent::Usage(u) if u.input_tokens==10 && u.output_tokens==7 && u.cached_input_tokens==3 && u.cache_write_tokens==2)));
        assert!(matches!(
            events.last().unwrap(),
            DriverEvent::Finish(FinishReason::Tools)
        ));
    }

    #[test]
    fn active_exact_replay_keeps_pause_boundaries_but_prior_turns_are_portable() {
        let call = ToolCall {
            id: "call-1".into(),
            name: "query".into(),
            arguments: json!({"query":text()}),
        };
        let segments = vec![
            json!({"role":"assistant","content":[{"type":"redacted_thinking","data":"opaque"},{"type":"server_tool_use","id":"search-1","name":"web_search","input":{"query":text()}}]}),
            json!({"role":"assistant","content":[{"type":"text","text":text(),"citations":[{"encrypted_index":"opaque"}]},{"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments}]}),
        ];
        let message = AssistantMessage {
            blocks: vec![
                ContentBlock::Text {
                    index: 0,
                    text: text(),
                },
                ContentBlock::ToolCall { call: call.clone() },
            ],
            replay: Some(ProviderReplay {
                provider: Provider::Anthropic,
                items: segments.clone(),
                native_search: None,
            }),
            complete: true,
            ..Default::default()
        };
        let mut request_input = input();
        request_input.conversation.push(entry(
            ConversationEntryKind::Assistant,
            serde_json::to_value(&message).unwrap(),
        ));
        request_input.conversation.push(entry(
            ConversationEntryKind::ToolResult,
            json!({"call":call.id,"status":"success","output":{"count":0}}),
        ));
        let body = request(&request_input, true).unwrap();
        assert_eq!(
            &body["messages"].as_array().unwrap()[1..3],
            segments.as_slice()
        );
        assert_eq!(body["messages"][3]["content"][0]["tool_use_id"], "call-1");
        request_input.turn = 2;
        let portable = request(&request_input, true).unwrap();
        assert_eq!(
            portable["messages"][1]["content"].as_array().unwrap().len(),
            2
        );
        assert!(!portable.to_string().contains("encrypted_index"));
        assert!(!portable.to_string().contains("redacted_thinking"));
        request_input.turn = 1;
        request_input.conversation[1].payload["replay"] = Value::Null;
        assert!(request(&request_input, true).is_err());
    }

    #[test]
    fn paused_turn_returns_exact_content_without_completing_model_round() {
        let content = json!({"type":"server_tool_use","id":"search-1","name":"web_search","input":{"query":text()}});
        let mut values = vec![start(), block(0, content.clone()), stop(0)];
        values.extend(terminal("pause_turn"));
        let (decoder, events) = decode(values, 3);
        assert_eq!(decoder.finish().unwrap(), Some(vec![content]));
        assert_eq!(decoder.next_index(), 4);
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, DriverEvent::Finish(_) | DriverEvent::Replay { .. }))
        );
    }

    #[test]
    fn blank_text_with_a_tool_call_cannot_finalize_or_publish_exact_replay() {
        for blank in ["", " \t\r\n", "\u{2003}"] {
            let mut decoder = Decoder::new(0);
            let mut pending = Vec::new();
            for value in [
                start(),
                block(0, json!({"type":"text","text":blank})),
                stop(0),
                block(
                    1,
                    json!({"type":"tool_use","id":"call","name":"query","input":{}}),
                ),
                stop(1),
            ] {
                pending.extend(push(&mut decoder, value).unwrap());
            }
            let finish = terminal("tool_use");
            pending.extend(push(&mut decoder, finish[0].clone()).unwrap());
            let error = push(&mut decoder, finish[1].clone()).unwrap_err();
            assert!(error.retryable);
            assert!(decoder.finish().is_err());
            assert!(
                pending
                    .iter()
                    .any(|e| matches!(e, DriverEvent::ToolCall(_)))
            );
            assert!(
                !pending
                    .iter()
                    .any(|e| matches!(e, DriverEvent::Finish(_) | DriverEvent::Replay { .. }))
            );
        }
    }

    #[test]
    fn native_search_error_reports_failed_and_preserves_error_block_for_replay() {
        let server = json!({"type":"server_tool_use","id":"search","name":"web_search","input":{"query":text()}});
        let result = json!({"type":"web_search_tool_result","tool_use_id":"search","content":{"type":"web_search_tool_result_error","error_code":"too_many_requests"}});
        let mut values = vec![
            start(),
            block(0, server.clone()),
            stop(0),
            block(1, result.clone()),
            stop(1),
        ];
        values.extend(terminal("end_turn"));
        let (decoder, events) = decode(values, 0);
        assert!(decoder.finish().unwrap().is_none());
        assert!(events.iter().any(|e| matches!(e, DriverEvent::ProviderTool { activity } if activity.id == "search" && activity.status == ProviderToolStatus::Failed && activity.query == Some(text()))));
        assert!(!events.iter().any(|e| matches!(e, DriverEvent::ProviderTool { activity } if activity.status == ProviderToolStatus::Completed)));
        assert!(events.iter().any(|e| matches!(e, DriverEvent::Replay { replay } if replay.items[0]["content"] == json!([server,result]))));
    }

    #[test]
    fn truncated_unsigned_duplicate_or_invalid_streams_fail_closed() {
        let mut decoder = Decoder::new(0);
        push(&mut decoder, start()).unwrap();
        assert!(decoder.finish().is_err());
        push(
            &mut decoder,
            block(0, json!({"type":"thinking","thinking":text()})),
        )
        .unwrap();
        assert!(push(&mut decoder, stop(0)).is_err());
        let mut decoder = Decoder::new(0);
        push(&mut decoder, start()).unwrap();
        push(
            &mut decoder,
            block(
                0,
                json!({"type":"tool_use","id":"call","name":"query","input":{}}),
            ),
        )
        .unwrap();
        push(
            &mut decoder,
            delta(0, json!({"type":"input_json_delta","partial_json":"{"})),
        )
        .unwrap();
        assert!(push(&mut decoder, stop(0)).is_err());
        assert!(push(&mut decoder, block(0, json!({"type":"text","text":text()}))).is_err());
        let mut decoder = Decoder::new(0);
        push(&mut decoder, start()).unwrap();
        let limit = terminal("max_tokens");
        push(&mut decoder, limit[0].clone()).unwrap();
        assert!(push(&mut decoder, limit[1].clone()).is_err());
        let mut decoder = Decoder::new(0);
        assert!(push(&mut decoder, json!({"type":"message_stop"})).is_err());
    }

    #[test]
    fn complete_unknown_blocks_and_initial_tool_arguments_survive() {
        let unknown = json!({"type":"future_complete_block","opaque":{"keep":true}});
        let tool =
            json!({"type":"tool_use","id":"initial","name":"query","input":{"query":text()}});
        let mut values = vec![
            start(),
            block(0, unknown.clone()),
            stop(0),
            block(1, tool.clone()),
            stop(1),
        ];
        values.extend(terminal("tool_use"));
        let (_, events) = decode(values, 0);
        assert!(events.iter().any(|e| matches!(e,DriverEvent::Replay{replay} if replay.items[0]["content"]==json!([unknown,tool]))));
    }

    #[test]
    fn stream_errors_are_classified_without_retaining_provider_body() {
        for (kind, category, retryable) in [
            (
                "authentication_error",
                ModelErrorCategory::Authentication,
                false,
            ),
            ("rate_limit_error", ModelErrorCategory::Quota, true),
            ("overloaded_error", ModelErrorCategory::Network, true),
        ] {
            let error=push(&mut Decoder::new(0),json!({"type":"error","error":{"type":kind,"message":"synthetic-private-provider-body"}})).unwrap_err();
            assert_eq!(error.category, category);
            assert_eq!(error.retryable, retryable);
            assert!(
                !error
                    .to_string()
                    .contains("synthetic-private-provider-body")
            );
        }
    }
}
