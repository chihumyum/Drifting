//! Real local transports, rmcp peers, M29 commands and synthetic F8 books.

use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

use dr_agent::{ExternalScope, ExternalStart, Options, Runtime, driver::scripted::ScriptedDriver};
use dr_agent_tools::{
    AgentTools,
    catalog::{ActionBinding, ActionRef, Catalog},
};
use dr_mcp::{
    ClientPaths, Credential, GrantPaths, GrantStore, bridge,
    host::{Backend, CatalogSource, Host, ScopeOpener},
    inbound::Server,
    transport::{self, Listener, LocalStream},
};
use dr_model::id::BookId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Subscription, Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, future::join_all};
use rmcp::{
    ClientHandler, Peer, RoleClient, ServiceExt,
    model::{CallToolRequestParams, CallToolResult, ProtocolVersion, Tool},
    service::{NotificationContext, RunningService},
    transport::async_rw::AsyncRwTransport,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncWriteExt, BufReader, ReadHalf, WriteHalf},
    runtime::Handle,
    time::{Instant, timeout},
};

type Client = RunningService<RoleClient, ()>;
const WAIT: Duration = Duration::from_secs(15);

struct Book {
    id: BookId,
    doc: String,
    paragraph: Value,
}
struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    /// The runtime's own book tools: the Host's catalog source reads these,
    /// as the app adapter reads the companion's.
    tools: AgentTools,
    runtime: Runtime,
    books: Vec<Book>,
    host: Host,
    follow: Subscription,
    server: Server,
    grants: GrantStore,
    grant: String,
    credential: Credential,
    scopes: Arc<Mutex<Vec<ExternalScope>>>,
}

fn catalog_source(tools: AgentTools, ws: Workspace) -> CatalogSource {
    Arc::new(move |book| {
        let (tools, ws) = (tools.clone(), ws.clone());
        async move {
            tokio::task::spawn_blocking(move || {
                tools
                    .catalog_for_book(&ws, &book)
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| error.to_string())?
        }
        .boxed()
    })
}

fn opener(runtime: Runtime, scopes: Arc<Mutex<Vec<ExternalScope>>>) -> ScopeOpener {
    Arc::new(move |start| {
        let runtime = runtime.clone();
        let scopes = scopes.clone();
        async move {
            let scope = tokio::task::spawn_blocking(move || runtime.open_external(start))
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
            scopes.lock().unwrap().push(scope.clone());
            Ok(scope)
        }
        .boxed()
    })
}

impl Fixture {
    async fn new(unix: bool, options: dr_store::LibraryOptions) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path().join("library"), options).unwrap();
        let mut ids = Vec::new();
        for number in 0..2 {
            let data = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED + number).unwrap();
            ids.push(data.books[0].book_id().clone());
            data.write_to(&lib).unwrap();
        }
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let books = ids
            .into_iter()
            .map(|id| {
                let chapters = ws
                    .call(&Actor::User, "entry.list", json!({"book":id,"all":true}))
                    .unwrap();
                let entry = chapters["output"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["template"] == "tpl-chapter")
                    .unwrap();
                let doc = format!("body:{}/mod-prose", entry["id"].as_str().unwrap());
                let paragraph = ws
                    .call(&Actor::User, "prose.read", json!({"doc":doc}))
                    .unwrap()["output"]["paragraphs"][1]
                    .clone();
                Book { id, doc, paragraph }
            })
            .collect::<Vec<_>>();
        let tools = AgentTools::new();
        let runtime = Runtime::new(
            ws.clone(),
            Arc::new(ScriptedDriver::new(vec![])),
            Arc::new(tools.clone()),
            Options::default(),
        )
        .unwrap();
        let paths = GrantPaths::new(
            dir.path().join("mcp"),
            dir.path().join("synthetic-writer"),
            ClientPaths::from_home(dir.path().join("home"), None, None),
        )
        .with_socket_root(dir.path().join("short"));
        let listener = if unix {
            Listener::bind(&paths).await.unwrap()
        } else {
            Listener::loopback().await.unwrap()
        };
        let grants = GrantStore::open(paths, listener.endpoint().unwrap()).unwrap();
        let description = grants
            .create_manual("Synthetic inbound client")
            .await
            .unwrap();
        let credential = Credential::read_private(Path::new(&description.config.args[2])).unwrap();
        let host = Host::new(Handle::current());
        let scopes = Arc::new(Mutex::new(Vec::new()));
        host.replace(
            Some(books[0].id.clone()),
            Some(Backend {
                opener: opener(runtime.clone(), scopes.clone()),
                catalog: catalog_source(tools.clone(), ws.clone()),
            }),
        );
        let follow = host.follow(&ws);
        let server = Server::start(listener, grants.clone(), host.clone(), &Handle::current());
        Self {
            _dir: dir,
            ws,
            tools,
            runtime,
            books,
            host,
            follow,
            server,
            grants,
            grant: description.grant.id,
            credential,
            scopes,
        }
    }
    async fn client(&self) -> Client {
        self.client_with(()).await
    }
    async fn client_with<H: ClientHandler>(&self, handler: H) -> RunningService<RoleClient, H> {
        let raw = Raw::authenticate(&self.credential).await;
        timeout(
            WAIT,
            handler.serve(AsyncRwTransport::new(raw.read, raw.write)),
        )
        .await
        .unwrap()
        .unwrap()
    }
    /// The catalog the Agent resolves for a book: what MCP must list.
    fn catalog(&self, index: usize) -> Arc<Catalog> {
        self.tools
            .catalog_for_book(&self.ws, &self.books[index].id)
            .unwrap()
    }
    /// The fixture's backend with another scope opener.
    fn backend(&self, opener: ScopeOpener) -> Backend {
        Backend {
            opener,
            catalog: catalog_source(self.tools.clone(), self.ws.clone()),
        }
    }
    fn write(&self, index: usize) -> Value {
        let book = &self.books[index];
        let text = book.paragraph["text"].as_str().unwrap();
        json!({"doc":book.doc,"find":text,"replace":text.chars().rev().collect::<String>(),"block_id":book.paragraph["block_id"]})
    }
    async fn finish(self) {
        self.host.suspend();
        timeout(WAIT, self.server.close()).await.unwrap().unwrap();
        let scopes = self.scopes.lock().unwrap().clone();
        for result in join_all(scopes.iter().map(ExternalScope::close)).await {
            result.unwrap();
        }
        self.runtime.drain_tools().await.unwrap();
        self.grants.drain().await.unwrap();
        assert!(self.ws.library().agent_sessions(None).unwrap().is_empty());
        assert!(
            self.ws
                .library()
                .docs(None, Some("conversation"))
                .unwrap()
                .is_empty()
        );
        drop(self.follow);
        drop(self.server);
        drop(self.host);
        drop(self.scopes);
        drop(self.runtime);
        drop(self.tools);
        drop(self.grants);
        self.ws.try_shutdown().unwrap();
    }
}

