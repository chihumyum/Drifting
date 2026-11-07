//! The command line's shape and its safety rules, on a seeded library.

use std::path::Path;

use dr_cli::args::{Command, parse};
use dr_cli::offline::{self, Guarded};
use dr_cli::{NOT_YET, execute};

fn a(s: &[&str]) -> Vec<String> {
    s.iter().map(|x| x.to_string()).collect()
}

#[test]
fn the_four_subcommands_parse() {
    assert_eq!(
        parse(&a(&["workspace", "describe", "--json"])).unwrap(),
        Command::Describe { json: true }
    );
    assert_eq!(
        parse(&a(&[
            "workspace",
            "call",
            "chapter.create",
            "--library",
            "L",
            "--input",
            "{}",
            "--yes"
        ]))
        .unwrap(),
        Command::Call {
            library: "L".into(),
            command: "chapter.create".into(),
            input: Some("{}".into()),
            yes: true
        }
    );
    assert_eq!(
        parse(&a(&["workspace", "inspect", "--library", "L"])).unwrap(),
        Command::Inspect {
            library: "L".into(),
            doc: None,
            json: false
        }
    );
    assert!(
        parse(&a(&["workspace", "inspect"])).is_err(),
        "--library is required"
    );
    assert!(
        parse(&a(&["workspace", "scenario", "--library", "L"])).is_err(),
        "a scenario name"
    );
    assert!(parse(&a(&["workspace", "frobnicate"])).is_err());
    assert_eq!(parse(&a(&[])).unwrap(), Command::Help);
}

fn seed(dir: &Path, yes: bool) -> (i32, String) {
    execute(Command::Scenario {
        library: dir.to_path_buf(),
        name: "seed:tiny".into(),
        yes,
    })
    .unwrap()
}

#[test]
fn writes_need_yes_a_closed_app_and_leave_a_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    // Without --yes nothing happens.
    let (code, out) = seed(&lib, false);
    assert_eq!(code, 0);
    assert!(out.contains("rerun with --yes"), "{out}");
    assert!(!offline::db_path(&lib).exists());
    // With it the seed is written; a new library needs no backup.
    let (_, out) = seed(&lib, true);
    assert!(out.starts_with("wrote 20 documents"), "{out}");
    // A second write backs the existing library up first.
    let (_, out) = seed(&lib, true);
    assert!(out.starts_with("backed up to"), "{out}");
    let backups: Vec<_> = std::fs::read_dir(lib.join("backups")).unwrap().collect();
    assert_eq!(backups.len(), 1);
    // While the app holds the library, writes are refused.
    let open = dr_store::Library::open(
        &lib,
        dr_testkit::seed::library_options(offline::APP_VERSION),
    )
    .unwrap();
    let e = execute(Command::Scenario {
        library: lib.clone(),
        name: "seed:tiny".into(),
        yes: true,
    })
    .unwrap_err();
    assert!(e.contains("quit it first"), "{e}");
    assert!(offline::guarded_write(&lib, true, "x", |_| Ok(String::new())).is_err());
    // Reading works anyway, on a copy.
    let (code, out) = execute(Command::Inspect {
        library: lib.clone(),
        doc: None,
        json: true,
    })
    .unwrap();
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["books"][0]["name"], "微型种子");
    assert_eq!(v["books"][0]["chapters"], 4);
    assert_eq!(v["documents"]["book"], 1);
    drop(open);
    assert!(matches!(
        offline::guarded_write(&lib, false, "x", |_| Ok(String::new())).unwrap(),
        Guarded::DryRun(_)
    ));
}

#[test]
fn describe_and_call_wait_for_the_registry() {
    let (code, _) = execute(Command::Describe { json: false }).unwrap();
    assert_eq!(code, NOT_YET);
    let tmp = tempfile::tempdir().unwrap();
    let (code, _) = execute(Command::Call {
        library: tmp.path().into(),
        command: "chapter.create".into(),
        input: Some("{}".into()),
        yes: true,
    })
    .unwrap();
    assert_eq!(code, NOT_YET);
    assert!(
        execute(Command::Call {
            library: tmp.path().into(),
            command: "x".into(),
            input: Some("{".into()),
            yes: false,
        })
        .is_err()
    );
}

#[test]
fn the_command_line_opens_libraries_as_the_app() {
    let manifest = include_str!("../../../app/drifting/Cargo.toml");
    assert!(manifest.contains(&format!("version = \"{}\"", offline::APP_VERSION)));
}
