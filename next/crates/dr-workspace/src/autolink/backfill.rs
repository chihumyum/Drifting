//! Linking what is already written when automatic linking is turned on
//! (`kernel-v5.md` §16 「打开时把全书补一遍」, the author 2026-11-24).
//!
//! **When.** A local commit of a book (anyone's but sync's: the author's,
//! an Agent's, MCP's, an undo, a restore) that turns an entry's own
//! 「自动链接」 from off to on, while the author's setting is on: the
//! workspace compares each entry's switch before and after every commit
//! that can change it ([`crate::workspace`]'s store events,
//! `BookViewV3::auto_link_switches`). An entry made with its switch on, or
//! brought back from Recently Deleted, is not turned on. The author's
//! setting going on ([`crate::Workspace::set_auto_links`]) asks for every
//! book of the library and every entry whose switch is on; a book that is
//! not open waits until it is. Another device's switch comes by sync and
//! is not backfilled here: its links come with the text that device linked.
//!
//! **What.** [`super::plan_backfill`] in every body of the book's live
//! entries (one write each, the documents an editor has open first), then
//! the comments that are not projected from a line and the relation
//! descriptions (one write of the book, under the book's gate, as commands
//! write it). Written with origin `repair`: no editor's undo takes it back
//! (`dr_model::origin::UNDO_EXCLUDED_ORIGIN_PREFIXES`), no command's undo
//! includes it (an undo of the switch only turns the switch back), it earns
//! no history label, writing-day count or check-in delta, and nobody's
//! words are coloured for it. An Agent that read a document before it is
//! held to read it again, as after any other write.
//!
//! **How.** One worker thread per workspace, started for a job and gone
//! when the queue is empty, holding the workspace only while it works. A
//! document whose input method is composing ([`crate::ProseSession::set_composing`])
//! is passed over and tried again once the rest is done. What is left of a
//! book is kept on this device ([`dr_store`]'s `local_state`, scope
//! [`SCOPE`], never synced): the worker stops at the next document when the
//! workspace closes or the app quits, and the next time the book opens it
//! carries on. Linking a document again is harmless: what is linked is
//! never linked twice.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use dr_model::DocId;
use dr_model::id::{BookId, EntryId};
use serde::{Deserialize, Serialize};

use crate::holder::{self, lock};
use crate::workspace::{BookSlot, Inner, Workspace};

/// The `local_state` scope of what is left to link, one row per book.
pub const SCOPE: &str = "ws-autolink-backfill";

/// How long a document being composed in is waited for before the book is
/// left for its next opening.
const COMPOSING_PATIENCE: Duration = Duration::from_secs(120);
/// How often a document being composed in is tried again.
const COMPOSING_RETRY: Duration = Duration::from_millis(100);

/// What is left to link in one book.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Want {
    /// The names of every entry whose switch is on (the author's setting
    /// went on).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    all: bool,
    /// The names of these entries (their own switch went on).
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    entries: BTreeSet<String>,
    /// Only if the book is open already; otherwise it is kept for its next
    /// opening (the author's setting asks this of every book).
    #[serde(skip)]
    lazy: bool,
}

impl Want {
    pub(crate) fn entries(ids: impl IntoIterator<Item = EntryId>) -> Self {
        Self {
            entries: ids.into_iter().map(|id| id.to_string()).collect(),
            ..Self::default()
        }
    }

    fn every_name_when_open() -> Self {
        Self {
            all: true,
            lazy: true,
            ..Self::default()
        }
    }

    fn is_empty(&self) -> bool {
        !self.all && self.entries.is_empty()
    }

    fn merge(&mut self, other: Want) {
        self.lazy = (self.lazy || self.is_empty()) && (other.lazy || other.is_empty());
        self.all |= other.all;
        if self.all {
            self.entries.clear();
        } else {
            self.entries.extend(other.entries);
        }
    }
}

enum Job {
    Book(BookId),
    /// The author's setting went on: every book of the library.
    EveryBook,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    /// What the books in `queue` want and the worker has not taken yet.
    waiting: HashMap<BookId, Want>,
    /// Books whose `waiting` is in their stored row already.
    saved: HashSet<BookId>,
    /// A worker is running.
    running: bool,
    /// The worker stops at the next document (quitting, closing).
    pause: bool,
    /// The workspace closed: no worker starts again.
    closed: bool,
    /// Documents an input method is composing in, by how many sessions.
    composing: HashMap<DocId, usize>,
}

