//! The text source on Drifting's storage: gpui-prose's `ProseSource` over a
//! workspace editing session.
//!
//! - **Writes and undo** go through F3's [`ProseSession`]: every edit is a
//!   `dr-doc` transaction in the document holder's write job (origin `user`,
//!   one commit, persisted before its event, seen by the workspace's caches
//!   and derived indexes); undo and redo are the session's `ProseUndo`, which
//!   never undoes an Agent's or a sync's commit.
//! - **Reads** run on the holder thread through dr-store's [`DocHandle`] (the
//!   same holder the session writes to), between queued writes, so they never
//!   see half a commit. The body is read raw (`to_delta`) with gpui-prose's
//!   reading rules, which are the schema's.
//! - **Events** come from a subscription on the body text: every commit on
//!   the holder (the author's, an Agent's command, a sync import, a repair)
//!   lands in a queue, with the inserted text's marks, so typing never makes
//!   the editor re-read a paragraph.
//! - **Anchors** are made and resolved on the holder thread (resolving can
//!   commit implicitly, which must not split a queued write).
//!
//! Other threads write this document, so the source keeps a count of the
//! events pushed (on the holder thread) and taken (by the editor). A read
//! that sees more commits than the editor has taken flags a resync; the
//! editor then rebuilds its mirror from [`ProseSource::resync`], which reads
//! and drops the queue in one holder job.

use std::any::Any;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use dr_doc::schema::prose::BODY;
use dr_store::{DocHandle, OpenDoc};
use dr_workspace::{ProseSession, Workspace, WsError};
use gpui_prose::text::{
    Anchor, Edit, EditResult, ORIGIN_USER, ProseSource, Resolved, SourceEvent, SourceParagraph,
    change_of, read_paragraphs,
};
use loro::cursor::PosType;
use loro::{ContainerTrait, EventTriggerKind, LoroDoc, Subscription};

use crate::convert::{self, OwnedEdit};

#[derive(Default)]
struct Queue {
    events: Vec<SourceEvent>,
    /// Events pushed since the source opened.
    pushed: u64,
    /// Of those, the author's (`user`): each is one item on the undo stack.
    pushed_user: u64,
}

#[derive(Default)]
struct Shared {
    queue: Mutex<Queue>,
    /// A read saw commits the editor had not taken.
    stale: AtomicBool,
}

impl Shared {
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The count of a document's events the holder has pushed. Read inside a
/// holder job, it says which state of the document that job saw; compare
/// it with [`SessionSource::taken`] to know whether the editor shows the
/// same state (positions found off the main thread are only right then).
#[derive(Clone)]
pub(crate) struct EventCount(Arc<Shared>);

impl EventCount {
    pub(crate) fn now(&self) -> u64 {
        self.0.queue().pushed
    }
}

/// gpui-prose's text source on one of the workspace's prose documents.
pub struct SessionSource {
    doc_id: String,
    /// Shared with the document's embeds (a table's cells write through it,
    /// so their commits land on the same undo stack).
    session: Arc<ProseSession>,
    handle: DocHandle,
    shared: Arc<Shared>,
    /// Events handed to the editor.
    taken: u64,
    /// Write other origins straight through the holder (tests).
    foreign_writes: bool,
    _subscription: Subscription,
}

impl SessionSource {
    /// Opens prose document `doc_id` (`node:<id>`, `idea:<id>`, …) for the
    /// author: an editing session on the workspace and a read handle on the
    /// same holder.
    pub fn open(ws: &Workspace, doc_id: &str) -> Result<SessionSource, WsError> {
        let session = ws.prose_session(doc_id)?;
        // The session opened the holder; this handle shares it.
        let handle = ws
            .library()
            .open_doc(doc_id, OpenDoc::Existing)
            .map_err(WsError::from)?;
        let shared = Arc::<Shared>::default();
        let subscription = {
            let shared = shared.clone();
            handle
                .read(move |doc| subscribe(doc, shared))
                .map_err(WsError::from)?
        };
        Ok(SessionSource {
            doc_id: doc_id.to_owned(),
            session: Arc::new(session),
            handle,
            shared,
            taken: 0,
            foreign_writes: false,
            _subscription: subscription,
        })
    }

