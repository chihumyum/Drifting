//! Agent-owned controls in the shell's declarative settings registry. The
//! shell owns account preference validation; this module owns model semantics
//! and the credential UI. No key is ever a settings value.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use dr_agent::Provider;
use dr_i18n::keys;
use dr_shell::{
    settings::{
        self,
        registry::{self, Section},
    },
    strings::{t, tf},
};
use dr_ui::components::{Button, Choice, Select};
use dr_ui::sand::Icon;
use gpui::{
    AnyElement, App, AppContext as _, Entity, IntoElement, ParentElement, Styled, Window, div, px,
};

use crate::{
    connection::{Connections, PROVIDERS, Readiness, provider_name, thinking_levels},
    connection_view::{ConnectionView, thinking_label},
    onboarding::{self, Event, Step},
};

pub fn init(connections: Entity<Connections>, cx: &mut App) {
    for (id, provider) in [
        ("models.chatgpt", Provider::Chatgpt),
        ("models.deepseek", Provider::Deepseek),
        ("models.anthropic", Provider::Anthropic),
        ("models.openai", Provider::Openai),
    ] {
        let connections = connections.clone();
        let views: Rc<RefCell<HashMap<gpui::WindowId, Entity<ConnectionView>>>> = Rc::default();
        let dismissed_views = views.clone();
        settings::on_panel_closed(cx, move |window, cx| {
            let view = dismissed_views.borrow().get(&window).cloned();
            if let Some(view) = view {
                view.update(cx, |view, cx| view.cancel_login(cx));
            }
        });
        let closed_views = views.clone();
        cx.on_window_closed(move |_, window| {
            closed_views.borrow_mut().remove(&window);
        })
        .detach();
        settings::set_module_row(cx, id, move |window, cx| {
            let view = views
                .borrow_mut()
                .entry(window.window_handle().window_id())
                .or_insert_with(|| {
                    cx.new(|cx| {
                        ConnectionView::for_settings(connections.clone(), provider, window, cx)
                    })
                })
                .clone();
            div().w_full().child(view).into_any_element()
        });
    }
    for key in [
        registry::AGENT_PROVIDER,
        registry::AGENT_MODEL,
        registry::AGENT_THINKING,
        registry::AGENT_MAX_MODEL_ROUNDS,
    ] {
        let connections = connections.clone();
        settings::set_module_row(cx, key, move |window, cx| {
            preference_control(key, connections.clone(), window, cx)
        });
    }
    settings::set_module_row(cx, "agent.onboarding", |_, cx| {
        div()
            .flex()
            .flex_wrap()
            .gap(px(8.0))
            .py(px(12.0))
            .child(
                Button::new(
                    "agent-manage-keys",
                    t(cx, keys::settings::common::MANAGE_KEYS),
                )
                .on_click(|_, window, cx| settings::open_section(Section::Models, window, cx)),
            )
            .child(
                Button::new(
                    "agent-reset-onboarding",
                    t(cx, keys::settings::agent::REPLAY_ONBOARDING),
                )
                .disabled(onboarding::step(cx) == Step::New)
                .on_click(|_, _, cx| onboarding::note(cx, Event::Reset)),
            )
            .into_any_element()
    });
}

