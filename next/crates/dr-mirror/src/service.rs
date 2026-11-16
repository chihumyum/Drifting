//! File watching and writeback scheduling for the open library.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use dr_export::Labels;
use dr_model::id::BookId;
use dr_store::Origin;
use dr_workspace::{Subscription, Workspace, WsEvent};
use notify::Watcher;

use crate::{
    layout::Names,
    sync::{Issue, Pass, Report},
};

#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub installation: String,
    pub app: String,
    pub names: Names,
    pub labels: Labels,
    pub author: String,
    pub conflict: String,
    pub quiet: Duration,
    pub max_wait: Duration,
    pub settle: Duration,
    pub composing: Arc<dyn Fn() -> bool + Send + Sync>,
    pub marker: fn(&str) -> Option<String>,
}

impl Options {
    pub fn new(
        root: impl Into<PathBuf>,
        installation: impl Into<String>,
        app: impl Into<String>,
    ) -> Self {
        Self {
            root: root.into(),
            installation: installation.into(),
            app: app.into(),
            names: Names {
                contents: "目录".into(),
                assets: "素材库".into(),
                untitled: "未命名".into(),
            },
            labels: Labels::default(),
            author: "Markdown 文件夹".into(),
            conflict: "这一段同时在 Drifting 和外部文件里改过。".into(),
            quiet: Duration::from_secs(5),
            max_wait: Duration::from_secs(30),
            settle: Duration::from_millis(400),
            composing: Arc::new(|| false),
            marker: |_| None,
        }
    }
}

enum Msg {
    Change(BookId),
    Disk,
    Sync(mpsc::Sender<Result<Report, String>>),
    Stop,
}

type IssueListener = Arc<dyn Fn(&[Issue]) + Send + Sync>;
type PreservedListener = Arc<dyn Fn(&[PathBuf]) + Send + Sync>;

#[derive(Default)]
struct State {
    issues: BTreeMap<String, Vec<Issue>>,
    listeners: Vec<IssueListener>,
    preserved: Vec<PreservedListener>,
}

/// Only this worker advances the ledger or edits files under the chosen
/// root; synchronous drains join before the library can be replaced.
pub struct Mirror {
    tx: mpsc::Sender<Msg>,
    shared: Arc<Mutex<State>>,
    _watcher: notify::RecommendedWatcher,
    _subscription: Subscription,
    worker: Option<JoinHandle<()>>,
}

impl Mirror {
    pub fn start(ws: Workspace, mut options: Options) -> std::io::Result<Self> {
        std::fs::create_dir_all(&options.root)?;
        options.root = options.root.canonicalize()?;
        let (tx, rx) = mpsc::channel();
        let events = tx.clone();
        let subscription = ws.subscribe(move |event| {
            let book = match event {
                WsEvent::Book(e) if e.origin != Origin::Mirror => Some(&e.book),
                WsEvent::Prose(e) if e.origin != Origin::Mirror => e.book.as_ref(),
                WsEvent::Checkpoints(e) if e.origin != Origin::Mirror => Some(&e.book),
                _ => None,
            };
            if let Some(book) = book {
                let _ = events.send(Msg::Change(book.clone()));
            }
        });
        let file_events = tx.clone();
        let root = options.root.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event
                    && !event.kind.is_access()
                    && event
                        .paths
                        .iter()
                        .any(|p| !ignored(p.strip_prefix(&root).unwrap_or(p)))
                {
                    let _ = file_events.send(Msg::Disk);
                }
            })
            .map_err(std::io::Error::other)?;
        watcher
            .watch(&options.root, notify::RecursiveMode::Recursive)
            .map_err(std::io::Error::other)?;
        let shared = Arc::new(Mutex::new(State::default()));
        let state = shared.clone();
        let worker = std::thread::Builder::new()
            .name("dr-mirror".into())
            .spawn(move || run(ws, options, rx, state))?;
        Ok(Self {
            tx,
            shared,
            worker: Some(worker),
            _watcher: watcher,
            _subscription: subscription,
        })
    }

    pub fn sync_now(&self) -> Result<Report, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Msg::Sync(tx))
            .map_err(|_| "Markdown folder worker stopped".to_owned())?;
        rx.recv()
            .map_err(|_| "Markdown folder worker stopped".to_owned())?
    }

    pub fn issues(&self) -> Vec<Issue> {
        lock(&self.shared)
            .issues
            .values()
            .flatten()
            .cloned()
            .collect()
    }

    pub fn on_issues(&self, f: impl Fn(&[Issue]) + Send + Sync + 'static) {
        let f = Arc::new(f);
        let current: Vec<Issue> = {
            let mut shared = lock(&self.shared);
            shared.listeners.push(f.clone());
            shared.issues.values().flatten().cloned().collect()
        };
        f(&current);
    }

    pub fn on_preserved(&self, f: impl Fn(&[PathBuf]) + Send + Sync + 'static) {
        lock(&self.shared).preserved.push(Arc::new(f));
    }

    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = self.tx.send(Msg::Stop);
            let _ = worker.join();
        }
    }
}

