//! The writing-day recorder: how many words this device added to each book
//! today (docs/writing-days.md, the 0.1 client's `writing-day-recorder.ts`).
//!
//! A day's words are the book's chapter total minus a baseline. The
//! recorder follows each chapter's words in the derived index, document by
//! document:
//!
//! - when the index moves a chapter that this device wrote (a prose change
//!   from the author, an Agent or the Markdown folder), the total moves and
//!   the baseline stays: the words count;
//! - when it moves for any other reason (a change from another device, an
//!   import, a rebuild of an index that was behind), the baseline moves with
//!   it: the words were written elsewhere, or earlier;
//! - chapters that appear or leave (created, trashed, restored) move the
//!   baseline too: that is not writing (the 0.1 client counted a restored
//!   chapter as written; this does not).
//!
//! Deleting more than was written reads as zero. The first time a book is
//! seen on a day, the baseline starts below the total by the words already
//! stored for this device, so reopening keeps the morning's words. Each
//! book's row is written at most once a minute while its words move, and
//! again on [`Recorder::flush`] (before quitting).
//!
//! The work runs on its own thread: dr-workspace delivers events on holder
//! threads, and the recorder's reads (one document's index row) and writes
//! (one book-document key) never wait for the interface.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dr_doc::book::Collection;
use dr_model::Day;
use dr_store::Origin;
use dr_workspace::commands::stats::{self as ops, day_number};
use dr_workspace::{Actor, Workspace, WsEvent};

/// How long after the first unsaved change a book's row is written.
pub const PERSIST_DELAY: Duration = Duration::from_secs(60);

/// What the recorder reads and writes; [`WorkspaceSource`] in the app, a
/// fake in tests.
pub trait Source: Send + 'static {
    /// The book's live chapters (prose document ids) with their indexed
    /// words; `None` when the book cannot be read now.
    fn chapters(&self, book: &str) -> Option<Vec<(String, u64)>>;
    /// A document's indexed words (`None`: not indexed).
    fn words(&self, doc: &str) -> Option<u64>;
    /// This device's stored words for `day` (0 when none).
    fn stored(&self, book: &str, day: &Day) -> i64;
    /// Store this device's words for `day`; false when it could not.
    fn store(&self, book: &str, day: &Day, words: i64) -> bool;
}

