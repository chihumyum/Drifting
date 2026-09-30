//! Hosted object transport. Streams native staging files without exposing paths or bytes to JS.
use crate::sync_object_store::{resolve_download_destination_ref, validate_upload_ref};
use futures_util::{stream, StreamExt};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::AppHandle;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
};
const MAX_BYTES: u64 = 64 * 1024 * 1024;
static TRANSFERS: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostedRequest {
    origin: String,
    token: String,
    path: String,
    method: String,
    transfer_id: String,
    source_ref: Option<String>,
    destination_ref: Option<String>,
    object_kind: Option<String>,
    stored_sha256: Option<String>,
    size_bytes: Option<u64>,
}
fn request_url(origin: &str, path: &str) -> Result<Url, String> {
    let base = Url::parse(origin).map_err(|_| "HOSTED_INVALID_ORIGIN")?;
    if !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || base.path() != "/"
        || !matches!(base.scheme(), "http" | "https")
    {
        return Err("HOSTED_INVALID_ORIGIN".into());
    }
    // HTTP is a local-development capability only. Release operators must configure HTTPS.
    if base.scheme() == "http" && !cfg!(debug_assertions) {
        return Err("HOSTED_HTTPS_REQUIRED".into());
    }
    if let Some(expected) = option_env!("DRIFTING_HOSTED_ORIGIN") {
        if base.as_str().trim_end_matches('/') != expected.trim_end_matches('/') {
            return Err("HOSTED_ORIGIN_MISMATCH".into());
        }
    } else if !cfg!(debug_assertions) {
        return Err("HOSTED_ORIGIN_UNCONFIGURED".into());
    }
    if !path.starts_with("/api/sync/v1/")
        || path.contains("..")
        || path.contains('\\')
        || path.contains('#')
    {
        return Err("HOSTED_INVALID_PATH".into());
    }
    let url = base.join(path).map_err(|_| "HOSTED_INVALID_PATH")?;
    if url.origin() != base.origin() {
        return Err("HOSTED_ORIGIN_MISMATCH".into());
    }
    if !url.path().starts_with("/api/sync/v1/") {
        return Err("HOSTED_INVALID_PATH".into());
    }
    Ok(url)
}
async fn response_error(response: reqwest::Response) -> String {
    match response.status().as_u16() {
        401 => "needs-reauth",
        403 => "permission-denied",
        404 => "REMOTE_OBJECT_MISSING",
        409 => "IMMUTABLE_OBJECT_CONFLICT",
        413 => "SIZE_MISMATCH",
        422 => "HASH_MISMATCH",
        429 => "rate-limited",
        500..=599 => "provider-unavailable",
        _ => "HOSTED_REQUEST_REJECTED",
    }
    .into()
}
async fn transfer(app: &AppHandle, input: &HostedRequest) -> Result<Value, String> {
    let url = request_url(&input.origin, &input.path)?;
    if input.token.is_empty() || input.token.len() > 8192 {
        return Err("needs-reauth".into());
    }
    if !matches!(input.method.as_str(), "GET" | "PUT") {
        return Err("HOSTED_INVALID_METHOD".into());
    }
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "HOSTED_TRANSPORT_UNAVAILABLE")?;
    let method = reqwest::Method::from_bytes(input.method.as_bytes())
        .map_err(|_| "HOSTED_INVALID_METHOD")?;
    let mut request = client.request(method, url).bearer_auth(&input.token);
    if let Some(source) = &input.source_ref {
        if input.method != "PUT" || input.destination_ref.is_some() {
            return Err("HOSTED_INVALID_TRANSFER".into());
        }
        let expected = input.stored_sha256.as_deref().ok_or("HASH_MISMATCH")?;
        let size = input
            .size_bytes
            .filter(|n| *n > 0 && *n <= MAX_BYTES)
            .ok_or("SIZE_MISMATCH")?;
        let path = validate_upload_ref(app, source, expected, size)?;
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| "LOCAL_OBJECT_MISSING")?;
        let body = stream::try_unfold(file, |mut file| async move {
            let mut chunk = vec![0; 64 * 1024];
            let read = file.read(&mut chunk).await?;
            if read == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            chunk.truncate(read);
            Ok(Some((chunk, file)))
        });
        request = request
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", size)
            .header("X-Content-Sha256", expected)
            .header(
                "X-Object-Kind",
                input.object_kind.as_deref().ok_or("HOSTED_INVALID_KIND")?,
            )
            .body(reqwest::Body::wrap_stream(body));
    }
    let response = request.send().await.map_err(|_| "provider-unavailable")?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    if let Some(destination) = &input.destination_ref {
        let expected = input.stored_sha256.as_deref().ok_or("HASH_MISMATCH")?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BYTES)
        {
            return Err("SIZE_MISMATCH".into());
        }
        let path = resolve_download_destination_ref(app, destination)?;
        let parent = path.parent().ok_or("LOCAL_OBJECT_MISSING")?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| "LOCAL_OBJECT_MISSING")?;
        let temporary = path.with_extension(format!("{}.part", input.transfer_id));
        // Drop removes an uncommitted temporary even when cancellation drops this future.
        struct Temporary(std::path::PathBuf);
        impl Drop for Temporary {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Temporary(temporary.clone());
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|_| "LOCAL_OBJECT_MISSING")?;
        let mut bytes = response.bytes_stream();
        let mut size = 0u64;
        let mut digest = Sha256::new();
        while let Some(chunk) = bytes.next().await {
            let chunk = chunk.map_err(|_| "provider-unavailable")?;
            size += chunk.len() as u64;
            if size > MAX_BYTES {
                return Err("SIZE_MISMATCH".into());
            }
            digest.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "LOCAL_OBJECT_MISSING")?;
        }
        let actual = format!("sha256:{:x}", digest.finalize());
        if actual != expected {
            return Err("HASH_MISMATCH".into());
        }
        file.sync_all().await.map_err(|_| "LOCAL_OBJECT_MISSING")?;
        drop(file);
        tokio::fs::rename(&temporary, &path)
            .await
            .map_err(|_| "LOCAL_OBJECT_MISSING")?;
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "LOCAL_OBJECT_MISSING")?;
        return Ok(json!({"destinationRef":destination,"storedSha256":actual,"sizeBytes":size}));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "provider-unavailable")?;
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("REMOTE_STORE_CORRUPT".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "REMOTE_STORE_CORRUPT".into())
}
#[tauri::command]
pub(crate) async fn hosted_sync_request(
    app: AppHandle,
    input: HostedRequest,
) -> Result<Value, String> {
    if input.transfer_id.is_empty()
        || input.transfer_id.len() > 100
        || !input
            .transfer_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("HOSTED_INVALID_TRANSFER".into());
    }
    let (sender, mut receiver) = watch::channel(false);
    {
        let mut transfers = TRANSFERS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "HOSTED_TRANSPORT_UNAVAILABLE")?;
        if transfers.contains_key(&input.transfer_id) {
            return Err("HOSTED_DUPLICATE_TRANSFER".into());
        }
        transfers.insert(input.transfer_id.clone(), sender);
    }
    let result = match futures_util::future::select(
        Box::pin(transfer(&app, &input)),
        Box::pin(receiver.changed()),
    )
    .await
    {
        futures_util::future::Either::Left((result, _)) => result,
        futures_util::future::Either::Right(_) => Err("ABORTED".into()),
    };
    if let Ok(mut transfers) = TRANSFERS.get_or_init(Default::default).lock() {
        transfers.remove(&input.transfer_id);
    }
    result
}
#[tauri::command]
pub(crate) fn hosted_sync_cancel(transfer_id: String) {
    if let Ok(transfers) = TRANSFERS.get_or_init(Default::default).lock() {
        if let Some(sender) = transfers.get(&transfer_id) {
            let _ = sender.send(true);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn constrains_origin_and_paths() {
        let origin = option_env!("DRIFTING_HOSTED_ORIGIN").unwrap_or("https://example.test");
        assert!(request_url(origin, "/api/sync/v1/project-v1/snapshots").is_ok());
        for origin in [
            "https://secret@example.test",
            "file:///tmp",
            "https://example.test/path",
            "https://example.test/?secret=1",
        ] {
            assert!(request_url(origin, "/api/sync/v1/project-v1/snapshots").is_err());
        }
        for path in [
            "//evil.test/api/sync/v1/a",
            "/api/auth/get-session",
            "/api/sync/v1/../auth",
            "/api/sync/v1/%2e%2e/auth",
            "/api/sync/v1/x#fragment",
        ] {
            assert!(request_url(origin, path).is_err());
        }
    }
}
