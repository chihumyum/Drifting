//! Real M29 calls, real F2 read/commit gates, and the controller close boundary.

use dr_agent::{
    ExternalCall, ExternalScope, ExternalStart, ToolStatus, driver::scripted::ScriptedDriver,
};
use dr_agent_tools::AgentTools;
use dr_model::id::BookId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_view_agent::controller::AgentController;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, executor::block_on};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    doc: String,
    paragraph: Value,
}
impl Fixture {
    fn new(options: dr_store::LibraryOptions) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), options).unwrap();
        let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seed.books[0].book_id().clone();
        seed.write_to(&lib).unwrap();
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
    fn start(&self, epoch: u64) -> ExternalStart {
        ExternalStart {
            client_id: "synthetic-mcp-client".into(),
            book: self.book.clone(),
            connection_epoch: epoch,
        }
    }
    fn write(&self) -> Value {
        let text = self.paragraph["text"].as_str().unwrap();
        json!({"doc":self.doc,"find":text,"replace":text.chars().rev().collect::<String>(),"block_id":self.paragraph["block_id"]})
    }
    fn controller(&self, tools: &Arc<AgentTools>) -> AgentController {
        AgentController::new(
            self.ws.clone(),
            Arc::new(ScriptedDriver::new(vec![])),
            tools.clone(),
        )
        .unwrap()
    }
}
fn call(tools: &AgentTools, name: &str, arguments: Value) -> ExternalCall {
    let revision = tools.catalog().descriptor(name).unwrap().revision;
    ExternalCall {
        name: "call_tool".into(),
        arguments: json!({"name":name,"arguments":arguments,"revision":revision}),
        revision,
    }
}
fn invoke(
    scope: &ExternalScope,
    tools: &AgentTools,
    name: &str,
    args: Value,
) -> dr_agent::ToolResult {
    block_on(scope.call(call(tools, name, args)).unwrap().finish()).unwrap()
}

#[test]
fn external_read_write_and_undo_use_stable_scope_authority_without_chat() {
    let f = Fixture::new(library_options("m32-external-tools"));
    let entry = f
        .doc
        .strip_prefix("body:")
        .unwrap()
        .strip_suffix("/mod-prose")
        .unwrap();
    let point = dr_testkit::seed::acceptance::entry_point(&f.ws, &f.book, &entry);
    let tools = Arc::new(AgentTools::new());
    let controller = f.controller(&tools);
    let first = controller.open_external(f.start(1)).unwrap();
    assert_eq!(
        invoke(
            &first,
            &tools,
            "entry.list",
            json!({"book":f.book,"all":true})
        )
        .status,
        ToolStatus::Success
    );
    assert_eq!(
        invoke(&first, &tools, "prose.read", json!({"doc":f.doc})).status,
        ToolStatus::Success
    );
    let written = invoke(&first, &tools, "prose.replace", f.write());
    assert_eq!(written.status, ToolStatus::Success);
    assert!(!written.settlements.is_empty());
    block_on(first.close()).unwrap();
    let next = controller.open_external(f.start(3)).unwrap();
    assert_ne!(first.session(), next.session());
    let stale = invoke(&next, &tools, "prose.replace", f.write());
    assert_eq!(stale.status, ToolStatus::Error);
    assert_eq!(stale.output["error"]["code"], "read_required");
    let entry = f
        .doc
        .strip_prefix("body:")
        .unwrap()
        .strip_suffix("/mod-prose")
        .unwrap();
    dr_testkit::seed::acceptance::restore_entry(&f.ws, &f.book, &entry, &point);
    let after =
        f.ws.call(&Actor::User, "prose.read", json!({"doc":f.doc}))
            .unwrap();
    assert_eq!(
        after["output"]["paragraphs"][1]["text"],
        f.paragraph["text"]
    );
    assert!(controller.list(&f.book).unwrap().is_empty());
    assert!(f.ws.library().agent_sessions(None).unwrap().is_empty());
    assert!(
        f.ws.library()
            .docs(None, Some("conversation"))
            .unwrap()
            .is_empty()
    );
    block_on(controller.close()).unwrap();
    assert!(next.is_closed());
    assert!(controller.open_external(f.start(4)).is_err());
    f.ws.try_shutdown().unwrap();
}

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

