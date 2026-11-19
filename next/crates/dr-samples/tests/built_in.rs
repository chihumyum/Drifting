//! The built-in samples over a real workspace (a temporary library): a new
//! library gets both once, in shelf order and with their words; a deleted
//! sample never comes back; a library that has a book is skipped; a failed
//! attempt leaves nothing and is retried; an interrupted one is cleaned up;
//! attempts run out.

mod common;
use std::path::Path;

use dr_samples::{
    ATTEMPTS_EXHAUSTED, MARKER_KEY, MARKER_SCOPE, MAX_ATTEMPTS, NOT_A_NEW_LIBRARY, OWNER_SCOPE,
    Outcome, RECIPE, UNKNOWN_MARKER, book_ids, ensure_built_in,
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
    ws.library().rebuild_stale_indexes().unwrap();
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
    let mine = out(&ws, "project.create", json!({ "name": "我的书" }))["id"]
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
    let mine = out(&ws, "project.create", json!({ "name": "废稿" }))["id"]
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
    let written = dr_samples::v3::write_book(
        ws.library(),
        &dr_samples::v3::convert(&a_q, &dr_samples::v3::MappingChoices::default()).unwrap(),
    )
    .unwrap();
    assert_eq!(ensure_built_in(&ws), skipped);
    assert_eq!(stored(&ws, &book_ids()[1]), written);
    assert_eq!(stored(&ws, &book_ids()[0]), 0);

    // So does one deleted for good before the samples were ever checked.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let mine = out(&ws, "project.create", json!({ "name": "旧书" }))["id"]
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
    let doc = dr_samples::v3::prose_id(pp.book_id(), pp.prose[10].doc_id()).to_string();
    lib.open_doc(
        &doc,
        OpenDoc::CreateIfMissing {
            kind: dr_model::DocId::parse(&doc).unwrap().kind().prefix(),
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
    dr_samples::v3::write_book(
        ws.library(),
        &dr_samples::v3::a_q(&dr_samples::v3::MappingChoices::default()).unwrap(),
    )
    .unwrap();
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

#[test]
fn created_markers_never_resurrect_books_and_act_drift_imports_into_act_track_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    set_marker(
        &ws,
        json!({"status":"created","recipe":RECIPE,"books":book_ids(),"attempts":1}),
    );
    assert_eq!(dr_samples::ensure_built_in(&ws), Outcome::AlreadyDone);
    assert!(ws.library().docs(None, None).unwrap().is_empty());
    ws.shutdown().unwrap();

    // Author settled 11-11 (#22): acts import into a top-level act track ("幕")
    // by default without needing MappingChoices or creating an outline relation.
    let mut source = dr_samples::a_q().unwrap();
    let drift_node = source
        .book
        .view()
        .nodes()
        .into_iter()
        .find(|n| n.kind == dr_model::import_v1::NodeKind::Drift)
        .unwrap()
        .id;
    let act_id = dr_model::import_v1::ActId::parse("sample-act-with-drift").unwrap();
    source
        .book
        .edit(dr_model::Origin::Import, |t| {
            let act = t.act(&act_id)?;
            act.name("第一幕")?
                .start_order(Some(0.0))?
                .drift(Some(&drift_node))?;
            Ok(())
        })
        .0
        .unwrap();
    let pending = dr_samples::v3::MappingChoices::default().pending(&source.book.view());
    assert!(pending.is_empty(), "{pending:?}");
    let converted =
        dr_samples::v3::convert(&source, &dr_samples::v3::MappingChoices::default()).unwrap();
    let view = converted.book.view();
    dr_samples::v3::validate(&view).unwrap();
    let act_track = view
        .root_entry_by_template(
            &dr_model::id::EntryTemplateId::parse(dr_doc::v3::novel::TPL_ACT_TRACK).unwrap(),
        )
        .expect("top-level act track level");
    assert_eq!(act_track.title, "幕");
    assert_eq!(act_track.parent, None);
    let timeline = &view.timeline_views_raw()[0];
    assert_eq!(timeline.lanes[0].entry, act_track.id);
    assert_eq!(timeline.lanes[0].act_track, Some(true));
    assert!(
        view.memberships_raw()
            .iter()
            .any(|m| { m.host == act_track.id && m.member.as_str() == drift_node.as_str() })
    );
}

#[test]
fn same_id_user_book_is_never_deleted_after_failed_attempt_or_unflushed_creating_cleanup() {
    let books = book_ids();
    let aq_id = &books[1];

    // 1. After a `failed` marker, importing/syncing a book that shares a sample
    //    ID (whether modified or unmodified) skips sample seeding and preserves
    //    the book untouched.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    set_marker(
        &ws,
        json!({
            "status": "failed",
            "recipe": RECIPE,
            "books": books,
            "attempts": 1,
            "reason": "transient disk error",
        }),
    );
    dr_samples::v3::write_book(
        ws.library(),
        &dr_samples::v3::a_q(&dr_samples::v3::MappingChoices::default()).unwrap(),
    )
    .unwrap();
    out(
        &ws,
        "book.update",
        json!({ "book": aq_id, "name": "我的阿Q续写" }),
    );
    assert_eq!(
        ensure_built_in(&ws),
        Outcome::Skipped {
            reason: NOT_A_NEW_LIBRARY.into(),
        }
    );
    let on_shelf = shelf(&ws);
    assert_eq!(on_shelf.len(), 1);
    assert_eq!(on_shelf[0].0, *aq_id);
    assert_eq!(on_shelf[0].1, "我的阿Q续写");
    assert_eq!(stored(&ws, &books[0]), 0);

    // 2. Cleanup succeeded (`discard` removed the partial sample and revoked
    //    `OWNER_SCOPE`), then releasing the global `creating` marker failed:
    //    even an unmodified or edited user book later imported under the same
    //    sample ID must never be deleted or overwritten on the next launch.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let token = "attempt-token-interrupted-1";
    set_marker(
        &ws,
        json!({
            "status": "creating",
            "recipe": RECIPE,
            "books": books,
            "token": token,
            "attempts": 1,
        }),
    );
    ws.library()
        .local_set(OWNER_SCOPE, aq_id, token, Some(aq_id))
        .unwrap();
    dr_samples::v3::write_book(
        ws.library(),
        &dr_samples::v3::a_q(&dr_samples::v3::MappingChoices::default()).unwrap(),
    )
    .unwrap();

    // Fault-inject global marker update so cleanup commits while releasing the
    // `creating` marker fails.
    ws.library()
        .local_write(|tx| {
            tx.execute_batch(
                "CREATE TRIGGER fail_samples_marker_update
                 BEFORE INSERT ON local_state
                 WHEN NEW.scope = 'samples' AND NEW.key = 'built-in'
                 BEGIN
                     SELECT RAISE(ABORT, 'simulated disk full on marker release');
                 END;
                 CREATE TRIGGER fail_samples_marker_update_2
                 BEFORE UPDATE ON local_state
                 WHEN NEW.scope = 'samples' AND NEW.key = 'built-in'
                 BEGIN
                     SELECT RAISE(ABORT, 'simulated disk full on marker release');
                 END;",
            )
            .map_err(dr_store::StoreError::from)
        })
        .unwrap();

    let res = ensure_built_in(&ws);
    assert!(
        matches!(res, Outcome::Failed { attempts: 1, .. }),
        "marker release fault returns Failed: {res:?}"
    );
    // Partial sample was cleaned up and its ownership token was revoked, while
    // the global marker remained stuck at `creating`.
    assert_eq!(stored(&ws, aq_id), 0);
    assert_eq!(ws.library().local_get(OWNER_SCOPE, aq_id).unwrap(), None);
    assert_eq!(marker(&ws)["status"], "creating");

    // Clear the disk fault; the author now imports a book with the same sample
    // ID (even completely unmodified!) before the next sample check.
    ws.library()
        .local_write(|tx| {
            tx.execute_batch(
                "DROP TRIGGER fail_samples_marker_update;
                 DROP TRIGGER fail_samples_marker_update_2;",
            )
            .map_err(dr_store::StoreError::from)
        })
        .unwrap();
    let expected_docs = dr_samples::v3::write_book(
        ws.library(),
        &dr_samples::v3::a_q(&dr_samples::v3::MappingChoices::default()).unwrap(),
    )
    .unwrap();

    assert_eq!(
        ensure_built_in(&ws),
        Outcome::Skipped {
            reason: NOT_A_NEW_LIBRARY.into(),
        }
    );
    assert_eq!(stored(&ws, aq_id), expected_docs);
    assert_eq!(stored(&ws, &books[0]), 0);
    assert_eq!(shelf(&ws).len(), 1);
    assert_eq!(shelf(&ws)[0].0, *aq_id);

    // 3. Even under a legacy `creating` marker without `token`, an author-edited
    //    book sharing a sample ID is preserved and never discarded.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    set_marker(
        &ws,
        json!({ "status": "creating", "recipe": RECIPE, "books": books, "attempts": 1 }),
    );
    dr_samples::v3::write_book(
        ws.library(),
        &dr_samples::v3::a_q(&dr_samples::v3::MappingChoices::default()).unwrap(),
    )
    .unwrap();
    out(
        &ws,
        "book.update",
        json!({ "book": aq_id, "name": "作者改过的阿Q" }),
    );
    assert_eq!(
        ensure_built_in(&ws),
        Outcome::Skipped {
            reason: NOT_A_NEW_LIBRARY.into(),
        }
    );
    assert_eq!(shelf(&ws)[0].1, "作者改过的阿Q");

    // 4. Unknown recipe or non-sample book ID in marker is refused as
    //    `UNKNOWN_MARKER` without touching any stored book.
    let dir = tempfile::tempdir().unwrap();
    let ws = open(dir.path());
    let user_book = out(&ws, "project.create", json!({ "name": "独立作品" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    set_marker(
        &ws,
        json!({
            "status": "creating",
            "recipe": RECIPE,
            "books": [user_book],
            "attempts": 1,
        }),
    );
    assert_eq!(
        ensure_built_in(&ws),
        Outcome::Skipped {
            reason: UNKNOWN_MARKER.into(),
        }
    );
    assert_eq!(shelf(&ws).len(), 1);
    assert_eq!(shelf(&ws)[0].0, user_book);
}
