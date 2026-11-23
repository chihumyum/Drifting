//! CM3's 「打开工作台」 card (`custom-modules.md` §8 entrances 1 and 2): a
//! scripted model makes a module with the Agent's tool (`custom_module.create`,
//! CM4b); the tool's result names it (`custom_modules`) and the conversation
//! shows a card with its name, 「我的模块」 and 「打开工作台」, which opens the
//! module's workbench as a pill of the project. No network, a synthetic
//! credential, loopback endpoints.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::{
    DriverEvent, FinishReason, ToolCall,
    driver::scripted::{ScriptedDriver, Step},
};
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_model::id::BookId;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace, nav::Target};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{
    connection::{Connections, PROVIDERS},
    hub::AgentHub,
    panel::AgentPanel,
    tools::CompanionTools,
};
use dr_workspace::{Actor, Workspace};
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

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

fn wait(
    cx: &mut VisualTestContext,
    what: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn bounds(cx: &mut VisualTestContext, selector: &str) -> Option<gpui::Bounds<gpui::Pixels>> {
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    cx.debug_bounds(selector)
}

#[gpui::test]
fn a_module_the_agent_made_has_a_card_that_opens_its_workbench(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "cm3-card-test").unwrap();
    ws.set_auto_links(false);
    let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book: BookId = seeded.books[0].book_id().clone();
    seeded.write_to(ws.library()).unwrap();
    let mut module: Value = serde_json::from_str(dr_testkit::samples::MODULE_FILES[0].1).unwrap();
    module.as_object_mut().unwrap().remove("credit");
    let driver = Arc::new(ScriptedDriver::new(vec![
        vec![
            Step::Event(DriverEvent::ToolCall(ToolCall {
                id: "make".into(),
                name: "call_tool".into(),
                arguments: json!({"name": "custom_module.create", "arguments": {"value": module}}),
            })),
            Step::Event(DriverEvent::Finish(FinishReason::Tools)),
        ],
        vec![
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: "做好了。".into(),
            }),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
    ]));
    cx.executor().allow_parking();
    let (hub, connections) = cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(book.as_str());
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "cm3-card-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(ws.clone()),
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
    let shell: Entity<ShellWorkspace> = shell_window.root(cx).unwrap();
    let (weak, view_hub, view_connections) = (shell.downgrade(), hub.clone(), connections.clone());
    let (panel, cx) = cx.add_window_view(move |window, cx| {
        AgentPanel::new(weak, view_hub, view_connections, window, cx)
    });
    let _keep: (Entity<AgentHub>, Entity<Connections>) = (hub.clone(), connections.clone());
    wait(cx, "the panel", |cx| {
        shell.read_with(cx, |ws, _| {
            ws.book_id == book.as_str() && !ws.book.is_empty()
        }) && connections.read_with(cx, |c, _| c.usable() == Some(true))
            && hub.read_with(cx, |h, _| h.controller.is_some())
            && panel.read_with(cx, |p, _| p.is_settled())
    });
    let composer = panel.read_with(cx, |p, _| p.composer());
    composer.update(cx, |c, cx| c.set_text("做一个伏笔追踪的模块", cx));
    panel.update(cx, |p, cx| p.send(cx));
    wait(cx, "the module made", |_| {
        ws.call(&Actor::User, "custom_module.list", json!({}))
            .unwrap()["output"]
            .as_array()
            .is_some_and(|l| l.len() == 1)
    });
    let id = ws
        .call(&Actor::User, "custom_module.list", json!({}))
        .unwrap()["output"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let card = format!("agent-module-card-{id}");
    let open = format!("agent-open-bench-{id}");
    wait(cx, "the card", |cx| bounds(cx, &card).is_some());
    let at = bounds(cx, &open).expect("打开工作台").center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    cx.simulate_click(at, Modifiers::none());
    wait(cx, "the workbench's pill", |cx| {
        shell.read_with(cx, |ws, _| ws.nav.current().cloned())
            == Some(Target::Module(id.parse().unwrap()))
    });
}
