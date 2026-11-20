//! Loopback fake Better Auth + Hosted server (`127.0.0.1:0`) for offline automated testing.
//!
//! Never connects to `api.drifting.cc` or any external host.

use std::cmp::Ordering as CmpOrdering;
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};

use crate::endpoint::{HostedConfig, HostedOrigin};
use crate::notices::{NOTICES_PATH, NOTICES_READ_PATH};
use crate::oauth::pkce_s256_challenge;
use crate::preferences::{
    RemotePreference, clamp_to_server_clock, compare_iso_timestamps, now_iso8601,
};
use crate::profile::{HostedUser, is_allowed_avatar_data_url, validate_profile_name};

#[derive(Debug, Clone)]
struct StoredAccount {
    user: HostedUser,
    password: String,
}

#[derive(Debug, Clone)]
struct PendingOAuthCode {
    email: String,
    name: String,
    code_challenge: String,
}

/// A notice the fake operator published (account notices v1).
#[derive(Debug, Clone)]
struct FakeNotice {
    id: String,
    seq: u64,
    /// The one account it is addressed to, or every account.
    to: Option<String>,
    content: Value,
    link: Option<String>,
    published_at: String,
}

#[derive(Default)]
struct ServerState {
    accounts_by_email: HashMap<String, StoredAccount>,
    sessions_by_token: HashMap<String, String>, // token -> email
    otps_by_email: HashMap<String, String>,     // email -> otp
    oauth_codes: HashMap<String, PendingOAuthCode>,
    preferences_by_email: HashMap<String, BTreeMap<String, RemotePreference>>,
    next_id: u64,
    require_signup_verification: bool,
    google_enabled: bool,
    preferences_supported: bool,
    server_clock_override: Option<String>,
    notices: Vec<FakeNotice>,
    /// The `seq` of the newest notice published.
    notice_seq: u64,
    notice_read_through_by_email: HashMap<String, u64>,
    notices_supported: bool,
    /// Every notices route answers this status (and no notices) while set.
    notices_failure: Option<u16>,
    /// `GET /api/account/v1/notices` answers these bytes as they are.
    notices_body: Option<String>,
    notices_refresh: Option<Value>,
    /// `"<METHOD> <path>"` → how many requests reached it.
    hits: HashMap<String, usize>,
}

/// Loopback fake server running on `127.0.0.1:0`.
pub struct FakeAuthServer {
    origin: HostedOrigin,
    state: Arc<Mutex<ServerState>>,
    stop: Arc<AtomicBool>,
    offline: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    handle: Option<JoinHandle<()>>,
}

impl FakeAuthServer {
    /// Start a new fake server bound to `127.0.0.1:0`.
    #[must_use]
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        listener
            .set_nonblocking(true)
            .expect("set_nonblocking on fake server");
        let addr = listener.local_addr().expect("local_addr");
        let origin = HostedOrigin::parse(&format!("http://{addr}")).expect("loopback origin");

