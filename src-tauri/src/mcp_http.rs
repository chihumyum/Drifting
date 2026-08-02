use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::future::{AbortHandle, Abortable};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::native_capabilities;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_PRE_CANCELLED: usize = 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpRequestInput {
    request_id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpResponseResult {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Default)]
struct McpHttpPending {
    requests: HashMap<String, AbortHandle>,
    pre_cancelled: HashSet<String>,
}

#[derive(Default)]
pub struct McpHttpState {
    pending: Mutex<McpHttpPending>,
}

impl Drop for McpHttpState {
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
pub async fn mcp_http_request(
    state: State<'_, McpHttpState>,
    input: McpHttpRequestInput,
) -> Result<McpHttpResponseResult, String> {
    validate_request(&input)?;
    let (abort, registration) = AbortHandle::new_pair();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "MCP HTTP state is unavailable")?;
        if pending.pre_cancelled.remove(&input.request_id) {
            return Err("MCP HTTP request was cancelled".into());
        }
        if pending
            .requests
            .insert(input.request_id.clone(), abort)
            .is_some()
        {
            return Err("MCP HTTP request id is already active".into());
        }
    }
    let request_id = input.request_id.clone();
    let result = Abortable::new(execute(input), registration).await;
    if let Ok(mut pending) = state.pending.lock() {
        pending.requests.remove(&request_id);
        pending.pre_cancelled.remove(&request_id);
    }
    match result {
        Ok(result) => result,
        Err(_) => Err("MCP HTTP request was cancelled".into()),
    }
}

#[tauri::command]
pub fn mcp_http_cancel(state: State<'_, McpHttpState>, request_id: String) -> Result<bool, String> {
    validate_id(&request_id)?;
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "MCP HTTP state is unavailable")?;
    if let Some(handle) = pending.requests.remove(&request_id) {
        handle.abort();
        return Ok(true);
    }
    if pending.pre_cancelled.len() >= MAX_PRE_CANCELLED {
        return Err("MCP HTTP cancellation queue is full".into());
    }
    Ok(pending.pre_cancelled.insert(request_id))
}

async fn execute(input: McpHttpRequestInput) -> Result<McpHttpResponseResult, String> {
    let timeout = Duration::from_millis(input.timeout_ms);
    let (client, url) = native_capabilities::mcp_http_client(&input.url, timeout)?;
    let headers = parse_headers(input.headers)?;
    let mut request = match input.method.as_str() {
        "POST" => client.post(url),
        "DELETE" => client.delete(url),
        _ => return Err("MCP HTTP method is unsupported".into()),
    }
    .headers(headers);
    if let Some(body) = input.body {
        request = request.body(body);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "MCP HTTP request failed".to_string())?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("MCP HTTP response exceeded the size limit".into());
    }
    let status = response.status().as_u16();
    let response_headers = project_response_headers(response.headers())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "MCP HTTP response could not be read".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("MCP HTTP response exceeded the size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body =
        String::from_utf8(bytes).map_err(|_| "MCP HTTP response was not UTF-8".to_string())?;
    Ok(McpHttpResponseResult {
        status,
        headers: response_headers,
        body,
    })
}

fn validate_request(input: &McpHttpRequestInput) -> Result<(), String> {
    validate_id(&input.request_id)?;
    if input.timeout_ms == 0 || input.timeout_ms > 300_000 {
        return Err("MCP HTTP timeout is invalid".into());
    }
    if !matches!(input.method.as_str(), "POST" | "DELETE") {
        return Err("MCP HTTP method is unsupported".into());
    }
    if input
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
    {
        return Err("MCP HTTP request exceeded the size limit".into());
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err("MCP HTTP request id is invalid".into());
    }
    Ok(())
}

fn parse_headers(values: HashMap<String, String>) -> Result<HeaderMap, String> {
    if values.len() > MAX_HEADERS {
        return Err("MCP HTTP request has too many headers".into());
    }
    let mut total = 0_usize;
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let parsed_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "MCP HTTP header name is invalid".to_string())?;
        if forbidden_header(parsed_name.as_str()) {
            return Err("MCP HTTP header is forbidden".into());
        }
        let parsed_value = HeaderValue::from_str(&value)
            .map_err(|_| "MCP HTTP header value is invalid".to_string())?;
        total = total.saturating_add(name.len() + value.len());
        if total > MAX_HEADER_BYTES {
            return Err("MCP HTTP request headers exceeded the size limit".into());
        }
        headers.insert(parsed_name, parsed_value);
    }
    Ok(headers)
}

fn forbidden_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "cookie"
            | "connection"
            | "content-length"
            | "origin"
            | "proxy-authorization"
            | "referer"
            | "transfer-encoding"
            | "upgrade"
    ) || name.starts_with("sec-")
        || name.starts_with("proxy-")
}

fn project_response_headers(headers: &HeaderMap) -> Result<HashMap<String, String>, String> {
    let mut projected = HashMap::new();
    for name in [
        "content-type",
        "content-length",
        "mcp-session-id",
        "mcp-protocol-version",
    ] {
        let Some(value) = headers.get(name) else {
            continue;
        };
        let value = value
            .to_str()
            .map_err(|_| "MCP HTTP response header was invalid")?;
        if value.len() > 8_000 {
            return Err("MCP HTTP response header exceeded the size limit".into());
        }
        projected.insert(name.to_string(), value.to_string());
    }
    Ok(projected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_authority_bearing_transport_headers() {
        for name in [
            "Host",
            "Cookie",
            "Origin",
            "Proxy-Authorization",
            "Sec-Fetch-Site",
        ] {
            let mut values = HashMap::new();
            values.insert(name.into(), "value".into());
            assert!(parse_headers(values).is_err(), "{name} must be rejected");
        }
    }

    #[test]
    fn accepts_mcp_and_authorization_headers() {
        let values = HashMap::from([
            (
                "Accept".into(),
                "application/json, text/event-stream".into(),
            ),
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), "Bearer test".into()),
            ("Mcp-Session-Id".into(), "session".into()),
        ]);
        assert_eq!(parse_headers(values).expect("headers").len(), 4);
    }
}
