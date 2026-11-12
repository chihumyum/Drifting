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

// ---- the book document, and the two documents beside it -------------------

/// The events recorded since the last call, oldest first, each told by its
/// kind: `book`, `stats` (with the day keys it names) or `checkpoints`.
fn kinds(seen: &Arc<Mutex<Vec<WsEvent>>>) -> Vec<String> {
    std::mem::take(&mut *seen.lock().unwrap())
        .into_iter()
        .filter_map(|ev| match ev {
            WsEvent::Book(_) => Some("book".to_string()),
            WsEvent::Stats(s) => Some(format!("stats {}", s.days.join(","))),
            WsEvent::Checkpoints(c) => Some(format!("checkpoints {}", c.points.len())),
            _ => None,
        })
        .collect()
}

/// One commit written straight on the holder of `doc` (a build that writes
/// a root this one does not know, say).
fn raw_write(e: &Env, doc: &str, f: impl FnOnce(&loro::LoroDoc) + Send + 'static) {
    e.ws()
        .library()
        .open_doc(doc, dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, f)
        .unwrap();
}

fn entry_meta(d: &loro::LoroDoc, id: &str) -> loro::LoroMap {
    let tree = d.get_tree("entries");
    tree.nodes()
        .into_iter()
        .map(|n| tree.get_meta(n).unwrap())
        .find(|m| {
            matches!(
                m.get("id"),
                Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) if s.as_str() == id
            )
        })
        .expect("the entry")
}

const DEVICE: &str = "device-000000000000000000000001";

