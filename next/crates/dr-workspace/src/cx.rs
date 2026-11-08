//! The context a command runs in, and the write order it enforces.
//!
//! A command may write several prose documents, the book document and the
//! workspace's local tables. Loro gives no atomic commit across documents, so
//! [`Cx`] makes every command write in one order (f3-workspace.md "写入顺序"):
//!
//! 1. **validate** everything first, reading only (dr-doc commits whatever a
//!    transaction applied even when it then fails);
//! 2. **prose documents** (registering new ones, seeding text), each its own
//!    commit;
//! 3. **the book document**, one commit per command;
//! 4. **local tables** (the journal), one SQLite transaction.
//!
//! A failure after step 2 leaves a prose document no book entity owns, which
//! every reader already tolerates (`PROSE-OWNER`) and nothing shows; a
//! failure after step 3 leaves the book change durable without its journal
//! row (the command then reports no undo). Removing things runs the other
//! way round: the book entity goes first, prose documents stay until a
//! sweep, so a book entity never names a prose document that is gone.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::ThreadId;

use dr_doc::book::{BookTxn, BorrowedBook};
use dr_doc::prose::{BorrowedProse, ProseTxn, ProseView};
use dr_model::DocId;
use dr_model::id::BookId;
use loro::Frontiers;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::actor::Actor;
use crate::error::{Result, WsError};
use crate::holder::{self, lock};
use crate::registry::{Access, Concurrency, Spec};
use crate::workspace::{BookSlot, ProseSlot, Workspace};

/// What a write did, entity by entity. Commands report every entity they
/// changed and every entity whose display changed as a consequence (a
/// relation hidden because its end went to the trash), so the interface can
/// say it and an Agent can report it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Effect {
    pub action: EffectAction,
    /// Entity kind: `book`, `node`, `act`, `storyline`, `category`,
    /// `element`, `relation`, `relation_type`, `comment`, `material`,
    /// `material_folder`, `idea_group`, `fact`, `memory`, `asset`, `prose`.
    pub kind: String,
    pub id: String,
    /// The entity's (final) name or title, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EffectAction {
    Created,
    Updated,
    Moved,
    Renamed,
    Trashed,
    Restored,
    /// Deleted for good.
    Purged,
    /// Still stored, but not shown while something it depends on is in the
    /// trash (a relation whose end is trashed). Comes back on restore.
    Hidden,
    /// Shown again after a restore.
    Shown,
    /// A comment whose target is in the trash or gone: shown as unlocated.
    Unlocated,
    /// A reference cleared because its target was deleted for good (a
    /// comment that became floating, an element left without category).
    Detached,
}

/// A call of a registered command: how a command's undo is expressed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Invocation {
    pub command: String,
    pub input: Value,
}

impl Invocation {
    pub fn new(command: &str, input: impl Serialize) -> Self {
        Self {
            command: command.to_string(),
            input: serde_json::to_value(input).expect("command input serializes"),
        }
    }
}

/// A command's result: its output, what it changed, how to undo it.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Outcome<T> {
    pub output: T,
    pub effects: Vec<Effect>,
    /// The commands that undo this one, in order; `None` when it cannot be
    /// undone this way (history still can).
    pub undo: Option<Vec<Invocation>>,
    /// The journal row (absent for reads, no-ops and inverse runs).
    pub journal: Option<i64>,
}

/// Writes a command makes to prose documents from other threads
/// ([`Cx::prose_writer`]).
pub(crate) struct ProseWriter {
    origin: dr_store::Origin,
    agent: Option<dr_store::AgentWrite>,
    guards: Option<crate::guard::Guards>,
}

impl ProseWriter {
    pub(crate) fn write<R, F>(&self, slot: &ProseSlot, f: F) -> Result<R>
    where
        F: FnOnce(&loro::LoroDoc) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let guards = self.guards.clone();
        let id = slot.doc.to_string();
        holder::write(
            &slot.handle,
            self.origin.clone(),
            self.agent.clone(),
            move |doc| {
                if let Some(guards) = guards {
                    guards.check(&id, doc)?;
                }
                f(doc)
            },
        )
    }
}

