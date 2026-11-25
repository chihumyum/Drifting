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
    components::{Button, Dialog, Layer, Place, float, tooltip},
    fonts::{Role, weight},
    glass,
    input::{FieldEvent, TextArea, TextField},
    sand,
    style::DrStyled as _,
    text,
    tokens::radius,
};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Either, select},
};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, PathBuilder, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, WeakEntity, Window, canvas,
    div, point, prelude::FluentBuilder as _, px, relative,
};
use serde_json::json;

use crate::{
    connection::Connections,
    connection_view::{self, ConnectionView},
    controller::{AgentController, Subscription as RunSubscription},
    data,
    hub::AgentHub,
    images,
    onboarding::{self, StarterSource},
    state::{
        ChatMessage, ChatSnapshot, ConversationSummary, MessageContent, RunSnapshot, TranscriptItem,
    },
};

mod continuity;
mod old;

pub use old::{EYEBROW, Results as HistoryResults};

/// The conversation a book's Agent panel shows (the workspace's book memory).
pub(crate) const MEMORY: &str = "agent.conversation";

struct Navigation {
    /// Dropping this ticket cancels the view-owned wait, independently of
    /// whether M18's globally cached view is ever rendered again.
    _cancel: oneshot::Sender<()>,
    review_pane: Option<dr_shell::panes::PaneId>,
    project_memory: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReturnToReview {
    pub book_id: String,
    pub comment_id: String,
    pub title: String,
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
    starters: Option<StarterSource>,
    book_view: Option<std::rc::Rc<dr_shell::book::Book>>,
    show_list: bool,
    return_to_review: Option<ReturnToReview>,
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
    continuity: continuity::Continuity,
    /// 「0.1 的旧对话」 and the search of 「历史」.
    old: old::Old,
    /// CM4a: images waiting in the composer for the next message.
    attached: Vec<images::Attached>,
    /// Pictures of images, by digest: the composer's and the transcript's.
    thumbs: HashMap<String, images::Thumb>,
    /// Attachments still being read; and which composer they belong to (a
    /// new book or conversation empties it).
    attaching: usize,
    tray_generation: u64,
    /// CW: images handed over before the panel first followed its window's
    /// book (it was made to take them): following the book empties the
    /// composer, so they are taken after it.
    followed: bool,
    handed: Vec<dr_shell::pages::AgentImages>,
    /// Context pressure breakdown modal visibility.
    show_context_modal: bool,
    /// Inline conversation rename state (conversation id, field, field subscription).
    renaming: Option<(ConversationId, Entity<TextField>, Subscription)>,
    /// Pagination window for long transcripts (number of tail items rendered).
    visible_limit: usize,
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
        let connect = cx.new(|cx| ConnectionView::new_companion(connections.clone(), window, cx));
        let (old, old_field) = old::Old::new(window, cx);
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
            starters: None,
            book_view: None,
            show_list: false,
            return_to_review: None,
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
            _subs: vec![old_field],
            continuity: Default::default(),
            old,
            attached: Vec::new(),
            thumbs: HashMap::new(),
            attaching: 0,
            tray_generation: 0,
            followed: false,
            handed: Vec::new(),
            show_context_modal: false,
            renaming: None,
            visible_limit: 40,
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
        let review_tracker = dr_shell::review_agent::ensure_tracker(cx);
        panel
            ._subs
            .push(cx.observe(&review_tracker, |panel, _, cx| {
                panel.consume_pending_review_open(cx);
            }));
        if cx.has_global::<crate::AgentViews>() {
            let self_weak = cx.entity().downgrade();
            let views = cx.global_mut::<crate::AgentViews>();
            views.panels.retain(|p| p.upgrade().is_some());
            if !views
                .panels
                .iter()
                .any(|p| p.entity_id() == self_weak.entity_id())
            {
                views.panels.push(self_weak);
            }
        }
        // The companion factory runs inside Workspace::render. Read it only
        // after that render has returned, then follow its book selection.
        cx.spawn(async move |this, cx| {
            let _ = this.update(cx, |panel, cx| panel.follow(cx));
        })
        .detach();
        panel
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        if let Some(ws) = self.ws.upgrade() {
            self.follow_book(&ws, cx);
            self._subs
                .push(cx.observe(&ws, |panel, ws, cx| panel.follow_book(&ws, cx)));
            self.bind_controller(cx);
            self.consume_pending_review_open(cx);
        }
        // Images handed over before now (CW): the book is followed, the
        // composer is the book's.
        self.followed = true;
        for images in std::mem::take(&mut self.handed) {
            self.take_images(images, cx);
        }
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
                self.starters = None;
                self.refresh(cx);
            }
            if cancelled {
                cx.notify();
            }
            return;
        }
        let name = state.book.name.clone();
        let selected = state
            .book_memory(MEMORY)
            .and_then(|v| v.as_str())
            .and_then(|id| ConversationId::parse(id).ok());
        self.close_memory(cx);
        self.continuity = Default::default();
        self.book = book;
        self.name = name;
        self.selected = selected;
        self.return_to_review = None;
        self.fresh = false;
        self.snapshot = None;
        self.conversations.clear();
        self.starters = None;
        self.composer.update(cx, |field, cx| field.set_text("", cx));
        self.clear_attached();
        self.thumbs.clear();
        self.reset_old(cx);
        self.invalidate();
        self.refresh(cx);
    }

    fn bind_controller(&mut self, cx: &mut Context<Self>) {
        self._run_subscription = None;
        self._signal = None;
        self.close_memory(cx);
        self.controller = self.hub.read(cx).controller.clone();
        // Another library may have its own archive (an import switches).
        self.forget_old_list();
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
        self.load_old(cx);
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
        let need_starters =
            self.starters.is_none() && self.snapshot.as_ref().is_none_or(|s| s.messages.is_empty());
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
                    let task = snapshot
                        .as_ref()
                        .and_then(|s| s.runs.last())
                        .map(|r| controller.task_view(&r.session))
                        .transpose()?
                        .flatten();
                    Ok::<_, String>((list, snapshot, starters, task))
                })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != generation {
                    return;
                }
                panel.loading = false;
                match result {
                    Ok((list, snapshot, starters, task)) => {
                        panel.continuity.task = task;
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
                            panel.starters = Some(starters);
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
        self.return_to_review = None;
        self.fresh = true;
        self.snapshot = None;
        self.show_list = false;
        self.show_context_modal = false;
        self.renaming = None;
        self.visible_limit = 40;
        self.old.leave();
        self.starters = None;
        self.error = None;
        self.expanded.clear();
        self.invalidate();
        self.composer.update(cx, |field, cx| field.set_text("", cx));
        self.clear_attached();
        self.refresh(cx);
        cx.notify();
    }

    pub fn select_conversation(&mut self, id: ConversationId, cx: &mut Context<Self>) {
        self.return_to_review = None;
        self.select_conversation_keep_return(id, cx);
    }

    fn select_conversation_keep_return(&mut self, id: ConversationId, cx: &mut Context<Self>) {
        self.selected = Some(id);
        self.fresh = false;
        self.show_list = false;
        self.show_context_modal = false;
        self.renaming = None;
        self.visible_limit = 40;
        self.old.leave();
        self.snapshot = None;
        self.error = None;
        self.expanded.clear();
        self.invalidate();
        self.remember(cx);
        self.refresh(cx);
        cx.notify();
    }

    pub(super) fn begin_rename(
        &mut self,
        id: ConversationId,
        current_title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field =
            cx.new(|cx| TextField::new("agent-rename-title", window, cx).with_text(current_title));
        let sub = cx.subscribe(&field, |panel, _, event, cx| match event {
            FieldEvent::Submitted(_) => panel.commit_rename(cx),
            FieldEvent::Cancelled => panel.cancel_rename(cx),
            _ => {}
        });
        window.focus(&field.focus_handle(cx), cx);
        self.renaming = Some((id, field, sub));
        cx.notify();
    }

    fn commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some((id, field, _)) = self.renaming.take() else {
            return;
        };
        let title = field.read(cx).text();
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            cx.notify();
            return;
        };
        cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { controller.rename_conversation(&book, &id, &title) })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if let Err(err) = res {
                    panel.error = Some(err);
                }
                panel.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_rename(&mut self, cx: &mut Context<Self>) {
        self.renaming = None;
        cx.notify();
    }

    pub(super) fn delete_conversation(&mut self, id: ConversationId, cx: &mut Context<Self>) {
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        let was_selected = self.selected.as_ref() == Some(&id);
        if was_selected {
            self.selected = None;
            self.snapshot = None;
            self.fresh = true;
        }
        cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { controller.delete_conversation(&book, &id) })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if let Err(err) = res {
                    panel.error = Some(err);
                }
                panel.refresh(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn current_title(&self, cx: &App) -> SharedString {
        if let Some(id) = &self.selected
            && let Some(item) = self.conversations.iter().find(|c| &c.id == id)
        {
            let clean = dr_shell::review_agent::clean_conversation_title(&item.title);
            if !clean.trim().is_empty() {
                return clean.to_owned().into();
            }
        }
        t(cx, k::NEW_CONVERSATION)
    }

    pub(super) fn context_metrics(&self) -> Option<(u64, u64, u64, u64, u64)> {
        if let Some(cp) = self.snapshot.as_ref().and_then(|s| s.context.as_ref()) {
            let bd = &cp.breakdown;
            let window = if bd.window > 0 {
                bd.window
            } else {
                cp.input_budget
            };
            let used = cp.estimated_input_tokens;
            let limit = window.max(1);
            let percent = ((used.saturating_mul(100)) / limit).min(100);
            return Some((used, limit, percent, bd.output_reserve, bd.safety_margin));
        }
        let last = self.snapshot.as_ref()?.runs.last()?;
        let used = last.usage.input_tokens.saturating_add(
            if last
                .config
                .as_ref()
                .is_some_and(|config| config.route.provider == dr_agent::Provider::Anthropic)
            {
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
            .and_then(|c| c.context_window)?;
        let percent = ((used.saturating_mul(100)) / limit.max(1)).min(100);
        let output_reserve = last
            .config
            .as_ref()
            .and_then(|c| c.max_output_tokens.map(u64::from))
            .unwrap_or_else(|| (limit / 8).clamp(4_096, 8_192));
        let safety_margin = limit / 10;
        Some((used, limit, percent, output_reserve, safety_margin))
    }

    fn toggle_context_modal(&mut self, cx: &mut Context<Self>) {
        self.show_context_modal = !self.show_context_modal;
        cx.notify();
    }

    /// HC: a suggestion card on Project Home opened `id` in `book` of the
    /// workspace `ws`; a panel of that workspace showing that book shows it.
    pub(crate) fn show_card_conversation(
        &mut self,
        ws: &WeakEntity<Workspace>,
        book: &BookId,
        id: ConversationId,
        cx: &mut Context<Self>,
    ) {
        if self.ws.entity_id() == ws.entity_id() && self.book.as_ref() == Some(book) {
            self.select_conversation(id, cx);
        }
    }

    pub fn return_to_review(&self) -> Option<&ReturnToReview> {
        self.return_to_review.as_ref()
    }

    pub(crate) fn is_visibly_showing(
        &self,
        self_id: gpui::EntityId,
        book_id: &str,
        conversation_id: &ConversationId,
        cx: &App,
    ) -> bool {
        self.book.as_ref().map(BookId::as_str) == Some(book_id)
            && self.selected.as_ref() == Some(conversation_id)
            && !self.show_list
            && !self.old.is_open()
            && self
                .ws
                .upgrade()
                .is_some_and(|ws| ws.read(cx).companion_visible(self_id))
    }

    fn consume_pending_review_open(&mut self, cx: &mut Context<Self>) {
        let Some(tracker) = dr_shell::review_agent::tracker(cx) else {
            return;
        };
        let Some(pending) = tracker.read(cx).peek_pending_open().cloned() else {
            return;
        };
        let current_book = self
            .book
            .as_ref()
            .map(|b| b.as_str().to_owned())
            .or_else(|| self.ws.upgrade().map(|ws| ws.read(cx).book_id.clone()));
        if current_book.as_deref() != Some(pending.book_id.as_str()) {
            return;
        }
        let eligible = match self.ws.upgrade() {
            Some(ws) => {
                ws.read(cx).companion_visible(cx.entity_id()) || crate::panels(cx).len() <= 1
            }
            None => true,
        };
        if !eligible {
            return;
        }
        let Some(req) = tracker.update(cx, |t, _| t.take_pending_open(&pending.book_id)) else {
            return;
        };
        if self.book.is_none()
            && let Ok(book) = BookId::parse(&req.book_id)
        {
            self.book = Some(book);
        }
        let Ok(conv_id) = ConversationId::parse(&req.conversation_id) else {
            return;
        };
        self.return_to_review = Some(ReturnToReview {
            book_id: req.book_id.clone(),
            comment_id: req.comment_id,
            title: req.return_title,
        });
        dr_shell::review_agent::mark_viewed(&req.book_id, &req.conversation_id, cx);
        self.select_conversation_keep_return(conv_id, cx);
    }

    pub fn back_to_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ret) = self.return_to_review.take() else {
            return;
        };
        if let (Some(book), Some(conv)) = (&self.book, &self.selected) {
            dr_shell::review_agent::mark_viewed(book.as_str(), conv.as_str(), cx);
        }
        if let Some(ws) = self.ws.upgrade() {
            ws.update(cx, |ws, cx| {
                if ws.book_id == ret.book_id {
                    let _ = ws.reveal_comment(&ret.comment_id, None, window, cx);
                }
            });
        }
        cx.notify();
    }

    pub fn snapshot(&self) -> Option<&ChatSnapshot> {
        self.snapshot.as_ref()
    }
    pub fn composer(&self) -> Entity<TextArea> {
        self.composer.clone()
    }
    pub fn is_settled(&self) -> bool {
        !self.busy
            && !self.loading
            && self.navigation.is_empty()
            && self.active().is_none()
            && self.old.settled()
            && self.attaching == 0
            && self.handed.is_empty()
            && !self
                .thumbs
                .values()
                .any(|thumb| matches!(thumb, images::Thumb::Loading))
    }

    /// CM4a: the images waiting in the composer for the next message.
    pub fn attached(&self) -> &[images::Attached] {
        &self.attached
    }

    /// The error line under the transcript, if any.
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// The picture of `image` as it stands (tests).
    pub fn thumb(&self, image: &dr_agent::ImageRef) -> Option<&images::Thumb> {
        self.thumbs.get(&image.sha256)
    }

    fn clear_attached(&mut self) {
        self.attached.clear();
        self.tray_generation += 1;
    }

    /// Attach image bytes (pasted) to the next message.
    pub fn attach_bytes(&mut self, items: Vec<Vec<u8>>, cx: &mut Context<Self>) {
        self.attach_with(move || items.into_iter().map(images::check).collect(), cx);
    }

    /// Attach image files (dropped or pasted) to the next message.
    pub fn attach_paths(&mut self, paths: Vec<std::path::PathBuf>, cx: &mut Context<Self>) {
        self.attach_with(
            move || paths.iter().map(|path| images::check_file(path)).collect(),
            cx,
        );
    }

    /// Reads and checks off the main thread, then adds in order what can be
    /// sent, up to the per-message limit; the same image twice is once. What
    /// cannot be sent is said on the error line.
    fn attach_with(
        &mut self,
        job: impl FnOnce() -> Vec<Result<images::Checked, dr_agent::ImageError>> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.old.is_open() {
            return;
        }
        self.attaching += 1;
        let tray = self.tray_generation;
        let checked = cx.background_executor().spawn(async move { job() });
        cx.spawn(async move |this, cx| {
            let checked = checked.await;
            let _ = this.update(cx, |panel, cx| {
                panel.attaching -= 1;
                if panel.tray_generation != tray {
                    cx.notify();
                    return;
                }
                let mut problem = None;
                for result in checked {
                    match result {
                        Ok(checked) => {
                            let sha = checked.attached.image.sha256.clone();
                            if panel.attached.iter().any(|a| a.image.sha256 == sha) {
                                continue;
                            }
                            if panel.attached.len() >= dr_agent::images::MAX_IMAGES_PER_MESSAGE {
                                problem.get_or_insert(dr_agent::ImageError::TooMany);
                                continue;
                            }
                            if let Some(thumb) = checked.thumb {
                                panel.thumbs.insert(sha, images::Thumb::Ready(thumb));
                            }
                            panel.attached.push(checked.attached);
                        }
                        Err(error) => {
                            problem.get_or_insert(error);
                        }
                    }
                }
                panel.error = problem.map(|error| image_error(error, cx));
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub fn remove_attached(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.attached.len() {
            self.attached.remove(index);
            cx.notify();
        }
    }

    /// Images handed over from a page (CW: dropped or pasted on the module
    /// workbench's paper, [`dr_shell::Workspace::give_agent_images`]):
    /// attached as if dropped or pasted here. A panel made to take them
    /// takes them once it has followed its window's book (which empties the
    /// composer).
    pub fn take_images(&mut self, images: dr_shell::pages::AgentImages, cx: &mut Context<Self>) {
        if !self.followed {
            self.handed.push(images);
            return;
        }
        match images {
            dr_shell::pages::AgentImages::Files(paths) => self.attach_paths(paths, cx),
            dr_shell::pages::AgentImages::Bytes(items) => self.attach_bytes(items, cx),
        }
    }

    /// ⌘V in the composer: files on the clipboard, or an image without any
    /// text, are attached; anything with text is pasted as text by the field
    /// itself ([`dr_shell::pages::AgentImages::on_clipboard`], which the
    /// workbench's paper reads the same way). True when it was taken here.
    fn paste_images(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        match dr_shell::pages::AgentImages::on_clipboard(&item) {
            Some(images) => {
                self.take_images(images, cx);
                true
            }
            None => false,
        }
    }

    /// The picture of an image a message in this conversation names: read
    /// from this device in the background the first time.
    fn transcript_thumb(
        &mut self,
        image: &dr_agent::ImageRef,
        cx: &mut Context<Self>,
    ) -> images::Thumb {
        if let Some(thumb) = self.thumbs.get(&image.sha256) {
            return thumb.clone();
        }
        let (Some(controller), Some(conversation)) =
            (self.controller.clone(), self.selected.clone())
        else {
            return images::Thumb::Missing;
        };
        self.thumbs
            .insert(image.sha256.clone(), images::Thumb::Loading);
        let image = image.clone();
        let sha = image.sha256.clone();
        let read = cx.background_executor().spawn(async move {
            controller
                .read_image(&conversation, &image)
                .ok()
                .flatten()
                .and_then(|bytes| images::thumbnail(&bytes))
        });
        cx.spawn(async move |this, cx| {
            let thumb = read.await;
            let _ = this.update(cx, |panel, cx| {
                if matches!(panel.thumbs.get(&sha), Some(images::Thumb::Loading)) {
                    panel.thumbs.insert(
                        sha,
                        thumb.map_or(images::Thumb::Missing, images::Thumb::Ready),
                    );
                    cx.notify();
                }
            });
        })
        .detach();
        images::Thumb::Loading
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
        self.send_after_list(false, cx);
    }

    /// `waited`: the selected provider's live list was already fetched for
    /// this message's images (see [`Connections::live_catalog`]).
    fn send_after_list(&mut self, waited: bool, cx: &mut Context<Self>) {
        // A 0.1 conversation is read only: nothing continues it.
        if self.old.is_open() {
            return;
        }
        let text = self.composer.read(cx).text();
        let attached = self.attached.clone();
        if (text.trim().is_empty() && attached.is_empty())
            || self.busy
            || self.attaching > 0
            || dr_shell::release::is_releasing(cx)
        {
            return;
        }
        let (Some(controller), Some(book)) = (self.controller.clone(), self.book.clone()) else {
            return;
        };
        if let Some(run) = self.active() {
            // Words go into the running turn; images wait for the next
            // message (CM4a).
            if text.trim().is_empty() {
                return;
            }
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
        // Whether the model takes images is what its live list says: fetch
        // it before deciding, once.
        if !attached.is_empty()
            && !waited
            && let Some(ready) = self.connections.update(cx, |c, cx| c.live_catalog(cx))
        {
            self.busy = true;
            let generation = self.generation;
            cx.spawn(async move |this, cx| {
                let _ = ready.await;
                let _ = this.update(cx, |panel, cx| {
                    if panel.generation == generation {
                        panel.busy = false;
                        panel.send_after_list(true, cx);
                    }
                });
            })
            .detach();
            cx.notify();
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
        let sent: Vec<String> = attached.iter().map(|a| a.image.sha256.clone()).collect();
        let start = controller.start_job_with_images(
            start,
            dr_agent::ImageAttachments {
                images: attached.into_iter().map(|a| a.bytes).collect(),
                unseen_reply: t(cx, dr_i18n::keys::agent_images::UNSEEN).to_string(),
            },
        );
        cx.spawn(async move |this, cx| {
            let result = start.await;
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
                        // What was sent leaves the composer; an image
                        // added meanwhile stays.
                        panel.attached.retain(|a| !sent.contains(&a.image.sha256));
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
        if let (Some(controller), Some(conversation)) = (&self.controller, &self.selected) {
            self.control(controller.stop_conversation(conversation), None, cx);
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
                project_memory: false,
            },
        );
        cx.spawn_in(window, async move |this, cx| {
            enum Opened {
                Page,
                Review(oneshot::Receiver<bool>, dr_shell::panes::PaneId),
                ProjectMemory(oneshot::Receiver<bool>),
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
                    if let data::ChangeLocation::ProjectMemory(id) = location {
                        let same_book = {
                            let ws = ws.read(cx);
                            ws.book_id == book.as_str() && ws.book.id == book.as_str()
                        };
                        if !same_book {
                            return None;
                        }
                        let revealed = panel.reveal_project_memory(id, window, cx)?;
                        if let Some(request) = panel.navigation.get_mut(&navigation) {
                            request.project_memory = true;
                        }
                        return Some(Opened::ProjectMemory(revealed));
                    }
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

                                ws.open(target, Open::KEEP, cx);
                                Some(Opened::Page)
                            }
                            data::ChangeLocation::Comment { id, target } => {
                                let revealed = ws.reveal_comment(&id, target, window, cx)?;
                                Some(Opened::Review(revealed, ws.right.panes.focused))
                            }
                            data::ChangeLocation::ProjectMemory(_) => unreachable!(),
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
                Some(Opened::Review(revealed, _) | Opened::ProjectMemory(revealed)) => {
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
                    && (!request.project_memory || panel.continuity.shown == Some(false))
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
        let ws = self.ws.clone();
        let opener: crate::markdown::OpenTargetFn = std::rc::Rc::new(move |target, _, cx| {
            ws.update(cx, |ws, cx| {
                if ws.book.exists(&target) {
                    ws.open(target, Open::KEEP, cx);
                }
            })
            .ok();
        });
        let mut column = div().flex().flex_col().gap(px(10.)).min_w_0();
        for block in &message.blocks {
            match block {
                ContentBlock::Text { index, text } => {
                    column = column.child(crate::markdown::render_markdown(
                        &format!("{id}:text:{index}"),
                        text,
                        Some(opener.clone()),
                        window,
                        cx,
                    ))
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
                    let live_preview = (running && !open)
                        .then(|| {
                            text.lines()
                                .rev()
                                .find(|l| !l.trim().is_empty())
                                .map(|l| l.trim().chars().take(72).collect::<String>())
                        })
                        .flatten();
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
                                    .child(sand::thinking(16., p.ink(3).solid(), running, window))
                                    .child(label),
                            )
                            .when_some(live_preview, |el, preview| {
                                el.child(
                                    div()
                                        .pl(px(23.))
                                        .font_role(Role::Index)
                                        .type_px(theme.scale.caption, theme.scale.line_caption)
                                        .text_color(p.ink(4).solid())
                                        .truncate()
                                        .child(preview),
                                )
                            })
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
                    let (title, detail) = tool_call_summary(call);
                    let label: SharedString = match &detail {
                        Some(d) => format!("{title} · {d}").into(),
                        None => title.into(),
                    };
                    column = column.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(5.))
                            .child(
                                self.disclosure(key.clone(), label.clone(), window, cx)
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .font_role(Role::Index)
                                    .type_px(theme.scale.caption, theme.scale.line_caption)
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
            MessageContent::User { text, images } if !images.is_empty() => {
                let mut pictures = div().flex().flex_wrap().gap(px(6.));
                for (index, image) in images.iter().enumerate() {
                    pictures = pictures.child(
                        self.tile(
                            SharedString::from(format!(
                                "agent-message-{}-image-{index}",
                                message.id
                            )),
                            image
                                .as_ref()
                                .and_then(|image| self.thumbs.get(&image.sha256)),
                            64.,
                            window,
                            cx,
                        ),
                    );
                }
                row = row
                    .p(px(12.))
                    .rounded(px(12.))
                    .bg(p.paper.solid())
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(pictures)
                    .when(!text.is_empty(), |el| el.child(text::wrapped(text.clone())))
            }
            MessageContent::User { text, .. } => {
                if let Some((header, body)) =
                    dr_shell::review_agent::parse_comment_user_message(text)
                {
                    let theme = Theme::of(window, cx);
                    row = row
                        .p(px(12.))
                        .rounded(px(12.))
                        .bg(p.paper.solid())
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .font_role(Role::Index)
                                .type_px(theme.scale.caption, theme.scale.line_caption)
                                .text_color(p.ink(4).solid())
                                .child(header.to_owned()),
                        )
                        .when(!body.is_empty(), |el| {
                            el.child(text::wrapped(body.to_owned()))
                        })
                } else {
                    row = row
                        .p(px(12.))
                        .rounded(px(12.))
                        .bg(p.paper.solid())
                        .child(text::wrapped(text.clone()))
                }
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
                // The modules it made, changed or put into a template
                // (CM4b's `custom_modules`): a card each, 「打开工作台」 (CM3).
                if *status != dr_agent::ToolStatus::Error {
                    row = row
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .children(self.module_cards(&message.id, output, window, cx));
                }
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

    /// One card for each module a tool result names (`custom_modules`):
    /// its name, 「我的模块」 and 「打开工作台」 (the module's workbench, a pill
    /// of the project in front; `custom-modules.md` §8 entrances 1 and 2).
    fn module_cards(
        &self,
        message: &str,
        output: &serde_json::Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let p = Theme::of(window, cx).palette;
        let Some(modules) = output["custom_modules"].as_array() else {
            return Vec::new();
        };
        modules
            .iter()
            .filter_map(|m| {
                let id: dr_model::id::CustomModuleId = m["id"].as_str()?.parse().ok()?;
                let name = m["name"].as_str().unwrap_or_default().to_owned();
                let element = format!("agent-module-card-{message}-{id}");
                let sel = format!("agent-module-card-{id}");
                let open_sel = format!("agent-open-bench-{id}");
                let ws = self.ws.clone();
                let target = dr_shell::nav::Target::Module(id);
                Some(
                    div()
                        .id(SharedString::from(element))
                        .debug_selector(move || sel.clone())
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.))
                        .px(px(12.))
                        .py(px(9.))
                        .rounded(px(4.))
                        .bg(p.paper.solid())
                        .border(px(0.5))
                        .border_color(p.hairline())
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .font_role(Role::Ui)
                                        .type_px(15., 20.)
                                        .text_color(p.ink(1).solid())
                                        .child(name),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(12.5, 18.)
                                        .text_color(p.ink(3).solid())
                                        .child(t(cx, dr_i18n::keys::module_bench::MY_MODULE)),
                                ),
                        )
                        .child(
                            div().debug_selector(move || open_sel.clone()).child(
                                Button::new(
                                    SharedString::from(format!(
                                        "agent-open-bench-{message}-{}",
                                        m["id"].as_str().unwrap_or_default()
                                    )),
                                    t(cx, dr_i18n::keys::module_bench::OPEN_BENCH),
                                )
                                .small()
                                .on_click(move |_, _, cx| {
                                    let target = target.clone();
                                    ws.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx)).ok();
                                }),
                            ),
                        )
                        .into_any_element(),
                )
            })
            .collect()
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
            let (tool_label, tool_preview) = tool_call_summary(&permission.call);
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
                    .child(match tool_preview {
                        Some(preview) => format!("{tool_label} · {preview}"),
                        None => tool_label,
                    })
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
            let label = self.change_target_label(target, cx);
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
        if turn == run.turn && run.state.is_terminal() {
            let u = run.usage;
            let total_in = u.input_tokens.saturating_add(
                if run
                    .config
                    .as_ref()
                    .is_some_and(|c| c.route.provider == dr_agent::Provider::Anthropic)
                {
                    u.cached_input_tokens.saturating_add(u.cache_write_tokens)
                } else {
                    0
                },
            );
            let duration_label = run
                .started_ms
                .zip(run.finished_ms)
                .filter(|(s, f)| f > s)
                .map(|(s, f)| format_duration_ms((f - s) as u64));
            let has_stats = total_in > 0
                || u.output_tokens > 0
                || duration_label.is_some()
                || !run.tools.is_empty();
            if has_stats {
                let theme = Theme::of(window, cx);
                let mut parts: Vec<String> = Vec::new();
                if let Some(dur) = duration_label {
                    parts.push(tf(cx, k::usage::WORKED_FOR, &[("duration", &dur)]).to_string());
                }
                if !run.tools.is_empty() {
                    parts.push(
                        tf(cx, k::usage::TOOLS_COUNT, &[("count", &run.tools.len())]).to_string(),
                    );
                }
                if total_in > 0 || u.output_tokens > 0 {
                    let net = total_in.saturating_sub(u.cached_input_tokens);
                    parts.push(
                        tf(
                            cx,
                            k::usage::INPUT_DETAIL,
                            &[
                                ("input", &format_compact_tokens(total_in)),
                                ("cacheRead", &format_compact_tokens(u.cached_input_tokens)),
                                ("cacheWrite", &format_compact_tokens(u.cache_write_tokens)),
                                ("net", &format_compact_tokens(net)),
                            ],
                        )
                        .to_string(),
                    );
                    parts.push(
                        tf(
                            cx,
                            k::usage::OUTPUT_TURNS,
                            &[
                                ("output", &format_compact_tokens(u.output_tokens)),
                                ("turns", &run.rounds.max(1)),
                            ],
                        )
                        .to_string(),
                    );
                }
                column = column.child(
                    div()
                        .font_role(Role::Index)
                        .type_px(theme.scale.caption, theme.scale.line_caption)
                        .text_color(p.ink(4).solid())
                        .child(parts.join(" · ")),
                );
            }
        }
        column.into_any_element()
    }

    fn change_target_label(&self, target: &data::ChangeTarget, cx: &App) -> SharedString {
        if let Some(book) = &self.book_view {
            let key = match target.kind.as_str() {
                "entry" => Some(format!("entry:{}", target.id)),
                "entry_template" | "template" => Some(format!("template:{}", target.id)),
                "timeline_view" => Some(format!("book-view:{}", target.id)),
                "asset" => Some(format!("material:{}", target.id)),
                _ => None,
            };
            if let Some(key) = key
                && let Some(nav_target) = dr_shell::nav::Target::from_key(&key)
                && let Some(title) = book.title(&nav_target)
                && !title.trim().is_empty()
            {
                return SharedString::from(title.to_owned());
            }
            if target.kind == "book" && !book.name.trim().is_empty() {
                return SharedString::from(book.name.clone());
            }
        }
        t(cx, k::TURN_CHANGES)
    }

    /// One image's square: its picture, or an empty place when this device
    /// does not hold it (CM4a). Read as an image named 「图片」.
    fn tile(
        &self,
        id: SharedString,
        thumb: Option<&images::Thumb>,
        size: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        use gpui::StyledImage as _;
        let p = Theme::of(window, cx).palette;
        let selector = id.to_string();
        let tile = div()
            .id(id)
            .debug_selector(move || selector)
            .role(gpui::Role::Image)
            .aria_label(t(cx, dr_i18n::keys::agent_images::IMAGE))
            .size(px(size))
            .flex_none()
            .rounded(px(8.))
            .overflow_hidden()
            .bg(p.page.solid());
        match thumb {
            Some(images::Thumb::Ready(picture)) => tile.child(
                gpui::img(picture.clone())
                    .size_full()
                    .object_fit(gpui::ObjectFit::Cover),
            ),
            Some(images::Thumb::Loading) => tile,
            _ => tile
                .flex()
                .items_center()
                .justify_center()
                .child(sand::icon(sand::Icon::Image, 16., p.ink(4).solid())),
        }
    }

    /// The images waiting for the next message, each with its remove button.
    fn tray(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut row = div().flex().flex_wrap().gap(px(8.));
        for (index, attached) in self.attached.iter().enumerate() {
            row = row.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(self.tile(
                        SharedString::from(format!("agent-attachment-{index}")),
                        self.thumbs.get(&attached.image.sha256),
                        48.,
                        window,
                        cx,
                    ))
                    .child(
                        dr_ui::components::PanelIconButton::new(
                            ("agent-attachment-remove", index),
                            sand::Icon::Close,
                        )
                        .label(t(cx, dr_i18n::keys::agent_images::REMOVE))
                        .on_click(
                            cx.listener(move |panel, _, _, cx| panel.remove_attached(index, cx)),
                        ),
                    ),
            );
        }
        row.into_any_element()
    }

    fn transcript(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut column = div().flex().flex_col().gap(px(18.)).min_w_0();
        let Some(snapshot) = self.snapshot.clone() else {
            return column.into_any_element();
        };
        for message in &snapshot.messages {
            if let MessageContent::User { images, .. } = &message.content {
                for image in images.iter().flatten() {
                    self.transcript_thumb(image, cx);
                }
            }
        }
        let mut assistants: HashMap<(&str, u32), usize> = HashMap::new();
        let all_items = snapshot.transcript();
        let total_items = all_items.len();
        let skip = total_items.saturating_sub(self.visible_limit);
        if skip > 0 {
            column = column.child(
                div().flex().justify_center().child(
                    Button::new("agent-load-earlier", t(cx, k::history::LOAD_EARLIER))
                        .text()
                        .small()
                        .on_click(cx.listener(|panel, _, _, cx| {
                            panel.visible_limit = panel.visible_limit.saturating_add(40);
                            cx.notify();
                        })),
                ),
            );
        }
        for (idx, item) in all_items.into_iter().enumerate() {
            match item {
                TranscriptItem::Message(message) => {
                    let ordinal = assistants
                        .entry((&message.session, message.turn))
                        .or_default();
                    let id = format!("assistant:{}:{}:{ordinal}", message.session, message.turn);
                    if matches!(message.content, MessageContent::Assistant { .. }) {
                        *ordinal += 1;
                    }
                    if idx >= skip
                        && let Some(row) = self.message(message, &id, window, cx)
                    {
                        column = column.child(row);
                    }
                }
                TranscriptItem::Run { run, turn } => {
                    if idx >= skip {
                        let ordinal = assistants
                            .get(&(run.session.as_str(), turn))
                            .copied()
                            .unwrap_or(0);
                        let id = format!("assistant:{}:{turn}:{ordinal}", run.session);
                        column = column.child(self.run(run, turn, &id, window, cx));
                    }
                }
            }
        }
        column.into_any_element()
    }

    fn context_modal(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.show_context_modal {
            return None;
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let (used, limit, percent, output_reserve, safety_margin) = self
            .context_metrics()
            .unwrap_or((0, 32_768, 0, 4_096, 3_276));
        let cp = self
            .snapshot
            .as_ref()
            .and_then(|snap| snap.context.as_ref());
        let bd = cp.map(|c| c.breakdown.clone()).unwrap_or_default();
        let window_total = bd.window.max(limit).max(1);
        let out_res = if bd.output_reserve > 0 {
            bd.output_reserve
        } else {
            output_reserve
        };
        let safety = if bd.safety_margin > 0 {
            bd.safety_margin
        } else {
            safety_margin
        };
        let free = window_total
            .saturating_sub(used)
            .saturating_sub(out_res)
            .saturating_sub(safety);
        let frac = |v: u64| (v as f32 / window_total as f32).clamp(0.0, 1.0);
        let summary_text = tf(
            cx,
            k::context::SUMMARY,
            &[
                ("used", &format_compact_tokens(used)),
                ("limit", &format_compact_tokens(window_total)),
                ("percent", &percent),
            ],
        );
        let bar = div()
            .w_full()
            .h(px(10.0))
            .rounded(px(5.0))
            .overflow_hidden()
            .bg(p.ink(1).alpha(0.08))
            .flex()
            .flex_row()
            .child(div().h_full().w(relative(frac(used))).bg(p.accent.solid()))
            .child(
                div()
                    .h_full()
                    .w(relative(frac(out_res)))
                    .bg(p.ink(3).alpha(0.55)),
            )
            .child(
                div()
                    .h_full()
                    .w(relative(frac(safety)))
                    .bg(p.ink(4).alpha(0.35)),
            )
            .child(div().h_full().flex_1());
        let legend_item = |dot_color: gpui::Hsla, label: SharedString, val: u64| {
            div()
                .flex()
                .items_center()
                .gap(px(5.0))
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(3).solid())
                .child(div().size(px(8.0)).rounded_full().bg(dot_color))
                .child(format!("{label} {}", format_compact_tokens(val)))
        };
        let categories: &[(dr_i18n::Key, u64)] = &[
            (k::context::categories::SYSTEM_PROMPT, bd.system_prompt),
            (
                k::context::categories::TOOL_DEFINITIONS,
                bd.tool_definitions,
            ),
            (
                k::context::categories::PROVIDER_OVERHEAD,
                bd.provider_overhead,
            ),
            (k::context::categories::TASK_PLAN, bd.task_plan),
            (
                k::context::categories::TASK_CONSTRAINTS,
                bd.task_constraints,
            ),
            (k::context::categories::USER_MESSAGES, bd.user_messages),
            (
                k::context::categories::ASSISTANT_MESSAGES,
                bd.assistant_messages,
            ),
            (k::context::categories::THINKING, bd.thinking),
            (k::context::categories::TOOL_CALLS, bd.tool_calls),
            (k::context::categories::TOOL_RESULTS, bd.tool_results),
            (
                k::context::categories::COMPACTION_SUMMARIES,
                bd.compaction_summaries,
            ),
        ];
        let mut cat_list = div().flex().flex_col().gap(px(4.0));
        for &(key, tokens) in categories {
            let pct = tokens
                .saturating_mul(100)
                .checked_div(used)
                .unwrap_or(0)
                .min(100);
            cat_list = cat_list.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .type_px(s.caption, s.line_caption)
                    .child(div().text_color(p.ink(2).solid()).child(t(cx, key)))
                    .child(
                        div()
                            .font_role(Role::Index)
                            .text_color(p.ink(3).solid())
                            .child(format!("{} ({pct}%)", format_compact_tokens(tokens))),
                    ),
            );
        }
        let compaction_text = if bd.compacted_count == 0 {
            t(cx, k::context::COMPACTION_NONE)
        } else {
            tf(
                cx,
                k::context::COMPACTION_DETAIL,
                &[
                    ("saved", &format_compact_tokens(bd.compacted_tokens_saved)),
                    ("stages", &"bounded projection"),
                    ("count", &bd.compacted_count),
                ],
            )
        };
        let body = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .w(px(420.0))
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .child(
                        div()
                            .font_role(Role::Structure)
                            .weight(weight::SEMIBOLD)
                            .text_color(p.ink(1).solid())
                            .child(summary_text),
                    )
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(tf(cx, k::context::SOURCES, &[("count", &bd.source_count)])),
                    ),
            )
            .child(
                div()
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(t(cx, k::context::DESCRIPTION)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .weight(weight::MEDIUM)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, k::context::allocation::TITLE)),
                    )
                    .child(bar)
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_x(px(12.0))
                            .gap_y(px(4.0))
                            .child(legend_item(
                                p.accent.solid(),
                                t(cx, k::context::allocation::INPUT),
                                used,
                            ))
                            .child(legend_item(
                                p.ink(3).alpha(0.55),
                                t(cx, k::context::allocation::OUTPUT),
                                out_res,
                            ))
                            .child(legend_item(
                                p.ink(4).alpha(0.35),
                                t(cx, k::context::allocation::SAFETY),
                                safety,
                            ))
                            .child(legend_item(
                                p.ink(1).alpha(0.14),
                                t(cx, k::context::allocation::FREE),
                                free,
                            )),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .pt(px(4.0))
                    .border_t(px(0.5))
                    .border_color(p.hairline())
                    .child(
                        div()
                            .weight(weight::MEDIUM)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, k::context::BREAKDOWN_TITLE)),
                    )
                    .child(cat_list),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .pt(px(4.0))
                    .border_t(px(0.5))
                    .border_color(p.hairline())
                    .child(
                        div()
                            .weight(weight::MEDIUM)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, k::context::COMPACTION)),
                    )
                    .child(
                        div()
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(compaction_text),
                    ),
            );
        let dismiss = cx.entity();
        let close = cx.entity();
        let dialog = Dialog::new("agent-context-modal", t(cx, k::context::TITLE))
            .body(body)
            .action(
                Button::new("agent-context-close", t(cx, dr_i18n::keys::common::CLOSE))
                    .small()
                    .on_click(move |_, _, cx| {
                        close.update(cx, |panel, cx| {
                            panel.show_context_modal = false;
                            cx.notify();
                        });
                    }),
            )
            .on_close(move |_, cx| {
                dismiss.update(cx, |panel, cx| {
                    panel.show_context_modal = false;
                    cx.notify();
                });
            });
        Some(float(Place::Center, Layer::Dialog, dialog).into_any_element())
    }
}

