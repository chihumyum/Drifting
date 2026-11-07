//! Checking an imported library: against the 0.1 ground truth (the Yjs
//! rendering the fixture generator wrote, `truth/<name>.jsonl`), and its
//! derived indexes. Used by the measurement (`examples/m10-measure.rs`) and
//! the dev tool; not part of the import.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use dr_doc::prose::ProseDoc;
use dr_model::{DocId, ProseProfile};
use dr_store::{Library, LibraryOptions};
use serde_json::{Value, json};

use crate::error::Result;
use crate::prose::{self, Context, Para, pm, read};
use crate::receipt::Receipt;
use crate::run::Timing;

/// The import's own numbers, for the measurement.
pub fn summary(receipt: &Receipt, timing: &Timing) -> Value {
    let kebab = |v: Value| v.as_str().unwrap_or("").to_string();
    let mut by_fresh: BTreeMap<String, usize> = BTreeMap::new();
    for d in &receipt.docs {
        *by_fresh
            .entry(kebab(serde_json::to_value(d.freshness).unwrap_or_default()))
            .or_default() += 1;
    }
    let mut notes = prose::Notes::default();
    for b in &receipt.books {
        notes.merge(&b.notes);
    }
    let mut resolutions: BTreeMap<String, usize> = BTreeMap::new();
    for a in &receipt.anchors {
        *resolutions
            .entry(kebab(
                serde_json::to_value(a.resolution).unwrap_or_default(),
            ))
            .or_default() += 1;
    }
    let sum =
        |f: fn(&crate::receipt::BookRecord) -> usize| receipt.books.iter().map(f).sum::<usize>();
    json!({
        "timing": timing,
        "books": receipt.books.len(),
        "bodies": receipt.docs.len(),
        "chars": receipt.docs.iter().map(|d| d.chars).sum::<usize>(),
        "byFreshness": by_fresh,
        "storedExactly": receipt.docs.iter().filter(|d| d.stored_exactly).count(),
        "roundTrips": receipt.docs.iter().filter(|d| d.round_trips).count(),
        "historyVersions": receipt.docs.iter().map(|d| d.history_versions).sum::<usize>(),
        "historyMetaReplayed": sum(|b| b.history_meta_replayed),
        "historyMetaChecked": sum(|b| b.history_meta_checked),
        "repairedBlockIds": receipt.docs.iter().map(|d| d.repaired_block_ids).sum::<usize>(),
        "anchors": receipt.anchors.len(),
        "anchorCursors": receipt.anchors.iter().filter(|a| a.cursor).count(),
        "anchorResolutions": resolutions,
        "assetsCopied": sum(|b| b.assets_copied),
        "assetsMissing": sum(|b| b.assets_missing),
        "assetsMismatched": sum(|b| b.assets_mismatched),
        "projectedTodos": sum(|b| b.projected_todos),
        "notes": notes,
        "gateReasons": receipt.gate.reasons,
        "archivedRows": receipt.archived_rows,
        "orphanYjsDocs": receipt.orphan_yjs_docs,
        "sourceBytes": receipt.source_bytes,
        "installationIdAdopted": receipt.installation_id_adopted,
    })
}

fn open(root: &Path, index: bool) -> Result<Library> {
    let mut o = LibraryOptions::new("0.2.0-dev");
    if index {
        dr_index::attach(&mut o);
        o.rebuild_indexes_on_open = false;
    } else {
        o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
    }
    Ok(Library::open(root, o)?)
}

/// (old doc id → (new doc id, freshness)) of the latest import run.
fn imported_docs(lib: &Library) -> Result<HashMap<String, (String, String)>> {
    Ok(lib.local_read(|conn| {
        let mut by_old = HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT old_doc_id, doc_id, freshness FROM import_doc
             WHERE run_id = (SELECT max(id) FROM import_run)",
        )?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (o, d, f) = row?;
            by_old.insert(o, (d, f));
        }
        Ok(by_old)
    })?)
}

