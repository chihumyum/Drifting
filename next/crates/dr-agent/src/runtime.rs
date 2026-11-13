use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use dr_model::id::{BookId, ConversationId, new_uuid_v7};
use dr_store::agent::AgentEventAppend;
use dr_workspace::{Actor, Workspace};
use futures::{
    FutureExt, StreamExt,
    channel::{mpsc, oneshot},
    future::BoxFuture,
    stream::FuturesUnordered,
};
use serde_json::{Value, json};

use crate::control::{Action, Command};
use crate::journal::Journal;
use crate::tools::ToolOutput;
use crate::*;

mod external;
pub use external::{
    ExternalCall, ExternalCallHandle, ExternalScope, ExternalStart, ExternalState,
    RecoveredExternal,
};

#[derive(Clone, Debug)]
pub struct Options {
    pub max_parallel_reads: usize,
    /// How long streamed text may stay out of the journal: a block's
    /// consecutive deltas are written as one event at most this long after
    /// the first of them arrived, or sooner when any other event is written.
    /// A crash loses at most this much of the message being streamed; the
    /// panel, which reads the journal, sees new text at this pace. Zero
    /// writes every delta as it arrives.
    pub stream_flush: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_parallel_reads: 4,
            stream_flush: Duration::from_millis(100),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Start {
    pub config: RunConfig,
    pub book: BookId,
    pub conversation: ConversationId,
    pub input: String,
}

#[derive(Clone, Debug)]
pub struct ContinuationStart {
    pub chain: String,
    pub config: RunConfig,
}

#[derive(Clone, Debug)]
pub struct ResumeStart {
    pub chain: String,
    pub config: RunConfig,
    pub input: Option<String>,
}

struct Inner {
    ws: Workspace,
    driver: Arc<dyn Driver>,
    tools: Arc<dyn ToolExecutor>,
    descriptors: Vec<ToolDescriptor>,
    options: Options,
    active: Mutex<HashSet<String>>,
    external_active: Mutex<HashSet<String>>,
    lifecycle: Mutex<()>,
    // Read groups overlap internally; whole groups and writes serialize
    // across all runs of this Runtime. F3 also keeps its own command gates.
    tool_gate: Arc<futures::lock::Mutex<()>>,
    executions: Arc<crate::tools::ToolExecutions>,
}

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}

static RUNTIMES: OnceLock<Mutex<HashMap<PathBuf, Weak<Inner>>>> = OnceLock::new();

#[derive(Debug)]
pub struct RecoveredRun {
    pub session: String,
    pub state: State,
    pub settlements: Vec<SettlementRef>,
}

impl Runtime {
    pub fn new(
        ws: Workspace,
        driver: Arc<dyn Driver>,
        tools: Arc<dyn ToolExecutor>,
        options: Options,
    ) -> Result<Self> {
        if options.max_parallel_reads == 0 {
            return Err(Error::Protocol("runtime limits must be positive".into()));
        }
        let descriptors = tools.descriptors();
        let mut names = HashSet::new();
        for descriptor in &descriptors {
            if descriptor.name.is_empty()
                || descriptor.revision.is_empty()
                || !names.insert(&descriptor.name)
            {
                return Err(Error::Protocol(
                    "tool names must be nonempty and unique".into(),
                ));
            }
        }
        let path = ws
            .library()
            .paths()
            .root
            .canonicalize()
            .map_err(|e| Error::Protocol(e.to_string()))?;
        let mut runtimes = RUNTIMES
            .get_or_init(Mutex::default)
            .lock()
            .expect("library runtimes");
        runtimes.retain(|_, runtime| runtime.strong_count() != 0);
        if runtimes.get(&path).and_then(Weak::upgrade).is_some() {
            return Err(Error::Protocol(
                "one Runtime owns each library; clone the existing Runtime".into(),
            ));
        }
        let runtime = Self {
            inner: Arc::new(Inner {
                ws,
                driver,
                tools,
                descriptors,
                options,
                active: Mutex::default(),
                external_active: Mutex::default(),
                lifecycle: Mutex::default(),
                tool_gate: Arc::default(),
                executions: Arc::default(),
            }),
        };
        runtimes.insert(path, Arc::downgrade(&runtime.inner));
        Ok(runtime)
    }

    pub fn start(&self, start: Start) -> Result<RunHandle> {
        self.start_mode(start, crate::long_task::StartMode::Author, None)
    }

    pub fn start_continuation(&self, start: ContinuationStart) -> Result<RunHandle> {
        let snapshot =
            crate::long_task::Store::new(self.inner.ws.library().clone()).snapshot(&start.chain)?;
        if snapshot
            .plan
            .as_ref()
            .is_none_or(|plan| plan.status != crate::long_task::TaskStatus::Active)
        {
            return Err(Error::Protocol(
                "automatic continuation needs an active plan".into(),
            ));
        }
        self.start_mode(
            Start {
                config: start.config,
                book: snapshot.book,
                conversation: snapshot.conversation,
                input: String::new(),
            },
            crate::long_task::StartMode::Automatic,
            Some(start.chain),
        )
    }

