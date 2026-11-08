//! A malformed or panicking adapter cannot discard durable output or keep
//! the dead run registered as active forever.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use dr_agent::driver::scripted::{ScriptedDriver, Step};
use dr_agent::tools::ToolOutput;
use dr_agent::*;
use dr_model::conversation::ConversationEntryKind;
use dr_model::id::{BookId, ConversationId};
use dr_store::{Library, agent::AgentEventAppend};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, StreamExt, future::BoxFuture, stream::BoxStream};
use serde_json::json;

struct Fixture {
    ws: Workspace,
    book: BookId,
    text: String,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m27-error-test")).unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(&lib).unwrap();
        let book = seeded.books[0].book_id().clone();
        let text = seeded.books[0].prose[0]
            .view()
            .paragraphs()
            .nth(1)
            .unwrap()
            .text();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        Self {
            ws,
            book,
            text,
            _dir: dir,
        }
    }

    fn start(&self, runtime: &Runtime, conversation: &ConversationId) -> RunHandle {
        runtime
            .start(Start {
                config: dr_agent::RunConfig::new(dr_agent::Provider::Openai, "synthetic-model"),
                book: self.book.clone(),
                conversation: conversation.clone(),
                input: self.text.clone(),
            })
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

#[test]
fn dropping_a_run_aborts_a_stalled_driver_instead_of_leaking_a_worker() {
    let f = Fixture::new();
    let (_release, wait) = futures::channel::oneshot::channel();
    let runtime = Runtime::new(
        f.ws.clone(),
        Arc::new(ScriptedDriver::new(vec![vec![Step::Wait(wait)]])),
        Arc::new(CountingTools::default()),
        Options::default(),
    )
    .unwrap();
    let run = f.start(&runtime, &ConversationId::new_v7());
    let control = run.control.clone();
    drop(run);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !control.state().is_terminal() {
        assert!(
            std::time::Instant::now() < deadline,
            "dropped run kept its worker alive"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    assert_eq!(control.state(), State::Aborted);
}

#[derive(Default)]
struct CountingTools(AtomicUsize);

impl ToolExecutor for CountingTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![ToolDescriptor {
            name: "read".into(),
            description: "read".into(),
            revision: "1".into(),
            input_schema: json!({"type": "object"}),
            access: ToolAccess::Read,
            policy: ToolPolicy::Local,
        }]
    }

    fn execute(&self, _: ToolContext, _: ToolCall) -> BoxFuture<'static, Result<ToolOutput>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        futures::future::ready(Ok(ToolOutput::Value(json!(null)))).boxed()
    }
}

#[test]
fn conflicting_block_kinds_fail_without_losing_preceding_text() {
    let f = Fixture::new();
    let conversation_id = ConversationId::new_v7();
    let driver = Arc::new(ScriptedDriver::new(vec![vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: f.text.clone(),
        }),
        Step::Event(DriverEvent::ThinkingDelta {
            index: 0,
            text: f.text.clone(),
        }),
    ]]));
    let tools = Arc::new(CountingTools::default());
    let runtime = Runtime::new(f.ws.clone(), driver, tools.clone(), Options::default()).unwrap();
    let run = f.start(&runtime, &conversation_id);
    let control = run.control.clone();
    assert!(matches!(run.join(), Err(Error::Protocol(_))));
    assert_eq!(control.state(), State::Failed);
    assert_eq!(tools.0.load(Ordering::SeqCst), 0);
    let transcript = conversation(f.ws.library(), &conversation_id).unwrap();
    let assistant = transcript
        .iter()
        .find(|entry| entry.kind == ConversationEntryKind::Assistant)
        .unwrap();
    let message: AssistantMessage = serde_json::from_value(assistant.payload.clone()).unwrap();
    assert!(!message.complete);
    assert_eq!(
        message.blocks,
        vec![ContentBlock::Text {
            index: 0,
            text: f.text.clone()
        }]
    );
    assert!(runtime.recover().unwrap().is_empty());
    assert_eq!(
        conversation(f.ws.library(), &conversation_id).unwrap(),
        transcript
    );
}

