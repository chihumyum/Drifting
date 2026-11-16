//! 「本地模型」 in the companion and Settings, against a synthetic routed
//! loopback service (作者 2026-11-16 定稿). No real model server is used.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use dr_agent::{Provider, ThinkingLevel};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_platform::SecretStore;
use dr_shell::{
    Settings,
    settings::{SettingsFile, registry},
};
use dr_view_agent::{
    connection::{ConnectionService, Connections, PROVIDERS},
    local::{self, KeyChange, LocalFailure, Probe},
    local_view::{self, FormState, LocalConnectionView},
};
use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

#[derive(Clone)]
struct Seen {
    path: String,
    headers: String,
    body: String,
}

type Route = Box<dyn Fn(&str, &str, &str) -> (u16, String) + Send + Sync>;

struct Fake {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Fake {
    /// `route(path, headers, body)`.
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
                        let Some((path, headers, body)) = read(&mut socket) else {
                            continue;
                        };
                        log.lock().unwrap().push(Seen {
                            path: path.clone(),
                            headers: headers.clone(),
                            body: body.clone(),
                        });
                        let (status, body) = route(&path, &headers, &body);
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

    fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
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

fn read(socket: &mut TcpStream) -> Option<(String, String, String)> {
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
            let path = headers.lines().next()?.split(' ').nth(1)?.to_owned();
            let body =
                String::from_utf8_lossy(&bytes[end + 4..(end + 4 + length).min(bytes.len())])
                    .into_owned();
            return Some((path, headers, body));
        }
    }
}

fn listed(rows: Value) -> String {
    json!({"object":"list","data":rows}).to_string()
}

/// A Chat Completions stream that thinks, then answers 「OK」.
fn says_ok() -> String {
    let mut out = String::new();
    for value in [
        json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"<think>one word</think>"},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
    ] {
        out.push_str(&format!("data: {value}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

/// Holds a reply back until the test opens it (at most 20 s).
#[derive(Clone, Default)]
struct Gate(Arc<(Mutex<bool>, std::sync::Condvar)>);

impl Gate {
    fn open(&self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }

    fn wait(&self) {
        let (open, signal) = &*self.0;
        let guard = open.lock().unwrap();
        let _ = signal
            .wait_timeout_while(guard, Duration::from_secs(20), |open| !*open)
            .unwrap();
    }
}

/// An Ollama-like service: two tool models, one without tools, one embedding.
fn ollama() -> Fake {
    Fake::new(Box::new(|path, _, body| match path {
        "/v1/models" => (
            200,
            listed(json!([
                {"id":"qwen3:14b"},{"id":"llama3.1:8b"},{"id":"gemma3:12b"},{"id":"nomic-embed-text"}
            ])),
        ),
        "/api/version" => (200, json!({"version":"0.12.0"}).to_string()),
        "/v1/chat/completions" => (200, says_ok()),
        "/api/show" => {
            let capabilities = if body.contains("gemma3") {
                json!(["completion", "vision"])
            } else if body.contains("embed") {
                json!(["embedding"])
            } else {
                json!(["completion", "tools"])
            };
            let context = if body.contains("qwen3") {
                40_960
            } else {
                131_072
            };
            (
                200,
                json!({"capabilities":capabilities,
                       "model_info":{"general.architecture":"arch","arch.context_length":context}})
                .to_string(),
            )
        }
        _ => (404, "{}".into()),
    }))
}

fn service(store: Arc<SecretStore>) -> ConnectionService {
    let nowhere = "http://127.0.0.1:9";
    let driver = ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
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
    );
    let mut service = ConnectionService::new(driver);
    for provider in PROVIDERS {
        service = service.with_catalog_endpoint(provider, format!("{nowhere}/models"));
    }
    service
}

fn shell(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(
            dr_shell::ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "lm-local-models-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            dr_shell::Services::default(),
            SettingsFile::in_memory(),
            cx,
        );
    });
}

