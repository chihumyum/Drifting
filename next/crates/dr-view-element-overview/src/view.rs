//! Main canvas, header slots, and state machine for M22 Element Overview (`ElementOverview`).

mod island;
mod relations;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_i18n::keys;
use dr_i18n::keys::super_element as k_se;
use dr_i18n::keys::super_element::empty as k_empty;
use dr_i18n::keys::super_element::isles as k_isles;
use dr_i18n::keys::super_element::layout as k_layout;
use dr_i18n::keys::super_element::relate as k_relate;
use dr_model::id::EntryId;
use dr_shell::Workspace;
use dr_shell::book::{Book, color_of};
use dr_shell::nav::{Open, Target};
use dr_shell::pages::{PageViewHost, SuperViewHost};
use dr_shell::strings::{t, tf};
use dr_ui::Theme;
use dr_ui::components::{Button, Segmented};
use dr_ui::input::field::{FieldEvent, TextField};
use dr_ui::sand::{Icon, KindMark};
use dr_ui::tokens::{Rgb, radius};
use dr_view_elements::data::v3 as g2_data;
use dr_view_elements::dialogs::v3::{EntryMode, open_entry};
use dr_workspace::commands::BookIn;
use dr_workspace::commands::v3::content::{RelationTypeInfo, RelationTypes};
use dr_workspace::commands::v3::relations::{List as RelationList, ListIn as RelationListIn};
use dr_workspace::dto::RelationInfo;
use dr_workspace::{Actor, EntryCooccurrenceGraph, Workspace as Library};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, AppContext as _, Bounds, Canvas, Context, DragMoveEvent, ElementId, Entity,
    InteractiveElement, IntoElement, MouseButton, MouseDownEvent, ParentElement, PathBuilder,
    Pixels, Point, Render, ScrollDelta, ScrollEvent, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Task, WeakEntity, Window, canvas, div, point, px,
};
use serde_json::json;

use crate::isles::{
    CELL_H, CELL_W, ElementCenter, ISLAND_GAP_X, IslandItem, IslandModel, IslePair, IslesLod,
    LayoutBounds, LayoutInput, LayoutPlacement, ZOOM_MAX, ZOOM_MIN, card_col_step,
    compute_element_centers, extract_v3_islands, isle_mark_weight, isle_neighbours, isle_pairs,
    isles_lod, major_element_ids, solve_super_element_layout,
};
use crate::relate::{
    ElementLayoutMode, MEMORY_KEY, OverviewMemory, RELATE_DRAG_ALPHA, RELATE_LABEL_BUDGET,
    RELATE_MOVE_MS, RelateNodeInput, RelatePoint, RelateSimulationInput, RelateSpring, SpringKind,
    create_relate_simulation, parse_overview_memory, relate_bounds, relate_cell_half, relate_ease,
    relate_positions, relate_spring_signature, serialize_overview_memory, settle_relate,
};

pub use island::{IslandEditorSheet, IslandMode, IslandSubject, SheetResizeDrag};
pub use relations::{PendingLink, RelateEdgeView, TypeManagerState};

const CANVAS_FIT_LEFT: f32 = 24.0;
const CANVAS_FIT_RIGHT: f32 = 180.0;

#[derive(Clone)]
pub struct ElementCarryDrag {
    pub element_id: String,
    pub element_name: String,
    pub color: Option<Rgb>,
    pub from_island_id: String,
    pub mode: ElementLayoutMode,
    pub origin_world: RelatePoint,
}

impl Render for ElementCarryDrag {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        let mark_color = self.color.unwrap_or_else(|| p.ink(2));
        div()
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(radius::SM))
            .bg(p.paper.solid())
            .border_1()
            .border_color(p.hairline())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(
                KindMark::new("se-carry-drag-mark", dr_ui::sand::Kind::Element)
                    .color(mark_color)
                    .scale(12.0 / 14.0),
            )
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(p.ink(1).solid())
                    .child(SharedString::from(self.element_name.clone())),
            )
    }
}

pub struct OverviewHeadStart {
    overview: WeakEntity<ElementOverview>,
}

impl OverviewHeadStart {
    pub fn new(overview: WeakEntity<ElementOverview>) -> Self {
        Self { overview }
    }
}

impl Render for OverviewHeadStart {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        let Some(ov) = self.overview.upgrade() else {
            return div().into_any_element();
        };
        let state = ov.read(cx);
        let mode = state.layout_mode;
        let categories_count = state
            .island_models
            .iter()
            .filter(|m| !m.is_uncategorized)
            .count();
        let elements_count = state.elements.len();
        let meta_label = tf(
            cx,
            k_se::META,
            &[
                ("categories", &categories_count),
                ("elements", &elements_count),
            ],
        );
        let labels = vec![t(cx, k_layout::ISLES), t(cx, k_layout::RELATE)];
        let selected_idx = match mode {
            ElementLayoutMode::Isles => 0,
            ElementLayoutMode::Relate => 1,
        };
        let weak = self.overview.clone();
        let switcher = Segmented::new("se-layout-switch", labels, selected_idx).on_change(
            move |idx, window, cx| {
                let next = if idx == 0 {
                    ElementLayoutMode::Isles
                } else {
                    ElementLayoutMode::Relate
                };
                if let Some(ov) = weak.upgrade() {
                    ov.update(cx, |this, cx| {
                        this.set_layout_mode(next, window, cx);
                    });
                }
            },
        );

        div()
            .id("se-head-start")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .child(switcher)
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(p.ink(3).solid())
                    .child(meta_label),
            )
            .into_any_element()
    }
}

pub struct OverviewHeadEnd {
    overview: WeakEntity<ElementOverview>,
    search_field: Entity<TextField>,
    _subs: Vec<Subscription>,
}

impl OverviewHeadEnd {
    pub fn new(
        overview: WeakEntity<ElementOverview>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let hint = t(cx, k_isles::FIND);
        let search_field =
            cx.new(|cx| TextField::new("se-find-field", window, cx).placeholder(hint));
        let weak = overview.clone();
        let sub = cx.subscribe_in(&search_field, window, move |_, field, event, window, cx| {
            let Some(ov) = weak.upgrade() else {
                return;
            };
            match event {
                FieldEvent::Changed(text) => {
                    let q = text.to_string();
                    ov.update(cx, |this, cx| this.set_find_query(q, cx));
                }
                FieldEvent::Submitted(_) => {
                    ov.update(cx, |this, cx| this.fly_to_first_find_hit(window, cx));
                }
                FieldEvent::Cancelled => {
                    field.update(cx, |f, cx| f.set_text("", cx));
                    ov.update(cx, |this, cx| this.set_find_query(String::new(), cx));
                }
                FieldEvent::Blurred => {}
            }
        });
        Self {
            overview,
            search_field,
            _subs: vec![sub],
        }
    }
}

impl Render for OverviewHeadEnd {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        let Some(ov) = self.overview.upgrade() else {
            return div().into_any_element();
        };
        let state = ov.read(cx);
        let mode = state.layout_mode;
        let threshold = state.line_threshold;
        let link_source = state.link_source.clone();
        let link_label = link_source
            .as_ref()
            .map(|(k, id)| state.endpoint_label(k, id));

        let weak_thresh = self.overview.clone();
        let next_threshold = match threshold {
            1 => 2,
            2 => 3,
            3 => 5,
            _ => 1,
        };
        let thresh_text = format!(
            "{} {}",
            t(cx, k_isles::THRESHOLD_LABEL),
            tf(cx, k_isles::AT_LEAST, &[("count", &threshold)])
        );
        let thresh_btn = Button::new("se-threshold-btn", SharedString::from(thresh_text))
            .text()
            .small()
            .on_click(move |_, _, cx| {
                if let Some(ov) = weak_thresh.upgrade() {
                    ov.update(cx, |this, cx| {
                        this.set_line_threshold(next_threshold, cx);
                    });
                }
            });

        let weak_relayout = self.overview.clone();
        let relayout_btn = (mode == ElementLayoutMode::Relate).then(|| {
            Button::new("se-relayout-btn", t(cx, k_relate::RELAYOUT))
                .text()
                .small()
                .icon(Icon::Rotate)
                .on_click(move |_, _, cx| {
                    if let Some(ov) = weak_relayout.upgrade() {
                        ov.update(cx, |this, cx| {
                            this.relayout_relate(cx);
                        });
                    }
                })
        });

        let weak_reset = self.overview.clone();
        let reset_btn = Button::new("se-reset-btn", t(cx, k_se::RESET))
            .text()
            .small()
            .icon(Icon::Locate)
            .on_click(move |_, _, cx| {
                if let Some(ov) = weak_reset.upgrade() {
                    ov.update(cx, |this, cx| {
                        this.reset_view(cx);
                    });
                }
            });

