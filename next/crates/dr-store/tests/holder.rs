//! Document holders: one origin per commit, persist before announcing,
//! peers per (device, document), compaction, history copies.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::synthetic::{self, Rng};
use common::*;
use dr_store::history::labels;
use dr_store::{COMMAND_ORIGIN, Library, OpenDoc, Origin, StoreError};
use loro::{CommitOptions, ExportMode, LoroDoc};

#[test]
fn a_created_document_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    assert_eq!(text(h.doc()), "\n", "genesis");
    let (_, c) = h
        .write(Origin::User, |doc| {
            doc.get_text(synthetic::BODY).insert(0, "第一句").unwrap();
        })
        .unwrap();
    assert_eq!(c.seq, Some(2), "after the genesis row");
    let (_, unchanged) = h.write(Origin::User, |_| {}).unwrap();
    assert_eq!(unchanged.seq, None, "an empty write appends nothing");
    h.close();
    lib.close().unwrap();

    let lib = open(dir.path());
    let info = lib.doc_info("node:a").unwrap().unwrap();
    assert_eq!(info.kind, "node");
    assert_eq!(info.book_id.as_deref(), Some("book-1"));
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    assert_eq!(text(h.doc()), "第一句\n");
    let (_, c) = h
        .write(Origin::User, |doc| {
            doc.get_text(synthetic::BODY).insert(3, "。").unwrap();
        })
        .unwrap();
    assert_eq!(c.seq, Some(3), "numbering continues");
    assert!(matches!(
        lib.open_doc("node:missing", OpenDoc::Existing),
        Err(StoreError::NotFound(_))
    ));
}

#[test]
fn opening_twice_shares_one_holder() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = create(&lib, "node:a");
    let b = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&a, Origin::User, 0, "甲");
    assert_eq!(text(b.doc()), "甲\n");
    assert_eq!(lib.open_doc_count(), 1);
    a.close();
    b.close();
    assert_eq!(lib.open_doc_count(), 0, "the holder released its slot");
    let c = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    assert_eq!(text(c.doc()), "甲\n");
}

/// Why the holder exists: Loro's implicit transaction is shared by every
/// clone of a document, so an edit made on one thread joins whatever commit
/// another thread makes next.
#[test]
fn loro_shares_its_implicit_transaction_across_clones() {
    let doc = LoroDoc::new();
    doc.set_peer_id(7).unwrap();
    let author = doc.clone();
    let agent = doc.clone();
    author.get_text("body").insert(0, "u").unwrap();
    agent.get_text("body").insert(1, "a").unwrap();
    agent.commit_with(
        CommitOptions::new()
            .origin("agent:s/1")
            .commit_msg("agent:s/1"),
    );
    let change = doc.get_change(loro::ID::new(7, 0)).unwrap();
    assert_eq!(
        (change.len, change.message.as_deref()),
        (2, Some("agent:s/1")),
        "the author's keystroke went into the Agent's commit"
    );
    // Loro even counts the uncommitted keystroke in the version vector.
    let fresh = LoroDoc::new();
    fresh.set_peer_id(8).unwrap();
    fresh.get_text("body").insert(0, "u").unwrap();
    assert_eq!(fresh.oplog_vv().get(&8).copied(), Some(1));
}

/// Import rows one by one and return what each added to the text.
fn added_per_row(lib: &Library, doc_id: &str) -> Vec<(String, String)> {
    let doc = LoroDoc::new();
    synthetic::configure(&doc);
    let mut out = Vec::new();
    let mut prev = String::new();
    for row in lib.updates_since(doc_id, 0).unwrap() {
        doc.import(&row.bytes).unwrap();
        let now = text(&doc);
        let mut added: Vec<char> = now.chars().collect();
        for c in prev.chars() {
            if let Some(i) = added.iter().position(|x| *x == c) {
                added.remove(i);
            }
        }
        out.push((row.origin, added.into_iter().collect()));
        prev = now;
    }
    out
}

