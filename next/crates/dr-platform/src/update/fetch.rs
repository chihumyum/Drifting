//! Getting the manifest and the artifact. `HttpFetch` is the real one;
//! `LocalFetch` reads `file://` URLs and absolute paths, so the end-to-end
//! tests (and a development build pointed at a folder) never touch the
//! network or the published releases.

use std::io::{Read, Write};
use std::path::PathBuf;

/// The most an artifact may be; a release is a few tens of megabytes.
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

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
    #[error("the network request failed: {0}")]
    Network(String),
    #[error("could not read or write the download: {0}")]
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
        let read = source.read(&mut buffer)?;
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
    sink.flush()?;
    Ok(received)
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

/// HTTPS through the same reqwest client Sentry's transport uses. Redirects
/// (GitHub sends `releases/latest/download/…` through two) must stay on HTTPS.
#[cfg(feature = "network")]
pub struct HttpFetch {
    client: reqwest::blocking::Client,
}

#[cfg(feature = "network")]
impl HttpFetch {
    pub fn new(user_agent: &str) -> Result<Self, FetchError> {
        crate::install_tls_provider();
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if attempt.url().scheme() != "https" {
                attempt.error("redirect left HTTPS")
            } else {
                attempt.follow()
            }
        });
        let client = reqwest::blocking::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(std::time::Duration::from_secs(30))
            .timeout(None)
            .redirect(policy)
            .https_only(true)
            .build()
            .map_err(|error| FetchError::Network(error.to_string()))?;
        Ok(Self { client })
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
        if !url.starts_with("https://") {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the TLS stack (rustls with ring, the platform verifier) without
    /// a request.
    #[cfg(feature = "network")]
    #[test]
    fn the_https_client_builds() {
        let fetch = HttpFetch::new("Drifting test").unwrap();
        assert!(matches!(
            fetch.get("http://example.invalid/update.json", 1),
            Err(FetchError::Url(_))
        ));
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
}
