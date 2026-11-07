//! Development tool for the 0.1 library import (M10). Not part of the app.
//!
//! ```text
//! m10-import discover <0.1 app data dir>
//! m10-import analyse <library.db>
//! m10-import import <library.db> --to <new library dir> [--old-root <dir>]
//!                   [--device <dir>] [--accept] [--keep-staging] [--verify-history]
//! m10-import check <new library dir> --truth <truth.jsonl>
//! m10-import measure <fixtures dir> [--out <evidence.json>]
//! m10-import mapping-md
//! ```
//!
//! `measure` reads `<fixtures>/manifest.json` (written by the 0.1 fixture
//! generator, `src/renderer/services/v2-handoff/m10-fixtures.test.ts`),
//! imports every library in a child process (so peak memory is per
//! library), checks it against the Yjs ground truth in `truth/<name>.jsonl`
//! and prints the evidence (`docs/rust-rewrite/acceptance/m10-import.json`).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use dr_doc::prose::ProseDoc;
use dr_import_v1::gate::Accept;
use dr_import_v1::prose::{self, Context, pm, read};
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::{locate, receipt, tables};
use dr_model::{DocId, ProseProfile};
use serde_json::{Value, json};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn peak_rss_bytes() -> u64 {
    #[cfg(unix)]
    unsafe {
        let mut u: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut u);
        let v = u.ru_maxrss as u64;
        if cfg!(target_os = "macos") {
            v
        } else {
            v * 1024
        }
    }
    #[cfg(not(unix))]
    0
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("discover") => {
            let found = locate::discover(Path::new(&args[1]))?;
            println!("{}", serde_json::to_string_pretty(&found)?);
        }
        Some("analyse") => {
            let dir = tempfile_dir()?;
            let (_, _, _, gate) = run::analyse(Path::new(&args[1]), &dir)?;
            let _ = std::fs::remove_dir_all(&dir);
            println!("{}", serde_json::to_string_pretty(&gate)?);
        }
        Some("import") => {
            let out = import_cmd(&args)?;
            println!("{}", serde_json::to_string(&out)?);
        }
        Some("check") => {
            let truth = arg(&args, "--truth").ok_or("--truth")?;
            let out = check(Path::new(&args[1]), Path::new(&truth))?;
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        Some("measure") => {
            let out = measure(Path::new(&args[1]))?;
            let text = serde_json::to_string_pretty(&out)? + "\n";
            match arg(&args, "--out") {
                Some(p) => std::fs::write(p, text)?,
                None => print!("{text}"),
            }
        }
        Some("mapping-md") => {
            println!("| 旧表 | 去向 | 落到哪里 / 为什么 |\n| --- | --- | --- |");
            for t in tables::TABLES {
                let fate = serde_json::to_value(t.fate)?;
                println!(
                    "| `{}` | {} | {} |",
                    t.table,
                    fate.as_str().unwrap_or(""),
                    t.target
                );
            }
        }
        _ => {
            eprintln!("usage: see the module documentation of src/bin/m10-import.rs");
            std::process::exit(2);
        }
    }
    Ok(())
}

fn tempfile_dir() -> Res<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "m10-import-{}-{}",
        std::process::id(),
        dr_store::now_ms()
    ));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn import_cmd(args: &[String]) -> Res<Value> {
    let source = PathBuf::from(&args[1]);
    let target = PathBuf::from(arg(args, "--to").ok_or("--to")?);
    let mut options = Options::new("0.2.0-dev");
    options.old_root = arg(args, "--old-root").map(PathBuf::from);
    options.device_dir = arg(args, "--device").map(PathBuf::from);
    options.keep_staging = flag(args, "--keep-staging");
    options.verify_history = flag(args, "--verify-history");
    if flag(args, "--accept") {
        options.accept = Accept::EVERYTHING;
    }
    let (outcome, timing) = run::import(&source, &target, &options)?;
    let rss = peak_rss_bytes();
    Ok(match outcome {
        Outcome::Blocked(gate) => {
            json!({"outcome": "blocked", "gate": gate, "timing": timing, "peakRssBytes": rss})
        }
        Outcome::Imported(r) => {
            let mut by_fresh: BTreeMap<String, usize> = BTreeMap::new();
            let mut notes = prose::Notes::default();
            for d in &r.docs {
                *by_fresh
                    .entry(
                        serde_json::to_value(d.freshness)?
                            .as_str()
                            .unwrap_or("")
                            .to_string(),
                    )
                    .or_default() += 1;
            }
            for b in &r.books {
                notes.merge(&b.notes);
            }
            let mut res: BTreeMap<String, usize> = BTreeMap::new();
            for a in &r.anchors {
                *res.entry(
                    serde_json::to_value(a.resolution)?
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                )
                .or_default() += 1;
            }
            json!({
                "outcome": "imported",
                "timing": timing,
                "peakRssBytes": rss,
                "books": r.books.iter().map(|b| json!({"name": b.name, "status": b.status, "bodies": b.bodies, "historyPoints": b.history_points, "assetsCopied": b.assets_copied, "assetsMissing": b.assets_missing, "assetsMismatched": b.assets_mismatched, "projectedTodos": b.projected_todos})).collect::<Vec<_>>(),
                "bodies": r.docs.len(),
                "byFreshness": by_fresh,
                "storedExactly": r.docs.iter().filter(|d| d.stored_exactly).count(),
                "roundTrips": r.docs.iter().filter(|d| d.round_trips).count(),
                "chars": r.docs.iter().map(|d| d.chars).sum::<usize>(),
                "historyVersions": r.docs.iter().map(|d| d.history_versions).sum::<usize>(),
                "repairedBlockIds": r.docs.iter().map(|d| d.repaired_block_ids).sum::<usize>(),
                "anchors": r.anchors.len(),
                "anchorCursors": r.anchors.iter().filter(|a| a.cursor).count(),
                "anchorResolutions": res,
                "notes": notes,
                "gateReasons": r.gate.reasons,
                "archivedRows": r.archived_rows,
                "orphanYjsDocs": r.orphan_yjs_docs,
                "sourceBytes": r.source_bytes,
            })
        }
    })
}

