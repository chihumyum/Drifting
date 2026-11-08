//! Library-scoped external MCP services. UI selection is never call authority.
mod catalog;
mod destination;
mod http;
mod stdio;
mod storage;
#[cfg(test)]
mod tests;
mod tracked;
mod types;

pub use types::*;

use std::{
    collections::BTreeMap,
    panic::AssertUnwindSafe,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use dr_agent::{ToolContext, tools::ToolOutput};
use dr_platform::secrets::SecretStore;
use dr_store::Library;
use futures::{
    FutureExt,
    channel::oneshot,
    future::{BoxFuture, Shared},
};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
    model::{CallToolRequestParams, CallToolResponse},
    service::{NotificationContext, RunningService},
    transport::{
        StreamableHttpClientTransport, common::client_side_sse::NeverRetry,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use tokio::{
    runtime::Handle,
    sync::{Mutex as AsyncMutex, Notify, watch},
};
use tokio_util::sync::CancellationToken;

use storage::Record;

#[derive(Clone)]
struct Resources {
    library: Library,
    secrets: Arc<SecretStore>,
}

#[derive(Clone)]
struct Slot {
    record: Record,
    connection: Arc<AsyncMutex<Option<Connection>>>,
    stale: Arc<AtomicBool>,
}

struct State {
    resources: Option<Resources>,
    selected: Option<String>,
    servers: BTreeMap<(String, String), Slot>,
    workers: usize,
    closing: bool,
    closed: bool,
    close_reply: Option<oneshot::Sender<crate::Result<()>>>,
}

struct Inner {
    runtime: Handle,
    epoch: String,
    state: Mutex<State>,
    configuration: AsyncMutex<()>,
    changed: watch::Sender<Snapshot>,
    drained: Notify,
    cancel: CancellationToken,
    closed: Shared<BoxFuture<'static, crate::Result<()>>>,
}

/// Clones are cheap handles. Completed close removes all strong Library
/// references even if UI or ToolExecutor clones are deliberately retained.
#[derive(Clone)]
pub struct Manager(Arc<Inner>);

struct Lease(Arc<Inner>);
impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().expect("MCP manager");
        state.workers -= 1;
        if state.workers == 0 {
            self.0.drained.notify_waiters();
        }
    }
}

#[derive(Clone)]
struct Fence {
    stale: Arc<AtomicBool>,
    manager: Weak<Inner>,
}
impl ClientHandler for Fence {
    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.stale.store(true, Ordering::SeqCst);
        if let Some(manager) = self.manager.upgrade() {
            Manager(manager).publish();
        }
    }
}

struct Connection {
    service: RunningService<RoleClient, Fence>,
    cleanup: Arc<tracked::Closed>,
}
impl Connection {
    async fn close(&mut self) -> crate::Result<()> {
        let service = self
            .service
            .close()
            .await
            .map(|_| ())
            .map_err(|_| "MCP service cleanup failed".to_owned());
        let process = self.cleanup.wait().await;
        service.and(process)
    }
}

impl Manager {
    pub fn new(library: Library, secrets: Arc<SecretStore>, runtime: Handle) -> Self {
        let (changed, _) = watch::channel(Snapshot::default());
        let (reply, receive) = oneshot::channel();
        let closed = async {
            receive
                .await
                .unwrap_or_else(|_| Err("MCP close ended early".into()))
        }
        .boxed()
        .shared();
        Self(Arc::new(Inner {
            runtime,
            epoch: uuid::Uuid::new_v4().to_string(),
            state: Mutex::new(State {
                resources: Some(Resources { library, secrets }),
                selected: None,
                servers: BTreeMap::new(),
                workers: 0,
                closing: false,
                closed: false,
                close_reply: Some(reply),
            }),
            configuration: AsyncMutex::new(()),
            changed,
            drained: Notify::new(),
            cancel: CancellationToken::new(),
            closed,
        }))
    }

    pub fn snapshot(&self) -> Snapshot {
        self.0.changed.borrow().clone()
    }
    pub fn watch(&self) -> watch::Receiver<Snapshot> {
        self.0.changed.subscribe()
    }
    pub fn is_closed(&self) -> bool {
        self.0.state.lock().expect("MCP manager").closing
    }

