//! ChatGPT subscription (Codex) credential host for the General Agent.
//!
//! Experimental and unsupported route. It signs the author in with the same
//! device-code flow the official Codex CLI uses, keeps the OAuth tokens in the
//! native secure store under a renderer-inaccessible key, and lets the native
//! Responses transport send General Agent requests to the ChatGPT Codex
//! backend with that account. The renderer only ever sees sign-in state and
//! non-secret account claims.
//!
//! The backend accepts requests that look like the official CLI, so this host
//! reuses the CLI's public OAuth client id and `originator`. OpenAI publishes
//! no third-party contract for this path; it can stop working without notice
//! and the account carrying that risk is the author's own.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::future::{AbortHandle, Abortable};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::secure_storage;

pub const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
/// Native-only secure-storage key; `secure_storage` refuses renderer access to it.
const TOKEN_KEY_ID: &str = "oauth.openai-codex";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const DEVICE_USERCODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_VERIFY_URL: &str = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const ORIGINATOR: &str = "codex_cli_rs";
const CLIENT_USER_AGENT: &str = "codex_cli_rs/0.0.0 (Drifting)";
const REFRESH_SKEW_MS: u64 = 5 * 60 * 1_000;
/// Local device-code window. The poll loop never issues a request past it,
/// matching the official CLI's fallback when the server window is unreadable.
const DEVICE_WINDOW_MS: u64 = 15 * 60 * 1_000;
const DEVICE_MIN_INTERVAL_MS: u64 = 1_000;
const DEVICE_MAX_INTERVAL_MS: u64 = 30_000;
const DEVICE_DEFAULT_INTERVAL_MS: u64 = 5_000;
const OAUTH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OAUTH_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOKEN_CHARS: usize = 32 * 1024;
const MAX_TOKEN_LIFETIME_SECONDS: u64 = 366 * 24 * 60 * 60;

static ATTEMPT_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct StoredTokens {
    access_token: String,
    refresh_token: String,
    expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id_token: Option<String>,
}

/// Non-secret account claims the renderer may display.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountSummary {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexLoginPhase {
    AwaitingAuthorization,
    Exchanging,
    Authenticated,
    Failed,
    Cancelled,
}

impl CodexLoginPhase {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            CodexLoginPhase::Authenticated | CodexLoginPhase::Failed | CodexLoginPhase::Cancelled
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginProjection {
    pub attempt_id: String,
    pub phase: CodexLoginPhase,
    /// One-time code the author types at `verification_url`.
    pub user_code: String,
    pub verification_url: String,
    pub expires_at_ms: u64,
    /// Bounded failure class; never provider text.
    pub failure: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubscriptionStatus {
    pub signed_in: bool,
    pub account: Option<CodexAccountSummary>,
    pub login: Option<CodexLoginProjection>,
}

struct LoginAttempt {
    projection: CodexLoginProjection,
    abort: Option<AbortHandle>,
}

#[derive(Default)]
pub struct CodexOAuthState {
    login: Mutex<Option<LoginAttempt>>,
    /// Serializes token refreshes so concurrent turns rotate one refresh token once.
    refresh: tokio::sync::Mutex<()>,
    client: OnceLock<reqwest::Client>,
}

impl CodexOAuthState {
    fn client(&self) -> Result<reqwest::Client, String> {
        if let Some(client) = self.client.get() {
            return Ok(client.clone());
        }
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "CODEX_TRANSPORT_UNAVAILABLE: native HTTP client could not start")?;
        let _ = self.client.set(client.clone());
        Ok(client)
    }
}

impl Drop for CodexOAuthState {
    fn drop(&mut self) {
        cancel_active(self);
    }
}

/// Access token plus the account routing claim the Codex backend expects.
pub(crate) struct CodexAuthorization {
    access_token: String,
    account_id: Option<String>,
}

struct DeviceAuthorization {
    device_auth_id: String,
    user_code: String,
    interval_ms: u64,
    expires_at_ms: u64,
}

struct DeviceGrant {
    authorization_code: String,
    code_verifier: String,
}

#[tauri::command]
pub async fn codex_oauth_start(
    app: AppHandle,
    state: State<'_, CodexOAuthState>,
) -> Result<CodexLoginProjection, String> {
    let client = state.client()?;
    cancel_active(&state);
    let device = start_device_authorization(&client).await?;
    let attempt_id = format!(
        "codex-login-{}-{}",
        now_ms(),
        ATTEMPT_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let projection = CodexLoginProjection {
        attempt_id: attempt_id.clone(),
        phase: CodexLoginPhase::AwaitingAuthorization,
        user_code: device.user_code.clone(),
        verification_url: DEVICE_VERIFY_URL.into(),
        expires_at_ms: device.expires_at_ms,
        failure: None,
    };
    let (abort, registration) = AbortHandle::new_pair();
    {
        let mut login = state
            .login
            .lock()
            .map_err(|_| "CODEX_LOGIN_UNAVAILABLE: login state is unavailable")?;
        *login = Some(LoginAttempt {
            projection: projection.clone(),
            abort: Some(abort),
        });
    }

    let task_app = app.clone();
    let task_id = attempt_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = Abortable::new(
            complete_device_login(&task_app, &client, &device, &task_id),
            registration,
        )
        .await;
        match outcome {
            Ok(Ok(())) => set_login(&task_app, &task_id, |projection| {
                projection.phase = CodexLoginPhase::Authenticated;
            }),
            Ok(Err(failure)) => set_login(&task_app, &task_id, |projection| {
                projection.phase = CodexLoginPhase::Failed;
                projection.failure = Some(failure);
            }),
            // Cancellation already projected its own terminal phase.
            Err(_) => {}
        }
    });
    Ok(projection)
}