    /// Lets edits with an origin other than the author's through, written
    /// straight to the holder with that origin. For tests and tools that
    /// stand in for another writer (gpui-prose's conformance suite writes an
    /// Agent's text between the author's); the app never turns it on, since
    /// Agents write through the workspace's commands.
    pub fn with_foreign_writes(mut self) -> SessionSource {
        self.foreign_writes = true;
        self
    }

    fn write_foreign(&mut self, edit: OwnedEdit, origin: &str) -> EditResult {
        let Some(store_origin) = dr_store::Origin::parse(origin) else {
            log::warn!("dr-editor: unknown origin {origin:?}; not written");
            return EditResult::default();
        };
        let doc_id = match dr_model::DocId::parse(&self.doc_id) {
            Ok(d) => d,
            Err(e) => {
                log::error!("dr-editor: {e}");
                return EditResult::default();
            }
        };
        let written = self.handle.write(store_origin, move |doc| {
            let prose = dr_doc::prose::BorrowedProse::new(doc, &doc_id)?;
            let mut txn = prose.txn();
            convert::apply(&mut txn, edit)
        });
        match written {
            Ok((Ok(result), _)) => result,
            Ok((Err(e), _)) => {
                log::error!("dr-editor: foreign edit failed: {e}");
                EditResult::default()
            }
            Err(e) => {
                log::error!("dr-editor: foreign edit failed: {e}");
                EditResult::default()
            }
        }
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    /// The holder's count of this document's events (see [`EventCount`]).
    pub(crate) fn event_count(&self) -> EventCount {
        EventCount(self.shared.clone())
    }

    /// Events the editor has taken, and so folded into what it shows.
    pub(crate) fn taken(&self) -> u64 {
        self.taken
    }

    pub fn session(&self) -> &ProseSession {
        &self.session
    }

    /// The session, for writers of the same document whose commits belong
    /// on the author's undo stack (a table's cells).
    pub fn shared_session(&self) -> Arc<ProseSession> {
        self.session.clone()
    }

    /// The holder's handle (reads on the holder thread).
    pub fn handle(&self) -> &DocHandle {
        &self.handle
    }

    /// Runs a read on the holder thread; flags a resync if the document has
    /// moved past what the editor took.
    fn read_on_holder<R: Send + 'static>(
        &self,
        f: impl FnOnce(&LoroDoc) -> R + Send + 'static,
    ) -> Option<R> {
        let shared = self.shared.clone();
        let taken = self.taken;
        let read = self.handle.read(move |doc| {
            if shared.queue().pushed != taken {
                shared.stale.store(true, Ordering::Relaxed);
            }
            f(doc)
        });
        match read {
            Ok(r) => Some(r),
            Err(e) => {
                log::error!("dr-editor: read of {} failed: {e}", self.doc_id);
                None
            }
        }
    }
}

fn subscribe(doc: &LoroDoc, shared: Arc<Shared>) -> Subscription {
    let text = doc.get_text(BODY);
    doc.subscribe(
        &text.id(),
        Arc::new(move |event| {
            let local = matches!(event.triggered_by, EventTriggerKind::Local);
            let mut changes = Vec::new();
            for diff in event.events {
                if let loro::event::Diff::Text(delta) = diff.diff {
                    changes.extend(delta.iter().map(change_of));
                }
            }
            if changes.is_empty() {
                return;
            }
            let mut q = shared.queue();
            if event.origin == ORIGIN_USER {
                q.pushed_user += 1;
            }
            q.events.push(SourceEvent {
                origin: event.origin.to_owned(),
                local,
                changes,
            });
            q.pushed += 1;
        }),
    )
}

impl ProseSource for SessionSource {
    fn read_all(&self) -> Vec<SourceParagraph> {
        self.read_on_holder(|doc| read_paragraphs(&doc.get_text(BODY).to_delta()))
            .unwrap_or_default()
    }

