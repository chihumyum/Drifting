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

/// A copy of `doc` to write on as another device would, with no typed API
/// in the way.
fn raw_copy(doc: &ConversationDoc, peer: u64) -> LoroDoc {
    let raw = configured();
    raw.import(&doc.export_snapshot().unwrap()).unwrap();
    raw.set_peer_id(peer).unwrap();
    raw
}

#[test]
fn conversation_import_rejects_deletion_and_reads_a_conflict_alike() {
    let mut a = ConversationDoc::create(id(), 1).unwrap();
    a.append(Origin::User, &entry(1)).0.unwrap();
    let invalid = raw_copy(&a, 2);
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

    // The same event with other content, appended on another device (only a
    // bug makes one): accepted, and both devices read the same one.
    let mut b = ConversationDoc::create(id(), 3).unwrap();
    let mut conflict = entry(1);
    conflict.payload = json!({"sequence": 99});
    b.append(Origin::User, &conflict).0.unwrap();
    let (sa, sb) = (a.export_snapshot().unwrap(), b.export_snapshot().unwrap());
    a.import(&sb, Origin::Sync).unwrap();
    b.import(&sa, Origin::Sync).unwrap();
    let read = a.entries().unwrap();
    assert_eq!(read, b.entries().unwrap());
    assert_eq!(read.len(), 1);
    assert!(read[0] == entry(1) || read[0] == conflict);
    for d in [&a, &b] {
        assert_eq!(
            d.problems(),
            ConversationProblems {
                unreadable: vec![],
                conflicting: vec!["session-1:1".into()],
            }
        );
    }
}

/// The guard judges an update by its own operations: a device that never
/// saw an entry refuses its deletion as well, so devices never split over
/// what one accepted and another refused.
#[test]
fn a_deletion_is_refused_whatever_the_receiver_has_seen() {
    let mut a = ConversationDoc::create(id(), 1).unwrap();
    let start = a.version();
    a.append(Origin::User, &entry(1)).0.unwrap();
    let with_one = a.version();
    let u1 = a.export_updates_since(&start).unwrap();
    let raw = raw_copy(&a, 2);
    raw.get_list(schema::conversation::ENTRIES)
        .delete(0, 1)
        .unwrap();
    raw.commit();
    let u2 = raw.export(ExportMode::updates(&with_one)).unwrap();
    let whole = raw.export(ExportMode::Snapshot).unwrap();

    // C has only the genesis: inserted then deleted is still a deletion.
    let mut c = ConversationDoc::create(id(), 3).unwrap();
    assert!(c.import(&whole, Origin::Sync).is_err());
    // Out of order: the deletion alone waits on what it deletes, refused
    // rather than kept pending and applied unchecked later.
    assert!(c.import(&u2, Origin::Sync).is_err());
    c.import(&u1, Origin::Sync).unwrap();
    assert!(c.import(&u2, Origin::Sync).is_err());
    assert_eq!(c.entries().unwrap(), vec![entry(1)]);

    // Rewriting the identity, or another conversation's bytes.
    let renamed = raw_copy(&a, 4);
    renamed
        .get_map(schema::conversation::META)
        .insert(schema::meta::DOC, "conversation:other")
        .unwrap();
    renamed.commit();
    assert!(
        a.import(
            &renamed.export(ExportMode::updates(&a.version())).unwrap(),
            Origin::Sync
        )
        .is_err()
    );
    let other = ConversationDoc::create(ConversationId::parse("other").unwrap(), 5).unwrap();
    assert!(
        a.import(&other.export_snapshot().unwrap(), Origin::Sync)
            .is_err()
    );
    // Other meta keys and other root containers are a later version's to add.
    let later = raw_copy(&a, 6);
    later
        .get_map(schema::conversation::META)
        .insert("title", "以后的字段")
        .unwrap();
    later.get_map("summary").insert("k", 1).unwrap();
    later.commit();
    a.import(
        &later.export(ExportMode::updates(&a.version())).unwrap(),
        Origin::Sync,
    )
    .unwrap();
    assert_eq!(a.entries().unwrap(), vec![entry(1)]);
}

