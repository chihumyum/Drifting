//! Image generation through the ChatGPT subscription (Codex) route, and the
//! local generation inbox that holds its results.
//!
//! Experimental and unsupported, like the rest of the subscription route (see
//! `codex_oauth`): the Codex backend's `images/generations` endpoint is what the
//! official Codex client calls for its `image_gen` tool. It ignores `quality`
//! and `size` for subscription accounts and meters images on their own limit,
//! which the `x-codex-*` response headers describe.
//!
//! Generated images never become domain rows here. Each one lands as a
//! candidate under `$APPLOCALDATA/generation-inbox/<projectId>/<candidateId>/`
//! (`image.<ext>` plus `candidate.json`). Keeping a candidate stages a copy in
//! `imports/`, so the ordinary asset import owns the kept bytes; discarded or
//! expired candidates are simply removed.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::future::{join_all, AbortHandle, Abortable};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::codex_oauth::{self, CodexOAuthState};
use crate::image_pipeline;
use crate::native_capabilities::app_local_dir;

const IMAGES_URL: &str = "https://chatgpt.com/backend-api/codex/images/generations";
pub(crate) const IMAGE_MODEL: &str = "gpt-image-2";
const PROVIDER: &str = "chatgpt-subscription";
const INBOX_DIR: &str = "generation-inbox";
const CANDIDATE_FILE: &str = "candidate.json";
const IMAGE_STEM: &str = "image";
const MAX_CANDIDATES_PER_REQUEST: u8 = 4;
const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_PROVENANCE_TEXT_CHARS: usize = 4_000;
const MAX_ID_CHARS: usize = 128;
const MAX_RESPONSE_BYTES: usize = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARS: usize = 300;
const MAX_PRE_CANCELLED: usize = 256;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// Unkept candidates are working files; listing drops them after this window.
const CANDIDATE_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateTarget {
    kind: String,
    id: String,
}

/// Author-facing provenance the renderer supplies; the native host adds the
/// provider facts it observes.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRequestProvenance {
    #[serde(default)]
    subject_prompt: Option<String>,
    #[serde(default)]
    style_text: Option<String>,
    #[serde(default)]
    extra_prompt: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateProvenance {
    provider: String,
    model: String,
    /// The exact prompt sent to the provider.
    prompt: String,
    subject_prompt: Option<String>,
    style_text: Option<String>,
    extra_prompt: Option<String>,
    conversation_id: Option<String>,
    generation_id: Option<String>,
    imagegen_request_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredCandidate {
    id: String,
    project_id: String,
    target: CandidateTarget,
    created_at_ms: u64,
    mime: String,
    width: u32,
    height: u32,
    size_bytes: u64,
    extension: String,
    provenance: CandidateProvenance,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboxCandidate {
    id: String,
    project_id: String,
    target: CandidateTarget,
    created_at_ms: u64,
    mime: String,
    width: u32,
    height: u32,
    size_bytes: u64,
    file_path: String,
    provenance: CandidateProvenance,
}

/// Non-secret view of the image limit reported by the Codex backend.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageQuotaSnapshot {
    limit: Option<String>,
    used_percent: Option<u32>,
    window_minutes: Option<u32>,
    resets_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexImagesGenerateInput {
    request_id: String,
    project_id: String,
    target: CandidateTarget,
    prompt: String,
    count: u8,
    #[serde(default)]
    provenance: CandidateRequestProvenance,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexImagesGenerateResult {
    candidates: Vec<InboxCandidate>,
    failures: Vec<String>,
    quota: Option<ImageQuotaSnapshot>,
}

#[derive(Default)]
struct CodexImagesPending {
    requests: HashMap<String, AbortHandle>,
    pre_cancelled: HashSet<String>,
}

#[derive(Default)]
pub struct CodexImagesState {
    pending: Mutex<CodexImagesPending>,
}

struct GeneratedImage {
    bytes: Vec<u8>,
    generation_id: Option<String>,
    imagegen_request_id: Option<String>,
}

struct GenerationAttempt {
    image: Result<GeneratedImage, String>,
    quota: Option<ImageQuotaSnapshot>,
}

#[tauri::command]
pub async fn codex_images_generate(
    app: AppHandle,
    state: State<'_, CodexImagesState>,
    input: CodexImagesGenerateInput,
) -> Result<CodexImagesGenerateResult, String> {
    validate_generate_input(&input)?;
    let (abort, registration) = AbortHandle::new_pair();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "CODEX_IMAGES_UNAVAILABLE: request state is unavailable")?;
        if pending.pre_cancelled.remove(&input.request_id) {
            return Err("CODEX_IMAGES_CANCELLED: request was cancelled".into());
        }
        if pending
            .requests
            .insert(input.request_id.clone(), abort)
            .is_some()
        {
            return Err("CODEX_IMAGES_INVALID_REQUEST: request id is already active".into());
        }
    }
    let request_id = input.request_id.clone();
    let result = Abortable::new(generate(app, input), registration).await;
    if let Ok(mut pending) = state.pending.lock() {
        pending.requests.remove(&request_id);
        pending.pre_cancelled.remove(&request_id);
    }
    result.unwrap_or_else(|_| Err("CODEX_IMAGES_CANCELLED: request was cancelled".into()))
}

#[tauri::command]
pub fn codex_images_cancel(
    state: State<'_, CodexImagesState>,
    request_id: String,
) -> Result<bool, String> {
    if !valid_id(&request_id) {
        return Err("CODEX_IMAGES_INVALID_REQUEST: request id is invalid".into());
    }
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "CODEX_IMAGES_UNAVAILABLE: request state is unavailable")?;
    if let Some(handle) = pending.requests.remove(&request_id) {
        handle.abort();
        return Ok(true);
    }
    if pending.pre_cancelled.len() >= MAX_PRE_CANCELLED {
        return Err("CODEX_IMAGES_UNAVAILABLE: cancellation queue is full".into());
    }
    Ok(pending.pre_cancelled.insert(request_id))
}

