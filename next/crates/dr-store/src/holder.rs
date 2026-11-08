//! Document holders: one thread per open document.
//!
//! Loro has one implicit transaction per document, shared by every thread
//! that touches it: if the editor inserted a character while an Agent write
//! was half done, the Agent's commit would carry the author's keystroke. So
//! nothing edits an open document except its holder thread:
//!
//! 1. A write is queued as a closure with its [`Origin`]. The holder runs it,
//!    then commits with that origin (and, for an Agent, the same string as
//!    the commit message). One message, one commit, one origin.
//! 2. The new operations are exported and appended to `loro_update` in one
//!    SQLite transaction (with any history label due).
//! 3. Only then are the Loro diffs of that commit delivered as a
//!    [`DocEvent`]. A crash can lose only operations nobody was told about.
//!
//! When idle with enough updates pending, the holder writes a snapshot and
//! deletes the updates it covers in one transaction; when idle after changes
//! and a deriver is configured, it brings the document's derived index up to
//! date from the Loro diffs it collected.
//!
//! Every append is a single SQLite transaction holding the update row, the
//! document's new head and the library's write counter, plus whatever must
//! not be separated from it: due history labels, an Agent write's settlement
//! record, and for a sync import what the server is now known to have. So
//! nothing ever needs flushing at exit (GPUI gives quit handlers 200 ms).

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::Instant;

use loro::event::{Diff, DiffEvent, MapDelta};
use loro::{
    ChangeMeta, CommitOptions, ContainerID, EventTriggerKind, ExportMode, Frontiers, ID,
    ImportStatus, Index, IntoContainerId, LoroCounter, LoroDoc, LoroList, LoroMap, LoroMovableList,
    LoroText, LoroTree, LoroValue, PeerID, Subscription, VersionVector,
};
use rusqlite::{OptionalExtension, params};

use crate::error::{Result, StoreError};
use crate::events::{LocalChange, LocalChangeKind, StoreEvent};
use crate::history::{self, labels};
use crate::index::{DeriveInput, DerivedUpdate, DocIndex, DocPatch, write_index, write_patch};
use crate::library::{
    CompactStats, Inner, LoadStats, export_snapshot, merge_remote_vv, record_append, store_snapshot,
};
use crate::now_ms;
use crate::origin::Origin;

/// An Agent write and what its settlement record says about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentWrite {
    pub session: String,
    pub turn: String,
    /// The tool call that made the write.
    pub call: String,
    /// What the write did, for the author.
    pub summary: String,
}

impl AgentWrite {
    pub fn origin(&self) -> Origin {
        Origin::agent(&self.session, &self.turn)
    }
}

/// What goes into an append's transaction besides the update.
#[derive(Clone, Debug, Default)]
struct Extras {
    /// A history label on the version before this write.
    pre_label: Option<(Vec<u8>, String)>,
    /// An Agent write's settlement, with the version before it.
    settlement: Option<(AgentWrite, Vec<u8>)>,
    /// For a sync import: what the server is now known to have.
    remote: Option<VersionVector>,
}

/// Loro diffs collected since the last derivation is capped; past it the
/// deriver starts from scratch.
const MAX_PENDING_CHANGES: usize = 20_000;

/// One container's change in an event, owned.
#[derive(Clone, Debug)]
pub struct ContainerChange {
    pub target: ContainerID,
    pub path: Vec<(ContainerID, Index)>,
    pub diff: Diff<'static>,
}

fn owned_diff(diff: Diff<'_>) -> Diff<'static> {
    match diff {
        Diff::List(l) => Diff::List(l),
        Diff::Text(t) => Diff::Text(t),
        Diff::Map(m) => Diff::Map(MapDelta {
            updated: m
                .updated
                .into_iter()
                .map(|(k, v)| (std::borrow::Cow::Owned(k.into_owned()), v))
                .collect(),
        }),
        Diff::Tree(t) => Diff::Tree(std::borrow::Cow::Owned(t.into_owned())),
        Diff::Counter(c) => Diff::Counter(c),
        Diff::Unknown => Diff::Unknown,
    }
}

/// A persisted change to an open document. Delivered after the update is in
/// SQLite, on the holder thread, in commit order.
#[derive(Clone, Debug)]
pub struct DocEvent {
    pub doc_id: Arc<str>,
    /// The `loro_update` row that made it durable.
    pub seq: i64,
    pub origin: Origin,
    /// Local commit or import.
    pub triggered_by: EventTriggerKind,
    /// The document's version after the change.
    pub frontiers: Frontiers,
    pub changes: Vec<ContainerChange>,
}

/// The result of a write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Committed {
    /// The `loro_update` row, or `None` when the write changed nothing.
    pub seq: Option<i64>,
    /// Size of the appended update.
    pub bytes: usize,
    /// The document's version after the write.
    pub frontiers: Frontiers,
}

/// The result of importing remote updates.
#[derive(Clone, Debug)]
pub struct Imported {
    /// What Loro applied, and what it is still waiting for (missing
    /// dependencies). Only applied operations are persisted; the sync layer
    /// must fetch the rest again.
    pub status: ImportStatus,
    pub committed: Committed,
}