/// Test hook: make one named point of the write path fail once.
#[derive(Default)]
pub struct Faults {
    point: Mutex<Option<&'static str>>,
}

impl Faults {
    /// Fail the next time `point` is reached: `after_prose` (between the
    /// prose and the book writes), `in_book` (inside a book transaction,
    /// after part of it is applied), `journal` (the local-table write).
    pub fn arm(&self, point: &'static str) {
        *lock(&self.point) = Some(point);
    }

    pub fn disarm(&self) {
        *lock(&self.point) = None;
    }

    pub(crate) fn hit(&self, point: &'static str) -> bool {
        let mut p = lock(&self.point);
        if *p == Some(point) {
            *p = None;
            true
        } else {
            false
        }
    }
}

/// A fault check that can travel into a write closure.
#[derive(Clone, Default)]
pub(crate) struct FaultHook(Option<Arc<Faults>>);

impl FaultHook {
    pub(crate) fn check(&self, point: &'static str) -> Result<()> {
        match &self.0 {
            Some(f) if f.hit(point) => Err(WsError::Fault(point)),
            _ => Ok(()),
        }
    }
}

/// One-at-a-time access to a book (or the library), re-entrant on the
/// thread that holds it (an undo runs inverse commands inside its own).
#[derive(Default)]
pub(crate) struct Gate {
    owner: Mutex<Option<(ThreadId, usize)>>,
    cv: Condvar,
}

pub(crate) struct Lease(Arc<Gate>);

impl Gate {
    pub(crate) fn enter(self: &Arc<Self>) -> Lease {
        let me = std::thread::current().id();
        let mut o = lock(&self.owner);
        loop {
            match &mut *o {
                None => {
                    *o = Some((me, 1));
                    break;
                }
                Some((t, n)) if *t == me => {
                    *n += 1;
                    break;
                }
                Some(_) => o = self.cv.wait(o).unwrap_or_else(|e| e.into_inner()),
            }
        }
        Lease(self.clone())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut o = lock(&self.0.owner);
        if let Some((_, n)) = &mut *o {
            *n -= 1;
            if *n == 0 {
                *o = None;
                self.0.cv.notify_all();
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    Prose,
    Book,
}

#[derive(Default)]
struct State {
    effects: Vec<Effect>,
    undo: Vec<Invocation>,
    undo_declared: bool,
    irreversible: bool,
    /// Not an entry of the journal (see [`Cx::follows_prose`]).
    unjournaled: bool,
    summary: Option<String>,
    leases: Vec<Lease>,
    leased: BTreeSet<BookId>,
    books_written: BTreeSet<BookId>,
    phase: Option<Phase>,
    book_hint: Option<BookId>,
    /// Elements whose `updated_at` the book write stamps
    /// ([`Cx::touch_element`]).
    touched_elements: Vec<String>,
    /// Documents opened for this command alone ([`Cx::prose_passing`]).
    passing: HashMap<DocId, Arc<ProseSlot>>,
}

/// The key of an element's last change of its own fields, in seconds
/// (dr-model's `Timestamp`), as comments keep theirs. dr-doc's element has
/// no such field yet (F1 待协调): F3 writes and reads the key itself, the
/// encoding dr-doc gives timestamps, so a later `ElementWriter::updated_at`
/// reads what is stored.
pub(crate) const ELEMENT_UPDATED_AT: &str = "updated_at";

/// Write [`ELEMENT_UPDATED_AT`] = now on each live element map of `ids`.
fn stamp_elements(doc: &loro::LoroDoc, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let root = doc.get_map(dr_doc::book::Collection::Elements.root());
    let now = loro::LoroValue::I64(dr_model::Timestamp::now().0);
    for id in ids {
        if let Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) = root.get(id) {
            m.insert(ELEMENT_UPDATED_AT, now.clone())
                .map_err(|e| WsError::Internal(e.to_string()))?;
        }
    }
    Ok(())
}

/// The context of one command or query.
pub struct Cx<'a> {
    pub(crate) ws: &'a Workspace,
    actor: &'a Actor,
    pub(crate) spec: &'static Spec,
    st: RefCell<State>,
    guards: Option<crate::guard::Guards>,
}

pub(crate) struct Finished {
    pub effects: Vec<Effect>,
    pub undo: Option<Vec<Invocation>>,
    /// Record a journal row (unless nothing changed).
    pub journaled: bool,
    pub book: Option<BookId>,
    pub leases: Vec<Lease>,
}

impl<'a> Cx<'a> {
    pub(crate) fn new(ws: &'a Workspace, actor: &'a Actor, spec: &'static Spec) -> Self {
        let cx = Self {
            ws,
            actor,
            spec,
            st: RefCell::default(),
            guards: None,
        };
        if spec.concurrency == Concurrency::Library {
            let lease = ws.inner.library_gate.enter();
            cx.st.borrow_mut().leases.push(lease);
        }
        cx
    }

