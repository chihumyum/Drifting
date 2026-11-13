//! Object-log HTTP protocol (`loro-v2`), origin validation, verified streaming
//! transfers, cancellation and quota checks.
//!
//! Per Decision D6, Hosted Sync v2 reuses the immutable object-log HTTP
//! contract under a dedicated namespace (`loro-v2`) so the server stores opaque
//! objects (Loro update batches, snapshots, purge tombstones and asset variant
//! blobs) without inspecting document schemas.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Once;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

/// Object-log namespace for Loro v2 sync objects (`/api/sync/v1/loro-v2/...`).
pub const SYNC_NAMESPACE_LORO_V2: &str = "loro-v2";

/// Capability header sent on every Hosted Sync request.
pub const SYNC_CAPABILITIES_HEADER: &str = "X-Drifting-Sync-Capabilities";

/// Capability header value advertising tombstone/removal support.
pub const SYNC_CAPABILITIES_VALUE: &str = "removals-v1";

/// Content digest header (`sha256:<hex>`).
pub const CONTENT_SHA256_HEADER: &str = "X-Content-Sha256";

/// Metadata header carrying base64url-encoded JSON [`RemoteObjectPayload`].
pub const OBJECT_META_HEADER: &str = "X-Drifting-Object-Meta";

/// Maximum size of a single sync object (64 MiB).
pub const MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;

/// Default Hosted Sync soft quota (500 MiB).
pub const DEFAULT_QUOTA_BYTES: u64 = 500 * 1024 * 1024;

/// Default Hosted Sync hard limit (1 GiB).
pub const DEFAULT_HARD_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;

static PART_COUNTER: AtomicU64 = AtomicU64::new(1);

fn ensure_rustls_provider() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Errors produced by the Hosted Sync v2 protocol and engine.
#[derive(Debug, Error)]
pub enum SyncError {
    #[error("invalid sync origin: {0}")]
    InvalidOrigin(String),

    #[error("invalid sync path: {0}")]
    InvalidPath(String),

    #[error("integrity mismatch (expected {expected}, got {actual})")]
    IntegrityMismatch { expected: String, actual: String },

    #[error("sync object size {size} exceeds limit {limit}")]
    ObjectTooLarge { size: u64, limit: u64 },

    #[error("sync transfer cancelled")]
    Cancelled,

    #[error("sync session unauthorized or expired")]
    Unauthorized,

    #[error("cloud storage quota exceeded ({used_bytes} / {quota_bytes} bytes)")]
    QuotaExceeded {
        used_bytes: u64,
        quota_bytes: u64,
        hard_limit_bytes: u64,
    },

    #[error("sync network offline or unreachable: {0}")]
    Offline(String),

    #[error("sync server error ({status}): {message}")]
    Server {
        status: u16,
        code: Option<String>,
        message: String,
    },

    /// The remote update in feed record `seq` builds on operations of
    /// `doc_id` this device does not have. It was neither acknowledged nor
    /// passed: the record is fetched again (see `SyncEngine`).
    #[error("remote update {seq} for {doc_id} depends on changes this device does not have yet")]
    MissingDependencies { doc_id: String, seq: u64 },

