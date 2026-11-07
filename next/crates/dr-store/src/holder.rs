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
//! deletes the updates it covers in one transaction.

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;

use loro::event::{Diff, DiffEvent, MapDelta};
use loro::{
    CommitOptions, ContainerID, EventTriggerKind, ExportMode, Frontiers, ImportStatus, Index,
    LoroDoc, Subscription, VersionVector,
};
use rusqlite::params;

use crate::error::{Result, StoreError};
use crate::history::{self, labels};
use crate::library::{CompactStats, Inner, LoadStats, export_snapshot, store_snapshot};
use crate::now_ms;
use crate::origin::Origin;

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
        job: Box<dyn WriteJob>,
    },
    Import {
        origin: Origin,
        bytes: Vec<u8>,
        done: Sender<Result<Imported>>,
    },
    Run(Box<dyn FnOnce(&LoroDoc) + Send>),
    Compact(Sender<Result<Option<CompactStats>>>),
    Label {
        label: String,
        done: Sender<Result<bool>>,
    },
    Close,
}

pub(crate) struct Shared {
    doc_id: Arc<str>,
    doc: LoroDoc,
    tx: Sender<Msg>,
    thread: Mutex<Option<JoinHandle<()>>>,
    listeners: Arc<Mutex<Listeners>>,
    counters: Arc<Counters>,
}

impl Drop for Shared {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Close);
        let thread = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(thread) = thread
            && thread.thread().id() != std::thread::current().id()
        {
            let _ = thread.join();
        }
    }
}