#[tauri::command]
pub async fn codex_oauth_status(
    app: AppHandle,
    state: State<'_, CodexOAuthState>,
) -> Result<CodexSubscriptionStatus, String> {
    let tokens = read_tokens(&app).await?;
    let login = state
        .login
        .lock()
        .map_err(|_| "CODEX_LOGIN_UNAVAILABLE: login state is unavailable")?
        .as_ref()
        .map(|attempt| attempt.projection.clone());
    Ok(CodexSubscriptionStatus {
        signed_in: tokens.is_some(),
        account: tokens.as_ref().map(account_summary),
        login,
    })
}

#[tauri::command]
pub fn codex_oauth_cancel(state: State<'_, CodexOAuthState>) -> Result<bool, String> {
    Ok(cancel_active(&state))
}

#[tauri::command]
pub async fn codex_oauth_logout(
    app: AppHandle,
    state: State<'_, CodexOAuthState>,
) -> Result<bool, String> {
    cancel_active(&state);
    if let Ok(mut login) = state.login.lock() {
        *login = None;
    }
    let key_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        secure_storage::remove_secret(&key_app, TOKEN_KEY_ID)
    })
    .await
    .map_err(|_| "CODEX_CREDENTIAL_UNAVAILABLE: secure storage worker failed")?
    .map_err(|_| "CODEX_CREDENTIAL_UNAVAILABLE: ChatGPT sign-in could not be removed")?;
    Ok(true)
}

/// Resolve a usable access token, refreshing under the shared lease when the
/// stored token is near expiry or the caller saw it rejected.
pub(crate) async fn authorization(
    app: &AppHandle,
    force_refresh: bool,
) -> Result<CodexAuthorization, String> {
    let tokens = require_tokens(app).await?;
    if !force_refresh && !needs_refresh(&tokens, now_ms()) {
        return Ok(authorization_from(&tokens));
    }
    let state = app.state::<CodexOAuthState>();
    let client = state.client()?;
    let _lease = state.refresh.lock().await;
    // Another turn may have rotated the credential while this one waited.
    let current = require_tokens(app).await?;
    if current.access_token != tokens.access_token
        || (!force_refresh && !needs_refresh(&current, now_ms()))
    {
        return Ok(authorization_from(&current));
    }
    let refreshed = refresh_tokens(&client, &current).await?;
    write_tokens(app, &refreshed).await.map_err(|_| {
        "CODEX_CREDENTIAL_UNAVAILABLE: refreshed ChatGPT sign-in could not be saved"
    })?;
    Ok(authorization_from(&refreshed))
}

