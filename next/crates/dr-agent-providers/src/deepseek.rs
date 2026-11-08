//! DeepSeek Chat Completions: pure wire projection and incremental decoding.
//! The transport owns credentials, retries, cancellation and SSE framing.

use std::collections::{BTreeMap, BTreeSet};

use dr_agent::{
    AssistantMessage, ContentBlock, DriverEvent, DriverRequest, FinishReason, Provider,
    ProviderReplay, ThinkingLevel, ToolCall, Usage,
};
use dr_model::conversation::ConversationEntryKind;
use serde_json::{Value, json};

use crate::{ProviderError, Result, SseEvent};

/// The requested search flag is deliberately ignored: DeepSeek has no hosted
/// web-search tool in this contract.
pub fn request(request: &DriverRequest, _search: bool) -> Result<Value> {
    let config = &request.config;
    let fallback = crate::catalog::profile(Provider::Deepseek, &config.route.model);
    let caps = config.capabilities.as_ref();
    let supports_off = caps
        .and_then(|c| c.supports_thinking_off)
        .or_else(|| {
            fallback
                .as_ref()
                .map(|p| p.thinking_modes.iter().any(|m| m == "off"))
        })
        .unwrap_or(true);
    let thinking = config.route.thinking != ThinkingLevel::Off || !supports_off;
    let maximum = caps
        .and_then(|c| c.max_output_tokens)
        .map(u64::from)
        .or_else(|| fallback.as_ref().and_then(|p| p.max_output_tokens));
    if config
        .max_output_tokens
        .is_some_and(|n| maximum.is_some_and(|max| u64::from(n) > max))
    {
        return Err(ProviderError::from_status(400, "unsupported output limit"));
    }
    let mut messages = vec![json!({"role": "system", "content": config.system_prompt})];
    let last_user = request
        .conversation
        .iter()
        .rposition(|e| e.kind == ConversationEntryKind::User);
    for (position, entry) in request.conversation.iter().enumerate() {
        let active = entry.session == request.session
            && entry.turn == request.turn
            && last_user.is_none_or(|i| position > i);
        match entry.kind {
            ConversationEntryKind::User => messages.push(json!({
                "role": "user", "content": string(&entry.payload, "text")?,
            })),
            ConversationEntryKind::Assistant => {
                let message: AssistantMessage = serde_json::from_value(entry.payload.clone())
                    .map_err(|_| {
                        ProviderError::protocol("invalid assistant conversation record")
                    })?;
                if let Some(replay) = &message.replay
                    && replay.provider == Provider::Deepseek
                    && active
                {
                    if replay.items.is_empty()
                        || replay.items.iter().any(|m| m["role"] != "assistant")
                    {
                        return Err(ProviderError::protocol("invalid DeepSeek assistant replay"));
                    }
                    if thinking
                        && replay.items.iter().any(|m| {
                            m.get("tool_calls")
                                .and_then(Value::as_array)
                                .is_some_and(|c| !c.is_empty())
                                && m.get("reasoning_content")
                                    .and_then(Value::as_str)
                                    .is_none_or(str::is_empty)
                        })
                    {
                        return Err(ProviderError::protocol(
                            "DeepSeek thinking tool replay is missing reasoning_content",
                        ));
                    }
                    messages.extend(replay.items.clone());
                    continue;
                }
                let mut content = String::new();
                let mut calls = Vec::new();
                for block in message.blocks {
                    match block {
                        ContentBlock::Text { text, .. } => content.push_str(&text),
                        ContentBlock::ToolCall { call } => calls.push(wire_call(&call)),
                        ContentBlock::Thinking { .. } => {}
                    }
                }
                if thinking && !calls.is_empty() && active {
                    return Err(ProviderError::protocol(
                        "DeepSeek thinking tool replay is missing",
                    ));
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
                if thinking && active {
                    return Err(ProviderError::protocol(
                        "DeepSeek thinking tool replay is missing",
                    ));
                }
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
        "thinking": {"type": if thinking { "enabled" } else { "disabled" }},
    });
    if thinking {
        let effort = wire_effort(config.route.thinking);
        let supported = caps
            .filter(|c| !c.thinking_levels.is_empty())
            .map(|c| {
                c.thinking_levels
                    .iter()
                    .any(|level| *level != ThinkingLevel::Off && wire_effort(*level) == effort)
            })
            .or_else(|| {
                fallback
                    .as_ref()
                    .map(|p| p.efforts.iter().any(|supported| supported == effort))
            })
            .unwrap_or(true);
        if !supported {
            return Err(ProviderError::from_status(
                400,
                "unsupported thinking effort",
            ));
        }
        body["reasoning_effort"] = effort.into();
    }
    if let Some(max) = config.max_output_tokens {
        body["max_tokens"] = max.into();
    }
    if !request.tools.is_empty() {
        body["tools"] = request.tools.iter().map(|tool| json!({
            "type":"function", "function": {"name":tool.name,"description":tool.description,"parameters":tool.input_schema},
        })).collect::<Vec<_>>().into();
        // Thinking mode rejects tool_choice; the model chooses itself.
        if !thinking {
            body["tool_choice"] = "auto".into();
        }
    }
    Ok(body)
}

fn wire_effort(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Minimal | ThinkingLevel::Low => "low",
        ThinkingLevel::Max | ThinkingLevel::Xhigh | ThinkingLevel::Ultra => "max",
        _ => "high",
    }
}

fn wire_call(call: &ToolCall) -> Value {
    json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}})
}

