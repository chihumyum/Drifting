//! A run owns this snapshot. Settings changes only affect the next run.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Provider {
    #[serde(rename = "deepseek")]
    Deepseek,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "openai-codex")]
    Chatgpt,
    /// A model server on this computer or the local network (Ollama,
    /// LM Studio, llama.cpp …). The route names which one.
    #[serde(rename = "local")]
    Local,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deepseek => "deepseek",
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Chatgpt => "openai-codex",
            Self::Local => "local",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    #[default]
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl ThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRoute {
    pub provider: Provider,
    pub model: String,
    pub thinking: ThinkingLevel,
    /// Only for [`Provider::Local`]: which server, frozen with the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalRoute>,
}

/// The local server a run talks to. The address is frozen into the run like
/// the model; the server id names its key in the credential store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalRoute {
    pub server: String,
    /// `scheme://host[:port][/path]`, without a trailing `/v1`.
    pub base_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunConfig {
    pub route: ModelRoute,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
    pub system_prompt: String,
    pub max_output_tokens: Option<u32>,
    /// The author's “帮手单轮迭代上限”; None means no implicit limit.
    pub max_model_rounds: Option<u32>,
    pub web_search: bool,
}

impl RunConfig {
    pub fn new(provider: Provider, model: impl Into<String>) -> Self {
        Self {
            route: ModelRoute {
                provider,
                model: model.into(),
                thinking: ThinkingLevel::Off,
                local: None,
            },
            capabilities: None,
            system_prompt: String::new(),
            max_output_tokens: None,
            max_model_rounds: None,
            web_search: true,
        }
    }

    pub fn validate(&self) -> crate::Result<()> {
        let local = self.route.local.as_ref().is_some_and(|local| {
            !local.server.trim().is_empty() && !local.base_url.trim().is_empty()
        });
        if self.route.model.trim().is_empty()
            || self.max_model_rounds == Some(0)
            || self.max_output_tokens == Some(0)
            || local != (self.route.provider == Provider::Local)
        {
            return Err(crate::Error::Protocol(
                "model and positive author-selected limits required".into(),
            ));
        }
        Ok(())
    }
}

/// Catalog metadata captured together with the route. Adapters never consult
/// a mutable model picker while a tool loop is running.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u32>,
    pub thinking_levels: Vec<ThinkingLevel>,
    pub supports_thinking_off: Option<bool>,
    pub supports_summary: Option<bool>,
    pub supports_verbosity: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_route_names_its_server_and_older_routes_still_read() {
        let mut config = RunConfig::new(Provider::Local, "synthetic-local");
        assert!(config.validate().is_err(), "a local run needs its server");
        config.route.local = Some(LocalRoute {
            server: "synthetic-server".into(),
            base_url: "http://localhost:11434".into(),
        });
        config.validate().unwrap();
        let value = serde_json::to_value(&config.route).unwrap();
        assert_eq!(value["provider"], "local");
        assert_eq!(value["local"]["server"], "synthetic-server");
        let mut blank = config.clone();
        blank.route.local.as_mut().unwrap().base_url = " ".into();
        assert!(blank.validate().is_err());

        let mut remote = RunConfig::new(Provider::Deepseek, "deepseek-flash");
        remote.validate().unwrap();
        let value = serde_json::to_value(&remote.route).unwrap();
        assert!(value.get("local").is_none(), "nothing new is written");
        let read: ModelRoute = serde_json::from_value(serde_json::json!({
            "provider": "deepseek", "model": "deepseek-flash", "thinking": "off"
        }))
        .unwrap();
        assert_eq!(read, remote.route);
        remote.route.local = config.route.local.clone();
        assert!(remote.validate().is_err(), "only a local run has a server");
    }
}
