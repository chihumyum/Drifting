//! 「本地模型」: the cells under the four providers, after a hairline, in the
//! companion's 「连接模型」 and in Settings → 模型与 API (作者 2026-11-16,
//! prototype v3 「定稿」). The four provider cells are not touched.
//!
//! - Companion: with no server, one hollow 「本地模型」 cell; it opens the
//!   form below it. With servers, one cell each; a click selects it.
//! - Settings: each server's cell, 「改地址」「加 Key」/「编辑密钥」
//!   「测试连接」「断开」, and its models with a 「上下文」 field each; a typed
//!   list ends with 「模型名」+「添加」. The last row adds another server.
//! - The form: the address (Enter connects, Esc closes), 「连接」「取消」
//!   「加 Key」; the key field only after 「加 Key」. When the server gives no
//!   model list the form asks for a model name instead.

use std::collections::HashMap;

use dr_i18n::keys;
use dr_shell::strings::t;
use dr_ui::{
    Theme,
    components::{Button, PanelIconButton, SandCell},
    fonts::Role,
    input::{FieldEvent, TextField},
    sand::{Icon, Kind},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement, Render, SharedString, Styled,
    Subscription, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    connection::Connections,
    connection_view::ConnectionEvent,
    local::{self, KeyChange, LocalFailure, LocalServer, LocalServerModel, Probe},
};

use dr_agent::Provider;
use dr_agent_providers::local::{LocalAddress, Software};

/// The local cells' mark: the fifth sand blob, after the four providers'.
const MARK: Kind = Kind::Chapter(4);

pub fn failure_text(failure: LocalFailure, cx: &App) -> SharedString {
    use keys::v3_settings::local_models as k;
    t(
        cx,
        match failure {
            LocalFailure::NotLocal => k::NOT_LOCAL,
            LocalFailure::Unreachable => k::UNREACHABLE,
            LocalFailure::InvalidKey => keys::settings::byok_provider::INVALID_KEY,
            LocalFailure::NoToolModels => k::NO_TOOL_MODELS,
            LocalFailure::RequestFailed => keys::settings::byok_provider::REQUEST_FAILED,
            LocalFailure::Storage => keys::agent_panel::onboarding::SAVE_FAILED,
        },
    )
}

/// A hairline between the four providers and the local servers.
pub fn divider(window: &mut Window, cx: &App) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    div()
        .w_full()
        .my(px(6.0))
        .h(px(1.0))
        .bg(p.hairline())
        .into_any_element()
}

/// The server's answer was not a model list: what the form keeps while the
/// author types a model name.
struct Pending {
    address: LocalAddress,
    key: KeyChange,
}

struct Form {
    /// The server being changed (「改地址」「加 Key」「编辑密钥」).
    editing: Option<String>,
    key_open: bool,
    busy: bool,
    error: Option<LocalFailure>,
    pending: Option<Pending>,
    generation: u64,
}

pub struct LocalConnectionView {
    connections: Entity<Connections>,
    settings: bool,
    address: Entity<TextField>,
    key: Entity<TextField>,
    model_name: Entity<TextField>,
    form: Option<Form>,
    generation: u64,
    /// Settings: one 「上下文」 field per (server, model), with its hint.
    contexts: HashMap<(String, String), (Entity<TextField>, String, Subscription)>,
    /// Settings: the 「模型名」 field under a typed list.
    additions: HashMap<String, (Entity<TextField>, Subscription)>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ConnectionEvent> for LocalConnectionView {}

impl LocalConnectionView {
    pub fn new(
        connections: Entity<Connections>,
        settings: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let address = cx.new(|cx| {
            TextField::new("local-model-address", window, cx)
                .mono()
                .placeholder(local::ADDRESS_PLACEHOLDER)
        });
        let key = cx.new(|cx| {
            TextField::new("local-model-key", window, cx)
                .secure(true)
                .mono()
                .placeholder(t(cx, keys::settings::byok_provider::KEY_PLACEHOLDER))
        });
        let model_name = cx.new(|cx| {
            TextField::new("local-model-name", window, cx)
                .placeholder(t(cx, keys::v3_settings::local_models::MODEL_NAME))
        });
        let mut subscriptions = Vec::new();
        for field in [&address, &key] {
            subscriptions.push(
                cx.subscribe_in(field, window, |view, _, event, window, cx| match event {
                    FieldEvent::Submitted(_) => view.connect(window, cx),
                    FieldEvent::Cancelled => view.close(window, cx),
                    _ => {}
                }),
            );
        }
        subscriptions.push(
            cx.subscribe_in(
                &model_name,
                window,
                |view, _, event, window, cx| match event {
                    FieldEvent::Submitted(_) => view.add_pending_model(window, cx),
                    FieldEvent::Cancelled => view.close(window, cx),
                    _ => {}
                },
            ),
        );
        subscriptions.push(cx.observe(&connections, |_, _, cx| cx.notify()));
        Self {
            connections,
            settings,
            address,
            key,
            model_name,
            form: None,
            generation: 0,
            contexts: HashMap::new(),
            additions: HashMap::new(),
            _subscriptions: subscriptions,
        }
    }

