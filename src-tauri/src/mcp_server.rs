//! Local inbound MCP. The renderer owns all domain execution; this module only
//! owns credentials, private IPC, connection lifetime and bounded JSON framing.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, State};

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod client_config;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Client {
    Codex,
    ClaudeCode,
    Antigravity,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub struct Installation {
    client: Client,
    config_path: std::path::PathBuf,
    server_name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub struct Grant {
    pub id: String,
    pub name: String,
    /// Connections reach whichever book is open in Drifting. One made before
    /// that, for a single book, stays limited to it until it is revoked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installation: Option<Installation>,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    token_hash: String,
    /// Every connection may use every tool. Until 2026-11-06 a connection was
    /// read-only, could write, or could also run destructive operations; a
    /// registry from then still names its tier, which is read and dropped.
    #[allow(dead_code)]
    #[serde(default, skip_serializing, rename = "access")]
    retired_access: Option<String>,
    #[allow(dead_code)]
    #[serde(default, skip_serializing, rename = "allowDangerous")]
    retired_allow_dangerous: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub struct CreateInput {
    name: String,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod local {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        collections::{HashMap, HashSet},
        fs::{self, OpenOptions},
        io::{BufRead, BufReader, Read, Write},
        path::{Path, PathBuf},
        sync::{mpsc, Arc, Mutex},
        thread,
        time::Duration,
    };
    use tauri::Manager;

    /// Windows clients reach the bridge over loopback TCP on a port chosen at
    /// each launch and written into every connection file; the connection's
    /// token authenticates each stream exactly as on the Unix socket.
    #[cfg(windows)]
    use std::net::{TcpListener as Listener, TcpStream as Stream};
    #[cfg(unix)]
    use std::os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        net::{UnixListener as Listener, UnixStream as Stream},
    };

    #[cfg(unix)]
    fn connect_endpoint(endpoint: &Path) -> std::io::Result<Stream> {
        Stream::connect(endpoint)
    }
    #[cfg(windows)]
    fn connect_endpoint(endpoint: &Path) -> std::io::Result<Stream> {
        Stream::connect(endpoint.to_string_lossy().as_ref())
    }

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
    struct Session {
        cancelled: HashSet<String>,
        /// The book this session's last request reached.
        book: Option<String>,
    }
    #[derive(Default)]
    struct Inner {
        grants: Vec<Grant>,
        bridge: Option<Bridge>,
        pending: HashMap<String, Pending>,
        connections: usize,
        sessions: HashMap<String, Session>,
    }
    pub struct Server {
        directory: PathBuf,
        /// Where clients connect: the Unix socket's path, or Windows'
        /// `127.0.0.1:<port>`.
        endpoint: PathBuf,
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
    /// Unix keeps the directory and its files to this OS user by mode; on
    /// Windows they live in the user's own app data, private by inherited ACL.
    #[cfg(unix)]
    fn shared_with_others(meta: &fs::Metadata) -> bool {
        meta.permissions().mode() & 0o077 != 0
    }
    #[cfg(not(unix))]
    fn shared_with_others(_meta: &fs::Metadata) -> bool {
        false
    }
    fn private_directory(path: &Path) -> Result<(), String> {
        if !path.exists() {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(path).map_err(|e| e.to_string())?;
        }
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() || shared_with_others(&meta) {
            return Err("MCP directory must be private to this OS user and not a symlink".into());
        }
        Ok(())
    }
    fn read_private(path: &Path) -> Result<Vec<u8>, String> {
        let meta = fs::symlink_metadata(path)
            .map_err(|_| "MCP connection file is missing; create a connection in Drifting")?;
        if !meta.is_file() || shared_with_others(&meta) || meta.len() > MAX_FRAME as u64 {
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
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temp).map_err(|e| e.to_string())?;
            file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            fs::rename(&temp, path).map_err(|e| e.to_string())?;
            drifting_core::file_io::sync_directory(path.parent().ok_or("Missing MCP directory")?)
                .map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }

    /// A Unix socket address holds at most 103 bytes of path.
    #[cfg(unix)]
    const MAX_SOCKET_PATH: usize = 103;
    #[cfg(unix)]
    const SOCKET_NAME: &str = "bridge.sock";
    /// The socket lives beside the connection files when its path fits. An
    /// account's library sits two folders deeper (`libraries/account-…/mcp`)
    /// and leaves no room, so its socket lives in a short private folder
    /// instead, named after the MCP directory: every launch binds the same
    /// path and the connection files keep naming it.
    #[cfg(unix)]
    fn socket_endpoint(
        directory: &Path,
        short_root: impl FnOnce() -> Result<PathBuf, String>,
    ) -> Result<PathBuf, String> {
        use std::os::unix::ffi::OsStrExt;
        let beside = directory.join(SOCKET_NAME);
        if beside.as_os_str().len() <= MAX_SOCKET_PATH {
            return Ok(beside);
        }
        let sockets = short_root()?.join("drifting-mcp");
        private_directory(&sockets)?;
        let digest = Sha256::digest(directory.as_os_str().as_bytes());
        let name: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
        let endpoint = sockets.join(format!("{name}.sock"));
        if endpoint.as_os_str().len() > MAX_SOCKET_PATH {
            return Err("MCP application data path is too long for local IPC".into());
        }
        Ok(endpoint)
    }
    /// This OS user's own cache folder (`/var/folders/…/C`): short, entered
    /// by this user alone, and not swept while Drifting runs, unlike the
    /// temporary folder beside it, which macOS empties of three-day-old files.
    #[cfg(unix)]
    fn user_cache_directory() -> Result<PathBuf, String> {
        use std::os::unix::{ffi::OsStringExt, fs::MetadataExt};
        let mut buffer = vec![0u8; 1024];
        // SAFETY: confstr writes at most `buffer.len()` bytes, NUL included.
        let length = unsafe {
            libc::confstr(
                libc::_CS_DARWIN_USER_CACHE_DIR,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
            )
        };
        if length == 0 || length > buffer.len() {
            return Err("MCP could not find this user's private cache folder".into());
        }
        buffer.truncate(length - 1);
        let path: PathBuf = PathBuf::from(std::ffi::OsString::from_vec(buffer))
            .components()
            .collect();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        if !meta.is_dir() || shared_with_others(&meta) || meta.uid() != uid {
            return Err("MCP cache folder must be private to this OS user".into());
        }
        Ok(path)
    }

    impl Server {
        fn start(directory: PathBuf) -> Result<Arc<Self>, String> {
            Self::start_with(directory, None)
        }
        /// `socket_root` stands in for the user's cache folder in tests.
        fn start_with(
            directory: PathBuf,
            #[cfg_attr(windows, allow(unused_variables))] socket_root: Option<PathBuf>,
        ) -> Result<Arc<Self>, String> {
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
            #[cfg(unix)]
            let endpoint = socket_endpoint(&directory, || {
                socket_root.map_or_else(user_cache_directory, Ok)
            })?;
            #[cfg(windows)]
            let listener = Listener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
            #[cfg(windows)]
            let endpoint = PathBuf::from(
                listener
                    .local_addr()
                    .map_err(|e| e.to_string())?
                    .to_string(),
            );
            // A moved application data folder (development launches keep theirs
            // beside the database) leaves connection files naming the old socket
            // and clients naming the old connection file; follow the move once.
            // Only a socket that lived beside its connection files says where
            // those files were; one in the short folder leaves the clients be.
            // On Windows the port changes at every launch: the connection files
            // follow it, and the clients keep naming the same files.
            #[cfg_attr(windows, allow(unused_mut))]
            let mut moved: Vec<(Grant, PathBuf)> = Vec::new();
            for grant in &grants {
                let path = directory.join(format!("connection-{}.json", grant.id));
                let Ok(bytes) = read_private(&path) else {
                    continue;
                };
                let Ok(mut credential) = serde_json::from_slice::<Credential>(&bytes) else {
                    continue;
                };
                if credential.socket_path == endpoint {
                    continue;
                }
                #[cfg(unix)]
                let previous = (credential.socket_path.file_name() == Some(SOCKET_NAME.as_ref()))
                    .then(|| {
                        credential
                            .socket_path
                            .with_file_name(format!("connection-{}.json", grant.id))
                    });
                credential.socket_path = endpoint.clone();
                write_private(&path, &credential)?;
                #[cfg(unix)]
                if let Some(previous) = previous {
                    moved.push((grant.clone(), previous));
                }
            }
            #[cfg(unix)]
            let listener = {
                if let Ok(meta) = fs::symlink_metadata(&endpoint) {
                    use std::os::unix::fs::FileTypeExt;
                    if !meta.file_type().is_socket() {
                        return Err("MCP socket path is occupied".into());
                    }
                    if connect_endpoint(&endpoint).is_ok() {
                        return Err("Another Drifting MCP bridge is running".into());
                    }
                    fs::remove_file(&endpoint).map_err(|e| e.to_string())?;
                }
                let listener = Listener::bind(&endpoint).map_err(|e| e.to_string())?;
                fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
                listener
            };
            let server = Arc::new(Self {
                directory,
                endpoint,
                inner: Mutex::new(Inner {
                    grants,
                    ..Inner::default()
                }),
            });
            for (grant, previous) in moved {
                let Some(installation) = &grant.installation else {
                    continue;
                };
                let config = server.describe(&grant)?["config"].clone();
                let previous_args = serde_json::json!(["--mcp", "--connection", previous]);
                // Best effort: a client edited meanwhile keeps its own entry.
                let _ = client_config::relocate(installation, &previous_args, &config);
            }
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
            Self::cancel_locked(&mut inner, predicate, reason);
        }
        fn cancel_locked(inner: &mut Inner, predicate: impl Fn(&Pending) -> bool, reason: &str) {
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
        let root = crate::data_paths::app_local_root(&app)?;
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
            Client::Antigravity => home.join(".gemini/config/mcp_config.json"),
        };
        let server = server(app, state)?;
        // One entry per client for this installation's library: stable across
        // launches, and apart from another installation's or account's entry.
        let name_hash = hash(&server.directory.display().to_string());
        let installation = Installation {
            client,
            config_path,
            server_name: format!("drifting_{}", &name_hash[..16]),
        };
        connect_installation(&server, input, installation)
    }
    /// Connects a client for every book, then retires the entries it was given
    /// one book at a time. A retired entry left in a client configuration that
    /// could not be rewritten is reported as `leftover`.
    fn connect_installation(
        server: &Arc<Server>,
        input: CreateInput,
        installation: Installation,
    ) -> Result<Value, String> {
        let mut description = create_connection(server, input, Some(installation.clone()))?;
        let retired: Vec<String> = server
            .inner
            .lock()
            .unwrap()
            .grants
            .iter()
            .filter(|grant| {
                grant.project_id.is_some()
                    && grant.installation.as_ref().is_some_and(|book| {
                        book.client == installation.client
                            && book.config_path == installation.config_path
                    })
            })
            .map(|grant| grant.id.clone())
            .collect();
        let mut leftover = false;
        for id in retired {
            leftover |= !matches!(revoke_connection(server, &id), Ok(None));
        }
        if leftover {
            description["leftover"] = true.into();
        }
        Ok(description)
    }
    fn create_connection(
        server: &Arc<Server>,
        input: CreateInput,
        installation: Option<Installation>,
    ) -> Result<Value, String> {
        if input.name.trim().is_empty() || input.name.len() > 120 {
            return Err("Invalid MCP connection name".into());
        }
        let mut inner = server.inner.lock().unwrap();
        if let Some(installation) = &installation {
            if let Some(grant) = inner
                .grants
                .iter()
                .find(|g| g.installation.as_ref() == Some(installation))
            {
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
            project_id: None,
            installation,
            token_hash: hash(&token),
            retired_access: None,
            retired_allow_dangerous: None,
        };
        let mut grants = inner.grants.clone();
        grants.push(grant.clone());
        let credential = Credential {
            version: 1,
            socket_path: server.endpoint.clone(),
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
            "The book open in Drifting changed; read again before writing",
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
                "The book was closed in Drifting; inspect any interrupted write before retrying",
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
    fn serve_connection(server: &Arc<Server>, stream: Stream) -> Result<(), String> {
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
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(stream));
        let grant = grant.unwrap();
        let session = format!("mcp:{}", random_id()?);
        server.inner.lock().unwrap().sessions.insert(
            session.clone(),
            Session {
                cancelled: HashSet::new(),
                book: None,
            },
        );
        let mut initialized = false;
        let mut ids = HashSet::new();
        let in_flight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let result = (|| {
            while let Some(request) = read_frame(&mut reader, MAX_REQUEST)? {
                let id = request.get("id").cloned();
                let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                if method == "notifications/cancelled" {
                    let target = &request["params"]["requestId"];
                    if let Some(session) = server.inner.lock().unwrap().sessions.get_mut(&session) {
                        if session.cancelled.len() < 100_000 {
                            session.cancelled.insert(target.to_string());
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
                        "instructions":initialize_instructions(server.directory.parent().expect("MCP directory parent"), grant.project_id.as_deref())
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
            let Some(grant) = inner.grants.iter().find(|g| g.id == grant.id).cloned() else {
                return rpc_error(&id, -32001, "MCP connection revoked");
            };
            if inner
                .sessions
                .get(session)
                .is_none_or(|session| session.cancelled.contains(&id.to_string()))
            {
                return rpc_error(&id, -32000, "MCP request cancelled or connection closed");
            }
            let Some(bridge) = inner.bridge.clone().filter(|b| {
                grant
                    .project_id
                    .as_ref()
                    .is_none_or(|project| project == &b.project)
            }) else {
                return rpc_error(
                    &id,
                    -32002,
                    if grant.project_id.is_some() {
                        "Open the authorized project in Drifting before using its tools"
                    } else {
                        "Open a book in Drifting before using its tools"
                    },
                );
            };
            // A call meant for the book this session was working in must not
            // land in the one the author switched to: refuse it once, before
            // anything runs, so the client looks again.
            if request["method"] == "tools/call" {
                if let Some(session) = inner.sessions.get_mut(session) {
                    let switched = session
                        .book
                        .as_ref()
                        .is_some_and(|book| book != &bridge.project);
                    session.book = Some(bridge.project.clone());
                    if switched {
                        return rpc_error(
                            &id,
                            -32002,
                            "Drifting now has another book open and nothing was done; call get_project_overview to see which, and read again before writing",
                        );
                    }
                }
            }
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
        let mut stream = connect_endpoint(&credential.socket_path)
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

    /// What a connecting client is told. A connection reaches whichever book
    /// is open, so it learns the book and its folder from
    /// get_project_overview; one limited to a single book is told where that
    /// book's folder is. Once the author turned the Markdown folder off, or
    /// while no location is chosen for that book, the client is told so instead.
    fn initialize_instructions(root: &Path, project_id: Option<&str>) -> String {
        let resolved = project_id.map(|project_id| {
            crate::markdown_projection::resolved_project_directory(root, project_id)
        });
        let unset = resolved.as_ref().is_some_and(|resolved| {
            resolved
                .as_ref()
                .is_err_and(|error| error == crate::markdown_projection::NO_LOCATION)
        });
        let folder = if !crate::markdown_projection::folder_enabled(root) {
            "The author turned the Markdown folder off: Drifting neither updates files on disk nor merges edits made there, so read and write through tools only.".into()
        } else if unset {
            "The author has not chosen where this project's Markdown folder goes: Drifting writes no files on disk, so read and write through tools only.".into()
        } else {
            let location = match resolved {
                None => "for each book with a chosen location; get_project_overview reports the open book's directory, or that no location is chosen".into(),
                Some(resolved) => {
                    let directory = resolved
                        .map(|path| path.display().to_string())
                        .unwrap_or_else(|_| {
                            "an unavailable output location (check Settings → Sync & Data → Local data)"
                                .into()
                        });
                    format!("for this project at {directory}")
                }
            };
            format!("A structured Markdown folder is automatically maintained {location}. Start with 开始阅读.md and 正文/目录.md. Each chapter, drift, element and storyline is one file named by title; chapters are numbered in reading order and grouped by existing acts, elements use their existing categories. 注释与待办.md groups comments by target; 素材 holds the materials in their folders and 素材/附件 their local image/PDF sources. .drifting/manifest.json records full entity identities, their current readable paths, canonical sourceVersion values and file SHA-256 hashes. Filenames can change after rename or reorder: resolve identities through the manifest. The projection uses relative Markdown links to whole files, without block anchors. Physical file lines and hashes differ from read_chapter. The manifest records generation time and file SHA-256 hashes; check freshness and hashes before citing a disk snapshot. Projection refresh is asynchronous while the project is open. The folder is named after the book and renamed with it; get_project_overview reports its current directory and status, including after the book is renamed or the output location changes. Chapter and drift files are TWO-WAY: their frontmatter holds drifting-id, 写作状态 and 摘要, then the prose. While Drifting runs, an edit saved to one merges into Drifting as the author's own edit, without Agent review; never change drifting-id, and creating, deleting or renaming files is not synced. Every other file is generated and READ-ONLY: edits there are overwritten. Use authorized MCP write tools for edits that should be reviewed. The directory is local to the Mac running Drifting.")
        };
        let (scope, book) = match project_id {
            None => (
                "Operate on the book open in Drifting; tools are unavailable while the author is on the shelf. The author may switch books: the first call after a switch is refused without running, so call get_project_overview to see which book is open (its name and bookId) and read again before writing.".to_string(),
                "<bookId>".to_string(),
            ),
            Some(project_id) => (
                "Operate only on the authorized project, which must be open in Drifting.".into(),
                project_id.to_string(),
            ),
        };
        format!("{scope} Read targets through tools before modifying them; filesystem reads do not establish write coverage. Paginate read_chapter with cursor and version; other large results use read_tool_result. After reconnect, read again. Never automatically retry an uncertain write. Changes use the app's live Yjs and review system. Read the target through tools for current line numbers before writing or citing a passage. To cite a passage in written prose or notes, use a Markdown location link such as [label](drifting:chapters/<title>/prose.md#L12-L18) (or id-<entity ID> from the manifest); Drifting stores it as a clickable paragraph anchor. Outside Drifting, drifting://open/{book}/<group>/<directory>/prose.md#L12 opens a location. {folder}")
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn fixture() -> (tempfile::TempDir, Arc<Server>, Grant, Credential) {
            fixture_for(None)
        }
        /// A connection made for one book before connections covered every book.
        fn book_fixture() -> (tempfile::TempDir, Arc<Server>, Grant, Credential) {
            fixture_for(Some("synthetic-project".into()))
        }
        fn fixture_for(
            project_id: Option<String>,
        ) -> (tempfile::TempDir, Arc<Server>, Grant, Credential) {
            // A Unix socket path must stay short.
            #[cfg(unix)]
            let dir = tempfile::tempdir_in("/tmp").unwrap();
            #[cfg(windows)]
            let dir = tempfile::tempdir().unwrap();
            let server = Server::start(dir.path().join("mcp")).unwrap();
            let grant = Grant {
                id: "synthetic-connection".into(),
                name: "Synthetic agent".into(),
                project_id,
                token_hash: hash("synthetic-token"),
                installation: None,
                retired_access: None,
                retired_allow_dangerous: None,
            };
            server.persist(&[grant.clone()]).unwrap();
            server.inner.lock().unwrap().grants.push(grant.clone());
            let credential = Credential {
                version: 1,
                socket_path: server.endpoint.clone(),
                connection_id: grant.id.clone(),
                token: "synthetic-token".into(),
            };
            (dir, server, grant, credential)
        }
        fn connect(credential: &Credential) -> BufReader<Stream> {
            let stream = connect_endpoint(&credential.socket_path).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            write_frame(reader.get_mut(), &serde_json::to_value(credential).unwrap()).unwrap();
            reader
        }
        fn request(reader: &mut BufReader<Stream>, id: u32, method: &str) -> Value {
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
            }
        }
        fn mount_synthetic_project(server: &Arc<Server>) {
            server.inner.lock().unwrap().bridge = Some(Bridge {
                epoch: "synthetic-epoch".into(),
                project: "synthetic-project".into(),
                channel: Channel::new(|_| Ok(())),
            });
        }
        /// Mounts `project` and returns every event the renderer receives.
        fn mount_recording(
            server: &Arc<Server>,
            epoch: &str,
            project: &str,
        ) -> mpsc::Receiver<Value> {
            let (tx, rx) = mpsc::channel();
            server.inner.lock().unwrap().bridge = Some(Bridge {
                epoch: epoch.into(),
                project: project.into(),
                channel: Channel::new(move |body| {
                    if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                        let _ = tx.send(serde_json::from_str::<Value>(&body).unwrap());
                    }
                    Ok(())
                }),
            });
            rx
        }
        /// Answers the renderer request `event` carries.
        fn answer(server: &Arc<Server>, event: &Value, id: u32) {
            let pending = server
                .inner
                .lock()
                .unwrap()
                .pending
                .remove(event["requestId"].as_str().unwrap())
                .unwrap();
            pending
                .sender
                .send(serde_json::json!({"jsonrpc":"2.0", "id":id, "result":{}}))
                .unwrap();
        }
        #[test]
        fn one_click_connections_are_idempotent_scoped_and_removed_on_revoke() {
            for client in [Client::Codex, Client::ClaudeCode, Client::Antigravity] {
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
                let id = first["grant"]["id"].as_str().unwrap();
                // Reconfiguring writes a removed entry back under the same grant.
                fs::remove_file(&installation.config_path).unwrap();
                assert_eq!(
                    create_connection(&server, synthetic_input(), Some(installation.clone()))
                        .unwrap(),
                    first
                );
                assert!(fs::read_to_string(&installation.config_path)
                    .unwrap()
                    .contains("drifting_test"));
                assert_eq!(server.inner.lock().unwrap().grants.len(), 2);
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
        fn initialize_reports_persisted_custom_projection_location() {
            let (_dir, server, grant, credential) = book_fixture();
            let project_id = grant.project_id.as_deref().unwrap();
            let custom = tempfile::tempdir().unwrap();
            let root = server.directory.parent().unwrap();
            crate::markdown_projection::set_output_root(
                root,
                project_id,
                Some(custom.path().to_string_lossy().into_owned()),
            )
            .unwrap();
            let directory =
                crate::markdown_projection::resolved_project_directory(root, project_id).unwrap();
            let mut client = connect(&credential);
            assert_eq!(
                read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["ok"],
                true
            );
            let response = request(&mut client, 1, "initialize");
            let instructions = response["result"]["instructions"].as_str().unwrap();
            assert!(instructions.contains(directory.to_str().unwrap()));
            assert!(!instructions.contains(
                crate::markdown_projection::project_directory(root, project_id)
                    .to_str()
                    .unwrap()
            ));
        }
        #[test]
        fn initialize_sends_a_connection_to_the_open_book_for_its_folder() {
            let (_dir, server, _, credential) = fixture();
            let mut client = connect(&credential);
            assert_eq!(
                read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["ok"],
                true
            );
            let response = request(&mut client, 1, "initialize");
            let instructions = response["result"]["instructions"].as_str().unwrap();
            assert!(instructions.contains("Operate on the book open in Drifting"));
            assert!(instructions.contains("get_project_overview reports the open book's directory"));
            assert!(instructions.contains("drifting://open/<bookId>/"));
            assert!(instructions.contains("Chapter and drift files are TWO-WAY"));
            assert!(!instructions.contains("authorized project"));
            assert!(!instructions.contains(
                &server
                    .directory
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            ));
        }

        #[test]
        fn initialize_says_when_the_markdown_folder_is_turned_off() {
            let (_dir, server, grant, credential) = book_fixture();
            let project_id = grant.project_id.as_deref().unwrap();
            let root = server.directory.parent().unwrap();
            crate::markdown_projection::set_enabled(root, false).unwrap();
            let mut client = connect(&credential);
            assert_eq!(
                read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["ok"],
                true
            );
            let response = request(&mut client, 1, "initialize");
            let instructions = response["result"]["instructions"].as_str().unwrap();
            assert!(instructions.contains("Markdown folder off"));
            assert!(!instructions.contains("TWO-WAY"));
            assert!(!instructions.contains(
                crate::markdown_projection::project_directory(root, project_id)
                    .to_str()
                    .unwrap()
            ));
            assert!(instructions.contains(&format!("drifting://open/{project_id}/")));
        }

        #[test]
        fn initialize_says_when_no_markdown_folder_location_is_chosen() {
            let (_dir, _server, _grant, credential) = book_fixture();
            let mut client = connect(&credential);
            assert_eq!(
                read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["ok"],
                true
            );
            let response = request(&mut client, 1, "initialize");
            let instructions = response["result"]["instructions"].as_str().unwrap();
            assert!(
                instructions.contains("has not chosen where this project's Markdown folder goes")
            );
            assert!(!instructions.contains("TWO-WAY"));
            assert!(!instructions.contains("markdown-projections"));
        }

        #[test]
        fn socket_authentication_project_scope_revocation_and_duplicate_ids() {
            let (_dir, server, grant, mut credential) = book_fixture();
            let project_id = grant.project_id.as_deref().unwrap();
            let chosen = tempfile::tempdir().unwrap();
            let root = server.directory.parent().unwrap();
            crate::markdown_projection::set_default_root(
                root,
                chosen.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let directory =
                crate::markdown_projection::resolved_project_directory(root, project_id).unwrap();
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
            let initialized = request(&mut client, 1, "initialize");
            assert_eq!(initialized["result"]["protocolVersion"], "2025-11-25");
            let instructions = initialized["result"]["instructions"].as_str().unwrap();
            assert!(instructions.contains("Chapter and drift files are TWO-WAY"));
            assert!(instructions.contains("Every other file is generated and READ-ONLY"));
            assert!(instructions.contains("drifting:chapters/<title>/prose.md#L12-L18"));
            assert!(instructions.contains(&format!("drifting://open/{project_id}/")));
            assert!(instructions.contains(directory.to_str().unwrap()));
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
        fn a_connection_reaches_the_open_book_and_refuses_the_first_call_after_a_switch() {
            let (_dir, server, _, credential) = fixture();
            let mut client = connect(&credential);
            read_frame(&mut client, MAX_FRAME).unwrap();
            request(&mut client, 1, "initialize");
            let shelf = request(&mut client, 2, "tools/list");
            assert_eq!(shelf["error"]["code"], -32002);
            assert!(shelf["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Open a book"));

            let first = mount_recording(&server, "first", "first-book");
            request_async(&mut client, 3, "tools/call");
            let event = first.recv_timeout(Duration::from_secs(3)).unwrap();
            answer(&server, &event, 3);
            assert!(read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["result"].is_object());

            let second = mount_recording(&server, "second", "second-book");
            let refused = request(&mut client, 4, "tools/call");
            assert_eq!(refused["error"]["code"], -32002);
            assert!(refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains("another book open and nothing was done"));
            assert!(second.try_recv().is_err());
            // Listing tools after the switch does not count as looking again.
            request_async(&mut client, 5, "tools/list");
            answer(
                &server,
                &second.recv_timeout(Duration::from_secs(3)).unwrap(),
                5,
            );
            read_frame(&mut client, MAX_FRAME).unwrap();
            request_async(&mut client, 6, "tools/call");
            let event = second.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(event["epoch"], "second");
            answer(&server, &event, 6);
            assert!(read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["result"].is_object());
        }
        fn request_async(reader: &mut BufReader<Stream>, id: u32, method: &str) {
            write_frame(
                reader.get_mut(),
                &serde_json::json!({"jsonrpc":"2.0","id":id,"method":method}),
            )
            .unwrap();
        }
        #[test]
        fn connecting_a_client_retires_the_entries_it_was_given_one_book_at_a_time() {
            let (dir, server, _, _) = fixture();
            let claude = |name: &str| Installation {
                client: Client::ClaudeCode,
                config_path: dir.path().join("claude.json"),
                server_name: name.into(),
            };
            let codex = Installation {
                client: Client::Codex,
                config_path: dir.path().join("config.toml"),
                server_name: "drifting_book_codex".into(),
            };
            // Book connections as an earlier version made them.
            let mut books = Vec::new();
            for (installation, book) in [
                (Some(claude("drifting_book_one")), "book-one"),
                (Some(claude("drifting_book_two")), "book-two"),
                (Some(codex.clone()), "book-one"),
                (None, "book-one"),
            ] {
                let made = create_connection(&server, synthetic_input(), installation).unwrap();
                books.push((made["grant"]["id"].as_str().unwrap().to_string(), book));
            }
            {
                let mut inner = server.inner.lock().unwrap();
                for grant in &mut inner.grants {
                    if let Some((_, book)) = books.iter().find(|(id, _)| id == &grant.id) {
                        grant.project_id = Some((*book).into());
                    }
                }
                let grants = inner.grants.clone();
                server.persist(&grants).unwrap();
            }

            let connected =
                connect_installation(&server, synthetic_input(), claude("drifting_library"))
                    .unwrap();
            assert!(connected.get("leftover").is_none());
            assert!(connected["grant"].get("projectId").is_none());
            let config = fs::read_to_string(dir.path().join("claude.json")).unwrap();
            assert!(config.contains("drifting_library"));
            assert!(!config.contains("drifting_book_one"));
            assert!(!config.contains("drifting_book_two"));
            assert!(fs::read_to_string(&codex.config_path)
                .unwrap()
                .contains("drifting_book_codex"));
            let remaining: Vec<String> = server
                .inner
                .lock()
                .unwrap()
                .grants
                .iter()
                .map(|grant| grant.id.clone())
                .collect();
            for (index, (id, _)) in books.iter().enumerate() {
                // Only the two Claude Code entries go; Codex and manual stay.
                assert_eq!(remaining.contains(id), index >= 2);
                assert_eq!(server.config_path(id).exists(), index >= 2);
            }

            // An entry changed outside Drifting is still revoked, and reported.
            let made = create_connection(
                &server,
                synthetic_input(),
                Some(claude("drifting_book_three")),
            )
            .unwrap();
            let id = made["grant"]["id"].as_str().unwrap().to_string();
            {
                let mut inner = server.inner.lock().unwrap();
                let grant = inner.grants.iter_mut().find(|g| g.id == id).unwrap();
                grant.project_id = Some("book-three".into());
            }
            let edited = fs::read_to_string(dir.path().join("claude.json"))
                .unwrap()
                .replace(
                    &server.config_path(&id).display().to_string(),
                    "/elsewhere/connection.json",
                );
            fs::write(dir.path().join("claude.json"), edited).unwrap();
            let reconnected =
                connect_installation(&server, synthetic_input(), claude("drifting_library"))
                    .unwrap();
            assert_eq!(reconnected["grant"]["id"], connected["grant"]["id"]);
            assert_eq!(reconnected["leftover"], true);
            assert!(server
                .inner
                .lock()
                .unwrap()
                .grants
                .iter()
                .all(|g| g.id != id));
        }
        #[test]
        #[cfg(unix)]
        fn a_library_too_deep_for_its_socket_listens_in_a_short_private_folder() {
            let dir = tempfile::tempdir_in("/tmp").unwrap();
            let directory = dir
                .path()
                .join("Application Support/cc.drifting.client/libraries")
                .join(format!("account-{}", "0".repeat(32)))
                .join("mcp");
            fs::create_dir_all(directory.parent().unwrap()).unwrap();
            assert!(directory.join(SOCKET_NAME).as_os_str().len() > MAX_SOCKET_PATH);
            // A connection file left naming another socket follows this one.
            let stale = Grant {
                id: "synthetic-stale".into(),
                name: "Synthetic agent".into(),
                project_id: None,
                token_hash: hash("synthetic-stale-token"),
                installation: None,
                retired_access: None,
                retired_allow_dangerous: None,
            };
            private_directory(&directory).unwrap();
            write_private(
                &directory.join("grants.json"),
                &Registry {
                    version: 1,
                    grants: vec![stale.clone()],
                },
            )
            .unwrap();
            let stale_path = directory.join(format!("connection-{}.json", stale.id));
            write_private(
                &stale_path,
                &Credential {
                    version: 1,
                    socket_path: "/tmp/drifting-mcp/0000000000000000.sock".into(),
                    connection_id: stale.id.clone(),
                    token: "synthetic-stale-token".into(),
                },
            )
            .unwrap();

            let short = tempfile::tempdir_in("/tmp").unwrap();
            let server = Server::start_with(directory.clone(), Some(short.path().into())).unwrap();
            let sockets = short.path().join("drifting-mcp");
            assert!(server.endpoint.starts_with(&sockets));
            assert!(server.endpoint.as_os_str().len() <= MAX_SOCKET_PATH);
            assert_eq!(
                fs::metadata(&sockets).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::symlink_metadata(&server.endpoint)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            // Every launch binds the same path.
            assert_eq!(
                socket_endpoint(&directory, || Ok(short.path().into())).unwrap(),
                server.endpoint
            );
            let moved: Credential =
                serde_json::from_slice(&read_private(&stale_path).unwrap()).unwrap();
            assert_eq!(moved.socket_path, server.endpoint);

            mount_synthetic_project(&server);
            let created = create_connection(&server, synthetic_input(), None).unwrap();
            let id = created["grant"]["id"].as_str().unwrap();
            let credential: Credential =
                serde_json::from_slice(&read_private(&server.config_path(id)).unwrap()).unwrap();
            assert_eq!(credential.socket_path, server.endpoint);
            assert_eq!(
                read_frame(&mut connect(&credential), MAX_FRAME)
                    .unwrap()
                    .unwrap()["ok"],
                true
            );
        }
        #[test]
        #[cfg(unix)]
        fn the_user_cache_folder_is_short_and_private() {
            use std::os::unix::fs::MetadataExt;
            let path = user_cache_directory().unwrap();
            assert!(path.is_absolute());
            assert!(!path.as_os_str().to_string_lossy().ends_with('/'));
            let sample = path.join("drifting-mcp").join("0123456789abcdef.sock");
            assert!(sample.as_os_str().len() <= MAX_SOCKET_PATH);
            let meta = fs::symlink_metadata(&path).unwrap();
            assert_eq!(meta.permissions().mode() & 0o077, 0);
            assert_eq!(meta.uid(), unsafe { libc::getuid() });
        }
        #[test]
        fn renderer_dispatch_preserves_authorized_scope_and_cancellation() {
            let (_dir, server, _, credential) = fixture();
            let rx = mount_recording(&server, "e", "synthetic-project");
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
            assert_eq!(event["grant"]["id"], "synthetic-connection");
            assert!(event["grant"].get("projectId").is_none());
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
        fn a_registry_naming_retired_permission_tiers_loads_and_drops_them() {
            #[cfg(unix)]
            let dir = tempfile::tempdir_in("/tmp").unwrap();
            #[cfg(windows)]
            let dir = tempfile::tempdir().unwrap();
            let directory = dir.path().join("mcp");
            private_directory(&directory).unwrap();
            // A read-only connection as an earlier version stored it.
            write_private(
                &directory.join("grants.json"),
                &serde_json::json!({"version":1, "grants":[{
                    "id":"synthetic-connection", "name":"Synthetic agent",
                    "access":"read", "allowDangerous":false,
                    "tokenHash":hash("synthetic-token")
                }]}),
            )
            .unwrap();
            let server = Server::start(directory.clone()).unwrap();
            let rx = mount_recording(&server, "e", "synthetic-project");
            let credential = Credential {
                version: 1,
                socket_path: server.endpoint.clone(),
                connection_id: "synthetic-connection".into(),
                token: "synthetic-token".into(),
            };
            let mut client = connect(&credential);
            read_frame(&mut client, MAX_FRAME).unwrap();
            // The tool list never changes under a live connection.
            assert_eq!(
                request(&mut client, 1, "initialize")["result"]["capabilities"],
                serde_json::json!({"tools":{}})
            );
            write_frame(
                client.get_mut(),
                &serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            )
            .unwrap();
            let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(
                event["grant"],
                serde_json::json!({"id":"synthetic-connection","name":"Synthetic agent"})
            );
            answer(&server, &event, 2);
            assert_eq!(
                read_frame(&mut client, MAX_FRAME).unwrap().unwrap()["id"],
                2
            );
            // The next write of the registry no longer names a tier.
            create_connection(&server, synthetic_input(), None).unwrap();
            let registry =
                String::from_utf8(read_private(&directory.join("grants.json")).unwrap()).unwrap();
            assert!(registry.contains("synthetic-connection"));
            assert!(!registry.contains("\"access\""));
            assert!(!registry.contains("allowDangerous"));
        }
        #[test]
        #[cfg(unix)]
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use local::McpServerState;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[derive(Default)]
pub struct McpServerState;

pub fn run_stdio_cli() -> Option<Result<(), String>> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--mcp") {
        return None;
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if args.len() == 4 && args[2] == "--connection" {
        return Some(local::cli(std::path::Path::new(&args[3])));
    }
    Some(Err(
        "Usage: Drifting --mcp --connection <connection-file>".into()
    ))
}

#[tauri::command]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(unused_variables)
)]
pub fn mcp_server_list(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
) -> Result<Vec<Value>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return local::list(&app, &state);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Local MCP is available on macOS and Windows".into())
}
#[tauri::command]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(unused_variables)
)]
pub fn mcp_server_create(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    input: CreateInput,
) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return local::create(&app, &state, input);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Local MCP is available on macOS and Windows".into())
}
#[tauri::command]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(unused_variables)
)]
pub fn mcp_server_connect(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    input: CreateInput,
    client: Client,
) -> Result<Value, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return local::connect(&app, &state, input, client);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Local MCP is available on macOS and Windows".into())
}
#[tauri::command]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(unused_variables)
)]
pub fn mcp_server_revoke(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    id: String,
) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return local::revoke(&app, &state, id);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Local MCP is available on macOS and Windows".into())
}
#[tauri::command]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(unused_variables)
)]
pub fn mcp_server_attach(
    app: tauri::AppHandle,
    state: State<'_, McpServerState>,
    project_id: String,
    on_event: Channel<Value>,
) -> Result<String, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return local::attach(&app, &state, project_id, on_event);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Local MCP is available on macOS and Windows".into())
}
#[tauri::command]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(unused_variables)
)]
pub fn mcp_server_detach(state: State<'_, McpServerState>, epoch: String) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    local::detach(&state, &epoch);
}
#[tauri::command]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(unused_variables)
)]
pub fn mcp_server_complete(
    state: State<'_, McpServerState>,
    epoch: String,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return local::complete(&state, &epoch, &request_id, response);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Local MCP is available on macOS and Windows".into())
}
