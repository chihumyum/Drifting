use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use dr_agent::{
    driver::scripted::{ScriptedDriver, Step},
    *,
};
use dr_mcp::{PluginSlot, PluginTools, outbound::*};
use dr_model::id::{BookId, ConversationId};
use dr_platform::secrets::SecretStore;
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

pub struct Fixture {
    pub ws: Workspace,
    pub book: BookId,
    pub other: BookId,
    pub text: String,
    pub secrets: Arc<SecretStore>,
    pub manager: Manager,
    pub slot: PluginSlot,
    pub tools: Arc<PluginTools>,
    pub _directory: tempfile::TempDir,
}
impl Fixture {
    pub fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(directory.path(), "m32-outbound-test").unwrap();
        ws.set_auto_links(false);
        let first = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let second = seed::generate(Preset::Tiny, seed::DEFAULT_SEED + 1).unwrap();
        let (book, other) = (
            first.books[0].book_id().clone(),
            second.books[0].book_id().clone(),
        );
        let text = first.books[0].prose[0].view().plain_text();
        first.write_to(ws.library()).unwrap();
        second.write_to(ws.library()).unwrap();
        let secrets = Arc::new(SecretStore::in_memory());
        let manager = Manager::new(
            ws.library().clone(),
            secrets.clone(),
            tokio::runtime::Handle::current(),
        );
        let slot = PluginSlot::default();
        slot.replace(Some(manager.clone()));
        let tools = Arc::new(PluginTools::new(slot.clone()));
        Self {
            ws,
            book,
            other,
            text,
            secrets,
            manager,
            slot,
            tools,
            _directory: directory,
        }
    }
    pub fn start(&self, book: BookId, call: ToolCall) -> (Runtime, RunHandle) {
        let driver = Arc::new(ScriptedDriver::new(vec![
            vec![
                Step::Event(DriverEvent::ToolCall(call)),
                Step::Event(DriverEvent::Finish(FinishReason::Tools)),
            ],
            vec![Step::Event(DriverEvent::Finish(FinishReason::Complete))],
        ]));
        let runtime = Runtime::new(
            self.ws.clone(),
            driver,
            self.tools.clone(),
            Options::default(),
        )
        .unwrap();
        let run = runtime
            .start(Start {
                book,
                conversation: ConversationId::new_v7(),
                input: self.text.clone(),
                config: RunConfig::new(Provider::Openai, "synthetic-model"),
            })
            .unwrap();
        (runtime, run)
    }
    pub async fn shutdown(self) {
        self.manager.begin_close().await.unwrap();
        // Old slot and executor clones intentionally remain alive here.
        assert!(
            self.slot
                .replace(Some(self.manager.clone()))
                .unwrap()
                .is_closed()
        );
        self.ws.try_shutdown().unwrap();
    }
}

pub fn draft(url: &str, id: &str) -> ServerDraft {
    ServerDraft {
        id: Some(id.into()),
        expected_revision: None,
        name: "Synthetic MCP".into(),
        enabled: true,
        transport: TransportDraft::Http {
            url: url.into(),
            headers: BTreeMap::new(),
        },
    }
}
pub fn call(info: &ServerInfo, text: &str) -> ToolCall {
    let tool = &info.tools[0];
    ToolCall {
        id: "plugin-call".into(),
        name: "mcp_call".into(),
        arguments: json!({"server":info.id,"tool":tool.name,"revision":tool.revision,"arguments":{"text":text}}),
    }
}
pub async fn until(mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "outbound condition timed out"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
pub async fn permission(f: &Fixture, run: &RunHandle) -> RequestId {
    until(|| run.control.state() == State::AwaitingPermission).await;
    events(f.ws.library(), &run.session, 0)
        .unwrap()
        .into_iter()
        .find_map(|event| match event.event {
            Event::PermissionAsked {
                request, policy, ..
            } => {
                assert_eq!(policy, ToolPolicy::ExternalPlugin);
                Some(request)
            }
            _ => None,
        })
        .unwrap()
}
pub async fn finish(runtime: Runtime, run: RunHandle) -> State {
    let state = tokio::task::spawn_blocking(move || run.join().unwrap())
        .await
        .unwrap();
    runtime.drain_tools().await.unwrap();
    drop(runtime);
    state
}

#[derive(Clone, Default)]
pub struct Behavior {
    pub hold: bool,
    pub expire: bool,
    pub duplicate: bool,
    pub loop_cursor: bool,
    pub bad_schema: bool,
    pub page_count: usize,
    pub tool_count: usize,
    pub oversized: bool,
    pub headers: usize,
    pub sse: bool,
    pub followup: bool,
}
struct Shared {
    behavior: Mutex<Behavior>,
    calls: AtomicUsize,
    requests: Mutex<Vec<Value>>,
    release: Semaphore,
}
pub struct Server {
    pub url: String,
    shared: Arc<Shared>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}
impl Server {
    pub async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let shared = Arc::new(Shared {
            behavior: Mutex::new(Behavior::default()),
            calls: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
            release: Semaphore::new(0),
        });
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let state = shared.clone();
        let task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                tokio::select! {
                    _=stopping.cancelled()=>break,
                    accepted=listener.accept()=>{let (socket,_)=accepted.unwrap();let state=state.clone();children.spawn(async move {let _=serve(socket,state).await;});},
                    _=children.join_next(),if !children.is_empty()=>{},
                }
            }
            children.abort_all();
            while children.join_next().await.is_some() {}
        });
        Self {
            url,
            shared,
            stop,
            task,
        }
    }
    pub fn behavior(&self, behavior: Behavior) {
        *self.shared.behavior.lock().unwrap() = behavior;
    }
    pub fn calls(&self) -> usize {
        self.shared.calls.load(Ordering::SeqCst)
    }
    pub fn requests(&self) -> Vec<Value> {
        self.shared.requests.lock().unwrap().clone()
    }
    pub fn release(&self) {
        self.shared.release.add_permits(1);
    }
    pub async fn close(self) {
        self.stop.cancel();
        self.task.await.unwrap();
    }
}

