//! The Review tab: format-5 comments of the book (`kernel-v5.md` §7,
//! `docs/rust-rewrite/modules/m18-review.md`).
//!
//! - Two filter rows over the list:
//!   1. Status (`未解决 n` / `已解决 n` / `全部`) + scope toggle (`当前`).
//!   2. Origin (`全部` / `手写` / `标记` / `清单` / `Agent` / `读者`).
//! - Grouped by entry (or standalone asset), never by `entry · module`; each
//!   card names `模块名 · 那一处` above its quoted text (omitted on whole-entry
//!   cards, module name only on whole-module cards, no quote on `marker` cards,
//!   struck through with `找不到原处` when the sub-target is gone while its
//!   entry remains live).
//! - Checklist (`task`) items inside each entry group collapse into `清单 n`
//!   unless the origin filter is `清单`; resolving a `task` card calls
//!   `comment.update`, which ticks or clears the prose checkbox on the data
//!   layer (`edit` and `delete` are not offered on `task` cards).
//! - Every card uses the round `.ring` completion circle (hover previews a
//!   faint check; clicking draws the check stroke over `0.38s`).
//! - Resting on a card floats its source hover card beside it: entry mark +
//!   title, `模块 · 那一处`, passage slip, and actions (`编辑`, `解决`/`未解决`,
//!   `交给 Agent ›` with a side note flyout `写给 Agent…`, `打开对话` once
//!   linked, and `删除`).
//! - After handing a comment to Agent, a bottom-right hollow pinwheel spins
//!   counter-clockwise (`1.6s`/turn), decelerates uniformly over `3.0s` when
//!   finished, cross-fades over `0.6s` to a solid pinwheel until viewed, and
//!   opens the conversation on click (`‹ 回审阅` in the Agent header).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_editor::decor::{Original, ReviewFocus};
use dr_i18n::{I18n, Locale, Platform, keys};
use dr_ui::Theme;
use dr_ui::anim::{self, Tween};
use dr_ui::components::{
    Button, CardAction, CardBody, EmptyState, HoverCard, ScopeToggle, Segmented,
    menu::{float_shadow, slab_edge},
    overlay::{self, Layer, Place as OverlayPlace},
};
use dr_ui::fonts::Role;
use dr_ui::glass::{self, Ground, Kind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextArea};
use dr_ui::sand::{self, Icon, KindMark};
use dr_ui::style::DrStyled;
use dr_ui::tokens::{Easing, menu as menu_tokens, motion, radius};
use dr_workspace::commands::comment::CommentUpdateIn;
use dr_workspace::dto::CommentInfo;
use dr_workspace::{Actor, Workspace};
use gpui::{
    AnyElement, AppContext, Bounds, ClickEvent, Context, ElementId, Entity, Focusable as _,
    InteractiveElement, IntoElement, ParentElement, Pixels, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, Window, canvas, div, point,
    prelude::FluentBuilder, px,
};

use crate::agent_bridge::{self, CommentAgentRequest, CompanionFocusRequest, ConversationPinwheel};
use crate::model::{Filter, Group, Listing, OriginFilter, Place, StatusFilter};
use crate::v3::PartWhere;

/// Side sub-flyout (`写给 Agent…`) opened when resting on `交给 Agent ›`.
struct AgentSubFlyout {
    comment_id: String,
    card_bounds: Option<Bounds<Pixels>>,
    row_bounds: Option<Bounds<Pixels>>,
    review_bounds: Option<Bounds<Pixels>>,
    hop_started: Option<Instant>,
    over_row: bool,
    over_box: bool,
    force_closed: bool,
    grace: Option<Task<()>>,
    field: Entity<TextArea>,
    _sub: Subscription,
}

/// The Review tab of one pane.
pub struct ReviewView {
    id: SharedString,
    lib: Option<Workspace>,
    pub(crate) book: String,
    book_epoch: u64,
    v3: Option<crate::v3_panel::State>,
    v3_load: u64,
    data_rev: u64,
    i18n: I18n,
    items: Vec<CommentInfo>,
    filter: Filter,
    status_filter: StatusFilter,
    origin_filter: OriginFilter,
    current_only: bool,
    expanded_tasks: HashSet<String>,
    reveal: Option<Reveal>,
    reveal_serial: u64,
    scroll: ScrollHandle,
    editing: Option<(String, Entity<TextArea>, Subscription)>,
    agent_flyout: Option<AgentSubFlyout>,
    writing: HashSet<String>,
    in_flight: Vec<futures::future::Shared<futures::channel::oneshot::Receiver<()>>>,
    write_errors: HashMap<String, String>,
    /// Check strokes currently animating (`0.38s`).
    checks: HashMap<String, Tween>,
    hovered_check: Option<String>,
    /// Per-card pinwheel animation tracks (`Running` -> `3.0s` slow -> `0.6s` solid).
    pinwheels: RefCell<HashMap<String, sand::PinwheelTrack>>,
    card_bounds: RefCell<HashMap<String, Bounds<Pixels>>>,
    pending: Option<Task<()>>,
    loaded: bool,
    /// The passages source cards show (`原文`), read when a card opens.
    originals: HashMap<String, (Instant, Option<Original>)>,
    asking: HashSet<String>,
}

/// How long a source card trusts the passage it read.
const ORIGINAL_FRESH: Duration = Duration::from_secs(2);

struct Reveal {
    id: String,
    serial: u64,
    ready: bool,
    reply: futures::channel::oneshot::Sender<bool>,
}

impl ReviewView {
    pub(crate) fn new(id: SharedString, lib: Option<Workspace>) -> ReviewView {
        ReviewView {
            id,
            lib,
            book: String::new(),
            book_epoch: 0,
            v3: Some(crate::v3_panel::State {
                scope: None,
                snapshot: crate::v3::Snapshot::default(),
                open: Rc::new(|_, _, _| {}),
                open_agent: None,
                marks: Rc::new(|_| None),
            }),
            v3_load: 0,
            data_rev: 0,
            i18n: I18n::new(Locale::default(), Platform::current()),
            items: Vec::new(),
            filter: Filter::All,
            status_filter: StatusFilter::Open,
            origin_filter: OriginFilter::All,
            current_only: false,
            expanded_tasks: HashSet::new(),
            reveal: None,
            reveal_serial: 0,
            scroll: ScrollHandle::new(),
            editing: None,
            agent_flyout: None,
            writing: HashSet::new(),
            in_flight: Vec::new(),
            write_errors: HashMap::new(),
            checks: HashMap::new(),
            hovered_check: None,
            pinwheels: RefCell::new(HashMap::new()),
            card_bounds: RefCell::new(HashMap::new()),
            pending: None,
            loaded: false,
            originals: HashMap::new(),
            asking: HashSet::new(),
        }
    }

