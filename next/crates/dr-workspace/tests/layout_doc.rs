//! The canvas coordinates beside a book (`layout:<book>`, `kernel-v5.md` §8):
//! only live entries get coordinates, and an entry that is gone for good
//! leaves none behind.
mod common;
use common::*;
use dr_doc::v3::BorrowedBookV3;
use dr_model::id::{BookId, EntryId};
use dr_workspace::WsError;
use serde_json::json;

fn idea(e: &Env, b: &str, parent: &str, title: &str) -> String {
    e.out(
        "entry.create",
        json!({"book": b, "parent": parent, "template": "tpl-idea", "title": title}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// DX 13: `layout.put` refuses an entry that is trashed or not in the book,
/// and writes nothing for it.
#[test]
fn coordinates_are_only_for_live_entries() {
    let e = env();
    let b = e.book();
    let ideas = acceptance::novel_root(e.ws(), &b, "tpl-ideas");
    let live = idea(&e, &b, &ideas, "活着");
    let gone = idea(&e, &b, &ideas, "删了");
    e.call("entry.trash", json!({"book": b, "id": gone}));
    for bad in [gone.clone(), EntryId::new_v7().to_string()] {
        match e.try_call(
            "layout.put",
            json!({"book": b, "scope": ideas, "mode": "board", "positions": {&live: [1.0, 2.0], &bad: [3.0, 4.0]}}),
        ) {
            Err(WsError::NotFound { .. }) => {}
            other => panic!("expected a refusal for {bad}, got {other:?}"),
        }
    }
    assert_eq!(
        e.out(
            "layout.get",
            json!({"book": b, "scope": ideas, "mode": "board"})
        ),
        json!({}),
        "a refused write writes nothing"
    );
    e.call(
        "layout.put",
        json!({"book": b, "scope": ideas, "mode": "board", "positions": {&live: [1.0, 2.0]}}),
    );
}

/// DX 13: an entry deleted from the book for good (another device's purge
/// arriving by sync would do it; no command does yet) has its coordinates
/// collected at the next layout write: its own in every canvas, and the
/// canvases of its own scope.
#[test]
fn a_purged_entry_leaves_no_coordinates() {
    let e = env();
    let b = e.book();
    let ideas = acceptance::novel_root(e.ws(), &b, "tpl-ideas");
    let keep = idea(&e, &b, &ideas, "留下");
    let group = e.out(
        "entry.create",
        json!({"book": b, "parent": ideas, "template": "tpl-idea-group", "title": "一组"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let inside = idea(&e, &b, &group, "组里");
    for (scope, mode, id) in [
        (&ideas, "board", &keep),
        (&ideas, "board", &group),
        (&ideas, "grid", &group),
        (&group, "board", &inside),
    ] {
        e.call(
            "layout.put",
            json!({"book": b, "scope": scope, "mode": mode, "positions": {id: [5.0, 6.0]}}),
        );
    }
    let (book, purged): (BookId, EntryId) = (b.parse().unwrap(), group.parse().unwrap());
    e.ws()
        .library()
        .open_doc(&format!("book:{b}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Sync, move |d| {
            BorrowedBookV3::new(d, &book)
                .unwrap()
                .txn()
                .entries()
                .purge_subtree(&purged)
                .unwrap();
        })
        .unwrap();
    e.call(
        "layout.put",
        json!({"book": b, "scope": ideas, "mode": "board", "positions": {&keep: [7.0, 8.0]}}),
    );
    let all = e.ws().layout_positions(&b).unwrap();
    for (scope, positions) in &all {
        assert!(!scope.starts_with(&format!("{group}/")), "{all:?}");
        for id in [&group, &inside] {
            assert!(!positions.contains_key(id.as_str()), "{all:?}");
        }
    }
    assert_eq!(all[&format!("{ideas}/board")][&keep], (7.0, 8.0));
}

/// DX 13: dr-store knows the layout document's kind like the other two
/// documents beside a book.
#[test]
fn the_store_knows_the_kind_of_every_document_beside_a_book() {
    let e = env();
    let b = e.book();
    let docs = e.ws().library().docs(Some(&b), None).unwrap();
    for prefix in ["book:", "stats:", "checkpoints:", "layout:"] {
        let d = docs
            .iter()
            .find(|d| d.doc_id.starts_with(prefix))
            .unwrap_or_else(|| panic!("no {prefix} document"));
        assert!(
            dr_store::index::is_known_doc_kind(&d.kind),
            "{} is stored as {:?}",
            d.doc_id,
            d.kind
        );
    }
}
