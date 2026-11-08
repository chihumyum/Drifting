//! Scoped edits: retain every unrelated JSON value verbatim (including large
//! integers) and its key order; retain Codex's TOML comments and user options.

use crate::{
    Result,
    grants::{Client, Installation, LaunchConfig},
    private_files,
};
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{MapAccess, Visitor},
    ser::SerializeMap,
};
use serde_json::value::RawValue;
use std::fmt;
use toml_edit::{Array, DocumentMut, Item, Table};

#[derive(Clone, Copy)]
pub(crate) enum Change<'a> {
    Install,
    Remove,
    Repair {
        previous_args: Option<&'a [String]>,
        keep_missing: bool,
    },
}

#[derive(Default)]
struct Object(Vec<(String, Box<RawValue>)>);
impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Object;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON object with unique keys")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Object, M::Error> {
                let mut fields: Vec<(String, Box<RawValue>)> = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    if fields.iter().any(|(old, _)| old == &key) {
                        return Err(serde::de::Error::custom("duplicate JSON key"));
                    }
                    fields.push((key, map.next_value()?));
                }
                Ok(Object(fields))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}
impl Serialize for Object {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}
impl Object {
    fn get(&self, key: &str) -> Option<&RawValue> {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| &**value)
    }
    fn child(&self, key: &str) -> Result<Self> {
        self.get(key)
            .map(|value| {
                serde_json::from_str(value.get()).map_err(|_| {
                    "Client MCP configuration must be an object with unique keys".into()
                })
            })
            .unwrap_or_else(|| Ok(Self::default()))
    }
    fn set(&mut self, key: &str, value: &impl Serialize) -> Result<()> {
        let raw = serde_json::value::to_raw_value(value)
            .map_err(|_| "Could not encode client configuration".to_owned())?;
        if let Some((_, field)) = self.0.iter_mut().find(|(name, _)| name == key) {
            *field = raw;
        } else {
            self.0.push((key.into(), raw));
        }
        Ok(())
    }
    fn remove(&mut self, key: &str) {
        self.0.retain(|(name, _)| name != key);
    }
}