#[test]
fn writing_days_and_checkpoints_leave_the_book_document_alone() {
    let e = env();
    let b = e.book();
    let doc = format!("book:{b}");
    let c = common::acceptance::novel_entry(e.ws(), &b, "tpl-chapter", "One", Some("一。"))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (seen, _sub) = record(&e);
    let version = || e.ws().version(&doc).unwrap();

    // The recorder's minute: one commit to `stats:<book>`, none to the book.
    let before = version();
    e.call(
        "writing_day.record",
        json!({"book": b, "device": DEVICE, "day": "2026-11-12", "words": 120}),
    );
    assert_eq!(version(), before, "a writing day is no change to the book");
    assert_eq!(kinds(&seen), [format!("stats {DEVICE}|2026-11-12")]);
    // The same value again writes nothing and announces nothing.
    e.call(
        "writing_day.record",
        json!({"book": b, "device": DEVICE, "day": "2026-11-12", "words": 120}),
    );
    assert_eq!(kinds(&seen), Vec::<String>::new());
    assert_eq!(
        e.out(
            "book.writing_days",
            json!({"book": b, "today": "2026-11-12", "days": 1})
        )["today"],
        120
    );

    // An automatic checkpoint: `checkpoints:<book>` gains one manifest.
    let capture = |reason: &str| {
        e.call(
            "entry_snapshot.capture",
            json!({"book": b, "entry": c, "reason": reason}),
        );
        (version() != before, kinds(&seen))
    };
    assert_eq!(capture("close"), (false, vec!["checkpoints 1".to_string()]));
    // Nothing changed since: no new point, no commit, no event.
    assert_eq!(capture("close"), (false, vec![]));
    // The entry's text changed: the next point, and again only a manifest.
    e.call(
        "prose.replace",
        json!({"doc": format!("body:{c}/mod-prose"), "find": "一", "replace": "二"}),
    );
    assert_eq!(
        kinds(&seen),
        Vec::<String>::new(),
        "prose is another document"
    );
    assert_eq!(capture("close"), (false, vec!["checkpoints 1".to_string()]));
    assert_eq!(
        e.out("entry_snapshot.list", json!({"book": b, "entry": c}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // The points an author and an Agent save are the same kind of change.
    e.call("entry_snapshot.create", json!({"book": b, "entry": c}));
    assert_eq!(kinds(&seen), ["checkpoints 1"]);
    assert_eq!(version(), before);

    // The book's content: a book event.
    e.call(
        "entry.update",
        json!({"book": b, "id": c, "title": "Renamed"}),
    );
    assert_eq!(kinds(&seen), ["book"]);
    e.call(
        "book.update",
        json!({"book": b, "summary": "Synthetic summary"}),
    );
    assert_eq!(kinds(&seen), ["book"]);
    e.call(
        "fact.put",
        json!({"book": b, "key": "Synthetic fact", "value": "Synthetic value"}),
    );
    assert_eq!(kinds(&seen), ["book"]);
}

#[test]
fn every_change_to_the_book_document_is_a_change_to_the_book() {
    let e = env();
    let b = e.book();
    let doc = format!("book:{b}");
    let (seen, _sub) = record(&e);
    // Every root container of the book document, as dr-doc lists them, a
    // root this build has no name for, and the two names the documents
    // beside the book use, written into the book document by some other
    // writer: each is one book event, and none is a stats or checkpoints one.
    let roots: Vec<String> = Collection::ALL
        .iter()
        .map(|c| c.root().to_string())
        .chain(["synthetic_future_root", "writing_days", "entry_checkpoints"].map(String::from))
        .collect();
    for root in roots {
        let tree = Collection::from_root(&root).is_some_and(|c| c.is_tree());
        let r = root.clone();
        raw_write(&e, &doc, move |d| {
            if tree {
                d.get_tree(r.as_str()).create(None).unwrap();
            } else {
                d.get_map(r.as_str()).insert("synthetic-key", 1).unwrap();
            }
        });
        assert_eq!(kinds(&seen), ["book"], "{root}");
    }
}

#[test]
fn changes_from_another_device_reach_the_document_they_belong_to() {
    let e = env();
    let b = e.book();
    let c = common::acceptance::novel_entry(e.ws(), &b, "tpl-chapter", "One", None)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (seen, _sub) = record(&e);
    // The other device: copies of the stored documents with peers of their own.
    let remote = |doc: String, kind: &'static str| {
        let other = e.ws().library().load_copy(&doc).unwrap();
        let sent = std::cell::RefCell::new(other.oplog_vv());
        let e = &e;
        let b = b.clone();
        move |write: &dyn Fn(&loro::LoroDoc)| {
            write(&other);
            other.commit();
            let bytes = other
                .export(loro::ExportMode::updates(&sent.borrow()))
                .unwrap();
            *sent.borrow_mut() = other.oplog_vv();
            assert!(
                e.ws()
                    .import_remote(&doc, Some((kind, b.as_str())), bytes, &Actor::Sync)
                    .unwrap()
            );
        }
    };
    let stats = remote(format!("stats:{b}"), "stats");
    let points = remote(format!("checkpoints:{b}"), "checkpoints");
    let book = remote(format!("book:{b}"), "book");
    let origins_are_sync = |seen: &Arc<Mutex<Vec<WsEvent>>>| {
        seen.lock().unwrap().iter().all(|ev| match ev {
            WsEvent::Book(x) => x.origin == dr_store::Origin::Sync,
            WsEvent::Stats(x) => x.origin == dr_store::Origin::Sync,
            WsEvent::Checkpoints(x) => x.origin == dr_store::Origin::Sync,
            _ => true,
        })
    };
    let other_device = "device-000000000000000000000002";
    stats(&|d| {
        d.get_map("writing_days")
            .insert(&format!("{other_device}|2026-11-12"), 300)
            .unwrap();
    });
    assert!(origins_are_sync(&seen));
    assert_eq!(
        kinds(&seen),
        [format!("stats {other_device}|2026-11-12")],
        "its recorder's minute"
    );
    points(&|d| {
        d.get_map("entry_checkpoints")
            .insert("synthetic-remote-point", "synthetic manifest")
            .unwrap();
    });
    assert!(origins_are_sync(&seen));
    assert_eq!(kinds(&seen), ["checkpoints 1"], "a checkpoint it saved");
    book(&|d| {
        entry_meta(d, &c).insert("title", "Renamed there").unwrap();
    });
    assert!(origins_are_sync(&seen));
    assert_eq!(kinds(&seen), ["book"], "a title it changed");
    assert_eq!(
        e.out("entry.get", json!({"book": b, "id": c}))["title"],
        "Renamed there"
    );
    assert_eq!(
        e.out(
            "book.writing_days",
            json!({"book": b, "today": "2026-11-12", "days": 1})
        )["today"],
        300
    );
}
