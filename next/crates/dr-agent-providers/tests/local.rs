//! Local model servers against a synthetic, routed loopback service: model
//! lists, software recognition, context and tool capability, keys, and a
//! chat through the shared transport. No real server or model is involved.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use dr_agent::{
    Cancellation, Driver, DriverEvent, DriverRequest, FinishReason, LocalRoute, ModelErrorCategory,
    Provider, RequestPurpose, RunConfig, ToolAccess, ToolDescriptor, ToolPolicy,
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy,
    credentials::Credentials,
    local::{self, DiscoverError, LocalAddress, Software},
    oauth::OAuthEndpoints,
};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_platform::SecretStore;
use futures::StreamExt;
use serde_json::{Value, json};

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    headers: String,
    body: Value,
}

type Route = Box<dyn Fn(&Seen) -> (u16, String) + Send + Sync>;

/// Answers every request by method and path until dropped.
struct Fake {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Fake {
    fn new(route: Route) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log, closing) = (seen.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !closing.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let Some(request) = read(&mut socket) else {
                            continue;
                        };
                        log.lock().unwrap().push(request.clone());
                        let (status, body) = route(&request);
                        let kind = if body.starts_with("data:") {
                            "text/event-stream"
                        } else {
                            "application/json"
                        };
                        let head = format!(
                            "HTTP/1.1 {status} Test\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = socket.write_all(head.as_bytes());
                        for chunk in body.as_bytes().chunks(5) {
                            let _ = socket.write_all(chunk);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        Self {
            url,
            seen,
            stop,
            thread: Some(thread),
        }
    }

    fn paths(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|seen| format!("{} {}", seen.method, seen.path))
            .collect()
    }

    fn requests(&self, path: &str) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.path == path)
            .cloned()
            .collect()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

fn read(socket: &mut TcpStream) -> Option<Seen> {
    socket.set_nonblocking(false).ok()?;
    socket.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = socket.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8(bytes[..end].to_vec()).ok()?;
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .and_then(|n| n.trim().parse().ok())
                .unwrap_or(0);
            while bytes.len() < end + 4 + length {
                let count = socket.read(&mut buffer).ok()?;
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            let line = headers.lines().next()?.to_owned();
            let mut parts = line.split(' ');
            let method = parts.next()?.to_owned();
            let path = parts.next()?.to_owned();
            let body = serde_json::from_slice(&bytes[end + 4..(end + 4 + length).min(bytes.len())])
                .unwrap_or(Value::Null);
            return Some(Seen {
                method,
                path,
                headers,
                body,
            });
        }
    }
}

fn address(fake: &Fake) -> LocalAddress {
    LocalAddress::parse(&fake.url).unwrap()
}

fn listed(rows: Value) -> String {
    json!({"object":"list","data":rows}).to_string()
}

fn ollama() -> Fake {
    Fake::new(Box::new(ollama_reply))
}

fn ollama_reply(seen: &Seen) -> (u16, String) {
    match (seen.method.as_str(), seen.path.as_str()) {
        ("GET", "/v1/models") => (
            200,
            listed(json!([
                {"id":"qwen3:14b","object":"model","owned_by":"library"},
                {"id":"llama3.1:8b","object":"model","owned_by":"library"},
                {"id":"gemma3:12b","object":"model","owned_by":"library"},
                {"id":"nomic-embed-text:latest","object":"model","owned_by":"library"},
            ])),
        ),
        ("GET", "/api/version") => (200, json!({"version":"0.12.0"}).to_string()),
        ("POST", "/api/show") => {
            let (arch, context, capabilities) = match seen.body["model"].as_str() {
                Some("qwen3:14b") => ("qwen3", 40_960, json!(["completion", "tools", "thinking"])),
                Some("llama3.1:8b") => ("llama", 131_072, json!(["completion", "tools"])),
                Some("gemma3:12b") => ("gemma3", 131_072, json!(["completion", "vision"])),
                _ => ("nomic-bert", 2_048, json!(["embedding"])),
            };
            (
                200,
                json!({
                    "capabilities": capabilities,
                    "model_info": {
                        "general.architecture": arch,
                        format!("{arch}.context_length"): context,
                        "general.parameter_count": 14_000_000_000u64,
                    },
                })
                .to_string(),
            )
        }
        _ => (404, "{}".into()),
    }
}

