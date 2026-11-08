use dr_agent::{
    AssistantMessage, ContentBlock, Event, JournalEvent, ProviderTool, ProviderToolAction,
    ProviderToolStatus, State, Usage,
};
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::state::{ChatMessage, ChatState, MessageContent};
use serde_json::json;

fn row(seq: i64, event: Event) -> JournalEvent {
    JournalEvent {
        session: "synthetic-session".into(),
        seq,
        turn: 1,
        event,
    }
}

fn fragments() -> Vec<String> {
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seeded.books[0]
        .groups()
        .values()
        .flatten()
        .find(|text| text.chars().count() >= 3)
        .unwrap()
        .chars()
        .take(3)
        .map(|character| character.to_string())
        .collect()
}

#[test]
fn streamed_blocks_keep_wire_order_and_final_message_replaces_the_draft() {
    let fragments = fragments();
    let mut state = ChatState::new("synthetic-session");
    state
        .apply(&row(
            1,
            Event::StateChanged {
                state: State::Streaming,
            },
        ))
        .unwrap();
    state
        .apply(&row(
            2,
            Event::TextDelta {
                index: 3,
                text: fragments[0].clone(),
            },
        ))
        .unwrap();
    state
        .apply(&row(
            3,
            Event::ThinkingDelta {
                index: 1,
                text: fragments[1].clone(),
            },
        ))
        .unwrap();
    let delta = row(
        4,
        Event::TextDelta {
            index: 3,
            text: fragments[2].clone(),
        },
    );
    state.apply(&delta).unwrap();
    state.apply(&delta).unwrap();
    let snapshot = state.snapshot();
    let message = snapshot.live_message.unwrap();
    assert!(
        matches!(&message.blocks[0],ContentBlock::Thinking{index:1,text,..} if text==&fragments[1])
    );
    assert!(
        matches!(&message.blocks[1],ContentBlock::Text{index:3,text} if text==&format!("{}{}",fragments[0],fragments[2]))
    );
    let message = AssistantMessage {
        blocks: message.blocks,
        usage: Usage {
            input_tokens: 100,
            ..Usage::default()
        },
        complete: true,
        replay: None,
    };
    state
        .apply(&row(5, Event::AssistantMessage { message }))
        .unwrap();
    assert!(state.snapshot().live_message.is_none());
    assert_eq!(state.snapshot().usage.input_tokens, 100);
    assert_eq!(state.entries().len(), 1);
    assert!(
        state
            .apply(&row(
                7,
                Event::StateChanged {
                    state: State::Completed
                }
            ))
            .is_err()
    );
    assert_eq!(state.snapshot().last_seq, 5);
}

#[test]
fn failed_search_keeps_its_query_and_unknown_transcript_payloads_are_preserved() {
    let query = fragments().concat();
    let mut state = ChatState::new("synthetic-session");
    let activity = ProviderTool {
        id: "synthetic-search".into(),
        action: ProviderToolAction::Search,
        status: ProviderToolStatus::Started,
        query: Some(query.clone()),
        url: None,
    };
    state
        .apply(&row(
            1,
            Event::ProviderTool {
                activity: activity.clone(),
            },
        ))
        .unwrap();
    state
        .apply(&row(
            2,
            Event::ProviderTool {
                activity: ProviderTool {
                    status: ProviderToolStatus::Failed,
                    query: None,
                    ..activity
                },
            },
        ))
        .unwrap();
    let run = state.snapshot();
    assert_eq!(run.provider_tools.len(), 1);
    assert_eq!(run.provider_tools[0].status, ProviderToolStatus::Failed);
    assert_eq!(run.provider_tools[0].query.as_deref(), Some(query.as_str()));
    let entry = ConversationEntry {
        id: "synthetic-session:3".into(),
        session: "synthetic-session".into(),
        turn: 1,
        kind: ConversationEntryKind::parse("future-content"),
        payload: json!({"preserve":[1,2,3]}),
    };
    let message = ChatMessage::from(&entry);
    assert!(
        matches!(message.content,MessageContent::Other{entry_kind,payload} if entry_kind==entry.kind && payload==entry.payload)
    );
}
