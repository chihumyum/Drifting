//! Model servers reached over OpenAI-compatible Chat Completions (in the
//! app 「自定义服务」): which addresses are accepted, and what a server says
//! about its models. Chat itself goes through the shared transport with
//! [`crate::chat`].
//!
//! This computer (`localhost`, `127.0.0.0/8`, `::1`) and the local network
//! (`10/8`, `172.16/12`, `192.168/16`, `*.local`) are accepted over `http`
//! or `https`. Anywhere else is a service on the internet, accepted over
//! `https` only (作者 2026-11-23, chihumyum/Drifting#3); plain `http` to it
//! is refused before any request.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use reqwest::Url;
use serde_json::{Value, json};

use crate::{HttpClient, ProviderError, Result};

const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODELS: usize = 500;
/// `/api/show` is asked about this many models at most.
const MAX_SHOWN: usize = 64;
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a local model may stay silent: loading a large model into memory
/// the first time can take minutes before the first byte (the providers'
/// client gives up after 90 s). Used for chat and 「测试连接」 alike.
pub const MODEL_WAIT: Duration = Duration::from_secs(300);
const MIN_CONTEXT: u64 = 256;
const MAX_CONTEXT: u64 = 100_000_000;

/// Where an accepted address is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    ThisComputer,
    LocalNetwork,
    /// Neither: a service on the internet, `https` only.
    Internet,
}

impl Reach {
    /// This computer or the local network.
    pub fn is_local(self) -> bool {
        self != Self::Internet
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AddressError {
    /// Not an http(s) address one can connect to.
    #[error("not an http address")]
    Invalid,
    /// An address on the internet over plain `http`.
    #[error("an address on the internet needs https")]
    NeedsHttps,
}

/// A parsed, accepted server address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalAddress {
    /// `scheme://host[:port][/path]` without a trailing `/` or `/v1`.
    pub base_url: String,
    /// What the settings show: `host[:port]` (a standard port left out),
    /// this computer as `localhost`.
    pub display: String,
    pub reach: Reach,
}

impl LocalAddress {
    /// What the author pasted. A missing scheme means `http://`.
    pub fn parse(raw: &str) -> std::result::Result<Self, AddressError> {
        let raw = raw.trim();
        if raw.is_empty() || raw.chars().any(char::is_whitespace) {
            return Err(AddressError::Invalid);
        }
        let with_scheme = if raw.contains("://") {
            raw.to_owned()
        } else {
            format!("http://{raw}")
        };
        let mut url = Url::parse(&with_scheme).map_err(|_| AddressError::Invalid)?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AddressError::Invalid);
        }
        let reach = reach(&url).ok_or(AddressError::Invalid)?;
        if reach == Reach::Internet && url.scheme() != "https" {
            return Err(AddressError::NeedsHttps);
        }
        let mut path = url.path().trim_end_matches('/').to_owned();
        if let Some(stripped) = path.strip_suffix("/v1") {
            path = stripped.trim_end_matches('/').to_owned();
        }
        url.set_path(&path);
        let base_url = url.as_str().trim_end_matches('/').to_owned();
        let host = match reach {
            Reach::ThisComputer => "localhost".to_owned(),
            Reach::LocalNetwork | Reach::Internet => url.host_str().unwrap_or_default().to_owned(),
        };
        let display = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        Ok(Self {
            base_url,
            display,
            reach,
        })
    }

    fn at(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }
}

/// Whether what was typed names a place on the internet, `http` or `https`:
/// the form shows the key field for it at once (作者 2026-11-24).
pub fn on_the_internet(raw: &str) -> bool {
    match LocalAddress::parse(raw) {
        Ok(address) => address.reach == Reach::Internet,
        Err(error) => error == AddressError::NeedsHttps,
    }
}

/// Where a URL's host is. `None` only without a host. This computer and the
/// local network are the same set `dr_platform::proxy` sends directly (no
/// proxy); everything else is the internet.
fn reach(url: &Url) -> Option<Reach> {
    let host = url.host_str()?;
    if let Some(v6) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return Some(if v6.parse::<Ipv6Addr>().is_ok_and(|ip| ip.is_loopback()) {
            Reach::ThisComputer
        } else {
            Reach::Internet
        });
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Some(ipv4_reach(ip));
    }
    let domain = host.trim_end_matches('.').to_ascii_lowercase();
    Some(if domain == "localhost" {
        Reach::ThisComputer
    } else if domain.len() > ".local".len()
        && domain.ends_with(".local")
        && !domain.starts_with('.')
    {
        Reach::LocalNetwork
    } else {
        Reach::Internet
    })
}

fn ipv4_reach(ip: Ipv4Addr) -> Reach {
    if ip.is_loopback() {
        Reach::ThisComputer
    } else if private(ip) {
        Reach::LocalNetwork
    } else {
        Reach::Internet
    }
}

