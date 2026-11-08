//! Hosted Auth HTTP client (`Better Auth` + `/api/auth/native-*`) and `AccountService`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dr_platform::SecretStore;
use serde::{Deserialize, Serialize};

use crate::endpoint::{HostedConfig, HostedOrigin};
use crate::library_registry::LibraryRegistry;
use crate::oauth::{
    PendingNativeOAuth, build_oauth_redirect_url, clear_pending_oauth, consume_pending_oauth,
    parse_oauth_callback_url, save_pending_oauth,
};
use crate::profile::{
    AccountErrorCode, HostedUser, is_allowed_avatar_data_url, normalize_avatar,
    validate_password_change, validate_profile_name,
};
use crate::session::{ProfileCache, SessionStatus, SessionTokenStore};

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Providers advertised by `GET /api/auth/providers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AuthProviders {
    #[serde(default)]
    pub google: bool,
}

/// Purpose passed to `POST /api/auth/email-otp/send-verification-otp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtpPurpose {
    SignIn,
    EmailVerification,
    ForgetPassword,
}

impl OtpPurpose {
    #[must_use]
    pub const fn as_api_str(self) -> &'static str {
        match self {
            Self::SignIn => "sign-in",
            Self::EmailVerification => "email-verification",
            Self::ForgetPassword => "forget-password",
        }
    }
}

/// Structured error returned by [`HostedClient`] and [`AccountService`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountError {
    pub code: AccountErrorCode,
    pub status: Option<u16>,
    pub message: String,
}