#[test]
fn author_and_agent_writes_never_share_a_commit() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = options();
    o.compaction.max_updates = usize::MAX;
    o.compaction.on_close_min_updates = usize::MAX;
    let lib = Library::open(dir.path(), o).unwrap();
    let h = create(&lib, "node:a");
    let n = 200;
    let spawn = |origin: Origin, ch: &'static str, seed: u64| {
        let h = h.clone();
        std::thread::spawn(move || {
            let mut rng = Rng::new(seed);
            for _ in 0..n {
                let pick = rng.next_u64();
                // Several edits per write, queued from two threads at once.
                h.submit(origin.clone(), move |doc| {
                    let t = doc.get_text(synthetic::BODY);
                    for i in 0..3u64 {
                        let len = t.len_unicode();
                        let at = ((pick >> (i * 8)) as usize) % len;
                        t.insert(at, ch).unwrap();
                    }
                })
                .unwrap()
                .wait()
                .unwrap();
            }
        })
    };
    let a = spawn(Origin::User, "u", 1);
    let b = spawn(Origin::agent("s", 1), "a", 2);
    a.join().unwrap();
    b.join().unwrap();
    assert_eq!(h.stats().outside_commits, 0);
    h.close();

    let rows = added_per_row(&lib, "node:a");
    assert_eq!(rows.len(), 1 + 2 * n, "genesis plus one row per write");
    for (origin, added) in &rows[1..] {
        let want = if origin == "user" { "uuu" } else { "aaa" };
        assert!(origin == "user" || origin == "agent:s/1", "{origin}");
        assert_eq!(added, want, "a {origin} row added only its own text");
    }
    // Agent commits carry their origin as a durable message.
    let doc = lib.load_copy("node:a").unwrap();
    let mut agent_changes = 0;
    let mut user_changes = 0;
    for change in doc
        .export_json_updates(&Default::default(), &doc.oplog_vv())
        .unwrap()
        .changes
    {
        match change.msg.as_deref() {
            Some("agent:s/1") => agent_changes += 1,
            None => user_changes += 1,
            Some(other) => panic!("unexpected message {other}"),
        }
    }
    assert!(agent_changes > 0 && user_changes > 0);
}

#[test]
fn edits_made_outside_the_holder_are_committed_on_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    // A bug: someone edits the shared document directly.
    h.doc().get_text(synthetic::BODY).insert(0, "x").unwrap();
    insert(&h, Origin::agent("s", 2), 1, "a");
    assert_eq!(h.stats().outside_commits, 1);
    h.close();
    let rows = added_per_row(&lib, "node:a");
    let tail: Vec<(&str, &str)> = rows[1..]
        .iter()
        .map(|(o, a)| (o.as_str(), a.as_str()))
        .collect();
    assert_eq!(tail, [("outside", "x"), ("agent:s/2", "a")]);
}

#[test]
fn events_arrive_after_the_update_is_stored() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let seen: Arc<Mutex<Vec<(i64, String, bool)>>> = Arc::default();
    let sub = {
        let seen = seen.clone();
        let lib = lib.clone();
        h.subscribe(move |e| {
            // Read SQLite from inside the event: the row must be there.
            let stored = lib
                .updates_since(&e.doc_id, e.seq - 1)
                .unwrap()
                .first()
                .is_some_and(|r| r.seq == e.seq);
            seen.lock().unwrap().push((
                e.seq,
                e.origin.to_string(),
                stored && !e.changes.is_empty(),
            ));
        })
    };
    insert(&h, Origin::User, 0, "一");
    insert(&h, Origin::agent("s", 3), 0, "二");
    let other = {
        let dir = tempfile::tempdir().unwrap();
        let lib2 = open(dir.path());
        let h2 = create(&lib2, "node:a");
        insert(&h2, Origin::User, 0, "三");
        h2.read(|doc| doc.export(ExportMode::all_updates()).unwrap())
            .unwrap()
    };
    let imported = h.import(other, Origin::Sync).unwrap();
    assert!(imported.status.pending.is_none());
    assert!(imported.committed.seq.is_some());
    drop(sub);
    insert(&h, Origin::User, 0, "四");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen,
        [
            (2, "user".to_string(), true),
            (3, "agent:s/3".to_string(), true),
            (4, "sync".to_string(), true),
        ],
        "in order, persisted, and none after unsubscribing"
    );
}

