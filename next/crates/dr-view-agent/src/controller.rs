//! Library-scoped Agent service, independent of GPUI.
//!
//! Construct, start and read snapshots on a background executor. Views
//! subscribe only for wakeups and own no runtime handles. `close` freezes
//! starts immediately; awaiting it is the boundary after which the shell may
//! release the library, including reads and starts already in progress.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};

use dr_agent::{
    Control, Driver, ExternalScope, ExternalStart, Options, RunHandle, Runtime, Start, ToolExecutor,
};
use dr_model::{
    DocId,
    id::{BookId, ConversationId},
};
use dr_store::{LibrarySubscription, StoreEvent};
use dr_workspace::Workspace;
use futures::{
    FutureExt, StreamExt,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Shared, join_all},
    stream::FuturesUnordered,
};

use crate::state::{ChatMessage, ChatSnapshot, ChatState, ConversationSummary};

mod long_tasks;
pub mod proactive;
pub use long_tasks::TaskView;

type Completion = Shared<BoxFuture<'static, Result<(), String>>>;
type Listener = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct AgentController {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<ServiceState>,
    listeners: Mutex<BTreeMap<u64, Listener>>,
    next_listener: std::sync::atomic::AtomicU64,
}

struct ServiceState {
    resources: Option<Arc<Resources>>,
    runs: HashMap<String, ActiveRun>,
    external: HashMap<String, ExternalScope>,
    starting: HashSet<ConversationId>,
    authorizations: HashMap<ConversationId, long_tasks::Authorization>,
    suggestion_jobs: HashMap<BookId, dr_agent::Cancellation>,
    proactive_enabled: bool,
    close: Option<Completion>,
}

struct Resources {
    workspace: Workspace,
    runtime: Runtime,
    driver: Arc<dyn Driver>,
    monitor: mpsc::UnboundedSender<WatchedRun>,
    _subscription: Option<LibrarySubscription>,
    reads: Arc<ReadTracker>,
}

#[derive(Default)]
struct ReadTracker {
    state: Mutex<ReadCount>,
}

#[derive(Default)]
struct ReadCount {
    active: usize,
    drained: Vec<oneshot::Sender<()>>,
}

struct ReadLease {
    resources: Option<Arc<Resources>>,
    tracker: Arc<ReadTracker>,
}

impl ReadTracker {
    fn enter(&self) {
        self.state.lock().expect("Agent reads").active += 1;
    }

    fn leave(&self) {
        let mut state = self.state.lock().expect("Agent reads");
        state.active -= 1;
        if state.active == 0 {
            for waiter in std::mem::take(&mut state.drained) {
                let _ = waiter.send(());
            }
        }
    }

    fn drained(&self) -> BoxFuture<'static, Result<(), String>> {
        let mut state = self.state.lock().expect("Agent reads");
        if state.active == 0 {
            return async { Ok(()) }.boxed();
        }
        let (send, receive) = oneshot::channel();
        state.drained.push(send);
        async move {
            receive
                .await
                .map_err(|_| "Agent read barrier ended early".to_owned())
        }
        .boxed()
    }
}

impl ReadLease {
    fn resources(&self) -> &Resources {
        self.resources.as_deref().expect("active read lease")
    }
}

impl Drop for ReadLease {
    fn drop(&mut self) {
        // The final waiter must never outrun this lease's Workspace reference.
        drop(self.resources.take());
        self.tracker.leave();
    }
}

struct ActiveRun {
    conversation: ConversationId,
    control: Control,
    completion: Completion,
    authorization: String,
    automatic: bool,
}

struct WatchedRun {
    handle: RunHandle,
    completed: oneshot::Sender<()>,
}

/// Drop to stop receiving wakeups. It keeps no library or runtime alive.
pub struct Subscription {
    inner: Weak<Inner>,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner
                .listeners
                .lock()
                .expect("Agent listeners")
                .remove(&self.id);
        }
    }
}

