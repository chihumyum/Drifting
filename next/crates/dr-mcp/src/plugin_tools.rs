//! Exactly two stable model-facing names. A remote call has no public API
//! that can bypass M27's per-call ExternalPlugin approval.
use std::sync::{Arc, Mutex};

use dr_agent::{
    ToolAccess, ToolCall, ToolContext, ToolDescriptor, ToolExecutor, ToolPolicy, tools::ToolOutput,
};
use futures::{FutureExt, future::BoxFuture};
use serde_json::{Value, json};

use crate::outbound::Manager;

#[derive(Clone, Default)]
pub struct PluginSlot(Arc<Mutex<Option<Manager>>>);
impl PluginSlot {
    pub fn replace(&self, manager: Option<Manager>) -> Option<Manager> {
        std::mem::replace(&mut *self.0.lock().expect("MCP plugin slot"), manager)
    }
    fn current(&self) -> Option<Manager> {
        self.0.lock().expect("MCP plugin slot").clone()
    }
}

#[derive(Clone)]
pub struct PluginTools {
    slot: PluginSlot,
}
impl PluginTools {
    pub fn new(slot: PluginSlot) -> Self {
        Self { slot }
    }
}

fn search() -> ToolDescriptor {
    ToolDescriptor {name:"mcp_search".into(),revision:"mcp-search-1".into(),description:"Find external MCP tools in this book's local discovery cache. No server is contacted. Use the returned server, tool, revision and input_schema for mcp_call.".into(),input_schema:json!({"type":"object","properties":{"query":{"type":"string"},"server":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}),access:ToolAccess::Read,policy:ToolPolicy::Local}
}
fn call() -> ToolDescriptor {
    ToolDescriptor {name:"mcp_call".into(),revision:"mcp-call-unavailable".into(),description:"Call an external MCP tool once, after the author approves this exact configuration and tool revision. Remote effects cannot be assumed rolled back after interruption. Obtain the revision and arguments schema from mcp_search.".into(),input_schema:json!({"type":"object","properties":{"server":{"type":"string"},"tool":{"type":"string"},"revision":{"type":"string"},"arguments":{"type":"object"}},"required":["server","tool","revision","arguments"],"additionalProperties":false}),access:ToolAccess::Write,policy:ToolPolicy::ExternalPlugin}
}

fn strings(arguments: &Value) -> Option<(&str, &str, &str)> {
    Some((
        arguments.get("server")?.as_str()?,
        arguments.get("tool")?.as_str()?,
        arguments.get("revision")?.as_str()?,
    ))
}

impl ToolExecutor for PluginTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![search(), call()]
    }
    fn describe(&self, request: &ToolCall) -> Option<ToolDescriptor> {
        match request.name.as_str() {
            "mcp_search" => Some(search()),
            "mcp_call" => {
                let mut descriptor = call();
                if let Some((server, tool, revision)) = strings(&request.arguments)
                    && let Some(manager) = self.slot.current()
                    && let Some((_, remote)) = manager.descriptor(server, tool, revision)
                {
                    descriptor.revision = remote.revision;
                    descriptor.description = format!(
                        "External MCP tool {} on server {}. {}",
                        remote.name, server, remote.description
                    );
                }
                Some(descriptor)
            }
            _ => None,
        }
    }
    fn execute(
        &self,
        context: ToolContext,
        request: ToolCall,
    ) -> BoxFuture<'static, dr_agent::Result<ToolOutput>> {
        let Some(manager) = self.slot.current() else {
            return async { Err(dr_agent::Error::Tool("MCP plugins are unavailable".into())) }
                .boxed();
        };
        match request.name.as_str() {
            "mcp_search" => {
                let query = request
                    .arguments
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let server = request.arguments.get("server").and_then(Value::as_str);
                let limit = request
                    .arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(20)
                    .min(50) as usize;
                let output = manager.search(context.book.as_str(), query, server, limit);
                async move { Ok(ToolOutput::Value(output)) }.boxed()
            }
            "mcp_call" => {
                let Some((server, tool, revision)) = strings(&request.arguments) else {
                    return async { Err(dr_agent::Error::Tool("invalid MCP call".into())) }.boxed();
                };
                let arguments = request
                    .arguments
                    .get("arguments")
                    .cloned()
                    .unwrap_or(Value::Null);
                let completion = manager.call(
                    context,
                    server.to_owned(),
                    tool.to_owned(),
                    revision.to_owned(),
                    arguments,
                );
                async move { completion.await.map_err(dr_agent::Error::Tool) }.boxed()
            }
            _ => async { Err(dr_agent::Error::Tool("unknown MCP facade".into())) }.boxed(),
        }
    }
}
