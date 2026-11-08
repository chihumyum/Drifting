//! The 0.1 client's keys and OAuth JSON, through F7's platform credential store.
//! This module never selects a production service: the app supplies its store.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use dr_agent::Provider;
use dr_platform::secrets::{SecretStore, keys};
use serde::{Deserialize, Serialize};

use crate::{ProviderError, Result};

pub const MAX_TOKEN_BYTES: usize = 32 * 1024;

/// Byte-compatible with `src-tauri/src/codex_oauth.rs::StoredTokens`.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
}

impl std::fmt::Debug for StoredTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredTokens")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

impl StoredTokens {
    pub fn valid(&self) -> bool {
        valid_secret(&self.access_token)
            && valid_secret(&self.refresh_token)
            && self.expires_at_ms > 0
            && self.id_token.as_deref().is_none_or(valid_secret)
    }
}

fn valid_secret(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_TOKEN_BYTES
}

#[derive(Clone)]
pub struct Credentials {
    store: Arc<SecretStore>,
    io: Arc<Mutex<()>>,
    oauth_save_checkpoint: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Credentials {
    pub fn new(store: Arc<SecretStore>) -> Self {
        Self {
            store,
            io: Arc::new(Mutex::new(())),
            oauth_save_checkpoint: None,
        }
    }

    /// Deterministic acceptance hook inside the native I/O lease, after the
    /// generation check and immediately before OAuth persistence. It receives
    /// no credential bytes. Production stores leave this unset.
    #[doc(hidden)]
    pub fn with_oauth_save_checkpoint(mut self, checkpoint: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.oauth_save_checkpoint = Some(checkpoint);
        self
    }

    /// A candidate key for an explicit connectivity check. Nothing reaches the
    /// operating system store until the caller accepts the successful check.
    pub fn candidate(provider: Provider, value: &str) -> Result<Self> {
        let key = api_key_id(provider)?;
        let value = value.trim();
        if !valid_secret(value) {
            return Err(ProviderError::protocol("invalid API key"));
        }
        let store = Arc::new(SecretStore::in_memory());
        store.set(key, value)?;
        Ok(Self::new(store))
    }

    /// Presence only: drawing a connection row must not decrypt a secret or
    /// prompt on macOS. The legacy Anthropic key is migrated on explicit use.
    pub async fn has_api_key(&self, provider: Provider) -> Result<bool> {
        let key = api_key_id(provider)?;
        self.with_store(move |store| {
            Ok(store.contains(key)?
                || (provider == Provider::Anthropic
                    && store.contains(keys::LEGACY_AGENT_ANTHROPIC)?))
        })
        .await
    }

    /// Blocking platform I/O stays off the shared async runtime.
    async fn with_store<T: Send + 'static>(
        &self,
        work: impl FnOnce(&SecretStore) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.store.clone();
        let io = self.io.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = io
                .lock()
                .map_err(|_| ProviderError::protocol("credential worker failed"))?;
            work(&store)
        })
        .await
        .map_err(|_| ProviderError::protocol("credential worker failed"))?
    }

    pub async fn api_key(&self, provider: Provider) -> Result<Option<String>> {
        let key = api_key_id(provider)?;
        self.with_store(move |store| {
            let read = |key: &str| store.get(key).map_err(ProviderError::from);
            if let Some(value) = read(key)?.filter(|value| valid_secret(value)) {
                return Ok(Some(value));
            }
            if provider == Provider::Anthropic
                && let Some(value) =
                    read(keys::LEGACY_AGENT_ANTHROPIC)?.filter(|value| valid_secret(value))
            {
                // Do not erase the only copy if saving the canonical key fails.
                store.set(key, &value)?;
                store.delete(keys::LEGACY_AGENT_ANTHROPIC)?;
                return Ok(Some(value));
            }
            Ok(None)
        })
        .await
    }

    pub async fn set_api_key(&self, provider: Provider, value: impl Into<String>) -> Result<()> {
        let key = api_key_id(provider)?;
        let value = value.into();
        if !valid_secret(&value) {
            return Err(ProviderError::protocol("invalid API key"));
        }
        self.with_store(move |store| store.set(key, &value).map_err(ProviderError::from))
            .await
    }

    pub async fn remove_api_key(&self, provider: Provider) -> Result<()> {
        let key = api_key_id(provider)?;
        self.with_store(move |store| {
            store.delete(key)?;
            if provider == Provider::Anthropic {
                store.delete(keys::LEGACY_AGENT_ANTHROPIC)?;
            }
            Ok(())
        })
        .await
    }

    /// A damaged legacy record reads as signed out; it never reaches HTTP headers.
    pub async fn tokens(&self) -> Result<Option<StoredTokens>> {
        self.with_store(|store| {
            Ok(store
                .get(keys::CHATGPT_SUBSCRIPTION)
                .map_err(ProviderError::from)?
                .and_then(|raw| serde_json::from_str::<StoredTokens>(&raw).ok())
                .filter(StoredTokens::valid))
        })
        .await
    }

    pub async fn save_tokens(&self, tokens: &StoredTokens) -> Result<()> {
        self.save_tokens_guarded(tokens, None).await
    }

    /// The fence is checked while owning the blocking I/O lease, so a dropped
    /// async refresh cannot write stale credentials after logout clears them.
    pub(crate) async fn save_tokens_if_current(
        &self,
        tokens: &StoredTokens,
        generation: Arc<AtomicU64>,
        expected: u64,
    ) -> Result<()> {
        self.save_tokens_guarded(tokens, Some((generation, expected)))
            .await
    }

    async fn save_tokens_guarded(
        &self,
        tokens: &StoredTokens,
        fence: Option<(Arc<AtomicU64>, u64)>,
    ) -> Result<()> {
        if !tokens.valid() {
            return Err(ProviderError::protocol("invalid OAuth credential"));
        }
        let raw = serde_json::to_string(tokens)
            .map_err(|_| ProviderError::protocol("invalid OAuth credential"))?;
        let checkpoint = self.oauth_save_checkpoint.clone();
        self.with_store(move |store| {
            if fence
                .is_some_and(|(generation, expected)| generation.load(Ordering::SeqCst) != expected)
            {
                return Err(ProviderError::cancelled());
            }
            if let Some(checkpoint) = checkpoint {
                checkpoint();
            }
            store
                .set(keys::CHATGPT_SUBSCRIPTION, &raw)
                .map_err(ProviderError::from)
        })
        .await
    }

    pub async fn clear_tokens(&self) -> Result<()> {
        self.with_store(|store| {
            store
                .delete(keys::CHATGPT_SUBSCRIPTION)
                .map_err(ProviderError::from)
        })
        .await
    }
}

