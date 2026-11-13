//! Authenticated MCP server over the private local listener. The catalog is
//! M29's projection; execution enters the application's existing Runtime.
//!
//! Without an open book the list is the registry's base catalog. With one,
//! it is that book's catalog (base tools plus the template actions its
//! levels bind), read through the Host from the `AgentTools` chat uses, so
//! MCP never keeps a second catalog. Listing opens no scope and writes no
//! audit; only calls enter the Runtime.

use std::{
    collections::HashSet,
    io,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, Ordering},
    },
};

use dr_agent::{ExternalCall, ExternalScope, ExternalStart, ToolAccess, ToolStatus};
use dr_agent_tools::catalog::{ActionRef, Catalog, Entry};
use dr_model::id::BookId;
use futures::{
    FutureExt as _,
    channel::oneshot,
    future::{BoxFuture, Shared},
};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt as _,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        JsonRpcMessage, ListToolsResult, PaginatedRequestParams, RequestId, ServerCapabilities,
        ServerConfig, Tool, ToolAnnotations,
    },
    service::{RequestContext, RxJsonRpcMessage, TxJsonRpcMessage},
    transport::{Transport, async_rw::AsyncRwTransport},
};
use serde::Serialize;
use serde_json::json;
use tokio::{
    io::{AsyncWriteExt as _, BufReader},
    runtime::Handle,
    sync::{Mutex, MutexGuard, Semaphore},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::{
    Credential, GrantLease, GrantStore, Result,
    host::{Host, Selection},
    transport::{self, Listener},
};

const CONNECTIONS: usize = 32;
const CALLS: usize = 8;
const REQUEST_IDS: usize = 4096;

pub struct Server {
    stop: CancellationToken,
    done: Shared<BoxFuture<'static, Result<()>>>,
}

impl Server {
    /// The listener/grant store belong to the app identity and survive library
    /// switches. Host owns no controller after the shell's release boundary.
    pub fn start(listener: Listener, grants: GrantStore, host: Host, reactor: &Handle) -> Self {
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let (send, receive) = oneshot::channel();
        reactor.spawn(async move {
            let limits = Arc::new(Semaphore::new(CONNECTIONS));
            let mut connections = JoinSet::new();
            let result = loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break Ok(()),
                    _ = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => match accepted {
                        Ok(stream) => {
                            let Ok(permit) = limits.clone().try_acquire_owned() else { continue; };
                            let (store, host, stop) = (grants.clone(), host.clone(), cancel.clone());
                            connections.spawn(async move {
                                let _permit = permit;
                                // A rejected credential or disconnected client is not an
                                // application failure and never logs its input bytes.
                                let _ = serve_connection(stream, store, host, stop).await;
                            });
                        }
                        Err(error) => break Err(format!("MCP listener stopped: {error}")),
                    }
                }
            };
            cancel.cancel();
            while connections.join_next().await.is_some() {}
            drop(listener);
            let _ = send.send(result);
        });
        Self {
            stop,
            done: async move {
                receive
                    .await
                    .map_err(|_| "MCP listener worker ended".to_owned())?
            }
            .boxed()
            .shared(),
        }
    }

    pub fn close(&self) -> BoxFuture<'static, Result<()>> {
        self.stop.cancel();
        self.done.clone().boxed()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

