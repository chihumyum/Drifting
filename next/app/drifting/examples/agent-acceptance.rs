//! A real desktop window over a throwaway tiny library, an in-memory secret
//! store, a loopback connection test, and the deterministic M27 driver. Every
//! provider/catalog/OAuth address is loopback. Never built as the release app.

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use dr_agent::{
    DriverEvent as E, FinishReason, Provider, ProviderTool, ProviderToolAction, ProviderToolStatus,
    ToolCall, Usage,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, catalog, credentials::Credentials,
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
use dr_workspace::{Actor, Workspace};
use gpui::{App, Global};
use serde_json::{Value, json};

struct Fixture {
    _directory: tempfile::TempDir,
    _server: LocalServer,
}
impl Global for Fixture {}

struct LocalServer {
    base: String,
    stop: Arc<AtomicBool>,
}
impl LocalServer {
    fn new(reply: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let models=json!({"data":catalog::bundled_models(Provider::Deepseek).into_iter().map(|model|json!({"id":model.id})).collect::<Vec<_>>()}).to_string();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut socket) = socket else {
                    continue;
                };
                let _ = socket.set_read_timeout(Some(Duration::from_secs(3)));
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                while request.len() < 1024 * 1024 {
                    let Ok(n) = socket.read(&mut buf) else {
                        break;
                    };
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
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
                let is_models = request.starts_with(b"GET /models ");
                let is_completion = request.starts_with(b"POST /chat/completions ");
                let (status, kind, body) = if is_models {
                    ("200 OK", "application/json", models.clone())
                } else if is_completion {
                    let first=json!({"id":"local-fixture","choices":[{"index":0,"delta":{"content":reply,"reasoning_content":""},"finish_reason":null}]}).to_string();
                    let last=json!({"id":"local-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":12}}).to_string();
                    (
                        "200 OK",
                        "text/event-stream",
                        format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
                    )
                } else {
                    ("400 Bad Request", "application/json", "{}".into())
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
impl Drop for LocalServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.base.trim_start_matches("http://"));
    }
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn event(event: E) -> Step {
    Step::Event(event)
}

fn main() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    let ws = Workspace::open_dir(directory.path(), "m31-window-fixture")?;
    ws.set_auto_links(false);
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED)?;
    seeded.write_to(ws.library())?;
    ws.library().rebuild_stale_indexes()?;
    let book: BookId = seeded.books[0].book_id().clone();
    let chapters = out(&ws, "chapter.list", json!({"book":book}));
    let chapter = chapters[0]["id"].as_str().unwrap().to_owned();
    let doc = format!("node:{chapter}");
    let body = out(&ws, "prose.read", json!({"doc":doc,"limit":1000}));
    let paragraph = &body["paragraphs"][1];
    let text = paragraph["text"].as_str().unwrap().to_owned();
    let prompt = text.chars().take(32).collect::<String>();
    let reply = text.chars().take(64).collect::<String>();
    let replacement = text.chars().rev().collect::<String>();
    let second_reply = chapters[1]["title"].as_str().unwrap().to_owned();
    let options = vec![
        chapters[0]["title"].as_str().unwrap().to_owned(),
        chapters[1]["title"].as_str().unwrap().to_owned(),
    ];
    let scripts = vec![
        vec![
            event(E::ThinkingDelta {
                index: 0,
                text: prompt.clone(),
            }),
            event(E::ToolCall(ToolCall {
                id: "question".into(),
                name: "ask_user".into(),
                arguments: json!({"prompt":prompt,"options":options}),
            })),
            event(E::Finish(FinishReason::Tools)),
        ],
        vec![
            event(E::ToolCall(ToolCall {
                id: "read".into(),
                name: "call_tool".into(),
                arguments: json!({"name":"prose.read","arguments":{"doc":doc,"limit":1000}}),
            })),
            event(E::Finish(FinishReason::Tools)),
        ],
        vec![
            event(E::ToolCall(ToolCall {
                id: "write".into(),
                name: "call_tool".into(),
                arguments: json!({"name":"prose.replace","arguments":{"doc":doc,"block_id":paragraph["block_id"],"find":text,"replace":replacement}}),
            })),
            event(E::Finish(FinishReason::Tools)),
        ],
        vec![
            event(E::ProviderTool {
                activity: ProviderTool {
                    id: "search".into(),
                    action: ProviderToolAction::Search,
                    status: ProviderToolStatus::Completed,
                    query: Some(chapters[0]["title"].as_str().unwrap().into()),
                    url: None,
                },
            }),
            event(E::TextDelta {
                index: 0,
                text: reply.clone(),
            }),
            event(E::Usage(Usage {
                input_tokens: 100,
                output_tokens: 20,
                ..Default::default()
            })),
            event(E::Finish(FinishReason::Complete)),
        ],
        // The second author turn remains in the same conversation. This
        // exposes attachment ordering that a one-turn window cannot check.
        vec![
            event(E::ThinkingDelta {
                index: 0,
                text: second_reply.clone(),
            }),
            event(E::TextDelta {
                index: 1,
                text: second_reply,
            }),
            event(E::Finish(FinishReason::Complete)),
        ],
    ];
    let server = LocalServer::new(reply);
    let base = &server.base;
    let provider = ProviderDriver::with_endpoints(
        HttpClient::new()?,
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
    let mut connection = dr_view_agent::connection::ConnectionService::new(provider);
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
                    version: "m31-window-fixture",
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
                Arc::new(ScriptedDriver::new(scripts)),
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
                    workspace.open(Target::Chapter(chapter.parse().unwrap()), Open::KEEP, cx);
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