pub fn api_key_id(provider: Provider) -> Result<&'static str> {
    match provider {
        Provider::Deepseek => Ok("byok.deepseek"),
        Provider::Anthropic => Ok("byok.anthropic"),
        Provider::Openai => Ok("byok.openai"),
        Provider::Chatgpt => Err(ProviderError::protocol(
            "ChatGPT uses OAuth, not an API key",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_agent::ModelErrorCategory;

    #[tokio::test]
    async fn presence_does_not_migrate_legacy_and_candidate_never_changes_the_store() {
        let store = Arc::new(SecretStore::in_memory());
        store
            .set(keys::LEGACY_AGENT_ANTHROPIC, "synthetic-old")
            .unwrap();
        let credentials = Credentials::new(store.clone());
        assert!(credentials.has_api_key(Provider::Anthropic).await.unwrap());
        assert!(!store.contains("byok.anthropic").unwrap());
        let candidate = Credentials::candidate(Provider::Anthropic, "synthetic-candidate").unwrap();
        assert_eq!(
            candidate
                .api_key(Provider::Anthropic)
                .await
                .unwrap()
                .as_deref(),
            Some("synthetic-candidate")
        );
        assert_eq!(
            store.get(keys::LEGACY_AGENT_ANTHROPIC).unwrap().as_deref(),
            Some("synthetic-old")
        );
        assert!(!store.contains("byok.anthropic").unwrap());
        assert!(Credentials::candidate(Provider::Chatgpt, "synthetic-key").is_err());
    }

    #[tokio::test]
    async fn abandoned_platform_write_settles_before_clear_and_stale_save_is_fenced() {
        let credentials = Credentials::new(Arc::new(SecretStore::in_memory()));
        let generation = Arc::new(AtomicU64::new(0));
        let tokens = StoredTokens {
            access_token: "synthetic-access".into(),
            refresh_token: "synthetic-refresh".into(),
            expires_at_ms: u64::MAX,
            id_token: None,
        };
        let raw = serde_json::to_string(&tokens).unwrap();
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let mut write = Box::pin(credentials.with_store(move |store| {
            entered.send(()).unwrap();
            blocked.recv().unwrap();
            store.set(keys::CHATGPT_SUBSCRIPTION, &raw)?;
            Ok(())
        }));
        assert!(futures::poll!(&mut write).is_pending());
        waiting.await.unwrap();
        // Aborting the async owner cannot cancel native credential I/O.
        drop(write);
        generation.fetch_add(1, Ordering::SeqCst);
        let clearing = credentials.clone();
        let mut clear = tokio::spawn(async move { clearing.clear_tokens().await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut clear)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        clear.await.unwrap().unwrap();
        let error = credentials
            .save_tokens_if_current(&tokens, generation, 0)
            .await
            .unwrap_err();
        assert_eq!(error.category, ModelErrorCategory::Cancelled);
        assert!(credentials.tokens().await.unwrap().is_none());
    }
}
