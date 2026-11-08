//! A pane is a view of a conversation. The application hub owns its runs.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use dr_agent::{AssistantMessage, ContentBlock, RequestId, Start, State};
use dr_i18n::Arg;
use dr_i18n::keys::agent_panel as k;
use dr_model::id::{BookId, ConversationId};
use dr_shell::{
    Workspace,
    nav::Open,
    strings::{t, tf},
};
use dr_ui::{
    Theme,
    components::Button,
    fonts::Role,
    glass,
    input::{FieldEvent, TextArea},
    sand,
    style::DrStyled as _,
    text,
};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Either, select},
};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use serde_json::json;

use crate::{
    connection::Connections,
    connection_view::{self, ConnectionView},
    controller::{AgentController, Subscription as RunSubscription},
    data,
    hub::AgentHub,
    onboarding::{self, StarterSource},
    state::{
        ChatMessage, ChatSnapshot, ConversationSummary, MessageContent, RunSnapshot, TranscriptItem,
    },
};

const MEMORY: &str = "agent.conversation";

struct Navigation {
    /// Dropping this ticket cancels the view-owned wait, independently of
    /// whether M18's globally cached view is ever rendered again.
    _cancel: oneshot::Sender<()>,
    review_pane: Option<dr_shell::panes::PaneId>,
}

