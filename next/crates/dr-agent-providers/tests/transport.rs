use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use dr_agent::{
    Cancellation, Driver, DriverEvent, DriverRequest, ModelErrorCategory, Provider, RunConfig,
    ToolAccess, ToolDescriptor, ToolPolicy,
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy,
    credentials::{Credentials, StoredTokens},
    oauth::OAuthEndpoints,
};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_platform::SecretStore;
use futures::StreamExt;
use serde_json::{Value, json};

struct Reply {
    status: u16,
    body: String,
}
struct Service {
    url: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Service {
    fn new(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let thread = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            for reply in replies {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "request did not arrive"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                let (headers, body) = read_request(&mut socket);
                log.lock().unwrap().push((headers, body));
                let head = format!(
                    "HTTP/1.1 {} Test\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.status,
                    reply.body.len()
                );
                socket.write_all(head.as_bytes()).unwrap();
                // Arbitrary transport fragmentation, including UTF-8 boundaries.
                for chunk in reply.body.as_bytes().chunks(7) {
                    let _ = socket.write_all(chunk);
                }
            }
        });
        Self {
            url,
            requests,
            thread: Some(thread),
        }
    }
    fn join(&mut self) {
        self.thread.take().unwrap().join().unwrap();
    }
}

fn read_request(socket: &mut TcpStream) -> (String, Value) {
    socket.set_nonblocking(false).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let count = socket.read(&mut buffer).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
            let len: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .parse()
                .unwrap();
            if bytes.len() >= end + 4 + len {
                return (
                    headers,
                    serde_json::from_slice(&bytes[end + 4..end + 4 + len]).unwrap(),
                );
            }
        }
    }
}

fn sse(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn source_text() -> String {
    let book = dr_testkit::samples::a_q().unwrap();
    book.groups()
        .values()
        .find_map(|parts| parts.first())
        .unwrap()
        .chars()
        .take(16)
        .collect()
}
fn request(provider: Provider, tools: bool) -> DriverRequest {
    let model = match provider {
        Provider::Anthropic => "claude-sonnet-5",
        Provider::Deepseek => "deepseek-flash",
        _ => "gpt-6.1-terra",
    };
    DriverRequest {
        config: Arc::new(RunConfig::new(provider, model)),
        session: "synthetic-session".into(),
        turn: 1,
        round: 1,
        conversation: vec![ConversationEntry {
            id: "user-1".into(),
            session: "synthetic-session".into(),
            turn: 1,
            kind: ConversationEntryKind::User,
            payload: json!({"text":source_text()}),
        }],
        tools: if tools {
            vec![ToolDescriptor {
                name: "read".into(),
                revision: "1".into(),
                description: "fixture".into(),
                input_schema: json!({"type":"object"}),
                access: ToolAccess::Read,
                policy: ToolPolicy::Local,
            }]
        } else {
            vec![]
        },
    }
}
fn driver(service: &Service) -> ProviderDriver {
    let store = Arc::new(SecretStore::in_memory());
    for p in [Provider::Anthropic, Provider::Openai, Provider::Deepseek] {
        store
            .set(&format!("byok.{}", p.as_str()), "synthetic-key")
            .unwrap();
    }
    store
        .set(
            "oauth.openai-codex",
            &serde_json::to_string(&StoredTokens {
                access_token: "synthetic-access".into(),
                refresh_token: "synthetic-refresh".into(),
                expires_at_ms: u64::MAX,
                id_token: None,
            })
            .unwrap(),
        )
        .unwrap();
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        Credentials::new(store),
        Endpoints {
            deepseek: service.url.clone(),
            anthropic: service.url.clone(),
            openai: service.url.clone(),
            chatgpt: service.url.clone(),
        },
        OAuthEndpoints::at(&service.url).unwrap(),
        RetryPolicy {
            max_attempts: 2,
            base_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
            jitter: false,
        },
    )
}
fn collect(driver: &ProviderDriver, request: DriverRequest) -> Vec<dr_agent::Result<DriverEvent>> {
    futures::executor::block_on(driver.stream(request, Cancellation::default()).collect())
}
fn response(text: &str, tools: bool) -> String {
    let mut output = vec![
        json!({"id":"msg","type":"message","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}),
    ];
    let mut stream = sse(
        json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":text}),
    );
    if tools {
        let call = json!({"id":"item","type":"function_call","call_id":"call-1","name":"read","arguments":"{}"});
        stream.push_str(&sse(
            json!({"type":"response.output_item.added","output_index":1,"item":call}),
        ));
        output.push(call);
    }
    stream
        + &sse(
            json!({"type":"response.completed","response":{"status":"completed","output":output,"usage":{"input_tokens":4,"output_tokens":3}}}),
        )
}

#[test]
fn failed_tool_attempt_publishes_no_partial_events_or_duplicate_tool_call() {
    let text = source_text();
    let truncated = sse(json!({"type":"response.output_text.delta","output_index":0,"delta":text}));
    let mut service = Service::new(vec![
        Reply {
            status: 200,
            body: truncated,
        },
        Reply {
            status: 200,
            body: response(&text, true),
        },
    ]);
    let events = collect(&driver(&service), request(Provider::Openai, true));
    assert!(events.iter().all(Result::is_ok));
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Ok(DriverEvent::TextDelta { .. })))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Ok(DriverEvent::ToolCall(_))))
            .count(),
        1
    );
    service.join();
    assert_eq!(service.requests.lock().unwrap().len(), 2);
}

