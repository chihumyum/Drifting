//! File watching and writeback scheduling for the open library.

use std::collections::{BTreeMap, BTreeSet};
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
    disk,
    layout::Names,
    sync::{self, Issue, Pass, Report, Seen},
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
    /// Paths the watcher reported; empty when it lost track (rescan all).
    Disk(Vec<PathBuf>),
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
                let Ok(event) = event else { return };
                if event.kind.is_access() {
                    return;
                }
                if event.need_rescan() {
                    let _ = file_events.send(Msg::Disk(Vec::new()));
                    return;
                }
                let paths: Vec<_> = event
                    .paths
                    .into_iter()
                    .filter(|p| !ignored(p.strip_prefix(&root).unwrap_or(p)))
                    .collect();
                if !paths.is_empty() {
                    let _ = file_events.send(Msg::Disk(paths));
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

/// Which projects the next disk pass covers.
#[derive(Default)]
struct Dirty {
    all: bool,
    books: BTreeSet<BookId>,
}

#[derive(Default)]
struct Schedule {
    app: BTreeMap<BookId, (Instant, Instant)>,
    disk: Option<Instant>,
    dirty: Dirty,
    /// Projects with a file waiting for the author's composition: no pass
    /// runs for them until it ended.
    composing: BTreeSet<BookId>,
    composing_check: Option<Instant>,
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
            .chain(self.composing_check)
            .min()
    }

    fn soon(&mut self, at: Instant) {
        self.disk = Some(self.disk.map_or(at, |previous| previous.min(at)));
    }

    fn disk_changed(&mut self, now: Instant, options: &Options, target: Target) {
        match target {
            Target::None => return,
            Target::All => self.dirty.all = true,
            Target::Book(book) => {
                self.dirty.books.insert(book);
            }
        }
        self.soon(now + options.settle);
    }

    /// A pass left files waiting: only their projects are looked at again,
    /// and a composition is waited out without any pass.
    fn retry(&mut self, report: &Report, options: &Options) {
        let later = Instant::now() + options.settle.max(Duration::from_millis(100));
        if !report.retry.is_empty() {
            self.dirty.books.extend(report.retry.iter().cloned());
            self.soon(later);
        }
        if !report.composing.is_empty() {
            self.composing.extend(report.composing.iter().cloned());
            self.composing_check = Some(self.composing_check.map_or(later, |at| at.min(later)));
        }
    }
}

enum Target {
    None,
    All,
    Book(BookId),
}

/// The project folders as the last passes left them.
#[derive(Default)]
struct Index {
    books: BTreeMap<BookId, Seen>,
    /// What the last metadata check found.
    checked: BTreeMap<PathBuf, disk::Stat>,
}

impl Index {
    fn absorb(&mut self, report: &Report) {
        for (book, seen) in &report.seen {
            self.books.insert(book.clone(), seen.clone());
        }
    }

    /// The project a reported path belongs to. The App's own writes (the
    /// size and time the ledger recorded) and folders are not changes.
    fn classify(&self, path: &Path) -> Target {
        for (book, seen) in &self.books {
            if !path.starts_with(&seen.dir) {
                continue;
            }
            if let Some(stat) = seen.files.get(path)
                && disk::stat(path).ok().flatten() == Some(*stat)
            {
                return Target::None;
            }
            if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
                return Target::None;
            }
            return Target::Book(book.clone());
        }
        Target::All
    }

    /// Native watchers can delay or drop an event. A Markdown file whose
    /// size or time is neither what the ledger recorded nor what the last
    /// check found changed outside.
    fn check(&mut self) -> BTreeSet<BookId> {
        let mut now = BTreeMap::new();
        let mut changed = BTreeSet::new();
        for (book, seen) in &self.books {
            let Ok(files) = sync::disk_markdown(&seen.dir, "", "") else {
                // A missing, replaced or inaccessible project directory also
                // needs a pass when the native watcher misses its event.
                changed.insert(book.clone());
                continue;
            };
            for file in files {
                if let Ok(path) = disk::checked(&seen.dir, &file, false)
                    && let Ok(Some(stat)) = disk::stat(&path)
                {
                    if seen.files.get(&path) != Some(&stat)
                        && self.checked.get(&path) != Some(&stat)
                    {
                        changed.insert(book.clone());
                    }
                    now.insert(path, stat);
                }
            }
            let gone = seen.files.keys().any(|path| {
                path.extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("md"))
                    && !now.contains_key(path)
                    && self.checked.contains_key(path)
            });
            if gone {
                changed.insert(book.clone());
            }
        }
        self.checked = now;
        changed
    }
}

