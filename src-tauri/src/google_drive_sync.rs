//! Native Google Drive `appDataFolder` transport for SyncEngine.
//!
//! OAuth credentials, bearer headers, resumable upload URLs and filesystem
//! paths stay in this module/native secure storage. Renderer callers receive
//! only opaque Sync Generation/object/cursor/page/local-object references and validated
//! immutable metadata.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use base64::Engine as _;
use futures_util::future::{AbortHandle, Abortable};
use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, LOCATION, RANGE, RETRY_AFTER,
};
use reqwest::{Client, RequestBuilder, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use tauri::Manager as _;
use tauri::{ipc::Channel, AppHandle, State};
#[cfg(any(target_os = "ios", target_os = "android"))]
use tauri_plugin_drifting_google_drive_oauth::{
    GoogleDriveOAuthExt as _, MobileOAuthResponse, MobileOperationDiagnostics,
};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::native_capabilities::{
    durable_replace_file, ensure_parent_directory, temporary_sibling,
};
use crate::secure_storage;
use crate::sync_object_store::{
    resolve_download_destination_ref, validate_upload_ref, SyncObjectKind,
};

const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const GOOGLE_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
// One App has one provider authority, therefore it also has one enumerable
// Google credential slot. The fixed opaque suffix closes the crash window in
// which OAuth had written a random Keychain item but JavaScript had not yet
// persisted its reference in SQLite.
const GOOGLE_APP_CREDENTIAL_SECRET_REF: &str =
    "sync.google-drive.credentials.49a8dd8ca988f0107a3bcb19b8c4677d36e322e977686879";
const CREDENTIAL_OWNERSHIP_PROVISIONAL: &str = "provisional";
const CREDENTIAL_OWNERSHIP_CLAIMED: &str = "claimed";
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const OAUTH_SCOPES: &str = "openid https://www.googleapis.com/auth/drive.appdata";
const APP_DATA_FOLDER: &str = "appDataFolder";
const RESUMABLE_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const PROGRESS_REPORT_INTERVAL_BYTES: u64 = 256 * 1024;
const MAX_REMOTE_OBJECT_BYTES: u64 = 513 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_OAUTH_REQUEST_BYTES: usize = 16 * 1024;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(120);
const PROP_PROTOCOL: &str = "driftingProtocol";
const PROP_SYNC_GENERATION: &str = "driftingSyncGenerationId";
const PROP_KIND: &str = "driftingObjectKind";
const PROP_LOGICAL: &str = "driftingLogicalKeyId";
const PROP_HASH: &str = "driftingStoredSha256";
const PROP_SIZE: &str = "driftingSizeBytes";
const PROTOCOL_VALUE: &str = "object-v2";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferProgressEvent {
    transfer_id: String,
    direction: &'static str,
    transferred_bytes: u64,
    total_bytes: u64,
}

fn report_transfer_progress(
    channel: &Channel<TransferProgressEvent>,
    transfer_id: &str,
    direction: &'static str,
    transferred_bytes: u64,
    total_bytes: u64,
) {
    let _ = channel.send(TransferProgressEvent {
        transfer_id: transfer_id.to_owned(),
        direction,
        transferred_bytes,
        total_bytes,
    });
}

#[derive(Clone, Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct GoogleCredentialV1 {
    protocol: String,
    version: u8,
    account_subject: String,
    ownership: String,
    material: GoogleCredentialMaterialV1,
}

#[derive(Clone, Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
enum GoogleCredentialMaterialV1 {
    DesktopRefreshToken(DesktopRefreshCredentialV1),
    MobileSdkAccount(MobileSdkCredentialV1),
}

#[derive(Clone, Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct DesktopRefreshCredentialV1 {
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct MobileSdkCredentialV1 {
    platform: String,
    client_id: String,
}

#[derive(Clone, Debug)]
struct OpenGeneration {
    credential_secret_ref: String,
    account_subject: String,
    sync_generation_id: String,
    authority_generation: u64,
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
struct CachedAccessToken {
    account_subject: String,
    access_token: String,
    expires_at_ms: u64,
}

#[derive(Default)]
struct PendingTransfers {
    active: HashMap<String, AbortHandle>,
    pre_cancelled: HashSet<String>,
}

type HttpFuture = Pin<Box<dyn Future<Output = Result<Response, reqwest::Error>> + Send>>;

trait DriveHttpTransport: Send + Sync {
    fn send(&self, request: RequestBuilder) -> HttpFuture;
}

struct ReqwestDriveHttpTransport;

impl DriveHttpTransport for ReqwestDriveHttpTransport {
    fn send(&self, request: RequestBuilder) -> HttpFuture {
        Box::pin(request.send())
    }
}

pub(crate) struct GoogleDriveState {
    client: OnceLock<Client>,
    http: Arc<dyn DriveHttpTransport>,
    generations: Mutex<HashMap<String, OpenGeneration>>,
    binding_handles: Mutex<HashMap<String, String>>,
    transfers: Mutex<PendingTransfers>,
    access_tokens: Mutex<HashMap<String, CachedAccessToken>>,
    refresh_lock: tokio::sync::Mutex<()>,
}

impl Default for GoogleDriveState {
    fn default() -> Self {
        Self {
            client: OnceLock::new(),
            http: Arc::new(ReqwestDriveHttpTransport),
            generations: Mutex::new(HashMap::new()),
            binding_handles: Mutex::new(HashMap::new()),
            transfers: Mutex::new(PendingTransfers::default()),
            access_tokens: Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }
}

impl GoogleDriveState {
    fn client(&self) -> Result<Client, NativeError> {
        if let Some(client) = self.client.get() {
            return Ok(client.clone());
        }
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| NativeError::configuration("Native Google Drive HTTP is unavailable"))?;
        let _ = self.client.set(client.clone());
        Ok(client)
    }

    fn require_generation(&self, generation_ref: &str) -> Result<OpenGeneration, NativeError> {
        validate_prefixed_ref(generation_ref, "syncdrive:")?;
        self.generations
            .lock()
            .map_err(|_| {
                NativeError::configuration("Google Drive Sync Generation state is unavailable")
            })?
            .get(generation_ref)
            .cloned()
            .ok_or_else(|| {
                NativeError::invalid("Google Drive Sync Generation reference is invalid")
            })
    }

    fn cache_access_token(
        &self,
        secret_ref: &str,
        credential: &GoogleCredentialV1,
    ) -> Result<(), NativeError> {
        let mut cache = self.access_tokens.lock().map_err(|_| {
            NativeError::configuration("Google Drive credential cache is unavailable")
        })?;
        match &credential.material {
            GoogleCredentialMaterialV1::DesktopRefreshToken(material) => {
                #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
                {
                    if material.expires_at_ms > now_ms().saturating_add(60_000) {
                        cache.insert(
                            secret_ref.to_owned(),
                            CachedAccessToken {
                                account_subject: credential.account_subject.clone(),
                                access_token: material.access_token.clone(),
                                expires_at_ms: material.expires_at_ms,
                            },
                        );
                    } else {
                        cache.remove(secret_ref);
                    }
                }
                #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
                {
                    let _ = material;
                    cache.remove(secret_ref);
                }
            }
            GoogleCredentialMaterialV1::MobileSdkAccount(_) => {
                cache.remove(secret_ref);
            }
        }
        Ok(())
    }

    fn cached_access_token(
        &self,
        secret_ref: &str,
        account_subject: &str,
    ) -> Result<Option<Zeroizing<String>>, NativeError> {
        let mut cache = self.access_tokens.lock().map_err(|_| {
            NativeError::configuration("Google Drive credential cache is unavailable")
        })?;
        let Some(cached) = cache.get(secret_ref) else {
            return Ok(None);
        };
        if cached.account_subject != account_subject {
            cache.remove(secret_ref);
            return Err(NativeError::new(
                NativeErrorCode::NeedsReauth,
                "Google Drive account identity changed",
                false,
            ));
        }
        if cached.expires_at_ms <= now_ms().saturating_add(60_000) {
            cache.remove(secret_ref);
            return Ok(None);
        }
        Ok(Some(Zeroizing::new(cached.access_token.clone())))
    }

    fn clear_cached_access_token(&self, secret_ref: &str) -> Result<(), NativeError> {
        self.access_tokens
            .lock()
            .map_err(|_| {
                NativeError::configuration("Google Drive credential cache is unavailable")
            })?
            .remove(secret_ref);
        Ok(())
    }

    fn cached_access_token_for_request(
        &self,
        secret_ref: &str,
        account_subject: &str,
        rejected_access_token: Option<&str>,
    ) -> Result<Option<Zeroizing<String>>, NativeError> {
        let cached = self.cached_access_token(secret_ref, account_subject)?;
        if cached
            .as_deref()
            .is_some_and(|cached| rejected_access_token.is_some_and(|rejected| cached == rejected))
        {
            self.clear_cached_access_token(secret_ref)?;
            return Ok(None);
        }
        Ok(cached)
    }

