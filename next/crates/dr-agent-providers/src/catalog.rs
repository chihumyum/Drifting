//! Live model lists and the exact 0.1 bundled fallback. Missing provider
//! metadata stays distinguishable from a bundled/local planning profile.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use dr_agent::{ModelCapabilities, ModelErrorCategory, Provider, RunConfig, ThinkingLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::credentials::Credentials;
use crate::oauth::{self, Authorization, OAuth, OAuthCancellation};
use crate::{ProviderError, Result};

pub const CACHE_MS: u64 = 5 * 60 * 1000;
const MAX_LIST_BYTES: usize = 8 * 1024 * 1024;
const EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const FULL_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub provider: Provider,
    pub id: String,
    pub label: String,
    pub short: String,
    pub profile_id: String,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub provider_overhead_tokens: u64,
    pub per_tool_overhead_tokens: u64,
    pub thinking_modes: Vec<String>,
    pub efforts: Vec<String>,
    pub default_thinking: String,
    pub default_effort: String,
    pub forced_tool_choice: bool,
    pub supports_summary: bool,
    pub supports_verbosity: bool,
    pub created: Option<i64>,
    /// Raw published limits: a local fallback never masquerades as metadata.
    pub published_context_window: Option<u64>,
    pub published_max_output_tokens: Option<u64>,
}

impl ModelInfo {
    /// Freeze the selected catalog profile into a run. The adapter never
    /// consults a changing catalog or silently substitutes an effort level.
    pub fn run_config(&self, thinking: ThinkingLevel) -> Result<RunConfig> {
        let supports_off = self.thinking_modes.iter().any(|mode| mode == "off");
        if (thinking == ThinkingLevel::Off && !supports_off)
            || (thinking != ThinkingLevel::Off
                && (!self.thinking_modes.iter().any(|mode| mode == "adaptive")
                    || !self
                        .efforts
                        .iter()
                        .any(|effort| effort == thinking.as_str())))
        {
            return Err(ProviderError::new(ModelErrorCategory::Unsupported, false));
        }
        let known = profile(self.provider, &self.id).is_some();
        let mut config = RunConfig::new(self.provider, &self.id);
        config.route.thinking = thinking;
        let codex_metadata = self.profile_id.ends_with("responses-codex-catalog-v2");
        config.capabilities = Some(ModelCapabilities {
            context_window: if self.published_context_window.is_some() || (known && !codex_metadata)
            {
                self.context_window
            } else {
                None
            },
            max_output_tokens: if self.published_max_output_tokens.is_some() || known {
                self.max_output_tokens.and_then(|n| u32::try_from(n).ok())
            } else {
                None
            },
            thinking_levels: self
                .efforts
                .iter()
                .filter_map(|effort| serde_json::from_value(Value::String(effort.clone())).ok())
                .collect(),
            supports_thinking_off: Some(supports_off),
            supports_summary: codex_metadata.then_some(self.supports_summary),
            supports_verbosity: codex_metadata.then_some(self.supports_verbosity),
        });
        Ok(config)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CatalogSource {
    Live,
    Cache,
    Bundled,
}

#[derive(Clone, Debug)]
pub struct Catalog {
    pub models: Vec<ModelInfo>,
    pub source: CatalogSource,
    pub refresh_after_ms: u64,
    pub failure: Option<ModelErrorCategory>,
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).to_owned()).collect()
}

fn bundled(
    provider: Provider,
    id: &str,
    label: &str,
    short: &str,
    reasoning_off: bool,
) -> ModelInfo {
    let (wire, window, max, overhead) = match provider {
        Provider::Deepseek => ("agent-v4", 1_048_576, 393_216, 512),
        Provider::Anthropic => ("messages-v1", 1_000_000, 128_000, 768),
        Provider::Openai => ("responses-v1", 1_050_000, 128_000, 640),
        Provider::Chatgpt => ("responses-codex-v1", 1_050_000, 128_000, 640),
    };
    ModelInfo {
        provider,
        id: id.into(),
        label: label.into(),
        short: short.into(),
        profile_id: format!("{id}:{wire}"),
        context_window: Some(window),
        max_output_tokens: Some(max),
        provider_overhead_tokens: overhead,
        per_tool_overhead_tokens: 8,
        thinking_modes: strings(if reasoning_off {
            &["off", "adaptive"]
        } else {
            &["adaptive"]
        }),
        efforts: strings(if provider == Provider::Deepseek {
            &["low", "high", "max"]
        } else {
            FULL_EFFORTS
        }),
        default_thinking: if reasoning_off { "off" } else { "adaptive" }.into(),
        default_effort: "high".into(),
        forced_tool_choice: provider != Provider::Anthropic || id == "claude-haiku-5-5",
        supports_summary: false,
        supports_verbosity: false,
        created: None,
        published_context_window: None,
        published_max_output_tokens: None,
    }
}