fn open(
    cx: &mut TestAppContext,
    store: Arc<SecretStore>,
    settings: bool,
) -> (
    Entity<Connections>,
    Entity<LocalConnectionView>,
    &mut VisualTestContext,
) {
    open_with(cx, service(store), settings)
}

fn open_with(
    cx: &mut TestAppContext,
    service: ConnectionService,
    settings: bool,
) -> (
    Entity<Connections>,
    Entity<LocalConnectionView>,
    &mut VisualTestContext,
) {
    let connections = cx.new(|cx| Connections::with_service(service, cx));
    let shared = connections.clone();
    let (view, vcx) = cx
        .add_window_view(move |window, cx| LocalConnectionView::new(shared, settings, window, cx));
    (connections, view, vcx)
}

fn wait(vcx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        vcx.run_until_parked();
        vcx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        if done(vcx) {
            return;
        }
        assert!(Instant::now() < deadline, "local model step did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn form(view: &Entity<LocalConnectionView>, vcx: &VisualTestContext) -> Option<FormState> {
    view.read_with(vcx, |view, _| view.form_state())
}

/// Type an address (and optionally a key) and press 「连接」.
fn connect(
    view: &Entity<LocalConnectionView>,
    vcx: &mut VisualTestContext,
    address: &str,
    key: Option<&str>,
) {
    let [address_field, key_field, _] = view.read_with(vcx, |view, _| view.fields());
    if form(view, vcx).is_none() {
        view.update_in(vcx, |view, window, cx| view.open_new(window, cx));
    }
    address_field.update(vcx, |field, cx| field.set_text(address, cx));
    if let Some(key) = key {
        view.update_in(vcx, |view, window, cx| view.show_key(window, cx));
        key_field.update(vcx, |field, cx| field.set_text(key, cx));
    }
    view.update_in(vcx, |view, window, cx| view.submit(window, cx));
}

fn device_list(vcx: &mut VisualTestContext) -> Option<Value> {
    vcx.update(|_, cx| Settings::device_memory(cx, local::SERVERS_KEY))
}

#[gpui::test]
fn connecting_selects_the_first_tool_model_and_freezes_its_server(cx: &mut TestAppContext) {
    shell(cx);
    let fake = ollama();
    let store = Arc::new(SecretStore::in_memory());
    let (connections, view, vcx) = open(cx, store.clone(), false);
    // Nothing is connected yet (once the startup keychain check is done).
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| c.usable() == Some(false))
    });
    connect(&view, vcx, &fake.url, None);
    wait(vcx, |vcx| form(&view, vcx).is_none());
    let (servers, preferences, config) = connections.read_with(vcx, |c, _| {
        (
            c.local_servers().to_vec(),
            c.preferences().clone(),
            c.run_config().unwrap(),
        )
    });
    assert_eq!(servers.len(), 1);
    let server = &servers[0];
    assert_eq!(server.label, "Ollama");
    assert!(!server.has_key && !server.manual);
    // gemma3 (no tools) and the embedding model are not offered.
    assert_eq!(
        server
            .models
            .iter()
            .map(|m| (m.id.as_str(), m.context))
            .collect::<Vec<_>>(),
        [("qwen3:14b", Some(40_960)), ("llama3.1:8b", Some(131_072))]
    );
    let asked: Vec<String> = fake.requests().into_iter().map(|seen| seen.path).collect();
    assert!(asked.iter().any(|path| path == "/api/version"));
    assert_eq!(asked.iter().filter(|path| *path == "/api/show").count(), 4);
    assert!(
        !asked.iter().any(|path| path.contains("chat")),
        "connecting asks for the list, never a chat"
    );
    assert_eq!(preferences.route.provider, Provider::Local);
    assert_eq!(preferences.route.model, "qwen3:14b");
    assert_eq!(
        preferences.local_server.as_deref(),
        Some(server.id.as_str())
    );
    assert_eq!(config.route.thinking, ThinkingLevel::Off);
    assert!(!config.web_search);
    let route = config.route.local.as_ref().unwrap();
    assert_eq!(route.base_url, fake.url);
    assert_eq!(route.server, server.id);
    assert_eq!(
        config.capabilities.as_ref().unwrap().context_window,
        Some(40_960)
    );
    config.validate().unwrap();
    assert!(
        store
            .get(&format!("byok.local.{}", server.id))
            .unwrap()
            .is_none()
    );
    // The list is this device's memory; the account keeps only the route.
    let stored = device_list(vcx).unwrap();
    assert_eq!(stored[0]["base_url"], fake.url.as_str());
    assert!(!stored.to_string().contains("synthetic"));
    let (provider, model) = vcx.update(|_, cx| {
        let file = Settings::read(cx);
        (
            file.get(registry::AGENT_PROVIDER),
            file.get(registry::AGENT_MODEL),
        )
    });
    assert_eq!(provider, json!("local"));
    assert_eq!(model, json!("qwen3:14b"));
    assert_eq!(
        vcx.update(|_, cx| local::read_selected(cx)),
        Some(server.id.clone())
    );
    connections.read_with(vcx, |c, _| {
        assert!(!local_view::has_reasoning(c), "no reasoning control");
        assert_eq!(
            local_view::routes(c)
                .into_iter()
                .map(|(_, _, label)| label)
                .collect::<Vec<_>>(),
            ["Ollama · qwen3:14b", "Ollama · llama3.1:8b"]
        );
    });

    // A second Ollama is named by its address.
    let second = ollama();
    connect(&view, vcx, &second.url, None);
    wait(vcx, |vcx| form(&view, vcx).is_none());
    let labels: Vec<String> = connections.read_with(vcx, |c, _| {
        c.local_servers().iter().map(|s| s.label.clone()).collect()
    });
    assert_eq!(labels[0], "Ollama");
    assert_eq!(
        labels[1],
        second.url.replace("http://127.0.0.1", "localhost")
    );

    // A fresh Connections (the next launch) reads the same list and route.
    let reread = vcx.update(|_, cx| cx.new(|cx| Connections::with_service(service(store), cx)));
    reread.read_with(vcx, |c, _| {
        assert_eq!(c.local_servers().len(), 2);
        assert_eq!(c.usable(), Some(true));
        assert_eq!(c.selected_local().unwrap().1.id, "qwen3:14b");
    });
}

