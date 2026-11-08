//! Session token storage (`SecretStore`) and offline profile cache.
//!
//! - The bearer token lives in `dr_platform::SecretStore` under
//!   `dr_platform::secrets::keys::hosted_session(origin)`.
//! - A revision counter prevents an in-flight response's `set-auth-token`
//!   header from overwriting an explicit sign-out or account change that
//!   happened while the request was in flight (`auth-client-race.test.ts`).
//! - The offline profile cache (`hosted-profile.json` in the app's data
//!   folder, scoped to `origin`) lets cold starts while offline display the
//!   signed-in user's name and avatar and keep their account library active.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dr_platform::{SecretError, SecretStore};
use serde::{Deserialize, Serialize};

use crate::endpoint::HostedOrigin;
use crate::profile::HostedUser;

pub const HOSTED_PROFILE_FILE: &str = "hosted-profile.json";
const PROFILE_CACHE_FORMAT: &str = "drifting.hosted.profile.v1";

/// The state of the Hosted account session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    #[default]
    SignedOut,
    Checking,
    Connected,
    Offline,
    NeedsReauth,
}

impl SessionStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SignedOut => "signed-out",
            Self::Checking => "checking",
            Self::Connected => "connected",
            Self::Offline => "offline",
            Self::NeedsReauth => "needs-reauth",
        }
    }

    #[must_use]
    pub const fn has_account(self) -> bool {
        matches!(
            self,
            Self::Checking | Self::Connected | Self::Offline | Self::NeedsReauth
        )
    }
}

/// Manages the Hosted session bearer token in `dr_platform::SecretStore`.
pub struct SessionTokenStore {
    secrets: Arc<SecretStore>,
    revision: AtomicU64,
    cached: Mutex<Option<(String, Option<String>)>>,
}

impl SessionTokenStore {
    #[must_use]
    pub fn new(secrets: Arc<SecretStore>) -> Self {
        Self {
            secrets,
            revision: AtomicU64::new(0),
            cached: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn secret_key(origin: &HostedOrigin) -> String {
        dr_platform::secrets::keys::hosted_session(origin.as_str())
    }

    #[must_use]
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    fn normalize(raw: Option<String>) -> Option<String> {
        raw.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
    }

    /// Reads the current session token for `origin` from cache or `SecretStore`.
    pub fn read(&self, origin: &HostedOrigin) -> Result<Option<String>, SecretError> {
        let key = Self::secret_key(origin);
        let mut guard = self.cached.lock().expect("token cache lock");
        if let Some((cached_key, existing)) = guard.as_ref()
            && cached_key == &key
        {
            return Ok(existing.clone());
        }
        let loaded = Self::normalize(self.secrets.get(&key)?);
        *guard = Some((key, loaded.clone()));
        Ok(loaded)
    }

    /// Writes a non-empty session token for `origin`, advancing the revision counter.
    pub fn write(&self, origin: &HostedOrigin, token: &str) -> Result<(), SecretError> {
        let key = Self::secret_key(origin);
        let normalized = Self::normalize(Some(token.to_owned()));
        let mut guard = self.cached.lock().expect("token cache lock");
        self.revision.fetch_add(1, Ordering::SeqCst);
        match &normalized {
            Some(value) => self.secrets.set(&key, value)?,
            None => self.secrets.delete(&key)?,
        }
        *guard = Some((key, normalized));
        Ok(())
    }

    /// Clears the session token for `origin`, advancing the revision counter.
    pub fn clear(&self, origin: &HostedOrigin) -> Result<(), SecretError> {
        let key = Self::secret_key(origin);
        let mut guard = self.cached.lock().expect("token cache lock");
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.secrets.delete(&key)?;
        *guard = Some((key, None));
        Ok(())
    }

    /// Captures a `set-auth-token` response header only if the revision has not
    /// changed since `expected_revision` was observed before the request.
    pub fn capture_if_revision(
        &self,
        origin: &HostedOrigin,
        expected_revision: u64,
        header_token: &str,
    ) -> Result<bool, SecretError> {
        let Some(token) = Self::normalize(Some(header_token.to_owned())) else {
            return Ok(false);
        };
        let key = Self::secret_key(origin);
        let mut guard = self.cached.lock().expect("token cache lock");
        if self.revision.load(Ordering::SeqCst) != expected_revision {
            return Ok(false);
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.secrets.set(&key, &token)?;
        *guard = Some((key, Some(token)));
        Ok(true)
    }
}

#[derive(Serialize, Deserialize)]
struct StoredProfileCache {
    format: String,
    origin: String,
    user: HostedUser,
}

/// Offline profile cache stored in `<data>/hosted-profile.json`, scoped by origin.
#[derive(Clone, Debug)]
pub struct ProfileCache {
    file: PathBuf,
    memory: Arc<Mutex<Option<(String, HostedUser)>>>,
}

impl ProfileCache {
    #[must_use]
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join(HOSTED_PROFILE_FILE),
            memory: Arc::new(Mutex::new(None)),
        }
    }

    #[must_use]
    pub fn read(&self, origin: &HostedOrigin) -> Option<HostedUser> {
        if let Some((cached_origin, user)) = self.memory.lock().expect("profile cache lock").clone()
            && cached_origin == origin.as_str()
        {
            return Some(user);
        }
        let bytes = fs::read(&self.file).ok()?;
        let parsed: StoredProfileCache = serde_json::from_slice(&bytes).ok()?;
        if parsed.format != PROFILE_CACHE_FORMAT || parsed.origin != origin.as_str() {
            return None;
        }
        let user = parsed.user.sanitized();
        if user.id.is_empty() || user.email.is_empty() {
            return None;
        }
        *self.memory.lock().expect("profile cache lock") =
            Some((origin.as_str().to_owned(), user.clone()));
        Some(user)
    }

    pub fn write(&self, origin: &HostedOrigin, user: &HostedUser) -> Result<(), String> {
        let sanitized = user.clone().sanitized();
        if sanitized.id.is_empty() || sanitized.email.is_empty() {
            return Err("invalid user id or email".into());
        }
        *self.memory.lock().expect("profile cache lock") =
            Some((origin.as_str().to_owned(), sanitized.clone()));
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let payload = StoredProfileCache {
            format: PROFILE_CACHE_FORMAT.to_owned(),
            origin: origin.as_str().to_owned(),
            user: sanitized,
        };
        let json = serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?;
        fs::write(&self.file, json).map_err(|e| e.to_string())
    }

    pub fn clear(&self) {
        *self.memory.lock().expect("profile cache lock") = None;
        let _ = fs::remove_file(&self.file);
    }
}