/// Ported from `AGENT_PROVIDER_OPTIONS`, including order, labels and profiles.
pub fn bundled_models(provider: Provider) -> Vec<ModelInfo> {
    let rows: &[(&str, &str, &str, bool)] = match provider {
        Provider::Deepseek => &[
            (
                "deepseek-flash",
                "DeepSeek Flash · fast",
                "DeepSeek Flash",
                true,
            ),
            (
                "deepseek-v4-pro",
                "DeepSeek Pro · steady",
                "DeepSeek Pro",
                true,
            ),
        ],
        Provider::Anthropic => &[
            (
                "claude-sonnet-5-5",
                "Claude Sonnet 5.5 · balanced",
                "Sonnet 5.5",
                false,
            ),
            (
                "claude-opus-5-5",
                "Claude Opus 5.5 · steady",
                "Opus 5.5",
                false,
            ),
            (
                "claude-fable-5-1",
                "Claude Fable 5.1 · frontier",
                "Fable 5.1",
                false,
            ),
            (
                "claude-haiku-5-5",
                "Claude Haiku 5.5 · fast",
                "Haiku 5.5",
                false,
            ),
        ],
        Provider::Openai | Provider::Chatgpt => &[
            ("gpt-6-astra", "GPT-6 Astra · frontier", "6 Astra", false),
            ("gpt-6.1-sol", "GPT-6.1 Sol · strong", "6.1 Sol", false),
            (
                "gpt-6.1-terra",
                "GPT-6.1 Terra · balanced",
                "6.1 Terra",
                true,
            ),
            ("gpt-6-luna", "GPT-6 Luna · efficient", "6 Luna", true),
        ],
    };
    rows.iter()
        .map(|(id, label, short, off)| bundled(provider, id, label, short, *off))
        .collect()
}

pub fn profile(provider: Provider, id: &str) -> Option<ModelInfo> {
    let id = if provider == Provider::Deepseek && id == "deepseek-v4-flash" {
        "deepseek-flash"
    } else {
        id
    };
    if let Some(model) = bundled_models(provider).into_iter().find(|m| m.id == id) {
        return Some(model);
    }
    match (provider, id) {
        (Provider::Anthropic, "claude-sonnet-5") => {
            let mut model = bundled(provider, id, "Claude Sonnet 5 · balanced", "Sonnet 5", true);
            model.forced_tool_choice = true;
            Some(model)
        }
        (Provider::Anthropic, "claude-haiku-4-5-20251001") => {
            let mut model = bundled(provider, id, "Claude Haiku 4.5 · fast", "Haiku 4.5", true);
            model.context_window = Some(200_000);
            model.max_output_tokens = Some(64_000);
            model.thinking_modes = strings(&["off"]);
            model.efforts.clear();
            model.forced_tool_choice = true;
            Some(model)
        }
        (Provider::Openai, "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna") => {
            let tier = id.rsplit('-').next()?;
            let title = format!("{}{}", tier[..1].to_uppercase(), &tier[1..]);
            Some(bundled(
                provider,
                id,
                &format!("GPT-5.6 {title}"),
                &format!("5.6 {title}"),
                true,
            ))
        }
        _ => None,
    }
}

pub fn models_url(provider: Provider) -> &'static str {
    match provider {
        Provider::Deepseek => "https://api.deepseek.com/models",
        Provider::Anthropic => "https://api.anthropic.com/v1/models",
        Provider::Openai => "https://api.openai.com/v1/models",
        Provider::Chatgpt => "https://chatgpt.com/backend-api/codex/models",
    }
}

#[derive(Clone)]
struct Cached {
    models: Vec<ModelInfo>,
    expires_ms: u64,
    etag: Option<String>,
    max_age_ms: u64,
}

