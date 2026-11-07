//! Reading the staged 0.1 library: authored rows, prose caches and the
//! evidence of how fresh each cache is. Column names are the last 0.1
//! schema's (`drizzle/`); everything reads the staging copy.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{Connection, Row, params};
use serde::Serialize;

use crate::error::Result;
use crate::handoff::{self, Stamp, sha256_hex};

/// The staged library, read-only.
pub struct Legacy {
    pub conn: Connection,
    pub stamp: Option<Stamp>,
}

impl Legacy {
    pub fn new(conn: Connection) -> Result<Self> {
        let stamp = handoff::read(&conn)?;
        Ok(Self { conn, stamp })
    }

    fn rows<T>(
        &self,
        sql: &str,
        p: impl rusqlite::Params,
        f: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
    ) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare(sql)?;
        let out = stmt
            .query_map(p, f)?
            .collect::<rusqlite::Result<Vec<T>>>()?;
        Ok(out)
    }

    /// Row counts of every table, for the receipt.
    pub fn table_counts(&self) -> Result<BTreeMap<String, i64>> {
        let names: Vec<String> = self.rows(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            [],
            |r| r.get(0),
        )?;
        let mut out = BTreeMap::new();
        for name in names {
            let n: i64 =
                self.conn
                    .query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |r| {
                        r.get(0)
                    })?;
            out.insert(name, n);
        }
        Ok(out)
    }

    pub fn projects(&self) -> Result<Vec<ProjectRow>> {
        self.rows(
            "SELECT id, name, summary, created_at, updated_at, deleted_at FROM project ORDER BY created_at, id",
            [],
            |r| {
                Ok(ProjectRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    summary: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    deleted_at: r.get(5)?,
                })
            },
        )
    }

    /// Facts the import must surface before it writes.
    pub fn sync_blockers(&self) -> Result<SyncBlockers> {
        let open = |sql: &str| -> Result<i64> { Ok(self.conn.query_row(sql, [], |r| r.get(0))?) };
        Ok(SyncBlockers {
            open_conflicts: open("SELECT count(*) FROM sync_conflict WHERE resolved_at IS NULL")?,
            open_frontier_gaps: open(
                "SELECT count(*) FROM sync_frontier_gap WHERE resolved_at IS NULL",
            )?,
            quarantined_objects: open(
                "SELECT count(*) FROM sync_quarantined_object WHERE resolved_at IS NULL",
            )?,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBlockers {
    pub open_conflicts: i64,
    pub open_frontier_gaps: i64,
    pub quarantined_objects: i64,
}

impl SyncBlockers {
    pub fn any(&self) -> bool {
        self.open_conflicts + self.open_frontier_gaps + self.quarantined_objects > 0
    }
}

#[derive(Clone, Debug)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

// ---- prose bodies and how fresh their caches are --------------------------

/// The five owners of a prose body and their Yjs document prefixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProseKind {
    NodeContent,
    Element,
    Storyline,
    Category,
    LibraryItem,
}

impl ProseKind {
    pub const ALL: [ProseKind; 5] = [
        Self::NodeContent,
        Self::Element,
        Self::Storyline,
        Self::Category,
        Self::LibraryItem,
    ];

    /// The 0.1 Yjs document id prefix.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::NodeContent => "node-content",
            Self::Element => "element",
            Self::Storyline => "storyline",
            Self::Category => "category",
            Self::LibraryItem => "library-item",
        }
    }

    /// The schema v2 document id prefix.
    pub fn new_prefix(self) -> &'static str {
        match self {
            Self::NodeContent => "node",
            Self::Element => "element",
            Self::Storyline => "storyline",
            Self::Category => "category",
            Self::LibraryItem => "material",
        }
    }

    pub fn from_doc_id(doc_id: &str) -> Option<(Self, &str)> {
        let (prefix, id) = doc_id.split_once(':')?;
        Self::ALL
            .into_iter()
            .find(|k| k.prefix() == prefix)
            .map(|k| (k, id))
    }

    fn owner_sql(self) -> &'static str {
        match self {
            Self::NodeContent => {
                "SELECT n.id, n.project_id, c.content_json, n.word_count_basis_kind, n.word_count_basis_revision, n.updated_at \
                 FROM book_node n LEFT JOIN node_content c ON c.node_id = n.id"
            }
            Self::Element => {
                "SELECT id, project_id, content_json, NULL, NULL, updated_at FROM element"
            }
            Self::Storyline => {
                "SELECT id, project_id, content_json, NULL, NULL, updated_at FROM storylines"
            }
            Self::Category => {
                "SELECT id, project_id, content_json, NULL, NULL, updated_at FROM element_category"
            }
            Self::LibraryItem => {
                "SELECT id, project_id, body_json, NULL, NULL, updated_at FROM library_item WHERE kind = 'text'"
            }
        }
    }
}

