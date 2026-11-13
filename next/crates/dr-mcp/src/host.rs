//! The open book is an application selection, never an argument supplied by
//! an external client. Publishing a new selection freezes old scopes first.
//!
//! The application adapter attaches a [`Backend`]: the scope opener of the
//! Agent controller and the catalog source of the same `AgentTools` chat
//! uses. Listing reads that catalog directly; it opens no scope.

use std::{
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use dr_agent::{ExternalScope, ExternalStart};
use dr_agent_tools::catalog::Catalog;
use dr_model::id::BookId;
use dr_workspace::{Subscription, Workspace, WsEvent};
use futures::{FutureExt as _, channel::oneshot, future::BoxFuture};
use tokio::{runtime::Handle, sync::watch};

use crate::Result;

/// Book edits arriving within this window are compared once.
const SETTLE: Duration = Duration::from_millis(150);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub book: Option<BookId>,
    pub epoch: u64,
}

/// The application adapter performs the controller's synchronous opening on
/// a worker. It must use the same controller as the in-app conversations.
pub type ScopeOpener =
    Arc<dyn Fn(ExternalStart) -> BoxFuture<'static, Result<ExternalScope>> + Send + Sync>;

/// The book's tool catalog, read on a worker from the same `AgentTools`
/// (and so the same cache) the in-app Agent uses, under the controller's
/// read lease so a library release waits for it.
pub type CatalogSource =
    Arc<dyn Fn(BookId) -> BoxFuture<'static, Result<Arc<Catalog>>> + Send + Sync>;

/// What a library's Agent controller lends the MCP endpoint.
#[derive(Clone)]
pub struct Backend {
    pub opener: ScopeOpener,
    pub catalog: CatalogSource,
}

struct State {
    selection: Selection,
    backend: Option<Backend>,
    scopes: Vec<ExternalScope>,
    /// The open book's catalog as last read in this selection epoch: what
    /// clients may have listed. A different one is an in-book change.
    known: Option<(u64, Arc<Catalog>)>,
    /// Catalog reads started, and the latest one whose result was compared:
    /// a read that started earlier but finished later is older news.
    reads: u64,
    compared: u64,
}

struct Inner {
    state: Mutex<State>,
    changed: watch::Sender<Selection>,
    /// Counts in-book catalog changes; selection changes are `changed`.
    catalogs: watch::Sender<u64>,
    settling: AtomicBool,
    reactor: Handle,
}

#[derive(Clone)]
pub struct Host(Arc<Inner>);

impl Host {
    pub fn new(reactor: Handle) -> Self {
        let (changed, _) = watch::channel(Selection::default());
        let (catalogs, _) = watch::channel(0);
        Self(Arc::new(Inner {
            state: Mutex::new(State {
                selection: Selection::default(),
                backend: None,
                scopes: Vec::new(),
                known: None,
                reads: 0,
                compared: 0,
            }),
            changed,
            catalogs,
            settling: AtomicBool::new(false),
            reactor,
        }))
    }

    pub fn selection(&self) -> Selection {
        self.0.changed.borrow().clone()
    }

    pub fn watch(&self) -> watch::Receiver<Selection> {
        self.0.changed.subscribe()
    }

    /// Changes to the open book's catalog within one selection epoch.
    pub fn catalog_changes(&self) -> watch::Receiver<u64> {
        self.0.catalogs.subscribe()
    }

    /// Attach a new library controller, or detach before library release.
    /// Closing each scope starts its independent worker cleanup immediately;
    /// the controller's release barrier also waits for these same scopes.
    pub fn replace(&self, book: Option<BookId>, backend: Option<Backend>) {
        let mut state = self.0.state.lock().expect("MCP host");
        state.backend = backend;
        let book = book.filter(|_| state.backend.is_some());
        self.publish(&mut state, book);
    }

    /// Called synchronously from the shell's active-book observation. Calls
    /// already entered may settle in their original book; queued calls are
    /// canceled before the new epoch becomes visible to the network worker.
    pub fn select(&self, book: Option<BookId>) {
        let mut state = self.0.state.lock().expect("MCP host");
        let book = book.filter(|_| state.backend.is_some());
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
        state.known = None;
        // send() would lose an update when there are no connected clients.
        self.0.changed.send_replace(state.selection.clone());
    }

    /// The open book's current catalog. A catalog that differs from the one
    /// last read in this epoch is announced to every connection.
    pub fn catalog(&self, book: &BookId, epoch: u64) -> BoxFuture<'static, Result<Arc<Catalog>>> {
        let (source, read) = {
            let mut state = self.0.state.lock().expect("MCP host");
            if state.selection.epoch != epoch || state.selection.book.as_ref() != Some(book) {
                return async { Err("the open book changed; list tools again".into()) }.boxed();
            }
            state.reads += 1;
            (
                state
                    .backend
                    .as_ref()
                    .map(|backend| backend.catalog.clone()),
                state.reads,
            )
        };
        let Some(source) = source else {
            return async { Err("no book is open".into()) }.boxed();
        };
        let host = self.clone();
        let book = book.clone();
        async move {
            let catalog = source(book.clone()).await?;
            host.observe(&book, epoch, read, &catalog);
            Ok(catalog)
        }
        .boxed()
    }

    fn observe(&self, book: &BookId, epoch: u64, read: u64, catalog: &Arc<Catalog>) {
        let mut state = self.0.state.lock().expect("MCP host");
        if state.selection.epoch != epoch
            || state.selection.book.as_ref() != Some(book)
            || read < state.compared
        {
            return;
        }
        state.compared = read;
        let changed = state
            .known
            .as_ref()
            .is_some_and(|(known, listed)| *known == epoch && !same_list(listed, catalog));
        state.known = Some((epoch, catalog.clone()));
        if changed {
            self.0.catalogs.send_modify(|generation| *generation += 1);
        }
    }

    /// Follow the library's book edits, so a change to the open book's
    /// templates or levels is announced without waiting for a client to
    /// call. Edits that leave the catalog as it was announce nothing; the
    /// comparison runs only while a client is connected. Drop the
    /// subscription before releasing the library.
    pub fn follow(&self, workspace: &Workspace) -> Subscription {
        let host = Arc::downgrade(&self.0);
        workspace.subscribe(move |event| {
            if let WsEvent::Book(changed) = event
                && let Some(host) = Weak::upgrade(&host)
            {
                Host(host).book_changed(&changed.book);
            }
        })
    }

    /// Runs on the committing thread: only schedules a later comparison.
    fn book_changed(&self, book: &BookId) {
        if self.0.changed.borrow().book.as_ref() != Some(book)
            || self.0.changed.receiver_count() == 0
            || self.0.settling.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let host = self.clone();
        self.0.reactor.spawn(async move {
            tokio::time::sleep(SETTLE).await;
            host.0.settling.store(false, Ordering::Release);
            let Selection { book, epoch } = host.selection();
            if let Some(book) = book {
                let _ = host.catalog(&book, epoch).await;
            }
        });
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
            state.backend.as_ref().map(|backend| backend.opener.clone())
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

/// Whether a client holding one list would see the other unchanged: names,
/// order, revisions, descriptions and action titles.
fn same_list(a: &Arc<Catalog>, b: &Arc<Catalog>) -> bool {
    Arc::ptr_eq(a, b)
        || (a.entries().len() == b.entries().len()
            && a.entries().iter().zip(b.entries()).all(|(a, b)| {
                a.name == b.name
                    && a.revision == b.revision
                    && a.description == b.description
                    && a.action.as_ref().map(|action| &action.display_name)
                        == b.action.as_ref().map(|action| &action.display_name)
            }))
}