/// Apply the bearer token and the client identity the Codex backend expects.
pub(crate) fn apply_request_headers(
    builder: reqwest::RequestBuilder,
    authorization: &CodexAuthorization,
) -> reqwest::RequestBuilder {
    let mut builder = builder
        .bearer_auth(&authorization.access_token)
        .header("OpenAI-Beta", "responses=experimental")
        .header("originator", ORIGINATOR)
        .header(USER_AGENT, CLIENT_USER_AGENT);
    if let Some(account_id) = &authorization.account_id {
        builder = builder.header("ChatGPT-Account-Id", account_id);
    }
    builder
}

async fn complete_device_login(
    app: &AppHandle,
    client: &reqwest::Client,
    device: &DeviceAuthorization,
    attempt_id: &str,
) -> Result<(), String> {
    let grant = poll_device_authorization(client, device).await?;
    set_login(app, attempt_id, |projection| {
        projection.phase = CodexLoginPhase::Exchanging;
    });
    let tokens = exchange_device_code(client, &grant).await?;
    write_tokens(app, &tokens)
        .await
        .map_err(|_| "storage_failed".to_string())?;
    Ok(())
}

async fn start_device_authorization(
    client: &reqwest::Client,
) -> Result<DeviceAuthorization, String> {
    let response = client
        .post(DEVICE_USERCODE_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(USER_AGENT, CLIENT_USER_AGENT)
        .timeout(OAUTH_TIMEOUT)
        .json(&serde_json::json!({ "client_id": CLIENT_ID }))
        .send()
        .await
        .map_err(|_| "CODEX_LOGIN_FAILED: network_failed".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "CODEX_LOGIN_FAILED: provider_rejected ({})",
            response.status().as_u16()
        ));
    }
    let payload = read_bounded_json(response)
        .await
        .map_err(|failure| format!("CODEX_LOGIN_FAILED: {failure}"))?;
    let device_auth_id = bounded_string(payload.get("device_auth_id"), 1_024)
        .ok_or_else(|| "CODEX_LOGIN_FAILED: invalid_response".to_string())?;
    // The official decoder accepts both spellings.
    let user_code = bounded_string(payload.get("user_code"), 1_024)
        .or_else(|| bounded_string(payload.get("usercode"), 1_024))
        .ok_or_else(|| "CODEX_LOGIN_FAILED: invalid_response".to_string())?;
    Ok(DeviceAuthorization {
        device_auth_id,
        user_code,
        interval_ms: interval_ms(payload.get("interval")),
        expires_at_ms: now_ms().saturating_add(DEVICE_WINDOW_MS),
    })
}

/// Poll until the browser approval lands. 403 and 404 mean "still pending", as
/// in the official CLI; anything else is a hard rejection. The loop never sends
/// a request once the local window has elapsed.
async fn poll_device_authorization(
    client: &reqwest::Client,
    device: &DeviceAuthorization,
) -> Result<DeviceGrant, String> {
    loop {
        let now = now_ms();
        if now >= device.expires_at_ms {
            return Err("expired".into());
        }
        let wait = device.interval_ms.min(device.expires_at_ms - now);
        tokio::time::sleep(Duration::from_millis(wait)).await;
        let response = client
            .post(DEVICE_TOKEN_URL)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(USER_AGENT, CLIENT_USER_AGENT)
            .timeout(OAUTH_TIMEOUT)
            .json(&serde_json::json!({
                "device_auth_id": device.device_auth_id,
                "user_code": device.user_code,
            }))
            .send()
            .await
            .map_err(|_| "network_failed".to_string())?;
        match response.status().as_u16() {
            200 => {
                let payload = read_bounded_json(response).await?;
                let authorization_code =
                    bounded_string(payload.get("authorization_code"), MAX_TOKEN_CHARS)
                        .ok_or_else(|| "invalid_response".to_string())?;
                let code_verifier = bounded_string(payload.get("code_verifier"), MAX_TOKEN_CHARS)
                    .ok_or_else(|| "invalid_response".to_string())?;
                return Ok(DeviceGrant {
                    authorization_code,
                    code_verifier,
                });
            }
            403 | 404 => continue,
            _ => return Err("provider_rejected".into()),
        }
    }
}

