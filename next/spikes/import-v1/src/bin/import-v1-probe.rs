//! What importing a Drifting 0.1.x library would do, as JSON.
//!
//! ```text
//! import-v1-probe <library.db> [--truth <exchange.jsonl>] [--app-local-data <dir>]
//! import-v1-probe evidence <manifest.json>   # acceptance evidence for several libraries
//! import-v1-probe check <evidence.json>      # verify the evidence's invariants
//! import-v1-probe --mapping-md               # the table mapping as Markdown
//! ```
//!
//! A manifest is `[{ "label", "origin", "db", "truth"?, "appLocalData"? }]`;
//! it holds local paths and is not committed.

use std::path::PathBuf;

use anyhow::{Result, bail};
use import_v1_spike::probe::{self, EvidenceInput, Options};

const USAGE: &str = "usage: import-v1-probe <library.db> [--truth <jsonl>] [--app-local-data <dir>] | evidence <manifest.json> | check <evidence.json> | --mapping-md";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--mapping-md") => {
            print!("{}", probe::mapping_markdown());
            return Ok(());
        }
        Some("evidence") => {
            let Some(path) = args.get(1) else {
                bail!(USAGE)
            };
            let inputs: Vec<EvidenceInput> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&probe::evidence(&inputs)?)?
            );
            return Ok(());
        }
        Some("check") => {
            let Some(path) = args.get(1) else {
                bail!(USAGE)
            };
            let problems =
                probe::check_evidence(&serde_json::from_str(&std::fs::read_to_string(path)?)?);
            if problems.is_empty() {
                println!("ok");
                return Ok(());
            }
            bail!("{}", problems.join("\n"));
        }
        _ => {}
    }
    let mut args = args.into_iter();
    let mut db = None;
    let mut truth = None;
    let mut app_local_data = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--truth" => truth = args.next().map(PathBuf::from),
            "--app-local-data" => app_local_data = args.next().map(PathBuf::from),
            other if db.is_none() && !other.starts_with("--") => db = Some(PathBuf::from(other)),
            other => bail!("unexpected argument {other}\n{USAGE}"),
        }
    }
    let Some(db) = db else { bail!(USAGE) };
    let report = probe::run(&Options {
        db,
        truth,
        app_local_data,
    })?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