        div()
            .id("se-head-end")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .when_some(link_label, |el, src_name| {
                el.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .text_size(px(11.5))
                        .text_color(p.ink(2).solid())
                        .child(t(cx, k_se::LINK_HINT_FROM))
                        .child(
                            div()
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(p.ink(1).solid())
                                .child(SharedString::from(src_name)),
                        )
                        .child(t(cx, k_se::LINK_HINT_TO)),
                )
            })
            .child(
                div()
                    .w(px(148.0))
                    .h(px(26.0))
                    .px(px(8.0))
                    .rounded(px(radius::SM))
                    .border_1()
                    .border_color(p.hairline())
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(self.search_field.clone()),
            )
            .child(thresh_btn)
            .children(relayout_btn)
            .child(reset_btn)
            .into_any_element()
    }
}

pub struct ElementOverview {
    pub(crate) ws: WeakEntity<Workspace>,
    pub(crate) lib: Option<Library>,
    pub(crate) book_id: String,
    pub(crate) book: Rc<Book>,
    pub(crate) memory_loaded_for: Option<String>,

    // Layout mode & camera
    pub(crate) layout_mode: ElementLayoutMode,
    pub(crate) pan: Point<f32>,
    pub(crate) zoom: f32,
    pub(crate) viewport_bounds: Option<Bounds<Pixels>>,
    pub(crate) pan_drag: Option<(Point<Pixels>, Point<f32>)>,

    // Canonical v3 islands (`群岛`) & unique canvas elements
    pub(crate) island_models: Vec<IslandModel>,
    pub(crate) elements: Vec<IslandItem>,
    pub(crate) placements: Vec<LayoutPlacement>,
    pub(crate) layout_bounds: LayoutBounds,
    pub(crate) element_centers: HashMap<String, ElementCenter>,
    pub(crate) drop_island_id: Option<String>,

    // True v3 mentions & shared-paragraph co-occurrence sand lines
    pub(crate) cooccurrences: EntryCooccurrenceGraph,
    pub(crate) lines_on: bool,
    pub(crate) line_threshold: u32,
    pub(crate) find_query: String,

    // Force-directed relation layout (`关系`)
    pub(crate) relate_live: BTreeMap<String, RelatePoint>,
    pub(crate) relate_rest: Option<BTreeMap<String, RelatePoint>>,
    pub(crate) relate_signature: Option<String>,
    pub(crate) relate_moving: bool,
    pub(crate) _tween_task: Option<Task<()>>,

    // Focus & floating island (`SuperElementIsland`)
    pub(crate) isle_focus: Option<String>,
    pub(crate) isle_island: Option<String>,
    pub(crate) isolated: bool,
    pub(crate) island_mode: IslandMode,
    pub(crate) island_width_ratio: f32,
    pub(crate) island_sheet: Option<IslandEditorSheet>,

    // Canonical v3 relations, shared legend & linking
    pub(crate) relations: Vec<RelationInfo>,
    pub(crate) relation_types: Vec<RelationTypeInfo>,
    pub(crate) hidden_relation_type_ids: HashSet<String>,
    pub(crate) link_mode: bool,
    pub(crate) link_source: Option<(String, String)>,
    pub(crate) pending_link: Option<PendingLink>,
    pub(crate) selected_edge_id: Option<String>,
    pub(crate) type_manager: Option<TypeManagerState>,

    _subs: Vec<Subscription>,
}

impl ElementOverview {
    pub fn new(host: SuperViewHost, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let weak_self = cx.entity().downgrade();
        cx.default_global::<crate::Registry>().views.push(weak_self);

        let mut view = Self {
            ws: host.workspace.clone(),
            lib: host.library,
            book_id: host.book_id,
            book: host.book,
            memory_loaded_for: None,
            layout_mode: ElementLayoutMode::Relate,
            pan: point(480.0, 320.0),
            zoom: 0.9,
            viewport_bounds: None,
            pan_drag: None,
            island_models: Vec::new(),
            elements: Vec::new(),
            placements: Vec::new(),
            layout_bounds: LayoutBounds {
                min_x: 0,
                max_x: 0,
                min_y: 0,
                max_y: 1,
            },
            element_centers: HashMap::new(),
            drop_island_id: None,
            cooccurrences: EntryCooccurrenceGraph::default(),
            lines_on: true,
            line_threshold: 2,
            find_query: String::new(),
            relate_live: BTreeMap::new(),
            relate_rest: None,
            relate_signature: None,
            relate_moving: false,
            _tween_task: None,
            isle_focus: None,
            isle_island: None,
            isolated: false,
            island_mode: IslandMode::Peek,
            island_width_ratio: 0.38,
            island_sheet: None,
            relations: Vec::new(),
            relation_types: Vec::new(),
            hidden_relation_type_ids: HashSet::new(),
            link_mode: false,
            link_source: None,
            pending_link: None,
            selected_edge_id: None,
            type_manager: None,
            _subs: Vec::new(),
        };

        view.reload_all_headless(cx);
        view.reset_view(cx);

        // SuperView construction happens inside `Workspace::render`, so never borrow
        // `host.workspace` synchronously here; attach observation in a microtask.
        let ws_weak = host.workspace;
        cx.spawn(async move |this, cx| {
            let _ = this.update(cx, |v, cx| {
                if let Some(ws) = ws_weak.upgrade() {
                    let sub = cx.observe(&ws, |this, ws, cx| {
                        this.sync_from_workspace(ws, cx);
                    });
                    v._subs.push(sub);
                    v.sync_from_workspace(ws, cx);
                }
            });
        })
        .detach();

        view
    }

    pub(crate) fn drop_library_handles(&mut self, cx: &mut Context<Self>) {
        self._tween_task = None;
        self.island_sheet = None;
        self.pending_link = None;
        self.type_manager = None;
        self.lib = None;
        cx.notify();
    }

    pub(crate) fn rebind_library(&mut self, lib: Option<Library>, cx: &mut Context<Self>) {
        self.lib = lib;
        if let Some(ws) = self.ws.upgrade() {
            self.sync_from_workspace(ws, cx);
        } else {
            self.reload_all_headless(cx);
            cx.notify();
        }
        if self.island_mode == IslandMode::Sheet
            && self.island_sheet.is_none()
            && let Some(entry_id) = self.subject_entry_id()
            && let Some(host) = self.make_page_host()
        {
            self.island_sheet = IslandEditorSheet::new(entry_id, host, cx);
            cx.notify();
        }
    }

    pub(crate) fn sync_from_workspace(&mut self, ws: Entity<Workspace>, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        let (book_id, book, lib, mem_ready, raw_mem) = {
            let w = ws.read(cx);
            (
                w.book_id.clone(),
                w.book.clone(),
                w.library.clone(),
                w.book_memory_ready(),
                w.book_memory(MEMORY_KEY).cloned(),
            )
        };

        let id_changed = self.book_id != book_id;
        let snap_changed = !Rc::ptr_eq(&self.book, &book);
        if lib.is_some() {
            self.lib = lib;
        }

        if id_changed {
            self.book_id = book_id;
            self.book = book;
            self.memory_loaded_for = None;
            self.close_island(cx);
            self.reload_all_headless(cx);
            self.reset_view(cx);
        } else if snap_changed {
            self.book = book;
            if let Some(sheet) = &self.island_sheet {
                sheet.refresh(self.book.clone(), cx);
            }
            self.reload_all_headless(cx);
        } else {
            self.reload_relations_and_cooccurrences();
            self.ensure_relate_settled(false, cx);
        }

        if mem_ready && self.memory_loaded_for.as_deref() != Some(self.book_id.as_str()) {
            self.memory_loaded_for = Some(self.book_id.clone());
            let parsed = parse_overview_memory(raw_mem.as_ref());
            let pins = self.author_pins();
            let had_positions = parsed.positions.is_some();
            if let Some(mut stored_pos) = parsed.positions {
                for (pid, pt) in &pins {
                    stored_pos.insert(pid.clone(), *pt);
                }
                if parsed.signature.is_some() && parsed.signature == self.relate_signature {
                    self.relate_live = stored_pos.clone();
                    self.relate_rest = Some(stored_pos);
                }
            }
            if parsed.mode != self.layout_mode {
                self.layout_mode = parsed.mode;
                self.reset_view(cx);
            } else if had_positions {
                self.reset_view(cx);
            }
        }
        cx.notify();
    }

    pub fn layout_mode(&self) -> ElementLayoutMode {
        self.layout_mode
    }

    pub fn is_ready(&self) -> bool {
        !self.book_id.is_empty() && self.memory_loaded_for.as_deref() == Some(self.book_id.as_str())
    }

    pub fn focused_element(&self) -> Option<&str> {
        self.isle_focus.as_deref()
    }