impl AgentController {
    /// Recover once before allowing starts. Supplying the driver and tools
    /// makes the complete service usable with the offline scripted driver.
    pub fn new(
        workspace: Workspace,
        driver: Arc<dyn Driver>,
        tools: Arc<dyn ToolExecutor>,
    ) -> Result<Self, String> {
        let runtime = Runtime::new(workspace.clone(), driver.clone(), tools, Options::default())
            .map_err(string)?;
        runtime.recover().map_err(string)?;
        runtime.recover_external().map_err(string)?;
        for doc in workspace
            .library()
            .docs(None, Some("book"))
            .map_err(string)?
        {
            if let Ok(DocId::Book(book)) = DocId::parse(&doc.doc_id) {
                dr_agent::proactive::ProactiveStore::recover(workspace.library(), &book)
                    .map_err(string)?;
            }
        }
        let (monitor, incoming) = mpsc::unbounded();
        let inner = Arc::new(Inner {
            state: Mutex::new(ServiceState {
                resources: Some(Arc::new(Resources {
                    workspace,
                    runtime,
                    driver,
                    monitor,
                    _subscription: None,
                    reads: Arc::default(),
                })),
                runs: HashMap::new(),
                external: HashMap::new(),
                starting: HashSet::new(),
                authorizations: HashMap::new(),
                suggestion_jobs: HashMap::new(),
                proactive_enabled: true,
                close: None,
            }),
            listeners: Mutex::new(BTreeMap::new()),
            next_listener: std::sync::atomic::AtomicU64::new(0),
        });
        let weak = Arc::downgrade(&inner);
        std::thread::Builder::new()
            .name("dr-agent-monitor".into())
            .spawn(move || monitor_runs(incoming, weak))
            .map_err(string)?;
        let weak = Arc::downgrade(&inner);
        {
            let mut state = inner.state.lock().expect("Agent service");
            let resources = Arc::get_mut(state.resources.as_mut().expect("new service"))
                .expect("unshared new service");
            resources._subscription = Some(resources.workspace.library().subscribe(move |event| {
                let relevant = match event {
                    StoreEvent::Doc(event) => event.doc_id.starts_with("conversation:"),
                    StoreEvent::Local(change) => matches!(
                        change.table.as_str(),
                        dr_store::agent::SESSION_TABLE | dr_store::agent::EVENT_TABLE
                    ),
                };
                if relevant && let Some(inner) = weak.upgrade() {
                    inner.notify();
                }
            }));
        }
        Ok(Self { inner })
    }

    /// Background synchronous entry. UI callers use `start_job`, which
    /// reserves its close lease before scheduling any background work.
    pub fn start(&self, start: Start) -> Result<String, String> {
        self.prepare_start(long_tasks::StartRequest::Author(start), None)?
            .run()
    }

