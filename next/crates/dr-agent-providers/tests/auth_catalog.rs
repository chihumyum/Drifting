//! OAuth and discovery use only an in-process loopback HTTP fixture. Platform
//! compatibility has a separate opt-in test with a unique credential service.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine;
use dr_agent::{ModelErrorCategory, Provider, ThinkingLevel};
use dr_agent_providers::HttpClient;
use dr_agent_providers::catalog::{CACHE_MS, CatalogCache, CatalogSource, bundled_models, profile};
use dr_agent_providers::credentials::{Credentials, StoredTokens};
use dr_agent_providers::oauth::{self, CLIENT_ID, OAuth, OAuthCancellation, OAuthEndpoints};
use dr_platform::secrets::{SecretStore, keys};
use serde_json::{Value, json};

struct Reply {
    status: u16,
    body: Value,
    headers: Vec<(String, String)>,
    delay: Duration,
}
impl Reply {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            headers: Vec::new(),
            delay: Duration::ZERO,
        }
    }
    fn header(mut self, key: &str, value: &str) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }
    fn delay(mut self, millis: u64) -> Self {
        self.delay = Duration::from_millis(millis);
        self
    }
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    fn new(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut replies = VecDeque::from(replies);
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let Some(request) = read_request(&mut stream) else {
                            continue;
                        };
                        captured.lock().unwrap().push(request);
                        let reply = replies
                            .pop_front()
                            .unwrap_or_else(|| Reply::json(500, json!({"unexpected":true})));
                        std::thread::sleep(reply.delay);
                        let body = serde_json::to_vec(&reply.body).unwrap();
                        let mut headers = format!(
                            "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n",
                            reply.status,
                            body.len()
                        );
                        for (key, value) in reply.headers {
                            headers.push_str(&format!("{key}: {value}\r\n"));
                        }
                        headers.push_str("\r\n");
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.write_all(&body);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn read_request(stream: &mut TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let n = stream.read(&mut buffer).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..end]);
            let len = head
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + len {
                return String::from_utf8(bytes).ok();
            }
        }
    }
}

fn credentials() -> (Arc<SecretStore>, Credentials) {
    let store = Arc::new(SecretStore::in_memory());
    let credentials = Credentials::new(store.clone());
    (store, credentials)
}
fn token(claims: Value) -> String {
    format!(
        "synthetic.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap())
    )
}

#[tokio::test]
async fn legacy_keys_migrate_and_oauth_json_remains_byte_compatible() {
    let (store, credentials) = credentials();
    for (provider, key) in [
        (Provider::Deepseek, "byok.deepseek"),
        (Provider::Openai, "byok.openai"),
    ] {
        store.set(key, "synthetic-old-key").unwrap();
        assert_eq!(
            credentials.api_key(provider).await.unwrap().as_deref(),
            Some("synthetic-old-key")
        );
    }
    store
        .set("byok.agent.anthropic", "synthetic-legacy-anthropic")
        .unwrap();
    assert_eq!(
        credentials
            .api_key(Provider::Anthropic)
            .await
            .unwrap()
            .as_deref(),
        Some("synthetic-legacy-anthropic")
    );
    assert_eq!(
        store.get("byok.anthropic").unwrap().as_deref(),
        Some("synthetic-legacy-anthropic")
    );
    assert!(store.get("byok.agent.anthropic").unwrap().is_none());
    let old = json!({"access_token":"synthetic-access","refresh_token":"synthetic-refresh","expires_at_ms":9_999_999_999_999_u64,"id_token":"synthetic-id"});
    store.set("oauth.openai-codex", &old.to_string()).unwrap();
    let tokens = credentials.tokens().await.unwrap().unwrap();
    assert_eq!(serde_json::to_value(&tokens).unwrap(), old);
    credentials.save_tokens(&tokens).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&store.get("oauth.openai-codex").unwrap().unwrap()).unwrap(),
        old
    );
    assert!(!format!("{tokens:?}").contains("synthetic-access"));
    credentials
        .remove_api_key(Provider::Anthropic)
        .await
        .unwrap();
    assert!(
        credentials
            .api_key(Provider::Anthropic)
            .await
            .unwrap()
            .is_none()
    );
    store.set("oauth.openai-codex", "{broken").unwrap();
    assert!(credentials.tokens().await.unwrap().is_none());
}