    #[error("store error: {0}")]
    Store(#[from] dr_store::StoreError),

    #[error("loro error: {0}")]
    Loro(#[from] loro::LoroError),

    #[error("loro encode error: {0}")]
    LoroEncode(#[from] loro::LoroEncodeError),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl SyncError {
    /// Whether this error indicates an expired or invalid session token (HTTP 401).
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }

    /// Whether this error indicates the account's cloud storage quota is full.
    pub fn is_quota_exceeded(&self) -> bool {
        matches!(self, Self::QuotaExceeded { .. })
    }

    /// Whether this error represents a transport/offline failure.
    pub fn is_offline(&self) -> bool {
        matches!(self, Self::Offline(_))
    }
}

/// Hosted account storage usage returned by `GET /api/sync/v1/usage`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedUsage {
    pub used_bytes: u64,
    #[serde(default = "default_quota_bytes")]
    pub quota_bytes: u64,
    #[serde(default = "default_hard_limit_bytes")]
    pub hard_limit_bytes: u64,
}

fn default_quota_bytes() -> u64 {
    DEFAULT_QUOTA_BYTES
}

fn default_hard_limit_bytes() -> u64 {
    DEFAULT_HARD_LIMIT_BYTES
}

impl Default for HostedUsage {
    fn default() -> Self {
        Self {
            used_bytes: 0,
            quota_bytes: DEFAULT_QUOTA_BYTES,
            hard_limit_bytes: DEFAULT_HARD_LIMIT_BYTES,
        }
    }
}

/// Check whether importing or queueing a new asset of `incoming_asset_bytes`
/// stays within the account's soft quota (`quota_bytes`, 500 MiB by default).
///
/// Prose/Loro document updates are never blocked by this client preflight; the
/// server still enforces `quota_bytes` / `hard_limit_bytes` (1 GiB).
pub fn check_asset_quota(
    usage: &HostedUsage,
    pending_upload_bytes: u64,
    incoming_asset_bytes: u64,
) -> Result<(), SyncError> {
    let projected = usage
        .used_bytes
        .saturating_add(pending_upload_bytes)
        .saturating_add(incoming_asset_bytes);
    if projected > usage.quota_bytes {
        return Err(SyncError::QuotaExceeded {
            used_bytes: projected,
            quota_bytes: usage.quota_bytes,
            hard_limit_bytes: usage.hard_limit_bytes,
        });
    }
    Ok(())
}

/// Kind and opaque metadata of an immutable object stored in the `loro-v2`
/// object log.
///
/// Document IDs (`doc_id`) and document kinds (`kind`) are opaque strings:
/// book catalog documents, chapters, v3 item trees and Agent conversations all
/// travel as [`RemoteObjectPayload::LoroUpdate`] without hardcoding document
/// kinds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteObjectPayload {
    /// An incremental Loro update batch or snapshot for `doc_id`.
    #[serde(rename_all = "camelCase")]
    LoroUpdate {
        doc_id: String,
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        book_id: Option<String>,
        /// Base64url-encoded `VersionVector` after applying this batch.
        vv_base64: String,
        #[serde(default)]
        is_snapshot: bool,
    },
    /// An immutable asset variant file belonging to `book_id`.
    #[serde(rename_all = "camelCase")]
    AssetBlob {
        asset_id: String,
        book_id: String,
        variant: String,
        mime: String,
        ext: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u32>,
    },
    /// A document purge tombstone (`removals-v1`).
    #[serde(rename_all = "camelCase")]
    DocPurge {
        doc_id: String,
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        book_id: Option<String>,
        purged_ms: i64,
    },
}

/// Metadata record for a stored object in `/api/sync/v1/loro-v2/changes`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteObjectRecord {
    pub seq: u64,
    pub object_key: String,
    pub sha256: String,
    pub byte_length: u64,
    pub created_at: String,
    pub payload: RemoteObjectPayload,
}

/// Paginated response from `GET /api/sync/v1/loro-v2/changes`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesPage {
    pub changes: Vec<RemoteObjectRecord>,
    pub next_cursor: u64,
    pub has_more: bool,
}

/// Compute the canonical `sha256:<lowercase-hex>` digest of `bytes`.
pub fn sha256_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Verify that `bytes` stay within [`MAX_OBJECT_BYTES`], match `expected_byte_length`
/// (if provided), and match `expected_sha256`.
pub fn verify_payload_integrity(
    bytes: &[u8],
    expected_sha256: &str,
    expected_byte_length: Option<u64>,
) -> Result<(), SyncError> {
    let actual_len = bytes.len() as u64;
    if actual_len > MAX_OBJECT_BYTES {
        return Err(SyncError::ObjectTooLarge {
            size: actual_len,
            limit: MAX_OBJECT_BYTES,
        });
    }
    if let Some(expected_len) = expected_byte_length
        && actual_len != expected_len
    {
        return Err(SyncError::IntegrityMismatch {
            expected: format!("{expected_len} bytes"),
            actual: format!("{actual_len} bytes"),
        });
    }
    let normalized_expected = if expected_sha256.starts_with("sha256:") {
        expected_sha256.to_ascii_lowercase()
    } else {
        format!("sha256:{}", expected_sha256.to_ascii_lowercase())
    };
    let actual_sha256 = sha256_digest(bytes);
    if actual_sha256 != normalized_expected {
        return Err(SyncError::IntegrityMismatch {
            expected: normalized_expected,
            actual: actual_sha256,
        });
    }
    Ok(())
}