/// Counters of one holder.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HolderStats {
    pub commits: u64,
    /// Commits of operations written outside the holder (should stay 0).
    pub outside_commits: u64,
    pub compactions: u64,
    pub pending_updates: usize,
    pub pending_bytes: usize,
}

type Listener = Arc<dyn Fn(&DocEvent) + Send + Sync>;

/// Loro diffs of commits not yet persisted, in order.
type EventBuffer = Arc<Mutex<Vec<(EventTriggerKind, Vec<ContainerChange>)>>>;

/// Holder threads whose last handle is gone, for [`crate::Library::close`]
/// to join.
pub(crate) type Closing = Arc<Mutex<Vec<JoinHandle<()>>>>;

/// Operations whose append failed: their origin and what was to be written
/// with them.
type Unpersisted = (Origin, Extras);

#[derive(Default)]
struct Listeners {
    next: u64,
    list: Vec<(u64, Listener)>,
}

#[derive(Default)]
struct Counters {
    commits: AtomicU64,
    outside: AtomicU64,
    compactions: AtomicU64,
    pending_updates: AtomicUsize,
    pending_bytes: AtomicUsize,
}

trait WriteJob: Send {
    /// Run the closure. Returns false if it panicked.
    fn run(&mut self, doc: &LoroDoc) -> bool;
    fn finish(self: Box<Self>, result: Result<Committed>);
}

struct Job<F, R> {
    f: Option<F>,
    out: Option<R>,
    doc_id: Arc<str>,
    done: Sender<Result<(R, Committed)>>,
}

impl<F, R> WriteJob for Job<F, R>
where
    F: FnOnce(&LoroDoc) -> R + Send,
    R: Send,
{
    fn run(&mut self, doc: &LoroDoc) -> bool {
        let Some(f) = self.f.take() else {
            return false;
        };
        match std::panic::catch_unwind(AssertUnwindSafe(|| f(doc))) {
            Ok(r) => {
                self.out = Some(r);
                true
            }
            Err(_) => false,
        }
    }

    fn finish(self: Box<Self>, result: Result<Committed>) {
        let Job {
            out, doc_id, done, ..
        } = *self;
        let result = result.and_then(|c| match out {
            Some(r) => Ok((r, c)),
            None => Err(StoreError::WritePanicked(doc_id.to_string())),
        });
        let _ = done.send(result);
    }
}

enum Msg {
    Write {
        origin: Origin,
        agent: Option<AgentWrite>,
        job: Box<dyn WriteJob>,
    },
    Reindex(Sender<Result<bool>>),
    Import {
        origin: Origin,
        bytes: Vec<u8>,
        done: Sender<Result<Imported>>,
    },
    /// A read; returns false if the closure panicked.
    Run(Box<dyn FnOnce(&LoroDoc) -> bool + Send>),
    Compact(Sender<Result<Option<CompactStats>>>),
    Label {
        label: String,
        done: Sender<Result<bool>>,
    },
    Close,
}

pub(crate) struct Shared {
    doc_id: Arc<str>,
    view: DocView,
    tx: Sender<Msg>,
    thread: Mutex<Option<JoinHandle<()>>>,
    closing: Closing,
    listeners: Arc<Mutex<Listeners>>,
    counters: Arc<Counters>,
}

impl Drop for Shared {
    /// Never blocks: the holder finishes its queue and closes on its own
    /// thread. [`DocHandle::close`] and [`crate::Library::close`] wait.
    fn drop(&mut self) {
        // Hand the thread over before asking it to stop, so whoever sees
        // the document's slot freed can also join the thread.
        if let Some(thread) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take() {
            self.closing
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(thread);
        }
        let _ = self.tx.send(Msg::Close);
    }
}

/// Read access to an open document from any thread (layout, queries).
///
/// Only reads of the current state are offered. Loro's `export`, `fork`,
/// `checkout`, `diff`, cursor-position queries and history walks first
/// commit the document's shared pending transaction: from another thread
/// that would cut a queued write in two, half of it without its origin. Do
/// those through [`DocHandle::read`].
///
/// The containers it returns can technically be edited. Never do that: an
/// edit made here is committed on its own with origin [`Origin::Outside`]
/// before the next queued operation, but one made while a queued write runs
/// would join it. Reads may observe a write in progress; [`DocHandle::read`]
/// sees only whole writes.
#[derive(Clone)]
pub struct DocView(LoroDoc);

impl DocView {
    pub fn get_text<I: IntoContainerId>(&self, id: I) -> LoroText {
        self.0.get_text(id)
    }

    pub fn get_map<I: IntoContainerId>(&self, id: I) -> LoroMap {
        self.0.get_map(id)
    }

    pub fn get_list<I: IntoContainerId>(&self, id: I) -> LoroList {
        self.0.get_list(id)
    }

    pub fn get_movable_list<I: IntoContainerId>(&self, id: I) -> LoroMovableList {
        self.0.get_movable_list(id)
    }

    pub fn get_tree<I: IntoContainerId>(&self, id: I) -> LoroTree {
        self.0.get_tree(id)
    }

    pub fn get_counter<I: IntoContainerId>(&self, id: I) -> LoroCounter {
        self.0.get_counter(id)
    }

    pub fn get_value(&self) -> LoroValue {
        self.0.get_value()
    }

    pub fn get_deep_value(&self) -> LoroValue {
        self.0.get_deep_value()
    }

