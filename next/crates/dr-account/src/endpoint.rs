//! Hosted service endpoint configuration and local-only boundary.
//!
//! Public source builds do not set `DRIFTING_API_BASE_URL` and default to
//! local-only mode. Development builds may point at a local loopback service
//! through `DRIFTING_DEV_API_BASE_URL`. Only `https://` or loopback `http://`
//! (`127.0.0.1`, `localhost`, `::1`) is accepted.

use dr_platform::{Channel, Identity};
use url::Url;

/// Development runtime override for pointing at a local fake service.
pub const DEV_API_BASE_ENV: &str = "DRIFTING_DEV_API_BASE_URL";

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the Hosted API base URL must be https:// or loopback http://")]
pub struct EndpointError;

/// A validated Hosted service origin (without a trailing slash).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct HostedOrigin {
    base: String,
}

impl HostedOrigin {
    /// Parses and validates `raw` as a Hosted API base URL.
    pub fn parse(raw: &str) -> Result<Self, EndpointError> {
        let trimmed = raw.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            return Err(EndpointError);
        }
        let parsed = Url::parse(trimmed).map_err(|_| EndpointError)?;
        if parsed.query().is_some()
            || parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(EndpointError);
        }
        match parsed.scheme() {
            "https" => {
                if parsed.host_str().is_none() {
                    return Err(EndpointError);
                }
            }
            "http" => {
                let Some(host) = parsed.host_str() else {
                    return Err(EndpointError);
                };
                if !matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1") {
                    return Err(EndpointError);
                }
            }
            _ => return Err(EndpointError),
        }
        Ok(Self {
            base: trimmed.to_owned(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.base
    }

    /// Joins an API path (such as `"/api/auth/get-session"`) onto this origin.
    pub fn endpoint(&self, path: &str) -> String {
        let suffix = path.trim_start_matches('/');
        format!("{}/{suffix}", self.base)
    }
}

/// Whether this build is configured with a Hosted service or runs local-only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostedConfig {
    origin: Option<HostedOrigin>,
}

impl HostedConfig {
    pub const fn local_only() -> Self {
        Self { origin: None }
    }

    pub const fn with_origin(origin: HostedOrigin) -> Self {
        Self {
            origin: Some(origin),
        }
    }

    /// Resolves the Hosted configuration for this build.
    pub fn for_build(identity: &Identity) -> Self {
        let dev_base = (identity.channel == Channel::Development)
            .then(|| std::env::var(DEV_API_BASE_ENV).ok())
            .flatten();
        Self::decide(dev_base.as_deref().or(option_env!("DRIFTING_API_BASE_URL")))
    }

    pub fn decide(raw_base: Option<&str>) -> Self {
        match raw_base
            .filter(|s| !s.trim().is_empty())
            .map(HostedOrigin::parse)
        {
            Some(Ok(origin)) => Self::with_origin(origin),
            Some(Err(err)) => {
                log::warn!("Hosted service disabled due to invalid base URL: {err}");
                Self::local_only()
            }
            None => Self::local_only(),
        }
    }

    pub fn is_configured(&self) -> bool {
        self.origin.is_some()
    }

    pub fn origin(&self) -> Option<&HostedOrigin> {
        self.origin.as_ref()
    }
}
