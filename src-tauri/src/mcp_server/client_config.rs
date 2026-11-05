//! Small, scoped edits to the external client's user-level configuration.
//! No CLI, shell, network, trust overrides, or credentials in generated entries.
use super::{Client, Installation};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use toml_edit::{Array, DocumentMut, Item, Table};

const MAX_CONFIG: u64 = 16 * 1024 * 1024;

/// Unix refuses a configuration others may write. Windows keeps the user's
/// profile folders private through their inherited ACLs.
#[cfg(unix)]
fn writable_by_others(meta: &fs::Metadata) -> bool {
    meta.permissions().mode() & 0o022 != 0
}
#[cfg(not(unix))]
fn writable_by_others(_meta: &fs::Metadata) -> bool {
    false
}

fn private_directories() -> fs::DirBuilder {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder
}

fn new_private_file() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
}

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read the client's configuration".into()),
        Ok(meta) => {
            if !meta.is_file() || meta.len() > MAX_CONFIG || writable_by_others(&meta) {
                return Err(
                    "Client configuration must be a regular file writable only by its owner".into(),
                );
            }
            fs::read_to_string(path)
                .map(Some)
                .map_err(|_| "Could not read the client's configuration".into())
        }
    }
}

/// What an edit does to Drifting's own entry in a client configuration.
#[derive(Clone, Copy)]
enum Change<'a> {
    Install,
    Remove,
    /// The connection file moved: rewrite only an entry that still names the
    /// previous arguments, and never re-add one the author removed.
    Move(&'a Value),
}

fn edit(
    source: &str,
    installation: &Installation,
    config: &Value,
    change: Change,
) -> Result<String, String> {
    let remove = matches!(change, Change::Remove);
    let keep_missing = !matches!(change, Change::Install);
    let owner_args = match change {
        Change::Move(previous) => previous,
        _ => &config["args"],
    };
    // Ownership follows the private connection-file reference, so an app move
    // can repair its executable path without replacing somebody else's entry.
    // A move that already happened leaves the entry naming the current file.
    let is_move = matches!(change, Change::Move(_));
    let owns_json = |entry: &Value| {
        entry.get("args") == Some(owner_args)
            || (is_move && entry.get("args") == config.get("args"))
    };
    match installation.client {
        Client::Codex => {
            let mut doc = source
                .parse::<DocumentMut>()
                .map_err(|_| "Codex configuration is invalid; it was left unchanged")?;
            if !doc.contains_key("mcp_servers") {
                if keep_missing {
                    return Ok(source.into());
                }
                doc["mcp_servers"] = Item::Table(Table::new());
            }
            let servers = doc["mcp_servers"]
                .as_table_like_mut()
                .ok_or("Codex mcp_servers must be a table")?;
            let owner_list = owner_args
                .as_array()
                .ok_or("Invalid MCP arguments")?
                .iter()
                .map(Value::as_str)
                .collect::<Vec<_>>();
            if let Some(entry) = servers.get(&installation.server_name) {
                let current_list = config["args"]
                    .as_array()
                    .ok_or("Invalid MCP arguments")?
                    .iter()
                    .map(Value::as_str)
                    .collect::<Vec<_>>();
                let owned = entry
                    .get("args")
                    .and_then(Item::as_array)
                    .map(|args| {
                        let args = args.iter().map(|arg| arg.as_str()).collect::<Vec<_>>();
                        args == owner_list || (is_move && args == current_list)
                    })
                    .unwrap_or(false);
                if !owned {
                    return Err("A different MCP server already uses this name; its configuration was left unchanged".into());
                }
            } else if keep_missing {
                return Ok(source.into());
            }
            if remove {
                servers.remove(&installation.server_name);
            } else {
                if !servers.contains_key(&installation.server_name) {
                    servers.insert(&installation.server_name, Item::Table(Table::new()));
                }
                let entry = servers
                    .get_mut(&installation.server_name)
                    .and_then(Item::as_table_like_mut)
                    .ok_or("Invalid Codex MCP server entry")?;
                entry.insert(
                    "command",
                    toml_edit::value(config["command"].as_str().ok_or("Invalid MCP command")?),
                );
                let mut args = Array::new();
                for arg in config["args"].as_array().ok_or("Invalid MCP arguments")? {
                    args.push(arg.as_str().ok_or("Invalid MCP argument")?);
                }
                entry.insert("args", toml_edit::value(args));
            }
            Ok(doc.to_string())
        }
        Client::ClaudeCode | Client::Antigravity => {
            let client_name = if installation.client == Client::ClaudeCode {
                "Claude Code"
            } else {
                "Antigravity"
            };
            let mut doc: Value = if source.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(source).map_err(|_| {
                    format!("{client_name} configuration is invalid; it was left unchanged")
                })?
            };
            let root = doc
                .as_object_mut()
                .ok_or_else(|| format!("{client_name} configuration must be an object"))?;
            if !root.contains_key("mcpServers") {
                if keep_missing {
                    return Ok(source.into());
                }
                root.insert("mcpServers".into(), json!({}));
            }
            let servers = root
                .get_mut("mcpServers")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| format!("{client_name} mcpServers must be an object"))?;
            if let Some(entry) = servers.get(&installation.server_name) {
                if !owns_json(entry) {
                    return Err("A different MCP server already uses this name; its configuration was left unchanged".into());
                }
            } else if keep_missing {
                return Ok(source.into());
            }
            if remove {
                servers.remove(&installation.server_name);
            } else {
                let entry = servers
                    .entry(installation.server_name.clone())
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or_else(|| format!("Invalid {client_name} MCP server entry"))?;
                if installation.client == Client::ClaudeCode {
                    entry.insert("type".into(), json!("stdio"));
                }
                entry.insert("command".into(), config["command"].clone());
                entry.insert("args".into(), config["args"].clone());
            }
            serde_json::to_string_pretty(&doc)
                .map(|s| s + "\n")
                .map_err(|_| "Could not encode client configuration".into())
        }
    }
}

