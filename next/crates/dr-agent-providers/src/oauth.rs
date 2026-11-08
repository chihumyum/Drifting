//! ChatGPT's legacy Codex device flow, without Tauri or a second HTTP client.

use std::future::Future;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, watch};

use crate::credentials::{Credentials, MAX_TOKEN_BYTES, StoredTokens};
use crate::{ProviderError, Result};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CLIENT_VERSION: &str = "0.166.0";
pub const ORIGINATOR: &str = "codex_cli_rs";
const REFRESH_SKEW_MS: u64 = 5 * 60 * 1000;
const DEVICE_WINDOW_MS: u64 = 15 * 60 * 1000;
const MAX_RESPONSE: usize = 64 * 1024;

pub fn user_agent() -> String {
    format!(
        "codex_cli_rs/{CLIENT_VERSION} (Drifting/{})",
        env!("CARGO_PKG_VERSION")
    )
}

#[derive(Clone, Debug)]
pub struct OAuthEndpoints {
    pub usercode: String,
    pub device_token: String,
    pub token: String,
    pub verification: String,
    pub redirect_uri: String,
}

impl Default for OAuthEndpoints {
    fn default() -> Self {
        Self::at("https://auth.openai.com").expect("fixed OAuth origin")
    }
}

impl OAuthEndpoints {
    /// HTTPS in production; loopback HTTP permits a synthetic test service.
    pub fn at(origin: &str) -> Result<Self> {
        let parsed = reqwest::Url::parse(origin)
            .map_err(|_| ProviderError::protocol("invalid OAuth origin"))?;
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || (parsed.scheme() != "https"
                && !(parsed.scheme() == "http"
                    && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
        {
            return Err(ProviderError::protocol("OAuth requires HTTPS or loopback"));
        }
        let base = origin.trim_end_matches('/');
        Ok(Self {
            usercode: format!("{base}/api/accounts/deviceauth/usercode"),
            device_token: format!("{base}/api/accounts/deviceauth/token"),
            token: format!("{base}/oauth/token"),
            verification: format!("{base}/codex/device"),
            redirect_uri: format!("{base}/deviceauth/callback"),
        })
    }
}

#[derive(Clone)]
pub struct OAuthCancellation(Arc<watch::Sender<bool>>);

impl Default for OAuthCancellation {
    fn default() -> Self {
        Self(Arc::new(watch::channel(false).0))
    }
}

impl OAuthCancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    async fn cancelled(&self) {
        let mut rx = self.0.subscribe();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
    pub(crate) async fn run<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        tokio::select! { biased;
            _ = self.cancelled() => Err(ProviderError::cancelled()),
            result = future => result,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_url: String,
    pub expires_at_ms: u64,
    pub interval_ms: u64,
    // This is an ephemeral login capability, not application display state.
    #[serde(skip)]
    device_auth_id: String,
    #[serde(skip)]
    generation: u64,
}

impl std::fmt::Debug for DeviceCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceCode")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct Authorization {
    pub access_token: String,
    pub account_id: Option<String>,
}

impl std::fmt::Debug for Authorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Authorization").finish_non_exhaustive()
    }
}

impl Authorization {
    pub fn catalog_identity(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.access_token.as_bytes());
        hash.update([0]);
        hash.update(self.account_id.as_deref().unwrap_or_default().as_bytes());
        format!("{:x}", hash.finalize())
    }
    pub fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let request = request
            .bearer_auth(&self.access_token)
            .header("OpenAI-Beta", "responses=experimental")
            .header("originator", ORIGINATOR)
            .header(reqwest::header::USER_AGENT, user_agent());
        match &self.account_id {
            Some(id) => request.header("ChatGPT-Account-Id", id),
            None => request,
        }
    }
}

/// The old native transport did not send a session header. Keep that wire
/// contract; session identity remains in M27 rather than an invented header.
pub fn apply_request_headers(
    request: reqwest::RequestBuilder,
    authorization: &Authorization,
    _session: &str,
) -> reqwest::RequestBuilder {
    authorization.apply(request)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct AccountSummary {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Clone)]
pub struct OAuth {
    credentials: Credentials,
    endpoints: OAuthEndpoints,
    generation: Arc<AtomicU64>,
    refresh: Arc<Mutex<()>>,
}

impl OAuth {
    pub fn new(credentials: Credentials, endpoints: OAuthEndpoints) -> Self {
        Self {
            credentials,
            endpoints,
            generation: Arc::new(AtomicU64::new(0)),
            refresh: Arc::default(),
        }
    }

