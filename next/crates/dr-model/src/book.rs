//! Records of everything the book (catalog) document stores, one struct per
//! collection (`loro-schema.md` "书目文档").
//!
//! These are read models: plain owned values `dr-doc` builds from one entity
//! map. They hold metadata only — prose bodies live in their own documents and
//! are read through `dr-doc`'s views. Writes are field by field (`dr-doc`'s
//! writers), so a field a newer version added survives an older version's
//! edit of the same entity.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::id::*;
use crate::kind::*;
use crate::pos::{PosKey, cmp_pos};
use crate::time::{Day, Timestamp};

/// A reference to any entity: a relation end, a comment or memory target.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EntityRef {
    pub kind: EntityKind,
    pub id: String,
}

impl EntityRef {
    pub fn new(kind: EntityKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
        }
    }
}

/// A position anchor as stored: two encoded Loro cursors (decision D4). The
/// bytes are opaque here; `dr-doc` decodes and resolves them against the
/// prose document the owning entity points at.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EncodedAnchor {
    pub start: Vec<u8>,
    pub end: Vec<u8>,
}

/// One entry of a key/value list (element fields, storyline fields, category
/// template fields, project facts, the storyline template). Lists are sorted
/// by position key, ties by entry id; an entry without a usable key sorts
/// last.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KvEntry {
    pub id: KvEntryId,
    pub key: String,
    pub value: String,
    pub pos: Option<PosKey>,
}

/// Sort a key/value list the way every reader shows it.
pub fn sort_kv(entries: &mut [KvEntry]) {
    entries.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
}

/// Default book word target (the old `DEFAULT_PROJECT_TARGET`).
pub const DEFAULT_WORD_TARGET: i64 = 120_000;
/// Default daily word goal (the old `DEFAULT_DAILY_GOAL`).
pub const DEFAULT_DAILY_WORD_TARGET: i64 = 1_500;

/// The book itself (`meta` in the book document; the old `project`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BookMeta {
    pub id: BookId,
    /// `meta.v`: the schema version the document was created with.
    pub schema_version: i64,
    pub name: String,
    pub summary: String,
    /// In the trash since then.
    pub deleted_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    /// Fields every new storyline starts with.
    pub storyline_template: Vec<KvEntry>,
    /// The book's word target as stored (`None`: never set). 0 turns the
    /// book progress bar off. Use [`BookMeta::word_target`].
    pub word_target_set: Option<i64>,
    /// Words per day the author commits to, as stored. 0 turns it off.
    pub daily_word_target_set: Option<i64>,
}

impl BookMeta {
    /// The book's word target, the default when never set; `None` when the
    /// author turned it off (0).
    pub fn word_target(&self) -> Option<i64> {
        match self.word_target_set.unwrap_or(DEFAULT_WORD_TARGET) {
            0 => None,
            n => Some(n.max(0)),
        }
    }

    /// The daily word goal, the default when never set; `None` when off.
    /// Today's words come from the writing days, never from a stored total.
    pub fn daily_word_target(&self) -> Option<i64> {
        match self
            .daily_word_target_set
            .unwrap_or(DEFAULT_DAILY_WORD_TARGET)
        {
            0 => None,
            n => Some(n.max(0)),
        }
    }
}

/// A chapter or an idea (the old `book_node` plus `node_storyline_link`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
    pub title: String,
    pub summary: String,
    /// Reading-order coordinate. Chapters only; readers ignore it on ideas.
    pub book_order: Option<f64>,
    /// Narrative-axis coordinate; `None` means not placed on the timeline.
    pub narrative_order: Option<f64>,
    pub status: NodeStatus,
    /// The idea group an idea sits in. Readers treat a group that no longer
    /// exists (and any group on a chapter) as the root.
    pub group: Option<DriftGroupId>,
    /// Position on the idea board.
    pub x: f64,
    pub y: f64,
    pub storylines: BTreeSet<StorylineId>,
    /// As stored; use [`Node::effective_primary_storyline`] to read it.
    pub primary_storyline: Option<StorylineId>,
    pub deleted_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    // No `updated_at`: it changes with every burst of typing and would make
    // each one a synced book write (the old client refreshed it on every
    // prose projection). "Last edited" comes from the local index (F2).
}

