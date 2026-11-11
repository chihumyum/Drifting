//! The workspace: the open library, the open books and prose documents, the
//! event bus, the journal, and the entry points every caller uses.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use dr_doc::prose::{BorrowedProse, ProseReader};
use dr_doc::v3::CollectionV3 as Collection;
use dr_model::DocId;
use dr_model::id::BookId;
use dr_store::{
    DocHandle, Library, LibraryOptions, LibrarySubscription, OpenDoc, StoreError, StoreEvent,
};
use serde_json::Value;

use crate::actor::Actor;
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
use crate::sync::{SyncController, SyncNowOutput, SyncStatusSnapshot};

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
        if let Ok(DocId::Book(book)) = DocId::parse(id) {
            validate_book_header(&book, bytes)?;
            let merged = loro::LoroDoc::new();
            dr_doc::schema::configure(&merged);
            merged.import(&doc.export(loro::ExportMode::Snapshot)?)?;
            merged.import(bytes)?;
            if !dr_doc::v3::is_v3_doc(&merged) {
                return Err(StoreError::Invalid {
                    what: "book import",
                    value: "canonical v3 book required".into(),
                });
            }
        }
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

/// A complete old-format payload must be rejected before registration, even
/// when its marker would lose a merge against a newly created v3 genesis.
/// Partial v3 updates may omit meta entirely; the holder validates the merge.
fn validate_book_header(book: &BookId, bytes: &[u8]) -> dr_store::Result<()> {
    let incoming = loro::LoroDoc::new();
    dr_doc::schema::configure(&incoming);
    incoming.import(bytes)?;
    let meta = incoming.get_map("meta");
    if let Some(version) = meta.get("v") {
        let valid = match version {
            loro::ValueOrContainer::Value(loro::LoroValue::I64(3)) => true,
            loro::ValueOrContainer::Value(loro::LoroValue::Double(v)) => v == 3.,
            _ => false,
        };
        if !valid {
            return Err(StoreError::Invalid {
                what: "book import",
                value: "canonical v3 book required; reimport into a new library".into(),
            });
        }
    }
    if let Some(identity) = meta.get("book")
        && !matches!(identity, loro::ValueOrContainer::Value(loro::LoroValue::String(ref id)) if id.as_str()==book.as_str())
    {
        return Err(StoreError::Invalid {
            what: "book import",
            value: "book identity mismatch".into(),
        });
    }
    Ok(())
}

/// An open book: its holder, a reader sharing the holder's document, and
/// the query caches.
pub(crate) struct BookSlot {
    pub book: BookId,
    pub handle: DocHandle,
    pub reader_v3: dr_doc::v3::BookReaderV3,
    pub link_names: std::sync::Mutex<Option<crate::autolink::SlotLinkCache>>,
}

