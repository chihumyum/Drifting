use std::collections::HashMap;
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime};

use dr_agent::{Cancellation, Driver, DriverEvent, DriverRequest, Provider, Usage};
use futures::{SinkExt, Stream, StreamExt, channel::mpsc, stream::BoxStream};
use serde_json::{Value, json};

use crate::credentials::Credentials;
use crate::oauth::{OAuth, OAuthCancellation, OAuthEndpoints};
use crate::{ProviderError, Result, SseParser, anthropic, deepseek, responses};

static EXECUTOR: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn executor() -> &'static tokio::runtime::Runtime {
    EXECUTOR.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("dr-model-http")
            .enable_all()
            .build()
            .expect("model HTTP executor")
    })
}

/// Clone the handle, not a client per provider, attempt, OAuth or catalog call.
#[derive(Clone)]
pub struct HttpClient(reqwest::Client);

impl HttpClient {
    pub fn new() -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ok(Self(
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .read_timeout(Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        ))
    }

    pub fn raw(&self) -> &reqwest::Client {
        &self.0
    }

    /// GUI callers can await this handle on their own executor. Network I/O
    /// always runs on the shared Tokio reactor; no Tokio context is required.
    pub fn spawn<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        executor().spawn(future)
    }
}

#[derive(Clone, Debug)]
pub struct Endpoints {
    pub deepseek: String,
    pub anthropic: String,
    pub openai: String,
    pub chatgpt: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            deepseek: "https://api.deepseek.com/chat/completions".into(),
            anthropic: "https://api.anthropic.com/v1/messages".into(),
            openai: "https://api.openai.com/v1/responses".into(),
            chatgpt: "https://chatgpt.com/backend-api/codex/responses".into(),
        }
    }
}

impl Endpoints {
    fn get(&self, provider: Provider) -> &str {
        match provider {
            Provider::Deepseek => &self.deepseek,
            Provider::Anthropic => &self.anthropic,
            Provider::Openai => &self.openai,
            Provider::Chatgpt => &self.chatgpt,
        }
    }
}

/// The 0.1 pre-effect lease: six samples, exponential 250ms–4s, jitter,
/// Retry-After capped at 60s. Tool-free text is never automatically repeated.
#[derive(Clone, Debug)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 6,
            base_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(4),
            jitter: true,
        }
    }
}

impl RetryPolicy {
    fn delay(&self, attempt: u32, hint: Option<Duration>) -> Duration {
        let delay = self
            .base_delay
            .saturating_mul(2u32.saturating_pow(attempt))
            .min(self.max_delay);
        let delay = if self.jitter {
            let fraction = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos()
                % 1000;
            delay.mul_f64(0.5 + f64::from(fraction) / 2000.0)
        } else {
            delay
        };
        delay.max(hint.unwrap_or_default().min(Duration::from_secs(60)))
    }
}

#[derive(Clone)]
pub struct ProviderDriver {
    http: HttpClient,
    credentials: Credentials,
    oauth: OAuth,
    endpoints: Endpoints,
    retry: RetryPolicy,
}

impl ProviderDriver {
    pub fn new(http: HttpClient, credentials: Credentials) -> Self {
        Self::with_endpoints(
            http,
            credentials,
            Endpoints::default(),
            OAuthEndpoints::default(),
            RetryPolicy::default(),
        )
    }

    /// Overrides are for an explicitly configured gateway or a loopback test
    /// service. Credentials never follow HTTP redirects.
    pub fn with_endpoints(
        http: HttpClient,
        credentials: Credentials,
        endpoints: Endpoints,
        oauth_endpoints: OAuthEndpoints,
        retry: RetryPolicy,
    ) -> Self {
        let oauth = OAuth::new(credentials.clone(), oauth_endpoints);
        Self {
            http,
            credentials,
            oauth,
            endpoints,
            retry,
        }
    }

    pub fn http(&self) -> &HttpClient {
        &self.http
    }
    pub fn oauth(&self) -> &OAuth {
        &self.oauth
    }
    pub fn credentials(&self) -> &Credentials {
        &self.credentials
    }

