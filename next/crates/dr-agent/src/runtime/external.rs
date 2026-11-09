//! External tools share the chat scheduler but own no chat transcript.
//! A scope's dedicated worker owns the library; public handles never do.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use dr_model::id::{BookId, new_uuid_v7};
use dr_workspace::Actor;
use futures::{
    FutureExt, StreamExt,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Shared},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Inner, Runtime};
use crate::{
    Cancellation, Error, Result, SettlementRef, ToolCall, ToolContext, ToolDescriptor, ToolPolicy,
    ToolResult, ToolStatus, tools::ToolOutput,
};

mod journal;
#[cfg(test)]
mod tests;
use journal::Journal;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalStart {
    pub client_id: String,
    pub book: BookId,
    pub connection_epoch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExternalCall {
    pub name: String,
    pub arguments: Value,
    pub revision: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalState {
    Open,
    Closed,
    Stopped,
    Interrupted,
    Failed,
}

#[derive(Debug)]
pub struct RecoveredExternal {
    pub session: String,
    pub state: ExternalState,
    pub settlements: Vec<SettlementRef>,
}

type Completion = Shared<BoxFuture<'static, std::result::Result<(), String>>>;

#[derive(Clone)]
struct Cancel {
    token: Cancellation,
    wake: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}
impl Cancel {
    fn cancel(&self) {
        self.token.cancel();
        if let Some(send) = self.wake.lock().expect("external cancellation").take() {
            let _ = send.send(());
        }
    }
}

struct ScopeState {
    sender: Option<mpsc::UnboundedSender<Queued>>,
    calls: HashMap<String, Cancel>,
}

struct Scope {
    session: String,
    start: ExternalStart,
    state: Mutex<ScopeState>,
    completed: Completion,
}
impl Scope {
    fn freeze(&self) {
        let mut state = self.state.lock().expect("external scope");
        state.sender.take();
        for call in state.calls.values() {
            call.cancel();
        }
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        self.freeze();
    }
}

/// Clones contain only IDs, mailboxes and completion signals. Closing also
/// releases the worker's Runtime, including when no close future is polled.
#[derive(Clone)]
pub struct ExternalScope {
    inner: Arc<Scope>,
}

impl ExternalScope {
    pub fn session(&self) -> &str {
        &self.inner.session
    }
    pub fn book(&self) -> &BookId {
        &self.inner.start.book
    }
    pub fn connection_epoch(&self) -> u64 {
        self.inner.start.connection_epoch
    }
    pub fn is_closed(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("external scope")
            .sender
            .is_none()
    }
    /// Strong resources have been released, independently of whether a
    /// caller has awaited close. Useful for pruning an owner's registry.
    pub fn is_settled(&self) -> bool {
        self.inner.completed.clone().now_or_never().is_some()
    }

    /// Memory admission only; finish acknowledges durable settlement. Call
    /// IDs belong to the runtime, independent of an RPC peer's request IDs.
    pub fn call(&self, request: ExternalCall) -> Result<ExternalCallHandle> {
        self.call_checked(request, Arc::new(|| Ok(())))
    }

    /// The authority check is the entry linearization point, after waiting
    /// for the shared gate and persisting Started, immediately before execute.
    /// It must be a short memory-only check, never storage or network I/O.
    pub fn call_checked(
        &self,
        request: ExternalCall,
        guard: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    ) -> Result<ExternalCallHandle> {
        if self.is_closed() {
            return Err(Error::Closed);
        }
        if request.name.is_empty()
            || request.revision.is_empty()
            || serde_json::to_vec(&request)?.len() > journal::MAX_REQUEST
        {
            return Err(Error::Protocol("invalid or oversized external call".into()));
        }
        let id = new_uuid_v7();
        let (wake, cancelled) = oneshot::channel();
        let cancel = Cancel {
            token: Cancellation::default(),
            wake: Arc::new(Mutex::new(Some(wake))),
        };
        let (reply, result) = oneshot::channel();
        let mut state = self.inner.state.lock().expect("external scope");
        let sender = state.sender.as_ref().ok_or(Error::Closed)?;
        sender
            .unbounded_send(Queued {
                id: id.clone(),
                request,
                cancel: cancel.clone(),
                cancelled,
                guard,
                reply,
            })
            .map_err(|_| Error::Closed)?;
        state.calls.insert(id.clone(), cancel.clone());
        Ok(ExternalCallHandle {
            id,
            cancel,
            result: Some(result),
        })
    }

    /// Freeze and cancel now. The dedicated worker settles even when this
    /// future is dropped; awaiting it additionally reports journal failure.
    pub fn close(&self) -> BoxFuture<'static, Result<()>> {
        self.inner.freeze();
        let completed = self.inner.completed.clone();
        async move { completed.await.map_err(Error::Protocol) }.boxed()
    }
}

pub struct ExternalCallHandle {
    id: String,
    cancel: Cancel,
    result: Option<oneshot::Receiver<Result<ToolResult>>>,
}
impl ExternalCallHandle {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
    pub fn finish(mut self) -> BoxFuture<'static, Result<ToolResult>> {
        async move {
            self.result
                .take()
                .expect("external result")
                .await
                .map_err(|_| Error::Closed)?
        }
        .boxed()
    }
}
impl Drop for ExternalCallHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct Queued {
    id: String,
    request: ExternalCall,
    cancel: Cancel,
    cancelled: oneshot::Receiver<()>,
    guard: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    reply: oneshot::Sender<Result<ToolResult>>,
}

