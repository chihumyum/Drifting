//! Events: fine-grained, after the change is durable, and the caches follow
//! them.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use dr_doc::book::Collection;
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
    let c = e.out("chapter.create", json!({"book": b, "title": "One"}))["id"]
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
            .any(|ch| ch.collection == Collection::Nodes && ch.id.as_deref() == Some(c.as_str()))
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
        "chapter.create",
        json!({"book": b, "title": "One", "text": "一。\n二。\n三。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let doc = format!("node:{c}");
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
            "chapter.create",
            json!({"book": b, "title": "By agent"}),
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
    assert!(s[0].summary.contains("By agent"));
}

#[test]
fn caches_follow_events() {
    let e = env();
    let b = e.book();
    let c = e.out("chapter.create", json!({"book": b, "title": "One"}))["id"].clone();
    for _ in 0..3 {
        e.out("chapter.list", json!({"book": b}));
    }
    let (hits, _) = e.ws().cache_stats(&b).unwrap();
    assert!(hits >= 2, "repeated lists hit the cache ({hits})");
    e.call(
        "chapter.update",
        json!({"book": b, "id": c, "title": "Renamed"}),
    );
    assert_eq!(
        e.out("chapter.list", json!({"book": b}))[0]["title"],
        "Renamed",
        "patched from the event"
    );
    let el = e.out("element.create", json!({"book": b, "name": "A"}))["id"].clone();
    e.out("element.list", json!({"book": b}));
    let cat = e.out("category.create", json!({"book": b, "name": "People"}))["id"].clone();
    e.call(
        "element.update",
        json!({"book": b, "id": el, "category": cat}),
    );
    e.call("category.trash", json!({"book": b, "id": cat}));
    assert_eq!(
        e.out("element.list", json!({"book": b}))[0]["category"],
        serde_json::Value::Null,
        "dependent read dropped"
    );
}

/// The `chapter_template` / `element_template` changes in `events`, as
/// (collection, owner id).
fn template_changes(events: &[WsEvent]) -> Vec<(Collection, String)> {
    events
        .iter()
        .filter_map(|ev| match ev {
            WsEvent::Book(b) => Some(b.changes.clone()),
            _ => None,
        })
        .flatten()
        .filter(|c| {
            c.fields.as_ref().is_some_and(|f| {
                f.iter()
                    .any(|f| f == "chapter_template" || f == "element_template")
            })
        })
        .map(|c| (c.collection, c.id.unwrap_or_default()))
        .collect()
}

#[test]
fn a_template_that_starts_or_stops_holding_something_changes_its_owner() {
    let e = env();
    let b = e.book();
    let line = e.out("storyline.create", json!({"book": b, "name": "主线"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let cat = e.out("category.create", json!({"book": b, "name": "人物"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    // The lists see both owners without a template (and remember it).
    assert_eq!(
        e.out("storyline.list", json!({"book": b}))[0]["has_chapter_template"],
        false
    );
    let doc = e.out(
        "chapter_template.document",
        json!({"book": b, "storyline": line}),
    )["doc"]
        .as_str()
        .unwrap()
        .to_string();
    e.out("storyline.list", json!({"book": b}));
    let (seen, _sub) = record(&e);
    // Typed in an editor: the first words make it a template.
    let s = e.ws().prose_session(&doc).unwrap();
    s.edit(|t| t.insert_text(0, "开")).unwrap();
    let take = || std::mem::take(&mut *seen.lock().unwrap());
    assert_eq!(
        template_changes(&take()),
        [(Collection::Storylines, line.clone())]
    );
    assert_eq!(
        e.out("storyline.list", json!({"book": b}))[0]["has_chapter_template"],
        true
    );
    // More typing is only prose.
    s.edit(|t| t.insert_text(1, "场")).unwrap();
    let events = take();
    assert!(template_changes(&events).is_empty());
    assert!(events.iter().any(|ev| matches!(ev, WsEvent::Prose(_))));
    // Emptied, it is no template again.
    s.edit(|t| t.delete(0..2)).unwrap();
    assert_eq!(
        template_changes(&take()),
        [(Collection::Storylines, line.clone())]
    );
    drop(s);
    assert_eq!(
        e.out("storyline.list", json!({"book": b}))[0]["has_chapter_template"],
        false
    );
    // The same for a category's element template, through the command.
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": [{"text": "外貌"}]}),
    );
    assert_eq!(
        template_changes(&take()),
        [(Collection::Categories, cat.clone())]
    );
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": [{"text": "性格"}]}),
    );
    assert!(template_changes(&take()).is_empty());
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": []}),
    );
    assert_eq!(template_changes(&take()), [(Collection::Categories, cat)]);
}
