//! Durable records around writes: Agent settlements, origins carried by Loro
//! commit messages, activity, history labels with the book's version, the
//! library event bus, derived indexes kept by the store, purging.

mod common;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::synthetic::{self, LinesDeriver};
use common::*;
use dr_store::{AgentWrite, Library, LocalChangeKind, OpenDoc, Origin, StoreError, StoreEvent};

fn agent(turn: u32, call: &str) -> AgentWrite {
    AgentWrite {
        session: "s".into(),
        turn: turn.to_string(),
        call: call.into(),
        summary: format!("call {call}"),
    }
}

#[test]
fn agent_writes_leave_a_settlement_in_the_same_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "作者");
    let before = h.doc().oplog_frontiers();
    let (_, c) = h
        .write_agent(agent(1, "c1"), |doc| {
            doc.get_text(synthetic::BODY).insert(0, "帮手").unwrap();
        })
        .unwrap();
    let s = lib.settlements(Some("s"), None).unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!((s[0].turn.as_str(), s[0].call.as_str()), ("1", "c1"));
    assert_eq!(s[0].doc_id, "node:a");
    assert_eq!(Some(s[0].seq), c.seq);
    assert_eq!(s[0].before, before);
    assert_eq!(s[0].after, c.frontiers);
    assert_eq!(
        text(&lib.load_copy_at("node:a", &s[0].before).unwrap()),
        "作者\n"
    );
    // A write that changes nothing settles nothing.
    h.write_agent(agent(1, "c2"), |_| {}).unwrap();
    assert_eq!(lib.settlements(None, Some("node:a")).unwrap().len(), 1);
}

#[test]
fn origins_survive_compaction_in_loro_commit_messages() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let start = dr_store::now_ms() - 1000;
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "作");
    insert(&h, Origin::agent("s", 2), 0, "帮");
    insert(&h, Origin::Mirror, 0, "镜");
    insert(&h, Origin::Import, 0, "导");
    h.compact_now().unwrap();
    h.close();
    assert!(
        lib.updates_since("node:a", 0).unwrap().is_empty(),
        "rows are gone"
    );
    let activity = lib.activity_since(start).unwrap();
    assert_eq!(activity.len(), 1);
    let messages: Vec<Option<&str>> = activity[0]
        .changes
        .iter()
        .filter(|c| c.timestamp > 0)
        .map(|c| c.message.as_deref())
        .collect();
    for m in [Some("agent:s/2"), Some("mirror"), Some("import"), None] {
        assert!(messages.contains(&m), "{m:?} in {messages:?}");
    }
    let me = lib.peer_for("node:a").unwrap();
    assert!(
        activity[0]
            .changes
            .iter()
            .any(|c| c.peer == me && c.message.is_none())
    );
    assert_eq!(lib.docs_changed_since(start).unwrap(), ["node:a"]);
    assert!(
        lib.docs_changed_since(dr_store::now_ms() + 60_000)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn history_labels_record_the_book_documents_version() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let book = lib
        .open_doc(
            "book:book-1",
            OpenDoc::CreateIfMissing {
                kind: "book",
                book_id: Some("book-1"),
                genesis: &|_| {},
            },
        )
        .unwrap();
    book.write(Origin::User, |doc| {
        doc.get_map("meta").insert("name", "书名").unwrap();
    })
    .unwrap();
    let book_version = book.doc().oplog_frontiers();
    let h = create(&lib, "node:a"); // book-1
    insert(&h, Origin::agent("s", 3), 0, "帮");
    let label = &lib.history("node:a").unwrap()[0];
    assert_eq!(label.label, "agent:s/3");
    assert_eq!(label.book_frontiers.as_ref(), Some(&book_version));
}

