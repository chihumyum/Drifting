//! M31: the Agent companion and its library-scoped runtime.

pub mod connection;
pub mod connection_view;
pub mod controller;
mod data;
pub mod hub;
pub mod onboarding;
pub mod panel;
mod prompt;
pub mod settings;
pub mod state;
pub mod tools;

use dr_agent::{Driver, ToolExecutor};
use dr_agent_providers::{HttpClient, ProviderDriver, credentials::Credentials};
use futures::FutureExt as _;
use gpui::{App, AppContext as _, Entity, Global, KeyBinding, WeakEntity};
use std::sync::Arc;

use connection::Connections;
use hub::AgentHub;
use panel::{AgentPanel, PanelHead};

pub struct AgentViews {
    pub connections: Entity<Connections>,
    pub hub: Entity<AgentHub>,
    panels: Vec<WeakEntity<AgentPanel>>,
}
impl Global for AgentViews {}

pub fn panels(cx: &App) -> Vec<Entity<AgentPanel>> {
    cx.try_global::<AgentViews>()
        .map(|views| {
            views
                .panels
                .iter()
                .filter_map(WeakEntity::upgrade)
                .collect()
        })
        .unwrap_or_default()
}

/// Production initialization uses F7's complete identity, including the
/// isolated worktree/profile keychain service. No credential reaches settings.
pub fn init(identity: &dr_platform::Identity, cx: &mut App) {
    let http = match HttpClient::new() {
        Ok(http) => http,
        Err(error) => {
            log::error!("Agent HTTP initialization: {error}");
            return;
        }
    };
    let credentials = Credentials::new(Arc::new(dr_platform::secrets::SecretStore::for_identity(
        identity,
    )));
    let provider = ProviderDriver::new(http, credentials);
    init_with(
        provider.clone(),
        Arc::new(provider),
        Arc::new(tools::CompanionTools::default()),
        cx,
    );
}

/// Injection seam for synthetic desktop acceptance and later runtime tool
/// composition. Every path still goes through one controller and Runtime.
pub fn init_with(
    provider: ProviderDriver,
    driver: Arc<dyn Driver>,
    tools: Arc<dyn ToolExecutor>,
    cx: &mut App,
) {
    init_with_service(
        connection::ConnectionService::new(provider),
        driver,
        tools,
        cx,
    );
}

pub fn init_with_service(
    service: connection::ConnectionService,
    driver: Arc<dyn Driver>,
    tools: Arc<dyn ToolExecutor>,
    cx: &mut App,
) {
    let connections = cx.new(|cx| Connections::with_service(service, cx));
    let hub = cx.new(|_| AgentHub::new(driver, tools));
    cx.set_global(AgentViews {
        connections: connections.clone(),
        hub: hub.clone(),
        panels: Vec::new(),
    });
    let weak = connections.downgrade();
    dr_shell::release::before_release(cx, move |cx| {
        weak.upgrade()
            .map(|connections| {
                connections
                    .update(cx, |connections, cx| connections.prepare_release(cx))
                    .boxed_local()
            })
            .unwrap_or_else(|| async { Ok(()) }.boxed_local())
    });
    settings::init(connections, cx);
    hub::install(&hub, cx);
    dr_shell::keymap::add_bindings(cx, || {
        vec![KeyBinding::new(
            "enter",
            dr_ui::input::field::Submit,
            Some("DrAgentComposer > DrTextArea"),
        )]
    });
    dr_shell::pages::set_companion(cx, |ws, window, cx| {
        let views = cx.global::<AgentViews>();
        let (hub, connections) = (views.hub.clone(), views.connections.clone());
        let body = cx.new(|cx| AgentPanel::new(ws, hub, connections, window, cx));
        let head = cx.new(|_| PanelHead::new(body.clone()));
        let views = cx.global_mut::<AgentViews>();
        views.panels.retain(|panel| panel.upgrade().is_some());
        views.panels.push(body.downgrade());
        dr_shell::pages::LeftPanel {
            head: head.into(),
            body: body.into(),
        }
    });
}
