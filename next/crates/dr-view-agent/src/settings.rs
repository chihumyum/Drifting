//! Agent-owned controls in the shell's declarative settings registry. The
//! shell owns account preference validation; this module owns model semantics
//! and the credential UI. No key is ever a settings value.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use dr_agent::Provider;
use dr_i18n::keys;
use dr_model::id::{BookId, ConversationId};
use dr_shell::{
    settings::{
        self,
        registry::{self, Section},
    },
    strings::{t, tf},
};
use dr_ui::{
    Theme,
    components::{Button, Choice, Dialog, IconButton, Layer, Place, Segmented, Select, float},
    fonts::{Role, weight},
    sand::Icon,
    style::DrStyled as _,
    tokens::radius,
};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, ParentElement, Render,
    SharedString, Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};

use crate::{
    connection::{Connections, PROVIDERS, Readiness, provider_name, thinking_levels},
    connection_view::{ConnectionView, thinking_label},
    controller::{AgentController, BookAgentUsage, Subscription as RunSubscription},
    hub::AgentHub,
    local_view::{self, LocalConnectionView},
    onboarding::{self, Event, Step},
    project_memory::ProjectMemoryView,
    state::ConversationSummary,
};

pub fn init(connections: Entity<Connections>, cx: &mut App) {
    let hub = cx
        .try_global::<crate::AgentViews>()
        .map(|views| views.hub.clone());
    init_with_hub(connections, hub, cx);
}

