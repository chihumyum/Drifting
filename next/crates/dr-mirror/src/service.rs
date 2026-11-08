//! The Markdown folder running beside an open library: one worker thread
//! that passes over a book's folder ([`crate::sync::Pass`]) when
//!
//! - the author changed the book in Drifting and paused ([`Options::quiet`],
//!   at most [`Options::max_wait`] after the first change): the files are
//!   written;
//! - a file under the root changed (the system's file events, through
//!   `notify`; 0.1 polled every 1.5 s): it is read back after
//!   [`Options::settle`];
//! - the shell asks ([`Mirror::sync_now`], e.g. before the library closes).
//!
//! The first pass, when it starts, covers every book: files edited while
//! Drifting was closed are merged then. What could not be merged is kept in
//! [`Mirror::issues`] and handed to [`Mirror::on_issues`] when it changes;
//! files kept before being replaced go to [`Mirror::on_preserved`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use dr_store::Origin;
use dr_workspace::{Subscription, Workspace, WsEvent};
use notify::Watcher;

use crate::ledger;
use crate::sync::{Issue, Pass, Report, SyncError};

/// Where the folder is and how eagerly it follows.
#[derive(Clone, Debug)]
pub struct Options {
    /// The folder every book's folder goes under (the author chooses it).
    pub root: PathBuf,
    /// This installation (F2's `Device::installation_id`).
    pub installation: String,
    /// The application's bundle id, written into each book folder's
    /// `.drifting/owner.json`.
    pub app: String,
    pub quiet: Duration,
    pub max_wait: Duration,
    pub settle: Duration,
}

impl Options {
    /// 0.1's timings: written 5 s after the author pauses (30 s at most),
    /// a file read 0.4 s after it was saved.
    pub fn new(
        root: impl Into<PathBuf>,
        installation: impl Into<String>,
        app: impl Into<String>,
    ) -> Options {
        Options {
            root: root.into(),
            installation: installation.into(),
            app: app.into(),
            quiet: Duration::from_secs(5),
            max_wait: Duration::from_secs(30),
            settle: Duration::from_millis(400),
        }
    }
}

enum Msg {
    /// A book changed in Drifting.
    Book(String),
    /// Something changed under the root.
    File(PathBuf),
    Sync(mpsc::Sender<Result<Report, String>>),
    Stop,
}

type Listener = Arc<dyn Fn(&[Issue]) + Send + Sync>;
type KeptListener = Arc<dyn Fn(&[PathBuf]) + Send + Sync>;

#[derive(Default)]
struct Shared {
    /// By book.
    issues: HashMap<String, Vec<Issue>>,
    listeners: Vec<Listener>,
    kept: Vec<KeptListener>,
}

/// The Markdown folder of an open library. Dropping it stops it (pending
/// writes are made first).
pub struct Mirror {
    tx: mpsc::Sender<Msg>,
    shared: Arc<Mutex<Shared>>,
    worker: Option<JoinHandle<()>>,
    _watcher: Option<notify::RecommendedWatcher>,
    _subscription: Subscription,
}

