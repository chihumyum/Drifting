//! One import, start to finish (`m10-import.md` "流程"):
//!
//! 1. stage the 0.1 database (the original is only read) and bring it up to
//!    the last 0.1 schema;
//! 2. classify every body's freshness and decide the gate; stop unless it is
//!    clear or the author accepted;
//! 3. per book: plan every body, give projected TODOs their ids, write each
//!    prose document (snapshot history first, then the current body) and
//!    the book document in memory with dr-doc (deterministic import peers and
//!    the 0.1 timestamps), store them in dr-store (origin `import`), copy the
//!    assets;
//! 4. label the history points, write the receipt and the summary.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Instant;

use dr_doc::Anchor;
use dr_doc::book::BookDoc;
use dr_doc::loro_types::{Frontiers, VersionVector};
use dr_doc::peer::import_peer;
use dr_doc::prose::ProseDoc;
use dr_model::id::{BlockId, BookId, CommentId};
use dr_model::kind::ProjectionKind;
use dr_model::{DocId, Origin, ProseProfile};
use dr_store::{Device, Library, LibraryOptions, OpenDoc};
use serde::Serialize;
use serde_json::Value;

use crate::anchors::{self, Resolution};
use crate::book;
use crate::error::{ImportError, Result};
use crate::gate::{Accept, Gate};
use crate::handoff::BookSettings;
use crate::legacy::{HistoryRow, Legacy, ProseKind, ProseOwner};
use crate::locate;
use crate::prose::{self, BlockSpan, Context, DocBlocks, Notes, Para, Plan, pm, read, write};
use crate::receipt::{self, AnchorRecord, BookRecord, DocRecord, Receipt};
use crate::staging::{self, Staged};
use crate::time::parse_iso_ms;

/// The importer's name in receipts.
pub const IMPORTER: &str = concat!("dr-import-v1 ", env!("CARGO_PKG_VERSION"));

/// How to import.
#[derive(Clone, Debug)]
pub struct Options {
    /// What the author accepted when the gate stopped ("仍然导入").
    pub accept: Accept,
    /// The 0.2 app version (dr-store's safety snapshots and library meta).
    pub app_version: String,
    /// The 0.1 library's data root: assets, installation identity. Without
    /// it no asset bytes are copied.
    pub old_root: Option<PathBuf>,
    /// This device's directory for dr-store's [`Device`]. When it has no
    /// installation identity yet, the 0.1 one is adopted, so writing days
    /// continue under the same device key.
    pub device_dir: Option<PathBuf>,
    /// Keep the staging copy after a successful import.
    pub keep_staging: bool,
    /// Also check every history version by loading it at its frontiers.
    pub verify_history: bool,
}

impl Options {
    pub fn new(app_version: impl Into<String>) -> Self {
        Self {
            accept: Accept::NOTHING,
            app_version: app_version.into(),
            old_root: None,
            device_dir: None,
            keep_staging: false,
            verify_history: false,
        }
    }
}

/// What an import (or an analysis) came to.
#[derive(Debug)]
pub enum Outcome {
    /// The gate stopped it; nothing was written to the new library.
    Blocked(Gate),
    Imported(Box<Receipt>),
}

/// Timing of one import, for the measurements.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    /// Copying, recovering and migrating the 0.1 database, and the gate.
    pub stage_ms: f64,
    pub prose_ms: f64,
    pub book_ms: f64,
    pub store_ms: f64,
    pub assets_ms: f64,
    pub receipt_ms: f64,
    pub total_ms: f64,
}

/// Stage and analyse a 0.1 library without writing anything new.
pub fn analyse(
    source: &Path,
    staging_dir: &Path,
) -> Result<(Staged, Legacy, Vec<ProseOwner>, Gate)> {
    let staged = staging::stage(source, staging_dir, "source")?;
    let legacy = Legacy::new(staged.open()?)?;
    let (owners, _) = legacy.prose_owners()?;
    let sync = legacy.sync_blockers()?;
    let mut gate = Gate::decide(
        legacy.stamp.is_some(),
        legacy.stamp.as_ref().and_then(|s| s.app_version.clone()),
        &owners,
        sync,
    );
    fill_titles(&legacy, &mut gate)?;
    Ok((staged, legacy, owners, gate))
}

