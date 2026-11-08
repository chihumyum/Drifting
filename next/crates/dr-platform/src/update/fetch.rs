//! Getting the manifest and the artifact. `HttpFetch` is the real one;
//! `LocalFetch` reads `file://` URLs and absolute paths; [`UpdateFetch`]
//! picks between them by the build's [`UrlPolicy`]. Under
//! `UrlPolicy::AllowLocal` (development builds given a test manifest, and
//! the tests) plain HTTP to this machine is allowed too, so the end-to-end
//! tests run against a stand-in on 127.0.0.1 ([`fake_server`]) and never
//! touch the network or the published releases.
//!
//! A download that breaks off is an error, never a short file: a body that
//! fails or stalls mid-way is [`FetchError::Interrupted`], one that ends
//! before the length the server announced is [`FetchError::Incomplete`].
//! Either way the updater deletes what it wrote.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use super::manifest::UrlPolicy;

/// The most an artifact may be; a release is a few tens of megabytes.
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// How long a connection may go without a byte before the download counts
/// as interrupted. Not a limit on the whole download: a slow line that
/// keeps receiving is fine.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("{0} is not a URL this updater fetches")]
    Url(String),
    #[error("the server answered {0}")]
    Status(u16),
    #[error("the download is larger than {0} bytes")]
    TooLarge(u64),
    /// The server could not be reached: offline, no name, refused, TLS.
    #[error("the network request failed: {0}")]
    Network(String),
    /// The connection broke or stalled after the download began.
    #[error("the download was interrupted: {0}")]
    Interrupted(String),
    /// The body ended before the length the server announced.
    #[error("the download stopped at {received} of {expected} bytes")]
    Incomplete { received: u64, expected: u64 },
    /// Writing the download on this machine failed.
    #[error("could not write the download: {0}")]
    Io(#[from] std::io::Error),
}

pub trait Fetch: Send + Sync {
    /// A small document such as the manifest, at most `limit` bytes.
    fn get(&self, url: &str, limit: u64) -> Result<Vec<u8>, FetchError> {
        let mut bytes = Vec::new();
        self.download(url, &mut bytes, limit, &mut |_| {})?;
        Ok(bytes)
    }

    /// Streams `url` into `sink`, at most `limit` bytes; returns the length.
    fn download(
        &self,
        url: &str,
        sink: &mut dyn Write,
        limit: u64,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<u64, FetchError>;
}

fn copy_limited(
    mut source: impl Read,
    sink: &mut dyn Write,
    limit: u64,
    total: Option<u64>,
    progress: &mut dyn FnMut(Progress),
) -> Result<u64, FetchError> {
    if total.is_some_and(|total| total > limit) {
        return Err(FetchError::TooLarge(limit));
    }
    let mut buffer = vec![0; 64 * 1024];
    let mut received = 0_u64;
    progress(Progress { received, total });
    loop {
        // A failed read is the connection (or the file being read), not this
        // machine's disk: the sink's errors are `Io`.
        let read = match source.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FetchError::Interrupted(error.to_string())),
        };
        if read == 0 {
            break;
        }
        received += read as u64;
        if received > limit {
            return Err(FetchError::TooLarge(limit));
        }
        sink.write_all(&buffer[..read])?;
        progress(Progress { received, total });
    }
    if let Some(expected) = total
        && received != expected
    {
        return Err(FetchError::Incomplete { received, expected });
    }
    sink.flush()?;
    Ok(received)
}

/// `http://` to this machine only: `127.0.0.1`, `localhost` or `[::1]`, with
/// an optional port and no user name. A development build given a local test
/// manifest, and the tests, fetch from such a server; nothing else may use
/// plain HTTP.
pub fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((host, after)) => (host, after.strip_prefix(':')),
            None => return false,
        },
        None => match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
        && port.is_none_or(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}

/// `file://` URLs and absolute paths.
#[derive(Clone, Copy, Debug, Default)]
pub struct LocalFetch;

impl LocalFetch {
    fn path(url: &str) -> Result<PathBuf, FetchError> {
        let path = url.strip_prefix("file://").unwrap_or(url);
        let path = PathBuf::from(path);
        if path.is_absolute() {
            Ok(path)
        } else {
            Err(FetchError::Url(url.to_owned()))
        }
    }
}