impl Runtime {
    /// Background initialization; never called on the UI thread. Every wire
    /// connection/selection epoch obtains an independent read-authority session.
    pub fn open_external(&self, start: ExternalStart) -> Result<ExternalScope> {
        let _lifecycle = self.inner.lifecycle.lock().expect("runtime lifecycle");
        if start.client_id.is_empty() || start.client_id.len() > 256 {
            return Err(Error::Protocol(
                "external client id must be 1–256 bytes".into(),
            ));
        }
        let session = new_uuid_v7();
        let journal = Journal::create(
            self.inner.ws.library().clone(),
            session.clone(),
            start.clone(),
        )?;
        let (sender, incoming) = mpsc::unbounded();
        let (finished, receive) = oneshot::channel();
        let completed = async move {
            receive
                .await
                .map_err(|_| "external worker disappeared".to_owned())?
        }
        .boxed()
        .shared();
        let scope = Arc::new(Scope {
            session: session.clone(),
            start,
            completed,
            state: Mutex::new(ScopeState {
                sender: Some(sender),
                calls: HashMap::new(),
            }),
        });
        let weak = Arc::downgrade(&scope);
        let inner = self.inner.clone();
        self.inner
            .external_active
            .lock()
            .expect("external sessions")
            .insert(session.clone());
        let worker_session = session.clone();
        let spawned = std::thread::Builder::new()
            .name("dr-agent-external".into())
            .spawn(move || {
                let mut worker = Worker {
                    inner,
                    journal,
                    scope: weak,
                    incoming,
                    stopped: false,
                };
                let result = futures::executor::block_on(
                    std::panic::AssertUnwindSafe(worker.run()).catch_unwind(),
                )
                .unwrap_or_else(|_| Err(Error::Tool("external worker panicked".into())));
                if let Some(scope) = worker.scope.upgrade() {
                    scope.freeze();
                }
                // On reconciliation/disk failure leave an open header for
                // startup recovery; never hide missing results behind Failed.
                if result.is_err()
                    && worker.journal.header.state == ExternalState::Open
                    && worker.journal.reconcile().is_ok()
                {
                    let _ = worker.journal.close(ExternalState::Failed);
                }
                worker.inner.tools.finish_session(&worker_session);
                worker
                    .inner
                    .external_active
                    .lock()
                    .expect("external sessions")
                    .remove(&worker_session);
                drop(worker); // Workspace and Runtime must precede completion.
                let _ = finished.send(result.map_err(|error| error.to_string()));
            });
        if let Err(error) = spawned {
            self.inner
                .external_active
                .lock()
                .expect("external sessions")
                .remove(&session);
            return Err(Error::Protocol(error.to_string()));
        }
        Ok(ExternalScope { inner: scope })
    }

    /// Close orphaned audits from receipts only. No tools, permissions or
    /// conversation projection are replayed, and terminal headers stay put.
    pub fn recover_external(&self) -> Result<Vec<RecoveredExternal>> {
        let _lifecycle = self.inner.lifecycle.lock().expect("runtime lifecycle");
        let mut recovered = Vec::new();
        for row in self
            .inner
            .ws
            .library()
            .local_entries(journal::SESSIONS, None)?
        {
            let mut journal = Journal::open(self.inner.ws.library().clone(), &row.value)?;
            if journal.header.session != row.key {
                return Err(Error::Protocol("external header key mismatch".into()));
            }
            if journal.header.state != ExternalState::Open
                || self
                    .inner
                    .external_active
                    .lock()
                    .expect("external sessions")
                    .contains(&row.key)
            {
                continue;
            }
            let settlements = journal.reconcile()?;
            journal.close(ExternalState::Interrupted)?;
            recovered.push(RecoveredExternal {
                session: row.key,
                state: ExternalState::Interrupted,
                settlements,
            });
        }
        Ok(recovered)
    }
}

struct Worker {
    inner: Arc<Inner>,
    journal: Journal,
    scope: Weak<Scope>,
    incoming: mpsc::UnboundedReceiver<Queued>,
    stopped: bool,
}