#[test]
fn peers_are_kept_per_document_and_change_with_the_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let b = create(&lib, "node:b");
    let peer_a = lib.peer_for("node:a").unwrap();
    assert_ne!(peer_a, lib.peer_for("node:b").unwrap());
    assert!(
        peer_a & (1 << 63) == 0,
        "device peers never look like genesis peers"
    );
    insert(&h, Origin::User, 0, "甲");
    assert!(matches!(
        lib.rotate_epoch(),
        Err(StoreError::DocumentsOpen(2))
    ));
    h.close();
    b.close();
    lib.close().unwrap();

    let lib = open(dir.path());
    assert_eq!(lib.peer_for("node:a").unwrap(), peer_a, "persisted");
    lib.rotate_epoch().unwrap();
    let new_peer = lib.peer_for("node:a").unwrap();
    assert_ne!(new_peer, peer_a);
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    assert_eq!(h.doc().peer_id(), new_peer);
}

#[test]
fn compaction_replaces_covered_updates_with_one_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = options();
    o.compaction.max_updates = usize::MAX;
    o.compaction.on_close_min_updates = usize::MAX;
    let lib = Library::open(dir.path(), o).unwrap();
    let h = create(&lib, "node:a");
    let mut rng = Rng::new(9);
    let mut cursor = 0;
    for _ in 0..60 {
        let seed = rng.next_u64();
        cursor = h
            .write(Origin::User, move |doc| {
                synthetic::keystroke(doc, &mut Rng::new(seed), cursor)
            })
            .unwrap()
            .0;
    }
    assert_eq!(lib.pending_updates("node:a").unwrap().0, 61);
    let stats = h.compact_now().unwrap().expect("something to compact");
    assert_eq!(stats.upto_seq, 61);
    assert_eq!(stats.deleted_updates, 61);
    assert_eq!(lib.pending_updates("node:a").unwrap().0, 0);
    assert_eq!(lib.snapshot_info("node:a").unwrap().unwrap().0, 61);
    assert_eq!(h.compact_now().unwrap(), None, "nothing pending");
    insert(&h, Origin::User, 0, "后");
    assert_eq!(lib.updates_since("node:a", 0).unwrap()[0].seq, 62);
    let content = text(h.doc());
    h.close();
    lib.close().unwrap();
    let lib = open(dir.path());
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), content);
}

#[test]
fn an_idle_holder_compacts_in_the_background() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = options();
    o.compaction.max_updates = 10;
    o.compaction.idle = Duration::from_millis(30);
    let lib = Library::open(dir.path(), o).unwrap();
    let h = create(&lib, "node:a");
    for i in 0..12 {
        insert(&h, Origin::User, 0, &i.to_string());
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while h.stats().compactions == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(h.stats().compactions, 1);
    assert_eq!(h.stats().pending_updates, 0);
    assert_eq!(lib.pending_updates("node:a").unwrap().0, 0);
}