#[gpui::test]
fn the_form_reports_not_local_unreachable_and_a_refused_key(cx: &mut TestAppContext) {
    shell(cx);
    let guarded = Fake::new(Box::new(|path, headers, _| match path {
        "/v1/models" if headers.contains("Bearer synthetic-local-key") => {
            (200, listed(json!([{"id":"guarded-model"}])))
        }
        "/v1/models" => (401, "{}".into()),
        _ => (404, "{}".into()),
    }));
    let store = Arc::new(SecretStore::in_memory());
    let (connections, view, vcx) = open(cx, store.clone(), false);
    connect(&view, vcx, "https://api.example.com/v1", None);
    wait(vcx, |vcx| {
        form(&view, vcx).is_some_and(|f| f.error.is_some())
    });
    assert_eq!(
        form(&view, vcx).unwrap().error,
        Some(LocalFailure::NotLocal)
    );
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    connect(&view, vcx, &closed, None);
    wait(vcx, |vcx| {
        form(&view, vcx).is_some_and(|f| !f.busy && f.error == Some(LocalFailure::Unreachable))
    });
    connect(&view, vcx, &guarded.url, None);
    wait(vcx, |vcx| {
        form(&view, vcx).is_some_and(|f| !f.busy && f.error == Some(LocalFailure::InvalidKey))
    });
    assert!(connections.read_with(vcx, |c, _| c.local_servers().is_empty()));
    // The key field opens with 「加 Key」; the key is kept only after it worked.
    connect(&view, vcx, &guarded.url, Some("synthetic-local-key"));
    wait(vcx, |vcx| form(&view, vcx).is_none());
    let server = connections.read_with(vcx, |c, _| c.local_servers()[0].clone());
    assert!(server.has_key);
    assert_eq!(
        store
            .get(&format!("byok.local.{}", server.id))
            .unwrap()
            .as_deref(),
        Some("synthetic-local-key")
    );
    assert!(
        !device_list(vcx)
            .unwrap()
            .to_string()
            .contains("synthetic-local-key")
    );

    // 「编辑密钥」, emptied, 「连接」: the key goes — but only if the server
    // still answers without it. This one does not, so it stays.
    view.update_in(vcx, |view, window, cx| {
        view.open_server(&server.id, true, window, cx)
    });
    assert!(form(&view, vcx).unwrap().key_open);
    view.update_in(vcx, |view, window, cx| view.submit(window, cx));
    wait(vcx, |vcx| {
        form(&view, vcx).is_some_and(|f| !f.busy && f.error == Some(LocalFailure::InvalidKey))
    });
    assert!(
        store
            .get(&format!("byok.local.{}", server.id))
            .unwrap()
            .is_some()
    );
    // 「改地址」 with the key field closed keeps the stored key.
    view.update_in(vcx, |view, window, cx| {
        view.open_server(&server.id, false, window, cx)
    });
    view.update_in(vcx, |view, window, cx| view.submit(window, cx));
    wait(vcx, |vcx| form(&view, vcx).is_none());
    assert!(connections.read_with(vcx, |c, _| c.local_servers()[0].has_key));
}