fn blocked_worker(write: bool) {
    let armed = Arc::new(AtomicBool::new(false));
    let check = armed.clone();
    let (entered, receive) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let mut release = Release(Some(release));
    let blocked = Mutex::new(blocked);
    let mut options = library_options("m32-external-close");
    if write {
        options.append_checkpoint = Some(Arc::new(move || {
            if check.swap(false, Ordering::SeqCst) {
                entered.send(()).unwrap();
                blocked
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(15))
                    .unwrap();
            }
        }));
    } else {
        let configure = options.configure_doc.take();
        options.configure_doc = Some(Arc::new(move |doc| {
            if let Some(configure) = &configure {
                configure(doc);
            }
            if std::thread::current().name() == Some("dr-agent-facade")
                && check.swap(false, Ordering::SeqCst)
            {
                entered.send(()).unwrap();
                blocked
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(15))
                    .unwrap();
            }
        }));
    }
    let f = Fixture::new(options);
    let tools = Arc::new(AgentTools::new());
    let controller = f.controller(&tools);
    let scope = controller.open_external(f.start(1)).unwrap();
    // The fixture's first chapter is already mounted by its author read.
    // Enter a different real chapter's first F3 load on the facade worker.
    let chapters = json!({"output":dr_testkit::seed::acceptance::entries_by_template(&f.ws,&f.book,"tpl-chapter")});
    let unread_doc = format!(
        "body:{}/mod-prose",
        chapters["output"][1]["id"].as_str().unwrap()
    );
    if write {
        assert_eq!(
            invoke(&scope, &tools, "prose.read", json!({"doc":f.doc})).status,
            ToolStatus::Success
        );
    }
    armed.store(true, Ordering::SeqCst);
    let call = if write {
        call(&tools, "prose.replace", f.write())
    } else {
        call(&tools, "prose.read", json!({"doc":unread_doc}))
    };
    let handle = scope.call(call).unwrap();
    receive.recv_timeout(Duration::from_secs(10)).unwrap();
    let session = scope.session().to_owned();
    let began = Instant::now();
    let closing = controller.close();
    assert!(began.elapsed() < Duration::from_millis(500));
    assert!(scope.is_closed());
    // RPC disconnect drops the response handle, not the entered OS worker.
    drop(handle);
    let (done, finished) = mpsc::channel();
    let thread = std::thread::spawn(move || done.send(block_on(closing)).unwrap());
    assert!(matches!(
        finished.recv_timeout(Duration::from_millis(200)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    release.open();
    finished
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    thread.join().unwrap();
    block_on(scope.close()).unwrap();
    if write {
        assert!(
            !f.ws
                .library()
                .settlements(Some(&session), None)
                .unwrap()
                .is_empty()
        );
        let after =
            f.ws.call(&Actor::User, "prose.read", json!({"doc":f.doc}))
                .unwrap();
        assert_ne!(
            after["output"]["paragraphs"][1]["text"],
            f.paragraph["text"]
        );
    }
    assert!(scope.is_settled());
    assert!(controller.list(&f.book).is_err());
    f.ws.try_shutdown().unwrap();
}

#[test]
fn controller_close_waits_for_real_entered_m29_read_even_after_rpc_drop() {
    blocked_worker(false);
}
#[test]
fn controller_close_waits_for_real_m29_write_transaction_even_after_rpc_drop() {
    blocked_worker(true);
}

#[test]
fn scope_close_progresses_without_polling_its_future_and_clones_release_the_library() {
    let f = Fixture::new(library_options("m32-scope-drop"));
    let tools = Arc::new(AgentTools::new());
    let controller = f.controller(&tools);
    let scope = controller.open_external(f.start(1)).unwrap();
    let retained = scope.clone();
    drop(scope.close());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !retained.is_settled() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(retained.close().now_or_never().unwrap().is_ok());
    block_on(controller.close()).unwrap();
    f.ws.try_shutdown().unwrap();
}

#[test]
fn close_waits_for_an_opening_scope_without_holding_the_controller_lock() {
    let f = Fixture::new(library_options("m32-opening-scope"));
    let tools = Arc::new(AgentTools::new());
    let controller = f.controller(&tools);
    let (entered, receive) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let mut release = Release(Some(release));
    let blocked = Mutex::new(blocked);
    let armed = AtomicBool::new(true);
    let subscription = f.ws.library().subscribe(move |event| {
        if matches!(event, dr_store::StoreEvent::Local(change)
            if change.table == dr_store::local_state::TABLE
                && change.key.starts_with("agent.external.sessions/"))
            && armed.swap(false, Ordering::SeqCst)
        {
            entered.send(()).unwrap();
            blocked
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
        }
    });
    let opening = controller.clone();
    let start = f.start(1);
    let thread = std::thread::spawn(move || opening.open_external(start));
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    let before = Instant::now();
    let mut closing = controller.close();
    assert!(before.elapsed() < Duration::from_millis(500));
    assert!(closing.as_mut().now_or_never().is_none());
    release.open();
    assert!(thread.join().unwrap().is_err());
    block_on(closing).unwrap();
    drop(subscription);
    f.ws.try_shutdown().unwrap();
}