    pub fn is_open(&self) -> bool {
        self.form.is_some()
    }

    fn open(
        &mut self,
        editing: Option<&LocalServer>,
        key_open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.generation += 1;
        self.form = Some(Form {
            editing: editing.map(|server| server.id.clone()),
            key_open,
            busy: false,
            error: None,
            pending: None,
            generation: self.generation,
        });
        let text = editing
            .map(|server| server.base_url.clone())
            .unwrap_or_default();
        self.address.update(cx, |field, cx| {
            field.set_disabled(false, cx);
            field.set_text(text, cx);
        });
        self.key.update(cx, |field, cx| {
            field.set_disabled(false, cx);
            field.set_text("", cx);
        });
        self.model_name
            .update(cx, |field, cx| field.set_text("", cx));
        let focus = if key_open { &self.key } else { &self.address };
        window.focus(&focus.focus_handle(cx), cx);
        cx.notify();
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.generation += 1;
        self.form = None;
        for field in [&self.address, &self.key, &self.model_name] {
            field.update(cx, |field, cx| {
                field.set_disabled(false, cx);
                field.set_text("", cx);
            });
        }
        window.blur(cx);
        cx.notify();
    }

    fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        if let Some(form) = &mut self.form {
            form.busy = busy;
        }
        for field in [&self.address, &self.key] {
            field.update(cx, |field, cx| field.set_disabled(busy, cx));
        }
        cx.notify();
    }