    fn project(state: &State) -> Snapshot {
        let servers = state
            .servers
            .iter()
            .filter(|((book, _), _)| Some(book) == state.selected.as_ref())
            .map(|(_, slot)| {
                let mut info = slot.record.info.clone();
                if info.status == Status::Ready && slot.stale.load(Ordering::SeqCst) {
                    info.status = Status::Disconnected;
                }
                info
            })
            .collect();
        Snapshot {
            book: state.selected.clone(),
            servers,
            closed: state.closing,
        }
    }

    fn publish(&self) {
        let state = self.0.state.lock().expect("MCP manager");
        self.0.changed.send_replace(Self::project(&state));
    }

    /// Register before returning the future. The returned value is an ACK,
    /// never ownership of the underlying I/O or cleanup worker.
    fn run<T, F, Fut>(&self, operation: F) -> BoxFuture<'static, crate::Result<T>>
    where
        T: Send + 'static,
        F: FnOnce(Manager, Resources) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = crate::Result<T>> + Send + 'static,
    {
        let resources = {
            let mut state = self.0.state.lock().expect("MCP manager");
            if state.closing {
                return async { Err("MCP manager is closing".into()) }.boxed();
            }
            state.workers += 1;
            state
                .resources
                .as_ref()
                .expect("live MCP resources")
                .clone()
        };
        let lease = Lease(self.0.clone());
        let manager = self.clone();
        let (reply, receive) = oneshot::channel();
        self.0.runtime.spawn(async move {
            let result = AssertUnwindSafe(operation(manager, resources))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err("MCP worker failed".into()));
            drop(lease);
            let _ = reply.send(result);
        });
        async {
            receive
                .await
                .unwrap_or_else(|_| Err("MCP worker ended early".into()))
        }
        .boxed()
    }

    async fn blocking<T: Send + 'static>(
        operation: impl FnOnce() -> crate::Result<T> + Send + 'static,
    ) -> crate::Result<T> {
        tokio::task::spawn_blocking(operation)
            .await
            .map_err(|_| "MCP local operation failed")?
    }

    fn slot(&self, book: &str, id: &str) -> crate::Result<Slot> {
        let state = self.0.state.lock().expect("MCP manager");
        if state.closing {
            return Err("MCP manager is closing".into());
        }
        state
            .servers
            .get(&(book.into(), id.into()))
            .cloned()
            .ok_or("MCP server is unavailable".into())
    }

    async fn close_slot(slot: Slot) -> crate::Result<()> {
        if let Some(mut connection) = slot.connection.lock().await.take() {
            connection.close().await?;
        }
        Ok(())
    }

    async fn load(&self, resources: &Resources, book: &str) -> crate::Result<Vec<ServerInfo>> {
        let guard = self.0.configuration.lock().await;
        let (library, owner) = (resources.library.clone(), book.to_owned());
        let records = Self::blocking(move || storage::list(&library, &owner)).await?;
        let mut previous = Vec::new();
        {
            let mut state = self.0.state.lock().expect("MCP manager");
            let ids: std::collections::HashSet<_> =
                records.iter().map(|r| r.info.id.clone()).collect();
            let removed: Vec<_> = state
                .servers
                .keys()
                .filter(|(b, id)| b == book && !ids.contains(id))
                .cloned()
                .collect();
            for key in removed {
                if let Some(old) = state.servers.remove(&key) {
                    previous.push(old);
                }
            }
            for mut record in records {
                let key = (book.to_owned(), record.info.id.clone());
                if state.servers.get(&key).is_some_and(|slot| {
                    slot.record.info.revision == record.info.revision
                        && slot.record.catalog_revision == record.catalog_revision
                }) {
                    continue;
                }
                record.info.status = if record.info.enabled {
                    Status::Disconnected
                } else {
                    Status::Disabled
                };
                catalog::bind(&self.0.epoch, book, &mut record);
                let slot = Slot {
                    record,
                    connection: Arc::new(AsyncMutex::new(None)),
                    stale: Arc::new(AtomicBool::new(false)),
                };
                if let Some(old) = state.servers.insert(key, slot) {
                    previous.push(old);
                }
            }
        }
        drop(guard);
        for slot in previous {
            Self::close_slot(slot).await?;
        }
        self.publish();
        Ok(self
            .0
            .state
            .lock()
            .expect("MCP manager")
            .servers
            .iter()
            .filter(|((b, _), _)| b == book)
            .map(|(_, slot)| slot.record.info.clone())
            .collect())
    }

    pub fn list(&self, book: String) -> BoxFuture<'static, crate::Result<Vec<ServerInfo>>> {
        self.run(move |manager, resources| async move { manager.load(&resources, &book).await })
    }

    pub fn activate(&self, book: Option<String>) -> BoxFuture<'static, crate::Result<()>> {
        {
            let mut state = self.0.state.lock().expect("MCP manager");
            if state.closing {
                return async { Err("MCP manager is closing".into()) }.boxed();
            }
            state.selected = book.clone();
        }
        self.publish();
        self.run(move |manager, resources| async move {
            if let Some(book) = book {
                let servers = manager.load(&resources, &book).await?;
                for info in servers {
                    if info.enabled && info.status != Status::Ready {
                        let _ = manager
                            .connect(&resources, &book, &info.id, &info.revision)
                            .await;
                    }
                }
            }
            Ok(())
        })
    }

    pub fn save(
        &self,
        book: String,
        draft: ServerDraft,
    ) -> BoxFuture<'static, crate::Result<ServerInfo>> {
        self.run(move |manager, resources| async move {
            let guard = manager.0.configuration.lock().await;
            // An entered call owns this connection until settlement. Freeze
            // that server's entry before committing a configuration replacement.
            let connection = draft.id.as_ref().and_then(|id| {
                manager
                    .0
                    .state
                    .lock()
                    .expect("MCP manager")
                    .servers
                    .get(&(book.clone(), id.clone()))
                    .map(|slot| slot.connection.clone())
            });
            let entered = match &connection {
                Some(connection) => Some(connection.lock().await),
                None => None,
            };
            let owner = book.clone();
            let io = resources.clone();
            let record =
                Self::blocking(move || storage::save(&io.library, &io.secrets, &owner, draft))
                    .await?;
            let id = record.info.id.clone();
            let revision = record.info.revision.clone();
            let enabled = record.info.enabled;
            let slot = Slot {
                record,
                connection: Arc::new(AsyncMutex::new(None)),
                stale: Arc::new(AtomicBool::new(false)),
            };
            let old = manager
                .0
                .state
                .lock()
                .expect("MCP manager")
                .servers
                .insert((book.clone(), id.clone()), slot);
            drop(entered);
            drop(guard);
            manager.publish();
            if let Some(old) = old {
                Self::close_slot(old).await?;
            }
            if enabled {
                let _ = manager.connect(&resources, &book, &id, &revision).await;
            }
            Ok(manager.slot(&book, &id)?.record.info)
        })
    }

    pub fn remove(
        &self,
        book: String,
        id: String,
        expected_revision: String,
    ) -> BoxFuture<'static, crate::Result<()>> {
        self.run(move |manager, resources| async move {
            let guard = manager.0.configuration.lock().await;
            let connection = manager
                .0
                .state
                .lock()
                .expect("MCP manager")
                .servers
                .get(&(book.clone(), id.clone()))
                .map(|slot| slot.connection.clone());
            let entered = match &connection {
                Some(connection) => Some(connection.lock().await),
                None => None,
            };
            let (owner, server) = (book.clone(), id.clone());
            let io = resources.clone();
            Self::blocking(move || {
                if let Some(old) =
                    storage::remove(&io.library, &owner, &server, &expected_revision)?
                {
                    storage::delete_secrets(&io.secrets, &storage::refs(&old));
                }
                Ok(())
            })
            .await?;
            let old = manager
                .0
                .state
                .lock()
                .expect("MCP manager")
                .servers
                .remove(&(book, id));
            drop(entered);
            drop(guard);
            manager.publish();
            if let Some(old) = old {
                Self::close_slot(old).await?;
            }
            Ok(())
        })
    }

    pub fn reconnect(
        &self,
        book: String,
        id: String,
        expected_revision: String,
    ) -> BoxFuture<'static, crate::Result<()>> {
        self.run(move |manager, resources| async move {
            manager.load(&resources, &book).await?;
            manager
                .connect(&resources, &book, &id, &expected_revision)
                .await
        })
    }

    fn update(
        &self,
        book: &str,
        id: &str,
        revision: &str,
        change: impl FnOnce(&mut Record),
    ) -> bool {
        let mut state = self.0.state.lock().expect("MCP manager");
        let Some(slot) = state
            .servers
            .get_mut(&(book.to_owned(), id.to_owned()))
            .filter(|slot| slot.record.info.revision == revision)
        else {
            return false;
        };
        change(&mut slot.record);
        self.0.changed.send_replace(Self::project(&state));
        true
    }

    async fn status(
        &self,
        resources: &Resources,
        book: &str,
        id: &str,
        revision: &str,
        status: Status,
    ) -> crate::Result<()> {
        let mut record = self.slot(book, id)?.record;
        if record.info.revision != revision {
            return Err("MCP configuration changed".into());
        }
        record.info.status = status.clone();
        let (library, owner, expected) = (
            resources.library.clone(),
            book.to_owned(),
            revision.to_owned(),
        );
        let result =
            Self::blocking(move || storage::put(&library, &owner, &record, Some(&expected))).await;
        self.update(book, id, revision, |r| r.info.status = status);
        result
    }

    async fn connect(
        &self,
        resources: &Resources,
        book: &str,
        id: &str,
        expected: &str,
    ) -> crate::Result<()> {
        let slot = self.slot(book, id)?;
        if slot.record.info.revision != expected {
            return Err("MCP configuration changed; reload before reconnecting".into());
        }
        if !slot.record.info.enabled {
            return Err("MCP server is disabled".into());
        }
        let mut current = slot.connection.lock().await;
        if let Some(mut connection) = current.take() {
            connection.close().await?;
        }
        if self.0.cancel.is_cancelled() {
            return Err("MCP manager is closing".into());
        }
        self.status(resources, book, id, expected, Status::Connecting)
            .await?;
        slot.stale.store(false, Ordering::SeqCst);
        let (store, config) = (
            resources.secrets.clone(),
            slot.record.info.transport.clone(),
        );
        let values = Self::blocking(move || storage::materialize(&store, &config)).await;
        let opened=async {
            let values=values?;
            let fence=Fence {stale:slot.stale.clone(),manager:Arc::downgrade(&self.0)};
            let mut connection=match &slot.record.info.transport {
                TransportConfig::Stdio{command,args,cwd,..}=> {
                    let (transport,_process)=stdio::spawn(command,args,cwd.as_deref(),&values,self.0.runtime.clone()).await?;
                    let (transport,cleanup)=tracked::Tracked::new(transport,self.0.runtime.clone());
                    let result=tokio::select! {
                        _=self.0.cancel.cancelled()=>Err("MCP connection cancelled".to_owned()),
                        result=tokio::time::timeout(Duration::from_secs(60),fence.serve(transport))=>result.map_err(|_|"MCP initialization timed out".to_owned()).and_then(|r|r.map_err(|_|"MCP initialization failed".to_owned())),
                    };
                    match result {Ok(service)=>Connection {service,cleanup:cleanup.clone()},Err(error)=>{cleanup.wait().await?;return Err(error);}}
                },
                TransportConfig::Http{url,..}=> {
                    let client=http::Http::new(url)?;
                    let mut config=StreamableHttpClientTransportConfig::with_uri(client.endpoint()).custom_headers(http::headers(&values)?).max_concurrent_requests(1).max_sse_event_size(http::RESPONSE_LIMIT).reinit_on_expired_session(false);
                    config.retry_config=Arc::new(NeverRetry::default());
                    let transport=StreamableHttpClientTransport::with_client(client,config);
                    let (transport,cleanup)=tracked::Tracked::new(transport,self.0.runtime.clone());
                    let result=tokio::select! {
                        _=self.0.cancel.cancelled()=>Err("MCP connection cancelled".to_owned()),
                        result=tokio::time::timeout(Duration::from_secs(60),fence.serve(transport))=>result.map_err(|_|"MCP initialization timed out".to_owned()).and_then(|r|r.map_err(|_|"MCP initialization failed".to_owned())),
                    };
                    match result {Ok(service)=>Connection {service,cleanup:cleanup.clone()},Err(error)=>{cleanup.wait().await?;return Err(error);}}
                },
            };
            connection.service.peer().set_response_cache_config(rmcp::service::ClientCacheConfig::disabled()).await;
            let tools=tokio::select! {
                _=self.0.cancel.cancelled()=>Err("MCP discovery cancelled".to_owned()),
                result=tokio::time::timeout(Duration::from_secs(60),catalog::discover(&connection))=>result.map_err(|_|"MCP tool discovery timed out".to_owned()).and_then(|r|r),
            };
            match tools {
                Ok(tools) if !slot.stale.load(Ordering::SeqCst)=>Ok((connection,tools)),
                result=>{connection.close().await?;Err(result.err().unwrap_or_else(||"MCP catalog changed during discovery".into()))},
            }
        }.await;
        match opened {
            Ok((mut connection, tools)) => {
                let mut record = slot.record.clone();
                record.info.tools = tools;
                record.info.status = Status::Ready;
                record.catalog_revision = uuid::Uuid::new_v4().to_string();
                catalog::bind(&self.0.epoch, book, &mut record);
                let (library, owner, saved, expected_revision) = (
                    resources.library.clone(),
                    book.to_owned(),
                    record.clone(),
                    expected.to_owned(),
                );
                let persisted = Self::blocking(move || {
                    storage::put(&library, &owner, &saved, Some(&expected_revision))
                })
                .await;
                if persisted.is_err()
                    || self.0.cancel.is_cancelled()
                    || !self.update(book, id, &record.info.revision, |r| *r = record.clone())
                {
                    connection.close().await?;
                    let error = persisted
                        .err()
                        .unwrap_or_else(|| "MCP connection became stale".into());
                    let _ = self
                        .status(
                            resources,
                            book,
                            id,
                            expected,
                            Status::Failed {
                                message: error.clone(),
                            },
                        )
                        .await;
                    return Err(error);
                }
                *current = Some(connection);
                Ok(())
            }
            Err(error) => {
                let _ = self
                    .status(
                        resources,
                        book,
                        id,
                        expected,
                        Status::Failed {
                            message: error.clone(),
                        },
                    )
                    .await;
                Err(error)
            }
        }
    }

    /// Freeze synchronously, then independently abort/drain all workers and
    /// transports. Dropping this ACK never stops the release operation.
    pub fn begin_close(&self) -> BoxFuture<'static, crate::Result<()>> {
        let start = {
            let mut state = self.0.state.lock().expect("MCP manager");
            let start = !state.closing;
            state.closing = true;
            start
        };
        if start {
            self.0.cancel.cancel();
            self.publish();
            let manager = self.clone();
            self.0.runtime.spawn(async move {
                loop {
                    let notified = manager.0.drained.notified();
                    if manager.0.state.lock().expect("MCP manager").workers == 0 {
                        break;
                    }
                    notified.await;
                }
                let slots =
                    std::mem::take(&mut manager.0.state.lock().expect("MCP manager").servers);
                let mut result = Ok(());
                for (_, slot) in slots {
                    if let Err(error) = Self::close_slot(slot).await {
                        result = Err(error);
                    }
                }
                let reply = {
                    let mut state = manager.0.state.lock().expect("MCP manager");
                    state.resources.take();
                    state.closed = true;
                    state.close_reply.take()
                };
                manager.publish();
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            });
        }
        self.0.closed.clone().boxed()
    }

    pub(crate) fn descriptor(
        &self,
        server: &str,
        tool: &str,
        revision: &str,
    ) -> Option<(String, RemoteTool)> {
        let state = self.0.state.lock().expect("MCP manager");
        if state.closing {
            return None;
        }
        state
            .servers
            .iter()
            .filter(|((_, id), slot)| {
                id == server
                    && slot.record.info.enabled
                    && slot.record.info.status == Status::Ready
                    && !slot.stale.load(Ordering::SeqCst)
            })
            .find_map(|((book, _), slot)| {
                slot.record
                    .info
                    .tools
                    .iter()
                    .find(|t| t.name == tool && t.revision == revision)
                    .cloned()
                    .map(|tool| (book.clone(), tool))
            })
    }

    pub(crate) fn search(
        &self,
        book: &str,
        query: &str,
        server: Option<&str>,
        limit: usize,
    ) -> Value {
        let state = self.0.state.lock().expect("MCP manager");
        let query = query.to_lowercase();
        let mut results = Vec::new();
        for ((owner, id), slot) in &state.servers {
            if owner != book
                || server.is_some_and(|wanted| wanted != id)
                || !slot.record.info.enabled
            {
                continue;
            }
            for tool in &slot.record.info.tools {
                if !query.is_empty()
                    && !tool.name.to_lowercase().contains(&query)
                    && !tool.description.to_lowercase().contains(&query)
                {
                    continue;
                }
                results.push(json!({"server":id,"server_name":slot.record.info.name,"tool":tool.name,"description":tool.description,"input_schema":tool.input_schema,"revision":tool.revision,"available":!state.closing && slot.record.info.status==Status::Ready && !slot.stale.load(Ordering::SeqCst)}));
            }
        }
        let total = results.len();
        results.truncate(limit.min(50));
        json!({"tools":results,"total":total})
    }

    // Deliberately crate-private: ToolExecutor is the only remote-call entry.
    pub(crate) fn call(
        &self,
        context: ToolContext,
        server: String,
        tool: String,
        revision: String,
        arguments: Value,
    ) -> BoxFuture<'static, crate::Result<ToolOutput>> {
        self.run(move |manager, resources| async move {
            let book = context.book.to_string();
            let result = manager
                .call_inner(
                    &resources, &context, &book, &server, &tool, &revision, arguments,
                )
                .await;
            drop(context);
            result
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn call_inner(
        &self,
        resources: &Resources,
        context: &ToolContext,
        book: &str,
        server: &str,
        tool: &str,
        revision: &str,
        arguments: Value,
    ) -> crate::Result<ToolOutput> {
        if context.descriptor.revision != revision
            || context.descriptor.policy != dr_agent::ToolPolicy::ExternalPlugin
            || context.descriptor.access != dr_agent::ToolAccess::Write
        {
            return Err("MCP approval does not match this call".into());
        }
        let args = arguments
            .as_object()
            .ok_or("MCP arguments must be an object")?
            .clone();
        let slot = self.slot(book, server)?;
        let mut connection = slot.connection.lock().await;
        let (library, owner, id) = (
            resources.library.clone(),
            book.to_owned(),
            server.to_owned(),
        );
        let stored = Self::blocking(move || storage::read(&library, &owner, &id)).await?;
        if !stored.is_some_and(|r| {
            r.info.revision == slot.record.info.revision
                && r.catalog_revision == slot.record.catalog_revision
        }) {
            return Err("MCP configuration or catalog changed".into());
        }
        if context.cancellation.is_cancelled() {
            return Err("MCP call cancelled before entry".into());
        }
        if self
            .descriptor(server, tool, revision)
            .as_ref()
            .is_none_or(|(owner, _)| owner != book)
        {
            return Err("MCP approval became stale".into());
        }
        let Some(active) = connection.as_mut() else {
            return Err("MCP server is disconnected; reconnect before calling".into());
        };
        let params = CallToolRequestParams::new(tool.to_owned()).with_arguments(args);
        let cancelled = async {
            while !context.cancellation.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        let result = tokio::select! {
            _=self.0.cancel.cancelled()=>Err("MCP connection closed; remote outcome is unknown".to_owned()),
            _=cancelled=>Err("MCP call interrupted; remote outcome is unknown".to_owned()),
            result=tokio::time::timeout(Duration::from_secs(300),active.service.call_tool_once(params))=>result.map_err(|_|"MCP call timed out; remote outcome is unknown".to_owned()).and_then(|r|r.map_err(|_|"MCP call failed; remote outcome is unknown".to_owned())),
        };
        match result {
            Ok(CallToolResponse::Complete(result)) => {
                let failed = result.is_error == Some(true);
                let output = serde_json::to_value(result).map_err(|_| "invalid MCP result")?;
                Ok(if failed {
                    ToolOutput::Error(output)
                } else {
                    ToolOutput::Value(output)
                })
            }
            Ok(_) => Ok(ToolOutput::Error(
                json!({"error":"MCP requires a follow-up interaction or task polling; no request was replayed","outcome":"incomplete"}),
            )),
            Err(mut error) => {
                // Revoke availability before awaiting cleanup. A failed
                // cleanup or status write must not leave a ready catalog
                // pointing at the connection we have already removed.
                slot.stale.store(true, Ordering::SeqCst);
                self.update(book, server, &slot.record.info.revision, |record| {
                    record.info.status = Status::Failed {
                        message: error.clone(),
                    };
                });
                if let Some(mut active) = connection.take()
                    && active.close().await.is_err()
                {
                    // Cleanup errors can originate in a remote transport;
                    // preserve the failure without copying its raw payload.
                    error.push_str("; MCP connection cleanup failed");
                }
                if self
                    .status(
                        resources,
                        book,
                        server,
                        &slot.record.info.revision,
                        Status::Failed {
                            message: error.clone(),
                        },
                    )
                    .await
                    .is_err()
                {
                    error.push_str("; MCP failure status could not be saved");
                    self.update(book, server, &slot.record.info.revision, |record| {
                        record.info.status = Status::Failed {
                            message: error.clone(),
                        };
                    });
                }
                Err(error)
            }
        }
    }
}