#[derive(Default)]
pub struct CatalogCache {
    entries: Mutex<HashMap<String, Cached>>,
}

impl CatalogCache {
    pub fn clear(&self) {
        self.entries.lock().expect("model catalog").clear();
    }

    pub async fn list(
        &self,
        client: &reqwest::Client,
        credentials: &Credentials,
        provider: Provider,
        endpoint: Option<&str>,
    ) -> Catalog {
        let key = match credentials.api_key(provider).await {
            Ok(Some(key)) => key,
            Ok(None) => return fallback(provider, ProviderError::from_status(401, "")),
            Err(error) => return fallback(provider, error),
        };
        self.list_with_key_at(
            client,
            provider,
            &key,
            endpoint.unwrap_or(models_url(provider)),
            oauth::now_ms(),
        )
        .await
    }

    /// Explicit clock/endpoint for deterministic cache and loopback tests.
    pub async fn list_with_key_at(
        &self,
        client: &reqwest::Client,
        provider: Provider,
        key: &str,
        endpoint: &str,
        now: u64,
    ) -> Catalog {
        if provider == Provider::Chatgpt {
            return fallback(
                provider,
                ProviderError::protocol("ChatGPT catalog needs OAuth"),
            );
        }
        match self.fetch(client, provider, key, None, endpoint, now).await {
            Ok(catalog) => catalog,
            Err(error) => fallback(provider, error),
        }
    }

    pub async fn list_chatgpt(
        &self,
        client: &reqwest::Client,
        oauth: &OAuth,
        cancel: &OAuthCancellation,
        endpoint: Option<&str>,
    ) -> Catalog {
        let mut authorization = match oauth.authorization(client, false, cancel).await {
            Ok(value) => value,
            Err(error) => return fallback(Provider::Chatgpt, error),
        };
        for attempt in 0..2 {
            let result = cancel
                .run(self.fetch(
                    client,
                    Provider::Chatgpt,
                    &authorization.access_token,
                    Some(&authorization),
                    endpoint.unwrap_or(models_url(Provider::Chatgpt)),
                    oauth::now_ms(),
                ))
                .await;
            match result {
                Ok(catalog) => return catalog,
                Err(error)
                    if attempt == 0 && error.category == ModelErrorCategory::Authentication =>
                {
                    authorization = match oauth.force_refresh(client, cancel).await {
                        Ok(value) => value,
                        Err(error) => return fallback(Provider::Chatgpt, error),
                    };
                }
                Err(error) => return fallback(Provider::Chatgpt, error),
            }
        }
        unreachable!("two catalog attempts return")
    }