#[cfg(any(target_os = "macos", windows))]
#[tokio::test]
#[ignore = "uses only a fresh test service in the operating-system credential store"]
async fn legacy_native_keyring_and_new_credentials_read_each_others_values() {
    struct Cleanup {
        service: String,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for key in [
                "byok.openai",
                "byok.anthropic",
                "byok.agent.anthropic",
                "oauth.openai-codex",
            ] {
                let _ = SecretStore::system(&self.service).delete(key);
            }
        }
    }
    let cleanup = Cleanup {
        service: format!("Drifting.test.m28.{}", dr_model::id::new_uuid_v7()),
    };
    let store = Arc::new(SecretStore::system(&cleanup.service));
    let credentials = Credentials::new(store);
    let old = keyring::Entry::new(&cleanup.service, "byok.openai").unwrap();
    old.set_password("synthetic-legacy-key").unwrap();
    assert_eq!(
        credentials
            .api_key(Provider::Openai)
            .await
            .unwrap()
            .as_deref(),
        Some("synthetic-legacy-key")
    );
    credentials
        .set_api_key(Provider::Openai, "synthetic-new-key")
        .await
        .unwrap();
    assert_eq!(old.get_password().unwrap(), "synthetic-new-key");
    let old_tokens = keyring::Entry::new(&cleanup.service, "oauth.openai-codex").unwrap();
    old_tokens.set_password(r#"{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","expires_at_ms":9999999999999}"#).unwrap();
    let tokens = credentials.tokens().await.unwrap().unwrap();
    credentials.save_tokens(&tokens).await.unwrap();
    assert_eq!(
        serde_json::from_str::<StoredTokens>(&old_tokens.get_password().unwrap()).unwrap(),
        tokens
    );
}

#[tokio::test]
async fn device_flow_polls_pending_exchanges_pkce_and_stores_legacy_tokens() {
    let access = token(
        json!({"https://api.openai.com/auth":{"chatgpt_account_id":"synthetic-account","chatgpt_plan_type":"plus"},"email":"synthetic@example.invalid"}),
    );
    let server = Server::new(vec![
        Reply::json(
            200,
            json!({"device_auth_id":"synthetic-device","usercode":"ABCD","interval":"1"}),
        ),
        Reply::json(403, json!({"status":"pending"})),
        Reply::json(
            200,
            json!({"authorization_code":"synthetic-code","code_verifier":"synthetic-verifier"}),
        ),
        Reply::json(
            200,
            json!({"access_token":access,"refresh_token":"synthetic-refresh","expires_in":3600}),
        ),
    ]);
    let (store, credentials) = credentials();
    let oauth = OAuth::new(credentials, OAuthEndpoints::at(&server.url).unwrap());
    let http = HttpClient::new().unwrap();
    let cancel = OAuthCancellation::default();
    let mut device = oauth.start(http.raw(), &cancel).await.unwrap();
    assert_eq!(device.interval_ms, 1000);
    device.interval_ms = 1;
    let summary = oauth.complete(http.raw(), &device, &cancel).await.unwrap();
    assert_eq!(summary.account_id.as_deref(), Some("synthetic-account"));
    assert_eq!(summary.email.as_deref(), Some("synthetic@example.invalid"));
    assert_eq!(summary.plan.as_deref(), Some("plus"));
    let requests = server.requests();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].starts_with("POST /api/accounts/deviceauth/usercode "));
    assert!(requests[0].contains(CLIENT_ID));
    assert!(requests[1].starts_with("POST /api/accounts/deviceauth/token "));
    assert!(requests[1].contains("synthetic-device"));
    assert!(requests[3].contains("grant_type=authorization_code"));
    assert!(requests[3].contains("code_verifier=synthetic-verifier"));
    assert!(requests[3].contains("redirect_uri=http%3A%2F%2F127.0.0.1"));
    assert!(store.get(keys::CHATGPT_SUBSCRIPTION).unwrap().is_some());
    let auth = oauth
        .authorization(http.raw(), false, &cancel)
        .await
        .unwrap();
    assert_eq!(auth.account_id, summary.account_id);
    let request = auth.apply(http.raw().get(&server.url)).build().unwrap();
    assert_eq!(request.headers()["originator"], "codex_cli_rs");
    assert_eq!(request.headers()["chatgpt-account-id"], "synthetic-account");
    oauth.logout().await.unwrap();
    assert!(oauth.status().await.unwrap().is_none());
}