#[tauri::command]
pub async fn image_inbox_list(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<InboxCandidate>, String> {
    if !valid_path_id(&project_id) {
        return Err("IMAGE_INBOX_INVALID: project id is invalid".into());
    }
    let root = app_local_dir(&app, INBOX_DIR)?;
    tauri::async_runtime::spawn_blocking(move || list_candidates(&root, &project_id, now_ms()))
        .await
        .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: inbox worker failed".to_string())?
}

#[tauri::command]
pub async fn image_inbox_delete(
    app: AppHandle,
    project_id: String,
    candidate_id: String,
) -> Result<(), String> {
    if !valid_path_id(&project_id) || !valid_path_id(&candidate_id) {
        return Err("IMAGE_INBOX_INVALID: candidate id is invalid".into());
    }
    let root = app_local_dir(&app, INBOX_DIR)?;
    tauri::async_runtime::spawn_blocking(move || {
        remove_candidate_dir(&root.join(&project_id).join(&candidate_id))
    })
    .await
    .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: inbox worker failed".to_string())?
}

/// Copies a candidate into `imports/` so the ordinary local asset import can
/// own it; the caller releases that import after its SQLite commit.
#[tauri::command]
pub async fn image_inbox_stage_import(
    app: AppHandle,
    project_id: String,
    candidate_id: String,
) -> Result<String, String> {
    if !valid_path_id(&project_id) || !valid_path_id(&candidate_id) {
        return Err("IMAGE_INBOX_INVALID: candidate id is invalid".into());
    }
    let root = app_local_dir(&app, INBOX_DIR)?;
    let imports = app_local_dir(&app, "imports")?;
    tauri::async_runtime::spawn_blocking(move || {
        let candidate = read_candidate(&root.join(&project_id).join(&candidate_id))?;
        if candidate.project_id != project_id {
            return Err("IMAGE_INBOX_INVALID: candidate belongs to another project".to_string());
        }
        let source = candidate_image_path(&root, &candidate);
        stage_import_copy(&source, &imports, &candidate.extension)
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: inbox worker failed".to_string())?
}

async fn generate(
    app: AppHandle,
    input: CodexImagesGenerateInput,
) -> Result<CodexImagesGenerateResult, String> {
    let client = app.state::<CodexOAuthState>().client()?;
    let body = serde_json::json!({
        "prompt": input.prompt,
        "model": IMAGE_MODEL,
        "background": "opaque",
        "quality": "auto",
        "size": "auto",
    })
    .to_string();
    // The subscription endpoint returns one image per request; independent
    // requests keep a partial failure from discarding the others.
    let attempts = join_all((0..input.count).map(|_| request_image(&app, &client, &body))).await;

    let root = app_local_dir(&app, INBOX_DIR)?;
    let mut candidates = Vec::new();
    let mut failures = Vec::new();
    let mut quota = None;
    for attempt in attempts {
        if attempt.quota.is_some() {
            quota = attempt.quota;
        }
        match attempt.image {
            Ok(image) => {
                let provenance = CandidateProvenance {
                    provider: PROVIDER.into(),
                    model: IMAGE_MODEL.into(),
                    prompt: input.prompt.clone(),
                    subject_prompt: input.provenance.subject_prompt.clone(),
                    style_text: input.provenance.style_text.clone(),
                    extra_prompt: input.provenance.extra_prompt.clone(),
                    conversation_id: input.provenance.conversation_id.clone(),
                    generation_id: image.generation_id,
                    imagegen_request_id: image.imagegen_request_id,
                };
                let root = root.clone();
                let project_id = input.project_id.clone();
                let target = input.target.clone();
                let bytes = image.bytes;
                let written = tauri::async_runtime::spawn_blocking(move || {
                    write_candidate(&root, &project_id, target, provenance, &bytes, now_ms())
                })
                .await
                .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: inbox worker failed".to_string())
                .and_then(|result| result);
                match written {
                    Ok(candidate) => candidates.push(candidate),
                    Err(error) => failures.push(error),
                }
            }
            Err(error) => failures.push(error),
        }
    }
    if candidates.is_empty() {
        return Err(failures
            .into_iter()
            .next()
            .unwrap_or_else(|| "CODEX_IMAGES_FAILED: no image was returned".into()));
    }
    Ok(CodexImagesGenerateResult {
        candidates,
        failures,
        quota,
    })
}

/// One generation request; a rejected token is refreshed once and replayed.
async fn request_image(app: &AppHandle, client: &reqwest::Client, body: &str) -> GenerationAttempt {
    let failed = |error: String| GenerationAttempt {
        image: Err(error),
        quota: None,
    };
    let mut authorization = match codex_oauth::authorization(app, false).await {
        Ok(authorization) => authorization,
        Err(error) => return failed(error),
    };
    for attempt in 0..2 {
        let sent = codex_oauth::apply_request_headers(
            client
                .post(IMAGES_URL)
                .header(ACCEPT, "application/json")
                .header(CONTENT_TYPE, "application/json")
                .timeout(REQUEST_TIMEOUT),
            &authorization,
        )
        .body(body.to_owned())
        .send()
        .await;
        let response = match sent {
            Ok(response) => response,
            Err(error) if error.is_timeout() => {
                return failed("CODEX_IMAGES_FAILED: timed_out".into())
            }
            Err(_) => return failed("CODEX_IMAGES_FAILED: network_failed".into()),
        };
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            authorization = match codex_oauth::authorization(app, true).await {
                Ok(authorization) => authorization,
                Err(error) => return failed(error),
            };
            continue;
        }
        let quota = project_quota(response.headers());
        let imagegen_request_id = header_text(response.headers(), "x-codex-imagegen-request-id");
        if !status.is_success() {
            let body = read_bounded(response, MAX_ERROR_BYTES, false)
                .await
                .unwrap_or_default();
            return GenerationAttempt {
                image: Err(project_upstream_error(
                    status.as_u16(),
                    &body,
                    quota.as_ref(),
                )),
                quota,
            };
        }
        let image = match read_bounded(response, MAX_RESPONSE_BYTES, true).await {
            Ok(bytes) => project_image(&bytes).map(|(bytes, generation_id)| GeneratedImage {
                bytes,
                generation_id,
                imagegen_request_id,
            }),
            Err(error) => Err(error),
        };
        return GenerationAttempt { image, quota };
    }
    failed("CODEX_IMAGES_FAILED: authorization_failed".into())
}

async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
    strict: bool,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "CODEX_IMAGES_FAILED: network_failed".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            if strict {
                return Err("CODEX_IMAGES_FAILED: response_too_large".into());
            }
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn project_image(bytes: &[u8]) -> Result<(Vec<u8>, Option<String>), String> {
    let invalid = || "CODEX_IMAGES_FAILED: invalid_response".to_string();
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let first = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
        .ok_or_else(invalid)?;
    let encoded = first
        .get("b64_json")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("CODEX_IMAGES_FAILED: response_too_large".into());
    }
    let image = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid())?;
    if !matches!(
        image_pipeline::sniff_extension(&image),
        "png" | "jpg" | "webp"
    ) {
        return Err(invalid());
    }
    let generation_id = first
        .get("generation_id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .map(str::to_owned);
    Ok((image, generation_id))
}

fn project_upstream_error(status: u16, body: &[u8], quota: Option<&ImageQuotaSnapshot>) -> String {
    let message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            let error = value.get("error").unwrap_or(&value);
            error
                .get("message")
                .or_else(|| error.get("detail"))
                .and_then(Value::as_str)
                .map(clean_message)
        })
        .filter(|message| !message.is_empty());
    match status {
        401 | 403 => "CODEX_IMAGES_FAILED: authorization_failed".into(),
        429 => {
            let resets = quota
                .and_then(|quota| quota.resets_at_ms)
                .map(|at| format!(" (resets_at_ms={at})"))
                .unwrap_or_default();
            format!("CODEX_IMAGES_USAGE_LIMIT: image limit reached{resets}")
        }
        400 | 422 => match message {
            Some(message) => format!("CODEX_IMAGES_REJECTED: {message}"),
            None => format!("CODEX_IMAGES_REJECTED: provider_rejected ({status})"),
        },
        _ => format!("CODEX_IMAGES_FAILED: provider_rejected ({status})"),
    }
}

