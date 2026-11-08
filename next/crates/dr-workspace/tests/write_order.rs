//! Write order across documents, and what a failure half-way leaves: after
//! every injected fault, reading again (also after reopening from disk)
//! finds the invariants intact or tolerated.

mod common;

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use common::*;
use dr_store::Library;
use dr_workspace::{Actor, Faults, Workspace, WorkspaceOptions, WsError, library_options};
use serde_json::{Value, json};

/// A book entity never names a prose document that is not stored, and every
/// read is tolerant.
fn check_book(e: &Env, b: &str) {
    let lib = e.ws().library();
    for c in ids(&e.out("chapter.list", json!({"book": b, "trashed": true}))) {
        assert!(
            lib.doc_info(&format!("node:{c}")).unwrap().is_some(),
            "chapter {c} has its prose document"
        );
    }
    for el in ids(&e.out("element.list", json!({"book": b, "trashed": true}))) {
        assert!(lib.doc_info(&format!("element:{el}")).unwrap().is_some());
    }
    let live: Vec<String> = ids(&e.out("chapter.list", json!({"book": b})))
        .into_iter()
        .chain(ids(&e.out("element.list", json!({"book": b}))))
        .collect();
    for r in e
        .out("relation.list", json!({"book": b}))
        .as_array()
        .unwrap()
    {
        for end in ["from", "to"] {
            assert!(
                live.contains(&r[end]["id"].as_str().unwrap().to_string()),
                "relation end live"
            );
        }
    }
}

#[test]
fn a_failure_after_the_prose_leaves_only_an_orphan() {
    let mut e = env();
    let b = e.book();
    e.faults.arm("after_prose");
    let err = e
        .try_call(
            "chapter.create",
            json!({"book": b, "title": "Lost", "text": "写下的字。"}),
        )
        .unwrap_err();
    assert!(matches!(err, WsError::Fault("after_prose")));
    assert!(
        ids(&e.out("chapter.list", json!({"book": b}))).is_empty(),
        "no chapter shows"
    );
    // The prose document was written first and is orphaned: nothing in the
    // book owns it.
    let docs = e.ws().library().docs(Some(&b), Some("node")).unwrap();
    assert_eq!(docs.len(), 1);
    check_book(&e, &b);
    e.reopen();
    assert!(ids(&e.out("chapter.list", json!({"book": b}))).is_empty());
    check_book(&e, &b);
    // The next command works normally.
    e.call("chapter.create", json!({"book": b, "title": "Kept"}));
    assert_eq!(ids(&e.out("chapter.list", json!({"book": b}))).len(), 1);
}

#[test]
fn a_failure_inside_the_book_commit_keeps_what_was_applied() {
    let mut e = env();
    let b = e.book();
    let c = e.out("chapter.create", json!({"book": b, "title": "One"}))["id"].clone();
    let el = e.out("element.create", json!({"book": b, "name": "A"}))["id"].clone();
    let t = e.out(
        "relation_type.create",
        json!({"book": b, "name": "r", "orientation": "symmetric",
        "source_kinds": ["element", "node"], "target_kinds": ["element", "node"]}),
    )["id"]
        .clone();
    e.call("relation.create", json!({"book": b, "from": {"kind": "element", "id": el}, "to": {"kind": "node", "id": c}, "relation_type": t}));
    e.faults.arm("in_book");
    let err = e
        .try_call("chapter.purge", json!({"book": b, "id": c}))
        .unwrap_err();
    assert!(matches!(err, WsError::Fault("in_book")));
    // dr-doc committed the first half (the relation is gone); the chapter
    // is still there. Both halves are readable states.
    assert_eq!(
        ids(&e.out("chapter.list", json!({"book": b}))),
        [c.as_str().unwrap()]
    );
    assert!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    check_book(&e, &b);
    // The mirror and the store agree: reopening reads the same.
    let before = e.out("chapter.list", json!({"book": b}));
    e.reopen();
    assert_eq!(e.out("chapter.list", json!({"book": b})), before);
    assert!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    // Retrying finishes the purge.
    e.call("chapter.purge", json!({"book": b, "id": c}));
    assert!(ids(&e.out("chapter.list", json!({"book": b, "trashed": true}))).is_empty());
    check_book(&e, &b);
}

#[test]
fn a_failed_journal_write_keeps_the_change_without_undo() {
    let e = env();
    let b = e.book();
    e.faults.arm("journal");
    let o = e.call("chapter.create", json!({"book": b, "title": "One"}));
    assert_eq!(o["journal"], Value::Null);
    assert_eq!(o["undo"], Value::Null);
    assert_eq!(ids(&e.out("chapter.list", json!({"book": b}))).len(), 1);
    // The journal's last entry is the book's creation.
    let j = e.ws().journal(Some("user"), 10).unwrap();
    assert_eq!(j[0].command, "book.create");
}