fn preference_control(
    key: &'static str,
    connections: Entity<Connections>,
    _: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = connections.read(cx);
    let busy = state.operation.is_some();
    match key {
        registry::AGENT_PROVIDER => {
            let providers: Vec<_> = PROVIDERS
                .into_iter()
                .filter(|provider| state.readiness(*provider) == Readiness::Ready)
                .collect();
            let current = state.preferences().route.provider;
            let selected = providers.iter().position(|provider| *provider == current);
            let mut choices: Vec<_> = providers
                .iter()
                .map(|provider| Choice::new(Icon::Thinking, provider_name(*provider)))
                .collect();
            if selected.is_none() {
                choices.insert(
                    0,
                    Choice::new(
                        Icon::Thinking,
                        t(cx, keys::agent_panel::config::MODEL_UNAVAILABLE),
                    ),
                );
            }
            let offset = usize::from(selected.is_none());
            Select::new(key, choices, selected.unwrap_or(0))
                .disabled(busy || providers.is_empty())
                .on_change(move |index, _, cx| {
                    if let Some(provider) = index
                        .checked_sub(offset)
                        .and_then(|index| providers.get(index))
                    {
                        connections.update(cx, |connections, cx| {
                            connections.select_provider(*provider, cx);
                            connections.load_catalog(*provider, cx);
                        });
                    }
                })
                .into_any_element()
        }
        registry::AGENT_MODEL => {
            let provider = state.preferences().route.provider;
            let models: Vec<_> = state
                .models(provider)
                .iter()
                .map(|model| (model.id.clone(), model.label.clone()))
                .collect();
            let selected = models
                .iter()
                .position(|(id, _)| id == &state.preferences().route.model);
            let mut choices: Vec<_> = models
                .iter()
                .map(|(_, label)| Choice::new(Icon::Thinking, label.clone()))
                .collect();
            if selected.is_none() {
                choices.insert(
                    0,
                    Choice::new(
                        Icon::Thinking,
                        t(cx, keys::agent_panel::config::MODEL_UNAVAILABLE),
                    ),
                );
            }
            let offset = usize::from(selected.is_none());
            Select::new(key, choices, selected.unwrap_or(0))
                .disabled(busy || state.readiness(provider) != Readiness::Ready)
                .on_change(move |index, _, cx| {
                    if let Some((id, _)) = index
                        .checked_sub(offset)
                        .and_then(|index| models.get(index))
                    {
                        connections.update(cx, |connections, cx| {
                            connections.select_model(provider, id, cx);
                        });
                    }
                })
                .into_any_element()
        }
        registry::AGENT_THINKING => {
            let levels = state
                .selected_model()
                .map(thinking_levels)
                .unwrap_or_default();
            let selected = levels
                .iter()
                .position(|level| *level == state.preferences().route.thinking)
                .unwrap_or(0);
            let choices = levels
                .iter()
                .map(|level| Choice::new(Icon::Thinking, thinking_label(*level, cx)))
                .collect();
            Select::new(key, choices, selected)
                .disabled(busy || levels.is_empty())
                .on_change(move |index, _, cx| {
                    if let Some(level) = levels.get(index) {
                        connections.update(cx, |connections, cx| {
                            connections.set_thinking(*level, cx);
                        });
                    }
                })
                .into_any_element()
        }
        registry::AGENT_MAX_MODEL_ROUNDS => {
            let mut limits = vec![Some(25), Some(50), Some(100), Some(200), None];
            let current = state.preferences().max_model_rounds;
            if !limits.contains(&current) {
                limits.insert(0, current);
            }
            let selected = limits
                .iter()
                .position(|limit| *limit == current)
                .unwrap_or(0);
            let choices = limits
                .iter()
                .map(|limit| {
                    Choice::new(
                        Icon::Thinking,
                        match limit {
                            Some(value) => tf(
                                cx,
                                keys::settings::agent_limits::ITERATION_OPTION,
                                &[("value", value)],
                            ),
                            None => t(cx, keys::settings::agent_limits::UNLIMITED),
                        },
                    )
                })
                .collect();
            let control = Select::new(key, choices, selected).on_change(move |index, _, cx| {
                if let Some(rounds) = limits.get(index) {
                    connections.update(cx, |connections, cx| {
                        connections.set_max_model_rounds(*rounds, cx);
                    });
                }
            });
            let mut col = div().flex().flex_col().gap(px(4.0)).child(control);
            if current.is_none() {
                col = col.child(t(cx, keys::settings::agent_limits::UNLIMITED_HINT));
            }
            col.into_any_element()
        }
        _ => div().into_any_element(),
    }
}
