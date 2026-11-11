//! Entry-wide periodic/close checkpoints, following F2's existing cadence.
//! Holder callbacks only enqueue; a worker calls the complete atomic command.
use dr_doc::v3::BorrowedBookV3;
use dr_model::{DocId, id::BookId};
use dr_store::{LibrarySubscription, StoreEvent};
use dr_workspace::{Actor, Workspace, commands::v3::snapshots as api};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub const PERIODIC_INTERVAL: Duration =
    Duration::from_millis(dr_store::history::PERIODIC_INTERVAL_MS as u64);

enum Message {
    Changed(String),
    Stop(mpsc::Sender<Result<(), String>>),
    #[cfg(test)]
    DirtySnapshot(mpsc::Sender<BTreeSet<(String, String)>>),
}
pub struct AutomaticHistory {
    send: mpsc::Sender<Message>,
    worker: Option<thread::JoinHandle<()>>,
    subscription: Option<LibrarySubscription>,
}
type Owners = BTreeMap<(String, String), String>;
type BookOwners = BTreeMap<String, String>;

fn initial_book_heads(ws: &Workspace) -> BTreeMap<BookId, loro::Frontiers> {
    let Ok(docs) = ws.library().docs(None, Some("book")) else {
        return BTreeMap::new();
    };
    let mut heads = BTreeMap::new();
    for info in docs {
        let Ok(DocId::Book(book)) = DocId::parse(&info.doc_id) else {
            continue;
        };
        if let Ok(Some(head)) = ws.library().head(&info.doc_id) {
            heads.insert(book, head.frontiers);
        }
    }
    heads
}

