//! Development tool for the 0.1 library import (M10). Not part of the app.
//!
//! ```text
//! m10-import discover <0.1 app data dir>
//! m10-import analyse <library.db>
//! m10-import import <library.db> --to <new library dir> [--old-root <dir>]
//!                   [--device <dir>] [--accept] [--keep-staging] [--verify-history]
//!                   [--no-index] [--progress]
//! m10-import check <new library dir> --truth <truth.jsonl>
//! m10-import mapping-md
//! ```
//!
//! The measurement (every fixture library, with the evidence) is
//! `examples/m10-measure.rs`.

use std::path::{Path, PathBuf};

use dr_import_v1::gate::Accept;
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::{locate, tables, verify};
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
            let out = verify::check_truth(Path::new(&args[1]), Path::new(&truth))?;
            println!("{}", serde_json::to_string_pretty(&out)?);
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
    options.index = !flag(args, "--no-index");
    if flag(args, "--accept") {
        options.accept = Accept::EVERYTHING;
    }
    let show = flag(args, "--progress");
    let mut last = None;
    let (outcome, timing) = run::import_with(&source, &target, &options, &mut |p| {
        if show && last != Some((p.step, p.book)) {
            last = Some((p.step, p.book));
            eprintln!(
                "{:>5.1}% {:?} {} {}/{}",
                p.overall * 100.0,
                p.step,
                p.book_name,
                p.done,
                p.total
            );
        }
    })?;
    let rss = peak_rss_bytes();
    Ok(match outcome {
        Outcome::Blocked(gate) => {
            json!({"outcome": "blocked", "gate": gate, "timing": timing, "peakRssBytes": rss})
        }
        Outcome::Cancelled => json!({"outcome": "cancelled", "timing": timing}),
        Outcome::Imported(r) => {
            let mut v = verify::summary(&r, &timing);
            v["outcome"] = json!("imported");
            v["peakRssBytes"] = json!(rss);
            v
        }
    })
}