    fn clear_rejected_access_token(
        &self,
        secret_ref: &str,
        account_subject: &str,
        rejected_access_token: &str,
    ) -> Result<(), NativeError> {
        let mut cache = self.access_tokens.lock().map_err(|_| {
            NativeError::configuration("Google Drive credential cache is unavailable")
        })?;
        let should_remove = cache.get(secret_ref).is_some_and(|cached| {
            cached.account_subject != account_subject
                || cached.access_token == rejected_access_token
        });
        if should_remove {
            cache.remove(secret_ref);
        }
        Ok(())
    }
}

impl Drop for GoogleDriveState {
    fn drop(&mut self) {
        if let Ok(mut transfers) = self.transfers.lock() {
            for (_, handle) in transfers.active.drain() {
                handle.abort();
            }
            transfers.pre_cancelled.clear();
        }
        if let Ok(mut access_tokens) = self.access_tokens.lock() {
            access_tokens.clear();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum NativeErrorCode {
    Cancelled,
    Offline,
    NeedsReauth,
    PermissionDenied,
    RateLimited,
    QuotaExceeded,
    Transient,
    InvalidCursor,
    InvalidPageToken,
    InvalidRequest,
    LocalObjectInvalid,
    RemoteObjectMissing,
    ImmutableConflict,
    RemoteCorrupt,
    ConfigurationRequired,
    #[allow(dead_code)]
    AccountMismatch,
    #[allow(dead_code)]
    UnsupportedPlatform,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiagnosticError {
    family: String,
    domain: String,
    code: i64,
    reason: Option<String>,
    http_status: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOperationDiagnostics {
    schema_version: u8,
    operation: String,
    platform: String,
    phase: String,
    elapsed_ms: u64,
    completed_phases: Vec<String>,
    error_chain: Vec<NativeDiagnosticError>,
}

fn safe_diagnostic_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(target_os = "ios")]
const NATIVE_DIAGNOSTIC_PLATFORM: &str = "ios";
#[cfg(target_os = "android")]
const NATIVE_DIAGNOSTIC_PLATFORM: &str = "android";
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const NATIVE_DIAGNOSTIC_PLATFORM: &str = "desktop";

fn rust_revoke_diagnostics(
    started_at: Instant,
    phase: &str,
    completed_phases: &[&str],
) -> NativeOperationDiagnostics {
    NativeOperationDiagnostics {
        schema_version: 1,
        operation: "revoke".to_owned(),
        platform: NATIVE_DIAGNOSTIC_PLATFORM.to_owned(),
        phase: phase.to_owned(),
        elapsed_ms: started_at.elapsed().as_millis().min(1_800_000) as u64,
        completed_phases: completed_phases
            .iter()
            .filter(|item| safe_diagnostic_token(item))
            .take(24)
            .map(|item| (*item).to_owned())
            .collect(),
        error_chain: Vec::new(),
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn native_revoke_diagnostics(
    started_at: Instant,
    rust_phase: &str,
    rust_completed_phases: &[&str],
    mobile: Option<MobileOperationDiagnostics>,
) -> NativeOperationDiagnostics {
    let mut completed_phases = rust_completed_phases
        .iter()
        .filter(|phase| safe_diagnostic_token(phase))
        .map(|phase| (*phase).to_owned())
        .collect::<Vec<_>>();
    let mut phase = rust_phase.to_owned();
    let mut error_chain = Vec::new();
    if let Some(mobile) = mobile.filter(|value| {
        value.schema_version == 1
            && safe_diagnostic_token(&value.operation)
            && safe_diagnostic_token(&value.platform)
            && safe_diagnostic_token(&value.phase)
            && value.completed_phases.len() <= 24
            && value
                .completed_phases
                .iter()
                .all(|item| safe_diagnostic_token(item))
            && value.error_chain.len() <= 4
    }) {
        phase = mobile.phase;
        completed_phases.extend(mobile.completed_phases);
        error_chain = mobile
            .error_chain
            .into_iter()
            .filter(|item| {
                safe_diagnostic_token(&item.family)
                    && safe_diagnostic_token(&item.domain)
                    && item.reason.as_deref().map_or(true, safe_diagnostic_token)
                    && item
                        .http_status
                        .map_or(true, |status| (100..=599).contains(&status))
            })
            .map(|item| NativeDiagnosticError {
                family: item.family,
                domain: item.domain,
                code: item.code,
                reason: item.reason,
                http_status: item.http_status,
            })
            .collect();
    }
    completed_phases.truncate(24);
    NativeOperationDiagnostics {
        schema_version: 1,
        operation: "revoke".to_owned(),
        platform: NATIVE_DIAGNOSTIC_PLATFORM.to_owned(),
        phase,
        elapsed_ms: started_at.elapsed().as_millis().min(1_800_000) as u64,
        completed_phases,
        error_chain,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeError {
    code: NativeErrorCode,
    message: String,
    retryable: bool,
    retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics: Option<NativeOperationDiagnostics>,
}

impl NativeError {
    fn new(code: NativeErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            retry_after_ms: None,
            diagnostics: None,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(NativeErrorCode::InvalidRequest, message, false)
    }

    fn configuration(message: impl Into<String>) -> Self {
        Self::new(NativeErrorCode::ConfigurationRequired, message, false)
    }

    fn corrupt(message: impl Into<String>) -> Self {
        Self::new(NativeErrorCode::RemoteCorrupt, message, false)
    }

    fn transient(message: impl Into<String>) -> Self {
        Self::new(NativeErrorCode::Transient, message, true)
    }

    fn retry_after(mut self, retry_after_ms: Option<u64>) -> Self {
        self.retry_after_ms = retry_after_ms;
        self
    }

    fn diagnostics(mut self, diagnostics: NativeOperationDiagnostics) -> Self {
        self.diagnostics = Some(diagnostics);
        self
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum NativeResult<T> {
    Ok { ok: bool, value: T },
    Err { ok: bool, error: NativeError },
}

impl<T> NativeResult<T> {
    fn from_result(result: Result<T, NativeError>) -> Self {
        match result {
            Ok(value) => Self::Ok { ok: true, value },
            Err(error) => Self::Err { ok: false, error },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteObject {
    object_id: String,
    object_kind: SyncObjectKind,
    logical_key_id: String,
    stored_sha256: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum RemoteChange {
    Present {
        object: RemoteObject,
    },
    Removed {
        #[serde(rename = "objectId")]
        object_id: String,
        #[serde(rename = "logicalKeyId")]
        logical_key_id: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthConnectResult {
    credential_secret_ref: String,
    account_subject: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RevokeAccountStatus {
    Revoked,
    AlreadyRevoked,
    AlreadyMissing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevokeAccountResult {
    status: RevokeAccountStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics: Option<NativeOperationDiagnostics>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenGenerationResult {
    generation_ref: String,
    sync_generation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InventoryPageResult {
    objects: Vec<RemoteObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_page_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSnapshotCandidate {
    sync_generation_id: String,
    object: RemoteObject,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSnapshotDiscoveryPage {
    snapshots: Vec<ProjectSnapshotCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_page_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangePageResult {
    changes: Vec<RemoteChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_page_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadResult {
    status: &'static str,
    object: RemoteObject,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadResult {
    destination_ref: String,
    stored_sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: Option<String>,
    size: Option<String>,
    trashed: Option<bool>,
    app_properties: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeList {
    #[serde(default)]
    changes: Vec<DriveChange>,
    next_page_token: Option<String>,
    new_start_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveChange {
    file_id: Option<String>,
    removed: Option<bool>,
    file: Option<DriveFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPageToken {
    start_page_token: String,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug, Deserialize)]
struct UserInfoResponse {
    sub: String,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug, Deserialize)]
struct OAuthErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct ResumableSession {
    protocol: String,
    version: u8,
    session_uri: String,
    sync_generation_id: String,
    object_kind: String,
    logical_key_id: String,
    stored_sha256: String,
    size_bytes: u64,
}

struct TempDownload {
    path: PathBuf,
    armed: bool,
}

impl TempDownload {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempDownload {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn random_hex(bytes: usize) -> Result<String, NativeError> {
    let mut random = vec![0_u8; bytes];
    getrandom::getrandom(&mut random)
        .map_err(|_| NativeError::configuration("OS CSPRNG is unavailable"))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn validate_plain_token(value: &str, label: &str, max: usize) -> Result<(), NativeError> {
    if value.is_empty()
        || value.len() > max
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-' | b':')
        })
    {
        return Err(NativeError::invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_prefixed_ref(value: &str, prefix: &str) -> Result<(), NativeError> {
    let token = value
        .strip_prefix(prefix)
        .ok_or_else(|| NativeError::invalid("Opaque native reference is invalid"))?;
    validate_plain_token(token, "Opaque native reference", 512)
}

fn validate_credential_secret_ref(value: &str) -> Result<(), NativeError> {
    if value != GOOGLE_APP_CREDENTIAL_SECRET_REF {
        return Err(NativeError::invalid(
            "Google Drive credential reference is invalid",
        ));
    }
    Ok(())
}

fn validate_provider_token(value: &str, label: &str) -> Result<(), NativeError> {
    if value.is_empty()
        || value.len() > 8192
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(NativeError::invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), NativeError> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(NativeError::invalid("Stored SHA-256 is invalid"));
    }
    Ok(())
}

fn validate_logical_key_id(value: &str) -> Result<(), NativeError> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(NativeError::invalid("Logical key ID is invalid"));
    }
    Ok(())
}

fn object_kind(value: &str) -> Result<SyncObjectKind, NativeError> {
    match value {
        "segment" => Ok(SyncObjectKind::Segment),
        "genesis" => Ok(SyncObjectKind::Genesis),
        "checkpoint" => Ok(SyncObjectKind::Checkpoint),
        "snapshot-commit" => Ok(SyncObjectKind::SnapshotCommit),
        "blob" => Ok(SyncObjectKind::Blob),
        _ => Err(NativeError::corrupt("Drive object kind is unsupported")),
    }
}

fn parse_drive_file(
    file: DriveFile,
    sync_generation_id: &str,
) -> Result<Option<RemoteObject>, NativeError> {
    let Some(properties) = file.app_properties else {
        return Ok(None);
    };
    let Some(protocol) = properties.get(PROP_PROTOCOL) else {
        return Ok(None);
    };
    let remote_generation = properties.get(PROP_SYNC_GENERATION).ok_or_else(|| {
        NativeError::corrupt("Drive sync object omitted its Sync Generation identity")
    })?;
    if remote_generation != sync_generation_id {
        return Ok(None);
    }
    if protocol != PROTOCOL_VALUE {
        return Err(NativeError::corrupt(
            "Drive sync object protocol version is unsupported",
        ));
    }
    if file.trashed.unwrap_or(false) {
        return Ok(None);
    }
    let object_id = file
        .id
        .filter(|value| !value.is_empty() && value.len() <= 255)
        .ok_or_else(|| NativeError::corrupt("Drive sync object ID is malformed"))?;
    let logical_key_id = properties
        .get(PROP_LOGICAL)
        .cloned()
        .ok_or_else(|| NativeError::corrupt("Drive sync object omitted its logical key ID"))?;
    validate_logical_key_id(&logical_key_id)
        .map_err(|_| NativeError::corrupt("Drive sync object logical key ID is malformed"))?;
    let stored_sha256 = properties
        .get(PROP_HASH)
        .cloned()
        .ok_or_else(|| NativeError::corrupt("Drive sync object omitted its stored hash"))?;
    validate_hash(&stored_sha256)
        .map_err(|_| NativeError::corrupt("Drive sync object stored hash is malformed"))?;
    let size_bytes = file
        .size
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| NativeError::corrupt("Drive sync object size is malformed"))?;
    let declared_size = properties
        .get(PROP_SIZE)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| NativeError::corrupt("Drive sync object declared size is malformed"))?;
    if size_bytes == 0 || size_bytes != declared_size || size_bytes > MAX_REMOTE_OBJECT_BYTES {
        return Err(NativeError::corrupt(
            "Drive sync object size does not match its immutable metadata",
        ));
    }
    let object_kind = properties
        .get(PROP_KIND)
        .ok_or_else(|| NativeError::corrupt("Drive sync object omitted its kind"))
        .and_then(|value| object_kind(value))?;
    Ok(Some(RemoteObject {
        object_id,
        object_kind,
        logical_key_id,
        stored_sha256,
        size_bytes,
    }))
}

fn parse_drive_change(
    change: DriveChange,
    sync_generation_id: &str,
) -> Result<RemoteChange, NativeError> {
    let object_id = change
        .file_id
        .ok_or_else(|| NativeError::corrupt("Drive change omitted its file ID"))?;
    validate_plain_token(&object_id, "Drive file ID", 255)
        .map_err(|_| NativeError::corrupt("Drive change file ID is malformed"))?;

    if change.removed.unwrap_or(false) {
        return Ok(RemoteChange::Removed {
            object_id,
            logical_key_id: None,
        });
    }

    // Drive can report a metadata edit or trash operation with removed=false.
    // Any record that no longer parses as this Sync Generation's immutable object must
    // still reach the reducer as degradation of the known file ID. Unknown IDs
    // are ignored by the renderer, while a known immutable ID becomes corrupt.
    let parsed = change
        .file
        .and_then(|file| parse_drive_file(file, sync_generation_id).ok().flatten());
    match parsed {
        Some(object) if object.object_id == object_id => Ok(RemoteChange::Present { object }),
        _ => Ok(RemoteChange::Removed {
            object_id,
            logical_key_id: None,
        }),
    }
}

fn parse_drive_changes(
    changes: Vec<DriveChange>,
    sync_generation_id: &str,
) -> Result<Vec<RemoteChange>, NativeError> {
    changes
        .into_iter()
        .map(|change| parse_drive_change(change, sync_generation_id))
        .collect()
}

fn parse_drive_project_snapshot(
    file: DriveFile,
) -> Result<Option<ProjectSnapshotCandidate>, NativeError> {
    let Some(properties) = file.app_properties.as_ref() else {
        return Ok(None);
    };
    if properties.get(PROP_KIND).map(String::as_str) != Some("snapshot-commit") {
        return Ok(None);
    }
    let sync_generation_id = properties
        .get(PROP_SYNC_GENERATION)
        .cloned()
        .ok_or_else(|| {
            NativeError::corrupt("Drive snapshot omitted its Sync Generation identity")
        })?;
    validate_plain_token(&sync_generation_id, "Sync Generation ID", 255).map_err(|_| {
        NativeError::corrupt("Drive snapshot Sync Generation identity is malformed")
    })?;
    let object = parse_drive_file(file, &sync_generation_id)?
        .ok_or_else(|| NativeError::corrupt("Drive snapshot metadata is incomplete"))?;
    if object.object_kind != SyncObjectKind::SnapshotCommit {
        return Err(NativeError::corrupt(
            "Drive snapshot kind changed during parsing",
        ));
    }
    Ok(Some(ProjectSnapshotCandidate {
        sync_generation_id,
        object,
    }))
}

fn retry_after_ms(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1000).min(NumberSafeInteger::MAX));
    }
    let target = httpdate::parse_http_date(value).ok()?;
    Some(
        target
            .duration_since(SystemTime::now())
            .unwrap_or_default()
            .as_millis()
            .min(NumberSafeInteger::MAX as u128) as u64,
    )
}

async fn bounded_bytes(mut response: Response, limit: usize) -> Result<Vec<u8>, NativeError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(NativeError::corrupt(
            "Google Drive response exceeded its size limit",
        ));
    }
    let mut output = Vec::new();
    while let Some(chunk) = tokio::time::timeout(HTTP_TIMEOUT, response.chunk())
        .await
        .map_err(|_| NativeError::transient("Google Drive response timed out"))?
        .map_err(|_| NativeError::transient("Google Drive response could not be read"))?
    {
        if output.len().saturating_add(chunk.len()) > limit {
            return Err(NativeError::corrupt(
                "Google Drive response exceeded its size limit",
            ));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn network_error(error: reqwest::Error) -> NativeError {
    if error.is_connect() {
        NativeError::new(
            NativeErrorCode::Offline,
            "Google Drive is unreachable",
            false,
        )
    } else {
        NativeError::transient("Google Drive request failed")
    }
}

async fn send_http(
    state: &GoogleDriveState,
    request: RequestBuilder,
) -> Result<Response, NativeError> {
    tokio::time::timeout(HTTP_TIMEOUT, state.http.send(request))
        .await
        .map_err(|_| NativeError::transient("Google Drive request timed out"))?
        .map_err(network_error)
}

async fn response_error(response: Response) -> NativeError {
    let status = response.status();
    let retry_after = retry_after_ms(response.headers());
    let body = bounded_bytes(response, MAX_ERROR_BYTES)
        .await
        .unwrap_or_default();
    let reasons = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|value| value.get("error").cloned())
        .and_then(|error| error.get("errors").cloned())
        .and_then(|errors| errors.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| entry.get("reason")?.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    match status {
        StatusCode::UNAUTHORIZED => NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google Drive authorization must be renewed",
            false,
        ),
        StatusCode::FORBIDDEN
            if reasons.iter().any(|reason| {
                matches!(
                    reason.as_str(),
                    "rateLimitExceeded" | "userRateLimitExceeded" | "sharingRateLimitExceeded"
                )
            }) =>
        {
            NativeError::new(
                NativeErrorCode::RateLimited,
                "Google Drive rate limit was reached",
                true,
            )
            .retry_after(retry_after)
        }
        StatusCode::FORBIDDEN
            if reasons.iter().any(|reason| {
                matches!(
                    reason.as_str(),
                    "storageQuotaExceeded" | "quotaExceeded" | "dailyLimitExceeded"
                )
            }) =>
        {
            NativeError::new(
                NativeErrorCode::QuotaExceeded,
                "Google Drive upload quota was reached",
                true,
            )
            .retry_after(retry_after)
        }
        StatusCode::FORBIDDEN => NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Google Drive appDataFolder permission was denied",
            false,
        ),
        StatusCode::TOO_MANY_REQUESTS => NativeError::new(
            NativeErrorCode::RateLimited,
            "Google Drive rate limit was reached",
            true,
        )
        .retry_after(retry_after),
        StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_EARLY => {
            NativeError::transient("Google Drive asked to retry the request")
                .retry_after(retry_after)
        }
        StatusCode::NOT_FOUND => NativeError::new(
            NativeErrorCode::RemoteObjectMissing,
            "Google Drive object is missing",
            false,
        ),
        status if status.is_server_error() => {
            NativeError::transient("Google Drive service is temporarily unavailable")
                .retry_after(retry_after)
        }
        _ => NativeError::invalid(format!(
            "Google Drive rejected the request ({})",
            status.as_u16()
        )),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn oauth_token_response_error(response: Response) -> NativeError {
    let status = response.status();
    let retry_after = retry_after_ms(response.headers());
    let body = bounded_bytes(response, MAX_ERROR_BYTES)
        .await
        .unwrap_or_default();
    let error = serde_json::from_slice::<OAuthErrorResponse>(&body).ok();

    match error.as_ref().map(|value| value.error.as_str()) {
        Some("invalid_grant") => NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google OAuth authorization code was rejected (invalid_grant)",
            false,
        ),
        Some("invalid_client" | "deleted_client") => {
            NativeError::configuration("Google Desktop OAuth client was rejected (invalid_client)")
        }
        Some("redirect_uri_mismatch") => NativeError::configuration(
            "Google OAuth redirect URI was rejected (redirect_uri_mismatch)",
        ),
        Some("access_denied") => NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google OAuth authorization was denied (access_denied)",
            false,
        ),
        Some("temporarily_unavailable" | "server_error") => {
            NativeError::transient("Google OAuth is temporarily unavailable")
                .retry_after(retry_after)
        }
        Some("invalid_request") => NativeError::invalid(
            error
                .as_ref()
                .and_then(|value| value.error_description.as_deref())
                .and_then(sanitize_oauth_error_description)
                .map(|description| {
                    format!(
                        "Google OAuth token request was invalid (invalid_request): {description}"
                    )
                })
                .unwrap_or_else(|| {
                    "Google OAuth token request was invalid (invalid_request)".into()
                }),
        ),
        _ if status.is_server_error() => {
            NativeError::transient("Google OAuth is temporarily unavailable")
                .retry_after(retry_after)
        }
        _ => NativeError::invalid(format!(
            "Google OAuth token exchange failed (HTTP {})",
            status.as_u16()
        )),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn sanitize_oauth_error_description(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 240
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b' ' | b'.' | b',' | b':' | b';' | b'(' | b')' | b'_' | b'-' | b'/' | b'\''
                )
        })
    {
        return None;
    }
    Some(value)
}

async fn parse_json<T: for<'de> Deserialize<'de>>(response: Response) -> Result<T, NativeError> {
    let bytes = bounded_bytes(response, MAX_JSON_BYTES).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| NativeError::corrupt("Google Drive returned malformed JSON"))
}

fn valid_google_oauth_client_id(value: &str) -> bool {
    let value = value.trim();
    (16..=255).contains(&value.len())
        && value.ends_with(".apps.googleusercontent.com")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn valid_google_oauth_client_secret(value: &str) -> bool {
    (8..=512).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
}

#[cfg(any(target_os = "ios", test))]
fn reversed_google_oauth_client_id(client_id: &str) -> String {
    client_id.split('.').rev().collect::<Vec<_>>().join(".")
}

#[cfg(any(target_os = "ios", test))]
fn valid_ios_oauth_build_config(client_id: &str, reversed_client_id: &str) -> bool {
    valid_google_oauth_client_id(client_id)
        && reversed_client_id == reversed_google_oauth_client_id(client_id)
}

pub(crate) fn google_drive_oauth_build_configured() -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        return option_env!("DRIFTING_GOOGLE_DESKTOP_CLIENT_ID")
            .zip(option_env!("DRIFTING_GOOGLE_DESKTOP_CLIENT_SECRET"))
            .is_some_and(|(client_id, client_secret)| {
                valid_google_oauth_client_id(client_id)
                    && valid_google_oauth_client_secret(client_secret)
            });
    }

    #[cfg(target_os = "ios")]
    {
        return option_env!("DRIFTING_GOOGLE_IOS_CLIENT_ID")
            .zip(option_env!("DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID"))
            .is_some_and(|(client_id, reversed)| {
                valid_ios_oauth_build_config(client_id, reversed)
            });
    }

    #[cfg(target_os = "android")]
    {
        return option_env!("DRIFTING_GOOGLE_ANDROID_CLIENT_ID")
            .is_some_and(valid_google_oauth_client_id);
    }

    #[allow(unreachable_code)]
    false
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn desktop_oauth_client_id() -> Result<&'static str, NativeError> {
    option_env!("DRIFTING_GOOGLE_DESKTOP_CLIENT_ID")
        .filter(|value| valid_google_oauth_client_id(value))
        .ok_or_else(|| {
            NativeError::configuration(
                "Google Drive desktop OAuth client is not configured in this build",
            )
        })
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn desktop_oauth_client_secret() -> Result<&'static str, NativeError> {
    option_env!("DRIFTING_GOOGLE_DESKTOP_CLIENT_SECRET")
        .filter(|value| valid_google_oauth_client_secret(value))
        .ok_or_else(|| {
            NativeError::configuration(
                "Google Drive desktop OAuth client secret is not configured in this build",
            )
        })
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn validate_desktop_material_for_build(
    material: &DesktopRefreshCredentialV1,
) -> Result<(), NativeError> {
    if material.client_id != desktop_oauth_client_id()? {
        return Err(NativeError::configuration(
            "Google Drive desktop OAuth binding does not match this build",
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn mobile_oauth_client_id() -> Result<&'static str, NativeError> {
    #[cfg(target_os = "ios")]
    let client_id = option_env!("DRIFTING_GOOGLE_IOS_CLIENT_ID");
    #[cfg(target_os = "android")]
    let client_id = option_env!("DRIFTING_GOOGLE_ANDROID_CLIENT_ID");

    client_id
        .filter(|value| valid_google_oauth_client_id(value))
        .ok_or_else(|| {
            NativeError::configuration(
                "Google Drive mobile OAuth client is not configured in this build",
            )
        })
}

#[cfg(target_os = "ios")]
fn ios_reversed_client_id() -> Result<&'static str, NativeError> {
    let client_id = mobile_oauth_client_id()?;
    option_env!("DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID")
        .filter(|value| valid_ios_oauth_build_config(client_id, value))
        .ok_or_else(|| {
            NativeError::configuration(
                "Google Drive iOS callback scheme is not configured in this build",
            )
        })
}

#[cfg(target_os = "ios")]
pub(crate) fn is_private_google_oauth_callback_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|parsed| parsed.scheme().starts_with("com.googleusercontent.apps."))
}

#[cfg(target_os = "ios")]
pub(crate) async fn handle_private_google_oauth_callback(app: &AppHandle, url: &str) {
    let Ok(expected_scheme) = ios_reversed_client_id() else {
        return;
    };
    let Ok(parsed) = Url::parse(url) else {
        return;
    };
    if parsed.scheme() != expected_scheme {
        return;
    }
    let _ = app.drifting_google_drive_oauth().handle_url(url).await;
}

#[cfg(target_os = "ios")]
const MOBILE_OAUTH_PLATFORM: &str = "ios";
#[cfg(target_os = "android")]
const MOBILE_OAUTH_PLATFORM: &str = "android";

#[cfg(any(target_os = "ios", target_os = "android"))]
fn mobile_oauth_error(code: Option<&str>) -> NativeError {
    match code.unwrap_or("transient") {
        "configuration-required" | "unsupported-platform" => NativeError::configuration(
            "The official Google OAuth client is unavailable or misconfigured",
        ),
        "needs-reauth" => NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google Drive authorization must be renewed",
            false,
        ),
        "account-mismatch" => NativeError::new(
            NativeErrorCode::AccountMismatch,
            "Google OAuth selected a different account",
            false,
        ),
        "permission-denied" => NativeError::new(
            NativeErrorCode::PermissionDenied,
            "Google Drive appDataFolder permission was denied",
            false,
        ),
        "cancelled" => NativeError::new(
            NativeErrorCode::Cancelled,
            "Google OAuth was cancelled",
            false,
        ),
        "offline" => NativeError::new(
            NativeErrorCode::Offline,
            "Google OAuth is unavailable offline",
            false,
        ),
        _ => NativeError::transient("Google OAuth failed temporarily"),
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn consume_mobile_oauth_response(
    mut response: MobileOAuthResponse,
    expected_subject: Option<&str>,
) -> Result<(String, Zeroizing<String>), NativeError> {
    if !response.ok {
        return Err(mobile_oauth_error(response.error_code.as_deref()));
    }
    let subject = response.account_subject.take().ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google OAuth returned no account identity",
            false,
        )
    })?;
    validate_plain_token(&subject, "Google account subject", 255)
        .map_err(|_| NativeError::corrupt("Google account identity is malformed"))?;
    if expected_subject.is_some_and(|expected| expected != subject) {
        return Err(NativeError::new(
            NativeErrorCode::AccountMismatch,
            "Google OAuth selected a different account",
            false,
        ));
    }
    let access_token = response.access_token.take().ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google OAuth returned no access token",
            false,
        )
    })?;
    validate_provider_token(&access_token, "Google access token")?;
    Ok((subject, Zeroizing::new(access_token)))
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn validate_mobile_material_for_build(material: &MobileSdkCredentialV1) -> Result<(), NativeError> {
    let configured_client_id = mobile_oauth_client_id()?;
    if material.platform != MOBILE_OAUTH_PLATFORM || material.client_id != configured_client_id {
        return Err(NativeError::configuration(
            "Google Drive mobile OAuth binding does not match this build",
        ));
    }
    #[cfg(target_os = "ios")]
    ios_reversed_client_id()?;
    Ok(())
}

fn validate_credential_material_for_build(
    credential: &GoogleCredentialV1,
) -> Result<(), NativeError> {
    match &credential.material {
        GoogleCredentialMaterialV1::DesktopRefreshToken(material) => {
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            {
                validate_desktop_material_for_build(material)
            }

            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                let _ = material;
                Err(NativeError::configuration(
                    "Desktop Google OAuth binding cannot be used on mobile",
                ))
            }

            #[cfg(not(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux",
                target_os = "ios",
                target_os = "android"
            )))]
            {
                let _ = material;
                Err(NativeError::new(
                    NativeErrorCode::UnsupportedPlatform,
                    "Google OAuth binding is unsupported on this platform",
                    false,
                ))
            }
        }
        GoogleCredentialMaterialV1::MobileSdkAccount(material) => {
            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                validate_mobile_material_for_build(material)
            }

            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            {
                let _ = material;
                Err(NativeError::configuration(
                    "Mobile Google OAuth binding cannot be used on desktop",
                ))
            }

            #[cfg(not(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux",
                target_os = "ios",
                target_os = "android"
            )))]
            {
                let _ = material;
                Err(NativeError::new(
                    NativeErrorCode::UnsupportedPlatform,
                    "Google OAuth binding is unsupported on this platform",
                    false,
                ))
            }
        }
    }
}

fn decode_credentials(serialized: &str) -> Result<GoogleCredentialV1, NativeError> {
    let credential: GoogleCredentialV1 = serde_json::from_str(&serialized)
        .map_err(|_| NativeError::configuration("Google Drive credentials are invalid"))?;
    if credential.protocol != "drifting.google-drive.credentials"
        || credential.version != 1
        || credential.account_subject.is_empty()
        || !matches!(
            credential.ownership.as_str(),
            CREDENTIAL_OWNERSHIP_PROVISIONAL | CREDENTIAL_OWNERSHIP_CLAIMED
        )
    {
        return Err(NativeError::configuration(
            "Google Drive credentials are invalid",
        ));
    }
    let material_valid = match &credential.material {
        GoogleCredentialMaterialV1::DesktopRefreshToken(material) => {
            valid_google_oauth_client_id(&material.client_id)
                && validate_provider_token(&material.access_token, "Google access token").is_ok()
                && validate_provider_token(&material.refresh_token, "Google refresh token").is_ok()
                && material.expires_at_ms > 0
        }
        GoogleCredentialMaterialV1::MobileSdkAccount(material) => {
            matches!(material.platform.as_str(), "ios" | "android")
                && valid_google_oauth_client_id(&material.client_id)
        }
    };
    if !material_valid {
        return Err(NativeError::configuration(
            "Google Drive credential material is invalid",
        ));
    }
    Ok(credential)
}

fn read_optional_credentials(
    app: &AppHandle,
    secret_ref: &str,
) -> Result<Option<GoogleCredentialV1>, NativeError> {
    let serialized = secure_storage::read_secret(app, secret_ref)
        .map_err(|_| NativeError::configuration("Google Drive credentials could not be read"))?;
    serialized.as_deref().map(decode_credentials).transpose()
}

fn read_credentials(app: &AppHandle, secret_ref: &str) -> Result<GoogleCredentialV1, NativeError> {
    read_optional_credentials(app, secret_ref)?.ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google Drive credentials are missing",
            false,
        )
    })
}

fn write_credentials(
    app: &AppHandle,
    secret_ref: &str,
    credential: &GoogleCredentialV1,
) -> Result<(), NativeError> {
    let serialized =
        Zeroizing::new(serde_json::to_string(credential).map_err(|_| {
            NativeError::configuration("Google Drive credentials could not encode")
        })?);
    secure_storage::write_secret(app, secret_ref, &serialized)
        .map_err(|_| NativeError::configuration("Google Drive credentials could not be stored"))
}

async fn validate_credential_binding(
    app: &AppHandle,
    state: &GoogleDriveState,
    credential_secret_ref: &str,
    account_subject: &str,
    mismatch_message: &'static str,
) -> Result<(), NativeError> {
    let _guard = state.refresh_lock.lock().await;
    if state
        .cached_access_token_for_request(credential_secret_ref, account_subject, None)?
        .is_some()
    {
        return Ok(());
    }

    let app_for_read = app.clone();
    let secret_for_read = credential_secret_ref.to_owned();
    let credential = tauri::async_runtime::spawn_blocking(move || {
        read_credentials(&app_for_read, &secret_for_read)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    if credential.account_subject != account_subject {
        state.clear_cached_access_token(credential_secret_ref)?;
        return Err(NativeError::new(
            NativeErrorCode::NeedsReauth,
            mismatch_message,
            false,
        ));
    }
    validate_credential_material_for_build(&credential)?;
    state.cache_access_token(credential_secret_ref, &credential)
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn revoke_google_token(
    state: &GoogleDriveState,
    refresh_token: &str,
) -> Result<RevokeAccountStatus, NativeError> {
    validate_provider_token(refresh_token, "Google refresh token")?;
    let client = state.client()?;
    let response = send_http(
        state,
        client
            .post(GOOGLE_REVOKE_URL)
            .form(&[("token", refresh_token)]),
    )
    .await?;
    if response.status().is_success() {
        return Ok(RevokeAccountStatus::Revoked);
    }
    if response.status() == StatusCode::BAD_REQUEST {
        let body = bounded_bytes(response, MAX_ERROR_BYTES)
            .await
            .unwrap_or_default();
        let error = serde_json::from_slice::<OAuthErrorResponse>(&body)
            .ok()
            .map(|value| value.error);
        if error.as_deref() == Some("invalid_token") {
            return Ok(RevokeAccountStatus::AlreadyRevoked);
        }
        return Err(NativeError::invalid(
            "Google Drive rejected credential revocation",
        ));
    }
    Err(response_error(response).await)
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn revoke_loaded_credential<Remove, RemoveFuture>(
    state: &GoogleDriveState,
    credential: Option<GoogleCredentialV1>,
    remove: Remove,
) -> Result<RevokeAccountResult, NativeError>
where
    Remove: FnOnce() -> RemoveFuture,
    RemoveFuture: Future<Output = Result<(), NativeError>>,
{
    let Some(credential) = credential else {
        return Ok(RevokeAccountResult {
            status: RevokeAccountStatus::AlreadyMissing,
            diagnostics: None,
        });
    };
    let GoogleCredentialMaterialV1::DesktopRefreshToken(material) = &credential.material else {
        return Err(NativeError::configuration(
            "Desktop Google OAuth cannot revoke a mobile SDK binding",
        ));
    };
    let status = revoke_google_token(state, &material.refresh_token).await?;
    remove().await?;
    Ok(RevokeAccountResult {
        status,
        diagnostics: None,
    })
}

async fn revoke_account_impl(
    app: AppHandle,
    state: &GoogleDriveState,
    credential_secret_ref: String,
) -> Result<RevokeAccountResult, NativeError> {
    let started_at = Instant::now();
    let _guard = state.refresh_lock.lock().await;
    // Revocation is an explicit authority transition. Stop using the bearer
    // immediately even if the remote revoke later needs a durable retry.
    state
        .clear_cached_access_token(&credential_secret_ref)
        .map_err(|error| {
            error.diagnostics(rust_revoke_diagnostics(
                started_at,
                "clear-token-cache",
                &["rust-invoke-received"],
            ))
        })?;
    let app_for_read = app.clone();
    let secret_for_read = credential_secret_ref.clone();
    let credential = tauri::async_runtime::spawn_blocking(move || {
        read_optional_credentials(&app_for_read, &secret_for_read)
    })
    .await
    .map_err(|_| {
        NativeError::configuration("Secure storage worker failed").diagnostics(
            rust_revoke_diagnostics(
                started_at,
                "read-secure-storage-worker",
                &["rust-invoke-received", "rust-cache-cleared"],
            ),
        )
    })?
    .map_err(|error| {
        error.diagnostics(rust_revoke_diagnostics(
            started_at,
            "read-secure-storage",
            &["rust-invoke-received", "rust-cache-cleared"],
        ))
    })?;

    let Some(credential) = credential else {
        return Ok(RevokeAccountResult {
            status: RevokeAccountStatus::AlreadyMissing,
            diagnostics: Some(rust_revoke_diagnostics(
                started_at,
                "already-missing",
                &[
                    "rust-invoke-received",
                    "rust-cache-cleared",
                    "rust-credential-checked",
                ],
            )),
        });
    };

    #[cfg(any(target_os = "ios", target_os = "android"))]
    let app_for_mobile = app.clone();
    let app_for_remove = app;
    let secret_for_remove = credential_secret_ref;
    let remove = move || async move {
        tauri::async_runtime::spawn_blocking(move || {
            secure_storage::remove_secret(&app_for_remove, &secret_for_remove).map_err(|_| {
                NativeError::configuration("Google Drive credentials could not be deleted")
            })
        })
        .await
        .map_err(|_| NativeError::configuration("Secure storage worker failed"))?
    };

    match &credential.material {
        GoogleCredentialMaterialV1::DesktopRefreshToken(_) => {
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            {
                let GoogleCredentialMaterialV1::DesktopRefreshToken(material) =
                    &credential.material
                else {
                    unreachable!()
                };
                validate_desktop_material_for_build(material).map_err(|error| {
                    error.diagnostics(rust_revoke_diagnostics(
                        started_at,
                        "validate-desktop-material",
                        &[
                            "rust-invoke-received",
                            "rust-cache-cleared",
                            "rust-credential-loaded",
                        ],
                    ))
                })?;
                let mut result = revoke_loaded_credential(state, Some(credential), remove)
                    .await
                    .map_err(|error| {
                        error.diagnostics(rust_revoke_diagnostics(
                            started_at,
                            "desktop-revoke-or-delete",
                            &[
                                "rust-invoke-received",
                                "rust-cache-cleared",
                                "rust-credential-loaded",
                                "rust-material-validated",
                            ],
                        ))
                    })?;
                result.diagnostics = Some(rust_revoke_diagnostics(
                    started_at,
                    "complete",
                    &[
                        "rust-invoke-received",
                        "rust-cache-cleared",
                        "rust-credential-loaded",
                        "rust-material-validated",
                        "rust-revoke-completed",
                        "rust-secure-storage-deleted",
                    ],
                ));
                Ok(result)
            }

            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                Err(NativeError::configuration(
                    "Desktop Google OAuth binding cannot be used on mobile",
                )
                .diagnostics(rust_revoke_diagnostics(
                    started_at,
                    "credential-platform-mismatch",
                    &[
                        "rust-invoke-received",
                        "rust-cache-cleared",
                        "rust-credential-loaded",
                    ],
                )))
            }
        }
        GoogleCredentialMaterialV1::MobileSdkAccount(material) => {
            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                validate_mobile_material_for_build(material).map_err(|error| {
                    error.diagnostics(rust_revoke_diagnostics(
                        started_at,
                        "validate-mobile-material",
                        &[
                            "rust-invoke-received",
                            "rust-cache-cleared",
                            "rust-credential-loaded",
                        ],
                    ))
                })?;
                let mut response = app_for_mobile
                    .drifting_google_drive_oauth()
                    .revoke(&material.client_id, &credential.account_subject)
                    .await
                    .map_err(|_| {
                        NativeError::configuration(
                            "The official Google OAuth client is unavailable",
                        )
                        .diagnostics(rust_revoke_diagnostics(
                            started_at,
                            "invoke-mobile-plugin",
                            &[
                                "rust-invoke-received",
                                "rust-cache-cleared",
                                "rust-credential-loaded",
                                "rust-material-validated",
                            ],
                        ))
                    })?;
                if !response.ok {
                    let diagnostics = native_revoke_diagnostics(
                        started_at,
                        "mobile-plugin-error",
                        &[
                            "rust-invoke-received",
                            "rust-cache-cleared",
                            "rust-credential-loaded",
                            "rust-material-validated",
                            "rust-mobile-plugin-invoked",
                        ],
                        response.diagnostics.take(),
                    );
                    return Err(
                        mobile_oauth_error(response.error_code.as_deref()).diagnostics(diagnostics)
                    );
                }
                let status = if response.already_missing {
                    RevokeAccountStatus::AlreadyRevoked
                } else {
                    RevokeAccountStatus::Revoked
                };
                remove().await.map_err(|error| {
                    error.diagnostics(rust_revoke_diagnostics(
                        started_at,
                        "delete-secure-storage",
                        &[
                            "rust-invoke-received",
                            "rust-cache-cleared",
                            "rust-credential-loaded",
                            "rust-material-validated",
                            "rust-mobile-plugin-invoked",
                            "rust-revoke-completed",
                        ],
                    ))
                })?;
                Ok(RevokeAccountResult {
                    status,
                    diagnostics: Some(native_revoke_diagnostics(
                        started_at,
                        "complete",
                        &[
                            "rust-invoke-received",
                            "rust-cache-cleared",
                            "rust-credential-loaded",
                            "rust-material-validated",
                            "rust-mobile-plugin-invoked",
                            "rust-secure-storage-deleted",
                        ],
                        response.diagnostics.take(),
                    )),
                })
            }

            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            {
                let _ = material;
                Err(NativeError::configuration(
                    "Mobile Google OAuth binding cannot be used on desktop",
                )
                .diagnostics(rust_revoke_diagnostics(
                    started_at,
                    "credential-platform-mismatch",
                    &[
                        "rust-invoke-received",
                        "rust-cache-cleared",
                        "rust-credential-loaded",
                    ],
                )))
            }
        }
    }
}

async fn refresh_credential(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    rejected_access_token: Option<&str>,
) -> Result<Zeroizing<String>, NativeError> {
    let _guard = state.refresh_lock.lock().await;
    if let Some(access_token) = state.cached_access_token_for_request(
        &generation.credential_secret_ref,
        &generation.account_subject,
        rejected_access_token,
    )? {
        return Ok(access_token);
    }
    let app_for_read = app.clone();
    let secret_ref = generation.credential_secret_ref.clone();
    let mut credential =
        tauri::async_runtime::spawn_blocking(move || read_credentials(&app_for_read, &secret_ref))
            .await
            .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    if credential.account_subject != generation.account_subject {
        state.clear_cached_access_token(&generation.credential_secret_ref)?;
        return Err(NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google Drive account identity changed",
            false,
        ));
    }
    validate_credential_material_for_build(&credential)?;
    match &mut credential.material {
        GoogleCredentialMaterialV1::DesktopRefreshToken(material) => {
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            {
                let force_refresh =
                    rejected_access_token.is_some_and(|rejected| material.access_token == rejected);
                if !force_refresh && material.expires_at_ms > now_ms().saturating_add(60_000) {
                    let access_token = Zeroizing::new(material.access_token.clone());
                    state.cache_access_token(&generation.credential_secret_ref, &credential)?;
                    return Ok(access_token);
                }
                let client = state.client()?;
                let client_secret = desktop_oauth_client_secret()?;
                let response = send_http(
                    state,
                    client.post(GOOGLE_TOKEN_URL).form(&[
                        ("client_id", material.client_id.as_str()),
                        ("client_secret", client_secret),
                        ("refresh_token", material.refresh_token.as_str()),
                        ("grant_type", "refresh_token"),
                    ]),
                )
                .await?;
                if !response.status().is_success() {
                    let mapped = oauth_token_response_error(response).await;
                    return Err(if matches!(mapped.code, NativeErrorCode::InvalidRequest) {
                        NativeError::new(
                            NativeErrorCode::NeedsReauth,
                            "Google Drive authorization must be renewed",
                            false,
                        )
                    } else {
                        mapped
                    });
                }
                let token: TokenResponse = parse_json(response).await?;
                if token.access_token.is_empty() || token.expires_in == 0 {
                    return Err(NativeError::new(
                        NativeErrorCode::NeedsReauth,
                        "Google Drive refresh returned no usable credential",
                        false,
                    ));
                }
                material.access_token = token.access_token;
                material.expires_at_ms =
                    now_ms().saturating_add(token.expires_in.saturating_mul(1000));
                let access_token = Zeroizing::new(material.access_token.clone());
                let app_for_write = app.clone();
                let secret_ref = generation.credential_secret_ref.clone();
                let serialized_credential = credential.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    write_credentials(&app_for_write, &secret_ref, &serialized_credential)
                })
                .await
                .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
                state.cache_access_token(&generation.credential_secret_ref, &credential)?;
                Ok(access_token)
            }

            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                let _ = (material, rejected_access_token);
                Err(NativeError::configuration(
                    "Desktop Google OAuth binding cannot be used on mobile",
                ))
            }

            #[cfg(not(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux",
                target_os = "ios",
                target_os = "android"
            )))]
            {
                let _ = (material, rejected_access_token);
                Err(NativeError::new(
                    NativeErrorCode::UnsupportedPlatform,
                    "Google OAuth binding is unsupported on this platform",
                    false,
                ))
            }
        }
        GoogleCredentialMaterialV1::MobileSdkAccount(material) => {
            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                let _ = rejected_access_token;
                let response = app
                    .drifting_google_drive_oauth()
                    .fresh_token(&material.client_id, &credential.account_subject)
                    .await
                    .map_err(|_| {
                        NativeError::configuration(
                            "The official Google OAuth client is unavailable",
                        )
                    })?;
                let (_, access_token) =
                    consume_mobile_oauth_response(response, Some(&credential.account_subject))?;
                Ok(access_token)
            }

            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            {
                let _ = (material, rejected_access_token);
                Err(NativeError::configuration(
                    "Mobile Google OAuth binding cannot be used on desktop",
                ))
            }
        }
    }
}