#[test]
fn each_agent_turn_labels_the_version_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "作者写的");
    let before_turn = text(h.doc());
    insert(&h, Origin::agent("s", 4), 0, "帮手写的");
    insert(&h, Origin::agent("s", 4), 0, "又写");
    let after_turn = text(h.doc());
    insert(&h, Origin::agent("s", 5), 0, "下一轮");
    let history = lib.history("node:a").unwrap();
    let names: Vec<&str> = history.iter().map(|l| l.label.as_str()).collect();
    // Newest first: one label per Agent turn (even on the same version as
    // the periodic label), then the first periodic one.
    assert_eq!(names, ["agent:s/5", "agent:s/4", labels::PERIODIC]);
    let back = lib.load_copy_at("node:a", &history[1].frontiers).unwrap();
    assert_eq!(text(&back), before_turn, "the version just before turn 4");
    assert!(back.is_detached());
    let back = lib.load_copy_at("node:a", &history[0].frontiers).unwrap();
    assert_eq!(text(&back), after_turn, "the version just before turn 5");
    assert_eq!(
        text(h.doc()),
        format!("下一轮{after_turn}"),
        "open doc untouched"
    );
    // A restore label goes on the current version once.
    assert!(h.label(labels::RESTORE).unwrap());
    assert!(
        !h.label(labels::RESTORE).unwrap(),
        "not twice on one version"
    );
}

#[test]
fn a_panicking_write_is_persisted_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let r = h.write(Origin::User, |doc| {
        doc.get_text(synthetic::BODY).insert(0, "半").unwrap();
        panic!("bug in a command");
    });
    assert!(matches!(r, Err(StoreError::WritePanicked(_))));
    insert(&h, Origin::User, 1, "句");
    h.close();
    assert_eq!(text(&lib.load_copy("node:a").unwrap()), "半句\n");
}

#[test]
fn reads_on_the_holder_see_whole_writes() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let pending = h
        .submit(Origin::User, |doc| {
            doc.get_text(synthetic::BODY).insert(0, "整").unwrap();
            std::thread::sleep(Duration::from_millis(20));
            doc.get_text(synthetic::BODY).insert(1, "句").unwrap();
        })
        .unwrap();
    let seen = h.read(text::<LoroDoc>).unwrap();
    assert_eq!(seen, "整句\n");
    pending.wait().unwrap();
}

#[test]
fn a_failed_append_is_retried_under_its_own_origin() {
    use std::sync::atomic::AtomicUsize;
    let dir = tempfile::tempdir().unwrap();
    let faults = Arc::new(AtomicUsize::new(0));
    let mut o = options();
    o.append_faults = Some(faults.clone());
    o.compaction.on_close_min_updates = usize::MAX;
    let lib = Library::open(dir.path(), o).unwrap();
    let h = create(&lib, "node:a");
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let _sub = {
        let seen = seen.clone();
        h.subscribe(move |e| seen.lock().unwrap().push(e.origin.to_string()))
    };
    // The disk "fills up" for two appends: the Agent write fails, and so
    // does its first retry, which refuses the author's next write.
    faults.store(2, std::sync::atomic::Ordering::Relaxed);
    let agent = h.write(Origin::agent("s", 6), |doc| {
        doc.get_text(synthetic::BODY).insert(0, "a").unwrap();
    });
    assert!(agent.is_err());
    let refused = h.write(Origin::User, |doc| {
        doc.get_text(synthetic::BODY).insert(0, "never").unwrap();
    });
    assert!(
        refused.is_err(),
        "no new edits while earlier ones are unstored"
    );
    // The disk recovers.
    insert(&h, Origin::User, 0, "u");
    h.close();
    let rows = added_per_row(&lib, "node:a");
    let tail: Vec<(&str, &str)> = rows[1..]
        .iter()
        .map(|(o, a)| (o.as_str(), a.as_str()))
        .collect();
    assert_eq!(tail, [("agent:s/6", "a"), ("user", "u")]);
    assert_eq!(*seen.lock().unwrap(), ["agent:s/6", "user"]);
    // The label due with the failed Agent write was written with its retry.
    let history = lib.history("node:a").unwrap();
    let turn = history
        .iter()
        .find(|l| l.label == "agent:s/6")
        .expect("turn label");
    assert_eq!(
        text(&lib.load_copy_at("node:a", &turn.frontiers).unwrap()),
        "\n"
    );
}

