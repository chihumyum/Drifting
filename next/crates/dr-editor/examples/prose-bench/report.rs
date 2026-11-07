//! Sample statistics, the machine's load and the evidence file (F8's
//! format, `dr_testkit::evidence`).

use std::time::Duration;

use dr_testkit::evidence::{self, Evidence, Summary};
use serde_json::{Value, json};

/// The milestone the evidence is taken at: F4e's second round, prose-bench
/// on the seed and the workspace.
pub const MILESTONE: &str = "f4e-m2";

/// What the numbers depend on, under `next/`: the bench, the editor, the
/// storage it writes through and the corpus generator.
const INPUTS: &[&str] = &[
    "crates/dr-editor",
    "crates/gpui-prose",
    "crates/dr-workspace",
    "crates/dr-store",
    "crates/dr-doc",
    "crates/dr-testkit/src/seed",
];

/// A one-minute load above this (other builds on the machine) takes whole
/// frames from the bench: the numbers are then for reference only, and the
/// final ones wait for an idle run.
pub const BUSY_LOAD: f64 = 2.0;

pub fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

pub fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// `{n, p50, p95, max, mean}` of samples in milliseconds.
pub fn summary(samples: &[f64]) -> Value {
    serde_json::to_value(Summary::of(samples)).expect("a summary")
}

/// Every sample, rounded to 0.01 ms (`null` for one that never came).
pub fn samples(values: &[f64]) -> Value {
    values
        .iter()
        .map(|v| v.is_finite().then(|| (v * 100.0).round() / 100.0))
        .collect()
}

/// The one-minute load average now.
pub fn load() -> Option<f64> {
    evidence::load_average()
}

/// Whether any of the loads was above [`BUSY_LOAD`] (or unknown).
pub fn busy(loads: &[Option<f64>]) -> bool {
    loads.iter().any(|l| l.is_none_or(|l| l > BUSY_LOAD))
}

/// The GPUI build measured: `PROSE_BENCH_GPUI` labels a patched one (the
/// idle display-link comparisons); otherwise the workspace's pinned tag.
pub fn gpui_build() -> String {
    std::env::var("PROSE_BENCH_GPUI").unwrap_or_else(|_| "stock".into())
}

/// Ends a measurement: adds the load at the start and the end and the
/// conditions to `results`, prints them, checks the contract (`held`: what
/// must be true; if anything is not, exits with 1 and writes nothing), and
/// with `write` stores `<MILESTONE>-prose-bench-<name>.json` in the evidence
/// directory.
pub fn finish(
    name: &str,
    write: bool,
    corpus: &Value,
    mut results: Value,
    loads: (Option<f64>, Option<f64>),
    held: &[(&str, bool)],
) {
    let (start, end) = loads;
    if let Some(fields) = results.as_object_mut() {
        fields.insert(
            "load_average_1m".into(),
            json!({ "start": start, "end": end }),
        );
        fields.insert(
            "conditions".into(),
            json!({
                "busy_above_load_1m": BUSY_LOAD,
                "reference_only": busy(&[start, end]),
            }),
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&results).expect("results as JSON")
    );
    let broken: Vec<&str> = held
        .iter()
        .filter(|(_, ok)| !ok)
        .map(|(what, _)| *what)
        .collect();
    if !broken.is_empty() {
        eprintln!("prose-bench {name}: not true: {}", broken.join("; "));
        std::process::exit(1);
    }
    if !write {
        return;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = evidence::workspace_root();
    // A patched GPUI's run is kept beside the stock one, not over it.
    let build = gpui_build();
    let file = if build == "stock" {
        format!("prose-bench-{name}")
    } else {
        let label: String = build
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        format!("prose-bench-{name}-{label}")
    };
    let mut e = Evidence::new(
        &file,
        MILESTONE,
        &format!(
            "cargo run --release -p dr-editor --example prose-bench -- {}",
            args.join(" ")
        ),
    )
    .inputs(&root, INPUTS)
    .expect("fingerprint the inputs");
    e.corpus = corpus.clone();
    e.results = results;
    let path = e
        .write(&root.join(evidence::DIR))
        .expect("write the evidence");
    eprintln!("wrote {}", path.display());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statistics() {
        let s = summary(&[3.0, 1.0, 2.0, 4.0]);
        assert_eq!(s["n"], 4);
        assert_eq!(s["p50"], 3.0);
        assert_eq!(s["max"], 4.0);
        assert_eq!(s["mean"], 2.5);
        assert_eq!(samples(&[1.234, 2.0, f64::NAN]), json!([1.23, 2.0, null]));
        assert_eq!(round3(1.23456), 1.235);
    }

    #[test]
    fn a_busy_or_unknown_load_marks_reference_only() {
        assert!(!busy(&[Some(0.5), Some(2.0)]));
        assert!(busy(&[Some(0.5), Some(2.1)]));
        assert!(busy(&[None, Some(0.5)]));
    }
}
