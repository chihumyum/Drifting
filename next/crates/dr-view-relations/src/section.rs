//! 「关联」 on an entity's page: the 0.1 client's `ReferencesPanel`
//! relations section (desktop glass).

use std::rc::Rc;

use dr_i18n::keys;
use dr_i18n::keys::edge_kind_manager as ekm;
use dr_i18n::keys::references_panel as rp;
use dr_i18n::keys::relation_types as rt;
use dr_shell::book::Book;
use dr_shell::nav::Open;
use dr_shell::strings::{t, tf};
use dr_shell::{Services, Workspace};
use dr_ui::Theme;
use dr_ui::components::overlay::{self, Align, Layer, Place};
use dr_ui::components::{Button, Menu, MenuItem, MenuWidth, RowIcon, Segmented};
use dr_ui::fonts::Role;
use dr_ui::glass::{self, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon, KindMark};
use dr_ui::style::DrStyled as _;
use dr_ui::tokens::radius;
use dr_workspace::dto::{RelationTypeInfo, Target as End};
use dr_workspace::{Workspace as Library, WsEvent};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, EventEmitter, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::data;
use crate::look::{self, Look};
use crate::model::{self, Candidate, Filter, Row, Words};
use crate::types::{TypeEvent, TypeManager};

/// A card is at least this wide; as many fit side by side as the column
/// holds (0.1: `repeat(auto-fill, minmax(190px, 1fr))`).
const CARD_MIN_W: f32 = 190.0;
const CARD_GAP: f32 = 10.0;

/// The entity being related, chosen in the picker and not made yet.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub end: End,
    /// The other entity → this one.
    pub reversed: bool,
    pub relation_type: Option<String>,
}

/// Whose type the open type menu sets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuFor {
    Pending,
    Row(String),
}

/// What the section tells its host.
#[derive(Clone, Debug)]
pub enum RelationsEvent {
    /// A relation was made or removed (the host may count again).
    Changed,
}

/// One entity's 「关联」.
pub struct Relations {
    ws: gpui::WeakEntity<Workspace>,
    lib: Option<Library>,
    owner: End,
    book: Rc<Book>,
    types: Vec<RelationTypeInfo>,
    rows: Vec<Row>,
    loaded: bool,
    /// The book the lists were read for.
    read_for: String,
    picking: bool,
    filter: Filter,
    query: Entity<TextField>,
    pending: Option<Pending>,
    menu: Option<MenuFor>,
    manager: Option<Entity<TypeManager>>,
    /// The types were opened from the pending pair's 「新建关系类型」.
    for_pending: bool,
    reading: Option<Task<()>>,
    /// F3 said the book changed while it was read: read again after.
    stale: bool,
    /// Writes not back yet.
    writing: usize,
    /// The card grid's width, for how many cards a row holds.
    grid: Entity<Option<Bounds<Pixels>>>,
    _ws: Option<Subscription>,
    _query: Subscription,
    _manager: Option<Subscription>,
    _events: Option<dr_workspace::events::Subscription>,
    _receiver: Option<Task<()>>,
}

impl EventEmitter<RelationsEvent> for Relations {}

