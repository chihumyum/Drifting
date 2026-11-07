//! The M10 measurement: import every 0.1 fixture library, check it, and
//! write the measured evidence (`dr_testkit::evidence`, `f8-testkit.md`).
//!
//! ```text
//! cargo run --release -p dr-import-v1 --example m10-measure -- <fixtures> [--milestone m10-m2] [--write]
//! ```
//!
//! `<fixtures>/manifest.json` is written by the 0.1 fixture generator
//! (`src/renderer/services/v2-handoff/m10-fixtures.test.ts`, see
//! `m10-import.md` "测试数据"). Each library is imported in a child process
//! (this program again, `--one`), so peak memory is per library; a library
//! the gate stops is imported again with "仍然导入". Then it is checked
//! against the Yjs ground truth and its indexes are checked.
//!
//! The contract is asserted here, not recorded: a body proven fresh that
//! differs from the truth, a body not stored exactly or not round-tripping,
//! an anchor without its cursors, a history row without its point (kept,
//! with the book's version), metadata that does not hold at its point, a
//! stale index, a body whose words differ from dr-index's own reading, a
//! search probe not found — any of these fails the run and nothing is
//! written. Only the measurements go into the evidence.

use std::path::{Path, PathBuf};
use std::time::Instant;

use dr_import_v1::gate::Accept;
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::verify;
use dr_testkit::evidence::{self, Evidence};
use serde_json::{Value, json};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

/// What the numbers depend on (paths under `next/`).
const INPUTS: &[&str] = &[
    "crates/dr-import-v1",
    "crates/dr-index",
    "crates/dr-text",
    "crates/prose-metrics",
    "crates/dr-doc",
    "crates/dr-model",
    "crates/dr-store",
];

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
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
    if args.first().map(String::as_str) == Some("--one") {
        let out = one(&args[1..])?;
        println!("{}", serde_json::to_string(&out)?);
        return Ok(());
    }
    let fixtures = PathBuf::from(
        args.first()
            .ok_or("usage: m10-measure <fixtures> [--milestone m10-m2] [--write]")?,
    );
    let milestone = arg(&args, "--milestone").unwrap_or_else(|| "m10-m2".into());
    let (libraries, corpus, failures) = measure(&fixtures)?;
    if !failures.is_empty() {
        for f in &failures {
            eprintln!("contract: {f}");
        }
        return Err(format!("{} contract failures; no evidence written", failures.len()).into());
    }
    let root = evidence::workspace_root();
    let mut ev = Evidence::new(
        "import",
        &milestone,
        &format!(
            "cargo run --release -p dr-import-v1 --example m10-measure -- <fixtures> --milestone {milestone} --write"
        ),
    )
    .inputs(&root, INPUTS)?;
    ev.corpus = corpus;
    ev.results = json!({ "libraries": libraries });
    if args.iter().any(|a| a == "--write") {
        let path = ev.write(&root.join(evidence::DIR))?;
        eprintln!(
            "wrote {}",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
    } else {
        println!("{}", serde_json::to_string_pretty(&ev)?);
    }
    Ok(())
}

/// The child: one import, with its peak memory and how often it reported
/// progress.
fn one(args: &[String]) -> Res<Value> {
    let db = PathBuf::from(&args[0]);
    let mut options = Options::new("0.2.0-dev");
    options.old_root = Some(PathBuf::from(&args[1]));
    let work = PathBuf::from(&args[2]);
    options.device_dir = Some(work.join("device"));
    options.verify_history = true;
    if args.iter().any(|a| a == "--accept") {
        options.accept = Accept::EVERYTHING;
    }
    let mut events = 0u64;
    let mut last = Instant::now();
    let mut max_gap_ms = 0f64;
    let mut steps: Vec<String> = Vec::new();
    let mut monotonic = true;
    let mut overall = 0f64;
    let (outcome, timing) = run::import_with(&db, &work.join("library"), &options, &mut |p| {
        events += 1;
        max_gap_ms = max_gap_ms.max(last.elapsed().as_secs_f64() * 1e3);
        last = Instant::now();
        monotonic &= p.overall >= overall;
        overall = p.overall;
        let s = format!("{:?}", p.step);
        if steps.last() != Some(&s) {
            steps.push(s);
        }
    })?;
    let progress = json!({
        "events": events,
        "maxGapMs": (max_gap_ms * 10.0).round() / 10.0,
        "overallMonotonic": monotonic,
        "steps": steps,
    });
    Ok(match outcome {
        Outcome::Blocked(gate) => json!({"outcome": "blocked", "gate": gate}),
        Outcome::Cancelled => json!({"outcome": "cancelled"}),
        Outcome::Imported(r) => {
            let mut v = verify::summary(&r, &timing);
            v["outcome"] = json!("imported");
            v["peakRssBytes"] = json!(peak_rss_bytes());
            v["progress"] = progress;
            v["sourceSha256"] = json!(r.source_sha256);
            v
        }
    })
}

fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or(0)
}

fn measure(fixtures: &Path) -> Res<(Vec<Value>, Value, Vec<String>)> {
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures.join("manifest.json"))?)?;
    let exe = std::env::current_exe()?;
    let mut libraries = Vec::new();
    let mut corpus = Vec::new();
    let mut failures = Vec::new();
    for lib in manifest["libraries"].as_array().ok_or("libraries")? {
        let name = lib["name"].as_str().ok_or("name")?.to_string();
        let db = fixtures.join(lib["path"].as_str().ok_or("path")?);
        let old_root = fixtures.join(lib["appLocalData"].as_str().unwrap_or(""));
        let truth = fixtures.join(lib["truth"].as_str().unwrap_or(""));
        let work = std::env::temp_dir().join(format!(
            "m10-measure-{}-{}",
            std::process::id(),
            dr_store::now_ms()
        ));
        let run = |accept: bool| -> Res<Value> {
            let _ = std::fs::remove_dir_all(&work);
            std::fs::create_dir_all(&work)?;
            let mut cmd = std::process::Command::new(&exe);
            cmd.arg("--one").arg(&db).arg(&old_root).arg(&work);
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
        let (stopped, imported) = if first["outcome"] == "blocked" {
            (Some(first["gate"]["reasons"].clone()), run(true)?)
        } else {
            (None, first)
        };
        let target = work.join("library");
        let truth_check = if truth.is_file() {
            verify::check_truth(&target, &truth)?
        } else {
            Value::Null
        };
        let index = verify::check_index(&target)?;
        let new_bytes = std::fs::metadata(target.join("library.sqlite")).map_or(0, |m| m.len());
        let _ = std::fs::remove_dir_all(&work);

        // The contract.
        let bodies = n(&imported, "bodies");
        let mut fail = |what: String| failures.push(format!("{name}: {what}"));
        if n(&imported, "storedExactly") != bodies {
            fail("a body is not stored exactly".into());
        }
        if n(&imported, "roundTrips") != bodies {
            fail("a body does not round-trip".into());
        }
        if n(&imported, "anchorCursors") != n(&imported, "anchors") {
            fail("an anchor has no cursors".into());
        }
        if n(&imported, "historyMetaChecked") != n(&imported, "historyMetaReplayed") {
            fail("replayed metadata does not hold at its point".into());
        }
        if imported["notes"].get("history-version-differs").is_some() {
            fail("a history version does not check out".into());
        }
        if imported["progress"]["overallMonotonic"] != json!(true) {
            fail("progress went back".into());
        }
        if !truth_check.is_null() {
            if truth_check["provenFreshButDifferent"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
            {
                fail(format!(
                    "proven fresh but different: {}",
                    truth_check["provenFreshButDifferent"]
                ));
            }
            if n(&truth_check, "historyRowsWithPoints") != n(&truth_check, "historyRows") {
                fail("a history row has no point".into());
            }
            if truth_check["historyPointsKeptWithBookVersion"] != json!(true) {
                fail("a history point is not kept or has no book version".into());
            }
        }
        if n(&index, "staleAfterImport") != 0 {
            fail("indexes are stale after the import".into());
        }
        if index["wordsDiffer"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            fail(format!("words differ: {}", index["wordsDiffer"]));
        }
        if index["searchFound"]
            .as_object()
            .is_some_and(|m| m.values().any(|v| v != &json!(true)))
        {
            fail(format!("search probes: {}", index["searchFound"]));
        }

        corpus.push(json!({
            "name": name,
            "source": lib["source"],
            "sha256": imported["sourceSha256"],
            "bytes": imported["sourceBytes"],
        }));
        libraries.push(json!({
            "name": name,
            "stoppedByGate": stopped,
            "import": imported,
            "truth": truth_check,
            "index": index,
            "newLibraryBytes": new_bytes,
        }));
    }
    let corpus = json!({
        "generator": manifest["generator"],
        "generatedAt": manifest["generatedAt"],
        "libraries": corpus,
    });
    Ok((libraries, corpus, failures))
}