    pub fn focused_island(&self) -> Option<&str> {
        self.isle_island.as_deref()
    }

    pub fn isolated(&self) -> bool {
        self.isolated
    }

    pub fn island_mode(&self) -> IslandMode {
        self.island_mode
    }

    pub fn island_sheet_active(&self) -> bool {
        self.island_sheet.is_some()
    }

    pub fn relate_positions(&self) -> &BTreeMap<String, RelatePoint> {
        &self.relate_live
    }

    pub fn author_pins(&self) -> BTreeMap<String, RelatePoint> {
        self.elements
            .iter()
            .filter_map(|el| el.relation_pin.map(|pt| (el.id.clone(), pt)))
            .collect()
    }

    pub fn island_models(&self) -> &[IslandModel] {
        &self.island_models
    }

    pub fn elements(&self) -> &[IslandItem] {
        &self.elements
    }

    pub fn relations(&self) -> &[RelationInfo] {
        &self.relations
    }

    pub fn cooccurrences(&self) -> &EntryCooccurrenceGraph {
        &self.cooccurrences
    }

    pub fn reload_all(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.reload_all_headless(cx);
    }

    pub(crate) fn reload_all_headless(&mut self, cx: &mut Context<Self>) {
        let res_label = t(cx, keys::v3_levels::RESIDENTS).to_string();
        let mem_label = t(cx, keys::v3_levels::MEMBERS).to_string();
        let uncat_label = t(cx, k_se::UNCATEGORIZED).to_string();

        if let Some(v3) = self.book.v3() {
            let extracted = extract_v3_islands(v3, &res_label, &mem_label, &uncat_label);
            self.island_models = extracted.islands;
            self.elements = extracted.elements;
        } else {
            self.island_models.clear();
            self.elements.clear();
        }

        let inputs: Vec<LayoutInput> = self
            .island_models
            .iter()
            .map(|m| LayoutInput {
                id: m.island_id.clone(),
                width_cells: m.width_cells,
                height_cells: m.height_cells,
                pinned: None,
            })
            .collect();
        let solved = solve_super_element_layout(&inputs, 1);
        self.placements = solved.placements;
        self.layout_bounds = solved.bounds;
        self.element_centers = compute_element_centers(&self.island_models, &self.placements);

        // Drop focus if focused subject was trashed
        if let Some(eid) = &self.isle_focus
            && !self.elements.iter().any(|e| &e.id == eid)
        {
            self.close_island(cx);
        }
        if let Some(iid) = &self.isle_island
            && !self.island_models.iter().any(|m| &m.island_id == iid)
        {
            self.close_island(cx);
        }

        self.reload_relations_and_cooccurrences();
        self.ensure_relate_settled(false, cx);
    }

    pub(crate) fn reload_relations_and_cooccurrences(&mut self) {
        let Some(lib) = &self.lib else {
            return;
        };
        if self.book_id.is_empty() {
            return;
        };
        let me = &Actor::User;
        if let Ok(out) = lib.run::<RelationTypes>(
            me,
            BookIn {
                book: self.book_id.clone(),
            },
        ) {
            self.relation_types = out.output;
        }
        if let Ok(out) = lib.run::<RelationList>(
            me,
            RelationListIn {
                book: self.book_id.clone(),
                entity: None,
                relation_type: None,
            },
        ) {
            self.relations = out.output;
        }
        if let Ok(graph) = lib.entry_cooccurrences(&self.book_id) {
            self.cooccurrences = graph;
        }
    }

    pub(crate) fn present_element_ids(&self) -> HashSet<String> {
        self.elements.iter().map(|e| e.id.clone()).collect()
    }

    pub(crate) fn threshold_sand_pairs(&self) -> Vec<IslePair> {
        let present = self.present_element_ids();
        isle_pairs(&self.cooccurrences.pairs, self.line_threshold, &present)
    }

    pub(crate) fn active_sand_pairs(&self) -> Vec<IslePair> {
        if self.lines_on {
            self.threshold_sand_pairs()
        } else {
            Vec::new()
        }
    }

    pub(crate) fn relate_nodes_and_springs(&self) -> (Vec<RelateNodeInput>, Vec<RelateSpring>) {
        let nodes: Vec<RelateNodeInput> = self
            .elements
            .iter()
            .map(|el| {
                let anchor = self
                    .element_centers
                    .get(&el.id)
                    .map(|c| RelatePoint::new(f64::from(c.x), f64::from(c.y)))
                    .unwrap_or_else(|| RelatePoint::new(0.0, 0.0));
                RelateNodeInput {
                    id: el.id.clone(),
                    name: el.name.clone(),
                    anchor,
                }
            })
            .collect();

        let present = self.present_element_ids();
        let mut springs = Vec::new();
        for r in &self.relations {
            if r.from.kind != "entry"
                || r.to.kind != "entry"
                || self.hidden_relation_type_ids.contains(&r.relation_type)
            {
                continue;
            }
            if !present.contains(&r.from.id) || !present.contains(&r.to.id) {
                continue;
            }
            springs.push(RelateSpring {
                a: r.from.id.clone(),
                b: r.to.id.clone(),
                kind: SpringKind::Relation,
                roles: self.relate_roles_for(&r.relation_type),
                count: 0,
            });
        }
        for pair in self.active_sand_pairs() {
            springs.push(RelateSpring {
                a: pair.a,
                b: pair.b,
                kind: SpringKind::Prose,
                roles: Vec::new(),
                count: pair.count,
            });
        }
        (nodes, springs)
    }

    pub(crate) fn isle_starts(&self) -> BTreeMap<String, RelatePoint> {
        let mut out = BTreeMap::new();
        for el in &self.elements {
            if let Some(c) = self.element_centers.get(&el.id) {
                out.insert(
                    el.id.clone(),
                    RelatePoint::new(f64::from(c.x), f64::from(c.y)),
                );
            }
        }
        out
    }

    fn aspect_ratio(&self) -> f64 {
        if let Some(bounds) = self.viewport_bounds {
            let w = f32::from(bounds.size.width).max(1.0);
            let h = f32::from(bounds.size.height).max(1.0);
            f64::from(w / h)
        } else {
            1.6
        }
    }

    pub(crate) fn ensure_relate_settled(&mut self, force: bool, cx: &mut Context<Self>) {
        let (nodes, springs) = self.relate_nodes_and_springs();
        if nodes.is_empty() {
            self.relate_live.clear();
            self.relate_rest = None;
            return;
        }
        let pins = self.author_pins();
        let sig = relate_spring_signature(&nodes, &springs);
        let up_to_date = !force
            && self.relate_rest.is_some()
            && self.relate_signature.as_deref() == Some(sig.as_str())
            && nodes
                .iter()
                .all(|n| self.relate_rest.as_ref().unwrap().contains_key(&n.id));
        if up_to_date {
            if self.relate_live.is_empty()
                && let Some(rest) = &self.relate_rest
            {
                self.relate_live = rest.clone();
            }
            for (pid, pt) in &pins {
                self.relate_live.insert(pid.clone(), *pt);
            }
            return;
        }

        let first = self.relate_live.is_empty();
        let mut start = self.relate_live.clone();
        for (id, pt) in self.isle_starts() {
            start.entry(id).or_insert(pt);
        }
        for (pid, pt) in &pins {
            start.insert(pid.clone(), *pt);
        }
        let alpha = if force || first { 1.0 } else { 0.4 };
        let mut sim = create_relate_simulation(RelateSimulationInput {
            nodes: &nodes,
            springs: &springs,
            start: &start,
            pins: &pins,
            aspect: self.aspect_ratio(),
            alpha,
        });
        settle_relate(&mut sim);
        let settled = relate_positions(&sim);
        self.relate_live = settled.clone();
        self.relate_rest = Some(settled);
        self.relate_signature = Some(sig);
        self.relate_moving = false;
        self.persist_overview_memory(cx);
    }

    pub(crate) fn persist_overview_memory(&self, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        if self.memory_loaded_for.as_deref() != Some(self.book_id.as_str()) {
            return;
        }
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        let record = OverviewMemory {
            mode: self.layout_mode,
            positions: self.relate_rest.clone(),
            signature: self.relate_signature.clone(),
        };
        let value = serialize_overview_memory(&record);
        ws.update(cx, |w, cx| {
            w.set_book_memory(MEMORY_KEY, value, cx);
        });
    }

