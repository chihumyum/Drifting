//! The panel service uses the real journal, conversation projection and F3
//! writes with an offline driver. Every prose string comes from F8's seed.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use dr_agent::{
    driver::scripted::{ScriptedDriver, Step},
    tools::ToolOutput,
    *,
};
use dr_doc::conversation::ConversationDoc;
use dr_model::{
    DocId, Origin,
    conversation::{ConversationEntry, ConversationEntryKind},
    id::{BookId, ConversationId},
};
use dr_store::{Library, agent::AgentEventAppend};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{controller::AgentController, state::MessageContent};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, channel::oneshot, executor::block_on, future::BoxFuture};
use serde_json::{Value, json};

struct Fixture {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    doc: String,
    paragraph: Value,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m31-controller")).unwrap();
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
            .unwrap();
        let paragraph = prose["output"]["paragraphs"][1].clone();
        Self {
            dir,
            ws,
            book,
            doc,
            paragraph,
        }
    }

    fn text(&self) -> String {
        self.paragraph["text"].as_str().unwrap().to_owned()
    }

    fn start(&self, conversation: ConversationId) -> Start {
        Start {
            config: RunConfig::new(Provider::Openai, "synthetic-model"),
            book: self.book.clone(),
            conversation,
            input: self.text(),
        }
    }

    fn write(&self) -> ToolCall {
        ToolCall {
            id: "write-1".into(),
            name: "write".into(),
            arguments: json!({
                "doc":self.doc,"find":self.text(),"replace":self.text().chars().rev().collect::<String>(),"block_id":self.paragraph["block_id"],
            }),
        }
    }
}

type Execute =
    dyn Fn(ToolContext, ToolCall) -> BoxFuture<'static, Result<ToolOutput>> + Send + Sync;
struct Tools {
    descriptors: Vec<ToolDescriptor>,
    execute: Arc<Execute>,
}
impl ToolExecutor for Tools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        self.descriptors.clone()
    }
    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, Result<ToolOutput>> {
        (self.execute)(context, call)
    }
}

fn no_tools() -> Arc<Tools> {
    Arc::new(Tools {
        descriptors: Vec::new(),
        execute: Arc::new(|_, _| async { panic!("no tool was offered") }.boxed()),
    })
}

fn descriptor(name: &str, access: ToolAccess) -> ToolDescriptor {
    ToolDescriptor {
        name: name.into(),
        revision: "1".into(),
        description: name.into(),
        input_schema: json!({"type":"object"}),
        access,
        policy: ToolPolicy::Local,
    }
}

