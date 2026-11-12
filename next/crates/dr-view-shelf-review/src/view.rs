//! Main M23 view (`ShelfReviewView`) and its two header slot views
//! (`ShelfReviewHeadStart` and `ShelfReviewHeadEnd`).

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

use dr_i18n::keys;
use dr_shell::{
    Strings, Workspace,
    book::Book,
    nav::{Open, Target},
    pages::SuperViewHost,
    strings::tf,
    t,
};
use dr_ui::{
    Theme,
    components::{EmptyState, PanelIconButton},
    fonts::{Role, weight},
    input::field::{FieldEvent, TextField},
    sand::{Icon, KindMark},
    style::DrStyled,
};
use dr_view_material::folders::Selection;
use dr_view_review::{Filter, ReviewView};
use dr_workspace::{
    Actor, Workspace as Library, WsEvent,
    commands::{
        material::{MaterialCreate, MaterialCreateIn},
        v3::{
            comment::{CommentCreate, CommentCreateIn},
            material_links::{SetEntryLink, SetEntryLinkIn},
        },
    },
};
use futures::{FutureExt as _, future::LocalBoxFuture};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, DragMoveEvent, Entity, FocusHandle,
    Focusable as _, InteractiveElement, IntoElement, KeyDownEvent, ListAlignment, ListState,
    MouseButton, MouseDownEvent, ParentElement, Pixels, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Subscription, Task, WeakEntity, Window, canvas, div,
    list, px,
};

use crate::{
    dialogs::ActiveDialog,
    drawer::{DrawerResizeDrag, EmptyDragGhost},
    model::{
        KIND_ORDER, MEMORY_KEY, RAIL_KEY_STEP, Rail, ShelfCounts, ShelfMemory, filter_listing,
        normalize_query,
    },
};

#[derive(Clone, PartialEq, Eq)]
struct ReviewCacheKey {
    rv_id: gpui::EntityId,
    data_rev: u64,
    query: String,
}

#[derive(Clone)]
pub(crate) enum RailRow {
    Header {
        first: bool,
        mark: Option<dr_ui::sand::Kind>,
        title: SharedString,
        jump: Option<dr_view_review::v3::Target>,
    },
    Card {
        item: Rc<dr_workspace::dto::CommentInfo>,
        bottom_pad: f32,
    },
}

#[derive(Clone)]
pub(crate) enum ShelfGridRow {
    Header {
        kind: &'static str,
        count: usize,
        first: bool,
    },
    Cards {
        items: Rc<[dr_workspace::dto::MaterialInfo]>,
        bottom_pad: f32,
    },
}

pub(crate) type ListSigSlot = RefCell<(Option<Rc<[String]>>, i32)>;
pub(crate) type ShelfRowsCache = RefCell<
    Option<(
        Rc<[dr_workspace::dto::MaterialInfo]>,
        usize,
        Rc<[ShelfGridRow]>,
        Rc<[String]>,
    )>,
>;

pub(crate) fn sync_list_state(
    list_state: &ListState,
    sig_slot: &ListSigSlot,
    keys: &Rc<[String]>,
    measure_key: i32,
) {
    let mut prev = sig_slot.borrow_mut();
    let same_keys = prev
        .0
        .as_ref()
        .is_some_and(|old| Rc::ptr_eq(old, keys) || old.as_ref() == keys.as_ref());
    if !same_keys {
        let mut offset = list_state.logical_scroll_top();
        if let Some(old) = prev.0.as_ref()
            && let Some(anchor) = old.get(offset.item_ix)
            && let Some(new_ix) = keys.iter().position(|k| k == anchor)
        {
            offset.item_ix = new_ix;
        }
        offset.item_ix = offset.item_ix.min(keys.len().saturating_sub(1));
        list_state.reset(keys.len());
        if !keys.is_empty() {
            list_state.scroll_to(offset);
        }
        *prev = (Some(keys.clone()), measure_key);
    } else {
        prev.0 = Some(keys.clone());
        if prev.1 != measure_key {
            list_state.remeasure_items(0..keys.len());
            prev.1 = measure_key;
        }
    }
}

fn build_rail_rows(
    rv_ref: &ReviewView,
    groups: &[dr_view_review::Group],
) -> (Rc<[RailRow]>, Rc<[String]>) {
    let editing_id = rv_ref.editing_id();
    let mut rows = Vec::new();
    let mut keys = Vec::new();
    let group_count = groups.len();
    for (g_idx, group) in groups.iter().enumerate() {
        let (mark, group_title, jump) = rv_ref.group_header(group);
        keys.push(format!("hdr:{g_idx}:{group_title}"));
        rows.push(RailRow::Header {
            first: g_idx == 0,
            mark,
            title: group_title,
            jump,
        });
        let item_count = group.items.len();
        for (i_idx, item) in group.items.iter().enumerate() {
            let last_in_group = i_idx + 1 == item_count;
            let last_overall = g_idx + 1 == group_count && last_in_group;
            let bottom_pad = if last_overall {
                10.0
            } else if last_in_group {
                0.0
            } else {
                6.0
            };
            let is_editing = editing_id == Some(item.id.as_str());
            keys.push(format!("card:{}:{}", item.id, u8::from(is_editing)));
            rows.push(RailRow::Card {
                item: Rc::new(item.clone()),
                bottom_pad,
            });
        }
    }
    (rows.into(), keys.into())
}

#[derive(Clone)]
pub(crate) struct CachedReview {
    pub(crate) open_todos: usize,
    pub(crate) open_comments: usize,
    pub(crate) todo_rows: Rc<[RailRow]>,
    pub(crate) todo_keys: Rc<[String]>,
    pub(crate) comment_rows: Rc<[RailRow]>,
    pub(crate) comment_keys: Rc<[String]>,
    pub(crate) resolved_items: Rc<[(dr_workspace::dto::CommentInfo, SharedString)]>,
    pub(crate) resolved_keys: Rc<[String]>,
}

impl Default for CachedReview {
    fn default() -> Self {
        Self {
            open_todos: 0,
            open_comments: 0,
            todo_rows: Rc::from([]),
            todo_keys: Rc::from([]),
            comment_rows: Rc::from([]),
            comment_keys: Rc::from([]),
            resolved_items: Rc::from([]),
            resolved_keys: Rc::from([]),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct MaterialCacheKey {
    book_ptr: usize,
    mat_state_rev: u64,
    kinds_mask: u8,
    selected_entry: Option<String>,
}

#[derive(Clone)]
pub(crate) struct CachedMaterials {
    pub(crate) visible: Rc<[dr_workspace::dto::MaterialInfo]>,
    pub(crate) orphans: Rc<[dr_workspace::dto::MaterialInfo]>,
    pub(crate) orphan_keys: Rc<[String]>,
}

static NEXT_REVIEW_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy)]
struct RailResizeDrag(Rail);

/// Ownership token preventing stale navigation or `book_memory` writes after a
/// book or library switch.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Owner {
    book: String,
    library: usize,
}

