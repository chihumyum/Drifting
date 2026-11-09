//! Wrap real native-window measurements in the F8 milestone format.
//! Raw bridge reports stay ignored; this input contains timings and counts only.
use anyhow::{Context, Result, ensure};
use dr_testkit::{evidence, seed};
use serde_json::{Value, json};
use std::path::PathBuf;

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 2,
        "sidebar-evidence <measurement.json> <evidence-directory>"
    );
    let report: Value = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let cases = report["cases"].as_array().context("measurement cases")?;
    ensure!(cases.len() == 2, "both heavy and v3-heavy are required");
    for (case, preset) in cases.iter().zip(["heavy", "v3-heavy"]) {
        ensure!(case["preset"] == preset, "case order or preset changed");
        ensure!(case["complete"] == true, "incomplete native measurement");
        ensure!(case["scroll_steps_each_direction"] == 60);
        ensure!(case["scroll_dispatch"]["samples"] == 120);
        ensure!(
            case["native_cpu"]["draw_us"]["samples"]
                .as_u64()
                .is_some_and(|n| n >= 10),
            "native draw samples required"
        );
    }
    let legacy = seed::generate(seed::Preset::Heavy, seed::DEFAULT_SEED)?.shape();
    let v3 = seed::generate_v3(seed::Preset::Heavy, seed::DEFAULT_SEED)?.shape();
    ensure!(legacy.corpus_fingerprint == v3.corpus_fingerprint);
    let mut record = evidence::Evidence::new(
        "sidebar-window-bench",
        "k4-g2",
        "cargo run --release -p dr-view-ideas --example sidebar-evidence -- target/acceptance/k4-g2-sidebar-heavy/measurement.json ../docs/rust-rewrite/acceptance",
    )
    .inputs(
        &evidence::workspace_root(),
        &[
            "Cargo.lock",
            "crates/dr-view-elements/src/panel.rs",
            "crates/dr-view-elements/src/data.rs",
            "crates/dr-view-elements/Cargo.toml",
            "crates/dr-view-ideas/src",
            "crates/dr-view-ideas/scripts/window-sidebar-bench.py",
            "crates/dr-view-ideas/examples/sidebar-evidence.rs",
            "crates/dr-shell/src/v3/sidebar.rs",
            "crates/dr-shell/src/workspace/sidebar.rs",
            "crates/dr-shell/src/book",
            "crates/dr-ui/src",
            "crates/dr-ui/assets/fonts/provenance.json",
            "crates/dr-i18n/own",
            "crates/dr-i18n/locales",
            "crates/dr-workspace/src/commands/v3",
            "crates/dr-doc/src/v3",
            "crates/dr-model/src/v3.rs",
            "crates/dr-testkit/src/seed",
            "crates/dr-corpus",
        ],
    )?;
    record.corpus = json!({"legacy": legacy, "v3": v3});
    record.results = report;
    let file = record.write(&PathBuf::from(&args[1]))?;
    println!("{}", file.display());
    Ok(())
}
