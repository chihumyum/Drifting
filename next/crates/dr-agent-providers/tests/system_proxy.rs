//! The model providers and their sign-in take the system's proxy, a model
//! server on this computer never does (`dr_platform::proxy`). A custom
//! service on the internet (「自定义服务」, CA 2026-11-24) takes it too, for
//! its model list and its chat alike. The test runs again with a fake proxy
//! as the system's (its proxy variables), so this machine's own proxy
//! settings never count; the fake proxy refuses every tunnel itself, so
//! nothing reaches a real service.

use std::sync::Arc;

use dr_agent::{
    Cancellation, Driver, DriverRequest, LocalRoute, Provider, RequestPurpose, RunConfig,
};
use dr_agent_providers::local::{self, DiscoverError, LocalAddress};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_platform::SecretStore;
use dr_platform::feedback::fake_service::FakeService;
use dr_platform::proxy::fake::rerun_through;
use futures::StreamExt;
use serde_json::json;

/// One chat request on a custom route, to `base_url`.
fn chat(base_url: &str) -> DriverRequest {
    let mut config = RunConfig::new(Provider::Local, "example-chat-large");
    config.route.local = Some(LocalRoute {
        server: "synthetic-server".into(),
        base_url: base_url.into(),
    });
    DriverRequest {
        purpose: RequestPurpose::Chat,
        config: Arc::new(config),
        session: "session".into(),
        turn: 1,
        round: 1,
        conversation: vec![ConversationEntry {
            id: "session:1".into(),
            session: "session".into(),
            turn: 1,
            kind: ConversationEntryKind::User,
            payload: json!({"text":"synthetic request"}),
        }],
        tools: Vec::new(),
        images: Default::default(),
    }
}

#[test]
fn providers_take_the_system_proxy_and_a_local_model_server_never_does() {
    let Some(proxy) =
        rerun_through("providers_take_the_system_proxy_and_a_local_model_server_never_does")
    else {
        let http = HttpClient::new().unwrap();
        let service = FakeService::start(&[200]);
        let address = LocalAddress::parse(&service.base).unwrap();
        let asking = http.clone();
        let checked = futures::executor::block_on(
            http.spawn(async move { local::check(&asking, &address, None).await }),
        )
        .unwrap();
        assert_eq!(checked, Ok(()));
        let received = service
            .next()
            .expect("the model server itself got the request");
        assert_eq!(received.request_line, "GET /v1/models HTTP/1.1");

        let client = http.raw().clone();
        let remote = futures::executor::block_on(http.spawn(async move {
            client
                .get("https://models.drifting.invalid/v1/models")
                .send()
                .await
        }))
        .unwrap();
        assert!(remote.is_err());

        // A custom service on the internet: its list, then a chat (the
        // long-waiting client), both through the proxy, which refuses.
        let internet = LocalAddress::parse("https://api.example.com/v1").unwrap();
        let asking = http.clone();
        let listed = futures::executor::block_on(http.spawn(async move {
            local::discover(&asking, &internet, Some("synthetic-service-key")).await
        }))
        .unwrap();
        assert_eq!(listed, Err(DiscoverError::Unreachable));
        let nowhere = "http://127.0.0.1:9";
        let driver = ProviderDriver::with_endpoints(
            http.clone(),
            Credentials::new(Arc::new(SecretStore::in_memory())),
            Endpoints {
                deepseek: nowhere.into(),
                anthropic: nowhere.into(),
                openai: nowhere.into(),
                chatgpt: nowhere.into(),
            },
            OAuthEndpoints::at(nowhere).unwrap(),
            RetryPolicy {
                max_attempts: 1,
                ..Default::default()
            },
        );
        let events: Vec<_> = futures::executor::block_on(
            driver
                .stream(chat("https://api.example.com"), Cancellation::default())
                .collect::<Vec<_>>(),
        );
        assert!(matches!(events.last(), Some(Err(_))));
        return;
    };
    assert_eq!(
        proxy.request_lines(),
        vec![
            "CONNECT models.drifting.invalid:443 HTTP/1.1".to_owned(),
            "CONNECT api.example.com:443 HTTP/1.1".to_owned(),
            "CONNECT api.example.com:443 HTTP/1.1".to_owned(),
        ]
    );
}
