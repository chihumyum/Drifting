//! Accepted shelf work owns its library until the worker really finishes.
use dr_workspace::Workspace;
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use std::sync::{Arc, Mutex};
#[derive(Clone, Default)]
pub(crate) struct Jobs(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    active: usize,
    waiters: Vec<oneshot::Sender<()>>,
}
pub(crate) struct Lease {
    library: Option<Workspace>,
    jobs: Jobs,
}
impl std::ops::Deref for Lease {
    type Target = Workspace;
    fn deref(&self) -> &Workspace {
        self.library.as_ref().expect("active shelf lease")
    }
}
impl Jobs {
    pub fn enter(&self, library: Workspace) -> Lease {
        self.0.lock().expect("shelf jobs").active += 1;
        Lease {
            library: Some(library),
            jobs: self.clone(),
        }
    }
    pub fn drained(&self) -> BoxFuture<'static, Result<(), String>> {
        let mut state = self.0.lock().expect("shelf jobs");
        if state.active == 0 {
            return async { Ok(()) }.boxed();
        }
        let (tx, rx) = oneshot::channel();
        state.waiters.push(tx);
        async {
            rx.await
                .map_err(|_| "shelf worker barrier disappeared".into())
        }
        .boxed()
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        // Release the workspace before acknowledging the last worker.
        self.library.take();
        let mut state = self.jobs.0.lock().expect("shelf jobs");
        state.active -= 1;
        if state.active == 0 {
            for tx in std::mem::take(&mut state.waiters) {
                let _ = tx.send(());
            }
        }
    }
}
