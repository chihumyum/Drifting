//! Real GPUI companion views over the shared-seed library and scripted model.
//! The connection state uses an in-memory synthetic credential and loopback
//! endpoints; no network call or operating-system credential is required.

use std::{
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, FinishReason, State, ToolCall,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::{
    DocId,
    id::{BookId, ConversationId},
};
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
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext, WindowHandle};
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
    shell_window: WindowHandle<ShellWorkspace>,
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
        shell_window,
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

fn text(panel: &Entity<AgentPanel>, cx: &VisualTestContext) -> String {
    let field = panel.read_with(cx, |panel, _| panel.composer());
    field.read_with(cx, |field, _| field.text())
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

#[gpui::test]
fn panel_sends_answers_the_real_question_tool_and_stops_the_next_round(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_keep, waiting) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::ToolCall(ToolCall {
                id: "ask-1".into(),
                name: "ask_user".into(),
                arguments: json!({"prompt":fixture.text[0],"options":[fixture.text[1]]}),
            })),
            Step::Event(DriverEvent::Finish(FinishReason::Tools)),
        ],
        vec![
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: fixture.text[1].clone(),
            }),
            Step::Wait(waiting),
        ],
    ]));
    let (views, cx) = open(cx, &fixture, driver.clone());
    composer(&views.panel, &fixture.text[0], cx);
    let field = views.panel.read_with(cx, |panel, _| panel.composer());
    cx.update(|window, cx| field.focus_handle(cx).focus(window, cx));
    draw(cx);
    cx.simulate_keystrokes("shift-enter");
    assert_eq!(text(&views.panel, cx), format!("{}\n", fixture.text[0]));
    assert!(driver.requests().is_empty());
    cx.simulate_keystrokes("enter");
    wait(cx, |cx| {
        snapshot(&views.panel, cx)
            .is_some_and(|snapshot| snapshot.runs.iter().any(|run| run.question.is_some()))
    });
    assert!(text(&views.panel, cx).is_empty());
    let question = snapshot(&views.panel, cx).unwrap().runs[0]
        .question
        .clone()
        .unwrap();
    assert_eq!(question.question.prompt, fixture.text[0]);
    send(&views.panel, &fixture.text[1], cx);
    wait(cx, |cx| {
        driver.requests().len() == 2
            && snapshot(&views.panel, cx)
                .is_some_and(|snapshot| snapshot.runs[0].live_message.is_some())
    });
    views.panel.update(cx, |panel, cx| panel.stop(cx));
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views.panel, cx)
                .is_some_and(|snapshot| snapshot.runs[0].state == State::Stopped)
    });
    let snapshot = snapshot(&views.panel, cx).unwrap();
    assert_eq!(
        snapshot.runs[0].questions[0].answer,
        Some(json!(fixture.text[1]))
    );
    assert_eq!(snapshot.messages.len(), 4);
    assert_eq!(driver.requests().len(), 2);
    close(&views, &fixture, cx);
}

#[gpui::test]
fn switching_books_keeps_the_old_run_and_restores_the_selected_conversation(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let (_keep, waiting) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: fixture.text[0].clone(),
            }),
            Step::Wait(waiting),
        ],
        vec![
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: fixture.text[1].clone(),
            }),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
    ]));
    let (views, cx) = open(cx, &fixture, driver.clone());
    send(&views.panel, &fixture.text[0], cx);
    wait(cx, |cx| {
        snapshot(&views.panel, cx).is_some_and(|snapshot| snapshot.runs[0].live_message.is_some())
    });
    let first = snapshot(&views.panel, cx).unwrap();
    composer(&views.panel, &fixture.text[0], cx);
    views
        .shell_window
        .update(cx, |ws, window, cx| {
            ws.open_book(fixture.books[1].as_str(), window, cx)
        })
        .unwrap();
    wait(cx, |cx| {
        views.shell.read_with(cx, |ws, _| {
            ws.book_id == fixture.books[1].as_str() && !ws.book.is_empty()
        }) && views.panel.read_with(cx, |panel, _| {
            panel.is_settled() && panel.snapshot().is_none()
        })
    });
    assert!(text(&views.panel, cx).is_empty());
    let controller = views
        .hub
        .read_with(cx, |hub, _| hub.controller.clone().unwrap());
    assert_eq!(
        controller
            .snapshot(&fixture.books[0], &first.conversation)
            .unwrap()
            .runs[0]
            .state,
        State::Streaming
    );
    send(&views.panel, &fixture.text[1], cx);
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views.panel, cx)
                .is_some_and(|snapshot| snapshot.runs[0].state == State::Completed)
    });
    let second = snapshot(&views.panel, cx).unwrap();
    assert_ne!(first.conversation, second.conversation);
    assert_eq!(
        fixture
            .ws
            .library()
            .agent_session(&second.runs[0].session)
            .unwrap()
            .unwrap()
            .book_id,
        fixture.books[1].as_str()
    );
    views
        .shell_window
        .update(cx, |ws, window, cx| {
            ws.open_book(fixture.books[0].as_str(), window, cx)
        })
        .unwrap();
    wait(cx, |cx| {
        snapshot(&views.panel, cx).is_some_and(|snapshot| {
            snapshot.conversation == first.conversation
                && snapshot.runs[0].state == State::Streaming
        })
    });
    views.panel.update(cx, |panel, cx| panel.stop(cx));
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
    });
    assert_eq!(
        controller
            .snapshot(&fixture.books[0], &first.conversation)
            .unwrap()
            .runs[0]
            .state,
        State::Stopped
    );
    assert_eq!(driver.requests().len(), 2);
    close(&views, &fixture, cx);
}

#[gpui::test]
fn a_delayed_start_acknowledgement_preserves_new_composer_text(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let next_draft = fixture.text.concat();
    let driver = Arc::new(ScriptedDriver::new(vec![vec![Step::Event(
        DriverEvent::Finish(FinishReason::Complete),
    )]]));
    let (views, cx) = open(cx, &fixture, driver);
    let conversation = ConversationId::new_v7();
    let doc_id = DocId::Conversation(conversation.clone()).to_string();
    let genesis = dr_doc::conversation::genesis(&conversation);
    let handle = fixture
        .ws
        .library()
        .open_doc(
            &doc_id,
            dr_store::OpenDoc::CreateIfMissing {
                kind: "conversation",
                book_id: Some(fixture.books[0].as_str()),
                genesis: &|doc| {
                    doc.import(&genesis).unwrap();
                },
            },
        )
        .unwrap();
    views.panel.update(cx, |panel, cx| {
        panel.select_conversation(conversation.clone(), cx)
    });
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views.panel, cx)
                .is_some_and(|snapshot| snapshot.conversation == conversation)
    });
    let (entered, entered_rx) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        handle
            .read(move |_| {
                entered.send(()).unwrap();
                blocked.recv().unwrap();
            })
            .unwrap()
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    send(&views.panel, &fixture.text[0], cx);
    // The holder prevents an acknowledgement while the author edits the
    // still-enabled composer; the next GPUI callback must retain that draft.
    composer(&views.panel, &next_draft, cx);
    release.send(()).unwrap();
    holder.join().unwrap();
    wait(cx, |cx| {
        views.panel.read_with(cx, |panel, _| panel.is_settled())
            && snapshot(&views.panel, cx).is_some_and(|snapshot| !snapshot.runs.is_empty())
    });
    assert_eq!(text(&views.panel, cx), next_draft);
    close(&views, &fixture, cx);
}
