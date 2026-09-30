//! Local inbound MCP. The renderer owns all domain execution; this module only
//! owns credentials, private IPC, connection lifetime and bounded JSON framing.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, State};

#[cfg(target_os = "macos")]
mod client_config;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Client {
    Codex,
    ClaudeCode,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installation {
    client: Client,
    config_path: std::path::PathBuf,
    server_name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub access: String,
    pub allow_dangerous: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installation: Option<Installation>,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    token_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    name: String,
    project_id: String,
    access: String,
    allow_dangerous: bool,
}

#[cfg(target_os = "macos")]
mod local {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        collections::{HashMap, HashSet},
        fs::{self, OpenOptions},
        io::{BufRead, BufReader, Read, Write},
        os::unix::{
            fs::{OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
        path::{Path, PathBuf},
        sync::{mpsc, Arc, Mutex},
        thread,
        time::Duration,
    };
    use tauri::Manager;

    const MAX_FRAME: usize = 4 * 1024 * 1024;
    const MAX_REQUEST: usize = 1024 * 1024;
    const LIMIT: usize = 32;

    #[derive(Clone)]
    struct Bridge {
        epoch: String,
        project: String,
        channel: Channel<Value>,
    }
    struct Pending {
        connection: String,
        session: String,
        client_id: Value,
        bridge: Bridge,
        sender: mpsc::Sender<Value>,
    }
    #[derive(Default)]
    struct Inner {
        grants: Vec<Grant>,
        bridge: Option<Bridge>,
        pending: HashMap<String, Pending>,
        connections: usize,
        sessions: HashMap<String, HashSet<String>>,
    }
    pub struct Server {
        directory: PathBuf,
        inner: Mutex<Inner>,
    }
    #[derive(Default)]
    pub struct McpServerState(pub Mutex<Option<Arc<Server>>>);

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Credential {
        version: u32,
        socket_path: PathBuf,
        connection_id: String,
        token: String,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Registry {
        version: u32,
        grants: Vec<Grant>,
    }

    pub(super) fn random_id() -> Result<String, String> {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|_| "Could not generate MCP credential")?;
        Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
    fn hash(token: &str) -> String {
        format!("{:x}", Sha256::digest(token.as_bytes()))
    }
    fn matches_hash(a: &str, b: &str) -> bool {
        a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
    }
    fn private_directory(path: &Path) -> Result<(), String> {
        if !path.exists() {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(path)
                .map_err(|e| e.to_string())?;
        }
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
            return Err("MCP directory must be private to this OS user and not a symlink".into());
        }
        Ok(())
    }
    fn read_private(path: &Path) -> Result<Vec<u8>, String> {
        let meta = fs::symlink_metadata(path)
            .map_err(|_| "MCP connection file is missing; create a connection in Drifting")?;
        if !meta.is_file()
            || meta.permissions().mode() & 0o077 != 0
            || meta.len() > MAX_FRAME as u64
        {
            return Err("MCP connection file must be a private regular file".into());
        }
        fs::read(path).map_err(|e| e.to_string())
    }
    fn write_private(path: &Path, value: &impl Serialize) -> Result<(), String> {
        if let Ok(meta) = fs::symlink_metadata(path) {
            if !meta.is_file() {
                return Err("MCP storage refuses non-regular files".into());
            }
        }
        let temp = path.with_extension(format!("{}.tmp", random_id()?));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            fs::rename(&temp, path).map_err(|e| e.to_string())?;
            fs::File::open(path.parent().ok_or("Missing MCP directory")?)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }

    impl Server {
        fn start(directory: PathBuf) -> Result<Arc<Self>, String> {
            private_directory(&directory)?;
            let registry_path = directory.join("grants.json");
            let grants = if registry_path.exists() {
                let registry: Registry = serde_json::from_slice(&read_private(&registry_path)?)
                    .map_err(|_| "Invalid MCP grant registry")?;
                if registry.version != 1 {
                    return Err("Unsupported MCP grant registry".into());
                }
                registry.grants
            } else {
                Vec::new()
            };
            let socket = directory.join("bridge.sock");
            if socket.as_os_str().len() > 103 {
                return Err("MCP application data path is too long for local IPC".into());
            }
            if let Ok(meta) = fs::symlink_metadata(&socket) {
                use std::os::unix::fs::FileTypeExt;
                if !meta.file_type().is_socket() {
                    return Err("MCP socket path is occupied".into());
                }
                if UnixStream::connect(&socket).is_ok() {
                    return Err("Another Drifting MCP bridge is running".into());
                }
                fs::remove_file(&socket).map_err(|e| e.to_string())?;
            }
            let listener = UnixListener::bind(&socket).map_err(|e| e.to_string())?;
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
            let server = Arc::new(Self {
                directory,
                inner: Mutex::new(Inner {
                    grants,
                    ..Inner::default()
                }),
            });
            let shared = server.clone();
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let mut inner = shared.inner.lock().unwrap();
                    if inner.connections >= LIMIT {
                        continue;
                    }
                    inner.connections += 1;
                    drop(inner);
                    let server = shared.clone();
                    thread::spawn(move || {
                        let _ = serve_connection(&server, stream);
                        server.inner.lock().unwrap().connections -= 1;
                    });
                }
            });
            Ok(server)
        }
        fn persist(&self, grants: &[Grant]) -> Result<(), String> {
            write_private(
                &self.directory.join("grants.json"),
                &Registry {
                    version: 1,
                    grants: grants.to_vec(),
                },
            )
        }
        fn config_path(&self, id: &str) -> PathBuf {
            self.directory.join(format!("connection-{id}.json"))
        }
        fn describe(&self, grant: &Grant) -> Result<Value, String> {
            let mut public = grant.clone();
            public.token_hash.clear();
            Ok(serde_json::json!({"grant": public, "config": {
                "command": std::env::current_exe().map_err(|e| e.to_string())?,
                "args": ["--mcp", "--connection", self.config_path(&grant.id)]
            }}))
        }
        fn cancel_matching(&self, predicate: impl Fn(&Pending) -> bool, reason: &str) {
            let mut inner = self.inner.lock().unwrap();
            let ids: Vec<_> = inner
                .pending
                .iter()
                .filter(|(_, p)| predicate(p))
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(p) = inner.pending.remove(&id) {
                    let _ = p
                        .bridge
                        .channel
                        .send(serde_json::json!({"type":"cancel", "requestId":id}));
                    let _ = p.sender.send(rpc_error(&p.client_id, -32000, reason));
                }
            }
        }
    }

    fn server(app: &tauri::AppHandle, state: &McpServerState) -> Result<Arc<Server>, String> {
        let mut slot = state.0.lock().map_err(|_| "MCP state unavailable")?;
        if let Some(server) = slot.as_ref() {
            return Ok(server.clone());
        }
        let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let server = Server::start(root.join("mcp"))?;
        *slot = Some(server.clone());
        Ok(server)
    }
    pub fn list(app: &tauri::AppHandle, state: &McpServerState) -> Result<Vec<Value>, String> {
        let server = server(app, state)?;
        let inner = server.inner.lock().unwrap();
        inner
            .grants
            .iter()
            .map(|grant| server.describe(grant))
            .collect()
    }
    pub fn create(
        app: &tauri::AppHandle,
        state: &McpServerState,
        input: CreateInput,
    ) -> Result<Value, String> {
        create_connection(&server(app, state)?, input, None)
    }
    pub fn connect(
        app: &tauri::AppHandle,
        state: &McpServerState,
        input: CreateInput,
        client: Client,
    ) -> Result<Value, String> {
        let home = app
            .path()
            .home_dir()
            .map_err(|_| "Could not find this user's home directory")?;
        let config_path = match client {
            Client::Codex => {
                let root = std::env::var_os("CODEX_HOME")
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".codex"));
                if !root.is_absolute() {
                    return Err("CODEX_HOME must be an absolute path".into());
                }
                root.join("config.toml")
            }
            Client::ClaudeCode => {
                if std::env::var_os("CLAUDE_CONFIG_DIR")
                    .filter(|s| !s.is_empty())
                    .is_some_and(|p| PathBuf::from(p) != home.join(".claude"))
                {
                    return Err("Use manual configuration for a custom CLAUDE_CONFIG_DIR".into());
                }
                home.join(".claude.json")
            }
        };
        let server = server(app, state)?;
        let name_hash = hash(&format!(
            "{}\0{}",
            server.directory.display(),
            input.project_id
        ));
        let installation = Installation {
            client,
            config_path,
            server_name: format!("drifting_{}", &name_hash[..16]),
        };
        create_connection(&server, input, Some(installation))
    }
    fn create_connection(
        server: &Arc<Server>,
        input: CreateInput,
        installation: Option<Installation>,
    ) -> Result<Value, String> {
        if input.name.trim().is_empty()
            || input.name.len() > 120
            || input.project_id.is_empty()
            || input.project_id.len() > 128
            || !["read", "write"].contains(&input.access.as_str())
            || (input.access == "read" && input.allow_dangerous)
        {
            return Err("Invalid MCP connection scope".into());
        }
        let mut inner = server.inner.lock().unwrap();
        if inner.bridge.as_ref().map(|b| b.project.as_str()) != Some(input.project_id.as_str()) {
            return Err("Open this project before authorizing MCP".into());
        }
        if let Some(installation) = &installation {
            if let Some(grant) = inner
                .grants
                .iter()
                .find(|g| g.installation.as_ref() == Some(installation))
            {
                if grant.access != input.access || grant.allow_dangerous != input.allow_dangerous {
                    return Err(
                        "Revoke the existing connection before changing its permissions".into(),
                    );
                }
                let description = server.describe(grant)?;
                client_config::update(installation, &description["config"], false)?;
                return Ok(description);
            }
        }
        if inner.grants.len() >= 32 {
            return Err("Revoke an unused MCP connection first".into());
        }
        let token = random_id()?;
        let grant = Grant {
            id: random_id()?,
            name: input.name.trim().into(),
            project_id: input.project_id,
            access: input.access,
            allow_dangerous: input.allow_dangerous,
            installation,
            token_hash: hash(&token),
        };
        let mut grants = inner.grants.clone();
        grants.push(grant.clone());
        let credential = Credential {
            version: 1,
            socket_path: server.directory.join("bridge.sock"),
            connection_id: grant.id.clone(),
            token,
        };
        write_private(&server.config_path(&grant.id), &credential)?;
        if let Err(error) = server.persist(&grants) {
            let _ = fs::remove_file(server.config_path(&grant.id));
            return Err(error);
        }
        let description = server.describe(&grant)?;
        if let Some(installation) = &grant.installation {
            if let Err(error) = client_config::update(installation, &description["config"], false) {
                let rollback = server.persist(&inner.grants);
                let _ = fs::remove_file(server.config_path(&grant.id));
                if rollback.is_err() {
                    inner.grants = grants;
                    return Err(format!("{error}. The unused connection could not be removed; revoke it in Drifting"));
                }
                return Err(error);
            }
        }
        inner.grants = grants;
        Ok(description)
    }
    pub fn revoke(
        app: &tauri::AppHandle,
        state: &McpServerState,
        id: String,
    ) -> Result<Option<String>, String> {
        let server = server(app, state)?;
        revoke_connection(&server, &id)
    }
    fn revoke_connection(server: &Arc<Server>, id: &str) -> Result<Option<String>, String> {
        let revoked = {
            let mut inner = server.inner.lock().unwrap();
            let revoked = inner
                .grants
                .iter()
                .find(|g| g.id == id)
                .cloned()
                .ok_or("MCP connection does not exist")?;
            let grants: Vec<_> = inner
                .grants
                .iter()
                .filter(|g| g.id != id)
                .cloned()
                .collect();
            server.persist(&grants)?;
            inner.grants = grants;
            revoked
        };
        server.cancel_matching(|p| p.connection == id, "MCP connection revoked");
        let _ = fs::remove_file(server.config_path(id));
        // Revocation must succeed even if an external config was moved or edited.
        let cleanup = revoked
            .installation
            .as_ref()
            .map(|installation| {
                client_config::update(installation, &server.describe(&revoked)?["config"], true)
            })
            .transpose();
        Ok(cleanup.err())
    }
    pub fn attach(
        app: &tauri::AppHandle,
        state: &McpServerState,
        project: String,
        channel: Channel<Value>,
    ) -> Result<String, String> {
        let server = server(app, state)?;
        server.cancel_matching(
            |_| true,
            "Drifting project changed; read again before writing",
        );
        let epoch = random_id()?;
        server.inner.lock().unwrap().bridge = Some(Bridge {
            epoch: epoch.clone(),
            project,
            channel,
        });
        Ok(epoch)
    }
    pub fn detach(state: &McpServerState, epoch: &str) {
        let slot = state.0.lock().unwrap();
        if let Some(server) = slot.as_ref() {
            let mut inner = server.inner.lock().unwrap();
            if inner.bridge.as_ref().map(|b| b.epoch.as_str()) == Some(epoch) {
                inner.bridge = None;
            }
            drop(inner);
            server.cancel_matching(
                |p| p.bridge.epoch == epoch,
                "Open the authorized project in Drifting",
            );
        }
    }
    pub fn complete(
        state: &McpServerState,
        epoch: &str,
        request_id: &str,
        response: Value,
    ) -> Result<(), String> {
        if response.to_string().len() > MAX_FRAME {
            return Err("MCP response exceeds limit".into());
        }
        let slot = state.0.lock().unwrap();
        let server = slot.as_ref().ok_or("MCP bridge unavailable")?;
        let mut inner = server.inner.lock().unwrap();
        if inner
            .pending
            .get(request_id)
            .map(|p| p.bridge.epoch.as_str())
            != Some(epoch)
        {
            return Ok(());
        }
        if let Some(p) = inner.pending.remove(request_id) {
            let _ = p.sender.send(response);
        }
        Ok(())
    }
    fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
        serde_json::json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
    }
    fn write_frame(stream: &mut impl Write, value: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut *stream, value).map_err(|e| e.to_string())?;
        stream
            .write_all(b"\n")
            .and_then(|_| stream.flush())
            .map_err(|e| e.to_string())
    }
    fn read_frame(reader: &mut impl BufRead, max: usize) -> Result<Option<Value>, String> {
        let mut bytes = Vec::new();
        let n = reader
            .take(max as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        if n > max || bytes.last() != Some(&b'\n') {
            return Err("MCP frame is too large or incomplete".into());
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Invalid MCP JSON".into())
    }
    fn serve_connection(server: &Arc<Server>, stream: UnixStream) -> Result<(), String> {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let credential: Credential =
            serde_json::from_value(read_frame(&mut reader, 4096)?.ok_or("Missing credential")?)
                .map_err(|_| "Invalid credential")?;
        let grant = server
            .inner
            .lock()
            .unwrap()
            .grants
            .iter()
            .find(|g| {
                g.id == credential.connection_id
                    && matches_hash(&g.token_hash, &hash(&credential.token))
            })
            .cloned();
        let mut stream = stream;
        if grant.is_none() {
            write_frame(&mut stream, &serde_json::json!({"ok":false}))?;
            return Err("MCP credential rejected".into());
        }
        write_frame(&mut stream, &serde_json::json!({"ok":true}))?;
        stream.set_read_timeout(None).map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(stream));
        let grant = grant.unwrap();
        let session = format!("mcp:{}", random_id()?);
        server
            .inner
            .lock()
            .unwrap()
            .sessions
            .insert(session.clone(), HashSet::new());
        let mut initialized = false;
        let mut ids = HashSet::new();
        let in_flight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let result = (|| {
            while let Some(request) = read_frame(&mut reader, MAX_REQUEST)? {
                let id = request.get("id").cloned();
                let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                if method == "notifications/cancelled" {
                    let target = &request["params"]["requestId"];
                    if let Some(cancelled) = server.inner.lock().unwrap().sessions.get_mut(&session)
                    {
                        if cancelled.len() < 100_000 {
                            cancelled.insert(target.to_string());
                        }
                    }
                    server.cancel_matching(
                        |p| p.session == session && &p.client_id == target,
                        "MCP request cancelled",
                    );
                    continue;
                }
                let Some(id) = id else {
                    continue;
                };
                if ids.len() >= 100_000 {
                    write_frame(
                        &mut *writer.lock().unwrap(),
                        &rpc_error(&id, -32000, "Reconnect MCP after 100000 requests"),
                    )?;
                    return Err("MCP connection request limit reached".into());
                }
                let immediate = if request["jsonrpc"] != "2.0"
                    || !(id.is_string() || id.is_i64() || id.is_u64())
                {
                    Some(rpc_error(&id, -32600, "Invalid JSON-RPC request"))
                } else if !ids.insert(id.to_string()) {
                    Some(rpc_error(
                        &id,
                        -32600,
                        "Duplicate request id; do not replay mutations",
                    ))
                } else if !server
                    .inner
                    .lock()
                    .unwrap()
                    .grants
                    .iter()
                    .any(|g| g.id == grant.id)
                {
                    Some(rpc_error(&id, -32001, "MCP connection revoked"))
                } else if method == "initialize" && !initialized {
                    initialized = true;
                    Some(serde_json::json!({"jsonrpc":"2.0","id":id,"result":{
                        "protocolVersion":"2025-11-25", "capabilities":{"tools":{}},
                        "serverInfo":{"name":"Drifting", "version":env!("CARGO_PKG_VERSION")},
                        "instructions":"Operate only on the authorized project, which must be open in Drifting. Read targets before modifying them; retain returned handles. Paginate using read_tool_result. After reconnect, read again. Never automatically retry an uncertain write. Changes use the app's live Yjs and review system."
                    }}))
                } else if !initialized {
                    Some(rpc_error(&id, -32000, "Initialize first"))
                } else if method == "ping" {
                    Some(serde_json::json!({"jsonrpc":"2.0","id":id,"result":{}}))
                } else if !["tools/list", "tools/call"].contains(&method) {
                    Some(rpc_error(&id, -32601, "Method not found"))
                } else {
                    None
                };
                if let Some(response) = immediate {
                    write_frame(&mut *writer.lock().unwrap(), &response)?;
                    continue;
                }
                if ids.len() > 100_000 {
                    return Err("Reconnect MCP after 100000 requests".into());
                }
                if in_flight.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= LIMIT {
                    in_flight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    write_frame(
                        &mut *writer.lock().unwrap(),
                        &rpc_error(&id, -32000, "Too many active requests"),
                    )?;
                    continue;
                }
                let in_flight = in_flight.clone();
                let server = server.clone();
                let writer = writer.clone();
                let grant = grant.clone();
                let session = session.clone();
                thread::spawn(move || {
                    let response = dispatch(&server, &grant, &session, request);
                    let _ = write_frame(&mut *writer.lock().unwrap(), &response);
                    in_flight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                });
            }
            Ok(())
        })();
        server.inner.lock().unwrap().sessions.remove(&session);
        server.cancel_matching(|p| p.session == session, "MCP client disconnected");
        if let Some(bridge) = server.inner.lock().unwrap().bridge.as_ref() {
            let _ = bridge
                .channel
                .send(serde_json::json!({"type":"closed", "sessionId":session}));
        }
        result
    }
    fn dispatch(server: &Server, grant: &Grant, session: &str, request: Value) -> Value {
        let id = request["id"].clone();
        let request_id = match random_id() {
            Ok(id) => id,
            Err(e) => return rpc_error(&id, -32603, &e),
        };
        let (sender, receiver) = mpsc::channel();
        {
            let mut inner = server.inner.lock().unwrap();
            if !inner.grants.iter().any(|g| g.id == grant.id) {
                return rpc_error(&id, -32001, "MCP connection revoked");
            }
            if inner
                .sessions
                .get(session)
                .is_none_or(|cancelled| cancelled.contains(&id.to_string()))
            {
                return rpc_error(&id, -32000, "MCP request cancelled or connection closed");
            }
            let Some(bridge) = inner
                .bridge
                .clone()
                .filter(|b| b.project == grant.project_id)
            else {
                return rpc_error(
                    &id,
                    -32002,
                    "Open the authorized project in Drifting before using its tools",
                );
            };
            if inner.pending.len() >= LIMIT {
                return rpc_error(&id, -32000, "Too many active MCP requests");
            }
            let mut public = grant.clone();
            public.token_hash.clear();
            let event = serde_json::json!({"type":"request", "requestId":request_id, "sessionId":session,
                "epoch":bridge.epoch, "grant":public, "request":request});
            inner.pending.insert(
                request_id.clone(),
                Pending {
                    connection: grant.id.clone(),
                    session: session.into(),
                    client_id: id.clone(),
                    bridge: bridge.clone(),
                    sender,
                },
            );
            if bridge.channel.send(event).is_err() {
                inner.pending.remove(&request_id);
                return rpc_error(&id, -32002, "Drifting renderer unavailable");
            }
        }
        match receiver.recv_timeout(Duration::from_secs(120)) {
            Ok(result) => result,
            Err(_) => {
                server.cancel_matching(
                    |p| p.session == session && p.client_id == id,
                    "MCP request timed out; inspect before retrying a write",
                );
                rpc_error(
                    &id,
                    -32000,
                    "MCP request timed out; inspect before retrying a write",
                )
            }
        }
    }

    pub fn cli(path: &Path) -> Result<(), String> {
        let credential: Credential = serde_json::from_slice(&read_private(path)?)
            .map_err(|_| "Invalid MCP connection file")?;
        if credential.version != 1 {
            return Err("Unsupported MCP connection file".into());
        }
        let mut stream = UnixStream::connect(&credential.socket_path)
            .map_err(|_| "Open Drifting and the authorized project, then reconnect MCP")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        write_frame(
            &mut stream,
            &serde_json::to_value(credential).map_err(|e| e.to_string())?,
        )?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        if read_frame(&mut reader, 4096)?
            .as_ref()
            .and_then(|v| v["ok"].as_bool())
            != Some(true)
        {
            return Err(
                "MCP connection revoked or invalid; authorize a new connection in Drifting".into(),
            );
        }
        stream.set_read_timeout(None).map_err(|e| e.to_string())?;
        let input_stream = stream.try_clone().map_err(|e| e.to_string())?;
        thread::spawn(move || {
            let mut input = std::io::stdin().lock();
            let mut stream = input_stream;
            while let Ok(Some(value)) = read_frame(&mut input, MAX_REQUEST) {
                if write_frame(&mut stream, &value).is_err() {
                    break;
                }
            }
            let _ = stream.shutdown(std::net::Shutdown::Write);
        });
        let mut stdout = std::io::stdout().lock();
        while let Some(value) = read_frame(&mut reader, MAX_FRAME)? {
            write_frame(&mut stdout, &value)?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn fixture() -> (tempfile::TempDir, Arc<Server>, Grant, Credential) {
            let dir = tempfile::tempdir_in("/tmp").unwrap();
            let server = Server::start(dir.path().join("mcp")).unwrap();
            let grant = Grant {
                id: "synthetic-connection".into(),
                name: "Synthetic agent".into(),
                project_id: "synthetic-project".into(),
                access: "read".into(),
                allow_dangerous: false,
                token_hash: hash("synthetic-token"),
                installation: None,
            };
            server.persist(&[grant.clone()]).unwrap();
            server.inner.lock().unwrap().grants.push(grant.clone());
            let credential = Credential {
                version: 1,
                socket_path: server.directory.join("bridge.sock"),
                connection_id: grant.id.clone(),
                token: "synthetic-token".into(),
            };
            (dir, server, grant, credential)
        }
        fn connect(credential: &Credential) -> BufReader<UnixStream> {
            let stream = UnixStream::connect(&credential.socket_path).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            write_frame(reader.get_mut(), &serde_json::to_value(credential).unwrap()).unwrap();
            reader
        }
        fn request(reader: &mut BufReader<UnixStream>, id: u32, method: &str) -> Value {
            write_frame(
                reader.get_mut(),
                &serde_json::json!({"jsonrpc":"2.0","id":id,"method":method}),
            )
            .unwrap();
            read_frame(reader, MAX_FRAME).unwrap().unwrap()
        }
        fn synthetic_input() -> CreateInput {
            CreateInput {
                name: "Synthetic client".into(),
                project_id: "synthetic-project".into(),
                access: "read".into(),
                allow_dangerous: false,
            }
        }
        fn mount_synthetic_project(server: &Arc<Server>) {
            server.inner.lock().unwrap().bridge = Some(Bridge {
                epoch: "synthetic-epoch".into(),
                project: "synthetic-project".into(),
                channel: Channel::new(|_| Ok(())),
            });
        }
        #[test]
        fn one_click_connections_are_idempotent_scoped_and_removed_on_revoke() {
            for client in [Client::Codex, Client::ClaudeCode] {
                let (dir, server, _, _) = fixture();
                mount_synthetic_project(&server);
                let installation = Installation {
                    client,
                    config_path: dir.path().join("client-config"),
                    server_name: "drifting_test".into(),
                };
                let first =
                    create_connection(&server, synthetic_input(), Some(installation.clone()))
                        .unwrap();
                let second =
                    create_connection(&server, synthetic_input(), Some(installation.clone()))
                        .unwrap();
                assert_eq!(first, second);
                assert_eq!(server.inner.lock().unwrap().grants.len(), 2);
                let mut changed = synthetic_input();
                changed.access = "write".into();
                assert!(create_connection(&server, changed, Some(installation.clone())).is_err());
                let id = first["grant"]["id"].as_str().unwrap();
                assert!(revoke_connection(&server, id).unwrap().is_none());
                assert!(!server.config_path(id).exists());
                assert!(!fs::read_to_string(&installation.config_path)
                    .unwrap()
                    .contains("drifting_test"));
                assert_eq!(server.inner.lock().unwrap().grants.len(), 1);
            }
        }
        #[test]
        fn failed_installation_rolls_back_grant_and_credentials_without_touching_config() {
            let (dir, server, _, _) = fixture();
            let installation = Installation {
                client: Client::Codex,
                config_path: dir.path().join("config.toml"),
                server_name: "drifting_test".into(),
            };
            assert!(
                create_connection(&server, synthetic_input(), Some(installation.clone())).is_err()
            );
            assert!(!installation.config_path.exists());
            mount_synthetic_project(&server);
            fs::write(&installation.config_path, "[broken").unwrap();
            assert!(
                create_connection(&server, synthetic_input(), Some(installation.clone())).is_err()
            );
            assert_eq!(
                fs::read_to_string(&installation.config_path).unwrap(),
                "[broken"
            );
            assert_eq!(server.inner.lock().unwrap().grants.len(), 1);
            let registry: Registry = serde_json::from_slice(
                &read_private(&server.directory.join("grants.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(registry.grants.len(), 1);
            assert_eq!(
                fs::read_dir(&server.directory)
                    .unwrap()
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("connection-"))
                    .count(),
                0
            );
        }
        #[test]
        fn changed_client_configuration_does_not_block_access_revocation() {
            let (dir, server, _, _) = fixture();
            mount_synthetic_project(&server);
            let installation = Installation {
                client: Client::ClaudeCode,
                config_path: dir.path().join("client.json"),
                server_name: "drifting_test".into(),
            };
            let connection =
                create_connection(&server, synthetic_input(), Some(installation.clone())).unwrap();
            let replacement = r#"{"mcpServers":{"drifting_test":{"command":"other","args":[]}}}"#;
            fs::write(&installation.config_path, replacement).unwrap();
            let id = connection["grant"]["id"].as_str().unwrap();
            assert!(revoke_connection(&server, id).unwrap().is_some());
            assert!(!server.config_path(id).exists());
            assert!(server
                .inner
                .lock()
                .unwrap()
                .grants
                .iter()
                .all(|g| g.id != id));
            assert_eq!(
                fs::read_to_string(installation.config_path).unwrap(),
                replacement
            );
        }
        #[test]
        fn socket_authentication_project_scope_revocation_and_duplicate_ids() {
            let (_dir, server, _grant, mut credential) = fixture();
            credential.token = "incorrect".into();
            assert_eq!(
                read_frame(&mut connect(&credential), MAX_FRAME)
                    .unwrap()
                    .unwrap()["ok"],
                false
            );
            credential.token = "synthetic-token".into();
            let mut client = connect(&credential);
            assert_eq!(
                read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["ok"],
                true
            );
            assert_eq!(
                request(&mut client, 1, "initialize")["result"]["protocolVersion"],
                "2025-11-25"
            );
            assert_eq!(
                request(&mut client, 2, "tools/list")["error"]["code"],
                -32002
            );
            server.inner.lock().unwrap().bridge = Some(Bridge {
                epoch: "e".into(),
                project: "other-project".into(),
                channel: Channel::new(|_| panic!("Wrong-project request reached renderer")),
            });
            assert_eq!(
                request(&mut client, 3, "tools/list")["error"]["code"],
                -32002
            );
            assert_eq!(request(&mut client, 3, "ping")["error"]["code"], -32600);
            server.inner.lock().unwrap().grants.clear();
            assert_eq!(
                request(&mut client, 4, "tools/list")["error"]["code"],
                -32001
            );
        }
        #[test]
        fn renderer_dispatch_preserves_authorized_scope_and_cancellation() {
            let (_dir, server, grant, credential) = fixture();
            let (tx, rx) = mpsc::channel();
            server.inner.lock().unwrap().bridge = Some(Bridge {
                epoch: "e".into(),
                project: grant.project_id,
                channel: Channel::new(move |body| {
                    if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                        tx.send(serde_json::from_str::<Value>(&body).unwrap())
                            .unwrap();
                    }
                    Ok(())
                }),
            });
            let mut client = connect(&credential);
            read_frame(&mut client, MAX_FRAME).unwrap();
            request(&mut client, 1, "initialize");
            write_frame(
                client.get_mut(),
                &serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
                "params":{"name":"create_chapter","access":"write","projectId":"other"}}),
            )
            .unwrap();
            let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(event["grant"]["access"], "read");
            assert_eq!(event["grant"]["projectId"], "synthetic-project");
            assert!(event["grant"].get("tokenHash").is_none());
            write_frame(
                client.get_mut(),
                &serde_json::json!({"jsonrpc":"2.0","method":"notifications/cancelled",
                "params":{"requestId":2}}),
            )
            .unwrap();
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
                "cancel"
            );
            assert_eq!(
                read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["error"]["code"],
                -32000
            );
            assert!(server.inner.lock().unwrap().pending.is_empty());
        }
        #[test]
        fn private_credentials_reject_symlinks_and_public_permissions() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("secret.json");
            write_private(&path, &serde_json::json!({"value":"synthetic"})).unwrap();
            assert!(read_private(&path).is_ok());
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(read_private(&link).is_err());
            assert!(write_private(&link, &true).is_err());
            fs::set_permissions(path.clone(), fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_private(&path).is_err());
        }
        #[test]
        fn framing_is_bounded_and_hashes_do_not_accept_partial_credentials() {
            assert!(read_frame(&mut &b"{\"a\":1}\n"[..], 128).unwrap().is_some());
            assert!(read_frame(&mut &b"{\"a\":1}"[..], 128).is_err());
            assert!(read_frame(&mut &b"{\"a\":1}\n"[..], 4).is_err());
            assert!(matches_hash(&hash("one"), &hash("one")));
            assert!(!matches_hash(&hash("one"), &hash("two")));
        }
    }
}