async fn serve_connection(
    stream: transport::LocalStream,
    store: GrantStore,
    host: Host,
    stop: CancellationToken,
) -> Result<()> {
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    let line = tokio::select! {
        _ = stop.cancelled() => return Ok(()),
        line = tokio::time::timeout(transport::HANDSHAKE_TIMEOUT, transport::read_line(&mut read, transport::HANDSHAKE_LIMIT)) => {
            line.map_err(|_| "MCP authentication timed out".to_owned())?
                .map_err(|_| "invalid MCP authentication frame".to_owned())?
                .ok_or_else(|| "MCP authentication ended".to_owned())?
        }
    };
    let lease = serde_json::from_slice::<Credential>(&line)
        .map_err(|_| "invalid MCP credential".to_owned())
        .and_then(|credential| store.authenticate(&credential));
    let Ok(lease) = lease else {
        let _ = tokio::time::timeout(
            transport::HANDSHAKE_TIMEOUT,
            write.write_all(b"{\"ok\":false,\"error\":\"Access denied\"}\n"),
        )
        .await;
        return Err("MCP access denied".into());
    };
    tokio::time::timeout(
        transport::HANDSHAKE_TIMEOUT,
        write.write_all(b"{\"ok\":true}\n"),
    )
    .await
    .map_err(|_| "MCP authentication reply timed out".to_owned())?
    .map_err(|error| error.to_string())?;
    let ended = CancellationToken::new();
    // Subscribed before initialization, so a change while the client is still
    // initializing is announced as soon as it can receive notifications.
    let mut selection = host.watch();
    let mut catalogs = host.catalog_changes();
    let peer = Peer(Arc::new(PeerInner {
        session: Mutex::new(Session {
            epoch: host.selection().epoch,
            scope: None,
        }),
        host,
        catalog: Catalog::new(),
        listed: SyncMutex::new(None),
        store: store.clone(),
        lease: lease.clone(),
        requests: Semaphore::new(CALLS),
        active: SyncMutex::new(None),
        opening: SyncMutex::new(None),
        closed: AtomicBool::new(false),
    }));
    let guarded = Guard {
        inner: AsyncRwTransport::new(
            transport::LineReader::new(read, transport::REQUEST_LIMIT),
            write,
        )
        .with_max_line_length(transport::REQUEST_LIMIT),
        store,
        lease: lease.clone(),
        ended: ended.clone(),
        seen: HashSet::new(),
    };
    let opening = peer.clone().serve(guarded);
    let mut service = tokio::select! {
        _ = stop.cancelled() => return Ok(()),
        _ = lease.revoked() => return Ok(()),
        opened = tokio::time::timeout(transport::HANDSHAKE_TIMEOUT, opening) => {
            opened.map_err(|_| "MCP initialization timed out".to_owned())?
                .map_err(|_| "MCP initialization failed".to_owned())?
        }
    };
    let notifier = service.peer().clone();
    let (mut following, mut counting) = (true, true);
    loop {
        // Every selection epoch (another book, the shelf, a library switch)
        // is another catalog, and so is an in-book change the Host noticed
        // to templates or levels: the client lists again.
        let changed = tokio::select! {
            _ = stop.cancelled() => break,
            _ = ended.cancelled() => break,
            _ = lease.revoked() => break,
            changed = selection.changed(), if following => {
                following = changed.is_ok();
                following
            }
            changed = catalogs.changed(), if counting => {
                counting = changed.is_ok();
                counting
            }
        };
        if changed {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = ended.cancelled() => break,
                _ = lease.revoked() => break,
                _ = notifier.notify_tool_list_changed() => {},
            }
        }
    }
    // Start scope cancellation before waiting for SDK request handlers, since
    // an entered write handler may itself be waiting on durable settlement.
    let closing = peer.close();
    let _ = service.close().await;
    closing.await
}

struct Session {
    /// The selection epoch this connection's calls last acknowledged. A
    /// listing never acknowledges a switch: the next call still reports it.
    epoch: u64,
    /// Opened by the first call that enters this epoch's book.
    scope: Option<ExternalScope>,
}
struct PeerInner {
    host: Host,
    /// The base catalog: the whole list without a book, and the names a call
    /// may use besides a template action's canonical id.
    catalog: Catalog,
    /// The open book's catalog as this connection last listed it, by epoch.
    listed: SyncMutex<Option<(u64, Arc<Catalog>)>>,
    store: GrantStore,
    lease: GrantLease,
    session: Mutex<Session>,
    requests: Semaphore,
    active: SyncMutex<Option<ExternalScope>>,
    opening: SyncMutex<Option<Shared<BoxFuture<'static, Result<ExternalScope>>>>>,
    closed: AtomicBool,
}
#[derive(Clone)]
struct Peer(Arc<PeerInner>);

