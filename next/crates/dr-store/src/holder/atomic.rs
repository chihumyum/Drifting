//! An opt-in multi-document transaction. Existing holder jobs are unchanged.
//! Reserve holders in id order, edit detached copies, append all updates in
//! one SQLite transaction, install every copy, then announce the changes.
//! Dropping a reservation before commit releases it without touching live data.
use super::*;
use std::collections::BTreeMap;

mod user;
use user::LocalText;

/// Registry boundary of an opt-in atomic operation. Every document whose id
/// starts with `prefix` must be reserved, and must belong to `book_id`.
/// Checked again inside the append transaction, so registering another body
/// without changing the book cannot bypass a preview's version guards.
pub struct AtomicScope<'a> {
    pub book_id: &'a str,
    pub prefix: &'a str,
}

/// An absent document to register and seed in the same transaction as edits.
/// The caller supplies its normal genesis; `edit` can populate the copy.
pub struct AtomicNewDocument {
    pub id: String,
    pub kind: String,
    pub genesis: Vec<u8>,
    /// The registry row already exists, but has no persisted content. The
    /// transaction verifies that absence; it never overwrites an existing head.
    pub pre_registered: bool,
}

pub(super) struct Request {
    ready: Sender<Result<Reserved>>,
    decision: Receiver<Apply>,
}
struct Reserved {
    lib: Arc<Inner>,
    doc: LoroDoc,
    seq: i64,
}
struct Apply {
    bytes: Vec<u8>,
    local: Option<LocalText>,
    origin: Origin,
    installed: Sender<()>,
    announce: Receiver<()>,
    finished: Sender<()>,
}

impl DocHandle {
    /// Atomically edit a set of documents. `edit` receives detached copies
    /// while all their holder queues are paused. An error (including a SQL
    /// append failure) leaves all live documents and stored rows unchanged.
    /// Never call a holder, workspace command or other atomic operation from
    /// `edit`: those queues are reserved. Keep it short; typing queues behind it.
    /// Every handle must belong to the same library. Copies have their original
    /// peer and configuration; commit options are set before calling `edit`.
    /// This API is for author commands; Agent writes use their settled APIs.
    pub fn atomic<R, E>(
        handles: &[DocHandle],
        origin: Origin,
        edit: impl FnOnce(&BTreeMap<String, LoroDoc>) -> std::result::Result<R, E>,
    ) -> std::result::Result<R, E>
    where
        E: From<StoreError>,
    {
        Self::atomic_inner(handles, origin, None, &[], None, None, edit)
    }

    /// Like `atomic`, with a complete registry boundary and optional new
    /// documents. A changed inventory, foreign owner, racing opener, failed
    /// edit or SQL append rejects the whole operation. New documents become
    /// openable only after every update is durable. Existing APIs are unchanged.
    pub fn atomic_scoped<R, E>(
        handles: &[DocHandle],
        origin: Origin,
        scope: AtomicScope<'_>,
        new_documents: &[AtomicNewDocument],
        edit: impl FnOnce(&BTreeMap<String, LoroDoc>) -> std::result::Result<R, E>,
    ) -> std::result::Result<R, E>
    where
        E: From<StoreError>,
    {
        Self::atomic_inner(
            handles,
            origin,
            Some(scope),
            new_documents,
            None,
            None,
            edit,
        )
    }

    /// An opt-in atomic author edit of existing documents. The original
    /// command-only APIs keep rejecting `Origin::User`. All edits are staged
    /// and durably appended together, then installed before `installed` runs.
    /// Only edits of existing text containers are supported. Their lossless
    /// typed deltas are replayed locally, so existing undo managers see local
    /// author edits rather than imports which rebase their older history.
    /// The replay's own operations are persisted, after validating its full
    /// values/marks and deterministic operation bytes on detached copies.
    /// Unsupported edits are rejected before the SQL transaction. Returned
    /// positions/values describe the accepted state; staged operation ids and
    /// versions are speculative and must not be used as committed receipts.
    /// The callback cannot fail, mutate a document or call a holder (all queues
    /// remain reserved). Notifications follow it. Unsuccessful staging/append
    /// never calls it or changes a live document/undo manager.
    pub fn atomic_user<R, E>(
        handles: &[DocHandle],
        book_id: &str,
        edit: impl FnOnce(&BTreeMap<String, LoroDoc>) -> std::result::Result<R, E>,
        installed: impl FnOnce(),
    ) -> std::result::Result<R, E>
    where
        E: From<StoreError>,
    {
        Self::atomic_inner(
            handles,
            Origin::User,
            None,
            &[],
            Some(book_id),
            Some(Box::new(installed)),
            edit,
        )
    }