#[gpui::test]
fn emptying_the_key_removes_it_when_the_server_needs_none(cx: &mut TestAppContext) {
    shell(cx);
    let fake = Fake::new(Box::new(|path, _, _| match path {
        "/v1/models" => (200, listed(json!([{"id":"open-model"}]))),
        _ => (404, "{}".into()),
    }));
    let store = Arc::new(SecretStore::in_memory());
    let (connections, view, vcx) = open(cx, store.clone(), true);
    connect(&view, vcx, &fake.url, Some("synthetic-extra-key"));
    wait(vcx, |vcx| form(&view, vcx).is_none());
    let id = connections.read_with(vcx, |c, _| c.local_servers()[0].id.clone());
    assert!(store.get(&format!("byok.local.{id}")).unwrap().is_some());
    assert!(
        fake.requests()
            .iter()
            .any(|seen| seen.headers.contains("Bearer synthetic-extra-key"))
    );
    view.update_in(vcx, |view, window, cx| {
        view.open_server(&id, true, window, cx)
    });
    view.update_in(vcx, |view, window, cx| view.submit(window, cx));
    wait(vcx, |vcx| form(&view, vcx).is_none());
    assert!(store.get(&format!("byok.local.{id}")).unwrap().is_none());
    let server = connections.read_with(vcx, |c, _| c.local_servers()[0].clone());
    assert!(!server.has_key);
    assert_eq!(server.id, id, "the same server, edited");
    assert_eq!(
        server.label,
        fake.url.replace("http://127.0.0.1", "localhost")
    );
}