#[test]
fn trailing_truncated_frame_after_finish_never_releases_unvalidated_tools() {
    let text = source_text();
    let mut service = Service::new(vec![
        Reply {
            status: 200,
            body: response(&text, true) + "data: {",
        },
        Reply {
            status: 200,
            body: response(&text, true),
        },
    ]);
    let events = collect(&driver(&service), request(Provider::Openai, true));
    assert!(events.iter().all(Result::is_ok));
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Ok(DriverEvent::ToolCall(_))))
            .count(),
        1
    );
    service.join();
}

#[test]
fn aborting_runtime_during_retry_after_settles_without_waiting_for_the_delay() {
    struct NoTools;
    impl dr_agent::ToolExecutor for NoTools {
        fn descriptors(&self) -> Vec<ToolDescriptor> {
            request(Provider::Openai, true).tools
        }
        fn execute(
            &self,
            _: dr_agent::ToolContext,
            _: dr_agent::ToolCall,
        ) -> futures::future::BoxFuture<'static, dr_agent::Result<dr_agent::tools::ToolOutput>>
        {
            Box::pin(async { panic!("no tool should execute") })
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read_request(&mut socket);
        socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        tx.send(()).unwrap();
    });
    let service = Service {
        url,
        requests: Arc::default(),
        thread: None,
    };
    let dir = tempfile::tempdir().unwrap();
    let library =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("m28-cancel")).unwrap();
    let seed = dr_testkit::seed::generate(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().clone();
    seed.write_to(&library).unwrap();
    let workspace =
        dr_workspace::Workspace::open(library, dr_workspace::WorkspaceOptions::default()).unwrap();
    let runtime = dr_agent::Runtime::new(
        workspace.clone(),
        Arc::new(driver(&service)),
        Arc::new(NoTools),
        dr_agent::Options::default(),
    )
    .unwrap();
    let run = runtime
        .start(dr_agent::Start {
            book,
            conversation: dr_model::id::ConversationId::new_v7(),
            input: source_text(),
            config: RunConfig::new(Provider::Openai, "gpt-6.1-terra"),
        })
        .unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let before = std::time::Instant::now();
    futures::executor::block_on(run.control.abort()).unwrap();
    assert_eq!(run.join().unwrap(), dr_agent::State::Aborted);
    assert!(before.elapsed() < Duration::from_secs(3));
    thread.join().unwrap();
    drop(runtime);
    workspace.shutdown().unwrap();
}

#[test]
fn tool_free_disconnect_does_not_retry_visible_output() {
    let text = source_text();
    let mut service = Service::new(vec![Reply {
        status: 200,
        body: sse(json!({"type":"response.output_text.delta","output_index":0,"delta":text})),
    }]);
    let events = collect(&driver(&service), request(Provider::Openai, false));
    assert!(matches!(
        events.first(),
        Some(Ok(DriverEvent::TextDelta { .. }))
    ));
    assert!(events.last().unwrap().is_err());
    service.join();
    assert_eq!(service.requests.lock().unwrap().len(), 1);
}

