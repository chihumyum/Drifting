use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::{AbortHandle, Abortable};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};

use crate::codex_oauth;
use crate::secure_storage;

const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const OPENAI_KEY_ID: &str = "byok.openai";
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_PRE_CANCELLED: usize = 1024;

/// Which native credential authorizes a Responses request. Both sources share
/// the renderer body contract; only the upstream origin and headers differ.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpenAIResponsesCredentialSource {
    /// `byok.openai` API key against the public OpenAI API.
    #[default]
    ApiKey,
    /// ChatGPT subscription OAuth token against the Codex backend.
    ChatgptSubscription,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIResponsesRequestInput {
    request_id: String,
    body: String,
    timeout_ms: u64,
    #[serde(default)]
    credential_source: OpenAIResponsesCredentialSource,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OpenAIResponsesStreamEvent {
    Started {
        status: u16,
        #[serde(rename = "requestId")]
        request_id: Option<String>,
        #[serde(rename = "errorCode")]
        error_code: Option<String>,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    Finished,
}

#[derive(Default)]
struct OpenAIResponsesPending {
    requests: HashMap<String, AbortHandle>,
    pre_cancelled: HashSet<String>,
}

#[derive(Default)]
pub struct OpenAIResponsesState {
    pending: Mutex<OpenAIResponsesPending>,
    client: OnceLock<reqwest::Client>,
}

impl OpenAIResponsesState {
    fn client(&self) -> Result<reqwest::Client, String> {
        if let Some(client) = self.client.get() {
            return Ok(client.clone());
        }
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "OPENAI_TRANSPORT_UNAVAILABLE: native HTTP client could not start")?;
        let _ = self.client.set(client.clone());
        Ok(client)
    }
}

impl Drop for OpenAIResponsesState {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, handle) in pending.requests.drain() {
                handle.abort();
            }
            pending.pre_cancelled.clear();
        }
    }
}

#[tauri::command]
pub async fn openai_responses_stream(
    app: AppHandle,
    state: State<'_, OpenAIResponsesState>,
    input: OpenAIResponsesRequestInput,
    on_event: Channel<OpenAIResponsesStreamEvent>,
) -> Result<(), String> {
    validate_request(&input)?;
    let client = state.client()?;
    let (abort, registration) = AbortHandle::new_pair();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "OPENAI_TRANSPORT_UNAVAILABLE: request state is unavailable")?;
        if pending.pre_cancelled.remove(&input.request_id) {
            return Err("OPENAI_REQUEST_CANCELLED: request was cancelled".into());
        }
        if pending
            .requests
            .insert(input.request_id.clone(), abort)
            .is_some()
        {
            return Err("OPENAI_INVALID_REQUEST: request id is already active".into());
        }
    }

    let request_id = input.request_id.clone();
    let result = Abortable::new(execute(app, client, input, on_event), registration).await;
    if let Ok(mut pending) = state.pending.lock() {
        pending.requests.remove(&request_id);
        pending.pre_cancelled.remove(&request_id);
    }
    match result {
        Ok(result) => result,
        Err(_) => Err("OPENAI_REQUEST_CANCELLED: request was cancelled".into()),
    }
}

#[tauri::command]
pub fn openai_responses_cancel(
    state: State<'_, OpenAIResponsesState>,
    request_id: String,
) -> Result<bool, String> {
    validate_id(&request_id)?;
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "OPENAI_TRANSPORT_UNAVAILABLE: request state is unavailable")?;
    if let Some(handle) = pending.requests.remove(&request_id) {
        handle.abort();
        return Ok(true);
    }
    if pending.pre_cancelled.len() >= MAX_PRE_CANCELLED {
        return Err("OPENAI_TRANSPORT_UNAVAILABLE: cancellation queue is full".into());
    }
    Ok(pending.pre_cancelled.insert(request_id))
}

