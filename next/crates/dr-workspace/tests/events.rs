//! Events: fine-grained, after the change is durable, and the caches follow
//! them.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use dr_doc::v3::CollectionV3 as Collection;
use dr_workspace::{Actor, WsEvent};
use serde_json::json;

fn record(e: &Env) -> (Arc<Mutex<Vec<WsEvent>>>, dr_workspace::Subscription) {
    let seen: Arc<Mutex<Vec<WsEvent>>> = Arc::default();
    let s = seen.clone();
    let sub = e
        .ws()
        .subscribe(move |ev| s.lock().unwrap().push(ev.clone()));
    (seen, sub)
}

#[test]
fn book_events_name_the_entities() {
    let e = env();
    let b = e.book();
    let (seen, _sub) = record(&e);
    let c = e.out("entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let events = seen.lock().unwrap().clone();
    let book_ev = events
        .iter()
        .find_map(|ev| match ev {
            WsEvent::Book(b) => Some(b.clone()),
            _ => None,
        })
        .expect("a book event");
    assert_eq!(book_ev.book.as_str(), b);
    assert_eq!(book_ev.origin.to_string(), "user");
    assert!(
        book_ev
            .changes
            .iter()
            .any(|ch| ch.collection == Collection::Entries && ch.id.as_deref() == Some(c.as_str())),
        "{book_ev:?}"
    );
    // The journal row is a local-table event on the same bus.
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, WsEvent::Local(l) if l.table == "ws_journal"))
    );
    // Delivered before the command returned: the durable row exists.
    assert!(
        e.ws()
            .library()
            .head(&format!("book:{b}"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn prose_events_name_ranges_and_paragraphs() {
    let e = env();
    let b = e.book();
    let c = e.out(
        "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "One", "bodies": {"mod-prose": "一。\n二。\n三。"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("body:{c}/mod-prose");
    let paras = e.out("prose.read", json!({"doc": doc}))["paragraphs"].clone();
    let (seen, _sub) = record(&e);
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "二", "replace": "两"}),
    );
    let events = seen.lock().unwrap().clone();
    let p = events
        .iter()
        .find_map(|ev| match ev {
            WsEvent::Prose(p) => Some(p.clone()),
            _ => None,
        })
        .expect("a prose event");
    assert_eq!(p.doc.to_string(), doc);
    assert_eq!(p.book.as_ref().map(|b| b.to_string()), Some(b));
    assert!(!p.ranges.is_empty());
    let ids: Vec<String> = p.blocks.iter().map(|b| b.to_string()).collect();
    assert_eq!(
        ids,
        [paras[1]["block_id"].as_str().unwrap().to_string()],
        "only the second paragraph"
    );
}

#[test]
fn agent_writes_announce_their_settlement() {
    let e = env();
    let b = e.book();
    let (seen, _sub) = record(&e);
    let agent = Actor::agent("sess", 1, "call-1");
    e.ws()
        .call(
            &agent,
            "entry.create", json!({"book": b, "parent": common::acceptance::novel_root(e.ws(), &b, "tpl-manuscript"), "template": "tpl-chapter", "title": "By agent"}),
        )
        .unwrap();
    let events = seen.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, WsEvent::Book(x) if x.origin.to_string() == "agent:sess/1"))
    );
    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, WsEvent::Local(l) if l.table == "agent_settlement"))
    );
    let s = e.ws().library().settlements(Some("sess"), None).unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!((s[0].turn.as_str(), s[0].call.as_str()), ("1", "call-1"));
    assert!(s[0].summary.contains("entry.create"));
}

#[test]
fn committed_entry_reads_follow_the_announced_changes() {
    let e = env();
    let b = e.book();
    let c = common::acceptance::novel_entry(e.ws(), &b, "tpl-chapter", "One", None)["id"].clone();
    let (seen, _sub) = record(&e);
    e.call("entry.update", json!({"book":b,"id":c,"title":"Renamed"}));
    assert_eq!(
        e.out("entry.get", json!({"book":b,"id":c}))["title"],
        "Renamed"
    );
    assert!(seen.lock().unwrap().iter().any(|ev| matches!(ev,WsEvent::Book(ev) if ev.changes.iter().any(|c|c.collection==Collection::Entries && c.fields.as_ref().is_some_and(|f|f.iter().any(|f|f=="title"))))));
}
