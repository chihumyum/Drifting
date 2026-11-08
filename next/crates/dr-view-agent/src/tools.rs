//! Author decisions are runtime controls, not a second CRUD registry. The
//! book tools remain the registry-generated M29 facade.

use dr_agent::{
    Question, ToolAccess, ToolCall, ToolContext, ToolDescriptor, ToolExecutor, ToolPolicy,
    tools::ToolOutput,
};
use dr_agent_tools::AgentTools;
use futures::{FutureExt as _, future::BoxFuture};
use serde::Deserialize;
use serde_json::json;

#[derive(Default)]
pub struct CompanionTools {
    book: AgentTools,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ask {
    prompt: String,
    #[serde(default)]
    options: Vec<String>,
}

fn ask_descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name:"ask_user".into(), revision:"m31-ask-author-v1".into(),
        description:"Ask the author when a missing decision blocks the requested work. Use project evidence for factual questions. The answer resumes this same tool call.".into(),
        input_schema:json!({"type":"object","properties":{"prompt":{"type":"string","minLength":1},"options":{"type":"array","items":{"type":"string","minLength":1}}},"required":["prompt"],"additionalProperties":false}),
        access:ToolAccess::Read, policy:ToolPolicy::Local,
    }
}

impl ToolExecutor for CompanionTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        let mut descriptors = self.book.descriptors();
        descriptors.push(ask_descriptor());
        descriptors
    }
    fn describe(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        if call.name == "ask_user" {
            Some(ask_descriptor())
        } else {
            self.book.describe(call)
        }
    }
    fn finish_session(&self, session: &str) {
        self.book.finish_session(session);
    }
    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, dr_agent::Result<ToolOutput>> {
        if call.name != "ask_user" {
            return self.book.execute(context, call);
        }
        async move {
            let ask:Ask=serde_json::from_value(call.arguments)?;
            if ask.prompt.trim().is_empty() || ask.options.iter().any(|option|option.trim().is_empty()) {
                return Ok(ToolOutput::Error(json!({"error":{"code":"invalid","message":"question and options must not be empty"}})));
            }
            Ok(ToolOutput::Question(Question{prompt:ask.prompt,options:ask.options}))
        }.boxed()
    }
}
