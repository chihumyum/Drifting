//! Small, scoped edits to the external client's user-level configuration.
//! No CLI, shell, network, trust overrides, or credentials in generated entries.
use super::{Client, Installation};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};
use toml_edit::{Array, DocumentMut, Item, Table};

const MAX_CONFIG: u64 = 16 * 1024 * 1024;

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read the client's configuration".into()),
        Ok(meta) => {
            if !meta.is_file() || meta.len() > MAX_CONFIG || meta.permissions().mode() & 0o022 != 0
            {
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

fn edit(
    source: &str,
    installation: &Installation,
    config: &Value,
    remove: bool,
) -> Result<String, String> {
    // Ownership follows the private connection-file reference, so an app move
    // can repair its executable path without replacing somebody else's entry.
    let owns_json = |entry: &Value| entry.get("args") == config.get("args");
    match installation.client {
        Client::Codex => {
            let mut doc = source
                .parse::<DocumentMut>()
                .map_err(|_| "Codex configuration is invalid; it was left unchanged")?;
            if !doc.contains_key("mcp_servers") {
                if remove {
                    return Ok(source.into());
                }
                doc["mcp_servers"] = Item::Table(Table::new());
            }
            let servers = doc["mcp_servers"]
                .as_table_like_mut()
                .ok_or("Codex mcp_servers must be a table")?;
            if let Some(entry) = servers.get(&installation.server_name) {
                let owned = entry
                    .get("args")
                    .and_then(Item::as_array)
                    .map(|args| {
                        args.iter().map(|arg| arg.as_str()).collect::<Vec<_>>()
                            == config["args"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(Value::as_str)
                                .collect::<Vec<_>>()
                    })
                    .unwrap_or(false);
                if !owned {
                    return Err("A different MCP server already uses this name; its configuration was left unchanged".into());
                }
            } else if remove {
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
                serde_json::from_str(source)
                    .map_err(|_| format!("{client_name} configuration is invalid; it was left unchanged"))?
            };
            let root = doc
                .as_object_mut()
                .ok_or_else(|| format!("{client_name} configuration must be an object"))?;
            if !root.contains_key("mcpServers") {
                if remove {
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
            } else if remove {
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
    let path = &installation.config_path;
    let before = read(path)?;
    if remove && before.is_none() {
        return Ok(());
    }
    let after = edit(
        before.as_deref().unwrap_or(""),
        installation,
        config,
        remove,
    )?;
    if before.as_deref() == Some(after.as_str()) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or("Missing client configuration directory")?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .map_err(|_| "Could not create client configuration directory")?;
    let suffix = super::local::random_id()?;
    let temp = parent.join(format!(".drifting-{suffix}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
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
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
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
        let result = edit(source, &i, &config(), false).unwrap();
        assert!(result.starts_with(source));
        assert_eq!(edit(&result, &i, &config(), false).unwrap(), result);
        assert_eq!(edit(&result, &i, &config(), true).unwrap(), source);
        let inline = "mcp_servers = {other = {command = 'other'}}\n";
        assert!(edit(inline, &i, &config(), false)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap()["mcp_servers"]["other"]
            .is_inline_table());
    }
    #[test]
    fn claude_merge_preserves_account_project_and_existing_mcp_settings() {
        let source = json!({"account":{"name":"synthetic"},"projects":{"/synthetic":{"hasTrustDialogAccepted":false}},"mcpServers":{"other":{"command":"other"}}});
        let i = installation(Client::ClaudeCode);
        let result = edit(&source.to_string(), &i, &config(), false).unwrap();
        assert_eq!(edit(&result, &i, &config(), false).unwrap(), result);
        assert_eq!(
            serde_json::from_str::<Value>(&edit(&result, &i, &config(), true).unwrap()).unwrap(),
            source
        );
    }
    #[test]
    fn antigravity_stdio_setup_preserves_other_servers_and_user_controls() {
        let source = json!({"mcpServers":{"other":{"serverUrl":"https://synthetic.invalid/mcp","disabledTools":["synthetic_tool"]}},"customSetting":true});
        let i = installation(Client::Antigravity);
        assert_eq!(serde_json::to_value(i.client).unwrap(), "antigravity");
        let result = edit(&source.to_string(), &i, &config(), false).unwrap();
        let mut installed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(installed["mcpServers"]["drifting_test"], config());
        assert_eq!(edit(&result, &i, &config(), false).unwrap(), result);
        installed["mcpServers"]["drifting_test"]["disabled"] = json!(true);
        installed["mcpServers"]["drifting_test"]["disabledTools"] = json!(["create_chapter"]);
        let mut moved = config();
        moved["command"] = json!("/synthetic/moved/writer");
        let repaired = edit(&installed.to_string(), &i, &moved, false).unwrap();
        let repaired_json: Value = serde_json::from_str(&repaired).unwrap();
        let entry = &repaired_json["mcpServers"]["drifting_test"];
        assert_eq!(entry["command"], moved["command"]);
        assert_eq!(entry["disabled"], true);
        assert_eq!(entry["disabledTools"], json!(["create_chapter"]));
        assert_eq!(
            serde_json::from_str::<Value>(&edit(&repaired, &i, &moved, true).unwrap()).unwrap(),
            source
        );
        for invalid in ["null", "[]", r#"{"mcpServers":[]}"#] {
            assert!(edit(invalid, &i, &config(), false).is_err());
        }
    }
    #[test]
    fn antigravity_setup_creates_nested_config_and_backs_up_before_revocation() {
        let dir = tempfile::tempdir().unwrap();
        let mut i = installation(Client::Antigravity);
        i.config_path = dir.path().join(".gemini/config/mcp_config.json");
        update(&i, &config(), false).unwrap();
        assert_eq!(
            fs::metadata(&i.config_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let installed = fs::read_to_string(&i.config_path).unwrap();
        update(&i, &config(), true).unwrap();
        let removed: Value = serde_json::from_str(&fs::read_to_string(&i.config_path).unwrap()).unwrap();
        assert_eq!(removed, json!({"mcpServers":{}}));
        let backup = fs::read_dir(i.config_path.parent().unwrap())
            .unwrap()
            .flatten()
            .find(|p| p.file_name().to_string_lossy().contains(".drifting-backup-"))
            .unwrap();
        assert_eq!(fs::read_to_string(backup.path()).unwrap(), installed);
    }
    #[test]
    fn claude_statistics_keep_their_exact_numeric_values() {
        let source = r#"{"projects":{"synthetic":{"stat":1.2345678901234567890123456789,"integer":123456789012345678901234567890}},"mcpServers":{}}"#;
        let i = installation(Client::ClaudeCode);
        let installed = edit(source, &i, &config(), false).unwrap();
        let removed = edit(&installed, &i, &config(), true).unwrap();
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
            assert!(edit("[broken", &i, &config(), false).is_err());
            let original = edit("", &i, &config(), false).unwrap();
            let mut other = config();
            other["args"] = json!(["unrelated"]);
            assert!(edit(&original, &i, &other, false).is_err());
            assert!(edit(&original, &i, &other, true).is_err());
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
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&i.config_path, &link).unwrap();
        i.config_path = link;
        assert!(update(&i, &config(), true).is_err());
    }
}
