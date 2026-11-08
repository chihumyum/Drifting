//! Native PKCE OAuth state, deep-link callback parser, and single-use verifier.
//!
//! Matches `src/renderer/platform/native-oauth-state.ts` and `src/renderer/platform/tauri.ts`:
//! - Generates a 32-byte hex `nativeState` and 32-byte hex `codeVerifier`, plus
//!   `codeChallenge = base64url_no_pad(SHA256(codeVerifier))`.
//! - Persists the pending OAuth state to `<data>/native-oauth-state.json` with a
//!   10-minute TTL (`600_000` ms) so callbacks delivered on cold start or after
//!   closing the sign-in dialog still complete.
//! - Verifies `nativeState` in constant time and deletes the state immediately
//!   so a state cannot be replayed.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::endpoint::HostedOrigin;
use crate::profile::AccountErrorCode;

pub const NATIVE_OAUTH_STATE_FILE: &str = "native-oauth-state.json";
pub const OAUTH_STATE_TTL_MS: u64 = 10 * 60 * 1000;
pub const DEFAULT_REDIRECT_URI: &str = "drifting://auth/callback";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingNativeOAuth {
    pub provider: String,
    pub native_state: String,
    pub code_verifier: String,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub created_at: u64,
}

impl PendingNativeOAuth {
    #[must_use]
    pub fn generate(provider: &str) -> Self {
        let native_state = random_hex_32();
        let code_verifier = random_hex_32();
        let code_challenge = pkce_s256_challenge(&code_verifier);
        Self {
            provider: provider.trim().to_owned(),
            native_state,
            code_verifier,
            code_challenge,
            redirect_uri: DEFAULT_REDIRECT_URI.to_owned(),
            created_at: now_ms(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedOAuthCallback {
    pub code: String,
    pub native_state: String,
}

#[must_use]
pub fn pkce_s256_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join(NATIVE_OAUTH_STATE_FILE)
}

pub fn save_pending_oauth(data_dir: &Path, pending: &PendingNativeOAuth) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let path = state_path(data_dir);
    let bytes = serde_json::to_vec_pretty(pending).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[must_use]
pub fn read_pending_oauth(data_dir: &Path) -> Option<PendingNativeOAuth> {
    let bytes = fs::read(state_path(data_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn clear_pending_oauth(data_dir: &Path) {
    let _ = fs::remove_file(state_path(data_dir));
}

#[must_use]
pub fn build_oauth_redirect_url(origin: &HostedOrigin, pending: &PendingNativeOAuth) -> String {
    let mut url = Url::parse(&origin.endpoint("/api/auth/native-start"))
        .expect("HostedOrigin is a valid URL");
    url.query_pairs_mut()
        .append_pair("provider", &pending.provider)
        .append_pair("nativeState", &pending.native_state)
        .append_pair("codeChallenge", &pending.code_challenge)
        .append_pair("codeChallengeMethod", "S256")
        .append_pair("redirectUri", &pending.redirect_uri);
    url.into()
}

pub fn parse_oauth_callback_url(
    raw_url: &str,
    build_scheme: &str,
) -> Result<ParsedOAuthCallback, AccountErrorCode> {
    let parsed = Url::parse(raw_url.trim()).map_err(|_| AccountErrorCode::InvalidOAuthCallback)?;
    let scheme = parsed.scheme();
    let clean_build_scheme = build_scheme.trim().trim_end_matches("://");
    let allowed_scheme = scheme.eq_ignore_ascii_case("drifting")
        || (!clean_build_scheme.is_empty() && scheme.eq_ignore_ascii_case(clean_build_scheme));
    if !allowed_scheme {
        return Err(AccountErrorCode::InvalidOAuthCallback);
    }
    let host = parsed.host_str().unwrap_or_default();
    let path = parsed.path().trim_matches('/');
    let is_auth_callback = (host.eq_ignore_ascii_case("auth") && path == "callback")
        || (host.is_empty() && path == "auth/callback");
    if !is_auth_callback {
        return Err(AccountErrorCode::InvalidOAuthCallback);
    }

    let mut native_state = None;
    let mut code = None;
    let mut error = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "nativeState" | "state" if !v.trim().is_empty() => {
                native_state = Some(v.trim().to_owned());
            }
            "code" if !v.trim().is_empty() => {
                code = Some(v.trim().to_owned());
            }
            "error" if !v.trim().is_empty() => {
                error = Some(v.trim().to_owned());
            }
            _ => {}
        }
    }
    if error.is_some() {
        return Err(AccountErrorCode::InvalidOAuthCallback);
    }
    let code = code.ok_or(AccountErrorCode::InvalidOAuthCallback)?;
    let native_state = native_state.ok_or(AccountErrorCode::OAuthStateMismatch)?;
    Ok(ParsedOAuthCallback { code, native_state })
}

pub fn consume_pending_oauth(
    data_dir: &Path,
    callback_state: &str,
) -> Result<PendingNativeOAuth, AccountErrorCode> {
    let pending = read_pending_oauth(data_dir).ok_or(AccountErrorCode::OAuthStateMismatch)?;
    if now_ms().saturating_sub(pending.created_at) > OAUTH_STATE_TTL_MS {
        clear_pending_oauth(data_dir);
        return Err(AccountErrorCode::OAuthStateExpired);
    }
    if !constant_time_eq(&pending.native_state, callback_state.trim()) {
        return Err(AccountErrorCode::OAuthStateMismatch);
    }
    clear_pending_oauth(data_dir);
    Ok(pending)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let max_len = a_bytes.len().max(b_bytes.len());
    let mut diff = a_bytes.len() ^ b_bytes.len();
    for i in 0..max_len {
        let x = a_bytes.get(i).copied().unwrap_or(0);
        let y = b_bytes.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}

fn random_hex_32() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS CSPRNG");
    let mut out = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