impl Render for AgentPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let root = div()
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
            .text_color(p.ink(1).solid());
        // A 0.1 conversation is read only: no input block at all (四甲).
        if self.old.is_open() {
            return root.child(self.old_transcript(window, cx));
        }
        // Images are dropped anywhere on the Agent column (CM4a;
        // custom-modules.md §8: 「拖进 Agent 那一栏」), the composer included.
        let wash = p.ink(1).alpha(0.05);
        let root = root
            .drag_over::<gpui::ExternalPaths>(move |style, _, _, _| style.bg(wash))
            .on_drop(cx.listener(|panel, paths: &gpui::ExternalPaths, _, cx| {
                panel.attach_paths(paths.paths().to_vec(), cx)
            }));
        let active = self.active().cloned();
        let empty = self
            .snapshot
            .as_ref()
            .is_none_or(|s| s.messages.is_empty() && s.runs.is_empty())
            && !self.busy;
        let mut content = div().flex().flex_col().gap(px(12.)).min_w_0();
        content = content.child(self.continuity_header(cx));
        if self.continuity.shown.is_none()
            && !self.show_list
            && let Some(plan) = self.plan_card(window, cx)
        {
            content = content.child(plan);
        }
        if let Some(working) = self.continuity.shown {
            if working {
                if let Some(view) = &self.continuity.working {
                    content = content.child(view.clone());
                }
            } else if let Some(view) = &self.continuity.project {
                content = content.child(view.clone());
            }
        } else if self.show_list {
            content = content.child(self.history(window, cx));
        } else if empty {
            match onboarding::resolve_view(
                onboarding::step(cx),
                self.connections.read(cx).usable(),
                true,
            ) {
                Some(onboarding::View::Connect) => content = content.child(self.connect.clone()),
                Some(onboarding::View::Suggest) => {
                    let prompts = self
                        .starters
                        .as_ref()
                        .map(onboarding::build_starter_prompts)
                        .unwrap_or_default();
                    // The empty conversation's first line sits right under
                    // the memory buttons: no cards and no switch there (HC).
                    content =
                        content.child(div().debug_selector(|| "agent-empty".into()).child(t(
                            cx,
                            if prompts.is_empty() {
                                k::empty::START
                            } else {
                                k::onboarding::TRY
                            },
                        )));
                    for (index, prompt) in prompts.iter().enumerate() {
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
                None => {
                    content = content.child(
                        div()
                            .debug_selector(|| "agent-empty".into())
                            .child(t(cx, k::empty::START)),
                    )
                }
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
            content = content
                .child(self.transcript(window, cx))
                .child(self.continuation_card(cx));
        }
        let error = self
            .error
            .as_ref()
            .or(self.hub.read(cx).error.as_ref())
            .cloned();
        let mut footer = div()
            .id("agent-composer-area")
            .debug_selector(|| "agent-composer-area".into())
            .flex()
            .flex_col()
            .gap(px(7.))
            .p(px(12.))
            .flex_none();
        if let Some(run) = &active {
            let status_text = match run.state {
                State::Stopping => t(cx, k::pending::CANCELLING),
                State::RunningTools => t(cx, k::pending::COMMITTING),
                State::AwaitingAnswer => t(cx, k::control::QUESTION_TITLE),
                State::AwaitingPermission => t(cx, k::control::PERMISSION_TITLE),
                _ => {
                    if let Some(started) = run.started_ms {
                        let now = chrono::Utc::now().timestamp_millis();
                        let secs = ((now - started).max(0) / 1000) as u64;
                        if secs >= 1 {
                            tf(cx, k::pending::WITH_SECONDS, &[("seconds", &secs)])
                        } else {
                            t(cx, k::pending::NOW)
                        }
                    } else {
                        t(cx, k::pending::NOW)
                    }
                }
            };
            footer = footer.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .text_color(p.ink(3).solid())
                    .child(sand::thinking(
                        16.,
                        p.ink(3).solid(),
                        run.state == State::Streaming,
                        window,
                    ))
                    .child(status_text),
            );
        }
        if let Some(snap) = &self.snapshot
            && let Some(last) = snap.runs.last()
        {
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
            let session_total: u64 = snap
                .runs
                .iter()
                .map(|r| {
                    let inp = r.usage.input_tokens.saturating_add(
                        if r.config
                            .as_ref()
                            .is_some_and(|c| c.route.provider == dr_agent::Provider::Anthropic)
                        {
                            r.usage
                                .cached_input_tokens
                                .saturating_add(r.usage.cache_write_tokens)
                        } else {
                            0
                        },
                    );
                    inp.saturating_add(r.usage.output_tokens)
                })
                .sum();
            let session_summary = (session_total > 0).then(|| {
                format!(
                    "{} {}",
                    t(cx, k::usage::SESSION),
                    format_compact_tokens(session_total)
                )
            });
            footer = footer.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .font_role(Role::Index)
                    .type_px(theme.scale.caption, theme.scale.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(
                        div()
                            .id("agent-context-usage")
                            .cursor_pointer()
                            .hover(|st| st.text_color(p.ink(1).solid()))
                            .on_click(cx.listener(|panel, _, _, cx| {
                                panel.toggle_context_modal(cx);
                            }))
                            .child(label),
                    )
                    .when_some(session_summary, |el, s| el.child(s)),
            );
        }
        footer = footer
            .child(connection_view::composer_controls(
                self.connections.clone(),
                window,
                cx,
            ))
            .when(!self.attached.is_empty(), |el| {
                el.child(self.tray(window, cx))
            })
            .child(
                div()
                    .key_context("DrAgentComposer")
                    // ⌘V with an image or files on the clipboard attaches
                    // them; anything with text is the field's own paste.
                    .capture_action(cx.listener(|panel, _: &dr_ui::input::field::Paste, _, cx| {
                        if panel.paste_images(cx) {
                            cx.stop_propagation();
                        }
                    }))
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
        let scrolled_up = !self.show_list
            && self.continuity.shown.is_none()
            && self.scroll.max_offset().y + self.scroll.offset().y > px(80.);
        let context_modal = self.context_modal(window, cx);
        root.child(
            div()
                .relative()
                .flex_1()
                .min_h_0()
                .child(
                    div()
                        .id("agent-transcript")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .p(px(14.))
                        .child(content),
                )
                .when(scrolled_up, |el| {
                    el.child(
                        div().absolute().bottom(px(10.)).right(px(14.)).child(
                            Button::new("agent-jump-latest", t(cx, k::JUMP_LATEST))
                                .small()
                                .on_click(cx.listener(|panel, _, _, cx| {
                                    panel.scroll.scroll_to_bottom();
                                    cx.notify();
                                })),
                        ),
                    )
                }),
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
        .children(context_modal)
    }
}

fn format_compact_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.2}M", n as f64 / 1_000_000.0)
    } else if n >= 10_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn format_duration_ms(ms: u64) -> String {
    if ms < 1_000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1_000.0)
    } else {
        let secs = ms / 1_000;
        format!("{}m{}s", secs / 60, secs % 60)
    }
}

