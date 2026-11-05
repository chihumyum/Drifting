//! Non-secret model lists for the API-key (BYOK) Agent providers.
//!
//! Each provider's own model-list endpoint is the authority for which models
//! the author's key can use. The key is read from secure storage here and never
//! crosses IPC; the renderer receives only model identifiers and the capability
//! metadata the provider publishes. Which listed models the Agent offers, their
//! order and the fallback profiles stay in the renderer's provider contract.

use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::ACCEPT;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::codex_models::valid_model_slug;
use crate::secure_storage;

const DEEPSEEK_MODELS_URL: &str = "https://api.deepseek.com/models";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
/// The same Messages API version the Anthropic drivers send.
const ANTHROPIC_VERSION: &str = "2023-06-01";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODELS: usize = 2_000;
const MAX_ANTHROPIC_PAGES: usize = 10;
const ANTHROPIC_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ByokModelProvider {
    Deepseek,
    Anthropic,
    Openai,
}

impl ByokModelProvider {
    /// Secure-storage ids in read order. The legacy General Agent Anthropic
    /// entry is still read until the renderer migrates it on first use.
    fn key_ids(self) -> &'static [&'static str] {
        match self {
            Self::Deepseek => &["byok.deepseek"],
            Self::Anthropic => &["byok.anthropic", "byok.agent.anthropic"],
            Self::Openai => &["byok.openai"],
        }
    }
}

/// One listed model. Fields the provider does not publish stay `None`; the
/// renderer then uses its own profile for that model or a conservative one.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ByokModel {
    id: String,
    display_name: Option<String>,
    /// Unix seconds, where the provider publishes a creation time.
    created: Option<i64>,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
    adaptive_thinking: Option<bool>,
    efforts: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByokModelCatalog {
    models: Vec<ByokModel>,
}

fn client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "BYOK_MODELS_FAILED: native HTTP client could not start".to_string())?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

#[tauri::command]
pub async fn byok_models_list(
    app: AppHandle,
    provider: ByokModelProvider,
) -> Result<ByokModelCatalog, String> {
    let api_key = read_key(app, provider).await?;
    let client = client()?;
    let models = match provider {
        ByokModelProvider::Deepseek => project_listed_ids(
            &get_json(client.get(DEEPSEEK_MODELS_URL).bearer_auth(&api_key)).await?,
        )?,
        ByokModelProvider::Openai => project_listed_ids(
            &get_json(client.get(OPENAI_MODELS_URL).bearer_auth(&api_key)).await?,
        )?,
        ByokModelProvider::Anthropic => list_anthropic(&client, &api_key).await?,
    };
    Ok(ByokModelCatalog { models })
}

async fn read_key(app: AppHandle, provider: ByokModelProvider) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        for id in provider.key_ids() {
            let value = secure_storage::read_secret(&app, id)
                .map_err(|_| "BYOK_MODELS_FAILED: credential_unavailable".to_string())?;
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                return Ok(value);
            }
        }
        Err("BYOK_MODELS_MISSING_KEY: no API key is configured for this provider".to_string())
    })
    .await
    .map_err(|_| "BYOK_MODELS_FAILED: credential_unavailable".to_string())?
}

