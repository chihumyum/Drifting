//! The four in-place connection cells. Settings reuses each cell with explicit
//! edit/delete actions; those actions are never present in the companion.

use dr_agent::{ModelErrorCategory, Provider, ThinkingLevel};
use dr_i18n::{Key, keys};
use dr_shell::strings::t;
use dr_ui::{
    Theme,
    components::{Button, Choice, SandCell, Select},
    fonts::Role,
    input::{FieldEvent, TextField},
    sand::{Icon, Kind},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::connection::{
    Connections, Failure, Operation, PROVIDERS, Readiness, key_page, provider_name, thinking_levels,
};

pub fn failure_key(failure: Failure, provider: Provider) -> Key {
    if provider == Provider::Chatgpt {
        use keys::settings::codex_subscription::failure as k;
        return match failure {
            Failure::Expired => k::EXPIRED,
            Failure::Storage => k::STORAGE_FAILED,
            Failure::Provider(ModelErrorCategory::Network) => k::NETWORK_FAILED,
            Failure::Provider(ModelErrorCategory::InvalidResponse) => k::INVALID_RESPONSE,
            _ => k::PROVIDER_REJECTED,
        };
    }
    match failure {
        Failure::Storage => keys::agent_panel::onboarding::SAVE_FAILED,
        Failure::Empty => keys::settings::byok_provider::KEY_PLACEHOLDER,
        Failure::Provider(ModelErrorCategory::Authentication) => {
            keys::settings::byok_provider::INVALID_KEY
        }
        _ => keys::settings::byok_provider::REQUEST_FAILED,
    }
}

pub fn thinking_label(level: ThinkingLevel, cx: &App) -> SharedString {
    use keys::settings::agent::effort_options as k;
    t(
        cx,
        match level {
            ThinkingLevel::Off => keys::agent_panel::common::NONE,
            ThinkingLevel::Minimal => k::MINIMAL,
            ThinkingLevel::Low => k::LOW,
            ThinkingLevel::Medium => k::MEDIUM,
            ThinkingLevel::High => k::HIGH,
            ThinkingLevel::Xhigh => k::XHIGH,
            ThinkingLevel::Max => k::MAX,
            ThinkingLevel::Ultra => k::ULTRA,
        },
    )
}

pub struct ConnectionView {
    connections: Entity<Connections>,
    field: Entity<TextField>,
    open: Option<Provider>,
    pending_connect: bool,
    pending_login: Option<u64>,
    settings_provider: Option<Provider>,
    _subscriptions: Vec<Subscription>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionEvent {
    Connected,
}
impl gpui::EventEmitter<ConnectionEvent> for ConnectionView {}

impl gpui::Focusable for ConnectionView {
    fn focus_handle(&self, cx: &App) -> gpui::FocusHandle {
        self.field.focus_handle(cx)
    }
}

impl ConnectionView {
    pub fn new(
        connections: Entity<Connections>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let field = cx.new(|cx| {
            TextField::new("agent-api-key", window, cx)
                .secure(true)
                .mono()
                .placeholder(t(cx, keys::settings::byok_provider::KEY_PLACEHOLDER))
        });
        let state = cx.observe_in(&connections, window, |view, connections, window, cx| {
            let current = connections.read(cx);
            let busy = current.operation.is_some();
            let succeeded = current.failure.is_none()
                && !busy
                && ((view.pending_connect
                    && view
                        .open
                        .is_some_and(|provider| current.readiness(provider) == Readiness::Ready))
                    || (view.pending_login.is_some()
                        && current.readiness(Provider::Chatgpt) == Readiness::Ready));
            view.field.update(cx, |field, cx| {
                field.set_disabled(busy, cx);
                if succeeded {
                    field.set_text("", cx);
                }
            });
            if succeeded {
                view.open = None;
                if view.settings_provider.is_some()
                    && view.field.focus_handle(cx).is_focused(window)
                {
                    window.blur(cx);
                }
                cx.emit(ConnectionEvent::Connected);
            }
            if !busy {
                view.pending_connect = false;
                view.pending_login = None;
            }
            cx.notify();
        });
        let input = cx.subscribe_in(&field, window, |view, _, event, window, cx| {
            if matches!(event, FieldEvent::Submitted(_)) {
                view.connect(cx);
            }
            if matches!(event, FieldEvent::Cancelled | FieldEvent::Blurred) && !view.pending_connect
            {
                view.open = None;
                view.field.update(cx, |field, cx| field.set_text("", cx));
                if matches!(event, FieldEvent::Cancelled) {
                    window.blur(cx);
                }
                cx.notify();
            }
        });
        let release = cx.on_release(|view, cx| view.cancel_login(cx));
        let owner_window = window.window_handle().window_id();
        let weak = cx.weak_entity();
        let window_closed = cx.on_window_closed(move |cx, window| {
            if window == owner_window {
                weak.update(cx, |view, cx| view.cancel_login(cx)).ok();
            }
        });
        Self {
            connections,
            field,
            open: None,
            pending_connect: false,
            pending_login: None,
            settings_provider: None,
            _subscriptions: vec![state, input, release, window_closed],
        }
    }

    /// A hidden or released connection UI cancels only the login it started.
    /// Another window's later login is identified by a different operation.
    pub fn cancel_login(&mut self, cx: &mut App) {
        if let Some(generation) = self.pending_login.take() {
            self.connections.update(cx, |connections, cx| {
                connections.cancel_owned_login(generation, cx)
            });
        }
    }

    pub fn start_login(&mut self, cx: &mut Context<Self>) {
        if let Some(generation) = self
            .connections
            .update(cx, |connections, cx| connections.start_login(cx))
        {
            self.pending_login = Some(generation);
        }
    }

    pub fn for_settings(
        connections: Entity<Connections>,
        provider: Provider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self::new(connections, window, cx);
        view.settings_provider = Some(provider);
        view
    }

    fn connect(&mut self, cx: &mut Context<Self>) {
        let Some(provider) = self.open else {
            return;
        };
        let value = self.field.read(cx).text();
        self.pending_connect =
            !value.trim().is_empty() && self.connections.read(cx).operation.is_none();
        let settings = self.settings_provider.is_some();
        self.connections.update(cx, |connections, cx| {
            if settings {
                connections.replace_key(provider, value, cx);
            } else {
                connections.connect_key(provider, value, cx);
            }
        });
    }

    fn open(&mut self, provider: Provider, window: &mut Window, cx: &mut Context<Self>) {
        self.open = Some(provider);
        self.field.update(cx, |field, cx| field.set_text("", cx));
        window.focus(&self.field.focus_handle(cx), cx);
        cx.notify();
    }

    fn cell(
        &mut self,
        provider: Provider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let state = self.connections.read(cx);
        let ready = state.readiness(provider) == Readiness::Ready;
        let checking = state.readiness(provider) == Readiness::Checking;
        let busy = state.operation.is_some();
        let login = (provider == Provider::Chatgpt)
            .then(|| state.login.clone())
            .flatten();
        let operation = state.operation;
        let account = state.account.clone();
        let failure = (state.failure_provider == Some(provider))
            .then_some(state.failure)
            .flatten();
        let tested = state.tested == Some(provider);
        let selected = ready && state.preferences().route.provider == provider;
        let settings = self.settings_provider.is_some();
        let id = provider.as_str();
        let name: SharedString = if provider == Provider::Chatgpt {
            t(cx, keys::settings::codex_subscription::NAME)
        } else {
            provider_name(provider).into()
        };
        let source = if checking {
            t(cx, keys::agent_panel::CHECKING)
        } else if ready && provider == Provider::Chatgpt {
            account
                .and_then(|account| account.email.or(account.plan))
                .map(SharedString::from)
                .unwrap_or_else(|| t(cx, keys::settings::codex_subscription::SIGNED_IN_AS))
        } else if ready {
            "Keychain".into()
        } else {
            t(cx, keys::settings::byok_provider::NOT_CONNECTED)
        };
        let entity = cx.entity();
        let mut cell = SandCell::new(format!("connect-{id}"), name)
            .mark(Kind::Chapter(
                PROVIDERS.iter().position(|p| *p == provider).unwrap_or(0) as u8,
            ))
            .hollow(!ready)
            .selected(selected)
            .disabled(busy || checking)
            .on_click(move |_, window, cx| {
                if ready && !settings {
                    entity.update(cx, |view, cx| {
                        let selected = view.connections.update(cx, |connections, cx| {
                            connections.select_provider(provider, cx)
                        });
                        if selected {
                            cx.emit(ConnectionEvent::Connected);
                        }
                    });
                } else if provider == Provider::Chatgpt {
                    if !ready {
                        entity.update(cx, |view, cx| view.start_login(cx));
                    }
                } else {
                    entity.update(cx, |view, cx| view.open(provider, window, cx));
                }
            });
        cell = cell.child(
            div()
                .font_role(Role::Index)
                .text_color(p.muted().solid())
                .child(source),
        );
        let mut col = div()
            .id(format!("connection-{id}"))
            .w_full()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .py(px(6.0))
            .child(cell);
        if settings && ready {
            let connections = self.connections.clone();
            let mut actions = div().flex().flex_wrap().gap(px(6.0));
            if provider != Provider::Chatgpt {
                let edit = cx.entity();
                let retest = self.connections.clone();
                actions = actions
                    .child(
                        Button::new(
                            format!("key-edit-{id}"),
                            t(cx, keys::settings::byok_provider::EDIT_KEY),
                        )
                        .small()
                        .disabled(busy)
                        .on_click(move |_, window, cx| {
                            edit.update(cx, |view, cx| view.open(provider, window, cx))
                        }),
                    )
                    .child(
                        Button::new(
                            format!("key-test-{id}"),
                            t(cx, keys::settings::common::TEST_CONNECTION),
                        )
                        .small()
                        .disabled(busy)
                        .on_click(move |_, _, cx| {
                            retest.update(cx, |connections, cx| connections.retest(provider, cx))
                        }),
                    );
            }
            actions = actions.child(
                Button::new(
                    format!("key-delete-{id}"),
                    t(
                        cx,
                        if provider == Provider::Chatgpt {
                            keys::settings::codex_subscription::SIGN_OUT
                        } else {
                            keys::settings::common::DISCONNECT
                        },
                    ),
                )
                .small()
                .text()
                .disabled(busy)
                .on_click(move |_, _, cx| {
                    connections.update(cx, |connections, cx| {
                        if provider == Provider::Chatgpt {
                            connections.logout(cx);
                        } else {
                            connections.remove_key(provider, cx);
                        }
                    })
                }),
            );
            col = col.child(actions);
        }
        if self.open == Some(provider) && provider != Provider::Chatgpt {
            let connect = cx.entity();
            let close = cx.entity();
            col = col.child(self.field.clone()).child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.0))
                    .child(
                        Button::new(
                            format!("key-connect-{id}"),
                            t(cx, keys::settings::common::CONNECT),
                        )
                        .primary()
                        .small()
                        .disabled(busy)
                        .busy(operation == Some(Operation::Connecting(provider)))
                        .on_click(move |_, _, cx| connect.update(cx, |view, cx| view.connect(cx))),
                    )
                    .child(
                        Button::new(
                            format!("key-cancel-{id}"),
                            t(cx, keys::settings::common::CANCEL),
                        )
                        .text()
                        .small()
                        .disabled(busy)
                        .on_click(move |_, window, cx| {
                            close.update(cx, |view, cx| {
                                view.open = None;
                                view.field.update(cx, |field, cx| field.set_text("", cx));
                                window.blur(cx);
                                cx.notify();
                            })
                        }),
                    )
                    .when_some(key_page(provider), |row, url| {
                        row.child(
                            Button::new(
                                format!("key-page-{id}"),
                                t(cx, keys::agent_panel::onboarding::GET_KEY),
                            )
                            .text()
                            .small()
                            .on_click(move |_, _, cx| cx.open_url(url)),
                        )
                    }),
            );
        }
        if let Some(login) = login {
            let url = login.verification_url;
            let cancel = self.connections.clone();
            col = col
                .child(div().font_role(Role::Index).child(format!(
                    "{}: {}",
                    t(cx, keys::settings::codex_subscription::CODE_LABEL),
                    login.user_code
                )))
                .child(
                    div()
                        .text_color(p.muted().solid())
                        .child(t(cx, keys::settings::codex_subscription::CODE_HINT)),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(6.0))
                        .child(
                            Button::new(
                                "chatgpt-open-verification",
                                t(cx, keys::settings::codex_subscription::OPEN_VERIFICATION),
                            )
                            .primary()
                            .small()
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                        )
                        .child(
                            Button::new("chatgpt-cancel", t(cx, keys::settings::common::CANCEL))
                                .text()
                                .small()
                                .on_click(move |_, _, cx| {
                                    cancel
                                        .update(cx, |connections, cx| connections.cancel_login(cx))
                                }),
                        ),
                );
        } else if provider == Provider::Chatgpt && operation == Some(Operation::Login) {
            let cancel = self.connections.clone();
            col = col.child(
                Button::new(
                    "chatgpt-cancel-starting",
                    t(cx, keys::settings::common::CANCEL),
                )
                .small()
                .on_click(move |_, _, cx| {
                    cancel.update(cx, |connections, cx| connections.cancel_login(cx))
                }),
            );
        }
        if let Some(failure) = failure {
            let key = if failure == Failure::Provider(ModelErrorCategory::Cancelled) {
                keys::settings::codex_subscription::CANCELLED
            } else {
                failure_key(failure, provider)
            };
            col = col.child(div().text_color(p.muted().solid()).child(t(cx, key)));
        } else if tested {
            col = col.child(
                div()
                    .text_color(p.muted().solid())
                    .child(t(cx, keys::settings::byok_provider::AVAILABLE)),
            );
        }
        col.into_any_element()
    }
}