async fn execute(
    app: AppHandle,
    client: reqwest::Client,
    input: OpenAIResponsesRequestInput,
    on_event: Channel<OpenAIResponsesStreamEvent>,
) -> Result<(), String> {
    let timeout = Duration::from_millis(input.timeout_ms);
    let response = match input.credential_source {
        OpenAIResponsesCredentialSource::ApiKey => {
            let key_app = app.clone();
            let api_key = tauri::async_runtime::spawn_blocking(move || {
                secure_storage::read_secret(&key_app, OPENAI_KEY_ID)
            })
            .await
            .map_err(|_| "OPENAI_CREDENTIAL_UNAVAILABLE: secure storage worker failed")?
            .map_err(|_| "OPENAI_CREDENTIAL_UNAVAILABLE: OpenAI key could not be read")?
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "OPENAI_CREDENTIAL_MISSING: no OpenAI API key is configured".to_string()
            })?;
            send_openai_request(&client, api_key, input.body, timeout).await?
        }
        OpenAIResponsesCredentialSource::ChatgptSubscription => {
            send_codex_request(&app, &client, &input.body, timeout).await?
        }
    };

    let status = response.status();
    let request_id = project_request_id(response.headers());
    if !status.is_success() {
        let body = read_bounded_error(response).await?;
        let (error_code, error_message) =
            project_upstream_error(status.as_u16(), &body, input.credential_source);
        send_event(
            &on_event,
            OpenAIResponsesStreamEvent::Started {
                status: status.as_u16(),
                request_id,
                error_code: Some(error_code),
                error_message: Some(error_message),
            },
        )?;
        send_event(&on_event, OpenAIResponsesStreamEvent::Finished)?;
        return Ok(());
    }

    send_event(
        &on_event,
        OpenAIResponsesStreamEvent::Started {
            status: status.as_u16(),
            request_id,
            error_code: None,
            error_message: None,
        },
    )?;

    let mut total = 0_usize;
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|_| {
            "OPENAI_STREAM_FAILED: OpenAI response stream could not be read".to_string()
        })?;
        total = total.saturating_add(chunk.len());
        if total > MAX_RESPONSE_BYTES {
            return Err("OPENAI_STREAM_TOO_LARGE: OpenAI response exceeded the size limit".into());
        }
        send_event(
            &on_event,
            OpenAIResponsesStreamEvent::Chunk {
                bytes: chunk.to_vec(),
            },
        )?;
    }
    send_event(&on_event, OpenAIResponsesStreamEvent::Finished)
}

async fn send_openai_request(
    client: &reqwest::Client,
    api_key: String,
    body: String,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    client
        .post(OPENAI_RESPONSES_URL)
        .header(ACCEPT, "text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .bearer_auth(api_key)
        .timeout(timeout)
        .body(body)
        .send()
        .await
        .map_err(project_network_error)
}

/// Codex backend request with the subscription bearer. A rejected token is
/// refreshed once under the shared lease and the bounded body replayed.
async fn send_codex_request(
    app: &AppHandle,
    client: &reqwest::Client,
    body: &str,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let authorization = codex_oauth::authorization(app, false).await?;
    let response = post_codex(client, &authorization, body, timeout).await?;
    if response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(response);
    }
    let authorization = codex_oauth::authorization(app, true).await?;
    post_codex(client, &authorization, body, timeout).await
}

async fn post_codex(
    client: &reqwest::Client,
    authorization: &codex_oauth::CodexAuthorization,
    body: &str,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    codex_oauth::apply_request_headers(
        client
            .post(codex_oauth::CODEX_RESPONSES_URL)
            .header(ACCEPT, "text/event-stream")
            .header(CONTENT_TYPE, "application/json"),
        authorization,
    )
    .timeout(timeout)
    .body(body.to_owned())
    .send()
    .await
    .map_err(project_network_error)
}

fn send_event(
    channel: &Channel<OpenAIResponsesStreamEvent>,
    event: OpenAIResponsesStreamEvent,
) -> Result<(), String> {
    channel
        .send(event)
        .map_err(|_| "OPENAI_STREAM_CLOSED: renderer stream is unavailable".into())
}