    pub fn start_resume(&self, start: ResumeStart) -> Result<RunHandle> {
        let snapshot =
            crate::long_task::Store::new(self.inner.ws.library().clone()).snapshot(&start.chain)?;
        if snapshot
            .plan
            .as_ref()
            .is_some_and(|plan| plan.status.terminal())
        {
            return Err(Error::Protocol(
                "this task is terminal; start a new author request".into(),
            ));
        }
        self.start_mode(
            Start {
                config: start.config,
                book: snapshot.book,
                conversation: snapshot.conversation,
                input: start.input.unwrap_or_default(),
            },
            crate::long_task::StartMode::Resume,
            Some(start.chain),
        )
    }

    fn start_mode(
        &self,
        start: Start,
        mode: crate::long_task::StartMode,
        chain: Option<String>,
    ) -> Result<RunHandle> {
        let _lifecycle = self.inner.lifecycle.lock().expect("runtime lifecycle");
        start.config.validate()?;
        if mode == crate::long_task::StartMode::Author && start.input.trim().is_empty() {
            return Err(Error::Protocol("empty author message".into()));
        }
        if let Some(chain) = &chain {
            let store = crate::long_task::Store::new(self.inner.ws.library().clone());
            for session in self.inner.active.lock().expect("active runs").iter() {
                if store.chain_for_session(session)?.as_ref() == Some(chain) {
                    return Err(Error::Protocol(
                        "a slice of this request chain is still running".into(),
                    ));
                }
            }
        }
        if self
            .inner
            .ws
            .library()
            .doc_info(&format!("book:{}", start.book))?
            .is_none()
        {
            return Err(Error::Protocol("book is not stored".into()));
        }
        let session = new_uuid_v7();
        let lib = self.inner.ws.library();
        let conversation_doc =
            dr_model::DocId::Conversation(start.conversation.clone()).to_string();
        if let Some(info) = lib.doc_info(&conversation_doc)?
            && (info.kind != "conversation" || info.book_id.as_deref() != Some(start.book.as_str()))
        {
            return Err(Error::Protocol(
                "conversation belongs to another book or document kind".into(),
            ));
        }
        lib.local_write(|tx| {
            tx.agent_create_session(&session, &conversation_doc, start.book.as_str())?;
            crate::long_task::begin(tx, &session, &start, mode, chain.as_deref())?;
            tx.agent_append_event(&AgentEventAppend {
                session: session.clone(),
                expected_seq: 0,
                event_json: json!({"turn":1,"event":Event::Started { version: PROTOCOL_VERSION }})
                    .to_string(),
            })?;
            Ok(())
        })?;
        let mut journal = Journal::open(lib.clone(), &session)?;
        journal.append(Event::Configured {
            config: start.config.clone(),
        })?;
        if mode == crate::long_task::StartMode::Automatic || start.input.trim().is_empty() {
            journal.append(Event::Continuation { text:"Continue the same author request using the current durable task plan and evidence. Read the plan, reconcile structural drift when needed, and do the next actionable step. Do not repeat saved writes or claim completion without matching evidence.".into() })?;
        } else {
            journal.append(Event::UserMessage { text: start.input })?;
        }
        let (sender, commands) = mpsc::unbounded();
        let (finished_tx, finished) = oneshot::channel();
        let state = Arc::new(Mutex::new(State::Streaming));
        let cancel = Cancellation::default();
        let control = Control {
            sender,
            cancel: cancel.clone(),
            state: state.clone(),
        };
        self.inner
            .active
            .lock()
            .expect("active runs")
            .insert(session.clone());
        let inner = self.inner.clone();
        let session_id = session.clone();
        let spawn = std::thread::Builder::new()
            .name("dr-agent".into())
            .spawn(move || {
                let mut worker = Worker {
                    config: Arc::new(start.config),
                    inner: inner.clone(),
                    journal,
                    book: start.book,
                    commands,
                    state,
                    cancel,
                    steering: VecDeque::new(),
                    stopping: false,
                    aborting: false,
                    seen_calls: HashSet::new(),
                    flush_timer: FlushTimer::default(),
                };
                let result = futures::executor::block_on(
                    std::panic::AssertUnwindSafe(worker.run()).catch_unwind(),
                )
                .unwrap_or_else(|_| Err(Error::Protocol("runtime adapter panicked".into())));
                let result = match result {
                    Ok(state) => Ok(state),
                    Err(error) => {
                        // A run can fail mid-stream with text still buffered.
                        // Write it before reconciling the partial message from
                        // the journal; if even that fails, it is the tail a
                        // crash would have lost, and the journal stays whole.
                        if worker.journal.flush().is_err() {
                            worker.journal.discard_unflushed();
                        }
                        if let Ok(log) = events(&worker.journal.lib, &worker.journal.session, 0) {
                            let _ = reconcile(&mut worker.journal, &log);
                        }
                        // Do not claim durable failure if even the journal cannot
                        // be appended. Startup recovery will mark it interrupted.
                        if let Error::Provider(failure) = &error {
                            let _ = worker.journal.append(Event::ModelFailed {
                                failure: failure.clone(),
                            });
                        }
                        let _ = worker.journal.append(Event::Failed {
                            error: error.to_string(),
                        });
                        let _ = worker.set_state(State::Failed);
                        Err(error)
                    }
                };
                worker.close_mailbox();
                inner
                    .active
                    .lock()
                    .expect("active runs")
                    .remove(&session_id);
                inner.tools.finish_session(&session_id);
                drop(worker);
                drop(inner);
                let _ = finished_tx.send(result);
            });
        if let Err(error) = spawn {
            self.inner
                .active
                .lock()
                .expect("active runs")
                .remove(&session);
            return Err(Error::Protocol(error.to_string()));
        }
        Ok(RunHandle {
            session,
            control,
            finished: Some(finished),
        })
    }

