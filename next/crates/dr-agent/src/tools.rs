//! Tool contract for M29. Parallelism is declared, never inferred from names.
//! Local writes run directly with the provided Actor. Only external plugins
//! and paid image tools request permission before entering the executor.

use crate::{Cancellation, Error, Question, Result, ToolAccess, ToolCall, ToolDescriptor};
use dr_model::id::BookId;
use dr_workspace::{Actor, Workspace};
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// A cancelled read future may have handed its context to a synchronous
/// worker. Keep library release separate from the model run's cancellation.
#[derive(Default)]
pub(crate) struct ToolExecutions(Mutex<ExecutionState>);

#[derive(Default)]
struct ExecutionState {
    active: usize,
    drained: Vec<oneshot::Sender<()>>,
}

impl ToolExecutions {
    pub(crate) fn enter(self: &Arc<Self>) -> Arc<ToolExecutionLease> {
        self.0.lock().expect("tool executions").active += 1;
        Arc::new(ToolExecutionLease {
            executions: self.clone(),
        })
    }

    pub(crate) fn drain(&self) -> BoxFuture<'static, Result<()>> {
        let mut state = self.0.lock().expect("tool executions");
        if state.active == 0 {
            return async { Ok(()) }.boxed();
        }
        let (send, receive) = oneshot::channel();
        state.drained.push(send);
        async move {
            receive
                .await
                .map_err(|_| Error::Tool("tool execution barrier ended early".into()))
        }
        .boxed()
    }
}

pub(crate) struct ToolExecutionLease {
    executions: Arc<ToolExecutions>,
}

impl Drop for ToolExecutionLease {
    fn drop(&mut self) {
        let mut state = self.executions.0.lock().expect("tool executions");
        state.active -= 1;
        if state.active == 0 {
            for waiter in std::mem::take(&mut state.drained) {
                let _ = waiter.send(());
            }
        }
    }
}

#[derive(Clone, Debug)]
pub enum ToolOutput {
    Value(Value),
    /// A structured tool failure the model can act on (for example, reread).
    Error(Value),
    /// Settle this result, then stop the turn without another model request.
    /// Used when a second CAS conflict requires the author to take over.
    Stop(Value),
    /// Pause this call. The author's answer becomes its result; execute is
    /// not invoked again (and cannot repeat side effects).
    Question(Question),
}

pub trait ToolExecutor: Send + Sync + 'static {
    fn descriptors(&self) -> Vec<ToolDescriptor>;
    /// Resolve a lazy call's actual access/policy without changing its wire
    /// envelope or opaque provider replay. The result is frozen at scheduling
    /// and rechecked immediately before execution.
    fn describe(&self, call: &ToolCall) -> Option<ToolDescriptor> {
        self.descriptors().into_iter().find(|d| d.name == call.name)
    }
    /// Discard per-run observations after entered tools and writes settle.
    fn finish_session(&self, _session: &str) {}
    /// Must yield promptly. For F3's synchronous commands use
    /// `context.workspace_call`, which performs the call on a worker.
    /// Write futures MUST finish only after all their effects have settled.
    /// Read futures must be side-effect-free and safe to drop on abort.
    /// Offloaded workers must retain their ToolContext (or a clone) until
    /// they finish using its workspace, even if the caller drops the future.
    /// Execute the exact `context.descriptor.revision`, or reject it. Plugin
    /// reloads must change that revision, including handler-only changes.
    fn execute(
        &self,
        context: ToolContext,
        call: ToolCall,
    ) -> BoxFuture<'static, Result<ToolOutput>>;
}

#[derive(Clone)]
pub struct ToolContext {
    pub book: BookId,
    pub actor: Actor,
    pub cancellation: Cancellation,
    pub descriptor: ToolDescriptor,
    pub(crate) workspace: Workspace,
    pub(crate) access: ToolAccess,
    // Keep this last: the context's Workspace must drop before a final lease
    // wakes a library-release waiter. Clones share the same execution lease.
    pub(crate) _execution: Arc<ToolExecutionLease>,
}

impl ToolContext {
    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }

    /// Runs the same command the UI runs. Never retries errors: a failed
    /// multi-document operation can already have committed effects.
    pub fn workspace_call(
        &self,
        name: impl Into<String>,
        input: Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let name = name.into();
        let cx = self.clone();
        async move {
            let spec = dr_workspace::registry()
                .get(&name)
                .ok_or_else(|| Error::Tool(format!("unknown command {name}")))?;
            if cx.access == ToolAccess::Read && !spec.is_query() {
                return Err(Error::Tool(
                    "a read tool cannot execute a write command".into(),
                ));
            }
            if let Some(book) = input.get("book").and_then(Value::as_str)
                && book != cx.book.as_str()
            {
                return Err(Error::Tool("command belongs to another book".into()));
            }
            if let Some(doc) = input.get("doc").and_then(Value::as_str) {
                let info = cx
                    .workspace
                    .library()
                    .doc_info(doc)?
                    .ok_or_else(|| Error::Tool("document is not stored".into()))?;
                if info.book_id.as_deref() != Some(cx.book.as_str()) {
                    return Err(Error::Tool("document belongs to another book".into()));
                }
            }
            let (tx, rx) = oneshot::channel();
            std::thread::Builder::new()
                .name("dr-agent-tool".into())
                .spawn(move || {
                    let result = if cx.cancellation.is_cancelled() {
                        Err(Error::Tool("cancelled before command entry".into()))
                    } else {
                        cx.workspace
                            .call(&cx.actor, &name, input)
                            .map_err(|e| Error::Tool(e.to_string()))
                    };
                    // Capture the whole context, not only its accessed fields:
                    // its execution lease must follow this worker as well.
                    drop(cx);
                    let _ = tx.send(result);
                })
                .map_err(|e| Error::Tool(e.to_string()))?;
            rx.await
                .map_err(|_| Error::Tool("command worker panicked".into()))?
        }
        .boxed()
    }
}
