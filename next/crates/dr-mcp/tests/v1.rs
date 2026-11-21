//! The 0.1 client's external-Agent connections after the in-place update.
//!
//! A synthetic 0.1 data folder laid out as on a Mac (`…/cc.drifting.client`):
//! the pre-registry library owned by account A at the root (its MCP state in
//! `mcp/`, which this client serves as its own), a local library and account
//! B's library (theirs in `libraries/<id>/mcp/`), each with one client
//! connected exactly as 0.1 connects one (`support/v1.rs`). The client side
//! is what an external Agent does with the entry 0.1 wrote: the arguments
//! from its configuration, through the executable's own argument rule
//! (`dr_platform::cli::parse`) to the headless bridge; the app side is what
//! the app does (`inbound::serve` for its own folder, `v1::folders` and
//! `v1::Connections` for the others, attached by the open library's owner).
//! Real Runtime, F8 seed book, real sockets or loopback ports.

#[path = "support/v1.rs"]
mod v1_state;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use dr_agent::{ExternalScope, Options, Runtime, driver::scripted::ScriptedDriver};
use dr_agent_tools::{AgentTools, catalog::Catalog};
use dr_mcp::{
    ClientPaths, Credential, Endpoint, GrantPaths, bridge,
    host::{Backend, CatalogSource, Host, ScopeOpener},
    inbound::{self, Network},
    transport::{self, LocalStream},
    v1::{self, Connections, Folder, Owner},
};
use dr_model::id::BookId;
use dr_store::Library;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt as _, future::join_all};
use rmcp::{
    RoleClient, ServiceExt as _,
    model::{CallToolRequestParams, CallToolResult},
    service::RunningService,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncWriteExt as _, BufReader},
    runtime::Handle,
    time::timeout,
};
use v1_state::Client;

const WAIT: Duration = Duration::from_secs(15);
const A: &str = "synthetic-subject-a";
const B: &str = "synthetic-subject-b";

/// The three 0.1 libraries of the folder, by the kind the audit names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// `legacy`, at the data folder's root, owned by A.
    Legacy,
    /// `libraries/local`.
    Local,
    /// `libraries/account-<hex of B>`.
    Account,
}

struct Fixture {
    _dir: tempfile::TempDir,
    home: PathBuf,
    base: PathBuf,
    connections: Vec<(Kind, v1_state::Connection)>,
    ws: Workspace,
    tools: AgentTools,
    runtime: Runtime,
    book: BookId,
    scopes: Arc<Mutex<Vec<ExternalScope>>>,
    host: Host,
    own: Network,
    v1: Connections,
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
        let (runtime, scopes) = (runtime.clone(), scopes.clone());
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
    /// `loopback`: Windows' rules (0.1's files name the port of its last
    /// launch; the app listens on new ports) on whatever system runs this.
    async fn new(loopback: bool) -> Self {
        Self::serving(loopback, true).await
    }

