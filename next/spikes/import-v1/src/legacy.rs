//! Reading a 0.1.x library without Yjs: the SQLite rows, the `contentJson`
//! caches, and the evidence that says whether each cache is current.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

/// Migrations a library must have to be read by this mapping (0000–0018).
pub const SUPPORTED_MIGRATIONS: usize = 19;

/// Key the last 0.1.x release would write into `library_state` (see the spike
/// conclusion): `{ "documents": { "<docId>": <yjs revision> }, … }`.
pub const HANDOFF_KEY: &str = "v2-handoff";

pub struct Library {
    pub conn: Connection,
    pub migrations: usize,
}

impl Library {
    /// Open read-only. The importer itself must first copy the database with
    /// SQLite's backup API (which also reads the WAL) while the old app is closed.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("open {}", path.display()))?;
        let migrations: usize = conn
            .query_row("SELECT count(*) FROM __drizzle_migrations", [], |r| {
                r.get::<_, i64>(0)
            })
            .context("not a Drifting library")? as usize;
        if migrations > SUPPORTED_MIGRATIONS {
            bail!("library is from a newer 0.1.x ({migrations} migrations)");
        }
        Ok(Self { conn, migrations })
    }

    pub fn tables(&self) -> Result<Vec<(String, i64)>> {
        let mut statement = self
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name")?;
        let names: Vec<String> = statement
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        names
            .into_iter()
            .map(|name| {
                let count =
                    self.conn
                        .query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |r| {
                            r.get(0)
                        })?;
                Ok((name, count))
            })
            .collect()
    }

    pub fn projects(&self) -> Result<Vec<(String, String, bool)>> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, deleted_at IS NOT NULL FROM project ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn handoff(&self) -> Result<Option<HashMap<String, i64>>> {
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value_json FROM library_state WHERE key = ?",
                [HANDOFF_KEY],
                |r| r.get(0),
            )
            .optional()?;
        let Some(value) = value else { return Ok(None) };
        let parsed: Value = serde_json::from_str(&value)?;
        let documents = parsed
            .get("documents")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        Ok(Some(
            documents
                .into_iter()
                .filter_map(|(k, v)| v.as_i64().map(|r| (k, r)))
                .collect(),
        ))
    }
}

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

    pub fn prefix(self) -> &'static str {
        match self {
            Self::NodeContent => "node-content",
            Self::Element => "element",
            Self::Storyline => "storyline",
            Self::Category => "category",
            Self::LibraryItem => "library-item",
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
                "SELECT n.id, n.project_id, c.content_json, n.deleted_at IS NOT NULL, n.word_count_basis_kind, n.word_count_basis_revision \
                 FROM book_node n LEFT JOIN node_content c ON c.node_id = n.id"
            }
            Self::Element => {
                "SELECT id, project_id, content_json, deleted_at IS NOT NULL, NULL, NULL FROM element"
            }
            Self::Storyline => {
                "SELECT id, project_id, content_json, deleted_at IS NOT NULL, NULL, NULL FROM storylines"
            }
            Self::Category => {
                "SELECT id, project_id, content_json, deleted_at IS NOT NULL, NULL, NULL FROM element_category"
            }
            Self::LibraryItem => {
                "SELECT id, project_id, body_json, 0, NULL, NULL FROM library_item WHERE kind = 'text'"
            }
        }
    }
}

/// How much the cached body can be trusted without reading Yjs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Freshness {
    /// No Yjs document: the cache is the body (material notes never opened).
    SeedOnly,
    /// One update, revision 1: the creation seed, written with the cache in one transaction.
    CreationSeed,
    /// Chapter or idea whose word-count basis was derived at the current revision,
    /// in the same transaction as the cache.
    NodeBasisCurrent,
    /// The last 0.1.x release refreshed the cache at this revision.
    Handoff,
    /// Proven stale: the chapter's basis revision is behind its Yjs revision.
    NodeBasisBehind,
    /// Changed after creation and nothing records which revision the cache shows.
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

#[derive(Debug, Clone)]
pub struct ProseOwner {
    pub kind: ProseKind,
    pub id: String,
    pub project_id: String,
    pub cached: Option<String>,
    pub owner_deleted: bool,
    pub updates: i64,
    pub snapshot: bool,
    pub revision: Option<i64>,
    pub freshness: Freshness,
}

