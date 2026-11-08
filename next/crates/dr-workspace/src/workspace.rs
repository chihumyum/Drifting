//! The workspace: the open library, the open books and prose documents, the
//! event bus, the journal, and the entry points every caller uses.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use dr_doc::book::{BookReader, BorrowedBook, Collection};
use dr_doc::prose::{BorrowedProse, ProseReader};
use dr_model::DocId;
use dr_model::id::BookId;
use dr_store::{
    DocHandle, Library, LibraryOptions, LibrarySubscription, OpenDoc, StoreError, StoreEvent,
};
use serde_json::Value;

use crate::actor::Actor;
use crate::cache::BookCache;
use crate::cx::{Cx, Faults, Gate, Invocation, Outcome};
use crate::error::{Result, WsError};
use crate::events::{
    self, BookChanged, Bus, EntityChange, ProseChanged, Removed, RemovedEntity, Subscription,
    WsEvent, book_changes, prose_ranges, touched_blocks_near,
};
use crate::guard::{Guards, Observation, WritePreconditions};
use crate::holder::{self, lock};
use crate::journal::{Journal, JournalEntry};
use crate::nav::NavTarget;
use crate::registry::{Access, Op, Spec, registry};

/// Options of a workspace.
#[derive(Clone)]
pub struct WorkspaceOptions {
    /// Prose documents kept open at once (least recently used close first).
    pub max_open_prose: usize,
    /// Test hook: fail named points of the write path.
    #[doc(hidden)]
    pub faults: Option<Arc<Faults>>,
}

impl Default for WorkspaceOptions {
    fn default() -> Self {
        Self {
            max_open_prose: 16,
            faults: None,
        }
    }
}

/// `LibraryOptions` with the workspace's hooks: dr-doc's style configuration
/// on every Loro document and dr-index's deriver for the derived index
/// (paragraphs, outline, references and dr-text's word counts, from Loro
/// diffs).
pub fn library_options(app_version: &str) -> LibraryOptions {
    let mut o = LibraryOptions::new(app_version);
    dr_index::attach(&mut o);
    o.validate_import = Some(Arc::new(|id, doc, bytes| {
        if matches!(DocId::parse(id), Ok(DocId::Conversation(_))) {
            dr_doc::conversation::validate_update(doc, bytes).map_err(|e| StoreError::Invalid {
                what: "conversation import",
                value: e.to_string(),
            })?;
        }
        Ok(())
    }));
    o
}

/// An open book: its holder, a reader sharing the holder's document, and
/// the query caches.
pub(crate) struct BookSlot {
    pub book: BookId,
    pub handle: DocHandle,
    pub reader: BookReader,
    pub cache: BookCache,
}

/// An open prose document: its holder and a reader sharing its document.
pub(crate) struct ProseSlot {
    pub doc: DocId,
    pub book: Option<BookId>,
    pub handle: DocHandle,
    pub reader: ProseReader,
}

/// dr-doc's deterministic background repair of a book document, as one
/// write with origin `repair` when there is anything to repair (cheap to
/// ask: dr-doc's `needs_repair`). Run when a book opens and after remote
/// updates arrive.
pub(crate) fn repair_book(slot: &BookSlot) -> Result<()> {
    if !slot.reader.view().needs_repair() {
        return Ok(());
    }
    let book = slot.book.clone();
    holder::write(&slot.handle, dr_store::Origin::Repair, None, move |doc| {
        let b = BorrowedBook::new(doc, &book)?;
        let plan = b.view().repair_plan();
        if !plan.is_empty() {
            b.txn().apply_repair(&plan)?;
        }
        Ok(())
    })
}

/// dr-doc's block-id repair of a prose document (duplicate ids a merge can
/// make), as one write with origin `repair`; nothing is stored when there is
/// nothing to repair.
pub(crate) fn repair_prose(slot: &ProseSlot) -> Result<()> {
    let doc_id = slot.doc.clone();
    holder::write(&slot.handle, dr_store::Origin::Repair, None, move |doc| {
        BorrowedProse::new(doc, &doc_id)?.txn().repair_block_ids()?;
        Ok(())
    })
}

#[derive(Default)]
struct ProseSlots {
    tick: u64,
    map: HashMap<DocId, (u64, Arc<ProseSlot>)>,
}

pub(crate) struct Inner {
    pub lib: Library,
    pub options: WorkspaceOptions,
    books: Mutex<HashMap<BookId, Arc<BookSlot>>>,
    gates: Mutex<HashMap<BookId, Arc<Gate>>>,
    prose: Mutex<ProseSlots>,
    pub bus: Bus,
    pub journal: Journal,
    pub library_gate: Arc<Gate>,
    subscription: Mutex<Option<LibrarySubscription>>,
    /// Whether each template document held a template when last seen (by
    /// `storyline.list` / `category.list`, or after its last commit): a
    /// commit that flips it is reported as a change to its owner
    /// ([`Inner::template_flip`]).
    templates: Mutex<HashMap<DocId, bool>>,
    /// The author's `editor.auto_entity_links` (`crate::autolink`).
    auto_links: std::sync::atomic::AtomicBool,
}

