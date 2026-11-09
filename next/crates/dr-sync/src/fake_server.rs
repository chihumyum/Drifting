//! Loopback fake Hosted Sync v2 server (`127.0.0.1:0`) for offline automated
//! testing. Never connects to `api.drifting.cc`.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;

use crate::protocol::{
    CONTENT_SHA256_HEADER, ChangesPage, DEFAULT_HARD_LIMIT_BYTES, DEFAULT_QUOTA_BYTES, HostedUsage,
    OBJECT_META_HEADER, RemoteObjectPayload, RemoteObjectRecord, SYNC_NAMESPACE_LORO_V2,
    sha256_digest,
};

#[derive(Clone)]
struct StoredObject {
    record: RemoteObjectRecord,
    bytes: Vec<u8>,
}

struct ServerState {
    expected_token: String,
    offline: bool,
    remaining_ok_requests: Option<usize>,
    quota_bytes: u64,
    hard_limit_bytes: u64,
    used_bytes_override: Option<u64>,
    next_seq: u64,
    objects_by_seq: BTreeMap<u64, StoredObject>,
    seq_by_key: BTreeMap<String, u64>,
}

/// Loopback fake server implementing `/api/sync/v1/usage` and
/// `/api/sync/v1/loro-v2/...`.
pub struct FakeSyncServer {
    base_url: String,
    state: Arc<Mutex<ServerState>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl FakeSyncServer {
    pub fn start(expected_token: impl Into<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback sync server");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let addr = listener.local_addr().expect("local addr");
        let base_url = format!("http://127.0.0.1:{}", addr.port());

        let state = Arc::new(Mutex::new(ServerState {
            expected_token: expected_token.into(),
            offline: false,
            remaining_ok_requests: None,
            quota_bytes: DEFAULT_QUOTA_BYTES,
            hard_limit_bytes: DEFAULT_HARD_LIMIT_BYTES,
            used_bytes_override: None,
            next_seq: 1,
            objects_by_seq: BTreeMap::new(),
            seq_by_key: BTreeMap::new(),
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let state_bg = Arc::clone(&state);
        let stop_bg = Arc::clone(&stop);

        let handle = thread::spawn(move || {
            while !stop_bg.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = handle_connection(stream, &state_bg);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            base_url,
            state,
            stop,
            handle: Some(handle),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn set_offline(&self, offline: bool) {
        self.state.lock().expect("lock").offline = offline;
    }

    /// Allow `count` requests to succeed and then drop subsequent requests as
    /// network failures (simulating a mid-sync disconnect).
    pub fn set_fail_after_requests(&self, count: Option<usize>) {
        self.state.lock().expect("lock").remaining_ok_requests = count;
    }

    pub fn set_quota_bytes(&self, quota_bytes: u64, hard_limit_bytes: u64) {
        let mut guard = self.state.lock().expect("lock");
        guard.quota_bytes = quota_bytes;
        guard.hard_limit_bytes = hard_limit_bytes;
    }

    pub fn set_used_bytes_override(&self, used_bytes: Option<u64>) {
        self.state.lock().expect("lock").used_bytes_override = used_bytes;
    }

    pub fn set_expected_token(&self, token: impl Into<String>) {
        self.state.lock().expect("lock").expected_token = token.into();
    }

    pub fn stored_object_count(&self) -> usize {
        self.state.lock().expect("lock").objects_by_seq.len()
    }
}

impl Drop for FakeSyncServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.base_url.trim_start_matches("http://"));
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    state: &Arc<Mutex<ServerState>>,
) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
    };

    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header_str.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");

    let mut content_length = 0usize;
    let mut auth_header = String::new();
    let mut sha_header = String::new();
    let mut meta_header = String::new();

    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let k_lower = k.trim().to_ascii_lowercase();
            let v_trimmed = v.trim();
            if k_lower == "content-length" {
                content_length = v_trimmed.parse().unwrap_or(0);
            } else if k_lower == "authorization" {
                auth_header = v_trimmed.to_string();
            } else if k_lower == CONTENT_SHA256_HEADER.to_ascii_lowercase() {
                sha_header = v_trimmed.to_string();
            } else if k_lower == OBJECT_META_HEADER.to_ascii_lowercase() {
                meta_header = v_trimmed.to_string();
            }
        }
    }

    while buf.len() < header_end + content_length {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = &buf[header_end..(header_end + content_length).min(buf.len())];

    let mut guard = state.lock().expect("lock");
    if guard.offline {
        // Close socket abruptly to simulate network offline error.
        return Ok(());
    }
    if let Some(rem) = &mut guard.remaining_ok_requests {
        if *rem == 0 {
            return Ok(());
        }
        *rem -= 1;
    }

    let expected_bearer = format!("Bearer {}", guard.expected_token);
    if auth_header != expected_bearer {
        return write_json(
            &mut stream,
            401,
            &json!({ "code": "UNAUTHORIZED", "message": "Invalid bearer token" }),
        );
    }

    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let objects_prefix = format!("/api/sync/v1/{SYNC_NAMESPACE_LORO_V2}/objects/");
    let changes_path = format!("/api/sync/v1/{SYNC_NAMESPACE_LORO_V2}/changes");

    if method == "GET" && path == "/api/sync/v1/usage" {
        let used = guard.used_bytes_override.unwrap_or_else(|| {
            guard
                .objects_by_seq
                .values()
                .map(|o| o.record.byte_length)
                .sum()
        });
        let usage = HostedUsage {
            used_bytes: used,
            quota_bytes: guard.quota_bytes,
            hard_limit_bytes: guard.hard_limit_bytes,
        };
        return write_json(&mut stream, 200, &usage);
    }

    if method == "PUT"
        && let Some(encoded_key) = path.strip_prefix(&objects_prefix)
    {
        let key_bytes = match URL_SAFE_NO_PAD.decode(encoded_key) {
            Ok(b) => b,
            Err(_) => {
                return write_json(
                    &mut stream,
                    400,
                    &json!({ "code": "INVALID_KEY", "message": "Invalid base64 key" }),
                );
            }
        };
        let object_key = String::from_utf8_lossy(&key_bytes).to_string();
        let actual_sha = sha256_digest(body);
        if !sha_header.is_empty() && sha_header.to_ascii_lowercase() != actual_sha {
            return write_json(
                &mut stream,
                400,
                &json!({ "code": "DIGEST_MISMATCH", "message": "SHA-256 mismatch" }),
            );
        }

        let meta_bytes = match URL_SAFE_NO_PAD.decode(&meta_header) {
            Ok(b) => b,
            Err(_) => {
                return write_json(
                    &mut stream,
                    400,
                    &json!({ "code": "INVALID_META", "message": "Invalid metadata header" }),
                );
            }
        };
        let payload: RemoteObjectPayload = match serde_json::from_slice(&meta_bytes) {
            Ok(p) => p,
            Err(e) => {
                return write_json(
                    &mut stream,
                    400,
                    &json!({ "code": "INVALID_META", "message": e.to_string() }),
                );
            }
        };

        // Check existing object idempotency first.
        if let Some(&existing_seq) = guard.seq_by_key.get(&object_key)
            && let Some(existing) = guard.objects_by_seq.get(&existing_seq)
        {
            return write_json(&mut stream, 200, &existing.record);
        }

        let current_used = guard.used_bytes_override.unwrap_or_else(|| {
            guard
                .objects_by_seq
                .values()
                .map(|o| o.record.byte_length)
                .sum()
        });
        let incoming = body.len() as u64;
        let is_asset = matches!(payload, RemoteObjectPayload::AssetBlob { .. });
        let limit = if is_asset {
            guard.quota_bytes
        } else {
            guard.hard_limit_bytes
        };
        if current_used.saturating_add(incoming) > limit {
            return write_json(
                &mut stream,
                413,
                &json!({
                    "code": "QUOTA_EXCEEDED",
                    "message": "Cloud storage quota exceeded",
                    "usedBytes": current_used.saturating_add(incoming),
                    "quotaBytes": guard.quota_bytes,
                    "hardLimitBytes": guard.hard_limit_bytes,
                }),
            );
        }

        let seq = guard.next_seq;
        guard.next_seq += 1;
        let record = RemoteObjectRecord {
            seq,
            object_key: object_key.clone(),
            sha256: actual_sha,
            byte_length: incoming,
            created_at: "2026-11-09T03:00:00Z".into(),
            payload,
        };
        guard.seq_by_key.insert(object_key, seq);
        guard.objects_by_seq.insert(
            seq,
            StoredObject {
                record: record.clone(),
                bytes: body.to_vec(),
            },
        );
        return write_json(&mut stream, 200, &record);
    }

    if method == "GET" && path == changes_path {
        let mut cursor = 0u64;
        let mut limit = 100usize;
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "cursor" {
                    cursor = v.parse().unwrap_or(0);
                } else if k == "limit" {
                    limit = v.parse().unwrap_or(100);
                }
            }
        }
        let all_after: Vec<RemoteObjectRecord> = guard
            .objects_by_seq
            .range((cursor + 1)..)
            .map(|(_, obj)| obj.record.clone())
            .collect();
        let has_more = all_after.len() > limit;
        let changes: Vec<RemoteObjectRecord> = all_after.into_iter().take(limit).collect();
        let next_cursor = changes.last().map(|r| r.seq).unwrap_or(cursor);
        let page = ChangesPage {
            changes,
            next_cursor,
            has_more,
        };
        return write_json(&mut stream, 200, &page);
    }