    pub fn set_layout_mode(
        &mut self,
        next: ElementLayoutMode,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.layout_mode == next {
            return;
        }
        self.selected_edge_id = None;
        let from_points = match self.layout_mode {
            ElementLayoutMode::Isles => self.isle_starts(),
            ElementLayoutMode::Relate => self.relate_live.clone(),
        };
        self.layout_mode = next;
        match next {
            ElementLayoutMode::Relate => {
                if let Some(remembered) = self.relate_rest.clone() {
                    let mut target = remembered;
                    for (id, pt) in self.isle_starts() {
                        target.entry(id).or_insert(pt);
                    }
                    for (pid, pt) in self.author_pins() {
                        target.insert(pid, pt);
                    }
                    self.tween_relate_positions(from_points, target.clone(), cx);
                    self.relate_live = target;
                } else {
                    self.ensure_relate_settled(true, cx);
                }
            }
            ElementLayoutMode::Isles => {
                let target = self.isle_starts();
                self.tween_relate_positions(from_points, target, cx);
            }
        }
        self.persist_overview_memory(cx);
        self.reset_view(cx);
        cx.notify();
    }

    fn tween_relate_positions(
        &mut self,
        from: BTreeMap<String, RelatePoint>,
        to: BTreeMap<String, RelatePoint>,
        cx: &mut Context<Self>,
    ) {
        self.relate_moving = true;
        let t0 = Instant::now();
        let total = Duration::from_millis(RELATE_MOVE_MS);
        self._tween_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let elapsed = t0.elapsed();
                let raw_t = (elapsed.as_secs_f32() / total.as_secs_f32()).min(1.0);
                let k = f64::from(relate_ease(raw_t));
                let done = raw_t >= 1.0;
                let ok = this
                    .update(cx, |view, cx| {
                        for (id, dst) in &to {
                            let src = from.get(id).copied().unwrap_or(*dst);
                            view.relate_live.insert(
                                id.clone(),
                                RelatePoint::new(
                                    src.x + (dst.x - src.x) * k,
                                    src.y + (dst.y - src.y) * k,
                                ),
                            );
                        }
                        if done {
                            view.relate_moving = false;
                        }
                        cx.notify();
                    })
                    .is_ok();
                if done || !ok {
                    break;
                }
            }
        }));
    }

    /// Re-runs force layout from island anchors while preserving author pins on `Entry.layout.relation_graph`.
    pub fn relayout_relate(&mut self, cx: &mut Context<Self>) {
        self._tween_task = None;
        let pins = self.author_pins();
        let mut fresh_start = self.isle_starts();
        for (pid, pt) in &pins {
            fresh_start.insert(pid.clone(), *pt);
        }
        self.relate_live = fresh_start;
        self.ensure_relate_settled(true, cx);
        self.reset_view(cx);
        cx.notify();
    }

    /// Pins `element_id` to `point` via guarded `entry.update` on `Entry.layout.relation_graph`,
    /// preserving `Entry.layout.board` and `Entry.layout.grid`.
    pub fn pin_element_in_relate(
        &mut self,
        element_id: &str,
        point: RelatePoint,
        cx: &mut Context<Self>,
    ) {
        if crate::is_frozen(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let Some(mut layout) = self
            .book
            .v3()
            .and_then(|v| v.entry(element_id))
            .map(|e| e.layout)
        else {
            return;
        };
        let rounded = (
            (point.x * 10.0).round() / 10.0,
            (point.y * 10.0).round() / 10.0,
        );
        layout.relation_graph = Some(rounded);
        match g2_data::prepare_edit(&self.book, element_id, json!({ "layout": layout }))
            .and_then(|m| m.commit(&lib))
        {
            Ok(_) => {
                self._tween_task = None;
                self.sync_workspace_book(cx);
                let pt = RelatePoint::new(rounded.0, rounded.1);
                self.relate_live.insert(element_id.to_owned(), pt);
                let pins = self.author_pins();
                let (nodes, springs) = self.relate_nodes_and_springs();
                let mut sim = create_relate_simulation(RelateSimulationInput {
                    nodes: &nodes,
                    springs: &springs,
                    start: &self.relate_live,
                    pins: &pins,
                    aspect: self.aspect_ratio(),
                    alpha: RELATE_DRAG_ALPHA,
                });
                settle_relate(&mut sim);
                let settled = relate_positions(&sim);
                self.relate_live = settled.clone();
                self.relate_rest = Some(settled);
                self.relate_signature = Some(relate_spring_signature(&nodes, &springs));
                self.persist_overview_memory(cx);
                cx.notify();
            }
            Err(err) => {
                log::warn!("failed to pin element {element_id} in relation_graph: {err}");
            }
        }
    }

    /// Clears `Entry.layout.relation_graph` for `element_id` while preserving `board` and `grid`.
    pub fn unpin_element_in_relate(&mut self, element_id: &str, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let Some(mut layout) = self
            .book
            .v3()
            .and_then(|v| v.entry(element_id))
            .map(|e| e.layout)
        else {
            return;
        };
        if layout.relation_graph.is_none() {
            return;
        }
        layout.relation_graph = None;
        if let Err(err) = g2_data::prepare_edit(&self.book, element_id, json!({ "layout": layout }))
            .and_then(|m| m.commit(&lib))
        {
            log::warn!("failed to unpin element {element_id}: {err}");
            return;
        }
        self.sync_workspace_book(cx);
        self.ensure_relate_settled(true, cx);
        cx.notify();
    }

    pub fn reset_view(&mut self, cx: &mut Context<Self>) {
        let (vw, vh) = self
            .viewport_bounds
            .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
            .unwrap_or((1080.0, 680.0));
        let room = (vw - CANVAS_FIT_LEFT - CANVAS_FIT_RIGHT).max(240.0);
        let avail_h = (vh - 96.0).max(200.0);

        match self.layout_mode {
            ElementLayoutMode::Isles => {
                let b = self.layout_bounds;
                let w = ((b.max_x - b.min_x).max(1) as f32) * CELL_W;
                let h = ((b.max_y - b.min_y).max(1) as f32) * CELL_H;
                let zoom = (room / w)
                    .min(avail_h / h)
                    .min(IslesLod::Mid.zoom())
                    .clamp(ZOOM_MIN, ZOOM_MAX);
                let cx_world = ((b.min_x + b.max_x) as f32 * 0.5) * CELL_W;
                let cy_world = ((b.min_y + b.max_y) as f32 * 0.5) * CELL_H;
                self.zoom = zoom;
                self.pan = point(
                    CANVAS_FIT_LEFT + room * 0.5 - cx_world * zoom,
                    vh * 0.5 - cy_world * zoom,
                );
            }
            ElementLayoutMode::Relate => {
                let names: HashMap<String, String> = self
                    .elements
                    .iter()
                    .map(|e| (e.id.clone(), e.name.clone()))
                    .collect();
                let b = relate_bounds(&self.relate_live, &names);
                let w = ((b.max_x - b.min_x) as f32).max(160.0);
                let h = ((b.max_y - b.min_y) as f32).max(120.0);
                let zoom = (room / w)
                    .min(avail_h / h)
                    .min(IslesLod::Mid.zoom())
                    .clamp(ZOOM_MIN, ZOOM_MAX);
                let cx_world = ((b.min_x + b.max_x) * 0.5) as f32;
                let cy_world = ((b.min_y + b.max_y) * 0.5) as f32;
                self.zoom = zoom;
                self.pan = point(
                    CANVAS_FIT_LEFT + room * 0.5 - cx_world * zoom,
                    vh * 0.5 - cy_world * zoom,
                );
            }
        }
        cx.notify();
    }

    pub(crate) fn make_page_host(&self) -> Option<PageViewHost> {
        let library = self.lib.clone()?;
        Some(PageViewHost {
            workspace: self.ws.clone(),
            library,
            book_id: self.book_id.clone(),
            book: self.book.clone(),
        })
    }

    pub fn focus_element(
        &mut self,
        id: Option<String>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.isle_focus = id.clone();
        self.isle_island = None;
        if id.is_none() {
            self.isolated = false;
            self.island_mode = IslandMode::Peek;
            self.island_sheet = None;
        } else if self.island_mode == IslandMode::Sheet
            && let Some(eid) = id
            && let Some(host) = self.make_page_host()
        {
            self.island_sheet = IslandEditorSheet::new(eid, host, cx);
        }
        cx.notify();
    }

    pub fn focus_island(
        &mut self,
        id: Option<String>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.isle_island = id.clone();
        self.isle_focus = None;
        self.isolated = false;
        if id.is_none() {
            self.island_mode = IslandMode::Peek;
            self.island_sheet = None;
        } else if self.island_mode == IslandMode::Sheet
            && let Some(iid) = id
        {
            let target_entry = self
                .island_models
                .iter()
                .find(|m| m.island_id == iid)
                .and_then(|m| m.creation_level_id.clone())
                .unwrap_or(iid);
            if let Some(host) = self.make_page_host() {
                self.island_sheet = IslandEditorSheet::new(target_entry, host, cx);
            }
        }
        cx.notify();
    }

    pub fn toggle_isolated(&mut self, cx: &mut Context<Self>) {
        self.isolated = !self.isolated;
        cx.notify();
    }

    pub fn grow_island(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if crate::is_frozen(cx) {
            return;
        }
        let Some(entry_id) = self.subject_entry_id() else {
            return;
        };
        let Some(host) = self.make_page_host() else {
            return;
        };
        if let Some(sheet) = IslandEditorSheet::new(entry_id, host, cx) {
            self.island_mode = IslandMode::Sheet;
            self.island_sheet = Some(sheet);
            cx.notify();
        }
    }

    pub fn collapse_island(&mut self, cx: &mut Context<Self>) {
        self.island_mode = IslandMode::Peek;
        self.island_sheet = None;
        cx.notify();
    }

    pub fn close_island(&mut self, cx: &mut Context<Self>) {
        self.isle_focus = None;
        self.isle_island = None;
        self.isolated = false;
        self.island_mode = IslandMode::Peek;
        self.island_sheet = None;
        cx.notify();
    }

    pub fn open_island_in_tab(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry_id) = self.subject_entry_id() else {
            return;
        };
        let Ok(parsed_id) = entry_id.parse::<EntryId>() else {
            return;
        };
        let target = Target::Entry {
            id: parsed_id,
            module: None,
        };
        if let Some(ws) = self.ws.upgrade() {
            ws.update(cx, |w, cx| {
                w.super_view = None;
                w.open(target, Open::KEEP, cx);
            });
        }
    }

    /// Drops `element_id` onto canonical v3 level `onto_level_id` via G2 `prepare_drop`.
    pub fn drop_element_onto_island(
        &mut self,
        element_id: &str,
        onto_level_id: &str,
        cx: &mut Context<Self>,
    ) -> bool {
        if crate::is_frozen(cx) {
            return false;
        }
        let Some(lib) = self.lib.clone() else {
            return false;
        };
        match g2_data::prepare_drop(&self.book, element_id, onto_level_id, false)
            .and_then(|m| m.commit(&lib))
        {
            Ok(_) => {
                self.sync_workspace_book(cx);
                true
            }
            Err(err) => {
                log::warn!("failed to drop element {element_id} onto {onto_level_id}: {err}");
                false
            }
        }
    }

    /// Opens G2's canonical v3 New Entry dialog for `level_id`.
    pub fn open_new_element_dialog(
        &mut self,
        level_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if crate::is_frozen(cx) {
            return;
        }
        let Some(host) = self.make_page_host() else {
            return;
        };
        open_entry(host, level_id.to_owned(), EntryMode::New, window, cx);
    }

    pub fn sync_workspace_book(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = &self.lib else {
            return;
        };
        let Ok(fresh) = Book::load(lib, &self.book_id) else {
            return;
        };
        let fresh_rc = Rc::new(fresh);
        self.book = fresh_rc.clone();
        if let Some(sheet) = &self.island_sheet {
            sheet.refresh(fresh_rc.clone(), cx);
        }
        self.reload_all_headless(cx);
        if let Some(ws) = self.ws.upgrade() {
            let expected_book = self.book_id.clone();
            ws.update(cx, |w, cx| {
                if w.book_id == expected_book {
                    w.book = fresh_rc;
                    cx.notify();
                }
            });
        }
    }

    pub fn set_find_query(&mut self, query: String, cx: &mut Context<Self>) {
        self.find_query = query;
        cx.notify();
    }

    pub fn fly_to_first_find_hit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(hits) = self.find_hits() else {
            return;
        };
        if let Some(el) = self.elements.iter().find(|e| hits.contains(&e.id)) {
            let id = el.id.clone();
            self.fly_to_element(&id, window, cx);
        }
    }

    pub fn fly_to_element(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let center = match self.layout_mode {
            ElementLayoutMode::Relate => self
                .relate_live
                .get(id)
                .map(|p| (p.x_f32(), p.y_f32()))
                .or_else(|| self.element_centers.get(id).map(|c| (c.x, c.y))),
            ElementLayoutMode::Isles => self.element_centers.get(id).map(|c| (c.x, c.y)),
        };
        if let Some((wx, wy)) = center {
            let (vw, vh) = self
                .viewport_bounds
                .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
                .unwrap_or((1080.0, 680.0));
            let target_zoom = self.zoom.max(IslesLod::Mid.zoom());
            self.zoom = target_zoom;
            self.pan = point(vw * 0.5 - wx * target_zoom, vh * 0.5 - wy * target_zoom);
        }
        self.focus_element(Some(id.to_owned()), window, cx);
    }

    pub fn toggle_sand_lines(&mut self, cx: &mut Context<Self>) {
        self.lines_on = !self.lines_on;
        self.ensure_relate_settled(false, cx);
        cx.notify();
    }

    pub fn set_line_threshold(&mut self, threshold: u32, cx: &mut Context<Self>) {
        self.line_threshold = threshold.max(1);
        self.ensure_relate_settled(false, cx);
        cx.notify();
    }

    pub fn set_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        self.zoom = zoom.clamp(ZOOM_MIN, ZOOM_MAX);
        cx.notify();
    }

    pub fn zoom(&self) -> f32 {
        self.zoom
    }

    pub fn toggle_relation_type(&mut self, type_id: &str, cx: &mut Context<Self>) {
        if !self.hidden_relation_type_ids.remove(type_id) {
            self.hidden_relation_type_ids.insert(type_id.to_owned());
        }
        self.ensure_relate_settled(false, cx);
        cx.notify();
    }

    pub fn start_edge_from(&mut self, kind: &str, id: &str, cx: &mut Context<Self>) {
        self.link_source = Some((kind.to_owned(), id.to_owned()));
        self.pending_link = None;
        cx.notify();
    }

    pub fn click_entity(
        &mut self,
        kind: &str,
        id: &str,
        shift: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if shift || self.link_mode {
            if let Some((src_kind, src_id)) = self.link_source.take() {
                if src_kind == kind && src_id == id {
                    cx.notify();
                    return;
                }
                let default_type = self
                    .compatible_relation_types(&src_kind, &src_id, kind, id)
                    .first()
                    .map(|t| t.definition.id.clone());
                self.pending_link = Some(PendingLink {
                    source: (src_kind, src_id),
                    target: (kind.to_owned(), id.to_owned()),
                    relation_type_id: default_type,
                    reversed: false,
                });
                self.link_mode = false;
            } else {
                self.link_source = Some((kind.to_owned(), id.to_owned()));
            }
            cx.notify();
            return;
        }

        if let Some((src_kind, src_id)) = self.link_source.take()
            && !(src_kind == kind && src_id == id)
        {
            let default_type = self
                .compatible_relation_types(&src_kind, &src_id, kind, id)
                .first()
                .map(|t| t.definition.id.clone());
            self.pending_link = Some(PendingLink {
                source: (src_kind, src_id),
                target: (kind.to_owned(), id.to_owned()),
                relation_type_id: default_type,
                reversed: false,
            });
            cx.notify();
            return;
        }

        if kind == "entry" && self.elements.iter().any(|e| e.id == id) {
            let next =
                if self.isle_focus.as_deref() == Some(id) && self.island_mode == IslandMode::Peek {
                    None
                } else {
                    Some(id.to_owned())
                };
            self.focus_element(next, window, cx);
        } else if kind == "entry"
            && let Ok(parsed_id) = id.parse::<EntryId>()
            && let Some(ws) = self.ws.upgrade()
        {
            let target = Target::Entry {
                id: parsed_id,
                module: None,
            };
            ws.update(cx, |w, cx| {
                w.super_view = None;
                w.open(target, Open::KEEP, cx);
            });
        }
    }

    pub(crate) fn find_hits(&self) -> Option<HashSet<String>> {
        let q = self.find_query.trim().to_lowercase();
        if q.is_empty() {
            return None;
        }
        let hits = self
            .elements
            .iter()
            .filter(|el| {
                el.name.to_lowercase().contains(&q)
                    || el.aliases.iter().any(|a| a.to_lowercase().contains(&q))
            })
            .map(|el| el.id.clone())
            .collect();
        Some(hits)
    }

    pub(crate) fn neighbourhood(&self) -> Option<HashSet<String>> {
        let focus_id = self.isle_focus.as_deref()?;
        let present = self.present_element_ids();
        let pairs = self.active_sand_pairs();
        let rel_pairs: Vec<(String, String)> = self
            .relations
            .iter()
            .filter(|r| {
                r.from.kind == "entry"
                    && r.to.kind == "entry"
                    && present.contains(&r.from.id)
                    && present.contains(&r.to.id)
                    && !self.hidden_relation_type_ids.contains(&r.relation_type)
            })
            .map(|r| (r.from.id.clone(), r.to.id.clone()))
            .collect();
        Some(isle_neighbours(focus_id, &pairs, &rel_pairs))
    }

    pub(crate) fn mark_weights(&self) -> HashMap<String, f32> {
        let present = self.present_element_ids();
        let most = self
            .cooccurrences
            .mentions
            .iter()
            .filter(|(id, _)| present.contains(*id))
            .map(|(_, c)| *c)
            .max()
            .unwrap_or(0);
        let mut weights = HashMap::new();
        for (id, &count) in &self.cooccurrences.mentions {
            if count > 0 && present.contains(id) {
                weights.insert(id.clone(), isle_mark_weight(count, most));
            }
        }
        weights
    }

    pub(crate) fn element_color(&self, el: &IslandItem) -> Option<Rgb> {
        el.color.as_deref().and_then(color_of)
    }

    fn on_drag_move(
        &mut self,
        event: &DragMoveEvent<ElementCarryDrag>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bounds) = self.viewport_bounds else {
            return;
        };
        let local_x = f32::from(event.event.position.x - bounds.origin.x);
        let local_y = f32::from(event.event.position.y - bounds.origin.y);
        let world_x = (local_x - self.pan.x) / self.zoom.max(0.1);
        let world_y = (local_y - self.pan.y) / self.zoom.max(0.1);
        let drag = event.drag(cx).clone();

        match drag.mode {
            ElementLayoutMode::Isles => {
                let mut hit_island = None;
                for model in &self.island_models {
                    let Some(pl) = self.placements.iter().find(|p| p.id == model.island_id) else {
                        continue;
                    };
                    let bx = pl.grid_x as f32 * CELL_W + ISLAND_GAP_X * 0.5;
                    let by = pl.grid_y as f32 * CELL_H;
                    let bw = model.width_cells as f32 * CELL_W - ISLAND_GAP_X;
                    let bh = model.height_cells as f32 * CELL_H;
                    if world_x >= bx
                        && world_x <= bx + bw
                        && world_y >= by
                        && world_y <= by + bh
                        && let Some(onto_level) = model.creation_level_id.as_deref()
                        && g2_data::drop_target(&self.book, &drag.element_id, onto_level, false)
                            .is_some()
                    {
                        hit_island = Some(model.island_id.clone());
                        break;
                    }
                }
                if self.drop_island_id != hit_island {
                    self.drop_island_id = hit_island;
                    cx.notify();
                }
            }
            ElementLayoutMode::Relate => {
                let pt = RelatePoint::new(f64::from(world_x), f64::from(world_y));
                self.relate_live.insert(drag.element_id, pt);
                cx.notify();
            }
        }
    }

    fn on_sheet_resize_move(
        &mut self,
        event: &DragMoveEvent<SheetResizeDrag>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bounds) = self.viewport_bounds else {
            return;
        };
        let vw = f32::from(bounds.size.width).max(320.0);
        let right_edge = f32::from(bounds.origin.x) + vw - 12.0;
        let desired_w = (right_edge - f32::from(event.event.position.x)).max(240.0);
        let ratio = (desired_w / vw).clamp(0.26, 0.62);
        if (self.island_width_ratio - ratio).abs() > 0.002 {
            self.island_width_ratio = ratio;
            cx.notify();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_isles_canvas(
        &self,
        lod: IslesLod,
        weights: &HashMap<String, f32>,
        neighbourhood: &Option<HashSet<String>>,
        dimmed: &Option<HashSet<String>>,
        hidden: &Option<HashSet<String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let p = Theme::of(window, cx).palette;
        let mut out = Vec::new();
        let by_id: HashMap<&str, &LayoutPlacement> = self
            .placements
            .iter()
            .map(|pl| (pl.id.as_str(), pl))
            .collect();

        for model in &self.island_models {
            let Some(placement) = by_id.get(model.island_id.as_str()) else {
                continue;
            };
            let isl_color = model
                .color
                .as_deref()
                .and_then(color_of)
                .unwrap_or_else(|| p.ink(3));
            let box_x =
                (placement.grid_x as f32 * CELL_W + ISLAND_GAP_X * 0.5) * self.zoom + self.pan.x;
            let box_y = (placement.grid_y as f32 * CELL_H) * self.zoom + self.pan.y;
            let box_w = (model.width_cells as f32 * CELL_W - ISLAND_GAP_X) * self.zoom;
            let box_h = (model.height_cells as f32 * CELL_H) * self.zoom;
            let col_step = card_col_step(model.width_cells);
            let is_drop = self.drop_island_id.as_deref() == Some(model.island_id.as_str());
            let isl_name: SharedString = if model.title.trim().is_empty() {
                t(cx, k_se::UNNAMED_CATEGORY)
            } else {
                SharedString::from(model.title.clone())
            };
            let isl_id = model.island_id.clone();

            let mut children: Vec<AnyElement> = Vec::new();

            let isl_id_click = isl_id.clone();
            let create_level_opt = model.creation_level_id.clone().filter(|lid| {
                !model.is_uncategorized && g2_data::creation(&self.book, lid).is_some()
            });
            let legend = div()
                .id(ElementId::Name(format!("se-cat-legend-{isl_id}").into()))
                .px(px(6.0))
                .py(px(2.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(5.0))
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    let next = if this.isle_island.as_deref() == Some(isl_id_click.as_str())
                        && this.island_mode == IslandMode::Peek
                    {
                        None
                    } else {
                        Some(isl_id_click.clone())
                    };
                    this.focus_island(next, window, cx);
                }))
                .child(
                    KindMark::new(
                        ElementId::Name(format!("se-cat-mark-{isl_id}").into()),
                        model.sand_kind,
                    )
                    .color(isl_color)
                    .scale(11.0 / 14.0),
                )
                .child(
                    div()
                        .text_size(px(11.5))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(p.ink(1).solid())
                        .child(isl_name),
                )
                .child(
                    div()
                        .text_size(px(10.5))
                        .text_color(p.ink(3).solid())
                        .child(SharedString::from(model.total_elements.to_string())),
                )
                .when_some(create_level_opt, |el, level_id| {
                    el.child(
                        div()
                            .id(ElementId::Name(format!("se-cat-new-el-{isl_id}").into()))
                            .ml(px(4.0))
                            .px(px(4.0))
                            .rounded(px(radius::SM))
                            .text_size(px(10.5))
                            .text_color(p.ink(3).solid())
                            .hover(|s| s.text_color(p.ink(1).solid()))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.open_new_element_dialog(&level_id, window, cx);
                            }))
                            .child("+"),
                    )
                })
                .into_any_element();
            children.push(legend);

            for g in &model.groups {
                if let (Some(top_px), Some(gname)) = (g.header_top_px, &g.group_name) {
                    children.push(
                        div()
                            .absolute()
                            .left(px(6.0))
                            .top(px(top_px * self.zoom))
                            .text_size(px((10.0 * self.zoom).clamp(9.0, 12.0)))
                            .text_color(p.ink(3).solid())
                            .child(SharedString::from(gname.clone()))
                            .into_any_element(),
                    );
                }
            }

            for (g_idx, g) in model.groups.iter().enumerate() {
                for (idx, element) in g.items.iter().enumerate() {
                    if hidden.as_ref().is_some_and(|set| set.contains(&element.id)) {
                        continue;
                    }
                    let col = idx % model.width_cells;
                    let row_offset = idx / model.width_cells;
                    let cell_left = (col as f32 * col_step + 3.0) * self.zoom;
                    let cell_top =
                        (g.card_rows_top_px + row_offset as f32 * CELL_H + 3.0) * self.zoom;
                    let cell_w = ((col_step - 6.0) * self.zoom).max(18.0);
                    let cell_h = ((CELL_H - 6.0) * self.zoom).max(18.0);

                    let card_color = self.element_color(element).unwrap_or(isl_color);
                    let is_focused = self.isle_focus.as_deref() == Some(element.id.as_str());
                    let is_link_source = self
                        .link_source
                        .as_ref()
                        .is_some_and(|(k, id)| k == "entry" && id == &element.id);
                    let is_neighbour = neighbourhood
                        .as_ref()
                        .is_some_and(|set| set.contains(&element.id));
                    let is_dim =
                        !is_focused && dimmed.as_ref().is_some_and(|set| set.contains(&element.id));
                    let weight = weights.get(&element.id).copied().unwrap_or(0.0);
                    let mark_sz = match lod {
                        IslesLod::Far => 7.0 + weight * 8.0,
                        IslesLod::Mid => 11.0,
                        IslesLod::Near => 12.0,
                    };

                    let el_id = element.id.clone();
                    let el_name = element.name.clone();
                    let el_summary = element.summary.clone();
                    let drag_payload = ElementCarryDrag {
                        element_id: el_id.clone(),
                        element_name: el_name.clone(),
                        color: Some(card_color),
                        from_island_id: isl_id.clone(),
                        mode: ElementLayoutMode::Isles,
                        origin_world: RelatePoint::default(),
                    };

                    let border_c = if is_focused || is_link_source {
                        card_color.solid()
                    } else if is_neighbour {
                        card_color.alpha(0.55)
                    } else {
                        card_color.alpha(0.18)
                    };

                    // Scope card ElementId by `(island_id, g_idx, el_id)` so accepted-membership
                    // cards never collide with resident cards on another island.
                    let card_dom_id = format!("se-isles-card-{isl_id}-{g_idx}-{el_id}");
                    let card_mark_id = format!("se-isles-mark-{isl_id}-{g_idx}-{el_id}");
                    let card = div()
                        .id(ElementId::Name(card_dom_id.into()))
                        .role(gpui::Role::Button)
                        .aria_label(SharedString::from(el_name.clone()))
                        .absolute()
                        .left(px(cell_left))
                        .top(px(cell_top))
                        .w(px(cell_w))
                        .h(px(cell_h))
                        .px(px(5.0))
                        .py(px(3.0))
                        .rounded(px(radius::SM))
                        .border_1()
                        .border_color(border_c)
                        .when(is_focused, |d| d.bg(card_color.alpha(0.12)))
                        .when(is_dim, |d| d.opacity(0.32))
                        .cursor_pointer()
                        .overflow_hidden()
                        .flex()
                        .flex_col()
                        .justify_center()
                        .on_drag(drag_payload, |drag, _, _, cx| cx.new(|_| drag.clone()))
                        .on_click(
                            cx.listener(move |this, event: &gpui::ClickEvent, window, cx| {
                                cx.stop_propagation();
                                this.click_entity(
                                    "entry",
                                    &el_id,
                                    event.modifiers().shift,
                                    window,
                                    cx,
                                );
                            }),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(4.0))
                                .child(
                                    KindMark::new(
                                        ElementId::Name(card_mark_id.into()),
                                        element.sand_kind,
                                    )
                                    .color(card_color)
                                    .scale(mark_sz / 14.0),
                                )
                                .when(lod != IslesLod::Far, |d| {
                                    d.child(
                                        div()
                                            .text_size(px((11.5 * self.zoom).clamp(10.0, 14.0)))
                                            .text_color(p.ink(1).solid())
                                            .truncate()
                                            .child(SharedString::from(el_name)),
                                    )
                                }),
                        )
                        .when(
                            lod == IslesLod::Near && !el_summary.trim().is_empty(),
                            |d| {
                                d.child(
                                    div()
                                        .mt(px(2.0))
                                        .text_size(px(10.0))
                                        .text_color(p.ink(3).solid())
                                        .truncate()
                                        .child(SharedString::from(el_summary)),
                                )
                            },
                        )
                        .into_any_element();
                    children.push(card);
                }
            }

            if model.total_elements == 0 {
                children.push(
                    div()
                        .mt(px(6.0))
                        .px(px(6.0))
                        .text_size(px(11.0))
                        .text_color(p.ink(3).solid())
                        .child(t(cx, k_empty::CATEGORY_NO_ELEMENTS))
                        .into_any_element(),
                );
            }

            let target_level_drop = model.creation_level_id.clone();
            let island_box = div()
                .id(ElementId::Name(format!("se-category-box-{isl_id}").into()))
                .absolute()
                .left(px(box_x))
                .top(px(box_y))
                .w(px(box_w.max(64.0)))
                .h(px(box_h.max(36.0)))
                .rounded(px(radius::MD))
                .border_1()
                .border_color(if is_drop {
                    isl_color.solid()
                } else {
                    isl_color.alpha(0.38)
                })
                .bg(if is_drop {
                    isl_color.alpha(0.10)
                } else {
                    p.paper.alpha(0.75)
                })
                .on_drop(
                    cx.listener(move |this, drag: &ElementCarryDrag, _window, cx| {
                        this.drop_island_id = None;
                        if drag.mode == ElementLayoutMode::Isles
                            && let Some(onto_level) = target_level_drop.as_deref()
                        {
                            let _ = this.drop_element_onto_island(&drag.element_id, onto_level, cx);
                        }
                    }),
                )
                .children(children)
                .into_any_element();
            out.push(island_box);
        }

        out
    }

    #[allow(clippy::too_many_arguments)]
    fn render_relate_cells(
        &self,
        lod: IslesLod,
        weights: &HashMap<String, f32>,
        neighbourhood: &Option<HashSet<String>>,
        dimmed: &Option<HashSet<String>>,
        hidden: &Option<HashSet<String>>,
        major_ids: &BTreeSet<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let p = Theme::of(window, cx).palette;
        let fallback = self.isle_starts();
        let mut out = Vec::with_capacity(self.elements.len());

        for element in &self.elements {
            if hidden.as_ref().is_some_and(|set| set.contains(&element.id)) {
                continue;
            }
            let Some(pos) = self
                .relate_live
                .get(&element.id)
                .or_else(|| fallback.get(&element.id))
                .copied()
            else {
                continue;
            };
            let (hw, hh) = relate_cell_half(&element.name);
            let sx = pos.x_f32() * self.zoom + self.pan.x;
            let sy = pos.y_f32() * self.zoom + self.pan.y;
            let cell_w = ((hw as f32) * 2.0 * self.zoom).max(24.0);
            let cell_h = ((hh as f32) * 2.0 * self.zoom).max(20.0);

            let cat_color = self.element_color(element).unwrap_or_else(|| p.ink(2));
            let is_focused = self.isle_focus.as_deref() == Some(element.id.as_str());
            let is_link_source = self
                .link_source
                .as_ref()
                .is_some_and(|(k, id)| k == "entry" && id == &element.id);
            let is_neighbour = neighbourhood
                .as_ref()
                .is_some_and(|set| set.contains(&element.id));
            let is_dim =
                !is_focused && dimmed.as_ref().is_some_and(|set| set.contains(&element.id));
            let is_pinned = element.relation_pin.is_some();
            let weight = weights.get(&element.id).copied().unwrap_or(0.0);

            let show_name = lod != IslesLod::Far
                || is_focused
                || is_neighbour
                || major_ids.contains(&element.id);

            let el_id = element.id.clone();
            let el_name = element.name.clone();
            let drag_payload = ElementCarryDrag {
                element_id: el_id.clone(),
                element_name: el_name.clone(),
                color: Some(cat_color),
                from_island_id: element.home_island_id.clone(),
                mode: ElementLayoutMode::Relate,
                origin_world: pos,
            };

            let border_c = if is_focused || is_link_source {
                cat_color.solid()
            } else if is_pinned || is_neighbour {
                cat_color.alpha(0.65)
            } else {
                cat_color.alpha(0.28)
            };

            let mark_id = format!("se-relate-mark-{el_id}");
            let cell = div()
                .id(ElementId::Name(format!("se-relate-card-{el_id}").into()))
                .role(gpui::Role::Button)
                .aria_label(SharedString::from(el_name.clone()))
                .absolute()
                .left(px(sx - cell_w * 0.5))
                .top(px(sy - cell_h * 0.5))
                .w(px(cell_w))
                .h(px(cell_h))
                .px(px(6.0))
                .rounded(px(radius::SM))
                .border_1()
                .border_color(border_c)
                .bg(if is_focused {
                    cat_color.alpha(0.16)
                } else {
                    p.paper.alpha(0.90)
                })
                .when(is_dim, |d| d.opacity(0.32))
                .cursor_pointer()
                .flex()
                .flex_row()
                .items_center()
                .justify_center()
                .gap(px(4.0))
                .on_drag(drag_payload, |drag, _, _, cx| cx.new(|_| drag.clone()))
                .on_click(
                    cx.listener(move |this, event: &gpui::ClickEvent, window, cx| {
                        cx.stop_propagation();
                        this.click_entity("entry", &el_id, event.modifiers().shift, window, cx);
                    }),
                )
                .child(
                    KindMark::new(ElementId::Name(mark_id.into()), element.sand_kind)
                        .color(cat_color)
                        .scale((9.0 + weight * 4.0) / 14.0),
                )
                .when(show_name, |d| {
                    d.child(
                        div()
                            .text_size(px(11.5))
                            .text_color(p.ink(1).solid())
                            .truncate()
                            .child(SharedString::from(el_name)),
                    )
                })
                .into_any_element();
            out.push(cell);
        }

        out
    }

    fn render_lines_canvas(
        &self,
        sand_pairs: Vec<IslePair>,
        relate_edges: Vec<RelateEdgeView>,
        neighbourhood: Option<HashSet<String>>,
        isolated: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Canvas<()> {
        let p = Theme::of(window, cx).palette;
        let sand_color = p.ink(3).solid();
        let zoom = self.zoom;
        let pan = self.pan;
        let mode = self.layout_mode;
        let centers: HashMap<String, (f32, f32)> = match mode {
            ElementLayoutMode::Isles => self
                .element_centers
                .iter()
                .map(|(id, c)| (id.clone(), (c.x, c.y)))
                .collect(),
            ElementLayoutMode::Relate => self
                .relate_live
                .iter()
                .map(|(id, pt)| (id.clone(), (pt.x_f32(), pt.y_f32())))
                .collect(),
        };
        let active_id = self.isle_focus.clone();
        let selected_edge_id = self.selected_edge_id.clone();

        canvas(
            move |_, _, _| {},
            move |bounds, _, window, _| {
                let origin = bounds.origin;
                let to_screen = |wx: f32, wy: f32| -> Point<Pixels> {
                    point(
                        origin.x + px(wx * zoom + pan.x),
                        origin.y + px(wy * zoom + pan.y),
                    )
                };

                // 1. Prose shared-paragraph sand lines (`正文同段`)
                let most = sand_pairs
                    .iter()
                    .map(|sp| sp.count)
                    .max()
                    .unwrap_or(1)
                    .max(1);
                for pair in &sand_pairs {
                    if isolated
                        && let Some(vis) = &neighbourhood
                        && (!vis.contains(&pair.a) || !vis.contains(&pair.b))
                    {
                        continue;
                    }
                    let Some(&(x0, y0)) = centers.get(&pair.a) else {
                        continue;
                    };
                    let Some(&(x2, y2)) = centers.get(&pair.b) else {
                        continue;
                    };
                    let dx = x2 - x0;
                    let dy = y2 - y0;
                    let cx_pt = (x0 + x2) * 0.5 - dy * 0.08;
                    let cy_pt = (y0 + y2) * 0.5 + dx * 0.08;
                    let strength = (pair.count as f32) / (most as f32);
                    let touches = active_id
                        .as_deref()
                        .is_some_and(|aid| pair.a == aid || pair.b == aid);
                    let mut alpha = 0.18 + strength * 0.42;
                    if active_id.is_some() {
                        alpha = if touches {
                            (alpha * 1.7).min(0.90)
                        } else {
                            alpha * 0.15
                        };
                    }
                    let mut builder =
                        PathBuilder::stroke(px((1.2 + strength * 2.0).clamp(1.0, 3.2)));
                    builder.move_to(to_screen(x0, y0));
                    builder.curve_to(to_screen(x2, y2), to_screen(cx_pt, cy_pt));
                    if let Ok(path) = builder.build() {
                        window.paint_path(path, sand_color.alpha(alpha));
                    }
                }

                // 2. Canonical relation arcs
                for edge in &relate_edges {
                    let is_selected = selected_edge_id.as_deref() == Some(edge.id.as_str())
                        || active_id
                            .as_deref()
                            .is_some_and(|aid| edge.from_id == aid || edge.to_id == aid);
                    if isolated && active_id.is_some() && !is_selected {
                        continue;
                    }
                    let alpha = if is_selected {
                        0.96
                    } else if active_id.is_some() {
                        0.18
                    } else {
                        0.80
                    };
                    let stroke_w = if is_selected { 2.2 } else { 1.5 };
                    let mut builder = PathBuilder::stroke(px(stroke_w));
                    builder.move_to(to_screen(edge.p0.x_f32(), edge.p0.y_f32()));
                    builder.curve_to(
                        to_screen(edge.p2.x_f32(), edge.p2.y_f32()),
                        to_screen(edge.ctrl.x_f32(), edge.ctrl.y_f32()),
                    );
                    if let Ok(path) = builder.build() {
                        window.paint_path(path, edge.color.alpha(alpha));
                    }
                }
            },
        )
        .size_full()
    }
}