impl AccountError {
    #[must_use]
    pub fn new(code: AccountErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            status: None,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn with_status(code: AccountErrorCode, status: u16, message: impl Into<String>) -> Self {
        Self {
            code,
            status: Some(status),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AccountError {}

/// Outcome of `sign_up_email`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignUpOutcome {
    SignedIn(AccountState),
    VerificationRequired { email: String },
}

/// Snapshot of the current account & active-library state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountState {
    pub hosted_configured: bool,
    pub origin: Option<HostedOrigin>,
    pub status: SessionStatus,
    pub user: Option<HostedUser>,
    pub providers: AuthProviders,
    pub active_library_dir: PathBuf,
    pub is_account_library: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuthUser {
    id: String,
    email: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    email_verified: bool,
}

impl RawAuthUser {
    fn into_hosted_user(self) -> HostedUser {
        let name = self
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                self.email
                    .split('@')
                    .next()
                    .unwrap_or("Author")
                    .trim()
                    .to_string()
            });
        HostedUser {
            id: self.id,
            email: self.email,
            name,
            image: normalize_avatar(self.image.as_deref()),
            email_verified: self.email_verified,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawGetSessionResponse {
    #[serde(default)]
    user: Option<RawAuthUser>,
}

#[derive(Debug, Deserialize)]
struct RawAuthTokenResponse {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    user: Option<RawAuthUser>,
}

#[derive(Debug, Deserialize)]
struct RawErrorPayload {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Blocking HTTP client for Hosted authentication endpoints.
#[derive(Clone)]
pub struct HostedClient {
    #[cfg(feature = "network")]
    http: reqwest::blocking::Client,
}

impl std::fmt::Debug for HostedClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostedClient").finish_non_exhaustive()
    }
}

impl Default for HostedClient {
    fn default() -> Self {
        Self::new()
    }
}

impl HostedClient {
    #[must_use]
    pub fn new() -> Self {
        #[cfg(feature = "network")]
        {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let http = reqwest::blocking::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("build reqwest blocking client");
            Self { http }
        }
        #[cfg(not(feature = "network"))]
        {
            Self {}
        }
    }

    pub fn providers(&self, origin: &HostedOrigin) -> Result<AuthProviders, AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = origin;
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .get(origin.endpoint("/api/auth/providers"))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Ok(AuthProviders::default());
            }
            resp.json::<AuthProviders>()
                .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))
        }
    }

    /// Fetch the active session for `token`.
    ///
    /// Returns `Ok(Some((user, replacement_token)))` when authenticated, `Ok(None)` when the
    /// server returns an empty session (`null`) or `401`/`403`.
    pub fn get_session(
        &self,
        origin: &HostedOrigin,
        token: &str,
    ) -> Result<Option<(HostedUser, Option<String>)>, AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, token);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .get(origin.endpoint("/api/auth/get-session"))
                .bearer_auth(token)
                .send()
                .map_err(map_network_err)?;
            let status = resp.status().as_u16();
            if status == 401 || status == 403 {
                return Ok(None);
            }
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            let header_token = extract_auth_header(&resp);
            let text = resp.text().map_err(map_network_err)?;
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed == "null" {
                return Ok(None);
            }
            let parsed: Option<RawGetSessionResponse> = serde_json::from_str(trimmed)
                .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
            let Some(user) = parsed.and_then(|p| p.user) else {
                return Ok(None);
            };
            Ok(Some((user.into_hosted_user(), header_token)))
        }
    }

    pub fn sign_in_email(
        &self,
        origin: &HostedOrigin,
        email: &str,
        password: &str,
    ) -> Result<(HostedUser, String), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, email, password);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/sign-in/email"))
                .json(&serde_json::json!({
                    "email": email.trim(),
                    "password": password,
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            parse_token_and_user(resp)
        }
    }

    pub fn sign_up_email(
        &self,
        origin: &HostedOrigin,
        name: &str,
        email: &str,
        password: &str,
    ) -> Result<(Option<HostedUser>, Option<String>), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, name, email, password);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let validated_name = validate_profile_name(name).map_err(|code| {
                AccountError::new(code, "Profile name must be 1..=80 UTF-16 code units")
            })?;
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/sign-up/email"))
                .json(&serde_json::json!({
                    "name": validated_name,
                    "email": email.trim(),
                    "password": password,
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            let header_token = extract_auth_header(&resp);
            let payload: RawAuthTokenResponse = resp
                .json()
                .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
            let token = header_token
                .or(payload.token)
                .filter(|t| !t.trim().is_empty());
            let user = payload.user.map(RawAuthUser::into_hosted_user);
            Ok((user, token))
        }
    }

    pub fn send_verification_otp(
        &self,
        origin: &HostedOrigin,
        email: &str,
        purpose: OtpPurpose,
    ) -> Result<(), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, email, purpose);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/email-otp/send-verification-otp"))
                .json(&serde_json::json!({
                    "email": email.trim(),
                    "type": purpose.as_api_str(),
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            Ok(())
        }
    }

    pub fn verify_email_otp(
        &self,
        origin: &HostedOrigin,
        email: &str,
        otp: &str,
    ) -> Result<(Option<HostedUser>, Option<String>), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, email, otp);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/email-otp/verify-email"))
                .json(&serde_json::json!({
                    "email": email.trim(),
                    "otp": otp.trim(),
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            let header_token = extract_auth_header(&resp);
            let payload: RawAuthTokenResponse = resp
                .json()
                .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
            let token = header_token
                .or(payload.token)
                .filter(|t| !t.trim().is_empty());
            let user = payload.user.map(RawAuthUser::into_hosted_user);
            Ok((user, token))
        }
    }

    pub fn sign_in_email_otp(
        &self,
        origin: &HostedOrigin,
        email: &str,
        otp: &str,
    ) -> Result<(HostedUser, String), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, email, otp);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/sign-in/email-otp"))
                .json(&serde_json::json!({
                    "email": email.trim(),
                    "otp": otp.trim(),
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            parse_token_and_user(resp)
        }
    }

    pub fn request_password_reset(
        &self,
        origin: &HostedOrigin,
        email: &str,
    ) -> Result<(), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, email);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/email-otp/request-password-reset"))
                .json(&serde_json::json!({
                    "email": email.trim(),
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            Ok(())
        }
    }

    pub fn reset_password(
        &self,
        origin: &HostedOrigin,
        email: &str,
        otp: &str,
        new_password: &str,
    ) -> Result<(), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, email, otp, new_password);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/email-otp/reset-password"))
                .json(&serde_json::json!({
                    "email": email.trim(),
                    "otp": otp.trim(),
                    "password": new_password,
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            Ok(())
        }
    }

    pub fn exchange_native_oauth(
        &self,
        origin: &HostedOrigin,
        code: &str,
        code_verifier: &str,
    ) -> Result<(HostedUser, String), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, code, code_verifier);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/native-exchange"))
                .json(&serde_json::json!({
                    "code": code.trim(),
                    "codeVerifier": code_verifier.trim(),
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            parse_token_and_user(resp)
        }
    }

    pub fn update_user(
        &self,
        origin: &HostedOrigin,
        token: &str,
        name: Option<&str>,
        image: Option<Option<&str>>,
    ) -> Result<Option<HostedUser>, AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, token, name, image);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            let mut body = serde_json::Map::new();
            if let Some(n) = name {
                let validated = validate_profile_name(n).map_err(|code| {
                    AccountError::new(code, "Profile name must be 1..=80 UTF-16 code units")
                })?;
                body.insert("name".into(), serde_json::Value::String(validated));
            }
            if let Some(img_opt) = image {
                match img_opt {
                    Some(data_url) => {
                        if !is_allowed_avatar_data_url(data_url) {
                            return Err(AccountError::new(
                                AccountErrorCode::InvalidAvatar,
                                "Avatar must be a JPEG data URL <= 128 KiB",
                            ));
                        }
                        body.insert(
                            "image".into(),
                            serde_json::Value::String(data_url.to_string()),
                        );
                    }
                    None => {
                        body.insert("image".into(), serde_json::Value::Null);
                    }
                }
            }
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/update-user"))
                .bearer_auth(token)
                .json(&body)
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            let text = resp.text().map_err(map_network_err)?;
            if let Ok(parsed) = serde_json::from_str::<RawAuthTokenResponse>(&text) {
                if let Some(u) = parsed.user {
                    return Ok(Some(u.into_hosted_user()));
                }
            }
            if let Ok(u) = serde_json::from_str::<RawAuthUser>(&text) {
                return Ok(Some(u.into_hosted_user()));
            }
            Ok(None)
        }
    }

    pub fn change_password(
        &self,
        origin: &HostedOrigin,
        token: &str,
        current_password: &str,
        new_password: &str,
    ) -> Result<Option<String>, AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, token, current_password, new_password);
            return Err(AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "network feature disabled",
            ));
        }
        #[cfg(feature = "network")]
        {
            validate_password_change(current_password, new_password)
                .map_err(|code| AccountError::new(code, "Password change validation failed"))?;
            let resp = self
                .http
                .post(origin.endpoint("/api/auth/change-password"))
                .bearer_auth(token)
                .json(&serde_json::json!({
                    "currentPassword": current_password,
                    "newPassword": new_password,
                    "revokeOtherSessions": true,
                }))
                .send()
                .map_err(map_network_err)?;
            if !resp.status().is_success() {
                return Err(parse_error_response(resp));
            }
            let header_token = extract_auth_header(&resp);
            let body_token = resp
                .json::<RawAuthTokenResponse>()
                .ok()
                .and_then(|p| p.token)
                .filter(|t| !t.trim().is_empty());
            Ok(header_token.or(body_token))
        }
    }

    pub fn sign_out(&self, origin: &HostedOrigin, token: &str) -> Result<(), AccountError> {
        #[cfg(not(feature = "network"))]
        {
            let _ = (origin, token);
            return Ok(());
        }
        #[cfg(feature = "network")]
        {
            let _ = self
                .http
                .post(origin.endpoint("/api/auth/sign-out"))
                .bearer_auth(token)
                .json(&serde_json::json!({}))
                .send();
            Ok(())
        }
    }
}

