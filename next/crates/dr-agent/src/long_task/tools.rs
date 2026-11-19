use dr_workspace::Actor;
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use serde::Deserialize;
use serde_json::json;

use super::{Command, StepStatus, Store};
use crate::{
    Error, Result, ToolAccess, ToolCall, ToolContext, ToolDescriptor, ToolPolicy, tools::ToolOutput,
};

pub const READ_TOOL: &str = "read_task_plan";
pub const UPDATE_TOOL: &str = "update_task_plan";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    #[serde(default)]
    from: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}

const fn default_limit() -> usize {
    50
}

pub fn read_descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: READ_TOOL.into(),
        revision: "m30-task-read-v1".into(),
        description: "Read this conversation's durable long-task plan, steps, active constraints, and whole-book manifest drift.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "from": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100}
            },
            "additionalProperties": false
        }),
        access: ToolAccess::Read,
        policy: ToolPolicy::Local,
    }
}

pub fn update_descriptor() -> ToolDescriptor {
    let claim = json!({
        "type": "object",
        "properties": {
            "text": {"type": "string", "minLength": 1},
            "citations": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "paragraph": {"type": "integer", "minimum": 0},
                        "quote": {"type": "string", "minLength": 1}
                    },
                    "required": ["paragraph", "quote"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["text", "citations"],
        "additionalProperties": false
    });
    let target = json!({
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["entry", "module"]},
            "name": {"type": "string", "minLength": 1}
        },
        "required": ["kind", "name"],
        "additionalProperties": false
    });
    ToolDescriptor {
        name: UPDATE_TOOL.into(),
        revision: "m30-task-update-v1".into(),
        description: "Create or update this conversation's durable long-task plan (operations: create, update, append_steps, reconcile_manifest, step, constraint). Whole-book scope enumerates the compiled book sequence automatically (omit targets). Non-create operations require expected_revision. Edit step completion requires an unclaimed saved write to the target's content: a module target's prose, or for an entry target its prose or another of its modules (fields, key-value rows, media, patches, plot grids); a comment, relation, membership, timeline placement or title change does not count. Review step completion requires a complete current target read and cited quotes in reviewResult.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["create", "update", "append_steps", "reconcile_manifest", "step", "constraint"]
                },
                "expected_revision": {"type": "integer", "minimum": 0},
                "objective": {"type": "string", "minLength": 1},
                "scope": {"type": "string", "enum": ["whole_book", "targets"]},
                "work_kind": {"type": "string", "enum": ["edit", "review"]},
                "targets": {"type": "array", "items": target},
                "status": {
                    "type": "string",
                    "description": "Task status (active|paused|blocked|completed|failed) for update, or step status (pending|in_progress|blocked|completed|failed) for step."
                },
                "step": {"type": "string", "minLength": 1},
                "note": {"type": "string"},
                "reviewResult": {
                    "type": "object",
                    "properties": {
                        "outcome": {"type": "string", "minLength": 1},
                        "claims": {"type": "array", "items": claim},
                        "findings": {"type": "array", "items": claim}
                    },
                    "required": ["outcome", "claims"],
                    "additionalProperties": false
                },
                "id": {"type": "string", "minLength": 1},
                "text": {"type": "string", "minLength": 1},
                "active": {"type": "boolean"}
            },
            "required": ["operation"],
            "additionalProperties": false
        }),
        access: ToolAccess::Write,
        policy: ToolPolicy::Local,
    }
}

pub fn describe_tool(name: &str) -> Option<ToolDescriptor> {
    match name {
        READ_TOOL => Some(read_descriptor()),
        UPDATE_TOOL => Some(update_descriptor()),
        _ => None,
    }
}

pub fn execute_tool(
    context: ToolContext,
    call: ToolCall,
) -> BoxFuture<'static, Result<ToolOutput>> {
    async move {
        let (tx, rx) = oneshot::channel();
        std::thread::Builder::new()
            .name("dr-agent-task-tool".into())
            .spawn(move || {
                let outcome = run_sync(&context, call);
                drop(context);
                let _ = tx.send(outcome);
            })
            .map_err(|e| Error::Tool(e.to_string()))?;
        rx.await
            .map_err(|_| Error::Tool("task plan worker panicked".into()))?
    }
    .boxed()
}

fn run_sync(context: &ToolContext, call: ToolCall) -> Result<ToolOutput> {
    if context.cancellation.is_cancelled() {
        return Ok(error_output("cancelled", "cancelled before tool entry"));
    }
    let Actor::Agent {
        session,
        turn,
        call: call_id,
    } = &context.actor
    else {
        return Ok(error_output(
            "invalid",
            "task plan tools require a chat Agent session",
        ));
    };
    let store = Store::new(context.workspace().library().clone());
    let chain = match store.chain_for_session(session) {
        Ok(Some(chain)) => chain,
        Ok(None) => {
            return Ok(error_output(
                "invalid",
                "task plan tools are only available in chat request chains",
            ));
        }
        Err(error) => return Ok(classify_error(&error.to_string())),
    };
    let snapshot = match store.snapshot(&chain) {
        Ok(snapshot) => snapshot,
        Err(error) => return Ok(classify_error(&error.to_string())),
    };
    if snapshot.book != context.book {
        return Ok(error_output(
            "invalid",
            "request chain belongs to another book",
        ));
    }
    match call.name.as_str() {
        READ_TOOL => {
            let input: ReadInput = match serde_json::from_value(call.arguments) {
                Ok(input) => input,
                Err(error) => return Ok(error_output("invalid", &error.to_string())),
            };
            if !(1..=100).contains(&input.limit) {
                return Ok(error_output("invalid", "limit must be between 1 and 100"));
            }
            Ok(ToolOutput::Value(crate::context::plan_projection(
                &snapshot,
                input.from,
                input.limit,
            )))
        }
        UPDATE_TOOL => {
            let command: Command = match serde_json::from_value(call.arguments) {
                Ok(command) => command,
                Err(error) => return Ok(error_output("invalid", &error.to_string())),
            };
            let receipt = match store.apply(session, *turn, call_id, command) {
                Ok(receipt) => receipt,
                Err(error) => return Ok(classify_error(&error.to_string())),
            };
            let updated = match store.snapshot(&chain) {
                Ok(updated) => updated,
                Err(error) => return Ok(classify_error(&error.to_string())),
            };
            let from = updated
                .plan
                .as_ref()
                .and_then(|plan| {
                    plan.steps.iter().position(|step| {
                        matches!(step.status, StepStatus::InProgress | StepStatus::Pending)
                    })
                })
                .unwrap_or(0);
            Ok(ToolOutput::Value(json!({
                "receipt": receipt,
                "state": crate::context::plan_projection(&updated, from, 50),
            })))
        }
        _ => Ok(error_output("invalid", "unknown task plan tool")),
    }
}

fn classify_error(message: &str) -> ToolOutput {
    let code = if message.contains("revision conflict") || message.contains("TASK_MANIFEST_DRIFT") {
        "conflict"
    } else {
        "invalid"
    };
    error_output(code, message)
}

fn error_output(code: &str, message: &str) -> ToolOutput {
    ToolOutput::Error(json!({"error": {"code": code, "message": message}}))
}
