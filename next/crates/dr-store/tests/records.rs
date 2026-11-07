//! Durable records around writes: Agent settlements, origins carried by Loro
//! commit messages, activity, history labels with the book's version, the
//! library event bus, derived indexes kept by the store, purging.

mod common;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use dr_store::synthetic::{self, LinesDeriver};
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