    pub fn oplog_frontiers(&self) -> Frontiers {
        self.0.oplog_frontiers()
    }

    pub fn state_frontiers(&self) -> Frontiers {
        self.0.state_frontiers()
    }

    pub fn oplog_vv(&self) -> VersionVector {
        self.0.oplog_vv()
    }

    pub fn state_vv(&self) -> VersionVector {
        self.0.state_vv()
    }

    pub fn peer_id(&self) -> PeerID {
        self.0.peer_id()
    }

    pub fn len_changes(&self) -> usize {
        self.0.len_changes()
    }

    pub fn len_ops(&self) -> usize {
        self.0.len_ops()
    }

    pub fn get_change(&self, id: ID) -> Option<ChangeMeta> {
        self.0.get_change(id)
    }

    /// The open document itself, for typed readers (dr-doc's views) that
    /// take a `&LoroDoc`. The same contract as the rest of `DocView`: read
    /// the current state only. Never commit, export, import, fork, check out,
    /// diff, ask for a cursor position or walk history on it here: those
    /// commit the shared pending transaction and would split a queued write.
    /// They belong in [`DocHandle::read`], which hands over the same
    /// document on the holder thread.
    pub fn with_doc<R>(&self, f: impl FnOnce(&LoroDoc) -> R) -> R {
        f(&self.0)
    }
}

/// A handle to an open document. Clones share one holder. When the last
/// handle goes, the holder finishes what is queued, labels and compacts on
/// its own thread; dropping never blocks, [`Self::close`] waits.
#[derive(Clone)]
pub struct DocHandle {
    shared: Arc<Shared>,
}

/// A queued write that has not been waited for.
pub struct PendingWrite<R> {
    doc_id: Arc<str>,
    rx: Receiver<Result<(R, Committed)>>,
}

impl<R> PendingWrite<R> {
    /// Wait until the write is committed and persisted.
    pub fn wait(self) -> Result<(R, Committed)> {
        self.rx
            .recv()
            .unwrap_or_else(|_| Err(StoreError::Closed(self.doc_id.to_string())))
    }
}

/// Unsubscribes when dropped.
pub struct EventSubscription {
    listeners: Weak<Mutex<Listeners>>,
    id: u64,
}

impl Drop for EventSubscription {
    fn drop(&mut self) {
        if let Some(listeners) = self.listeners.upgrade() {
            listeners
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .list
                .retain(|(id, _)| *id != self.id);
        }
    }
}

impl DocHandle {
    pub(crate) fn from_shared(shared: Arc<Shared>) -> Self {
        Self { shared }
    }

    pub(crate) fn weak(&self) -> Weak<Shared> {
        Arc::downgrade(&self.shared)
    }

    pub fn doc_id(&self) -> &str {
        &self.shared.doc_id
    }

    /// Read access from any thread; see [`DocView`] for what it allows.
    pub fn doc(&self) -> &DocView {
        &self.shared.view
    }

    fn send(&self, msg: Msg) -> Result<()> {
        self.shared
            .tx
            .send(msg)
            .map_err(|_| StoreError::Closed(self.shared.doc_id.to_string()))
    }

    /// Queue a write and return without waiting.
    pub fn submit<R, F>(&self, origin: Origin, f: F) -> Result<PendingWrite<R>>
    where
        F: FnOnce(&LoroDoc) -> R + Send + 'static,
        R: Send + 'static,
    {
        self.submit_inner(origin, None, f)
    }

    /// Queue an Agent write: origin and commit message
    /// `agent:<session>/<turn>`, and a settlement record written in the same
    /// transaction as the update.
    pub fn submit_agent<R, F>(&self, agent: AgentWrite, f: F) -> Result<PendingWrite<R>>
    where
        F: FnOnce(&LoroDoc) -> R + Send + 'static,
        R: Send + 'static,
    {
        self.submit_inner(agent.origin(), Some(agent), f)
    }

    /// [`Self::submit_agent`] and wait.
    pub fn write_agent<R, F>(&self, agent: AgentWrite, f: F) -> Result<(R, Committed)>
    where
        F: FnOnce(&LoroDoc) -> R + Send + 'static,
        R: Send + 'static,
    {
        self.submit_agent(agent, f)?.wait()
    }

    /// Bring the derived index up to date now (needs a deriver). Returns
    /// whether rows were written.
    pub fn reindex_now(&self) -> Result<bool> {
        let (done, rx) = mpsc::channel();
        self.send(Msg::Reindex(done))?;
        rx.recv()
            .unwrap_or_else(|_| Err(StoreError::Closed(self.shared.doc_id.to_string())))
    }