fn clean_message(message: &str) -> String {
    message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_ERROR_MESSAGE_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| valid_id(value))
        .map(str::to_owned)
}

fn header_number(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.round() as u64)
}

fn project_quota(headers: &HeaderMap) -> Option<ImageQuotaSnapshot> {
    let snapshot = ImageQuotaSnapshot {
        limit: header_text(headers, "x-codex-active-limit"),
        used_percent: header_number(headers, "x-codex-primary-used-percent")
            .map(|percent| percent.min(100) as u32),
        window_minutes: header_number(headers, "x-codex-primary-window-minutes")
            .filter(|minutes| *minutes > 0 && *minutes <= 60 * 24 * 31)
            .map(|minutes| minutes as u32),
        resets_at_ms: header_number(headers, "x-codex-primary-reset-at")
            .filter(|seconds| *seconds > 0)
            .map(|seconds| seconds.saturating_mul(1_000)),
    };
    (snapshot != ImageQuotaSnapshot::default()).then_some(snapshot)
}

fn validate_generate_input(input: &CodexImagesGenerateInput) -> Result<(), String> {
    let invalid = |reason: &str| Err(format!("CODEX_IMAGES_INVALID_REQUEST: {reason}"));
    if !valid_id(&input.request_id) || !valid_path_id(&input.project_id) {
        return invalid("request or project id is invalid");
    }
    if input.target.kind != "element" || !valid_id(&input.target.id) {
        return invalid("target must be an element");
    }
    if input.prompt.trim().is_empty() || input.prompt.chars().count() > MAX_PROMPT_CHARS {
        return invalid("prompt is empty or too long");
    }
    if input.count == 0 || input.count > MAX_CANDIDATES_PER_REQUEST {
        return invalid("count must be between 1 and 4");
    }
    let provenance = &input.provenance;
    for text in [
        &provenance.subject_prompt,
        &provenance.style_text,
        &provenance.extra_prompt,
    ]
    .into_iter()
    .flatten()
    {
        if text.chars().count() > MAX_PROVENANCE_TEXT_CHARS {
            return invalid("provenance text is too long");
        }
    }
    if provenance
        .conversation_id
        .as_deref()
        .is_some_and(|id| !valid_id(id))
    {
        return invalid("conversation id is invalid");
    }
    Ok(())
}