impl Mirror {
    /// Start following `ws` into `options.root` (created when missing).
    pub fn start(ws: Workspace, options: Options) -> std::io::Result<Mirror> {
        std::fs::create_dir_all(&options.root)?;
        let (tx, rx) = mpsc::channel();
        let events = tx.clone();
        let subscription = ws.subscribe(move |e| {
            let book = match e {
                // The mirror's own merges are written by the pass that made
                // them.
                WsEvent::Prose(p) if p.origin != Origin::Mirror => {
                    p.book.as_ref().map(|b| b.to_string())
                }
                WsEvent::Book(b) if b.origin != Origin::Mirror => Some(b.book.to_string()),
                _ => None,
            };
            if let Some(book) = book {
                let _ = events.send(Msg::Book(book));
            }
        });
        let files = tx.clone();
        let watcher = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
            if let Ok(e) = r {
                for p in e.paths {
                    let _ = files.send(Msg::File(p));
                }
            }
        })
        .and_then(|mut w| {
            w.watch(&options.root, notify::RecursiveMode::Recursive)?;
            Ok(w)
        });
        let watcher = match watcher {
            Ok(w) => Some(w),
            Err(e) => {
                // Without events the folder is still read when it starts and
                // when asked.
                log::warn!(
                    "Markdown folder: not watching {}: {e}",
                    options.root.display()
                );
                None
            }
        };
        let shared = Arc::new(Mutex::new(Shared::default()));
        let worker = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("dr-mirror".into())
                .spawn(move || run(ws, options, rx, shared))?
        };
        Ok(Mirror {
            tx,
            shared,
            worker: Some(worker),
            _watcher: watcher,
            _subscription: subscription,
        })
    }

    /// One pass over every book now; waits for it.
    pub fn sync_now(&self) -> Result<Report, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Msg::Sync(tx))
            .map_err(|_| "the Markdown folder has stopped".to_owned())?;
        rx.recv()
            .map_err(|_| "the Markdown folder has stopped".to_owned())?
    }

    /// Files that could not be merged (and folders that may not be used).
    pub fn issues(&self) -> Vec<Issue> {
        let s = lock(&self.shared);
        let mut all: Vec<Issue> = s.issues.values().flatten().cloned().collect();
        all.sort_by(|a, b| a.path.cmp(&b.path));
        all
    }

    /// Called on the worker thread with every issue whenever they change.
    pub fn on_issues(&self, f: impl Fn(&[Issue]) + Send + Sync + 'static) {
        lock(&self.shared).listeners.push(Arc::new(f));
    }

    /// Called on the worker thread with the files a pass kept under
    /// `.drifting/preserved` before replacing or dropping them.
    pub fn on_preserved(&self, f: impl Fn(&[PathBuf]) + Send + Sync + 'static) {
        lock(&self.shared).kept.push(Arc::new(f));
    }

    /// Stop after writing what is pending.
    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

impl Drop for Mirror {
    fn drop(&mut self) {
        self.halt();
    }
}

fn lock(m: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// When each book is due, and why.
#[derive(Default)]
struct Due {
    /// Changed in Drifting: (first change, last change).
    changed: HashMap<String, (Instant, Instant)>,
    /// A file changed: read at this time.
    read: HashMap<String, Instant>,
}

impl Due {
    fn at(&self, o: &Options) -> Option<Instant> {
        let changed = self
            .changed
            .values()
            .map(|(first, last)| (*last + o.quiet).min(*first + o.max_wait));
        changed.chain(self.read.values().copied()).min()
    }

    fn take(&mut self, now: Instant, o: &Options) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        self.changed.retain(|b, (first, last)| {
            let due = (*last + o.quiet).min(*first + o.max_wait) <= now;
            if due {
                out.push(b.clone());
            }
            !due
        });
        self.read.retain(|b, at| {
            let due = *at <= now;
            if due && !out.contains(b) {
                out.push(b.clone());
            }
            !due
        });
        out.sort();
        out
    }
}