#[gpui::test]
fn without_a_model_list_the_form_asks_for_a_model_name(cx: &mut TestAppContext) {
    shell(cx);
    let fake = Fake::new(Box::new(|_, _, _| (404, "{}".into())));
    let store = Arc::new(SecretStore::in_memory());
    let (connections, view, vcx) = open(cx, store, true);
    connect(&view, vcx, &fake.url, None);
    wait(vcx, |vcx| {
        form(&view, vcx).is_some_and(|f| f.asks_model_name)
    });
    assert!(connections.read_with(vcx, |c, _| c.local_servers().is_empty()));
    let [_, _, name] = view.read_with(vcx, |view, _| view.fields());
    name.update(vcx, |field, cx| field.set_text("  ", cx));
    view.update_in(vcx, |view, window, cx| view.submit_model_name(window, cx));
    assert!(
        form(&view, vcx).unwrap().asks_model_name,
        "a blank name adds nothing"
    );
    name.update(vcx, |field, cx| field.set_text(" typed-model ", cx));
    view.update_in(vcx, |view, window, cx| view.submit_model_name(window, cx));
    wait(vcx, |vcx| form(&view, vcx).is_none());
    let server = connections.read_with(vcx, |c, _| c.local_servers()[0].clone());
    assert!(server.manual);
    assert_eq!(server.models[0].id, "typed-model");
    assert_eq!(
        connections.read_with(vcx, |c, _| c.run_config().unwrap().route.model),
        "typed-model"
    );
    // More names in Settings; the × on the last one disconnects the server.
    connections.update(vcx, |c, cx| {
        assert!(c.add_local_model(&server.id, "second-model", cx));
        assert!(!c.add_local_model(&server.id, "\n", cx));
        c.remove_local_model(&server.id, "typed-model", cx);
    });
    assert_eq!(
        connections.read_with(vcx, |c, _| c.local_servers()[0]
            .models
            .iter()
            .map(|m| m.id.clone())
            .collect::<Vec<_>>()),
        ["second-model"]
    );
    assert_eq!(
        connections.read_with(vcx, |c, _| c.usable()),
        Some(false),
        "the selected typed model is gone"
    );
    connections.update(vcx, |c, cx| {
        c.remove_local_model(&server.id, "second-model", cx)
    });
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| c.local_servers().is_empty())
    });
    assert!(device_list(vcx).is_none());
}

#[gpui::test]
fn settings_context_test_and_disconnect(cx: &mut TestAppContext) {
    shell(cx);
    let fake = ollama();
    let store = Arc::new(SecretStore::in_memory());
    let (connections, view, vcx) = open(cx, store.clone(), true);
    connect(&view, vcx, &fake.url, Some("synthetic-local-key"));
    wait(vcx, |vcx| form(&view, vcx).is_none());
    let id = connections.read_with(vcx, |c, _| c.local_servers()[0].id.clone());
    let context = |vcx: &mut VisualTestContext| {
        connections.read_with(vcx, |c, _| {
            c.run_config().unwrap().capabilities.unwrap().context_window
        })
    };
    assert_eq!(context(vcx), Some(40_960));
    connections.update(vcx, |c, cx| {
        c.set_local_context(&id, "qwen3:14b", Some(16_384), cx)
    });
    assert_eq!(context(vcx), Some(16_384), "the author's value wins");
    assert_eq!(
        device_list(vcx).unwrap()[0]["models"][0]["context_override"],
        16_384
    );
    connections.update(vcx, |c, cx| c.set_local_context(&id, "qwen3:14b", None, cx));
    assert_eq!(context(vcx), Some(40_960));

    connections.update(vcx, |c, cx| c.test_local(&id, cx));
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| {
            c.local_test.as_ref().is_some_and(|(_, r)| r.is_some())
        })
    });
    assert_eq!(
        connections.read_with(vcx, |c, _| c.local_test.clone()),
        Some((id.clone(), Some(Ok(()))))
    );
    assert!(
        fake.requests()
            .last()
            .is_some_and(|seen| seen.headers.contains("Bearer synthetic-local-key"))
    );
    drop(fake);
    connections.update(vcx, |c, cx| c.test_local(&id, cx));
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| {
            c.local_test.as_ref().is_some_and(|(_, r)| r.is_some())
        })
    });
    assert_eq!(
        connections.read_with(vcx, |c, _| c.local_test.clone()),
        Some((id.clone(), Some(Err(LocalFailure::Unreachable))))
    );
    // A server that is down still counts as connected (no special state).
    assert_eq!(connections.read_with(vcx, |c, _| c.usable()), Some(true));

    connections.update(vcx, |c, cx| c.disconnect_local(&id, cx));
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| c.local_servers().is_empty())
    });
    assert!(store.get(&format!("byok.local.{id}")).unwrap().is_none());
    assert_eq!(connections.read_with(vcx, |c, _| c.usable()), Some(false));
}