#[cfg(feature = "network")]
fn map_network_err(err: reqwest::Error) -> AccountError {
    AccountError::new(AccountErrorCode::Network, err.to_string())
}

#[cfg(feature = "network")]
fn extract_auth_header(resp: &reqwest::blocking::Response) -> Option<String> {
    resp.headers()
        .get("set-auth-token")
        .or_else(|| resp.headers().get("x-auth-token"))
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(feature = "network")]
fn parse_token_and_user(
    resp: reqwest::blocking::Response,
) -> Result<(HostedUser, String), AccountError> {
    let header_token = extract_auth_header(&resp);
    let payload: RawAuthTokenResponse = resp
        .json()
        .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
    let token = header_token
        .or(payload.token)
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AccountError::new(AccountErrorCode::Unknown, "Missing session token"))?;
    let user = payload
        .user
        .ok_or_else(|| AccountError::new(AccountErrorCode::Unknown, "Missing user payload"))?
        .into_hosted_user();
    Ok((user, token))
}

#[cfg(feature = "network")]
fn parse_error_response(resp: reqwest::blocking::Response) -> AccountError {
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    let parsed: Option<RawErrorPayload> = serde_json::from_str(&text).ok();
    let raw_code = parsed
        .as_ref()
        .and_then(|p| p.code.as_deref())
        .unwrap_or("");
    let message = parsed
        .as_ref()
        .and_then(|p| p.message.as_deref().or(p.error.as_deref()))
        .unwrap_or_else(|| {
            if text.is_empty() {
                "Request failed"
            } else {
                &text
            }
        })
        .to_string();
    let code = AccountErrorCode::from_api(Some(status), raw_code, &message);
    AccountError::with_status(code, status, message)
}

