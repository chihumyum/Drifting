//! HC: the Agent's suggestion cards on Project Home (`kernel-v5.md` §15
//! #46, #47; `handoff/v5-tracks.md` HC). The app hands this view to
//! `dr_view_home::set_agent_cards`; Home places it below 继续写 and calls
//! [`HomeCards::shown`] when it comes to the front.
//!
//! Everything goes through the controller's existing suggestion API
//! (`suggestions`, `trigger_suggestions`, `open_suggestion`,
//! `dismiss_suggestion`, `set_proactive_enabled`); the controller keeps the
//! 90 minutes per book and device, and runs nothing without a model or with
//! 主动建议 off. Opening a card shows its new conversation in the right
//! sidebar's Agent; the card stays and reads 查看对话.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use dr_agent::proactive::{CardStatus, StoredCard};
use dr_i18n::keys::project_agent as k;
use dr_model::id::{BookId, ConversationId};
use dr_shell::{
    Settings, Workspace,
    settings::registry,
    strings::{t, tf},
};
use dr_ui::{
    Theme,
    components::{PanelIconButton, button::spinner},
    fonts::{Role, weight},
    glass,
    sand::{Icon, KindMark},
    style::DrStyled as _,
    tokens::radius,
};
use futures::{StreamExt as _, channel::mpsc};
use gpui::{
    App, Context, ElementId, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};
use serde_json::json;

use crate::{
    AgentViews,
    connection::Connections,
    controller::{AgentController, Subscription as RunSubscription, proactive::Suggestions},
    hub::AgentHub,
};

/// 设置 → 智能 → Agent → 主动建议 (on unless turned off; no settings in a
/// module's own tests: on).
pub fn proactive_enabled(cx: &App) -> bool {
    if cx.has_global::<Settings>() {
        Settings::read(cx).bool(registry::AGENT_PROACTIVE)
    } else {
        true
    }
}