    fn open_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(form) = &mut self.form {
            form.key_open = true;
        }
        window.focus(&self.key.focus_handle(cx), cx);
        cx.notify();
    }

    fn connect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = &self.form else {
            return;
        };
        if form.busy || form.pending.is_some() {
            return;
        }
        let raw = self.address.read(cx).text();
        if raw.trim().is_empty() {
            window.focus(&self.address.focus_handle(cx), cx);
            return;
        }
        let key = if form.key_open {
            let value = self.key.read(cx).text();
            if value.trim().is_empty() {
                KeyChange::Clear
            } else {
                KeyChange::Set(value.trim().to_owned())
            }
        } else {
            KeyChange::Keep
        };
        let editing = form.editing.clone();
        let generation = form.generation;
        if let Some(form) = &mut self.form {
            form.error = None;
        }
        self.set_busy(true, cx);
        let service = self.connections.read(cx).service();
        let http = service.driver().http().clone();
        let probe_key = key.clone();
        let existing = editing.clone();
        let task = http.spawn(async move {
            service
                .probe_local(&raw, &probe_key, existing.as_deref())
                .await
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await.unwrap_or(Err(LocalFailure::Unreachable));
            this.update_in(cx, |view, window, cx| {
                if view.form.as_ref().map(|form| form.generation) != Some(generation) {
                    return;
                }
                match result {
                    Ok((address, Probe::Listed(discovery))) => {
                        let models = discovery
                            .models
                            .iter()
                            .map(|model| LocalServerModel::new(&model.id, model.context_window))
                            .collect();
                        view.finish(address, discovery.software, models, false, key, window, cx);
                    }
                    Ok((address, Probe::NoList)) => {
                        view.set_busy(false, cx);
                        if let Some(form) = &mut view.form {
                            form.pending = Some(Pending { address, key });
                        }
                        window.focus(&view.model_name.focus_handle(cx), cx);
                    }
                    Err(error) => {
                        view.set_busy(false, cx);
                        if let Some(form) = &mut view.form {
                            form.error = Some(error);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn add_pending_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.model_name.read(cx).text().trim().to_owned();
        if !dr_agent_providers::local::valid_model_id(&name) {
            window.focus(&self.model_name.focus_handle(cx), cx);
            return;
        }
        let Some(pending) = self.form.as_mut().and_then(|form| form.pending.take()) else {
            return;
        };
        self.finish(
            pending.address,
            None,
            vec![LocalServerModel::new(name, None)],
            true,
            pending.key,
            window,
            cx,
        );
    }

    /// The server answered: keep its key, then the server, then select it.
    #[allow(clippy::too_many_arguments)]
    fn finish(
        &mut self,
        address: LocalAddress,
        software: Option<Software>,
        models: Vec<LocalServerModel>,
        manual: bool,
        key: KeyChange,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(form) = &self.form else {
            return;
        };
        let generation = form.generation;
        let editing = form.editing.clone();
        let previous = editing
            .as_deref()
            .and_then(|id| self.connections.read(cx).local_server(id).cloned());
        let id = editing.clone().unwrap_or_else(local::new_id);
        let has_key = key.has_key(previous.as_ref().is_some_and(|server| server.has_key));
        let models = match &previous {
            // The author's context values follow the models that remain.
            Some(previous) => models
                .into_iter()
                .map(|mut model| {
                    model.context_override = previous
                        .model(&model.id)
                        .and_then(|old| old.context_override);
                    model
                })
                .collect(),
            None => models,
        };
        let label = local::label_for(
            software,
            &address,
            self.connections.read(cx).local_servers(),
            Some(&id),
        );
        let server = LocalServer {
            id: id.clone(),
            base_url: address.base_url,
            label,
            has_key,
            manual,
            models,
        };
        self.set_busy(true, cx);
        let service = self.connections.read(cx).service();
        let http = service.driver().http().clone();
        let task = http.spawn(async move { service.apply_local_key(&id, &key).await });
        let select = editing.is_none();
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await.unwrap_or(Err(LocalFailure::Storage));
            this.update_in(cx, |view, window, cx| {
                if view.form.as_ref().map(|form| form.generation) != Some(generation) {
                    return;
                }
                match result {
                    Ok(()) => {
                        view.connections.update(cx, |connections, cx| {
                            connections.put_local(server, select, cx)
                        });
                        view.close(window, cx);
                        cx.emit(ConnectionEvent::Connected);
                    }
                    Err(error) => {
                        view.set_busy(false, cx);
                        if let Some(form) = &mut view.form {
                            form.error = Some(error);
                        }
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn form_element(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(form) = &self.form else {
            return div().into_any_element();
        };
        let p = Theme::of(window, cx).palette;
        let mut col = div().w_full().flex().flex_col().gap(px(6.0));
        if form.pending.is_some() {
            col = col
                .child(
                    div()
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(div().flex_1().min_w_0().child(self.model_name.clone()))
                        .child(
                            Button::new(
                                "local-model-name-add",
                                t(cx, keys::v3_settings::local_models::ADD),
                            )
                            .primary()
                            .small()
                            .disabled(form.busy)
                            .busy(form.busy)
                            .on_click(
                                cx.listener(|view, _, window, cx| {
                                    view.add_pending_model(window, cx)
                                }),
                            ),
                        ),
                )
                .child(
                    div().flex().child(
                        Button::new("local-model-cancel", t(cx, keys::settings::common::CANCEL))
                            .text()
                            .small()
                            .on_click(cx.listener(|view, _, window, cx| view.close(window, cx))),
                    ),
                );
        } else {
            col = col.child(self.address.clone());
            if form.key_open {
                col = col.child(self.key.clone());
            }
            col = col.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.0))
                    .child(
                        Button::new(
                            "local-model-connect",
                            t(cx, keys::settings::common::CONNECT),
                        )
                        .primary()
                        .small()
                        .disabled(form.busy)
                        .busy(form.busy)
                        .on_click(cx.listener(|view, _, window, cx| view.connect(window, cx))),
                    )
                    .child(
                        Button::new("local-model-cancel", t(cx, keys::settings::common::CANCEL))
                            .text()
                            .small()
                            .on_click(cx.listener(|view, _, window, cx| view.close(window, cx))),
                    )
                    .when(!form.key_open, |row| {
                        row.child(
                            Button::new(
                                "local-model-add-key",
                                t(cx, keys::v3_settings::local_models::ADD_KEY),
                            )
                            .text()
                            .small()
                            .disabled(form.busy)
                            .on_click(cx.listener(|view, _, window, cx| view.open_key(window, cx))),
                        )
                    }),
            );
        }
        if let Some(error) = form.error {
            col = col.child(
                div()
                    .text_color(p.muted().solid())
                    .child(failure_text(error, cx)),
            );
        }
        col.into_any_element()
    }

    /// A server's cell: its name, and its `host:port` in the index face.
    fn server_cell(
        &self,
        server: &LocalServer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let state = self.connections.read(cx);
        let selected = !self.settings
            && state
                .selected_local()
                .is_some_and(|(selected, _)| selected.id == server.id);
        let mut cell = SandCell::new(format!("local-server-{}", server.id), server.label.clone())
            .mark(MARK)
            .selected(selected)
            .child(
                div()
                    .font_role(Role::Index)
                    .text_color(p.muted().solid())
                    .child(server.display()),
            );
        if !self.settings {
            let id = server.id.clone();
            let first = server.models.first().map(|model| model.id.clone());
            let entity = cx.entity();
            cell = cell.on_click(move |_, _, cx| {
                if let Some(first) = &first {
                    entity.update(cx, |view, cx| {
                        let chosen = view.connections.update(cx, |connections, cx| {
                            // The model already chosen on this server stays.
                            let model = connections
                                .selected_local()
                                .filter(|(server, _)| server.id == id)
                                .map(|(_, model)| model.id.clone())
                                .unwrap_or_else(|| first.clone());
                            connections.select_local(&id, &model, cx)
                        });
                        if chosen {
                            cx.emit(ConnectionEvent::Connected);
                        }
                    });
                }
            });
        }
        cell.into_any_element()
    }

    /// 「本地模型」 when nothing is connected yet.
    fn empty_cell(&self, cx: &mut Context<Self>, window: &mut Window) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let busy = self.form.as_ref().is_some_and(|form| form.busy);
        let entity = cx.entity();
        SandCell::new(
            "local-server-new",
            t(cx, keys::v3_settings::local_models::NAME),
        )
        .mark(MARK)
        .hollow(true)
        .disabled(busy)
        .on_click(move |_, window, cx| {
            entity.update(cx, |view, cx| {
                if !view.is_open() {
                    view.open(None, false, window, cx);
                }
            })
        })
        .child(
            div()
                .font_role(Role::Index)
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::byok_provider::NOT_CONNECTED)),
        )
        .into_any_element()
    }

    fn context_field(
        &mut self,
        server: &str,
        model: &LocalServerModel,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextField> {
        let hint = model.context.unwrap_or(local::DEFAULT_CONTEXT).to_string();
        let key = (server.to_owned(), model.id.clone());
        if let Some((field, old_hint, _)) = self.contexts.get(&key)
            && *old_hint == hint
        {
            return field.clone();
        }
        let text = model
            .context_override
            .map(|n| n.to_string())
            .unwrap_or_default();
        let field = cx.new(|cx| {
            TextField::new(
                gpui::ElementId::Name(format!("local-context-{server}-{}", model.id).into()),
                window,
                cx,
            )
            .small()
            .placeholder(hint.clone())
            .with_text(text)
        });
        let (id, model_id) = key.clone();
        let subscription = cx.subscribe_in(&field, window, move |view, field, event, _, cx| {
            if let FieldEvent::Changed(text) = event {
                let digits: String = text.chars().filter(char::is_ascii_digit).collect();
                if digits != *text {
                    field.update(cx, |field, cx| field.set_text(digits.clone(), cx));
                }
                let value = local::parse_context(&digits);
                view.connections.update(cx, |connections, cx| {
                    connections.set_local_context(&id, &model_id, value, cx)
                });
            }
        });
        self.contexts
            .insert(key, (field.clone(), hint, subscription));
        field
    }

    fn addition_field(
        &mut self,
        server: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextField> {
        if let Some((field, _)) = self.additions.get(server) {
            return field.clone();
        }
        let field = cx.new(|cx| {
            TextField::new(
                gpui::ElementId::Name(format!("local-model-more-{server}").into()),
                window,
                cx,
            )
            .small()
            .placeholder(t(cx, keys::v3_settings::local_models::MODEL_NAME))
        });
        let id = server.to_owned();
        let subscription = cx.subscribe_in(&field, window, move |view, _, event, _, cx| {
            if matches!(event, FieldEvent::Submitted(_)) {
                view.add_model(&id, cx);
            }
        });
        self.additions
            .insert(server.to_owned(), (field.clone(), subscription));
        field
    }

    fn add_model(&mut self, server: &str, cx: &mut Context<Self>) {
        let Some((field, _)) = self.additions.get(server) else {
            return;
        };
        let field = field.clone();
        let name = field.read(cx).text();
        let added = self.connections.update(cx, |connections, cx| {
            connections.add_local_model(server, &name, cx)
        });
        if added {
            field.update(cx, |field, cx| field.set_text("", cx));
        }
    }

    /// Settings: a server's buttons, test result and model list.
    fn settings_server(
        &mut self,
        server: &LocalServer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let id = server.id.clone();
        let state = self.connections.read(cx);
        let testing = state
            .local_test
            .as_ref()
            .filter(|(test, _)| *test == id)
            .map(|(_, result)| *result);
        let failure = state
            .local_failure
            .as_ref()
            .filter(|(failed, _)| *failed == id)
            .map(|(_, failure)| *failure);
        let mut col = div().w_full().flex().flex_col().gap(px(6.0));
        let edit = server.clone();
        let edit_key = server.clone();
        let test = id.clone();
        let disconnect = id.clone();
        col = col.child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.0))
                .child(
                    Button::new(
                        format!("local-edit-address-{id}"),
                        t(cx, keys::v3_settings::local_models::EDIT_ADDRESS),
                    )
                    .small()
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.open(Some(&edit), false, window, cx)
                    })),
                )
                .child(
                    Button::new(
                        format!("local-key-{id}"),
                        t(
                            cx,
                            if server.has_key {
                                keys::settings::byok_provider::EDIT_KEY
                            } else {
                                keys::v3_settings::local_models::ADD_KEY
                            },
                        ),
                    )
                    .small()
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.open(Some(&edit_key), true, window, cx)
                    })),
                )
                .child(
                    Button::new(
                        format!("local-test-{id}"),
                        t(cx, keys::settings::common::TEST_CONNECTION),
                    )
                    .small()
                    .busy(testing == Some(None))
                    .disabled(testing == Some(None))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.connections
                            .update(cx, |connections, cx| connections.test_local(&test, cx))
                    })),
                )
                .child(
                    Button::new(
                        format!("local-disconnect-{id}"),
                        t(cx, keys::settings::common::DISCONNECT),
                    )
                    .small()
                    .text()
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.connections.update(cx, |connections, cx| {
                            connections.disconnect_local(&disconnect, cx)
                        })
                    })),
                ),
        );
        let note = match (testing, failure) {
            (_, Some(failure)) => Some(failure_text(failure, cx)),
            (Some(Some(Ok(()))), None) => Some(t(cx, keys::settings::byok_provider::AVAILABLE)),
            (Some(Some(Err(failure))), None) => Some(failure_text(failure, cx)),
            _ => None,
        };
        if let Some(note) = note {
            col = col.child(div().text_color(p.muted().solid()).child(note));
        }
        // 「上下文」: the server's value (or 32768) as the hint; typed wins.
        let mut table = div().w_full().flex().flex_col().gap(px(4.0)).child(
            div()
                .w_full()
                .flex()
                .items_center()
                .gap(px(6.0))
                .font_role(Role::Index)
                .text_color(p.muted().solid())
                .child(div().flex_1())
                .child(
                    div()
                        .w(px(96.0))
                        .child(t(cx, keys::v3_settings::local_models::CONTEXT)),
                )
                .child(div().w(px(24.0))),
        );
        for model in &server.models {
            let field = self.context_field(&server.id, model, window, cx);
            let remove = (server.manual).then(|| {
                let (id, model) = (server.id.clone(), model.id.clone());
                PanelIconButton::new(
                    gpui::ElementId::Name(format!("local-remove-{id}-{model}").into()),
                    Icon::Close,
                )
                .label(t(cx, keys::common::DELETE))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.connections.update(cx, |connections, cx| {
                        connections.remove_local_model(&id, &model, cx)
                    })
                }))
            });
            table = table.child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .font_role(Role::Index)
                            .child(model.id.clone()),
                    )
                    .child(div().w(px(96.0)).child(field))
                    .child(
                        div()
                            .w(px(24.0))
                            .when_some(remove, |cell, remove| cell.child(remove)),
                    ),
            );
        }
        if server.manual {
            let field = self.addition_field(&server.id, window, cx);
            let add = server.id.clone();
            table = table.child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(div().flex_1().min_w_0().child(field))
                    .child(
                        Button::new(
                            format!("local-model-add-{}", server.id),
                            t(cx, keys::v3_settings::local_models::ADD),
                        )
                        .small()
                        .on_click(cx.listener(move |view, _, _, cx| view.add_model(&add, cx))),
                    ),
            );
        }
        col.child(table).into_any_element()
    }

    fn prune(&mut self, servers: &[LocalServer]) {
        self.contexts.retain(|(server, model), _| {
            servers
                .iter()
                .any(|s| s.id == *server && s.model(model).is_some())
        });
        self.additions
            .retain(|server, _| servers.iter().any(|s| s.id == *server && s.manual));
    }
}

