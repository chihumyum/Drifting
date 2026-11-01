//! Non-secret model catalog for the existing ChatGPT subscription route.

use std::collections::HashSet;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AGE, CACHE_CONTROL, ETAG, IF_NONE_MATCH};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::codex_compat;
use crate::codex_oauth::{self, CodexOAuthState};

const MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const DEFAULT_REFRESH_MS: u64 = 5 * 60 * 1_000;
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

/// Only a non-secret projection crosses IPC. HTTP validators stay native.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelCatalog {
    models: Vec<CodexModel>,
    refresh_after_ms: u64,
}

#[derive(Clone, Copy)]
struct CachePolicy {
    store: bool,
    max_age_ms: u64,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            store: true,
            max_age_ms: DEFAULT_REFRESH_MS,
        }
    }
}

impl CachePolicy {
    fn from_headers(headers: &HeaderMap, previous: Self) -> Self {
        if !headers.contains_key(CACHE_CONTROL) {
            return previous;
        }
        let mut result = Self::default();
        let mut revalidate = false;
        for value in headers.get_all(CACHE_CONTROL) {
            let Ok(value) = value.to_str() else { continue };
            for directive in value.split(',').map(str::trim) {
                let (name, value) = directive.split_once('=').unwrap_or((directive, ""));
                match name.trim().to_ascii_lowercase().as_str() {
                    "no-store" => {
                        result.store = false;
                        revalidate = true;
                    }
                    "no-cache" => revalidate = true,
                    "max-age" => {
                        if let Ok(seconds) = value.trim().trim_matches('"').parse::<u64>() {
                            result.max_age_ms = seconds.saturating_mul(1_000);
                        }
                    }
                    _ => {}
                }
            }
        }
        if revalidate {
            result.max_age_ms = 0;
        }
        result
    }

    fn refresh_after_ms(self, headers: &HeaderMap) -> u64 {
        let age = headers
            .get(AGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        self.max_age_ms
            .saturating_sub(age.saturating_mul(1_000))
            .min(DEFAULT_REFRESH_MS)
    }
}

#[derive(Clone)]
struct CachedCatalog {
    models: Vec<CodexModel>,
    etag: Option<HeaderValue>,
    policy: CachePolicy,
}

struct CatalogRequest {
    epoch: u64,
    cached: Option<CachedCatalog>,
}

#[derive(Default)]
pub(crate) struct CodexCatalogCache {
    epoch: u64,
    identity: Option<String>,
    entry: Option<CachedCatalog>,
}

impl CodexCatalogCache {
    pub(crate) fn clear(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.identity = None;
        self.entry = None;
    }

    fn prepare(&mut self, epoch: u64, identity: String) -> Result<CatalogRequest, String> {
        if epoch != self.epoch {
            return Err("CODEX_MODELS_FAILED: stale_authorization".into());
        }
        if self
            .identity
            .as_ref()
            .is_some_and(|current| current != &identity)
        {
            self.clear();
        }
        self.identity = Some(identity);
        Ok(CatalogRequest {
            epoch: self.epoch,
            cached: self.entry.clone(),
        })
    }

