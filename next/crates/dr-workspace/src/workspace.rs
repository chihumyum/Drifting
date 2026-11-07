//! The workspace: the open library, the open books and prose documents, the
//! event bus, the journal, and the entry points every caller uses.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use dr_doc::book::{BookDoc, BookReader};
use dr_doc::prose::{ProseDoc, ProseReader};
use dr_model::DocId;
use dr_model::id::BookId;
use dr_store::{Library, LibraryOptions, LibrarySubscription, OpenDoc, StoreError, StoreEvent};
use loro::ExportMode;
use serde_json::Value;

use crate::actor::{Actor, repair_store_origin};
use crate::bridge::{Mirror, lock};
use crate::cache::BookCache;
use crate::cx::{Cx, Faults, Gate, Invocation, Outcome};
use crate::error::{Result, WsError};
use crate::events::{
    self, BookChanged, Bus, ProseChanged, Subscription, WsEvent, book_changes, prose_ranges,
    touched_blocks,
};
use crate::journal::{Journal, JournalEntry};
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
/// on every Loro document and the prose deriver for the derived index.
pub fn library_options(app_version: &str) -> LibraryOptions {
    let mut o = LibraryOptions::new(app_version);
    o.configure_doc = Some(Arc::new(dr_doc::schema::configure));
    o.deriver = Some(Arc::new(crate::deriver::ProseDeriver));
    o
}

/// An open book: its document (holder + mirror), reader and caches.
pub(crate) struct BookSlot {
    pub book: BookId,
    pub mirror: Mirror<BookDoc>,
    pub reader: BookReader,
    pub cache: BookCache,
}