    /// Wait for every entered tool context, including synchronous workers
    /// whose read futures were cancelled. The owner must first freeze new
    /// starts and await all run handles; this does not change read cancellation
    /// or a RunHandle's completion boundary.
    pub fn drain_tools(&self) -> BoxFuture<'static, Result<()>> {
        self.inner.executions.drain()
    }

    /// Startup recovery, before creating runs. Replays the conversation
    /// projection, settles unknown tool outcomes from F2 receipts, and closes
    /// interrupted runs. Never repeats a tool or revives an old permission.
    ///
    /// A session replayed in full is remembered as settled with the journal
    /// sequence it ended at; while its journal still ends there it is not
    /// replayed again, since a replay would change nothing (see [`SETTLED`]).
    pub fn recover(&self) -> Result<Vec<RecoveredRun>> {
        let _lifecycle = self.inner.lifecycle.lock().expect("runtime lifecycle");
        let lib = self.inner.ws.library();
        let marks: HashMap<String, String> = lib
            .local_entries(SETTLED, None)?
            .into_iter()
            .map(|entry| (entry.key, entry.value))
            .collect();
        let mut settled = Vec::new();
        let recovered = self.recover_sessions(&marks, &mut settled);
        // What was replayed in full stays settled even if a later session
        // failed to recover. The marks only save work: if they cannot be
        // written, those sessions are replayed again next time.
        if !settled.is_empty() {
            let _ = lib.local_write(|tx| {
                for (session, book, seq) in &settled {
                    tx.set_state(SETTLED, session, &settled_mark(*seq), Some(book))?;
                }
                Ok(())
            });
        }
        recovered
    }

    fn recover_sessions(
        &self,
        marks: &HashMap<String, String>,
        settled: &mut Vec<(String, String, i64)>,
    ) -> Result<Vec<RecoveredRun>> {
        let lib = self.inner.ws.library();
        let mut recovered = Vec::new();
        for session in lib.agent_sessions(None)? {
            if self
                .inner
                .active
                .lock()
                .expect("active runs")
                .contains(&session.session)
            {
                continue;
            }
            if is_settled(lib, &session.session, marks.get(&session.session))? {
                continue;
            }
            let (mut journal, log) = Journal::open_with_log(lib.clone(), &session.session)?;
            let state = log.iter().rev().find_map(|e| {
                if let Event::StateChanged { state } = e.event {
                    Some(state)
                } else {
                    None
                }
            });
            reconcile(&mut journal, &log)?;
            if !state.is_some_and(State::is_terminal) {
                // Steering received before a crash remains visible and available
                // for an explicit new run; no unfinished run executes on restart.
                journal.append(Event::Recovered)?;
                journal.append(Event::StateChanged {
                    state: State::Interrupted,
                })?;
                let settlements = settlement_refs(&journal.lib, &journal.session, 0, None)?;
                recovered.push(RecoveredRun {
                    session: session.session.clone(),
                    state: State::Interrupted,
                    settlements,
                });
            }
            settled.push((session.session, session.book_id, journal.seq));
        }
        Ok(recovered)
    }
}

/// `local_state` scope of the sessions `recover` replayed in full: key the
/// session, value [`settled_mark`] of the journal sequence the replay ended
/// at. After such a replay every event of the journal is projected, the
/// partial message and every open call are closed, and the session is
/// terminal; journals and conversations only grow and terminal sessions take
/// no new events, so while the journal still ends at that sequence another
/// replay would write nothing. A session that grew, a mark of another format
/// or protocol, or no mark (journals from before marks) is replayed as it
/// always was. Rows are tied to the book and go when it is purged.
const SETTLED: &str = "agent.settled";

/// Change when `Journal::project` or `reconcile` would write something for
/// a journal they already replayed: every session is then replayed once more.
const SETTLED_FORMAT: u32 = 1;

fn settled_mark(seq: i64) -> String {
    format!("{SETTLED_FORMAT}:{PROTOCOL_VERSION}:{seq}")
}