    fn finish(
        &mut self,
        request: CatalogRequest,
        headers: &HeaderMap,
        models: Option<Vec<CodexModel>>,
    ) -> Result<CodexModelCatalog, String> {
        if request.epoch != self.epoch {
            return Err("CODEX_MODELS_FAILED: stale_authorization".into());
        }
        let not_modified = models.is_none();
        let models = models
            .or_else(|| request.cached.as_ref().map(|cached| cached.models.clone()))
            .ok_or("CODEX_MODELS_FAILED: unexpected_not_modified")?;
        let previous = request.cached.as_ref();
        let policy = CachePolicy::from_headers(
            headers,
            if not_modified {
                previous.map(|cached| cached.policy).unwrap_or_default()
            } else {
                CachePolicy::default()
            },
        );
        let etag = headers
            .get(ETAG)
            .filter(|value| value.as_bytes().len() <= 1_024)
            .cloned()
            .or_else(|| {
                if not_modified {
                    previous.and_then(|cached| cached.etag.clone())
                } else {
                    None
                }
            });
        self.entry = policy.store.then(|| CachedCatalog {
            models: models.clone(),
            etag,
            policy,
        });
        Ok(CodexModelCatalog {
            models,
            refresh_after_ms: policy.refresh_after_ms(headers),
        })
    }
}

#[tauri::command]
pub async fn codex_models_list(app: AppHandle) -> Result<CodexModelCatalog, String> {
    let state = app.state::<CodexOAuthState>();
    let client = state.client()?;
    let unavailable = || "CODEX_MODELS_FAILED: cache_unavailable".to_string();
    // Capture before reading credentials: logout also invalidates requests still
    // waiting on Keychain or token refresh, not only those already on the wire.
    let mut epoch = state.models.lock().map_err(|_| unavailable())?.epoch;
    let mut authorization = codex_oauth::authorization(&app, false).await?;
    for attempt in 0..2 {
        let request = state
            .models
            .lock()
            .map_err(|_| unavailable())?
            .prepare(epoch, authorization.catalog_identity())?;
        let mut builder = client
            .get(MODELS_URL)
            .query(&[(
                "client_version",
                &codex_compat::compatibility().client_version,
            )])
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(Duration::from_secs(30));
        if let Some(etag) = request
            .cached
            .as_ref()
            .and_then(|cached| cached.etag.as_ref())
        {
            builder = builder.header(IF_NONE_MATCH, etag);
        }
        let response = codex_oauth::apply_request_headers(builder, &authorization)
            .send()
            .await
            .map_err(|_| "CODEX_MODELS_FAILED: network_failed".to_string())?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            epoch = request.epoch;
            authorization = codex_oauth::authorization(&app, true).await?;
            continue;
        }
        let headers = response.headers().clone();
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return state
                .models
                .lock()
                .map_err(|_| unavailable())?
                .finish(request, &headers, None);
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
        let models = project_models(&bytes)?;
        return state.models.lock().map_err(|_| unavailable())?.finish(
            request,
            &headers,
            Some(models),
        );
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

    fn fixture_models() -> Vec<CodexModel> {
        project_models(br#"{"models":[{"slug":"synthetic-next","visibility":"list"}]}"#).unwrap()
    }

    fn headers(values: &[(&str, &str)]) -> HeaderMap {
        values
            .iter()
            .map(|(name, value)| {
                (
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    HeaderValue::from_str(value).unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn revalidates_etags_and_reuses_only_the_matching_catalog_on_304() {
        let mut cache = CodexCatalogCache::default();
        let request = cache
            .prepare(0, "synthetic-account-a-token".into())
            .unwrap();
        let response = cache
            .finish(
                request,
                &headers(&[
                    ("etag", "W/\"synthetic-v1\""),
                    ("cache-control", "private, max-age=60"),
                ]),
                Some(fixture_models()),
            )
            .unwrap();
        assert_eq!(response.refresh_after_ms, 60_000);
        let request = cache
            .prepare(cache.epoch, "synthetic-account-a-token".into())
            .unwrap();
        assert_eq!(
            request.cached.as_ref().unwrap().etag.as_ref().unwrap(),
            "W/\"synthetic-v1\""
        );
        let response = cache
            .finish(request, &headers(&[("age", "10")]), None)
            .unwrap();
        assert_eq!(response.models, fixture_models());
        assert_eq!(response.refresh_after_ms, 50_000);
        let request = cache
            .prepare(cache.epoch, "synthetic-account-b-token".into())
            .unwrap();
        assert!(request.cached.is_none());
        assert!(cache.finish(request, &HeaderMap::new(), None).is_err());
    }

    #[test]
    fn logout_or_new_login_invalidates_inflight_requests_and_clears_validators() {
        let mut cache = CodexCatalogCache::default();
        let request = cache.prepare(0, "synthetic-a".into()).unwrap();
        cache.clear();
        assert!(cache
            .finish(request, &HeaderMap::new(), Some(fixture_models()))
            .is_err());
        assert!(cache.prepare(0, "synthetic-a".into()).is_err());
        let request = cache.prepare(cache.epoch, "synthetic-b".into()).unwrap();
        assert!(request.cached.is_none());
    }

    #[test]
    fn no_store_discards_the_native_cache_and_no_cache_keeps_only_revalidation_data() {
        let mut cache = CodexCatalogCache::default();
        let request = cache.prepare(0, "synthetic-a".into()).unwrap();
        let response = cache
            .finish(
                request,
                &headers(&[
                    ("etag", "\"v1\""),
                    ("cache-control", "no-store, max-age=600"),
                ]),
                Some(fixture_models()),
            )
            .unwrap();
        assert_eq!(response.refresh_after_ms, 0);
        assert!(cache.entry.is_none());
        let request = cache.prepare(cache.epoch, "synthetic-a".into()).unwrap();
        let response = cache
            .finish(
                request,
                &headers(&[
                    ("etag", "\"v2\""),
                    ("cache-control", "max-age=600, no-cache"),
                ]),
                Some(fixture_models()),
            )
            .unwrap();
        assert_eq!(response.refresh_after_ms, 0);
        assert!(cache.entry.as_ref().unwrap().etag.is_some());
        let request = cache.prepare(cache.epoch, "synthetic-a".into()).unwrap();
        let response = cache
            .finish(request, &headers(&[("cache-control", "no-store")]), None)
            .unwrap();
        assert_eq!(response.models, fixture_models());
        assert!(cache.entry.is_none());
    }

    #[test]
    fn freshness_accounts_for_age_and_caps_long_server_lifetimes() {
        for (control, age, expected) in [
            ("max-age=60", "15", 45_000),
            ("max-age=60", "90", 0),
            ("MAX-AGE=\"3600\"", "600", DEFAULT_REFRESH_MS),
            ("no-cache=\"private-field\", max-age=60", "0", 0),
        ] {
            let headers = headers(&[("cache-control", control), ("age", age)]);
            assert_eq!(
                CachePolicy::from_headers(&headers, CachePolicy::default())
                    .refresh_after_ms(&headers),
                expected
            );
        }
    }

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
