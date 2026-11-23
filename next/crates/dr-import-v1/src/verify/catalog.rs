//! The loss detector: every 0.1 row the importer says it carries
//! ([`crate::tables`]: `book-doc`, `stats-doc`, `prose-doc`, `assets`,
//! `history`, `agent-archive`, `local`) is in the imported library, or the
//! import's receipt records why it is not. Whatever is neither is
//! *unexplained* and named by table, book and id.
//!
//! The 0.1 side is read with its own SQL from a staging copy (WAL replayed,
//! schema brought up to the last 0.1 migration), not through the importer's
//! readers, so a row the importer never read is still counted. The imported
//! side is read from the stored documents (format 5), the history labels
//! and entry checkpoints, the asset store, the receipt tables and
//! `import-v1/receipt.sqlite`.
//!
//! What it does not check: field values beyond presence (it checks the
//! trashed state, primary storylines and writing-day words), prose content
//! (that is [`super::check_truth`]'s), anchors, and the device-local rows of
//! the `drop` and `rebuild` tables.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use dr_doc::v3::BookDocV3;
use dr_doc::v3::novel::{MOD_FIELDS, MOD_KV, MOD_PLOT_GRID, TPL_STORYLINE};
use dr_model::DocId;
use dr_model::id::*;
use dr_model::relations::RelationDirection;
use dr_model::v3::FieldValue;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::error::{ImportError, Result};

/// One 0.1 table's rows: in the source, in the library, and dropped with a
/// receipt record.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub source: usize,
    pub carried: usize,
    pub dropped: usize,
}

/// A source row with neither an imported object nor a receipt record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unexplained {
    pub table: String,
    /// The 0.1 book (`project.id`), empty for library-wide tables.
    pub book: String,
    pub id: String,
    pub what: String,
}

/// What [`check_catalog`] found.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCheck {
    pub books: usize,
    /// By table (a few tables have a second line for what hangs off a row:
    /// `project_asset (file)`, `element (body)`, `storylines (template)`, …).
    pub tables: BTreeMap<String, Tally>,
    pub unexplained: Vec<Unexplained>,
}

impl CatalogCheck {
    pub fn is_clean(&self) -> bool {
        self.unexplained.is_empty()
    }
}

enum Outcome {
    Carried,
    Dropped,
    Missing(String),
}
use Outcome::*;

struct Tallies<'a> {
    out: &'a mut CatalogCheck,
    book: String,
}

impl Tallies<'_> {
    fn add(&mut self, table: &str, id: impl Into<String>, outcome: Outcome) {
        let t = self.out.tables.entry(table.to_string()).or_default();
        t.source += 1;
        match outcome {
            Carried => t.carried += 1,
            Dropped => t.dropped += 1,
            Missing(what) => self.out.unexplained.push(Unexplained {
                table: table.to_string(),
                book: self.book.clone(),
                id: id.into(),
                what,
            }),
        }
    }
}

fn rows<T>(
    conn: &Connection,
    sql: &str,
    p: impl rusqlite::Params,
    f: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let v = stmt
        .query_map(p, f)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(v)
}

/// A directory of this check's own. Two checks in one process can start in
/// the same millisecond (tests in parallel did, and each read the other's
/// staged 0.1 database), so the name also counts up and the directory must
/// not exist yet.
fn scratch_dir() -> Result<PathBuf> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    loop {
        let dir = std::env::temp_dir().join(format!(
            "dr-import-catalog-check-{}-{}-{}",
            std::process::id(),
            dr_store::now_ms(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

/// Check the library at `new_root` against the 0.1 database `old_db` it was
/// imported from (read-only: the 0.1 side is a staging copy in a temporary
/// directory, removed afterwards).
pub fn check_catalog(old_db: &Path, new_root: &Path) -> Result<CatalogCheck> {
    let lib = super::open(new_root, false)?;
    let checked = check_catalog_in(old_db, &lib);
    let closed = lib.close();
    let checked = checked?;
    closed?;
    Ok(checked)
}

/// [`check_catalog`] on a library that is already open.
pub fn check_catalog_in(old_db: &Path, lib: &dr_store::Library) -> Result<CatalogCheck> {
    let scratch = scratch_dir()?;
    let result = (|| {
        let staged = crate::staging::stage(old_db, &scratch, "catalog-check")?;
        let source = staged.open()?;
        check(&source, lib, &lib.paths().root)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// The receipt, as the library holds it.
struct Receipt {
    /// Book id → the latest `imported` record.
    books: HashMap<String, Value>,
    /// (collection, id, field) → JSON.
    originals: HashMap<(String, String, String), String>,
    /// Old (0.1) doc id → new doc id.
    docs: HashMap<String, String>,
    thinned: bool,
}

fn receipt(lib: &dr_store::Library) -> Result<Receipt> {
    Ok(lib.local_read(|c| {
        let mut books = HashMap::new();
        let mut stmt = c.prepare(
            "SELECT book_id, record_json FROM import_book WHERE status = 'imported' ORDER BY run_id",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (book, json) = row?;
            books.insert(book, serde_json::from_str(&json).unwrap_or(Value::Null));
        }
        let mut originals = HashMap::new();
        let mut stmt = c.prepare("SELECT collection, id, field, json FROM import_original")?;
        for row in stmt.query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                r.get::<_, String>(3)?,
            ))
        })? {
            let (k, v) = row?;
            originals.insert(k, v);
        }
        let mut docs = HashMap::new();
        let mut stmt = c.prepare("SELECT old_doc_id, doc_id FROM import_doc ORDER BY run_id")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (o, n) = row?;
            docs.insert(o, n);
        }
        let thinned: Option<String> = c
            .query_row(
                "SELECT json_extract(summary_json, '$.historyRetention') FROM import_run ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(Receipt {
            books,
            originals,
            docs,
            thinned: thinned.as_deref() == Some("thinned"),
        })
    })?)
}

/// Whether an editor JSON body holds any text (an empty one makes no
/// template document).
fn has_text(json: &str) -> bool {
    fn walk(v: &Value) -> bool {
        match v {
            Value::Object(m) => {
                m.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| !t.trim().is_empty())
                    || m.values().any(walk)
            }
            Value::Array(a) => a.iter().any(walk),
            _ => false,
        }
    }
    serde_json::from_str::<Value>(json).is_ok_and(|v| walk(&v))
}