/// What the form shows, for tests and acceptance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormState {
    pub editing: bool,
    pub key_open: bool,
    pub busy: bool,
    pub asks_model_name: bool,
    pub error: Option<LocalFailure>,
}

/// The same entry points the buttons and fields use.
#[doc(hidden)]
impl LocalConnectionView {
    pub fn form_state(&self) -> Option<FormState> {
        self.form.as_ref().map(|form| FormState {
            editing: form.editing.is_some(),
            key_open: form.key_open,
            busy: form.busy,
            asks_model_name: form.pending.is_some(),
            error: form.error,
        })
    }

    /// The address, key and model-name fields.
    pub fn fields(&self) -> [Entity<TextField>; 3] {
        [
            self.address.clone(),
            self.key.clone(),
            self.model_name.clone(),
        ]
    }

    /// 「本地模型」 or 「＋ 本地模型」.
    pub fn open_new(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open(None, false, window, cx);
    }

    /// 「改地址」 (`key: false`), 「加 Key」/「编辑密钥」 (`key: true`).
    pub fn open_server(
        &mut self,
        server: &str,
        key: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let server = self.connections.read(cx).local_server(server).cloned();
        if let Some(server) = server {
            self.open(Some(&server), key, window, cx);
        }
    }

    /// 「加 Key」 inside the form.
    pub fn show_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_key(window, cx);
    }

    /// 「连接」 or Enter.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.connect(window, cx);
    }

    /// 「添加」 after 「模型名」.
    pub fn submit_model_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add_pending_model(window, cx);
    }

    /// 「取消」 or Esc.
    pub fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
    }
}

