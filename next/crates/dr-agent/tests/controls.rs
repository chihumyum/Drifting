//! Control commands are acknowledged durably and cannot outrun entered writes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use dr_agent::driver::scripted::{ScriptedDriver, Step};
use dr_agent::tools::ToolOutput;
use dr_agent::*;
use dr_model::id::{BookId, ConversationId};
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, channel::oneshot, executor::block_on, future::BoxFuture};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    book: BookId,
    text: String,
    doc: String,
    block: Value,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m27-control-test")).unwrap();
        let seed = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seed.write_to(&lib).unwrap();
        let book = seed.books[0].book_id().clone();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let chapters = ws
            .call(&Actor::User, "chapter.list", json!({"book": book}))
            .unwrap();
        let doc = format!("node:{}", chapters["output"][0]["id"].as_str().unwrap());
        let prose = ws
            .call(&Actor::User, "prose.read", json!({"doc": doc}))
            .unwrap();
        let paragraph = &prose["output"]["paragraphs"][1];
        Self {
            ws,
            book,
            text: paragraph["text"].as_str().unwrap().into(),
            doc,
            block: paragraph["block_id"].clone(),
            _dir: dir,
        }
    }

    fn start(&self, runtime: &Runtime) -> RunHandle {
        runtime
            .start(Start {
                config: dr_agent::RunConfig::new(dr_agent::Provider::Openai, "synthetic-model"),
                book: self.book.clone(),
                conversation: ConversationId::new_v7(),
                input: self.text.clone(),
            })
            .unwrap()
    }

    fn write_call(&self, id: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "write".into(),
            arguments: json!({
                "doc": self.doc, "block_id": self.block,
                "find": self.text, "replace": self.text.chars().rev().collect::<String>(),
            }),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
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

fn descriptor(name: &str, access: ToolAccess, policy: ToolPolicy) -> ToolDescriptor {
    ToolDescriptor {
        name: name.into(),
        description: name.into(),
        revision: "1".into(),
        input_schema: json!({"type":"object"}),
        access,
        policy,
    }
}

fn tool_round(calls: Vec<ToolCall>) -> Vec<Step> {
    calls
        .into_iter()
        .map(|call| Step::Event(DriverEvent::ToolCall(call)))
        .chain([Step::Event(DriverEvent::Finish(FinishReason::Tools))])
        .collect()
}

fn complete() -> Vec<Step> {
    vec![Step::Event(DriverEvent::Finish(FinishReason::Complete))]
}

fn call(id: &str, name: &str) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: json!({}),
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "control condition timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn steering_racing_with_completion_is_durably_acknowledged_or_explicitly_closed() {
    for _ in 0..8 {
        let f = Fixture::new();
        let (release, waiting) = oneshot::channel();
        let driver = Arc::new(ScriptedDriver::new(vec![
            vec![
                Step::Wait(waiting),
                Step::Event(DriverEvent::Finish(FinishReason::Complete)),
            ],
            complete(),
        ]));
        let tools = Arc::new(Tools {
            descriptors: Vec::new(),
            execute: Arc::new(|_, _| unreachable!()),
        });
        let runtime =
            Runtime::new(f.ws.clone(), driver.clone(), tools, Options::default()).unwrap();
        let run = f.start(&runtime);
        let session = run.session.clone();
        wait_until(|| !driver.requests().is_empty());
        let rendezvous = Arc::new(std::sync::Barrier::new(2));
        let sender_ready = rendezvous.clone();
        let control = run.control.clone();
        let text = f.text.clone();
        let sending = std::thread::spawn(move || {
            sender_ready.wait();
            block_on(control.steer(text))
        });
        rendezvous.wait();
        release.send(()).unwrap();
        let result = sending.join().unwrap();
        assert_eq!(run.join().unwrap(), State::Completed);
        let received = events(f.ws.library(), &session, 0).unwrap().into_iter().filter(|entry| {
            matches!(&entry.event, Event::SteeringReceived {text, ..} if text == &f.text)
        }).count();
        match result {
            Ok(()) => assert_eq!(received, 1, "an ACK requires its durable steering event"),
            Err(Error::Closed) => {
                assert_eq!(received, 0, "a racing rejected message was not accepted")
            }
            Err(error) => panic!("unexpected steering outcome: {error}"),
        }
    }
}

