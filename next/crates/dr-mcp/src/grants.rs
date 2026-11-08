//! App-identity scoped grants. Disk mutations enter one queue synchronously;
//! authentication only reads the short-lived in-memory snapshot.

use crate::{
    Result,
    client_config::{self, Change},
    private_files,
};
use futures::{
    FutureExt,
    channel::oneshot,
    future::{BoxFuture, Shared},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Client {
    Codex,
    ClaudeCode,
    Antigravity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Unix(PathBuf),
    Loopback(SocketAddr),
}
impl Endpoint {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Unix(path) if path.is_absolute() => Ok(()),
            Self::Loopback(address) if address.ip().is_loopback() && address.port() != 0 => Ok(()),
            _ => Err("MCP endpoint must be an absolute local socket or loopback address".into()),
        }
    }
    fn wire(&self) -> PathBuf {
        match self {
            Self::Unix(path) => path.clone(),
            Self::Loopback(address) => address.to_string().into(),
        }
    }
    fn from_wire(path: PathBuf) -> Result<Self> {
        let endpoint = match path
            .to_str()
            .and_then(|text| text.parse::<SocketAddr>().ok())
        {
            Some(address) => Self::Loopback(address),
            None => Self::Unix(path),
        };
        endpoint.validate()?;
        Ok(endpoint)
    }
}

#[derive(Clone, Debug)]
pub struct ClientPaths {
    codex: Result<PathBuf>,
    claude: Result<PathBuf>,
    antigravity: Result<PathBuf>,
}
impl ClientPaths {
    pub fn from_home(
        home: PathBuf,
        codex_home: Option<PathBuf>,
        claude_config_dir: Option<PathBuf>,
    ) -> Self {
        let absolute = |path: PathBuf| {
            if path.is_absolute() {
                Ok(path)
            } else {
                Err("Client configuration requires an absolute home directory".into())
            }
        };
        let codex = absolute(
            codex_home
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| home.join(".codex")),
        )
        .map(|path| path.join("config.toml"));
        let claude = if claude_config_dir
            .filter(|path| !path.as_os_str().is_empty())
            .is_some_and(|path| path != home.join(".claude"))
        {
            Err("Use manual configuration for a custom CLAUDE_CONFIG_DIR".into())
        } else {
            absolute(home.join(".claude.json"))
        };
        let antigravity = absolute(home.join(".gemini/config/mcp_config.json"));
        Self {
            codex,
            claude,
            antigravity,
        }
    }
    pub fn path(&self, client: Client) -> Result<&Path> {
        match client {
            Client::Codex => &self.codex,
            Client::ClaudeCode => &self.claude,
            Client::Antigravity => &self.antigravity,
        }
        .as_ref()
        .map(PathBuf::as_path)
        .map_err(Clone::clone)
    }
}

#[derive(Clone, Debug)]
pub struct GrantPaths {
    pub directory: PathBuf,
    pub executable: PathBuf,
    pub clients: ClientPaths,
    short_socket_root: Option<PathBuf>,
}
impl GrantPaths {
    /// Production discovery is application-identity scoped. This only builds
    /// paths; it never opens the author's client configurations.
    pub fn for_app(data_directory: PathBuf, executable: PathBuf) -> Result<Self> {
        if !data_directory.is_absolute() || !executable.is_absolute() {
            return Err("MCP application paths must be absolute".into());
        }
        let home = dirs::home_dir().ok_or("Could not find this user's home directory")?;
        Ok(Self::new(
            data_directory.join("mcp"),
            executable,
            ClientPaths::from_home(
                home,
                std::env::var_os("CODEX_HOME").map(PathBuf::from),
                std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
            ),
        ))
    }