#[test]
fn a_failed_append_of_outside_edits_refuses_the_next_write() {
    use std::sync::atomic::AtomicUsize;
    let dir = tempfile::tempdir().unwrap();
    let faults = Arc::new(AtomicUsize::new(0));
    let mut o = options();
    o.append_faults = Some(faults.clone());
    o.compaction.on_close_min_updates = usize::MAX;
    let lib = Library::open(dir.path(), o).unwrap();
    let h = create(&lib, "node:a");
    h.doc().get_text(synthetic::BODY).insert(0, "x").unwrap();
    faults.store(1, std::sync::atomic::Ordering::Relaxed);
    let refused = h.write(Origin::agent("s", 8), |doc| {
        doc.get_text(synthetic::BODY).insert(0, "never").unwrap();
    });
    assert!(refused.is_err(), "the outside edit could not be stored");
    insert(&h, Origin::agent("s", 8), 0, "a");
    h.close();
    let rows = added_per_row(&lib, "node:a");
    let tail: Vec<(&str, &str)> = rows[1..]
        .iter()
        .map(|(o, a)| (o.as_str(), a.as_str()))
        .collect();
    assert_eq!(tail, [("outside", "x"), ("agent:s/8", "a")]);
}

#[test]
fn copies_stay_complete_while_the_holder_compacts() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = options();
    o.compaction.max_updates = usize::MAX;
    let lib = Library::open(dir.path(), o).unwrap();
    let h = create(&lib, "node:a");
    let writer = {
        let h = h.clone();
        std::thread::spawn(move || {
            for k in 0..300i64 {
                h.write(Origin::User, move |doc| {
                    doc.get_map("meta").insert("k", k).unwrap();
                    doc.get_text(synthetic::BODY).insert(0, "字").unwrap();
                })
                .unwrap();
                if k % 3 == 0 {
                    h.compact_now().unwrap();
                }
            }
        })
    };
    let mut last = -1;
    while !writer.is_finished() {
        let copy = lib.load_copy("node:a").unwrap();
        let k = synthetic::last_crash_edit(&copy);
        assert!(k >= last, "a copy went back from {last} to {k}");
        assert_eq!(text(&copy).chars().count() as i64, k + 2, "text matches k");
        last = k;
    }
    writer.join().unwrap();
}

#[test]
fn dropping_the_last_handle_does_not_wait_for_the_holder() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let pending = h
        .submit(Origin::User, |doc| {
            std::thread::sleep(Duration::from_millis(300));
            doc.get_text(synthetic::BODY).insert(0, "慢").unwrap();
        })
        .unwrap();
    let t = std::time::Instant::now();
    drop(h);
    assert!(
        t.elapsed() < Duration::from_millis(200),
        "drop returned at once"
    );
    pending.wait().unwrap();
    // Reopening waits for the old holder to finish closing.
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    assert_eq!(text(h.doc()), "慢\n");
    assert!(matches!(
        lib.clone().close(),
        Err(StoreError::DocumentsOpen(1))
    ));
    h.close();
    lib.close().unwrap();
    open(dir.path());
}

#[test]
fn a_panicking_read_leaves_the_holder_running() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let r: Result<(), _> = h.read(|_| panic!("bug in a query"));
    assert!(matches!(r, Err(StoreError::ReadPanicked(_))));
    insert(&h, Origin::User, 0, "仍在");
    assert_eq!(h.read(text::<LoroDoc>).unwrap(), "仍在\n");
}

#[test]
fn a_panicking_genesis_does_not_block_the_document() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = lib.open_doc(
            "node:a",
            OpenDoc::CreateIfMissing {
                kind: "node",
                book_id: None,
                genesis: &|_| panic!("bad genesis"),
            },
        );
    }));
    assert!(panicked.is_err());
    assert_eq!(lib.open_doc_count(), 0);
    let h = create(&lib, "node:a");
    assert_eq!(text(h.doc()), "\n");
}

