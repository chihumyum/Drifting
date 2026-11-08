//! The open book is an application selection, never an argument supplied by
//! an external client. Publishing a new selection freezes old scopes first.

use std::sync::{Arc, Mutex};

use dr_agent::{ExternalScope, ExternalStart};
use dr_model::id::BookId;
use futures::{FutureExt as _, channel::oneshot, future::BoxFuture};
use tokio::{runtime::Handle, sync::watch};

use crate::Result;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub book: Option<BookId>,
    pub epoch: u64,
}

/// The application adapter performs the controller's synchronous opening on
/// a worker. It must use the same controller as the in-app conversations.
pub type ScopeOpener =
    Arc<dyn Fn(ExternalStart) -> BoxFuture<'static, Result<ExternalScope>> + Send + Sync>;

struct State {
    selection: Selection,
    opener: Option<ScopeOpener>,
    scopes: Vec<ExternalScope>,
}

struct Inner {
    state: Mutex<State>,
    changed: watch::Sender<Selection>,
    reactor: Handle,
}

#[derive(Clone)]
pub struct Host(Arc<Inner>);

impl Host {
    pub fn new(reactor: Handle) -> Self {
        let (changed, _) = watch::channel(Selection::default());
        Self(Arc::new(Inner {
            state: Mutex::new(State {
                selection: Selection::default(),
                opener: None,
                scopes: Vec::new(),
            }),
            changed,
            reactor,
        }))
    }

    pub fn selection(&self) -> Selection {
        self.0.changed.borrow().clone()
    }

    pub fn watch(&self) -> watch::Receiver<Selection> {
        self.0.changed.subscribe()
    }

    /// Attach a new library controller, or detach before library release.
    /// Closing each scope starts its independent worker cleanup immediately;
    /// the controller's release barrier also waits for these same scopes.
    pub fn replace(&self, book: Option<BookId>, opener: Option<ScopeOpener>) {
        let mut state = self.0.state.lock().expect("MCP host");
        state.opener = opener;
        let book = book.filter(|_| state.opener.is_some());
        self.publish(&mut state, book);
    }

    /// Called synchronously from the shell's active-book observation. Calls
    /// already entered may settle in their original book; queued calls are
    /// canceled before the new epoch becomes visible to the network worker.
    pub fn select(&self, book: Option<BookId>) {
        let mut state = self.0.state.lock().expect("MCP host");
        let book = book.filter(|_| state.opener.is_some());
        if state.selection.book != book {
            self.publish(&mut state, book);
        }
    }

    pub fn suspend(&self) {
        self.replace(None, None);
    }

    fn publish(&self, state: &mut State, book: Option<BookId>) {
        for scope in state.scopes.drain(..) {
            // close() freezes and starts cleanup before returning its waiter.
            drop(scope.close());
        }
        state.selection.epoch += 1;
        state.selection.book = book;
        // send() would lose an update when there are no connected clients.
        self.0.changed.send_replace(state.selection.clone());
    }

    /// Opening continues independently of the request future. A canceled
    /// caller cannot abandon a scope created after its connection went away.
    pub fn open_external(&self, start: ExternalStart) -> BoxFuture<'static, Result<ExternalScope>> {
        let opener = {
            let state = self.0.state.lock().expect("MCP host");
            if state.selection.epoch != start.connection_epoch
                || state.selection.book.as_ref() != Some(&start.book)
            {
                return async { Err("the open book changed; read the new book again".into()) }
                    .boxed();
            }
            state.opener.clone()
        };
        let Some(opener) = opener else {
            return async { Err("no book is open".into()) }.boxed();
        };
        let host = self.clone();
        let (send, receive) = oneshot::channel();
        let (claimed, claim) = oneshot::channel();
        self.0.reactor.spawn(async move {
            let epoch = start.connection_epoch;
            let book = start.book.clone();
            let scope = match opener(start).await {
                Ok(scope) => scope,
                Err(error) => {
                    let _ = send.send(Err(error));
                    return;
                }
            };
            let current = {
                let mut state = host.0.state.lock().expect("MCP host");
                if state.selection.epoch == epoch
                    && state.selection.book.as_ref() == Some(&book)
                    && scope.book() == &book
                    && scope.connection_epoch() == epoch
                {
                    state.scopes.retain(|scope| !scope.is_settled());
                    state.scopes.push(scope.clone());
                    true
                } else {
                    false
                }
            };
            if !current {
                let _ = scope.close().await;
                let _ = send.send(Err("the open book changed while connecting".into()));
                return;
            }
            if send.send(Ok(scope.clone())).is_err() || claim.await.is_err() {
                let _ = scope.close().await;
            }
        });
        async move {
            let scope = receive
                .await
                .map_err(|_| "MCP scope opening ended".to_owned())??;
            let _ = claimed.send(());
            Ok(scope)
        }
        .boxed()
    }
}
