use crate::{Error, RequestId, Result, State};
use futures::channel::{mpsc, oneshot};
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

#[derive(Clone)]
pub struct Control {
    pub(crate) sender: mpsc::UnboundedSender<Command>,
    pub(crate) cancel: Cancellation,
    pub(crate) state: Arc<Mutex<State>>,
    pub(crate) accepting: Arc<Mutex<bool>>,
}

impl Control {
    pub fn state(&self) -> State {
        *self.state.lock().expect("runtime state")
    }

    fn request(&self, action: Action) -> Result<oneshot::Receiver<Result<()>>> {
        let (tx, rx) = oneshot::channel();
        {
            let accepting = self.accepting.lock().expect("control mailbox");
            if !*accepting {
                return Err(Error::Closed);
            }
            let aborting = matches!(action, Action::Abort);
            self.sender
                .unbounded_send(Command { action, reply: tx })
                .map_err(|_| Error::Closed)?;
            if aborting {
                self.cancel.cancel();
            }
        }
        Ok(rx)
    }

    async fn send(&self, action: Action) -> Result<()> {
        self.request(action)?.await.map_err(|_| Error::Closed)?
    }

    /// Acknowledged only after the steering text is durably journaled.
    pub async fn steer(&self, text: impl Into<String>) -> Result<()> {
        self.send(Action::Steer(text.into())).await
    }
    pub async fn answer(&self, request: RequestId, answer: Value) -> Result<()> {
        self.send(Action::Answer(request, answer)).await
    }
    pub async fn permit(&self, request: RequestId, allow: bool) -> Result<()> {
        self.send(Action::Permission(request, allow)).await
    }
    pub async fn stop_after_tool(&self) -> Result<()> {
        self.send(Action::Stop).await
    }

    /// Immediately signals the driver and tools. An entered write must still
    /// settle; `join` is the boundary after which no tool can keep writing.
    pub async fn abort(&self) -> Result<()> {
        self.send(Action::Abort).await
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
