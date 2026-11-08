//! The built-in samples over a real workspace (a temporary library): a new
//! library gets both once, in shelf order and with their words; a deleted
//! sample never comes back; a library that has a book is skipped; a failed
//! attempt leaves nothing and is retried; an interrupted one is cleaned up;
//! attempts run out.

use std::path::Path;

use dr_samples::{
    ATTEMPTS_EXHAUSTED, MARKER_KEY, MARKER_SCOPE, MAX_ATTEMPTS, NOT_A_NEW_LIBRARY, Outcome, RECIPE,
    book_ids, ensure_built_in,
};
use dr_store::OpenDoc;
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn open(dir: &Path) -> Workspace {
    Workspace::open_dir(dir, "test").unwrap()
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// The live books on the shelf: (id, name, chapters, words).
fn shelf(ws: &Workspace) -> Vec<(String, String, u64, u64)> {
    out(ws, "book.shelf", json!({}))
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["id"].as_str().unwrap().to_owned(),
                b["name"].as_str().unwrap().to_owned(),
                b["chapters"].as_u64().unwrap(),
                b["words"].as_u64().unwrap(),
            )
        })
        .collect()
}

fn marker(ws: &Workspace) -> Value {
    let v = ws
        .library()
        .local_get(MARKER_SCOPE, MARKER_KEY)
        .unwrap()
        .expect("a marker");
    serde_json::from_str(&v).unwrap()
}

fn set_marker(ws: &Workspace, v: Value) {
    ws.library()
        .local_set(MARKER_SCOPE, MARKER_KEY, &v.to_string(), None)
        .unwrap();
}

/// Every document stored for `book`.
fn stored(ws: &Workspace, book: &str) -> usize {
    ws.library().docs(Some(book), None).unwrap().len()
}

fn assert_both_on_the_shelf(ws: &Workspace, books: &[String]) {
    let shelf = shelf(ws);
    assert_eq!(
        shelf.iter().map(|b| &b.0).collect::<Vec<_>>(),
        books.iter().collect::<Vec<_>>(),
        "both samples, in shelf order"
    );
    assert_eq!(shelf[0].1, "Pride and Prejudice (Sample)");
    assert_eq!(shelf[0].2, 61);
    assert_eq!(shelf[1].1, "阿Q正传（示例）");
    assert_eq!(shelf[1].2, 9);
    for (_, name, _, words) in &shelf {
        assert!(*words > 0, "{name} has words on the shelf");
    }
    // Pride and Prejudice is about 122,000 words, the six chapters of 阿Q正传
    // about 13,500 characters.
    assert!(shelf[0].3 > 100_000, "{shelf:?}");
    assert!(shelf[1].3 > 10_000, "{shelf:?}");
}

#[test]
fn a_new_library_gets_both_samples_once() {
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let books = book_ids();
    assert_eq!(books.len(), 2);
    // The fixed ids: the same sample is the same book everywhere.
    assert_eq!(
        books[0],
        dr_samples::pride_and_prejudice()
            .unwrap()
            .book_id()
            .to_string()
    );
    assert_eq!(books[1], dr_samples::a_q().unwrap().book_id().to_string());

    assert_eq!(
        ensure_built_in(&ws),
        Outcome::Created {
            books: books.clone()
        }
    );
    assert_both_on_the_shelf(&ws, &books);
    let m = marker(&ws);
    assert_eq!(m["status"], "created");
    assert_eq!(m["recipe"], RECIPE);
    assert_eq!(m["attempts"], 1);
    assert_eq!(m["books"], json!(books));

    // Once: a second call, and a second launch, change nothing.
    assert_eq!(ensure_built_in(&ws), Outcome::AlreadyDone);
    ws.shutdown().unwrap();
    let ws = open(dir.path());
    assert_eq!(ensure_built_in(&ws), Outcome::AlreadyDone);
    assert_both_on_the_shelf(&ws, &books);
}

#[test]
fn a_deleted_sample_never_comes_back() {
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let Outcome::Created { books } = ensure_built_in(&ws) else {
        panic!("a new library gets the samples");
    };
    // Deleted for good, as the shelf does it: trash, then purge.
    out(&ws, "book.trash", json!({ "book": books[0] }));
    out(&ws, "book.purge", json!({ "book": books[0] }));
    assert_eq!(stored(&ws, &books[0]), 0);
    assert_eq!(ensure_built_in(&ws), Outcome::AlreadyDone);
    ws.shutdown().unwrap();

    let ws = open(dir.path());
    assert_eq!(ensure_built_in(&ws), Outcome::AlreadyDone);
    let shelf = shelf(&ws);
    assert_eq!(shelf.len(), 1);
    assert_eq!(shelf[0].0, books[1]);
    // The marker outlives the book it named.
    assert_eq!(marker(&ws)["status"], "created");
}

