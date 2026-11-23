//! The model providers and their sign-in take the system's proxy, a model
//! server on this computer never does (`dr_platform::proxy`). The test runs
//! again with a fake proxy as the system's (its proxy variables), so this
//! machine's own proxy settings never count.

use dr_agent_providers::HttpClient;
use dr_agent_providers::local::{self, LocalAddress};
use dr_platform::feedback::fake_service::FakeService;
use dr_platform::proxy::fake::rerun_through;

#[test]
fn providers_take_the_system_proxy_and_a_local_model_server_never_does() {
    let Some(proxy) =
        rerun_through("providers_take_the_system_proxy_and_a_local_model_server_never_does")
    else {
        let http = HttpClient::new().unwrap();
        let service = FakeService::start(&[200]);
        let address = LocalAddress::parse(&service.base).unwrap();
        let client = http.raw().clone();
        let checked = futures::executor::block_on(
            http.spawn(async move { local::check(&client, &address, None).await }),
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
        return;
    };
    assert_eq!(
        proxy.request_lines(),
        vec!["CONNECT models.drifting.invalid:443 HTTP/1.1".to_owned()]
    );
}