/// How far a cached body can be trusted without reading Yjs (P0-E,
/// `docs/rust-rewrite/spikes/p0-e-import.md` "新鲜度").
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Freshness {
    /// No Yjs document: the cache is the body (notes never opened).
    SeedOnly,
    /// One update, revision 1: the creation seed, written with the cache.
    CreationSeed,
    /// A chapter or idea whose word-count basis was derived at the current
    /// revision, in the same transaction as the cache.
    NodeBasisCurrent,
    /// The handoff verified the cache at the current revision and its hash
    /// still matches.
    Handoff,
    /// The handoff stamped this revision but the cache changed since.
    HandoffMismatch,
    /// Proven stale: the chapter's basis revision is behind.
    NodeBasisBehind,
    /// Changed after creation; nothing records which revision the cache shows.
    Unproven,
}

impl Freshness {
    pub fn proven_fresh(self) -> bool {
        matches!(
            self,
            Self::SeedOnly | Self::CreationSeed | Self::NodeBasisCurrent | Self::Handoff
        )
    }
}

/// A prose body as the import sees it.
#[derive(Clone, Debug)]
pub struct ProseOwner {
    pub kind: ProseKind,
    pub id: String,
    pub project_id: String,
    pub cache: Option<String>,
    pub updated_at: String,
    pub updates: i64,
    pub snapshot: bool,
    pub revision: Option<i64>,
    pub freshness: Freshness,
}

impl ProseOwner {
    /// The 0.1 Yjs document id.
    pub fn old_doc_id(&self) -> String {
        format!("{}:{}", self.kind.prefix(), self.id)
    }

    /// The schema v2 document id.
    pub fn new_doc_id(&self) -> String {
        format!("{}:{}", self.kind.new_prefix(), self.id)
    }

    pub fn cache_sha256(&self) -> Option<String> {
        self.cache.as_deref().map(sha256_hex)
    }
}

/// Yjs rows nobody owns.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDocs {
    /// The owner row is gone (deleting a material keeps its Yjs rows).
    pub owner_missing: usize,
    pub unknown_prefix: usize,
}