#[test]
fn a_failed_store_append_is_retried_by_the_next_write() {
    let dir = tempfile::tempdir().unwrap();
    let faults = Arc::new(AtomicUsize::new(0));
    let open = || {
        let mut o = library_options("test");
        o.append_faults = Some(faults.clone());
        let lib = Library::open(dir.path(), o).unwrap();
        Workspace::open(
            lib,
            WorkspaceOptions {
                faults: Some(Arc::new(Faults::default())),
                ..Default::default()
            },
        )
        .unwrap()
    };
    let ws = open();
    let u = Actor::User;
    let b = call(&ws, &u, "book.create", json!({"name": "B"}))["output"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    faults.store(1, std::sync::atomic::Ordering::SeqCst);
    let err = ws
        .call(&u, "chapter.create", json!({"book": b, "title": "One"}))
        .unwrap_err();
    assert!(matches!(err, WsError::Store(_)), "{err}");
    // dr-store keeps the unstored change in memory and stores it before the
    // next write; its events (and so the cached views) wait until then.
    call(
        &ws,
        &u,
        "chapter.create",
        json!({"book": b, "title": "Two"}),
    );
    assert_eq!(
        ids(&call(&ws, &u, "chapter.list", json!({"book": b}))["output"]).len(),
        2
    );
    ws.shutdown().unwrap();
    let ws = open();
    let titles = field(
        &call(&ws, &u, "chapter.list", json!({"book": b}))["output"],
        "title",
    );
    assert_eq!(
        titles,
        [json!("One"), json!("Two")],
        "the retry stored the first write too"
    );
    ws.shutdown().unwrap();
}

#[test]
fn prose_written_before_the_book_survives_a_reopen() {
    let mut e = env();
    let b = e.book();
    let c = e.out(
        "chapter.create",
        json!({"book": b, "title": "One", "text": "甲。\n乙。"}),
    )["id"]
        .clone();
    e.reopen();
    let p = e.out(
        "prose.read",
        json!({"doc": format!("node:{}", c.as_str().unwrap())}),
    );
    assert_eq!(
        field(&p["paragraphs"], "text"),
        [json!("甲。"), json!("乙。")]
    );
    check_book(&e, &b);
}

#[test]
fn every_commit_is_durable_when_the_command_returns() {
    let mut e = env();
    let b = e.book();
    for i in 0..20 {
        e.call(
            "chapter.create",
            json!({"book": b, "title": format!("C{i}")}),
        );
    }
    let c0 = ids(&e.out("chapter.list", json!({"book": b})))[0].clone();
    e.call(
        "chapter.update",
        json!({"book": b, "id": c0, "title": "First"}),
    );
    let before = e.out("chapter.list", json!({"book": b}));
    // No flush: shut down and read from disk.
    e.reopen();
    assert_eq!(e.out("chapter.list", json!({"book": b})), before);
}

#[test]
fn a_refused_shutdown_hands_the_workspace_back() {
    let dir = tempfile::tempdir().unwrap();
    let ws = open_at(dir.path(), Arc::new(Faults::default()));
    let u = Actor::User;
    let b = call(&ws, &u, "book.create", json!({"name": "书"}))["output"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    ws.set_auto_links(false);
    // Someone still holds the workspace: the close is refused and the
    // workspace comes back, working and listening as before.
    let other = ws.clone();
    let refused = ws.try_shutdown().unwrap_err();
    assert!(
        matches!(refused.error, WsError::Internal(_)),
        "{:?}",
        refused.error
    );
    let ws = refused.workspace.expect("handed back");
    assert!(!ws.auto_links(), "the author's setting is kept");
    // A cached list first, so the next one needs the write's event.
    assert!(ids(&call(&ws, &u, "chapter.list", json!({"book": b}))["output"]).is_empty());
    call(
        &ws,
        &u,
        "chapter.create",
        json!({"book": b, "title": "One"}),
    );
    assert_eq!(
        ids(&call(&other, &u, "chapter.list", json!({"book": b}))["output"]).len(),
        1,
        "the caches follow the new write"
    );
    // Once the other one lets go, it closes, and the library opens again.
    drop(other);
    ws.shutdown().unwrap();
    let ws = open_at(dir.path(), Arc::new(Faults::default()));
    assert_eq!(
        ids(&call(&ws, &u, "chapter.list", json!({"book": b}))["output"]).len(),
        1
    );
    ws.shutdown().unwrap();
}
