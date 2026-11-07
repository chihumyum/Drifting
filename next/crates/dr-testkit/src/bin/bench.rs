//! The one benchmark program (`dr_testkit::bench`).
//!
//! ```text
//! cargo run --release -p dr-testkit --bin bench -- <suite> [--quick] [--out FILE]
//! cargo run --release -p dr-testkit --bin bench -- <suite> --milestone <m>
//! cargo run -p dr-testkit --bin bench -- --check
//! cargo run -p dr-testkit --bin bench -- --compare <a.json> <b.json>
//! cargo run -p dr-testkit --bin bench -- --list
//! ```
//!
//! Without `--milestone` the result goes to `--out` or standard output and is
//! not evidence. With it, the file is written as measured evidence
//! (`docs/rust-rewrite/acceptance/<milestone>-<suite>-bench.json`); commit
//! it only at a milestone or as a before/after pair.

use std::path::PathBuf;

use dr_testkit::bench::{self, COMMON_INPUTS, Mode};
use dr_testkit::evidence::{self, Evidence};

fn usage() -> String {
    let names: Vec<&str> = bench::suites().iter().map(|s| s.name).collect();
    format!(
        "usage: bench <{}> [--quick] [--out FILE | --milestone M] | --check | --compare A B | --list",
        names.join("|")
    )
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    match args.first().map(String::as_str) {
        Some("--check") => {
            let n = bench::check_all()?;
            eprintln!("bench: {n} suites keep their quick shape");
            Ok(())
        }
        Some("--list") => {
            for s in bench::suites() {
                println!("{:8} {}", s.name, s.about);
            }
            Ok(())
        }
        Some("--compare") => {
            let read = |i: usize| -> Result<serde_json::Value, String> {
                let p = args.get(i).ok_or_else(usage)?;
                let t = std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"))?;
                serde_json::from_str(&t).map_err(|e| format!("{p}: {e}"))
            };
            let (a, b) = (read(1)?, read(2)?);
            println!(
                "{:24} {:28} {:>10} {:>10} {:>7}",
                "case", "metric (p50 ms)", "a", "b", "b/a"
            );
            for line in bench::compare(&a, &b) {
                println!("{line}");
            }
            Ok(())
        }
        Some(name) if !name.starts_with('-') => {
            let suite = bench::suites()
                .into_iter()
                .find(|s| s.name == name)
                .ok_or_else(usage)?;
            let mode = if args.iter().any(|a| a == "--quick") {
                Mode::Quick
            } else {
                Mode::Full
            };
            if mode == Mode::Full && cfg!(debug_assertions) {
                eprintln!("bench: a debug build; timings are not representative (add --release)");
            }
            let result = (suite.run)(mode)?;
            let json = if let Some(milestone) = flag("--milestone") {
                let root = evidence::workspace_root();
                let inputs: Vec<&str> = COMMON_INPUTS.iter().chain(suite.inputs).copied().collect();
                let mut e = Evidence::new(
                    &format!("{}-bench", suite.name),
                    &milestone,
                    &format!(
                        "cargo run --release -p dr-testkit --bin bench -- {} --milestone {milestone}",
                        suite.name
                    ),
                )
                .inputs(&root, &inputs)
                .map_err(|e| e.to_string())?;
                e.corpus = result.corpus.clone();
                e.results = result.to_json();
                let path = e
                    .write(&root.join(evidence::DIR))
                    .map_err(|e| e.to_string())?;
                eprintln!("wrote {}", path.display());
                return Ok(());
            } else {
                serde_json::json!({ "corpus": result.corpus, "results": result.to_json() })
            };
            let text = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())? + "\n";
            match flag("--out") {
                Some(out) => {
                    let out = PathBuf::from(out);
                    std::fs::write(&out, text).map_err(|e| e.to_string())?;
                    eprintln!("wrote {}", out.display());
                }
                None => print!("{text}"),
            }
            Ok(())
        }
        _ => Err(usage()),
    }
}
