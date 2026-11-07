//! `drifting:` links (`drifting-next-dev:` in development builds).
//!
//! Links arrive three ways and all land in one queue:
//!
//! - macOS hands them to GPUI's `Application::on_open_urls`, whether the app
//!   was running or launched by the link;
//! - Windows starts `drifting.exe "<url>"` (the installer registers the
//!   scheme), so they come in as command-line arguments;
//! - a second Windows launch forwards its arguments to the running instance
//!   (`single_instance`).
//!
//! Consumers take only their own prefix, as in the 0.1 client's
//! `DeepLinkQueue`: sign-in drains `auth/`, location links drain `open/`.
//! Links can carry one-time sign-in codes, so nothing here logs them.

use std::sync::{Arc, Mutex};

/// Longer links are refused; the longest real one (a location link) is a few
/// hundred bytes.
pub const MAX_URL_BYTES: usize = 8 * 1024;
/// At most this many links wait in the queue; older ones are dropped first.
pub const MAX_QUEUED: usize = 64;

type Waker = Box<dyn Fn() + Send + Sync>;

pub struct DeepLinks {
    scheme: String,
    queue: Mutex<Vec<String>>,
    waker: Mutex<Option<Waker>>,
}

impl std::fmt::Debug for DeepLinks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeepLinks")
            .field("scheme", &self.scheme)
            .finish_non_exhaustive()
    }
}

impl DeepLinks {
    pub fn new(scheme: &str) -> Arc<Self> {
        Arc::new(Self {
            scheme: scheme.to_ascii_lowercase(),
            queue: Mutex::new(Vec::new()),
            waker: Mutex::new(None),
        })
    }

    pub fn scheme(&self) -> &str {
        &self.scheme
    }

    /// The link with its scheme in lower case, when it is one of ours and
    /// within limits.
    pub fn normalize(&self, url: &str) -> Option<String> {
        let url = url.trim();
        if url.len() > MAX_URL_BYTES || url.chars().any(char::is_control) {
            return None;
        }
        let (scheme, rest) = url.split_once(':')?;
        if !scheme.eq_ignore_ascii_case(&self.scheme) || rest.is_empty() {
            return None;
        }
        Some(format!("{}:{rest}", self.scheme))
    }

    /// Queues the links that are ours and wakes the consumer. Returns how
    /// many were taken.
    pub fn push_all<I, S>(&self, urls: I) -> usize
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let accepted: Vec<String> = urls
            .into_iter()
            .filter_map(|url| self.normalize(url.as_ref()))
            .collect();
        let count = accepted.len();
        if count == 0 {
            return 0;
        }
        {
            let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.extend(accepted);
            let excess = queue.len().saturating_sub(MAX_QUEUED);
            queue.drain(..excess);
        }
        tracing::info!(count, "deep links received");
        if let Some(waker) = self
            .waker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            waker();
        }
        count
    }

    /// Command-line arguments: the program name and anything that is not one
    /// of our links are ignored.
    pub fn push_args<I, S>(&self, args: I) -> usize
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.push_all(args)
    }

    /// Takes the queued links under `<scheme>://<prefix>` (for example
    /// `auth/` or `open/`) and leaves the rest for their own consumer.
    pub fn drain_matching(&self, prefix: &str) -> Vec<String> {
        let full = format!("{}://{prefix}", self.scheme);
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let (taken, kept) = queue.drain(..).partition(|url| url.starts_with(&full));
        *queue = kept;
        taken
    }

    /// Called after links arrive, on whichever thread delivered them. The app
    /// uses it to get back to its main thread and drain the queue.
    pub fn set_waker(&self, waker: impl Fn() + Send + Sync + 'static) {
        *self.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(waker));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn each_consumer_drains_only_its_prefix() {
        let links = DeepLinks::new("drifting");
        links.push_all([
            "drifting://auth/callback?nativeState=a",
            "drifting://open/p/chapters/id-x/prose.md#L3",
        ]);
        assert_eq!(
            links.drain_matching("open/"),
            vec!["drifting://open/p/chapters/id-x/prose.md#L3"]
        );
        assert!(links.drain_matching("open/").is_empty());
        assert_eq!(
            links.drain_matching("auth/"),
            vec!["drifting://auth/callback?nativeState=a"]
        );
    }

    #[test]
    fn only_this_builds_scheme_is_accepted() {
        let links = DeepLinks::new("drifting-next-dev");
        assert_eq!(
            links.push_args([
                "C:\\Users\\x\\AppData\\Local\\Drifting Next\\drifting.exe",
                "drifting://open/release-link",
                "https://example.com",
                "Drifting-Next-Dev://open/a",
                "drifting-next-dev:",
                "drifting-next-dev://open/\u{7}b",
            ]),
            1
        );
        assert_eq!(
            links.drain_matching("open/"),
            vec!["drifting-next-dev://open/a"]
        );
    }

    #[test]
    fn oversized_links_are_refused_and_the_queue_is_bounded() {
        let links = DeepLinks::new("drifting");
        let long = format!("drifting://open/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(links.push_all([long]), 0);
        let many: Vec<String> = (0..MAX_QUEUED + 10)
            .map(|index| format!("drifting://open/{index}"))
            .collect();
        links.push_all(&many);
        let drained = links.drain_matching("open/");
        assert_eq!(drained.len(), MAX_QUEUED);
        assert_eq!(drained[0], "drifting://open/10");
    }

    #[test]
    fn arrivals_wake_the_consumer() {
        let links = DeepLinks::new("drifting");
        let woken = Arc::new(AtomicUsize::new(0));
        let counter = woken.clone();
        links.set_waker(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        links.push_all(["https://not-ours"]);
        assert_eq!(woken.load(Ordering::SeqCst), 0);
        links.push_all(["drifting://auth/callback"]);
        assert_eq!(woken.load(Ordering::SeqCst), 1);
    }
}