    async fn fetch(
        &self,
        client: &reqwest::Client,
        provider: Provider,
        key: &str,
        authorization: Option<&Authorization>,
        endpoint: &str,
        now: u64,
    ) -> Result<Catalog> {
        validate_endpoint(endpoint)?;
        if key.trim().is_empty() {
            return Err(ProviderError::from_status(401, ""));
        }
        let mut hash = Sha256::new();
        hash.update(provider.as_str());
        hash.update([0]);
        hash.update(endpoint);
        hash.update([0]);
        hash.update(key);
        if let Some(auth) = authorization {
            hash.update([0]);
            hash.update(auth.account_id.as_deref().unwrap_or_default());
        }
        let identity = format!("{:x}", hash.finalize());
        let cached = self
            .entries
            .lock()
            .expect("model catalog")
            .get(&identity)
            .cloned();
        if let Some(entry) = cached.as_ref().filter(|c| c.expires_ms > now) {
            return Ok(Catalog {
                models: entry.models.clone(),
                source: CatalogSource::Cache,
                refresh_after_ms: entry.expires_ms - now,
                failure: None,
            });
        }
        let mut models = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        let mut cursors = HashSet::new();
        let mut headers = reqwest::header::HeaderMap::new();
        let mut not_modified = false;
        for page in 0..10 {
            let mut request = client
                .get(endpoint)
                .header("accept", "application/json")
                .timeout(Duration::from_secs(20));
            if provider == Provider::Anthropic {
                request = request
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01")
                    .query(&[("limit", "1000")]);
                if let Some(cursor) = &cursor {
                    request = request.query(&[("after_id", cursor)]);
                }
            } else if let Some(auth) = authorization {
                request = auth
                    .apply(request)
                    .query(&[("client_version", oauth::CLIENT_VERSION)]);
                if let Some(etag) = cached.as_ref().and_then(|c| c.etag.as_deref()) {
                    request = request.header("if-none-match", etag);
                }
            } else {
                request = request.bearer_auth(key);
            }
            let response = request.send().await.map_err(ProviderError::network)?;
            headers = response.headers().clone();
            if response.status().as_u16() == 304 && provider == Provider::Chatgpt {
                not_modified = true;
                models = cached
                    .as_ref()
                    .ok_or_else(|| ProviderError::protocol("catalog 304 without matching cache"))?
                    .models
                    .clone();
                break;
            }
            let value = oauth::checked_json(response, MAX_LIST_BYTES).await?;
            if provider == Provider::Chatgpt {
                models = project_codex(&value)?;
                break;
            }
            project_api(provider, &value, &mut seen, &mut models)?;
            if provider != Provider::Anthropic
                || value.get("has_more").and_then(Value::as_bool) != Some(true)
            {
                break;
            }
            let next = value
                .get("last_id")
                .and_then(Value::as_str)
                .filter(|id| valid_model_id(id))
                .ok_or_else(|| ProviderError::protocol("model pagination has no cursor"))?;
            if page == 9 || !cursors.insert(next.to_owned()) {
                return Err(ProviderError::protocol(
                    "model pagination did not terminate",
                ));
            }
            cursor = Some(next.to_owned());
        }
        if models.is_empty() {
            return Err(ProviderError::protocol("no supported models listed"));
        }
        if provider != Provider::Chatgpt {
            let bundled = bundled_models(provider);
            models.sort_by_key(|m| {
                (
                    bundled
                        .iter()
                        .position(|b| b.id == m.id)
                        .unwrap_or(bundled.len()),
                    std::cmp::Reverse(m.created.unwrap_or(0)),
                )
            });
        }
        let (store, max_age) = cache_policy(
            &headers,
            if not_modified {
                cached.as_ref().map(|c| c.max_age_ms).unwrap_or(CACHE_MS)
            } else {
                CACHE_MS
            },
        );
        let age = headers
            .get("age")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_mul(1000);
        let refresh_after_ms = max_age.saturating_sub(age).min(CACHE_MS);
        let etag = headers
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .filter(|h| h.len() <= 1024)
            .map(str::to_owned)
            .or_else(|| {
                not_modified
                    .then(|| cached.as_ref().and_then(|c| c.etag.clone()))
                    .flatten()
            });
        let mut cache = self.entries.lock().expect("model catalog");
        if store {
            cache.insert(
                identity,
                Cached {
                    models: models.clone(),
                    expires_ms: now.saturating_add(refresh_after_ms),
                    etag,
                    max_age_ms: max_age,
                },
            );
        } else {
            cache.remove(&identity);
        }
        Ok(Catalog {
            models,
            source: CatalogSource::Live,
            refresh_after_ms,
            failure: None,
        })
    }
}

fn fallback(provider: Provider, error: ProviderError) -> Catalog {
    Catalog {
        models: bundled_models(provider),
        source: CatalogSource::Bundled,
        refresh_after_ms: 0,
        failure: Some(error.category),
    }
}

