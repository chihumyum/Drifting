use super::journal;
use super::*;
use crate::{
    driver::scripted::{ScriptedDriver, Step},
    *,
};
use dr_model::id::ConversationId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use futures::executor::block_on;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc as sync,
    },
    time::Duration,
};

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    doc: String,
    paragraph: Value,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m32-external")).unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        seeded.write_to(&lib).unwrap();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let chapters = json!({"output":dr_testkit::seed::acceptance::entries_by_template(&ws,&book,"tpl-chapter")});
        let doc = format!(
            "body:{}/mod-prose",
            chapters["output"][0]["id"].as_str().unwrap()
        );
        let paragraph = ws
            .call(&Actor::User, "prose.read", json!({"doc":doc}))
            .unwrap()["output"]["paragraphs"][1]
            .clone();
        Self {
            _dir: dir,
            ws,
            book,
            doc,
            paragraph,
        }
    }
    fn start(&self) -> ExternalStart {
        ExternalStart {
            client_id: "synthetic-client".into(),
            book: self.book.clone(),
            connection_epoch: 1,
        }
    }
    fn runtime(&self, tools: Arc<dyn ToolExecutor>) -> Runtime {
        Runtime::new(
            self.ws.clone(),
            Arc::new(ScriptedDriver::new(vec![])),
            tools,
            Options::default(),
        )
        .unwrap()
    }
    fn no_chat(&self) {
        assert!(self.ws.library().agent_sessions(None).unwrap().is_empty());
        assert!(
            self.ws
                .library()
                .docs(None, Some("conversation"))
                .unwrap()
                .is_empty()
        );
    }
}

fn descriptor(name: &str) -> ToolDescriptor {
    ToolDescriptor {
        name: name.into(),
        revision: "1".into(),
        description: name.into(),
        input_schema: json!({}),
        access: ToolAccess::Read,
        policy: ToolPolicy::Local,
    }
}
fn call(name: &str) -> ExternalCall {
    ExternalCall {
        name: name.into(),
        arguments: json!({}),
        revision: "1".into(),
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
    fn execute(&self, cx: ToolContext, call: ToolCall) -> BoxFuture<'static, Result<ToolOutput>> {
        (self.execute)(cx, call)
    }
}
fn empty_tools() -> Arc<Tools> {
    Arc::new(Tools {
        descriptors: vec![],
        execute: Arc::new(|_, _| async { panic!("unexpected execution") }.boxed()),
    })
}

struct Reloading {
    tools: Tools,
    revision: Arc<AtomicUsize>,
}
impl ToolExecutor for Reloading {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        self.tools.descriptors()
    }
    fn describe(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        let mut found = self.tools.describe(call)?;
        found.revision = self.revision.load(Ordering::SeqCst).to_string();
        Some(found)
    }
    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, Result<ToolOutput>> {
        self.tools.execute(context, call)
    }
}

#[test]
fn queued_external_call_rechecks_its_frozen_revision_after_acquiring_shared_gate() {
    queued_entry_recheck(false);
}

#[test]
fn revoked_entry_guard_rejects_queued_call_without_executing_or_receipts() {
    queued_entry_recheck(true);
}

