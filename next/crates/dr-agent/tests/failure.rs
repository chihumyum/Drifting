//! Journal failure must not detach an already-entered write worker.

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use dr_agent::driver::scripted::{ScriptedDriver, Step};
use dr_agent::tools::ToolOutput;
use dr_agent::*;
use dr_model::id::ConversationId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, channel::oneshot, executor::block_on, future::BoxFuture};
use serde_json::json;

struct EnteredWrite {
    entered: mpsc::Sender<()>,
    release: Arc<Mutex<mpsc::Receiver<()>>>,
}

impl ToolExecutor for EnteredWrite {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![ToolDescriptor {
            name: "write".into(),
            revision: "1".into(),
            description: "write".into(),
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
        let (done, result) = oneshot::channel();
        let release = self.release.clone();
        let entered = self.entered.clone();
        // This models a write already accepted by an independent worker:
        // cancellation cannot undo its entry, and dropping the receiving
        // future cannot stop it. The runtime must await its durable result.
        std::thread::spawn(move || {
            entered.send(()).unwrap();
            release.lock().unwrap().recv().unwrap();
            let written = context
                .workspace()
                .call(&context.actor, "prose.replace", call.arguments)
                .map(ToolOutput::Value)
                .map_err(|e| Error::Tool(e.to_string()));
            let _ = done.send(written);
        });
        async move {
            result
                .await
                .map_err(|_| Error::Tool("test write worker exited".into()))?
        }
        .boxed()
    }
}

#[test]
fn failed_abort_journal_waits_for_entered_write_before_join_and_failure() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("m27-failure-test")).unwrap();
    let seed = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seed.write_to(&lib).unwrap();
    let book = seed.books[0].book_id().clone();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    ws.set_auto_links(false);
    let chapters = ws
        .call(&Actor::User, "chapter.list", json!({"book":book}))
        .unwrap();
    let doc = format!("node:{}", chapters["output"][0]["id"].as_str().unwrap());
    let prose = ws
        .call(&Actor::User, "prose.read", json!({"doc":doc}))
        .unwrap();
    let paragraph = &prose["output"]["paragraphs"][1];
    let text = paragraph["text"].as_str().unwrap();
    let changed: String = text.chars().rev().collect();
    assert_ne!(text, changed);
    let call = ToolCall {
        id: "write-1".into(),
        name: "write".into(),
        arguments: json!({"doc":doc, "block_id":paragraph["block_id"], "find":text, "replace":changed}),
    };
    // Reject only the abort request; ordinary event/settlement writes still
    // work. This isolates the control failure from the tool's own write.
    ws.library()
        .local_transaction(|tx| {
            tx.execute_batch(
                "CREATE TEMP TRIGGER m27_reject_abort BEFORE INSERT ON agent_event
             WHEN json_extract(NEW.event_json, '$.event.kind') = 'abort_requested'
             BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;",
            )?;
            Ok(())
        })
        .unwrap();
    let (entered, entry) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let tools = Arc::new(EnteredWrite {
        entered,
        release: Arc::new(Mutex::new(gate)),
    });
    let driver = Arc::new(ScriptedDriver::new(vec![vec![
        Step::Event(DriverEvent::ToolCall(call)),
        Step::Event(DriverEvent::Finish(FinishReason::Tools)),
    ]]));
    let runtime = Runtime::new(ws.clone(), driver, tools, Options::default()).unwrap();
    let run = runtime
        .start(Start {
            config: dr_agent::RunConfig::new(dr_agent::Provider::Openai, "synthetic-model"),
            book,
            conversation: ConversationId::new_v7(),
            input: text.into(),
        })
        .unwrap();
    let session = run.session.clone();
    let control = run.control.clone();
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    let (finished, completion) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = finished.send(run.join());
    });
    assert!(block_on(control.abort()).is_err());
    let premature = completion.recv_timeout(Duration::from_millis(100));
    // Always release the test worker, including when the assertion fails.
    release.send(()).unwrap();
    assert!(
        matches!(premature, Err(mpsc::RecvTimeoutError::Timeout)),
        "join returned before the entered write settled: {premature:?}"
    );
    assert!(
        completion
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_err()
    );
    assert_eq!(control.state(), State::Failed);
    let after = ws
        .call(&Actor::User, "prose.read", json!({"doc":doc}))
        .unwrap();
    assert_eq!(after["output"]["paragraphs"][1]["text"], changed);
    let receipts = ws
        .library()
        .settlements(Some(&session), Some(&doc))
        .unwrap();
    assert_eq!(receipts.len(), 1);
    let log = events(ws.library(), &session, 0).unwrap();
    assert!(log.iter().any(|event| matches!(&event.event,
        Event::ToolFinished { result } if result.call == "write-1" && result.settlements.len() == 1)));
    assert!(matches!(
        log.last().unwrap().event,
        Event::StateChanged {
            state: State::Failed
        }
    ));
    assert!(
        !log.iter()
            .any(|event| matches!(event.event, Event::AbortRequested))
    );
    drop(runtime);
    ws.shutdown().unwrap();
}