    pub fn new(directory: PathBuf, executable: PathBuf, clients: ClientPaths) -> Self {
        Self {
            directory,
            executable,
            clients,
            short_socket_root: None,
        }
    }
    pub fn with_socket_root(mut self, root: PathBuf) -> Self {
        self.short_socket_root = Some(root);
        self
    }
    #[cfg(unix)]
    pub fn socket_path(&self) -> Result<PathBuf> {
        private_files::socket_path(&self.directory, self.short_socket_root.as_deref())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installation {
    pub client: Client,
    pub config_path: PathBuf,
    pub server_name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<Installation>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchConfig {
    pub command: PathBuf,
    pub args: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct ConnectionDescription {
    pub grant: GrantInfo,
    pub config: LaunchConfig,
}
#[derive(Clone, Debug, Serialize)]
pub struct ConnectOutcome {
    pub connection: ConnectionDescription,
    pub leftover: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct RevokeOutcome {
    pub leftover: bool,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct RepairReport {
    pub warnings: Vec<RepairWarning>,
}
#[derive(Clone, Debug, Serialize)]
pub struct RepairWarning {
    pub grant_id: String,
    pub client: Option<Client>,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "CredentialWire", into = "CredentialWire")]
pub struct Credential {
    endpoint: Endpoint,
    connection_id: String,
    token: String,
}
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("endpoint", &self.endpoint)
            .field("connection_id", &self.connection_id)
            .field("token", &"[REDACTED]")
            .finish()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialWire {
    version: u32,
    socket_path: PathBuf,
    connection_id: String,
    token: String,
}
impl TryFrom<CredentialWire> for Credential {
    type Error = String;
    fn try_from(wire: CredentialWire) -> Result<Self> {
        if wire.version != 1 {
            return Err("Unsupported MCP connection file".into());
        }
        valid_id(&wire.connection_id)?;
        if wire.token.is_empty() || wire.token.len() > 4096 {
            return Err("Invalid MCP credential".into());
        }
        Ok(Self {
            endpoint: Endpoint::from_wire(wire.socket_path)?,
            connection_id: wire.connection_id,
            token: wire.token,
        })
    }
}
impl From<Credential> for CredentialWire {
    fn from(credential: Credential) -> Self {
        Self {
            version: 1,
            socket_path: credential.endpoint.wire(),
            connection_id: credential.connection_id,
            token: credential.token,
        }
    }
}
impl Credential {
    pub fn read_private(path: &Path) -> Result<Self> {
        serde_json::from_slice(&private_files::read_private(path)?)
            .map_err(|_| "Invalid MCP connection file".into())
    }
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installation: Option<Installation>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    token_hash: String,
    #[serde(default, skip_serializing, rename = "access")]
    _retired_access: Option<String>,
    #[serde(default, skip_serializing, rename = "allowDangerous")]
    _retired_dangerous: Option<bool>,
}
impl Record {
    fn info(&self) -> GrantInfo {
        GrantInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            project_id: self.project_id.clone(),
            installation: self.installation.clone(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    grants: Vec<Record>,
}
fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err("Invalid MCP connection identity".into())
    } else {
        Ok(())
    }
}
fn hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
fn same_hash(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |sum, (a, b)| sum | (a ^ b))
            == 0
}

struct Live {
    revoked: AtomicBool,
    done: Shared<BoxFuture<'static, ()>>,
}
struct Entry {
    record: Record,
    live: Arc<Live>,
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}
impl Entry {
    fn new(record: Record) -> Self {
        let (cancel, receiver) = oneshot::channel();
        Self {
            record,
            live: Arc::new(Live {
                revoked: AtomicBool::new(false),
                done: async move {
                    let _ = receiver.await;
                }
                .boxed()
                .shared(),
            }),
            cancel: Mutex::new(Some(cancel)),
        }
    }
    fn revoke(&self) {
        self.live.revoked.store(true, Ordering::Release);
        if let Some(cancel) = self
            .cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = cancel.send(());
        }
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.revoke();
    }
}
#[derive(Clone)]
pub struct GrantLease {
    store: Arc<()>,
    live: Arc<Live>,
    info: GrantInfo,
}
impl fmt::Debug for GrantLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GrantLease")
            .field("info", &self.info)
            .field("revoked", &self.live.revoked.load(Ordering::Acquire))
            .finish()
    }
}
impl GrantLease {
    pub fn info(&self) -> &GrantInfo {
        &self.info
    }
    pub fn check_book(&self, book: &str) -> Result<()> {
        if self.live.revoked.load(Ordering::Acquire) {
            return Err("MCP connection revoked".into());
        }
        if self
            .info
            .project_id
            .as_deref()
            .is_some_and(|scope| scope != book)
        {
            return Err("MCP connection is limited to its authorized book".into());
        }
        Ok(())
    }
    pub fn revoked(&self) -> BoxFuture<'static, ()> {
        self.live.done.clone().boxed()
    }
}

