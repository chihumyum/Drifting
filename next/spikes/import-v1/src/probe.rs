//! Run the whole mapping over one library and report what an import would do.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::Instant;

use anyhow::Result;
use loro::cursor::Side;
use serde::Serialize;
use serde_json::Value;

use crate::anchors::{self, Resolution};
use crate::book::{self, BookStats};
use crate::legacy::{self, AssetCheck, Blockers, Freshness, Library, OrphanDocs, ProseKind};
use crate::loro_body;
use crate::prose::{self, Prose};
use crate::tables::{self, Fate};

pub struct Options {
    pub db: PathBuf,
    /// The old client's own rendering of every Yjs document (JSON lines).
    pub truth: Option<PathBuf>,
    /// The library's app-local data folder, to check asset bytes.
    pub app_local_data: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
pub struct TableRow {
    pub table: String,
    pub rows: i64,
    pub fate: Option<Fate>,
}

#[derive(Debug, Default, Serialize)]
pub struct KindStats {
    pub documents: usize,
    pub owner_deleted: usize,
    pub lines: usize,
    pub chars: usize,
    pub cache_parse_errors: usize,
    pub freshness: BTreeMap<Freshness, usize>,
    pub blocks: BTreeMap<String, usize>,
    pub marks: BTreeMap<String, usize>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruthCheck {
    pub compared: usize,
    pub truth_missing: usize,
    /// Per freshness class: [cache equals Yjs, cache differs].
    pub by_freshness: BTreeMap<Freshness, [usize; 2]>,
    /// Classified proven-fresh but different from Yjs. Must be 0.
    pub false_fresh: usize,
    /// Lines whose text differs, over all stale documents.
    pub stale_lines: usize,
    /// Characters the stale caches lack or have extra (absolute length difference).
    pub stale_chars: usize,
}

#[derive(Debug, Default, Serialize)]
pub struct LoroCheck {
    pub documents: usize,
    pub round_trip_ok: usize,
    pub round_trip_failed: usize,
    pub snapshot_bytes: usize,
    pub build_ms: u128,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorCheck {
    /// `source:version` → count.
    pub versions: BTreeMap<String, usize>,
    /// `source:resolution` → count, for anchors that point into a prose document.
    pub resolutions: BTreeMap<String, usize>,
    /// Entity-level, floating or region anchors: no text position to carry.
    pub positionless: usize,
    pub cursors_ok: usize,
    pub cursors_failed: usize,
}

#[derive(Debug, Default, Serialize)]
pub struct HistoryCheck {
    pub rows: usize,
    pub by_kind: BTreeMap<String, usize>,
    pub preview_present: usize,
    pub preview_parsed: usize,
    pub state_bytes: usize,
    pub entities: usize,
    pub replayed_versions: usize,
    pub replay_all_match: bool,
    pub replay_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct BookReport {
    pub trashed: bool,
    pub stats: BookStats,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub migrations: usize,
    pub tables: Vec<TableRow>,
    /// Tables in the library that the mapping does not know. Must be empty.
    pub unmapped_tables: Vec<String>,
    pub fates: BTreeMap<Fate, [i64; 2]>,
    pub books: Vec<BookReport>,
    pub prose: BTreeMap<ProseKind, KindStats>,
    pub orphan_yjs_documents: OrphanDocs,
    pub overlapping_entity_links: usize,
    pub unknown_inline_nodes: usize,
    pub truth: Option<TruthCheck>,
    pub loro: LoroCheck,
    pub anchors: AnchorCheck,
    pub history: HistoryCheck,
    pub assets: AssetCheck,
    pub blockers: Blockers,
    pub total_ms: u128,
}

fn count_structure(
    prose: &Prose,
    stats: &mut KindStats,
    overlapping: &mut usize,
    unknown_inline: &mut usize,
) {
    stats.lines += prose.lines.len();
    stats.chars += prose.chars();
    for line in &prose.lines {
        *stats.blocks.entry(line.kind.clone()).or_default() += 1;
        for container in &line.path {
            *stats.blocks.entry(container.kind.clone()).or_default() += 1;
        }
        let links: Vec<_> = line
            .marks
            .iter()
            .filter(|s| s.mark == "entityLink")
            .collect();
        for (i, a) in links.iter().enumerate() {
            if links[i + 1..]
                .iter()
                .any(|b| b.start < a.end && a.start < b.end)
            {
                *overlapping += 1;
            }
        }
        for span in &line.marks {
            *stats.marks.entry(span.mark.clone()).or_default() += 1;
            if span.mark == "inline" {
                *unknown_inline += 1;
            }
        }
    }
}

fn line_diff(a: &Prose, b: &Prose) -> (usize, usize) {
    let lines = a.lines.len().max(b.lines.len());
    let mut changed = 0;
    for i in 0..lines {
        if a.lines.get(i).map(|l| (&l.text, l.id())) != b.lines.get(i).map(|l| (&l.text, l.id())) {
            changed += 1;
        }
    }
    (changed, a.chars().abs_diff(b.chars()))
}

pub fn run(options: &Options) -> Result<Report> {
    let started = Instant::now();
    let library = Library::open(&options.db)?;
    let tables_in_db = library.tables()?;
    let mut fates: BTreeMap<Fate, [i64; 2]> = BTreeMap::new();
    let mut unmapped = Vec::new();
    let tables = tables_in_db
        .iter()
        .map(|(table, rows)| {
            let fate = tables::fate(table).map(|f| f.fate);
            match fate {
                Some(fate) => {
                    let entry = fates.entry(fate).or_default();
                    entry[0] += 1;
                    entry[1] += rows;
                }
                None => unmapped.push(table.clone()),
            }
            TableRow {
                table: table.clone(),
                rows: *rows,
                fate,
            }
        })
        .collect();

    let mut books = Vec::new();
    for (index, (project_id, _name, trashed)) in library.projects()?.into_iter().enumerate() {
        let (_, stats) = book::build(&library, &project_id, 1000 + index as u64)?;
        books.push(BookReport { trashed, stats });
    }

    let truth = options
        .truth
        .as_ref()
        .map(|p| legacy::read_truth(p))
        .transpose()?;
    let (owners, orphans) = legacy::prose_owners(&library)?;
    let mut prose_stats: BTreeMap<ProseKind, KindStats> = BTreeMap::new();
    let mut truth_check = truth.as_ref().map(|_| TruthCheck::default());
    let mut loro_check = LoroCheck::default();
    let mut overlapping = 0;
    let mut unknown_inline = 0;
    // The prose an import would write: Yjs truth when the comparison supplied it, else the cache.
    let mut imported: HashMap<String, (Prose, Vec<usize>, loro::LoroDoc)> = HashMap::new();
    for (index, owner) in owners.iter().enumerate() {
        let stats = prose_stats.entry(owner.kind).or_default();
        stats.documents += 1;
        stats.owner_deleted += usize::from(owner.owner_deleted);
        *stats.freshness.entry(owner.freshness).or_default() += 1;
        let cached = match prose::parse(owner.cached.as_deref().unwrap_or("{}")) {
            Ok(p) => p,
            Err(_) => {
                stats.cache_parse_errors += 1;
                Prose::default()
            }
        };
        let doc_id = owner.doc_id();
        let mut body = cached.clone();
        if let (Some(truth), Some(check)) = (truth.as_ref(), truth_check.as_mut()) {
            match truth.get(&doc_id) {
                Some(value) => {
                    let live = prose::parse_value(value).unwrap_or_default();
                    let same = prose::same_prose(&cached, &live);
                    check.compared += 1;
                    check.by_freshness.entry(owner.freshness).or_default()[usize::from(!same)] += 1;
                    if !same {
                        if owner.freshness.proven_fresh() {
                            check.false_fresh += 1;
                        }
                        let (lines, chars) = line_diff(&cached, &live);
                        check.stale_lines += lines;
                        check.stale_chars += chars;
                    }
                    body = live;
                }
                None if owner.freshness != Freshness::SeedOnly => check.truth_missing += 1,
                None => {}
            }
        }
        count_structure(&body, stats, &mut overlapping, &mut unknown_inline);
        let built_at = Instant::now();
        let built = loro_body::build(&body, 1 + index as u64)?;
        loro_check.build_ms += built_at.elapsed().as_millis();
        loro_check.documents += 1;
        if built.round_trip {
            loro_check.round_trip_ok += 1;
        } else {
            loro_check.round_trip_failed += 1;
        }
        loro_check.snapshot_bytes += built.snapshot_bytes;
        imported.insert(doc_id, (body, built.line_starts, built.doc));
    }

    // Anchors.
    let mut anchor_check = AnchorCheck::default();
    for row in legacy::anchors(&library)? {
        let anchor = anchors::parse_anchor(&row.anchor_json);
        *anchor_check
            .versions
            .entry(format!("{}:{}", row.source, anchor.version()))
            .or_default() += 1;
        let Some((prose, starts, doc)) = row.doc_id.as_ref().and_then(|d| imported.get(d)) else {
            anchor_check.positionless += 1;
            continue;
        };
        let (resolution, range) = match (&anchor.text, row.block_ids.is_empty()) {
            (Some(text), _) => anchors::resolve_text(prose, starts, text),
            (None, false) => anchors::resolve_blocks(prose, starts, &row.block_ids),
            (None, true) => {
                anchor_check.positionless += 1;
                continue;
            }
        };
        *anchor_check
            .resolutions
            .entry(format!("{}:{}", row.source, resolution_name(resolution)))
            .or_default() += 1;
        if let Some(range) = range {
            let start = loro_body::cursor_at(doc, range.start, Side::Middle)?;
            let end = loro_body::cursor_at(doc, range.end, Side::Middle)?;
            if start.is_some() && end.is_some() {
                anchor_check.cursors_ok += 1;
            } else {
                anchor_check.cursors_failed += 1;
            }
        }
    }

    // Snapshot history: previews, then a replay per entity ending at the imported body.
    let mut history_check = HistoryCheck {
        replay_all_match: true,
        ..HistoryCheck::default()
    };
    let rows = legacy::history(&library)?;
    let mut by_doc: BTreeMap<String, Vec<Prose>> = BTreeMap::new();
    for row in &rows {
        history_check.rows += 1;
        *history_check
            .by_kind
            .entry(row.entity_kind.clone())
            .or_default() += 1;
        history_check.state_bytes += row.state_bytes;
        let _ = &row.meta;
        let _ = &row.created_at;
        if let Some(preview) = &row.preview {
            history_check.preview_present += 1;
            if let Ok(prose) = prose::parse(preview) {
                history_check.preview_parsed += 1;
                by_doc
                    .entry(legacy::history_doc_id(row))
                    .or_default()
                    .push(prose);
            }
        }
    }
    let replay_started = Instant::now();
    for (index, (doc_id, mut versions)) in by_doc.into_iter().enumerate() {
        if let Some((current, _, _)) = imported.get(&doc_id) {
            versions.push(current.clone());
        }
        history_check.entities += 1;
        history_check.replayed_versions += versions.len();
        let (_, _, all_match) = loro_body::replay(&versions, 50_000 + index as u64)?;
        history_check.replay_all_match &= all_match;
    }
    history_check.replay_ms = replay_started.elapsed().as_millis();

    Ok(Report {
        migrations: library.migrations,
        tables,
        unmapped_tables: unmapped,
        fates,
        books,
        prose: prose_stats,
        orphan_yjs_documents: orphans,
        overlapping_entity_links: overlapping,
        unknown_inline_nodes: unknown_inline,
        truth: truth_check,
        loro: loro_check,
        anchors: anchor_check,
        history: history_check,
        assets: legacy::assets(&library, options.app_local_data.as_deref())?,
        blockers: legacy::blockers(&library)?,
        total_ms: started.elapsed().as_millis(),
    })
}

fn resolution_name(resolution: Resolution) -> String {
    match serde_json::to_value(resolution) {
        Ok(Value::String(s)) => s,
        _ => format!("{resolution:?}"),
    }
}

/// The mapping as the Markdown table the conclusion document carries.
pub fn mapping_markdown() -> String {
    let mut out = String::from("| 旧表 | 去向 | 落到哪里 / 为什么 |\n| --- | --- | --- |\n");
    for entry in tables::TABLES {
        let fate = match serde_json::to_value(entry.fate) {
            Ok(Value::String(s)) => s,
            _ => String::new(),
        };
        out.push_str(&format!(
            "| `{}` | {} | {} |\n",
            entry.table, fate, entry.target
        ));
    }
    out
}

/// One library of the acceptance evidence.
#[derive(Debug, serde::Deserialize)]
pub struct EvidenceInput {
    pub label: String,
    /// How the copy was made (no paths).
    pub origin: String,
    pub db: PathBuf,
    pub truth: Option<PathBuf>,
    #[serde(rename = "appLocalData")]
    pub app_local_data: Option<PathBuf>,
}

fn summary(input: &EvidenceInput, report: &Report) -> Value {
    let prose: BTreeMap<String, Value> = report
        .prose
        .iter()
        .map(|(kind, s)| {
            (
                kind.prefix().to_string(),
                serde_json::json!({
                    "documents": s.documents, "ownerDeleted": s.owner_deleted, "lines": s.lines, "chars": s.chars,
                    "cacheParseErrors": s.cache_parse_errors, "freshness": s.freshness, "marks": s.marks,
                }),
            )
        })
        .collect();
    let rows: BTreeMap<String, i64> = report
        .tables
        .iter()
        .filter(|t| t.rows > 0)
        .map(|t| (t.table.clone(), t.rows))
        .collect();
    serde_json::json!({
        "label": input.label,
        "origin": input.origin,
        "migrations": report.migrations,
        "unmappedTables": report.unmapped_tables,
        "nonEmptyTables": rows,
        "books": report.books.iter().map(|b| serde_json::json!({ "trashed": b.trashed, "entries": b.stats.entries, "bookOrder": b.stats.book_order, "narrativeOrder": b.stats.narrative_order, "treeNodes": b.stats.tree_nodes })).collect::<Vec<_>>(),
        "prose": prose,
        "orphanYjsDocuments": report.orphan_yjs_documents,
        "overlappingEntityLinks": report.overlapping_entity_links,
        "unknownInlineNodes": report.unknown_inline_nodes,
        "truth": report.truth,
        "loro": { "documents": report.loro.documents, "roundTripOk": report.loro.round_trip_ok, "roundTripFailed": report.loro.round_trip_failed, "snapshotBytes": report.loro.snapshot_bytes },
        "anchors": report.anchors,
        "history": {
            "rows": report.history.rows, "byKind": report.history.by_kind, "previewPresent": report.history.preview_present,
            "previewParsed": report.history.preview_parsed, "stateBytes": report.history.state_bytes, "entities": report.history.entities,
            "replayedVersions": report.history.replayed_versions, "replayAllMatch": report.history.replay_all_match,
        },
        "assets": report.assets,
        "blockers": report.blockers,
    })
}

/// Run every library of a manifest and produce the evidence document.
pub fn evidence(inputs: &[EvidenceInput]) -> Result<Value> {
    let mut libraries = Vec::new();
    for input in inputs {
        let report = run(&Options {
            db: input.db.clone(),
            truth: input.truth.clone(),
            app_local_data: input.app_local_data.clone(),
        })?;
        libraries.push(summary(input, &report));
    }
    let mapping: Vec<Value> = tables::TABLES
        .iter()
        .map(|t| serde_json::json!({ "table": t.table, "fate": t.fate, "target": t.target }))
        .collect();
    Ok(serde_json::json!({
        "spike": "P0-E legacy library import",
        "generatedBy": "cargo run -p import-v1-spike --release -- evidence <manifest.json>",
        "schema": { "migrations": legacy::SUPPORTED_MIGRATIONS, "tables": tables::TABLES.len() },
        "mapping": mapping,
        "libraries": libraries,
    }))
}

/// The invariants the evidence must show. Returns the problems found.
pub fn check_evidence(evidence: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    let mapping: Vec<(String, Value)> = evidence["mapping"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    (
                        m["table"].as_str().unwrap_or("").to_string(),
                        m["fate"].clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let expected: Vec<(String, Value)> = tables::TABLES
        .iter()
        .map(|t| {
            (
                t.table.to_string(),
                serde_json::to_value(t.fate).unwrap_or(Value::Null),
            )
        })
        .collect();
    if mapping != expected {
        problems.push("mapping differs from tables::TABLES".into());
    }
    let libraries = evidence["libraries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if libraries.is_empty() {
        problems.push("no libraries".into());
    }
    for library in &libraries {
        let label = library["label"].as_str().unwrap_or("?");
        let mut require = |ok: bool, what: &str| {
            if !ok {
                problems.push(format!("{label}: {what}"));
            }
        };
        require(
            library["unmappedTables"]
                .as_array()
                .is_some_and(Vec::is_empty),
            "unmapped tables",
        );
        require(
            library["migrations"].as_u64() == Some(legacy::SUPPORTED_MIGRATIONS as u64),
            "migration level",
        );
        require(
            library["loro"]["roundTripFailed"].as_u64() == Some(0),
            "Loro round trip failed",
        );
        require(
            library["anchors"]["cursorsFailed"].as_u64() == Some(0),
            "cursor failed",
        );
        require(
            library["history"]["replayAllMatch"].as_bool() == Some(true),
            "history replay mismatch",
        );
        require(
            library["assets"]["shaMismatch"].as_u64() == Some(0),
            "asset hash mismatch",
        );
        require(
            library["assets"]["filesMissing"].as_u64() == Some(0),
            "asset file missing",
        );
        if !library["truth"].is_null() {
            require(
                library["truth"]["falseFresh"].as_u64() == Some(0),
                "a cache proven fresh differs from Yjs",
            );
            require(
                library["truth"]["truthMissing"].as_u64() == Some(0),
                "a Yjs document was not compared",
            );
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_evidence_holds() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/rust-rewrite/acceptance/p0-e-import.json");
        let text =
            std::fs::read_to_string(&path).expect("docs/rust-rewrite/acceptance/p0-e-import.json");
        let evidence: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(check_evidence(&evidence), Vec::<String>::new());
    }
}