/// Validate `base_url` and `request_url` against the Hosted Sync origin & path
/// rules from `src-tauri/src/hosted_sync.rs`:
/// - Scheme must be `http` or `https`.
/// - No username, password or fragment.
/// - `base_url` must have no query string.
/// - `request_url` must share the exact scheme, host and port of `base_url`.
/// - Path must start with `/api/sync/v1/` and contain no `..` traversal.
pub fn validate_sync_url(base_url: &str, request_url: &str) -> Result<Url, SyncError> {
    let base = Url::parse(base_url.trim())
        .map_err(|e| SyncError::InvalidOrigin(format!("invalid base URL {base_url}: {e}")))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err(SyncError::InvalidOrigin(format!(
            "unsupported scheme {}",
            base.scheme()
        )));
    }
    if !base.username().is_empty() || base.password().is_some() {
        return Err(SyncError::InvalidOrigin(
            "credentials are not allowed in sync base URL".into(),
        ));
    }
    if base.query().is_some() || base.fragment().is_some() {
        return Err(SyncError::InvalidOrigin(
            "query or fragment not allowed in sync base URL".into(),
        ));
    }

    let raw_req = request_url.trim();
    let raw_before_query = raw_req.split('?').next().unwrap_or(raw_req);
    let raw_lower = raw_before_query.to_ascii_lowercase();
    if raw_before_query
        .split('/')
        .any(|seg| seg == ".." || seg == ".")
        || raw_lower.contains("%2e%2e")
    {
        return Err(SyncError::InvalidPath(format!(
            "path traversal segment in sync URL: {raw_req}"
        )));
    }

    let req = Url::parse(raw_req)
        .map_err(|e| SyncError::InvalidOrigin(format!("invalid request URL {request_url}: {e}")))?;
    if req.scheme() != base.scheme()
        || req.host_str() != base.host_str()
        || req.port_or_known_default() != base.port_or_known_default()
    {
        return Err(SyncError::InvalidOrigin(format!(
            "request origin {} does not match base origin {}",
            req.as_str(),
            base.as_str()
        )));
    }
    if !req.username().is_empty() || req.password().is_some() || req.fragment().is_some() {
        return Err(SyncError::InvalidOrigin(
            "credentials or fragment not allowed in sync request URL".into(),
        ));
    }

    let path = req.path();
    if !path.starts_with("/api/sync/v1/") {
        return Err(SyncError::InvalidPath(format!(
            "sync request path must start with /api/sync/v1/, got {path}"
        )));
    }
    if path
        .split('/')
        .any(|segment| segment == ".." || segment == ".")
    {
        return Err(SyncError::InvalidPath(format!(
            "path traversal segment in sync URL: {path}"
        )));
    }
    Ok(req)
}

/// Validate a local staging destination path (must be absolute and contain no
/// `..` parent traversal components).
pub fn validate_staging_path(dest: &Path) -> Result<(), SyncError> {
    if !dest.is_absolute() {
        return Err(SyncError::InvalidPath(format!(
            "staging path must be absolute: {}",
            dest.display()
        )));
    }
    for comp in dest.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(SyncError::InvalidPath(format!(
                "staging path must not contain '..': {}",
                dest.display()
            )));
        }
    }
    Ok(())
}

/// Write `bytes` to `dest` via a temporary `.part` sibling, verifying size,
/// SHA-256 and cancellation before syncing to disk and atomically renaming.
pub fn write_verified_file_atomic(
    dest: &Path,
    bytes: &[u8],
    expected_sha256: &str,
    expected_byte_length: Option<u64>,
    cancel: Option<&AtomicBool>,
) -> Result<(), SyncError> {
    validate_staging_path(dest)?;
    if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(SyncError::Cancelled);
    }
    verify_payload_integrity(bytes, expected_sha256, expected_byte_length)?;

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }

    let part_path = temp_part_path(dest);
    let write_res = (|| -> Result<(), SyncError> {
        let mut file = File::create(&part_path)?;
        for chunk in bytes.chunks(64 * 1024) {
            if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                return Err(SyncError::Cancelled);
            }
            file.write_all(chunk)?;
        }
        file.sync_all()?;
        drop(file);
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(SyncError::Cancelled);
        }
        fs::rename(&part_path, dest)?;
        Ok(())
    })();

    if write_res.is_err() {
        let _ = fs::remove_file(&part_path);
    }
    write_res
}

