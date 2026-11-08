//! First-turn metadata receipts must reveal the changed object, not the book
//! document which stores it. All text comes from the shared tiny seed.

use std::{
    sync::Arc,
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
use dr_editor::decor::ReviewFocus;
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace,
    nav::{Open, Target},
};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{connection::PROVIDERS, onboarding, panel::AgentPanel, tools::CompanionTools};
use dr_workspace::{Actor, Workspace};
use futures::executor::block_on;
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    chapter: String,
    element: String,
    words: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m31-navigation-test").unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let words = seeded.books[0]
            .groups()
            .values()
            .flatten()
            .find(|text| text.chars().count() >= 16)
            .unwrap()
            .chars()
            .take(16)
            .collect();
        seeded.write_to(ws.library()).unwrap();
        let chapter = ws
            .call(&Actor::User, "chapter.list", json!({"book":book}))
            .unwrap()["output"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let element = ws
            .call(&Actor::User, "element.list", json!({"book":book}))
            .unwrap()["output"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            _dir: dir,
            ws,
            book,
            chapter,
            element,
            words,
        }
    }
}

fn tool(id: &str, name: &str, arguments: Value) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::ToolCall(ToolCall {
            id: id.into(),
            name: "call_tool".into(),
            arguments: json!({"name":name,"arguments":arguments}),
        })),
        Step::Event(DriverEvent::Finish(FinishReason::Tools)),
    ]
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
        assert!(
            Instant::now() < deadline,
            "metadata navigation did not settle"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    fixture: &Fixture,
    mut rounds: Vec<Vec<Step>>,
) -> (
    Entity<ShellWorkspace>,
    Entity<AgentPanel>,
    &'a mut VisualTestContext,
) {
    cx.executor().allow_parking();
    rounds.push(vec![
        Step::Event(DriverEvent::TextDelta {
            index: 0,
            text: fixture.words.clone(),
        }),
        Step::Event(DriverEvent::Finish(FinishReason::Complete)),
    ]);
    let (hub, connections) = cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(&fixture.book);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "m31-navigation-test",
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
        let local = "http://127.0.0.1:9";
        let provider = ProviderDriver::with_endpoints(
            HttpClient::new().unwrap(),
            Credentials::candidate(dr_agent::Provider::Deepseek, "synthetic-navigation-key")
                .unwrap(),
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
        );
        dr_view_agent::init_with(
            provider,
            Arc::new(ScriptedDriver::new(rounds)),
            Arc::new(CompanionTools::default()),
            cx,
        );
        let views = cx.global::<dr_view_agent::AgentViews>();
        let (hub, connections) = (views.hub.clone(), views.connections.clone());
        for provider in PROVIDERS {
            connections.update(cx, |connections, _| {
                connections.set_catalog_endpoint(provider, format!("{local}/models"))
            });
        }
        onboarding::note(cx, onboarding::Event::Reset);
        (hub, connections)
    });
    let shell = cx.add_window(ShellWorkspace::new).root(cx).unwrap();
    let weak = shell.downgrade();
    let (view_hub, view_connections) = (hub.clone(), connections.clone());
    let (panel, cx) = cx.add_window_view(move |window, cx| {
        AgentPanel::new(weak, view_hub, view_connections, window, cx)
    });
    cx.simulate_resize(size(px(1000.), px(1400.)));
    wait(cx, |cx| {
        shell.read_with(cx, |shell, _| {
            shell.book_id == fixture.book && !shell.book.is_empty()
        }) && connections.read_with(cx, |connections, _| connections.usable() == Some(true))
            && hub.read_with(cx, |hub, _| hub.controller.is_some())
            && panel.read_with(cx, |panel, _| panel.is_settled())
    });
    shell.update(cx, |shell, cx| {
        shell.open(
            Target::Chapter(fixture.chapter.parse().unwrap()),
            Open::KEEP,
            cx,
        )
    });
    let composer = panel.read_with(cx, |panel, _| panel.composer());
    composer.update(cx, |field, cx| field.set_text(&fixture.words, cx));
    panel.update(cx, |panel, cx| panel.send(cx));
    wait(cx, |cx| {
        panel.read_with(cx, |panel, _| {
            panel.snapshot().is_some_and(|snapshot| {
                snapshot
                    .runs
                    .first()
                    .is_some_and(|run| run.state == State::Completed)
            })
        })
    });
    assert_eq!(
        cx.update(|_, cx| onboarding::step(cx)),
        onboarding::Step::Change
    );
    (shell, panel, cx)
}

fn changed(panel: &Entity<AgentPanel>, key: &str, cx: &mut VisualTestContext) -> String {
    let session = panel.read_with(cx, |panel, _| {
        let run = &panel.snapshot().unwrap().runs[0];
        assert!(!run.changes.is_empty());
        assert!(
            run.changes
                .iter()
                .all(|change| change.receipt.document.starts_with("book:")),
            "this must remain a metadata-only regression"
        );
        run.session.clone()
    });
    let id = format!("agent-change-{session}-1-{key}");
    assert!(
        cx.debug_bounds(Box::leak(
            format!("agent-history-{session}-1-{key}").into_boxed_str()
        ))
        .is_none(),
        "metadata has no prose-history button"
    );
    id
}

