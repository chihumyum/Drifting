use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

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

#[derive(Clone, Debug)]
pub struct Options {
    pub max_parallel_reads: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_parallel_reads: 4,
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

struct Inner {
    ws: Workspace,
    driver: Arc<dyn Driver>,
    tools: Arc<dyn ToolExecutor>,
    descriptors: Vec<ToolDescriptor>,
    options: Options,
    active: Mutex<HashSet<String>>,
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
                lifecycle: Mutex::default(),
                tool_gate: Arc::default(),
                executions: Arc::default(),
            }),
        };
        runtimes.insert(path, Arc::downgrade(&runtime.inner));
        Ok(runtime)
    }

    pub fn start(&self, start: Start) -> Result<RunHandle> {
        let _lifecycle = self.inner.lifecycle.lock().expect("runtime lifecycle");
        start.config.validate()?;
        if start.input.trim().is_empty() {
            return Err(Error::Protocol("empty author message".into()));
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
        journal.append(Event::UserMessage { text: start.input })?;
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
                };
                let result = futures::executor::block_on(
                    std::panic::AssertUnwindSafe(worker.run()).catch_unwind(),
                )
                .unwrap_or_else(|_| Err(Error::Protocol("runtime adapter panicked".into())));
                let result = match result {
                    Ok(state) => Ok(state),
                    Err(error) => {
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
    pub fn recover(&self) -> Result<Vec<RecoveredRun>> {
        let _lifecycle = self.inner.lifecycle.lock().expect("runtime lifecycle");
        let mut recovered = Vec::new();
        for session in self.inner.ws.library().agent_sessions(None)? {
            if self
                .inner
                .active
                .lock()
                .expect("active runs")
                .contains(&session.session)
            {
                continue;
            }
            let mut journal = Journal::open(self.inner.ws.library().clone(), &session.session)?;
            let log = events(&journal.lib, &session.session, 0)?;
            let state = log.iter().rev().find_map(|e| {
                if let Event::StateChanged { state } = e.event {
                    Some(state)
                } else {
                    None
                }
            });
            reconcile(&mut journal, &log)?;
            if state.is_some_and(State::is_terminal) {
                continue;
            }
            // Steering received before a crash remains visible and available
            // for an explicit new run; no unfinished run executes on restart.
            journal.append(Event::Recovered)?;
            journal.append(Event::StateChanged {
                state: State::Interrupted,
            })?;
            let settlements = settlement_refs(&journal.lib, &journal.session, 0, None)?;
            recovered.push(RecoveredRun {
                session: session.session,
                state: State::Interrupted,
                settlements,
            });
        }
        Ok(recovered)
    }
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
                return Err(Error::Protocol(
                    "author-selected model round limit reached".into(),
                ));
            }
            let calls = self.model(round).await?;
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

    async fn model(&mut self, round: u32) -> Result<Vec<ToolCall>> {
        self.set_state(State::Streaming)?;
        let request = DriverRequest {
            config: self.config.clone(),
            session: self.journal.session.clone(),
            turn: self.journal.turn,
            round,
            conversation: self.journal.transcript()?,
            tools: self.inner.descriptors.clone(),
        };
        let mut stream = self
            .inner
            .driver
            .stream(request, self.cancel.clone())
            .fuse();
        let mut message = AssistantMessage::default();
        let mut calls = Vec::new();
        let result = loop {
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
                            self.journal.append(Event::TextDelta { index, text })?;
                        }
                        DriverEvent::ThinkingDelta { index, text } => {
                            add_delta(&mut message, index, &text, true)?;
                            self.journal.append(Event::ThinkingDelta { index, text })?;
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
                }
            }
        };
        self.journal.append(Event::AssistantMessage { message })?;
        if result.is_err() {
            for call in &calls {
                self.tool_result(call, ToolStatus::Cancelled, Value::Null)?;
            }
        }
        result?;
        Ok(calls)
    }

    fn descriptor(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        self.inner
            .descriptors
            .iter()
            .any(|d| d.name == call.name)
            .then(|| self.inner.tools.describe(call))
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
        let mut active: FuturesUnordered<BoxFuture<'static, (ToolCall, Result<ToolOutput>)>> =
            FuturesUnordered::new();
        let mut pending = HashMap::new();
        for (call, descriptor) in group {
            if self.inner.tools.describe(&call).as_ref() != Some(&descriptor) {
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
            active.push(
                async move {
                    let tool = async { executor.execute(cx, call.clone()).await };
                    let result = std::panic::AssertUnwindSafe(tool)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| Err(Error::Tool("tool executor panicked".into())));
                    (call, result)
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
                    let (call, output) = result.expect("active tool");
                    pending.remove(&call.id);
                    match output {
                        Ok(ToolOutput::Value(value)) => self.tool_result(&call, ToolStatus::Success, value)?,
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
        let settlements = settlement_refs(
            &self.journal.lib,
            &self.journal.session,
            self.journal.turn,
            Some(&call.id),
        )?;
        self.journal.append(Event::ToolFinished {
            result: ToolResult {
                call: call.id.clone(),
                status,
                output,
                settlements,
            },
        })
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