impl ProseOwner {
    pub fn doc_id(&self) -> String {
        format!("{}:{}", self.kind.prefix(), self.id)
    }
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDocs {
    /// Yjs rows whose owner row no longer exists (a deleted material keeps its rows).
    pub owner_missing: usize,
    /// Yjs documents with an unknown prefix.
    pub unknown_prefix: usize,
}

pub fn prose_owners(library: &Library) -> Result<(Vec<ProseOwner>, OrphanDocs)> {
    let conn = &library.conn;
    let mut updates: HashMap<String, i64> = HashMap::new();
    let mut statement =
        conn.prepare("SELECT document_id, count(*) FROM yjs_updates GROUP BY document_id")?;
    for row in statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (doc, count) = row?;
        updates.insert(doc, count);
    }
    let mut snapshots: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut statement = conn.prepare("SELECT document_id FROM yjs_snapshots")?;
    for row in statement.query_map([], |r| r.get::<_, String>(0))? {
        snapshots.insert(row?);
    }
    let mut revisions: HashMap<String, i64> = HashMap::new();
    let mut statement = conn.prepare("SELECT document_id, revision FROM yjs_document_revision")?;
    for row in statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (doc, revision) = row?;
        revisions.insert(doc, revision);
    }
    let handoff = library.handoff()?;

    let mut owners = Vec::new();
    let mut known = std::collections::HashSet::new();
    for kind in ProseKind::ALL {
        let mut statement = conn.prepare(kind.owner_sql())?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
            ))
        })?;
        for row in rows {
            let (id, project_id, cached, owner_deleted, basis_kind, basis_revision) = row?;
            let doc_id = format!("{}:{}", kind.prefix(), id);
            let update_count = updates.get(&doc_id).copied().unwrap_or(0);
            let snapshot = snapshots.contains(&doc_id);
            let revision = revisions.get(&doc_id).copied();
            let freshness = if update_count == 0 && !snapshot {
                Freshness::SeedOnly
            } else if handoff
                .as_ref()
                .and_then(|h| h.get(&doc_id))
                .is_some_and(|r| Some(*r) == revision)
            {
                Freshness::Handoff
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
                cached,
                owner_deleted,
                updates: update_count,
                snapshot,
                revision,
                freshness,
            });
        }
    }
    let mut orphans = OrphanDocs::default();
    for doc in updates.keys().chain(snapshots.iter()) {
        if known.contains(doc) {
            continue;
        }
        match ProseKind::from_doc_id(doc) {
            Some(_) => orphans.owner_missing += 1,
            None => orphans.unknown_prefix += 1,
        }
    }
    Ok((owners, orphans))
}

/// One row of `entity_snapshot_history`.
#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub entity_kind: String,
    pub entity_id: String,
    pub created_at: String,
    pub preview: Option<String>,
    pub meta: Option<String>,
    pub state_bytes: usize,
}

