//! An external Agent configured by the 0.1 client, after the in-place
//! update: an MCP client starts the command and arguments of the entry 0.1
//! wrote (here the executable path names this build of `drifting`, as the
//! update keeps 0.1's path), and through it reads the book open in the app.
//!
//! The 0.1 data folder is synthetic (dr-mcp's `support/v1.rs`): the
//! pre-registry library owned by account A at the root, a local library and
//! account B's library under `libraries/<id>`, each with one connection. The
//! app side is what `dr_view_agent::mcp` serves: its own folder, the 0.1
//! data folder's `mcp/`, and the other libraries' folders, which see the
//! book only while their owner's library is the open one.

#[path = "../../../crates/dr-mcp/tests/support/v1.rs"]
mod v1_mcp;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use dr_agent::{ExternalScope, Options, Runtime, driver::scripted::ScriptedDriver};
use dr_agent_tools::AgentTools;
use dr_mcp::{
    ClientPaths, GrantPaths,
    host::{Backend, CatalogSource, Host, ScopeOpener},
    inbound,
    v1::{self, Connections, Owner},
};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt as _, future::join_all};
use rmcp::{
    RoleClient, ServiceExt as _,
    model::{CallToolRequestParams, CallToolResult},
    service::RunningService,
    transport::TokioChildProcess,
};
use serde_json::{Value, json};
use tokio::{runtime::Handle, time::timeout};

const WAIT: Duration = Duration::from_secs(20);
const A: &str = "synthetic-subject-a";
const B: &str = "synthetic-subject-b";

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

#[cfg(unix)]
fn endpoint(directory: &Path, short: &Path) -> String {
    v1_mcp::socket(directory, short).display().to_string()
}
#[cfg(not(unix))]
fn endpoint(_: &Path, _: &Path) -> String {
    v1_mcp::closed_port()
}

/// The client an Agent runs from `connection`'s entry under `home`.
async fn start(home: &Path, connection: &v1_mcp::Connection) -> RunningService<RoleClient, ()> {
    let (command, args) = v1_mcp::launch(home, connection);
    let mut process = tokio::process::Command::new(command);
    process.args(args);
    let transport = TokioChildProcess::new(process).unwrap();
    timeout(WAIT, ().serve(transport)).await.unwrap().unwrap()
}

async fn read(client: &RunningService<RoleClient, ()>, book: &str) -> CallToolResult {
    timeout(
        WAIT,
        client.call_tool(
            CallToolRequestParams::new("entry.list")
                .with_arguments(json!({"book": book}).as_object().unwrap().clone()),
        ),
    )
    .await
    .unwrap()
    .unwrap()
}

fn text(result: &CallToolResult) -> &str {
    &result.content[0].as_text().unwrap().text
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_configured_by_0_1_reads_its_owners_book_through_the_updated_executable() {
    #[cfg(unix)]
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    #[cfg(not(unix))]
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let short = dir.path().join("cache");
    let base = dir.path().join("local/cc.drifting.client");
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_drifting"));
    let account = v1_mcp::account_library(B);
    v1_mcp::registry(
        &base,
        "legacy",
        &[
            ("legacy", Some(Some(A))),
            ("local", Some(None)),
            (account.as_str(), Some(Some(B))),
        ],
    );
    let mut made = Vec::new();
    for (name, root, client) in [
        ("legacy", base.clone(), v1_mcp::Client::Codex),
        (
            "local",
            base.join("libraries/local"),
            v1_mcp::Client::ClaudeCode,
        ),
        (
            "account",
            base.join("libraries").join(&account),
            v1_mcp::Client::ClaudeCode,
        ),
    ] {
        let directory = root.join("mcp");
        let at = endpoint(&directory, &short);
        made.push((
            name,
            v1_mcp::connect(&directory, &at, &home, &executable, client, name),
        ));
    }
    let connection = |name: &str| made.iter().find(|(n, _)| *n == name).unwrap().1.clone();

    let lib = dr_store::Library::open(
        dir.path().join("next-library"),
        library_options("m32-v1-executable"),
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
    let scopes = Arc::new(Mutex::new(Vec::new()));

    let paths = GrantPaths::new(
        base.join("mcp"),
        executable.clone(),
        ClientPaths::from_home(home.clone(), None, None),
    )
    .with_socket_root(short);
    let host = Host::new(Handle::current());
    let own = inbound::serve(paths.clone(), host.clone()).await.unwrap();
    let served = Connections::serve(
        v1::folders(&base, &paths.directory),
        &paths,
        &Handle::current(),
        async {}.boxed(),
    );
    for opened in served.opened().await {
        opened.unwrap();
    }
    let backend = Backend {
        opener: opener(runtime.clone(), scopes.clone()),
        catalog: catalog_source(tools.clone(), ws.clone()),
    };

    for (owner, reads, refused) in [
        (Owner::Account(A.into()), "legacy", "local"),
        (Owner::Local, "local", "account"),
        (Owner::Account(B.into()), "account", "local"),
    ] {
        host.replace(Some(book.clone()), Some(backend.clone()));
        served.attach(Some(&owner), Some(book.clone()), Some(backend.clone()));

        let client = start(&home, &connection(reads)).await;
        let result = read(&client, book.as_str()).await;
        assert_ne!(result.is_error, Some(true), "{reads}: {}", text(&result));
        let reply: Value = serde_json::from_str(text(&result)).unwrap();
        assert_eq!(reply["book"], book.as_str(), "{reads}");
        timeout(WAIT, client.cancel()).await.unwrap().unwrap();

        let opened = scopes.lock().unwrap().len();
        let client = start(&home, &connection(refused)).await;
        let result = read(&client, book.as_str()).await;
        assert_eq!(result.is_error, Some(true), "{refused} in {owner:?}");
        assert!(
            text(&result).contains("no book is open"),
            "{}",
            text(&result)
        );
        assert_eq!(
            scopes.lock().unwrap().len(),
            opened,
            "{refused} in {owner:?}"
        );
        timeout(WAIT, client.cancel()).await.unwrap().unwrap();
    }

    host.suspend();
    served.suspend();
    timeout(WAIT, own.server.close()).await.unwrap().unwrap();
    timeout(WAIT, served.close()).await.unwrap();
    let scopes = scopes.lock().unwrap().clone();
    for result in join_all(scopes.iter().map(ExternalScope::close)).await {
        result.unwrap();
    }
    runtime.drain_tools().await.unwrap();
    own.grants.drain().await.unwrap();
    served.drain().await.unwrap();
    drop((own, served, host, backend, runtime, tools));
    ws.try_shutdown().unwrap();
}
