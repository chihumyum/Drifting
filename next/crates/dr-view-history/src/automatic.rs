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

/// The fingerprint of every entry of a book: what the entry owns and where
/// it is (`BookViewV3::entry_change_state`), read for all of them in one
/// pass. An entry's fingerprint names no other entry but its parent, so a
/// sibling created, deleted or moved leaves it as it was.
fn owners_from_doc(doc: &loro::LoroDoc, book: &BookId) -> Result<BookOwners, String> {
    if !dr_doc::v3::is_v3_doc(doc) {
        return Ok(BTreeMap::new());
    }
    let b = BorrowedBookV3::new(doc, book).map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for (entry, state) in b.view().entry_change_states() {
        let bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
        out.insert(entry.to_string(), dr_store::digest::sha256_hex(&bytes));
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
/// Whether a persisted change can have changed what some entry owns: an
/// entry's prose, or a commit to the book document that touched the entry
/// tree or a collection of entry-owned records. Only then does the worker
/// look at the book's entries (one pass over all of them).
///
/// Book counters (the writing days, once a minute), saved checkpoints,
/// comments and shared templates do not change entry-owned content. In
/// particular they must not materialize every entry's lazy body as a side
/// effect.
fn concerns_entries(e: &dr_store::DocEvent) -> bool {
    if !dr_store::history::records_periodic(&e.origin) {
        return false;
    }
    match DocId::parse(&e.doc_id) {
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
            if let StoreEvent::Doc(e) = event
                && concerns_entries(e)
            {
                let _ = events.send(Message::Changed(e.doc_id.to_string()));
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
///
/// The command is called only for the entries it has something to do for
/// (`entries_due_for_capture`: the same comparison, made once for the whole
/// book), so a quit costs what changed and not one copy of the book document
/// per entry. Which entries earn a checkpoint is the same either way.
pub fn capture_on_close(ws: &Workspace) -> Result<(), String> {
    for info in ws
        .library()
        .docs(None, Some("book"))
        .map_err(|e| e.to_string())?
    {
        let Ok(DocId::Book(book)) = DocId::parse(&info.doc_id) else {
            continue;
        };
        let due = api::entries_due_for_capture(ws, book.as_str()).map_err(|e| e.to_string())?;
        for entry in due {
            let key = (book.to_string(), entry);
            capture(ws, &key, api::CaptureReason::Close)?;
        }
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
    fn a_writing_day_or_a_saved_checkpoint_asks_for_no_look_at_the_entries() {
        let (_dir, ws, t) = setup();
        let book_doc = format!("book:{}", t.book);
        // Every persisted change, and whether the worker would be told.
        let seen: std::sync::Arc<std::sync::Mutex<Vec<(String, bool)>>> = Default::default();
        let sink = seen.clone();
        let _subscription = ws.library().subscribe(move |event| {
            if let StoreEvent::Doc(e) = event {
                sink.lock()
                    .unwrap()
                    .push((e.doc_id.to_string(), concerns_entries(e)));
            }
        });
        let changes = || std::mem::take(&mut *seen.lock().unwrap());

        // The recorder's minute.
        call(
            &ws,
            "writing_day.record",
            json!({"book": t.book, "device": "device-000000000000000000000001",
                "day": "2026-11-12", "words": 120}),
        );
        assert_eq!(changes(), [(book_doc.clone(), false)]);

        // A saved checkpoint: the manifest is a commit to the book document
        // and no change to any entry. (The entry's first point may also
        // create bodies it has not written yet: prose, which is.)
        for _ in 0..2 {
            call(
                &ws,
                "entry_snapshot.create",
                json!({"book": t.book, "entry": t.entry}),
            );
            let saved = changes();
            assert!(
                saved.contains(&(book_doc.clone(), false)),
                "the manifest: {saved:?}"
            );
            assert!(
                saved
                    .iter()
                    .all(|(doc, told)| *told == doc.starts_with("body:")),
                "{saved:?}"
            );
        }
        assert_eq!(
            changes(),
            [],
            "and the second point wrote nothing but its manifest"
        );

        // A book-level setting is none either; an entry's own change is.
        call(
            &ws,
            "book.update",
            json!({"book": t.book, "summary": "Synthetic book-level setting"}),
        );
        assert_eq!(changes(), [(book_doc.clone(), false)]);
        call(
            &ws,
            "entry.update",
            json!({"book": t.book, "id": t.entry, "title": "Synthetic renamed"}),
        );
        assert_eq!(changes(), [(book_doc, true)]);
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

        // The entry created and the entry edited, and nothing else: the new
        // entry's siblings at the top level did not change.
        let expected_dirty = BTreeSet::from([
            (t.book.clone(), created_id),
            (t.book.clone(), t.entry.clone()),
        ]);

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

    /// Every entry of the book, trashed ones too, as `entry.list` gives them.
    fn entries(ws: &Workspace, book: &str) -> Vec<serde_json::Value> {
        call(
            ws,
            "entry.list",
            json!({"book": book, "all": true, "trashed": true}),
        )
        .as_array()
        .unwrap()
        .clone()
    }
    fn ids(entries: &[serde_json::Value]) -> BTreeSet<String> {
        entries
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect()
    }
    /// The checkpoints of every entry: `(id, reason)`, newest first.
    fn checkpoints(ws: &Workspace, book: &str) -> BTreeMap<String, Vec<(String, String)>> {
        ids(&entries(ws, book))
            .into_iter()
            .map(|entry| {
                let points = ws
                    .run::<api::List>(
                        &Actor::User,
                        api::EntryIn {
                            book: book.to_owned(),
                            entry: entry.clone(),
                        },
                    )
                    .unwrap()
                    .output
                    .into_iter()
                    .map(|p| (p.id, p.reason))
                    .collect();
                (entry, points)
            })
            .collect()
    }
    /// The chapter of `setup`, with its parent and the titles beside it.
    fn family(ws: &Workspace, t: &api::EntryIn) -> (serde_json::Value, Vec<String>) {
        let all = entries(ws, &t.book);
        let parent = all.iter().find(|e| e["id"] == t.entry.as_str()).unwrap()["parent"].clone();
        assert!(parent.is_string(), "the seed keeps its chapters in a level");
        let siblings = all
            .iter()
            .filter(|e| e["parent"] == parent)
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        (parent, siblings)
    }

    #[test]
    fn a_sibling_created_moved_trashed_or_restored_dirties_and_checkpoints_no_other_entry() {
        let (_dir, ws, t) = setup();
        // Every entry has its first checkpoint: from here on only a change
        // earns another.
        capture_on_close(&ws).unwrap();
        let before = checkpoints(&ws, &t.book);
        assert!(before.len() > 10 && before.values().all(|points| points.len() == 1));
        let (parent, siblings) = family(&ws, &t);
        assert!(siblings.len() > 1, "the chapter has siblings");

        let service = AutomaticHistory::start(ws.clone());
        let sibling = call(
            &ws,
            "entry.create",
            json!({"book": t.book, "parent": parent, "template": "tpl-chapter", "title": "A sibling arrives"}),
        );
        assert_eq!(sibling["parent"], parent);
        let sibling = sibling["id"].as_str().unwrap().to_owned();
        let only_the_sibling = BTreeSet::from([(t.book.clone(), sibling.clone())]);
        assert_eq!(service.dirty_for_test(), only_the_sibling, "created");
        call(
            &ws,
            "entry.move",
            json!({"book": t.book, "id": sibling, "parent": parent, "index": 0}),
        );
        assert_eq!(
            family(&ws, &t).1[0],
            sibling,
            "it moved in front of them all"
        );
        assert_eq!(service.dirty_for_test(), only_the_sibling, "moved");
        call(&ws, "entry.trash", json!({"book": t.book, "id": sibling}));
        assert_eq!(service.dirty_for_test(), only_the_sibling, "trashed");
        call(&ws, "entry.restore", json!({"book": t.book, "id": sibling}));
        assert_eq!(service.dirty_for_test(), only_the_sibling, "restored");

        service.finish().unwrap();
        let mut after = checkpoints(&ws, &t.book);
        let own = after.remove(&sibling).expect("the sibling's checkpoints");
        assert_eq!(own.len(), 1);
        assert_eq!(own[0].1, "close");
        assert_eq!(after, before, "no other entry earned a checkpoint");
        ws.shutdown().unwrap();
    }

    #[test]
    fn an_entry_moved_among_its_siblings_or_to_another_parent_is_dirty_and_earns_a_checkpoint() {
        let (_dir, ws, t) = setup();
        capture_on_close(&ws).unwrap();
        let mut expected = checkpoints(&ws, &t.book);
        let (parent, siblings) = family(&ws, &t);
        let at = siblings.iter().position(|id| *id == t.entry).unwrap();
        // To the other end of its level.
        let index = if at == 0 { siblings.len() - 1 } else { 0 };
        assert!(siblings.len() > 1, "the chapter has siblings");
        let grandparent = entries(&ws, &t.book)
            .iter()
            .find(|e| e["id"] == parent)
            .unwrap()["parent"]
            .clone();
        let only_the_chapter = BTreeSet::from([(t.book.clone(), t.entry.clone())]);

        for (step, to, index) in [
            ("among its siblings", &parent, index),
            ("to another parent", &grandparent, 0),
        ] {
            let service = AutomaticHistory::start(ws.clone());
            call(
                &ws,
                "entry.move",
                json!({"book": t.book, "id": t.entry, "parent": to, "index": index}),
            );
            let now = entries(&ws, &t.book);
            let moved = now.iter().find(|e| e["id"] == t.entry.as_str()).unwrap();
            assert_eq!(&moved["parent"], to, "{step}");
            assert_eq!(service.dirty_for_test(), only_the_chapter, "{step}");
            service.finish().unwrap();
            let mut after = checkpoints(&ws, &t.book);
            let own = after.remove(&t.entry).unwrap();
            let known = expected.remove(&t.entry).unwrap();
            assert_eq!(own.len(), known.len() + 1, "{step}");
            assert_eq!(own[0].1, "close", "{step}");
            assert_eq!(own[1..], known[..], "{step}");
            assert_eq!(
                after, expected,
                "{step}: no other entry earned a checkpoint"
            );
            expected.insert(t.entry.clone(), own);
        }
        ws.shutdown().unwrap();
    }

    #[test]
    fn the_close_sweep_calls_the_command_for_exactly_the_entries_it_would_save() {
        let (_dir, ws, t) = setup();
        let due = |ws: &Workspace| -> BTreeSet<String> {
            let due = api::entries_due_for_capture(ws, &t.book).unwrap();
            let set: BTreeSet<String> = due.iter().cloned().collect();
            assert_eq!(set.len(), due.len(), "each entry once");
            set
        };
        let all = entries(&ws, &t.book);
        assert_eq!(
            due(&ws),
            ids(&all),
            "without a checkpoint every entry is due"
        );
        capture_on_close(&ws).unwrap();
        assert_eq!(due(&ws), BTreeSet::new());

        // A title, a body, a field, a new sibling and a move.
        let chapters: Vec<String> = all
            .iter()
            .filter(|e| e["template"] == "tpl-chapter" && e["deleted_at"].is_null())
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        assert!(chapters.len() >= 3, "{chapters:?}");
        let (parent, _) = family(&ws, &t);
        call(
            &ws,
            "entry.update",
            json!({"book": t.book, "id": chapters[0], "title": "A new title"}),
        );
        call(
            &ws,
            "module.set_prose",
            json!({"book": t.book, "owner": chapters[1], "module": "mod-prose", "paragraphs": [{"text": "A new body"}]}),
        );
        let created = call(
            &ws,
            "entry.create",
            json!({"book": t.book, "parent": parent, "template": "tpl-chapter", "title": "A new sibling"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let last = chapters.last().unwrap();
        let home = all.iter().find(|e| e["id"] == last.as_str()).unwrap()["parent"].clone();
        call(
            &ws,
            "entry.move",
            json!({"book": t.book, "id": last, "parent": home, "index": 0}),
        );
        let changed = BTreeSet::from([
            chapters[0].clone(),
            chapters[1].clone(),
            created.clone(),
            last.clone(),
        ]);
        assert_eq!(changed.len(), 4);
        assert_eq!(due(&ws), changed);

        // The command itself, entry by entry: it saves for those and for no
        // other, so leaving the others out changes nothing.
        let before = checkpoints(&ws, &t.book);
        for (entry, known) in &before {
            let got = ws
                .run::<api::Capture>(
                    &Actor::User,
                    api::CaptureIn {
                        target: api::EntryIn {
                            book: t.book.clone(),
                            entry: entry.clone(),
                        },
                        reason: api::CaptureReason::Close,
                    },
                )
                .unwrap()
                .output;
            if changed.contains(entry) {
                assert!(known.iter().all(|(id, _)| *id != got.id), "{entry} is new");
            } else {
                assert_eq!(got.id, known[0].0, "{entry} was left alone");
            }
        }
        let after = checkpoints(&ws, &t.book);
        for (entry, known) in &before {
            let more = usize::from(changed.contains(entry));
            assert_eq!(after[entry].len(), known.len() + more, "{entry}");
        }
        assert_eq!(due(&ws), BTreeSet::new());

        // A template gains a prose module: a capture gives each of its
        // entries the missing body, so they are due though nothing they own
        // changed.
        call(
            &ws,
            "entry_template.put_module",
            json!({"book": t.book, "template": "tpl-chapter", "module": {"id": "second", "kind": "prose", "name": "second"}}),
        );
        let of_the_template: BTreeSet<String> = entries(&ws, &t.book)
            .iter()
            .filter(|e| e["template"] == "tpl-chapter")
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        assert!(of_the_template.is_superset(&changed));
        assert_eq!(due(&ws), of_the_template);
        capture_on_close(&ws).unwrap();
        assert_eq!(due(&ws), BTreeSet::new());
        let last = checkpoints(&ws, &t.book);
        for (entry, known) in &after {
            let more = usize::from(of_the_template.contains(entry));
            assert_eq!(last[entry].len(), known.len() + more, "{entry}");
        }
        ws.shutdown().unwrap();
    }

    #[test]
    fn text_a_holder_could_not_store_still_counts_as_a_change_on_close() {
        let (_dir, ws, t) = setup();
        capture_on_close(&ws).unwrap();
        let body = format!("body:{}/mod-prose", t.entry);
        let session = ws.prose_session(&body).unwrap();
        ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("CREATE TRIGGER reject_body BEFORE INSERT ON loro_update WHEN NEW.doc_id LIKE 'body:%' BEGIN SELECT RAISE(ABORT,'body fault'); END;")?;
                Ok(())
            })
            .unwrap();
        let stored = ws.library().head(&body).unwrap().unwrap().frontiers;
        assert!(
            session
                .edit(|t| t.insert_text(0, "Typed while the disk refused"))
                .is_err()
        );
        // SQLite still holds the version of the last checkpoint; only the
        // open holder has the new text. The sweep reads the holder.
        assert_eq!(ws.library().head(&body).unwrap().unwrap().frontiers, stored);
        assert_eq!(
            api::entries_due_for_capture(&ws, &t.book).unwrap(),
            vec![t.entry.clone()]
        );
        assert!(
            capture_on_close(&ws).is_err(),
            "a quit must not pass over text that is not stored"
        );
        ws.library()
            .local_transaction(|tx| {
                tx.execute_batch("DROP TRIGGER reject_body")?;
                Ok(())
            })
            .unwrap();
        capture_on_close(&ws).unwrap();
        let points = ws.run::<api::List>(&Actor::User, t.clone()).unwrap().output;
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].reason, "close");
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
                .any(|b| b.text.contains("Typed while the disk refused"))
        );
        drop(session);
        ws.shutdown().unwrap();
    }
}