fn validate_endpoint(endpoint: &str) -> Result<()> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|_| ProviderError::protocol("invalid catalog endpoint"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (url.scheme() != "https"
            && !(url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
    {
        return Err(ProviderError::protocol(
            "catalog endpoint requires HTTPS or loopback",
        ));
    }
    Ok(())
}

fn cache_policy(headers: &reqwest::header::HeaderMap, previous: u64) -> (bool, u64) {
    let Some(raw) = headers.get("cache-control").and_then(|h| h.to_str().ok()) else {
        return (true, previous);
    };
    let mut store = true;
    let mut age = CACHE_MS;
    let mut revalidate = false;
    for directive in raw.split(',').map(str::trim) {
        let (name, value) = directive.split_once('=').unwrap_or((directive, ""));
        match name.trim().to_ascii_lowercase().as_str() {
            "no-store" => {
                store = false;
                revalidate = true;
            }
            "no-cache" => revalidate = true,
            "max-age" => {
                if let Ok(seconds) = value.trim().trim_matches('"').parse::<u64>() {
                    age = seconds.saturating_mul(1000);
                }
            }
            _ => {}
        }
    }
    (store, if revalidate { 0 } else { age })
}

pub fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub fn supported_api_model(provider: Provider, id: &str) -> bool {
    if !valid_model_id(id) {
        return false;
    }
    match provider {
        Provider::Deepseek => id.starts_with("deepseek-"),
        Provider::Anthropic => id.starts_with("claude-"),
        Provider::Chatgpt => false,
        Provider::Openai => {
            let Some(rest) = id.strip_prefix("gpt-") else {
                return false;
            };
            let major = rest
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            let parts: Vec<_> = id.split('-').collect();
            let dated = parts.len() >= 4
                && parts[parts.len() - 3].len() == 4
                && parts[parts.len() - 2].len() == 2
                && parts[parts.len() - 1].len() == 2
                && parts[parts.len() - 3..]
                    .iter()
                    .all(|p| p.bytes().all(|b| b.is_ascii_digit()));
            major >= 5
                && !dated
                && !parts.iter().skip(1).any(|p| {
                    matches!(
                        *p,
                        "audio"
                            | "realtime"
                            | "transcribe"
                            | "tts"
                            | "image"
                            | "search"
                            | "embedding"
                            | "instruct"
                            | "moderation"
                            | "live"
                            | "chat"
                            | "codex"
                            | "cyber"
                            | "rosalind"
                            | "research"
                            | "deep"
                            | "daybreak"
                            | "preview"
                    )
                })
        }
    }
}

fn number(value: &Value, key: &str, min: u64) -> Option<u64> {
    value
        .get(key)?
        .as_u64()
        .filter(|n| (min..=10_000_000).contains(n))
}
fn name(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}

fn unknown(provider: Provider, id: &str) -> ModelInfo {
    let mut model = bundled(provider, id, id, id, provider == Provider::Deepseek);
    model.profile_id = format!("{id}:listed-v1");
    model.context_window = Some(128_000);
    model.max_output_tokens = if provider == Provider::Anthropic {
        Some(32_000)
    } else {
        None
    };
    model.efforts = strings(if provider == Provider::Deepseek {
        &["high", "max"]
    } else {
        &["low", "medium", "high"]
    });
    model.forced_tool_choice = provider != Provider::Anthropic;
    model
}

fn project_api(
    provider: Provider,
    value: &Value,
    seen: &mut HashSet<String>,
    models: &mut Vec<ModelInfo>,
) -> Result<()> {
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .filter(|v| v.len() <= 2000)
        .ok_or_else(|| ProviderError::protocol("invalid model list"))?;
    for row in rows {
        let Some(id) = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| supported_api_model(provider, id))
        else {
            continue;
        };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        if models.len() >= 2000 {
            return Err(ProviderError::protocol("too many listed models"));
        }
        let known = profile(provider, id);
        let mut model = known.clone().unwrap_or_else(|| unknown(provider, id));
        model.id = id.into();
        if known.is_none()
            && let Some(label) = name(
                row,
                if provider == Provider::Anthropic {
                    "display_name"
                } else {
                    "name"
                },
            )
        {
            model.label = label.clone();
            model.short = label;
        }
        model.created = row
            .get("created")
            .and_then(Value::as_i64)
            .filter(|n| *n > 0);
        if provider == Provider::Openai {
            models.push(model);
            continue;
        }
        model.published_context_window = number(
            row,
            if provider == Provider::Anthropic {
                "max_input_tokens"
            } else {
                "context_window"
            },
            8192,
        );
        model.published_max_output_tokens = number(
            row,
            if provider == Provider::Anthropic {
                "max_tokens"
            } else {
                "max_output_tokens"
            },
            256,
        );
        if let Some(n) = model.published_context_window {
            model.context_window = Some(n);
        }
        if let Some(n) = model.published_max_output_tokens {
            model.max_output_tokens = Some(n);
        }
        if let (Some(max), Some(window)) = (model.max_output_tokens, model.context_window) {
            model.max_output_tokens = Some(max.min(window));
        }
        if provider == Provider::Deepseek {
            if let Some(effort) = row.get("effort")
                && let Some(levels) = effort.get("supported_levels").and_then(Value::as_array)
            {
                model.efforts = FULL_EFFORTS
                    .iter()
                    .filter(|e| levels.iter().any(|v| v.as_str() == Some(**e)))
                    .map(|s| (*s).to_owned())
                    .collect();
                model.thinking_modes = if model.efforts.is_empty() {
                    strings(&["off"])
                } else {
                    strings(&["off", "adaptive"])
                };
                model.default_effort = effort
                    .get("default_level")
                    .and_then(Value::as_str)
                    .filter(|e| model.efforts.iter().any(|v| v == e))
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        if model.efforts.iter().any(|e| e == "high") {
                            "high".into()
                        } else {
                            model
                                .efforts
                                .first()
                                .cloned()
                                .unwrap_or_else(|| "high".into())
                        }
                    });
            }
        } else if let Some(capabilities) = row.get("capabilities") {
            let supported = |path: &[&str]| {
                let mut value = capabilities;
                for key in path {
                    value = value.get(*key)?;
                }
                value.get("supported")?.as_bool()
            };
            let adaptive = supported(&["thinking", "types", "adaptive"])
                .or_else(|| supported(&["thinking"]).map(|_| false));
            match supported(&["effort"]) {
                Some(true) => {
                    model.efforts = FULL_EFFORTS
                        .iter()
                        .filter(|e| supported(&["effort", e]) == Some(true))
                        .map(|s| (*s).to_owned())
                        .collect()
                }
                Some(false) => model.efforts.clear(),
                None => {}
            }
            if let Some(adaptive) = adaptive {
                model.thinking_modes = if !adaptive {
                    strings(&["off"])
                } else if known
                    .as_ref()
                    .is_some_and(|m| m.thinking_modes.iter().any(|s| s == "off"))
                {
                    strings(&["off", "adaptive"])
                } else {
                    strings(&["adaptive"])
                };
                model.default_thinking = if model.thinking_modes.iter().any(|s| s == "off") {
                    "off"
                } else {
                    "adaptive"
                }
                .into();
            }
        }
        models.push(model);
    }
    Ok(())
}