async fn read_bounded_error(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        let chunk =
            next.map_err(|_| "OPENAI_STREAM_FAILED: OpenAI error response could not be read")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_ERROR_BYTES {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn project_request_id(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 200
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
                })
        })
        .map(str::to_owned)
}

fn project_upstream_error(
    status: u16,
    body: &[u8],
    source: OpenAIResponsesCredentialSource,
) -> (String, String) {
    let upstream_code = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("error")?.get("code")?.as_str().map(str::to_owned))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let subscription = source == OpenAIResponsesCredentialSource::ChatgptSubscription;

    if upstream_code.contains("insufficient_quota")
        || upstream_code.contains("billing")
        || (subscription && upstream_code.contains("usage_limit"))
    {
        return (
            "quota_exhausted".into(),
            if subscription {
                "The ChatGPT subscription usage limit was reached; wait for the window to reset."
            } else {
                "OpenAI quota or billing access is unavailable for this API key."
            }
            .into(),
        );
    }
    if upstream_code.contains("model_not_found") || matches!(status, 404) {
        return (
            "model_unavailable".into(),
            if subscription {
                "The selected model is unavailable to this ChatGPT subscription."
            } else {
                "The selected OpenAI model is unavailable to this API key."
            }
            .into(),
        );
    }
    match status {
        401 | 403 => (
            "authentication_failed".into(),
            if subscription {
                "The ChatGPT subscription sign-in was rejected; sign in again in Settings."
            } else {
                "OpenAI rejected the configured API key or project access."
            }
            .into(),
        ),
        429 => (
            "rate_limited".into(),
            "OpenAI rate limit was reached; retry after the provider window resets.".into(),
        ),
        400..=499 => (
            "invalid_request".into(),
            "OpenAI rejected the Responses request.".into(),
        ),
        _ => (
            "upstream_failed".into(),
            "OpenAI could not complete the request.".into(),
        ),
    }
}

fn project_network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "OPENAI_NETWORK_TIMEOUT: OpenAI did not respond before the request deadline".into()
    } else if error.is_connect() {
        "OPENAI_NETWORK_FAILED: OpenAI could not be reached from the native runtime".into()
    } else {
        "OPENAI_NETWORK_FAILED: native OpenAI request failed".into()
    }
}