/// Metadata checks run so far (the no-notification test waits for one).
#[cfg(test)]
static CHECKS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn run(ws: Workspace, options: Options, rx: mpsc::Receiver<Msg>, state: Arc<Mutex<State>>) {
    let pass = Pass::new(&ws, &options);
    let mut schedule = Schedule {
        disk: Some(Instant::now()),
        dirty: Dirty {
            all: true,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut index = Index::default();
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
            Ok(Msg::Disk(paths)) if paths.is_empty() => {
                schedule.disk_changed(now, &options, Target::All);
            }
            Ok(Msg::Disk(paths)) => {
                for path in paths {
                    let target = index.classify(&path);
                    schedule.disk_changed(now, &options, target);
                }
            }
            Ok(Msg::Sync(reply)) => {
                schedule = Schedule::default();
                let result = pass.run();
                if let Ok(report) = &result {
                    publish(&state, report, None);
                    index.absorb(report);
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
            for book in index.check() {
                schedule.disk_changed(now, &options, Target::Book(book));
            }
            #[cfg(test)]
            CHECKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            check_disk_at = Instant::now() + DISK_CHECK_INTERVAL;
        }
        if schedule.composing_check.is_some_and(|at| at <= now) {
            schedule.composing_check = None;
            if (options.composing)() {
                schedule.composing_check =
                    Some(Instant::now() + options.settle.max(Duration::from_millis(100)));
            } else {
                let waiting = std::mem::take(&mut schedule.composing);
                schedule.dirty.books.extend(waiting);
                schedule.soon(now);
            }
        }
        if schedule.disk.is_some_and(|due| due <= now) {
            schedule.disk = None;
            let dirty = std::mem::take(&mut schedule.dirty);
            let books = (!dirty.all).then_some(&dirty.books);
            // Ingest disk edits now. A file watcher must not bypass a
            // pending App writeback deadline (including our own file events).
            match pass.reconcile(books, |book| !schedule.app.contains_key(book)) {
                Ok(report) => {
                    publish(&state, &report, books);
                    index.absorb(&report);
                    schedule.retry(&report, &options);
                }
                Err(err) => log::warn!("Markdown folder: {err}"),
            }
        }
        let due: Vec<_> = schedule
            .app
            .iter()
            .filter(|&(_, &(first, last))| Schedule::app_due(first, last, &options) <= now)
            .map(|(book, _)| book.clone())
            .collect();
        for book in due {
            schedule.app.remove(&book);
            let books = BTreeSet::from([book]);
            match pass.reconcile(Some(&books), |_| true) {
                Ok(report) => {
                    publish(&state, &report, Some(&books));
                    index.absorb(&report);
                    schedule.retry(&report, &options);
                }
                Err(err) => log::warn!("Markdown folder: {err}"),
            }
        }
    }
}

/// `books`: the projects the pass covered (all when `None`). An issue about
/// the chosen folder itself is replaced by every pass.
fn publish(state: &Mutex<State>, report: &Report, books: Option<&BTreeSet<BookId>>) {
    let (listeners, current, preserved) = {
        let mut state = lock(state);
        let before = state.issues.clone();
        let unreachable = report.issues.iter().any(|issue| issue.book.is_empty());
        let failed: BTreeSet<_> = report
            .issues
            .iter()
            .filter(|issue| {
                !issue.book.is_empty()
                    && !report.seen.keys().any(|book| book.as_str() == issue.book)
            })
            .map(|issue| issue.book.as_str())
            .collect();
        state.issues.retain(|book, issues| {
            if book.is_empty() {
                return false;
            }
            if unreachable || books.is_some_and(|books| !books.iter().any(|b| b.as_str() == book)) {
                return true;
            }
            // A failed project never reached settle, so it cannot confirm
            // that its previously preserved files have been dealt with.
            if failed.contains(book.as_str()) {
                issues.retain(|issue| issue.kept.is_some());
                return !issues.is_empty();
            }
            false
        });
        for issue in &report.issues {
            let issues = state.issues.entry(issue.book.clone()).or_default();
            if !issues.contains(issue) {
                issues.push(issue.clone());
            }
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
    fn partial_pass_callbacks_keep_unrelated_and_unreachable_notices() {
        let first = BookId::parse("first").unwrap();
        let second = BookId::parse("second").unwrap();
        let issue = |book: &BookId| Issue {
            book: book.to_string(),
            doc: None,
            title: book.to_string(),
            path: PathBuf::from("folder"),
            problem: sync::Problem::Frontmatter,
            kept: None,
        };
        let shared = Mutex::new(State::default());
        let (tx, rx) = mpsc::channel();
        lock(&shared).listeners.push(Arc::new(move |issues| {
            tx.send(issues.to_vec()).unwrap();
        }));
        publish(
            &shared,
            &Report {
                issues: vec![issue(&first), issue(&second)],
                ..Default::default()
            },
            None,
        );
        assert_eq!(rx.recv().unwrap().len(), 2);
        publish(&shared, &Report::default(), Some(&BTreeSet::from([first])));
        assert_eq!(rx.recv().unwrap(), vec![issue(&second)]);
        let mut inaccessible = issue(&second);
        inaccessible.book.clear();
        inaccessible.problem = sync::Problem::Disk;
        publish(
            &shared,
            &Report {
                issues: vec![inaccessible],
                ..Default::default()
            },
            None,
        );
        let current = rx.recv().unwrap();
        assert_eq!(current.len(), 2);
        assert!(current.contains(&issue(&second)));
    }

    #[test]
    fn own_writes_and_composition_waits_do_not_schedule_full_passes() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("body.md");
        fs::write(&path, b"owned bytes").unwrap();
        let book = BookId::parse("book").unwrap();
        let seen = Seen {
            dir: folder.path().to_path_buf(),
            files: BTreeMap::from([(path.clone(), disk::stat(&path).unwrap().unwrap())]),
        };
        let mut index = Index::default();
        index.books.insert(book.clone(), seen);
        assert!(matches!(index.classify(&path), Target::None));
        assert!(index.check().is_empty());
        fs::write(&path, b"outside bytes").unwrap();
        assert!(matches!(index.classify(&path), Target::Book(id) if id == book));
        assert_eq!(index.check(), BTreeSet::from([book.clone()]));
        assert!(index.check().is_empty());
        let mut schedule = Schedule::default();
        schedule.retry(
            &Report {
                composing: BTreeSet::from([book.clone()]),
                waiting: true,
                ..Default::default()
            },
            &Options::new(folder.path(), "test", "test"),
        );
        assert!(schedule.disk.is_none());
        assert!(!schedule.dirty.all && schedule.dirty.books.is_empty());
        assert_eq!(schedule.composing, BTreeSet::from([book]));
        assert!(schedule.composing_check.is_some());
    }

    #[test]
    fn a_failed_project_pass_keeps_its_preserved_issues_until_a_successful_pass() {
        let book = BookId::parse("book").unwrap();
        let kept = Issue {
            book: book.to_string(),
            doc: Some("body:entry/mod-prose".into()),
            title: "preserved change".into(),
            path: PathBuf::from("project/body.md"),
            problem: sync::Problem::FieldConflict,
            kept: Some(PathBuf::from("project/.drifting/preserved/body.md")),
        };
        for problem in [
            sync::Problem::Disk,
            sync::Problem::UnsafePath,
            sync::Problem::OwnedElsewhere,
        ] {
            for partial in [false, true] {
                let shared = Mutex::new(State::default());
                let books = BTreeSet::from([book.clone()]);
                let selected = partial.then_some(&books);
                publish(
                    &shared,
                    &Report {
                        issues: vec![kept.clone()],
                        ..Default::default()
                    },
                    None,
                );
                let failure = Issue {
                    book: book.to_string(),
                    doc: None,
                    title: "unavailable project".into(),
                    path: PathBuf::from("project"),
                    problem,
                    kept: None,
                };
                let failed = Report {
                    issues: vec![failure.clone()],
                    ..Default::default()
                };
                publish(&shared, &failed, selected);
                publish(&shared, &failed, selected);
                assert_eq!(
                    lock(&shared).issues[book.as_str()],
                    vec![kept.clone(), failure]
                );
                let successful = Report {
                    seen: BTreeMap::from([(
                        book.clone(),
                        Seen {
                            dir: PathBuf::from("project"),
                            files: BTreeMap::new(),
                        },
                    )]),
                    ..Default::default()
                };
                publish(&shared, &successful, selected);
                assert!(lock(&shared).issues.is_empty());
            }
        }
    }

    #[test]
    fn a_missing_project_folder_schedules_a_pass_without_a_native_event() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("project");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("body.md");
        fs::write(&path, b"projected body").unwrap();
        let book = BookId::parse("book").unwrap();
        let mut index = Index::default();
        index.books.insert(
            book.clone(),
            Seen {
                dir: dir.clone(),
                files: BTreeMap::from([(path.clone(), disk::stat(&path).unwrap().unwrap())]),
            },
        );
        assert!(index.check().is_empty());
        fs::rename(&dir, root.path().join("moved-project")).unwrap();
        assert_eq!(index.check(), BTreeSet::from([book.clone()]));
        // A regular file at the old directory name is also an error to report.
        fs::write(&dir, b"unavailable mount").unwrap();
        assert_eq!(index.check(), BTreeSet::from([book]));
        assert_eq!(
            fs::read(root.path().join("moved-project/body.md")).unwrap(),
            b"projected body"
        );
        assert_eq!(fs::read(&dir).unwrap(), b"unavailable mount");
    }

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
        // The old implementation initialized its polling baseline here,
        // after the first pass. Editing before this check hid that bug.
        let checked = CHECKS.load(std::sync::atomic::Ordering::SeqCst);
        let start = Instant::now();
        while CHECKS.load(std::sync::atomic::Ordering::SeqCst) == checked {
            assert!(start.elapsed() < Duration::from_secs(6));
            std::thread::sleep(Duration::from_millis(25));
        }
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