impl Legacy {
    /// Every prose body with its freshness, and the Yjs rows nobody owns.
    pub fn prose_owners(&self) -> Result<(Vec<ProseOwner>, OrphanDocs)> {
        let mut updates: HashMap<String, i64> = HashMap::new();
        for (doc, n) in self.rows(
            "SELECT document_id, count(*) FROM yjs_updates GROUP BY document_id",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )? {
            updates.insert(doc, n);
        }
        let snapshots: HashSet<String> = self
            .rows("SELECT document_id FROM yjs_snapshots", [], |r| r.get(0))?
            .into_iter()
            .collect();
        let revisions: HashMap<String, i64> = self
            .rows(
                "SELECT document_id, revision FROM yjs_document_revision",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )?
            .into_iter()
            .collect();
        let stamped = self.stamp.as_ref().map(|s| &s.documents);
        let mut owners = Vec::new();
        let mut known = HashSet::new();
        for kind in ProseKind::ALL {
            let rows = self.rows(kind.owner_sql(), [], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?;
            for (id, project_id, cache, basis_kind, basis_revision, updated_at) in rows {
                let doc_id = format!("{}:{}", kind.prefix(), id);
                let update_count = updates.get(&doc_id).copied().unwrap_or(0);
                let snapshot = snapshots.contains(&doc_id);
                let revision = revisions.get(&doc_id).copied();
                let entry = stamped
                    .and_then(|d| d.get(&doc_id))
                    .filter(|e| Some(e.revision) == revision);
                let freshness = if update_count == 0 && !snapshot {
                    Freshness::SeedOnly
                } else if let Some(entry) = entry {
                    // The handoff verified this very revision. A different
                    // hash means the cache changed afterwards without a Yjs
                    // change: trust nothing weaker.
                    if cache
                        .as_deref()
                        .is_some_and(|c| sha256_hex(c) == entry.sha256)
                    {
                        Freshness::Handoff
                    } else {
                        Freshness::HandoffMismatch
                    }
                } else if kind == ProseKind::NodeContent
                    && basis_kind.as_deref() == Some("yjs")
                    && basis_revision.is_some()
                {
                    if basis_revision == revision {
                        Freshness::NodeBasisCurrent
                    } else {
                        Freshness::NodeBasisBehind
                    }
                } else if update_count == 1 && !snapshot && revision == Some(1) {
                    Freshness::CreationSeed
                } else {
                    Freshness::Unproven
                };
                known.insert(doc_id);
                owners.push(ProseOwner {
                    kind,
                    id,
                    project_id,
                    cache,
                    updated_at,
                    updates: update_count,
                    snapshot,
                    revision,
                    freshness,
                });
            }
        }
        let mut orphans = OrphanDocs::default();
        let all: HashSet<&String> = updates.keys().chain(snapshots.iter()).collect();
        for doc in all {
            if known.contains(doc) {
                continue;
            }
            match ProseKind::from_doc_id(doc) {
                Some(_) => orphans.owner_missing += 1,
                None => orphans.unknown_prefix += 1,
            }
        }
        owners.sort_by(|a, b| (a.kind, &a.id).cmp(&(b.kind, &b.id)));
        Ok((owners, orphans))
    }
}

// ---- snapshot history ------------------------------------------------------

/// One row of `entity_snapshot_history`. The preview (`content_json`) is the
/// body rendered from `state_blob` when it was captured, so history replays
/// without Yjs.
#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub id: String,
    pub project_id: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub created_at: String,
    pub preview: Option<String>,
    pub meta: Option<String>,
}

impl HistoryRow {
    /// The 0.1 document id it belongs to.
    pub fn old_doc_id(&self) -> String {
        let prefix = match self.entity_kind.as_str() {
            "node" => "node-content",
            "library_item" | "library-item" => "library-item",
            other => other,
        };
        format!("{prefix}:{}", self.entity_id)
    }
}

impl Legacy {
    pub fn history(&self) -> Result<Vec<HistoryRow>> {
        self.rows(
            "SELECT id, project_id, entity_kind, entity_id, created_at, content_json, meta_json FROM entity_snapshot_history ORDER BY entity_kind, entity_id, created_at, id",
            [],
            |r| {
                Ok(HistoryRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    entity_kind: r.get(2)?,
                    entity_id: r.get(3)?,
                    created_at: r.get(4)?,
                    preview: r.get(5)?,
                    meta: r.get(6)?,
                })
            },
        )
    }
}

// ---- authored rows of one book ----------------------------------------------

#[derive(Clone, Debug)]
pub struct NodeRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub book_order: Option<f64>,
    pub narrative_order: Option<f64>,
    pub status: String,
    pub group: Option<String>,
    pub x: f64,
    pub y: f64,
    pub deleted_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct ActRow {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub start_order: Option<f64>,
    pub drift: Option<String>,
}