struct SharedStore {
    identity: Arc<()>,
    paths: GrantPaths,
    endpoint: Endpoint,
    available: AtomicBool,
    entries: RwLock<Vec<Arc<Entry>>>,
    disk: Mutex<Option<Vec<u8>>>,
}
type Job = Box<dyn FnOnce(&Arc<SharedStore>) + Send>;
#[derive(Clone)]
pub struct GrantStore {
    shared: Arc<SharedStore>,
    queue: mpsc::Sender<Job>,
}
impl GrantStore {
    /// Startup I/O. The caller binds the endpoint first; call off the UI thread.
    pub fn open(paths: GrantPaths, endpoint: Endpoint) -> Result<Self> {
        endpoint.validate()?;
        if !paths.executable.is_absolute() {
            return Err("MCP executable path must be absolute".into());
        }
        private_files::ensure_private_dir(&paths.directory)?;
        let disk = private_files::read_optional_private(&paths.directory.join("grants.json"))?;
        let records = match &disk {
            Some(bytes) => {
                let registry: Registry = serde_json::from_slice(bytes)
                    .map_err(|_| "Invalid MCP grant registry".to_owned())?;
                if registry.version != 1 {
                    return Err("Unsupported MCP grant registry".into());
                }
                let mut seen = std::collections::HashSet::new();
                for record in &registry.grants {
                    valid_id(&record.id)?;
                    if !seen.insert(&record.id) {
                        return Err("Duplicate MCP grant identity".into());
                    }
                }
                registry.grants
            }
            None => Vec::new(),
        };
        let shared = Arc::new(SharedStore {
            identity: Arc::new(()),
            paths,
            endpoint,
            available: AtomicBool::new(true),
            entries: RwLock::new(
                records
                    .into_iter()
                    .map(|record| Arc::new(Entry::new(record)))
                    .collect(),
            ),
            disk: Mutex::new(disk),
        });
        let (queue, receiver) = mpsc::channel::<Job>();
        let worker = shared.clone();
        thread::Builder::new()
            .name("mcp-grants".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    job(&worker);
                }
            })
            .map_err(|_| "Could not start MCP grant storage".to_owned())?;
        Ok(Self { shared, queue })
    }
    pub fn endpoint(&self) -> &Endpoint {
        &self.shared.endpoint
    }
    pub fn list(&self) -> Vec<GrantInfo> {
        self.shared.records().iter().map(Record::info).collect()
    }
    pub fn describe(&self, id: &str) -> Result<ConnectionDescription> {
        let record = self
            .shared
            .records()
            .into_iter()
            .find(|record| record.id == id)
            .ok_or("MCP connection does not exist")?;
        self.shared.describe(&record)
    }
    fn enqueue<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Arc<SharedStore>) -> Result<T> + Send + 'static,
    ) -> BoxFuture<'static, Result<T>> {
        let (reply, received) = oneshot::channel();
        let job = Box::new(move |store: &Arc<SharedStore>| {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(store)))
                .unwrap_or_else(|_| {
                    store.disable();
                    Err("MCP storage operation panicked; reopen the service".into())
                });
            let _ = reply.send(result);
        });
        if self.queue.send(job).is_err() {
            return async { Err("MCP grant storage is closed".into()) }.boxed();
        }
        async move {
            received
                .await
                .map_err(|_| "MCP grant storage stopped".to_owned())?
        }
        .boxed()
    }
    pub fn create_manual(&self, name: &str) -> BoxFuture<'static, Result<ConnectionDescription>> {
        let name = name.to_owned();
        self.enqueue(move |store| store.create(&name, None))
    }
    pub fn connect(
        &self,
        client: Client,
        name: &str,
    ) -> BoxFuture<'static, Result<ConnectOutcome>> {
        let name = name.to_owned();
        self.enqueue(move |store| {
            let installation = store.installation(client)?;
            let connection = store.create(&name, Some(installation.clone()))?;
            let retired: Vec<_> = store
                .records()
                .into_iter()
                .filter(|record| {
                    record.project_id.is_some()
                        && record.installation.as_ref().is_some_and(|old| {
                            old.client == client && old.config_path == installation.config_path
                        })
                })
                .map(|record| record.id)
                .collect();
            let mut leftover = false;
            for id in retired {
                leftover |= store.revoke(&id).map(|out| out.leftover).unwrap_or(true);
            }
            store.ensure_available()?;
            Ok(ConnectOutcome {
                connection,
                leftover,
            })
        })
    }
    pub fn revoke(&self, id: &str) -> BoxFuture<'static, Result<RevokeOutcome>> {
        let id = id.to_owned();
        self.enqueue(move |store| store.revoke(&id))
    }
    pub fn repair_owned(&self, keep_missing: bool) -> BoxFuture<'static, Result<RepairReport>> {
        self.enqueue(move |store| store.repair(keep_missing))
    }
    /// Enqueued now, even if the returned future is never polled until later.
    pub fn drain(&self) -> BoxFuture<'static, Result<()>> {
        self.enqueue(|_| Ok(()))
    }
    pub fn authenticate(&self, credential: &Credential) -> Result<GrantLease> {
        self.shared.ensure_available()?;
        let entries = self
            .shared
            .entries
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let entry = entries
            .iter()
            .find(|entry| {
                !entry.live.revoked.load(Ordering::Acquire)
                    && entry.record.id == credential.connection_id
                    && same_hash(&entry.record.token_hash, &hash(&credential.token))
            })
            .ok_or("MCP credential rejected")?;
        Ok(GrantLease {
            store: self.shared.identity.clone(),
            live: entry.live.clone(),
            info: entry.record.info(),
        })
    }
    pub fn validate(&self, lease: &GrantLease) -> Result<()> {
        self.shared.ensure_available()?;
        if !Arc::ptr_eq(&self.shared.identity, &lease.store)
            || lease.live.revoked.load(Ordering::Acquire)
        {
            return Err("MCP connection revoked".into());
        }
        let entries = self
            .shared
            .entries
            .read()
            .unwrap_or_else(|error| error.into_inner());
        if entries
            .iter()
            .any(|entry| entry.record.id == lease.info.id && Arc::ptr_eq(&entry.live, &lease.live))
        {
            Ok(())
        } else {
            Err("MCP connection revoked".into())
        }
    }
}