async fn serve(mut socket: TcpStream, state: Arc<Shared>) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    let (method, request) = loop {
        let count = socket.read(&mut chunk).await?;
        if count == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 2 * 1024 * 1024 {
            return Ok(());
        }
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                let method = headers.split_whitespace().next().unwrap_or("").to_owned();
                let value = serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])
                    .unwrap_or(Value::Null);
                break (method, value);
            }
        }
    };
    let behavior = state.behavior.lock().unwrap().clone();
    let (status, result) = if method == "GET" {
        (405, None)
    } else if method == "DELETE" {
        (204, None)
    } else {
        state.requests.lock().unwrap().push(request.clone());
        match request["method"].as_str().unwrap_or("") {
            "initialize" => (
                200,
                Some(
                    json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"synthetic","version":"1"}}),
                ),
            ),
            "notifications/initialized" | "notifications/cancelled" => (202, None),
            "tools/list" => {
                let page = request["params"]["cursor"]
                    .as_str()
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                let schema = if behavior.bad_schema {
                    json!({"type":123})
                } else {
                    json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"]})
                };
                let tool = json!({"name":format!("echo-{page}"),"description":"Synthetic protocol fixture","inputSchema":schema,"annotations":{"readOnlyHint":true}});
                let tools = if behavior.duplicate {
                    vec![tool.clone(), tool]
                } else if behavior.tool_count > 0 {
                    (0..behavior.tool_count)
                        .map(|n| {
                            let mut tool = tool.clone();
                            tool["name"] = format!("echo-{page}-{n}").into();
                            tool
                        })
                        .collect()
                } else {
                    vec![tool]
                };
                let mut result = json!({"tools":tools});
                if behavior.loop_cursor {
                    result["nextCursor"] = "0".into();
                } else if page + 1 < behavior.page_count {
                    result["nextCursor"] = (page + 1).to_string().into();
                }
                (200, Some(result))
            }
            "tools/call" => {
                state.calls.fetch_add(1, Ordering::SeqCst);
                if behavior.hold {
                    let _ = state.release.acquire().await;
                }
                if behavior.expire {
                    (404, None)
                } else if behavior.followup {
                    (
                        200,
                        Some(
                            json!({"resultType":"input_required","inputRequests":{},"requestState":"synthetic-state"}),
                        ),
                    )
                } else {
                    (
                        200,
                        Some(
                            json!({"content":[{"type":"text","text":request["params"]["arguments"].to_string()}],"isError":false}),
                        ),
                    )
                }
            }
            _ => (202, None),
        }
    };
    let message = result
        .map(|result| json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string())
        .unwrap_or_default();
    let body = if behavior.oversized {
        "x".repeat(4 * 1024 * 1024 + 1)
    } else if behavior.sse && status == 200 {
        format!("data: {message}\n\n")
    } else {
        message
    };
    let content = if behavior.sse {
        "text/event-stream"
    } else {
        "application/json"
    };
    let extra = (0..behavior.headers)
        .map(|i| format!("x-fixture-{i}: value\r\n"))
        .collect::<String>();
    let response = format!(
        "HTTP/1.1 {status} fixture\r\nContent-Type: {content}\r\nContent-Length: {}\r\nMcp-Session-Id: synthetic-session\r\nConnection: close\r\n{extra}\r\n{body}",
        body.len()
    );
    socket.write_all(response.as_bytes()).await?;
    socket.shutdown().await
}
