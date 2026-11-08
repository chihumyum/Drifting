use dr_agent::{
    driver::scripted::{ScriptedDriver, Step},
    tools::ToolOutput,
    *,
};
use dr_model::{
    DocId,
    id::{BookId, ConversationId},
};
use dr_store::{Library, agent::AgentEventAppend};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, future::BoxFuture};
use serde_json::{Value, json};
use std::sync::Arc;

struct Commands;
impl ToolExecutor for Commands {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![ToolDescriptor {
            name: "prose.replace".into(),
            revision: "1".into(),
            description: "fixture command".into(),
            input_schema: json!({"type":"object"}),
            access: ToolAccess::Write,
            policy: ToolPolicy::Local,
        }]
    }
    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, Result<ToolOutput>> {
        async move {
            Ok(ToolOutput::Value(
                context.workspace_call(call.name, call.arguments).await?,
            ))
        }
        .boxed()
    }
}

fn setup() -> (tempfile::TempDir, Workspace, BookId, String, Value) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("m27")).unwrap();
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = seeded.books[0].book_id().clone();
    seeded.write_to(&lib).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    ws.set_auto_links(false);
    let chapters = ws
        .call(&Actor::User, "chapter.list", json!({"book":book}))
        .unwrap();
    let doc = format!("node:{}", chapters["output"][0]["id"].as_str().unwrap());
    let prose = ws
        .call(&Actor::User, "prose.read", json!({"doc":doc}))
        .unwrap()["output"]
        .clone();
    (dir, ws, book, doc, prose)
}

fn delta(text: &str) -> Step {
    Step::Event(DriverEvent::TextDelta {
        index: 0,
        text: text.into(),
    })
}
fn done() -> Step {
    Step::Event(DriverEvent::Finish(FinishReason::Complete))
}

#[test]
fn ordinary_round_projects_one_transcript_and_replays_signed_thinking() {
    let (_dir, ws, book, _doc, prose) = setup();
    let text = prose["paragraphs"][1]["text"].as_str().unwrap();
    let thinking = prose["paragraphs"][0]["text"].as_str().unwrap();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::ThinkingDelta {
                index: 1,
                text: thinking.into(),
            }),
            Step::Event(DriverEvent::ThinkingSignature {
                index: 1,
                signature: Some("synthetic-signature".into()),
                replay: Some(json!({"synthetic":true})),
            }),
            delta(text),
            Step::Event(DriverEvent::Usage(Usage {
                input_tokens: 10,
                output_tokens: 5,
                ..Usage::default()
            })),
            Step::Event(DriverEvent::Replay {
                replay: ProviderReplay {
                    native_search: None,
                    provider: Provider::Openai,
                    items: vec![
                        json!({"type":"reasoning","encrypted_content":"synthetic-encrypted"}),
                    ],
                },
            }),
            Step::Event(DriverEvent::ProviderTool {
                activity: ProviderTool {
                    id: "search-1".into(),
                    action: ProviderToolAction::Search,
                    status: ProviderToolStatus::Completed,
                    query: Some(thinking.into()),
                    url: None,
                },
            }),
            done(),
        ],
        vec![delta(text), done()],
    ]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(Commands),
        Options::default(),
    )
    .unwrap();
    let conversation_id = ConversationId::new_v7();
    let start = Start {
        config: dr_agent::RunConfig::new(dr_agent::Provider::Openai, "synthetic-model"),
        book,
        conversation: conversation_id.clone(),
        input: text.into(),
    };
    let first = runtime.start(start.clone()).unwrap();
    let session = first.session.clone();
    assert_eq!(first.join().unwrap(), State::Completed);
    let log = events(ws.library(), &session, 0).unwrap();
    assert!(log.windows(2).all(|w| w[1].seq == w[0].seq + 1));
    let transcript = conversation(ws.library(), &conversation_id).unwrap();
    assert_eq!(transcript.len(), 2);
    assert_eq!(
        transcript[1].payload["blocks"][0]["signature"],
        "synthetic-signature"
    );
    assert_eq!(transcript[1].payload["usage"]["output_tokens"], 5);
    assert_eq!(
        transcript[1].payload["replay"]["items"][0]["encrypted_content"],
        "synthetic-encrypted"
    );
    assert!(log.iter().any(
        |row| matches!(&row.event, Event::ProviderTool {activity} if activity.id == "search-1")
    ));
    assert_eq!(
        runtime.start(start).unwrap().join().unwrap(),
        State::Completed
    );
    assert_eq!(
        driver.requests()[1].conversation.len(),
        3,
        "next run has the previous conversation and new author message"
    );
    assert!(runtime.recover().unwrap().is_empty());
    assert_eq!(
        conversation(ws.library(), &conversation_id).unwrap().len(),
        4
    );
    drop(runtime);
    ws.shutdown().unwrap();
}