impl SharedStore {
    fn ensure_available(&self) -> Result<()> {
        if self.available.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err("MCP grant storage changed unexpectedly; reopen the service".into())
        }
    }

    fn disable(&self) {
        self.available.store(false, Ordering::Release);
        for entry in self
            .entries
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
        {
            entry.revoke();
        }
    }

    fn records(&self) -> Vec<Record> {
        self.entries
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|entry| entry.record.clone())
            .collect()
    }
    fn installation(&self, client: Client) -> Result<Installation> {
        let config_path = self.paths.clients.path(client)?.to_owned();
        let records = self.records();
        let same_client = |installation: &Installation| {
            installation.client == client && installation.config_path == config_path
        };
        if let Some(existing) = records
            .iter()
            .filter(|record| record.project_id.is_none())
            .filter_map(|record| record.installation.as_ref())
            .find(|installation| same_client(installation))
        {
            return Ok(existing.clone());
        }
        let base = format!(
            "drifting_{}",
            &hash(&self.paths.directory.display().to_string())[..16]
        );
        let mut server_name = base.clone();
        let mut suffix = 0usize;
        // A legacy per-book grant may occupy the same stable name. Install the
        // new grant independently before retiring any of its old authority.
        while records
            .iter()
            .filter_map(|record| record.installation.as_ref())
            .any(|installation| {
                same_client(installation) && installation.server_name == server_name
            })
        {
            suffix += 1;
            server_name = if suffix == 1 {
                format!("{base}_all")
            } else {
                format!("{base}_all_{suffix}")
            };
        }
        Ok(Installation {
            client,
            config_path,
            server_name,
        })
    }
    fn path(&self, id: &str) -> PathBuf {
        self.paths.directory.join(format!("connection-{id}.json"))
    }
    fn describe(&self, record: &Record) -> Result<ConnectionDescription> {
        Ok(ConnectionDescription {
            grant: record.info(),
            config: LaunchConfig {
                command: self.paths.executable.clone(),
                args: vec![
                    "--mcp".into(),
                    "--connection".into(),
                    self.path(&record.id)
                        .to_str()
                        .ok_or("MCP connection path is not UTF-8")?
                        .into(),
                ],
            },
        })
    }
    fn persist(&self, records: &[Record]) -> Result<()> {
        self.ensure_available()?;
        let bytes = serde_json::to_vec(&Registry {
            version: 1,
            grants: records.to_owned(),
        })
        .map_err(|_| "Could not encode MCP grant registry".to_owned())?;
        let mut disk = self.disk.lock().unwrap_or_else(|error| error.into_inner());
        let path = self.paths.directory.join("grants.json");
        if let Err(error) = private_files::atomic_write(&path, &bytes, disk.as_deref(), false, true)
        {
            // A rename can succeed before a directory sync fails. Never keep
            // granting access from a cache whose durable state is uncertain.
            if private_files::read_optional_private(&path).ok().as_ref() != Some(&*disk) {
                self.disable();
            }
            return Err(error);
        }
        *disk = Some(bytes);
        Ok(())
    }
    fn publish(&self, records: Vec<Record>) {
        let mut entries = self
            .entries
            .write()
            .unwrap_or_else(|error| error.into_inner());
        let mut old = std::mem::take(&mut *entries);
        for record in records {
            if let Some(index) = old.iter().position(|entry| {
                entry.record.id == record.id
                    && entry.record.token_hash == record.token_hash
                    && entry.record.project_id == record.project_id
            }) {
                entries.push(old.remove(index));
            } else {
                entries.push(Arc::new(Entry::new(record)));
            }
        }
        for entry in old {
            entry.revoke();
        }
    }
    fn create(
        &self,
        name: &str,
        installation: Option<Installation>,
    ) -> Result<ConnectionDescription> {
        self.ensure_available()?;
        if name.trim().is_empty() || name.len() > 120 {
            return Err("Invalid MCP connection name".into());
        }
        let before = self.records();
        if let Some(installation) = &installation
            && let Some(record) = before.iter().find(|record| {
                record.project_id.is_none() && record.installation.as_ref() == Some(installation)
            })
        {
            let credential = Credential::read_private(&self.path(&record.id))?;
            if credential.connection_id != record.id
                || !same_hash(&record.token_hash, &hash(&credential.token))
            {
                return Err(
                    "MCP connection file does not match its grant; revoke it and reconnect".into(),
                );
            }
            let description = self.describe(record)?;
            client_config::apply(installation, &description.config, Change::Install)?;
            return Ok(description);
        }
        if before.len() >= 32 {
            return Err("Revoke an unused MCP connection first".into());
        }
        let token = private_files::random_hex()?;
        let record = Record {
            id: private_files::random_hex()?,
            name: name.trim().into(),
            project_id: None,
            installation,
            token_hash: hash(&token),
            _retired_access: None,
            _retired_dangerous: None,
        };
        let description = self.describe(&record)?;
        let credential = Credential {
            endpoint: self.endpoint.clone(),
            connection_id: record.id.clone(),
            token,
        };
        let bytes = serde_json::to_vec(&credential)
            .map_err(|_| "Could not encode MCP credential".to_owned())?;
        private_files::atomic_write(&self.path(&record.id), &bytes, None, false, true)?;
        let mut after = before.clone();
        after.push(record.clone());
        if let Err(error) = self.persist(&after) {
            let _ = private_files::remove_private(&self.path(&record.id));
            return Err(error);
        }
        if let Some(installation) = &record.installation
            && let Err(error) =
                client_config::apply(installation, &description.config, Change::Install)
        {
            if self.persist(&before).is_err() {
                self.publish(after);
                return Err(format!(
                    "{error}. The unused connection {} could not be removed; revoke it in Drifting",
                    record.id
                ));
            }
            let _ = private_files::remove_private(&self.path(&record.id));
            return Err(error);
        }
        self.publish(after);
        Ok(description)
    }
    fn revoke(&self, id: &str) -> Result<RevokeOutcome> {
        self.ensure_available()?;
        let mut records = self.records();
        let index = records
            .iter()
            .position(|record| record.id == id)
            .ok_or("MCP connection does not exist")?;
        let revoked = records.remove(index);
        self.persist(&records)?;
        self.publish(records);
        let mut leftover = private_files::remove_private(&self.path(id)).is_err();
        if let Some(installation) = &revoked.installation {
            leftover |= self
                .describe(&revoked)
                .and_then(|description| {
                    client_config::apply(installation, &description.config, Change::Remove)
                })
                .is_err();
        }
        Ok(RevokeOutcome { leftover })
    }
    fn repair(&self, keep_missing: bool) -> Result<RepairReport> {
        self.ensure_available()?;
        let mut report = RepairReport::default();
        for record in self.records() {
            let result = (|| {
                let path = self.path(&record.id);
                let bytes = private_files::read_private(&path)?;
                let mut credential: Credential = serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid MCP connection file".to_owned())?;
                if credential.connection_id != record.id
                    || !same_hash(&record.token_hash, &hash(&credential.token))
                {
                    return Err("MCP connection file does not match its grant".into());
                }
                let previous_args = match &credential.endpoint {
                    Endpoint::Unix(old)
                        if old.file_name().is_some_and(|name| name == "bridge.sock") =>
                    {
                        old.parent().map(|parent| {
                            vec![
                                "--mcp".into(),
                                "--connection".into(),
                                parent
                                    .join(format!("connection-{}.json", record.id))
                                    .to_string_lossy()
                                    .into_owned(),
                            ]
                        })
                    }
                    _ => None,
                };
                if credential.endpoint != self.endpoint {
                    credential.endpoint = self.endpoint.clone();
                    let updated = serde_json::to_vec(&credential)
                        .map_err(|_| "Could not encode MCP connection file".to_owned())?;
                    private_files::atomic_write(&path, &updated, Some(&bytes), false, true)?;
                }
                if let Some(installation) = &record.installation {
                    client_config::apply(
                        installation,
                        &self.describe(&record)?.config,
                        Change::Repair {
                            previous_args: previous_args.as_deref(),
                            keep_missing,
                        },
                    )?;
                }
                Ok(())
            })();
            if let Err(message) = result {
                report.warnings.push(RepairWarning {
                    grant_id: record.id,
                    client: record.installation.map(|installation| installation.client),
                    message,
                });
            }
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;

    fn open(root: &Path) -> GrantStore {
        GrantStore::open(
            GrantPaths::new(
                root.join("app/mcp"),
                root.join("writer"),
                ClientPaths::from_home(root.join("home"), None, None),
            ),
            Endpoint::Loopback(([127, 0, 0, 1], 42120).into()),
        )
        .unwrap()
    }

    #[test]
    fn dropped_waiters_keep_mutating_and_drain_waits_for_previously_enqueued_work() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        let (entered, observe) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        drop(store.enqueue(move |_| {
            entered.send(()).unwrap();
            blocked.recv().unwrap();
            Ok(())
        }));
        observe.recv().unwrap();
        drop(store.create_manual("Synthetic queued client"));
        let mut barrier = store.drain();
        assert!(barrier.as_mut().now_or_never().is_none());
        assert!(store.list().is_empty());
        release.send(()).unwrap();
        block_on(barrier).unwrap();
        let grants = store.list();
        assert_eq!(grants.len(), 1);
        let path = store.describe(&grants[0].id).unwrap().config.args[2].clone();
        store
            .authenticate(&Credential::read_private(Path::new(&path)).unwrap())
            .unwrap();
    }

    #[test]
    fn changed_authority_revokes_the_old_generation_and_store_identity_is_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        let grant = block_on(store.create_manual("Synthetic client")).unwrap();
        let credential = Credential::read_private(Path::new(&grant.config.args[2])).unwrap();
        let lease = store.authenticate(&credential).unwrap();
        let second = open(dir.path());
        assert!(second.validate(&lease).is_err());
        let wake = lease.revoked();
        block_on(store.enqueue(|store| {
            let mut records = store.records();
            records[0].project_id = Some("synthetic-book".into());
            store.persist(&records)?;
            store.publish(records);
            Ok(())
        }))
        .unwrap();
        block_on(wake);
        assert!(store.validate(&lease).is_err());
        let scoped = store.authenticate(&credential).unwrap();
        scoped.check_book("synthetic-book").unwrap();
        assert!(scoped.check_book("another-book").is_err());
    }
}