impl Fetch for LocalFetch {
    fn download(
        &self,
        url: &str,
        sink: &mut dyn Write,
        limit: u64,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<u64, FetchError> {
        let file = std::fs::File::open(Self::path(url)?)?;
        let total = file.metadata()?.len();
        copy_limited(file, sink, limit, Some(total), progress)
    }
}

/// What [`HttpFetch`] accepts besides HTTPS, and how long a stalled
/// connection is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HttpOptions {
    /// Also plain HTTP to this machine ([`is_loopback_http`]).
    pub loopback: bool,
    /// See [`STALL_TIMEOUT`].
    pub stall: Duration,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            loopback: false,
            stall: STALL_TIMEOUT,
        }
    }
}

/// HTTPS through the same reqwest client Sentry's transport uses. Redirects
/// (GitHub sends `releases/latest/download/…` through two) must stay on HTTPS
/// (or, with `loopback`, on this machine).
#[cfg(feature = "network")]
pub struct HttpFetch {
    client: reqwest::blocking::Client,
    loopback: bool,
}

#[cfg(feature = "network")]
impl HttpFetch {
    pub fn new(user_agent: &str, options: HttpOptions) -> Result<Self, FetchError> {
        crate::install_tls_provider();
        let loopback = options.loopback;
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if !(attempt.url().scheme() == "https"
                || (loopback && is_loopback_http(attempt.url().as_str())))
            {
                attempt.error("redirect left HTTPS")
            } else {
                attempt.follow()
            }
        });
        // reqwest's blocking timeout applies to each wait (the response
        // head, then every read of the body), so it is a stall limit.
        let client = reqwest::blocking::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(30))
            .timeout(options.stall)
            .redirect(policy)
            .https_only(!loopback)
            .build()
            .map_err(|error| FetchError::Network(error.to_string()))?;
        Ok(Self { client, loopback })
    }

    fn allowed(&self, url: &str) -> bool {
        url.starts_with("https://") || (self.loopback && is_loopback_http(url))
    }
}

#[cfg(feature = "network")]
impl Fetch for HttpFetch {
    fn download(
        &self,
        url: &str,
        sink: &mut dyn Write,
        limit: u64,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<u64, FetchError> {
        if !self.allowed(url) {
            return Err(FetchError::Url(url.to_owned()));
        }
        let response = self
            .client
            .get(url)
            .send()
            .map_err(|error| FetchError::Network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(FetchError::Status(status.as_u16()));
        }
        let total = response.content_length();
        copy_limited(response, sink, limit, total, progress)
    }
}

/// What a build fetches updates with: HTTPS, and under
/// [`UrlPolicy::AllowLocal`] also local files and plain HTTP to this machine.
pub struct UpdateFetch {
    #[cfg(feature = "network")]
    http: HttpFetch,
    local: bool,
}

impl UpdateFetch {
    pub fn new(policy: UrlPolicy, user_agent: &str, stall: Duration) -> Result<Self, FetchError> {
        let local = policy == UrlPolicy::AllowLocal;
        #[cfg(not(feature = "network"))]
        let _ = (user_agent, stall);
        Ok(Self {
            #[cfg(feature = "network")]
            http: HttpFetch::new(
                user_agent,
                HttpOptions {
                    loopback: local,
                    stall,
                },
            )?,
            local,
        })
    }
}

impl Fetch for UpdateFetch {
    fn download(
        &self,
        url: &str,
        sink: &mut dyn Write,
        limit: u64,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<u64, FetchError> {
        if self.local && (url.starts_with("file://") || url.starts_with('/')) {
            return LocalFetch.download(url, sink, limit, progress);
        }
        #[cfg(feature = "network")]
        return self.http.download(url, sink, limit, progress);
        #[cfg(not(feature = "network"))]
        Err(FetchError::Network(format!(
            "this build has no network client for {url}"
        )))
    }
}

/// A stand-in for GitHub Releases on 127.0.0.1, for tests: it serves the
/// paths it was given, each the way it was told to (whole, cut short,
/// stalled, an error status), and counts the requests. Nothing here reaches
/// a real server.
#[cfg(any(test, feature = "test-support"))]
pub mod fake_server {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// How one path answers.
    #[derive(Clone, Debug)]
    pub enum Serve {
        /// 200 with the bytes.
        Bytes(Vec<u8>),
        /// Announces the whole length, sends the first `sent` bytes, then
        /// closes: a download that broke off.
        CutShort { body: Vec<u8>, sent: usize },
        /// Announces the whole length, sends the first `sent` bytes, then
        /// goes quiet for `quiet` before closing.
        Stall {
            body: Vec<u8>,
            sent: usize,
            quiet: Duration,
        },
        /// A bare status, such as 404 or 503.
        Status(u16),
        /// A redirect to `location`.
        Redirect(String),
    }