pub fn init_with_hub(
    connections: Entity<Connections>,
    hub: Option<Entity<AgentHub>>,
    cx: &mut App,
) {
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
    // 「本地模型」 under the four, after a hairline (作者 2026-11-16, 乙).
    {
        let connections = connections.clone();
        let views: Rc<RefCell<HashMap<gpui::WindowId, Entity<LocalConnectionView>>>> =
            Rc::default();
        let closed_views = views.clone();
        cx.on_window_closed(move |_, window| {
            closed_views.borrow_mut().remove(&window);
        })
        .detach();
        settings::set_module_row(cx, "models.local", move |window, cx| {
            let view = views
                .borrow_mut()
                .entry(window.window_handle().window_id())
                .or_insert_with(|| {
                    cx.new(|cx| LocalConnectionView::new(connections.clone(), true, window, cx))
                })
                .clone();
            div()
                .w_full()
                .child(local_view::divider(window, cx))
                .child(view)
                .into_any_element()
        });
    }
    for key in [
        registry::AGENT_PROVIDER,
        registry::AGENT_MODEL,
        registry::AGENT_MAX_MODEL_ROUNDS,
    ] {
        let connections = connections.clone();
        settings::set_module_row(cx, key, move |window, cx| {
            preference_control(key, connections.clone(), window, cx)
        });
    }
    // A local model has no reasoning level: the row is left out, as the
    // dropdown above the composer is (作者 2026-11-16, 乙).
    {
        let connections = connections.clone();
        settings::set_module_row_when(cx, registry::AGENT_THINKING, move |window, cx| {
            local_view::has_reasoning(connections.read(cx)).then(|| {
                preference_control(registry::AGENT_THINKING, connections.clone(), window, cx)
            })
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

    if let Some(hub) = hub {
        let usage_views: Rc<RefCell<HashMap<gpui::WindowId, Entity<AgentUsageSettingsView>>>> =
            Rc::default();
        let history_views: Rc<RefCell<HashMap<gpui::WindowId, Entity<AgentHistorySettingsView>>>> =
            Rc::default();
        let memory_views: Rc<RefCell<HashMap<gpui::WindowId, Entity<AgentMemorySettingsView>>>> =
            Rc::default();
        {
            let (u, h, m) = (
                usage_views.clone(),
                history_views.clone(),
                memory_views.clone(),
            );
            settings::on_panel_closed(cx, move |window, cx| {
                if let Some(view) = h.borrow().get(&window).cloned() {
                    view.update(cx, |view, cx| view.close(cx));
                }
                if let Some(view) = m.borrow().get(&window).cloned() {
                    view.update(cx, |view, cx| view.close(cx));
                }
                let _ = &u;
            });
        }
        {
            let (u, h, m) = (
                usage_views.clone(),
                history_views.clone(),
                memory_views.clone(),
            );
            cx.on_window_closed(move |_, window| {
                u.borrow_mut().remove(&window);
                h.borrow_mut().remove(&window);
                m.borrow_mut().remove(&window);
            })
            .detach();
        }
        {
            let hub = hub.clone();
            settings::set_module_row(cx, "agent.usage", move |window, cx| {
                usage_views
                    .borrow_mut()
                    .entry(window.window_handle().window_id())
                    .or_insert_with(|| cx.new(|cx| AgentUsageSettingsView::new(hub.clone(), cx)))
                    .clone()
                    .into_any_element()
            });
        }
        {
            let hub = hub.clone();
            settings::set_module_row(cx, "agent.history", move |window, cx| {
                history_views
                    .borrow_mut()
                    .entry(window.window_handle().window_id())
                    .or_insert_with(|| cx.new(|cx| AgentHistorySettingsView::new(hub.clone(), cx)))
                    .clone()
                    .into_any_element()
            });
        }
        {
            settings::set_module_row(cx, "agent.memory", move |window, cx| {
                memory_views
                    .borrow_mut()
                    .entry(window.window_handle().window_id())
                    .or_insert_with(|| cx.new(|cx| AgentMemorySettingsView::new(hub.clone(), cx)))
                    .clone()
                    .into_any_element()
            });
        }
    }
}

fn active_book(window: &Window, cx: &App) -> Option<BookId> {
    window
        .root::<dr_shell::Workspace>()
        .flatten()
        .and_then(|ws| {
            let w = ws.read(cx);
            (!w.shelf_open && !w.book_id.is_empty())
                .then(|| BookId::parse(&w.book_id).ok())
                .flatten()
        })
        .or_else(|| {
            cx.try_global::<dr_shell::Services>()
                .and_then(|s| s.book.as_deref())
                .and_then(|id| BookId::parse(id).ok())
        })
}

fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.2}M", n as f64 / 1_000_000.0)
    } else if n >= 10_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

struct AgentUsageSettingsView {
    hub: Entity<AgentHub>,
    book: Option<BookId>,
    month_scope: bool,
    stats: Option<BookAgentUsage>,
    loading: bool,
    serial: u64,
    _hub_sub: Subscription,
    _run_sub: Option<RunSubscription>,
}

impl AgentUsageSettingsView {
    fn new(hub: Entity<AgentHub>, cx: &mut Context<Self>) -> Self {
        let sub = cx.observe(&hub, |view, _, cx| {
            view.bind_subscription(cx);
            view.refresh(cx);
        });
        let mut view = Self {
            hub,
            book: None,
            month_scope: true,
            stats: None,
            loading: false,
            serial: 0,
            _hub_sub: sub,
            _run_sub: None,
        };
        view.bind_subscription(cx);
        view
    }

    fn bind_subscription(&mut self, cx: &mut Context<Self>) {
        self._run_sub = None;
        let Some(controller) = self.hub.read(cx).controller.clone() else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded();
        self._run_sub = Some(controller.subscribe(std::sync::Arc::new(move || {
            let _ = tx.unbounded_send(());
        })));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                if this.update(cx, |v, cx| v.refresh(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) =
            (self.hub.read(cx).controller.clone(), self.book.clone())
        else {
            self.stats = None;
            cx.notify();
            return;
        };
        if controller.is_closed() {
            return;
        }
        self.serial += 1;
        let serial = self.serial;
        self.loading = true;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { controller.usage_stats(&book) })
                .await;
            let _ = this.update(cx, |view, cx| {
                if view.serial != serial {
                    return;
                }
                view.loading = false;
                if let Ok(stats) = result {
                    view.stats = Some(stats);
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for AgentUsageSettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let current = active_book(window, cx);
        if current != self.book {
            self.book = current;
            self.stats = None;
            self.refresh(cx);
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let k = keys::settings::agent_usage::USAGE;
        let _ = k;
        if self.book.is_none() {
            return div()
                .py(px(8.0))
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::agent_usage::NO_PROJECT_USAGE))
                .into_any_element();
        }
        let scope_idx = usize::from(!self.month_scope);
        let scope_label = t(
            cx,
            if self.month_scope {
                keys::settings::agent_usage::MONTH
            } else {
                keys::settings::agent_usage::ALL
            },
        );
        let totals = self
            .stats
            .as_ref()
            .map(|st| if self.month_scope { &st.month } else { &st.all })
            .cloned()
            .unwrap_or_default();
        let me = cx.entity();
        div()
            .w_full()
            .py(px(8.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div().flex().items_center().justify_between().child(
                    Segmented::new(
                        "agent-usage-scope",
                        vec![
                            t(cx, keys::settings::agent_usage::MONTH),
                            t(cx, keys::settings::agent_usage::ALL),
                        ],
                        scope_idx,
                    )
                    .on_change(move |idx, _, cx| {
                        me.update(cx, |v, cx| {
                            v.month_scope = idx == 0;
                            cx.notify();
                        });
                    }),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(10.0))
                    .child(
                        div()
                            .flex_1()
                            .p(px(12.0))
                            .rounded(px(radius::MD))
                            .bg(p.paper.solid())
                            .border(px(0.5))
                            .border_color(p.hairline())
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.muted().solid())
                                    .child(tf(
                                        cx,
                                        keys::settings::agent_usage::TOKEN_CARD,
                                        &[("scope", &scope_label)],
                                    )),
                            )
                            .child(
                                div()
                                    .font_role(Role::Structure)
                                    .type_px(20.0, 26.0)
                                    .weight(weight::SEMIBOLD)
                                    .text_color(p.ink(1).solid())
                                    .child(format_tokens(totals.total_tokens)),
                            )
                            .child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.ink(3).solid())
                                    .child(format!(
                                        "{} in · {} out",
                                        format_tokens(totals.input_tokens),
                                        format_tokens(totals.output_tokens),
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .p(px(12.0))
                            .rounded(px(radius::MD))
                            .bg(p.paper.solid())
                            .border(px(0.5))
                            .border_color(p.hairline())
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.muted().solid())
                                    .child(t(cx, keys::settings::agent_usage::CONVERSATIONS_TURNS)),
                            )
                            .child(
                                div()
                                    .font_role(Role::Structure)
                                    .type_px(20.0, 26.0)
                                    .weight(weight::SEMIBOLD)
                                    .text_color(p.ink(1).solid())
                                    .child(format!("{} / {}", totals.conversations, totals.turns)),
                            ),
                    ),
            )
            .into_any_element()
    }
}

struct AgentHistorySettingsView {
    hub: Entity<AgentHub>,
    book: Option<BookId>,
    items: Vec<ConversationSummary>,
    confirm_clear: bool,
    busy: bool,
    serial: u64,
    _hub_sub: Subscription,
    _run_sub: Option<RunSubscription>,
}

impl AgentHistorySettingsView {
    fn new(hub: Entity<AgentHub>, cx: &mut Context<Self>) -> Self {
        let sub = cx.observe(&hub, |view, _, cx| {
            view.bind_subscription(cx);
            view.refresh(cx);
        });
        let mut view = Self {
            hub,
            book: None,
            items: Vec::new(),
            confirm_clear: false,
            busy: false,
            serial: 0,
            _hub_sub: sub,
            _run_sub: None,
        };
        view.bind_subscription(cx);
        view
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.confirm_clear = false;
        cx.notify();
    }

    fn bind_subscription(&mut self, cx: &mut Context<Self>) {
        self._run_sub = None;
        let Some(controller) = self.hub.read(cx).controller.clone() else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded();
        self._run_sub = Some(controller.subscribe(std::sync::Arc::new(move || {
            let _ = tx.unbounded_send(());
        })));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                if this.update(cx, |v, cx| v.refresh(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) =
            (self.hub.read(cx).controller.clone(), self.book.clone())
        else {
            self.items.clear();
            cx.notify();
            return;
        };
        if controller.is_closed() {
            return;
        }
        self.serial += 1;
        let serial = self.serial;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { controller.list(&book) })
                .await;
            let _ = this.update(cx, |view, cx| {
                if view.serial != serial {
                    return;
                }
                if let Ok(list) = result {
                    view.items = list;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn delete_one(&mut self, id: ConversationId, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let (Some(controller), Some(book)) =
            (self.hub.read(cx).controller.clone(), self.book.clone())
        else {
            return;
        };
        self.busy = true;
        cx.spawn(async move |this, cx| {
            let _ = cx
                .background_executor()
                .spawn(async move { controller.delete_conversation(&book, &id) })
                .await;
            let _ = this.update(cx, |view, cx| {
                view.busy = false;
                view.refresh(cx);
            });
        })
        .detach();
    }

    fn clear_all(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let (Some(controller), Some(book)) =
            (self.hub.read(cx).controller.clone(), self.book.clone())
        else {
            return;
        };
        self.busy = true;
        self.confirm_clear = false;
        cx.spawn(async move |this, cx| {
            let _ = cx
                .background_executor()
                .spawn(async move { controller.clear_history(&book) })
                .await;
            let _ = this.update(cx, |view, cx| {
                view.busy = false;
                view.refresh(cx);
            });
        })
        .detach();
    }
}

impl Render for AgentHistorySettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let current = active_book(window, cx);
        if current != self.book {
            self.book = current;
            self.items.clear();
            self.confirm_clear = false;
            self.refresh(cx);
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        if self.book.is_none() {
            return div()
                .py(px(8.0))
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::agent_usage::NO_PROJECT_HISTORY))
                .into_any_element();
        }
        if self.items.is_empty() {
            return div()
                .py(px(8.0))
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::agent_usage::NO_HISTORY))
                .into_any_element();
        }
        let untitled = t(cx, keys::settings::agent_usage::UNTITLED);
        let mut list = div().w_full().py(px(8.0)).flex().flex_col().gap(px(6.0));
        for item in &self.items {
            let id = item.id.clone();
            let clean = dr_shell::review_agent::clean_conversation_title(&item.title);
            let title: SharedString = if clean.trim().is_empty() {
                untitled.clone()
            } else {
                clean.to_owned().into()
            };
            let date_str = chrono::DateTime::from_timestamp_millis(item.last_created_ms)
                .map(|dt| {
                    dt.with_timezone(&chrono::Local)
                        .format("%Y-%m-%d %H:%M")
                        .to_string()
                })
                .unwrap_or_default();
            let me = cx.entity();
            list = list.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(px(radius::SM))
                    .bg(p.paper.solid())
                    .border(px(0.5))
                    .border_color(p.hairline())
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().truncate().text_color(p.ink(1).solid()).child(title))
                            .when(!date_str.is_empty(), |el| {
                                el.child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.muted().solid())
                                        .child(date_str),
                                )
                            }),
                    )
                    .child(
                        IconButton::new(
                            SharedString::from(format!("settings-agent-del-{}", item.id)),
                            Icon::Trash,
                        )
                        .label(t(cx, keys::settings::agent_usage::DELETE_CONVERSATION))
                        .on_click(move |_, _, cx| {
                            let id = id.clone();
                            me.update(cx, |view, cx| view.delete_one(id, cx));
                        }),
                    ),
            );
        }
        let me = cx.entity();
        list = list.child(
            div().pt(px(4.0)).child(
                Button::new(
                    "settings-agent-clear-history",
                    t(cx, keys::settings::agent_usage::CLEAR_HISTORY),
                )
                .small()
                .danger()
                .disabled(self.busy)
                .on_click(move |_, _, cx| {
                    me.update(cx, |view, cx| {
                        view.confirm_clear = true;
                        cx.notify();
                    });
                }),
            ),
        );
        if self.confirm_clear {
            let count = self.items.len();
            let prompt = tf(
                cx,
                keys::settings::agent_usage::CLEAR_CONFIRM,
                &[("count", &count)],
            );
            let cancel_ent = cx.entity();
            let ok_ent = cx.entity();
            let dismiss_ent = cx.entity();
            let dialog = Dialog::new(
                "settings-agent-clear-dialog",
                t(cx, keys::settings::agent_usage::CLEAR_HISTORY),
            )
            .body(div().child(prompt))
            .action(
                Button::new("settings-agent-clear-cancel", t(cx, keys::common::CANCEL))
                    .small()
                    .on_click(move |_, _, cx| {
                        cancel_ent.update(cx, |view, cx| {
                            view.confirm_clear = false;
                            cx.notify();
                        });
                    }),
            )
            .action(
                Button::new(
                    "settings-agent-clear-ok",
                    t(cx, keys::settings::agent_usage::CLEAR_HISTORY),
                )
                .small()
                .danger()
                .on_click(move |_, _, cx| {
                    ok_ent.update(cx, |view, cx| view.clear_all(cx));
                }),
            )
            .on_close(move |_, cx| {
                dismiss_ent.update(cx, |view, cx| {
                    view.confirm_clear = false;
                    cx.notify();
                });
            });
            list = list.child(float(Place::Center, Layer::Dialog, dialog));
        }
        list.into_any_element()
    }
}