pub struct HomeCards {
    ws: WeakEntity<Workspace>,
    hub: Option<Entity<AgentHub>>,
    connections: Option<Entity<Connections>>,
    controller: Option<AgentController>,
    book: Option<BookId>,
    suggestions: Option<Suggestions>,
    /// Cards clicked whose conversation is being started here.
    starting: HashSet<String>,
    /// 没能开始: why a card's conversation did not start.
    failed: HashMap<String, String>,
    /// Home asked for a look before the controller or the model's
    /// connection was ready (the app opening on Project Home): it is made
    /// once they are.
    wants_look: bool,
    loading: bool,
    again: bool,
    generation: u64,
    _run_subscription: Option<RunSubscription>,
    _signal: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl HomeCards {
    pub fn new(ws: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Self {
        let (hub, connections) = cx
            .try_global::<AgentViews>()
            .map(|v| (v.hub.clone(), v.connections.clone()))
            .unzip();
        let mut this = Self {
            ws: ws.clone(),
            hub: hub.clone(),
            connections: connections.clone(),
            controller: None,
            book: None,
            suggestions: None,
            starting: HashSet::new(),
            failed: HashMap::new(),
            wants_look: false,
            loading: false,
            again: false,
            generation: 0,
            _run_subscription: None,
            _signal: None,
            _subs: Vec::new(),
        };
        if let Some(hub) = &hub {
            this._subs
                .push(cx.observe(hub, |cards, _, cx| cards.bind_controller(cx)));
        }
        if let Some(connections) = &connections {
            this._subs.push(cx.observe(connections, |cards, _, cx| {
                cards.look(cx);
                cx.notify();
            }));
        }
        if let Some(ws) = ws.upgrade() {
            this._subs
                .push(cx.observe(&ws, |cards, _, cx| cards.follow_book(cx)));
        }
        this._subs.push(cx.observe_global::<Settings>(|cards, cx| {
            if let Some(controller) = &cards.controller {
                controller.set_proactive_enabled(proactive_enabled(cx));
            }
            cx.notify();
        }));
        this.follow_book(cx);
        this.bind_controller(cx);
        this
    }

    /// Whether there is anything to draw: 主动建议 on, a model connected, and
    /// a check-in under way, the last one failed, or cards.
    pub fn drawn(&self, cx: &App) -> bool {
        proactive_enabled(cx)
            && self.connected(cx)
            && self.controller.is_some()
            && self.suggestions.as_ref().is_some_and(|s| {
                s.state.active.is_some() || s.state.error.is_some() || !s.state.cards.is_empty()
            })
    }

    /// Home came to the front, or the window came back with Home in front:
    /// the controller looks unless it looked in the last 90 minutes, has no
    /// model, or 主动建议 is off.
    pub fn shown(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.follow_book(cx);
        self.wants_look = true;
        self.look(cx);
    }

    /// The look Home asked for, once the controller is there and the
    /// model's connection is known.
    fn look(&mut self, cx: &mut Context<Self>) {
        if !self.wants_look {
            return;
        }
        let (Some(controller), Some(book)) = (&self.controller, &self.book) else {
            return;
        };
        let on = proactive_enabled(cx);
        controller.set_proactive_enabled(on);
        let Some(connections) = self.connections.as_ref().filter(|_| on) else {
            self.wants_look = false;
            return;
        };
        if connections.read(cx).usable().is_none() {
            return;
        }
        self.wants_look = false;
        let config = connections.read(cx).run_config().ok();
        // The controller accepts and owns the operation before returning.
        drop(controller.trigger_suggestions(
            book.clone(),
            config,
            chrono::Utc::now().timestamp_millis(),
        ));
    }

    /// The suggestion state last read (tests).
    pub fn suggestions(&self) -> Option<&Suggestions> {
        self.suggestions.as_ref()
    }

    fn connected(&self, cx: &App) -> bool {
        self.connections
            .as_ref()
            .is_some_and(|c| c.read(cx).run_config().is_ok())
    }

    fn follow_book(&mut self, cx: &mut Context<Self>) {
        let book = self
            .ws
            .upgrade()
            .and_then(|ws| BookId::parse(&ws.read(cx).book_id).ok());
        if book == self.book {
            return;
        }
        self.book = book;
        // A look asked for another book is not this one's.
        self.wants_look = false;
        self.reset();
        self.refresh(cx);
    }

    fn bind_controller(&mut self, cx: &mut Context<Self>) {
        let controller = self
            .hub
            .as_ref()
            .and_then(|h| h.read(cx).controller.clone());
        self._run_subscription = None;
        self._signal = None;
        self.controller = controller;
        self.reset();
        if let Some(controller) = &self.controller {
            controller.set_proactive_enabled(proactive_enabled(cx));
            let (send, mut receive) = mpsc::unbounded();
            self._run_subscription = Some(controller.subscribe(Arc::new(move || {
                let _ = send.unbounded_send(());
            })));
            self._signal = Some(cx.spawn(async move |this, cx| {
                while receive.next().await.is_some() {
                    if this.update(cx, |cards, cx| cards.refresh(cx)).is_err() {
                        break;
                    }
                }
            }));
        }
        self.look(cx);
        self.refresh(cx);
        cx.notify();
    }

    fn reset(&mut self) {
        self.generation += 1;
        self.suggestions = None;
        self.starting.clear();
        self.failed.clear();
        self.loading = false;
        self.again = false;
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            self.again = true;
            return;
        }
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            cx.notify();
            return;
        };
        if controller.is_closed() {
            return;
        }
        self.loading = true;
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    controller.suggestions(&book, chrono::Utc::now().timestamp_millis())
                })
                .await;
            let _ = this.update(cx, |cards, cx| {
                if cards.generation != generation {
                    return;
                }
                cards.loading = false;
                match result {
                    Ok(suggestions) => {
                        cards.failed.retain(|id, _| {
                            suggestions.state.cards.iter().any(|c| &c.card.id == id)
                        });
                        cards.suggestions = Some(suggestions);
                    }
                    Err(error) => log::warn!("suggestion cards could not be read: {error}"),
                }
                if std::mem::take(&mut cards.again) {
                    cards.refresh(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open(&mut self, card: &StoredCard, window: &mut Window, cx: &mut Context<Self>) {
        match &card.status {
            CardStatus::Started { conversation } => {
                if let Ok(id) = ConversationId::parse(conversation) {
                    self.reveal(id, window, cx);
                }
            }
            CardStatus::Starting { .. } => {}
            CardStatus::Open => self.start(card.card.id.clone(), window, cx),
        }
    }

    fn start(&mut self, card: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.starting.contains(&card) {
            return;
        }
        let (Some(controller), Some(book), Some(connections)) = (
            self.controller.clone(),
            self.book.clone(),
            self.connections.clone(),
        ) else {
            return;
        };
        let mut config = match connections.read(cx).run_config() {
            Ok(config) => config,
            Err(error) => {
                self.failed.insert(card, error.to_string());
                cx.notify();
                return;
            }
        };
        let name = self
            .ws
            .upgrade()
            .map(|ws| ws.read(cx).book.name.clone())
            .unwrap_or_default();
        config.system_prompt = crate::prompt::system_prompt(book.as_str(), &name);
        self.failed.remove(&card);
        self.starting.insert(card.clone());
        let task = controller.open_suggestion(
            book,
            card.clone(),
            config,
            chrono::Utc::now().timestamp_millis(),
        );
        let generation = self.generation;
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |cards, window, cx| {
                if cards.generation != generation {
                    return;
                }
                cards.starting.remove(&card);
                match result {
                    Ok(id) => cards.reveal(id, window, cx),
                    Err(error) => {
                        cards.failed.insert(card, error);
                    }
                }
                cards.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The right sidebar opens on Agent, on `id`; Home does not move.
    fn reveal(&mut self, id: ConversationId, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(ws), Some(book)) = (self.ws.upgrade(), self.book.clone()) else {
            return;
        };
        if ws.read(cx).book_id != book.as_str() {
            return;
        }
        ws.update(cx, |ws, cx| {
            // A panel made for this reveal starts on the conversation the
            // book remembers.
            ws.set_book_memory(crate::panel::MEMORY, json!(id.as_str()), cx);
            ws.reveal_companion(window, cx);
        });
        for panel in crate::panels(cx) {
            panel.update(cx, |panel, cx| {
                panel.show_card_conversation(&self.ws, &book, id.clone(), cx)
            });
        }
    }

    fn dismiss(&mut self, card: String, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        // A card whose conversation is starting stays until the start
        // settles (the store keeps it too).
        let starting = self.starting.contains(&card)
            || self.suggestions.as_ref().is_some_and(|s| {
                s.state
                    .cards
                    .iter()
                    .any(|c| c.card.id == card && matches!(c.status, CardStatus::Starting { .. }))
            });
        if starting {
            return;
        }
        self.failed.remove(&card);
        // Gone at once; the stored card goes with the controller's write.
        if let Some(s) = &mut self.suggestions {
            s.state.cards.retain(|c| c.card.id != card);
        }
        let task = controller.dismiss_suggestion(book, card);
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                log::warn!("a suggestion card could not be dismissed: {error}");
            }
            let _ = this.update(cx, |cards, cx| cards.refresh(cx));
        })
        .detach();
        cx.notify();
    }

    fn card(
        &self,
        index: usize,
        stored: &StoredCard,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let id = stored.card.id.clone();
        let starting =
            self.starting.contains(&id) || matches!(stored.status, CardStatus::Starting { .. });
        let started = matches!(stored.status, CardStatus::Started { .. });
        // Its entry: the entry's own mark, grey, and its name.
        let target = stored.card.target.as_ref().and_then(|target| {
            let ws = self.ws.upgrade()?;
            let book = ws.read(cx).book.clone();
            let v3 = book.v3()?;
            let entry = v3.entry(&target.id)?;
            let mark = v3
                .appearance(&target.id)
                .map(|a| a.sand)
                .unwrap_or(dr_ui::sand::Kind::Element);
            Some(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(KindMark::new(
                        ElementId::Name(format!("home-agent-card-mark-{index}").into()),
                        mark,
                    ))
                    .child(entry.title.clone()),
            )
        });
        let go = t(
            cx,
            if started {
                k::OPEN_CONVERSATION
            } else {
                k::START
            },
        );
        let stored_card = stored.clone();
        let label: SharedString = stored.card.title.clone().into();
        let body = glass::glass_box(
            SharedString::from(format!("home-agent-card-{index}")),
            glass::Kind::Rest,
            glass::Mode {
                disabled: starting,
                ..Default::default()
            },
            false,
            glass::Spec::new(glass::Tone::Clear, radius::SM),
            window,
            cx,
        )
        .debug_selector(move || format!("home-agent-card-{index}"))
        .role(gpui::Role::Button)
        .aria_label(label)
        .w_full()
        .h_full()
        .rounded(px(radius::SM))
        .when(!starting, |el| el.cursor_pointer())
        .pt(px(12.0))
        .pb(px(12.0))
        .pl(px(14.0))
        .pr(px(34.0))
        .flex()
        .flex_col()
        .items_start()
        .gap(px(6.0))
        .children(target)
        .child(
            div()
                .font_role(Role::Ui)
                .type_px(s.emphasis, s.emphasis * 1.5)
                .text_color(p.ink(1).solid())
                .child(stored.card.title.clone()),
        )
        .when(!stored.card.detail.is_empty(), |el| {
            el.child(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.body, s.body * 1.5)
                    .text_color(p.ink(3).solid())
                    .child(stored.card.detail.clone()),
            )
        })
        .child(
            div()
                .mt_auto()
                .pt(px(2.0))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_caption)
                .weight(weight::MEDIUM)
                .text_color(p.ink(2).solid())
                .child(go),
        )
        .when(!starting, |el| {
            el.on_click(
                cx.listener(move |cards, _, window, cx| cards.open(&stored_card, window, cx)),
            )
        });
        let dismiss = id.clone();
        let close = div()
            .absolute()
            .top(px(6.0))
            .right(px(6.0))
            .occlude()
            .child(
                PanelIconButton::new(
                    ElementId::Name(format!("home-agent-card-dismiss-{index}").into()),
                    Icon::Close,
                )
                .label(t(cx, k::DISMISS))
                .on_click(cx.listener(move |cards, _, _, cx| cards.dismiss(dismiss.clone(), cx))),
            );
        let failed = self.failed.get(&id).map(|error| {
            div()
                .id(ElementId::Name(
                    format!("home-agent-card-failed-{index}").into(),
                ))
                .debug_selector(move || format!("home-agent-card-failed-{index}"))
                .pt(px(6.0))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_caption)
                .text_color(p.ink(3).solid())
                .child(tf(cx, k::START_FAILED, &[("error", error)]))
        });
        div()
            .min_w_0()
            .flex()
            .flex_col()
            .child(div().relative().flex_1().child(body).child(close))
            .children(failed)
            .into_any_element()
    }
}