/// Whether the session's journal still ends exactly at its settled mark.
fn is_settled(lib: &dr_store::Library, session: &str, mark: Option<&String>) -> Result<bool> {
    let prefix = format!("{SETTLED_FORMAT}:{PROTOCOL_VERSION}:");
    let Some(seq) = mark
        .and_then(|mark| mark.strip_prefix(&prefix))
        .and_then(|seq| seq.parse::<i64>().ok())
        .filter(|seq| *seq >= 1)
    else {
        return Ok(false);
    };
    Ok(lib.agent_event(session, seq)?.is_some() && lib.agent_events(session, seq)?.is_empty())
}

fn reconcile(journal: &mut Journal, log: &[JournalEvent]) -> Result<()> {
    let turn = journal.turn;
    let mut pending = HashMap::new();
    let mut partial = None;
    for event in log {
        match &event.event {
            Event::StateChanged {
                state: State::Streaming,
            } => partial = Some(AssistantMessage::default()),
            Event::TextDelta { index, text } => {
                if let Some(message) = &mut partial {
                    add_delta(message, *index, text, false)?;
                }
            }
            Event::ThinkingDelta { index, text } => {
                if let Some(message) = &mut partial {
                    add_delta(message, *index, text, true)?;
                }
            }
            Event::ThinkingSignature {
                index,
                signature,
                replay,
            } => {
                if let Some(message) = &mut partial {
                    add_delta(message, *index, "", true)?;
                    for block in &mut message.blocks {
                        if let ContentBlock::Thinking {
                            index: i,
                            signature: s,
                            replay: r,
                            ..
                        } = block
                            && i == index
                        {
                            *s = signature.clone();
                            *r = replay.clone();
                        }
                    }
                }
            }
            Event::Usage { usage } => {
                if let Some(message) = &mut partial {
                    message.usage = *usage;
                }
            }
            Event::ProviderReplay { replay } => {
                if let Some(message) = &mut partial {
                    message.replay = Some(replay.clone());
                }
            }
            Event::ToolProposed { call } => {
                pending.insert(call.id.clone(), event.turn);
                if let Some(message) = &mut partial {
                    message
                        .blocks
                        .push(ContentBlock::ToolCall { call: call.clone() });
                }
            }
            Event::AssistantMessage { .. } => partial = None,
            Event::ToolStarted { call } => {
                pending.insert(call.id.clone(), event.turn);
            }
            Event::ToolFinished { result } => {
                pending.remove(&result.call);
            }
            _ => {}
        }
    }
    if let Some(message) = partial
        && !message.blocks.is_empty()
    {
        journal.append(Event::AssistantMessage { message })?;
    }
    let mut calls: Vec<_> = pending.into_iter().collect();
    calls.sort();
    for (call, turn) in calls {
        journal.turn = turn;
        let settlements = settlement_refs(&journal.lib, &journal.session, turn, Some(&call))?;
        journal.append(Event::ToolFinished {
            result: ToolResult {
                call,
                status: ToolStatus::Interrupted,
                output: json!({"reason":"interrupted; effects reconciled from durable receipts"}),
                settlements,
            },
        })?;
    }
    journal.turn = turn;
    Ok(())
}

fn settlement_refs(
    lib: &dr_store::Library,
    session: &str,
    turn: u32,
    call: Option<&str>,
) -> Result<Vec<SettlementRef>> {
    Ok(lib
        .settlements(Some(session), None)?
        .into_iter()
        .filter(|s| call.is_none_or(|c| s.call == c && s.turn == turn.to_string()))
        .map(|s| SettlementRef {
            id: s.id,
            document: s.doc_id,
            seq: s.seq,
        })
        .collect())
}

enum Reply {
    Answer(Value),
    Permission(bool),
}

struct Worker {
    config: Arc<RunConfig>,
    inner: Arc<Inner>,
    journal: Journal,
    book: BookId,
    commands: mpsc::UnboundedReceiver<Command>,
    state: Arc<Mutex<State>>,
    cancel: Cancellation,
    steering: VecDeque<(String, String)>,
    stopping: bool,
    aborting: bool,
    seen_calls: HashSet<String>,
    flush_timer: FlushTimer,
}

/// Wakes a run when its buffered text is due, without an async timer
/// runtime: one sleeping thread per run, started by the first deadline and
/// ended with the run. It holds no library resources. Deadlines arrive in
/// increasing order (each buffer starts after the previous one was written),
/// so serving them first come, first served never wakes one late.
#[derive(Default)]
struct FlushTimer {
    requests: Option<std::sync::mpsc::Sender<(Instant, oneshot::Sender<()>)>>,
}

impl FlushTimer {
    /// A receiver completed at `at`, or `None` when no timer thread can run.
    fn at(&mut self, at: Instant) -> Option<oneshot::Receiver<()>> {
        if self.requests.is_none() {
            let (requests, incoming) = std::sync::mpsc::channel::<(Instant, oneshot::Sender<()>)>();
            std::thread::Builder::new()
                .name("dr-agent-flush".into())
                .spawn(move || {
                    while let Ok((at, wake)) = incoming.recv() {
                        let now = Instant::now();
                        if at > now {
                            std::thread::sleep(at - now);
                        }
                        let _ = wake.send(());
                    }
                })
                .ok()?;
            self.requests = Some(requests);
        }
        let (wake, woken) = oneshot::channel();
        match self.requests.as_ref()?.send((at, wake)) {
            Ok(()) => Some(woken),
            Err(_) => {
                self.requests = None;
                None
            }
        }
    }
}

