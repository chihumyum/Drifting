//! `cargo xtask`: the `next/` workspace's gates and launchers.
//!
//! ```text
//! cargo xtask check [--only a,b] [--skip a,b] [--list]   every gate (CI runs all)
//! cargo xtask evidence --check                            the evidence gate alone
//! cargo xtask check-binary [--release-identity] [--precompiled-shaders] <file>…
//!                                                         no debug bridge or hot reload built in; which identity; which shaders
//! cargo xtask dev [--instance N] [--debug-bridge] [--hot] [--print-config] [--release] [-- app args]
//! ```
//!
//! See `docs/rust-rewrite/foundations/f8-testkit.md`.

mod dev;
mod gates;
mod repo;

use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask check [--only a,b] [--skip a,b] [--list]
       cargo xtask evidence --check
       cargo xtask check-binary [--release-identity] [--precompiled-shaders] <file>…
       cargo xtask dev [--instance NAME] [--debug-bridge] [--hot] [--print-config] [--release] [-- app args]";

fn list_arg(args: &[String], name: &str) -> Vec<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_default()
}

fn check(args: &[String]) -> ExitCode {
    let gates = gates::all();
    if args.iter().any(|a| a == "--list") {
        for g in &gates {
            println!("{:16} {}", g.name, g.about);
        }
        return ExitCode::SUCCESS;
    }
    let only = list_arg(args, "--only");
    let skip = list_arg(args, "--skip");
    for name in only.iter().chain(&skip) {
        if !gates.iter().any(|g| g.name == name) {
            eprintln!("unknown gate {name}; cargo xtask check --list");
            return ExitCode::FAILURE;
        }
    }
    let repo = repo::Repo::locate();
    let mut failed = Vec::new();
    for g in gates
        .iter()
        .filter(|g| only.is_empty() || only.iter().any(|o| o == g.name))
        .filter(|g| !skip.iter().any(|s| s == g.name))
    {
        match (g.run)(&repo) {
            Ok(o) if o.failures.is_empty() => {
                println!("ok   {:16} {}", g.name, o.summary);
                for n in &o.notes {
                    println!("       note: {n}");
                }
            }
            Ok(o) => {
                println!("FAIL {:16} {}", g.name, o.summary);
                for f in &o.failures {
                    println!("       {f}");
                }
                for n in &o.notes {
                    println!("       note: {n}");
                }
                failed.push(g.name);
            }
            Err(e) => {
                println!("FAIL {:16} could not run: {e}", g.name);
                failed.push(g.name);
            }
        }
    }
    if failed.is_empty() {
        ExitCode::SUCCESS
    } else {
        eprintln!("cargo xtask check: {} failed", failed.join(", "));
        ExitCode::FAILURE
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => check(&args[1..]),
        Some("evidence") if args.get(1).map(String::as_str) == Some("--check") => {
            check(&["--only".into(), "evidence".into()])
        }
        Some("check-binary") if args.len() > 1 => {
            let flag = |name: &str| args[1..].iter().any(|a| a == name);
            let expect = gates::release_identity::Expect {
                release_identity: flag("--release-identity"),
                precompiled_shaders: flag("--precompiled-shaders"),
            };
            let files: Vec<String> = args[1..]
                .iter()
                .filter(|a| !matches!(a.as_str(), "--release-identity" | "--precompiled-shaders"))
                .cloned()
                .collect();
            if files.is_empty() {
                eprintln!("{USAGE}");
                return ExitCode::FAILURE;
            }
            let found = gates::debug_bridge::check_binaries(&files).and_then(|mut f| {
                f.extend(gates::hot_reload::check_binaries(&files)?);
                f.extend(gates::release_identity::check_binaries(&files, expect)?);
                Ok(f)
            });
            match found {
                Ok(f) if f.is_empty() => {
                    println!(
                        "ok   {} file(s) without the debug bridge ({}) or GPUI's hot reload; {} identity{}",
                        files.len(),
                        dr_debug_protocol::PROTOCOL,
                        if expect.release_identity {
                            "the release"
                        } else {
                            "not the release"
                        },
                        if expect.precompiled_shaders {
                            "; precompiled Metal shaders"
                        } else {
                            ""
                        }
                    );
                    ExitCode::SUCCESS
                }
                Ok(f) => {
                    for line in f {
                        println!("FAIL {line}");
                    }
                    ExitCode::FAILURE
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("dev") => {
            let repo = repo::Repo::locate();
            match dev::run(&repo.root, &repo.next, &args[1..]) {
                Ok(0) => ExitCode::SUCCESS,
                Ok(code) => ExitCode::from(code.clamp(1, 255) as u8),
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}