#[test]
fn a_library_with_a_book_is_skipped() {
    // A live book.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let mine = out(&ws, "book.create", json!({ "name": "我的书" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let skipped = Outcome::Skipped {
        reason: NOT_A_NEW_LIBRARY.into(),
    };
    assert_eq!(ensure_built_in(&ws), skipped);
    assert_eq!(shelf(&ws).len(), 1);
    assert_eq!(marker(&ws)["status"], "skipped");
    for b in book_ids() {
        assert_eq!(stored(&ws, &b), 0, "nothing of the samples was written");
    }

    // Skipped stays skipped, even once the library is empty again.
    out(&ws, "book.trash", json!({ "book": mine }));
    out(&ws, "book.purge", json!({ "book": mine }));
    assert!(shelf(&ws).is_empty());
    assert_eq!(ensure_built_in(&ws), skipped);
    assert!(shelf(&ws).is_empty());

    // A book in Recently Deleted counts too.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let mine = out(&ws, "book.create", json!({ "name": "废稿" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(&ws, "book.trash", json!({ "book": mine }));
    assert_eq!(ensure_built_in(&ws), skipped);
    assert!(shelf(&ws).is_empty());

    // So does a sample that arrived some other way (sync, an import): it is
    // left as it is, never removed and written again.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let a_q = dr_samples::a_q().unwrap();
    let written = dr_samples::write_book(ws.library(), &a_q).unwrap();
    assert_eq!(ensure_built_in(&ws), skipped);
    assert_eq!(stored(&ws, &book_ids()[1]), written);
    assert_eq!(stored(&ws, &book_ids()[0]), 0);

    // So does one deleted for good before the samples were ever checked.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let mine = out(&ws, "book.create", json!({ "name": "旧书" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(&ws, "book.trash", json!({ "book": mine }));
    out(&ws, "book.purge", json!({ "book": mine }));
    assert_eq!(ensure_built_in(&ws), skipped);
    assert!(shelf(&ws).is_empty());
}

#[test]
fn a_failed_attempt_leaves_nothing_and_is_retried() {
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let books = book_ids();
    // Make Pride and Prejudice, written after 阿Q正传, impossible to store:
    // one of its documents was deleted for good here, so the store refuses
    // every new document of that book (no book document is involved, so the
    // library still counts as new).
    let lib = ws.library();
    let pp = dr_samples::pride_and_prejudice().unwrap();
    let doc = pp.prose[10].doc_id().to_string();
    lib.open_doc(
        &doc,
        OpenDoc::CreateIfMissing {
            kind: pp.prose[10].doc_id().kind().prefix(),
            book_id: Some(&books[0]),
            genesis: &|_| {},
        },
    )
    .unwrap()
    .close();
    lib.purge_doc(&doc).unwrap();
    assert!(lib.book_purged(&books[0]).unwrap());

    let Outcome::Failed { error, attempts } = ensure_built_in(&ws) else {
        panic!("the attempt fails");
    };
    assert_eq!(attempts, 1, "{error}");
    // Both or neither: 阿Q正传, already stored, went with it.
    assert!(shelf(&ws).is_empty());
    for b in &books {
        assert_eq!(stored(&ws, b), 0, "{b} left nothing behind");
    }
    let m = marker(&ws);
    assert_eq!(m["status"], "failed");
    assert_eq!(m["attempts"], 1);
    assert!(m["reason"].as_str().is_some_and(|r| !r.is_empty()));

    // The next launch tries again, and the same ids can be written again.
    ws.shutdown().unwrap();
    let ws = open(dir.path());
    assert_eq!(
        ensure_built_in(&ws),
        Outcome::Created {
            books: books.clone()
        }
    );
    assert_both_on_the_shelf(&ws, &books);
    assert_eq!(marker(&ws)["attempts"], 2);
}

#[test]
fn an_interrupted_attempt_is_cleaned_up_and_attempts_run_out() {
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let books = book_ids();
    // A launch quit midway: its claim, and 阿Q正传 stored.
    set_marker(
        &ws,
        json!({ "status": "creating", "recipe": RECIPE, "books": books, "attempts": 1 }),
    );
    dr_samples::write_book(ws.library(), &dr_samples::a_q().unwrap()).unwrap();
    assert_eq!(
        ensure_built_in(&ws),
        Outcome::Created {
            books: books.clone()
        }
    );
    assert_both_on_the_shelf(&ws, &books);
    assert_eq!(marker(&ws)["attempts"], 2);

    // After the last attempt failed, the library gives up for good.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    set_marker(
        &ws,
        json!({
            "status": "failed", "recipe": RECIPE, "books": books,
            "attempts": MAX_ATTEMPTS, "reason": "disk full",
        }),
    );
    let exhausted = Outcome::Skipped {
        reason: ATTEMPTS_EXHAUSTED.into(),
    };
    assert_eq!(ensure_built_in(&ws), exhausted);
    assert_eq!(ensure_built_in(&ws), exhausted);
    assert!(shelf(&ws).is_empty());
}