    pub fn start_job(&self, start: Start) -> BoxFuture<'static, Result<String, String>> {
        long_tasks::spawn_start(self.prepare_start(long_tasks::StartRequest::Author(start), None))
    }

    pub fn control(&self, session: &str) -> Option<Control> {
        self.inner
            .state
            .lock()
            .expect("Agent service")
            .runs
            .get(session)
            .map(|run| run.control.clone())
    }

    /// Background initialization with the same opening reservation as chat
    /// starts. Public scopes contain no Workspace once their worker closes.
    pub fn open_external(&self, start: ExternalStart) -> Result<ExternalScope, String> {
        let lease = self.read_lease()?;
        let scope = lease
            .resources()
            .runtime
            .open_external(start)
            .map_err(string)?;
        let mut state = self.inner.state.lock().expect("Agent service");
        if state.resources.is_none() {
            drop(state);
            futures::executor::block_on(scope.close()).map_err(string)?;
            return Err(closed());
        }
        // Closed handles carry no library resources. Discard their registry
        // slots when the next connection arrives; callers may retain clones.
        state.external.retain(|_, scope| !scope.is_settled());
        state
            .external
            .insert(scope.session().to_owned(), scope.clone());
        Ok(scope)
    }

    pub fn is_closed(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("Agent service")
            .resources
            .is_none()
    }

    pub fn active_count(&self) -> usize {
        let state = self.inner.state.lock().expect("Agent service");
        state.runs.len() + state.starting.len() + state.suggestion_jobs.len()
    }

    /// The callback can run on a store or monitor thread. It must only signal
    /// a wakeup, never synchronously read this service or a GPUI entity.
    pub fn subscribe(&self, listener: Listener) -> Subscription {
        use std::sync::atomic::Ordering;
        let id = self.inner.next_listener.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .lock()
            .expect("Agent listeners")
            .insert(id, listener);
        Subscription {
            inner: Arc::downgrade(&self.inner),
            id,
        }
    }

    pub fn list(&self, book: &BookId) -> Result<Vec<ConversationSummary>, String> {
        let lease = self.read_lease()?;
        let resources = lease.resources();
        let lib = resources.workspace.library();
        let sessions = lib.agent_sessions(Some(book.as_str())).map_err(string)?;
        let mut ids = BTreeMap::new();
        for doc in lib
            .docs(Some(book.as_str()), Some("conversation"))
            .map_err(string)?
        {
            let id = conversation_id(&doc.doc_id)?;
            ids.insert(id, 0_i64);
        }
        for session in &sessions {
            let id = conversation_id(&session.conversation)?;
            let time = ids.entry(id).or_default();
            *time = (*time).max(session.created_ms);
        }
        let mut summaries = Vec::with_capacity(ids.len());
        for (id, last_created_ms) in ids {
            let snapshot = read_snapshot(resources, book, &id)?;
            let title = snapshot
                .messages
                .iter()
                .find_map(|message| {
                    if let crate::state::MessageContent::User { text } = &message.content {
                        Some(
                            text.lines()
                                .next()
                                .unwrap_or_default()
                                .chars()
                                .take(80)
                                .collect(),
                        )
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let active = self
                .inner
                .state
                .lock()
                .expect("Agent service")
                .runs
                .iter()
                .filter(|(_, run)| run.conversation == id)
                .map(|(session, _)| session.clone())
                .collect();
            let interrupted = snapshot
                .runs
                .iter()
                .any(|run| run.state == dr_agent::State::Interrupted);
            summaries.push(ConversationSummary {
                id,
                title,
                message_count: snapshot.messages.len(),
                active,
                interrupted,
                last_created_ms,
            });
        }
        summaries.sort_by(|a, b| {
            b.last_created_ms
                .cmp(&a.last_created_ms)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(summaries)
    }

    /// The book is mandatory: a stale pane cannot read another book's chat.
    /// An unstarted new conversation produces an empty snapshot.
    pub fn snapshot(
        &self,
        book: &BookId,
        conversation: &ConversationId,
    ) -> Result<ChatSnapshot, String> {
        let lease = self.read_lease()?;
        read_snapshot(lease.resources(), book, conversation)
    }

    /// A short background read for the panel's starter queries. Return owned
    /// data only: do not retain/clone the Workspace, spawn work from it, or
    /// call this controller inside the closure. The close barrier waits for
    /// the whole closure without keeping the service mutex locked.
    pub fn with_workspace_read<T>(
        &self,
        read: impl FnOnce(&Workspace) -> Result<T, String>,
    ) -> Result<T, String> {
        let lease = self.read_lease()?;
        read(&lease.resources().workspace)
    }

    /// An already-background synchronous operation. Return owned values only;
    /// never retain the Workspace or start detached work from the closure.
    pub fn with_workspace<T>(
        &self,
        job: impl FnOnce(&Workspace) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_workspace_read(job)
    }

    /// Accept a background operation now, before returning its waiter. The
    /// independent worker retains the close lease even when its view or waiter
    /// disappears. Its Workspace reference is released before acknowledgement.
    /// The closure must return owned data, not another Workspace handle.
    pub fn workspace_job<T: Send + 'static>(
        &self,
        job: impl FnOnce(&Workspace) -> Result<T, String> + Send + 'static,
    ) -> BoxFuture<'static, Result<T, String>> {
        let lease = match self.read_lease() {
            Ok(lease) => lease,
            Err(error) => return async move { Err(error) }.boxed(),
        };
        let (send, receive) = oneshot::channel();
        let spawned = std::thread::Builder::new()
            .name("agent-workspace-job".into())
            .spawn(move || {
                let result = job(&lease.resources().workspace);
                drop(lease);
                let _ = send.send(result);
            });
        async move {
            spawned.map_err(string)?;
            receive
                .await
                .map_err(|_| "Agent workspace operation ended before acknowledgement".to_owned())?
        }
        .boxed()
    }

    fn read_lease(&self) -> Result<ReadLease, String> {
        let state = self.inner.state.lock().expect("Agent service");
        let resources = state.resources.as_ref().ok_or_else(closed)?;
        let tracker = resources.reads.clone();
        tracker.enter();
        Ok(ReadLease {
            resources: Some(resources.clone()),
            tracker,
        })
    }

    /// Freeze synchronously, before the returned future is polled. Abort all
    /// known runs and wait for entered reads, startup reservations and writes.
    /// Repeated callers share one barrier. Completion releases every Workspace/Runtime
    /// strong reference even if views still retain a clone of this controller.
    pub fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let mut state = self.inner.state.lock().expect("Agent service");
        if let Some(close) = &state.close {
            return close.clone().boxed();
        }
        let resources = state.resources.take();
        for authorization in state.authorizations.values_mut() {
            authorization.enabled = false;
        }
        for cancellation in state.suggestion_jobs.values() {
            cancellation.cancel();
        }
        let reads = resources
            .as_ref()
            .map(|resources| resources.reads.drained());
        let runs = std::mem::take(&mut state.runs);
        let external = std::mem::take(&mut state.external)
            .into_values()
            .map(|scope| scope.close())
            .collect::<Vec<_>>();
        // Nonblocking delivery freezes and signals every run now. The returned
        // futures only wait for durable acknowledgements; none is polled while
        // the service mutex is held or before close returns to the UI.
        let aborts = runs
            .values()
            .map(|run| run.control.abort())
            .collect::<Vec<_>>();
        let close = async move {
            // An already terminal run may close its control mailbox before
            // its completion arrives; only the completion is the boundary.
            join_all(aborts).await;
            let (completed, reads, external) = futures::join!(
                join_all(runs.into_values().map(|run| run.completion)),
                async move {
                    match reads {
                        Some(reads) => reads.await,
                        None => Ok(()),
                    }
                },
                join_all(external),
            );
            if let Some(resources) = &resources {
                // Run cancellation can drop a read future while its F3 OS
                // worker still owns a cloned context. Starts/read reservations
                // have drained, so no new execution can enter this barrier.
                resources.runtime.drain_tools().await.map_err(string)?;
            }
            drop(resources);
            reads?;
            for result in external {
                result.map_err(string)?;
            }
            for result in completed {
                result?;
            }
            Ok(())
        }
        .boxed()
        .shared();
        state.close = Some(close.clone());
        close.boxed()
    }
}

impl Inner {
    fn notify(&self) {
        let listeners: Vec<_> = self
            .listeners
            .lock()
            .expect("Agent listeners")
            .values()
            .cloned()
            .collect();
        for listener in listeners {
            listener();
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // A missing shell close must not strand a question forever. This is
        // only a cancellation fallback; the shell still has to await close.
        if let Ok(state) = self.state.get_mut() {
            for scope in state.external.values() {
                drop(scope.close());
            }
            for run in state.runs.values() {
                drop(run.control.abort());
            }
        }
    }
}

fn monitor_runs(mut incoming: mpsc::UnboundedReceiver<WatchedRun>, inner: Weak<Inner>) {
    futures::executor::block_on(async move {
        let mut pending = FuturesUnordered::<BoxFuture<'static, ()>>::new();
        loop {
            if pending.is_empty() {
                let Some(run) = incoming.next().await else {
                    break;
                };
                pending.push(watch(run, inner.clone()));
            } else {
                futures::select! {
                    run = incoming.next().fuse() => match run {
                        Some(run) => pending.push(watch(run, inner.clone())),
                        None => { while pending.next().await.is_some() {} break; }
                    },
                    _ = pending.next().fuse() => {},
                }
            }
        }
    });
}

fn watch(run: WatchedRun, inner: Weak<Inner>) -> BoxFuture<'static, ()> {
    async move {
        let session = run.handle.session.clone();
        // Runtime failures are durable terminal states too; finish returning
        // proves its worker released all writes even when the model failed.
        let _ = run.handle.finish().await;
        if let Some(inner) = inner.upgrade() {
            // Follow-up inspection can touch the F3 holder. It must not block
            // unrelated completions on the single monitor executor.
            let (send, receive) = oneshot::channel();
            let controller = AgentController { inner };
            let fallback = controller.clone();
            let failed_session = session.clone();
            let spawned = std::thread::Builder::new()
                .name("agent-continuation".into())
                .spawn(move || {
                    controller.after_run(&session);
                    let _ = send.send(());
                });
            if spawned.is_ok() {
                let _ = receive.await;
            } else {
                fallback.retire_run(
                    &failed_session,
                    Some("continuation worker unavailable".into()),
                );
            }
        }
        let _ = run.completed.send(());
    }
    .boxed()
}

fn read_snapshot(
    resources: &Resources,
    book: &BookId,
    id: &ConversationId,
) -> Result<ChatSnapshot, String> {
    let lib = resources.workspace.library();
    let doc = DocId::Conversation(id.clone()).to_string();
    let info = lib.doc_info(&doc).map_err(string)?;
    if info.as_ref().is_some_and(|info| {
        info.kind != "conversation" || info.book_id.as_deref() != Some(book.as_str())
    }) {
        return Err("conversation belongs to another book".into());
    }
    let mut entries = if info.is_some() {
        dr_agent::conversation(lib, id).map_err(string)?
    } else {
        Vec::new()
    };
    let mut runs = Vec::new();
    for session in lib
        .agent_sessions(Some(book.as_str()))
        .map_err(string)?
        .into_iter()
        .filter(|session| session.conversation == doc)
    {
        let mut state = ChatState::new(&session.session);
        for row in dr_agent::events(lib, &session.session, 0).map_err(string)? {
            state.apply(&row)?;
        }
        // Journal commits precede Loro projection. Fill a read racing that
        // projection by immutable source id, preserving the shared list order.
        for entry in state.entries() {
            match entries.iter().find(|stored| stored.id == entry.id) {
                Some(stored) if stored != entry => {
                    return Err("conversation conflicts with its durable source event".into());
                }
                Some(_) => {}
                None => entries.push(entry.clone()),
            }
        }
        runs.push(state.snapshot());
    }
    let messages = entries
        .iter()
        .filter(|e| {
            !(e.payload["version"] == 1
                && matches!(
                    e.kind.as_str(),
                    dr_agent::long_task::CONTINUATION_ENTRY_KIND
                        | dr_agent::long_task::CHECKPOINT_ENTRY_KIND
                ))
        })
        .map(ChatMessage::from)
        .collect();
    Ok(ChatSnapshot {
        conversation: id.clone(),
        entries,
        messages,
        runs,
    })
}

fn conversation_id(doc: &str) -> Result<ConversationId, String> {
    match DocId::parse(doc).map_err(string)? {
        DocId::Conversation(id) => Ok(id),
        _ => Err("session does not refer to a conversation".into()),
    }
}

fn closed() -> String {
    "the Agent library is closing or closed".into()
}
fn string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