/// A handle to an open document. Clones share one holder; the holder closes
/// (label, compaction) when the last handle is dropped or [`Self::close`]d.
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

    /// The open document, for reading from any thread (layout, queries).
    /// **Never edit it directly**: edits belong in [`Self::write`]. A direct
    /// edit is committed separately with origin [`Origin::Outside`] before
    /// the next queued operation, so it cannot join another origin's commit,
    /// but one made while a queued write runs would. Reads may observe a
    /// write that is still in progress; use [`Self::read`] for a consistent
    /// view.
    pub fn doc(&self) -> &LoroDoc {
        &self.shared.doc
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
        let (done, rx) = mpsc::channel();
        self.send(Msg::Write {
            origin,
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
    /// view. `f` must not edit.
    pub fn read<R, F>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&LoroDoc) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (done, rx) = mpsc::channel();
        self.send(Msg::Run(Box::new(move |doc| {
            let _ = done.send(f(doc));
        })))?;
        rx.recv()
            .map_err(|_| StoreError::Closed(self.shared.doc_id.to_string()))
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

    /// Close this handle. The holder stops (labelling and compacting) once
    /// no other clone is left; this call waits for that if it was the last.
    pub fn close(self) {
        drop(self);
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
    import_since_idle: bool,
    /// The origin of operations whose append failed. They are retried on
    /// their own before anything else runs, so a row never mixes origins.
    unpersisted: Option<Origin>,
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
        import_since_idle: false,
        unpersisted: None,
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
            doc,
            tx,
            thread: Mutex::new(Some(thread)),
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
        let idle = self.lib.options.compaction.idle;
        loop {
            let msg = if self.maintenance_due() {
                match rx.recv_timeout(idle) {
                    Ok(msg) => msg,
                    Err(RecvTimeoutError::Timeout) => {
                        self.idle_maintenance();
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match rx.recv() {
                    Ok(msg) => msg,
                    Err(_) => break,
                }
            };
            match msg {
                Msg::Write { origin, mut job } => {
                    let result = self.write(&origin, &mut *job);
                    job.finish(result);
                }
                Msg::Import {
                    origin,
                    bytes,
                    done,
                } => {
                    let _ = done.send(self.import(&origin, &bytes));
                }
                Msg::Run(f) => {
                    if self.retry_unpersisted().is_ok() {
                        self.absorb_outside();
                    }
                    f(&self.doc);
                    if self.retry_unpersisted().is_ok() {
                        self.absorb_outside();
                    }
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

    /// Commit and persist operations someone wrote outside the holder, so
    /// they never join the next origin's commit.
    fn absorb_outside(&mut self) {
        if self.doc.get_pending_txn_len() == 0 {
            return;
        }
        log::error!(
            "{}: {} operations were written outside the document holder",
            self.doc_id,
            self.doc.get_pending_txn_len()
        );
        self.doc
            .commit_with(CommitOptions::new().origin(&Origin::Outside.to_string()));
        self.counters.outside.fetch_add(1, Ordering::Relaxed);
        if let Err(e) = self.persist(&Origin::Outside, None) {
            log::error!("{}: persisting outside operations failed: {e}", self.doc_id);
        }
    }

    /// Append operations whose earlier append failed, under their own origin.
    fn retry_unpersisted(&mut self) -> Result<()> {
        if let Some(origin) = self.unpersisted.clone() {
            self.persist(&origin, None)?;
        }
        Ok(())
    }

    fn write(&mut self, origin: &Origin, job: &mut dyn WriteJob) -> Result<Committed> {
        // Refuse new edits while earlier ones cannot be stored.
        self.retry_unpersisted()?;
        self.absorb_outside();
        let before = self.doc.oplog_frontiers();
        let ok = job.run(&self.doc);
        let mut options = CommitOptions::new().origin(&origin.to_string());
        if let Some(message) = origin.commit_message() {
            options = options.commit_msg(&message);
        }
        self.doc.commit_with(options);
        // The version just before an Agent write, so it can be undone.
        let pre_label = origin
            .is_agent()
            .then(|| (before.encode(), origin.to_string()));
        let committed = self.persist(origin, pre_label)?;
        if !ok {
            log::error!("{}: a {origin} write panicked", self.doc_id);
        }
        Ok(committed)
    }

    fn import(&mut self, origin: &Origin, bytes: &[u8]) -> Result<Imported> {
        self.retry_unpersisted()?;
        self.absorb_outside();
        let status = self.doc.import_with(bytes, &origin.to_string())?;
        self.import_since_idle = true;
        let committed = self.persist(origin, None)?;
        Ok(Imported { status, committed })
    }

    /// Append everything since the last append as one row (with any history
    /// labels due, in the same transaction), then deliver the buffered
    /// events. On failure nothing advances: the operations stay in memory and
    /// go out with the next append, and their events wait for it.
    fn persist(
        &mut self,
        origin: &Origin,
        pre_label: Option<(Vec<u8>, String)>,
    ) -> Result<Committed> {
        let result = self.append(origin, pre_label);
        match &result {
            Ok(_) => self.unpersisted = None,
            Err(e) => {
                log::error!("{}: appending a {origin} update failed: {e}", self.doc_id);
                if self.unpersisted.is_none() {
                    self.unpersisted = Some(origin.clone());
                }
            }
        }
        result
    }

    fn append(
        &mut self,
        origin: &Origin,
        pre_label: Option<(Vec<u8>, String)>,
    ) -> Result<Committed> {
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
        let mut labels_to_write: Vec<(Vec<u8>, String)> = Vec::new();
        let mut latest = self.latest_label.clone();
        // One label per Agent turn: the version before its first write.
        if let Some((f, label)) = pre_label
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
            labels_to_write.push((after, labels::PERIODIC.to_string()));
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
            tx.prepare_cached(
                "INSERT INTO loro_update (doc_id, seq, bytes, origin, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?
            .execute(params![&*self.doc_id, seq, bytes, origin.to_string(), now])?;
            for (f, label) in &labels_to_write {
                history::insert(&tx, &self.doc_id, f, label, now)?;
            }
            if !labels_to_write.is_empty() {
                history::thin(&tx, &self.doc_id, now)?;
            }
            tx.commit()?;
        }
        self.next_seq += 1;
        self.last_vv = vv;
        self.latest_label = latest;
        self.counters.commits.fetch_add(1, Ordering::Relaxed);
        self.counters
            .pending_updates
            .fetch_add(1, Ordering::Relaxed);
        self.counters
            .pending_bytes
            .fetch_add(bytes.len(), Ordering::Relaxed);
        self.deliver(seq, origin, &frontiers);
        Ok(Committed {
            seq: Some(seq),
            bytes: bytes.len(),
            frontiers,
        })
    }

    fn deliver(&self, seq: i64, origin: &Origin, frontiers: &Frontiers) {
        let buffered = std::mem::take(&mut *self.buffer.lock().unwrap_or_else(|e| e.into_inner()));
        if buffered.is_empty() {
            return;
        }
        let triggered_by = buffered
            .last()
            .map(|(t, _)| *t)
            .unwrap_or(EventTriggerKind::Local);
        let event = DocEvent {
            doc_id: self.doc_id.clone(),
            seq,
            origin: origin.clone(),
            triggered_by,
            frontiers: frontiers.clone(),
            changes: buffered.into_iter().flat_map(|(_, c)| c).collect(),
        };
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
    }

    fn compact(&mut self) -> Result<Option<CompactStats>> {
        // A snapshot must not cover operations no row holds yet.
        self.retry_unpersisted()?;
        self.absorb_outside();
        if self.unpersisted.is_some() {
            return Err(StoreError::invalid(
                "compaction",
                "updates are not stored yet",
            ));
        }
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
        self.retry_unpersisted()?;
        self.absorb_outside();
        let frontiers = self.doc.oplog_frontiers().encode();
        if self
            .latest_label
            .as_ref()
            .is_some_and(|(_, f, _)| *f == frontiers)
        {
            return Ok(false);
        }
        let now = now_ms();
        {
            let conn = self.lib.writer();
            let tx = conn.unchecked_transaction()?;
            history::insert(&tx, &self.doc_id, &frontiers, label, now)?;
            history::thin(&tx, &self.doc_id, now)?;
            tx.commit()?;
        }
        self.latest_label = Some((now, frontiers, label.to_string()));
        Ok(true)
    }

    fn on_close(&mut self) {
        if let Err(e) = self.retry_unpersisted() {
            log::error!(
                "{}: final append failed; edits since are lost: {e}",
                self.doc_id
            );
            return;
        }
        self.absorb_outside();
        if self.counters.commits.load(Ordering::Relaxed) > 0
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