async fn get_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .header(ACCEPT, "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| "BYOK_MODELS_FAILED: network_failed".to_string())?;
    let status = response.status();
    if !status.is_success() {
        // Provider error bodies can echo request details; only the status crosses.
        return Err(match status.as_u16() {
            401 | 403 => "BYOK_MODELS_FAILED: authentication_failed".to_string(),
            429 => "BYOK_MODELS_FAILED: rate_limited".to_string(),
            code => format!("BYOK_MODELS_FAILED: provider_rejected ({code})"),
        });
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "BYOK_MODELS_FAILED: network_failed".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > MAX_LIST_BYTES {
            return Err("BYOK_MODELS_FAILED: list_too_large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "BYOK_MODELS_FAILED: invalid_list".to_string())
}

async fn list_anthropic(client: &reqwest::Client, api_key: &str) -> Result<Vec<ByokModel>, String> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_ANTHROPIC_PAGES {
        let mut request = client
            .get(ANTHROPIC_MODELS_URL)
            .query(&[("limit", "1000")])
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION);
        if let Some(after) = &after {
            request = request.query(&[("after_id", after.as_str())]);
        }
        let page = get_json(request).await?;
        project_anthropic_page(&page, &mut seen, &mut models)?;
        if page.get("has_more").and_then(Value::as_bool) != Some(true) {
            break;
        }
        after = page
            .get("last_id")
            .and_then(Value::as_str)
            .filter(|id| valid_model_slug(id))
            .map(str::to_owned);
        if after.is_none() {
            break;
        }
    }
    if models.is_empty() {
        return Err("BYOK_MODELS_FAILED: invalid_list".into());
    }
    Ok(models)
}

fn listed_entries(value: &Value) -> Result<&Vec<Value>, String> {
    let invalid = || "BYOK_MODELS_FAILED: invalid_list".to_string();
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if entries.len() > MAX_MODELS {
        return Err(invalid());
    }
    Ok(entries)
}

/// OpenAI-compatible `GET /models` (OpenAI and DeepSeek): identifiers and the
/// creation time only. Fine-tune ids carry `:` and owner fields name accounts,
/// so neither crosses.
fn project_listed_ids(value: &Value) -> Result<Vec<ByokModel>, String> {
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for entry in listed_entries(value)? {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_model_slug(id))
        else {
            continue;
        };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        models.push(ByokModel {
            id: id.to_owned(),
            created: entry
                .get("created")
                .and_then(Value::as_i64)
                .filter(|seconds| *seconds > 0),
            ..ByokModel::default()
        });
    }
    // An empty or unrecognized list must not replace a working catalog.
    if models.is_empty() {
        return Err("BYOK_MODELS_FAILED: invalid_list".into());
    }
    Ok(models)
}