    pub async fn start(
        &self,
        client: &reqwest::Client,
        cancel: &OAuthCancellation,
    ) -> Result<DeviceCode> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let payload = cancel
            .run(async {
                let response = client
                    .post(&self.endpoints.usercode)
                    .header("accept", "application/json")
                    .header("user-agent", user_agent())
                    .timeout(Duration::from_secs(30))
                    .json(&json!({"client_id":CLIENT_ID}))
                    .send()
                    .await
                    .map_err(ProviderError::network)?;
                checked_json(response, MAX_RESPONSE).await
            })
            .await?;
        Ok(DeviceCode {
            user_code: bounded(payload.get("user_code"), 1024)
                .or_else(|| bounded(payload.get("usercode"), 1024))
                .ok_or_else(invalid)?,
            device_auth_id: bounded(payload.get("device_auth_id"), 1024).ok_or_else(invalid)?,
            verification_url: self.endpoints.verification.clone(),
            interval_ms: interval_ms(payload.get("interval")),
            expires_at_ms: now_ms().saturating_add(DEVICE_WINDOW_MS),
            generation,
        })
    }

    /// Resolves only after token exchange and durable credential storage.
    /// Cancelling drops an in-flight HTTP request. Once platform storage starts,
    /// the blocking operation settles under a generation fence and I/O lease.
    pub async fn complete(
        &self,
        client: &reqwest::Client,
        device: &DeviceCode,
        cancel: &OAuthCancellation,
    ) -> Result<AccountSummary> {
        if device.device_auth_id.is_empty() {
            return Err(invalid());
        }
        loop {
            self.check_generation(device.generation)?;
            let now = now_ms();
            if now >= device.expires_at_ms {
                return Err(ProviderError::protocol("OAuth device code expired"));
            }
            cancel
                .run(async {
                    tokio::time::sleep(Duration::from_millis(
                        device.interval_ms.min(device.expires_at_ms - now),
                    ))
                    .await;
                    Ok(())
                })
                .await?;
            // Check after sleeping too: never poll after expiry.
            if now_ms() >= device.expires_at_ms {
                return Err(ProviderError::protocol("OAuth device code expired"));
            }
            self.check_generation(device.generation)?;
            let response = cancel.run(async {
                client.post(&self.endpoints.device_token).header("accept", "application/json")
                    .header("user-agent", user_agent()).timeout(Duration::from_secs(30))
                    .json(&json!({"device_auth_id":device.device_auth_id,"user_code":device.user_code}))
                    .send().await.map_err(ProviderError::network)
            }).await?;
            if matches!(response.status().as_u16(), 403 | 404) {
                continue;
            }
            let grant = cancel.run(checked_json(response, MAX_RESPONSE)).await?;
            let code =
                bounded(grant.get("authorization_code"), MAX_TOKEN_BYTES).ok_or_else(invalid)?;
            let verifier =
                bounded(grant.get("code_verifier"), MAX_TOKEN_BYTES).ok_or_else(invalid)?;
            let tokens = cancel
                .run(async {
                    let response = client
                        .post(&self.endpoints.token)
                        .header("accept", "application/json")
                        .header("user-agent", user_agent())
                        .timeout(Duration::from_secs(30))
                        .form(&[
                            ("grant_type", "authorization_code"),
                            ("client_id", CLIENT_ID),
                            ("code", code.as_str()),
                            ("code_verifier", verifier.as_str()),
                            ("redirect_uri", self.endpoints.redirect_uri.as_str()),
                        ])
                        .send()
                        .await
                        .map_err(ProviderError::network)?;
                    tokens_from_payload(
                        &checked_json(response, MAX_RESPONSE).await?,
                        None,
                        now_ms(),
                    )
                })
                .await?;
            let _guard = cancel.run(async { Ok(self.refresh.lock().await) }).await?;
            self.check_generation(device.generation)?;
            if cancel.is_cancelled() {
                return Err(ProviderError::cancelled());
            }
            // The blocking store operation retains its lease even if the
            // caller drops this future; logout invalidates its generation.
            self.credentials
                .save_tokens_if_current(&tokens, self.generation.clone(), device.generation)
                .await?;
            return Ok(account_summary(&tokens));
        }
    }

    pub async fn authorization(
        &self,
        client: &reqwest::Client,
        force_refresh: bool,
        cancel: &OAuthCancellation,
    ) -> Result<Authorization> {
        self.resolve_authorization(client, force_refresh, cancel)
            .await
    }

    pub async fn force_refresh(
        &self,
        client: &reqwest::Client,
        cancel: &OAuthCancellation,
    ) -> Result<Authorization> {
        self.resolve_authorization(client, true, cancel).await
    }

    async fn resolve_authorization(
        &self,
        client: &reqwest::Client,
        force_refresh: bool,
        cancel: &OAuthCancellation,
    ) -> Result<Authorization> {
        if cancel.is_cancelled() {
            return Err(ProviderError::cancelled());
        }
        let generation = self.generation.load(Ordering::SeqCst);
        let before = self
            .credentials
            .tokens()
            .await?
            .ok_or_else(|| ProviderError::from_status(401, ""))?;
        self.check_generation(generation)?;
        if !force_refresh && before.expires_at_ms > now_ms().saturating_add(REFRESH_SKEW_MS) {
            return Ok(authorization_from(&before));
        }
        let _guard = cancel.run(async { Ok(self.refresh.lock().await) }).await?;
        let current = self
            .credentials
            .tokens()
            .await?
            .ok_or_else(|| ProviderError::from_status(401, ""))?;
        self.check_generation(generation)?;
        if current.access_token != before.access_token
            || (!force_refresh && current.expires_at_ms > now_ms().saturating_add(REFRESH_SKEW_MS))
        {
            return Ok(authorization_from(&current));
        }
        let refreshed = cancel
            .run(async {
                let response = client
                    .post(&self.endpoints.token)
                    .header("accept", "application/json")
                    .header("user-agent", user_agent())
                    .timeout(Duration::from_secs(30))
                    .form(&[
                        ("grant_type", "refresh_token"),
                        ("client_id", CLIENT_ID),
                        ("refresh_token", current.refresh_token.as_str()),
                    ])
                    .send()
                    .await
                    .map_err(ProviderError::network)?;
                if matches!(response.status().as_u16(), 400 | 401) {
                    return Err(ProviderError::from_status(401, ""));
                }
                tokens_from_payload(
                    &checked_json(response, MAX_RESPONSE).await?,
                    Some(&current),
                    now_ms(),
                )
            })
            .await?;
        self.check_generation(generation)?;
        self.credentials
            .save_tokens_if_current(&refreshed, self.generation.clone(), generation)
            .await?;
        Ok(authorization_from(&refreshed))
    }

    pub async fn status(&self) -> Result<Option<AccountSummary>> {
        Ok(self
            .credentials
            .tokens()
            .await?
            .as_ref()
            .map(account_summary))
    }

    pub async fn logout(&self) -> Result<()> {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _guard = self.refresh.lock().await;
        self.credentials.clear_tokens().await
    }

    fn check_generation(&self, generation: u64) -> Result<()> {
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(ProviderError::cancelled());
        }
        Ok(())
    }
}

