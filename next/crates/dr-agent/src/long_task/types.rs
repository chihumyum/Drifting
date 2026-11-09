use dr_model::id::{BookId, ConversationId};
use serde::{Deserialize, Serialize};

use crate::RunConfig;

pub const CONTINUATION_ENTRY_KIND: &str = "runtime_continuation";
pub const CHECKPOINT_ENTRY_KIND: &str = "runtime_checkpoint";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartMode {
    Author,
    Automatic,
    Resume,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Chain {
    pub id: String,
    pub book: BookId,
    pub conversation: ConversationId,
    pub original_request: String,
    pub config: RunConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Member {
    pub chain: String,
    pub session: String,
    pub mode: StartMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorInput {
    pub session: String,
    pub id: String,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    Edit,
    Review,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    WholeBook,
    Targets,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Active,
    Paused,
    Blocked,
    Completed,
    Failed,
}
impl TaskStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Blocked,
    Completed,
    Failed,
    Retired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub doc: Option<String>,
}
impl Target {
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub target: Target,
    pub ordinal: usize,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestState {
    pub drifted: bool,
    pub added: Vec<String>,
    pub missing: Vec<String>,
    pub renamed: Vec<String>,
    pub reordered: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    pub paragraph: usize,
    pub quote: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewClaim {
    pub text: String,
    pub citations: Vec<Citation>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewResult {
    pub outcome: String,
    pub claims: Vec<ReviewClaim>,
    #[serde(default)]
    pub findings: Vec<ReviewClaim>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub target: Target,
    pub status: StepStatus,
    pub ordinal: usize,
    pub started_ms: Option<i64>,
    pub finished_ms: Option<i64>,
    pub note: Option<String>,
    pub evidence: Option<String>,
    pub review: Option<ReviewResult>,
    #[serde(default)]
    pub review_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub objective: String,
    pub scope: Scope,
    pub work_kind: WorkKind,
    pub status: TaskStatus,
    pub revision: u64,
    pub manifest: Vec<ManifestEntry>,
    /// Returned snapshot only; stored independently so an individual row stays bounded.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Constraint {
    pub id: String,
    pub text: String,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChainSnapshot {
    pub chain: String,
    pub book: BookId,
    pub conversation: ConversationId,
    pub original_request: String,
    pub steering: Vec<AuthorInput>,
    pub config: RunConfig,
    pub plan: Option<Plan>,
    pub constraints: Vec<Constraint>,
    pub manifest_state: ManifestState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Decision {
    Continue { reason: String },
    Pause { reason: String },
    Off { reason: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Continuation {
    pub snapshot: ChainSnapshot,
    pub decision: Decision,
    pub fingerprint: String,
    pub waited_user: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetSpec {
    pub kind: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Create {
        objective: String,
        scope: Scope,
        work_kind: WorkKind,
        #[serde(default)]
        targets: Vec<TargetSpec>,
    },
    Update {
        expected_revision: u64,
        #[serde(default)]
        objective: Option<String>,
        #[serde(default)]
        status: Option<TaskStatus>,
    },
    AppendSteps {
        expected_revision: u64,
        targets: Vec<TargetSpec>,
    },
    ReconcileManifest {
        expected_revision: u64,
    },
    Step {
        expected_revision: u64,
        step: String,
        status: StepStatus,
        #[serde(default)]
        note: Option<String>,
        #[serde(default, rename = "reviewResult")]
        review: Option<ReviewResult>,
    },
    Constraint {
        expected_revision: u64,
        #[serde(default)]
        id: Option<String>,
        text: String,
        active: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommandReceipt {
    pub id: String,
    pub revision: u64,
    pub merged_steps: Vec<String>,
    pub fingerprint: String,
}