pub(crate) fn edit(
    source: &str,
    installation: &Installation,
    config: &LaunchConfig,
    change: Change<'_>,
) -> Result<String> {
    let remove = matches!(change, Change::Remove);
    let keep_missing = match change {
        Change::Install => false,
        Change::Remove => true,
        Change::Repair { keep_missing, .. } => keep_missing,
    };
    let previous = match change {
        Change::Repair { previous_args, .. } => previous_args,
        _ => None,
    };
    let owns =
        |args: &[String]| args == config.args || previous.is_some_and(|previous| previous == args);
    let command = config
        .command
        .to_str()
        .ok_or("MCP executable path is not UTF-8")?;
    match installation.client {
        Client::Codex => {
            let mut document = source
                .parse::<DocumentMut>()
                .map_err(|_| "Codex configuration is invalid; it was left unchanged".to_owned())?;
            if !document.contains_key("mcp_servers") {
                if keep_missing {
                    return Ok(source.into());
                }
                document["mcp_servers"] = Item::Table(Table::new());
            }
            let servers = document["mcp_servers"]
                .as_table_like_mut()
                .ok_or("Codex mcp_servers must be a table")?;
            if let Some(entry) = servers.get(&installation.server_name) {
                let args = entry.get("args").and_then(Item::as_array).and_then(|args| {
                    args.iter()
                        .map(|arg| arg.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                });
                if !args.as_deref().is_some_and(owns) {
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
                entry.insert("command", toml_edit::value(command));
                let mut args = Array::new();
                for arg in &config.args {
                    args.push(arg.as_str());
                }
                entry.insert("args", toml_edit::value(args));
            }
            Ok(document.to_string())
        }
        Client::ClaudeCode | Client::Antigravity => {
            let mut root: Object = if source.trim().is_empty() {
                Object::default()
            } else {
                serde_json::from_str(source).map_err(|_| {
                    "Client configuration is invalid; it was left unchanged".to_owned()
                })?
            };
            if root.get("mcpServers").is_none() && keep_missing {
                return Ok(source.into());
            }
            let mut servers = root.child("mcpServers")?;
            if let Some(raw) = servers.get(&installation.server_name) {
                let entry: Object = serde_json::from_str(raw.get())
                    .map_err(|_| "Invalid client MCP server entry".to_owned())?;
                let args = entry
                    .get("args")
                    .and_then(|raw| serde_json::from_str::<Vec<String>>(raw.get()).ok());
                if !args.as_deref().is_some_and(owns) {
                    return Err("A different MCP server already uses this name; its configuration was left unchanged".into());
                }
            } else if keep_missing {
                return Ok(source.into());
            }
            if remove {
                servers.remove(&installation.server_name);
            } else {
                let mut entry = servers.child(&installation.server_name)?;
                if installation.client == Client::ClaudeCode {
                    entry.set("type", &"stdio")?;
                }
                entry.set("command", &command)?;
                entry.set("args", &config.args)?;
                servers.set(&installation.server_name, &entry)?;
            }
            root.set("mcpServers", &servers)?;
            serde_json::to_string_pretty(&root)
                .map(|text| text + "\n")
                .map_err(|_| "Could not encode client configuration".into())
        }
    }
}

pub(crate) fn apply(
    installation: &Installation,
    config: &LaunchConfig,
    change: Change<'_>,
) -> Result<()> {
    let before = private_files::read_client(&installation.config_path)?;
    let source = before
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| "Client configuration is not UTF-8".to_owned())?
        .unwrap_or("");
    let after = edit(source, installation, config, change)?;
    if source == after {
        return Ok(());
    }
    private_files::atomic_write(
        &installation.config_path,
        after.as_bytes(),
        before.as_deref(),
        true,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn install(client: Client) -> Installation {
        Installation {
            client,
            config_path: "/unused".into(),
            server_name: "drifting_synthetic".into(),
        }
    }
    fn launch() -> LaunchConfig {
        LaunchConfig {
            command: "/synthetic/writer".into(),
            args: vec![
                "--mcp".into(),
                "--connection".into(),
                "/synthetic/connection.json".into(),
            ],
        }
    }
    #[test]
    fn client_formats_preserve_user_settings_and_are_idempotent() {
        for (client, source) in [
            (
                Client::Codex,
                "# Keep user comments\nmodel = 'synthetic-model'\n[mcp_servers.other]\ncommand = 'other' # owned by user\n",
            ),
            (
                Client::ClaudeCode,
                "{\"account\":{\"counter\":184467440737095516160123},\"projects\":{},\"mcpServers\":{\"other\":{\"command\":\"other\"}}}",
            ),
            (
                Client::Antigravity,
                "{\"first\":1,\"mcpServers\":{\"other\":{\"disabled\":true,\"disabledTools\":[\"synthetic\"]}},\"last\":900719925474099312345}",
            ),
        ] {
            let installation = install(client);
            let edited = edit(source, &installation, &launch(), Change::Install).unwrap();
            assert_eq!(
                edit(&edited, &installation, &launch(), Change::Install).unwrap(),
                edited
            );
            assert!(edited.contains("other"));
            let name = match client {
                Client::Codex => "codex",
                Client::ClaudeCode => "claude",
                Client::Antigravity => "antigravity",
            };
            insta::assert_snapshot!(name, edited);
            let removed = edit(&edited, &installation, &launch(), Change::Remove).unwrap();
            assert!(!removed.contains("drifting_synthetic"));
            if client == Client::Codex {
                assert!(removed.contains("# owned by user"));
            } else {
                assert!(removed.contains(if client == Client::ClaudeCode {
                    "184467440737095516160123"
                } else {
                    "900719925474099312345"
                }));
            }
            assert_eq!(
                edit(
                    source,
                    &installation,
                    &launch(),
                    Change::Repair {
                        previous_args: None,
                        keep_missing: true
                    }
                )
                .unwrap(),
                source
            );
        }
    }
    #[test]
    fn owned_controls_survive_repair_and_foreign_entries_are_refused() {
        let installation = install(Client::Antigravity);
        let mut config = launch();
        let source = serde_json::json!({"mcpServers":{"drifting_synthetic":{"command":"old", "args":config.args,"disabled":true,"disabledTools":["synthetic"]}}}).to_string();
        config.command = "/synthetic/moved".into();
        let repaired = edit(
            &source,
            &installation,
            &config,
            Change::Repair {
                previous_args: None,
                keep_missing: true,
            },
        )
        .unwrap();
        assert!(repaired.contains("\"disabled\":true"));
        assert!(repaired.contains("disabledTools"));
        config.args.push("different".into());
        assert!(edit(&source, &installation, &config, Change::Install).is_err());
        assert!(
            edit(
                "{\"mcpServers\":{},\"mcpServers\":{}}",
                &installation,
                &config,
                Change::Install
            )
            .is_err()
        );
    }

    #[test]
    fn moved_connection_repair_is_idempotent_and_codex_accepts_inline_tables() {
        let current = launch();
        let mut previous = current.clone();
        previous.args[2] = "/synthetic/previous/connection.json".into();
        for client in [Client::Codex, Client::ClaudeCode, Client::Antigravity] {
            let installation = install(client);
            let source = edit("", &installation, &previous, Change::Install).unwrap();
            let repair = Change::Repair {
                previous_args: Some(&previous.args),
                keep_missing: true,
            };
            let moved = edit(&source, &installation, &current, repair).unwrap();
            assert_eq!(
                moved,
                edit("", &installation, &current, Change::Install).unwrap()
            );
            assert_eq!(
                edit(&moved, &installation, &current, repair).unwrap(),
                moved
            );
            assert_eq!(edit("", &installation, &current, repair).unwrap(), "");
        }
        let source = "mcp_servers = {other = {command = 'other'}}\n";
        let edited = edit(source, &install(Client::Codex), &current, Change::Install).unwrap();
        let parsed = edited.parse::<DocumentMut>().unwrap();
        assert!(parsed["mcp_servers"]["other"].is_inline_table());
        assert_eq!(
            parsed["mcp_servers"]["drifting_synthetic"]["command"].as_str(),
            Some("/synthetic/writer")
        );
    }
}