impl Render for ConnectionView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let providers = self
            .settings_provider
            .map(|provider| vec![provider])
            .unwrap_or_else(|| PROVIDERS.to_vec());
        let mut content = div().w_full().flex().flex_col().gap(px(6.0));
        if self.settings_provider.is_none() {
            content = content.child(t(cx, keys::agent_panel::onboarding::CONNECT));
        }
        for provider in providers {
            content = content.child(self.cell(provider, window, cx));
        }
        content
    }
}

/// Composer controls contain only usable routes. The run freezes this choice
/// when it starts; choosing another model affects the next send only.
pub fn composer_controls(
    connections: Entity<Connections>,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = connections.read(cx);
    let routes: Vec<_> = PROVIDERS
        .into_iter()
        .filter(|provider| state.readiness(*provider) == Readiness::Ready)
        .flat_map(|provider| {
            state.models(provider).iter().map(move |model| {
                (
                    provider,
                    model.id.clone(),
                    if model.short.starts_with(provider_name(provider)) {
                        model.short.clone()
                    } else {
                        format!("{} · {}", provider_name(provider), model.short)
                    },
                )
            })
        })
        .collect();
    if routes.is_empty() {
        return div().into_any_element();
    }
    let selected = routes.iter().position(|(provider, id, _)| {
        *provider == state.preferences().route.provider && id == &state.preferences().route.model
    });
    let mut choices: Vec<_> = routes
        .iter()
        .map(|(_, _, label)| Choice::new(Icon::Thinking, label.clone()))
        .collect();
    // A saved model removed from the live catalog remains visibly unavailable.
    let selected_index = selected.unwrap_or_else(|| {
        choices.insert(
            0,
            Choice::new(Icon::Thinking, t(cx, keys::agent_panel::config::MODEL)),
        );
        0
    });
    let offset = usize::from(selected.is_none());
    let levels = state
        .selected_model()
        .map(thinking_levels)
        .unwrap_or_default();
    let thinking = state.preferences().route.thinking;
    let busy = state.operation.is_some();
    let model_connections = connections.clone();
    let model = Select::new("agent-composer-model", choices, selected_index)
        .disabled(busy || routes.is_empty())
        .on_change(move |index, _, cx| {
            if let Some((provider, id, _)) = index
                .checked_sub(offset)
                .and_then(|index| routes.get(index))
            {
                model_connections.update(cx, |connections, cx| {
                    connections.select_model(*provider, id, cx);
                });
            }
        });
    let level_choices = levels
        .iter()
        .map(|level| Choice::new(Icon::Thinking, thinking_label(*level, cx)))
        .collect();
    let selected_level = levels
        .iter()
        .position(|level| *level == thinking)
        .unwrap_or(0);
    let catalog_connections = connections.clone();
    let effort = Select::new("agent-composer-thinking", level_choices, selected_level)
        .disabled(busy || levels.is_empty())
        .on_change(move |index, _, cx| {
            if let Some(level) = levels.get(index) {
                connections.update(cx, |connections, cx| {
                    connections.set_thinking(*level, cx);
                });
            }
        });
    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .w_full()
                .min_w_0()
                .max_w_full()
                .flex()
                .flex_col()
                .on_mouse_down(gpui::MouseButton::Left, move |_, _, cx| {
                    catalog_connections.update(cx, |connections, cx| {
                        for provider in PROVIDERS {
                            connections.load_catalog(provider, cx);
                        }
                    });
                })
                .child(model),
        )
        .child(
            div()
                .w_full()
                .min_w_0()
                .max_w_full()
                .flex()
                .flex_col()
                .child(effort),
        )
        .into_any_element()
}