    pub(crate) fn guarded(
        ws: &'a Workspace,
        actor: &'a Actor,
        spec: &'static Spec,
        guards: crate::guard::Guards,
    ) -> Self {
        let mut cx = Self::new(ws, actor, spec);
        cx.guards = Some(guards);
        cx
    }

    pub fn actor(&self) -> &Actor {
        self.actor
    }

    pub fn workspace(&self) -> &Workspace {
        self.ws
    }

    pub(crate) fn finish(self) -> Finished {
        let st = self.st.into_inner();
        let undo = if st.irreversible || !st.undo_declared {
            None
        } else {
            Some(st.undo)
        };
        Finished {
            effects: st.effects,
            undo,
            journaled: !st.unjournaled,
            book: st.book_hint,
            leases: st.leases,
        }
    }

    pub(crate) fn faults(&self) -> FaultHook {
        FaultHook(self.ws.inner.options.faults.clone())
    }

    /// The open book `id`. A writing command takes the book's lease here and
    /// keeps it until it has finished (journal included).
    pub(crate) fn book(&self, id: &str) -> Result<Arc<BookSlot>> {
        let book =
            BookId::parse(id).map_err(|_| WsError::invalid(format!("bad book id {id:?}")))?;
        if self.spec.access == Access::Write && self.spec.concurrency == Concurrency::Book {
            let gate = self.ws.book_gate(&book);
            let mut st = self.st.borrow_mut();
            if st.leased.insert(book.clone()) {
                st.leases.push(gate.enter());
            }
        }
        let slot = self.ws.book_slot(&book)?;
        let mut st = self.st.borrow_mut();
        if st.book_hint.is_none() {
            st.book_hint = Some(book);
        }
        Ok(slot)
    }

    fn check_phase(&self, want: Phase) -> Result<()> {
        if self.spec.access != Access::Write {
            return Err(WsError::Internal(format!("{} is a query", self.spec.name)));
        }
        let mut st = self.st.borrow_mut();
        match st.phase {
            Some(p) if p > want => Err(WsError::Internal(format!(
                "{}: prose written after the book (write order)",
                self.spec.name
            ))),
            _ => {
                st.phase = Some(want);
                Ok(())
            }
        }
    }

    fn summary(&self) -> String {
        self.st
            .borrow()
            .summary
            .clone()
            .unwrap_or_else(|| self.spec.name.to_string())
    }

    /// What an Agent's settlement records says this write did.
    pub(crate) fn summarize(&self, s: impl Into<String>) {
        self.st.borrow_mut().summary = Some(format!("{}: {}", self.spec.name, s.into()));
    }