#[test]
fn a_write_starts_on_a_settled_document_and_typed_readers_borrow_it() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    insert(&h, Origin::User, 0, "甲");
    // A stray edit is pending in Loro's shared transaction…
    h.doc().get_text(synthetic::BODY).insert(0, "x").unwrap();
    let persisted_before = lib.updates_since("node:a", 0).unwrap().len();
    let (pending, stored) = {
        let lib = lib.clone();
        h.write(Origin::User, move |doc| {
            // …but the job starts settled: nothing pending, all stored.
            let pending = doc.get_pending_txn_len();
            let stored = lib.updates_since("node:a", 0).unwrap().len();
            doc.get_text(synthetic::BODY).insert(0, "乙").unwrap();
            (pending, stored)
        })
        .unwrap()
        .0
    };
    assert_eq!(pending, 0);
    assert_eq!(
        stored,
        persisted_before + 1,
        "the stray edit was stored first"
    );
    // A typed reader borrows the open document without copying it.
    let len = h
        .doc()
        .with_doc(|doc| doc.get_text(synthetic::BODY).len_unicode());
    assert_eq!(len, "乙x甲\n".chars().count());
}

/// The author's commands (dr-workspace's `user:command`) are the author's
/// writes in every respect but the origin: the holder commits them with
/// `user:command` (so an editor's undo manager can leave them out), stores
/// and announces them as `Origin::Command`, writes no commit message (the
/// author's attribution) and labels them like typing.
#[test]
fn the_authors_commands_keep_their_own_origin_from_commit_to_event() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let loro_origins: Arc<Mutex<Vec<String>>> = Arc::default();
    {
        let seen = loro_origins.clone();
        h.read(move |doc| {
            doc.subscribe_root(Arc::new(move |e| {
                seen.lock().unwrap().push(e.origin.to_string());
            }))
            .detach();
        })
        .unwrap();
    }
    let events: Arc<Mutex<Vec<Origin>>> = Arc::default();
    let _sub = {
        let events = events.clone();
        h.subscribe(move |e| events.lock().unwrap().push(e.origin.clone()))
    };
    insert(&h, Origin::User, 0, "甲");
    insert(&h, Origin::Command, 0, "乙");
    // A job that commits part-way (as resolving an anchor does) takes the
    // options it set, as for any other origin.
    h.write(Origin::Command, |doc| {
        doc.set_next_commit_options(CommitOptions::new().origin(dr_store::COMMAND_ORIGIN));
        doc.get_text(synthetic::BODY).insert(0, "丙").unwrap();
        doc.commit();
        doc.get_text(synthetic::BODY).insert(0, "丁").unwrap();
    })
    .unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        [Origin::User, Origin::Command, Origin::Command]
    );
    assert_eq!(
        *loro_origins.lock().unwrap(),
        ["user", "user:command", "user:command", "user:command"]
    );
    let stored: Vec<(String, Option<Origin>)> = lib
        .updates_since("node:a", 1)
        .unwrap()
        .into_iter()
        .map(|r| (r.origin.clone(), Origin::parse(&r.origin)))
        .collect();
    assert_eq!(
        stored,
        [
            ("user".to_string(), Some(Origin::User)),
            ("user:command".to_string(), Some(Origin::Command)),
            ("user:command".to_string(), Some(Origin::Command)),
        ],
        "one row per job, the part-way commit included"
    );
    h.close();
    let doc = lib.load_copy("node:a").unwrap();
    let messages: Vec<Option<String>> = doc
        .export_json_updates(&Default::default(), &doc.oplog_vv())
        .unwrap()
        .changes
        .into_iter()
        .filter(|c| c.id.peer != (1 << 63) | 0x5EED)
        .map(|c| c.msg.as_deref().map(str::to_string))
        .collect();
    assert!(!messages.is_empty());
    assert!(messages.iter().all(Option::is_none), "{messages:?}");
    // A session of commands alone still earns the closing label.
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&h, Origin::Command, 0, "戊");
    h.close();
    let names: Vec<String> = lib
        .history("node:a")
        .unwrap()
        .into_iter()
        .map(|l| l.label)
        .collect();
    assert_eq!(names.first().map(String::as_str), Some(labels::CLOSE));
}

