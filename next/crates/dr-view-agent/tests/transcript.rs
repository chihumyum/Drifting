//! Real GPUI companion views over the shared-seed library and scripted model.
//! The connection state uses an in-memory synthetic credential and loopback
//! endpoints; no network call or operating-system credential is required.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, FinishReason, ProviderTool, ProviderToolAction, ProviderToolStatus, State,
    ToolCall,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::id::BookId;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    connection::{Connections, PROVIDERS},
    hub::AgentHub,
    panel::AgentPanel,
    state::ChatSnapshot,
    tools::CompanionTools,
};
use dr_workspace::Workspace;
use futures::{channel::oneshot, executor::block_on};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::json;

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    books: [BookId; 2],
    text: [String; 2],
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m31-panel-test").unwrap();
        ws.set_auto_links(false);
        let mut books = Vec::new();
        let mut text = Vec::new();
        for offset in [0, 1] {
            let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED + offset).unwrap();
            books.push(seeded.books[0].book_id().clone());
            text.push(
                seeded.books[0]
                    .groups()
                    .values()
                    .flatten()
                    .find(|text| text.chars().count() >= 16)
                    .unwrap()
                    .chars()
                    .take(16)
                    .collect(),
            );
            seeded.write_to(ws.library()).unwrap();
        }
        Self {
            _dir: dir,
            ws,
            books: books.try_into().unwrap(),
            text: text.try_into().unwrap(),
        }
    }
}

struct Views {
    shell: Entity<ShellWorkspace>,
    panel: Entity<AgentPanel>,
    hub: Entity<AgentHub>,
    connections: Entity<Connections>,
}

fn provider() -> ProviderDriver {
    let local = "http://127.0.0.1:9";
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        Credentials::candidate(dr_agent::Provider::Deepseek, "synthetic-panel-key").unwrap(),
        Endpoints {
            deepseek: local.into(),
            anthropic: local.into(),
            openai: local.into(),
            chatgpt: local.into(),
        },
        OAuthEndpoints::at(local).unwrap(),
        RetryPolicy {
            max_attempts: 1,
            ..Default::default()
        },
    )
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    fixture: &Fixture,
    driver: Arc<ScriptedDriver>,
) -> (Views, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let (hub, connections) = cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(fixture.books[0].as_str());
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "m31-panel-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(fixture.ws.clone()),
                ..Services::default()
            },
            settings,
            cx,
        );
        dr_view_agent::init_with(provider(), driver, Arc::new(CompanionTools::default()), cx);
        let views = cx.global::<dr_view_agent::AgentViews>();
        let (hub, connections) = (views.hub.clone(), views.connections.clone());
        for provider in PROVIDERS {
            connections.update(cx, |connections, _| {
                connections.set_catalog_endpoint(provider, "http://127.0.0.1:9/models".into())
            });
        }
        (hub, connections)
    });
    let shell_window = cx.add_window(ShellWorkspace::new);
    let shell = shell_window.root(cx).unwrap();
    let (weak, view_hub, view_connections) = (shell.downgrade(), hub.clone(), connections.clone());
    let (panel, cx) = cx.add_window_view(move |window, cx| {
        AgentPanel::new(weak, view_hub, view_connections, window, cx)
    });
    let views = Views {
        shell,
        panel,
        hub,
        connections,
    };
    wait(cx, |cx| {
        views.shell.read_with(cx, |ws, _| {
            ws.book_id == fixture.books[0].as_str() && !ws.book.is_empty()
        }) && views
            .connections
            .read_with(cx, |connections, _| connections.usable() == Some(true))
            && views.hub.read_with(cx, |hub, _| hub.controller.is_some())
            && views.panel.read_with(cx, |panel, _| panel.is_settled())
    });
    (views, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "Agent panel condition timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn composer(panel: &Entity<AgentPanel>, text: &str, cx: &mut VisualTestContext) {
    let field = panel.read_with(cx, |panel, _| panel.composer());
    field.update(cx, |field, cx| field.set_text(text, cx));
}

fn snapshot(panel: &Entity<AgentPanel>, cx: &VisualTestContext) -> Option<ChatSnapshot> {
    panel.read_with(cx, |panel, _| panel.snapshot().cloned())
}

fn send(panel: &Entity<AgentPanel>, text: &str, cx: &mut VisualTestContext) {
    composer(panel, text, cx);
    panel.update(cx, |panel, cx| panel.send(cx));
}

fn close(views: &Views, fixture: &Fixture, cx: &mut VisualTestContext) {
    let close = views.hub.update(cx, |hub, cx| hub.prepare_close(cx));
    block_on(close).unwrap();
    cx.run_until_parked();
    fixture.ws.close();
}

fn search(id: &str, text: &str) -> Step {
    Step::Event(DriverEvent::ProviderTool {
        activity: ProviderTool {
            id: id.into(),
            action: ProviderToolAction::Search,
            status: ProviderToolStatus::Completed,
            query: Some(text.into()),
            url: None,
        },
    })
}

