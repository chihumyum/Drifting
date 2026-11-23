//! Which way a request leaves the machine (NP, 2026-11-24).
//!
//! Every HTTP client of the App takes the proxy the system is set to use:
//! the `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY` variables
//! when they are set, otherwise the macOS network settings (the web and
//! secure web proxies) or the Windows internet options (the proxy server and
//! its exceptions). An App opened from Finder or the Start menu has no proxy
//! variables: reading only those, it went out directly while the system was
//! set to a proxy, and where the direct route was poor, signing in worked
//! and sync failed (the 0.1 client's fix of 2026-11-23, `d57fb838a`).
//!
//! Destinations on this computer or the local network never take a proxy,
//! whatever the system says (see [`reach`]): a model server on the author's
//! own machine or network, the Hosted stand-in of development and tests.
//! macOS keeps its exception list apart from the proxy addresses and only
//! the addresses are read, so without this rule such a request would be
//! handed to the proxy.
//!
//! The system's settings are read again for each new connection, not once
//! per client: turning the system proxy off, or switching the proxy app to
//! its TUN mode, needs no restart. [`system`] is the one [`reqwest::Proxy`]
//! the App's clients add (sync, account, feedback, the updater, crash
//! reports, the Agent's model providers). MCP's outbound client is the
//! exception: it takes no proxy at all (`dr-mcp`'s `outbound::destination`).
//!
//! Not read: an automatic proxy configuration (PAC) file and a SOCKS-only
//! setting on macOS; reqwest's `system-proxy` reads neither.

use std::net::{IpAddr, Ipv4Addr};

/// Where a destination is, when it is on this computer or the local
/// network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    ThisComputer,
    LocalNetwork,
}

/// Where `host` (as a URL gives it: an IPv6 address in brackets or not, a
/// trailing dot or not, any case) is, when it is on this computer
/// (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) or the local network
/// (`10/8`, `172.16/12`, `192.168/16`, `*.local`): the addresses
/// `dr_agent_providers::local` accepts for a model server, and the
/// `*.localhost` names a development Hosted origin may use. Nothing is
/// looked up; a name is judged as written.
pub fn reach(host: &str) -> Option<Reach> {
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) if ip.is_loopback() => Some(Reach::ThisComputer),
            IpAddr::V4(ip) if private(ip) => Some(Reach::LocalNetwork),
            IpAddr::V6(ip) if ip.is_loopback() => Some(Reach::ThisComputer),
            _ => None,
        };
    }
    let domain = bare.trim_end_matches('.').to_ascii_lowercase();
    let under = |suffix: &str| {
        domain.len() > suffix.len() && domain.ends_with(suffix) && !domain.starts_with('.')
    };
    if domain == "localhost" || under(".localhost") {
        Some(Reach::ThisComputer)
    } else if under(".local") {
        Some(Reach::LocalNetwork)
    } else {
        None
    }
}

/// Exactly 10/8, 172.16/12 and 192.168/16.
fn private(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

/// Whether a request to `host` goes straight there, never through a proxy.
pub fn direct(host: &str) -> bool {
    reach(host).is_some()
}

/// The proxy every client of the App adds: the one the system is set to use
/// for the destination, none for this computer and the local network
/// ([`direct`]). Adding it replaces reqwest's own system proxy, which has no
/// such exception.
#[cfg(feature = "network")]
pub fn system() -> reqwest::Proxy {
    routed(hyper_util::client::proxy::matcher::Matcher::from_system)
}

/// [`system`] with the settings `settings` reads.
#[cfg(feature = "network")]
fn routed<F>(settings: F) -> reqwest::Proxy
where
    F: Fn() -> hyper_util::client::proxy::matcher::Matcher + Send + Sync + 'static,
{
    reqwest::Proxy::custom(move |destination: &reqwest::Url| {
        if direct(destination.host_str()?) {
            return None;
        }
        let uri = destination.as_str().parse::<http::Uri>().ok()?;
        settings()
            .intercept(&uri)
            .and_then(|proxy| proxy_url(&proxy))
    })
}

/// The proxy as reqwest takes it back: a URL with its user and password.
#[cfg(feature = "network")]
fn proxy_url(proxy: &hyper_util::client::proxy::matcher::Intercept) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(&proxy.uri().to_string()).ok()?;
    let credentials = match (proxy.raw_auth(), proxy.basic_auth()) {
        (Some((user, password)), _) => Some((user.to_owned(), password.to_owned())),
        (None, Some(header)) => basic_credentials(header),
        (None, None) => None,
    };
    if let Some((user, password)) = credentials {
        url.set_username(&user).ok()?;
        url.set_password(Some(&password)).ok()?;
    }
    Some(url)
}