pub(crate) async fn checked_json(response: reqwest::Response, max: usize) -> Result<Value> {
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(ProviderError::from_status(status, ""));
    }
    bounded_json(response, max).await
}

pub(crate) async fn bounded_json(response: reqwest::Response, max: usize) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(ProviderError::network)?;
        if bytes.len().saturating_add(chunk.len()) > max {
            return Err(ProviderError::protocol("provider response too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

fn invalid() -> ProviderError {
    ProviderError::protocol("invalid OAuth response")
}

fn bounded(value: Option<&Value>, max: usize) -> Option<String> {
    value?
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= max)
        .map(str::to_owned)
}

fn interval_ms(value: Option<&Value>) -> u64 {
    let seconds = value.and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().parse().ok()));
    seconds
        .filter(|s| *s > 0)
        .map(|s| s.saturating_mul(1000))
        .unwrap_or(5000)
        .clamp(1000, 30_000)
}

fn tokens_from_payload(
    value: &Value,
    previous: Option<&StoredTokens>,
    now: u64,
) -> Result<StoredTokens> {
    let access_token = bounded(value.get("access_token"), MAX_TOKEN_BYTES).ok_or_else(invalid)?;
    let seconds = value
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|s| *s > 0 && *s <= 366 * 24 * 60 * 60)
        .ok_or_else(invalid)?;
    let refresh_token = bounded(value.get("refresh_token"), MAX_TOKEN_BYTES)
        .or_else(|| previous.map(|t| t.refresh_token.clone()))
        .ok_or_else(invalid)?;
    let id_token = bounded(value.get("id_token"), MAX_TOKEN_BYTES)
        .or_else(|| previous.and_then(|t| t.id_token.clone()));
    Ok(StoredTokens {
        access_token,
        refresh_token,
        id_token,
        expires_at_ms: now.saturating_add(seconds.saturating_mul(1000)),
    })
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn claims(token: &str) -> Option<Value> {
    let part = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(part)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(part))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn account_id(value: &Value) -> Option<String> {
    bounded(
        value
            .get("https://api.openai.com/auth")
            .and_then(|v| v.get("chatgpt_account_id"))
            .or_else(|| value.get("chatgpt_account_id")),
        200,
    )
    .or_else(|| {
        value
            .get("organizations")?
            .as_array()?
            .iter()
            .find_map(|o| bounded(o.get("id"), 200))
    })
}

fn authorization_from(tokens: &StoredTokens) -> Authorization {
    Authorization {
        access_token: tokens.access_token.clone(),
        account_id: claims(&tokens.access_token)
            .as_ref()
            .and_then(account_id)
            .or_else(|| {
                tokens
                    .id_token
                    .as_deref()
                    .and_then(claims)
                    .as_ref()
                    .and_then(account_id)
            }),
    }
}

pub fn account_summary(tokens: &StoredTokens) -> AccountSummary {
    let id = tokens.id_token.as_deref().and_then(claims);
    let access = claims(&tokens.access_token);
    let first = |f: fn(&Value) -> Option<String>| {
        id.as_ref()
            .and_then(f)
            .or_else(|| access.as_ref().and_then(f))
    };
    AccountSummary {
        account_id: first(account_id),
        email: first(|v| {
            bounded(
                v.get("email")
                    .or_else(|| v.get("https://api.openai.com/profile")?.get("email")),
                320,
            )
        }),
        plan: first(|v| {
            bounded(
                v.get("https://api.openai.com/auth")?
                    .get("chatgpt_plan_type"),
                64,
            )
        }),
    }
}