fn note(record: &Value, key: &str) -> u64 {
    record["notes"][key].as_u64().unwrap_or(0)
}

fn check(src: &Connection, lib: &dr_store::Library, root: &Path) -> Result<CatalogCheck> {
    let receipt = receipt(lib)?;
    let mut out = CatalogCheck::default();
    let projects = rows(src, "SELECT id, name FROM project ORDER BY id", [], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for (book, name) in &projects {
        check_book(src, lib, &receipt, book, name, &mut out)?;
    }
    library_wide(src, root, &mut out)?;
    Ok(out)
}

fn entry_id(s: &str) -> Option<EntryId> {
    EntryId::parse(s).ok()
}

#[allow(clippy::too_many_lines)]
fn check_book(
    src: &Connection,
    lib: &dr_store::Library,
    receipt: &Receipt,
    book: &str,
    name: &str,
    out: &mut CatalogCheck,
) -> Result<()> {
    out.books += 1;
    let mut t = Tallies {
        out,
        book: book.to_string(),
    };
    let Some(record) = receipt.books.get(book) else {
        t.add(
            "project",
            book,
            Missing("the receipt has no imported record of this book".into()),
        );
        return Ok(());
    };
    let book_id = BookId::parse(book).map_err(|e| ImportError::Invalid(e.to_string()))?;
    // What the import's defaults did, by (table, id): their drops are
    // explained, the rest changed a value and still count as carried.
    let adjusted: HashMap<(String, String), Vec<(String, String)>> = {
        let mut m: HashMap<(String, String), Vec<(String, String)>> = HashMap::new();
        for a in record["adjustments"].as_array().into_iter().flatten() {
            let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
            m.entry((s("table"), s("id")))
                .or_default()
                .push((s("code"), s("done")));
        }
        m
    };
    let dropped_by_default = |table: &str, id: &str| {
        adjusted
            .get(&(table.to_string(), id.to_string()))
            .is_some_and(|l| {
                l.iter().any(|(_, done)| {
                    done == "dropped" || done == "skipped" || done.starts_with("dropped ")
                })
            })
    };
    if lib.doc_info(&format!("book:{book}"))?.is_none() {
        t.add("project", book, Missing("no book document".into()));
        return Ok(());
    }
    let snap = lib
        .load_copy(&format!("book:{book}"))?
        .export(loro::ExportMode::Snapshot)?;
    let doc = BookDocV3::load(book_id.clone(), dr_doc::peer::random_device_peer(), &[snap])?;
    let view = doc.view();
    let p = [book];
    t.add(
        "project",
        book,
        if view.meta().name == name {
            Carried
        } else {
            Missing(format!("book name is {:?}", view.meta().name))
        },
    );
    let entries = view.entries_map();
    let entry = |id: &str| entry_id(id).and_then(|e| entries.get(&e));
    let live_state = |table: &str, id: &str, deleted: bool| -> Outcome {
        match entry(id) {
            None => Missing(format!("no entry for this {table} row")),
            Some(e) if e.deleted_at.is_some() != deleted => Missing(if deleted {
                "in Recently Deleted in 0.1, live after the import".into()
            } else {
                "live in 0.1, in Recently Deleted after the import".into()
            }),
            Some(_) => Carried,
        }
    };

    // Entries.
    for (table, sql) in [
        (
            "book_node",
            "SELECT id, deleted_at IS NOT NULL FROM book_node WHERE project_id = ?1",
        ),
        (
            "book_act",
            "SELECT id, 0 FROM book_act WHERE project_id = ?1",
        ),
        (
            "drift_group",
            "SELECT id, 0 FROM drift_group WHERE project_id = ?1",
        ),
        (
            "element_category",
            "SELECT id, deleted_at IS NOT NULL FROM element_category WHERE project_id = ?1",
        ),
        (
            "element",
            "SELECT id, deleted_at IS NOT NULL FROM element WHERE project_id = ?1",
        ),
        (
            "storylines",
            "SELECT id, deleted_at IS NOT NULL FROM storylines WHERE project_id = ?1",
        ),
    ] {
        for (id, deleted) in rows(src, sql, p, |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })? {
            let outcome = live_state(table, &id, deleted);
            t.add(table, id, outcome);
        }
    }

    // Storyline memberships and primary storylines.
    let memberships: BTreeSet<(EntryId, EntryId)> = view
        .memberships_raw()
        .into_iter()
        .map(|m| (m.host, m.member))
        .collect();
    for (node, storyline, primary) in rows(
        src,
        "SELECT l.node_id, l.storyline_id, l.is_primary FROM node_storyline_link l JOIN book_node n ON n.id = l.node_id WHERE n.project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? != 0,
            ))
        },
    )? {
        let key = format!("{node}|{storyline}");
        let pair = entry_id(&storyline).zip(entry_id(&node));
        let outcome = match pair {
            Some(pair) if memberships.contains(&pair) => {
                if primary
                    && entry(&node).and_then(|e| e.primary.clone()) != entry_id(&storyline)
                    // One of several primaries, the others kept as
                    // storylines (recorded).
                    && !adjusted
                        .get(&("book_node".to_string(), node.clone()))
                        .is_some_and(|l| l.iter().any(|(c, _)| c == "multiple-primary-memberships"))
                {
                    Missing("the primary storyline was lost".into())
                } else {
                    Carried
                }
            }
            _ if dropped_by_default("node_storyline_link", &key) => Dropped,
            _ => Missing("no membership of the chapter or idea in its storyline".into()),
        };
        t.add("node_storyline_link", key, outcome);
    }

    // Materials, folders, files.
    let dropped_materials: Vec<&Value> = record["materialsDropped"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    // `MaterialDropped` names its variants in camelCase and keeps its fields
    // snake_case (`folder_id`, `material_id`).
    let recorded = |kind: &str, key: &str, id: &str| {
        dropped_materials
            .iter()
            .any(|d| d["kind"] == kind && d[key].as_str() == Some(id))
    };
    let merged: HashMap<String, String> = record["mergedAssets"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let assets: BTreeSet<String> = view
        .assets_raw()
        .into_iter()
        .map(|a| a.id.to_string())
        .collect();
    let asset_folders: BTreeSet<String> = view
        .asset_folders_raw()
        .into_iter()
        .map(|f| f.id.to_string())
        .collect();
    for (id,) in rows(
        src,
        "SELECT id FROM material_folder WHERE project_id = ?1",
        p,
        |r| Ok((r.get::<_, String>(0)?,)),
    )? {
        let outcome = if entry(&id).is_some() || asset_folders.contains(&id) {
            Carried
        } else if recorded("emptyFolder", "folder_id", &id)
            || recorded("unimportedFolder", "folder_id", &id)
        {
            Dropped
        } else {
            Missing("no note level and no file folder for this folder".into())
        };
        t.add("material_folder", id, outcome);
    }
    for (id, kind, asset) in rows(
        src,
        "SELECT id, kind, asset_id FROM library_item WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )? {
        let outcome = if ["withoutFile", "unknownKind", "sameFile"]
            .iter()
            .any(|k| recorded(k, "material_id", &id))
        {
            Dropped
        } else if kind == "text" {
            if entry(&id).is_some() {
                Carried
            } else {
                Missing("no note entry".into())
            }
        } else {
            let file = asset.map(|a| merged.get(&a).cloned().unwrap_or(a));
            if file.is_some_and(|a| assets.contains(&a)) {
                Carried
            } else {
                Missing(format!(
                    "no file in the asset library for this {kind} material"
                ))
            }
        };
        t.add("library_item", id, outcome);
    }
    let files_missing: BTreeSet<&str> = ["assetFilesMissing", "assetFilesMismatched"]
        .iter()
        .flat_map(|k| record[*k].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    let copies_missing =
        |id: &str, variant: &str| record["assetCopiesMissing"][id][variant].as_str().is_some();
    for (id, kind, mime) in rows(
        src,
        "SELECT id, kind, source_mime FROM project_asset WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        if merged.contains_key(&id) {
            t.add("project_asset", id, Dropped);
            continue;
        }
        if !assets.contains(&id) {
            t.add("project_asset", id, Missing("no asset record".into()));
            continue;
        }
        let bytes = lib.asset(&id, dr_store::asset::Variant::Source)?.is_some();
        t.add("project_asset", id.clone(), Carried);
        t.add(
            "project_asset (file)",
            id.clone(),
            if bytes {
                Carried
            } else if files_missing.contains(id.as_str()) {
                Dropped
            } else {
                Missing("the asset store has no bytes for it".into())
            },
        );
        // An image the new client cannot decode itself: 0.1's display and
        // thumbnail copies came with its bytes, or the receipt says why not.
        if bytes && crate::copies::wanted(&kind, &mime) {
            for variant in crate::copies::VARIANTS {
                let name = variant.as_str();
                let outcome = if lib.asset(&id, variant)?.is_some() {
                    Carried
                } else if copies_missing(&id, name) {
                    Dropped
                } else {
                    Missing(format!(
                        "no {name} copy of an image the new client cannot decode itself"
                    ))
                };
                t.add(&format!("project_asset ({name})"), id.clone(), outcome);
            }
        }
    }

    // Comments and their actions.
    let comments = view.comments();
    let comment_ids: BTreeSet<String> = comments.iter().map(|c| c.id.to_string()).collect();
    let conversations: BTreeSet<String> = comments
        .iter()
        .filter_map(|c| c.agent_conversation.clone())
        .collect();
    // Projected TODOs get ids from their line: count them per (entry, kind).
    let mut projected_targets: HashMap<(String, String), usize> = HashMap::new();
    for c in &comments {
        if let (Some(p), Some(target)) = (&c.projection, &c.target) {
            *projected_targets
                .entry((target.id.clone(), p.kind.as_str().to_string()))
                .or_default() += 1;
        }
    }
    let mut projected_sources: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    for (id, meta, target) in rows(
        src,
        "SELECT id, metadata_json, target_id FROM comment WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )? {
        if comment_ids.contains(&id) {
            t.add("comment", id, Carried);
            continue;
        }
        let kind = meta
            .as_deref()
            .and_then(|m| serde_json::from_str::<Value>(m).ok())
            .and_then(|v| v["kind"].as_str().map(str::to_string));
        let projection = match kind.as_deref() {
            Some("todo-autoparse") => Some(dr_model::kind::ProjectionKind::Marker.as_str()),
            Some("note-task") => Some(dr_model::kind::ProjectionKind::NoteTask.as_str()),
            _ => None,
        };
        match (projection, target) {
            (Some(k), Some(target)) => projected_sources
                .entry((target, k.to_string()))
                .or_default()
                .push(id),
            _ => t.add("comment", id, Missing("no comment with this id".into())),
        }
    }
    for (key, ids) in projected_sources {
        let have = projected_targets.get(&key).copied().unwrap_or(0);
        for (n, id) in ids.iter().enumerate() {
            let outcome = if n < have {
                Carried
            } else {
                Missing(format!(
                    "{} projected TODOs of this kind on {} in 0.1, {have} after the import",
                    ids.len(),
                    key.0
                ))
            };
            t.add("comment", id.clone(), outcome);
        }
    }
    let mut action_drops: HashMap<String, u64> = HashMap::new();
    let mut without_conversation = note(record, "agent-task-action-without-conversation");
    for (id, kind, payload) in rows(
        src,
        "SELECT id, kind, payload_json FROM comment_action WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        let outcome = if dr_model::import_v1::legacy::comment_action_survives(&kind) {
            let conversation = serde_json::from_str::<Value>(&payload)
                .ok()
                .and_then(|v| v["conversationId"].as_str().map(str::to_string));
            match conversation {
                Some(c) if conversations.contains(&c) => Carried,
                None if without_conversation > 0 => {
                    without_conversation -= 1;
                    Dropped
                }
                _ => Missing("no comment carries its Agent conversation".into()),
            }
        } else {
            let left = action_drops
                .entry(kind.clone())
                .or_insert_with(|| note(record, &format!("comment-action-dropped:{kind}")));
            if *left > 0 {
                *left -= 1;
                Dropped
            } else {
                Missing(format!("a `{kind}` action, not recorded as dropped"))
            }
        };
        t.add("comment_action", id, outcome);
    }

    // Patches, memory, time pins.
    let patches: BTreeSet<String> = view
        .patches()
        .into_iter()
        .map(|x| x.id.to_string())
        .collect();
    for (id,) in rows(
        src,
        "SELECT id FROM element_patch WHERE project_id = ?1",
        p,
        |r| Ok((r.get::<_, String>(0)?,)),
    )? {
        let outcome = if patches.contains(&id) {
            Carried
        } else {
            Missing("no patch".into())
        };
        t.add("element_patch", id, outcome);
    }
    let memory: BTreeSet<String> = view
        .memory()
        .into_iter()
        .map(|m| m.id.to_string())
        .collect();
    for (id,) in rows(
        src,
        "SELECT id FROM agent_memory WHERE project_id = ?1",
        p,
        |r| Ok((r.get::<_, String>(0)?,)),
    )? {
        let outcome = if memory.contains(&id) {
            Carried
        } else {
            Missing("no memory".into())
        };
        t.add("agent_memory", id, outcome);
    }
    let pins: BTreeSet<String> = view
        .timeline_views_raw()
        .into_iter()
        .flat_map(|v| v.pins.into_iter().map(|p| p.id.to_string()))
        .collect();
    for (id,) in rows(
        src,
        "SELECT id FROM timeline_marker WHERE project_id = ?1",
        p,
        |r| Ok((r.get::<_, String>(0)?,)),
    )? {
        let outcome = if pins.contains(&id) {
            Carried
        } else {
            Missing("no time pin".into())
        };
        t.add("timeline_marker", id, outcome);
    }

    // Plot grids.
    let plot = ModuleId::parse(MOD_PLOT_GRID).expect("module id");
    let mut grids: HashMap<String, (String, Option<dr_model::v3::PlotGridV3>)> = HashMap::new();
    for (id, node) in rows(
        src,
        "SELECT d.id, d.node_id FROM plot_grid_document d JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1",
        p,
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )? {
        let grid = entry_id(&node).and_then(|e| view.plot_grid(&e, &plot));
        let outcome = if grid.is_some() {
            Carried
        } else {
            Missing("no plot grid".into())
        };
        t.add("plot_grid_document", id.clone(), outcome);
        grids.insert(id, (node, grid));
    }
    for (table, rows_of) in [("plot_grid_row", true), ("plot_grid_column", false)] {
        for (id, document) in rows(
            src,
            &format!(
                "SELECT x.id, x.document_id FROM {table} x JOIN plot_grid_document d ON d.id = x.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1"
            ),
            p,
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )? {
            let found = grids
                .get(&document)
                .and_then(|(_, g)| g.as_ref())
                .is_some_and(|g| {
                    if rows_of {
                        g.rows.iter().any(|l| l.id.as_str() == id)
                    } else {
                        g.cols.iter().any(|l| l.id.as_str() == id)
                    }
                });
            t.add(
                table,
                id,
                if found {
                    Carried
                } else {
                    Missing("not in its plot grid".into())
                },
            );
        }
    }
    for (id, document, row, col) in rows(
        src,
        "SELECT c.id, c.document_id, c.row_id, c.column_id FROM plot_grid_cell c JOIN plot_grid_document d ON d.id = c.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    )? {
        let found = grids
            .get(&document)
            .and_then(|(_, g)| g.as_ref())
            .is_some_and(|g| {
                g.cells
                    .keys()
                    .any(|(r, c)| r.as_str() == row && c.as_str() == col)
            });
        t.add(
            "plot_grid_cell",
            id,
            if found {
                Carried
            } else {
                Missing("not in its plot grid".into())
            },
        );
    }

    // Key/value rows: facts, field templates, element values.
    let facts: BTreeSet<String> = view.facts().into_iter().map(|f| f.id.to_string()).collect();
    let template_kv = |template: &EntryTemplateId, module: &str| -> BTreeSet<String> {
        view.template(template)
            .and_then(|t| t.modules.into_iter().find(|m| m.id.as_str() == module))
            .map(|m| {
                m.config
                    .initial_kv
                    .iter()
                    .map(|k| k.id.to_string())
                    .chain(m.config.defs.iter().map(|d| d.id.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let storyline_template = template_kv(
        &EntryTemplateId::parse(TPL_STORYLINE).expect("template id"),
        MOD_KV,
    );
    let kv_mod = ModuleId::parse(MOD_KV).expect("module id");
    let fields_mod = ModuleId::parse(MOD_FIELDS).expect("module id");
    let entry_kv = |owner: &str, id: &str| {
        entry(owner).is_some_and(|e| {
            e.kv.get(&kv_mod)
                .is_some_and(|l| l.iter().any(|k| k.id.as_str() == id))
        })
    };
    let element_category: HashMap<String, Option<String>> = rows(
        src,
        "SELECT id, category_id FROM element WHERE project_id = ?1",
        p,
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    )?
    .into_iter()
    .collect();
    let all_kv = rows(
        src,
        "SELECT id, owner_kind, owner_id, namespace, key, value FROM entity_kv_entry WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        },
    )?;
    let template_field_ids: HashMap<(String, String), Vec<String>> = {
        let mut m: HashMap<(String, String), Vec<String>> = HashMap::new();
        for (id, kind, owner, ns, key, _) in &all_kv {
            if kind == "element-category" && ns == "element-template" {
                m.entry((owner.clone(), key.clone()))
                    .or_default()
                    .push(id.clone());
            }
        }
        m
    };
    for (id, kind, owner, ns, key, value) in &all_kv {
        if dropped_by_default("entity_kv_entry", id) {
            t.add("entity_kv_entry", id.clone(), Dropped);
            continue;
        }
        let carried = match (kind.as_str(), ns.as_str()) {
            ("project", "facts") => facts.contains(id),
            ("project", "storyline-template") => storyline_template.contains(id),
            ("element-category", "element-template") => {
                let defs = template_kv(&dr_samples::v3::category_template(owner), MOD_FIELDS);
                defs.contains(id) || defs.contains(&crate::defaults::regenerated_kv_id(book, id))
            }
            ("storyline", "facts") => entry_kv(owner, id),
            ("element", "facts") => {
                entry_kv(owner, id)
                    || element_category
                        .get(owner)
                        .cloned()
                        .flatten()
                        .and_then(|c| template_field_ids.get(&(c, key.clone())))
                        .is_some_and(|fields| {
                            entry(owner).is_some_and(|e| {
                                fields.iter().any(|f| {
                                    // The field's id, or the one the import
                                    // gave it in place of a built-in id.
                                    [f.clone(), crate::defaults::regenerated_kv_id(book, f)]
                                        .iter()
                                        .any(|f| {
                                            e.fields.get(&fields_mod).and_then(|m| m.get(f))
                                                == Some(&FieldValue::Text(value.clone()))
                                        })
                                })
                            })
                        })
            }
            _ => false,
        };
        t.add(
            "entity_kv_entry",
            id.clone(),
            if carried {
                Carried
            } else {
                Missing(format!("no {ns} row of {kind} {owner}"))
            },
        );
    }

    // Relation types, their end kinds, relations.
    let types: BTreeSet<String> = view
        .relation_types_raw()
        .into_iter()
        .map(|x| x.id.to_string())
        .collect();
    let original = |collection: &str, id: &str, field: &str| {
        receipt
            .originals
            .get(&(collection.to_string(), id.to_string(), field.to_string()))
    };
    let mut built_in: BTreeSet<String> = BTreeSet::new();
    for (id, system) in rows(
        src,
        "SELECT id, system_key FROM entity_relation_type WHERE project_id = ?1",
        p,
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    )? {
        let is_built_in = system.as_deref() == Some("generic-association")
            || id == dr_doc::import_v1::generic_relation_type_id(&book_id).as_str();
        if is_built_in {
            built_in.insert(id.clone());
        }
        let outcome = if types.contains(&id) {
            Carried
        } else if is_built_in && original("relation_types", &id, "source_kinds").is_some() {
            // kernel-v5.md §19 「导入 0.1」: the built-in type itself is not carried.
            Dropped
        } else {
            Missing("no relation type".into())
        };
        t.add("entity_relation_type", id, outcome);
    }
    for (ty, side, kind) in rows(
        src,
        "SELECT k.relation_type_id, k.side, k.entity_kind FROM entity_relation_type_endpoint_kind k JOIN entity_relation_type t ON t.id = k.relation_type_id WHERE t.project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        let field = if side == "source" {
            "source_kinds"
        } else {
            "target_kinds"
        };
        // Format 5 has no end kinds; the receipt keeps them (§19).
        let kept = original("relation_types", &ty, field)
            .and_then(|j| serde_json::from_str::<Vec<String>>(j).ok())
            .is_some_and(|kinds| kinds.contains(&kind));
        t.add(
            "entity_relation_type_endpoint_kind",
            format!("{ty}/{side}/{kind}"),
            if kept {
                Dropped
            } else {
                Missing("not in the receipt's end kinds".into())
            },
        );
    }
    let relation_rows = view.relations_raw();
    let directions: HashMap<String, RelationDirection> = view
        .relation_types_raw()
        .into_iter()
        .map(|x| (x.id.to_string(), x.direction))
        .collect();
    for (id, from, to, ty) in rows(
        src,
        "SELECT id, from_id, to_id, relation_type_id FROM entity_relation WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    )? {
        if original("relations", &id, "dropped").is_some() {
            t.add("entity_relation", id, Dropped);
            continue;
        }
        let (Some(a), Some(b)) = (entry_id(&from), entry_id(&to)) else {
            t.add(
                "entity_relation",
                id,
                Missing("an end is not an entry id".into()),
            );
            continue;
        };
        let association = built_in.contains(&ty);
        let found = relation_rows.iter().any(|row| {
            let forward = row.left.contains(&a) && row.right.contains(&b);
            let backward = row.left.contains(&b) && row.right.contains(&a);
            if association {
                forward || backward
            } else {
                row.relation_type.as_str() == ty
                    && (forward
                        || (backward && directions.get(&ty) == Some(&RelationDirection::Symmetric)))
            }
        });
        let outcome = if found {
            Carried
        } else if association && original("relations", &id, "source-association").is_none() {
            Missing("a built-in association neither carried nor recorded".into())
        } else {
            Missing("no relation row with both ends".into())
        };
        t.add("entity_relation", id, outcome);
    }

    // Writing days.
    let days: HashMap<(String, String), i64> = match lib.load_copy(&format!("stats:{book}")) {
        Ok(d) => {
            let snap = d.export(loro::ExportMode::Snapshot)?;
            let stats = dr_doc::side::StatsDoc::load(
                book_id.clone(),
                dr_doc::peer::random_device_peer(),
                &[snap],
            )?;
            stats
                .view()
                .writing_days()
                .into_iter()
                .map(|w| ((w.device.to_string(), w.day.to_string()), w.words))
                .collect()
        }
        Err(_) => HashMap::new(),
    };
    let source_days = rows(
        src,
        "SELECT id, day, device_key, words FROM writing_day WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        },
    )?;
    // Several rows of one device and day are added up (`crate::defaults`).
    let mut totals: HashMap<(String, String), i64> = HashMap::new();
    for (_, day, device, words) in &source_days {
        *totals.entry((device.clone(), day.clone())).or_default() += words;
    }
    for (id, day, device, _) in source_days {
        let key = (device.clone(), day.clone());
        let outcome = match days.get(&key) {
            Some(w) if *w == totals[&key] => Carried,
            Some(w) => Missing(format!(
                "{} words in 0.1, {w} after the import",
                totals[&key]
            )),
            None if dropped_by_default("writing_day", &id) => Dropped,
            None => Missing("no writing day for this device and day".into()),
        };
        t.add("writing_day", id, outcome);
    }

    // Prose bodies, body templates, snapshot history.
    let body_exists = |old: &str| -> Result<bool> {
        Ok(match receipt.docs.get(old) {
            Some(new) => lib.doc_info(new)?.is_some(),
            None => false,
        })
    };
    for (table, prefix, sql) in [
        (
            "node_content",
            "node-content",
            "SELECT c.node_id FROM node_content c JOIN book_node n ON n.id = c.node_id WHERE n.project_id = ?1",
        ),
        (
            "element (body)",
            "element",
            "SELECT id FROM element WHERE project_id = ?1",
        ),
        (
            "storylines (body)",
            "storyline",
            "SELECT id FROM storylines WHERE project_id = ?1",
        ),
        (
            "element_category (body)",
            "category",
            "SELECT id FROM element_category WHERE project_id = ?1",
        ),
        (
            "library_item (body)",
            "library-item",
            "SELECT id FROM library_item WHERE project_id = ?1 AND kind = 'text'",
        ),
    ] {
        for (id,) in rows(src, sql, p, |r| Ok((r.get::<_, String>(0)?,)))? {
            let old = format!("{prefix}:{id}");
            let outcome = if body_exists(&old)? {
                Carried
            } else {
                Missing("no prose document".into())
            };
            t.add(table, id, outcome);
        }
    }
    let prose = ModuleId::parse(dr_doc::v3::novel::MOD_PROSE).expect("module id");
    for (table, sql, template) in [
        (
            "element_category (template)",
            "SELECT id, element_template_json FROM element_category WHERE project_id = ?1",
            dr_samples::v3::category_template as fn(&str) -> EntryTemplateId,
        ),
        (
            "storylines (template)",
            "SELECT id, node_content_template_json FROM storylines WHERE project_id = ?1",
            dr_samples::v3::storyline_template,
        ),
    ] {
        for (id, json) in rows(src, sql, p, |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })? {
            if !json.as_deref().is_some_and(has_text) {
                continue;
            }
            let doc = DocId::Template(TemplateId::for_entry_module(
                &book_id,
                &template(&id),
                &prose,
            ));
            let outcome = if lib.doc_info(&doc.to_string())?.is_some() {
                Carried
            } else {
                Missing("no template document".into())
            };
            t.add(table, id, outcome);
        }
    }
    let mut labels: HashMap<String, Vec<i64>> = HashMap::new();
    // The entry checkpoints the history dialog lists, one per row
    // (`crate::checkpoints`): written, or recorded as not written.
    let manifests: HashMap<String, String> = match lib.load_copy(&format!("checkpoints:{book}")) {
        Ok(doc) => dr_doc::side::BorrowedCheckpoints::new(&doc, &book_id)?
            .view()
            .entry_checkpoints()
            .into_iter()
            .collect(),
        Err(dr_store::StoreError::NotFound(_)) => HashMap::new(),
        Err(e) => return Err(e.into()),
    };
    let without_checkpoint = |id: &str| record["historyWithoutCheckpoint"][id].is_string();
    let checkpoint = |id: &str, body: &str, at: Option<i64>| -> Outcome {
        let point = crate::checkpoints::checkpoint_id(id);
        let entry = match DocId::parse(body) {
            Ok(DocId::Body(b)) => b.entry().to_string(),
            _ => String::new(),
        };
        let target = dr_workspace::commands::v3::snapshots::EntryIn {
            book: book.to_string(),
            entry,
        };
        match manifests
            .get(&point)
            .map(|m| dr_workspace::commands::v3::snapshots::checked_checkpoint(m, &target, &point))
        {
            Some(Ok(p)) if Some(p.ts) == at => Carried,
            Some(Ok(_)) => Missing("its entry checkpoint is not at its time".into()),
            Some(Err(e)) => Missing(format!("its entry checkpoint is not sound: {e}")),
            None if without_checkpoint(id) => Dropped,
            None => Missing("no entry checkpoint for this row".into()),
        }
    };
    for (id, kind, entity, created) in rows(
        src,
        "SELECT id, entity_kind, entity_id, created_at FROM entity_snapshot_history WHERE project_id = ?1",
        p,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    )? {
        let prefix = match kind.as_str() {
            "node" => "node-content",
            "library_item" | "library-item" => "library-item",
            other => other,
        };
        let old = format!("{prefix}:{entity}");
        if dropped_by_default("entity_snapshot_history", &id) {
            t.add("entity_snapshot_history (checkpoint)", id.clone(), Dropped);
            t.add("entity_snapshot_history", id, Dropped);
            continue;
        }
        let Some(new) = receipt.docs.get(&old) else {
            t.add(
                "entity_snapshot_history (checkpoint)",
                id.clone(),
                Missing(format!("its body {old} was not imported")),
            );
            t.add(
                "entity_snapshot_history",
                id,
                Missing(format!("its body {old} was not imported")),
            );
            continue;
        };
        let at = crate::time::parse_iso_ms(&created);
        t.add(
            "entity_snapshot_history (checkpoint)",
            id.clone(),
            checkpoint(&id, new, at),
        );
        if !labels.contains_key(new) {
            let ts = lib
                .history(new)?
                .into_iter()
                .filter(|l| l.label == dr_store::history::labels::PERIODIC)
                .map(|l| l.ts)
                .collect();
            labels.insert(new.clone(), ts);
        }
        let points = labels.get_mut(new).expect("labels");
        let outcome = match points.iter().position(|ts| Some(*ts) == at) {
            Some(i) => {
                points.swap_remove(i);
                Carried
            }
            None if receipt.thinned => Dropped,
            None => Missing("no history point at its time".into()),
        };
        t.add("entity_snapshot_history", id, outcome);
    }
    Ok(())
}

/// The read-only Agent archive and the device-local rows, copied whole into
/// `import-v1/receipt.sqlite`.
fn library_wide(src: &Connection, root: &Path, out: &mut CatalogCheck) -> Result<()> {
    let path = crate::receipt::directory(root).join(crate::receipt::DATABASE);
    let archive =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok();
    let mut t = Tallies {
        out,
        book: String::new(),
    };
    for (prefix, tables) in [
        ("archive_", crate::receipt::AGENT_ARCHIVE),
        ("local_", crate::receipt::LOCAL),
    ] {
        for table in tables {
            let ids: Vec<String> = rows(
                src,
                &format!("SELECT CAST(rowid AS TEXT) FROM \"{table}\""),
                [],
                |r| r.get(0),
            )?;
            let copied: Option<i64> = archive.as_ref().and_then(|a| {
                a.query_row(
                    &format!("SELECT count(*) FROM \"{prefix}{table}\""),
                    [],
                    |r| r.get(0),
                )
                .ok()
            });
            let copied = copied.unwrap_or(0) as usize;
            for (n, id) in ids.iter().enumerate() {
                t.add(
                    table,
                    format!("rowid {id}"),
                    if n < copied {
                        Carried
                    } else {
                        Missing(format!(
                            "{} rows in 0.1, {copied} in {prefix}{table}",
                            ids.len()
                        ))
                    },
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::receipt::MaterialDropped;

    /// The keys the detector reads the receipt's material drops by.
    #[test]
    fn material_drops_read_by_the_keys_the_receipt_writes() {
        let folder = serde_json::to_value(MaterialDropped::EmptyFolder {
            folder_id: "f".into(),
            name: "n".into(),
        })
        .unwrap();
        assert_eq!(folder["kind"], "emptyFolder");
        assert_eq!(folder["folder_id"], "f");
        let same = serde_json::to_value(MaterialDropped::SameFile {
            material_id: "m".into(),
            material_title: "t".into(),
            kept_title: "k".into(),
            asset_id: "a".into(),
        })
        .unwrap();
        assert_eq!(same["kind"], "sameFile");
        assert_eq!(same["material_id"], "m");
    }

    /// Checks that start in the same millisecond each get a directory of
    /// their own (they used to share one and read each other's staged copy).
    #[test]
    fn every_check_stages_into_its_own_directory() {
        let dirs: Vec<std::path::PathBuf> =
            (0..64).map(|_| super::scratch_dir().unwrap()).collect();
        let distinct: std::collections::BTreeSet<&std::path::PathBuf> = dirs.iter().collect();
        for dir in &dirs {
            assert!(dir.is_dir());
            std::fs::remove_dir_all(dir).unwrap();
        }
        assert_eq!(distinct.len(), dirs.len());
    }
}
