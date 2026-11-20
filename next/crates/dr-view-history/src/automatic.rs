//! Entry-wide periodic/close checkpoints, following F2's existing cadence.
//! Holder callbacks only enqueue; a worker takes the checkpoints, many
//! entries of a book in one atomic write (`snapshots::CapturePlan`).
//!
//! Entries without any checkpoint (a library just imported or seeded, a
//! book synced in) get their first one from the worker in the background,
//! a while after it starts and while the author is not typing, a small
//! batch at a time; so the first quit does not have to take a point for
//! every entry of the library. Whatever the pass has not reached when the
//! app quits, the last sweep takes, batched as well.
use dr_doc::v3::BorrowedBookV3;
use dr_model::{DocId, id::BookId};
use dr_store::{LibrarySubscription, Origin, StoreEvent};
use dr_workspace::{Workspace, commands::v3::snapshots as api};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub const PERIODIC_INTERVAL: Duration =
    Duration::from_millis(dr_store::history::PERIODIC_INTERVAL_MS as u64);

/// How long after the worker starts it begins giving entries without a
/// checkpoint their first one: opening the library and its first book come
/// first. A quit before then takes them in the last sweep.
pub const FIRST_POINTS_DELAY: Duration = Duration::from_secs(30);
/// Entries per background write (the first points and the periodic
/// captures). Each write reserves the book and those entries' bodies for a
/// few milliseconds; a keystroke in one of them waits for it.
pub const BACKGROUND_BATCH: usize = 8;
/// Between two first-points writes, for whatever queued behind one.
pub const FIRST_POINTS_GAP: Duration = Duration::from_millis(50);
/// After the author typed, how long the first-points pass waits before its
/// next write.
pub const FIRST_POINTS_QUIET: Duration = Duration::from_secs(2);
/// A first-points write that failed (another write to the book got in
/// between, say) is tried again this much later, three times in all.
const FIRST_POINTS_RETRY: Duration = Duration::from_secs(5);
const FIRST_POINTS_TRIES: u32 = 3;

/// When the worker takes checkpoints.
#[derive(Clone, Copy, Debug)]
pub struct Cadence {
    /// From the first change of an entry to its periodic checkpoint.
    pub interval: Duration,
    /// From the start to the first-points pass; `None`: no pass (the last
    /// sweep gives the entries their first points).
    pub first_points: Option<Duration>,
    /// Between two writes of the pass.
    pub gap: Duration,
    /// How long the pass waits after the author typed.
    pub quiet: Duration,
}
impl Default for Cadence {
    fn default() -> Self {
        Self {
            interval: PERIODIC_INTERVAL,
            first_points: Some(FIRST_POINTS_DELAY),
            gap: FIRST_POINTS_GAP,
            quiet: FIRST_POINTS_QUIET,
        }
    }
}

enum Message {
    /// A persisted change of `doc`; `typed`: the author's own typing.
    Changed {
        doc: String,
        typed: bool,
    },
    Stop(mpsc::Sender<Result<(), String>>),
    #[cfg(test)]
    DirtySnapshot(mpsc::Sender<BTreeSet<(String, String)>>),
    /// One write of the first-points pass now, whatever its timer says:
    /// how many entries it held, or the error.
    #[cfg(test)]
    FirstPointsStep(mpsc::Sender<Result<usize, String>>),
    /// When the pass writes next.
    #[cfg(test)]
    FirstPointsAt(mpsc::Sender<Option<Instant>>),
    /// Stop without the last sweep, as a crash or a forced quit would.
    #[cfg(test)]
    Abandon,
}

/// The first-points pass: which entries are left, in batches.
#[derive(Default)]
struct FirstPoints {
    listed: bool,
    queue: VecDeque<(String, Vec<String>)>,
    tries: u32,
    /// The book of the batches being written, read once for all of them.
    plan: Option<(String, api::CapturePlan)>,
}
impl FirstPoints {
    /// Every entry of every book that has no checkpoint yet, in batches.
    fn list(ws: &Workspace) -> VecDeque<(String, Vec<String>)> {
        let mut queue = VecDeque::new();
        let Ok(books) = ws.library().docs(None, Some("book")) else {
            return queue;
        };
        for info in books {
            let Ok(DocId::Book(book)) = DocId::parse(&info.doc_id) else {
                continue;
            };
            match api::entries_without_checkpoint(ws, book.as_str()) {
                Ok(entries) => {
                    for batch in entries.chunks(BACKGROUND_BATCH) {
                        queue.push_back((book.to_string(), batch.to_vec()));
                    }
                }
                Err(e) => log::warn!("entries without a checkpoint could not be listed: {e}"),
            }
        }
        queue
    }
    /// One write: the entries it held (0 when nothing is left).
    fn step(&mut self, ws: &Workspace) -> Result<usize, String> {
        if !self.listed {
            self.queue = Self::list(ws);
            self.listed = true;
        }
        let Some((book, batch)) = self.queue.pop_front() else {
            self.plan = None;
            return Ok(0);
        };
        let plan = match self.plan.take() {
            Some((of, plan)) if of == book => Ok(plan),
            _ => api::CapturePlan::read(ws, &book),
        };
        let written = plan.and_then(|mut plan| {
            let r = plan.capture(ws, &batch, api::CaptureReason::Periodic);
            self.plan = Some((book.clone(), plan));
            r
        });
        if self.queue.is_empty() {
            self.plan = None;
        }
        match written {
            Ok(_) => {
                self.tries = 0;
                Ok(batch.len())
            }
            Err(e) => {
                self.tries += 1;
                if self.tries < FIRST_POINTS_TRIES {
                    self.queue.push_front((book, batch));
                } else {
                    // Left to the periodic captures and the last sweep.
                    self.tries = 0;
                }
                Err(e.to_string())
            }
        }
    }
    fn done(&self) -> bool {
        self.listed && self.queue.is_empty()
    }
}
pub struct AutomaticHistory {
    send: mpsc::Sender<Message>,
    worker: Option<thread::JoinHandle<()>>,
    subscription: Option<LibrarySubscription>,
}
type BookOwners = BTreeMap<String, String>;

fn initial_book_heads(ws: &Workspace) -> BTreeMap<BookId, loro::Frontiers> {
    let Ok(docs) = ws.library().docs(None, Some("book")) else {
        return BTreeMap::new();
    };
    let mut heads = BTreeMap::new();
    for info in docs {
        let Ok(DocId::Book(book)) = DocId::parse(&info.doc_id) else {
            continue;
        };
        if let Ok(Some(head)) = ws.library().head(&info.doc_id) {
            heads.insert(book, head.frontiers);
        }
    }
    heads
}