    /// Step 2: make sure prose document `doc` exists (registered; its genesis
    /// is written when it is first opened, identically on every device).
    pub(crate) fn create_prose(&self, book: &BookId, doc: &DocId) -> Result<()> {
        self.check_phase(Phase::Prose)?;
        let id = doc.to_string();
        let fresh = self.guards.is_some() && self.ws.library().doc_info(&id)?.is_none();
        if fresh {
            let guards = self.guards.clone().expect("guarded creation");
            let parent = format!("book:{book}");
            let slot = self.book(book.as_str())?;
            slot.handle
                .read(move |doc| guards.check_required(&parent, doc))??;
        }
        self.ws
            .inner
            .lib
            .register(&id, doc.kind().prefix(), Some(book.as_str()))?;
        if fresh {
            let info = self.ws.library().doc_info(&id)?;
            if info.as_ref().and_then(|i| i.book_id.as_deref()) != Some(book.as_str()) {
                return Err(WsError::Conflict(format!(
                    "document belongs to another book: {id}"
                )));
            }
            let initial = loro::LoroDoc::new();
            initial.import(&dr_doc::prose::genesis(doc))?;
            self.guards
                .as_ref()
                .expect("guarded creation")
                .created(id, initial.oplog_frontiers());
        }
        Ok(())
    }

    /// Step 2: one commit on prose document `doc`, a dr-doc transaction on
    /// the holder's document.
    pub(crate) fn write_prose<R, F>(&self, slot: &ProseSlot, f: F) -> Result<R>
    where
        F: FnOnce(&mut ProseTxn<'_>) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let doc_id = slot.doc.clone();
        self.write_prose_raw(slot, move |doc| {
            let b = BorrowedProse::new(doc, &doc_id)?;
            let mut txn = b.txn();
            f(&mut txn)
        })
    }

    /// Step 2, raw: run `f` on the holder's document itself (history
    /// restores use Loro's `revert_to`).
    ///
    /// The author's commands are written with dr-store's `Origin::Command`
    /// (`user:command`), not `user`: an editor open on this document undoes
    /// only its own steps (`ProseSession`), and a command is undone through
    /// the journal. An
    /// Agent's, the mirror's or a sync's origin is left out of the editor's
    /// undo already.
    pub(crate) fn write_prose_raw<R, F>(&self, slot: &ProseSlot, f: F) -> Result<R>
    where
        F: FnOnce(&loro::LoroDoc) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.check_phase(Phase::Prose)?;
        let agent = self.actor.agent_write(&self.summary());
        // The author's command, not the author's typing (dr-store's
        // `Origin::Command`): an editor's undo leaves it to the journal.
        let origin = match self.actor {
            Actor::User => dr_store::Origin::Command,
            _ => self.actor.store_origin(),
        };
        let guards = self.guards.clone();
        let id = slot.doc.to_string();
        holder::write(&slot.handle, origin, agent, move |doc| {
            if let Some(guards) = guards {
                guards.check(&id, doc)?;
            }
            f(doc)
        })
    }

    /// Step 2 for writes this command makes on other threads (one per
    /// document, `holder::par_map`): the origin and the Agent record
    /// [`Cx::write_prose_raw`] would use.
    pub(crate) fn prose_writer(&self) -> Result<ProseWriter> {
        self.check_phase(Phase::Prose)?;
        Ok(ProseWriter {
            origin: match self.actor {
                Actor::User => dr_store::Origin::Command,
                _ => self.actor.store_origin(),
            },
            agent: self.actor.agent_write(&self.summary()),
            guards: self.guards.clone(),
        })
    }