#[test]
fn run_freezes_route_and_author_limit_before_tools_settle() {
    let (_dir, ws, book, doc, prose) = setup();
    let p = &prose["paragraphs"][1];
    let text = p["text"].as_str().unwrap();
    let driver = Arc::new(ScriptedDriver::new(vec![vec![
        Step::Event(DriverEvent::ToolCall(ToolCall {
            id: "limited-write".into(),
            name: "prose.replace".into(),
            arguments: json!({"doc":doc,"find":text,"replace":text.chars().rev().collect::<String>(),"block_id":p["block_id"]}),
        })),
        Step::Event(DriverEvent::Finish(FinishReason::Tools)),
    ]]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(Commands),
        Options::default(),
    )
    .unwrap();
    let mut settings = RunConfig::new(Provider::Anthropic, "synthetic-frozen-model");
    settings.route.thinking = ThinkingLevel::High;
    settings.max_model_rounds = Some(1);
    let frozen = settings.clone();
    let run = runtime
        .start(Start {
            config: settings.clone(),
            book,
            conversation: ConversationId::new_v7(),
            input: text.into(),
        })
        .unwrap();
    let session = run.session.clone();
    settings.route.provider = Provider::Deepseek;
    settings.route.model = "changed-for-next-run".into();
    settings.max_model_rounds = None;
    assert!(run.join().unwrap_err().to_string().contains("round limit"));
    assert_eq!(driver.requests().len(), 1);
    assert_eq!(*driver.requests()[0].config, frozen);
    let log = events(ws.library(), &session, 0).unwrap();
    assert!(
        log.iter()
            .any(|row| matches!(&row.event, Event::Configured {config} if config == &frozen))
    );
    assert!(log.iter().any(
        |row| matches!(&row.event, Event::ToolFinished {result} if !result.settlements.is_empty())
    ));
    assert_ne!(settings, frozen);
    drop(runtime);
    ws.shutdown().unwrap();
}

#[test]
fn scripted_tool_writes_book_leaves_receipts_and_can_be_undone() {
    let (_dir, ws, book, doc, prose) = setup();
    let p = &prose["paragraphs"][1];
    let text = p["text"].as_str().unwrap();
    let replacement: String = text.chars().rev().collect();
    let call = ToolCall {
        id: "replace-1".into(),
        name: "prose.replace".into(),
        arguments: json!({"doc":doc,"find":text,"replace":replacement,"block_id":p["block_id"]}),
    };
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::ToolCall(call)),
            Step::Event(DriverEvent::Finish(FinishReason::Tools)),
        ],
        vec![delta(text), done()],
    ]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(Commands),
        Options::default(),
    )
    .unwrap();
    let cid = ConversationId::new_v7();
    let run = runtime
        .start(Start {
            config: dr_agent::RunConfig::new(dr_agent::Provider::Openai, "synthetic-model"),
            book,
            conversation: cid.clone(),
            input: text.into(),
        })
        .unwrap();
    let session = run.session.clone();
    assert_eq!(run.join().unwrap(), State::Completed);
    let log = events(ws.library(), &session, 0).unwrap();
    let result = log
        .iter()
        .find_map(|r| {
            if let Event::ToolFinished { result } = &r.event {
                Some(result)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(result.status, ToolStatus::Success);
    assert_eq!(result.settlements.len(), 1);
    assert!(
        !log.iter()
            .any(|e| matches!(e.event, Event::PermissionAsked { .. }))
    );
    assert_eq!(
        ws.call(&Actor::User, "prose.read", json!({"doc":doc}))
            .unwrap()["output"]["paragraphs"][1]["text"],
        replacement
    );
    ws.call(
        &Actor::User,
        "history.undo_agent",
        json!({"session":session,"turn":1}),
    )
    .unwrap();
    assert_eq!(
        ws.call(&Actor::User, "prose.read", json!({"doc":doc}))
            .unwrap()["output"]["paragraphs"],
        prose["paragraphs"]
    );
    let transcript = conversation(ws.library(), &cid).unwrap();
    let serialized = serde_json::to_string(&transcript).unwrap();
    assert!(
        !serialized.contains("settlements"),
        "local receipt identities do not sync"
    );
    assert_eq!(driver.requests().len(), 2);
    drop(runtime);
    ws.shutdown().unwrap();
}

fn append(lib: &Library, session: &str, seq: i64, event: Event) {
    lib.agent_append_event(&AgentEventAppend {
        session: session.into(),
        expected_seq: seq,
        event_json: json!({"turn":1,"event":event}).to_string(),
    })
    .unwrap();
}

#[test]
fn recovery_reconciles_commit_before_result_and_replays_projection_once() {
    let (dir, ws, book, doc, prose) = setup();
    let cid = ConversationId::new_v7();
    let session = "recovery-synthetic";
    ws.library()
        .agent_create_session(
            session,
            &DocId::Conversation(cid.clone()).to_string(),
            book.as_str(),
        )
        .unwrap();
    let p = &prose["paragraphs"][1];
    let text = p["text"].as_str().unwrap();
    let call = ToolCall {
        id: "write".into(),
        name: "prose.replace".into(),
        arguments: json!({"doc":doc,"find":text,"replace":text.chars().rev().collect::<String>(),"block_id":p["block_id"]}),
    };
    append(
        ws.library(),
        session,
        0,
        Event::Started {
            version: PROTOCOL_VERSION,
        },
    );
    append(
        ws.library(),
        session,
        1,
        Event::UserMessage { text: text.into() },
    );
    append(
        ws.library(),
        session,
        2,
        Event::StateChanged {
            state: State::Streaming,
        },
    );
    append(
        ws.library(),
        session,
        3,
        Event::TextDelta {
            index: 0,
            text: text.into(),
        },
    );
    append(
        ws.library(),
        session,
        4,
        Event::ToolProposed { call: call.clone() },
    );
    append(
        ws.library(),
        session,
        5,
        Event::ToolStarted { call: call.clone() },
    );
    ws.call(
        &Actor::agent(session, 1, &call.id),
        &call.name,
        call.arguments.clone(),
    )
    .unwrap();
    // Simulates a lost process after F2 commits but before ToolFinished and
    // before any synchronized conversation projection is written.
    ws.shutdown().unwrap();
    let ws = Workspace::open_dir(dir.path(), "m27").unwrap();
    let driver = Arc::new(ScriptedDriver::new(vec![]));
    let runtime = Runtime::new(
        ws.clone(),
        driver.clone(),
        Arc::new(Commands),
        Options::default(),
    )
    .unwrap();
    let recovered = runtime.recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].state, State::Interrupted);
    assert_eq!(recovered[0].settlements.len(), 1);
    assert!(
        driver.requests().is_empty(),
        "recovery never calls the driver or tools"
    );
    let transcript = conversation(ws.library(), &cid).unwrap();
    assert_eq!(transcript.len(), 3);
    assert_eq!(transcript[1].payload["complete"], false);
    assert_eq!(transcript[2].payload["status"], "interrupted");
    assert!(runtime.recover().unwrap().is_empty());
    assert_eq!(conversation(ws.library(), &cid).unwrap(), transcript);
    assert_eq!(
        ws.library().settlements(Some(session), None).unwrap().len(),
        1
    );
    drop(runtime);
    ws.shutdown().unwrap();
}

#[test]
fn premature_driver_eof_preserves_partial_message_and_fails() {
    let (_dir, ws, book, _doc, prose) = setup();
    let text = prose["paragraphs"][1]["text"].as_str().unwrap();
    let runtime = Runtime::new(
        ws.clone(),
        Arc::new(ScriptedDriver::new(vec![vec![delta(text)]])),
        Arc::new(Commands),
        Options::default(),
    )
    .unwrap();
    let cid = ConversationId::new_v7();
    let run = runtime
        .start(Start {
            config: dr_agent::RunConfig::new(dr_agent::Provider::Openai, "synthetic-model"),
            book,
            conversation: cid.clone(),
            input: text.into(),
        })
        .unwrap();
    let control = run.control.clone();
    assert!(run.join().is_err());
    assert_eq!(control.state(), State::Failed);
    assert_eq!(
        conversation(ws.library(), &cid).unwrap()[1].payload["complete"],
        false
    );
    assert!(matches!(
        futures::executor::block_on(control.steer(text)),
        Err(Error::Closed)
    ));
    drop(runtime);
    ws.shutdown().unwrap();
}
