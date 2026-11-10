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
    let entries = e.out("entry.list", json!({"book":b,"all":true,"trashed":true}));
    for entry in entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["template"] == "tpl-chapter")
    {
        assert!(
            e.ws()
                .library()
                .doc_info(&format!("body:{}/mod-prose", entry["id"].as_str().unwrap()))
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn a_failure_after_the_prose_leaves_only_an_orphan() {
    let mut e = env();
    let b = e.book();
    let before = e.ws().library().docs(Some(&b), Some("body")).unwrap().len();
    e.faults.arm("after_prose");
    let err = e
        .try_call(
            "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "Lost", "bodies": {"mod-prose": "写下的字。"}}),
        )
        .unwrap_err();
    assert!(matches!(err, WsError::Fault("after_prose")));
    assert!(
        ids(&e.out(
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ))
        .is_empty(),
        "no chapter shows"
    );
    // The prose document was written first and is orphaned: nothing in the
    // book owns it.
    let docs = e.ws().library().docs(Some(&b), Some("body")).unwrap();
    assert_eq!(docs.len(), before + 1);
    check_book(&e, &b);
    e.reopen();
    assert!(
        ids(&e.out(
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ))
        .is_empty()
    );
    check_book(&e, &b);
    // The next command works normally.
    e.call("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "Kept"}));
    assert_eq!(
        ids(&e.out(
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ))
        .len(),
        1
    );
}

#[test]
fn a_failed_journal_write_keeps_the_change_without_undo() {
    let e = env();
    let b = e.book();
    e.faults.arm("journal");
    let o = e.call("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One"}));
    assert_eq!(o["journal"], Value::Null);
    assert_eq!(o["undo"], Value::Null);
    assert_eq!(
        ids(&e.out(
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ))
        .len(),
        1
    );
    // The journal's last entry is the book's creation.
    let j = e.ws().journal(Some("user"), 10).unwrap();
    assert_eq!(j[0].command, "project.create");
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
    let b = call(&ws, &u, "project.create", json!({"name": "B"}))["output"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    faults.store(1, std::sync::atomic::Ordering::SeqCst);
    let err = ws
        .call(&u, "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(&ws, &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One"}))
        .unwrap_err();
    assert!(matches!(err, WsError::Store(_)), "{err}");
    // dr-store keeps the unstored change in memory and stores it before the
    // next write; its events (and so the cached views) wait until then.
    call(
        &ws,
        &u,
        "entry.create",
        json!({"book": b, "parent": common::acceptance::novel_root(&ws, &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "Two"}),
    );
    assert_eq!(
        ids(&call(
            &ws,
            &u,
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(&ws,&b,"tpl-manuscript")})
        )["output"])
        .len(),
        2
    );
    ws.shutdown().unwrap();
    let ws = open();
    let titles = field(
        &call(
            &ws,
            &u,
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(&ws,&b,"tpl-manuscript")}),
        )["output"],
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
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "甲。\n乙。"}}),
    )["id"]
        .clone();
    e.reopen();
    let p = e.out(
        "prose.read",
        json!({"doc": format!("body:{}/mod-prose", c.as_str().unwrap())}),
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
            "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": format!("C{i}")}),
        );
    }
    let c0 = ids(&e.out(
        "entry.list",
        json!({"book": b,"parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")}),
    ))[0]
        .clone();
    e.call(
        "entry.update",
        json!({"book": b, "id": c0, "title": "First"}),
    );
    let before = e.out(
        "entry.list",
        json!({"book": b,"parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")}),
    );
    // No flush: shut down and read from disk.
    e.reopen();
    assert_eq!(
        e.out(
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(e.ws(),&b,"tpl-manuscript")})
        ),
        before
    );
}

#[test]
fn a_refused_shutdown_hands_the_workspace_back() {
    let dir = tempfile::tempdir().unwrap();
    let ws = open_at(dir.path(), Arc::new(Faults::default()));
    let u = Actor::User;
    let b = call(&ws, &u, "project.create", json!({"name": "书"}))["output"]["id"]
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
    assert!(
        ids(&call(
            &ws,
            &u,
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(&ws,&b,"tpl-manuscript")})
        )["output"])
        .is_empty()
    );
    call(
        &ws,
        &u,
        "entry.create",
        json!({"book": b, "parent": common::acceptance::novel_root(&ws, &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One"}),
    );
    assert_eq!(
        ids(&call(
            &other,
            &u,
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(&ws,&b,"tpl-manuscript")})
        )["output"])
        .len(),
        1,
        "the caches follow the new write"
    );
    // Once the other one lets go, it closes, and the library opens again.
    drop(other);
    ws.shutdown().unwrap();
    let ws = open_at(dir.path(), Arc::new(Faults::default()));
    assert_eq!(
        ids(&call(
            &ws,
            &u,
            "entry.list",
            json!({"book": b,"parent":common::acceptance::novel_root(&ws,&b,"tpl-manuscript")})
        )["output"])
        .len(),
        1
    );
    ws.shutdown().unwrap();
}
