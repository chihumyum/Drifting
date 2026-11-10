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
        "entry.create", json!({"book": book, "parent": common::acceptance::novel_root(e.ws(), &book, "tpl-manuscript"), "template": "tpl-chapter", "title": title, "bodies": {"mod-prose": text}}),
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

#[test]
fn the_shelf_in_one_read() {
    let e = env();
    let b = e.book();
    let other = e.out("project.create", json!({"name": "Other"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let a = chapter(&e, &b, "One", "一二三");
    let idea = common::acceptance::novel_entry(e.ws(), &b, "tpl-idea", "Thought", None)["id"]
        .as_str()
        .unwrap()
        .to_string();
    common::acceptance::novel_entry(e.ws(), &b, "tpl-storyline", "Main", None);
    common::acceptance::novel_entry(e.ws(), &b, "tpl-character", "Anna", None);
    let id = b.parse().unwrap();
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Import, move |doc| {
        dr_doc::v3::BorrowedBookV3::new(doc, &id)
            .unwrap()
            .txn()
            .put_fact(&dr_model::shared::KvEntry {
                id: dr_model::id::KvEntryId::parse("subtitle").unwrap(),
                key: "副标题".into(),
                value: "  一个副标题 ".into(),
                pos: None,
            })
            .unwrap();
    })
    .unwrap();
    drop(h);
    index(
        &e,
        &[
            format!("body:{a}/mod-prose"),
            format!("body:{idea}/mod-prose"),
        ],
    );
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
    assert_eq!(mine["elements"], 2);
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
    let keep = e.out("project.create", json!({"name": "Keep"}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    let a = chapter(&e, &b, "One", "text");
    e.call(
        "recent.touch",
        json!({"book": b, "target": {"kind": "entry", "id": a}}),
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
    assert!(lib.head(&format!("body:{a}/mod-prose")).unwrap().is_none());
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
            json!({"book": b, "target": {"kind": "entry", "id": id}}),
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
    e.call("entry.trash", json!({"book": b, "id": chapters[3]}));
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
            json!({"book": b, "target": {"kind": "entry", "id": chapters[3]}})
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
        json!({"book": b, "target": {"kind": "entry", "id": a}}),
    );
    e.reopen();
    let list = e.out("recent.list", json!({"book": b}));
    assert_eq!(list[0]["target"]["id"], json!(a));
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
    let mut docs: Vec<_> = a
        .ws()
        .library()
        .docs(None, None)
        .unwrap()
        .into_iter()
        .filter(|d| a.ws().library().head(&d.doc_id).unwrap().is_some())
        .collect();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
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

#[test]
fn shelf_words_distinguish_pending_unwritten_and_ready_prose_and_refresh_after_indexing() {
    let dir = tempfile::tempdir().unwrap();
    let mut options = dr_workspace::library_options("pending-shelf");
    options.derive_idle = std::time::Duration::from_secs(3600);
    options.background_quiet = std::time::Duration::from_secs(3600);
    options.rebuild_indexes_on_open = false;
    let store = dr_store::Library::open(dir.path(), options).unwrap();
    let ws = dr_workspace::Workspace::open(store, Default::default()).unwrap();
    let call = |name: &str, input: Value| {
        ws.call(&dr_workspace::Actor::User, name, input).unwrap()["output"].clone()
    };
    let book = call("project.create", json!({"name":"Pending count"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(call("book.shelf", json!({}))[0]["words"], 0);
    let entry =
        common::acceptance::novel_entry(&ws, &book, "tpl-chapter", "Written", Some("一二三"))["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let doc = format!("body:{entry}/mod-prose");
    assert!(call("book.shelf", json!({}))[0]["words"].is_null());
    ws.library().reindex_doc(&doc).unwrap();
    assert_eq!(call("book.shelf", json!({}))[0]["words"], 3);
    let session = ws.prose_session(&doc).unwrap();
    session.edit(|t| t.insert_text(0, "四五")).unwrap();
    assert!(call("book.shelf", json!({}))[0]["words"].is_null());
    ws.library().reindex_doc(&doc).unwrap();
    assert_eq!(call("book.shelf", json!({}))[0]["words"], 5);
    drop(session);
    ws.shutdown().unwrap();
}
