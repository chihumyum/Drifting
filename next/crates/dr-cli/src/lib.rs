//! Drifting's development command line (foundation F8): F3's command
//! registry from a shell, under the offline-write safety rules
//! ([`offline`]).
//!
//! ```text
//! cargo drifting workspace describe [--json]
//! cargo drifting workspace call chapter.list --library DIR --input '{"book": "…"}'
//! cargo drifting workspace call chapter.create --library DIR --input '{…}' --yes
//! cargo drifting workspace scenario acceptance.json --library DIR --yes
//! cargo drifting workspace scenario seed:lite --library DIR --yes
//! cargo drifting workspace inspect --library DIR [--json] [--doc ID]
//! ```
//!
//! Queries and read-only scenarios run on a consistent copy of the library
//! (the app may have it open); commands run on the library itself, as the
//! author (`user`), only with the app closed, after a backup, with `--yes`.

pub mod args;
pub mod inspect;
pub mod offline;
pub mod scenario;

use std::path::Path;

use args::Command;
use dr_workspace::{Actor, Workspace, registry};
use offline::{APP_VERSION, Guarded};
use serde_json::Value;

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

fn pretty(v: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(v).map_err(|e| e.to_string())
}

/// Open a workspace on `root`, run `f`, shut it down (closing the library).
fn with_workspace<T>(
    root: &Path,
    f: impl FnOnce(&Workspace) -> Result<T, String>,
) -> Result<T, String> {
    let ws = Workspace::open_dir(root, APP_VERSION).map_err(|e| e.to_string())?;
    let out = f(&ws);
    ws.shutdown().map_err(|e| e.to_string())?;
    out
}

fn call_one(ws: &Workspace, name: &str, input: Value) -> Result<Value, String> {
    ws.call(&Actor::User, name, input)
        .map_err(|e| format!("{name}: {}: {e}", e.code()))
}

pub fn execute(cmd: Command) -> Result<(i32, String), String> {
    match cmd {
        Command::Help => Ok((0, args::USAGE.to_string())),
        Command::Describe { json } => Ok((
            0,
            if json {
                pretty(&registry().manifest())?
            } else {
                registry().table()
            },
        )),
        Command::Call {
            library,
            command,
            input,
            yes,
        } => {
            let spec = registry().get(&command).ok_or_else(|| {
                format!("unknown command {command}; `cargo drifting workspace describe` lists them")
            })?;
            let input: Value = match &input {
                Some(i) => {
                    serde_json::from_str(i).map_err(|e| format!("--input is not JSON: {e}"))?
                }
                None => Value::Object(Default::default()),
            };
            if spec.is_query() {
                let out = offline::on_copy(&library, |copy| {
                    with_workspace(copy, |ws| call_one(ws, &command, input))
                })?;
                return Ok((0, pretty(&out)?));
            }
            let r = offline::guarded_write(
                &library,
                yes,
                &format!("run {command} as the author"),
                |root| with_workspace(root, |ws| pretty(&call_one(ws, &command, input)?)),
            )?;
            Ok((0, guarded(r)))
        }
        Command::Inspect { library, doc, json } => {
            let v = inspect::inspect(&library, doc.as_deref())?;
            Ok((
                0,
                if json {
                    pretty(&v)?
                } else {
                    inspect::human(&v)
                },
            ))
        }
        Command::Scenario { library, name, yes } => scenario_command(&library, &name, yes),
    }
}

fn preset(name: &str) -> Result<dr_testkit::seed::Preset, String> {
    dr_testkit::seed::Preset::parse(name)
        .ok_or_else(|| format!("unknown seed {name}: tiny, lite, heavy, showcase"))
}

fn scenario_command(library: &Path, name: &str, yes: bool) -> Result<(i32, String), String> {
    use dr_testkit::seed;
    if let Some(p) = name.strip_prefix("seed:") {
        let preset = preset(p)?;
        let r = offline::guarded_write(
            library,
            yes,
            &format!("write the {} seed", preset.name()),
            |root| {
                let seeded =
                    seed::generate(preset, seed::DEFAULT_SEED).map_err(|e| e.to_string())?;
                let lib = dr_store::Library::open(root, dr_workspace::library_options(APP_VERSION))
                    .map_err(|e| e.to_string())?;
                let n = seeded.write_to(&lib).map_err(|e| e.to_string())?;
                lib.close().map_err(|e| e.to_string())?;
                Ok(format!(
                    "wrote {n} documents ({} books, corpus {})",
                    seeded.books.len(),
                    seeded.shape().corpus_fingerprint
                ))
            },
        )?;
        return Ok((0, guarded(r)));
    }
    if let Some(p) = name.strip_prefix("seed-commands:") {
        let preset = preset(p)?;
        let r = offline::guarded_write(
            library,
            yes,
            &format!("write the {} seed through the commands", preset.name()),
            |root| {
                with_workspace(root, |ws| {
                    let made = seed::generate_via_commands(
                        preset,
                        seed::DEFAULT_SEED,
                        ws,
                        &Actor::Import,
                    )?;
                    Ok(made
                        .iter()
                        .map(|b| {
                            format!(
                                "book {}: {} commands, {} prose edits",
                                b.book, b.commands, b.prose_edits
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n"))
                })
            },
        )?;
        return Ok((0, guarded(r)));
    }
    let text = std::fs::read_to_string(name).map_err(|e| {
        format!("{name}: {e} (a scenario is a JSON file, seed:<preset> or seed-commands:<preset>)")
    })?;
    let s = scenario::parse(&text)?;
    let report = |v: Value| -> Result<String, String> {
        let mut out: Vec<String> = v["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| l.as_str().map(str::to_string))
            .collect();
        out.push(format!("saved: {}", v["saved"]));
        Ok(out.join("\n"))
    };
    if scenario::is_read_only(&s) {
        let v = offline::on_copy(library, |copy| {
            with_workspace(copy, |ws| scenario::run(ws, &s))
        })?;
        return Ok((0, report(v)?));
    }
    let r = offline::guarded_write(
        library,
        yes,
        &format!("run the {} steps of {name}", s.steps.len()),
        |root| with_workspace(root, |ws| report(scenario::run(ws, &s)?)),
    )?;
    Ok((0, guarded(r)))
}