    /// Uses candidate BYOK credentials with the same HTTP client and endpoints.
    /// OAuth remains the original subscription connection; this is for API-key
    /// connectivity checks, not for creating another subscription identity.
    pub fn with_credentials(&self, credentials: Credentials) -> Self {
        Self {
            credentials,
            ..self.clone()
        }
    }

    async fn run(
        &self,
        request: DriverRequest,
        sender: &mut mpsc::Sender<dr_agent::Result<DriverEvent>>,
    ) -> Result<()> {
        validate_endpoint(self.endpoints.get(request.config.route.provider))?;
        let buffered = !request.tools.is_empty();
        let mut search = request.config.web_search && !search_was_rejected(&request);
        let attempts = if buffered {
            self.retry.max_attempts.max(1)
        } else {
            1
        };
        for attempt in 0..attempts {
            let mut pending = Vec::new();
            match self
                .attempt(&request, buffered, sender, &mut pending, &mut search)
                .await
            {
                Ok(()) => {
                    for event in pending {
                        publish(sender, event).await?;
                    }
                    return Ok(());
                }
                Err(error) if buffered && error.retryable && attempt + 1 < attempts => {
                    tokio::time::sleep(self.retry.delay(attempt, error.retry_after)).await;
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("at least one provider attempt")
    }

    async fn attempt(
        &self,
        request: &DriverRequest,
        buffered: bool,
        sender: &mut mpsc::Sender<dr_agent::Result<DriverEvent>>,
        pending: &mut Vec<DriverEvent>,
        search: &mut bool,
    ) -> Result<()> {
        let provider = request.config.route.provider;
        let mut body = wire_request(request, *search)?;
        let mut pause_count = 0;
        let mut prior_replay = Vec::new();
        let mut prior_usage = Usage::default();
        let mut searches = search_queries(request);
        let mut index_offset = 0;
        let mut auth_retry = false;
        let mut refreshed = false;
        let oauth_cancel = OAuthCancellation::default();
        loop {
            let mut http = self
                .http
                .raw()
                .post(self.endpoints.get(provider))
                .header("accept", "text/event-stream")
                .json(&body);
            if provider == Provider::Chatgpt {
                let auth = self
                    .oauth
                    .authorization(self.http.raw(), auth_retry && !refreshed, &oauth_cancel)
                    .await?;
                refreshed |= auth_retry;
                http = auth.apply(http);
            } else {
                let key = self
                    .credentials
                    .api_key(provider)
                    .await?
                    .ok_or_else(|| ProviderError::from_status(401, ""))?;
                http = if provider == Provider::Anthropic {
                    http.header("x-api-key", key)
                        .header("anthropic-version", "2023-06-01")
                } else {
                    http.bearer_auth(key)
                };
            }
            let response = http.send().await?;
            let status = response.status().as_u16();
            if !(200..300).contains(&status) {
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(retry_after);
                let text = error_body(response).await.unwrap_or_default();
                if status == 401 && provider == Provider::Chatgpt && !auth_retry && pause_count == 0
                {
                    auth_retry = true;
                    continue;
                }
                if status == 400
                    && provider == Provider::Anthropic
                    && *search
                    && pause_count == 0
                    && active_anthropic_replays(request).next().is_none()
                    && mentions_web_search(&text)
                {
                    *search = false;
                    body = wire_request(request, *search)?;
                    continue;
                }
                let mut error = ProviderError::from_status(status, &text);
                error.retry_after = retry_after;
                return Err(error);
            }
            let mut parser = SseParser::default();
            let thinking = match provider {
                Provider::Deepseek => body["thinking"]["type"] == "enabled",
                Provider::Openai | Provider::Chatgpt => body["reasoning"]["effort"] != "none",
                Provider::Anthropic => body["thinking"]["type"] == "adaptive",
            };
            let mut decoder = Decoder::new(provider, index_offset, thinking);
            let mut stream = response.bytes_stream();
            let mut terminal = Vec::new();
            let mut current_usage = Usage::default();
            while let Some(chunk) = stream.next().await {
                for wire in parser.push(&chunk?)? {
                    for mut event in decoder.push(&wire)? {
                        if let DriverEvent::ToolCall(call) = &event
                            && !request.tools.iter().any(|tool| tool.name == call.name)
                        {
                            return Err(ProviderError::protocol(
                                "model called an unavailable tool",
                            ));
                        }
                        match &mut event {
                            DriverEvent::ProviderTool { activity } => {
                                if let Some(query) = &activity.query {
                                    searches.insert(activity.id.clone(), query.clone());
                                } else {
                                    activity.query = searches.get(&activity.id).cloned();
                                }
                            }
                            DriverEvent::Usage(usage) => {
                                current_usage = *usage;
                                *usage = add_usage(prior_usage, *usage);
                            }
                            DriverEvent::Replay { replay } => {
                                replay.native_search = Some(*search);
                                let mut items = prior_replay.clone();
                                items.append(&mut replay.items);
                                replay.items = items;
                            }
                            _ => {}
                        }
                        if matches!(event, DriverEvent::Finish(_) | DriverEvent::Replay { .. }) {
                            terminal.push(event);
                        } else if buffered {
                            pending.push(event);
                        } else {
                            publish(sender, event).await?;
                        }
                    }
                }
            }
            parser.finish()?;
            if let Some(content) = decoder.finish()? {
                if pause_count == 4 {
                    let mut error = ProviderError::protocol("Anthropic pause continuation limit");
                    error.retryable = false;
                    return Err(error);
                }
                pause_count += 1;
                index_offset = decoder.next_index();
                prior_usage = add_usage(prior_usage, current_usage);
                let message = json!({"role":"assistant","content":content});
                prior_replay.push(message.clone());
                body["messages"]
                    .as_array_mut()
                    .ok_or_else(|| ProviderError::protocol("missing Messages request"))?
                    .push(message);
                continue;
            }
            for event in terminal {
                if buffered {
                    pending.push(event);
                } else {
                    publish(sender, event).await?;
                }
            }
            return Ok(());
        }
    }
}

impl Driver for ProviderDriver {
    fn stream(
        &self,
        request: DriverRequest,
        cancel: Cancellation,
    ) -> BoxStream<'static, dr_agent::Result<DriverEvent>> {
        let driver = self.clone();
        let (mut tx, rx) = mpsc::channel(64);
        let task = self.http.spawn(async move {
            let result = tokio::select! {
                result = driver.run(request, &mut tx) => result,
                _ = async { loop { if cancel.is_cancelled() { break; } tokio::time::sleep(Duration::from_millis(25)).await; } } => Err(ProviderError::cancelled()),
            };
            if let Err(error) = result { let _ = tx.send(Err(error.into())).await; }
        });
        Box::pin(TransportStream {
            receiver: rx,
            task: task.abort_handle(),
        })
    }
}

struct TransportStream {
    receiver: mpsc::Receiver<dr_agent::Result<DriverEvent>>,
    task: tokio::task::AbortHandle,
}

impl Stream for TransportStream {
    type Item = dr_agent::Result<DriverEvent>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.receiver).poll_next(cx)
    }
}
impl Drop for TransportStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn publish(
    sender: &mut mpsc::Sender<dr_agent::Result<DriverEvent>>,
    event: DriverEvent,
) -> Result<()> {
    sender
        .send(Ok(event))
        .await
        .map_err(|_| ProviderError::cancelled())
}