/// The fingerprint of every entry of a book: what the entry owns and where
/// it is (`BookViewV3::entry_change_state`), read for all of them in one
/// pass. An entry's fingerprint names no other entry but its parent, so a
/// sibling created, deleted or moved leaves it as it was.
fn owners_from_doc(doc: &loro::LoroDoc, book: &BookId) -> Result<BookOwners, String> {
    if !dr_doc::v3::is_book_doc(doc) {
        return Ok(BTreeMap::new());
    }
    let b = BorrowedBookV3::new(doc, book).map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for (entry, state) in b.view().entry_change_states() {
        let bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
        out.insert(entry.to_string(), dr_store::digest::sha256_hex(&bytes));
    }
    Ok(out)
}
fn book_owners(ws: &Workspace, book: &BookId) -> Result<BookOwners, String> {
    let d = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(|e| e.to_string())?;
    owners_from_doc(&d, book)
}
fn book_owners_at(
    ws: &Workspace,
    book: &BookId,
    frontiers: &loro::Frontiers,
) -> Result<BookOwners, String> {
    let d = ws
        .library()
        .load_copy_at(&format!("book:{book}"), frontiers)
        .map_err(|e| e.to_string())?;
    owners_from_doc(&d, book)
}
/// The periodic captures of the entries in `pending`, a book at a time and
/// [`BACKGROUND_BATCH`] entries per write. Those whose write failed stay in
/// `dirty` for the next round.
fn capture_periodic(
    ws: &Workspace,
    pending: BTreeSet<(String, String)>,
    dirty: &mut BTreeSet<(String, String)>,
) {
    let mut by_book: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (book, entry) in pending {
        by_book.entry(book).or_default().push(entry);
    }
    for (book, entries) in by_book {
        let mut plan = match api::CapturePlan::read(ws, &book) {
            Ok(plan) => plan,
            Err(e) => {
                log::warn!("periodic entry checkpoint failed: {e}");
                dirty.extend(entries.into_iter().map(|entry| (book.clone(), entry)));
                continue;
            }
        };
        for batch in entries.chunks(BACKGROUND_BATCH) {
            if let Err(e) = plan.capture(ws, batch, api::CaptureReason::Periodic) {
                log::warn!("periodic entry checkpoint failed: {e}");
                dirty.extend(batch.iter().map(|entry| (book.clone(), entry.clone())));
            }
        }
    }
}
/// Whether a persisted change can have changed what some entry owns: an
/// entry's prose, or a commit to the book document that touched the entry
/// tree or a collection of entry-owned records. Only then does the worker
/// look at the book's entries (one pass over all of them).
///
/// The writing days (once a minute) and saved checkpoints, in the two
/// documents beside the book, comments and shared templates do not change
/// entry-owned content. In
/// particular they must not materialize every entry's lazy body as a side
/// effect.
fn concerns_entries(e: &dr_store::DocEvent) -> bool {
    if !dr_store::history::records_periodic(&e.origin) {
        return false;
    }
    match DocId::parse(&e.doc_id) {
        Ok(DocId::Body(_)) => true,
        Ok(DocId::Book(_)) => e.changes.iter().any(|c| {
            let root = c.path.first().map(|(id, _)| id).unwrap_or(&c.target);
            matches!(
                root,
                loro::ContainerID::Root { name, .. }
                    if matches!(
                        name.as_str(),
                        "entries" | "patches" | "plot_grids" | "memberships" | "relations"
                    )
            )
        }),
        _ => false,
    }
}

impl AutomaticHistory {
    pub fn start(ws: Workspace) -> Self {
        Self::start_with(ws, Cadence::default())
    }

    pub fn start_with_interval(ws: Workspace, interval: Duration) -> Self {
        Self::start_with(
            ws,
            Cadence {
                interval,
                ..Cadence::default()
            },
        )
    }