    fn submit_inner<R, F>(
        &self,
        origin: Origin,
        agent: Option<AgentWrite>,
        f: F,
    ) -> Result<PendingWrite<R>>
    where
        F: FnOnce(&LoroDoc) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (done, rx) = mpsc::channel();
        self.send(Msg::Write {
            origin,
            agent,
            job: Box::new(Job {
                f: Some(f),
                out: None,
                doc_id: self.shared.doc_id.clone(),
                done,
            }),
        })?;
        Ok(PendingWrite {
            doc_id: self.shared.doc_id.clone(),
            rx,
        })
    }

    /// Run `f` on the holder thread, commit its edits as one commit with
    /// `origin`, append it to SQLite, and return once it is durable. `f` must
    /// only edit; it must not commit, export, import or check out.
    ///
    /// When `f` starts, the holder has settled the document: nothing is
    /// pending in Loro's transaction and everything committed is stored. So
    /// `f` may export what it needs at its start, or import updates made
    /// elsewhere and then edit; the whole job is still one append with one
    /// origin (dr-workspace's mirror relies on this).
    pub fn write<R, F>(&self, origin: Origin, f: F) -> Result<(R, Committed)>
    where
        F: FnOnce(&LoroDoc) -> R + Send + 'static,
        R: Send + 'static,
    {
        self.submit(origin, f)?.wait()
    }

    /// Import updates from elsewhere (sync), persist what was applied and
    /// announce it.
    pub fn import(&self, bytes: Vec<u8>, origin: Origin) -> Result<Imported> {
        let (done, rx) = mpsc::channel();
        self.send(Msg::Import {
            origin,
            bytes,
            done,
        })?;
        rx.recv()
            .unwrap_or_else(|_| Err(StoreError::Closed(self.shared.doc_id.to_string())))
    }

    /// Run `f` on the holder thread, between queued writes: a consistent
    /// view, and the place for exports, cursor positions and history walks.
    /// `f` must not edit.
    pub fn read<R, F>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&LoroDoc) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (done, rx) = mpsc::channel();
        self.send(Msg::Run(Box::new(
            move |doc| match std::panic::catch_unwind(AssertUnwindSafe(|| f(doc))) {
                Ok(r) => {
                    let _ = done.send(Ok(r));
                    true
                }
                Err(_) => {
                    let _ = done.send(Err(()));
                    false
                }
            },
        )))?;
        match rx.recv() {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(())) => Err(StoreError::ReadPanicked(self.shared.doc_id.to_string())),
            Err(_) => Err(StoreError::Closed(self.shared.doc_id.to_string())),
        }
    }

    /// Compact now: snapshot plus deletion of the covered updates. `None`
    /// when nothing was pending.
    pub fn compact_now(&self) -> Result<Option<CompactStats>> {
        let (done, rx) = mpsc::channel();
        self.send(Msg::Compact(done))?;
        rx.recv()
            .unwrap_or_else(|_| Err(StoreError::Closed(self.shared.doc_id.to_string())))
    }

    /// Label the current version in history (for example
    /// [`labels::RESTORE`] after a revert). Skipped (false) when the latest
    /// label already points at this version.
    pub fn label(&self, label: &str) -> Result<bool> {
        let (done, rx) = mpsc::channel();
        self.send(Msg::Label {
            label: label.to_string(),
            done,
        })?;
        rx.recv()
            .unwrap_or_else(|_| Err(StoreError::Closed(self.shared.doc_id.to_string())))
    }

    /// Call `f` with every persisted change, on the holder thread. `f` must
    /// not block on this document's holder.
    pub fn subscribe(&self, f: impl Fn(&DocEvent) + Send + Sync + 'static) -> EventSubscription {
        let mut listeners = self
            .shared
            .listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        listeners.next += 1;
        let id = listeners.next;
        listeners.list.push((id, Arc::new(f)));
        EventSubscription {
            listeners: Arc::downgrade(&self.shared.listeners),
            id,
        }
    }

    pub fn stats(&self) -> HolderStats {
        let c = &self.shared.counters;
        HolderStats {
            commits: c.commits.load(Ordering::Relaxed),
            outside_commits: c.outside.load(Ordering::Relaxed),
            compactions: c.compactions.load(Ordering::Relaxed),
            pending_updates: c.pending_updates.load(Ordering::Relaxed),
            pending_bytes: c.pending_bytes.load(Ordering::Relaxed),
        }
    }

    /// Close this handle. If it was the last one, wait until the holder has
    /// finished its queue, labelled, compacted and released the document.
    pub fn close(self) {
        let Ok(shared) = Arc::try_unwrap(self.shared) else {
            return;
        };
        let thread = shared
            .thread
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        drop(shared);
        if let Some(thread) = thread
            && thread.thread().id() != std::thread::current().id()
        {
            let _ = thread.join();
        }
    }
}

struct Holder {
    lib: Arc<Inner>,
    doc_id: Arc<str>,
    doc: LoroDoc,
    last_vv: VersionVector,
    next_seq: i64,
    /// The latest history label: (time, encoded frontiers, label).
    latest_label: Option<(i64, Vec<u8>, String)>,
    /// This opening committed something that earns history labels (not
    /// only genesis, import, repair or outside writes): closing labels it.
    labelled_writes: bool,
    import_since_idle: bool,
    /// Operations whose append failed. They are retried on their own, with
    /// their label, before anything else runs, so a row never mixes origins.
    unpersisted: Option<Unpersisted>,
    kind: String,
    book_id: Option<String>,
    /// The book document whose version history labels record.
    book_doc: Option<String>,
    /// The derived index is behind the document.
    index_dirty: bool,
    /// Loro diffs since the last derivation; `None` means start from scratch.
    changes_since_index: Option<Vec<ContainerChange>>,
    buffer: EventBuffer,
    _loro_subscription: Subscription,
    listeners: Arc<Mutex<Listeners>>,
    counters: Arc<Counters>,
}