pub fn history(library: &Library) -> Result<Vec<HistoryRow>> {
    let mut statement = library.conn.prepare(
        "SELECT entity_kind, entity_id, created_at, content_json, meta_json, length(state_blob) FROM entity_snapshot_history ORDER BY entity_kind, entity_id, created_at, id",
    )?;
    let rows = statement.query_map([], |r| {
        Ok(HistoryRow {
            entity_kind: r.get(0)?,
            entity_id: r.get(1)?,
            created_at: r.get(2)?,
            preview: r.get(3)?,
            meta: r.get(4)?,
            state_bytes: r.get::<_, i64>(5)? as usize,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The prose document a history row belongs to.
pub fn history_doc_id(row: &HistoryRow) -> String {
    let prefix = match row.entity_kind.as_str() {
        "node" => "node-content",
        "library_item" | "library-item" => "library-item",
        other => other,
    };
    format!("{prefix}:{}", row.entity_id)
}

/// A comment or element patch anchor, with the prose document it points into.
#[derive(Debug, Clone)]
pub struct AnchorRow {
    pub source: &'static str,
    pub id: String,
    pub doc_id: Option<String>,
    pub block_ids: Vec<String>,
    pub anchor_json: String,
    pub target_kind: Option<String>,
}

fn target_doc(kind: &str, id: &str) -> Option<String> {
    let prefix = match kind {
        "node" => "node-content",
        "element" => "element",
        "storyline" => "storyline",
        "category" => "category",
        "library_item" => "library-item",
        _ => return None,
    };
    Some(format!("{prefix}:{id}"))
}

pub fn anchors(library: &Library) -> Result<Vec<AnchorRow>> {
    let mut out = Vec::new();
    let mut statement = library
        .conn
        .prepare("SELECT id, target_kind, target_id, target_block_id, target_block_ids_json, anchor_json FROM comment ORDER BY id")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    for row in rows {
        let (id, target_kind, target_id, block, blocks_json, anchor_json) = row?;
        let mut block_ids: Vec<String> = serde_json::from_str(&blocks_json).unwrap_or_default();
        if block_ids.is_empty()
            && let Some(block) = block
        {
            block_ids.push(block);
        }
        let doc_id = match (&target_kind, &target_id) {
            (Some(kind), Some(id)) => target_doc(kind, id),
            _ => None,
        };
        out.push(AnchorRow {
            source: "comment",
            id,
            doc_id,
            block_ids,
            anchor_json,
            target_kind,
        });
    }
    let mut statement = library
        .conn
        .prepare("SELECT id, source_node_id, source_block_id, text_anchor_json FROM element_patch ORDER BY id")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    for row in rows {
        let (id, node, block, text_anchor) = row?;
        let anchor_json = text_anchor
            .map(|t| format!("{{\"textAnchor\":{t}}}"))
            .unwrap_or_else(|| "{}".into());
        out.push(AnchorRow {
            source: "element_patch",
            id,
            doc_id: node.map(|n| format!("node-content:{n}")),
            block_ids: block.into_iter().collect(),
            anchor_json,
            target_kind: Some("node".into()),
        });
    }
    Ok(out)
}

/// Asset rows and whether their source bytes are present and intact.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCheck {
    pub rows: usize,
    pub source_bytes: u64,
    pub files_checked: usize,
    pub files_missing: usize,
    pub sha_mismatch: usize,
}

pub fn assets(library: &Library, app_local_data: Option<&Path>) -> Result<AssetCheck> {
    use sha2::{Digest, Sha256};
    let mut check = AssetCheck::default();
    let mut statement = library
        .conn
        .prepare("SELECT id, project_id, source_sha256, source_size_bytes FROM project_asset")?;
    let rows: Vec<(String, String, String, i64)> = statement
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    for (id, project, sha, size) in rows {
        check.rows += 1;
        check.source_bytes += size as u64;
        let Some(root) = app_local_data else { continue };
        let dir = root.join("assets").join(&project).join(&id);
        let source = std::fs::read_dir(&dir).ok().and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| p.file_stem().is_some_and(|s| s == "source"))
        });
        check.files_checked += 1;
        match source {
            None => check.files_missing += 1,
            Some(path) => {
                let digest = Sha256::digest(std::fs::read(path)?);
                let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
                if hex != sha {
                    check.sha_mismatch += 1;
                }
            }
        }
    }
    Ok(check)
}

/// Facts the importer must surface before it runs (it refuses or warns).
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blockers {
    pub open_sync_conflicts: i64,
    pub open_frontier_gaps: i64,
    pub quarantined_objects: i64,
}

pub fn blockers(library: &Library) -> Result<Blockers> {
    let count = |table: &str| -> Result<i64> {
        Ok(library
            .conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
    };
    Ok(Blockers {
        open_sync_conflicts: count("sync_conflict")?,
        open_frontier_gaps: count("sync_frontier_gap")?,
        quarantined_objects: count("sync_quarantined_object")?,
    })
}

/// Rendered truth for each document (the prototype exchange file the one-off
/// comparison wrote from the old client's own Yjs rendering): doc id → ProseMirror JSON.
pub fn read_truth(path: &Path) -> Result<BTreeMap<String, Value>> {
    let text = std::fs::read_to_string(path)?;
    let mut out = BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let value: Value = serde_json::from_str(line)?;
        let id = value
            .get("documentId")
            .and_then(Value::as_str)
            .context("documentId")?
            .to_string();
        out.insert(id, value.get("prose").cloned().unwrap_or(Value::Null));
    }
    Ok(out)
}
