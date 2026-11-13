//! M22: Element Overview Super View (`SuperView::Elements`, `⌘⌥4`) on canonical v3.
//!
//! Provides two synchronised canvas layouts over canonical v3 element levels and the
//! content entries in them:
//! - `关系` (`ElementLayoutMode::Relate`, default): deterministic force-directed graph
//!   pulled by explicit canonical relations and true shared-paragraph prose co-occurrence
//!   (`Workspace::entry_cooccurrences`), with author pins stored on
//!   `Entry.layout.relation_graph`.
//! - `群岛` (`ElementLayoutMode::Isles`): balanced skyline islands for element levels
//!   (separating resident entries and accepted memberships), three zoom LODs, and drag-drop
//!   reassignment through `dr_view_elements::data::v3::{drop_target, prepare_drop}`.
//!
//! Focusing an element or island opens a Peek Card that expands into a floating Sheet
//! mounting the real canonical v3 `dr_shell::v3::page::EntryPage`.

pub mod isles;
pub mod relate;
pub mod view;

use futures::FutureExt as _;
use gpui::{App, AppContext as _, Entity, Global, WeakEntity};

pub use isles::{
    CELL_H, CELL_W, ElementCenter, ExtractedIslands, IslandGroupLayout, IslandItem, IslandModel,
    IslePair, IslesLod, LayoutBounds, LayoutInput, LayoutPlacement, LayoutResult, LayoutSide,
    PinnedGrid, UNCATEGORIZED_KEY, extract_v3_islands, isle_companions, isle_mark_weight,
    isle_neighbours, isle_pairs, isles_lod, major_element_ids, solve_super_element_layout,
};
pub use relate::{
    ElementLayoutMode, MEMORY_KEY, OverviewMemory, RelateEdgeGeometry, RelateEdgeInput,
    RelateNodeInput, RelatePoint, RelateRoleLabel, RelateSimNode, RelateSimulation,
    RelateSimulationInput, RelateSpring, SpringKind, create_relate_simulation,
    parse_overview_memory, relate_anchors, relate_bend, relate_bounds, relate_cell_half,
    relate_ease, relate_edge_geometry, relate_positions, relate_role_half, relate_spring_signature,
    serialize_overview_memory, settle_relate,
};
pub use view::{
    ElementCarryDrag, ElementOverview, IslandMode, IslandSubject, OverviewHeadEnd,
    OverviewHeadStart, PendingLink, RelateEdgeView,
};

#[derive(Default)]
pub(crate) struct Registry {
    pub(crate) frozen: bool,
    pub(crate) views: Vec<WeakEntity<ElementOverview>>,
}

impl Global for Registry {}

pub(crate) fn is_frozen(cx: &App) -> bool {
    cx.try_global::<Registry>().is_some_and(|r| r.frozen) || dr_shell::release::is_releasing(cx)
}

/// Registers `SuperView::Elements` (`⌘⌥4`) and library-release barriers.
pub fn init(cx: &mut App) {
    if !cx.has_global::<Registry>() {
        cx.set_global(Registry::default());
    }

    dr_shell::release::before_release(cx, |cx| {
        let views = {
            let reg = cx.default_global::<Registry>();
            reg.frozen = true;
            reg.views.retain(|v| v.upgrade().is_some());
            reg.views.clone()
        };
        let app = cx.to_async();
        async move {
            app.update(|cx| {
                for weak in &views {
                    if let Some(view) = weak.upgrade() {
                        view.update(cx, |v, cx| v.drop_library_handles(cx));
                    }
                }
            });
            Ok(())
        }
        .boxed_local()
    });

    dr_shell::release::after_release(cx, |cx| {
        let next_lib = cx
            .try_global::<dr_shell::Services>()
            .and_then(|s| s.library.clone());
        let views = {
            let reg = cx.default_global::<Registry>();
            reg.frozen = false;
            reg.views.retain(|v| v.upgrade().is_some());
            reg.views.clone()
        };
        for weak in views {
            if let Some(view) = weak.upgrade() {
                view.update(cx, |v, cx| v.rebind_library(next_lib.clone(), cx));
            }
        }
    });

    dr_shell::pages::add_super_view(
        cx,
        dr_shell::workspace::SuperView::Elements,
        |host, window, cx| {
            let host = host.clone();
            let overview = cx.new(|cx| ElementOverview::new(host, window, cx));
            let weak_start = overview.downgrade();
            let weak_end = overview.downgrade();
            let start = cx.new(|_| OverviewHeadStart::new(weak_start));
            let end = cx.new(|cx| OverviewHeadEnd::new(weak_end, window, cx));
            dr_shell::pages::SuperViewPage::new(overview)
                .head_start(start)
                .head_end(end)
        },
    );
}

/// Returns the most recently mounted `ElementOverview` entity, if still alive (for tests).
pub fn current(cx: &App) -> Option<Entity<ElementOverview>> {
    cx.try_global::<Registry>()?
        .views
        .iter()
        .rev()
        .find_map(WeakEntity::upgrade)
}