/// Entries this version cannot read (not JSON, a later envelope, a
/// container) never stop the conversation from opening, syncing or taking
/// new entries; they are kept and reported.
#[test]
fn a_conversation_with_entries_it_cannot_read_still_opens_and_syncs() {
    let mut a = ConversationDoc::create(id(), 1).unwrap();
    let raw = raw_copy(&a, 2);
    let list = raw.get_list(schema::conversation::ENTRIES);
    list.push("不是 JSON").unwrap();
    list.push(r#"{"id":"s:9","session":"s","turn":"三","kind":"assistant","payload":{}}"#)
        .unwrap();
    list.push_container(loro::LoroMap::new()).unwrap();
    list.push(serde_json::to_string(&entry(1)).unwrap())
        .unwrap();
    raw.commit();
    a.import(&raw.export(ExportMode::Snapshot).unwrap(), Origin::Sync)
        .unwrap();
    assert_eq!(a.entries().unwrap(), vec![entry(1)]);
    assert_eq!(a.problems().unreadable, vec![0, 1, 2]);
    assert!(a.append(Origin::User, &entry(2)).0.unwrap());
    let reopened = ConversationDoc::load(id(), 3, &[a.export_snapshot().unwrap()]).unwrap();
    assert_eq!(reopened.entries().unwrap(), vec![entry(1), entry(2)]);
    assert_eq!(reopened.problems().unreadable, vec![0, 1, 2]);
    let raw_list = raw_copy(&reopened, 4)
        .get_list(schema::conversation::ENTRIES)
        .len();
    assert_eq!(raw_list, 5, "nothing dropped");
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

/// An append looks for a replay without parsing the entries already in the
/// list: appending a new event parses none, a replayed one only the stored
/// entry it is compared with. A conversation of M appends used to parse
/// M(M-1)/2 entries.
#[test]
fn appending_to_a_long_conversation_parses_none_of_its_entries() {
    const M: u32 = 2_000;
    let mut doc = ConversationDoc::create(id(), 1).unwrap();
    for sequence in 0..M {
        assert!(doc.append(Origin::User, &entry(sequence)).0.unwrap());
    }
    assert_eq!(doc.index.parsed(), 0, "the warm index never reparsed");
    let before = doc.version();
    assert!(!doc.append(Origin::User, &entry(7)).0.unwrap());
    assert_eq!(
        doc.index.parsed(),
        1,
        "a replay parses only its stored entry"
    );
    let mut changed = entry(7);
    changed.payload = json!({"sequence": "changed"});
    assert!(doc.append(Origin::User, &changed).0.is_err());
    assert_eq!(doc.index.parsed(), 2);
    assert_eq!(doc.version(), before);

    // A writer on a document held elsewhere keeps the index between appends:
    // one rebuild when it first meets the list, none after.
    let raw = raw_copy(&doc, 2);
    let borrowed = BorrowedConversation::new(&raw, &id()).unwrap();
    let mut index = EntryIndex::default();
    assert!(borrowed.append_indexed(&mut index, &entry(M)).unwrap());
    assert_eq!(index.parsed(), M as usize);
    for sequence in M + 1..M + 100 {
        assert!(
            borrowed
                .append_indexed(&mut index, &entry(sequence))
                .unwrap()
        );
    }
    assert!(!borrowed.append_indexed(&mut index, &entry(3)).unwrap());
    assert_eq!(index.parsed(), M as usize + 1);
    raw.commit();
    let mut all: Vec<_> = (0..M + 100).map(entry).collect();
    assert_eq!(borrowed.entries().unwrap(), all);
    all.truncate(M as usize);
    assert_eq!(doc.entries().unwrap(), all);
}

/// The index notices a list that changed under it (entries merged in from
/// another device) and answers as a full reading would: the first readable
/// entry of an id decides, and a replay is still a no-op.
#[test]
fn an_index_follows_a_list_that_changed_under_it() {
    let mut a = ConversationDoc::create(id(), 1).unwrap();
    let mut b = ConversationDoc::create(id(), 2).unwrap();
    for sequence in 0..3 {
        a.append(Origin::User, &entry(sequence)).0.unwrap();
    }
    let other = |sequence: u32| ConversationEntry {
        id: format!("session-2:{sequence}"),
        session: "session-2".into(),
        ..entry(sequence)
    };
    for sequence in 0..3 {
        b.append(Origin::User, &other(sequence)).0.unwrap();
    }
    // The same event appended on both devices, with other content on b
    // (only a bug makes one): after the merge both read whichever is first.
    let mut conflict = entry(9);
    conflict.payload = json!({"sequence": "b"});
    b.append(Origin::User, &conflict).0.unwrap();
    a.append(Origin::User, &entry(9)).0.unwrap();
    a.import(&b.export_snapshot().unwrap(), Origin::Sync)
        .unwrap();
    let merged = a.entries().unwrap();
    assert_eq!(merged.len(), 7);
    let parsed = a.index.parsed();
    for e in &merged {
        assert!(!a.append(Origin::User, e).0.unwrap(), "{} replays", e.id);
    }
    // One rebuild of the eight stored values, then one per replay.
    assert_eq!(a.index.parsed(), parsed + 8 + merged.len());
    let first = merged.iter().find(|e| e.id == entry(9).id).unwrap();
    let second = if *first == conflict {
        entry(9)
    } else {
        conflict.clone()
    };
    assert!(a.append(Origin::User, &second).0.is_err());
    assert!(a.append(Origin::User, &entry(10)).0.unwrap());
    let mut expected = merged;
    expected.push(entry(10));
    assert_eq!(a.entries().unwrap(), expected);
    // A fresh index reads the same list the same way.
    let raw = raw_copy(&a, 3);
    let fresh = BorrowedConversation::new(&raw, &id()).unwrap();
    assert!(fresh.append(&second).is_err());
    for e in &expected {
        assert!(!fresh.append(e).unwrap());
    }
}