/// The device flow returns a server-issued PKCE verifier and pins its own
/// redirect URI, so it never shares the loopback exchange used elsewhere.
async fn exchange_device_code(
    client: &reqwest::Client,
    grant: &DeviceGrant,
) -> Result<StoredTokens, String> {
    let response = client
        .post(TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, CLIENT_USER_AGENT)
        .timeout(OAUTH_TIMEOUT)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", grant.authorization_code.as_str()),
            ("code_verifier", grant.code_verifier.as_str()),
            ("redirect_uri", DEVICE_REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|_| "network_failed".to_string())?;
    if !response.status().is_success() {
        return Err("provider_rejected".into());
    }
    let payload = read_bounded_json(response).await?;
    tokens_from_payload(&payload, None, now_ms())
}

async fn refresh_tokens(
    client: &reqwest::Client,
    tokens: &StoredTokens,
) -> Result<StoredTokens, String> {
    let response = client
        .post(TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, CLIENT_USER_AGENT)
        .timeout(OAUTH_TIMEOUT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", tokens.refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "CODEX_REFRESH_FAILED: network_failed".to_string())?;
    let status = response.status().as_u16();
    if matches!(status, 400 | 401) {
        return Err(
            "CODEX_CREDENTIAL_EXPIRED: the ChatGPT sign-in is no longer valid; sign in again"
                .into(),
        );
    }
    if !(200..300).contains(&status) {
        return Err(format!(
            "CODEX_REFRESH_FAILED: ChatGPT token refresh returned HTTP {status}"
        ));
    }
    let payload = read_bounded_json(response)
        .await
        .map_err(|failure| format!("CODEX_REFRESH_FAILED: {failure}"))?;
    tokens_from_payload(&payload, Some(tokens), now_ms())
        .map_err(|failure| format!("CODEX_REFRESH_FAILED: {failure}"))
}

/// Guard a token response before it may replace the stored authority: a
/// missing access token or expiry never overwrites a still-working record.
fn tokens_from_payload(
    payload: &serde_json::Value,
    previous: Option<&StoredTokens>,
    now: u64,
) -> Result<StoredTokens, String> {
    let access_token = bounded_string(payload.get("access_token"), MAX_TOKEN_CHARS)
        .ok_or_else(|| "invalid_response".to_string())?;
    let expires_in = payload
        .get("expires_in")
        .and_then(serde_json::Value::as_u64)
        .filter(|seconds| *seconds > 0 && *seconds <= MAX_TOKEN_LIFETIME_SECONDS)
        .ok_or_else(|| "invalid_response".to_string())?;
    let refresh_token = bounded_string(payload.get("refresh_token"), MAX_TOKEN_CHARS)
        .or_else(|| previous.map(|tokens| tokens.refresh_token.clone()))
        .ok_or_else(|| "invalid_response".to_string())?;
    let id_token = bounded_string(payload.get("id_token"), MAX_TOKEN_CHARS)
        .or_else(|| previous.and_then(|tokens| tokens.id_token.clone()));
    Ok(StoredTokens {
        access_token,
        refresh_token,
        expires_at_ms: now.saturating_add(expires_in.saturating_mul(1_000)),
        id_token,
    })
}

fn needs_refresh(tokens: &StoredTokens, now: u64) -> bool {
    tokens.expires_at_ms <= now.saturating_add(REFRESH_SKEW_MS)
}

fn authorization_from(tokens: &StoredTokens) -> CodexAuthorization {
    CodexAuthorization {
        access_token: tokens.access_token.clone(),
        account_id: account_id_from_tokens(tokens),
    }
}

async fn require_tokens(app: &AppHandle) -> Result<StoredTokens, String> {
    read_tokens(app)
        .await?
        .ok_or_else(|| "CODEX_CREDENTIAL_MISSING: no ChatGPT subscription is signed in".to_string())
}

/// A malformed stored record reads as signed out; signing in again replaces it.
async fn read_tokens(app: &AppHandle) -> Result<Option<StoredTokens>, String> {
    let key_app = app.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || {
        secure_storage::read_secret(&key_app, TOKEN_KEY_ID)
    })
    .await
    .map_err(|_| "CODEX_CREDENTIAL_UNAVAILABLE: secure storage worker failed")?
    .map_err(|_| "CODEX_CREDENTIAL_UNAVAILABLE: ChatGPT sign-in could not be read")?;
    Ok(raw.and_then(|raw| serde_json::from_str::<StoredTokens>(&raw).ok()))
}