impl Worker {
    fn set_state(&mut self, state: State) -> Result<()> {
        self.journal.append(Event::StateChanged { state })?;
        *self.state.lock().expect("runtime state") = state;
        Ok(())
    }

    fn halted(&self) -> bool {
        self.stopping || self.aborting
    }

    fn command(
        &mut self,
        command: Command,
        pending: Option<(&RequestId, bool)>,
    ) -> Result<Option<Reply>> {
        let mut response = None;
        let event = match command.action {
            Action::Steer(text) if !self.halted() && !text.trim().is_empty() => {
                let id = new_uuid_v7();
                self.steering.push_back((id.clone(), text.clone()));
                Some(Event::SteeringReceived { id, text })
            }
            Action::Answer(request, answer)
                if pending.is_some_and(|(id, permission)| !permission && id == &request)
                    && !self.halted() =>
            {
                response = Some(Reply::Answer(answer.clone()));
                Some(Event::Answered { request, answer })
            }
            Action::Permission(request, allow)
                if pending.is_some_and(|(id, permission)| permission && id == &request)
                    && !self.halted() =>
            {
                response = Some(Reply::Permission(allow));
                Some(Event::PermissionAnswered { request, allow })
            }
            Action::Stop => {
                if self.stopping {
                    None
                } else {
                    self.stopping = true;
                    Some(Event::StopRequested)
                }
            }
            Action::Abort => {
                self.cancel.cancel();
                if self.aborting {
                    None
                } else {
                    self.aborting = true;
                    Some(Event::AbortRequested)
                }
            }
            _ => {
                let _ = command.reply.send(Err(Error::StaleRequest));
                return Ok(None);
            }
        };
        if let Some(event) = event
            && let Err(error) = self.journal.append(event)
        {
            let _ = command.reply.send(Err(Error::Protocol(error.to_string())));
            return Err(error);
        }
        if self.halted() {
            self.set_state(State::Stopping)?;
        }
        let _ = command.reply.send(Ok(()));
        Ok(response)
    }

    fn drain(&mut self) -> Result<()> {
        while let Ok(command) = self.commands.try_recv() {
            self.command(command, None)?;
        }
        Ok(())
    }

    fn close_mailbox(&mut self) {
        self.commands.close();
        // Delivery is not acknowledgement. Requests racing with completion
        // that have not been durably handled receive Closed, never success.
        while let Ok(command) = self.commands.try_recv() {
            let _ = command.reply.send(Err(Error::Closed));
        }
    }

    fn apply_steering(&mut self) -> Result<bool> {
        let applied = !self.steering.is_empty();
        while let Some((id, text)) = self.steering.pop_front() {
            self.journal.turn = self
                .journal
                .turn
                .checked_add(1)
                .ok_or_else(|| Error::Protocol("turn overflow".into()))?;
            self.journal.append(Event::UserMessage { text })?;
            self.journal.append(Event::SteeringApplied { id })?;
        }
        Ok(applied)
    }

    async fn run(&mut self) -> Result<State> {
        let mut round = 0_u32;
        let mut budget_turn = self.journal.turn;
        let mut turn_round = 0_u32;
        loop {
            self.drain()?;
            if self.halted() {
                return self.finish_halted();
            }
            self.apply_steering()?;
            if budget_turn != self.journal.turn {
                budget_turn = self.journal.turn;
                turn_round = 0;
            }
            turn_round = turn_round.saturating_add(1);
            round = round
                .checked_add(1)
                .ok_or_else(|| Error::Protocol("round overflow".into()))?;
            if self
                .config
                .max_model_rounds
                .is_some_and(|limit| turn_round > limit)
            {
                return self.checkpoint("model_round_limit");
            }
            let Some(calls) = self.model(round).await? else {
                return Ok(State::Checkpointed);
            };
            self.drain()?;
            if self.halted() {
                for call in calls {
                    self.tool_result(&call, ToolStatus::Cancelled, Value::Null)?;
                }
                return self.finish_halted();
            }
            let has_tools = !calls.is_empty();
            if has_tools {
                self.tools(calls).await?;
            }
            self.drain()?;
            if self.halted() {
                return self.finish_halted();
            }
            if !has_tools && self.steering.is_empty() {
                // Closing the channel is the completion linearization point.
                // No control caller shares a lock with the terminal write.
                self.close_mailbox();
                self.set_state(State::Completed)?;
                return Ok(State::Completed);
            }
        }
    }

    fn finish_halted(&mut self) -> Result<State> {
        let state = if self.aborting {
            State::Aborted
        } else {
            State::Stopped
        };
        self.set_state(state)?;
        Ok(state)
    }