/// Listen to the library's events (the caches and the bus follow them),
/// holding the workspace weakly.
fn subscribe(inner: &Arc<Inner>) {
    let weak: Weak<Inner> = Arc::downgrade(inner);
    let sub = inner.lib.subscribe(move |e| {
        if let Some(inner) = weak.upgrade() {
            inner.on_store_event(e);
        }
    });
    *lock(&inner.subscription) = Some(sub);
}

/// Why [`Workspace::try_shutdown`] did not close the library, with the
/// workspace handed back.
pub struct ShutdownRefused {
    pub error: WsError,
    /// The workspace, open as before. `None` only when the library refused
    /// to close and a workspace could not be opened over it again (its
    /// journal could not be read); the library is then dropped.
    pub workspace: Option<Workspace>,
}

impl std::fmt::Debug for ShutdownRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShutdownRefused")
            .field("error", &self.error)
            .field("workspace", &self.workspace.is_some())
            .finish()
    }
}

/// The command and query layer over one library. Cheap to clone.
#[derive(Clone)]
pub struct Workspace {
    pub(crate) inner: Arc<Inner>,
}

impl Workspace {
    /// A workspace over `lib`. Open the library with [`library_options`] so
    /// documents get dr-doc's configuration and the derived index its
    /// deriver.
    pub fn open(lib: Library, options: WorkspaceOptions) -> Result<Self> {
        let inner = Arc::new(Inner {
            journal: Journal::open(lib.clone())?,
            lib,
            options,
            books: Mutex::default(),
            gates: Mutex::default(),
            prose: Mutex::default(),
            bus: Bus::default(),
            library_gate: Arc::default(),
            subscription: Mutex::new(None),
            templates: Mutex::new(HashMap::new()),
            auto_links: std::sync::atomic::AtomicBool::new(true),
        });
        subscribe(&inner);
        Ok(Self { inner })
    }

    /// Open (or create) the library in `root` with the workspace's hooks.
    pub fn open_dir(root: impl AsRef<Path>, app_version: &str) -> Result<Self> {
        let lib = Library::open(root.as_ref(), library_options(app_version))?;
        Self::open(lib, WorkspaceOptions::default())
    }

