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

/// F2's review of M27 (2026-11-08): the journal of a purged conversation
/// goes by the id its sessions name, whatever kind the document was stored
/// with (the store knows no kind names).
#[test]
fn purging_the_conversation_a_session_names_drops_its_journal_whatever_its_kind() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    create(&lib, "node:one").close();
    lib.open_doc(
        "chat:one",
        OpenDoc::CreateIfMissing {
            kind: "chat",
            book_id: Some("book-1"),
            genesis: &|_| {},
        },
    )
    .unwrap()
    .close();
    lib.agent_create_session("session-1", "chat:one", "book-1")
        .unwrap();
    lib.agent_append_event(&request("session-1", 0)).unwrap();
    lib.purge_doc("chat:one").unwrap();
    assert!(lib.agent_session("session-1").unwrap().is_none());
    assert!(lib.agent_events("session-1", 0).unwrap().is_empty());
}

/// Settlements outlive a document purged alone (the session that made them
/// still shows them) but go with the book: once its last document is purged
/// nothing of it can be undone, and their summaries are its last words.
#[test]
fn a_purged_books_settlements_go_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let book_doc = |id: &str, book: &str| {
        lib.open_doc(
            id,
            OpenDoc::CreateIfMissing {
                kind: "book",
                book_id: Some(book),
                genesis: &|_| {},
            },
        )
        .unwrap()
        .close();
    };
    book_doc("book:1", "book-1");
    book_doc("book:2", "book-2");
    let write = |doc_id: &str, book: &str, call: &str| {
        let h = lib
            .open_doc(
                doc_id,
                OpenDoc::CreateIfMissing {
                    kind: "node",
                    book_id: Some(book),
                    genesis: &common::genesis,
                },
            )
            .unwrap();
        h.write_agent(
            dr_store::AgentWrite {
                session: "s".into(),
                turn: "1".into(),
                call: call.into(),
                summary: format!("改了 {doc_id}"),
            },
            |doc| {
                doc.get_text(common::synthetic::BODY)
                    .insert(0, "写")
                    .unwrap();
            },
        )
        .unwrap();
        h.close();
    };
    write("node:a", "book-1", "c1");
    write("node:b", "book-2", "c2");
    let docs = |lib: &Library| -> Vec<String> {
        lib.settlements(Some("s"), None)
            .unwrap()
            .into_iter()
            .map(|s| s.doc_id)
            .collect()
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let _sub = {
        let seen = seen.clone();
        lib.subscribe(move |event| {
            if let StoreEvent::Local(change) = event
                && change.table == "agent_settlement"
            {
                seen.lock().unwrap().push(change.clone());
            }
        })
    };
    lib.purge_doc("node:a").unwrap();
    assert_eq!(docs(&lib), ["node:a", "node:b"], "the book still lives");
    assert!(seen.lock().unwrap().is_empty());
    lib.purge_doc("book:1").unwrap();
    assert_eq!(docs(&lib), ["node:b"], "book-1 is gone, book-2 is not");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].kind, dr_store::LocalChangeKind::Delete);
}