    fn read(&self, range: Range<usize>) -> Vec<SourceParagraph> {
        if range.is_empty() {
            return vec![SourceParagraph::default()];
        }
        self.read_on_holder(move |doc| {
            let delta = doc
                .get_text(BODY)
                .slice_delta(range.start, range.end, PosType::Unicode)
                .unwrap_or_default();
            read_paragraphs(&delta)
        })
        .unwrap_or_default()
    }

    fn take_events(&mut self) -> Vec<SourceEvent> {
        let mut q = self.shared.queue();
        self.taken = q.pushed;
        std::mem::take(&mut q.events)
    }

    fn resync(&mut self) -> Vec<SourceParagraph> {
        let shared = self.shared.clone();
        let read = self.handle.read(move |doc| {
            let mut q = shared.queue();
            q.events.clear();
            shared.stale.store(false, Ordering::Relaxed);
            (read_paragraphs(&doc.get_text(BODY).to_delta()), q.pushed)
        });
        match read {
            Ok((paragraphs, pushed)) => {
                self.taken = pushed;
                paragraphs
            }
            Err(e) => {
                log::error!("dr-editor: resync of {} failed: {e}", self.doc_id);
                Vec::new()
            }
        }
    }

    fn needs_resync(&mut self) -> bool {
        self.shared.stale.swap(false, Ordering::Relaxed)
    }

    fn edit(&mut self, edit: Edit<'_>, origin: &str) -> EditResult {
        let edit = OwnedEdit::from(edit);
        if origin != ORIGIN_USER {
            if self.foreign_writes {
                return self.write_foreign(edit, origin);
            }
            // Agents write through the workspace's commands; the editor only
            // sees their commits as events.
            log::warn!(
                "dr-editor: an edit with origin {origin:?} was not written; Agent writes go through the workspace's commands"
            );
            return EditResult::default();
        }
        let before = self.shared.queue().pushed_user;
        match self.session.edit(move |txn| convert::apply(txn, edit)) {
            Ok(mut result) => {
                // Merge interval 0: each of the author's commits is one item.
                // Count only the author's: an Agent's command may commit on
                // the holder while this edit waits in its queue.
                result.undo_items = (self.shared.queue().pushed_user - before) as usize;
                result
            }
            Err(e) => {
                log::error!("dr-editor: edit of {} failed: {e}", self.doc_id);
                EditResult::default()
            }
        }
    }

    fn edit_batch(&mut self, edits: &[Edit<'_>], origin: &str) -> EditResult {
        if origin != ORIGIN_USER {
            // Tests and stand-ins only (see `edit`): one at a time.
            let mut merged = EditResult::default();
            for edit in edits {
                merged.merge(self.edit(edit.clone(), origin));
            }
            return merged;
        }
        let edits: Vec<OwnedEdit> = edits.iter().cloned().map(OwnedEdit::from).collect();
        let before = self.shared.queue().pushed_user;
        // One `dr-doc` transaction, one commit, one item on the undo stack.
        let written = self.session.edit(move |txn| {
            let mut merged = EditResult::default();
            for edit in edits {
                merged.merge(convert::apply(txn, edit)?);
            }
            Ok(merged)
        });
        match written {
            Ok(mut result) => {
                result.undo_items = (self.shared.queue().pushed_user - before) as usize;
                result
            }
            Err(e) => {
                log::error!("dr-editor: batch edit of {} failed: {e}", self.doc_id);
                EditResult::default()
            }
        }
    }

    fn undo_item(&mut self) -> bool {
        self.session.undo().unwrap_or_else(|e| {
            log::error!("dr-editor: undo in {} failed: {e}", self.doc_id);
            false
        })
    }

    fn redo_item(&mut self) -> bool {
        self.session.redo().unwrap_or_else(|e| {
            log::error!("dr-editor: redo in {} failed: {e}", self.doc_id);
            false
        })
    }

    fn anchor(&self, range: Range<usize>) -> Option<Anchor> {
        self.read_on_holder(move |doc| Anchor::new(&doc.get_text(BODY), range))
            .flatten()
    }

    fn resolve(&self, anchor: &Anchor) -> Option<Resolved> {
        let anchor = anchor.clone();
        self.read_on_holder(move |doc| anchor.resolve(doc))
            .flatten()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