struct AgentMemorySettingsView {
    hub: Entity<AgentHub>,
    book: Option<BookId>,
    controller: Option<AgentController>,
    inner: Option<Entity<ProjectMemoryView>>,
    _hub_sub: Subscription,
}

impl AgentMemorySettingsView {
    fn new(hub: Entity<AgentHub>, cx: &mut Context<Self>) -> Self {
        let sub = cx.observe(&hub, |view, _, cx| {
            view.reset_inner(cx);
            cx.notify();
        });
        Self {
            hub,
            book: None,
            controller: None,
            inner: None,
            _hub_sub: sub,
        }
    }

    fn reset_inner(&mut self, cx: &mut Context<Self>) {
        if let Some(view) = self.inner.take() {
            view.update(cx, |v, cx| v.close(cx));
        }
        self.controller = None;
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.reset_inner(cx);
        cx.notify();
    }
}

impl Render for AgentMemorySettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let current_book = active_book(window, cx);
        let current_ctrl = self.hub.read(cx).controller.clone();
        let needs_rebuild = current_book != self.book
            || current_ctrl.is_none() != self.controller.is_none()
            || (self.inner.is_none() && current_book.is_some() && current_ctrl.is_some());
        if needs_rebuild {
            self.reset_inner(cx);
            self.book = current_book.clone();
            self.controller = current_ctrl.clone();
            if let (Some(ctrl), Some(book)) = (current_ctrl, current_book) {
                self.inner = Some(cx.new(|cx| ProjectMemoryView::new(ctrl, book, window, cx)));
            }
        }
        let p = Theme::of(window, cx).palette;
        match &self.inner {
            Some(view) => div()
                .w_full()
                .max_h(px(360.0))
                .rounded(px(radius::MD))
                .border(px(0.5))
                .border_color(p.hairline())
                .overflow_hidden()
                .child(view.clone())
                .into_any_element(),
            None => div()
                .py(px(8.0))
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::agent_usage::NO_PROJECT_HISTORY))
                .into_any_element(),
        }
    }
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
            // A local server is chosen like a provider, by its own name.
            let providers: Vec<(Provider, Option<String>, String)> = PROVIDERS
                .into_iter()
                .filter(|provider| state.readiness(*provider) == Readiness::Ready)
                .map(|provider| (provider, None, provider_name(provider).to_owned()))
                .chain(
                    state
                        .local_servers()
                        .iter()
                        .filter(|server| !server.models.is_empty())
                        .map(|server| {
                            (
                                Provider::Local,
                                Some(server.id.clone()),
                                server.label.clone(),
                            )
                        }),
                )
                .collect();
            let current = state.preferences().route.provider;
            let current_server = state.preferences().local_server.clone();
            let selected = providers.iter().position(|(provider, server, _)| {
                *provider == current && (current != Provider::Local || *server == current_server)
            });
            let mut choices: Vec<_> = providers
                .iter()
                .map(|(_, _, name)| Choice::new(Icon::Thinking, name.clone()))
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
                    if let Some((provider, server, _)) = index
                        .checked_sub(offset)
                        .and_then(|index| providers.get(index))
                    {
                        connections.update(cx, |connections, cx| match server {
                            Some(server) => {
                                let model = connections
                                    .local_server(server)
                                    .and_then(|server| server.models.first())
                                    .map(|model| model.id.clone());
                                if let Some(model) = model {
                                    connections.select_local(server, &model, cx);
                                }
                            }
                            None => {
                                connections.select_provider(*provider, cx);
                                connections.load_catalog(*provider, cx);
                            }
                        });
                    }
                })
                .into_any_element()
        }
        registry::AGENT_MODEL => {
            let provider = state.preferences().route.provider;
            let local = (provider == Provider::Local)
                .then(|| {
                    state
                        .preferences()
                        .local_server
                        .as_deref()
                        .and_then(|id| state.local_server(id))
                })
                .flatten()
                .cloned();
            let models: Vec<_> = match &local {
                Some(server) => server
                    .models
                    .iter()
                    .map(|model| (model.id.clone(), model.id.clone()))
                    .collect(),
                None => state
                    .models(provider)
                    .iter()
                    .map(|model| (model.id.clone(), model.label.clone()))
                    .collect(),
            };
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
            let ready = local.is_some() || state.readiness(provider) == Readiness::Ready;
            let server = local.map(|server| server.id);
            Select::new(key, choices, selected.unwrap_or(0))
                .disabled(busy || !ready)
                .on_change(move |index, _, cx| {
                    if let Some((id, _)) = index
                        .checked_sub(offset)
                        .and_then(|index| models.get(index))
                    {
                        connections.update(cx, |connections, cx| match &server {
                            Some(server) => {
                                connections.select_local(server, id, cx);
                            }
                            None => {
                                connections.select_model(provider, id, cx);
                            }
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
