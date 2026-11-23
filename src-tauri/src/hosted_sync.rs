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
    time::{Duration, Instant, SystemTime},
};
use tauri::AppHandle;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
};
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_JSON_BODY_BYTES: usize = 256 * 1024;
/// Announced on every sync request. A pruned Hosted stream rejects clients
/// that cannot interpret removal changes instead of letting them miss history.
const SYNC_CAPABILITIES: &str = "removals-v1";
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
    json_body: Option<Value>,
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
    if let Some(expected) = option_env!("DRIFTING_HOSTED_ORIGIN").filter(|value| !value.is_empty())
    {
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
/// Read at most 4 KiB of an error body; `None` when it is larger or broken.
async fn bounded_error_body(response: reqwest::Response) -> Option<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if body.len() + chunk.len() > 4096 {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}
async fn response_error(response: reqwest::Response) -> String {
    if response.status().as_u16() == 410 {
        // Forward only a bounded deletion receipt. The provider validates its exact scope.
        let Some(body) = bounded_error_body(response).await else {
            return "REMOTE_STORE_CORRUPT".into();
        };
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            return format!("HOSTED_DELETION_RECEIPT:{}", value);
        }
        return "REMOTE_STORE_CORRUPT".into();
    }
    if response.status().as_u16() == 413 {
        // The account storage ceiling and the per-object size ceiling share 413.
        let quota = bounded_error_body(response)
            .await
            .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
            .is_some_and(|value| {
                value.get("code").and_then(Value::as_str) == Some("QUOTA_EXCEEDED")
            });
        return if quota {
            "QUOTA_EXCEEDED"
        } else {
            "SIZE_MISMATCH"
        }
        .into();
    }
    match response.status().as_u16() {
        401 => "needs-reauth",
        403 => "permission-denied",
        404 => "REMOTE_OBJECT_MISSING",
        409 => "IMMUTABLE_OBJECT_CONFLICT",
        422 => "HASH_MISMATCH",
        429 => "rate-limited",
        500..=599 => "provider-unavailable",
        _ => "HOSTED_REQUEST_REJECTED",
    }
    .into()
}
/// A local development origin is reached directly. The macOS proxy settings
/// carry their exception list apart from the proxy addresses, and only the
/// addresses are read, so a loopback request would be handed to the proxy.
fn is_loopback_target(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}
/// How long one client serves sync requests. Building a client is what reads
/// the system's proxy settings, so this is also how long a change to them can
/// take to apply while requests keep succeeding.
const CLIENT_MAX_AGE: Duration = Duration::from_secs(60);
/// How long an unused connection stays open for the next request. Shorter than
/// the idle limits of proxies and address translators on the way, so a request
/// is not handed a connection that was dropped without notice.
const CONNECTION_IDLE: Duration = Duration::from_secs(20);
fn build_client(direct: bool) -> reqwest::Result<Client> {
    // The client follows the proxy the system is set to use (macOS network
    // settings, Windows internet options, or the proxy environment variables),
    // like the WebView does for sign-in. A direct route that drops packets
    // otherwise fails sync while the rest of the App stays online.
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .pool_idle_timeout(CONNECTION_IDLE)
        // A connection that died under a request in flight is noticed here
        // instead of at the request's own three-minute limit.
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(20));
    if direct {
        builder = builder.no_proxy();
    }
    builder.build()
}
struct SharedClient {
    client: Client,
    direct: bool,
    generation: u64,
    built: Instant,
    built_wall: SystemTime,
}
impl SharedClient {
    /// The monotonic clock stands still while the machine sleeps, so the wall
    /// clock is consulted too: connections do not outlive a sleep.
    fn serves(&self, direct: bool, now: Instant, wall: SystemTime) -> bool {
        self.direct == direct
            && now.saturating_duration_since(self.built) < CLIENT_MAX_AGE
            && wall
                .duration_since(self.built_wall)
                .is_ok_and(|age| age < CLIENT_MAX_AGE)
    }
}
struct ClientState {
    shared: Option<SharedClient>,
    built: u64,
}
/// Sync requests share one client, so the requests of a sync cycle travel over
/// connections that are already open. One client per request meant one TCP and
/// TLS handshake per request, and on a route that drops packets every
/// handshake is another chance for the cycle to fail.
struct ClientCache(Mutex<ClientState>);
impl ClientCache {
    const fn new() -> Self {
        Self(Mutex::new(ClientState {
            shared: None,
            built: 0,
        }))
    }
    /// The client to send with, and the generation to name in `retire`.
    fn client(
        &self,
        direct: bool,
        now: Instant,
        wall: SystemTime,
    ) -> Result<(Client, u64), String> {
        let mut state = self.0.lock().map_err(|_| "HOSTED_TRANSPORT_UNAVAILABLE")?;
        if let Some(shared) = state
            .shared
            .as_ref()
            .filter(|shared| shared.serves(direct, now, wall))
        {
            return Ok((shared.client.clone(), shared.generation));
        }
        let client = build_client(direct).map_err(|_| "HOSTED_TRANSPORT_UNAVAILABLE")?;
        state.built += 1;
        let generation = state.built;
        state.shared = Some(SharedClient {
            client: client.clone(),
            direct,
            generation,
            built: now,
            built_wall: wall,
        });
        Ok((client, generation))
    }
    /// A request that was lost in transit gives up its client: the next
    /// request opens new connections and reads the proxy settings again.
    /// Requests already in flight on the retired client finish on it.
    fn retire(&self, generation: u64) {
        if let Ok(mut state) = self.0.lock() {
            if state
                .shared
                .as_ref()
                .is_some_and(|shared| shared.generation == generation)
            {
                state.shared = None;
            }
        }
    }
}
static CLIENTS: ClientCache = ClientCache::new();
async fn transfer(app: &AppHandle, input: &HostedRequest) -> Result<Value, String> {
    let url = request_url(&input.origin, &input.path)?;
    if input.token.is_empty() || input.token.len() > 8192 {
        return Err("needs-reauth".into());
    }
    if !matches!(input.method.as_str(), "GET" | "PUT" | "DELETE" | "POST") {
        return Err("HOSTED_INVALID_METHOD".into());
    }
    if input.method == "DELETE" && (input.source_ref.is_some() || input.destination_ref.is_some()) {
        return Err("HOSTED_INVALID_METHOD".into());
    }
    if (input.method == "POST") != input.json_body.is_some()
        || (input.method == "POST"
            && (input.source_ref.is_some() || input.destination_ref.is_some()))
    {
        return Err("HOSTED_INVALID_METHOD".into());
    }
    let (client, generation) =
        CLIENTS.client(is_loopback_target(&url), Instant::now(), SystemTime::now())?;
    let lost_in_transit = move |_: reqwest::Error| -> String {
        CLIENTS.retire(generation);
        "provider-unavailable".into()
    };
    let method = reqwest::Method::from_bytes(input.method.as_bytes())
        .map_err(|_| "HOSTED_INVALID_METHOD")?;
    let mut request = client
        .request(method, url)
        .bearer_auth(&input.token)
        .header("X-Drifting-Sync-Capabilities", SYNC_CAPABILITIES);
    if let Some(body) = &input.json_body {
        let bytes = serde_json::to_vec(body).map_err(|_| "HOSTED_INVALID_BODY")?;
        if bytes.len() > MAX_JSON_BODY_BYTES {
            return Err("HOSTED_INVALID_BODY".into());
        }
        request = request
            .header("Content-Type", "application/json")
            .body(bytes);
    }
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
    let response = request.send().await.map_err(lost_in_transit)?;
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
            let chunk = chunk.map_err(lost_in_transit)?;
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
        drifting_core::file_io::sync_directory(parent).map_err(|_| "LOCAL_OBJECT_MISSING")?;
        return Ok(json!({"destinationRef":destination,"storedSha256":actual,"sizeBytes":size}));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(lost_in_transit)?;
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
    use std::{
        io::{Read, Write},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    #[test]
    fn constrains_origin_and_paths() {
        let origin = option_env!("DRIFTING_HOSTED_ORIGIN")
            .filter(|value| !value.is_empty())
            .unwrap_or("https://example.test");
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
    #[test]
    fn only_loopback_origins_bypass_the_system_proxy() {
        for origin in [
            "http://localhost:8787",
            "http://hosted.localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(is_loopback_target(&Url::parse(origin).unwrap()), "{origin}");
        }
        for origin in [
            "https://example.test",
            "https://localhost.example.test",
            "https://192.168.1.20:8787",
        ] {
            assert!(
                !is_loopback_target(&Url::parse(origin).unwrap()),
                "{origin}"
            );
        }
    }
    /// A loopback server that answers every request with an empty JSON object
    /// and counts the connections it accepted.
    fn serve_counting_connections() -> (String, Arc<AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut buffer = [0u8; 4096];
                    let mut pending = Vec::new();
                    loop {
                        match stream.read(&mut buffer) {
                            Ok(read) if read > 0 => pending.extend_from_slice(&buffer[..read]),
                            _ => return,
                        }
                        while let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
                            pending.drain(..end + 4);
                            let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}";
                            if stream.write_all(response).is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        (origin, accepted)
    }
    fn get(cache: &ClientCache, origin: &str) -> u64 {
        let (client, generation) = cache
            .client(true, Instant::now(), SystemTime::now())
            .unwrap();
        let url = format!("{origin}/api/sync/v1/project-v1/snapshots");
        let body = tauri::async_runtime::block_on(async {
            let response = client.get(url).send().await.unwrap();
            assert!(response.status().is_success());
            response.bytes().await.unwrap()
        });
        assert_eq!(&body[..], b"{}");
        generation
    }
    #[test]
    fn requests_in_a_row_travel_over_one_connection() {
        let (origin, accepted) = serve_counting_connections();
        let cache = ClientCache::new();
        let first = get(&cache, &origin);
        for _ in 0..5 {
            assert_eq!(get(&cache, &origin), first);
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn a_request_lost_in_transit_retires_its_client_only() {
        let (origin, accepted) = serve_counting_connections();
        let cache = ClientCache::new();
        let first = get(&cache, &origin);
        cache.retire(first);
        let second = get(&cache, &origin);
        assert_ne!(second, first);
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
        // A late failure of a request that used the retired client leaves the
        // client that replaced it in place.
        cache.retire(first);
        assert_eq!(get(&cache, &origin), second);
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn a_client_is_replaced_once_it_is_a_minute_old() {
        let cache = ClientCache::new();
        let now = Instant::now();
        let wall = SystemTime::now();
        let after = |seconds| {
            (
                now + Duration::from_secs(seconds),
                wall + Duration::from_secs(seconds),
            )
        };
        let generation = |direct: bool, (now, wall): (Instant, SystemTime)| {
            cache.client(direct, now, wall).unwrap().1
        };
        let first = generation(true, after(0));
        assert_eq!(generation(true, after(59)), first);
        let second = generation(true, after(60));
        assert_ne!(second, first);
        // Asleep, the monotonic clock stands still while the wall clock moves on.
        let third = generation(true, (after(61).0, after(3_600).1));
        assert_ne!(third, second);
        // A wall clock that was set back is not taken as proof of freshness.
        let fourth = generation(true, (after(62).0, after(0).1));
        assert_ne!(fourth, third);
        assert_eq!(generation(true, (after(63).0, after(1).1)), fourth);
        // A client that skips the proxy does not serve a request that needs one.
        assert_ne!(generation(false, (after(63).0, after(1).1)), fourth);
    }
}
