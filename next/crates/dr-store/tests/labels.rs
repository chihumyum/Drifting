//! History points written at a given version and time (the 0.1 import's
//! replayed versions), with or without the usual retention.

mod common;

use common::*;
use dr_store::history::{DAY_MS, LabelRetention, NewLabel};
use dr_store::{OpenDoc, Origin, StoreError};

#[test]
fn label_at_writes_a_dated_point_with_the_books_version() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let book = lib
        .open_doc(
            "book:book-1",
            OpenDoc::CreateIfMissing {
                kind: "book",
                book_id: Some("book-1"),
                genesis: &|_| {},
            },
        )
        .unwrap();
    book.write(Origin::Import, |doc| {
        doc.get_map("meta").insert("name", "书").unwrap();
    })
    .unwrap();
    let book_version = book.doc().oplog_frontiers();
    let h = create(&lib, "node:a"); // in book-1
    insert(&h, Origin::Import, 0, "旧版本");
    let old_version = h.doc().oplog_frontiers();
    insert(&h, Origin::Import, 0, "新");
    h.close();

    let an_hour_ago = dr_store::now_ms() - 3_600_000;
    assert!(
        lib.label_at(
            "node:a",
            &old_version,
            "import",
            an_hour_ago,
            LabelRetention::Thinned
        )
        .unwrap()
    );
    let label = lib
        .history("node:a")
        .unwrap()
        .into_iter()
        .find(|l| l.label == "import")
        .unwrap();
    assert_eq!(label.ts, an_hour_ago);
    assert_eq!(label.frontiers, old_version);
    assert_eq!(label.book_frontiers, Some(book_version));
    assert!(!label.keep);
    assert_eq!(
        text(&lib.load_copy_at("node:a", &label.frontiers).unwrap()),
        "旧版本\n"
    );
    assert!(matches!(
        lib.label_at(
            "node:missing",
            &old_version,
            "import",
            an_hour_ago,
            LabelRetention::Thinned
        ),
        Err(StoreError::NotFound(_))
    ));
    assert!(
        lib.label_at(
            "node:a",
            &old_version,
            "",
            an_hour_ago,
            LabelRetention::Thinned
        )
        .is_err()
    );
}

#[test]
fn old_points_are_pruned_unless_kept() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let h = create(&lib, "node:a");
    let mut versions = Vec::new();
    for i in 0..3 {
        insert(&h, Origin::Import, 0, &i.to_string());
        versions.push(h.doc().oplog_frontiers());
    }
    h.close();
    let now = dr_store::now_ms();
    let points = [
        // 40 days old: past retention.
        (now - 40 * DAY_MS, LabelRetention::Thinned),
        (now - 40 * DAY_MS + 1, LabelRetention::Kept),
        // Two in the same hour, two days ago: thinning keeps the newer.
        (now - 2 * DAY_MS, LabelRetention::Thinned),
    ];
    let labels: Vec<NewLabel<'_>> = points
        .iter()
        .zip(&versions)
        .map(|((ts, retention), f)| NewLabel {
            doc_id: "node:a",
            frontiers: f,
            label: "import",
            ts_ms: *ts,
            retention: *retention,
        })
        .collect();
    assert_eq!(
        lib.label_many(&labels).unwrap(),
        2,
        "the 40-day-old thinned one is gone"
    );
    let stored: Vec<(i64, bool)> = lib
        .history("node:a")
        .unwrap()
        .into_iter()
        .filter(|l| l.label == "import")
        .map(|l| (now - l.ts, l.keep))
        .collect();
    assert!(stored.contains(&(2 * DAY_MS, false)));
    assert!(stored.contains(&(40 * DAY_MS - 1, true)));
    // A kept point survives later pruning too.
    lib.prune_history(dr_store::now_ms()).unwrap();
    assert!(lib.history("node:a").unwrap().iter().any(|l| l.keep));
}

/// The import's way to store a document (genesis, one `import` commit, a
/// dated `import` point) leaves no `close` point beside it: closing labels
/// only an opening that wrote something worth a label, and never the
/// version the latest label already has.
#[test]
fn closing_labels_only_openings_that_wrote_something_worth_a_label() {
    use dr_store::history::labels;
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let names = |lib: &dr_store::Library| -> Vec<String> {
        lib.history("node:a")
            .unwrap()
            .into_iter()
            .map(|l| l.label)
            .collect()
    };

    let h = create(&lib, "node:a");
    let other = h.read(|d| d.fork()).unwrap();
    other.set_peer_id(42).unwrap();
    other
        .get_text(synthetic::BODY)
        .insert(0, "旧版的正文")
        .unwrap();
    other.commit();
    let bytes = other
        .export(loro::ExportMode::updates(&h.doc().oplog_vv()))
        .unwrap();
    h.import(bytes, Origin::Import).unwrap();
    h.write(Origin::Repair, |doc| {
        doc.get_map("meta").insert("repaired", true).unwrap();
    })
    .unwrap();
    let imported = h.doc().oplog_frontiers();
    // As M10 does: the document is stored and closed before its book, and
    // only then gets its dated points.
    h.close();
    assert!(names(&lib).is_empty(), "no close point after an import");
    assert!(
        lib.label_at(
            "node:a",
            &imported,
            "import",
            dr_store::now_ms(),
            LabelRetention::Kept
        )
        .unwrap()
    );

    // Opened and closed without writing: nothing.
    lib.open_doc("node:a", OpenDoc::Existing).unwrap().close();
    assert_eq!(names(&lib), ["import"]);

    // The author writes: closing labels the new version.
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&h, Origin::User, 0, "新");
    h.close();
    assert_eq!(names(&lib), [labels::CLOSE, "import"]);

    // A point written beside the open holder on its current version is not
    // repeated by the close.
    let h = lib.open_doc("node:a", OpenDoc::Existing).unwrap();
    insert(&h, Origin::User, 0, "再");
    let current = h.doc().oplog_frontiers();
    assert!(
        lib.label_at(
            "node:a",
            &current,
            "restore-point",
            dr_store::now_ms(),
            LabelRetention::Thinned
        )
        .unwrap()
    );
    h.close();
    assert_eq!(names(&lib), ["restore-point", labels::CLOSE, "import"]);
}