impl BookSlot {
    pub(crate) fn is_v3(&self) -> bool {
        self.handle.doc().with_doc(dr_doc::v3::is_v3_doc)
    }
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
    if !slot.reader_v3.view().needs_repair() {
        return Ok(());
    }
    let book = slot.book.clone();
    holder::write(&slot.handle, dr_store::Origin::Repair, None, move |doc| {
        let b = dr_doc::v3::BorrowedBookV3::new(doc, &book)?;
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

static NEXT_WS_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(crate) struct Inner {
    pub id: u64,
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
    /// The author's `editor.auto_entity_links` (`crate::autolink`).
    auto_links: std::sync::atomic::AtomicBool,
    active_book: Mutex<Option<BookId>>,
    sync_controller: Mutex<Option<Arc<dyn SyncController>>>,
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

/// Weak handle to a [`Workspace`] that does not block [`Workspace::try_shutdown`].
#[derive(Clone)]
pub struct WeakWorkspace {
    inner: Weak<Inner>,
}

impl WeakWorkspace {
    #[must_use]
    pub fn upgrade(&self) -> Option<Workspace> {
        self.inner.upgrade().map(|inner| Workspace { inner })
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
            id: NEXT_WS_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            journal: Journal::open(lib.clone())?,
            lib,
            options,
            books: Mutex::default(),
            gates: Mutex::default(),
            prose: Mutex::default(),
            bus: Bus::default(),
            library_gate: Arc::default(),
            subscription: Mutex::new(None),
            auto_links: std::sync::atomic::AtomicBool::new(true),
            active_book: Mutex::new(None),
            sync_controller: Mutex::new(None),
        });
        subscribe(&inner);
        Ok(Self { inner })
    }

    /// Process-unique identifier of this workspace instance (safe for in-memory
    /// and disk libraries alike).
    pub fn instance_id(&self) -> u64 {
        self.inner.id
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

    #[must_use]
    pub fn downgrade(&self) -> WeakWorkspace {
        WeakWorkspace {
            inner: Arc::downgrade(&self.inner),
        }
    }

    /// Close every open document and wait for their holders (the library
    /// stays open; close it with `Library::close`).
    pub fn close(&self) {
        self.close_slots();
        lock(&self.inner.subscription).take();
        lock(&self.inner.sync_controller).take();
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
                value: serde_json::to_value({
                    // Getters can expose a never-authored empty root in the live
                    // Loro arena. Observe committed operations, so a reopen and
                    // a read-only query at the same frontier have identical JSON.
                    let committed = loro::LoroDoc::new();
                    committed
                        .import(
                            &doc.export(loro::ExportMode::all_updates())
                                .map_err(|e| WsError::Internal(e.to_string()))?,
                        )
                        .map_err(|e| WsError::Internal(e.to_string()))?;
                    committed.get_deep_value()
                })
                .map_err(|e| WsError::Internal(e.to_string()))?,
            })
        })?
    }

    /// Run a registered call with document CAS checked inside each write job.
    /// V3 comment ranges, blocks and reanchors also require the source prose
    /// observation: its check and anchor/quote derivation share one read job.
    /// Later prose edits move stable anchors; quotes remain historical. This
    /// is not a transaction spanning source prose and the book write.
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
        match name {
            "sync.status" => {
                if !input.is_null() && input.as_object().is_none_or(|m| !m.is_empty()) {
                    return Err(WsError::Invalid("sync.status takes an empty object".into()));
                }
                let output = serde_json::to_value(self.sync_status())
                    .map_err(|e| WsError::Internal(e.to_string()))?;
                return Ok(Outcome {
                    output,
                    effects: Vec::new(),
                    undo: None,
                    journal: None,
                });
            }
            "sync.now" => {
                if !input.is_null() && input.as_object().is_none_or(|m| !m.is_empty()) {
                    return Err(WsError::Invalid("sync.now takes an empty object".into()));
                }
                let output = serde_json::to_value(self.sync_now()?)
                    .map_err(|e| WsError::Internal(e.to_string()))?;
                return Ok(Outcome {
                    output,
                    effects: Vec::new(),
                    undo: None,
                    journal: None,
                });
            }
            _ => {}
        }
        let spec: &'static Spec = registry()
            .get(name)
            .ok_or_else(|| WsError::UnknownCommand(name.into()))?;
        let cx = Cx::new(self, actor, spec);
        let out = (spec.call)(&cx, input);
        self.finish(cx, out, journal)
    }

    /// Attach (or clear) the runtime sync controller backing `sync.status` and `sync.now`.
    pub fn set_sync_controller(&self, controller: Option<Arc<dyn SyncController>>) {
        *lock(&self.inner.sync_controller) = controller;
    }

    /// Current sync health and pending local upload counts for this workspace.
    pub fn sync_status(&self) -> SyncStatusSnapshot {
        if let Some(ctrl) = lock(&self.inner.sync_controller).clone() {
            return ctrl.status();
        }
        let pending_docs = self
            .inner
            .lib
            .docs_with_local_changes()
            .map(|d| d.len())
            .unwrap_or(0);
        let pending_assets = self
            .inner
            .lib
            .assets_pending_upload()
            .map(|a| a.len())
            .unwrap_or(0);
        let pending_purges = self
            .inner
            .lib
            .purged_docs(None)
            .map(|p| p.len())
            .unwrap_or(0);
        SyncStatusSnapshot {
            pending_docs,
            pending_assets,
            pending_purges,
            ..SyncStatusSnapshot::default()
        }
    }

    /// Trigger an immediate sync cycle when Hosted Sync is active.
    pub fn sync_now(&self) -> Result<SyncNowOutput> {
        let Some(ctrl) = lock(&self.inner.sync_controller).clone() else {
            return Err(WsError::Conflict(
                "Hosted Sync is not active in local-only mode".into(),
            ));
        };
        ctrl.sync_now()
    }

    /// Record which book is currently open on screen in the shell so remote
    /// purges never close an active book's cached slots behind the author's back.
    pub fn set_active_book(&self, book: Option<BookId>) {
        *lock(&self.inner.active_book) = book;
    }

    pub fn active_book(&self) -> Option<BookId> {
        lock(&self.inner.active_book).clone()
    }

    /// Release an unheld cached slot in `Workspace` right before a remote
    /// `DocPurge` runs on `doc_id`. Never releases a document held by an open
    /// editor (`ProseSession`), an active book on screen, or another reader.
    pub fn release_idle_doc_for_remote_purge(&self, doc_id: &str) -> bool {
        let Ok(doc) = DocId::parse(doc_id) else {
            return false;
        };
        let active_book = lock(&self.inner.active_book).clone();
        match doc {
            DocId::Book(book) => {
                if active_book.as_ref() == Some(&book) {
                    return false;
                }
                {
                    let prose = lock(&self.inner.prose);
                    if prose
                        .map
                        .values()
                        .any(|(_, s)| s.book.as_ref() == Some(&book) && Arc::strong_count(s) > 1)
                    {
                        return false;
                    }
                }
                let removed = {
                    let mut books = lock(&self.inner.books);
                    if books.get(&book).is_some_and(|s| Arc::strong_count(s) == 1) {
                        books.remove(&book)
                    } else {
                        None
                    }
                };
                if let Some(slot) = removed
                    && let Ok(slot) = Arc::try_unwrap(slot)
                {
                    slot.handle.close();
                    return true;
                }
                false
            }
            other => {
                let removed = {
                    let mut prose = lock(&self.inner.prose);
                    if let Some((_, slot)) = prose.map.get(&other) {
                        if (slot.book.is_some() && slot.book == active_book)
                            || Arc::strong_count(slot) > 1
                        {
                            None
                        } else {
                            prose.map.remove(&other).map(|(_, s)| s)
                        }
                    } else {
                        None
                    }
                };
                if let Some(slot) = removed
                    && let Ok(slot) = Arc::try_unwrap(slot)
                {
                    slot.handle.close();
                    return true;
                }
                false
            }
        }
    }

    /// Run dr-doc's post-merge deterministic repair on `doc_id` if its slot is
    /// currently open in `Workspace`.
    pub fn repair_after_sync(&self, doc_id: &str) {
        let Ok(doc) = DocId::parse(doc_id) else {
            return;
        };
        match doc {
            DocId::Book(book) => {
                let slot = lock(&self.inner.books).get(&book).cloned();
                if let Some(slot) = slot {
                    let _ = repair_book(&slot);
                }
            }
            other => {
                let slot = lock(&self.inner.prose)
                    .map
                    .get(&other)
                    .map(|(_, s)| s.clone());
                if let Some(slot) = slot {
                    let _ = repair_prose(&slot);
                }
            }
        }
    }

    /// Forget undo journal rows and per-book concurrency gates after a book is
    /// permanently purged via remote sync.
    pub fn cleanup_purged_book(&self, book_id: &str) {
        let _ = self.inner.journal.forget_book(book_id);
        if let Ok(book) = BookId::parse(book_id) {
            lock(&self.inner.gates).remove(&book);
        }
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
        if let DocId::Book(book) = &doc {
            validate_book_header(book, &bytes)?;
        }
        if let Some((kind, book)) = kind_book {
            self.inner.lib.register(doc_id, kind, Some(book))?;
        }
        // dr-store's own import path: it records what the server has for a
        // sync import, persists, and announces the change (the caches follow
        // the event like any other).
        let origin = actor.store_origin();
        match &doc {
            DocId::Book(book) => {
                let slot = self.book_slot_or_create_v3(book)?;
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

    pub(crate) fn flush_book_prose_indices(&self, book: &BookId) -> Result<()> {
        let handles: Vec<DocHandle> = {
            let p = lock(&self.inner.prose);
            p.map
                .values()
                .filter(|(_, s)| s.book.as_ref() == Some(book))
                .map(|(_, s)| s.handle.clone())
                .collect()
        };
        for handle in handles {
            handle.reindex_now()?;
        }
        let stale = self.inner.lib.stale_index_docs()?;
        if !stale.is_empty() {
            let stale_set: std::collections::HashSet<String> = stale.into_iter().collect();
            for doc in self.inner.lib.docs(Some(book.as_str()), Some("body"))? {
                if stale_set.contains(&doc.doc_id) {
                    self.inner.lib.reindex_doc(&doc.doc_id)?;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn book_slot_or_create_v3(&self, book: &BookId) -> Result<Arc<BookSlot>> {
        self.book_slot_with(book, true)
    }

    fn book_slot_with(&self, book: &BookId, create: bool) -> Result<Arc<BookSlot>> {
        if let Some(s) = lock(&self.inner.books).get(book).cloned() {
            return Ok(s);
        }
        let doc_id = DocId::Book(book.clone()).to_string();
        let lib = &self.inner.lib;
        let handle = if create {
            let g = dr_doc::v3::genesis_v3(book);
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
        if !handle.doc().with_doc(dr_doc::v3::is_v3_doc) {
            return Err(WsError::invalid(
                "only canonical v3 books are supported; reimport to a new library",
            ));
        }
        let reader_v3 = handle
            .doc()
            .with_doc(|d| dr_doc::v3::BookReaderV3::from_loro(book.clone(), d))?;
        let slot = Arc::new(BookSlot {
            book: book.clone(),
            handle,
            reader_v3,
            link_names: std::sync::Mutex::new(None),
        });
        // dr-doc's deterministic background repair, once per open.
        repair_book(&slot)?;
        let slot = lock(&self.inner.books)
            .entry(book.clone())
            .or_insert(slot)
            .clone();
        Ok(slot)
    }

    /// Every automatic-link name of `book`, cached on its open slot until the
    /// book's committed frontiers advance.
    pub fn book_link_names(
        &self,
        book: &str,
    ) -> Result<Arc<Vec<dr_text::autolink::LinkName<dr_text::autolink::LinkTarget>>>> {
        let book_id = BookId::parse(book).map_err(|e| WsError::Invalid(e.to_string()))?;
        let slot = self.book_slot(&book_id)?;
        Ok(crate::autolink::book_names(&slot))
    }

    /// Cached `(frontiers_hex, names, full_matcher)` for `book`, reused by
    /// editor decorations and `@` completion until the book commits.
    pub fn book_link_cache(
        &self,
        book: &str,
    ) -> Result<(
        String,
        crate::autolink::CachedLinkNames,
        crate::autolink::CachedLinkMatcher,
    )> {
        let book_id = BookId::parse(book).map_err(|e| WsError::Invalid(e.to_string()))?;
        let slot = self.book_slot(&book_id)?;
        let (frontiers, names, matcher) = crate::autolink::book_cache(&slot);
        Ok((crate::naming::frontiers_hex(&frontiers), names, matcher))
    }

    /// Compiled automatic-link matcher for `book` excluding `own_entity_id`.
    /// Shares the book's cached Aho-Corasick automaton whenever `own_entity_id`
    /// is not itself an auto-link leaf.
    pub fn book_link_matcher(
        &self,
        book: &str,
        own_entity_id: &str,
    ) -> Result<Arc<dr_text::autolink::LinkMatcher<dr_text::autolink::LinkTarget>>> {
        let book_id = BookId::parse(book).map_err(|e| WsError::Invalid(e.to_string()))?;
        let slot = self.book_slot(&book_id)?;
        Ok(crate::autolink::book_matcher_for_owner(
            &slot,
            own_entity_id,
        ))
    }

    /// Read a canonical v3 book document and its committed frontier version
    /// together in a single holder read job. Rejects non-v3 books without
    /// modifying them.
    pub fn read_book_v3<R: Send + 'static>(
        &self,
        book: &str,
        f: impl FnOnce(&loro::LoroDoc, String) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        let book_id = BookId::parse(book).map_err(|e| WsError::Invalid(e.to_string()))?;
        let slot = self.book_slot(&book_id)?;
        slot.handle.read(move |doc| {
            let version = crate::naming::frontiers_hex(&doc.oplog_frontiers());
            f(doc, version)
        })?
    }

    /// Whether `entry` is a live (non-trashed) entry in `book`.
    pub fn is_live_entry(&self, book: &str, entry: &dr_model::id::EntryId) -> Result<bool> {
        let book_id = BookId::parse(book).map_err(|e| WsError::Invalid(e.to_string()))?;
        let slot = self.book_slot(&book_id)?;
        Ok(slot
            .reader_v3
            .view()
            .entry_raw(entry)
            .is_some_and(|e| !e.is_trashed()))
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

    pub(crate) fn prose_slot(&self, doc: &DocId) -> Result<Arc<ProseSlot>> {
        let canonical = match doc {
            DocId::Body(_) | DocId::Material(_) => true,
            DocId::Template(t) => t.entry_module().is_some(),
            _ => false,
        };
        if !canonical {
            return Err(WsError::invalid(
                "only canonical body, template-module or material prose is supported",
            ));
        }
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
        if let Some(book) = &info.book_id {
            let book = BookId::parse(book).map_err(|e| WsError::invalid(e.to_string()))?;
            self.book_slot(&book)?;
        } else if !matches!(doc, DocId::Material(_)) {
            return Err(WsError::invalid("canonical prose needs its owning book"));
        }
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
        Collection::Materials | Collection::Entries | Collection::Templates | Collection::Meta
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
        let state =
            if ch.collection == Collection::Entries {
                slot.reader_v3
                    .view()
                    .entry(&match id.parse() {
                        Ok(id) => id,
                        Err(_) => continue,
                    })
                    .map_or(Some(true), |e| e.deleted_at.map(|_| false))
            } else {
                match doc.get_map(ch.collection.root()).get(id) {
                    Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) => {
                        if trashed(&m) { Some(false) } else { None }
                    }
                    Some(_) => None,
                    None => Some(true),
                }
            };
        let Some(purged) = state else { continue };
        let targets: Vec<NavTarget> = match ch.collection {
            Collection::Entries => match id.parse() {
                Ok(id) => vec![NavTarget::Entry { id, module: None }],
                Err(_) => continue,
            },
            Collection::Templates => match id.parse() {
                Ok(id) => vec![NavTarget::Template(id)],
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
    fn on_store_event(&self, e: &StoreEvent) {
        match e {
            StoreEvent::Doc(ev) => {
                let Ok(doc) = DocId::parse(&ev.doc_id) else {
                    return;
                };
                match &doc {
                    DocId::Book(book) => {
                        let slot = lock(&self.books).get(book).cloned();
                        let changes = slot.as_ref().map_or_else(
                            || book_changes(&ev.changes, None),
                            |slot| {
                                slot.handle
                                    .doc()
                                    .with_doc(|doc| book_changes(&ev.changes, Some(doc)))
                            },
                        );
                        // Before the caches forget what a purged node was.
                        let removed = slot
                            .as_ref()
                            .map(|s| removed_by(s, &changes))
                            .unwrap_or_default();
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
                    }
                }
            }
            StoreEvent::Local(c) => {
                events::publish(&self.bus, &WsEvent::Local(c.clone()));
                if c.table == "purged_doc"
                    && let Ok(DocId::Book(book)) = DocId::parse(&c.key)
                {
                    events::publish(
                        &self.bus,
                        &WsEvent::Removed(Removed {
                            book,
                            seq: 0,
                            origin: dr_store::Origin::Sync,
                            entities: vec![RemovedEntity {
                                target: NavTarget::Book,
                                purged: true,
                            }],
                        }),
                    );
                }
            }
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