    fn atomic_inner<R, E>(
        handles: &[DocHandle],
        origin: Origin,
        scope: Option<AtomicScope<'_>>,
        new_documents: &[AtomicNewDocument],
        owner: Option<&str>,
        installed: Option<Box<dyn FnOnce() + '_>>,
        edit: impl FnOnce(&BTreeMap<String, LoroDoc>) -> std::result::Result<R, E>,
    ) -> std::result::Result<R, E>
    where
        E: From<StoreError>,
    {
        if handles.is_empty()
            || (origin != Origin::Command && !(origin == Origin::User && installed.is_some()))
        {
            return Err(StoreError::invalid(
                "atomic edit",
                "requires documents and command origin",
            )
            .into());
        }
        if handles
            .iter()
            .any(|h| !Arc::ptr_eq(&h.shared.closing, &handles[0].shared.closing))
        {
            return Err(StoreError::invalid("atomic edit", "different libraries").into());
        }
        let mut handles = handles.to_vec();
        handles.sort_by(|a, b| a.doc_id().cmp(b.doc_id()));
        if handles.windows(2).any(|p| p[0].doc_id() == p[1].doc_id()) {
            return Err(StoreError::invalid("atomic edit", "duplicate document").into());
        }
        let mut reservations = Vec::new();
        for h in &handles {
            let (ready, rx) = mpsc::channel();
            let (decision, receive) = mpsc::channel();
            h.send(Msg::Reserve(Request {
                ready,
                decision: receive,
            }))?;
            let r = rx
                .recv()
                .map_err(|_| StoreError::Closed(h.doc_id().into()))??;
            if reservations
                .first()
                .is_some_and(|(_, first): &(Sender<Apply>, Reserved)| {
                    !Arc::ptr_eq(&first.lib, &r.lib)
                })
            {
                return Err(StoreError::invalid("atomic edit", "different libraries").into());
            }
            reservations.push((decision, r));
        }
        let lib = &reservations[0].1.lib;
        let mut copies: BTreeMap<_, _> = handles
            .iter()
            .zip(&reservations)
            .map(|(h, (_, r))| (h.doc_id().to_owned(), r.doc.clone()))
            .collect();
        for new in new_documents {
            if new.id.is_empty()
                || new.id.len() > 256
                || new.id.chars().any(char::is_control)
                || !scope.as_ref().is_some_and(|s| new.id.starts_with(s.prefix))
                || copies.contains_key(&new.id)
            {
                return Err(StoreError::invalid("atomic new document", &new.id).into());
            }
            let doc = lib.new_doc();
            doc.import(&new.genesis).map_err(StoreError::from)?;
            copies.insert(new.id.clone(), doc);
        }
        let before: BTreeMap<_, _> = copies
            .iter()
            .map(|(id, d)| (id.clone(), d.oplog_vv()))
            .collect();
        let bases = if origin == Origin::User {
            copies
                .iter()
                .map(|(id, d)| Ok((id.clone(), user::copy(lib, d)?)))
                .collect::<Result<BTreeMap<_, _>>>()?
        } else {
            BTreeMap::new()
        };
        for d in copies.values() {
            d.set_next_commit_options(CommitOptions::new().origin(&origin.to_string()));
        }
        let result = edit(&copies)?;
        let mut updates = Vec::new();
        let mut local = BTreeMap::new();
        for (id, d) in &copies {
            d.commit_with(CommitOptions::new().origin(&origin.to_string()));
            let replay;
            let d = if origin == Origin::User && d.oplog_vv() != before[id] {
                let (doc, plan) = LocalText::prepare(lib, &bases[id], d)?;
                local.insert(id.clone(), plan);
                replay = doc;
                &replay
            } else {
                d
            };
            let vv = d.oplog_vv();
            let bytes = if new_documents.iter().any(|n| n.id == *id) {
                d.export(ExportMode::all_updates())
                    .map_err(StoreError::from)?
            } else if vv == before[id] {
                Vec::new()
            } else {
                d.export(ExportMode::updates(&before[id]))
                    .map_err(StoreError::from)?
            };
            updates.push((id.clone(), bytes, vv, d.oplog_frontiers()));
        }
        if let Some(faults) = &lib.options.append_faults
            && faults
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
                .is_ok()
        {
            return Err(
                StoreError::Io(std::io::Error::other("injected atomic append fault")).into(),
            );
        }
        // Prevent a racing CreateIfMissing opener from seeding one of our new
        // documents. No holder is started here; opening after commit loads it.
        let slots = lib.docs.lock().unwrap_or_else(|e| e.into_inner());
        if new_documents.iter().any(|n| slots.contains_key(&n.id)) {
            return Err(StoreError::invalid("atomic inventory", "new document is opening").into());
        }
        {
            let conn = lib.writer();
            let tx = conn.unchecked_transaction().map_err(StoreError::from)?;
            if let Some(book) = owner {
                for h in &handles {
                    let actual: Option<String> = tx
                        .query_row(
                            "SELECT book_id FROM loro_doc WHERE doc_id = ?1",
                            [h.doc_id()],
                            |r| r.get(0),
                        )
                        .map_err(StoreError::from)?;
                    if actual.as_deref() != Some(book) {
                        return Err(
                            StoreError::invalid("atomic author edit", "foreign document").into(),
                        );
                    }
                }
            }
            if let Some(scope) = &scope {
                let actual: BTreeMap<String, Option<String>> = tx
                    .prepare(
                        "SELECT doc_id, book_id FROM loro_doc WHERE substr(doc_id, 1, ?1) = ?2",
                    )
                    .map_err(StoreError::from)?
                    .query_map(
                        params![scope.prefix.chars().count() as i64, scope.prefix],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(StoreError::from)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(StoreError::from)?;
                let expected: BTreeMap<_, _> = handles
                    .iter()
                    .filter(|h| h.doc_id().starts_with(scope.prefix))
                    .map(|h| (h.doc_id().to_owned(), Some(scope.book_id.to_owned())))
                    .chain(
                        new_documents
                            .iter()
                            .filter(|n| n.pre_registered)
                            .map(|n| (n.id.clone(), Some(scope.book_id.to_owned()))),
                    )
                    .collect();
                if actual != expected {
                    return Err(StoreError::invalid(
                        "atomic inventory",
                        "document set or owner changed",
                    )
                    .into());
                }
                for h in &handles {
                    let owner: Option<String> = tx
                        .query_row(
                            "SELECT book_id FROM loro_doc WHERE doc_id = ?1",
                            [h.doc_id()],
                            |r| r.get(0),
                        )
                        .map_err(StoreError::from)?;
                    if owner.as_deref() != Some(scope.book_id) {
                        return Err(
                            StoreError::invalid("atomic inventory", "foreign document").into()
                        );
                    }
                }
                for n in new_documents {
                    crate::purge::check_creatable(&tx, &n.id, Some(scope.book_id))?;
                    if n.pre_registered {
                        let occupied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM loro_update WHERE doc_id=?1) OR EXISTS(SELECT 1 FROM loro_snapshot WHERE doc_id=?1) OR EXISTS(SELECT 1 FROM loro_head WHERE doc_id=?1)",[&n.id],|r|r.get(0)).map_err(StoreError::from)?;
                        let kind: String = tx
                            .query_row("SELECT kind FROM loro_doc WHERE doc_id=?1", [&n.id], |r| {
                                r.get(0)
                            })
                            .map_err(StoreError::from)?;
                        if occupied || kind != n.kind {
                            return Err(StoreError::invalid(
                                "atomic inventory",
                                "unmaterialized document changed",
                            )
                            .into());
                        }
                    } else {
                        tx.execute("INSERT INTO loro_doc (doc_id, kind, book_id, created_ms) VALUES (?1, ?2, ?3, ?4)", params![n.id, n.kind, scope.book_id, now_ms()]).map_err(StoreError::from)?;
                    }
                }
            }
            for (id, bytes, vv, frontiers) in &updates {
                if !bytes.is_empty() {
                    let seq = handles
                        .iter()
                        .position(|h| h.doc_id() == id)
                        .map(|i| reservations[i].1.seq)
                        .unwrap_or(1);
                    record_append(&tx, id, seq, bytes, &origin, now_ms(), vv, frontiers)?;
                }
            }
            tx.commit().map_err(StoreError::from)?;
        }
        drop(slots);
        // The updates have been tested on identical copies. After this point
        // a crash is recovered by loading the already-committed SQLite rows.
        let after_install = installed;
        let (installed, installed_rx) = mpsc::channel();
        let (finished, finished_rx) = mpsc::channel();
        let mut release = Vec::new();
        let mut updates: BTreeMap<_, _> = updates
            .into_iter()
            .map(|(id, bytes, _, _)| (id, bytes))
            .collect();
        for (h, (decision, _)) in handles.iter().zip(reservations) {
            let (announce, receive) = mpsc::channel();
            decision
                .send(Apply {
                    bytes: updates
                        .remove(h.doc_id())
                        .expect("reserved document update"),
                    local: local.remove(h.doc_id()),
                    origin: origin.clone(),
                    installed: installed.clone(),
                    announce: receive,
                    finished: finished.clone(),
                })
                .expect("reserved holder remains alive until released");
            release.push(announce);
        }
        for _ in &release {
            installed_rx
                .recv()
                .expect("reserved holder installed committed update");
        }
        if let Some(installed) = after_install {
            installed();
        }
        for announce in &release {
            let _ = announce.send(());
        }
        for _ in &release {
            finished_rx
                .recv()
                .expect("reserved holder announced committed update");
        }
        Ok(result)
    }
}

