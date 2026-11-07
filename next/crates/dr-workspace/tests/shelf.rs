//! What the bookshelf, Project Home and the chapter panel read in one go
//! (`book.shelf`, `chapter.list`'s words and dates, `recent.*`), deleting a
//! book for good (`book.purge`, `book.purge_expired`), and time pins.

mod common;

use common::*;
use dr_workspace::WsError;
use dr_workspace::commands::book::{BOOK_TRASH_DAYS, purge_due};
use serde_json::{Value, json};

fn chapter(e: &Env, book: &str, title: &str, text: &str) -> String {
    e.out(
        "chapter.create",
        json!({"book": book, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .into()
}

/// Bring the derived index up to date for `docs` (dr-index runs when the
/// holder is idle; tests do not wait for it).
fn index(e: &Env, docs: &[String]) {
    for d in docs {
        e.ws().library().reindex_doc(d).unwrap();
    }
}

fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[test]
fn chapter_list_carries_words_and_dates() {
    let e = env();
    let b = e.book();
    let before = now_s();
    let a = chapter(&e, &b, "One", "one two three\nfour");
    let c = chapter(&e, &b, "Two", "");
    index(&e, &[format!("node:{a}"), format!("node:{c}")]);
    let list = e.out("chapter.list", json!({"book": b}));
    assert_eq!(field(&list, "words"), [json!(4), json!(0)]);
    for ch in list.as_array().unwrap() {
        let created = ch["created_at"].as_i64().unwrap();
        let updated = ch["updated_at"].as_i64().unwrap();
        assert!(created >= before - 1 && created <= now_s());
        assert!(updated >= created, "never before its creation: {ch}");
    }
    // A trashed chapter keeps its numbers in the trash listing.
    e.call("chapter.trash", json!({"book": b, "id": a}));
    let all = e.out("chapter.list", json!({"book": b, "trashed": true}));
    let t = all
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == a)
        .unwrap();
    assert_eq!(t["trashed"], true);
    assert_eq!(t["words"], 4);
}

#[test]
fn the_shelf_in_one_read() {
    let e = env();
    let b = e.book();
    let other = e.out("book.create", json!({"name": "Other"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let a = chapter(&e, &b, "One", "一二三");
    let idea = e.out("idea.create", json!({"book": b, "title": "Thought"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    e.call("storyline.create", json!({"book": b, "name": "Main"}));
    e.call("element.create", json!({"book": b, "name": "Anna"}));
    e.call(
        "fact.put",
        json!({"book": b, "key": "副标题", "value": "  一个副标题 "}),
    );
    index(&e, &[format!("node:{a}"), format!("node:{idea}")]);
    let shelf = e.out("book.shelf", json!({}));
    let mine = shelf
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == b)
        .unwrap();
    assert_eq!(mine["name"], "Test Book");
    assert_eq!(mine["subtitle"], "一个副标题");
    assert_eq!(mine["chapters"], 1);
    assert_eq!(mine["storylines"], 1);
    assert_eq!(mine["elements"], 1);
    // Only chapters count (the idea's text does not).
    assert_eq!(mine["words"], 3);
    assert!(mine["created_at"].as_i64().is_some());
    assert!(mine["updated_at"].as_i64().unwrap() >= mine["created_at"].as_i64().unwrap());
    assert_eq!(mine["deleted_at"], Value::Null);
    assert_eq!(mine["days_left"], Value::Null);

    // Trashed books come last (only when asked), with their days left.
    e.call("book.trash", json!({"book": other}));
    assert_eq!(
        ids(&e.out("book.shelf", json!({}))),
        std::slice::from_ref(&b)
    );
    let shelf = e.out("book.shelf", json!({"trashed": true}));
    assert_eq!(ids(&shelf), [b.clone(), other.clone()]);
    let gone = &shelf[1];
    assert_eq!(gone["trashed"], true);
    assert_eq!(gone["days_left"], BOOK_TRASH_DAYS);
    assert_eq!(
        gone["purge_at"].as_i64().unwrap() - gone["deleted_at"].as_i64().unwrap(),
        BOOK_TRASH_DAYS * 86_400
    );
}

#[test]
fn days_left_round_up_and_end_at_zero() {
    let day = 86_400;
    assert_eq!(purge_due(0, 0), (30 * day, 30));
    assert_eq!(purge_due(0, 1).1, 30, "29 days and change: 30");
    assert_eq!(purge_due(0, 29 * day).1, 1);
    assert_eq!(purge_due(0, 30 * day - 1).1, 1);
    assert_eq!(purge_due(0, 30 * day).1, 0);
    assert_eq!(purge_due(0, 40 * day).1, 0);
}

#[test]
fn purging_a_book_deletes_it_for_good() {
    let e = env();
    let b = e.book();
    let keep = e.out("book.create", json!({"name": "Keep"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let a = chapter(&e, &b, "One", "text");
    e.call(
        "recent.touch",
        json!({"book": b, "target": {"kind": "node", "id": a}}),
    );
    // Only from Recently Deleted.
    assert!(matches!(
        e.try_call("book.purge", json!({"book": b})),
        Err(WsError::Conflict(_))
    ));
    e.call("book.trash", json!({"book": b}));
    let out = e.call("book.purge", json!({"book": b}));
    assert_eq!(effects(&out), ["purged book"]);
    assert_eq!(out["undo"], Value::Null, "cannot be undone");
    assert!(out["output"]["docs"].as_u64().unwrap() >= 2, "{out}");
    let lib = e.ws().library();
    assert!(lib.docs(Some(&b), None).unwrap().is_empty());
    assert!(lib.head(&format!("book:{b}")).unwrap().is_none());
    assert!(lib.head(&format!("node:{a}")).unwrap().is_none());
    assert!(matches!(
        e.try_call("book.get", json!({"book": b})),
        Err(WsError::NotFound { .. })
    ));
    assert_eq!(
        ids(&e.out("book.shelf", json!({"trashed": true}))),
        std::slice::from_ref(&keep)
    );
    // Its journal rows are gone: undo has nothing of it left to try.
    assert!(
        e.ws()
            .journal(None, 100)
            .unwrap()
            .iter()
            .all(|j| j.book.as_deref() != Some(b.as_str()))
    );
    // A second purge finds nothing.
    assert!(matches!(
        e.try_call("book.purge", json!({"book": b})),
        Err(WsError::NotFound { .. })
    ));
    // The other book is untouched.
    assert_eq!(e.out("book.get", json!({"book": keep}))["name"], "Keep");
}

#[test]
fn only_expired_books_are_purged() {
    let e = env();
    let fresh = e.book();
    e.call("book.trash", json!({"book": fresh}));
    let out = e.out("book.purge_expired", json!({}));
    assert_eq!(out["purged"], json!([]));
    assert_eq!(ids(&e.out("book.shelf", json!({"trashed": true}))), [fresh]);
}

#[test]
fn recent_pages_per_book_newest_first() {
    let e = env();
    let b = e.book();
    let mut chapters = Vec::new();
    for i in 0..12 {
        chapters.push(chapter(&e, &b, &format!("C{i}"), ""));
    }
    let touch = |id: &str| {
        e.call(
            "recent.touch",
            json!({"book": b, "target": {"kind": "node", "id": id}}),
        )
    };
    for c in &chapters {
        touch(c);
    }
    touch(&chapters[3]);
    let list = e.out("recent.list", json!({"book": b}));
    let got: Vec<String> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["target"]["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(got.len(), 10, "the newest ten");
    assert_eq!(got[0], chapters[3], "moved to the front, not doubled");
    assert_eq!(got[1], chapters[11]);
    assert_eq!(got.iter().filter(|x| **x == chapters[3]).count(), 1);
    // Not an author's step: nothing to undo.
    assert!(
        e.ws()
            .journal(None, 100)
            .unwrap()
            .iter()
            .all(|j| j.command != "recent.touch")
    );
    // What is in the trash is left out; a limit cuts the list.
    e.call("chapter.trash", json!({"book": b, "id": chapters[3]}));
    let list = e.out("recent.list", json!({"book": b, "limit": 2}));
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(list[0]["target"]["id"], json!(chapters[11]));
    // Pages only, and live ones.
    assert!(matches!(
        e.try_call(
            "recent.touch",
            json!({"book": b, "target": {"kind": "comment", "id": "x"}})
        ),
        Err(WsError::Invalid(_))
    ));
    assert!(
        e.try_call(
            "recent.touch",
            json!({"book": b, "target": {"kind": "node", "id": chapters[3]}})
        )
        .is_err()
    );
}

#[test]
fn recent_pages_survive_a_restart() {
    let mut e = env();
    let b = e.book();
    let a = chapter(&e, &b, "One", "");
    e.call(
        "recent.touch",
        json!({"book": b, "target": {"kind": "node", "id": a}}),
    );
    e.reopen();
    let list = e.out("recent.list", json!({"book": b}));
    assert_eq!(list[0]["target"]["id"], json!(a));
}

#[test]
fn time_pins_label_bind_move_delete() {
    let e = env();
    let b = e.book();
    let idea = e.out("idea.create", json!({"book": b, "title": "The storm"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    // An unbound pin needs a label.
    assert!(matches!(
        e.try_call(
            "time_pin.create",
            json!({"book": b, "narrative_order": 3.0, "label": "  "})
        ),
        Err(WsError::Invalid(_))
    ));
    let p = e.out(
        "time_pin.create",
        json!({"book": b, "narrative_order": 3.0, "label": " 1999 "}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let bound = e.out(
        "time_pin.create",
        json!({"book": b, "narrative_order": 7.5, "idea": idea}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let list = e.out("time_pin.list", json!({"book": b}));
    assert_eq!(field(&list, "label"), [json!("1999"), json!("")]);
    assert_eq!(list[1]["idea_title"], "The storm");
    // One pin per idea.
    assert!(matches!(
        e.try_call("time_pin.update", json!({"book": b, "id": p, "idea": idea})),
        Err(WsError::Conflict(_))
    ));
    // Move and relabel, then undo.
    e.call(
        "time_pin.update",
        json!({"book": b, "id": p, "narrative_order": 1.0, "label": "1998"}),
    );
    assert_eq!(
        e.out("time_pin.list", json!({"book": b}))[0]["label"],
        "1998"
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    let list = e.out("time_pin.list", json!({"book": b}));
    assert_eq!(list[0]["narrative_order"], 3.0);
    assert_eq!(list[0]["label"], "1999");
    // Unbinding a label-less pin would leave it blank.
    assert!(matches!(
        e.try_call(
            "time_pin.update",
            json!({"book": b, "id": bound, "idea": null})
        ),
        Err(WsError::Invalid(_))
    ));
    // A trashed idea reads as unbound.
    e.call("idea.trash", json!({"book": b, "id": idea}));
    assert_eq!(
        e.out("time_pin.list", json!({"book": b}))[1]["idea"],
        Value::Null
    );
    e.call("idea.restore", json!({"book": b, "id": idea}));
    // Delete, and undo brings it back with its id and binding.
    e.call("time_pin.delete", json!({"book": b, "id": bound}));
    assert_eq!(
        e.out("time_pin.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    e.ws().undo(&dr_workspace::Actor::User).unwrap();
    let list = e.out("time_pin.list", json!({"book": b}));
    assert_eq!(ids(&list), [p, bound]);
    assert_eq!(list[1]["idea"], json!(idea));
}

#[test]
fn a_purged_book_does_not_come_back_with_sync() {
    use dr_workspace::Actor;
    use loro::ExportMode;
    let a = env();
    let z = env();
    let b = a.book();
    chapter(&a, &b, "One", "text");
    // Both devices have the book.
    let docs: Vec<_> = a.ws().library().docs(None, None).unwrap();
    let export = |e: &Env, doc: &str| {
        e.ws()
            .library()
            .load_copy(doc)
            .unwrap()
            .export(ExportMode::all_updates())
            .unwrap()
    };
    for d in &docs {
        let book = d.book_id.clone().unwrap_or_default();
        assert!(
            z.ws()
                .import_remote(
                    &d.doc_id,
                    Some((&d.kind, &book)),
                    export(&a, &d.doc_id),
                    &Actor::Sync
                )
                .unwrap()
        );
    }
    // A deletes it for good; Z's copy then arrives at A.
    a.call("book.trash", json!({"book": b}));
    a.call("book.purge", json!({"book": b}));
    assert!(a.ws().library().book_purged(&b).unwrap());
    for d in &docs {
        let book = d.book_id.clone().unwrap_or_default();
        let imported = a
            .ws()
            .import_remote(
                &d.doc_id,
                Some((&d.kind, &book)),
                export(&z, &d.doc_id),
                &Actor::Sync,
            )
            .unwrap();
        assert!(!imported, "{} stays deleted", d.doc_id);
    }
    assert!(a.ws().library().docs(Some(&b), None).unwrap().is_empty());
    assert!(ids(&a.out("book.shelf", json!({"trashed": true}))).is_empty());
    // Bringing it back on purpose forgets the records first.
    a.ws().library().forget_purged_book(&b).unwrap();
    let book_doc = format!("book:{b}");
    let d = docs.iter().find(|d| d.doc_id == book_doc).unwrap();
    assert!(
        a.ws()
            .import_remote(
                &book_doc,
                Some((&d.kind, &b)),
                export(&z, &book_doc),
                &Actor::Sync
            )
            .unwrap()
    );
    assert_eq!(ids(&a.out("book.shelf", json!({"trashed": true}))), [b]);
}