fn tool_result(payload: &Value) -> Result<String> {
    let output = payload
        .get("output")
        .ok_or_else(|| ProviderError::protocol("tool result has no output"))?;
    let content = output
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| output.to_string());
    Ok(if payload["status"] == "success" {
        content
    } else {
        format!("Tool failed: {content}")
    })
}

fn check_tool_closure(messages: &[Value]) -> Result<()> {
    let mut pending = BTreeSet::new();
    for item in messages {
        if let Some(calls) = item.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let id = nonblank(call, "id")?;
                if !pending.insert(id.to_owned()) {
                    return Err(ProviderError::protocol(
                        "duplicate tool call in conversation",
                    ));
                }
            }
        }
        if item["role"] == "tool" && !pending.remove(nonblank(item, "tool_call_id")?) {
            return Err(ProviderError::protocol("tool output has no preceding call"));
        }
    }
    if !pending.is_empty() {
        return Err(ProviderError::protocol(
            "conversation has unfinished tool calls",
        ));
    }
    Ok(())
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}

pub struct Decoder {
    index_offset: u32,
    text: String,
    reasoning: String,
    calls: BTreeMap<u32, Call>,
    usage: Option<Usage>,
    reason: Option<String>,
    terminal: bool,
    require_reasoning: bool,
}

impl Decoder {
    #[cfg(test)]
    pub fn new(index_offset: u32) -> Self {
        Self::with_thinking(index_offset, false)
    }

    pub fn with_thinking(index_offset: u32, require_reasoning: bool) -> Self {
        Self {
            index_offset,
            text: String::new(),
            reasoning: String::new(),
            calls: BTreeMap::new(),
            usage: None,
            reason: None,
            terminal: false,
            require_reasoning,
        }
    }