impl Holder {
    pub(super) fn reserve(&mut self, request: Request) {
        let prepare = (|| -> Result<Reserved> {
            self.settle()?;
            let copy = self.lib.new_doc();
            copy.import(&self.doc.export(ExportMode::Snapshot)?)?;
            copy.set_peer_id(self.doc.peer_id())?;
            Ok(Reserved {
                lib: self.lib.clone(),
                doc: copy,
                seq: self.next_seq,
            })
        })();
        let ok = prepare.is_ok();
        if request.ready.send(prepare).is_err() || !ok {
            return;
        }
        let Ok(apply) = request.decision.recv() else {
            return;
        };
        let changed = !apply.bytes.is_empty();
        let seq = self.next_seq;
        if changed {
            if let Some(local) = apply.local {
                local.install(&self.doc, &apply.bytes);
            } else {
                self.doc
                    .import_with(&apply.bytes, &apply.origin.to_string())
                    .expect("update validated on an identical reserved document");
            }
            self.last_vv = self.doc.oplog_vv();
            self.next_seq += 1;
            self.index_dirty = true;
            self.counters.commits.fetch_add(1, Ordering::Relaxed);
            self.counters
                .pending_updates
                .fetch_add(1, Ordering::Relaxed);
            self.counters
                .pending_bytes
                .fetch_add(apply.bytes.len(), Ordering::Relaxed);
        }
        let _ = apply.installed.send(());
        let _ = apply.announce.recv();
        if changed {
            self.deliver(seq, &apply.origin, &self.doc.oplog_frontiers());
        }
        let _ = apply.finished.send(());
    }
}