fn project_codex(value: &Value) -> Result<Vec<ModelInfo>> {
    let rows = value
        .get("models")
        .and_then(Value::as_array)
        .filter(|m| m.len() <= 1000)
        .ok_or_else(|| ProviderError::protocol("invalid subscription catalog"))?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        if row.get("visibility").and_then(Value::as_str) != Some("list") {
            continue;
        }
        let Some(id) = row
            .get("slug")
            .and_then(Value::as_str)
            .filter(|id| valid_model_id(id))
        else {
            continue;
        };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let mut model =
            profile(Provider::Chatgpt, id).unwrap_or_else(|| unknown(Provider::Chatgpt, id));
        model.profile_id = format!("{id}:responses-codex-catalog-v2");
        if let Some(label) = name(row, "display_name") {
            model.label = label.clone();
            model.short = label;
        }
        model.published_context_window = number(row, "context_window", 8192);
        model.context_window = Some(model.published_context_window.unwrap_or(32_768));
        // Codex lists no output ceiling: do not invent one on the wire.
        model.max_output_tokens = None;
        let levels = row
            .get("supported_reasoning_levels")
            .and_then(Value::as_array);
        let explicitly_supports_off = levels.is_some_and(|levels| {
            levels
                .iter()
                .any(|v| v.get("effort").and_then(Value::as_str) == Some("none"))
        });
        let mut seen_efforts = HashSet::new();
        model.efforts = levels
            .into_iter()
            .flatten()
            .filter_map(|v| v.get("effort").and_then(Value::as_str))
            .filter(|e| EFFORTS.contains(e) && seen_efforts.insert(*e))
            .map(str::to_owned)
            .collect();
        let supports_off = explicitly_supports_off || model.efforts.is_empty();
        model.thinking_modes = if model.efforts.is_empty() {
            strings(&["off"])
        } else if supports_off {
            strings(&["off", "adaptive"])
        } else {
            strings(&["adaptive"])
        };
        model.default_thinking = if supports_off { "off" } else { "adaptive" }.into();
        model.default_effort = row
            .get("default_reasoning_level")
            .and_then(Value::as_str)
            .filter(|e| model.efforts.iter().any(|v| v == e))
            .map(str::to_owned)
            .or_else(|| model.efforts.first().cloned())
            .unwrap_or_else(|| "high".into());
        model.supports_summary = row
            .get("supports_reasoning_summary_parameter")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        model.supports_verbosity = row
            .get("support_verbosity")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        result.push(model);
    }
    Ok(result)
}