fn temp_part_path(dest: &Path) -> PathBuf {
    let seq = PART_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("sync-object");
    dest.with_file_name(format!(".{file_name}.part.{pid}.{seq}"))
}

#[derive(Deserialize)]
struct ServerErrorBody {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "usedBytes")]
    used_bytes: Option<u64>,
    #[serde(default, rename = "quotaBytes")]
    quota_bytes: Option<u64>,
    #[serde(default, rename = "hardLimitBytes")]
    hard_limit_bytes: Option<u64>,
}

/// Blocking HTTP client for `/api/sync/v1/loro-v2/...` and `/api/sync/v1/usage`.
#[derive(Clone)]
pub struct SyncHttpClient {
    base_url: String,
    http: reqwest::blocking::Client,
}

impl SyncHttpClient {
    pub fn new(base_url: impl Into<String>) -> Result<Self, SyncError> {
        ensure_rustls_provider();
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let probe = format!("{base_url}/api/sync/v1/usage");
        validate_sync_url(&base_url, &probe)?;
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| SyncError::Offline(e.to_string()))?;
        Ok(Self { base_url, http })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn validated_url(&self, path_and_query: &str) -> Result<Url, SyncError> {
        let full = format!("{}{}", self.base_url, path_and_query);
        validate_sync_url(&self.base_url, &full)
    }

    /// Fetch `GET /api/sync/v1/usage`.
    pub fn fetch_usage(&self, access_token: &str) -> Result<HostedUsage, SyncError> {
        let url = self.validated_url("/api/sync/v1/usage")?;
        let resp = self
            .http
            .get(url)
            .bearer_auth(access_token)
            .header(SYNC_CAPABILITIES_HEADER, SYNC_CAPABILITIES_VALUE)
            .send()
            .map_err(|e| SyncError::Offline(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(parse_error_response(status.as_u16(), resp.text().ok()));
        }
        resp.json::<HostedUsage>().map_err(|e| SyncError::Server {
            status: status.as_u16(),
            code: None,
            message: format!("invalid usage JSON: {e}"),
        })
    }

    /// Upload an immutable object to `PUT /api/sync/v1/loro-v2/objects/<object_key>`.
    pub fn put_object(
        &self,
        access_token: &str,
        object_key: &str,
        payload: &RemoteObjectPayload,
        bytes: &[u8],
        cancel: Option<&AtomicBool>,
    ) -> Result<RemoteObjectRecord, SyncError> {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(SyncError::Cancelled);
        }
        let byte_len = bytes.len() as u64;
        if byte_len > MAX_OBJECT_BYTES {
            return Err(SyncError::ObjectTooLarge {
                size: byte_len,
                limit: MAX_OBJECT_BYTES,
            });
        }
        let sha256 = sha256_digest(bytes);
        let meta_json = serde_json::to_vec(payload)?;
        let meta_b64 = URL_SAFE_NO_PAD.encode(&meta_json);
        let encoded_key = URL_SAFE_NO_PAD.encode(object_key.as_bytes());
        let path = format!("/api/sync/v1/{SYNC_NAMESPACE_LORO_V2}/objects/{encoded_key}");
        let url = self.validated_url(&path)?;

        let resp = self
            .http
            .put(url)
            .bearer_auth(access_token)
            .header(SYNC_CAPABILITIES_HEADER, SYNC_CAPABILITIES_VALUE)
            .header(CONTENT_SHA256_HEADER, &sha256)
            .header(OBJECT_META_HEADER, meta_b64)
            .header("Content-Type", "application/octet-stream")
            .body(bytes.to_vec())
            .send()
            .map_err(|e| SyncError::Offline(e.to_string()))?;

        let status = resp.status();
        if !status.is_success() {
            return Err(parse_error_response(status.as_u16(), resp.text().ok()));
        }
        resp.json::<RemoteObjectRecord>()
            .map_err(|e| SyncError::Server {
                status: status.as_u16(),
                code: None,
                message: format!("invalid object record JSON: {e}"),
            })
    }

