use super::*;

fn source() -> DocumentSession {
    let mut seed = DocumentSession::with_test_client_id(28001).unwrap();
    for (id, text) in [("p", "甲北塔乙👩🏽‍🚀"), ("q", "海岸")] {
        seed.edit(Edit::AppendParagraph {
            id: id.into(),
            text: text.into(),
        })
        .unwrap();
    }
    let mut doc = DocumentSession::with_test_client_id(28002).unwrap();
    doc.apply_remote(&seed.update(None, 1).unwrap(), 1).unwrap();
    doc
}
fn select(doc: &mut DocumentSession, id: &str, epoch: u64, at: u32, length: u32) {
    doc.set_selection(NativeSelectionRequest {
        view_id: id.into(),
        epoch,
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
    })
    .unwrap();
}
fn range(doc: &DocumentSession, id: &str) -> Option<(u32, u32)> {
    doc.native_projection()
        .unwrap()
        .selections
        .into_iter()
        .find(|s| s.view_id == id)
        .and_then(|s| s.range)
        .map(|r| (r.location, r.length))
}
fn replace(doc: &mut DocumentSession, at: u32, length: u32, text: &str) {
    doc.replace_native(NativeReplacement {
        revision: doc.revision,
        range: NativeRange {
            location: at,
            length,
        },
        text: text.into(),
    })
    .unwrap();
}

#[test]
fn relative_selections_follow_remote_edits_on_both_sides_without_collapsing() {
    let mut doc = source();
    select(&mut doc, "caret", 1, 2, 0);
    select(&mut doc, "quote", 1, 1, 2);
    let mut peer = DocumentSession::with_test_client_id(28003).unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let vector = peer.state_vector();
    peer.edit(Edit::Insert {
        block: "p".into(),
        offset: 0,
        text: "远".into(),
    })
    .unwrap();
    peer.edit(Edit::Insert {
        block: "q".into(),
        offset: 2,
        text: "潮".into(),
    })
    .unwrap();
    doc.apply_remote(&peer.update(Some(&vector), 1).unwrap(), 1)
        .unwrap();
    assert_eq!(range(&doc, "caret"), Some((3, 0)));
    assert_eq!(range(&doc, "quote"), Some((2, 2)));
    assert!(!doc.undo(), "remote input cannot enter local history");
}

#[test]
fn structural_selection_history_keeps_live_crdt_positions_and_manual_epochs() {
    let mut doc = source();
    select(&mut doc, "quote", 1, 1, 2);
    select(&mut doc, "tail", 1, 3, 0);
    replace(&mut doc, 2, 0, "\n");
    assert_eq!(range(&doc, "quote"), Some((1, 3)));
    assert_eq!(range(&doc, "tail"), Some((4, 0)));
    assert!(doc.undo());
    assert_eq!(range(&doc, "quote"), Some((1, 2)));
    assert_eq!(range(&doc, "tail"), Some((3, 0)));
    assert!(doc.redo());
    assert_eq!(range(&doc, "tail"), Some((4, 0)));
    let at = doc
        .native_projection()
        .unwrap()
        .blocks
        .last()
        .unwrap()
        .range
        .location
        + 1;
    select(&mut doc, "tail", 2, at, 0);
    assert!(doc.undo());
    assert_eq!(range(&doc, "tail"), Some((at - 1, 0)));
    assert!(doc.redo());
    assert_eq!(range(&doc, "tail"), Some((at, 0)));
}

#[test]
fn deleted_selection_collapses_and_removed_parent_is_unresolved_until_undo() {
    let mut doc = source();
    select(&mut doc, "view", 1, 1, 1);
    replace(&mut doc, 0, 3, "新");
    assert_eq!(range(&doc, "view"), Some((1, 0)));
    replace(&mut doc, 1, 0, "续");
    assert_eq!(range(&doc, "view"), Some((2, 0)));
    assert!(doc.undo());
    assert_eq!(range(&doc, "view"), Some((1, 0)));
    assert!(doc.undo());
    assert_eq!(range(&doc, "view"), Some((1, 1)));
    doc.edit(Edit::DeleteBlock { block: "p".into() }).unwrap();
    assert_eq!(range(&doc, "view"), None);
    assert!(doc.undo());
    assert_eq!(range(&doc, "view"), Some((1, 1)));
}

#[test]
fn invalid_or_stale_capture_is_atomic_and_detached_views_never_return_from_history() {
    let mut doc = source();
    select(&mut doc, "view", 5, 2, 0);
    let before = doc.update(None, 1).unwrap();
    let revision = doc.revision;
    for (epoch, expected_revision, location) in
        [(4, revision, 0), (6, revision - 1, 0), (6, revision, 5)]
    {
        assert!(doc
            .set_selection(NativeSelectionRequest {
                view_id: "view".into(),
                epoch,
                revision: expected_revision,
                range: NativeRange {
                    location,
                    length: 0
                }
            })
            .is_err());
        assert_eq!(range(&doc, "view"), Some((2, 0)));
    }
    assert_eq!(doc.update(None, 1).unwrap(), before);
    assert!(!doc.undo());
    replace(&mut doc, 0, 0, "序");
    doc.drop_selection("view");
    assert!(doc.undo());
    assert!(doc.native_projection().unwrap().selections.is_empty());
    select(&mut doc, "view", 6, 0, 0);
    assert!(doc.redo());
    assert_eq!(range(&doc, "view"), Some((1, 0)));
}

