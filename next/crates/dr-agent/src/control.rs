use crate::{Error, RequestId, Result, State};
use futures::{
    FutureExt,
    channel::{mpsc, oneshot},
    future::BoxFuture,
};
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

pub(crate) enum Action {
    Steer(String),
    Answer(RequestId, Value),
    Permission(RequestId, bool),
    Stop,
    Abort,
}

pub(crate) struct Command {
    pub action: Action,
    pub reply: oneshot::Sender<Result<()>>,
}

/// Requests are enqueued when a method is called. The returned future waits
/// for durable acknowledgement; dropping it does not withdraw the request.
#[derive(Clone)]
pub struct Control {
    pub(crate) sender: mpsc::UnboundedSender<Command>,
    pub(crate) cancel: Cancellation,
    pub(crate) state: Arc<Mutex<State>>,
}

impl Control {
    pub fn state(&self) -> State {
        *self.state.lock().expect("runtime state")
    }

    fn request(&self, action: Action) -> Result<oneshot::Receiver<Result<()>>> {
        let (tx, rx) = oneshot::channel();
        let aborting = matches!(action, Action::Abort);
        self.sender
            .unbounded_send(Command { action, reply: tx })
            .map_err(|_| Error::Closed)?;
        if aborting {
            self.cancel.cancel();
        }
        Ok(rx)
    }

    fn send(&self, action: Action) -> BoxFuture<'static, Result<()>> {
        // Enqueue immediately without any lock shared with journal/holder
        // work. Polling the returned future only waits for the durable ACK.
        let reply = self.request(action);
        async move { reply?.await.map_err(|_| Error::Closed)? }.boxed()
    }

    /// Acknowledged only after the steering text is durably journaled.
    pub fn steer(&self, text: impl Into<String>) -> BoxFuture<'static, Result<()>> {
        self.send(Action::Steer(text.into()))
    }
    pub fn answer(&self, request: RequestId, answer: Value) -> BoxFuture<'static, Result<()>> {
        self.send(Action::Answer(request, answer))
    }
    pub fn permit(&self, request: RequestId, allow: bool) -> BoxFuture<'static, Result<()>> {
        self.send(Action::Permission(request, allow))
    }
    pub fn stop_after_tool(&self) -> BoxFuture<'static, Result<()>> {
        self.send(Action::Stop)
    }

    /// Immediately signals the driver and tools. An entered write must still
    /// settle; `join` is the boundary after which no tool can keep writing.
    pub fn abort(&self) -> BoxFuture<'static, Result<()>> {
        self.send(Action::Abort)
    }
}

pub struct RunHandle {
    pub session: String,
    pub control: Control,
    pub(crate) finished: Option<oneshot::Receiver<Result<State>>>,
}

impl RunHandle {
    pub async fn finish(mut self) -> Result<State> {
        self.finished
            .take()
            .expect("run completion")
            .await
            .map_err(|_| Error::Closed)?
    }
    pub fn join(self) -> Result<State> {
        futures::executor::block_on(self.finish())
    }
}

impl Drop for RunHandle {
    fn drop(&mut self) {
        // An abandoned handle must not leave a worker waiting forever for
        // an answer while holding the library. Writes still settle normally.
        let _ = self.control.request(Action::Abort);
    }
}