fn bounds(cx: &mut VisualTestContext, selector: String) -> gpui::Bounds<gpui::Pixels> {
    // The test API accepts static selectors; each synthetic conversation only
    // allocates a bounded number of them for this process.
    let selector = Box::leak(selector.into_boxed_str());
    cx.debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing rendered element {selector}"))
}

fn expanded(cx: &mut VisualTestContext, id: &str, expected: bool) {
    let selector = Box::leak(format!("{id}:content").into_boxed_str());
    assert_eq!(
        cx.debug_bounds(selector).is_some(),
        expected,
        "{id} expansion"
    );
}

#[gpui::test]
fn two_turn_cards_keep_order_during_stream_finish_and_reopen_and_disclosures_use_keyboard(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let (finish, waiting) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::ThinkingDelta {
                index: 0,
                text: fixture.text[1].clone(),
            }),
            search("first-search", &fixture.text[0]),
            Step::Event(DriverEvent::ToolCall(ToolCall {
                id: "first-ask".into(),
                name: "ask_user".into(),
                arguments: json!({"prompt":fixture.text[0], "options":[fixture.text[1]]}),
            })),
            Step::Event(DriverEvent::Finish(FinishReason::Tools)),
        ],
        vec![
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: fixture.text[1].clone(),
            }),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
        vec![
            Step::Event(DriverEvent::ThinkingDelta {
                index: 0,
                text: fixture.text[0].clone(),
            }),
            Step::Event(DriverEvent::TextDelta {
                index: 1,
                text: fixture.text[1].clone(),
            }),
            search("second-search", &fixture.text[1]),
            Step::Wait(waiting),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
    ]));
    let (views, cx) = open(cx, &fixture, driver);
    cx.simulate_resize(gpui::size(gpui::px(1000.), gpui::px(1800.)));
    send(&views.panel, &fixture.text[0], cx);
    wait(cx, |cx| {
        snapshot(&views.panel, cx).is_some_and(|s| s.runs[0].question.is_some())
    });
    send(&views.panel, &fixture.text[1], cx);
    wait(cx, |cx| {
        snapshot(&views.panel, cx).is_some_and(|s| s.runs[0].state == State::Completed)
    });
    let first = snapshot(&views.panel, cx).unwrap();
    assert_eq!(first.messages.len(), 4);
    let session = &first.runs[0].session;
    let thinking = format!("assistant:{session}:1:0:thinking:0");
    let tool = format!("assistant:{session}:1:0:tool:first-ask");
    let result = format!("result:{}", first.messages[2].id);
    for id in [&thinking, &tool, &result] {
        expanded(cx, id, false);
    }
    // A pointer can focus the same control; all subsequent transitions use
    // keyboard input and check the actually rendered disclosure contents.
    let at = bounds(cx, thinking.clone()).center();
    cx.simulate_click(at, gpui::Modifiers::none());
    draw(cx);
    expanded(cx, &thinking, true);
    cx.simulate_keystrokes("enter");
    draw(cx);
    expanded(cx, &thinking, false);
    cx.simulate_keystrokes("space");
    draw(cx);
    expanded(cx, &thinking, true);
    cx.simulate_keystrokes("tab enter");
    draw(cx);
    expanded(cx, &tool, true);
    cx.simulate_keystrokes("tab space");
    draw(cx);
    expanded(cx, &result, true);
    cx.simulate_keystrokes("shift-tab enter shift-tab space");
    draw(cx);
    expanded(cx, &thinking, false);
    expanded(cx, &tool, false);

    send(&views.panel, &fixture.text[0], cx);
    wait(cx, |cx| {
        snapshot(&views.panel, cx).is_some_and(|s| {
            s.runs.len() == 2
                && s.runs[1].live_message.is_some()
                && !s.runs[1].provider_tools.is_empty()
        })
    });
    let stream = snapshot(&views.panel, cx).unwrap();
    let second = &stream.runs[1];
    let first_final = format!("agent-message-{}", first.messages[3].id);
    let first_card = format!("provider-tool-{session}-first-search");
    let first_question = format!(
        "agent-question-history-{}",
        first.runs[0].questions[0].request.nonce
    );
    let second_user = format!("agent-message-{}", stream.messages[4].id);
    let second_live = format!("agent-live-{}-1", second.session);
    let second_card = format!("provider-tool-{}-second-search", second.session);
    let first_y = bounds(cx, first_final).origin.y;
    let card_y = bounds(cx, first_card.clone()).origin.y;
    let question_y = bounds(cx, first_question.clone()).origin.y;
    let user_y = bounds(cx, second_user.clone()).origin.y;
    let live_y = bounds(cx, second_live).origin.y;
    let next_card_y = bounds(cx, second_card.clone()).origin.y;
    assert!(
        first_y < card_y
            && card_y < question_y
            && question_y < user_y
            && user_y < live_y
            && live_y < next_card_y
    );
    // The active assistant uses the same disclosure key when its durable
    // message replaces the streaming draft.
    let live_thinking = format!("assistant:{}:1:0:thinking:0", second.session);
    let at = bounds(cx, live_thinking.clone()).center();
    cx.simulate_click(at, gpui::Modifiers::none());
    draw(cx);
    expanded(cx, &live_thinking, true);
    let before = bounds(cx, second_user.clone()).origin.y;
    finish.send(()).unwrap();
    wait(cx, |cx| {
        snapshot(&views.panel, cx).is_some_and(|s| s.runs[1].state == State::Completed)
    });
    let final_snapshot = snapshot(&views.panel, cx).unwrap();
    assert_eq!(final_snapshot.messages.len(), 6);
    let final_id = format!("agent-message-{}", final_snapshot.messages[5].id);
    assert_eq!(bounds(cx, second_user.clone()).origin.y, before);
    assert!(bounds(cx, first_card.clone()).origin.y < bounds(cx, second_user.clone()).origin.y);
    assert!(bounds(cx, final_id.clone()).origin.y < bounds(cx, second_card.clone()).origin.y);
    assert_eq!(bounds(cx, final_id.clone()).origin.y, live_y);
    expanded(cx, &live_thinking, true);
    let conversation = final_snapshot.conversation;
    views
        .panel
        .update(cx, |panel, cx| panel.new_conversation(cx));
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| {
            panel.is_settled() && panel.snapshot().is_none()
        })
    });
    views.panel.update(cx, |panel, cx| {
        panel.select_conversation(conversation.clone(), cx)
    });
    wait(cx, |cx| {
        snapshot(&views.panel, cx).is_some_and(|s| s.messages.len() == 6)
    });
    assert!(bounds(cx, first_card).origin.y < bounds(cx, second_user).origin.y);
    assert!(bounds(cx, first_question).origin.y < bounds(cx, final_id.clone()).origin.y);
    assert!(bounds(cx, final_id).origin.y < bounds(cx, second_card).origin.y);
    close(&views, &fixture, cx);
}