/// The workspace's backfill queue and its worker.
#[derive(Default)]
pub(crate) struct Backfill {
    state: Mutex<State>,
    /// Signalled when the worker stops.
    stopped: Condvar,
    workspace: OnceLock<Weak<Inner>>,
}

/// How a book's turn ended.
enum Fill {
    /// Everything it wanted is linked.
    Done,
    /// Kept for later (paused, the author's setting off, not open).
    Kept,
}

/// How one document's turn ended.
#[derive(PartialEq, Eq)]
enum DocFill {
    Linked,
    Composing,
}

impl Backfill {
    pub(crate) fn attach(&self, inner: Weak<Inner>) {
        let _ = self.workspace.set(inner);
    }

    /// Ask for `want` in `book`.
    pub(crate) fn request(self: &Arc<Self>, book: BookId, want: Want) {
        let mut st = lock(&self.state);
        if st.closed {
            return;
        }
        if !st.waiting.contains_key(&book) {
            st.queue.push_back(Job::Book(book.clone()));
        }
        st.saved.remove(&book);
        st.waiting.entry(book).or_default().merge(want);
        self.start(st);
    }

    /// The author's setting went on: every book of the library, every
    /// entry whose switch is on.
    pub(crate) fn request_every_book(self: &Arc<Self>) {
        let mut st = lock(&self.state);
        if st.closed {
            return;
        }
        st.queue.push_back(Job::EveryBook);
        self.start(st);
    }

    fn start(self: &Arc<Self>, mut st: std::sync::MutexGuard<'_, State>) {
        if st.running || st.pause {
            return;
        }
        let Some(inner) = self.workspace.get().cloned() else {
            return;
        };
        st.running = true;
        drop(st);
        let this = self.clone();
        let spawned = std::thread::Builder::new()
            .name("autolink-backfill".into())
            .spawn(move || this.work(inner));
        if let Err(e) = spawned {
            log::error!("automatic links: the backfill could not start: {e}");
            lock(&self.state).running = false;
            self.stopped.notify_all();
        }
    }

