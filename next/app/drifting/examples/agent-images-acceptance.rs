//! CM4a in a real window (`crates/dr-view-agent/scenarios/agent-images.json`):
//! images dropped on the Agent composer and sent. A throwaway tiny library,
//! synthetic keys in an in-memory secret store, and one loopback service
//! that plays Anthropic (its model list says the model takes images; its
//! Messages endpoint answers what images a request carried) and DeepSeek
//! (whose list says nothing about images). The real model driver speaks to
//! it. A synthetic sketch (dr-testkit's `media::png`) is written beside the
//! library as `sketch.png`, for the scenario to drop. No real provider,
//! key or library. Never built as the release app.
//!
//! `DRIFTING_ACCEPTANCE_PROVIDER=deepseek` starts on DeepSeek instead of
//! Anthropic's model.

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
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, catalog, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_shell::{Services, SettingsFile, ShellInfo, panes::PaneId, workspace::RightTab};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace;
use gpui::{App, Global};
use serde_json::{Value, json};

struct Fixture {
    _directory: tempfile::TempDir,
    _server: Service,
}
impl Global for Fixture {}

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
                if let Ok(socket) = socket {
                    answer(socket);
                }
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

fn answer(mut socket: TcpStream) {
    let _ = socket.set_read_timeout(Some(Duration::from_secs(5)));
    let mut request = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    let mut body_at = None;
    while request.len() < 64 * 1024 * 1024 {
        let Ok(n) = socket.read(&mut buf) else { break };
        if n == 0 {
            break;
        }
        request.extend_from_slice(&buf[..n]);
        if body_at.is_none() {
            body_at = request
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|end| end + 4);
        }
        if let Some(start) = body_at {
            let head = String::from_utf8_lossy(&request[..start]);
            let length = head
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, n)| n.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if request.len() >= start + length {
                break;
            }
        }
    }
    let start = body_at.unwrap_or(request.len());
    let line = String::from_utf8_lossy(&request[..start])
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned();
    let body: Value = serde_json::from_slice(&request[start..]).unwrap_or(Value::Null);
    let (kind, reply) = if line.starts_with("GET /anthropic/models") {
        let rows: Vec<_> = catalog::bundled_models(Provider::Anthropic)
            .into_iter()
            .map(|m| json!({"id": m.id, "capabilities": {"image_input": {"supported": true}}}))
            .collect();
        (
            "application/json",
            json!({"data": rows, "has_more": false}).to_string(),
        )
    } else if line.starts_with("GET /deepseek/models") {
        let rows: Vec<_> = catalog::bundled_models(Provider::Deepseek)
            .into_iter()
            .map(|m| json!({"id": m.id}))
            .collect();
        ("application/json", json!({"data": rows}).to_string())
    } else if line.starts_with("POST /anthropic/messages") {
        ("text/event-stream", messages(&seen_images(&body)))
    } else {
        ("application/json", "{}".to_owned())
    };
    let status = if kind == "application/json" && reply == "{}" {
        "400 Bad Request"
    } else {
        "200 OK"
    };
    let _ = socket.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
            reply.len()
        )
        .as_bytes(),
    );
}

/// What the request's last author message carried: each image block's size
/// in pixels, read from its decoded bytes.
fn seen_images(body: &Value) -> Vec<(u32, u32)> {
    let Some(last) = body["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|m| m["role"] == "user"))
    else {
        return Vec::new();
    };
    last["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "image" && block["source"]["type"] == "base64")
        .filter_map(|block| decode_base64(block["source"]["data"].as_str()?))
        .filter_map(|bytes| dr_agent::images::inspect(&bytes).ok())
        .map(|image| (image.width, image.height))
        .collect()
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let digits = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c)? << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

/// A Messages stream answering with one line: what images arrived, or
/// 「没有收到图片」. Only when images arrived does the line come with a
/// (signed) thinking block too, so the window shows 「思考过程」, a button
/// the scenario can find: the accessibility tree has no plain text.
fn messages(images: &[(u32, u32)]) -> String {
    let mut events = vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}),
    ];
    let text = if images.is_empty() {
        "没有收到图片".to_owned()
    } else {
        let line = format!(
            "收到 {} 张图片：{}",
            images.len(),
            images
                .iter()
                .map(|(w, h)| format!("{w}×{h}"))
                .collect::<Vec<_>>()
                .join("、")
        );
        events.extend([
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":line}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"synthetic-cm4a"}}),
            json!({"type":"content_block_stop","index":0}),
        ]);
        line
    };
    let index = usize::from(!images.is_empty());
    events.extend([
        json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}}),
        json!({"type":"content_block_stop","index":index}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}),
        json!({"type":"message_stop"}),
    ]);
    events
        .into_iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}

fn main() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    let ws = Workspace::open_dir(directory.path().join("library"), "cm4a-window-fixture")?;
    ws.set_auto_links(false);
    let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED)?;
    seeded.write_to(ws.library())?;
    ws.library().rebuild_stale_indexes()?;
    let book = seeded.books[0].book_id().clone();
    // The sketch the scenario drops: `<library>/../sketch.png`.
    std::fs::write(
        directory.path().join("sketch.png"),
        dr_testkit::media::png(640, 400),
    )?;
    let deepseek = std::env::var("DRIFTING_ACCEPTANCE_PROVIDER").as_deref() == Ok("deepseek");

    let server = Service::new();
    let base = server.base.clone();
    let secrets = Arc::new(dr_platform::secrets::SecretStore::in_memory());
    for provider in [Provider::Anthropic, Provider::Deepseek] {
        secrets.set(
            &format!("byok.{}", provider.as_str()),
            "synthetic-cm4a-window-key",
        )?;
    }
    let provider = ProviderDriver::with_endpoints(
        HttpClient::new()?,
        Credentials::new(secrets),
        Endpoints {
            deepseek: format!("{base}/deepseek/chat/completions"),
            anthropic: format!("{base}/anthropic/messages"),
            openai: format!("{base}/openai/responses"),
            chatgpt: format!("{base}/chatgpt/responses"),
        },
        OAuthEndpoints::at(&base)?,
        RetryPolicy {
            max_attempts: 1,
            ..Default::default()
        },
    );
    let connection = dr_view_agent::connection::ConnectionService::new(provider.clone())
        .with_catalog_endpoint(Provider::Anthropic, format!("{base}/anthropic/models"))
        .with_catalog_endpoint(Provider::Deepseek, format!("{base}/deepseek/models"))
        .with_catalog_endpoint(Provider::Openai, format!("{base}/openai/models"))
        .with_catalog_endpoint(Provider::Chatgpt, format!("{base}/chatgpt/models"));
    gpui_platform::application()
        .with_assets(dr_ui::Assets::new())
        .run(move |cx: &mut App| {
            dr_ui::init(cx).expect("pinned fonts");
            let mut file = SettingsFile::in_memory();
            let registry = dr_shell::settings::registry::UI_LOCALE;
            file.set(registry, json!("zh-CN"), None).unwrap();
            let (route, model, thinking) = if deepseek {
                ("deepseek", "deepseek-flash", "off")
            } else {
                ("anthropic", "claude-sonnet-5-5", "high")
            };
            for (key, value) in [
                (dr_shell::settings::registry::AGENT_PROVIDER, route),
                (dr_shell::settings::registry::AGENT_MODEL, model),
                (dr_shell::settings::registry::AGENT_THINKING, thinking),
            ] {
                file.set(key, json!(value), None).unwrap();
            }
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "cm4a-window-fixture",
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