#[tokio::test]
async fn cancelling_device_poll_and_expired_code_cannot_save_or_send_late_requests() {
    let server = Server::new(vec![
        Reply::json(
            200,
            json!({"device_auth_id":"device","user_code":"CODE","interval":1}),
        ),
        Reply::json(
            200,
            json!({"authorization_code":"code","code_verifier":"verifier"}),
        )
        .delay(150),
    ]);
    let (_, credentials) = credentials();
    let oauth = OAuth::new(
        credentials.clone(),
        OAuthEndpoints::at(&server.url).unwrap(),
    );
    let http = HttpClient::new().unwrap();
    let cancel = OAuthCancellation::default();
    let mut device = oauth.start(http.raw(), &cancel).await.unwrap();
    device.interval_ms = 1;
    let cancelling = cancel.clone();
    let stop = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(15)).await;
        cancelling.cancel();
    });
    assert_eq!(
        oauth
            .complete(http.raw(), &device, &cancel)
            .await
            .unwrap_err()
            .category,
        ModelErrorCategory::Cancelled
    );
    stop.await.unwrap();
    assert!(credentials.tokens().await.unwrap().is_none());
    device.expires_at_ms = oauth::now_ms();
    let uncancelled = OAuthCancellation::default();
    let before = server.requests().len();
    assert!(
        oauth
            .complete(http.raw(), &device, &uncancelled)
            .await
            .is_err()
    );
    assert_eq!(server.requests().len(), before);
}

#[tokio::test]
async fn concurrent_refreshes_rotate_once_and_preserve_omitted_refresh_token() {
    let server = Server::new(vec![
        Reply::json(
            200,
            json!({"access_token":"synthetic-new-access","expires_in":3600}),
        )
        .delay(40),
    ]);
    let (_, credentials) = credentials();
    credentials
        .save_tokens(&StoredTokens {
            access_token: "synthetic-old-access".into(),
            refresh_token: "synthetic-refresh".into(),
            expires_at_ms: 1,
            id_token: None,
        })
        .await
        .unwrap();
    let oauth = OAuth::new(
        credentials.clone(),
        OAuthEndpoints::at(&server.url).unwrap(),
    );
    let http = HttpClient::new().unwrap();
    let cancel = OAuthCancellation::default();
    let (a, b) = tokio::join!(
        oauth.authorization(http.raw(), false, &cancel),
        oauth.authorization(http.raw(), false, &cancel)
    );
    assert_eq!(a.unwrap().access_token, b.unwrap().access_token);
    assert_eq!(server.requests().len(), 1);
    assert!(server.requests()[0].contains("grant_type=refresh_token"));
    assert_eq!(
        credentials.tokens().await.unwrap().unwrap().refresh_token,
        "synthetic-refresh"
    );
}