fn tool_call_summary(call: &dr_agent::ToolCall) -> (String, Option<String>) {
    let name = data::tool_name(call).to_owned();
    let args = if call.name == "call_tool" {
        call.arguments.get("arguments").unwrap_or(&call.arguments)
    } else {
        &call.arguments
    };
    let preview = [
        "title",
        "name",
        "query",
        "find",
        "prompt",
        "objective",
        "doc",
        "id",
    ]
    .iter()
    .find_map(|key| args.get(*key).and_then(|v| v.as_str()))
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(|s| {
        let mut out: String = s.chars().take(36).collect();
        if s.chars().count() > 36 {
            out.push('…');
        }
        out
    });
    (name, preview)
}

fn paint_context_ring(percent: u64, track: gpui::Hsla, fill: gpui::Hsla) -> AnyElement {
    let frac = (percent as f32 / 100.0).clamp(0.0, 1.0);
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let cx_pt = f32::from(bounds.origin.x) + f32::from(bounds.size.width) * 0.5;
            let cy_pt = f32::from(bounds.origin.y) + f32::from(bounds.size.height) * 0.5;
            let r = (f32::from(bounds.size.width).min(f32::from(bounds.size.height)) * 0.5 - 2.0)
                .max(3.0);
            let steps = 28usize;
            let mut track_path = PathBuilder::stroke(px(2.0));
            for i in 0..=steps {
                let angle =
                    (i as f32 / steps as f32) * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                let pt = point(px(cx_pt + r * angle.cos()), px(cy_pt + r * angle.sin()));
                if i == 0 {
                    track_path.move_to(pt);
                } else {
                    track_path.line_to(pt);
                }
            }
            if let Ok(built) = track_path.build() {
                window.paint_path(built, track);
            }
            if frac > 0.005 {
                let arc_steps = ((steps as f32 * frac).ceil() as usize).max(2);
                let mut fill_path = PathBuilder::stroke(px(2.2));
                for i in 0..=arc_steps {
                    let t = (i as f32 / arc_steps as f32) * frac;
                    let angle = t * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                    let pt = point(px(cx_pt + r * angle.cos()), px(cy_pt + r * angle.sin()));
                    if i == 0 {
                        fill_path.move_to(pt);
                    } else {
                        fill_path.line_to(pt);
                    }
                }
                if let Ok(built) = fill_path.build() {
                    window.paint_path(built, fill);
                }
            }
        },
    )
    .size(px(18.0))
    .into_any_element()
}

