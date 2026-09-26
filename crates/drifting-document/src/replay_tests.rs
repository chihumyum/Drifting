//! Real Yrs regressions for sparse out-of-order updates. The JS harness also
//! checks the same ordering against Yjs and the live XML prose projection.
use super::*;
use yrs::GetString;

fn insert(doc: &Doc, root: &str, at: u32, value: &str) -> Vec<u8> {
    let text = doc.get_or_insert_text(root);
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, at, value);
    txn.encode_update_v1()
}

fn read(session: &DocumentSession, root: &str) -> String {
    session
        .doc
        .get_or_insert_text(root)
        .get_string(&session.doc.transact())
}

#[test]
fn sparse_dependency_replays_in_every_order_and_across_pending_snapshot() {
    let source = Doc::with_client_id(19001);
    let updates = [
        insert(&source, "probe-a", 0, "A"),
        insert(&source, "probe-a", 1, "B"),
        insert(&source, "probe-b", 0, "C"),
    ];
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        for reload_after in [None, Some(1), Some(2)] {
            let mut session = DocumentSession::new();
            for (step, index) in order.iter().enumerate() {
                session.apply_remote(&updates[*index], 1).unwrap();
                if reload_after == Some(step + 1) {
                    let checkpoint = session.update(None, 1).unwrap();
                    session = DocumentSession::new();
                    session.apply_remote(&checkpoint, 1).unwrap();
                }
            }
            assert!(!session.has_pending(), "{order:?}, reload {reload_after:?}");
            assert_eq!(read(&session, "probe-a"), "AB");
            assert_eq!(read(&session, "probe-b"), "C");
            assert_eq!(
                StateVector::decode_v1(&session.state_vector()).unwrap(),
                source.transact().state_vector()
            );
            assert!(!session.undo(), "Remote replay entered native undo history");
        }
    }
}

#[test]
fn separate_holes_and_duplicate_updates_remain_pending_until_dependencies_arrive() {
    let source = Doc::with_client_id(19101);
    let updates = [
        insert(&source, "a", 0, "A"),
        insert(&source, "a", 1, "a"),
        insert(&source, "b", 0, "B"),
        insert(&source, "b", 1, "b"),
        insert(&source, "c", 0, "C"),
    ];
    let mut session = DocumentSession::new();
    for index in [4, 1, 3, 3, 1] {
        session.apply_remote(&updates[index], 1).unwrap();
    }
    assert!(session.has_pending());
    assert_eq!(read(&session, "a"), "");
    assert_eq!(read(&session, "b"), "");
    session.apply_remote(&updates[2], 1).unwrap();
    // Yrs may keep a same-client pending group behind its earliest missing
    // item. Intermediate eager visibility is not the convergence contract.
    assert_eq!(read(&session, "a"), "");
    assert!(session.has_pending());
    // Duplicate/empty updates must terminate without inventing a dependency.
    session.apply_remote(&updates[2], 1).unwrap();
    session.apply_remote(&[0, 0], 1).unwrap();
    assert!(session.has_pending());
    session.apply_remote(&updates[0], 1).unwrap();
    assert_eq!(read(&session, "a"), "Aa");
    assert_eq!(read(&session, "b"), "Bb");
    assert_eq!(read(&session, "c"), "C");
    assert!(!session.has_pending());
    assert_eq!(
        StateVector::decode_v1(&session.state_vector()).unwrap(),
        source.transact().state_vector()
    );
}

#[test]
fn sparse_pending_delete_replays_and_subsequent_native_history_preserves_remote_text() {
    let source = Doc::with_client_id(19201);
    let first = insert(&source, "a", 0, "A");
    let second = insert(&source, "a", 1, "B");
    let independent = insert(&source, "b", 0, "C");
    let deletion = {
        let text = source.get_or_insert_text("a");
        let mut txn = source.transact_mut();
        text.remove_range(&mut txn, 1, 1);
        txn.encode_update_v1()
    };
    let mut session = DocumentSession::new();
    for update in [&independent, &second, &deletion, &first] {
        session.apply_remote(update, 1).unwrap();
    }
    assert!(!session.has_pending());
    assert_eq!(read(&session, "a"), "A");
    session
        .edit(Edit::AppendParagraph {
            id: "local".into(),
            text: "原生".into(),
        })
        .unwrap();
    assert!(session.undo());
    assert_eq!(read(&session, "a"), "A");
    assert!(session.redo());
    assert_eq!(read(&session, "b"), "C");
}