async fn authorized_send<F>(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    build: F,
) -> Result<Response, NativeError>
where
    F: Fn(&Client, &str) -> RequestBuilder,
{
    let client = state.client()?;
    let token = refresh_credential(app, state, generation, None).await?;
    let response = send_http(state, build(&client, &token)).await?;
    if response.status() != StatusCode::UNAUTHORIZED {
        return Ok(response);
    }
    drop(response);
    let refreshed_token = refresh_credential(app, state, generation, Some(token.as_str())).await?;
    drop(token);
    let response = send_http(state, build(&client, &refreshed_token)).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        state.clear_rejected_access_token(
            &generation.credential_secret_ref,
            &generation.account_subject,
            refreshed_token.as_str(),
        )?;
        return Err(NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google Drive authorization must be renewed",
            false,
        ));
    }
    Ok(response)
}

fn fields() -> &'static str {
    "id,size,trashed,appProperties"
}

async fn start_cursor(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
) -> Result<String, NativeError> {
    let response = authorized_send(app, state, generation, |client, token| {
        client
            .get(format!("{DRIVE_API}/changes/startPageToken"))
            .bearer_auth(token)
            .query(&[("spaces", APP_DATA_FOLDER), ("supportsAllDrives", "false")])
    })
    .await?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let result: StartPageToken = parse_json(response).await?;
    validate_provider_token(&result.start_page_token, "Drive cursor")?;
    Ok(result.start_page_token)
}

