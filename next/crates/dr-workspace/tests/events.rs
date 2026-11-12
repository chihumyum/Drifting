//! Events: fine-grained, after the change is durable, and the caches follow
//! them.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use dr_doc::v3::CollectionV3 as Collection;
use dr_workspace::{Actor, BookChanged, BookTouched, WsEvent};
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

// ---- what a book change touched ---------------------------------------------

const CONTENT: BookTouched = BookTouched {
    content: true,
    writing_days: false,
    checkpoints: false,
};
const WRITING_DAYS: BookTouched = BookTouched {
    content: false,
    writing_days: true,
    checkpoints: false,
};
const CHECKPOINTS: BookTouched = BookTouched {
    content: false,
    writing_days: false,
    checkpoints: true,
};

/// The book events recorded since the last call, oldest first.
fn book_events(seen: &Arc<Mutex<Vec<WsEvent>>>) -> Vec<BookChanged> {
    std::mem::take(&mut *seen.lock().unwrap())
        .into_iter()
        .filter_map(|ev| match ev {
            WsEvent::Book(b) => Some(b),
            _ => None,
        })
        .collect()
}

/// What each of those events touched.
fn touched(seen: &Arc<Mutex<Vec<WsEvent>>>) -> Vec<BookTouched> {
    book_events(seen).iter().map(|b| b.touched).collect()
}