    fn checkpoint(&mut self, reason: &str) -> Result<State> {
        self.journal.append(Event::Checkpoint {
            reason: reason.into(),
        })?;
        self.close_mailbox();
        self.set_state(State::Checkpointed)?;
        Ok(State::Checkpointed)
    }

    async fn model(&mut self, round: u32) -> Result<Option<Vec<ToolCall>>> {
        let store = crate::long_task::Store::new(self.journal.lib.clone());
        let chain = store
            .chain_for_session(&self.journal.session)?
            .ok_or_else(|| Error::Protocol("run has no request chain".into()))?;
        let snapshot = store.snapshot(&chain)?;
        let contributions =
            self.inner
                .tools
                .context(&self.inner.ws, &self.book, &self.journal.session)?;
        let prepared = crate::context::prepare(
            &self.config,
            &snapshot,
            self.journal.transcript()?,
            &self.inner.descriptors,
            contributions,
        )?;
        let crate::context::Prepared::Ready {
            conversation,
            checkpoint,
        } = prepared
        else {
            self.checkpoint("context_capacity")?;
            return Ok(None);
        };
        crate::context::save_checkpoint(&self.journal.lib, &snapshot, &checkpoint)?;
        self.drain()?;
        if self.halted() {
            return Ok(Some(Vec::new()));
        }
        self.set_state(State::Streaming)?;
        let request = DriverRequest {
            purpose: crate::RequestPurpose::Chat,
            config: self.config.clone(),
            session: self.journal.session.clone(),
            turn: self.journal.turn,
            round,
            conversation,
            tools: self.inner.descriptors.clone(),
        };
        let mut stream = self
            .inner
            .driver
            .stream(request, self.cancel.clone())
            .fuse();
        let mut message = AssistantMessage::default();
        let mut calls = Vec::new();
        // Streamed text is buffered by the journal (see `Journal`); this
        // alarm writes it when it is due while the stream is quiet. Every
        // other event below, and the closing `AssistantMessage`, writes it
        // first in its own transaction.
        let interval = self.inner.options.stream_flush;
        let mut alarm: Option<(Instant, oneshot::Receiver<()>)> = None;
        let result = loop {
            match self.journal.flush_due(interval) {
                None => alarm = None,
                Some(at) if alarm.as_ref().is_none_or(|(armed, _)| *armed != at) => {
                    alarm = None;
                    match self.flush_timer.at(at) {
                        Some(woken) => alarm = Some((at, woken)),
                        None => self.journal.flush()?,
                    }
                }
                Some(_) => {}
            }
            let due = async {
                match alarm.as_mut() {
                    Some((_, woken)) => {
                        let _ = woken.await;
                    }
                    None => futures::future::pending::<()>().await,
                }
            };
            futures::select_biased! {
                command = next_command(&mut self.commands).fuse() => {
                    if let Some(command) = command { self.command(command, None)?; }
                    if self.halted() { break Ok(()); }
                },
                event = stream.next() => {
                    let event = match event {
                        Some(Ok(event)) => event,
                        Some(Err(error)) => break Err(error),
                        None => break Err(Error::Protocol("driver ended without Finish".into())),
                    };
                    match event {
                        DriverEvent::TextDelta { index, text } => {
                            add_delta(&mut message, index, &text, false)?;
                            self.journal.stream(false, index, &text, interval, Instant::now())?;
                        }
                        DriverEvent::ThinkingDelta { index, text } => {
                            add_delta(&mut message, index, &text, true)?;
                            self.journal.stream(true, index, &text, interval, Instant::now())?;
                        }
                        DriverEvent::ThinkingSignature { index, signature, replay } => {
                            add_delta(&mut message, index, "", true)?;
                            let block = message.blocks.iter_mut().find(|b| matches!(b, ContentBlock::Thinking { index: i, .. } if *i == index)).expect("thinking block");
                            if let ContentBlock::Thinking { signature: s, replay: r, .. } = block { *s = signature.clone(); *r = replay.clone(); }
                            self.journal.append(Event::ThinkingSignature { index, signature, replay })?;
                        }
                        DriverEvent::ToolCall(call) => {
                            if call.id.is_empty() || !self.seen_calls.insert(call.id.clone()) {
                                break Err(Error::Protocol("tool call ids must be nonempty and unique within a run".into()));
                            }
                            message.blocks.push(ContentBlock::ToolCall { call: call.clone() });
                            self.journal.append(Event::ToolProposed { call: call.clone() })?;
                            calls.push(call);
                        }
                        DriverEvent::Usage(usage) => {
                            message.usage = usage;
                            self.journal.append(Event::Usage { usage })?;
                        }
                        DriverEvent::Replay { replay } => {
                            message.replay = Some(replay.clone());
                            self.journal.append(Event::ProviderReplay { replay })?;
                        }
                        DriverEvent::ProviderTool { activity } => {
                            self.journal.append(Event::ProviderTool { activity })?;
                        }
                        DriverEvent::Finish(reason) => {
                            if (reason == FinishReason::Tools) == calls.is_empty() {
                                break Err(Error::Protocol("Finish reason does not match tool calls".into()));
                            }
                            message.complete = true;
                            break Ok(());
                        }
                    }
                },
                () = due.fuse() => {
                    alarm = None;
                    self.journal.flush()?;
                },
            }
        };
        self.journal.append(Event::AssistantMessage { message })?;
        if result.is_err() {
            for call in &calls {
                self.tool_result(call, ToolStatus::Cancelled, Value::Null)?;
            }
        }
        result?;
        Ok(Some(calls))
    }

