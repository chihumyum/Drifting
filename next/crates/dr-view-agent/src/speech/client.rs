//! One sequential ASR request per segment. Only explicit HTTP 429/5xx replies
//! retry automatically; an unknown network outcome stays available for an
//! author-requested retry. Keys, audio and response bodies are never logged.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dr_agent_providers::HttpClient;
use dr_platform::secrets::SecretStore;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub const KEY: &str = "byok.dashscope";
pub const ENDPOINT: &str =
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
pub const MAX_AUDIO_BYTES: usize = 7_000_000;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Failure {
    #[error("speech credential unavailable")]
    NoKey,
    #[error("speech credential storage failed")]
    Storage,
    #[error("speech credential rejected")]
    Authentication,
    #[error("audio segment rejected")]
    Rejected,
    #[error("speech transcription failed; audio retained")]
    Transport,
    #[error("speech capture failed")]
    Microphone,
    #[error("speech capture queue filled; capture stopped")]
    Backlog,
    #[error("speech cancelled")]
    Cancelled,
}

#[derive(Clone)]
pub struct Client {
    pub(crate) http: HttpClient,
    pub(crate) secrets: Arc<SecretStore>,
    endpoint: String,
    retry_delay: Duration,
}
impl Client {
    pub fn new(http: HttpClient, secrets: Arc<SecretStore>) -> Self {
        Self {
            http,
            secrets,
            endpoint: ENDPOINT.into(),
            retry_delay: Duration::from_millis(500),
        }
    }
    /// Only HTTPS production or loopback fake services, with no credentials in
    /// the URL. Never follow redirects while carrying the speech key.
    pub fn with_endpoint(mut self, endpoint: &str) -> Result<Self, Failure> {
        let url = url::Url::parse(endpoint).map_err(|_| Failure::Rejected)?;
        let local = url.host_str().is_some_and(|host| {
            host.parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        });
        if (url.scheme() != "https" && !(url.scheme() == "http" && local))
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Failure::Rejected);
        }
        self.endpoint = url.to_string();
        Ok(self)
    }
    pub async fn transcribe(
        &self,
        audio: Arc<Vec<u8>>,
        context: String,
        cancel: CancellationToken,
    ) -> Result<String, Failure> {
        if audio.len() <= 44 || audio.len() > MAX_AUDIO_BYTES || !audio.starts_with(b"RIFF") {
            return Err(Failure::Rejected);
        }
        let client = self.clone();
        self.http
            .spawn(async move {
                if cancel.is_cancelled() {
                    return Err(Failure::Cancelled);
                }
                let store = client.secrets.clone();
                let key = tokio::task::spawn_blocking(move || store.get(KEY))
                    .await
                    .map_err(|_| Failure::Storage)?
                    .map_err(|_| Failure::Storage)?
                    .filter(|key| !key.trim().is_empty())
                    .ok_or(Failure::NoKey)?;
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(Failure::Cancelled),
                    result = client.request(&audio, &context, &key) => result,
                }
            })
            .await
            .unwrap_or(Err(Failure::Transport))
    }
    async fn request(&self, audio: &[u8], context: &str, key: &str) -> Result<String, Failure> {
        let mut messages = Vec::new();
        if !context.is_empty() {
            messages.push(json!({"role":"system","content":[{"text":context}]}));
        }
        messages.push(json!({"role":"user","content":[{"audio":format!("data:audio/wav;base64,{}", STANDARD.encode(audio))}]}));
        let body = json!({"model":"qwen3-asr-flash","input":{"messages":messages},"parameters":{"asr_options":{"enable_itn":false}}});
        for attempt in 0..3 {
            let mut response = self
                .http
                .raw()
                .post(&self.endpoint)
                .bearer_auth(key.trim())
                .timeout(Duration::from_secs(120))
                .json(&body)
                .send()
                .await
                .map_err(|_| Failure::Transport)?;
            let status = response.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(Failure::Authentication);
            }
            if status.as_u16() == 429 || status.is_server_error() {
                if attempt == 2 {
                    return Err(Failure::Transport);
                }
                let delay = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(|seconds| Duration::from_secs(seconds.min(10)))
                    .unwrap_or(self.retry_delay * (1 << attempt));
                drop(response);
                tokio::time::sleep(delay).await;
                continue;
            }
            if !status.is_success() {
                return Err(Failure::Rejected);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Transport)? {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(Failure::Rejected);
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Rejected)?;
            let content = value
                .pointer("/output/choices/0/message/content")
                .and_then(Value::as_array)
                .ok_or(Failure::Rejected)?;
            let text = content
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            // Silence is a valid empty transcript; missing text blocks are not.
            if !content
                .iter()
                .any(|part| part.get("text").is_some_and(Value::is_string))
            {
                return Err(Failure::Rejected);
            }
            return Ok(text.trim().to_owned());
        }
        unreachable!()
    }
}