#[test]
fn session_turn_slots_preserve_model_rounds_and_messages_without_a_local_run() {
    use dr_agent::{AssistantMessage, ContentBlock, Event, JournalEvent, Usage};
    use dr_view_agent::state::{ChatMessage, ChatState, MessageContent, TranscriptItem};
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let text = seeded.books[0].groups().values().flatten().next().unwrap();
    let mut state = ChatState::new("local");
    let assistant = AssistantMessage {
        complete: true,
        blocks: vec![ContentBlock::Text {
            index: 0,
            text: text.clone(),
        }],
        usage: Usage::default(),
        replay: None,
    };
    let events = [
        (1, Event::UserMessage { text: text.clone() }),
        (
            1,
            Event::AssistantMessage {
                message: assistant.clone(),
            },
        ),
        (
            1,
            Event::ProviderTool {
                activity: ProviderTool {
                    id: "search-1".into(),
                    action: ProviderToolAction::Search,
                    status: ProviderToolStatus::Completed,
                    query: Some(text.clone()),
                    url: None,
                },
            },
        ),
        (1, Event::AssistantMessage { message: assistant }),
        (2, Event::UserMessage { text: text.clone() }),
        (
            2,
            Event::ProviderTool {
                activity: ProviderTool {
                    id: "search-2".into(),
                    action: ProviderToolAction::Search,
                    status: ProviderToolStatus::Completed,
                    query: Some(text.clone()),
                    url: None,
                },
            },
        ),
        (
            2,
            Event::TextDelta {
                index: 0,
                text: text.clone(),
            },
        ),
    ];
    for (index, (turn, event)) in events.into_iter().enumerate() {
        state
            .apply(&JournalEvent {
                session: "local".into(),
                seq: index as i64 + 1,
                turn,
                event,
            })
            .unwrap();
    }
    let mut messages: Vec<ChatMessage> = state.entries().iter().map(ChatMessage::from).collect();
    messages.insert(
        1,
        ChatMessage {
            id: "synced-message".into(),
            session: "other-device".into(),
            turn: 1,
            content: MessageContent::User { text: text.clone() },
        },
    );
    let expected: Vec<String> = messages.iter().map(|message| message.id.clone()).collect();
    let snapshot = ChatSnapshot {
        conversation: "conversation".parse().unwrap(),
        entries: state.entries().to_vec(),
        messages,
        runs: vec![state.snapshot()],
    };
    let mut actual = Vec::new();
    let mut cards = Vec::new();
    for item in snapshot.transcript() {
        match item {
            TranscriptItem::Message(message) => actual.push(message.id.clone()),
            TranscriptItem::Run { run, turn } => cards.push((
                turn,
                actual.last().unwrap().clone(),
                run.provider_tools
                    .iter()
                    .filter(|activity| run.provider_tool_turns[&activity.id] == turn)
                    .map(|activity| activity.id.clone())
                    .collect::<Vec<_>>(),
            )),
        }
    }
    assert_eq!(actual, expected);
    assert_eq!(
        cards,
        vec![
            (1, "local:4".into(), vec!["search-1".into()]),
            (2, "local:5".into(), vec!["search-2".into()])
        ]
    );
}
