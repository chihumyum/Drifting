//! M31 「0.1 的旧对话」 in a real window (`crates/dr-view-agent/scenarios/
//! old-conversations.json`): the shell over the active library of this
//! profile's data folder (the scenario's throwaway profile), the bookshelf's
//! ordinary 「导入 Drifting 0.1」 of the synthetic 0.1 library the scenario's
//! `legacy` step makes (`DRIFTING_APP_DATA_DIR`), an in-memory secret store,
//! a loopback connection test and the deterministic M27 driver for the one
//! new conversation. No real provider, key or library. Never built as the
//! release app.

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use dr_agent::{
    DriverEvent as E, FinishReason, Provider,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, catalog, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_shell::{Services, SettingsFile, ShellInfo, panes::PaneId, workspace::RightTab};
use dr_workspace::Workspace;
use gpui::{App, Global};
use serde_json::json;

/// The scripted answer to the new conversation's one question.
const ANSWER: &str = "可以，换成被人打了以后的那一次。";

struct Fixture {
    _server: LocalServer,
}
impl Global for Fixture {}

/// The connection test's and the model catalog's loopback (as
/// `agent-acceptance`).
struct LocalServer {
    base: String,
    stop: Arc<AtomicBool>,
}
impl LocalServer {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let models = json!({"data": catalog::bundled_models(Provider::Deepseek)
            .into_iter().map(|model| json!({"id": model.id})).collect::<Vec<_>>()})
        .to_string();
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
                let (status, kind, body) = if request.starts_with(b"GET /models ") {
                    ("200 OK", "application/json", models.clone())
                } else if request.starts_with(b"POST /chat/completions ") {
                    let first = json!({"id": "local-fixture", "choices": [{"index": 0,
                        "delta": {"content": "好", "reasoning_content": ""}, "finish_reason": null}]})
                    .to_string();
                    let last = json!({"id": "local-fixture", "choices": [{"index": 0,
                        "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 12,
                        "completion_tokens": 1, "total_tokens": 13, "prompt_cache_hit_tokens": 0,
                        "prompt_cache_miss_tokens": 12}})
                    .to_string();
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

/// The data folder's active library (`libraries.json`, as the app opens it),
/// or `<data>/library`.
fn active_dir(data: &Path) -> PathBuf {
    if data.join(dr_account::LIBRARIES_FILE).is_file() {
        dr_account::LibraryRegistry::load_or_init(data)
            .map(|reg| reg.active_library_dir(data))
            .unwrap_or_else(|_| data.join("library"))
    } else {
        data.join("library")
    }
}

fn main() -> anyhow::Result<()> {
    // This profile's own data folder (the scenario's throwaway one), as the
    // app's; the 0.1 folder is `DRIFTING_APP_DATA_DIR`, which the import's
    // own lookup reads.
    let data = dr_platform::AppDirs::for_identity(dr_platform::Identity::current())?.own;
    let ws = Workspace::open_dir(active_dir(&data), "m31-old-conversations-fixture")?;
    ws.set_auto_links(false);
    let appearance = match std::env::var("DRIFTING_APPEARANCE").as_deref() {
        Ok("dark") => dr_ui::Appearance::Dark,
        _ => dr_ui::Appearance::Light,
    };
    let server = LocalServer::new();
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
    let scripts = vec![vec![
        Step::Event(E::TextDelta {
            index: 0,
            text: ANSWER.into(),
        }),
        Step::Event(E::Finish(FinishReason::Complete)),
    ]];
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
                    version: "m31-old-conversations-fixture",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(appearance),
                },
                Services {
                    library: Some(ws),
                    ..Default::default()
                },
                file,
                cx,
            );
            // The import is started by the scenario, not offered.
            dr_shell::Settings::set_device_memory(cx, dr_view_import::OFFERED, Some(json!(true)));
            dr_view_shelf::init(cx);
            dr_view_home::init(cx);
            dr_view_page::init(cx);
            dr_view_elements::init(cx);
            dr_view_import::init(cx);
            dr_view_agent::init_with_service(
                connection,
                Arc::new(ScriptedDriver::new(scripts)),
                Arc::new(dr_view_agent::tools::CompanionTools::default()),
                cx,
            );
            cx.set_global(Fixture { _server: server });
            let handle =
                dr_shell::open_workspace(cx, |window, _| window.activate_window()).unwrap();
            handle
                .update(cx, |workspace, _, cx| {
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