    if method == "GET"
        && let Some(encoded_key) = path.strip_prefix(&objects_prefix)
    {
        let key_bytes = URL_SAFE_NO_PAD.decode(encoded_key).unwrap_or_default();
        let object_key = String::from_utf8_lossy(&key_bytes).to_string();
        if let Some(&seq) = guard.seq_by_key.get(&object_key)
            && let Some(stored) = guard.objects_by_seq.get(&seq)
        {
            return write_bytes(&mut stream, 200, &stored.record.sha256, &stored.bytes);
        }
        return write_json(
            &mut stream,
            404,
            &json!({ "code": "NOT_FOUND", "message": "Object not found" }),
        );
    }

    write_json(
        &mut stream,
        404,
        &json!({ "code": "NOT_FOUND", "message": "Unknown route" }),
    )
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn write_json<T: serde::Serialize>(
    stream: &mut TcpStream,
    status: u16,
    body: &T,
) -> std::io::Result<()> {
    let payload = serde_json::to_vec(body).unwrap_or_default();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    )?;
    stream.write_all(&payload)?;
    stream.flush()
}

fn write_bytes(
    stream: &mut TcpStream,
    status: u16,
    sha256: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} OK\r\nContent-Type: application/octet-stream\r\n{CONTENT_SHA256_HEADER}: {sha256}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(bytes)?;
    stream.flush()
}
