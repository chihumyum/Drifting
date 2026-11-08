//! Unsupported or damaged journals cannot mutate a conversation projection.

use std::sync::Arc;

use dr_agent::driver::scripted::ScriptedDriver;
use dr_agent::tools::ToolOutput;
use dr_agent::*;
use dr_doc::conversation::BorrowedConversation;
use dr_model::{
    DocId,
    conversation::{ConversationEntry, ConversationEntryKind},
    id::ConversationId,
};
use dr_store::{Library, OpenDoc, Origin, agent::AgentEventAppend};
use dr_workspace::{Workspace, WorkspaceOptions, library_options};
use futures::{FutureExt, future::BoxFuture};
use serde_json::json;

struct NoTools;

impl ToolExecutor for NoTools {
    fn descriptors(&self) -> Vec<ToolDescriptor> {
        Vec::new()
    }

    fn execute(&self, _: ToolContext, _: ToolCall) -> BoxFuture<'static, Result<ToolOutput>> {
        futures::future::ready(Err(Error::Tool("no test tools".into()))).boxed()
    }
}

fn append(lib: &Library, session: &str, previous: i64, event: Event) {
    lib.agent_append_event(&AgentEventAppend {
        session: session.into(),
        expected_seq: previous,
        event_json: json!({"turn":1,"event":event}).to_string(),
    })
    .unwrap();
}

#[test]
fn invalid_journals_fail_before_creating_or_replaying_conversations() {
    let cases = [
        Vec::new(),
        vec![Event::Started {
            version: PROTOCOL_VERSION + 1,
        }],
        vec![Event::StateChanged {
            state: State::Streaming,
        }],
        vec![
            Event::Started {
                version: PROTOCOL_VERSION,
            },
            Event::UserMessage {
                text: String::new(),
            },
            Event::Started {
                version: PROTOCOL_VERSION,
            },
        ],
    ];
    for log in cases {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m27-protocol-test")).unwrap();
        let id = ConversationId::new_v7();
        let doc_id = DocId::Conversation(id).to_string();
        lib.agent_create_session("session", &doc_id, "book")
            .unwrap();
        for (i, event) in log.into_iter().enumerate() {
            append(&lib, "session", i as i64, event);
        }
        let before = lib.agent_events("session", 0).unwrap();
        assert!(events(&lib, "session", 0).is_err());
        // Skipping Started cannot bypass version/shape validation.
        assert!(events(&lib, "session", 1).is_err());
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        let runtime = Runtime::new(
            ws.clone(),
            Arc::new(ScriptedDriver::new(Vec::new())),
            Arc::new(NoTools),
            Options::default(),
        )
        .unwrap();
        assert!(runtime.recover().is_err());
        assert!(ws.library().doc_info(&doc_id).unwrap().is_none());
        assert_eq!(ws.library().agent_events("session", 0).unwrap(), before);
        drop(runtime);
        ws.shutdown().unwrap();
    }
}

#[test]
fn missing_sequence_is_not_silently_replayed_as_a_complete_log() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("m27-protocol-test")).unwrap();
    let doc_id = DocId::Conversation(ConversationId::new_v7()).to_string();
    lib.agent_create_session("session", &doc_id, "book")
        .unwrap();
    append(
        &lib,
        "session",
        0,
        Event::Started {
            version: PROTOCOL_VERSION,
        },
    );
    append(
        &lib,
        "session",
        1,
        Event::StateChanged {
            state: State::Streaming,
        },
    );
    append(
        &lib,
        "session",
        2,
        Event::StateChanged {
            state: State::Completed,
        },
    );
    assert_eq!(events(&lib, "session", 1).unwrap().len(), 2);
    assert!(events(&lib, "session", 3).unwrap().is_empty());
    // Simulate storage corruption that ordinary append APIs cannot create.
    lib.local_transaction(|tx| {
        tx.execute(
            "DELETE FROM agent_event WHERE session = 'session' AND seq = 2",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(events(&lib, "session", 0).is_err());
    assert!(events(&lib, "session", 1).is_err());
    // An incremental cursor represents a prefix already accepted by the
    // caller. It reads only newer events; startup full replay checks all.
    assert_eq!(events(&lib, "session", 2).unwrap().len(), 1);
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let runtime = Runtime::new(
        ws.clone(),
        Arc::new(ScriptedDriver::new(Vec::new())),
        Arc::new(NoTools),
        Options::default(),
    )
    .unwrap();
    assert!(runtime.recover().is_err());
    assert!(ws.library().doc_info(&doc_id).unwrap().is_none());
    assert_eq!(ws.library().agent_events("session", 0).unwrap().len(), 2);
    drop(runtime);
    ws.shutdown().unwrap();
}

#[test]
fn conversation_projection_can_be_read_without_a_writable_library_or_holder() {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("m27-protocol-test")).unwrap();
    let id = ConversationId::new_v7();
    let doc_id = DocId::Conversation(id.clone()).to_string();
    let bytes = dr_doc::conversation::genesis(&id);
    let handle = lib
        .open_doc(
            &doc_id,
            OpenDoc::CreateIfMissing {
                kind: "conversation",
                book_id: Some("book"),
                genesis: &|doc| {
                    doc.import(&bytes).unwrap();
                },
            },
        )
        .unwrap();
    // Synthetic protocol metadata, no separately authored manuscript.
    let entry = ConversationEntry {
        id: "session:1".into(),
        session: "session".into(),
        turn: 1,
        kind: ConversationEntryKind::User,
        payload: json!({"text":""}),
    };
    let copied_entry = entry.clone();
    let copied_id = id.clone();
    handle
        .write(Origin::User, move |doc| {
            BorrowedConversation::new(doc, &copied_id)?.append(&copied_entry)
        })
        .unwrap()
        .0
        .unwrap();
    handle.close();
    let head = lib.head(&doc_id).unwrap();
    lib.close().unwrap();

    let lib = Library::open_read_only(dir.path(), library_options("m27-protocol-test")).unwrap();
    assert!(lib.is_read_only());
    assert_eq!(conversation(&lib, &id).unwrap(), vec![entry]);
    assert_eq!(lib.open_doc_count(), 0);
    assert_eq!(lib.head(&doc_id).unwrap(), head);
}