#[tokio::test]
async fn ollama_is_recognized_and_only_tool_models_are_offered() {
    let fake = ollama();
    let http = HttpClient::new().unwrap();
    let found = local::discover(http.raw(), &address(&fake), None)
        .await
        .unwrap();
    assert_eq!(found.software, Some(Software::Ollama));
    let models: Vec<_> = found
        .models
        .iter()
        .map(|m| (m.id.as_str(), m.context_window))
        .collect();
    // gemma3 says it has no tools; nomic-embed-text is an embedding model.
    assert_eq!(
        models,
        [("qwen3:14b", Some(40_960)), ("llama3.1:8b", Some(131_072))]
    );
    let shown: Vec<_> = fake
        .requests("/api/show")
        .iter()
        .map(|seen| seen.body["model"].clone())
        .collect();
    assert_eq!(shown.len(), 4);
    assert!(
        fake.seen
            .lock()
            .unwrap()
            .iter()
            .all(|seen| !seen.headers.to_ascii_lowercase().contains("authorization")),
        "no key, no Authorization header"
    );
}

/// An Ollama with only gemma3 (no tools) and an embedding model gave its
/// list; nothing is left to offer, and that is not 「no list」.
#[tokio::test]
async fn an_ollama_with_only_models_without_tools_has_none_to_offer() {
    let fake = Fake::new(Box::new(|seen| match seen.path.as_str() {
        "/v1/models" => (
            200,
            listed(json!([
                {"id":"gemma3:12b","object":"model","owned_by":"library"},
                {"id":"nomic-embed-text:latest","object":"model","owned_by":"library"},
            ])),
        ),
        // Everything else as the full Ollama answers it.
        _ => ollama_reply(seen),
    }));
    let http = HttpClient::new().unwrap();
    assert_eq!(
        local::discover(http.raw(), &address(&fake), None).await,
        Err(DiscoverError::NoToolModels)
    );
    assert_eq!(fake.requests("/api/show").len(), 2, "both were asked about");
    local::check(http.raw(), &address(&fake), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn lm_studio_and_llama_cpp_are_recognized_by_their_own_endpoints() {
    let studio = Fake::new(Box::new(|seen| match seen.path.as_str() {
        "/v1/models" => (
            200,
            listed(json!([
                {"id":"qwen/qwen3-30b-a3b","object":"model","owned_by":"organization_owner"},
                {"id":"text-embedding-nomic-embed-text-v1.5","object":"model","owned_by":"organization_owner"},
                {"id":"mistral-small-3.2","object":"model","owned_by":"organization_owner"},
            ])),
        ),
        "/api/v0/models" => (
            200,
            listed(json!([
                {"id":"qwen/qwen3-30b-a3b","type":"llm","max_context_length":32_768},
                {"id":"text-embedding-nomic-embed-text-v1.5","type":"embeddings","max_context_length":2_048},
                {"id":"mistral-small-3.2","type":"vlm","max_context_length":131_072},
            ])),
        ),
        _ => (404, r#"{"error":"Unexpected endpoint"}"#.into()),
    }));
    let http = HttpClient::new().unwrap();
    let found = local::discover(http.raw(), &address(&studio), None)
        .await
        .unwrap();
    assert_eq!(found.software, Some(Software::LmStudio));
    assert_eq!(
        found
            .models
            .iter()
            .map(|m| (m.id.as_str(), m.context_window))
            .collect::<Vec<_>>(),
        [
            ("qwen/qwen3-30b-a3b", Some(32_768)),
            ("mistral-small-3.2", Some(131_072))
        ]
    );

    let llama = Fake::new(Box::new(|seen| match seen.path.as_str() {
        "/v1/models" => (
            200,
            listed(
                json!([{"id":"gpt-oss-20b","object":"model","owned_by":"llamacpp",
                "meta":{"n_ctx_train":131_072}}]),
            ),
        ),
        "/props" => (
            200,
            json!({"default_generation_settings":{"n_ctx":16_384},"total_slots":1}).to_string(),
        ),
        _ => (404, "{}".into()),
    }));
    let found = local::discover(http.raw(), &address(&llama), None)
        .await
        .unwrap();
    assert_eq!(found.software, Some(Software::LlamaCpp));
    assert_eq!(
        found.models[0].context_window,
        Some(16_384),
        "what it runs with"
    );
    assert!(!llama.paths().iter().any(|p| p.contains("/api/")));
}

#[tokio::test]
async fn an_unknown_server_keeps_its_address_name_and_row_context() {
    let fake = Fake::new(Box::new(|seen| match seen.path.as_str() {
        "/v1/models" => (
            200,
            listed(json!([
                {"id":"served-model","max_model_len":24_576},
                {"id":"bge-embeddings"},
                {"id":"served-model"},
                {"id":"  "},
                {"object":"model"},
            ])),
        ),
        _ => (404, "{}".into()),
    }));
    let http = HttpClient::new().unwrap();
    let found = local::discover(http.raw(), &address(&fake), None)
        .await
        .unwrap();
    assert_eq!(found.software, None);
    assert_eq!(found.models.len(), 1);
    assert_eq!(found.models[0].id, "served-model");
    assert_eq!(found.models[0].context_window, Some(24_576));
}

#[tokio::test]
async fn no_list_wrong_key_and_nothing_listening_are_told_apart() {
    let http = HttpClient::new().unwrap();
    for (status, body, error) in [
        (404, "{}".to_owned(), DiscoverError::NoList),
        (200, "not json".to_owned(), DiscoverError::NoList),
        (200, json!({"models":[]}).to_string(), DiscoverError::NoList),
        (500, "{}".to_owned(), DiscoverError::NoList),
        // A list, but nothing on it the Agent can use (作者 2026-11-16, 乙):
        // empty, or only an embedding model.
        (200, listed(json!([])), DiscoverError::NoToolModels),
        (
            200,
            listed(json!([{"id":"nomic-embed-text","object":"model"}])),
            DiscoverError::NoToolModels,
        ),
    ] {
        let reply = (status, body.clone());
        let fake = Fake::new(Box::new(move |_| reply.clone()));
        assert_eq!(
            local::discover(http.raw(), &address(&fake), None).await,
            Err(error),
            "{status} {body}"
        );
        // Anything answering is up, even without a model list.
        local::check(http.raw(), &address(&fake), None)
            .await
            .unwrap();
    }
    let fake = Fake::new(Box::new(|seen| {
        if seen.headers.contains("Bearer synthetic-local-key") {
            (200, listed(json!([{"id":"guarded"}])))
        } else {
            (401, r#"{"error":"unauthorized"}"#.into())
        }
    }));
    assert_eq!(
        local::discover(http.raw(), &address(&fake), None).await,
        Err(DiscoverError::Unauthorized)
    );
    assert_eq!(
        local::check(http.raw(), &address(&fake), Some("wrong")).await,
        Err(DiscoverError::Unauthorized)
    );
    let found = local::discover(http.raw(), &address(&fake), Some("synthetic-local-key"))
        .await
        .unwrap();
    assert_eq!(found.models[0].id, "guarded");
    local::check(http.raw(), &address(&fake), Some("synthetic-local-key"))
        .await
        .unwrap();

    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let closed = LocalAddress::parse(&closed).unwrap();
    assert_eq!(
        local::discover(http.raw(), &closed, None).await,
        Err(DiscoverError::Unreachable)
    );
    assert_eq!(
        local::check(http.raw(), &closed, None).await,
        Err(DiscoverError::Unreachable)
    );
}

fn chat(text: &str) -> String {
    let mut out = String::new();
    for value in [
        json!({"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{"content":"<think>check the chapter</think>\n\n"},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}),
    ] {
        out.push_str(&format!("data: {value}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn tool_call() -> String {
    let mut out = String::new();
    for value in [
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_7","index":0,"type":"function","function":{"name":"read","arguments":"{\"chapter\":1}"}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
    ] {
        out.push_str(&format!("data: {value}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn request(base_url: &str, tools: bool) -> DriverRequest {
    let mut config = RunConfig::new(Provider::Local, "qwen3:14b");
    config.route.local = Some(LocalRoute {
        server: "synthetic-server".into(),
        base_url: base_url.into(),
    });
    config.system_prompt = "synthetic system".into();
    config.web_search = true;
    DriverRequest {
        purpose: RequestPurpose::Chat,
        config: Arc::new(config),
        session: "session".into(),
        turn: 1,
        round: 1,
        conversation: vec![ConversationEntry {
            id: "session:1".into(),
            session: "session".into(),
            turn: 1,
            kind: ConversationEntryKind::User,
            payload: json!({"text":"synthetic request"}),
        }],
        tools: if tools {
            vec![ToolDescriptor {
                name: "read".into(),
                revision: "v1".into(),
                description: "synthetic read".into(),
                input_schema: json!({"type":"object"}),
                access: ToolAccess::Read,
                policy: ToolPolicy::Local,
            }]
        } else {
            Vec::new()
        },
    }
}

fn driver(credentials: Credentials) -> ProviderDriver {
    // The four providers' endpoints point nowhere: a local route must not
    // fall back to any of them.
    let nowhere = "http://127.0.0.1:9";
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        credentials,
        Endpoints {
            deepseek: nowhere.into(),
            anthropic: nowhere.into(),
            openai: nowhere.into(),
            chatgpt: nowhere.into(),
        },
        OAuthEndpoints::at(nowhere).unwrap(),
        RetryPolicy {
            max_attempts: 1,
            ..Default::default()
        },
    )
}

async fn events(
    driver: &ProviderDriver,
    request: DriverRequest,
) -> Vec<dr_agent::Result<DriverEvent>> {
    driver
        .stream(request, Cancellation::default())
        .collect()
        .await
}

#[tokio::test]
async fn a_local_chat_goes_to_its_own_server_without_a_key_or_deepseek_fields() {
    let replies = Arc::new(Mutex::new(vec![chat("The tide came in."), tool_call()]));
    let queue = replies.clone();
    let fake = Fake::new(Box::new(move |seen| match seen.path.as_str() {
        "/v1/chat/completions" => (200, queue.lock().unwrap().remove(0)),
        _ => (404, "{}".into()),
    }));
    let store = Arc::new(SecretStore::in_memory());
    let driver = driver(Credentials::new(store.clone()));
    let got = events(&driver, request(&fake.url, false)).await;
    let mut text = String::new();
    let mut thinking = String::new();
    for event in &got {
        match event.as_ref().unwrap() {
            DriverEvent::TextDelta { text: t, .. } => text.push_str(t),
            DriverEvent::ThinkingDelta { text: t, .. } => thinking.push_str(t),
            _ => {}
        }
    }
    assert_eq!(text, "The tide came in.");
    assert_eq!(thinking, "check the chapter");
    assert!(
        got.iter()
            .any(|e| matches!(e, Ok(DriverEvent::Finish(FinishReason::Complete))))
    );
    let sent = fake.requests("/v1/chat/completions");
    assert_eq!(sent.len(), 1);
    assert!(
        !sent[0]
            .headers
            .to_ascii_lowercase()
            .contains("authorization")
    );
    for absent in ["thinking", "reasoning_effort", "max_tokens", "tools"] {
        assert!(sent[0].body.get(absent).is_none(), "{absent}");
    }
    assert_eq!(sent[0].body["model"], "qwen3:14b");

    store
        .set("byok.local.synthetic-server", "synthetic-local-key")
        .unwrap();
    let got = events(&driver, request(&fake.url, true)).await;
    assert!(got.iter().any(|e| matches!(
        e,
        Ok(DriverEvent::ToolCall(call)) if call.id == "call_7" && call.arguments == json!({"chapter":1})
    )));
    let sent = fake.requests("/v1/chat/completions");
    assert!(sent[1].headers.contains("Bearer synthetic-local-key"));
    assert_eq!(sent[1].body["tools"][0]["function"]["name"], "read");
    assert!(
        fake.paths()
            .iter()
            .all(|p| p == "POST /v1/chat/completions")
    );
}

#[tokio::test]
async fn a_route_off_this_network_or_without_a_server_is_refused_before_any_request() {
    let driver = driver(Credentials::new(Arc::new(SecretStore::in_memory())));
    for base in ["https://api.example.com", "http://8.8.8.8:11434"] {
        let got = events(&driver, request(base, false)).await;
        assert!(matches!(
            got.last(),
            Some(Err(dr_agent::Error::Provider(failure)))
                if failure.category == ModelErrorCategory::Unsupported
        ));
    }
    let mut missing = request("http://localhost:11434", false);
    Arc::make_mut(&mut missing.config).route.local = None;
    let got = events(&driver, missing).await;
    assert!(matches!(
        got.last(),
        Some(Err(dr_agent::Error::Provider(failure)))
            if failure.category == ModelErrorCategory::Unsupported
    ));
    // Nothing listening: the send fails like any unreachable provider.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let got = events(&driver, request(&closed, false)).await;
    assert!(matches!(
        got.last(),
        Some(Err(dr_agent::Error::Provider(failure)))
            if failure.category == ModelErrorCategory::Network
    ));
}
