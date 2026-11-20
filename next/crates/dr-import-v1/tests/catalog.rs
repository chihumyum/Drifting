//! The loss detector (`verify::check_catalog`) on the synthetic 0.1 library:
//! every row the importer carries is in the imported library or recorded as
//! dropped in the receipt, and a row that is neither is named. Then what
//! 0.1 leaves behind when the author deletes a chapter or an element: its
//! comments and storyline links stay, so they must come over.

mod common;

use common::{v3_fixture as fixture, *};
use dr_doc::peer::random_device_peer;
use dr_doc::v3::BookDocV3;
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::verify::{self, CatalogCheck};
use dr_model::id::*;
use dr_store::{Library, LibraryOptions};

fn options(old: &Old) -> Options {
    let mut options = Options::new("catalog-check-test");
    options.v3 = common::v3_choices();
    options.old_root = Some(old.root.clone());
    options.index = false;
    options
}

fn open(root: &std::path::Path) -> Library {
    let start = std::time::Instant::now();
    loop {
        let mut o = LibraryOptions::new("catalog-check-test");
        o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
        match Library::open(root, o) {
            Ok(lib) => return lib,
            // m10-import.md 待协调 12: a closed library's lock can outlive
            // `close` for a moment while other tests run.
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn import(old: &Old, root: &std::path::Path) {
    let (outcome, _) = run::import(&old.db, root, &options(old)).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("not imported")
    };
    assert!(receipt.books.iter().all(|b| b.status == "imported"));
}

fn check(old: &Old, root: &std::path::Path) -> CatalogCheck {
    let lib = open(root);
    let checked = verify::check_catalog_in(&old.db, &lib).unwrap();
    lib.close().unwrap();
    checked
}

fn book(lib: &Library) -> BookDocV3 {
    let snap = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[snap]).unwrap()
}

#[test]
fn every_row_is_imported_or_recorded_and_a_lost_one_is_named() {
    let old = fixture::build();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    import(&old, &root);

    let clean = check(&old, &root);
    assert!(clean.is_clean(), "{:#?}", clean.unexplained);
    assert_eq!(clean.books, 1);
    let tally = |t: &str| clean.tables.get(t).cloned().unwrap_or_default();
    // Every kind the importer carries is counted, from the 0.1 rows.
    for table in [
        "project",
        "book_node",
        "book_act",
        "drift_group",
        "element_category",
        "element",
        "storylines",
        "node_storyline_link",
        "material_folder",
        "library_item",
        "project_asset",
        "project_asset (file)",
        "comment",
        "comment_action",
        "element_patch",
        "entity_kv_entry",
        "entity_relation_type",
        "entity_relation_type_endpoint_kind",
        "entity_relation",
        "timeline_marker",
        "plot_grid_document",
        "plot_grid_row",
        "plot_grid_column",
        "plot_grid_cell",
        "agent_memory",
        "writing_day",
        "node_content",
        "element (body)",
        "storylines (template)",
        "element_category (template)",
        "entity_snapshot_history",
        "agent_conversation",
        "library_state",
    ] {
        let t = tally(table);
        assert!(t.source > 0, "{table}: no 0.1 rows counted");
        assert_eq!(t.source, t.carried + t.dropped, "{table}: {t:?}");
    }
    assert_eq!(tally("comment").carried, tally("comment").source);
    assert_eq!(tally("entity_snapshot_history").carried, 3);
    // Recorded drops: the built-in relation type, the relations ending on
    // a TODO and a patch (kernel-v5.md §19), the accept-suggestion action
    // (m10-import.md 「书目文档：逐表怎么落」), every end kind (kept in the
    // receipt only).
    assert_eq!(tally("entity_relation_type").dropped, 1);
    assert_eq!(tally("entity_relation").dropped, 2);
    assert_eq!(tally("comment_action").dropped, 1);
    assert_eq!(
        tally("entity_relation_type_endpoint_kind").dropped,
        tally("entity_relation_type_endpoint_kind").source
    );

    // Negative control 1: a comment lost after the import.
    let lib = open(&root);
    let h = lib
        .open_doc(&format!("book:{BOOK}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::User, |doc| {
        doc.get_map(dr_doc::schema::book_v3::COMMENTS)
            .delete(COMMENT)
            .unwrap();
    })
    .unwrap();
    h.close();
    assert!(
        book(&lib)
            .view()
            .comment(&CommentId::parse(COMMENT).unwrap())
            .is_none()
    );
    let lost = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert_eq!(
        lost.unexplained
            .iter()
            .map(|u| (u.table.as_str(), u.book.as_str(), u.id.as_str()))
            .collect::<Vec<_>>(),
        [("comment", BOOK, COMMENT)]
    );

    // Negative control 2: a drop the receipt no longer records.
    lib.local_transaction(|tx| {
        tx.execute(
            "DELETE FROM import_original WHERE collection = 'relations' AND field = 'dropped' AND id = 'rel-patch'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    let unrecorded = verify::check_catalog_in(&old.db, &lib).unwrap();
    assert!(
        unrecorded
            .unexplained
            .iter()
            .any(|u| u.table == "entity_relation" && u.id == "rel-patch"),
        "{:#?}",
        unrecorded.unexplained
    );
    assert_eq!(unrecorded.unexplained.len(), 2);
    lib.close().unwrap();
}

/// What 0.1 writes when the author deletes a chapter and an element
/// (`useBookNode.deleteNode`, `useBookElement.deleteElement` with Recently
/// Deleted): their relations go, the row is marked deleted, their comments
/// and storyline links stay. The import used to refuse the whole library
/// (`comment-target-missing-or-trashed`), and then dropped the chapter's
/// storyline links; both come over now, the links read as absent until the
/// chapter comes back, as format 5's own Recently Deleted keeps them.
#[test]
fn comments_and_storylines_of_deleted_chapters_and_elements_come_over() {
    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    for (kind, id) in [("node", CHAPTER), ("element", ELEMENT)] {
        c.execute(
            "DELETE FROM entity_relation WHERE (from_kind = ?1 AND from_id = ?2) OR (to_kind = ?1 AND to_id = ?2)",
            rusqlite::params![kind, id],
        )
        .unwrap();
    }
    c.execute(
        "UPDATE book_node SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![T2, CHAPTER],
    )
    .unwrap();
    c.execute(
        "UPDATE element SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![T2, ELEMENT],
    )
    .unwrap();
    let links: i64 = c
        .query_row(
            "SELECT count(*) FROM node_storyline_link WHERE node_id = ?1",
            [CHAPTER],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(links, 2);
    drop(c);

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    import(&old, &root);
    let checked = check(&old, &root);
    assert!(checked.is_clean(), "{:#?}", checked.unexplained);

    let lib = open(&root);
    let doc = book(&lib);
    let view = doc.view();
    let chapter = EntryId::parse(CHAPTER).unwrap();
    let element = EntryId::parse(ELEMENT).unwrap();
    let entries = view.entries_map();
    assert!(entries[&chapter].is_trashed());
    assert!(entries[&element].is_trashed());
    for id in [COMMENT, BLOCK_COMMENT] {
        let c = view.comment(&CommentId::parse(id).unwrap()).unwrap();
        assert_eq!(c.target.as_ref().map(|t| t.id.as_str()), Some(CHAPTER));
    }
    let raw: Vec<_> = view
        .memberships_raw()
        .into_iter()
        .filter(|m| m.member == chapter)
        .map(|m| m.host.to_string())
        .collect();
    assert_eq!(raw.len(), 2, "{raw:?}");
    assert!(raw.contains(&STORYLINE.to_string()));
    assert!(raw.contains(&fixture::STORYLINE_OTHER.to_string()));
    assert!(view.memberships().iter().all(|m| m.member != chapter));
    assert_eq!(
        entries[&chapter].primary.as_ref().map(|p| p.as_str()),
        Some(STORYLINE)
    );
    lib.close().unwrap();
}