/// Check an imported library against the Yjs ground truth: for every body
/// with Yjs state, does the imported body equal the truth's? (A body the
/// gate proved fresh must; one it could not prove may differ.) And does
/// every 0.1 history row have its history point?
pub fn check_truth(root: &Path, truth: &Path) -> Result<Value> {
    let lib = open(root, false)?;
    let by_old = imported_docs(&lib)?;
    let mut docs = 0usize;
    let mut equal = 0usize;
    let mut fresh_equal = 0usize;
    let mut fresh_differ: Vec<String> = Vec::new();
    let mut doubtful_differ = 0usize;
    let mut doubtful_equal = 0usize;
    let mut missing = 0usize;
    let mut history_rows = 0usize;
    let mut history_equal = 0usize;
    let mut labels_by_doc: HashMap<String, usize> = HashMap::new();
    for line in std::fs::read_to_string(truth)?
        .lines()
        .filter(|l| !l.trim().is_empty())
    {
        let v: Value = serde_json::from_str(line)?;
        let Some(old) = v.get("documentId").and_then(Value::as_str) else {
            continue;
        };
        if v.get("historyId").is_some() {
            history_rows += 1;
            *labels_by_doc.entry(old.to_string()).or_default() += 1;
            continue;
        }
        let Some((new, freshness)) = by_old.get(old) else {
            missing += 1;
            continue;
        };
        docs += 1;
        let doc_id = DocId::parse(new).map_err(|e| crate::ImportError::Invalid(e.to_string()))?;
        let profile = doc_id.profile().unwrap_or(ProseProfile::Prose);
        let want = {
            let lines = pm::parse_value(&v["prose"])?;
            let blocks = prose::doc_blocks(&lines);
            prose::plan(
                &lines,
                &blocks,
                &Context {
                    profile,
                    span: &|_| None,
                    todo: &|_| None,
                },
            )
            .paras
        };
        let stored = lib.load_copy(new)?;
        let snap = stored.export(loro::ExportMode::Snapshot)?;
        let doc = ProseDoc::load(doc_id, dr_doc::peer::random_device_peer(), &[snap])?;
        let have = read::read_paras(&doc.view());
        // Compare what the author sees: text, attributes and marks; block ids
        // except the ones the repair rewrote and the entity links' remapped
        // blocks (both noted in the receipt).
        let same = have.len() == want.len()
            && have.iter().zip(&want).all(|(a, b)| {
                a.attrs == b.attrs
                    && a.embed.is_some() == b.embed.is_some()
                    && a.text() == b.text()
                    && marks_shape(a) == marks_shape(b)
            });
        let proven = matches!(
            freshness.as_str(),
            "seed-only" | "creation-seed" | "node-basis-current" | "handoff"
        );
        if same {
            equal += 1;
            if proven {
                fresh_equal += 1
            } else {
                doubtful_equal += 1
            }
        } else if proven {
            fresh_differ.push(old.to_string());
        } else {
            doubtful_differ += 1;
        }
    }
    // History: the replayed points per document vs the truth's rows.
    let mut labels_ok = 0usize;
    let mut kept = true;
    for (old, n) in &labels_by_doc {
        if let Some((new, _)) = by_old.get(old) {
            let points: Vec<_> = lib
                .history(new)?
                .into_iter()
                .filter(|l| l.label == dr_store::history::labels::PERIODIC)
                .collect();
            kept &= points.iter().all(|l| l.keep && l.book_frontiers.is_some());
            if points.len() == *n {
                labels_ok += 1;
                history_equal += n;
            }
        }
    }
    lib.close()?;
    Ok(json!({
        "bodiesWithYjs": docs,
        "equalToYjs": equal,
        "provenFreshEqual": fresh_equal,
        "provenFreshButDifferent": fresh_differ,
        "doubtfulAndDifferent": doubtful_differ,
        "doubtfulButEqual": doubtful_equal,
        "notImported": missing,
        "historyRows": history_rows,
        "historyRowsWithPoints": history_equal,
        "historyDocsMatching": labels_ok,
        "historyDocs": labels_by_doc.len(),
        "historyPointsKeptWithBookVersion": kept,
    }))
}

/// Marks as (char range, marks without entity block ids).
fn marks_shape(p: &Para) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut at = 0;
    for r in &p.runs {
        let n = r.text.chars().count();
        let mut m = r.marks.clone();
        for l in &mut m.entities {
            l.block = None;
            l.end_block = None;
        }
        m.embed = None;
        out.push((at, at + n, format!("{m:?}")));
        at += n;
    }
    out
}

/// The derived indexes of an imported library: none stale, every body's
/// words equal to what dr-index reads from the stored document, the books'
/// totals, outline entries, and a search for the start of one paragraph of
/// every body kind.
pub fn check_index(root: &Path) -> Result<Value> {
    let lib = open(root, true)?;
    let by_old = imported_docs(&lib)?;
    let stale = lib.stale_index_docs()?.len();
    let mut words: BTreeMap<String, u64> = BTreeMap::new();
    let mut differ: Vec<String> = Vec::new();
    let mut outline = 0usize;
    let mut probes: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut ids: Vec<&String> = by_old.values().map(|(d, _)| d).collect();
    ids.sort();
    for id in ids {
        let doc_id = DocId::parse(id).map_err(|e| crate::ImportError::Invalid(e.to_string()))?;
        let kind = id.split(':').next().unwrap_or("").to_string();
        let snap = lib.load_copy(id)?.export(loro::ExportMode::Snapshot)?;
        let p = ProseDoc::load(doc_id, dr_doc::peer::random_device_peer(), &[snap])?;
        let want = dr_index::derive_view(&p.view());
        let got = lib.doc_stats(id)?;
        match got {
            Some(s) if (s.words, s.chars) == (want.words, want.chars) => {}
            _ => differ.push(id.clone()),
        }
        *words.entry(kind.clone()).or_default() += want.words;
        outline += lib.outline(id)?.len();
        if let std::collections::btree_map::Entry::Vacant(slot) = probes.entry(kind)
            // Twelve characters of the first long paragraph, as written.
            && let Some(probe) = read::read_paras(&p.view()).iter().find_map(|para| {
                let t: Vec<char> = para.text().chars().collect();
                (t.len() >= 16).then(|| t[2..14].iter().collect::<String>())
            })
        {
            slot.insert((id.clone(), probe));
        }
    }
    let mut found = BTreeMap::new();
    for (kind, (id, probe)) in &probes {
        // The synthetic corpus repeats its sentences: ask for every hit.
        let hits = lib.search(None, probe, 100_000)?;
        found.insert(kind.clone(), hits.iter().any(|h| &h.doc_id == id));
    }
    let mut books = BTreeMap::new();
    let book_ids: Vec<String> = lib.local_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT book_id FROM import_book WHERE run_id = (SELECT max(id) FROM import_run) AND status = 'imported'",
        )?;
        let v = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    })?;
    for b in book_ids {
        books.insert(b.clone(), lib.book_stats(&b)?.words);
    }
    lib.close()?;
    Ok(json!({
        "staleAfterImport": stale,
        "wordsByKind": words,
        "wordsDiffer": differ,
        "bookWords": books.values().sum::<u64>(),
        "outlineEntries": outline,
        "searchFound": found,
    }))
}
