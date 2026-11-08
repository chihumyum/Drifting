//! Versioned, provider-neutral journal payloads. Controls stay local.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelErrorCategory {
    Authentication,
    Quota,
    Network,
    Unsupported,
    InvalidResponse,
    Cancelled,
}

/// Safe, stable classification. Never persist raw HTTP bodies or credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct ModelFailure {
    pub category: ModelErrorCategory,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderReplay {
    pub provider: crate::Provider,
    pub items: Vec<Value>,
    /// Records a provider rejection of native search so the next tool round
    /// retains the same tool list that signed thinking was produced against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_search: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderToolAction {
    Search,
    Open,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderToolStatus {
    Started,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTool {
    pub id: String,
    pub action: ProviderToolAction,
    pub status: ProviderToolStatus,
    pub query: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Streaming,
    RunningTools,
    AwaitingAnswer,
    AwaitingPermission,
    Stopping,
    Completed,
    Stopped,
    Aborted,
    Failed,
    Interrupted,
}

impl State {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Stopped | Self::Aborted | Self::Failed | Self::Interrupted
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Unique within this run, supplied by the driver. Never reused on retry.
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolAccess {
    Read,
    Write,
}

/// The only two operations that ask permission. Local writes, including
/// deletion, execute directly and are undone through workspace history.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPolicy {
    #[default]
    Local,
    PaidImage,
    ExternalPlugin,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDescriptor {
    pub name: String,
    /// Immutable handler/schema generation; change it when a plugin changes.
    pub revision: String,
    pub description: String,
    pub input_schema: Value,
    pub access: ToolAccess,
    pub policy: ToolPolicy,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Question {
    pub prompt: String,
    pub options: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestId {
    pub session: String,
    pub turn: u32,
    pub call: String,
    pub nonce: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        index: u32,
        text: String,
    },
    /// The adapter retains the exact signature / opaque replay payload.
    Thinking {
        index: u32,
        text: String,
        signature: Option<String>,
        replay: Option<Value>,
    },
    ToolCall {
        call: ToolCall,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub blocks: Vec<ContentBlock>,
    pub usage: Usage,
    pub complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<ProviderReplay>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Success,
    Error,
    Denied,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettlementRef {
    pub id: i64,
    pub document: String,
    pub seq: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub call: String,
    pub status: ToolStatus,
    pub output: Value,
    /// Authoritative persisted effects, including a failed/aborted write's
    /// partial effects. Empty for no-op writes and ordinary reads.
    pub settlements: Vec<SettlementRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Started {
        version: u32,
    },
    Configured {
        config: crate::RunConfig,
    },
    ProviderReplay {
        replay: ProviderReplay,
    },
    ProviderTool {
        activity: ProviderTool,
    },
    ModelFailed {
        failure: ModelFailure,
    },
    UserMessage {
        text: String,
    },
    StateChanged {
        state: State,
    },
    TextDelta {
        index: u32,
        text: String,
    },
    ThinkingDelta {
        index: u32,
        text: String,
    },
    ThinkingSignature {
        index: u32,
        signature: Option<String>,
        replay: Option<Value>,
    },
    Usage {
        usage: Usage,
    },
    AssistantMessage {
        message: AssistantMessage,
    },
    ToolProposed {
        call: ToolCall,
    },
    ToolStarted {
        call: ToolCall,
    },
    ToolFinished {
        result: ToolResult,
    },
    QuestionAsked {
        request: RequestId,
        question: Question,
    },
    Answered {
        request: RequestId,
        answer: Value,
    },
    PermissionAsked {
        request: RequestId,
        policy: ToolPolicy,
        call: ToolCall,
    },
    PermissionAnswered {
        request: RequestId,
        allow: bool,
    },
    SteeringReceived {
        id: String,
        text: String,
    },
    SteeringApplied {
        id: String,
    },
    StopRequested,
    AbortRequested,
    Failed {
        error: String,
    },
    Recovered,
}
