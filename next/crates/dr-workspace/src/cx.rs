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
use std::collections::BTreeSet;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::ThreadId;

use dr_doc::book::BookTxn;
use dr_doc::prose::{ProseTxn, ProseView};
use dr_model::DocId;
use dr_model::id::BookId;
use loro::Frontiers;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::actor::Actor;
use crate::bridge::lock;
use crate::error::{Result, WsError};
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
    summary: Option<String>,
    leases: Vec<Lease>,
    leased: BTreeSet<BookId>,
    books_written: BTreeSet<BookId>,
    phase: Option<Phase>,
    book_hint: Option<BookId>,
}

/// The context of one command or query.
pub struct Cx<'a> {
    pub(crate) ws: &'a Workspace,
    actor: &'a Actor,
    pub(crate) spec: &'static Spec,
    st: RefCell<State>,
}

pub(crate) struct Finished {
    pub effects: Vec<Effect>,
    pub undo: Option<Vec<Invocation>>,
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
        };
        if spec.concurrency == Concurrency::Library {
            let lease = ws.inner.library_gate.enter();
            cx.st.borrow_mut().leases.push(lease);
        }
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
        self.ws
            .inner
            .lib
            .register(&doc.to_string(), doc.kind().prefix(), Some(book.as_str()))?;
        Ok(())
    }

    /// Step 2: one commit on prose document `doc`.
    pub(crate) fn write_prose<R, F>(&self, slot: &ProseSlot, f: F) -> Result<R>
    where
        F: FnOnce(&mut ProseTxn<'_>) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.check_phase(Phase::Prose)?;
        let origin = self.actor.model_origin();
        let agent = self.actor.agent_write(&self.summary());
        slot.mirror
            .write(self.actor.store_origin(), agent, move |d, _| {
                let (r, _) = d.edit(origin, |txn| Ok(f(txn)));
                r?
            })
    }

    /// Step 2, raw: run `f` on prose document `doc`'s mirror and the
    /// holder's own document (history restores use Loro's `revert_to`).
    pub(crate) fn write_prose_raw<R, F>(&self, slot: &ProseSlot, f: F) -> Result<R>
    where
        F: FnOnce(&mut dr_doc::prose::ProseDoc, &loro::LoroDoc) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.check_phase(Phase::Prose)?;
        let agent = self.actor.agent_write(&self.summary());
        slot.mirror.write(self.actor.store_origin(), agent, f)
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
        let origin = self.actor.model_origin();
        let agent = self.actor.agent_write(&self.summary());
        slot.mirror
            .write(self.actor.store_origin(), agent, move |d, _| {
                let before = d.frontiers();
                let (r, _) = d.edit(origin, |txn| Ok(f(txn)));
                Ok((r??, before))
            })
    }

    /// The open prose document `doc` (created from its genesis if only
    /// registered).
    pub(crate) fn prose(&self, doc: &DocId) -> Result<Arc<ProseSlot>> {
        self.ws.prose_slot(doc)
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
}