/// A book's sessions are read through `agent_session_by_book`, in order,
/// without scanning every session of the library or sorting.
#[test]
fn a_books_sessions_are_read_through_its_own_index() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let plan: Vec<String> = lib
        .local_read(|c| {
            let mut s = c.prepare(
                "EXPLAIN QUERY PLAN SELECT session, conversation, book_id, created_ms
                 FROM agent_session WHERE book_id = ?1 ORDER BY created_ms, session",
            )?;
            let rows = s
                .query_map(["book-1"], |r| r.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(
        plan,
        ["SEARCH agent_session USING INDEX agent_session_by_book (book_id=?)"],
        "{plan:?}"
    );
    for (session, book) in [("s3", "book-1"), ("s1", "book-2"), ("s2", "book-1")] {
        lib.agent_create_session(session, &format!("conversation:{session}"), book)
            .unwrap();
    }
    let names = |book: Option<&str>| -> Vec<String> {
        lib.agent_sessions(book)
            .unwrap()
            .into_iter()
            .map(|s| s.session)
            .collect()
    };
    assert_eq!(names(Some("book-1")).len(), 2);
    assert!(names(Some("book-1")).iter().all(|s| s != "s1"));
    assert_eq!(names(None).len(), 3);
}

/// The import validator runs on the holder thread; a panic in it refuses
/// the import and leaves the holder working, and anything it wrote into the
/// live document (it must only read) is stored apart as an outside write,
/// never inside the import's row.
#[test]
fn a_panicking_or_writing_import_validator_cannot_break_the_holder() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut opts = options();
    {
        let calls = calls.clone();
        opts.validate_import = Some(Arc::new(move |_, current, _| {
            match calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) {
                0 => panic!("validator bug"),
                1 => {
                    current.get_map("stray").insert("k", 1).unwrap();
                    Ok(())
                }
                _ => Ok(()),
            }
        }));
    }
    let lib = Library::open(dir.path(), opts).unwrap();
    let h = create(&lib, "node:one");
    let before = lib.head("node:one").unwrap();
    let remote = |text: &str| {
        let d = loro::LoroDoc::new();
        d.get_map("remote").insert(text, true).unwrap();
        d.commit();
        d.export(loro::ExportMode::all_updates()).unwrap()
    };
    assert!(matches!(
        h.import(remote("first"), dr_store::Origin::Sync),
        Err(StoreError::Invalid { what: "import", .. })
    ));
    assert_eq!(lib.head("node:one").unwrap(), before);
    assert!(h.doc().get_map("remote").get("first").is_none());
    h.import(remote("second"), dr_store::Origin::Sync).unwrap();
    assert!(h.doc().get_map("remote").get("second").is_some());
    let origins: Vec<String> = lib
        .updates_since("node:one", 1)
        .unwrap()
        .into_iter()
        .map(|r| r.origin)
        .collect();
    assert_eq!(origins, ["outside", "sync"]);
    common::insert(&h, dr_store::Origin::User, 0, "还能写");
    h.close();
}

/// Manual measurement for M27/M28 (reference only on a busy machine): what
/// one streamed delta costs as its own journal transaction, how much the
/// journal grows, and what a full replay read costs.
/// `cargo test --release -p dr-store --test agent -- --ignored --nocapture`
#[test]
#[ignore = "manual measurement"]
fn measure_journal_appends() {
    use std::time::Instant;
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    const SESSIONS: usize = 20;
    const DELTAS: i64 = 1_000;
    let size_before = lib.size_bytes().unwrap();
    let mut each = Vec::new();
    let text = "一段流式输出的文字，大约二十个字。";
    for s in 0..SESSIONS {
        let session = format!("session-{s}");
        lib.agent_create_session(&session, &format!("conversation:{s}"), "book-1")
            .unwrap();
        for seq in 0..DELTAS {
            let json = serde_json::json!({
                "turn": 1,
                "event": {"TextDelta": {"index": 0, "text": text}},
            })
            .to_string();
            let t = Instant::now();
            lib.agent_append_event(&AgentEventAppend {
                session: session.clone(),
                expected_seq: seq,
                event_json: json,
            })
            .unwrap();
            each.push(t.elapsed().as_secs_f64() * 1e3);
        }
    }
    each.sort_by(f64::total_cmp);
    let p = |q: f64| each[((each.len() - 1) as f64 * q) as usize];
    let grown = lib.size_bytes().unwrap() - size_before;
    let t = Instant::now();
    let mut rows = 0;
    for session in lib.agent_sessions(None).unwrap() {
        rows += lib.agent_events(&session.session, 0).unwrap().len();
    }
    let replay = t.elapsed().as_secs_f64() * 1e3;
    println!(
        "appends: {} — p50 {:.3} ms, p95 {:.3} ms, p99 {:.3} ms, max {:.3} ms; \
         journal +{:.1} KiB ({:.0} B/event); replaying {rows} events of {SESSIONS} sessions: {replay:.1} ms",
        each.len(),
        p(0.5),
        p(0.95),
        p(0.99),
        p(1.0),
        grown as f64 / 1024.0,
        grown as f64 / each.len() as f64,
    );
    lib.close().unwrap();
}
