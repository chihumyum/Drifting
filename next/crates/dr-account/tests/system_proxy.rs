//! Signing in takes the system's proxy, except to a development origin on
//! this computer (`dr_platform::proxy`). The test runs again with a fake
//! proxy as the system's (its proxy variables), so this machine's own proxy
//! settings never count.
#![cfg(feature = "network")]

use dr_account::{HostedClient, HostedOrigin};
use dr_platform::feedback::fake_service::FakeService;
use dr_platform::proxy::fake::rerun_through;

#[test]
fn signing_in_takes_the_system_proxy_except_to_this_computer() {
    let Some(proxy) = rerun_through("signing_in_takes_the_system_proxy_except_to_this_computer")
    else {
        let client = HostedClient::new();
        let service = FakeService::start(&[200]);
        let local = HostedOrigin::parse(&service.base).unwrap();
        let _ = client.providers(&local);
        let received = service.next().expect("the stand-in itself got the request");
        assert_eq!(received.request_line, "GET /api/auth/providers HTTP/1.1");
        let remote = HostedOrigin::parse("https://hosted.drifting.invalid").unwrap();
        assert!(client.providers(&remote).is_err());
        return;
    };
    assert_eq!(
        proxy.request_lines(),
        vec!["CONNECT hosted.drifting.invalid:443 HTTP/1.1".to_owned()]
    );
}