pub struct AgentPanel {
    ws: WeakEntity<Workspace>,
    hub: Entity<AgentHub>,
    connections: Entity<Connections>,
    connect: Entity<ConnectionView>,
    composer: Entity<TextArea>,
    controller: Option<AgentController>,
    book: Option<BookId>,
    name: String,
    selected: Option<ConversationId>,
    fresh: bool,
    snapshot: Option<ChatSnapshot>,
    conversations: Vec<ConversationSummary>,
    starters: StarterSource,
    book_view: Option<std::rc::Rc<dr_shell::book::Book>>,
    show_list: bool,
    expanded: HashSet<String>,
    busy: bool,
    loading: bool,
    navigation: HashMap<u64, Navigation>,
    navigation_serial: u64,
    again: bool,
    generation: u64,
    error: Option<String>,
    scroll: ScrollHandle,
    _run_subscription: Option<RunSubscription>,
    _signal: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl AgentPanel {
    pub fn new(
        ws: WeakEntity<Workspace>,
        hub: Entity<AgentHub>,
        connections: Entity<Connections>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let composer = cx.new(|cx| {
            TextArea::new("agent-composer", window, cx)
                .framed(3.0)
                .placeholder(t(cx, k::composer::PLACEHOLDER))
        });
        let connect = cx.new(|cx| ConnectionView::new(connections.clone(), window, cx));
        let mut panel = Self {
            ws,
            hub: hub.clone(),
            connections: connections.clone(),
            connect: connect.clone(),
            composer: composer.clone(),
            controller: None,
            book: None,
            name: String::new(),
            selected: None,
            fresh: false,
            snapshot: None,
            conversations: Vec::new(),
            starters: StarterSource::default(),
            book_view: None,
            show_list: false,
            expanded: HashSet::new(),
            busy: false,
            loading: false,
            navigation: HashMap::new(),
            navigation_serial: 0,
            again: false,
            generation: 0,
            error: None,
            scroll: ScrollHandle::new(),
            _run_subscription: None,
            _signal: None,
            _subs: Vec::new(),
        };
        panel._subs.push(
            cx.subscribe_in(&composer, window, |panel, _, event, _, cx| {
                if matches!(event, FieldEvent::Submitted(_)) {
                    panel.send(cx);
                }
            }),
        );
        panel
            ._subs
            .push(cx.observe(&connections, |_, _, cx| cx.notify()));
        panel._subs.push(
            cx.subscribe_in(&connect, window, |panel, _, event, window, cx| {
                if *event == connection_view::ConnectionEvent::Connected {
                    panel.composer.focus_handle(cx).focus(window, cx);
                }
            }),
        );
        panel
            ._subs
            .push(cx.observe(&hub, |panel, _, cx| panel.bind_controller(cx)));
        // The companion factory runs inside Workspace::render. Read it only
        // after that render has returned, then follow its book selection.
        cx.spawn(async move |this, cx| {
            let _ = this.update(cx, |panel, cx| panel.follow(cx));
        })
        .detach();
        panel
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.follow_book(&ws, cx);
        self._subs
            .push(cx.observe(&ws, |panel, ws, cx| panel.follow_book(&ws, cx)));
        self.bind_controller(cx);
    }

    fn follow_book(&mut self, ws: &Entity<Workspace>, cx: &mut Context<Self>) {
        if !ws.read(cx).companion_visible(cx.entity_id()) {
            self.connect.update(cx, |view, cx| view.cancel_login(cx));
        }
        let state = ws.read(cx);
        let navigating = self.navigation.len();
        self.navigation.retain(|_, request| {
            request
                .review_pane
                .is_none_or(|pane| state.review_visible(pane))
        });
        let cancelled = self.navigation.len() != navigating;
        let book = BookId::parse(&state.book_id).ok();
        let changed = self
            .book_view
            .as_ref()
            .is_none_or(|old| !std::rc::Rc::ptr_eq(old, &state.book));
        self.book_view = Some(state.book.clone());
        if book == self.book {
            self.name = state.book.name.clone();
            if self.selected.is_none()
                && !self.fresh
                && state.book_memory_ready()
                && let Some(id) = state
                    .book_memory(MEMORY)
                    .and_then(|v| v.as_str())
                    .and_then(|id| ConversationId::parse(id).ok())
            {
                self.selected = Some(id);
                self.invalidate();
                self.refresh(cx);
            }
            if changed
                && self
                    .snapshot
                    .as_ref()
                    .is_none_or(|snapshot| snapshot.messages.is_empty())
            {
                self.starters = StarterSource::default();
                self.refresh(cx);
            }
            if cancelled {
                cx.notify();
            }
            return;
        }
        self.book = book;
        self.name = state.book.name.clone();
        self.selected = state
            .book_memory(MEMORY)
            .and_then(|v| v.as_str())
            .and_then(|id| ConversationId::parse(id).ok());
        self.fresh = false;
        self.snapshot = None;
        self.conversations.clear();
        self.starters = StarterSource::default();
        self.composer.update(cx, |field, cx| field.set_text("", cx));
        self.invalidate();
        self.refresh(cx);
    }

    fn bind_controller(&mut self, cx: &mut Context<Self>) {
        self._run_subscription = None;
        self._signal = None;
        self.controller = self.hub.read(cx).controller.clone();
        self.invalidate();
        if let Some(controller) = &self.controller {
            let (send, mut receive) = mpsc::unbounded();
            self._run_subscription = Some(controller.subscribe(Arc::new(move || {
                let _ = send.unbounded_send(());
            })));
            self._signal = Some(cx.spawn(async move |this, cx| {
                while receive.next().await.is_some() {
                    if this.update(cx, |panel, cx| panel.refresh(cx)).is_err() {
                        break;
                    }
                }
            }));
        }
        self.refresh(cx);
        cx.notify();
    }

    fn invalidate(&mut self) {
        self.generation += 1;
        self.navigation.clear();
        self.busy = false;
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
        let selected = self.selected.clone();
        let generation = self.generation;
        let need_starters = self.starters.chapters.is_empty()
            && self.snapshot.as_ref().is_none_or(|s| s.messages.is_empty());
        self.loading = true;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let list = controller.list(&book)?;
                    let snapshot = selected
                        .as_ref()
                        .map(|id| controller.snapshot(&book, id))
                        .transpose()?;
                    let starters = if need_starters {
                        controller
                            .with_workspace_read(|lib| data::starters(lib, book.as_str()))
                            .ok()
                    } else {
                        None
                    };
                    Ok::<_, String>((list, snapshot, starters))
                })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.loading = false;
                match result {
                    Ok((list, snapshot, starters)) => {
                        if let Some(ws) = panel
                            .ws
                            .upgrade()
                            .filter(|ws| ws.read(cx).book_memory_ready())
                        {
                            let remembered = ws
                                .read(cx)
                                .book_memory(MEMORY)
                                .and_then(|value| value.as_str())
                                .is_some_and(|id| list.iter().any(|item| item.id.as_str() == id));
                            onboarding::migrate_existing(cx, remembered);
                        }
                        let follow = panel.snapshot.is_none()
                            || panel.scroll.max_offset().y + panel.scroll.offset().y < px(30.);
                        panel.conversations = list;
                        panel.snapshot = snapshot;
                        if follow {
                            panel.scroll.scroll_to_bottom();
                        }
                        if let Some(starters) = starters {
                            panel.starters = starters;
                        }
                        if panel.selected.is_none()
                            && !panel.fresh
                            && let Some(first) = panel.conversations.first()
                        {
                            panel.selected = Some(first.id.clone());
                            panel.again = true;
                        }
                    }
                    Err(error) => panel.error = Some(error),
                }
                if std::mem::take(&mut panel.again) {
                    panel.refresh(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn remember(&self, cx: &mut App) {
        if let (Some(ws), Some(id)) = (self.ws.upgrade(), &self.selected) {
            if self.book.as_ref().map(BookId::as_str) != Some(ws.read(cx).book_id.as_str()) {
                return;
            }
            let value = json!(id.as_str());
            ws.update(cx, |ws, cx| ws.set_book_memory(MEMORY, value, cx));
        }
    }

    pub fn new_conversation(&mut self, cx: &mut Context<Self>) {
        self.selected = None;
        self.fresh = true;
        self.snapshot = None;
        self.show_list = false;
        self.starters = StarterSource::default();
        self.error = None;
        self.expanded.clear();
        self.invalidate();
        self.composer.update(cx, |field, cx| field.set_text("", cx));
        self.refresh(cx);
        cx.notify();
    }

    pub fn select_conversation(&mut self, id: ConversationId, cx: &mut Context<Self>) {
        self.selected = Some(id);
        self.fresh = false;
        self.show_list = false;
        self.snapshot = None;
        self.error = None;
        self.expanded.clear();
        self.invalidate();
        self.remember(cx);
        self.refresh(cx);
    }

    pub fn snapshot(&self) -> Option<&ChatSnapshot> {
        self.snapshot.as_ref()
    }
    pub fn composer(&self) -> Entity<TextArea> {
        self.composer.clone()
    }
    pub fn is_settled(&self) -> bool {
        !self.busy && !self.loading && self.navigation.is_empty() && self.active().is_none()
    }
    pub fn active(&self) -> Option<&RunSnapshot> {
        self.snapshot
            .as_ref()?
            .runs
            .iter()
            .rev()
            .find(|run| !run.state.is_terminal())
    }

    pub fn send(&mut self, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).text();
        if text.trim().is_empty() || self.busy || dr_shell::release::is_releasing(cx) {
            return;
        }
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        if let Some(run) = self.active() {
            if let Some(control) = controller.control(&run.session) {
                let question = run.question.clone();
                let submitted = text.clone();
                self.control(
                    async move {
                        if let Some(question) = question {
                            control.answer(question.request, json!(text)).await
                        } else {
                            control.steer(text).await
                        }
                    }
                    .boxed(),
                    Some(submitted),
                    cx,
                );
            }
            return;
        }
        let mut config = match self.connections.read(cx).run_config() {
            Ok(config) => config,
            Err(error) => {
                self.error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        config.system_prompt = crate::prompt::system_prompt(book.as_str(), &self.name);
        let conversation = self.selected.clone().unwrap_or_else(ConversationId::new_v7);
        let generation = self.generation;
        let start = Start {
            config,
            book,
            conversation: conversation.clone(),
            input: text.clone(),
        };
        self.busy = true;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { controller.start(start) })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.busy = false;
                match result {
                    Ok(_) => {
                        panel.selected = Some(conversation);
                        panel.fresh = false;
                        panel.error = None;
                        panel.composer.update(cx, |field, cx| {
                            if field.text() == text {
                                field.set_text("", cx);
                            }
                        });
                        panel.remember(cx);
                        onboarding::note(cx, onboarding::Event::Sent);
                    }
                    Err(error) => panel.error = Some(error),
                }
                panel.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn control(
        &mut self,
        action: BoxFuture<'static, dr_agent::Result<()>>,
        clear: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.busy = true;
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let result = action.await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.busy = false;
                match result {
                    Ok(()) => {
                        panel.error = None;
                        if let Some(submitted) = clear {
                            panel.composer.update(cx, |f, cx| {
                                if f.text() == submitted {
                                    f.set_text("", cx);
                                }
                            });
                        }
                    }
                    Err(error) => panel.error = Some(error.to_string()),
                }
                panel.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(control) = self
            .active()
            .and_then(|r| self.controller.as_ref()?.control(&r.session))
        {
            self.control(
                async move { control.stop_after_tool().await }.boxed(),
                None,
                cx,
            );
        }
    }

    fn answer(&mut self, request: RequestId, value: String, cx: &mut Context<Self>) {
        if let Some(control) = self
            .controller
            .as_ref()
            .and_then(|c| c.control(&request.session))
        {
            self.control(
                async move { control.answer(request, json!(value)).await }.boxed(),
                None,
                cx,
            );
        }
    }

    fn permit(&mut self, request: RequestId, allow: bool, cx: &mut Context<Self>) {
        if let Some(control) = self
            .controller
            .as_ref()
            .and_then(|c| c.control(&request.session))
        {
            self.control(
                async move { control.permit(request, allow).await }.boxed(),
                None,
                cx,
            );
        }
    }

    fn change(
        &mut self,
        change: &data::ChangeTarget,
        history: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        let (generation, change) = (self.generation, change.clone());
        // A later author click owns navigation, including while an earlier
        // target is still resolving on a worker.
        self.navigation.clear();
        self.navigation_serial += 1;
        let navigation = self.navigation_serial;
        let (cancel, cancelled) = oneshot::channel();
        self.navigation.insert(
            navigation,
            Navigation {
                _cancel: cancel,
                review_pane: None,
            },
        );
        cx.spawn_in(window, async move |this, cx| {
            enum Opened {
                Page,
                Review(oneshot::Receiver<bool>, dr_shell::panes::PaneId),
            }
            let (reader, owner) = (controller.clone(), book.clone());
            let resolved = cx
                .background_executor()
                .spawn(async move {
                    reader.with_workspace_read(|ws| {
                        data::resolve_change(ws, owner.as_str(), &change, history)
                    })
                })
                .await;
            let opened = this
                .update_in(cx, |panel, window, cx| {
                    if panel.generation != generation
                        || panel.book.as_ref() != Some(&book)
                        || controller.is_closed()
                        || !panel.navigation.contains_key(&navigation)
                    {
                        return None;
                    }
                    let (Ok(location), Some(ws)) = (resolved, panel.ws.upgrade()) else {
                        return None;
                    };
                    let opened = ws.update(cx, |ws, cx| {
                        if ws.book_id != book.as_str() || ws.book.id != book.as_str() {
                            return None;
                        }
                        match location {
                            data::ChangeLocation::Home => {
                                ws.open_home(cx);
                                Some(Opened::Page)
                            }
                            data::ChangeLocation::Page(target) => {
                                ws.book.entry(&target)?;
                                ws.super_view = None;
                                ws.open(target, Open::KEEP, cx);
                                Some(Opened::Page)
                            }
                            data::ChangeLocation::Comment { id, target } => {
                                let revealed = ws.reveal_comment(&id, target, window, cx)?;
                                Some(Opened::Review(revealed, ws.right.panes.focused))
                            }
                            data::ChangeLocation::History { doc, name, target } => {
                                ws.book.entry(&target)?;
                                ws.open_history(doc, &name, window, cx);
                                Some(Opened::Page)
                            }
                        }
                    });
                    if let Some(Opened::Review(_, pane)) = &opened
                        && let Some(request) = panel.navigation.get_mut(&navigation)
                    {
                        request.review_pane = Some(*pane);
                    }
                    opened
                })
                .ok()
                .flatten();
            let opened = match opened {
                Some(Opened::Page) => true,
                Some(Opened::Review(revealed, _)) => {
                    matches!(
                        select(revealed, cancelled).await,
                        Either::Left((Ok(true), _))
                    )
                }
                None => false,
            };
            this.update_in(cx, |panel, _, cx| {
                let current = panel.navigation.remove(&navigation);
                cx.notify();
                if let Some(request) = current
                    && opened
                    && panel.generation == generation
                    && panel.book.as_ref() == Some(&book)
                    && !controller.is_closed()
                    && panel.ws.upgrade().is_some_and(|ws| {
                        let ws = ws.read(cx);
                        ws.book_id == book.as_str()
                            && ws.book.id == book.as_str()
                            && request
                                .review_pane
                                .is_none_or(|pane| ws.review_visible(pane))
                    })
                {
                    onboarding::note(cx, onboarding::Event::ChangeSeen);
                }
            })
            .ok();
        })
        .detach();
    }

    fn toggle(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.expanded.remove(&id) {
            self.expanded.insert(id);
        }
        cx.notify();
    }
}

use futures::FutureExt as _;

impl AgentPanel {
    fn disclosure(
        &self,
        key: String,
        label: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let open = self.expanded.contains(&key);
        let click = key.clone();
        let keyboard = key.clone();
        let accessible = key.clone();
        let panel = cx.entity().downgrade();
        let p = Theme::of(window, cx).palette;
        div()
            .id(SharedString::from(key.clone()))
            .debug_selector(|| key)
            .role(gpui::Role::Button)
            .aria_label(label)
            .aria_expanded(open)
            .tab_index(0)
            .cursor_pointer()
            .rounded(px(4.))
            .focus(|el| el.bg(p.paper.solid()))
            .on_click(cx.listener(move |panel, _, _, cx| panel.toggle(click.clone(), cx)))
            .on_key_down(
                cx.listener(move |panel, event: &gpui::KeyDownEvent, _, cx| {
                    let modifiers = &event.keystroke.modifiers;
                    if modifiers.control
                        || modifiers.alt
                        || modifiers.platform
                        || modifiers.function
                        || modifiers.shift
                    {
                        return;
                    }
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        cx.stop_propagation();
                        panel.toggle(keyboard.clone(), cx);
                    }
                }),
            )
            .on_a11y_action(gpui::AccessibleAction::Click, move |_, _, cx| {
                let _ = panel.update(cx, |panel, cx| panel.toggle(accessible.clone(), cx));
            })
    }

    fn assistant(
        &self,
        id: &str,
        message: &AssistantMessage,
        running: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let mut column = div().flex().flex_col().gap(px(10.)).min_w_0();
        for block in &message.blocks {
            match block {
                ContentBlock::Text { text, .. } => {
                    column = column.child(text::wrapped(text.clone()))
                }
                ContentBlock::Thinking { index, text, .. } => {
                    let key = format!("{id}:thinking:{index}");
                    let open = self.expanded.contains(&key);
                    let label = t(
                        cx,
                        if running {
                            k::thinking::STREAMING
                        } else {
                            k::thinking::DONE
                        },
                    );
                    column = column.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .child(
                                self.disclosure(key.clone(), label.clone(), window, cx)
                                    .flex()
                                    .items_center()
                                    .gap(px(7.))
                                    .cursor_pointer()
                                    .text_color(p.ink(3).solid())
                                    .child(sand::thinking(
                                        16.,
                                        p.ink(3).solid(),
                                        running && !theme.reduce_motion,
                                        window,
                                    ))
                                    .child(label),
                            )
                            .when(open, |el| {
                                el.child(
                                    div()
                                        .id(SharedString::from(format!("{key}:content")))
                                        .debug_selector(|| format!("{key}:content"))
                                        .text_color(p.ink(3).solid())
                                        .child(text::wrapped(text.clone())),
                                )
                            }),
                    );
                }
                ContentBlock::ToolCall { call } => {
                    let key = format!("{id}:tool:{}", call.id);
                    let open = self.expanded.contains(&key);
                    let label = SharedString::from(data::tool_name(call).to_owned());
                    column = column.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(5.))
                            .child(
                                self.disclosure(key.clone(), label.clone(), window, cx)
                                    .text_color(p.ink(3).solid())
                                    .child(label),
                            )
                            .when(open, |el| {
                                el.child(
                                    div()
                                        .id(SharedString::from(format!("{key}:content")))
                                        .debug_selector(|| format!("{key}:content"))
                                        .child(text::wrapped(data::result_text(&call.arguments))),
                                )
                            }),
                    );
                }
            }
        }
        column.into_any_element()
    }

    fn message(
        &self,
        message: &ChatMessage,
        assistant_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let p = Theme::of(window, cx).palette;
        let mut row = div()
            .id(SharedString::from(format!("agent-message-{}", message.id)))
            .debug_selector(|| format!("agent-message-{}", message.id))
            .min_w_0();
        match &message.content {
            MessageContent::User { text } => {
                row = row
                    .p(px(12.))
                    .rounded(px(12.))
                    .bg(p.paper.solid())
                    .child(text::wrapped(text.clone()))
            }
            MessageContent::Assistant { message: assistant } => {
                row = row.child(self.assistant(assistant_id, assistant, false, window, cx))
            }
            MessageContent::ToolResult {
                call,
                status,
                output,
            } => {
                let key = format!("result:{}", message.id);
                let open = self.expanded.contains(&key);
                let label = format!("{} · {}", t(cx, k::tool::RESULT), call);
                row = row
                    .text_color(if *status == dr_agent::ToolStatus::Error {
                        p.danger.solid()
                    } else {
                        p.ink(3).solid()
                    })
                    .child(
                        self.disclosure(key.clone(), label.clone().into(), window, cx)
                            .child(label),
                    )
                    .when(open, |el| {
                        el.child(
                            div()
                                .id(SharedString::from(format!("{key}:content")))
                                .debug_selector(|| format!("{key}:content"))
                                .child(text::wrapped(data::result_text(output))),
                        )
                    });
            }
            MessageContent::Other { payload, .. } => {
                let text = payload["text"]
                    .as_str()
                    .or_else(|| payload["error"].as_str())?;
                row = row.child(text::wrapped(text.to_owned()));
            }
        }
        Some(row.into_any_element())
    }

    fn run(
        &self,
        run: &RunSnapshot,
        turn: u32,
        live_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let mut column = div().flex().flex_col().gap(px(18.)).min_w_0();
        let latest_finished = self.snapshot.as_ref().and_then(|snapshot| {
            snapshot
                .runs
                .iter()
                .rev()
                .find(|run| run.state.is_terminal())
                .map(|run| (run.session.as_str(), run.turn))
        });
        if turn == run.turn
            && let Some(live) = &run.live_message
        {
            column = column.child(
                div()
                    .id(SharedString::from(format!(
                        "agent-live-{}-{turn}",
                        run.session
                    )))
                    .debug_selector(|| format!("agent-live-{}-{turn}", run.session))
                    .child(self.assistant(live_id, live, !run.state.is_terminal(), window, cx)),
            );
        }
        for activity in run
            .provider_tools
            .iter()
            .filter(|activity| run.provider_tool_turns.get(&activity.id) == Some(&turn))
        {
            let label = activity
                .query
                .as_ref()
                .or(activity.url.as_ref())
                .cloned()
                .unwrap_or_default();
            let url = activity.url.as_deref().and_then(data::web_url);
            column = column.child(
                div()
                    .id(SharedString::from(format!(
                        "provider-tool-{}-{}",
                        run.session, activity.id
                    )))
                    .debug_selector(|| format!("provider-tool-{}-{}", run.session, activity.id))
                    .flex()
                    .gap(px(8.))
                    .p(px(10.))
                    .rounded(px(10.))
                    .bg(p.paper.solid())
                    .text_color(if activity.status == dr_agent::ProviderToolStatus::Failed {
                        p.danger.solid()
                    } else {
                        p.ink(3).solid()
                    })
                    .child(sand::icon(sand::Icon::Search, 16., p.ink(3).solid()))
                    .child(text::wrapped(label))
                    .when_some(url, |el, url| {
                        el.cursor_pointer()
                            .on_click(move |_, _, cx| cx.open_url(&url))
                    }),
            );
        }
        if let Some(question) = &run.question
            && question.request.turn == turn
        {
            let mut card = div()
                .id("agent-question")
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .rounded(px(12.))
                .bg(p.paper.solid())
                .child(div().child(t(cx, k::control::QUESTION_TITLE)))
                .child(text::wrapped(question.question.prompt.clone()));
            for (index, option) in question.question.options.iter().enumerate() {
                let request = question.request.clone();
                let answer = option.clone();
                card = card.child(
                    Button::new(("agent-answer", index), option.clone())
                        .small()
                        .disabled(self.busy)
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.answer(request.clone(), answer.clone(), cx)
                        })),
                );
            }
            column = column.child(card);
        }
        for question in run
            .questions
            .iter()
            .filter(|question| question.request.turn == turn)
        {
            if run
                .question
                .as_ref()
                .is_some_and(|pending| pending.request == question.request)
            {
                continue;
            }
            column = column.child(
                div()
                    .id(SharedString::from(format!(
                        "agent-question-history-{}",
                        question.request.nonce
                    )))
                    .debug_selector(|| format!("agent-question-history-{}", question.request.nonce))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .p(px(12.))
                    .rounded(px(12.))
                    .bg(p.paper.solid())
                    .child(t(cx, k::control::QUESTION_TITLE))
                    .child(text::wrapped(question.question.prompt.clone()))
                    .when_some(question.answer.as_ref(), |el, answer| {
                        el.child(text::wrapped(
                            answer
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| data::result_text(answer)),
                        ))
                    }),
            );
        }
        if let Some(permission) = &run.permission
            && permission.request.turn == turn
        {
            let request = permission.request.clone();
            let deny = request.clone();
            column = column.child(
                div()
                    .id("agent-permission")
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .p(px(12.))
                    .rounded(px(12.))
                    .bg(p.paper.solid())
                    .child(t(cx, k::control::PERMISSION_TITLE))
                    .child(data::tool_name(&permission.call).to_owned())
                    .child(text::wrapped(data::result_text(&permission.call.arguments)))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(
                                Button::new("agent-deny", t(cx, k::control::DENY))
                                    .small()
                                    .disabled(self.busy)
                                    .on_click(cx.listener(move |panel, _, _, cx| {
                                        panel.permit(deny.clone(), false, cx)
                                    })),
                            )
                            .child(
                                Button::new("agent-allow", t(cx, k::control::allow::ONCE))
                                    .small()
                                    .primary()
                                    .disabled(self.busy)
                                    .on_click(cx.listener(move |panel, _, _, cx| {
                                        panel.permit(request.clone(), true, cx)
                                    })),
                            ),
                    ),
            );
        }
        if turn == run.turn && run.state == State::Interrupted {
            column = column.child(
                div()
                    .id("agent-interrupted")
                    .p(px(12.))
                    .rounded(px(12.))
                    .bg(p.paper.solid())
                    .child(t(cx, k::control::RECOVERED_TITLE)),
            );
        }
        for steering in run
            .unapplied_steering
            .iter()
            .filter(|steering| steering.turn == turn)
        {
            column = column.child(
                div()
                    .id(SharedString::from(format!(
                        "agent-steering-{}",
                        steering.id
                    )))
                    .p(px(10.))
                    .rounded(px(10.))
                    .bg(p.paper.solid())
                    .child(
                        div()
                            .text_color(p.ink(3).solid())
                            .child(t(cx, k::composer::STEER)),
                    )
                    .child(text::wrapped(steering.text.clone())),
            );
        }
        if turn == run.turn
            && let Some(error) = &run.error
        {
            column = column.child(
                div()
                    .text_color(p.danger.solid())
                    .child(text::wrapped(error.clone())),
            );
        }
        let targets = data::change_targets(run, turn);
        for (index, target) in targets.iter().enumerate() {
            let doc = target.clone();
            let history = target.clone();
            let waiting = onboarding::waits_on_change(onboarding::step(cx), run.changes.len())
                && latest_finished == Some((run.session.as_str(), turn));
            let first_change = index == 0;
            let label = t(cx, k::TURN_CHANGES);
            column = column.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .child(
                        glass::glass_box(
                            SharedString::from(format!(
                                "agent-change-{}-{turn}-{}",
                                run.session,
                                doc.key()
                            )),
                            glass::Kind::Rest,
                            glass::Mode {
                                waiting,
                                ..Default::default()
                            },
                            false,
                            glass::Spec::new(
                                if waiting {
                                    glass::Tone::Accent
                                } else {
                                    glass::Tone::Clear
                                },
                                8.,
                            ),
                            window,
                            cx,
                        )
                        .role(gpui::Role::Button)
                        .debug_selector(|| {
                            format!("agent-change-{}-{turn}-{}", run.session, target.key())
                        })
                        .aria_label(label.clone())
                        .cursor_pointer()
                        .px(px(8.))
                        .py(px(5.))
                        .child(label)
                        .on_click(cx.listener(
                            move |panel, _, window, cx| panel.change(&doc, false, window, cx),
                        )),
                    )
                    .when(waiting && first_change && target.history.is_some(), |el| {
                        el.child(
                            div()
                                .debug_selector(|| {
                                    format!(
                                        "agent-history-{}-{turn}-{}",
                                        run.session,
                                        history.key()
                                    )
                                })
                                .child(
                                    Button::new(
                                        SharedString::from(format!(
                                            "agent-history-{}-{turn}-{}",
                                            run.session,
                                            history.key()
                                        )),
                                        t(cx, k::onboarding::HISTORY),
                                    )
                                    .text()
                                    .small()
                                    .on_click(cx.listener(
                                        move |panel, _, window, cx| {
                                            panel.change(&history, true, window, cx)
                                        },
                                    )),
                                ),
                        )
                    }),
            );
        }
        column.into_any_element()
    }

    fn transcript(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut column = div().flex().flex_col().gap(px(18.)).min_w_0();
        let Some(snapshot) = self.snapshot.clone() else {
            return column.into_any_element();
        };
        let mut assistants: HashMap<(&str, u32), usize> = HashMap::new();
        for item in snapshot.transcript() {
            match item {
                TranscriptItem::Message(message) => {
                    let ordinal = assistants
                        .entry((&message.session, message.turn))
                        .or_default();
                    let id = format!("assistant:{}:{}:{ordinal}", message.session, message.turn);
                    if matches!(message.content, MessageContent::Assistant { .. }) {
                        *ordinal += 1;
                    }
                    if let Some(row) = self.message(message, &id, window, cx) {
                        column = column.child(row);
                    }
                }
                TranscriptItem::Run { run, turn } => {
                    let ordinal = assistants
                        .get(&(run.session.as_str(), turn))
                        .copied()
                        .unwrap_or(0);
                    let id = format!("assistant:{}:{turn}:{ordinal}", run.session);
                    column = column.child(self.run(run, turn, &id, window, cx));
                }
            }
        }
        column.into_any_element()
    }
}