/// High-level coordinator for Hosted sign-in, token persistence, profile cache,
/// OAuth PKCE state, and per-account library switching.
pub struct AccountService {
    config: HostedConfig,
    data_dir: PathBuf,
    build_scheme: String,
    token_store: Arc<SessionTokenStore>,
    profile_cache: ProfileCache,
    client: HostedClient,
    state: Mutex<AccountState>,
}

impl AccountService {
    pub fn new(
        config: HostedConfig,
        data_dir: impl Into<PathBuf>,
        build_scheme: impl Into<String>,
        secrets: Arc<SecretStore>,
    ) -> Result<Self, AccountError> {
        let data_dir = data_dir.into();
        let build_scheme = build_scheme.into();
        let token_store = Arc::new(SessionTokenStore::new(secrets));
        let profile_cache = ProfileCache::new(&data_dir);
        let client = HostedClient::new();

        let (has_token, cached_user) = match config.origin() {
            Some(origin) => {
                let tok = token_store
                    .read(origin)
                    .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
                let cached = profile_cache.read(origin);
                (tok.is_some(), cached)
            }
            None => (false, None),
        };

        let (reg, active_library_dir) = LibraryRegistry::settle_for_startup(
            &data_dir,
            has_token,
            cached_user.as_ref().map(|u| u.id.as_str()),
        )
        .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;

        let initial_status = if !config.is_configured() || !has_token {
            SessionStatus::SignedOut
        } else {
            SessionStatus::Checking
        };

        let initial_state = AccountState {
            hosted_configured: config.is_configured(),
            origin: config.origin().cloned(),
            status: initial_status,
            user: if has_token { cached_user } else { None },
            providers: AuthProviders::default(),
            is_account_library: !reg.is_active_local(),
            active_library_dir,
        };

        Ok(Self {
            config,
            data_dir,
            build_scheme,
            token_store,
            profile_cache,
            client,
            state: Mutex::new(initial_state),
        })
    }

