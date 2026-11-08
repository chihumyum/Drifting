use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use dr_agent::{ModelErrorCategory, Provider};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, catalog, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_platform::SecretStore;
use dr_shell::settings::{
    SettingsFile,
    registry::{self, Scope},
};
use dr_view_agent::connection::{
    ConnectionService, Connections, Failure, Preferences, Readiness, thinking_levels,
};
use dr_view_agent::connection_view::ConnectionView;
use futures::FutureExt as _;
use gpui::{AppContext as _, Context, Entity, IntoElement, Render, TestAppContext, Window, div};
use serde_json::{Value, json};

struct Service {
    url: String,
    request: Arc<Mutex<Option<(String, Value)>>>,
    task: Option<std::thread::JoinHandle<()>>,
}

impl Service {
    fn new(status: u16, body: String) -> Self {
        Self::sequence(vec![(status, body)])
    }
    fn sequence(replies: Vec<(u16, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let request = Arc::new(Mutex::new(None));
        let seen = request.clone();
        let task = std::thread::spawn(move || {
            for (status, body) in replies {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "no connection-test request"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0; 2048];
                loop {
                    let count = socket.read(&mut buf).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buf[..count]);
                    if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                        let length: usize = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(str::to_owned)
                            })
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            *seen.lock().unwrap() = Some((
                                header,
                                serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                                    .unwrap_or_else(|_| Value::String("form exchange".into())),
                            ));
                            break;
                        }
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        Self {
            url,
            request,
            task: Some(task),
        }
    }
    fn driver(&self, credentials: Credentials) -> ProviderDriver {
        ProviderDriver::with_endpoints(
            HttpClient::new().unwrap(),
            credentials,
            Endpoints {
                deepseek: self.url.clone(),
                anthropic: self.url.clone(),
                openai: self.url.clone(),
                chatgpt: self.url.clone(),
            },
            OAuthEndpoints::at(&self.url).unwrap(),
            RetryPolicy {
                max_attempts: 1,
                ..Default::default()
            },
        )
    }
    fn join(&mut self) {
        self.task.take().unwrap().join().unwrap();
    }
}

fn complete(text: &str) -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}})
    )
}

