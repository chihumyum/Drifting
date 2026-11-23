//! Hosted sync takes the system's proxy, except to a development origin on
//! this computer (`dr_platform::proxy`). The test runs again with a fake
//! proxy as the system's (its proxy variables), so this machine's own proxy
//! settings never count.

use dr_platform::feedback::fake_service::FakeService;
use dr_platform::proxy::fake::rerun_through;
use dr_sync::SyncHttpClient;

#[test]
fn sync_takes_the_system_proxy_except_to_this_computer() {
    let Some(proxy) = rerun_through("sync_takes_the_system_proxy_except_to_this_computer") else {
        let service = FakeService::start(&[200]);
        let local = SyncHttpClient::new(service.base.clone()).unwrap();
        let _ = local.fetch_usage("synthetic-token");
        let received = service.next().expect("the stand-in itself got the request");
        assert_eq!(received.request_line, "GET /api/sync/v1/usage HTTP/1.1");
        let remote = SyncHttpClient::new("https://hosted.drifting.invalid").unwrap();
        assert!(remote.fetch_usage("synthetic-token").is_err());
        return;
    };
    assert_eq!(
        proxy.request_lines(),
        vec!["CONNECT hosted.drifting.invalid:443 HTTP/1.1".to_owned()]
    );
}