pub(crate) fn spawn(
    lib: Arc<Inner>,
    doc_id: &str,
    doc: LoroDoc,
    stats: LoadStats,
) -> Result<DocHandle> {
    let doc_id: Arc<str> = Arc::from(doc_id);
    let latest_label = history::latest(&lib.reader(), &doc_id)?;
    let (kind, book_id): (String, Option<String>) = lib
        .reader()
        .query_row(
            "SELECT kind, book_id FROM loro_doc WHERE doc_id = ?1",
            [&*doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or_else(|| (String::new(), None));
    let indexed_seq: Option<i64> = lib
        .reader()
        .query_row(
            "SELECT indexed_seq FROM index_state WHERE doc_id = ?1",
            [&*doc_id],
            |r| r.get(0),
        )
        .optional()?;
    let index_dirty = indexed_seq.is_none_or(|s| s < stats.last_seq);
    let book_doc = book_id.as_ref().map(|b| format!("book:{b}"));
    let (pending_updates, pending_bytes): (i64, i64) = lib.reader().query_row(
        "SELECT count(*), coalesce(sum(length(bytes)), 0) FROM loro_update WHERE doc_id = ?1",
        [&*doc_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let counters = Arc::new(Counters::default());
    counters
        .pending_updates
        .store(pending_updates as usize, Ordering::Relaxed);
    counters
        .pending_bytes
        .store(pending_bytes as usize, Ordering::Relaxed);
    let buffer: EventBuffer = Arc::default();
    let sink = buffer.clone();
    let loro_subscription = doc.subscribe_root(Arc::new(move |e: DiffEvent<'_>| {
        if matches!(e.triggered_by, EventTriggerKind::Checkout) {
            return;
        }
        let changes = e
            .events
            .into_iter()
            .map(|c| ContainerChange {
                target: c.target.clone(),
                path: c.path.to_vec(),
                diff: owned_diff(c.diff),
            })
            .collect();
        sink.lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((e.triggered_by, changes));
    }));
    let listeners: Arc<Mutex<Listeners>> = Arc::default();
    let holder = Holder {
        lib: lib.clone(),
        doc_id: doc_id.clone(),
        doc: doc.clone(),
        last_vv: doc.oplog_vv(),
        next_seq: stats.last_seq + 1,
        latest_label,
        labelled_writes: false,
        import_since_idle: false,
        unpersisted: None,
        kind,
        book_id,
        book_doc,
        index_dirty,
        changes_since_index: None,
        buffer,
        _loro_subscription: loro_subscription,
        listeners: listeners.clone(),
        counters: counters.clone(),
    };
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name(format!("dr-store:{doc_id}"))
        .spawn(move || holder.run(rx))?;
    Ok(DocHandle {
        shared: Arc::new(Shared {
            doc_id,
            view: DocView(doc),
            tx,
            thread: Mutex::new(Some(thread)),
            closing: lib.closing.clone(),
            listeners,
            counters,
        }),
    })
}

/// Frees the document's slot in the library when the holder thread ends,
/// even by a panic, so a later `open_doc` never waits for it forever.
struct ReleaseSlot(Arc<Inner>, Arc<str>);

impl Drop for ReleaseSlot {
    fn drop(&mut self) {
        self.0.release(&self.1);
    }
}

impl Holder {
    fn run(mut self, rx: Receiver<Msg>) {
        let _release = ReleaseSlot(self.lib.clone(), self.doc_id.clone());
        let derive_idle = self.lib.options.derive_idle;
        let idle = self.lib.options.compaction.idle;
        // Idle work waits for a quiet spell after the last job: deriving the
        // index `derive_idle` after it, compacting `idle` after it. Work
        // that ran (or failed) waits a full spell again before it is retried.
        let (mut derive_at, mut maintain_at) = {
            let now = Instant::now();
            (now + derive_idle, now + idle)
        };
        loop {
            let next = [
                self.derive_due().then_some(derive_at),
                self.maintenance_due().then_some(maintain_at),
            ]
            .into_iter()
            .flatten()
            .min();
            let msg = match next {
                Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                    Ok(msg) => msg,
                    Err(RecvTimeoutError::Timeout) => {
                        let now = Instant::now();
                        if self.derive_due() && now >= derive_at {
                            self.derive_when_idle();
                            derive_at = now + derive_idle;
                        }
                        if self.maintenance_due() && now >= maintain_at {
                            self.idle_maintenance();
                            maintain_at = now + idle;
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(msg) => msg,
                    Err(_) => break,
                },
            };
            let now = Instant::now();
            derive_at = now + derive_idle;
            maintain_at = now + idle;
            match msg {
                Msg::Write {
                    origin,
                    agent,
                    mut job,
                } => {
                    let result = self.write(&origin, agent, &mut *job);
                    job.finish(result);
                }
                Msg::Reindex(done) => {
                    let _ = done.send(self.reindex());
                }
                Msg::Import {
                    origin,
                    bytes,
                    done,
                } => {
                    let _ = done.send(self.import(&origin, &bytes));
                }
                Msg::Run(f) => {
                    let _ = self.settle();
                    if !f(&self.doc) {
                        log::error!("{}: a read panicked", self.doc_id);
                    }
                    let _ = self.settle();
                }
                Msg::Compact(done) => {
                    let _ = done.send(self.compact());
                }
                Msg::Label { label, done } => {
                    let _ = done.send(self.label_now(&label));
                }
                Msg::Close => break,
            }
        }
        self.on_close();
    }

    fn pending(&self) -> (usize, usize) {
        (
            self.counters.pending_updates.load(Ordering::Relaxed),
            self.counters.pending_bytes.load(Ordering::Relaxed),
        )
    }

    fn compaction_due(&self) -> bool {
        let policy = &self.lib.options.compaction;
        let (count, bytes) = self.pending();
        count > 0 && (count >= policy.max_updates || bytes >= policy.max_bytes)
    }

    fn maintenance_due(&self) -> bool {
        self.compaction_due() || self.import_since_idle
    }

    fn derive_due(&self) -> bool {
        self.index_dirty && self.lib.options.deriver.is_some()
    }

    fn derive_when_idle(&mut self) {
        if let Err(e) = self.reindex() {
            log::warn!("deriving the index of {} failed: {e}", self.doc_id);
            // Try again from scratch next time rather than spinning.
            self.index_dirty = false;
            self.changes_since_index = None;
        }
    }

    fn idle_maintenance(&mut self) {
        if self.compaction_due()
            && let Err(e) = self.compact()
        {
            log::warn!("compacting {} failed: {e}", self.doc_id);
        }
        if self.import_since_idle {
            // Imports expand history into memory (P0-C); give back what Loro can.
            self.doc.free_history_cache();
            self.import_since_idle = false;
        }
    }

    /// Run the deriver on the collected diffs and store the result with the
    /// seq it reflects. Returns whether rows were written.
    fn reindex(&mut self) -> Result<bool> {
        self.settle()?;
        let Some(deriver) = self.lib.options.deriver.clone() else {
            return Ok(false);
        };
        let changes = self.changes_since_index.take();
        let input = DeriveInput {
            doc_id: &self.doc_id,
            kind: &self.kind,
            book_id: self.book_id.as_deref(),
            doc: &self.doc,
            changes: changes.as_deref(),
            held: true,
        };
        let derived = deriver.derive(&input);
        self.index_dirty = false;
        self.changes_since_index = Some(Vec::new());
        let frontiers = self.doc.oplog_frontiers();
        let seq = self.next_seq - 1;
        let written = match derived {
            None => return Ok(false),
            Some(DerivedUpdate::Full(derived)) => write_index(
                &self.lib.writer(),
                &DocIndex {
                    doc_id: &self.doc_id,
                    book_id: self.book_id.as_deref(),
                    seq,
                    frontiers: &frontiers,
                    derived: &derived,
                },
            )?,
            Some(DerivedUpdate::Patch(patch)) => {
                let written = write_patch(
                    &self.lib.writer(),
                    &DocPatch {
                        doc_id: &self.doc_id,
                        book_id: self.book_id.as_deref(),
                        seq,
                        frontiers: &frontiers,
                        patch: &patch,
                    },
                );
                match written {
                    Err(StoreError::IndexBase { .. }) => {
                        // Made from other rows than the stored ones: derive
                        // the whole document next time.
                        log::debug!("{}: index patch did not fit, rederiving", self.doc_id);
                        self.changes_since_index = None;
                        self.index_dirty = true;
                        return Ok(false);
                    }
                    other => other?,
                }
            }
        };
        if written {
            self.lib.publish(&StoreEvent::Local(LocalChange::new(
                "index",
                &*self.doc_id,
                LocalChangeKind::Update,
            )));
        }
        Ok(written)
    }

    /// Before anything else: store what an earlier failed append left, then
    /// commit and store what was written outside the holder. On failure the
    /// caller must not add operations of its own.
    fn settle(&mut self) -> Result<()> {
        self.retry_unpersisted()?;
        self.absorb_outside()
    }

    /// Commit and persist operations someone wrote outside the holder, so
    /// they never join the next origin's commit.
    fn absorb_outside(&mut self) -> Result<()> {
        if self.doc.get_pending_txn_len() == 0 {
            return Ok(());
        }
        log::error!(
            "{}: {} operations were written outside the document holder",
            self.doc_id,
            self.doc.get_pending_txn_len()
        );
        self.doc.commit_with(
            CommitOptions::new()
                .origin(&Origin::Outside.to_string())
                .commit_msg(&Origin::Outside.to_string()),
        );
        self.counters.outside.fetch_add(1, Ordering::Relaxed);
        self.persist(&Origin::Outside, Extras::default())
            .map(|_| ())
    }

    /// Append operations whose earlier append failed, under their own origin
    /// and with the label that was due with them.
    fn retry_unpersisted(&mut self) -> Result<()> {
        if let Some((origin, extras)) = self.unpersisted.clone() {
            self.persist(&origin, extras)?;
        }
        Ok(())
    }

    fn write(
        &mut self,
        origin: &Origin,
        agent: Option<AgentWrite>,
        job: &mut dyn WriteJob,
    ) -> Result<Committed> {
        // Refuse new edits while earlier ones cannot be stored.
        self.settle()?;
        let before = self.doc.oplog_frontiers();
        let mut options = CommitOptions::new().origin(&origin.to_string());
        if let Some(message) = origin.commit_message() {
            options = options.commit_msg(&message);
        }
        // Set before the job runs: Loro commits part-way through on its own
        // (an import's barrier, resolving an anchor on deleted text), and
        // that part must carry the origin and message too. After such a
        // commit the rest waits in a fresh transaction for the final one.
        // An empty final commit drops the options, so none leak into the
        // next write.
        self.doc.set_next_commit_options(options.clone());
        let ok = job.run(&self.doc);
        self.doc.commit_with(options);
        // The version just before an Agent write, so it can be undone.
        let before = before.encode();
        let extras = Extras {
            pre_label: origin
                .is_agent()
                .then(|| (before.clone(), origin.to_string())),
            settlement: agent.map(|a| (a, before)),
            remote: None,
        };
        let committed = self.persist(origin, extras)?;
        if !ok {
            log::error!("{}: a {origin} write panicked", self.doc_id);
        }
        Ok(committed)
    }

    fn import(&mut self, origin: &Origin, bytes: &[u8]) -> Result<Imported> {
        self.settle()?;
        if let Some(validate) = self.lib.options.validate_import.clone() {
            let verdict = std::panic::catch_unwind(AssertUnwindSafe(|| {
                validate(&self.doc_id, &self.doc, bytes)
            }));
            // A validator must only read; whatever it wrote anyway is
            // stored apart, as any write outside the holder.
            self.absorb_outside()?;
            match verdict {
                Ok(verdict) => verdict?,
                Err(_) => {
                    log::error!("{}: the import validator panicked", self.doc_id);
                    return Err(StoreError::invalid(
                        "import",
                        "the import validator panicked; nothing was imported",
                    ));
                }
            }
        }
        let status = self.doc.import_with(bytes, &origin.to_string())?;
        self.import_since_idle = true;
        // Everything in a blob from the server is on the server, including
        // operations this device already had (a shared genesis, say).
        let remote = (*origin == Origin::Sync).then(|| {
            let mut vv = LoroDoc::decode_import_blob_meta(bytes, false)
                .map(|m| m.partial_end_vv)
                .unwrap_or_default();
            for (peer, (_, end)) in status.success.iter() {
                let known = vv.get(peer).copied().unwrap_or(0);
                vv.insert(*peer, known.max(*end));
            }
            vv
        });
        let committed = self.persist(
            origin,
            Extras {
                remote,
                ..Extras::default()
            },
        )?;
        Ok(Imported { status, committed })
    }

    /// Append everything since the last append as one row (with any history
    /// labels due, in the same transaction), then deliver the buffered
    /// events. On failure nothing advances: the operations stay in memory and
    /// go out with the next append, and their events wait for it.
    fn persist(&mut self, origin: &Origin, extras: Extras) -> Result<Committed> {
        let result = self.append(origin, extras.clone());
        match &result {
            Ok(_) => self.unpersisted = None,
            Err(e) => {
                log::error!("{}: appending a {origin} update failed: {e}", self.doc_id);
                if self.unpersisted.is_none() {
                    self.unpersisted = Some((origin.clone(), extras));
                }
            }
        }
        result
    }

    fn append(&mut self, origin: &Origin, extras: Extras) -> Result<Committed> {
        let vv = self.doc.oplog_vv();
        let frontiers = self.doc.oplog_frontiers();
        if vv == self.last_vv {
            return Ok(Committed {
                seq: None,
                bytes: 0,
                frontiers,
            });
        }
        let bytes = self.doc.export(ExportMode::updates(&self.last_vv))?;
        let now = now_ms();
        let seq = self.next_seq;
        let after = frontiers.encode();
        let settled = extras.settlement.is_some();
        let mut labels_to_write: Vec<(Vec<u8>, String)> = Vec::new();
        let mut latest = self.latest_label.clone();
        // One label per Agent turn: the version before its first write.
        if let Some((f, label)) = extras.pre_label
            && latest.as_ref().is_none_or(|(_, _, l)| *l != label)
        {
            latest = Some((now, f.clone(), label.clone()));
            labels_to_write.push((f, label));
        }
        if history::records_periodic(origin)
            && history::periodic_due(latest.as_ref().map(|(ts, _, _)| *ts), now)
            && latest.as_ref().is_none_or(|(_, lf, _)| *lf != after)
        {
            latest = Some((now, after.clone(), labels::PERIODIC.to_string()));
            labels_to_write.push((after.clone(), labels::PERIODIC.to_string()));
        }
        if let Some(faults) = &self.lib.options.append_faults
            && faults
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
                .is_ok()
        {
            return Err(StoreError::Io(std::io::Error::other(
                "injected append fault",
            )));
        }
        {
            let conn = self.lib.writer();
            let tx = conn.unchecked_transaction()?;
            record_append(&tx, &self.doc_id, seq, &bytes, origin, now, &vv, &frontiers)?;
            if let Some(checkpoint) = &self.lib.options.append_checkpoint {
                checkpoint();
            }
            if let Some(pause) = self.lib.options.append_pause {
                std::thread::sleep(pause);
            }
            for (f, label) in &labels_to_write {
                history::insert(&tx, &self.doc_id, self.book_doc.as_deref(), f, label, now)?;
            }
            if let Some((agent, before)) = &extras.settlement {
                tx.prepare_cached(
                    "INSERT INTO agent_settlement
                       (session, turn, call, doc_id, seq, before_frontiers, after_frontiers, summary, ts)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )?
                .execute(params![
                    agent.session,
                    agent.turn,
                    agent.call,
                    &*self.doc_id,
                    seq,
                    before,
                    after,
                    agent.summary,
                    now
                ])?;
            }
            if let Some(remote) = &extras.remote {
                merge_remote_vv(&tx, &self.doc_id, remote)?;
            }
            if !labels_to_write.is_empty() {
                history::thin(&tx, &self.doc_id, now)?;
            }
            tx.commit()?;
        }
        self.next_seq += 1;
        self.last_vv = vv;
        self.latest_label = latest;
        self.labelled_writes |= history::records_periodic(origin);
        self.counters.commits.fetch_add(1, Ordering::Relaxed);
        self.counters
            .pending_updates
            .fetch_add(1, Ordering::Relaxed);
        self.counters
            .pending_bytes
            .fetch_add(bytes.len(), Ordering::Relaxed);
        self.index_dirty = true;
        self.deliver(seq, origin, &frontiers);
        if settled {
            self.lib.publish(&StoreEvent::Local(LocalChange::new(
                "agent_settlement",
                &*self.doc_id,
                LocalChangeKind::Insert,
            )));
        }
        Ok(Committed {
            seq: Some(seq),
            bytes: bytes.len(),
            frontiers,
        })
    }

    fn deliver(&mut self, seq: i64, origin: &Origin, frontiers: &Frontiers) {
        let buffered = std::mem::take(&mut *self.buffer.lock().unwrap_or_else(|e| e.into_inner()));
        if buffered.is_empty() {
            return;
        }
        let triggered_by = buffered
            .last()
            .map(|(t, _)| *t)
            .unwrap_or(EventTriggerKind::Local);
        let event = Arc::new(DocEvent {
            doc_id: self.doc_id.clone(),
            seq,
            origin: origin.clone(),
            triggered_by,
            frontiers: frontiers.clone(),
            changes: buffered.into_iter().flat_map(|(_, c)| c).collect(),
        });
        let listeners: Vec<Listener> = self
            .listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .list
            .iter()
            .map(|(_, l)| l.clone())
            .collect();
        for listener in listeners {
            if std::panic::catch_unwind(AssertUnwindSafe(|| listener(&event))).is_err() {
                log::error!("{}: an event listener panicked", self.doc_id);
            }
        }
        // The deriver gets the diffs since its last run (or starts over once
        // too many piled up).
        if self.lib.options.deriver.is_some()
            && let Some(pending) = &mut self.changes_since_index
        {
            if pending.len() + event.changes.len() > MAX_PENDING_CHANGES {
                self.changes_since_index = None;
            } else {
                pending.extend(event.changes.iter().cloned());
            }
        }
        self.lib.publish(&StoreEvent::Doc(event));
    }

    fn compact(&mut self) -> Result<Option<CompactStats>> {
        // A snapshot must not cover operations no row holds yet.
        self.settle()?;
        if self.pending().0 == 0 {
            return Ok(None);
        }
        let upto = self.next_seq - 1;
        let parts = export_snapshot(&self.doc)?;
        let stats = store_snapshot(
            &self.lib.writer(),
            &self.doc_id,
            &parts,
            upto,
            self.lib.options.compaction_pause,
        )?;
        self.counters.compactions.fetch_add(1, Ordering::Relaxed);
        self.counters.pending_updates.store(0, Ordering::Relaxed);
        self.counters.pending_bytes.store(0, Ordering::Relaxed);
        Ok(Some(stats))
    }

    fn label_now(&mut self, label: &str) -> Result<bool> {
        self.settle()?;
        let frontiers = self.doc.oplog_frontiers().encode();
        // Never the same version twice in a row: neither after this
        // holder's own label nor after one written beside it
        // (`Library::label_at` while the document is open).
        let same = |l: &Option<(i64, Vec<u8>, String)>| {
            l.as_ref().is_some_and(|(_, f, _)| *f == frontiers)
        };
        if same(&self.latest_label) || same(&history::latest(&self.lib.reader(), &self.doc_id)?) {
            return Ok(false);
        }
        let now = now_ms();
        {
            let conn = self.lib.writer();
            let tx = conn.unchecked_transaction()?;
            history::insert(
                &tx,
                &self.doc_id,
                self.book_doc.as_deref(),
                &frontiers,
                label,
                now,
            )?;
            history::thin(&tx, &self.doc_id, now)?;
            tx.commit()?;
        }
        self.latest_label = Some((now, frontiers, label.to_string()));
        Ok(true)
    }

    fn on_close(&mut self) {
        if let Err(e) = self.settle() {
            log::error!(
                "{}: final append failed; edits since are lost: {e}",
                self.doc_id
            );
            return;
        }
        if self.labelled_writes
            && let Err(e) = self.label_now(labels::CLOSE)
        {
            log::warn!("{}: close label failed: {e}", self.doc_id);
        }
        if self.pending().0 >= self.lib.options.compaction.on_close_min_updates.max(1)
            && let Err(e) = self.compact()
        {
            log::warn!("{}: compaction on close failed: {e}", self.doc_id);
        }
    }
}

#[allow(dead_code)]
fn assert_send_sync() {
    fn is<T: Send + Sync>() {}
    is::<DocHandle>();
}