fn wire_request(request: &DriverRequest, search: bool) -> Result<Value> {
    match request.config.route.provider {
        Provider::Anthropic => anthropic::request(request, search),
        Provider::Deepseek => deepseek::request(request, search),
        Provider::Openai | Provider::Chatgpt => responses::request(request, search),
    }
}

fn active_anthropic_replays(
    request: &DriverRequest,
) -> impl Iterator<Item = dr_agent::ProviderReplay> + '_ {
    request
        .conversation
        .iter()
        .rev()
        .take_while(|entry| entry.kind != dr_model::conversation::ConversationEntryKind::User)
        .filter(|entry| {
            request.config.route.provider == Provider::Anthropic
                && entry.session == request.session
                && entry.turn == request.turn
        })
        .filter_map(|entry| {
            serde_json::from_value::<dr_agent::AssistantMessage>(entry.payload.clone()).ok()
        })
        .filter_map(|message| message.replay)
        .filter(|replay| replay.provider == Provider::Anthropic)
}

fn search_was_rejected(request: &DriverRequest) -> bool {
    active_anthropic_replays(request).any(|replay| replay.native_search == Some(false))
}

fn search_queries(request: &DriverRequest) -> HashMap<String, String> {
    let mut queries = HashMap::new();
    for replay in active_anthropic_replays(request) {
        for message in replay.items {
            for block in message["content"].as_array().into_iter().flatten() {
                if block["type"] == "server_tool_use"
                    && block["name"] == "web_search"
                    && let (Some(id), Some(query)) =
                        (block["id"].as_str(), block["input"]["query"].as_str())
                {
                    queries.insert(id.into(), query.into());
                }
            }
        }
    }
    queries
}