impl Render for HomeCards {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut column = div()
            .id("home-agent-cards")
            .w_full()
            .flex()
            .flex_col()
            .gap(px(12.0));
        if !self.drawn(cx) {
            return column;
        }
        let Some(suggestions) = self.suggestions.clone() else {
            return column;
        };
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let line = |id: &'static str| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .flex()
                .items_center()
                .gap(px(8.0))
                .font_role(Role::Ui)
                .type_px(s.body, s.line_body)
                .text_color(p.ink(3).solid())
        };
        if suggestions.state.active.is_some() {
            column = column.child(
                line("home-agent-checking")
                    .child(spinner(13.0, p.ink(3).solid(), window))
                    .child(t(cx, k::CHECKIN_RUNNING)),
            );
        } else if let Some(error) = &suggestions.state.error {
            column = column.child(line("home-agent-check-failed").child(tf(
                cx,
                k::CHECKIN_FAILED,
                &[("error", error)],
            )));
        }
        if !suggestions.state.cards.is_empty() {
            let mut grid = div().w_full().grid().grid_cols(2).gap(px(10.0));
            for (index, stored) in suggestions.state.cards.iter().enumerate() {
                grid = grid.child(self.card(index, stored, window, cx));
            }
            column = column.child(grid);
        }
        column
    }
}
