//! The Responses protocol shared by the OpenAI API and ChatGPT subscription.
//! Raw ordered output is replayed only inside the same active reasoning turn.

use std::collections::{BTreeMap, BTreeSet};

use dr_agent::{
    AssistantMessage, ContentBlock, DriverEvent, DriverRequest, FinishReason, Provider,
    ProviderReplay, ProviderTool, ProviderToolAction, ProviderToolStatus, ThinkingLevel, ToolCall,
    Usage,
};
use dr_model::conversation::ConversationEntryKind;
use serde_json::{Value, json};

use crate::{ProviderError, Result, SseEvent};

pub fn request(request: &DriverRequest, search: bool) -> Result<Value> {
    let config = &request.config;
    let fallback = crate::catalog::profile(config.route.provider, &config.route.model);
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
    let effort = if config.route.thinking == ThinkingLevel::Off && thinking {
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
        .as_str()
    } else if thinking {
        config.route.thinking.as_str()
    } else {
        "none"
    };
    let supported = caps
        .filter(|c| !c.thinking_levels.is_empty())
        .map(|c| {
            c.thinking_levels
                .iter()
                .any(|level| level.as_str() == effort)
        })
        .or_else(|| {
            fallback
                .as_ref()
                .map(|p| p.efforts.iter().any(|supported| supported == effort))
        })
        .unwrap_or(true);
    if thinking && !supported {
        return Err(ProviderError::from_status(
            400,
            "unsupported thinking effort",
        ));
    }
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
    let summary = caps
        .and_then(|c| c.supports_summary)
        .or_else(|| fallback.as_ref().map(|p| p.supports_summary))
        .unwrap_or(true);
    let verbosity = caps
        .and_then(|c| c.supports_verbosity)
        .or_else(|| fallback.as_ref().map(|p| p.supports_verbosity))
        .unwrap_or(true);
    let subscription = config.route.provider == Provider::Chatgpt;
    let last_user = request
        .conversation
        .iter()
        .rposition(|e| e.kind == ConversationEntryKind::User);
    let mut input = Vec::new();
    for (position, entry) in request.conversation.iter().enumerate() {
        let active = entry.session == request.session
            && entry.turn == request.turn
            && last_user.is_none_or(|i| position > i);
        match entry.kind {
            ConversationEntryKind::User => {
                input.push(json!({"role":"user","content":string(&entry.payload,"text")?}))
            }
            ConversationEntryKind::ToolResult => {
                let output = entry
                    .payload
                    .get("output")
                    .ok_or_else(|| ProviderError::protocol("tool result has no output"))?;
                let content = output
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| output.to_string());
                input.push(json!({"type":"function_call_output", "call_id":nonblank(&entry.payload,"call")?,
                    "output": if entry.payload["status"] == "success" { content } else { format!("Tool failed: {content}") }}));
            }
            ConversationEntryKind::Assistant => {
                let message: AssistantMessage = serde_json::from_value(entry.payload.clone())
                    .map_err(|_| {
                        ProviderError::protocol("invalid assistant conversation record")
                    })?;
                if let Some(replay) = &message.replay
                    && replay.provider == config.route.provider
                    && active
                {
                    if replay.items.is_empty() || replay.items.iter().any(|v| !v.is_object()) {
                        return Err(ProviderError::protocol("invalid Responses replay"));
                    }
                    input.extend(replay.items.clone());
                    continue;
                }
                let mut text = String::new();
                let mut calls = Vec::new();
                for block in message.blocks {
                    match block {
                        ContentBlock::Text { text: part, .. } => text.push_str(&part),
                        ContentBlock::ToolCall { call } => calls.push(wire_call(&call)),
                        ContentBlock::Thinking { .. } => {}
                    }
                }
                if thinking && active && !calls.is_empty() {
                    return Err(ProviderError::protocol(
                        "Responses thinking tool replay is missing",
                    ));
                }
                if !text.is_empty() {
                    input.push(json!({"role":"assistant","content":text}));
                }
                input.extend(calls);
            }
            ConversationEntryKind::ToolCall => {
                let call: ToolCall = serde_json::from_value(entry.payload.clone())
                    .map_err(|_| ProviderError::protocol("invalid tool conversation record"))?;
                if thinking && active {
                    return Err(ProviderError::protocol(
                        "Responses thinking tool replay is missing",
                    ));
                }
                input.push(wire_call(&call));
            }
            _ => {}
        }
    }
    check_tool_closure(&input)?;
    let mut tools: Vec<_> = request.tools.iter().map(|tool| json!({
        "type":"function","name":tool.name,"description":tool.description,"parameters":tool.input_schema,"strict":false,
    })).collect();
    if search && config.web_search {
        tools.push(json!({"type":"web_search","external_web_access":true}));
    }
    let mut body = json!({
        "model":config.route.model,"instructions":config.system_prompt,"input":input,"stream":true,"store":false,
        "prompt_cache_key":cache_key(&request.session),
        "reasoning":{"effort":effort},
    });
    if thinking {
        if summary {
            body["reasoning"]["summary"] = "auto".into();
            body["reasoning"]["context"] = "current_turn".into();
        }
        body["include"] = json!(["reasoning.encrypted_content"]);
    }
    if subscription {
        if verbosity {
            body["text"] = json!({"verbosity":"medium"});
        }
    } else if let Some(max) = config.max_output_tokens {
        body["max_output_tokens"] = max.into();
    }
    if !tools.is_empty() {
        body["tools"] = tools.into();
        body["tool_choice"] = "auto".into();
    }
    Ok(body)
}