    pub struct FakeServer {
        /// `http://127.0.0.1:<port>`.
        pub base: String,
        routes: Arc<Mutex<HashMap<String, Serve>>>,
        requests: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
    }

    impl FakeServer {
        pub fn start() -> FakeServer {
            let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
            let base = format!("http://{}", listener.local_addr().unwrap());
            let routes: Arc<Mutex<HashMap<String, Serve>>> = Arc::default();
            let requests = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let (r, n, s) = (routes.clone(), requests.clone(), stop.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if s.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(stream) = stream else { continue };
                    n.fetch_add(1, Ordering::SeqCst);
                    let routes = r.clone();
                    std::thread::spawn(move || answer(stream, &routes));
                }
            });
            FakeServer {
                base,
                routes,
                requests,
                stop,
            }
        }

        /// `<base><path>`.
        pub fn url(&self, path: &str) -> String {
            format!("{}{path}", self.base)
        }

        pub fn serve(&self, path: &str, serve: Serve) {
            self.routes.lock().unwrap().insert(path.to_owned(), serve);
        }

        /// How many connections it has answered.
        pub fn requests(&self) -> usize {
            self.requests.load(Ordering::SeqCst)
        }
    }

    impl Drop for FakeServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wakes the accept loop so it sees the flag.
            let _ = TcpStream::connect(self.base.trim_start_matches("http://"));
        }
    }

    /// A port nothing listens on: a request there is refused, as when the
    /// machine is offline.
    pub fn refused_base() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        base
    }

    fn answer(stream: TcpStream, routes: &Mutex<HashMap<String, Serve>>) {
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() {
            return;
        }
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                break;
            }
        }
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("/")
            .to_owned();
        let serve = routes.lock().unwrap().get(&path).cloned();
        let mut stream = reader.into_inner();
        let head = |status: u16, length: usize| {
            format!("HTTP/1.1 {status} X\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n")
        };
        let _ = match serve {
            None => stream.write_all(head(404, 0).as_bytes()),
            Some(Serve::Status(status)) => stream.write_all(head(status, 0).as_bytes()),
            Some(Serve::Bytes(body)) => stream
                .write_all(head(200, body.len()).as_bytes())
                .and_then(|()| stream.write_all(&body)),
            Some(Serve::CutShort { body, sent }) => stream
                .write_all(head(200, body.len()).as_bytes())
                .and_then(|()| stream.write_all(&body[..sent])),
            Some(Serve::Stall { body, sent, quiet }) => {
                let written = stream
                    .write_all(head(200, body.len()).as_bytes())
                    .and_then(|()| stream.write_all(&body[..sent]))
                    .and_then(|()| stream.flush());
                std::thread::sleep(quiet);
                written
            }
            Some(Serve::Redirect(location)) => stream.write_all(
                format!(
                    "HTTP/1.1 302 X\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                )
                .as_bytes(),
            ),
        };
        let _ = stream.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the TLS stack (rustls with ring, the platform verifier) without
    /// a request.
    #[cfg(feature = "network")]
    #[test]
    fn the_https_client_builds() {
        let fetch = HttpFetch::new("Drifting test", HttpOptions::default()).unwrap();
        assert!(matches!(
            fetch.get("http://example.invalid/update.json", 1),
            Err(FetchError::Url(_))
        ));
        // Not even this machine, without `loopback`.
        assert!(matches!(
            fetch.get("http://127.0.0.1:9/update.json", 1),
            Err(FetchError::Url(_))
        ));
    }

    #[test]
    fn only_this_machine_may_be_plain_http() {
        for url in [
            "http://127.0.0.1:4100/update.json",
            "http://localhost/update.json",
            "http://[::1]:8080/x",
            "http://127.0.0.1",
        ] {
            assert!(is_loopback_http(url), "{url}");
        }
        for url in [
            "https://127.0.0.1/update.json",
            "http://127.0.0.1.example.test/update.json",
            "http://user@127.0.0.1/update.json",
            "http://127.0.0.1@evil.test/",
            "http://example.test/update.json",
            "http://127.0.0.1:/x",
            "http://127.0.0.1:80x/x",
            "http://[::1/x",
            "file:///tmp/update.json",
        ] {
            assert!(!is_loopback_http(url), "{url}");
        }
    }

    #[cfg(feature = "network")]
    mod over_http {
        use super::super::fake_server::{FakeServer, Serve, refused_base};
        use super::super::*;

        fn loopback(stall: Duration) -> HttpFetch {
            HttpFetch::new(
                "Drifting test",
                HttpOptions {
                    loopback: true,
                    stall,
                },
            )
            .unwrap()
        }

        fn fetch(fetch: &HttpFetch, url: &str) -> Result<Vec<u8>, FetchError> {
            let mut sink = Vec::new();
            fetch
                .download(url, &mut sink, MAX_ARTIFACT_BYTES, &mut |_| {})
                .map(|_| sink)
        }

        #[test]
        fn a_whole_body_arrives_and_redirects_stay_on_this_machine() {
            let server = FakeServer::start();
            let body = vec![9_u8; 300_000];
            server.serve("/a.bin", Serve::Bytes(body.clone()));
            server.serve("/latest", Serve::Redirect(server.url("/a.bin")));
            server.serve("/away", Serve::Redirect("http://example.test/a.bin".into()));
            let http = loopback(STALL_TIMEOUT);
            assert_eq!(fetch(&http, &server.url("/latest")).unwrap(), body);
            assert!(matches!(
                fetch(&http, &server.url("/away")),
                Err(FetchError::Network(_))
            ));
            assert!(matches!(
                fetch(&http, &server.url("/missing")),
                Err(FetchError::Status(404))
            ));
        }

        #[test]
        fn a_body_cut_short_or_stalled_is_an_error_not_a_short_file() {
            let server = FakeServer::start();
            let body = vec![3_u8; 200_000];
            server.serve(
                "/cut",
                Serve::CutShort {
                    body: body.clone(),
                    sent: 50_000,
                },
            );
            server.serve(
                "/stall",
                Serve::Stall {
                    body,
                    sent: 50_000,
                    quiet: Duration::from_secs(3),
                },
            );
            let http = loopback(Duration::from_millis(500));
            assert!(matches!(
                fetch(&http, &server.url("/cut")),
                Err(FetchError::Interrupted(_) | FetchError::Incomplete { .. })
            ));
            let started = std::time::Instant::now();
            assert!(matches!(
                fetch(&http, &server.url("/stall")),
                Err(FetchError::Interrupted(_))
            ));
            assert!(started.elapsed() < Duration::from_secs(3));
        }

        #[test]
        fn no_server_is_a_network_error() {
            let http = loopback(STALL_TIMEOUT);
            assert!(matches!(
                fetch(&http, &format!("{}/update.json", refused_base())),
                Err(FetchError::Network(_))
            ));
        }
    }

    #[test]
    fn local_files_stream_with_progress_and_a_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("artifact.bin");
        std::fs::write(&path, vec![7_u8; 200_000]).unwrap();
        let url = format!("file://{}", path.display());

        let mut sink = Vec::new();
        let mut last = None;
        let length = LocalFetch
            .download(&url, &mut sink, MAX_ARTIFACT_BYTES, &mut |p| last = Some(p))
            .unwrap();
        assert_eq!(length, 200_000);
        assert_eq!(sink.len(), 200_000);
        assert_eq!(
            last,
            Some(Progress {
                received: 200_000,
                total: Some(200_000)
            })
        );

        assert!(matches!(
            LocalFetch.get(&url, 1000),
            Err(FetchError::TooLarge(1000))
        ));
        assert!(matches!(
            LocalFetch.get("relative/path", 1000),
            Err(FetchError::Url(_))
        ));
    }

    #[test]
    fn a_source_shorter_than_announced_is_incomplete() {
        let mut sink = Vec::new();
        assert!(matches!(
            copy_limited(&[1_u8; 10][..], &mut sink, 100, Some(20), &mut |_| {}),
            Err(FetchError::Incomplete {
                received: 10,
                expected: 20
            })
        ));
    }
}