impl Owner {
    fn of(book_id: &str, book: &Book, lib: Option<&Library>) -> Option<Self> {
        let lib = lib?;
        (!book_id.is_empty() && book.id == book_id && book.v3().is_some()).then(|| Self {
            book: book_id.to_owned(),
            library: lib.library() as *const _ as usize,
        })
    }

    fn matches(&self, ws: &Workspace) -> bool {
        ws.book_id == self.book
            && ws.book.id == self.book
            && ws.book.v3().is_some()
            && ws
                .library
                .as_ref()
                .is_some_and(|lib| lib.library() as *const _ as usize == self.library)
    }
}

fn v3_review_target(target: dr_view_review::v3::Target) -> Option<Target> {
    use dr_view_review::v3::Target as ReviewTarget;
    Some(match target {
        ReviewTarget::Entry { id, module } => Target::Entry {
            id: id.parse().ok()?,
            module: module.map(|m| m.parse()).transpose().ok()?,
        },
        ReviewTarget::Material(id) => Target::Material(id.parse().ok()?),
    })
}

/// Header left slot: `{{todos}} 待办 · {{comments}} 批注 · {{materials}} 素材`.
pub struct ShelfReviewHeadStart {
    view: WeakEntity<ShelfReviewView>,
    _sub: Subscription,
}

impl ShelfReviewHeadStart {
    pub fn new(view: &Entity<ShelfReviewView>, cx: &mut Context<Self>) -> Self {
        let sub = cx.observe(view, |_, _, cx| cx.notify());
        Self {
            view: view.downgrade(),
            _sub: sub,
        }
    }
}

impl Render for ShelfReviewHeadStart {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let counts = self
            .view
            .upgrade()
            .map(|v| v.update(cx, |this, cx| this.counts(cx)))
            .unwrap_or_default();
        let meta = tf(
            cx,
            keys::memo_material::super_::META,
            &[
                ("todos", &counts.open_todos.to_string()),
                ("comments", &counts.open_comments.to_string()),
                ("materials", &counts.materials.to_string()),
            ],
        );
        div()
            .id("shelf-review-head-meta")
            .px(px(6.0))
            .font_role(Role::Index)
            .type_px(s.caption, s.line_caption)
            .text_color(p.ink(3).solid())
            .child(meta)
    }
}

/// Header right slot: unified search input filtering TODOs, comments, materials
/// and bottom-drawer items.
pub struct ShelfReviewHeadEnd {
    field: Entity<TextField>,
}

impl ShelfReviewHeadEnd {
    pub fn new(
        view: &Entity<ShelfReviewView>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            field: view.read(cx).search_field.clone(),
        }
    }
}

impl Render for ShelfReviewHeadEnd {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("shelf-review-head-search")
            .w(px(220.0))
            .child(self.field.clone())
    }
}

pub struct ShelfReviewView {
    pub(crate) ws: WeakEntity<Workspace>,
    pub(crate) lib: Option<Library>,
    pub(crate) book_id: String,
    pub(crate) book: Rc<Book>,
    owner: Option<Owner>,
    review_id: SharedString,
    pub(crate) review: Option<Entity<ReviewView>>,
    _review_sub: Option<Subscription>,

    pub(crate) memory: ShelfMemory,
    memory_loaded_for: Option<String>,
    stage_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    rail_drag_start: Option<(Rail, f32, f32)>,
    pub(crate) drawer_drag_start: Option<(f32, f32)>,
    todo_resize_focus: FocusHandle,
    comment_resize_focus: FocusHandle,

    pub(crate) search_field: Entity<TextField>,
    _search_sub: Subscription,

    pub(crate) active_kinds: HashSet<&'static str>,
    pub(crate) selected_entry: Option<String>,
    pub(crate) entry_menu_open: bool,
    pub(crate) entry_search: Option<Entity<TextField>>,
    _entry_search_sub: Option<Subscription>,
    pub(crate) add_menu_open: bool,
    pub(crate) dialog: Option<ActiveDialog>,

    pub(crate) linked_materials: HashSet<String>,
    pub(crate) entry_related_materials: Option<HashSet<String>>,
    pub(crate) entry_links_cache: HashMap<String, Vec<dr_view_material::v3::EntryLink>>,
    entry_links_loading: HashSet<String>,
    relations_loaded: bool,
    rel_serial: u64,
    mat_state_rev: u64,
    rel_task: Option<Task<()>>,
    import_task: Option<Task<()>>,
    review_cache: RefCell<Option<(ReviewCacheKey, CachedReview)>>,
    material_cache: RefCell<Option<(MaterialCacheKey, CachedMaterials)>>,
    pub(crate) shelf_rows_cache: ShelfRowsCache,
    pub(crate) todo_list: ListState,
    pub(crate) todo_list_sig: ListSigSlot,
    pub(crate) comment_list: ListState,
    pub(crate) comment_list_sig: ListSigSlot,
    pub(crate) material_list: ListState,
    pub(crate) material_list_sig: ListSigSlot,
    pub(crate) orphan_list: ListState,
    pub(crate) orphan_list_sig: ListSigSlot,
    pub(crate) resolved_list: ListState,
    pub(crate) resolved_list_sig: ListSigSlot,

    in_flight_writes: Vec<futures::future::Shared<futures::channel::oneshot::Receiver<()>>>,
    _ws_sub: Option<Subscription>,
    _lib_sub: Option<dr_workspace::Subscription>,
}