    pub fn push(&mut self, event: &SseEvent) -> Result<Vec<DriverEvent>> {
        if self.terminal {
            return Err(ProviderError::protocol(
                "DeepSeek event after stream completion",
            ));
        }
        if event.data.trim() == "[DONE]" {
            return self.complete();
        }
        let chunk: Value = serde_json::from_str(&event.data)
            .map_err(|_| ProviderError::protocol("DeepSeek stream contains invalid JSON"))?;
        if !chunk.is_object() {
            return Err(ProviderError::protocol(
                "DeepSeek stream event is not an object",
            ));
        }
        if chunk.get("error").is_some() {
            return Err(stream_error(&chunk));
        }
        if let Some(usage) = chunk.get("usage").filter(|v| !v.is_null()) {
            if self.usage.is_some() {
                return Err(ProviderError::protocol("DeepSeek repeated terminal usage"));
            }
            self.usage = Some(parse_usage(usage)?);
        }
        let choices = chunk
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::protocol("DeepSeek event has no choices"))?;
        if choices.is_empty() {
            return Ok(Vec::new());
        }
        if choices.len() != 1
            || choices[0]
                .get("index")
                .map(|_| number(&choices[0], "index"))
                .transpose()?
                .unwrap_or(0)
                != 0
        {
            return Err(ProviderError::protocol(
                "DeepSeek returned multiple choices",
            ));
        }
        if self.reason.is_some() {
            return Err(ProviderError::protocol(
                "DeepSeek content after finish reason",
            ));
        }
        let choice = &choices[0];
        let delta = choice
            .get("delta")
            .filter(|v| v.is_object())
            .ok_or_else(|| ProviderError::protocol("DeepSeek choice has no delta"))?;
        let mut events = Vec::new();
        if let Some(text) = optional_string(delta, "content")? {
            self.text.push_str(text);
            if !text.is_empty() {
                events.push(DriverEvent::TextDelta {
                    index: self
                        .index_offset
                        .checked_add(1)
                        .ok_or_else(|| ProviderError::protocol("content index overflow"))?,
                    text: text.into(),
                });
            }
        }
        if let Some(text) = optional_string(delta, "reasoning_content")? {
            self.reasoning.push_str(text);
            if !text.is_empty() {
                events.push(DriverEvent::ThinkingDelta {
                    index: self.index_offset,
                    text: text.into(),
                });
            }
        }
        if let Some(calls) = delta.get("tool_calls").filter(|v| !v.is_null()) {
            let calls = calls
                .as_array()
                .ok_or_else(|| ProviderError::protocol("DeepSeek invalid tool delta"))?;
            for part in calls {
                let index = number(part, "index")?
                    .try_into()
                    .map_err(|_| ProviderError::protocol("tool index overflow"))?;
                let call = self.calls.entry(index).or_default();
                if let Some(id) = optional_string(part, "id")? {
                    if id.is_empty() || (!call.id.is_empty() && call.id != id) {
                        return Err(ProviderError::protocol("DeepSeek tool identity changed"));
                    }
                    call.id = id.into();
                }
                if let Some(kind) = optional_string(part, "type")?
                    && kind != "function"
                {
                    return Err(ProviderError::protocol("unsupported DeepSeek tool type"));
                }
                if let Some(function) = part.get("function") {
                    if !function.is_object() {
                        return Err(ProviderError::protocol("DeepSeek invalid function delta"));
                    }
                    if let Some(name) = optional_string(function, "name")? {
                        call.name.push_str(name);
                    }
                    if let Some(arguments) = optional_string(function, "arguments")? {
                        call.arguments.push_str(arguments);
                    }
                }
            }
        }
        if let Some(reason) = optional_string(choice, "finish_reason")? {
            if reason.is_empty() {
                return Err(ProviderError::protocol("DeepSeek empty finish reason"));
            }
            self.reason = Some(reason.into());
        }
        Ok(events)
    }

    fn complete(&mut self) -> Result<Vec<DriverEvent>> {
        let reason = self.reason.as_deref().ok_or_else(|| {
            ProviderError::protocol("DeepSeek stream ended without finish reason")
        })?;
        let usage = self
            .usage
            .ok_or_else(|| ProviderError::protocol("DeepSeek stream ended without usage"))?;
        let has_tools = !self.calls.is_empty();
        if self.require_reasoning && has_tools && self.reasoning.is_empty() {
            return Err(ProviderError::protocol(
                "DeepSeek thinking tool response has no reasoning_content",
            ));
        }
        if !matches!((reason, has_tools), ("stop", false) | ("tool_calls", true)) {
            return Err(ProviderError::protocol(
                "DeepSeek response was truncated or has inconsistent tool completion",
            ));
        }
        let mut calls = Vec::new();
        let mut ids = BTreeSet::new();
        for (position, (index, call)) in self.calls.iter().enumerate() {
            if *index as usize != position
                || call.id.trim().is_empty()
                || call.name.trim().is_empty()
                || !ids.insert(&call.id)
            {
                return Err(ProviderError::protocol(
                    "DeepSeek incomplete or duplicate tool identity",
                ));
            }
            let arguments: Value = serde_json::from_str(&call.arguments).map_err(|_| {
                ProviderError::protocol("DeepSeek tool arguments are not valid JSON")
            })?;
            if !arguments.is_object() {
                return Err(ProviderError::protocol(
                    "DeepSeek tool arguments must be an object",
                ));
            }
            calls.push(ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments,
            });
        }
        let mut wire = json!({"role":"assistant","content":self.text});
        if self.text.is_empty() && has_tools {
            wire["content"] = Value::Null;
        }
        if !self.reasoning.is_empty() {
            wire["reasoning_content"] = self.reasoning.clone().into();
        }
        if has_tools {
            wire["tool_calls"] = self.calls.values().map(|call| json!({
                "id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments},
            })).collect::<Vec<_>>().into();
        }
        let mut events: Vec<_> = calls.into_iter().map(DriverEvent::ToolCall).collect();
        events.push(DriverEvent::Usage(usage));
        events.push(DriverEvent::Replay {
            replay: ProviderReplay {
                provider: Provider::Deepseek,
                native_search: None,
                items: vec![wire],
            },
        });
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
            Err(ProviderError::protocol(
                "DeepSeek stream disconnected before [DONE]",
            ))
        }
    }
}