pub(super) fn update(
    installation: &Installation,
    config: &Value,
    remove: bool,
) -> Result<(), String> {
    apply(
        installation,
        config,
        if remove {
            Change::Remove
        } else {
            Change::Install
        },
    )
}

/// Point an entry that still names `previous_args` at the moved connection.
pub(super) fn relocate(
    installation: &Installation,
    previous_args: &Value,
    config: &Value,
) -> Result<(), String> {
    apply(installation, config, Change::Move(previous_args))
}

fn apply(installation: &Installation, config: &Value, change: Change) -> Result<(), String> {
    let path = &installation.config_path;
    let before = read(path)?;
    if !matches!(change, Change::Install) && before.is_none() {
        return Ok(());
    }
    let after = edit(
        before.as_deref().unwrap_or(""),
        installation,
        config,
        change,
    )?;
    if before.as_deref() == Some(after.as_str()) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or("Missing client configuration directory")?;
    private_directories()
        .create(parent)
        .map_err(|_| "Could not create client configuration directory")?;
    let suffix = super::local::random_id()?;
    let temp = parent.join(format!(".drifting-{suffix}.tmp"));
    let result = (|| {
        let mut file = new_private_file()
            .open(&temp)
            .map_err(|_| "Could not prepare client configuration")?;
        file.write_all(after.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save client configuration")?;
        // Refuse a concurrent external edit instead of replacing its newer data.
        if read(path)? != before {
            return Err("Client configuration changed. Try connecting again".into());
        }
        if let Some(before) = &before {
            let backup = parent.join(format!(
                "{}.drifting-backup-{suffix}",
                path.file_name().unwrap().to_string_lossy()
            ));
            let mut file = new_private_file()
                .open(backup)
                .map_err(|_| "Could not back up client configuration")?;
            file.write_all(before.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| "Could not back up client configuration")?;
        }
        if read(path)? != before {
            return Err("Client configuration changed. Try connecting again".into());
        }
        fs::rename(&temp, path).map_err(|_| "Could not install client configuration")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value {
        json!({"command":"/Applications/Synthetic Writer.app/Contents/MacOS/writer", "args":["--mcp", "--connection", "/synthetic/private/connection.json"]})
    }
    fn installation(client: Client) -> Installation {
        Installation {
            client,
            config_path: "/unused".into(),
            server_name: "drifting_test".into(),
        }
    }

    #[test]
    fn codex_merge_preserves_comments_and_other_servers_and_is_idempotent() {
        let source = "# user settings\nmodel = 'synthetic-model'\n[mcp_servers.other]\ncommand = 'other' # keep this\n";
        let i = installation(Client::Codex);
        let result = edit(source, &i, &config(), Change::Install).unwrap();
        assert!(result.starts_with(source));
        assert_eq!(
            edit(&result, &i, &config(), Change::Install).unwrap(),
            result
        );
        assert_eq!(
            edit(&result, &i, &config(), Change::Remove).unwrap(),
            source
        );
        let inline = "mcp_servers = {other = {command = 'other'}}\n";
        assert!(edit(inline, &i, &config(), Change::Install)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap()["mcp_servers"]["other"]
            .is_inline_table());
    }
    #[test]
    fn claude_merge_preserves_account_project_and_existing_mcp_settings() {
        let source = json!({"account":{"name":"synthetic"},"projects":{"/synthetic":{"hasTrustDialogAccepted":false}},"mcpServers":{"other":{"command":"other"}}});
        let i = installation(Client::ClaudeCode);
        let result = edit(&source.to_string(), &i, &config(), Change::Install).unwrap();
        assert_eq!(
            edit(&result, &i, &config(), Change::Install).unwrap(),
            result
        );
        assert_eq!(
            serde_json::from_str::<Value>(&edit(&result, &i, &config(), Change::Remove).unwrap())
                .unwrap(),
            source
        );
    }
    #[test]
    fn antigravity_stdio_setup_preserves_other_servers_and_user_controls() {
        let source = json!({"mcpServers":{"other":{"serverUrl":"https://synthetic.invalid/mcp","disabledTools":["synthetic_tool"]}},"customSetting":true});
        let i = installation(Client::Antigravity);
        assert_eq!(serde_json::to_value(i.client).unwrap(), "antigravity");
        let result = edit(&source.to_string(), &i, &config(), Change::Install).unwrap();
        let mut installed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(installed["mcpServers"]["drifting_test"], config());
        assert_eq!(
            edit(&result, &i, &config(), Change::Install).unwrap(),
            result
        );
        installed["mcpServers"]["drifting_test"]["disabled"] = json!(true);
        installed["mcpServers"]["drifting_test"]["disabledTools"] = json!(["create_chapter"]);
        let mut moved = config();
        moved["command"] = json!("/synthetic/moved/writer");
        let repaired = edit(&installed.to_string(), &i, &moved, Change::Install).unwrap();
        let repaired_json: Value = serde_json::from_str(&repaired).unwrap();
        let entry = &repaired_json["mcpServers"]["drifting_test"];
        assert_eq!(entry["command"], moved["command"]);
        assert_eq!(entry["disabled"], true);
        assert_eq!(entry["disabledTools"], json!(["create_chapter"]));
        assert_eq!(
            serde_json::from_str::<Value>(&edit(&repaired, &i, &moved, Change::Remove).unwrap())
                .unwrap(),
            source
        );
        for invalid in ["null", "[]", r#"{"mcpServers":[]}"#] {
            assert!(edit(invalid, &i, &config(), Change::Install).is_err());
        }
    }
    #[test]
    fn a_moved_connection_file_rewrites_only_its_own_entry() {
        let previous = json!(["--mcp", "--connection", "/synthetic/old/connection.json"]);
        let mut old = config();
        old["args"] = previous.clone();
        for client in [Client::ClaudeCode, Client::Codex] {
            let i = installation(client);
            let installed = edit("", &i, &old, Change::Install).unwrap();
            let moved = edit(&installed, &i, &config(), Change::Move(&previous)).unwrap();
            assert_eq!(moved, edit("", &i, &config(), Change::Install).unwrap());
            assert_eq!(
                edit(&moved, &i, &config(), Change::Move(&previous)).unwrap(),
                moved
            );
            // An entry the author removed stays removed.
            assert_eq!(
                edit("", &i, &config(), Change::Move(&previous)).unwrap(),
                ""
            );
        }
        let foreign =
            json!({"mcpServers":{"drifting_test":{"command":"other","args":["x"]}}}).to_string();
        assert!(edit(
            &foreign,
            &installation(Client::ClaudeCode),
            &config(),
            Change::Move(&previous)
        )
        .is_err());
    }
    #[test]
    fn antigravity_setup_creates_nested_config_and_backs_up_before_revocation() {
        let dir = tempfile::tempdir().unwrap();
        let mut i = installation(Client::Antigravity);
        i.config_path = dir.path().join(".gemini/config/mcp_config.json");
        update(&i, &config(), false).unwrap();
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&i.config_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let installed = fs::read_to_string(&i.config_path).unwrap();
        update(&i, &config(), true).unwrap();
        let removed: Value =
            serde_json::from_str(&fs::read_to_string(&i.config_path).unwrap()).unwrap();
        assert_eq!(removed, json!({"mcpServers":{}}));
        let backup = fs::read_dir(i.config_path.parent().unwrap())
            .unwrap()
            .flatten()
            .find(|p| {
                p.file_name()
                    .to_string_lossy()
                    .contains(".drifting-backup-")
            })
            .unwrap();
        assert_eq!(fs::read_to_string(backup.path()).unwrap(), installed);
    }
    #[test]
    fn claude_statistics_keep_their_exact_numeric_values() {
        let source = r#"{"projects":{"synthetic":{"stat":1.2345678901234567890123456789,"integer":123456789012345678901234567890}},"mcpServers":{}}"#;
        let i = installation(Client::ClaudeCode);
        let installed = edit(source, &i, &config(), Change::Install).unwrap();
        let removed = edit(&installed, &i, &config(), Change::Remove).unwrap();
        assert!(removed.contains("1.2345678901234567890123456789"));
        assert!(removed.contains("123456789012345678901234567890"));
        assert_eq!(
            serde_json::from_str::<Value>(&removed).unwrap(),
            serde_json::from_str::<Value>(source).unwrap()
        );
    }
    #[test]
    fn malformed_or_colliding_config_is_never_replaced() {
        for client in [Client::Codex, Client::ClaudeCode, Client::Antigravity] {
            let i = installation(client);
            assert!(edit("[broken", &i, &config(), Change::Install).is_err());
            let original = edit("", &i, &config(), Change::Install).unwrap();
            let mut other = config();
            other["args"] = json!(["unrelated"]);
            assert!(edit(&original, &i, &other, Change::Install).is_err());
            assert!(edit(&original, &i, &other, Change::Remove).is_err());
        }
    }
    #[test]
    fn configuration_updates_back_up_original_and_reject_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let mut i = installation(Client::Codex);
        i.config_path = dir.path().join("config.toml");
        let original = "model = 'synthetic'\n";
        fs::write(&i.config_path, original).unwrap();
        update(&i, &config(), false).unwrap();
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&i.config_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let backup = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .find(|p| {
                p.file_name()
                    .to_string_lossy()
                    .contains(".drifting-backup-")
            })
            .unwrap();
        assert_eq!(fs::read_to_string(backup.path()).unwrap(), original);
        // Creating a symlink on Windows needs developer mode or privileges.
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&i.config_path, &link).unwrap();
            i.config_path = link;
            assert!(update(&i, &config(), true).is_err());
        }
    }
}