impl ShelfReviewView {
    pub fn new(host: &SuperViewHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = t(cx, keys::memo_material::super_::SEARCH_PLACEHOLDER);
        let search_field = cx.new(|cx| {
            TextField::new("shelf-review-search-input", window, cx)
                .icon(Icon::Search)
                .small()
                .placeholder(placeholder)
        });
        let search_sub = cx.subscribe_in(
            &search_field,
            window,
            |_this, field, ev: &FieldEvent, _, cx| {
                if matches!(ev, FieldEvent::Cancelled) {
                    field.update(cx, |f, cx| f.set_text("", cx));
                }
                cx.notify();
            },
        );

        let review_id = SharedString::from(format!(
            "shelf-review-{}",
            NEXT_REVIEW_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let self_weak = cx.weak_entity();
        cx.default_global::<crate::Registry>().views.push(self_weak);
        let owner = Owner::of(&host.book_id, &host.book, host.library.as_ref());
        let mut this = Self {
            ws: host.workspace.clone(),
            lib: host.library.clone(),
            book_id: host.book_id.clone(),
            book: host.book.clone(),
            owner,
            review_id,
            review: None,
            _review_sub: None,
            memory: ShelfMemory::default(),
            memory_loaded_for: None,
            stage_bounds: Rc::new(Cell::new(None)),
            rail_drag_start: None,
            drawer_drag_start: None,
            todo_resize_focus: cx.focus_handle(),
            comment_resize_focus: cx.focus_handle(),
            search_field,
            _search_sub: search_sub,
            active_kinds: KIND_ORDER.into_iter().collect(),
            selected_entry: None,
            entry_menu_open: false,
            entry_search: None,
            _entry_search_sub: None,
            add_menu_open: false,
            dialog: None,
            linked_materials: HashSet::new(),
            entry_related_materials: None,
            entry_links_cache: HashMap::new(),
            entry_links_loading: HashSet::new(),
            relations_loaded: false,
            rel_serial: 0,
            mat_state_rev: 0,
            rel_task: None,
            import_task: None,
            review_cache: RefCell::new(None),
            material_cache: RefCell::new(None),
            shelf_rows_cache: RefCell::new(None),
            todo_list: ListState::new(0, ListAlignment::Top, px(220.0)),
            todo_list_sig: RefCell::new((None, 0)),
            comment_list: ListState::new(0, ListAlignment::Top, px(220.0)),
            comment_list_sig: RefCell::new((None, 0)),
            material_list: ListState::new(0, ListAlignment::Top, px(240.0)),
            material_list_sig: RefCell::new((None, 0)),
            orphan_list: ListState::new(0, ListAlignment::Top, px(160.0)),
            orphan_list_sig: RefCell::new((None, 0)),
            resolved_list: ListState::new(0, ListAlignment::Top, px(160.0)),
            resolved_list_sig: RefCell::new((None, 0)),
            in_flight_writes: Vec::new(),
            _ws_sub: None,
            _lib_sub: None,
        };

        this.bind_review(cx);
        this.bind_library_events(cx);
        this.reload_relations(cx);

        // `Workspace` is borrowed while building the Super View page; attach
        // observation and read `book_memory` on the next microtask.
        let ws_weak = host.workspace.clone();
        cx.spawn(async move |view, cx| {
            view.update(cx, |this, cx| {
                if let Some(ws) = ws_weak.upgrade() {
                    this._ws_sub = Some(cx.observe(&ws, |this, ws, cx| {
                        this.sync_from_workspace(ws, cx);
                    }));
                    this.sync_from_workspace(ws, cx);
                }
            })
            .ok();
        })
        .detach();

        this
    }

    /// Underlying `ReviewView` entity backing both review rails and the resolved drawer.
    pub fn review_view(&self) -> Option<&Entity<ReviewView>> {
        self.review.as_ref()
    }

    /// Whether both the review snapshot and canonical material relations have loaded.
    pub fn is_ready(&self, cx: &App) -> bool {
        self.relations_loaded
            && self
                .review
                .as_ref()
                .is_some_and(|rv| rv.read(cx).is_loaded())
    }

    pub fn memory(&self) -> &ShelfMemory {
        &self.memory
    }

    pub fn selected_entry(&self) -> Option<&str> {
        self.selected_entry.as_deref()
    }

    pub fn query_text(&self, cx: &App) -> String {
        self.search_field.read(cx).text().to_owned()
    }

    pub fn set_search_query(&mut self, query: &str, cx: &mut Context<Self>) {
        self.search_field
            .update(cx, |f, cx| f.set_text(query.to_owned(), cx));
        cx.notify();
    }

    pub fn set_kind_enabled(&mut self, kind: &'static str, enabled: bool, cx: &mut Context<Self>) {
        if enabled {
            self.active_kinds.insert(kind);
        } else {
            self.active_kinds.remove(kind);
        }
        cx.notify();
    }

    pub fn set_entry_filter(&mut self, entry: Option<String>, cx: &mut Context<Self>) {
        let changed = self.selected_entry != entry;
        self.selected_entry = entry;
        self.entry_menu_open = false;
        if changed {
            self.relations_loaded = false;
            self.reload_relations(cx);
        }
        cx.notify();
    }

    pub(crate) fn toggle_entry_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.entry_menu_open = !self.entry_menu_open;
        self.add_menu_open = false;
        if self.entry_menu_open && self.entry_search.is_none() {
            let placeholder = t(cx, keys::memo_material::super_::SEARCH_PLACEHOLDER);
            let field = cx.new(|cx| {
                TextField::new("shelf-entry-filter-search", window, cx)
                    .icon(Icon::Search)
                    .small()
                    .placeholder(placeholder)
            });
            let sub = cx.subscribe_in(&field, window, |this, _, ev: &FieldEvent, _, cx| {
                if matches!(ev, FieldEvent::Cancelled) {
                    this.entry_menu_open = false;
                }
                cx.notify();
            });
            self.entry_search = Some(field);
            self._entry_search_sub = Some(sub);
        }
        if let Some(field) = &self.entry_search
            && self.entry_menu_open
        {
            field.update(cx, |f, cx| f.set_text("", cx));
            field.read(cx).focus_handle(cx).focus(window, cx);
        }
        cx.notify();
    }

    pub fn toggle_drawer(&mut self, cx: &mut Context<Self>) {
        self.memory.drawer_open = !self.memory.drawer_open;
        self.persist_memory(cx);
        cx.notify();
    }

    pub fn set_drawer_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.memory.drawer_open != open {
            self.memory.drawer_open = open;
            self.persist_memory(cx);
            cx.notify();
        }
    }

    pub fn resize_rail(
        &mut self,
        rail: Rail,
        proposed: f32,
        container_width: Option<f32>,
        cx: &mut Context<Self>,
    ) -> (f32, f32) {
        let cw = container_width.or_else(|| self.container_width());
        let out = self.memory.apply_rail_drag(rail, proposed, cw);
        self.persist_memory(cx);
        cx.notify();
        out
    }

    pub fn resize_drawer(
        &mut self,
        proposed: f32,
        container_height: Option<f32>,
        cx: &mut Context<Self>,
    ) -> f32 {
        let ch = container_height.or_else(|| self.container_height());
        let out = self.memory.apply_drawer_height(proposed, ch);
        self.persist_memory(cx);
        cx.notify();
        out
    }

    fn active_kinds_mask(&self) -> u8 {
        let mut mask = 0u8;
        for (idx, kind) in KIND_ORDER.iter().enumerate() {
            if self.active_kinds.contains(kind) {
                mask |= 1u8 << idx;
            }
        }
        mask
    }