fn validate_request(input: &OpenAIResponsesRequestInput) -> Result<(), String> {
    validate_id(&input.request_id)?;
    if input.timeout_ms < 1_000 || input.timeout_ms > 900_000 {
        return Err("OPENAI_INVALID_REQUEST: timeout is invalid".into());
    }
    if input.body.is_empty() || input.body.len() > MAX_REQUEST_BYTES {
        return Err("OPENAI_INVALID_REQUEST: request body size is invalid".into());
    }
    let body = serde_json::from_str::<serde_json::Value>(&input.body)
        .map_err(|_| "OPENAI_INVALID_REQUEST: request body is not JSON")?;
    let Some(body) = body.as_object() else {
        return Err("OPENAI_INVALID_REQUEST: request body must be an object".into());
    };
    if body.get("stream").and_then(serde_json::Value::as_bool) != Some(true)
        || body.get("store").and_then(serde_json::Value::as_bool) != Some(false)
    {
        return Err("OPENAI_INVALID_REQUEST: streaming and store policy are invalid".into());
    }
    if !matches!(
        body.get("model").and_then(serde_json::Value::as_str),
        Some("gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna")
    ) {
        return Err("OPENAI_INVALID_REQUEST: model is not certified".into());
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("OPENAI_INVALID_REQUEST: request id is invalid".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(body: &str) -> OpenAIResponsesRequestInput {
        OpenAIResponsesRequestInput {
            request_id: "openai-request-1".into(),
            body: body.into(),
            timeout_ms: 60_000,
            credential_source: OpenAIResponsesCredentialSource::ApiKey,
        }
    }

    #[test]
    fn credential_source_defaults_to_the_api_key_and_decodes_the_subscription() {
        let legacy: OpenAIResponsesRequestInput =
            serde_json::from_str(r#"{"requestId":"r1","body":"{}","timeoutMs":60000}"#)
                .expect("legacy input");
        assert_eq!(
            legacy.credential_source,
            OpenAIResponsesCredentialSource::ApiKey
        );
        let subscription: OpenAIResponsesRequestInput = serde_json::from_str(
            r#"{"requestId":"r1","body":"{}","timeoutMs":60000,"credentialSource":"chatgpt_subscription"}"#,
        )
        .expect("subscription input");
        assert_eq!(
            subscription.credential_source,
            OpenAIResponsesCredentialSource::ChatgptSubscription
        );
    }

    #[test]
    fn projects_subscription_failures_with_sign_in_guidance() {
        let (code, message) = project_upstream_error(
            401,
            b"{}",
            OpenAIResponsesCredentialSource::ChatgptSubscription,
        );
        assert_eq!(code, "authentication_failed");
        assert!(message.contains("sign in again"));
        let body = br#"{"error":{"code":"usage_limit_reached"}}"#;
        let (code, _) = project_upstream_error(
            429,
            body,
            OpenAIResponsesCredentialSource::ChatgptSubscription,
        );
        assert_eq!(code, "quota_exhausted");
    }

    #[test]
    fn accepts_bounded_json_requests_and_rejects_authority_like_ids() {
        assert!(validate_request(&input(
            r#"{"model":"gpt-5.6-luna","stream":true,"store":false}"#
        ))
        .is_ok());
        let mut invalid = input("{}");
        invalid.request_id = "../openai".into();
        assert!(validate_request(&invalid).is_err());
        assert!(
            validate_request(&input(r#"{"model":"gpt-4o","stream":true,"store":false}"#)).is_err()
        );
    }

    #[test]
    fn projects_upstream_failures_without_returning_raw_provider_text() {
        let body = br#"{"error":{"code":"insufficient_quota","message":"Bearer sk-secret"}}"#;
        let (code, message) =
            project_upstream_error(429, body, OpenAIResponsesCredentialSource::ApiKey);
        assert_eq!(code, "quota_exhausted");
        assert!(!message.contains("sk-secret"));
        assert!(!message.contains("Bearer"));
    }

    #[test]
    fn identifies_model_entitlement_failures() {
        let body = br#"{"error":{"code":"model_not_found"}}"#;
        assert_eq!(
            project_upstream_error(404, body, OpenAIResponsesCredentialSource::ApiKey).0,
            "model_unavailable"
        );
    }

    #[test]
    #[ignore = "paid OpenAI native transport canary"]
    fn live_luna_native_transport_streams_a_required_tool_call() {
        let api_key = std::env::var("DRIFTING_OPENAI_NATIVE_CANARY_KEY")
            .expect("DRIFTING_OPENAI_NATIVE_CANARY_KEY is required");
        let state = OpenAIResponsesState::default();
        let client = state.client().expect("native client");
        let request_body = serde_json::json!({
            "model": "gpt-5.6-luna",
            "instructions": "Call echo exactly once with text=\"native-canary\". Do not answer in prose.",
            "input": "Run the required native canary tool now.",
            "max_output_tokens": 256,
            "stream": true,
            "store": false,
            "reasoning": { "effort": "none" },
            "tools": [{
                "type": "function",
                "name": "echo",
                "description": "Return a canary string.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "const": "native-canary" }
                    },
                    "required": ["text"],
                    "additionalProperties": false
                }
            }],
            "tool_choice": { "type": "function", "name": "echo" }
        })
        .to_string();

        tauri::async_runtime::block_on(async {
            let response =
                send_openai_request(&client, api_key, request_body, Duration::from_secs(120))
                    .await
                    .expect("native OpenAI request");
            let status = response.status();
            let request_id = project_request_id(response.headers());
            assert!(
                status.is_success(),
                "OpenAI native canary returned HTTP {status}; request id: {request_id:?}"
            );
            let stream = response.text().await.expect("native OpenAI stream");
            assert!(stream.contains("response.completed"));
            assert!(stream.contains("native-canary"));
            assert!(stream.contains("function_call"));
        });
    }
}