async fn write_tokens(app: &AppHandle, tokens: &StoredTokens) -> Result<(), String> {
    let serialized = serde_json::to_string(tokens).map_err(|_| "storage_failed".to_string())?;
    let key_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        secure_storage::write_secret(&key_app, TOKEN_KEY_ID, &serialized)
    })
    .await
    .map_err(|_| "storage_failed".to_string())?
    .map_err(|_| "storage_failed".to_string())
}

fn set_login(app: &AppHandle, attempt_id: &str, update: impl FnOnce(&mut CodexLoginProjection)) {
    let state = app.state::<CodexOAuthState>();
    let Ok(mut login) = state.login.lock() else {
        return;
    };
    let Some(attempt) = login.as_mut() else {
        return;
    };
    if attempt.projection.attempt_id != attempt_id {
        return;
    }
    update(&mut attempt.projection);
    if attempt.projection.phase.is_terminal() {
        attempt.abort = None;
    }
}

fn cancel_active(state: &CodexOAuthState) -> bool {
    let Ok(mut login) = state.login.lock() else {
        return false;
    };
    let Some(attempt) = login.as_mut() else {
        return false;
    };
    let Some(abort) = attempt.abort.take() else {
        return false;
    };
    abort.abort();
    attempt.projection.phase = CodexLoginPhase::Cancelled;
    true
}

async fn read_bounded_json(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|_| "network_failed".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > MAX_OAUTH_RESPONSE_BYTES {
            return Err("invalid_response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_response".into())
}

fn bounded_string(value: Option<&serde_json::Value>, max_chars: usize) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= max_chars)
        .map(str::to_owned)
}

/// The device endpoint reports `interval` in seconds, as a number or a string.
fn interval_ms(value: Option<&serde_json::Value>) -> u64 {
    let seconds = match value {
        Some(serde_json::Value::Number(number)) => number.as_u64(),
        Some(serde_json::Value::String(text)) => text.trim().parse::<u64>().ok(),
        _ => None,
    };
    seconds
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.saturating_mul(1_000))
        .unwrap_or(DEVICE_DEFAULT_INTERVAL_MS)
        .clamp(DEVICE_MIN_INTERVAL_MS, DEVICE_MAX_INTERVAL_MS)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn account_summary(tokens: &StoredTokens) -> CodexAccountSummary {
    let id_claims = tokens.id_token.as_deref().and_then(jwt_claims);
    let access_claims = jwt_claims(&tokens.access_token);
    let first = |read: fn(&serde_json::Value) -> Option<String>| {
        id_claims
            .as_ref()
            .and_then(read)
            .or_else(|| access_claims.as_ref().and_then(read))
    };
    CodexAccountSummary {
        account_id: first(chatgpt_account_id),
        email: first(profile_email),
        plan: first(plan_type),
    }
}

fn account_id_from_tokens(tokens: &StoredTokens) -> Option<String> {
    jwt_claims(&tokens.access_token)
        .as_ref()
        .and_then(chatgpt_account_id)
        .or_else(|| {
            tokens
                .id_token
                .as_deref()
                .and_then(jwt_claims)
                .as_ref()
                .and_then(chatgpt_account_id)
        })
}

/// Decode the unsigned payload of a JWT for routing claims. Signatures are not
/// checked: these claims only shape request headers and a settings label.
fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let bytes = engine
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.is_object().then_some(value)
}