#[cfg(target_os = "macos")]
pub use local::McpServerState;
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct McpServerState;

pub fn run_stdio_cli() -> Option<Result<(), String>> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--mcp") {
        return None;
    }
    #[cfg(target_os = "macos")]
    if args.len() == 4 && args[2] == "--connection" {
        return Some(local::cli(std::path::Path::new(&args[3])));
    }
    Some(Err(
        "Usage on macOS: Drifting --mcp --connection <connection-file>".into(),
    ))
}

#[tauri::command]
pub fn mcp_server_list(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
) -> Result<Vec<Value>, String> {
    #[cfg(target_os = "macos")]
    return local::list(&app, &state);
    #[cfg(not(target_os = "macos"))]
    Err("Local MCP is available on macOS".into())
}
#[tauri::command]
pub fn mcp_server_create(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    input: CreateInput,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return local::create(&app, &state, input);
    #[cfg(not(target_os = "macos"))]
    Err("Local MCP is available on macOS".into())
}
#[tauri::command]
pub fn mcp_server_connect(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    input: CreateInput,
    client: Client,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    return local::connect(&app, &state, input, client);
    #[cfg(not(target_os = "macos"))]
    Err("Local MCP is available on macOS".into())
}
#[tauri::command]
pub fn mcp_server_revoke(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    id: String,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    return local::revoke(&app, &state, id);
    #[cfg(not(target_os = "macos"))]
    Err("Local MCP is available on macOS".into())
}
#[tauri::command]
pub fn mcp_server_attach(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    project_id: String,
    on_event: Channel<Value>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return local::attach(&app, &state, project_id, on_event);
    #[cfg(not(target_os = "macos"))]
    Err("Local MCP is available on macOS".into())
}
#[tauri::command]
pub fn mcp_server_detach(state: State<'_, McpServerState>, epoch: String) {
    #[cfg(target_os = "macos")]
    local::detach(&state, &epoch);
}
#[tauri::command]
pub fn mcp_server_complete(
    state: State<'_, McpServerState>,
    epoch: String,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return local::complete(&state, &epoch, &request_id, response);
    #[cfg(not(target_os = "macos"))]
    Err("Local MCP is available on macOS".into())
}