fn queued_entry_recheck(revoke: bool) {
    let f = Fixture::new();
    let revision = Arc::new(AtomicUsize::new(1));
    let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let executions = Arc::new(AtomicUsize::new(0));
    let counted = executions.clone();
    let (entered, receive) = sync::channel();
    let (release, blocked) = oneshot::channel();
    let blocked = Mutex::new(Some(blocked));
    let tools = Arc::new(Reloading {
        revision: revision.clone(),
        tools: Tools {
            descriptors: vec![descriptor("hold"), descriptor("later")],
            execute: Arc::new(move |context, call| {
                counted.fetch_add(1, Ordering::SeqCst);
                assert_eq!(call.name, "hold", "replaced definition executed");
                let blocked = blocked.lock().unwrap().take().unwrap();
                entered.send(()).unwrap();
                async move {
                    blocked.await.unwrap();
                    drop(context);
                    Ok(ToolOutput::Value(Value::Null))
                }
                .boxed()
            }),
        },
    });
    let runtime = f.runtime(tools);
    let first = runtime.open_external(f.start()).unwrap();
    let held = first.call(call("hold")).unwrap();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    let second = runtime.open_external(f.start()).unwrap();
    let checked = revoked.clone();
    let later = second
        .call_checked(
            call("later"),
            Arc::new(move || {
                if checked.load(Ordering::SeqCst) {
                    Err(Error::Tool("grant revoked".into()))
                } else {
                    Ok(())
                }
            }),
        )
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let accepted =
            f.ws.library()
                .local_entries(journal::EVENTS, None)
                .unwrap()
                .iter()
                .any(|row| {
                    let value: Value = serde_json::from_str(&row.value).unwrap();
                    value["event"]["kind"] == "accepted" && value["event"]["call"] == later.id()
                });
        if accepted {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    if revoke {
        revoked.store(true, Ordering::SeqCst);
    } else {
        revision.store(2, Ordering::SeqCst);
    }
    release.send(()).unwrap();
    assert_eq!(block_on(held.finish()).unwrap().status, ToolStatus::Success);
    let changed = block_on(later.finish()).unwrap();
    assert_eq!(changed.status, ToolStatus::Error);
    assert!(
        changed.output["error"]
            .as_str()
            .unwrap()
            .contains(if revoke { "revoked" } else { "changed" })
    );
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    assert!(changed.settlements.is_empty());
    assert!(
        f.ws.library()
            .settlements(Some(second.session()), None)
            .unwrap()
            .is_empty()
    );
    block_on(first.close()).unwrap();
    block_on(second.close()).unwrap();
    drop(runtime);
    f.ws.try_shutdown().unwrap();
}

#[test]
fn policy_question_and_stop_are_terminal_without_chat_or_permission_waits() {
    let f = Fixture::new();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let mut plugin = descriptor("plugin");
    plugin.policy = ToolPolicy::ExternalPlugin;
    let tools = Arc::new(Tools {
        descriptors: vec![descriptor("question"), descriptor("stop"), plugin],
        execute: Arc::new(move |_, call| {
            seen.fetch_add(1, Ordering::SeqCst);
            async move {
                Ok(if call.name == "question" {
                    ToolOutput::Question(Question {
                        prompt: String::new(),
                        options: vec![],
                    })
                } else {
                    ToolOutput::Stop(json!({"error":{"code":"conflict_limit"}}))
                })
            }
            .boxed()
        }),
    });
    let runtime = f.runtime(tools);
    let scope = runtime.open_external(f.start()).unwrap();
    let result = block_on(scope.call(call("plugin")).unwrap().finish()).unwrap();
    assert_eq!(result.status, ToolStatus::Error);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(
        block_on(scope.call(call("question")).unwrap().finish())
            .unwrap()
            .status,
        ToolStatus::Error
    );
    let result = block_on(scope.call(call("stop")).unwrap().finish()).unwrap();
    assert_eq!(result.output["error"]["code"], "conflict_limit");
    assert!(scope.is_closed());
    assert!(matches!(scope.call(call("question")), Err(Error::Closed)));
    block_on(scope.close()).unwrap();
    let header: Value = serde_json::from_str(
        &f.ws
            .library()
            .local_get(journal::SESSIONS, scope.session())
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(header["state"], "stopped");
    f.no_chat();
    drop(runtime);
    f.ws.try_shutdown().unwrap();
}

#[test]
fn external_cancellation_while_waiting_on_chat_gate_does_not_wait_for_chat() {
    let f = Fixture::new();
    let (entered, receive) = sync::channel();
    let (release, blocked) = oneshot::channel();
    let blocked = Mutex::new(Some(blocked));
    let tools = Arc::new(Tools {
        descriptors: vec![descriptor("hold"), descriptor("later")],
        execute: Arc::new(move |context, call| {
            assert_eq!(
                call.name, "hold",
                "cancelled external call entered executor"
            );
            let blocked = blocked.lock().unwrap().take().unwrap();
            entered.send(()).unwrap();
            async move {
                blocked.await.unwrap();
                drop(context);
                Ok(ToolOutput::Value(Value::Null))
            }
            .boxed()
        }),
    });
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::ToolCall(ToolCall {
                id: "chat-call".into(),
                name: "hold".into(),
                arguments: json!({}),
            })),
            Step::Event(DriverEvent::Finish(FinishReason::Tools)),
        ],
        vec![Step::Event(DriverEvent::Finish(FinishReason::Complete))],
    ]));
    let runtime = Runtime::new(f.ws.clone(), driver, tools, Options::default()).unwrap();
    let run = runtime
        .start(Start {
            book: f.book.clone(),
            conversation: ConversationId::new_v7(),
            input: f.paragraph["text"].as_str().unwrap().into(),
            config: RunConfig::new(Provider::Openai, "synthetic"),
        })
        .unwrap();
    receive.recv_timeout(Duration::from_secs(10)).unwrap();
    let scope = runtime.open_external(f.start()).unwrap();
    let handle = scope.call(call("later")).unwrap();
    let closing = scope.close();
    let (done, finished) = sync::channel();
    std::thread::spawn(move || done.send(block_on(closing)).unwrap());
    let result = finished.recv_timeout(Duration::from_secs(3));
    release.send(()).unwrap(); // Always free the chat before any assertion.
    result.unwrap().unwrap();
    assert_eq!(
        block_on(handle.finish()).unwrap().status,
        ToolStatus::Cancelled
    );
    assert_eq!(run.join().unwrap(), State::Completed);
    drop(runtime);
    f.ws.try_shutdown().unwrap();
}