#[derive(Clone, Debug)]
pub struct StorylineRow {
    pub id: String,
    pub name: String,
    pub color: String,
    pub summary: String,
    pub order_key: i64,
    pub template: String,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LinkRow {
    pub node: String,
    pub storyline: String,
    pub primary: bool,
}

#[derive(Clone, Debug)]
pub struct ElementRow {
    pub id: String,
    pub category: Option<String>,
    pub name: String,
    pub summary: String,
    pub kv_json: String,
    pub aliases_json: String,
    pub group_name: Option<String>,
    pub portrait: Option<String>,
    pub deleted_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct CategoryRow {
    pub id: String,
    pub name: String,
    pub color: String,
    pub layout: String,
    pub grid_x: Option<i64>,
    pub grid_y: Option<i64>,
    pub template_json: Option<String>,
    pub template_kv_json: String,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct KvRow {
    pub id: String,
    pub owner_kind: String,
    pub owner_id: String,
    pub namespace: String,
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct RelationTypeRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub orientation: String,
    pub system_key: Option<String>,
    pub locked: bool,
    pub source_role: String,
    pub target_role: String,
}

#[derive(Clone, Debug)]
pub struct EndpointRow {
    pub relation_type: String,
    pub side: String,
    pub kind: String,
}

#[derive(Clone, Debug)]
pub struct RelationRow {
    pub id: String,
    pub from_kind: String,
    pub from_id: String,
    pub to_kind: String,
    pub to_id: String,
    pub relation_type: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct TimePinRow {
    pub id: String,
    pub narrative_order: f64,
    pub label: String,
    pub drift: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PlotDocRow {
    pub id: String,
    pub node: String,
    pub cell_w: f64,
    pub cell_h: f64,
}

#[derive(Clone, Debug)]
pub struct PlotLineRow {
    pub id: String,
    pub document: String,
    pub pos: String,
    pub label: String,
}

#[derive(Clone, Debug)]
pub struct PlotCellRow {
    pub document: String,
    pub row: String,
    pub col: String,
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct CommentRow {
    pub id: String,
    pub kind: String,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub target_block_id: Option<String>,
    pub target_block_ids_json: String,
    pub anchor_json: String,
    pub author_kind: String,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub body_json: String,
    pub status: String,
    pub priority: Option<String>,
    pub source: String,
    pub metadata_json: Option<String>,
    pub resolved_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct CommentActionRow {
    pub id: String,
    pub comment: String,
    pub kind: String,
    pub payload_json: String,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct PatchRow {
    pub id: String,
    pub element: String,
    pub source_node: Option<String>,
    pub source_block: Option<String>,
    pub source_text: Option<String>,
    pub text_anchor_json: Option<String>,
    pub invalidated_at: Option<String>,
    pub title: Option<String>,
    pub content_json: String,
    pub order_key: i64,
}

#[derive(Clone, Debug)]
pub struct MaterialRow {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub asset: Option<String>,
    pub notes_json: Option<String>,
    pub order_key: i64,
    pub provenance_json: Option<String>,
    pub folder: Option<String>,
    pub task_todos: bool,
}

#[derive(Clone, Debug)]
pub struct TreeRow {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub color: Option<String>,
    pub order: Option<f64>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct MemoryRow {
    pub id: String,
    pub kind: String,
    pub body: String,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub target_block: Option<String>,
    pub source: String,
    pub origin_ref: Option<String>,
    pub status: String,
    pub supersedes: Option<String>,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct WritingDayRow {
    pub day: String,
    pub device_key: String,
    pub words: i64,
}

#[derive(Clone, Debug)]
pub struct AssetRow {
    pub id: String,
    pub kind: String,
    pub mime: String,
    pub size: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// Every authored row of one book.
#[derive(Clone, Debug, Default)]
pub struct BookRows {
    pub nodes: Vec<NodeRow>,
    pub acts: Vec<ActRow>,
    pub storylines: Vec<StorylineRow>,
    pub links: Vec<LinkRow>,
    pub elements: Vec<ElementRow>,
    pub categories: Vec<CategoryRow>,
    pub kv: Vec<KvRow>,
    pub project_kv_json: String,
    pub project_template_kv_json: String,
    pub storyline_kv_json: HashMap<String, String>,
    pub relation_types: Vec<RelationTypeRow>,
    pub endpoints: Vec<EndpointRow>,
    pub relations: Vec<RelationRow>,
    pub time_pins: Vec<TimePinRow>,
    pub plot_docs: Vec<PlotDocRow>,
    pub plot_rows: Vec<PlotLineRow>,
    pub plot_cols: Vec<PlotLineRow>,
    pub plot_cells: Vec<PlotCellRow>,
    pub comments: Vec<CommentRow>,
    pub comment_actions: Vec<CommentActionRow>,
    pub patches: Vec<PatchRow>,
    pub materials: Vec<MaterialRow>,
    pub folders: Vec<TreeRow>,
    pub groups: Vec<TreeRow>,
    pub memory: Vec<MemoryRow>,
    pub writing_days: Vec<WritingDayRow>,
    pub assets: Vec<AssetRow>,
}

impl Legacy {
    pub fn book(&self, project: &str) -> Result<BookRows> {
        let p = params![project];
        let (project_kv_json, project_template_kv_json): (String, String) = self.conn.query_row(
            "SELECT kv_json, storyline_template_kv_json FROM project WHERE id = ?1",
            p,
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut b = BookRows {
            project_kv_json,
            project_template_kv_json,
            ..BookRows::default()
        };
        b.nodes = self.rows(
            "SELECT id, kind, title, summary, book_order, narrative_order, writing_status, drift_group_id, position_x, position_y, deleted_at, created_at FROM book_node WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(NodeRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    title: r.get(2)?,
                    summary: r.get(3)?,
                    book_order: r.get(4)?,
                    narrative_order: r.get(5)?,
                    status: r.get(6)?,
                    group: r.get(7)?,
                    x: r.get(8)?,
                    y: r.get(9)?,
                    deleted_at: r.get(10)?,
                    created_at: r.get(11)?,
                })
            },
        )?;
        b.acts = self.rows(
            "SELECT id, name, color, start_order, drift_node_id FROM book_act WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(ActRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                    start_order: r.get(3)?,
                    drift: r.get(4)?,
                })
            },
        )?;
        let storylines = self.rows(
            "SELECT id, name, color, summary, order_key, node_content_template_json, deleted_at, kv_json FROM storylines WHERE project_id = ?1 ORDER BY order_key, id",
            p,
            |r| {
                Ok((
                    StorylineRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        color: r.get(2)?,
                        summary: r.get(3)?,
                        order_key: r.get(4)?,
                        template: r.get(5)?,
                        deleted_at: r.get(6)?,
                    },
                    r.get::<_, String>(7)?,
                ))
            },
        )?;
        for (s, kv) in storylines {
            b.storyline_kv_json.insert(s.id.clone(), kv);
            b.storylines.push(s);
        }
        b.links = self.rows(
            "SELECT l.node_id, l.storyline_id, l.is_primary FROM node_storyline_link l JOIN book_node n ON n.id = l.node_id WHERE n.project_id = ?1 ORDER BY l.node_id, l.storyline_id",
            p,
            |r| {
                Ok(LinkRow {
                    node: r.get(0)?,
                    storyline: r.get(1)?,
                    primary: r.get::<_, i64>(2)? != 0,
                })
            },
        )?;
        b.elements = self.rows(
            "SELECT id, category_id, name, summary, kv_json, aliases_json, group_name, portrait_asset_id, deleted_at, created_at FROM element WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(ElementRow {
                    id: r.get(0)?,
                    category: r.get(1)?,
                    name: r.get(2)?,
                    summary: r.get(3)?,
                    kv_json: r.get(4)?,
                    aliases_json: r.get(5)?,
                    group_name: r.get(6)?,
                    portrait: r.get(7)?,
                    deleted_at: r.get(8)?,
                    created_at: r.get(9)?,
                })
            },
        )?;
        b.categories = self.rows(
            "SELECT id, name, color, layout_mode, grid_x, grid_y, element_template_json, element_template_kv_json, deleted_at FROM element_category WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(CategoryRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                    layout: r.get(3)?,
                    grid_x: r.get(4)?,
                    grid_y: r.get(5)?,
                    template_json: r.get(6)?,
                    template_kv_json: r.get(7)?,
                    deleted_at: r.get(8)?,
                })
            },
        )?;
        b.kv = self.rows(
            "SELECT id, owner_kind, owner_id, namespace, key, value FROM entity_kv_entry WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(KvRow {
                    id: r.get(0)?,
                    owner_kind: r.get(1)?,
                    owner_id: r.get(2)?,
                    namespace: r.get(3)?,
                    key: r.get(4)?,
                    value: r.get(5)?,
                })
            },
        )?;
        b.relation_types = self.rows(
            "SELECT id, name, description, orientation, system_key, locked, source_role, target_role FROM entity_relation_type WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(RelationTypeRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    orientation: r.get(3)?,
                    system_key: r.get(4)?,
                    locked: r.get::<_, i64>(5)? != 0,
                    source_role: r.get(6)?,
                    target_role: r.get(7)?,
                })
            },
        )?;
        b.endpoints = self.rows(
            "SELECT k.relation_type_id, k.side, k.entity_kind FROM entity_relation_type_endpoint_kind k JOIN entity_relation_type t ON t.id = k.relation_type_id WHERE t.project_id = ?1 ORDER BY 1, 2, 3",
            p,
            |r| {
                Ok(EndpointRow {
                    relation_type: r.get(0)?,
                    side: r.get(1)?,
                    kind: r.get(2)?,
                })
            },
        )?;
        b.relations = self.rows(
            "SELECT id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at FROM entity_relation WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(RelationRow {
                    id: r.get(0)?,
                    from_kind: r.get(1)?,
                    from_id: r.get(2)?,
                    to_kind: r.get(3)?,
                    to_id: r.get(4)?,
                    relation_type: r.get(5)?,
                    created_at: r.get(6)?,
                })
            },
        )?;
        b.time_pins = self.rows(
            "SELECT id, narrative_order, label, drift_node_id FROM timeline_marker WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(TimePinRow {
                    id: r.get(0)?,
                    narrative_order: r.get(1)?,
                    label: r.get(2)?,
                    drift: r.get(3)?,
                })
            },
        )?;
        b.plot_docs = self.rows(
            "SELECT d.id, d.node_id, d.cell_width, d.cell_height FROM plot_grid_document d JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1 ORDER BY d.id",
            p,
            |r| {
                Ok(PlotDocRow {
                    id: r.get(0)?,
                    node: r.get(1)?,
                    cell_w: r.get(2)?,
                    cell_h: r.get(3)?,
                })
            },
        )?;
        let line = |table: &str| -> Result<Vec<PlotLineRow>> {
            self.rows(
                &format!(
                    "SELECT x.id, x.document_id, x.position_key, x.label FROM {table} x JOIN plot_grid_document d ON d.id = x.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1 ORDER BY x.id"
                ),
                p,
                |r| {
                    Ok(PlotLineRow {
                        id: r.get(0)?,
                        document: r.get(1)?,
                        pos: r.get(2)?,
                        label: r.get(3)?,
                    })
                },
            )
        };
        b.plot_rows = line("plot_grid_row")?;
        b.plot_cols = line("plot_grid_column")?;
        b.plot_cells = self.rows(
            "SELECT c.document_id, c.row_id, c.column_id, c.value FROM plot_grid_cell c JOIN plot_grid_document d ON d.id = c.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1 ORDER BY c.id",
            p,
            |r| {
                Ok(PlotCellRow {
                    document: r.get(0)?,
                    row: r.get(1)?,
                    col: r.get(2)?,
                    value: r.get(3)?,
                })
            },
        )?;
        b.comments = self.rows(
            "SELECT id, kind, target_kind, target_id, target_block_id, target_block_ids_json, anchor_json, author_kind, author_id, author_name, body_json, status, priority, source, metadata_json, resolved_at, created_at, updated_at FROM comment WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(CommentRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    target_kind: r.get(2)?,
                    target_id: r.get(3)?,
                    target_block_id: r.get(4)?,
                    target_block_ids_json: r.get(5)?,
                    anchor_json: r.get(6)?,
                    author_kind: r.get(7)?,
                    author_id: r.get(8)?,
                    author_name: r.get(9)?,
                    body_json: r.get(10)?,
                    status: r.get(11)?,
                    priority: r.get(12)?,
                    source: r.get(13)?,
                    metadata_json: r.get(14)?,
                    resolved_at: r.get(15)?,
                    created_at: r.get(16)?,
                    updated_at: r.get(17)?,
                })
            },
        )?;
        b.comment_actions = self.rows(
            "SELECT id, comment_id, kind, payload_json, status FROM comment_action WHERE project_id = ?1 ORDER BY created_at, id",
            p,
            |r| {
                Ok(CommentActionRow {
                    id: r.get(0)?,
                    comment: r.get(1)?,
                    kind: r.get(2)?,
                    payload_json: r.get(3)?,
                    status: r.get(4)?,
                })
            },
        )?;
        b.patches = self.rows(
            "SELECT id, element_id, source_node_id, source_block_id, source_block_text, text_anchor_json, invalidated_at, title, content_json, order_key FROM element_patch WHERE project_id = ?1 ORDER BY element_id, order_key, id",
            p,
            |r| {
                Ok(PatchRow {
                    id: r.get(0)?,
                    element: r.get(1)?,
                    source_node: r.get(2)?,
                    source_block: r.get(3)?,
                    source_text: r.get(4)?,
                    text_anchor_json: r.get(5)?,
                    invalidated_at: r.get(6)?,
                    title: r.get(7)?,
                    content_json: r.get(8)?,
                    order_key: r.get(9)?,
                })
            },
        )?;
        b.materials = self.rows(
            "SELECT id, title, kind, asset_id, notes_json, order_key, provenance_json, folder_id, task_todos FROM library_item WHERE project_id = ?1 ORDER BY order_key, id",
            p,
            |r| {
                Ok(MaterialRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    kind: r.get(2)?,
                    asset: r.get(3)?,
                    notes_json: r.get(4)?,
                    order_key: r.get(5)?,
                    provenance_json: r.get(6)?,
                    folder: r.get(7)?,
                    task_todos: r.get::<_, i64>(8)? != 0,
                })
            },
        )?;
        b.folders = self.rows(
            "SELECT id, name, parent_folder_id, NULL, NULL, created_at FROM material_folder WHERE project_id = ?1 ORDER BY created_at, id",
            p,
            tree_row,
        )?;
        b.groups = self.rows(
            "SELECT id, name, parent_group_id, color, sort_order, created_at FROM drift_group WHERE project_id = ?1 ORDER BY sort_order IS NULL, sort_order, created_at, id",
            p,
            tree_row,
        )?;
        b.memory = self.rows(
            "SELECT id, kind, body, target_kind, target_id, target_block_id, source, origin_ref, status, supersedes_id, deleted_at FROM agent_memory WHERE project_id = ?1 ORDER BY created_at, id",
            p,
            |r| {
                Ok(MemoryRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    body: r.get(2)?,
                    target_kind: r.get(3)?,
                    target_id: r.get(4)?,
                    target_block: r.get(5)?,
                    source: r.get(6)?,
                    origin_ref: r.get(7)?,
                    status: r.get(8)?,
                    supersedes: r.get(9)?,
                    deleted_at: r.get(10)?,
                })
            },
        )?;
        b.writing_days = self.rows(
            "SELECT day, device_key, words FROM writing_day WHERE project_id = ?1 ORDER BY device_key, day",
            p,
            |r| {
                Ok(WritingDayRow {
                    day: r.get(0)?,
                    device_key: r.get(1)?,
                    words: r.get(2)?,
                })
            },
        )?;
        b.assets = self.rows(
            "SELECT id, kind, source_mime, source_size_bytes, source_sha256, width, height FROM project_asset WHERE project_id = ?1 ORDER BY id",
            p,
            |r| {
                Ok(AssetRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    mime: r.get(2)?,
                    size: r.get(3)?,
                    sha256: r.get(4)?,
                    width: r.get(5)?,
                    height: r.get(6)?,
                })
            },
        )?;
        Ok(b)
    }
}

fn tree_row(r: &Row<'_>) -> rusqlite::Result<TreeRow> {
    Ok(TreeRow {
        id: r.get(0)?,
        name: r.get(1)?,
        parent: r.get(2)?,
        color: r.get(3)?,
        order: r.get(4)?,
        created_at: r.get(5)?,
    })
}
