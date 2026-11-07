//! Device-local state (`local_state`) and purge records (`purged_doc`):
//! values per (scope, key) announced after commit, the borrowed
//! `library_meta` key moved by the migration, and purged documents and
//! books that sync and imports cannot bring back.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use dr_store::{
    LocalChange, LocalChangeKind, MIGRATIONS, OpenDoc, Origin, StoreError, StoreEvent, local_state,
    purge,
};

fn local_changes(
    lib: &dr_store::Library,
) -> (Arc<Mutex<Vec<LocalChange>>>, dr_store::LibrarySubscription) {
    let seen: Arc<Mutex<Vec<LocalChange>>> = Arc::default();
    let sub = {
        let seen = seen.clone();
        lib.subscribe(move |e| {
            if let StoreEvent::Local(c) = e
                && (c.table == local_state::TABLE || c.table == purge::TABLE)
            {
                seen.lock().unwrap().push(c.clone());
            }
        })
    };
    (seen, sub)
}

fn change(table: &str, key: &str, kind: LocalChangeKind) -> LocalChange {
    LocalChange::new(table, key, kind)
}

fn create_in(lib: &dr_store::Library, doc_id: &str, book: &str) -> dr_store::Result<()> {
    lib.open_doc(
        doc_id,
        OpenDoc::CreateIfMissing {
            kind: "node",
            book_id: Some(book),
            genesis: &genesis,
        },
    )
    .map(|h| h.close())
}