/// Opaque identifiers carried through requests and provenance.
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

/// Project and candidate ids double as path components, so they stay plain
/// ASCII tokens that can never name a parent, hidden or drive-relative path.
fn valid_path_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 12];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: randomness is unavailable".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn ensure_real_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: inbox directory could not be created".to_string())?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: inbox directory is unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("IMAGE_INBOX_UNAVAILABLE: inbox directory is invalid".into());
    }
    Ok(())
}

fn write_file_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: candidate file could not be created".to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: candidate file could not be written".to_string())
}

/// Writes the candidate into a hidden staging directory and renames it into
/// place, so a listing never observes a half-written candidate.
fn write_candidate(
    root: &Path,
    project_id: &str,
    target: CandidateTarget,
    provenance: CandidateProvenance,
    bytes: &[u8],
    created_at_ms: u64,
) -> Result<InboxCandidate, String> {
    let project_dir = root.join(project_id);
    ensure_real_dir(root)?;
    ensure_real_dir(&project_dir)?;
    let id = format!("{created_at_ms:x}-{}", random_token()?);
    let staging = project_dir.join(format!(".{id}.part"));
    let result = (|| {
        fs::create_dir(&staging).map_err(|_| {
            "IMAGE_INBOX_UNAVAILABLE: candidate directory could not be created".to_string()
        })?;
        let extension = image_pipeline::sniff_extension(bytes).to_owned();
        let image_path = staging.join(format!("{IMAGE_STEM}.{extension}"));
        write_file_synced(&image_path, bytes)?;
        let inspection = image_pipeline::inspect(&image_path, MAX_IMAGE_BYTES as u64)
            .map_err(|error| format!("CODEX_IMAGES_FAILED: invalid image ({})", error.message))?;
        let stored = StoredCandidate {
            id: id.clone(),
            project_id: project_id.to_owned(),
            target,
            created_at_ms,
            mime: inspection.mime,
            width: inspection.width,
            height: inspection.height,
            size_bytes: inspection.size_bytes,
            extension,
            provenance,
        };
        let json = serde_json::to_vec_pretty(&stored)
            .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: candidate could not be recorded".to_string())?;
        write_file_synced(&staging.join(CANDIDATE_FILE), &json)?;
        let destination = project_dir.join(&id);
        fs::rename(&staging, &destination)
            .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: candidate could not be finalized".to_string())?;
        Ok(public_candidate(root, stored))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn candidate_image_path(root: &Path, candidate: &StoredCandidate) -> PathBuf {
    root.join(&candidate.project_id)
        .join(&candidate.id)
        .join(format!("{IMAGE_STEM}.{}", candidate.extension))
}

fn public_candidate(root: &Path, stored: StoredCandidate) -> InboxCandidate {
    let file_path = candidate_image_path(root, &stored)
        .to_string_lossy()
        .into_owned();
    InboxCandidate {
        id: stored.id,
        project_id: stored.project_id,
        target: stored.target,
        created_at_ms: stored.created_at_ms,
        mime: stored.mime,
        width: stored.width,
        height: stored.height,
        size_bytes: stored.size_bytes,
        file_path,
        provenance: stored.provenance,
    }
}

fn read_candidate(dir: &Path) -> Result<StoredCandidate, String> {
    let metadata = fs::symlink_metadata(dir)
        .map_err(|_| "IMAGE_INBOX_NOT_FOUND: candidate is no longer available".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("IMAGE_INBOX_INVALID: candidate directory is invalid".into());
    }
    let bytes = fs::read(dir.join(CANDIDATE_FILE))
        .map_err(|_| "IMAGE_INBOX_NOT_FOUND: candidate is no longer available".to_string())?;
    let stored: StoredCandidate = serde_json::from_slice(&bytes)
        .map_err(|_| "IMAGE_INBOX_INVALID: candidate record is unreadable".to_string())?;
    let expected = dir.file_name().and_then(|name| name.to_str());
    if expected != Some(stored.id.as_str())
        || !valid_path_id(&stored.project_id)
        || !matches!(stored.extension.as_str(), "png" | "jpg" | "webp")
    {
        return Err("IMAGE_INBOX_INVALID: candidate record is inconsistent".into());
    }
    Ok(stored)
}

fn list_candidates(root: &Path, project_id: &str, now: u64) -> Result<Vec<InboxCandidate>, String> {
    let project_dir = root.join(project_id);
    let entries = match fs::read_dir(&project_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("IMAGE_INBOX_UNAVAILABLE: inbox could not be read".into()),
    };
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            // A staging directory older than the request timeout was orphaned
            // by a crash; a live one is left to its writer.
            let stale = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age > REQUEST_TIMEOUT * 2);
            if stale {
                let _ = fs::remove_dir_all(&path);
            }
            continue;
        }
        match read_candidate(&path) {
            Ok(stored) if now.saturating_sub(stored.created_at_ms) > CANDIDATE_RETENTION_MS => {
                let _ = remove_candidate_dir(&path);
            }
            Ok(stored) if stored.project_id == project_id => {
                candidates.push(public_candidate(root, stored));
            }
            _ => {}
        }
    }
    candidates.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(candidates)
}

