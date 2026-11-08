use dr_agent::{ModelErrorCategory, ModelFailure};
use std::time::Duration;

pub type Result<T> = std::result::Result<T, ProviderError>;

/// Provider bodies may contain secrets or author text. They are only inspected
/// for classification and never retained, logged or sent to the local journal.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct ProviderError {
    pub category: ModelErrorCategory,
    pub message: String,
    pub retryable: bool,
    pub retry_after: Option<Duration>,
}

impl ProviderError {
    pub fn new(category: ModelErrorCategory, retryable: bool) -> Self {
        let message = match category {
            ModelErrorCategory::Authentication => "Connect this model provider again.",
            ModelErrorCategory::Quota => "The model provider's quota or request limit was reached.",
            ModelErrorCategory::Network => "The model provider could not be reached. Try again.",
            ModelErrorCategory::Unsupported => {
                "This model does not support the requested operation."
            }
            ModelErrorCategory::InvalidResponse => {
                "The model returned an incomplete or invalid response."
            }
            ModelErrorCategory::Cancelled => "The model request was cancelled.",
        };
        Self {
            category,
            message: message.into(),
            retryable,
            retry_after: None,
        }
    }

    pub fn protocol(_detail: impl Into<String>) -> Self {
        Self::new(ModelErrorCategory::InvalidResponse, true)
    }

    pub fn network(_detail: impl std::fmt::Display) -> Self {
        Self::new(ModelErrorCategory::Network, true)
    }

    pub fn cancelled() -> Self {
        Self::new(ModelErrorCategory::Cancelled, false)
    }

    pub fn from_status(status: u16, body: &str) -> Self {
        use ModelErrorCategory::*;
        let lower = body.to_ascii_lowercase();
        match status {
            401 | 403 => Self::new(Authentication, false),
            402 => Self::new(Quota, false),
            429 => Self::new(
                Quota,
                !["insufficient_quota", "billing", "credit balance"]
                    .iter()
                    .any(|s| lower.contains(s)),
            ),
            408 | 409 | 425 | 500..=599 => Self::new(Network, true),
            _ if lower.contains("quota") || lower.contains("credit balance") => {
                Self::new(Quota, false)
            }
            _ => Self::new(Unsupported, false),
        }
    }
}

impl From<ProviderError> for dr_agent::Error {
    fn from(error: ProviderError) -> Self {
        ModelFailure {
            category: error.category,
            message: error.message,
        }
        .into()
    }
}

impl From<reqwest::Error> for ProviderError {
    fn from(error: reqwest::Error) -> Self {
        Self::network(error)
    }
}

impl From<serde_json::Error> for ProviderError {
    fn from(_: serde_json::Error) -> Self {
        Self::protocol("invalid JSON")
    }
}

impl From<dr_platform::secrets::SecretError> for ProviderError {
    fn from(_: dr_platform::secrets::SecretError) -> Self {
        Self::new(ModelErrorCategory::Authentication, false)
    }
}