impl Drop for Mirror {
    fn drop(&mut self) {
        self.halt();
    }
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

fn ignored(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
}

#[derive(Default)]
struct Schedule {
    app: BTreeMap<BookId, (Instant, Instant)>,
    disk: Option<Instant>,
}

impl Schedule {
    fn app_due(first: Instant, last: Instant, options: &Options) -> Instant {
        (last + options.quiet).min(first + options.max_wait)
    }

    fn next(&self, options: &Options) -> Option<Instant> {
        self.app
            .values()
            .map(|&(first, last)| Self::app_due(first, last, options))
            .chain(self.disk)
            .min()
    }

    fn retry(&mut self, report: &Report, options: &Options) {
        if report.waiting {
            self.disk = Some(Instant::now() + options.settle.max(Duration::from_millis(100)));
        }
    }
}

fn run(ws: Workspace, options: Options, rx: mpsc::Receiver<Msg>, state: Arc<Mutex<State>>) {
    let pass = Pass::new(&ws, &options);
    let mut schedule = Schedule {
        disk: Some(Instant::now()),
        ..Default::default()
    };
    let mut running = true;
    while running {
        let message = match schedule.next(&options) {
            Some(due) => rx.recv_timeout(due.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        let now = Instant::now();
        match message {
            Ok(Msg::Change(book)) => {
                schedule
                    .app
                    .entry(book)
                    .and_modify(|(_, last)| *last = now)
                    .or_insert((now, now));
            }
            Ok(Msg::Disk) => {
                let due = now + options.settle;
                schedule.disk = Some(schedule.disk.map_or(due, |previous| previous.min(due)));
            }
            Ok(Msg::Sync(reply)) => {
                schedule = Schedule::default();
                let result = pass.run();
                if let Ok(report) = &result {
                    publish(&state, report, None);
                    schedule.retry(report, &options);
                }
                let _ = reply.send(result.map_err(|e| e.to_string()));
            }
            Ok(Msg::Stop) => {
                match pass.run() {
                    Ok(report) => publish(&state, &report, None),
                    Err(err) => log::warn!("Markdown folder final pass: {err}"),
                }
                running = false;
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if schedule.disk.is_some_and(|due| due <= now) {
            schedule.disk = None;
            match pass.run() {
                Ok(report) => {
                    publish(&state, &report, None);
                    schedule.retry(&report, &options);
                }
                Err(err) => log::warn!("Markdown folder: {err}"),
            }
        }
        schedule.app.retain(|book, &mut (first, last)| {
            if Schedule::app_due(first, last, &options) > now {
                return true;
            }
            match pass.book(book) {
                Ok(report) => {
                    publish(&state, &report, Some(book));
                    if report.waiting {
                        schedule.disk =
                            Some(Instant::now() + options.settle.max(Duration::from_millis(100)));
                    }
                }
                Err(err) => log::warn!("Markdown folder: {err}"),
            }
            false
        });
    }
}

fn publish(state: &Mutex<State>, report: &Report, book: Option<&BookId>) {
    let (listeners, current, preserved) = {
        let mut state = lock(state);
        let before = state.issues.clone();
        if let Some(book) = book {
            state.issues.remove(book.as_str());
        } else {
            state.issues.clear();
        }
        for issue in &report.issues {
            state
                .issues
                .entry(issue.book.clone())
                .or_default()
                .push(issue.clone());
        }
        let listeners = if state.issues == before {
            Vec::new()
        } else {
            state.listeners.clone()
        };
        let current: Vec<_> = state.issues.values().flatten().cloned().collect();
        (listeners, current, state.preserved.clone())
    };
    for listener in listeners {
        listener(&current);
    }
    if !report.preserved.is_empty() {
        for listener in preserved {
            listener(&report.preserved);
        }
    }
}