    /// Fetch `GET /api/sync/v1/loro-v2/changes?cursor=<cursor>&limit=<limit>&includeRemovals=1`.
    pub fn list_changes(
        &self,
        access_token: &str,
        cursor: u64,
        limit: usize,
    ) -> Result<ChangesPage, SyncError> {
        let path = format!(
            "/api/sync/v1/{SYNC_NAMESPACE_LORO_V2}/changes?cursor={cursor}&limit={limit}&includeRemovals=1"
        );
        let url = self.validated_url(&path)?;
        let resp = self
            .http
            .get(url)
            .bearer_auth(access_token)
            .header(SYNC_CAPABILITIES_HEADER, SYNC_CAPABILITIES_VALUE)
            .send()
            .map_err(|e| SyncError::Offline(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(parse_error_response(status.as_u16(), resp.text().ok()));
        }
        resp.json::<ChangesPage>().map_err(|e| SyncError::Server {
            status: status.as_u16(),
            code: None,
            message: format!("invalid changes page JSON: {e}"),
        })
    }

    /// Download raw bytes of an object from `GET /api/sync/v1/loro-v2/objects/<encoded_key>`
    /// and verify its SHA-256 and byte length before returning.
    pub fn get_object_bytes(
        &self,
        access_token: &str,
        object_key: &str,
        expected_sha256: &str,
        expected_byte_length: u64,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<u8>, SyncError> {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(SyncError::Cancelled);
        }
        if expected_byte_length > MAX_OBJECT_BYTES {
            return Err(SyncError::ObjectTooLarge {
                size: expected_byte_length,
                limit: MAX_OBJECT_BYTES,
            });
        }
        let encoded_key = URL_SAFE_NO_PAD.encode(object_key.as_bytes());
        let path = format!("/api/sync/v1/{SYNC_NAMESPACE_LORO_V2}/objects/{encoded_key}");
        let url = self.validated_url(&path)?;
        let resp = self
            .http
            .get(url)
            .bearer_auth(access_token)
            .header(SYNC_CAPABILITIES_HEADER, SYNC_CAPABILITIES_VALUE)
            .send()
            .map_err(|e| SyncError::Offline(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(parse_error_response(status.as_u16(), resp.text().ok()));
        }
        let bytes = resp
            .bytes()
            .map_err(|e| SyncError::Offline(e.to_string()))?
            .to_vec();
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(SyncError::Cancelled);
        }
        verify_payload_integrity(&bytes, expected_sha256, Some(expected_byte_length))?;
        Ok(bytes)
    }
}

fn parse_error_response(status: u16, body: Option<String>) -> SyncError {
    if status == 401 {
        return SyncError::Unauthorized;
    }
    let parsed = body
        .as_deref()
        .and_then(|raw| serde_json::from_str::<ServerErrorBody>(raw).ok());
    if status == 413
        || parsed
            .as_ref()
            .and_then(|p| p.code.as_deref())
            .is_some_and(|c| c == "QUOTA_EXCEEDED")
    {
        let used_bytes = parsed
            .as_ref()
            .and_then(|p| p.used_bytes)
            .unwrap_or(DEFAULT_QUOTA_BYTES);
        let quota_bytes = parsed
            .as_ref()
            .and_then(|p| p.quota_bytes)
            .unwrap_or(DEFAULT_QUOTA_BYTES);
        let hard_limit_bytes = parsed
            .as_ref()
            .and_then(|p| p.hard_limit_bytes)
            .unwrap_or(DEFAULT_HARD_LIMIT_BYTES);
        return SyncError::QuotaExceeded {
            used_bytes,
            quota_bytes,
            hard_limit_bytes,
        };
    }
    let code = parsed.as_ref().and_then(|p| p.code.clone());
    let message = parsed
        .and_then(|p| p.message.or(p.error))
        .or(body)
        .unwrap_or_else(|| format!("HTTP {status}"));
    SyncError::Server {
        status,
        code,
        message,
    }
}