/// Check an imported library against the Yjs ground truth: for every body
/// with Yjs state, does the imported body equal the truth's? (A body the
/// gate proved fresh must; one it could not prove may differ.)
fn check(root: &Path, truth: &Path) -> Res<Value> {
    let rec_db = receipt::directory(root).join(receipt::DATABASE);
    let conn = rusqlite::Connection::open(&rec_db)?;
    let run_id: i64 = conn.query_row("SELECT max(id) FROM import_run", [], |r| r.get(0))?;
    let mut by_old: HashMap<String, (String, String)> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT old_doc_id, doc_id, freshness FROM import_doc WHERE run_id = ?1")?;
        for row in stmt.query_map([run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (o, d, f) = row?;
            by_old.insert(o, (d, f));
        }
    }
    let lib = dr_store::Library::open(root, dr_store::LibraryOptions::new("0.2.0-dev"))?;
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
        let doc_id = DocId::parse(new)?;
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
                    && runs_text(a) == runs_text(b)
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
    // History: the replayed labels (periodic) per document vs the truth's rows.
    let mut labels_ok = 0usize;
    for (old, n) in &labels_by_doc {
        if let Some((new, _)) = by_old.get(old) {
            let got = lib
                .history(new)?
                .iter()
                .filter(|l| l.label == "periodic")
                .count();
            if got == *n {
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
        "historyRowsWithLabels": history_equal,
        "historyDocsMatching": labels_ok,
        "historyDocs": labels_by_doc.len(),
    }))
}

fn runs_text(p: &prose::Para) -> String {
    p.text()
}

/// Marks as (char range, marks without entity block ids).
fn marks_shape(p: &prose::Para) -> Vec<(usize, usize, String)> {
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

fn measure(fixtures: &Path) -> Res<Value> {
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures.join("manifest.json"))?)?;
    let exe = std::env::current_exe()?;
    let mut libraries = Vec::new();
    for lib in manifest["libraries"].as_array().ok_or("libraries")? {
        let name = lib["name"].as_str().ok_or("name")?;
        let db = fixtures.join(lib["path"].as_str().ok_or("path")?);
        let old_root = fixtures.join(lib["appLocalData"].as_str().unwrap_or(""));
        let truth = fixtures.join(lib["truth"].as_str().unwrap_or(""));
        let work = tempfile_dir()?;
        let target = work.join("library");
        let device = work.join("device");
        let run = |accept: bool| -> Res<Value> {
            let _ = std::fs::remove_dir_all(&target);
            let mut cmd = std::process::Command::new(&exe);
            cmd.arg("import")
                .arg(&db)
                .arg("--to")
                .arg(&target)
                .arg("--old-root")
                .arg(&old_root)
                .arg("--device")
                .arg(&device)
                .arg("--verify-history");
            if accept {
                cmd.arg("--accept");
            }
            let out = cmd.output()?;
            if !out.status.success() {
                return Err(format!("{name}: {}", String::from_utf8_lossy(&out.stderr)).into());
            }
            Ok(serde_json::from_slice(&out.stdout)?)
        };
        let first = run(false)?;
        let (gate_stopped, imported) = if first["outcome"] == "blocked" {
            (Some(first["gate"]["reasons"].clone()), run(true)?)
        } else {
            (None, first)
        };
        let checked = if truth.is_file() {
            check(&target, &truth)?
        } else {
            Value::Null
        };
        let size = dir_size(&target.join("library.sqlite"));
        libraries.push(json!({
            "name": name,
            "stoppedByGate": gate_stopped,
            "import": imported,
            "truth": checked,
            "newLibraryBytes": size,
        }));
        let _ = std::fs::remove_dir_all(&work);
    }
    Ok(json!({
        "milestone": "m10-1",
        "sourceFingerprint": dr_import_v1::source_fingerprint(),
        "generatedBy": "cargo run --release -p dr-import-v1 --bin m10-import -- measure <fixtures>",
        "fixtures": "src/renderer/services/v2-handoff/m10-fixtures.test.ts + src/dev-cli/seed-main.ts (lite, stress)",
        "machine": machine(),
        "libraries": libraries,
    }))
}

fn dir_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn machine() -> Value {
    let load = std::process::Command::new("sysctl")
        .arg("-n")
        .arg("vm.loadavg")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let cpu = std::process::Command::new("sysctl")
        .arg("-n")
        .arg("machdep.cpu.brand_string")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    json!({"os": std::env::consts::OS, "arch": std::env::consts::ARCH, "cpu": cpu, "loadavg": load, "profile": if cfg!(debug_assertions) { "debug" } else { "release" }})
}
