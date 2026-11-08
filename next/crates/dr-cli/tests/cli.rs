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
        library: Some(dir.to_path_buf()),
        name: "seed:tiny".into(),
        yes,
        app: None,
        profile: None,
        out: None,
        keep: false,
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
        library: Some(lib.clone()),
        name: "seed:tiny".into(),
        yes: true,
        app: None,
        profile: None,
        out: None,
        keep: false,
    })
    .unwrap_err();
    assert!(e.contains("quit it first"), "{e}");
    assert!(offline::guarded_write(&lib, true, "x", |_| Ok(String::new())).is_err());
    // … and reading works anyway: inspect opens it read-only beside the
    // app, queries read a copy.
    let out = run(Command::Inspect {
        library: lib.clone(),
        doc: None,
        json: true,
    });
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["opened"], "read-only");
    assert_eq!(v["books"][0]["name"], "微型种子");
    assert_eq!(v["books"][0]["chapters"], 4);
    let book = v["books"][0]["id"].as_str().unwrap().to_string();
    let doc: serde_json::Value = serde_json::from_str(&run(Command::Inspect {
        library: lib.clone(),
        doc: Some(format!("book:{book}")),
        json: true,
    }))
    .unwrap();
    assert_eq!(doc["opened"], "read-only");
    assert!(doc["value"].is_object(), "{doc}");
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
fn inspect_reads_a_library_to_be_migrated_from_a_copy_and_leaves_it() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    let options = || dr_workspace::library_options(offline::APP_VERSION);
    // A library an earlier build wrote: only the first migration applied.
    dr_store::Library::open_with_migrations(&lib, options(), &dr_store::MIGRATIONS[..1])
        .unwrap()
        .close()
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&run(Command::Inspect {
        library: lib.clone(),
        doc: None,
        json: true,
    }))
    .unwrap();
    assert_eq!(v["opened"], "copy");
    assert_eq!(v["books"], serde_json::json!([]));
    assert!(
        matches!(
            dr_store::Library::open_read_only(&lib, options()),
            Err(dr_store::StoreError::NeedsMigration { applied: 1, .. })
        ),
        "the library itself was not migrated"
    );
    assert!(!lib.join("backups").exists());
    let human = run(Command::Inspect {
        library: lib,
        doc: None,
        json: false,
    });
    assert!(human.contains("read from a migrated copy"), "{human}");
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
        library: Some(lib.clone()),
        name: name.clone(),
        yes: false,
        app: None,
        profile: None,
        out: None,
        keep: false,
    });
    assert!(dry.contains("run the 8 steps"), "{dry}");
    let out = run(Command::Scenario {
        library: Some(lib.clone()),
        name: name.clone(),
        yes: true,
        app: None,
        profile: None,
        out: None,
        keep: false,
    });
    assert!(out.contains("failed as expected (name_taken)"), "{out}");
    // A failed expectation stops the run with the step.
    std::fs::write(
        &file,
        r#"{"steps": [{"call": "book.list", "expect": {"/0/name": "不存在"}}]}"#,
    )
    .unwrap();
    let e = execute(Command::Scenario {
        library: Some(lib.clone()),
        name,
        yes: false,
        app: None,
        profile: None,
        out: None,
        keep: false,
    })
    .unwrap_err();
    assert!(e.contains("step 0 (book.list): expected /0/name"), "{e}");
}

#[test]
fn the_seed_can_be_written_through_the_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    let out = run(Command::Scenario {
        library: Some(lib.clone()),
        name: "seed-commands:tiny".into(),
        yes: true,
        app: None,
        profile: None,
        out: None,
        keep: false,
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

#[test]
fn app_calls_parse_and_need_a_running_build() {
    let c = parse(&a(&["app", "open", "第一章", "--profile", "p9"])).unwrap();
    let Command::App(call) = c else {
        panic!("{c:?}")
    };
    assert_eq!(
        (call.verb.as_str(), call.args.as_slice()),
        ("open", &["第一章".to_string()][..])
    );
    assert_eq!(call.profile.as_deref(), Some("p9"));
    assert!(parse(&a(&["app"])).is_err());
    // No build runs under this profile: the error says how to start one.
    let e = execute(Command::App(dr_cli::app::AppCall {
        profile: Some("dr-cli-test-nothing-here".into()),
        ..call
    }))
    .unwrap_err();
    assert!(e.contains("not_running"), "{e}");
}

/// The acceptance scenarios that ship with dr-cli parse, and the writing
/// loop drives the app, typing included.
#[test]
fn the_shipped_scenarios_parse() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("scenarios");
    let mut n = 0;
    for e in std::fs::read_dir(&dir).unwrap() {
        let path = e.unwrap().path();
        let s = dr_cli::scenario::parse(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(!s.about.is_empty(), "{}", path.display());
        // Every shipped scenario drives the app and quits it at the end; a
        // step it skips says which module's work it waits for.
        assert!(dr_cli::scenario::is_live(&s), "{}", path.display());
        assert!(
            s.steps.last().and_then(|l| l.app.as_deref()) == Some("app.quit"),
            "{} does not end by quitting the app",
            path.display()
        );
        for step in &s.steps {
            if let Some(why) = &step.pending {
                assert!(why.contains("待协调"), "{}: {why}", path.display());
            }
        }
        n += 1;
    }
    // The phase 2 loop, M03, M09, M10, M11, M18, settings and M39.
    assert!(n >= 8, "{n} scenarios");
    let loop_ =
        dr_cli::scenario::parse(&std::fs::read_to_string(dir.join("writing-loop.json")).unwrap())
            .unwrap();
    assert!(dr_cli::scenario::is_live(&loop_));
    assert!(loop_.steps.iter().all(|s| s.pending.is_none()));
    assert!(
        loop_
            .steps
            .iter()
            .any(|s| s.app.as_deref() == Some("input.type"))
    );
    assert!(loop_.steps.iter().filter(|s| s.launch.is_some()).count() == 2);
}

#[test]
fn a_scenario_that_drives_the_app_keeps_to_its_own_profile() {
    let (_dir, lib) = seeded();
    let file = _dir.path().join("live.json");
    std::fs::write(
        &file,
        r#"{"about": "x", "steps": [{"seed": "tiny"}, {"app": "state.get"}]}"#,
    )
    .unwrap();
    let live = |library: Option<PathBuf>, profile: Option<&str>, yes: bool| {
        execute(Command::Scenario {
            library,
            name: file.to_string_lossy().into_owned(),
            yes,
            app: None,
            profile: profile.map(str::to_string),
            out: None,
            keep: false,
        })
    };
    // Never on a library given by path.
    assert!(
        live(Some(lib.clone()), None, true)
            .unwrap_err()
            .contains("--library")
    );
    // An existing profile's library only with --yes; without, nothing runs.
    let (code, out) = live(None, Some("dr-cli-test-nothing-here"), false).unwrap();
    assert_eq!(code, 0);
    assert!(out.contains("--yes"), "{out}");
    // Offline, an app step says what it needs.
    let s = dr_cli::scenario::parse(r#"{"steps": [{"call": "book.list"}, {"app": "state.get"}]}"#)
        .unwrap();
    let ws = dr_workspace::Workspace::open_dir(&lib, dr_cli::offline::APP_VERSION).unwrap();
    let e = dr_cli::scenario::run(&ws, &s).unwrap_err();
    ws.shutdown().unwrap();
    assert!(e.contains("needs_app"), "{e}");
}