#[tokio::test]
async fn logout_invalidates_in_flight_refresh_before_credential_storage() {
    let server = Server::new(vec![
        Reply::json(
            200,
            json!({"access_token":"synthetic-new","expires_in":3600}),
        )
        .delay(40),
    ]);
    let (_, credentials) = credentials();
    credentials
        .save_tokens(&StoredTokens {
            access_token: "synthetic-old".into(),
            refresh_token: "synthetic-refresh".into(),
            expires_at_ms: 1,
            id_token: None,
        })
        .await
        .unwrap();
    let oauth = OAuth::new(
        credentials.clone(),
        OAuthEndpoints::at(&server.url).unwrap(),
    );
    let http = HttpClient::new().unwrap();
    let refreshing = oauth.clone();
    let client = http.raw().clone();
    let refresh = tokio::spawn(async move {
        refreshing
            .authorization(&client, false, &OAuthCancellation::default())
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while server.requests().is_empty() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    oauth.logout().await.unwrap();
    assert_eq!(
        refresh.await.unwrap().unwrap_err().category,
        ModelErrorCategory::Cancelled
    );
    assert!(credentials.tokens().await.unwrap().is_none());
}

#[tokio::test]
async fn catalogs_expire_after_five_minutes_and_are_isolated_by_credential() {
    let page = |id| {
        Reply::json(
            200,
            json!({"data":[{"id":id,"name":"Synthetic model","context_window":262144,"max_output_tokens":32768,"effort":{"supported_levels":["low","high","max"],"default_level":"low"}}]}),
        )
    };
    let server = Server::new(vec![
        page("deepseek-test-a"),
        page("deepseek-test-b"),
        page("deepseek-test-c"),
    ]);
    let http = HttpClient::new().unwrap();
    let cache = CatalogCache::default();
    let endpoint = format!("{}/models", server.url);
    let a = cache
        .list_with_key_at(http.raw(), Provider::Deepseek, "key-a", &endpoint, 100)
        .await;
    assert_eq!(a.source, CatalogSource::Live);
    let cached = cache
        .list_with_key_at(
            http.raw(),
            Provider::Deepseek,
            "key-a",
            &endpoint,
            100 + CACHE_MS - 1,
        )
        .await;
    assert_eq!(cached.source, CatalogSource::Cache);
    assert_eq!(server.requests().len(), 1);
    let b = cache
        .list_with_key_at(
            http.raw(),
            Provider::Deepseek,
            "key-a",
            &endpoint,
            100 + CACHE_MS,
        )
        .await;
    assert_eq!(b.models[0].id, "deepseek-test-b");
    let c = cache
        .list_with_key_at(
            http.raw(),
            Provider::Deepseek,
            "key-b",
            &endpoint,
            100 + CACHE_MS,
        )
        .await;
    assert_eq!(c.models[0].id, "deepseek-test-c");
    assert_eq!(server.requests().len(), 3);
    assert_eq!(c.models[0].published_context_window, Some(262144));
    assert_eq!(c.models[0].default_effort, "low");
    let config = c.models[0].run_config(ThinkingLevel::Low).unwrap();
    assert_eq!(config.capabilities.unwrap().max_output_tokens, Some(32768));
    assert!(c.models[0].run_config(ThinkingLevel::Medium).is_err());
}

#[tokio::test]
async fn anthropic_pagination_preserves_metadata_and_openai_filters_specialists() {
    let server = Server::new(vec![
        Reply::json(
            200,
            json!({"data":[{"id":"claude-synthetic-a","max_input_tokens":400000,"max_tokens":50000,"capabilities":{"thinking":{"types":{"adaptive":{"supported":true}}},"effort":{"supported":true,"high":{"supported":true},"max":{"supported":true}}}}],"has_more":true,"last_id":"claude-synthetic-a"}),
        ),
        Reply::json(
            200,
            json!({"data":[{"id":"claude-synthetic-b","display_name":"Synthetic B"}],"has_more":false}),
        ),
        Reply::json(
            200,
            json!({"data":[{"id":"gpt-6.1-sol"},{"id":"gpt-7-synthetic","owned_by":"private-owner"},{"id":"gpt-7-audio"},{"id":"gpt-7-codex"},{"id":"gpt-7-2026-11-08"},{"id":"ft:gpt-7:private"},{"id":"gpt-4-old"}]}),
        ),
    ]);
    let http = HttpClient::new().unwrap();
    let cache = CatalogCache::default();
    let endpoint = format!("{}/models", server.url);
    let a = cache
        .list_with_key_at(http.raw(), Provider::Anthropic, "synthetic", &endpoint, 0)
        .await;
    assert_eq!(a.source, CatalogSource::Live);
    assert_eq!(a.models.len(), 2);
    assert!(server.requests()[1].contains("after_id=claude-synthetic-a"));
    assert!(
        server.requests()[0]
            .to_ascii_lowercase()
            .contains("anthropic-version: 2023-06-01")
    );
    assert_eq!(a.models[0].max_output_tokens, Some(50000));
    assert_eq!(a.models[0].efforts, ["high", "max"]);
    assert!(a.models[0].run_config(ThinkingLevel::Off).is_err());
    let o = cache
        .list_with_key_at(http.raw(), Provider::Openai, "synthetic", &endpoint, 0)
        .await;
    assert_eq!(o.models.len(), 2);
    assert_eq!(o.models[0].id, "gpt-6.1-sol");
    let unknown = &o.models[1];
    assert!(unknown.published_context_window.is_none());
    assert!(unknown.max_output_tokens.is_none());
    assert!(
        unknown
            .run_config(ThinkingLevel::High)
            .unwrap()
            .capabilities
            .unwrap()
            .context_window
            .is_none()
    );
    assert!(
        !serde_json::to_string(&o.models)
            .unwrap()
            .contains("private-owner")
    );
}

#[tokio::test]
async fn failed_or_unrecognized_catalog_uses_exact_bundled_fallback() {
    let server = Server::new(vec![
        Reply::json(500, json!({"echo":"synthetic-secret-must-not-escape"})),
        Reply::json(200, json!({"data":[]})),
    ]);
    let http = HttpClient::new().unwrap();
    let cache = CatalogCache::default();
    let endpoint = format!("{}/models", server.url);
    let a = cache
        .list_with_key_at(http.raw(), Provider::Deepseek, "synthetic", &endpoint, 0)
        .await;
    assert_eq!(a.source, CatalogSource::Bundled);
    assert_eq!(a.models, bundled_models(Provider::Deepseek));
    assert_eq!(a.failure, Some(ModelErrorCategory::Network));
    let b = cache
        .list_with_key_at(http.raw(), Provider::Anthropic, "synthetic", &endpoint, 0)
        .await;
    assert_eq!(b.models, bundled_models(Provider::Anthropic));
    assert_eq!(
        profile(Provider::Anthropic, "claude-haiku-4-5-20251001")
            .unwrap()
            .max_output_tokens,
        Some(64000)
    );
    assert_eq!(
        profile(Provider::Deepseek, "deepseek-v4-flash").unwrap().id,
        "deepseek-flash"
    );
    assert_eq!(
        bundled_models(Provider::Openai)
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]
    );
    assert!(!format!("{a:?}").contains("synthetic-secret"));
}

#[tokio::test]
async fn codex_catalog_revalidates_etag_and_preserves_account_visibility() {
    let server=Server::new(vec![
        Reply::json(200,json!({"models":[{"slug":"synthetic-listed","visibility":"list","supported_in_api":false,"context_window":400000,"supported_reasoning_levels":[{"effort":"none"},{"effort":"high"},{"effort":"ultra"}],"default_reasoning_level":"high","supports_reasoning_summary_parameter":true,"support_verbosity":true},{"slug":"synthetic-hidden","visibility":"hide"},{"slug":"gpt-6.1-sol","visibility":"list"}]})).header("etag","\"synthetic-v1\"").header("cache-control","no-cache"),
        Reply::json(304,Value::Null).header("cache-control","max-age=600").header("age","300"),
    ]);
    let (_, credentials) = credentials();
    credentials
        .save_tokens(&StoredTokens {
            access_token: token(json!({"chatgpt_account_id":"synthetic-account"})),
            refresh_token: "synthetic-refresh".into(),
            expires_at_ms: oauth::now_ms() + 3_600_000,
            id_token: None,
        })
        .await
        .unwrap();
    let oauth = OAuth::new(credentials, OAuthEndpoints::at(&server.url).unwrap());
    let http = HttpClient::new().unwrap();
    let cache = CatalogCache::default();
    let cancel = OAuthCancellation::default();
    let endpoint = format!("{}/models", server.url);
    let a = cache
        .list_chatgpt(http.raw(), &oauth, &cancel, Some(&endpoint))
        .await;
    assert_eq!(a.source, CatalogSource::Live);
    assert_eq!(a.models.len(), 2);
    assert!(a.models[0].max_output_tokens.is_none());
    let config = a.models[0].run_config(ThinkingLevel::Ultra).unwrap();
    assert_eq!(config.capabilities.unwrap().supports_summary, Some(true));
    assert_eq!(a.models[1].context_window, Some(32_768));
    assert_eq!(a.models[1].thinking_modes, ["off"]);
    assert!(a.models[1].run_config(ThinkingLevel::High).is_err());
    assert!(
        a.models[1]
            .run_config(ThinkingLevel::Off)
            .unwrap()
            .capabilities
            .unwrap()
            .context_window
            .is_none()
    );
    let b = cache
        .list_chatgpt(http.raw(), &oauth, &cancel, Some(&endpoint))
        .await;
    assert_eq!(b.models, a.models);
    assert_eq!(b.refresh_after_ms, CACHE_MS);
    assert_eq!(server.requests().len(), 2);
    assert!(
        server.requests()[1]
            .to_ascii_lowercase()
            .contains("if-none-match: \"synthetic-v1\"")
    );
    assert!(server.requests()[0].contains("client_version=0.166.0"));
}