#[test]
fn last_context_clone_keeps_external_gate_and_close_until_worker_releases_it() {
    let f = Fixture::new();
    let (entered, receive) = sync::channel();
    let (release, blocked) = sync::channel();
    let blocked = Mutex::new(Some(blocked));
    let (later_entered, later_receive) = sync::channel();
    let tools = Arc::new(Tools {
        descriptors: vec![descriptor("hold"), descriptor("later")],
        execute: Arc::new(move |context, call| {
            if call.name == "later" {
                later_entered.send(()).unwrap();
                return async move {
                    drop(context);
                    Ok(ToolOutput::Value(Value::Null))
                }
                .boxed();
            }
            let blocked = blocked.lock().unwrap().take().unwrap();
            let entered = entered.clone();
            std::thread::spawn(move || {
                entered.send(()).unwrap();
                let _ = blocked.recv_timeout(Duration::from_secs(10));
                drop(context);
            });
            async { Ok(ToolOutput::Value(Value::Null)) }.boxed()
        }),
    });
    let runtime = f.runtime(tools);
    let scope = runtime.open_external(f.start()).unwrap();
    let handle = scope.call(call("hold")).unwrap();
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    let next = runtime.open_external(f.start()).unwrap();
    let later = next.call(call("later")).unwrap();
    let closing = scope.close();
    let (done, finished) = sync::channel();
    std::thread::spawn(move || done.send(block_on(closing)).unwrap());
    assert!(matches!(
        finished.recv_timeout(Duration::from_millis(150)),
        Err(sync::RecvTimeoutError::Timeout)
    ));
    assert!(!scope.is_settled());
    assert!(matches!(
        later_receive.try_recv(),
        Err(sync::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    finished
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert_eq!(
        block_on(handle.finish()).unwrap().status,
        ToolStatus::Success
    );
    assert!(scope.is_settled());
    later_receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        block_on(later.finish()).unwrap().status,
        ToolStatus::Success
    );
    block_on(next.close()).unwrap();
    drop(runtime);
    f.ws.try_shutdown().unwrap();
}

#[test]
fn recovery_reconciles_real_receipts_without_reexecuting_or_creating_chat() {
    let f = Fixture::new();
    let runtime = f.runtime(empty_tools());
    let session = new_uuid_v7();
    let mut audit = Journal::create(f.ws.library().clone(), session.clone(), f.start()).unwrap();
    audit
        .event(json!({"kind":"accepted","call":"crashed-write"}))
        .unwrap();
    audit
        .event(json!({"kind":"started","call":"crashed-write"}))
        .unwrap();
    let original = f.paragraph["text"].as_str().unwrap();
    let replacement = original.chars().rev().collect::<String>();
    f.ws.call(&Actor::agent(&session,1,"crashed-write"),"prose.replace",json!({"doc":f.doc,"block_id":f.paragraph["block_id"],"find":original,"replace":replacement})).unwrap();
    let receipts = f.ws.library().settlements(Some(&session), None).unwrap();
    assert!(!receipts.is_empty());
    drop(audit);
    let first_key = format!("{session}/{:020}", 1);
    let first =
        f.ws.library()
            .local_get(journal::EVENTS, &first_key)
            .unwrap()
            .unwrap();
    f.ws.library()
        .local_remove(journal::EVENTS, &first_key)
        .unwrap();
    assert!(
        runtime.recover_external().is_err(),
        "a missing audit event cannot become a complete recovery"
    );
    f.ws.library()
        .local_set(journal::EVENTS, &first_key, &first, Some(f.book.as_str()))
        .unwrap();
    let recovered = runtime.recover_external().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].state, ExternalState::Interrupted);
    assert_eq!(recovered[0].settlements.len(), receipts.len());
    assert!(runtime.recover_external().unwrap().is_empty());
    assert_eq!(
        f.ws.library()
            .settlements(Some(&session), None)
            .unwrap()
            .len(),
        receipts.len()
    );
    f.no_chat();
    drop(runtime);
    f.ws.try_shutdown().unwrap();
}

