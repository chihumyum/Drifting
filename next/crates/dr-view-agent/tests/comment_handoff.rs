//! Synthetic-model GPUI integration test for M18 -> M31 comment handoff:
//! `交给 Agent`, `agent_conversation` persistence & reuse, pinwheel state
//! transitions (`Running` -> `UnviewedDone` -> `Hidden`), status preservation,
//! and `‹ 回审阅` back navigation.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, FinishReason, State,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::id::BookId;
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace,
    review_agent::{self, CommentAgentRequest, CompanionFocusRequest, ConversationPinwheel},
};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    connection::{Connections, PROVIDERS},
    hub::AgentHub,
    panel::{AgentPanel, PanelHead},
    tools::CompanionTools,
};
use dr_workspace::{Actor, Workspace};
use futures::{channel::oneshot, executor::block_on};
use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext};
use serde_json::json;

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    comment_id: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "t6-comment-handoff").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        seeded.write_to(ws.library()).unwrap();

        let entries: serde_json::Value = ws
            .call(&Actor::User, "entry.list", json!({ "book": book.as_str() }))
            .unwrap();
        let entry_id = entries["output"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|e| e["id"].as_str())
            .expect("seeded entry")
            .to_owned();

        let created: serde_json::Value = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({
                    "book": book.as_str(),
                    "target": { "kind": "entry", "id": entry_id },
                    "body": "第一章说她二十五，统一一下。"
                }),
            )
            .unwrap();
        let comment_id = created["output"]["id"]
            .as_str()
            .expect("comment id")
            .to_owned();

        Self {
            _dir: dir,
            ws,
            book,
            comment_id,
        }
    }

    fn comment(&self) -> serde_json::Value {
        let list: serde_json::Value = self
            .ws
            .call(
                &Actor::User,
                "comment.list",
                json!({ "book": self.book.as_str() }),
            )
            .unwrap();
        list["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"].as_str() == Some(&self.comment_id))
            .cloned()
            .expect("comment exists")
    }
}