#[test]
fn question_rejects_stale_answer_and_resumes_with_exact_response() {
    let f = Fixture::new();
    let question = Question {
        prompt: f.text.clone(),
        options: Vec::new(),
    };
    let driver = Arc::new(ScriptedDriver::new(vec![
        tool_round(vec![call("ask-1", "ask")]),
        complete(),
    ]));
    let tools = Arc::new(Tools {
        descriptors: vec![descriptor("ask", ToolAccess::Read, ToolPolicy::Local)],
        execute: Arc::new(move |_, _| {
            futures::future::ready(Ok(ToolOutput::Question(question.clone()))).boxed()
        }),
    });
    let runtime = Runtime::new(f.ws.clone(), driver.clone(), tools, Options::default()).unwrap();
    let run = f.start(&runtime);
    wait_until(|| run.control.state() == State::AwaitingAnswer);
    let request = events(f.ws.library(), &run.session, 0)
        .unwrap()
        .into_iter()
        .find_map(|event| {
            if let Event::QuestionAsked { request, .. } = event.event {
                Some(request)
            } else {
                None
            }
        })
        .unwrap();
    let mut stale = request.clone();
    stale.call = "another-call".into();
    assert!(matches!(
        block_on(run.control.answer(stale, json!(f.text))),
        Err(Error::StaleRequest)
    ));
    assert_eq!(run.control.state(), State::AwaitingAnswer);
    assert_eq!(driver.requests().len(), 1);
    block_on(run.control.answer(request, json!(f.text))).unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    let requests = driver.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .conversation
            .iter()
            .any(|entry| entry.payload["call"] == "ask-1" && entry.payload["output"] == f.text)
    );
}

#[test]
fn permission_is_bound_to_request_and_denial_never_enters_executor() {
    let f = Fixture::new();
    let executions = Arc::new(AtomicUsize::new(0));
    let entered = executions.clone();
    let driver = Arc::new(ScriptedDriver::new(vec![
        tool_round(vec![call("plugin-1", "plugin")]),
        complete(),
    ]));
    let tools = Arc::new(Tools {
        descriptors: vec![descriptor(
            "plugin",
            ToolAccess::Read,
            ToolPolicy::ExternalPlugin,
        )],
        execute: Arc::new(move |_, _| {
            entered.fetch_add(1, Ordering::SeqCst);
            futures::future::ready(Ok(ToolOutput::Value(Value::Null))).boxed()
        }),
    });
    let runtime = Runtime::new(f.ws.clone(), driver, tools, Options::default()).unwrap();
    let run = f.start(&runtime);
    let session = run.session.clone();
    wait_until(|| run.control.state() == State::AwaitingPermission);
    let request = events(f.ws.library(), &session, 0)
        .unwrap()
        .into_iter()
        .find_map(|event| {
            if let Event::PermissionAsked {
                request, policy, ..
            } = event.event
            {
                assert_eq!(policy, ToolPolicy::ExternalPlugin);
                Some(request)
            } else {
                None
            }
        })
        .unwrap();
    let mut stale = request.clone();
    stale.nonce = "wrong-request".into();
    assert!(matches!(
        block_on(run.control.permit(stale, true)),
        Err(Error::StaleRequest)
    ));
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    block_on(run.control.permit(request, false)).unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert!(events(f.ws.library(), &session, 0).unwrap().iter().any(|event| matches!(&event.event,
        Event::ToolFinished { result } if result.call == "plugin-1" && result.status == ToolStatus::Denied)));
}

#[test]
fn changing_plugin_revision_while_waiting_invalidates_permission() {
    struct ChangingTools {
        revision: AtomicUsize,
        executions: AtomicUsize,
    }
    impl ToolExecutor for ChangingTools {
        fn descriptors(&self) -> Vec<ToolDescriptor> {
            let mut descriptor =
                descriptor("plugin", ToolAccess::Write, ToolPolicy::ExternalPlugin);
            descriptor.revision = self.revision.load(Ordering::SeqCst).to_string();
            vec![descriptor]
        }
        fn execute(&self, _: ToolContext, _: ToolCall) -> BoxFuture<'static, Result<ToolOutput>> {
            self.executions.fetch_add(1, Ordering::SeqCst);
            futures::future::ready(Ok(ToolOutput::Value(Value::Null))).boxed()
        }
    }
    let f = Fixture::new();
    let tools = Arc::new(ChangingTools {
        revision: AtomicUsize::new(1),
        executions: AtomicUsize::new(0),
    });
    let driver = Arc::new(ScriptedDriver::new(vec![
        tool_round(vec![call("plugin-1", "plugin")]),
        complete(),
    ]));
    let runtime = Runtime::new(f.ws.clone(), driver, tools.clone(), Options::default()).unwrap();
    let run = f.start(&runtime);
    let session = run.session.clone();
    wait_until(|| run.control.state() == State::AwaitingPermission);
    let request = events(f.ws.library(), &session, 0)
        .unwrap()
        .into_iter()
        .find_map(|event| {
            if let Event::PermissionAsked { request, .. } = event.event {
                Some(request)
            } else {
                None
            }
        })
        .unwrap();
    tools.revision.store(2, Ordering::SeqCst);
    block_on(run.control.permit(request, true)).unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert_eq!(tools.executions.load(Ordering::SeqCst), 0);
    assert!(events(f.ws.library(), &session, 0).unwrap().iter().any(|event| matches!(&event.event,
        Event::ToolFinished { result } if result.call == "plugin-1" && result.status == ToolStatus::Error)));
}