impl Render for ElementOverview {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        let lod = isles_lod(self.zoom);
        let weights = self.mark_weights();
        let neighbourhood = self.neighbourhood();
        let find_hits = self.find_hits();
        let keep_set = find_hits.as_ref().or(neighbourhood.as_ref());
        let dimmed: Option<HashSet<String>> = keep_set.map(|keep| {
            self.elements
                .iter()
                .filter(|e| !keep.contains(&e.id))
                .map(|e| e.id.clone())
                .collect()
        });
        let hidden: Option<HashSet<String>> =
            (self.isolated && neighbourhood.is_some()).then(|| {
                let nb = neighbourhood.as_ref().unwrap();
                self.elements
                    .iter()
                    .filter(|e| !nb.contains(&e.id))
                    .map(|e| e.id.clone())
                    .collect()
            });
        let present = self.present_element_ids();
        let major_ids = major_element_ids(&self.cooccurrences.mentions, &present, 12);

        let sand_pairs = self.active_sand_pairs();
        let relate_edges = self.build_relate_edges();
        let crowded = relate_edges.len() > RELATE_LABEL_BUDGET;
        let role_labels_all = lod != IslesLod::Far && !crowded;

        let world_items = match self.layout_mode {
            ElementLayoutMode::Isles => self.render_isles_canvas(
                lod,
                &weights,
                &neighbourhood,
                &dimmed,
                &hidden,
                window,
                cx,
            ),
            ElementLayoutMode::Relate => self.render_relate_cells(
                lod,
                &weights,
                &neighbourhood,
                &dimmed,
                &hidden,
                &major_ids,
                window,
                cx,
            ),
        };
        let role_badges = if self.layout_mode == ElementLayoutMode::Relate {
            self.render_relate_role_labels(&relate_edges, role_labels_all, window, cx)
        } else {
            Vec::new()
        };

