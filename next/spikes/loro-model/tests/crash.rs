//! A short crash-recovery run: SIGKILL the writer a few times and verify
//! the recovered document (the full run is `p0c-crash run`).

#[test]
fn killed_writer_recovers() {
    let out = std::env::temp_dir().join(format!("p0c-crash-test-{}.json", std::process::id()));
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_p0c-crash"))
        .args(["run", "--kills", "6", "--out"])
        .arg(&out)
        .status()
        .expect("run p0c-crash");
    assert!(status.success());
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["results"]["kills"], 6);
    let _ = std::fs::remove_file(out);
}