/// `Basic <user:password in base64>` back into the two.
#[cfg(feature = "network")]
fn basic_credentials(header: &http::HeaderValue) -> Option<(String, String)> {
    use base64::Engine;
    let encoded = header.to_str().ok()?.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let (user, password) = std::str::from_utf8(&decoded).ok()?.split_once(':')?;
    Some((user.to_owned(), password.to_owned()))
}

/// A proxy on 127.0.0.1 for tests, and a way to make it the system's proxy
/// of a test without touching this machine's settings. Nothing here reaches
/// a real server: the proxy answers every request itself.
#[cfg(any(test, feature = "test-support"))]
pub mod fake {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    /// What [`FakeProxy`] answers a request forwarded through it with.
    pub const BODY: &str = "answered by the fake proxy";
    /// Marks the re-run of [`rerun_through`].
    const CHILD: &str = "DRIFTING_TEST_PROXY_CHILD";
    /// What `NO_PROXY` says in the re-run: a name no test asks for, so that
    /// nothing else (the Windows proxy exceptions) is read in its place.
    const UNUSED: &str = "no-proxy.drifting.invalid";

    /// One request the proxy was asked to carry.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Seen {
        /// `GET http://<host>/<path> HTTP/1.1`, or `CONNECT <host>:443
        /// HTTP/1.1` for HTTPS.
        pub request_line: String,
        /// Its `proxy-authorization` header.
        pub authorization: Option<String>,
    }

    /// Answers a forwarded `GET http://…` with 200 and [`BODY`] and refuses
    /// every `CONNECT` (HTTPS) with 502; keeps each request line.
    pub struct FakeProxy {
        /// `http://127.0.0.1:<port>`.
        pub url: String,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl FakeProxy {
        pub fn start() -> FakeProxy {
            let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
            let url = format!("http://{}", listener.local_addr().unwrap());
            let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
            let log = seen.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else {
                        return;
                    };
                    let log = log.clone();
                    std::thread::spawn(move || answer(stream, &log));
                }
            });
            FakeProxy { url, seen }
        }

        /// Every request it was asked to carry, in order.
        pub fn seen(&self) -> Vec<Seen> {
            self.seen.lock().unwrap().clone()
        }

        /// Just the request lines.
        pub fn request_lines(&self) -> Vec<String> {
            self.seen().into_iter().map(|s| s.request_line).collect()
        }
    }

    fn answer(stream: TcpStream, log: &Mutex<Vec<Seen>>) {
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            return;
        }
        let mut authorization = None;
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                match name.trim().to_ascii_lowercase().as_str() {
                    "proxy-authorization" => authorization = Some(value.trim().to_owned()),
                    "content-length" => length = value.trim().parse().unwrap_or(0),
                    _ => {}
                }
            }
        }
        let mut body = vec![0; length];
        let _ = reader.read_exact(&mut body);
        let connect = request_line.starts_with("CONNECT ");
        log.lock().unwrap().push(Seen {
            request_line: request_line.trim().to_owned(),
            authorization,
        });
        let mut stream = reader.into_inner();
        let _ = if connect {
            write!(
                stream,
                "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            )
        } else {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{BODY}",
                BODY.len()
            )
        };
    }

    /// Runs the test `name` (its full name, as `cargo test -- --exact`
    /// takes it) again, alone, in a child process of this test executable
    /// whose `HTTP_PROXY` and `HTTPS_PROXY` name a fresh [`FakeProxy`]. The
    /// variables come before the macOS and Windows settings, so that proxy
    /// is the system's proxy of the child whatever this machine is set to,
    /// and nothing in this process's environment changes.
    ///
    /// In the child it returns `None`: the test makes its requests there.
    /// In this process it waits for the child to pass and returns the proxy,
    /// to look at what went through it.
    pub fn rerun_through(name: &str) -> Option<FakeProxy> {
        if std::env::var_os(CHILD).is_some() {
            return None;
        }
        let proxy = FakeProxy::start();
        let mut command =
            std::process::Command::new(std::env::current_exe().expect("the test executable"));
        command.args([name, "--exact", "--nocapture", "--test-threads=1"]);
        for variable in [
            "ALL_PROXY",
            "all_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "NO_PROXY",
            "no_proxy",
            // A CGI request turns every proxy off.
            "REQUEST_METHOD",
        ] {
            command.env_remove(variable);
        }
        command
            .env("HTTP_PROXY", &proxy.url)
            .env("HTTPS_PROXY", &proxy.url)
            .env("NO_PROXY", UNUSED)
            .env(CHILD, "1");
        let output = command.output().expect("the test executable runs again");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "the re-run of {name} did not pass:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Some(proxy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_computer_and_the_local_network_are_direct_and_nothing_else_is() {
        for (host, expected) in [
            ("localhost", Reach::ThisComputer),
            ("LOCALHOST.", Reach::ThisComputer),
            ("hosted.localhost", Reach::ThisComputer),
            ("127.0.0.1", Reach::ThisComputer),
            ("127.8.9.10", Reach::ThisComputer),
            ("[::1]", Reach::ThisComputer),
            ("::1", Reach::ThisComputer),
            ("10.0.0.5", Reach::LocalNetwork),
            ("172.16.0.1", Reach::LocalNetwork),
            ("172.31.255.255", Reach::LocalNetwork),
            ("192.168.1.20", Reach::LocalNetwork),
            ("studio.local", Reach::LocalNetwork),
            ("Studio.Local.", Reach::LocalNetwork),
        ] {
            assert_eq!(reach(host), Some(expected), "{host}");
            assert!(direct(host), "{host}");
        }
        for host in [
            "api.openai.com",
            "hosted.drifting.invalid",
            "localhost.example.test",
            "local",
            ".local",
            ".localhost",
            "studio.local.example.test",
            "8.8.8.8",
            "172.15.0.1",
            "172.32.0.1",
            "192.169.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "[2606:4700:4700::1111]",
            "[fe80::1]",
            "[fd00::1]",
            "[::ffff:127.0.0.1]",
            "",
        ] {
            assert_eq!(reach(host), None, "{host}");
            assert!(!direct(host), "{host}");
        }
    }

    /// The two features `system` stands on. Turning reqwest's default
    /// features off (for its TLS) once turned `system-proxy` off with them;
    /// without them a client reads only the proxy variables, which an App
    /// opened from Finder or the Start menu does not have.
    #[test]
    fn the_system_proxy_features_stay_on() {
        let manifest = include_str!("../../../Cargo.toml");
        let declared = |name: &str| {
            manifest
                .lines()
                .find(|line| line.starts_with(&format!("{name} = ")))
                .unwrap_or_else(|| panic!("the workspace declares {name} on one line"))
        };
        assert!(declared("reqwest").contains("\"system-proxy\""));
        assert!(declared("hyper-util").contains("\"client-proxy-system\""));
        let own = include_str!("../Cargo.toml");
        let network = own
            .lines()
            .find(|line| line.starts_with("network = "))
            .expect("dr-platform's network feature");
        assert!(network.contains("\"dep:hyper-util\""));
        assert!(network.contains("\"dep:http\""));
    }

    #[cfg(feature = "network")]
    mod network {
        use std::net::SocketAddr;

        use hyper_util::client::proxy::matcher::Matcher;

        use super::super::fake::{BODY, FakeProxy};
        use super::super::routed;
        use crate::feedback::fake_service::FakeService;

        /// A client whose system proxy is `proxy` (none with `None`), with
        /// these names answering at `at`.
        fn client(
            proxy: Option<String>,
            no: &'static str,
            names: &[&str],
            at: SocketAddr,
        ) -> reqwest::blocking::Client {
            crate::install_tls_provider();
            let mut builder = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .proxy(routed(move || {
                    let builder = Matcher::builder().no(no);
                    match &proxy {
                        Some(url) => builder.http(url.clone()).https(url.clone()).build(),
                        None => builder.build(),
                    }
                }));
            for name in names {
                builder = builder.resolve(name, at);
            }
            builder.build().unwrap()
        }

        fn address(base: &str) -> SocketAddr {
            base.trim_start_matches("http://").parse().unwrap()
        }

        #[test]
        fn remote_requests_go_through_the_proxy_and_local_ones_go_straight_there() {
            let proxy = FakeProxy::start();
            let service = FakeService::start(&[200, 200, 200]);
            let at = address(&service.base);
            let port = at.port();
            // The local names lead to the stand-in, the remote one too: only
            // the proxy can tell them apart.
            let client = client(
                Some(proxy.url.clone()),
                "",
                &["localhost", "studio.local", "hosted.drifting.invalid"],
                at,
            );
            for url in [
                format!("http://127.0.0.1:{port}/a"),
                format!("http://localhost:{port}/b"),
                format!("http://studio.local:{port}/c"),
            ] {
                let body = client.get(&url).send().unwrap().text().unwrap();
                assert_eq!(body, "{}", "{url} reached the stand-in itself");
            }
            for path in ["/a", "/b", "/c"] {
                let received = service.next().expect("the stand-in answered");
                assert_eq!(received.request_line, format!("GET {path} HTTP/1.1"));
            }

            let remote = format!("http://hosted.drifting.invalid:{port}/d");
            let body = client.get(&remote).send().unwrap().text().unwrap();
            assert_eq!(body, BODY);
            let secure = client.get("https://hosted.drifting.invalid/e").send();
            assert!(secure.is_err(), "the proxy refuses every tunnel");
            assert_eq!(
                proxy.request_lines(),
                vec![
                    format!("GET {remote} HTTP/1.1"),
                    "CONNECT hosted.drifting.invalid:443 HTTP/1.1".to_owned(),
                ]
            );
        }

        #[test]
        fn without_a_system_proxy_every_request_goes_straight_there() {
            let service = FakeService::start(&[200]);
            let at = address(&service.base);
            let client = client(None, "", &["hosted.drifting.invalid"], at);
            let url = format!("http://hosted.drifting.invalid:{}/a", at.port());
            assert_eq!(client.get(&url).send().unwrap().text().unwrap(), "{}");
            assert!(service.next().is_some());
        }

        #[test]
        fn the_settings_exceptions_still_count() {
            let proxy = FakeProxy::start();
            let service = FakeService::start(&[200]);
            let at = address(&service.base);
            let client = client(
                Some(proxy.url.clone()),
                "excepted.drifting.invalid",
                &["mirror.excepted.drifting.invalid"],
                at,
            );
            let url = format!("http://mirror.excepted.drifting.invalid:{}/a", at.port());
            assert_eq!(client.get(&url).send().unwrap().text().unwrap(), "{}");
            assert!(proxy.seen().is_empty());
        }

        #[test]
        fn the_proxys_user_and_password_go_with_each_request_through_it() {
            let proxy = FakeProxy::start();
            let port = proxy.url.rsplit(':').next().unwrap().to_owned();
            // A password with the characters a URL has to escape.
            let with_credentials =
                format!("http://synthetic-user:synthetic%40pass%3Aword@127.0.0.1:{port}");
            let unused = "127.0.0.1:9".parse().unwrap();
            let client = client(Some(with_credentials), "", &[], unused);
            let body = client
                .get("http://hosted.drifting.invalid/a")
                .send()
                .unwrap()
                .text()
                .unwrap();
            assert_eq!(body, BODY);
            assert!(
                client
                    .get("https://hosted.drifting.invalid/b")
                    .send()
                    .is_err()
            );
            use base64::Engine;
            let expected = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode("synthetic-user:synthetic@pass:word")
            );
            let seen = proxy.seen();
            assert_eq!(seen.len(), 2);
            for request in seen {
                assert_eq!(
                    request.authorization.as_deref(),
                    Some(expected.as_str()),
                    "{}",
                    request.request_line
                );
            }
        }
    }
}