fn remove_candidate_dir(dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("IMAGE_INBOX_INVALID: candidate directory is invalid".into())
        }
        Ok(_) => fs::remove_dir_all(dir)
            .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: candidate could not be removed".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("IMAGE_INBOX_UNAVAILABLE: candidate could not be removed".into()),
    }
}

fn stage_import_copy(source: &Path, imports: &Path, extension: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|_| "IMAGE_INBOX_NOT_FOUND: candidate image is no longer available".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("IMAGE_INBOX_INVALID: candidate image is invalid".into());
    }
    ensure_real_dir(imports)?;
    let token = random_token()?;
    let temporary = imports.join(format!(".{token}.part"));
    let destination = imports.join(format!("{token}-generated.{extension}"));
    let result = (|| {
        let bytes = fs::read(source).map_err(|_| {
            "IMAGE_INBOX_UNAVAILABLE: candidate image could not be read".to_string()
        })?;
        write_file_synced(&temporary, &bytes)?;
        fs::rename(&temporary, &destination)
            .map_err(|_| "IMAGE_INBOX_UNAVAILABLE: candidate could not be staged".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|()| destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn tiny_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::RgbaImage::new(3, 2)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    fn provenance() -> CandidateProvenance {
        CandidateProvenance {
            provider: PROVIDER.into(),
            model: IMAGE_MODEL.into(),
            prompt: "A lighthouse keeper".into(),
            subject_prompt: Some("A lighthouse keeper".into()),
            style_text: Some("watercolor".into()),
            extra_prompt: None,
            conversation_id: None,
            generation_id: Some("gen-1".into()),
            imagegen_request_id: None,
        }
    }

    fn element(id: &str) -> CandidateTarget {
        CandidateTarget {
            kind: "element".into(),
            id: id.into(),
        }
    }

    #[test]
    fn projects_the_first_image_and_rejects_non_images() {
        let png = tiny_png();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
        let body = serde_json::to_vec(&serde_json::json!({
            "created": 1, "quality": "medium", "size": "1024x1536",
            "data": [{ "b64_json": encoded, "generation_id": "gen-1" }],
        }))
        .unwrap();
        let (bytes, generation_id) = project_image(&body).unwrap();
        assert_eq!(bytes, png);
        assert_eq!(generation_id.as_deref(), Some("gen-1"));

        let not_image = base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7");
        for body in [
            serde_json::json!({ "data": [] }),
            serde_json::json!({ "data": [{ "b64_json": "!!" }] }),
            serde_json::json!({ "data": [{ "b64_json": not_image }] }),
        ] {
            assert!(project_image(&serde_json::to_vec(&body).unwrap()).is_err());
        }
    }

    #[test]
    fn projects_quota_headers_and_upstream_errors_without_secrets() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-active-limit",
            HeaderValue::from_static("imagegen_premium"),
        );
        headers.insert(
            "x-codex-primary-used-percent",
            HeaderValue::from_static("1"),
        );
        headers.insert(
            "x-codex-primary-window-minutes",
            HeaderValue::from_static("1440"),
        );
        headers.insert(
            "x-codex-primary-reset-at",
            HeaderValue::from_static("1793016673"),
        );
        let quota = project_quota(&headers).unwrap();
        assert_eq!(quota.limit.as_deref(), Some("imagegen_premium"));
        assert_eq!(quota.used_percent, Some(1));
        assert_eq!(quota.window_minutes, Some(1440));
        assert_eq!(quota.resets_at_ms, Some(1_793_016_673_000));
        assert!(project_quota(&HeaderMap::new()).is_none());

        let limited = project_upstream_error(429, b"{}", Some(&quota));
        assert!(limited.starts_with("CODEX_IMAGES_USAGE_LIMIT"));
        assert!(limited.contains("1793016673000"));
        let rejected = project_upstream_error(
            400,
            br#"{"error":{"message":"Your request was rejected\nby the safety system."}}"#,
            None,
        );
        assert_eq!(
            rejected,
            "CODEX_IMAGES_REJECTED: Your request was rejected by the safety system."
        );
        assert_eq!(
            project_upstream_error(403, b"{\"error\":{\"message\":\"token abc\"}}", None),
            "CODEX_IMAGES_FAILED: authorization_failed"
        );
    }

    #[test]
    fn writes_lists_stages_and_removes_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(INBOX_DIR);
        let imports = dir.path().join("imports");
        let png = tiny_png();
        let first = write_candidate(
            &root,
            "project-1",
            element("element-1"),
            provenance(),
            &png,
            1_000,
        )
        .unwrap();
        let second = write_candidate(
            &root,
            "project-1",
            element("element-2"),
            provenance(),
            &png,
            2_000,
        )
        .unwrap();
        assert_eq!(
            (first.width, first.height, first.mime.as_str()),
            (3, 2, "image/png")
        );

        let listed = list_candidates(&root, "project-1", 3_000).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|candidate| candidate.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
        assert!(list_candidates(&root, "project-2", 3_000)
            .unwrap()
            .is_empty());

        let stored = read_candidate(&root.join("project-1").join(&first.id)).unwrap();
        let staged =
            stage_import_copy(&candidate_image_path(&root, &stored), &imports, "png").unwrap();
        assert_eq!(staged.parent(), Some(imports.as_path()));
        assert_eq!(fs::read(&staged).unwrap(), png);

        remove_candidate_dir(&root.join("project-1").join(&first.id)).unwrap();
        remove_candidate_dir(&root.join("project-1").join(&first.id)).unwrap();
        let remaining = list_candidates(&root, "project-1", 3_000).unwrap();
        assert_eq!(remaining.len(), 1);

        let expired =
            list_candidates(&root, "project-1", 2_000 + CANDIDATE_RETENTION_MS + 1).unwrap();
        assert!(expired.is_empty());
        assert!(!root.join("project-1").join(&second.id).exists());
    }

    #[test]
    fn rejects_ids_that_could_escape_the_inbox() {
        for id in ["", ".", "..", ".hidden", "a/b", "a\\b", "c:", "名字"] {
            assert!(!valid_path_id(id), "{id}");
        }
        assert!(valid_path_id("019a2b3c-element_1"));
        assert!(valid_id("mcp:server:conversation"));
        let input = CodexImagesGenerateInput {
            request_id: "req-1".into(),
            project_id: "project-1".into(),
            target: CandidateTarget {
                kind: "chapter".into(),
                id: "x".into(),
            },
            prompt: "x".into(),
            count: 1,
            provenance: CandidateRequestProvenance::default(),
        };
        assert!(validate_generate_input(&input).is_err());
        let input = CodexImagesGenerateInput {
            target: element("x"),
            count: 5,
            ..input
        };
        assert!(validate_generate_input(&input).is_err());
    }
}