impl Node {
    pub fn is_chapter(&self) -> bool {
        self.kind == NodeKind::Chapter
    }

    pub fn is_drift(&self) -> bool {
        self.kind == NodeKind::Drift
    }

    pub fn is_trashed(&self) -> bool {
        self.deleted_at.is_some()
    }

    /// The book order readers use: chapters only (an idea's stray value is
    /// ignored).
    pub fn effective_book_order(&self) -> Option<f64> {
        if self.is_chapter() {
            self.book_order.filter(|o| o.is_finite())
        } else {
            None
        }
    }

    /// The primary storyline readers use: only if the node is still a member
    /// of it.
    pub fn effective_primary_storyline(&self) -> Option<&StorylineId> {
        self.primary_storyline
            .as_ref()
            .filter(|s| self.storylines.contains(*s))
    }

    /// The status readers show: the stored one if it fits the kind, the
    /// kind's default otherwise.
    pub fn effective_status(&self) -> NodeStatus {
        if self.status.fits(&self.kind) {
            self.status.clone()
        } else {
            NodeStatus::default_for(&self.kind)
        }
    }
}

/// An act (幕): a boundary on the book-order axis (the old `book_act`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Act {
    pub id: ActId,
    pub name: String,
    pub color: Option<String>,
    /// `None` is the optional book-head anchor.
    pub start_order: Option<f64>,
    /// An idea bound to this act as its notes.
    pub drift: Option<NodeId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Storyline {
    pub id: StorylineId,
    pub name: String,
    pub color: String,
    pub summary: String,
    pub pos: Option<PosKey>,
    pub facts: Vec<KvEntry>,
    /// The content template new chapters of this storyline start with, as the
    /// old JSON (see `f1-model-doc.md` "待协调").
    pub chapter_template: Option<String>,
    pub deleted_at: Option<Timestamp>,
}

/// An element category (分类; the old `element_category`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Category {
    pub id: CategoryId,
    pub name: String,
    pub color: String,
    pub layout: CategoryLayout,
    pub grid_x: Option<i64>,
    pub grid_y: Option<i64>,
    /// The content template new elements of this category start with, as the
    /// old JSON.
    pub element_template: Option<String>,
    pub template_fields: Vec<KvEntry>,
    pub deleted_at: Option<Timestamp>,
}

/// An element (要素).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Element {
    pub id: ElementId,
    pub name: String,
    pub summary: String,
    /// Readers treat a category that no longer exists as none.
    pub category: Option<CategoryId>,
    pub aliases: BTreeSet<String>,
    pub facts: Vec<KvEntry>,
    pub group_name: Option<String>,
    pub portrait: Option<AssetId>,
    /// Where the author pinned the element in the relation graph (要素全景的
    /// 关系布局), if they did. Layout the simulation computes is not stored.
    pub relate_pin: Option<(f64, f64)>,
    pub deleted_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    /// Set by readers when this element's name or an alias collides with an
    /// earlier element (by creation time, then id): the element that keeps
    /// the name. Commands prevent this; a merge can still produce it.
    pub name_conflict: Option<ElementId>,
}

/// The key element names and aliases are compared by: trimmed, lowercased
/// (the old `findElementNameConflict`). Empty names never conflict.
pub fn element_name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// An element patch: a chapter passage attached to an element.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Patch {
    pub id: PatchId,
    pub element: ElementId,
    pub source_node: Option<NodeId>,
    pub source_block: Option<BlockId>,
    /// The passage as it was when attached.
    pub source_text: Option<String>,
    /// Where the passage is now, in `source_node`'s prose document.
    pub anchor: Option<EncodedAnchor>,
    pub invalidated_at: Option<Timestamp>,
    pub title: Option<String>,
    /// Plain text of the patch body (a rich text in the book document).
    pub body: String,
    pub pos: Option<PosKey>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationType {
    pub id: RelationTypeId,
    pub name: String,
    pub normalized_name: String,
    pub description: String,
    pub orientation: RelationOrientation,
    pub system_key: Option<SystemRelationKey>,
    /// Built-in and locked: commands refuse to change or delete it.
    pub locked: bool,
    pub source_role: String,
    pub target_role: String,
    /// Display colour of the relation's edges (the old client kept it only on
    /// the device, `drifting:edge-kind-meta`).
    pub color: Option<String>,
    /// Entity kinds allowed at each end; empty means any allowed kind.
    pub source_kinds: Vec<EntityKind>,
    pub target_kinds: Vec<EntityKind>,
}