#[test]
fn audit_cas_missing_header_and_oversize_output_preserve_terminal_and_every_receipt() {
    let f = Fixture::new();
    let session = new_uuid_v7();
    let mut audit = Journal::create(f.ws.library().clone(), session.clone(), f.start()).unwrap();
    let mut stale = Journal::open(
        f.ws.library().clone(),
        &serde_json::to_string(&audit.header).unwrap(),
    )
    .unwrap();
    audit
        .event(json!({"kind":"accepted","call":"bulk"}))
        .unwrap();
    assert!(
        stale
            .event(json!({"kind":"accepted","call":"stale"}))
            .is_err()
    );
    // Synthetic receipt identities exercise paging independently of F3; the
    // recovery test above verifies authoritative receipt lookup from writes.
    let receipts = (0..12_000)
        .map(|id| SettlementRef {
            id,
            document: f.doc.clone(),
            seq: id,
        })
        .collect::<Vec<_>>();
    let text = f.paragraph["text"].as_str().unwrap();
    audit
        .finish(&ToolResult {
            call: "bulk".into(),
            status: ToolStatus::Success,
            output: json!(text.repeat(2 * 1024 * 1024 / text.len() + 1)),
            settlements: receipts.clone(),
        })
        .unwrap();
    audit.close(ExternalState::Closed).unwrap();
    let rows = f.ws.library().local_entries(journal::EVENTS, None).unwrap();
    let mut stored = Vec::new();
    let mut truncated = false;
    for row in rows {
        assert!(row.value.len() <= dr_store::local_state::MAX_VALUE_BYTES);
        let value: Value = serde_json::from_str(&row.value).unwrap();
        let event = &value["event"];
        if event["kind"] == "receipts" {
            stored.extend(
                serde_json::from_value::<Vec<SettlementRef>>(event["receipts"].clone()).unwrap(),
            );
        }
        if event["kind"] == "finished" {
            truncated = event["output"]["truncated"] == true;
            assert_eq!(event["output"]["sha256"].as_str().unwrap().len(), 64);
        }
    }
    assert_eq!(stored, receipts);
    assert!(truncated);
    let mut missing = Journal::create(f.ws.library().clone(), new_uuid_v7(), f.start()).unwrap();
    f.ws.library()
        .local_remove(journal::SESSIONS, &missing.header.session)
        .unwrap();
    assert!(
        missing
            .event(json!({"kind":"accepted","call":"never"}))
            .is_err()
    );
    assert!(
        f.ws.library()
            .local_get(journal::SESSIONS, &missing.header.session)
            .unwrap()
            .is_none()
    );
    drop(missing);
    drop(stale);
    drop(audit);
    f.no_chat();
    f.ws.try_shutdown().unwrap();
}