fn event(event: DriverEvent) -> Step {
    Step::Event(event)
}
fn finish(reason: FinishReason) -> Step {
    event(DriverEvent::Finish(reason))
}
fn wait(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "Agent service condition timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn streaming_question_search_and_completion_are_rebuilt_without_a_panel() {
    let f = Fixture::new();
    let (release, blocked) = oneshot::channel();
    let text = f.text();
    let query = text.clone();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            event(DriverEvent::ThinkingDelta {
                index: 0,
                text: text.clone(),
            }),
            event(DriverEvent::TextDelta {
                index: 1,
                text: text.clone(),
            }),
            Step::Wait(blocked),
            event(DriverEvent::ToolCall(ToolCall {
                id: "ask-1".into(),
                name: "ask_user".into(),
                arguments: json!({"prompt":text,"options":[text]}),
            })),
            finish(FinishReason::Tools),
        ],
        vec![
            event(DriverEvent::ProviderTool {
                activity: ProviderTool {
                    id: "search-1".into(),
                    action: ProviderToolAction::Search,
                    status: ProviderToolStatus::Started,
                    query: Some(query.clone()),
                    url: None,
                },
            }),
            event(DriverEvent::ProviderTool {
                activity: ProviderTool {
                    id: "search-1".into(),
                    action: ProviderToolAction::Search,
                    status: ProviderToolStatus::Completed,
                    query: None,
                    url: None,
                },
            }),
            event(DriverEvent::TextDelta {
                index: 2,
                text: text.clone(),
            }),
            event(DriverEvent::Usage(Usage {
                input_tokens: 55,
                output_tokens: 12,
                ..Usage::default()
            })),
            finish(FinishReason::Complete),
        ],
    ]));
    let tools = Arc::new(dr_view_agent::tools::CompanionTools::default());
    let controller = AgentController::new(f.ws.clone(), driver.clone(), tools).unwrap();
    let notifications = Arc::new(AtomicUsize::new(0));
    let count = notifications.clone();
    let subscription = controller.subscribe(Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    }));
    let conversation = ConversationId::new_v7();
    assert!(
        controller
            .snapshot(&f.book, &conversation)
            .unwrap()
            .messages
            .is_empty()
    );
    let mut start = f.start(conversation.clone());
    start.config.system_prompt = text.clone();
    let session = controller.start(start.clone()).unwrap();
    start.config.system_prompt.clear();
    drop(controller.clone()); // An unmounted pane owns no handle.
    wait(|| {
        controller.snapshot(&f.book, &conversation).unwrap().runs[0]
            .live_message
            .as_ref()
            .is_some_and(|message| message.blocks.len() == 2)
    });
    assert!(controller.start(f.start(conversation.clone())).is_err());
    assert_eq!(driver.requests()[0].config.system_prompt, text);
    assert_eq!(
        controller.list(&f.book).unwrap()[0].active.as_slice(),
        std::slice::from_ref(&session)
    );
    release.send(()).unwrap();
    wait(|| {
        controller.snapshot(&f.book, &conversation).unwrap().runs[0]
            .question
            .is_some()
    });
    let pending = controller.snapshot(&f.book, &conversation).unwrap().runs[0]
        .question
        .clone()
        .unwrap();
    let control = controller.control(&session).unwrap();
    let mut stale = pending.request.clone();
    stale.nonce = "stale".into();
    assert!(matches!(
        block_on(control.answer(stale, json!(text))),
        Err(Error::StaleRequest)
    ));
    block_on(control.answer(pending.request, json!(text))).unwrap();
    wait(|| controller.active_count() == 0);
    let snapshot = controller.snapshot(&f.book, &conversation).unwrap();
    let run = &snapshot.runs[0];
    assert_eq!(run.state, State::Completed);
    assert!(run.live_message.is_none());
    assert!(run.question.is_none());
    assert_eq!(run.questions[0].answer, Some(json!(text)));
    assert_eq!(run.provider_tools.len(), 1);
    assert_eq!(run.provider_tools[0].query, Some(query));
    assert_eq!(run.provider_tools[0].status, ProviderToolStatus::Completed);
    assert_eq!(run.usage.input_tokens, 55);
    assert_eq!(snapshot.messages.len(), 4); // author, assistant/tool, tool answer, final
    assert!(matches!(
        snapshot.messages[0].content,
        MessageContent::User { .. }
    ));
    assert_eq!(
        snapshot.entries,
        dr_agent::conversation(f.ws.library(), &conversation).unwrap()
    );
    assert!(controller.control(&session).is_none());
    assert!(notifications.load(Ordering::SeqCst) > 0);
    block_on(controller.close()).unwrap();
    block_on(controller.close()).unwrap();
    assert!(controller.is_closed());
    assert!(controller.snapshot(&f.book, &conversation).is_err());
    // Closed views and subscriptions retain no Workspace strong references.
    f.ws.try_shutdown().unwrap();
    drop(subscription);
}

#[test]
fn close_freezes_immediately_aborts_every_run_and_waits_for_entered_write() {
    let f = Fixture::new();
    let (entered, entered_rx) = mpsc::channel();
    let (release, blocked) = oneshot::channel();
    let blocked = Arc::new(Mutex::new(Some(blocked)));
    let tools = Arc::new(Tools {
        descriptors: vec![descriptor("write", ToolAccess::Write)],
        execute: Arc::new(move |context, call| {
            let gate = blocked.lock().unwrap().take().unwrap();
            let entered = entered.clone();
            async move {
                let result = context
                    .workspace_call("prose.replace", call.arguments)
                    .await?;
                entered.send(()).unwrap();
                // An entered write future owns settlement until it resolves.
                let _ = gate.await;
                Ok(ToolOutput::Value(result))
            }
            .boxed()
        }),
    });
    let (_hold, waiting) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            event(DriverEvent::ToolCall(f.write())),
            finish(FinishReason::Tools),
        ],
        vec![Step::Wait(waiting)],
    ]));
    let controller = AgentController::new(f.ws.clone(), driver, tools).unwrap();
    let first = controller.start(f.start(ConversationId::new_v7())).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let second = controller.start(f.start(ConversationId::new_v7())).unwrap();
    let second_control = controller.control(&second).unwrap();
    let mut close = controller.close();
    assert!(controller.is_closed());
    assert!(controller.start(f.start(ConversationId::new_v7())).is_err());
    // Synchronous freeze delivers every abort before anybody polls the
    // barrier. A stalled driver must already be cancelled.
    wait(|| second_control.state() == State::Aborted);
    assert!(
        close.as_mut().now_or_never().is_none(),
        "entered write still owns its completion"
    );
    release.send(()).unwrap();
    block_on(close).unwrap();
    let log = events(f.ws.library(), &first, 0).unwrap();
    assert!(log.iter().any(
        |row| matches!(&row.event,Event::ToolFinished{result} if !result.settlements.is_empty())
    ));
    assert!(matches!(
        log.last().unwrap().event,
        Event::StateChanged {
            state: State::Aborted
        }
    ));
    assert_eq!(
        f.ws.call(&Actor::User, "prose.read", json!({"doc":f.doc}))
            .unwrap()["output"]["paragraphs"][1]["text"],
        f.text().chars().rev().collect::<String>()
    );
    f.ws.try_shutdown().unwrap();
}