/// Normalize a relation-type name the way uniqueness is judged, exactly as
/// the old `normalizeRelationTypeName`: trimmed, ASCII letters lowercased
/// (SQLite's `lower()` is ASCII-only, so the old data was normalized that
/// way; other letters keep their case).
pub fn normalize_relation_type_name(name: &str) -> String {
    name.trim().to_ascii_lowercase()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relation {
    pub id: RelationId,
    pub from: EntityRef,
    pub to: EntityRef,
    pub relation_type: RelationTypeId,
    pub created_at: Option<Timestamp>,
}

/// Canonical endpoint order of a symmetric relation: the smaller (kind, id)
/// first, so the same pair is stored one way on every device.
pub fn canonical_symmetric(a: EntityRef, b: EntityRef) -> (EntityRef, EntityRef) {
    let ka = (a.kind.as_str().to_string(), a.id.clone());
    let kb = (b.kind.as_str().to_string(), b.id.clone());
    if ka <= kb { (a, b) } else { (b, a) }
}

/// A time pin (时间钉) on the narrative axis (the old `timeline_marker`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimePin {
    pub id: TimePinId,
    pub narrative_order: f64,
    pub label: String,
    /// An idea bound to this pin.
    pub drift: Option<NodeId>,
}

/// A row or column of a plot grid.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlotLine<Id> {
    pub id: Id,
    /// Fractional-index key (the old `position_key`); sorted bytewise, ties
    /// by id, a missing one last.
    pub pos: Option<PosKey>,
    pub label: String,
}

/// A chapter's plot grid (情节规划; the old `plot_grid_*` tables). Keyed by
/// the chapter's id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlotGrid {
    pub chapter: NodeId,
    pub cell_w: f64,
    pub cell_h: f64,
    /// Sorted by `pos`, ties by id.
    pub rows: Vec<PlotLine<PlotRowId>>,
    pub cols: Vec<PlotLine<PlotColId>>,
    /// Cell text; a cell whose row or column is gone is not listed.
    pub cells: BTreeMap<(PlotRowId, PlotColId), String>,
}

/// Plot-grid cell size limits (old `plot_grid_document_size_check`).
pub const PLOT_CELL_W: std::ops::RangeInclusive<f64> = 120.0..=440.0;
pub const PLOT_CELL_H: std::ops::RangeInclusive<f64> = 56.0..=380.0;
/// The cell size a grid without a stored size reads as (the old default).
pub const PLOT_DEFAULT_CELL: (f64, f64) = (184.0, 96.0);
/// A new grid's rows, and its columns (`PlotRowId::default_for`).
pub const PLOT_DEFAULT_LINES: usize = 3;

/// A margin note or a TODO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Comment {
    pub id: CommentId,
    pub kind: CommentKind,
    /// `None` for a floating comment.
    pub target: Option<EntityRef>,
    /// Readers set this when `target` names an entity that no longer exists
    /// (or is in the trash): the comment is shown as unlocated, not lost.
    pub target_missing: bool,
    /// The block a block-level comment or TODO sits on (the old
    /// `target_block_id`; added in schema v1).
    pub target_block: Option<BlockId>,
    /// The anchored text, in the target's prose document.
    pub anchor: Option<EncodedAnchor>,
    /// The exact text that was selected, as it was then ("查看原文", and
    /// "原文已改" by comparing with the anchored text now).
    pub quote: Option<String>,
    /// Every block the selection spanned, as it was then.
    pub snapshots: Vec<BlockSnapshot>,
    /// A region on an image or a PDF page (comments on materials).
    pub region: Option<MaterialRegion>,
    pub author_kind: CommentAuthorKind,
    pub author: Option<String>,
    pub author_name: Option<String>,
    /// Plain text of the comment body (a rich text in the book document).
    pub body: String,
    pub status: CommentStatus,
    pub priority: Option<CommentPriority>,
    pub source: CommentSource,
    /// Opaque JSON, as the old `metadata_json`.
    pub metadata: Option<String>,
    /// The Agent conversation started from this TODO (the old
    /// `start_agent_task` comment action).
    pub agent_conversation: Option<String>,
    /// Set when the TODO is generated from prose (a `TODO:` marker or a
    /// material-note task line): which kind and which block. Its id is then
    /// [`CommentId::for_projection`].
    pub projection: Option<TodoProjection>,
    pub resolved_at: Option<Timestamp>,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
}