/// Exactly 10/8, 172.16/12 and 192.168/16.
fn private(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

/// The transport's check for a frozen route: the same rule as the settings
/// form, so a hand-edited setting cannot widen it.
pub(crate) fn validate_endpoint(endpoint: &str) -> Result<()> {
    let url = Url::parse(endpoint).map_err(ProviderError::network)?;
    let refused = !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || match reach(&url) {
            None => true,
            Some(Reach::Internet) => url.scheme() != "https",
            Some(Reach::ThisComputer | Reach::LocalNetwork) => false,
        };
    if refused {
        return Err(ProviderError::new(
            dr_agent::ModelErrorCategory::Unsupported,
            false,
        ));
    }
    Ok(())
}

/// The software a server was recognized as, by an endpoint only it has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Software {
    Ollama,
    LmStudio,
    LlamaCpp,
}

impl Software {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
            Self::LlamaCpp => "llama.cpp",
        }
    }
}

/// A model the Agent can use: neither an embedding model nor one the
/// server says cannot call tools.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalModel {
    pub id: String,
    /// What the server reported, when it did. It is often the model's
    /// maximum, not what the server actually runs with.
    pub context_window: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Discovery {
    pub software: Option<Software>,
    pub models: Vec<LocalModel>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DiscoverError {
    /// Nothing answered.
    #[error("the server could not be reached")]
    Unreachable,
    /// The server wants a (different) key.
    #[error("the server refused the key")]
    Unauthorized,
    /// The server answered, but gave no model list.
    #[error("the server gave no model list")]
    NoList,
    /// The server gave its list, but every model on it is an embedding model
    /// or one the server says cannot use tools (or the list is empty).
    #[error("the server has no model that can use tools")]
    NoToolModels,
}

/// A model id as a server gives it or the author types it: trimmed, no
/// control characters, at most 256 bytes. `qwen3:14b`, `qwen/qwen3-30b`.
pub fn valid_model_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

fn get(http: &HttpClient, url: String, key: Option<&str>) -> reqwest::RequestBuilder {
    let request = http
        .raw()
        .get(http.destination(url))
        .header("accept", "application/json");
    match key {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

async fn json_body(response: reqwest::Response) -> Option<Value> {
    if !response.status().is_success() {
        return None;
    }
    crate::oauth::bounded_json(response, MAX_LIST_BYTES)
        .await
        .ok()
}

/// Is anything answering at this address with this key? Any reply but an
/// authentication refusal counts: a server without a model list is still up.
pub async fn check(
    http: &HttpClient,
    address: &LocalAddress,
    key: Option<&str>,
) -> std::result::Result<(), DiscoverError> {
    let response = get(http, address.at("/v1/models"), key)
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(|_| DiscoverError::Unreachable)?;
    match response.status().as_u16() {
        401 | 403 => Err(DiscoverError::Unauthorized),
        _ => Ok(()),
    }
}

/// Asks the server for its models (`/v1/models`), recognizes the software,
/// and reads what it says about each model's context and tools.
pub async fn discover(
    http: &HttpClient,
    address: &LocalAddress,
    key: Option<&str>,
) -> std::result::Result<Discovery, DiscoverError> {
    let response = get(http, address.at("/v1/models"), key)
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(|_| DiscoverError::Unreachable)?;
    match response.status().as_u16() {
        401 | 403 => return Err(DiscoverError::Unauthorized),
        200..=299 => {}
        _ => return Err(DiscoverError::NoList),
    }
    let list = json_body(response).await.ok_or(DiscoverError::NoList)?;
    let rows: Vec<&Value> = list
        .get("data")
        .and_then(Value::as_array)
        .ok_or(DiscoverError::NoList)?
        .iter()
        .take(MAX_MODELS)
        .collect();
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for row in &rows {
        let Some(id) = row.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if !valid_model_id(id) || !seen.insert(id.to_owned()) {
            continue;
        }
        found.push(Found {
            id: id.to_owned(),
            context: row_context(row),
            embedding: None,
            tools: None,
        });
    }
    let software = if rows
        .iter()
        .any(|row| row.get("owned_by").and_then(Value::as_str) == Some("llamacpp"))
    {
        Some(Software::LlamaCpp)
    } else if ollama(http, address, key).await {
        Some(Software::Ollama)
    } else if let Some(models) = lm_studio(http, address, key).await {
        for model in &mut found {
            if let Some(row) = models.get(&model.id) {
                model.embedding = row
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|kind| kind == "embeddings");
                if let Some(context) = number(row.get("max_context_length")) {
                    model.context = Some(context);
                }
            }
        }
        Some(Software::LmStudio)
    } else {
        None
    };
    match software {
        Some(Software::Ollama) => {
            for model in found.iter_mut().take(MAX_SHOWN) {
                show(http, address, key, model).await;
            }
        }
        Some(Software::LlamaCpp) => {
            if let Some(context) = llama_context(http, address, key).await {
                for model in &mut found {
                    model.context = Some(context);
                }
            }
        }
        _ => {}
    }
    let models: Vec<LocalModel> = found
        .into_iter()
        .filter(|model| {
            !model
                .embedding
                .unwrap_or_else(|| model.id.to_ascii_lowercase().contains("embed"))
                && model.tools != Some(false)
        })
        .map(|model| LocalModel {
            id: model.id,
            context_window: model.context,
        })
        .collect();
    if models.is_empty() {
        return Err(DiscoverError::NoToolModels);
    }
    Ok(Discovery { software, models })
}

struct Found {
    id: String,
    context: Option<u64>,
    /// `None`: the server did not say; the name decides.
    embedding: Option<bool>,
    /// `Some(false)` only when the server says the model has no tools.
    tools: Option<bool>,
}

fn number(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|n| (MIN_CONTEXT..=MAX_CONTEXT).contains(n))
}

/// Context fields some OpenAI-compatible servers put on `/v1/models` rows
/// (vLLM's `max_model_len`, llama.cpp's training size).
fn row_context(row: &Value) -> Option<u64> {
    number(row.get("max_model_len"))
        .or_else(|| number(row.get("context_length")))
        .or_else(|| number(row.get("max_context_length")))
        .or_else(|| number(row.get("meta").and_then(|meta| meta.get("n_ctx_train"))))
}

/// Ollama answers `GET /api/version` with `{"version": "…"}`.
async fn ollama(http: &HttpClient, address: &LocalAddress, key: Option<&str>) -> bool {
    let Ok(response) = get(http, address.at("/api/version"), key)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
    else {
        return false;
    };
    json_body(response)
        .await
        .is_some_and(|value| value.get("version").and_then(Value::as_str).is_some())
}

/// LM Studio's own `GET /api/v0/models` gives each model a `type` (`llm`,
/// `vlm`, `embeddings`) and its `max_context_length`.
async fn lm_studio(
    http: &HttpClient,
    address: &LocalAddress,
    key: Option<&str>,
) -> Option<HashMap<String, Value>> {
    let response = get(http, address.at("/api/v0/models"), key)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .ok()?;
    let value = json_body(response).await?;
    let rows = value.get("data")?.as_array()?;
    let typed = rows.iter().any(|row| {
        matches!(
            row.get("type").and_then(Value::as_str),
            Some("llm" | "vlm" | "embeddings")
        )
    });
    typed.then(|| {
        rows.iter()
            .filter_map(|row| Some((row.get("id")?.as_str()?.to_owned(), row.clone())))
            .collect()
    })
}

/// Ollama's `POST /api/show`: `capabilities` (`completion`, `tools`,
/// `embedding` …) and `model_info["<architecture>.context_length"]`.
async fn show(http: &HttpClient, address: &LocalAddress, key: Option<&str>, model: &mut Found) {
    let mut request = http
        .raw()
        .post(http.destination(address.at("/api/show")))
        .header("accept", "application/json")
        .json(&json!({"model": model.id}))
        .timeout(PROBE_TIMEOUT);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let Ok(response) = request.send().await else {
        return;
    };
    let Some(value) = json_body(response).await else {
        return;
    };
    if let Some(capabilities) = value.get("capabilities").and_then(Value::as_array) {
        let has = |name: &str| capabilities.iter().any(|c| c.as_str() == Some(name));
        model.embedding = Some(has("embedding") && !has("completion"));
        model.tools = Some(has("tools"));
    }
    if let Some(info) = value.get("model_info").and_then(Value::as_object) {
        let architecture = info.get("general.architecture").and_then(Value::as_str);
        let context = architecture
            .and_then(|arch| number(info.get(&format!("{arch}.context_length"))))
            .or_else(|| {
                info.iter()
                    .filter(|(name, _)| name.ends_with(".context_length"))
                    .find_map(|(_, value)| number(Some(value)))
            });
        if context.is_some() {
            model.context = context;
        }
    }
}

/// llama.cpp's `GET /props`: the context it actually runs with.
async fn llama_context(
    http: &HttpClient,
    address: &LocalAddress,
    key: Option<&str>,
) -> Option<u64> {
    let response = get(http, address.at("/props"), key)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .ok()?;
    let value = json_body(response).await?;
    number(
        value
            .get("default_generation_settings")
            .and_then(|settings| settings.get("n_ctx")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Four groups: this computer and the local network over `http` or
    /// `https`; the internet over `https`; the internet over `http` refused.
    #[test]
    fn the_internet_needs_https_and_this_network_takes_either() {
        for (raw, base, display, reach) in [
            (
                "http://localhost:11434",
                "http://localhost:11434",
                "localhost:11434",
                Reach::ThisComputer,
            ),
            (
                "localhost:1234",
                "http://localhost:1234",
                "localhost:1234",
                Reach::ThisComputer,
            ),
            (
                " http://127.0.0.1:8080/v1/ ",
                "http://127.0.0.1:8080",
                "localhost:8080",
                Reach::ThisComputer,
            ),
            (
                "http://[::1]:11434",
                "http://[::1]:11434",
                "localhost:11434",
                Reach::ThisComputer,
            ),
            (
                "http://192.168.1.20:11434",
                "http://192.168.1.20:11434",
                "192.168.1.20:11434",
                Reach::LocalNetwork,
            ),
            (
                "10.0.0.5:8000/proxy/v1",
                "http://10.0.0.5:8000/proxy",
                "10.0.0.5:8000",
                Reach::LocalNetwork,
            ),
            (
                "https://172.16.0.9",
                "https://172.16.0.9",
                "172.16.0.9",
                Reach::LocalNetwork,
            ),
            (
                "http://172.31.255.1:80",
                "http://172.31.255.1",
                "172.31.255.1",
                Reach::LocalNetwork,
            ),
            (
                "http://gpu-box.local:11434",
                "http://gpu-box.local:11434",
                "gpu-box.local:11434",
                Reach::LocalNetwork,
            ),
            (
                "https://api.example.com/v1",
                "https://api.example.com",
                "api.example.com",
                Reach::Internet,
            ),
            (
                "https://api.example.com:8443/proxy/v1/",
                "https://api.example.com:8443/proxy",
                "api.example.com:8443",
                Reach::Internet,
            ),
            (
                "https://API.Example.com:443",
                "https://api.example.com",
                "api.example.com",
                Reach::Internet,
            ),
            (
                "https://203.0.113.7",
                "https://203.0.113.7",
                "203.0.113.7",
                Reach::Internet,
            ),
            (
                "https://[2001:db8::1]",
                "https://[2001:db8::1]",
                "[2001:db8::1]",
                Reach::Internet,
            ),
        ] {
            let address = LocalAddress::parse(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
            assert_eq!(address.base_url, base, "{raw}");
            assert_eq!(address.display, display, "{raw}");
            assert_eq!(address.reach, reach, "{raw}");
            assert_eq!(address.reach.is_local(), reach != Reach::Internet);
            assert_eq!(on_the_internet(raw), reach == Reach::Internet, "{raw}");
            validate_endpoint(&format!("{}/v1/chat/completions", address.base_url)).unwrap();
        }
        // On the internet over plain http: refused, here and in the transport.
        for raw in [
            "http://api.example.com/v1",
            "api.example.com",
            "http://example.com:11434",
            "http://172.32.0.1",
            "http://172.15.0.1",
            "http://192.169.0.1",
            "http://11.0.0.1",
            "http://8.8.8.8",
            "http://[fe80::1]:11434",
            "http://[::ffff:203.0.113.7]",
            // Only `::1` counts as this computer, as for the proxy's rule.
            "http://[::ffff:192.168.1.20]:11434",
            "http://local",
            "http://.local",
            "http://intranet",
        ] {
            assert_eq!(
                LocalAddress::parse(raw),
                Err(AddressError::NeedsHttps),
                "{raw}"
            );
            assert!(on_the_internet(raw), "{raw}");
            assert!(validate_endpoint(raw).is_err(), "{raw}");
        }
        for raw in [
            "",
            "   ",
            "ftp://localhost:21",
            "http://user:pass@localhost:11434",
            "http://localhost:11434/?q=1",
            "http://localhost:11434/#top",
            "http://local host",
            "http://",
            "https://user:pass@api.example.com/v1",
            "https://api.example.com/v1?key=1",
            "https://api.example.com/v1#models",
        ] {
            assert_eq!(
                LocalAddress::parse(raw),
                Err(AddressError::Invalid),
                "{raw}"
            );
            assert!(!on_the_internet(raw), "{raw}");
        }
        assert!(validate_endpoint("http://user@localhost:11434/v1").is_err());
        assert!(validate_endpoint("https://user@api.example.com/v1").is_err());
        assert!(validate_endpoint("ftp://api.example.com/v1").is_err());
    }

    #[test]
    fn model_ids_keep_the_servers_own_spelling() {
        for id in [
            "qwen3:14b",
            "qwen/qwen3-30b-a3b",
            "gpt-oss-20b",
            "Llama 3.1",
        ] {
            assert!(valid_model_id(id), "{id}");
        }
        for id in ["", "  ", "a\nb", &"x".repeat(257)] {
            assert!(!valid_model_id(id), "{id:?}");
        }
    }
}