    pub(crate) fn review_snapshot(&self, cx: &App) -> CachedReview {
        let Some(rv) = &self.review else {
            return CachedReview::default();
        };
        let query = self.query_text(cx);
        let rv_ref = rv.read(cx);
        let key = ReviewCacheKey {
            rv_id: rv.entity_id(),
            data_rev: rv_ref.data_revision(),
            query: query.clone(),
        };
        if let Some((cached_key, cached)) = self.review_cache.borrow().as_ref()
            && *cached_key == key
        {
            return cached.clone();
        }
        let todos = filter_listing(rv_ref.cards_for(Filter::Todos, None), &query, |item| {
            rv_ref
                .source_summary(&item.id)
                .map(|(title, _)| title.to_string())
                .unwrap_or_default()
        });
        let comments = filter_listing(rv_ref.cards_for(Filter::Comments, None), &query, |item| {
            rv_ref
                .source_summary(&item.id)
                .map(|(title, _)| title.to_string())
                .unwrap_or_default()
        });
        let all = filter_listing(rv_ref.cards_for(Filter::All, None), &query, |item| {
            rv_ref
                .source_summary(&item.id)
                .map(|(title, _)| title.to_string())
                .unwrap_or_default()
        });
        let open_todos = todos.open.iter().map(|g| g.items.len()).sum();
        let open_comments = comments.open.iter().map(|g| g.items.len()).sum();
        let (todo_rows, todo_keys) = build_rail_rows(rv_ref, &todos.open);
        let (comment_rows, comment_keys) = build_rail_rows(rv_ref, &comments.open);
        let mut resolved_items = Vec::new();
        let mut resolved_keys = Vec::new();
        for group in all.resolved {
            let (_, group_title, _) = rv_ref.group_header(&group);
            for item in group.items {
                resolved_keys.push(item.id.clone());
                resolved_items.push((item, group_title.clone()));
            }
        }
        let built = CachedReview {
            open_todos,
            open_comments,
            todo_rows,
            todo_keys,
            comment_rows,
            comment_keys,
            resolved_items: resolved_items.into(),
            resolved_keys: resolved_keys.into(),
        };
        *self.review_cache.borrow_mut() = Some((key, built.clone()));
        built
    }

    pub(crate) fn materials_snapshot(&self, cx: &mut App) -> CachedMaterials {
        let query = normalize_query(&self.query_text(cx));
        if query.is_empty() {
            let key = MaterialCacheKey {
                book_ptr: Rc::as_ptr(&self.book) as usize,
                mat_state_rev: self.mat_state_rev,
                kinds_mask: self.active_kinds_mask(),
                selected_entry: self.selected_entry.clone(),
            };
            if let Some((cached_key, cached)) = self.material_cache.borrow().as_ref()
                && *cached_key == key
            {
                return cached.clone();
            }
            let visible: Rc<[_]> = self.compute_visible_materials("", cx).into();
            let orphans_vec: Vec<_> = visible
                .iter()
                .filter(|mat| !self.linked_materials.contains(&mat.id))
                .cloned()
                .collect();
            let orphan_keys: Rc<[String]> = orphans_vec
                .iter()
                .map(|m| m.id.clone())
                .collect::<Vec<_>>()
                .into();
            let orphans: Rc<[_]> = orphans_vec.into();
            let built = CachedMaterials {
                visible,
                orphans,
                orphan_keys,
            };
            *self.material_cache.borrow_mut() = Some((key, built.clone()));
            return built;
        }
        let visible: Rc<[_]> = self.compute_visible_materials(&query, cx).into();
        let orphans_vec: Vec<_> = visible
            .iter()
            .filter(|mat| !self.linked_materials.contains(&mat.id))
            .cloned()
            .collect();
        let orphan_keys: Rc<[String]> = orphans_vec
            .iter()
            .map(|m| m.id.clone())
            .collect::<Vec<_>>()
            .into();
        let orphans: Rc<[_]> = orphans_vec.into();
        CachedMaterials {
            visible,
            orphans,
            orphan_keys,
        }
    }

    pub fn counts(&self, cx: &mut App) -> ShelfCounts {
        let rev = self.review_snapshot(cx);
        let mats = self.materials_snapshot(cx);
        ShelfCounts {
            open_todos: rev.open_todos,
            open_comments: rev.open_comments,
            materials: mats.visible.len(),
            orphans: mats.orphans.len(),
            resolved: rev.resolved_items.len(),
        }
    }

    fn container_width(&self) -> Option<f32> {
        self.stage_bounds
            .get()
            .map(|b| f32::from(b.size.width))
            .filter(|&w| w > 0.0)
    }

    fn container_height(&self) -> Option<f32> {
        self.stage_bounds
            .get()
            .map(|b| f32::from(b.size.height))
            .filter(|&h| h > 0.0)
    }

    fn persist_memory(&mut self, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        let Some(owner) = self.owner.clone() else {
            return;
        };
        let value = self.memory.to_json();
        let ws_weak = self.ws.clone();
        cx.spawn(async move |_, cx| {
            ws_weak
                .update(cx, |ws, cx| {
                    if owner.matches(ws) {
                        ws.set_book_memory(MEMORY_KEY, value, cx);
                    }
                })
                .ok();
        })
        .detach();
    }

    fn sync_from_workspace(&mut self, ws_ent: Entity<Workspace>, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        let (ws_book_id, ws_book, ws_lib, mem_ready, saved_mem) = {
            let ws = ws_ent.read(cx);
            (
                ws.book_id.clone(),
                ws.book.clone(),
                ws.library.clone(),
                ws.book_memory_ready(),
                ws.book_memory(MEMORY_KEY).cloned(),
            )
        };

        let lib_changed = match (&self.lib, &ws_lib) {
            (Some(a), Some(b)) => !std::ptr::eq(a.library(), b.library()),
            (None, None) => false,
            _ => true,
        };
        let book_changed = self.book_id != ws_book_id;
        let rev_changed = self.book.v3().map(|b| &b.revision) != ws_book.v3().map(|b| &b.revision)
            || self.book.material_items().len() != ws_book.material_items().len();

        if book_changed || lib_changed {
            self.book_id = ws_book_id;
            self.book = ws_book;
            self.lib = ws_lib;
            self.owner = Owner::of(&self.book_id, &self.book, self.lib.as_ref());
            self.memory = ShelfMemory::default();
            self.memory_loaded_for = None;
            self.selected_entry = None;
            self.entry_related_materials = None;
            self.mat_state_rev += 1;
            self.entry_links_cache.clear();
            self.entry_links_loading.clear();
            self.relations_loaded = false;
            self.dialog = None;
            self.entry_menu_open = false;
            self.add_menu_open = false;
            self.bind_library_events(cx);
            self.bind_review(cx);
            self.reload_relations(cx);
        } else if !Rc::ptr_eq(&self.book, &ws_book) {
            self.book = ws_book;
            self.owner = Owner::of(&self.book_id, &self.book, self.lib.as_ref());
            if let Some(sel) = &self.selected_entry
                && self.book.v3().and_then(|b| b.entry(sel)).is_none()
            {
                self.selected_entry = None;
                self.entry_related_materials = None;
            }
            self.mat_state_rev += 1;
            self.bind_review(cx);
            if rev_changed {
                self.entry_links_cache.clear();
                self.entry_links_loading.clear();
                self.reload_relations(cx);
            }
        }

        if mem_ready && self.memory_loaded_for.as_deref() != Some(self.book_id.as_str()) {
            if let Some(val) = saved_mem {
                self.memory = ShelfMemory::from_json(&val);
            }
            self.memory_loaded_for = Some(self.book_id.clone());
        }
        cx.notify();
    }