    fn descriptor(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        self.inner
            .descriptors
            .iter()
            .any(|d| d.name == call.name)
            .then(|| {
                self.inner
                    .tools
                    .describe_in_book(&self.inner.ws, &self.book, call)
            })
            .flatten()
    }

    async fn tools(&mut self, calls: Vec<ToolCall>) -> Result<()> {
        let mut queue = VecDeque::from(calls);
        while let Some(call) = queue.pop_front() {
            self.drain()?;
            if self.halted() {
                queue.push_front(call);
                break;
            }
            let Some(descriptor) = self.descriptor(&call) else {
                self.tool_result(&call, ToolStatus::Error, json!({"error":"unknown tool"}))?;
                continue;
            };
            if descriptor.policy != ToolPolicy::Local
                && !self.permission(&call, descriptor.policy).await?
            {
                self.tool_result(
                    &call,
                    if self.halted() {
                        ToolStatus::Cancelled
                    } else {
                        ToolStatus::Denied
                    },
                    Value::Null,
                )?;
                continue;
            }
            let mut group = vec![(call, descriptor.clone())];
            if descriptor.access == ToolAccess::Read && descriptor.policy == ToolPolicy::Local {
                while group.len() < self.inner.options.max_parallel_reads {
                    let Some(next) = queue.front() else {
                        break;
                    };
                    let Some(d) = self.descriptor(next) else {
                        break;
                    };
                    if d.access != ToolAccess::Read || d.policy != ToolPolicy::Local {
                        break;
                    }
                    group.push((queue.pop_front().expect("front"), d));
                }
            }
            self.group(group).await?;
        }
        for call in queue {
            self.tool_result(&call, ToolStatus::Cancelled, Value::Null)?;
        }
        Ok(())
    }