#[gpui::test]
fn choosing_a_cloud_model_keeps_its_reasoning_level(cx: &mut TestAppContext) {
    shell(cx);
    let fake = ollama();
    let store = Arc::new(SecretStore::in_memory());
    store.set("byok.deepseek", "synthetic-deepseek").unwrap();
    let (connections, view, vcx) = open(cx, store, false);
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| c.usable() == Some(true))
    });
    connections.update(vcx, |c, cx| {
        assert!(c.select_provider(Provider::Deepseek, cx));
        assert!(c.set_thinking(ThinkingLevel::Max, cx));
    });
    connect(&view, vcx, &fake.url, None);
    wait(vcx, |vcx| form(&view, vcx).is_none());
    assert_eq!(
        connections.read_with(vcx, |c, _| c.run_config().unwrap().route.thinking),
        ThinkingLevel::Off
    );
    connections.update(vcx, |c, cx| {
        assert!(c.select_provider(Provider::Deepseek, cx));
    });
    connections.read_with(vcx, |c, _| {
        assert_eq!(c.preferences().route.thinking, ThinkingLevel::Max);
        assert_eq!(c.preferences().local_server, None);
        assert!(local_view::has_reasoning(c));
    });
    assert_eq!(vcx.update(|_, cx| local::read_selected(cx)), None);
}

#[tokio::test]
async fn the_service_probes_keys_and_refuses_the_internet_before_asking() {
    let fake = ollama();
    let store = Arc::new(SecretStore::in_memory());
    let service = service(store.clone());
    assert_eq!(
        service
            .probe_local("https://api.example.com", &KeyChange::Keep, None)
            .await
            .unwrap_err(),
        LocalFailure::NotLocal
    );
    assert_eq!(
        service
            .probe_local("ftp://localhost", &KeyChange::Keep, None)
            .await
            .unwrap_err(),
        LocalFailure::Unreachable
    );
    let (address, probe) = service
        .probe_local(&format!("{}/v1/", fake.url), &KeyChange::Keep, None)
        .await
        .unwrap();
    assert_eq!(address.base_url, fake.url);
    assert!(matches!(probe, Probe::Listed(found) if found.models.len() == 2));
    // Keep with a stored key sends it; Clear sends none.
    store.set("byok.local.edited", "synthetic-stored").unwrap();
    service
        .probe_local(&fake.url, &KeyChange::Keep, Some("edited"))
        .await
        .unwrap();
    assert!(
        fake.requests()
            .iter()
            .any(|seen| seen.headers.contains("Bearer synthetic-stored"))
    );
    let before = fake.requests().len();
    service
        .probe_local(&fake.url, &KeyChange::Clear, Some("edited"))
        .await
        .unwrap();
    assert!(
        fake.requests()[before..]
            .iter()
            .all(|seen| !seen.headers.to_ascii_lowercase().contains("authorization"))
    );
    service
        .apply_local_key("edited", &KeyChange::Keep)
        .await
        .unwrap();
    assert!(store.get("byok.local.edited").unwrap().is_some());
    service
        .apply_local_key("edited", &KeyChange::Clear)
        .await
        .unwrap();
    assert!(store.get("byok.local.edited").unwrap().is_none());
    service
        .apply_local_key("edited", &KeyChange::Set(" synthetic-new ".into()))
        .await
        .unwrap();
    assert_eq!(
        store.get("byok.local.edited").unwrap().as_deref(),
        Some("synthetic-new")
    );
}

#[test]
fn the_account_keeps_local_as_a_provider_and_nothing_else() {
    let mut file = SettingsFile::in_memory();
    file.set(registry::AGENT_PROVIDER, json!("local"), None)
        .unwrap();
    assert!(
        registry::find(local::SERVERS_KEY).is_none(),
        "the server list is not a setting"
    );
    assert!(registry::find(local::SELECTED_KEY).is_none());
    assert!(
        registry::info_in(registry::Section::Models).any(|row| row.id == "models.local"),
        "Settings → 模型与 API has the local row"
    );
}