    fn bind_review(&mut self, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) || self.lib.is_none() || self.book.v3().is_none() {
            self.review = None;
            self._review_sub = None;
            return;
        }
        let Some(owner) = self.owner.clone() else {
            self.review = None;
            self._review_sub = None;
            return;
        };
        let strings = Strings::get(cx);
        let (locale, platform) = (strings.locale(), strings.platform());
        let ws_weak = self.ws.clone();
        let open: dr_view_review::v3_panel::Open = Rc::new(move |source, _, cx| {
            let Some(target) = v3_review_target(source) else {
                return;
            };
            ws_weak
                .update(cx, |ws, cx| {
                    if owner.matches(ws) && ws.book.exists(&target) {
                        ws.super_view = None;
                        ws.open(target, Open::KEEP, cx);
                    }
                })
                .ok();
        });
        let book = self.book.clone();
        let marks: dr_view_review::v3_panel::Marks =
            Rc::new(move |target| v3_review_target(target.clone()).map(|t| book.mark(&t).0));

        let ensured = dr_view_review::v3_panel::ensure(
            &self.review_id,
            &self.book_id,
            None,
            locale,
            platform,
            open,
            marks,
            cx,
        );
        let changed = match (&self.review, &ensured) {
            (Some(a), Some(b)) => a != b,
            (None, None) => false,
            _ => true,
        };
        if changed {
            self._review_sub = ensured
                .as_ref()
                .map(|rv| cx.observe(rv, |_, _, cx| cx.notify()));
            self.review = ensured;
        }
    }

    fn bind_library_events(&mut self, cx: &mut Context<Self>) {
        self._lib_sub = None;
        if crate::is_frozen(cx) {
            return;
        }
        let Some(lib) = &self.lib else { return };
        let watched = self.book_id.clone();
        if watched.is_empty() {
            return;
        }
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        self._lib_sub = Some(lib.subscribe(move |ev| {
            // Relations and entry links are the book's content; a writing
            // day or a saved checkpoint changes none of them.
            if matches!(ev, WsEvent::Book(b) if b.book.as_str() == watched) {
                let _ = tx.unbounded_send(());
            }
        }));
        cx.spawn(async move |view, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if view
                    .update(cx, |this, cx| {
                        this.entry_links_cache.clear();
                        this.entry_links_loading.clear();
                        this.reload_relations(cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    pub(crate) fn reload_relations(&mut self, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) || self.book_id.is_empty() || self.book.v3().is_none() {
            self.linked_materials.clear();
            self.entry_related_materials = None;
            self.mat_state_rev += 1;
            self.relations_loaded = false;
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        self.rel_serial += 1;
        let serial = self.rel_serial;
        let book = self.book_id.clone();
        let selected = self.selected_entry.clone();
        let task = cx.background_executor().spawn(async move {
            dr_view_material::v3::shelf_relations(&lib, &book, selected.as_deref())
        });

        let expected_book = self.book_id.clone();
        self.rel_task = Some(cx.spawn(async move |view, cx| {
            let res: dr_workspace::Result<(HashSet<String>, Option<HashSet<String>>)> = task.await;
            view.update(cx, |this, cx| {
                if this.book_id != expected_book || this.rel_serial != serial {
                    return;
                }
                this.rel_task = None;
                match res {
                    Ok((linked, entry_related)) => {
                        this.linked_materials = linked;
                        this.entry_related_materials = entry_related;
                        this.mat_state_rev += 1;
                        this.relations_loaded = true;
                    }
                    Err(e) => {
                        log::warn!("shelf-review: relation load failed: {e}");
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub(crate) fn ensure_entry_links(&mut self, material_id: &str, cx: &mut Context<Self>) {
        if crate::is_frozen(cx)
            || self.entry_links_cache.contains_key(material_id)
            || !self.entry_links_loading.insert(material_id.to_owned())
        {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            self.entry_links_loading.remove(material_id);
            return;
        };
        let book = self.book_id.clone();
        let mat_id = material_id.to_owned();
        let mat_for_task = mat_id.clone();
        let expected_book = book.clone();
        cx.spawn(async move |view, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { dr_view_material::v3::entry_links(&lib, &book, &mat_for_task) })
                .await;
            view.update(cx, |this, cx| {
                this.entry_links_loading.remove(&mat_id);
                if this.book_id != expected_book {
                    return;
                }
                if let Ok(links) = res {
                    this.entry_links_cache.insert(mat_id, links);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn spawn_tracked_write<T, F>(
        &mut self,
        work: F,
        on_done: impl FnOnce(&mut Self, Result<T, String>, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) where
        T: Send + 'static,
        F: FnOnce(Library) -> Result<T, String> + Send + 'static,
    {
        if crate::is_frozen(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else { return };
        let Some(owner) = self.owner.clone() else {
            return;
        };
        self.in_flight_writes.retain(|rx| rx.peek().is_none());
        let (done_tx, done_rx) = futures::channel::oneshot::channel();
        self.in_flight_writes.push(done_rx.shared());

        cx.spawn(async move |view, cx| {
            let out = cx
                .background_executor()
                .spawn(async move {
                    let res = work(lib);
                    let _ = done_tx.send(());
                    res
                })
                .await;
            view.update(cx, |this, cx| {
                this.in_flight_writes.retain(|rx| rx.peek().is_none());
                if this.owner.as_ref() != Some(&owner) {
                    return;
                }
                on_done(this, out, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn create_floating_comment(
        &mut self,
        kind: &'static str,
        body: String,
        cx: &mut Context<Self>,
    ) {
        let book = self.book_id.clone();
        self.spawn_tracked_write(
            move |lib| {
                lib.run::<CommentCreate>(
                    &Actor::User,
                    CommentCreateIn {
                        book,
                        module: None,
                        kind: Some(kind.to_owned()),
                        target: None,
                        block_id: None,
                        range: None,
                        anchor: None,
                        region: None,
                        body,
                        priority: None,
                        author_name: None,
                    },
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            },
            |this, res, cx| match res {
                Ok(()) => {
                    this.dialog = None;
                    if let Some(rv) = &this.review {
                        rv.update(cx, |r, cx| r.reload_now(cx));
                    }
                }
                Err(err) => {
                    if let Some(ActiveDialog::ComposeComment { busy, error, .. }) = &mut this.dialog
                    {
                        *busy = false;
                        *error = Some(err.into());
                    }
                }
            },
            cx,
        );
    }

    pub(crate) fn create_text_material(&mut self, title: String, cx: &mut Context<Self>) {
        let book = self.book_id.clone();
        self.spawn_tracked_write(
            move |lib| {
                lib.run::<MaterialCreate>(
                    &Actor::User,
                    MaterialCreateIn {
                        book,
                        kind: "text".into(),
                        title,
                        asset: None,
                        folder: None,
                        place: None,
                        description: String::new(),
                        text: None,
                    },
                )
                .map(|r| r.output.id)
                .map_err(|e| e.to_string())
            },
            |this, res, cx| match res {
                Ok(_id) => {
                    this.dialog = None;
                    this.reload_relations(cx);
                }
                Err(err) => {
                    if let Some(ActiveDialog::NewNote { busy, error, .. }) = &mut this.dialog {
                        *busy = false;
                        *error = Some(err.into());
                    }
                }
            },
            cx,
        );
    }

    pub(crate) fn confirm_delete_material(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(ActiveDialog::DeleteMaterial { busy, error, .. }) = &mut self.dialog {
            if *busy {
                return;
            }
            *busy = true;
            *error = None;
        }
        let book = self.book_id.clone();
        let sel = Selection::material(&id);
        let removed_id = id;
        self.spawn_tracked_write(
            move |lib| dr_view_material::folders::delete(&lib, &book, &sel),
            move |this, res, cx| match res {
                Ok(()) => {
                    this.dialog = None;
                    this.entry_links_cache.remove(&removed_id);
                    this.reload_relations(cx);
                }
                Err(err) => {
                    if let Some(ActiveDialog::DeleteMaterial { busy, error, .. }) = &mut this.dialog
                    {
                        *busy = false;
                        *error = Some(err.into());
                    }
                }
            },
            cx,
        );
    }

    pub fn toggle_material_entry_link(
        &mut self,
        material_id: &str,
        entry_id: &str,
        linked: bool,
        cx: &mut Context<Self>,
    ) {
        let book = self.book_id.clone();
        let mat = material_id.to_owned();
        let mat_done = mat.clone();
        let entry = entry_id.to_owned();
        self.spawn_tracked_write(
            move |lib| {
                lib.run::<SetEntryLink>(
                    &Actor::User,
                    SetEntryLinkIn {
                        book,
                        material: mat,
                        entry,
                        linked,
                    },
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            },
            move |this, res, cx| {
                if res.is_ok() {
                    this.entry_links_cache.remove(&mat_done);
                    this.reload_relations(cx);
                    if let Some(rv) = &this.review {
                        rv.update(cx, |r, cx| r.reload_now(cx));
                    }
                }
            },
            cx,
        );
    }

    pub fn move_material_to_folder(
        &mut self,
        material_id: &str,
        folder: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let book = self.book_id.clone();
        let sel = Selection::material(material_id);
        self.spawn_tracked_write(
            move |lib| dr_view_material::folders::move_to(&lib, &book, &sel, folder.as_deref()),
            |_, _, _| {},
            cx,
        );
    }

    pub(crate) fn import_external_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() || crate::is_frozen(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else { return };
        let Some(owner) = self.owner.clone() else {
            return;
        };
        let book = self.book_id.clone();
        self.in_flight_writes.retain(|rx| rx.peek().is_none());
        let (done_tx, done_rx) = futures::channel::oneshot::channel();
        self.in_flight_writes.push(done_rx.shared());

        self.import_task = Some(cx.spawn(async move |view, cx| {
            let outcome = cx
                .background_executor()
                .spawn(async move {
                    let out = dr_view_material::import::import_paths(&lib, &book, None, &paths);
                    let _ = done_tx.send(());
                    out
                })
                .await;
            view.update(cx, |this, cx| {
                this.in_flight_writes.retain(|rx| rx.peek().is_none());
                this.import_task = None;
                if this.owner.as_ref() != Some(&owner) {
                    return;
                }
                if !outcome.imported.is_empty() {
                    this.reload_relations(cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn open_material(&mut self, id: &str, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        let Ok(mat_id) = id.parse() else { return };
        let target = Target::Material(mat_id);
        let Some(owner) = self.owner.clone() else {
            return;
        };
        let ws_weak = self.ws.clone();
        cx.spawn(async move |_, cx| {
            ws_weak
                .update(cx, |ws, cx| {
                    if owner.matches(ws) && ws.book.exists(&target) {
                        ws.super_view = None;
                        ws.open(target, Open::KEEP, cx);
                    }
                })
                .ok();
        })
        .detach();
    }

    pub(crate) fn open_material_in_system(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(lib) = &self.lib else { return };
        if let Ok(path) = dr_view_material::menu::source_path(lib, &self.book_id, id) {
            cx.open_with_system(&path);
        }
    }

    pub fn reopen_review_item(&mut self, id: &str, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        if let Some(rv) = &self.review {
            rv.update(cx, |r, cx| r.set_done(id, false, cx));
        }
    }

    pub fn delete_review_item(&mut self, id: &str, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        if let Some(rv) = &self.review {
            rv.update(cx, |r, cx| r.delete(id, cx));
        }
    }

    pub(crate) fn prepare_release(
        &mut self,
        cx: &mut Context<Self>,
    ) -> (
        Vec<futures::future::Shared<futures::channel::oneshot::Receiver<()>>>,
        Option<LocalBoxFuture<'static, ()>>,
    ) {
        self.dialog = None;
        self.entry_menu_open = false;
        self.add_menu_open = false;
        let own: Vec<_> = self
            .in_flight_writes
            .iter()
            .filter(|rx| rx.peek().is_none())
            .cloned()
            .collect();
        let review_drain = self.review.as_ref().map(|rv| rv.read(cx).drain_writes());
        (own, review_drain)
    }

    pub(crate) fn drop_library_handles(&mut self, cx: &mut Context<Self>) {
        self._lib_sub = None;
        self.rel_task = None;
        self.import_task = None;
        self._review_sub = None;
        self.review = None;
        self.lib = None;
        self.owner = None;
        cx.notify();
    }

    pub(crate) fn rebind_library(&mut self, lib: Option<Library>, cx: &mut Context<Self>) {
        self.lib = lib;
        self.owner = Owner::of(&self.book_id, &self.book, self.lib.as_ref());
        self.bind_library_events(cx);
        self.bind_review(cx);
        self.reload_relations(cx);
        if let Some(ws) = self.ws.upgrade() {
            self.sync_from_workspace(ws, cx);
        }
        cx.notify();
    }

    fn render_todo_rail(
        &self,
        width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let entity = cx.entity();

        let cached_rev = self.review_snapshot(cx);
        let rows = cached_rev.todo_rows;
        let keys = cached_rev.todo_keys;
        let count = cached_rev.open_todos;

        let new_ent = entity.clone();
        let header = div()
            .flex_none()
            .min_h(px(40.0))
            .px(px(12.0))
            .py(px(6.0))
            .border_b(px(0.5))
            .border_color(p.subtle_hairline())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(
                div()
                    .font_role(Role::Structure)
                    .type_px(s.secondary, s.line_body)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(1).solid())
                    .child(t(cx, keys::review_panel::filters::TODO)),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(count.to_string()),
            )
            .child(div().flex_1())
            .child(
                PanelIconButton::new("shelf-new-todo-btn", Icon::ChecklistPlus)
                    .label(t(cx, keys::memo_material::dialog::NEW_TODO))
                    .on_click(move |_, window, cx| {
                        new_ent.update(cx, |this, cx| this.open_new_todo_dialog(window, cx));
                    }),
            );

        let body = if rows.is_empty() {
            sync_list_state(&self.todo_list, &self.todo_list_sig, &keys, width as i32);
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.0))
                .child(
                    EmptyState::new(
                        "shelf-todos-empty",
                        t(cx, keys::memo_material::super_::TODO_EMPTY_HINT),
                    )
                    .icon(Icon::Checklist),
                )
                .into_any_element()
        } else {
            sync_list_state(&self.todo_list, &self.todo_list_sig, &keys, width as i32);
            let weak = cx.weak_entity();
            let rv_opt = self.review.clone();
            div()
                .id("shelf-todos-scroll")
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .child(
                    list(self.todo_list.clone(), move |ix, window, cx| {
                        let Some(row) = rows.get(ix) else {
                            return div().into_any_element();
                        };
                        match row {
                            RailRow::Header {
                                first,
                                mark,
                                title,
                                jump,
                            } => {
                                let label = weak
                                    .upgrade()
                                    .map(|ent| {
                                        ent.update(cx, |this, cx| {
                                            this.render_group_label(
                                                "todo",
                                                *mark,
                                                title.clone(),
                                                jump.clone(),
                                                window,
                                                cx,
                                            )
                                        })
                                    })
                                    .unwrap_or_else(|| div().into_any_element());
                                div()
                                    .px(px(10.0))
                                    .pt(px(if *first { 10.0 } else { 12.0 }))
                                    .pb(px(6.0))
                                    .child(label)
                                    .into_any_element()
                            }
                            RailRow::Card { item, bottom_pad } => {
                                let card = rv_opt
                                    .as_ref()
                                    .map(|rv| {
                                        rv.update(cx, |r, cx| {
                                            r.render_card(item, false, window, cx)
                                        })
                                    })
                                    .unwrap_or_else(|| div().into_any_element());
                                div()
                                    .px(px(10.0))
                                    .pb(px(*bottom_pad))
                                    .child(card)
                                    .into_any_element()
                            }
                        }
                    })
                    .size_full(),
                )
                .into_any_element()
        };

        let down_ent = entity.clone();
        let key_ent = entity.clone();
        let resize_handle = div()
            .id("shelf-review-resize-todos")
            .track_focus(&self.todo_resize_focus)
            .role(gpui::Role::Button)
            .aria_label(t(cx, keys::memo_material::super_::RESIZE_TODOS))
            .absolute()
            .top_0()
            .bottom_0()
            .right(px(-3.0))
            .w(px(6.0))
            .cursor_col_resize()
            .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, _, cx| {
                down_ent.update(cx, |this, _| {
                    this.rail_drag_start = Some((Rail::Todos, f32::from(e.position.x), width));
                });
            })
            .on_drag(RailResizeDrag(Rail::Todos), |_, _, _, cx| {
                cx.new(|_| EmptyDragGhost)
            })
            .on_key_down(
                move |e: &KeyDownEvent, _, cx| match e.keystroke.key.as_str() {
                    "left" => {
                        key_ent.update(cx, |this, cx| {
                            this.resize_rail(Rail::Todos, width - RAIL_KEY_STEP, None, cx);
                        });
                    }
                    "right" => {
                        key_ent.update(cx, |this, cx| {
                            this.resize_rail(Rail::Todos, width + RAIL_KEY_STEP, None, cx);
                        });
                    }
                    _ => {}
                },
            );

        div()
            .id("shelf-review-todos-rail")
            .relative()
            .flex_none()
            .w(px(width))
            .h_full()
            .border_r(px(0.5))
            .border_color(p.hairline())
            .flex()
            .flex_col()
            .child(header)
            .child(body)
            .child(resize_handle)
            .into_any_element()
    }

    fn render_comment_rail(
        &self,
        width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let entity = cx.entity();

        let cached_rev = self.review_snapshot(cx);
        let rows = cached_rev.comment_rows;
        let keys = cached_rev.comment_keys;
        let count = cached_rev.open_comments;

        let new_ent = entity.clone();
        let header = div()
            .flex_none()
            .min_h(px(40.0))
            .px(px(12.0))
            .py(px(6.0))
            .border_b(px(0.5))
            .border_color(p.subtle_hairline())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(
                div()
                    .font_role(Role::Structure)
                    .type_px(s.secondary, s.line_body)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(1).solid())
                    .child(t(cx, keys::memo_material::super_::COMMENTS)),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(count.to_string()),
            )
            .child(div().flex_1())
            .child(
                PanelIconButton::new("shelf-new-comment-btn", Icon::CommentPlus)
                    .label(t(cx, keys::review_panel::NEW_COMMENT))
                    .on_click(move |_, window, cx| {
                        new_ent.update(cx, |this, cx| this.open_new_comment_dialog(window, cx));
                    }),
            );

        let body = if rows.is_empty() {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.0))
                .child(
                    EmptyState::new(
                        "shelf-comments-empty",
                        t(cx, keys::memo_material::super_::COMMENT_EMPTY_HINT),
                    )
                    .icon(Icon::Comment),
                )
                .into_any_element()
        } else {
            sync_list_state(
                &self.comment_list,
                &self.comment_list_sig,
                &keys,
                width as i32,
            );
            let weak = cx.weak_entity();
            let rv_opt = self.review.clone();
            div()
                .id("shelf-comments-scroll")
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .child(
                    list(self.comment_list.clone(), move |ix, window, cx| {
                        let Some(row) = rows.get(ix) else {
                            return div().into_any_element();
                        };
                        match row {
                            RailRow::Header {
                                first,
                                mark,
                                title,
                                jump,
                            } => {
                                let label = weak
                                    .upgrade()
                                    .map(|ent| {
                                        ent.update(cx, |this, cx| {
                                            this.render_group_label(
                                                "comment",
                                                *mark,
                                                title.clone(),
                                                jump.clone(),
                                                window,
                                                cx,
                                            )
                                        })
                                    })
                                    .unwrap_or_else(|| div().into_any_element());
                                div()
                                    .px(px(10.0))
                                    .pt(px(if *first { 10.0 } else { 12.0 }))
                                    .pb(px(6.0))
                                    .child(label)
                                    .into_any_element()
                            }
                            RailRow::Card { item, bottom_pad } => {
                                let card = rv_opt
                                    .as_ref()
                                    .map(|rv| {
                                        rv.update(cx, |r, cx| {
                                            r.render_card(item, false, window, cx)
                                        })
                                    })
                                    .unwrap_or_else(|| div().into_any_element());
                                div()
                                    .px(px(10.0))
                                    .pb(px(*bottom_pad))
                                    .child(card)
                                    .into_any_element()
                            }
                        }
                    })
                    .size_full(),
                )
                .into_any_element()
        };

        let down_ent = entity.clone();
        let key_ent = entity.clone();
        let resize_handle = div()
            .id("shelf-review-resize-comments")
            .track_focus(&self.comment_resize_focus)
            .role(gpui::Role::Button)
            .aria_label(t(cx, keys::memo_material::super_::RESIZE_COMMENTS))
            .absolute()
            .top_0()
            .bottom_0()
            .right(px(-3.0))
            .w(px(6.0))
            .cursor_col_resize()
            .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, _, cx| {
                down_ent.update(cx, |this, _| {
                    this.rail_drag_start = Some((Rail::Comments, f32::from(e.position.x), width));
                });
            })
            .on_drag(RailResizeDrag(Rail::Comments), |_, _, _, cx| {
                cx.new(|_| EmptyDragGhost)
            })
            .on_key_down(
                move |e: &KeyDownEvent, _, cx| match e.keystroke.key.as_str() {
                    "left" => {
                        key_ent.update(cx, |this, cx| {
                            this.resize_rail(Rail::Comments, width - RAIL_KEY_STEP, None, cx);
                        });
                    }
                    "right" => {
                        key_ent.update(cx, |this, cx| {
                            this.resize_rail(Rail::Comments, width + RAIL_KEY_STEP, None, cx);
                        });
                    }
                    _ => {}
                },
            );

        div()
            .id("shelf-review-comments-rail")
            .relative()
            .flex_none()
            .w(px(width))
            .h_full()
            .border_r(px(0.5))
            .border_color(p.hairline())
            .flex()
            .flex_col()
            .child(header)
            .child(body)
            .child(resize_handle)
            .into_any_element()
    }

    fn render_group_label(
        &self,
        prefix: &'static str,
        mark: Option<dr_ui::sand::Kind>,
        title: SharedString,
        jump: Option<dr_view_review::v3::Target>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let nav_target = jump.and_then(v3_review_target);
        let owner = self.owner.clone();
        let ws_weak = self.ws.clone();
        let id = SharedString::from(format!("shelf-group-{prefix}-{title}"));

        let mut row = div()
            .id(id.clone())
            .px(px(4.0))
            .py(px(2.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .font_role(Role::Structure)
            .type_px(s.caption, s.line_caption)
            .weight(weight::MEDIUM)
            .text_color(p.ink(3).solid());

        if let Some(kind) = mark {
            row =
                row.child(KindMark::new(SharedString::from(format!("{id}-mark")), kind).scale(0.9));
        }
        row = row.child(div().flex_1().min_w_0().truncate().child(title));
        if let Some(target) = nav_target {
            row = row.cursor_pointer().on_click(move |_, _, cx| {
                let Some(owner) = owner.clone() else { return };
                let target = target.clone();
                ws_weak
                    .update(cx, |ws, cx| {
                        if owner.matches(ws) && ws.book.exists(&target) {
                            ws.super_view = None;
                            ws.open(target, Open::KEEP, cx);
                        }
                    })
                    .ok();
            });
        }
        row.into_any_element()
    }
}

impl Render for ShelfReviewView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let entity = cx.entity();

        let cw = self.container_width();
        let ch = self.container_height();
        let (todo_w, comment_w) = self.memory.resolve_widths(cw);
        let mat_w = cw
            .map(|w| (w - todo_w - comment_w).max(crate::model::LIBRARY_MIN_WIDTH))
            .unwrap_or(720.0);

        let bounds_cell = self.stage_bounds.clone();
        let probe = canvas(
            |_, _, _| (),
            move |bounds, _, _, _| {
                bounds_cell.set(Some(bounds));
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let rail_move_ent = entity.clone();
        let drawer_move_ent = entity.clone();

        div()
            .id("shelf-review-stage")
            .relative()
            .size_full()
            .bg(p.page.solid())
            .flex()
            .flex_col()
            .on_drag_move::<RailResizeDrag>(move |e: &DragMoveEvent<RailResizeDrag>, _, cx| {
                let rail = e.drag(cx).0;
                let cur_x = f32::from(e.event.position.x);
                rail_move_ent.update(cx, |this, cx| {
                    if let Some((active, start_x, start_w)) = this.rail_drag_start
                        && active == rail
                    {
                        this.resize_rail(rail, start_w + (cur_x - start_x), None, cx);
                    }
                });
            })
            .on_drag_move::<DrawerResizeDrag>(move |e: &DragMoveEvent<DrawerResizeDrag>, _, cx| {
                let cur_y = f32::from(e.event.position.y);
                drawer_move_ent.update(cx, |this, cx| {
                    if let Some((start_y, start_h)) = this.drawer_drag_start {
                        this.resize_drawer(start_h + (start_y - cur_y), None, cx);
                    }
                });
            })
            .child(probe)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .flex()
                    .flex_row()
                    .child(self.render_todo_rail(todo_w, window, cx))
                    .child(self.render_comment_rail(comment_w, window, cx))
                    .child(self.render_material_shelf(mat_w, window, cx)),
            )
            .child(self.render_bottom_drawer(ch, window, cx))
            .children(self.render_dialog(window, cx))
    }
}
