//! Pure layout math, memory persistence and filter predicates for M23.

use dr_view_review::Listing;
use dr_workspace::dto::{CommentInfo, MaterialInfo};
use serde::{Deserialize, Serialize};

/// Per-book memory key in [`dr_shell::Workspace::book_memory`].
pub const MEMORY_KEY: &str = "shelf-review";

/// Minimum width of each review rail (TODOs and Comments).
pub const RAIL_MIN_WIDTH: f32 = 240.0;
/// Minimum width reserved for the right-hand Material shelf.
pub const LIBRARY_MIN_WIDTH: f32 = 360.0;
/// Initial rail width before any drag or container ratio is stored.
pub const RAIL_DEFAULT_WIDTH: f32 = 280.0;
/// Keyboard resize step when nudging a rail handle with arrow keys.
pub const RAIL_KEY_STEP: f32 = 24.0;

/// Collapsed bar height of the bottom unsorted/resolved drawer.
pub const DRAWER_HEADER_HEIGHT: f32 = 28.0;
/// Minimum open height of the bottom drawer.
pub const DRAWER_MIN_HEIGHT: f32 = 120.0;
/// Default open height of the bottom drawer.
pub const DRAWER_DEFAULT_HEIGHT: f32 = 260.0;
/// Minimum vertical space kept above the open bottom drawer.
pub const STAGE_MIN_HEIGHT: f32 = 200.0;

/// Fixed material kind chip order.
pub const KIND_ORDER: [&str; 3] = ["text", "image", "pdf"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rail {
    Todos,
    Comments,
}

/// Per-book persisted layout for M23 (`local_state` under `memory:<book>:shelf-review`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShelfMemory {
    pub todo_width: f32,
    pub comment_width: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo_ratio: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_ratio: Option<f32>,
    pub drawer_open: bool,
    pub drawer_height: f32,
}

impl Default for ShelfMemory {
    fn default() -> Self {
        Self {
            todo_width: RAIL_DEFAULT_WIDTH,
            comment_width: RAIL_DEFAULT_WIDTH,
            todo_ratio: None,
            comment_ratio: None,
            drawer_open: false,
            drawer_height: DRAWER_DEFAULT_HEIGHT,
        }
    }
}

impl ShelfMemory {
    pub fn from_json(value: &serde_json::Value) -> Self {
        let def = Self::default();
        let num = |k: &str| {
            value
                .get(k)
                .and_then(|v| v.as_f64())
                .map(|n| n as f32)
                .filter(|n| n.is_finite())
        };
        let todo_width = num("todo_width")
            .unwrap_or(def.todo_width)
            .max(RAIL_MIN_WIDTH);
        let comment_width = num("comment_width")
            .unwrap_or(def.comment_width)
            .max(RAIL_MIN_WIDTH);
        let ratio = |k: &str| num(k).filter(|&r| r > 0.0 && r < 1.0);
        let drawer_open = value
            .get("drawer_open")
            .and_then(|v| v.as_bool())
            .unwrap_or(def.drawer_open);
        let drawer_height = num("drawer_height")
            .unwrap_or(def.drawer_height)
            .max(DRAWER_MIN_HEIGHT);
        Self {
            todo_width,
            comment_width,
            todo_ratio: ratio("todo_ratio"),
            comment_ratio: ratio("comment_ratio"),
            drawer_open,
            drawer_height,
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}))
    }

    /// Resolves `(todo_width, comment_width)` inside `container_width`, preserving
    /// stored ratios when available and always leaving at least [`LIBRARY_MIN_WIDTH`]
    /// for the material shelf whenever the container permits.
    pub fn resolve_widths(&self, container_width: Option<f32>) -> (f32, f32) {
        let Some(cw) = container_width.filter(|&w| w.is_finite() && w > 0.0) else {
            return (
                self.todo_width.max(RAIL_MIN_WIDTH),
                self.comment_width.max(RAIL_MIN_WIDTH),
            );
        };
        let raw_todo = self
            .todo_ratio
            .map(|r| r * cw)
            .unwrap_or(self.todo_width)
            .max(RAIL_MIN_WIDTH);
        let raw_comment = self
            .comment_ratio
            .map(|r| r * cw)
            .unwrap_or(self.comment_width)
            .max(RAIL_MIN_WIDTH);
        let max_pair = (cw - LIBRARY_MIN_WIDTH).max(RAIL_MIN_WIDTH * 2.0);
        if raw_todo + raw_comment <= max_pair {
            return (raw_todo.round(), raw_comment.round());
        }
        let excess_todo = (raw_todo - RAIL_MIN_WIDTH).max(0.0);
        let excess_comment = (raw_comment - RAIL_MIN_WIDTH).max(0.0);
        let excess_sum = excess_todo + excess_comment;
        let room = (max_pair - RAIL_MIN_WIDTH * 2.0).max(0.0);
        if excess_sum <= f32::EPSILON {
            return (RAIL_MIN_WIDTH, RAIL_MIN_WIDTH);
        }
        let scale = room / excess_sum;
        (
            (RAIL_MIN_WIDTH + excess_todo * scale).round(),
            (RAIL_MIN_WIDTH + excess_comment * scale).round(),
        )
    }

    /// Updates `rail` to `proposed` inside `container_width`, keeping the sibling
    /// rail's current resolved width intact and updating proportional ratios.
    pub fn apply_rail_drag(
        &mut self,
        rail: Rail,
        proposed: f32,
        container_width: Option<f32>,
    ) -> (f32, f32) {
        let (cur_todo, cur_comment) = self.resolve_widths(container_width);
        let (next_todo, next_comment) = match rail {
            Rail::Todos => (
                drag_rail_width(proposed, cur_comment, container_width),
                cur_comment,
            ),
            Rail::Comments => (
                cur_todo,
                drag_rail_width(proposed, cur_todo, container_width),
            ),
        };
        self.todo_width = next_todo;
        self.comment_width = next_comment;
        if let Some(cw) = container_width
            .filter(|&w| w.is_finite() && w >= RAIL_MIN_WIDTH * 2.0 + LIBRARY_MIN_WIDTH)
        {
            self.todo_ratio = Some((next_todo / cw).clamp(0.05, 0.85));
            self.comment_ratio = Some((next_comment / cw).clamp(0.05, 0.85));
        }
        (next_todo, next_comment)
    }

    pub fn apply_drawer_height(&mut self, proposed: f32, container_height: Option<f32>) -> f32 {
        let next = clamp_drawer_height(proposed, container_height);
        self.drawer_height = next;
        next
    }
}