fn parse_usage(value: &Value) -> Result<Usage> {
    Ok(Usage {
        input_tokens: number(value, "prompt_tokens")?,
        output_tokens: number(value, "completion_tokens")?,
        cached_input_tokens: optional_number(value, "prompt_cache_hit_tokens")?,
        cache_write_tokens: 0,
        reasoning_tokens: value
            .get("completion_tokens_details")
            .filter(|v| !v.is_null())
            .map(|v| optional_number(v, "reasoning_tokens"))
            .transpose()?
            .unwrap_or(0),
    })
}

fn number(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ProviderError::protocol(format!("invalid {key}")))
}
fn optional_number(value: &Value, key: &str) -> Result<u64> {
    match value.get(key) {
        None => Ok(0),
        Some(_) => number(value, key),
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::protocol(format!("invalid {key}")))
}
fn nonblank<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let text = string(value, key)?;
    if text.trim().is_empty() {
        Err(ProviderError::protocol(format!("empty {key}")))
    } else {
        Ok(text)
    }
}
fn optional_string<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => string(value, key).map(Some),
    }
}
fn stream_error(value: &Value) -> ProviderError {
    let error = &value["error"];
    let code = error["code"].as_str().unwrap_or_default();
    let status = error["status"]
        .as_u64()
        .and_then(|s| s.try_into().ok())
        .unwrap_or(match code {
            "invalid_api_key" | "authentication_error" => 401,
            "rate_limit_exceeded" | "insufficient_quota" => 429,
            "model_not_found" => 404,
            _ => 502,
        });
    ProviderError::from_status(status, &value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(value: Value) -> SseEvent {
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
    fn chunk(delta: Value, reason: Value) -> SseEvent {
        event(json!({"choices":[{"index":0,"delta":delta,"finish_reason":reason}]}))
    }
    fn usage() -> SseEvent {
        event(
            json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"prompt_cache_hit_tokens":2}}),
        )
    }

    #[test]
    fn text_reasoning_parallel_fragmented_tools_and_exact_replay() {
        let mut decoder = Decoder::new(20);
        let events = decoder
            .push(&chunk(
                json!({"reasoning_content":"think", "content":"text"}),
                Value::Null,
            ))
            .unwrap();
        assert!(matches!(&events[0], DriverEvent::TextDelta { index:21, text } if text == "text"));
        assert!(
            matches!(&events[1], DriverEvent::ThinkingDelta { index:20, text } if text == "think")
        );
        decoder.push(&chunk(json!({"tool_calls":[
            {"index":0,"id":"call-a","type":"function","function":{"name":"read_","arguments":"{\"n\":"}},
            {"index":1,"id":"call-b","type":"function","function":{"name":"list","arguments":"{}"}}
        ]}), Value::Null)).unwrap();
        decoder
            .push(&chunk(
                json!({"tool_calls":[{"index":0,"function":{"name":"chapter","arguments":"1}"}}]}),
                json!("tool_calls"),
            ))
            .unwrap();
        decoder.push(&usage()).unwrap();
        let complete = decoder.push(&done()).unwrap();
        assert!(
            matches!(&complete[0], DriverEvent::ToolCall(call) if call.name == "read_chapter" && call.arguments == json!({"n":1}))
        );
        let replay = complete
            .iter()
            .find_map(|e| {
                if let DriverEvent::Replay { replay } = e {
                    Some(replay)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(replay.items[0]["reasoning_content"], "think");
        assert_eq!(
            replay.items[0]["tool_calls"][0]["function"]["arguments"],
            "{\"n\":1}"
        );
        assert_eq!(replay.items[0]["tool_calls"][1]["id"], "call-b");
        assert!(matches!(
            complete.last(),
            Some(DriverEvent::Finish(FinishReason::Tools))
        ));
        assert!(decoder.finish().unwrap().is_none());
    }

    #[test]
    fn normal_terminal_requires_usage_and_finish_reason() {
        let mut decoder = Decoder::new(0);
        decoder
            .push(&chunk(json!({"content":"text"}), json!("stop")))
            .unwrap();
        assert!(decoder.finish().is_err());
        assert!(decoder.push(&done()).is_err());
        decoder.push(&usage()).unwrap();
        assert!(matches!(
            decoder.push(&done()).unwrap().last(),
            Some(DriverEvent::Finish(FinishReason::Complete))
        ));
        assert!(decoder.push(&chunk(json!({}), Value::Null)).is_err());
    }

    #[test]
    fn malformed_arguments_truncation_error_and_disconnect_fail_before_tools() {
        for (arguments, reason) in [("{", "tool_calls"), ("[]", "tool_calls"), ("{}", "length")] {
            let mut decoder = Decoder::new(0);
            decoder.push(&chunk(json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":arguments}}]}), json!(reason))).unwrap();
            decoder.push(&usage()).unwrap();
            assert!(decoder.push(&done()).is_err());
        }
        assert!(
            Decoder::new(0)
                .push(&event(json!({"error":{"code":"insufficient_quota"}})))
                .is_err()
        );
        assert!(Decoder::new(0).finish().is_err());
    }
}

#[cfg(test)]
mod request_tests {
    use super::*;
    use dr_agent::{ModelCapabilities, RunConfig, ToolAccess, ToolDescriptor, ToolPolicy};
    use dr_model::conversation::ConversationEntry;
    use std::sync::Arc;

    fn base() -> DriverRequest {
        let mut config = RunConfig::new(Provider::Deepseek, "deepseek-flash");
        config.system_prompt = "synthetic system".into();
        config.route.thinking = ThinkingLevel::Medium;
        DriverRequest {
            config: Arc::new(config),
            session: "session-1".into(),
            turn: 1,
            round: 2,
            conversation: vec![ConversationEntry {
                id: "session-1:1".into(),
                session: "session-1".into(),
                turn: 1,
                kind: ConversationEntryKind::User,
                payload: json!({"text":"synthetic request"}),
            }],
            tools: vec![ToolDescriptor {
                name: "read".into(),
                revision: "v1".into(),
                description: "synthetic read".into(),
                input_schema: json!({"type":"object","properties":{"optional":{"type":"string"}}}),
                access: ToolAccess::Read,
                policy: ToolPolicy::Local,
            }],
        }
    }
    fn add_round(request: &mut DriverRequest, replay: bool) {
        let call = ToolCall {
            id: "call-1".into(),
            name: "read".into(),
            arguments: json!({}),
        };
        let mut wire = wire_call(&call);
        wire["function"]["arguments"] = "{ }".into();
        let message=AssistantMessage {
            blocks:vec![ContentBlock::ToolCall{call}],complete:true,
            replay:replay.then(||ProviderReplay{provider:Provider::Deepseek,native_search:None,items:vec![json!({"role":"assistant","content":null,"reasoning_content":"synthetic reasoning","tool_calls":[wire]})]}),
            ..AssistantMessage::default()
        };
        request.conversation.push(ConversationEntry {
            id: "session-1:2".into(),
            session: "session-1".into(),
            turn: 1,
            kind: ConversationEntryKind::Assistant,
            payload: serde_json::to_value(message).unwrap(),
        });
        request.conversation.push(ConversationEntry {
            id: "session-1:3".into(),
            session: "session-1".into(),
            turn: 1,
            kind: ConversationEntryKind::ToolResult,
            payload: json!({"call":"call-1","status":"success","output":{"n":1}}),
        });
    }

    #[test]
    fn request_replays_reasoning_only_in_active_segment_and_never_offers_search() {
        let mut input = base();
        add_round(&mut input, true);
        let body = request(&input, true).unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "high");
        assert!(body.get("tool_choice").is_none());
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["messages"][2]["reasoning_content"],
            "synthetic reasoning"
        );
        assert_eq!(
            body["messages"][2]["tool_calls"][0]["function"]["arguments"],
            "{ }"
        );
        input.conversation[1].turn = 0;
        let old = request(&input, true).unwrap();
        assert!(old["messages"][2].get("reasoning_content").is_none());
        input.conversation[1].turn = 1;
        input.conversation.push(ConversationEntry {
            id: "session-1:4".into(),
            session: "session-1".into(),
            turn: 1,
            kind: ConversationEntryKind::User,
            payload: json!({"text":"steering"}),
        });
        assert!(
            request(&input, true).unwrap()["messages"][2]
                .get("reasoning_content")
                .is_none()
        );
    }

    #[test]
    fn missing_active_reasoning_and_advertised_limit_fail_closed() {
        let mut input = base();
        add_round(&mut input, false);
        assert!(request(&input, false).is_err());
        let mut input = base();
        let config = Arc::make_mut(&mut input.config);
        config.max_output_tokens = Some(17);
        config.capabilities = Some(ModelCapabilities {
            max_output_tokens: Some(16),
            ..ModelCapabilities::default()
        });
        assert_eq!(
            request(&input, false).unwrap_err().category,
            dr_agent::ModelErrorCategory::Unsupported
        );
        Arc::make_mut(&mut input.config).max_output_tokens = Some(16);
        assert_eq!(request(&input, false).unwrap()["max_tokens"], 16);
    }

    #[test]
    fn thinking_tool_response_requires_reasoning_before_tool_event() {
        let mut decoder = Decoder::with_thinking(0, true);
        decoder.push(&SseEvent{event:None,data:json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string()}).unwrap();
        assert!(
            decoder
                .push(&SseEvent {
                    event: None,
                    data: "[DONE]".into()
                })
                .is_err()
        );
    }
}
