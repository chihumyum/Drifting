//! The M27 journal is append-only, local and replayable after reopening.

mod common;

use std::sync::{Arc, Mutex};

use common::{create, open, options};
use dr_store::agent::{AgentEventAppend, EVENT_TABLE, SESSION_TABLE};
use dr_store::{Library, MIGRATIONS, OpenDoc, StoreError, StoreEvent};

fn request(session: &str, expected_seq: i64) -> AgentEventAppend {
    AgentEventAppend {
        session: session.into(),
        expected_seq,
        event_json: serde_json::json!({"version": 1, "step": expected_seq}).to_string(),
    }
}

#[test]
fn ordered_events_survive_reopen_without_changing_document_sync_state() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let doc = create(&lib, "node:one");
    let before = lib.head("node:one").unwrap();
    doc.close();
    let original = lib
        .agent_create_session("session-1", "conversation:one", "book-1")
        .unwrap();
    assert_eq!(
        lib.agent_create_session("session-1", "conversation:one", "book-1")
            .unwrap(),
        original
    );
    assert!(
        lib.agent_create_session("session-1", "conversation:other", "book-1")
            .is_err()
    );
    for seq in 0..4 {
        assert_eq!(
            lib.agent_append_event(&request("session-1", seq))
                .unwrap()
                .seq,
            seq + 1
        );
    }
    assert!(matches!(
        lib.agent_append_event(&request("session-1", 2)),
        Err(StoreError::AgentSequence {
            expected: 2,
            stored: 4,
            ..
        })
    ));
    assert_eq!(
        lib.agent_events("session-1", 2)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect::<Vec<_>>(),
        [3, 4]
    );
    assert_eq!(lib.head("node:one").unwrap(), before);
    assert_eq!(lib.docs(Some("book-1"), None).unwrap().len(), 1);
    lib.close().unwrap();

    let lib = open(dir.path());
    assert_eq!(
        lib.agent_session("session-1").unwrap(),
        Some(original.clone())
    );
    assert_eq!(lib.agent_sessions(Some("book-1")).unwrap(), [original]);
    assert!(lib.agent_sessions(Some("other")).unwrap().is_empty());
    assert_eq!(lib.agent_events("session-1", 0).unwrap().len(), 4);
    assert_eq!(lib.agent_event("session-1", 1).unwrap().unwrap().seq, 1);
    assert!(lib.agent_event("session-1", 9).unwrap().is_none());
    assert!(lib.agent_event("session-1", 0).is_err());
    assert_eq!(
        lib.agent_append_event(&request("session-1", 4))
            .unwrap()
            .seq,
        5
    );
}

#[test]
fn failed_transactions_leave_no_journal_or_notification() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_sub = seen.clone();
    let _sub = lib.subscribe(move |event| {
        if let StoreEvent::Local(change) = event
            && (change.table == EVENT_TABLE || change.table == SESSION_TABLE)
        {
            seen_sub.lock().unwrap().push(change.clone());
        }
    });
    let failed = lib.local_write(|tx| -> dr_store::Result<()> {
        tx.agent_create_session("session-1", "conversation:one", "book-1")?;
        tx.agent_append_event(&request("session-1", 0))?;
        Err(StoreError::NotFound("test rollback".into()))
    });
    assert!(failed.is_err());
    assert!(lib.agent_session("session-1").unwrap().is_none());
    assert!(seen.lock().unwrap().is_empty());
    lib.local_write(|tx| {
        tx.agent_create_session("session-1", "conversation:one", "book-1")?;
        tx.agent_append_event(&request("session-1", 0))?;
        tx.agent_append_event(&request("session-1", 1))
    })
    .unwrap();
    assert_eq!(seen.lock().unwrap().len(), 3);
    assert_eq!(lib.agent_events("session-1", 0).unwrap().len(), 2);

    let mut bad = request("session-1", 2);
    bad.event_json = "{".into();
    assert!(lib.agent_append_event(&bad).is_err());
    assert!(lib.agent_append_event(&request("session-1", -1)).is_err());
    assert!(lib.agent_append_event(&request("missing", 0)).is_err());
    assert_eq!(seen.lock().unwrap().len(), 3);
    assert_eq!(lib.agent_events("session-1", 0).unwrap().len(), 2);
}

