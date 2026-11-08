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
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deepseek => "deepseek",
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Chatgpt => "openai-codex",
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
            },
            capabilities: None,
            system_prompt: String::new(),
            max_output_tokens: None,
            max_model_rounds: None,
            web_search: true,
        }
    }

    pub fn validate(&self) -> crate::Result<()> {
        if self.route.model.trim().is_empty()
            || self.max_model_rounds == Some(0)
            || self.max_output_tokens == Some(0)
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