#[test]
fn abort_drops_stalled_driver_and_late_controls_return_closed() {
    let f = Fixture::new();
    let (_release, gate) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![vec![Step::Wait(gate)]]));
    let tools = Arc::new(Tools {
        descriptors: Vec::new(),
        execute: Arc::new(|_, _| unreachable!()),
    });
    let runtime = Runtime::new(f.ws.clone(), driver.clone(), tools, Options::default()).unwrap();
    let run = f.start(&runtime);
    wait_until(|| !driver.requests().is_empty());
    let control = run.control.clone();
    block_on(control.abort()).unwrap();
    let (finished, result) = mpsc::channel();
    let waiter = std::thread::spawn(move || finished.send(run.join()).unwrap());
    assert_eq!(
        result
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap(),
        State::Aborted
    );
    waiter.join().unwrap();
    let (finished, result) = mpsc::channel();
    let text = f.text.clone();
    let waiter = std::thread::spawn(move || {
        assert!(matches!(block_on(control.steer(text)), Err(Error::Closed)));
        assert!(matches!(
            block_on(control.stop_after_tool()),
            Err(Error::Closed)
        ));
        assert!(matches!(block_on(control.abort()), Err(Error::Closed)));
        finished.send(()).unwrap();
    });
    result
        .recv_timeout(Duration::from_secs(10))
        .expect("closed controls cannot wait for an absent worker");
    waiter.join().unwrap();
}

#[test]
fn steering_arriving_during_streaming_is_applied_at_next_model_boundary() {
    let f = Fixture::new();
    let (release, gate) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: f.text.clone(),
            }),
            Step::Wait(gate),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
        complete(),
    ]));
    let tools = Arc::new(Tools {
        descriptors: Vec::new(),
        execute: Arc::new(|_, _| unreachable!()),
    });
    let runtime = Runtime::new(f.ws.clone(), driver.clone(), tools, Options::default()).unwrap();
    let run = f.start(&runtime);
    wait_until(|| !driver.requests().is_empty());
    let steering: String = f.text.chars().rev().collect();
    block_on(run.control.steer(steering.clone())).unwrap();
    assert_eq!(driver.requests().len(), 1);
    release.send(()).unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    let requests = driver.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].turn, 2);
    assert_eq!(
        requests[1].conversation.last().unwrap().payload["text"],
        steering
    );
}

fn paused_write_tools(done: mpsc::Sender<()>, gate: oneshot::Receiver<()>) -> Arc<Tools> {
    let gate = Mutex::new(Some(gate));
    Arc::new(Tools {
        descriptors: vec![descriptor("write", ToolAccess::Write, ToolPolicy::Local)],
        execute: Arc::new(move |context, call| {
            let gate = gate
                .lock()
                .unwrap()
                .take()
                .expect("only the first write may start");
            let done = done.clone();
            async move {
                let result = context
                    .workspace_call("prose.replace", call.arguments)
                    .await?;
                done.send(()).unwrap();
                // The effect committed, but the tool has not yet settled.
                let _ = gate.await;
                Ok(ToolOutput::Value(result))
            }
            .boxed()
        }),
    })
}