#[test]
fn selection_metadata_never_enters_checkpoint_or_creates_prose_history() {
    let mut doc = source();
    let before = doc.update(None, 1).unwrap();
    select(&mut doc, "view", 1, 1, 2);
    let bytes = doc.update(None, 1).unwrap();
    assert_eq!(bytes, before);
    let mut reopened = DocumentSession::new();
    reopened.apply_remote(&bytes, 1).unwrap();
    assert!(reopened.native_projection().unwrap().selections.is_empty());
    assert!(!doc.undo());
    assert!(!reopened.undo());
}

#[test]
fn new_manual_positions_in_copied_tail_survive_repeated_structural_history() {
    let mut doc = source();
    replace(&mut doc, 2, 0, "\n");
    for epoch in 1..=4 {
        select(&mut doc, "new", epoch, 5, 7); // all of the astronaut emoji
        assert!(doc.undo());
        assert_eq!(range(&doc, "new"), Some((4, 7)));
        assert!(doc.redo());
        assert_eq!(range(&doc, "new"), Some((5, 7)));
    }
    // A newer range set on the restored original tree must also map forward.
    assert!(doc.undo());
    select(&mut doc, "new", 5, 2, 2);
    assert!(doc.redo());
    assert_eq!(range(&doc, "new"), Some((3, 2)));
    assert!(doc.undo());
    assert_eq!(range(&doc, "new"), Some((2, 2)));
}

#[test]
fn lineage_tracks_fragmented_items_and_remote_prefix_shifts_without_text_search() {
    let mut doc = source();
    let mut peer = DocumentSession::with_test_client_id(28004).unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let sv = peer.state_vector();
    peer.edit(Edit::Insert {
        block: "p".into(),
        offset: 2,
        text: "北北".into(),
    })
    .unwrap();
    peer.edit(Edit::Format {
        block: "p".into(),
        offset: 3,
        length: 1,
        attributes: [("bold".into(), json!(true))].into_iter().collect(),
    })
    .unwrap();
    doc.apply_remote(&peer.update(Some(&sv), 1).unwrap(), 1)
        .unwrap();
    replace(&mut doc, 2, 0, "\n");
    let second = doc.native_projection().unwrap().blocks[1]
        .id
        .clone()
        .unwrap();
    peer.apply_remote(&doc.update(None, 1).unwrap(), 1).unwrap();
    let sv = peer.state_vector();
    peer.edit(Edit::Insert {
        block: "p".into(),
        offset: 0,
        text: "远".into(),
    })
    .unwrap();
    // This is deliberately inside the copied subtree. The selected ORIGINAL
    // characters must keep their correspondence even with a newer remote item.
    peer.edit(Edit::Insert {
        block: second,
        offset: 1,
        text: "潮".into(),
    })
    .unwrap();
    doc.apply_remote(&peer.update(Some(&sv), 1).unwrap(), 1)
        .unwrap();
    select(&mut doc, "new", 1, 6, 2); // original second 北 and 塔
    assert!(doc.undo());
    assert_eq!(range(&doc, "new"), Some((4, 2)));
    assert!(doc.redo());
    assert_eq!(range(&doc, "new"), Some((6, 2)));
    // Recapture after redo: item IDs have changed, original clocks still map.
    select(&mut doc, "new", 2, 6, 2);
    assert!(doc.undo());
    assert_eq!(range(&doc, "new"), Some((4, 2)));
}

#[test]
fn joined_tail_and_inserted_or_empty_blocks_have_explicit_history_positions() {
    let mut doc = source();
    let end = doc.native_projection().unwrap().blocks[0].range.length;
    replace(&mut doc, end, 1, "");
    select(&mut doc, "tail", 1, end + 1, 1);
    assert!(doc.undo());
    assert_eq!(range(&doc, "tail"), Some((end + 2, 1)));
    assert!(doc.redo());
    assert_eq!(range(&doc, "tail"), Some((end + 1, 1)));
    replace(&mut doc, 2, 0, "\n插入\n\n");
    select(&mut doc, "inside", 1, 4, 0);
    select(&mut doc, "empty", 1, 6, 0);
    assert!(doc.undo());
    assert_eq!(range(&doc, "inside"), Some((2, 0)));
    assert_eq!(range(&doc, "empty"), Some((2, 0)));
    assert!(doc.redo());
    assert_eq!(range(&doc, "inside"), Some((4, 0)));
    assert_eq!(range(&doc, "empty"), Some((6, 0)));
}

#[test]
fn newest_selection_follows_multiple_reconstructed_ancestors() {
    let mut doc = source();
    replace(&mut doc, 1, 0, "\n");
    replace(&mut doc, 3, 0, "\n");
    select(&mut doc, "latest", 1, 6, 7);
    assert!(doc.undo());
    assert_eq!(range(&doc, "latest"), Some((5, 7)));
    assert!(doc.undo());
    assert_eq!(range(&doc, "latest"), Some((4, 7)));
    assert!(doc.redo());
    assert_eq!(range(&doc, "latest"), Some((5, 7)));
    assert!(doc.redo());
    assert_eq!(range(&doc, "latest"), Some((6, 7)));
}

#[test]
fn reading_compressed_lineage_does_not_write_prose_or_add_undo_items() {
    let mut doc = source();
    let before = doc.update(None, 1).unwrap();
    let revision = doc.revision;
    let view = doc.native_projection().unwrap();
    let _ = doc.capture_lineage(&view.blocks).unwrap();
    assert_eq!(doc.update(None, 1).unwrap(), before);
    assert_eq!(doc.revision, revision);
    assert!(!doc.undo());
}