async fn call(client: &Peer<RoleClient>, name: &str, arguments: Value) -> CallToolResult {
    timeout(
        WAIT,
        client.call_tool(
            CallToolRequestParams::new(name.to_owned())
                .with_arguments(arguments.as_object().unwrap().clone()),
        ),
    )
    .await
    .unwrap()
    .unwrap()
}
fn text(result: &CallToolResult) -> &str {
    &result.content[0].as_text().unwrap().text
}
fn reply(result: &CallToolResult) -> Value {
    assert_ne!(result.is_error, Some(true), "{}", text(result));
    serde_json::from_str(text(result)).unwrap()
}
async fn wait(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !ready() {
        assert!(Instant::now() < deadline, "local MCP condition timed out");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn main_chain(unix: bool, through_bridge: bool) {
    let f = Fixture::new(unix, library_options("m32-inbound")).await;
    let mut bridging = None;
    let mut client = if through_bridge {
        let (client, pipes) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(pipes);
        let credential = f.credential.clone();
        bridging = Some(tokio::spawn(async move {
            bridge::forward(credential, read, write).await
        }));
        timeout(WAIT, ().serve(client)).await.unwrap().unwrap()
    } else {
        f.client().await
    };
    assert!(
        client
            .peer_info()
            .unwrap()
            .instructions
            .as_ref()
            .unwrap()
            .contains(f.books[0].id.as_str())
    );
    let listed = client.list_tools(None).await.unwrap();
    // With a book open the list is that book's catalog: base tools plus its
    // template actions, exactly as the Agent resolves them.
    let catalog = f.catalog(0);
    assert_eq!(listed.tools.len(), catalog.entries().len());
    assert!(listed.tools.iter().any(|tool| tool.name == "prose.replace"));
    assert!(
        !listed
            .tools
            .iter()
            .any(|tool| matches!(tool.name.as_ref(), "ask_user" | "call_tool" | "tool_search"))
    );
    reply(&call(&client, "entry.list", json!({"book":f.books[0].id})).await);
    let owner = f.books[0]
        .doc
        .strip_prefix("body:")
        .unwrap()
        .split_once('/')
        .unwrap()
        .0;
    let target = json!({"book":f.books[0].id,"entry":owner});
    let point =
        f.ws.call(&Actor::User, "entry_snapshot.create", target.clone())
            .unwrap()["output"]["id"]
            .clone();
    let read = reply(&call(&client, "prose.read", json!({"doc":f.books[0].doc})).await);
    let write = reply(&call(&client, "prose.replace", f.write(0)).await);
    assert_eq!(write["session"], read["session"]);
    assert!(!write["settlements"].as_array().unwrap().is_empty());
    let changed = reply(&call(&client, "prose.read", json!({"doc":f.books[0].doc})).await);
    assert_eq!(
        changed["output"]["output"]["paragraphs"][1]["text"],
        f.write(0)["replace"]
    );
    assert_eq!(
        f.ws.library()
            .settlements(write["session"].as_str(), None)
            .unwrap()
            .len(),
        1
    );
    assert!(
        !listed.tools.iter().any(|tool| matches!(
            tool.name.as_ref(),
            "history.undo_agent" | "history.agent_changes"
        )),
        "retired selective Agent undo is not a v3 model tool"
    );
    // Complete checkpoint restoration belongs to the author host. It is not
    // reintroduced into the MCP model catalog as an old selective undo tool.
    let at = json!({"book":f.books[0].id,"entry":owner,"point":point});
    let preview =
        f.ws.call(&Actor::User, "entry_snapshot.preview", at.clone())
            .unwrap()["output"]
            .clone();
    let mut restore = at;
    restore["expected"] = preview["expected"].clone();
    f.ws.call(&Actor::User, "entry_snapshot.restore", restore)
        .unwrap();
    let after =
        f.ws.call(&Actor::User, "prose.read", json!({"doc":f.books[0].doc}))
            .unwrap();
    assert_eq!(
        after["output"]["paragraphs"][1]["text"],
        f.books[0].paragraph["text"]
    );
    timeout(WAIT, client.close()).await.unwrap().unwrap();
    drop(client);
    if let Some(bridge) = bridging {
        timeout(WAIT, bridge).await.unwrap().unwrap().unwrap();
    }
    f.finish().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unix_client_lists_reads_writes_and_author_restores_with_real_runtime() {
    main_chain(true, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loopback_client_lists_reads_writes_and_author_restores_with_real_runtime() {
    main_chain(false, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headless_bridge_forwards_the_complete_author_tool_chain() {
    main_chain(false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_a_b_a_requires_new_reads_and_new_sessions_on_the_same_wire() {
    let f = Fixture::new(false, library_options("m32-inbound-book-epoch")).await;
    let mut client = f.client().await;
    let first = reply(&call(&client, "prose.read", json!({"doc":f.books[0].doc})).await);
    f.host.select(Some(f.books[1].id.clone()));
    let changed = call(&client, "entry.list", json!({"book":f.books[1].id})).await;
    assert_eq!(changed.is_error, Some(true));
    assert!(text(&changed).contains(f.books[1].id.as_str()));
    let second = reply(&call(&client, "entry.list", json!({"book":f.books[1].id})).await);
    assert_ne!(first["session"], second["session"]);
    f.host.select(Some(f.books[0].id.clone()));
    assert_eq!(
        call(&client, "prose.replace", f.write(0)).await.is_error,
        Some(true)
    );
    let stale = call(&client, "prose.replace", f.write(0)).await;
    assert_eq!(stale.is_error, Some(true));
    let stale: Value = serde_json::from_str(text(&stale)).unwrap();
    assert_eq!(stale["output"]["error"]["code"], "read_required");
    assert_ne!(stale["session"], first["session"]);
    assert!(f.ws.library().settlements(None, None).unwrap().is_empty());
    client.close().await.unwrap();
    drop(client);
    f.finish().await;
}

/// A client that counts `notifications/tools/list_changed`.
#[derive(Clone, Default)]
struct Watcher(Arc<AtomicUsize>);
impl Watcher {
    fn seen(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}
impl ClientHandler for Watcher {
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn names(tools: &[Tool]) -> Vec<String> {
    tools.iter().map(|tool| tool.name.to_string()).collect()
}
fn entry_names(catalog: &Catalog) -> Vec<String> {
    catalog.entries().iter().map(|e| e.name.clone()).collect()
}
/// The seed's manuscript action: bound on a level and creating its entries
/// under that same level (the novel template's new chapter).
fn own_level_action(catalog: &Catalog) -> ActionBinding {
    catalog
        .actions()
        .into_iter()
        .find(|action| action.home.as_deref() == Some(action.reference.level.as_str()))
        .expect("the seeded book binds an action on its own level")
        .clone()
}
fn external_calls(f: &Fixture) -> Vec<String> {
    f.ws.library()
        .local_entries("agent.external.events", None)
        .unwrap()
        .iter()
        .map(|row| serde_json::from_str::<Value>(&row.value).unwrap()["event"].clone())
        .filter(|event| event["kind"] == "accepted")
        .map(|event| event["request"]["name"].as_str().unwrap().to_owned())
        .collect()
}
/// Every durable trace an external call leaves: the scope's session header,
/// its audit events and the workspace journal.
fn traces(f: &Fixture) -> (usize, usize, usize) {
    let lib = f.ws.library();
    (
        lib.local_entries("agent.external.sessions", None)
            .unwrap()
            .len(),
        lib.local_entries("agent.external.events", None)
            .unwrap()
            .len(),
        f.ws.journal(None, 100_000).unwrap().len(),
    )
}
/// Longer than the Host takes to compare the catalog after a book edit.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(600)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_book_lists_its_template_actions_and_an_action_writes_through_the_runtime() {
    let f = Fixture::new(false, library_options("m32-inbound-actions")).await;
    let watcher = Watcher::default();
    let mut client = f.client_with(watcher.clone()).await;
    let catalog = f.catalog(0);
    let before = traces(&f);
    let listed = client.list_tools(None).await.unwrap().tools;
    // Listing reads the catalog: no scope, no audit or journal rows.
    assert!(f.scopes.lock().unwrap().is_empty());
    assert_eq!(traces(&f), before);
    assert_eq!(before.0 + before.1, 0);
    // The Agent's catalog for this book, in its order, with its descriptions
    // and schemas: base tools and the template actions the book binds.
    assert_eq!(names(&listed), entry_names(&catalog));
    for (tool, entry) in listed.iter().zip(catalog.entries()) {
        assert_eq!(
            tool.description.as_deref(),
            Some(entry.description.as_str())
        );
        assert_eq!(
            Value::Object((*tool.input_schema).clone()),
            entry.input_schema
        );
    }
    let actions = catalog.actions();
    assert!(!actions.is_empty());
    for action in &actions {
        assert!(action.id.starts_with(&format!("action:{}/", f.books[0].id)));
        let tool = listed.iter().find(|tool| tool.name == action.id).unwrap();
        assert_eq!(tool.title.as_deref(), Some(action.display_name.as_str()));
        assert_eq!(
            tool.annotations.as_ref().and_then(|a| a.read_only_hint),
            Some(false)
        );
    }
    let listed_names = names(&listed);
    assert!(
        f.catalog(1)
            .actions()
            .iter()
            .all(|action| !listed_names.contains(&action.id))
    );

    let action = own_level_action(&catalog);
    let title = "MCP 外部新建";
    // An action is a write like any other: it needs its read first.
    let unread = call(&client, &action.id, json!({"title":title})).await;
    assert_eq!(unread.is_error, Some(true));
    let unread: Value = serde_json::from_str(text(&unread)).unwrap();
    assert_eq!(unread["output"]["error"]["code"], "read_required");
    reply(&call(&client, "entry.list", json!({"all":true})).await);
    // The refusal changed nothing the book binds: nothing announced.
    assert_eq!(watcher.seen(), 0);
    let created = reply(&call(&client, &action.id, json!({"title":title})).await);
    // Committed through the shared Runtime with this session's receipts.
    assert_eq!(created["session"], unread["session"]);
    let session = created["session"].as_str().unwrap();
    assert!(!created["settlements"].as_array().unwrap().is_empty());
    assert!(
        !f.ws
            .library()
            .settlements(Some(session), None)
            .unwrap()
            .is_empty()
    );
    let id = created["output"]["output"]["id"].as_str().unwrap();
    let entry =
        f.ws.call(
            &Actor::User,
            "entry.get",
            json!({"book":f.books[0].id,"id":id}),
        )
        .unwrap()["output"]
            .clone();
    assert_eq!(entry["title"], title);
    assert_eq!(
        entry["template"].as_str(),
        Some(action.target_template.as_str())
    );
    assert_eq!(entry["parent"].as_str(), action.home.as_deref());
    client.close().await.unwrap();
    drop(client);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_an_open_book_the_list_is_the_base_catalog_and_actions_wait_for_one() {
    let f = Fixture::new(false, library_options("m32-inbound-shelf")).await;
    f.host.select(None);
    let mut client = f.client().await;
    let listed = client.list_tools(None).await.unwrap().tools;
    assert_eq!(names(&listed), entry_names(&Catalog::new()));
    assert!(listed.iter().all(|tool| tool.title.is_none()));
    let action = own_level_action(&f.catalog(0));
    let refused = call(&client, &action.id, json!({"title":"不会创建"})).await;
    assert_eq!(refused.is_error, Some(true));
    assert!(
        text(&refused).contains("no book is open"),
        "{}",
        text(&refused)
    );
    // Neither listing nor the refusal opened a scope or journaled a call.
    assert!(f.scopes.lock().unwrap().is_empty());
    assert!(external_calls(&f).is_empty());
    client.close().await.unwrap();
    drop(client);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actions_of_another_book_and_unbound_verbs_are_refused_before_any_call_enters() {
    let f = Fixture::new(false, library_options("m32-inbound-foreign-action")).await;
    let mut client = f.client().await;
    client.list_tools(None).await.unwrap();
    let foreign = own_level_action(&f.catalog(1));
    let refused = call(&client, &foreign.id, json!({"title":"不会创建"})).await;
    assert_eq!(refused.is_error, Some(true));
    assert!(
        text(&refused).contains(&format!(
            "belongs to book {}, not the open book {}",
            f.books[1].id, f.books[0].id
        )),
        "{}",
        text(&refused)
    );
    // A canonical reference into the open book that no level binds.
    let own = own_level_action(&f.catalog(0));
    let unbound = ActionRef {
        verb: "no-such-verb".into(),
        ..own.reference.clone()
    }
    .canonical_id();
    let refused = call(&client, &unbound, json!({"title":"不会创建"})).await;
    assert_eq!(refused.is_error, Some(true));
    assert!(
        text(&refused).contains("not available in the open book"),
        "{}",
        text(&refused)
    );
    let refused = call(&client, "entry.create_anything", json!({})).await;
    assert!(text(&refused).contains("not in Drifting's author-tool catalog"));
    // None of them entered the Runtime: no scope, no audit, no write.
    assert!(f.scopes.lock().unwrap().is_empty());
    assert!(external_calls(&f).is_empty());
    assert!(f.ws.library().settlements(None, None).unwrap().is_empty());
    client.close().await.unwrap();
    drop(client);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_books_announces_list_changed_and_the_list_follows_the_open_book() {
    let f = Fixture::new(false, library_options("m32-inbound-list-changed")).await;
    let watcher = Watcher::default();
    let mut client = f.client_with(watcher.clone()).await;
    assert_eq!(
        names(&client.list_tools(None).await.unwrap().tools),
        entry_names(&f.catalog(0))
    );
    let first = reply(&call(&client, "entry.list", json!({"all":true})).await);

    f.host.select(Some(f.books[1].id.clone()));
    wait(|| watcher.seen() >= 1).await;
    let second = names(&client.list_tools(None).await.unwrap().tools);
    assert_eq!(second, entry_names(&f.catalog(1)));
    assert!(
        f.catalog(0)
            .actions()
            .iter()
            .all(|action| !second.contains(&action.id))
    );
    // Listing does not acknowledge the switch for calls: the first call still
    // reports the new book before anything enters it.
    let switched = call(&client, "entry.list", json!({"all":true})).await;
    assert_eq!(switched.is_error, Some(true));
    assert!(text(&switched).contains(f.books[1].id.as_str()));
    reply(&call(&client, "entry.list", json!({"all":true})).await);
    let action = own_level_action(&f.catalog(1));
    let created = reply(&call(&client, &action.id, json!({"title":"第二本书的新条目"})).await);
    assert_eq!(created["book"], f.books[1].id.as_str());
    assert_ne!(created["session"], first["session"]);

    f.host.select(None);
    wait(|| watcher.seen() >= 2).await;
    assert_eq!(
        names(&client.list_tools(None).await.unwrap().tools),
        entry_names(&Catalog::new())
    );
    client.close().await.unwrap();
    drop(client);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_action_rebound_after_listing_is_announced_and_refused_until_listed_again() {
    let f = Fixture::new(false, library_options("m32-inbound-stale-action")).await;
    let watcher = Watcher::default();
    let mut client = f.client_with(watcher.clone()).await;
    client.list_tools(None).await.unwrap();
    let catalog = f.catalog(0);
    // An edit that leaves the catalog as it was announces nothing.
    let entries =
        f.ws.call(
            &Actor::User,
            "entry.list",
            json!({"book":f.books[0].id,"all":true}),
        )
        .unwrap()["output"]
            .clone();
    let ordinary = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["level"] != true)
        .expect("the seeded book has an entry without the level switch");
    f.ws.call(
        &Actor::User,
        "entry.update",
        json!({"book":f.books[0].id,"id":ordinary["id"],"title":"改名不改目录"}),
    )
    .unwrap();
    settle().await;
    assert_eq!(watcher.seen(), 0);
    // An action bound on one level that creates its entries in another.
    let action = catalog
        .actions()
        .into_iter()
        .find(|action| {
            action
                .home
                .as_ref()
                .is_some_and(|home| home != &action.reference.level)
        })
        .expect("the seeded book binds an action with a home elsewhere")
        .clone();
    let listed_revision = catalog.descriptor(&action.id).unwrap().revision;
    reply(&call(&client, "entry.list", json!({"all":true})).await);
    // The author switches the home level off in the app: the action rebinds
    // to its own level under a new revision while the client's list is old.
    f.ws.call(
        &Actor::User,
        "entry.set_level",
        json!({"book":f.books[0].id,"id":action.home,"level":false}),
    )
    .unwrap();
    let rebound = f.catalog(0);
    assert_ne!(
        rebound.descriptor(&action.id).unwrap().revision,
        listed_revision
    );
    // Announced from the book edit itself, before the client calls anything.
    wait(|| watcher.seen() >= 1).await;
    let stale_title = "按旧绑定不会创建";
    let entered = external_calls(&f).len();
    let stale = call(&client, &action.id, json!({"title":stale_title})).await;
    assert_eq!(stale.is_error, Some(true));
    assert!(
        text(&stale).contains("changed after tools were listed"),
        "{}",
        text(&stale)
    );
    // Refused before the Runtime and never replayed.
    assert_eq!(external_calls(&f).len(), entered);
    let entries =
        f.ws.call(
            &Actor::User,
            "entry.list",
            json!({"book":f.books[0].id,"all":true}),
        )
        .unwrap()["output"]
            .clone();
    assert!(
        entries
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["title"] != stale_title)
    );
    // Listed again, the current binding is callable after a fresh read. The
    // change was announced once.
    assert_eq!(
        names(&client.list_tools(None).await.unwrap().tools),
        entry_names(&rebound)
    );
    assert_eq!(watcher.seen(), 1);
    reply(&call(&client, "entry.list", json!({"all":true})).await);
    let created = reply(&call(&client, &action.id, json!({"title":"按新绑定创建"})).await);
    let id = created["output"]["output"]["id"].as_str().unwrap();
    let entry =
        f.ws.call(
            &Actor::User,
            "entry.get",
            json!({"book":f.books[0].id,"id":id}),
        )
        .unwrap()["output"]
            .clone();
    assert_eq!(
        entry["parent"].as_str(),
        Some(action.reference.level.as_str())
    );
    client.close().await.unwrap();
    drop(client);
    f.finish().await;
}

struct Raw {
    read: BufReader<ReadHalf<LocalStream>>,
    write: WriteHalf<LocalStream>,
}
impl Raw {
    async fn authenticate(credential: &Credential) -> Self {
        let stream = transport::connect(credential.endpoint()).await.unwrap();
        let (read, write) = tokio::io::split(stream);
        let mut this = Self {
            read: BufReader::new(read),
            write,
        };
        this.send(serde_json::to_value(credential).unwrap()).await;
        assert_eq!(this.receive().await.unwrap()["ok"], true);
        this
    }
    async fn send(&mut self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.write.write_all(&bytes).await.unwrap();
        self.write.flush().await.unwrap();
    }
    async fn receive(&mut self) -> Option<Value> {
        timeout(
            WAIT,
            transport::read_line(&mut self.read, transport::RESPONSE_LIMIT),
        )
        .await
        .unwrap()
        .ok()
        .flatten()
        .map(|line| serde_json::from_slice(&line).unwrap())
    }
    async fn initialize(&mut self) {
        self.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":ProtocolVersion::LATEST_WITH_INITIALIZE,"capabilities":{},"clientInfo":{"name":"synthetic-raw-client","version":"1"}}})).await;
        assert!(self.receive().await.unwrap()["result"].is_object());
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await;
    }
    async fn tool(&mut self, id: u64, name: &str, args: Value) -> Value {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})).await;
        self.receive().await.unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_request_id_closes_the_wire_before_a_second_operation_enters() {
    let f = Fixture::new(false, library_options("m32-duplicate-id")).await;
    let mut raw = Raw::authenticate(&f.credential).await;
    raw.initialize().await;
    let read = raw
        .tool(2, "prose.read", json!({"doc":f.books[0].doc}))
        .await;
    assert_ne!(read["result"]["isError"], true);
    raw.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"prose.replace","arguments":f.write(0)}})).await;
    assert!(raw.receive().await.is_none());
    assert!(f.ws.library().settlements(None, None).unwrap().is_empty());
    drop(raw);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grant_revocation_disconnects_existing_wire_and_rejects_the_old_credential() {
    let f = Fixture::new(false, library_options("m32-revoke-wire")).await;
    let client = f.client().await;
    reply(&call(&client, "prose.read", json!({"doc":f.books[0].doc})).await);
    f.grants.revoke(&f.grant).await.unwrap();
    wait(|| client.is_transport_closed()).await;
    assert!(
        client
            .call_tool(
                CallToolRequestParams::new("prose.replace")
                    .with_arguments(f.write(0).as_object().unwrap().clone())
            )
            .await
            .is_err()
    );
    let stream = transport::connect(f.credential.endpoint()).await.unwrap();
    let (read, write) = tokio::io::split(stream);
    let mut raw = Raw {
        read: BufReader::new(read),
        write,
    };
    raw.send(serde_json::to_value(&f.credential).unwrap()).await;
    assert_eq!(raw.receive().await.unwrap()["ok"], false);
    assert!(f.ws.library().settlements(None, None).unwrap().is_empty());
    drop(raw);
    drop(client);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_limits_reject_large_calls_and_unterminated_wire_frames() {
    let f = Fixture::new(false, library_options("m32-inbound-limits")).await;
    let mut client = f.client().await;
    let sample = f.books[0].paragraph["text"].as_str().unwrap();
    let padding = sample.repeat(600_000 / sample.len() + 1);
    let rejected = call(
        &client,
        "prose.read",
        json!({"doc":f.books[0].doc,"padding":padding}),
    )
    .await;
    assert_eq!(rejected.is_error, Some(true));
    assert!(text(&rejected).contains("oversized"));
    client.close().await.unwrap();
    drop(client);
    let mut raw = Raw::authenticate(&f.credential).await;
    raw.initialize().await;
    let _ = raw
        .write
        .write_all(&vec![b'x'; transport::REQUEST_LIMIT + 1])
        .await;
    assert!(raw.receive().await.is_none());
    drop(raw);
    let mut raw = Raw::authenticate(&f.credential).await;
    raw.initialize().await;
    // The serialized request-ID limit includes the JSON string quotes.
    raw.send(json!({"jsonrpc":"2.0","id":"x".repeat(254),"method":"tools/list"}))
        .await;
    assert!(raw.receive().await.unwrap()["result"]["tools"].is_array());
    raw.send(json!({"jsonrpc":"2.0","id":"x".repeat(255),"method":"tools/list"}))
        .await;
    assert!(raw.receive().await.is_none());
    drop(raw);
    // Boundary framing itself accepts exactly the bound and rejects one more,
    // through the same production function used by the headless bridge.
    let mut line = vec![b'x'; transport::HANDSHAKE_LIMIT - 1];
    line.push(b'\n');
    let mut exact = BufReader::new(line.as_slice());
    assert_eq!(
        transport::read_line(&mut exact, transport::HANDSHAKE_LIMIT)
            .await
            .unwrap()
            .unwrap()
            .len(),
        transport::HANDSHAKE_LIMIT
    );
    line.insert(0, b'x');
    let mut oversized = BufReader::new(line.as_slice());
    assert!(
        transport::read_line(&mut oversized, transport::HANDSHAKE_LIMIT)
            .await
            .is_err()
    );
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_real_prose_reply_ends_scope_without_replaying_the_read() {
    let f = Fixture::new(false, library_options("m32-response-limit")).await;
    let book = &f.books[0];
    let sample = book.paragraph["text"].as_str().unwrap();
    // M29 returns both paragraphs and its editable projection, so this real
    // seed-derived paragraph puts the response beyond the 4 MiB wire bound.
    let large = sample.repeat((transport::RESPONSE_LIMIT / 2 + 64 * 1024) / sample.len() + 1);
    f.ws.call(
        &Actor::User,
        "prose.replace",
        json!({"doc":book.doc,"find":sample,"replace":large,"block_id":book.paragraph["block_id"]}),
    )
    .unwrap();
    let mut client = f.client().await;
    let result = timeout(
        Duration::from_secs(60),
        client.call_tool(
            CallToolRequestParams::new("prose.read")
                .with_arguments(json!({"doc":book.doc}).as_object().unwrap().clone()),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.is_error, Some(true));
    assert!(text(&result).contains("exceeded"));
    let ended = call(&client, "entry.list", json!({"book":book.id})).await;
    assert_eq!(ended.is_error, Some(true));
    assert!(text(&ended).contains("reconnect"));
    let scopes = f.scopes.lock().unwrap().clone();
    assert_eq!(scopes.len(), 1);
    assert!(scopes[0].is_closed());
    let rows =
        f.ws.library()
            .local_entries("agent.external.events", Some(book.id.as_str()))
            .unwrap();
    assert_eq!(
        rows.iter()
            .filter(
                |row| serde_json::from_str::<Value>(&row.value).unwrap()["event"]["kind"]
                    == "accepted"
            )
            .count(),
        1
    );
    client.close().await.unwrap();
    drop(client);
    f.finish().await;
}

struct Release(Option<mpsc::Sender<()>>);
impl Release {
    fn open(&mut self) {
        if let Some(send) = self.0.take() {
            let _ = send.send(());
        }
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        self.open();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_and_server_close_wait_for_the_entered_write_to_settle() {
    let armed = Arc::new(AtomicBool::new(false));
    let check = armed.clone();
    let entered = Arc::new(tokio::sync::Notify::new());
    let notify = entered.clone();
    let (release, blocked) = mpsc::channel();
    let mut release = Release(Some(release));
    let blocked = Mutex::new(blocked);
    let mut options = library_options("m32-disconnect-write");
    options.append_checkpoint = Some(Arc::new(move || {
        if check.swap(false, Ordering::SeqCst) {
            notify.notify_one();
            blocked.lock().unwrap().recv_timeout(WAIT).unwrap();
        }
    }));
    let f = Fixture::new(false, options).await;
    let client = f.client().await;
    let read = reply(&call(&client, "prose.read", json!({"doc":f.books[0].doc})).await);
    let session = read["session"].as_str().unwrap().to_owned();
    armed.store(true, Ordering::SeqCst);
    let peer = client.peer().clone();
    let args = f.write(0).as_object().unwrap().clone();
    let pending = tokio::spawn(async move {
        peer.call_tool_once(CallToolRequestParams::new("prose.replace").with_arguments(args))
            .await
    });
    timeout(WAIT, entered.notified()).await.unwrap();
    drop(client);
    let mut closing = f.server.close();
    assert!(
        timeout(Duration::from_millis(150), &mut closing)
            .await
            .is_err()
    );
    release.open();
    timeout(WAIT, closing).await.unwrap().unwrap();
    let _ = timeout(WAIT, pending).await.unwrap();
    assert!(
        !f.ws
            .library()
            .settlements(Some(&session), None)
            .unwrap()
            .is_empty()
    );
    let after =
        f.ws.call(&Actor::User, "prose.read", json!({"doc":f.books[0].doc}))
            .unwrap();
    assert_ne!(
        after["output"]["paragraphs"][1]["text"],
        f.books[0].paragraph["text"]
    );
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_host_opening_closes_the_late_scope_instead_of_leaking_library_refs() {
    let f = Fixture::new(false, library_options("m32-abandoned-opening")).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let normal = opener(f.runtime.clone(), f.scopes.clone());
    let notify = entered.clone();
    let blocked = release.clone();
    f.host.replace(
        Some(f.books[0].id.clone()),
        Some(f.backend(Arc::new(move |start| {
            let normal = normal.clone();
            let notify = notify.clone();
            let blocked = blocked.clone();
            async move {
                notify.notify_one();
                blocked.notified().await;
                normal(start).await
            }
            .boxed()
        }))),
    );
    let opening = f.host.open_external(ExternalStart {
        client_id: f.grant.clone(),
        book: f.books[0].id.clone(),
        connection_epoch: f.host.selection().epoch,
    });
    timeout(WAIT, entered.notified()).await.unwrap();
    drop(opening);
    release.notify_one();
    wait(|| {
        f.scopes
            .lock()
            .unwrap()
            .first()
            .is_some_and(ExternalScope::is_settled)
    })
    .await;
    assert!(f.scopes.lock().unwrap()[0].is_closed());
    f.finish().await;
}

struct NotifyRelease(Arc<tokio::sync::Notify>);
impl Drop for NotifyRelease {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_close_waits_for_a_scope_still_being_initialized() {
    let f = Fixture::new(false, library_options("m32-server-opening-close")).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let _release_on_failure = NotifyRelease(release.clone());
    let normal = opener(f.runtime.clone(), f.scopes.clone());
    let notify = entered.clone();
    let blocked = release.clone();
    f.host.replace(
        Some(f.books[0].id.clone()),
        Some(f.backend(Arc::new(move |start| {
            let normal = normal.clone();
            let notify = notify.clone();
            let blocked = blocked.clone();
            async move {
                notify.notify_one();
                blocked.notified().await;
                normal(start).await
            }
            .boxed()
        }))),
    );
    let client = f.client().await;
    let peer = client.peer().clone();
    let book = f.books[0].id.clone();
    let pending = tokio::spawn(async move {
        peer.call_tool_once(
            CallToolRequestParams::new("entry.list")
                .with_arguments(json!({"book":book}).as_object().unwrap().clone()),
        )
        .await
    });
    timeout(WAIT, entered.notified()).await.unwrap();
    let mut closing = f.server.close();
    assert!(
        timeout(Duration::from_millis(150), &mut closing)
            .await
            .is_err(),
        "Server.close returned before its opening scope settled"
    );
    release.notify_one();
    timeout(WAIT, closing).await.unwrap().unwrap();
    let _ = timeout(WAIT, pending).await.unwrap();
    let scopes = f.scopes.lock().unwrap().clone();
    assert_eq!(scopes.len(), 1);
    assert!(scopes[0].is_settled());
    drop(client);
    f.finish().await;
}