async fn list_inventory(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    page_token: Option<String>,
) -> Result<InventoryPageResult, NativeError> {
    if let Some(token) = page_token.as_deref() {
        validate_provider_token(token, "Drive page token")?;
    }
    let query = format!(
        "trashed = false and appProperties has {{ key='{PROP_PROTOCOL}' and value='{PROTOCOL_VALUE}' }} and appProperties has {{ key='{PROP_SYNC_GENERATION}' and value='{}' }}",
        escape_drive_query_value(&generation.sync_generation_id),
    );
    let response = authorized_send(app, state, generation, |client, token| {
        let mut request = client
            .get(format!("{DRIVE_API}/files"))
            .bearer_auth(token)
            .query(&[
                ("spaces", APP_DATA_FOLDER),
                ("q", query.as_str()),
                ("pageSize", "1000"),
                ("fields", &format!("nextPageToken,files({})", fields())),
            ]);
        if let Some(page_token) = page_token.as_deref() {
            request = request.query(&[("pageToken", page_token)]);
        }
        request
    })
    .await?;
    if !response.status().is_success() {
        if response.status() == StatusCode::GONE && page_token.is_some() {
            return Err(NativeError::new(
                NativeErrorCode::InvalidPageToken,
                "Google Drive inventory page token is no longer valid",
                false,
            ));
        }
        return Err(response_error(response).await);
    }
    let wire: FileList = parse_json(response).await?;
    let mut objects = Vec::new();
    let mut logical_keys = HashSet::new();
    for file in wire.files {
        if let Some(object) = parse_drive_file(file, &generation.sync_generation_id)? {
            if !logical_keys.insert(object.logical_key_id.clone()) {
                return Err(NativeError::corrupt(
                    "Drive inventory contains duplicate immutable logical keys",
                ));
            }
            objects.push(object);
        }
    }
    if let Some(token) = wire.next_page_token.as_deref() {
        validate_provider_token(token, "Drive page token")
            .map_err(|_| NativeError::corrupt("Drive returned a malformed page token"))?;
    }
    Ok(InventoryPageResult {
        objects,
        next_page_token: wire.next_page_token,
    })
}

async fn discover_project_snapshots(
    app: &AppHandle,
    state: &GoogleDriveState,
    account: &OpenGeneration,
    page_token: Option<String>,
) -> Result<ProjectSnapshotDiscoveryPage, NativeError> {
    if let Some(token) = page_token.as_deref() {
        validate_provider_token(token, "Drive page token")?;
    }
    let query = format!(
        "trashed = false and appProperties has {{ key='{PROP_PROTOCOL}' and value='{PROTOCOL_VALUE}' }} and appProperties has {{ key='{PROP_KIND}' and value='snapshot-commit' }}"
    );
    let response = authorized_send(app, state, account, |client, token| {
        let mut request = client
            .get(format!("{DRIVE_API}/files"))
            .bearer_auth(token)
            .query(&[
                ("spaces", APP_DATA_FOLDER),
                ("q", query.as_str()),
                ("pageSize", "1000"),
                ("fields", &format!("nextPageToken,files({})", fields())),
            ]);
        if let Some(page_token) = page_token.as_deref() {
            request = request.query(&[("pageToken", page_token)]);
        }
        request
    })
    .await?;
    if !response.status().is_success() {
        if response.status() == StatusCode::GONE && page_token.is_some() {
            return Err(NativeError::new(
                NativeErrorCode::InvalidPageToken,
                "Google Drive snapshot page token is no longer valid",
                false,
            ));
        }
        return Err(response_error(response).await);
    }
    let wire: FileList = parse_json(response).await?;
    let mut snapshots = Vec::new();
    let mut logical_keys = HashSet::new();
    for file in wire.files {
        if let Some(candidate) = parse_drive_project_snapshot(file)? {
            if !logical_keys.insert(candidate.object.logical_key_id.clone()) {
                return Err(NativeError::corrupt(
                    "Drive project discovery contains duplicate snapshot logical keys",
                ));
            }
            snapshots.push(candidate);
        }
    }
    if let Some(token) = wire.next_page_token.as_deref() {
        validate_provider_token(token, "Drive page token")
            .map_err(|_| NativeError::corrupt("Drive returned a malformed page token"))?;
    }
    Ok(ProjectSnapshotDiscoveryPage {
        snapshots,
        next_page_token: wire.next_page_token,
    })
}

async fn list_changes(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    cursor: String,
    page_token: Option<String>,
) -> Result<ChangePageResult, NativeError> {
    validate_provider_token(&cursor, "Drive cursor")?;
    if let Some(token) = page_token.as_deref() {
        validate_provider_token(token, "Drive page token")?;
    }
    let effective_token = page_token.as_deref().unwrap_or(&cursor);
    let response = authorized_send(app, state, generation, |client, token| {
        client
            .get(format!("{DRIVE_API}/changes"))
            .bearer_auth(token)
            .query(&[
                ("pageToken", effective_token),
                ("spaces", APP_DATA_FOLDER),
                ("includeRemoved", "true"),
                ("pageSize", "1000"),
                (
                    "fields",
                    &format!(
                        "nextPageToken,newStartPageToken,changes(fileId,removed,file({}))",
                        fields()
                    ),
                ),
            ])
    })
    .await?;
    if !response.status().is_success() {
        if response.status() == StatusCode::GONE {
            return Err(NativeError::new(
                if page_token.is_some() {
                    NativeErrorCode::InvalidPageToken
                } else {
                    NativeErrorCode::InvalidCursor
                },
                "Google Drive changes token is no longer valid",
                false,
            ));
        }
        return Err(response_error(response).await);
    }
    let wire: ChangeList = parse_json(response).await?;
    let changes = parse_drive_changes(wire.changes, &generation.sync_generation_id)?;
    for token in [
        wire.next_page_token.as_deref(),
        wire.new_start_page_token.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        validate_provider_token(token, "Drive cursor")
            .map_err(|_| NativeError::corrupt("Drive returned a malformed cursor"))?;
    }
    if wire.next_page_token.is_some() && wire.new_start_page_token.is_some() {
        return Err(NativeError::corrupt(
            "Drive changes page returned conflicting continuation tokens",
        ));
    }
    if wire.next_page_token.is_none() && wire.new_start_page_token.is_none() {
        return Err(NativeError::corrupt(
            "Drive changes page omitted its continuation cursor",
        ));
    }
    Ok(ChangePageResult {
        changes,
        next_page_token: wire.next_page_token,
        new_cursor: wire.new_start_page_token,
    })
}

fn escape_drive_query_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

async fn stat_objects(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    logical_key_id: &str,
) -> Result<Vec<RemoteObject>, NativeError> {
    validate_logical_key_id(logical_key_id)?;
    let query = format!(
        "trashed = false and appProperties has {{ key='{PROP_PROTOCOL}' and value='{PROTOCOL_VALUE}' }} and appProperties has {{ key='{PROP_SYNC_GENERATION}' and value='{}' }} and appProperties has {{ key='{PROP_LOGICAL}' and value='{}' }}",
        escape_drive_query_value(&generation.sync_generation_id),
        escape_drive_query_value(logical_key_id),
    );
    let response = authorized_send(app, state, generation, |client, token| {
        client
            .get(format!("{DRIVE_API}/files"))
            .bearer_auth(token)
            .query(&[
                ("spaces", APP_DATA_FOLDER),
                ("q", query.as_str()),
                ("pageSize", "10"),
                ("fields", &format!("files({})", fields())),
            ])
    })
    .await?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let wire: FileList = parse_json(response).await?;
    let mut objects = Vec::new();
    for file in wire.files {
        if let Some(object) = parse_drive_file(file, &generation.sync_generation_id)? {
            objects.push(object);
        }
    }
    Ok(objects)
}

async fn stat_immutable(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    expected_kind: SyncObjectKind,
    logical_key_id: &str,
) -> Result<Option<RemoteObject>, NativeError> {
    let mut objects = stat_objects(app, state, generation, logical_key_id).await?;
    if objects.len() > 1 {
        return Err(NativeError::corrupt(
            "Drive contains duplicate immutable logical keys",
        ));
    }
    let result = objects.pop();
    if result
        .as_ref()
        .is_some_and(|object| object.object_kind != expected_kind)
    {
        return Err(NativeError::new(
            NativeErrorCode::ImmutableConflict,
            "Drive logical key is already bound to another object kind",
            false,
        ));
    }
    Ok(result)
}

fn transfer_secret_ref(transfer_id: &str) -> Result<String, NativeError> {
    validate_plain_token(transfer_id, "Transfer ID", 200)?;
    Ok(format!(
        "sync.google-drive.resumable.{:x}",
        Sha256::digest(transfer_id.as_bytes())
    ))
}

fn validate_session_uri(value: &str) -> Result<(), NativeError> {
    let url = Url::parse(value)
        .map_err(|_| NativeError::corrupt("Saved resumable upload session is invalid"))?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https"
        || !(host == "www.googleapis.com" || host.ends_with(".googleapis.com"))
        || url.username() != ""
        || url.password().is_some()
    {
        return Err(NativeError::corrupt(
            "Saved resumable upload session has an invalid origin",
        ));
    }
    Ok(())
}

fn load_session(
    app: &AppHandle,
    transfer_id: &str,
) -> Result<Option<ResumableSession>, NativeError> {
    let secret_ref = transfer_secret_ref(transfer_id)?;
    let Some(serialized) = secure_storage::read_secret(app, &secret_ref)
        .map_err(|_| NativeError::configuration("Resumable upload state could not be read"))?
    else {
        return Ok(None);
    };
    let session: ResumableSession = serde_json::from_str(&serialized)
        .map_err(|_| NativeError::corrupt("Saved resumable upload state is malformed"))?;
    validate_session_uri(&session.session_uri)?;
    Ok(Some(session))
}

fn save_session(
    app: &AppHandle,
    transfer_id: &str,
    session: &ResumableSession,
) -> Result<(), NativeError> {
    let secret_ref = transfer_secret_ref(transfer_id)?;
    let serialized = Zeroizing::new(
        serde_json::to_string(session)
            .map_err(|_| NativeError::configuration("Resumable upload state could not encode"))?,
    );
    secure_storage::write_secret(app, &secret_ref, &serialized)
        .map_err(|_| NativeError::configuration("Resumable upload state could not be stored"))
}

fn remove_session(app: &AppHandle, transfer_id: &str) -> Result<(), NativeError> {
    let secret_ref = transfer_secret_ref(transfer_id)?;
    secure_storage::remove_secret(app, &secret_ref)
        .map_err(|_| NativeError::configuration("Resumable upload state could not be removed"))
}

fn session_matches(
    session: &ResumableSession,
    generation: &OpenGeneration,
    kind: SyncObjectKind,
    logical_key_id: &str,
    stored_sha256: &str,
    size_bytes: u64,
) -> bool {
    session.protocol == "drifting.google-drive.resumable"
        && session.version == 1
        && session.sync_generation_id == generation.sync_generation_id
        && session.object_kind == kind.as_str()
        && session.logical_key_id == logical_key_id
        && session.stored_sha256 == stored_sha256
        && session.size_bytes == size_bytes
}

fn upload_metadata(
    generation: &OpenGeneration,
    kind: SyncObjectKind,
    logical_key_id: &str,
    stored_sha256: &str,
    size_bytes: u64,
) -> Value {
    json!({
        "name": "drifting-sync-object",
        "parents": [APP_DATA_FOLDER],
        "appProperties": {
            PROP_PROTOCOL: PROTOCOL_VALUE,
            PROP_SYNC_GENERATION: generation.sync_generation_id,
            PROP_KIND: kind.as_str(),
            PROP_LOGICAL: logical_key_id,
            PROP_HASH: stored_sha256,
            PROP_SIZE: size_bytes.to_string(),
        }
    })
}

fn upload_range(headers: &HeaderMap, total: u64) -> Result<u64, NativeError> {
    let Some(value) = headers.get(RANGE) else {
        return Ok(0);
    };
    let text = value
        .to_str()
        .map_err(|_| NativeError::corrupt("Drive resumable Range is malformed"))?;
    let end = text
        .strip_prefix("bytes=0-")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| NativeError::corrupt("Drive resumable Range is malformed"))?;
    let next = end
        .checked_add(1)
        .ok_or_else(|| NativeError::corrupt("Drive resumable Range overflowed"))?;
    if next > total {
        return Err(NativeError::corrupt(
            "Drive resumable Range exceeds the upload size",
        ));
    }
    Ok(next)
}

async fn initiate_upload(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    kind: SyncObjectKind,
    logical_key_id: &str,
    stored_sha256: &str,
    size_bytes: u64,
) -> Result<String, NativeError> {
    let metadata = upload_metadata(generation, kind, logical_key_id, stored_sha256, size_bytes);
    let response = authorized_send(app, state, generation, |client, token| {
        client
            .post(format!("{DRIVE_UPLOAD_API}/files"))
            .bearer_auth(token)
            .query(&[("uploadType", "resumable"), ("fields", fields())])
            .header(CONTENT_TYPE, "application/json; charset=UTF-8")
            .header("X-Upload-Content-Type", "application/octet-stream")
            .header("X-Upload-Content-Length", size_bytes)
            .json(&metadata)
    })
    .await?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let uri = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| NativeError::corrupt("Drive omitted the resumable upload location"))?;
    validate_session_uri(&uri)?;
    Ok(uri)
}

async fn query_upload_offset(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    session_uri: &str,
    total: u64,
) -> Result<(u64, Option<Response>), NativeError> {
    let response = authorized_send(app, state, generation, |client, token| {
        client
            .put(session_uri)
            .bearer_auth(token)
            .header(CONTENT_LENGTH, 0)
            .header(CONTENT_RANGE, format!("bytes */{total}"))
    })
    .await?;
    if response.status().is_success() {
        return Ok((total, Some(response)));
    }
    if response.status().as_u16() == 308 {
        return Ok((upload_range(response.headers(), total)?, None));
    }
    if matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::GONE) {
        return Err(NativeError::new(
            NativeErrorCode::RemoteObjectMissing,
            "Google Drive resumable upload session expired",
            false,
        ));
    }
    Err(response_error(response).await)
}