#[test]
fn subscription_uses_same_parser_with_native_headers_and_no_output_ceiling() {
    let mut service = Service::new(vec![Reply {
        status: 200,
        body: response(&source_text(), true),
    }]);
    let events = collect(&driver(&service), request(Provider::Chatgpt, true));
    assert!(events.iter().all(Result::is_ok));
    assert!(
        events.iter().any(
            |e| matches!(e,Ok(DriverEvent::Replay{replay})if replay.provider==Provider::Chatgpt)
        )
    );
    service.join();
    let requests = service.requests.lock().unwrap();
    let headers = requests[0].0.to_ascii_lowercase();
    assert!(headers.contains("authorization: bearer synthetic-access"));
    assert!(headers.contains("originator: codex_cli_rs"));
    assert!(requests[0].1.get("max_output_tokens").is_none());
    assert_eq!(
        requests[0].1["tools"].as_array().unwrap().last().unwrap()["external_web_access"],
        true
    );
}

#[test]
fn authentication_is_not_retried_and_error_body_is_not_exposed() {
    let mut service = Service::new(vec![Reply {
        status: 401,
        body: "synthetic-secret-in-provider-body".into(),
    }]);
    let events = collect(&driver(&service), request(Provider::Openai, true));
    assert_eq!(events.len(), 1);
    let error = events[0].as_ref().unwrap_err();
    assert!(
        matches!(error,dr_agent::Error::Provider(f)if f.category==ModelErrorCategory::Authentication)
    );
    assert!(!error.to_string().contains("synthetic-secret"));
    service.join();
}

#[test]
fn dropping_stream_closes_the_active_http_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (sent, received) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read_request(&mut socket);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        sent.send(()).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let result = socket.read(&mut [0; 1]);
        assert!(
            matches!(result, Ok(0))
                || result.is_err_and(|e| e.kind() != std::io::ErrorKind::WouldBlock
                    && e.kind() != std::io::ErrorKind::TimedOut)
        );
    });
    let service = Service {
        url,
        requests: Arc::default(),
        thread: None,
    };
    let stream = driver(&service).stream(request(Provider::Openai, true), Cancellation::default());
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(stream);
    thread.join().unwrap();
}

fn anthropic_response(text: &str, reason: &str) -> String {
    [
        json!({"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":3}}),
        json!({"type":"message_stop"}),
    ]
    .into_iter()
    .map(sse)
    .collect()
}

#[test]
fn anthropic_search_fallback_continuations_replay_order_and_usage() {
    let text = source_text();
    let mut service = Service::new(vec![
        Reply {
            status: 400,
            body: "web_search is not supported".into(),
        },
        Reply {
            status: 200,
            body: anthropic_response(&text, "pause_turn"),
        },
        Reply {
            status: 200,
            body: anthropic_response(&text, "end_turn"),
        },
        Reply {
            status: 200,
            body: anthropic_response(&text, "end_turn"),
        },
    ]);
    let events = collect(&driver(&service), request(Provider::Anthropic, true));
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let indices: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Ok(DriverEvent::TextDelta { index, .. }) => Some(*index),
            _ => None,
        })
        .collect();
    assert_eq!(indices, vec![0, 1]);
    let replay = events
        .iter()
        .find_map(|e| match e {
            Ok(DriverEvent::Replay { replay }) => Some(replay),
            _ => None,
        })
        .unwrap();
    assert_eq!(replay.items.len(), 2);
    assert_eq!(replay.native_search, Some(false));
    assert!(events.iter().any(|e|matches!(e,Ok(DriverEvent::Usage(usage))if usage.input_tokens==4&&usage.output_tokens==6)));
    let mut next = request(Provider::Anthropic, true);
    next.round = 2;
    next.conversation.push(ConversationEntry {
        id: "assistant-1".into(),
        session: next.session.clone(),
        turn: 1,
        kind: ConversationEntryKind::Assistant,
        payload: serde_json::to_value(dr_agent::AssistantMessage {
            replay: Some(replay.clone()),
            complete: true,
            ..Default::default()
        })
        .unwrap(),
    });
    assert!(collect(&driver(&service), next).iter().all(Result::is_ok));
    service.join();
    let requests = service.requests.lock().unwrap();
    assert_eq!(requests[0].1["tools"].as_array().unwrap().len(), 2);
    assert_eq!(requests[1].1["tools"].as_array().unwrap().len(), 1);
    assert_eq!(
        requests[2].1["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        &replay.items[0]
    );
    assert_eq!(requests[3].1["tools"].as_array().unwrap().len(), 1);
}