    #[must_use]
    pub fn config(&self) -> &HostedConfig {
        &self.config
    }

    #[must_use]
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    #[must_use]
    pub fn client(&self) -> &HostedClient {
        &self.client
    }

    #[must_use]
    pub fn token_store(&self) -> &Arc<SessionTokenStore> {
        &self.token_store
    }

    /// Current bearer token if Hosted is configured and a token is stored.
    pub fn current_token(&self) -> Option<String> {
        let origin = self.config.origin()?;
        self.token_store.read(origin).ok().flatten()
    }

    /// Snapshot of the current [`AccountState`].
    #[must_use]
    pub fn state(&self) -> AccountState {
        self.state.lock().expect("account state lock").clone()
    }

    /// Bootstrap session state against the Hosted origin (or settle immediately in local-only mode).
    pub fn bootstrap(&self) -> AccountState {
        let Some(origin) = self.config.origin() else {
            return self.state();
        };

        let providers = self.client.providers(origin).unwrap_or_default();
        let rev_before = self.token_store.revision();
        let token = self.token_store.read(origin).ok().flatten();

        let Some(token) = token else {
            let mut reg = LibraryRegistry::load_or_init(&self.data_dir)
                .unwrap_or_else(|_| LibraryRegistry::default_local());
            let dir = reg
                .activate_local(&self.data_dir)
                .unwrap_or_else(|_| reg.local_library_dir(&self.data_dir));
            let mut guard = self.state.lock().expect("account state lock");
            guard.providers = providers;
            guard.status = SessionStatus::SignedOut;
            guard.user = None;
            guard.active_library_dir = dir;
            guard.is_account_library = false;
            return guard.clone();
        };

        let cached_user = self.profile_cache.read(origin);
        match self.client.get_session(origin, &token) {
            Ok(Some((user, replacement_token))) => {
                if self.token_store.revision() != rev_before {
                    return self.state();
                }
                if let Some(new_tok) = replacement_token {
                    let _ = self
                        .token_store
                        .capture_if_revision(origin, rev_before, &new_tok);
                }
                let _ = self.profile_cache.write(origin, &user);
                if let Ok(state) = self.apply_connected_user(user, Some(providers)) {
                    return state;
                }
                self.state()
            }
            Ok(None) => {
                if self.token_store.revision() != rev_before {
                    return self.state();
                }
                // Session expired or revoked: keep the active account library open and mark NeedsReauth.
                let mut guard = self.state.lock().expect("account state lock");
                guard.providers = providers;
                guard.status = SessionStatus::NeedsReauth;
                if guard.user.is_none() {
                    guard.user = cached_user;
                }
                guard.clone()
            }
            Err(err) if err.code == AccountErrorCode::Unauthorized => {
                if self.token_store.revision() != rev_before {
                    return self.state();
                }
                let mut guard = self.state.lock().expect("account state lock");
                guard.providers = providers;
                guard.status = SessionStatus::NeedsReauth;
                if guard.user.is_none() {
                    guard.user = cached_user;
                }
                guard.clone()
            }
            Err(_) => {
                if self.token_store.revision() != rev_before {
                    return self.state();
                }
                // Offline startup: preserve active account library and cached user profile.
                let mut guard = self.state.lock().expect("account state lock");
                guard.providers = providers;
                guard.status = SessionStatus::Offline;
                if guard.user.is_none() {
                    guard.user = cached_user;
                }
                guard.clone()
            }
        }
    }

    pub fn sign_in_email(&self, email: &str, password: &str) -> Result<AccountState, AccountError> {
        let origin = self.require_origin()?;
        let (user, token) = self.client.sign_in_email(origin, email, password)?;
        self.finish_sign_in(origin, user, &token)
    }