    /// `v1`: whether the 0.1 libraries' own folders are served, or only the
    /// app's own folder, as before they were.
    async fn serving(loopback: bool, v1: bool) -> Self {
        // A Unix socket path must stay short: the folder is laid out under
        // /tmp as under a short home, so that the root's and the local
        // library's sockets fit beside their files and the account
        // library's does not, as on a Mac with a short user name.
        #[cfg(unix)]
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        #[cfg(not(unix))]
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let short = dir.path().join("cache");
        let base = dir.path().join("local").join("cc.drifting.client");
        let executable = dir
            .path()
            .join("Drifting.app")
            .join("Contents")
            .join("MacOS")
            .join("drifting");
        let account = v1_state::account_library(B);
        v1_state::registry(
            &base,
            &account,
            &[
                ("legacy", Some(Some(A))),
                ("local", Some(None)),
                (account.as_str(), Some(Some(B))),
            ],
        );
        let mut connections = Vec::new();
        for (kind, root, client) in [
            (Kind::Legacy, base.clone(), Client::Codex),
            (
                Kind::Local,
                base.join("libraries").join("local"),
                Client::ClaudeCode,
            ),
            (
                Kind::Account,
                base.join("libraries").join(&account),
                Client::ClaudeCode,
            ),
        ] {
            let directory = root.join("mcp");
            let endpoint = if loopback {
                v1_state::closed_port()
            } else {
                v1_endpoint(&directory, &short)
            };
            let made = v1_state::connect(
                &directory,
                &endpoint,
                &home,
                &executable,
                client,
                &format!("{kind:?}"),
            );
            connections.push((kind, made));
        }
        let lib = Library::open(
            dir.path().join("next-library"),
            library_options("m32-v1-connections"),
        )
        .unwrap();
        let data = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = data.books[0].book_id().clone();
        data.write_to(&lib).unwrap();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        ws.set_auto_links(false);
        let tools = AgentTools::new();
        let runtime = Runtime::new(
            ws.clone(),
            Arc::new(ScriptedDriver::new(vec![])),
            Arc::new(tools.clone()),
            Options::default(),
        )
        .unwrap();
        // The app's paths under the release identity: its own folder is the
        // 0.1 data folder's `mcp/` (`GrantPaths::for_app`).
        let mut paths = GrantPaths::new(
            base.join("mcp"),
            executable,
            ClientPaths::from_home(home.clone(), None, None),
        )
        .with_socket_root(short);
        if loopback {
            paths = paths.with_loopback();
        }
        let folders = v1::folders(&base, &paths.directory);
        assert_eq!(
            folders,
            [
                Folder {
                    library: account.clone(),
                    owner: Owner::Account(B.into()),
                    directory: base.join("libraries").join(&account).join("mcp"),
                },
                Folder {
                    library: "local".into(),
                    owner: Owner::Local,
                    directory: base.join("libraries").join("local").join("mcp"),
                },
            ]
        );
        let host = Host::new(Handle::current());
        let own = inbound::serve(paths.clone(), host.clone()).await.unwrap();
        assert!(own.warnings.is_empty(), "{:?}", own.warnings);
        // After the app's own folder started, as the app orders them.
        let folders = if v1 { folders } else { Vec::new() };
        let v1 = Connections::serve(folders, &paths, &Handle::current(), async {}.boxed());
        for opened in v1.opened().await {
            let network = opened.unwrap();
            assert!(network.warnings.is_empty(), "{:?}", network.warnings);
        }
        Self {
            _dir: dir,
            home,
            base,
            connections,
            ws,
            tools,
            runtime,
            book,
            scopes: Arc::new(Mutex::new(Vec::new())),
            host,
            own,
            v1,
        }
    }

    /// The app attaching the library `owner` owns, with its book open.
    fn open(&self, owner: Owner) {
        let backend = Backend {
            opener: opener(self.runtime.clone(), self.scopes.clone()),
            catalog: catalog_source(self.tools.clone(), self.ws.clone()),
        };
        self.host
            .replace(Some(self.book.clone()), Some(backend.clone()));
        self.v1
            .attach(Some(&owner), Some(self.book.clone()), Some(backend));
    }

    fn connection(&self, kind: Kind) -> &v1_state::Connection {
        &self.connections.iter().find(|(k, _)| *k == kind).unwrap().1
    }

    /// The connection file the client's entry names, as the executable reads
    /// its arguments.
    fn file(&self, kind: Kind) -> PathBuf {
        let (_, args) = v1_state::launch(&self.home, self.connection(kind));
        match dr_platform::cli::parse(&args) {
            dr_platform::cli::Launch::Mcp(Ok(file)) => file,
            other => panic!("the 0.1 entry is not an MCP launch: {other:?}"),
        }
    }

    /// An MCP client started from the entry 0.1 wrote for `kind`, through
    /// the headless bridge.
    async fn client(
        &self,
        kind: Kind,
    ) -> (
        RunningService<RoleClient, ()>,
        tokio::task::JoinHandle<dr_mcp::Result<()>>,
    ) {
        let credential = Credential::read_private(&self.file(kind)).unwrap();
        let (client, pipes) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(pipes);
        let bridging = tokio::spawn(bridge::forward(credential, read, write));
        let client = timeout(WAIT, ().serve(client)).await.unwrap().unwrap();
        (client, bridging)
    }

    async fn finish(self) {
        self.host.suspend();
        self.v1.suspend();
        timeout(WAIT, self.own.server.close())
            .await
            .unwrap()
            .unwrap();
        timeout(WAIT, self.v1.close()).await.unwrap();
        let scopes = self.scopes.lock().unwrap().clone();
        for result in join_all(scopes.iter().map(ExternalScope::close)).await {
            result.unwrap();
        }
        self.runtime.drain_tools().await.unwrap();
        self.own.grants.drain().await.unwrap();
        self.v1.drain().await.unwrap();
        drop(self.own);
        drop(self.v1);
        drop(self.scopes);
        drop(self.runtime);
        drop(self.tools);
        self.ws.try_shutdown().unwrap();
    }
}

