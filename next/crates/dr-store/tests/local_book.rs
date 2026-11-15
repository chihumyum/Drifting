//! Books kept on this device (`local_book`, migration 0008): marked before
//! their first document, left out of every list sync reads (documents with
//! local changes, the documents it may register, what it exports, purge
//! records, asset bytes), listed while they still have a stored document.

mod common;

use common::*;
use dr_store::OpenDoc;
use dr_store::asset::{MAX_COPY_BYTES, SourceImport};

fn create_in(lib: &dr_store::Library, doc_id: &str, book: &str) {
    let h = lib
        .open_doc(
            doc_id,
            OpenDoc::CreateIfMissing {
                kind: "node",
                book_id: Some(book),
                genesis: &genesis,
            },
        )
        .unwrap();
    insert(&h, dr_store::Origin::User, 0, "写了一点");
    h.close();
}

#[test]
fn a_kept_book_never_shows_in_what_sync_reads() {
    let dir = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.keep_local("book-copy", r#"{"template":"t-1"}"#)
        .unwrap();
    create_in(&lib, "node:shared", "book-shared");
    create_in(&lib, "node:copy-a", "book-copy");
    create_in(&lib, "node:copy-b", "book-copy");

    // Marked before its documents; refused once it has some or was marked.
    assert!(lib.keep_local("book-shared", "").is_err());
    assert!(lib.keep_local("book-copy", "").is_err());

    assert_eq!(
        lib.docs_with_local_changes().unwrap(),
        vec!["node:shared".to_owned()]
    );
    assert_eq!(
        lib.syncable_docs()
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect::<Vec<_>>(),
        vec!["node:shared".to_owned()]
    );
    assert!(lib.export_for_upload("node:copy-a").unwrap().is_none());
    assert!(lib.export_for_upload("node:shared").unwrap().is_some());
    assert!(lib.is_local_doc("node:copy-b").unwrap());
    assert!(!lib.is_local_doc("node:shared").unwrap());
    // Its documents are still the library's own.
    assert_eq!(lib.docs(Some("book-copy"), None).unwrap().len(), 2);

    // Asset bytes stay too.
    let png = files.path().join("a.png");
    std::fs::write(&png, b"synthetic image bytes").unwrap();
    for (book, asset) in [("book-copy", "asset-copy"), ("book-shared", "asset-shared")] {
        lib.import_asset(&SourceImport {
            book_id: book,
            asset_id: asset,
            source: &png,
            mime: "image/png",
            ext: "png",
            dimensions: Some((1, 1)),
            limit: MAX_COPY_BYTES,
        })
        .unwrap();
    }
    let pending: Vec<String> = lib
        .assets_pending_upload()
        .unwrap()
        .into_iter()
        .map(|a| a.asset_id)
        .collect();
    assert_eq!(pending, vec!["asset-shared".to_owned()]);

    // Listed with its note while it has documents; a new note is kept.
    let listed = lib.local_books().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].book_id, "book-copy");
    assert_eq!(listed[0].note, r#"{"template":"t-1"}"#);
    assert!(lib.set_local_note("book-copy", "later").unwrap());
    assert_eq!(lib.local_book("book-copy").unwrap().unwrap().note, "later");
    assert!(!lib.set_local_note("book-never", "x").unwrap());

    // Purged: no longer listed, and its purge records never reach sync.
    lib.purge_doc("node:copy-a").unwrap();
    lib.purge_doc("node:copy-b").unwrap();
    lib.purge_doc("node:shared").unwrap();
    assert!(lib.local_books().unwrap().is_empty());
    assert!(lib.local_book("book-copy").unwrap().is_none());
    assert_eq!(
        lib.purged_docs(None)
            .unwrap()
            .into_iter()
            .map(|p| p.doc_id)
            .collect::<Vec<_>>(),
        vec!["node:shared".to_owned()]
    );
    lib.close().unwrap();
}