        let lines_canvas = self.render_lines_canvas(
            sand_pairs,
            relate_edges,
            neighbourhood,
            self.isolated,
            window,
            cx,
        );

        let legend = self.render_legend(window, cx);
        let island = self.render_floating_island(window, cx);
        let pending_modal = self.render_pending_link_modal(window, cx);
        let edge_popover = self.render_selected_edge_popover(window, cx);
        let type_modal = self.render_type_manager_modal(window, cx);

        let entity = cx.entity();
        let bounds_probe = canvas(
            move |bounds, _, cx| {
                entity.update(cx, |this, _| {
                    this.viewport_bounds = Some(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .size_full();

        div()
            .id("se-viewport")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(p.paper.solid())
            .on_drag_move::<ElementCarryDrag>(cx.listener(Self::on_drag_move))
            .on_drag_move::<SheetResizeDrag>(cx.listener(Self::on_sheet_resize_move))
            .on_drop(cx.listener(|this, drag: &ElementCarryDrag, _window, cx| {
                this.drop_island_id = None;
                if drag.mode == ElementLayoutMode::Relate
                    && let Some(pos) = this.relate_live.get(&drag.element_id).copied()
                {
                    this.pin_element_in_relate(&drag.element_id, pos, cx);
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, _window, cx| {
                    this.selected_edge_id = None;
                    this.pan_drag = Some((event.position, this.pan));
                    cx.notify();
                }),
            )
            .on_mouse_move(
                cx.listener(|this, event: &gpui::MouseMoveEvent, _window, cx| {
                    if let Some((start_pos, start_pan)) = this.pan_drag {
                        if event.pressed_button == Some(MouseButton::Left) {
                            let dx = f32::from(event.position.x - start_pos.x);
                            let dy = f32::from(event.position.y - start_pos.y);
                            this.pan = point(start_pan.x + dx, start_pan.y + dy);
                            cx.notify();
                        } else {
                            this.pan_drag = None;
                        }
                    }
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _window, _cx| {
                    this.pan_drag = None;
                }),
            )
            .on_scroll(cx.listener(|this, event: &ScrollEvent, _window, cx| {
                let delta = match event.delta {
                    ScrollDelta::Pixels(p) => point(f32::from(p.x), f32::from(p.y)),
                    ScrollDelta::Lines(l) => point(l.x * 24.0, l.y * 24.0),
                };
                if event.modifiers.platform || event.modifiers.control {
                    let factor = (1.0 - delta.y * 0.003).clamp(0.8, 1.25);
                    this.zoom = (this.zoom * factor).clamp(ZOOM_MIN, ZOOM_MAX);
                } else {
                    this.pan = point(this.pan.x + delta.x, this.pan.y + delta.y);
                }
                cx.notify();
            }))
            .child(div().absolute().inset_0().child(bounds_probe))
            .child(div().absolute().inset_0().child(lines_canvas))
            .children(role_badges)
            .children(world_items)
            .when(self.island_models.is_empty(), |el| {
                el.child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(13.0))
                        .text_color(p.ink(3).solid())
                        .child(t(cx, k_empty::NO_CATEGORIES)),
                )
            })
            .child(legend)
            .children(island)
            .children(pending_modal)
            .children(edge_popover)
            .children(type_modal)
    }
}
