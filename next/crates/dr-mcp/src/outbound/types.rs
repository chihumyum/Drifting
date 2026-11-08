use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Editable values. `Keep` can only retain this server's existing secret at
/// the same key; clients cannot introduce arbitrary keychain references.
#[derive(Clone)]
pub enum SecretInput {
    Public(String),
    Keep,
    Set(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ConfigValue {
    Public(String),
    Secret { reference: String },
}

#[derive(Clone)]
pub enum TransportDraft {
    Stdio {
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: BTreeMap<String, SecretInput>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, SecretInput>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TransportConfig {
    Stdio {
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: BTreeMap<String, ConfigValue>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, ConfigValue>,
    },
}

#[derive(Clone)]
pub struct ServerDraft {
    pub id: Option<String>,
    pub expected_revision: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub transport: TransportDraft,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Status {
    Disabled,
    Disconnected,
    Connecting,
    Ready,
    Failed { message: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RemoteTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// Opaque capability obtained from mcp_search; includes library instance,
    /// book, configuration, secret references, and this catalog generation.
    pub revision: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub revision: String,
    pub transport: TransportConfig,
    pub status: Status,
    pub tools: Vec<RemoteTool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub book: Option<String>,
    pub servers: Vec<ServerInfo>,
    pub closed: bool,
}