#[tokio::test]
async fn candidate_is_tested_with_same_driver_then_saved_and_never_logs_into_settings() {
    let credentials = Credentials::new(Arc::new(SecretStore::in_memory()));
    let mut server = Service::new(200, complete("OK"));
    let service = ConnectionService::new(server.driver(credentials.clone()));
    let model = catalog::bundled_models(Provider::Deepseek).remove(0);
    service
        .connect_key(&model, " synthetic-candidate ".into())
        .await
        .unwrap();
    server.join();
    assert_eq!(
        credentials
            .api_key(Provider::Deepseek)
            .await
            .unwrap()
            .as_deref(),
        Some("synthetic-candidate")
    );
    {
        let request = server.request.lock().unwrap();
        let (headers, body) = request.as_ref().unwrap();
        assert!(headers.contains("Bearer synthetic-candidate"));
        assert_eq!(body["messages"][1]["content"], "Return exactly OK.");
        assert!(
            body.get("tools")
                .is_none_or(|tools| tools.as_array().is_some_and(Vec::is_empty))
        );
        assert_eq!(body["max_tokens"], 32);
    }
    assert!(
        service
            .driver()
            .credentials()
            .has_api_key(Provider::Deepseek)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn failed_and_incomplete_tests_preserve_existing_key() {
    for (status, body, expected) in [
        (401, String::new(), ModelErrorCategory::Authentication),
        (200, complete("  "), ModelErrorCategory::InvalidResponse),
        (
            200,
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"}}]}\n\n".into(),
            ModelErrorCategory::InvalidResponse,
        ),
    ] {
        let credentials = Credentials::new(Arc::new(SecretStore::in_memory()));
        credentials
            .set_api_key(Provider::Deepseek, "synthetic-old")
            .await
            .unwrap();
        let mut server = Service::new(status, body);
        let service = ConnectionService::new(server.driver(credentials.clone()));
        let model = catalog::bundled_models(Provider::Deepseek).remove(0);
        assert_eq!(
            service
                .connect_key(&model, "synthetic-replacement".into())
                .await
                .unwrap_err(),
            Failure::Provider(expected)
        );
        server.join();
        assert_eq!(
            credentials
                .api_key(Provider::Deepseek)
                .await
                .unwrap()
                .as_deref(),
            Some("synthetic-old")
        );
    }
}

#[tokio::test]
async fn empty_candidate_does_not_change_the_store_or_need_http() {
    let credentials = Credentials::new(Arc::new(SecretStore::in_memory()));
    let service = ConnectionService::new(ProviderDriver::new(
        HttpClient::new().unwrap(),
        credentials.clone(),
    ));
    let model = catalog::bundled_models(Provider::Deepseek).remove(0);
    assert_eq!(
        service.connect_key(&model, "  ".into()).await.unwrap_err(),
        Failure::Empty
    );
    assert!(!credentials.has_api_key(Provider::Deepseek).await.unwrap());
}

#[test]
fn model_preferences_have_account_scope_and_typed_validation() {
    let mut file = SettingsFile::in_memory();
    for key in [
        registry::AGENT_PROVIDER,
        registry::AGENT_MODEL,
        registry::AGENT_THINKING,
        registry::AGENT_MAX_MODEL_ROUNDS,
    ] {
        assert_eq!(registry::find(key).unwrap().scope, Scope::Account);
    }
    assert!(
        file.set(registry::AGENT_PROVIDER, json!("unknown"), None)
            .is_err()
    );
    assert!(
        file.set(registry::AGENT_THINKING, json!("extra"), None)
            .is_err()
    );
    assert!(file.set(registry::AGENT_MODEL, json!(" "), None).is_err());
    for value in [json!(0), json!(-1), json!(2.5), json!(u64::MAX)] {
        assert!(
            file.set(registry::AGENT_MAX_MODEL_ROUNDS, value, None)
                .is_err()
        );
    }
    file.set(registry::AGENT_MAX_MODEL_ROUNDS, Value::Null, None)
        .unwrap();
    assert_eq!(file.get(registry::AGENT_MAX_MODEL_ROUNDS), Value::Null);
    let preferences = Preferences::default();
    assert_eq!(preferences.max_model_rounds, Some(50));
    for provider in [
        Provider::Deepseek,
        Provider::Anthropic,
        Provider::Openai,
        Provider::Chatgpt,
    ] {
        for model in catalog::bundled_models(provider) {
            for thinking in thinking_levels(&model) {
                model.run_config(thinking).unwrap();
            }
        }
    }
}

fn settle(
    cx: &mut TestAppContext,
    connections: &Entity<Connections>,
    done: impl Fn(&Connections) -> bool,
) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if connections.read_with(cx, |connections, _| done(connections)) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "connection operation did not settle"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn failed_key_preserves_route_and_success_selects_it_only_after_the_check(cx: &mut TestAppContext) {
    // This test intentionally crosses the real loopback/Tokio executor, as do
    // the shell's real-storage lifecycle tests.
    cx.executor().allow_parking();
    for status in [401, 200] {
        let store = Arc::new(SecretStore::in_memory());
        store.set("byok.openai", "synthetic-existing").unwrap();
        let mut server = Service::new(
            status,
            if status == 200 {
                complete("OK")
            } else {
                String::new()
            },
        );
        let service = ConnectionService::new(server.driver(Credentials::new(store.clone())))
            .with_catalog_endpoint(Provider::Deepseek, "http://127.0.0.1:1/models".into());
        let connections = cx.new(|cx| Connections::with_service(service, cx));
        settle(cx, &connections, |connections| {
            connections.readiness(Provider::Openai) == Readiness::Ready
                && connections.readiness(Provider::Deepseek) == Readiness::Missing
        });
        connections.update(cx, |connections, cx| {
            assert!(connections.select_provider(Provider::Openai, cx));
            connections.connect_key(Provider::Deepseek, "synthetic-candidate".into(), cx);
        });
        assert_eq!(
            connections.read_with(cx, |connections, _| connections
                .preferences()
                .route
                .provider),
            Provider::Openai
        );
        settle(cx, &connections, |connections| {
            connections.operation.is_none()
        });
        server.join();
        if status == 401 {
            assert_eq!(
                connections.read_with(cx, |connections, _| connections
                    .preferences()
                    .route
                    .provider),
                Provider::Openai
            );
            assert!(store.get("byok.deepseek").unwrap().is_none());
        } else {
            assert_eq!(
                connections.read_with(cx, |connections, _| connections
                    .preferences()
                    .route
                    .provider),
                Provider::Deepseek
            );
            assert_eq!(
                store.get("byok.deepseek").unwrap().as_deref(),
                Some("synthetic-candidate")
            );
            let frozen =
                connections.read_with(cx, |connections, _| connections.run_config().unwrap());
            connections.update(cx, |connections, cx| {
                connections.set_max_model_rounds(Some(25), cx);
            });
            assert_eq!(frozen.max_model_rounds, Some(50));
            assert_eq!(
                connections.read_with(cx, |connections, _| connections
                    .run_config()
                    .unwrap()
                    .max_model_rounds),
                Some(25)
            );
        }
    }
}

#[gpui::test]
fn cancelling_device_login_keeps_route_and_persists_no_oauth_tokens(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let store = Arc::new(SecretStore::in_memory());
    store.set("byok.openai", "synthetic-existing").unwrap();
    let mut server = Service::new(
        200,
        json!({"device_auth_id":"synthetic-device","user_code":"TEST-CODE","interval":5})
            .to_string(),
    );
    let service = ConnectionService::new(server.driver(Credentials::new(store.clone())))
        .with_catalog_endpoint(Provider::Chatgpt, "http://127.0.0.1:1/models".into());
    let connections = cx.new(|cx| Connections::with_service(service, cx));
    settle(cx, &connections, |connections| {
        connections.readiness(Provider::Openai) == Readiness::Ready
    });
    connections.update(cx, |connections, cx| {
        connections.select_provider(Provider::Openai, cx);
        assert!(connections.start_login(cx).is_some());
    });
    settle(cx, &connections, |connections| connections.login.is_some());
    assert_eq!(
        connections.read_with(cx, |connections, _| connections
            .login
            .as_ref()
            .unwrap()
            .user_code
            .clone()),
        "TEST-CODE"
    );
    connections.update(cx, |connections, cx| connections.cancel_login(cx));
    settle(cx, &connections, |connections| {
        connections.operation.is_none()
    });
    server.join();
    assert_eq!(
        connections.read_with(cx, |connections, _| connections
            .preferences()
            .route
            .provider),
        Provider::Openai
    );
    assert_eq!(
        connections.read_with(cx, |connections, _| connections.failure),
        Some(Failure::Provider(ModelErrorCategory::Cancelled))
    );
    assert!(store.get("oauth.openai-codex").unwrap().is_none());
}

struct LoginHost {
    view: Option<Entity<ConnectionView>>,
}

impl Render for LoginHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        // The host retains the view just as the companion/settings cache does.
        div()
    }
}