#[test]
fn synchronized_conversations_are_listed_and_interrupted_controls_are_recovered() {
    let f = Fixture::new();
    let synced = ConversationId::new_v7();
    let mut doc = ConversationDoc::create(synced.clone(), 42).unwrap();
    let entry = ConversationEntry {
        id: "synthetic-remote:1".into(),
        session: "synthetic-remote".into(),
        turn: 1,
        kind: ConversationEntryKind::User,
        payload: json!({"text":f.text()}),
    };
    doc.append(Origin::User, &entry).0.unwrap();
    f.ws.import_remote(
        &DocId::Conversation(synced.clone()).to_string(),
        Some(("conversation", f.book.as_str())),
        doc.export_snapshot().unwrap(),
        &Actor::User,
    )
    .unwrap();
    assert!(f.ws.library().agent_sessions(None).unwrap().is_empty());
    let interrupted = ConversationId::new_v7();
    let session = "synthetic-interrupted";
    f.ws.library()
        .agent_create_session(
            session,
            &DocId::Conversation(interrupted.clone()).to_string(),
            f.book.as_str(),
        )
        .unwrap();
    let request = RequestId {
        session: session.into(),
        turn: 1,
        call: "ask-1".into(),
        nonce: "synthetic-nonce".into(),
    };
    let fixture_events = [
        Event::Started {
            version: PROTOCOL_VERSION,
        },
        Event::Configured {
            config: f.start(interrupted.clone()).config,
        },
        Event::UserMessage { text: f.text() },
        Event::StateChanged {
            state: State::Streaming,
        },
        Event::TextDelta {
            index: 0,
            text: f.text(),
        },
        Event::SteeringReceived {
            id: "queued".into(),
            text: f.text(),
        },
        Event::QuestionAsked {
            request,
            question: Question {
                prompt: f.text(),
                options: Vec::new(),
            },
        },
        Event::StateChanged {
            state: State::AwaitingAnswer,
        },
    ];
    for (index, event) in fixture_events.into_iter().enumerate() {
        f.ws.library()
            .agent_append_event(&AgentEventAppend {
                session: session.into(),
                expected_seq: index as i64,
                event_json: json!({"turn":1,"event":event}).to_string(),
            })
            .unwrap();
    }
    let driver = Arc::new(ScriptedDriver::new(Vec::new()));
    let controller = AgentController::new(f.ws.clone(), driver.clone(), no_tools()).unwrap();
    assert!(
        driver.requests().is_empty(),
        "recovery must never restart a model"
    );
    let list = controller.list(&f.book).unwrap();
    assert_eq!(list.len(), 2);
    let remote = list.iter().find(|item| item.id == synced).unwrap();
    assert_eq!(remote.message_count, 1);
    assert!(remote.active.is_empty());
    assert_eq!(
        controller.snapshot(&f.book, &synced).unwrap().entries,
        vec![entry]
    );
    assert!(controller.snapshot(&BookId::new_v7(), &synced).is_err());
    let snapshot = controller.snapshot(&f.book, &interrupted).unwrap();
    let run = &snapshot.runs[0];
    assert_eq!(run.state, State::Interrupted);
    assert!(run.question.is_none());
    assert_eq!(run.questions.len(), 1);
    assert_eq!(run.unapplied_steering[0].text, f.text());
    assert_eq!(snapshot.messages.len(), 2); // recovered partial answer is durable
    assert!(
        matches!(&snapshot.messages[1].content,MessageContent::Assistant{message} if !message.complete)
    );
    let before = snapshot.entries;
    block_on(controller.close()).unwrap();
    let reopened = AgentController::new(f.ws.clone(), driver, no_tools()).unwrap();
    assert_eq!(
        reopened.snapshot(&f.book, &interrupted).unwrap().entries,
        before
    );
    block_on(reopened.close()).unwrap();
    f.ws.try_shutdown().unwrap();
    assert!(f.dir.path().exists());
}