    pub fn start_with(ws: Workspace, cadence: Cadence) -> Self {
        let interval = cadence.interval;
        // Capture pre-subscription book heads synchronously (`loro_head` point
        // reads only) so an immediate foreground edit cannot race the worker's
        // baseline read and cause every entry in the book to be marked dirty.
        let mut initial_heads = initial_book_heads(&ws);
        let (send, rx) = mpsc::channel();
        let events = send.clone();
        let subscription = ws.library().subscribe(move |event| {
            if let StoreEvent::Doc(e) = event
                && concerns_entries(e)
            {
                let _ = events.send(Message::Changed {
                    doc: e.doc_id.to_string(),
                    typed: e.origin == Origin::User,
                });
            }
        });
        let worker = thread::spawn(move || {
            let mut known: BTreeMap<BookId, BookOwners> = BTreeMap::new();
            let mut dirty: BTreeSet<(String, String)> = BTreeSet::new();
            let mut deadline: Option<Instant> = None;
            let mut first = FirstPoints::default();
            let mut first_at: Option<Instant> = cadence.first_points.map(|d| Instant::now() + d);
            loop {
                let wake = deadline.into_iter().chain(first_at).min();
                let message = match wake {
                    Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now()))
                    {
                        Ok(message) => message,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let now = Instant::now();
                            if deadline.is_some_and(|at| at <= now) {
                                deadline = None;
                                let pending = std::mem::take(&mut dirty);
                                capture_periodic(&ws, pending, &mut dirty);
                                if !dirty.is_empty() {
                                    deadline = Some(Instant::now() + interval);
                                }
                            }
                            if first_at.is_some_and(|at| at <= now) {
                                first_at = match first.step(&ws) {
                                    Ok(_) if first.done() => None,
                                    Ok(_) => Some(Instant::now() + cadence.gap),
                                    Err(e) => {
                                        log::warn!("first entry checkpoints failed: {e}");
                                        (!first.done()).then(|| Instant::now() + FIRST_POINTS_RETRY)
                                    }
                                };
                            }
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    },
                    None => match rx.recv() {
                        Ok(message) => message,
                        Err(_) => break,
                    },
                };
                match message {
                    Message::Changed { doc, typed } => {
                        // The pass makes way for the author's typing.
                        if typed && let Some(at) = first_at.as_mut() {
                            *at = (*at).max(Instant::now() + cadence.quiet);
                        }
                        match DocId::parse(&doc) {
                            Ok(DocId::Body(body)) => {
                                if let Ok(Some(info)) = ws.library().doc_info(&doc)
                                    && let Some(book) = info.book_id
                                {
                                    dirty.insert((book, body.entry().to_string()));
                                }
                            }
                            Ok(DocId::Book(book)) => {
                                if !known.contains_key(&book) {
                                    match initial_heads.get(&book) {
                                        Some(frontiers) => {
                                            match book_owners_at(&ws, &book, frontiers) {
                                                Ok(owners) => {
                                                    initial_heads.remove(&book);
                                                    known.insert(book.clone(), owners);
                                                }
                                                Err(e) => {
                                                    log::warn!(
                                                        "entry checkpoint baseline load failed: {e}"
                                                    );
                                                }
                                            }
                                        }
                                        None => {
                                            known.insert(book.clone(), BTreeMap::new());
                                        }
                                    }
                                }
                                if let Some(prev) = known.get(&book) {
                                    match book_owners(&ws, &book) {
                                        Ok(current) => {
                                            dirty.retain(|(b, e)| {
                                                b != book.as_str() || current.contains_key(e)
                                            });
                                            for (entry, hash) in &current {
                                                if prev.get(entry) != Some(hash) {
                                                    dirty.insert((book.to_string(), entry.clone()));
                                                }
                                            }
                                            known.insert(book, current);
                                        }
                                        Err(e) => {
                                            log::warn!("entry checkpoint observation failed: {e}")
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                        if dirty.is_empty() {
                            deadline = None;
                        } else {
                            deadline.get_or_insert_with(|| Instant::now() + interval);
                        }
                    }
                    Message::Stop(done) => {
                        // What the first-points pass has not reached yet is
                        // due, so this sweep takes it.
                        let result = capture_on_close(&ws);
                        let _ = done.send(result);
                        break;
                    }
                    #[cfg(test)]
                    Message::DirtySnapshot(reply) => {
                        let _ = reply.send(dirty.clone());
                    }
                    #[cfg(test)]
                    Message::FirstPointsStep(reply) => {
                        let _ = reply.send(first.step(&ws));
                    }
                    #[cfg(test)]
                    Message::FirstPointsAt(reply) => {
                        let _ = reply.send(first_at);
                    }
                    #[cfg(test)]
                    Message::Abandon => break,
                }
            }
        });
        Self {
            send,
            worker: Some(worker),
            subscription: Some(subscription),
        }
    }

    #[cfg(test)]
    fn dirty_for_test(&self) -> BTreeSet<(String, String)> {
        let (tx, rx) = mpsc::channel();
        self.send.send(Message::DirtySnapshot(tx)).unwrap();
        rx.recv().unwrap()
    }

    #[cfg(test)]
    fn first_points_step(&self) -> Result<usize, String> {
        let (tx, rx) = mpsc::channel();
        self.send.send(Message::FirstPointsStep(tx)).unwrap();
        rx.recv().unwrap()
    }

    #[cfg(test)]
    fn first_points_at(&self) -> Option<Instant> {
        let (tx, rx) = mpsc::channel();
        self.send.send(Message::FirstPointsAt(tx)).unwrap();
        rx.recv().unwrap()
    }

    /// The worker stops as the process would in a crash: no last sweep.
    #[cfg(test)]
    fn abandon(mut self) {
        self.subscription.take();
        self.send.send(Message::Abandon).unwrap();
        self.worker.take().unwrap().join().unwrap();
    }

    /// Stop admission, drain previously queued writes and save dirty entries.
    /// Call off the foreground thread; a failed close checkpoint blocks the
    /// ordinary release flow and remains recoverable through a manual retry.
    pub fn finish(mut self) -> Result<(), String> {
        self.subscription.take();
        let (done, rx) = mpsc::channel();
        self.send
            .send(Message::Stop(done))
            .map_err(|e| e.to_string())?;
        let result = rx.recv().map_err(|e| e.to_string())?;
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "entry checkpoint worker panicked".to_owned())?;
        }
        result
    }
}
impl Drop for AutomaticHistory {
    fn drop(&mut self) {
        self.subscription.take();
        if self.worker.is_some() {
            let (done, _) = mpsc::channel();
            let _ = self.send.send(Message::Stop(done));
        }
    }
}

/// Last sweep after all ordinary release services have settled. The command
/// compares entry-owned content, so checkpoint metadata and other books do not
/// manufacture new versions. Also usable by a host's explicit close flow.
///
/// Only the entries a capture has something to do for are captured
/// (`entries_due_for_capture`: the command's comparison, made once for the
/// whole book), so a quit costs what changed and not one copy of the book
/// document per entry. They are captured [`api::CAPTURE_BATCH`] at a time,
/// one atomic write each (`capture_entries`): the same points the command
/// takes entry by entry, so a first quit with hundreds of entries without a
/// checkpoint is a handful of writes. A write that fails stops the sweep
/// (and the quit) with its error; the writes before it are kept, and its
/// entries are still due.
pub fn capture_on_close(ws: &Workspace) -> Result<(), String> {
    for info in ws
        .library()
        .docs(None, Some("book"))
        .map_err(|e| e.to_string())?
    {
        let Ok(DocId::Book(book)) = DocId::parse(&info.doc_id) else {
            continue;
        };
        let due = api::entries_due_for_capture(ws, book.as_str()).map_err(|e| e.to_string())?;
        if due.is_empty() {
            continue;
        }
        let mut plan = api::CapturePlan::read(ws, book.as_str()).map_err(|e| e.to_string())?;
        for batch in due.chunks(api::CAPTURE_BATCH) {
            plan.capture(ws, batch, api::CaptureReason::Close)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v3::tests::{call, setup};
    use dr_workspace::Actor;
    use serde_json::json;
    #[test]
    fn worker_drains_periodic_and_close_points_and_releases_library_handles() {
        let (dir, ws, t) = setup();
        let service = AutomaticHistory::start(ws.clone());
        call(
            &ws,
            "module.set_prose",
            json!({"book":t.book,"owner":t.entry,"module":"mod-prose","paragraphs":[{"text":"Synthetic periodic write"}]}),
        );
        service.finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
        assert!(!points.is_empty());
        let latest = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: t.clone(),
                    point: points[0].id.clone(),
                },
            )
            .unwrap()
            .output;
        assert!(
            latest
                .bodies
                .iter()
                .any(|b| b.text.contains("Synthetic periodic write"))
        );
        call(
            &ws,
            "entry.update",
            json!({"book":t.book,"id":t.entry,"title":"Metadata after worker stopped"}),
        );
        capture_on_close(&ws).unwrap();
        ws.shutdown().unwrap();
        let ws = Workspace::open_dir(dir.path(), "test").unwrap();
        let points = ws.run::<api::List>(&Actor::User, t).unwrap().output;
        assert_eq!(points[0].title, "Metadata after worker stopped");
        assert_eq!(points[0].reason, "close");
        ws.shutdown().unwrap();
    }
    #[test]
    fn failed_close_preserves_current_text_and_restarted_worker_can_retry() {
        let (_dir, ws, t) = setup();
        let service = AutomaticHistory::start(ws.clone());
        ws.library().local_transaction(|tx| {tx.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'checkpoints:%' BEGIN SELECT RAISE(ABORT,'checkpoint fault'); END;")?;Ok(())}).unwrap();
        call(
            &ws,
            "module.set_prose",
            json!({"book":t.book,"owner":t.entry,"module":"mod-prose","paragraphs":[{"text":"Author text survives checkpoint failure"}]}),
        );
        assert!(service.finish().is_err());
        assert_eq!(
            call(
                &ws,
                "module.read_prose",
                json!({"book":t.book,"owner":t.entry,"module":"mod-prose"})
            )["paragraphs"][0]["text"],
            "Author text survives checkpoint failure"
        );
        ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER reject_checkpoint")?;
                Ok(())
            })
            .unwrap();
        AutomaticHistory::start(ws.clone()).finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
        let preview = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: t,
                    point: points[0].id.clone(),
                },
            )
            .unwrap()
            .output;
        assert!(
            preview
                .bodies
                .iter()
                .any(|b| b.text.contains("Author text survives checkpoint failure"))
        );
        ws.shutdown().unwrap();
    }

    #[test]
    fn unrelated_book_metadata_does_not_schedule_entry_periodic_checkpoints() {
        let (_dir, ws, t) = setup();
        let service = AutomaticHistory::start(ws.clone());
        call(
            &ws,
            "book.update",
            json!({"book":t.book,"summary":"Synthetic book-level setting"}),
        );
        service.finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t).unwrap().output;
        assert!(!points.is_empty());
        assert!(points.iter().all(|p| p.reason == "close"));
        ws.shutdown().unwrap();
    }

    #[test]
    fn a_writing_day_or_a_saved_checkpoint_asks_for_no_look_at_the_entries() {
        let (_dir, ws, t) = setup();
        let book_doc = format!("book:{}", t.book);
        let (stats_doc, points_doc) = (
            format!("stats:{}", t.book),
            format!("checkpoints:{}", t.book),
        );
        // Every persisted change, and whether the worker would be told.
        let seen: std::sync::Arc<std::sync::Mutex<Vec<(String, bool)>>> = Default::default();
        let sink = seen.clone();
        let _subscription = ws.library().subscribe(move |event| {
            if let StoreEvent::Doc(e) = event {
                sink.lock()
                    .unwrap()
                    .push((e.doc_id.to_string(), concerns_entries(e)));
            }
        });
        let changes = || std::mem::take(&mut *seen.lock().unwrap());

        // The recorder's minute.
        call(
            &ws,
            "writing_day.record",
            json!({"book": t.book, "device": "device-000000000000000000000001",
                "day": "2026-11-12", "words": 120}),
        );
        assert_eq!(changes(), [(stats_doc, false)]);

        // A saved checkpoint: the manifest is a commit to the checkpoints
        // document beside the book and no change to any entry. (The entry's
        // first point may also create bodies it has not written yet: prose,
        // which is.)
        for _ in 0..2 {
            call(
                &ws,
                "entry_snapshot.create",
                json!({"book": t.book, "entry": t.entry}),
            );
            let saved = changes();
            assert!(
                saved.contains(&(points_doc.clone(), false)),
                "the manifest: {saved:?}"
            );
            assert!(
                !saved.iter().any(|(doc, _)| *doc == book_doc),
                "no commit to the book document: {saved:?}"
            );
            assert!(
                saved
                    .iter()
                    .all(|(doc, told)| *told == doc.starts_with("body:")),
                "{saved:?}"
            );
        }
        assert_eq!(
            changes(),
            [],
            "and the second point wrote nothing but its manifest"
        );

        // A book-level setting is none either; an entry's own change is.
        call(
            &ws,
            "book.update",
            json!({"book": t.book, "summary": "Synthetic book-level setting"}),
        );
        assert_eq!(changes(), [(book_doc.clone(), false)]);
        call(
            &ws,
            "entry.update",
            json!({"book": t.book, "id": t.entry, "title": "Synthetic renamed"}),
        );
        assert_eq!(changes(), [(book_doc, true)]);
        ws.shutdown().unwrap();
    }

    #[test]
    fn immediate_foreground_edits_enqueue_only_touched_entries_without_racing_book_head() {
        let (_dir, ws, t) = setup();
        let entries = call(&ws, "entry.list", json!({"book": t.book, "all": true}))
            .as_array()
            .unwrap()
            .clone();
        assert!(
            entries.len() > 10,
            "Preset::Tiny should contain dozens of entries"
        );
        let untouched = entries
            .iter()
            .find(|e| !e["parent"].is_null() && e["id"].as_str() != Some(t.entry.as_str()))
            .expect("untouched non-root entry")["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let book_doc = format!("book:{}", t.book);

        let service = AutomaticHistory::start(ws.clone());
        let created_id = call(
            &ws,
            "entry.create",
            json!({"book": t.book, "template": "tpl-chapter", "title": "Immediate foreground entry"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        call(
            &ws,
            "entry.update",
            json!({"book": t.book, "id": t.entry, "title": "Edited chapter"}),
        );
        let head_after_edits = ws
            .library()
            .head(&book_doc)
            .unwrap()
            .expect("book head")
            .frontiers;

        // The entry created and the entry edited, and nothing else: the new
        // entry's siblings at the top level did not change.
        let expected_dirty = BTreeSet::from([
            (t.book.clone(), created_id),
            (t.book.clone(), t.entry.clone()),
        ]);

        let dirty = service.dirty_for_test();
        assert_eq!(dirty, expected_dirty);
        assert!(!dirty.contains(&(t.book.clone(), untouched.clone())));
        assert_eq!(
            ws.library()
                .head(&book_doc)
                .unwrap()
                .expect("book head")
                .frontiers,
            head_after_edits,
            "AutomaticHistory must not advance book oplog frontiers before the periodic interval"
        );
        assert!(
            ws.run::<api::List>(&Actor::User, t.clone())
                .unwrap()
                .output
                .is_empty(),
            "no periodic checkpoint should be written immediately on foreground edit"
        );

        ws.undo(&Actor::User).unwrap();
        ws.undo(&Actor::User).unwrap();
        let head_after_undo = ws
            .library()
            .head(&book_doc)
            .unwrap()
            .expect("book head")
            .frontiers;
        let dirty_after_undo = service.dirty_for_test();
        assert!(
            !dirty_after_undo.contains(&(t.book.clone(), untouched)),
            "undoing back to baseline must not mark untouched entries dirty"
        );
        assert_eq!(
            ws.library()
                .head(&book_doc)
                .unwrap()
                .expect("book head")
                .frontiers,
            head_after_undo,
            "AutomaticHistory must not advance book oplog frontiers after undo"
        );

        service.finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t).unwrap().output;
        assert!(!points.is_empty());
        assert!(points.iter().all(|p| p.reason == "close"));
        ws.shutdown().unwrap();
    }

    #[test]
    fn periodic_cadence_captures_dirty_entries_after_interval_elapses() {
        let (_dir, ws, t) = setup();
        let untouched = call(&ws, "entry.list", json!({"book": t.book, "all": true}))
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["id"].as_str())
            .find(|id| *id != t.entry)
            .expect("untouched sibling entry")
            .to_owned();

        let service = AutomaticHistory::start_with_interval(ws.clone(), Duration::from_millis(25));
        call(
            &ws,
            "module.set_prose",
            json!({
                "book": t.book,
                "owner": t.entry,
                "module": "mod-prose",
                "paragraphs": [{"text": "Timed periodic capture"}]
            }),
        );

        let wait_until = Instant::now() + Duration::from_secs(5);
        let points = loop {
            let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
            if !points.is_empty() {
                break points;
            }
            assert!(
                Instant::now() < wait_until,
                "periodic checkpoint did not fire within deadline"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(service.dirty_for_test().is_empty());
        assert_eq!(points[0].reason, "periodic");
        let preview = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: t.clone(),
                    point: points[0].id.clone(),
                },
            )
            .unwrap()
            .output;
        assert!(
            preview
                .bodies
                .iter()
                .any(|b| b.text.contains("Timed periodic capture"))
        );
        assert!(
            ws.run::<api::List>(
                &Actor::User,
                api::EntryIn {
                    book: t.book.clone(),
                    entry: untouched,
                },
            )
            .unwrap()
            .output
            .is_empty(),
            "untouched sibling entries must not receive periodic checkpoints"
        );

        service.finish().unwrap();
        ws.shutdown().unwrap();
    }

    /// Every entry of the book, trashed ones too, as `entry.list` gives them.
    fn entries(ws: &Workspace, book: &str) -> Vec<serde_json::Value> {
        call(
            ws,
            "entry.list",
            json!({"book": book, "all": true, "trashed": true}),
        )
        .as_array()
        .unwrap()
        .clone()
    }
    fn ids(entries: &[serde_json::Value]) -> BTreeSet<String> {
        entries
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect()
    }
    /// The checkpoints of every entry: `(id, reason)`, newest first.
    fn checkpoints(ws: &Workspace, book: &str) -> BTreeMap<String, Vec<(String, String)>> {
        ids(&entries(ws, book))
            .into_iter()
            .map(|entry| {
                let points = ws
                    .run::<api::List>(
                        &Actor::User,
                        api::EntryIn {
                            book: book.to_owned(),
                            entry: entry.clone(),
                        },
                    )
                    .unwrap()
                    .output
                    .into_iter()
                    .map(|p| (p.id, p.reason))
                    .collect();
                (entry, points)
            })
            .collect()
    }
    /// The chapter of `setup`, with its parent and the titles beside it.
    fn family(ws: &Workspace, t: &api::EntryIn) -> (serde_json::Value, Vec<String>) {
        let all = entries(ws, &t.book);
        let parent = all.iter().find(|e| e["id"] == t.entry.as_str()).unwrap()["parent"].clone();
        assert!(parent.is_string(), "the seed keeps its chapters in a level");
        let siblings = all
            .iter()
            .filter(|e| e["parent"] == parent)
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        (parent, siblings)
    }

    #[test]
    fn a_sibling_created_moved_trashed_or_restored_dirties_and_checkpoints_no_other_entry() {
        let (_dir, ws, t) = setup();
        // Every entry has its first checkpoint: from here on only a change
        // earns another.
        capture_on_close(&ws).unwrap();
        let before = checkpoints(&ws, &t.book);
        assert!(before.len() > 10 && before.values().all(|points| points.len() == 1));
        let (parent, siblings) = family(&ws, &t);
        assert!(siblings.len() > 1, "the chapter has siblings");

        let service = AutomaticHistory::start(ws.clone());
        let sibling = call(
            &ws,
            "entry.create",
            json!({"book": t.book, "parent": parent, "template": "tpl-chapter", "title": "A sibling arrives"}),
        );
        assert_eq!(sibling["parent"], parent);
        let sibling = sibling["id"].as_str().unwrap().to_owned();
        let only_the_sibling = BTreeSet::from([(t.book.clone(), sibling.clone())]);
        assert_eq!(service.dirty_for_test(), only_the_sibling, "created");
        call(
            &ws,
            "entry.move",
            json!({"book": t.book, "id": sibling, "parent": parent, "index": 0}),
        );
        assert_eq!(
            family(&ws, &t).1[0],
            sibling,
            "it moved in front of them all"
        );
        assert_eq!(service.dirty_for_test(), only_the_sibling, "moved");
        call(&ws, "entry.trash", json!({"book": t.book, "id": sibling}));
        assert_eq!(service.dirty_for_test(), only_the_sibling, "trashed");
        call(&ws, "entry.restore", json!({"book": t.book, "id": sibling}));
        assert_eq!(service.dirty_for_test(), only_the_sibling, "restored");

        service.finish().unwrap();
        let mut after = checkpoints(&ws, &t.book);
        let own = after.remove(&sibling).expect("the sibling's checkpoints");
        assert_eq!(own.len(), 1);
        assert_eq!(own[0].1, "close");
        assert_eq!(after, before, "no other entry earned a checkpoint");
        ws.shutdown().unwrap();
    }

    #[test]
    fn an_entry_moved_among_its_siblings_or_to_another_parent_is_dirty_and_earns_a_checkpoint() {
        let (_dir, ws, t) = setup();
        capture_on_close(&ws).unwrap();
        let mut expected = checkpoints(&ws, &t.book);
        let (parent, siblings) = family(&ws, &t);
        let at = siblings.iter().position(|id| *id == t.entry).unwrap();
        // To the other end of its level.
        let index = if at == 0 { siblings.len() - 1 } else { 0 };
        assert!(siblings.len() > 1, "the chapter has siblings");
        let grandparent = entries(&ws, &t.book)
            .iter()
            .find(|e| e["id"] == parent)
            .unwrap()["parent"]
            .clone();
        let only_the_chapter = BTreeSet::from([(t.book.clone(), t.entry.clone())]);

        for (step, to, index) in [
            ("among its siblings", &parent, index),
            ("to another parent", &grandparent, 0),
        ] {
            let service = AutomaticHistory::start(ws.clone());
            call(
                &ws,
                "entry.move",
                json!({"book": t.book, "id": t.entry, "parent": to, "index": index}),
            );
            let now = entries(&ws, &t.book);
            let moved = now.iter().find(|e| e["id"] == t.entry.as_str()).unwrap();
            assert_eq!(&moved["parent"], to, "{step}");
            assert_eq!(service.dirty_for_test(), only_the_chapter, "{step}");
            service.finish().unwrap();
            let mut after = checkpoints(&ws, &t.book);
            let own = after.remove(&t.entry).unwrap();
            let known = expected.remove(&t.entry).unwrap();
            assert_eq!(own.len(), known.len() + 1, "{step}");
            assert_eq!(own[0].1, "close", "{step}");
            assert_eq!(own[1..], known[..], "{step}");
            assert_eq!(
                after, expected,
                "{step}: no other entry earned a checkpoint"
            );
            expected.insert(t.entry.clone(), own);
        }
        ws.shutdown().unwrap();
    }

    #[test]
    fn the_close_sweep_calls_the_command_for_exactly_the_entries_it_would_save() {
        let (_dir, ws, t) = setup();
        let due = |ws: &Workspace| -> BTreeSet<String> {
            let due = api::entries_due_for_capture(ws, &t.book).unwrap();
            let set: BTreeSet<String> = due.iter().cloned().collect();
            assert_eq!(set.len(), due.len(), "each entry once");
            set
        };
        let all = entries(&ws, &t.book);
        assert_eq!(
            due(&ws),
            ids(&all),
            "without a checkpoint every entry is due"
        );
        capture_on_close(&ws).unwrap();
        assert_eq!(due(&ws), BTreeSet::new());

        // A title, a body, a field, a new sibling and a move.
        let chapters: Vec<String> = all
            .iter()
            .filter(|e| e["template"] == "tpl-chapter" && e["deleted_at"].is_null())
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        assert!(chapters.len() >= 3, "{chapters:?}");
        let (parent, _) = family(&ws, &t);
        call(
            &ws,
            "entry.update",
            json!({"book": t.book, "id": chapters[0], "title": "A new title"}),
        );
        call(
            &ws,
            "module.set_prose",
            json!({"book": t.book, "owner": chapters[1], "module": "mod-prose", "paragraphs": [{"text": "A new body"}]}),
        );
        let created = call(
            &ws,
            "entry.create",
            json!({"book": t.book, "parent": parent, "template": "tpl-chapter", "title": "A new sibling"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let last = chapters.last().unwrap();
        let home = all.iter().find(|e| e["id"] == last.as_str()).unwrap()["parent"].clone();
        call(
            &ws,
            "entry.move",
            json!({"book": t.book, "id": last, "parent": home, "index": 0}),
        );
        let changed = BTreeSet::from([
            chapters[0].clone(),
            chapters[1].clone(),
            created.clone(),
            last.clone(),
        ]);
        assert_eq!(changed.len(), 4);
        assert_eq!(due(&ws), changed);

        // The command itself, entry by entry: it saves for those and for no
        // other, so leaving the others out changes nothing.
        let before = checkpoints(&ws, &t.book);
        for (entry, known) in &before {
            let got = ws
                .run::<api::Capture>(
                    &Actor::User,
                    api::CaptureIn {
                        target: api::EntryIn {
                            book: t.book.clone(),
                            entry: entry.clone(),
                        },
                        reason: api::CaptureReason::Close,
                    },
                )
                .unwrap()
                .output;
            if changed.contains(entry) {
                assert!(known.iter().all(|(id, _)| *id != got.id), "{entry} is new");
            } else {
                assert_eq!(got.id, known[0].0, "{entry} was left alone");
            }
        }
        let after = checkpoints(&ws, &t.book);
        for (entry, known) in &before {
            let more = usize::from(changed.contains(entry));
            assert_eq!(after[entry].len(), known.len() + more, "{entry}");
        }
        assert_eq!(due(&ws), BTreeSet::new());

        // A template gains a prose module: a capture gives each of its
        // entries the missing body, so they are due though nothing they own
        // changed.
        call(
            &ws,
            "entry_template.put_module",
            json!({"book": t.book, "template": "tpl-chapter", "module": {"id": "second", "kind": "prose", "name": "second"}}),
        );
        let of_the_template: BTreeSet<String> = entries(&ws, &t.book)
            .iter()
            .filter(|e| e["template"] == "tpl-chapter")
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        assert!(of_the_template.is_superset(&changed));
        assert_eq!(due(&ws), of_the_template);
        capture_on_close(&ws).unwrap();
        assert_eq!(due(&ws), BTreeSet::new());
        let last = checkpoints(&ws, &t.book);
        for (entry, known) in &after {
            let more = usize::from(of_the_template.contains(entry));
            assert_eq!(last[entry].len(), known.len() + more, "{entry}");
        }
        ws.shutdown().unwrap();
    }

    #[test]
    fn text_a_holder_could_not_store_still_counts_as_a_change_on_close() {
        let (_dir, ws, t) = setup();
        capture_on_close(&ws).unwrap();
        let body = format!("body:{}/mod-prose", t.entry);
        let session = ws.prose_session(&body).unwrap();
        ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("CREATE TRIGGER reject_body BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'body:%' BEGIN SELECT RAISE(ABORT,'body fault'); END;")?;
                Ok(())
            })
            .unwrap();
        let stored = ws.library().head(&body).unwrap().unwrap().frontiers;
        assert!(
            session
                .edit(|t| t.insert_text(0, "Typed while the disk refused"))
                .is_err()
        );
        // SQLite still holds the version of the last checkpoint; only the
        // open holder has the new text. The sweep reads the holder.
        assert_eq!(ws.library().head(&body).unwrap().unwrap().frontiers, stored);
        assert_eq!(
            api::entries_due_for_capture(&ws, &t.book).unwrap(),
            vec![t.entry.clone()]
        );
        assert!(
            capture_on_close(&ws).is_err(),
            "a quit must not pass over text that is not stored"
        );
        ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER reject_body")?;
                Ok(())
            })
            .unwrap();
        capture_on_close(&ws).unwrap();
        let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].reason, "close");
        let preview = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: t.clone(),
                    point: points[0].id.clone(),
                },
            )
            .unwrap()
            .output;
        assert!(
            preview
                .bodies
                .iter()
                .any(|b| b.text.contains("Typed while the disk refused"))
        );
        drop(session);
        ws.shutdown().unwrap();
    }

    /// The worker without its first-points pass on a timer (the tests step
    /// it).
    fn no_pass() -> Cadence {
        Cadence {
            first_points: None,
            ..Cadence::default()
        }
    }
    /// Commits per document kind while `f` runs, as the store announces them.
    fn commits(ws: &Workspace, f: impl FnOnce()) -> BTreeMap<String, usize> {
        let seen: std::sync::Arc<std::sync::Mutex<BTreeMap<String, usize>>> = Default::default();
        let sink = seen.clone();
        let subscription = ws.library().subscribe(move |event| {
            if let StoreEvent::Doc(e) = event {
                let kind = e.doc_id.split(':').next().unwrap_or_default().to_owned();
                *sink.lock().unwrap().entry(kind).or_default() += 1;
            }
        });
        f();
        drop(subscription);
        std::mem::take(&mut *seen.lock().unwrap())
    }
    /// The documents of the book, as the registry lists them.
    fn documents(ws: &Workspace, book: &str) -> BTreeSet<String> {
        ws.library()
            .docs(Some(book), None)
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect()
    }

    #[test]
    fn the_first_close_takes_every_entry_in_a_bounded_number_of_writes() {
        let (_dir, ws, t) = setup();
        let all = api::entries_without_checkpoint(&ws, &t.book).unwrap();
        assert_eq!(
            all.iter().cloned().collect::<BTreeSet<_>>(),
            ids(&entries(&ws, &t.book)),
            "no entry has a checkpoint yet"
        );
        assert!(all.len() > 10, "a seed with many entries: {}", all.len());
        let made = commits(&ws, || capture_on_close(&ws).unwrap());
        // One write per CAPTURE_BATCH entries, not one per entry.
        assert_eq!(
            made.get("checkpoints").copied(),
            Some(all.len().div_ceil(api::CAPTURE_BATCH)),
            "{made:?}"
        );
        assert!(
            made.keys()
                .all(|kind| ["checkpoints", "body"].contains(&kind.as_str()))
        );
        let points = checkpoints(&ws, &t.book);
        assert!(points.values().all(|p| p.len() == 1 && p[0].1 == "close"));
        assert_eq!(points.len(), all.len());
        // The quit after it has nothing left to write.
        assert_eq!(
            commits(&ws, || capture_on_close(&ws).unwrap()),
            BTreeMap::new()
        );
        ws.shutdown().unwrap();
    }

    /// Two libraries holding the same seeded book (the same ids).
    fn twins() -> [(tempfile::TempDir, Workspace, String); 2] {
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        [(), ()].map(|_| {
            let dir = tempfile::tempdir().unwrap();
            let store =
                dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
            seed.write_to(&store).unwrap();
            store.close().unwrap();
            let ws = Workspace::open_dir(dir.path(), "test").unwrap();
            (dir, ws, book.clone())
        })
    }
    /// What a point holds, without the versions (each library has its own
    /// device, so its own operation ids).
    fn content(ws: &Workspace, book: &str, entry: &str, point: &str) -> serde_json::Value {
        let p = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: api::EntryIn {
                        book: book.to_owned(),
                        entry: entry.to_owned(),
                    },
                    point: point.to_owned(),
                },
            )
            .unwrap()
            .output;
        json!({
            "title": p.point.title,
            "reason": p.point.reason,
            "bodies": p.point.bodies.keys().collect::<Vec<_>>(),
            "metadata": p.metadata,
            "raw_state": p.raw_state,
            "records": p.records,
            "template": p.template,
            "template_metadata": p.template_metadata,
            "texts": p.bodies.iter().map(|b| json!([b.doc, b.text, b.raw_state])).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn batched_first_points_hold_what_the_command_took_entry_by_entry() {
        let [(_a, batched, book), (_b, one_by_one, _)] = twins();
        capture_on_close(&batched).unwrap();
        // The sweep as it was: the command for each entry due.
        for entry in api::entries_due_for_capture(&one_by_one, &book).unwrap() {
            one_by_one
                .run::<api::Capture>(
                    &Actor::User,
                    api::CaptureIn {
                        target: api::EntryIn {
                            book: book.clone(),
                            entry,
                        },
                        reason: api::CaptureReason::Close,
                    },
                )
                .unwrap();
        }
        // The same documents (the default bodies a capture creates) and,
        // entry by entry, one point holding the same.
        assert_eq!(documents(&batched, &book), documents(&one_by_one, &book));
        let (a, b) = (
            checkpoints(&batched, &book),
            checkpoints(&one_by_one, &book),
        );
        assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>());
        for (entry, points) in &a {
            assert_eq!((points.len(), b[entry].len()), (1, 1), "{entry}");
            assert_eq!(
                content(&batched, &book, entry, &points[0].0),
                content(&one_by_one, &book, entry, &b[entry][0].0),
                "{entry}"
            );
        }
        for ws in [batched, one_by_one] {
            ws.shutdown().unwrap();
        }
    }

    #[test]
    fn the_first_points_pass_takes_every_entry_a_batch_at_a_time_and_leaves_the_quit_nothing() {
        let (_dir, ws, t) = setup();
        let all = api::entries_without_checkpoint(&ws, &t.book).unwrap();
        let service = AutomaticHistory::start_with(ws.clone(), no_pass());
        let mut steps = 0;
        let made = commits(&ws, || {
            while service.first_points_step().unwrap() > 0 {
                steps += 1;
            }
        });
        assert_eq!(steps, all.len().div_ceil(BACKGROUND_BATCH));
        assert_eq!(made.get("checkpoints").copied(), Some(steps), "{made:?}");
        let points = checkpoints(&ws, &t.book);
        assert_eq!(points.len(), all.len());
        assert!(
            points
                .values()
                .all(|p| p.len() == 1 && p[0].1 == "periodic")
        );
        assert!(
            api::entries_without_checkpoint(&ws, &t.book)
                .unwrap()
                .is_empty()
        );
        // Each is the entry as it is: what a close would have saved.
        for entry in &all {
            let saved = ws
                .run::<api::Capture>(
                    &Actor::User,
                    api::CaptureIn {
                        target: api::EntryIn {
                            book: t.book.clone(),
                            entry: entry.clone(),
                        },
                        reason: api::CaptureReason::Close,
                    },
                )
                .unwrap()
                .output;
            assert_eq!(saved.id, points[entry][0].0, "{entry}");
        }
        assert_eq!(commits(&ws, || service.finish().unwrap()), BTreeMap::new());
        ws.shutdown().unwrap();
    }

    #[test]
    fn a_pass_stopped_halfway_keeps_whole_points_and_the_rest_is_taken_later() {
        let (dir, ws, t) = setup();
        let all = api::entries_without_checkpoint(&ws, &t.book).unwrap();
        assert!(all.len() > 2 * BACKGROUND_BATCH, "{}", all.len());
        let service = AutomaticHistory::start_with(ws.clone(), no_pass());
        assert_eq!(service.first_points_step(), Ok(BACKGROUND_BATCH));
        let taken: BTreeSet<String> = all[..BACKGROUND_BATCH].iter().cloned().collect();
        let after_one = documents(&ws, &t.book);
        // The next write fails at its SQL append, as a crash inside it
        // would leave it: nothing of it is stored.
        ws.library().local_transaction(|tx| {tx.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'checkpoints:%' BEGIN SELECT RAISE(ABORT,'checkpoint fault'); END;")?;Ok(())}).unwrap();
        assert!(service.first_points_step().is_err());
        ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER reject_checkpoint")?;
                Ok(())
            })
            .unwrap();
        // The process goes: no last sweep.
        service.abandon();
        ws.shutdown().unwrap();
        let ws = Workspace::open_dir(dir.path(), "test").unwrap();
        assert_eq!(
            documents(&ws, &t.book),
            after_one,
            "no body of the failed write"
        );
        let points = checkpoints(&ws, &t.book);
        let with: BTreeSet<String> = points
            .iter()
            .filter(|(_, p)| !p.is_empty())
            .map(|(e, _)| e.clone())
            .collect();
        assert_eq!(with, taken);
        for entry in &taken {
            assert_eq!(points[entry].len(), 1);
            ws.run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: api::EntryIn {
                        book: t.book.clone(),
                        entry: entry.clone(),
                    },
                    point: points[entry][0].0.clone(),
                },
            )
            .unwrap();
        }
        assert_eq!(
            api::entries_without_checkpoint(&ws, &t.book).unwrap(),
            all[BACKGROUND_BATCH..].to_vec()
        );
        // The next session's pass takes the rest; the first ones stay.
        let service = AutomaticHistory::start_with(ws.clone(), no_pass());
        while service.first_points_step().unwrap() > 0 {}
        service.finish().unwrap();
        let now = checkpoints(&ws, &t.book);
        assert!(now.values().all(|p| p.len() == 1), "{now:?}");
        for entry in &taken {
            assert_eq!(now[entry], points[entry]);
        }
        // And restores: the first point of the chapter, after a rename.
        let first = now[&t.entry][0].0.clone();
        call(
            &ws,
            "entry.update",
            json!({"book": t.book, "id": t.entry, "title": "Renamed after the pass"}),
        );
        let preview = call(
            &ws,
            "entry_snapshot.preview",
            json!({"book": t.book, "entry": t.entry, "point": first}),
        );
        call(
            &ws,
            "entry_snapshot.restore",
            json!({"book": t.book, "entry": t.entry, "point": first, "expected": preview["expected"]}),
        );
        assert_eq!(
            call(&ws, "entry.get", json!({"book": t.book, "id": t.entry}))["title"],
            preview["point"]["title"]
        );
        ws.shutdown().unwrap();
    }

    #[test]
    fn the_pass_runs_on_its_timer_and_makes_way_for_the_authors_typing() {
        // Typing puts the next write off; a command's write does not.
        let (_dir, ws, t) = setup();
        let hour = Duration::from_secs(3600);
        let service = AutomaticHistory::start_with(
            ws.clone(),
            Cadence {
                first_points: Some(hour),
                quiet: 2 * hour,
                ..Cadence::default()
            },
        );
        let planned = service.first_points_at().expect("planned");
        call(
            &ws,
            "module.set_prose",
            json!({"book":t.book,"owner":t.entry,"module":"mod-prose","paragraphs":[{"text":"By a command"}]}),
        );
        assert_eq!(service.first_points_at(), Some(planned));
        let session = ws
            .prose_session(&format!("body:{}/mod-prose", t.entry))
            .unwrap();
        let typed = Instant::now();
        session.edit(|t| t.insert_text(0, "Typed")).unwrap();
        let later = service.first_points_at().expect("still planned");
        assert!(later >= typed + 2 * hour, "put off by the quiet time");
        drop(session);
        service.finish().unwrap();
        ws.shutdown().unwrap();

        // On its timer: every entry gets its first point by itself.
        let (_dir, ws, t) = setup();
        let service = AutomaticHistory::start_with(
            ws.clone(),
            Cadence {
                first_points: Some(Duration::ZERO),
                gap: Duration::ZERO,
                ..Cadence::default()
            },
        );
        let deadline = Instant::now() + Duration::from_secs(20);
        while !api::entries_without_checkpoint(&ws, &t.book)
            .unwrap()
            .is_empty()
        {
            assert!(Instant::now() < deadline, "the pass did not finish");
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(service.first_points_at(), None, "and stops");
        service.finish().unwrap();
        ws.shutdown().unwrap();
    }
}
