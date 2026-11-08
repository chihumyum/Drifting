use super::*;
use dr_mcp::{Client, ConnectionDescription, GrantInfo};
use gpui::{ClipboardItem, Focusable as _};
use keys::settings::agent::mcp_access as k;

fn client_name(client: Client) -> &'static str {
    match client {
        Client::Codex => "Codex",
        Client::ClaudeCode => "Claude Code",
        Client::Antigravity => "Antigravity",
    }
}

/// Executable and connection-file reference only; never the token.
pub fn manual_configuration(connection: &ConnectionDescription) -> Result<String, String> {
    serde_json::to_string_pretty(&serde_json::json!({"mcpServers":{"drifting":connection.config}}))
        .map_err(|_| "MCP configuration could not be encoded".into())
}

pub struct AccessView {
    service: Entity<McpService>,
    name: Entity<TextField>,
    manual: bool,
    selected: Option<String>,
    busy: bool,
    message: Option<String>,
    _subscriptions: Vec<Subscription>,
}
impl AccessView {
    pub fn new(service: Entity<McpService>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| {
            TextField::new("mcp-connection-name", window, cx).placeholder(t(cx, k::NAME))
        });
        let service_changed = cx.observe(&service, |_, _, cx| cx.notify());
        let input_changed = cx.observe(&name, |_, _, cx| cx.notify());
        Self {
            service,
            name,
            manual: false,
            selected: None,
            busy: false,
            message: None,
            _subscriptions: vec![service_changed, input_changed],
        }
    }
    pub(super) fn close(&mut self, cx: &mut Context<Self>) {
        self.name.update(cx, |field, cx| field.set_text("", cx));
        self.manual = false;
        self.selected = None;
        cx.notify();
    }
    fn blocked(&self, cx: &App) -> bool {
        self.busy || self.service.read(cx).is_busy() || dr_shell::release::is_releasing(cx)
    }
    fn finish<T: Send + 'static>(
        &mut self,
        future: BoxFuture<'static, Result<T, String>>,
        success: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        self.busy = true;
        self.message = None;
        self.name
            .update(cx, |field, cx| field.set_disabled(true, cx));
        // The operation has entered its owner's queue before this waiter starts.
        let task = cx.background_executor().spawn(future);
        let service = self.service.clone();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            service.update(cx, |_, cx| cx.notify());
            let _ = this.update(cx, |view, cx| {
                view.busy = false;
                view.name
                    .update(cx, |field, cx| field.set_disabled(false, cx));
                match result {
                    Ok(value) => success(view, value, cx),
                    Err(error) => view.message = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub fn connect(&mut self, client: Client, cx: &mut Context<Self>) {
        if self.blocked(cx) {
            return;
        }
        let Some(store) = self.service.read(cx).grants() else {
            return;
        };
        self.finish(
            store.connect(client, client_name(client)),
            move |view, result, cx| {
                view.message = Some(
                    tf(
                        cx,
                        if result.leftover {
                            k::INSTALLED_LEFTOVER
                        } else {
                            k::INSTALLED
                        },
                        &[("client", &client_name(client))],
                    )
                    .to_string(),
                );
            },
            cx,
        );
    }
    pub fn create_manual(&mut self, cx: &mut Context<Self>) {
        if self.blocked(cx) {
            return;
        }
        let Some(store) = self.service.read(cx).grants() else {
            return;
        };
        let name = self.name.read(cx).text();
        if name.trim().is_empty() {
            return;
        }
        self.finish(
            store.create_manual(name.trim()),
            |view, connection, cx| {
                view.name.update(cx, |field, cx| field.set_text("", cx));
                view.selected = Some(connection.grant.id);
            },
            cx,
        );
    }
    pub fn revoke(&mut self, id: String, cx: &mut Context<Self>) {
        if self.blocked(cx) {
            return;
        }
        let Some(store) = self.service.read(cx).grants() else {
            return;
        };
        self.finish(
            store.revoke(&id),
            move |view, result, cx| {
                if view.selected.as_deref() == Some(&id) {
                    view.selected = None;
                }
                view.message = Some(
                    t(
                        cx,
                        if result.leftover {
                            k::REVOKED_WARNING
                        } else {
                            k::REVOKED
                        },
                    )
                    .to_string(),
                );
            },
            cx,
        );
    }
    fn connection(
        &self,
        grant: &GrantInfo,
        blocked: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.0))
            .child(div().flex_1().min_w_0().child(grant.name.clone()));
        if let Some(installation) = &grant.installation {
            let entity = cx.entity();
            let client = installation.client;
            row = row.child(
                Button::new(format!("mcp-reconfigure-{}", grant.id), t(cx, k::REINSTALL))
                    .small()
                    .disabled(blocked)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |view, cx| view.connect(client, cx))
                    })
                    .mark(format!("mcp-reconfigure-{}", grant.id)),
            );
        }
        let entity = cx.entity();
        let id = grant.id.clone();
        row = row.child(
            Button::new(format!("mcp-config-{}", grant.id), t(cx, k::CONFIG))
                .small()
                .on_click(move |_, _, cx| {
                    entity.update(cx, |view, cx| {
                        view.selected = (view.selected.as_ref() != Some(&id)).then(|| id.clone());
                        cx.notify();
                    })
                })
                .mark(format!("mcp-config-{}", grant.id)),
        );
        let entity = cx.entity();
        let id = grant.id.clone();
        row = row.child(
            Button::new(format!("mcp-revoke-{}", grant.id), t(cx, k::REVOKE))
                .small()
                .danger()
                .disabled(blocked)
                .on_click(move |_, _, cx| entity.update(cx, |view, cx| view.revoke(id.clone(), cx)))
                .mark(format!("mcp-revoke-{}", grant.id)),
        );
        let mut col = div().flex().flex_col().gap(px(6.0)).child(row);
        if self.selected.as_deref() == Some(&grant.id) {
            let config = self
                .service
                .read(cx)
                .grants()
                .and_then(|store| store.describe(&grant.id).ok())
                .and_then(|connection| manual_configuration(&connection).ok());
            if let Some(config) = config {
                col = col.child(
                    note(config.clone(), window, cx)
                        .font_role(Role::Index)
                        .text_size(px(12.0)),
                );
                let entity = cx.entity();
                col = col.child(
                    Button::new(format!("mcp-copy-{}", grant.id), t(cx, k::COPY))
                        .small()
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(config.clone()));
                            entity.update(cx, |view, cx| {
                                view.message = Some(t(cx, k::COPIED).to_string());
                                cx.notify();
                            });
                        })
                        .mark(format!("mcp-copy-{}", grant.id)),
                );
            }
        }
        col.into_any_element()
    }
}
impl Render for AccessView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let store = self.service.read(cx).grants();
        let blocked = self.blocked(cx) || store.is_none();
        let grants = store.as_ref().map(|store| store.list()).unwrap_or_default();
        let mut col = div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .py(px(12.0))
            .child(heading(k::TITLE, cx))
            .child(note(t(cx, k::DESC), window, cx));
        for client in [Client::Codex, Client::ClaudeCode, Client::Antigravity] {
            let installed: Vec<_> = grants
                .iter()
                .filter(|grant| {
                    grant
                        .installation
                        .as_ref()
                        .is_some_and(|installation| installation.client == client)
                })
                .collect();
            if installed.is_empty() {
                let entity = cx.entity();
                col = col.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(div().flex_1().child(client_name(client)))
                        .child(
                            Button::new(
                                format!("mcp-connect-{client:?}"),
                                t(cx, k::CONNECT_ACTION),
                            )
                            .small()
                            .disabled(blocked)
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |view, cx| view.connect(client, cx))
                            })
                            .mark(format!("mcp-connect-{client:?}")),
                        ),
                );
            } else {
                for grant in installed {
                    col = col.child(self.connection(grant, blocked, window, cx));
                }
            }
        }
        col = col.child(note(t(cx, k::AUTOMATIC), window, cx));
        let entity = cx.entity();
        col = col.child(
            Button::new("mcp-manual", t(cx, k::MANUAL))
                .text()
                .on_click(move |_, window, cx| {
                    entity.update(cx, |view, cx| {
                        view.manual = !view.manual;
                        if view.manual {
                            window.focus(&view.name.focus_handle(cx), cx);
                        }
                        cx.notify();
                    })
                })
                .mark("mcp-manual"),
        );
        if self.manual {
            let entity = cx.entity();
            col = col.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .debug_selector(|| "mcp-connection-name".into())
                            .child(self.name.clone()),
                    )
                    .child(
                        Button::new("mcp-create", t(cx, k::CREATE))
                            .small()
                            .disabled(blocked || self.name.read(cx).text().trim().is_empty())
                            .on_click(move |_, _, cx| {
                                entity.update(cx, |view, cx| view.create_manual(cx))
                            })
                            .mark("mcp-create"),
                    ),
            );
            for grant in grants.iter().filter(|grant| grant.installation.is_none()) {
                col = col.child(self.connection(grant, blocked, window, cx));
            }
        }
        col = col.child(note(t(cx, k::LOCAL), window, cx));
        if let Some(message) = self
            .message
            .as_deref()
            .or_else(|| self.service.read(cx).error())
        {
            col = col.child(note(message.to_owned(), window, cx));
        }
        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_mcp::{ClientPaths, GrantPaths};
    use dr_platform::secrets::SecretStore;
    use dr_shell::{Services, SettingsFile, ShellInfo};
    use gpui::{Modifiers, TestAppContext, VisualTestContext};
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
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
                "MCP settings operation did not settle"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[gpui::test]
    fn native_connection_controls_and_dropped_views_keep_their_queued_disk_work(
        cx: &mut TestAppContext,
    ) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let paths = GrantPaths::new(
            dir.path().join("app/mcp"),
            dir.path().join("writer"),
            ClientPaths::from_home(dir.path().join("home"), None, None),
        )
        .with_socket_root(dir.path().join("sockets"));
        let service = cx.update(|cx| {
            dr_shell::init(
                ShellInfo {
                    app_name: "Synthetic",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
            crate::mcp::init_with(Ok(paths), Arc::new(SecretStore::in_memory()), cx);
            cx.global::<crate::mcp::McpGlobal>().service.clone()
        });
        let (view, cx) =
            cx.add_window_view(|window, cx| AccessView::new(service.clone(), window, cx));
        wait(cx, |cx| {
            service.read_with(cx, |service, _| service.grants().is_some())
        });
        let bounds = cx.debug_bounds("mcp-connect-Codex").unwrap();
        cx.simulate_click(bounds.center(), Modifiers::none());
        wait(cx, |cx| view.read_with(cx, |view, _| !view.busy));
        let store = service.read_with(cx, |service, _| service.grants().unwrap());
        assert_eq!(store.list().len(), 1);
        let codex = store.list()[0].clone();
        assert_eq!(codex.installation.as_ref().unwrap().client, Client::Codex);
        view.update(cx, |view, cx| {
            view.manual = true;
            view.name
                .update(cx, |name, cx| name.set_text("Synthetic manual", cx));
        });
        draw(cx);
        let bounds = cx.debug_bounds("mcp-create").unwrap();
        cx.simulate_click(bounds.center(), Modifiers::none());
        wait(cx, |cx| view.read_with(cx, |view, _| !view.busy));
        let manual = store
            .list()
            .into_iter()
            .find(|grant| grant.installation.is_none())
            .unwrap();
        let description = store.describe(&manual.id).unwrap();
        let config = manual_configuration(&description).unwrap();
        assert!(!config.contains("token"));
        let config: serde_json::Value = serde_json::from_str(&config).unwrap();
        assert_eq!(config["mcpServers"]["drifting"]["args"][0], "--mcp");
        view.update(cx, |view, cx| view.revoke(manual.id.clone(), cx));
        wait(cx, |cx| view.read_with(cx, |view, _| !view.busy));
        assert!(store.describe(&manual.id).is_err());
        view.update_in(cx, |view, window, cx| {
            view.connect(Client::ClaudeCode, cx);
            window.remove_window();
        });
        drop(view);
        futures::executor::block_on(store.drain()).unwrap();
        assert!(store.list().iter().any(|grant| {
            grant
                .installation
                .as_ref()
                .is_some_and(|i| i.client == Client::ClaudeCode)
        }));
        futures::executor::block_on(service.update(cx, |service, cx| service.prepare_close(cx)))
            .unwrap();
    }
}