#[derive(Clone, Copy, Debug)]
enum CloseLogin {
    Button,
    Hidden,
    Released,
    Window,
    Release,
}

#[gpui::test]
fn closing_login_during_native_save_waits_for_logout_and_cannot_restore_tokens(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    cx.update(|cx| dr_shell::strings::Strings::install(dr_i18n::Locale::En, cx));
    for close in [
        CloseLogin::Button,
        CloseLogin::Hidden,
        CloseLogin::Released,
        CloseLogin::Window,
        CloseLogin::Release,
    ] {
        let store = Arc::new(SecretStore::in_memory());
        store.set("byok.openai", "synthetic-existing").unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let checkpoint = entered.clone();
        let (release, waiting) = std::sync::mpsc::channel();
        let waiting = Mutex::new(waiting);
        let credentials =
            Credentials::new(store.clone()).with_oauth_save_checkpoint(Arc::new(move || {
                checkpoint.store(true, Ordering::SeqCst);
                waiting
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
            }));
        let mut server = Service::sequence(vec![
            (200, json!({"device_auth_id":"synthetic-device","user_code":"TEST-CODE","interval":1}).to_string()),
            (200, json!({"authorization_code":"synthetic-code","code_verifier":"synthetic-verifier"}).to_string()),
            (200, json!({"access_token":"synthetic-access","refresh_token":"synthetic-refresh","expires_in":3600}).to_string()),
        ]);
        let service = ConnectionService::new(server.driver(credentials))
            .with_catalog_endpoint(Provider::Chatgpt, "http://127.0.0.1:1/models".into());
        let connections = cx.new(|cx| Connections::with_service(service, cx));
        settle(cx, &connections, |connections| {
            connections.readiness(Provider::Openai) == Readiness::Ready
        });
        connections.update(cx, |connections, cx| {
            connections.select_provider(Provider::Openai, cx);
        });
        let shared = connections.clone();
        let window = cx.add_window(move |window, cx| LoginHost {
            view: Some(cx.new(|cx| ConnectionView::new(shared, window, cx))),
        });
        let host = window.root(cx).unwrap();
        let view = host.read_with(cx, |host, _| host.view.clone().unwrap());
        view.update(cx, |view, cx| view.start_login(cx));
        // A repeated activation while busy must retain the original view's
        // ownership rather than losing its cancellation handle.
        view.update(cx, |view, cx| view.start_login(cx));
        // This signal is inside the real Credentials I/O lease and after its
        // generation check, not before a poll or token-exchange HTTP request.
        settle(cx, &connections, |_| entered.load(Ordering::SeqCst));
        assert!(store.get("oauth.openai-codex").unwrap().is_none());
        let shared = connections.clone();
        let observer = window
            .update(cx, |_, window, cx| {
                cx.new(|cx| ConnectionView::new(shared, window, cx))
            })
            .unwrap();
        observer.update(cx, |view, cx| view.cancel_login(cx));
        drop(observer);
        cx.run_until_parked();
        assert!(connections.read_with(cx, |connections, _| connections.login.is_some()));
        let mut release_barrier = None;
        match close {
            CloseLogin::Button => {
                connections.update(cx, |connections, cx| connections.cancel_login(cx))
            }
            CloseLogin::Hidden => view.update(cx, |view, cx| view.cancel_login(cx)),
            CloseLogin::Released => {
                host.update(cx, |host, _| host.view = None);
            }
            CloseLogin::Window => {
                window
                    .update(cx, |_, window, _| window.remove_window())
                    .unwrap();
            }
            CloseLogin::Release => {
                let barrier = connections
                    .update(cx, |connections, cx| connections.prepare_release(cx))
                    .shared();
                assert!(barrier.clone().now_or_never().is_none());
                release_barrier = Some(barrier);
            }
        }
        drop(view);
        // Entity handles dropped by test code are reclaimed at the next App
        // update; running only the executor does not flush GPUI releases.
        cx.update(|_| {});
        cx.run_until_parked();
        assert!(
            connections.read_with(cx, |connections, _| connections.login.is_none()),
            "{close:?}"
        );
        assert!(
            connections.read_with(cx, |connections, _| connections.operation.is_some()),
            "{close:?}"
        );
        // A second login cannot race the pending native write/logout cleanup.
        assert!(
            connections
                .update(cx, |connections, cx| connections.start_login(cx))
                .is_none()
        );
        release.send(()).unwrap();
        settle(cx, &connections, |connections| {
            connections.operation.is_none()
        });
        if let Some(barrier) = release_barrier {
            assert_eq!(barrier.now_or_never(), Some(Ok(())));
        }
        server.join();
        assert_eq!(
            connections.read_with(cx, |connections, _| connections
                .preferences()
                .route
                .provider),
            Provider::Openai,
            "{close:?}"
        );
        assert_eq!(
            connections.read_with(cx, |connections, _| connections.failure),
            Some(Failure::Provider(ModelErrorCategory::Cancelled)),
            "{close:?}"
        );
        assert!(
            store.get("oauth.openai-codex").unwrap().is_none(),
            "{close:?}"
        );
        assert_eq!(
            store.get("byok.openai").unwrap().as_deref(),
            Some("synthetic-existing")
        );
        if !matches!(close, CloseLogin::Window) {
            window
                .update(cx, |_, window, _| window.remove_window())
                .unwrap();
        }
    }
}