impl Comment {
    pub fn is_todo(&self) -> bool {
        self.kind == CommentKind::Todo
    }

    /// A TODO is done when resolved. Task lines linked to a TODO render this,
    /// never a checkbox state of their own.
    pub fn is_done(&self) -> bool {
        self.status == CommentStatus::Resolved
    }
}

/// One block's text when a comment was made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockSnapshot {
    pub block: Option<BlockId>,
    pub text: String,
}

/// A rectangle on an image, or on one page of a PDF, as fractions (0–1) of
/// the media box, so it survives display size and zoom (the old
/// `MaterialRegion`, v1).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterialRegion {
    /// 1-based PDF page; `None` for images.
    pub page: Option<u32>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl MaterialRegion {
    /// `None` unless the rectangle lies inside the box (the old
    /// `parseMaterialRegion`: each value 0–1, x + w and y + h at most 1,
    /// page ≥ 1).
    pub fn new(page: Option<u32>, x: f64, y: f64, w: f64, h: f64) -> Option<Self> {
        let unit = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
        if !(unit(x) && unit(y) && unit(w) && unit(h)) || x + w > 1.000001 || y + h > 1.000001 {
            return None;
        }
        if page == Some(0) {
            return None;
        }
        Some(Self { page, x, y, w, h })
    }
}

/// Where a generated TODO came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoProjection {
    pub kind: ProjectionKind,
    /// The block of the marker or the task line.
    pub block: BlockId,
}

/// A material (素材; the old `library_item`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Material {
    pub id: MaterialId,
    pub title: String,
    pub kind: MaterialKind,
    /// Image and PDF materials only.
    pub asset: Option<AssetId>,
    /// Readers treat a folder that no longer exists as the root.
    pub folder: Option<MaterialFolderId>,
    pub pos: Option<PosKey>,
    /// A text material's checklist items project into TODOs.
    pub task_todos: bool,
    /// Opaque JSON, as the old `provenance_json`.
    pub provenance: Option<String>,
    /// What the material is about, as plain text (the old `notes_json`).
    /// The Agent writes it; search reads it.
    pub description: String,
}

/// An asset's metadata. The bytes are in SQLite / files, addressed by sha256;
/// metadata is written once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Asset {
    pub id: AssetId,
    pub kind: AssetKind,
    pub mime: String,
    pub size: i64,
    /// Lowercase hex, 64 characters.
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// Whether `s` is a lowercase 64-character hex sha256.
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// An idea group (构想分组): a node of the `drift_groups` tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DriftGroup {
    pub id: DriftGroupId,
    pub name: String,
    pub color: Option<String>,
    /// `None` at the root.
    pub parent: Option<DriftGroupId>,
}

/// A material folder (素材夹): a node of the `material_folders` tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterialFolder {
    pub id: MaterialFolderId,
    pub name: String,
    pub parent: Option<MaterialFolderId>,
}

/// A Project Memory entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Memory {
    pub id: MemoryId,
    pub kind: MemoryKind,
    pub body: String,
    pub target: Option<EntityRef>,
    pub target_block: Option<BlockId>,
    pub source: MemorySource,
    pub origin_ref: Option<String>,
    pub status: MemoryStatus,
    pub supersedes: Option<MemoryId>,
    pub deleted_at: Option<Timestamp>,
}

/// Words one device added to the book on one day of its own calendar. A
/// day's total is the sum over devices; each device writes only its own key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritingDay {
    pub device: DeviceKey,
    pub day: Day,
    pub words: i64,
}

impl WritingDay {
    /// The key in `writing_days`: `"<device>|<date>"`.
    pub fn key(device: &DeviceKey, day: &Day) -> String {
        format!("{}|{}", device.as_str(), day.as_str())
    }

