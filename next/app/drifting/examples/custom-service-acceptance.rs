//! 「自定义服务」 with a service on the internet, in a real window
//! (`crates/dr-view-agent/scenarios/custom-service.json`): a throwaway tiny
//! library, an in-memory secret store, and a loopback stand-in that takes
//! what is meant for `https://api.example.com` (dr-agent-providers'
//! `HttpClient::with_stand_in`, as an injected name resolution would). The
//! Agent's runs go through the real model transport to that stand-in. No
//! real service, key or model. Never built as the release app.

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use dr_agent::Provider;
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::id::BookId;
use dr_shell::{
    Services, SettingsFile, ShellInfo,
    nav::{Open, Target},
    panes::PaneId,
    workspace::RightTab,
};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace;
use gpui::{App, Global};
use serde_json::json;

/// What the scenario types into the key field.
const KEY: &str = "synthetic-ca-window-key";
/// The stand-in's one answer.
const ANSWER: &str = "潮水退回去以前，她又核对了一遍记录。";

struct Fixture {
    _directory: tempfile::TempDir,
    _server: Service,
}
impl Global for Fixture {}

/// The stand-in for a service on the internet: an OpenAI-compatible list
/// (with the key; 401 without) and Chat Completions.
struct Service {
    base: String,
    stop: Arc<AtomicBool>,
}

impl Service {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut socket) = socket else {
                    continue;
                };
                let request = read(&mut socket);
                let head = String::from_utf8_lossy(&request);
                let keyed = head.contains(&format!("Bearer {KEY}"));
                let (status, kind, body) = if head.starts_with("GET /v1/models ") && keyed {
                    let models = json!({"object": "list", "data": [
                        {"id": "example-chat-large", "object": "model", "context_length": 131_072},
                        {"id": "example-chat-mini", "object": "model"},
                        {"id": "example-embed-v2", "object": "model"},
                    ]});
                    ("200 OK", "application/json", models.to_string())
                } else if head.starts_with("POST /v1/chat/completions ") && keyed {
                    let mut out = String::new();
                    for value in [
                        json!({"choices": [{"index": 0, "delta": {"role": "assistant",
                            "content": "<think>核对记录</think>"}, "finish_reason": null}]}),
                        json!({"choices": [{"index": 0, "delta": {"content": ANSWER},
                            "finish_reason": null}]}),
                        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
                        json!({"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 8}}),
                    ] {
                        out.push_str(&format!("data: {value}\n\n"));
                    }
                    out.push_str("data: [DONE]\n\n");
                    ("200 OK", "text/event-stream", out)
                } else if head.starts_with("GET /v1/models ")
                    || head.starts_with("POST /v1/chat/completions ")
                {
                    (
                        "401 Unauthorized",
                        "application/json",
                        r#"{"error":"unauthorized"}"#.into(),
                    )
                } else {
                    ("404 Not Found", "application/json", "{}".into())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes());
            }
        });
        Self { base, stop }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.base.trim_start_matches("http://"));
    }
}

/// One request, head and body.
fn read(socket: &mut TcpStream) -> Vec<u8> {
    let _ = socket.set_read_timeout(Some(Duration::from_secs(3)));
    let mut request = Vec::new();
    let mut buf = [0u8; 4096];
    while request.len() < 10 * 1024 * 1024 {
        let Ok(n) = socket.read(&mut buf) else {
            break;
        };
        if n == 0 {
            break;
        }
        request.extend_from_slice(&buf[..n]);
        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, n)| n.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if request.len() >= end + 4 + length {
                break;
            }
        }
    }
    request
}

fn main() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    let ws = Workspace::open_dir(directory.path(), "ca-window-fixture")?;
    ws.set_auto_links(false);
    let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED)?;
    seeded.write_to(ws.library())?;
    ws.library().rebuild_stale_indexes()?;
    let book: BookId = seeded.books[0].book_id().clone();
    let chapters = dr_testkit::seed::acceptance::entries_by_template(&ws, &book, "tpl-chapter");
    let chapter = chapters[0]["id"].as_str().unwrap().to_owned();

    let server = Service::new();
    let base = &server.base;
    let http = HttpClient::new()?.with_stand_in("https://api.example.com", base);
    // The four providers stay unconnected; their addresses are loopback too.
    let provider = ProviderDriver::with_endpoints(
        http,
        Credentials::new(Arc::new(dr_platform::secrets::SecretStore::in_memory())),
        Endpoints {
            deepseek: format!("{base}/chat/completions"),
            anthropic: format!("{base}/messages"),
            openai: format!("{base}/responses"),
            chatgpt: format!("{base}/responses"),
        },
        OAuthEndpoints::at(base)?,
        RetryPolicy::default(),
    );
    let mut connection = dr_view_agent::connection::ConnectionService::new(provider.clone());
    for provider in [
        Provider::Deepseek,
        Provider::Anthropic,
        Provider::Openai,
        Provider::Chatgpt,
    ] {
        connection = connection.with_catalog_endpoint(provider, format!("{base}/models"));
    }
    gpui_platform::application()
        .with_assets(dr_ui::Assets::new())
        .run(move |cx: &mut App| {
            dr_ui::init(cx).expect("pinned fonts");
            let mut file = SettingsFile::in_memory();
            file.set(
                dr_shell::settings::registry::UI_LOCALE,
                json!("zh-CN"),
                None,
            )
            .unwrap();
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "ca-window-fixture",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services {
                    library: Some(ws),
                    book: Some(book.to_string()),
                    ..Default::default()
                },
                file,
                cx,
            );
            dr_view_page::init(cx);
            dr_view_elements::init(cx);
            dr_view_agent::init_with_service(
                connection,
                Arc::new(provider),
                Arc::new(dr_view_agent::tools::CompanionTools::default()),
                cx,
            );
            cx.set_global(Fixture {
                _directory: directory,
                _server: server,
            });
            let handle =
                dr_shell::open_workspace(cx, |window, _| window.activate_window()).unwrap();
            handle
                .update(cx, |workspace, _, cx| {
                    workspace.open(
                        Target::Entry {
                            id: chapter.parse().unwrap(),
                            module: Some("mod-prose".parse().unwrap()),
                        },
                        Open::KEEP,
                        cx,
                    );
                    workspace
                        .right
                        .panes
                        .click(PaneId::Primary, RightTab::Companion);
                    cx.notify();
                })
                .unwrap();
            dr_debug_bridge::start(cx);
        });
    Ok(())
}