fn click(id: &str, cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx
        .debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .expect("changed object button");
    cx.simulate_click(bounds.center(), Modifiers::none());
}

fn close(fixture: &Fixture, cx: &mut VisualTestContext) {
    let hub = cx.update(|_, cx| cx.global::<dr_view_agent::AgentViews>().hub.clone());
    block_on(hub.update(cx, |hub, cx| hub.prepare_close(cx))).unwrap();
    fixture.ws.close();
}

#[gpui::test]
fn first_book_metadata_change_opens_home_without_prose_history(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let rounds = vec![
        tool("read", "book.get", json!({"book":fixture.book})),
        tool(
            "write",
            "book.update",
            json!({"book":fixture.book,"name":fixture.words}),
        ),
    ];
    let (shell, panel, cx) = open(cx, &fixture, rounds);
    let id = changed(&panel, &format!("book:{}", fixture.book), cx);
    click(&id, cx);
    wait(cx, |cx| {
        cx.update(|_, cx| onboarding::step(cx)) == onboarding::Step::Done
    });
    assert!(shell.read_with(cx, |shell, _| shell.nav.current().is_none()));
    assert!(shell.read_with(cx, |shell, _| shell.history.is_none()));
    close(&fixture, cx);
}

#[gpui::test]
fn first_element_metadata_change_opens_the_element_without_prose_history(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let rounds = vec![
        tool("read", "element.list", json!({"book":fixture.book})),
        tool(
            "write",
            "element.update",
            json!({"book":fixture.book,"id":fixture.element,"summary":fixture.words}),
        ),
    ];
    let (shell, panel, cx) = open(cx, &fixture, rounds);
    let id = changed(&panel, &format!("element:{}", fixture.element), cx);
    click(&id, cx);
    wait(cx, |cx| {
        cx.update(|_, cx| onboarding::step(cx)) == onboarding::Step::Done
    });
    assert_eq!(
        shell.read_with(cx, |shell, _| shell.nav.current().cloned()),
        Some(Target::Element(fixture.element.parse().unwrap()))
    );
    assert!(shell.read_with(cx, |shell, _| shell.history.is_none()));
    close(&fixture, cx);
}

#[gpui::test]
fn a_changed_object_deleted_before_inspection_does_not_complete_the_guide(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let rounds = vec![
        tool("read", "element.list", json!({"book":fixture.book})),
        tool(
            "write",
            "element.update",
            json!({"book":fixture.book,"id":fixture.element,"summary":fixture.words}),
        ),
    ];
    let (shell, panel, cx) = open(cx, &fixture, rounds);
    let id = changed(&panel, &format!("element:{}", fixture.element), cx);
    fixture
        .ws
        .call(
            &Actor::User,
            "element.trash",
            json!({"book":fixture.book,"id":fixture.element}),
        )
        .unwrap();
    wait(cx, |cx| {
        shell.read_with(cx, |shell, _| {
            shell
                .book
                .entry(&Target::Element(fixture.element.parse().unwrap()))
                .is_none()
        })
    });
    click(&id, cx);
    wait(cx, |cx| panel.read_with(cx, |panel, _| panel.is_settled()));
    assert_eq!(
        cx.update(|_, cx| onboarding::step(cx)),
        onboarding::Step::Change
    );
    assert!(shell.read_with(cx, |shell, _| shell.history.is_none()));
    close(&fixture, cx);
}

#[gpui::test]
fn a_comment_receipt_reveals_its_actual_chapter_and_review_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let rounds = vec![
        tool("chapters", "chapter.list", json!({"book":fixture.book})),
        tool("comments", "comment.list", json!({"book":fixture.book})),
        tool(
            "write",
            "comment.create",
            json!({"book":fixture.book,"target":{"kind":"node","id":fixture.chapter},"body":fixture.words}),
        ),
    ];
    let (shell, panel, cx) = open(cx, &fixture, rounds);
    let comment = panel.read_with(cx, |panel, _| {
        panel.snapshot().unwrap().runs[0]
            .tools
            .iter()
            .find_map(|tool| {
                tool.result.as_ref()?.output["effects"]
                    .as_array()?
                    .iter()
                    .find(|effect| effect["kind"] == "comment")?["id"]
                    .as_str()
                    .map(str::to_owned)
            })
            .unwrap()
    });
    let id = changed(&panel, &format!("comment:{comment}"), cx);
    click(&id, cx);
    wait(cx, |cx| {
        cx.update(|_, cx| onboarding::step(cx)) == onboarding::Step::Done
    });
    assert_eq!(
        shell.read_with(cx, |shell, _| shell.nav.current().cloned()),
        Some(Target::Chapter(fixture.chapter.parse().unwrap()))
    );
    assert_eq!(
        cx.update(|_, cx| ReviewFocus::get(cx).jump.unwrap().comment),
        comment
    );
    assert_eq!(
        shell.read_with(cx, |shell, _| shell.right.panes.focused_tab()),
        dr_shell::workspace::RightTab::Review
    );
    close(&fixture, cx);
}