/// The account id must come from OpenAI's account claims; a bare `sub` is not
/// a ChatGPT account id and is never sent as one.
fn chatgpt_account_id(claims: &serde_json::Value) -> Option<String> {
    claims
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .or_else(|| claims.get("chatgpt_account_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .map(str::to_owned)
        .or_else(|| {
            claims
                .get("organizations")?
                .as_array()?
                .iter()
                .find_map(|organization| organization.get("id")?.as_str())
                .map(str::trim)
                .filter(|id| !id.is_empty() && id.len() <= 200)
                .map(str::to_owned)
        })
}

fn profile_email(claims: &serde_json::Value) -> Option<String> {
    claims
        .get("email")
        .or_else(|| {
            claims
                .get("https://api.openai.com/profile")
                .and_then(|profile| profile.get("email"))
        })
        .and_then(serde_json::Value::as_str)
        .filter(|email| !email.is_empty() && email.len() <= 320)
        .map(str::to_owned)
}

fn plan_type(claims: &serde_json::Value) -> Option<String> {
    claims
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_plan_type"))
        .and_then(serde_json::Value::as_str)
        .filter(|plan| !plan.is_empty() && plan.len() <= 64)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(payload: serde_json::Value) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.{}",
            engine.encode(br#"{"alg":"none"}"#),
            engine.encode(payload.to_string().as_bytes()),
            engine.encode(b"signature")
        )
    }

    fn tokens(access_token: String, id_token: Option<String>) -> StoredTokens {
        StoredTokens {
            access_token,
            refresh_token: "refresh-1".into(),
            expires_at_ms: 10_000,
            id_token,
        }
    }

    #[test]
    fn reads_account_claims_from_openai_namespaced_jwt_fields() {
        let access = jwt(serde_json::json!({
            "sub": "user-sub",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_123",
                "chatgpt_plan_type": "plus"
            }
        }));
        let id = jwt(serde_json::json!({
            "email": "author@example.com",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct_123" }
        }));
        let stored = tokens(access, Some(id));
        assert_eq!(
            account_summary(&stored),
            CodexAccountSummary {
                account_id: Some("acct_123".into()),
                email: Some("author@example.com".into()),
                plan: Some("plus".into()),
            }
        );
        assert_eq!(account_id_from_tokens(&stored).as_deref(), Some("acct_123"));
    }

    #[test]
    fn never_uses_a_bare_subject_as_the_account_id() {
        let stored = tokens(jwt(serde_json::json!({ "sub": "user-sub" })), None);
        assert_eq!(account_id_from_tokens(&stored), None);
        assert_eq!(account_summary(&stored).account_id, None);
        assert_eq!(jwt_claims("not-a-jwt"), None);
    }

    #[test]
    fn token_payloads_keep_previous_refresh_and_id_tokens() {
        let previous = tokens("old-access".into(), Some("old-id".into()));
        let refreshed = tokens_from_payload(
            &serde_json::json!({ "access_token": "new-access", "expires_in": 3600 }),
            Some(&previous),
            1_000,
        )
        .expect("refresh payload");
        assert_eq!(
            refreshed,
            StoredTokens {
                access_token: "new-access".into(),
                refresh_token: "refresh-1".into(),
                expires_at_ms: 3_601_000,
                id_token: Some("old-id".into()),
            }
        );
        assert!(tokens_from_payload(
            &serde_json::json!({ "access_token": "", "expires_in": 3600 }),
            Some(&previous),
            1_000,
        )
        .is_err());
        assert!(tokens_from_payload(
            &serde_json::json!({ "access_token": "fresh", "expires_in": 3600 }),
            None,
            1_000,
        )
        .is_err());
    }

    #[test]
    fn refreshes_inside_the_expiry_skew_only() {
        let mut stored = tokens("access".into(), None);
        stored.expires_at_ms = REFRESH_SKEW_MS + 10_000;
        assert!(!needs_refresh(&stored, 9_999));
        assert!(needs_refresh(&stored, 10_000));
    }

    #[test]
    fn device_intervals_parse_strings_and_clamp() {
        assert_eq!(interval_ms(Some(&serde_json::json!("5"))), 5_000);
        assert_eq!(interval_ms(Some(&serde_json::json!(2))), 2_000);
        assert_eq!(
            interval_ms(Some(&serde_json::json!(0))),
            DEVICE_DEFAULT_INTERVAL_MS
        );
        assert_eq!(
            interval_ms(Some(&serde_json::json!(900))),
            DEVICE_MAX_INTERVAL_MS
        );
        assert_eq!(interval_ms(None), DEVICE_DEFAULT_INTERVAL_MS);
    }

    #[test]
    fn stored_tokens_round_trip_without_extra_fields() {
        let stored = tokens("access".into(), None);
        let serialized = serde_json::to_string(&stored).expect("serialize");
        assert!(!serialized.contains("id_token"));
        assert_eq!(
            serde_json::from_str::<StoredTokens>(&serialized).expect("parse"),
            stored
        );
    }
}
