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
};

enum Message {
    Changed(String),
    Stop(mpsc::Sender<Result<(), String>>),
}
pub struct AutomaticHistory {
    send: mpsc::Sender<Message>,
    worker: Option<thread::JoinHandle<()>>,
    subscription: Option<LibrarySubscription>,
}
type Owners = BTreeMap<(String, String), String>;

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
        out.extend(book_owners(ws, &id)?);
    }
    Ok(out)
}
fn book_owners(ws: &Workspace, book: &BookId) -> Result<Owners, String> {
    let d = ws
        .library()
        .load_copy(&format!("book:{book}"))
        .map_err(|e| e.to_string())?;
    if !dr_doc::v3::is_v3_doc(&d) {
        return Ok(BTreeMap::new());
    }
    let b = BorrowedBookV3::new(&d, book).map_err(|e| e.to_string())?;
    let v = b.view();
    let entries = v.entries_raw();
    let mut out = BTreeMap::new();
    for e in &entries {
        let value = v.entry_owned_raw_state(&e.id).expect("entry exists");
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        out.insert(
            (book.to_string(), e.id.to_string()),
            dr_store::digest::sha256_hex(&bytes),
        );
    }
    Ok(out)
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
        let (send, rx) = mpsc::channel();
        let events = send.clone();
        let subscription=ws.library().subscribe(move |event| {
            if let StoreEvent::Doc(e)=event && dr_store::history::records_periodic(&e.origin) {
                // Book counters, comments, shared templates and checkpoints
                // do not change entry-owned content. In particular they must
                // not materialize every entry's lazy body as a side effect.
                let relevant=match DocId::parse(&e.doc_id) {
                    Ok(DocId::Body(_))=>true,
                    Ok(DocId::Book(_))=>e.changes.iter().any(|c| {
                        let root=c.path.first().map(|(id,_)|id).unwrap_or(&c.target);
                        matches!(root,loro::ContainerID::Root {name,..} if matches!(name.as_str(),"entries"|"patches"|"plot_grids"|"memberships"|"relations"))
                    }),
                    _=>false,
                };
                if relevant {let _=events.send(Message::Changed(e.doc_id.to_string()));}
            }
        });
        let worker = thread::spawn(move || {
            let mut known = owners(&ws).unwrap_or_default();
            let mut dirty = BTreeSet::new();
            while let Ok(message) = rx.recv() {
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
                                match book_owners(&ws, &book) {
                                    Ok(current) => {
                                        dirty.retain(|key| {
                                            key.0 != book.as_str() || current.contains_key(key)
                                        });
                                        let changed: Vec<_> = current
                                            .iter()
                                            .filter(|(key, hash)| known.get(*key) != Some(*hash))
                                            .map(|(key, _)| key.clone())
                                            .collect();
                                        // The initial baseline can already include a
                                        // queued first edit. Capture conservatively.
                                        if changed.is_empty() {
                                            dirty.extend(current.keys().cloned());
                                        } else {
                                            dirty.extend(changed);
                                        }
                                        known.retain(|(b, _), _| b != book.as_str());
                                        known.extend(current);
                                    }
                                    Err(e) => {
                                        log::warn!("entry checkpoint observation failed: {e}")
                                    }
                                }
                            }
                            _ => {}
                        }
                        for key in &dirty {
                            if let Err(e) = capture(&ws, key, api::CaptureReason::Periodic) {
                                log::warn!("periodic entry checkpoint failed: {e}");
                            }
                        }
                    }
                    Message::Stop(done) => {
                        let result = capture_on_close(&ws);
                        let _ = done.send(result);
                        break;
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
}