#[gpui::test]
fn dropping_connections_during_native_save_still_clears_the_completed_write(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let store = Arc::new(SecretStore::in_memory());
    let entered = Arc::new(AtomicBool::new(false));
    let checkpoint = entered.clone();
    let (release, waiting) = std::sync::mpsc::channel();
    let waiting = Mutex::new(waiting);
    let credentials =
        Credentials::new(store.clone()).with_oauth_save_checkpoint(Arc::new(move || {
            checkpoint.store(true, Ordering::SeqCst);
            waiting
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
        }));
    let mut server = Service::sequence(vec![
        (200, json!({"device_auth_id":"synthetic-device","user_code":"TEST-CODE","interval":1}).to_string()),
        (200, json!({"authorization_code":"synthetic-code","code_verifier":"synthetic-verifier"}).to_string()),
        (200, json!({"access_token":"synthetic-access","refresh_token":"synthetic-refresh","expires_in":3600}).to_string()),
    ]);
    let driver = server.driver(credentials.clone());
    let connections = cx.new(|cx| Connections::new(driver.clone(), cx));
    assert!(
        connections
            .update(cx, |connections, cx| connections.start_login(cx))
            .is_some()
    );
    settle(cx, &connections, |_| entered.load(Ordering::SeqCst));
    let weak = connections.downgrade();
    drop(connections);
    cx.update(|_| {});
    cx.run_until_parked();
    assert!(weak.upgrade().is_none());
    let cleared = Arc::new(AtomicBool::new(false));
    let observed = cleared.clone();
    let checking = driver.http().spawn(async move {
        // Reading uses the same I/O lease as the checkpoint-held write. It
        // cannot see the initial empty store and incorrectly pass this test.
        for _ in 0..1000 {
            if credentials.tokens().await.unwrap().is_none() {
                observed.store(true, Ordering::SeqCst);
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !cleared.load(Ordering::SeqCst) {
        cx.run_until_parked();
        assert!(
            std::time::Instant::now() < deadline,
            "dropped login left credentials stored"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    drop(checking);
    server.join();
    assert!(store.get("oauth.openai-codex").unwrap().is_none());
}