    pub fn sign_up_email(
        &self,
        name: &str,
        email: &str,
        password: &str,
    ) -> Result<SignUpOutcome, AccountError> {
        let origin = self.require_origin()?;
        let (user_opt, token_opt) = self.client.sign_up_email(origin, name, email, password)?;
        if let (Some(user), Some(token)) = (user_opt.clone(), token_opt) {
            if user.email_verified {
                let state = self.finish_sign_in(origin, user, &token)?;
                return Ok(SignUpOutcome::SignedIn(state));
            }
        }
        // Account requires email OTP verification before signing in.
        let _ = self
            .client
            .send_verification_otp(origin, email, OtpPurpose::EmailVerification);
        Ok(SignUpOutcome::VerificationRequired {
            email: email.trim().to_string(),
        })
    }

    pub fn send_verification_otp(
        &self,
        email: &str,
        purpose: OtpPurpose,
    ) -> Result<(), AccountError> {
        let origin = self.require_origin()?;
        self.client.send_verification_otp(origin, email, purpose)
    }

    pub fn verify_email_otp(
        &self,
        email: &str,
        otp: &str,
        password_fallback: Option<&str>,
    ) -> Result<AccountState, AccountError> {
        let origin = self.require_origin()?;
        let (user_opt, token_opt) = self.client.verify_email_otp(origin, email, otp)?;
        if let (Some(user), Some(token)) = (user_opt, token_opt) {
            return self.finish_sign_in(origin, user, &token);
        }
        if let Some(pw) = password_fallback.filter(|p| !p.is_empty()) {
            return self.sign_in_email(email, pw);
        }
        Err(AccountError::new(
            AccountErrorCode::Unauthorized,
            "Email verified; please sign in with your password",
        ))
    }

    pub fn sign_in_email_otp(&self, email: &str, otp: &str) -> Result<AccountState, AccountError> {
        let origin = self.require_origin()?;
        let (user, token) = self.client.sign_in_email_otp(origin, email, otp)?;
        self.finish_sign_in(origin, user, &token)
    }

    pub fn request_password_reset(&self, email: &str) -> Result<(), AccountError> {
        let origin = self.require_origin()?;
        self.client.request_password_reset(origin, email)
    }

    pub fn reset_password(
        &self,
        email: &str,
        otp: &str,
        new_password: &str,
    ) -> Result<(), AccountError> {
        let origin = self.require_origin()?;
        self.client.reset_password(origin, email, otp, new_password)
    }

    /// Generate PKCE state, persist it to `<data>/native-oauth-state.json`, and return the
    /// browser redirect URL (`/api/auth/native-start?...`).
    pub fn start_google_oauth(&self) -> Result<String, AccountError> {
        let origin = self.require_origin()?;
        let pending = PendingNativeOAuth::generate("google");
        save_pending_oauth(&self.data_dir, &pending)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
        Ok(build_oauth_redirect_url(origin, &pending))
    }

    /// Handle a deep-link callback URL (`drifting://auth/callback?...`), verify & consume the
    /// persisted PKCE state (supporting both live and cold-start callbacks), exchange the code
    /// for a bearer token, and switch to the user's isolated account library.
    pub fn complete_oauth_callback_url(
        &self,
        callback_url: &str,
    ) -> Result<AccountState, AccountError> {
        let origin = self.require_origin()?;
        let parsed = parse_oauth_callback_url(callback_url, &self.build_scheme)
            .map_err(|code| AccountError::new(code, "Invalid OAuth callback URL"))?;
        let pending = consume_pending_oauth(&self.data_dir, &parsed.native_state)
            .map_err(|code| AccountError::new(code, "OAuth state verification failed"))?;
        let (user, token) =
            self.client
                .exchange_native_oauth(origin, &parsed.code, &pending.code_verifier)?;
        self.finish_sign_in(origin, user, &token)
    }

