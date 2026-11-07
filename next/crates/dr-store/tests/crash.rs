//! A short crash-recovery run for CI: kill the writer a few times and kill
//! a migration at every stage (the full run is `f2-crash run --kills 60
//! --migration-kills`, which writes the evidence file).

#[test]
fn killed_writers_and_migrations_recover() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("crash.json");
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_f2-crash"))
        .args(["run", "--kills", "6", "--migration-kills", "--out"])
        .arg(&out)
        .status()
        .expect("run f2-crash");
    assert!(status.success());
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    let r = &v["results"];
    assert_eq!(r["kills"], 6);
    assert_eq!(r["lostDurableEdits"], 0);
    assert_eq!(r["mismatches"], 0);
    let stages = r["migrationKills"].as_object().unwrap();
    assert_eq!(stages.len(), 6);
    for (stage, s) in stages {
        assert_eq!(s["textIntact"], true, "{stage}");
        let replaced = stage == "reopen";
        assert_eq!(s["libraryBytesUnchanged"], !replaced, "{stage}");
    }
}