#[test]
fn driver_failure_closes_proposed_tool_without_executing_it() {
    let f = Fixture::new();
    let conversation_id = ConversationId::new_v7();
    let proposed = ToolCall {
        id: "proposed-1".into(),
        name: "read".into(),
        arguments: json!({}),
    };
    let driver = Arc::new(ScriptedDriver::new(vec![vec![
        Step::Event(DriverEvent::ToolCall(proposed.clone())),
        Step::Fail("synthetic provider failure".into()),
    ]]));
    let tools = Arc::new(CountingTools::default());
    let runtime = Runtime::new(f.ws.clone(), driver, tools.clone(), Options::default()).unwrap();
    let run = f.start(&runtime, &conversation_id);
    let session = run.session.clone();
    assert!(matches!(run.join(), Err(Error::Driver(_))));
    assert_eq!(tools.0.load(Ordering::SeqCst), 0);
    let log = events(f.ws.library(), &session, 0).unwrap();
    assert!(
        !log.iter()
            .any(|event| matches!(event.event, Event::ToolStarted { .. }))
    );
    let results: Vec<_> = log
        .iter()
        .filter_map(|event| {
            if let Event::ToolFinished { result } = &event.event {
                Some(result)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].call, proposed.id);
    assert_ne!(results[0].status, ToolStatus::Success);
    assert!(results[0].settlements.is_empty());
    let transcript = conversation(f.ws.library(), &conversation_id).unwrap();
    assert!(
        transcript
            .iter()
            .any(|entry| entry.kind == ConversationEntryKind::ToolResult
                && entry.payload["call"] == proposed.id)
    );
    runtime.recover().unwrap();
    assert_eq!(
        conversation(f.ws.library(), &conversation_id).unwrap(),
        transcript
    );
}

enum PanicAt {
    Stream,
    Poll,
}

impl Driver for PanicAt {
    fn stream(&self, _: DriverRequest, _: Cancellation) -> BoxStream<'static, Result<DriverEvent>> {
        match self {
            Self::Stream => panic!("synthetic stream-construction panic"),
            Self::Poll => {
                futures::stream::poll_fn(|_| panic!("synthetic stream-poll panic")).boxed()
            }
        }
    }
}

#[test]
fn panicking_driver_is_failed_and_unregisters_dead_execution() {
    for panic_at in [PanicAt::Stream, PanicAt::Poll] {
        let f = Fixture::new();
        let conversation_id = ConversationId::new_v7();
        let runtime = Runtime::new(
            f.ws.clone(),
            Arc::new(panic_at),
            Arc::new(CountingTools::default()),
            Options::default(),
        )
        .unwrap();
        let run = f.start(&runtime, &conversation_id);
        let session = run.session.clone();
        let control = run.control.clone();
        assert!(
            matches!(run.join(), Err(Error::Protocol(message)) if message.contains("panicked"))
        );
        assert_eq!(control.state(), State::Failed);
        let log = events(f.ws.library(), &session, 0).unwrap();
        assert!(
            log.iter()
                .any(|event| matches!(event.event, Event::Failed { .. }))
        );
        assert!(runtime.recover().unwrap().is_empty());
        // Make the tail nonterminal to expose a stale in-memory active-set
        // entry: recovery must inspect it, not skip a worker that is dead.
        f.ws.library()
            .agent_append_event(&AgentEventAppend {
                session: session.clone(),
                expected_seq: log.last().unwrap().seq,
                event_json:
                    json!({"turn": 1, "event": Event::StateChanged { state: State::Streaming }})
                        .to_string(),
            })
            .unwrap();
        let recovered = runtime.recover().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].session, session);
        assert_eq!(recovered[0].state, State::Interrupted);
        assert!(runtime.recover().unwrap().is_empty());
    }
}

#[test]
fn library_has_one_runtime_owner_until_all_clones_are_dropped() {
    let f = Fixture::new();
    let create = || {
        Runtime::new(
            f.ws.clone(),
            Arc::new(ScriptedDriver::new(Vec::new())),
            Arc::new(CountingTools::default()),
            Options::default(),
        )
    };
    let runtime = create().unwrap();
    assert!(matches!(create(), Err(Error::Protocol(_))));
    let clone = runtime.clone();
    drop(runtime);
    assert!(matches!(create(), Err(Error::Protocol(_))));
    drop(clone);
    let reopened = create().expect("dropping the last owner releases the library runtime slot");
    assert!(reopened.recover().unwrap().is_empty());
}

#[test]
fn conversation_cannot_be_rebound_to_another_book_or_poison_recovery() {
    let f = Fixture::new();
    let second = seed::generate(Preset::Tiny, seed::DEFAULT_SEED + 1).unwrap();
    second.write_to(f.ws.library()).unwrap();
    let second_book = second.books[0].book_id().clone();
    assert_ne!(f.book, second_book);
    let driver = Arc::new(ScriptedDriver::new(vec![vec![Step::Event(
        DriverEvent::Finish(FinishReason::Complete),
    )]]));
    let runtime = Runtime::new(
        f.ws.clone(),
        driver,
        Arc::new(CountingTools::default()),
        Options::default(),
    )
    .unwrap();
    let conversation = ConversationId::new_v7();
    assert_eq!(
        f.start(&runtime, &conversation).join().unwrap(),
        State::Completed
    );
    let sessions_before = f.ws.library().agent_sessions(None).unwrap().len();
    assert!(
        runtime
            .start(Start {
                config: dr_agent::RunConfig::new(dr_agent::Provider::Openai, "synthetic-model"),
                book: second_book,
                conversation,
                input: f.text.clone(),
            })
            .is_err()
    );
    assert_eq!(
        f.ws.library().agent_sessions(None).unwrap().len(),
        sessions_before
    );
    assert!(runtime.recover().unwrap().is_empty());
}