/// Anthropic `GET /v1/models`: newest first, with the context window, output
/// ceiling and capability tree the Models API publishes.
fn project_anthropic_page(
    value: &Value,
    seen: &mut HashSet<String>,
    models: &mut Vec<ByokModel>,
) -> Result<(), String> {
    for entry in listed_entries(value)? {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_model_slug(id))
        else {
            continue;
        };
        if models.len() >= MAX_MODELS || !seen.insert(id.to_owned()) {
            continue;
        }
        let capabilities = entry.get("capabilities");
        let supported = |path: &[&str]| -> Option<bool> {
            let mut node = capabilities?;
            for key in path {
                node = node.get(*key)?;
            }
            node.get("supported").and_then(Value::as_bool)
        };
        let efforts = match supported(&["effort"]) {
            Some(true) => Some(
                ANTHROPIC_EFFORTS
                    .into_iter()
                    .filter(|level| supported(&["effort", *level]) == Some(true))
                    .map(str::to_owned)
                    .collect(),
            ),
            Some(false) => Some(Vec::new()),
            None => None,
        };
        models.push(ByokModel {
            id: id.to_owned(),
            display_name: entry
                .get("display_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| {
                    !name.is_empty() && name.len() <= 200 && !name.chars().any(char::is_control)
                })
                .map(str::to_owned),
            created: None,
            context_window: entry
                .get("max_input_tokens")
                .and_then(Value::as_u64)
                .filter(|tokens| (8_192..=10_000_000).contains(tokens)),
            max_output_tokens: entry
                .get("max_tokens")
                .and_then(Value::as_u64)
                .filter(|tokens| (256..=10_000_000).contains(tokens)),
            adaptive_thinking: capabilities.and_then(|_| {
                supported(&["thinking", "types", "adaptive"])
                    .or(supported(&["thinking"]).map(|_| false))
            }),
            efforts,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_three_providers_and_rejects_others() {
        for (raw, provider) in [
            ("\"deepseek\"", ByokModelProvider::Deepseek),
            ("\"anthropic\"", ByokModelProvider::Anthropic),
            ("\"openai\"", ByokModelProvider::Openai),
        ] {
            assert_eq!(
                serde_json::from_str::<ByokModelProvider>(raw).unwrap(),
                provider
            );
        }
        assert!(serde_json::from_str::<ByokModelProvider>("\"openai-codex\"").is_err());
        assert!(serde_json::from_str::<ByokModelProvider>("\"google\"").is_err());
        assert_eq!(
            ByokModelProvider::Anthropic.key_ids(),
            &["byok.anthropic", "byok.agent.anthropic"]
        );
    }

    #[test]
    fn projects_openai_compatible_lists_without_owners_or_fine_tunes() {
        let value = serde_json::json!({ "object": "list", "data": [
            { "id": "synthetic-next", "object": "model", "created": 1_790_000_000, "owned_by": "org-synthetic" },
            { "id": "ft:synthetic-next:org:custom:abc", "created": 1_790_000_100 },
            { "id": "synthetic-next", "created": 1 },
            { "id": "synthetic-older", "created": -5 },
            { "object": "model" }
        ]});
        let models = project_listed_ids(&value).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "synthetic-next");
        assert_eq!(models[0].created, Some(1_790_000_000));
        assert_eq!(models[1].created, None);
        let projection = serde_json::to_string(&models).unwrap();
        assert!(!projection.contains("org-synthetic"));
        assert!(!projection.contains("ft:"));
    }

    #[test]
    fn rejects_empty_and_malformed_lists() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({ "data": [] }),
            serde_json::json!({ "data": [{ "id": "bad/slug" }] }),
            serde_json::json!({ "models": [{ "slug": "synthetic-next" }] }),
        ] {
            assert!(project_listed_ids(&value).is_err());
        }
    }

    #[test]
    fn projects_anthropic_limits_and_capabilities_in_listed_order() {
        let value = serde_json::json!({ "data": [
            {
                "id": "claude-synthetic-next", "display_name": "Claude Synthetic Next",
                "created_at": "2026-10-01T00:00:00Z",
                "max_input_tokens": 1_000_000, "max_tokens": 128_000,
                "capabilities": {
                    "image_input": { "supported": true },
                    "thinking": { "supported": true, "types": {
                        "enabled": { "supported": false }, "adaptive": { "supported": true } } },
                    "effort": { "supported": true, "low": { "supported": true },
                        "medium": { "supported": true }, "high": { "supported": true },
                        "xhigh": { "supported": false }, "max": { "supported": true } }
                }
            },
            {
                "id": "claude-synthetic-small", "display_name": "  ",
                "max_input_tokens": 200_000, "max_tokens": 64_000,
                "capabilities": {
                    "thinking": { "supported": true, "types": { "enabled": { "supported": true } } },
                    "effort": { "supported": false }
                }
            },
            { "id": "claude-synthetic-bare", "max_input_tokens": 12, "max_tokens": 2 },
            { "id": "claude-synthetic-next" }
        ]});
        let mut seen = HashSet::new();
        let mut models = Vec::new();
        project_anthropic_page(&value, &mut seen, &mut models).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(
            models[0].display_name.as_deref(),
            Some("Claude Synthetic Next")
        );
        assert_eq!(models[0].context_window, Some(1_000_000));
        assert_eq!(models[0].max_output_tokens, Some(128_000));
        assert_eq!(models[0].adaptive_thinking, Some(true));
        assert_eq!(
            models[0].efforts.as_deref(),
            Some(
                &[
                    "low".to_owned(),
                    "medium".to_owned(),
                    "high".to_owned(),
                    "max".to_owned()
                ][..]
            )
        );
        assert_eq!(models[1].display_name, None);
        assert_eq!(models[1].adaptive_thinking, Some(false));
        assert_eq!(models[1].efforts.as_deref(), Some(&[][..]));
        // Missing capability data is unknown, not "unsupported".
        assert_eq!(models[2].context_window, None);
        assert_eq!(models[2].max_output_tokens, None);
        assert_eq!(models[2].adaptive_thinking, None);
        assert_eq!(models[2].efforts, None);
    }
}