    pub(crate) fn is_v3(&self) -> bool {
        self.v3.is_some()
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn show_v3(
        &mut self,
        book: &str,
        target: Option<crate::v3::Target>,
        locale: Locale,
        platform: Platform,
        open: crate::v3_panel::Open,
        marks: crate::v3_panel::Marks,
        cx: &mut Context<Self>,
    ) {
        let changed_book = self.book != book || self.v3.is_none();
        if changed_book {
            self.book_epoch += 1;
            self.pending = None;
            self.v3_load += 1;
            self.book = book.to_owned();
            self.items.clear();
            self.originals.clear();
            self.asking.clear();
            self.editing = None;
            self.agent_flyout = None;
            self.expanded_tasks.clear();
            self.pinwheels.borrow_mut().clear();
            self.card_bounds.borrow_mut().clear();
            self.writing.clear();
            self.write_errors.clear();
            self.reveal = None;
            self.loaded = false;
            let prev_open_agent = self.v3.as_ref().and_then(|s| s.open_agent.clone());
            self.v3 = Some(crate::v3_panel::State {
                scope: target.clone(),
                snapshot: crate::v3::Snapshot::default(),
                open: open.clone(),
                open_agent: prev_open_agent,
                marks: marks.clone(),
            });
        }
        let state = self.v3.as_mut().expect("v3 state");
        let changed_target = state.scope != target;
        state.scope = target;
        state.open = open;
        state.marks = marks;
        self.data_rev += 1;
        if self.i18n.locale() != locale {
            self.i18n = I18n::new(locale, platform);
        }
        if changed_book {
            self.reload(cx);
        }
        if changed_book || changed_target {
            cx.notify();
        }
    }

    pub(crate) fn set_open_agent(&mut self, open_agent: Option<crate::v3_panel::OpenAgent>) {
        if let Some(state) = &mut self.v3 {
            state.open_agent = open_agent;
        }
    }

    /// Accept navigation to a comment, including when this pane has not yet
    /// loaded it. Only filters and folds which conceal this item are relaxed.
    pub fn reveal_comment(
        &mut self,
        book: &str,
        id: &str,
        cx: &mut Context<Self>,
    ) -> futures::channel::oneshot::Receiver<bool> {
        if self.book != book {
            self.book_epoch += 1;
            self.book = book.to_owned();
            self.items.clear();
            self.data_rev += 1;
            if let Some(state) = &mut self.v3 {
                self.editing = None;
                self.agent_flyout = None;
                self.expanded_tasks.clear();
                self.writing.clear();
                self.write_errors.clear();
                state.snapshot = crate::v3::Snapshot::default();
                state.scope = None;
                self.originals.clear();
                self.asking.clear();
            }
            self.loaded = false;
        }
        let (reply, received) = futures::channel::oneshot::channel();
        if self.lib.is_none() || book.is_empty() {
            self.reveal = None;
            let _ = reply.send(false);
            return received;
        }
        self.reveal_serial += 1;
        self.reveal = Some(Reveal {
            id: id.to_owned(),
            serial: self.reveal_serial,
            ready: false,
            reply,
        });
        self.reload(cx);
        received
    }

    fn apply_reveal(&mut self) {
        let Some(mut reveal) = self.reveal.take() else {
            return;
        };
        if reveal.reply.is_canceled() {
            return;
        }
        let Some(item) = self.items.iter().find(|item| item.id == reveal.id).cloned() else {
            let _ = reveal.reply.send(false);
            return;
        };
        let is_projected = matches!(item.origin.as_str(), "marker" | "task");
        if (self.filter == Filter::Todos && !is_projected)
            || (self.filter == Filter::Comments && is_projected)
        {
            self.filter = Filter::All;
        }
        if !self.origin_filter.matches(&item.origin) {
            self.origin_filter = OriginFilter::All;
        }
        if (item.status == "resolved" && self.status_filter == StatusFilter::Open)
            || (item.status != "resolved" && self.status_filter == StatusFilter::Resolved)
        {
            self.status_filter = StatusFilter::All;
        }
        let listing = self.listing();
        if self.current_only
            && !listing
                .open
                .iter()
                .chain(&listing.resolved)
                .flat_map(|group| &group.items)
                .any(|c| c.id == reveal.id)
        {
            self.current_only = false;
        }
        if item.origin == "task" && self.origin_filter != OriginFilter::Task {
            let refreshed = self.listing();
            for group in refreshed.open.iter().chain(&refreshed.resolved) {
                if group.items.iter().any(|c| c.id == reveal.id) {
                    self.expanded_tasks.insert(group.key());
                }
            }
        }
        reveal.ready = true;
        self.reveal = Some(reveal);
    }

    /// The comments changed: read them again shortly.
    pub(crate) fn schedule(&mut self, cx: &mut Context<Self>) {
        if self.v3.is_some() {
            self.v3_load += 1;
        }
        self.pending = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(60))
                .await;
            this.update(cx, |this, cx| this.reload(cx)).ok();
        }));
    }

    /// Reloads the current book's v3 review snapshot immediately.
    pub fn reload_now(&mut self, cx: &mut Context<Self>) {
        self.reload(cx);
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        self.reload_v3(cx);
    }

    fn reload_v3(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else { return };
        if self.book.is_empty() {
            return;
        }
        self.v3_load += 1;
        let serial = self.v3_load;
        let book = self.book.clone();
        let requested = book.clone();
        let task = cx
            .background_executor()
            .spawn(async move { crate::v3::load(&lib, &requested) });
        self.pending = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.book != book || this.v3_load != serial {
                    return;
                }
                this.pending = None;
                let Some(state) = &mut this.v3 else { return };
                match result {
                    Ok(snapshot) => {
                        let draft_card = this.editing.as_ref().and_then(|(id, _, _)| {
                            this.items.iter().find(|item| &item.id == id).cloned()
                        });
                        this.items = snapshot.items.iter().map(crate::v3::Item::card).collect();
                        if let Some(card) = draft_card
                            && !this.items.iter().any(|item| item.id == card.id)
                        {
                            // An external deletion must not remove the author's
                            // unsaved field from the UI. This card is display-only.
                            this.items.push(card);
                        }
                        state.snapshot = snapshot;
                        this.data_rev += 1;
                        this.loaded = true;
                        this.originals.clear();
                        this.apply_reveal();
                    }
                    Err(e) => {
                        log::warn!("review: v3 load: {e}");
                        if this.editing.is_none() {
                            this.items.clear();
                            state.snapshot = crate::v3::Snapshot::default();
                        }
                        this.data_rev += 1;
                        this.loaded = false;
                        if let Some(reveal) = this.reveal.take() {
                            let _ = reveal.reply.send(false);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Whether the first v3 snapshot load for the current book has completed.
    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// Monotonic counter incremented whenever loaded snapshot, items, inline
    /// edit state or locale/marks bindings change.
    pub fn data_revision(&self) -> u64 {
        self.data_rev
    }

    /// Current v3 snapshot (comments and targets).
    pub fn v3_snapshot(&self) -> Option<&crate::v3::Snapshot> {
        self.v3.as_ref().map(|s| &s.snapshot)
    }

    /// Comment currently being edited in place, if any.
    pub fn editing_id(&self) -> Option<&str> {
        self.editing.as_ref().map(|(id, _, _)| id.as_str())
    }

    /// Whether comment `id` has a partial write in flight.
    pub fn is_writing(&self, id: &str) -> bool {
        self.writing.contains(id)
    }

    /// Waits for all in-flight comment writes launched by this view to settle.
    pub fn drain_writes(&self) -> futures::future::LocalBoxFuture<'static, ()> {
        use futures::FutureExt as _;
        let waiters: Vec<_> = self
            .in_flight
            .iter()
            .filter(|rx| rx.peek().is_none())
            .cloned()
            .collect();
        async move {
            for rx in waiters {
                let _ = rx.await;
            }
        }
        .boxed_local()
    }

    /// Cards for `filter` and explicit `scope`, preserving any unsaved draft
    /// card whose persisted comment was externally removed while being edited.
    pub fn cards_for(&self, filter: Filter, scope: Option<&crate::v3::Target>) -> Listing {
        let mut listing = self
            .v3
            .as_ref()
            .map(|state| state.snapshot.cards(filter, scope))
            .unwrap_or_default();
        if self.v3.is_some()
            && let Some((editing, _, _)) = &self.editing
            && !listing
                .open
                .iter()
                .chain(&listing.resolved)
                .flat_map(|g| &g.items)
                .any(|item| &item.id == editing)
            && let Some(card) = self.items.iter().find(|item| &item.id == editing)
        {
            let is_projected = matches!(card.origin.as_str(), "marker" | "task");
            let matches_kind = match filter {
                Filter::All => true,
                Filter::Comments => !is_projected,
                Filter::Todos => is_projected,
            };
            if matches_kind {
                listing.open.insert(
                    0,
                    Group {
                        place: Place::Floating,
                        items: vec![card.clone()],
                    },
                );
            }
        }
        listing
    }

    /// Group header metadata `(mark, title, jump_target)` for multi-column hosts.
    pub fn group_header(
        &self,
        group: &Group,
    ) -> (Option<sand::Kind>, SharedString, Option<crate::v3::Target>) {
        match &group.place {
            Place::V3(target) => {
                let mark = self.v3.as_ref().and_then(|s| (s.marks)(target));
                (mark, self.group_title(group), Some(target.clone()))
            }
            Place::Gone | Place::Floating => (None, self.group_title(group), None),
        }
    }

    /// Renders a single review card with its inline editor, failed-draft state
    /// and source hover card.
    pub fn render_card(
        &self,
        item: &CommentInfo,
        resolved: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.card(item, resolved, window, cx)
    }

    /// What is listed now (filtered by `origin_filter`, legacy `filter`, and `current_only`).
    pub fn listing(&self) -> Listing {
        self.v3
            .as_ref()
            .map(|state| {
                state.snapshot.cards_filtered(
                    self.origin_filter,
                    self.filter,
                    self.current_only.then_some(state.scope.as_ref()).flatten(),
                )
            })
            .unwrap_or_default()
    }

    pub fn set_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    pub fn status_filter(&self) -> StatusFilter {
        self.status_filter
    }

    pub fn set_status_filter(&mut self, status: StatusFilter, cx: &mut Context<Self>) {
        self.status_filter = status;
        cx.notify();
    }

    pub fn origin_filter(&self) -> OriginFilter {
        self.origin_filter
    }

    pub fn set_origin_filter(&mut self, origin: OriginFilter, cx: &mut Context<Self>) {
        self.origin_filter = origin;
        cx.notify();
    }

    pub fn current_only(&self) -> bool {
        self.current_only
    }

    pub fn set_current_only(&mut self, on: bool, cx: &mut Context<Self>) {
        self.current_only = on;
        cx.notify();
    }

    pub fn is_task_fold_open(&self, group_key: &str) -> bool {
        self.expanded_tasks.contains(group_key)
    }

    pub fn toggle_task_fold(&mut self, group_key: &str, cx: &mut Context<Self>) {
        if !self.expanded_tasks.remove(group_key) {
            self.expanded_tasks.insert(group_key.to_owned());
        }
        cx.notify();
    }

    fn update_comment(&mut self, input: CommentUpdateIn, cx: &mut Context<Self>) {
        self.write_v3(
            input.id.clone(),
            "comment.update",
            serde_json::to_value(input).expect("serializable comment update"),
            false,
            cx,
        );
    }

    /// Partial commands only. The read projection is never written back,
    /// and a refused write keeps both the persisted card and the draft.
    fn write_v3(
        &mut self,
        id: String,
        command: &'static str,
        input: serde_json::Value,
        close_editor: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.lib.clone() else { return };
        if !self.writing.insert(id.clone()) {
            return;
        }
        self.write_errors.remove(&id);
        if let Some((editing, field, _)) = &self.editing
            && editing == &id
        {
            field.update(cx, |f, cx| f.set_disabled(true, cx));
        }
        let book = self.book.clone();
        let book_epoch = self.book_epoch;
        self.in_flight.retain(|rx| rx.peek().is_none());
        let (done_tx, done_rx) = futures::channel::oneshot::channel();
        self.in_flight.push(futures::FutureExt::shared(done_rx));
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let out = lib.call(&Actor::User, command, input);
                    let _ = done_tx.send(());
                    out
                })
                .await;
            this.update(cx, |v, cx| {
                v.in_flight.retain(|rx| rx.peek().is_none());
                if v.book != book || v.book_epoch != book_epoch || v.v3.is_none() {
                    return;
                }
                v.writing.remove(&id);
                if let Some((editing, field, _)) = &v.editing
                    && editing == &id
                {
                    field.update(cx, |f, cx| f.set_disabled(false, cx));
                }
                match result {
                    Ok(_) => {
                        if close_editor && v.editing.as_ref().is_some_and(|(e, _, _)| e == &id) {
                            v.editing = None;
                            v.data_rev += 1;
                        }
                        v.reload(cx);
                    }
                    Err(error) => {
                        v.write_errors.insert(id, error.to_string());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn update_in(&self, id: &str) -> CommentUpdateIn {
        CommentUpdateIn {
            book: self.book.clone(),
            id: id.to_owned(),
            body: None,
            status: None,
            agent_conversation: None,
        }
    }

    /// Completes or reopens a comment; animates the `.ring` check stroke over `0.38s`.
    pub fn set_done(&mut self, id: &str, done: bool, cx: &mut Context<Self>) {
        let now = anim::now();
        let mut tween = Tween::still(if done { 0.0 } else { 1.0 });
        tween.retarget(
            if done { 1.0 } else { 0.0 },
            now,
            CHECK_DRAW,
            Easing::EASE_OUT,
        );
        self.checks.insert(id.to_owned(), tween);
        let mut input = self.update_in(id);
        input.status = Some(if done { "resolved" } else { "open" }.into());
        self.update_comment(input, cx);
    }

    /// Starts editing a card's body in place (`task` cards cannot be edited here).
    pub fn edit(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.v3.is_some() && (self.writing.contains(id) || self.editing.is_some()) {
            return;
        }
        let Some(item) = self.items.iter().find(|i| i.id == id) else {
            return;
        };
        if item.origin == "task" {
            return;
        }
        let body = item.body.text.clone();
        let placeholder = self
            .i18n
            .t(keys::review_panel::COMMENT_PLACEHOLDER)
            .to_owned();
        let field_id = ElementId::Name(format!("{}-edit-{id}", self.id).into());
        let field = cx.new(|cx| {
            TextArea::new(field_id, window, cx)
                .placeholder(placeholder)
                .with_text(body)
        });
        let comment = id.to_owned();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, _, e: &FieldEvent, _, cx| match e {
                FieldEvent::Submitted(text) => this.finish_edit(&comment, Some(text.clone()), cx),
                FieldEvent::Cancelled => this.finish_edit(&comment, None, cx),
                _ => {}
            },
        );
        let handle = gpui::Focusable::focus_handle(field.read(cx), cx);
        window.focus(&handle, cx);
        self.editing = Some((id.to_owned(), field, sub));
        self.data_rev += 1;
        cx.notify();
    }

    /// Ends editing: saves `text` (or cancels with `None`).
    pub fn finish_edit(&mut self, id: &str, text: Option<String>, cx: &mut Context<Self>) {
        if self.writing.contains(id) {
            return;
        }
        if let Some(text) = text {
            let mut input = self.update_in(id);
            input.body = Some(text.into());
            self.write_v3(
                id.to_owned(),
                "comment.update",
                serde_json::to_value(input).expect("serializable comment update"),
                true,
                cx,
            );
            return;
        }
        self.write_errors.remove(id);
        if self
            .editing
            .as_ref()
            .is_some_and(|(editing, _, _)| editing == id)
        {
            self.editing = None;
            self.data_rev += 1;
            self.reload(cx);
        }
        cx.notify();
    }

    /// Deletes a comment (`task` cards cannot be deleted here).
    pub fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        if self
            .items
            .iter()
            .find(|i| i.id == id)
            .is_some_and(|i| i.origin == "task")
        {
            return;
        }
        self.write_v3(
            id.to_owned(),
            "comment.delete",
            serde_json::json!({"book": self.book, "id": id}),
            true,
            cx,
        );
    }

    /// Dispatches comment `id` (with optional `extra_note`) to the Agent runtime.
    pub fn hand_to_agent(&mut self, id: &str, extra_note: String, cx: &mut Context<Self>) {
        let Some(state) = &self.v3 else { return };
        let Some(v3_item) = state.snapshot.item(id).cloned() else {
            return;
        };
        let where_str = self.format_where(&v3_item);
        let header_place = if !where_str.is_empty() {
            Some(where_str.to_string())
        } else if !v3_item.title.trim().is_empty() {
            Some(v3_item.title.clone())
        } else {
            None
        };
        let header = match header_place {
            Some(place) => self
                .i18n
                .fmt(keys::v3_review::COMMENT_FROM_HEADER, &[("where", &place)]),
            None => self.i18n.t(keys::v3_review::COMMENT_FROM_SIMPLE).to_owned(),
        };
        let quote = if v3_item.comment.origin == dr_model::kind::CommentOrigin::Marker {
            None
        } else {
            v3_item
                .part_quote
                .clone()
                .or_else(|| v3_item.comment.quote.clone())
        };
        let req = CommentAgentRequest {
            book_id: self.book.clone(),
            book_name: state.snapshot.book_name.clone(),
            comment_id: id.to_owned(),
            existing_conversation: v3_item.comment.agent_conversation.clone(),
            header,
            quote,
            body: v3_item.comment.body.text.clone(),
            extra_note: extra_note.trim().to_owned(),
        };
        if let Some(flyout) = &mut self.agent_flyout
            && flyout.comment_id == id
        {
            flyout.force_closed = true;
            flyout.over_row = false;
            flyout.over_box = false;
        }
        let _ = agent_bridge::dispatch(req, cx);
        cx.notify();
    }

    /// Marks the linked Agent conversation of comment `id` as viewed and opens it in the Agent tab.
    pub fn open_agent_conversation(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(state) = &self.v3 else { return };
        let Some(v3_item) = state.snapshot.item(id) else {
            return;
        };
        let Some(conversation_id) = v3_item.comment.agent_conversation.clone() else {
            return;
        };
        let return_title = self.return_title(v3_item);
        let open_agent = state.open_agent.clone();
        let book_id = self.book.clone();
        agent_bridge::mark_viewed(&book_id, &conversation_id, cx);
        self.pinwheels.borrow_mut().remove(id);
        let req = CompanionFocusRequest {
            book_id,
            conversation_id,
            comment_id: id.to_owned(),
            return_title: return_title.to_string(),
        };
        agent_bridge::request_open_conversation(req.clone(), cx);
        if let Some(open_cb) = open_agent {
            open_cb(req, window, cx);
        }
        cx.notify();
    }

    fn return_title(&self, item: &crate::v3::Item) -> SharedString {
        let where_str = self.format_where(item);
        match (&item.place, where_str.is_empty()) {
            (crate::v3::Place::On(_), false) if !item.title.is_empty() => {
                format!("{} · {where_str}", item.title).into()
            }
            (crate::v3::Place::On(_), true) if !item.title.is_empty() => item.title.clone().into(),
            (crate::v3::Place::Gone, _) => self.i18n.t(keys::review_panel::groups::DELETED).into(),
            _ => self.i18n.t(keys::review_panel::SOURCE_FLOATING).into(),
        }
    }

    fn format_where(&self, item: &crate::v3::Item) -> SharedString {
        let mod_label = item
            .module_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                item.retained
                    .then(|| self.i18n.t(keys::k4_book::RETAINED_CONTENT))
            });
        let region_str = |r: Option<u32>| -> String {
            match r {
                Some(page) => self
                    .i18n
                    .fmt(keys::v3_review::REGION_PLACE_PAGED, &[("page", &page)]),
                None => self.i18n.t(keys::v3_review::REGION_PLACE).to_owned(),
            }
        };
        match &item.part_where {
            PartWhere::Floating | PartWhere::WholeEntry => SharedString::default(),
            PartWhere::WholeModule | PartWhere::Prose => {
                mod_label.unwrap_or_default().to_owned().into()
            }
            PartWhere::NamedPart(label) => match (mod_label, label.trim()) {
                (Some(m), l) if !l.is_empty() => format!("{m} · {l}").into(),
                (Some(m), _) => m.to_owned().into(),
                (None, l) if !l.is_empty() => l.to_owned().into(),
                _ => SharedString::default(),
            },
            PartWhere::EntryAsset {
                asset_title,
                region,
            } => {
                let mut parts: Vec<String> = Vec::new();
                if let Some(m) = mod_label {
                    parts.push(m.to_owned());
                }
                if let Some(t) = asset_title.as_deref().filter(|s| !s.is_empty()) {
                    parts.push(t.to_owned());
                }
                if let Some(r) = *region {
                    parts.push(region_str(r));
                }
                parts.join(" · ").into()
            }
            PartWhere::StandaloneAsset { region } => match *region {
                None => self.i18n.t(keys::v3_review::WHOLE_FILE).to_owned().into(),
                Some(r) => region_str(r).into(),
            },
        }
    }

    /// Sub-target label (`模块名 · 那一处`) for comment `id`.
    pub fn where_label(&self, id: &str) -> SharedString {
        self.v3
            .as_ref()
            .and_then(|s| s.snapshot.item(id))
            .map(|i| self.format_where(i))
            .unwrap_or_default()
    }

    /// What the source card of comment `id` says: where it is (`条目 · 模块 · 那一处`),
    /// and the passage/value it is anchored to.
    pub fn source_summary(&self, id: &str) -> Option<(SharedString, Option<SharedString>)> {
        if let Some(state) = &self.v3
            && let Some(item) = state.snapshot.item(id)
        {
            let title = self.return_title(item);
            let quote = if item.comment.origin == dr_model::kind::CommentOrigin::Marker {
                None
            } else {
                item.part_quote
                    .clone()
                    .or_else(|| item.comment.quote.clone())
                    .map(Into::into)
            };
            return Some((title, quote));
        }
        let item = self.items.iter().find(|i| i.id == id)?;
        let source = self.source_of(item);
        Some((source.title, source.quote))
    }

    /// The passage comment `id` was written on, as last read (see
    /// [`Self::want_original`]).
    pub fn original_of(&self, id: &str) -> Option<&Original> {
        self.originals.get(id).and_then(|(_, o)| o.as_ref())
    }

    /// Reads comment `id`'s passage (`原文` snapshot, and whether the prose has
    /// changed under it) unless a fresh one is at hand.
    pub fn want_original(&mut self, id: &str, cx: &mut Context<Self>) {
        let fresh = self
            .originals
            .get(id)
            .is_some_and(|(at, _)| at.elapsed() < ORIGINAL_FRESH);
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if fresh || !self.asking.insert(id.to_owned()) {
            return;
        }
        let (book, comment) = (self.book.clone(), id.to_owned());
        let requested_book = book.clone();
        let v3 = self.v3.is_some();
        let v3_load = self.v3_load;
        let task = cx.background_executor().spawn(async move {
            crate::v3::original(&lib, &book, &comment).map_err(|e| e.to_string())
        });
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let found = task.await;
            this.update(cx, |this, cx| {
                if (v3 || this.v3.is_some())
                    && (this.book != requested_book || this.v3.is_some() != v3)
                {
                    return;
                }
                this.asking.remove(&id);
                if v3 && this.v3_load != v3_load {
                    return;
                }
                let found = found.unwrap_or_else(|e| {
                    log::warn!("review: the passage of {id}: {e}");
                    None
                });
                let changed = this.originals.get(&id).map(|(_, o)| o) != Some(&found);
                this.originals.insert(id, (Instant::now(), found));
                if changed {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn source_of(&self, item: &CommentInfo) -> Source {
        self.source_of_id(&item.id, item.quote.as_deref())
    }

    fn source_of_id(&self, id: &str, quote: Option<&str>) -> Source {
        if let Some(state) = &self.v3
            && let Some(item) = state.snapshot.item(id)
        {
            let title: SharedString = match &item.place {
                crate::v3::Place::On(_) => item.title.clone().into(),
                crate::v3::Place::Gone => self.i18n.t(keys::review_panel::groups::DELETED).into(),
                crate::v3::Place::Floating => {
                    self.i18n.t(keys::review_panel::SOURCE_FLOATING).into()
                }
            };
            let mark_target = match &item.place {
                crate::v3::Place::On(t) => Some(t),
                _ => item.target.as_ref(),
            };
            let where_label = self.format_where(item);
            let quote = if item.comment.origin == dr_model::kind::CommentOrigin::Marker {
                None
            } else {
                item.part_quote
                    .as_deref()
                    .or(quote)
                    .map(|q| q.to_owned().into())
            };
            return Source {
                title,
                where_label: (!where_label.is_empty()).then_some(where_label),
                mark: mark_target.and_then(|t| (state.marks)(t)),
                quote,
            };
        }
        Source {
            title: self.i18n.t(keys::review_panel::SOURCE_FLOATING).into(),
            where_label: None,
            mark: None,
            quote: None,
        }
    }

    /// Jumps to a comment's place: opens its entry (or standalone asset) and
    /// replays the sand underline / anchor draw-in.
    pub fn jump(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(state) = &self.v3
            && let Some(item) = state.snapshot.item(id)
            && matches!(item.place, crate::v3::Place::On(_))
            && let Some(target) = item.target.clone()
        {
            ReviewFocus::jump(id, cx);
            (state.open)(target, window, cx);
        }
    }

    fn group_title(&self, group: &Group) -> SharedString {
        match &group.place {
            Place::V3(target) => self
                .v3
                .as_ref()
                .and_then(|s| s.snapshot.item_for_target(target))
                .map(|i| i.title.clone().into())
                .unwrap_or_default(),
            Place::Gone => self.i18n.t(keys::review_panel::groups::DELETED).into(),
            Place::Floating => self.i18n.t(keys::review_panel::groups::FLOATING).into(),
        }
    }

    fn enter_agent_row(
        &mut self,
        comment_id: &str,
        review_bounds: Option<Bounds<Pixels>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let same = self
            .agent_flyout
            .as_ref()
            .is_some_and(|f| f.comment_id == comment_id);
        if same {
            if let Some(flyout) = &mut self.agent_flyout {
                flyout.over_row = true;
                flyout.force_closed = false;
                flyout.grace = None;
                flyout.hop_started = Some(anim::now());
                if review_bounds.is_some() {
                    flyout.review_bounds = review_bounds;
                }
            }
            cx.notify();
            return;
        }
        let cid = comment_id.to_owned();
        let placeholder = self.i18n.t(keys::v3_review::NOTE_FOR_AGENT).to_owned();
        let field_id = ElementId::Name(format!("{}-agent-note-{cid}", self.id).into());
        let field = cx.new(|cx| TextArea::new(field_id, window, cx).placeholder(placeholder));
        let sub_cid = cid.clone();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, _, ev: &FieldEvent, _, cx| match ev {
                FieldEvent::Submitted(text) => this.hand_to_agent(&sub_cid, text.clone(), cx),
                FieldEvent::Cancelled => {
                    if let Some(f) = &mut this.agent_flyout
                        && f.comment_id == sub_cid
                    {
                        f.force_closed = true;
                        f.over_row = false;
                        f.over_box = false;
                    }
                    cx.notify();
                }
                _ => {}
            },
        );
        self.agent_flyout = Some(AgentSubFlyout {
            comment_id: cid,
            card_bounds: None,
            row_bounds: None,
            review_bounds,
            hop_started: Some(anim::now()),
            over_row: true,
            over_box: false,
            force_closed: false,
            grace: None,
            field,
            _sub: sub,
        });
        cx.notify();
    }

    fn leave_agent_part(&mut self, comment_id: &str, from_box: bool, cx: &mut Context<Self>) {
        let Some(flyout) = &mut self.agent_flyout else {
            return;
        };
        if flyout.comment_id != comment_id {
            return;
        }
        if from_box {
            flyout.over_box = false;
        } else {
            flyout.over_row = false;
        }
        if !flyout.over_row && !flyout.over_box {
            let cid = comment_id.to_owned();
            flyout.grace = Some(cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(240))
                    .await;
                this.update(cx, |this, cx| {
                    let close = this
                        .agent_flyout
                        .as_ref()
                        .is_some_and(|f| f.comment_id == cid && !f.over_row && !f.over_box);
                    if close {
                        this.agent_flyout = None;
                        cx.notify();
                    }
                })
                .ok();
            }));
        }
        cx.notify();
    }

    fn is_holding_hover_card(&self, comment_id: &str, window: &Window, cx: &gpui::App) -> bool {
        self.agent_flyout.as_ref().is_some_and(|f| {
            f.comment_id == comment_id
                && !f.force_closed
                && (f.over_box || f.field.read(cx).focus_handle(cx).is_focused(window))
        })
    }

    fn origin_word(&self, item: &CommentInfo) -> Option<SharedString> {
        match item.origin.as_str() {
            "manual" => None,
            "marker" => Some(self.i18n.t(keys::v3_review::ORIGIN_MARKER).into()),
            "task" => Some(self.i18n.t(keys::v3_review::ORIGIN_TASK).into()),
            "agent" => Some(self.i18n.t(keys::v3_review::ORIGIN_AGENT).into()),
            "reader" => match item.author_name.as_deref().map(str::trim) {
                Some(name) if !name.is_empty() => Some(
                    self.i18n
                        .fmt(keys::v3_review::ORIGIN_READER_NAMED, &[("name", &name)])
                        .into(),
                ),
                _ => Some(self.i18n.t(keys::v3_review::ORIGIN_READER).into()),
            },
            _ => None,
        }
    }

    fn pinwheel_corner(
        &self,
        item: &CommentInfo,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let conv_id = item.agent_conversation.as_deref()?;
        if self.book.is_empty() {
            return None;
        }
        agent_bridge::ensure_watched(&self.book, conv_id, cx);
        let state = agent_bridge::pinwheel_state(&self.book, conv_id, cx);
        let now = anim::now();
        let sample = match state {
            ConversationPinwheel::Hidden => {
                self.pinwheels.borrow_mut().remove(&item.id);
                return None;
            }
            ConversationPinwheel::Running => {
                let mut map = self.pinwheels.borrow_mut();
                let track = map
                    .entry(item.id.clone())
                    .or_insert_with(|| sand::PinwheelTrack::spinning(now));
                track.sync(true, now);
                track.sample(now)
            }
            ConversationPinwheel::UnviewedDone => {
                let mut map = self.pinwheels.borrow_mut();
                let track = map
                    .entry(item.id.clone())
                    .or_insert_with(sand::PinwheelTrack::finished);
                track.sync(false, now);
                track.sample(now)
            }
        };
        let p = Theme::of(window, cx).palette;
        let entity = cx.entity();
        let comment = item.id.clone();
        let open_label: SharedString = self.i18n.t(keys::v3_review::OPEN_CONVERSATION).into();
        Some(
            div()
                .id(ElementId::Name(
                    format!("{}-pinwheel-{}", self.id, item.id).into(),
                ))
                .debug_selector({
                    let id = self.id.clone();
                    let cid = item.id.clone();
                    move || format!("{id}-pinwheel-{cid}")
                })
                .role(gpui::Role::Button)
                .aria_label(open_label)
                .absolute()
                .right(px(8.0))
                .bottom(px(8.0))
                .size(px(22.0))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .child(sand::pinwheel_element(
                    sample,
                    16.0,
                    p.ink(2).solid(),
                    window,
                ))
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, window, cx| {
                    entity.update(cx, |this, cx| {
                        this.open_agent_conversation(&comment, window, cx);
                    });
                })
                .into_any_element(),
        )
    }

    fn card(
        &self,
        item: &CommentInfo,
        resolved: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let is_task = item.origin == "task";
        let focus = ReviewFocus::get(cx);
        let lit = focus.prose.contains(&item.id) || focus.cards.contains(&item.id);
        let id = |part: &str| ElementId::Name(format!("{}-{part}-{}", self.id, item.id).into());
        let entity = cx.entity();
        let comment = item.id.clone();

        let v3_item = self.v3.as_ref().and_then(|st| st.snapshot.item(&item.id));
        let target_missing =
            v3_item.is_some_and(|i| i.target_missing && i.place != crate::v3::Place::Gone);
        let can_jump = v3_item
            .map(|i| matches!(i.place, crate::v3::Place::On(_)) && i.target.is_some())
            .unwrap_or(item.target.is_some() && !item.unlocated);

        let mut head = div().flex().flex_row().items_center().gap(px(6.0));
        if let Some(word) = self.origin_word(item) {
            head = head.child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.comment.solid())
                    .child(word),
            );
        }
        head = head.child(div().flex_1());
        if can_jump {
            let (entity, comment) = (entity.clone(), comment.clone());
            let jump_label: SharedString = self.i18n.t(keys::v3_review::JUMP_TO_PLACE).into();
            head = head.child(
                div()
                    .id(id("jump"))
                    .role(gpui::Role::Button)
                    .aria_label(jump_label)
                    .size(px(22.0))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(sand::icon(Icon::ArrowForward, 13.0, p.ink(3).solid()))
                    .on_click(move |_: &ClickEvent, window, cx| {
                        entity.update(cx, |this, cx| this.jump(&comment, window, cx));
                    }),
            );
        }
        let done = item.status == "resolved";
        head = head.child(self.check(item, done, window, cx));

        let mut body = div().flex().flex_col().gap(px(4.0)).child(head);
        if self.write_errors.contains_key(&item.id) {
            body = body.child(
                div()
                    .text_color(p.danger.solid())
                    .child(self.i18n.t(keys::common::SAVE_FAILED).to_owned()),
            );
        }

        let where_label = v3_item.map(|i| self.format_where(i)).unwrap_or_default();
        let quote_text = if item.origin == "marker" {
            None
        } else {
            item.quote
                .as_deref()
                .map(str::trim)
                .filter(|q| !q.is_empty())
        };
        if !where_label.is_empty() || quote_text.is_some() || target_missing {
            let mut q_col = div().pl(px(6.0)).flex().flex_col().gap(px(2.0));
            if !where_label.is_empty() {
                let strike_where = target_missing && quote_text.is_none();
                q_col = q_col.child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(4).solid())
                        .when(strike_where, |d| d.line_through())
                        .child(where_label),
                );
            }
            if let Some(q) = quote_text {
                let short: String = q.chars().take(60).collect();
                q_col = q_col.child(
                    div()
                        .font_role(Role::Prose)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(3).solid())
                        .when(target_missing, |d| d.line_through())
                        .child(short),
                );
            }
            if target_missing {
                q_col = q_col.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(3).solid())
                        .child(sand::icon(Icon::StatusWarning, 12.0, p.ink(3).solid()))
                        .child(self.i18n.t(keys::v3_review::UNLOCATED).to_owned()),
                );
            }
            body = body.child(q_col);
        }

        let pinwheel = self.pinwheel_corner(item, window, cx);
        let has_pinwheel = pinwheel.is_some();

        match &self.editing {
            Some((editing, field, _)) if *editing == item.id => {
                let (save, cancel) = (entity.clone(), entity.clone());
                let (c1, c2) = (comment.clone(), comment.clone());
                let f = field.clone();
                let slip = div()
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(px(radius::SM))
                    .bg(p.page.solid())
                    .border_1()
                    .border_color(p.hairline())
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(1).solid())
                    .child(field.clone());
                body = body.child(slip).child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap(px(8.0))
                        .child(
                            Button::new(id("cancel"), self.i18n.t(keys::common::CANCEL).to_owned())
                                .text()
                                .small()
                                .disabled(self.writing.contains(&item.id))
                                .on_click(move |_, _, cx| {
                                    cancel.update(cx, |this, cx| this.finish_edit(&c1, None, cx));
                                }),
                        )
                        .child(
                            Button::new(id("save"), self.i18n.t(keys::common::SAVE).to_owned())
                                .primary()
                                .small()
                                .disabled(self.writing.contains(&item.id))
                                .on_click(move |_, _, cx| {
                                    let text = f.read(cx).text();
                                    save.update(cx, |this, cx| {
                                        this.finish_edit(&c2, Some(text), cx)
                                    });
                                }),
                        ),
                );
            }
            _ => {
                let text: SharedString = if item.body.text.trim().is_empty() {
                    self.i18n.t(keys::comment_rail::card::EMPTY_COMMENT).into()
                } else {
                    item.body.text.clone().into()
                };
                let (entity, comment) = (entity.clone(), comment.clone());
                body = body.child(
                    div()
                        .id(id("body"))
                        .role(gpui::Role::Label)
                        .aria_label(text.clone())
                        .when(has_pinwheel, |d| d.pr(px(22.0)))
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(text)
                        .when(!is_task, |d| {
                            d.on_click(move |e: &ClickEvent, window, cx| {
                                if e.click_count() >= 2 {
                                    entity.update(cx, |this, cx| this.edit(&comment, window, cx));
                                }
                            })
                        }),
                );
            }
        }

        let source_card = self.build_source_card_closure(item, done, is_task, entity.clone());
        let hold_open = self.is_holding_hover_card(&item.id, window, cx);
        let force_closed = self
            .agent_flyout
            .as_ref()
            .is_some_and(|f| f.comment_id == item.id && f.force_closed);

        let pointed = comment.clone();
        let bounds_cid = comment.clone();
        let bounds_view = entity.downgrade();
        let card = div()
            .id(id("wrap"))
            .debug_selector(|| format!("{}-comment-{}", self.id, item.id))
            .relative()
            .w_full()
            .child(
                canvas(
                    move |b, _, cx| {
                        if let Some(v) = bounds_view.upgrade() {
                            v.read(cx)
                                .card_bounds
                                .borrow_mut()
                                .insert(bounds_cid.clone(), b);
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .on_hover(move |hovered, _, cx| {
                let ids = if *hovered {
                    vec![pointed.clone()]
                } else {
                    Vec::new()
                };
                ReviewFocus::point_cards(ids, cx);
            })
            .child(
                glass::glass_box(
                    id("card"),
                    Kind::Surface,
                    Mode::default(),
                    lit,
                    Spec::new(Tone::Clear, radius::MD),
                    window,
                    cx,
                )
                .relative()
                .w_full()
                .p(px(10.0))
                .when(resolved, |d| d.opacity(0.55))
                .child(body)
                .children(pinwheel),
            )
            .when_some(
                self.reveal
                    .as_ref()
                    .filter(|request| request.ready && request.id == item.id),
                |card, request| self.attach_reveal_probe(card, request, cx),
            );
        let editing = self.editing.as_ref().is_some_and(|(e, _, _)| *e == item.id);
        if editing {
            return card.into_any_element();
        }
        let hc = HoverCard::new(id("source"), card, source_card)
            .beside()
            .keep_open(hold_open);
        let hc = if force_closed {
            hc.force_open(false)
        } else {
            hc
        };
        hc.into_any_element()
    }

    fn task_row(
        &self,
        item: &CommentInfo,
        resolved: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let focus = ReviewFocus::get(cx);
        let lit = focus.prose.contains(&item.id) || focus.cards.contains(&item.id);
        let id =
            |part: &str| ElementId::Name(format!("{}-task-{part}-{}", self.id, item.id).into());
        let entity = cx.entity();
        let comment = item.id.clone();
        let done = item.status == "resolved";
        let v3_item = self.v3.as_ref().and_then(|st| st.snapshot.item(&item.id));
        let can_jump = v3_item
            .map(|i| matches!(i.place, crate::v3::Place::On(_)) && i.target.is_some())
            .unwrap_or(item.target.is_some() && !item.unlocated);

        let text: SharedString = if item.body.text.trim().is_empty() {
            self.i18n.t(keys::comment_rail::card::EMPTY_COMMENT).into()
        } else {
            item.body.text.clone().into()
        };
        let pinwheel = self.pinwheel_corner(item, window, cx);

        let mut row_inner = div()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(8.0))
            .w_full()
            .child(div().pt(px(1.0)).child(self.check(item, done, window, cx)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(if done { p.ink(3) } else { p.ink(1) }.solid())
                    .when(done, |d| d.line_through())
                    .child(text),
            );
        if can_jump {
            let (entity, comment) = (entity.clone(), comment.clone());
            let jump_label: SharedString = self.i18n.t(keys::v3_review::JUMP_TO_PLACE).into();
            row_inner = row_inner.child(
                div()
                    .id(id("jump"))
                    .role(gpui::Role::Button)
                    .aria_label(jump_label)
                    .size(px(22.0))
                    .flex_none()
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(sand::icon(Icon::ArrowForward, 13.0, p.ink(3).solid()))
                    .on_click(move |_: &ClickEvent, window, cx| {
                        entity.update(cx, |this, cx| this.jump(&comment, window, cx));
                    }),
            );
        }

        let source_card = self.build_source_card_closure(item, done, true, entity.clone());
        let hold_open = self.is_holding_hover_card(&item.id, window, cx);
        let force_closed = self
            .agent_flyout
            .as_ref()
            .is_some_and(|f| f.comment_id == item.id && f.force_closed);

        let pointed = comment.clone();
        let bounds_cid = comment;
        let bounds_view = entity.downgrade();
        let row = div()
            .id(id("wrap"))
            .debug_selector(|| format!("{}-comment-{}", self.id, item.id))
            .relative()
            .w_full()
            .child(
                canvas(
                    move |b, _, cx| {
                        if let Some(v) = bounds_view.upgrade() {
                            v.read(cx)
                                .card_bounds
                                .borrow_mut()
                                .insert(bounds_cid.clone(), b);
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .on_hover(move |hovered, _, cx| {
                let ids = if *hovered {
                    vec![pointed.clone()]
                } else {
                    Vec::new()
                };
                ReviewFocus::point_cards(ids, cx);
            })
            .child(
                glass::glass_box(
                    id("row"),
                    Kind::Hidden,
                    Mode::default(),
                    lit,
                    Spec::new(Tone::Clear, radius::SM),
                    window,
                    cx,
                )
                .relative()
                .w_full()
                .px(px(6.0))
                .py(px(5.0))
                .when(resolved, |d| d.opacity(0.6))
                .child(row_inner)
                .children(pinwheel),
            )
            .when_some(
                self.reveal
                    .as_ref()
                    .filter(|request| request.ready && request.id == item.id),
                |el, request| self.attach_reveal_probe(el, request, cx),
            );
        let hc = HoverCard::new(id("source"), row, source_card)
            .beside()
            .keep_open(hold_open);
        let hc = if force_closed {
            hc.force_open(false)
        } else {
            hc
        };
        hc.into_any_element()
    }

    fn attach_reveal_probe(
        &self,
        card: gpui::Stateful<gpui::Div>,
        request: &Reveal,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let serial = request.serial;
        let book = self.book.clone();
        let view = cx.weak_entity();
        card.child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    let mask = window.content_mask().bounds;
                    let visible = bounds.intersect(&mask);
                    if !visible.is_empty()
                        && bounds.top() >= mask.top() - px(1.0)
                        && visible.size.width >= bounds.size.width - px(1.0)
                        && visible.size.height >= bounds.size.height.min(mask.size.height) - px(1.0)
                    {
                        window.defer(cx, move |_, cx| {
                            view.update(cx, |view, _| {
                                if view.book == book
                                    && view.reveal.as_ref().is_some_and(|request| {
                                        request.ready
                                            && request.serial == serial
                                            && !request.reply.is_canceled()
                                    })
                                    && let Some(request) = view.reveal.take()
                                {
                                    let _ = request.reply.send(true);
                                }
                            })
                            .ok();
                        });
                    }
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }

    fn build_source_card_closure(
        &self,
        item: &CommentInfo,
        done: bool,
        is_task: bool,
        entity: Entity<Self>,
    ) -> impl Fn(&mut Window, &mut gpui::App) -> AnyElement + 'static {
        let card_id = format!("{}-src-{}", self.id, item.id);
        let card_comment = item.id.clone();
        let card_quote = item.quote.clone();
        let is_marker = item.origin == "marker";
        let has_conversation = item.agent_conversation.is_some();
        let readonly = self.writing.contains(&item.id);
        move |window: &mut Window, cx: &mut gpui::App| {
            let (view, id) = (entity.clone(), card_comment.clone());
            window.defer(cx, move |_, cx| {
                view.update(cx, |v, cx| {
                    if let Some(f) = &mut v.agent_flyout
                        && f.comment_id == id
                        && f.force_closed
                    {
                        f.force_closed = false;
                    }
                    if !is_marker {
                        v.want_original(&id, cx);
                    }
                });
            });
            let (source, labels, original, review_bounds, sub_state) = {
                let rv = entity.read(cx);
                let source = rv.source_of_id(&card_comment, card_quote.as_deref());
                let labels = Labels {
                    edit: rv.i18n.t(keys::common::EDIT).to_owned().into(),
                    status: rv
                        .i18n
                        .t(if done {
                            keys::comment_rail::actions::REOPEN
                        } else {
                            keys::comment_rail::actions::RESOLVE
                        })
                        .to_owned()
                        .into(),
                    hand_to_agent: rv.i18n.t(keys::v3_review::HAND_TO_AGENT).to_owned().into(),
                    open_conversation: rv
                        .i18n
                        .t(keys::v3_review::OPEN_CONVERSATION)
                        .to_owned()
                        .into(),
                    delete: rv.i18n.t(keys::common::DELETE).to_owned().into(),
                    changed: rv
                        .i18n
                        .t(keys::comment_rail::snapshot::CHANGED)
                        .to_owned()
                        .into(),
                };
                let original = (!is_marker)
                    .then(|| rv.original_of(&card_comment).cloned())
                    .flatten();
                let review_bounds = rv.card_bounds.borrow().get(&card_comment).copied();
                let sub_state = rv
                    .agent_flyout
                    .as_ref()
                    .filter(|f| f.comment_id == card_comment && !f.force_closed)
                    .map(|f| {
                        (
                            f.field.clone(),
                            f.hop_started,
                            f.card_bounds,
                            f.row_bounds,
                            f.review_bounds.or(review_bounds),
                            f.over_row
                                || f.over_box
                                || f.field.read(cx).focus_handle(cx).is_focused(window),
                        )
                    });
                (source, labels, original, review_bounds, sub_state)
            };
            source_card(
                &card_id,
                &source,
                original.as_ref(),
                &labels,
                entity.clone(),
                card_comment.clone(),
                is_task,
                done,
                has_conversation,
                readonly,
                review_bounds,
                sub_state,
                window,
                cx,
            )
        }
    }

    /// Round `.ring` completion circle (`20px`): hover shows a faint check;
    /// click animates the stroke left-to-right over `0.38s`.
    fn check(
        &self,
        item: &CommentInfo,
        done: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let now = anim::now();
        let (drawn, animating) = match self.checks.get(&item.id) {
            Some(t) => {
                let moving = !t.settled(now);
                anim::keep_going(moving, window);
                let v = if theme.reduce_motion {
                    if done { 1.0 } else { 0.0 }
                } else {
                    t.value(now)
                };
                (v, moving)
            }
            None => (if done { 1.0 } else { 0.0 }, false),
        };
        let hovered = self.hovered_check.as_deref() == Some(item.id.as_str());
        let preview_hover = !done && !animating && hovered;
        let clip_ratio = if preview_hover { 1.0 } else { drawn };
        let icon_color = if preview_hover {
            p.ink(2).alpha(0.5)
        } else {
            p.ink(1).solid()
        };
        let size = 20.0;
        let entity = cx.entity();
        let hover_entity = entity.clone();
        let comment = item.id.clone();
        let hover_comment = comment.clone();
        let label_key = if done {
            keys::comment_rail::actions::REOPEN
        } else {
            keys::comment_rail::actions::RESOLVE
        };
        let aria: SharedString = self.i18n.t(label_key).into();
        div()
            .id(ElementId::Name(
                format!("{}-check-wrap-{}", self.id, item.id).into(),
            ))
            .flex_none()
            .on_hover(move |on, _, cx| {
                hover_entity.update(cx, |this, cx| {
                    if *on {
                        this.hovered_check = Some(hover_comment.clone());
                    } else if this.hovered_check.as_deref() == Some(hover_comment.as_str()) {
                        this.hovered_check = None;
                    }
                    cx.notify();
                });
            })
            .child(
                glass::glass_box(
                    ElementId::Name(format!("{}-check-{}", self.id, item.id).into()),
                    Kind::Rest,
                    Mode::default(),
                    done,
                    Spec::new(Tone::Clear, size / 2.0),
                    window,
                    cx,
                )
                .role(gpui::Role::Button)
                .aria_label(aria)
                .size(px(size))
                .flex_none()
                .rounded_full()
                .when(!self.writing.contains(&item.id), |d| d.cursor_pointer())
                .child(
                    div()
                        .absolute()
                        .top(px(3.0))
                        .left(px(3.0))
                        .h(px(size - 6.0))
                        .w(px((size - 6.0) * clip_ratio))
                        .overflow_hidden()
                        .child(sand::icon(Icon::Check, size - 6.0, icon_color)),
                )
                .on_click(move |_, _, cx| {
                    entity.update(cx, |this, cx| this.set_done(&comment, !done, cx));
                }),
            )
            .into_any_element()
    }
}

impl Render for ReviewView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self
            .reveal
            .as_ref()
            .is_some_and(|request| request.reply.is_canceled())
        {
            self.reveal = None;
        }
        let now = anim::now();
        self.checks.retain(|_, t| !t.settled(now));

        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let listing = self.listing();
        let open_count: usize = listing.open.iter().map(|g| g.items.len()).sum();
        let resolved_count = listing.resolved_count;
        let entity = cx.entity();

        let status_options = [
            format!("{} {open_count}", self.i18n.t(keys::v3_review::STATUS_OPEN)),
            format!(
                "{} {resolved_count}",
                self.i18n.t(keys::v3_review::STATUS_RESOLVED)
            ),
            self.i18n.t(keys::review_panel::filters::ALL).to_owned(),
        ];
        let status_seg = {
            let entity = entity.clone();
            Segmented::new(
                ElementId::Name(format!("{}-status-filter", self.id).into()),
                status_options,
                self.status_filter.index(),
            )
            .pad_x(7.0)
            .on_change(move |ix, _, cx| {
                entity.update(cx, |this, cx| {
                    this.set_status_filter(StatusFilter::ALL[ix], cx)
                });
            })
        };
        let scope = {
            let entity = entity.clone();
            ScopeToggle::new(
                ElementId::Name(format!("{}-scope", self.id).into()),
                self.i18n.t(keys::review_panel::scopes::CURRENT).to_owned(),
                self.current_only,
            )
            .disabled(match &self.v3 {
                Some(state) => state.scope.is_none(),
                None => true,
            })
            .on_change(move |on, _, cx| {
                entity.update(cx, |this, cx| this.set_current_only(on, cx));
            })
        };
        let origin_options = [
            self.i18n.t(keys::review_panel::filters::ALL).to_owned(),
            self.i18n.t(keys::v3_review::ORIGIN_MANUAL).to_owned(),
            self.i18n.t(keys::v3_review::ORIGIN_MARKER).to_owned(),
            self.i18n.t(keys::v3_review::ORIGIN_TASK).to_owned(),
            self.i18n.t(keys::v3_review::ORIGIN_AGENT).to_owned(),
            self.i18n.t(keys::v3_review::ORIGIN_READER).to_owned(),
        ];
        let origin_seg = {
            let entity = entity.clone();
            Segmented::new(
                ElementId::Name(format!("{}-origin-filter", self.id).into()),
                origin_options,
                self.origin_filter.index(),
            )
            .pad_x(5.5)
            .text_size(13.5)
            .on_change(move |ix, _, cx| {
                entity.update(cx, |this, cx| {
                    this.set_origin_filter(OriginFilter::ALL[ix], cx)
                });
            })
        };
        let toolbar = div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .px(px(12.0))
            .py(px(8.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .child(status_seg)
                    .child(scope),
            )
            .child(
                div()
                    .id(ElementId::Name(format!("{}-origin-scroll", self.id).into()))
                    .w_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .overflow_x_scroll()
                    .child(origin_seg),
            );

        let visible_groups: Vec<Group> = match self.status_filter {
            StatusFilter::Open => {
                if self.checks.is_empty() || theme.reduce_motion {
                    listing.open.clone()
                } else {
                    merge_groups_with_animating(&listing.open, &listing.resolved, &self.checks)
                }
            }
            StatusFilter::Resolved => {
                if self.checks.is_empty() || theme.reduce_motion {
                    listing.resolved.clone()
                } else {
                    merge_groups_with_animating(&listing.resolved, &listing.open, &self.checks)
                }
            }
            StatusFilter::All => merge_all_groups(&listing.open, &listing.resolved),
        };

        let mut rows: Vec<AnyElement> = Vec::new();
        let mut reveal_index = None;
        if self.v3.is_some()
            && let Some((editing, _, _)) = &self.editing
            && !visible_groups
                .iter()
                .flat_map(|g| &g.items)
                .any(|item| &item.id == editing)
            && let Some(card) = self.items.iter().find(|item| &item.id == editing).cloned()
        {
            rows.push(
                div()
                    .flex_none()
                    .child(self.card(&card, false, window, cx))
                    .into_any_element(),
            );
        }
        if self.loaded && rows.is_empty() && visible_groups.is_empty() {
            rows.push(
                EmptyState::new(
                    ElementId::Name(format!("{}-empty", self.id).into()),
                    self.i18n.t(keys::review_panel::EMPTY).to_owned(),
                )
                .into_any_element(),
            );
        }

        let fold_tasks = self.origin_filter != OriginFilter::Task;
        for group in &visible_groups {
            let group_key = group.key();
            if !(self.current_only && visible_groups.len() == 1) {
                let (mark, title, _) = self.group_header(group);
                rows.push(
                    div()
                        .flex_none()
                        .pt(px(4.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .when_some(mark, |el, kind| {
                            el.child(KindMark::new(
                                ElementId::Name(format!("{}-gmark-{group_key}", self.id).into()),
                                kind,
                            ))
                        })
                        .child(
                            div()
                                .font_role(Role::Structure)
                                .type_px(s.secondary, s.line_body)
                                .text_color(p.ink(2).solid())
                                .child(title),
                        )
                        .into_any_element(),
                );
            }

            let mut regular = Vec::new();
            let mut tasks = Vec::new();
            for item in &group.items {
                if fold_tasks && item.origin == "task" {
                    tasks.push(item);
                } else {
                    regular.push(item);
                }
            }

            for item in regular {
                if self
                    .reveal
                    .as_ref()
                    .is_some_and(|request| request.ready && request.id == item.id)
                {
                    reveal_index = Some(rows.len());
                }
                let is_resolved = item.status == "resolved";
                let el = if item.origin == "task" {
                    self.task_row(item, is_resolved, window, cx)
                } else {
                    self.card(item, is_resolved, window, cx)
                };
                rows.push(div().flex_none().child(el).into_any_element());
            }

            if !tasks.is_empty() {
                let open = self.expanded_tasks.contains(&group_key);
                let toggle = entity.clone();
                let gk = group_key.clone();
                let fold_label: SharedString = self
                    .i18n
                    .fmt(keys::v3_review::CHECKLIST_FOLD, &[("count", &tasks.len())])
                    .into();
                rows.push(
                    div()
                        .id(ElementId::Name(
                            format!("{}-tasks-{group_key}", self.id).into(),
                        ))
                        .role(gpui::Role::Button)
                        .aria_label(fold_label.clone())
                        .aria_expanded(open)
                        .flex_none()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .py(px(2.0))
                        .cursor_pointer()
                        .child(sand::icon(
                            if open {
                                Icon::ChevronDown
                            } else {
                                Icon::ChevronRight
                            },
                            11.0,
                            p.ink(3).solid(),
                        ))
                        .child(
                            div()
                                .font_role(Role::Index)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(3).solid())
                                .child(fold_label),
                        )
                        .on_click(move |_, _, cx| {
                            toggle.update(cx, |this, cx| this.toggle_task_fold(&gk, cx));
                        })
                        .into_any_element(),
                );
                if open {
                    for item in tasks {
                        if self
                            .reveal
                            .as_ref()
                            .is_some_and(|request| request.ready && request.id == item.id)
                        {
                            reveal_index = Some(rows.len());
                        }
                        let is_resolved = item.status == "resolved";
                        rows.push(
                            div()
                                .flex_none()
                                .pl(px(6.0))
                                .child(self.task_row(item, is_resolved, window, cx))
                                .into_any_element(),
                        );
                    }
                }
            }
        }
        if let Some(index) = reveal_index {
            self.scroll.scroll_to_item(index);
        }
        div().size_full().flex().flex_col().child(toolbar).child(
            div()
                .id(ElementId::Name(format!("{}-list", self.id).into()))
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap(px(10.0))
                .px(px(12.0))
                .pb(px(16.0))
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
                .children(rows),
        )
    }
}

fn merge_all_groups(open: &[Group], resolved: &[Group]) -> Vec<Group> {
    let mut out: Vec<Group> = open.to_vec();
    for g in resolved {
        if let Some(existing) = out.iter_mut().find(|e| e.place == g.place) {
            existing.items.extend(g.items.iter().cloned());
        } else {
            out.push(g.clone());
        }
    }
    out.sort_by_key(|g| match g.place {
        Place::V3(_) => 0,
        Place::Gone => 1,
        Place::Floating => 2,
    });
    out
}

fn merge_groups_with_animating(
    primary: &[Group],
    other: &[Group],
    checks: &HashMap<String, Tween>,
) -> Vec<Group> {
    let mut out: Vec<Group> = primary.to_vec();
    for g in other {
        let moving: Vec<CommentInfo> = g
            .items
            .iter()
            .filter(|i| checks.contains_key(&i.id))
            .cloned()
            .collect();
        if moving.is_empty() {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|e| e.place == g.place) {
            for item in moving {
                if !existing.items.iter().any(|x| x.id == item.id) {
                    existing.items.push(item);
                }
            }
        } else {
            out.push(Group {
                place: g.place.clone(),
                items: moving,
            });
        }
    }
    out
}

/// The time a check stroke takes, for tests.
pub const CHECK_DRAW: Duration = motion::sand::DRAW;

#[derive(Clone)]
struct Source {
    title: SharedString,
    where_label: Option<SharedString>,
    mark: Option<sand::Kind>,
    quote: Option<SharedString>,
}

#[derive(Clone)]
struct Labels {
    edit: SharedString,
    status: SharedString,
    hand_to_agent: SharedString,
    open_conversation: SharedString,
    delete: SharedString,
    changed: SharedString,
}

type SubFlyoutState = (
    Entity<TextArea>,
    Option<Instant>,
    Option<Bounds<Pixels>>,
    Option<Bounds<Pixels>>,
    Option<Bounds<Pixels>>,
    bool,
);

#[allow(clippy::too_many_arguments)]
fn source_card(
    id: &str,
    source: &Source,
    original: Option<&Original>,
    labels: &Labels,
    view: Entity<ReviewView>,
    comment: String,
    is_task: bool,
    done: bool,
    has_conversation: bool,
    readonly: bool,
    review_bounds: Option<Bounds<Pixels>>,
    sub_state: Option<SubFlyoutState>,
    window: &mut Window,
    cx: &mut gpui::App,
) -> AnyElement {
    let rid = |part: &str| ElementId::Name(format!("{id}-{part}").into());
    let mut body = CardBody::new(rid("body"), source.title.clone());
    if let Some(mark) = source.mark {
        body = body.mark(mark, None);
    }
    if let Some(where_label) = &source.where_label {
        body = body.meta(div().child(where_label.clone()));
    }
    match (original, &source.quote) {
        (Some(original), _) => {
            let note = (original.changed == Some(true)).then(|| labels.changed.clone());
            body = body.quote(original.text.clone(), note);
        }
        (None, Some(quote)) => body = body.quote(quote.clone(), None),
        _ => {}
    }
    if readonly {
        return body.into_any_element();
    }

    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;

    if !is_task {
        let (v1, c1) = (view.clone(), comment.clone());
        body = body.section(vec![
            CardAction::new(rid("edit"), Icon::Edit, labels.edit.clone())
                .on_click(move |_, window, cx| v1.update(cx, |v, cx| v.edit(&c1, window, cx)))
                .into_any_element(),
        ]);
    }

    let (v2, c2) = (view.clone(), comment.clone());
    let hop_started = sub_state.as_ref().and_then(|st| st.1);
    let hand_active = sub_state.as_ref().is_some_and(|st| st.5);
    let note_field = sub_state.as_ref().map(|st| st.0.clone());

    let (v_hover, c_hover) = (view.clone(), comment.clone());
    let (v_click, c_click, f_click) = (view.clone(), comment.clone(), note_field.clone());
    let row_probe_view = view.downgrade();
    let row_probe_cid = comment.clone();

    let hand_row = div()
        .id(rid("hand-agent-wrap"))
        .w_full()
        .on_hover(move |on, window, cx| {
            if *on {
                v_hover.update(cx, |rv, cx| {
                    rv.enter_agent_row(&c_hover, review_bounds, window, cx);
                });
            } else {
                v_hover.update(cx, |rv, cx| {
                    rv.leave_agent_part(&c_hover, false, cx);
                });
            }
        })
        .child(
            glass::glass_box(
                rid("hand-agent"),
                Kind::Hidden,
                Mode::default(),
                hand_active,
                Spec::new(Tone::Clear, radius::MENU_ROW).rim(3.0),
                window,
                cx,
            )
            .relative()
            .mx(px(menu_tokens::HOVER_CARD_PAD - 8.0))
            .px(px(8.0))
            .py(px(4.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .rounded(px(radius::MENU_ROW))
            .font_role(Role::Index)
            .type_px(s.secondary, s.line_body)
            .text_color(if hand_active { p.ink(1) } else { p.ink(2) }.solid())
            .cursor_pointer()
            .role(gpui::Role::MenuItem)
            .aria_label(labels.hand_to_agent.clone())
            .child(
                canvas(
                    move |b, _, cx| {
                        if let Some(v) = row_probe_view.upgrade() {
                            v.update(cx, |rv, _| {
                                if let Some(f) = &mut rv.agent_flyout
                                    && f.comment_id == row_probe_cid
                                {
                                    f.row_bounds = Some(b);
                                }
                            });
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .child(sand::shikigami_hop_icon(
                menu_tokens::ICON,
                if hand_active { p.ink(1) } else { p.ink(2) }.solid(),
                hop_started,
                theme.reduce_motion,
                window,
            ))
            .child(div().flex_1().min_w_0().child(labels.hand_to_agent.clone()))
            .child(sand::icon(Icon::ChevronRight, 12.0, p.ink(3).solid()))
            .on_click(move |_, _, cx| {
                let extra = f_click
                    .as_ref()
                    .map(|f| f.read(cx).text())
                    .unwrap_or_default();
                v_click.update(cx, |rv, cx| rv.hand_to_agent(&c_click, extra, cx));
            }),
        )
        .into_any_element();

    let mut middle_rows = vec![
        CardAction::new(
            rid("status"),
            if done { Icon::Rotate } else { Icon::Check },
            labels.status.clone(),
        )
        .on_click(move |_, _, cx| v2.update(cx, |v, cx| v.set_done(&c2, !done, cx)))
        .into_any_element(),
        hand_row,
    ];
    if has_conversation {
        let (v_open, c_open) = (view.clone(), comment.clone());
        middle_rows.push(
            CardAction::new(
                rid("open-conversation"),
                Icon::ArrowOut,
                labels.open_conversation.clone(),
            )
            .on_click(move |_, window, cx| {
                v_open.update(cx, |v, cx| v.open_agent_conversation(&c_open, window, cx))
            })
            .into_any_element(),
        );
    }
    body = body.section(middle_rows);

    if !is_task {
        let (v4, c4) = (view.clone(), comment.clone());
        body = body.section(vec![
            CardAction::new(rid("delete"), Icon::Trash, labels.delete.clone())
                .danger()
                .on_click(move |_, _, cx| v4.update(cx, |v, cx| v.delete(&c4, cx)))
                .into_any_element(),
        ]);
    }

    let card_probe_view = view.downgrade();
    let card_probe_cid = comment.clone();
    let sub_overlay = sub_state.and_then(|(field, _, card_b, row_b, rev_b, show_box)| {
        if !show_box {
            return None;
        }
        let anchor_card = card_b.or(row_b)?;
        let row_top = row_b
            .map(|r| f32::from(r.top()))
            .unwrap_or(f32::from(anchor_card.top()));
        let sub_w = menu_tokens::HOVER_CARD_WIDTH;
        let gap = menu_tokens::HOVER_CARD_GAP;
        let ww = f32::from(window.viewport_size().width);
        let card_left = f32::from(anchor_card.left());
        let card_right = f32::from(anchor_card.right());
        let opened_left = rev_b
            .map(|rb| card_left < f32::from(rb.left()))
            .unwrap_or(card_right + gap + sub_w > ww - overlay::MARGIN);
        let x = if opened_left {
            if card_left - gap - sub_w >= overlay::MARGIN {
                card_left - gap - sub_w
            } else {
                card_right + gap
            }
        } else if card_right + gap + sub_w <= ww - overlay::MARGIN {
            card_right + gap
        } else {
            card_left - gap - sub_w
        };
        let y = (row_top - 10.0).max(overlay::MARGIN);
        let (v_box, c_box) = (view.clone(), comment.clone());
        Some(
            overlay::float(
                OverlayPlace::Point(point(px(x), px(y))),
                Layer::Popover,
                glass::surface(
                    Ground::flat(p.desk),
                    div()
                        .id(rid("agent-sub-box"))
                        .relative()
                        .w(px(sub_w))
                        .rounded(px(radius::SHEET))
                        .shadow(float_shadow(p))
                        .occlude()
                        .child(slab_edge(p, radius::SHEET))
                        .on_hover(move |on, _, cx| {
                            v_box.update(cx, |rv, cx| {
                                if *on {
                                    if let Some(f) = &mut rv.agent_flyout
                                        && f.comment_id == c_box
                                    {
                                        f.over_box = true;
                                        f.grace = None;
                                    }
                                    cx.notify();
                                } else {
                                    rv.leave_agent_part(&c_box, true, cx);
                                }
                            });
                        })
                        .child(
                            div().relative().p(px(12.0)).child(
                                div()
                                    .px(px(8.0))
                                    .py(px(6.0))
                                    .min_h(px(64.0))
                                    .rounded(px(radius::MD))
                                    .bg(p.page.solid())
                                    .border_1()
                                    .border_color(p.hairline())
                                    .font_role(Role::Ui)
                                    .type_px(s.secondary, s.line_body)
                                    .text_color(p.ink(1).solid())
                                    .child(field),
                            ),
                        ),
                ),
            )
            .into_any_element(),
        )
    });

    div()
        .relative()
        .child(
            canvas(
                move |b, _, cx| {
                    if let Some(v) = card_probe_view.upgrade() {
                        v.update(cx, |rv, _| {
                            if let Some(f) = &mut rv.agent_flyout
                                && f.comment_id == card_probe_cid
                            {
                                f.card_bounds = Some(b);
                            }
                        });
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
        .child(body)
        .children(sub_overlay)
        .into_any_element()
}

#[cfg(test)]
mod reveal_tests {
    use super::*;
    use dr_testkit::seed::{self, Preset};
    use gpui::{TestAppContext, VisualTestContext, size};
    use serde_json::json;

    fn wait(cx: &mut TestAppContext, view: &Entity<ReviewView>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.executor().advance_clock(Duration::from_millis(20));
            cx.run_until_parked();
            if view.read_with(cx, |view, _| {
                view.pending.is_none() && view.reveal.is_none()
            }) {
                return;
            }
            assert!(Instant::now() < deadline, "comment reveal did not load");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn visible(view: &ReviewView, id: &str) -> bool {
        let listing = view.listing();
        let groups: Vec<Group> = match view.status_filter {
            StatusFilter::Open => listing.open,
            StatusFilter::Resolved => listing.resolved,
            StatusFilter::All => merge_all_groups(&listing.open, &listing.resolved),
        };
        for g in &groups {
            let gk = g.key();
            for item in &g.items {
                if item.id == id {
                    if item.origin == "task" && view.origin_filter != OriginFilter::Task {
                        return view.expanded_tasks.contains(&gk);
                    }
                    return true;
                }
            }
        }
        false
    }

    struct Frame(Entity<ReviewView>, bool);

    impl Render for Frame {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .size_full()
                .when(self.1, |frame| frame.child(self.0.clone()))
        }
    }

    fn draw(cx: &mut VisualTestContext) {
        cx.executor().advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        cx.run_until_parked();
    }

    fn painted(cx: &mut VisualTestContext, view: &Entity<ReviewView>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            draw(cx);
            if view.read_with(cx, |view, _| {
                view.pending.is_none() && view.reveal.is_none()
            }) {
                return;
            }
            assert!(Instant::now() < deadline, "target card was not painted");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[gpui::test]
    fn reveal_relaxes_only_filters_hiding_the_target_and_expands_resolved(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let directory = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(directory.path(), "m31-review-reveal-test").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let body = seeded.books[0]
            .groups()
            .values()
            .flatten()
            .next()
            .unwrap()
            .clone();
        seeded.write_to(ws.library()).unwrap();
        let chapters = ws
            .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
            .unwrap();
        let chapter = chapters["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["template"] == "tpl-chapter")
            .unwrap()["id"]
            .as_str()
            .unwrap();
        let located = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({
                    "book":book,"body":body,"target":{"kind":"entry","id":chapter}
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let floating = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({
                    "book":book,"body":body
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let resolved = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({
                    "book":book,"body":body,"target":{"kind":"entry","id":chapter}
                }),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        ws.call(
            &Actor::User,
            "comment.update",
            json!({"book":book,"id":resolved,"status":"resolved"}),
        )
        .unwrap();
        cx.update(|cx| crate::init(Some(ws.clone()), cx));
        // The first request arrives before the pane exists in a window.
        let mut first = cx
            .update(|cx| crate::reveal_comment("reveal", &book, &located, cx))
            .unwrap();
        let view = cx.update(|cx| crate::view("reveal", cx)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !view.read_with(cx, |view, _| {
            view.reveal.as_ref().is_some_and(|request| request.ready)
        }) {
            cx.run_until_parked();
            assert!(
                Instant::now() < deadline,
                "reveal did not load before mounting"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            first.try_recv().unwrap(),
            None,
            "loading an unmounted pane must not acknowledge navigation"
        );
        let shown = view.clone();
        let (_, cx) = cx.add_window_view(move |_, _| Frame(shown, true));
        cx.simulate_resize(size(px(360.0), px(280.0)));
        painted(cx, &view);
        assert_eq!(first.try_recv().unwrap(), Some(true));
        for (index, id) in [&located, &floating, &resolved].into_iter().enumerate() {
            view.update(cx, |view, cx| {
                view.v3.as_mut().unwrap().scope = Some(crate::v3::Target::Entry {
                    id: chapter.into(),
                    module: None,
                });
                view.set_origin_filter(
                    if index == 0 {
                        OriginFilter::Agent
                    } else {
                        OriginFilter::Manual
                    },
                    cx,
                );
                view.set_current_only(true, cx);
                view.set_status_filter(StatusFilter::Open, cx);
            });
            assert!(
                !view.read_with(cx, |view, _| visible(view, id)),
                "precondition {index}"
            );
            let mut ack = cx
                .update(|_, cx| crate::reveal_comment("reveal", &book, id, cx))
                .unwrap();
            painted(cx, &view);
            assert_eq!(ack.try_recv().unwrap(), Some(true));
            view.read_with(cx, |view, _| {
                assert!(visible(view, id), "target {index} remains hidden");
                assert_eq!(
                    view.origin_filter,
                    if index == 0 {
                        OriginFilter::All
                    } else {
                        OriginFilter::Manual
                    }
                );
                assert_eq!(view.current_only, index != 1);
                assert_eq!(
                    view.status_filter,
                    if index == 2 {
                        StatusFilter::All
                    } else {
                        StatusFilter::Open
                    }
                );
            });
        }
        let other_book = dr_model::id::BookId::new_v7().to_string();
        let mut switched = cx
            .update(|_, cx| crate::reveal_comment("reveal", &other_book, &floating, cx))
            .unwrap();
        assert!(
            view.read_with(cx, |view, _| view
                .v3
                .as_ref()
                .unwrap()
                .snapshot
                .items
                .is_empty()),
            "reveal book switch clears the old comments immediately"
        );
        painted(cx, &view);
        assert_eq!(switched.try_recv().unwrap(), Some(false));
        cx.update(|_, cx| crate::release(cx));
        ws.close();
    }

    #[gpui::test]
    fn reveal_scrolls_long_floating_and_folded_resolved_cards_before_ack(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let directory = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(directory.path(), "m31-review-scroll-test").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let body: String = seeded.books[0]
            .groups()
            .values()
            .flatten()
            .next()
            .unwrap()
            .chars()
            .take(48)
            .collect();
        seeded.write_to(ws.library()).unwrap();
        let chapters = ws
            .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
            .unwrap();
        let chapter = chapters["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["template"] == "tpl-chapter")
            .unwrap()["id"]
            .as_str()
            .unwrap();
        let mut located = String::new();
        for _ in 0..48 {
            located = ws
                .call(
                    &Actor::User,
                    "comment.create",
                    json!({
                        "book":book,"body":body,"target":{"kind":"entry","id":chapter}
                    }),
                )
                .unwrap()["output"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
        }
        let floating = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({"book":book,"body":body}),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let resolved = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({"book":book,"body":body}),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        ws.call(
            &Actor::User,
            "comment.update",
            json!({"book":book,"id":resolved,"status":"resolved"}),
        )
        .unwrap();
        cx.update(|cx| crate::init(Some(ws.clone()), cx));
        let mut first = cx
            .update(|cx| crate::reveal_comment("long", &book, &located, cx))
            .unwrap();
        let view = cx.update(|cx| crate::view("long", cx)).unwrap();
        let shown = view.clone();
        let (frame, cx) = cx.add_window_view(move |_, _| Frame(shown, true));
        cx.simulate_resize(size(px(360.0), px(320.0)));
        painted(cx, &view);
        assert_eq!(first.try_recv().unwrap(), Some(true));
        for id in [&floating, &resolved] {
            view.update(cx, |view, cx| {
                view.status_filter = StatusFilter::Open;
                view.scroll.scroll_to_item(0);
                cx.notify();
            });
            draw(cx);
            let selector = Box::leak(format!("long-comment-{id}").into_boxed_str());
            let viewport = view.read_with(cx, |view, _| view.scroll.bounds());
            assert!(view.read_with(cx, |view, _| view.scroll.max_offset().y) > px(1000.0));
            assert!(
                cx.debug_bounds(selector)
                    .is_none_or(|bounds| bounds.intersect(&viewport).is_empty()),
                "the target must begin outside the painted viewport"
            );
            let mut ack = cx
                .update(|_, cx| crate::reveal_comment("long", &book, id, cx))
                .unwrap();
            assert_eq!(
                ack.try_recv().unwrap(),
                None,
                "queuing a reveal must not complete navigation"
            );
            painted(cx, &view);
            assert_eq!(ack.try_recv().unwrap(), Some(true));
            let bounds = cx.debug_bounds(selector).expect("target card painted");
            let viewport = view.read_with(cx, |view, _| view.scroll.bounds());
            assert!(bounds.top() >= viewport.top() - px(1.0));
            assert!(bounds.bottom() <= viewport.bottom() + px(1.0));
            assert!(view.read_with(cx, |view, _| view.scroll.offset().y) < -px(100.0));
        }
        // A retained Review view is hidden while the caller drops its ACK.
        // Cancellation before load must not relax filters.
        view.update(cx, |view, cx| {
            view.status_filter = StatusFilter::Open;
            view.scroll.scroll_to_item(0);
            cx.notify();
        });
        draw(cx);
        let before = view.read_with(cx, |view, _| view.scroll.offset());
        frame.update(cx, |frame, cx| {
            frame.1 = false;
            cx.notify();
        });
        draw(cx);
        cx.update(|_, cx| {
            drop(crate::reveal_comment("long", &book, &resolved, cx));
        });
        painted(cx, &view);
        assert_eq!(
            view.read_with(cx, |view, _| view.status_filter),
            StatusFilter::Open
        );

        // Cancellation after load but before any paint must not replay the
        // old scroll when this retained view is mounted again.
        let canceled = cx
            .update(|_, cx| crate::reveal_comment("long", &book, &floating, cx))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !view.read_with(cx, |view, _| {
            view.reveal.as_ref().is_some_and(|request| request.ready)
        }) {
            draw(cx);
            assert!(Instant::now() < deadline, "hidden reveal did not load");
            std::thread::sleep(Duration::from_millis(2));
        }
        drop(canceled);
        frame.update(cx, |frame, cx| {
            frame.1 = true;
            cx.notify();
        });
        draw(cx);
        assert!(view.read_with(cx, |view, _| view.reveal.is_none()));
        assert_eq!(view.read_with(cx, |view, _| view.scroll.offset()), before);

        // Dropping an older receiver cannot clear a replacement request.
        let mut fresh = cx.update(|_, cx| {
            let old = crate::reveal_comment("long", &book, &resolved, cx).unwrap();
            let fresh = crate::reveal_comment("long", &book, &floating, cx).unwrap();
            drop(old);
            fresh
        });
        painted(cx, &view);
        assert_eq!(fresh.try_recv().unwrap(), Some(true));
        cx.update(|_, cx| crate::release(cx));
        ws.close();
    }

    #[gpui::test]
    fn reveal_ack_rejects_missing_failed_and_superseded_loads(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let directory = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(directory.path(), "m31-review-ack-test").unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let body = seeded.books[0]
            .groups()
            .values()
            .flatten()
            .next()
            .unwrap()
            .clone();
        seeded.write_to(ws.library()).unwrap();
        let comment = ws
            .call(
                &Actor::User,
                "comment.create",
                json!({"book":book,"body":body}),
            )
            .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        cx.update(|cx| crate::init(Some(ws.clone()), cx));
        let (mut first, mut replaced, view) = cx.update(|cx| {
            let first = crate::reveal_comment("ack", &book, &comment, cx).unwrap();
            let view = crate::view("ack", cx).unwrap();
            let replaced = crate::reveal_comment("ack", &book, &comment, cx).unwrap();
            view.update(cx, |view, cx| {
                view.show_v3(
                    "",
                    None,
                    Locale::En,
                    Platform::current(),
                    Rc::new(|_, _, _| {}),
                    Rc::new(|_| None),
                    cx,
                )
            });
            (first, replaced, view)
        });
        assert!(
            first.try_recv().is_err(),
            "replacement closes the previous ACK"
        );
        assert!(
            replaced.try_recv().is_err(),
            "book change closes the pending ACK"
        );

        ws.call(
            &Actor::User,
            "comment.delete",
            json!({"book":book,"id":comment}),
        )
        .unwrap();
        let mut missing = cx
            .update(|cx| crate::reveal_comment("ack", &book, &comment, cx))
            .unwrap();
        wait(cx, &view);
        assert_eq!(missing.try_recv().unwrap(), Some(false));

        let unavailable = dr_model::id::BookId::new_v7().to_string();
        assert!(
            ws.call(&Actor::User, "comment.list", json!({"book":unavailable}))
                .is_err()
        );
        let mut failed = cx
            .update(|cx| crate::reveal_comment("ack", &unavailable, &comment, cx))
            .unwrap();
        wait(cx, &view);
        assert_eq!(
            failed.try_recv().unwrap(),
            Some(false),
            "failed F3 read is not a reveal"
        );

        let mut dropped = cx.update(|cx| {
            let receiver = crate::reveal_comment("drop", &book, &comment, cx).unwrap();
            crate::release(cx);
            receiver
        });
        cx.run_until_parked();
        assert!(
            dropped.try_recv().is_err(),
            "dropping the view closes its ACK"
        );
        ws.close();
    }
}

#[cfg(test)]
mod v3_write_tests {
    use super::*;
    use gpui::{TestAppContext, VisualTestContext};
    use serde_json::json;
    use std::rc::Rc;

    struct Frame(Entity<ReviewView>);
    impl Render for Frame {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(self.0.clone())
        }
    }
    fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.executor().advance_clock(Duration::from_millis(30));
            cx.run_until_parked();
            cx.update(|window, cx| window.draw(cx).clear(cx));
            if done(cx) {
                return;
            }
            assert!(Instant::now() < deadline, "v3 review write timed out");
            std::thread::sleep(Duration::from_millis(3));
        }
    }
    fn call(lib: &Workspace, name: &str, input: serde_json::Value) -> serde_json::Value {
        lib.call(&Actor::User, name, input).unwrap()["output"].clone()
    }

    #[gpui::test]
    fn partial_writes_preserve_other_fields_hidden_comments_and_failed_drafts(
        cx: &mut TestAppContext,
    ) {
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().unwrap();
        let lib = Workspace::open_dir(dir.path(), "v3-review").unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        let source = seed.books[0]
            .book
            .view()
            .comments()
            .into_iter()
            .find(|c| c.target_module.is_some())
            .unwrap();
        let target = source.target.as_ref().unwrap().id.clone();
        let module = source.target_module.as_ref().unwrap().to_string();
        let body = source.body.text.clone();
        seed.write_to(lib.library()).unwrap();
        let a = call(
            &lib,
            "comment.create",
            json!({"book":book,"target":{"kind":"entry","id":target},"module":module,"body":body}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let b = call(
            &lib,
            "comment.create",
            json!({"book":book,"target":{"kind":"entry","id":target},"module":module,"body":body}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let hidden = call(&lib, "comment.create", json!({"book":book,"body":body}))["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let view = cx.new(|_| ReviewView::new("v3-writes".into(), Some(lib.clone())));
        let (_, cx) = cx.add_window_view(|_, _| Frame(view.clone()));
        view.update(cx, |v, cx| {
            v.show_v3(
                &book,
                Some(crate::v3::Target::Entry {
                    id: target,
                    module: Some(module),
                }),
                Locale::En,
                Platform::Mac,
                Rc::new(|_, _, _| {}),
                Rc::new(|_| None),
                cx,
            );
            v.set_current_only(true, cx);
        });
        wait(cx, |cx| view.read_with(cx, |v, _| v.loaded));
        assert!(!view.read_with(cx, |v, _| {
            v.listing()
                .open
                .iter()
                .flat_map(|g| &g.items)
                .any(|i| i.id == hidden)
        }));
        cx.update(|window, cx| view.update(cx, |v, cx| v.edit(&a, window, cx)));
        let field = view.read_with(cx, |v, _| v.editing.as_ref().unwrap().1.clone());
        let draft = format!("{body}\n{body}");
        field.update(cx, |f, cx| f.set_text(&draft, cx));
        call(
            &lib,
            "comment.update",
            json!({"book":book,"id":a,"agent_conversation":"conv-elsewhere"}),
        );
        view.update(cx, |v, cx| v.reload(cx));
        wait(cx, |cx| view.read_with(cx, |v, _| v.pending.is_none()));
        assert_eq!(field.read_with(cx, |f, _| f.text()), draft);
        view.update(cx, |v, cx| {
            v.finish_edit(&a, Some(draft.clone()), cx);
            v.set_done(&b, true, cx);
        });
        wait(cx, |cx| {
            view.read_with(cx, |v, _| v.writing.is_empty() && v.pending.is_none())
        });
        let comments = call(&lib, "comment.list", json!({"book":book}));
        let get = |id: &str| {
            comments
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == id)
                .unwrap()
        };
        assert_eq!(get(&a)["body"]["text"], draft);
        assert_eq!(get(&a)["agent_conversation"], "conv-elsewhere");
        assert_eq!(get(&b)["status"], "resolved");
        assert_eq!(get(&hidden)["body"]["text"], body);
        cx.update(|window, cx| view.update(cx, |v, cx| v.edit(&a, window, cx)));
        let field = view.read_with(cx, |v, _| v.editing.as_ref().unwrap().1.clone());
        let refused = format!("{draft}\n{body}");
        field.update(cx, |f, cx| f.set_text(&refused, cx));
        call(&lib, "comment.delete", json!({"book":book,"id":a}));
        view.update(cx, |v, cx| v.reload(cx));
        wait(cx, |cx| view.read_with(cx, |v, _| v.pending.is_none()));
        assert!(view.read_with(cx, |v, _| v.items.iter().any(|item| item.id == a)));
        view.update(cx, |v, cx| v.finish_edit(&a, Some(refused.clone()), cx));
        wait(cx, |cx| {
            view.read_with(cx, |v, _| v.write_errors.contains_key(&a))
        });
        assert_eq!(field.read_with(cx, |f, _| f.text()), refused);
        assert!(view.read_with(cx, |v, _| v.editing.is_some()));
        lib.close();
    }
}