    /// Split a `writing_days` key; `None` for a malformed one.
    pub fn parse_key(key: &str) -> Option<(DeviceKey, Day)> {
        let (d, day) = key.split_once('|')?;
        Some((DeviceKey::parse(d).ok()?, Day::parse(day)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(kind: NodeKind) -> Node {
        Node {
            id: NodeId::parse("n").unwrap(),
            kind,
            title: String::new(),
            summary: String::new(),
            book_order: Some(5.0),
            narrative_order: None,
            status: NodeStatus::Finished,
            group: None,
            x: 0.0,
            y: 0.0,
            storylines: BTreeSet::new(),
            primary_storyline: Some(StorylineId::parse("s").unwrap()),
            deleted_at: None,
            created_at: None,
        }
    }

    #[test]
    fn read_tolerance_on_nodes() {
        let mut n = node(NodeKind::Drift);
        assert_eq!(
            n.effective_book_order(),
            None,
            "an idea's book order is ignored"
        );
        assert_eq!(n.effective_status(), NodeStatus::Drifting);
        assert_eq!(n.effective_primary_storyline(), None, "not a member");
        n.kind = NodeKind::Chapter;
        n.storylines.insert(StorylineId::parse("s").unwrap());
        assert_eq!(n.effective_book_order(), Some(5.0));
        assert_eq!(n.effective_status(), NodeStatus::Finished);
        assert!(n.effective_primary_storyline().is_some());
        n.book_order = Some(f64::NAN);
        assert_eq!(n.effective_book_order(), None);
    }

    #[test]
    fn symmetric_endpoints_are_canonical() {
        let a = EntityRef::new(EntityKind::Element, "b");
        let b = EntityRef::new(EntityKind::Element, "a");
        let (x, y) = canonical_symmetric(a.clone(), b.clone());
        assert_eq!((x.id.as_str(), y.id.as_str()), ("a", "b"));
        assert_eq!(canonical_symmetric(b, a), (x, y));
    }

    #[test]
    fn relation_type_names_normalize() {
        assert_eq!(
            normalize_relation_type_name("  Friend   OF "),
            "friend   of"
        );
        assert_eq!(normalize_relation_type_name("师徒"), "师徒");
        assert_eq!(normalize_relation_type_name("ÉCOLE"), "École");
    }

    #[test]
    fn writing_day_keys() {
        let d = DeviceKey::parse("mac-1").unwrap();
        let day = Day::parse("2026-11-07").unwrap();
        let k = WritingDay::key(&d, &day);
        assert_eq!(k, "mac-1|2026-11-07");
        assert_eq!(WritingDay::parse_key(&k), Some((d, day)));
        assert_eq!(WritingDay::parse_key("x"), None);
        assert_eq!(WritingDay::parse_key("a|2026-13-01"), None);
    }

    #[test]
    fn word_targets_default_and_turn_off() {
        let mut m = BookMeta {
            id: BookId::parse("b").unwrap(),
            schema_version: 2,
            name: String::new(),
            summary: String::new(),
            deleted_at: None,
            created_at: None,
            storyline_template: Vec::new(),
            word_target_set: None,
            daily_word_target_set: None,
        };
        assert_eq!(m.word_target(), Some(DEFAULT_WORD_TARGET));
        assert_eq!(m.daily_word_target(), Some(DEFAULT_DAILY_WORD_TARGET));
        m.word_target_set = Some(0);
        m.daily_word_target_set = Some(800);
        assert_eq!(m.word_target(), None);
        assert_eq!(m.daily_word_target(), Some(800));
    }

    #[test]
    fn regions_and_name_keys() {
        // The old parseMaterialRegion's accepted and rejected cases.
        assert!(MaterialRegion::new(None, 0.1, 0.2, 0.3, 0.4).is_some());
        assert!(MaterialRegion::new(Some(3), 0.0, 0.0, 1.0, 1.0).is_some());
        assert!(MaterialRegion::new(None, 0.8, 0.0, 0.5, 0.1).is_none());
        assert!(MaterialRegion::new(None, -0.1, 0.0, 0.1, 0.1).is_none());
        assert!(MaterialRegion::new(Some(0), 0.0, 0.0, 0.1, 0.1).is_none());
        assert_eq!(element_name_key("  Anna "), "anna");
        assert_eq!(element_name_key("安娜"), "安娜");
    }

    #[test]
    fn sha256_shape() {
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(!is_sha256_hex(&"A".repeat(64)));
        assert!(!is_sha256_hex("abc"));
    }
}