fn verify_uploaded_object(
    object: RemoteObject,
    kind: SyncObjectKind,
    logical_key_id: &str,
    stored_sha256: &str,
    size_bytes: u64,
) -> Result<RemoteObject, NativeError> {
    if object.object_kind != kind
        || object.logical_key_id != logical_key_id
        || object.stored_sha256 != stored_sha256
        || object.size_bytes != size_bytes
    {
        return Err(NativeError::corrupt(
            "Drive upload response conflicts with immutable metadata",
        ));
    }
    Ok(object)
}

#[allow(clippy::too_many_arguments)]
async fn upload_impl(
    app: AppHandle,
    state: &GoogleDriveState,
    generation: OpenGeneration,
    source_ref: String,
    kind: SyncObjectKind,
    logical_key_id: String,
    stored_sha256: String,
    size_bytes: u64,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
) -> Result<UploadResult, NativeError> {
    validate_logical_key_id(&logical_key_id)?;
    validate_hash(&stored_sha256)?;
    validate_plain_token(&transfer_id, "Transfer ID", 200)?;
    if size_bytes == 0 || size_bytes > MAX_REMOTE_OBJECT_BYTES {
        return Err(NativeError::invalid("Upload size is invalid"));
    }
    let app_for_validation = app.clone();
    let source_for_validation = source_ref.clone();
    let hash_for_validation = stored_sha256.clone();
    let source_path = tauri::async_runtime::spawn_blocking(move || {
        validate_upload_ref(
            &app_for_validation,
            &source_for_validation,
            &hash_for_validation,
            size_bytes,
        )
    })
    .await
    .map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Upload object validation worker failed",
            false,
        )
    })?
    .map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Upload source does not match its immutable hash and size",
            false,
        )
    })?;
    report_transfer_progress(&on_progress, &transfer_id, "upload", 0, size_bytes);

    if let Some(existing) = stat_immutable(&app, state, &generation, kind, &logical_key_id).await? {
        if existing.stored_sha256 == stored_sha256 && existing.size_bytes == size_bytes {
            let app_for_remove = app.clone();
            let transfer_for_remove = transfer_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                remove_session(&app_for_remove, &transfer_for_remove)
            })
            .await
            .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
            report_transfer_progress(&on_progress, &transfer_id, "upload", size_bytes, size_bytes);
            return Ok(UploadResult {
                status: "already-present",
                object: existing,
            });
        }
        return Err(NativeError::new(
            NativeErrorCode::ImmutableConflict,
            "Drive logical key already contains different immutable bytes",
            false,
        ));
    }

    let app_for_session = app.clone();
    let transfer_for_session = transfer_id.clone();
    let mut session = tauri::async_runtime::spawn_blocking(move || {
        load_session(&app_for_session, &transfer_for_session)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    if session.as_ref().is_some_and(|value| {
        !session_matches(
            value,
            &generation,
            kind,
            &logical_key_id,
            &stored_sha256,
            size_bytes,
        )
    }) {
        return Err(NativeError::invalid(
            "Transfer ID is already bound to a different immutable upload",
        ));
    }
    let mut resumed = session.is_some();
    if session.is_none() {
        let session_uri = initiate_upload(
            &app,
            state,
            &generation,
            kind,
            &logical_key_id,
            &stored_sha256,
            size_bytes,
        )
        .await?;
        let created = ResumableSession {
            protocol: "drifting.google-drive.resumable".into(),
            version: 1,
            session_uri,
            sync_generation_id: generation.sync_generation_id.clone(),
            object_kind: kind.as_str().into(),
            logical_key_id: logical_key_id.clone(),
            stored_sha256: stored_sha256.clone(),
            size_bytes,
        };
        let app_for_save = app.clone();
        let transfer_for_save = transfer_id.clone();
        let saved = created.clone_for_storage();
        tauri::async_runtime::spawn_blocking(move || {
            save_session(&app_for_save, &transfer_for_save, &saved)
        })
        .await
        .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
        session = Some(created);
    }
    let mut session = session.ok_or_else(|| {
        NativeError::configuration("Resumable upload session was not initialized")
    })?;
    let mut offset = 0_u64;
    if resumed {
        let query =
            query_upload_offset(&app, state, &generation, &session.session_uri, size_bytes).await;
        let (remote_offset, completed) = match query {
            Ok(value) => value,
            Err(error) if error.code == NativeErrorCode::RemoteObjectMissing => {
                let app_for_remove = app.clone();
                let transfer_for_remove = transfer_id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    remove_session(&app_for_remove, &transfer_for_remove)
                })
                .await
                .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
                session.session_uri = initiate_upload(
                    &app,
                    state,
                    &generation,
                    kind,
                    &logical_key_id,
                    &stored_sha256,
                    size_bytes,
                )
                .await?;
                let app_for_save = app.clone();
                let transfer_for_save = transfer_id.clone();
                let saved = session.clone_for_storage();
                tauri::async_runtime::spawn_blocking(move || {
                    save_session(&app_for_save, &transfer_for_save, &saved)
                })
                .await
                .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
                resumed = false;
                (0, None)
            }
            Err(error) => return Err(error),
        };
        if let Some(response) = completed {
            let file: DriveFile = parse_json(response).await?;
            let object = parse_drive_file(file, &generation.sync_generation_id)?
                .ok_or_else(|| NativeError::corrupt("Completed upload returned no sync object"))?;
            let object =
                verify_uploaded_object(object, kind, &logical_key_id, &stored_sha256, size_bytes)?;
            let app_for_remove = app.clone();
            let transfer_for_remove = transfer_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                remove_session(&app_for_remove, &transfer_for_remove)
            })
            .await
            .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
            report_transfer_progress(&on_progress, &transfer_id, "upload", size_bytes, size_bytes);
            return Ok(UploadResult {
                status: "created",
                object,
            });
        }
        offset = remote_offset;
        report_transfer_progress(&on_progress, &transfer_id, "upload", offset, size_bytes);
    }
    debug_assert!(!resumed || offset <= size_bytes);

    let mut file = tokio::fs::File::open(&source_path).await.map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Upload source disappeared",
            false,
        )
    })?;
    while offset < size_bytes {
        let length = RESUMABLE_CHUNK_BYTES.min(size_bytes - offset);
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| {
                NativeError::new(
                    NativeErrorCode::LocalObjectInvalid,
                    "Upload source could not seek",
                    false,
                )
            })?;
        let mut chunk = vec![0_u8; length as usize];
        file.read_exact(&mut chunk).await.map_err(|_| {
            NativeError::new(
                NativeErrorCode::LocalObjectInvalid,
                "Upload source was truncated",
                false,
            )
        })?;
        let end = offset + length - 1;
        let response = authorized_send(&app, state, &generation, |client, token| {
            client
                .put(&session.session_uri)
                .bearer_auth(token)
                .header(CONTENT_TYPE, "application/octet-stream")
                .header(CONTENT_LENGTH, length)
                .header(CONTENT_RANGE, format!("bytes {offset}-{end}/{size_bytes}"))
                .body(chunk.clone())
        })
        .await?;
        if response.status().is_success() {
            let uploaded: DriveFile = parse_json(response).await?;
            let object = parse_drive_file(uploaded, &generation.sync_generation_id)?
                .ok_or_else(|| NativeError::corrupt("Drive upload returned no sync object"))?;
            let object =
                verify_uploaded_object(object, kind, &logical_key_id, &stored_sha256, size_bytes)?;
            let app_for_remove = app.clone();
            let transfer_for_remove = transfer_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                remove_session(&app_for_remove, &transfer_for_remove)
            })
            .await
            .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
            report_transfer_progress(&on_progress, &transfer_id, "upload", size_bytes, size_bytes);
            return Ok(UploadResult {
                status: "created",
                object,
            });
        }
        if response.status().as_u16() != 308 {
            return Err(response_error(response).await);
        }
        let next = upload_range(response.headers(), size_bytes)?;
        if next <= offset {
            return Err(NativeError::transient(
                "Drive resumable upload did not advance",
            ));
        }
        offset = next;
        report_transfer_progress(&on_progress, &transfer_id, "upload", offset, size_bytes);
    }
    let (_, completed) =
        query_upload_offset(&app, state, &generation, &session.session_uri, size_bytes).await?;
    let response = completed.ok_or_else(|| {
        NativeError::transient("Drive did not commit the completed resumable upload")
    })?;
    let uploaded: DriveFile = parse_json(response).await?;
    let object = parse_drive_file(uploaded, &generation.sync_generation_id)?
        .ok_or_else(|| NativeError::corrupt("Drive upload returned no sync object"))?;
    let object = verify_uploaded_object(object, kind, &logical_key_id, &stored_sha256, size_bytes)?;
    let app_for_remove = app.clone();
    let transfer_for_remove = transfer_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        remove_session(&app_for_remove, &transfer_for_remove)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    report_transfer_progress(&on_progress, &transfer_id, "upload", size_bytes, size_bytes);
    Ok(UploadResult {
        status: "created",
        object,
    })
}

impl ResumableSession {
    fn clone_for_storage(&self) -> Self {
        Self {
            protocol: self.protocol.clone(),
            version: self.version,
            session_uri: self.session_uri.clone(),
            sync_generation_id: self.sync_generation_id.clone(),
            object_kind: self.object_kind.clone(),
            logical_key_id: self.logical_key_id.clone(),
            stored_sha256: self.stored_sha256.clone(),
            size_bytes: self.size_bytes,
        }
    }
}

async fn fetch_remote_metadata(
    app: &AppHandle,
    state: &GoogleDriveState,
    generation: &OpenGeneration,
    object_id: &str,
) -> Result<RemoteObject, NativeError> {
    validate_plain_token(object_id, "Drive object ID", 255)?;
    let encoded =
        percent_encoding::utf8_percent_encode(object_id, percent_encoding::NON_ALPHANUMERIC);
    let response = authorized_send(app, state, generation, |client, token| {
        client
            .get(format!("{DRIVE_API}/files/{encoded}"))
            .bearer_auth(token)
            .query(&[("fields", fields())])
    })
    .await?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let wire: DriveFile = parse_json(response).await?;
    parse_drive_file(wire, &generation.sync_generation_id)?
        .ok_or_else(|| NativeError::corrupt("Drive file is not an object in this Sync Generation"))
}

async fn download_impl(
    app: AppHandle,
    state: &GoogleDriveState,
    generation: OpenGeneration,
    object_id: String,
    destination_ref: String,
    expected_stored_sha256: String,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
) -> Result<DownloadResult, NativeError> {
    validate_hash(&expected_stored_sha256)?;
    validate_plain_token(&transfer_id, "Transfer ID", 200)?;
    let metadata = fetch_remote_metadata(&app, state, &generation, &object_id).await?;
    if metadata.stored_sha256 != expected_stored_sha256 {
        return Err(NativeError::corrupt(
            "Drive download hash conflicts with immutable metadata",
        ));
    }
    report_transfer_progress(
        &on_progress,
        &transfer_id,
        "download",
        0,
        metadata.size_bytes,
    );
    let app_for_path = app.clone();
    let destination_for_path = destination_ref.clone();
    let destination = tauri::async_runtime::spawn_blocking(move || {
        resolve_download_destination_ref(&app_for_path, &destination_for_path)
    })
    .await
    .map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Download staging worker failed",
            false,
        )
    })?
    .map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Download destination is invalid",
            false,
        )
    })?;
    ensure_parent_directory(&destination).map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Download destination could not be prepared",
            false,
        )
    })?;
    let temporary = temporary_sibling(&destination).map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Download staging path could not be allocated",
            false,
        )
    })?;
    let mut guard = TempDownload::new(temporary.clone());
    let encoded =
        percent_encoding::utf8_percent_encode(&object_id, percent_encoding::NON_ALPHANUMERIC);
    let response = authorized_send(&app, state, &generation, |client, token| {
        client
            .get(format!("{DRIVE_API}/files/{encoded}"))
            .bearer_auth(token)
            .query(&[("alt", "media")])
    })
    .await?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    if response
        .content_length()
        .is_some_and(|length| length != metadata.size_bytes)
    {
        return Err(NativeError::corrupt(
            "Drive download length conflicts with immutable metadata",
        ));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await
        .map_err(|_| {
            NativeError::new(
                NativeErrorCode::LocalObjectInvalid,
                "Download staging file could not be created",
                false,
            )
        })?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut last_reported = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(next) = tokio::time::timeout(HTTP_TIMEOUT, stream.next())
        .await
        .map_err(|_| NativeError::transient("Google Drive download timed out"))?
    {
        let chunk = next.map_err(network_error)?;
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| NativeError::corrupt("Drive download size overflowed"))?;
        if total > MAX_REMOTE_OBJECT_BYTES || total > metadata.size_bytes {
            return Err(NativeError::corrupt(
                "Drive download exceeded immutable metadata",
            ));
        }
        digest.update(&chunk);
        file.write_all(&chunk).await.map_err(|_| {
            NativeError::new(
                NativeErrorCode::LocalObjectInvalid,
                "Download staging write failed",
                false,
            )
        })?;
        if total == metadata.size_bytes
            || total.saturating_sub(last_reported) >= PROGRESS_REPORT_INTERVAL_BYTES
        {
            report_transfer_progress(
                &on_progress,
                &transfer_id,
                "download",
                total,
                metadata.size_bytes,
            );
            last_reported = total;
        }
    }
    if total != metadata.size_bytes {
        return Err(NativeError::corrupt("Drive download was truncated"));
    }
    let actual = format!("sha256:{:x}", digest.finalize());
    if actual != expected_stored_sha256 {
        return Err(NativeError::corrupt(
            "Drive download failed its stored SHA-256 check",
        ));
    }
    file.sync_all().await.map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Download durability barrier failed",
            false,
        )
    })?;
    drop(file);
    let temporary_for_commit = temporary.clone();
    let destination_for_commit = destination.clone();
    tauri::async_runtime::spawn_blocking(move || {
        durable_replace_file(&temporary_for_commit, &destination_for_commit)
    })
    .await
    .map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Download commit worker failed",
            false,
        )
    })?
    .map_err(|_| {
        NativeError::new(
            NativeErrorCode::LocalObjectInvalid,
            "Download could not be committed durably",
            false,
        )
    })?;
    guard.disarm();
    Ok(DownloadResult {
        destination_ref,
        stored_sha256: actual,
        size_bytes: total,
    })
}

fn register_transfer(
    state: &GoogleDriveState,
    transfer_id: &str,
) -> Result<(AbortHandle, futures_util::future::AbortRegistration), NativeError> {
    validate_plain_token(transfer_id, "Transfer ID", 200)?;
    let (handle, registration) = AbortHandle::new_pair();
    let mut transfers = state
        .transfers
        .lock()
        .map_err(|_| NativeError::configuration("Transfer state is unavailable"))?;
    if transfers.pre_cancelled.remove(transfer_id) {
        return Err(NativeError::new(
            NativeErrorCode::Cancelled,
            "Google Drive transfer was cancelled",
            false,
        ));
    }
    if transfers.active.contains_key(transfer_id) {
        return Err(NativeError::invalid("Transfer ID is already active"));
    }
    transfers
        .active
        .insert(transfer_id.to_owned(), handle.clone());
    Ok((handle, registration))
}

async fn run_transfer<T>(
    state: &GoogleDriveState,
    transfer_id: String,
    operation: Pin<Box<dyn Future<Output = Result<T, NativeError>> + Send + '_>>,
) -> Result<T, NativeError> {
    let (_handle, registration) = register_transfer(state, &transfer_id)?;
    let result = Abortable::new(operation, registration).await;
    if let Ok(mut transfers) = state.transfers.lock() {
        transfers.active.remove(&transfer_id);
        transfers.pre_cancelled.remove(&transfer_id);
    }
    match result {
        Ok(result) => result,
        Err(_) => Err(NativeError::new(
            NativeErrorCode::Cancelled,
            "Google Drive transfer was cancelled",
            false,
        )),
    }
}

#[tauri::command]
pub(crate) async fn google_drive_open_generation(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    credential_secret_ref: String,
    account_subject: String,
    binding_id: String,
    sync_generation_id: String,
    authority_generation: u64,
) -> Result<NativeResult<OpenGenerationResult>, String> {
    let result: Result<OpenGenerationResult, NativeError> = async {
        validate_plain_token(&credential_secret_ref, "Credential secret reference", 128)?;
        validate_plain_token(&account_subject, "Google account subject", 255)?;
        validate_plain_token(&binding_id, "Binding ID", 255)?;
        validate_plain_token(&sync_generation_id, "Sync Generation ID", 255)?;
        if authority_generation == 0 || authority_generation > NumberSafeInteger::MAX {
            return Err(NativeError::invalid("Authority generation is invalid"));
        }
        validate_credential_binding(
            &app,
            &state,
            &credential_secret_ref,
            &account_subject,
            "Google account identity does not match the binding",
        )
        .await?;
        let mut handles = state
            .binding_handles
            .lock()
            .map_err(|_| NativeError::configuration("Google Drive binding state is unavailable"))?;
        if let Some(existing_ref) = handles.get(&binding_id) {
            let generations = state.generations.lock().map_err(|_| {
                NativeError::configuration("Google Drive Sync Generation state is unavailable")
            })?;
            let existing = generations.get(existing_ref).ok_or_else(|| {
                NativeError::configuration("Google Drive Sync Generation state is inconsistent")
            })?;
            if existing.sync_generation_id != sync_generation_id
                || existing.account_subject != account_subject
                || existing.credential_secret_ref != credential_secret_ref
                || existing.authority_generation != authority_generation
            {
                return Err(NativeError::invalid(
                    "A Drive binding cannot be reopened with different authority",
                ));
            }
            return Ok(OpenGenerationResult {
                generation_ref: existing_ref.clone(),
                sync_generation_id,
            });
        }
        let generation_ref = format!("syncdrive:{}", random_hex(32)?);
        state
            .generations
            .lock()
            .map_err(|_| {
                NativeError::configuration("Google Drive Sync Generation state is unavailable")
            })?
            .insert(
                generation_ref.clone(),
                OpenGeneration {
                    credential_secret_ref,
                    account_subject,
                    sync_generation_id: sync_generation_id.clone(),
                    authority_generation,
                },
            );
        handles.insert(binding_id, generation_ref.clone());
        Ok(OpenGenerationResult {
            generation_ref,
            sync_generation_id,
        })
    }
    .await;
    Ok(NativeResult::from_result(result))
}