#[test]
fn anthropic_allows_at_most_four_pause_continuations_and_no_partial_tools_escape() {
    let mut service = Service::new(
        (0..5)
            .map(|_| Reply {
                status: 200,
                body: anthropic_response(&source_text(), "pause_turn"),
            })
            .collect(),
    );
    let driver = driver(&service);
    let events = collect(&driver, request(Provider::Anthropic, true));
    assert_eq!(events.len(), 1);
    assert!(events[0].is_err());
    service.join();
    assert_eq!(service.requests.lock().unwrap().len(), 5);
}

#[test]
fn search_tool_list_bound_to_active_replay_cannot_change_on_a_later_400() {
    let mut service = Service::new(vec![Reply {
        status: 400,
        body: "web_search is not supported".into(),
    }]);
    let mut next = request(Provider::Anthropic, true);
    next.conversation.push(ConversationEntry {
        id: "assistant-1".into(),
        session: next.session.clone(),
        turn: 1,
        kind: ConversationEntryKind::Assistant,
        payload: serde_json::to_value(dr_agent::AssistantMessage {
            replay: Some(dr_agent::ProviderReplay {
                provider: Provider::Anthropic,
                items: vec![
                    json!({"role":"assistant","content":[{"type":"text","text":source_text()}]}),
                ],
                native_search: Some(true),
            }),
            complete: true,
            ..Default::default()
        })
        .unwrap(),
    });
    let events = collect(&driver(&service), next);
    assert_eq!(events.len(), 1);
    assert!(
        matches!(&events[0],Err(dr_agent::Error::Provider(failure))if failure.category==ModelErrorCategory::Unsupported)
    );
    service.join();
    assert_eq!(service.requests.lock().unwrap().len(), 1);
}

#[test]
fn search_result_keeps_query_after_pause_and_after_the_next_model_round() {
    fn search_stream(block: Value, reason: &str) -> String {
        [json!({"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}),
         json!({"type":"content_block_start","index":0,"content_block":block}),
         json!({"type":"content_block_stop","index":0}),
         json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":1}}),
         json!({"type":"message_stop"})].into_iter().map(sse).collect()
    }
    let query = source_text();
    let started = json!({"type":"server_tool_use","id":"search-1","name":"web_search","input":{"query":query}});
    let completed = json!({"type":"web_search_tool_result","tool_use_id":"search-1","content":[{"type":"web_search_result","url":"https://example.invalid","title":query,"encrypted_content":"synthetic"}]});
    let mut service = Service::new(vec![
        Reply {
            status: 200,
            body: search_stream(started, "pause_turn"),
        },
        Reply {
            status: 200,
            body: search_stream(completed.clone(), "end_turn"),
        },
        Reply {
            status: 200,
            body: search_stream(completed, "end_turn"),
        },
    ]);
    let events = collect(&driver(&service), request(Provider::Anthropic, true));
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    assert!(events.iter().any(|e|matches!(e,Ok(DriverEvent::ProviderTool{activity})if activity.status==dr_agent::ProviderToolStatus::Completed&&activity.query.as_deref()==Some(query.as_str()))));
    let replay = events
        .iter()
        .find_map(|e| match e {
            Ok(DriverEvent::Replay { replay }) => Some(replay.clone()),
            _ => None,
        })
        .unwrap();
    let mut next = request(Provider::Anthropic, true);
    next.round = 2;
    next.conversation.push(ConversationEntry {
        id: "assistant".into(),
        session: next.session.clone(),
        turn: 1,
        kind: ConversationEntryKind::Assistant,
        payload: serde_json::to_value(dr_agent::AssistantMessage {
            replay: Some(replay),
            complete: true,
            ..Default::default()
        })
        .unwrap(),
    });
    let events = collect(&driver(&service), next);
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    assert!(events.iter().any(|e|matches!(e,Ok(DriverEvent::ProviderTool{activity})if activity.query.as_deref()==Some(query.as_str()))));
    service.join();
}

#[test]
fn deepseek_wire_ignores_search_and_streams_text_usage_without_tool_round_retry() {
    let text = source_text();
    let body = sse(json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}))
        + &sse(json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}))
        + &sse(json!({"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}))
        + "data: [DONE]\n\n";
    let mut service = Service::new(vec![Reply { status: 200, body }]);
    let events = collect(&driver(&service), request(Provider::Deepseek, false));
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    assert!(
        events
            .iter()
            .any(|e| matches!(e,Ok(DriverEvent::TextDelta{text:t,..})if t==&text))
    );
    service.join();
    assert!(
        service.requests.lock().unwrap()[0]
            .1
            .to_string()
            .find("web_search")
            .is_none()
    );
}
