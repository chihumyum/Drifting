//! Secrets in the operating system's credential store: the Keychain on macOS,
//! Credential Manager on Windows.
//!
//! The layout is the 0.1 client's, byte for byte, so the release identity reads
//! every login and API key the Tauri client wrote, and the Tauri client still
//! reads what this one writes if the author goes back:
//!
//! | | macOS | Windows |
//! | --- | --- | --- |
//! | item | generic password, service `<service>`, account `<key>` | generic credential, target `<key>.<service>`, user name `<key>` |
//! | value | UTF-8 bytes | UTF-16LE; longer than 1200 UTF-16 units splits into parts (see `chunked`) |
//!
//! The service is `Drifting` for the release identity and
//! `Drifting.<bundle id>` for anything else, as in the 0.1 client.
//!
//! GPUI's own `write_credentials` / `read_credentials` cannot read those items:
//! it stores internet passwords on macOS and prefixes Windows targets with
//! `zed:url=`, it needs a running app (so tests cannot reach it), and its
//! macOS read may raise a password prompt. See the F7 doc for the decision.

mod chunked;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::identity::Identity;

/// The 0.1 client's limits, kept so a key or value one client accepts the
/// other accepts too.
pub const MAX_KEY_BYTES: usize = 128;
pub const MAX_VALUE_BYTES: usize = 256 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SecretError {
    #[error("invalid secret key")]
    InvalidKey,
    #[error("secret value is too long")]
    TooLong,
    #[error("stored secret is not valid text")]
    Encoding,
    #[error("stored secret is damaged")]
    Damaged,
    #[error("stored secret is incomplete")]
    Incomplete,
    /// The store refused. `code` is the OSStatus or Win32 error.
    #[error("credential store {operation} failed ({code})")]
    Platform { operation: &'static str, code: i64 },
    #[error("this platform has no credential store")]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, SecretError>;

/// One credential store, by account (macOS) or key (Windows target prefix).
/// `delete` succeeds when nothing is stored.
pub(crate) trait RawStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn exists(&self, key: &str) -> Result<bool> {
        self.get(key).map(|value| value.is_some())
    }
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

/// Keys the 0.1 client accepts: ASCII letters, digits and `. _ : -`.
pub fn key_is_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

/// The 0.1 client's rule (`keychain_service_for`): its own identifiers share
/// `Drifting`, every other identifier gets `Drifting.<identifier>`.
pub fn service_for_bundle_id(bundle_id: &str) -> String {
    if matches!(bundle_id, "cc.drifting.client" | "cc.drifting.client.dev") {
        "Drifting".into()
    } else {
        format!("Drifting.{bundle_id}")
    }
}

/// The key names the 0.1 client stored, for the crates that take each secret
/// over (sign-in, the Agent's providers, extensions), so an upgraded library
/// keeps its logins and API keys.
pub mod keys {
    use sha2::{Digest, Sha256};

    /// A Hosted session: `drifting.hosted.v1.<sha256 of the API origin>`,
    /// as `hostedSessionStorageKey` (`session-token.ts`). `origin` is
    /// `scheme://host[:port]`, lower case, no default port, no path.
    pub fn hosted_session(origin: &str) -> String {
        format!("drifting.hosted.v1.{:x}", Sha256::digest(origin.as_bytes()))
    }

    /// An API key: `byok.openai`, `byok.anthropic`, `byok.deepseek`, and
    /// `byok.dashscope` for speech (`byok-keychain.ts`).
    pub fn api_key(provider: &str) -> String {
        format!("byok.{provider}")
    }

    /// The Agent's Anthropic key before it moved to `byok.anthropic`; the 0.1
    /// client still migrated it on read.
    pub const LEGACY_AGENT_ANTHROPIC: &str = "byok.agent.anthropic";
    /// The ChatGPT subscription's OAuth tokens (`codex_oauth.rs`), long enough
    /// to be split on Windows.
    pub const CHATGPT_SUBSCRIPTION: &str = "oauth.openai-codex";
    /// Extension (MCP server) secrets start with this, followed by the
    /// URI-encoded project id, server id, transport and name
    /// (`AgentExtensionsSettings.tsx`).
    pub const EXTENSION_PREFIX: &str = "drifting.mcp.";
}

pub struct SecretStore {
    service: String,
    raw: Box<dyn RawStore>,
}

impl std::fmt::Debug for SecretStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretStore")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl SecretStore {
    /// The system store under this run's service (`Identity::secret_service`:
    /// the identity's, plus the development profile when there is one).
    pub fn for_identity(identity: &Identity) -> Self {
        Self::system(identity.secret_service())
    }

    /// The system store under any service. Tests use a throwaway service so
    /// they never see the author's items.
    pub fn system(service: impl Into<String>) -> Self {
        let service = service.into();
        let raw = system_store(&service);
        Self { service, raw }
    }

    /// A store that lives only in this process, for other crates' tests.
    pub fn in_memory() -> Self {
        Self {
            service: "memory".into(),
            raw: Box::new(MemoryStore::default()),
        }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        check_key(key)?;
        self.raw.get(key)
    }

    /// Whether a value exists, without reading it where the store allows
    /// (macOS reads attributes only, so a status check never prompts).
    pub fn contains(&self, key: &str) -> Result<bool> {
        check_key(key)?;
        self.raw.exists(key)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        check_key(key)?;
        if value.len() > MAX_VALUE_BYTES {
            return Err(SecretError::TooLong);
        }
        self.raw.set(key, value)
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        check_key(key)?;
        self.raw.delete(key)
    }
}

fn check_key(key: &str) -> Result<()> {
    if key_is_valid(key) {
        Ok(())
    } else {
        Err(SecretError::InvalidKey)
    }
}

#[cfg(target_os = "macos")]
fn system_store(service: &str) -> Box<dyn RawStore> {
    Box::new(macos::Keychain::new(service))
}

#[cfg(windows)]
fn system_store(service: &str) -> Box<dyn RawStore> {
    Box::new(chunked::Chunked::new(windows::CredentialManager::new(
        service,
    )))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_store(_service: &str) -> Box<dyn RawStore> {
    Box::new(Unsupported)
}

#[cfg(not(any(target_os = "macos", windows)))]
struct Unsupported;

#[cfg(not(any(target_os = "macos", windows)))]
impl RawStore for Unsupported {
    fn get(&self, _key: &str) -> Result<Option<String>> {
        Err(SecretError::Unsupported)
    }
    fn set(&self, _key: &str, _value: &str) -> Result<()> {
        Err(SecretError::Unsupported)
    }
    fn delete(&self, _key: &str) -> Result<()> {
        Err(SecretError::Unsupported)
    }
}

#[derive(Default)]
struct MemoryStore(Mutex<BTreeMap<String, String>>);

impl RawStore for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{DEVELOPMENT, RELEASE};

    #[test]
    fn services_follow_the_tauri_clients_rule() {
        assert_eq!(service_for_bundle_id("cc.drifting.client"), "Drifting");
        assert_eq!(service_for_bundle_id("cc.drifting.client.dev"), "Drifting");
        assert_eq!(
            service_for_bundle_id("cc.drifting.next.dev"),
            "Drifting.cc.drifting.next.dev"
        );
        for identity in [DEVELOPMENT, RELEASE] {
            assert_eq!(
                identity.keychain_service,
                service_for_bundle_id(identity.bundle_id)
            );
        }
    }

    #[test]
    fn keys_the_renderer_used_stay_valid_and_paths_do_not() {
        for key in [
            "drifting.session_token",
            "byok.anthropic",
            "byok.agent.anthropic",
            "oauth.openai-codex",
            "sync.provider.credentials.opaque",
        ] {
            assert!(key_is_valid(key), "{key}");
        }
        for key in ["", "../session", "session/token", "session token", "令牌"] {
            assert!(!key_is_valid(key), "{key:?}");
        }
        assert!(!key_is_valid(&"a".repeat(MAX_KEY_BYTES + 1)));
    }

    #[test]
    fn legacy_key_names_match_the_tauri_client() {
        // Cross-checked with Python's hashlib, as the 0.1 client hashes with
        // WebCrypto.
        assert_eq!(
            keys::hosted_session("https://api.drifting.cc"),
            "drifting.hosted.v1.9f2136a19b5dab39ad5f371c4ba1adf1e5ea04f2d3bddaa9d8d14fd69be989d1"
        );
        assert!(key_is_valid(&keys::hosted_session("http://localhost:3000")));
        assert_eq!(keys::api_key("openai"), "byok.openai");
        for key in [keys::LEGACY_AGENT_ANTHROPIC, keys::CHATGPT_SUBSCRIPTION] {
            assert!(key_is_valid(key));
        }
    }

    #[test]
    fn the_memory_store_round_trips_and_checks_limits() {
        let store = SecretStore::in_memory();
        assert_eq!(store.get("byok.openai"), Ok(None));
        store.set("byok.openai", "sk-test").unwrap();
        assert_eq!(
            store.get("byok.openai").unwrap().as_deref(),
            Some("sk-test")
        );
        assert_eq!(store.contains("byok.openai"), Ok(true));
        store.delete("byok.openai").unwrap();
        store.delete("byok.openai").unwrap();
        assert_eq!(store.contains("byok.openai"), Ok(false));
        assert_eq!(store.set("bad key", "x"), Err(SecretError::InvalidKey));
        assert_eq!(
            store.set("byok.openai", &"x".repeat(MAX_VALUE_BYTES + 1)),
            Err(SecretError::TooLong)
        );
    }
}