struct NumberSafeInteger;
impl NumberSafeInteger {
    const MAX: u64 = 9_007_199_254_740_991;
}

async fn discovery_account(
    app: &AppHandle,
    state: &GoogleDriveState,
    credential_secret_ref: String,
    account_subject: String,
) -> Result<OpenGeneration, NativeError> {
    validate_plain_token(&credential_secret_ref, "Credential secret reference", 128)?;
    validate_plain_token(&account_subject, "Google account subject", 255)?;
    validate_credential_binding(
        app,
        state,
        &credential_secret_ref,
        &account_subject,
        "Google account identity does not match project discovery",
    )
    .await?;
    Ok(OpenGeneration {
        credential_secret_ref,
        account_subject,
        sync_generation_id: "project-discovery".into(),
        authority_generation: 1,
    })
}

#[tauri::command]
pub(crate) async fn google_drive_discover_project_snapshots(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    credential_secret_ref: String,
    account_subject: String,
    page_token: Option<String>,
) -> Result<NativeResult<ProjectSnapshotDiscoveryPage>, String> {
    let result = match discovery_account(&app, &state, credential_secret_ref, account_subject).await
    {
        Ok(account) => discover_project_snapshots(&app, &state, &account, page_token).await,
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_capture_start_cursor(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    generation_ref: String,
) -> Result<NativeResult<String>, String> {
    let result = match state.require_generation(&generation_ref) {
        Ok(generation) => start_cursor(&app, &state, &generation).await,
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_list_inventory(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    generation_ref: String,
    page_token: Option<String>,
) -> Result<NativeResult<InventoryPageResult>, String> {
    let result = match state.require_generation(&generation_ref) {
        Ok(generation) => list_inventory(&app, &state, &generation, page_token).await,
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_list_changes(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    generation_ref: String,
    cursor: String,
    page_token: Option<String>,
) -> Result<NativeResult<ChangePageResult>, String> {
    let result = match state.require_generation(&generation_ref) {
        Ok(generation) => list_changes(&app, &state, &generation, cursor, page_token).await,
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_stat_immutable(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    generation_ref: String,
    object_kind: SyncObjectKind,
    logical_key_id: String,
) -> Result<NativeResult<Option<RemoteObject>>, String> {
    let result = match state.require_generation(&generation_ref) {
        Ok(generation) => {
            stat_immutable(&app, &state, &generation, object_kind, &logical_key_id).await
        }
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn google_drive_upload_immutable(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    generation_ref: String,
    source_ref: String,
    object_kind: SyncObjectKind,
    logical_key_id: String,
    stored_sha256: String,
    size_bytes: u64,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
) -> Result<NativeResult<UploadResult>, String> {
    let result = match state.require_generation(&generation_ref) {
        Ok(generation) => {
            let operation = upload_impl(
                app,
                &state,
                generation,
                source_ref,
                object_kind,
                logical_key_id,
                stored_sha256,
                size_bytes,
                transfer_id.clone(),
                on_progress,
            );
            run_transfer(&state, transfer_id, Box::pin(operation)).await
        }
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_download_verified_immutable(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    generation_ref: String,
    object_id: String,
    destination_ref: String,
    expected_stored_sha256: String,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
) -> Result<NativeResult<DownloadResult>, String> {
    let result = match state.require_generation(&generation_ref) {
        Ok(generation) => {
            let operation = download_impl(
                app,
                &state,
                generation,
                object_id,
                destination_ref,
                expected_stored_sha256,
                transfer_id.clone(),
                on_progress,
            );
            run_transfer(&state, transfer_id, Box::pin(operation)).await
        }
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_revoke_account(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    credential_secret_ref: String,
    transfer_id: String,
) -> Result<NativeResult<RevokeAccountResult>, String> {
    let result = match validate_credential_secret_ref(&credential_secret_ref) {
        Ok(()) => {
            let operation = revoke_account_impl(app, &state, credential_secret_ref);
            run_transfer(&state, transfer_id, Box::pin(operation)).await
        }
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) fn google_drive_cancel_transfer(
    state: State<'_, GoogleDriveState>,
    transfer_id: String,
) -> bool {
    if validate_plain_token(&transfer_id, "Transfer ID", 200).is_err() {
        return false;
    }
    let Ok(mut transfers) = state.transfers.lock() else {
        return false;
    };
    if let Some(handle) = transfers.active.remove(&transfer_id) {
        handle.abort();
        return true;
    }
    if transfers.pre_cancelled.len() >= 1024 {
        return false;
    }
    transfers.pre_cancelled.insert(transfer_id)
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn read_oauth_callback_request(
    socket: &mut tokio::net::TcpStream,
) -> Result<Vec<u8>, NativeError> {
    let mut request = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 1024];
    while request.len() < MAX_OAUTH_REQUEST_BYTES {
        let remaining = MAX_OAUTH_REQUEST_BYTES - request.len();
        let read_capacity = remaining.min(chunk.len());
        let read = socket
            .read(&mut chunk[..read_capacity])
            .await
            .map_err(|_| NativeError::invalid("OAuth callback could not be read"))?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(request);
        }
    }
    Err(NativeError::invalid(
        "OAuth callback headers were incomplete or too large",
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn focus_main_window_after_oauth_callback(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn oauth_authorize_desktop(
    app: &AppHandle,
    state: &GoogleDriveState,
) -> Result<GoogleCredentialV1, NativeError> {
    let client_id = desktop_oauth_client_id()?;
    let client_secret = desktop_oauth_client_secret()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| NativeError::configuration("OAuth loopback listener could not start"))?;
    let port = listener
        .local_addr()
        .map_err(|_| NativeError::configuration("OAuth loopback listener is unavailable"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let state_token = random_hex(32)?;
    let mut verifier_bytes = [0_u8; 32];
    getrandom::getrandom(&mut verifier_bytes)
        .map_err(|_| NativeError::configuration("OS CSPRNG is unavailable"))?;
    let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(verifier_bytes));
    verifier_bytes.zeroize();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorization = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|_| NativeError::configuration("Google OAuth endpoint is invalid"))?;
    authorization
        .query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", OAUTH_SCOPES)
        .append_pair("state", &state_token)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    app.opener()
        .open_url(authorization, None::<&str>)
        .map_err(|_| NativeError::configuration("System browser could not open Google OAuth"))?;
    let callback = tokio::time::timeout(OAUTH_TIMEOUT, async {
        loop {
            let (mut socket, peer) = listener
                .accept()
                .await
                .map_err(|_| NativeError::configuration("OAuth loopback callback failed"))?;
            if !peer.ip().is_loopback() {
                continue;
            }
            let request = read_oauth_callback_request(&mut socket).await?;
            let first_line = std::str::from_utf8(&request)
                .ok()
                .and_then(|text| text.lines().next())
                .unwrap_or_default();
            let target = first_line
                .strip_prefix("GET ")
                .and_then(|value| value.split_once(' ').map(|(target, _)| target));
            let Some(target) = target else {
                continue;
            };
            let url = Url::parse(&format!("http://127.0.0.1:{port}{target}"))
                .map_err(|_| NativeError::invalid("OAuth callback URL is invalid"))?;
            if url.path() != "/" {
                continue;
            }
            let pairs = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
            let callback_ok = pairs.get("state") == Some(&state_token)
                && pairs.contains_key("code")
                && !pairs.contains_key("error");
            let body = if callback_ok {
                "<!doctype html><title>Drifting</title>You may return to Drifting now."
            } else {
                "OAuth callback rejected"
            };
            let status = if callback_ok {
                "200 OK"
            } else {
                "400 Bad Request"
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            if pairs.get("state") == Some(&state_token) {
                focus_main_window_after_oauth_callback(app);
            }
            if pairs.get("state") != Some(&state_token) {
                return Err(NativeError::invalid("OAuth state validation failed"));
            }
            if pairs.contains_key("error") {
                return Err(NativeError::new(
                    NativeErrorCode::NeedsReauth,
                    "Google OAuth authorization was denied",
                    false,
                ));
            }
            return pairs
                .get("code")
                .cloned()
                .ok_or_else(|| NativeError::invalid("OAuth callback omitted its code"));
        }
    })
    .await
    .map_err(|_| NativeError::new(NativeErrorCode::Cancelled, "Google OAuth timed out", false))??;
    let client = state.client()?;
    let response = send_http(
        state,
        client.post(GOOGLE_TOKEN_URL).form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", callback.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ]),
    )
    .await?;
    if !response.status().is_success() {
        return Err(oauth_token_response_error(response).await);
    }
    let token: TokenResponse = parse_json(response).await?;
    let refresh_token = token.refresh_token.ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::NeedsReauth,
            "Google OAuth returned no durable refresh credential",
            false,
        )
    })?;
    let access_token = Zeroizing::new(token.access_token);
    let response = send_http(
        state,
        client
            .get(GOOGLE_USERINFO_URL)
            .bearer_auth(access_token.as_str()),
    )
    .await?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let user: UserInfoResponse = parse_json(response).await?;
    validate_plain_token(&user.sub, "Google account subject", 255)
        .map_err(|_| NativeError::corrupt("Google account identity is malformed"))?;
    let credential = GoogleCredentialV1 {
        protocol: "drifting.google-drive.credentials".into(),
        version: 1,
        account_subject: user.sub.clone(),
        ownership: CREDENTIAL_OWNERSHIP_PROVISIONAL.into(),
        material: GoogleCredentialMaterialV1::DesktopRefreshToken(DesktopRefreshCredentialV1 {
            client_id: client_id.into(),
            access_token: access_token.to_string(),
            refresh_token,
            expires_at_ms: now_ms().saturating_add(token.expires_in.saturating_mul(1000)),
        }),
    };
    Ok(credential)
}

fn oauth_result_for_credential(credential: &GoogleCredentialV1) -> OAuthConnectResult {
    OAuthConnectResult {
        credential_secret_ref: GOOGLE_APP_CREDENTIAL_SECRET_REF.into(),
        account_subject: credential.account_subject.clone(),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn oauth_connect_desktop(
    app: AppHandle,
    state: &GoogleDriveState,
) -> Result<OAuthConnectResult, NativeError> {
    let _guard = state.refresh_lock.lock().await;
    let app_for_read = app.clone();
    let existing = tauri::async_runtime::spawn_blocking(move || {
        read_optional_credentials(&app_for_read, GOOGLE_APP_CREDENTIAL_SECRET_REF)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    if let Some(existing) = existing {
        let GoogleCredentialMaterialV1::DesktopRefreshToken(material) = &existing.material else {
            return Err(NativeError::configuration(
                "Google Drive credential source does not match this platform",
            ));
        };
        validate_desktop_material_for_build(material)?;
        state.cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &existing)?;
        // A provisional value is an OAuth result whose SQLite owner may not
        // have committed before a crash. A claimed value can likewise outlive
        // a deliberately reset development database. Both are reused and can
        // only be replaced after explicit, successful revocation.
        return Ok(oauth_result_for_credential(&existing));
    }
    let credential = oauth_authorize_desktop(&app, state).await?;
    let result = oauth_result_for_credential(&credential);
    let credential_for_cache = credential.clone();
    let app_for_write = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_credentials(
            &app_for_write,
            GOOGLE_APP_CREDENTIAL_SECRET_REF,
            &credential,
        )
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    state.cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &credential_for_cache)?;
    Ok(result)
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn mobile_credential(account_subject: String, client_id: &str) -> GoogleCredentialV1 {
    GoogleCredentialV1 {
        protocol: "drifting.google-drive.credentials".into(),
        version: 1,
        account_subject,
        ownership: CREDENTIAL_OWNERSHIP_PROVISIONAL.into(),
        material: GoogleCredentialMaterialV1::MobileSdkAccount(MobileSdkCredentialV1 {
            platform: MOBILE_OAUTH_PLATFORM.into(),
            client_id: client_id.into(),
        }),
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
async fn oauth_connect_mobile(
    app: AppHandle,
    state: &GoogleDriveState,
) -> Result<OAuthConnectResult, NativeError> {
    let client_id = mobile_oauth_client_id()?;
    #[cfg(target_os = "ios")]
    ios_reversed_client_id()?;

    let _guard = state.refresh_lock.lock().await;
    let app_for_read = app.clone();
    let existing = tauri::async_runtime::spawn_blocking(move || {
        read_optional_credentials(&app_for_read, GOOGLE_APP_CREDENTIAL_SECRET_REF)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    if let Some(existing) = existing {
        let GoogleCredentialMaterialV1::MobileSdkAccount(material) = &existing.material else {
            return Err(NativeError::configuration(
                "Google Drive credential source does not match this platform",
            ));
        };
        validate_mobile_material_for_build(material)?;
        state.cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &existing)?;
        return Ok(oauth_result_for_credential(&existing));
    }

    let response = app
        .drifting_google_drive_oauth()
        .authorize(client_id, None)
        .await
        .map_err(|_| {
            NativeError::configuration("The official Google OAuth client is unavailable")
        })?;
    let (account_subject, access_token) = consume_mobile_oauth_response(response, None)?;
    // AuthorizationClient / GoogleSignIn owns renewal. The token proves this
    // authorization completed but is never written to Drifting secure storage.
    drop(access_token);
    let credential = mobile_credential(account_subject, client_id);
    let result = oauth_result_for_credential(&credential);
    let credential_for_cache = credential.clone();
    let app_for_write = app;
    tauri::async_runtime::spawn_blocking(move || {
        write_credentials(
            &app_for_write,
            GOOGLE_APP_CREDENTIAL_SECRET_REF,
            &credential,
        )
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    state.cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &credential_for_cache)?;
    Ok(result)
}

async fn commit_claimed_credential<Write, WriteFuture>(
    credential_secret_ref: String,
    account_subject: String,
    mut credential: GoogleCredentialV1,
    write: Write,
) -> Result<OAuthConnectResult, NativeError>
where
    Write: FnOnce(GoogleCredentialV1) -> WriteFuture,
    WriteFuture: Future<Output = Result<(), NativeError>>,
{
    if credential.account_subject != account_subject {
        return Err(NativeError::new(
            NativeErrorCode::AccountMismatch,
            "Google credential ownership selected a different account",
            false,
        ));
    }
    if credential.ownership == CREDENTIAL_OWNERSHIP_PROVISIONAL {
        credential.ownership = CREDENTIAL_OWNERSHIP_CLAIMED.into();
        write(credential).await?;
    } else if credential.ownership != CREDENTIAL_OWNERSHIP_CLAIMED {
        return Err(NativeError::configuration(
            "Google Drive credential ownership is invalid",
        ));
    }
    Ok(OAuthConnectResult {
        credential_secret_ref,
        account_subject,
    })
}

async fn claim_account_native(
    app: AppHandle,
    state: &GoogleDriveState,
    credential_secret_ref: String,
    account_subject: String,
) -> Result<OAuthConnectResult, NativeError> {
    let _guard = state.refresh_lock.lock().await;
    let app_for_read = app.clone();
    let secret_for_read = credential_secret_ref.clone();
    let credential = tauri::async_runtime::spawn_blocking(move || {
        read_credentials(&app_for_read, &secret_for_read)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    validate_credential_material_for_build(&credential)?;
    let credential_for_cache = credential.clone();
    let app_for_write = app;
    let secret_for_write = credential_secret_ref.clone();
    let result = commit_claimed_credential(
        credential_secret_ref,
        account_subject,
        credential,
        move |claimed| async move {
            tauri::async_runtime::spawn_blocking(move || {
                write_credentials(&app_for_write, &secret_for_write, &claimed)
            })
            .await
            .map_err(|_| NativeError::configuration("Secure storage worker failed"))?
        },
    )
    .await?;
    state.cache_access_token(&result.credential_secret_ref, &credential_for_cache)?;
    Ok(result)
}

async fn commit_reauthorized_credential<Write, WriteFuture>(
    credential_secret_ref: String,
    existing: GoogleCredentialV1,
    mut replacement: GoogleCredentialV1,
    write: Write,
) -> Result<OAuthConnectResult, NativeError>
where
    Write: FnOnce(GoogleCredentialV1) -> WriteFuture,
    WriteFuture: Future<Output = Result<(), NativeError>>,
{
    if replacement.account_subject != existing.account_subject {
        return Err(NativeError::new(
            NativeErrorCode::AccountMismatch,
            "Google reauthorization selected a different account",
            false,
        ));
    }
    replacement.ownership = existing.ownership.clone();
    let account_subject = replacement.account_subject.clone();
    write(replacement).await?;
    Ok(OAuthConnectResult {
        credential_secret_ref,
        account_subject,
    })
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn oauth_reauthorize_desktop(
    app: AppHandle,
    state: &GoogleDriveState,
    credential_secret_ref: String,
) -> Result<OAuthConnectResult, NativeError> {
    let _guard = state.refresh_lock.lock().await;
    state.clear_cached_access_token(&credential_secret_ref)?;
    let app_for_read = app.clone();
    let secret_for_read = credential_secret_ref.clone();
    let existing = tauri::async_runtime::spawn_blocking(move || {
        read_credentials(&app_for_read, &secret_for_read)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    let GoogleCredentialMaterialV1::DesktopRefreshToken(material) = &existing.material else {
        return Err(NativeError::configuration(
            "Google Drive credential source does not match this platform",
        ));
    };
    validate_desktop_material_for_build(material)?;
    let replacement = oauth_authorize_desktop(&app, state).await?;
    let replacement_for_cache = replacement.clone();
    let app_for_write = app;
    let secret_for_write = credential_secret_ref.clone();
    let result = commit_reauthorized_credential(
        credential_secret_ref,
        existing,
        replacement,
        move |credential| async move {
            tauri::async_runtime::spawn_blocking(move || {
                write_credentials(&app_for_write, &secret_for_write, &credential)
            })
            .await
            .map_err(|_| NativeError::configuration("Secure storage worker failed"))?
        },
    )
    .await?;
    state.cache_access_token(&result.credential_secret_ref, &replacement_for_cache)?;
    Ok(result)
}

#[cfg(any(target_os = "ios", target_os = "android"))]
async fn oauth_reauthorize_mobile(
    app: AppHandle,
    state: &GoogleDriveState,
    credential_secret_ref: String,
) -> Result<OAuthConnectResult, NativeError> {
    let client_id = mobile_oauth_client_id()?;
    #[cfg(target_os = "ios")]
    ios_reversed_client_id()?;

    let _guard = state.refresh_lock.lock().await;
    state.clear_cached_access_token(&credential_secret_ref)?;
    let app_for_read = app.clone();
    let secret_for_read = credential_secret_ref.clone();
    let existing = tauri::async_runtime::spawn_blocking(move || {
        read_credentials(&app_for_read, &secret_for_read)
    })
    .await
    .map_err(|_| NativeError::configuration("Secure storage worker failed"))??;
    let GoogleCredentialMaterialV1::MobileSdkAccount(material) = &existing.material else {
        return Err(NativeError::configuration(
            "Google Drive credential source does not match this platform",
        ));
    };
    validate_mobile_material_for_build(material)?;
    let expected_subject = existing.account_subject.clone();
    let response = app
        .drifting_google_drive_oauth()
        .authorize(client_id, Some(&expected_subject))
        .await
        .map_err(|_| {
            NativeError::configuration("The official Google OAuth client is unavailable")
        })?;
    let (account_subject, access_token) =
        consume_mobile_oauth_response(response, Some(&expected_subject))?;
    drop(access_token);
    let replacement = mobile_credential(account_subject, client_id);
    let replacement_for_cache = replacement.clone();
    let app_for_write = app;
    let secret_for_write = credential_secret_ref.clone();
    let result = commit_reauthorized_credential(
        credential_secret_ref,
        existing,
        replacement,
        move |credential| async move {
            tauri::async_runtime::spawn_blocking(move || {
                write_credentials(&app_for_write, &secret_for_write, &credential)
            })
            .await
            .map_err(|_| NativeError::configuration("Secure storage worker failed"))?
        },
    )
    .await?;
    state.cache_access_token(&result.credential_secret_ref, &replacement_for_cache)?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn google_drive_oauth_connect(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
) -> Result<NativeResult<OAuthConnectResult>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let result = oauth_connect_desktop(app, &state).await;

    #[cfg(any(target_os = "ios", target_os = "android"))]
    let result = oauth_connect_mobile(app, &state).await;

    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux",
        target_os = "ios",
        target_os = "android"
    )))]
    let result = {
        let _ = (app, state);
        Err(NativeError::new(
            NativeErrorCode::UnsupportedPlatform,
            "Google Drive OAuth is unsupported on this platform",
            false,
        ))
    };

    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_claim_account(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    credential_secret_ref: String,
    account_subject: String,
) -> Result<NativeResult<OAuthConnectResult>, String> {
    let result = match (
        validate_credential_secret_ref(&credential_secret_ref),
        validate_plain_token(&account_subject, "Google account subject", 255),
    ) {
        (Ok(()), Ok(())) => {
            #[cfg(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux",
                target_os = "ios",
                target_os = "android"
            ))]
            {
                claim_account_native(app, &state, credential_secret_ref, account_subject).await
            }

            #[cfg(not(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux",
                target_os = "ios",
                target_os = "android"
            )))]
            {
                let _ = (app, state, credential_secret_ref, account_subject);
                Err(NativeError::new(
                    NativeErrorCode::UnsupportedPlatform,
                    "Google Drive credential ownership is unsupported on this platform",
                    false,
                ))
            }
        }
        (Err(error), _) | (_, Err(error)) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[tauri::command]
pub(crate) async fn google_drive_oauth_reauthorize(
    app: AppHandle,
    state: State<'_, GoogleDriveState>,
    credential_secret_ref: String,
) -> Result<NativeResult<OAuthConnectResult>, String> {
    let result = match validate_credential_secret_ref(&credential_secret_ref) {
        Ok(()) => {
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            {
                oauth_reauthorize_desktop(app, &state, credential_secret_ref).await
            }

            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                oauth_reauthorize_mobile(app, &state, credential_secret_ref).await
            }

            #[cfg(not(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux",
                target_os = "ios",
                target_os = "android"
            )))]
            {
                let _ = (app, state, credential_secret_ref);
                Err(NativeError::new(
                    NativeErrorCode::UnsupportedPlatform,
                    "Google Drive OAuth is unsupported on this platform",
                    false,
                ))
            }
        }
        Err(error) => Err(error),
    };
    Ok(NativeResult::from_result(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    struct FakeResponse {
        status: u16,
        headers: Vec<(&'static str, &'static str)>,
        body: String,
    }

    #[derive(Default)]
    struct FakeHttpTransport {
        responses: Mutex<VecDeque<FakeResponse>>,
        requests: Mutex<Vec<(String, String, Vec<String>, String)>>,
    }

    impl FakeHttpTransport {
        fn with_responses(responses: impl IntoIterator<Item = FakeResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl DriveHttpTransport for FakeHttpTransport {
        fn send(&self, request: RequestBuilder) -> HttpFuture {
            let request = request.build().expect("fake request builds");
            let body = request
                .body()
                .and_then(reqwest::Body::as_bytes)
                .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                .unwrap_or_default();
            self.requests.lock().unwrap().push((
                request.method().to_string(),
                request.url().path().to_owned(),
                request
                    .headers()
                    .keys()
                    .map(|name| name.as_str().to_owned())
                    .collect(),
                body,
            ));
            let response = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("fake response exists");
            Box::pin(async move {
                let mut builder = http::Response::builder().status(response.status);
                for (name, value) in response.headers {
                    builder = builder.header(name, value);
                }
                Ok(builder
                    .body(response.body)
                    .expect("fake response builds")
                    .into())
            })
        }
    }

    fn drive_file(properties: HashMap<String, String>) -> DriveFile {
        DriveFile {
            id: Some("file-1".into()),
            size: Some("42".into()),
            trashed: Some(false),
            app_properties: Some(properties),
        }
    }

    fn properties() -> HashMap<String, String> {
        HashMap::from([
            (PROP_PROTOCOL.into(), PROTOCOL_VALUE.into()),
            (PROP_SYNC_GENERATION.into(), "generation-a".into()),
            (PROP_KIND.into(), "segment".into()),
            (PROP_LOGICAL.into(), format!("sha256:{}", "a".repeat(64))),
            (PROP_HASH.into(), format!("sha256:{}", "b".repeat(64))),
            (PROP_SIZE.into(), "42".into()),
        ])
    }

    fn credentials() -> GoogleCredentialV1 {
        GoogleCredentialV1 {
            protocol: "drifting.google-drive.credentials".into(),
            version: 1,
            account_subject: "google-subject".into(),
            ownership: CREDENTIAL_OWNERSHIP_PROVISIONAL.into(),
            material: GoogleCredentialMaterialV1::DesktopRefreshToken(DesktopRefreshCredentialV1 {
                client_id: "123456789-test.apps.googleusercontent.com".into(),
                access_token: "native-access-token".into(),
                refresh_token: "native-refresh-token".into(),
                expires_at_ms: now_ms().saturating_add(60_000),
            }),
        }
    }

    fn desktop_material(credential: &GoogleCredentialV1) -> &DesktopRefreshCredentialV1 {
        let GoogleCredentialMaterialV1::DesktopRefreshToken(material) = &credential.material else {
            panic!("test credential must use desktop material")
        };
        material
    }

    fn desktop_material_mut(
        credential: &mut GoogleCredentialV1,
    ) -> &mut DesktopRefreshCredentialV1 {
        let GoogleCredentialMaterialV1::DesktopRefreshToken(material) = &mut credential.material
        else {
            panic!("test credential must use desktop material")
        };
        material
    }

    async fn revoke_with_response(
        response: FakeResponse,
    ) -> (
        Result<RevokeAccountResult, NativeError>,
        usize,
        Arc<FakeHttpTransport>,
    ) {
        let fake = Arc::new(FakeHttpTransport::with_responses([response]));
        let mut state = GoogleDriveState::default();
        state.http = fake.clone();
        let removals = Arc::new(AtomicUsize::new(0));
        let removals_for_call = removals.clone();
        let result = revoke_loaded_credential(&state, Some(credentials()), move || async move {
            removals_for_call.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
        (result, removals.load(Ordering::SeqCst), fake)
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn desktop_access_token_cache_reuses_valid_tokens_and_compares_401_rejections() {
        let state = GoogleDriveState::default();
        let mut credential = credentials();
        desktop_material_mut(&mut credential).expires_at_ms = now_ms().saturating_add(5 * 60_000);
        state
            .cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &credential)
            .unwrap();

        for _ in 0..2 {
            let cached = state
                .cached_access_token_for_request(
                    GOOGLE_APP_CREDENTIAL_SECRET_REF,
                    "google-subject",
                    None,
                )
                .unwrap()
                .expect("valid access token remains memory-resident");
            assert_eq!(cached.as_str(), "native-access-token");
        }

        assert!(state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                Some("native-access-token"),
            )
            .unwrap()
            .is_none());
        assert!(state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                None,
            )
            .unwrap()
            .is_none());

        desktop_material_mut(&mut credential).expires_at_ms = now_ms().saturating_add(5 * 60_000);
        state
            .cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &credential)
            .unwrap();
        let mut replacement = credential.clone();
        desktop_material_mut(&mut replacement).access_token = "replacement-access-token".into();
        state
            .cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &replacement)
            .unwrap();

        let replacement_after_concurrent_refresh = state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                Some("native-access-token"),
            )
            .unwrap()
            .expect("a concurrently refreshed bearer must not be discarded");
        assert_eq!(
            replacement_after_concurrent_refresh.as_str(),
            "replacement-access-token"
        );
        state
            .clear_rejected_access_token(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                "native-access-token",
            )
            .unwrap();
        assert!(state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                None,
            )
            .unwrap()
            .is_some());
        state
            .clear_rejected_access_token(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                "replacement-access-token",
            )
            .unwrap();
        assert!(state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                None,
            )
            .unwrap()
            .is_none());
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn access_token_cache_fails_closed_for_expiry_identity_and_mobile_sdk_material() {
        let state = GoogleDriveState::default();
        let mut credential = credentials();
        desktop_material_mut(&mut credential).expires_at_ms = now_ms().saturating_add(5 * 60_000);
        state
            .cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &credential)
            .unwrap();

        let mismatch = state.cached_access_token_for_request(
            GOOGLE_APP_CREDENTIAL_SECRET_REF,
            "another-google-subject",
            None,
        );
        assert!(matches!(
            mismatch,
            Err(NativeError {
                code: NativeErrorCode::NeedsReauth,
                ..
            })
        ));
        assert!(state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                None,
            )
            .unwrap()
            .is_none());

        desktop_material_mut(&mut credential).expires_at_ms = now_ms().saturating_add(30_000);
        state
            .cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &credential)
            .unwrap();
        assert!(state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                None,
            )
            .unwrap()
            .is_none());

        desktop_material_mut(&mut credential).expires_at_ms = now_ms().saturating_add(5 * 60_000);
        state
            .cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &credential)
            .unwrap();
        let mobile = GoogleCredentialV1 {
            protocol: "drifting.google-drive.credentials".into(),
            version: 1,
            account_subject: "google-subject".into(),
            ownership: CREDENTIAL_OWNERSHIP_CLAIMED.into(),
            material: GoogleCredentialMaterialV1::MobileSdkAccount(MobileSdkCredentialV1 {
                platform: "ios".into(),
                client_id: "123456789-mobile.apps.googleusercontent.com".into(),
            }),
        };
        state
            .cache_access_token(GOOGLE_APP_CREDENTIAL_SECRET_REF, &mobile)
            .unwrap();
        assert!(state
            .cached_access_token_for_request(
                GOOGLE_APP_CREDENTIAL_SECRET_REF,
                "google-subject",
                None,
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn metadata_is_fail_closed_and_ignores_unrelated_app_files() {
        assert!(parse_drive_file(
            DriveFile {
                id: Some("foreign".into()),
                size: Some("1".into()),
                trashed: Some(false),
                app_properties: None,
            },
            "generation-a"
        )
        .unwrap()
        .is_none());

        let parsed = parse_drive_file(drive_file(properties()), "generation-a")
            .unwrap()
            .unwrap();
        assert_eq!(parsed.size_bytes, 42);

        let mut malformed = properties();
        malformed.insert(PROP_SIZE.into(), "41".into());
        assert!(matches!(
            parse_drive_file(drive_file(malformed), "generation-a"),
            Err(NativeError {
                code: NativeErrorCode::RemoteCorrupt,
                ..
            })
        ));

        let mut empty = properties();
        empty.insert(PROP_SIZE.into(), "0".into());
        let mut empty_file = drive_file(empty);
        empty_file.size = Some("0".into());
        assert!(matches!(
            parse_drive_file(empty_file, "generation-a"),
            Err(NativeError {
                code: NativeErrorCode::RemoteCorrupt,
                ..
            })
        ));

        let mut future_other_generation = properties();
        future_other_generation.insert(PROP_PROTOCOL.into(), "object-v2".into());
        future_other_generation.insert(PROP_SYNC_GENERATION.into(), "generation-b".into());
        assert!(
            parse_drive_file(drive_file(future_other_generation), "generation-a")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn changes_fake_materializes_unparseable_known_file_ids_as_removed() {
        let valid_properties = properties();
        let mut malformed_properties = properties();
        malformed_properties.insert(PROP_LOGICAL.into(), "malformed".into());
        let wire = serde_json::json!({
            "changes": [
                {
                    "fileId": "known-present",
                    "removed": false,
                    "file": {
                        "id": "known-present",
                        "size": "42",
                        "trashed": false,
                        "appProperties": valid_properties
                    }
                },
                {
                    "fileId": "known-trashed",
                    "removed": false,
                    "file": {
                        "id": "known-trashed",
                        "size": "42",
                        "trashed": true,
                        "appProperties": properties()
                    }
                },
                {
                    "fileId": "known-metadata-lost",
                    "removed": false,
                    "file": {
                        "id": "known-metadata-lost",
                        "size": "42",
                        "trashed": false
                    }
                },
                {
                    "fileId": "known-malformed",
                    "removed": false,
                    "file": {
                        "id": "known-malformed",
                        "size": "42",
                        "trashed": false,
                        "appProperties": malformed_properties
                    }
                },
                {
                    "fileId": "known-explicit-removal",
                    "removed": true
                }
            ],
            "newStartPageToken": "next-cursor"
        });
        let page: ChangeList = serde_json::from_value(wire).unwrap();
        let parsed = parse_drive_changes(page.changes, "generation-a").unwrap();
        assert_eq!(parsed.len(), 5);
        assert!(matches!(
            &parsed[0],
            RemoteChange::Present { object } if object.object_id == "known-present"
        ));
        for (index, object_id) in [
            "known-trashed",
            "known-metadata-lost",
            "known-malformed",
            "known-explicit-removal",
        ]
        .into_iter()
        .enumerate()
        {
            assert!(matches!(
                &parsed[index + 1],
                RemoteChange::Removed {
                    object_id: removed_id,
                    logical_key_id: None,
                } if removed_id == object_id
            ));
        }
    }

    #[test]
    fn account_inventory_identifies_only_project_snapshots_before_binding() {
        let mut snapshot = properties();
        snapshot.insert(PROP_KIND.into(), "snapshot-commit".into());
        let candidate = parse_drive_project_snapshot(drive_file(snapshot))
            .unwrap()
            .unwrap();
        assert_eq!(candidate.sync_generation_id, "generation-a");
        assert_eq!(candidate.object.object_kind, SyncObjectKind::SnapshotCommit);

        assert!(parse_drive_project_snapshot(drive_file(properties()))
            .unwrap()
            .is_none());
        let mut malformed = properties();
        malformed.insert(PROP_KIND.into(), "snapshot-commit".into());
        malformed.remove(PROP_LOGICAL);
        assert!(matches!(
            parse_drive_project_snapshot(drive_file(malformed)),
            Err(NativeError {
                code: NativeErrorCode::RemoteCorrupt,
                ..
            })
        ));
    }

    #[test]
    fn resumable_ranges_are_strict_and_use_eight_mib_chunks() {
        assert_eq!(RESUMABLE_CHUNK_BYTES % (256 * 1024), 0);
        let headers = HeaderMap::from_iter([(RANGE, HeaderValue::from_static("bytes=0-8388607"))]);
        assert_eq!(upload_range(&headers, 20_000_000).unwrap(), 8_388_608);

        let invalid = HeaderMap::from_iter([(RANGE, HeaderValue::from_static("bytes=1-8388607"))]);
        assert!(upload_range(&invalid, 20_000_000).is_err());
    }

    #[test]
    fn status_mapping_distinguishes_permission_rate_quota_and_retry_after() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("17"));
        assert_eq!(retry_after_ms(&headers), Some(17_000));

        let rate = NativeError::new(NativeErrorCode::RateLimited, "rate", true)
            .retry_after(retry_after_ms(&headers));
        assert!(rate.retryable);
        assert_eq!(rate.retry_after_ms, Some(17_000));

        let permission = NativeError::new(NativeErrorCode::PermissionDenied, "permission", false);
        assert!(!permission.retryable);
    }

    #[test]
    fn injectable_http_fake_exercises_sanitized_quota_mapping() {
        tauri::async_runtime::block_on(async {
            let fake = Arc::new(FakeHttpTransport::with_responses([
                FakeResponse {
                    status: 403,
                    headers: vec![("retry-after", "23")],
                    body: r#"{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}"#.into(),
                },
                FakeResponse {
                    status: 403,
                    headers: vec![],
                    body: r#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#.into(),
                },
                FakeResponse {
                    status: 403,
                    headers: vec![],
                    body: r#"{"error":{"errors":[{"reason":"insufficientPermissions"}]}}"#.into(),
                },
                FakeResponse {
                    status: 408,
                    headers: vec![("retry-after", "5")],
                    body: r#"{"error":{"message":"request timed out"}}"#.into(),
                },
            ]));
            let mut state = GoogleDriveState::default();
            state.http = fake.clone();
            let client = state.client().unwrap();
            let request = || {
                client
                    .get("https://www.googleapis.com/drive/v3/files")
                    .bearer_auth("native-only-secret")
            };
            let response = state.http.send(request()).await.unwrap();
            let error = response_error(response).await;
            assert_eq!(error.code, NativeErrorCode::QuotaExceeded);
            assert_eq!(error.retry_after_ms, Some(23_000));
            assert!(error.retryable);

            let rate = response_error(state.http.send(request()).await.unwrap()).await;
            assert_eq!(rate.code, NativeErrorCode::RateLimited);
            assert!(rate.retryable);

            let permission = response_error(state.http.send(request()).await.unwrap()).await;
            assert_eq!(permission.code, NativeErrorCode::PermissionDenied);
            assert!(!permission.retryable);

            let timeout = response_error(state.http.send(request()).await.unwrap()).await;
            assert_eq!(timeout.code, NativeErrorCode::Transient);
            assert!(timeout.retryable);
            assert_eq!(timeout.retry_after_ms, Some(5_000));

            let requests = fake.requests.lock().unwrap();
            assert_eq!(requests.len(), 4);
            assert_eq!(requests[0].0, "GET");
            assert_eq!(requests[0].1, "/drive/v3/files");
            assert!(requests[0].2.iter().any(|name| name == "authorization"));
            assert!(!format!("{requests:?}").contains("native-only-secret"));
        });
    }

    #[test]
    fn oauth_token_errors_preserve_safe_codes_without_provider_details() {
        tauri::async_runtime::block_on(async {
            let fake = Arc::new(FakeHttpTransport::with_responses([
                FakeResponse {
                    status: 400,
                    headers: vec![],
                    body: r#"{"error":"invalid_grant","error_description":"authorization code value must stay native"}"#.into(),
                },
                FakeResponse {
                    status: 400,
                    headers: vec![],
                    body: r#"{"error":"redirect_uri_mismatch"}"#.into(),
                },
                FakeResponse {
                    status: 400,
                    headers: vec![],
                    body: r#"{"error":"provider_private_detail","error_description":"must not escape"}"#.into(),
                },
            ]));
            let mut state = GoogleDriveState::default();
            state.http = fake;
            let client = state.client().unwrap();
            let request = || client.post(GOOGLE_TOKEN_URL);

            let invalid_grant =
                oauth_token_response_error(state.http.send(request()).await.unwrap()).await;
            assert_eq!(invalid_grant.code, NativeErrorCode::NeedsReauth);
            assert!(invalid_grant.message.contains("invalid_grant"));
            assert!(!invalid_grant.message.contains("authorization code value"));

            let redirect =
                oauth_token_response_error(state.http.send(request()).await.unwrap()).await;
            assert_eq!(redirect.code, NativeErrorCode::ConfigurationRequired);
            assert!(redirect.message.contains("redirect_uri_mismatch"));

            let unknown =
                oauth_token_response_error(state.http.send(request()).await.unwrap()).await;
            assert_eq!(unknown.code, NativeErrorCode::InvalidRequest);
            assert_eq!(
                unknown.message,
                "Google OAuth token exchange failed (HTTP 400)"
            );
        });
    }

    #[test]
    fn revoke_is_idempotent_and_deletes_only_after_a_remote_terminal_result() {
        tauri::async_runtime::block_on(async {
            let (revoked, removed, fake) = revoke_with_response(FakeResponse {
                status: 200,
                headers: vec![],
                body: String::new(),
            })
            .await;
            assert_eq!(revoked.unwrap().status, RevokeAccountStatus::Revoked);
            assert_eq!(removed, 1);
            let requests = fake.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].0, "POST");
            assert_eq!(requests[0].1, "/revoke");
            assert!(requests[0].2.iter().any(|name| name == "content-type"));
            assert_eq!(requests[0].3, "token=native-refresh-token");
            assert!(!requests[0].2.iter().any(|name| name == "authorization"));
            drop(requests);

            let (already_revoked, removed, _) = revoke_with_response(FakeResponse {
                status: 400,
                headers: vec![],
                body: r#"{"error":"invalid_token","error_description":"expired"}"#.into(),
            })
            .await;
            assert_eq!(
                already_revoked.unwrap().status,
                RevokeAccountStatus::AlreadyRevoked
            );
            assert_eq!(removed, 1);

            let state = GoogleDriveState::default();
            let removals = Arc::new(AtomicUsize::new(0));
            let removals_for_call = removals.clone();
            let missing = revoke_loaded_credential(&state, None, move || async move {
                removals_for_call.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap();
            assert_eq!(missing.status, RevokeAccountStatus::AlreadyMissing);
            assert_eq!(removals.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn revoke_keeps_the_secret_for_invalid_requests_and_retryable_failures() {
        tauri::async_runtime::block_on(async {
            let (invalid, removed, _) = revoke_with_response(FakeResponse {
                status: 400,
                headers: vec![],
                body: r#"{"error":"invalid_request"}"#.into(),
            })
            .await;
            assert!(matches!(
                invalid,
                Err(NativeError {
                    code: NativeErrorCode::InvalidRequest,
                    retryable: false,
                    ..
                })
            ));
            assert_eq!(removed, 0);

            let (unavailable, removed, _) = revoke_with_response(FakeResponse {
                status: 503,
                headers: vec![("retry-after", "11")],
                body: String::new(),
            })
            .await;
            assert!(matches!(
                unavailable,
                Err(NativeError {
                    code: NativeErrorCode::Transient,
                    retryable: true,
                    retry_after_ms: Some(11_000),
                    ..
                })
            ));
            assert_eq!(removed, 0);
        });
    }

    #[test]
    fn credential_references_are_native_generated_and_namespace_confined() {
        assert!(validate_credential_secret_ref(GOOGLE_APP_CREDENTIAL_SECRET_REF).is_ok());
        for invalid in [
            "renderer.byok.google",
            "sync.google-drive.credentials.opaque",
            "sync.google-drive.credentials.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "sync.google-drive.credentials.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(validate_credential_secret_ref(invalid).is_err());
        }
    }

    #[test]
    fn mobile_credential_material_contains_only_sdk_binding_and_ownership() {
        let credential = GoogleCredentialV1 {
            protocol: "drifting.google-drive.credentials".into(),
            version: 1,
            account_subject: "stable-google-subject".into(),
            ownership: CREDENTIAL_OWNERSHIP_PROVISIONAL.into(),
            material: GoogleCredentialMaterialV1::MobileSdkAccount(MobileSdkCredentialV1 {
                platform: "ios".into(),
                client_id: "123456789-mobile.apps.googleusercontent.com".into(),
            }),
        };
        let serialized = serde_json::to_string(&credential).unwrap();
        assert!(serialized.contains("mobile-sdk-account"));
        assert!(serialized.contains("stable-google-subject"));
        for forbidden in [
            "accessToken",
            "refreshToken",
            "expiresAtMs",
            "email",
            "sessionUri",
        ] {
            assert!(!serialized.contains(forbidden));
        }
        assert!(matches!(
            decode_credentials(&serialized).unwrap().material,
            GoogleCredentialMaterialV1::MobileSdkAccount(_)
        ));

        let old_shape = serde_json::json!({
            "protocol": "drifting.google-drive.credentials",
            "version": 1,
            "accountSubject": "stable-google-subject",
            "ownership": CREDENTIAL_OWNERSHIP_PROVISIONAL,
            "clientId": "123456789-mobile.apps.googleusercontent.com",
            "accessToken": "must-not-migrate",
            "refreshToken": "must-not-migrate",
            "expiresAtMs": 1
        });
        assert!(decode_credentials(&old_shape.to_string()).is_err());
    }

    #[test]
    fn native_revoke_diagnostics_serialize_only_structured_safe_fields() {
        let diagnostics = NativeOperationDiagnostics {
            schema_version: 1,
            operation: "revoke".into(),
            platform: "ios".into(),
            phase: "disconnect-revoke-request".into(),
            elapsed_ms: 125,
            completed_phases: vec!["rust-mobile-plugin-invoked".into()],
            error_chain: vec![NativeDiagnosticError {
                family: "network".into(),
                domain: "ns-url".into(),
                code: -1001,
                reason: Some("timeout".into()),
                http_status: None,
            }],
        };
        let serialized = serde_json::to_string(&NativeResult::<()>::from_result(Err(
            NativeError::transient("Google OAuth failed temporarily").diagnostics(diagnostics),
        )))
        .unwrap();
        assert!(serialized.contains("disconnect-revoke-request"));
        assert!(serialized.contains("ns-url"));
        assert!(serialized.contains("-1001"));
        for forbidden in [
            "accessToken",
            "refreshToken",
            "accountSubject",
            "localizedDescription",
            "userInfo",
            "/Users/example/",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn ios_build_config_requires_exact_reversed_client_id() {
        let client_id = "123456789-mobile.apps.googleusercontent.com";
        let reversed = "com.googleusercontent.apps.123456789-mobile";
        assert_eq!(reversed_google_oauth_client_id(client_id), reversed);
        assert!(valid_ios_oauth_build_config(client_id, reversed));
        assert!(!valid_ios_oauth_build_config(client_id, "drifting"));
        assert!(!valid_ios_oauth_build_config(
            "not-a-google-client",
            reversed
        ));
    }

    #[test]
    fn desktop_oauth_build_secret_is_nonempty_and_native_safe() {
        assert!(valid_google_oauth_client_secret(
            "GOCSPX-native-installed-app-value"
        ));
        assert!(!valid_google_oauth_client_secret(""));
        assert!(!valid_google_oauth_client_secret("contains whitespace"));
    }

    #[test]
    fn provisional_credential_claim_is_idempotent_and_account_bound() {
        tauri::async_runtime::block_on(async {
            let reference = GOOGLE_APP_CREDENTIAL_SECRET_REF.to_string();
            let writes = Arc::new(AtomicUsize::new(0));
            let writes_for_call = writes.clone();
            let claimed = commit_claimed_credential(
                reference.clone(),
                "google-subject".into(),
                credentials(),
                move |credential| async move {
                    assert_eq!(credential.ownership, CREDENTIAL_OWNERSHIP_CLAIMED);
                    writes_for_call.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert_eq!(claimed.credential_secret_ref, reference);
            assert_eq!(writes.load(Ordering::SeqCst), 1);

            let mut already_claimed = credentials();
            already_claimed.ownership = CREDENTIAL_OWNERSHIP_CLAIMED.into();
            let writes_for_retry = writes.clone();
            commit_claimed_credential(
                GOOGLE_APP_CREDENTIAL_SECRET_REF.into(),
                "google-subject".into(),
                already_claimed,
                move |_| async move {
                    writes_for_retry.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert_eq!(writes.load(Ordering::SeqCst), 1);

            let mismatch = commit_claimed_credential(
                GOOGLE_APP_CREDENTIAL_SECRET_REF.into(),
                "another-google-subject".into(),
                credentials(),
                |_| async { Ok(()) },
            )
            .await;
            assert!(matches!(
                mismatch,
                Err(NativeError {
                    code: NativeErrorCode::AccountMismatch,
                    ..
                })
            ));
        });
    }

    #[test]
    fn reauthorize_overwrites_only_after_same_account_validation() {
        tauri::async_runtime::block_on(async {
            let mut old = credentials();
            old.ownership = CREDENTIAL_OWNERSHIP_CLAIMED.into();
            let mut replacement = credentials();
            desktop_material_mut(&mut replacement).access_token = "replacement-access-token".into();
            desktop_material_mut(&mut replacement).refresh_token =
                "replacement-refresh-token".into();
            let stored = Arc::new(Mutex::new(old.clone()));
            let stored_for_write = stored.clone();
            let result = commit_reauthorized_credential(
                GOOGLE_APP_CREDENTIAL_SECRET_REF.into(),
                old,
                replacement,
                move |credential| async move {
                    *stored_for_write.lock().unwrap() = credential;
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert_eq!(result.account_subject, "google-subject");
            assert_eq!(
                desktop_material(&stored.lock().unwrap()).refresh_token,
                "replacement-refresh-token"
            );
            assert_eq!(
                stored.lock().unwrap().ownership,
                CREDENTIAL_OWNERSHIP_CLAIMED
            );

            let old = credentials();
            let mut wrong_account = credentials();
            wrong_account.account_subject = "another-google-subject".into();
            let stored = Arc::new(Mutex::new(old.clone()));
            let stored_for_write = stored.clone();
            let mismatch = commit_reauthorized_credential(
                GOOGLE_APP_CREDENTIAL_SECRET_REF.into(),
                old.clone(),
                wrong_account,
                move |credential| async move {
                    *stored_for_write.lock().unwrap() = credential;
                    Ok(())
                },
            )
            .await;
            assert!(matches!(
                mismatch,
                Err(NativeError {
                    code: NativeErrorCode::AccountMismatch,
                    retryable: false,
                    ..
                })
            ));
            assert_eq!(
                desktop_material(&stored.lock().unwrap()).refresh_token,
                desktop_material(&old).refresh_token
            );

            let stored = Arc::new(Mutex::new(credentials()));
            let before = desktop_material(&stored.lock().unwrap())
                .refresh_token
                .clone();
            let write_failure = commit_reauthorized_credential(
                GOOGLE_APP_CREDENTIAL_SECRET_REF.into(),
                credentials(),
                credentials(),
                move |_credential| async move {
                    Err(NativeError::configuration("secure storage write failed"))
                },
            )
            .await;
            assert!(write_failure.is_err());
            assert_eq!(
                desktop_material(&stored.lock().unwrap()).refresh_token,
                before
            );
        });
    }

    #[test]
    fn renderer_visible_shapes_never_contain_tokens_sessions_or_paths() {
        let object = RemoteObject {
            object_id: "drive-file".into(),
            object_kind: SyncObjectKind::Blob,
            logical_key_id: format!("sha256:{}", "a".repeat(64)),
            stored_sha256: format!("sha256:{}", "b".repeat(64)),
            size_bytes: 10,
        };
        let serialized = serde_json::to_string(&NativeResult::from_result(Ok(object))).unwrap();
        for forbidden in ["accessToken", "refreshToken", "sessionUri", "filePath"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn generation_wire_shapes_use_current_names() {
        let opened = serde_json::to_value(OpenGenerationResult {
            generation_ref: "syncdrive:opaque".into(),
            sync_generation_id: "generation-a".into(),
        })
        .unwrap();
        assert_eq!(
            opened,
            serde_json::json!({
                "generationRef": "syncdrive:opaque",
                "syncGenerationId": "generation-a"
            })
        );

        let candidate = serde_json::to_value(ProjectSnapshotCandidate {
            sync_generation_id: "generation-a".into(),
            object: RemoteObject {
                object_id: "snapshot-file".into(),
                object_kind: SyncObjectKind::SnapshotCommit,
                logical_key_id: format!("sha256:{}", "a".repeat(64)),
                stored_sha256: format!("sha256:{}", "b".repeat(64)),
                size_bytes: 10,
            },
        })
        .unwrap();
        assert_eq!(candidate["syncGenerationId"], "generation-a");
        assert_eq!(candidate["object"]["objectKind"], "snapshot-commit");
        assert_eq!(candidate.as_object().unwrap().len(), 2);
    }
}