#[test]
fn service_and_snapshots_are_send_and_sync() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<AgentController>();
    send_sync::<dr_view_agent::state::ChatSnapshot>();
}

#[test]
fn close_returns_while_a_read_is_busy_and_waits_for_its_last_reference() {
    let f = Fixture::new();
    let controller = AgentController::new(
        f.ws.clone(),
        Arc::new(ScriptedDriver::new(Vec::new())),
        no_tools(),
    )
    .unwrap();
    let (entered, entered_rx) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let reader = controller.clone();
    let book = f.book.clone();
    let read = std::thread::spawn(move || {
        reader.with_workspace_read(|ws| {
            entered.send(()).unwrap();
            blocked.recv().unwrap();
            ws.call(&Actor::User, "chapter.list", json!({"book":book}))
                .map(|value| value["output"].clone())
                .map_err(|error| error.to_string())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let closing = controller.clone();
    let (returned, returned_rx) = mpsc::channel();
    let caller = std::thread::spawn(move || returned.send(closing.close()).unwrap());
    let mut close = returned_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("close must freeze without waiting on the read mutex");
    caller.join().unwrap();
    assert!(controller.is_closed());
    assert!(controller.control("any-session").is_none());
    assert!(controller.list(&f.book).is_err());
    assert!(close.as_mut().now_or_never().is_none());
    release.send(()).unwrap();
    assert!(
        read.join()
            .unwrap()
            .unwrap()
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    );
    block_on(close).unwrap();
    f.ws.try_shutdown().unwrap();
}

#[test]
fn close_covers_a_start_blocked_on_the_conversation_holder() {
    let f = Fixture::new();
    let conversation = ConversationId::new_v7();
    let doc_id = DocId::Conversation(conversation.clone()).to_string();
    let genesis = dr_doc::conversation::genesis(&conversation);
    let handle =
        f.ws.library()
            .open_doc(
                &doc_id,
                dr_store::OpenDoc::CreateIfMissing {
                    kind: "conversation",
                    book_id: Some(f.book.as_str()),
                    genesis: &|doc| {
                        doc.import(&genesis).unwrap();
                    },
                },
            )
            .unwrap();
    let (_keep, blocked_model) = oneshot::channel();
    let controller = AgentController::new(
        f.ws.clone(),
        Arc::new(ScriptedDriver::new(vec![vec![Step::Wait(blocked_model)]])),
        no_tools(),
    )
    .unwrap();
    let (entered, entered_rx) = mpsc::channel();
    let (release, blocked_holder) = mpsc::channel();
    let held = std::thread::spawn(move || {
        handle
            .read(move |_| {
                entered.send(()).unwrap();
                blocked_holder.recv().unwrap();
            })
            .unwrap()
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let starting = controller.clone();
    let request = f.start(conversation);
    let start = std::thread::spawn(move || starting.start(request));
    wait(|| !f.ws.library().agent_sessions(None).unwrap().is_empty());
    let closing = controller.clone();
    let (returned, returned_rx) = mpsc::channel();
    let caller = std::thread::spawn(move || returned.send(closing.close()).unwrap());
    let mut close = returned_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("close must not wait synchronously for session projection");
    caller.join().unwrap();
    assert!(controller.is_closed());
    assert!(close.as_mut().now_or_never().is_none());
    release.send(()).unwrap();
    held.join().unwrap();
    assert!(start.join().unwrap().is_err());
    block_on(close).unwrap();
    let sessions = f.ws.library().agent_sessions(None).unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(matches!(
        events(f.ws.library(), &sessions[0].session, 0)
            .unwrap()
            .last()
            .unwrap()
            .event,
        Event::StateChanged {
            state: State::Aborted
        }
    ));
    f.ws.try_shutdown().unwrap();
}
