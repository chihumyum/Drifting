//! Drifting's development command line (foundation F8), first milestone:
//! the command shape, the offline-write safety rules ([`offline`]) and a
//! read-only `inspect` ([`inspect`]). `describe` and `call` run F3's
//! command registry once it is merged; until then they say so.
//!
//! ```text
//! cargo drifting workspace inspect --library DIR [--json] [--doc ID]
//! cargo drifting workspace scenario seed:lite --library DIR --yes
//! ```

pub mod args;
pub mod inspect;
pub mod offline;

use args::Command;
use offline::Guarded;

/// Exit code for a command that waits for F3's registry.
pub const NOT_YET: i32 = 2;

/// Run the command line; returns the exit code.
pub fn run(argv: &[String]) -> i32 {
    match args::parse(argv) {
        Ok(cmd) => match execute(cmd) {
            Ok((code, out)) => {
                if !out.is_empty() {
                    println!("{out}");
                }
                code
            }
            Err(e) => {
                eprintln!("error: {e}");
                1
            }
        },
        Err(e) => {
            eprintln!("error: {e}\n\n{}", args::USAGE);
            1
        }
    }
}

fn guarded(r: Guarded) -> String {
    match r {
        Guarded::DryRun(plan) => plan,
        Guarded::Done { backup, report } => match backup {
            Some(b) => format!("backed up to {}\n{report}", b.display()),
            None => report,
        },
    }
}

pub fn execute(cmd: Command) -> Result<(i32, String), String> {
    match cmd {
        Command::Help => Ok((0, args::USAGE.to_string())),
        Command::Describe { .. } => Ok((
            NOT_YET,
            "describe lists F3's command registry; it arrives when dr-workspace is merged".into(),
        )),
        Command::Call {
            library,
            command,
            input,
            yes,
        } => {
            if let Some(i) = &input {
                serde_json::from_str::<serde_json::Value>(i)
                    .map_err(|e| format!("--input is not JSON: {e}"))?;
            }
            offline::ensure_closed(&library)?;
            let what = format!("run {command}");
            if !yes {
                return Ok((
                    0,
                    format!("would back up the library, then {what}; rerun with --yes"),
                ));
            }
            Ok((
                NOT_YET,
                format!(
                    "{what}: commands arrive with F3's registry (dr-workspace); nothing was changed"
                ),
            ))
        }
        Command::Inspect { library, doc, json } => {
            let v = inspect::inspect(&library, doc.as_deref())?;
            Ok((
                0,
                if json {
                    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?
                } else {
                    inspect::human(&v)
                },
            ))
        }
        Command::Scenario { library, name, yes } => {
            let preset = name
                .strip_prefix("seed:")
                .and_then(dr_testkit::seed::Preset::parse)
                .ok_or_else(|| {
                    format!("unknown scenario {name}; built in: seed:tiny, seed:lite, seed:heavy, seed:showcase")
                })?;
            let r = offline::guarded_write(
                &library,
                yes,
                &format!("write the {} seed", preset.name()),
                |lib| {
                    let seeded = dr_testkit::seed::generate(preset, dr_testkit::seed::DEFAULT_SEED)
                        .map_err(|e| e.to_string())?;
                    let n = seeded.write_to(lib).map_err(|e| e.to_string())?;
                    Ok(format!(
                        "wrote {n} documents ({} books, corpus {})",
                        seeded.books.len(),
                        seeded.shape().corpus_fingerprint
                    ))
                },
            )?;
            Ok((0, guarded(r)))
        }
    }
}