#[test]
fn concurrent_writers_cannot_fork_the_durable_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.agent_create_session("session-1", "conversation:one", "book-1")
        .unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let writes: Vec<_> = (0..8)
        .map(|_| {
            let library = lib.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                library.agent_append_event(&request("session-1", 0))
            })
        })
        .collect();
    let results: Vec<_> = writes.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(StoreError::AgentSequence { .. })))
            .count(),
        7
    );
    assert_eq!(lib.agent_events("session-1", 0).unwrap().len(), 1);
}

#[test]
fn migration_protects_the_old_library_and_keeps_documents() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open_with_migrations(dir.path(), options(), &MIGRATIONS[..7]).unwrap();
    create(&lib, "node:one").close();
    let old_head = lib.head("node:one").unwrap();
    lib.close().unwrap();
    let lib = open(dir.path());
    assert_eq!(lib.open_report().migrations_applied, 1);
    assert!(lib.open_report().safety_snapshot.as_ref().unwrap().exists());
    assert_eq!(lib.head("node:one").unwrap(), old_head);
    lib.agent_create_session("session-1", "conversation:one", "book-1")
        .unwrap();
    lib.agent_append_event(&request("session-1", 0)).unwrap();
}

#[test]
fn purging_conversation_or_last_book_document_removes_journal_content() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    create(&lib, "node:one").close();
    lib.open_doc(
        "conversation:one",
        OpenDoc::CreateIfMissing {
            kind: "conversation",
            book_id: Some("book-1"),
            genesis: &|_| {},
        },
    )
    .unwrap()
    .close();
    lib.agent_create_session("session-1", "conversation:one", "book-1")
        .unwrap();
    lib.agent_create_session("session-2", "conversation:two", "book-1")
        .unwrap();
    lib.agent_append_event(&request("session-1", 0)).unwrap();
    lib.agent_append_event(&request("session-2", 0)).unwrap();
    lib.purge_doc("conversation:one").unwrap();
    assert!(lib.agent_session("session-1").unwrap().is_none());
    assert!(lib.agent_events("session-1", 0).unwrap().is_empty());
    assert!(lib.agent_session("session-2").unwrap().is_some());
    assert!(matches!(
        lib.agent_create_session("new", "conversation:one", "book-1"),
        Err(StoreError::Purged(_))
    ));
    lib.purge_doc("node:one").unwrap();
    assert!(lib.agent_sessions(Some("book-1")).unwrap().is_empty());
    assert!(lib.agent_events("session-2", 0).unwrap().is_empty());
    assert!(matches!(
        lib.agent_create_session("new", "conversation:new", "book-1"),
        Err(StoreError::Purged(_))
    ));
}

#[test]
fn import_guard_sees_settled_state_and_rejection_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let guard_calls = calls.clone();
    let mut opts = options();
    opts.validate_import = Some(Arc::new(move |id, current, bytes| {
        assert_eq!(id, "node:one");
        assert!(current.get_map("guard").get("local").is_some());
        guard_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let candidate = current.fork();
        candidate.import(bytes)?;
        if candidate.get_map("guard").get("forbidden").is_some() {
            return Err(StoreError::Invalid {
                what: "test schema",
                value: "forbidden field".into(),
            });
        }
        Ok(())
    }));
    let lib = Library::open(dir.path(), opts).unwrap();
    let h = create(&lib, "node:one");
    h.write(dr_store::Origin::User, |doc| {
        doc.get_map("guard").insert("local", 42).unwrap();
    })
    .unwrap();
    let before = lib.head("node:one").unwrap();
    let before_vv = h.doc().oplog_vv();
    let forbidden = loro::LoroDoc::new();
    forbidden
        .get_map("guard")
        .insert("forbidden", true)
        .unwrap();
    forbidden.commit();
    let result = h.import(
        forbidden.export(loro::ExportMode::all_updates()).unwrap(),
        dr_store::Origin::Sync,
    );
    assert!(matches!(
        result,
        Err(StoreError::Invalid {
            what: "test schema",
            ..
        })
    ));
    assert_eq!(lib.head("node:one").unwrap(), before);
    assert_eq!(h.doc().oplog_vv(), before_vv);
    assert!(h.doc().get_map("guard").get("forbidden").is_none());

    let allowed = loro::LoroDoc::new();
    allowed.get_map("guard").insert("allowed", true).unwrap();
    allowed.commit();
    h.import(
        allowed.export(loro::ExportMode::all_updates()).unwrap(),
        dr_store::Origin::Sync,
    )
    .unwrap();
    assert!(h.doc().get_map("guard").get("allowed").is_some());
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 2);
}