        let state = Arc::new(Mutex::new(ServerState {
            require_signup_verification: true,
            google_enabled: true,
            preferences_supported: true,
            notices_supported: true,
            ..ServerState::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let offline = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));

        let state_bg = Arc::clone(&state);
        let stop_bg = Arc::clone(&stop);
        let offline_bg = Arc::clone(&offline);
        let req_bg = Arc::clone(&requests);

        let handle = thread::spawn(move || {
            while !stop_bg.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        req_bg.fetch_add(1, Ordering::SeqCst);
                        if offline_bg.load(Ordering::SeqCst) {
                            drop(stream);
                            continue;
                        }
                        let _ = handle_connection(stream, &state_bg);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            origin,
            state,
            stop,
            offline,
            requests,
            handle: Some(handle),
        }
    }

    #[must_use]
    pub fn origin(&self) -> HostedOrigin {
        self.origin.clone()
    }

    #[must_use]
    pub fn config(&self) -> HostedConfig {
        HostedConfig::with_origin(self.origin.clone())
    }

    #[must_use]
    pub fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    pub fn set_offline(&self, is_offline: bool) {
        self.offline.store(is_offline, Ordering::SeqCst);
    }

    pub fn set_require_signup_verification(&self, required: bool) {
        self.state
            .lock()
            .expect("fake state")
            .require_signup_verification = required;
    }

    /// Retrieve the most recently issued 6-digit OTP for `email`.
    #[must_use]
    pub fn last_otp_for(&self, email: &str) -> Option<String> {
        self.state
            .lock()
            .expect("fake state")
            .otps_by_email
            .get(&email.trim().to_ascii_lowercase())
            .cloned()
    }

    /// Expire a specific bearer token so subsequent `get-session` calls return `401`.
    pub fn expire_token(&self, token: &str) {
        self.state
            .lock()
            .expect("fake state")
            .sessions_by_token
            .remove(token.trim());
    }

    /// Configure whether `/api/account/v1/preferences` is enabled or returns `404 Not Found`.
    pub fn set_preferences_supported(&self, supported: bool) {
        self.state.lock().expect("fake state").preferences_supported = supported;
    }

    /// Pin the server's clock (`ISO-8601`) used to clamp future `changedAt` timestamps.
    pub fn set_server_clock(&self, clock_iso: Option<&str>) {
        self.state.lock().expect("fake state").server_clock_override =
            clock_iso.map(ToOwned::to_owned);
    }

    /// Inspect stored preferences for `email` on the fake server.
    #[must_use]
    pub fn preferences_for(&self, email: &str) -> BTreeMap<String, RemotePreference> {
        self.state
            .lock()
            .expect("fake state")
            .preferences_by_email
            .get(&email.trim().to_ascii_lowercase())
            .cloned()
            .unwrap_or_default()
    }

    /// How many requests reached `method path` (`"GET", "/api/account/v1/notices"`).
    #[must_use]
    pub fn requests_to(&self, method: &str, path: &str) -> usize {
        self.state
            .lock()
            .expect("fake state")
            .hits
            .get(&format!("{method} {path}"))
            .copied()
            .unwrap_or(0)
    }

    /// Publishes a notice to every account (`to: None`) or to the account of
    /// `to` alone; `content` is the contract's `{ "zh": { "title", "body" },
    /// "en": … }`. Returns its id.
    pub fn publish_notice(&self, to: Option<&str>, content: Value, link: Option<&str>) -> String {
        let mut guard = self.state.lock().expect("fake state");
        guard.notice_seq += 1;
        let seq = guard.notice_seq;
        let id = format!("00000000-0000-4000-8000-{seq:012}");
        let published_at = guard
            .server_clock_override
            .clone()
            .unwrap_or_else(now_iso8601);
        guard.notices.push(FakeNotice {
            id: id.clone(),
            seq,
            to: to.map(|email| email.trim().to_ascii_lowercase()),
            content,
            link: link.map(ToOwned::to_owned),
            published_at,
        });
        id
    }

    /// The operator withdraws a notice (or it expires): it is no longer offered.
    pub fn withdraw_notice(&self, id: &str) {
        self.state
            .lock()
            .expect("fake state")
            .notices
            .retain(|n| n.id != id);
    }

    /// The account's read mark for `email`.
    #[must_use]
    pub fn notice_read_through(&self, email: &str) -> u64 {
        self.state
            .lock()
            .expect("fake state")
            .notice_read_through_by_email
            .get(&email.trim().to_ascii_lowercase())
            .copied()
            .unwrap_or(0)
    }

    /// Whether the notices routes exist (`false`: they answer 404).
    pub fn set_notices_supported(&self, supported: bool) {
        self.state.lock().expect("fake state").notices_supported = supported;
    }

    /// While `Some(status)`, every notices route fails with that status.
    pub fn set_notices_failure(&self, status: Option<u16>) {
        self.state.lock().expect("fake state").notices_failure = status;
    }

    /// While `Some`, `GET /api/account/v1/notices` answers a signed-in
    /// request with `body` as it is (malformed or oversized responses).
    pub fn set_notices_body(&self, body: Option<String>) {
        self.state.lock().expect("fake state").notices_body = body;
    }

    /// The `refreshAfterSeconds` the notices route answers (`None`: 60).
    pub fn set_notices_refresh(&self, seconds: Option<Value>) {
        self.state.lock().expect("fake state").notices_refresh = seconds;
    }

    /// Simulate the browser leg of `/api/auth/native-start?...` and return the deep-link
    /// callback URL `drifting://auth/callback?code=...&nativeState=...`.
    #[must_use]
    pub fn simulate_google_oauth_redirect(
        &self,
        start_url: &str,
        email: &str,
        name: &str,
    ) -> String {
        let query = start_url.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut native_state = String::new();
        let mut code_challenge = String::new();
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                match k {
                    "nativeState" => native_state = v.to_string(),
                    "codeChallenge" => code_challenge = v.to_string(),
                    _ => {}
                }
            }
        }
        let mut guard = self.state.lock().expect("fake state");
        guard.next_id += 1;
        let code = format!("oauth-code-{}", guard.next_id);
        guard.oauth_codes.insert(
            code.clone(),
            PendingOAuthCode {
                email: email.trim().to_ascii_lowercase(),
                name: name.trim().to_string(),
                code_challenge,
            },
        );
        format!("drifting://auth/callback?code={code}&nativeState={native_state}")
    }
}