/// Whether a prose change is this device's writing.
pub fn writes_here(origin: &Origin) -> bool {
    // The author typing or by a command (`Origin::Command`), an Agent, the
    // mirror.
    origin.is_author() || matches!(origin, Origin::Agent(_) | Origin::Mirror)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pending {
    Here,
    Elsewhere,
}

#[derive(Debug)]
struct BookTally {
    /// Chapter documents and their indexed words.
    chapters: HashMap<String, u64>,
    day: i64,
    total: i64,
    baseline: i64,
    /// What the book document holds for this device and `day`.
    stored: i64,
    /// The first change not stored yet.
    dirty_since: Option<Instant>,
}

impl BookTally {
    fn words(&self) -> i64 {
        (self.total - self.baseline).max(0)
    }
}

/// The recorder's state, without threads or a library: events in, rows
/// out through the [`Source`].
pub struct Tracker<S: Source> {
    source: S,
    books: HashMap<String, BookTally>,
    /// Chapter document → its book, for the tracked books.
    owner: HashMap<String, String>,
    /// Prose changes waiting for the index to catch up, per document.
    pending: HashMap<String, Pending>,
    /// Books whose chapters could not be read; tried again on the next
    /// change.
    unreadable: HashSet<String>,
}

impl<S: Source> Tracker<S> {
    pub fn new(source: S) -> Self {
        Tracker {
            source,
            books: HashMap::new(),
            owner: HashMap::new(),
            pending: HashMap::new(),
            unreadable: HashSet::new(),
        }
    }

    pub fn source(&self) -> &S {
        &self.source
    }

    /// Today's words of `book` on this device, when the recorder follows it.
    pub fn today(&self, book: &str) -> Option<i64> {
        self.books.get(book).map(BookTally::words)
    }

    /// Start following `book` (the open one, or one this device writes).
    pub fn track(&mut self, book: &str, today: &Day) -> bool {
        if self.books.contains_key(book) {
            return true;
        }
        let Some(chapters) = self.source.chapters(book) else {
            self.unreadable.insert(book.to_owned());
            return false;
        };
        self.unreadable.remove(book);
        let total = chapters.iter().map(|(_, w)| *w as i64).sum::<i64>();
        for (doc, _) in &chapters {
            self.owner.insert(doc.clone(), book.to_owned());
        }
        let stored = self.source.stored(book, today).max(0);
        self.books.insert(
            book.to_owned(),
            BookTally {
                chapters: chapters.into_iter().collect(),
                day: day_number(today),
                total,
                baseline: total - stored,
                stored,
                dirty_since: None,
            },
        );
        true
    }

    /// A prose document changed (persisted; the index follows when its
    /// holder is idle).
    pub fn prose(&mut self, doc: &str, book: Option<&str>, here: bool, today: &Day, now: Instant) {
        let entry = self
            .pending
            .entry(doc.to_owned())
            .or_insert(Pending::Elsewhere);
        if here {
            *entry = Pending::Here;
            if let Some(book) = book {
                self.track(book, today);
                self.roll(book, today, now);
            }
        }
    }

    /// The derived index of `doc` was written.
    pub fn indexed(&mut self, doc: &str, today: &Day, now: Instant) {
        let pending = self.pending.remove(doc);
        let Some(book) = self.owner.get(doc).cloned() else {
            return;
        };
        self.roll(&book, today, now);
        let new = self.source.words(doc).unwrap_or(0);
        let Some(t) = self.books.get_mut(&book) else {
            return;
        };
        let old = t.chapters.insert(doc.to_owned(), new).unwrap_or(0);
        let delta = new as i64 - old as i64;
        if delta == 0 {
            return;
        }
        let before = t.words();
        t.total += delta;
        if pending != Some(Pending::Here) {
            t.baseline += delta;
        }
        if t.words() != before {
            t.dirty_since.get_or_insert(now);
        }
    }

    /// A book's chapters may have come or gone: read the set again.
    pub fn chapters_changed(&mut self, book: &str, today: &Day, now: Instant) {
        if self.unreadable.contains(book) {
            self.track(book, today);
            return;
        }
        if !self.books.contains_key(book) {
            return;
        }
        let Some(now_chapters) = self.source.chapters(book) else {
            return;
        };
        self.roll(book, today, now);
        let t = self.books.get_mut(book).expect("checked above");
        let fresh: HashMap<String, u64> = now_chapters.into_iter().collect();
        let gone: Vec<String> = t
            .chapters
            .keys()
            .filter(|d| !fresh.contains_key(*d))
            .cloned()
            .collect();
        for doc in gone {
            let w = t.chapters.remove(&doc).unwrap_or(0) as i64;
            t.total -= w;
            t.baseline -= w;
            self.owner.remove(&doc);
        }
        for (doc, w) in fresh {
            if !t.chapters.contains_key(&doc) {
                t.total += w as i64;
                t.baseline += w as i64;
                t.chapters.insert(doc.clone(), w);
                self.owner.insert(doc, book.to_owned());
            }
        }
    }

    /// A new day: store the old one's words, start the new one.
    fn roll(&mut self, book: &str, today: &Day, now: Instant) {
        let n = day_number(today);
        let Some(t) = self.books.get(book) else {
            return;
        };
        if t.day == n {
            return;
        }
        let old_day = ops::day_of_number(t.day);
        let words = t.words();
        if words != t.stored {
            self.source.store(book, &old_day, words);
        }
        let stored = self.source.stored(book, today).max(0);
        let t = self.books.get_mut(book).expect("checked above");
        t.day = n;
        t.baseline = t.total - stored;
        t.stored = stored;
        t.dirty_since = None;
        let _ = now;
    }

    /// Store every book whose first unsaved change is older than `delay`
    /// (all of them with `Duration::ZERO`). Returns when the next one is
    /// due.
    pub fn persist(&mut self, now: Instant, delay: Duration) -> Option<Instant> {
        let mut next: Option<Instant> = None;
        let due: Vec<String> = self
            .books
            .iter()
            .filter_map(|(b, t)| {
                let since = t.dirty_since?;
                if now.duration_since(since) >= delay {
                    Some(b.clone())
                } else {
                    let at = since + delay;
                    next = Some(next.map_or(at, |n: Instant| n.min(at)));
                    None
                }
            })
            .collect();
        for book in due {
            let t = &self.books[&book];
            let (day, words) = (ops::day_of_number(t.day), t.words());
            let stored = words == t.stored || self.source.store(&book, &day, words);
            let t = self.books.get_mut(&book).expect("listed above");
            if stored {
                t.stored = words;
                t.dirty_since = None;
            } else {
                // Try again a while later.
                t.dirty_since = Some(now);
                let at = now + delay.max(Duration::from_secs(1));
                next = Some(next.map_or(at, |n| n.min(at)));
            }
        }
        next
    }

    /// Feed one workspace event.
    pub fn event(&mut self, event: &WsEvent, today: &Day, now: Instant) {
        match event {
            WsEvent::Prose(p) => {
                let book = p.book.as_ref().map(|b| b.as_str());
                self.prose(&p.doc.to_string(), book, writes_here(&p.origin), today, now)
            }
            WsEvent::Local(c) if c.table == "index" => self.indexed(&c.key, today, now),
            WsEvent::Book(b) if b.changes.iter().any(|c| c.collection == Collection::Nodes) => {
                self.chapters_changed(b.book.as_str(), today, now)
            }
            _ => {}
        }
    }
}

/// The library behind the recorder in the app.
pub struct WorkspaceSource {
    pub ws: Workspace,
    /// This device's writing-day key; without one nothing is stored.
    pub device: Option<String>,
}

impl Source for WorkspaceSource {
    fn chapters(&self, book: &str) -> Option<Vec<(String, u64)>> {
        let out = self
            .ws
            .run::<ops::WordCounts>(
                &Actor::User,
                dr_workspace::commands::BookIn {
                    book: book.to_owned(),
                },
            )
            .ok()?;
        Some(
            out.output
                .chapters
                .into_iter()
                .map(|c| (c.doc, c.count.words))
                .collect(),
        )
    }

    fn words(&self, doc: &str) -> Option<u64> {
        self.ws
            .library()
            .doc_stats(doc)
            .ok()
            .flatten()
            .map(|s| s.words)
    }

    fn stored(&self, book: &str, day: &Day) -> i64 {
        let Some(device) = &self.device else {
            return 0;
        };
        self.ws
            .run::<ops::WritingDays>(
                &Actor::User,
                ops::WritingDaysIn {
                    book: book.to_owned(),
                    today: day.to_string(),
                    days: Some(1),
                    device: Some(device.clone()),
                },
            )
            .map(|o| o.output.mine_today)
            .unwrap_or(0)
    }

    fn store(&self, book: &str, day: &Day, words: i64) -> bool {
        let Some(device) = &self.device else {
            return true;
        };
        match self.ws.run::<ops::WritingDayRecord>(
            &Actor::User,
            ops::WritingDayIn {
                book: book.to_owned(),
                device: device.clone(),
                day: day.to_string(),
                words,
            },
        ) {
            Ok(_) => true,
            Err(error) => {
                log::warn!("writing day of {book} not stored: {error}");
                false
            }
        }
    }
}

enum Msg {
    Event(WsEvent),
    Track(String),
    Flush(Sender<()>),
    Stop,
}

/// Today's words per followed book, as the recorder last tallied them.
pub type Today = Arc<Mutex<HashMap<String, i64>>>;

/// The recorder thread and its inbox.
pub struct Recorder {
    tx: Sender<Msg>,
    today: Today,
    _subscription: Option<dr_workspace::Subscription>,
}

impl Recorder {
    /// Starts the thread. `changed` runs on it after a book's words moved.
    pub fn start<S: Source>(
        source: S,
        clock: fn() -> Day,
        delay: Duration,
        changed: impl Fn(&str) + Send + 'static,
    ) -> Recorder {
        let (tx, rx) = mpsc::channel::<Msg>();
        let today: Today = Arc::default();
        let shared = today.clone();
        std::thread::Builder::new()
            .name("writing-days".into())
            .spawn(move || {
                let mut t = Tracker::new(source);
                let mut deadline: Option<Instant> = None;
                loop {
                    let msg = match deadline {
                        Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
                        None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                    };
                    let now = Instant::now();
                    let day = clock();
                    let mut flush = None;
                    match msg {
                        Ok(Msg::Event(e)) => t.event(&e, &day, now),
                        Ok(Msg::Track(book)) => {
                            t.track(&book, &day);
                            t.roll(&book, &day, now);
                        }
                        Ok(Msg::Flush(done)) => flush = Some(done),
                        Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => {
                            t.persist(now, Duration::ZERO);
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    let wait = if flush.is_some() {
                        Duration::ZERO
                    } else {
                        delay
                    };
                    deadline = t.persist(now, wait);
                    if let Some(done) = flush {
                        let _ = done.send(());
                    }
                    let mut moved = Vec::new();
                    {
                        let mut today = shared.lock().unwrap_or_else(|e| e.into_inner());
                        for (book, tally) in &t.books {
                            let w = tally.words();
                            if today.insert(book.clone(), w) != Some(w) {
                                moved.push(book.clone());
                            }
                        }
                    }
                    for book in moved {
                        changed(&book);
                    }
                }
            })
            .expect("the writing-days thread starts");
        Recorder {
            tx,
            today,
            _subscription: None,
        }
    }

    /// Starts the recorder over the library and subscribes it to the
    /// library's events.
    pub fn over(ws: &Workspace, changed: impl Fn(&str) + Send + 'static) -> Recorder {
        let device = ws.writing_device();
        if device.is_none() {
            log::info!("no device identity: writing days are tallied but not stored");
        }
        let mut r = Recorder::start(
            WorkspaceSource {
                ws: ws.clone(),
                device,
            },
            crate::clock::today,
            PERSIST_DELAY,
            changed,
        );
        let tx = r.tx.clone();
        r._subscription = Some(ws.subscribe(move |e| {
            if matches!(e, WsEvent::Prose(_) | WsEvent::Local(_) | WsEvent::Book(_)) {
                let _ = tx.send(Msg::Event(e.clone()));
            }
        }));
        r
    }

    /// Follow `book` from now on (the book the window shows).
    pub fn track(&self, book: &str) {
        let _ = self.tx.send(Msg::Track(book.to_owned()));
    }

    /// Feed one event by hand (tests; the app subscribes in [`Self::over`]).
    pub fn event(&self, event: WsEvent) {
        let _ = self.tx.send(Msg::Event(event));
    }

    /// Today's words of `book` on this device, when followed.
    pub fn today(&self, book: &str) -> Option<i64> {
        self.today
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(book)
            .copied()
    }

    /// Store every unsaved day now; waits up to `timeout`.
    pub fn flush(&self, timeout: Duration) -> bool {
        let (done, wait) = mpsc::channel();
        if self.tx.send(Msg::Flush(done)).is_err() {
            return false;
        }
        wait.recv_timeout(timeout).is_ok()
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_authors_commands_are_writing_here() {
        assert!(writes_here(&Origin::User));
        assert!(writes_here(&Origin::Command));
        assert!(writes_here(&Origin::agent("s", 1)));
        assert!(writes_here(&Origin::Mirror));
        assert!(!writes_here(&Origin::Sync));
        assert!(!writes_here(&Origin::Import));
    }
}