/// 作者 2026-11-16 (乙): the server gave its list, but nothing on it can use
/// tools. Nothing is connected, the form says why, and it does not ask for
/// a model name (that is only for a server with no list).
#[gpui::test]
fn a_list_with_no_tool_model_stays_unconnected_and_says_why(cx: &mut TestAppContext) {
    shell(cx);
    cx.update(|cx| dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx));
    let fake = Fake::new(Box::new(|path, _, body| match path {
        "/v1/models" => (
            200,
            listed(json!([{"id":"gemma3:12b"},{"id":"nomic-embed-text"}])),
        ),
        "/api/version" => (200, json!({"version":"0.12.0"}).to_string()),
        "/api/show" => {
            let capabilities = if body.contains("embed") {
                json!(["embedding"])
            } else {
                json!(["completion", "vision"])
            };
            (200, json!({"capabilities":capabilities}).to_string())
        }
        _ => (404, "{}".into()),
    }));
    let store = Arc::new(SecretStore::in_memory());
    let (connections, view, vcx) = open(cx, store, false);
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| c.usable() == Some(false))
    });
    connect(&view, vcx, &fake.url, None);
    wait(vcx, |vcx| {
        form(&view, vcx).is_some_and(|f| !f.busy && f.error.is_some())
    });
    let state = form(&view, vcx).unwrap();
    assert_eq!(state.error, Some(LocalFailure::NoToolModels));
    assert!(!state.asks_model_name, "no 「模型名」 field");
    assert_eq!(
        vcx.update(|_, cx| local_view::failure_text(LocalFailure::NoToolModels, cx)),
        "这台服务上没有能用工具的模型"
    );
    assert!(connections.read_with(vcx, |c, _| c.local_servers().is_empty()));
    assert_eq!(connections.read_with(vcx, |c, _| c.usable()), Some(false));
    assert!(device_list(vcx).is_none());
    assert!(
        !fake
            .requests()
            .iter()
            .any(|seen| seen.path.contains("chat"))
    );
    // A server with no list at all still asks for a model name.
    let silent = Fake::new(Box::new(|_, _, _| (404, "{}".into())));
    connect(&view, vcx, &silent.url, None);
    wait(vcx, |vcx| {
        form(&view, vcx).is_some_and(|f| f.asks_model_name && f.error.is_none())
    });
}

fn tool_models() -> String {
    listed(json!([{"id":"first-model"},{"id":"second-model"}]))
}

fn chat_requests(fake: &Fake) -> Vec<Value> {
    fake.requests()
        .into_iter()
        .filter(|seen| seen.path == "/v1/chat/completions")
        .map(|seen| serde_json::from_str(&seen.body).unwrap())
        .collect()
}

fn tested(
    connections: &Entity<Connections>,
    vcx: &mut VisualTestContext,
    id: &str,
) -> Option<Result<(), LocalFailure>> {
    connections.update(vcx, |c, cx| c.test_local(id, cx));
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| {
            c.local_test.as_ref().is_some_and(|(_, r)| r.is_some())
        })
    });
    connections.read_with(vcx, |c, _| {
        c.local_test
            .clone()
            .filter(|(test, _)| test == id)
            .and_then(|(_, result)| result)
    })
}