impl Relations {
    /// `owner`'s 「关联」 (an F3 target: `element`, `node`, …) in the window
    /// of `ws`, whose book snapshot names the ends.
    pub fn new(
        owner: End,
        ws: gpui::WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Relations {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let query = cx.new(|cx| {
            TextField::new("relations-query", window, cx)
                .icon(Icon::Search)
                .placeholder(t(cx, rp::picker::PLACEHOLDER))
        });
        let _query = cx.subscribe(&query, |r, _, event, cx| match event {
            FieldEvent::Changed(_) => cx.notify(),
            FieldEvent::Cancelled => r.set_picking(false, cx),
            _ => {}
        });
        // The workspace may be the one being updated (it is drawing):
        // follow it once this update is over.
        cx.spawn(async move |this, cx| this.update(cx, |r, cx| r.follow(cx)).ok())
            .detach();
        let grid = cx.new(|_| None);
        let mut r = Relations {
            ws,
            lib,
            owner,
            book: Rc::default(),
            types: Vec::new(),
            rows: Vec::new(),
            loaded: false,
            read_for: String::new(),
            picking: false,
            filter: Filter::All,
            query,
            pending: None,
            menu: None,
            manager: None,
            for_pending: false,
            reading: None,
            stale: false,
            writing: 0,
            grid,
            _ws: None,
            _query,
            _manager: None,
            _events: None,
            _receiver: None,
        };
        r.listen(cx);
        r
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.book = ws.read(cx).book.clone();
        self._ws = Some(cx.observe(&ws, |r, ws, cx| {
            let book = ws.read(cx).book.clone();
            if !Rc::ptr_eq(&book, &r.book) {
                r.book = book;
                if r.book.id != r.read_for {
                    r.reload(cx);
                }
                cx.notify();
            }
        }));
        self.reload(cx);
        cx.notify();
    }

    /// F3's events for the book's relations and types read them again.
    fn listen(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<String>();
        self._events = Some(lib.subscribe(move |event| {
            if let WsEvent::Book(b) = event
                && b.changes.iter().any(|c| {
                    matches!(
                        c.collection,
                        dr_doc::book::Collection::Relations
                            | dr_doc::book::Collection::RelationTypes
                    )
                })
            {
                let _ = tx.unbounded_send(b.book.to_string());
            }
        }));
        self._receiver = Some(cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(book) = rx.next().await {
                let mut books = vec![book];
                while let Ok(b) = rx.try_recv() {
                    books.push(b);
                }
                let go = this.update(cx, |r, cx| {
                    if books.contains(&r.book.id) {
                        r.reload(cx);
                    }
                });
                if go.is_err() {
                    break;
                }
            }
        }));
    }

    /// Reads the book's types and the owner's relations.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (Some(lib), book) = (self.lib.clone(), self.book.id.clone()) else {
            return;
        };
        if book.is_empty() {
            return;
        }
        if self.reading.is_some() {
            self.stale = true;
            return;
        }
        self.stale = false;
        let owner = self.owner.clone();
        let b = book.clone();
        let read = cx.background_spawn(async move { data::load(&lib, &b, Some(&owner)) });
        self.reading = Some(cx.spawn(async move |this, cx| {
            let lists = read.await;
            this.update(cx, |r, cx| {
                r.reading = None;
                match lists {
                    Ok((types, relations)) => {
                        r.types = types;
                        r.rows = model::rows(&r.owner, &relations);
                        r.loaded = true;
                        r.read_for = book;
                        // A chosen type the book no longer has goes.
                        if let Some(p) = &mut r.pending
                            && p.relation_type
                                .as_ref()
                                .is_some_and(|id| !r.types.iter().any(|t| &t.id == id))
                        {
                            p.relation_type = None;
                        }
                    }
                    Err(error) => log::warn!("the relations could not be read: {error}"),
                }
                if r.stale {
                    r.reload(cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    // ── reading, for the host and tests ─────────────────────────────────

    pub fn owner(&self) -> &End {
        &self.owner
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn types(&self) -> &[RelationTypeInfo] {
        &self.types
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// Nothing read or written is still on its way.
    pub fn is_settled(&self) -> bool {
        self.reading.is_none() && self.writing == 0 && !self.stale
    }

    pub fn is_picking(&self) -> bool {
        self.picking
    }

    pub fn pending(&self) -> Option<&Pending> {
        self.pending.as_ref()
    }

    pub fn menu(&self) -> Option<&MenuFor> {
        self.menu.as_ref()
    }

    pub fn query_field(&self) -> Entity<TextField> {
        self.query.clone()
    }

    pub fn manager(&self) -> Option<Entity<TypeManager>> {
        self.manager.clone()
    }

    /// What the picker offers now.
    pub fn candidates(&self, cx: &App) -> Vec<Candidate> {
        let query = self.query.read(cx).text();
        model::candidates(&self.book, &self.owner, &self.rows, self.filter, &query)
    }

    /// The types the open menu offers.
    pub fn menu_options(&self) -> Vec<&RelationTypeInfo> {
        match &self.menu {
            Some(MenuFor::Pending) => self.pending_options(),
            Some(MenuFor::Row(id)) => self
                .rows
                .iter()
                .find(|r| &r.id == id)
                .map(|row| model::options_for_row(&self.types, &self.owner, row))
                .unwrap_or_default(),
            None => Vec::new(),
        }
    }

    fn pending_options(&self) -> Vec<&RelationTypeInfo> {
        match &self.pending {
            Some(p) => model::options_for_pair(&self.types, &self.owner, &p.end, p.reversed),
            None => Vec::new(),
        }
    }

    // ── the author's steps ──────────────────────────────────────────────

    /// 「＋ 关联实体」 / 「取消」.
    pub fn set_picking(&mut self, picking: bool, cx: &mut Context<Self>) {
        self.picking = picking;
        self.menu = None;
        if !picking {
            self.pending = None;
            self.filter = Filter::All;
            self.query.update(cx, |q, cx| q.set_text("", cx));
        }
        cx.notify();
    }

    pub fn set_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    /// A candidate chosen: it waits for its direction and type.
    pub fn choose(&mut self, end: End, cx: &mut Context<Self>) {
        self.pending = Some(Pending {
            end,
            reversed: false,
            relation_type: None,
        });
        self.menu = None;
        cx.notify();
    }

    /// 该实体 → 目标 / 该实体 ← 目标: the type is chosen again.
    pub fn reverse_pending(&mut self, cx: &mut Context<Self>) {
        if let Some(p) = &mut self.pending {
            p.reversed = !p.reversed;
            p.relation_type = None;
        }
        self.menu = None;
        cx.notify();
    }

    pub fn set_pending_type(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(p) = &mut self.pending {
            p.relation_type = Some(id.to_owned());
        }
        self.menu = None;
        cx.notify();
    }

    fn book_and_lib(&self) -> Option<(Library, String)> {
        let lib = self.lib.clone()?;
        (!self.book.id.is_empty()).then(|| (lib, self.book.id.clone()))
    }

    /// Runs `f` off the main thread, then reads the lists again.
    fn write<T: Send + 'static>(
        &mut self,
        what: &'static str,
        f: impl FnOnce(&Library, &str) -> Result<T, dr_workspace::WsError> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some((lib, book)) = self.book_and_lib() else {
            return;
        };
        self.writing += 1;
        let task = cx.background_spawn(async move { f(&lib, &book) });
        cx.spawn(async move |this, cx| {
            let done = task.await;
            this.update(cx, |r, cx| {
                r.writing -= 1;
                if let Err(error) = done {
                    log::warn!("{what} failed: {error}");
                }
                cx.emit(RelationsEvent::Changed);
                r.reload(cx);
            })
            .ok();
        })
        .detach();
    }

    /// 「创建」: the pending relation, made; the picker closes.
    pub fn create(&mut self, cx: &mut Context<Self>) {
        let Some(p) = self.pending.clone() else {
            return;
        };
        let Some(type_id) = p.relation_type.clone() else {
            return;
        };
        let (from, to) = if p.reversed {
            (p.end.clone(), self.owner.clone())
        } else {
            (self.owner.clone(), p.end.clone())
        };
        self.write(
            "making a relation",
            move |lib, book| data::create(lib, book, from, to, &type_id),
            cx,
        );
        self.set_picking(false, cx);
    }

    /// × on a card.
    pub fn remove(&mut self, id: &str, cx: &mut Context<Self>) {
        let id = id.to_owned();
        self.rows.retain(|r| r.id != id);
        self.write(
            "removing a relation",
            move |lib, book| data::delete(lib, book, &id),
            cx,
        );
        cx.notify();
    }

    /// A card's type changed (turned round when its ends fit the new type
    /// only the other way).
    pub fn change_type(&mut self, id: &str, type_id: &str, cx: &mut Context<Self>) {
        self.menu = None;
        let Some(row) = self.rows.iter().find(|r| r.id == id).cloned() else {
            return;
        };
        let Some(t) = self.types.iter().find(|t| t.id == type_id).cloned() else {
            return;
        };
        if row.relation_type == type_id {
            cx.notify();
            return;
        }
        let swap = model::needs_swap(&t, &self.owner, &row);
        self.replace(row, type_id.to_owned(), swap, cx);
    }

    /// ⇄ on a card: the relation turned round.
    pub fn swap(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(row) = self.rows.iter().find(|r| r.id == id).cloned() else {
            return;
        };
        let type_id = row.relation_type.clone();
        self.replace(row, type_id, true, cx);
    }

    fn replace(&mut self, row: Row, type_id: String, swap: bool, cx: &mut Context<Self>) {
        let (from, to) = row.ends(&self.owner);
        let (from, to) = if swap { (to, from) } else { (from, to) };
        if let Some(r) = self.rows.iter_mut().find(|r| r.id == row.id) {
            r.relation_type = type_id.clone();
            if swap {
                r.outgoing = !r.outgoing;
            }
        }
        let id = row.id.clone();
        self.write(
            "changing a relation",
            move |lib, book| data::replace(lib, book, &id, from, to, &type_id),
            cx,
        );
        cx.notify();
    }

    /// A card's name: its page opens.
    pub fn open(&mut self, end: &End, cx: &mut Context<Self>) {
        let Some(target) = model::target_of(&self.book, end) else {
            return;
        };
        if !self.book.exists(&target) {
            return;
        }
        self.ws
            .update(cx, |ws, cx| ws.open(target, Open::KEEP, cx))
            .ok();
    }

    pub fn toggle_menu(&mut self, which: MenuFor, cx: &mut Context<Self>) {
        self.menu = if self.menu.as_ref() == Some(&which) {
            None
        } else {
            Some(which)
        };
        cx.notify();
    }

    /// 「编辑类型」: the book's relation types, over the page.
    pub fn toggle_manager(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.manager.is_some() {
            self.close_manager(cx);
        } else {
            self.open_manager(None, window, cx);
        }
    }

    /// Opens the types; with `seed`, a new type's editor for the pending
    /// pair's kinds (「新建关系类型」 in the type menu).
    fn open_manager(
        &mut self,
        seed: Option<(Vec<String>, Vec<String>)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        self.menu = None;
        let book = self.book.id.clone();
        let manager = cx.new(|cx| TypeManager::new(lib, book, window, cx));
        self.for_pending = seed.is_some();
        if let Some((sources, targets)) = seed {
            manager.update(cx, |m, cx| {
                m.start_new(Some((sources, targets)), window, cx)
            });
        }
        self._manager = Some(cx.subscribe(&manager, |r, _, event, cx| match event {
            TypeEvent::Created(id) => {
                // A type made for the pending pair is chosen for it, and
                // the author is back at the pair.
                let id = id.clone();
                r.reload(cx);
                if r.for_pending && r.pending.is_some() {
                    r.pending_type_after_read(id, cx);
                    r.close_manager(cx);
                }
            }
            TypeEvent::Close => r.close_manager(cx),
        }));
        manager.update(cx, |m, cx| m.focus(window, cx));
        self.manager = Some(manager);
        cx.notify();
    }

    fn pending_type_after_read(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(p) = &mut self.pending {
            p.relation_type = Some(id);
        }
        cx.notify();
    }

    pub fn close_manager(&mut self, cx: &mut Context<Self>) {
        self.manager = None;
        self.for_pending = false;
        self._manager = None;
        cx.notify();
    }

    /// The type menu's 「新建关系类型」: a new type for the pending pair.
    pub fn new_type_for_pending(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let seed = self.pending.as_ref().map(|p| {
            let (from, to) = if p.reversed {
                (&p.end, &self.owner)
            } else {
                (&self.owner, &p.end)
            };
            (vec![from.kind.clone()], vec![to.kind.clone()])
        });
        self.open_manager(seed, window, cx);
    }

    // ── drawing ─────────────────────────────────────────────────────────

    fn words(&self, cx: &App) -> Words {
        Words {
            name: t(cx, rt::generic_association::NAME).to_string(),
            source_role: t(cx, rt::generic_association::SOURCE_ROLE).to_string(),
            target_role: t(cx, rt::generic_association::TARGET_ROLE).to_string(),
        }
    }

    fn summary_of(&self, ty: &RelationTypeInfo, cx: &App) -> (SharedString, SharedString) {
        let w = model::words(ty, &self.words(cx));
        let summary = model::summary(ty, &w, |role| {
            tf(cx, rt::SYMMETRIC_SUMMARY, &[("role", &role)]).to_string()
        });
        (w.name.into(), summary.into())
    }

    /// A type field: the chosen type's dash, name and summary, or the
    /// placeholder; a click opens the type menu.
    fn type_field(
        &self,
        id: SharedString,
        which: MenuFor,
        chosen: Option<&RelationTypeInfo>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // A card's field is bare words; the pending one a field of glass. A
        // card whose type the book no longer has says so.
        let bare = matches!(which, MenuFor::Row(_));
        let missing = bare && chosen.is_none();
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let anchor = overlay::use_bounds(SharedString::from(format!("{id}-anchor")), window, cx);
        let open = self.menu.as_ref() == Some(&which);
        let mut row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .overflow_hidden()
            .font_role(Role::Prose)
            .type_px(if bare { 12.0 } else { 12.5 }, 18.0)
            .text_color(p.ink(2).solid());
        // What the field reads as (the debug bridge and assistive tools find
        // it by this): the chosen type's name, or the placeholder.
        let label: SharedString;
        match chosen {
            Some(ty) => {
                let (name, summary) = self.summary_of(ty, cx);
                label = name.clone();
                let color = look::rgb(model::paint_of(ty), window, cx);
                row = row
                    .child(look::dash(SharedString::from(format!("{id}-dash")), color))
                    .child(div().flex_none().child(name))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(p.ink(4).solid())
                            .type_px(11.0, 16.0)
                            .child(summary),
                    );
            }
            None => {
                let words = if missing {
                    t(cx, rt::MISSING)
                } else {
                    t(cx, rt::SELECT_CONFIGURED)
                };
                label = words.clone();
                row = row.child(div().text_color(p.ink(4).solid()).child(words));
            }
        }
        let toggle =
            cx.listener(move |r, _: &gpui::ClickEvent, _, cx| r.toggle_menu(which.clone(), cx));
        let body = if bare {
            div()
                .id(id.clone())
                .h(px(22.0))
                .flex()
                .items_center()
                .min_w_0()
                .cursor_pointer()
                .on_click(toggle)
                .child(row)
        } else {
            glass::glass_box(
                id.clone(),
                GlassKind::Rest,
                Mode::default(),
                open,
                Spec::new(Tone::Clear, radius::SM),
                window,
                cx,
            )
            .h(px(28.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .min_w_0()
            .cursor_pointer()
            .on_click(toggle)
            .child(row)
        };
        div()
            .relative()
            .min_w_0()
            .flex_1()
            .child(body.role(gpui::Role::ComboBox).aria_label(label))
            .child(overlay::probe(anchor))
            .into_any_element()
    }

    fn picker(&mut self, look: Look, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let labels: Vec<SharedString> = Filter::ALL
            .iter()
            .map(|f| match f {
                Filter::All => t(cx, rp::filters::ALL),
                Filter::Element => look::kind_word("element", cx),
                Filter::Node => look::kind_word("node", cx),
                Filter::Category => look::kind_word("category", cx),
                Filter::Storyline => look::kind_word("storyline", cx),
            })
            .collect();
        let selected = Filter::ALL
            .iter()
            .position(|f| *f == self.filter)
            .unwrap_or(0);
        let this = cx.entity().downgrade();
        let filter = Segmented::new("relations-filter", labels, selected)
            .text_size(12.0)
            .on_change(move |i, _, cx| {
                this.update(cx, |r, cx| r.set_filter(Filter::ALL[i], cx))
                    .ok();
            });
        let mut col = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .mb(px(12.0))
            .child(div().flex().child(filter))
            .child(self.query.clone());
        if let Some(pending) = self.pending.clone() {
            col = col.child(self.pending_row(&pending, window, cx));
        }
        let candidates = self.candidates(cx);
        let list = if candidates.is_empty() {
            div()
                .px(px(4.0))
                .py(px(6.0))
                .font_role(Role::Prose)
                .type_px(12.0, 16.0)
                .text_color(p.ink(4).solid())
                .child(t(cx, rp::picker::EMPTY))
                .into_any_element()
        } else {
            let mut list = div()
                .id("relations-candidates")
                .flex()
                .flex_col()
                .gap(px(1.0))
                .max_h(px(240.0))
                .overflow_y_scroll();
            for (i, c) in candidates.into_iter().enumerate() {
                list = list.child(self.candidate(i, c, window, cx));
            }
            list.into_any_element()
        };
        let _ = look;
        col.child(list).into_any_element()
    }

    fn candidate(
        &self,
        i: usize,
        c: Candidate,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let chosen = self.pending.as_ref().is_some_and(|x| x.end == c.end);
        let title = look::title(&c.end.kind, &c.shown, cx);
        let mark = KindMark::new(
            SharedString::from(format!("relations-cand-mark-{i}")),
            c.shown.mark,
        );
        let mark = match c.shown.color {
            Some(color) => mark.color(color),
            None => mark,
        };
        let end = c.end.clone();
        glass::glass_box(
            SharedString::from(format!("relations-cand-{i}")),
            GlassKind::Hidden,
            Mode::default(),
            chosen,
            Spec::new(
                c.shown.color.map(Tone::Color).unwrap_or(Tone::Clear),
                radius::SM,
            ),
            window,
            cx,
        )
        .min_h(px(30.0))
        .px(px(8.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_label(title.clone())
        .on_click(cx.listener(move |r, _: &gpui::ClickEvent, _, cx| r.choose(end.clone(), cx)))
        .child(mark)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_role(Role::Ui)
                .type_px(13.5, 18.0)
                .text_color(p.ink(1).solid())
                .child(title),
        )
        .child(
            div()
                .flex_none()
                .font_role(Role::Index)
                .type_px(9.0, 12.0)
                .text_color(p.ink(4).solid())
                .child(look::kind_word(&c.end.kind, cx)),
        )
        .into_any_element()
    }

    fn pending_row(
        &mut self,
        pending: &Pending,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let shown = model::shown(&self.book, &pending.end);
        let mark = KindMark::new("relations-pending-mark", shown.mark);
        let mark = match shown.color {
            Some(c) => mark.color(c),
            None => mark,
        };
        let direction = if pending.reversed {
            t(cx, rt::PENDING_INCOMING)
        } else {
            t(cx, rt::PENDING_OUTGOING)
        };
        let chosen = pending
            .relation_type
            .as_ref()
            .and_then(|id| self.types.iter().find(|t| &t.id == id))
            .cloned();
        let field = self.type_field(
            "relations-pending-type".into(),
            MenuFor::Pending,
            chosen.as_ref(),
            window,
            cx,
        );
        let create = Button::new("relations-create", t(cx, keys::story_graph::edge::CREATE))
            .primary()
            .small()
            .disabled(chosen.is_none())
            .on_click(cx.listener(|r, _, _, cx| r.create(cx)));
        div()
            .pt(px(8.0))
            .pb(px(2.0))
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .min_w_0()
                    .font_role(Role::Prose)
                    .type_px(13.5, 18.0)
                    .text_color(p.ink(1).solid())
                    .child(mark)
                    .child(look::title(&pending.end.kind, &shown, cx)),
            )
            .child(
                div()
                    .id("relations-direction")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(direction.clone())
                    .font_role(Role::Ui)
                    .type_px(12.0, 16.0)
                    .text_color(p.ink(3).solid())
                    .on_click(cx.listener(|r, _, _, cx| r.reverse_pending(cx)))
                    .child(direction)
                    .child("·")
                    .child(sand::icon(Icon::Swap, 10.0, p.ink(3).solid())),
            )
            .child(div().flex_1().min_w(px(160.0)).flex().child(field))
            .child(create)
            .into_any_element()
    }

    fn card(
        &self,
        row: &Row,
        width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let shown = model::shown(&self.book, &row.other);
        let id = row.id.clone();
        let key = |part: &str| SharedString::from(format!("relations-card-{part}-{id}"));
        let group = key("group");
        let mark = KindMark::new(key("mark"), shown.mark);
        let mark = match shown.color {
            Some(c) => mark.color(c),
            None => mark,
        };
        let ty = self
            .types
            .iter()
            .find(|t| t.id == row.relation_type)
            .cloned();
        let field = self.type_field(
            key("type"),
            MenuFor::Row(row.id.clone()),
            ty.as_ref(),
            window,
            cx,
        );
        let swap = ty
            .as_ref()
            .is_some_and(|t| model::can_swap(t, &self.owner, row));
        let remove_id = row.id.clone();
        let swap_id = row.id.clone();
        let other = row.other.clone();
        let title = look::title(&row.other.kind, &shown, cx);
        glass::glass_box(
            key("box"),
            GlassKind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::SM),
            window,
            cx,
        )
        .group(group.clone())
        .role(gpui::Role::Group)
        .aria_label(title.clone())
        .w(px(width))
        .pt(px(10.0))
        .px(px(11.0))
        .pb(px(11.0))
        .flex()
        .flex_col()
        .gap(px(7.0))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(mark)
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(9.0, 12.0)
                        .text_color(p.ink(4).solid())
                        .child(look::kind_word(&row.other.kind, cx)),
                )
                .child(sand::icon(
                    if row.outgoing {
                        Icon::ArrowForward
                    } else {
                        Icon::ArrowBack
                    },
                    9.0,
                    p.ink(5).solid(),
                ))
                .child(div().flex_1())
                .child(
                    div()
                        .id(key("remove"))
                        .size(px(16.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .aria_label(t(cx, rp::actions::REMOVE))
                        .opacity(0.0)
                        .group_hover(group.clone(), |s| s.opacity(1.0))
                        .on_click(cx.listener(move |r, _: &gpui::ClickEvent, _, cx| {
                            r.remove(&remove_id, cx)
                        }))
                        .child(sand::icon(Icon::Close, 9.0, p.ink(4).solid())),
                ),
        )
        .child(
            div()
                .id(key("title"))
                .min_w_0()
                .truncate()
                .font_role(Role::Ui)
                .italic()
                .type_px(15.0, 20.0)
                .text_color(p.ink(1).solid())
                .when(shown.live, |el| {
                    el.cursor_pointer()
                        .role(gpui::Role::Link)
                        .aria_label(title.clone())
                        .hover(|s| s.text_color(p.ink(2).solid()).underline())
                        .on_click(
                            cx.listener(move |r, _: &gpui::ClickEvent, _, cx| r.open(&other, cx)),
                        )
                })
                .child(title),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .child(field)
                .when(swap, |el| {
                    el.child(
                        div()
                            .id(key("swap"))
                            .flex_none()
                            .size(px(20.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .role(gpui::Role::Button)
                            .aria_label(t(cx, rt::SWAP))
                            .on_click(cx.listener(move |r, _: &gpui::ClickEvent, _, cx| {
                                r.swap(&swap_id, cx)
                            }))
                            .child(sand::icon(Icon::Swap, 11.0, p.ink(3).solid())),
                    )
                }),
        )
        .into_any_element()
    }

    fn grid(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let width = (*self.grid.read(cx)).map(|b| f32::from(b.size.width));
        let cols = width
            .map(|w| (((w + CARD_GAP) / (CARD_MIN_W + CARD_GAP)).floor() as usize).max(1))
            .unwrap_or(1);
        let card_w = width
            .map(|w| ((w - CARD_GAP * (cols as f32 - 1.0)) / cols as f32).floor())
            .unwrap_or(CARD_MIN_W);
        let rows = self.rows.clone();
        let mut grid = div()
            .relative()
            .w_full()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(CARD_GAP));
        for row in &rows {
            grid = grid.child(self.card(row, card_w, window, cx));
        }
        grid.child(overlay::probe(self.grid.clone()))
            .into_any_element()
    }

    fn menu_float(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let which = self.menu.clone()?;
        let id: SharedString = match &which {
            MenuFor::Pending => "relations-pending-type".into(),
            MenuFor::Row(row) => format!("relations-card-type-{row}").into(),
        };
        let anchor =
            (*overlay::use_bounds(SharedString::from(format!("{id}-anchor")), window, cx)
                .read(cx))?;
        let theme = Theme::of(window, cx);
        let current = match &which {
            MenuFor::Pending => self.pending.as_ref().and_then(|p| p.relation_type.clone()),
            MenuFor::Row(row) => self
                .rows
                .iter()
                .find(|r| &r.id == row)
                .map(|r| r.relation_type.clone()),
        };
        let options: Vec<RelationTypeInfo> = self.menu_options().into_iter().cloned().collect();
        let mut menu = Menu::new("relations-type-menu").width(MenuWidth::Wide);
        for (i, ty) in options.iter().enumerate() {
            let (name, summary) = self.summary_of(ty, cx);
            let color = look::rgb(model::paint_of(ty), window, cx);
            let type_id = ty.id.clone();
            let which = which.clone();
            menu = menu.item(
                MenuItem::new(
                    SharedString::from(format!("relations-type-option-{i}")),
                    RowIcon::Mark(sand::Kind::Storyline, Some(color)),
                    name,
                )
                .trailing(summary)
                .checked(current.as_deref() == Some(ty.id.as_str()))
                .on_click(
                    cx.listener(move |r, _: &gpui::ClickEvent, _, cx| match &which {
                        MenuFor::Pending => r.set_pending_type(&type_id, cx),
                        MenuFor::Row(row) => r.change_type(&row.clone(), &type_id, cx),
                    }),
                ),
            );
        }
        if which == MenuFor::Pending {
            if !options.is_empty() {
                menu = menu.separator(&theme);
            }
            menu = menu.item(
                MenuItem::new("relations-type-new", Icon::Plus, t(cx, rt::CREATE_INLINE)).on_click(
                    cx.listener(|r, _: &gpui::ClickEvent, window, cx| {
                        r.new_type_for_pending(window, cx)
                    }),
                ),
            );
        }
        let close = cx.listener(move |r, e: &gpui::MouseDownEvent, _, cx| {
            if anchor.contains(&e.position) {
                return;
            }
            r.menu = None;
            cx.notify();
        });
        Some(
            overlay::float(
                Place::Rect {
                    rect: anchor,
                    align: Align::Start,
                    gap: 4.0,
                },
                Layer::Popover,
                div()
                    .id("relations-type-menu-float")
                    .occlude()
                    .on_mouse_down_out(close)
                    .child(menu),
            )
            .into_any_element(),
        )
    }

    fn manager_float(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let manager = self.manager.clone()?;
        let anchor = (*overlay::use_bounds("relations-types-anchor", window, cx).read(cx))?;
        let close = cx.listener(move |r, e: &gpui::MouseDownEvent, _, cx| {
            if anchor.contains(&e.position) {
                return;
            }
            // A question the manager asked is the window's dialog.
            if r.ws
                .upgrade()
                .is_some_and(|ws| ws.read(cx).dialog.is_some())
            {
                return;
            }
            r.close_manager(cx);
        });
        Some(
            overlay::float(
                Place::Rect {
                    rect: anchor,
                    align: Align::End,
                    gap: 4.0,
                },
                Layer::Popover,
                div()
                    .id("relations-types-float")
                    .occlude()
                    .on_mouse_down_out(close)
                    .child(manager),
            )
            .into_any_element(),
        )
    }
}

impl Render for Relations {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let look = look::look(cx);
        let p = Theme::of(window, cx).palette;
        let count = self.rows.len();
        let types_anchor = overlay::use_bounds("relations-types-anchor", window, cx);
        let edit_types = look::text_action(
            "relations-edit-types",
            None,
            t(cx, ekm::EDIT_TYPES),
            cx.listener(|r, _: &gpui::ClickEvent, window, cx| r.toggle_manager(window, cx)),
            window,
            cx,
        );
        let edit_types = div()
            .relative()
            .child(edit_types)
            .child(overlay::probe(types_anchor))
            .into_any_element();
        let add = if self.picking {
            look::text_action(
                "relations-add",
                None,
                t(cx, keys::common::CANCEL),
                cx.listener(|r, _: &gpui::ClickEvent, _, cx| r.set_picking(false, cx)),
                window,
                cx,
            )
        } else {
            look::text_action(
                "relations-add",
                Some(Icon::Plus),
                t(cx, rp::actions::LINK_ENTITY),
                cx.listener(|r, _: &gpui::ClickEvent, window, cx| {
                    r.set_picking(true, cx);
                    let focus = r.query.focus_handle(cx);
                    window.focus(&focus, cx);
                }),
                window,
                cx,
            )
        };
        let head = look::section(
            t(cx, rp::sections::RELATIONS),
            vec![
                look::meta(count.to_string().into(), window, cx),
                edit_types,
                add.into_any_element(),
            ],
            window,
            cx,
        );
        let mut body = div().w_full().flex().flex_col().child(head);
        if self.picking {
            body = body.child(self.picker(look, window, cx));
        }
        if self.loaded && self.rows.is_empty() && !self.picking {
            body = body.child(look::empty_line(
                t(cx, rp::empty::RELATIONS),
                look,
                window,
                cx,
            ));
        }
        body = body.child(self.grid(window, cx));
        let menu = self.menu_float(window, cx);
        let manager = self.manager_float(window, cx);
        let _ = p;
        look::column(look, body)
            // The page's last section (0.1: the element page's patches came
            // after it; they are not here yet).
            .pb(px(80.0))
            .children(menu)
            .children(manager)
    }
}