fn fill_titles(legacy: &Legacy, gate: &mut Gate) -> Result<()> {
    for d in &mut gate.doubtful {
        let Some((kind, id)) = ProseKind::from_doc_id(&d.doc) else {
            continue;
        };
        let sql = match kind {
            ProseKind::NodeContent => "SELECT title FROM book_node WHERE id = ?1",
            ProseKind::Element => "SELECT name FROM element WHERE id = ?1",
            ProseKind::Storyline => "SELECT name FROM storylines WHERE id = ?1",
            ProseKind::Category => "SELECT name FROM element_category WHERE id = ?1",
            ProseKind::LibraryItem => "SELECT title FROM library_item WHERE id = ?1",
        };
        d.title = legacy.conn.query_row(sql, [id], |r| r.get(0)).ok();
    }
    Ok(())
}

fn secs(ms: i64) -> i64 {
    ms.div_euclid(1000)
}

/// Adopt the 0.1 installation identity into `device_dir` when it has none.
fn adopt_identity(old_root: Option<&Path>, device_dir: &Path) -> Result<bool> {
    let target = device_dir.join(locate::INSTALLATION_FILE);
    if target.exists() {
        return Ok(false);
    }
    let Some(id) = old_root.and_then(locate::installation_id) else {
        return Ok(false);
    };
    std::fs::create_dir_all(device_dir)?;
    let tmp = device_dir.join(format!(".{}.import.tmp", locate::INSTALLATION_FILE));
    std::fs::write(
        &tmp,
        serde_json::to_vec(&serde_json::json!({"version": 2, "installation_id": id}))?,
    )?;
    std::fs::rename(&tmp, &target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(true)
}

struct Body<'a> {
    owner: &'a ProseOwner,
    doc_id: DocId,
    profile: ProseProfile,
    lines: pm::Prose,
    blocks: DocBlocks,
    history: Vec<&'a HistoryRow>,
}

/// A history label to write once the documents are stored.
struct Label {
    doc_id: String,
    frontiers: Frontiers,
    ts_ms: i64,
    label: &'static str,
}

fn old_doc_of_target(kind: &str, id: &str) -> Option<String> {
    let prefix = match kind {
        "node" => "node-content",
        "element" => "element",
        "storyline" => "storyline",
        "category" => "category",
        "library_item" | "material" => "library-item",
        _ => return None,
    };
    Some(format!("{prefix}:{id}"))
}

fn store_doc(
    lib: &Library,
    doc_id: &DocId,
    book: &str,
    genesis: Vec<u8>,
    bytes: Vec<u8>,
) -> Result<()> {
    let id = doc_id.to_string();
    let g = genesis;
    let h = lib.open_doc(
        &id,
        OpenDoc::CreateIfMissing {
            kind: doc_id.kind().prefix(),
            book_id: Some(book),
            genesis: &move |d: &loro::LoroDoc| {
                d.import(&g)
                    .expect("dr-doc's genesis imports into an empty document");
            },
        },
    )?;
    let imported = h.import(bytes, dr_store::Origin::Import)?;
    if imported.status.pending.is_some() {
        return Err(ImportError::Invalid(format!(
            "{id}: imported updates wait for missing ones"
        )));
    }
    h.close();
    Ok(())
}