#[test]
fn local_values_are_kept_per_scope_and_announced_once_committed() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let (seen, _sub) = local_changes(&lib);
    lib.local_set("ws", "recent", r#"[{"a":1}]"#, None).unwrap();
    lib.local_set("ws", "width:b1", "320", Some("b1")).unwrap();
    lib.local_set("shell", "recent", "other module", None)
        .unwrap();
    // The same value again changes nothing and says nothing.
    lib.local_set("ws", "width:b1", "320", Some("b1")).unwrap();
    lib.local_set("ws", "width:b1", "360", Some("b1")).unwrap();
    assert_eq!(
        lib.local_get("ws", "recent").unwrap().as_deref(),
        Some(r#"[{"a":1}]"#)
    );
    assert_eq!(
        lib.local_get("shell", "recent").unwrap().as_deref(),
        Some("other module")
    );
    assert_eq!(lib.local_get("ws", "missing").unwrap(), None);
    let keys: Vec<(String, Option<String>)> = lib
        .local_entries("ws", None)
        .unwrap()
        .into_iter()
        .map(|e| (e.key, e.book_id))
        .collect();
    assert_eq!(
        keys,
        [
            ("recent".to_string(), None),
            ("width:b1".to_string(), Some("b1".to_string()))
        ]
    );
    assert_eq!(lib.local_entries("ws", Some("b1")).unwrap().len(), 1);
    // A failed transaction stores and announces nothing.
    let failed = lib.local_write(|tx| -> dr_store::Result<()> {
        tx.set_state("ws", "lost", "x", None)?;
        Err(StoreError::NotFound("abort".into()))
    });
    assert!(failed.is_err());
    assert_eq!(lib.local_get("ws", "lost").unwrap(), None);
    assert!(lib.local_remove("ws", "recent").unwrap());
    assert!(!lib.local_remove("ws", "recent").unwrap());
    assert!(lib.local_set("", "k", "v", None).is_err());
    assert!(lib.local_set("a/b", "k", "v", None).is_err());
    assert!(
        lib.local_set(
            "ws",
            "big",
            &"x".repeat(local_state::MAX_VALUE_BYTES + 1),
            None
        )
        .is_err()
    );
    let t = local_state::TABLE;
    assert_eq!(
        *seen.lock().unwrap(),
        [
            change(t, "ws/recent", LocalChangeKind::Insert),
            change(t, "ws/width:b1", LocalChangeKind::Insert),
            change(t, "shell/recent", LocalChangeKind::Insert),
            change(t, "ws/width:b1", LocalChangeKind::Update),
            change(t, "ws/recent", LocalChangeKind::Delete),
        ]
    );
    lib.close().unwrap();
    let lib = open(dir.path());
    assert_eq!(
        lib.local_get("ws", "width:b1").unwrap().as_deref(),
        Some("360")
    );
    lib.close().unwrap();
}

/// dr-workspace kept「最近打开」under `library_meta` ('ws.recent') before
/// the table existed; migration 0004 moves the value as it is.
#[test]
fn the_migration_moves_the_recent_pages_out_of_the_library_settings() {
    let dir = tempfile::tempdir().unwrap();
    let before = MIGRATIONS
        .iter()
        .position(|m| m.name == "0004_local_state")
        .unwrap();
    let value = r#"[{"book":"b1","target":{"kind":"node","id":"n1"},"used_ms":5}]"#;
    {
        let lib =
            dr_store::Library::open_with_migrations(dir.path(), options(), &MIGRATIONS[..before])
                .unwrap();
        lib.local_transaction(|tx| {
            tx.execute(
                "INSERT INTO library_meta (key, value) VALUES ('ws.recent', ?1)",
                [value],
            )?;
            Ok(())
        })
        .unwrap();
        lib.close().unwrap();
    }
    let lib = open(dir.path());
    assert_eq!(
        lib.local_get("ws", "recent").unwrap().as_deref(),
        Some(value)
    );
    let left: i64 = lib
        .local_read(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM library_meta WHERE key = 'ws.recent'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(left, 0);
    lib.close().unwrap();
}

#[test]
fn purged_documents_and_books_are_not_created_again() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    for d in ["node:a", "node:b"] {
        create_in(&lib, d, "b1").unwrap();
    }
    create_in(&lib, "node:x", "b2").unwrap();
    lib.local_set("ws", "recent:b1", "[]", Some("b1")).unwrap();
    lib.local_set("ws", "recent:b2", "[]", Some("b2")).unwrap();
    lib.local_set("ws", "all", "[]", None).unwrap();
    let (seen, _sub) = local_changes(&lib);

    lib.purge_doc("node:a").unwrap();
    let rec = lib.purged("node:a").unwrap().unwrap();
    assert_eq!(
        (rec.kind.as_str(), rec.book_id.as_deref()),
        ("node", Some("b1"))
    );
    // Created or registered again: refused, nothing stored. Opening it is
    // "not stored", as for any document that is not there.
    assert!(matches!(
        lib.open_doc("node:a", OpenDoc::Existing),
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        create_in(&lib, "node:a", "b1"),
        Err(StoreError::Purged(_))
    ));
    assert!(matches!(
        lib.register("node:a", "node", Some("b1")),
        Err(StoreError::Purged(_))
    ));
    assert_eq!(lib.doc_info("node:a").unwrap(), None);
    assert!(lib.updates_since("node:a", 0).unwrap().is_empty());
    // The book still has a document: new ones may still arrive.
    assert!(!lib.book_purged("b1").unwrap());
    create_in(&lib, "node:c", "b1").unwrap();
    for d in ["node:b", "node:c"] {
        lib.purge_doc(d).unwrap();
    }
    // Its last document gone, the book is purged: nothing of it comes back,
    // and its device-local state went with it.
    assert!(lib.book_purged("b1").unwrap());
    assert!(!lib.book_purged("b2").unwrap());
    assert!(matches!(
        create_in(&lib, "node:new", "b1"),
        Err(StoreError::Purged(_))
    ));
    assert_eq!(lib.local_get("ws", "recent:b1").unwrap(), None);
    assert!(lib.local_get("ws", "recent:b2").unwrap().is_some());
    assert!(lib.local_get("ws", "all").unwrap().is_some());
    // Another book, and documents without a book, are unaffected.
    create_in(&lib, "node:y", "b2").unwrap();
    lib.open_doc(
        "loose:1",
        OpenDoc::CreateIfMissing {
            kind: "loose",
            book_id: None,
            genesis: &genesis,
        },
    )
    .unwrap()
    .close();
    // Purging what is not stored records nothing.
    lib.purge_doc("node:never").unwrap();
    assert_eq!(lib.purged("node:never").unwrap(), None);
    let p = purge::TABLE;
    assert_eq!(
        *seen.lock().unwrap(),
        [
            change(p, "node:a", LocalChangeKind::Insert),
            change(p, "node:b", LocalChangeKind::Insert),
            change(p, "node:c", LocalChangeKind::Insert),
            change(local_state::TABLE, "ws/recent:b1", LocalChangeKind::Delete),
        ]
    );
    let ids: Vec<String> = lib
        .purged_docs(Some("b1"))
        .unwrap()
        .into_iter()
        .map(|p| p.doc_id)
        .collect();
    assert_eq!(ids.len(), 3);
    lib.close().unwrap();

    // Kept across restarts; forgetting the book lets it come back on
    // purpose (the same 0.1 library imported again).
    let lib = open(dir.path());
    assert!(lib.book_purged("b1").unwrap());
    assert!(matches!(
        create_in(&lib, "node:a", "b1"),
        Err(StoreError::Purged(_))
    ));
    assert_eq!(lib.forget_purged_book("b1").unwrap(), 3);
    assert!(!lib.book_purged("b1").unwrap());
    create_in(&lib, "node:a", "b1").unwrap();
    lib.purge_doc("node:x").unwrap();
    assert!(lib.forget_purged("node:x").unwrap());
    assert!(!lib.forget_purged("node:x").unwrap());
    create_in(&lib, "node:x", "b2").unwrap();
    lib.close().unwrap();
}

/// What M36's sync does with a remote update: open (creating) the document
/// and import. For a purged document the open is refused, so the remote
/// copy never lands; for one never purged it does.
#[test]
fn a_remote_copy_of_a_purged_document_stays_out() {
    let remote = {
        let dir = tempfile::tempdir().unwrap();
        let lib = open(dir.path());
        let h = create(&lib, "node:a");
        insert(&h, Origin::User, 0, "远端的字");
        let bytes = h
            .read(|d| d.export(loro::ExportMode::all_updates()).unwrap())
            .unwrap();
        h.close();
        lib.close().unwrap();
        bytes
    };
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let pull = |lib: &dr_store::Library| -> dr_store::Result<()> {
        let h = lib.open_doc(
            "node:a",
            OpenDoc::CreateIfMissing {
                kind: "node",
                book_id: Some("book-1"),
                genesis: &genesis,
            },
        )?;
        h.import(remote.clone(), Origin::Sync)?;
        h.close();
        Ok(())
    };
    pull(&lib).unwrap();
    lib.purge_doc("node:a").unwrap();
    assert!(matches!(pull(&lib), Err(StoreError::Purged(_))));
    assert_eq!(lib.doc_info("node:a").unwrap(), None);
    assert!(lib.docs(Some("book-1"), None).unwrap().is_empty());
    lib.close().unwrap();
}
