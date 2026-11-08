//! Real shell surfaces deliver close notifications and identify their cached
//! Agent body, including when another pane still shows a different body.

use std::{cell::RefCell, rc::Rc, sync::Arc, time::Duration};

use dr_agent::driver::scripted::ScriptedDriver;
use dr_agent_providers::{
    Endpoints, HttpClient, ProviderDriver, RetryPolicy, credentials::Credentials,
    oauth::OAuthEndpoints,
};
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace,
    panes::PaneId,
    settings::{self, panel::PanelEvent},
    workspace::RightTab,
};
use dr_testkit::seed::{self, Preset};
use dr_view_agent::{AgentViews, panel::AgentPanel, tools::CompanionTools};
use dr_workspace::Workspace;
use gpui::{Entity, TestAppContext, VisualTestContext, px, size};

struct Fixture {
    ws: Workspace,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn open(cx: &mut TestAppContext) -> (Self, Entity<ShellWorkspace>, &mut VisualTestContext) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m31-visibility-test").unwrap();
        let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(ws.library()).unwrap();
        let mut settings = SettingsFile::in_memory();
        settings.set_last_book(seeded.books[0].book_id().as_str());
        cx.update(|cx| {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "m31-visibility-test",
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
            let local = "http://127.0.0.1:9";
            let provider = ProviderDriver::with_endpoints(
                HttpClient::new().unwrap(),
                Credentials::new(Arc::new(dr_platform::SecretStore::in_memory())),
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
                Arc::new(ScriptedDriver::new(vec![])),
                Arc::new(CompanionTools::default()),
                cx,
            );
            let connections = cx.global::<AgentViews>().connections.clone();
            connections.update(cx, |connections, _| {
                for provider in dr_view_agent::connection::PROVIDERS {
                    connections.set_catalog_endpoint(provider, format!("{local}/models"));
                }
            });
        });
        let (shell, cx) = cx.add_window_view(ShellWorkspace::new);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            draw(cx);
            if shell.read_with(cx, |shell, _| !shell.book.is_empty() && !shell.covered()) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "book did not open");
            std::thread::sleep(Duration::from_millis(2));
        }
        (Self { ws, _dir: dir }, shell, cx)
    }

    fn close(self, cx: &mut VisualTestContext) {
        let hub = cx.update(|_, cx| cx.global::<AgentViews>().hub.clone());
        let closing = hub.update(cx, |hub, cx| hub.prepare_close(cx));
        futures::executor::block_on(closing).unwrap();
        cx.run_until_parked();
        self.ws.close();
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

#[gpui::test]
fn settings_escape_dismiss_and_panel_close_notify_only_the_owning_window(cx: &mut TestAppContext) {
    let (fixture, shell, cx) = Fixture::open(cx);
    let closed = Rc::new(RefCell::new(Vec::new()));
    let observed = closed.clone();
    cx.update(|_, cx| {
        settings::on_panel_closed(cx, move |window, _| observed.borrow_mut().push(window));
    });
    let first_id = cx.update(|window, _| window.window_handle().window_id());
    let other_window = cx.add_window(ShellWorkspace::new);
    let other = other_window.root(cx).unwrap();
    let other_id = other_window.window_id();
    assert_ne!(first_id, other_id);
    shell.update_in(cx, |shell, window, cx| {
        shell.open_settings(window, cx);
        // Route Escape through the workspace's real keymap/dismiss path;
        // the search field has its own PanelEvent::Close path below.
        shell.focus_handle().focus(window, cx);
    });
    other_window
        .update(cx, |shell, window, cx| shell.open_settings(window, cx))
        .unwrap();
    draw(cx);
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(shell.read_with(cx, |shell, _| shell.settings.is_none()));
    assert!(other.read_with(cx, |shell, _| shell.settings.is_some()));
    assert_eq!(*closed.borrow(), vec![first_id]);

    shell.update_in(cx, |shell, window, cx| shell.open_settings(window, cx));
    other_window
        .update(cx, |shell, window, cx| assert!(shell.dismiss(window, cx)))
        .unwrap();
    cx.run_until_parked();
    assert!(shell.read_with(cx, |shell, _| shell.settings.is_some()));
    assert!(other.read_with(cx, |shell, _| shell.settings.is_none()));
    assert_eq!(*closed.borrow(), vec![first_id, other_id]);

    // The panel remains retained here: its actual subscription, rather than
    // entity release, must deliver the same owning-window notification.
    let panel = shell.read_with(cx, |shell, _| shell.settings.clone().unwrap());
    panel.update(cx, |_, cx| cx.emit(PanelEvent::Close));
    cx.run_until_parked();
    assert!(shell.read_with(cx, |shell, _| shell.settings.is_none()));
    assert_eq!(*closed.borrow(), vec![first_id, other_id, first_id]);
    shell.update_in(cx, |shell, window, cx| assert!(!shell.dismiss(window, cx)));
    assert_eq!(
        closed.borrow().len(),
        3,
        "an already closed panel emits nothing"
    );
    fixture.close(cx);
}

fn panels(cx: &mut VisualTestContext) -> Vec<Entity<AgentPanel>> {
    cx.update(|_, cx| dr_view_agent::panels(cx))
}

fn visible(
    shell: &Entity<ShellWorkspace>,
    panel: &Entity<AgentPanel>,
    cx: &VisualTestContext,
) -> bool {
    shell.read_with(cx, |shell, _| shell.companion_visible(panel.entity_id()))
}

#[gpui::test]
fn cached_agent_bodies_follow_their_pane_and_settings_cover(cx: &mut TestAppContext) {
    let (fixture, shell, cx) = Fixture::open(cx);
    cx.simulate_resize(size(px(2400.0), px(1100.0)));
    shell.update_in(cx, |shell, window, cx| {
        if shell.left.open {
            shell.toggle_left(window, cx);
        }
        if !shell.right.open {
            shell.toggle_right(window, cx);
        }
        shell.right.reveal.set(1.0);
        shell
            .right
            .panes
            .click(PaneId::Primary, RightTab::Companion);
        cx.notify();
    });
    draw(cx);
    draw(cx);
    assert_eq!(panels(cx).len(), 1);
    let first = panels(cx).remove(0);
    assert!(visible(&shell, &first, cx));

    shell.update(cx, |shell, cx| {
        shell.right.panes.click(PaneId::Primary, RightTab::Review);
        // Let the real shell sizing code split the sidebar on the next frame.
        shell.right.width = 1200.0;
        cx.notify();
    });
    draw(cx);
    assert!(shell.read_with(cx, |shell, _| shell.right.panes.is_split()));
    assert!(!visible(&shell, &first, cx));
    shell.update(cx, |shell, cx| {
        shell
            .right
            .panes
            .click(PaneId::Secondary, RightTab::Companion);
        cx.notify();
    });
    draw(cx);
    draw(cx);
    assert_eq!(panels(cx).len(), 2);
    let second = panels(cx)
        .into_iter()
        .find(|panel| panel.entity_id() != first.entity_id())
        .unwrap();
    assert!(
        !visible(&shell, &first, cx),
        "another pane is not this body"
    );
    assert!(visible(&shell, &second, cx));

    shell.update(cx, |shell, cx| {
        shell
            .right
            .panes
            .click(PaneId::Primary, RightTab::Companion);
        cx.notify();
    });
    draw(cx);
    assert!(visible(&shell, &first, cx));
    assert!(visible(&shell, &second, cx));

    let changes = Rc::new(RefCell::new(Vec::new()));
    let notifications = changes.clone();
    let second_id = second.entity_id();
    let _visibility = cx.update(|_, cx| {
        cx.observe(&shell, move |shell, cx| {
            let shell = shell.read(cx);
            notifications.borrow_mut().push((
                shell.right.panes.is_split(),
                shell.companion_visible(second_id),
            ));
        })
    });
    // No direct pane edit or notify: real viewport sizing must tell cached
    // bodies that the unfocused half disappeared, so owned work can cancel.
    cx.simulate_resize(size(px(700.0), px(800.0)));
    draw(cx);
    draw(cx);
    assert!(!shell.read_with(cx, |shell, _| shell.right.panes.is_split()));
    assert!(visible(&shell, &first, cx));
    assert!(!visible(&shell, &second, cx));
    assert!(
        changes.borrow().contains(&(false, false)),
        "resizing must notify observers after the cached body becomes hidden"
    );
    cx.simulate_resize(size(px(2400.0), px(1100.0)));
    shell.update(cx, |shell, cx| {
        shell.right.width = 1200.0;
        cx.notify();
    });
    draw(cx);
    shell.update(cx, |shell, cx| {
        shell
            .right
            .panes
            .click(PaneId::Secondary, RightTab::Companion);
        cx.notify();
    });
    draw(cx);
    assert!(visible(&shell, &first, cx));
    assert!(visible(&shell, &second, cx));
    shell.update(cx, |shell, cx| {
        assert!(
            shell
                .right
                .panes
                .click(PaneId::Primary, RightTab::Companion)
        );
        cx.notify();
    });
    draw(cx);
    assert!(!visible(&shell, &first, cx));
    assert!(visible(&shell, &second, cx));

    shell.update_in(cx, |shell, window, cx| shell.toggle_right(window, cx));
    draw(cx);
    assert!(!visible(&shell, &second, cx));
    shell.update_in(cx, |shell, window, cx| shell.toggle_right(window, cx));
    draw(cx);
    assert!(visible(&shell, &second, cx));
    shell.update_in(cx, |shell, window, cx| shell.open_settings(window, cx));
    draw(cx);
    assert!(!visible(&shell, &first, cx));
    assert!(!visible(&shell, &second, cx));
    shell.update_in(cx, |shell, window, cx| assert!(shell.dismiss(window, cx)));
    draw(cx);
    assert!(!visible(&shell, &first, cx));
    assert!(visible(&shell, &second, cx));
    assert_eq!(panels(cx).len(), 2, "reopening reuses both cached bodies");
    fixture.close(cx);
}