enum Decoder {
    Anthropic(anthropic::Decoder),
    Deepseek(deepseek::Decoder),
    Responses(responses::Decoder),
}

impl Decoder {
    fn new(provider: Provider, offset: u32, thinking: bool) -> Self {
        match provider {
            Provider::Anthropic => Self::Anthropic(anthropic::Decoder::new(offset)),
            Provider::Deepseek => {
                Self::Deepseek(deepseek::Decoder::with_thinking(offset, thinking))
            }
            Provider::Openai | Provider::Chatgpt => {
                Self::Responses(responses::Decoder::with_config(offset, provider, thinking))
            }
        }
    }
    fn push(&mut self, event: &crate::SseEvent) -> Result<Vec<DriverEvent>> {
        match self {
            Self::Anthropic(d) => d.push(event),
            Self::Deepseek(d) => d.push(event),
            Self::Responses(d) => d.push(event),
        }
    }
    fn finish(&self) -> Result<Option<Vec<Value>>> {
        match self {
            Self::Anthropic(d) => d.finish(),
            Self::Deepseek(d) => d.finish(),
            Self::Responses(d) => d.finish(),
        }
    }
    fn next_index(&self) -> u32 {
        match self {
            Self::Anthropic(d) => d.next_index(),
            _ => 0,
        }
    }
}

fn add_usage(a: Usage, b: Usage) -> Usage {
    Usage {
        input_tokens: a.input_tokens.saturating_add(b.input_tokens),
        output_tokens: a.output_tokens.saturating_add(b.output_tokens),
        cached_input_tokens: a.cached_input_tokens.saturating_add(b.cached_input_tokens),
        cache_write_tokens: a.cache_write_tokens.saturating_add(b.cache_write_tokens),
        reasoning_tokens: a.reasoning_tokens.saturating_add(b.reasoning_tokens),
    }
}

fn mentions_web_search(body: &str) -> bool {
    let text = body.to_ascii_lowercase();
    text.contains("web_search") || text.contains("web search")
}

fn validate_endpoint(endpoint: &str) -> Result<()> {
    let url = reqwest::Url::parse(endpoint).map_err(ProviderError::network)?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() != "https" && !(url.scheme() == "http" && local))
    {
        return Err(ProviderError::new(
            dr_agent::ModelErrorCategory::Unsupported,
            false,
        ));
    }
    Ok(())
}

async fn error_body(response: reqwest::Response) -> Result<String> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let remaining = 64 * 1024 - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() == 64 * 1024 {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn retry_after(value: &str) -> Option<Duration> {
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    // HTTP-date is parsed by the same HTTP stack's RFC 7231 helper.
    let when = httpdate::parse_http_date(value).ok()?;
    when.duration_since(SystemTime::now()).ok()
}