impl Render for AgentPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let active = self.active().cloned();
        let empty = self
            .snapshot
            .as_ref()
            .is_none_or(|s| s.messages.is_empty() && s.runs.is_empty())
            && !self.busy;
        let mut content = div().flex().flex_col().gap(px(12.)).min_w_0();
        if self.show_list {
            if self.conversations.is_empty() {
                content = content.child(t(cx, k::history::EMPTY));
            }
            for (index, item) in self.conversations.iter().enumerate() {
                let id = item.id.clone();
                let title = if item.title.is_empty() {
                    t(cx, k::history::UNTITLED)
                } else {
                    item.title.clone().into()
                };
                content = content.child(
                    Button::new(("agent-conversation", index), title)
                        .text()
                        .full_width()
                        .on_click(cx.listener(move |panel, _, _, cx| {
                            panel.select_conversation(id.clone(), cx)
                        })),
                );
            }
        } else if empty {
            match onboarding::resolve_view(
                onboarding::step(cx),
                self.connections.read(cx).usable(),
                true,
            ) {
                Some(onboarding::View::Connect) => content = content.child(self.connect.clone()),
                Some(onboarding::View::Suggest) => {
                    content = content.child(t(cx, k::onboarding::TRY));
                    for (index, prompt) in onboarding::build_starter_prompts(&self.starters)
                        .iter()
                        .enumerate()
                    {
                        let args: Vec<Arg<'_>> = prompt
                            .values
                            .iter()
                            .map(|(key, value)| (*key, value as &dyn std::fmt::Display))
                            .collect();
                        let label = tf(cx, prompt.key, &args);
                        let send = label.to_string();
                        content = content.child(
                            div()
                                .id(("agent-starter", index))
                                .role(gpui::Role::Button)
                                .aria_label(label.clone())
                                .p(px(10.))
                                .rounded(px(10.))
                                .cursor_pointer()
                                .hover(move |style| style.bg(p.paper.solid()))
                                .child(text::wrapped(label))
                                .on_click(cx.listener(move |panel, _, _, cx| {
                                    panel
                                        .composer
                                        .update(cx, |field, cx| field.set_text(send.clone(), cx));
                                    panel.send(cx);
                                })),
                        );
                    }
                }
                None => content = content.child(t(cx, k::empty::START)),
            }
        } else {
            if self.connections.read(cx).usable() == Some(false) {
                content = content.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.))
                        .child(t(cx, k::UNAVAILABLE))
                        .child(
                            Button::new("agent-open-settings", t(cx, k::setup::OPEN_SETTINGS))
                                .text()
                                .small()
                                .on_click(|_, window, cx| {
                                    dr_shell::settings::open_section(
                                        dr_shell::settings::registry::Section::Models,
                                        window,
                                        cx,
                                    )
                                }),
                        ),
                );
            }
            content = content.child(self.transcript(window, cx));
        }
        let error = self
            .error
            .as_ref()
            .or(self.hub.read(cx).error.as_ref())
            .cloned();
        let mut footer = div().flex().flex_col().gap(px(7.)).p(px(12.)).flex_none();
        if let Some(run) = &active {
            footer = footer.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .text_color(p.ink(3).solid())
                    .child(sand::thinking(
                        16.,
                        p.ink(3).solid(),
                        run.state == State::Streaming && !theme.reduce_motion,
                        window,
                    ))
                    .child(t(
                        cx,
                        match run.state {
                            State::Stopping => k::pending::CANCELLING,
                            State::RunningTools => k::pending::COMMITTING,
                            State::AwaitingAnswer => k::control::QUESTION_TITLE,
                            State::AwaitingPermission => k::control::PERMISSION_TITLE,
                            _ => k::pending::NOW,
                        },
                    )),
            );
        }
        if let Some(last) = self.snapshot.as_ref().and_then(|s| s.runs.last()) {
            let used =
                last.usage.input_tokens.saturating_add(
                    if last.config.as_ref().is_some_and(|config| {
                        config.route.provider == dr_agent::Provider::Anthropic
                    }) {
                        last.usage
                            .cached_input_tokens
                            .saturating_add(last.usage.cache_write_tokens)
                    } else {
                        0
                    },
                );
            let limit = last
                .config
                .as_ref()
                .and_then(|c| c.capabilities.as_ref())
                .and_then(|c| c.context_window);
            let label = if let Some(limit) = limit {
                tf(
                    cx,
                    k::context::TOKENS,
                    &[("count", &format!("{used} / {limit}"))],
                )
                .to_string()
            } else {
                tf(cx, k::context::TOKENS, &[("count", &used)]).to_string()
            };
            footer = footer.child(
                div()
                    .id("agent-context-usage")
                    .text_color(p.ink(3).solid())
                    .child(label),
            );
        }
        footer = footer
            .child(connection_view::composer_controls(
                self.connections.clone(),
                window,
                cx,
            ))
            .child(
                div()
                    .key_context("DrAgentComposer")
                    .child(self.composer.clone()),
            )
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(6.))
                    .when(active.is_some(), |el| {
                        el.child(
                            Button::new("agent-stop", t(cx, k::composer::STOP))
                                .text()
                                .small()
                                .disabled(self.busy)
                                .on_click(cx.listener(|panel, _, _, cx| panel.stop(cx))),
                        )
                    })
                    .child(
                        Button::new(
                            "agent-send",
                            t(
                                cx,
                                if active.as_ref().is_some_and(|r| r.question.is_some()) {
                                    k::composer::ANSWER
                                } else if active.is_some() {
                                    k::composer::STEER
                                } else {
                                    k::composer::SEND
                                },
                            ),
                        )
                        .primary()
                        .small()
                        .disabled(
                            self.busy
                                || self.book.is_none()
                                || self.controller.is_none()
                                || dr_shell::release::is_releasing(cx),
                        )
                        .on_click(cx.listener(|panel, _, _, cx| panel.send(cx))),
                    ),
            );
        div()
            .id("agent-panel")
            .tab_group()
            .on_key_down(|event, window, cx| {
                let modifiers = &event.keystroke.modifiers;
                if event.keystroke.key == "tab"
                    && !(modifiers.control
                        || modifiers.alt
                        || modifiers.platform
                        || modifiers.function)
                {
                    cx.stop_propagation();
                    if modifiers.shift {
                        window.focus_prev(cx);
                    } else {
                        window.focus_next(cx);
                    }
                }
            })
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .min_w_0()
            .font_role(Role::Ui)
            .text_size(px(theme.scale.body))
            .text_color(p.ink(1).solid())
            .child(
                div()
                    .id("agent-transcript")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .p(px(14.))
                    .child(content),
            )
            .when_some(error, |el, error| {
                el.child(
                    div()
                        .px(px(12.))
                        .text_color(p.danger.solid())
                        .child(text::wrapped(error)),
                )
            })
            .child(footer)
    }
}

pub struct PanelHead {
    panel: Entity<AgentPanel>,
}
impl PanelHead {
    pub fn new(panel: Entity<AgentPanel>) -> Self {
        Self { panel }
    }
}
impl Render for PanelHead {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let panel = self.panel.clone();
        let new = self.panel.clone();
        div()
            .flex()
            .items_center()
            .justify_between()
            .w_full()
            .child(
                Button::new("agent-chat-list", t(cx, k::toolbar::HISTORY))
                    .text()
                    .small()
                    .on_click(move |_, _, cx| {
                        panel.update(cx, |p, cx| {
                            p.show_list = !p.show_list;
                            p.refresh(cx);
                            cx.notify();
                        })
                    }),
            )
            .child(
                Button::new("agent-new-chat", t(cx, k::NEW_CONVERSATION))
                    .text()
                    .small()
                    .on_click(move |_, _, cx| new.update(cx, |p, cx| p.new_conversation(cx))),
            )
    }
}