fn wire_call(call: &ToolCall) -> Value {
    json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":call.arguments.to_string()})
}

fn check_tool_closure(input: &[Value]) -> Result<()> {
    let mut pending = BTreeSet::new();
    for item in input {
        match item["type"].as_str() {
            Some("function_call") => {
                let id = nonblank(item, "call_id")?;
                if !pending.insert(id) {
                    return Err(ProviderError::protocol("duplicate Responses call identity"));
                }
            }
            Some("function_call_output") if !pending.remove(nonblank(item, "call_id")?) => {
                return Err(ProviderError::protocol(
                    "Responses output has no preceding call",
                ));
            }
            _ => {}
        }
    }
    if !pending.is_empty() {
        return Err(ProviderError::protocol(
            "Responses conversation has unfinished tool calls",
        ));
    }
    Ok(())
}

fn cache_key(session: &str) -> String {
    let key = format!("drifting-agent:{session}");
    if key.len() <= 64 {
        return key;
    }
    // Stable across runs without retaining a provider-specific request id.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in session.as_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    format!("drifting-agent:{hash:016x}")
}

struct Call {
    call_id: String,
    name: String,
    arguments: String,
    arguments_done: bool,
    item_done: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Part {
    output: u32,
    part: u32,
    thinking: bool,
}

pub struct Decoder {
    provider: Provider,
    next_index: u32,
    indices: BTreeMap<Part, u32>,
    contents: BTreeMap<Part, String>,
    calls: BTreeMap<String, Call>,
    completed: BTreeMap<u32, Value>,
    started_searches: BTreeSet<String>,
    completed_searches: BTreeSet<String>,
    terminal: bool,
    require_reasoning: bool,
}

impl Decoder {
    #[cfg(test)]
    pub fn new(index_offset: u32) -> Self {
        Self::with_provider(index_offset, Provider::Openai)
    }

    #[cfg(test)]
    pub fn with_provider(index_offset: u32, provider: Provider) -> Self {
        Self::with_config(index_offset, provider, false)
    }

    pub fn with_config(index_offset: u32, provider: Provider, require_reasoning: bool) -> Self {
        Self {
            provider,
            next_index: index_offset,
            indices: BTreeMap::new(),
            contents: BTreeMap::new(),
            calls: BTreeMap::new(),
            completed: BTreeMap::new(),
            started_searches: BTreeSet::new(),
            completed_searches: BTreeSet::new(),
            terminal: false,
            require_reasoning,
        }
    }

