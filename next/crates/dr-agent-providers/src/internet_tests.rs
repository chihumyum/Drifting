//! A custom service on the internet (「自定义服务」, 作者 2026-11-23/24,
//! chihumyum/Drifting#3) against a loopback stand-in for
//! `https://api.example.com` ([`HttpClient::with_stand_in`]): `https` only,
//! its list and its chat through the same code as a local server, and a key
//! that goes only to its own service. Nothing here reaches a real service.
//!
//! These are unit tests, not in `tests/`: the stand-in needs `cfg(test)` or
//! the `test-support` feature, and a dev-dependency of this crate on itself
//! is a cycle the hot-reload gate refuses.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use dr_agent::{
    Cancellation, Driver, DriverEvent, DriverRequest, LocalRoute, ModelErrorCategory, Provider,
    RequestPurpose, RunConfig,
};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_platform::SecretStore;
use futures::StreamExt;
use serde_json::{Value, json};

use crate::credentials::Credentials;
use crate::local::{self, DiscoverError, LocalAddress, LocalModel, Reach};
use crate::oauth::OAuthEndpoints;
use crate::{Endpoints, HttpClient, ProviderDriver, RetryPolicy};

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    headers: String,
    body: Value,
}

type Route = Box<dyn Fn(&Seen) -> (u16, String) + Send + Sync>;