    /// Step 3: the book document, one commit. Returns `f`'s value and the
    /// book's version just before the commit (what a purge's undo restores
    /// from). Whatever `f` applied before failing is committed too (dr-doc
    /// cannot roll back), so `f` must validate nothing: validate before.
    pub(crate) fn write_book<R, F>(&self, slot: &BookSlot, f: F) -> Result<(R, Frontiers)>
    where
        F: FnOnce(&mut BookTxn<'_>) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.check_phase(Phase::Book)?;
        if !self.st.borrow_mut().books_written.insert(slot.book.clone()) {
            return Err(WsError::Internal(format!(
                "{}: a second book commit in one command",
                self.spec.name
            )));
        }
        self.faults().check("after_prose")?;
        let agent = self.actor.agent_write(&self.summary());
        let book = slot.book.clone();
        let touched = std::mem::take(&mut self.st.borrow_mut().touched_elements);
        let guards = self.guards.clone();
        holder::write(&slot.handle, self.actor.store_origin(), agent, move |doc| {
            if let Some(guards) = guards {
                guards.check(&format!("book:{book}"), doc)?;
            }
            // The holder has settled the document: this is the stored head.
            let before = doc.oplog_frontiers();
            let r = {
                let b = BorrowedBook::new(doc, &book)?;
                let mut txn = b.txn();
                f(&mut txn)?
            };
            stamp_elements(doc, &touched)?;
            Ok((r, before))
        })
    }

    /// Stamp element `id`'s `updated_at` in this command's book write (a
    /// rename, a field, an alias, a summary: what M11 shows as 「更新于」).
    /// Call it before [`Self::write_book`].
    pub(crate) fn touch_element(&self, id: &dr_model::id::ElementId) {
        self.st.borrow_mut().touched_elements.push(id.to_string());
    }

    /// The open prose document `doc` (created from its genesis if only
    /// registered).
    pub(crate) fn prose(&self, doc: &DocId) -> Result<Arc<ProseSlot>> {
        self.ws.prose_slot(doc)
    }

    /// [`Cx::prose`] for a command that touches a document in passing: its
    /// open slot, or one held for this command only
    /// (`Workspace::prose_slot_passing`).
    pub(crate) fn prose_passing(&self, doc: &DocId) -> Result<Arc<ProseSlot>> {
        if let Some(s) = self.st.borrow().passing.get(doc) {
            return Ok(s.clone());
        }
        let s = self.ws.prose_slot_passing(doc)?;
        self.st.borrow_mut().passing.insert(doc.clone(), s.clone());
        Ok(s)
    }

    pub(crate) fn prose_view<'s>(&self, slot: &'s ProseSlot) -> ProseView<'s> {
        slot.reader.view()
    }

    // ---- results --------------------------------------------------------

    pub(crate) fn effect(
        &self,
        action: EffectAction,
        kind: &str,
        id: impl Into<String>,
        name: Option<&str>,
    ) {
        self.st.borrow_mut().effects.push(Effect {
            action,
            kind: kind.to_string(),
            id: id.into(),
            name: name.map(str::to_string),
        });
    }

    /// Declare how to undo this command (call once per inverse, in order).
    pub(crate) fn undo_with(&self, inv: Invocation) {
        let mut st = self.st.borrow_mut();
        st.undo_declared = true;
        st.undo.push(inv);
    }

    /// Declare that the command did nothing that needs undoing.
    pub(crate) fn undo_nothing(&self) {
        self.st.borrow_mut().undo_declared = true;
    }

    /// Declare that this command cannot be undone by another command
    /// (history can still restore it).
    pub(crate) fn irreversible(&self) {
        self.st.borrow_mut().irreversible = true;
    }

    /// Declare that this command follows what happened in prose and is not
    /// a step of the author's own: no journal row, so the object-level Undo
    /// neither stops at it nor loses its redo to it. An editor's undo
    /// bringing back a comment's anchor, and the TODOs projected from
    /// markers, are such: the editor's own undo takes the prose back and
    /// they follow again. The outcome still says how to undo it.
    pub(crate) fn follows_prose(&self) {
        self.st.borrow_mut().unjournaled = true;
    }
}