/// The holder sets a write's commit options before the job runs (F1's
/// request): Loro commits part-way through on its own (an import's barrier,
/// as dr-doc's seeds do; resolving an anchor on deleted text), and that part
/// carries the write's origin and commit message like the rest, without the
/// job setting anything itself. Nothing carries over into the next write.
#[test]
fn a_part_way_commit_carries_the_writes_origin_and_message() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let local: Arc<Mutex<Vec<String>>> = Arc::default();
    {
        let seen = local.clone();
        h.read(move |doc| {
            doc.subscribe_root(Arc::new(move |e| {
                if e.triggered_by == loro::EventTriggerKind::Local {
                    seen.lock().unwrap().push(e.origin.to_string());
                }
            }))
            .detach();
        })
        .unwrap();
    }
    // Someone else's change, imported from inside the job.
    let other = LoroDoc::new();
    other.set_peer_id(77).unwrap();
    other.get_text("seed").insert(0, "种").unwrap();
    other.commit();
    let foreign = other.export(ExportMode::all_updates()).unwrap();
    let write = dr_store::AgentWrite {
        session: "s".into(),
        turn: "1".into(),
        call: "c".into(),
        summary: "两处".into(),
    };
    let agent = write.origin();
    h.write_agent(write, move |doc| {
        doc.get_text(synthetic::BODY).insert(0, "前").unwrap();
        doc.import(&foreign).unwrap();
        doc.get_text(synthetic::BODY).insert(0, "后").unwrap();
    })
    .unwrap();
    h.write(Origin::Command, |doc| {
        doc.get_text(synthetic::BODY).insert(0, "甲").unwrap();
        doc.commit();
        doc.get_text(synthetic::BODY).insert(0, "乙").unwrap();
    })
    .unwrap();
    // A job that writes nothing, then typing: no options are left over.
    h.write(Origin::Mirror, |_| {}).unwrap();
    insert(&h, Origin::User, 0, "丙");
    let agent_origin = agent.to_string();
    assert_eq!(
        *local.lock().unwrap(),
        [
            agent_origin.as_str(),
            &agent_origin,
            COMMAND_ORIGIN,
            COMMAND_ORIGIN,
            "user"
        ],
        "every local commit carries its write's origin"
    );
    h.close();
    let doc = lib.load_copy("node:a").unwrap();
    // Every change with what it inserted (Loro merges adjacent changes
    // that share a message, so 甲, 乙 and 丙 may come as one).
    let changes: Vec<(String, Option<String>)> = doc
        .export_json_updates(&Default::default(), &doc.oplog_vv())
        .unwrap()
        .changes
        .into_iter()
        .map(|c| {
            let text: String = c
                .ops
                .iter()
                .filter_map(|o| match &o.content {
                    loro::JsonOpContent::Text(loro::JsonTextOp::Insert { text, .. }) => {
                        Some(text.as_str())
                    }
                    _ => None,
                })
                .collect();
            (text, c.msg.as_deref().map(str::to_string))
        })
        .collect();
    let message = agent.commit_message();
    assert!(message.is_some());
    let agents: String = changes
        .iter()
        .filter(|(_, m)| *m == message)
        .map(|(t, _)| t.as_str())
        .collect();
    assert_eq!(
        agents, "前后",
        "both parts of the Agent write carry its message, nothing else does: {changes:?}"
    );
    assert!(
        changes.iter().all(|(_, m)| m.is_none() || *m == message),
        "{changes:?}"
    );
}
