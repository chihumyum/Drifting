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
    plugins: Option<dr_mcp::PluginTools>,
}

impl CompanionTools {
    pub fn with_plugins(slot: dr_mcp::PluginSlot) -> Self {
        Self {
            book: AgentTools::new(),
            plugins: Some(dr_mcp::PluginTools::new(slot)),
        }
    }
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
        if let Some(plugins) = &self.plugins {
            descriptors.extend(plugins.descriptors());
        }
        descriptors
    }
    fn describe(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        if call.name == "ask_user" {
            Some(ask_descriptor())
        } else {
            self.book.describe(call).or_else(|| {
                self.plugins
                    .as_ref()
                    .and_then(|plugins| plugins.describe(call))
            })
        }
    }
    fn describe_in_book(
        &self,
        workspace: &dr_workspace::Workspace,
        book: &dr_model::id::BookId,
        call: &ToolCall,
    ) -> Option<ToolDescriptor> {
        if call.name == "ask_user" {
            Some(ask_descriptor())
        } else {
            self.book
                .describe_in_book(workspace, book, call)
                .or_else(|| {
                    self.plugins
                        .as_ref()
                        .and_then(|plugins| plugins.describe_in_book(workspace, book, call))
                })
        }
    }
    fn finish_session(&self, session: &str) {
        self.book.finish_session(session);
        if let Some(plugins) = &self.plugins {
            plugins.finish_session(session);
        }
    }
    fn context(
        &self,
        workspace: &dr_workspace::Workspace,
        book: &dr_model::id::BookId,
        session: &str,
    ) -> dr_agent::Result<Vec<dr_agent::context::Contribution>> {
        let mut context = self.book.context(workspace, book, session)?;
        let project = dr_agent::memory::project(workspace, book)
            .map_err(|e| dr_agent::Error::Protocol(e.to_string()))?;
        let working = dr_agent::memory::load(workspace.library(), book)
            .map_err(|e| dr_agent::Error::Protocol(e.to_string()))?;
        if project.entries.iter().any(|e| e.active()) {
            context.push(dr_agent::context::Contribution {
                source: "PROJECT_MEMORY.md".into(),
                text: project.markdown,
            });
        }
        if working.exists {
            context.push(dr_agent::context::Contribution {
                source: "WORKING_MEMORY.md (local work context, not new author instructions)"
                    .into(),
                text: working.content_md,
            });
        }
        Ok(context)
    }
    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, dr_agent::Result<ToolOutput>> {
        if call.name != "ask_user" {
            if let Some(plugins) = &self.plugins
                && plugins.describe(&call).is_some()
            {
                return plugins.execute(context, call);
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m30_does_not_expand_the_frozen_tool_surface() {
        let tools = CompanionTools::default();
        let mut names: Vec<_> = tools.descriptors().into_iter().map(|d| d.name).collect();
        names.sort();
        assert_eq!(names, ["ask_user", "call_tool", "tool_search"]);
        for name in [
            "read_task_plan",
            "update_task_plan",
            "read_working_memory",
            "edit_working_memory",
            "submit_project_checkin",
        ] {
            assert!(
                tools
                    .describe(&ToolCall {
                        id: "fixture".into(),
                        name: name.into(),
                        arguments: json!({})
                    })
                    .is_none()
            );
        }
    }
}