    /// Stop the worker at its next document and wait for it (at most
    /// `timeout`); `close` keeps it from starting again. What is left stays
    /// stored for the books' next opening.
    pub(crate) fn pause(self: &Arc<Self>, timeout: Duration, close: bool) {
        let mut st = lock(&self.state);
        st.pause = true;
        st.closed |= close;
        let deadline = Instant::now() + timeout;
        while st.running {
            let now = Instant::now();
            if now >= deadline {
                log::warn!("automatic links: the backfill did not stop in time");
                break;
            }
            st = self
                .stopped
                .wait_timeout(st, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        st.pause = false;
    }

    /// Wait until nothing is queued or running, at most `timeout`; whether
    /// it got there.
    pub(crate) fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut st = lock(&self.state);
        loop {
            if !st.running && (st.queue.is_empty() || st.pause || st.closed) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            st = self
                .stopped
                .wait_timeout(st, (deadline - now).min(Duration::from_millis(50)))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    pub(crate) fn set_composing(&self, doc: &DocId, on: bool) {
        let mut st = lock(&self.state);
        if on {
            *st.composing.entry(doc.clone()).or_default() += 1;
        } else if let Some(n) = st.composing.get_mut(doc) {
            *n -= 1;
            if *n == 0 {
                st.composing.remove(doc);
            }
        }
    }

    fn is_composing(&self, doc: &DocId) -> bool {
        lock(&self.state).composing.contains_key(doc)
    }

    fn paused(&self) -> bool {
        let st = lock(&self.state);
        st.pause || st.closed
    }

    fn work(self: Arc<Self>, inner: Weak<Inner>) {
        loop {
            let next = {
                let mut st = lock(&self.state);
                if st.pause || st.closed {
                    None
                } else {
                    st.queue.pop_front()
                }
            };
            let job = match next {
                Some(job) => job,
                None => {
                    // What waits is stored for later, before the worker
                    // says it stopped (a closing workspace waits for that).
                    if let Some(inner) = inner.upgrade() {
                        self.save_waiting(&Workspace { inner });
                    }
                    let mut st = lock(&self.state);
                    if !st.queue.is_empty() && !st.pause && !st.closed {
                        // Asked for while it was storing: carry on.
                        continue;
                    }
                    st.running = false;
                    drop(st);
                    self.stopped.notify_all();
                    return;
                }
            };
            let Some(inner) = inner.upgrade() else {
                let mut st = lock(&self.state);
                st.running = false;
                st.queue.clear();
                drop(st);
                self.stopped.notify_all();
                return;
            };
            let ws = Workspace { inner };
            let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &job {
                Job::Book(book) => self.run_book(&ws, book),
                Job::EveryBook => self.queue_every_book(&ws),
            }));
            if ran.is_err() {
                log::error!("automatic links: the backfill panicked");
            }
        }
    }

    fn queue_every_book(self: &Arc<Self>, ws: &Workspace) {
        let books = match ws.library().docs(None, Some("book")) {
            Ok(docs) => docs,
            Err(e) => {
                log::warn!("automatic links: the library's books could not be listed: {e}");
                return;
            }
        };
        let mut st = lock(&self.state);
        for info in books {
            let Ok(DocId::Book(book)) = DocId::parse(&info.doc_id) else {
                continue;
            };
            if !st.waiting.contains_key(&book) {
                st.queue.push_back(Job::Book(book.clone()));
            }
            st.saved.remove(&book);
            st.waiting
                .entry(book)
                .or_default()
                .merge(Want::every_name_when_open());
        }
    }

    fn run_book(self: &Arc<Self>, ws: &Workspace, book: &BookId) {
        let fresh = {
            let mut st = lock(&self.state);
            st.saved.remove(book);
            st.waiting.remove(book).unwrap_or_default()
        };
        let lazy = fresh.lazy;
        let mut want = load(ws, book);
        want.merge(fresh);
        want.lazy = lazy;
        if want.is_empty() {
            return;
        }
        save(ws, book, &want);
        match self.fill(ws, book, &want) {
            Fill::Kept => {}
            Fill::Done => {
                // What was asked for since this turn began is the book's
                // next turn (it is queued already).
                let newer = lock(&self.state).waiting.get(book).cloned();
                match newer {
                    Some(w) => {
                        save(ws, book, &w);
                        lock(&self.state).saved.insert(book.clone());
                    }
                    None => forget(ws, book),
                }
            }
        }
    }

    /// Store what the queued books want (each merged into its row).
    fn save_waiting(&self, ws: &Workspace) {
        let todo: Vec<(BookId, Want)> = {
            let mut st = lock(&self.state);
            let todo: Vec<_> = st
                .waiting
                .iter()
                .filter(|(b, w)| !st.saved.contains(*b) && !w.is_empty())
                .map(|(b, w)| (b.clone(), w.clone()))
                .collect();
            for (b, _) in &todo {
                st.saved.insert(b.clone());
            }
            todo
        };
        for (book, w) in todo {
            let mut stored = load(ws, &book);
            stored.merge(w);
            save(ws, &book, &stored);
        }
    }

    fn fill(self: &Arc<Self>, ws: &Workspace, book: &BookId, want: &Want) -> Fill {
        if !ws.auto_links() {
            // All of it comes when the setting goes on again.
            return Fill::Kept;
        }
        let open = ws.open_book_slot(book);
        let slot = match open {
            Some(slot) => slot,
            None if want.lazy => return Fill::Kept,
            None => match ws.book_slot(book) {
                Ok(slot) => slot,
                Err(crate::WsError::NotFound { .. }) => return Fill::Done,
                Err(e) => {
                    log::warn!("automatic links: book {book} could not be opened: {e}");
                    return Fill::Kept;
                }
            },
        };
        if !slot.is_v3() {
            return Fill::Done;
        }
        let (_, names, _) = super::book_cache(&slot);
        let targets: Arc<HashSet<String>> = Arc::new(
            names
                .iter()
                .map(|n| n.target.id.clone())
                .filter(|id| want.all || want.entries.contains(id))
                .collect(),
        );
        if targets.is_empty() {
            return Fill::Done;
        }
        let started = Instant::now();
        let mut later = Vec::new();
        let mut linked = 0usize;
        for doc in documents(ws, &slot) {
            if self.paused() {
                return Fill::Kept;
            }
            self.save_waiting(ws);
            match self.fill_doc(ws, &slot, &doc, &targets) {
                Ok((DocFill::Composing, _)) => later.push(doc),
                Ok((DocFill::Linked, n)) => linked += n,
                Err(e) => log::warn!("automatic links: {doc} not linked: {e}"),
            }
        }
        if let Err(e) = self.fill_book_texts(ws, &slot, &targets) {
            log::warn!("automatic links: comments of {book} not linked: {e}");
        }
        let waited = Instant::now();
        while !later.is_empty() {
            if self.paused() || !ws.auto_links() {
                return Fill::Kept;
            }
            if waited.elapsed() > COMPOSING_PATIENCE {
                log::info!("automatic links: still composing in {book}; left for its next opening");
                return Fill::Kept;
            }
            std::thread::sleep(COMPOSING_RETRY);
            let mut still = Vec::new();
            for doc in later {
                match self.fill_doc(ws, &slot, &doc, &targets) {
                    Ok((DocFill::Composing, _)) => still.push(doc),
                    Ok((DocFill::Linked, n)) => linked += n,
                    Err(e) => log::warn!("automatic links: {doc} not linked: {e}"),
                }
            }
            later = still;
        }
        log::debug!(
            "automatic links: {linked} links added in {book} in {:.0} ms",
            started.elapsed().as_secs_f64() * 1e3
        );
        Fill::Done
    }

    /// Link one prose document: a look first, without opening it for
    /// writing (most documents have nothing to link), then the write, planned
    /// again on the holder's document as it is then.
    fn fill_doc(
        self: &Arc<Self>,
        ws: &Workspace,
        slot: &BookSlot,
        doc: &DocId,
        targets: &Arc<HashSet<String>>,
    ) -> crate::Result<(DocFill, usize)> {
        let names = super::book_matcher(slot, doc);
        let (look_names, look_targets) = (names.clone(), targets.clone());
        let found = ws.read_prose_readonly(doc, move |view| {
            let added = |id: &str| look_targets.contains(id);
            Ok(!super::plan_backfill_prose(view, &look_names, &added)?.is_empty())
        })?;
        if found != Some(true) {
            return Ok((DocFill::Linked, 0));
        }
        let prose = ws.prose_slot(doc)?;
        let (this, id, targets) = (self.clone(), doc.clone(), targets.clone());
        let linked = holder::write(&prose.handle, dr_store::Origin::Repair, None, move |d| {
            if this.is_composing(&id) {
                return Ok(None);
            }
            let body = dr_doc::prose::BorrowedProse::new(d, &id)?;
            let mut txn = body.txn();
            let added = |t: &str| targets.contains(t);
            Ok(Some(super::backfill_prose(&mut txn, &names, &added)?))
        })?;
        Ok(match linked {
            Some(n) => (DocFill::Linked, n),
            None => (DocFill::Composing, 0),
        })
    }

    /// The comments not projected from a line, and the relation
    /// descriptions: one write of the book, under its gate.
    fn fill_book_texts(
        &self,
        ws: &Workspace,
        slot: &BookSlot,
        targets: &Arc<HashSet<String>>,
    ) -> crate::Result<()> {
        let _lease = ws.book_gate(&slot.book).enter();
        let names = super::book_cache(slot).2;
        let (book, targets) = (slot.book.clone(), targets.clone());
        holder::write(&slot.handle, dr_store::Origin::Repair, None, move |d| {
            let b = dr_doc::v3::BorrowedBookV3::new(d, &book)?;
            let added = |id: &str| targets.contains(id);
            let (comments, relations) = {
                let view = b.view();
                let comments: Vec<_> = view
                    .comments()
                    .into_iter()
                    .filter(|c| c.projection.is_none())
                    .filter_map(|c| {
                        let owner = c
                            .target
                            .as_ref()
                            .filter(|t| t.kind == dr_model::kind::EntityKind::Entry)
                            .and_then(|t| EntryId::parse(&t.id).ok());
                        let stored = view.comment_body_raw(&c.id)?;
                        let body =
                            super::backfill_linked_text(&stored, owner.as_ref(), &names, &added)?;
                        Some((c.id, body))
                    })
                    .collect();
                let relations: Vec<_> = view
                    .relation_types_raw()
                    .into_iter()
                    .filter_map(|r| {
                        let text =
                            super::backfill_linked_text(&r.description, None, &names, &added)?;
                        Some((r.id, text))
                    })
                    .collect();
                (comments, relations)
            };
            let mut txn = b.txn();
            for (id, body) in &comments {
                txn.comment(id)?.linked_body(body)?;
            }
            for (id, text) in &relations {
                txn.relation_type(id)?.description(text)?;
            }
            Ok(())
        })
    }
}

/// The bodies of `slot`'s live entries, the ones an editor has open first.
fn documents(ws: &Workspace, slot: &BookSlot) -> Vec<DocId> {
    let live: HashSet<EntryId> = slot
        .reader_v3
        .view()
        .auto_link_switches()
        .into_iter()
        .filter(|(_, (_, live))| *live)
        .map(|(id, _)| id)
        .collect();
    let docs = match ws.library().docs(Some(slot.book.as_str()), Some("body")) {
        Ok(docs) => docs,
        Err(e) => {
            log::warn!(
                "automatic links: the documents of {} could not be listed: {e}",
                slot.book
            );
            return Vec::new();
        }
    };
    let in_use = ws.prose_in_use();
    let mut docs: Vec<DocId> = docs
        .into_iter()
        .filter_map(|d| match DocId::parse(&d.doc_id) {
            Ok(DocId::Body(body)) if live.contains(body.entry()) => Some(DocId::Body(body)),
            _ => None,
        })
        .collect();
    docs.sort_by_key(|d| !in_use.contains(d));
    docs
}

fn load(ws: &Workspace, book: &BookId) -> Want {
    match ws.library().local_get(SCOPE, book.as_str()) {
        Ok(Some(value)) => serde_json::from_str(&value).unwrap_or_else(|e| {
            log::warn!("automatic links: what is left of {book} could not be read: {e}");
            // Read as the most there could be: every name.
            Want {
                all: true,
                ..Want::default()
            }
        }),
        Ok(None) => Want::default(),
        Err(e) => {
            log::warn!("automatic links: what is left of {book} could not be read: {e}");
            Want::default()
        }
    }
}

/// Store `want` as what is left of `book` (replacing the row).
fn save(ws: &Workspace, book: &BookId, want: &Want) {
    if want.is_empty() {
        forget(ws, book);
        return;
    }
    let value = serde_json::to_string(want).expect("a backfill want serializes");
    if let Err(e) = ws
        .library()
        .local_set(SCOPE, book.as_str(), &value, Some(book.as_str()))
    {
        log::warn!("automatic links: what is left of {book} could not be stored: {e}");
    }
}

fn forget(ws: &Workspace, book: &BookId) {
    if let Err(e) = ws.library().local_remove(SCOPE, book.as_str()) {
        log::warn!("automatic links: the row of {book} could not be removed: {e}");
    }
}

/// Whether `book` has something left to link on this device.
pub(crate) fn has_row(ws: &Workspace, book: &BookId) -> bool {
    matches!(ws.library().local_get(SCOPE, book.as_str()), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wants_merge_to_the_most_and_only_the_setting_waits_for_an_opening() {
        let id = |s: &str| s.to_owned();
        let mut a = Want::entries([]);
        assert!(a.is_empty());
        a.merge(Want {
            entries: [id("e1")].into(),
            ..Want::default()
        });
        a.merge(Want {
            entries: [id("e2")].into(),
            ..Want::default()
        });
        assert_eq!(a.entries, [id("e1"), id("e2")].into());
        assert!(!a.lazy);
        // The setting's turn, lazy, does not make an entry's turn wait.
        a.merge(Want::every_name_when_open());
        assert!(a.all && a.entries.is_empty() && !a.lazy);
        let mut b = Want::default();
        b.merge(Want::every_name_when_open());
        assert!(b.all && b.lazy);
        // Stored and read back: the opening it waits for is not stored.
        let stored: Want = serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
        assert!(stored.all && !stored.lazy);
        let stored: Want =
            serde_json::from_str(&serde_json::to_string(&Want::entries([])).unwrap()).unwrap();
        assert!(stored.is_empty());
    }
}