/// An open prose document.
pub(crate) struct ProseSlot {
    pub book: Option<BookId>,
    pub mirror: Mirror<ProseDoc>,
    pub reader: ProseReader,
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
        });
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        let sub = inner.lib.subscribe(move |e| {
            if let Some(inner) = weak.upgrade() {
                inner.on_store_event(e);
            }
        });
        *lock(&inner.subscription) = Some(sub);
        Ok(Self { inner })
    }

    /// Open (or create) the library in `root` with the workspace's hooks.
    pub fn open_dir(root: impl AsRef<Path>, app_version: &str) -> Result<Self> {
        let lib = Library::open(root.as_ref(), library_options(app_version))?;
        Self::open(lib, WorkspaceOptions::default())
    }

    pub fn library(&self) -> &Library {
        &self.inner.lib
    }

    /// Close every open document and wait for their holders (the library
    /// stays open; close it with `Library::close`).
    pub fn close(&self) {
        let books: Vec<Arc<BookSlot>> = lock(&self.inner.books).drain().map(|(_, s)| s).collect();
        let prose: Vec<Arc<ProseSlot>> = lock(&self.inner.prose)
            .map
            .drain()
            .map(|(_, (_, s))| s)
            .collect();
        for s in books {
            if let Ok(s) = Arc::try_unwrap(s) {
                s.mirror.handle.close();
            }
        }
        for s in prose {
            if let Ok(s) = Arc::try_unwrap(s) {
                s.mirror.handle.close();
            }
        }
        lock(&self.inner.subscription).take();
    }

    /// Close every document, then the library itself (this must be the last
    /// clone of the workspace).
    pub fn shutdown(self) -> Result<()> {
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
                Err(_) => {
                    return Err(WsError::Internal(
                        "other clones of the workspace are alive".into(),
                    ));
                }
            }
        };
        let lib = inner.lib.clone();
        drop(inner);
        lib.close()?;
        Ok(())
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
        if journal && spec.access == Access::Write && !done.effects.is_empty() {
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

    /// Import remote updates of `doc_id` (sync), through the document's
    /// mirror, so the workspace stays the only writer. Creates the document
    /// (from its genesis) when it is new here.
    pub fn import_remote(
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
        // dr-store's own import path (it records what the server has for a
        // sync import); the mirror then levels on the holder thread.
        let origin = actor.store_origin();
        match &doc {
            DocId::Book(book) => {
                let slot = self.book_slot_or_create(book)?;
                slot.mirror.handle.import(bytes, origin)?;
                slot.mirror.mark_stale();
                slot.mirror.refresh()?;
                slot.cache.clear();
            }
            _ => {
                let slot = self.prose_slot(&doc)?;
                slot.mirror.handle.import(bytes, origin)?;
                slot.mirror.mark_stale();
                slot.mirror.refresh()?;
            }
        }
        Ok(())
    }

    // ---- slots ------------------------------------------------------------

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
            if s.mirror.is_stale() {
                s.mirror.refresh()?;
                s.cache.clear();
            }
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
        let peer = lib.peer_for(&doc_id)?;
        let snap = handle.read(|d| d.export(ExportMode::Snapshot))??;
        let doc = BookDoc::load(book.clone(), peer, &[snap])?;
        let reader = doc.reader();
        let slot = Arc::new(BookSlot {
            book: book.clone(),
            mirror: Mirror::new(handle, doc),
            reader,
            cache: BookCache::default(),
        });
        // dr-doc's deterministic background repair, once per open.
        slot.mirror.write(repair_store_origin(), None, |d, _| {
            d.repair()?;
            Ok(())
        })?;
        let slot = lock(&self.inner.books)
            .entry(book.clone())
            .or_insert(slot)
            .clone();
        if slot.mirror.frontiers() != slot.mirror.handle.doc().oplog_frontiers() {
            slot.mirror.mark_stale();
        }
        Ok(slot)
    }

    pub(crate) fn prose_slot(&self, doc: &DocId) -> Result<Arc<ProseSlot>> {
        {
            let mut p = lock(&self.inner.prose);
            p.tick += 1;
            let tick = p.tick;
            if let Some((t, s)) = p.map.get_mut(doc) {
                *t = tick;
                let s = s.clone();
                drop(p);
                s.mirror.refresh()?;
                return Ok(s);
            }
        }
        if doc.is_book() {
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
        let peer = lib.peer_for(&id)?;
        let snap = handle.read(|d| d.export(ExportMode::Snapshot))??;
        let pd = ProseDoc::load(doc.clone(), peer, &[snap])?;
        let reader = pd.reader();
        let slot = Arc::new(ProseSlot {
            book: info.book_id.as_deref().and_then(|b| BookId::parse(b).ok()),
            mirror: Mirror::new(handle, pd),
            reader,
        });
        // dr-doc asks for one block-id repair after opening.
        slot.mirror.write(repair_store_origin(), None, |d, _| {
            d.repair()?;
            Ok(())
        })?;
        let mut p = lock(&self.inner.prose);
        p.tick += 1;
        let tick = p.tick;
        let slot = p.map.entry(doc.clone()).or_insert((tick, slot)).1.clone();
        // Close the least recently used, but never one still in use (a
        // `ProseSession` holds its slot): a second slot on the same holder
        // would be safe but would not see the first one's writes until its
        // own next write.
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

impl Inner {
    fn on_store_event(&self, e: &StoreEvent) {
        match e {
            StoreEvent::Doc(ev) => {
                let Ok(doc) = DocId::parse(&ev.doc_id) else {
                    return;
                };
                match &doc {
                    DocId::Book(book) => {
                        let changes = book_changes(&ev.changes);
                        if let Some(slot) = lock(&self.books).get(book).cloned() {
                            slot.mirror.check_event(&ev.frontiers);
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
                    }
                    _ => {
                        let (ranges, embeds) = prose_ranges(&ev.changes);
                        let slot = lock(&self.prose).map.get(&doc).map(|(_, s)| s.clone());
                        let (book, blocks) = match slot {
                            Some(s) => {
                                s.mirror.check_event(&ev.frontiers);
                                let blocks = if s.mirror.is_stale() || ranges.is_empty() {
                                    Vec::new()
                                } else {
                                    touched_blocks(&s.reader.view().blocks(), &ranges)
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
                                doc,
                                book,
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
            StoreEvent::Local(c) => events::publish(&self.bus, &WsEvent::Local(c.clone())),
        }
    }
}