impl Peer {
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        self.0.closed.store(true, Ordering::Release);
        let (opening, closing) = {
            // The opening -> active handoff and close share this lock order.
            let mut opening = self.0.opening.lock().expect("MCP opening scope");
            let closing = self
                .0
                .active
                .lock()
                .expect("MCP active scope")
                .take()
                .map(|scope| scope.close());
            (opening.take(), closing)
        };
        let peer = self.clone();
        async move {
            let mut failure = None;
            if let Some(closing) = closing {
                failure = closing.await.err().map(|error| error.to_string());
            }
            // SDK shutdown may drop a handler while its durable scope header
            // is still being initialized. Retain and settle that opening too.
            if let Some(opening) = opening
                && let Ok(scope) = opening.await
                && let Err(error) = scope.close().await
            {
                failure = Some(error.to_string());
            }
            let scope = peer.0.session.lock().await.scope.take();
            if let Some(scope) = scope
                && let Err(error) = scope.close().await
            {
                failure = Some(error.to_string());
            }
            failure.map_or(Ok(()), Err)
        }
        .boxed()
    }

    async fn call(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse> {
        let _permit = self
            .0
            .requests
            .try_acquire()
            .map_err(|_| "too many pending MCP calls".to_owned())?;
        if request.input_responses.is_some() || request.request_state.is_some() {
            return Err("MCP continuation and task requests are not supported".into());
        }
        // Unknown names never open a scope. A template action is screened by
        // its canonical form here and resolved in the open book below.
        let action = ActionRef::parse_canonical(&request.name);
        if action.is_none()
            && !self
                .0
                .catalog
                .entries()
                .iter()
                .any(|entry| entry.name == request.name)
        {
            return Err("this tool is not in Drifting's author-tool catalog".into());
        }
        let mut session = self.session(&context).await?;
        self.0.store.validate(&self.0.lease)?;
        if self.0.closed.load(Ordering::Acquire) {
            return Err("MCP connection closed".into());
        }
        let selected = self.0.host.selection();
        if session.epoch != selected.epoch {
            self.retire(&mut session, selected.epoch).await?;
            session.epoch = selected.epoch;
            return Err(format!(
                "the open book changed to {}; read its overview and targets again before writing",
                selected
                    .book
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "none".into())
            ));
        }
        let book = selected
            .book
            .clone()
            .ok_or_else(|| "no book is open; open one in Drifting".to_owned())?;
        self.0.lease.check_book(book.as_str())?;
        if let Some(action) = &action
            && action.book != book.as_str()
        {
            return Err(format!(
                "this template action belongs to book {}, not the open book {book}; list tools again",
                action.book
            ));
        }
        // Resolved before any scope opens: a refused name enters nothing.
        let tool = self
            .resolve(&selected, &book, &request.name, action.is_some(), &context)
            .await?;
        let scope = self.scope(&mut session, &selected, &book, &context).await?;
        self.0.store.validate(&self.0.lease)?;
        if self.0.closed.load(Ordering::Acquire)
            || self.0.host.selection().epoch != selected.epoch
            || context.ct.is_cancelled()
        {
            drop(scope.close());
            return Err("the MCP request was superseded before tool entry".into());
        }
        let arguments = request.arguments.unwrap_or_default();
        // M29's call envelope addresses a template action by its reference,
        // never by name; both carry the revision the client listed.
        let envelope = if tool.action.is_some() {
            json!({"action":tool.name,"arguments":arguments,"revision":tool.revision})
        } else {
            json!({"name":tool.name,"arguments":arguments,"revision":tool.revision})
        };
        let call = scope
            .call_checked(
                ExternalCall {
                    name: "call_tool".into(),
                    arguments: envelope,
                    revision: tool.revision.clone(),
                },
                self.guard(selected.epoch, book.clone()),
            )
            .map_err(|error| error.to_string())?;
        let finished = call.finish();
        tokio::pin!(finished);
        let result = tokio::select! {
            biased;
            _ = context.ct.cancelled() => {
                // A canceled read may have recorded coverage whose reply the
                // client did not consume. End this scope instead of reusing it.
                let closing = scope.close();
                let _ = finished.await;
                let _ = closing.await;
                return Err("MCP call canceled; committed effects remain. Reconnect and inspect before retrying".into());
            }
            _ = self.0.lease.revoked() => {
                let closing = scope.close();
                let _ = finished.await;
                let _ = closing.await;
                return Err("MCP access revoked; committed effects remain".into());
            }
            result = &mut finished => result.map_err(|error| error.to_string())?,
        };
        if tool.action.is_some() && result.status != ToolStatus::Success {
            // The Runtime may have refused a binding that changed after the
            // lookup above. Reading the catalog again announces a change to
            // every connection; the call itself is never retried.
            let _ = self.0.host.catalog(&book, selected.epoch).await;
        }
        #[derive(Serialize)]
        struct Reply<'a> {
            session: &'a str,
            book: &'a str,
            #[serde(flatten)]
            result: &'a dr_agent::ToolResult,
        }
        let content = match bounded_json(
            &Reply {
                session: scope.session(),
                book: book.as_str(),
                result: &result,
            },
            transport::RESPONSE_LIMIT - 2048,
        ) {
            Ok(content) => content,
            Err(_) => {
                let _ = scope.close().await;
                return Err(
                    "tool response exceeded the local limit; reconnect and use smaller reads"
                        .into(),
                );
            }
        };
        let response = if result.status == ToolStatus::Success {
            CallToolResult::success(vec![ContentBlock::text(content)])
        } else {
            CallToolResult::error(vec![ContentBlock::text(content)])
        };
        // Account for JSON string escaping as well as the tool's JSON bytes.
        if bounded_json(&response, transport::RESPONSE_LIMIT - 2048).is_err() {
            let _ = scope.close().await;
            return Err(
                "tool response exceeded the wire limit; reconnect and use smaller reads".into(),
            );
        }
        Ok(response.into())
    }

    /// The tools this connection may see now: the base catalog without an
    /// open book, otherwise the open book's catalog. A plain read of the
    /// catalog: no scope, no audit, no wait for the shared tool scheduler.
    async fn list(&self, context: &RequestContext<RoleServer>) -> Result<Vec<Tool>> {
        let _permit = self
            .0
            .requests
            .try_acquire()
            .map_err(|_| "too many pending MCP calls".to_owned())?;
        if self.0.closed.load(Ordering::Acquire) {
            return Err("MCP connection closed".into());
        }
        let selected = self.0.host.selection();
        let book = selected
            .book
            .clone()
            // A connection limited to another book enters none of this one.
            .filter(|book| self.0.lease.check_book(book.as_str()).is_ok());
        let Some(book) = book else {
            return Ok(self.0.catalog.entries().iter().map(tool).collect());
        };
        let catalog = self.catalog(&selected, &book, context).await?;
        *self.0.listed.lock().expect("MCP listed catalog") =
            Some((selected.epoch, catalog.clone()));
        Ok(catalog.entries().iter().map(tool).collect())
    }

    async fn catalog(
        &self,
        selected: &Selection,
        book: &BookId,
        context: &RequestContext<RoleServer>,
    ) -> Result<Arc<Catalog>> {
        tokio::select! {
            _ = context.ct.cancelled() => Err("MCP request canceled".into()),
            _ = self.0.lease.revoked() => Err("MCP access revoked".into()),
            catalog = self.0.host.catalog(book, selected.epoch) => catalog,
        }
    }

    async fn session(
        &self,
        context: &RequestContext<RoleServer>,
    ) -> Result<MutexGuard<'_, Session>> {
        tokio::select! {
            _ = context.ct.cancelled() => Err("MCP request canceled before entry".into()),
            _ = self.0.lease.revoked() => Err("MCP access revoked".into()),
            session = self.0.session.lock() => Ok(session),
        }
    }

    /// Settle a scope opened for an earlier selection; publishing the current
    /// one already froze it.
    async fn retire(&self, session: &mut Session, epoch: u64) -> Result<()> {
        if session
            .scope
            .as_ref()
            .is_some_and(|scope| scope.connection_epoch() != epoch)
        {
            let scope = session.scope.take().expect("checked external scope");
            self.0.active.lock().expect("MCP active scope").take();
            scope.close().await.map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// The current selection's scope, opened on first use and never reopened
    /// once it ended.
    async fn scope(
        &self,
        session: &mut Session,
        selected: &Selection,
        book: &BookId,
        context: &RequestContext<RoleServer>,
    ) -> Result<ExternalScope> {
        if let Some(scope) = &session.scope {
            if scope.is_closed() {
                // In particular, never reopen automatically after a second CAS
                // conflict. A reconnect receives a new session and no observations.
                return Err("this MCP scope ended; reconnect and read the book again".into());
            }
            return Ok(scope.clone());
        }
        let opening = {
            let mut pending = self.0.opening.lock().expect("MCP opening scope");
            if self.0.closed.load(Ordering::Acquire) {
                return Err("MCP connection closed before scope initialization".into());
            }
            let opening = self
                .0
                .host
                .open_external(ExternalStart {
                    client_id: self.0.lease.info().id.clone(),
                    book: book.clone(),
                    connection_epoch: selected.epoch,
                })
                .shared();
            *pending = Some(opening.clone());
            opening
        };
        let pending = opening.clone();
        let scope = tokio::select! {
            _ = context.ct.cancelled() => {
                self.0.closed.store(true, Ordering::Release);
                if let Ok(scope) = pending.await { let _ = scope.close().await; }
                self.0.opening.lock().expect("MCP opening scope").take();
                return Err("MCP request canceled while connecting; reconnect and read again".into());
            },
            _ = self.0.lease.revoked() => {
                self.0.closed.store(true, Ordering::Release);
                if let Ok(scope) = pending.await { let _ = scope.close().await; }
                self.0.opening.lock().expect("MCP opening scope").take();
                return Err("MCP access revoked".into());
            },
            scope = opening => scope?,
        };
        {
            let mut opening = self.0.opening.lock().expect("MCP opening scope");
            *self.0.active.lock().expect("MCP active scope") = Some(scope.clone());
            opening.take();
        }
        session.scope = Some(scope.clone());
        Ok(scope)
    }

    /// The entry linearization check every queued call carries.
    fn guard(
        &self,
        epoch: u64,
        book: BookId,
    ) -> Arc<dyn Fn() -> dr_agent::Result<()> + Send + Sync> {
        let peer = self.clone();
        Arc::new(move || {
            peer.0
                .store
                .validate(&peer.0.lease)
                .map_err(dr_agent::Error::Tool)?;
            let selected = peer.0.host.selection();
            if peer.0.closed.load(Ordering::Acquire)
                || selected.epoch != epoch
                || selected.book.as_ref() != Some(&book)
            {
                return Err(dr_agent::Error::Closed);
            }
            Ok(())
        })
    }

    /// What a call enters: the tool in the open book's current catalog. A
    /// tool this connection listed in this epoch under another revision has
    /// changed since; it is refused rather than entered under a binding the
    /// client has not seen. Reading the catalog announces such a change.
    async fn resolve(
        &self,
        selected: &Selection,
        book: &BookId,
        name: &str,
        action: bool,
        context: &RequestContext<RoleServer>,
    ) -> Result<Entry> {
        let catalog = self.catalog(selected, book, context).await?;
        let Some(entry) = catalog.entries().iter().find(|entry| entry.name == name) else {
            return Err(if action {
                "this template action is not available in the open book; list tools again"
            } else {
                "this tool is not in the open book's catalog; list tools again"
            }
            .into());
        };
        let listed = self.0.listed.lock().expect("MCP listed catalog").clone();
        if let Some((epoch, listed)) = listed
            && epoch == selected.epoch
            && let Some(was) = listed.entries().iter().find(|entry| entry.name == name)
            && was.revision != entry.revision
        {
            return Err("this tool changed after tools were listed; list tools again".into());
        }
        Ok(entry.clone())
    }
}

/// One catalog entry as MCP lists it. A template action's name is its
/// canonical id; the author's name for it is the title.
fn tool(entry: &Entry) -> Tool {
    let tool = Tool::new(
        entry.name.clone(),
        entry.description.clone(),
        entry
            .input_schema
            .as_object()
            .expect("M29 object schema")
            .clone(),
    )
    .with_annotations(
        ToolAnnotations::new()
            .read_only(entry.access == ToolAccess::Read)
            .open_world(false),
    );
    match &entry.action {
        Some(action) => tool.with_title(action.display_name.clone()),
        None => tool,
    }
}

impl ServerHandler for Peer {
    fn get_info(&self) -> ServerConfig {
        let book = self
            .0
            .host
            .selection()
            .book
            .map(|id| id.to_string())
            .unwrap_or_else(|| "none".into());
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
            .with_server_info(Implementation::new("Drifting", env!("CARGO_PKG_VERSION")))
            .with_instructions(format!("Current open book: {book}. Tools are Drifting's canonical author tools plus the open book's template actions (named action:…); the list follows the open book and announces changes with notifications/tools/list_changed. Read the current book and complete target content before editing. Calls share the in-app Agent scheduler; changes commit directly with durable receipts. The result's session identifies this external connection and its durable settlement receipts. Complete entry history is restored by the author in the app. Switching books ends its read coverage. A canceled or disconnected call may already have committed; inspect before retrying. Calls are never replayed automatically."))
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        self.0
            .store
            .validate(&self.0.lease)
            .map_err(|_| ErrorData::invalid_params("access revoked", None))?;
        if request.is_some_and(|request| request.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "the tool catalog has one page",
                None,
            ));
        }
        let tools = self
            .list(&context)
            .await
            .map_err(|error| ErrorData::internal_error(error, None))?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        Ok(match self.call(request, context).await {
            Ok(result) => result,
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error)]).into(),
        })
    }
}