    async fn group(&mut self, group: Vec<(ToolCall, ToolDescriptor)>) -> Result<()> {
        let gate = self.inner.tool_gate.clone();
        let guard = gate.lock().fuse();
        futures::pin_mut!(guard);
        let _guard = loop {
            futures::select_biased! {
                command = next_command(&mut self.commands).fuse() => {
                    if let Some(command) = command { self.command(command, None)?; }
                    if self.halted() {
                        for (call, _) in group { self.tool_result(&call, ToolStatus::Cancelled, Value::Null)?; }
                        return Ok(());
                    }
                },
                acquired = guard => break acquired,
            }
        };
        self.drain()?;
        if self.halted() {
            for (call, _) in group {
                self.tool_result(&call, ToolStatus::Cancelled, Value::Null)?;
            }
            return Ok(());
        }
        self.set_state(State::RunningTools)?;
        let is_write = group[0].1.access == ToolAccess::Write;
        type ToolCompletion = (
            ToolCall,
            Result<ToolOutput>,
            Vec<crate::evidence::ReadObservation>,
        );
        let mut active: FuturesUnordered<BoxFuture<'static, ToolCompletion>> =
            FuturesUnordered::new();
        let mut pending = HashMap::new();
        for (call, descriptor) in group {
            if self
                .inner
                .tools
                .describe_in_book(&self.inner.ws, &self.book, &call)
                .as_ref()
                != Some(&descriptor)
            {
                self.tool_result(
                    &call,
                    ToolStatus::Error,
                    json!({"error":"tool definition changed; request it again"}),
                )?;
                continue;
            }
            self.journal
                .append(Event::ToolStarted { call: call.clone() })?;
            pending.insert(call.id.clone(), call.clone());
            let cx = ToolContext {
                book: self.book.clone(),
                actor: Actor::agent(&self.journal.session, self.journal.turn, &call.id),
                cancellation: self.cancel.clone(),
                workspace: self.inner.ws.clone(),
                access: descriptor.access,
                descriptor,
                _execution: self.inner.executions.enter(),
            };
            let executor = self.inner.tools.clone();
            let evidence = cx._execution.clone();
            active.push(
                async move {
                    let tool = async { executor.execute(cx, call.clone()).await };
                    let result = std::panic::AssertUnwindSafe(tool)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| Err(Error::Tool("tool executor panicked".into())));
                    (call, result, evidence.take_observations())
                }
                .boxed(),
            );
        }
        let mut questions = Vec::new();
        let mut control_error = None;
        while !active.is_empty() {
            futures::select_biased! {
                command = next_command(&mut self.commands).fuse() => {
                    if let Some(command) = command
                        && let Err(error) = self.command(command, None) {
                        if !is_write { return Err(error); }
                        // Even a full disk must not detach an entered write.
                        self.cancel.cancel();
                        control_error = Some(error);
                    }
                    // Entered writes cannot be dropped: they might be in F2's
                    // transaction. Wait, reconcile receipts, then terminate.
                    if self.aborting && !is_write { break; }
                },
                result = active.next().fuse() => {
                    let (call, output, observations) = result.expect("active tool");
                    pending.remove(&call.id);
                    match output {
                        Ok(ToolOutput::Value(value)) => self.tool_result_observed(&call, ToolStatus::Success, value, observations)?,
                        Ok(ToolOutput::Error(value)) => self.tool_result(&call, ToolStatus::Error, value)?,
                        Ok(ToolOutput::Stop(value)) => {
                            self.tool_result(&call, ToolStatus::Error, value)?;
                            self.stopping = true;
                            self.set_state(State::Stopping)?;
                        }
                        Ok(ToolOutput::Question(question)) => questions.push((call, question)),
                        Err(error) => self.tool_result(&call, ToolStatus::Error, json!({"error":error.to_string()}))?,
                    }
                }
            }
        }
        drop(active);
        for call in pending.into_values() {
            self.tool_result(&call, ToolStatus::Cancelled, Value::Null)?;
        }
        if let Some(error) = control_error {
            return Err(error);
        }
        // A user wait must not hold the scheduler and block other runs.
        drop(_guard);
        for (call, question) in questions {
            if self.halted() {
                self.tool_result(&call, ToolStatus::Cancelled, Value::Null)?;
                continue;
            }
            let request = self.request(&call);
            self.journal.append(Event::QuestionAsked {
                request: request.clone(),
                question,
            })?;
            self.set_state(State::AwaitingAnswer)?;
            match self.wait_answer(&request, false).await? {
                Some(Reply::Answer(answer)) => {
                    self.tool_result(&call, ToolStatus::Success, answer)?
                }
                _ => self.tool_result(&call, ToolStatus::Cancelled, Value::Null)?,
            }
        }
        Ok(())
    }

    fn request(&self, call: &ToolCall) -> RequestId {
        RequestId {
            session: self.journal.session.clone(),
            turn: self.journal.turn,
            call: call.id.clone(),
            nonce: new_uuid_v7(),
        }
    }

    async fn permission(&mut self, call: &ToolCall, policy: ToolPolicy) -> Result<bool> {
        let request = self.request(call);
        self.journal.append(Event::PermissionAsked {
            request: request.clone(),
            policy,
            call: call.clone(),
        })?;
        self.set_state(State::AwaitingPermission)?;
        Ok(matches!(
            self.wait_answer(&request, true).await?,
            Some(Reply::Permission(true))
        ))
    }

    async fn wait_answer(
        &mut self,
        request: &RequestId,
        permission: bool,
    ) -> Result<Option<Reply>> {
        while let Some(command) = self.commands.next().await {
            if let Some(reply) = self.command(command, Some((request, permission)))? {
                return Ok(Some(reply));
            }
            if self.halted() {
                return Ok(None);
            }
        }
        self.stopping = true;
        Ok(None)
    }

    fn tool_result(&mut self, call: &ToolCall, status: ToolStatus, output: Value) -> Result<()> {
        self.tool_result_observed(call, status, output, Vec::new())
    }

    fn tool_result_observed(
        &mut self,
        call: &ToolCall,
        status: ToolStatus,
        output: Value,
        observations: Vec<crate::evidence::ReadObservation>,
    ) -> Result<()> {
        let settlements = settlement_refs(
            &self.journal.lib,
            &self.journal.session,
            self.journal.turn,
            Some(&call.id),
        )?;
        self.journal.append_observed(
            Event::ToolFinished {
                result: ToolResult {
                    call: call.id.clone(),
                    status,
                    output,
                    settlements,
                },
            },
            observations,
        )
    }
}

fn add_delta(
    message: &mut AssistantMessage,
    index: u32,
    delta: &str,
    thinking: bool,
) -> Result<()> {
    for block in &mut message.blocks {
        match block {
            ContentBlock::Text { index: i, text } if *i == index && !thinking => {
                text.push_str(delta);
                return Ok(());
            }
            ContentBlock::Thinking { index: i, text, .. } if *i == index && thinking => {
                text.push_str(delta);
                return Ok(());
            }
            ContentBlock::Text { index: i, .. } | ContentBlock::Thinking { index: i, .. }
                if *i == index =>
            {
                return Err(Error::Protocol("content block changed kind".into()));
            }
            _ => {}
        }
    }
    message.blocks.push(if thinking {
        ContentBlock::Thinking {
            index,
            text: delta.to_string(),
            signature: None,
            replay: None,
        }
    } else {
        ContentBlock::Text {
            index,
            text: delta.to_string(),
        }
    });
    Ok(())
}

async fn next_command(commands: &mut mpsc::UnboundedReceiver<Command>) -> Option<Command> {
    match commands.next().await {
        Some(command) => Some(command),
        None => futures::future::pending().await,
    }
}
