//! V3 book structure loading, using the fixed canonical seed and actual workspace queries.
use super::*;
use crate::seed::{self, DEFAULT_SEED};
use dr_workspace::{Actor, Workspace};

pub fn suite(legacy: bool) -> Suite {
    Suite {
        name: if legacy { "v3-book-legacy" } else { "v3-book" },
        about: "v3 book metadata snapshot: seed and storage setup, first workspace open, complete structure queries; no window rendering",
        inputs: &[
            "crates/dr-model/src/v3.rs",
            "crates/dr-doc",
            "crates/dr-workspace",
            "crates/dr-testkit/src/bench/v3_levels.rs",
        ],
        run: if legacy { run_legacy } else { run },
        expect_quick,
    }
}
fn expect_quick() -> Value {
    json!({"prepare":{"books":1},"read":{"books":1,"entries":24,"levels":11}})
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn out(ws: &Workspace, name: &str, input: Value) -> Result<Value, String> {
    ws.call(&Actor::User, name, input)
        .map(|v| v["output"].clone())
        .map_err(err)
}
fn timed<R>(
    case: &mut Case,
    key: &str,
    f: impl FnOnce() -> Result<R, String>,
) -> Result<R, String> {
    let t = Instant::now();
    let result = f()?;
    let ms = t.elapsed().as_secs_f64() * 1e3;
    case.sample(key, ms);
    eprintln!("v3 book: {key} completed in {ms:.3} ms");
    Ok(result)
}
pub fn run_legacy(mode: Mode) -> Result<Bench, String> {
    measure(mode, true)
}
pub fn run(mode: Mode) -> Result<Bench, String> {
    measure(mode, false)
}
fn measure(mode: Mode, legacy: bool) -> Result<Bench, String> {
    let mut bench = Bench::new(if legacy { "v3-book-legacy" } else { "v3-book" }, mode);
    let scratch = Scratch::new("v3-book").map_err(err)?;
    let dir = scratch.path().join("library");
    let prepare=bench.case("prepare","seed generation, shape audit, storing documents and first workspace open are separate from reading");
    let seeded = timed(prepare, "seedGeneration", || {
        seed::generate_v3(mode.preset(), DEFAULT_SEED).map_err(err)
    })?;
    let shape = timed(prepare, "seedShape", || Ok(seeded.shape()))?;
    let book = seeded.books[0].book_id().to_string();
    let ws = Workspace::open_dir(&dir, "v3-book-bench").map_err(err)?;
    timed(prepare, "storeSeed", || {
        seeded.write_to(ws.library()).map_err(err)
    })?;
    drop(seeded);
    ws.shutdown().map_err(err)?;
    let ws = timed(prepare, "firstWorkspaceOpen", || {
        Workspace::open_dir(&dir, "v3-book-bench").map_err(err)
    })?;
    prepare.set("books", 1);
    let case=bench.case("read","one complete book structure read after reopening; includes holder loading, queries and JSON conversion, excludes UI construction and rendering");
    let total = Instant::now();
    let before = timed(case, "observeBefore", || {
        ws.observe(&format!("book:{book}")).map_err(err)
    })?;
    let entries = timed(case, "entries", || {
        out(
            &ws,
            "entry.list",
            json!({"book":book,"all":true,"trashed":true}),
        )
    })?;
    timed(case, "templates", || {
        out(&ws, "entry_template.list", json!({"book":book}))
    })?;
    let level_ids: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["deleted_at"].is_null() && e["level"] == true)
        .filter_map(|e| e["id"].as_str())
        .collect();
    let complete = |below: &Value| {
        below["sources"].as_object().is_some_and(|s| s.len() == 8)
            && below["children"].is_array()
            && below["members"].is_array()
    };
    timed(case, "levels", || {
        if legacy {
            for (i, id) in level_ids.iter().enumerate() {
                let entry = out(&ws, "entry.get", json!({"book":book,"id":id}))?;
                if !complete(&entry["below"]) {
                    return Err(format!("entry {id} lacks what lies below it"));
                }
                eprintln!("v3 book: level {}/{} complete", i + 1, level_ids.len());
            }
        } else {
            let batch = out(
                &ws,
                "entry.list",
                json!({"book":book,"all":true,"below":true}),
            )?;
            let rows: Vec<_> = batch
                .as_array()
                .ok_or("missing entry rows")?
                .iter()
                .filter(|r| r.get("below").is_some())
                .collect();
            let actual: Vec<_> = rows.iter().filter_map(|r| r["id"].as_str()).collect();
            if actual != level_ids || rows.iter().any(|r| !complete(&r["below"])) {
                return Err("batch omitted levels or resolved structure".into());
            }
        }
        Ok(())
    })?;
    timed(case, "roots", || {
        out(&ws, "entry.list", json!({"book":book}))
    })?;
    timed(case, "memberships", || {
        out(&ws, "membership.list", json!({"book":book}))
    })?;
    timed(case, "timelineViews", || {
        out(&ws, "timeline_view.list", json!({"book":book}))
    })?;
    let after = timed(case, "observeAfter", || {
        ws.observe(&format!("book:{book}")).map_err(err)
    })?;
    if before.version != after.version {
        return Err("book changed during measured read".into());
    }
    case.sample("total", total.elapsed().as_secs_f64() * 1e3);
    case.set("books", 1);
    case.set("entries", entries.as_array().unwrap().len());
    case.set("levels", level_ids.len());
    bench.corpus = json!({"preset":format!("v3-{}",shape.preset),"seed":shape.seed,"corpusFingerprint":shape.corpus_fingerprint,"shape":shape,"entries":entries.as_array().unwrap().len(),"levels":level_ids.len(),"samples":1,"buildProfile":if cfg!(debug_assertions){"debug"}else{"release"},"queryPath":if legacy{"per-level"}else{"batch"}});
    ws.shutdown().map_err(err)?;
    Ok(bench)
}
