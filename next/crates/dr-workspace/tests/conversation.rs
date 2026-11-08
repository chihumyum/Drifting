//! A conversation never enters the prose command/editor path.

mod common;

use common::env;
use dr_doc::conversation::{BorrowedConversation, ConversationDoc};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_model::id::ConversationId;
use dr_workspace::{Actor, WsEvent};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[test]
fn prose_commands_and_editor_reject_conversations_without_writing() {
    let e = env();
    let conversation = "conversation:control-test";
    for (name, input) in [
        ("prose.read", json!({"doc": conversation})),
        ("prose.shape", json!({"doc": conversation})),
        (
            "prose.replace",
            json!({"doc": conversation, "find": "a", "replace": "b"}),
        ),
        ("history.points", json!({"doc": conversation})),
    ] {
        let error = e.try_call(name, input).unwrap_err();
        assert_eq!(error.code(), "invalid", "{name}: {error}");
    }
    assert!(e.ws().prose_session(conversation).is_err());
    assert!(e.ws().library().doc_info(conversation).unwrap().is_none());
}

#[test]
fn sync_conversation_uses_append_only_document_without_prose_events() {
    let e = env();
    let book = e.book();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let _subscription = e
        .ws()
        .subscribe(move |event| captured.lock().unwrap().push(event.clone()));
    let id = ConversationId::new_v7();
    let mut remote = ConversationDoc::create(id.clone(), 1).unwrap();
    let entry = ConversationEntry {
        id: "session-1:1".into(),
        session: "session-1".into(),
        turn: 1,
        kind: ConversationEntryKind::Assistant,
        payload: json!({"sequence": 1}),
    };
    remote.append(dr_model::Origin::User, &entry).0.unwrap();
    let doc_id = remote.doc_id().to_string();
    e.ws()
        .import_remote(
            &doc_id,
            Some(("conversation", &book)),
            remote.export_snapshot().unwrap(),
            &Actor::Sync,
        )
        .unwrap();
    let stored = e.ws().library().load_copy(&doc_id).unwrap();
    assert_eq!(
        BorrowedConversation::new(&stored, &id)
            .unwrap()
            .entries()
            .unwrap(),
        vec![entry]
    );
    assert_eq!(stored.get_text("body").len_unicode(), 0);
    assert!(e.ws().prose_session(&doc_id).is_err());
    assert!(
        !seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, WsEvent::Prose(_)))
    );

    let head = e.ws().library().head(&doc_id).unwrap();
    stored.set_peer_id(3).unwrap();
    stored
        .get_list(dr_doc::schema::conversation::ENTRIES)
        .delete(0, 1)
        .unwrap();
    stored.commit();
    let invalid = stored.export(loro::ExportMode::Snapshot).unwrap();
    assert!(
        e.ws()
            .import_remote(&doc_id, None, invalid, &Actor::Sync)
            .is_err()
    );
    assert_eq!(e.ws().library().head(&doc_id).unwrap(), head);
    let retained = e.ws().library().load_copy(&doc_id).unwrap();
    assert_eq!(
        BorrowedConversation::new(&retained, &id)
            .unwrap()
            .entries()
            .unwrap()
            .len(),
        1
    );
}