#[test]
fn one_bus_carries_document_and_local_changes() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("pic.png");
    std::fs::write(&file, b"synthetic").unwrap();
    let lib = open(&dir.path().join("lib"));
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let _sub = {
        let seen = seen.clone();
        lib.subscribe(move |e| {
            let line = match e {
                StoreEvent::Doc(d) => format!("doc {} {}", d.doc_id, d.origin),
                StoreEvent::Local(l) => format!("local {} {:?}", l.table, l.kind),
            };
            seen.lock().unwrap().push(line);
        })
    };
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "字");
    h.write_agent(agent(4, "c"), |doc| {
        doc.get_text(synthetic::BODY).insert(0, "帮").unwrap();
    })
    .unwrap();
    lib.import_asset(&dr_store::asset::SourceImport {
        book_id: "book-1",
        asset_id: "pic",
        source: &file,
        mime: "image/png",
        ext: "png",
        dimensions: Some((1, 1)),
        limit: 1024,
    })
    .unwrap();
    lib.notify_local(dr_store::LocalChange::new(
        "agent_run",
        "run-1",
        LocalChangeKind::Insert,
    ));
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen,
        [
            "doc node:a user",
            "doc node:a agent:s/4",
            "local agent_settlement Insert",
            "local asset Insert",
            "local agent_run Insert",
        ]
    );
}

fn with_deriver(dir: &std::path::Path, deriver: &Arc<LinesDeriver>, rebuild: bool) -> Library {
    let mut o = options();
    o.deriver = Some(deriver.clone());
    o.rebuild_indexes_on_open = rebuild;
    o.compaction.idle = Duration::from_millis(20);
    Library::open(dir, o).unwrap()
}

fn wait_until(mut f: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(std::time::Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_store_keeps_the_index_up_to_date_from_loro_changes() {
    let dir = tempfile::tempdir().unwrap();
    let deriver = Arc::new(LinesDeriver::default());
    let lib = with_deriver(dir.path(), &deriver, false);
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "第一段\n第二段");
    // The idle holder derives from scratch first, then from diffs.
    wait_until(|| {
        lib.doc_stats("node:a")
            .unwrap()
            .is_some_and(|s| s.indexed_seq == 2)
    });
    assert_eq!(lib.outline("node:a").unwrap().len(), 0);
    assert_eq!(lib.block_lengths("node:a").unwrap(), [3, 3]);
    insert(&h, Origin::User, 0, "新");
    wait_until(|| {
        lib.doc_stats("node:a")
            .unwrap()
            .is_some_and(|s| s.indexed_seq == 3)
    });
    assert_eq!(lib.block_lengths("node:a").unwrap(), [4, 3]);
    assert!(
        deriver.with_changes.load(Ordering::Relaxed) >= 1,
        "later runs get diffs"
    );
    assert_eq!(lib.search(None, "新第一", 5).unwrap().len(), 1);
    assert!(lib.stale_index_docs().unwrap().is_empty());
}

#[test]
fn opening_rebuilds_indexes_that_fell_behind() {
    let dir = tempfile::tempdir().unwrap();
    // Written without a deriver: the index falls behind.
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "落后的正文");
    h.close();
    let h = create(&lib, "node:b");
    insert(&h, Origin::User, 0, "另一篇");
    h.close();
    assert_eq!(lib.stale_index_docs().unwrap(), ["node:a", "node:b"]);
    lib.close().unwrap();

    let deriver = Arc::new(LinesDeriver::default());
    let lib = with_deriver(dir.path(), &deriver, true);
    wait_until(|| lib.stale_index_docs().unwrap().is_empty());
    assert_eq!(lib.search(None, "落后的", 5).unwrap()[0].doc_id, "node:a");
    lib.close().unwrap();
}

#[test]
fn purging_a_document_removes_it_everywhere() {
    let dir = tempfile::tempdir().unwrap();
    let deriver = Arc::new(LinesDeriver::default());
    let lib = with_deriver(dir.path(), &deriver, false);
    let h = create(&lib, "node:a");
    insert(&h, Origin::agent("s", 5), 0, "要删的");
    h.reindex_now().unwrap();
    assert!(matches!(
        lib.purge_doc("node:a"),
        Err(StoreError::AlreadyOpen(_))
    ));
    h.close();
    lib.purge_doc("node:a").unwrap();
    assert!(lib.doc_info("node:a").unwrap().is_none());
    assert!(lib.head("node:a").unwrap().is_none());
    assert!(lib.history("node:a").unwrap().is_empty());
    assert!(lib.search(None, "要删的", 5).unwrap().is_empty());
    assert!(lib.load_copy("node:a").is_err());
    assert_eq!(lib.settlements(None, Some("node:a")).unwrap().len(), 0);
}

