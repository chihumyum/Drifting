//! Reviewed Codex wire compatibility, independent of Drifting's app version.
//! Updating the upstream release number requires catalog and Responses checks.

use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Compatibility {
    pub client_version: String,
}

pub(crate) fn compatibility() -> &'static Compatibility {
    static VALUE: OnceLock<Compatibility> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!("../codex-compatibility.json"))
            .expect("checked Codex compatibility manifest")
    })
}

pub(crate) fn user_agent() -> &'static str {
    static VALUE: OnceLock<String> = OnceLock::new();
    VALUE.get_or_init(|| {
        format!(
            "codex_cli_rs/{} (Drifting/{})",
            compatibility().client_version,
            env!("CARGO_PKG_VERSION")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_and_oauth_share_the_reviewed_compatibility_version() {
        let version = &compatibility().client_version;
        assert_ne!(version, "0.0.0");
        let parts: Vec<_> = version.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|part| part.parse::<u32>().is_ok()));
        assert!(user_agent().starts_with(&format!("codex_cli_rs/{version} (Drifting/")));
    }
}