    /// Whether commands link names in the text they write (the author's
    /// `editor.auto_entity_links`, on by default; see [`crate::autolink`]).
    pub fn auto_links(&self) -> bool {
        self.inner
            .auto_links
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The shell passes the author's setting on whenever it changes.
    pub fn set_auto_links(&self, on: bool) {
        self.inner
            .auto_links
            .store(on, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn library(&self) -> &Library {
        &self.inner.lib
    }

    /// This device's writing-day key (`writing_day.record`), when the
    /// library was opened with F2's `Device` (`LibraryOptions::device`).
    pub fn writing_device(&self) -> Option<String> {
        self.inner
            .lib
            .options()
            .device
            .as_ref()
            .map(|d| d.writing_device_key())
    }

    /// Close every open document and wait for their holders (the library
    /// stays open; close it with `Library::close`).
    pub fn close(&self) {
        self.close_slots();
        lock(&self.inner.subscription).take();
    }

    /// Close the open documents nobody else holds; (closed, still in use).
    fn close_slots(&self) -> (usize, usize) {
        let books: Vec<Arc<BookSlot>> = lock(&self.inner.books).drain().map(|(_, s)| s).collect();
        let prose: Vec<Arc<ProseSlot>> = lock(&self.inner.prose)
            .map
            .drain()
            .map(|(_, (_, s))| s)
            .collect();
        let (mut closed, mut kept) = (0, 0);
        let handles = books
            .into_iter()
            .map(|s| Arc::try_unwrap(s).map(|s| s.handle).map_err(drop))
            .chain(
                prose
                    .into_iter()
                    .map(|s| Arc::try_unwrap(s).map(|s| s.handle).map_err(drop)),
            );
        for h in handles {
            match h {
                Ok(h) => {
                    h.close();
                    closed += 1;
                }
                Err(_) => kept += 1,
            }
        }
        (closed, kept)
    }

    /// Before the app quits (the shell registers it with its
    /// `quit::before_quit`). Nothing is lost without it — every command
    /// returned once durable — but it brings the derived index of each open
    /// document up to date and lets each holder finish its queue, write its
    /// closing history label and compact, so the next start has nothing to
    /// rebuild. A document still in use (an editing session) is indexed but
    /// stays open. The workspace stays usable: a later command opens what it
    /// needs again.
    pub fn before_quit(&self) -> QuitReport {
        let started = std::time::Instant::now();
        let mut report = QuitReport::default();
        let handles: Vec<DocHandle> = {
            let books = lock(&self.inner.books);
            let prose = lock(&self.inner.prose);
            books
                .values()
                .map(|s| s.handle.clone())
                .chain(prose.map.values().map(|(_, s)| s.handle.clone()))
                .collect()
        };
        for h in &handles {
            if let Err(e) = h.reindex_now() {
                log::warn!("{}: indexing before quit failed: {e}", h.doc_id());
            }
        }
        drop(handles);
        let (closed, kept) = self.close_slots();
        report.closed = closed;
        report.in_use = kept;
        report.ms = started.elapsed().as_secs_f64() * 1e3;
        report
    }

    /// Close every document, then the library itself (this must be the last
    /// clone of the workspace). The workspace is gone either way;
    /// [`Self::try_shutdown`] hands it back on refusal.
    pub fn shutdown(self) -> Result<()> {
        self.try_shutdown().map_err(|r| r.error)
    }

    /// [`Self::shutdown`], but a refusal hands the workspace back, as
    /// dr-store's `Library::try_close` hands the library back: still open
    /// over the same library (its documents closed and reopened when next
    /// asked for, its listener subscribed again, the author's setting
    /// kept), so a library swap that cannot close the old library can carry
    /// on with it.
    pub fn try_shutdown(self) -> std::result::Result<(), ShutdownRefused> {
        self.close();
        // An event being delivered on a holder or index thread holds the
        // workspace for a moment (the listener upgrades its weak reference);
        // the subscription is gone, so wait for those to finish.
        let mut arc = self.inner;
        let mut tries = 0;
        let inner = loop {
            match Arc::try_unwrap(arc) {
                Ok(inner) => break inner,
                Err(back) if tries < 2000 => {
                    arc = back;
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(back) => {
                    subscribe(&back);
                    return Err(ShutdownRefused {
                        error: WsError::Internal("other clones of the workspace are alive".into()),
                        workspace: Some(Workspace { inner: back }),
                    });
                }
            }
        };
        let (options, auto_links) = (
            inner.options.clone(),
            inner.auto_links.load(std::sync::atomic::Ordering::Relaxed),
        );
        let mut lib = inner.lib.clone();
        drop(inner);
        // The library refused: a workspace over it again.
        let hand_back = |lib: Library, error: WsError| {
            let workspace = match Workspace::open(lib, options.clone()) {
                Ok(ws) => {
                    ws.set_auto_links(auto_links);
                    Some(ws)
                }
                Err(e) => {
                    log::error!(
                        "the workspace could not be opened again after a refused close: {e}"
                    );
                    None
                }
            };
            ShutdownRefused { error, workspace }
        };
        // dr-store's background index rebuild (started when the library
        // opened) briefly holds a handle on a document it finds open; a close
        // that lands then is refused with the library handed back. Try again
        // for up to a second.
        for _ in 0..200 {
            match lib.try_close() {
                Ok(()) => return Ok(()),
                Err(refused) if matches!(refused.error, StoreError::DocumentsOpen(_)) => {
                    lib = refused.library;
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(refused) => return Err(hand_back(refused.library, refused.error.into())),
            }
        }
        match lib.try_close() {
            Ok(()) => Ok(()),
            Err(refused) => Err(hand_back(refused.library, refused.error.into())),
        }
    }

    /// Run a command or query by type.
    pub fn run<O: Op>(&self, actor: &Actor, input: O::Input) -> Result<Outcome<O::Output>> {
        let spec = registry()
            .get(O::NAME)
            .ok_or_else(|| WsError::UnknownCommand(O::NAME.into()))?;
        let cx = Cx::new(self, actor, spec);
        let out = O::run(&cx, input);
        self.finish(cx, out, true)
    }

    /// Run a command or query by name with JSON input (Agent tools, MCP, the
    /// dev CLI). The result is the [`Outcome`] as JSON.
    pub fn call(&self, actor: &Actor, name: &str, input: Value) -> Result<Value> {
        let o = self.call_outcome(actor, name, input, true)?;
        serde_json::to_value(o).map_err(|e| WsError::Internal(e.to_string()))
    }

    /// Read a book or prose document and its committed version together.
    /// Deep JSON is a canonical observation, not a replacement prose format.
    pub fn observe(&self, id: &str) -> Result<Observation> {
        let doc = DocId::parse(id).map_err(|e| WsError::Invalid(e.to_string()))?;
        let handle = match &doc {
            DocId::Book(book) => self.book_slot(book)?.handle.clone(),
            _ if doc.profile().is_some() => self.prose_slot(&doc)?.handle.clone(),
            _ => {
                return Err(WsError::Invalid(
                    "observe requires a book or prose document".into(),
                ));
            }
        };
        let id = doc.to_string();
        handle.read(move |doc| -> Result<Observation> {
            Ok(Observation {
                doc: id,
                version: crate::naming::frontiers_hex(&doc.oplog_frontiers()),
                value: serde_json::to_value(doc.get_deep_value())
                    .map_err(|e| WsError::Internal(e.to_string()))?,
            })
        })?
    }

    /// Run a registered call with document CAS checked inside each write job.
    /// A later failure can follow earlier settled document writes. Never retry
    /// this whole call automatically. Library creation/purge and device-local
    /// recent-page bookkeeping have no document CAS and are refused here.
    /// `history.restore_point` also labels history before its document write;
    /// it needs an owner-provided atomic label-and-write hook before use here.
    pub fn call_guarded(
        &self,
        actor: &Actor,
        name: &str,
        input: Value,
        preconditions: WritePreconditions,
    ) -> Result<Value> {
        let spec = registry()
            .get(name)
            .ok_or_else(|| WsError::UnknownCommand(name.into()))?;
        let guards = Guards::parse(preconditions)?;
        if spec.name == "history.restore_point" {
            return Err(WsError::Invalid(
                "guarded history restore requires atomic label-and-write support".into(),
            ));
        }
        if spec.access == Access::Write
            && (spec.concurrency == crate::registry::Concurrency::Library
                || spec.name == "recent.touch")
        {
            return Err(WsError::Invalid(
                "guarded calls do not support library-level or device-local writes".into(),
            ));
        }
        let cx = Cx::guarded(self, actor, spec, guards);
        let out = (spec.call)(&cx, input);
        let outcome = self.finish(cx, out, true)?;
        serde_json::to_value(outcome).map_err(|e| WsError::Internal(e.to_string()))
    }

    pub(crate) fn call_outcome(
        &self,
        actor: &Actor,
        name: &str,
        input: Value,
        journal: bool,
    ) -> Result<Outcome<Value>> {
        let spec: &'static Spec = registry()
            .get(name)
            .ok_or_else(|| WsError::UnknownCommand(name.into()))?;
        let cx = Cx::new(self, actor, spec);
        let out = (spec.call)(&cx, input);
        self.finish(cx, out, journal)
    }

    fn finish<T>(&self, cx: Cx<'_>, out: Result<T>, journal: bool) -> Result<Outcome<T>> {
        let spec = cx.spec;
        let actor = cx.actor().clone();
        let faults = cx.faults();
        let done = cx.finish();
        let output = out?;
        let mut row = None;
        let mut undo = done.undo;
        if journal && done.journaled && spec.access == Access::Write && !done.effects.is_empty() {
            // Step 4 of the write order: the local journal row, one SQLite
            // transaction. The document writes are durable already; if this
            // fails the command still succeeded, only without an undo entry.
            let r = faults.check("journal").and_then(|_| {
                self.inner.journal.record(
                    &actor.journal_key(),
                    spec.name,
                    done.book.as_ref().map(|b| b.as_str()),
                    &done.effects,
                    undo.as_deref(),
                )
            });
            match r {
                Ok(seq) => row = Some(seq),
                Err(e) => {
                    log::warn!("{}: journal write failed ({e}); no undo entry", spec.name);
                    undo = None;
                }
            }
        }
        drop(done.leases);
        Ok(Outcome {
            output,
            effects: done.effects,
            undo,
            journal: row,
        })
    }

    /// Undo `actor`'s latest command that has an undo (object level: runs
    /// the inverse commands it declared). `None` when there is nothing.
    pub fn undo(&self, actor: &Actor) -> Result<Option<Outcome<Value>>> {
        let key = actor.journal_key();
        let Some((seq, inverses)) = self.inner.journal.last_undoable(&key)? else {
            return Ok(None);
        };
        let (effects, redo) = self.run_inverses(actor, &inverses)?;
        self.inner.journal.mark_undone(seq, redo.as_deref())?;
        Ok(Some(Outcome {
            output: Value::Null,
            effects,
            undo: redo,
            journal: Some(seq),
        }))
    }

    /// Redo the command `actor` undid last.
    pub fn redo(&self, actor: &Actor) -> Result<Option<Outcome<Value>>> {
        let key = actor.journal_key();
        let Some((seq, redo)) = self.inner.journal.last_redoable(&key)? else {
            return Ok(None);
        };
        let (effects, undo) = self.run_inverses(actor, &redo)?;
        self.inner.journal.mark_redone(seq, undo.as_deref())?;
        Ok(Some(Outcome {
            output: Value::Null,
            effects,
            undo,
            journal: Some(seq),
        }))
    }

    fn run_inverses(
        &self,
        actor: &Actor,
        inverses: &[Invocation],
    ) -> Result<(Vec<crate::cx::Effect>, Option<Vec<Invocation>>)> {
        let mut effects = Vec::new();
        let mut back: Vec<Vec<Invocation>> = Vec::new();
        let mut reversible = true;
        for inv in inverses {
            let o = self.call_outcome(actor, &inv.command, inv.input.clone(), false)?;
            effects.extend(o.effects);
            match o.undo {
                Some(u) => back.push(u),
                None => reversible = false,
            }
        }
        back.reverse();
        Ok((
            effects,
            reversible.then(|| back.into_iter().flatten().collect()),
        ))
    }

    /// The journal, newest first (`actor`: one actor's key, see
    /// [`Actor::journal_key`]).
    pub fn journal(&self, actor: Option<&str>, limit: usize) -> Result<Vec<JournalEntry>> {
        self.inner.journal.entries(actor, limit)
    }

    /// Listen to every persisted change, as fine-grained events.
    pub fn subscribe(&self, f: impl Fn(&WsEvent) + Send + Sync + 'static) -> Subscription {
        events::subscribe(&self.inner.bus, Arc::new(f))
    }

    /// Import remote updates of `doc_id` (sync) through its holder, then run
    /// dr-doc's repair for what a merge can produce (duplicate block ids,
    /// semantic duplicate relations, chapters without a book order). Creates
    /// the document (from its genesis) when it is new here.
    ///
    /// Returns false, writing nothing, when the document or its book was
    /// purged on this device (dr-store's `purged_doc`): a book deleted for
    /// good stays deleted however its updates arrive. Bringing it back on
    /// purpose is `Library::forget_purged_book` first (the sync module's
    /// call, M36).
    pub fn import_remote(
        &self,
        doc_id: &str,
        kind_book: Option<(&str, &str)>,
        bytes: Vec<u8>,
        actor: &Actor,
    ) -> Result<bool> {
        match self.import_remote_inner(doc_id, kind_book, bytes, actor) {
            Ok(()) => Ok(true),
            Err(WsError::Store(StoreError::Purged(_))) => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn import_remote_inner(
        &self,
        doc_id: &str,
        kind_book: Option<(&str, &str)>,
        bytes: Vec<u8>,
        actor: &Actor,
    ) -> Result<()> {
        let doc = DocId::parse(doc_id).map_err(|e| WsError::invalid(e.to_string()))?;
        if let Some((kind, book)) = kind_book {
            self.inner.lib.register(doc_id, kind, Some(book))?;
        }
        // dr-store's own import path: it records what the server has for a
        // sync import, persists, and announces the change (the caches follow
        // the event like any other).
        let origin = actor.store_origin();
        match &doc {
            DocId::Book(book) => {
                let slot = self.book_slot_or_create(book)?;
                slot.handle.import(bytes, origin)?;
                repair_book(&slot)?;
            }
            DocId::Conversation(id) => {
                let genesis = dr_doc::conversation::genesis(id);
                let info = self.inner.lib.doc_info(doc_id)?;
                let handle = self.inner.lib.open_doc(
                    doc_id,
                    OpenDoc::CreateIfMissing {
                        kind: "conversation",
                        book_id: info.as_ref().and_then(|i| i.book_id.as_deref()),
                        genesis: &move |d| {
                            d.import(&genesis).expect("conversation genesis");
                        },
                    },
                )?;
                handle.import(bytes, origin)?;
            }
            _ => {
                let slot = self.prose_slot(&doc)?;
                slot.handle.import(bytes, origin)?;
                repair_prose(&slot)?;
            }
        }
        Ok(())
    }

    // ---- slots ------------------------------------------------------------

    /// Close every open document of `book` and delete everything stored for
    /// it on this device: its documents (updates, snapshots, history,
    /// derived rows), its assets and its journal rows (they can no longer be
    /// undone). Returns (documents, assets) deleted. Refused while one of
    /// its documents is in use (an editor holds it). The caller holds the
    /// book's lease.
    pub(crate) fn purge_book(&self, book: &BookId) -> Result<(usize, usize)> {
        let book_doc = DocId::Book(book.clone()).to_string();
        let mut slots: Vec<Arc<ProseSlot>> = Vec::new();
        {
            let mut p = lock(&self.inner.prose);
            let ids: Vec<DocId> = p
                .map
                .iter()
                .filter(|(_, (_, s))| s.book.as_ref() == Some(book))
                .map(|(d, _)| d.clone())
                .collect();
            for d in ids {
                if let Some((_, s)) = p.map.remove(&d) {
                    slots.push(s);
                }
            }
        }
        let book_slot = lock(&self.inner.books).remove(book);
        // Readers finishing a query may hold a slot for a moment.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut handles = Vec::new();
        for s in slots {
            handles.push(unwrap_slot(s, deadline, |s| s.handle)?);
        }
        if let Some(s) = book_slot {
            handles.push(unwrap_slot(s, deadline, |s| s.handle)?);
        }
        for h in handles {
            h.close();
        }
        let lib = &self.inner.lib;
        let mut docs: Vec<String> = lib
            .docs(Some(book.as_str()), None)?
            .into_iter()
            .map(|d| d.doc_id)
            .filter(|d| *d != book_doc)
            .collect();
        // The book's own document last: until it goes, the book is still in
        // Recently Deleted and a second purge finishes the job.
        docs.push(book_doc);
        let mut purged = 0;
        for d in &docs {
            match lib.purge_doc(d) {
                Ok(()) => purged += 1,
                Err(StoreError::NotFound(_)) => {}
                Err(StoreError::AlreadyOpen(_)) => {
                    return Err(WsError::Conflict(format!("{d} is in use; close it first")));
                }
                Err(e) => return Err(e.into()),
            }
        }
        let mut assets: Vec<String> = lib
            .assets_of_book(book.as_str())?
            .into_iter()
            .map(|a| a.asset_id)
            .collect();
        assets.sort();
        assets.dedup();
        for a in &assets {
            lib.remove_asset(a)?;
        }
        self.inner.journal.forget_book(book.as_str())?;
        crate::commands::recent::forget_book(lib, book.as_str())?;
        lock(&self.inner.gates).remove(book);
        Ok((purged, assets.len()))
    }

    pub(crate) fn book_gate(&self, book: &BookId) -> Arc<Gate> {
        lock(&self.inner.gates)
            .entry(book.clone())
            .or_default()
            .clone()
    }

    pub(crate) fn book_slot(&self, book: &BookId) -> Result<Arc<BookSlot>> {
        self.book_slot_with(book, false)
    }

    pub(crate) fn book_slot_or_create(&self, book: &BookId) -> Result<Arc<BookSlot>> {
        self.book_slot_with(book, true)
    }

    fn book_slot_with(&self, book: &BookId, create: bool) -> Result<Arc<BookSlot>> {
        if let Some(s) = lock(&self.inner.books).get(book).cloned() {
            return Ok(s);
        }
        let doc_id = DocId::Book(book.clone()).to_string();
        let lib = &self.inner.lib;
        let handle = if create {
            let g = dr_doc::book::genesis(book);
            let genesis = move |d: &loro::LoroDoc| {
                if let Err(e) = d.import(&g) {
                    log::error!("book genesis: {e}");
                }
            };
            lib.open_doc(
                &doc_id,
                OpenDoc::CreateIfMissing {
                    kind: "book",
                    book_id: Some(book.as_str()),
                    genesis: &genesis,
                },
            )?
        } else {
            lib.open_doc(&doc_id, OpenDoc::Existing)
                .map_err(|e| match e {
                    StoreError::NotFound(_) => WsError::not_found("book", book.as_str()),
                    e => e.into(),
                })?
        };
        let reader = handle
            .doc()
            .with_doc(|d| BookReader::from_loro(book.clone(), d))?;
        let slot = Arc::new(BookSlot {
            book: book.clone(),
            handle,
            reader,
            cache: BookCache::default(),
        });
        // dr-doc's deterministic background repair, once per open.
        repair_book(&slot)?;
        let slot = lock(&self.inner.books)
            .entry(book.clone())
            .or_insert(slot)
            .clone();
        Ok(slot)
    }

    /// The automatic-link matcher for text written in `doc`: every name of
    /// its book without `doc`'s own entity, as [`crate::autolink::matcher`]
    /// builds it, but kept per book until an element or a node changes (a
    /// build is about 50 ms on the heavy seed). `None` for a document
    /// outside any book.
    pub fn link_matcher(
        &self,
        doc: &DocId,
    ) -> Result<Option<Arc<dr_text::autolink::LinkMatcher<dr_text::autolink::LinkTarget>>>> {
        let Some(book) = self
            .inner
            .lib
            .doc_info(&doc.to_string())?
            .and_then(|i| i.book_id)
            .and_then(|b| BookId::parse(&b).ok())
        else {
            return Ok(None);
        };
        let slot = self.book_slot(&book)?;
        Ok(Some(crate::autolink::book_matcher(&slot, doc)))
    }

    /// The prose documents of `book` open here.
    pub(crate) fn open_prose(&self, book: &BookId) -> Vec<DocId> {
        lock(&self.inner.prose)
            .map
            .iter()
            .filter(|(_, (_, s))| s.book.as_ref() == Some(book))
            .map(|(d, _)| d.clone())
            .collect()
    }

    /// `doc`'s slot if it is open here.
    pub(crate) fn open_prose_slot(&self, doc: &DocId) -> Option<Arc<ProseSlot>> {
        lock(&self.inner.prose).map.get(doc).map(|(_, s)| s.clone())
    }

    /// `doc`'s open slot, or one opened for the caller alone: not kept among
    /// the open documents (so it never pushes the author's out of them) and
    /// without the block-id repair (the callers only read and change
    /// marks). Dropping the last one closes the holder. For commands that
    /// touch many documents once, like the autolink backfill and its undo
    /// (opening through the open-document cache cost 12 ms a document on
    /// the heavy seed, mostly the repair and closing the evicted ones).
    pub(crate) fn prose_slot_passing(&self, doc: &DocId) -> Result<Arc<ProseSlot>> {
        if let Some((_, s)) = lock(&self.inner.prose).map.get(doc) {
            return Ok(s.clone());
        }
        if doc.profile().is_none() {
            return Err(WsError::invalid(format!("{doc} is not a prose document")));
        }
        let lib = &self.inner.lib;
        let id = doc.to_string();
        let info = lib
            .doc_info(&id)?
            .ok_or_else(|| WsError::not_found("document", id.clone()))?;
        // Registered but never written: the full path writes its genesis.
        if lib.head(&id)?.is_none() {
            return self.prose_slot(doc);
        }
        let handle = lib.open_doc(&id, OpenDoc::Existing)?;
        let reader = handle
            .doc()
            .with_doc(|d| ProseReader::from_loro(doc.clone(), d))?;
        Ok(Arc::new(ProseSlot {
            doc: doc.clone(),
            book: info.book_id.as_deref().and_then(|b| BookId::parse(b).ok()),
            handle,
            reader,
        }))
    }

    pub(crate) fn prose_slot(&self, doc: &DocId) -> Result<Arc<ProseSlot>> {
        {
            let mut p = lock(&self.inner.prose);
            p.tick += 1;
            let tick = p.tick;
            if let Some((t, s)) = p.map.get_mut(doc) {
                *t = tick;
                return Ok(s.clone());
            }
        }
        if doc.profile().is_none() {
            return Err(WsError::invalid(format!("{doc} is not a prose document")));
        }
        let lib = &self.inner.lib;
        let id = doc.to_string();
        let info = lib
            .doc_info(&id)?
            .ok_or_else(|| WsError::not_found("document", id.clone()))?;
        let g = dr_doc::prose::genesis(doc);
        let genesis = move |d: &loro::LoroDoc| {
            if let Err(e) = d.import(&g) {
                log::error!("prose genesis: {e}");
            }
        };
        let handle = lib.open_doc(
            &id,
            OpenDoc::CreateIfMissing {
                kind: doc.kind().prefix(),
                book_id: info.book_id.as_deref(),
                genesis: &genesis,
            },
        )?;
        let reader = handle
            .doc()
            .with_doc(|d| ProseReader::from_loro(doc.clone(), d))?;
        let slot = Arc::new(ProseSlot {
            doc: doc.clone(),
            book: info.book_id.as_deref().and_then(|b| BookId::parse(b).ok()),
            handle,
            reader,
        });
        // dr-doc asks for one block-id repair after opening.
        repair_prose(&slot)?;
        let mut p = lock(&self.inner.prose);
        p.tick += 1;
        let tick = p.tick;
        let slot = p.map.entry(doc.clone()).or_insert((tick, slot)).1.clone();
        // Close the least recently used, but never one still in use (a
        // `ProseSession` holds its slot and its undo manager lives on the
        // holder's document).
        while p.map.len() > self.inner.options.max_open_prose.max(1) {
            let Some(oldest) = p
                .map
                .iter()
                .filter(|(d, (_, s))| *d != doc && Arc::strong_count(s) == 1)
                .min_by_key(|(_, (t, _))| *t)
                .map(|(d, _)| d.clone())
            else {
                break;
            };
            p.map.remove(&oldest);
        }
        Ok(slot)
    }

    /// (hits, misses) of a book's query cache.
    #[doc(hidden)]
    pub fn cache_stats(&self, book: &str) -> Option<(u64, u64)> {
        let b = BookId::parse(book).ok()?;
        lock(&self.inner.books).get(&b).map(|s| s.cache.stats())
    }
}

/// What [`Workspace::before_quit`] did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuitReport {
    /// Documents closed (their holders finished, labelled and compacted).
    pub closed: usize,
    /// Documents left open because something still holds them.
    pub in_use: usize,
    pub ms: f64,
}

/// Collections whose entities a tab can show, and how a removal names them.
fn removable(c: Collection) -> bool {
    matches!(
        c,
        Collection::Nodes
            | Collection::Storylines
            | Collection::Elements
            | Collection::Categories
            | Collection::Materials
            | Collection::Meta
    )
}

/// Which of `changes` trashed or purged something a tab can show. Reads the
/// holder's document as it is right after the change (this runs on the
/// holder thread, in its event callback): only the entities whose trash
/// mark changed or that changed whole, one map lookup each.
fn removed_by(slot: &BookSlot, changes: &[EntityChange]) -> Vec<RemovedEntity> {
    let mut out = Vec::new();
    let doc = slot.handle.doc();
    let trashed = |m: &loro::LoroMap| {
        matches!(
            m.get("deleted_at"),
            Some(loro::ValueOrContainer::Value(v)) if !v.is_null()
        )
    };
    for ch in changes.iter().filter(|c| removable(c.collection)) {
        let marks = ch
            .fields
            .as_ref()
            .is_none_or(|f| f.iter().any(|f| f == "deleted_at"));
        if !marks {
            continue;
        }
        if ch.collection == Collection::Meta {
            if trashed(&doc.get_map(Collection::Meta.root())) {
                out.push(RemovedEntity {
                    target: NavTarget::Book,
                    purged: false,
                });
            }
            continue;
        }
        let Some(id) = &ch.id else { continue };
        let state = match doc.get_map(ch.collection.root()).get(id) {
            Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) => {
                if trashed(&m) {
                    Some(false)
                } else {
                    None
                }
            }
            Some(_) => None,
            None => Some(true),
        };
        let Some(purged) = state else { continue };
        let targets: Vec<NavTarget> = match ch.collection {
            Collection::Nodes => {
                let Ok(nid) = dr_model::id::NodeId::parse(id) else {
                    continue;
                };
                let node = if purged {
                    slot.cache.known_node(&nid)
                } else {
                    slot.reader.view().node(&nid)
                };
                match node {
                    Some(n) if n.is_drift() => vec![NavTarget::Idea(nid)],
                    Some(_) => vec![NavTarget::Chapter(nid)],
                    None => vec![NavTarget::Chapter(nid.clone()), NavTarget::Idea(nid)],
                }
            }
            Collection::Storylines => match id.parse() {
                Ok(x) => vec![NavTarget::Storyline(x)],
                Err(_) => continue,
            },
            Collection::Elements => match id.parse() {
                Ok(x) => vec![NavTarget::Element(x)],
                Err(_) => continue,
            },
            Collection::Categories => match id.parse() {
                Ok(x) => vec![NavTarget::Category(x)],
                Err(_) => continue,
            },
            Collection::Materials => match id.parse() {
                Ok(x) => vec![NavTarget::Material(x)],
                Err(_) => continue,
            },
            _ => continue,
        };
        out.extend(
            targets
                .into_iter()
                .map(|target| RemovedEntity { target, purged }),
        );
    }
    out
}

impl Inner {
    /// Remember whether template document `doc` holds a template, unless
    /// a commit already told (the list queries seed it; commits, on the
    /// holder thread in their order, are what count).
    pub(crate) fn seen_template(&self, doc: &DocId, has: bool) {
        lock(&self.templates).entry(doc.clone()).or_insert(has);
    }

    /// After a commit to template document `doc`: when whether it holds a
    /// template flipped (blank ↔ not, or not known yet), the owner's
    /// `has_chapter_template` / `has_element_template` changed for every
    /// reader of the book's lists, so the change is also reported as a
    /// [`BookChanged`] naming the owner, field `chapter_template` (a
    /// storyline) or `element_template` (a category): the 0.1 fields that
    /// held the templates. The shell reloads its snapshot on it as on any
    /// change to the book. Typing inside a template sends no such event.
    fn template_flip(
        &self,
        doc: &DocId,
        t: &dr_model::id::TemplateId,
        book: BookId,
        ev: &dr_store::DocEvent,
    ) {
        let Some(owner) = t.owner() else { return };
        let open = lock(&self.prose).map.get(doc).map(|(_, s)| s.clone());
        let has = match open {
            // On the holder thread, right after the commit.
            Some(s) => !crate::commands::template::blank(&s.reader.view()),
            None => match self.lib.load_copy(&doc.to_string()) {
                Ok(d) => ProseReader::from_loro(doc.clone(), &d)
                    .map(|r| !crate::commands::template::blank(&r.view()))
                    .unwrap_or(false),
                Err(_) => return,
            },
        };
        if lock(&self.templates).insert(doc.clone(), has) == Some(has) {
            return;
        }
        let (collection, id, field) = match owner {
            dr_model::id::TemplateOwner::Storyline(s) => {
                (Collection::Storylines, s.to_string(), "chapter_template")
            }
            dr_model::id::TemplateOwner::Category(c) => {
                (Collection::Categories, c.to_string(), "element_template")
            }
        };
        events::publish(
            &self.bus,
            &WsEvent::Book(BookChanged {
                book,
                seq: ev.seq,
                origin: ev.origin.clone(),
                changes: vec![EntityChange {
                    collection,
                    id: Some(id),
                    fields: Some(vec![field.to_string()]),
                }],
            }),
        );
    }

    fn on_store_event(&self, e: &StoreEvent) {
        match e {
            StoreEvent::Doc(ev) => {
                let Ok(doc) = DocId::parse(&ev.doc_id) else {
                    return;
                };
                match &doc {
                    DocId::Book(book) => {
                        let changes = book_changes(&ev.changes);
                        let slot = lock(&self.books).get(book).cloned();
                        // Before the caches forget what a purged node was.
                        let removed = slot
                            .as_ref()
                            .map(|s| removed_by(s, &changes))
                            .unwrap_or_default();
                        if let Some(slot) = &slot {
                            slot.cache.invalidate(&changes);
                        }
                        events::publish(
                            &self.bus,
                            &WsEvent::Book(BookChanged {
                                book: book.clone(),
                                seq: ev.seq,
                                origin: ev.origin.clone(),
                                changes,
                            }),
                        );
                        if !removed.is_empty() {
                            events::publish(
                                &self.bus,
                                &WsEvent::Removed(Removed {
                                    book: book.clone(),
                                    seq: ev.seq,
                                    origin: ev.origin.clone(),
                                    entities: removed,
                                }),
                            );
                        }
                    }
                    // Conversation observers subscribe to their journal or
                    // store document events; they are never prose events.
                    DocId::Conversation(_) => {}
                    _ => {
                        let (ranges, embeds) = prose_ranges(&ev.changes);
                        let slot = lock(&self.prose).map.get(&doc).map(|(_, s)| s.clone());
                        let (book, blocks) = match slot {
                            Some(s) => {
                                // On the holder thread, right after the
                                // commit: the reader shows exactly it.
                                let blocks = if ranges.is_empty() {
                                    Vec::new()
                                } else {
                                    touched_blocks_near(&s.reader.view(), &ranges)
                                };
                                (s.book.clone(), blocks)
                            }
                            None => (
                                self.lib
                                    .doc_info(&ev.doc_id)
                                    .ok()
                                    .flatten()
                                    .and_then(|i| i.book_id)
                                    .and_then(|b| BookId::parse(&b).ok()),
                                Vec::new(),
                            ),
                        };
                        events::publish(
                            &self.bus,
                            &WsEvent::Prose(ProseChanged {
                                doc: doc.clone(),
                                book: book.clone(),
                                seq: ev.seq,
                                origin: ev.origin.clone(),
                                ranges,
                                blocks,
                                embeds,
                            }),
                        );
                        if let (DocId::Template(t), Some(book)) = (&doc, book) {
                            self.template_flip(&doc, t, book, ev);
                        }
                    }
                }
            }
            StoreEvent::Local(c) => events::publish(&self.bus, &WsEvent::Local(c.clone())),
        }
    }
}

/// The slot's own value once nobody else holds it (waiting until
/// `deadline`); a conflict when someone still does.
fn unwrap_slot<S, T>(
    mut slot: Arc<S>,
    deadline: std::time::Instant,
    take: impl FnOnce(S) -> T,
) -> Result<T> {
    loop {
        match Arc::try_unwrap(slot) {
            Ok(s) => return Ok(take(s)),
            Err(s) if std::time::Instant::now() < deadline => {
                slot = s;
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => {
                return Err(WsError::Conflict(
                    "the book is open in an editor; close it first".into(),
                ));
            }
        }
    }
}
