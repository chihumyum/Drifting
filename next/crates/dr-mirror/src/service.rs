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

const DISK_CHECK_INTERVAL: Duration = Duration::from_secs(4);

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

    fn disk_changed(&mut self, now: Instant, options: &Options) {
        let due = now + options.settle;
        self.disk = Some(self.disk.map_or(due, |previous| previous.min(due)));
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
    let mut disk_stamp = BTreeMap::new();
    let mut check_disk_at = Instant::now() + DISK_CHECK_INTERVAL;
    let mut running = true;
    while running {
        let due = schedule
            .next(&options)
            .map_or(check_disk_at, |due| due.min(check_disk_at));
        let message = rx.recv_timeout(due.saturating_duration_since(Instant::now()));
        let now = Instant::now();
        match message {
            Ok(Msg::Change(book)) => {
                schedule
                    .app
                    .entry(book)
                    .and_modify(|(_, last)| *last = now)
                    .or_insert((now, now));
            }
            Ok(Msg::Disk) => schedule.disk_changed(now, &options),
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
        if check_disk_at <= now {
            // Native watchers can delay or drop an event. A metadata-only
            // check schedules the same pass if the projected files changed.
            match pass.disk_stamp() {
                Ok(stamp) if stamp != disk_stamp => {
                    disk_stamp = stamp;
                    schedule.disk_changed(now, &options);
                }
                Ok(_) => {}
                Err(err) => log::warn!("Markdown folder metadata check: {err}"),
            }
            check_disk_at = Instant::now() + DISK_CHECK_INTERVAL;
        }
        if schedule.disk.is_some_and(|due| due <= now) {
            schedule.disk = None;
            // Ingest disk edits now. A file watcher must not bypass a
            // pending App writeback deadline (including our own file events).
            match pass.reconcile(|book| !schedule.app.contains_key(book)) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use dr_testkit::seed::{DEFAULT_SEED, Preset, acceptance::novel_entry, generate_v3};
    use dr_workspace::Actor;
    use serde_json::json;
    use std::fs;

    #[test]
    fn a_missed_disk_event_is_recovered_while_the_app_is_idle() {
        let db = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(db.path(), "mirror-acceptance").unwrap();
        let seeded = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        seeded.write_to(ws.library()).unwrap();
        seeded.write_files_to(ws.library()).unwrap();
        let title = "监听补扫";
        let entry = novel_entry(&ws, book.as_str(), "tpl-chapter", title, Some("灯还亮着。"));
        let doc = format!("body:{}/mod-prose", entry["id"].as_str().unwrap());
        let options = Options {
            settle: Duration::ZERO,
            ..Options::new(output.path(), "test-installation", "test-app")
        };

        // Drive the real scheduler without a native watcher or App changes.
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn({
            let ws = ws.clone();
            let options = options.clone();
            move || run(ws, options, rx, Arc::new(Mutex::new(State::default())))
        });
        let (reply, ack) = mpsc::channel();
        tx.send(Msg::Sync(reply)).unwrap();
        let report = ack.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
        assert!(!report.waiting, "{report:?}");
        let path = Pass::new(&ws, &options)
            .folder(&book)
            .unwrap()
            .unwrap()
            .join("书稿")
            .join(format!("{title}.md"));
        let changed = fs::read_to_string(&path)
            .unwrap()
            .replace("灯还亮着。", "灯已熄了。");
        fs::write(path, changed).unwrap();

        let start = Instant::now();
        loop {
            let read = ws
                .call(&Actor::User, "prose.read", json!({"doc":doc}))
                .unwrap();
            if read["output"]["paragraphs"][0]["text"] == "灯已熄了。" {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "{read:?}");
            std::thread::sleep(Duration::from_millis(25));
        }
        tx.send(Msg::Stop).unwrap();
        worker.join().unwrap();
    }
}