#[test]
fn stop_finishes_current_write_and_cancels_unstarted_calls() {
    let f = Fixture::new();
    let (done, entered) = mpsc::channel();
    let (release, gate) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![tool_round(vec![
        f.write_call("write-1"),
        f.write_call("write-2"),
    ])]));
    let runtime = Runtime::new(
        f.ws.clone(),
        driver.clone(),
        paused_write_tools(done, gate),
        Options::default(),
    )
    .unwrap();
    let run = f.start(&runtime);
    let session = run.session.clone();
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    block_on(run.control.stop_after_tool()).unwrap();
    assert_eq!(run.control.state(), State::Stopping);
    release.send(()).unwrap();
    assert_eq!(run.join().unwrap(), State::Stopped);
    assert_eq!(driver.requests().len(), 1);
    let receipts = f.ws.library().settlements(Some(&session), None).unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].call, "write-1");
    let log = events(f.ws.library(), &session, 0).unwrap();
    assert!(
        !log.iter().any(
            |entry| matches!(&entry.event, Event::ToolStarted { call } if call.id == "write-2")
        )
    );
    assert!(log.iter().any(|entry| matches!(&entry.event, Event::ToolFinished { result } if result.call == "write-2" && result.status == ToolStatus::Cancelled)));
    assert!(
        !log.iter()
            .any(|entry| matches!(entry.event, Event::PermissionAsked { .. }))
    );
}

#[test]
fn abort_waits_for_entered_write_and_preserves_its_receipt() {
    let f = Fixture::new();
    let (done, entered) = mpsc::channel();
    let (release, gate) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![tool_round(vec![
        f.write_call("write-1"),
    ])]));
    let runtime = Runtime::new(
        f.ws.clone(),
        driver,
        paused_write_tools(done, gate),
        Options::default(),
    )
    .unwrap();
    let run = f.start(&runtime);
    let session = run.session.clone();
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    block_on(run.control.abort()).unwrap();
    assert_eq!(run.control.state(), State::Stopping);
    let (finished, result) = mpsc::channel();
    let join = std::thread::spawn(move || finished.send(run.join()).unwrap());
    assert!(matches!(
        result.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    release.send(()).unwrap();
    assert_eq!(
        result
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap(),
        State::Aborted
    );
    join.join().unwrap();
    let log = events(f.ws.library(), &session, 0).unwrap();
    let completed = log.iter().position(|event| matches!(&event.event, Event::ToolFinished { result } if result.call == "write-1" && result.settlements.len() == 1)).unwrap();
    let aborted = log
        .iter()
        .position(|event| {
            matches!(
                event.event,
                Event::StateChanged {
                    state: State::Aborted
                }
            )
        })
        .unwrap();
    assert!(completed < aborted);
    assert_eq!(
        f.ws.library()
            .settlements(Some(&session), None)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn adjacent_reads_overlap_and_later_write_waits_for_both() {
    let f = Fixture::new();
    let (first_release, first_gate) = oneshot::channel();
    let (second_release, second_gate) = oneshot::channel();
    let gates = Mutex::new(HashMap::from([
        ("read-1".to_owned(), first_gate),
        ("read-2".to_owned(), second_gate),
    ]));
    let (entered, observed) = mpsc::channel();
    let writes = Arc::new(AtomicUsize::new(0));
    let count = writes.clone();
    let tools = Arc::new(Tools {
        descriptors: vec![
            descriptor("read", ToolAccess::Read, ToolPolicy::Local),
            descriptor("write", ToolAccess::Write, ToolPolicy::Local),
        ],
        execute: Arc::new(move |_, call| {
            if call.name == "write" {
                count.fetch_add(1, Ordering::SeqCst);
                return futures::future::ready(Ok(ToolOutput::Value(Value::Null))).boxed();
            }
            let gate = gates.lock().unwrap().remove(&call.id).unwrap();
            let entered = entered.clone();
            async move {
                entered.send(call.id).unwrap();
                let _ = gate.await;
                Ok(ToolOutput::Value(Value::Null))
            }
            .boxed()
        }),
    });
    let driver = Arc::new(ScriptedDriver::new(vec![
        tool_round(vec![
            call("read-1", "read"),
            call("read-2", "read"),
            call("write-1", "write"),
        ]),
        complete(),
    ]));
    let runtime = Runtime::new(f.ws.clone(), driver, tools, Options::default()).unwrap();
    let run = f.start(&runtime);
    let session = run.session.clone();
    let first = observed.recv_timeout(Duration::from_secs(10)).unwrap();
    let second = observed.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_ne!(first, second, "both reads entered before either completes");
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    first_release.send(()).unwrap();
    wait_until(|| {
        events(f.ws.library(), &session, 0).unwrap().iter().any(|event| matches!(&event.event, Event::ToolFinished { result } if result.call == "read-1"))
    });
    assert_eq!(
        writes.load(Ordering::SeqCst),
        0,
        "second read still owns the barrier"
    );
    second_release.send(()).unwrap();
    assert_eq!(run.join().unwrap(), State::Completed);
    assert_eq!(writes.load(Ordering::SeqCst), 1);
}
