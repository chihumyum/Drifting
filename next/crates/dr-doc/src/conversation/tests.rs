use super::*;
use dr_model::conversation::ConversationEntryKind;
use serde_json::json;

fn id() -> ConversationId {
    ConversationId::parse("conversation-1").unwrap()
}

fn entry(sequence: u32) -> ConversationEntry {
    ConversationEntry {
        id: format!("session-1:{sequence}"),
        session: "session-1".into(),
        turn: 1,
        kind: ConversationEntryKind::Assistant,
        payload: json!({"sequence": sequence}),
    }
}

#[test]
fn conversation_replay_is_idempotent_and_content_is_immutable() {
    let mut doc = ConversationDoc::create(id(), 1).unwrap();
    let first = entry(1);
    let (result, committed) = doc.append(Origin::User, &first);
    assert!(result.unwrap());
    assert_eq!(committed.unwrap().doc_id, DocId::Conversation(id()));
    let before = doc.version();
    let (result, committed) = doc.append(Origin::User, &first);
    assert!(!result.unwrap());
    assert!(committed.is_none());
    assert_eq!(doc.version(), before);
    let mut changed = first.clone();
    changed.payload = json!({"sequence": 2});
    let (result, committed) = doc.append(Origin::User, &changed);
    assert!(result.is_err());
    assert!(committed.is_none());
    assert_eq!(doc.entries().unwrap(), vec![first]);

    let snapshot = doc.export_snapshot().unwrap();
    let reopened = ConversationDoc::load(id(), 2, std::slice::from_ref(&snapshot)).unwrap();
    assert_eq!(reopened.entries().unwrap(), doc.entries().unwrap());
    assert!(
        ConversationDoc::load(ConversationId::parse("other").unwrap(), 2, &[snapshot]).is_err()
    );
}

#[test]
fn conversation_concurrent_appends_converge() {
    assert_eq!(genesis(&id()), genesis(&id()));
    let mut a = ConversationDoc::create(id(), 1).unwrap();
    let mut b = ConversationDoc::create(id(), 2).unwrap();
    for d in [&mut a, &mut b] {
        assert!(d.append(Origin::User, &entry(1)).0.unwrap());
    }
    a.append(Origin::User, &entry(2)).0.unwrap();
    b.append(Origin::User, &entry(3)).0.unwrap();
    let av = a.export_snapshot().unwrap();
    let bv = b.export_snapshot().unwrap();
    a.import(&bv, Origin::User).unwrap();
    b.import(&av, Origin::User).unwrap();
    let entries = a.entries().unwrap();
    assert_eq!(entries, b.entries().unwrap());
    assert_eq!(entries.len(), 3, "concurrent replays are shown only once");
    assert_eq!(entries[0], entry(1));
    assert!(entries.contains(&entry(2)) && entries.contains(&entry(3)));
    a.import(&bv, Origin::User).unwrap();
    assert_eq!(a.entries().unwrap(), entries);
}

#[test]
fn conversation_borrowed_append_is_committed_by_holder() {
    let raw = configured();
    assert!(BorrowedConversation::new(&raw, &id()).is_err());
    raw.import(&genesis(&id())).unwrap();
    raw.set_peer_id(1).unwrap();
    let borrowed = BorrowedConversation::new(&raw, &id()).unwrap();
    let before = raw.len_ops();
    assert!(borrowed.append(&entry(1)).unwrap());
    raw.commit_with(CommitOptions::new().origin("user"));
    assert!(raw.len_ops() > before);
    assert_eq!(borrowed.entries().unwrap(), vec![entry(1)]);
    assert!(BorrowedConversation::new(&raw, &ConversationId::parse("other").unwrap()).is_err());
}

#[test]
fn conversation_is_not_a_prose_document() {
    let doc_id = DocId::Conversation(id());
    assert_eq!(doc_id.profile(), None);
    assert!(!doc_id.kind().is_book_text());
    assert!(crate::prose::ProseDoc::create(doc_id, 1).is_err());
}

#[test]
fn conversation_import_rejects_deletion_and_conflicting_replay() {
    let mut a = ConversationDoc::create(id(), 1).unwrap();
    a.append(Origin::User, &entry(1)).0.unwrap();
    let before = a.export_snapshot().unwrap();
    let invalid = configured();
    invalid.import(&before).unwrap();
    invalid.set_peer_id(2).unwrap();
    invalid
        .get_list(schema::conversation::ENTRIES)
        .delete(0, 1)
        .unwrap();
    invalid.commit();
    assert!(
        a.import(&invalid.export(ExportMode::Snapshot).unwrap(), Origin::User)
            .is_err()
    );
    assert_eq!(a.entries().unwrap(), vec![entry(1)]);

    let mut b = ConversationDoc::create(id(), 3).unwrap();
    let mut conflict = entry(1);
    conflict.payload = json!({"sequence": 99});
    b.append(Origin::User, &conflict).0.unwrap();
    assert!(
        a.import(&b.export_snapshot().unwrap(), Origin::User)
            .is_err()
    );
    assert_eq!(a.entries().unwrap(), vec![entry(1)]);
}

#[test]
fn conversation_unknown_content_is_preserved_and_invalid_ids_rejected() {
    let mut doc = ConversationDoc::create(id(), 1).unwrap();
    let mut unknown = entry(1);
    unknown.kind = ConversationEntryKind::parse("future_block");
    unknown.payload = json!({"signed": {"opaque": [1, 2, 3]}, "future": true});
    doc.append(Origin::User, &unknown).0.unwrap();
    let restored = ConversationDoc::load(id(), 2, &[doc.export_snapshot().unwrap()]).unwrap();
    assert_eq!(restored.entries().unwrap(), vec![unknown]);
    let mut bad = entry(2);
    bad.id.clear();
    assert!(doc.append(Origin::User, &bad).0.is_err());
    assert_eq!(doc.entries().unwrap().len(), 1);
}

#[test]
fn conversation_import_rejects_reordered_existing_entries() {
    let mut doc = ConversationDoc::create(id(), 1).unwrap();
    doc.append(Origin::User, &entry(1)).0.unwrap();
    doc.append(Origin::User, &entry(2)).0.unwrap();
    let remote = configured();
    remote.import(&doc.export_snapshot().unwrap()).unwrap();
    remote.set_peer_id(2).unwrap();
    let list = remote.get_list(schema::conversation::ENTRIES);
    list.delete(0, 1).unwrap();
    list.push(serde_json::to_string(&entry(1)).unwrap())
        .unwrap();
    remote.commit();
    assert!(
        doc.import(&remote.export(ExportMode::Snapshot).unwrap(), Origin::Sync)
            .is_err()
    );
    assert_eq!(doc.entries().unwrap(), vec![entry(1), entry(2)]);
}
