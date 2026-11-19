use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dr_workspace::Actor;
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use serde::Deserialize;
use serde_json::json;

use super::{DEFAULT_PAGE_CHARS, Edit, MAX_PAGE_CHARS, MemoryError, edit_once, read_page};
use crate::{
    Error, Result, ToolAccess, ToolCall, ToolContext, ToolDescriptor, ToolPolicy, tools::ToolOutput,
};

pub const READ_TOOL: &str = "read_working_memory";
pub const EDIT_TOOL: &str = "edit_working_memory";

#[derive(Clone, Default)]
pub struct WorkingMemoryConflicts(Arc<Mutex<HashMap<(String, u32), u32>>>);

impl WorkingMemoryConflicts {
    pub fn forget_session(&self, session: &str) {
        self.0
            .lock()
            .expect("working memory conflicts")
            .retain(|(s, _), _| s != session);
    }

    fn count(&self, session: &str, turn: u32) -> u32 {
        self.0
            .lock()
            .expect("working memory conflicts")
            .get(&(session.to_owned(), turn))
            .copied()
            .unwrap_or(0)
    }

    fn note_conflict(&self, session: &str, turn: u32) -> u32 {
        let mut map = self.0.lock().expect("working memory conflicts");
        let count = map.entry((session.to_owned(), turn)).or_default();
        *count += 1;
        *count
    }

    fn clear_turn(&self, session: &str, turn: u32) {
        self.0
            .lock()
            .expect("working memory conflicts")
            .remove(&(session.to_owned(), turn));
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    #[serde(default)]
    start: usize,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default, alias = "expectedRevision")]
    expected_revision: Option<u64>,
}

const fn default_limit() -> usize {
    DEFAULT_PAGE_CHARS
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditInput {
    #[serde(alias = "expectedRevision")]
    expected_revision: u64,
    edits: Vec<Edit>,
}

pub fn read_descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: READ_TOOL.into(),
        revision: "m30-working-memory-read-v1".into(),
        description: "Read device-local WORKING_MEMORY.md for this project by Unicode character offset and optional expected_revision.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "start": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_PAGE_CHARS},
                "expected_revision": {"type": "integer", "minimum": 0}
            },
            "additionalProperties": false
        }),
        access: ToolAccess::Read,
        policy: ToolPolicy::Local,
    }
}

pub fn edit_descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: EDIT_TOOL.into(),
        revision: "m30-working-memory-edit-v1".into(),
        description: "Apply atomic exact-passage replacements to device-local WORKING_MEMORY.md with revision CAS. When exists is false (expected_revision = 0), edits apply against '# Working Memory\\n\\n## Current\\n\\n## Recent\\n'.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "expected_revision": {"type": "integer", "minimum": 0},
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldText": {"type": "string", "minLength": 1},
                            "newText": {"type": "string"}
                        },
                        "required": ["oldText", "newText"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["expected_revision", "edits"],
            "additionalProperties": false
        }),
        access: ToolAccess::Write,
        policy: ToolPolicy::Local,
    }
}

pub fn describe_tool(name: &str) -> Option<ToolDescriptor> {
    match name {
        READ_TOOL => Some(read_descriptor()),
        EDIT_TOOL => Some(edit_descriptor()),
        _ => None,
    }
}

pub fn execute_tool(
    context: ToolContext,
    call: ToolCall,
    conflicts: Option<WorkingMemoryConflicts>,
) -> BoxFuture<'static, Result<ToolOutput>> {
    async move {
        let (tx, rx) = oneshot::channel();
        std::thread::Builder::new()
            .name("dr-agent-memory-tool".into())
            .spawn(move || {
                let outcome = run_sync(&context, call, conflicts.as_ref());
                drop(context);
                let _ = tx.send(outcome);
            })
            .map_err(|e| Error::Tool(e.to_string()))?;
        rx.await
            .map_err(|_| Error::Tool("working memory worker panicked".into()))?
    }
    .boxed()
}

fn run_sync(
    context: &ToolContext,
    call: ToolCall,
    conflicts: Option<&WorkingMemoryConflicts>,
) -> Result<ToolOutput> {
    if context.cancellation.is_cancelled() {
        return Ok(error_output("cancelled", "cancelled before tool entry"));
    }
    let Actor::Agent { session, turn, .. } = &context.actor else {
        return Ok(error_output(
            "invalid",
            "working memory tools require a chat Agent session",
        ));
    };
    let lib = context.workspace().library();
    let store = crate::long_task::Store::new(lib.clone());
    let chain = match store.chain_for_session(session) {
        Ok(Some(chain)) => chain,
        Ok(None) => {
            return Ok(error_output(
                "invalid",
                "working memory tools are only available in chat request chains",
            ));
        }
        Err(error) => return Ok(error_output("invalid", &error.to_string())),
    };
    match store.snapshot(&chain) {
        Ok(snapshot) if snapshot.book == context.book => {}
        Ok(_) => {
            return Ok(error_output(
                "invalid",
                "request chain belongs to another book",
            ));
        }
        Err(error) => return Ok(error_output("invalid", &error.to_string())),
    }
    match call.name.as_str() {
        READ_TOOL => {
            let input: ReadInput = match serde_json::from_value(call.arguments) {
                Ok(input) => input,
                Err(error) => return Ok(error_output("invalid", &error.to_string())),
            };
            match read_page(
                lib,
                &context.book,
                input.start,
                input.limit,
                input.expected_revision,
            ) {
                Ok(page) => Ok(ToolOutput::Value(serde_json::to_value(page)?)),
                Err(error @ MemoryError::Conflict { .. }) => {
                    Ok(error_output("conflict", &error.to_string()))
                }
                Err(error) => Ok(error_output("invalid", &error.to_string())),
            }
        }
        EDIT_TOOL => {
            if conflicts.is_some_and(|c| c.count(session, *turn) >= 2) {
                return Ok(stop_output(
                    "conflict_limit",
                    "two conflicts on WORKING_MEMORY.md; stopping the turn",
                ));
            }
            let input: EditInput = match serde_json::from_value(call.arguments) {
                Ok(input) => input,
                Err(error) => return Ok(error_output("invalid", &error.to_string())),
            };
            match edit_once(
                lib,
                &context.book,
                &context.actor,
                input.expected_revision,
                &input.edits,
            ) {
                Ok(info) => {
                    if let Some(c) = conflicts {
                        c.clear_turn(session, *turn);
                    }
                    Ok(ToolOutput::Value(serde_json::to_value(info)?))
                }
                Err(error @ MemoryError::Conflict { .. }) => {
                    let count = conflicts.map_or(1, |c| c.note_conflict(session, *turn));
                    if count >= 2 {
                        Ok(stop_output("conflict_limit", &error.to_string()))
                    } else {
                        Ok(error_output("conflict", &error.to_string()))
                    }
                }
                Err(error) => Ok(error_output("invalid", &error.to_string())),
            }
        }
        _ => Ok(error_output("invalid", "unknown working memory tool")),
    }
}

fn error_output(code: &str, message: &str) -> ToolOutput {
    ToolOutput::Error(json!({"error": {"code": code, "message": message}}))
}

fn stop_output(code: &str, message: &str) -> ToolOutput {
    ToolOutput::Stop(json!({"error": {"code": code, "message": message}}))
}