fn run(ws: Workspace, o: Options, rx: mpsc::Receiver<Msg>, shared: Arc<Mutex<Shared>>) {
    let pass = Pass {
        ws: &ws,
        root: &o.root,
        installation: &o.installation,
        app: &o.app,
        settle: o.settle,
        thorough: false,
    };
    // The first pass and the asked-for ones read every file.
    let thorough = Pass {
        thorough: true,
        ..pass
    };
    let mut due = Due::default();
    // File events name the folder as the system sees it (on macOS
    // `/private/var/…` for `/var/…`).
    let canonical = o.root.canonicalize().unwrap_or_else(|_| o.root.clone());
    let publish = |books: &[String], r: &Report, all: bool| {
        if !r.preserved.is_empty() {
            let kept = lock(&shared).kept.clone();
            for l in kept {
                l(&r.preserved);
            }
        }
        let (listeners, issues) = {
            let mut s = lock(&shared);
            let before = s.issues.clone();
            if all {
                s.issues.clear();
            } else {
                for b in books {
                    s.issues.remove(b);
                }
            }
            for i in &r.issues {
                s.issues.entry(i.book.clone()).or_default().push(i.clone());
            }
            if s.issues == before {
                return;
            }
            let mut all: Vec<Issue> = s.issues.values().flatten().cloned().collect();
            all.sort_by(|a, b| a.path.cmp(&b.path));
            (s.listeners.clone(), all)
        };
        for l in listeners {
            l(&issues);
        }
    };
    let full = |due: &mut Due| -> Result<Report, SyncError> {
        let r = thorough.run()?;
        publish(&[], &r, true);
        if r.waiting {
            let at = Instant::now() + o.settle;
            for b in book_ids(&ws) {
                due.read.insert(b, at);
            }
        }
        Ok(r)
    };
    if let Err(e) = full(&mut due) {
        log::warn!("Markdown folder: {e}");
    }
    loop {
        let msg = match due.at(&o) {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => break,
            },
        };
        match msg {
            Some(Msg::Book(b)) => {
                let now = Instant::now();
                due.changed
                    .entry(b)
                    .and_modify(|(_, last)| *last = now)
                    .or_insert((now, now));
            }
            Some(Msg::File(p)) => {
                if ignored(&p) {
                    continue;
                }
                let at = Instant::now() + o.settle;
                match book_of(&ws, &o.root, &canonical, &p) {
                    Some(b) => {
                        due.read.insert(b, at);
                    }
                    None => {
                        for b in book_ids(&ws) {
                            due.read.entry(b).or_insert(at);
                        }
                    }
                }
            }
            Some(Msg::Sync(reply)) => {
                due = Due::default();
                let _ = reply.send(full(&mut due).map_err(|e| e.to_string()));
            }
            Some(Msg::Stop) => {
                // What the author wrote is written before it stops.
                let pending: Vec<String> = due.changed.keys().cloned().collect();
                for b in pending {
                    if let Err(e) = pass.book(&b) {
                        log::warn!("Markdown folder: {e}");
                    }
                }
                break;
            }
            None => {}
        }
        let books = due.take(Instant::now(), &o);
        if books.is_empty() {
            continue;
        }
        let mut report = Report::default();
        for b in &books {
            match pass.book(b) {
                Ok(r) => {
                    if r.waiting {
                        due.read.insert(b.clone(), Instant::now() + o.settle);
                    }
                    report.issues.extend(r.issues);
                    report.preserved.extend(r.preserved);
                }
                Err(e) => log::warn!("Markdown folder: {b}: {e}"),
            }
        }
        publish(&books, &report, false);
    }
}

/// Paths the mirror itself writes (its temporary files and its own
/// directory) do not call for a pass.
fn ignored(p: &Path) -> bool {
    p.components()
        .any(|c| c.as_os_str() == crate::disk::META_DIR)
        || p.file_name()
            .is_some_and(|n| n.to_string_lossy().ends_with(".drifting-tmp"))
}

/// The book whose folder `p` is in.
fn book_of(ws: &Workspace, root: &Path, canonical: &Path, p: &Path) -> Option<String> {
    let rel = p
        .strip_prefix(root)
        .or_else(|_| p.strip_prefix(canonical))
        .ok()?;
    let folder = rel
        .components()
        .next()?
        .as_os_str()
        .to_string_lossy()
        .into_owned();
    ledger::books(ws.library(), &root.to_string_lossy())
        .ok()?
        .into_iter()
        .find(|(_, r)| r.folder == folder)
        .map(|(id, _)| id)
}

fn book_ids(ws: &Workspace) -> Vec<String> {
    ws.run::<dr_workspace::commands::book::BookList>(
        &dr_workspace::Actor::Mirror,
        dr_workspace::commands::book::ListBooksIn { trashed: false },
    )
    .map(|o| o.output.into_iter().map(|b| b.id).collect())
    .unwrap_or_default()
}