    pub fn push(&mut self, event: &SseEvent) -> Result<Vec<DriverEvent>> {
        if event.data.trim() == "[DONE]" {
            return if self.terminal {
                Ok(Vec::new())
            } else {
                Err(ProviderError::protocol(
                    "Responses ended before a terminal event",
                ))
            };
        }
        if self.terminal {
            return Err(ProviderError::protocol("Responses event after completion"));
        }
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|_| ProviderError::protocol("Responses event contains invalid JSON"))?;
        if !value.is_object() {
            return Err(ProviderError::protocol("Responses event is not an object"));
        }
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .or(event.event.as_deref())
            .ok_or_else(|| ProviderError::protocol("Responses event has no type"))?;
        let mut output = Vec::new();
        match kind {
            "error" | "response.failed" => return Err(stream_error(&value)),
            "response.incomplete" => {
                return Err(ProviderError::protocol("Responses response was incomplete"));
            }
            "response.output_text.delta"
            | "response.refusal.delta"
            | "response.reasoning_summary_text.delta" => {
                let thinking = kind == "response.reasoning_summary_text.delta";
                let part = event_part(&value, thinking)?;
                self.delta(part, string(&value, "delta")?, &mut output)?;
            }
            "response.output_text.done"
            | "response.refusal.done"
            | "response.reasoning_summary_text.done" => {
                let thinking = kind == "response.reasoning_summary_text.done";
                let part = event_part(&value, thinking)?;
                self.complete_content(
                    part,
                    string(
                        &value,
                        if kind == "response.refusal.done" {
                            "refusal"
                        } else {
                            "text"
                        },
                    )?,
                    &mut output,
                )?;
            }
            "response.output_item.added" => {
                let item = object(&value, "item")?;
                match string(item, "type")? {
                    "function_call" => {
                        let id = nonblank(item, "id")?.to_owned();
                        let call_id = nonblank(item, "call_id")?.to_owned();
                        if self.calls.contains_key(&id)
                            || self.calls.values().any(|c| c.call_id == call_id)
                        {
                            return Err(ProviderError::protocol(
                                "duplicate Responses function identity",
                            ));
                        }
                        self.calls.insert(
                            id,
                            Call {
                                call_id,
                                name: nonblank(item, "name")?.into(),
                                arguments: optional_string(item, "arguments")?.unwrap_or("").into(),
                                arguments_done: false,
                                item_done: false,
                            },
                        );
                    }
                    "web_search_call" => {
                        self.search(item, ProviderToolStatus::Started, &mut output)?
                    }
                    _ => {}
                }
            }
            "response.function_call_arguments.delta" => {
                let id = nonblank(&value, "item_id")?;
                let call = self.calls.get_mut(id).ok_or_else(|| {
                    ProviderError::protocol("argument fragment has no function item")
                })?;
                if call.arguments_done || call.item_done {
                    return Err(ProviderError::protocol(
                        "argument fragment after function completion",
                    ));
                }
                call.arguments.push_str(string(&value, "delta")?);
            }
            "response.function_call_arguments.done" => {
                let call = self
                    .calls
                    .get_mut(nonblank(&value, "item_id")?)
                    .ok_or_else(|| {
                        ProviderError::protocol("completed arguments have no function item")
                    })?;
                if call.arguments_done || call.item_done {
                    return Err(ProviderError::protocol("duplicate argument completion"));
                }
                finish_arguments(call, string(&value, "arguments")?)?;
                call.arguments_done = true;
            }
            "response.output_item.done" => {
                let index = index(&value, "output_index")?;
                let item = object(&value, "item")?.clone();
                if self.completed.contains_key(&index) {
                    return Err(ProviderError::protocol("duplicate output item completion"));
                }
                self.complete_item(index, &item, &mut output)?;
                self.completed.insert(index, item);
            }
            "response.web_search_call.in_progress" | "response.web_search_call.searching" => {
                let id = nonblank(&value, "item_id")?;
                self.search(&json!({"id":id}), ProviderToolStatus::Started, &mut output)?;
            }
            "response.completed" => {
                let response = object(&value, "response")?;
                if response.get("status").is_some_and(|s| s != "completed") {
                    return Err(ProviderError::protocol(
                        "Responses terminal status is not completed",
                    ));
                }
                let terminal = response
                    .get("output")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        ProviderError::protocol("Responses terminal has no output array")
                    })?;
                let items = if terminal.is_empty() && !self.completed.is_empty() {
                    if self
                        .completed
                        .keys()
                        .enumerate()
                        .any(|(i, k)| i != *k as usize)
                    {
                        return Err(ProviderError::protocol(
                            "Responses completed output has missing indices",
                        ));
                    }
                    self.completed.values().cloned().collect::<Vec<_>>()
                } else {
                    terminal.clone()
                };
                for (index, completed) in &self.completed {
                    let item = items.get(*index as usize).ok_or_else(|| {
                        ProviderError::protocol("Responses terminal dropped an output item")
                    })?;
                    if item.get("id") != completed.get("id")
                        || item.get("type") != completed.get("type")
                    {
                        return Err(ProviderError::protocol(
                            "Responses terminal changed output identity",
                        ));
                    }
                }
                let mut calls = Vec::new();
                let mut seen = BTreeSet::new();
                for (position, item) in items.iter().enumerate() {
                    let output_index = u32::try_from(position)
                        .map_err(|_| ProviderError::protocol("output index overflow"))?;
                    self.complete_item(output_index, item, &mut output)?;
                    if item["type"] == "function_call" {
                        let id = nonblank(item, "id")?;
                        if !seen.insert(id.to_owned()) {
                            return Err(ProviderError::protocol(
                                "duplicate terminal function item",
                            ));
                        }
                        let call = self.calls.get(id).ok_or_else(|| {
                            ProviderError::protocol("terminal function has no streamed identity")
                        })?;
                        let arguments: Value =
                            serde_json::from_str(&call.arguments).map_err(|_| {
                                ProviderError::protocol(
                                    "Responses tool arguments are not valid JSON",
                                )
                            })?;
                        if !arguments.is_object() {
                            return Err(ProviderError::protocol(
                                "Responses tool arguments must be an object",
                            ));
                        }
                        calls.push(ToolCall {
                            id: call.call_id.clone(),
                            name: call.name.clone(),
                            arguments,
                        });
                    }
                }
                if seen.len() != self.calls.len() {
                    return Err(ProviderError::protocol(
                        "Responses terminal lost a function call",
                    ));
                }
                if self.require_reasoning
                    && !calls.is_empty()
                    && !items.iter().any(|item| {
                        item["type"] == "reasoning"
                            && item["encrypted_content"]
                                .as_str()
                                .is_some_and(|s| !s.is_empty())
                    })
                {
                    return Err(ProviderError::protocol(
                        "Responses thinking tool response has no encrypted reasoning",
                    ));
                }
                let usage = parse_usage(object(response, "usage")?)?;
                let reason = if calls.is_empty() {
                    FinishReason::Complete
                } else {
                    FinishReason::Tools
                };
                output.extend(calls.into_iter().map(DriverEvent::ToolCall));
                output.push(DriverEvent::Usage(usage));
                output.push(DriverEvent::Replay {
                    replay: ProviderReplay {
                        provider: self.provider,
                        native_search: None,
                        items,
                    },
                });
                output.push(DriverEvent::Finish(reason));
                self.terminal = true;
            }
            _ => {}
        }
        Ok(output)
    }

    fn block_index(&mut self, part: Part) -> Result<u32> {
        if let Some(index) = self.indices.get(&part) {
            return Ok(*index);
        }
        let index = self.next_index;
        self.next_index = index
            .checked_add(1)
            .ok_or_else(|| ProviderError::protocol("content index overflow"))?;
        self.indices.insert(part, index);
        Ok(index)
    }

    fn delta(&mut self, part: Part, text: &str, output: &mut Vec<DriverEvent>) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let index = self.block_index(part)?;
        self.contents.entry(part).or_default().push_str(text);
        output.push(if part.thinking {
            DriverEvent::ThinkingDelta {
                index,
                text: text.into(),
            }
        } else {
            DriverEvent::TextDelta {
                index,
                text: text.into(),
            }
        });
        Ok(())
    }

    fn complete_content(
        &mut self,
        part: Part,
        text: &str,
        output: &mut Vec<DriverEvent>,
    ) -> Result<()> {
        let previous = self.contents.get(&part).map(String::as_str).unwrap_or("");
        let remaining = text
            .strip_prefix(previous)
            .ok_or_else(|| {
                ProviderError::protocol("Responses final content conflicts with streamed deltas")
            })?
            .to_owned();
        self.delta(part, &remaining, output)
    }

    fn complete_item(
        &mut self,
        output_index: u32,
        item: &Value,
        output: &mut Vec<DriverEvent>,
    ) -> Result<()> {
        match string(item, "type")? {
            "function_call" => {
                let call = self.calls.get_mut(nonblank(item, "id")?).ok_or_else(|| {
                    ProviderError::protocol("completed function has no streamed identity")
                })?;
                if call.call_id != nonblank(item, "call_id")?
                    || call.name != nonblank(item, "name")?
                {
                    return Err(ProviderError::protocol(
                        "Responses function identity changed",
                    ));
                }
                finish_arguments(call, string(item, "arguments")?)?;
                call.item_done = true;
            }
            "message" => {
                let parts = item
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or_else(|| ProviderError::protocol("Responses message has no content"))?;
                for (position, part) in parts.iter().enumerate() {
                    let text = match part["type"].as_str() {
                        Some("output_text") => string(part, "text")?,
                        Some("refusal") => string(part, "refusal")?,
                        _ => continue,
                    };
                    self.complete_content(
                        Part {
                            output: output_index,
                            part: position
                                .try_into()
                                .map_err(|_| ProviderError::protocol("content index overflow"))?,
                            thinking: false,
                        },
                        text,
                        output,
                    )?;
                }
            }
            "reasoning" => {
                if let Some(parts) = item.get("summary").and_then(Value::as_array) {
                    for (position, part) in parts.iter().enumerate() {
                        if part["type"] != "summary_text" {
                            continue;
                        }
                        self.complete_content(
                            Part {
                                output: output_index,
                                part: position.try_into().map_err(|_| {
                                    ProviderError::protocol("summary index overflow")
                                })?,
                                thinking: true,
                            },
                            string(part, "text")?,
                            output,
                        )?;
                    }
                }
            }
            "web_search_call" => {
                let status = if item["status"] == "failed" {
                    ProviderToolStatus::Failed
                } else {
                    ProviderToolStatus::Completed
                };
                self.search(item, status, output)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn search(
        &mut self,
        item: &Value,
        status: ProviderToolStatus,
        output: &mut Vec<DriverEvent>,
    ) -> Result<()> {
        let id = nonblank(item, "id")?.to_owned();
        let seen = if status == ProviderToolStatus::Started {
            &mut self.started_searches
        } else {
            &mut self.completed_searches
        };
        if !seen.insert(id.clone()) {
            return Ok(());
        }
        let action = &item["action"];
        let open = matches!(action["type"].as_str(), Some("open_page" | "find_in_page"));
        let query = action["query"]
            .as_str()
            .or_else(|| action["queries"].as_array()?.iter().find_map(Value::as_str))
            .map(str::to_owned);
        let url = action["url"].as_str().map(str::to_owned);
        output.push(DriverEvent::ProviderTool {
            activity: ProviderTool {
                id,
                action: if open {
                    ProviderToolAction::Open
                } else {
                    ProviderToolAction::Search
                },
                status,
                query,
                url,
            },
        });
        Ok(())
    }

    pub fn finish(&self) -> Result<Option<Vec<Value>>> {
        if self.terminal {
            Ok(None)
        } else {
            Err(ProviderError::protocol(
                "Responses stream disconnected before completion",
            ))
        }
    }
}

fn finish_arguments(call: &mut Call, complete: &str) -> Result<()> {
    if call.arguments.is_empty() {
        call.arguments = complete.into();
    } else if call.arguments != complete {
        return Err(ProviderError::protocol(
            "Responses final arguments conflict with fragments",
        ));
    }
    Ok(())
}
fn event_part(value: &Value, thinking: bool) -> Result<Part> {
    Ok(Part {
        output: optional_index(value, "output_index")?,
        part: optional_index(
            value,
            if thinking {
                "summary_index"
            } else {
                "content_index"
            },
        )?,
        thinking,
    })
}
fn index(value: &Value, key: &str) -> Result<u32> {
    number(value, key)?
        .try_into()
        .map_err(|_| ProviderError::protocol("index overflow"))
}
fn optional_index(value: &Value, key: &str) -> Result<u32> {
    if value.get(key).is_none() {
        Ok(0)
    } else {
        index(value, key)
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::protocol(format!("invalid {key}")))
}
fn nonblank<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let value = string(value, key)?;
    if value.trim().is_empty() {
        Err(ProviderError::protocol(format!("empty {key}")))
    } else {
        Ok(value)
    }
}
fn optional_string<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => string(value, key).map(Some),
    }
}
fn object<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    value
        .get(key)
        .filter(|v| v.is_object())
        .ok_or_else(|| ProviderError::protocol(format!("invalid {key}")))
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ProviderError::protocol(format!("invalid {key}")))
}
fn optional_number(value: &Value, key: &str) -> Result<u64> {
    if value.get(key).is_none() {
        Ok(0)
    } else {
        number(value, key)
    }
}
fn parse_usage(value: &Value) -> Result<Usage> {
    Ok(Usage {
        input_tokens: number(value, "input_tokens")?,
        output_tokens: number(value, "output_tokens")?,
        cached_input_tokens: value
            .get("input_tokens_details")
            .filter(|v| !v.is_null())
            .map(|v| optional_number(v, "cached_tokens"))
            .transpose()?
            .unwrap_or(0),
        cache_write_tokens: value
            .get("input_tokens_details")
            .filter(|v| !v.is_null())
            .map(|v| optional_number(v, "cache_write_tokens"))
            .transpose()?
            .unwrap_or(0),
        reasoning_tokens: value
            .get("output_tokens_details")
            .filter(|v| !v.is_null())
            .map(|v| optional_number(v, "reasoning_tokens"))
            .transpose()?
            .unwrap_or(0),
    })
}
fn stream_error(value: &Value) -> ProviderError {
    let error = value
        .get("response")
        .and_then(|r| r.get("error"))
        .or_else(|| value.get("error"))
        .unwrap_or(value);
    let status = error["status"]
        .as_u64()
        .and_then(|n| n.try_into().ok())
        .unwrap_or(match error["code"].as_str().unwrap_or("") {
            "invalid_api_key" | "authentication_error" => 401,
            "rate_limit_exceeded" | "insufficient_quota" => 429,
            "model_not_found" => 404,
            _ => 502,
        });
    ProviderError::from_status(status, &error.to_string())
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
    fn completed(items: Vec<Value>) -> SseEvent {
        event(
            json!({"type":"response.completed","response":{"status":"completed","output":items,"usage":{"input_tokens":7,"output_tokens":4,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":3}}}}),
        )
    }
    fn function() -> Value {
        json!({"id":"item-1","type":"function_call","call_id":"call-1","name":"read","arguments":"{\"n\":1}"})
    }
    fn add_function(d: &mut Decoder) {
        d.push(&event(json!({"type":"response.output_item.added","output_index":1,"item":{"id":"item-1","type":"function_call","call_id":"call-1","name":"read","arguments":""}}))).unwrap();
    }

    #[test]
    fn text_reasoning_tools_and_encrypted_output_are_preserved_in_order() {
        let mut decoder = Decoder::new(8);
        let thought = json!({"id":"reason-1","type":"reasoning","summary":[{"type":"summary_text","text":"think"}],"encrypted_content":"opaque-synthetic"});
        let text = json!({"id":"message-1","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.invalid/source"}]}]});
        assert!(matches!(&decoder.push(&event(json!({"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"think"}))).unwrap()[0],DriverEvent::ThinkingDelta{index:8,..}));
        add_function(&mut decoder);
        for fragment in ["{\"n\":", "1}"] {
            decoder.push(&event(json!({"type":"response.function_call_arguments.delta","item_id":"item-1","delta":fragment}))).unwrap();
        }
        decoder.push(&event(json!({"type":"response.function_call_arguments.done","item_id":"item-1","arguments":"{\"n\":1}"}))).unwrap();
        let items = vec![thought, function(), text];
        let events = decoder.push(&completed(items.clone())).unwrap();
        assert!(
            events
                .iter()
                .any(|e| matches!(e,DriverEvent::ToolCall(call)if call.arguments==json!({"n":1})))
        );
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
        assert_eq!(replay.items, items);
        assert!(matches!(
            events.last(),
            Some(DriverEvent::Finish(FinishReason::Tools))
        ));
        assert!(decoder.finish().unwrap().is_none());
    }

    #[test]
    fn codex_empty_terminal_uses_contiguous_done_items_and_provider_identity() {
        let mut decoder = Decoder::with_provider(0, Provider::Chatgpt);
        let text = json!({"id":"message-1","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer","annotations":[]}]});
        decoder
            .push(&event(
                json!({"type":"response.output_item.done","output_index":0,"item":text}),
            ))
            .unwrap();
        let events = decoder.push(&completed(vec![])).unwrap();
        assert!(events.iter().any(|e|matches!(e,DriverEvent::Replay{replay}if replay.provider==Provider::Chatgpt&&replay.items==vec![text.clone()])));
        let mut incomplete = Decoder::new(0);
        incomplete
            .push(&event(
                json!({"type":"response.output_item.done","output_index":1,"item":text}),
            ))
            .unwrap();
        assert!(incomplete.push(&completed(vec![])).is_err());
    }

    #[test]
    fn hosted_search_and_open_are_reported_once_and_replayed() {
        let mut decoder = Decoder::new(0);
        let search = json!({"id":"web-1","type":"web_search_call","status":"completed","action":{"type":"search","query":"synthetic"}});
        let open = json!({"id":"web-2","type":"web_search_call","status":"completed","action":{"type":"open_page","url":"https://example.invalid/page"}});
        decoder.push(&event(json!({"type":"response.output_item.added","output_index":0,"item":{"id":"web-1","type":"web_search_call","status":"in_progress"}}))).unwrap();
        let done = decoder
            .push(&event(
                json!({"type":"response.output_item.done","output_index":0,"item":search}),
            ))
            .unwrap();
        assert_eq!(done.iter().filter(|e|matches!(e,DriverEvent::ProviderTool{activity}if activity.status==ProviderToolStatus::Completed)).count(),1);
        let terminal = decoder.push(&completed(vec![search, open])).unwrap();
        assert_eq!(terminal.iter().filter(|e|matches!(e,DriverEvent::ProviderTool{activity}if activity.status==ProviderToolStatus::Completed)).count(),1);
        assert!(terminal.iter().any(|e|matches!(e,DriverEvent::ProviderTool{activity}if activity.action==ProviderToolAction::Open&&activity.url.as_deref()==Some("https://example.invalid/page"))));
        assert!(matches!(
            terminal.last(),
            Some(DriverEvent::Finish(FinishReason::Complete))
        ));
    }

    #[test]
    fn failed_hosted_search_is_reported_once_and_preserved_for_replay() {
        let mut decoder = Decoder::new(0);
        let search = json!({"id":"web-failed","type":"web_search_call","status":"failed","action":{"type":"search","query":"synthetic"}});
        let done = decoder
            .push(&event(
                json!({"type":"response.output_item.done","output_index":0,"item":search}),
            ))
            .unwrap();
        assert!(matches!(
            done.as_slice(),
            [DriverEvent::ProviderTool { activity }]
                if activity.status == ProviderToolStatus::Failed
                    && activity.query.as_deref() == Some("synthetic")
        ));
        let terminal = decoder.push(&completed(vec![search.clone()])).unwrap();
        assert!(
            !terminal
                .iter()
                .any(|event| matches!(event, DriverEvent::ProviderTool { .. }))
        );
        assert!(terminal.iter().any(|event| {
            matches!(event, DriverEvent::Replay { replay } if replay.items == vec![search.clone()])
        }));
        assert!(matches!(
            terminal.last(),
            Some(DriverEvent::Finish(FinishReason::Complete))
        ));
    }

    #[test]
    fn malformed_arguments_duplicate_identity_errors_and_disconnect_fail_closed() {
        let mut decoder = Decoder::new(0);
        add_function(&mut decoder);
        let mut item = function();
        item["arguments"] = "{".into();
        assert!(decoder.push(&completed(vec![item])).is_err());
        let mut decoder = Decoder::new(0);
        add_function(&mut decoder);
        decoder.push(&event(json!({"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\"n\":2}"}))).unwrap();
        assert!(decoder.push(&completed(vec![function()])).is_err());
        assert!(Decoder::new(0).push(&event(json!({"type":"response.failed","response":{"error":{"code":"insufficient_quota"}}}))).is_err());
        assert!(Decoder::new(0).push(&event(json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}))).is_err());
        assert!(Decoder::new(0).finish().is_err());
    }
}

#[cfg(test)]
mod request_tests {
    use super::*;
    use dr_agent::{ModelCapabilities, RunConfig, ToolAccess, ToolDescriptor, ToolPolicy};
    use dr_model::conversation::ConversationEntry;
    use std::sync::Arc;

    fn base(provider: Provider) -> DriverRequest {
        let mut config = RunConfig::new(provider, "synthetic-model");
        config.system_prompt = "synthetic system".into();
        config.route.thinking = ThinkingLevel::High;
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

    #[test]
    fn request_preserves_full_active_replay_and_projects_old_turns_portably() {
        let mut input = base(Provider::Openai);
        let call = ToolCall {
            id: "call-1".into(),
            name: "read".into(),
            arguments: json!({}),
        };
        let raw = vec![
            json!({"type":"reasoning","id":"reason-1","summary":[],"encrypted_content":"opaque-synthetic"}),
            json!({"type":"web_search_call","id":"web-1","status":"completed","action":{"type":"search","query":"synthetic"}}),
            wire_call(&call),
        ];
        let message = AssistantMessage {
            blocks: vec![
                ContentBlock::Text {
                    index: 0,
                    text: "portable text".into(),
                },
                ContentBlock::ToolCall { call },
            ],
            replay: Some(ProviderReplay {
                provider: Provider::Openai,
                native_search: None,
                items: raw.clone(),
            }),
            complete: true,
            ..AssistantMessage::default()
        };
        input.conversation.push(ConversationEntry {
            id: "session-1:2".into(),
            session: "session-1".into(),
            turn: 1,
            kind: ConversationEntryKind::Assistant,
            payload: serde_json::to_value(message).unwrap(),
        });
        input.conversation.push(ConversationEntry {
            id: "session-1:3".into(),
            session: "session-1".into(),
            turn: 1,
            kind: ConversationEntryKind::ToolResult,
            payload: json!({"call":"call-1","status":"success","output":[]}),
        });
        let body = request(&input, true).unwrap();
        assert_eq!(&body["input"].as_array().unwrap()[1..4], raw);
        assert_eq!(body["tools"][0]["strict"], false);
        assert_eq!(
            body["tools"][1],
            json!({"type":"web_search","external_web_access":true})
        );
        input.conversation[1].turn = 0;
        let old = request(&input, true).unwrap();
        assert_eq!(
            old["input"][1],
            json!({"role":"assistant","content":"portable text"})
        );
        assert!(!old.to_string().contains("opaque-synthetic"));
        input.conversation[1].turn = 1;
        Arc::make_mut(&mut input.config).route.provider = Provider::Chatgpt;
        assert!(
            request(&input, true).is_err(),
            "another provider's active opaque state cannot be replayed"
        );
    }

    #[test]
    fn capabilities_control_wire_without_inventing_an_output_cap() {
        let mut input = base(Provider::Chatgpt);
        let config = Arc::make_mut(&mut input.config);
        config.route.thinking = ThinkingLevel::Off;
        config.max_output_tokens = Some(10);
        config.capabilities = Some(ModelCapabilities {
            supports_thinking_off: Some(false),
            thinking_levels: vec![ThinkingLevel::High],
            max_output_tokens: Some(20),
            supports_summary: Some(false),
            supports_verbosity: Some(false),
            ..ModelCapabilities::default()
        });
        let body = request(&input, false).unwrap();
        assert_eq!(body["reasoning"]["effort"], "high");
        assert!(body.get("text").is_none());
        assert!(body.get("max_output_tokens").is_none());
        assert!(body["reasoning"].get("summary").is_none());
        let config = Arc::make_mut(&mut input.config);
        config.route.provider = Provider::Openai;
        config.max_output_tokens = None;
        assert!(
            request(&input, false)
                .unwrap()
                .get("max_output_tokens")
                .is_none()
        );
        Arc::make_mut(&mut input.config).max_output_tokens = Some(21);
        assert_eq!(
            request(&input, false).unwrap_err().category,
            dr_agent::ModelErrorCategory::Unsupported
        );
    }

    #[test]
    fn thinking_tools_require_encrypted_replay_and_cache_key_stays_bounded() {
        let mut decoder = Decoder::with_config(0, Provider::Openai, true);
        decoder.push(&SseEvent{event:None,data:json!({"type":"response.output_item.added","item":{"type":"function_call","id":"item","call_id":"call","name":"read","arguments":"{}"}}).to_string()}).unwrap();
        assert!(decoder.push(&SseEvent{event:None,data:json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","id":"item","call_id":"call","name":"read","arguments":"{}"}],"usage":{"input_tokens":1,"output_tokens":1}}}).to_string()}).is_err());
        assert!(cache_key(&"x".repeat(500)).len() <= 64);
    }
}
