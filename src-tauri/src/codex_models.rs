//! Non-secret model catalog for the existing ChatGPT subscription route.

use std::collections::HashSet;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::codex_oauth::{self, CodexOAuthState};

const MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";
// Match the native OAuth host's codex_cli_rs/0.0.0 identity. This is the
// upstream development-client version, not a model name or entitlement.
const CLIENT_VERSION: &str = "0.0.0";
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    slug: String,
    display_name: String,
    context_window: Option<u64>,
    supported_reasoning_efforts: Vec<String>,
    default_reasoning_effort: Option<String>,
    supports_reasoning_summary: bool,
    supports_verbosity: bool,
}

#[tauri::command]
pub async fn codex_models_list(app: AppHandle) -> Result<Vec<CodexModel>, String> {
    let client = app.state::<CodexOAuthState>().client()?;
    let mut authorization = codex_oauth::authorization(&app, false).await?;
    for attempt in 0..2 {
        let response = codex_oauth::apply_request_headers(
            client
                .get(MODELS_URL)
                .query(&[("client_version", CLIENT_VERSION)])
                .header(reqwest::header::ACCEPT, "application/json")
                .timeout(Duration::from_secs(30)),
            &authorization,
        )
        .send()
        .await
        .map_err(|_| "CODEX_MODELS_FAILED: network_failed".to_string())?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            authorization = codex_oauth::authorization(&app, true).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "CODEX_MODELS_FAILED: provider_rejected ({})",
                response.status().as_u16()
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "CODEX_MODELS_FAILED: network_failed")?;
            if bytes.len().saturating_add(chunk.len()) > MAX_CATALOG_BYTES {
                return Err("CODEX_MODELS_FAILED: catalog_too_large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        return project_models(&bytes);
    }
    Err("CODEX_MODELS_FAILED: authorization_failed".into())
}

pub(crate) fn valid_model_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn project_models(bytes: &[u8]) -> Result<Vec<CodexModel>, String> {
    let invalid = || "CODEX_MODELS_FAILED: invalid_catalog".to_string();
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if models.len() > 1_000 {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for model in models {
        // Preserve subscription visibility and ordering; supported_in_api is
        // about API-key access, so it must not filter this account's choices.
        if model.get("visibility").and_then(Value::as_str) != Some("list") {
            continue;
        }
        let Some(slug) = model
            .get("slug")
            .and_then(Value::as_str)
            .filter(|s| valid_model_slug(s))
        else {
            continue;
        };
        if !seen.insert(slug.to_owned()) {
            continue;
        }
        let display_name = model
            .get("display_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control))
            .unwrap_or(slug)
            .to_owned();
        let efforts = model
            .get("supported_reasoning_levels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|level| level.get("effort").and_then(Value::as_str))
                    .filter(|effort| {
                        matches!(
                            *effort,
                            "none"
                                | "minimal"
                                | "low"
                                | "medium"
                                | "high"
                                | "xhigh"
                                | "max"
                                | "ultra"
                        )
                    })
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        result.push(CodexModel {
            slug: slug.to_owned(),
            display_name,
            context_window: model
                .get("context_window")
                .and_then(Value::as_u64)
                .filter(|n| *n >= 8_192 && *n <= 10_000_000),
            default_reasoning_effort: model
                .get("default_reasoning_level")
                .and_then(Value::as_str)
                .filter(|effort| efforts.iter().any(|candidate| candidate == effort))
                .map(str::to_owned),
            supported_reasoning_efforts: efforts,
            supports_reasoning_summary: model
                .get("supports_reasoning_summary_parameter")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            supports_verbosity: model
                .get("support_verbosity")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    // An empty / unrecognized response must not replace a working catalog.
    if result.is_empty() {
        return Err(invalid());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_visible_models_in_server_order_without_instructions_or_secrets() {
        let bytes = serde_json::to_vec(&serde_json::json!({ "models": [
            { "slug": "gpt-next", "display_name": "Next", "visibility": "list", "supported_in_api": false,
              "context_window": 256000, "supported_reasoning_levels": [{"effort":"low"}, {"effort":"ultra"}],
              "default_reasoning_level": "ultra", "base_instructions": "do not expose", "access_token": "synthetic" },
            { "slug": "gpt-hidden", "visibility": "hide" },
            { "slug": "gpt-next", "visibility": "list" },
            { "slug": "gpt-other", "visibility": "list" },
            { "slug": "bad/slug", "visibility": "list" }
        ]})).unwrap();
        let models = project_models(&bytes).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].slug, "gpt-next");
        assert_eq!(models[0].context_window, Some(256000));
        assert_eq!(models[0].supported_reasoning_efforts, vec!["low", "ultra"]);
        assert_eq!(models[1].display_name, "gpt-other");
        assert_eq!(models[1].context_window, None);
        let projection = serde_json::to_string(&models).unwrap();
        assert!(!projection.contains("access_token"));
        assert!(!projection.contains("instructions"));
    }

    #[test]
    fn rejects_empty_malformed_and_non_catalog_responses() {
        for bytes in [
            b"{}".as_slice(),
            b"not json",
            br#"{"models":[]}"#,
            br#"{"data":[{"id":"gpt-next"}]}"#,
        ] {
            assert!(project_models(bytes).is_err());
        }
        for slug in ["", "gpt-next\n", "https://example.test/model"] {
            assert!(!valid_model_slug(slug));
        }
    }
}
