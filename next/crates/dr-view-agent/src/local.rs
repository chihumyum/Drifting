//! Model servers the author adds by address (「自定义服务」; a local model
//! server on this computer or the local network, or a service on the
//! internet over https): the list this device keeps, and the network steps
//! the connection form takes. The list stays on this device (it is not an
//! account preference, 作者 2026-11-16 and 2026-11-23). Keys stay in the
//! credential store, one per server.

use dr_agent_providers::local::{
    self, AddressError, DiscoverError, Discovery, LocalAddress, LocalModel, Reach, Software,
};
use dr_shell::Settings;
use gpui::App;
use serde::{Deserialize, Serialize};

use crate::connection::ConnectionService;

/// Device memory: the servers, in the order they were added.
pub const SERVERS_KEY: &str = "agent.local_servers";
/// Device memory: which server the selected local model is on.
pub const SELECTED_KEY: &str = "agent.local_server";
/// What the address field shows before anything is typed.
pub const ADDRESS_PLACEHOLDER: &str = "http://localhost:11434";
/// The context assumed when the server did not say and the author did not
/// set one (the same default the planner uses).
pub const DEFAULT_CONTEXT: u64 = 32_768;
const MAX_SERVERS: usize = 32;
const MAX_MODELS: usize = 500;
pub const MAX_CONTEXT: u64 = 100_000_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalServer {
    pub id: String,
    pub base_url: String,
    /// The recognized software's name, or the address.
    pub label: String,
    /// Whether a key is in the credential store (never the key itself).
    #[serde(default)]
    pub has_key: bool,
    /// The server gave no model list; the author typed the names.
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub models: Vec<LocalServerModel>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalServerModel {
    pub id: String,
    /// What the server reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
    /// What the author set in Settings; it wins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_override: Option<u64>,
    /// Whether the server said the model takes images (CM4a); a list kept
    /// before this was asked, or a model typed by hand, says nothing (no).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_input: Option<bool>,
}

impl LocalServerModel {
    pub fn new(id: impl Into<String>, context: Option<u64>) -> Self {
        Self {
            id: id.into(),
            context,
            context_override: None,
            image_input: None,
        }
    }

    /// The author's value, else the server's; `None` leaves the planner's
    /// default ([`DEFAULT_CONTEXT`]).
    pub fn context_window(&self) -> Option<u64> {
        self.context_override.or(self.context)
    }
}

impl LocalServer {
    /// `host:port`, this computer as `localhost`.
    pub fn display(&self) -> String {
        LocalAddress::parse(&self.base_url)
            .map(|address| address.display)
            .unwrap_or_else(|_| self.base_url.clone())
    }

    pub fn model(&self, id: &str) -> Option<&LocalServerModel> {
        self.models.iter().find(|model| model.id == id)
    }

    /// A service on the internet: its model list is never offered.
    pub fn on_the_internet(&self) -> bool {
        LocalAddress::parse(&self.base_url).is_ok_and(|address| address.reach == Reach::Internet)
    }

    fn valid(&self) -> bool {
        dr_agent_providers::credentials::local_key_id(&self.id).is_ok()
            && LocalAddress::parse(&self.base_url)
                .is_ok_and(|address| address.base_url == self.base_url)
            && !self.label.trim().is_empty()
            && self.label.len() <= 256
    }
}

/// The stored list. Entries that no longer pass the address rule (a hand
/// edited file) are left out rather than connected to.
pub fn read(cx: &App) -> Vec<LocalServer> {
    from_value(Settings::device_memory(cx, SERVERS_KEY))
}

pub fn from_value(value: Option<serde_json::Value>) -> Vec<LocalServer> {
    let servers: Vec<LocalServer> = value
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let mut ids = std::collections::HashSet::new();
    servers
        .into_iter()
        .filter(|server| server.valid() && ids.insert(server.id.clone()))
        .take(MAX_SERVERS)
        .map(|mut server| {
            let mut seen = std::collections::HashSet::new();
            server
                .models
                .retain(|model| local::valid_model_id(&model.id) && seen.insert(model.id.clone()));
            server.models.truncate(MAX_MODELS);
            for model in &mut server.models {
                model.context = model.context.filter(|n| (1..=MAX_CONTEXT).contains(n));
                model.context_override = model
                    .context_override
                    .filter(|n| (1..=MAX_CONTEXT).contains(n));
            }
            server
        })
        .collect()
}

pub fn write(servers: &[LocalServer], cx: &mut App) {
    Settings::set_device_memory(
        cx,
        SERVERS_KEY,
        (!servers.is_empty())
            .then(|| serde_json::to_value(servers).expect("local server list is JSON")),
    );
}

pub fn read_selected(cx: &App) -> Option<String> {
    Settings::device_memory(cx, SELECTED_KEY).and_then(|value| value.as_str().map(str::to_owned))
}

pub fn write_selected(server: Option<&str>, cx: &mut App) {
    Settings::set_device_memory(cx, SELECTED_KEY, server.map(serde_json::Value::from));
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The recognized software's name; the address when unrecognized or when
/// another server already has that name (the later one takes the address).
pub fn label_for(
    software: Option<Software>,
    address: &LocalAddress,
    others: &[LocalServer],
    except: Option<&str>,
) -> String {
    let label = software
        .map(|software| software.name().to_owned())
        .unwrap_or_else(|| address.display.clone());
    if others
        .iter()
        .any(|other| Some(other.id.as_str()) != except && other.label == label)
    {
        address.display.clone()
    } else {
        label
    }
}

/// What the form shows under its buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalFailure {
    /// 「网上的地址要用 https」: an address on the internet over plain http
    /// (作者 2026-11-24).
    NeedsHttps,
    /// 「连不上这个地址」
    Unreachable,
    /// 「密钥无效」
    InvalidKey,
    /// 「这台服务上没有能用工具的模型」: the list came, nothing on it can use
    /// tools (作者 2026-11-16, 乙).
    NoToolModels,
    /// 「请求失败（provider 不可用或网络问题）」: the server is up, but the
    /// model gave no answer in time or refused the request.
    RequestFailed,
    /// The credential store refused the key.
    Storage,
}

/// What happens to a server's key when the form connects. The value never
/// reaches `Debug` output.
#[derive(Clone, PartialEq, Eq)]
pub enum KeyChange {
    /// The key field stayed closed: whatever is stored stays.
    Keep,
    /// The field was opened and left empty: the key goes.
    Clear,
    Set(String),
}

impl std::fmt::Debug for KeyChange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Keep => "Keep",
            Self::Clear => "Clear",
            Self::Set(_) => "Set(..)",
        })
    }
}