/// Answers every request until dropped. For a 3xx status the route's text
/// is the `Location`, and the body is empty.
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
                        let (status, mut body) = route(&request);
                        let mut location = String::new();
                        if (300..400).contains(&status) {
                            location = format!("Location: {body}\r\n");
                            body.clear();
                        }
                        let kind = if body.starts_with("data:") {
                            "text/event-stream"
                        } else {
                            "application/json"
                        };
                        let head = format!(
                            "HTTP/1.1 {status} Test\r\n{location}Content-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = socket.write_all(head.as_bytes());
                        let _ = socket.write_all(body.as_bytes());
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

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn requests(&self, path: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|seen| seen.path == path)
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
            let mut first = headers.lines().next()?.split(' ');
            let method = first.next()?.to_owned();
            let path = first.next()?.to_owned();
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

fn listed(rows: Value) -> String {
    json!({"object":"list","data":rows}).to_string()
}

/// A Chat Completions stream that answers `text`.
fn chat(text: &str) -> String {
    let mut out = String::new();
    for value in [
        json!({"choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}),
    ] {
        out.push_str(&format!("data: {value}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn request(server: &str, base_url: &str) -> DriverRequest {
    let mut config = RunConfig::new(Provider::Local, "example-chat-large");
    config.route.local = Some(LocalRoute {
        server: server.into(),
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
        tools: Vec::new(),
    }
}

fn driver(http: HttpClient, store: Arc<SecretStore>) -> ProviderDriver {
    // The four providers' endpoints point nowhere: a custom route must not
    // fall back to any of them.
    let nowhere = "http://127.0.0.1:9";
    ProviderDriver::with_endpoints(
        http,
        Credentials::new(store),
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

fn text_of(got: &[dr_agent::Result<DriverEvent>]) -> String {
    got.iter()
        .filter_map(|event| match event {
            Ok(DriverEvent::TextDelta { text, .. }) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// Plain http to the internet, another scheme, a user and password: refused
/// before any request. Were one sent, the stand-in would see it.
#[tokio::test]
async fn plain_http_to_the_internet_is_refused_before_any_request() {
    let fake = Fake::new(Box::new(|_| (200, chat("should not be asked"))));
    let http = HttpClient::new()
        .unwrap()
        .with_stand_in("http://api.example.com", &fake.url)
        .with_stand_in("ftp://api.example.com", &fake.url)
        .with_stand_in("https://user:pass@api.example.com", &fake.url);
    let driver = driver(http.clone(), Arc::new(SecretStore::in_memory()));
    for base in [
        "http://api.example.com",
        "ftp://api.example.com",
        "https://user:pass@api.example.com",
    ] {
        let got = events(&driver, request("synthetic-server", base)).await;
        assert!(
            matches!(
                got.last(),
                Some(Err(dr_agent::Error::Provider(failure)))
                    if failure.category == ModelErrorCategory::Unsupported
            ),
            "{base}"
        );
    }
    assert_eq!(
        LocalAddress::parse("http://api.example.com/v1"),
        Err(local::AddressError::NeedsHttps),
        "and the form cannot ask its list"
    );
    assert!(fake.seen().is_empty(), "refused before any request");
}

#[tokio::test]
async fn a_service_on_the_internet_is_listed_and_chatted_with_over_https() {
    let fake = Fake::new(Box::new(|seen| {
        match (seen.method.as_str(), seen.path.as_str()) {
            ("GET", "/v1/models") if seen.headers.contains("Bearer synthetic-service-key") => (
                200,
                listed(json!([
                    {"id":"example-chat-large","object":"model","owned_by":"example","context_length":131_072},
                    {"id":"example-embed-v2","object":"model","owned_by":"example"},
                ])),
            ),
            ("GET", "/v1/models") => (401, r#"{"error":"unauthorized"}"#.into()),
            ("POST", "/v1/chat/completions") => (200, chat("Answered from the service.")),
            _ => (404, "{}".into()),
        }
    }));
    let http = HttpClient::new()
        .unwrap()
        .with_stand_in("https://api.example.com", &fake.url);
    let address = LocalAddress::parse("https://api.example.com/v1").unwrap();
    assert_eq!(address.reach, Reach::Internet);
    assert_eq!(address.display, "api.example.com");
    assert_eq!(
        local::discover(&http, &address, None).await,
        Err(DiscoverError::Unauthorized)
    );
    let found = local::discover(&http, &address, Some("synthetic-service-key"))
        .await
        .unwrap();
    assert_eq!(found.software, None, "nothing recognized");
    assert_eq!(
        found.models,
        [LocalModel {
            id: "example-chat-large".into(),
            context_window: Some(131_072),
        }]
    );
    local::check(&http, &address, Some("synthetic-service-key"))
        .await
        .unwrap();

    let store = Arc::new(SecretStore::in_memory());
    store
        .set("byok.local.synthetic-server", "synthetic-service-key")
        .unwrap();
    let driver = driver(http, store);
    let got = events(&driver, request("synthetic-server", &address.base_url)).await;
    assert_eq!(text_of(&got), "Answered from the service.");
    let sent = fake.requests("/v1/chat/completions");
    assert_eq!(sent.len(), 1);
    assert!(sent[0].headers.contains("Bearer synthetic-service-key"));
    for absent in [
        "thinking",
        "reasoning_effort",
        "tools",
        "web_search_options",
    ] {
        assert!(sent[0].body.get(absent).is_none(), "{absent}");
    }
}

/// A key goes to the service it was stored for and nowhere else: not to
/// another server, and not along a redirect (the clients follow none).
#[tokio::test]
async fn a_key_goes_only_to_its_own_service_and_never_along_a_redirect() {
    let other = Fake::new(Box::new(|seen| match seen.path.as_str() {
        "/v1/chat/completions" => (200, chat("From the other server.")),
        _ => (200, listed(json!([{"id":"other-model"}]))),
    }));
    let elsewhere = other.url.clone();
    let service = Fake::new(Box::new(move |seen| {
        (307, format!("{elsewhere}{}", seen.path))
    }));
    let http = HttpClient::new()
        .unwrap()
        .with_stand_in("https://api.example.com", &service.url);
    let store = Arc::new(SecretStore::in_memory());
    store.set("byok.local.server-a", "synthetic-key-a").unwrap();
    store.set("byok.local.server-b", "synthetic-key-b").unwrap();
    let driver = driver(http.clone(), store);

    let got = events(&driver, request("server-a", "https://api.example.com")).await;
    assert!(
        matches!(got.last(), Some(Err(_))),
        "a redirect is a failure"
    );
    let address = LocalAddress::parse("https://api.example.com").unwrap();
    assert_eq!(
        local::discover(&http, &address, Some("synthetic-key-a")).await,
        Err(DiscoverError::NoList),
        "the redirect is not followed"
    );
    assert!(other.seen().is_empty(), "nothing reached the other server");
    let asked = service.seen();
    assert!(!asked.is_empty());
    assert!(
        asked
            .iter()
            .all(|seen| seen.headers.contains("Bearer synthetic-key-a"))
    );

    // The other server's own route carries its own key only.
    let got = events(&driver, request("server-b", &other.url)).await;
    assert_eq!(text_of(&got), "From the other server.");
    let sent = other.requests("/v1/chat/completions");
    assert_eq!(sent.len(), 1);
    assert!(sent[0].headers.contains("Bearer synthetic-key-b"));
    assert!(!sent[0].headers.contains("synthetic-key-a"));
}