fn bounded_json(value: &impl Serialize, limit: usize) -> io::Result<String> {
    struct Buffer {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl io::Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.bytes.len().saturating_add(bytes.len()) > self.limit {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "MCP response is too large",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut buffer = Buffer {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut buffer, value).map_err(io::Error::other)?;
    String::from_utf8(buffer.bytes).map_err(io::Error::other)
}

struct Guard<T> {
    inner: T,
    store: GrantStore,
    lease: GrantLease,
    ended: CancellationToken,
    seen: HashSet<RequestId>,
}

impl<T: Transport<RoleServer, Error = io::Error> + 'static> Transport<RoleServer> for Guard<T> {
    type Error = io::Error;
    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = io::Result<()>> + Send + 'static {
        let valid = self
            .store
            .validate(&self.lease)
            .map_err(io::Error::other)
            .and_then(|_| bounded_json(&item, transport::RESPONSE_LIMIT).map(|_| ()));
        let sending = self.inner.send(item);
        let (lease, ended) = (self.lease.clone(), self.ended.clone());
        async move {
            let result = match valid {
                Err(error) => Err(error),
                Ok(()) => tokio::select! {
                    _ = lease.revoked() => Err(io::Error::new(io::ErrorKind::PermissionDenied, "access revoked")),
                    result = sending => result,
                },
            };
            if result.is_err() {
                ended.cancel();
            }
            result
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        if self.store.validate(&self.lease).is_err() {
            self.ended.cancel();
            return None;
        }
        let received = self.inner.receive().await;
        if let Some(JsonRpcMessage::Request(request)) = &received
            && (self.seen.len() >= REQUEST_IDS
                || serde_json::to_vec(&request.id).map_or(true, |id| id.len() > 256)
                || !self.seen.insert(request.id.clone()))
        {
            self.ended.cancel();
            return None;
        }
        if received.is_none() {
            self.ended.cancel();
        }
        received
    }
    async fn close(&mut self) -> io::Result<()> {
        self.ended.cancel();
        self.inner.close().await
    }
}