/// Import the 0.1 library at `source` into the 0.2 library at `target`.
pub fn import(source: &Path, target: &Path, options: &Options) -> Result<(Outcome, Timing)> {
    let started = Instant::now();
    let started_ms = dr_store::now_ms();
    let mut timing = Timing::default();
    let staging_dir = receipt::directory(target).join("staging");
    let (staged, legacy, owners, gate) = analyse(source, &staging_dir)?;
    timing.stage_ms = started.elapsed().as_secs_f64() * 1e3;
    if !gate.allows(options.accept) {
        if !options.keep_staging {
            let _ = std::fs::remove_dir_all(&staging_dir);
            // Leave nothing behind (removes the folder only if empty).
            let _ = std::fs::remove_dir(receipt::directory(target));
            let _ = std::fs::remove_dir(target);
        }
        return Ok((Outcome::Blocked(gate), timing));
    }

    let adopted = match &options.device_dir {
        Some(dir) => adopt_identity(options.old_root.as_deref(), dir)?,
        None => false,
    };
    let mut lib_options = LibraryOptions::new(options.app_version.clone());
    lib_options.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
    if let Some(dir) = &options.device_dir {
        lib_options.device = Some(Device::open(dir)?);
    }
    let lib = Library::open(target, lib_options)?;

    let (_, orphans) = legacy.prose_owners()?;
    let history = legacy.history()?;
    let stamp = legacy.stamp.clone();
    let mut books = Vec::new();
    let mut docs = Vec::new();
    let mut anchors_out = Vec::new();
    let mut originals = Vec::new();
    let mut labels: Vec<Label> = Vec::new();

    for project in legacy.projects()? {
        let mut rec = BookRecord {
            book_id: project.id.clone(),
            name: project.name.clone(),
            trashed: project.deleted_at.is_some(),
            ..BookRecord::default()
        };
        let Ok(book_id) = BookId::parse(&project.id) else {
            rec.status = "invalid-book-id".into();
            books.push(rec);
            continue;
        };
        let book_doc_id = DocId::Book(book_id.clone());
        if lib.doc_info(&book_doc_id.to_string())?.is_some() {
            rec.status = "already-imported".into();
            books.push(rec);
            continue;
        }
        let rows = legacy.book(&project.id)?;
        let mut notes = Notes::default();
        let empty = BookSettings::default();
        let settings = stamp
            .as_ref()
            .and_then(|s| s.books.get(&project.id))
            .unwrap_or(&empty);

        // Pass 1: every body's lines and block ids.
        let mut bodies: Vec<Body<'_>> = Vec::new();
        for o in owners.iter().filter(|o| o.project_id == project.id) {
            let Ok(doc_id) = DocId::parse(&o.new_doc_id()) else {
                notes.add("invalid-id");
                continue;
            };
            let profile = doc_id.profile().unwrap_or(ProseProfile::Prose);
            let lines = match pm::parse(o.cache.as_deref().unwrap_or("")) {
                Ok(l) => l,
                Err(_) => {
                    notes.add("cache-unreadable");
                    pm::Prose::default()
                }
            };
            let blocks = prose::doc_blocks(&lines);
            let old = o.old_doc_id();
            let mut hist: Vec<&HistoryRow> =
                history.iter().filter(|h| h.old_doc_id() == old).collect();
            hist.sort_by(|a, b| {
                (parse_iso_ms(&a.created_at), &a.id).cmp(&(parse_iso_ms(&b.created_at), &b.id))
            });
            bodies.push(Body {
                owner: o,
                doc_id,
                profile,
                lines,
                blocks,
                history: hist,
            });
        }
        let mut spans: HashMap<String, BlockSpan> = HashMap::new();
        for b in &bodies {
            for id in b.blocks.ranges.keys() {
                if let Some(s) = b.blocks.span(id) {
                    spans.entry(id.clone()).or_insert(s);
                }
            }
        }
        let span = |old: &str| spans.get(old).cloned();

        // Projected TODOs get deterministic ids.
        let mut projected: HashMap<String, (CommentId, ProjectionKind, DocId, BlockId)> =
            HashMap::new();
        for c in &rows.comments {
            let meta: Value = c
                .metadata_json
                .as_deref()
                .and_then(|m| serde_json::from_str(m).ok())
                .unwrap_or(Value::Null);
            let kind = match meta.get("kind").and_then(Value::as_str) {
                Some("todo-autoparse") => ProjectionKind::Marker,
                Some("note-task") => ProjectionKind::NoteTask,
                _ => continue,
            };
            let (Some(tk), Some(tid)) = (c.target_kind.as_deref(), c.target_id.as_deref()) else {
                notes.add("projected-todo-without-target");
                continue;
            };
            let Some(doc) = old_doc_of_target(tk, tid)
                .and_then(|o| {
                    ProseKind::from_doc_id(&o).map(|(k, id)| format!("{}:{id}", k.new_prefix()))
                })
                .and_then(|d| DocId::parse(&d).ok())
            else {
                notes.add("projected-todo-without-target");
                continue;
            };
            let old_block = meta
                .get("blockId")
                .and_then(Value::as_str)
                .or(c.target_block_id.as_deref());
            let Some(block) = old_block.and_then(|b| {
                span(b)
                    .and_then(|s| s.first)
                    .or_else(|| BlockId::parse(b).ok())
            }) else {
                notes.add("projected-todo-without-block");
                continue;
            };
            let new = CommentId::for_projection(&kind, &doc, &block);
            projected.insert(c.id.clone(), (new, kind, doc, block));
        }
        rec.projected_todos = projected.len();
        let todo = |old: &str| projected.get(old).map(|p| p.0.clone());

        // Pass 2: plan, write and check every body, history first.
        let mut anchors_made: HashMap<String, Anchor> = HashMap::new();
        for b in &bodies {
            let t0 = Instant::now();
            let ctx = Context {
                profile: b.profile,
                span: &span,
                todo: &todo,
            };
            let current = prose::plan(&b.lines, &b.blocks, &ctx);
            let mut versions: Vec<(Plan, i64)> = Vec::new();
            for h in &b.history {
                let Some(preview) = h.preview.as_deref() else {
                    notes.add("history-row-without-preview");
                    continue;
                };
                let Ok(lines) = pm::parse(preview) else {
                    notes.add("history-preview-unreadable");
                    continue;
                };
                let blocks = prose::doc_blocks(&lines);
                let ts = parse_iso_ms(&h.created_at).unwrap_or(0);
                versions.push((prose::plan(&lines, &blocks, &ctx), ts));
            }
            let final_ms = parse_iso_ms(&b.owner.updated_at)
                .unwrap_or(0)
                .max(versions.last().map_or(0, |v| v.1));
            let id_s = b.doc_id.to_string();
            let mut doc = ProseDoc::create(b.doc_id.clone(), import_peer(&id_s))?;
            for (p, ts) in &versions {
                let (r, _) = doc.edit_at(Origin::Import, Some(secs(*ts)), |t| {
                    write::sync(t, &p.paras)
                });
                r?;
                labels.push(Label {
                    doc_id: id_s.clone(),
                    frontiers: doc.frontiers(),
                    ts_ms: *ts,
                    label: dr_store::history::labels::PERIODIC,
                });
            }
            let (r, _) = doc.edit_at(Origin::Import, Some(secs(final_ms)), |t| {
                write::sync(t, &current.paras)
            });
            r?;
            let back: Vec<Para> = read::read_paras(&doc.view());
            let stored_exactly = back == current.paras;
            let round_trips = prose::round_trips(&back, b.profile);
            if options.verify_history && !versions.is_empty() {
                // Every version checks out on a detached copy.
                let bytes = vec![doc.export_snapshot()?];
                for (n, (p, _)) in versions.iter().enumerate() {
                    let at = labels[labels.len() - versions.len() + n].frontiers.clone();
                    let copy = dr_doc::prose::ProseReader::load_at(b.doc_id.clone(), &bytes, &at)?;
                    if read::read_paras(&copy.view()) != p.paras {
                        notes.add("history-version-differs");
                    }
                }
            }
            // Anchors on this body (comments and patches), on the current version.
            let old = b.owner.old_doc_id();
            {
                let starts = current.starts();
                let view = doc.view();
                let mut make =
                    |entity: &'static str,
                     id: &str,
                     resolved: (Resolution, Option<anchors::BodyRange>)| {
                        let (resolution, range) = resolved;
                        let range = range.filter(|r| !r.is_empty());
                        let resolution = if range.is_none() && resolved_some(resolution) {
                            Resolution::Empty
                        } else {
                            resolution
                        };
                        let made = range.as_ref().and_then(|r| {
                            let a = view.anchor(r.clone())?;
                            let back = view.resolve(&a)?;
                            (back.range == *r).then_some(a)
                        });
                        let cursor = made.is_some();
                        if let Some(a) = made {
                            anchors_made.insert(id.to_string(), a);
                        }
                        anchors_out.push(AnchorRecord {
                            entity,
                            id: id.to_string(),
                            doc_id: id_s.clone(),
                            resolution,
                            cursor,
                        });
                        cursor
                    };
                for c in &rows.comments {
                    if c.target_kind
                        .as_deref()
                        .zip(c.target_id.as_deref())
                        .and_then(|(k, i)| old_doc_of_target(k, i))
                        .as_deref()
                        != Some(old.as_str())
                    {
                        continue;
                    }
                    if projected.contains_key(&c.id) {
                        // A projected TODO's position is its block.
                        continue;
                    }
                    let a = anchors::parse_anchor(&c.anchor_json);
                    let ids: Vec<String> =
                        serde_json::from_str::<Vec<String>>(&c.target_block_ids_json)
                            .ok()
                            .filter(|v| !v.is_empty())
                            .or_else(|| c.target_block_id.clone().map(|b| vec![b]))
                            .unwrap_or_default();
                    let resolved = match &a.text {
                        Some(t) => anchors::resolve_text(&b.lines, &current, &starts, t),
                        None if !ids.is_empty() => {
                            anchors::resolve_blocks(&b.lines, &current, &starts, &ids)
                        }
                        None => continue,
                    };
                    if make("comment", &c.id, resolved) {
                        rec.anchors_with_cursors += 1;
                    } else {
                        rec.anchors_without_cursors += 1;
                    }
                }
                if b.owner.kind == ProseKind::NodeContent {
                    for p in rows
                        .patches
                        .iter()
                        .filter(|p| p.source_node.as_deref() == Some(b.owner.id.as_str()))
                    {
                        let resolved = match p
                            .text_anchor_json
                            .as_deref()
                            .and_then(|j| serde_json::from_str::<Value>(j).ok())
                            .and_then(|v| anchors::parse_text_anchor(&v))
                        {
                            Some(t) => anchors::resolve_text(&b.lines, &current, &starts, &t),
                            None => match &p.source_block {
                                Some(sb) => anchors::resolve_blocks(
                                    &b.lines,
                                    &current,
                                    &starts,
                                    std::slice::from_ref(sb),
                                ),
                                None => continue,
                            },
                        };
                        if make("patch", &p.id, resolved) {
                            rec.anchors_with_cursors += 1;
                        } else {
                            rec.anchors_without_cursors += 1;
                        }
                    }
                }
            }
            // Duplicate block ids from the 0.1 data, fixed the dr-doc way.
            let (repaired, _) = doc.edit_at(Origin::Repair, Some(secs(final_ms)), |t| {
                t.repair_block_ids()
            });
            let repaired = repaired?;
            labels.push(Label {
                doc_id: id_s.clone(),
                frontiers: doc.frontiers(),
                ts_ms: started_ms,
                label: IMPORT_LABEL,
            });
            let bytes = doc.export_updates_since(&VersionVector::default())?;
            timing.prose_ms += t0.elapsed().as_secs_f64() * 1e3;
            let t1 = Instant::now();
            store_doc(
                &lib,
                &b.doc_id,
                &project.id,
                dr_doc::prose::genesis(&b.doc_id),
                bytes,
            )?;
            timing.store_ms += t1.elapsed().as_secs_f64() * 1e3;
            let mut doc_notes = current.notes.clone();
            notes.merge(&doc_notes);
            if repaired > 0 {
                doc_notes.add("block-id-assigned");
            }
            rec.history_points += versions.len();
            docs.push(DocRecord {
                doc_id: id_s,
                old_doc_id: old,
                book_id: project.id.clone(),
                kind: b.owner.kind,
                freshness: b.owner.freshness,
                revision: b.owner.revision,
                cache_sha256: b.owner.cache_sha256(),
                history_versions: versions.len(),
                paragraphs: back.len(),
                chars: back.iter().map(Para::len).sum(),
                stored_exactly,
                round_trips,
                repaired_block_ids: repaired,
                notes: doc_notes,
                dropped_inline: current.dropped_inline.clone(),
            });
        }
        rec.bodies = bodies.len();

        // The book document.
        let t2 = Instant::now();
        let book_ts = secs(parse_iso_ms(&project.updated_at).unwrap_or(0));
        let mut bdoc = BookDoc::create(book_id.clone(), import_peer(&book_doc_id.to_string()))?;
        let inputs = book::Inputs {
            book: &book_id,
            project: &project,
            rows: &rows,
            settings: Some(settings),
            projected: &projected,
            anchors: &anchors_made,
            span: &span,
        };
        let (r, _) = bdoc.edit_at(Origin::Import, Some(book_ts), |t| {
            book::write(t, &inputs, &mut notes)
        });
        for (c, id, f, json) in r? {
            originals.push((c.to_string(), id, f.to_string(), json));
        }
        let (r, _) = bdoc.edit_at(Origin::Repair, Some(book_ts), |t| {
            let plan = t.view().repair_plan();
            t.apply_repair(&plan)
        });
        r?;
        let bytes = bdoc.export_updates_since(&VersionVector::default())?;
        timing.book_ms += t2.elapsed().as_secs_f64() * 1e3;
        let t3 = Instant::now();
        store_doc(
            &lib,
            &book_doc_id,
            &project.id,
            dr_doc::book::genesis(&book_id),
            bytes,
        )?;
        timing.store_ms += t3.elapsed().as_secs_f64() * 1e3;

        // Asset bytes.
        let t4 = Instant::now();
        copy_assets(
            &lib,
            options.old_root.as_deref(),
            &project.id,
            &rows.assets,
            &mut rec,
            &mut notes,
        )?;
        timing.assets_ms += t4.elapsed().as_secs_f64() * 1e3;

        rec.rows = [
            ("book_node", rows.nodes.len()),
            ("book_act", rows.acts.len()),
            ("storylines", rows.storylines.len()),
            ("element", rows.elements.len()),
            ("element_category", rows.categories.len()),
            ("entity_kv_entry", rows.kv.len()),
            ("entity_relation_type", rows.relation_types.len()),
            ("entity_relation", rows.relations.len()),
            ("timeline_marker", rows.time_pins.len()),
            ("plot_grid_document", rows.plot_docs.len()),
            ("comment", rows.comments.len()),
            ("comment_action", rows.comment_actions.len()),
            ("element_patch", rows.patches.len()),
            ("library_item", rows.materials.len()),
            ("material_folder", rows.folders.len()),
            ("drift_group", rows.groups.len()),
            ("agent_memory", rows.memory.len()),
            ("writing_day", rows.writing_days.len()),
            ("project_asset", rows.assets.len()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        rec.notes = notes;
        rec.status = "imported".into();
        books.push(rec);
    }
    lib.close()?;

    let t5 = Instant::now();
    write_labels(target, &labels)?;
    let counts = legacy.table_counts()?;
    let pick = |tables: &[&str]| -> BTreeMap<String, i64> {
        tables
            .iter()
            .map(|t| (t.to_string(), counts.get(*t).copied().unwrap_or(0)))
            .collect()
    };
    let receipt = Receipt {
        importer: IMPORTER,
        started_ms,
        finished_ms: dr_store::now_ms(),
        source_sha256: staged.source.sha256.clone(),
        source_bytes: staged.source.database_bytes + staged.source.wal_bytes,
        schema_level_before: staged.level_before.applied,
        gate,
        accepted: options.accept,
        books,
        docs,
        anchors: anchors_out,
        originals,
        orphan_yjs_docs: orphans.owner_missing + orphans.unknown_prefix,
        archived_rows: pick(receipt::AGENT_ARCHIVE),
        local_rows: pick(receipt::LOCAL),
        installation_id_adopted: adopted,
    };
    let settings = stamp.map(|s| s.settings).unwrap_or_default();
    drop(legacy);
    receipt::write(target, &staged.path, &receipt, &settings)?;
    timing.receipt_ms = t5.elapsed().as_secs_f64() * 1e3;
    if !options.keep_staging {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    timing.total_ms = started.elapsed().as_secs_f64() * 1e3;
    Ok((Outcome::Imported(Box::new(receipt)), timing))
}

/// The history label on the version as imported.
pub const IMPORT_LABEL: &str = "import";

fn resolved_some(r: Resolution) -> bool {
    matches!(
        r,
        Resolution::Exact
            | Resolution::Relocated
            | Resolution::TextChanged
            | Resolution::WholeBlock
            | Resolution::SomeBlocksMissing
    )
}

fn copy_assets(
    lib: &Library,
    old_root: Option<&Path>,
    book: &str,
    assets: &[crate::legacy::AssetRow],
    rec: &mut BookRecord,
    notes: &mut Notes,
) -> Result<()> {
    use sha2::{Digest, Sha256};
    let Some(root) = old_root else {
        if !assets.is_empty() {
            notes.add("asset-bytes-not-copied");
        }
        return Ok(());
    };
    for a in assets {
        let dir = root
            .join("assets")
            .join(dr_store::asset::sanitized_segment(book)?)
            .join(dr_store::asset::sanitized_segment(&a.id)?);
        let source = std::fs::read_dir(&dir).ok().and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| p.file_stem().is_some_and(|s| s == "source") && p.is_file())
        });
        let Some(source) = source else {
            rec.assets_missing += 1;
            continue;
        };
        let bytes = std::fs::read(&source)?;
        let sha: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if sha != a.sha256 || bytes.len() as i64 != a.size {
            rec.assets_mismatched += 1;
            continue;
        }
        let ext = source
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let dims = match (a.width, a.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some((w as u32, h as u32)),
            _ => None,
        };
        lib.import_asset(&dr_store::asset::SourceImport {
            book_id: book,
            asset_id: &a.id,
            source: &source,
            mime: &a.mime,
            ext: &ext,
            dimensions: dims,
            limit: 512 * 1024 * 1024,
        })?;
        rec.assets_copied += 1;
    }
    Ok(())
}

/// History labels at the replayed versions, with their 0.1 times. dr-store
/// has no call for "a label at these frontiers at that time" (only "label
/// the current version now"), so the rows are written here, in exactly the
/// shape dr-store writes them (`history.rs` `insert`), after the library is
/// closed (`m10-import.md` 待协调 2).
fn write_labels(root: &Path, labels: &[Label]) -> Result<()> {
    let db = dr_store::LibraryPaths::new(root).db;
    let conn = rusqlite::Connection::open(db)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO history_label (doc_id, frontiers, book_frontiers, label, ts)
             VALUES (?1, ?2, (SELECT h.frontiers FROM loro_doc d JOIN loro_head h ON h.doc_id = 'book:' || d.book_id WHERE d.doc_id = ?1), ?3, ?4)",
        )?;
        for l in labels {
            stmt.execute(rusqlite::params![
                l.doc_id,
                l.frontiers.encode(),
                l.label,
                l.ts_ms
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}