impl KeyChange {
    /// Whether the server has a key after this change.
    pub fn has_key(&self, before: bool) -> bool {
        match self {
            Self::Keep => before,
            Self::Clear => false,
            Self::Set(_) => true,
        }
    }
}

/// What the server answered to the form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Probe {
    /// Its models, offered as they are: this computer or the local network.
    Listed(Discovery),
    /// Ask for a model name: the server answered without a model list, or
    /// it is on the internet, whose list is not offered (作者 2026-11-24).
    /// `known` is what its list said, for the context of a name typed from it.
    AskName {
        software: Option<Software>,
        known: Vec<LocalModel>,
    },
}

impl Probe {
    fn ask_name() -> Self {
        Self::AskName {
            software: None,
            known: Vec::new(),
        }
    }
}

impl ConnectionService {
    /// Parse what was typed, then ask the server for its models with the key
    /// the form would leave (`existing`: the server being edited). A service
    /// on the internet is asked too: that is how the form knows it is there
    /// and takes the key.
    pub async fn probe_local(
        &self,
        raw: &str,
        key: &KeyChange,
        existing: Option<&str>,
    ) -> Result<(LocalAddress, Probe), LocalFailure> {
        let address = LocalAddress::parse(raw).map_err(|error| match error {
            AddressError::NeedsHttps => LocalFailure::NeedsHttps,
            AddressError::Invalid => LocalFailure::Unreachable,
        })?;
        let stored = match (key, existing) {
            (KeyChange::Keep, Some(server)) => self
                .driver()
                .credentials()
                .local_key(server)
                .await
                .map_err(|_| LocalFailure::Storage)?,
            _ => None,
        };
        let key = match key {
            KeyChange::Set(value) => Some(value.trim().to_owned()),
            KeyChange::Clear => None,
            KeyChange::Keep => stored,
        };
        let http = self.driver().http().clone();
        let found = local::discover(&http, &address, key.as_deref()).await;
        let internet = address.reach == Reach::Internet;
        match found {
            Ok(discovery) if internet => Ok((
                address,
                Probe::AskName {
                    software: discovery.software,
                    known: discovery.models,
                },
            )),
            Ok(discovery) => Ok((address, Probe::Listed(discovery))),
            Err(DiscoverError::NoList) => Ok((address, Probe::ask_name())),
            // Nothing on its list to offer, but the list is not offered anyway.
            Err(DiscoverError::NoToolModels) if internet => Ok((address, Probe::ask_name())),
            Err(DiscoverError::NoToolModels) => Err(LocalFailure::NoToolModels),
            Err(DiscoverError::Unauthorized) => Err(LocalFailure::InvalidKey),
            Err(DiscoverError::Unreachable) => Err(LocalFailure::Unreachable),
        }
    }