impl Drop for FakeAuthServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
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
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut buf = Vec::with_capacity(8192);
    let mut temp = [0u8; 4096];
    let mut header_end = None;
    let mut content_length = 0usize;

    loop {
        let n = stream.read(&mut temp)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&temp[..n]);
        if header_end.is_none()
            && let Some(pos) = find_subslice(&buf, b"\r\n\r\n")
        {
            header_end = Some(pos + 4);
            let headers_str = String::from_utf8_lossy(&buf[..pos]);
            for line in headers_str.lines() {
                if let Some((k, v)) = line.split_once(':')
                    && k.trim().eq_ignore_ascii_case("content-length")
                {
                    content_length = v.trim().parse().unwrap_or(0);
                }
            }
        }
        if let Some(end) = header_end
            && buf.len() >= end + content_length
        {
            break;
        }
    }

    let Some(end) = header_end else {
        return Ok(());
    };
    let head = String::from_utf8_lossy(&buf[..end]);
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let raw_path = parts.next().unwrap_or("/");
    let path = raw_path.split('?').next().unwrap_or(raw_path);

    let mut bearer_token: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':')
            && k.trim().eq_ignore_ascii_case("authorization")
        {
            let v = v.trim();
            if let Some(rest) = v
                .strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
            {
                bearer_token = Some(rest.trim().to_string());
            }
        }
    }

    let body_bytes = &buf[end..(end + content_length).min(buf.len())];
    let body_json: Value = serde_json::from_slice(body_bytes).unwrap_or_else(|_| json!({}));

    *state
        .lock()
        .expect("fake state")
        .hits
        .entry(format!("{method} {path}"))
        .or_default() += 1;
    let (status, extra_header, body_str) =
        match raw_notices_body(state, method, path, bearer_token.as_deref()) {
            Some(raw) => (200, None, raw),
            None => {
                let (status, extra_header, resp_body) =
                    route_request(state, method, path, bearer_token.as_deref(), &body_json);
                (status, extra_header, resp_body.to_string())
            }
        };
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    };

    let mut response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body_str.len()
    );
    if let Some((hk, hv)) = extra_header {
        response.push_str(&format!("{hk}: {hv}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(&body_str);
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

/// The bytes [`FakeAuthServer::set_notices_body`] set, for a signed-in
/// `GET /api/account/v1/notices`.
fn raw_notices_body(
    state: &Arc<Mutex<ServerState>>,
    method: &str,
    path: &str,
    bearer: Option<&str>,
) -> Option<String> {
    let guard = state.lock().expect("fake state");
    if method != "GET"
        || path != NOTICES_PATH
        || !guard.notices_supported
        || guard.notices_failure.is_some()
    {
        return None;
    }
    let body = guard.notices_body.clone()?;
    guard
        .sessions_by_token
        .contains_key(bearer?)
        .then_some(body)
}

/// Account notices v1, as the 0.1 client's contract describes the service
/// (`docs/hosted-sync/notices.md`).
fn route_notices(
    guard: &mut ServerState,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: &Value,
) -> (u16, Value) {
    if !guard.notices_supported {
        return (
            404,
            json!({ "code": "NOT_FOUND", "message": "Route not found" }),
        );
    }
    let Some(email) = bearer.and_then(|t| guard.sessions_by_token.get(t).cloned()) else {
        return (401, json!({ "code": "UNAUTHORIZED" }));
    };
    if let Some(status) = guard.notices_failure {
        return (
            status,
            json!({ "code": "INTERNAL", "message": "Notices unavailable" }),
        );
    }
    let mark = guard
        .notice_read_through_by_email
        .get(&email)
        .copied()
        .unwrap_or(0);
    match (method, path) {
        ("GET", NOTICES_PATH) => {
            let mut offered: Vec<&FakeNotice> = guard
                .notices
                .iter()
                .filter(|n| n.to.as_ref().is_none_or(|to| to == &email))
                .collect();
            offered.sort_by_key(|n| n.seq);
            let notices: Vec<Value> = offered
                .into_iter()
                .map(|n| {
                    json!({
                        "id": n.id,
                        "seq": n.seq,
                        "personal": n.to.is_some(),
                        "content": n.content,
                        "link": n.link,
                        "publishedAt": n.published_at,
                        "expiresAt": "2099-01-01T00:00:00.000Z",
                    })
                })
                .collect();
            let refresh = guard.notices_refresh.clone().unwrap_or_else(|| json!(60));
            (
                200,
                json!({ "notices": notices, "readThrough": mark, "refreshAfterSeconds": refresh }),
            )
        }
        ("POST", NOTICES_READ_PATH) => {
            let Some(through) = body.get("through").and_then(Value::as_u64) else {
                return (400, json!({ "code": "INVALID_REQUEST" }));
            };
            // Never back, never past the newest notice published.
            let raised = mark.max(through.min(guard.notice_seq));
            guard.notice_read_through_by_email.insert(email, raised);
            (200, json!({ "readThrough": raised }))
        }
        _ => (
            404,
            json!({ "code": "NOT_FOUND", "message": "Route not found" }),
        ),
    }
}

fn route_request(
    state: &Arc<Mutex<ServerState>>,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: &Value,
) -> (u16, Option<(&'static str, String)>, Value) {
    let mut guard = state.lock().expect("fake state");

    if path == NOTICES_PATH || path == NOTICES_READ_PATH {
        let (status, reply) = route_notices(&mut guard, method, path, bearer, body);
        return (status, None, reply);
    }

    match (method, path) {
        ("GET", "/api/auth/providers") => (200, None, json!({ "google": guard.google_enabled })),

        ("GET", "/api/auth/get-session") => {
            let Some(token) = bearer else {
                return (
                    401,
                    None,
                    json!({ "code": "UNAUTHORIZED", "message": "Missing token" }),
                );
            };
            let Some(email) = guard.sessions_by_token.get(token).cloned() else {
                return (
                    401,
                    None,
                    json!({ "code": "SESSION_EXPIRED", "message": "Session expired" }),
                );
            };
            let Some(acc) = guard.accounts_by_email.get(&email) else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            (
                200,
                None,
                json!({
                    "user": user_to_json(&acc.user),
                    "session": { "id": format!("sess-{token}") }
                }),
            )
        }

        ("POST", "/api/auth/sign-up/email") => {
            let email = body
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let password = body
                .get("password")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let name = body
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            if email.is_empty() || !email.contains('@') {
                return (
                    400,
                    None,
                    json!({ "code": "INVALID_EMAIL", "message": "Invalid email" }),
                );
            }
            if password.len() < 8 {
                return (
                    400,
                    None,
                    json!({ "code": "PASSWORD_TOO_SHORT", "message": "Password too short" }),
                );
            }
            if guard.accounts_by_email.contains_key(&email) {
                return (
                    400,
                    None,
                    json!({ "code": "USER_ALREADY_EXISTS", "message": "Email already registered" }),
                );
            }

            guard.next_id += 1;
            let user_id = format!("usr_{}", guard.next_id);
            let verified = !guard.require_signup_verification;
            let user = HostedUser {
                id: user_id,
                email: email.clone(),
                name,
                image: None,
                email_verified: verified,
            };
            guard.accounts_by_email.insert(
                email.clone(),
                StoredAccount {
                    user: user.clone(),
                    password,
                },
            );

            if verified {
                let token = issue_token(&mut guard, &email);
                (
                    200,
                    Some(("set-auth-token", token.clone())),
                    json!({ "token": token, "user": user_to_json(&user) }),
                )
            } else {
                issue_otp(&mut guard, &email);
                (
                    200,
                    None,
                    json!({ "token": Value::Null, "user": user_to_json(&user) }),
                )
            }
        }

        ("POST", "/api/auth/sign-in/email") => {
            let email = body
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let password = body.get("password").and_then(Value::as_str).unwrap_or("");

            let Some(acc) = guard.accounts_by_email.get(&email).cloned() else {
                return (
                    401,
                    None,
                    json!({ "code": "INVALID_EMAIL_OR_PASSWORD", "message": "Invalid credentials" }),
                );
            };
            if acc.password != password {
                return (
                    401,
                    None,
                    json!({ "code": "INVALID_EMAIL_OR_PASSWORD", "message": "Invalid credentials" }),
                );
            }
            if !acc.user.email_verified {
                issue_otp(&mut guard, &email);
                return (
                    403,
                    None,
                    json!({ "code": "EMAIL_NOT_VERIFIED", "message": "Email not verified" }),
                );
            }
            let token = issue_token(&mut guard, &email);
            (
                200,
                Some(("set-auth-token", token.clone())),
                json!({ "token": token, "user": user_to_json(&acc.user) }),
            )
        }

        ("POST", "/api/auth/email-otp/send-verification-otp") => {
            let email = body
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if email.is_empty() {
                return (
                    400,
                    None,
                    json!({ "code": "INVALID_EMAIL", "message": "Missing email" }),
                );
            }
            // Ensure account exists for sign-in OTP so passwordless email OTP works for new or existing users.
            if !guard.accounts_by_email.contains_key(&email) {
                guard.next_id += 1;
                let id = format!("usr_{}", guard.next_id);
                guard.accounts_by_email.insert(
                    email.clone(),
                    StoredAccount {
                        user: HostedUser {
                            id,
                            email: email.clone(),
                            name: String::new(),
                            image: None,
                            email_verified: true,
                        },
                        password: String::new(),
                    },
                );
            }
            issue_otp(&mut guard, &email);
            (200, None, json!({ "status": true }))
        }

        ("POST", "/api/auth/email-otp/verify-email") => {
            let email = body
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let otp = body.get("otp").and_then(Value::as_str).unwrap_or("").trim();

            if !verify_and_consume_otp(&mut guard, &email, otp) {
                return (
                    400,
                    None,
                    json!({ "code": "INVALID_OTP", "message": "Invalid verification code" }),
                );
            }
            let Some(acc) = guard.accounts_by_email.get_mut(&email) else {
                return (
                    404,
                    None,
                    json!({ "code": "USER_NOT_FOUND", "message": "User not found" }),
                );
            };
            acc.user.email_verified = true;
            let user = acc.user.clone();
            let token = issue_token(&mut guard, &email);
            (
                200,
                Some(("set-auth-token", token.clone())),
                json!({ "status": true, "token": token, "user": user_to_json(&user) }),
            )
        }

        ("POST", "/api/auth/sign-in/email-otp") => {
            let email = body
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let otp = body.get("otp").and_then(Value::as_str).unwrap_or("").trim();

            if !verify_and_consume_otp(&mut guard, &email, otp) {
                return (
                    400,
                    None,
                    json!({ "code": "INVALID_OTP", "message": "Invalid verification code" }),
                );
            }
            let Some(acc) = guard.accounts_by_email.get_mut(&email) else {
                return (
                    404,
                    None,
                    json!({ "code": "USER_NOT_FOUND", "message": "User not found" }),
                );
            };
            acc.user.email_verified = true;
            let user = acc.user.clone();
            let token = issue_token(&mut guard, &email);
            (
                200,
                Some(("set-auth-token", token.clone())),
                json!({ "token": token, "user": user_to_json(&user) }),
            )
        }

        ("POST", "/api/auth/email-otp/request-password-reset") => {
            let email = body
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if guard.accounts_by_email.contains_key(&email) {
                issue_otp(&mut guard, &email);
            }
            (200, None, json!({ "status": true }))
        }

        ("POST", "/api/auth/email-otp/reset-password") => {
            let email = body
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let otp = body.get("otp").and_then(Value::as_str).unwrap_or("").trim();
            let new_password = body.get("password").and_then(Value::as_str).unwrap_or("");
            if new_password.len() < 8 {
                return (
                    400,
                    None,
                    json!({ "code": "PASSWORD_TOO_SHORT", "message": "Password too short" }),
                );
            }
            if !verify_and_consume_otp(&mut guard, &email, otp) {
                return (
                    400,
                    None,
                    json!({ "code": "INVALID_OTP", "message": "Invalid verification code" }),
                );
            }
            if let Some(acc) = guard.accounts_by_email.get_mut(&email) {
                acc.password = new_password.to_string();
                acc.user.email_verified = true;
            }
            (200, None, json!({ "status": true }))
        }

        ("POST", "/api/auth/native-exchange") => {
            let code = body
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let verifier = body
                .get("codeVerifier")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();

            let Some(pending) = guard.oauth_codes.remove(code) else {
                return (
                    400,
                    None,
                    json!({ "code": "INVALID_OAUTH_CODE", "message": "Invalid or expired OAuth code" }),
                );
            };
            let computed = pkce_s256_challenge(verifier);
            if computed != pending.code_challenge {
                return (
                    400,
                    None,
                    json!({ "code": "OAUTH_STATE_MISMATCH", "message": "PKCE verifier mismatch" }),
                );
            }

            let email = pending.email.clone();
            if !guard.accounts_by_email.contains_key(&email) {
                guard.next_id += 1;
                let id = format!("usr_{}", guard.next_id);
                guard.accounts_by_email.insert(
                    email.clone(),
                    StoredAccount {
                        user: HostedUser {
                            id,
                            email: email.clone(),
                            name: pending.name,
                            image: None,
                            email_verified: true,
                        },
                        password: String::new(),
                    },
                );
            }
            let user = guard
                .accounts_by_email
                .get(&email)
                .expect("account exists")
                .user
                .clone();
            let token = issue_token(&mut guard, &email);
            (
                200,
                Some(("set-auth-token", token.clone())),
                json!({ "token": token, "user": user_to_json(&user) }),
            )
        }

        ("POST", "/api/auth/update-user") => {
            let Some(token) = bearer else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let Some(email) = guard.sessions_by_token.get(token).cloned() else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let Some(acc) = guard.accounts_by_email.get_mut(&email) else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };

            if let Some(name_val) = body.get("name") {
                let Some(raw_name) = name_val.as_str() else {
                    return (400, None, json!({ "code": "INVALID_NAME" }));
                };
                let Ok(valid) = validate_profile_name(raw_name) else {
                    return (400, None, json!({ "code": "INVALID_NAME" }));
                };
                acc.user.name = valid;
            }
            if let Some(image_val) = body.get("image") {
                if image_val.is_null() {
                    acc.user.image = None;
                } else if let Some(s) = image_val.as_str() {
                    if !is_allowed_avatar_data_url(s) {
                        return (400, None, json!({ "code": "INVALID_AVATAR" }));
                    }
                    acc.user.image = Some(s.to_string());
                } else {
                    return (400, None, json!({ "code": "INVALID_AVATAR" }));
                }
            }
            let updated = acc.user.clone();
            (
                200,
                None,
                json!({ "status": true, "user": user_to_json(&updated) }),
            )
        }

        ("POST", "/api/auth/change-password") => {
            let Some(token) = bearer else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let Some(email) = guard.sessions_by_token.get(token).cloned() else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let current_pw = body
                .get("currentPassword")
                .and_then(Value::as_str)
                .unwrap_or("");
            let new_pw = body
                .get("newPassword")
                .and_then(Value::as_str)
                .unwrap_or("");
            let revoke_others = body
                .get("revokeOtherSessions")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            {
                let Some(acc) = guard.accounts_by_email.get_mut(&email) else {
                    return (401, None, json!({ "code": "UNAUTHORIZED" }));
                };
                if acc.password != current_pw {
                    return (
                        400,
                        None,
                        json!({ "code": "INVALID_PASSWORD", "message": "Incorrect current password" }),
                    );
                }
                if new_pw.len() < 8 {
                    return (
                        400,
                        None,
                        json!({ "code": "PASSWORD_TOO_SHORT", "message": "Password too short" }),
                    );
                }
                acc.password = new_pw.to_string();
            }

            if revoke_others {
                guard.sessions_by_token.retain(|_, v| v != &email);
            } else {
                guard.sessions_by_token.remove(token);
            }
            let replacement = issue_token(&mut guard, &email);
            let user = guard.accounts_by_email[&email].user.clone();
            (
                200,
                Some(("set-auth-token", replacement.clone())),
                json!({ "token": replacement, "user": user_to_json(&user) }),
            )
        }

        ("POST", "/api/auth/sign-out") => {
            if let Some(tok) = bearer {
                guard.sessions_by_token.remove(tok);
            }
            (200, None, json!({ "success": true }))
        }

        ("GET", "/api/account/v1/preferences") => {
            if !guard.preferences_supported {
                return (
                    404,
                    None,
                    json!({ "code": "NOT_FOUND", "message": "Preferences endpoint not supported" }),
                );
            }
            let Some(token) = bearer else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let Some(email) = guard.sessions_by_token.get(token).cloned() else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let prefs = guard
                .preferences_by_email
                .get(&email)
                .cloned()
                .unwrap_or_default();
            (200, None, json!({ "preferences": prefs }))
        }

        ("PUT", "/api/account/v1/preferences") => {
            if !guard.preferences_supported {
                return (
                    404,
                    None,
                    json!({ "code": "NOT_FOUND", "message": "Preferences endpoint not supported" }),
                );
            }
            let Some(token) = bearer else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let Some(email) = guard.sessions_by_token.get(token).cloned() else {
                return (401, None, json!({ "code": "UNAUTHORIZED" }));
            };
            let server_now = guard
                .server_clock_override
                .clone()
                .unwrap_or_else(now_iso8601);
            let entries = body
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let store = guard.preferences_by_email.entry(email).or_default();
            for item in entries {
                let Some(key) = item.get("key").and_then(Value::as_str) else {
                    continue;
                };
                let Some(value) = item.get("value") else {
                    continue;
                };
                let raw_at = item
                    .get("changedAt")
                    .and_then(Value::as_str)
                    .unwrap_or(&server_now);
                let effective_at = clamp_to_server_clock(raw_at, &server_now);
                let should_write = match store.get(key) {
                    Some(existing) => {
                        compare_iso_timestamps(&effective_at, &existing.changed_at)
                            != CmpOrdering::Less
                    }
                    None => true,
                };
                if should_write {
                    store.insert(
                        key.to_owned(),
                        RemotePreference {
                            value: value.clone(),
                            changed_at: effective_at,
                        },
                    );
                }
            }
            let snapshot = store.clone();
            (200, None, json!({ "preferences": snapshot }))
        }

        _ => (
            404,
            None,
            json!({ "code": "NOT_FOUND", "message": "Route not found" }),
        ),
    }
}

fn issue_token(state: &mut ServerState, email: &str) -> String {
    state.next_id += 1;
    let tok = format!("tok_{}", state.next_id);
    state
        .sessions_by_token
        .insert(tok.clone(), email.to_string());
    tok
}

fn issue_otp(state: &mut ServerState, email: &str) -> String {
    state.next_id += 1;
    let otp = format!("{:06}", (state.next_id * 137) % 1_000_000);
    state.otps_by_email.insert(email.to_string(), otp.clone());
    otp
}

fn verify_and_consume_otp(state: &mut ServerState, email: &str, otp: &str) -> bool {
    let Some(expected) = state.otps_by_email.get(email) else {
        return false;
    };
    if expected != otp {
        return false;
    }
    state.otps_by_email.remove(email);
    true
}

fn user_to_json(user: &HostedUser) -> Value {
    json!({
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "image": user.image,
        "emailVerified": user.email_verified,
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