#[cfg(unix)]
fn v1_endpoint(directory: &Path, short: &Path) -> String {
    use std::os::unix::fs::PermissionsExt as _;
    let socket = v1_state::socket(directory, short);
    // The user's cache folder is private, and so is the `drifting-mcp`
    // folder 0.1 made in it.
    for folder in [
        directory.to_path_buf(),
        short.to_path_buf(),
        short.join("drifting-mcp"),
    ] {
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    // 0.1 never removed its socket: the file of its last launch is still
    // there, with nothing listening.
    drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
    socket.display().to_string()
}
#[cfg(not(unix))]
fn v1_endpoint(_: &Path, _: &Path) -> String {
    v1_state::closed_port()
}

async fn call(
    client: &RunningService<RoleClient, ()>,
    name: &str,
    arguments: Value,
) -> CallToolResult {
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

/// The client reads the open book: `entry.list` succeeds and names it.
async fn reads_the_open_book(f: &Fixture, kind: Kind) {
    let (client, bridging) = f.client(kind).await;
    let instructions = client.peer_info().unwrap().instructions.clone().unwrap();
    assert!(instructions.contains(f.book.as_str()), "{kind:?}");
    let listed = client.list_tools(None).await.unwrap().tools;
    assert!(
        listed.iter().any(|tool| tool.name == "entry.list"),
        "{kind:?}"
    );
    let read = call(&client, "entry.list", json!({"book": f.book})).await;
    assert_ne!(read.is_error, Some(true), "{kind:?}: {}", text(&read));
    let reply: Value = serde_json::from_str(text(&read)).unwrap();
    assert_eq!(reply["book"], f.book.as_str(), "{kind:?}");
    assert!(!reply["output"]["output"].as_array().unwrap().is_empty());
    timeout(WAIT, client.cancel()).await.unwrap().unwrap();
    timeout(WAIT, bridging).await.unwrap().unwrap().unwrap();
}

/// The client is let in (its grant is valid) but sees no book: the base
/// catalog, the open book's id withheld, and a call refused before any
/// scope opens.
async fn sees_no_book(f: &Fixture, kind: Kind) {
    let opened = f.scopes.lock().unwrap().len();
    let (client, bridging) = f.client(kind).await;
    let instructions = client.peer_info().unwrap().instructions.clone().unwrap();
    assert!(instructions.contains("Current open book: none"), "{kind:?}");
    assert!(!instructions.contains(f.book.as_str()), "{kind:?}");
    let listed = client.list_tools(None).await.unwrap().tools;
    let base: Vec<String> = Catalog::new()
        .entries()
        .iter()
        .map(|entry| entry.name.clone())
        .collect();
    let names: Vec<String> = listed.iter().map(|tool| tool.name.to_string()).collect();
    assert_eq!(names, base, "{kind:?}");
    let refused = call(&client, "entry.list", json!({"book": f.book})).await;
    assert_eq!(refused.is_error, Some(true), "{kind:?}");
    assert!(
        text(&refused).contains("no book is open"),
        "{kind:?}: {}",
        text(&refused)
    );
    assert_eq!(f.scopes.lock().unwrap().len(), opened, "{kind:?}");
    timeout(WAIT, client.cancel()).await.unwrap().unwrap();
    timeout(WAIT, bridging).await.unwrap().unwrap().unwrap();
}

async fn each_library_kind_reaches_its_owners_books_and_no_other(loopback: bool) {
    let f = Fixture::new(loopback).await;
    // 0.1's socket rule as on such a Mac: the root's and the local
    // library's beside their files, the account library's in the short
    // folder.
    if !loopback {
        let socket = |kind| {
            Credential::read_private(&f.connection(kind).file)
                .unwrap()
                .endpoint()
                .clone()
        };
        let short = f._dir.path().join("cache").join("drifting-mcp");
        for kind in [Kind::Legacy, Kind::Local] {
            assert!(
                matches!(socket(kind), Endpoint::Unix(path) if path.ends_with("mcp/bridge.sock")),
                "{kind:?}"
            );
        }
        assert!(matches!(socket(Kind::Account), Endpoint::Unix(path) if path.starts_with(&short)));
    }
    // Every connection file names the endpoint its folder listens on now:
    // the same socket on macOS, a new port on Windows.
    for (kind, connection) in &f.connections {
        let wire: Value =
            serde_json::from_slice(&std::fs::read(&connection.file).unwrap()).unwrap();
        let endpoint = Credential::read_private(&connection.file).unwrap();
        assert_eq!(wire["connectionId"], connection.id.as_str(), "{kind:?}");
        transport::connect(endpoint.endpoint())
            .await
            .unwrap_or_else(|error| {
                panic!("{kind:?}: nothing listens where its connection file says: {error}")
            });
    }

    // Account A's library, the 0.1 pre-registry library's owner: its
    // connection reads the book; the local and B's do not.
    f.open(Owner::Account(A.into()));
    reads_the_open_book(&f, Kind::Legacy).await;
    sees_no_book(&f, Kind::Local).await;
    sees_no_book(&f, Kind::Account).await;

    // Signed out: the local library.
    f.open(Owner::Local);
    reads_the_open_book(&f, Kind::Local).await;
    sees_no_book(&f, Kind::Account).await;

    // Account B's library: B's connection, and not the local one.
    f.open(Owner::Account(format!(" {B} ")));
    reads_the_open_book(&f, Kind::Account).await;
    sees_no_book(&f, Kind::Local).await;

    // An owner that cannot be told reaches no 0.1 library's folder.
    f.v1.attach(None, Some(f.book.clone()), None);
    sees_no_book(&f, Kind::Account).await;
    f.finish().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn macos_each_0_1_library_kind_keeps_its_connection_for_its_owners_books() {
    each_library_kind_reaches_its_owners_books_and_no_other(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn windows_each_0_1_library_kind_keeps_its_connection_for_its_owners_books() {
    each_library_kind_reaches_its_owners_books_and_no_other(true).await;
}

/// The same wire: B's client connected while A's library was open sees the
/// book once the author signs into B (after the switch is reported once),
/// and loses it again when the author switches away.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_waiting_in_another_library_follows_its_owner_in_and_out() {
    let f = Fixture::new(cfg!(not(unix))).await;
    f.open(Owner::Account(A.into()));
    let (client, bridging) = f.client(Kind::Account).await;
    let refused = call(&client, "entry.list", json!({"book": f.book})).await;
    assert!(
        text(&refused).contains("no book is open"),
        "{}",
        text(&refused)
    );
    f.open(Owner::Account(B.into()));
    let switched = call(&client, "entry.list", json!({"book": f.book})).await;
    assert!(
        text(&switched).contains("the open book changed"),
        "{}",
        text(&switched)
    );
    let read = call(&client, "entry.list", json!({"book": f.book})).await;
    assert_ne!(read.is_error, Some(true), "{}", text(&read));
    f.open(Owner::Local);
    let switched = call(&client, "entry.list", json!({"book": f.book})).await;
    assert_eq!(switched.is_error, Some(true));
    let refused = call(&client, "entry.list", json!({"book": f.book})).await;
    assert!(
        text(&refused).contains("no book is open"),
        "{}",
        text(&refused)
    );
    timeout(WAIT, client.cancel()).await.unwrap().unwrap();
    timeout(WAIT, bridging).await.unwrap().unwrap().unwrap();
    f.finish().await;
}

/// A credential is only good at its own folder's endpoint: B's token is
/// refused by the local library's listener and by the app's own one, so no
/// grant of one 0.1 library opens another's door.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_0_1_credential_is_refused_at_another_librarys_endpoint() {
    let f = Fixture::new(cfg!(not(unix))).await;
    f.open(Owner::Account(B.into()));
    let wire: Value =
        serde_json::from_slice(&std::fs::read(&f.connection(Kind::Account).file).unwrap()).unwrap();
    for other in [Kind::Local, Kind::Legacy] {
        let elsewhere = Credential::read_private(&f.connection(other).file).unwrap();
        let stream: LocalStream = transport::connect(elsewhere.endpoint()).await.unwrap();
        let (read, mut write) = tokio::io::split(stream);
        let mut read = BufReader::new(read);
        let mut line = serde_json::to_vec(&wire).unwrap();
        line.push(b'\n');
        write.write_all(&line).await.unwrap();
        let reply = timeout(
            WAIT,
            transport::read_line(&mut read, transport::HANDSHAKE_LIMIT),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let reply: Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(reply["ok"], false, "{other:?}");
    }
    assert!(f.scopes.lock().unwrap().is_empty());
    assert!(f.base.join("libraries.json").is_file());
    f.finish().await;
}

/// The negative control: serving only the app's own folder, as before the
/// 0.1 libraries' folders were served. The pre-registry library's client
/// still reads (its folder is the app's own), but the local and account
/// libraries' clients reach nothing: on macOS their sockets are not
/// listened on, on Windows their files name the port of 0.1's last launch.
async fn only_the_root_librarys_connection_reached_the_app(loopback: bool) {
    let f = Fixture::serving(loopback, false).await;
    f.open(Owner::Account(A.into()));
    reads_the_open_book(&f, Kind::Legacy).await;
    for kind in [Kind::Local, Kind::Account] {
        let credential = Credential::read_private(&f.file(kind)).unwrap();
        let (_client, pipes) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(pipes);
        let refused = timeout(WAIT, bridge::forward(credential, read, write))
            .await
            .unwrap()
            .unwrap_err();
        assert!(refused.contains("not listening"), "{kind:?}: {refused}");
    }
    f.finish().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn macos_before_only_the_root_librarys_connection_reached_the_app() {
    only_the_root_librarys_connection_reached_the_app(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn windows_before_only_the_root_librarys_connection_reached_the_app() {
    only_the_root_librarys_connection_reached_the_app(true).await;
}