/// Why an image cannot go with the message, in the author's language.
fn image_error(error: dr_agent::ImageError, cx: &App) -> String {
    use dr_agent::{ImageError, images};
    use dr_i18n::keys::agent_images as k;
    match error {
        ImageError::Unsupported => t(cx, k::UNSUPPORTED).to_string(),
        ImageError::TooLarge => tf(
            cx,
            k::TOO_LARGE,
            &[
                ("size", &(images::MAX_IMAGE_BYTES / 1024 / 1024)),
                ("side", &images::MAX_IMAGE_SIDE),
            ],
        )
        .to_string(),
        ImageError::TooMany => {
            tf(cx, k::TOO_MANY, &[("max", &images::MAX_IMAGES_PER_MESSAGE)]).to_string()
        }
    }
}

pub struct PanelHead {
    panel: Entity<AgentPanel>,
    _sub: Option<Subscription>,
}
impl PanelHead {
    pub fn new(panel: Entity<AgentPanel>) -> Self {
        Self { panel, _sub: None }
    }

    pub fn new_observed(panel: Entity<AgentPanel>, cx: &mut Context<Self>) -> Self {
        let sub = cx.observe(&panel, |_, _, cx| cx.notify());
        Self {
            panel,
            _sub: Some(sub),
        }
    }
}
impl Render for PanelHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // An opened 0.1 conversation: the back arrow and its title only.
        if let Some(head) = old::head(&self.panel, window, cx) {
            return head;
        }
        if let Some(ret) = self.panel.read(cx).return_to_review().cloned() {
            let panel = self.panel.clone();
            let back_label = t(cx, dr_i18n::keys::v3_review::BACK_TO_REVIEW);
            let p = Theme::of(window, cx).palette;
            return div()
                .flex()
                .items_center()
                .gap(px(8.))
                .w_full()
                .min_w_0()
                .child(
                    dr_ui::components::IconButton::new(
                        "agent-back-to-review",
                        sand::Icon::ArrowBack,
                    )
                    .label(back_label)
                    .on_click(move |_, window, cx| {
                        panel.update(cx, |p, cx| p.back_to_review(window, cx))
                    }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(p.ink(1).solid())
                        .child(ret.title),
                )
                .into_any_element();
        }
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let state = self.panel.read(cx);
        let renaming_field = state.renaming.as_ref().map(|(_, f, _)| f.clone());
        let selected_id = state.selected.clone();
        let current_title = state.current_title(cx);
        let metrics = state.context_metrics();
        let panel = self.panel.clone();
        let new = self.panel.clone();
        let rename_panel = self.panel.clone();
        let ring_panel = self.panel.clone();
        let rename_tip = t(cx, k::toolbar::RENAME_TITLE);
        let history_tip = t(cx, k::toolbar::HISTORY_TITLE);
        let new_tip = t(cx, k::toolbar::NEW_TITLE);

        let title_el: AnyElement = if let Some(field) = renaming_field {
            div().flex_1().min_w_0().child(field).into_any_element()
        } else {
            let title_str = current_title.to_string();
            let can_rename = selected_id.is_some();
            div()
                .id("agent-head-title")
                .flex_1()
                .min_w_0()
                .truncate()
                .px(px(4.))
                .py(px(2.))
                .rounded(px(radius::SM))
                .text_color(p.ink(1).solid())
                .when(can_rename, |el| {
                    let tip = rename_tip.clone();
                    el.cursor_pointer()
                        .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                        .tooltip(tooltip(tip))
                        .on_click(move |_, window, cx| {
                            if let Some(id) = selected_id.clone() {
                                let title = title_str.clone();
                                rename_panel
                                    .update(cx, |p, cx| p.begin_rename(id, title, window, cx));
                            }
                        })
                })
                .child(current_title)
                .into_any_element()
        };

        let ring_el: Option<AnyElement> =
            metrics.map(|(used, limit, percent, output_res, safety)| {
                let ring_color = if percent >= 88 {
                    p.danger.solid()
                } else if percent >= 70 {
                    gpui::hsla(36.0 / 360.0, 0.85, 0.48, 1.0)
                } else {
                    p.accent.solid()
                };
                let tip = tf(
                    cx,
                    k::context::TOOLTIP,
                    &[
                        ("used", &format_compact_tokens(used)),
                        ("limit", &format_compact_tokens(limit)),
                        ("percent", &percent),
                        ("output", &format_compact_tokens(output_res)),
                        ("safety", &format_compact_tokens(safety)),
                    ],
                );
                div()
                    .id("agent-context-ring")
                    .debug_selector(|| "agent-context-ring".into())
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, k::context::PROGRESS_ARIA))
                    .flex_none()
                    .size(px(24.0))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(move |st| st.bg(p.ink(1).alpha(0.06)))
                    .tooltip(tooltip(tip))
                    .on_click(move |_, _, cx| {
                        ring_panel.update(cx, |p, cx| p.toggle_context_modal(cx));
                    })
                    .child(paint_context_ring(
                        percent,
                        p.ink(1).alpha(0.14),
                        ring_color,
                    ))
                    .into_any_element()
            });

        div()
            .flex()
            .items_center()
            .gap(px(4.))
            .w_full()
            .min_w_0()
            .child(title_el)
            .children(ring_el)
            .child(
                div()
                    .id("agent-chat-list-tip")
                    .tooltip(tooltip(history_tip))
                    .child(
                        Button::new("agent-chat-list", t(cx, k::toolbar::HISTORY))
                            .text()
                            .small()
                            .on_click(move |_, _, cx| {
                                panel.update(cx, |p, cx| p.show_history(!p.show_list, cx))
                            }),
                    ),
            )
            .child(
                div()
                    .id("agent-new-chat-tip")
                    .tooltip(tooltip(new_tip))
                    .child(
                        Button::new("agent-new-chat", t(cx, k::NEW_CONVERSATION))
                            .text()
                            .small()
                            .on_click(move |_, _, cx| {
                                new.update(cx, |p, cx| p.new_conversation(cx))
                            }),
                    ),
            )
            .into_any_element()
    }
}