    /// Update profile name and/or avatar image.
    pub fn update_profile(
        &self,
        name: Option<&str>,
        image: Option<Option<&str>>,
    ) -> Result<AccountState, AccountError> {
        let origin = self.require_origin()?;
        let token = self.require_token(origin)?;
        let updated_opt = self.client.update_user(origin, &token, name, image)?;

        let mut guard = self.state.lock().expect("account state lock");
        if let Some(updated) = updated_opt {
            let _ = self.profile_cache.write(origin, &updated);
            guard.user = Some(updated);
        } else if let Some(existing) = guard.user.as_mut() {
            if let Some(n) = name {
                if let Ok(valid) = validate_profile_name(n) {
                    existing.name = valid;
                }
            }
            if let Some(img_opt) = image {
                existing.image = img_opt.and_then(|s| normalize_avatar(Some(s)));
            }
            let _ = self.profile_cache.write(origin, existing);
        }
        Ok(guard.clone())
    }

    /// Change the signed-in user's password and rotate the local session token.
    pub fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<AccountState, AccountError> {
        let origin = self.require_origin()?;
        let rev_before = self.token_store.revision();
        let token = self.require_token(origin)?;
        let replacement =
            self.client
                .change_password(origin, &token, current_password, new_password)?;
        if let Some(new_token) = replacement {
            let _ = self
                .token_store
                .capture_if_revision(origin, rev_before, &new_token);
        }
        Ok(self.state())
    }

    /// Sign out: clear the stored session token, clear the profile cache and pending OAuth state,
    /// switch `<data>/libraries.json` back to the local library (leaving the account library
    /// directory untouched on disk), and notify the Hosted server best-effort.
    pub fn sign_out(&self) -> Result<AccountState, AccountError> {
        let Some(origin) = self.config.origin() else {
            return Ok(self.state());
        };
        let old_token = self.token_store.read(origin).ok().flatten();
        self.token_store
            .clear(origin)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
        self.profile_cache.clear();
        clear_pending_oauth(&self.data_dir);

        if let Some(tok) = old_token {
            let _ = self.client.sign_out(origin, &tok);
        }

        let mut reg = LibraryRegistry::load_or_init(&self.data_dir)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
        let local_dir = reg
            .activate_local(&self.data_dir)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;

        let mut guard = self.state.lock().expect("account state lock");
        guard.status = SessionStatus::SignedOut;
        guard.user = None;
        guard.active_library_dir = local_dir;
        guard.is_account_library = false;
        Ok(guard.clone())
    }

    fn require_origin(&self) -> Result<&HostedOrigin, AccountError> {
        self.config.origin().ok_or_else(|| {
            AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "Hosted service is not configured in local-only mode",
            )
        })
    }

    fn require_token(&self, origin: &HostedOrigin) -> Result<String, AccountError> {
        self.token_store
            .read(origin)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?
            .ok_or_else(|| {
                AccountError::new(AccountErrorCode::Unauthorized, "Not signed in to Hosted")
            })
    }

    fn finish_sign_in(
        &self,
        origin: &HostedOrigin,
        user: HostedUser,
        token: &str,
    ) -> Result<AccountState, AccountError> {
        self.token_store
            .write(origin, token)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
        self.profile_cache
            .write(origin, &user)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
        self.apply_connected_user(user, None)
    }

    fn apply_connected_user(
        &self,
        user: HostedUser,
        providers_override: Option<AuthProviders>,
    ) -> Result<AccountState, AccountError> {
        let mut reg = LibraryRegistry::load_or_init(&self.data_dir)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;
        let account_dir = reg
            .activate_account(&self.data_dir, &user.id)
            .map_err(|e| AccountError::new(AccountErrorCode::Unknown, e.to_string()))?;

        let mut guard = self.state.lock().expect("account state lock");
        if let Some(p) = providers_override {
            guard.providers = p;
        }
        guard.status = SessionStatus::Connected;
        guard.user = Some(user);
        guard.active_library_dir = account_dir;
        guard.is_account_library = true;
        Ok(guard.clone())
    }
}