#[test]
fn modules_write_their_local_tables_in_one_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let run = lib
        .local_transaction(|tx| {
            tx.execute(
                "INSERT INTO import_run (importer, started_ms, finished_ms, source_sha256, source_bytes,
                   schema_level_before, gate_json, accepted_json, summary_json)
                 VALUES ('dr-import-v1', 1, 2, 'abc', 10, 18, '{}', '{}', '{}')",
                [],
            )?;
            let run = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO import_book VALUES (?1, 'book-1', '书', 'imported', '{}')",
                [run],
            )?;
            Ok(run)
        })
        .unwrap();
    // A failing closure rolls everything back.
    let failed: dr_store::Result<()> = lib.local_transaction(|tx| {
        tx.execute(
            "INSERT INTO import_book VALUES (?1, 'book-2', '书二', 'imported', '{}')",
            [run],
        )?;
        Err(StoreError::Asset("roll back".into()))
    });
    assert!(failed.is_err());
    let books: i64 = lib
        .local_read(|c| Ok(c.query_row("SELECT count(*) FROM import_book", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(books, 1);
}

#[test]
fn local_writes_announce_their_changes_after_commit() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let _sub = {
        let seen = seen.clone();
        lib.subscribe(move |e| {
            if let StoreEvent::Local(l) = e {
                seen.lock().unwrap().push(format!("{} {}", l.table, l.key));
            }
        })
    };
    let seq = lib
        .local_write(|tx| {
            tx.execute(
                "INSERT INTO ws_journal (ts, actor, command, effects, changed_ts) VALUES (1, 'user', 'node.rename', '[]', 1)",
                [],
            )?;
            let seq = tx.last_insert_rowid();
            tx.changed(dr_store::LocalChange::new("ws_journal", seq.to_string(), LocalChangeKind::Insert));
            Ok(seq)
        })
        .unwrap();
    let failed: dr_store::Result<()> = lib.local_write(|tx| {
        tx.execute(
            "INSERT INTO ws_journal (ts, actor, command, effects, changed_ts) VALUES (2, 'user', 'x', '[]', 2)",
            [],
        )?;
        tx.changed(dr_store::LocalChange::new("ws_journal", "never", LocalChangeKind::Insert));
        Err(StoreError::Asset("roll back".into()))
    });
    assert!(failed.is_err());
    assert_eq!(*seen.lock().unwrap(), [format!("ws_journal {seq}")]);
    let rows: i64 = lib
        .local_read(|c| Ok(c.query_row("SELECT count(*) FROM ws_journal", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn a_refused_close_hands_the_library_back() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let refused = lib.try_close().expect_err("a document is open");
    assert!(matches!(refused.error, StoreError::DocumentsOpen(1)));
    let lib = refused.library;
    insert(&h, Origin::User, 0, "还能用");
    h.close();
    lib.try_close().expect("closes once the document is closed");
    open(dir.path());
}

#[test]
fn a_read_only_open_reads_beside_the_app_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let app = open(dir.path());
    let h = create(&app, "node:a");
    insert(&h, Origin::User, 0, "看得见");
    // The app keeps the library open (and locked) meanwhile.
    let ro = Library::open_read_only(dir.path(), options()).unwrap();
    assert!(ro.is_read_only());
    assert_eq!(text(&ro.load_copy("node:a").unwrap()), "看得见\n");
    assert_eq!(ro.doc_info("node:a").unwrap().unwrap().kind, "node");
    assert!(!ro.history("node:a").unwrap().is_empty());
    assert!(matches!(
        ro.open_doc("node:a", OpenDoc::Existing),
        Err(StoreError::ReadOnly)
    ));
    assert!(ro.register("node:b", "node", None).is_err(), "writes fail");
    ro.close().unwrap();
    assert!(Library::open_read_only(dir.path().join("missing"), options()).is_err());
    h.close();
    app.close().unwrap();

    // A library this build would migrate first.
    let old = tempfile::tempdir().unwrap();
    Library::open_with_migrations(old.path(), options(), &dr_store::MIGRATIONS[..1])
        .unwrap()
        .close()
        .unwrap();
    assert!(matches!(
        Library::open_read_only(old.path(), options()),
        Err(StoreError::NeedsMigration { applied: 1, .. })
    ));
}

/// Closing releases the library at once, even while other threads are
/// starting processes (which briefly hold copies of every descriptor, the
/// lock file's included). Before the lock was released explicitly, 438
/// immediate reopens in 1000 failed this way. Windows handles are not
/// inherited, so this is a Unix case.
#[cfg(unix)]
#[test]
fn a_closed_library_reopens_at_once_while_processes_start() {
    use std::sync::atomic::AtomicBool;
    let dir = tempfile::tempdir().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let spawners: Vec<_> = (0..4)
        .map(|_| {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut n = 0usize;
                while !stop.load(Ordering::Relaxed) {
                    let _ = std::process::Command::new("true").status();
                    n += 1;
                }
                n
            })
        })
        .collect();
    let mut refused = 0;
    for _ in 0..1000 {
        match Library::open(dir.path(), options()) {
            Ok(lib) => lib.close().unwrap(),
            Err(_) => {
                refused += 1;
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    stop.store(true, Ordering::Relaxed);
    let spawned: usize = spawners.into_iter().map(|t| t.join().unwrap()).sum();
    assert!(spawned > 100, "only {spawned} processes started meanwhile");
    assert_eq!(
        refused, 0,
        "reopens refused while {spawned} processes started"
    );
}

/// Deriving the index waits `derive_idle` after the last job, compacting
/// waits `compaction.idle`: each runs on its own clock.
#[test]
fn deriving_and_compacting_wait_for_their_own_quiet_spells() {
    let deriver = Arc::new(LinesDeriver::default());
    let open_with = |dir: &std::path::Path, derive_ms: u64, compact_ms: u64| {
        let mut o = options();
        o.deriver = Some(deriver.clone());
        o.rebuild_indexes_on_open = false;
        o.derive_idle = Duration::from_millis(derive_ms);
        o.compaction.idle = Duration::from_millis(compact_ms);
        o.compaction.max_updates = 1;
        Library::open(dir, o).unwrap()
    };
    // Quick derivation, slow compaction.
    let dir = tempfile::tempdir().unwrap();
    let lib = open_with(dir.path(), 20, 60_000);
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "一段");
    wait_until(|| {
        lib.doc_stats("node:a")
            .unwrap()
            .is_some_and(|s| s.indexed_seq == 2)
    });
    assert_eq!(
        h.stats().compactions,
        0,
        "compaction waits for its own idle"
    );
    drop(h);
    drop(lib);
    // The other way round.
    let dir = tempfile::tempdir().unwrap();
    let lib = open_with(dir.path(), 60_000, 20);
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "一段");
    wait_until(|| h.stats().compactions == 1);
    assert!(
        lib.doc_stats("node:a").unwrap().is_none(),
        "derivation waits for its own idle"
    );
}

/// A deriver that takes its time.
struct Slow(LinesDeriver, Duration);

impl dr_store::index::Deriver for Slow {
    fn derive(
        &self,
        input: &dr_store::index::DeriveInput<'_>,
    ) -> Option<dr_store::index::DerivedUpdate> {
        std::thread::sleep(self.1);
        self.0.derive(input)
    }
}

/// The rebuild when a library opens leaves open documents to their holders
/// and takes no handle on them, so closing the library while it runs is
/// not refused (dr-workspace saw one refusal in three thousand runs).
#[test]
fn closing_during_the_rebuild_on_open_is_not_refused() {
    let dir = tempfile::tempdir().unwrap();
    {
        let lib = open(dir.path());
        for id in ["node:a-copy", "node:b-open"] {
            let h = create(&lib, id);
            insert(&h, Origin::User, 0, "旧的正文");
            h.close();
        }
        lib.close().unwrap();
    }
    let mut o = options();
    o.deriver = Some(Arc::new(Slow(
        LinesDeriver::default(),
        Duration::from_millis(200),
    )));
    o.rebuild_indexes_on_open = true;
    o.derive_idle = Duration::from_secs(60);
    o.compaction.idle = Duration::from_secs(60);
    let lib = Library::open(dir.path(), o).unwrap();
    // The rebuild derives node:a-copy from a copy for 200 ms, then comes to
    // node:b-open, which is open by then.
    let h = lib.open_doc("node:b-open", OpenDoc::Existing).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    drop(h);
    let refused = lib.try_close().err();
    assert!(
        refused.is_none(),
        "close refused: {:?}",
        refused.map(|r| r.error)
    );
}