impl Render for LocalConnectionView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let servers = self.connections.read(cx).local_servers().to_vec();
        self.prune(&servers);
        let editing = self.form.as_ref().and_then(|form| form.editing.clone());
        let adding = self.form.is_some() && editing.is_none();
        let mut col = div()
            .id(if self.settings {
                "local-models-settings"
            } else {
                "local-models"
            })
            .w_full()
            .flex()
            .flex_col()
            .gap(px(6.0));
        if servers.is_empty() {
            col = col.child(self.empty_cell(cx, window));
            if adding {
                col = col.child(self.form_element(window, cx));
            }
            return col;
        }
        for server in &servers {
            col = col.child(self.server_cell(server, window, cx));
            if self.settings {
                if editing.as_deref() == Some(server.id.as_str()) {
                    col = col.child(self.form_element(window, cx));
                } else {
                    col = col.child(self.settings_server(server, window, cx));
                }
            }
        }
        if self.settings {
            let entity = cx.entity();
            col = col.child(
                SandCell::new(
                    "local-server-add",
                    t(cx, keys::v3_settings::local_models::NAME),
                )
                .icon(Icon::Plus)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |view, cx| view.open(None, false, window, cx))
                }),
            );
            if adding {
                col = col.child(self.form_element(window, cx));
            }
        }
        col
    }
}

/// The local models among the composer's routes: 「<名字> · <模型>」.
pub fn routes(connections: &Connections) -> Vec<(String, String, String)> {
    connections
        .local_servers()
        .iter()
        .flat_map(|server| {
            server.models.iter().map(move |model| {
                (
                    server.id.clone(),
                    model.id.clone(),
                    format!("{} · {}", server.label, model.id),
                )
            })
        })
        .collect()
}

/// Whether the composer's reasoning control applies (not to a local model).
pub fn has_reasoning(connections: &Connections) -> bool {
    connections.preferences().route.provider != Provider::Local
}