/// Clamps one rail's width during drag or keyboard nudge.
pub fn drag_rail_width(proposed: f32, sibling_width: f32, container_width: Option<f32>) -> f32 {
    if !proposed.is_finite() {
        return RAIL_DEFAULT_WIDTH;
    }
    let sibling = sibling_width.max(RAIL_MIN_WIDTH);
    let max_width = match container_width.filter(|&w| w.is_finite() && w > 0.0) {
        Some(cw) => (cw - LIBRARY_MIN_WIDTH - sibling).max(RAIL_MIN_WIDTH),
        None => 960.0,
    };
    proposed.clamp(RAIL_MIN_WIDTH, max_width).round()
}

/// Clamps the open drawer height inside `container_height`.
pub fn clamp_drawer_height(proposed: f32, container_height: Option<f32>) -> f32 {
    if !proposed.is_finite() {
        return DRAWER_DEFAULT_HEIGHT;
    }
    let max_h = match container_height.filter(|&h| h.is_finite() && h > 0.0) {
        Some(ch) => (ch - STAGE_MIN_HEIGHT).max(DRAWER_MIN_HEIGHT),
        None => 640.0,
    };
    proposed.clamp(DRAWER_MIN_HEIGHT, max_h).round()
}

pub fn normalize_query(raw: &str) -> String {
    raw.trim().to_lowercase()
}

pub fn matches_comment(item: &CommentInfo, source_title: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    item.body.to_lowercase().contains(query)
        || item
            .quote
            .as_deref()
            .is_some_and(|q| q.to_lowercase().contains(query))
        || source_title.to_lowercase().contains(query)
}

pub fn matches_material(
    material: &MaterialInfo,
    first_words: Option<&str>,
    folder_path: Option<&str>,
    query: &str,
) -> bool {
    if query.is_empty() {
        return true;
    }
    material.title.to_lowercase().contains(query)
        || material.kind.to_lowercase().contains(query)
        || first_words.is_some_and(|w| w.to_lowercase().contains(query))
        || folder_path.is_some_and(|p| p.to_lowercase().contains(query))
}

/// Narrows `listing` by `query` (matching body, quote or group/source title).
pub fn filter_listing(
    mut listing: Listing,
    query: &str,
    mut title_of: impl FnMut(&CommentInfo) -> String,
) -> Listing {
    let q = normalize_query(query);
    if q.is_empty() {
        return listing;
    }
    for groups in [&mut listing.open, &mut listing.resolved] {
        for group in groups.iter_mut() {
            group
                .items
                .retain(|item| matches_comment(item, &title_of(item), &q));
        }
        groups.retain(|group| !group.items.is_empty());
    }
    listing
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShelfCounts {
    pub open_todos: usize,
    pub open_comments: usize,
    pub materials: usize,
    pub orphans: usize,
    pub resolved: usize,
}