fn provider() -> ProviderDriver {
    let local = "http://127.0.0.1:9";
    ProviderDriver::with_endpoints(
        HttpClient::new().unwrap(),
        Credentials::candidate(dr_agent::Provider::Deepseek, "synthetic-handoff-key").unwrap(),
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

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait(
    cx: &mut VisualTestContext,
    label: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "condition timed out: {label}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn comment_handoff_tracks_pinwheel_reuses_conversation_and_returns_to_review(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let (finish_1, wait_1) = oneshot::channel();
    let (finish_2, wait_2) = oneshot::channel();
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::ThinkingDelta {
                index: 0,
                text: "核对年龄设定".into(),
            }),
            Step::Wait(wait_1),
            Step::Event(DriverEvent::TextDelta {
                index: 1,
                text: "已核对，第一章写的是二十五。".into(),
            }),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
        vec![
            Step::Wait(wait_2),
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: "第三章没有提生日。".into(),
            }),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
    ]));

    cx.executor().allow_parking();
    let (hub, connections): (Entity<AgentHub>, Entity<Connections>) = cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(fixture.book.as_str());
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "t6-handoff-test",
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
        for p in PROVIDERS {
            connections.update(cx, |c, _| {
                c.set_catalog_endpoint(p, "http://127.0.0.1:9/models".into())
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
    let panel_for_head = panel.clone();
    let _head = cx.update(|_, cx| cx.new(|cx| PanelHead::new_observed(panel_for_head, cx)));

    wait(cx, "initial settle", |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_id == fixture.book.as_str() && !ws.book.is_empty()
        }) && connections.read_with(cx, |c, _| c.usable() == Some(true))
            && hub.read_with(cx, |h, _| h.controller.is_some())
            && panel.read_with(cx, |p, _| p.is_settled())
    });

    // 1. Hand the comment to Agent with an extra note.
    let conv_1 = cx.update(|_, cx| {
        review_agent::dispatch(
            CommentAgentRequest {
                book_id: fixture.book.to_string(),
                book_name: "测试书".into(),
                comment_id: fixture.comment_id.clone(),
                existing_conversation: None,
                header: "批注 · 林晚 · 设定 · 年龄".into(),
                quote: Some("二十七".into()),
                body: "第一章说她二十五，统一一下。".into(),
                extra_note: "顺便看看第三章有没有写她的生日。".into(),
            },
            cx,
        )
        .expect("dispatch succeeds")
    });

    // Immediately running (hollow spinning pinwheel).
    assert_eq!(
        cx.update(|_, cx| review_agent::pinwheel_state(fixture.book.as_str(), &conv_1, cx)),
        ConversationPinwheel::Running
    );

    // Wait until `agent_conversation` is linked on the comment and the run is streaming.
    wait(cx, "agent_conversation linked", |_| {
        fixture.comment()["agent_conversation"].as_str() == Some(conv_1.as_str())
    });

    // Let turn 1 finish: pinwheel becomes UnviewedDone, comment stays open!
    finish_1.send(()).unwrap();
    wait(cx, "turn 1 UnviewedDone", |cx| {
        cx.update(|_, cx| review_agent::pinwheel_state(fixture.book.as_str(), &conv_1, cx))
            == ConversationPinwheel::UnviewedDone
    });
    assert_eq!(fixture.comment()["status"].as_str(), Some("open"));

    // 2. Click the stopped pinwheel -> opens conversation, marks viewed (Hidden), sets ReturnToReview.
    cx.update(|_, cx| {
        review_agent::request_open_conversation(
            CompanionFocusRequest {
                book_id: fixture.book.to_string(),
                conversation_id: conv_1.clone(),
                comment_id: fixture.comment_id.clone(),
                return_title: "林晚 · 设定 · 年龄".into(),
            },
            cx,
        );
    });
    wait(cx, "panel opened conversation 1", |cx| {
        panel.read_with(cx, |p, _| {
            p.return_to_review()
                .is_some_and(|r| r.title == "林晚 · 设定 · 年龄")
                && p.snapshot().is_some_and(|s| {
                    s.conversation.as_str() == conv_1
                        && s.runs.len() == 1
                        && s.runs[0].state == State::Completed
                })
        })
    });
    assert_eq!(
        cx.update(|_, cx| review_agent::pinwheel_state(fixture.book.as_str(), &conv_1, cx)),
        ConversationPinwheel::Hidden
    );

    // 3. Return to Review (`回审阅`) clears return_to_review on the panel.
    cx.update(|window, cx| {
        panel.update(cx, |p, cx| p.back_to_review(window, cx));
    });
    assert!(panel.read_with(cx, |p, _| p.return_to_review().is_none()));

    // 4. Hand the same comment to Agent again (no extra note): reuses the same conversation!
    let conv_2 = cx.update(|_, cx| {
        review_agent::dispatch(
            CommentAgentRequest {
                book_id: fixture.book.to_string(),
                book_name: "测试书".into(),
                comment_id: fixture.comment_id.clone(),
                existing_conversation: Some(conv_1.clone()),
                header: "批注 · 林晚 · 设定 · 年龄".into(),
                quote: Some("二十七".into()),
                body: "第一章说她二十五，统一一下。".into(),
                extra_note: String::new(),
            },
            cx,
        )
        .expect("second dispatch succeeds")
    });
    assert_eq!(conv_2, conv_1);
    assert_eq!(
        cx.update(|_, cx| review_agent::pinwheel_state(fixture.book.as_str(), &conv_1, cx)),
        ConversationPinwheel::Running
    );

    finish_2.send(()).unwrap();
    wait(cx, "turn 2 UnviewedDone", |cx| {
        cx.update(|_, cx| review_agent::pinwheel_state(fixture.book.as_str(), &conv_1, cx))
            == ConversationPinwheel::UnviewedDone
            && panel.read_with(cx, |p, _| {
                p.snapshot()
                    .is_some_and(|s| s.runs.len() == 2 && s.runs[1].state == State::Completed)
            })
    });
    assert_eq!(fixture.comment()["status"].as_str(), Some("open"));

    let close = hub.update(cx, |h, cx| h.prepare_close(cx));
    block_on(close).unwrap();
    cx.run_until_parked();
    fixture.ws.close();
}