impl Worker {
    async fn run(&mut self) -> Result<()> {
        while let Some(mut queued) = self.incoming.next().await {
            let id = queued.id.clone();
            let outcome = self.execute(&mut queued).await;
            if let Some(scope) = self.scope.upgrade() {
                scope
                    .state
                    .lock()
                    .expect("external scope")
                    .calls
                    .remove(&id);
            }
            match outcome {
                Ok(result) => {
                    let _ = queued.reply.send(Ok(result));
                }
                Err(error) => {
                    let message = error.to_string();
                    let _ = queued.reply.send(Err(error));
                    return Err(Error::Tool(message));
                }
            }
        }
        self.journal.close(if self.stopped {
            ExternalState::Stopped
        } else {
            ExternalState::Closed
        })
    }

    fn descriptor(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        self.inner
            .descriptors
            .iter()
            .any(|d| d.name == call.name)
            .then(|| {
                self.inner.tools.describe_in_book(
                    &self.inner.ws,
                    &self.journal.header.start.book,
                    call,
                )
            })
            .flatten()
    }

    async fn execute(&mut self, queued: &mut Queued) -> Result<ToolResult> {
        let call = ToolCall {
            id: queued.id.clone(),
            name: queued.request.name.clone(),
            arguments: queued.request.arguments.clone(),
        };
        let descriptor = self.descriptor(&call);
        self.journal.event(json!({"kind":"accepted","call":call.id,"request":queued.request,
            "access":descriptor.as_ref().map(|d|d.access),"policy":descriptor.as_ref().map(|d|d.policy)}))?;
        let mut result = ToolResult {
            call: call.id.clone(),
            status: ToolStatus::Cancelled,
            output: Value::Null,
            settlements: Vec::new(),
        };
        if queued.cancel.token.is_cancelled() {
            self.journal.finish(&result)?;
            return Ok(result);
        }
        let Some(descriptor) = descriptor
            .filter(|d| d.revision == queued.request.revision && d.policy == ToolPolicy::Local)
        else {
            result.status = ToolStatus::Error;
            result.output =
                json!({"error":"unknown, changed, or permission-requiring external tool"});
            self.journal.finish(&result)?;
            return Ok(result);
        };
        let gate = self.inner.tool_gate.clone();
        // The cancellation receiver is polled by reference while a call waits
        // for the shared scheduler. Entered tools are always fully awaited.
        let acquire = gate.lock().fuse();
        futures::pin_mut!(acquire);
        let guard = futures::select_biased! {
            _ = (&mut queued.cancelled).fuse() => {
                self.journal.finish(&result)?;
                return Ok(result);
            },
            guard = acquire => guard,
        };
        if queued.cancel.token.is_cancelled() {
            self.journal.finish(&result)?;
            return Ok(result);
        }
        if self
            .inner
            .tools
            .describe_in_book(&self.inner.ws, &self.journal.header.start.book, &call)
            .as_ref()
            != Some(&descriptor)
        {
            result.status = ToolStatus::Error;
            result.output = json!({"error":"tool definition changed; request it again"});
        } else {
            self.journal
                .event(json!({"kind":"started","call":call.id}))?;
            if queued.cancel.token.is_cancelled() {
                self.journal.finish(&result)?;
                return Ok(result);
            }
            if let Err(error) = (queued.guard)() {
                result.status = ToolStatus::Error;
                result.output = json!({"error":error.to_string()});
                self.journal.finish(&result)?;
                return Ok(result);
            }
            let (lease, released) = self.inner.executions.enter_with_completion();
            let context = ToolContext {
                book: self.journal.header.start.book.clone(),
                actor: Actor::agent(&self.journal.header.session, 1, &call.id),
                cancellation: queued.cancel.token.clone(),
                workspace: self.inner.ws.clone(),
                access: descriptor.access,
                descriptor,
                _execution: lease,
            };
            let output = std::panic::AssertUnwindSafe(async {
                self.inner.tools.execute(context, call).await
            })
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(Error::Tool("external executor panicked".into())));
            released.await?;
            match output {
                Ok(ToolOutput::Value(value)) => {
                    result.status = ToolStatus::Success;
                    result.output = value;
                }
                Ok(ToolOutput::Error(value)) => {
                    result.status = ToolStatus::Error;
                    result.output = value;
                }
                Ok(ToolOutput::Stop(value)) => {
                    result.status = ToolStatus::Error;
                    result.output = value;
                    self.stopped = true;
                    if let Some(scope) = self.scope.upgrade() {
                        scope.freeze();
                    }
                }
                Ok(ToolOutput::Question(_)) => {
                    result.status = ToolStatus::Error;
                    result.output = json!({"error":"external scopes cannot ask the author"});
                }
                Err(error) => {
                    result.status = ToolStatus::Error;
                    result.output = json!({"error":error.to_string()});
                }
            }
        }
        result.settlements = super::settlement_refs(
            &self.journal.lib,
            &self.journal.header.session,
            1,
            Some(&result.call),
        )?;
        self.journal.finish(&result)?;
        drop(guard);
        Ok(result)
    }
}
