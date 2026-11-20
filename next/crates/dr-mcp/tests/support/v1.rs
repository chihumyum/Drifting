//! The MCP state the 0.1 client leaves for one library, shaped as its code
//! writes it (`src-tauri/src/mcp_server.rs`: `create_connection`, `connect`,
//! `describe`, `socket_endpoint`; `mcp_server/client_config.rs`). Synthetic
//! ids and tokens only; nothing is copied from a real folder.
//!
//! Also included by the app's `data_folder_tests`.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

/// The clients 0.1 configures in one click (`Client`, serialized
/// `snake_case`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    Codex,
    ClaudeCode,
}

impl Client {
    fn wire(self) -> &'static str {
        match self {
            Client::Codex => "codex",
            Client::ClaudeCode => "claude_code",
        }
    }
    /// Where 0.1 writes the client's configuration under `home`.
    pub fn config(self, home: &Path) -> PathBuf {
        match self {
            Client::Codex => home.join(".codex/config.toml"),
            Client::ClaudeCode => home.join(".claude.json"),
        }
    }
}

/// One connection as 0.1 made it.
#[derive(Clone, Debug)]
pub struct Connection {
    pub id: String,
    pub client: Client,
    pub server_name: String,
    /// `<mcp folder>/connection-<id>.json`, the file the client's entry names.
    pub file: PathBuf,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// 0.1's endpoint on macOS for an MCP folder (`socket_endpoint`):
/// `bridge.sock` beside the connection files when that path fits a Unix
/// socket address (103 bytes), otherwise `<short root>/drifting-mcp/<the
/// first 8 bytes of SHA-256(folder path), hex>.sock`, where 0.1's short root
/// is the user's cache folder.
#[cfg(unix)]
pub fn socket(directory: &Path, short_root: &Path) -> PathBuf {
    use std::os::unix::ffi::OsStrExt as _;
    let beside = directory.join("bridge.sock");
    if beside.as_os_str().as_bytes().len() <= 103 {
        return beside;
    }
    let digest = Sha256::digest(directory.as_os_str().as_bytes());
    short_root
        .join("drifting-mcp")
        .join(format!("{}.sock", hex(&digest[..8])))
}

/// A private folder as 0.1 makes one (`private_directory`: 0700).
fn private_folder(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

/// A private file as 0.1 writes one (`write_private`: 0600, compact JSON).
fn private_file(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

/// Connects `client` to the library whose MCP folder is `directory`, as 0.1's
/// 「连接」 does: a grant (`grants.json`, version 1, the token's SHA-256
/// only), its connection file naming `endpoint` (0.1's wire form: the socket
/// path, or Windows' `127.0.0.1:<port>`), and the client's entry in `home`
/// (server `drifting_<first 16 hex of SHA-256(folder)>`, `command` the
/// executable, `args` `--mcp --connection <file>`). `seed` makes the id and
/// token.
pub fn connect(
    directory: &Path,
    endpoint: &str,
    home: &Path,
    executable: &Path,
    client: Client,
    seed: &str,
) -> Connection {
    private_folder(directory);
    let id = sha256_hex(&format!("synthetic-connection-{seed}"));
    let token = sha256_hex(&format!("synthetic-token-{seed}"));
    let file = directory.join(format!("connection-{id}.json"));
    let config_path = client.config(home);
    let server_name = format!(
        "drifting_{}",
        &sha256_hex(&directory.display().to_string())[..16]
    );
    let registry = directory.join("grants.json");
    let mut grants: Value = std::fs::read(&registry)
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        .unwrap_or_else(|| json!({"version": 1, "grants": []}));
    grants["grants"].as_array_mut().unwrap().push(json!({
        "id": id,
        "name": "Synthetic agent",
        "installation": {
            "client": client.wire(),
            "configPath": config_path,
            "serverName": server_name,
        },
        "tokenHash": sha256_hex(&token),
    }));
    private_file(&registry, &serde_json::to_vec(&grants).unwrap());
    private_file(
        &file,
        &serde_json::to_vec(&json!({
            "version": 1,
            "socketPath": endpoint,
            "connectionId": id,
            "token": token,
        }))
        .unwrap(),
    );
    let args = [
        "--mcp".to_owned(),
        "--connection".to_owned(),
        file.display().to_string(),
    ];
    let command = executable.display().to_string();
    private_folder(config_path.parent().unwrap());
    let before = std::fs::read_to_string(&config_path).unwrap_or_default();
    let after = match client {
        Client::ClaudeCode => {
            let mut root: Value = if before.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&before).unwrap()
            };
            root.as_object_mut()
                .unwrap()
                .entry("mcpServers")
                .or_insert_with(|| json!({}))[&server_name] =
                json!({"type": "stdio", "command": command, "args": args});
            serde_json::to_string_pretty(&root).unwrap() + "\n"
        }
        // A JSON string is a TOML basic string.
        Client::Codex => format!(
            "{before}[mcp_servers.{server_name}]\ncommand = {}\nargs = {}\n",
            serde_json::to_string(&command).unwrap(),
            serde_json::to_string(&args).unwrap(),
        ),
    };
    private_file(&config_path, after.as_bytes());
    Connection {
        id,
        client,
        server_name,
        file,
    }
}

/// What the client's entry for `connection` says to run: its command and
/// arguments, read back from the configuration file under `home`.
pub fn launch(home: &Path, connection: &Connection) -> (PathBuf, Vec<String>) {
    let text = std::fs::read_to_string(connection.client.config(home)).unwrap();
    let entry: Value = match connection.client {
        Client::ClaudeCode => serde_json::from_str::<Value>(&text).unwrap()["mcpServers"]
            [&connection.server_name]
            .clone(),
        Client::Codex => {
            let document = text.parse::<toml_edit::DocumentMut>().unwrap();
            let entry = &document["mcp_servers"][&connection.server_name];
            json!({
                "command": entry["command"].as_str().unwrap(),
                "args": entry["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|arg| arg.as_str().unwrap())
                    .collect::<Vec<_>>(),
            })
        }
    };
    (
        PathBuf::from(entry["command"].as_str().unwrap()),
        serde_json::from_value(entry["args"].clone()).unwrap(),
    )
}

/// 0.1's registry of libraries (`libraries.json`, version 1) under `base`:
/// `(id, owner)` with owner `None` (never claimed), `Some(None)` local, or
/// `Some(Some(subject))` an account.
pub fn registry(base: &Path, active: &str, libraries: &[(&str, Option<Option<&str>>)]) {
    let libraries: serde_json::Map<String, Value> = libraries
        .iter()
        .map(|(id, owner)| {
            let owner = match owner {
                None => Value::Null,
                Some(None) => json!({"kind": "local"}),
                Some(Some(subject)) => json!({"kind": "account", "subject": subject}),
            };
            ((*id).to_owned(), json!({"owner": owner}))
        })
        .collect();
    std::fs::create_dir_all(base).unwrap();
    std::fs::write(
        base.join("libraries.json"),
        serde_json::to_vec_pretty(&json!({"version": 1, "active": active, "libraries": libraries}))
            .unwrap(),
    )
    .unwrap();
}

/// 0.1's id for an account's library (`library_id_for`).
pub fn account_library(subject: &str) -> String {
    format!("account-{}", &sha256_hex(subject)[..32])
}

/// A port nothing listens on: where 0.1's last launch listened, on Windows.
pub fn closed_port() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().to_string()
}