/// 「测试连接」 (作者 2026-11-16, 乙): one short sentence to the model, and
/// 「可用」 only once the model has answered. The model asked is the one
/// selected on this server, else the server's first. A refused key and a
/// server that is gone each say so.
#[gpui::test]
fn testing_a_connection_waits_for_the_model_to_answer(cx: &mut TestAppContext) {
    shell(cx);
    let gate = Gate::default();
    let refuse = Arc::new(AtomicBool::new(false));
    let (held, refusing) = (gate.clone(), refuse.clone());
    let fake = Fake::new(Box::new(move |path, _, _| match path {
        "/v1/models" => (200, tool_models()),
        "/v1/chat/completions" if refusing.load(Ordering::SeqCst) => {
            (401, r#"{"error":"unauthorized"}"#.into())
        }
        "/v1/chat/completions" => {
            held.wait();
            (200, says_ok())
        }
        _ => (404, "{}".into()),
    }));
    let store = Arc::new(SecretStore::in_memory());
    store.set("byok.deepseek", "synthetic-deepseek").unwrap();
    let service = service(store).with_local_test_wait(Duration::from_secs(30));
    let (connections, view, vcx) = open_with(cx, service, true);
    connect(&view, vcx, &fake.url, None);
    wait(vcx, |vcx| form(&view, vcx).is_none());
    assert!(chat_requests(&fake).is_empty(), "connecting only lists");
    let id = connections.read_with(vcx, |c, _| c.local_servers()[0].id.clone());
    connections.update(vcx, |c, cx| {
        assert!(c.select_local(&id, "second-model", cx));
    });

    connections.update(vcx, |c, cx| c.test_local(&id, cx));
    wait(vcx, |_| !chat_requests(&fake).is_empty());
    std::thread::sleep(Duration::from_millis(200));
    vcx.run_until_parked();
    assert_eq!(
        connections.read_with(vcx, |c, _| c.local_test.clone()),
        Some((id.clone(), None)),
        "no 「可用」 while the model has not answered"
    );
    gate.open();
    wait(vcx, |vcx| {
        connections.read_with(vcx, |c, _| {
            c.local_test.as_ref().is_some_and(|(_, r)| r.is_some())
        })
    });
    assert_eq!(
        connections.read_with(vcx, |c, _| c.local_test.clone()),
        Some((id.clone(), Some(Ok(()))))
    );
    let sent = chat_requests(&fake);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["model"], "second-model");
    assert!(sent[0].to_string().contains("Return exactly OK."));
    assert!(sent[0].get("tools").is_none() && sent[0].get("thinking").is_none());

    // A cloud model is selected: the server's first model is asked.
    connections.update(vcx, |c, cx| {
        assert!(c.select_provider(Provider::Deepseek, cx));
    });
    assert_eq!(tested(&connections, vcx, &id), Some(Ok(())));
    assert_eq!(chat_requests(&fake).last().unwrap()["model"], "first-model");

    // The model refuses the key: 「密钥无效」.
    refuse.store(true, Ordering::SeqCst);
    assert_eq!(
        tested(&connections, vcx, &id),
        Some(Err(LocalFailure::InvalidKey))
    );

    // The server is gone: 「连不上这个地址」.
    drop(fake);
    assert_eq!(
        tested(&connections, vcx, &id),
        Some(Err(LocalFailure::Unreachable))
    );
}

/// A model that has not answered when the wait is up (minutes in the app,
/// a moment here) is a failed request, not 「可用」 and not 「连不上」.
#[gpui::test]
fn a_model_that_does_not_answer_in_time_fails_the_test(cx: &mut TestAppContext) {
    shell(cx);
    cx.update(|cx| dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx));
    let gate = Gate::default();
    let held = gate.clone();
    let fake = Fake::new(Box::new(move |path, _, _| match path {
        "/v1/models" => (200, tool_models()),
        "/v1/chat/completions" => {
            held.wait();
            (200, says_ok())
        }
        _ => (404, "{}".into()),
    }));
    let store = Arc::new(SecretStore::in_memory());
    let service = service(store).with_local_test_wait(Duration::from_millis(300));
    let (connections, view, vcx) = open_with(cx, service, true);
    connect(&view, vcx, &fake.url, None);
    wait(vcx, |vcx| form(&view, vcx).is_none());
    let id = connections.read_with(vcx, |c, _| c.local_servers()[0].id.clone());
    assert_eq!(
        tested(&connections, vcx, &id),
        Some(Err(LocalFailure::RequestFailed))
    );
    assert_eq!(chat_requests(&fake).len(), 1);
    // The words are the existing request-failed line.
    assert_eq!(
        vcx.update(|_, cx| local_view::failure_text(LocalFailure::RequestFailed, cx)),
        "请求失败（provider 不可用或网络问题）"
    );
    gate.open();
}
