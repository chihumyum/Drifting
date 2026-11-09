//! An opt-in multi-document transaction. Existing holder jobs are unchanged.
//! Reserve holders in id order, edit detached copies, append all updates in
//! one SQLite transaction, install every copy, then announce the changes.
//! Dropping a reservation before commit releases it without touching live data.
use super::*;
use std::collections::BTreeMap;

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
        if handles.is_empty() || origin != Origin::Command {
            return Err(StoreError::invalid(
                "atomic edit",
                "requires documents and command origin",
            )
            .into());
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
        let copies: BTreeMap<_, _> = handles
            .iter()
            .zip(&reservations)
            .map(|(h, (_, r))| (h.doc_id().to_owned(), r.doc.clone()))
            .collect();
        let before: BTreeMap<_, _> = copies
            .iter()
            .map(|(id, d)| (id.clone(), d.oplog_vv()))
            .collect();
        for d in copies.values() {
            d.set_next_commit_options(CommitOptions::new().origin(&origin.to_string()));
        }
        let result = edit(&copies)?;
        let mut updates = Vec::new();
        for (id, d) in &copies {
            d.commit_with(CommitOptions::new().origin(&origin.to_string()));
            let vv = d.oplog_vv();
            let bytes = if vv == before[id] {
                Vec::new()
            } else {
                d.export(ExportMode::updates(&before[id]))
                    .map_err(StoreError::from)?
            };
            updates.push((id, bytes, vv, d.oplog_frontiers()));
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
        {
            let conn = lib.writer();
            let tx = conn.unchecked_transaction().map_err(StoreError::from)?;
            for ((id, bytes, vv, frontiers), (_, r)) in updates.iter().zip(&reservations) {
                if !bytes.is_empty() {
                    record_append(&tx, id, r.seq, bytes, &origin, now_ms(), vv, frontiers)?;
                }
            }
            tx.commit().map_err(StoreError::from)?;
        }
        // The updates have been tested on identical copies. After this point
        // a crash is recovered by loading the already-committed SQLite rows.
        let (installed, installed_rx) = mpsc::channel();
        let (finished, finished_rx) = mpsc::channel();
        let mut release = Vec::new();
        for ((decision, _), (_, bytes, _, _)) in reservations.into_iter().zip(updates) {
            let (announce, receive) = mpsc::channel();
            decision
                .send(Apply {
                    bytes,
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
            self.doc
                .import_with(&apply.bytes, &apply.origin.to_string())
                .expect("update validated on an identical reserved document");
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