fn owners(ws: &Workspace) -> Result<Owners, String> {
    let mut out = BTreeMap::new();
    for info in ws
        .library()
        .docs(None, Some("book"))
        .map_err(|e| e.to_string())?
    {
        let Ok(DocId::Book(id)) = DocId::parse(&info.doc_id) else {
            continue;
        };
        for (entry, hash) in book_owners(ws, &id)? {
            out.insert((id.to_string(), entry), hash);
        }
    }
    Ok(out)
}
fn owners_from_doc(doc: &loro::LoroDoc, book: &BookId) -> Result<BookOwners, String> {
    if !dr_doc::v3::is_v3_doc(doc) {
        return Ok(BTreeMap::new());
    }
    let b = BorrowedBookV3::new(doc, book).map_err(|e| e.to_string())?;
    let v = b.view();
    let entries = v.entries_raw();
    let mut out = BTreeMap::new();
    for e in &entries {
        let value = v.entry_owned_raw_state(&e.id).expect("entry exists");
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        out.insert(e.id.to_string(), dr_store::digest::sha256_hex(&bytes));
    }
    Ok(out)
}
fn book_owners(ws: &Workspace, book: &BookId) -> Result<BookOwners, String> {
    let d = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(|e| e.to_string())?;
    owners_from_doc(&d, book)
}
fn book_owners_at(
    ws: &Workspace,
    book: &BookId,
    frontiers: &loro::Frontiers,
) -> Result<BookOwners, String> {
    let d = ws
        .library()
        .load_copy_at(&format!("book:{book}"), frontiers)
        .map_err(|e| e.to_string())?;
    owners_from_doc(&d, book)
}
fn capture(
    ws: &Workspace,
    key: &(String, String),
    reason: api::CaptureReason,
) -> Result<(), String> {
    match ws.run::<api::Capture>(
        &Actor::User,
        api::CaptureIn {
            target: api::EntryIn {
                book: key.0.clone(),
                entry: key.1.clone(),
            },
            reason,
        },
    ) {
        Ok(_) | Err(dr_workspace::WsError::NotFound { what: "entry", .. }) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
impl AutomaticHistory {
    pub fn start(ws: Workspace) -> Self {
        Self::start_with_interval(ws, PERIODIC_INTERVAL)
    }

    pub fn start_with_interval(ws: Workspace, interval: Duration) -> Self {
        // Capture pre-subscription book heads synchronously (`loro_head` point
        // reads only) so an immediate foreground edit cannot race the worker's
        // baseline read and cause every entry in the book to be marked dirty.
        let mut initial_heads = initial_book_heads(&ws);
        let (send, rx) = mpsc::channel();
        let events = send.clone();
        let subscription = ws.library().subscribe(move |event| {
            if let StoreEvent::Doc(e) = event && dr_store::history::records_periodic(&e.origin) {
                // Book counters, comments, shared templates and checkpoints
                // do not change entry-owned content. In particular they must
                // not materialize every entry's lazy body as a side effect.
                let relevant = match DocId::parse(&e.doc_id) {
                    Ok(DocId::Body(_)) => true,
                    Ok(DocId::Book(_)) => e.changes.iter().any(|c| {
                        let root = c.path.first().map(|(id, _)| id).unwrap_or(&c.target);
                        matches!(
                            root,
                            loro::ContainerID::Root { name, .. }
                                if matches!(
                                    name.as_str(),
                                    "entries" | "patches" | "plot_grids" | "memberships" | "relations"
                                )
                        )
                    }),
                    _ => false,
                };
                if relevant {
                    let _ = events.send(Message::Changed(e.doc_id.to_string()));
                }
            }
        });
        let worker = thread::spawn(move || {
            let mut known: BTreeMap<BookId, BookOwners> = BTreeMap::new();
            let mut dirty: BTreeSet<(String, String)> = BTreeSet::new();
            let mut deadline: Option<Instant> = None;
            loop {
                let message = match deadline {
                    Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now()))
                    {
                        Ok(message) => message,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            deadline = None;
                            let pending = std::mem::take(&mut dirty);
                            for key in pending {
                                if let Err(e) = capture(&ws, &key, api::CaptureReason::Periodic) {
                                    log::warn!("periodic entry checkpoint failed: {e}");
                                    dirty.insert(key);
                                }
                            }
                            if !dirty.is_empty() {
                                deadline = Some(Instant::now() + interval);
                            }
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    },
                    None => match rx.recv() {
                        Ok(message) => message,
                        Err(_) => break,
                    },
                };
                match message {
                    Message::Changed(doc) => {
                        match DocId::parse(&doc) {
                            Ok(DocId::Body(body)) => {
                                if let Ok(Some(info)) = ws.library().doc_info(&doc)
                                    && let Some(book) = info.book_id
                                {
                                    dirty.insert((book, body.entry().to_string()));
                                }
                            }
                            Ok(DocId::Book(book)) => {
                                if !known.contains_key(&book) {
                                    match initial_heads.get(&book) {
                                        Some(frontiers) => {
                                            match book_owners_at(&ws, &book, frontiers) {
                                                Ok(owners) => {
                                                    initial_heads.remove(&book);
                                                    known.insert(book.clone(), owners);
                                                }
                                                Err(e) => {
                                                    log::warn!(
                                                        "entry checkpoint baseline load failed: {e}"
                                                    );
                                                }
                                            }
                                        }
                                        None => {
                                            known.insert(book.clone(), BTreeMap::new());
                                        }
                                    }
                                }
                                if let Some(prev) = known.get(&book) {
                                    match book_owners(&ws, &book) {
                                        Ok(current) => {
                                            dirty.retain(|(b, e)| {
                                                b != book.as_str() || current.contains_key(e)
                                            });
                                            for (entry, hash) in &current {
                                                if prev.get(entry) != Some(hash) {
                                                    dirty.insert((book.to_string(), entry.clone()));
                                                }
                                            }
                                            known.insert(book, current);
                                        }
                                        Err(e) => {
                                            log::warn!("entry checkpoint observation failed: {e}")
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                        if dirty.is_empty() {
                            deadline = None;
                        } else {
                            deadline.get_or_insert_with(|| Instant::now() + interval);
                        }
                    }
                    Message::Stop(done) => {
                        let result = capture_on_close(&ws);
                        let _ = done.send(result);
                        break;
                    }
                    #[cfg(test)]
                    Message::DirtySnapshot(reply) => {
                        let _ = reply.send(dirty.clone());
                    }
                }
            }
        });
        Self {
            send,
            worker: Some(worker),
            subscription: Some(subscription),
        }
    }

    #[cfg(test)]
    fn dirty_for_test(&self) -> BTreeSet<(String, String)> {
        let (tx, rx) = mpsc::channel();
        self.send.send(Message::DirtySnapshot(tx)).unwrap();
        rx.recv().unwrap()
    }

    /// Stop admission, drain previously queued writes and save dirty entries.
    /// Call off the foreground thread; a failed close checkpoint blocks the
    /// ordinary release flow and remains recoverable through a manual retry.
    pub fn finish(mut self) -> Result<(), String> {
        self.subscription.take();
        let (done, rx) = mpsc::channel();
        self.send
            .send(Message::Stop(done))
            .map_err(|e| e.to_string())?;
        let result = rx.recv().map_err(|e| e.to_string())?;
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "entry checkpoint worker panicked".to_owned())?;
        }
        result
    }
}
impl Drop for AutomaticHistory {
    fn drop(&mut self) {
        self.subscription.take();
        if self.worker.is_some() {
            let (done, _) = mpsc::channel();
            let _ = self.send.send(Message::Stop(done));
        }
    }
}

/// Last sweep after all ordinary release services have settled. The command
/// compares entry-owned content, so checkpoint metadata and other books do not
/// manufacture new versions. Also usable by a host's explicit close flow.
pub fn capture_on_close(ws: &Workspace) -> Result<(), String> {
    for key in owners(ws)?.keys() {
        capture(ws, key, api::CaptureReason::Close)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v3::tests::{call, setup};
    use serde_json::json;
    #[test]
    fn worker_drains_periodic_and_close_points_and_releases_library_handles() {
        let (dir, ws, t) = setup();
        let service = AutomaticHistory::start(ws.clone());
        call(
            &ws,
            "module.set_prose",
            json!({"book":t.book,"owner":t.entry,"module":"mod-prose","paragraphs":[{"text":"Synthetic periodic write"}]}),
        );
        service.finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
        assert!(!points.is_empty());
        let latest = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: t.clone(),
                    point: points[0].id.clone(),
                },
            )
            .unwrap()
            .output;
        assert!(
            latest
                .bodies
                .iter()
                .any(|b| b.text.contains("Synthetic periodic write"))
        );
        call(
            &ws,
            "entry.update",
            json!({"book":t.book,"id":t.entry,"title":"Metadata after worker stopped"}),
        );
        capture_on_close(&ws).unwrap();
        ws.shutdown().unwrap();
        let ws = Workspace::open_dir(dir.path(), "test").unwrap();
        let points = ws.run::<api::List>(&Actor::User, t).unwrap().output;
        assert_eq!(points[0].title, "Metadata after worker stopped");
        assert_eq!(points[0].reason, "close");
        ws.shutdown().unwrap();
    }
    #[test]
    fn failed_close_preserves_current_text_and_restarted_worker_can_retry() {
        let (_dir, ws, t) = setup();
        let service = AutomaticHistory::start(ws.clone());
        ws.library().local_transaction(|tx| {tx.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'book:%' BEGIN SELECT RAISE(ABORT,'checkpoint fault'); END;")?;Ok(())}).unwrap();
        call(
            &ws,
            "module.set_prose",
            json!({"book":t.book,"owner":t.entry,"module":"mod-prose","paragraphs":[{"text":"Author text survives checkpoint failure"}]}),
        );
        assert!(service.finish().is_err());
        assert_eq!(
            call(
                &ws,
                "module.read_prose",
                json!({"book":t.book,"owner":t.entry,"module":"mod-prose"})
            )["paragraphs"][0]["text"],
            "Author text survives checkpoint failure"
        );
        ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER reject_checkpoint")?;
                Ok(())
            })
            .unwrap();
        AutomaticHistory::start(ws.clone()).finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
        let preview = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: t,
                    point: points[0].id.clone(),
                },
            )
            .unwrap()
            .output;
        assert!(
            preview
                .bodies
                .iter()
                .any(|b| b.text.contains("Author text survives checkpoint failure"))
        );
        ws.shutdown().unwrap();
    }

    #[test]
    fn unrelated_book_metadata_does_not_schedule_entry_periodic_checkpoints() {
        let (_dir, ws, t) = setup();
        let service = AutomaticHistory::start(ws.clone());
        call(
            &ws,
            "book.update",
            json!({"book":t.book,"summary":"Synthetic book-level setting"}),
        );
        service.finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t).unwrap().output;
        assert!(!points.is_empty());
        assert!(points.iter().all(|p| p.reason == "close"));
        ws.shutdown().unwrap();
    }

    #[test]
    fn immediate_foreground_edits_enqueue_only_touched_entries_without_racing_book_head() {
        let (_dir, ws, t) = setup();
        let entries = call(&ws, "entry.list", json!({"book": t.book, "all": true}))
            .as_array()
            .unwrap()
            .clone();
        assert!(
            entries.len() > 10,
            "Preset::Tiny should contain dozens of entries"
        );
        let root_ids: Vec<String> = entries
            .iter()
            .filter(|e| e["parent"].is_null())
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        let untouched = entries
            .iter()
            .find(|e| !e["parent"].is_null() && e["id"].as_str() != Some(t.entry.as_str()))
            .expect("untouched non-root entry")["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let book_doc = format!("book:{}", t.book);

        let service = AutomaticHistory::start(ws.clone());
        let created_id = call(
            &ws,
            "entry.create",
            json!({"book": t.book, "template": "tpl-chapter", "title": "Immediate foreground entry"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        call(
            &ws,
            "entry.update",
            json!({"book": t.book, "id": t.entry, "title": "Edited chapter"}),
        );
        let head_after_edits = ws
            .library()
            .head(&book_doc)
            .unwrap()
            .expect("book head")
            .frontiers;

        let mut expected_dirty = BTreeSet::from([
            (t.book.clone(), created_id),
            (t.book.clone(), t.entry.clone()),
        ]);
        for root_id in &root_ids {
            expected_dirty.insert((t.book.clone(), root_id.clone()));
        }

        let dirty = service.dirty_for_test();
        assert_eq!(dirty, expected_dirty);
        assert!(!dirty.contains(&(t.book.clone(), untouched.clone())));
        assert_eq!(
            ws.library()
                .head(&book_doc)
                .unwrap()
                .expect("book head")
                .frontiers,
            head_after_edits,
            "AutomaticHistory must not advance book oplog frontiers before the periodic interval"
        );
        assert!(
            ws.run::<api::List>(&Actor::User, t.clone())
                .unwrap()
                .output
                .is_empty(),
            "no periodic checkpoint should be written immediately on foreground edit"
        );

        ws.undo(&Actor::User).unwrap();
        ws.undo(&Actor::User).unwrap();
        let head_after_undo = ws
            .library()
            .head(&book_doc)
            .unwrap()
            .expect("book head")
            .frontiers;
        let dirty_after_undo = service.dirty_for_test();
        assert!(
            !dirty_after_undo.contains(&(t.book.clone(), untouched)),
            "undoing back to baseline must not mark untouched entries dirty"
        );
        assert_eq!(
            ws.library()
                .head(&book_doc)
                .unwrap()
                .expect("book head")
                .frontiers,
            head_after_undo,
            "AutomaticHistory must not advance book oplog frontiers after undo"
        );

        service.finish().unwrap();
        let points = ws.run::<api::List>(&Actor::User, t).unwrap().output;
        assert!(!points.is_empty());
        assert!(points.iter().all(|p| p.reason == "close"));
        ws.shutdown().unwrap();
    }

    #[test]
    fn periodic_cadence_captures_dirty_entries_after_interval_elapses() {
        let (_dir, ws, t) = setup();
        let untouched = call(&ws, "entry.list", json!({"book": t.book, "all": true}))
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["id"].as_str())
            .find(|id| *id != t.entry)
            .expect("untouched sibling entry")
            .to_owned();

        let service = AutomaticHistory::start_with_interval(ws.clone(), Duration::from_millis(25));
        call(
            &ws,
            "module.set_prose",
            json!({
                "book": t.book,
                "owner": t.entry,
                "module": "mod-prose",
                "paragraphs": [{"text": "Timed periodic capture"}]
            }),
        );

        let wait_until = Instant::now() + Duration::from_secs(5);
        let points = loop {
            let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
            if !points.is_empty() {
                break points;
            }
            assert!(
                Instant::now() < wait_until,
                "periodic checkpoint did not fire within deadline"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(service.dirty_for_test().is_empty());
        assert_eq!(points[0].reason, "periodic");
        let preview = ws
            .run::<api::Preview>(
                &Actor::User,
                api::PointIn {
                    target: t.clone(),
                    point: points[0].id.clone(),
                },
            )
            .unwrap()
            .output;
        assert!(
            preview
                .bodies
                .iter()
                .any(|b| b.text.contains("Timed periodic capture"))
        );
        assert!(
            ws.run::<api::List>(
                &Actor::User,
                api::EntryIn {
                    book: t.book.clone(),
                    entry: untouched,
                },
            )
            .unwrap()
            .output
            .is_empty(),
            "untouched sibling entries must not receive periodic checkpoints"
        );

        service.finish().unwrap();
        ws.shutdown().unwrap();
    }
}
