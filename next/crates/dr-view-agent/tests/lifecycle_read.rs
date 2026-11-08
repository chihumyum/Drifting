//! Cancelling a model read may drop its future while M29's synchronous F3
//! worker is still inside a document load. Library release must await that
//! worker's ToolContext, not just the already-aborted model run.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, Event, FinishReason, Provider, RunConfig, Start, State, ToolAccess, ToolCall,
    ToolContext, ToolDescriptor, ToolExecutor, ToolPolicy,
    driver::scripted::{ScriptedDriver, Step},
    tools::ToolOutput,
};
use dr_agent_tools::AgentTools;
use dr_model::id::ConversationId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_view_agent::controller::AgentController;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, channel::oneshot, executor::block_on, future::BoxFuture};
use serde_json::json;

struct Release(Option<mpsc::Sender<()>>);

impl Release {
    fn open(&mut self) {
        if let Some(send) = self.0.take() {
            let _ = send.send(());
        }
    }
}

impl Drop for Release {
    fn drop(&mut self) {
        self.open();
    }
}

#[test]
fn closing_waits_for_a_cancelled_m29_read_worker_before_releasing_the_library() {
    cancelled_read(ReadPath::Facade);
}

#[test]
fn closing_waits_for_a_cancelled_workspace_call_worker_context() {
    cancelled_read(ReadPath::WorkspaceCall);
}

#[derive(Clone, Copy)]
enum ReadPath {
    Facade,
    WorkspaceCall,
}

struct WorkspaceRead;

impl ToolExecutor for WorkspaceRead {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![ToolDescriptor {
            name: "read".into(),
            revision: "1".into(),
            description: "Read the synthetic chapter through ToolContext".into(),
            input_schema: json!({"type":"object"}),
            access: ToolAccess::Read,
            policy: ToolPolicy::Local,
        }]
    }

    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, dr_agent::Result<ToolOutput>> {
        async move {
            Ok(ToolOutput::Value(
                context.workspace_call("prose.read", call.arguments).await?,
            ))
        }
        .boxed()
    }
}

fn cancelled_read(path: ReadPath) {
    let dir = tempfile::tempdir().unwrap();
    let armed = Arc::new(AtomicBool::new(false));
    let checkpoint = armed.clone();
    let (entered, entered_rx) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let mut release = Release(Some(release));
    let blocked = Mutex::new(blocked);
    let mut options = library_options("m31-entered-read");
    let configure = options.configure_doc.take();
    options.configure_doc = Some(Arc::new(move |doc| {
        if let Some(configure) = &configure {
            configure(doc);
        }
        // The production M29 executor has already entered its OS thread,
        // passed its cancellation check, and reached F2's holder load path.
        // Seed setup, indexing and the runtime's journal never take this gate.
        let worker = match path {
            ReadPath::Facade => "dr-agent-facade",
            ReadPath::WorkspaceCall => "dr-agent-tool",
        };
        if std::thread::current().name() == Some(worker) && checkpoint.swap(false, Ordering::SeqCst)
        {
            entered.send(()).unwrap();
            blocked
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(15))
                .unwrap();
        }
    }));
    let lib = Library::open(dir.path(), options).unwrap();
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = seeded.books[0].book_id().clone();
    let input = seeded.books[0].prose[0].view().plain_text();
    seeded.write_to(&lib).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let chapters = ws
        .call(&Actor::User, "chapter.list", json!({"book":book}))
        .unwrap();
    let doc = format!("node:{}", chapters["output"][0]["id"].as_str().unwrap());
    let (model_ready, model_wait) = oneshot::channel();
    let call = match path {
        ReadPath::Facade => ToolCall {
            id: "read-1".into(),
            name: "call_tool".into(),
            arguments: json!({"name":"prose.read","arguments":{"doc":doc}}),
        },
        ReadPath::WorkspaceCall => ToolCall {
            id: "read-1".into(),
            name: "read".into(),
            arguments: json!({"doc":doc}),
        },
    };
    let driver = Arc::new(ScriptedDriver::new(vec![vec![
        Step::Wait(model_wait),
        Step::Event(DriverEvent::ToolCall(call)),
        Step::Event(DriverEvent::Finish(FinishReason::Tools)),
    ]]));
    let tools: Arc<dyn ToolExecutor> = match path {
        ReadPath::Facade => Arc::new(AgentTools::new()),
        ReadPath::WorkspaceCall => Arc::new(WorkspaceRead),
    };
    let controller = AgentController::new(ws.clone(), driver.clone(), tools).unwrap();
    let session = controller
        .start(Start {
            book,
            conversation: ConversationId::new_v7(),
            input,
            config: RunConfig::new(Provider::Openai, "synthetic-model"),
        })
        .unwrap();
    armed.store(true, Ordering::SeqCst);
    model_ready.send(()).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();

    let closing = controller.close();
    assert!(controller.is_closed());
    let (closed, closed_rx) = mpsc::channel();
    let close_thread = std::thread::spawn(move || closed.send(block_on(closing)).unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let log = dr_agent::events(ws.library(), &session, 0).unwrap();
        if log.iter().any(|entry| {
            matches!(
                entry.event,
                Event::StateChanged {
                    state: State::Aborted
                }
            )
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "read cancellation did not finish the run"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(
        driver.requests().len(),
        1,
        "abort cannot start another model round"
    );

    match closed_rx.recv_timeout(Duration::from_secs(1)) {
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Ok(result) => {
            result.unwrap();
            // On the old implementation this proves the observable release
            // failure, rather than only asserting a task's internal state.
            let refused = ws
                .try_shutdown()
                .expect_err("the F3 worker still owns Workspace");
            let error = refused.error.to_string();
            release.open();
            refused.workspace.unwrap().try_shutdown().unwrap();
            close_thread.join().unwrap();
            panic!("controller.close completed before its read worker: {error}");
        }
        Err(error) => panic!("close worker disappeared: {error}"),
    }
    release.open();
    closed_rx
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    close_thread.join().unwrap();
    // Retained controller/driver handles are harmless after the real worker
    // releases its context; shutdown must not require dropping the panel.
    ws.try_shutdown().unwrap();
}
