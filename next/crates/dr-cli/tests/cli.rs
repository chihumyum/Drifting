//! The command line's shape, its safety rules, and F3's registry through it,
//! on a seeded library.

use std::path::{Path, PathBuf};

use dr_cli::args::{Command, parse};
use dr_cli::execute;
use dr_cli::offline::{self, Guarded};

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

fn run(cmd: Command) -> String {
    let (code, out) = execute(cmd).unwrap();
    assert_eq!(code, 0, "{out}");
    out
}

fn seed(dir: &Path, yes: bool) -> String {
    run(Command::Scenario {
        library: dir.to_path_buf(),
        name: "seed:tiny".into(),
        yes,
    })
}

fn call(lib: &Path, command: &str, input: serde_json::Value, yes: bool) -> String {
    run(Command::Call {
        library: lib.to_path_buf(),
        command: command.into(),
        input: Some(input.to_string()),
        yes,
    })
}

fn book_of(lib: &Path) -> String {
    let out = run(Command::Inspect {
        library: lib.to_path_buf(),
        doc: None,
        json: true,
    });
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    v["books"][0]["id"].as_str().unwrap().to_string()
}

fn seeded() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    seed(&lib, true);
    (tmp, lib)
}

#[test]
fn writes_need_yes_a_closed_app_and_leave_a_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    // Without --yes nothing happens.
    let out = seed(&lib, false);
    assert!(out.contains("rerun with --yes"), "{out}");
    assert!(!offline::db_path(&lib).exists());
    // With it the seed is written; a new library needs no backup.
    let out = seed(&lib, true);
    assert!(out.starts_with("wrote 20 documents"), "{out}");
    // A second write backs the existing library up first.
    let out = seed(&lib, true);
    assert!(out.starts_with("backed up to"), "{out}");
    assert_eq!(std::fs::read_dir(lib.join("backups")).unwrap().count(), 1);
    // While the app holds the library, writes are refused …
    let open =
        dr_store::Library::open(&lib, dr_workspace::library_options(offline::APP_VERSION)).unwrap();
    let e = execute(Command::Scenario {
        library: lib.clone(),
        name: "seed:tiny".into(),
        yes: true,
    })
    .unwrap_err();
    assert!(e.contains("quit it first"), "{e}");
    assert!(offline::guarded_write(&lib, true, "x", |_| Ok(String::new())).is_err());
    // … and reading works anyway, on a copy: inspect, and queries.
    let out = run(Command::Inspect {
        library: lib.clone(),
        doc: None,
        json: true,
    });
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["books"][0]["name"], "微型种子");
    assert_eq!(v["books"][0]["chapters"], 4);
    let book = v["books"][0]["id"].as_str().unwrap().to_string();
    let list: serde_json::Value = serde_json::from_str(&call(
        &lib,
        "chapter.list",
        serde_json::json!({ "book": book }),
        false,
    ))
    .unwrap();
    assert_eq!(list["output"].as_array().unwrap().len(), 4);
    drop(open);
    assert!(matches!(
        offline::guarded_write(&lib, false, "x", |_| Ok(String::new())).unwrap(),
        Guarded::DryRun(_)
    ));
}

#[test]
fn describe_lists_the_registry() {
    let table = run(Command::Describe { json: false });
    assert!(table.contains("chapter.create"), "{table}");
    let manifest: serde_json::Value =
        serde_json::from_str(&run(Command::Describe { json: true })).unwrap();
    assert!(manifest.to_string().contains("chapter.create"));
}

#[test]
fn commands_change_the_library_only_with_yes() {
    let (_tmp, lib) = seeded();
    let book = book_of(&lib);
    let input = serde_json::json!({ "book": book, "title": "命令行加的章" });
    let dry = call(&lib, "chapter.create", input.clone(), false);
    assert!(dry.contains("rerun with --yes"), "{dry}");
    let done = call(&lib, "chapter.create", input, true);
    assert!(done.starts_with("backed up to"), "{done}");
    assert!(done.contains("命令行加的章"), "{done}");
    let list = call(
        &lib,
        "chapter.list",
        serde_json::json!({ "book": book }),
        false,
    );
    assert!(list.contains("命令行加的章"));
    // A bad call reports the registry's error code.
    let e = execute(Command::Call {
        library: lib.clone(),
        command: "chapter.update".into(),
        input: Some(serde_json::json!({ "book": book, "id": "nope" }).to_string()),
        yes: true,
    })
    .unwrap_err();
    assert!(e.contains("not_found"), "{e}");
    assert!(
        execute(Command::Call {
            library: lib.clone(),
            command: "no.such".into(),
            input: None,
            yes: true
        })
        .is_err()
    );
}

#[test]
fn scenarios_run_steps_with_references_and_expectations() {
    let (tmp, lib) = seeded();
    let file = tmp.path().join("acceptance.json");
    std::fs::write(
        &file,
        serde_json::json!({
            "about": "two chapters, a refused element, an undo",
            "steps": [
                { "call": "book.create", "input": { "name": "验收" }, "save": "book" },
                { "call": "chapter.create", "input": { "book": "${book.id}", "title": "第一章" },
                  "expect": { "/title": "第一章" } },
                { "call": "chapter.create", "input": { "book": "${book.id}", "title": "第一章" },
                  "expect": { "/title": "第一章 2" } },
                { "call": "element.create", "input": { "book": "${book.id}", "name": "阿Q" } },
                { "call": "element.create", "input": { "book": "${book.id}", "name": "阿Q" },
                  "expect_error": "name_taken" },
                { "undo": true },
                { "call": "element.list", "input": { "book": "${book.id}" }, "expect": { "/0": null } },
                { "call": "chapter.list", "input": { "book": "${book.id}" },
                  "expect": { "/0/title": "第一章", "/1/title": "第一章 2" } }
            ]
        })
        .to_string(),
    )
    .unwrap();
    let name = file.to_string_lossy().to_string();
    let dry = run(Command::Scenario {
        library: lib.clone(),
        name: name.clone(),
        yes: false,
    });
    assert!(dry.contains("run the 8 steps"), "{dry}");
    let out = run(Command::Scenario {
        library: lib.clone(),
        name: name.clone(),
        yes: true,
    });
    assert!(out.contains("failed as expected (name_taken)"), "{out}");
    // A failed expectation stops the run with the step.
    std::fs::write(
        &file,
        r#"{"steps": [{"call": "book.list", "expect": {"/0/name": "不存在"}}]}"#,
    )
    .unwrap();
    let e = execute(Command::Scenario {
        library: lib.clone(),
        name,
        yes: false,
    })
    .unwrap_err();
    assert!(e.contains("step 0 (book.list): expected /0/name"), "{e}");
}

#[test]
fn the_seed_can_be_written_through_the_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    let out = run(Command::Scenario {
        library: lib.clone(),
        name: "seed-commands:tiny".into(),
        yes: true,
    });
    assert!(out.contains("commands"), "{out}");
    let v: serde_json::Value = serde_json::from_str(&run(Command::Inspect {
        library: lib,
        doc: None,
        json: true,
    }))
    .unwrap();
    assert_eq!(v["books"][0]["chapters"], 4);
}

#[test]
fn the_command_line_opens_libraries_as_the_app() {
    let manifest = include_str!("../../../app/drifting/Cargo.toml");
    assert!(manifest.contains(&format!("version = \"{}\"", offline::APP_VERSION)));
}
