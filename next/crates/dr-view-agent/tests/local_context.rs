//! LM hand-back (`m28-model-providers.md`, the measurement at its end): a
//! local model with a small context sends the sample book's first message,
//! with room to spare at the 32 768 fallback (CX, `m27-agent-runtime.md`
//! 「请求有多长」).
//! The App's controller, system prompt and tools, the real provider driver's
//! local route and a synthetic loopback server; no real server or model.
//! The book is 《慢钟》 of the showcase seed, which the LM smoke run used.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use dr_agent::context::Checkpoint;
use dr_agent::{LocalRoute, ModelCapabilities, Provider, RunConfig, Start};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::id::{BookId, ConversationId};
use dr_platform::SecretStore;
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{controller::AgentController, tools::CompanionTools};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use rusqlite::OptionalExtension as _;
use serde_json::{Value, json};

/// Answers every chat request with a short reply and keeps the size of
/// what it was sent.
struct Fake {
    url: String,
    chats: Arc<Mutex<Vec<usize>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Fake {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let chats = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log, closing) = (chats.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !closing.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let Some((path, size)) = read(&mut socket) else {
                            continue;
                        };
                        let (status, body) = if path == "/v1/chat/completions" {
                            log.lock().unwrap().push(size);
                            (200, reply("你好。"))
                        } else {
                            (404, "{}".to_owned())
                        };
                        let kind = if status == 200 {
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
            chats,
            stop,
            thread: Some(thread),
        }
    }

    fn chats(&self) -> Vec<usize> {
        self.chats.lock().unwrap().clone()
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

/// The request's path and body size.
fn read(socket: &mut TcpStream) -> Option<(String, usize)> {
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
            return Some((path, length));
        }
    }
}

fn reply(text: &str) -> String {
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

fn driver() -> ProviderDriver {
    // The hosted endpoints point nowhere: the local route must not use them.
    let nowhere = "http://127.0.0.1:9";
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        Credentials::new(Arc::new(SecretStore::in_memory())),
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

/// What happened to 《慢钟》's first message.
struct Sent {
    /// The size of each chat request the server got.
    chats: Vec<usize>,
    /// The run's state when it ended.
    state: Value,
    /// How the request was counted (`dr_agent::context::Checkpoint`): none
    /// when it did not fit.
    counted: Option<Checkpoint>,
}

impl Sent {
    /// Tokens of the request's budget the first message leaves unused.
    fn headroom(&self) -> u64 {
        let counted = self.counted.as_ref().expect("the request was counted");
        counted.input_budget - counted.estimated_input_tokens
    }
}

/// Send 《慢钟》's first message to a local model whose context is
/// `context_window`.
fn first_message(context_window: u64) -> Sent {
    let fake = Fake::new();
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), library_options("lm-local-context")).unwrap();
    let seeded = seed::generate_v3(Preset::Showcase, seed::DEFAULT_SEED).unwrap();
    seeded.write_to(&lib).unwrap();
    let book: BookId = seeded
        .books
        .iter()
        .find(|b| b.book.view().meta().name == "慢钟")
        .expect("the showcase has 《慢钟》")
        .book_id()
        .clone();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let controller = AgentController::new(
        ws.clone(),
        Arc::new(driver()),
        Arc::new(CompanionTools::default()),
    )
    .unwrap();

    let mut config = RunConfig::new(Provider::Local, "qwen3:14b");
    config.route.local = Some(LocalRoute {
        server: "synthetic-server".into(),
        base_url: fake.url.clone(),
    });
    config.capabilities = Some(ModelCapabilities {
        context_window: Some(context_window),
        ..Default::default()
    });
    let conversation = ConversationId::new_v7();
    controller
        .start(Start {
            config,
            book: book.clone(),
            conversation: conversation.clone(),
            input: "你好，本地模型".into(),
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let state = loop {
        let snapshot = controller.snapshot(&book, &conversation).unwrap();
        if let Some(run) = snapshot.runs.first() {
            let seen = serde_json::to_value(run).unwrap();
            if run.state.is_terminal() {
                break seen["state"].clone();
            }
            assert!(Instant::now() < deadline, "the run did not end: {seen}");
        }
        assert!(Instant::now() < deadline, "no run started");
        std::thread::sleep(Duration::from_millis(10));
    };
    // The one request chain's count, saved before the request is sent.
    let counted = ws
        .library()
        .local_read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM local_state WHERE scope = 'agent.context'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })
        .unwrap()
        .map(|value| serde_json::from_str(&value).unwrap());
    futures::executor::block_on(controller.close()).unwrap();
    ws.shutdown().unwrap();
    Sent {
        chats: fake.chats(),
        state,
        counted,
    }
}

/// Tokens the sample book's first message must leave unused at the 32 768
/// fallback (CX, 2026-11-24): room for the turn's first tool calls and
/// results. It was 2 168 when this was set (and between none and a dozen,
/// by the luck of the random ids, before); the fixed context (system
/// prompt, tools, the book's structure) growing by more than the difference
/// turns this red, every time.
const HEADROOM_AT_32K: u64 = 1_024;

/// Ollama tells 40 960 for qwen3:14b, and a server that tells nothing gets
/// the 32 768 fallback: either way the sample book's first message goes out
/// (it used to stop at 「继续此任务」 with nothing sent), at 32 768 with at
/// least [`HEADROOM_AT_32K`] to spare. A context too small for the book's
/// fixed part still stops before anything is sent.
#[test]
fn a_small_local_context_sends_the_sample_books_first_message() {
    for window in [40_960, 32_768] {
        let sent = first_message(window);
        assert_eq!(sent.chats.len(), 1, "{window}: {}", sent.state);
        // The request is about the size the LM smoke run measured (54 KB).
        assert!(sent.chats[0] > 30_000, "{window}: {} bytes", sent.chats[0]);
        assert_eq!(sent.state, json!("completed"), "{window}");
        let counted = sent.counted.as_ref().unwrap();
        assert!(counted.estimated_input_tokens <= counted.input_budget);
    }

    // Counted the same every time (the random session ids no longer move
    // it), so this holds or fails on the book and the code, not on luck.
    let (first, again) = (first_message(32_768), first_message(32_768));
    assert_eq!(
        first.counted.as_ref().unwrap().estimated_input_tokens,
        again.counted.as_ref().unwrap().estimated_input_tokens
    );
    assert!(
        first.headroom() >= HEADROOM_AT_32K,
        "32 768: {} tokens to spare, fewer than {HEADROOM_AT_32K}",
        first.headroom()
    );

    let sent = first_message(16_384);
    assert!(sent.chats.is_empty(), "{:?}", sent.chats);
    assert_eq!(sent.state, json!("checkpointed"));
    assert!(sent.counted.is_none());
}
