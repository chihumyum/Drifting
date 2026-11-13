use super::*;
use dr_mcp::outbound::{
    ConfigValue, Manager, ServerDraft, ServerInfo, Status, TransportConfig, TransportDraft,
};
use dr_ui::{
    components::{Choice, Select},
    input::TextArea,
    sand::Icon,
};
use gpui::Focusable as _;
use keys::settings::agent::extensions as k;

struct SecretRow {
    id: u64,
    name: Entity<TextField>,
    value: Entity<TextField>,
}
struct Editor {
    original: Option<ServerInfo>,
    stdio: bool,
    name: Entity<TextField>,
    command: Entity<TextField>,
    cwd: Entity<TextField>,
    url: Entity<TextField>,
    args: Entity<TextArea>,
    public: Entity<TextArea>,
    secrets: Vec<SecretRow>,
    next_secret: u64,
    _name_changed: Subscription,
}
impl Editor {
    fn new(
        server: Option<ServerInfo>,
        window: &mut Window,
        cx: &mut Context<ExtensionsView>,
    ) -> Self {
        let field = |id: &'static str,
                     text: String,
                     window: &mut Window,
                     cx: &mut Context<ExtensionsView>| {
            cx.new(|cx| TextField::new(id, window, cx).with_text(text))
        };
        let name = field(
            "mcp-server-name",
            server.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
            window,
            cx,
        );
        let changed = cx.observe(&name, |_, _, cx| cx.notify());
        let (stdio, command, args, cwd, url, values) = match server.as_ref().map(|s| &s.transport) {
            Some(TransportConfig::Stdio {
                command,
                args,
                cwd,
                env,
            }) => (
                true,
                command.clone(),
                args.join("\n"),
                cwd.clone().unwrap_or_default(),
                String::new(),
                env.clone(),
            ),
            Some(TransportConfig::Http { url, headers }) => (
                false,
                String::new(),
                String::new(),
                String::new(),
                url.clone(),
                headers.clone(),
            ),
            None => (
                false,
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                Default::default(),
            ),
        };
        let public = values
            .iter()
            .filter_map(|(name, value)| match value {
                ConfigValue::Public(value) => Some(format!("{name}={value}")),
                ConfigValue::Secret { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut editor = Self {
            original: server,
            stdio,
            name,
            command: field("mcp-server-command", command, window, cx),
            cwd: field("mcp-server-cwd", cwd, window, cx),
            url: field("mcp-server-url", url, window, cx),
            args: cx.new(|cx| {
                TextArea::new("mcp-server-args", window, cx)
                    .framed(3.0)
                    .with_text(args)
            }),
            public: cx.new(|cx| {
                TextArea::new("mcp-server-public", window, cx)
                    .framed(3.0)
                    .with_text(public)
            }),
            secrets: Vec::new(),
            next_secret: 0,
            _name_changed: changed,
        };
        for (name, value) in values {
            if matches!(value, ConfigValue::Secret { .. }) {
                editor.add_secret(name, window, cx);
            }
        }
        editor
    }
    fn add_secret(&mut self, name: String, window: &mut Window, cx: &mut Context<ExtensionsView>) {
        let id = self.next_secret;
        self.next_secret += 1;
        self.secrets.push(SecretRow {
            id,
            name: cx.new(|cx| {
                TextField::new(format!("mcp-secret-name-{id}"), window, cx)
                    .mono()
                    .with_text(name)
            }),
            value: cx.new(|cx| {
                TextField::new(format!("mcp-secret-value-{id}"), window, cx)
                    .mono()
                    .secure(true)
            }),
        });
    }
    fn disable(&self, disabled: bool, cx: &mut App) {
        for field in [&self.name, &self.command, &self.cwd, &self.url] {
            field.update(cx, |field, cx| field.set_disabled(disabled, cx));
        }
        for area in [&self.args, &self.public] {
            area.update(cx, |area, cx| area.set_disabled(disabled, cx));
        }
        for row in &self.secrets {
            for field in [&row.name, &row.value] {
                field.update(cx, |field, cx| field.set_disabled(disabled, cx));
            }
        }
    }
    fn draft(&self, cx: &App) -> Result<ServerDraft, String> {
        let secrets = self
            .secrets
            .iter()
            .map(|row| (row.name.read(cx).text(), row.value.read(cx).text()))
            .collect::<Vec<_>>();
        let values = form::values(&self.public.read(cx).text(), &secrets)?;
        let transport = if self.stdio {
            let cwd = self.cwd.read(cx).text();
            TransportDraft::Stdio {
                command: self.command.read(cx).text(),
                args: self
                    .args
                    .read(cx)
                    .text()
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect(),
                cwd: (!cwd.trim().is_empty()).then_some(cwd),
                env: values,
            }
        } else {
            TransportDraft::Http {
                url: self.url.read(cx).text(),
                headers: values,
            }
        };
        Ok(ServerDraft {
            id: self.original.as_ref().map(|s| s.id.clone()),
            expected_revision: self.original.as_ref().map(|s| s.revision.clone()),
            name: self.name.read(cx).text(),
            enabled: self.original.as_ref().is_none_or(|s| s.enabled),
            transport,
        })
    }
}

pub(super) struct ExtensionsView {
    service: Entity<McpService>,
    generation: u64,
    book: Option<String>,
    busy: bool,
    error: Option<String>,
    editor: Option<Editor>,
    _subscription: Subscription,
}
impl ExtensionsView {
    pub(super) fn new(service: Entity<McpService>, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let generation = service.read(cx).generation();
        let book = service.read(cx).book();
        let subscription = cx.observe(&service, |view, service, cx| {
            let state = service.read(cx);
            if view.generation != state.generation() || view.book != state.book() {
                view.generation = state.generation();
                view.book = state.book();
                view.editor = None;
                view.busy = false;
                view.error = None;
            }
            cx.notify();
        });
        Self {
            service,
            generation,
            book,
            busy: false,
            error: None,
            editor: None,
            _subscription: subscription,
        }
    }
    pub(super) fn close(&mut self, cx: &mut Context<Self>) {
        self.editor = None;
        cx.notify();
    }
    fn scope(&self) -> (u64, Option<String>) {
        (self.generation, self.book.clone())
    }
    fn current(&self, scope: &(u64, Option<String>), cx: &App) -> bool {
        let service = self.service.read(cx);
        scope.0 == service.generation() && scope.1 == service.book() && *scope == self.scope()
    }
    fn blocked(&self, cx: &App) -> bool {
        self.busy || self.service.read(cx).is_busy() || dr_shell::release::is_releasing(cx)
    }
    fn context(&self, cx: &App) -> Option<(Manager, String)> {
        if self.blocked(cx) {
            return None;
        }
        let service = self.service.read(cx);
        if service.generation() != self.generation || service.book() != self.book {
            return None;
        }
        Some((service.manager()?, service.book()?))
    }
    fn run<T: Send + 'static>(
        &mut self,
        future: BoxFuture<'static, Result<T, String>>,
        close: bool,
        cx: &mut Context<Self>,
    ) {
        self.busy = true;
        self.error = None;
        if let Some(editor) = &self.editor {
            editor.disable(true, cx);
        }
        let generation = self.generation;
        let book = self.book.clone();
        let service = self.service.clone();
        let task = cx.background_executor().spawn(future);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            service.update(cx, |_, cx| cx.notify());
            let _ = this.update(cx, |view, cx| {
                if view.generation != generation || view.book != book {
                    return;
                }
                view.busy = false;
                if let Some(editor) = &view.editor {
                    editor.disable(false, cx);
                }
                match result {
                    Ok(_) => {
                        if close {
                            view.editor = None;
                        }
                    }
                    Err(error) => view.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn edit(&mut self, server: Option<ServerInfo>, window: &mut Window, cx: &mut Context<Self>) {
        if self.context(cx).is_none() {
            return;
        }
        let editor = Editor::new(server, window, cx);
        window.focus(&editor.name.focus_handle(cx), cx);
        self.editor = Some(editor);
        self.error = None;
        cx.notify();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        let Some((manager, book)) = self.context(cx) else {
            return;
        };
        let Some(editor) = &self.editor else {
            return;
        };
        match editor.draft(cx) {
            Ok(draft) => self.run(manager.save(book, draft), true, cx),
            Err(error) => {
                self.error = Some(error);
                cx.notify();
            }
        }
    }
    fn toggle(&mut self, server: ServerInfo, cx: &mut Context<Self>) {
        let Some((manager, book)) = self.context(cx) else {
            return;
        };
        self.run(
            manager.save(book, form::retained(&server, !server.enabled)),
            false,
            cx,
        );
    }
    fn remove(&mut self, server: ServerInfo, cx: &mut Context<Self>) {
        let Some((manager, book)) = self.context(cx) else {
            return;
        };
        let close = self
            .editor
            .as_ref()
            .and_then(|e| e.original.as_ref())
            .is_some_and(|s| s.id == server.id);
        self.run(manager.remove(book, server.id, server.revision), close, cx);
    }
    fn reconnect(&mut self, server: ServerInfo, cx: &mut Context<Self>) {
        let Some((manager, book)) = self.context(cx) else {
            return;
        };
        self.run(
            manager.reconnect(book, server.id, server.revision),
            false,
            cx,
        );
    }
    fn server(
        &self,
        server: &ServerInfo,
        blocked: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let status = match &server.status {
            Status::Disabled => t(cx, k::policy::DISABLED),
            Status::Disconnected => t(cx, k::NOT_CHECKED),
            Status::Connecting => t(cx, keys::agent_panel::CHECKING),
            Status::Ready => t(cx, keys::settings::byok_provider::AVAILABLE),
            Status::Failed { message } => message.clone().into(),
        };
        let mut col = div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(div().child(server.name.clone()))
            .child(note(status, window, cx));
        let mut row = div().flex().flex_wrap().gap(px(6.0));
        let entity = cx.entity();
        let item = server.clone();
        let scope = self.scope();
        row = row.child(
            Button::new(
                format!("mcp-enable-{}", server.id),
                t(
                    cx,
                    if server.enabled {
                        k::DISABLE
                    } else {
                        k::ENABLE
                    },
                ),
            )
            .small()
            .disabled(blocked)
            .on_click(move |_, _, cx| {
                entity.update(cx, |view, cx| {
                    if view.current(&scope, cx) {
                        view.toggle(item.clone(), cx);
                    }
                })
            })
            .mark(format!("mcp-enable-{}", server.id)),
        );
        let entity = cx.entity();
        let item = server.clone();
        let scope = self.scope();
        row = row.child(
            Button::new(
                format!("mcp-edit-{}", server.id),
                t(cx, keys::settings::common::EDIT),
            )
            .small()
            .disabled(blocked)
            .on_click(move |_, window, cx| {
                entity.update(cx, |view, cx| {
                    if view.current(&scope, cx) {
                        view.edit(Some(item.clone()), window, cx);
                    }
                })
            })
            .mark(format!("mcp-edit-{}", server.id)),
        );
        let entity = cx.entity();
        let item = server.clone();
        let scope = self.scope();
        row = row.child(
            Button::new(format!("mcp-reconnect-{}", server.id), t(cx, k::RECONNECT))
                .small()
                .disabled(blocked || !server.enabled)
                .on_click(move |_, _, cx| {
                    entity.update(cx, |view, cx| {
                        if view.current(&scope, cx) {
                            view.reconnect(item.clone(), cx);
                        }
                    })
                })
                .mark(format!("mcp-reconnect-{}", server.id)),
        );
        let entity = cx.entity();
        let item = server.clone();
        let scope = self.scope();
        row = row.child(
            Button::new(
                format!("mcp-remove-{}", server.id),
                t(cx, keys::settings::common::DELETE),
            )
            .small()
            .danger()
            .disabled(blocked)
            .on_click(move |_, _, cx| {
                entity.update(cx, |view, cx| {
                    if view.current(&scope, cx) {
                        view.remove(item.clone(), cx);
                    }
                })
            })
            .mark(format!("mcp-remove-{}", server.id)),
        );
        col = col.child(row);
        col.into_any_element()
    }
    fn editor(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(editor) = &self.editor else {
            return div().into_any_element();
        };
        let blocked = self.blocked(cx);
        let field = |key: Key, element: AnyElement, cx: &App| {
            div()
                .w_full()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .debug_selector(move || format!("mcp-field-{}", key.name()))
                .child(note(t(cx, key), window, cx))
                .child(element)
        };
        let mut col = div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(heading(
                if editor.original.is_some() {
                    k::EDIT_TITLE
                } else {
                    k::ADD_TITLE
                },
                cx,
            ))
            .child(field(k::NAME, editor.name.clone().into_any_element(), cx));
        let entity = cx.entity();
        col = col.child(field(
            k::TRANSPORT,
            Select::new(
                "mcp-transport",
                vec![
                    Choice::new(Icon::KnotLinks, "Streamable HTTP"),
                    Choice::new(Icon::KnotLinks, "stdio"),
                ],
                usize::from(editor.stdio),
            )
            .disabled(blocked)
            .on_change(move |index, _, cx| {
                entity.update(cx, |view, cx| {
                    if let Some(editor) = &mut view.editor {
                        let stdio = index == 1;
                        if editor.stdio != stdio {
                            editor.stdio = stdio;
                            editor.public.update(cx, |area, cx| area.set_text("", cx));
                            editor.secrets.clear();
                            cx.notify();
                        }
                    }
                })
            })
            .into_any_element(),
            cx,
        ));
        if editor.stdio {
            col = col
                .child(field(
                    k::COMMAND,
                    editor.command.clone().into_any_element(),
                    cx,
                ))
                .child(field(k::ARGS, editor.args.clone().into_any_element(), cx))
                .child(field(k::CWD, editor.cwd.clone().into_any_element(), cx));
        } else {
            col = col.child(field(k::URL, editor.url.clone().into_any_element(), cx));
        }
        col = col.child(field(
            if editor.stdio {
                k::PUBLIC_ENV
            } else {
                k::PUBLIC_HEADERS
            },
            editor.public.clone().into_any_element(),
            cx,
        ));
        let entity = cx.entity();
        col = col.child(
            Button::new(
                "mcp-add-secret",
                t(
                    cx,
                    if editor.stdio {
                        k::SECRET_ENV
                    } else {
                        k::SECRET_HEADERS
                    },
                ),
            )
            .small()
            .icon(Icon::Plus)
            .disabled(blocked)
            .on_click(move |_, window, cx| {
                entity.update(cx, |view, cx| {
                    if let Some(editor) = &mut view.editor {
                        editor.add_secret(String::new(), window, cx);
                        cx.notify();
                    }
                })
            })
            .mark("mcp-add-secret"),
        );
        for secret in &editor.secrets {
            let entity = cx.entity();
            let id = secret.id;
            col = col.child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .debug_selector(move || format!("mcp-secret-name-{id}"))
                            .child(secret.name.clone()),
                    )
                    .child("=")
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .debug_selector(move || format!("mcp-secret-value-{id}"))
                            .child(secret.value.clone()),
                    )
                    .child(
                        Button::new(
                            format!("mcp-remove-secret-{id}"),
                            t(cx, keys::settings::common::DELETE),
                        )
                        .small()
                        .disabled(blocked)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |view, cx| {
                                if let Some(editor) = &mut view.editor {
                                    editor.secrets.retain(|row| row.id != id);
                                    cx.notify();
                                }
                            })
                        })
                        .mark(format!("mcp-remove-secret-{id}")),
                    ),
            );
        }
        col = col.child(note(t(cx, k::SECRET_HINT), window, cx));
        let entity = cx.entity();
        let cancel = cx.entity();
        let scope = self.scope();
        col = col.child(
            div()
                .flex()
                .gap(px(6.0))
                .child(
                    Button::new("mcp-save-server", t(cx, keys::settings::common::SAVE))
                        .small()
                        .primary()
                        .disabled(blocked || editor.name.read(cx).text().trim().is_empty())
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |view, cx| {
                                if view.current(&scope, cx) {
                                    view.save(cx);
                                }
                            })
                        })
                        .mark("mcp-save-server"),
                )
                .child(
                    Button::new("mcp-cancel-server", t(cx, keys::settings::common::CANCEL))
                        .small()
                        .on_click(move |_, _, cx| cancel.update(cx, |view, cx| view.close(cx)))
                        .mark("mcp-cancel-server"),
                ),
        );
        col.into_any_element()
    }
}
impl Render for ExtensionsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let manager = self.service.read(cx).manager();
        let book = self.service.read(cx).book();
        let blocked = self.blocked(cx) || manager.is_none() || book.is_none();
        let servers = manager
            .map(|manager| manager.snapshot())
            .filter(|snapshot| snapshot.book == book)
            .map(|snapshot| snapshot.servers)
            .unwrap_or_default();
        let entity = cx.entity();
        let mut col = div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .py(px(12.0))
            .child(heading(k::TITLE, cx))
            .child(
                Button::new("mcp-add-server", t(cx, k::ADD))
                    .small()
                    .disabled(blocked)
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |view, cx| view.edit(None, window, cx))
                    })
                    .mark("mcp-add-server"),
            );
        if book.is_none() {
            col = col.child(note(t(cx, k::NO_PROJECT), window, cx));
        } else if servers.is_empty() && self.service.read(cx).plugin_error().is_none() {
            col = col.child(note(t(cx, k::EMPTY), window, cx));
        }
        for server in servers {
            col = col.child(self.server(&server, blocked, window, cx));
        }
        col = col.child(self.editor(window, cx));
        if self.service.read(cx).plugin_error().is_some() {
            col = col.child(
                note(t(cx, k::LOAD_FAILED), window, cx).debug_selector(|| "mcp-load-error".into()),
            );
        }
        if let Some(error) = self.error.as_deref() {
            col = col.child(note(error.to_owned(), window, cx));
        }
        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_mcp::outbound::SecretInput;
    use dr_platform::secrets::SecretStore;
    use dr_shell::{Services, SettingsFile, ShellInfo};
    use gpui::TestAppContext;
    use std::{collections::BTreeMap, sync::Arc};

    #[gpui::test]
    fn ready_service_add_button_gives_the_new_editor_real_keyboard_input(cx: &mut TestAppContext) {
        use dr_agent::driver::scripted::ScriptedDriver;
        use dr_agent_providers::{HttpClient, ProviderDriver, credentials::Credentials};
        use dr_mcp::{ClientPaths, GrantPaths};
        use dr_testkit::seed::{self, Preset};
        use std::time::{Duration, Instant};

        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let ws =
            dr_workspace::Workspace::open_dir(dir.path().join("library"), "mcp-editor").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        seeded.write_to(ws.library()).unwrap();
        let paths = GrantPaths::new(
            dir.path().join("app/mcp"),
            dir.path().join("Drifting"),
            ClientPaths::from_home(dir.path().join("home"), None, None),
        )
        .with_socket_root(dir.path().join("sockets"));
        let secrets = Arc::new(SecretStore::in_memory());
        let service = cx.update(|cx| {
            let mut settings = SettingsFile::in_memory();
            settings.set_last_book(&book);
            dr_shell::init(
                ShellInfo {
                    app_name: "Synthetic",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: None,
                },
                Services {
                    library: Some(ws),
                    book: Some(book.clone()),
                    ..Services::default()
                },
                settings,
                cx,
            );
            crate::mcp::init_with(Ok(paths), secrets.clone(), cx);
            cx.global::<crate::mcp::McpGlobal>().service.clone()
        });
        // Native initializers may flush deferred effects between modules.
        // Readiness must still reach this already-created settings service.
        cx.run_until_parked();
        cx.update(|cx| {
            let provider =
                ProviderDriver::new(HttpClient::new().unwrap(), Credentials::new(secrets));
            let global = cx.global::<crate::mcp::McpGlobal>();
            let tools = Arc::new(crate::tools::CompanionTools::shared(
                global.tools.clone(),
                global.slot.clone(),
            ));
            crate::init_with(provider, Arc::new(ScriptedDriver::new(vec![])), tools, cx);
        });
        let shell = cx.add_window(dr_shell::Workspace::new).root(cx).unwrap();
        let (view, cx) =
            cx.add_window_view(|window, cx| ExtensionsView::new(service.clone(), window, cx));
        let draw = |cx: &mut gpui::VisualTestContext| {
            cx.run_until_parked();
            cx.update(|window, cx| {
                window.simulate_next_frame(cx);
                window.draw(cx).clear(cx);
                let current = window.window_handle().window_id();
                for other in cx.windows() {
                    if other.window_id() != current {
                        other
                            .update(cx, |_, window, cx| {
                                window.simulate_next_frame(cx);
                                window.draw(cx).clear(cx);
                            })
                            .unwrap();
                    }
                }
            });
            cx.run_until_parked();
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            draw(cx);
            if view.read_with(cx, |view, cx| view.context(cx).is_some()) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "MCP editor service did not become ready"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        cx.update(|window, _| window.activate_window());
        let button = cx.debug_bounds("mcp-add-server").unwrap();
        cx.simulate_click(button.center(), gpui::Modifiers::none());
        draw(cx);
        assert!(view.read_with(cx, |view, _| view.editor.is_some()));
        // Exercise the platform input handler after mounting, not set_text
        // or a direct call to edit(): the user's first typing must land.
        cx.simulate_input("Synthetic server");
        draw(cx);
        assert_eq!(
            view.read_with(cx, |view, cx| view
                .editor
                .as_ref()
                .unwrap()
                .name
                .read(cx)
                .text()),
            "Synthetic server"
        );
        // A stored config that cannot be decoded is not an empty catalog.
        // Returning to this book starts a fresh activation and paints the
        // localized failure, separate from inbound connection warnings.
        shell.update(cx, |shell, cx| {
            shell
                .library
                .as_ref()
                .unwrap()
                .library()
                .local_set(
                    "mcp.outbound",
                    &format!("{book}/synthetic-corrupt"),
                    "{invalid synthetic configuration",
                    Some(&book),
                )
                .unwrap();
            shell.shelf_open = true;
            cx.notify();
        });
        draw(cx);
        shell.update(cx, |shell, cx| {
            shell.shelf_open = false;
            cx.notify();
        });
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            draw(cx);
            if service.read_with(cx, |service, _| service.plugin_error().is_some()) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "MCP load failure did not reach the settings"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        draw(cx);
        assert!(cx.debug_bounds("mcp-load-error").is_some());
        assert!(service.read_with(cx, |service, _| service.error().is_none()));
        let (plugins, agent) = cx.update(|_, cx| {
            let hub = cx.global::<crate::AgentViews>().hub.clone();
            (
                service.update(cx, |service, cx| service.prepare_close(cx)),
                hub.update(cx, |hub, cx| hub.prepare_close(cx)),
            )
        });
        futures::executor::block_on(async {
            plugins.await.unwrap();
            agent.await.unwrap();
        });
        shell.update(cx, |shell, _| shell.library.as_ref().unwrap().close());
    }

    #[gpui::test]
    fn native_editor_masks_secrets_and_discards_them_on_close_or_library_release(
        cx: &mut TestAppContext,
    ) {
        cx.executor().allow_parking();
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
            crate::mcp::init_with(
                Err("Synthetic unavailable listener".into()),
                Arc::new(SecretStore::in_memory()),
                cx,
            );
            cx.global::<crate::mcp::McpGlobal>().service.clone()
        });
        let (view, cx) =
            cx.add_window_view(|window, cx| ExtensionsView::new(service.clone(), window, cx));
        let server = ServerInfo {
            id: "synthetic-server".into(),
            name: "Synthetic".into(),
            enabled: false,
            revision: "revision".into(),
            status: Status::Disabled,
            tools: vec![],
            transport: TransportConfig::Http {
                url: "https://synthetic.invalid/mcp".into(),
                headers: BTreeMap::from([(
                    "Authorization".into(),
                    ConfigValue::Secret {
                        reference: "synthetic-reference".into(),
                    },
                )]),
            },
        };
        view.update_in(cx, |view, window, cx| {
            view.editor = Some(Editor::new(Some(server.clone()), window, cx))
        });
        view.update(cx,|view,cx|{
            let editor=view.editor.as_mut().unwrap();
            let row=&editor.secrets[0];
            assert!(row.value.read(cx).is_secure());assert!(row.value.read(cx).text().is_empty());
            let TransportDraft::Http{headers,..}=editor.draft(cx).unwrap().transport else{panic!()};
            assert!(matches!(headers.get("Authorization"),Some(SecretInput::Keep)));
            row.value.update(cx,|value,cx|value.set_text("synthetic-new-secret",cx));
            assert!(!row.value.read(cx).display_text().contains("synthetic-new-secret"));
            let TransportDraft::Http{headers,..}=editor.draft(cx).unwrap().transport else{panic!()};
            assert!(matches!(headers.get("Authorization"),Some(SecretInput::Set(value)) if value=="synthetic-new-secret"));
            editor.secrets.clear();
            let TransportDraft::Http{headers,..}=editor.draft(cx).unwrap().transport else{panic!()};assert!(headers.is_empty());
        });
        view.update(cx, |view, cx| view.close(cx));
        assert!(view.read_with(cx, |view, _| view.editor.is_none()));
        view.update_in(cx, |view, window, cx| {
            view.editor = Some(Editor::new(Some(server), window, cx))
        });
        let scope = view.read_with(cx, |view, _| view.scope());
        let closed = service.update(cx, |service, cx| service.prepare_close(cx));
        futures::executor::block_on(closed).unwrap();
        cx.run_until_parked();
        assert!(view.read_with(cx, |view, cx| view.editor.is_none()
            && !view.current(&scope, cx)));
    }
}