    /// Store, remove or keep the server's key, after the server accepted it.
    pub async fn apply_local_key(&self, server: &str, key: &KeyChange) -> Result<(), LocalFailure> {
        let credentials = self.driver().credentials().clone();
        match key {
            KeyChange::Keep => Ok(()),
            KeyChange::Clear => credentials.remove_local_key(server).await,
            KeyChange::Set(value) => credentials.set_local_key(server, value.trim()).await,
        }
        .map_err(|_| LocalFailure::Storage)
    }

    /// 「测试连接」 (作者 2026-11-16, 乙): is the server there with its stored
    /// key, and does `config`'s model answer one short sentence? A model's
    /// first load can take minutes, so the wait is minutes long
    /// ([`dr_agent_providers::local::MODEL_WAIT`]).
    pub async fn test_local(
        &self,
        server: &LocalServer,
        config: dr_agent::RunConfig,
    ) -> Result<(), LocalFailure> {
        let address =
            LocalAddress::parse(&server.base_url).map_err(|_| LocalFailure::Unreachable)?;
        let key = if server.has_key {
            self.driver()
                .credentials()
                .local_key(&server.id)
                .await
                .map_err(|_| LocalFailure::Storage)?
        } else {
            None
        };
        let http = self.driver().http().clone();
        local::check(&http, &address, key.as_deref())
            .await
            .map_err(|error| match error {
                DiscoverError::Unauthorized => LocalFailure::InvalidKey,
                _ => LocalFailure::Unreachable,
            })?;
        let driver = self.driver();
        // A thinking model may think before its 「OK」: the cap the three
        // providers' check gives thinking models.
        match tokio::time::timeout(
            self.local_wait(),
            crate::connection::say_ok(&driver, config, 1024),
        )
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(crate::connection::Failure::Provider(
                dr_agent::ModelErrorCategory::Authentication,
            ))) => Err(LocalFailure::InvalidKey),
            Ok(Err(_)) | Err(_) => Err(LocalFailure::RequestFailed),
        }
    }

    /// A fresh model list for a server whose list came from the server, or
    /// what a service on the internet lists (for a typed name's context).
    pub async fn relist_local(&self, server: &LocalServer) -> Option<Discovery> {
        let address = LocalAddress::parse(&server.base_url).ok()?;
        let key = if server.has_key {
            self.driver()
                .credentials()
                .local_key(&server.id)
                .await
                .ok()?
        } else {
            None
        };
        let http = self.driver().http().clone();
        local::discover(&http, &address, key.as_deref()).await.ok()
    }

    pub async fn forget_local_key(&self, server: &str) -> Result<(), LocalFailure> {
        self.driver()
            .credentials()
            .remove_local_key(server)
            .await
            .map_err(|_| LocalFailure::Storage)
    }
}

/// The models a fresh list gives, keeping what the author set for models
/// that are still there.
pub fn merge_models(
    previous: &[LocalServerModel],
    listed: &[local::LocalModel],
) -> Vec<LocalServerModel> {
    listed
        .iter()
        .take(MAX_MODELS)
        .map(|model| LocalServerModel {
            id: model.id.clone(),
            context: model.context_window,
            context_override: previous
                .iter()
                .find(|old| old.id == model.id)
                .and_then(|old| old.context_override),
            image_input: model.image_input,
        })
        .collect()
}