/// One commit to the book document written straight on its holder, as a
/// build that writes several roots at once (or a root this one does not
/// know) would leave it.
fn raw_write(e: &Env, book: &str, f: impl FnOnce(&loro::LoroDoc) + Send + 'static) {
    e.ws()
        .library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
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
fn a_writing_day_or_a_saved_checkpoint_does_not_touch_the_books_content() {
    let e = env();
    let b = e.book();
    let doc = format!("book:{b}");
    let c = common::acceptance::novel_entry(e.ws(), &b, "tpl-chapter", "One", Some("一。"))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (seen, _sub) = record(&e);
    let version = || e.ws().version(&doc).unwrap();

    // The recorder's minute: one commit to the book document, and no part
    // of the book's content in it.
    let before = version();
    e.call(
        "writing_day.record",
        json!({"book": b, "device": DEVICE, "day": "2026-11-12", "words": 120}),
    );
    assert_ne!(version(), before, "the writing day is a commit to the book");
    assert_eq!(touched(&seen), [WRITING_DAYS]);
    // The same value again writes nothing and announces nothing.
    e.call(
        "writing_day.record",
        json!({"book": b, "device": DEVICE, "day": "2026-11-12", "words": 120}),
    );
    assert_eq!(touched(&seen), []);

    // An automatic checkpoint: the book document gains one manifest.
    let capture = |reason: &str| {
        let before = version();
        e.call(
            "entry_snapshot.capture",
            json!({"book": b, "entry": c, "reason": reason}),
        );
        (version() != before, touched(&seen))
    };
    assert_eq!(capture("close"), (true, vec![CHECKPOINTS]));
    // Nothing changed since: no new point, no commit, no event.
    assert_eq!(capture("close"), (false, vec![]));
    // The entry's text changed: the next point, and again only a manifest.
    e.call(
        "prose.replace",
        json!({"doc": format!("body:{c}/mod-prose"), "find": "一", "replace": "二"}),
    );
    assert_eq!(touched(&seen), [], "prose is another document");
    assert_eq!(capture("close"), (true, vec![CHECKPOINTS]));
    assert_eq!(
        e.out("entry_snapshot.list", json!({"book": b, "entry": c}))
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // The points an author and an Agent save are the same kind of change.
    e.call("entry_snapshot.create", json!({"book": b, "entry": c}));
    assert_eq!(touched(&seen), [CHECKPOINTS]);

    // The book's content: every listener is told.
    e.call(
        "entry.update",
        json!({"book": b, "id": c, "title": "Renamed"}),
    );
    assert_eq!(touched(&seen), [CONTENT]);
    e.call(
        "book.update",
        json!({"book": b, "summary": "Synthetic summary"}),
    );
    assert_eq!(touched(&seen), [CONTENT]);
    e.call(
        "fact.put",
        json!({"book": b, "key": "Synthetic fact", "value": "Synthetic value"}),
    );
    assert_eq!(touched(&seen), [CONTENT]);
}

#[test]
fn a_change_that_touches_the_content_too_is_a_change_to_the_content() {
    let e = env();
    let b = e.book();
    let c = common::acceptance::novel_entry(e.ws(), &b, "tpl-chapter", "One", None)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (seen, _sub) = record(&e);

    // A title and a writing day in one commit.
    let entry = c.clone();
    raw_write(&e, &b, move |d| {
        entry_meta(d, &entry).insert("title", "Renamed").unwrap();
        d.get_map("writing_days")
            .insert(&format!("{DEVICE}|2026-11-12"), 7)
            .unwrap();
    });
    assert_eq!(
        touched(&seen),
        [BookTouched {
            content: true,
            writing_days: true,
            checkpoints: false,
        }]
    );
    // A checkpoint manifest and a writing day: neither is content.
    raw_write(&e, &b, |d| {
        d.get_map("entry_checkpoints")
            .insert("synthetic-point", "synthetic manifest")
            .unwrap();
        d.get_map("writing_days")
            .insert(&format!("{DEVICE}|2026-11-13"), 9)
            .unwrap();
    });
    assert_eq!(
        touched(&seen),
        [BookTouched {
            content: false,
            writing_days: true,
            checkpoints: true,
        }]
    );
    // A point saved and an older one thinned in the same commit (what
    // saving an automatic point does once the older ones are due).
    raw_write(&e, &b, |d| {
        let points = d.get_map("entry_checkpoints");
        points
            .insert("synthetic-later-point", "synthetic manifest")
            .unwrap();
        points.delete("synthetic-point").unwrap();
    });
    assert_eq!(touched(&seen), [CHECKPOINTS]);
    // All three.
    raw_write(&e, &b, |d| {
        d.get_map("meta").insert("summary", "Synthetic").unwrap();
        d.get_map("entry_checkpoints")
            .delete("synthetic-later-point")
            .unwrap();
        d.get_map("writing_days")
            .insert(&format!("{DEVICE}|2026-11-13"), 10)
            .unwrap();
    });
    assert_eq!(touched(&seen), [BookTouched::EVERYTHING]);
}

#[test]
fn every_root_but_the_writing_days_and_the_checkpoints_is_content() {
    let e = env();
    let b = e.book();
    let (seen, _sub) = record(&e);

    // Every root container of the book document, as dr-doc lists them. A
    // root added to that list is content until this test is told otherwise.
    for collection in Collection::ALL {
        let root = collection.root();
        raw_write(&e, &b, move |d| {
            if collection.is_tree() {
                d.get_tree(root).create(None).unwrap();
            } else {
                d.get_map(root).insert("synthetic-key", 1).unwrap();
            }
        });
        let want = match collection {
            Collection::WritingDays => WRITING_DAYS,
            _ => CONTENT,
        };
        assert_eq!(touched(&seen), [want], "{root}");
    }
    // The second root that is no collection of dr-doc's.
    raw_write(&e, &b, |d| {
        d.get_map("entry_checkpoints")
            .insert("synthetic-point", "synthetic manifest")
            .unwrap();
    });
    assert_eq!(touched(&seen), [CHECKPOINTS]);

    // A value nested under one of the two roots still lies under it …
    raw_write(&e, &b, |d| {
        let nested = d
            .get_map("writing_days")
            .insert_container("synthetic-nested", loro::LoroMap::new())
            .unwrap();
        nested.insert("words", 1).unwrap();
    });
    assert_eq!(touched(&seen), [WRITING_DAYS]);
    raw_write(&e, &b, |d| {
        let Some(loro::ValueOrContainer::Container(loro::Container::Map(nested))) =
            d.get_map("writing_days").get("synthetic-nested")
        else {
            panic!("the nested map");
        };
        nested.insert("words", 2).unwrap();
    });
    assert_eq!(touched(&seen), [WRITING_DAYS]);

    // … and everything else is content: a root this build has no name for,
    // roots that only resemble the two, a root of the same name and another
    // container type, and a container of that name under any other root.
    for root in [
        "synthetic_future_root",
        "writing_days_v2",
        "entry_checkpoint",
        "Writing_Days",
    ] {
        raw_write(&e, &b, move |d| {
            d.get_map(root).insert("synthetic-key", 1).unwrap();
        });
        assert_eq!(touched(&seen), [CONTENT], "{root}");
    }
    for root in ["writing_days", "entry_checkpoints"] {
        raw_write(&e, &b, move |d| {
            d.get_list(root).insert(0, 1).unwrap();
        });
        assert_eq!(touched(&seen), [CONTENT], "a list named {root}");
        raw_write(&e, &b, move |d| {
            d.get_text(root).insert(0, "synthetic").unwrap();
        });
        assert_eq!(touched(&seen), [CONTENT], "a text named {root}");
    }
    raw_write(&e, &b, |d| {
        let nested = d
            .get_map("synthetic_future_root")
            .insert_container("writing_days", loro::LoroMap::new())
            .unwrap();
        nested.insert("synthetic-key", 1).unwrap();
    });
    assert_eq!(touched(&seen), [CONTENT]);
}

#[test]
fn changes_from_another_device_are_told_apart_the_same_way() {
    let e = env();
    let b = e.book();
    let id = format!("book:{b}");
    let c = common::acceptance::novel_entry(e.ws(), &b, "tpl-chapter", "One", None)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // The other device: a copy of the stored book with a peer of its own.
    let other = e.ws().library().load_copy(&id).unwrap();
    let sent = std::cell::RefCell::new(other.oplog_vv());
    // What it has committed since its last upload, with `write` on top.
    let upload = |write: &dyn Fn(&loro::LoroDoc)| {
        write(&other);
        other.commit();
        let bytes = other
            .export(loro::ExportMode::updates(&sent.borrow()))
            .unwrap();
        *sent.borrow_mut() = other.oplog_vv();
        bytes
    };
    let (seen, _sub) = record(&e);
    let arrive = |bytes: Vec<u8>| {
        assert!(
            e.ws()
                .import_remote(&id, Some(("book", b.as_str())), bytes, &Actor::Sync)
                .unwrap()
        );
        let events = book_events(&seen);
        assert!(
            events.iter().all(|ev| ev.origin == dr_store::Origin::Sync),
            "{events:?}"
        );
        events.iter().map(|ev| ev.touched).collect::<Vec<_>>()
    };
    let day = |d: &loro::LoroDoc, date: &str, words: i64| {
        d.get_map("writing_days")
            .insert(&format!("device-000000000000000000000002|{date}"), words)
            .unwrap();
    };

    assert_eq!(
        arrive(upload(&|d| day(d, "2026-11-12", 300))),
        [WRITING_DAYS],
        "its recorder's minute"
    );
    assert_eq!(
        arrive(upload(&|d| {
            d.get_map("entry_checkpoints")
                .insert("synthetic-remote-point", "synthetic manifest")
                .unwrap();
        })),
        [CHECKPOINTS],
        "a checkpoint it saved"
    );
    assert_eq!(
        arrive(upload(&|d| {
            entry_meta(d, &c).insert("title", "Renamed there").unwrap();
        })),
        [CONTENT],
        "a title it changed"
    );
    assert_eq!(
        e.out("entry.get", json!({"book": b, "id": c}))["title"],
        "Renamed there"
    );
    // One batch of several of its commits: a title, then a writing day.
    entry_meta(&other, &c)
        .insert("title", "Renamed again")
        .unwrap();
    other.commit();
    assert_eq!(
        arrive(upload(&|d| day(d, "2026-11-12", 450))),
        [BookTouched {
            content: true,
            writing_days: true,
            checkpoints: false,
        }]
    );
    // And a batch of writing days alone stays what it is.
    day(&other, "2026-11-13", 10);
    other.commit();
    assert_eq!(
        arrive(upload(&|d| day(d, "2026-11-13", 20))),
        [WRITING_DAYS]
    );
    assert_eq!(
        e.out(
            "book.writing_days",
            json!({"book": b, "today": "2026-11-13", "days": 2})
        )["week"],
        470
    );
}