/// What the author typed in a 「上下文」 field: digits only; empty means none.
pub fn parse_context(text: &str) -> Option<u64> {
    text.trim()
        .parse::<u64>()
        .ok()
        .filter(|n| (1..=MAX_CONTEXT).contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_stored_list_drops_what_the_address_rule_would_refuse() {
        let servers = from_value(Some(json!([
            {"id":"a1","base_url":"http://localhost:11434","label":"Ollama",
             "models":[{"id":"qwen3:14b","context":40960},{"id":"qwen3:14b"},{"id":" "}]},
            {"id":"a1","base_url":"http://localhost:1234","label":"dup id"},
            {"id":"b2","base_url":"https://api.example.com","label":"api.example.com",
             "has_key":true,"manual":true,"models":[{"id":"example-chat"}]},
            {"id":"b3","base_url":"http://api.example.com","label":"plain http"},
            {"id":"c 3","base_url":"http://localhost:8080","label":"bad id"},
            {"id":"d4","base_url":"http://localhost:8080/v1","label":"unnormalized"},
            {"id":"e5","base_url":"http://192.168.1.20:11434","label":"Ollama","has_key":true,
             "models":[{"id":"m","context_override":0}]}
        ])));
        assert_eq!(
            servers.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["a1", "b2", "e5"]
        );
        assert_eq!(servers[0].models.len(), 1);
        assert_eq!(servers[0].models[0].context_window(), Some(40960));
        assert!(!servers[0].on_the_internet());
        assert!(servers[1].on_the_internet());
        assert_eq!(servers[1].display(), "api.example.com");
        assert!(servers[2].has_key);
        assert_eq!(servers[2].models[0].context_override, None);
        assert_eq!(servers[2].display(), "192.168.1.20:11434");
        assert!(!servers[2].on_the_internet());
        assert!(from_value(Some(json!({"not":"a list"}))).is_empty());
    }

    #[test]
    fn names_follow_the_software_and_a_repeat_takes_the_address() {
        let address = LocalAddress::parse("http://192.168.1.20:11434").unwrap();
        let ollama = LocalServer {
            id: "a".into(),
            base_url: "http://localhost:11434".into(),
            label: "Ollama".into(),
            has_key: false,
            manual: false,
            models: Vec::new(),
        };
        assert_eq!(
            label_for(Some(Software::Ollama), &address, &[], None),
            "Ollama"
        );
        assert_eq!(
            label_for(
                Some(Software::Ollama),
                &address,
                std::slice::from_ref(&ollama),
                None
            ),
            "192.168.1.20:11434"
        );
        assert_eq!(
            label_for(Some(Software::Ollama), &address, &[ollama], Some("a")),
            "Ollama",
            "editing a server does not collide with itself"
        );
        assert_eq!(label_for(None, &address, &[], None), "192.168.1.20:11434");
        assert_eq!(
            label_for(Some(Software::LmStudio), &address, &[], None),
            "LM Studio"
        );
        // A service on the internet is rarely recognized: its host, and the
        // port only when it is not the standard one (作者 2026-11-24).
        for (raw, label) in [
            ("https://api.example.com/v1", "api.example.com"),
            ("https://api.example.com:443/v1", "api.example.com"),
            ("https://api.example.com:8443", "api.example.com:8443"),
        ] {
            let address = LocalAddress::parse(raw).unwrap();
            assert_eq!(label_for(None, &address, &[], None), label, "{raw}");
        }
        let internet = LocalAddress::parse("https://api.example.com").unwrap();
        assert_eq!(
            label_for(Some(Software::Ollama), &internet, &[], None),
            "Ollama",
            "recognized software keeps its name"
        );
    }

    #[test]
    fn a_fresh_list_keeps_the_authors_context_for_models_still_there() {
        let previous = vec![
            LocalServerModel {
                id: "kept".into(),
                context: Some(131_072),
                context_override: Some(16_384),
                image_input: None,
            },
            LocalServerModel {
                id: "gone".into(),
                context: None,
                context_override: Some(8_192),
                image_input: None,
            },
        ];
        let merged = merge_models(
            &previous,
            &[
                local::LocalModel {
                    id: "kept".into(),
                    context_window: Some(65_536),
                    image_input: Some(true),
                },
                local::LocalModel {
                    id: "new".into(),
                    context_window: None,
                    image_input: None,
                },
            ],
        );
        // What the fresh list says about images replaces the old answer.
        assert_eq!(merged[0].image_input, Some(true));
        assert_eq!(merged[1].image_input, None);
        assert_eq!(merged[0].context, Some(65_536));
        assert_eq!(merged[0].context_window(), Some(16_384));
        assert_eq!(merged[1].context_window(), None);
        assert_eq!(merged.len(), 2);
        assert_eq!(parse_context(" 8192 "), Some(8192));
        for text in ["", "0", "abc", "-5", "100000001"] {
            assert_eq!(parse_context(text), None, "{text}");
        }
        assert_eq!(format!("{:?}", KeyChange::Set("secret".into())), "Set(..)");
        assert!(KeyChange::Keep.has_key(true) && !KeyChange::Clear.has_key(true));
    }
}
